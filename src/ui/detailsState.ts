// Optional Details reads and explicit personal writes. The route owns and stops this work.
import { ApiError } from "../api/errors.ts";
import { shufflePick } from "../player/nextShuffle.ts";
import type { RequestSpec } from "../api/http.ts";
import { detailOperations, RELATED_LIMIT, type PersonalAction } from "../api/detailOperations.ts";
import { operations } from "../api/operations.ts";
import type { Card, ItemDetail, LocalExtra } from "../contracts/v2/catalog.ts";
import { TITLE_ART_KEY } from "../contracts/v2/settings.ts";
import { playChoices, type PlayRequest } from "./browseModel.ts";
import type { Clock } from "../api/clock.ts";
import type { NativeSession } from "../session/session.ts";
import { readSettingsCapability, readTitleArt } from "./presentationSettings.ts";
import { ADVISORY_KEY } from "../contracts/v2/settingsRows.ts";
import type { SubtitleIntent } from "../contracts/v2/preplaySubtitles.ts";
import { SeriesEpisodes } from "./seriesEpisodes.ts";
import { freshPlayPosition } from "./playbackPreparation.ts";
import { PreplayAudioPreference } from "./preplayAudioPreference.ts";
import { PreplayTrackPreference } from "./preplayTrackPreference.ts";
import { subtitlePreferenceOperations, type SubtitlePreferencePick, type SubtitlePreference } from "../api/subtitlePreferenceOperations.ts";
import { matchesSubtitle, preferredCatalogSubtitle } from "../player/preplaySubtitles.ts";
import { DescriptionTranslations, type ItemDescriptionTranslation } from "./descriptionTranslation.ts";
import { TrailerFetch } from "./trailerFetch.ts";

/** A failure Apple TV presents as a system alert with one OK button. */
export interface DetailsAlert {
    readonly id: string;
    readonly title: string;
    readonly message: string;
    /** A write the server never answered; the alert also offers Discard Held Change. */
    readonly held?: PersonalAction;
}

/** PersonalStateNotice.failed(nil) (silo-apple Components/MediaActionFeedback.swift). */
const ITEM_UPDATE_FAILED: DetailsAlert = { id: "details-update-failed", title: "Couldn't Update Item", message: "Your change wasn't saved. Please try again." };
/** PersonalStateNotice.held: the write may have landed without an answer, so it is never re-sent from here. */
const HELD_MESSAGE = "Silo sent this change but the server didn't answer, so it won't be sent again. Discard the held change to reload this item and try again.";
/** TVSeriesDetailView's season watched alert (detail.watchedError). */
const SEASON_WATCHED_FAILED: DetailsAlert = { id: "details-season-watched-failed", title: "Couldn't Update Watched Status", message: "Please check your connection and try again." };
/** ShuffleLauncher.failureMessage under the shuffle.failedTitle alert. */
function shuffleFailure(error: unknown): DetailsAlert {
    // ShuffleError.classify reads Problem Details only.
    const failure = error instanceof ApiError ? error.failure : undefined;
    const status = failure?.kind === "problem" ? failure.problem.status : undefined;
    const message = status === 409 ? "Nothing here can be played." : status === 404 ? "This is no longer available to shuffle." : "Couldn't start the shuffle. Try again.";
    return { id: "details-shuffle-failed", title: "Couldn't Shuffle", message };
}

export interface PersonalChange {
    readonly target: boolean;
    readonly pending: boolean;
    readonly failed: boolean;
}

const EPISODE_PREFETCH_CONCURRENCY = 4;
const EPISODE_OWNER_CACHE_LIMIT = 16;
// TVItemDetailView.swift:835-841 at df891d2e.
const EPISODE_FOCUS_DWELL_MS = 120;

export class DetailsState {
    readonly trailers: TrailerFetch;
    showAdvisoryAge = false;
    /** The stored resolution cap that ranks versions, read from the profile's cache so the first paint is already ranked. */
    get preferredQuality(): string | undefined { return this.quality(); }
    readonly descriptions: ItemDescriptionTranslation | undefined;
    readonly audioPreference: PreplayAudioPreference;
    readonly subtitlePreference: PreplayTrackPreference<SubtitlePreferencePick, SubtitlePreference>;
    series: SeriesEpisodes | undefined;
    detail: ItemDetail;
    selectedFileId: string | undefined;
    panel: "audio" | "version" | "subtitles" | "more" | undefined;
    get audioOpen(): boolean { return this.panel === "audio"; }
    preparingPlay = false;
    failedPlay: PlayRequest | undefined;
    nextEpisode: ItemDetail | undefined;
    nextEpisodeState: DetailsState | undefined;
    private previousNextEpisodeState: DetailsState | undefined;
    focusedEpisodeId: string | undefined;
    private readonly episodeStates = new Map<string, DetailsState>();
    private readonly previousEpisodeStates = new Map<string, DetailsState>();
    private readonly episodeReads = new Set<string>();
    private readonly episodeFailures = new Set<string>();
    private readonly episodeRefusals = new Set<string>();
    private readonly episodeQueue: string[] = [];
    private episodeWorkers = 0;
    private episodeFocusDwell: ReturnType<typeof setTimeout> | undefined;
    private queuedFocusEpisode: string | undefined;
    private episodeFocusOwner: string | undefined;
    private episodeEpoch = 0;
    private episodeController: AbortController | undefined;
    private pendingEpisodePanel: { id: string; panel: "audio" | "subtitles" | "version" } | undefined;
    private episodePreferenceDirty = false;
    private episodePreferenceSource: string | undefined;
    get unsettledEpisode(): DetailsState | undefined {
        return [...this.episodeStates.values(), ...this.previousEpisodeStates.values()].find(state => state.audioPreference.pending || state.audioPreference.failed || state.subtitlePreference.pending || state.subtitlePreference.failed);
    }
    get episodePreferencesBlocked(): boolean { return this.unsettledEpisode !== undefined; }
    get playbackTargetId(): string | undefined {
        const episodes = this.series?.episodes;
        if (this.series?.selectionOwnsHero) return episodes?.[0]?.id;
        return this.focusedEpisodeId ?? (episodes?.find(episode => episode.inProgress) ?? episodes?.find(episode => !episode.played) ?? episodes?.[0])?.id ?? this.detail.playContentId;
    }
    get heroEpisodeId(): string | undefined { return this.series?.selectionOwnsHero ? this.series.episodes?.[0]?.id : this.focusedEpisodeId; }
    nextEpisodeLoading = false;
    nextEpisodeFailed = false;
    extraPending: string | undefined;
    extraFailed: string | undefined;
    shuffleSupported = false;
    shuffleSeasonSupported = false;
    shuffleStarting = false;
    /** The failure on screen as an alert, until OK or Back dismisses it. */
    alert: DetailsAlert | undefined;
    private full = false;
    private restored = false;
    private readonly responses = new Map<string, unknown>();
    offline = false;
    private audioPick: { fileId: string; ordinal: number; inventory: string } | undefined;
    private audioAuto = false;
    private subtitlePick: { fileId: string; inventory: string; intent: SubtitleIntent } | undefined;
    private subtitleAuto = false;
    related: readonly Card[] | undefined;
    relatedFailed = false;
    personalSupported: boolean | undefined;
    personalFailed = false;
    titleArtPolicy: "pending" | "supported" | "compatibility" | "failed" = "pending";
    titleArt: boolean | undefined;
    readonly values = new Map<PersonalAction, boolean>();
    readonly changes = new Map<PersonalAction, PersonalChange>();
    private controller: AbortController | undefined;
    private stopAuthority: (() => void) | undefined;
    private readonly session: NativeSession;
    private readonly changed: (returnKey?: string) => void;
    private readonly watchedChanged: (detail: ItemDetail, signal: AbortSignal) => Promise<void>;
    private readonly pendingElsewhere: () => boolean;
    private readonly quality: () => string | undefined;
    private readonly capReady: (signal: AbortSignal) => Promise<void>;

