import type { Clock } from "../api/clock.ts";
import { abortedError } from "../api/http.ts";
import { operations } from "../api/operations.ts";
import { thumbnailAt, type SeekThumbnail, type TrickplayManifest } from "../contracts/v2/trickplay.ts";
import type { NativeSession } from "../session/session.ts";

export type ThumbnailSheetLoader = (tile: SeekThumbnail, signal: AbortSignal) => Promise<void>;

const RENEWAL_MARGIN_MS = 30000;
const FAILURE_BACKOFF_MS = 30000;

/** Optional decoration for one adopted plan; never opens, seeks or reports playback. */
export class SeekThumbnails {
    private readonly session: NativeSession;
    private readonly clock: Clock;
    private readonly contentId: string;
    private readonly fileId: string;
    private readonly authority: AbortSignal;
    private active: AbortController | undefined;
    private manifest: TrickplayManifest | undefined;
    private available: boolean | undefined;
    private failedUntil = 0;
    private closed = false;

    constructor(session: NativeSession, clock: Clock, contentId: string, fileId: string) {
        this.session = session;
        this.clock = clock;
        this.contentId = contentId;
        this.fileId = fileId;
        this.authority = session.authoritySignal;
    }

    destroy(): void {
        this.closed = true;
        this.active?.abort();
        this.active = undefined;
        this.manifest = undefined;
    }

    async load(seconds: number, signal: AbortSignal, loadSheet: ThumbnailSheetLoader): Promise<SeekThumbnail | undefined> {
        this.active?.abort();
        if (this.closed || this.authority.aborted || signal.aborted || !Number.isFinite(seconds) || seconds < 0 || this.clock.now() < this.failedUntil) return undefined;
        const request = new AbortController();
        this.active = request;
        const abort = (): void => request.abort();
        signal.addEventListener("abort", abort, { once: true });
        this.authority.addEventListener("abort", abort, { once: true });
        const current = (): void => {
            if (request.signal.aborted || this.closed || this.active !== request) throw abortedError();
        };
        try {
            if (this.available === undefined) {
                const files = await this.session.call({ ...operations.watchTrickplayFiles(this.contentId, this.fileId), profileScoped: true, signal: request.signal });
                current();
                this.available = files.includes(this.fileId);
            }
            if (!this.available) return undefined;
            let manifest = this.manifest;
            if (manifest === undefined || manifest.expiresAt <= this.clock.now() + RENEWAL_MARGIN_MS) {
                manifest = await this.renew(request.signal);
                current();
                this.manifest = manifest;
            }
            for (let attempt = 0; attempt < 2; attempt++) {
                const tile = thumbnailAt(manifest, seconds);
                if (tile === undefined) return undefined;
                try {
                    await loadSheet(tile, request.signal);
                    current();
                    return tile;
                } catch (error) {
                    current();
                    // DOM image errors do not expose HTTP status: renew once for any failed sheet.
                    if (attempt !== 0) throw error;
                    manifest = await this.renew(request.signal);
                    current();
                    this.manifest = manifest;
                }
            }
        } catch {
            if (!request.signal.aborted && !this.closed && this.active === request) {
                this.manifest = undefined;
                this.failedUntil = this.clock.now() + FAILURE_BACKOFF_MS;
            }
        } finally {
            signal.removeEventListener("abort", abort);
            this.authority.removeEventListener("abort", abort);
            if (this.active === request) this.active = undefined;
        }
        return undefined;
    }

    private async renew(signal: AbortSignal): Promise<TrickplayManifest> {
        const manifest = await this.session.call({
            ...operations.watchTrickplay(this.contentId, this.fileId, this.session.http.base.origin), profileScoped: true, signal,
        });
        if (manifest.expiresAt <= this.clock.now()) throw new Error("Expired seek thumbnails");
        return manifest;
    }
}
