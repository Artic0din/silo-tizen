// Consumed subset of settings v1, server cc851494 (manifest revision 24).
import { boolean, integer, object, string, WireError } from "./wire.ts";
import { PRIMARY_MENU_KEY, decodePrimaryMenu } from "./navigation.ts";
import { ROW_KEYS, BUFFERING_MODE_KEY, INTRO_SKIP_KEY, CREDITS_SKIP_KEY, ADVISORY_KEY, APPEARANCE_KEY, METADATA_KEY } from "./settingsRows.ts";
import { decodeAppearance } from "./subtitles.ts";

export const HIDDEN_KEY = "ui.disabled_library_ids";
export const TITLE_ART_KEY = "ui.title_art";
export const AUDIO_KEY = "playback.audio_language";
export const QUALITY_KEY = "playback.preferred_quality";
export const BITRATE_KEY = "playback.max_bitrate_kbps";
export const SUBTITLE_LANGUAGE_KEY = "playback.subtitle_language" as const;
export const SUBTITLE_MODE_KEY = "playback.subtitle_mode" as const;
export const SHOW_FORCED_KEY = "playback.show_forced_subtitles" as const;
export const SEEK_BACK_KEY = "player.video_skip_back_seconds";
export const SEEK_FORWARD_KEY = "player.video_skip_forward_seconds";
export const SEEK_KEYS = [SEEK_BACK_KEY, SEEK_FORWARD_KEY] as const;
/** Device-only boolean. Apple's manifest lists it; the vendored subset does not. */
export const HDR_KEY = "player.hdr_enabled";
export const HDR_KEYS = [HDR_KEY] as const;
const SEEK_SECONDS = [5, 10, 15, 30, 45, 60, 90];
export const NEXT_UP_KEY = "playback.next_up_prompt_seconds";
export const AUTO_NEXT_KEY = "playback.auto_play_next";
/** Read-only here: the profile's poster-badge document (`card-overlays.json`) and its on/off choice. */
export const CARD_OVERLAYS_KEY = "ui.card_overlays";
export const CARD_OVERLAYS_ENABLED_KEY = "ui.card_overlays_enabled";
export const CARD_PRESENTATION_KEY = "ui.card_presentation";
/** Profile switches from settings manifest revision 17. The consumed contract subset does not list them. */
export const SPOILER_IMAGE_KEY = "catalog.hide_unwatched_episode_images";
/** Profile and profile-device booleans from settings manifest revision 11, read and written by `ThemeMusicPreferences` only. */
export const THEME_MUSIC_ENABLED_KEY = "ui.theme_music_enabled";
export const THEME_MUSIC_LOOP_KEY = "ui.theme_music_loop";
export const SPOILER_OVERVIEW_KEY = "catalog.hide_unwatched_episode_overviews";
export const SETTINGS_KEYS = [HIDDEN_KEY, AUDIO_KEY, QUALITY_KEY, BITRATE_KEY, ...SEEK_KEYS, ...HDR_KEYS, TITLE_ART_KEY, AUTO_NEXT_KEY, NEXT_UP_KEY, ...ROW_KEYS] as const;
export type SettingsKey = (typeof SETTINGS_KEYS)[number] | typeof AUTO_NEXT_KEY | typeof SUBTITLE_LANGUAGE_KEY | typeof SUBTITLE_MODE_KEY | typeof SHOW_FORCED_KEY | typeof CARD_OVERLAYS_KEY | typeof CARD_OVERLAYS_ENABLED_KEY | typeof CARD_PRESENTATION_KEY | typeof PRIMARY_MENU_KEY | typeof SPOILER_IMAGE_KEY | typeof SPOILER_OVERVIEW_KEY | typeof THEME_MUSIC_ENABLED_KEY | typeof THEME_MUSIC_LOOP_KEY;
type Json = null | boolean | string | number | readonly Json[] | { readonly [member: string]: Json | undefined };
export type SettingValue = null | boolean | string | number | readonly number[] | { readonly [member: string]: Json | undefined };
export type SettingsScope = "profile" | "profile_device" | "profile_client";
export interface SettingsIdentity { readonly profileId: string; readonly deviceId: string; readonly manifestRevision?: number }
export interface SettingsCapabilities {
    readonly apiVersion: number;
    readonly revision: string;
    readonly manifestRevision: number;
    readonly state: string;
    readonly allowed: boolean;
    readonly scopes: readonly string[];
    readonly supportsBatchedEffective: boolean;
    readonly supportsAtomicShortcuts: boolean;
    readonly clientFamilies: readonly string[];
}
export interface SettingDefinition {
    readonly key: SettingsKey;
    readonly introducedIn: number;
    readonly profile: boolean;
    readonly device: boolean;
    readonly client?: boolean;
    readonly options: readonly { value: string | number; label: string; introducedIn: number; deprecated: boolean }[];
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
        supportsBatchedEffective: obj.supports_batched_effective === undefined ? false : boolean(obj, "supports_batched_effective", "settings_capabilities"),
        supportsAtomicShortcuts: obj.supports_atomic_shortcuts === undefined ? false : boolean(obj, "supports_atomic_shortcuts", "settings_capabilities"),
        clientFamilies: obj.client_families === undefined ? [] : strings(obj.client_families, "settings_capabilities.client_families"),
    };
}

