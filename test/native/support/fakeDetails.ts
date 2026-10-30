import { FakeCatalog } from "./fakeCatalog.ts";
import { fixture, problem, type Reply } from "./fakeSilo.ts";
import assert from "node:assert/strict";
import { object, string } from "../../../src/contracts/v2/wire.ts";

/** Detail-only synthetic extension; leaves library discovery fixtures untouched. */
export class FakeDetails extends FakeCatalog {
    favorite = false;
    watchlist = false;
    watched = false;
    capability = true;
    empty = false;
    readonly mutations: string[] = [];
    mutationFailure: Reply | undefined;
    readonly neverPlayed = new Set<string>();
    readonly watchedEpisodes = new Set([...this.titles.values()].filter((title) => title.type === "episode" && title.season === 1).map((title) => title.id));

    override route(method: string, path: string, profileId: string | undefined): Reply | undefined {
        const url = new URL(path, "https://example.test");
        if (url.pathname === "/catalog/items/series%3As1-S1") return { status: 200, body: { ...fixture("get_catalog_item_ok"), content_id: "series:s1-S1", type: "season", series_id: "series:s1", season_number: 1, title: "Harbor Lights · Season 1", overview: "The first season follows the night shift at a coastal observatory.", backdrop_url: "/art/harbor.svg", play_content_id: "episode:s1e11", versions: [], user_state: { played: this.episodesPlayed("series:s1", 1) }, user_data: { played: this.episodesPlayed("series:s1", 1) } } };
        if (profileId !== "p-owner" && !url.pathname.startsWith("/user/") && (url.pathname.startsWith("/catalog/people/") || url.pathname.startsWith("/recommendations/") || url.pathname.startsWith("/capabilities/"))) return problem(404, "not_found", "Not found");
        if (url.pathname === "/capabilities/personal-lists") return { status: 200, body: { state: this.capability ? "available" : "unsupported", allowed: this.capability, membership_supported: this.capability, revision: "synthetic" } };
        if (url.pathname === "/catalog/people/river") return { status: 200, body: { id: "river", name: "River Vale", bio: "A synthetic performer whose work spans film and television.", birth_date: "1980-04-12", birthplace: "Melbourne", photo_url: "/art/river.svg" } };
        if (url.pathname.startsWith("/recommendations/similar/") || (url.pathname === "/catalog" && url.searchParams.get("source") === "person")) {
            const base = fixture("list_catalog_items_ok");
            return { status: 200, body: { ...base, items: this.empty ? [] : Array.from({ length: 30 }, (_, index) => ({ content_id: `movie:m${String(index + 2).padStart(4, "0")}`, type: "movie", title: `Movie ${String(index + 2).padStart(4, "0")}`, poster_url: `/art/movie-${index + 2}.svg` })), total: this.empty ? 0 : 30, total_exact: true } };
        }
        const personal = /^\/(watchlist|favorites|watched)\/([^/]+)(\/membership)?$/.exec(url.pathname);
        if (personal !== null) {
            const kind = personal[1];
            if (personal[2] === "series%3As1-S1" && kind !== "watched") return problem(404, "not_found", "Not found");
            if (method === "GET") return { status: 200, body: { item_id: decodeURIComponent(personal[2] ?? ""), is_member: kind === "favorites" ? this.favorite : this.watchlist } };
            this.mutations.push(`${method} ${url.pathname}`);
            if (this.mutationFailure !== undefined) { const failure = this.mutationFailure; this.mutationFailure = undefined; return failure; }
            if (kind === "favorites") this.favorite = method === "PUT";
            if (kind === "watchlist") this.watchlist = method === "PUT";
            if (kind === "watched") {
                const id = decodeURIComponent(personal[2] ?? "");
                const played = method === "POST";
                if (id === "movie:m0001") this.watched = played;
                for (const title of this.titles.values()) {
                    if (title.type === "episode" && (title.id === id || title.seriesId === id || `${title.seriesId}-S${title.season}` === id)) {
                        if (played) this.watchedEpisodes.add(title.id);
                        else this.watchedEpisodes.delete(title.id);
                        this.progress.delete(title.id);
                    }
                }
                this.progress.delete(id);
            }
            return { status: 204 };
        }
        const reply = super.route(method, path, profileId);
        if (reply?.status === 200 && url.pathname.endsWith("/episodes")) {
            const body = object(reply.body, "episodes");
            assert.ok(Array.isArray(body.items));
            return { ...reply, body: { ...body, items: body.items.map((value: unknown) => {
                const episode = object(value, "episode");
                return { ...episode, user_data: { played: this.watchedEpisodes.has(string(episode, "content_id", "episode")) } };
            }) } };
        }
        if (reply?.status === 200 && url.pathname.startsWith("/catalog/items/")) {
            const body = object(reply.body, "detail");
            const id = string(body, "content_id", "detail");
            const title = this.titles.get(id);
            const played = title?.type === "series" ? this.episodesPlayed(id) : title?.type === "episode" ? this.watchedEpisodes.has(id) : this.watched;
            reply.body = { ...body, user_state: { played }, user_data: this.neverPlayed.has(id) && !played ? undefined : { ...object(body.user_data, "user_data"), played } };
        }
        if (url.pathname === "/catalog/items/movie%3Am0001" && reply?.status === 200 && typeof reply.body === "object" && reply.body !== null) {
            return { status: 200, body: { ...reply.body,
                title: "The Last Signal", overview: "A remote observatory receives a message that changes the lives of everyone on the night shift.",
                backdrop_url: "/art/last-signal-backdrop.svg", logo_url: "/art/last-signal-logo.svg",
                cast: [{ person_id: "river", name: "River Vale", character: "Alex", order: 0, photo_url: "/art/river.svg" }, { name: "Morgan Lane", character: "Sam", order: 1 }],
                crew: [{ person_id: "river", name: "River Vale", job: "Director", photo_url: "/art/river.svg" }],
                ratings: [{ source: "imdb", name: "IMDb", score: 81, display: "8.1" }], studios: ["North Studio"], countries: ["AU"], original_language: "en",
                versions: [{ file_id: "long", duration: 5400, resolution: "2160p", codec_video: "hevc", codec_audio: "aac", hdr: true, edition_raw: "Original" }, { file_id: "short", duration: 1200, resolution: "1080p", codec_video: "h264", codec_audio: "aac", hdr: false, edition_raw: "Short cut" }],
                user_data: this.neverPlayed.has("movie:m0001") && !this.watched ? undefined : { played: this.watched, position_seconds: this.progress.get("movie:m0001"), last_file_id: "long" },
            } };
        }
        return reply;
    }

    private episodesPlayed(seriesId: string, season?: number): boolean {
        const episodes = [...this.titles.values()].filter((title) => title.type === "episode" && title.seriesId === seriesId && (season === undefined || title.season === season));
        return episodes.length > 0 && episodes.every((episode) => this.watchedEpisodes.has(episode.id));
    }
}