    constructor(detail: ItemDetail, session: NativeSession, changed: (returnKey?: string) => void, watchedChanged: (detail: ItemDetail, signal: AbortSignal) => Promise<void>, pendingElsewhere: () => boolean = () => false, translations?: DescriptionTranslations, quality: () => string | undefined = () => undefined, capReady: (signal: AbortSignal) => Promise<void> = async () => undefined) {
        this.detail = detail;
        this.quality = quality;
        this.capReady = capReady;
        this.session = session;
        this.trailers = new TrailerFetch(
            signal => session.call({ ...detailOperations.refreshTrailers(detail.id), profileScoped: true, replayAfterRefresh: false, signal }),
            signal => session.call({ ...operations.getCatalogItem(detail.id), profileScoped: true, signal }),
            found => { this.detail = { ...found, played: this.detail.played, watch: this.detail.watch }; },
            () => this.changed(),
        );
        this.descriptions = translations?.open({
            detail: () => this.detail,
            season: () => {
                const series = this.series;
                const number = series?.seasonNumber;
                if (series === undefined || number === undefined) return undefined;
                const season = series.seasons.find((item) => item.seasonNumber === number);
                return season === undefined ? undefined : { id: season.id, number };
            },
            episodes: () => this.series?.episodes,
            seriesId: () => this.detail.type === "series" ? this.detail.id : undefined,
            replaceDetail: (next) => {
                if (this.controller === undefined || this.controller.signal.aborted || next.id !== this.detail.id) return true;
                this.detail = next;
                this.changed();
                return next.pendingTranslationLanguage === undefined;
            },
            replaceEpisodes: (season, episodes) => {
                const series = this.series;
                if (series === undefined || series.seasonNumber !== season) return true;
                series.publishTranslatedEpisodes(season, episodes);
                return !episodes.some((episode) => episode.pendingTranslationLanguage !== undefined);
            },
            changed: () => this.changed(),
        });
        this.changed = changed;
        this.watchedChanged = watchedChanged;
        this.pendingElsewhere = pendingElsewhere;
        this.audioPreference = new PreplayAudioPreference(session, detail.seriesId || detail.id, () => this.changed(), async signal => {
            const refreshed = await session.call({ ...operations.getCatalogItem(detail.id), profileScoped: true, signal });
            if (refreshed.id !== detail.id) throw new Error("Audio readback item mismatch");
            if (signal.aborted) return;
            this.detail = refreshed;
            this.audioTrackId();
        });
        this.subtitlePreference = new PreplayTrackPreference(subtitlePreferenceOperations, session, detail.seriesId || detail.id, () => this.changed(), async signal => {
            const refreshed = await session.call({ ...operations.getCatalogItem(detail.id), profileScoped: true, signal });
            if (refreshed.id !== detail.id) throw new Error("Subtitle readback item mismatch");
            if (signal.aborted) return;
            this.detail = refreshed;
            this.subtitleIntent();
        });
        if (detail.played !== undefined && ["movie", "episode", "series", "season"].includes(detail.type)) this.values.set("watched", detail.played);
    }

    get pending(): boolean { return [...this.changes.values()].some(change => change.pending) || [...this.seasonStates.values()].some(state => state.pending); }
    readonly seasonStates = new Map<number, DetailsState>();
    private aggregateWatched: boolean | undefined;
    get busy(): boolean { return this.pending || this.pendingElsewhere() || this.episodePreferencesBlocked; }

    acceptDetail(detail: ItemDetail): void {
        const retrySupporting = this.offline;
        this.offline = false;
        const changedTarget = this.detail.playContentId !== detail.playContentId;
        this.detail = detail;
        if (!detail.versions.some(file => file.fileId === this.selectedFileId)) this.selectedFileId = undefined;
        this.invalidateEpisodes();
        if (changedTarget) {
            this.nextEpisode = undefined;
            this.nextEpisodeLoading = false;
            this.nextEpisodeFailed = false;
        }
        if (changedTarget || this.nextEpisodeFailed || retrySupporting) this.loadNextEpisode();
        this.warmSeriesEpisodes();
        this.descriptions?.consider();
        if (this.controller === undefined || !this.full) return;
        if (this.personalFailed || retrySupporting) this.loadPersonal();
        if (this.relatedFailed || retrySupporting) this.loadRelated();
        if (this.titleArtPolicy === "failed" || retrySupporting) this.loadTitleArt();
        if (retrySupporting) this.loadSupportingPreferences();
    }

