import { ApiError } from "../api/errors.ts";
import type { JsonValue, RequestSpec } from "../api/http.ts";
import { subtitleDisplayOperations as operations } from "../api/subtitleDisplayOperations.ts";
import { subtitleOperations } from "../api/subtitleOperations.ts";
import { decodeSettingsCapabilities } from "../contracts/v2/settings.ts";
import { DEFAULT_APPEARANCE, type SubtitleAppearance } from "../contracts/v2/subtitles.ts";
import type { NativeSession } from "../session/session.ts";
import { allowedScopes, appearanceValue, APPEARANCE_KEY, clampDelay, editAppearance, type AppearanceMember, subtitleControlSupport, type SubtitleControlSupport, SYNC_KEY, syncWriteScope } from "./subtitleAppearance.ts";

export interface SubtitleDisplayView {
    readonly delay: boolean;
    readonly styling: boolean;
    readonly deviceScope: boolean;
    readonly textOpacity: boolean;
    readonly delayMs: number;
    readonly appearance: SubtitleAppearance;
    readonly deviceOverride: boolean;
    readonly busy: boolean;
    readonly message: string;
}

const FAILED = "Couldn't save that change. Try again.";

export class SubtitleDisplay {
    private readonly session: NativeSession;
    private readonly profileId: string;
    private readonly onChange: (appearance: SubtitleAppearance, sync: number) => void;
    private readonly changed: () => void;
    private readonly abort = new AbortController();
    private support: SubtitleControlSupport = { delay: false, styling: false, deviceScope: false, syncAtProfile: false, textOpacity: false };
    private syncScopes: readonly string[] = [];
    private manifest = 0;
    private appearance: SubtitleAppearance = DEFAULT_APPEARANCE;
    private delayMs = 0;
    private deviceOverride = false;
    private busy = false;
    private message = "";
    private loaded = false;
    private edited = false;

    constructor(session: NativeSession, profileId: string, onChange: (appearance: SubtitleAppearance, sync: number) => void, changed: () => void) {
        this.session = session;
        this.profileId = profileId;
        this.onChange = onChange;
        this.changed = changed;
    }

    get view(): SubtitleDisplayView | undefined {
        if (!this.loaded) return undefined;
        return {
            delay: this.support.delay, styling: this.support.styling, deviceScope: this.support.deviceScope, textOpacity: this.support.textOpacity,
            delayMs: this.delayMs, appearance: this.appearance, deviceOverride: this.deviceOverride, busy: this.busy, message: this.message,
        };
    }

    get editedAppearance(): boolean { return this.edited; }

    destroy(): void { this.abort.abort(); }

    async load(): Promise<void> {
        let effectiveSupported = false;
        try {
            const capability = await this.call(operations.capabilities());
            const contract = await this.call(operations.contract());
            const support = subtitleControlSupport(contract, capability);
            effectiveSupported = support.styling || support.delay || support.deviceScope;
            const device = support.deviceScope ? await this.call(operations.deviceAppearance(this.profileId, this.session.http.deviceId)) : false;
            const [appearance, readDelay] = await Promise.all([
                support.styling ? this.call(subtitleOperations.subtitleAppearance(this.profileId)) : this.appearance,
                support.delay ? this.call(subtitleOperations.subtitleSync()) : this.delayMs,
            ]);
            let delay = readDelay;
            // Older builds saved Delay on this device without turning the appearance override on.
            // That row hides the profile offset. Apple clears it once the profile can store the offset.
            if (!device && support.syncAtProfile && support.delay) {
                try {
                    const leftover = await this.call(operations.deviceTiming(this.profileId, this.session.http.deviceId));
                    if (leftover) {
                        try {
                            await this.call(operations.delete(SYNC_KEY, "profile_device"));
                            delay = await this.call(subtitleOperations.subtitleSync());
                        } catch (error) {
                            if (this.abort.signal.aborted || (error instanceof ApiError && error.aborted)) return;
                            this.message = "This TV still has its own subtitle delay.";
                        }
                    }
                } catch (error) {
                    if (this.abort.signal.aborted || (error instanceof ApiError && error.aborted)) return;
                }
            }
            if (this.abort.signal.aborted) return;
            this.appearance = appearance;
            this.delayMs = delay;
            this.support = support;
            this.syncScopes = allowedScopes(contract, SYNC_KEY);
            this.manifest = decodeSettingsCapabilities(capability).manifestRevision;
            this.deviceOverride = device;
            this.loaded = true;
            this.onChange(appearance, delay);
        } catch (error) {
            if (this.abort.signal.aborted) return;
            this.loaded = true;
            if (!(error instanceof ApiError && error.status === 404 && !effectiveSupported)) this.message = "Could not load subtitle preferences. Reopen playback to retry.";
        }
        this.changed();
    }

