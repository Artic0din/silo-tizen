// Optional Details reads and explicit personal writes. The route owns and stops this work.
import { ApiError } from "../api/errors.ts";
import type { RequestSpec } from "../api/http.ts";
import { detailOperations, type PersonalAction } from "../api/detailOperations.ts";
import { operations } from "../api/operations.ts";
import type { Card, ItemDetail, LocalExtra } from "../contracts/v2/catalog.ts";
import { playChoices, type PlayRequest } from "./browseModel.ts";
import type { Clock } from "../api/clock.ts";
import type { NativeSession } from "../session/session.ts";
import { readSettingsCapability, readTitleArt } from "./presentationSettings.ts";
import { ADVISORY_KEY } from "../contracts/v2/settingsRows.ts";
import { RatingState } from "./ratingState.ts";
import type { SubtitleIntent } from "../contracts/v2/preplaySubtitles.ts";
import { SeriesEpisodes } from "./seriesEpisodes.ts";
import { freshPlayPosition } from "./playbackPreparation.ts";
import { PreplayAudioPreference } from "./preplayAudioPreference.ts";
import { PreplayTrackPreference } from "./preplayTrackPreference.ts";
import { subtitlePreferenceOperations, type SubtitlePreferencePick, type SubtitlePreference } from "../api/subtitlePreferenceOperations.ts";
import { matchesSubtitle, preferredCatalogSubtitle } from "../player/preplaySubtitles.ts";

export interface PersonalChange {
    readonly target: boolean;
    readonly pending: boolean;
    readonly failed: boolean;
}

const EPISODE_PREFETCH_CONCURRENCY = 4;

export class DetailsState {
    readonly rating: RatingState;
    readonly audioPreference: PreplayAudioPreference;
    readonly subtitlePreference: PreplayTrackPreference<SubtitlePreferencePick, SubtitlePreference>;
    series: SeriesEpisodes | undefined;
    detail: ItemDetail;
    selectedFileId: string | undefined;
    panel: "audio" | "version" | "subtitles" | "more" | "rating" | undefined;
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
    private readonly episodeQueue: string[] = [];
    private episodeWorkers = 0;
    private episodeEpoch = 0;
    private episodeController: AbortController | undefined;
    private episodePreferenceDirty = false;
    private episodePreferenceSource: string | undefined;
    get unsettledEpisode(): DetailsState | undefined {
        return [...this.episodeStates.values(), ...this.previousEpisodeStates.values()].find(state => state.audioPreference.pending || state.audioPreference.failed || state.subtitlePreference.pending || state.subtitlePreference.failed);
    }
    get episodePreferencesBlocked(): boolean { return this.unsettledEpisode !== undefined; }
    get playbackTargetId(): string | undefined { return this.focusedEpisodeId ?? this.detail.playContentId; }
    nextEpisodeLoading = false;
    nextEpisodeFailed = false;
    extraPending: string | undefined;
    extraFailed: string | undefined;
    private full = false;
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
    showAdvisoryAge = false;
    readonly values = new Map<PersonalAction, boolean>();
    readonly changes = new Map<PersonalAction, PersonalChange>();
    private controller: AbortController | undefined;
    private stopAuthority: (() => void) | undefined;
    private readonly session: NativeSession;
    private readonly changed: (returnKey?: string) => void;
    private readonly watchedChanged: (detail: ItemDetail, signal: AbortSignal) => Promise<void>;
    private readonly pendingElsewhere: () => boolean;

