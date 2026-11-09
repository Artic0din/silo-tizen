import { operations } from "../api/operations.ts";
import { ApiError } from "../api/errors.ts";
import type { Episode, Season } from "../contracts/v2/catalog.ts";
import type { NativeSession } from "../session/session.ts";
import { contiguousNeighborSeasons, episodeWindow, episodeWindowReachesSeriesStart, orderedEpisodeSeasons, retainEpisodePages } from "./episodeRail.ts";

const BOUNDARY_DWELL_MS = 70;
// TVSeriesDetailView.swift:780-793 at 7baff3ef.
const SEASON_DWELL_MS = 70;
type SeriesEpisodeUpdate = "load" | "focus" | "neighbor" | "translation";

/** One accepted series visit owns its selected season and episode read. */
export class SeriesEpisodes {
    seasonNumber: number | undefined;
    episodes: readonly Episode[] | undefined;
    railEpisodes: readonly Episode[] | undefined;
    private readonly failedNeighbors = new Set<number>();
    private readonly failedSelections = new Set<number>();
    /** Failures hidden while their retry runs. An aborted retry never resolved them, so they come back. */
    private readonly retryingNeighbors = new Set<number>();
    private readonly cancelledSeasons = new Set<number>();
    get interrupted(): boolean { return this.episodes === undefined && this.controller === undefined && this.seasonNumber !== undefined && !this.pendingNeighbors.has(this.seasonNumber) && this.cancelledSeasons.has(this.seasonNumber); }
    get boundaryFailed(): boolean { return [...this.failedNeighbors].some(number => !this.failedSelections.has(number) && number !== this.seasonNumber); }
    private readonly pages = new Map<number, readonly Episode[]>();
    /** Pages a fresh visit leaves out of the rail window. Reaching one again reuses it instead of the network. */
    private readonly parked = new Map<number, readonly Episode[]>();
    private neighbors: AbortController | undefined;
    private readonly pendingNeighbors = new Set<number>();
    private readonly requestedBoundaries = new Map<string, number>();
    private boundaryDwell: ReturnType<typeof setTimeout> | undefined;
    private seasonDwell: ReturnType<typeof setTimeout> | undefined;
    private automaticRead = false;
    private focusedSeason: number | undefined;
    entryEpisode: string | undefined;
    failed = false;
    private readonly transportFailures = new Set<number>();
    selectionChanged = false;
    focusSelectedEpisode = false;
    selectionOwnsHero = false;
    private active = false;
    private loaded = false;
    private controller: AbortController | undefined;
    get loading(): boolean { return this.controller !== undefined; }
    private readonly session: NativeSession;
    private readonly seriesId: string;
    seasons: readonly Season[];
    private readonly changed: (reason: SeriesEpisodeUpdate) => void;

    constructor(session: NativeSession, seriesId: string, seasons: readonly Season[], changed: (reason: SeriesEpisodeUpdate) => void, preferredSeason?: number, preferredEpisode?: string) {
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
        if (!this.loaded && this.controller === undefined && !this.failed && !this.interrupted) this.load(true, false, true);
        else this.restartPrefetch();
    }

    restore(previous: SeriesEpisodes | undefined, refresh = false, freshWindow = false): void {
        this.selectionChanged = refresh && previous?.selectionChanged === true;
        if (this.selectionChanged && previous !== undefined) {
            this.entryEpisode = previous.entryEpisode;
            this.selectionOwnsHero = previous.selectionOwnsHero;
            this.focusSelectedEpisode = previous.focusSelectedEpisode;
        }
        if (previous !== undefined && previous.seasonNumber === this.seasonNumber) {
            this.episodes = previous.episodes;
            if (!freshWindow) this.railEpisodes = previous.railEpisodes;
            for (const [number, page] of previous.pages) this.pages.set(number, page);
            for (const [number, page] of previous.parked) if (!this.pages.has(number)) this.parked.set(number, page);
            if (freshWindow) {
                this.keepFreshNeighborPages();
                this.updateWindow();
            }
            // Edge failures are not carried over: start() restarts the prefetch, which clears them (TVItemDetailView.swift:467,935).
            for (const number of previous.failedSelections) { this.failedSelections.add(number); this.failedNeighbors.add(number); }
            if (previous.seasonNumber !== undefined && (previous.failedNeighbors.has(previous.seasonNumber) || previous.retryingNeighbors.has(previous.seasonNumber))) this.failedNeighbors.add(previous.seasonNumber);
            for (const number of previous.cancelledSeasons) this.cancelledSeasons.add(number);
            this.loaded = !refresh && previous.loaded;
            for (const number of previous.transportFailures) this.transportFailures.add(number);
            this.failed = previous.failed && !(refresh && previous.seasonNumber !== undefined && previous.transportFailures.has(previous.seasonNumber));
        }
    }

