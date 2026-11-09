// Lowers quality when playback keeps buffering. A port of silo-apple's BufferingQualityController
// (iosApp/iosApp/Screens/Player, revision 97ecec1), whose spec is silo-server's
// docs/design/2026-10-17-buffering-quality.md. test/native/bufferingQuality.test.ts replays the
// published conformance vectors against it.
//
// The player feeds it plan adoptions, media events and the viewer's answers, and acts on what
// `onOutput` emits: replans to send, pills and notices to show, and `plan_summary` events.
// It does no I/O. Arithmetic is in integer milliseconds of an elapsed clock, so a change of the
// wall clock moves nothing.
//
// The trigger is evaluated when a stall ends (`playing`) and when a stall in progress reaches
// LONG_STALL_MS. While that long stall continues it is evaluated again when a time-based
// suppression (cooldown, re-offer) expires or the undo pill leaves the screen. Until a plan of the
// attempt has played, the trigger acts only on evidence that the plan's media arrived more slowly
// than its delivered bitrate (`measuredThroughputKbps`, else `arrivalLowerBoundKbps`).

export type BufferingQualityMode = "never" | "ask" | "always";

/** `playback.buffering_quality_mode` contract default. */
export const DEFAULT_BUFFERING_QUALITY_MODE: BufferingQualityMode = "always";

export const STARTUP_GRACE_MS = 10_000;
export const STALL_MIN_MS = 1_000;
export const STALLS_BEFORE_TRIGGER = 2;
export const STALL_WINDOW_MS = 120_000;
export const LONG_STALL_MS = 6_000;
export const PROMPT_SECONDS = 15;
export const REOFFER_MIN_MS = 120_000;
export const NO_LOWER_COOLDOWN_MS = 300_000;
export const REARM_AFTER_UNADOPTED_MS = 60_000;
/** A wait that begins with more media than this buffered past the playhead is the renderer's. */
export const RENDERER_WAIT_BUFFER_MS = 1_000;
export const MIN_ESTIMATE_KBPS = 100;
/** The `quality_preference` and plan quality for Auto. */
export const AUTO_QUALITY = "auto";

export const COPY = {
    promptTitle: "Playback keeps buffering",
    promptDetail: "Try a lower quality to keep watching",
    lowerAction: "Lower quality",
    keepAction: "Keep quality",
    undoCaption: "Quality lowered to stop buffering",
    undoAction: "Restore quality",
    lowered: "Quality lowered to stop buffering",
    cantLower: "Can't lower quality for this video",
} as const;

const PROMPT_MS = PROMPT_SECONDS * 1000;

export interface QualityRung {
    label: string;
    bitrateKbps: number;
}

/** What the controller reads from an adopted playback plan. */
export interface BufferingPlan {
    /** Every adoption is a new plan, so the host gives each a new id: a server `plan_id` can repeat. */
    readonly id: string;
    /** `effective_recipe.bitrate_kbps`, else `source.bitrate_kbps`. */
    readonly deliveredKbps: number | null;
    /** `auto`, or the label of the rung the viewer picked. */
    readonly quality: string;
    /** The `available_qualities` label the plan names in `active_quality`. */
    readonly activeQuality?: string;
    readonly availableQualities: readonly QualityRung[];
    /** `degradation_warnings` contains `quality_reduction_unavailable`. */
    readonly qualityReductionUnavailable: boolean;
    /** The estimate the plan was requested with, for `plan_summary`. */
    readonly requestedBandwidthEstimateKbps?: number;
}

/** Why the player is waiting. Only a `network` wait can be a stall. */
export type WaitCause = "network" | "seek" | "pause" | "reload" | "renderer";

export type ClientReplanOperation = "track_change" | "seek_reanchor" | "seek_failure_recovery" | "failure_recovery" | "output_change";

/** The fields of a replan for the host to send. */
export interface ReplanRequest {
    operation: "quality_change" | ClientReplanOperation;
    qualityPreference: string;
    bandwidthEstimateKbps?: number;
    /** Only set when the server advertises `buffering_quality_v1`. */
    bandwidthEstimateSource?: "observed_rebuffer";
    /** Only set when the server advertises `buffering_quality_v1`. */
    learnedLimit?: "clear";
    /** What the plan's media measurably arrived at, as evidence for the lowering. */
    observedThroughputKbps?: number;
}

export type Notice = "lowered" | "cantLower";

export type PillKind = "prompt" | "undo";

export interface Pill {
    kind: PillKind;
    /** When the timer runs out, on the elapsed clock; null while a pause or competing pill holds it. */
    deadlineMs: number | null;
    remainingMs: number;
    totalMs: number;
}

/** `buffering_action`: the last action on a plan. */
export type BufferingAction = "none" | "ignored" | "lowered" | "restored" | "accepted" | "kept" | "timed_out" | "cant_lower";