    start(mode: "full" | "personal" | "playback" = "full"): void {
        if (this.controller !== undefined) return;
        this.controller = new AbortController();
        for (const state of this.seasonStates.values()) state.start("personal");
        if (["movie", "episode"].includes(this.detail.type)) this.audioPreference.start();
        if (["movie", "episode"].includes(this.detail.type)) this.subtitlePreference.start();
        this.full = mode === "full";
        if (this.full && this.episodePreferenceDirty) this.episodePreferenceChanged(this);
        // Clear trailer resume before stop() so a later trailers.stop() cannot mark it resumable.
        this.stopAuthority = this.session.onAuthorityChange(() => { this.trailers.stop(false); this.stop(); this.changed(); });
        if (mode === "full") this.trailers.resume();
        if (mode === "playback") return;
        this.nextEpisodeState?.start("playback");
        for (const state of this.episodeStates.values()) state.start("playback");
        for (const [id, state] of this.previousEpisodeStates) if (state.audioPreference.failed || state.subtitlePreference.failed) this.queueEpisode(id);
        if (mode === "full") this.series?.start();
        if (mode === "full") this.warmSeriesEpisodes();
        if (mode === "full") this.loadTitleArt();
        if (mode === "full") this.loadSupportingPreferences();
        if (mode === "full" && (this.nextEpisode === undefined || this.restored) && !this.nextEpisodeFailed) this.loadNextEpisode();
        let interrupted = false;
        for (const [kind, change] of this.changes) {
            if (change.pending) {
                this.changes.set(kind, { ...change, pending: false, failed: true });
                interrupted = true;
            }
        }
        if (interrupted) this.changed();
        if (mode === "full" && (this.related === undefined || this.restored)) this.loadRelated();
        if (this.personalSupported === undefined || (this.restored && this.changes.size === 0)) this.loadPersonal();
        this.restored = false;
        if (this.full && this.controller !== undefined) this.descriptions?.attach(this.controller.signal);
    }

    private loadSupportingPreferences(): void {
        const controller = this.controller;
        if (controller === undefined) return;
        void this.read(operations.effectiveSettings([ADVISORY_KEY]), controller).then(values => {
            if (!this.current(controller)) return;
            this.showAdvisoryAge = values.get(ADVISORY_KEY)?.value === true;
            this.changed();
        }, () => { /* Missing advisory preferences keep the optional badge hidden. */ });
        if (this.detail.type !== "series") return;
        void this.read(operations.shuffleCapabilities(), controller).then(capability => {
            if (!this.current(controller)) return;
            this.shuffleSupported = capability.usable && capability.scopeKinds.includes("series");
            this.shuffleSeasonSupported = capability.usable && capability.scopeKinds.includes("season");
            this.changed();
        }, () => undefined);
    }

    stop(): void {
        this.cancelEpisodeFocus();
        for (const [kind, change] of this.changes) {
            if (change.pending) this.changes.set(kind, { ...change, pending: false, failed: true });
        }
        this.trailers.stop();
        this.pendingEpisodePanel = undefined;
        this.shuffleStarting = false;
        this.alert = undefined;
        for (const state of this.seasonStates.values()) state.stop();
        this.descriptions?.stop();
        this.extraPending = undefined;
        this.episodeEpoch++;
        this.episodeController?.abort();
        this.episodeController = undefined;
        this.nextEpisodeState?.stop();
        for (const state of this.episodeStates.values()) state.stop();
        this.episodeReads.clear();
        this.episodeQueue.length = 0;
        this.episodeWorkers = 0;
        this.audioPreference.stop();
        this.subtitlePreference.stop();
        this.series?.stop();
        this.controller?.abort();
        this.controller = undefined;
        this.stopAuthority?.();
        this.stopAuthority = undefined;
        this.panel = undefined;
        this.preparingPlay = false;
        this.nextEpisodeLoading = false;
    }

    /** Capture the route generation as well as the confirmed policy for late image events. */
    acceptTitleArt(value: boolean): void {
        this.titleArt = value;
        this.titleArtPolicy = "supported";
        for (const path of this.responses.keys()) if (path.includes(TITLE_ART_KEY)) this.responses.delete(path);
    }

    titleArtGuard(): () => boolean {
        const controller = this.controller;
        return () => controller !== undefined && this.current(controller) && (this.titleArtPolicy === "compatibility" || (this.titleArtPolicy === "supported" && this.titleArt === true));
    }

    loadTitleArt(): void {
        const controller = this.controller;
        if (controller === undefined) return;
        if (this.titleArtPolicy === "failed") this.titleArtPolicy = "pending";
        this.changed();
        const run = async (): Promise<void> => {
            const read = <T>(spec: RequestSpec<T>): Promise<T> => this.read(spec, controller);
            const answer = await readTitleArt(read, this.session, await readSettingsCapability(read));
            if (!this.current(controller) || answer === undefined) return;
            if (answer === "compatibility") { this.titleArtPolicy = "compatibility"; return; }
            this.titleArt = answer;
            this.titleArtPolicy = "supported";
        };
        run().then(() => { if (this.current(controller)) this.changed(); }, (error: unknown) => {
            if (!this.current(controller)) return;
            const transport = error instanceof ApiError && ["network", "timeout"].includes(error.failure.kind);
            if (!transport || !["compatibility", "supported"].includes(this.titleArtPolicy)) this.titleArtPolicy = "failed";
            this.changed();
        });
    }

    select(fileId: string | undefined): void {
        if (fileId !== undefined && !this.detail.versions.some((file) => file.fileId === fileId)) return;
        if (fileId !== playChoices(this.detail, this.selectedFileId, this.preferredQuality)?.fromStart.fileId) this.audioPick = undefined;
        this.selectedFileId = fileId;
        this.changed();
    }

