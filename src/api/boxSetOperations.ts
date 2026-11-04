// Movie box set reads. Profile-scoped; callers send them through session.call.
// Retry is the catalog read class: one transport retry after no answer or 502/503/504.
// searchCatalogBoxSets does not take artwork sizing. getCatalogBoxSet does (ArtworkQuery).

import type { CatalogBoxSet, CatalogBoxSetDetail } from "../contracts/v2/boxSets.ts";
import { decodeCatalogBoxSetDetail, decodeCatalogBoxSetList } from "../contracts/v2/boxSets.ts";
import type { RequestSpec } from "./http.ts";

/** Apple SearchViewModel.boxSetLimit. The server default is the same; the maximum is 20. */
export const BOX_SET_SEARCH_LIMIT = 5;

function bounded(value: number, min: number, max: number): void {
    if (!Number.isInteger(value) || value < min || value > max) throw new RangeError("Box set request number outside contract bounds");
}

export const boxSetOperations = {
    /** searchCatalogBoxSets: best match first, for All and Movies. */
    search: (query: string, limit: number): RequestSpec<CatalogBoxSet[]> => {
        const q = query.trim();
        if (q === "" || q.length > 200) throw new RangeError("Box set search text is outside the contract");
        bounded(limit, 1, 20);
        return { method: "GET", path: `/catalog/box-sets?q=${encodeURIComponent(q)}&limit=${limit}`, retry: "safe", decode: decodeCatalogBoxSetList };
    },
    /** getCatalogBoxSet: movies in `libraryId` the viewer can see, in release order. 404 when the set is unavailable. */
    get: (id: string, libraryId: string): RequestSpec<CatalogBoxSetDetail> => {
        if (id.trim() === "" || libraryId.trim() === "") throw new RangeError("Box set identity is outside the contract");
        return {
            method: "GET",
            path: `/catalog/box-sets/${encodeURIComponent(id)}?library_id=${encodeURIComponent(libraryId)}&image_size=medium`,
            retry: "safe",
            decode: decodeCatalogBoxSetDetail,
        };
    },
};