/** The `plan_summary` route event, for a plan that stopped being the playing plan. */
export interface PlanSummary {
    planId: string;
    playedMs: number;
    stallCount: number;
    /** Stall time with startup grace and outages excluded. */
    stallTotalMs: number;
    stallLongestMs: number;
    deliveredKbps: number | null;
    mode: BufferingQualityMode;
    action: BufferingAction;
    bandwidthEstimateKbps: number | null;
}

export type BufferingOutput =
    | { kind: "replan"; request: ReplanRequest }
    /** A pill came on screen: first, or again after a higher-priority pill hid. */
    | { kind: "pillShown"; pill: PillKind }
    | { kind: "notice"; notice: Notice }
    | { kind: "planSummary"; summary: PlanSummary };

/** Elapsed real time that a wall-clock change does not move, and one-shot timers on it. */
export interface BufferingClock {
    /** Whole milliseconds: the summary's times and every threshold comparison assume integers. */
    elapsedMs(): number;
    /** Runs `fn` once after `ms`; returns a function that cancels it. */
    schedule(fn: () => void, ms: number): () => void;
}

/** `floor(delivered × 7 / 10)` in integer arithmetic, or null below MIN_ESTIMATE_KBPS. */
export function stepDownEstimate(deliveredKbps: number | null): number | null {
    if (deliveredKbps === null || deliveredKbps <= 0) {
        return null;
    }
    const estimate = Math.floor((deliveredKbps * 7) / 10);
    return estimate >= MIN_ESTIMATE_KBPS ? estimate : null;
}

// A cap that keeps the rung's resolution can deliver below its bitrate.
function activeBitrate(plan: BufferingPlan): number | null {
    const rung = plan.activeQuality === undefined ? undefined : plan.availableQualities.find((r) => r.label === plan.activeQuality && r.bitrateKbps > 0);
    return rung === undefined ? plan.deliveredKbps : Math.min(rung.bitrateKbps, plan.deliveredKbps ?? rung.bitrateKbps);
}

/**
 * The highest real rung below the lower of the named rung's bitrate and the delivered bitrate, or
 * below the delivered bitrate when the plan names no rung or one that matches no entry. Equal
 * bitrates resolve to the earlier entry.
 */
export function lowerRung(plan: BufferingPlan): QualityRung | null {
    const ceiling = activeBitrate(plan);
    if (ceiling === null) {
        return null;
    }
    let best: QualityRung | null = null;
    for (const rung of plan.availableQualities) {
        if (rung.label !== AUTO_QUALITY && rung.bitrateKbps > 0 && rung.bitrateKbps < ceiling && (best === null || rung.bitrateKbps > best.bitrateKbps)) {
            best = rung;
        }
    }
    return best;
}

interface Stall {
    /** Where the trigger times this stall from; null during transport trouble. Ahead of now while startup grace runs. */
    timedFrom: number | null;
    /** The summary's timing, which a history clear does not re-time. */
    measuredFrom: number | null;
}

interface EndedStall {
    at: number;
    long: boolean;
}

interface PlanState {
    plan: BufferingPlan;
    action: BufferingAction;
    /** STARTUP_GRACE_MS after the plan's first wait or, when none came before it, its first frame. */
    graceEndsAt: number | null;
    stall: Stall | null;
    endedStalls: EndedStall[];
    cooldownUntil: number | null;
    /** Replaced a plan after the attempt had played and has not played itself: a wait begins no stall. */
    reloading: boolean;
    playedMs: number;
    stallCount: number;
    /** A source reload ended a stall that had reached STALL_MIN_MS, and the plan has not run since. */
    stallEndedByReload: boolean;
    stallTotalMs: number;
    stallLongestMs: number;
}

interface PendingReplan {
    /** `always` on Auto, whose lower result shows the undo pill; otherwise the result is a notice. */
    automatic: boolean;
    /** The delivered bitrate the replan left; a lower result is below it. */
    fromKbps: number | null;
    /** The kept estimate before this replan, for one the player refuses. */
    priorKeptEstimateKbps: number | null;
}

interface PresentedPill {
    kind: PillKind;
    remainingMs: number;
    deadlineMs: number | null;
    firstShownAt: number | null;
    isOnScreen: boolean;
}

interface SendOptions {
    estimateKbps?: number;
    learnedLimit?: "clear";
    fromKbps?: number | null;
    observedThroughputKbps?: number | null;
}

type AttemptStage = "new" | "adopted" | "played";

