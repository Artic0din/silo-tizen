import { ApiError } from "../api/errors.ts";
import type { RequestSpec } from "../api/http.ts";
import type { NativeSession } from "../session/session.ts";

export interface TrackPreferenceOperations<Pick, Actual> {
    read(key: string): RequestSpec<Actual>;
    write(key: string, pick: Pick | undefined): RequestSpec<undefined>;
    matches(actual: Actual | undefined, pick: Pick | undefined): boolean;
}

const trackDeliveries = new WeakMap<NativeSession, Map<string, { writing: Promise<void>; count: number }>>();

/** One Details owner serializes its track choices, including a retained return from playback. */
export class PreplayTrackPreference<Pick, Actual> {
    pending = false;
    failed = false;
    private latest: { pick: Pick | undefined } | undefined;
    private controller: AbortController | undefined;
    private readonly delivery: { writing: Promise<void>; count: number };

    private readonly session: NativeSession;
    private readonly key: string;
    private readonly changed: () => void;
    private readonly refresh: (signal: AbortSignal) => Promise<void>;

    private readonly operations: TrackPreferenceOperations<Pick, Actual>;

    constructor(operations: TrackPreferenceOperations<Pick, Actual>, session: NativeSession, key: string, changed: () => void, refresh: (signal: AbortSignal) => Promise<void>) {
        this.operations = operations;
        this.session = session;
        this.key = key;
        this.changed = changed;
        this.refresh = refresh;
        let owners = trackDeliveries.get(session);
        if (owners === undefined) { owners = new Map(); trackDeliveries.set(session, owners); }
        let delivery = owners.get(operations.write(key, undefined).path);
        if (delivery === undefined) { delivery = { writing: Promise.resolve(), count: 0 }; owners.set(operations.write(key, undefined).path, delivery); }
        this.delivery = delivery;
    }

    start(): void {
        const controller = new AbortController();
        this.controller = controller;
        if (this.latest === undefined && this.delivery.count === 0 && !this.failed) return;
        const target = this.latest;
        this.pending = true;
        this.failed = false;
        this.changed();
        const run = async (): Promise<void> => {
            await this.delivery.writing;
            if (controller.signal.aborted) return;
            if (target !== undefined && !this.operations.matches(await this.read(controller), target.pick)) throw new Error("Track preference needs confirmation");
            if (!controller.signal.aborted) await this.refresh(controller.signal);
        };
        run().then(() => {
            if (this.controller !== controller || controller.signal.aborted) return;
            this.pending = false; this.failed = false;
            if (this.latest !== target) this.send();
            else { this.latest = undefined; this.changed(); }
        }, () => {
            if (this.controller !== controller || controller.signal.aborted) return;
            this.pending = false; this.failed = true; this.changed();
        });
    }
    stop(): void {
        this.controller?.abort();
        this.controller = undefined;
        if (this.pending) this.failed = true;
        this.pending = false;
    }

    restore(previous: PreplayTrackPreference<Pick, Actual>): void {
        if (previous.session !== this.session || previous.key !== this.key) return;
        this.latest = previous.latest;
        this.failed = previous.failed;
    }

    choose(pick: Pick | undefined): void {
        if (this.controller === undefined) return;
        this.latest = { pick };
        if (!this.pending) this.send();
    }

    retry(): void {
        if (this.pending || !this.failed) return;
        if (this.latest !== undefined) this.send();
        else this.start();
    }

    private async read(controller: AbortController) {
        try { return await this.session.call({ ...this.operations.read(this.key), profileScoped: true, signal: controller.signal }); }
        catch (error) { if (error instanceof ApiError && error.status === 404) return undefined; throw error; }
    }

    private send(): void {
        const controller = this.controller, target = this.latest;
        if (controller === undefined || target === undefined) return;
        const reconcile = this.failed;
        const before = this.delivery.writing;
        let release = (): void => undefined;
        this.delivery.writing = new Promise<void>(resolve => { release = resolve; });
        this.delivery.count++;
        const finish = (): void => { this.delivery.count--; release(); };
        this.pending = true;
        this.failed = false;
        this.changed();
        const current = (): boolean => this.controller === controller && !controller.signal.aborted;
        const run = async (): Promise<void> => {
            await before;
            if (!current()) return;
            if (reconcile && this.operations.matches(await this.read(controller), target.pick)) {
                if (current()) await this.refresh(controller.signal);
                return;
            }
            if (!current()) return;
            // Keep the request alive across Back so a retained owner can wait for its answer.
            const write = this.session.call({ ...this.operations.write(this.key, target.pick), profileScoped: true, replayAfterRefresh: false });
            await write;
            if (!current()) return;
            if (!this.operations.matches(await this.read(controller), target.pick)) throw new Error("Track preference was not applied");
            if (current()) await this.refresh(controller.signal);
        };
        run().then(() => {
            finish();
            if (!current()) return;
            this.pending = false;
            if (this.latest !== target) this.send();
            else { this.latest = undefined; this.changed(); }
        }, () => {
            finish();
            if (!current()) return;
            this.pending = false;
            this.failed = true;
            this.changed();
        });
    }
}
