// The browse reads of a fake Silo household: an owner and a PIN-locked child profile with
// different library access, applied server-side as Silo does. Bodies start from the vendored
// fixtures; titles are synthetic. Plug into FakeSilo.catalog.

import { fixture, problem, type CatalogRoutes, type Reply } from "./fakeSilo.ts";

export interface FakeTitle {
    readonly id: string;
    readonly type: "movie" | "series" | "episode" | "ebook";
    readonly title: string;
    readonly libraryId: string;
    readonly year?: number;
    /** Undefined: a served SVG. null: no artwork. A string: that URL. */
    readonly poster?: string | null;
    readonly seriesId?: string;
    readonly season?: number;
    readonly episode?: number;
    readonly backdrop?: string;
    readonly overview?: string;
    readonly runtime?: number;
    readonly duration?: number;
}

interface Household {
    readonly libraries: { id: string; name: string; type: string; sort_order: number }[];
    hidden: number[] | null;
    sections: { id: string; sectionType?: string; title: string; items: string[] }[];
}

const OWNER = "p-owner";
const KID = "p-kid";
const MAX_LIMIT = 200;

export class FakeCatalog implements CatalogRoutes {
    searchCapabilities = fixture("get_catalog_search_capabilities_ok");
    readonly titles = new Map<string, FakeTitle>();
    readonly households = new Map<string, Household>();
    /** content id -> resume position in seconds. */
    readonly progress = new Map<string, number>();
    readonly fileIds = new Map<string, string>();
    readonly removed = new Set<string>();
    private readonly failures = new Map<string, Reply[]>();
    private readonly searchContinuations = new Map<string, { q: string; type: string | null; household: Household; offset: number }>();

    constructor(movieCount = 60) {
        for (let i = 1; i <= movieCount; i++) {
            const n = String(i).padStart(4, "0");
            const title: FakeTitle = { id: `movie:m${n}`, type: "movie", title: `Movie ${n}`, libraryId: "12", year: 1990 + (i % 30) };
            // Movie 0002 has no artwork; Movie 0003's artwork URL fails to load.
            this.add(i === 2 ? { ...title, poster: null } : i === 3 ? { ...title, poster: "https://images.invalid/broken.jpg" } : title);
        }
        this.add({ id: "movie:archived", type: "movie", title: "Archived Feature", libraryId: "15", year: 1950 });
        for (const [index, name] of ["Harbor Lights", "Night Shift", "Quiet Hills"].entries()) {
            const seriesId = `series:s${index + 1}`;
            this.add({ id: seriesId, type: "series", title: name, libraryId: "13", year: 2020 + index });
            for (const season of index === 2 ? [] : [1, 2]) {
                for (let episode = 1; episode <= 3; episode++) {
                    this.add({ id: `episode:s${index + 1}e${season}${episode}`, type: "episode", title: `${name} chapter ${season}.${episode}`, libraryId: "13", seriesId, season, episode });
                }
            }
        }
        this.add({ id: "ebook:atlas", type: "ebook", title: "Atlas of Rivers", libraryId: "14" });
        for (let i = 1; i <= 8; i++) {
            this.add({ id: `movie:k${i}`, type: "movie", title: `Cartoon ${i}`, libraryId: "16", year: 2015 + i });
        }
        this.progress.set("movie:m0001", 1200);
        this.households.set(OWNER, {
            libraries: [
                { id: "12", name: "Movies", type: "movies", sort_order: 1 },
                { id: "13", name: "Shows", type: "series", sort_order: 2 },
                { id: "14", name: "Audiobooks", type: "audiobooks", sort_order: 3 },
                { id: "15", name: "Archive", type: "movies", sort_order: 4 },
            ],
            hidden: [15],
            sections: [
                { id: "continue_watching", title: "Continue Watching", items: ["movie:m0001", "episode:s1e12"] },
                { id: "books", title: "Books for you", items: ["ebook:atlas"] },
                { id: "recently_added", title: "Recently Added", items: ["ebook:atlas", "series:s1", "series:s2", ...this.ids("12").slice(0, 12), "episode:s1e12"] },
            ],
        });
        this.households.set(KID, {
            libraries: [{ id: "16", name: "Kids Movies", type: "movies", sort_order: 1 }],
            hidden: null,
            sections: [{ id: "kids_picks", title: "Kids Picks", items: this.ids("16") }],
        });
    }

    add(title: FakeTitle): void {
        this.titles.set(title.id, title);
    }