export class BufferingQualityController {
    mode: BufferingQualityMode = DEFAULT_BUFFERING_QUALITY_MODE;
    /** The server advertises `buffering_quality_v1`; without it replans omit the source and learned limit. */
    sendsBufferingQualityFields = false;
    onOutput: ((output: BufferingOutput) => void) | null = null;
    /** Called when the actionable pill on screen changes, with null once it is gone. */
    onPillChange: ((pill: Pill | null) => void) | null = null;
    /** What the playing plan's media has measurably arrived at so far, or null when there is no figure. */
    measuredThroughputKbps: () => number | null = () => null;
    /**
     * A lower bound on what the plan's media arrived at, for evidence only when
     * `measuredThroughputKbps` has no figure. Its share reads low, so it is never sent.
     */
    arrivalLowerBoundKbps: () => number | null = () => null;
    /** What the link delivered, every reader included: what a lowering sends as `observed_throughput_kbps`. */
    linkThroughputKbps: () => number | null = () => null;

    private currentPill: Pill | null = null;
    /**
     * The step-down estimate of the latest Auto lowering, from when its replan is sent until Restore
     * quality, a quality change this controller did not send, or a new attempt.
     */
    private kept: number | null = null;

    private current: PlanState | null = null;
    private playingSince: number | null = null;
    private isPaused = false;
    private rendererWaiting = false;
    private transportTrouble = false;
    private transportTroubleEndedAt: number | null = null;
    private competingPillVisible = false;
    private attemptStage: AttemptStage = "new";

    // The title, across plans.
    private answered = false;
    private noLowerRungNoticeShown = false;
    /** When a prompt that timed out first reached the screen. Only a timeout starts the re-offer wait. */
    private lastOfferAt: number | null = null;
    private pendingReplan: PendingReplan | null = null;
    private pickPending = false;

    private presented: PresentedPill | null = null;

    private cancelLongStallTimer: (() => void) | null = null;
    private cancelSuppressionTimer: (() => void) | null = null;
    private cancelRearmTimer: (() => void) | null = null;
    private cancelPillTimer: (() => void) | null = null;

    private readonly clock: BufferingClock;

    constructor(clock: BufferingClock) {
        this.clock = clock;
    }

    /** The actionable pill on screen, or null. */
    get pill(): Pill | null {
        return this.currentPill;
    }

    get keptEstimateKbps(): number | null {
        return this.kept;
    }

    // Plans

    /**
     * A plan became the playing plan. It ends the outgoing plan (emitting its summary), takes down
     * any pill, and starts fresh history. A plan that answers this controller's pending replan
     * settles it: a lower plan shows the undo pill (automatic) or the lowered notice (accepted); one
     * that is no lower shows the can't-lower notice and starts NO_LOWER_COOLDOWN_MS. Pass
     * `controllerInitiated: false` for a plan that answers a replan the controller did not send.
     */
    planAdopted(plan: BufferingPlan, controllerInitiated = true): void {
        const now = this.nowMs;
        // During the start, a stall in progress carries over as the new plan's first wait.
        const wasStalled = this.current?.stall != null;
        const startGrace = this.attemptStage === "adopted" ? (this.current?.graceEndsAt ?? null) : null;
        this.endPlan(now);
        const pending = controllerInitiated ? this.pendingReplan : null;
        this.pendingReplan = null;
        const state: PlanState = {
            plan,
            action: "none",
            graceEndsAt: startGrace,
            stall: null,
            endedStalls: [],
            cooldownUntil: null,
            reloading: false,
            playedMs: 0,
            stallCount: 0,
            stallEndedByReload: false,
            stallTotalMs: 0,
            stallLongestMs: 0,
        };
        if (this.playingSince !== null) {
            // A plan adopted while playing has its first frame now.
            this.playingSince = now;
            state.graceEndsAt = now + STARTUP_GRACE_MS;
        } else {
            state.reloading = this.attemptStage === "played";
        }
        if (this.attemptStage === "new") {
            this.attemptStage = "adopted";
        }
        this.current = state;
        if (wasStalled && !state.reloading) {
            this.beginStall(now);
        }
        if (pending !== null) {
            this.settle(pending, now);
        }
    }

    /** The plan stopped or failed with no successor: emits its summary. */
    planEnded(): void {
        this.endPlan(this.nowMs);
        this.pendingReplan = null;
        this.playingSince = null;
    }

    /** The player starts a new playback attempt of the title: the kept estimate and a fresh start. */
    newAttempt(): void {
        this.attemptStage = "new";
        this.kept = null;
        if (this.pendingReplan !== null) {
            this.pendingReplan.priorKeptEstimateKbps = null;
        }
    }

    /** New content: emits the current plan's summary and forgets every decision the title made. */
    reset(): void {
        this.planEnded();
        this.newAttempt();
        this.isPaused = false;
        this.answered = false;
        this.noLowerRungNoticeShown = false;
        this.lastOfferAt = null;
        this.pickPending = false;
    }

    // Media events

