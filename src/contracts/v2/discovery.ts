// Consumed discovery members from openapi.json at the commit in SOURCE.
import { decodeCatalogPage, decodeHomeSections, type CatalogPage, type HomeSection } from "./catalog.ts";
import { boolean, integer, object, optionalString, string, WireError } from "./wire.ts";

export type MediaScope = "movie" | "series" | "video";
export type Match = "all" | "any";
export type Order = "asc" | "desc";
export type FilterRule = {
    readonly field: string;
    readonly op: string;
    readonly value: string | number | boolean | readonly (string | number | boolean)[];
};
export type FilterGroup = { readonly match: Match; readonly rules: readonly FilterRule[] };
export type CatalogLettersRequest = {
    readonly library_id?: string;
    readonly type: MediaScope;
    readonly match?: Match;
    readonly groups?: readonly FilterGroup[];
    readonly order?: Order;
};
export type CatalogQueryRequest = Omit<CatalogLettersRequest, "type"> & {
    readonly type?: MediaScope | "episode";
    readonly source?: "query" | "section" | "library_collection" | "user_collection" | "watchlist" | "favorites" | "history";
    readonly scope?: "home" | "library";
    readonly section_id?: string;
    readonly collection_id?: string;
    readonly q?: string;
    readonly limit?: number;
    readonly cursor?: string;
    readonly seek?: number;
    readonly name_prefix?: string;
    readonly sort?: string;
    readonly skip_total?: boolean;
};
export type CatalogFiltersRequest = {
    readonly source?: "query" | "section" | "library_collection";
    readonly scope?: "home" | "library";
    readonly section_id?: string;
    readonly library_id?: string;
    readonly collection_id?: string;
    readonly type: MediaScope;
    readonly skip_technical?: boolean;
};
type Obj = ReturnType<typeof object>;
function array(obj: Obj, key: string, path: string): unknown[] {
    const value = obj[key];
    if (!Array.isArray(value)) throw new WireError(`${path}.${key}`, "an array");
    return value;
}
function strings(obj: Obj, key: string, path: string): string[] {
    return array(obj, key, path).map((v, i) => {
        if (typeof v !== "string") throw new WireError(`${path}.${key}[${i}]`, "a string");
        return v;
    });
}
function count(obj: Obj, key: string, path: string): number {
    const value = integer(obj, key, path);
    if (value < 0) throw new WireError(`${path}.${key}`, "a nonnegative integer");
    return value;
}
function optionalBoolean(obj: Obj, key: string, path: string): boolean | undefined {
    return obj[key] === undefined ? undefined : boolean(obj, key, path);
}
function enumValue<T extends string>(value: string, known: readonly T[]): T | "unknown" {
    return known.find(k => k === value) ?? "unknown";
}

export function decodeLibrarySection(value: unknown): HomeSection {
    const section = decodeHomeSections({ sections: [value] })[0];
    if (section === undefined) throw new WireError("library_section", "a section");
    return section;
}
export interface CatalogQueryPage extends CatalogPage {
    readonly windowCursor: string;
    readonly effectiveSort: { readonly field: string; readonly order: Order | "unknown" } | undefined;
}
export function decodeCatalogQueryPage(value: unknown): CatalogQueryPage {
    const path = "catalog_query";
    const obj = object(value, path);
    const sort = obj.effective_sort === undefined ? undefined : object(obj.effective_sort, path + ".effective_sort");
    return {
        ...decodeCatalogPage(value),
        windowCursor: string(obj, "window_cursor", path),
        effectiveSort: sort === undefined ? undefined : {
            field: string(sort, "field", path + ".effective_sort"),
            order: enumValue(string(sort, "order", path + ".effective_sort"), ["asc", "desc"]),
        },
    };
}

export interface CatalogFilters {
    readonly genres: readonly string[];
    readonly studios: readonly string[];
    readonly networks: readonly string[];
    readonly countries: readonly string[];
    readonly originalLanguages: readonly string[];
    readonly contentRatings: readonly string[];
    readonly technical: {
        readonly resolutions: readonly string[];
        readonly audioLanguages: readonly string[];
        readonly subtitleLanguages: readonly string[];
    } | undefined;
}
export function decodeCatalogFilters(value: unknown): CatalogFilters {
    const path = "catalog_filters";
    const obj = object(value, path);
    const tech = obj.technical === undefined ? undefined : object(obj.technical, path + ".technical");
    return {
        genres: strings(obj, "genres", path), studios: strings(obj, "studios", path),
        networks: strings(obj, "networks", path), countries: strings(obj, "countries", path),
        originalLanguages: strings(obj, "original_languages", path), contentRatings: strings(obj, "content_ratings", path),
        technical: tech === undefined ? undefined : {
            resolutions: strings(tech, "resolutions", path + ".technical"),
            audioLanguages: strings(tech, "audio_languages", path + ".technical"),
            subtitleLanguages: strings(tech, "subtitle_languages", path + ".technical"),
        },
    };
}