    /** The next requests for `pathname` get these replies, first in first out. */
    failNext(pathname: string, ...replies: Reply[]): void {
        this.failures.set(pathname, [...(this.failures.get(pathname) ?? []), ...replies]);
    }

    route(method: string, path: string, profileId: string | undefined, body?: Record<string, unknown>): Reply | undefined {
        const url = new URL(path, "https://fake.invalid");
        const failure = this.failures.get(url.pathname)?.shift();
        if (failure !== undefined) {
            return failure;
        }
        const household = profileId === undefined ? undefined : this.households.get(profileId);
        if (household !== undefined) {
            if (body?.type === "video_with_episodes" && body.source !== undefined && body.source !== "query") {
                return problem(422, "validation_failed", "Unsupported search scope");
            }
            if (method === "POST" && url.pathname === "/catalog/query" && typeof body?.q === "string") {
                const params = new URLSearchParams();
                for (const [key, value] of Object.entries(body)) if (typeof value === "string" || typeof value === "number") params.set(key, String(value));
                return this.page(household, params);
            }
            const discovery = this.discoveryRoute(household, method, url, body);
            if (discovery !== undefined) return discovery;
        }
        if (method !== "GET" || household === undefined) {
            return household === undefined ? problem(400, "profile_header_required", "Profile header required") : undefined;
        }
        const params = url.searchParams;
        const pathname = url.pathname;
        if (pathname === "/user/libraries") {
            // An unrestricted profile gets its own hidden libraries too; the client filters them.
            return { status: 200, body: { items: household.libraries } };
        }
        if (pathname === "/settings/values/effective") {
            const base = fixture("list_effective_settings_ok");
            return { status: 200, body: { ...base, items: [{ key: "ui.disabled_library_ids", value: household.hidden, source: household.hidden === null ? "default" : "profile", definition_revision: 3 }] } };
        }
        if (pathname === "/home/sections") {
            const template = toRecord(arrayOf(fixture("list_home_sections_ok").sections)[0]);
            const sections = household.sections.map((section) => {
                const items = section.items.filter((id) => this.visible(household, id)).map((id) => this.card(id));
                return { ...template, id: section.id, section_type: section.sectionType ?? section.id, title: section.title, total_count: items.length, items };
            });
            return { status: 200, body: { sections } };
        }
        if (pathname === "/catalog") {
            return this.page(household, params);
        }
        return this.detailRoutes(household, pathname);
    }

    private discoveryRoute(household: Household, method: string, url: URL, body: Record<string, unknown> | undefined): Reply | undefined {
        if (url.pathname === "/catalog/search/capabilities") return { status: 200, body: this.searchCapabilities };
        if (url.pathname === "/catalog/filters") return { status: 200, body: { ...fixture("get_catalog_filters_ok"), genres: ["Drama", "Comedy"] } };
        const library = /^\/library\/([^/]+)\/(sections|collections)(?:\/([^/]+)\/items)?$/.exec(url.pathname);
        const id = library?.[1] ?? (typeof body?.library_id === "string" ? body.library_id : undefined);
        if (id === undefined) return undefined;
        if (!household.libraries.some(item => item.id === id)) return problem(404, "not_found", "Not found");
        const titles = [...this.titles.values()].filter(title => title.libraryId === id && this.visible(household, title.id) && (title.type === "movie" || title.type === "series"));
        if (library?.[2] === "sections" && method === "GET") {
            const section = { id: "library-picks", section_type: "recently_added", title: "Library Picks", total_count: titles.length, items: titles.slice(0, 24).map(title => this.card(title.id)) };
            return { status: 200, body: library[3] === undefined ? { sections: titles.length === 0 ? [] : [section] } : section };
        }
        if (library?.[2] === "collections" && library[3] === undefined) {
            if (titles.length === 0) return { status: 200, body: { library_id: id, collections: [], groups: [], ungrouped: { sort_order: 1, collections: [] } } };
            const collection = { id: "highlights", library_id: id, library_ids: [id], group_id: "curated", title: "Library Highlights", poster_url: "", item_count: titles.length, poster_is_collage: false };
            return { status: 200, body: { library_id: id, collections: [collection], groups: [{ id: "curated", name: "Curated", kind: "admin", sort_mode: "name_asc", sort_order: 0, collections: [collection] }], ungrouped: { sort_order: 1, collections: [] } } };
        }
        if (url.pathname === "/catalog/letters") {
            const sorted = [...titles].sort((a, b) => a.title.localeCompare(b.title));
            const letters = [...new Set(sorted.map(title => title.title[0] ?? "#"))].map(letter => ({ letter, count: sorted.filter(title => title.title.startsWith(letter)).length, position: sorted.findIndex(title => title.title.startsWith(letter)) }));
            return { status: 200, body: { total: titles.length, letters, runs: letters.map(({ letter, position }) => ({ letter, position })) } };
        }
        if (url.pathname !== "/catalog/query" && library?.[3] === undefined) return undefined;
        const descending = body?.order === "desc";
        const ordered = [...titles].sort((a, b) => a.title.localeCompare(b.title));
        if (descending) ordered.reverse();
        const groups = body?.groups;
        const filtered = Array.isArray(groups) && JSON.stringify(groups).includes('"Comedy"') ? [] : ordered;
        const cursor = body?.cursor ?? url.searchParams.get("cursor");
        const offset = typeof body?.seek === "number" ? body.seek : typeof cursor === "string" && cursor.startsWith("cursor-") ? Number(cursor.slice(7)) : 0;
        const limit = typeof body?.limit === "number" ? body.limit : Number(url.searchParams.get("limit") ?? 24);
        const more = offset + limit < filtered.length;
        return { status: 200, body: { window_cursor: "window", effective_sort: { field: body?.sort ?? "title", order: body?.order ?? "asc" }, items: filtered.slice(offset, offset + limit).map(title => this.card(title.id)), total: filtered.length, total_exact: true, page: more ? { has_more: true, next_cursor: `cursor-${offset + limit}` } : { has_more: false } } };
    }