    playing(): void {
        const now = this.nowMs;
        this.isPaused = false;
        this.rendererWaiting = false;
        const state = this.current;
        if (state !== null) {
            // The plan ran again: a reload that ended its stall did not end it.
            state.stallEndedByReload = false;
            state.reloading = false;
        }
        if (this.playingSince === null) {
            this.playingSince = now;
            if (state !== null && state.graceEndsAt === null) {
                state.graceEndsAt = now + STARTUP_GRACE_MS;
            }
        }
        // The start wait the first frame ends counts only on evidence.
        const counts = this.attemptStage === "played" || (state !== null && this.arrivesSlowly(state.plan));
        if (state !== null) {
            this.attemptStage = "played";
        }
        this.endStall(now, counts, false);
        this.refreshPill();
        this.evaluate(now);
    }

    /**
     * The player is waiting. A `network` wait is a stall, except while a replacement of a plan that
     * played loads; any other cause ends a stall in progress without counting it. `startedAgoMs`
     * back-dates a wait the host noticed late, never past the start of the current playing state.
     */
    waiting(cause: WaitCause = "network", startedAgoMs = 0): void {
        const now = this.nowMs;
        this.rendererWaiting = cause === "renderer";
        const began = this.playingSince === null ? now : Math.max(this.playingSince, now - Math.max(0, startedAgoMs));
        this.leavePlaying(began);
        if (cause !== "network") {
            this.endStall(now, false, cause === "reload");
            if (cause === "renderer") {
                this.isPaused = false;
                this.refreshPill();
            }
            return;
        }
        this.isPaused = false;
        if (this.current !== null && this.current.stall === null && !this.current.reloading) {
            this.beginStall(began);
        }
        this.refreshPill();
    }

    paused(): void {
        const now = this.nowMs;
        this.rendererWaiting = false;
        this.leavePlaying(now);
        this.endStall(now, false, false);
        this.isPaused = true;
        this.refreshPill();
    }

    seeked(): void {
        this.endStall(this.nowMs, false, false);
    }

    /**
     * Media requests are failing or the device is offline. A stall that runs into trouble drops its
     * time so far; a stall still in progress when the trouble ends is timed from then.
     */
    transportTroubleChanged(trouble: boolean): void {
        if (trouble === this.transportTrouble) {
            return;
        }
        this.transportTrouble = trouble;
        const now = this.nowMs;
        if (!trouble) {
            this.transportTroubleEndedAt = now;
        }
        const state = this.current;
        if (state === null || state.stall === null) {
            return;
        }
        if (trouble) {
            state.stall.measuredFrom = null;
            state.stall.timedFrom = null;
            this.cancelStallTimers();
        } else {
            const from = Math.max(now, state.graceEndsAt ?? now);
            state.stall.timedFrom = from;
            state.stall.measuredFrom = from;
            this.scheduleLongStallTimer();
        }
    }

    /** The replan this controller sent failed. The plan keeps playing and is watched again at the rearm. */
    replanFailed(): void {
        this.pendingReplan = null;
    }

    /** The player could not send this controller's replan at all: the kept estimate from before it stays. */
    replanRefused(): void {
        if (this.pendingReplan !== null) {
            this.kept = this.pendingReplan.priorKeptEstimateKbps;
        }
        this.pendingReplan = null;
    }

    /**
     * The plan failed before its first frame because the player's own start deadline passed. On Auto
     * in `always`, when `measuredThroughputKbps` shows the plan's media arriving below its delivered
     * bitrate, it lowers as a long stall would. True when that replan was sent; false leaves the
     * failure to the player's usual recovery.
     */
    startDeadlinePassed(): boolean {
        const state = this.current;
        if (
            this.mode !== "always" ||
            this.answered ||
            this.transportTrouble ||
            (this.transportTroubleEndedAt !== null && this.nowMs - this.transportTroubleEndedAt < LONG_STALL_MS) ||
            this.rendererWaiting ||
            this.pickPending ||
            this.cancelRearmTimer !== null ||
            state === null ||
            state.plan.quality !== AUTO_QUALITY ||
            state.plan.qualityReductionUnavailable ||
            state.plan.deliveredKbps === null ||
            !this.arrivesSlowly(state.plan) ||
            state.cooldownUntil !== null ||
            lowerRung(state.plan) === null
        ) {
            return false;
        }
        const delivered = state.plan.deliveredKbps;
        const estimate = stepDownEstimate(delivered);
        if (estimate === null) {
            return false;
        }
        this.withdrawPill();
        this.sendReplan("lowered", AUTO_QUALITY, {
            estimateKbps: estimate,
            fromKbps: delivered,
            observedThroughputKbps: this.observedThroughputKbps(state.plan),
        });
        return true;
    }

    // Pill answers