export function decodeSettingsContract(value: unknown): SettingsContract {
    const obj = object(value, "settings_contract");
    const sets = object(obj.option_sets, "settings_contract.option_sets");
    const definitions: SettingDefinition[] = [];
    let titleArtSeen = false;
    for (const raw of array(obj.definitions, "settings_contract.definitions")) {
        const def = object(raw, "setting_definition");
        const key = ([...SETTINGS_KEYS, AUTO_NEXT_KEY, SUBTITLE_LANGUAGE_KEY, SUBTITLE_MODE_KEY, SHOW_FORCED_KEY] as const).find(key => def.key === key);
        if (key === undefined) continue;
        if (key === TITLE_ART_KEY) {
            if (titleArtSeen) throw new WireError("setting_definition.key", "each title-art key once");
            titleArtSeen = true;
        }
        const schema = object(def.value_schema, "setting_definition.value_schema");
        const extra = ROW_KEYS.some(row => row === key);
        if (extra && (def.persistence !== "remote" || schema.type !== (key === INTRO_SKIP_KEY || key === BUFFERING_MODE_KEY ? "enum" : key === METADATA_KEY ? "language_tag" : key === APPEARANCE_KEY || key === CARD_PRESENTATION_KEY ? "object" : "boolean"))) continue;
        const seek = key === SEEK_BACK_KEY || key === SEEK_FORWARD_KEY;
        const titleArt = key === TITLE_ART_KEY;
        const subtitleLanguage = key === SUBTITLE_LANGUAGE_KEY;
        const subtitleMode = key === SUBTITLE_MODE_KEY;
        const showForced = key === SHOW_FORCED_KEY;
        if (key === NEXT_UP_KEY && (def.persistence !== "remote" || schema.type !== "integer" || schema.nullable === true || schema.minimum !== 0 || schema.maximum !== 120 || def.default_value !== 30)) continue;
        if (key === AUTO_NEXT_KEY && (def.persistence !== "remote" || schema.type !== "boolean" || schema.nullable === true || def.default_value !== true || def.introduced_in !== 1 || JSON.stringify(def.allowed_scopes) !== JSON.stringify(["profile", "profile_device"]) || JSON.stringify(def.resolution_order) !== JSON.stringify(["profile_device", "profile", "default"]))) continue;
        if (titleArt && (def.persistence !== "remote" || schema.type !== "boolean" || (schema.nullable !== undefined && schema.nullable !== false) || def.default_value !== true || def.introduced_in !== 16 || def.recommended_control !== "switch")) continue;
        if (seek && (def.persistence !== "remote" || schema.type !== "enum" || schema.nullable === true || def.default_value !== (key === SEEK_BACK_KEY ? 10 : 30) || def.unit !== "seconds" || def.recommended_control !== "select" || def.introduced_in !== 9)) continue;
        if ((key === QUALITY_KEY || key === BITRATE_KEY) && def.persistence !== "remote") continue;
        if (key === AUDIO_KEY && (schema.nullable !== true || schema.type !== "language_tag")) continue;
        if (subtitleLanguage && (schema.nullable !== true || schema.type !== "language_tag" || def.default_value !== null || def.recommended_control !== "select" || def.unset_label !== "None" || typeof def.suggested_options !== "string")) continue;
        if (subtitleMode && (schema.type !== "enum" || schema.nullable === true || def.default_value !== "auto" || def.recommended_control !== "select")) continue;
        if (showForced && (schema.type !== "boolean" || schema.nullable === true || def.default_value !== true || def.recommended_control !== "switch")) continue;
        const hdr = key === HDR_KEY;
        if (hdr && (def.persistence !== "remote" || schema.type !== "boolean" || schema.nullable === true || def.default_value !== true || def.introduced_in !== 1 || def.recommended_control !== "switch" || JSON.stringify(def.allowed_scopes) !== JSON.stringify(["profile_device"]) || JSON.stringify(def.resolution_order) !== JSON.stringify(["profile_device", "default"]))) continue;
        if (hdr && definitions.some(existing => existing.key === key)) throw new WireError("setting_definition.key", "each HDR key once");
        if (key === HIDDEN_KEY && (schema.nullable !== true || schema.type !== "object" || schema.schema_ref !== "library-id-list.json")) continue;
        if (key === QUALITY_KEY && (schema.type !== "enum" || schema.nullable === true || def.default_value !== "auto" || def.recommended_control !== "select")) continue;
        if (key === BITRATE_KEY && (schema.type !== "integer" || schema.nullable !== true || schema.minimum !== 100 || schema.maximum !== 200000 || def.default_value !== null || def.unit !== "kbps" || def.recommended_control !== "select")) continue;
        // Definitions restricted to another platform are advisory exclusions, not Tizen aliases.
        const platforms = def.platforms === undefined ? undefined : strings(def.platforms, "setting_definition.platforms");
        const scopes = strings(def.allowed_scopes, "setting_definition.allowed_scopes");
        if (titleArt && (scopes.length !== 2 || !scopes.includes("profile") || !scopes.includes("profile_device") || JSON.stringify(def.resolution_order) !== JSON.stringify(["profile", "profile_device", "default"]))) continue;
        if (seek && (scopes.length !== 1 || scopes[0] !== "profile" || JSON.stringify(def.resolution_order) !== JSON.stringify(["profile", "default"]))) continue;
        let options: SettingDefinition["options"] = [];
        if ((key === AUDIO_KEY || key === METADATA_KEY || subtitleLanguage) && typeof def.suggested_options === "string") {
            const set = object(sets[def.suggested_options], "language_options");
            options = array(set.options, "language_options.options").map(raw => {
                const option = object(raw, "language_option");
                const value = string(option, "value", "language_option");
                decodeSettingValue(key, value);
                return { value, label: value, introducedIn: integer(option, "introduced_in", "language_option"), deprecated: false };
            });
        }
        if (subtitleMode) {
            const members = array(schema.values, "subtitle_mode_options").map(raw => object(raw, "subtitle_mode_option"));
            const values = ["auto", "always", "off"];
            if (members.length !== values.length || !values.every(value => members.filter(option => option.value === value).length === 1)) continue;
            options = members.map(option => {
                const value = string(option, "value", "subtitle_mode_option");
                const label = string(option, "label", "subtitle_mode_option");
                if (label.trim() === "") throw new WireError("subtitle_mode_option.label", "a nonblank label");
                return { value, label, introducedIn: option.introduced_in === undefined ? 1 : integer(option, "introduced_in", "subtitle_mode_option"), deprecated: option.deprecated === true };
            });
        }
        if (key === QUALITY_KEY) {
            options = array(schema.values, "quality_options").map(raw => {
                const option = object(raw, "quality_option");
                return { value: string(option, "value", "quality_option"), label: string(option, "label", "quality_option"), introducedIn: integer(def, "introduced_in", "setting_definition"), deprecated: option.deprecated === true };
            }).filter(option => ["auto", "480p", "720p", "1080p", "2160p", "original"].includes(option.value));
            if (!options.some(option => option.value === "auto" && !option.deprecated)) continue;
        }
        if (seek) {
            const members = array(schema.values, "seek_options").map(raw => object(raw, "seek_option"));
            if (members.length !== SEEK_SECONDS.length || !SEEK_SECONDS.every(value => members.filter(option => option.value === value).length === 1)) continue;
            options = members.map(option => {
                const value = integer(option, "value", "seek_option");
                const label = string(option, "label", "seek_option");
                if (label.trim() === "") throw new WireError("seek_option.label", "a nonblank label");
                return { value, label, introducedIn: option.introduced_in === undefined ? 9 : integer(option, "introduced_in", "seek_option"), deprecated: option.deprecated === true };
            });
            if (definitions.some(def => def.key === key)) throw new WireError("setting_definition.key", "each seek key once");
        }
        // Only the two seek keys and title art have approved advisory-platform adoption for a profile row.
        // HDR keys are device-only, so a platform list that omits tizen does not hide them.
        definitions.push({ key, introducedIn: integer(def, "introduced_in", "setting_definition"), profile: scopes.includes("profile") && (extra || seek || titleArt || subtitleLanguage || subtitleMode || showForced || platforms === undefined || platforms.includes("tizen")), device: scopes.includes("profile_device"), client: scopes.includes("profile_client"), options });
    }
    return { apiVersion: integer(obj, "api_version", "settings_contract"), revision: integer(obj, "revision", "settings_contract"), definitions };
}

