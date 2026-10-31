import { ApiError } from "../api/errors.ts";
import type { RequestSpec } from "../api/http.ts";
import { integer, object, string, WireError } from "../contracts/v2/wire.ts";
import type { NativeSession } from "../session/session.ts";

export function decodeRating(value: unknown, id: string): number {
    const row = object(value, "rating");
    if (string(row, "item_id", "rating") !== id) throw new WireError("rating.item_id", "the requested item");
    const stars = integer(row, "rating", "rating");
    if (stars < 1 || stars > 5) throw new WireError("rating.rating", "1 to 5 stars");
    return stars;
}

export const ratingOperations = {
    read: (id: string): RequestSpec<number> => ({ method: "GET", path: `/ratings/${encodeURIComponent(id)}`, retry: "safe", decode: value => decodeRating(value, id) }),
    write: (id: string, stars: number | null): RequestSpec<undefined> => {
        if (stars !== null && (!Number.isInteger(stars) || stars < 1 || stars > 5)) throw new RangeError("Rating must be 1 to 5 stars");
        return { method: stars === null ? "DELETE" : "PUT", path: `/ratings/${encodeURIComponent(id)}`, retry: "never", ...(stars === null ? {} : { body: { rating: stars } }), decode: () => undefined };
    },
};

export class RatingState {
    value: number | null | undefined;
    loading = false;
    pending = false;
    failed = false;
    failedTarget: number | null | undefined;
    private controller: AbortController | undefined;

    private readonly session: NativeSession;
    private readonly id: string;
    private readonly changed: () => void;
    private readonly busy: () => boolean;

    constructor(session: NativeSession, id: string, changed: () => void, busy: () => boolean) {
        this.session = session;
        this.id = id;
        this.changed = changed;
        this.busy = busy;
    }

    start(): void {
        this.controller = new AbortController();
        if (this.pending) { this.pending = false; this.failed = true; }
        this.load();
    }

    stop(): void { this.controller?.abort(); this.controller = undefined; this.loading = false; }

    private current(controller: AbortController): boolean { return this.controller === controller && !controller.signal.aborted; }

    private async read(controller: AbortController): Promise<number | null> {
        try { return await this.session.call({ ...ratingOperations.read(this.id), profileScoped: true, signal: controller.signal }); }
        catch (error) {
            if (error instanceof ApiError && error.status === 404) return null;
            throw error;
        }
    }

    load(): void {
        const controller = this.controller;
        if (controller === undefined || this.pending || this.loading) return;
        this.loading = true;
        this.failed = false;
        this.failedTarget = undefined;
        this.changed();
        this.read(controller).then(value => {
            if (!this.current(controller)) return;
            this.value = value;
            this.loading = false;
            this.changed();
        }, () => {
            if (!this.current(controller)) return;
            this.loading = false;
            this.failed = true;
            this.changed();
        });
    }

    save(target: number | null, reconcile = false): void {
        const controller = this.controller;
        if (controller === undefined || this.pending || this.loading || this.busy() || this.value === undefined) return;
        this.pending = true;
        this.failed = false;
        this.failedTarget = target;
        this.changed();
        const run = async (): Promise<void> => {
            if (reconcile) {
                const actual = await this.read(controller);
                if (!this.current(controller)) return;
                this.value = actual;
                if (actual === target) return;
            }
            await this.session.call({ ...ratingOperations.write(this.id, target), profileScoped: true, replayAfterRefresh: false, signal: controller.signal });
            if (!this.current(controller)) return;
            const actual = await this.read(controller);
            if (actual !== target) throw new Error("Rating was not applied");
            if (this.current(controller)) this.value = actual;
        };
        run().then(() => {
            if (!this.current(controller)) return;
            this.pending = false;
            this.failedTarget = undefined;
            this.changed();
        }, () => {
            if (!this.current(controller)) return;
            this.pending = false;
            this.failed = true;
            this.changed();
        });
    }
}
