// Consumed subset of settings v1, server cc851494 (manifest revision 24).
import { boolean, integer, object, string, WireError } from "./wire.ts";

export const HIDDEN_KEY = "ui.disabled_library_ids";
export const AUDIO_KEY = "playback.audio_language";
export const QUALITY_KEY = "playback.preferred_quality";
export const BITRATE_KEY = "playback.max_bitrate_kbps";
export const SETTINGS_KEYS = [HIDDEN_KEY, AUDIO_KEY, QUALITY_KEY, BITRATE_KEY] as const;
export type SettingsKey = (typeof SETTINGS_KEYS)[number];
export type SettingValue = null | string | number | readonly number[];
export interface SettingsCapabilities {
    readonly apiVersion: number;
    readonly revision: string;
    readonly manifestRevision: number;
    readonly state: string;
    readonly allowed: boolean;
    readonly scopes: readonly string[];
}
export interface SettingDefinition {
    readonly key: SettingsKey;
    readonly introducedIn: number;
    readonly profile: boolean;
    readonly options: readonly { value: string; label: string; introducedIn: number; deprecated: boolean }[];
}
export interface SettingsContract {
    readonly apiVersion: number;
    readonly revision: number;
    readonly definitions: readonly SettingDefinition[];
}
export type ExplicitSetting = { readonly isSet: false } | { readonly isSet: true; readonly value: SettingValue; readonly revision: number };
export interface EffectiveSetting {
    readonly value: SettingValue;
    readonly source: string;
    readonly definitionRevision: number;
    readonly constrained: boolean;
    readonly requestedValue?: SettingValue;
    readonly storedValue?: SettingValue;
    readonly permittedValues?: readonly SettingValue[];
    readonly suggestedValues?: readonly SettingValue[];
}

function array(value: unknown, path: string): unknown[] {
    if (!Array.isArray(value)) throw new WireError(path, "an array");
    return value;
}
function strings(value: unknown, path: string): string[] {
    return array(value, path).map(entry => {
        if (typeof entry !== "string") throw new WireError(path, "strings");
        return entry;
    });
}
export function decodeSettingsCapabilities(value: unknown): SettingsCapabilities {
    const obj = object(value, "settings_capabilities");
    return {
        apiVersion: integer(obj, "api_version", "settings_capabilities"),
        revision: string(obj, "revision", "settings_capabilities"),
        manifestRevision: integer(obj, "manifest_revision", "settings_capabilities"),
        state: string(obj, "state", "settings_capabilities"),
        allowed: boolean(obj, "allowed", "settings_capabilities"),
        scopes: strings(obj.scopes, "settings_capabilities.scopes"),
    };
}

export function decodeSettingsContract(value: unknown): SettingsContract {
    const obj = object(value, "settings_contract");
    const sets = object(obj.option_sets, "settings_contract.option_sets");
    const definitions: SettingDefinition[] = [];
    for (const raw of array(obj.definitions, "settings_contract.definitions")) {
        const def = object(raw, "setting_definition");
        const key = SETTINGS_KEYS.find(key => def.key === key);
        if (key === undefined) continue;
        const schema = object(def.value_schema, "setting_definition.value_schema");
        if ((key === QUALITY_KEY || key === BITRATE_KEY) && def.persistence !== "remote") continue;
        if (key === AUDIO_KEY && (schema.nullable !== true || schema.type !== "language_tag")) continue;
        if (key === HIDDEN_KEY && (schema.nullable !== true || schema.type !== "object" || schema.schema_ref !== "library-id-list.json")) continue;
        if (key === QUALITY_KEY && (schema.type !== "enum" || schema.nullable === true || def.default_value !== "auto" || def.recommended_control !== "select")) continue;
        if (key === BITRATE_KEY && (schema.type !== "integer" || schema.nullable !== true || schema.minimum !== 100 || schema.maximum !== 200000 || def.default_value !== null || def.unit !== "kbps" || def.recommended_control !== "select")) continue;
        // Definitions restricted to another platform are advisory exclusions, not Tizen aliases.
        const platforms = def.platforms === undefined ? undefined : strings(def.platforms, "setting_definition.platforms");
        const scopes = strings(def.allowed_scopes, "setting_definition.allowed_scopes");
        let options: SettingDefinition["options"] = [];
        if (key === AUDIO_KEY && typeof def.suggested_options === "string") {
            const set = object(sets[def.suggested_options], "audio_options");
            options = array(set.options, "audio_options.options").map(raw => {
                const option = object(raw, "audio_option");
                const value = string(option, "value", "audio_option");
                decodeSettingValue(AUDIO_KEY, value);
                return { value, label: value, introducedIn: integer(option, "introduced_in", "audio_option"), deprecated: false };
            });
        }
        if (key === QUALITY_KEY) {
            options = array(schema.values, "quality_options").map(raw => {
                const option = object(raw, "quality_option");
                return { value: string(option, "value", "quality_option"), label: string(option, "label", "quality_option"), introducedIn: integer(def, "introduced_in", "setting_definition"), deprecated: option.deprecated === true };
            }).filter(option => ["auto", "480p", "720p", "1080p", "2160p", "original"].includes(option.value));
            if (!options.some(option => option.value === "auto" && !option.deprecated)) continue;
        }
        definitions.push({ key, introducedIn: integer(def, "introduced_in", "setting_definition"), profile: scopes.includes("profile") && (platforms === undefined || platforms.includes("tizen")), options });
    }
    return { apiVersion: integer(obj, "api_version", "settings_contract"), revision: integer(obj, "revision", "settings_contract"), definitions };
}

