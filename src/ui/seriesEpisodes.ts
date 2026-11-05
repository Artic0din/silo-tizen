import { operations } from "../api/operations.ts";
import type { Episode, Season } from "../contracts/v2/catalog.ts";
import type { NativeSession } from "../session/session.ts";

/** One accepted series visit owns its selected season and episode read. */
export class SeriesEpisodes {
    seasonNumber: number | undefined;
    episodes: readonly Episode[] | undefined;
    entryEpisode: string | undefined;
    failed = false;
    focusSelectedEpisode = false;
    private active = false;
    private loaded = false;
    private controller: AbortController | undefined;
    get loading(): boolean { return this.controller !== undefined; }
    private readonly session: NativeSession;
    private readonly seriesId: string;
    seasons: readonly Season[];
    private readonly changed: () => void;

    constructor(session: NativeSession, seriesId: string, seasons: readonly Season[], changed: () => void, preferredSeason?: number, preferredEpisode?: string) {
        this.session = session;
        this.seriesId = seriesId;
        this.seasons = seasons;
        this.changed = changed;
        this.entryEpisode = preferredEpisode;
        const regular = seasons.filter(season => !season.isSpecials && season.seasonNumber !== 0);
        const initial = seasons.find(season => season.seasonNumber === preferredSeason)
            ?? seasons.find(season => (season.userData?.inProgressCount ?? 0) > 0)
            ?? seasons.find(season => (season.userData?.watchedCount ?? 0) > 0 && (season.userData?.watchedCount ?? 0) < season.episodeCount)
            ?? regular.find(season => !season.userData?.played)
            ?? seasons.find(season => !season.userData?.played)
            ?? regular[0] ?? seasons[0];
        this.seasonNumber = initial?.seasonNumber;
    }

    start(): void {
        this.active = true;
        if (!this.loaded && this.controller === undefined && !this.failed) this.load(true);
    }

    restore(previous: SeriesEpisodes | undefined): void {
        if (previous !== undefined && previous.seasonNumber === this.seasonNumber) this.episodes = previous.episodes;
    }

    stop(): void {
        this.active = false;
        this.controller?.abort();
        this.controller = undefined;
    }

    select(season: number): void {
        if (!this.active || !this.seasons.some(item => item.seasonNumber === season)) return;
        if (season === this.seasonNumber && this.episodes !== undefined) {
            this.focusSelectedEpisode = true;
            this.entryEpisode = this.episodes[0]?.id;
            this.changed();
            return;
        }
        if (season === this.seasonNumber && this.controller !== undefined) {
            this.focusSelectedEpisode = true;
            this.entryEpisode = undefined;
            this.changed();
            return;
        }
        this.seasonNumber = season;
        this.focusSelectedEpisode = true;
        this.entryEpisode = undefined;
        this.load();
    }

    replace(season: number, episodes: readonly Episode[]): void {
        if (!this.active || this.seasonNumber !== season) return;
        this.controller?.abort();
        this.controller = undefined;
        this.episodes = episodes;
        this.loaded = true;
        this.failed = false;
        this.changed();
    }

    retry(): void { if (this.active && this.controller === undefined) this.load(true); }

    private load(retain = false): void {
        const season = this.seasonNumber;
        if (season === undefined || !this.active) return;
        this.controller?.abort();
        const controller = new AbortController();
        this.controller = controller;
        if (!retain) this.episodes = undefined;
        this.loaded = false;
        this.failed = false;
        this.changed();
        const current = (): boolean => this.active && this.controller === controller && !controller.signal.aborted;
        this.session.call({ ...operations.listSeasonEpisodes(this.seriesId, season), profileScoped: true, signal: controller.signal }).then(episodes => {
            if (!current()) return;
            this.controller = undefined;
            this.episodes = episodes;
            if (!episodes.some(episode => episode.id === this.entryEpisode)) this.entryEpisode = (this.focusSelectedEpisode ? episodes[0] : episodes.find(episode => episode.inProgress) ?? episodes.find(episode => !episode.played) ?? episodes[0])?.id;
            this.loaded = true;
            this.changed();
        }, () => {
            if (!current()) return;
            this.controller = undefined;
            this.failed = true;
            this.changed();
        });
    }
}
