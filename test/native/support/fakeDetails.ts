import { FakeCatalog, type FakeTitle } from "./fakeCatalog.ts";
import { fixture, problem, type Reply } from "./fakeSilo.ts";
import assert from "node:assert/strict";
import { object, string } from "../../../src/contracts/v2/wire.ts";
import { defaultFiles } from "./fakePlayback.ts";

/** Detail-only synthetic extension; leaves library discovery fixtures untouched. */
export class FakeDetails extends FakeCatalog {
    private readonly personalByProfile = new Map<string, Set<string>>();
    get favorite(): boolean { return this.personalMembers("p-owner", "favorites").has("movie:m0001"); }
    set favorite(value: boolean) { this.setMember("p-owner", "favorites", "movie:m0001", value); }
    get watchlist(): boolean { return this.personalMembers("p-owner", "watchlist").has("movie:m0001"); }
    set watchlist(value: boolean) { this.setMember("p-owner", "watchlist", "movie:m0001", value); }
    get watched(): boolean { return this.personalMembers("p-owner", "watched").has("movie:m0001"); }
    set watched(value: boolean) { this.setMember("p-owner", "watched", "movie:m0001", value); }
    capability = true;
    /** Home and catalog cards carry `user_state` and, while in progress, `progress_updated_at`, as the server sends them. */
    cardUserState = false;
    empty = false;
    extras: readonly Record<string, unknown>[] = [];
    videos: readonly Record<string, unknown>[] = [];
    readonly mutations: string[] = [];
    mutationFailure: Reply | undefined;
    readonly neverPlayed = new Set<string>();
    readonly audioFiles = defaultFiles();
    readonly subtitleFiles = new Map<string, readonly Record<string, unknown>[]>();
    readonly personCredits = new Map<string, string[]>([["7", [...this.titles.keys(), "movie:m0001"]]]);
    readonly personLibraryIds = new Map<string, string[]>();
    readonly matureTitles = new Set<string>();
    readonly personReplies: Reply[] = [];
    private readonly personCursors = new Map<string, { scope: string; offset: number }>();
    get watchedEpisodes(): Set<string> { return this.personalMembers("p-owner", "episodes"); }

    private personalMembers(profile: string | undefined, kind: string): Set<string> {
        const key = JSON.stringify([profile, kind]);
        let values = this.personalByProfile.get(key);
        if (values === undefined) {
            values = new Set(kind === "episodes" ? [...this.titles.values()].filter(title => title.type === "episode" && title.season === 1).map(title => title.id) : []);
            this.personalByProfile.set(key, values);
        }
        return values;
    }

    private setMember(profile: string | undefined, kind: string, id: string, value: boolean): void {
        if (value) this.personalMembers(profile, kind).add(id);
        else this.personalMembers(profile, kind).delete(id);
    }

    protected override card(id: string): Record<string, unknown> {
        const card = super.card(id);
        if (!this.cardUserState) return card;
        return { ...card, ...(card.position_seconds === undefined ? {} : { progress_updated_at: "2026-11-01T10:00:00.123456Z" }),
            user_state: { played: this.playedFor(id, "p-owner"), is_favorite: this.personalMembers("p-owner", "favorites").has(id), in_watchlist: this.personalMembers("p-owner", "watchlist").has(id), not_interested: false } };
    }

    private playedFor(id: string, profileId: string | undefined): boolean {
        const title = this.titles.get(id);
        return title?.type === "series" ? this.episodesPlayed(id, profileId) : title?.type === "episode" ? this.personalMembers(profileId, "episodes").has(id) : this.personalMembers(profileId, "watched").has(id);
    }

