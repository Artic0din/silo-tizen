// Requests over FakeCatalog. Status, My Requests, create and cancel start from the vendored fixtures;
// discover, search, browse, detail and follow bodies are synthetic, built from the pinned OpenAPI
// schemas (no fixture exists at SOURCE). The household's requests belong to the account.
import { FakeCatalog } from "./fakeCatalog.ts";
import { fixture, problem, type Reply } from "./fakeSilo.ts";

export interface FakeRequestTitle {
    readonly media_type: "movie" | "series";
    readonly tmdb_id: number;
    readonly title: string;
    readonly year: number;
    readonly poster_path?: string;
    availability: "missing" | "available";
    library_content_id?: string;
}
interface FakeRequest { id: string; key: string; status: string; outcome: string; state: string; profile: string; targets: number; created: string }

const PAGE = 20;
const key = (type: string, id: number | string): string => `${type}:${id}`;

export class FakeRequests extends FakeCatalog {
    status: Record<string, unknown> = fixture("request_status_ok");
    readonly media = new Map<string, FakeRequestTitle>();
    readonly requests: FakeRequest[] = [];
    readonly follows = new Set<string>();
    rowOrder: { key: string; type: string; title: string }[] = [
        { key: "trending_movies", type: "tmdb_chart", title: "Trending Movies" },
        { key: "r_cozy", type: "tmdb_list", title: "Cozy Nights" },
        { key: "future_row", type: "future_kind", title: "Unknown row" },
        { key: "studios", type: "studios", title: "Studios" },
        { key: "genres", type: "genres", title: "Genres" },
    ];
    private nextRequest = 3;

    constructor() {
        super();
        for (let i = 1; i <= 45; i++) this.addMedia({ media_type: "movie", tmdb_id: 1000 + i, title: `Request Movie ${i}`, year: 2000 + (i % 20), poster_path: `/poster-${i}.jpg`, availability: "missing" });
        this.addMedia({ media_type: "series", tmdb_id: 1399, title: "Northern Line", year: 2024, availability: "missing" });
        this.addMedia({ media_type: "movie", tmdb_id: 603, title: "Signal Harbor", year: 1999, availability: "available", library_content_id: "movie:m0001" });
        this.addMedia({ media_type: "movie", tmdb_id: 949, title: "Heat", year: 1995, availability: "missing" });
        this.addMedia({ media_type: "movie", tmdb_id: 950, title: "Heat", year: 1995, availability: "missing" });
        // The fixture's two requests: r-1 is processing, r-2 is pending; both made by the owner.
        this.requests.push({ id: "r-2", key: key("movie", 950), status: "pending", outcome: "active", state: "pending", profile: "p-owner", targets: 1, created: "2026-01-02T03:04:05.678Z" });
        this.requests.push({ id: "r-1", key: key("movie", 949), status: "downloading", outcome: "active", state: "processing", profile: "p-owner", targets: 1, created: "2026-01-02T03:04:05.678Z" });
        // Another account's active request: the owner can follow it.
        this.requests.push({ id: "r-other", key: key("series", 1399), status: "approved", outcome: "active", state: "approved", profile: "p-elsewhere", targets: 0, created: "2026-01-01T00:00:00.000Z" });
    }

    addMedia(title: FakeRequestTitle): void {
        this.media.set(key(title.media_type, title.tmdb_id), title);
    }
    disable(state = "disabled"): void {
        this.status = { ...this.status, state, requests_enabled: false };
    }
    count(method: string, pattern: RegExp, requests: readonly { method: string; path: string }[]): number {
        return requests.filter(request => request.method === method && pattern.test(request.path)).length;
    }

