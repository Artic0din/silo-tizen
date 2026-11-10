// Apple TV's library Browse grid state for video libraries: sort, filter facets and the A–Z name
// prefix, and the catalog query they lower to (CatalogSortKey, CatalogFilterState,
// CatalogFacets and CatalogQueryBuilder at the pinned silo-apple source).

import type { UserLibrary } from "../contracts/v2/catalog.ts";
import type { CatalogFilters, CatalogQueryRequest, FilterGroup, FilterRule, Order } from "../contracts/v2/discovery.ts";
import { scopeOf } from "./browseModel.ts";

export type SortKey = "title" | "added_at" | "release_date" | "year" | "rating_imdb" | "runtime" | "resolution" | "author" | "narrator" | "series";
/** CatalogSortKey.available(for: .movie / .series), in display order, with labels and natural order. */
export const SORT_KEYS: readonly { readonly key: SortKey; readonly label: string; readonly order: Order }[] = [
    { key: "title", label: "Title", order: "asc" },
    { key: "added_at", label: "Date Added", order: "desc" },
    { key: "release_date", label: "Release Date", order: "desc" },
    { key: "year", label: "Year", order: "desc" },
    { key: "rating_imdb", label: "Rating", order: "desc" },
    { key: "runtime", label: "Runtime", order: "desc" },
    { key: "resolution", label: "Resolution", order: "desc" },
];

/** CatalogSortKey.available(for: .audiobook), in display order. */
const AUDIOBOOK_SORT_KEYS: typeof SORT_KEYS = [
    { key: "title", label: "Title", order: "asc" },
    { key: "author", label: "Author", order: "asc" },
    { key: "narrator", label: "Narrator", order: "asc" },
    { key: "series", label: "Series", order: "asc" },
    { key: "added_at", label: "Date Added", order: "desc" },
    { key: "runtime", label: "Runtime", order: "desc" },
];

/** The sort keys a library of this type offers. */
export function sortKeysFor(libraryType: string): typeof SORT_KEYS {
    return libraryType === "audiobooks" ? AUDIOBOOK_SORT_KEYS : SORT_KEYS;
}

export type Facet = "genre" | "decade" | "watchStatus" | "contentRating" | "resolution" | "dynamicRange" | "studio" | "network" | "country" | "audioLanguage" | "subtitleLanguage" | "originalLanguage";
/** CatalogFacet.available(for: .movie / .series), in display order. */
export const FACETS: readonly { readonly facet: Facet; readonly title: string }[] = [
    { facet: "genre", title: "Genre" }, { facet: "decade", title: "Decade" }, { facet: "watchStatus", title: "Watch Status" },
    { facet: "contentRating", title: "Content Rating" }, { facet: "resolution", title: "Resolution" }, { facet: "dynamicRange", title: "Dynamic Range" },
    { facet: "studio", title: "Studio" }, { facet: "network", title: "Network" }, { facet: "country", title: "Country" },
    { facet: "audioLanguage", title: "Audio Language" }, { facet: "subtitleLanguage", title: "Subtitle Language" }, { facet: "originalLanguage", title: "Original Language" },
];

const DECADES = [2020, 2010, 2000, 1990, 1980, 1970, 1960];
const WATCH_STATUS: readonly (readonly [string, string, string])[] = [
    ["unwatched", "Unwatched", "watched"], ["inProgress", "In Progress", "in_progress"], ["watched", "Watched", "watched"],
    ["favorited", "Favorited", "favorited"], ["watchlist", "Watchlist", "in_watchlist"],
];

export interface BrowseFilter {
    readonly sort: SortKey;
    /** Undefined: the key's natural order. */
    readonly order: Order | undefined;
    readonly matchAll: boolean;
    readonly values: Readonly<Partial<Record<Facet, readonly string[]>>>;
    /** The A–Z rail's prefix ("#" for non-letters); a jump, not a facet. */
    readonly prefix: string | undefined;
}

export const DEFAULT_FILTER: BrowseFilter = { sort: "title", order: undefined, matchAll: true, values: {}, prefix: undefined };

export function sortKey(key: SortKey): (typeof SORT_KEYS)[number] {
    return SORT_KEYS.find(entry => entry.key === key) ?? AUDIOBOOK_SORT_KEYS.find(entry => entry.key === key) ?? SORT_KEYS[0] as (typeof SORT_KEYS)[number];
}

