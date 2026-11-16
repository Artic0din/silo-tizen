// The profile's app language (`ui.app_language`), following silo-apple Networking/AppLanguagePreferences.swift
// and tvOS/Screens/Settings/TVGeneralSettingsView.swift. Null means Match Device. The choice is stored on the
// server for the profile; picking one also clears this TV's own value so the choice takes effect here.
// Nothing is cached: the row shows only an answer read from the server for the active profile.
// Tizen has no localised text and no per-app system language (Apple also writes `AppleLanguages`), so the
// only shipped language is English and the choice changes no on-screen text yet (see docs/settings.md).
import { ApiError } from "../api/errors.ts";
import type { RequestSpec } from "../api/http.ts";
import { settingsOperations } from "../api/settingsOperations.ts";
import { APP_LANGUAGE_KEY, type SettingsCapabilities } from "../contracts/v2/settings.ts";
import type { NativeSession } from "../session/session.ts";
import { readSettingsCapability } from "./presentationSettings.ts";

/** Settings manifest revision that introduced the key (SettingKeyRevisions.swift). */
export const APP_LANGUAGE_INTRODUCED_IN = 28;
/** The languages this build shows text in. Apple's list is the bundle's localizations. */
const SHIPPED_LANGUAGES: readonly string[] = ["en"];
const MATCH_DEVICE = "Match Device";
const FOOTER = "The language of Silo’s menus and buttons on this profile. Audio and subtitle languages are set in Playback.";
export const APP_LANGUAGE_SAVING = "Saving the app language…";

export interface AppLanguageChoice {
    /** Null: Match Device. */
    readonly tag: string | null;
    /** This TV's own row won, so the profile's value is hidden behind it. */
    readonly isDeviceValue: boolean;
}
export interface AppLanguageOption {
    readonly tag: string | null;
    readonly label: string;
}

export function appLanguageSettingsSupported(capability: SettingsCapabilities | undefined): boolean {
    if (capability === undefined) return false;
    return capability.apiVersion === 1
        && capability.state === "available"
        && capability.allowed
        && capability.supportsBatchedEffective
        && capability.manifestRevision >= APP_LANGUAGE_INTRODUCED_IN;
}

/** A language's own name, capitalised for a list ("English", "Español"); the tag itself when it has no name. */
export function languageEndonym(tag: string): string {
    try {
        const name = new Intl.DisplayNames([tag], { type: "language" }).of(tag);
        return name === undefined ? tag : name.charAt(0).toLocaleUpperCase(tag) + name.slice(1);
    } catch {
        return tag;
    }
}

// shortcut: matches on the language code only; upgrade when a shipped language needs a script or region (zh-Hans).
function isShipped(tag: string): boolean {
    const code = tag.split("-")[0]?.toLowerCase();
    return SHIPPED_LANGUAGES.some(shipped => shipped === code);
}

function writeFailure(error: unknown): string {
    if (error instanceof ApiError && (error.failure.kind === "network" || error.failure.kind === "timeout")) return "Couldn't save the app language. Check the connection and try again.";
    if (error instanceof ApiError && (error.status === 404 || error.status === 501 || error.problemId === "unknown_setting" || error.problemId === "server_upgrade_required" || error.problemId === "scope_not_allowed")) return "This server can't save the app language.";
    return "The server didn't save the app language. Try again.";
}

export class AppLanguagePreferences {
    private readonly session: NativeSession;
    private readonly listeners = new Set<() => void>();
    private readonly controller = new AbortController();
    private choice: AppLanguageChoice | undefined;
    /** The profile the answer belongs to; another profile's answer is never shown. */
    private profileId: string | undefined;
    private saving = false;
    private errorMessage: string | undefined;
    private published = "";
    private refreshSequence = 0;

    constructor(session: NativeSession) {
        this.session = session;
    }

    /** The stored choice for the active profile; undefined hides the row. */
    get currentChoice(): AppLanguageChoice | undefined {
        return this.profileId !== undefined && this.profileId === this.session.activeProfile?.id ? this.choice : undefined;
    }
    get isOffered(): boolean { return this.currentChoice !== undefined; }
    /** A save is running: the picker takes no new choice. */
    get isBusy(): boolean { return this.saving; }
    get error(): string | undefined { return this.errorMessage; }