    restore(previous: DetailsState | undefined): void {
        if (previous === undefined) return;
        this.restored = true;
        this.titleArt = previous.titleArt;
        this.titleArtPolicy = previous.titleArtPolicy;
        for (const [key, value] of previous.responses) this.responses.set(key, value);
        this.related = previous.related;
        this.nextEpisode = previous.nextEpisode?.id === this.detail.playContentId ? previous.nextEpisode : undefined;
        this.personalSupported = previous.personalSupported;
        for (const [key, value] of previous.values) if (key !== "watched") this.values.set(key, value);
        if (this.detail.id === previous.detail.id) this.trailers.restore(previous.trailers);
        if (this.detail.versions.some(file => file.fileId === previous.failedPlay?.fileId)) this.failedPlay = previous.failedPlay;
        this.previousNextEpisodeState = previous.nextEpisodeState;
        this.focusedEpisodeId = previous.focusedEpisodeId;
        this.episodePreferenceDirty = previous.episodePreferenceDirty;
        this.episodePreferenceSource = previous.episodePreferenceDirty ? previous.episodePreferenceSource : undefined;
        for (const [id, state] of previous.previousEpisodeStates) this.previousEpisodeStates.set(id, state);
        for (const [id, state] of previous.episodeStates) this.previousEpisodeStates.set(id, state);
        for (const id of previous.episodeRefusals) this.episodeRefusals.add(id);
        this.audioPreference.restore(previous.audioPreference);
        this.subtitlePreference.restore(previous.subtitlePreference);
        if (this.detail.versions.some(file => file.fileId === previous.selectedFileId)) this.selectedFileId = previous.selectedFileId;
        this.audioPick = previous.audioPick;
        this.audioAuto = previous.audioAuto;
        this.subtitlePick = previous.subtitlePick;
        this.subtitleAuto = previous.subtitleAuto;
        this.audioTrackId();
        this.subtitleIntent();
    }

    audioTrackId(explicitOnly = false): string | undefined {
        const fileId = playChoices(this.detail, this.selectedFileId, this.preferredQuality)?.fromStart.fileId;
        const file = this.detail.versions.find(file => file.fileId === fileId);
        const pick = this.audioPick;
        if (pick === undefined) {
            if (explicitOnly) return undefined;
            const index = file?.effectiveAudioTrackIndex;
            return !this.audioAuto && index !== undefined && file?.audio?.[index] !== undefined ? `file:${fileId}:audio:${index}` : undefined;
        }
        if (pick.fileId !== fileId || file?.audio?.[pick.ordinal] === undefined || pick.inventory !== JSON.stringify([file.audio, file.audioMetadata])) {
            this.audioPick = undefined;
            return undefined;
        }
        return `file:${pick.fileId}:audio:${pick.ordinal}`;
    }

    showPanel(panel: NonNullable<DetailsState["panel"]>): void {
        if (panel !== "more" && this.detail.type === "series" && (this.nextEpisodeFailed || this.episodePreferencesBlocked || this.nextEpisode !== undefined && playChoices(this.nextEpisode, this.nextEpisodeState?.selectedFileId, this.nextEpisodeState?.preferredQuality) === undefined)) return;
        this.pendingEpisodePanel = undefined;
        const id = this.playbackTargetId;
        if (panel !== "more" && this.detail.type === "series" && this.nextEpisode === undefined && id !== undefined) {
            this.pendingEpisodePanel = { id, panel };
            this.loadNextEpisode();
            return;
        }
        this.panel = panel; this.changed();
    }
    closePanel(): void {
        this.pendingEpisodePanel = undefined;
        const panel = this.panel;
        this.panel = undefined;
        this.changed(panel);
    }
    showAudio(): void { this.showPanel("audio"); }
    closeAudio(): void { this.closePanel(); }

    selectAudio(ordinal: number | undefined): void {
        if (this.preparingPlay) { this.closeAudio(); return; }
        const fileId = playChoices(this.detail, this.selectedFileId, this.preferredQuality)?.fromStart.fileId;
        const file = this.detail.versions.find(file => file.fileId === fileId);
        if (file === undefined || (ordinal !== undefined && file.audio?.[ordinal] === undefined)) return;
        this.audioPick = ordinal === undefined ? undefined : { fileId: file.fileId, ordinal, inventory: JSON.stringify([file.audio, file.audioMetadata]) };
        this.audioAuto = ordinal === undefined;
        const track = ordinal === undefined ? undefined : file.audio?.[ordinal];
        this.audioPreference.choose(ordinal === undefined || track === undefined ? undefined : { ordinal, track });
        this.closeAudio();
    }

    subtitleIntent(): SubtitleIntent {
        const pick = this.subtitlePick;
        if (pick?.intent.kind === "off") return pick.intent;
        const fileId = playChoices(this.detail, this.selectedFileId, this.preferredQuality)?.fromStart.fileId;
        const file = this.detail.versions.find(file => file.fileId === fileId);
        if (pick === undefined || pick.fileId !== fileId || pick.inventory !== JSON.stringify(file?.subtitles)) {
            this.subtitlePick = undefined;
            if (pick === undefined && !this.subtitleAuto) {
                const effective = file?.effectiveSubtitle;
                if (effective?.mode === "off") return { kind: effective.showForced ? "auto" : "off" };
                const match = preferredCatalogSubtitle(file?.subtitles ?? [], effective?.signature);
                if (match !== undefined && file?.subtitles?.filter(track => matchesSubtitle(track, match)).length === 1) return { kind: "track", signature: match, saved: true };
            }
            return { kind: "auto" };
        }
        return pick.intent;
    }

    selectSubtitle(choice: number | "off" | undefined): void {
        if (this.preparingPlay) { this.closePanel(); return; }
        const fileId = playChoices(this.detail, this.selectedFileId, this.preferredQuality)?.fromStart.fileId;
        const file = this.detail.versions.find(file => file.fileId === fileId);
        if (file === undefined) return;
        let intent: SubtitleIntent;
        if (typeof choice === "number") {
            const track = file.subtitles?.[choice];
            if (track === undefined) return;
            intent = { kind: "track", signature: track };
        } else intent = { kind: choice === "off" ? "off" : "auto" };
        this.subtitlePick = choice === undefined ? undefined : { fileId: file.fileId, inventory: JSON.stringify(file.subtitles), intent };
        this.subtitleAuto = choice === undefined;
        const track = typeof choice === "number" ? file.subtitles?.[choice] : undefined;
        // An external sidecar with no stream index cannot be named on the preference wire. Apple leaves it unselected for persistence.
        if (track === undefined || track.selectionIndex !== undefined) this.subtitlePreference.choose(track === undefined ? choice === "off" ? "off" : undefined : { track });
        this.closePanel();
    }

