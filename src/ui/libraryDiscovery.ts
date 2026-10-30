import { operations } from "../api/operations.ts";
import type { RequestSpec } from "../api/http.ts";
import type { HomeSection, UserLibrary } from "../contracts/v2/catalog.ts";
import type { CatalogFilters, CatalogLetters, CatalogSearchCapabilities, FilterGroup, LibraryCollections, MediaScope } from "../contracts/v2/discovery.ts";
import { scopeOf } from "./browseModel.ts";

export type LibraryMode = "Browse" | "Collections" | "Genres" | "A–Z" | "Recently Added";
export const LIBRARY_MODES: readonly LibraryMode[] = ["Browse", "Collections", "Genres", "A–Z", "Recently Added"];
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
}
export type LibrarySource = { readonly kind: "collection"; readonly id: string; readonly groupKind: "admin" | "user_collections" } | { readonly kind: "section"; readonly id: string } | { readonly kind: "genre"; readonly name: string };
export function discoveryState(): DiscoveryState {
    return { capabilities: undefined, mode: "Browse", data: undefined, windowCursor: undefined, seek: undefined, letter: undefined, genre: undefined, descending: false };
}
export function libraryScope(library: UserLibrary): { library_id: string; type: MediaScope } {
    return { library_id: library.id, type: scopeOf(library) };
}
export function genreGroups(name: string): readonly FilterGroup[] {
    return [{ match: "all", rules: [{ field: "genre", op: "is", value: name }] }];
}
export async function readDiscovery(library: UserLibrary, mode: LibraryMode, read: <T>(spec: RequestSpec<T>) => Promise<T>): Promise<DiscoveryData> {
    const capabilities = await read(operations.getCatalogSearchCapabilities());
    const available = capabilities?.allowed === true && capabilities.state === "available";
    const sections = mode === "Browse" ? await read(operations.listLibrarySections(library.id)) : [];
    const collections = mode === "Collections" || mode === "Browse" ? await read(operations.getLibraryCollections(library.id)) : undefined;
    const filters = mode === "Genres" && available && capabilities.extendedQueryRules === true ? await read(operations.getCatalogFilters(libraryScope(library))) : undefined;
    const letters = mode === "A–Z" && available && capabilities.letterIndex === true ? await read(operations.queryCatalogLetters({ ...libraryScope(library), order: "asc" })) : undefined;
    return { capabilities, sections, collections, filters, letters };
}
