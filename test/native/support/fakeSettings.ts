import type { FakeSilo, Reply } from "./fakeSilo.ts";
import { fixture, problem } from "./fakeSilo.ts";
import { AUDIO_KEY, DOLBY_VISION_KEY, HDR_KEY, QUALITY_KEY, SEEK_BACK_KEY, SEEK_FORWARD_KEY, SETTINGS_KEYS, SHOW_FORCED_KEY, SPOILER_IMAGE_KEY, SPOILER_OVERVIEW_KEY, SUBTITLE_LANGUAGE_KEY, SUBTITLE_MODE_KEY, type SettingsKey, type SettingValue } from "../../../src/contracts/v2/settings.ts";
const TITLE = "ui.title_art" as SettingsKey;

export class FakeSettings {
    readonly rows = new Map<string, Map<SettingsKey, SettingValue>>();
    readonly overrides = new Map<SettingsKey, SettingValue>();
    readonly devices = new Map<string, Map<SettingsKey, SettingValue>>();
    readonly rowRevisions = new Map<string, number>();
    titleDefault = true;
    revision = 24;
    allowed = true;
    supportsBatchedEffective = true;
    clientFamilies: string[] = ["tv"];
    supportsAtomicShortcuts = true;
    cardClientFamily: string | undefined;
    constrained = false;
    devicePlayback = true;
    /** Adds the profile subtitle definitions Apple TV edits. The vendored fixture omits them. */
    profileSubtitles = false;
    /** Adds the device-only HDR and Dolby Vision definitions. The vendored fixture omits them. */
    hdrRows = false;
    remainingRows = false;
    /** `GET /settings/overlay-config`; undefined answers 404. */
    overlayConfig: { enabled: boolean; defaults?: string } | undefined = { enabled: true };
    constructor(fake: FakeSilo) {
        const catalog = fake.catalog;
        fake.catalog = { route: (method, path, profile, body, headers) => {
            if (path.includes("ui.card_presentation")) this.cardClientFamily = headers?.["x-silo-client-family"];
            return this.route(method, path, profile, body, headers?.["x-silo-device-id"]) ?? catalog?.route(method, path, profile, body, headers);
        } };
    }
    profile(id = "p-owner"): Map<SettingsKey, SettingValue> {
        let rows = this.rows.get(id);
        if (rows === undefined) { rows = new Map(); this.rows.set(id, rows); }
        return rows;
    }
    device(profile: string, device: string): Map<SettingsKey, SettingValue> {
        const id = JSON.stringify([profile, device]);
        let rows = this.devices.get(id);
        if (rows === undefined) { rows = new Map(); this.devices.set(id, rows); }
        return rows;
    }
    private route(method: string, path: string, profile: string | undefined, body: Record<string, unknown> | undefined, device?: string): Reply | undefined {
        const url = new URL(path, "https://fake.invalid");
        const pathname = url.pathname;
        if (pathname === "/settings/contract/capabilities") return { status: 200, body: { api_version: 1, revision: "opaque-24", manifest_revision: this.revision, state: "available", allowed: this.allowed, scopes: ["profile", "profile_client", "profile_device"], supports_batched_effective: this.supportsBatchedEffective, supports_atomic_shortcuts: this.supportsAtomicShortcuts, client_families: this.clientFamilies } };
        if (pathname === "/settings/contract") {
            const contract = fixture("settings_contract_ok");
            if (this.remainingRows && Array.isArray(contract.definitions)) {
                const extra = fixture("settings_rows_216");
                if (Array.isArray(extra.definitions)) {
                    const keys = extra.definitions.map(def => def.key);
                    contract.definitions = [...contract.definitions.filter(def => !keys.includes(def.key)), ...extra.definitions];
                }
                if (typeof contract.option_sets === "object" && contract.option_sets !== null) Object.assign(contract.option_sets, extra.option_sets);
            }
            if (!this.devicePlayback && Array.isArray(contract.definitions)) contract.definitions = contract.definitions.map(def => [AUDIO_KEY, QUALITY_KEY, "playback.max_bitrate_kbps"].includes(String(def.key)) ? { ...def, allowed_scopes: ["profile"] } : def);
            if (this.hdrRows && Array.isArray(contract.definitions)) {
                const hdrDefinition = (key: string, label: string, description: string) => ({
                    key, label, description, introduced_in: 1, persistence: "remote", allowed_scopes: ["profile_device"], resolution_order: ["profile_device", "default"],
                    value_schema: { type: "boolean" }, default_value: true, platforms: ["ios", "tvos", "macos", "android", "android_tv"], category: "player", recommended_control: "switch",
                });
                contract.definitions = [...contract.definitions.filter(def => def.key !== HDR_KEY && def.key !== DOLBY_VISION_KEY), hdrDefinition(HDR_KEY, "HDR", "Allow HDR output on this device."), hdrDefinition(DOLBY_VISION_KEY, "Dolby Vision", "Allow Dolby Vision output on this device.")];
            }
            if (this.profileSubtitles && Array.isArray(contract.definitions)) {
                const sets = contract.option_sets;
                if (typeof sets === "object" && sets !== null) Object.assign(sets, { playback_subtitle_languages: { type: "language_tag", options: [{ value: "en", introduced_in: 1 }, { value: "fr", introduced_in: 1 }] } });
                const scopes = ["profile", "profile_device", "profile_library", "profile_series"];
                const order = ["profile_series", "profile_library", "profile_device", "profile", "default"];
                contract.definitions = [...contract.definitions, {
                    key: SUBTITLE_LANGUAGE_KEY, introduced_in: 1, persistence: "remote", allowed_scopes: scopes, resolution_order: order,
                    value_schema: { type: "language_tag", nullable: true }, default_value: null, recommended_control: "select", suggested_options: "playback_subtitle_languages", unset_label: "None",
                }, {
                    key: SUBTITLE_MODE_KEY, introduced_in: 1, persistence: "remote", allowed_scopes: scopes, resolution_order: order,
                    value_schema: { type: "enum", nullable: false, values: [{ value: "auto", label: "Auto" }, { value: "always", label: "Always on" }, { value: "off", label: "Off" }] },
                    default_value: "auto", recommended_control: "select",
                }, {
                    key: SHOW_FORCED_KEY, introduced_in: 1, persistence: "remote", allowed_scopes: scopes, resolution_order: order,
                    value_schema: { type: "boolean", nullable: false }, default_value: true, recommended_control: "switch",
                }];
            }
            return { status: 200, body: contract };
        }
        if (pathname === "/settings/overlay-config") return this.overlayConfig === undefined ? problem(404, "not_found", "Not found") : { status: 200, body: { quick_actions_enabled: false, quick_actions_default: "both", ...this.overlayConfig } };
        if (!pathname.startsWith("/settings/values")) return undefined;
        if (profile === undefined) return problem(422, "validation_failed", "Profile required");
        const scope = url.searchParams.get("scope") ?? "profile";
        const profileRows = this.profile(profile);
        const deviceRows = this.device(profile, device ?? "");
        const familyRows = this.device(profile, "client:tv");
        const rows = scope === "profile_device" ? deviceRows : scope === "profile_client" ? familyRows : profileRows;
        const rowRevision = (key: string, rowScope = scope): number => this.rowRevisions.get(JSON.stringify([profile, rowScope, rowScope === "profile_device" ? device : undefined, key])) ?? 7;
        if (pathname === "/settings/values" || pathname === "/settings/values/effective") {
            const effective = pathname.endsWith("/effective");
            if (effective && !this.supportsBatchedEffective && url.searchParams.getAll("keys").length > 1) return problem(422, "validation_failed", "Batch not supported");
            const items = url.searchParams.getAll("keys").map(key => {
                const typed = key as SettingsKey;
                const base = { key, scope, profile_id: profile, ...(scope === "profile_device" ? { device_id: device } : {}) };
                if (!effective) return rows.has(typed) ? { ...base, is_set: true, value: rows.get(typed), revision: rowRevision(key) } : { ...base, is_set: false };
                if (typed === TITLE) {
                    const source = profileRows.has(typed) ? "profile" : deviceRows.has(typed) ? "profile_device" : "default";
                    return { key, value: source === "profile" ? profileRows.get(typed) : source === "profile_device" ? deviceRows.get(typed) : this.titleDefault, source, definition_revision: 16,
                        ...(source === "default" ? {} : { scope: source, profile_id: profile, ...(source === "profile_device" ? { device_id: device } : {}), source_context: { profile_id: profile, ...(source === "profile_device" ? { device_id: device } : {}) } }) };
                }
                if (typed === "ui.card_presentation" && familyRows.has(typed) && !deviceRows.has(typed)) return { key, value: familyRows.get(typed), source: "profile_client", definition_revision: this.revision };
                const deviceOverride = typed !== SEEK_BACK_KEY && typed !== SEEK_FORWARD_KEY && deviceRows.has(typed);
                const override = this.overrides.has(typed) || deviceOverride;
                const defaults = fixture("settings_rows_216").definitions;
                const fallback = typed === SPOILER_IMAGE_KEY || typed === SPOILER_OVERVIEW_KEY ? false : Array.isArray(defaults) ? defaults.find(def => def.key === key)?.default_value : undefined;
                const value = this.overrides.has(typed) ? this.overrides.get(typed) : deviceOverride ? deviceRows.get(typed) : profileRows.has(typed) ? profileRows.get(typed) : key === "ui.card_presentation" ? { poster_size: "standard", caption: "title_metadata" } : typed === QUALITY_KEY ? "auto" : typed === SEEK_BACK_KEY ? 10 : typed === SEEK_FORWARD_KEY ? 30 : typed === SUBTITLE_MODE_KEY ? "auto" : typed === SHOW_FORCED_KEY || typed === HDR_KEY || typed === DOLBY_VISION_KEY ? true : fallback ?? null;
                return { key, value, source: override ? "profile_device" : rows.has(typed) ? "profile" : "default", definition_revision: this.revision, ...(this.constrained && typed === AUDIO_KEY ? { constrained: true, requested_value: rows.get(typed) ?? null, permitted_values: [null, "en"] } : {}) };
            });
            return { status: 200, body: { items, revision: this.revision } };
        }
        const key = pathname.slice("/settings/values/".length) as SettingsKey;
        if (!SETTINGS_KEYS.some(known => known === key) && key !== TITLE && key !== SPOILER_IMAGE_KEY && key !== SPOILER_OVERVIEW_KEY && key !== SUBTITLE_LANGUAGE_KEY && key !== SUBTITLE_MODE_KEY && key !== SHOW_FORCED_KEY) return problem(422, "validation_failed", "Unknown setting");
        if (scope !== "profile" && !(key === "ui.card_presentation" && scope === "profile_client") && !([TITLE, "playback.subtitle_appearance", "ui.card_presentation", AUDIO_KEY, QUALITY_KEY, "playback.max_bitrate_kbps", "playback.auto_play_next", "playback.next_up_prompt_seconds", "playback.intro_skip_mode", "playback.auto_skip_credits", HDR_KEY, DOLBY_VISION_KEY].includes(key) && scope === "profile_device" && device)) return problem(422, "validation_failed", "Invalid scope");
        if (method === "DELETE") {
            if (!rows.delete(key)) return problem(404, "not_found", "Unset");
            return { status: 204 };
        }
        if (method === "PUT") {
            rows.set(key, body?.value as SettingValue);
            if (key === TITLE) this.rowRevisions.set(JSON.stringify([profile, scope, scope === "profile_device" ? device : undefined, key]), rowRevision(key) + 1);
        }
        return rows.has(key) ? { status: 200, body: { key, scope, profile_id: profile, ...(scope === "profile_device" ? { device_id: device } : {}), value: rows.get(key), revision: rowRevision(key) } } : problem(404, "not_found", "Unset");
    }
}
