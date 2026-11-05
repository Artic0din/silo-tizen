import { ApiError } from "../api/errors.ts";
import { systemClock, type Clock } from "../api/clock.ts";
import type { RequestSpec } from "../api/http.ts";
import { operations } from "../api/operations.ts";
import type { UserLibrary } from "../contracts/v2/catalog.ts";
import { AUDIO_KEY, HIDDEN_KEY, QUALITY_KEY, TITLE_ART_KEY, SEEK_KEYS, SETTINGS_KEYS, SHOW_FORCED_KEY, SUBTITLE_LANGUAGE_KEY, SUBTITLE_MODE_KEY, decodeSettingValue, numericLibraryId, profileSettings, type SettingsIdentity, type SettingsScope, type EffectiveSetting, type ExplicitSetting, type SettingDefinition, type SettingsKey, type SettingValue } from "../contracts/v2/settings.ts";
import { NativeSession, SessionError } from "../session/session.ts";
import { APPEARANCE_KEY, METADATA_KEY, INTRO_SKIP_KEY, CREDITS_SKIP_KEY } from "../contracts/v2/settingsRows.ts";
import { DEFAULT_APPEARANCE } from "../contracts/v2/subtitles.ts";

type TitleEdit = { key: typeof TITLE_ART_KEY; kind: "title"; profile: ExplicitSetting; steps: { scope: SettingsScope; value?: boolean; done?: boolean }[] };
type Edit = TitleEdit | ({ key: SettingsKey; scope?: SettingsScope; snapshot?: ExplicitSetting } & ({ kind: "reset" } | { kind: "device-reset" } | { kind: "appearance-device" } | { kind: "appearance-profile" } | { kind: "value"; value: SettingValue } | { kind: "hidden"; id: number; hidden: boolean }));
class SettingsConflict extends Error {}

export class SettingsState {
    readonly explicit = new Map<SettingsKey, ExplicitSetting>();
    readonly device = new Map<SettingsKey, ExplicitSetting>();
    readonly client = new Map<SettingsKey, ExplicitSetting>();
    readonly effective = new Map<SettingsKey, EffectiveSetting>();
    titleDevice: ExplicitSetting | undefined;
    definitions: readonly SettingDefinition[] = [];
    libraries: readonly UserLibrary[] = [];
    audioOptions: readonly (string | null)[] = [];
    subtitleOptions: readonly string[] = [];
    busy = false;
    loaded = false;
    error: string | undefined;
    hiddenChanged = false;
    private retryEdit: Edit | undefined;
    private readonly session: NativeSession;
    private readonly changed: () => void;
    private readonly clock: Clock;
    private retryAt = 0;
    private batchedEffective = false;
    private manifestRevision: number | undefined;
    private readonly controller = new AbortController();
    private readonly stopAuthority: () => void;

    constructor(session: NativeSession, changed: () => void, clock: Clock = systemClock) {
        this.session = session;
        this.changed = changed;
        this.clock = clock;
        this.stopAuthority = session.onAuthorityChange(() => { this.stop(); this.changed(); });
    }
    get canRetry(): boolean { return this.retryEdit !== undefined; }
    scope(key: SettingsKey): SettingsScope {
        if (key === APPEARANCE_KEY && this.device.get(key)?.isSet) return "profile_device";
        if (key === "ui.card_presentation" && this.definitions.some(def => def.key === key && def.client)) return "profile_client";
        return [AUDIO_KEY, QUALITY_KEY, "playback.max_bitrate_kbps", "playback.auto_play_next", "playback.next_up_prompt_seconds", INTRO_SKIP_KEY, CREDITS_SKIP_KEY].includes(key) && this.definitions.some(def => def.key === key && def.device) ? "profile_device" : "profile";
    }
    stored(key: SettingsKey): ExplicitSetting | undefined { return (this.scope(key) === "profile_device" ? this.device : this.scope(key) === "profile_client" ? this.client : this.explicit).get(key); }
    subtitleProfileValue(key: typeof SUBTITLE_LANGUAGE_KEY | typeof SUBTITLE_MODE_KEY | typeof SHOW_FORCED_KEY): SettingValue {
        const stored = this.explicit.get(key);
        return stored?.isSet ? stored.value : key === SUBTITLE_LANGUAGE_KEY ? null : key === SUBTITLE_MODE_KEY ? "auto" : true;
    }
    get qualityOptions(): SettingDefinition["options"] { return this.definitions.find(def => def.key === QUALITY_KEY)?.options.filter(option => !option.deprecated && option.value !== "original") ?? []; }
    private get active(): boolean { return !this.controller.signal.aborted; }
    private get identity(): SettingsIdentity {
        const profile = this.session.activeProfile;
        if (profile === undefined) throw new SessionError("unavailable");
        return { profileId: profile.id, deviceId: this.session.http.deviceId, ...(this.manifestRevision === undefined ? {} : { manifestRevision: this.manifestRevision }) };
    }
    private call<T>(spec: RequestSpec<T>): Promise<T> {
        return this.session.call({ ...spec, ...(spec.path.includes("ui.card_presentation") ? { clientFamily: "tv" } : {}), profileScoped: true, replayAfterRefresh: spec.method === "GET", signal: this.controller.signal });
    }

