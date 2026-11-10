// Whether title pages play local theme music (`ui.theme_music_enabled`) and whether it repeats
// (`ui.theme_music_loop`), following silo-apple Networking/ThemeMusicPreferences.swift. Both default to off.
// The server resolves each key for this device (profile_device, then profile, then default); the rows write
// this TV's profile_device value, which wins over a profile value, so a change always takes effect here.
// Nothing is cached: music plays only for an answer read from the server for this profile.
import { ApiError } from "../api/errors.ts";
import type { RequestSpec } from "../api/http.ts";
import { settingsOperations } from "../api/settingsOperations.ts";
import { THEME_MUSIC_ENABLED_KEY, THEME_MUSIC_LOOP_KEY, type SettingsCapabilities } from "../contracts/v2/settings.ts";
import type { NativeSession } from "../session/session.ts";
import { readSettingsCapability } from "./presentationSettings.ts";

/** Settings manifest revision that introduced both keys (SettingKeyRevisions.swift). */
export const THEME_MUSIC_INTRODUCED_IN = 11;
const KEYS = [THEME_MUSIC_ENABLED_KEY, THEME_MUSIC_LOOP_KEY] as const;
type ThemeMusicKey = (typeof KEYS)[number];

export interface ThemeMusicSetting {
    readonly enabled: boolean;
    readonly loop: boolean;
}

const OFF: ThemeMusicSetting = { enabled: false, loop: false };

export function themeMusicSettingsSupported(capability: SettingsCapabilities | undefined): boolean {
    if (capability === undefined) return false;
    return capability.apiVersion === 1
        && capability.state === "available"
        && capability.allowed
        && capability.scopes.includes("profile_device")
        && capability.supportsBatchedEffective
        && capability.manifestRevision >= THEME_MUSIC_INTRODUCED_IN;
}

function writeFailure(error: unknown): string {
    if (error instanceof ApiError && (error.failure.kind === "network" || error.failure.kind === "timeout")) return "Couldn't save the theme music setting. Check the connection and try again.";
    if (error instanceof ApiError && (error.status === 404 || error.status === 501 || error.problemId === "unknown_setting" || error.problemId === "server_upgrade_required" || error.problemId === "scope_not_allowed")) return "This server can't save the theme music setting.";
    return "The server didn't save the theme music setting. Try again.";
}

export class ThemeMusicPreferences {
    private readonly session: NativeSession;
    private readonly listeners = new Set<() => void>();
    private readonly onVisible: () => void;
    private readonly controller = new AbortController();
    private shown: ThemeMusicSetting = OFF;
    /** The last answer the server confirmed; a failed write rolls back to it. */
    private confirmed: ThemeMusicSetting | undefined;
    private errorMessage: string | undefined;
    private published = "";
    private refreshSequence = 0;
    private pendingWrites = 0;
    private writeChain: Promise<void> = Promise.resolve();

    constructor(session: NativeSession) {
        this.session = session;
        this.onVisible = () => {
            if (typeof document === "undefined" || document.hidden || this.controller.signal.aborted) return;
            void this.refresh();
        };
        if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisible);
    }

    /** Whether title pages may play theme music right now. */
    get playsThemeMusic(): boolean { return this.confirmed !== undefined && this.shown.enabled; }
    get loops(): boolean { return this.confirmed !== undefined && this.shown.loop; }
    /** Whether settings should show the switches. */
    get isOffered(): boolean { return this.confirmed !== undefined; }
    get allowsEditing(): boolean { return this.confirmed !== undefined; }
    get error(): string | undefined { return this.errorMessage; }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    stop(): void {
        this.controller.abort();
        if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisible);
        this.listeners.clear();
    }

    /** Reads the server's answer for this profile and TV. Called at launch, on return to the foreground and when settings open. */
    async refresh(): Promise<void> {
        if (this.controller.signal.aborted) return;
        const sequence = ++this.refreshSequence;
        const current = (): boolean => !this.controller.signal.aborted && sequence === this.refreshSequence && this.pendingWrites === 0;
        try {
            const capability = await readSettingsCapability(spec => this.call(spec));
            if (!current()) return;
            if (!themeMusicSettingsSupported(capability)) {
                this.adopt(undefined);
                return;
            }
            const effective = await this.call(settingsOperations.effectiveSettings(KEYS));
            if (!current()) return;
            this.adopt({ enabled: effective.get(THEME_MUSIC_ENABLED_KEY)?.value === true, loop: effective.get(THEME_MUSIC_LOOP_KEY)?.value === true });
        } catch (error) {
            // An unreachable server keeps the last answer for this profile; nothing new to read.
            if (error instanceof ApiError && error.aborted) return;
        }
    }

    setEnabled(on: boolean): void { this.write(THEME_MUSIC_ENABLED_KEY, on); }
    setLoop(on: boolean): void { this.write(THEME_MUSIC_LOOP_KEY, on); }

    /** Resolves once every queued write, and the read-back after them, has finished. For tests. */
    async waitForPendingWrites(): Promise<void> {
        let awaited: Promise<void>;
        do {
            awaited = this.writeChain;
            await awaited;
        } while (this.writeChain !== awaited);
    }

    private write(key: ThemeMusicKey, on: boolean): void {
        if (!this.allowsEditing) return;
        const enabled = key === THEME_MUSIC_ENABLED_KEY;
        if ((enabled ? this.shown.enabled : this.shown.loop) === on) return;
        this.shown = enabled ? { ...this.shown, enabled: on } : { ...this.shown, loop: on };
        this.errorMessage = undefined;
        this.pendingWrites++;
        this.publish();
        // Serialized so quick changes reach the server in the order made.
        this.writeChain = this.writeChain.then(() => this.perform(key, on));
    }

    private async perform(key: ThemeMusicKey, on: boolean): Promise<void> {
        const enabled = key === THEME_MUSIC_ENABLED_KEY;
        try {
            await this.call(settingsOperations.putSetting(key, on, "profile_device"), false);
        } catch (error) {
            this.pendingWrites--;
            if (this.controller.signal.aborted || (error instanceof ApiError && error.aborted)) return;
            // Roll back only the key that failed; a queued change to the other one stands.
            const saved = this.confirmed ?? OFF;
            this.shown = enabled ? { ...this.shown, enabled: saved.enabled } : { ...this.shown, loop: saved.loop };
            this.errorMessage = writeFailure(error);
            this.publish();
            return;
        }
        this.pendingWrites--;
        if (this.controller.signal.aborted) return;
        const base = this.confirmed ?? OFF;
        this.confirmed = enabled ? { ...base, enabled: on } : { ...base, loop: on };
        // The last queued change landed: adopt what the server now resolves.
        if (this.pendingWrites === 0) await this.refresh();
        else this.publish();
    }

    private adopt(value: ThemeMusicSetting | undefined): void {
        this.confirmed = value;
        this.shown = value ?? OFF;
        this.errorMessage = undefined;
        this.publish();
    }

    private call<T>(spec: RequestSpec<T>, replayAfterRefresh = true): Promise<T> {
        return this.session.call({ ...spec, profileScoped: true, replayAfterRefresh, signal: this.controller.signal });
    }

    private publish(): void {
        const snapshot = JSON.stringify({ shown: this.shown, offered: this.isOffered, plays: this.playsThemeMusic, loops: this.loops, error: this.errorMessage });
        if (snapshot === this.published) return;
        this.published = snapshot;
        for (const listener of this.listeners) listener();
    }
}