    /**
     * A new Details visit keeps the selected season and the neighbor pages a
     * first open would warm. Seasons reached only by walking chips are dropped,
     * so reopening matches a later-season rail that has not loaded Season 1.
     */
    private keepFreshNeighborPages(): void {
        const selected = this.seasonNumber;
        if (selected === undefined || !this.pages.has(selected)) return;
        const order = orderedEpisodeSeasons(this.seasons);
        if (!order.includes(selected)) return;
        const keep = contiguousNeighborSeasons(order, selected, this.pages).add(selected);
        for (const [number, page] of this.pages) if (!keep.has(number)) { this.parked.set(number, page); this.pages.delete(number); }
    }

    private unpark(season: number): void {
        const page = this.parked.get(season);
        if (page === undefined || this.pages.has(season)) return;
        this.pages.set(season, page);
        this.parked.delete(season);
    }

    stop(): void {
        this.blurSeason();
        this.blur();
        this.active = false;
        this.controller?.abort();
        this.controller = undefined;
        this.neighbors?.abort();
        this.neighbors = undefined;
        this.pendingNeighbors.clear();
        for (const number of this.retryingNeighbors) this.failedNeighbors.add(number);
        this.retryingNeighbors.clear();
    }

    focusSeason(season: number): void {
        if (this.focusedSeason === season) return;
        this.blurSeason();
        this.focusedSeason = season;
        if (!this.active || season === this.seasonNumber) return;
        this.seasonDwell = setTimeout(() => {
            this.seasonDwell = undefined;
            this.select(season, true);
        }, SEASON_DWELL_MS);
    }

    blurSeason(): void {
        this.focusedSeason = undefined;
        clearTimeout(this.seasonDwell);
        this.seasonDwell = undefined;
        if (this.automaticRead) {
            if (this.seasonNumber !== undefined) this.cancelledSeasons.add(this.seasonNumber);
            this.controller?.abort();
            this.controller = undefined;
            this.automaticRead = false;
            this.failed = false;
            queueMicrotask(() => { if (this.active && this.interrupted && this.controller === undefined) this.changed("neighbor"); });
        }
    }

    select(season: number, automatic = false): void {
        clearTimeout(this.seasonDwell);
        if (!this.active || !this.seasons.some(item => item.seasonNumber === season)) return;
        this.selectionChanged = true;
        this.selectionOwnsHero = true;
        if (!automatic) this.automaticRead = false;
        if (season === this.seasonNumber && this.episodes !== undefined) {
            this.focusSelectedEpisode = true;
            this.entryEpisode = this.episodes[0]?.id;
            this.changed("load");
            return;
        }
        if (season === this.seasonNumber && (this.controller !== undefined || this.failed)) {
            this.focusSelectedEpisode = true;
            this.entryEpisode = undefined;
            this.changed("load");
            return;
        }
        this.seasonNumber = season;
        this.focusSelectedEpisode = true;
        this.entryEpisode = undefined;
        this.unpark(season);
        if (!automatic && !this.pages.has(season)) { this.load(); this.restartPrefetch(); return; }
        this.controller?.abort();
        this.controller = undefined;
        this.episodes = this.pages.get(season);
        this.failed = false;
        this.loaded = this.episodes !== undefined;
        if (this.episodes !== undefined) {
            this.entryEpisode = this.episodes[0]?.id;
            this.updateWindow();
            this.changed("load");
        } else if (this.pendingNeighbors.has(season)) {
            this.railEpisodes = [];
            this.changed("load");
        } else if (this.failedNeighbors.has(season)) {
            this.failedSelections.add(season);
            this.railEpisodes = [];
            this.failed = true;
            this.changed("load");
        } else {
            this.automaticRead = true;
            this.load(false, true);
        }
        this.restartPrefetch();
    }

    /**
     * TVItemDetailView.swift:467,935: a new selected season or a reappearing view restarts the prefetch.
     * It clears carouselLoadFailed and reads every missing neighbour, cache first. A selection, not a focus move.
     * Failures of a season the user selected stay; they belong to its own row.
     */
    private restartPrefetch(): void {
        let cleared = false;
        for (const number of new Set([...this.failedNeighbors, ...this.retryingNeighbors])) {
            if (number === this.seasonNumber || this.failedSelections.has(number)) continue;
            this.failedNeighbors.delete(number);
            this.retryingNeighbors.delete(number);
            cleared = true;
        }
        if (cleared) this.changed("neighbor");
        // Apple cancels the previous prefetch task, so its late failure cannot show. The selected season's own in-flight read must survive: select() is waiting on it.
        if (this.seasonNumber === undefined || !this.pendingNeighbors.has(this.seasonNumber)) {
            this.neighbors?.abort();
            this.neighbors = undefined;
            this.pendingNeighbors.clear();
        }
        this.warmNeighbors();
    }