    /** Lower quality on the prompt. */
    selectLower(): void {
        const plan = this.current?.plan;
        if (this.currentPill?.kind !== "prompt" || plan === undefined) {
            return;
        }
        this.withdrawPill();
        const rung = lowerRung(plan);
        if (rung === null) {
            this.cantLower();
            return;
        }
        if (plan.quality === AUTO_QUALITY) {
            const estimate = stepDownEstimate(plan.deliveredKbps);
            if (estimate === null) {
                this.cantLower();
                return;
            }
            this.sendReplan("accepted", AUTO_QUALITY, { estimateKbps: estimate, fromKbps: plan.deliveredKbps });
        } else {
            // This playback only: the saved preference does not change.
            this.sendReplan("accepted", rung.label, { fromKbps: plan.deliveredKbps ?? activeBitrate(plan) });
        }
    }

    /** Keep quality on the prompt: answers the title at this quality. */
    selectKeep(): void {
        if (this.currentPill?.kind !== "prompt") {
            return;
        }
        this.withdrawPill();
        this.answered = true;
        if (this.current !== null) {
            this.current.action = "kept";
        }
    }

    /** Restore quality on the undo pill: answers the title and clears the learned limit. */
    selectRestore(): void {
        if (this.currentPill?.kind !== "undo" || this.current === null) {
            return;
        }
        this.withdrawPill();
        this.answered = true;
        this.kept = null;
        this.sendReplan("restored", AUTO_QUALITY, { learnedLimit: "clear" });
    }

    /**
     * Back. On the prompt it answers like Keep; on the undo pill it only hides it, as its timer ending
     * does. True when a visible pill consumed the press, so a second Back behaves normally.
     */
    back(): boolean {
        switch (this.currentPill?.kind) {
            case "prompt":
                this.selectKeep();
                return true;
            case "undo":
                this.withdrawPill();
                this.evaluateLongStall();
                return true;
            default:
                return false;
        }
    }

    // Host inputs

    /**
     * A quality change this controller did not send: the viewer's pick, or a switch between the Wi-Fi
     * and cellular qualities. Any pill hides, history clears, the title is no longer answered and the
     * kept estimate goes. Call it once the player has accepted the change; for a pick, as its plan is
     * adopted, just before `planAdopted`.
     */
    qualityChanged(): void {
        this.pickPending = false;
        this.kept = null;
        this.answered = false;
        this.lastOfferAt = null;
        this.pendingReplan = null;
        this.cancelRearmTimer?.();
        this.cancelRearmTimer = null;
        this.withdrawPill();
        this.clearHistory(this.nowMs);
    }

    /** The viewer picked a quality and the player sent it: any pill hides and nothing prompts or lowers until its plan arrives. */
    pickSent(): void {
        this.pickPending = true;
        this.withdrawPill();
    }

    /** The pick from `pickSent` never became a plan. A long stall in progress is evaluated at once. */
    pickRefused(): void {
        if (!this.pickPending) {
            return;
        }
        this.pickPending = false;
        this.evaluateLongStall();
    }

    /**
     * A replan the player sends for its own reasons. It asks for the adopted plan's quality and, on
     * Auto, carries the kept estimate without a source. Null before a plan is adopted.
     */
    clientReplan(operation: ClientReplanOperation): ReplanRequest | null {
        const plan = this.current?.plan;
        if (plan === undefined) {
            return null;
        }
        const request: ReplanRequest = { operation, qualityPreference: plan.quality };
        if (plan.quality === AUTO_QUALITY && this.kept !== null) {
            request.bandwidthEstimateKbps = this.kept;
        }
        return request;
    }

    /**
     * Another actionable pill is showing, or the player cannot show pills at all. A buffering pill
     * that would appear now waits, and one already up hides with its timer frozen.
     */
    setCompetingPillVisible(visible: boolean): void {
        if (visible === this.competingPillVisible) {
            return;
        }
        this.competingPillVisible = visible;
        this.refreshPill();
    }

    // Trigger

    private evaluate(now: number): void {
        const state = this.current;
        if (this.isPaused || this.transportTrouble || state === null) {
            return;
        }
        state.endedStalls = state.endedStalls.filter((stall) => now - stall.at < STALL_WINDOW_MS);
        if (!triggered(state, now)) {
            return;
        }
        // Before anything of the attempt played, the wait is the network's only on evidence.
        if (this.attemptStage !== "played" && !this.arrivesSlowly(state.plan)) {
            return;
        }
        const evidenceKbps = this.attemptStage === "played" ? null : this.observedThroughputKbps(state.plan);

        // A suppressed trigger leaves history intact for a later evaluation.
        if (this.answered || this.pickPending || this.cancelRearmTimer !== null || this.presented !== null) {
            return;
        }
        if (state.cooldownUntil !== null && now < state.cooldownUntil) {
            this.watchStall(state.cooldownUntil);
            return;
        }
        if (this.mode === "never") {
            state.action = "ignored";
            return;
        }

        const plan = state.plan;
        if (lowerRung(plan) === null) {
            this.cantLower();
            return;
        }
        if (plan.quality === AUTO_QUALITY) {
            // Auto without a usable step-down estimate has no lower rung.
            const estimate = stepDownEstimate(plan.deliveredKbps);
            if (estimate === null) {
                this.cantLower();
                return;
            }
            if (this.mode === "always") {
                this.sendReplan("lowered", AUTO_QUALITY, {
                    estimateKbps: estimate,
                    fromKbps: plan.deliveredKbps,
                    observedThroughputKbps: evidenceKbps,
                });
                return;
            }
        }
        if (this.lastOfferAt !== null && now - this.lastOfferAt < REOFFER_MIN_MS) {
            this.watchStall(this.lastOfferAt + REOFFER_MIN_MS);
            return;
        }
        this.present("prompt");
    }