    override route(method: string, path: string, profileId: string | undefined, body?: Record<string, unknown>): Reply | undefined {
        const url = new URL(path, "https://example.test");
        const dismissal = /^\/home\/dismissals\/(continue_watching|next_up)\/([^/]+)$/.exec(url.pathname);
        if (dismissal !== null && method === "PUT") {
            this.mutations.push(`${method} ${url.pathname} ${JSON.stringify(body ?? {})}`);
            if (this.mutationFailure !== undefined) { const failure = this.mutationFailure; this.mutationFailure = undefined; return failure; }
            const field = dismissal[1] === "continue_watching" ? "progress_updated_at" : "series_id";
            if (typeof body?.[field] !== "string" || Object.keys(body).length !== 1) return problem(422, "validation_failed", `${field} is required`);
            this.homeDismissed.add(decodeURIComponent(dismissal[2] ?? ""));
            return { status: 204 };
        }
        if (method === "GET" && url.pathname.startsWith("/watch/")) {
            const reply = this.route("GET", `/catalog/items/${url.pathname.slice(7)}`, profileId);
            if (reply?.status !== 200) return reply;
            const detail = object(reply.body, "detail");
            return { status: 200, body: { ...detail, versions: Array.isArray(detail.versions) ? detail.versions.map((value: unknown) => {
                const file = object(value, "version");
                return { ...file, duration_seconds: file.duration };
            }) : [] } };
        }
        const personQuery = url.pathname === "/catalog/query" && body?.source === "person";
        if (personQuery || (url.pathname === "/catalog" && url.searchParams.get("source") === "person")) {
            return this.personPage(method, url, profileId, body);
        }
        if (url.pathname.startsWith("/catalog/people/")) {
            const id = decodeURIComponent(url.pathname.slice("/catalog/people/".length));
            if (method !== "GET" || !this.visibleCredits(id, profileId).length) return problem(404, "not_found", "Not found");
            return { status: 200, body: { id, name: "River Vale", bio: "A synthetic performer whose work spans film and television.", birth_date: "1980-04-12", birthplace: "Melbourne", photo_url: "/art/river.svg" } };
        }
        if (url.pathname === "/catalog/items/series%3As1-S1") return { status: 200, body: { ...fixture("get_catalog_item_ok"), content_id: "series:s1-S1", type: "season", series_id: "series:s1", season_number: 1, title: "Harbor Lights · Season 1", overview: "The first season follows the night shift at a coastal observatory.", backdrop_url: "/art/harbor.svg", play_content_id: "episode:s1e11", versions: [], user_state: { played: this.episodesPlayed("series:s1", profileId, 1) }, user_data: { played: this.episodesPlayed("series:s1", profileId, 1) } } };
        if (profileId !== "p-owner" && !url.pathname.startsWith("/user/") && (url.pathname.startsWith("/catalog/people/") || url.pathname.startsWith("/recommendations/") || url.pathname.startsWith("/capabilities/"))) return problem(404, "not_found", "Not found");
        if (url.pathname === "/capabilities/personal-lists") return { status: 200, body: { state: this.capability ? "available" : "unsupported", allowed: this.capability, membership_supported: this.capability, revision: "synthetic" } };
        if (url.pathname.startsWith("/recommendations/similar/")) {
            return { status: 200, body: { items: this.empty ? [] : Array.from({ length: 30 }, (_, index) => url.pathname.endsWith("series%3As1") && index < 2 ? ({ content_id: `series:s1-S${index + 1}`, type: "season", series_id: "series:s1", season_number: index + 1, title: `Harbor Lights · Season ${index + 1}` }) : ({ content_id: `movie:m${String(index + 2).padStart(4, "0")}`, type: "movie", title: `Movie ${String(index + 2).padStart(4, "0")}`, poster_url: `/art/movie-${index + 2}.svg` })) } };
        }
        const personal = /^\/(watchlist|favorites|watched)\/([^/]+)(\/membership)?$/.exec(url.pathname);
        if (personal !== null) {
            const kind = personal[1];
            if (personal[2] === "series%3As1-S1" && kind !== "watched") return problem(404, "not_found", "Not found");
            const id = decodeURIComponent(personal[2] ?? "");
            if (method === "GET") return { status: 200, body: { item_id: id, is_member: this.personalMembers(profileId, kind ?? "").has(id) } };
            this.mutations.push(`${method} ${url.pathname}`);
            if (this.mutationFailure !== undefined) { const failure = this.mutationFailure; this.mutationFailure = undefined; return failure; }
            if (kind === "favorites" || kind === "watchlist") this.setMember(profileId, kind, id, method === "PUT");
            if (kind === "watched") {
                const id = decodeURIComponent(personal[2] ?? "");
                const played = method === "POST";
                this.setMember(profileId, "watched", id, played);
                for (const title of this.titles.values()) {
                    if (title.type === "episode" && (title.id === id || title.seriesId === id || `${title.seriesId}-S${title.season}` === id)) {
                        this.setMember(profileId, "episodes", title.id, played);
                        this.progress.delete(title.id);
                    }
                }
                this.progress.delete(id);
            }
            return { status: 204 };
        }
        const reply = super.route(method, path, profileId, body);
        if (reply?.status === 200 && url.pathname.endsWith("/episodes")) {
            const body = object(reply.body, "episodes");
            assert.ok(Array.isArray(body.items));
            return { ...reply, body: { ...body, items: body.items.map((value: unknown) => {
                const episode = object(value, "episode");
                return { ...episode, user_data: { played: this.personalMembers(profileId, "episodes").has(string(episode, "content_id", "episode")) } };
            }) } };
        }
        if (reply?.status === 200 && url.pathname.startsWith("/catalog/items/")) {
            const body = object(reply.body, "detail");
            const id = string(body, "content_id", "detail");
            const played = this.playedFor(id, profileId);
            reply.body = { ...body,
                ...(Array.isArray(body.versions) ? { versions: body.versions.map((value: unknown) => {
                    const file = object(value, "version");
                    const audio = this.audioFiles.get(string(file, "file_id", "version"))?.audio;
                    return { ...file, ...(audio === undefined ? {} : { audio_tracks: audio }) };
                }) } : {}),
                ...(id === "series:s1" ? { extras: this.extras, videos: this.videos } : {}),
                user_state: { played, is_favorite: this.personalMembers(profileId, "favorites").has(id), in_watchlist: this.personalMembers(profileId, "watchlist").has(id) }, user_data: this.neverPlayed.has(id) && !played ? undefined : { ...object(body.user_data, "user_data"), played } };
        }
        if (url.pathname === "/catalog/items/movie%3Am0001" && reply?.status === 200 && typeof reply.body === "object" && reply.body !== null) {
            return { status: 200, body: { ...reply.body,
                title: "The Last Signal", overview: "A remote observatory receives a message that changes the lives of everyone on the night shift.", extras: this.extras, videos: this.videos,
                backdrop_url: "/art/last-signal-backdrop.svg", logo_url: "/art/last-signal-logo.svg",
                cast: [{ person_id: "7", name: "River Vale", character: "Alex", order: 0, photo_url: "/art/river.svg" }, { name: "Morgan Lane", character: "Sam", order: 1 }],
                crew: [{ person_id: "7", name: "River Vale", job: "Director", photo_url: "/art/river.svg" }],
                ratings: [{ source: "imdb", name: "IMDb", score: 81, display: "8.1" }], studios: ["North Studio"], countries: ["AU"], original_language: "en",
                versions: [{ file_id: "42", duration: 5400, resolution: "2160p", codec_video: "hevc", codec_audio: "aac", hdr: true, edition_raw: "Original", audio_tracks: this.audioFiles.get("42")?.audio, subtitle_tracks: this.subtitleFiles.get("42") }, { file_id: "43", duration: 1200, resolution: "1080p", codec_video: "h264", codec_audio: "aac", hdr: false, edition_raw: "Short cut", audio_tracks: this.audioFiles.get("43")?.audio, subtitle_tracks: this.subtitleFiles.get("43") }],
                user_data: this.neverPlayed.has("movie:m0001") && !this.personalMembers(profileId, "watched").has("movie:m0001") ? undefined : { played: this.personalMembers(profileId, "watched").has("movie:m0001"), position_seconds: this.progress.get("movie:m0001"), last_file_id: "42" },
            } };
        }
        return reply;
    }

