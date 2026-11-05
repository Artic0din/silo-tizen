import { operations } from "../api/operations.ts";
import type { Episode, Season } from "../contracts/v2/catalog.ts";
import type { NativeSession } from "../session/session.ts";
import { episodeWindow, orderedEpisodeSeasons, retainEpisodePages } from "./episodeRail.ts";

/** One accepted series visit owns its selected season and episode read. */
export class SeriesEpisodes {
    seasonNumber: number | undefined;
    episodes: readonly Episode[] | undefined;
    railEpisodes: readonly Episode[] | undefined;
    private readonly failedNeighbors = new Set<number>();
    get boundaryFailed(): boolean { return this.failedNeighbors.size > 0; }
    private readonly pages = new Map<number, readonly Episode[]>();
    private neighbors: AbortController | undefined;
    private readonly pendingNeighbors = new Set<number>();
    entryEpisode: string | undefined;
    failed = false;
    focusSelectedEpisode = false;
    private active = false;
    private loaded = false;
    private controller: AbortController | undefined;
    get loading(): boolean { return this.controller !== undefined; }
    private readonly session: NativeSession;
    private readonly seriesId: string;
    readonly seasons: readonly Season[];
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
        else if (this.loaded) this.warmNeighbors();
    }

    restore(previous: SeriesEpisodes | undefined): void {
        if (previous !== undefined && previous.seasonNumber === this.seasonNumber) {
            this.episodes = previous.episodes;
            this.railEpisodes = previous.railEpisodes;
            for (const [number, page] of previous.pages) this.pages.set(number, page);
        }
    }

    stop(): void {
        this.active = false;
        this.controller?.abort();
        this.controller = undefined;
        this.neighbors?.abort();
        this.neighbors = undefined;
        this.pendingNeighbors.clear();
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
        this.failedNeighbors.clear();
        this.controller?.abort();
        this.controller = undefined;
        this.neighbors?.abort();
        this.neighbors = undefined;
        this.pendingNeighbors.clear();
        this.episodes = episodes;
        this.pages.clear();
        this.pages.set(season, episodes);
        this.updateWindow();
        this.loaded = true;
        this.failed = false;
        this.changed();
        this.warmNeighbors();
    }

    retry(): void { if (this.active && this.controller === undefined) this.load(true); }

    private load(retain = false): void {
        const season = this.seasonNumber;
        if (season === undefined || !this.active) return;
        this.failedNeighbors.clear();
        this.controller?.abort();
        this.neighbors?.abort();
        this.neighbors = undefined;
        this.pendingNeighbors.clear();
        const controller = new AbortController();
        this.controller = controller;
        if (!retain) { this.episodes = undefined; this.railEpisodes = undefined; }
        this.loaded = false;
        this.failed = false;
        this.changed();
        const current = (): boolean => this.active && this.controller === controller && !controller.signal.aborted;
        this.session.call({ ...operations.listSeasonEpisodes(this.seriesId, season), profileScoped: true, signal: controller.signal }).then(episodes => {
            if (!current()) return;
            this.controller = undefined;
            this.episodes = episodes;
            this.pages.set(season, episodes);
            this.updateWindow();
            if (!episodes.some(episode => episode.id === this.entryEpisode)) this.entryEpisode = (this.focusSelectedEpisode ? episodes[0] : episodes.find(episode => episode.inProgress) ?? episodes.find(episode => !episode.played) ?? episodes[0])?.id;
            this.loaded = true;
            this.changed();
            this.warmNeighbors();
        }, () => {
            if (!current()) return;
            this.controller = undefined;
            this.failed = true;
            this.changed();
        });
    }

    focus(id: string): void {
        const episodes = this.railEpisodes ?? [];
        const index = episodes.findIndex(episode => episode.id === id);
        if (index < 0) return;
        const episode = episodes[index]!;
        if (episode.seasonNumber !== this.seasonNumber) {
            this.failedNeighbors.clear();
            this.controller?.abort();
            this.controller = undefined;
            this.neighbors?.abort();
            this.neighbors = undefined;
            this.pendingNeighbors.clear();
            this.seasonNumber = episode.seasonNumber;
            this.episodes = this.pages.get(episode.seasonNumber);
            this.focusSelectedEpisode = false;
            this.changed();
            this.warmNeighbors();
        } else if (this.boundaryFailed && (index === 0 || index === episodes.length - 1)) this.warmNeighbors();
    }

    private updateWindow(): void {
        const order = orderedEpisodeSeasons(this.seasons);
        if (this.seasonNumber !== undefined) retainEpisodePages(order, this.seasonNumber, this.pages);
        this.railEpisodes = episodeWindow(order, this.seasonNumber, this.pages);
    }

    private warmNeighbors(): void {
        if (this.seasonNumber === undefined) return;
        this.loadNeighbor(-1, this.seasonNumber);
        this.loadNeighbor(1, this.seasonNumber);
    }

    private loadNeighbor(direction: number, season: number): void {
        if (!this.active) return;
        this.neighbors ??= new AbortController();
        const controller = this.neighbors;
        const order = orderedEpisodeSeasons(this.seasons);
        const seen = new Set((this.pages.get(season) ?? []).map(episode => episode.id));
        const run = async (): Promise<void> => {
            let count = 0;
            for (let index = order.indexOf(season) + direction; index >= 0 && index < order.length && count < 8; index += direction) {
                const number = order[index]!;
                if (!this.active || controller.signal.aborted || this.pendingNeighbors.has(number)) return;
                let page = this.pages.get(number);
                if (page === undefined) {
                    this.pendingNeighbors.add(number);
                    try {
                        page = await this.session.call({ ...operations.listSeasonEpisodes(this.seriesId, number), profileScoped: true, signal: controller.signal });
                        if (!this.active || controller.signal.aborted) return;
                        this.pages.set(number, page);
                        this.failedNeighbors.delete(number);
                        this.updateWindow();
                        this.changed();
                    } catch {
                        if (!controller.signal.aborted) { this.failedNeighbors.add(number); this.changed(); }
                        return;
                    } finally { if (!controller.signal.aborted) this.pendingNeighbors.delete(number); }
                }
                for (const episode of page) if (!seen.has(episode.id)) { seen.add(episode.id); count++; }
            }
        };
        void run();
    }
}
