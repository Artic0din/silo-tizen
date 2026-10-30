import { ApiError } from "../api/errors.ts";
import { systemClock, type Clock } from "../api/clock.ts";
import type { RequestSpec } from "../api/http.ts";
import { operations } from "../api/operations.ts";
import type { UserLibrary } from "../contracts/v2/catalog.ts";
import { AUDIO_KEY, HIDDEN_KEY, QUALITY_KEY, SEEK_KEYS, SETTINGS_KEYS, decodeSettingValue, numericLibraryId, profileSettings, type EffectiveSetting, type ExplicitSetting, type SettingDefinition, type SettingsKey, type SettingValue } from "../contracts/v2/settings.ts";
import { NativeSession, SessionError } from "../session/session.ts";

type Edit = { key: SettingsKey } & ({ kind: "reset" } | { kind: "value"; value: SettingValue } | { kind: "hidden"; id: number; hidden: boolean });

export class SettingsState {
    readonly explicit = new Map<SettingsKey, ExplicitSetting>();
    readonly effective = new Map<SettingsKey, EffectiveSetting>();
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
        } catch (error) {
            if (this.active) this.fail(error);
        } finally {
            this.busy = false;
            if (this.active) this.changed();
        }
    }

    private async readValues(keys: readonly SettingsKey[]): Promise<void> {
        const [explicit, effective] = await Promise.all([this.call(operations.settingsValues(keys)), Promise.all((this.batchedEffective ? [keys] : keys.map(key => [key])).map(group => this.call(operations.effectiveSettings(group))))]);
        if (!this.active) return;
        for (const [key, value] of explicit) this.explicit.set(key, value);
        for (const values of effective) for (const [key, value] of values) this.effective.set(key, value);
    }

    save(key: SettingsKey, value: SettingValue): Promise<void> { return this.edit({ key, kind: "value", value }); }
    reset(key: SettingsKey): Promise<void> { return this.edit({ key, kind: "reset" }); }
    setHidden(id: string, hidden: boolean): Promise<void> { return this.edit({ key: HIDDEN_KEY, kind: "hidden", id: numericLibraryId(id), hidden }); }
    retry(): Promise<void> { return this.retryEdit === undefined ? this.load() : this.edit(this.retryEdit); }

    private achieved(edit: Edit): boolean {
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
            if (!(error instanceof ApiError) || error.transient || error.status === 404 || error.failure.kind === "invalid_response") this.retryEdit = edit;
        } finally {
            this.busy = false;
            if (this.active) this.changed();
        }
    }

    stop(): void {
        this.controller.abort();
        this.stopAuthority();
        this.explicit.clear();
        this.effective.clear();
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