export function profileSettings(contract: SettingsContract, capability: SettingsCapabilities): readonly SettingDefinition[] {
    if (capability.apiVersion !== 1 || capability.state !== "available" || !capability.allowed || !capability.scopes.includes("profile") || contract.apiVersion !== 1) return [];
    const revision = Math.min(contract.revision, capability.manifestRevision);
    const deviceScope = capability.scopes.includes("profile_device");
    const definitions = contract.definitions.filter(def => def.introducedIn <= revision && (def.profile || (deviceScope && def.device && def.key === HDR_KEY))).map(def => ({ ...def, device: def.device === true && deviceScope, options: def.options.filter(option => option.introducedIn <= revision) }));
    const pair = revision >= 9 && SEEK_KEYS.every(key => definitions.some(def => def.key === key && def.options.length === SEEK_SECONDS.length && def.options.every(option => !option.deprecated)));
    return definitions.filter(def => (pair || (def.key !== SEEK_BACK_KEY && def.key !== SEEK_FORWARD_KEY)) && (def.key !== TITLE_ART_KEY || capability.scopes.includes("profile_device")));
}

/** Keep opaque library IDs as strings everywhere except this validated JSON-integer boundary. */
export function numericLibraryId(id: string): number {
    const number = Number(id);
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(number)) throw new WireError("library.id", "a positive safe integer ID");
    return number;
}

