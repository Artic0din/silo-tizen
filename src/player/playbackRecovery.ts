// Mid-stream reconnect (playback protocol v3 §6.2). A stream that already showed a frame and then
// lost the server is not a failed route: `failure_recovery` would drop the current recipe, so a
// direct-play viewer would come back on a transcode. Each attempt is a no-op `track_change` at the
// saved source position and tracks. A 404 (the session did not survive) may start once at that
// position; a terminal start does not start again. Delays are 1, 2, 4, 8, then 15 seconds, twelve
// attempts, 135 seconds of waiting. A loss within 30 seconds of a recovery keeps that budget.
//
// Tizen does not copy Apple's installation_changed retry. The session owns the installation and
// the profile authority fence; a changed installation or a revoked login ends the cycle.
// 410 playback_session_ended ends it too, with no replacement session.
//
// Visibility is separate and follows Samsung's AVPlay multitasking rule (Multimedia FAQ Q4,
// AVPlay `suspend` / `restoreAsync`): hide suspends a PLAYING or PAUSED pipeline, show restores
// it. `restoreAsync` is the non-blocking call. `bPrepare` stays false so the app does not call
// `prepare()`, which blocks the thread and leaves the picture black until preparation finishes.
// `restoreAsync` is not valid in READY, so a hide before play resumes with play/pause instead.
// There is no in-memory pipeline after a cold relaunch; that is a new play from the server's
// resume point, not `restore`. Hidden timers are cancelled. On show, the remaining delay is read
// from the clock, so a timer that did not run while hidden is not required.

import { ApiError } from "../api/errors.ts";
import { SessionError } from "../session/session.ts";

export const RECONNECT_MAX_ATTEMPTS = 12;
export const RECONNECT_MAX_DELAY_MS = 15000;
export const RECONNECT_STABLE_MS = 30000;

export type RecoveryStep = "replan" | "start";

export type RecoveryAction =
    | { readonly kind: "wait"; readonly delayMs: number }
    | { readonly kind: "give_up" }
    | { readonly kind: "join" };

export type RecoveryVerdict =
    | { readonly kind: "retry"; readonly retryAfterMs?: number }
    | { readonly kind: "start_new_session" }
    | { readonly kind: "give_up" }
    | { readonly kind: "installation_changed" }
    | { readonly kind: "ended" }
    | { readonly kind: "revoked" };

/** Delay before the next attempt once `attemptsAlreadyMade` attempts have been sent. */
export function reconnectDelayMs(attemptsAlreadyMade: number): number {
    const exponent = Math.min(16, Math.max(0, attemptsAlreadyMade));
    return Math.min(RECONNECT_MAX_DELAY_MS, 1000 * 2 ** exponent);
}

export function unanswered(error: unknown): boolean {
    return (error instanceof ApiError && (error.transient || error.problemId === "replan_in_progress"))
        || (error instanceof SessionError && error.reason === "unavailable");
}

export function recoveryVerdict(error: unknown, step: RecoveryStep): RecoveryVerdict {
    if (error instanceof SessionError && error.reason === "unavailable") return retryVerdict(error);
    if (!(error instanceof ApiError)) {
        return { kind: "give_up" };
    }
    if (error.aborted) {
        return { kind: "give_up" };
    }
    if (error.status === 410) {
        return { kind: "ended" };
    }
    if (error.status === 401 || error.status === 403) {
        return { kind: "revoked" };
    }
    if (error.problemId === "installation_changed") {
        return { kind: "installation_changed" };
    }
    if (unanswered(error)) {
        return retryVerdict(error);
    }
    switch (step) {
        case "replan":
            return { kind: "start_new_session" };
        case "start":
            return { kind: "give_up" };
        default: {
            const never: never = step;
            return never;
        }
    }
}

function retryVerdict(error: ApiError | SessionError): RecoveryVerdict {
    return error.retryAfterSeconds === undefined ? { kind: "retry" } : { kind: "retry", retryAfterMs: error.retryAfterSeconds * 1000 };
}

/** Budget for one reconnect cycle. No clock of its own; the controller schedules. */
export class PlaybackRecovery {
    active = false;
    generation = 0;
    attempts = 0;
    step: RecoveryStep = "replan";
    dueAt: number | undefined;
    private recoveredAt: number | undefined;

    begin(now: number, freshBudget: boolean, step: RecoveryStep): RecoveryAction {
        if (this.active) {
            return { kind: "join" };
        }
        this.active = true;
        this.generation += 1;
        this.step = step;
        const recent = this.recoveredAt !== undefined && now - this.recoveredAt < RECONNECT_STABLE_MS;
        if (freshBudget || !recent) {
            this.attempts = 0;
        }
        if (this.attempts >= RECONNECT_MAX_ATTEMPTS) {
            this.end(false, now);
            return { kind: "give_up" };
        }
        return { kind: "wait", delayMs: freshBudget ? 0 : reconnectDelayMs(this.attempts) };
    }

    beginAttempt(): void {
        this.attempts += 1;
    }

    retryLater(now: number): RecoveryAction {
        if (this.attempts >= RECONNECT_MAX_ATTEMPTS) {
            this.end(false, now);
            return { kind: "give_up" };
        }
        return { kind: "wait", delayMs: reconnectDelayMs(this.attempts) };
    }

    recovered(now: number): void {
        this.end(true, now);
    }

    end(recovered: boolean, now: number): void {
        const wasActive = this.active;
        this.active = false;
        this.dueAt = undefined;
        if (wasActive) {
            this.generation += 1;
        }
        if (recovered) {
            this.recoveredAt = now;
        }
    }
}
