import { object, WireError } from "./wire.ts";

export const PRIMARY_MENU_KEY = "nav.primary_menu";
export const MENU_BUILTINS = ["home", "movies", "series", "music", "audiobooks", "for_you", "calendar"] as const;
export type MenuBuiltin = typeof MENU_BUILTINS[number];
export type MenuItem =
    | { readonly type: "builtin"; readonly destination: MenuBuiltin }
    | { readonly type: "library"; readonly library_id: number; readonly label: string }
    | { readonly type: "section"; readonly library_id: number; readonly section_id: string; readonly label: string }
    | { readonly type: "collection"; readonly library_id?: number; readonly collection_id: string; readonly label: string };
export type PrimaryMenu = { readonly items: readonly MenuItem[] };

function reject(): never { throw new WireError("primary_menu", "a primary-menu.json document with unique destinations and Home"); }
function text(value: unknown, limit: number): value is string {
    return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= limit;
}
function libraryId(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Server cc851494, primary-menu.json. Unsupported TV destinations are validated before projection. */
export function decodePrimaryMenu(value: unknown): PrimaryMenu | null {
    if (value === null) return null;
    const document = object(value, "primary_menu");
    if (Object.keys(document).some(key => key !== "items") || !Array.isArray(document.items) || document.items.length < 1 || document.items.length > 64) reject();
    const seen = new Set<string>();
    let home = false;
    for (const raw of document.items) {
        const item = object(raw, "primary_menu.items");
        let allowed: readonly string[];
        let identity: readonly unknown[];
        switch (item.type) {
            case "builtin":
                if (typeof item.destination !== "string" || !MENU_BUILTINS.some(destination => destination === item.destination)) reject();
                allowed = ["type", "destination"];
                identity = [item.type, item.destination];
                home ||= item.destination === "home";
                break;
            case "library":
                if (!libraryId(item.library_id) || !text(item.label, 256)) reject();
                allowed = ["type", "library_id", "label"];
                identity = [item.type, item.library_id];
                break;
            case "section":
                if (!libraryId(item.library_id) || !text(item.section_id, 128) || !text(item.label, 256)) reject();
                allowed = ["type", "library_id", "section_id", "label"];
                identity = [item.type, item.library_id, item.section_id];
                break;
            case "collection":
                if ((item.library_id !== undefined && !libraryId(item.library_id)) || !text(item.collection_id, 128) || !text(item.label, 256)) reject();
                allowed = ["type", "library_id", "collection_id", "label"];
                identity = [item.type, item.library_id ?? null, item.collection_id];
                break;
            default: reject();
        }
        const key = JSON.stringify(identity);
        if (seen.has(key) || Object.keys(item).some(member => !allowed.includes(member))) reject();
        seen.add(key);
    }
    if (!home) reject();
    return document as PrimaryMenu;
}