    replace(season: number, episodes: readonly Episode[]): void {
        if (!this.active || this.seasonNumber !== season) return;
        this.transportFailures.delete(season);
        this.blur();
        this.requestedBoundaries.clear();
        this.failedNeighbors.clear();
        this.failedSelections.clear();
        this.cancelledSeasons.delete(season);
        this.controller?.abort();
        this.controller = undefined;
        this.neighbors?.abort();
        this.neighbors = undefined;
        this.pendingNeighbors.clear();
        this.retryingNeighbors.clear();
        this.episodes = episodes;
        this.pages.clear();
        this.pages.set(season, episodes);
        this.updateWindow();
        this.loaded = true;
        this.failed = false;
        this.changed("load");
        this.warmNeighbors();
    }

    publishTranslatedEpisodes(season: number, episodes: readonly Episode[]): void {
        if (!this.active || this.seasonNumber !== season) return;
        this.cancelledSeasons.delete(season);
        this.episodes = episodes;
        this.pages.set(season, episodes);
        this.updateWindow();
        this.changed("translation");
    }

    retry(): void { if (this.active && this.controller === undefined) this.load(true); }

    private load(retain = false, automatic = false, warm = false): void {
        const season = this.seasonNumber;
        if (season === undefined || !this.active) return;
        this.automaticRead = automatic;
        this.blur();
        if (!automatic) {
            this.requestedBoundaries.clear();
            this.failedNeighbors.delete(season);
            this.cancelledSeasons.delete(season);
        }
        this.controller?.abort();
        this.neighbors?.abort();
        this.neighbors = undefined;
        this.pendingNeighbors.clear();
        for (const number of this.retryingNeighbors) if (number !== season) this.failedNeighbors.add(number);
        this.retryingNeighbors.clear();
        const controller = new AbortController();
        this.controller = controller;
        if (!retain) { this.episodes = undefined; this.railEpisodes = undefined; }
        this.loaded = false;
        this.failed = retain && this.failed;
        this.changed("load");
        const current = (): boolean => this.active && this.controller === controller && !controller.signal.aborted;
        this.session.call({ ...operations.listSeasonEpisodes(this.seriesId, season), retry: "never", profileScoped: true, signal: controller.signal }).then(episodes => {
            if (!current()) return;
            this.controller = undefined;
            this.automaticRead = false;
            this.failed = false;
            this.transportFailures.delete(season);
            this.episodes = episodes;
            this.failedSelections.delete(season);
            this.cancelledSeasons.delete(season);
            this.pages.set(season, episodes);
            this.updateWindow();
            if (!episodes.some(episode => episode.id === this.entryEpisode)) this.entryEpisode = (this.focusSelectedEpisode ? episodes[0] : episodes.find(episode => episode.inProgress) ?? episodes.find(episode => !episode.played) ?? episodes[0])?.id;
            this.loaded = true;
            this.changed("load");
            if (warm) this.warmNeighbors();
        }, (error: unknown) => {
            if (!current()) return;
            if (!this.pages.has(season)) this.failedNeighbors.add(season);
            this.cancelledSeasons.delete(season);
            this.controller = undefined;
            this.automaticRead = false;
            this.failed = true;
            this.recordFailure(season, error);
            this.failedSelections.add(season);
            this.changed("load");
        });
    }

    private recordFailure(season: number, error: unknown): void {
        if (error instanceof ApiError && !error.aborted && ["network", "timeout"].includes(error.failure.kind)) this.transportFailures.add(season);
        else this.transportFailures.delete(season);
    }

