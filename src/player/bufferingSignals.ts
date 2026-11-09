// Turns the player's playback facts into BufferingQualityController's media events, so only the
// network's own buffering can count as a stall. A port of silo-apple's BufferingSignalMapper for
// AVPlay, which reports buffering only through onbufferingstart and onbufferingcomplete: there is
// no buffered-ahead figure (so no renderer wait), no byte counter (so no upstream-silence outage)
// and no software route. It holds no clock and does no I/O.

import type { WaitCause } from "./bufferingQuality.ts";

export interface BufferingSnapshot {
    /** A plan is adopted. */
    readonly hasActiveLoad: boolean;
    /** The viewer's intent: play, not pause. */
    readonly wantsToPlay: boolean;
    /** The current transport is open and showing a frame. */
    readonly started: boolean;
    /** AVPlay is between onbufferingstart and onbufferingcomplete. */
    readonly buffering: boolean;
    /** A seek has not landed yet. */
    readonly seekInFlight: boolean;
    /** The source is being reloaded rather than a new plan starting: a reconnect hand-off or a background restore. */
    readonly reloadInProgress: boolean;
    readonly reachedEnd: boolean;
    /** The playhead, in milliseconds of source time. */
    readonly playheadMs: number;
    /** The app is in the background and AVPlay is suspended. */
    readonly suspended: boolean;
    /** The player is reconnecting or the device is offline. */
    readonly connectionTrouble: boolean;
}

export type BufferingCall =
    | { readonly kind: "trouble"; readonly trouble: boolean }
    | { readonly kind: "playing" }
    | { readonly kind: "waiting"; readonly cause: WaitCause }
    | { readonly kind: "paused" };

type MediaState = { readonly kind: "playing" } | { readonly kind: "paused" } | { readonly kind: "waiting"; readonly cause: WaitCause };

const PLAYING: MediaState = { kind: "playing" };
const PAUSED: MediaState = { kind: "paused" };
const waiting = (cause: WaitCause): MediaState => ({ kind: "waiting", cause });

function same(a: MediaState | undefined, b: MediaState): boolean {
    return a !== undefined && a.kind === b.kind && (a.kind !== "waiting" || (b.kind === "waiting" && a.cause === b.cause));
}

export class BufferingSignalMapper {
    private state: MediaState | undefined;
    private trouble = false;
    /** A seek since playback last ran: the buffering that follows belongs to it until playback runs. */
    private seekSincePlaying = false;
    /** The adopted plan has neither run nor paused yet: a start the viewer means to play is the plan's wait. */
    private startPending = false;
    private planHasRun = true;
    /** A media request failed: an outage lasts until playback runs. */
    private requestFailed = false;
    /** Where the last seek landed, until the playhead moves past it: AVPlay can report playing over a frame it has not played on from. */
    private landing: "in_flight" | number | undefined;

    /** A media request failed (AVPlay reported a lost connection). */
    noteMediaRequestFailed(): void {
        this.requestFailed = true;
    }

    /** Forgets the state last reported, so the next update reports it again. */
    invalidate(): void {
        this.state = undefined;
    }

    /** A plan was adopted: it hears whether playback is already waiting, and starts with no outage. */
    planAdopted(): void {
        this.state = undefined;
        this.startPending = true;
        this.planHasRun = false;
        this.seekSincePlaying = false;
        this.requestFailed = false;
        this.landing = undefined;
    }

    update(snapshot: BufferingSnapshot): BufferingCall[] {
        const calls: BufferingCall[] = [];
        this.noteLanding(snapshot);
        if (this.planHasRun && snapshot.seekInFlight) this.seekSincePlaying = true;
        if (!snapshot.wantsToPlay || snapshot.suspended) this.startPending = false;
        let next = this.mediaState(snapshot);
        // Buffering after a seek stays the seek's until playback runs, even once the seek has landed.
        if (next.kind === "waiting" && next.cause === "network" && this.seekSincePlaying) next = waiting("seek");
        if (next.kind === "playing") {
            this.seekSincePlaying = false;
            this.startPending = false;
            this.planHasRun = true;
            this.requestFailed = false;
        }
        const trouble = snapshot.connectionTrouble || this.requestFailed;
        if (trouble !== this.trouble) {
            this.trouble = trouble;
            calls.push({ kind: "trouble", trouble });
        }
        if (same(this.state, next)) return calls;
        this.state = next;
        calls.push(next);
        return calls;
    }

    private noteLanding(s: BufferingSnapshot): void {
        if (s.seekInFlight) this.landing = "in_flight";
        else if (this.landing === "in_flight") this.landing = s.playheadMs;
        else if (this.landing !== undefined && s.playheadMs > this.landing) this.landing = undefined;
    }

    private get reloadWait(): MediaState {
        return this.startPending ? waiting("network") : waiting("reload");
    }

    private mediaState(s: BufferingSnapshot): MediaState {
        if (!s.hasActiveLoad) return s.wantsToPlay ? this.reloadWait : PAUSED;
        if (s.reachedEnd || !s.wantsToPlay || s.suspended) return PAUSED;
        if (s.seekInFlight) return this.planHasRun ? waiting("seek") : waiting("network");
        if (s.started && !s.buffering && this.landing === undefined) return PLAYING;
        if (s.reloadInProgress) return this.reloadWait;
        return waiting("network");
    }
}