export interface CatalogLetterRun { readonly letter: string; readonly position: number }
export interface CatalogLetter extends CatalogLetterRun { readonly count: number }
export interface CatalogLetters {
    readonly total: number;
    readonly letters: readonly CatalogLetter[];
    readonly runs: readonly CatalogLetterRun[];
}
export function decodeCatalogLetters(value: unknown): CatalogLetters {
    const path = "catalog_letters";
    const obj = object(value, path);
    const run = (value: unknown, path: string): CatalogLetterRun => {
        const entry = object(value, path);
        return { letter: string(entry, "letter", path), position: count(entry, "position", path) };
    };
    return {
        total: count(obj, "total", path),
        letters: array(obj, "letters", path).map((v, i) => {
            const p = `${path}.letters[${i}]`;
            return { ...run(v, p), count: count(object(v, p), "count", p) };
        }),
        runs: array(obj, "runs", path).map((v, i) => run(v, `${path}.runs[${i}]`)),
    };
}

export interface CollectionSummary {
    readonly id: string;
    readonly title: string;
    readonly posterUrl: string;
    readonly itemCount: number;
    readonly posterIsCollage: boolean;
}
export interface LibraryCollection extends CollectionSummary {
    readonly libraryId: string;
    readonly libraryIds: readonly string[];
    readonly groupId: string | null;
}
export interface CollectionGroup {
    readonly id: string;
    readonly name: string;
    readonly kind: "admin" | "user_collections" | "unknown";
    readonly sortMode: string;
    readonly sortOrder: number;
    readonly collections: readonly CollectionSummary[];
}
export interface LibraryCollections {
    readonly libraryId: string;
    readonly collections: readonly LibraryCollection[];
    readonly groups: readonly CollectionGroup[];
    readonly ungrouped: { readonly sortOrder: number; readonly collections: readonly CollectionSummary[] } | undefined;
}
function collection(value: unknown, path: string): CollectionSummary {
    const obj = object(value, path);
    return {
        id: string(obj, "id", path), title: string(obj, "title", path),
        posterUrl: string(obj, "poster_url", path), itemCount: count(obj, "item_count", path),
        posterIsCollage: boolean(obj, "poster_is_collage", path),
    };
}
function collectionList(obj: Obj, path: string): CollectionSummary[] {
    return array(obj, "collections", path).map((v, i) => collection(v, `${path}.collections[${i}]`));
}
export function decodeLibraryCollections(value: unknown): LibraryCollections {
    const path = "library_collections";
    const obj = object(value, path);
    const ungrouped = obj.ungrouped === undefined ? undefined : object(obj.ungrouped, path + ".ungrouped");
    return {
        libraryId: string(obj, "library_id", path),
        collections: array(obj, "collections", path).map((v, i) => {
            const p = `${path}.collections[${i}]`;
            const entry = object(v, p);
            return {
                ...collection(v, p), libraryId: string(entry, "library_id", p),
                libraryIds: strings(entry, "library_ids", p),
                groupId: entry.group_id === null ? null : string(entry, "group_id", p),
            };
        }),
        groups: array(obj, "groups", path).map((v, i) => {
            const p = `${path}.groups[${i}]`;
            const entry = object(v, p);
            return {
                id: string(entry, "id", p), name: string(entry, "name", p),
                kind: enumValue(string(entry, "kind", p), ["admin", "user_collections"]),
                sortMode: string(entry, "sort_mode", p), sortOrder: integer(entry, "sort_order", p),
                collections: collectionList(entry, p),
            };
        }),
        ungrouped: ungrouped === undefined ? undefined : {
            sortOrder: integer(ungrouped, "sort_order", path + ".ungrouped"),
            collections: collectionList(ungrouped, path + ".ungrouped"),
        },
    };
}

export interface CatalogSearchCapabilities {
    readonly revision: string;
    readonly state: "available" | "disabled" | "not_configured" | "unsupported" | "unknown";
    readonly allowed: boolean;
    readonly letterIndex: boolean | undefined;
    readonly extendedQueryRules: boolean | undefined;
    readonly provider: "postgres" | "meilisearch" | "unknown" | undefined;
}
export function decodeCatalogSearchCapabilities(value: unknown): CatalogSearchCapabilities {
    const path = "catalog_search_capabilities";
    const obj = object(value, path);
    const provider = optionalString(obj, "provider", path);
    return {
        revision: string(obj, "revision", path),
        state: enumValue(string(obj, "state", path), ["available", "disabled", "not_configured", "unsupported"]),
        allowed: boolean(obj, "allowed", path), letterIndex: optionalBoolean(obj, "letter_index", path),
        extendedQueryRules: optionalBoolean(obj, "extended_query_rules", path),
        provider: provider === undefined ? undefined : enumValue<"postgres" | "meilisearch">(provider, ["postgres", "meilisearch"]),
    };
}
