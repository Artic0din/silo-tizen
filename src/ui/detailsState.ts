// Optional Details reads and explicit personal writes. The route owns and stops this work.
import { ApiError } from "../api/errors.ts";
import type { RequestSpec } from "../api/http.ts";
import { detailOperations, type PersonalAction } from "../api/detailOperations.ts";
import { operations } from "../api/operations.ts";
import type { Card, ItemDetail } from "../contracts/v2/catalog.ts";
import { playChoices, resumeSeconds, type PlayRequest } from "./browseModel.ts";
import type { Clock } from "../api/clock.ts";
import type { NativeSession } from "../session/session.ts";
import { TITLE_ART_KEY, profileSettings } from "../contracts/v2/settings.ts";

export interface PersonalChange {
    readonly target: boolean;
    readonly pending: boolean;
    readonly failed: boolean;
}

export class DetailsState {
    detail: ItemDetail;
    selectedFileId: string | undefined;
    audioOpen = false;
    preparingPlay = false;
    failedPlay: PlayRequest | undefined;
    private audioPick: { fileId: string; ordinal: number; inventory: string } | undefined;
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
    private readonly changed: (audioClosed?: boolean) => void;
    private readonly watchedChanged: (detail: ItemDetail, signal: AbortSignal) => Promise<void>;
    private readonly pendingElsewhere: () => boolean;

    constructor(detail: ItemDetail, session: NativeSession, changed: (audioClosed?: boolean) => void, watchedChanged: (detail: ItemDetail, signal: AbortSignal) => Promise<void>, pendingElsewhere: () => boolean = () => false) {
        this.detail = detail;
        this.session = session;
        this.changed = changed;
        this.watchedChanged = watchedChanged;
        this.pendingElsewhere = pendingElsewhere;
        if (detail.played !== undefined && ["movie", "episode", "series", "season"].includes(detail.type)) this.values.set("watched", detail.played);
    }

    get pending(): boolean { return [...this.changes.values()].some(change => change.pending); }
    get busy(): boolean { return this.pending || this.pendingElsewhere(); }

    start(mode: "full" | "personal" = "full"): void {
        if (this.controller !== undefined) return;
        this.controller = new AbortController();
        this.stopAuthority = this.session.onAuthorityChange(() => { this.stop(); this.changed(); });
        if (mode === "full") this.loadTitleArt();
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
        this.controller?.abort();
        this.controller = undefined;
        this.stopAuthority?.();
        this.stopAuthority = undefined;
        this.titleArt = undefined;
        this.titleArtPolicy = "pending";
        this.audioOpen = false;
        this.preparingPlay = false;
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
            let capability;
            try { capability = await this.read(operations.settingsCapabilities(), controller); }
            catch (error) {
                if (error instanceof ApiError && (error.status === 404 || error.status === 501)) {
                    if (this.current(controller)) this.titleArtPolicy = "compatibility";
                    return;
                }
                throw error;
            }
            if (!this.current(controller)) return;
            if (capability.apiVersion !== 1 || capability.state !== "available" || !capability.allowed) throw new Error("Title-art settings unavailable");
            if (capability.manifestRevision < 16) { this.titleArtPolicy = "compatibility"; return; }
            const contract = await this.read(operations.settingsContract(), controller);
            if (!this.current(controller)) return;
            if (contract.revision < capability.manifestRevision || !profileSettings(contract, capability).some(def => def.key === TITLE_ART_KEY)) throw new Error("Incompatible title-art definition");
            const profile = this.session.activeProfile;
            if (profile === undefined) return;
            const effective = await this.read(operations.effectiveSettings([TITLE_ART_KEY], { profileId: profile.id, deviceId: this.session.http.deviceId, manifestRevision: contract.revision }), controller);
            if (!this.current(controller)) return;
            const value = effective.get(TITLE_ART_KEY)?.value;
            if (typeof value !== "boolean") throw new Error("Missing title-art boolean");
            this.titleArt = value;
            this.titleArtPolicy = "supported";
        };
        run().then(() => { if (this.current(controller)) this.changed(); }, () => {
            if (!this.current(controller)) return;
            this.titleArtPolicy = "failed";
            this.changed();
        });
    }

    select(fileId: string): void {
        if (!this.detail.versions.some((file) => file.fileId === fileId)) return;
        if (fileId !== playChoices(this.detail, this.selectedFileId)?.fromStart.fileId) this.audioPick = undefined;
        this.selectedFileId = fileId;
        this.changed();
    }

    restore(previous: DetailsState | undefined): void {
        if (previous === undefined) return;
        if (this.detail.versions.some(file => file.fileId === previous.selectedFileId)) this.selectedFileId = previous.selectedFileId;
        this.audioPick = previous.audioPick;
        this.audioTrackId();
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

    showAudio(): void { this.audioOpen = true; this.changed(); }
    closeAudio(): void { this.audioOpen = false; this.changed(true); }

    selectAudio(ordinal: number | undefined): void {
        const fileId = playChoices(this.detail, this.selectedFileId)?.fromStart.fileId;
        const file = this.detail.versions.find(file => file.fileId === fileId);
        if (file === undefined || (ordinal !== undefined && file.audio?.[ordinal] === undefined)) return;
        this.audioPick = ordinal === undefined ? undefined : { fileId: file.fileId, ordinal, inventory: JSON.stringify([file.audio, file.audioMetadata]) };
        this.closeAudio();
    }

    preparePlay(request: PlayRequest, clock: Clock, handoff: (request: PlayRequest) => void): void {
        const controller = this.controller;
        if (controller === undefined || this.preparingPlay) return;
        this.failedPlay = undefined;
        if (request.startSeconds === 0) { handoff(request); return; }
        this.preparingPlay = true;
        this.changed();
        this.freshPosition(request, clock, controller.signal).then(position => {
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

    private async freshPosition(request: PlayRequest, clock: Clock, signal: AbortSignal): Promise<number> {
        const controller = new AbortController();
        const abort = (): void => controller.abort();
        signal.addEventListener("abort", abort, { once: true });
        let cancel = (): void => undefined;
        try {
            const timeout = new Promise<never>((_resolve, reject) => {
                cancel = clock.schedule(() => { reject(new ApiError({ kind: "timeout" })); controller.abort(); }, 3000);
            });
            const fresh = await Promise.race([this.read(detailOperations.resumePosition(request.contentId, request.fileId), controller), timeout]);
            return resumeSeconds(fresh.position, fresh.duration) ?? 0;
        } catch (error) {
            if (!signal.aborted && error instanceof ApiError && (error.failure.kind === "network" || error.failure.kind === "timeout" || error.status === 501 || error.status === 503)) return request.startSeconds ?? 0;
            throw error;
        } finally {
            cancel();
            signal.removeEventListener("abort", abort);
        }
    }

    private read<T>(spec: RequestSpec<T>, controller: AbortController): Promise<T> {
        return this.session.call({ ...spec, profileScoped: true, signal: controller.signal });
    }

    private current(controller: AbortController): boolean {
        return this.controller === controller && !controller.signal.aborted;
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
            }
            return detail.played;
        }
        const membership = await this.read(detailOperations.membership(kind, this.detail.id), controller);
        if (membership.id !== this.detail.id) throw new Error("Membership item mismatch");
        if (this.current(controller)) this.values.set(kind, membership.member);
        return membership.member;
    }
}
