import { operations } from "../api/operations.ts";
import type { RequestSpec } from "../api/http.ts";
import { ApiError } from "../api/errors.ts";
import type { Card, HomeSection, UserLibrary } from "../contracts/v2/catalog.ts";
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
    /** A narrowed shelf could not be fully refilled (TVLibraryBrowseView.scopeIncomplete). */
    readonly incomplete?: boolean;
    /** Rows were narrowed to the tab's type (TVLibraryBrowseView.mediaScope). */
    readonly scoped?: boolean;
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
/** Apple BrowseMediaType.catalogTypeParam: an audiobook library is scoped by its id alone. */
export function libraryScope(library: UserLibrary): { library_id: string; type?: MediaScope } {
    return library.type === "audiobooks" ? { library_id: library.id } : { library_id: library.id, type: scopeOf(library) };
}
/** A library section owns its filters. `type`, `sort`, `order` and `match` are overlay params and the server rejects them. */
export function librarySectionQuery(libraryId: string, sectionId: string): CatalogQueryRequest {
    return { source: "section", scope: "library", section_id: sectionId, library_id: libraryId };
}
export function genreGroups(name: string): readonly FilterGroup[] {
    return [{ match: "all", rules: [{ field: "genre", op: "is", value: name }] }];
}
export async function readDiscovery(library: UserLibrary, mode: LibraryMode, read: <T>(spec: RequestSpec<T>) => Promise<T>, artwork: Readonly<Record<string, string>> = {}, scope?: VideoScope): Promise<DiscoveryData> {
    const capabilities = await read(operations.getCatalogSearchCapabilities());
    const available = capabilities?.allowed === true && capabilities.state === "available";
    let sections = mode === "Recommended" ? await read(operations.listLibrarySections(library.id, artwork)) : [];
    let incomplete = false;
    if (scope !== undefined && sections.length > 0) {
        // TVLibraryBrowseView.loadContent (TVLibraryBrowseView.swift:144-167): a mixed library on a video tab shows only that tab's type.
        const scoped = await refillSections(sections.filter(section => section.featured !== true), scope, (section, cursor) => sectionPage(library.id, section.id, cursor, read, artwork));
        sections = scoped.map(entry => entry.section);
        incomplete = scoped.some(entry => entry.incomplete);
    }
    // TVLibraryCollectionsView.loadCollections (:183-191): a failed read is shown as no collections.
    const collections = mode === "Collections" ? await read(operations.getLibraryCollections(library.id)).catch((error: unknown) => {
        if (error instanceof ApiError && error.aborted) throw error;
        return undefined;
    }) : undefined;
    const filters = mode === "Genres" && available && capabilities.extendedQueryRules === true ? await read(operations.getCatalogFilters(libraryScope(library))) : undefined;
    const letters = mode === "A–Z" && available && capabilities.letterIndex === true ? await read(operations.queryCatalogLetters({ ...libraryScope(library), order: "asc" })) : undefined;
    return { capabilities, sections, incomplete, scoped: scope !== undefined, collections, filters, letters };
}

/** LibraryVideoScope: the media type a mixed library is narrowed to by the Movies or Series tab it was opened from. */
export type VideoScope = "movie" | "series";
export interface ScopedPage { readonly items: readonly Card[]; readonly next: string | undefined; readonly startsOver?: boolean }
export interface ScopedSection { readonly section: HomeSection; readonly incomplete: boolean }
const REFILL_PAGES = 8;
const REFILL_CONCURRENCY = 3;

/** LibraryVideoScope.contains (LibraryVideoScope.swift:9-17): seasons are neither. */
export function inVideoScope(scope: VideoScope, card: Card): boolean {
    return scope === "movie" ? card.type === "movie" : card.type === "series" || card.type === "episode";
}

/**
 * LibraryVideoScope.refill (LibraryVideoScope.swift:57-117). Section reads reject a type overlay, so a typed shelf
 * pages its section source and keeps the server's order. Only a missing continuation proves the shelf ran out.
 */
export async function refillSection(original: HomeSection, scope: VideoScope, loadPage: (cursor: string | undefined) => Promise<ScopedPage>): Promise<ScopedSection> {
    const initial = original.items.filter(card => inVideoScope(scope, card));
    const target = Math.min(100, original.itemLimit !== undefined && original.itemLimit > 0 ? original.itemLimit : Math.max(20, original.items.length));
    const result = (items: readonly Card[], incomplete = false): ScopedSection => ({ section: { ...original, totalCount: undefined, items: items.slice(0, target) }, incomplete });
    if (initial.length >= target) return result(initial);
    // The section source pages the admin definition, not a profile's override, so a customized row keeps its own items.
    if (original.customized === true || original.isCustom === true) {
        return result(initial, !(original.items.length < target && (original.totalCount ?? 0) <= original.items.length));
    }
    const inline = new Map(original.items.map(card => [card.id, card]));
    let visible: Card[] = [];
    let seen = new Set<string>();
    let originalWindow = true;
    let cursor: string | undefined;
    for (let read = 0; read < REFILL_PAGES; read++) {
        let page: ScopedPage;
        try {
            page = await loadPage(cursor);
        } catch (error) {
            if (error instanceof ApiError && error.aborted) throw error;
            if (originalWindow) for (const card of initial) if (!seen.has(card.id)) { seen.add(card.id); visible.push(card); }
            return result(visible, true);
        }
        // A restarted cursor is a new ordering; its cards never join the old window.
        if (page.startsOver === true) { visible = []; seen = new Set(); originalWindow = false; }
        for (const card of page.items) {
            if (!inVideoScope(scope, card) || seen.has(card.id)) continue;
            seen.add(card.id);
            visible.push(originalWindow ? inline.get(card.id) ?? card : card);
        }
        if (visible.length >= target || page.next === undefined) return result(visible);
        cursor = page.next;
    }
    return result(visible, true);
}

/** LibraryVideoScope.refillSections: at most three shelves at a time, in layout order. */
export async function refillSections(originals: readonly HomeSection[], scope: VideoScope, loadPage: (section: HomeSection, cursor: string | undefined) => Promise<ScopedPage>): Promise<ScopedSection[]> {
    const results: ScopedSection[] = originals.map(section => ({ section, incomplete: false }));
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < originals.length) {
            const index = next++;
            const original = originals[index];
            if (original !== undefined) results[index] = await refillSection(original, scope, cursor => loadPage(original, cursor));
        }
    };
    await Promise.all(Array.from({ length: Math.min(REFILL_CONCURRENCY, originals.length) }, worker));
    return results;
}

/** A shelf's section source, 100 at a time (TVLibraryBrowseView.swift:152-155); a rejected cursor reads page one again, marked as a restart. */
async function sectionPage(libraryId: string, sectionId: string, cursor: string | undefined, read: <T>(spec: RequestSpec<T>) => Promise<T>, artwork: Readonly<Record<string, string>>): Promise<ScopedPage> {
    const query = { ...librarySectionQuery(libraryId, sectionId), limit: 100 };
    try {
        // The refilled cards share the row's artwork sizes, which upgradeLibraryArtwork cannot repair for titles the inline row lacked.
        const page = await read(operations.queryCatalogItems(cursor === undefined ? query : { ...query, cursor }, artwork));
        return { items: page.items, next: page.nextCursor };
    } catch (error) {
        if (cursor === undefined || !(error instanceof ApiError) || error.problemId !== "invalid_cursor") throw error;
        const page = await read(operations.queryCatalogItems(query, artwork));
        return { items: page.items, next: page.nextCursor, startsOver: true };
    }
}