    preparePlay(request: PlayRequest, clock: Clock, handoff: (request: PlayRequest) => void): void {
        const controller = this.controller;
        if (controller === undefined || this.preparingPlay || this.audioPreference.pending || this.audioPreference.failed || this.subtitlePreference.pending || this.subtitlePreference.failed) return;
        this.failedPlay = undefined;
        if (request.startSeconds === 0) { handoff(request); return; }
        this.preparingPlay = true;
        this.changed();
        freshPlayPosition(this.session, request, clock, controller.signal).then(position => {
            if (!this.current(controller)) return;
            this.preparingPlay = false;
            handoff({ ...request, startSeconds: position });
        }, () => {
            if (!this.current(controller)) return;
            this.preparingPlay = false;
            this.failedPlay = request;
            this.changed();
        });
    }

    deferPlay(request: PlayRequest): void { this.failedPlay = request; this.changed(); }

    playExtra(extra: LocalExtra, handoff: (request: PlayRequest) => void): void {
        const controller = this.controller;
        if (controller === undefined || this.extraPending !== undefined) return;
        const play = (fileId: string): void => handoff({ contentId: extra.contentId, fileId, title: extra.title || extra.kind, startSeconds: 0 });
        if (extra.fileId !== undefined) { play(extra.fileId); return; }
        this.extraPending = extra.contentId;
        this.extraFailed = undefined;
        this.changed();
        this.read(operations.catalogItemVersions(extra.contentId), controller).then(files => {
            if (!this.current(controller)) return;
            const file = files[0];
            if (file === undefined) throw new Error("Extra has no playback file");
            this.extraPending = undefined;
            play(file.fileId);
        }).catch(() => {
            if (!this.current(controller)) return;
            this.extraPending = undefined;
            this.extraFailed = extra.contentId;
            this.changed();
        });
    }

    private async read<T>(spec: RequestSpec<T>, controller: AbortController, cachedDisplay = true): Promise<T> {
        try {
            const value = await this.session.call({ ...spec, profileScoped: true, signal: controller.signal });
            if (this.current(controller)) this.responses.set(spec.path, value);
            return value;
        } catch (error) {
            // A 403 or 404 refuses this response. A later transport failure must not serve it.
            if (this.current(controller) && error instanceof ApiError && (error.status === 403 || error.status === 404)) this.responses.delete(spec.path);
            if (this.current(controller) && error instanceof ApiError && ["network", "timeout"].includes(error.failure.kind)) {
                this.offline = true;
                if (cachedDisplay && this.responses.has(spec.path)) return this.responses.get(spec.path) as T;
            }
            throw error;
        }
    }

    dismissAlert(): void {
        if (this.alert === undefined) return;
        this.alert = undefined;
        this.changed();
    }

    /** Discard Held Change: drop the unconfirmed write and reload what the server now holds for it. */
    discardHeld(): void {
        const kind = this.alert?.held;
        const change = kind === undefined ? undefined : this.changes.get(kind);
        const controller = this.controller;
        this.alert = undefined;
        if (kind !== undefined) this.changes.delete(kind);
        this.changed();
        if (kind === undefined || change === undefined || controller === undefined) return;
        void this.refresh(kind, controller, change.target, false).then(() => { if (this.current(controller)) this.changed(); }, () => undefined);
    }

    /** ShuffleLauncher.start: More closes at once; a failure is the Couldn't Shuffle alert. */
    startShuffle(handoff: (request: PlayRequest) => void, season?: { readonly id: string }): void {
        const controller = this.controller;
        const supported = season === undefined ? this.shuffleSupported : this.shuffleSeasonSupported;
        if (controller === undefined || !supported || this.shuffleStarting || this.detail.type !== "series") return;
        this.shuffleStarting = true;
        this.closePanel();
        void (async () => {
            try {
                const shuffle = await this.session.call({ ...operations.createShuffle(season?.id ?? this.detail.id, season === undefined ? "series" : "season"), profileScoped: true, replayAfterRefresh: false, signal: controller.signal });
                if (!this.current(controller)) return;
                await this.capReady(controller.signal);
                if (!this.current(controller)) return;
                const request = await shufflePick(spec => this.read(spec, controller), shuffle, this.preferredQuality);
                if (!this.current(controller)) return;
                if (request === undefined) throw new Error("Shuffle has no playable file");
                handoff(request);
            } catch (error) {
                if (this.current(controller)) this.alert = shuffleFailure(error);
            } finally {
                if (this.current(controller)) { this.shuffleStarting = false; this.changed(); }
            }
        })();
    }


    private current(controller: AbortController): boolean {
        return this.controller === controller && !controller.signal.aborted;
    }

    loadNextEpisode(): void {
        if (!this.full || !["series", "season"].includes(this.detail.type)) return;
        const id = this.playbackTargetId;
        if (id !== undefined) { this.episodeFailures.delete(id); this.queueEpisode(id); }
        this.syncEpisode();
        this.changed();
    }

    warmSeriesEpisodes(translate = true): void {
        if (!["series", "season"].includes(this.detail.type)) return;
        const season = this.series?.seasons.find(season => season.seasonNumber === this.series?.seasonNumber);
        if (season !== undefined && (this.aggregateWatched !== undefined || season.userData !== undefined) && !this.seasonStates.has(season.seasonNumber)) {
            const owner = new DetailsState({ ...this.detail, id: season.id, type: "season", seriesId: this.detail.id, seasonNumber: season.seasonNumber, played: this.aggregateWatched ?? season.userData?.played },
                this.session, () => this.changed(), (detail, signal) => this.seasonWatchedChanged(detail, signal),
                () => this.pending || this.pendingElsewhere());
            this.seasonStates.set(season.seasonNumber, owner);
            owner.start("personal");
        }
        // A pill selection applies once, while it still owns the hero. Episode
        // focus and Show Series Info clear that ownership; a later refresh must
        // not put the season's first episode back. TVSeriesDetailView.swift:740-745.
        if (this.series?.focusSelectedEpisode && this.series.selectionOwnsHero) {
            this.focusedEpisodeId = this.series.episodes?.[0]?.id;
        }
        if (this.series?.railEpisodes !== undefined && this.focusedEpisodeId !== undefined && !this.series.railEpisodes.some(episode => episode.id === this.focusedEpisodeId)) this.focusedEpisodeId = undefined;
        const target = this.playbackTargetId;
        if (this.queuedFocusEpisode !== undefined && this.queuedFocusEpisode !== target) this.cancelEpisodeFocus();
        if (target !== undefined && !this.series?.selectionOwnsHero && this.focusedEpisodeId === undefined) this.queueEpisode(target);
        this.syncEpisode();
        this.changed();
        this.descriptions?.consider(translate);
    }