    override route(method: string, path: string, profileId: string | undefined, body?: Record<string, unknown>): Reply | undefined {
        const url = new URL(path, "https://fake.invalid");
        if (!url.pathname.startsWith("/requests")) return super.route(method, path, profileId, body);
        if (profileId === undefined || !this.households.has(profileId)) return problem(422, "validation_failed", "Profile required");
        if (method === "GET" && url.pathname === "/requests/status") return { status: 200, body: this.status };
        if (this.status.requests_enabled !== true) return problem(409, "capability_disabled", "Requests are disabled");
        const page = Number(url.searchParams.get("page") ?? "1");
        const path_ = url.pathname;
        if (method === "GET" && path_ === "/requests/discover") {
            return { status: 200, body: {
                row_order: this.rowOrder,
                items: this.rowOrder.filter(row => !["studios", "networks", "genres"].includes(row.type)).map(row => this.row(row.key, row.title, 1, profileId)).filter(row => row.results.length > 0),
            } };
        }
        const section = /^\/requests\/discover\/(?:rows\/)?([a-z0-9_]+)$/.exec(path_);
        if (method === "GET" && section?.[1] !== undefined && !["studios", "networks", "genres"].includes(section[1])) {
            const row = this.rowOrder.find(candidate => candidate.key === section[1]);
            return row === undefined ? problem(404, "not_found", "Not found") : { status: 200, body: this.row(row.key, row.title, page, profileId) };
        }
        const brands = /^\/requests\/discover\/(studios|networks|genres)$/.exec(path_);
        if (method === "GET" && brands?.[1] !== undefined) {
            const names = brands[1] === "genres" ? ["Drama", "Comedy"] : brands[1] === "studios" ? ["Harbor Pictures"] : ["North Broadcasting"];
            return { status: 200, body: { items: names.map(name => ({ slug: name.toLowerCase().replace(/ /g, "-"), display_name: name, logo_url: null })) } };
        }
        const browse = /^\/requests\/discover\/browse\/(genre|network|studio)\/([^/]+)$/.exec(path_);
        if (method === "GET" && browse?.[1] !== undefined) {
            if (browse[1] === "genre" && !["movie", "series"].includes(url.searchParams.get("media_type") ?? "")) return problem(422, "validation_failed", "media_type required");
            return { status: 200, body: { kind: browse[1], slug: decodeURIComponent(browse[2] ?? ""), display_name: "Brand", logo_url: null, media_type: url.searchParams.get("media_type") ?? "movie", sort: "popularity", ...this.mediaPage(this.movies().slice(10), page, profileId) } };
        }
        if (method === "GET" && path_ === "/requests/search") {
            const q = (url.searchParams.get("q") ?? "").toLowerCase();
            if (q === "") return problem(422, "validation_failed", "q required");
            return { status: 200, body: { ...this.mediaPage([...this.media.values()].filter(title => title.title.toLowerCase().includes(q)), page, profileId), total_results: 0 } };
        }
        const detail = /^\/requests\/detail\/(movie|series)\/(\d+)$/.exec(path_);
        if (method === "GET" && detail !== null) {
            const title = this.media.get(key(detail[1] ?? "", detail[2] ?? ""));
            return title === undefined ? problem(404, "not_found", "Not found") : { status: 200, body: this.mediaDetail(title, profileId) };
        }
        if (method === "GET" && path_ === "/requests/mine") {
            const offset = Number(url.searchParams.get("cursor")?.slice(1) ?? "0"), limit = Number(url.searchParams.get("limit") ?? "50");
            const items = this.requests.filter(request => request.profile !== "p-elsewhere").slice(offset, offset + limit);
            const more = offset + limit < this.requests.filter(request => request.profile !== "p-elsewhere").length;
            return { status: 200, body: { items: items.map(request => this.request(request)), page: more ? { has_more: true, next_cursor: `c${offset + limit}` } : { has_more: false } } };
        }
        if (method === "POST" && path_ === "/requests") {
            const target = this.media.get(key(String(body?.media_type), String(body?.tmdb_id)));
            if (target === undefined || typeof body?.title !== "string") return problem(422, "validation_failed", "Invalid request");
            if (this.active(target) !== undefined || target.availability === "available") return problem(409, "conflict", "Already requested");
            const request: FakeRequest = { id: `r-${this.nextRequest++}`, key: key(target.media_type, target.tmdb_id), status: "pending", outcome: "active", state: "pending", profile: profileId, targets: 0, created: "2026-01-03T00:00:00.000Z" };
            this.requests.unshift(request);
            return { status: 201, body: { ...fixture("create_request_ok"), ...this.request(request) } };
        }
        const cancel = /^\/requests\/([^/]+)\/cancel$/.exec(path_);
        if (method === "POST" && cancel !== null) {
            const request = this.requests.find(candidate => candidate.id === decodeURIComponent(cancel[1] ?? ""));
            if (request === undefined) return problem(404, "not_found", "Not found");
            if (request.outcome !== "active" || !(request.status === "pending" || request.status === "approved" && request.targets === 0)) return problem(409, "conflict", "Already sent");
            request.outcome = "cancelled";
            request.state = "cancelled";
            return { status: 200, body: { ...fixture("cancel_request_ok"), ...this.request(request) } };
        }
        const follow = /^\/requests\/follows\/(movie|series)\/(\d+)$/.exec(path_);
        if (follow !== null && (method === "PUT" || method === "DELETE")) {
            const title = this.media.get(key(follow[1] ?? "", follow[2] ?? ""));
            if (title === undefined) return problem(404, "not_found", "Not found");
            const id = `${profileId}|${key(title.media_type, title.tmdb_id)}`;
            if (method === "DELETE") { this.follows.delete(id); return { status: 204 }; }
            if (this.active(title) === undefined) return problem(409, "conflict", "Nothing to follow");
            this.follows.add(id);
            return { status: 200, body: this.state(title, profileId) };
        }
        return problem(404, "not_found", "Not found");
    }