    async load(): Promise<void> {
        if (!this.active || this.busy || this.clock.now() < this.retryAt) return;
        this.busy = true;
        this.loaded = false;
        this.definitions = [];
        this.explicit.clear();
        this.device.clear();
        this.client.clear();
        this.effective.clear();
        this.titleDevice = undefined;
        this.libraries = [];
        this.audioOptions = [];
        this.subtitleOptions = [];
        this.error = undefined;
        this.changed();
        try {
            const capability = await this.call(operations.settingsCapabilities());
            if (!this.active) return;
            if (capability.apiVersion !== 1 || capability.state !== "available" || !capability.allowed || !capability.scopes.includes("profile")) throw new Error("Settings are unavailable for this profile.");
            const contract = await this.call(operations.settingsContract());
            if (!this.active) return;
            if (contract.apiVersion !== 1 || contract.revision < capability.manifestRevision) throw new Error("The server settings contract changed. Try again.");
            const revision = Math.min(contract.revision, capability.manifestRevision);
            this.definitions = profileSettings(contract, capability).filter(def => def.key !== "ui.card_presentation" || (capability.supportsBatchedEffective && capability.supportsAtomicShortcuts && capability.scopes.includes("profile_client") && capability.clientFamilies.includes("tv") && def.client));
            this.manifestRevision = contract.revision;
            this.batchedEffective = capability.supportsBatchedEffective;
            const keys: SettingsKey[] = [...SETTINGS_KEYS, SUBTITLE_LANGUAGE_KEY, SUBTITLE_MODE_KEY, SHOW_FORCED_KEY].filter(key => this.definitions.some(def => def.key === key));
            if (keys.length > 0) await this.readValues(keys);
            const libraries = keys.includes(HIDDEN_KEY) ? await this.call(operations.listUserLibraries(true)) : [];
            if (!this.active) return;
            this.libraries = libraries;
            const options = this.definitions.find(def => def.key === AUDIO_KEY)?.options.filter(option => option.introducedIn <= revision).map(option => option.value).filter((value): value is string => typeof value === "string") ?? [];
            this.audioOptions = [null, ...(revision >= 9 ? ["x-silo-original"] : []), ...options];
            this.subtitleOptions = this.definitions.find(def => def.key === SUBTITLE_LANGUAGE_KEY)?.options.filter(option => option.introducedIn <= revision && typeof option.value === "string").map(option => String(option.value)) ?? [];
            this.loaded = true;
            this.retryEdit = undefined;
            if (capability.manifestRevision >= 16 && !this.definitions.some(def => def.key === TITLE_ART_KEY)) this.error = "Title-art settings are unavailable. Reload settings.";
        } catch (error) {
            if (this.active) this.fail(error);
        } finally {
            this.busy = false;
            if (this.active) this.changed();
        }
    }

