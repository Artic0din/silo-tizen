// Optional Details reads and explicit personal writes. The route owns and stops this work.
import { ApiError } from "../api/errors.ts";
import type { RequestSpec } from "../api/http.ts";
import { detailOperations, type PersonalAction } from "../api/detailOperations.ts";
import { operations } from "../api/operations.ts";
import type { Card, ItemDetail } from "../contracts/v2/catalog.ts";
import { playChoices, type PlayRequest } from "./browseModel.ts";
import type { Clock } from "../api/clock.ts";
import type { NativeSession } from "../session/session.ts";
import { readSettingsCapability, readTitleArt } from "./presentationSettings.ts";
import { RatingState } from "./ratingState.ts";
import type { SubtitleIntent } from "../contracts/v2/preplaySubtitles.ts";
import { SeriesEpisodes } from "./seriesEpisodes.ts";
import { freshPlayPosition } from "./playbackPreparation.ts";

export interface PersonalChange {
    readonly target: boolean;
    readonly pending: boolean;
    readonly failed: boolean;
}

export class DetailsState {
    readonly rating: RatingState;
    series: SeriesEpisodes | undefined;
    detail: ItemDetail;
    selectedFileId: string | undefined;
    panel: "audio" | "version" | "subtitles" | "more" | "rating" | undefined;
    get audioOpen(): boolean { return this.panel === "audio"; }
    preparingPlay = false;
    failedPlay: PlayRequest | undefined;
    nextEpisode: ItemDetail | undefined;
    nextEpisodeLoading = false;
    nextEpisodeFailed = false;
    private nextEpisodeRevision = 0;
    private full = false;
    private restored = false;
    private readonly responses = new Map<string, unknown>();
    offline = false;
    private audioPick: { fileId: string; ordinal: number; inventory: string } | undefined;
    private subtitlePick: { fileId: string; inventory: string; intent: SubtitleIntent } | undefined;
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

    constructor(detail: ItemDetail, session: NativeSession, changed: (returnKey?: string) => void, watchedChanged: (detail: ItemDetail, signal: AbortSignal) => Promise<void>, pendingElsewhere: () => boolean = () => false) {
        this.detail = detail;
        this.session = session;
        this.changed = changed;
        this.watchedChanged = watchedChanged;
        this.pendingElsewhere = pendingElsewhere;
        this.rating = new RatingState(session, detail.id, () => this.changed(), () => this.pending || this.pendingElsewhere());
        if (detail.played !== undefined && ["movie", "episode", "series", "season"].includes(detail.type)) this.values.set("watched", detail.played);
    }

    get pending(): boolean { return [...this.changes.values()].some(change => change.pending); }
    get busy(): boolean { return this.pending || this.rating.pending || this.pendingElsewhere(); }

    acceptDetail(detail: ItemDetail): void {
        const retrySupporting = this.offline;
        this.offline = false;
        const changedTarget = this.detail.playContentId !== detail.playContentId;
        this.detail = detail;
        if (!detail.versions.some(file => file.fileId === this.selectedFileId)) this.selectedFileId = undefined;
        if (changedTarget) {
            this.nextEpisodeRevision++;
            this.nextEpisode = undefined;
            this.nextEpisodeLoading = false;
            this.nextEpisodeFailed = false;
        }
        if (changedTarget || this.nextEpisodeFailed || retrySupporting) this.loadNextEpisode();
        if (this.controller === undefined || !this.full) return;
        if (this.personalFailed || retrySupporting) this.loadPersonal();
        if (this.relatedFailed || retrySupporting) this.loadRelated();
        if (this.titleArtPolicy === "failed" || retrySupporting) this.loadTitleArt();
        if (this.rating.failed && this.rating.failedTarget === undefined) this.rating.load();
    }

    start(mode: "full" | "personal" = "full"): void {
        if (this.controller !== undefined) return;
        this.controller = new AbortController();
        this.full = mode === "full";
        if (mode === "full" && ["movie", "series"].includes(this.detail.type)) this.rating.start();
        this.stopAuthority = this.session.onAuthorityChange(() => { this.stop(); this.changed(); });
        if (mode === "full") this.series?.start();
        if (mode === "full") this.loadTitleArt();
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
    }

