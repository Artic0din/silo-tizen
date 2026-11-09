// Joins silo-apple's buffering-quality pieces for one playback attempt, as PlayerViewModel does:
// the decision controller (bufferingQuality.ts), the signal mapper (bufferingSignals.ts), the
// pill and the five-second notice. It sends nothing itself: the player passes it playback facts
// and carries out the replans it asks for.

import type { Clock } from "../api/clock.ts";
import type { PlaybackPlan } from "../contracts/v2/playback.ts";
import {
    AUTO_QUALITY,
    BufferingQualityController,
    COPY,
    type BufferingOutput,
    type BufferingPlan,
    type BufferingQualityMode,
    type ClientReplanOperation,
    type Notice,
    type Pill,
    type PillKind,
    type ReplanRequest,
} from "./bufferingQuality.ts";
import { BufferingSignalMapper, type BufferingCall, type BufferingSnapshot } from "./bufferingSignals.ts";

/** How long the lowered and cannot-lower notices stay up. */
export const NOTICE_MS = 5000;
const QUALITY_REDUCTION_UNAVAILABLE = "quality_reduction_unavailable";
const PLAN_ACTIVE_QUALITY_FEATURE = "plan_active_quality_v1";

export interface BufferingHost {
    /** Sends the controller's replan; false when the player cannot send it now. */
    issueReplan(request: ReplanRequest, restore: boolean): boolean;
    /** The pill or notice on screen changed. */
    changed(): void;
}

/** What the player screen draws for the buffering controller. */
export interface BufferingPillView {
    readonly kind: PillKind;
    readonly remainingMs: number;
    readonly totalMs: number;
    /** The countdown is moving: not frozen by a pause or a competing pill. */
    readonly running: boolean;
    /** Changes whenever the countdown must restart from `remainingMs`. */
    readonly revision: number;
}

export interface BufferingNoticeView {
    readonly text: string;
    /** The lowering notice carries the undo pill's symbol. */
    readonly lowered: boolean;
}

export class BufferingBridge {
    readonly controller: BufferingQualityController;
    private readonly signals = new BufferingSignalMapper();
    private readonly origin: number;
    private planRevision = 0;
    private pillRevision = 0;
    private shownNotice: BufferingNoticeView | undefined;
    private pendingNotice: Notice | undefined;
    private cancelNotice: (() => void) | undefined;
    private cancelReplan: (() => void) | undefined;
    private syncing = false;
    private dirty = false;
    private canShow = true;
    /** The replan being asked for is Restore quality, the viewer's answer, which the player must not drop. */
    private restoring = false;

    private readonly clock: Clock;
    private readonly host: BufferingHost;

    constructor(clock: Clock, host: BufferingHost) {
        this.clock = clock;
        this.host = host;
        this.origin = clock.now();
        // shortcut: the controller's elapsed clock is the injected clock, which is the wall clock on a TV; upgrade if a monotonic source appears.
        this.controller = new BufferingQualityController({
            elapsedMs: () => Math.round(clock.now() - this.origin),
            schedule: (fn, ms) => clock.schedule(fn, ms),
        });
        this.controller.onOutput = (output) => this.handle(output);
        this.controller.onPillChange = () => {
            this.pillRevision++;
            host.changed();
        };
    }

    set mode(mode: BufferingQualityMode) {
        this.controller.mode = mode;
    }

    get mode(): BufferingQualityMode {
        return this.controller.mode;
    }

    /** The server advertises `buffering_quality_v1`, so replans carry the source and learned limit. */
    set advertised(advertised: boolean) {
        this.controller.sendsBufferingQualityFields = advertised;
    }

    get pill(): BufferingPillView | undefined {
        const pill: Pill | null = this.controller.pill;
        return pill === null ? undefined : { kind: pill.kind, remainingMs: pill.remainingMs, totalMs: pill.totalMs, running: pill.deadlineMs !== null, revision: this.pillRevision };
    }

    get notice(): BufferingNoticeView | undefined {
        return this.shownNotice;
    }