    private async readValues(keys: readonly SettingsKey[]): Promise<void> {
        const identity = this.identity;
        const clientKeys = keys.filter(key => this.scope(key) === "profile_client");
        if (clientKeys.length > 0) {
            const values = await this.call(operations.settingsValues(clientKeys, "profile_client", identity));
            if (!this.active) return;
            for (const [key, value] of values) this.client.set(key, value);
        }
        const deviceKeys = keys.filter(key => key === TITLE_ART_KEY || ((key === APPEARANCE_KEY || key === "ui.card_presentation") && this.definitions.some(def => def.key === key && def.device)) || this.scope(key) === "profile_device");
        const [explicit, effective, device] = await Promise.all([this.call(operations.settingsValues(keys, "profile", identity)), Promise.all((this.batchedEffective ? [keys] : keys.map(key => [key])).map(group => this.call(operations.effectiveSettings(group, identity)))), deviceKeys.length > 0 ? this.call(operations.settingsValues(deviceKeys, "profile_device", identity)) : undefined]);
        if (!this.active) return;
        for (const [key, value] of explicit) this.explicit.set(key, value);
        for (const values of effective) for (const [key, value] of values) this.effective.set(key, value);
        if (device !== undefined) {
            for (const [key, value] of device) this.device.set(key, value);
            if (keys.includes(TITLE_ART_KEY)) this.titleDevice = device.get(TITLE_ART_KEY);
        }
    }

    save(key: SettingsKey, value: SettingValue): Promise<void> {
        // Legacy stored null stays selected; new device no-preference choices clear the row.
        if (key === AUDIO_KEY && value === null && this.scope(key) === "profile_device") {
            const stored = this.stored(key);
            if (stored?.isSet && stored.value === null) return Promise.resolve();
            return this.reset(key);
        }
        if (key !== TITLE_ART_KEY) return this.edit({ key, kind: "value", value });
        decodeSettingValue(key, value);
        const effective = this.effective.get(key);
        if (effective === undefined || effective.value === value) return Promise.resolve();
        return this.titleEdit([{ scope: effective.source === "profile" ? "profile" : "profile_device", value: value as boolean }]);
    }
    setTitleArtScope(all: boolean): Promise<void> {
        const effective = this.effective.get(TITLE_ART_KEY);
        if (effective === undefined || typeof effective.value !== "boolean" || all === (effective.source === "profile")) return Promise.resolve();
        return this.titleEdit(all ? [{ scope: "profile", value: effective.value }] : [{ scope: "profile_device", value: effective.value }, { scope: "profile" }]);
    }
    private titleEdit(steps: TitleEdit["steps"]): Promise<void> {
        const profile = this.explicit.get(TITLE_ART_KEY);
        return profile === undefined ? Promise.resolve() : this.edit({ key: TITLE_ART_KEY, kind: "title", profile, steps });
    }
    reset(key: SettingsKey): Promise<void> { return this.edit({ key, kind: "reset" }); }
    resetPosterDevice(): Promise<void> { return this.edit({ key: "ui.card_presentation", kind: "device-reset" }); }
    setAppearanceDevice(enabled: boolean): Promise<void> { return this.edit({ key: APPEARANCE_KEY, kind: enabled ? "appearance-device" : "appearance-profile" }); }
    setHidden(id: string, hidden: boolean): Promise<void> { return this.edit({ key: HIDDEN_KEY, kind: "hidden", id: numericLibraryId(id), hidden }); }
    retry(): Promise<void> { return this.retryEdit === undefined ? this.load() : this.edit(this.retryEdit); }

    private achieved(edit: Edit): boolean {
        if (edit.kind === "title") return edit.steps.every(step => step.done);
        if (edit.kind === "appearance-device" || edit.kind === "appearance-profile") return this.device.get(APPEARANCE_KEY)?.isSet === (edit.kind === "appearance-device");
        const scope = edit.kind === "device-reset" ? "profile_device" : edit.scope ?? this.scope(edit.key);
        const stored = (scope === "profile_device" ? this.device : scope === "profile_client" ? this.client : this.explicit).get(edit.key);
        if (stored === undefined) return false;
        if (edit.kind === "reset" || edit.kind === "device-reset") return !stored.isSet;
        if (!stored.isSet) return false;
        if (edit.kind === "hidden") return (Array.isArray(stored.value) && stored.value.includes(edit.id)) === edit.hidden;
        return edit.kind === "value" && JSON.stringify(stored.value) === JSON.stringify(edit.value);
    }