    private detailRoutes(household: Household, pathname: string): Reply | undefined {
        const watch = /^\/watch\/([^/]+)$/.exec(pathname);
        if (watch?.[1] !== undefined) {
            const id = decodeURIComponent(watch[1]);
            if (!this.visible(household, id)) return problem(404, "not_found", "Not found");
            const detail = this.detail(id);
            return { status: 200, body: { ...detail, versions: arrayOf(detail.versions).map(value => {
                const file = toRecord(value);
                return { ...file, duration_seconds: file.duration };
            }) } };
        }
        const item = /^\/catalog\/items\/([^/]+)$/.exec(pathname);
        if (item?.[1] !== undefined) {
            const id = decodeURIComponent(item[1]);
            return this.visible(household, id) ? { status: 200, body: this.detail(id) } : problem(404, "not_found", "Not found");
        }
        const seasons = /^\/catalog\/series\/([^/]+)\/seasons$/.exec(pathname);
        if (seasons?.[1] !== undefined) {
            const id = decodeURIComponent(seasons[1]);
            if (!this.visible(household, id)) {
                return problem(404, "not_found", "Not found");
            }
            const template = toRecord(arrayOf(fixture("list_series_seasons_ok").items)[0]);
            const numbers = [...new Set(this.episodes(id).map((episode) => episode.season ?? 0))];
            return { status: 200, body: { items: numbers.map((season) => ({ ...template, content_id: `${id}-S${season}`, season_number: season, title: `Season ${season}`, episode_count: this.episodes(id, season).length, poster_url: `/art/${encodeURIComponent(id)}-${season}.svg` })) } };
        }
        const episodes = /^\/catalog\/series\/([^/]+)\/seasons\/(\d+)\/episodes$/.exec(pathname);
        if (episodes?.[1] !== undefined && episodes[2] !== undefined) {
            const id = decodeURIComponent(episodes[1]);
            if (!this.visible(household, id)) {
                return problem(404, "not_found", "Not found");
            }
            const template = toRecord(arrayOf(fixture("list_season_episodes_ok").items)[0]);
            return {
                status: 200,
                body: {
                    items: this.episodes(id, Number(episodes[2])).map((episode) => ({
                        ...template,
                        content_id: episode.id,
                        season_number: episode.season,
                        episode_number: episode.episode,
                        title: episode.title,
                        user_data: { ...toRecord(template.user_data), played: episode.episode === 1 },
                        files: [{ file_id: `f-${episode.id}`, resolution: "1080p", hdr: false, file_size: 1 }],
                    })),
                },
            };
        }
        return undefined;
    }

    private ids(libraryId: string): string[] {
        return [...this.titles.values()].filter((title) => title.libraryId === libraryId).map((title) => title.id);
    }

    private episodes(seriesId: string, season?: number): FakeTitle[] {
        return [...this.titles.values()].filter((title) => title.seriesId === seriesId && !this.removed.has(title.id) && (season === undefined || title.season === season));
    }

    /** What the profile's library access allows; the client never sees the rest. */
    private visible(household: Household, id: string): boolean {
        const title = this.titles.get(id);
        return title !== undefined && !this.removed.has(id) && household.libraries.some((library) => library.id === title.libraryId);
    }

