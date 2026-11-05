import { sleep, systemClock, type Clock } from "../api/clock.ts";
import { ApiError } from "../api/errors.ts";
import type { ItemDetail } from "../contracts/v2/catalog.ts";
import type { decodeTrailerRefresh } from "../contracts/v2/trailers.ts";
import { trailerCards } from "./trailerRail.ts";

const POLL_MS = 3000;
const WINDOW_MS = 120000;
const MINIMUM_OBSERVATION_MS = 60000;
const SETTLED_POLLS = 5;
const TERMINAL_MS = 3000;

/** Apple TrailerFetchCoordinator: one request, then baseline-relative observation. */
export class TrailerFetch {
    message: string | undefined;
    fetching = false;
    private controller: AbortController | undefined;
    private baseline: ItemDetail | undefined;
    private interrupted = false;
    private dismiss: (() => void) | undefined;
    private readonly request: (signal: AbortSignal) => Promise<ReturnType<typeof decodeTrailerRefresh>>;
    private readonly read: (signal: AbortSignal) => Promise<ItemDetail>;
    private readonly found: (detail: ItemDetail) => void;
    private readonly changed: () => void;
    private readonly clock: Clock;

    constructor(
        request: (signal: AbortSignal) => Promise<ReturnType<typeof decodeTrailerRefresh>>,
        read: (signal: AbortSignal) => Promise<ItemDetail>,
        found: (detail: ItemDetail) => void,
        changed: () => void,
        clock: Clock = systemClock,
    ) { this.request = request; this.read = read; this.found = found; this.changed = changed; this.clock = clock; }

    start(baseline: ItemDetail): void {
        if (this.fetching) return;
        this.baseline = baseline;
        this.interrupted = false;
        this.launch(true);
    }

    stop(resumable = true): void {
        if (this.fetching) this.interrupted = resumable;
        else if (!resumable) this.interrupted = false;
        this.controller?.abort(); this.controller = undefined;
        this.dismiss?.(); this.dismiss = undefined;
        this.fetching = false; this.message = undefined;
        if (!resumable) this.baseline = undefined;
    }

    resume(): void {
        if (!this.interrupted || this.fetching) return;
        this.interrupted = false;
        this.launch(false);
    }

    restore(previous: TrailerFetch): void {
        if (!previous.interrupted) return;
        this.baseline = previous.baseline;
        this.interrupted = true;
        previous.stop(false);
    }

    private launch(post: boolean): void {
        this.dismiss?.();
        const controller = new AbortController(); this.controller = controller;
        this.fetching = true; this.message = "Finding trailers…"; this.changed();
        void this.run(post, controller).catch(error => {
            if (controller.signal.aborted) return;
            this.finish(error instanceof ApiError && error.status === 429 ? "Please wait a moment and try again" : "Couldn't reach the server — try again", controller);
        });
    }

    private finish(message: string | undefined, controller: AbortController): void {
        if (controller.signal.aborted) return;
        this.fetching = false; this.message = message; this.changed();
        if (message !== undefined) this.dismiss = this.clock.schedule(() => {
            if (this.controller !== controller) return;
            this.message = undefined; this.changed();
        }, TERMINAL_MS);
    }

    private async run(post: boolean, controller: AbortController): Promise<void> {
        const baseline = this.baseline;
        if (baseline === undefined) return;
        if (post) {
            const response = await this.request(controller.signal);
            if (controller.signal.aborted) return;
            if (response.status !== "queued") {
                this.finish(response.status === "cooldown" ? "Trailers were checked recently" : response.status === "disabled" ? "Trailers are disabled for this library" : "No trailers found", controller);
                return;
            }
        }
        const started = this.clock.now();
        const keys = new Set(identities(baseline));
        let signature: string | undefined;
        let settled = 0;
        while (!controller.signal.aborted && this.clock.now() - started < WINDOW_MS) {
            await sleep(this.clock, POLL_MS, controller.signal, () => new Error("Cancelled"));
            let detail: ItemDetail;
            // Failed observations cannot settle the result; the fixed window still ends it.
            try { detail = await this.read(controller.signal); } catch { continue; }
            if (controller.signal.aborted) return;
            if (detail.id !== baseline.id) continue;
            if (identities(detail).some(key => !keys.has(key))) {
                this.found(detail); this.finish(undefined, controller); return;
            }
            const current = JSON.stringify({ videos: detail.videos?.map(video => `${video.site.toLowerCase()}:${video.siteKey}`).sort(), extras: detail.extras?.map(extra => extra.contentId).sort(), overview: detail.overview, tagline: detail.tagline, poster: detail.posterUrl, backdrop: detail.backdropUrl, ratings: detail.extra?.ratings });
            settled = current === signature ? settled + 1 : 0;
            signature = current;
            if (settled >= SETTLED_POLLS && this.clock.now() - started >= MINIMUM_OBSERVATION_MS) break;
        }
        this.finish("No trailers found", controller);
    }
}

function identities(detail: ItemDetail): string[] {
    return trailerCards(detail.extras, detail.videos, true).map(card => card.role === "local" ? `local:${card.extra.contentId}` : `remote:${card.site.toLowerCase()}:${card.siteKey}`);
}
