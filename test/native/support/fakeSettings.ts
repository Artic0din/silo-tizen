import type { FakeSilo, Reply } from "./fakeSilo.ts";
import { fixture, problem } from "./fakeSilo.ts";
import { AUDIO_KEY, HIDDEN_KEY, type SettingsKey, type SettingValue } from "../../../src/contracts/v2/settings.ts";

export class FakeSettings {
    readonly rows = new Map<string, Map<SettingsKey, SettingValue>>();
    readonly overrides = new Map<SettingsKey, SettingValue>();
    revision = 24;
    allowed = true;
    constrained = false;
    constructor(fake: FakeSilo) {
        const catalog = fake.catalog;
        fake.catalog = { route: (method, path, profile, body) => this.route(method, path, profile, body) ?? catalog?.route(method, path, profile, body) };
    }
    profile(id = "p-owner"): Map<SettingsKey, SettingValue> {
        let rows = this.rows.get(id);
        if (rows === undefined) { rows = new Map(); this.rows.set(id, rows); }
        return rows;
    }
    private route(method: string, path: string, profile: string | undefined, body: Record<string, unknown> | undefined): Reply | undefined {
        const url = new URL(path, "https://fake.invalid");
        const pathname = url.pathname;
        if (pathname === "/settings/contract/capabilities") return { status: 200, body: { api_version: 1, revision: "opaque-24", manifest_revision: this.revision, state: "available", allowed: this.allowed, scopes: ["profile"] } };
        if (pathname === "/settings/contract") return { status: 200, body: fixture("settings_contract_ok") };
        if (!pathname.startsWith("/settings/values")) return undefined;
        if (profile === undefined) return problem(422, "validation_failed", "Profile required");
        const rows = this.profile(profile);
        if (pathname === "/settings/values" || pathname === "/settings/values/effective") {
            const effective = pathname.endsWith("/effective");
            const items = url.searchParams.getAll("keys").map(key => {
                const typed = key as SettingsKey;
                const base = { key, scope: "profile", profile_id: profile };
                if (!effective) return rows.has(typed) ? { ...base, is_set: true, value: rows.get(typed), revision: 7 } : { ...base, is_set: false };
                const override = this.overrides.has(typed);
                const value = override ? this.overrides.get(typed) : rows.get(typed) ?? null;
                return { key, value, source: override ? "profile_device" : rows.has(typed) ? "profile" : "default", definition_revision: this.revision, ...(this.constrained && typed === AUDIO_KEY ? { constrained: true, requested_value: rows.get(typed) ?? null, permitted_values: [null, "en"] } : {}) };
            });
            return { status: 200, body: { items, revision: this.revision } };
        }
        const key = pathname.slice("/settings/values/".length) as SettingsKey;
        if (key !== HIDDEN_KEY && key !== AUDIO_KEY) return problem(422, "validation_failed", "Unknown setting");
        if (url.searchParams.get("scope") !== "profile") return problem(422, "validation_failed", "Profile scope required");
        if (method === "DELETE") {
            if (!rows.delete(key)) return problem(404, "not_found", "Unset");
            return { status: 204 };
        }
        if (method === "PUT") {
            rows.set(key, body?.value as SettingValue);
        }
        return rows.has(key) ? { status: 200, body: { key, scope: "profile", profile_id: profile, value: rows.get(key), revision: 7 } } : problem(404, "not_found", "Unset");
    }
}