    private movies(): FakeRequestTitle[] {
        return [...this.media.values()].filter(title => title.media_type === "movie" && title.tmdb_id > 1000);
    }
    private active(title: FakeRequestTitle): FakeRequest | undefined {
        return this.requests.find(request => request.key === key(title.media_type, title.tmdb_id) && request.outcome === "active");
    }
    state(title: FakeRequestTitle, profileId: string): Record<string, unknown> {
        const active = this.active(title);
        const mine = active?.profile === profileId;
        return {
            requestable: active === undefined && title.availability !== "available",
            following: active !== undefined && (mine || this.follows.has(`${profileId}|${key(title.media_type, title.tmdb_id)}`)),
            requested_by_viewer: mine,
            ...(active === undefined ? title.availability === "available" ? { reason: "already_available" } : {} : { request_id: active.id, state: active.state, status: active.status, reason: "already_requested" }),
        };
    }
    private result(title: FakeRequestTitle, profileId: string): Record<string, unknown> {
        const { media_type, tmdb_id, title: name, year, poster_path, availability, library_content_id } = title;
        return { media_type, tmdb_id, title: name, year, ...(poster_path === undefined ? {} : { poster_path }), availability, ...(library_content_id === undefined ? {} : { library_content_id }), overview: `${name} overview.`, request: this.state(title, profileId), in_watchlist: false };
    }
    private mediaPage(titles: readonly FakeRequestTitle[], page: number, profileId: string): Record<string, unknown> {
        return { page, total_pages: Math.max(1, Math.ceil(titles.length / PAGE)), total_results: titles.length, results: titles.slice((page - 1) * PAGE, page * PAGE).map(title => this.result(title, profileId)) };
    }
    private row(rowKey: string, title: string, page: number, profileId: string): Record<string, unknown> & { results: unknown[] } {
        const titles = rowKey === "trending_movies" ? [...this.movies(), ...[...this.media.values()].filter(title => title.tmdb_id < 1000)] : this.movies().slice(0, 6);
        const body = this.mediaPage(titles, page, profileId);
        return { key: rowKey, title, ...body, results: body.results as unknown[] };
    }
    private mediaDetail(title: FakeRequestTitle, profileId: string): Record<string, unknown> {
        return {
            ...this.result(title, profileId), genres: ["Drama"], production_companies: [], networks: [], cast: [], creators: [], recommendations: [], runtime: title.media_type === "movie" ? 118 : undefined,
            seasons: title.media_type === "series" ? [{ season_number: 1, episode_count: 8, availability: "missing", requested: true }] : [],
        };
    }
    private request(request: FakeRequest): Record<string, unknown> {
        const title = this.media.get(request.key);
        return {
            id: request.id, provider: "tmdb", media_type: title?.media_type, tmdb_id: title?.tmdb_id, title: title?.title, year: title?.year,
            status: request.status, outcome: request.outcome, state: request.state, seasons: [], season_progress: [], source: "direct",
            requested_by_user_id: "1", requested_by_profile_id: request.profile, is_anime: false,
            targets: Array.from({ length: request.targets }, (_, i) => ({ id: String(42 + i), request_id: request.id, quality: "1080p", is_anime: false, status: "queued", created_at: request.created, updated_at: request.created })),
            created_at: request.created, updated_at: request.created,
            ...(request.state === "processing" ? { download: { phase: "downloading", percent: 43, bytes_total: 4294967296, bytes_left: 2448131358, downloads: 1, updated_at: request.created } } : {}),
        };
    }
}