    focusEpisode(id: string): void {
        if (!this.series?.railEpisodes?.some(episode => episode.id === id)) return;
        if (this.focusedEpisodeId === id && (this.episodeFocusDwell !== undefined || this.episodeStates.has(id) || this.episodeReads.has(id) || this.episodeFailures.has(id))) return;
        this.cancelEpisodeFocus();
        this.focusedEpisodeId = id;
        this.episodeFocusOwner = id;
        const cached = this.episodeStates.get(id);
        if (cached !== undefined) { this.episodeStates.delete(id); this.episodeStates.set(id, cached); }
        if (!this.episodeStates.has(id) && !this.episodeFailures.has(id)) {
            this.episodeFocusDwell = setTimeout(() => {
                this.episodeFocusDwell = undefined;
                if (this.episodeFocusOwner !== id || this.heroEpisodeId !== id) return;
                this.queueEpisode(id, true);
                this.syncEpisode();
                this.changed();
            }, EPISODE_FOCUS_DWELL_MS);
        }
        this.syncEpisode();
        this.changed();
    }

    blurEpisode(id: string): void {
        if (this.focusedEpisodeId !== id) return;
        this.cancelEpisodeFocus();
        this.syncEpisode();
    }

    private cancelEpisodeFocus(): void {
        this.episodeFocusOwner = undefined;
        clearTimeout(this.episodeFocusDwell);
        this.episodeFocusDwell = undefined;
        const id = this.queuedFocusEpisode;
        const index = id === undefined ? -1 : this.episodeQueue.indexOf(id);
        if (index >= 0 && id !== undefined) {
            this.episodeQueue.splice(index, 1);
            this.episodeReads.delete(id);
        }
        this.queuedFocusEpisode = undefined;
    }

    private async seasonWatchedChanged(detail: ItemDetail, signal: AbortSignal): Promise<void> {
        await this.watchedChanged(detail, signal);
        const [series, seasons] = await Promise.all([
            this.session.call({ ...operations.getCatalogItem(this.detail.id), profileScoped: true, signal }),
            this.session.call({ ...operations.listSeriesSeasons(this.detail.id), profileScoped: true, signal }),
        ]);
        if (series.id !== this.detail.id || series.played === undefined) throw new Error("Series watch state missing");
        if (signal.aborted) return;
        this.invalidateEpisodes();
        this.detail = this.mergeDiscoveredTrailers(series);
        this.values.set("watched", series.played);
        this.aggregateWatched = undefined;
        if (this.series !== undefined) this.series.seasons = seasons;
        this.warmSeriesEpisodes();
    }

    cachedEpisode(id: string): DetailsState | undefined { return this.episodeStates.get(id); }

    noteEpisodePreference(id: string, external = false, seriesId?: string): void {
        const sharedSeries = external && ["series", "season"].includes(this.detail.type) && seriesId === (this.detail.seriesId || this.detail.id);
        if (sharedSeries || this.episodeStates.has(id) || this.previousEpisodeStates.has(id)) {
            this.episodePreferenceDirty = true;
            this.episodePreferenceSource = external ? undefined : id;
        }
    }

    retryPreference(kind: "audio" | "subtitles", owner: DetailsState): void {
        if (this.previousEpisodeStates.get(owner.detail.id) === owner && this.episodeStates.get(owner.detail.id) !== owner) {
            this.episodeFailures.delete(owner.detail.id);
            this.queueEpisode(owner.detail.id);
            this.syncEpisode();
            this.changed();
        } else if (kind === "audio") owner.audioPreference.retry();
        else owner.subtitlePreference.retry();
    }

    showSeriesOverview(): void {
        this.cancelEpisodeFocus();
        this.focusedEpisodeId = undefined;
        if (this.series !== undefined) this.series.selectionOwnsHero = false;
        this.warmSeriesEpisodes(); this.closePanel();
    }

    restoreSeasonStates(previous: DetailsState | undefined): void {
        for (const [number, prior] of previous?.seasonStates ?? []) {
            const season = this.series?.seasons.find(season => season.seasonNumber === number);
            if (season === undefined) continue;
            const owner = new DetailsState({ ...prior.detail, played: season.userData?.played }, this.session, () => this.changed(),
                (detail, signal) => this.seasonWatchedChanged(detail, signal), () => this.pending || this.pendingElsewhere());
            for (const [kind, change] of prior.changes) owner.changes.set(kind, { ...change, pending: false, failed: true });
            this.seasonStates.set(number, owner);
        }
    }

    private syncEpisode(): void {
        const id = this.playbackTargetId;
        this.nextEpisodeState = id === undefined ? undefined : this.episodeStates.get(id);
        const previous = id === undefined || this.episodeRefusals.has(id) ? undefined : this.previousEpisodeStates.get(id) ?? (this.previousNextEpisodeState?.detail.id === id ? this.previousNextEpisodeState : undefined);
        if (id !== undefined && this.nextEpisodeState === undefined && previous !== undefined && !previous.audioPreference.pending && !previous.audioPreference.failed && !previous.subtitlePreference.pending && !previous.subtitlePreference.failed && this.controller !== undefined) {
            const state = new DetailsState(previous.detail, this.session, key => this.episodePreferenceChanged(state, key), this.watchedChanged, this.pendingElsewhere, undefined, this.quality);
            state.restore(previous);
            this.episodeStates.set(id, state);
            state.start("playback");
            this.nextEpisodeState = state;
        }
        this.nextEpisodeState ??= previous;
        this.nextEpisode = this.nextEpisodeState?.detail;
        this.nextEpisodeFailed = this.nextEpisodeState === undefined && ["series", "season"].includes(this.detail.type) && id !== undefined && this.episodeFailures.has(id);
        this.nextEpisodeLoading = id !== undefined && this.episodeReads.has(id);
    }