export function effectiveOrder(filter: BrowseFilter): Order {
    return filter.order ?? sortKey(filter.sort).order;
}

/** CatalogSortKey.directionLabel. */
export function directionLabel(key: SortKey, order: Order): string {
    if (key === "title") return order === "asc" ? "A–Z" : "Z–A";
    if (key === "release_date" || key === "year" || key === "added_at") return order === "asc" ? "Oldest" : "Newest";
    if (key === "runtime") return order === "asc" ? "Shortest" : "Longest";
    return order === "asc" ? "Lowest" : "Highest";
}

/** Picking the active key flips its order; another key starts at its natural order. */
export function withSort(filter: BrowseFilter, key: SortKey): BrowseFilter {
    if (filter.sort === key) return { ...filter, order: effectiveOrder(filter) === "asc" ? "desc" : "asc" };
    return { ...filter, sort: key, order: undefined };
}

export function selected(filter: BrowseFilter, facet: Facet): readonly string[] {
    return filter.values[facet] ?? [];
}

/** Watch status is single-select; every other facet is multi-select. */
export function toggled(filter: BrowseFilter, facet: Facet, value: string): BrowseFilter {
    const current = selected(filter, facet);
    const next = current.includes(value) ? current.filter(item => item !== value) : facet === "watchStatus" ? [value] : [...current, value];
    return { ...filter, values: { ...filter.values, [facet]: next } };
}

export function cleared(filter: BrowseFilter, facet: Facet): BrowseFilter {
    return { ...filter, values: { ...filter.values, [facet]: [] } };
}

/** Facets and matching back to defaults; sort and prefix stay. */
export function reset(filter: BrowseFilter): BrowseFilter {
    return { ...filter, matchAll: true, values: {} };
}

export function activeFacetCount(filter: BrowseFilter): number {
    return FACETS.filter(({ facet }) => selected(filter, facet).length > 0).length;
}

export function canReset(filter: BrowseFilter): boolean {
    return activeFacetCount(filter) > 0 || !filter.matchAll;
}

/** CatalogFacets.optionPairs: fixed vocabularies for derived facets, the server's otherwise. */
export function options(facet: Facet, vocabulary: CatalogFilters | undefined): readonly { readonly value: string; readonly label: string }[] {
    const plain = (values: readonly string[] | undefined): { value: string; label: string }[] => (values ?? []).map(value => ({ value, label: value }));
    switch (facet) {
        case "decade": return DECADES.map(year => ({ value: String(year), label: `${year}s` }));
        case "dynamicRange": return [{ value: "hdr", label: "HDR" }, { value: "dolby_vision", label: "Dolby Vision" }];
        case "watchStatus": return WATCH_STATUS.map(([value, label]) => ({ value, label }));
        case "genre": return plain(vocabulary?.genres);
        case "contentRating": return plain(vocabulary?.contentRatings);
        case "studio": return plain(vocabulary?.studios);
        case "network": return plain(vocabulary?.networks);
        case "country": return plain(vocabulary?.countries);
        case "originalLanguage": return plain(vocabulary?.originalLanguages);
        case "resolution": return plain(vocabulary?.technical?.resolutions);
        case "audioLanguage": return plain(vocabulary?.technical?.audioLanguages);
        case "subtitleLanguage": return plain(vocabulary?.technical?.subtitleLanguages);
    }
}

/** "Any", the one chosen value's label, or "N selected". */
export function facetSummary(filter: BrowseFilter, facet: Facet, vocabulary: CatalogFilters | undefined): string {
    const values = selected(filter, facet);
    if (values.length === 0) return "Any";
    if (values.length > 1) return `${values.length} selected`;
    return options(facet, vocabulary).find(option => option.value === values[0])?.label ?? values[0] ?? "";
}

