import { FakeDetails } from "./fakeDetails.ts";
import { problem, type Reply } from "./fakeSilo.ts";

export interface CalendarFixtureEvent {
    readonly content_id: string;
    readonly type: string;
    readonly title: string;
    readonly air_date: string;
    readonly local_air_date: string;
    readonly watched: boolean;
    readonly badges: string[];
    readonly series_id?: string;
    readonly season_number?: number;
    readonly episode_number?: number;
    readonly episode_title?: string;
    readonly air_at?: string;
    readonly air_time?: string;
    readonly air_timezone?: string;
    readonly poster_url?: string;
}
export class FakeCalendar extends FakeDetails {
    readonly libraryMemberships = new Map<string, readonly string[]>();
    readonly restrictedProfiles = new Set(["p-kid"]);
    readonly favoriteIds = new Set(["movie:m0001"]);
    readonly watchlistIds = new Set(["series:s1"]);
    readonly trending = new Set(["series:s1", "movie:archived"]);
    events: CalendarFixtureEvent[] = Array.from({ length: 30 }, (_, i) => ({ content_id: `movie:m${String(i + 1).padStart(4, "0")}`, type: "movie", title: `Release ${i + 1}`, air_date: "2025-12-29", local_air_date: "2025-12-29", watched: false, badges: [], poster_url: `/art/release-${i + 1}` }));
    calendarFailure: Reply | undefined;
    constructor() {
        super();
        this.events.push(
            { content_id: "episode:s1e22", type: "episode", title: "Harbor Lights", series_id: "series:s1", season_number: 2, episode_number: 2, episode_title: "The Crossing", air_date: "2026-01-01", local_air_date: "2026-01-02", air_at: "2026-01-01T21:00:00Z", watched: true, badges: ["finale"] },
            { content_id: "season:s1:2", type: "season_premiere", title: "Harbor Lights", series_id: "series:s1", season_number: 2, air_date: "2026-01-03", local_air_date: "2026-01-03", watched: false, badges: ["season_premiere"] },
            { content_id: "movie:archived", type: "movie", title: "Archived Feature", air_date: "2026-01-01", local_air_date: "2026-01-01", watched: false, badges: [] },
            { content_id: "movie:k1", type: "movie", title: "Cartoon 1", air_date: "2026-01-01", local_air_date: "2026-01-01", watched: false, badges: [] },
        );
    }
    override route(method: string, path: string, profileId: string | undefined, body?: Record<string, unknown>): Reply | undefined {
        const url = new URL(path, "https://fake.invalid");
        if (url.pathname !== "/calendar") {
            const membership = /^\/(favorites|watchlist)\/([^/]+)(?:\/membership)?$/.exec(url.pathname);
            const ids = membership?.[1] === "favorites" ? this.favoriteIds : this.watchlistIds;
            const id = decodeURIComponent(membership?.[2] ?? "");
            if (membership !== null && method === "GET") return { status: 200, body: { item_id: id, is_member: ids.has(id) } };
            const reply = super.route(method, path, profileId, body);
            if (membership !== null && reply?.status === 204) { if (method === "PUT") ids.add(id); else ids.delete(id); }
            return reply;
        }
        if (this.calendarFailure !== undefined) return this.calendarFailure;
        const household = profileId === undefined ? undefined : this.households.get(profileId);
        if (household === undefined) return problem(422, "validation_failed", "Profile required");
        const start = url.searchParams.get("start") ?? "", end = url.searchParams.get("end") ?? "", filter = url.searchParams.get("filter");
        const groups = new Map<string, CalendarFixtureEvent[]>();
        for (const event of this.events) {
            const title = this.titles.get(event.content_id) ?? (event.series_id ? this.titles.get(event.series_id) : undefined);
            if (title === undefined) continue;
            const id = event.series_id ?? event.content_id;
            const memberships = this.libraryMemberships.get(id) ?? [title.libraryId];
            const hidden = (library: string): boolean => household.hidden?.includes(Number(library)) ?? false;
            const allowed = memberships.some(id => household.libraries.some(library => library.id === id) && !hidden(id));
            if (!allowed || (!this.restrictedProfiles.has(profileId ?? "") && memberships.some(hidden))) continue;
            const following = this.favoriteIds.has(id) || this.watchlistIds.has(id) || this.progress.has(id) || [...this.progress.keys()].some(key => this.titles.get(key)?.seriesId === id);
            if (filter === "following" && !following || filter === "trending" && !this.trending.has(id)) continue;
            if (event.local_air_date < start || event.local_air_date > end) continue;
            const events = groups.get(event.local_air_date) ?? [];
            events.push({ ...event, watched: event.type === "episode" ? this.watchedEpisodes.has(event.content_id) : event.content_id === "movie:m0001" ? this.watched : event.watched }); groups.set(event.local_air_date, events);
        }
        return { status: 200, body: { events: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, items]) => ({ date, items })) } };
    }
}