    /** Keeps watching a long stall that a time-based suppression held back: evaluates again when it expires. */
    private watchStall(deadline: number): void {
        this.cancelSuppressionTimer?.();
        this.cancelSuppressionTimer = null;
        if (this.current?.stall == null) {
            return;
        }
        this.cancelSuppressionTimer = this.scheduleAt(deadline, () => {
            this.cancelSuppressionTimer = null;
            this.evaluateLongStall();
        });
    }

    /** Evaluates only if a stall in progress has reached LONG_STALL_MS. */
    private evaluateLongStall(): void {
        const now = this.nowMs;
        const from = this.current?.stall?.timedFrom;
        if (from === undefined || from === null || now - from < LONG_STALL_MS) {
            return;
        }
        this.evaluate(now);
    }

    /** Evidence the plan's media arrives too slowly: measured throughput, else a lower bound, below its delivered bitrate. */
    private arrivesSlowly(plan: BufferingPlan): boolean {
        if (plan.deliveredKbps === null) {
            return false;
        }
        const measured = this.measuredThroughputKbps() ?? this.arrivalLowerBoundKbps();
        return measured !== null && measured < plan.deliveredKbps;
    }

    /** The figure a lowering sends as `observed_throughput_kbps`: what the link delivered when it is below the plan's bitrate. */
    private observedThroughputKbps(plan: BufferingPlan): number | null {
        if (plan.deliveredKbps === null) {
            return null;
        }
        const measured = this.linkThroughputKbps() ?? this.measuredThroughputKbps();
        return measured !== null && measured < plan.deliveredKbps ? measured : null;
    }

    /** No lower rung: the display-only notice, once per title. */
    private cantLower(): void {
        if (this.current !== null) {
            this.current.action = "cant_lower";
        }
        if (this.noLowerRungNoticeShown) {
            return;
        }
        this.noLowerRungNoticeShown = true;
        this.emit({ kind: "notice", notice: "cantLower" });
    }

    // Replans

    /** Sends the replan for `action`, which becomes the plan's `buffering_action`. */
    private sendReplan(action: BufferingAction, qualityPreference: string, options: SendOptions): void {
        const now = this.nowMs;
        const { estimateKbps, learnedLimit, fromKbps = null, observedThroughputKbps = null } = options;
        if (this.current !== null) {
            this.current.action = action;
        }
        const request: ReplanRequest = { operation: "quality_change", qualityPreference };
        if (estimateKbps !== undefined) {
            request.bandwidthEstimateKbps = estimateKbps;
        }
        if (this.sendsBufferingQualityFields) {
            if (estimateKbps !== undefined) {
                request.bandwidthEstimateSource = "observed_rebuffer";
            }
            if (learnedLimit !== undefined) {
                request.learnedLimit = learnedLimit;
            }
            if (observedThroughputKbps !== null) {
                request.observedThroughputKbps = observedThroughputKbps;
            }
        }
        // Only an Auto lowering sends an estimate; the next one replaces it.
        const priorKept = this.kept;
        if (estimateKbps !== undefined) {
            this.kept = estimateKbps;
        }
        // A Restore's plan settles nothing.
        this.pendingReplan = action === "restored" ? null : { automatic: action === "lowered", fromKbps, priorKeptEstimateKbps: priorKept };
        // Triggers on this plan wait for the adoption, or for the rearm if the replan fails or its plan never arrives.
        this.cancelSuppressionTimer?.();
        this.cancelSuppressionTimer = null;
        this.cancelRearmTimer?.();
        this.cancelRearmTimer = this.scheduleAt(now + REARM_AFTER_UNADOPTED_MS, () => this.rearm());
        this.emit({ kind: "replan", request });
    }

    private rearm(): void {
        this.cancelRearmTimer = null;
        this.pendingReplan = null;
        this.clearHistory(this.nowMs);
    }