    private queueEpisode(id: string, focusOnly = false): void {
        // Explicit activation promotes a queued focus read; blur must not cancel it.
        if (!focusOnly && this.queuedFocusEpisode === id) this.queuedFocusEpisode = undefined;
        if (this.controller === undefined || this.episodeStates.has(id) || this.episodeReads.has(id) || this.episodeFailures.has(id)) return;
        if (focusOnly) this.queuedFocusEpisode = id;
        this.episodeReads.add(id);
        this.episodeController ??= new AbortController();
        this.episodeQueue.push(id);
        this.drainEpisodes();
    }

    private drainEpisodes(): void {
        const controller = this.controller;
        const episodeController = this.episodeController, epoch = this.episodeEpoch;
        if (controller === undefined || episodeController === undefined) return;
        const current = (): boolean => this.current(controller) && this.episodeEpoch === epoch;
        while (this.episodeWorkers < EPISODE_PREFETCH_CONCURRENCY && this.episodeQueue.length > 0) {
            const id = this.episodeQueue.shift();
            if (id === undefined) break;
            this.episodeWorkers++;
            this.session.call({ ...operations.getCatalogItem(id), profileScoped: true, signal: episodeController.signal }).then(detail => {
                if (!current()) return;
                if (detail.id !== id || detail.type !== "episode") throw new ApiError({ kind: "invalid_response", path: "nextEpisode.item" });
                this.episodeRefusals.delete(id);
                const state = new DetailsState(detail, this.session, key => this.episodePreferenceChanged(state, key), this.watchedChanged, this.pendingElsewhere, undefined, this.quality);
                // The fallback already on screen can hold this visit's version, audio, or subtitles.
                const active = this.episodeStates.get(id);
                const retained = active ?? this.previousEpisodeStates.get(id) ?? (this.previousNextEpisodeState?.detail.id === id ? this.previousNextEpisodeState : undefined);
                state.restore(retained);
                this.previousEpisodeStates.delete(id);
                this.episodeStates.set(id, state);
                state.start("playback");
                if (active !== undefined && active !== state) active.stop();
            }).catch(error => {
                if (!current()) return;
                this.episodeFailures.add(id);
                if (error instanceof ApiError && ["network", "timeout"].includes(error.failure.kind)) this.offline = true;
                else { this.episodeRefusals.add(id); this.episodeStates.get(id)?.stop(); this.episodeStates.delete(id); }
            }).finally(() => {
                if (!current()) return;
                this.episodeWorkers--;
                this.episodeReads.delete(id);
                this.syncEpisode();
                const pending = this.pendingEpisodePanel;
                if (pending?.id === id) {
                    this.pendingEpisodePanel = undefined;
                    if (this.playbackTargetId === id && this.nextEpisode !== undefined) this.panel = pending.panel;
                }
                this.pruneEpisodeOwners();
                this.changed();
                this.drainEpisodes();
            });
        }
    }

    private pruneEpisodeOwners(): void {
        // Tizen retains live preference owners rather than Apple's decoded ResponseCache values.
        // Keep a small revisit window, but never discard unfinished user work.
        const owners = new Map([...this.previousEpisodeStates, ...this.episodeStates]);
        for (const [id, state] of owners) {
            if (this.episodeStates.size + this.previousEpisodeStates.size <= EPISODE_OWNER_CACHE_LIMIT) break;
            if (id === this.playbackTargetId || id === this.pendingEpisodePanel?.id || this.episodeReads.has(id)
                || state.busy || state.preparingPlay || state.failedPlay !== undefined || state.panel !== undefined
                || state.audioPreference.pending || state.audioPreference.failed || state.subtitlePreference.pending || state.subtitlePreference.failed) continue;
            state.stop();
            this.episodeStates.delete(id);
            this.previousEpisodeStates.delete(id);
        }
    }

    private invalidateEpisodes(): void {
        this.cancelEpisodeFocus();
        this.episodeEpoch++;
        this.episodeController?.abort();
        this.episodeController = undefined;
        for (const [id, state] of this.episodeStates) { this.previousEpisodeStates.set(id, state); state.stop(); }
        this.episodeStates.clear();
        this.episodeReads.clear();
        this.episodeFailures.clear();
        this.episodeQueue.length = 0;
        this.episodeWorkers = 0;
    }

    private episodePreferenceChanged(state: DetailsState, key?: string): void {
        if (state.audioPreference.pending || state.subtitlePreference.pending) {
            this.episodePreferenceDirty = true;
        }
        if (this.episodePreferenceDirty && !this.episodePreferencesBlocked && this.controller !== undefined) {
            this.episodePreferenceDirty = false;
            const owners = new Map([...this.previousEpisodeStates, ...this.episodeStates]);
            const ids = [...new Set([...owners.keys(), ...this.episodeReads])];
            for (const [episodeId, owner] of owners) {
                if (episodeId !== this.episodePreferenceSource) {
                    owner.audioPick = undefined; owner.subtitlePick = undefined;
                    owner.audioAuto = false; owner.subtitleAuto = false;
                    if (owner.failedPlay !== undefined) {
                        const { audioTrackId: _audio, subtitle: _subtitle, ...request } = owner.failedPlay;
                        owner.failedPlay = { ...request, subtitle: { kind: "auto" } };
                    }
                }
            }
            this.episodePreferenceSource = undefined;
            this.invalidateEpisodes();
            this.previousNextEpisodeState = undefined;
            for (const episodeId of ids) this.queueEpisode(episodeId);
            this.syncEpisode();
        }
        this.pruneEpisodeOwners();
        this.changed(key);
    }

    loadRelated(): void {
        const controller = this.controller;
        if (controller === undefined) return;
        this.relatedFailed = false;
        this.changed();
        this.read(detailOperations.similar(this.detail.id), controller).then((page) => {
            if (!this.current(controller)) return;
            // TVSimilarRail.swift:158-161 asks for 12 and shows them as sent.
            this.related = page.items.slice(0, RELATED_LIMIT);
            this.changed();
        }, () => {
            if (!this.current(controller)) return;
            this.relatedFailed = true;
            this.changed();
        });
    }