    private episodesPlayed(seriesId: string, profile: string | undefined, season?: number): boolean {
        const episodes = [...this.titles.values()].filter((title) => title.type === "episode" && title.seriesId === seriesId && (season === undefined || title.season === season));
        return episodes.length > 0 && episodes.every((episode) => this.personalMembers(profile, "episodes").has(episode.id));
    }

    private visibleCredits(id: string, profileId: string | undefined): string[] {
        const household = profileId === undefined ? undefined : this.households.get(profileId);
        return [...new Set(this.personCredits.get(id) ?? [])].filter(id => {
            const title = this.titles.get(id);
            return title !== undefined && !this.removed.has(id) && (this.personLibraryIds.get(id) ?? [title.libraryId]).some(libraryId =>
                household?.libraries.some(library => library.id === libraryId) && !household.hidden?.includes(Number(libraryId)))
                && (profileId !== "p-kid" || !this.matureTitles.has(id));
        });
    }

    private personPage(method: string, url: URL, profileId: string | undefined, body?: Record<string, unknown>): Reply {
        const answer = body?.limit === 1 ? undefined : this.personReplies.shift();
        if (answer !== undefined) return answer;
        const id = String(body?.person_id ?? url.searchParams.get("person_id"));
        const type = body?.type ?? url.searchParams.get("type");
        const limit = Number(body?.limit ?? url.searchParams.get("limit") ?? 50);
        const cursor = body?.cursor ?? url.searchParams.get("cursor");
        const sort = body?.sort ?? url.searchParams.get("sort");
        const descending = body?.order === "desc" || sort === "-year";
        const household = profileId === undefined ? undefined : this.households.get(profileId);
        if (!/^[1-9]\d*$/.test(id) || !Number.isInteger(limit) || limit < 1 || limit > (method === "POST" ? 100 : 200)
            || !["video", "movie", "series"].includes(String(type))) return problem(422, "validation_failed", "Invalid person query");
        const scope = JSON.stringify([method, id, profileId, type, sort, descending, limit, household?.hidden, household?.libraries, [...this.matureTitles]]);
        const position = typeof cursor === "string" ? this.personCursors.get(cursor) : undefined;
        if (cursor != null && position?.scope !== scope) return problem(400, "invalid_cursor", "Invalid cursor");
        const offset = position?.offset ?? 0;
        const population = this.empty ? [] : this.visibleCredits(id, profileId).map(id => this.titles.get(id)).filter((title): title is FakeTitle => title !== undefined).filter(title => type === "video" ? title.type === "movie" || title.type === "series" : title.type === type);
        if (sort === "year" || sort === "-year") population.sort((a, b) => (descending ? (b.year ?? 0) - (a.year ?? 0) : (a.year ?? 0) - (b.year ?? 0)) || a.id.localeCompare(b.id));
        else population.reverse(); // Fixture insertion order stands in for added_at.
        const next = offset + limit < population.length ? `opaque-person-${this.personCursors.size + 1}/+==` : undefined;
        if (next !== undefined) this.personCursors.set(next, { scope, offset: offset + limit });
        return { status: 200, body: {
            window_cursor: "synthetic-person-window", total: population.length, total_exact: true,
            effective_sort: { field: "year", order: descending ? "desc" : "asc" },
            items: population.slice(offset, offset + limit).map(title => ({ content_id: title.id, title: title.title, type: title.type, year: title.year,
                ...(title.poster === null ? {} : { poster_url: title.poster ?? `/art/${encodeURIComponent(title.id)}.svg` }) })),
            page: next === undefined ? { has_more: false } : { has_more: true, next_cursor: next },
        } };
    }
}