    private settle(pending: PendingReplan, now: number): void {
        const state = this.current;
        if (state === null) {
            return;
        }
        let lower: boolean;
        if (state.plan.qualityReductionUnavailable) {
            lower = false;
        } else if (pending.fromKbps !== null) {
            // A result with no delivered bitrate counts as lower, as the vectors' `delivered_kbps: 0` encodes it.
            lower = (state.plan.deliveredKbps ?? 0) < pending.fromKbps;
        } else {
            return;
        }
        // The viewer's pending pick replaces this plan, so its result shows nothing; its action and cooldown still stand.
        if (lower) {
            if (this.pickPending) {
                return;
            }
            if (pending.automatic) {
                this.present("undo");
            } else {
                this.emit({ kind: "notice", notice: "lowered" });
            }
        } else {
            state.cooldownUntil = now + NO_LOWER_COOLDOWN_MS;
            state.action = "cant_lower";
            if (this.pickPending) {
                return;
            }
            // The viewer has now seen this copy for the title.
            this.noLowerRungNoticeShown = true;
            this.emit({ kind: "notice", notice: "cantLower" });
        }
    }

    // Stall tracker

    private beginStall(now: number): void {
        const state = this.current;
        if (state === null) {
            return;
        }
        state.stallEndedByReload = false;
        // The plan's first wait, when it comes before a frame, starts the grace.
        const graceEnd = state.graceEndsAt ?? now + STARTUP_GRACE_MS;
        state.graceEndsAt = graceEnd;
        const stall: Stall = { timedFrom: null, measuredFrom: null };
        if (!this.transportTrouble) {
            // A stall that begins in the grace counts from its end.
            const from = Math.max(now, graceEnd);
            stall.timedFrom = from;
            stall.measuredFrom = from;
        }
        state.stall = stall;
        this.scheduleLongStallTimer();
    }

    /**
     * Ends a stall in progress. Only one that playback `resumed` from, outside transport trouble, can
     * be a counted stall; its time feeds the summary either way. One that a source reload ended
     * (`byReload`) counts in the summary as one still in progress at the plan's end would.
     */
    private endStall(now: number, resumed: boolean, byReload: boolean): void {
        const state = this.current;
        const stall = state?.stall;
        if (state === null || stall === null || stall === undefined) {
            return;
        }
        state.stall = null;
        recordStall(state, stall.measuredFrom === null ? 0 : Math.max(0, now - stall.measuredFrom));
        if (stall.timedFrom !== null && !this.transportTrouble && now - stall.timedFrom >= STALL_MIN_MS) {
            if (resumed) {
                state.endedStalls.push({ at: now, long: now - stall.timedFrom >= LONG_STALL_MS });
                state.stallCount += 1;
            } else if (byReload) {
                state.stallEndedByReload = true;
            }
        }
        this.cancelStallTimers();
    }

    /** Prompt timeout, rearm, or a quality change: history clears with startup grace over, and a stall in progress is timed again from now. */
    private clearHistory(now: number): void {
        const state = this.current;
        if (state === null) {
            return;
        }
        state.endedStalls = [];
        state.graceEndsAt = now;
        if (state.stall !== null && state.stall.timedFrom !== null) {
            state.stall.timedFrom = now;
        }
        this.cancelSuppressionTimer?.();
        this.cancelSuppressionTimer = null;
        this.scheduleLongStallTimer();
    }

    private scheduleLongStallTimer(): void {
        this.cancelLongStallTimer?.();
        this.cancelLongStallTimer = null;
        const from = this.current?.stall?.timedFrom;
        if (from === undefined || from === null) {
            return;
        }
        this.cancelLongStallTimer = this.scheduleAt(from + LONG_STALL_MS, () => {
            this.cancelLongStallTimer = null;
            this.longStallTimerFired();
        });
    }

    private longStallTimerFired(): void {
        const from = this.current?.stall?.timedFrom;
        if (from === undefined || from === null) {
            return;
        }
        // A timer can fire a little early against the clock; wait out the rest rather than miss the threshold.
        if (this.nowMs - from < LONG_STALL_MS) {
            this.scheduleLongStallTimer();
            return;
        }
        this.evaluate(this.nowMs);
    }

    private cancelStallTimers(): void {
        this.cancelLongStallTimer?.();
        this.cancelLongStallTimer = null;
        this.cancelSuppressionTimer?.();
        this.cancelSuppressionTimer = null;
    }

    private leavePlaying(now: number): void {
        if (this.playingSince === null) {
            return;
        }
        if (this.current !== null) {
            this.current.playedMs += now - this.playingSince;
        }
        this.playingSince = null;
    }