    /** Match Device, each shipped language by its own name, and a stored tag this build lacks as itself, so re-saving never clears it. */
    get options(): readonly AppLanguageOption[] {
        const stored = this.currentChoice?.tag;
        const tags = stored !== undefined && stored !== null && !SHIPPED_LANGUAGES.includes(stored) ? [...SHIPPED_LANGUAGES, stored] : SHIPPED_LANGUAGES;
        return [{ tag: null, label: MATCH_DEVICE }, ...tags.map(tag => ({ tag, label: languageEndonym(tag) }))];
    }
    get selectedLabel(): string {
        const tag = this.currentChoice?.tag;
        return tag === undefined || tag === null ? MATCH_DEVICE : languageEndonym(tag);
    }
    get footer(): string {
        const tag = this.currentChoice?.tag;
        return tag !== undefined && tag !== null && !isShipped(tag) ? `Silo isn’t available in ${languageEndonym(tag)} yet, so it uses the device language.` : FOOTER;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    stop(): void {
        this.controller.abort();
        this.listeners.clear();
    }

    /** Reads the server's answer for the active profile. Called at launch, on return to the foreground and when settings open. */
    async refresh(): Promise<void> {
        if (this.controller.signal.aborted) return;
        const profileId = this.session.activeProfile?.id;
        if (profileId === undefined) return;
        if (profileId !== this.profileId) {
            this.profileId = profileId;
            this.choice = undefined;
            this.errorMessage = undefined;
            this.publish();
        }
        const sequence = ++this.refreshSequence;
        try {
            const capability = await readSettingsCapability(spec => this.call(spec));
            if (!this.isCurrent(sequence)) return;
            if (!appLanguageSettingsSupported(capability)) {
                this.adopt(undefined);
                return;
            }
            await this.read(sequence);
        } catch (error) {
            // An unreachable server keeps the last answer for this profile; nothing new to read.
            if (error instanceof ApiError && error.aborted) return;
        }
    }

    /** Saves the profile's language (null: Match Device) and clears this TV's own value. */
    async select(tag: string | null): Promise<void> {
        const current = this.currentChoice;
        if (current === undefined || this.saving || (current.tag === tag && !current.isDeviceValue)) return;
        this.saving = true;
        this.errorMessage = undefined;
        // Reads already in flight answer for the state before this save.
        const sequence = ++this.refreshSequence;
        this.choice = { tag, isDeviceValue: false };
        this.publish();
        let failure: unknown;
        try {
            await this.call(settingsOperations.putSetting(APP_LANGUAGE_KEY, tag, "profile"), false);
            if (current.isDeviceValue) await this.clearDeviceValue();
        } catch (error) {
            if (this.controller.signal.aborted || (error instanceof ApiError && error.aborted)) return;
            failure = error;
        }
        this.saving = false;
        if (failure !== undefined) {
            this.choice = current;
            this.errorMessage = writeFailure(failure);
        }
        this.publish();
        // Success or not, show what the server now resolves: a failed step may have landed anyway.
        try { await this.read(sequence); } catch (error) { if (!(error instanceof ApiError && error.aborted)) this.publish(); }
    }

    private async clearDeviceValue(): Promise<void> {
        try {
            await this.call(settingsOperations.deleteSetting(APP_LANGUAGE_KEY, "profile_device"), false);
        } catch (error) {
            // Nothing stored for this TV: the profile's value already applies.
            if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
    }

    private async read(sequence: number): Promise<void> {
        const effective = await this.call(settingsOperations.effectiveSettings([APP_LANGUAGE_KEY]));
        if (!this.isCurrent(sequence) || this.saving) return;
        const row = effective.get(APP_LANGUAGE_KEY);
        if (row === undefined) return;
        this.adopt({ tag: typeof row.value === "string" ? row.value : null, isDeviceValue: row.source === "profile_device" });
    }

    private isCurrent(sequence: number): boolean {
        return !this.controller.signal.aborted && sequence === this.refreshSequence && this.profileId === this.session.activeProfile?.id;
    }

    private adopt(choice: AppLanguageChoice | undefined): void {
        this.choice = choice;
        this.publish();
    }

    private call<T>(spec: RequestSpec<T>, replayAfterRefresh = true): Promise<T> {
        return this.session.call({ ...spec, profileScoped: true, replayAfterRefresh, signal: this.controller.signal });
    }

    private publish(): void {
        const snapshot = JSON.stringify({ choice: this.currentChoice, saving: this.saving, error: this.errorMessage });
        if (snapshot === this.published) return;
        this.published = snapshot;
        for (const listener of this.listeners) listener();
    }
}