export function decodeSettingValue(key: SettingsKey, value: unknown): SettingValue {
    if (key === APPEARANCE_KEY) {
        decodeAppearance({ profile_id: "validate", effective_value: JSON.stringify(value) }, "validate");
        return object(value, "appearance") as { readonly [member: string]: Json };
    }
    if (key === ADVISORY_KEY || key === CREDITS_SKIP_KEY) {
        if (typeof value !== "boolean") throw new WireError(key, "a boolean");
        return value;
    }
    if (key === INTRO_SKIP_KEY || key === BUFFERING_MODE_KEY) {
        if (value !== "never" && value !== "ask" && value !== "always") throw new WireError(key, "never, ask or always");
        return value;
    }
    if (key === PRIMARY_MENU_KEY) return decodePrimaryMenu(value);
    if (key === CARD_PRESENTATION_KEY) {
        const document = object(value, "card_presentation.value");
        if (!["compact", "standard", "large"].includes(string(document, "poster_size", "card_presentation.value"))) throw new WireError("card_presentation.value.poster_size", "a supported size");
        return document as { readonly [member: string]: Json };
    }
    if (key === CARD_OVERLAYS_KEY) {
        // The document's members are interpreted (and unknown ones dropped) by the badge registry.
        if (value === null) return null;
        // Decoded from a JSON response body, so every member is JSON.
        return object(value, "card_overlays.value") as { readonly [member: string]: Json };
    }
    if (key === CARD_OVERLAYS_ENABLED_KEY) {
        if (value !== null && typeof value !== "boolean") throw new WireError("card_overlays_enabled.value", "a JSON boolean or null");
        return value;
    }
    if (key === NEXT_UP_KEY) {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 120) throw new WireError(key, "an integer from 0 to 120");
        return value;
    }
    if (key === AUTO_NEXT_KEY) {
        if (typeof value !== "boolean") throw new WireError("auto_play_next.value", "a JSON boolean");
        return value;
    }
    if (key === SHOW_FORCED_KEY) {
        if (typeof value !== "boolean") throw new WireError("show_forced_subtitles.value", "a JSON boolean");
        return value;
    }
    if (key === HDR_KEY) {
        if (typeof value !== "boolean") throw new WireError(key, "a boolean");
        return value;
    }
    if (key === SUBTITLE_MODE_KEY) {
        if (value !== "auto" && value !== "always" && value !== "off") throw new WireError("subtitle_mode.value", "auto, always or off");
        return value;
    }
    if (key === TITLE_ART_KEY) {
        if (typeof value !== "boolean") throw new WireError("title_art.value", "a JSON boolean");
        return value;
    }
    if (key === SPOILER_IMAGE_KEY || key === SPOILER_OVERVIEW_KEY) {
        if (typeof value !== "boolean") throw new WireError("episode_spoiler.value", "a JSON boolean");
        return value;
    }
    if (key === THEME_MUSIC_ENABLED_KEY || key === THEME_MUSIC_LOOP_KEY) {
        if (typeof value !== "boolean") throw new WireError("theme_music.value", "a JSON boolean");
        return value;
    }
    if (key === SEEK_BACK_KEY || key === SEEK_FORWARD_KEY) {
        if (typeof value !== "number" || !SEEK_SECONDS.includes(value)) throw new WireError("video_skip_seconds.value", "one of 5, 10, 15, 30, 45, 60 or 90");
        return value;
    }
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
    if (typeof value !== "string" || !tag.test(value) || duplicateSubtags(value)) throw new WireError(key === SUBTITLE_LANGUAGE_KEY ? "subtitle_language.value" : "audio_language.value", "a canonical BCP 47 tag or null");
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