    /** Closes the playing plan's books, takes down its pill and timers, and emits its summary. */
    private endPlan(now: number): void {
        const state = this.current;
        if (state === null) {
            return;
        }
        let playedMs = state.playedMs;
        if (this.playingSince !== null) {
            playedMs += now - this.playingSince;
        }
        if (state.stall !== null) {
            // A stall still running when its plan ends ends with it, and counts if it reached STALL_MIN_MS outside trouble.
            recordStall(state, state.stall.measuredFrom === null ? 0 : Math.max(0, now - state.stall.measuredFrom));
            if (!this.transportTrouble && state.stall.timedFrom !== null && now - state.stall.timedFrom >= STALL_MIN_MS) {
                state.stallCount += 1;
            }
        } else if (state.stallEndedByReload) {
            state.stallCount += 1;
        }
        const summary: PlanSummary = {
            planId: state.plan.id,
            playedMs,
            stallCount: state.stallCount,
            stallTotalMs: state.stallTotalMs,
            stallLongestMs: state.stallLongestMs,
            deliveredKbps: state.plan.deliveredKbps,
            mode: this.mode,
            action: state.action,
            bandwidthEstimateKbps: state.plan.requestedBandwidthEstimateKbps ?? null,
        };
        this.current = null;
        this.cancelStallTimers();
        this.cancelRearmTimer?.();
        this.cancelRearmTimer = null;
        this.withdrawPill();
        this.emit({ kind: "planSummary", summary });
    }

    // Pill

    private present(kind: PillKind): void {
        this.presented = { kind, remainingMs: PROMPT_MS, deadlineMs: null, firstShownAt: null, isOnScreen: false };
        this.refreshPill();
    }

    private withdrawPill(): void {
        this.presented = null;
        this.refreshPill();
    }

    /**
     * Shows, hides, runs or freezes the pill to match the player. Its timer runs only while it is on
     * screen and playback is not paused. It counts as shown each time it reaches the screen, and the
     * prompt as offered the first time.
     */
    private refreshPill(): void {
        const shown = this.presented;
        if (shown === null) {
            this.cancelPillTimer?.();
            this.cancelPillTimer = null;
            this.setPill(null);
            return;
        }
        const now = this.nowMs;
        const visible = !this.competingPillVisible;
        const running = visible && !this.isPaused;
        if (!running && shown.deadlineMs !== null) {
            shown.remainingMs = Math.max(0, shown.deadlineMs - now);
            shown.deadlineMs = null;
            this.cancelPillTimer?.();
            this.cancelPillTimer = null;
        } else if (running && shown.deadlineMs === null) {
            shown.deadlineMs = now + shown.remainingMs;
            this.cancelPillTimer = this.scheduleAt(shown.deadlineMs, () => this.pillExpired());
        }
        const appearing = visible && !shown.isOnScreen;
        if (appearing && shown.firstShownAt === null) {
            shown.firstShownAt = now;
        }
        shown.isOnScreen = visible;
        this.setPill(visible ? { kind: shown.kind, deadlineMs: shown.deadlineMs, remainingMs: shown.remainingMs, totalMs: PROMPT_MS } : null);
        if (appearing) {
            this.emit({ kind: "pillShown", pill: shown.kind });
        }
    }

    private setPill(next: Pill | null): void {
        const previous = this.currentPill;
        const same =
            previous === next ||
            (previous !== null && next !== null && previous.kind === next.kind && previous.deadlineMs === next.deadlineMs && previous.remainingMs === next.remainingMs);
        if (!same) {
            this.currentPill = next;
            this.onPillChange?.(next);
        }
    }

    /** The prompt's timeout leaves the title unanswered, clears history and starts the re-offer wait; the undo's only hides it. */
    private pillExpired(): void {
        this.cancelPillTimer = null;
        const expired = this.presented;
        if (expired === null) {
            return;
        }
        this.withdrawPill();
        if (expired.kind === "prompt") {
            if (this.current !== null) {
                this.current.action = "timed_out";
            }
            // The re-offer wait counts from the prompt's first display.
            this.lastOfferAt = expired.firstShownAt;
            this.clearHistory(this.nowMs);
        } else {
            this.evaluateLongStall();
        }
    }

    // Helpers

    private get nowMs(): number {
        return this.clock.elapsedMs();
    }

    private scheduleAt(deadline: number, fn: () => void): () => void {
        return this.clock.schedule(fn, Math.max(0, deadline - this.nowMs));
    }

    private emit(output: BufferingOutput): void {
        this.onOutput?.(output);
    }
}

function triggered(state: PlanState, now: number): boolean {
    const from = state.stall?.timedFrom;
    if (from !== undefined && from !== null && now - from >= LONG_STALL_MS) {
        return true;
    }
    const recent = state.endedStalls.filter((stall) => now - stall.at < STALL_WINDOW_MS);
    return recent.some((stall) => stall.long) || recent.length >= STALLS_BEFORE_TRIGGER;
}

function recordStall(state: PlanState, measuredMs: number): void {
    if (measuredMs > 0) {
        state.stallTotalMs += measuredMs;
        state.stallLongestMs = Math.max(state.stallLongestMs, measuredMs);
    }
}