    constructor(detail: ItemDetail, session: NativeSession, changed: (returnKey?: string) => void, watchedChanged: (detail: ItemDetail, signal: AbortSignal) => Promise<void>, pendingElsewhere: () => boolean = () => false) {
        this.detail = detail;
        this.session = session;
        this.changed = changed;
        this.watchedChanged = watchedChanged;
        this.pendingElsewhere = pendingElsewhere;
        this.rating = new RatingState(session, detail.id, () => this.changed(), () => this.pending || this.pendingElsewhere());
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

    get pending(): boolean { return [...this.changes.values()].some(change => change.pending); }
    get busy(): boolean { return this.pending || this.rating.pending || this.pendingElsewhere() || this.episodePreferencesBlocked; }

    start(mode: "full" | "personal" | "playback" = "full"): void {
        if (this.controller !== undefined) return;
        this.controller = new AbortController();
        if (["movie", "episode"].includes(this.detail.type)) this.audioPreference.start();
        if (["movie", "episode"].includes(this.detail.type)) this.subtitlePreference.start();
        this.full = mode === "full";
        if (this.full && this.episodePreferenceDirty) this.episodePreferenceChanged(this);
        if (mode === "full" && ["movie", "series"].includes(this.detail.type)) this.rating.start();
        this.stopAuthority = this.session.onAuthorityChange(() => { this.stop(); this.changed(); });
        if (mode === "playback") return;
        this.nextEpisodeState?.start("playback");
        for (const state of this.episodeStates.values()) state.start("playback");
        for (const [id, state] of this.previousEpisodeStates) if (state.audioPreference.failed || state.subtitlePreference.failed) this.queueEpisode(id);
        if (mode === "full") this.series?.start();
        if (mode === "full") this.warmSeriesEpisodes();
        if (mode === "full") this.loadTitleArt();
        if (mode === "full") {
            const controller = this.controller;
            void this.read(operations.effectiveSettings([ADVISORY_KEY]), controller).then(values => {
                if (!this.current(controller)) return;
                this.showAdvisoryAge = values.get(ADVISORY_KEY)?.value === true;
                this.changed();
            }, () => { /* Missing advisory preferences keep the optional badge hidden. */ });
        }
        if (mode === "full" && this.nextEpisode === undefined && !this.nextEpisodeFailed) this.loadNextEpisode();
        let interrupted = false;
        for (const [kind, change] of this.changes) {
            if (change.pending) {
                this.changes.set(kind, { ...change, pending: false, failed: true });
                interrupted = true;
            }
        }
        if (interrupted) this.changed();
        if (mode === "full" && this.related === undefined) this.loadRelated();
        if (this.personalSupported === undefined) this.loadPersonal();
    }

    stop(): void {
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
        this.rating.stop();
        this.series?.stop();
        this.controller?.abort();
        this.controller = undefined;
        this.stopAuthority?.();
        this.stopAuthority = undefined;
        this.titleArt = undefined;
        this.titleArtPolicy = "pending";
        this.panel = undefined;
        this.preparingPlay = false;
        this.nextEpisodeLoading = false;
    }

    /** Capture the route generation as well as the confirmed policy for late image events. */
    titleArtGuard(): () => boolean {
        const controller = this.controller;
        return () => controller !== undefined && this.current(controller) && (this.titleArtPolicy === "compatibility" || (this.titleArtPolicy === "supported" && this.titleArt === true));
    }

    loadTitleArt(): void {
        const controller = this.controller;
        if (controller === undefined) return;
        this.titleArt = undefined;
        this.titleArtPolicy = "pending";
        this.changed();
        const run = async (): Promise<void> => {
            const read = <T>(spec: RequestSpec<T>): Promise<T> => this.read(spec, controller);
            const answer = await readTitleArt(read, this.session, await readSettingsCapability(read));
            if (!this.current(controller) || answer === undefined) return;
            if (answer === "compatibility") { this.titleArtPolicy = "compatibility"; return; }
            this.titleArt = answer;
            this.titleArtPolicy = "supported";
        };
        run().then(() => { if (this.current(controller)) this.changed(); }, () => {
            if (!this.current(controller)) return;
            this.titleArtPolicy = "failed";
            this.changed();
        });
    }

    select(fileId: string | undefined): void {
        if (fileId !== undefined && !this.detail.versions.some((file) => file.fileId === fileId)) return;
        if (fileId !== playChoices(this.detail, this.selectedFileId)?.fromStart.fileId) this.audioPick = undefined;
        this.selectedFileId = fileId;
        this.changed();
    }

    restore(previous: DetailsState | undefined): void {
        if (previous === undefined) return;
        if (this.detail.versions.some(file => file.fileId === previous.failedPlay?.fileId)) this.failedPlay = previous.failedPlay;
        this.previousNextEpisodeState = previous.nextEpisodeState;
        this.focusedEpisodeId = previous.focusedEpisodeId;
        this.episodePreferenceDirty = previous.episodePreferenceDirty;
        this.episodePreferenceSource = previous.episodePreferenceDirty ? previous.episodePreferenceSource : undefined;
        for (const [id, state] of previous.previousEpisodeStates) this.previousEpisodeStates.set(id, state);
        for (const [id, state] of previous.episodeStates) this.previousEpisodeStates.set(id, state);
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
        const fileId = playChoices(this.detail, this.selectedFileId)?.fromStart.fileId;
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

    showPanel(panel: NonNullable<DetailsState["panel"]>): void { this.panel = panel; this.changed(); }
    closePanel(): void {
        const panel = this.panel;
        this.panel = panel === "rating" ? "more" : undefined;
        this.changed(panel === "rating" ? "rate" : panel);
    }
    showAudio(): void { this.showPanel("audio"); }
    closeAudio(): void { this.closePanel(); }

    selectAudio(ordinal: number | undefined): void {
        if (this.preparingPlay) { this.closeAudio(); return; }
        const fileId = playChoices(this.detail, this.selectedFileId)?.fromStart.fileId;
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
        const fileId = playChoices(this.detail, this.selectedFileId)?.fromStart.fileId;
        const file = this.detail.versions.find(file => file.fileId === fileId);
        if (pick === undefined || pick.fileId !== fileId || pick.inventory !== JSON.stringify(file?.subtitles)) {
            this.subtitlePick = undefined;
            if (pick === undefined && !this.subtitleAuto) {
                const effective = file?.effectiveSubtitle;
                if (effective?.mode === "off") return { kind: effective.showForced ? "auto" : "off" };
                const match = preferredCatalogSubtitle(file?.subtitles ?? [], effective?.signature);
                if (match !== undefined && file?.subtitles?.filter(track => matchesSubtitle(track, match)).length === 1) return { kind: "track", signature: match };
            }
            return { kind: "auto" };
        }
        return pick.intent;
    }

    selectSubtitle(choice: number | "off" | undefined): void {
        if (this.preparingPlay) { this.closePanel(); return; }
        const fileId = playChoices(this.detail, this.selectedFileId)?.fromStart.fileId;
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

    private read<T>(spec: RequestSpec<T>, controller: AbortController): Promise<T> {
        return this.session.call({ ...spec, profileScoped: true, signal: controller.signal });
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

    warmSeriesEpisodes(): void {
        if (!["series", "season"].includes(this.detail.type)) return;
        if (this.series?.focusSelectedEpisode && this.series.episodes !== undefined) {
            this.focusedEpisodeId = this.series.entryEpisode;
        }
        if (this.detail.playContentId !== undefined) this.queueEpisode(this.detail.playContentId);
        if (this.series?.episodes !== undefined && this.focusedEpisodeId !== undefined && !this.series.episodes.some(episode => episode.id === this.focusedEpisodeId)) this.focusedEpisodeId = undefined;
        for (const episode of this.series?.episodes ?? []) this.queueEpisode(episode.id);
        this.syncEpisode();
        this.changed();
    }

    focusEpisode(id: string): void {
        if (this.focusedEpisodeId === id || !this.series?.episodes?.some(episode => episode.id === id)) return;
        this.focusedEpisodeId = id;
        // Focus only selects a preloaded owner. Reads belong to season acceptance and explicit Retry.
        this.syncEpisode();
        this.changed();
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

    showSeriesOverview(): void { this.focusedEpisodeId = undefined; this.syncEpisode(); this.closePanel(); }

    private syncEpisode(): void {
        const id = this.playbackTargetId;
        this.nextEpisodeState = id === undefined ? undefined : this.episodeStates.get(id);
        this.nextEpisode = this.nextEpisodeState?.detail;
        this.nextEpisodeFailed = ["series", "season"].includes(this.detail.type) && id !== undefined && this.episodeFailures.has(id);
        this.nextEpisodeLoading = id !== undefined && this.episodeReads.has(id);
    }

    private queueEpisode(id: string): void {
        if (this.controller === undefined || this.episodeStates.has(id) || this.episodeReads.has(id) || this.episodeFailures.has(id)) return;
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
                const state = new DetailsState(detail, this.session, key => this.episodePreferenceChanged(state, key), this.watchedChanged, this.pendingElsewhere);
                state.restore(this.previousEpisodeStates.get(id) ?? (this.previousNextEpisodeState?.detail.id === id ? this.previousNextEpisodeState : undefined));
                this.previousEpisodeStates.delete(id);
                this.episodeStates.set(id, state);
                state.start("playback");
            }).catch(() => { if (current()) this.episodeFailures.add(id); }).finally(() => {
                if (!current()) return;
                this.episodeWorkers--;
                this.episodeReads.delete(id);
                this.syncEpisode();
                this.changed();
                this.drainEpisodes();
            });
        }
    }

    private invalidateEpisodes(): void {
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
            const ids = [...new Set([...owners.keys(), ...this.episodeReads, ...(this.series?.episodes ?? []).map(episode => episode.id)])];
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
        this.changed(key);
    }

    loadRelated(): void {
        const controller = this.controller;
        if (controller === undefined) return;
        this.relatedFailed = false;
        this.changed();
        this.read(detailOperations.similar(this.detail.id), controller).then((page) => {
            if (!this.current(controller)) return;
            this.related = page.items.filter((card) => card.id !== this.detail.id).slice(0, 24);
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
            if (error instanceof ApiError && (error.status === 404 || error.status === 501)) this.personalSupported = false;
            else this.personalFailed = true;
            this.changed();
        });
    }

    /** A failed write is reconciled by a read before an explicit retry can send it again. */
    change(kind: PersonalAction, target: boolean, reconcile = false): void {
        const controller = this.controller;
        if (controller === undefined || this.busy || !this.values.has(kind)) return;
        this.changes.set(kind, { target, pending: true, failed: false });
        this.changed();
        const run = async (): Promise<void> => {
            if (reconcile) {
                const actual = await this.refresh(kind, controller);
                if (!this.current(controller) || actual === target) return;
            }
            if (!this.current(controller)) return;
            await this.session.call({ ...detailOperations.setPersonal(kind, this.detail.id, target), profileScoped: true, replayAfterRefresh: false, signal: controller.signal });
            if (!this.current(controller)) return;
            const actual = await this.refresh(kind, controller);
            if (actual !== target) throw new Error("Personal state was not applied");
        };
        run().then(() => {
            if (!this.current(controller)) return;
            this.changes.delete(kind);
            this.changed();
        }, () => {
            if (!this.current(controller)) return;
            this.changes.set(kind, { target, pending: false, failed: true });
            this.changed();
        });
    }

    private async refresh(kind: PersonalAction, controller: AbortController): Promise<boolean> {
        if (kind === "watched") {
            const detail = await this.read(operations.getCatalogItem(this.detail.id), controller);
            if (detail.id !== this.detail.id || detail.played === undefined) throw new Error("Watch state missing");
            if (!this.current(controller)) return detail.played;
            await this.watchedChanged(detail, controller.signal);
            if (this.current(controller)) {
                this.detail = detail;
                this.values.set(kind, detail.played);
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
        const membership = await this.read(detailOperations.membership(kind, this.detail.id), controller);
        if (membership.id !== this.detail.id) throw new Error("Membership item mismatch");
        if (this.current(controller)) this.values.set(kind, membership.member);
        return membership.member;
    }
}