    /**
     * A plan became the playing plan. `controllerInitiated` is true for the plan that answers this
     * controller's own replan. `quality` is `auto`, or the label of the quality the viewer asked for.
     */
    planAdopted(plan: PlaybackPlan, serverFeatures: readonly string[], qualityPreference: string, controllerInitiated: boolean): void {
        this.planRevision++;
        const named = qualityPreference === AUTO_QUALITY ? AUTO_QUALITY : plan.availableQualities.find((quality) => quality.label === qualityPreference)?.label ?? qualityPreference;
        const active = serverFeatures.includes(PLAN_ACTIVE_QUALITY_FEATURE) ? plan.activeQuality : undefined;
        const buffering: BufferingPlan = {
            id: `${this.planRevision}:${plan.planId}`,
            deliveredKbps: plan.recipe?.bitrateKbps ?? plan.sourceBitrateKbps ?? null,
            quality: named,
            ...(active === undefined ? {} : { activeQuality: active }),
            availableQualities: plan.availableQualities.flatMap((quality) => (quality.bitrateKbps === undefined ? [] : [{ label: quality.label, bitrateKbps: quality.bitrateKbps }])),
            qualityReductionUnavailable: plan.warnings.some((warning) => warning.code === QUALITY_REDUCTION_UNAVAILABLE),
        };
        this.controller.planAdopted(buffering, controllerInitiated);
        this.signals.planAdopted();
    }

    /** The plan stopped or failed with no successor. */
    planEnded(): void {
        this.controller.planEnded();
        this.signals.invalidate();
    }

    /** The player starts another playback attempt of the same title. */
    newAttempt(): void {
        this.controller.newAttempt();
    }

    /** Hands the controller whatever the playback facts changed. */
    sync(snapshot: BufferingSnapshot): void {
        if (this.syncing) {
            this.dirty = true;
            return;
        }
        this.syncing = true;
        try {
            do {
                this.dirty = false;
                for (const call of this.signals.update(snapshot)) this.apply(call);
            } while (this.dirty);
        } finally {
            this.syncing = false;
        }
    }

    /** The viewer picked a quality and the player sent it. */
    pickSent(): void {
        this.controller.pickSent();
    }

    /** The viewer's pick never became a plan. */
    pickRefused(): void {
        this.controller.pickRefused();
    }

    /** The player accepted a quality change this controller did not send. */
    qualityChanged(): void {
        this.controller.qualityChanged();
    }

    /** The replan this controller sent failed. */
    replanFailed(): void {
        this.controller.replanFailed();
    }

    noteMediaRequestFailed(): void {
        this.signals.noteMediaRequestFailed();
    }

    // The viewer's answers.

    selectPrimary(): void {
        if (this.controller.pill?.kind === "prompt") {
            this.controller.selectLower();
        } else {
            this.restoring = true;
            this.controller.selectRestore();
            this.restoring = false;
        }
    }

    selectKeep(): void {
        this.controller.selectKeep();
    }

    /** True when a visible pill took the press. */
    back(): boolean {
        return this.controller.back();
    }

    /** Another pill (Up Next) is up, or the player cannot show pills at all. */
    setCompetingPill(visible: boolean): void {
        this.controller.setCompetingPillVisible(visible);
        this.canShow = !visible;
        this.showPendingNotice();
    }

    clientReplan(operation: ClientReplanOperation): ReplanRequest | null {
        return this.controller.clientReplan(operation);
    }

    destroy(): void {
        this.cancelNotice?.();
        this.cancelNotice = undefined;
        this.cancelReplan?.();
        this.cancelReplan = undefined;
        this.controller.onOutput = null;
        this.controller.onPillChange = null;
        this.controller.reset();
    }

    private apply(call: BufferingCall): void {
        switch (call.kind) {
            case "trouble": this.controller.transportTroubleChanged(call.trouble); break;
            case "playing": this.controller.playing(); break;
            case "waiting": this.controller.waiting(call.cause); break;
            case "paused": this.controller.paused(); break;
        }
    }

    private handle(output: BufferingOutput): void {
        switch (output.kind) {
            case "replan": {
                // The controller is still inside the event that fired it, and the replan feeds it events of its own.
                const request = output.request;
                const restore = this.restoring;
                this.cancelReplan?.();
                this.cancelReplan = this.clock.schedule(() => {
                    this.cancelReplan = undefined;
                    if (!this.host.issueReplan(request, restore)) this.controller.replanRefused();
                }, 0);
                break;
            }
            case "notice":
                this.pendingNotice = output.notice;
                this.showPendingNotice();
                break;
            case "pillShown":
            case "planSummary":
                break;
        }
    }

    /** The notice shows for NOTICE_MS in the information tone once the player can show it. */
    private showPendingNotice(): void {
        const notice = this.pendingNotice;
        if (notice === undefined || !this.canShow || this.shownNotice !== undefined) return;
        this.pendingNotice = undefined;
        this.shownNotice = { text: notice === "lowered" ? COPY.lowered : COPY.cantLower, lowered: notice === "lowered" };
        this.cancelNotice = this.clock.schedule(() => {
            this.cancelNotice = undefined;
            this.shownNotice = undefined;
            this.host.changed();
            this.showPendingNotice();
        }, NOTICE_MS);
        this.host.changed();
    }
}
