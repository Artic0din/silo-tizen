import {
    type AudiobookGroupBy, decodeAudiobook, decodeAudiobookGroups, decodeProgressSync,
} from "../contracts/v2/audiobooks.ts";
import type { CatalogQueryRequest } from "../contracts/v2/discovery.ts";
import { discoveryOperations } from "./discoveryOperations.ts";
import type { RequestSpec } from "./http.ts";

export type AudiobookGroupSort = "name" | "count" | "duration";
/** Sort fields offered for an audiobook library (silo-apple CatalogSortKey.available). */
export type AudiobookSort = "title" | "author" | "narrator" | "series" | "added_at" | "runtime";

export interface AudiobookGroupsRequest {
    readonly libraryId: string;
    readonly groupBy: AudiobookGroupBy;
    readonly limit: number;
    readonly cursor?: string;
    readonly sort?: AudiobookGroupSort;
    /** Case-insensitive prefix on the group name. */
    readonly namePrefix?: string;
    /** The total is then an estimate. */
    readonly skipTotal?: boolean;
}

export interface AudiobookBooksRequest {
    readonly libraryId: string;
    readonly limit: number;
    readonly cursor?: string;
    readonly sort: AudiobookSort;
    readonly order: "asc" | "desc";
    /** Only the books of one author, narrator or series: a group's `name` is the filter value. */
    readonly group?: { readonly by: AudiobookGroupBy; readonly name: string };
    readonly namePrefix?: string;
}

export interface ProgressWrite {
    readonly mediaItemId: string;
    readonly positionSeconds: number;
    /** 0 when unknown. */
    readonly durationSeconds: number;
}

const GROUPS_MAX_LIMIT = 200;
const PROGRESS_MAX_ITEMS = 100;

function milliseconds(seconds: number, what: string): number {
    const ms = Math.round(seconds * 1000);
    if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(ms)) throw new RangeError(`${what} must be nonnegative finite seconds`);
    return ms;
}

/**
 * All operations are profile_scoped: send them through session.call with profileScoped.
 * An audiobook library is scoped by its library id, so book queries carry no `type`
 * (silo-apple CatalogSortKey.catalogTypeParam).
 */
export const audiobookOperations = {
    /** listAudiobookGroups: authors, narrators or series with aggregate counts and cover stacks. */
    listAudiobookGroups: (request: AudiobookGroupsRequest): RequestSpec<ReturnType<typeof decodeAudiobookGroups>> => {
        if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > GROUPS_MAX_LIMIT) throw new RangeError("Audiobook groups limit outside contract bounds");
        const params: [string, string][] = [["library_id", request.libraryId], ["group_by", request.groupBy], ["limit", String(request.limit)], ["image_size", "small"]];
        if (request.cursor !== undefined) params.push(["cursor", request.cursor]);
        if (request.sort !== undefined) params.push(["sort", request.sort]);
        if (request.namePrefix !== undefined) params.push(["q", request.namePrefix]);
        if (request.skipTotal !== undefined) params.push(["skip_total", String(request.skipTotal)]);
        const query = params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
        return { method: "GET", path: `/catalog/audiobook-groups?${query}`, retry: "safe", decode: decodeAudiobookGroups };
    },
    /** getCatalogItem for an audiobook: parts, chapters, the viewer's position and the audiobook extension. */
    getAudiobook: (contentId: string): RequestSpec<ReturnType<typeof decodeAudiobook>> => ({
        method: "GET", path: `/catalog/items/${encodeURIComponent(contentId)}?image_size=large`, retry: "safe", decode: decodeAudiobook,
    }),
    /** queryCatalogItems over an audiobook library; same page shape as every other catalog query. */
    queryAudiobooks: (request: AudiobookBooksRequest): ReturnType<typeof discoveryOperations.queryCatalogItems> => {
        const body: CatalogQueryRequest = {
            library_id: request.libraryId,
            match: "all",
            sort: request.sort,
            order: request.order,
            limit: request.limit,
            ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
            ...(request.namePrefix === undefined ? {} : { name_prefix: request.namePrefix }),
            ...(request.group === undefined ? {} : { groups: [{ match: "any", rules: [{ field: request.group.by, op: "is", value: request.group.name }] }] }),
        };
        return discoveryOperations.queryCatalogItems(body);
    },
    /**
     * syncProgress: non_retryable. The audiobook's whole-book position is written here and never resent;
     * a later sample carries a fresh value. Pass `replayAfterRefresh: false` to session.call.
     * Positions cross the wire as whole milliseconds and every write overwrites the stored position, as Apple's does.
     */
    syncProgress: (writes: readonly ProgressWrite[]): RequestSpec<ReturnType<typeof decodeProgressSync>> => {
        if (writes.length < 1 || writes.length > PROGRESS_MAX_ITEMS) throw new RangeError("Progress batch must hold 1 to 100 items");
        const ids = writes.map(write => write.mediaItemId);
        if (ids.some(id => id.trim() === "") || new Set(ids).size !== ids.length) throw new RangeError("Progress batch needs distinct, nonblank item ids");
        return {
            method: "POST", path: "/sync/progress", retry: "never",
            body: { items: writes.map(write => ({
                media_item_id: write.mediaItemId,
                position_ms: milliseconds(write.positionSeconds, "position"),
                duration_ms: Number.isFinite(write.durationSeconds) && write.durationSeconds >= 0 ? Math.round(write.durationSeconds * 1000) : 0,
                force_overwrite: true,
            })) },
            decode: value => decodeProgressSync(value, ids),
        };
    },
};