    private async edit(edit: Edit): Promise<void> {
        if (!this.active || this.busy || this.clock.now() < this.retryAt || !this.loaded || !this.definitions.some(def => def.key === edit.key)) return;
        if (this.retryEdit !== undefined && this.retryEdit !== edit) return;
        if (edit.kind !== "title" && edit.scope === undefined) edit = { ...edit, scope: this.scope(edit.key) };
        if (edit.kind === "value" && edit.value !== null && typeof edit.value === "object" && !Array.isArray(edit.value) && edit.snapshot === undefined) edit = { ...edit, snapshot: this.stored(edit.key) ?? { isSet: false } };
        this.busy = true;
        this.error = undefined;
        this.retryEdit = undefined;
        this.changed();
        try {
            const originalScope = this.scope(edit.key);
            if (edit.kind === "title") { await this.applyTitleEdit(edit); return; }
            if (edit.kind === "value") {
                decodeSettingValue(edit.key, edit.value);
                if (edit.key === QUALITY_KEY && !this.qualityOptions.some(option => option.value === edit.value)) throw new Error("Choose a supported quality.");
                if (SEEK_KEYS.some(key => key === edit.key) && !this.definitions.find(def => def.key === edit.key)?.options.some(option => option.value === edit.value)) throw new Error("Choose a supported seek interval.");
            }
            await this.readValues([edit.key]);
            if ((edit.kind === "value" || edit.kind === "reset") && originalScope !== this.scope(edit.key)) throw new SettingsConflict("The setting scope changed. Reload settings before editing it.");
            if (!this.active || this.achieved(edit)) {
                if (edit.key === HIDDEN_KEY) this.hiddenChanged = true;
                return;
            }
            if (edit.snapshot !== undefined && JSON.stringify(edit.snapshot) !== JSON.stringify(this.stored(edit.key))) throw new SettingsConflict("The setting changed on another device. Reload settings before editing it.");
            let value: SettingValue = null;
            if (edit.kind === "appearance-device") value = this.effective.get(APPEARANCE_KEY)?.value ?? { ...DEFAULT_APPEARANCE };
            if (edit.kind === "value") value = decodeSettingValue(edit.key, edit.value);
            if (edit.kind === "hidden") {
                const stored = this.explicit.get(HIDDEN_KEY);
                const ids = stored?.isSet && Array.isArray(stored.value) ? stored.value : [];
                value = decodeSettingValue(HIDDEN_KEY, edit.hidden ? [...ids.filter(id => id !== edit.id), edit.id] : ids.filter(id => id !== edit.id));
            }
            if (edit.key === HIDDEN_KEY || edit.key === METADATA_KEY) this.hiddenChanged = true;
            let refused: unknown;
            try {
                const scope = edit.kind === "device-reset" || edit.kind === "appearance-device" || edit.kind === "appearance-profile" ? "profile_device" : edit.scope ?? this.scope(edit.key);
                await this.call(edit.kind === "reset" || edit.kind === "device-reset" || edit.kind === "appearance-profile" ? operations.deleteSetting(edit.key, scope) : operations.putSetting(edit.key, value, scope, this.identity));
            } catch (error) {
                if (error instanceof ApiError && (error.status === 403 || error.status === 422 || error.status === 429)) throw error;
                refused = error;
            }
            if (!this.active) return;
            // A failed answer can still have committed. Read this exact scope before offering retry.
            await this.readValues([edit.key]);
            if (!this.active || this.achieved(edit)) return;
            if (refused !== undefined) throw refused;
            throw new Error("The server did not confirm the change. Check again before retrying.");
        } catch (error) {
            if (!this.active) return;
            this.fail(error);
            if (!(error instanceof SettingsConflict) && (!(error instanceof ApiError) || error.transient || error.status === 404 || error.failure.kind === "invalid_response")) this.retryEdit = edit;
        } finally {
            this.busy = false;
            if (this.active) this.changed();
        }
    }