    focus(id: string): void {
        this.blur();
        if (!this.active || this.focusedSeason !== undefined) return;
        this.selectionOwnsHero = false;
        const episodes = this.railEpisodes ?? [];
        const index = episodes.findIndex(episode => episode.id === id);
        if (index < 0) return;
        const episode = episodes[index]!;
        if (episode.seasonNumber !== this.seasonNumber) {
            this.controller?.abort();
            this.controller = undefined;
            this.seasonNumber = episode.seasonNumber;
            this.selectionChanged = true;
            this.episodes = this.pages.get(episode.seasonNumber);
            this.focusSelectedEpisode = false;
            this.changed("focus");
        }
        // Only the outer loaded edge needs another page; a cached-season crossing does not.
        const direction = index === 0 ? -1 : index === episodes.length - 1 ? 1 : 0;
        if (direction === 0) return;
        const boundary = `${id}:${direction}`;
        const requested = this.requestedBoundaries.get(boundary);
        if (requested !== undefined && (this.pages.has(requested) || this.pendingNeighbors.has(requested) || this.failedSelections.has(requested))) return;
        const order = orderedEpisodeSeasons(this.seasons);
        let neighbor = order.indexOf(episode.seasonNumber) + direction;
        while (neighbor >= 0 && neighbor < order.length && this.pages.has(order[neighbor]!)) neighbor += direction;
        const number = order[neighbor];
        if (number === undefined || this.failedSelections.has(number) || this.pendingNeighbors.has(number)) return;
        this.boundaryDwell = setTimeout(() => {
            this.boundaryDwell = undefined;
            // Restored focus after an empty page must not walk through further seasons.
            this.requestedBoundaries.set(boundary, number);
            // TVItemDetailView.swift:301-305: reaching a boundary after a failed prefetch re-runs the whole prefetch.
            for (const edge of this.windowEdges()) if (this.failedNeighbors.has(edge) && !this.failedSelections.has(edge)) void this.readNeighbor(edge, true);
            void this.readNeighbor(number, true);
            this.changed("neighbor");
        }, BOUNDARY_DWELL_MS);
    }

    /** The first unloaded season beyond each end of the loaded run: what Apple's two-sided prefetch walks to. */
    private windowEdges(): number[] {
        const order = orderedEpisodeSeasons(this.seasons);
        const edges: number[] = [];
        for (const direction of [-1, 1]) {
            let index = order.indexOf(this.seasonNumber ?? -1);
            if (index < 0) continue;
            while (order[index + direction] !== undefined && this.pages.has(order[index + direction]!)) index += direction;
            const edge = order[index + direction];
            if (edge !== undefined) edges.push(edge);
        }
        return edges;
    }

    blur(): void {
        clearTimeout(this.boundaryDwell);
        this.boundaryDwell = undefined;
    }

    /** The painted rail's loaded run includes this series' first season. */
    get windowReachesSeriesStart(): boolean {
        return episodeWindowReachesSeriesStart(orderedEpisodeSeasons(this.seasons), this.seasonNumber, this.pages);
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
        const order = orderedEpisodeSeasons(this.seasons);
        const seen = new Set((this.pages.get(season) ?? []).map(episode => episode.id));
        const run = async (): Promise<void> => {
            let count = 0;
            for (let index = order.indexOf(season) + direction; index >= 0 && index < order.length && count < 8; index += direction) {
                const number = order[index]!;
                if (!this.active || this.pendingNeighbors.has(number) || this.failedNeighbors.has(number)) return;
                let page = this.pages.get(number);
                if (page === undefined) {
                    page = await this.readNeighbor(number);
                    if (page === undefined) return;
                }
                for (const episode of page) if (!seen.has(episode.id)) { seen.add(episode.id); count++; }
            }
        };
        void run();
    }

    private async readNeighbor(number: number, retry = false): Promise<readonly Episode[] | undefined> {
        if (!this.active || this.pages.has(number) || this.pendingNeighbors.has(number) || (!retry && this.failedNeighbors.has(number))) return;
        this.neighbors ??= new AbortController();
        const controller = this.neighbors;
        this.pendingNeighbors.add(number);
        // TVItemDetailView.swift:935: a prefetch clears carouselLoadFailed when it starts; a failure sets it again.
        if (retry && this.failedNeighbors.delete(number)) this.retryingNeighbors.add(number);
        try {
            const page = this.parked.get(number) ?? await this.session.call({ ...operations.listSeasonEpisodes(this.seriesId, number), retry: "never", profileScoped: true, signal: controller.signal });
            this.parked.delete(number);
            if (!this.active || controller.signal.aborted) return;
            this.failedNeighbors.delete(number);
            this.transportFailures.delete(number);
            this.failedSelections.delete(number);
            this.cancelledSeasons.delete(number);
            this.pages.set(number, page);
            if (this.seasonNumber === number && this.episodes === undefined) {
                this.failed = false;
                this.episodes = page;
                this.entryEpisode = page[0]?.id;
                this.loaded = true;
                this.updateWindow();
                this.changed("load");
                return page;
            }
            this.updateWindow();
            this.changed("neighbor");
            return page;
        } catch (error: unknown) {
            if (!controller.signal.aborted) {
                this.recordFailure(number, error);
                this.failedNeighbors.add(number);
                this.cancelledSeasons.delete(number);
                if (this.seasonNumber === number && this.episodes === undefined) {
                    this.failed = true;
                    this.failedSelections.add(number);
                    this.changed("load");
                } else this.changed("neighbor");
            }
            return;
        } finally { if (!controller.signal.aborted) { this.pendingNeighbors.delete(number); this.retryingNeighbors.delete(number); } }
    }
}