    private page(household: Household, params: URLSearchParams): Reply {
        const limit = Number(params.get("limit") ?? "50");
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
            return problem(422, "validation_failed", "Validation failed");
        }
        const libraryId = params.get("library_id");
        if (libraryId !== null && !household.libraries.some((library) => library.id === libraryId)) {
            return problem(404, "not_found", "Not found");
        }
        const type = params.get("type");
        const q = (params.get("q") ?? "").toLowerCase();
        if (type === "video_with_episodes" && ((params.get("source") ?? "query") !== "query" || this.searchCapabilities.video_with_episodes_scope !== true)) {
            return problem(422, "validation_failed", "Unsupported search scope");
        }
        const matches = [...this.titles.values()]
            .filter((title) => this.visible(household, title.id) && (libraryId === null || title.libraryId === libraryId))
            .filter((title) => (type === "video" || type === "video_with_episodes"
                ? title.type === "movie" || title.type === "series" || (type === "video_with_episodes" && q.trim() !== "" && title.type === "episode")
                : title.type === type))
            .filter((title) => q === "" || title.title.toLowerCase().indexOf(q) !== -1)
            .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
        const cursor = params.get("cursor");
        const continuation = cursor === null ? undefined : this.searchContinuations.get(cursor);
        const offset = cursor === null ? 0 : q !== ""
            ? continuation?.q === q && continuation.type === type && continuation.household === household ? continuation.offset : NaN
            : Number(/^cursor-(\d+)$/.exec(cursor)?.[1] ?? "NaN");
        if (!Number.isInteger(offset)) {
            return problem(400, "invalid_cursor", "Invalid cursor");
        }
        const items = matches.slice(offset, offset + limit).map((title) => this.card(title.id));
        const more = offset + limit < matches.length;
        const next = q === "" ? `cursor-${offset + limit}` : `search+/= ?字:${q}:${type}:${offset + limit}`;
        if (more && q !== "") this.searchContinuations.set(next, { q, type, household, offset: offset + limit });
        const page = more ? { has_more: true, next_cursor: next } : { has_more: false };
        return { status: 200, body: { window_cursor: "window", items, page, total: matches.length, total_exact: true } };
    }

    private card(id: string): Record<string, unknown> {
        const title = this.mustTitle(id);
        const template = toRecord(arrayOf(fixture("list_catalog_items_ok").items)[0]);
        const series = title.seriesId === undefined ? undefined : this.titles.get(title.seriesId);
        const card: Record<string, unknown> = { ...template, content_id: id, type: title.type, title: title.title, year: title.year };
        Object.assign(card, { backdrop_url: title.backdrop, overview: title.overview, runtime: title.runtime, duration_seconds: title.duration });
        const poster = title.poster === undefined ? `/art/${encodeURIComponent(id)}.svg` : title.poster;
        if (poster !== null) {
            card.poster_url = poster;
        }
        if (series !== undefined) {
            Object.assign(card, { series_id: series.id, series_title: series.title, season_number: title.season, episode_number: title.episode });
        }
        const position = this.progress.get(id);
        if (position !== undefined) {
            card.position_seconds = position;
        }
        return card;
    }

    private detail(id: string): Record<string, unknown> {
        const title = this.mustTitle(id);
        const template = fixture("get_catalog_item_ok");
        const version = toRecord(arrayOf(template.versions)[0]);
        const body: Record<string, unknown> = {
            ...template,
            ...this.card(id),
            overview: `A synthetic ${title.type} for the browse tests.`,
            runtime: 90,
            duration_seconds: 5400,
            versions: title.type === "series" ? [] : [{ ...version, file_id: this.fileIds.get(id) ?? `f-${id}`, duration: 5400 }],
            user_data: { watched_count: 0, unplayed_count: 1, in_progress_count: 0, played: false, position_seconds: this.progress.get(id), last_file_id: this.fileIds.get(id) ?? `f-${id}` },
        };
        if (title.type === "series") {
            body.play_content_id = this.episodes(id)[0]?.id;
        }
        return body;
    }

    private mustTitle(id: string): FakeTitle {
        const title = this.titles.get(id);
        if (title === undefined) {
            throw new Error(`no title ${id}`);
        }
        return title;
    }
}

function toRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("expected an object");
    }
    return { ...value };
}

function arrayOf(value: unknown): unknown[] {
    if (!Array.isArray(value)) {
        throw new Error("expected an array");
    }
    return value;
}