function titleIdentity(row: Readonly<Record<string, unknown>>, scope: SettingsScope, identity?: SettingsIdentity): void {
    if (row.scope !== scope || typeof row.profile_id !== "string" || row.profile_id === "" || (identity !== undefined && row.profile_id !== identity.profileId)
        || (scope === "profile_device" ? typeof row.device_id !== "string" || row.device_id === "" || (identity !== undefined && row.device_id !== identity.deviceId) : row.device_id !== undefined)
        || row.client_family !== undefined || row.library_id !== undefined || row.series_id !== undefined) throw new WireError("title_art.identity", "the requested profile and device scope identity");
}

export function decodeStoredSetting(key: SettingsKey, value: unknown, scope: SettingsScope = "profile", identity?: SettingsIdentity, previousRevision = 0): Extract<ExplicitSetting, { isSet: true }> {
    const obj = object(value, "setting_value");
    if (obj.key !== key || obj.scope !== scope) throw new WireError("setting_value", "the requested scoped setting");
    if (key === TITLE_ART_KEY) {
        titleIdentity(obj, scope, identity);
        if (integer(obj, "revision", "setting_value") <= previousRevision) throw new WireError("setting_value.revision", "an advancing positive row revision");
    }
    return { isSet: true, value: decodeSettingValue(key, obj.value), revision: integer(obj, "revision", "setting_value") };
}