    stop(): void {
        this.rating.stop();
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
        if (fileId !== playChoices(this.detail, this.selectedFileId)?.fromStart.fileId) this.audioPick = undefined;
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
        if (this.detail.versions.some(file => file.fileId === previous.selectedFileId)) this.selectedFileId = previous.selectedFileId;
        this.audioPick = previous.audioPick;
        this.subtitlePick = previous.subtitlePick;
        this.audioTrackId();
        this.subtitleIntent();
    }

    audioTrackId(): string | undefined {
        const fileId = playChoices(this.detail, this.selectedFileId)?.fromStart.fileId;
        const file = this.detail.versions.find(file => file.fileId === fileId);
        const pick = this.audioPick;
        if (pick === undefined) return undefined;
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
        const fileId = playChoices(this.detail, this.selectedFileId)?.fromStart.fileId;
        const file = this.detail.versions.find(file => file.fileId === fileId);
        if (file === undefined || (ordinal !== undefined && file.audio?.[ordinal] === undefined)) return;
        this.audioPick = ordinal === undefined ? undefined : { fileId: file.fileId, ordinal, inventory: JSON.stringify([file.audio, file.audioMetadata]) };
        this.closeAudio();
    }

    subtitleIntent(): SubtitleIntent {
        const pick = this.subtitlePick;
        if (pick?.intent.kind === "off") return pick.intent;
        const fileId = playChoices(this.detail, this.selectedFileId)?.fromStart.fileId;
        const file = this.detail.versions.find(file => file.fileId === fileId);
        if (pick === undefined || pick.fileId !== fileId || pick.inventory !== JSON.stringify(file?.subtitles)) {
            this.subtitlePick = undefined;
            return { kind: "auto" };
        }
        return pick.intent;
    }

    selectSubtitle(choice: number | "off" | undefined): void {
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
        this.closePanel();
    }

    preparePlay(request: PlayRequest, clock: Clock, handoff: (request: PlayRequest) => void): void {
        const controller = this.controller;
        if (controller === undefined || this.preparingPlay) return;
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

    private async read<T>(spec: RequestSpec<T>, controller: AbortController, cachedDisplay = true): Promise<T> {
        try {
            const value = await this.session.call({ ...spec, profileScoped: true, signal: controller.signal });
            if (this.current(controller)) this.responses.set(spec.path, value);
            return value;
        } catch (error) {
            if (this.current(controller) && error instanceof ApiError && ["network", "timeout"].includes(error.failure.kind)) {
                this.offline = true;
                if (cachedDisplay && this.responses.has(spec.path)) return this.responses.get(spec.path) as T;
            }
            throw error;
        }
    }

    private current(controller: AbortController): boolean {
        return this.controller === controller && !controller.signal.aborted;
    }

    loadNextEpisode(): void {
        const controller = this.controller, id = this.detail.playContentId;
        if (controller === undefined || !this.full || id === undefined || this.nextEpisodeLoading || !["series", "season"].includes(this.detail.type)) return;
        this.nextEpisodeLoading = true;
        this.nextEpisodeFailed = false;
        const revision = ++this.nextEpisodeRevision;
        const current = (): boolean => this.current(controller) && this.nextEpisodeRevision === revision && this.detail.playContentId === id;
        this.changed();
        this.read(operations.getCatalogItem(id), controller).then(detail => {
            if (!current()) return;
            if (detail.id !== id || detail.type !== "episode") throw new ApiError({ kind: "invalid_response", path: "nextEpisode.item" });
            this.nextEpisode = detail;
            this.nextEpisodeLoading = false;
            this.changed();
        }).catch(() => {
            if (!current()) return;
            this.nextEpisodeLoading = false;
            this.nextEpisodeFailed = true;
            this.changed();
        });
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
            const detail = await this.read(operations.getCatalogItem(this.detail.id), controller, false);
            if (detail.id !== this.detail.id || detail.played === undefined) throw new Error("Watch state missing");
            if (!this.current(controller)) return detail.played;
            await this.watchedChanged(detail, controller.signal);
            if (this.current(controller)) {
                this.detail = detail;
                this.values.set(kind, detail.played);
                this.nextEpisode = undefined;
                this.nextEpisodeLoading = false;
                this.nextEpisodeFailed = false;
                this.loadNextEpisode();
            }
            return detail.played;
        }
        const membership = await this.read(detailOperations.membership(kind, this.detail.id), controller, false);
        if (membership.id !== this.detail.id) throw new Error("Membership item mismatch");
        if (this.current(controller)) this.values.set(kind, membership.member);
        return membership.member;
    }
}