    adopt(appearance: SubtitleAppearance, sync: number): void {
        if (this.edited || this.busy || this.abort.signal.aborted) return;
        this.appearance = appearance;
        this.delayMs = sync;
        if (this.loaded) this.changed();
    }

    async setDelay(milliseconds: number): Promise<void> {
        if (!this.support.delay) return;
        const next = clampDelay(milliseconds);
        const scope = syncWriteScope(this.deviceOverride, this.syncScopes, this.manifest);
        await this.commit(() => this.call(operations.put(SYNC_KEY, next, scope)), () => { this.delayMs = next; });
    }

    async setSize(size: SubtitleAppearance["fontSize"]): Promise<void> {
        await this.writeAppearance(editAppearance(this.appearance, "fontSize", size));
    }

    async setPosition(position: SubtitleAppearance["position"]): Promise<void> {
        await this.writeAppearance(editAppearance(this.appearance, "position", position));
    }

    async setAppearance(member: AppearanceMember, value: string | number | boolean): Promise<void> {
        await this.writeAppearance(editAppearance(this.appearance, member, value));
    }

    async setDeviceOverride(enabled: boolean): Promise<void> {
        if (!this.support.deviceScope || this.busy) return;
        if (enabled) {
            await this.commit(() => this.call(operations.put(APPEARANCE_KEY, appearanceJson(this.appearance, this.support.textOpacity), "profile_device")), () => { this.deviceOverride = true; });
            return;
        }
        await this.commit(async () => {
            await this.call(operations.delete(APPEARANCE_KEY, "profile_device"));
            if (this.support.syncAtProfile) await this.call(operations.delete(SYNC_KEY, "profile_device"));
            this.deviceOverride = false;
            try {
                const [appearance, delay] = await Promise.all([
                    this.support.styling ? this.call(subtitleOperations.subtitleAppearance(this.profileId)) : this.appearance,
                    this.support.delay ? this.call(subtitleOperations.subtitleSync()) : this.delayMs,
                ]);
                this.appearance = appearance;
                this.delayMs = delay;
            } catch (error) {
                this.support = { ...this.support, styling: false, delay: false, deviceScope: false };
                throw error;
            }
        }, () => { this.deviceOverride = false; });
    }

    private async writeAppearance(next: SubtitleAppearance): Promise<void> {
        if (!this.support.styling) return;
        const scope = this.deviceOverride && this.support.deviceScope ? "profile_device" : "profile";
        await this.commit(() => this.call(operations.put(APPEARANCE_KEY, appearanceJson(next, this.support.textOpacity), scope)), () => { this.appearance = next; });
    }

    private async commit(send: () => Promise<void>, apply: () => void): Promise<void> {
        if (this.busy || this.abort.signal.aborted) return;
        this.busy = true;
        this.message = "";
        this.changed();
        try {
            await send();
            if (this.abort.signal.aborted) return;
            this.edited = true;
            apply();
            this.onChange(this.appearance, this.delayMs);
        } catch (error) {
            if (this.abort.signal.aborted || (error instanceof ApiError && error.aborted)) return;
            this.message = FAILED;
        } finally {
            this.busy = false;
            if (!this.abort.signal.aborted) this.changed();
        }
    }

    private call<T>(spec: RequestSpec<T>): Promise<T> {
        return this.session.call({ ...spec, profileScoped: true, replayAfterRefresh: spec.method === "GET", signal: this.abort.signal });
    }
}

function appearanceJson(appearance: SubtitleAppearance, includeTextOpacity: boolean): JsonValue {
    const value: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(appearanceValue(appearance, includeTextOpacity))) {
        if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") value[key] = item;
    }
    return value;
}