    loadPersonal(): void {
        const controller = this.controller;
        if (controller === undefined) return;
        if (!["movie", "series", "episode"].includes(this.detail.type)) {
            this.personalSupported = false;
            this.changed();
            return;
        }
        this.personalFailed = false;
        this.changed();
        const read = async (): Promise<void> => {
            const supported = await this.read(detailOperations.personalCapability(), controller);
            if (!this.current(controller)) return;
            if (!supported) { this.personalSupported = false; return; }
            const [watchlist, favorites] = await Promise.all([
                this.read(detailOperations.membership("watchlist", this.detail.id), controller),
                this.read(detailOperations.membership("favorites", this.detail.id), controller),
            ]);
            if (!this.current(controller)) return;
            if (watchlist.id !== this.detail.id || favorites.id !== this.detail.id) throw new Error("Membership item mismatch");
            this.values.set("watchlist", watchlist.member);
            this.values.set("favorites", favorites.member);
            this.personalSupported = true;
        };
        read().then(() => {
            if (this.current(controller)) this.changed();
        }, (error: unknown) => {
            if (!this.current(controller)) return;
            if (error instanceof ApiError && (error.status === 404 || error.status === 501)) {
                this.personalSupported = false;
                // 501 is not a 403/404, and one refused membership can sit beside a newer capability answer.
                this.responses.delete(detailOperations.personalCapability().path);
                this.responses.delete(detailOperations.membership("watchlist", this.detail.id).path);
                this.responses.delete(detailOperations.membership("favorites", this.detail.id).path);
            } else this.personalFailed = true;
            this.changed();
        });
    }

    /** A failed write is reconciled by a read before an explicit retry can send it again. */
    change(kind: PersonalAction, target: boolean, reconcile = false): void {
        const controller = this.controller;
        if (controller === undefined || this.busy || !this.values.has(kind)) return;
        this.changes.set(kind, { target, pending: true, failed: false });
        this.changed();
        let unanswered = false;
        const run = async (): Promise<void> => {
            if (reconcile) {
                const actual = await this.refresh(kind, controller, target, false);
                if (!this.current(controller) || actual === target) return;
            }
            if (!this.current(controller)) return;
            try {
                await this.session.call({ ...detailOperations.setPersonal(kind, this.detail.id, target), profileScoped: true, replayAfterRefresh: false, signal: controller.signal });
            } catch (error) {
                // MutationDelivery.unconfirmed: no answer may still mean the write landed. A network failure here
                // cannot tell an unsent request from a lost answer, so it is held like a timeout.
                unanswered = error instanceof ApiError && (error.failure.kind === "timeout" || error.failure.kind === "network");
                throw error;
            }
            if (!this.current(controller)) return;
            const actual = await this.refresh(kind, controller, target, true);
            if (actual !== target) throw new Error("Personal state was not applied");
        };
        run().then(() => {
            if (!this.current(controller)) return;
            this.changes.delete(kind);
            this.changed();
        }, () => {
            if (!this.current(controller)) return;
            this.changes.set(kind, { target, pending: false, failed: true });
            this.alert = this.detail.type === "season" ? SEASON_WATCHED_FAILED : unanswered ? { id: "details-change-held", title: "Change Not Confirmed", message: HELD_MESSAGE, held: kind } : ITEM_UPDATE_FAILED;
            this.changed();
        });
    }

    private async refresh(kind: PersonalAction, controller: AbortController, requested = false, writeAccepted = false): Promise<boolean> {
        if (kind === "watched") {
            const detail = await this.read(operations.getCatalogItem(this.detail.id), controller, false);
            if (detail.id !== this.detail.id || detail.played === undefined) throw new Error("Watch state missing");
            if (!this.current(controller)) return detail.played;
            await this.watchedChanged(detail, controller.signal);
            if (this.current(controller)) {
                // Series played:false only means the show is incomplete. Copy it onto seasons
                // after that write was accepted, or when the read shows the whole series watched.
                // A lost unwatched answer is separate: the series was fully watched and this read
                // matches that request, so the write took effect. Refresh the seasons already
                // loaded from their rollups, and drop the series aggregate so a season opened
                // later uses the rollup it was read with. Do that before accepting the read; if
                // the refresh fails, the series stays watched and Retry can try again.
                const unwatchedLanded = detail.type === "series" && !writeAccepted && requested === false && detail.played === false && this.values.get(kind) === true;
                const rollups = unwatchedLanded ? await this.read(operations.listSeriesSeasons(this.detail.id), controller) : undefined;
                if (!this.current(controller)) return detail.played;
                // Discovery may have published trailers while this watched readback was
                // in flight; keep the richer extras/videos rather than wiping them.
                this.detail = this.mergeDiscoveredTrailers(detail);
                this.values.set(kind, detail.played);
                if (detail.type === "series" && detail.played === requested && (detail.played === true || writeAccepted)) {
                    this.aggregateWatched = detail.played;
                    for (const owner of this.seasonStates.values()) {
                        owner.values.set("watched", detail.played);
                        owner.detail = { ...owner.detail, played: detail.played };
                        owner.changes.delete("watched");
                    }
                } else if (rollups !== undefined) {
                    if (this.series !== undefined) this.series.seasons = rollups;
                    this.aggregateWatched = undefined;
                    for (const [number, owner] of this.seasonStates) {
                        const played = rollups.find(season => season.seasonNumber === number)?.userData?.played;
                        if (played === undefined) continue;
                        owner.values.set("watched", played);
                        owner.detail = { ...owner.detail, played };
                        owner.changes.delete("watched");
                    }
                }
                this.invalidateEpisodes();
                this.focusedEpisodeId = undefined;
                this.nextEpisode = undefined;
                this.nextEpisodeLoading = false;
                this.nextEpisodeFailed = false;
                this.loadNextEpisode();
                this.warmSeriesEpisodes();
            }
            return detail.played;
        }
        const membership = await this.read(detailOperations.membership(kind, this.detail.id), controller, false);
        if (membership.id !== this.detail.id) throw new Error("Membership item mismatch");
        if (this.current(controller)) this.values.set(kind, membership.member);
        return membership.member;
    }

    /** Keep trailers discovery published while an older watched readback finishes. */
    private mergeDiscoveredTrailers(detail: ItemDetail): ItemDetail {
        const videos = detail.videos.length >= this.detail.videos.length ? detail.videos : this.detail.videos;
        const extras = (detail.extras?.length ?? 0) >= (this.detail.extras?.length ?? 0) ? detail.extras : this.detail.extras;
        return extras === undefined ? { ...detail, videos } : { ...detail, videos, extras };
    }
}