/** Keep opaque library IDs as strings everywhere except this validated JSON-integer boundary. */
export function numericLibraryId(id: string): number {
    const number = Number(id);
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(number)) throw new WireError("library.id", "a positive safe integer ID");
    return number;
}

export function decodeSettingValue(key: SettingsKey, value: unknown): SettingValue {
    if (key === QUALITY_KEY) {
        // Legacy and future stored strings remain visible; they are never offered as new choices.
        if (typeof value !== "string" || value.trim() === "") throw new WireError("preferred_quality.value", "a nonblank string");
        return value;
    }
    if (value === null) return null;
    if (key === BITRATE_KEY) {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > 200000) throw new WireError("max_bitrate_kbps.value", "an integer from 100 to 200000 or null");
        return value;
    }
    if (key === HIDDEN_KEY) {
        const ids = array(value, "hidden_libraries.value");
        if (ids.length > 512 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)) throw new WireError("hidden_libraries.value", "up to 512 unique positive integer IDs");
        return ids as number[];
    }
    // Match the server's canonical tag grammar, including unregistered and private-use tags.
    const tag = /^(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?(?:-(?:[a-z0-9]{5,8}|\d[a-z0-9]{3}))*(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?|x(?:-[a-z0-9]{1,8})+)$/i;
    if (typeof value !== "string" || !tag.test(value) || duplicateSubtags(value)) throw new WireError("audio_language.value", "a canonical BCP 47 tag or null");
    return value;
}

function duplicateSubtags(value: string): boolean {
    const parts = value.toLowerCase().split("-");
    const seen = new Set<string>();
    let extension = false;
    if (parts[0] === "x") return false;
    for (const part of parts.slice(1)) {
        if (part === "x") break;
        if (part.length === 1 || (!extension && (part.length >= 5 || /^\d...$/.test(part)))) {
            if (seen.has(part)) return true;
            seen.add(part);
        }
        if (part.length === 1) extension = true;
    }
    return false;
}

export function decodeStoredSetting(key: SettingsKey, value: unknown): Extract<ExplicitSetting, { isSet: true }> {
    const obj = object(value, "setting_value");
    if (obj.key !== key || obj.scope !== "profile") throw new WireError("setting_value", "the requested profile setting");
    return { isSet: true, value: decodeSettingValue(key, obj.value), revision: integer(obj, "revision", "setting_value") };
}

export function decodeExplicitSettings(keys: readonly SettingsKey[], value: unknown): Map<SettingsKey, ExplicitSetting> {
    const obj = object(value, "explicit_settings");
    integer(obj, "revision", "explicit_settings");
    const entries = array(obj.items, "explicit_settings.items").map(raw => object(raw, "explicit_setting"));
    return new Map(keys.map(key => {
        const rows = entries.filter(entry => entry.key === key);
        const row = rows[0];
        if (rows.length !== 1 || row?.scope !== "profile") throw new WireError("explicit_settings.items", "each requested profile key once");
        return [key, boolean(row, "is_set", "explicit_setting") ? decodeStoredSetting(key, row) : { isSet: false }];
    }));
}

export function decodeEffectiveSettings(keys: readonly SettingsKey[], value: unknown): Map<SettingsKey, EffectiveSetting> {
    const obj = object(value, "effective_settings");
    integer(obj, "revision", "effective_settings");
    const entries = array(obj.items, "effective_settings.items").map(raw => object(raw, "effective_setting"));
    return new Map(keys.map(key => {
        const rows = entries.filter(entry => entry.key === key);
        const row = rows[0];
        if (rows.length !== 1 || row === undefined) throw new WireError("effective_settings.items", "each requested key once");
        const result: EffectiveSetting = {
            value: decodeSettingValue(key, row.value), source: string(row, "source", "effective_setting"),
            definitionRevision: integer(row, "definition_revision", "effective_setting"),
            constrained: row.constrained === undefined ? false : boolean(row, "constrained", "effective_setting"),
            ...(row.requested_value === undefined ? {} : { requestedValue: decodeSettingValue(key, row.requested_value) }),
            ...(row.stored_value === undefined ? {} : { storedValue: decodeSettingValue(key, row.stored_value) }),
            ...(row.permitted_values === undefined ? {} : { permittedValues: array(row.permitted_values, "permitted_values").map(value => decodeSettingValue(key, value)) }),
            ...(row.suggested_values === undefined ? {} : { suggestedValues: array(row.suggested_values, "suggested_values").map(value => decodeSettingValue(key, value)) }),
        };
        return [key, result];
    }));
}
