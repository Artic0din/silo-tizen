// Time source for timeouts, polling and token expiry. Tests substitute a manual clock.

export interface Clock {
    now(): number;
    /** Runs `fn` after `ms`; returns a function that cancels it. */
    schedule(fn: () => void, ms: number): () => void;
}

export const systemClock: Clock = {
    now: () => Date.now(),
    schedule(fn, ms) {
        const handle = setTimeout(fn, ms);
        return () => clearTimeout(handle);
    },
};

/** Resolves after `ms`, or rejects with `onAbort()` once `signal` aborts. */
export function sleep(clock: Clock, ms: number, signal: AbortSignal, onAbort: () => Error): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
            reject(onAbort());
            return;
        }
        const abort = (): void => {
            cancel();
            reject(onAbort());
        };
        const cancel = clock.schedule(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, ms);
        signal.addEventListener("abort", abort, { once: true });
    });
}
