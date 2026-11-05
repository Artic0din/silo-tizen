import type { RequestSpec } from "./http.ts";
import { decodeAudiobook, decodeAudioPage, decodeGroups } from "../contracts/v2/audiobooks.ts";
import { object, string, WireError } from "../contracts/v2/wire.ts";
import { decodeCatalogLetters } from "../contracts/v2/discovery.ts";

export type AudioGroup = "author" | "narrator" | "series";
export const audiobookOperations = {
    detail: (id: string): RequestSpec<ReturnType<typeof decodeAudiobook>> => ({ method: "GET", path: `/catalog/items/${encodeURIComponent(id)}`, retry: "safe", decode: decodeAudiobook }),
    groups: (library: string, group: AudioGroup, cursor?: string): RequestSpec<ReturnType<typeof decodeGroups>> => ({
        method: "GET", path: `/catalog/audiobook-groups?library_id=${encodeURIComponent(library)}&group_by=${group}&limit=24${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`, retry: "safe", decode: decodeGroups,
    }),
    letters: (library: string): RequestSpec<ReturnType<typeof decodeCatalogLetters>> => ({ method: "POST", path: "/catalog/letters", retry: "safe", body: { library_id: library, type: "audiobook", order: "asc" }, decode: decodeCatalogLetters }),
    books: (library: string, group?: AudioGroup, name?: string, cursor?: string, options?: { collection?: string | undefined; prefix?: string | undefined; source?: "library_collection" | "user_collection" | undefined }): RequestSpec<ReturnType<typeof decodeAudioPage>> => ({
        method: "POST", path: "/catalog/query", retry: "safe", decode: decodeAudioPage,
        body: { ...(options?.collection === undefined ? { type: "audiobook", sort: "title", order: "asc", groups: group === undefined ? [] : [{ match: "all", rules: [{ field: group, op: "is", value: name }] }] } : { source: options.source ?? "library_collection", collection_id: options.collection }), library_id: library, match: "all", limit: options?.collection === undefined ? 100 : 60, ...(options?.prefix === undefined ? {} : { name_prefix: options.prefix }), ...(cursor === undefined ? {} : { cursor }) },
    }),
    progress: (id: string, position: number, duration: number): RequestSpec<undefined> => ({
        method: "POST", path: "/sync/progress", retry: "never", body: { items: [{ media_item_id: id, position_ms: Math.round(position * 1000), duration_ms: Math.round(duration * 1000), force_overwrite: true }] },
        decode: value => {
            const raw = object(value, "sync");
            if (!Array.isArray(raw.items) || raw.items.length !== 1) throw new WireError("sync.items", "one result");
            const result = object(raw.items[0], "sync.result");
            if (string(result, "media_item_id", "sync.result") !== id || result.status !== "success") throw new WireError("sync.result", "a successful matching progress write");
            return undefined;
        },
    }),
};