export function decodeExplicitSettings(keys: readonly SettingsKey[], value: unknown, scope: SettingsScope = "profile", identity?: SettingsIdentity): Map<SettingsKey, ExplicitSetting> {
    const obj = object(value, "explicit_settings");
    integer(obj, "revision", "explicit_settings");
    if (keys.includes(TITLE_ART_KEY) && Number(obj.revision) < 16) throw new WireError("explicit_settings.revision", "a title-art contract revision");
    if (keys.includes(TITLE_ART_KEY) && identity?.manifestRevision !== undefined && obj.revision !== identity.manifestRevision) throw new WireError("explicit_settings.revision", "the discovered contract revision");
    const entries = array(obj.items, "explicit_settings.items").map(raw => object(raw, "explicit_setting"));
    return new Map(keys.map(key => {
        const rows = entries.filter(entry => entry.key === key);
        const row = rows[0];
        if (rows.length !== 1 || row?.scope !== scope) throw new WireError("explicit_settings.items", "each requested scoped key once");
        if (key === TITLE_ART_KEY) titleIdentity(row, scope, identity);
        return [key, boolean(row, "is_set", "explicit_setting") ? decodeStoredSetting(key, row, scope, identity) : { isSet: false }];
    }));
}

export function decodeEffectiveSettings(keys: readonly SettingsKey[], value: unknown, identity?: SettingsIdentity): Map<SettingsKey, EffectiveSetting> {
    const obj = object(value, "effective_settings");
    integer(obj, "revision", "effective_settings");
    if (keys.includes(TITLE_ART_KEY) && Number(obj.revision) < 16) throw new WireError("effective_settings.revision", "a title-art contract revision");
    if (keys.includes(TITLE_ART_KEY) && identity?.manifestRevision !== undefined && obj.revision !== identity.manifestRevision) throw new WireError("effective_settings.revision", "the discovered contract revision");
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
        if ((key === SEEK_BACK_KEY || key === SEEK_FORWARD_KEY) && (!["profile", "default"].includes(result.source) || result.definitionRevision < 9)) throw new WireError("effective_setting", "a profile or default seek interval introduced at revision 9");
        if (key === TITLE_ART_KEY) {
            if (!["profile", "profile_device", "default"].includes(result.source) || result.definitionRevision < 16 || result.definitionRevision > Number(obj.revision)) throw new WireError("title_art.effective", "a compatible effective source and definition revision");
            if (result.source === "default") {
                if (["scope", "profile_id", "device_id", "source_context", "client_family", "library_id", "series_id"].some(field => row[field] !== undefined)) throw new WireError("title_art.default", "an inherited default without a stored identity");
            } else {
                titleIdentity(row, result.source as SettingsScope, identity);
                if (row.source_context !== undefined) titleIdentity({ scope: result.source, ...object(row.source_context, "source_context") }, result.source as SettingsScope, identity);
            }
        }
        return [key, result];
    }));
}

/** `GET /settings/overlay-config`: the server-wide badge default and the administrator's baseline document. */
export interface OverlayConfig {
    readonly enabled: boolean;
    /** A JSON document string; absent when the administrator set none. */
    readonly defaults: string | undefined;
}

export function decodeOverlayConfig(value: unknown): OverlayConfig {
    const obj = object(value, "overlay_config");
    const defaults = obj.defaults;
    if (defaults !== undefined && typeof defaults !== "string") throw new WireError("overlay_config.defaults", "a string");
    return { enabled: boolean(obj, "enabled", "overlay_config"), defaults };
}
