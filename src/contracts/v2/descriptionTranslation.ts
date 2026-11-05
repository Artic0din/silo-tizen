// Description translation, separate from subtitle AI. Shapes follow
// getMetadataAICapability and translateCatalogItemDescription.

import { WireError, boolean, string } from "./wire.ts";

export type OnViewMode = "off" | "button" | "auto";

export interface MetadataAICapability {
    readonly enabled: boolean;
    readonly onView: OnViewMode;
}

/** Unknown `on_view` values are off. The feature is off unless the profile is allowed and the state is available. */
export function decodeMetadataAICapability(value: unknown): MetadataAICapability {
    const path = "metadata_ai";
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WireError(path, "an object");
    const row = value as { readonly [key: string]: unknown };
    if (string(row, "revision", path) === "") throw new WireError(`${path}.revision`, "a non-empty string");
    const allowed = boolean(row, "allowed", path);
    const available = string(row, "state", path) === "available";
    const raw = string(row, "on_view", path);
    const onView: OnViewMode = raw === "auto" || raw === "button" || raw === "off" ? raw : "off";
    const enabled = allowed && available;
    return { enabled, onView: enabled ? onView : "off" };
}

export interface DescriptionJob {
    readonly id: string;
    readonly targetKind: string;
    readonly contentId: string;
    readonly targetLanguage: string;
    readonly status: string;
    readonly failed: boolean;
}

const TARGET_KINDS = ["item", "season", "episode"];

/** A recently failed job may come back without new work. `canceled` and `cancelled` are both terminal. */
export function decodeDescriptionTranslationJob(value: unknown, contentId: string): DescriptionJob {
    const path = "metadata_translation_job";
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WireError(path, "an object");
    const row = value as { readonly [key: string]: unknown };
    const id = string(row, "id", path);
    const targetKind = string(row, "target_kind", path);
    const reported = string(row, "content_id", path);
    if (id === "" || reported !== contentId || !TARGET_KINDS.includes(targetKind)) throw new WireError(path, "the requested item, season or episode job");
    const status = string(row, "status", path);
    return { id, targetKind, contentId: reported, targetLanguage: string(row, "target_language", path), status, failed: status === "failed" || status === "canceled" || status === "cancelled" };
}

/** Pending language and machine-translated fields carried on a card, detail, season or episode. Empty and null pending languages are absent. */
export function translationMembers(obj: { readonly [key: string]: unknown }, path: string): { readonly pendingTranslationLanguage?: string; readonly machineTranslatedFields?: readonly string[] } {
    const rawPending = obj.pending_translation_language;
    let pending: string | undefined;
    if (rawPending !== undefined && rawPending !== null && rawPending !== "") {
        if (typeof rawPending !== "string") throw new WireError(`${path}.pending_translation_language`, "a string");
        pending = rawPending;
    }
    const rawFields = obj.machine_translated_fields;
    let fields: readonly string[] | undefined;
    if (rawFields !== undefined && rawFields !== null) {
        if (!Array.isArray(rawFields)) throw new WireError(`${path}.machine_translated_fields`, "an array of strings");
        fields = rawFields.map((entry, index) => {
            if (typeof entry !== "string") throw new WireError(`${path}.machine_translated_fields[${index}]`, "a string");
            return entry;
        });
    }
    return { ...(pending === undefined ? {} : { pendingTranslationLanguage: pending }), ...(fields === undefined ? {} : { machineTranslatedFields: fields }) };
}
