// The Skip Intro and Watch Intro offers' timer, ported from silo-apple `IntroSkipPrompt` (`.skip` and `.undo`).
// The `always` skip itself belongs to the controller, which owns the seek.

import type { Clock } from "../api/clock.ts";

/** The spec's INTRO_PROMPT_SECONDS. */
export const SKIP_PROMPT_MS = 5000;
/** The spec's PLAYBACK_PAUSE_GRACE_MS: a stall shorter than this is a rebuffer and leaves the timer alone. */
export const SKIP_PAUSE_GRACE_MS = 1500;

/** `skip` is the `ask` offer. `undo` is the Watch Intro offer after an automatic skip. */
export type SkipKind = "skip" | "undo";

/** `playing` runs the timer, `paused` freezes it at once, `stalled` (loading or rebuffering) freezes it after the grace. */
export type SkipActivity = "playing" | "stalled" | "paused";

/** What the pill's fill needs: how far it has crept now, and whether it is moving. */
export interface SkipFill {
    readonly elapsedMs: number;
    readonly running: boolean;
    /** Changes whenever the timer is armed or frozen, so the fill must restart from `elapsedMs`. */
    readonly revision: number;
}

export class SkipPrompt {
    /** Intros decided in this playback. A decided intro is never offered again, even after scrubbing back into it. */
    private readonly resolved = new Set<string>();
    /** The intro whose offer timed out while the playhead is still inside it: no re-offer until the playhead leaves. */
    private expiredKey: string | undefined;
    private active: string | undefined;
    private activeKind: SkipKind = "skip";
    private remainingMs = SKIP_PROMPT_MS;
    /** Clock time the timer runs out; undefined while a pause holds it. */
    private deadline: number | undefined;
    private remainingAtStall: number | undefined;
    private activity: SkipActivity = "paused";
    private cancelExpiry: (() => void) | undefined;
    private cancelGrace: (() => void) | undefined;
    private revision = 0;

    private readonly clock: Clock;
    private readonly expired: () => void;

    constructor(clock: Clock, expired: () => void) {
        this.clock = clock;
        this.expired = expired;
    }

    get visible(): boolean {
        return this.active !== undefined;
    }

    get kind(): SkipKind | undefined {
        return this.active === undefined ? undefined : this.activeKind;
    }

    get fill(): SkipFill {
        // While the timer runs the deadline is the truth: remainingMs is only what the last arm or freeze set.
        const remainingMs = this.deadline === undefined ? this.remainingMs : Math.max(0, this.deadline - this.clock.now());
        return { elapsedMs: SKIP_PROMPT_MS - remainingMs, running: this.deadline !== undefined, revision: this.revision };
    }

    /**
     * `key` identifies the intro the playhead is inside, or is undefined outside one (and in `never` and `always`).
     * For `undo` it identifies the skip just made, which the pill outlives: the playhead has already left the intro.
     * The two kinds use distinct keys.
     */
    update(key: string | undefined, activity: SkipActivity, kind: SkipKind = "skip"): void {
        this.activity = activity;
        if (key === undefined) {
            this.expiredKey = undefined;
            this.clear();
            return;
        }
        if (this.active !== undefined && (this.active !== key || this.activeKind !== kind)) {
            this.expiredKey = undefined;
            this.clear();
        }
        if (this.resolved.has(key) || key === this.expiredKey) {
            this.clear();
            return;
        }
        if (this.active !== undefined) {
            this.follow();
            return;
        }
        // The pill and its fill start together, once playback is actually running.
        if (activity !== "playing") return;
        this.active = key;
        this.activeKind = kind;
        this.arm(SKIP_PROMPT_MS);
    }

    /** Nothing is playing (loading, reconnecting, replanning) but the content is the same: a stall, so the timer freezes after the grace. */
    stall(): void {
        this.activity = "stalled";
        if (this.active !== undefined) this.follow();
    }

    /** Select or Back: the intro is decided and the pill goes. False when no pill was showing. */
    resolve(): boolean {
        if (this.active === undefined) return false;
        this.resolved.add(this.active);
        this.expiredKey = undefined;
        this.clear();
        return true;
    }

    /** Different content: forget every decision. */
    reset(): void {
        this.resolved.clear();
        this.expiredKey = undefined;
        this.clear();
    }

    private arm(remainingMs: number): void {
        this.cancelTimers();
        this.remainingAtStall = undefined;
        this.remainingMs = Math.max(0, remainingMs);
        this.deadline = this.clock.now() + this.remainingMs;
        this.revision++;
        this.scheduleExpiry(this.remainingMs);
    }

    private freeze(remainingMs: number): void {
        this.cancelTimers();
        this.remainingAtStall = undefined;
        this.remainingMs = remainingMs;
        this.deadline = undefined;
        this.revision++;
    }

    private scheduleExpiry(delayMs: number): void {
        this.cancelExpiry?.();
        this.cancelExpiry = this.clock.schedule(() => this.expire(), Math.max(0, delayMs));
    }

    /** A pause freezes the timer and play continues it. A stall holds the expiry for the grace window, then freezes. */
    private follow(): void {
        const deadline = this.deadline;
        switch (this.activity) {
            case "playing":
                this.cancelGrace?.();
                this.cancelGrace = undefined;
                if (deadline === undefined) {
                    this.arm(this.remainingMs);
                } else if (this.remainingAtStall !== undefined) {
                    this.remainingAtStall = undefined;
                    const left = deadline - this.clock.now();
                    if (left > 0) this.scheduleExpiry(left);
                    else this.expire();
                }
                return;
            case "paused":
                if (deadline === undefined) return;
                this.freeze(this.remainingAtStall ?? Math.max(0, deadline - this.clock.now()));
                return;
            case "stalled":
                if (deadline === undefined || this.remainingAtStall !== undefined) return;
                this.remainingAtStall = Math.max(0, deadline - this.clock.now());
                this.cancelExpiry?.();
                this.cancelExpiry = undefined;
                this.cancelGrace = this.clock.schedule(() => {
                    const left = this.remainingAtStall;
                    if (this.activity === "playing" || left === undefined) return;
                    this.freeze(left);
                    this.expired();
                }, SKIP_PAUSE_GRACE_MS);
        }
    }

    /** An `undo` the viewer let run out is decided, as in Apple; a `skip` offer only waits for the playhead to leave the intro. */
    private expire(): void {
        if (this.active === undefined) return;
        if (this.activeKind === "undo") this.resolved.add(this.active);
        else this.expiredKey = this.active;
        this.clear();
        this.expired();
    }

    private cancelTimers(): void {
        this.cancelExpiry?.();
        this.cancelExpiry = undefined;
        this.cancelGrace?.();
        this.cancelGrace = undefined;
    }

    private clear(): void {
        this.cancelTimers();
        this.remainingAtStall = undefined;
        this.active = undefined;
        this.deadline = undefined;
    }
}
