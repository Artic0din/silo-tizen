import { decodeCatalogPage, decodeHomeSections } from "../contracts/v2/catalog.ts";
import {
    type CatalogFiltersRequest, type CatalogLettersRequest, type CatalogQueryRequest,
    decodeCatalogFilters, decodeCatalogLetters, decodeCatalogQueryPage,
    decodeCatalogSearchCapabilities, decodeLibraryCollections, decodeLibrarySection,
} from "../contracts/v2/discovery.ts";
import type { RequestSpec } from "./http.ts";

export interface CollectionPageRequest { readonly limit: number; readonly cursor?: string }
function bounded(value: number | undefined, min: number, max: number): void {
    if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) {
        throw new RangeError("Discovery request number outside contract bounds");
    }
}
function read<T>(path: string, decode: (value: unknown) => T): RequestSpec<T> {
    return { method: "GET", path, retry: "safe", decode };
}
function params(values: { readonly [key: string]: string | number | boolean | undefined }): string {
    const entries = Object.entries(values).filter(([, v]) => v !== undefined);
    return entries.length === 0 ? "" : "?" + entries.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(String(v))).join("&");
}

/** All operations are profile_scoped; callers send through session.call with profileScoped. */
export const discoveryOperations = {
    listLibrarySections: (libraryId: string) =>
        read(`/library/${encodeURIComponent(libraryId)}/sections?image_size=small`, decodeHomeSections),
    getLibrarySectionItems: (libraryId: string, sectionId: string) =>
        read(`/library/${encodeURIComponent(libraryId)}/sections/${encodeURIComponent(sectionId)}/items?image_size=small`, decodeLibrarySection),
    getLibraryCollections: (libraryId: string) =>
        read(`/library/${encodeURIComponent(libraryId)}/collections`, decodeLibraryCollections),
    getLibraryCollectionItems: (libraryId: string, collectionId: string, page: CollectionPageRequest) => {
        bounded(page.limit, 1, 200);
        return read(`/library/${encodeURIComponent(libraryId)}/collections/${encodeURIComponent(collectionId)}/items${params({ limit: page.limit, cursor: page.cursor })}`, decodeCatalogPage);
    },
    getCatalogFilters: (request: CatalogFiltersRequest) =>
        read("/catalog/filters" + params(request), decodeCatalogFilters),
    // natural_idempotent: NativeHttp's existing safe-read retry applies to these POSTs too.
    queryCatalogItems: (body: CatalogQueryRequest): RequestSpec<ReturnType<typeof decodeCatalogQueryPage>> => {
        bounded(body.limit, 1, 100);
        bounded(body.seek, 0, 10000000);
        return { method: "POST", path: "/catalog/query?image_size=small", retry: "safe", body: { ...body }, decode: decodeCatalogQueryPage };
    },
    queryCatalogLetters: (body: CatalogLettersRequest): RequestSpec<ReturnType<typeof decodeCatalogLetters>> => ({
        method: "POST", path: "/catalog/letters", retry: "safe", body: { ...body }, decode: decodeCatalogLetters,
    }),
    getCatalogSearchCapabilities: () => read("/catalog/search/capabilities", decodeCatalogSearchCapabilities),
};
