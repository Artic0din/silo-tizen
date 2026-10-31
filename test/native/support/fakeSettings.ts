import type { FakeSilo, Reply } from "./fakeSilo.ts";
import { fixture, problem } from "./fakeSilo.ts";
import { AUDIO_KEY, QUALITY_KEY, SEEK_BACK_KEY, SEEK_FORWARD_KEY, SETTINGS_KEYS, type SettingsKey, type SettingValue } from "../../../src/contracts/v2/settings.ts";
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
    constrained = false;
    constructor(fake: FakeSilo) {
        const catalog = fake.catalog;
        fake.catalog = { route: (method, path, profile, body, headers) => this.route(method, path, profile, body, headers?.["x-silo-device-id"]) ?? catalog?.route(method, path, profile, body, headers) };
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
        if (pathname === "/settings/contract/capabilities") return { status: 200, body: { api_version: 1, revision: "opaque-24", manifest_revision: this.revision, state: "available", allowed: this.allowed, scopes: ["profile", "profile_device"], supports_batched_effective: this.supportsBatchedEffective } };
        if (pathname === "/settings/contract") return { status: 200, body: fixture("settings_contract_ok") };
        if (!pathname.startsWith("/settings/values")) return undefined;
        if (profile === undefined) return problem(422, "validation_failed", "Profile required");
        const scope = url.searchParams.get("scope") ?? "profile";
        const profileRows = this.profile(profile);
        const deviceRows = this.device(profile, device ?? "");
        const rows = scope === "profile_device" ? deviceRows : profileRows;
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
                const override = this.overrides.has(typed);
                const value = override ? this.overrides.get(typed) : rows.has(typed) ? rows.get(typed) : typed === QUALITY_KEY ? "auto" : typed === SEEK_BACK_KEY ? 10 : typed === SEEK_FORWARD_KEY ? 30 : null;
                return { key, value, source: override ? "profile_device" : rows.has(typed) ? "profile" : "default", definition_revision: this.revision, ...(this.constrained && typed === AUDIO_KEY ? { constrained: true, requested_value: rows.get(typed) ?? null, permitted_values: [null, "en"] } : {}) };
            });
            return { status: 200, body: { items, revision: this.revision } };
        }
        const key = pathname.slice("/settings/values/".length) as SettingsKey;
        if (!SETTINGS_KEYS.some(known => known === key) && key !== TITLE) return problem(422, "validation_failed", "Unknown setting");
        if (scope !== "profile" && !(key === TITLE && scope === "profile_device" && device)) return problem(422, "validation_failed", "Invalid scope");
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
