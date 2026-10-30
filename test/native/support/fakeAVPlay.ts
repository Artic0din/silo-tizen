// Samsung AVPlay as its API reference documents it, for the player tests. Calls outside a
// method's documented states throw InvalidStateError, as the platform does. prepareAsync and
// seekTo callbacks are kept and fire whenever the test releases them, even after close() or a
// newer open(): the platform cannot cancel them, so the player must ignore late ones. Listener
// events go to whichever listener is registered when they fire, and a test can also hold an old
// listener object and call it late.

import type { AVPlay, AVPlayAsyncError, AVPlayListener } from "../../../src/player/avplay.ts";

type State = "NONE" | "IDLE" | "READY" | "PLAYING" | "PAUSED";

interface Pending {
    readonly success: () => void;
    readonly error: (error: AVPlayAsyncError) => void;
    /** The open() this call was made under. */
    readonly stream: number;
}

class InvalidStateError extends Error {
    constructor(method: string, state: State) {
        super(`${method} is not allowed in ${state}`);
        this.name = "InvalidStateError";
    }
}

export class FakeAVPlay implements AVPlay {
    state: State = "NONE";
    /** Every call in order, e.g. "open <url>", "seekTo 12500", "play". */
    readonly calls: string[] = [];
    readonly listeners: AVPlayListener[] = [];
    readonly urls: string[] = [];
    positionMs = 0;
    private stream = 0;
    private readonly prepares: Pending[] = [];
    private readonly seeks: (Pending & { readonly ms: number })[] = [];

    get listener(): AVPlayListener | undefined {
        return this.listeners[this.listeners.length - 1];
    }

    open(url: string): void {
        this.require("open", ["NONE", "IDLE"]);
        this.stream++;
        this.state = "IDLE";
        this.positionMs = 0;
        this.urls.push(url);
        this.calls.push(`open ${url}`);
    }

    close(): void {
        this.require("close", ["NONE", "IDLE", "READY", "PLAYING", "PAUSED"]);
        this.calls.push("close");
        this.state = "NONE";
    }

    prepareAsync(success: () => void, error: (error: AVPlayAsyncError) => void): void {
        this.require("prepareAsync", ["IDLE", "READY"]);
        this.calls.push("prepareAsync");
        this.prepares.push({ success, error, stream: this.stream });
    }

    setDisplayRect(): void {
        this.require("setDisplayRect", ["IDLE", "READY", "PLAYING", "PAUSED"]);
    }

    setListener(listener: AVPlayListener): void {
        this.listeners.push(listener);
    }

    play(): void {
        this.require("play", ["READY", "PLAYING", "PAUSED"]);
        this.calls.push("play");
        this.state = "PLAYING";
    }

    pause(): void {
        this.require("pause", ["PLAYING", "PAUSED"]);
        this.calls.push("pause");
        this.state = "PAUSED";
    }

    seekTo(milliseconds: number, success: () => void, error: (error: AVPlayAsyncError) => void): void {
        this.require("seekTo", ["IDLE", "READY", "PLAYING", "PAUSED"]);
        this.calls.push(`seekTo ${milliseconds}`);
        this.seeks.push({ success, error, stream: this.stream, ms: milliseconds });
    }

    stop(): void {
        this.calls.push("stop");
        if (this.state !== "NONE") {
            this.state = "IDLE";
        }
    }

    getState(): string {
        return this.state;
    }

    getCurrentTime(): number {
        return this.positionMs;
    }

    // --- test controls ---

    get pendingPrepares(): number {
        return this.prepares.length;
    }

    /** Fires the oldest pending prepareAsync callback, current or not. */
    finishPrepare(errorName?: string): void {
        const pending = this.prepares.shift();
        if (pending === undefined) {
            throw new Error("no prepareAsync pending");
        }
        if (errorName !== undefined) {
            pending.error({ name: errorName });
            return;
        }
        if (pending.stream === this.stream && this.state === "IDLE") {
            this.state = "READY";
        }
        pending.success();
    }

    /** Fires the oldest pending seekTo callback. */
    finishSeek(errorName?: string): void {
        const pending = this.seeks.shift();
        if (pending === undefined) {
            throw new Error("no seekTo pending");
        }
        if (errorName !== undefined) {
            pending.error({ name: errorName });
            return;
        }
        if (pending.stream === this.stream) {
            this.positionMs = pending.ms;
        }
        pending.success();
    }

    /** Playback reached `ms` on the current listener. */
    tick(ms: number): void {
        this.positionMs = ms;
        this.listener?.oncurrentplaytime(ms);
    }

    private require(method: string, states: readonly State[]): void {
        if (this.seeks.length > 0) {
            // "During this async operation, the other API would not be allowed."
            throw new InvalidStateError(`${method} during seekTo`, this.state);
        }
        if (states.indexOf(this.state) === -1) {
            throw new InvalidStateError(method, this.state);
        }
    }
}