/** CatalogQueryBuilder.build for a movie or series library, page one of `limit`. */
export function browseQuery(filter: BrowseFilter, library: UserLibrary, limit: number): CatalogQueryRequest {
    const groups: FilterGroup[] = [];
    const any = (field: string, op: string, values: readonly string[]): void => {
        if (values.length > 0) groups.push({ match: "any", rules: [...values].sort().map(value => ({ field, op, value })) });
    };
    any("genre", "contains", selected(filter, "genre"));
    any("studio", "is", selected(filter, "studio"));
    any("network", "is", selected(filter, "network"));
    any("country", "is", selected(filter, "country"));
    any("content_rating", "is", selected(filter, "contentRating"));
    any("resolution", "is", selected(filter, "resolution"));
    any("audio_language", "is", selected(filter, "audioLanguage"));
    any("subtitle_language", "is", selected(filter, "subtitleLanguage"));
    any("original_language", "is", selected(filter, "originalLanguage"));
    const decades = selected(filter, "decade").map(Number).filter(Number.isInteger).sort((a, b) => a - b);
    if (decades.length > 0) groups.push({ match: "any", rules: decades.map(start => ({ field: "year", op: "between", value: [start, start + 9] })) });
    const range: FilterRule[] = selected(filter, "dynamicRange").filter(value => value === "hdr" || value === "dolby_vision").sort().map(field => ({ field, op: "is", value: true }));
    if (range.length > 0) groups.push({ match: "any", rules: range });
    const status = WATCH_STATUS.find(([value]) => value === selected(filter, "watchStatus")[0]);
    if (status !== undefined) groups.push({ match: "all", rules: [{ field: status[2], op: "is", value: status[0] !== "unwatched" }] });
    return {
        library_id: library.id, ...(library.type === "audiobooks" ? {} : { type: scopeOf(library) }), limit,
        sort: filter.sort, order: effectiveOrder(filter), match: filter.matchAll ? "all" : "any",
        ...(filter.prefix === undefined ? {} : { name_prefix: filter.prefix }),
        ...(groups.length === 0 ? {} : { groups }),
    };
}

/**
 * BrowsePrefsStore: per server, profile and library (and a mixed library's tab type), Browse remembers its
 * committed sort and filters while "Preserve sort & filters" is on (the default); the A–Z prefix is never
 * kept. Turning it off drops what was kept. Storage failures leave Browse working unremembered.
 */
export class BrowsePrefs {
    private readonly storage: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void } | undefined;
    private readonly base: string;
    private readonly choices = new Map<string, boolean>();

    constructor(storage: BrowsePrefs["storage"], base: string) {
        this.storage = storage;
        this.base = base;
    }

    private key(library: { readonly id: string; readonly type: string }): string {
        return `${this.base}.${JSON.stringify([library.id, library.type])}`;
    }

    preserve(library: Parameters<BrowsePrefs["key"]>[0]): boolean {
        try { return this.choices.get(this.key(library)) ?? (this.storage?.getItem(`${this.key(library)}.preserve`) !== "false"); } catch { return true; }
    }

    setPreserve(library: Parameters<BrowsePrefs["key"]>[0], enabled: boolean): void {
        this.choices.set(this.key(library), enabled);
        try {
            this.storage?.setItem(`${this.key(library)}.preserve`, String(enabled));
            if (!enabled) this.storage?.removeItem(`${this.key(library)}.state`);
        } catch { /* The choice applies for this session. */ }
    }

    saved(library: Parameters<BrowsePrefs["key"]>[0]): BrowseFilter | undefined {
        if (!this.preserve(library)) return undefined;
        let raw: string | null | undefined;
        try { raw = this.storage?.getItem(`${this.key(library)}.state`); } catch { return undefined; }
        if (raw == null) return undefined;
        try {
            const value = JSON.parse(raw) as Partial<BrowseFilter>;
            const sort = sortKeysFor(library.type).find(entry => entry.key === value.sort)?.key ?? "title";
            const order = value.order === "asc" || value.order === "desc" ? value.order : undefined;
            const values: Partial<Record<Facet, readonly string[]>> = {};
            for (const { facet } of FACETS) {
                const chosen = (value.values as Record<string, unknown> | undefined)?.[facet];
                if (Array.isArray(chosen)) values[facet] = chosen.filter((entry): entry is string => typeof entry === "string");
            }
            return { sort, order, matchAll: value.matchAll !== false, values, prefix: undefined };
        } catch { return undefined; }
    }

    save(library: Parameters<BrowsePrefs["key"]>[0], filter: BrowseFilter): void {
        if (!this.preserve(library)) return;
        try { this.storage?.setItem(`${this.key(library)}.state`, JSON.stringify({ ...filter, prefix: undefined })); } catch { /* Kept for this session only. */ }
    }
}
