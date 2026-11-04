import { operations } from "../api/operations.ts";
import type { RequestSpec } from "../api/http.ts";
import type { HomeSection, UserLibrary } from "../contracts/v2/catalog.ts";
import type { CatalogFilters, CatalogLetters, CatalogQueryRequest, CatalogSearchCapabilities, FilterGroup, LibraryCollections, MediaScope } from "../contracts/v2/discovery.ts";
import { scopeOf } from "./browseModel.ts";
import { DEFAULT_FILTER, type BrowseFilter, type Facet } from "./libraryBrowse.ts";
import type { SectionSnapshot } from "./sectionCatalogState.ts";

export type LibraryMode = "Recommended" | "Browse" | "Collections" | "Genres" | "A–Z" | "Recently Added";
export const LIBRARY_MODES: readonly LibraryMode[] = ["Recommended", "Collections", "Browse", "Genres", "A–Z", "Recently Added"];
export type BrowsePanel = { readonly kind: "sort" } | { readonly kind: "filter"; draft: BrowseFilter; facet: Facet | undefined; lastFacet: Facet | undefined };
export interface BrowseChange { readonly filter?: BrowseFilter; readonly panel?: BrowsePanel | undefined; readonly preserve?: boolean; readonly focus?: import("./browseFocus.ts").FocusTarget }
export interface DiscoveryData {
    readonly capabilities: CatalogSearchCapabilities | undefined;
    readonly sections: readonly HomeSection[];
    readonly collections: LibraryCollections | undefined;
    readonly filters: CatalogFilters | undefined;
    readonly letters: CatalogLetters | undefined;
}
export interface DiscoveryState {
    capabilities: CatalogSearchCapabilities | undefined;
    mode: LibraryMode;
    data: DiscoveryData | undefined;
    windowCursor: string | undefined;
    seek: number | undefined;
    letter: string | undefined;
    genre: string | undefined;
    descending: boolean;
    filter: BrowseFilter;
    panel: BrowsePanel | undefined;
    snapshot: SectionSnapshot | undefined;
    emptyReason: "libraryEmpty" | "noFilterMatches";
    facets: CatalogFilters | undefined;
    facetsRequested: boolean;
}
export type LibrarySource = { readonly kind: "collection"; readonly id: string; readonly groupKind: "admin" | "user_collections" } | { readonly kind: "section"; readonly id: string } | { readonly kind: "genre"; readonly name: string };
export function discoveryState(): DiscoveryState {
    return { capabilities: undefined, mode: "Recommended", data: undefined, windowCursor: undefined, seek: undefined, letter: undefined, genre: undefined, descending: false, filter: DEFAULT_FILTER, panel: undefined, snapshot: undefined, emptyReason: "libraryEmpty", facets: undefined, facetsRequested: false };
}
export function libraryScope(library: UserLibrary): { library_id: string; type: MediaScope } {
    return { library_id: library.id, type: scopeOf(library) };
}
/** A library section owns its filters. `type`, `sort`, `order` and `match` are overlay params and the server rejects them. */
export function librarySectionQuery(libraryId: string, sectionId: string): CatalogQueryRequest {
    return { source: "section", scope: "library", section_id: sectionId, library_id: libraryId };
}
export function genreGroups(name: string): readonly FilterGroup[] {
    return [{ match: "all", rules: [{ field: "genre", op: "is", value: name }] }];
}
export async function readDiscovery(library: UserLibrary, mode: LibraryMode, read: <T>(spec: RequestSpec<T>) => Promise<T>, artwork: Readonly<Record<string, string>> = {}): Promise<DiscoveryData> {
    const capabilities = await read(operations.getCatalogSearchCapabilities());
    const available = capabilities?.allowed === true && capabilities.state === "available";
    const sections = mode === "Recommended" ? await read(operations.listLibrarySections(library.id, artwork)) : [];
    const collections = mode === "Collections" ? await read(operations.getLibraryCollections(library.id)) : undefined;
    const filters = mode === "Genres" && available && capabilities.extendedQueryRules === true ? await read(operations.getCatalogFilters(libraryScope(library))) : undefined;
    const letters = mode === "A–Z" && available && capabilities.letterIndex === true ? await read(operations.queryCatalogLetters({ ...libraryScope(library), order: "asc" })) : undefined;
    return { capabilities, sections, collections, filters, letters };
}
