import { ApiError } from "../api/errors.ts";
import { systemClock, type Clock } from "../api/clock.ts";
import type { RequestSpec } from "../api/http.ts";
import { operations } from "../api/operations.ts";
import type { UserLibrary } from "../contracts/v2/catalog.ts";
import { AUDIO_KEY, HIDDEN_KEY, QUALITY_KEY, TITLE_ART_KEY, SEEK_KEYS, SETTINGS_KEYS, decodeSettingValue, numericLibraryId, profileSettings, type SettingsIdentity, type SettingsScope, type EffectiveSetting, type ExplicitSetting, type SettingDefinition, type SettingsKey, type SettingValue } from "../contracts/v2/settings.ts";
import { NativeSession, SessionError } from "../session/session.ts";

type TitleEdit = { key: typeof TITLE_ART_KEY; kind: "title"; profile: ExplicitSetting; steps: { scope: SettingsScope; value?: boolean; done?: boolean }[] };
type Edit = TitleEdit | ({ key: SettingsKey } & ({ kind: "reset" } | { kind: "value"; value: SettingValue } | { kind: "hidden"; id: number; hidden: boolean }));
class SettingsConflict extends Error {}

export class SettingsState {
    readonly explicit = new Map<SettingsKey, ExplicitSetting>();
    readonly effective = new Map<SettingsKey, EffectiveSetting>();
    titleDevice: ExplicitSetting | undefined;
    definitions: readonly SettingDefinition[] = [];
    libraries: readonly UserLibrary[] = [];
    audioOptions: readonly (string | null)[] = [];
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
    get qualityOptions(): SettingDefinition["options"] { return this.definitions.find(def => def.key === QUALITY_KEY)?.options.filter(option => !option.deprecated && option.value !== "original") ?? []; }
    private get active(): boolean { return !this.controller.signal.aborted; }
    private get identity(): SettingsIdentity {
        const profile = this.session.activeProfile;
        if (profile === undefined) throw new SessionError("unavailable");
        return { profileId: profile.id, deviceId: this.session.http.deviceId, ...(this.manifestRevision === undefined ? {} : { manifestRevision: this.manifestRevision }) };
    }
    private call<T>(spec: RequestSpec<T>): Promise<T> {
        return this.session.call({ ...spec, profileScoped: true, replayAfterRefresh: spec.method === "GET", signal: this.controller.signal });
    }

    async load(): Promise<void> {
        if (!this.active || this.busy || this.clock.now() < this.retryAt) return;
        this.busy = true;
        this.loaded = false;
        this.definitions = [];
        this.explicit.clear();
        this.effective.clear();
        this.titleDevice = undefined;
        this.libraries = [];
        this.audioOptions = [];
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
            this.definitions = profileSettings(contract, capability);
            this.manifestRevision = contract.revision;
            this.batchedEffective = capability.supportsBatchedEffective;
            const keys = SETTINGS_KEYS.filter(key => this.definitions.some(def => def.key === key));
            if (keys.length > 0) await this.readValues(keys);
            const libraries = keys.includes(HIDDEN_KEY) ? await this.call(operations.listUserLibraries(true)) : [];
            if (!this.active) return;
            this.libraries = libraries;
            const options = this.definitions.find(def => def.key === AUDIO_KEY)?.options.filter(option => option.introducedIn <= revision).map(option => option.value).filter((value): value is string => typeof value === "string") ?? [];
            this.audioOptions = [null, ...(revision >= 9 ? ["x-silo-original"] : []), ...options];
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
        const [explicit, effective, device] = await Promise.all([this.call(operations.settingsValues(keys, "profile", identity)), Promise.all((this.batchedEffective ? [keys] : keys.map(key => [key])).map(group => this.call(operations.effectiveSettings(group, identity)))), keys.includes(TITLE_ART_KEY) ? this.call(operations.settingsValues([TITLE_ART_KEY], "profile_device", identity)) : undefined]);
        if (!this.active) return;
        for (const [key, value] of explicit) this.explicit.set(key, value);
        for (const values of effective) for (const [key, value] of values) this.effective.set(key, value);
        if (device !== undefined) this.titleDevice = device.get(TITLE_ART_KEY);
    }

    save(key: SettingsKey, value: SettingValue): Promise<void> {
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
    setHidden(id: string, hidden: boolean): Promise<void> { return this.edit({ key: HIDDEN_KEY, kind: "hidden", id: numericLibraryId(id), hidden }); }
    retry(): Promise<void> { return this.retryEdit === undefined ? this.load() : this.edit(this.retryEdit); }

    private achieved(edit: Edit): boolean {
        if (edit.kind === "title") return edit.steps.every(step => step.done);
        const stored = this.explicit.get(edit.key);
        if (stored === undefined) return false;
        if (edit.kind === "reset") return !stored.isSet;
        if (!stored.isSet) return false;
        if (edit.kind === "hidden") return (Array.isArray(stored.value) && stored.value.includes(edit.id)) === edit.hidden;
        return JSON.stringify(stored.value) === JSON.stringify(edit.value);
    }

    private async edit(edit: Edit): Promise<void> {
        if (!this.active || this.busy || this.clock.now() < this.retryAt || !this.loaded || !this.definitions.some(def => def.key === edit.key)) return;
        if (this.retryEdit !== undefined && this.retryEdit !== edit) return;
        this.busy = true;
        this.error = undefined;
        this.retryEdit = undefined;
        this.changed();
        try {
            if (edit.kind === "title") { await this.applyTitleEdit(edit); return; }
            if (edit.kind === "value") {
                decodeSettingValue(edit.key, edit.value);
                if (edit.key === QUALITY_KEY && !this.qualityOptions.some(option => option.value === edit.value)) throw new Error("Choose a supported quality.");
                if (SEEK_KEYS.some(key => key === edit.key) && !this.definitions.find(def => def.key === edit.key)?.options.some(option => option.value === edit.value)) throw new Error("Choose a supported seek interval.");
            }
            await this.readValues([edit.key]);
            if (!this.active || this.achieved(edit)) {
                if (edit.key === HIDDEN_KEY) this.hiddenChanged = true;
                return;
            }
            let value: SettingValue = null;
            if (edit.kind === "value") value = decodeSettingValue(edit.key, edit.value);
            if (edit.kind === "hidden") {
                const stored = this.explicit.get(HIDDEN_KEY);
                const ids = stored?.isSet && Array.isArray(stored.value) ? stored.value : [];
                value = decodeSettingValue(HIDDEN_KEY, edit.hidden ? [...ids.filter(id => id !== edit.id), edit.id] : ids.filter(id => id !== edit.id));
            }
            if (edit.key === HIDDEN_KEY) this.hiddenChanged = true;
            let refused: unknown;
            try {
                await this.call(edit.kind === "reset" ? operations.deleteSetting(edit.key) : operations.putSetting(edit.key, value));
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
        this.effective.clear();
        this.titleDevice = undefined;
        this.definitions = [];
        this.libraries = [];
        this.audioOptions = [];
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