    private async applyTitleEdit(edit: TitleEdit): Promise<void> {
        const conflict = new SettingsConflict("Title art changed on another device. Reload settings before changing it.");
        const checkSnapshot = (): void => {
            const profile = this.explicit.get(TITLE_ART_KEY);
            const effective = this.effective.get(TITLE_ART_KEY);
            const winner = profile?.isSet ? profile : this.titleDevice?.isSet ? this.titleDevice : undefined;
            const source = profile?.isSet ? "profile" : winner === undefined ? "default" : "profile_device";
            if (effective?.source !== source || (winner !== undefined && effective.value !== winner.value)) throw conflict;
        };
        await this.readValues([TITLE_ART_KEY]);
        if (!this.active) return;
        checkSnapshot();
        for (const step of edit.steps) {
            if (!this.active) return;
            const profile = this.explicit.get(TITLE_ART_KEY);
            const stored = step.scope === "profile" ? profile : this.titleDevice;
            const achieved = (): boolean => {
                const row = step.scope === "profile" ? this.explicit.get(TITLE_ART_KEY) : this.titleDevice;
                return row !== undefined && (step.value === undefined ? !row.isSet : row.isSet && row.value === step.value);
            };
            if (step.done && !achieved()) throw conflict;
            if (achieved()) { step.done = true; continue; }
            // Reconcile a newer profile choice rather than clearing or overwriting it.
            if (JSON.stringify(profile) !== JSON.stringify(edit.profile)) throw conflict;
            let lostAnswer: unknown;
            try {
                step.value === undefined
                    ? await this.call(operations.deleteSetting(TITLE_ART_KEY, step.scope))
                    : await this.call(operations.putSetting(TITLE_ART_KEY, step.value, step.scope, this.identity, stored?.isSet ? stored.revision : 0));
            } catch (error) {
                if (error instanceof ApiError && error.status === 404 && step.value === undefined) { /* Already absent. */ }
                else if (error instanceof ApiError && [403, 422, 429].includes(error.status ?? 0)) throw error;
                else lostAnswer = error;
            }
            if (!this.active) return;
            await this.readValues([TITLE_ART_KEY]);
            if (!this.active) return;
            checkSnapshot();
            if (!achieved()) throw lostAnswer ?? new Error("The server did not confirm the title-art change. Check and retry.");
            const confirmed = step.scope === "profile" ? this.explicit.get(TITLE_ART_KEY) : this.titleDevice;
            if (step.value !== undefined && stored?.isSet && confirmed?.isSet && confirmed.revision <= stored.revision) throw new Error("The server did not advance the title-art row revision. Reload settings.");
            step.done = true;
        }
    }

    stop(): void {
        this.controller.abort();
        this.stopAuthority();
        this.explicit.clear();
        this.device.clear();
        this.effective.clear();
        this.titleDevice = undefined;
        this.definitions = [];
        this.libraries = [];
        this.audioOptions = [];
        this.subtitleOptions = [];
        this.retryEdit = undefined;
        this.loaded = false;
        this.error = undefined;
    }

    private fail(error: unknown): void {
        this.error = settingsError(error);
        if (error instanceof ApiError && error.retryAfterSeconds !== undefined) this.retryAt = this.clock.now() + error.retryAfterSeconds * 1000;
    }
}

function settingsError(error: unknown): string {
    if (error instanceof SessionError) return "The session is unavailable. Try again.";
    if (error instanceof ApiError) {
        if (error.status === 429) return `Too many requests.${error.retryAfterSeconds === undefined ? " Try again later." : ` Try again after ${error.retryAfterSeconds} seconds.`}`;
        if (error.status === 422) return "The server refused this value. Reload settings before choosing another value.";
        if (error.status === 403) return "This profile cannot change the setting.";
        if (error.failure.kind === "invalid_response") return "The server sent an unreadable settings answer. Check again.";
        return "Could not confirm settings with the server. Check the connection and try again.";
    }
    return error instanceof Error ? error.message : "Could not load settings. Try again.";
}
