import { sleep, type Clock } from "../api/clock.ts";
import { ApiError } from "../api/errors.ts";
import type { Person } from "../contracts/v2/details.ts";

const REFRESH_WINDOW_MS = 120_000;
const POLL_INTERVAL_MS = 3_000;
const SETTLED_POLLS = 5;

function incomplete(person: Person): boolean {
    return [person.bio, person.photoUrl, person.birthDate].some(value => !value?.trim());
}

/** Visit-scoped refresh; filter/page reads never own or restart its polling. */
export class PersonMetadataRefresh {
    private requested = false;
    private exhausted = false;
    private flight: AbortSignal | undefined;
    private readonly clock: Clock;
    private readonly current: () => Person | undefined;
    private readonly dispatch: (signal: AbortSignal) => Promise<undefined>;
    private readonly read: (signal: AbortSignal) => Promise<Person>;
    private readonly changed: (person?: Person) => void;

    constructor(
        clock: Clock,
        current: () => Person | undefined,
        dispatch: (signal: AbortSignal) => Promise<undefined>,
        read: (signal: AbortSignal) => Promise<Person>,
        changed: (person?: Person) => void,
    ) {
        this.clock = clock;
        this.current = current;
        this.dispatch = dispatch;
        this.read = read;
        this.changed = changed;
    }

    get refreshing(): boolean { return this.flight !== undefined && !this.flight.aborted; }

    start(signal: AbortSignal): void {
        const person = this.current();
        if (signal.aborted || this.refreshing || this.exhausted || person === undefined || !incomplete(person)) return;
        this.flight = signal;
        const dispatch = !this.requested;
        this.requested = true;
        this.changed();
        void this.run(signal, dispatch).finally(() => {
            if (this.flight !== signal) return;
            this.flight = undefined;
            if (!signal.aborted) this.exhausted = true;
            this.changed();
        });
    }

    private async run(signal: AbortSignal, dispatch: boolean): Promise<void> {
        if (dispatch) {
            try { await this.dispatch(signal); }
            catch (error) {
                if (signal.aborted) return;
                if (error instanceof ApiError && error.failure.kind !== "network" && error.failure.kind !== "timeout") {
                    const status = error.status;
                    const poll = error.failure.kind === "invalid_response" || (status !== undefined && ((status >= 200 && status < 300) || status === 429 || (status >= 500 && status <= 599 && status !== 503)));
                    if (!poll) return;
                }
            }
        }
        const deadline = this.clock.now() + REFRESH_WINDOW_MS;
        let unchanged = 0;
        while (!signal.aborted && this.clock.now() < deadline) {
            try { await sleep(this.clock, POLL_INTERVAL_MS, signal, () => new ApiError({ kind: "aborted" })); }
            catch { return; }
            try {
                const person = await this.read(signal);
                if (signal.aborted) return;
                if (JSON.stringify(person) === JSON.stringify(this.current())) {
                    if (++unchanged >= SETTLED_POLLS) return;
                    continue;
                }
                unchanged = 0;
                this.changed(person);
                if (!incomplete(person)) return;
            } catch {
                // A failed poll leaves the mounted person usable until the next bounded read.
            }
        }
    }
}
