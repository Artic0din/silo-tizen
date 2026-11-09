import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
    AUTO_QUALITY,
    BufferingQualityController,
    COPY,
    LONG_STALL_MS,
    MIN_ESTIMATE_KBPS,
    NO_LOWER_COOLDOWN_MS,
    PROMPT_SECONDS,
    REARM_AFTER_UNADOPTED_MS,
    REOFFER_MIN_MS,
    RENDERER_WAIT_BUFFER_MS,
    STALL_MIN_MS,
    STALL_WINDOW_MS,
    STALLS_BEFORE_TRIGGER,
    STARTUP_GRACE_MS,
    lowerRung,
    stepDownEstimate,
    type BufferingClock,
    type BufferingOutput,
    type BufferingPlan,
    type BufferingQualityMode,
    type ClientReplanOperation,
    type Notice,
    type PlanSummary,
    type ReplanRequest,
    type WaitCause,
} from "../../src/player/bufferingQuality.ts";

// Vectors

interface VectorRung {
    label: string;
    bitrate_kbps: number;
}

interface VectorPlan {
    plan_id: string;
    delivered_kbps: number;
    quality: string;
    active_quality?: string;
    available_qualities: VectorRung[];
    degradation_warnings?: string[];
}

interface VectorEvent {
    t: number;
    type: string;
    plan?: VectorPlan;
    controllerInitiated?: boolean;
    cause?: WaitCause;
    operation?: ClientReplanOperation;
}

interface VectorOutput {
    t: number;
    type: "replan" | "prompt_shown" | "undo_shown" | "notice";
    body?: Record<string, string | number>;
    key?: string;
}

interface VectorCase {
    name: string;
    mode?: BufferingQualityMode;
    events: VectorEvent[];
    until: number;
    expect: VectorOutput[];
    buffering_action?: Record<string, string>;
}

interface Vectors {
    constants: Record<string, number>;
    copy: Record<string, string>;
    event_types: string[];
    output_types: string[];
    defaults: { mode: BufferingQualityMode };
    cases: VectorCase[];
}

const TOP_LEVEL_KEYS = [
    "version",
    "spec",
    "about",
    "constants",
    "copy",
    "event_types",
    "output_types",
    "defaults",
    "cases",
    "connection_budget_cases",
    "probe_about",
    "probe_constants",
    "probe_cases",
];
const EVENT_TYPES = [
    "plan_adopted",
    "playing",
    "waiting",
    "pause",
    "seek",
    "transport_error_start",
    "transport_error_end",
    "replan_failed",
    "select_lower",
    "select_keep",
    "select_restore",
    "back",
    "pill_obscured",
    "pill_unobscured",
    "client_replan",
    "quality_changed",
    "pick_sent",
    "pick_refused",
    "new_attempt",
];
const OUTPUT_TYPES = ["replan", "prompt_shown", "undo_shown", "notice"];
const KNOWN_ACTIONS = ["none", "ignored", "lowered", "restored", "accepted", "kept", "timed_out", "cant_lower"];

const raw: unknown = JSON.parse(readFileSync(new URL("./fixtures/buffering-quality/vectors.json", import.meta.url), "utf8"));
const vectors = raw as Vectors;

// A clock the test advances by hand. Due timers fire in deadline order, first-scheduled first on a tie,
// including timers that firing ones schedule.
class ManualBufferingClock implements BufferingClock {
    private time = 0;
    private scheduled = 0;
    private timers: { at: number; order: number; fn: () => void; cancelled: boolean }[] = [];

    elapsedMs(): number {
        return this.time;
    }

    schedule(fn: () => void, ms: number): () => void {
        const timer = { at: this.time + Math.max(0, Math.round(ms)), order: this.scheduled++, fn, cancelled: false };
        this.timers.push(timer);
        return () => {
            timer.cancelled = true;
        };
    }

    advance(to: number): void {
        assert.ok(to >= this.time, "the clock only moves forward");
        for (;;) {
            const due = this.timers.filter((timer) => !timer.cancelled && timer.at <= to).sort((a, b) => a.at - b.at || a.order - b.order)[0];
            if (due === undefined) {
                break;
            }
            this.time = Math.max(this.time, due.at);
            due.cancelled = true;
            due.fn();
        }
        this.timers = this.timers.filter((timer) => !timer.cancelled);
        this.time = to;
    }
}

interface Recorded {
    t: number;
    output: BufferingOutput;
}

class Harness {
    readonly clock = new ManualBufferingClock();
    readonly controller = new BufferingQualityController(this.clock);
    readonly outputs: Recorded[] = [];
    /** The vectors' waits are a link too slow for every plan: each plan's media is measured below its bitrate. */
    measuredKbps: number | null = 1;

    constructor(mode: BufferingQualityMode, sendsBufferingQualityFields = true) {
        this.controller.mode = mode;
        this.controller.sendsBufferingQualityFields = sendsBufferingQualityFields;
        this.controller.onOutput = (output) => this.outputs.push({ t: this.clock.elapsedMs(), output });
        this.controller.measuredThroughputKbps = () => this.measuredKbps;
    }

    at(ms: number, act: (controller: BufferingQualityController) => void): void {
        this.clock.advance(ms);
        act(this.controller);
    }

    /** Records an output the player sends itself with the controller's fields, such as a client replan. */
    record(output: BufferingOutput): void {
        this.outputs.push({ t: this.clock.elapsedMs(), output });
    }

    startPlaying(plan: BufferingPlan, ms = 0): void {
        this.at(ms, (controller) => {
            controller.planAdopted(plan);
            controller.playing();
        });
    }

    get shown(): Recorded[] {
        return this.outputs.filter((recorded) => recorded.output.kind !== "planSummary");
    }

    get summaries(): PlanSummary[] {
        return this.outputs.flatMap((recorded) => (recorded.output.kind === "planSummary" ? [recorded.output.summary] : []));
    }
}

const LADDER = [
    { label: "original", bitrateKbps: 63_000 },
    { label: "1080p-high", bitrateKbps: 10_000 },
    { label: "1080p-medium", bitrateKbps: 6_000 },
    { label: "720p-high", bitrateKbps: 4_000 },
];

function plan(id: string, options: Partial<Omit<BufferingPlan, "id">> = {}): BufferingPlan {
    return { id, deliveredKbps: 63_000, quality: AUTO_QUALITY, availableQualities: LADDER, qualityReductionUnavailable: false, ...options };
}

function toPlan(vectorPlan: VectorPlan): BufferingPlan {
    return {
        id: vectorPlan.plan_id,
        // The vectors write a missing delivered bitrate as 0.
        deliveredKbps: vectorPlan.delivered_kbps === 0 ? null : vectorPlan.delivered_kbps,
        quality: vectorPlan.quality,
        ...(vectorPlan.active_quality === undefined ? {} : { activeQuality: vectorPlan.active_quality }),
        availableQualities: vectorPlan.available_qualities.map((rung) => ({ label: rung.label, bitrateKbps: rung.bitrate_kbps })),
        qualityReductionUnavailable: (vectorPlan.degradation_warnings ?? []).includes("quality_reduction_unavailable"),
    };
}

// The request body as the vectors write it: `operation` and every present field, snake_case.
function wireBody(request: ReplanRequest): Record<string, string | number> {
    const body: Record<string, string | number> = { operation: request.operation, quality_preference: request.qualityPreference };
    if (request.bandwidthEstimateKbps !== undefined) {
        body["bandwidth_estimate_kbps"] = request.bandwidthEstimateKbps;
    }
    if (request.bandwidthEstimateSource !== undefined) {
        body["bandwidth_estimate_source"] = request.bandwidthEstimateSource;
    }
    if (request.learnedLimit !== undefined) {
        body["learned_limit"] = request.learnedLimit;
    }
    return body;
}

const NOTICE_KEY: Record<Notice, string> = { lowered: "lowered", cantLower: "cant_lower" };

function toVectorOutput({ t, output }: Recorded): VectorOutput {
    switch (output.kind) {
        case "replan":
            return { t, type: "replan", body: wireBody(output.request) };
        case "pillShown":
            return { t, type: output.pill === "prompt" ? "prompt_shown" : "undo_shown" };
        case "notice":
            return { t, type: "notice", key: NOTICE_KEY[output.notice] };
        case "planSummary":
            throw new Error("summaries are checked separately");
    }
}

// The same output as a server without `buffering_quality_v1` receives it.
function withoutBufferingQualityFields(output: VectorOutput): VectorOutput {
    if (output.body === undefined) {
        return output;
    }
    const { bandwidth_estimate_source: _source, learned_limit: _limit, ...body } = output.body;
    return { ...output, body };
}

function applyEvent(controller: BufferingQualityController, event: VectorEvent): ReplanRequest | null {
    switch (event.type) {
        case "plan_adopted": {
            assert.ok(event.plan, "plan_adopted carries a plan");
            controller.planAdopted(toPlan(event.plan), event.controllerInitiated ?? true);
            return null;
        }
        case "playing":
            controller.playing();
            return null;
        case "waiting":
            controller.waiting(event.cause ?? "network");
            return null;
        case "pause":
            controller.paused();
            return null;
        case "seek":
            controller.seeked();
            return null;
        case "transport_error_start":
            controller.transportTroubleChanged(true);
            return null;
        case "transport_error_end":
            controller.transportTroubleChanged(false);
            return null;
        case "replan_failed":
            controller.replanFailed();
            return null;
        case "select_lower":
            controller.selectLower();
            return null;
        case "select_keep":
            controller.selectKeep();
            return null;
        case "select_restore":
            controller.selectRestore();
            return null;
        case "back":
            controller.back();
            return null;
        case "pill_obscured":
            controller.setCompetingPillVisible(true);
            return null;
        case "pill_unobscured":
            controller.setCompetingPillVisible(false);
            return null;
        case "client_replan":
            assert.ok(event.operation, "client_replan carries an operation");
            return controller.clientReplan(event.operation);
        case "quality_changed":
            controller.qualityChanged();
            return null;
        case "pick_sent":
            controller.pickSent();
            return null;
        case "pick_refused":
            controller.pickRefused();
            return null;
        case "new_attempt":
            controller.newAttempt();
            return null;
        default:
            throw new Error(`unknown event type ${event.type}`);
    }
}

function replay(vectorCase: VectorCase, sendsBufferingQualityFields: boolean): void {
    const label = `${vectorCase.name} (buffering_quality_v1 ${sendsBufferingQualityFields ? "on" : "off"})`;
    const harness = new Harness(vectorCase.mode ?? vectors.defaults.mode, sendsBufferingQualityFields);
    const adopted: string[] = [];
    for (const event of vectorCase.events) {
        harness.clock.advance(event.t);
        if (event.type === "plan_adopted" && event.plan !== undefined) {
            adopted.push(event.plan.plan_id);
        }
        const sent = applyEvent(harness.controller, event);
        if (sent !== null) {
            harness.record({ kind: "replan", request: sent });
        }
    }
    harness.clock.advance(vectorCase.until);
    harness.controller.planEnded();

    const expected = vectorCase.expect.map((output) => (sendsBufferingQualityFields ? output : withoutBufferingQualityFields(output)));
    assert.deepEqual(harness.shown.map(toVectorOutput), expected, label);
    assert.deepEqual(
        harness.summaries.map((summary) => summary.planId),
        adopted,
        `${label}: one plan_summary per adopted plan`,
    );
    for (const [planId, action] of Object.entries(vectorCase.buffering_action ?? {})) {
        assert.equal(harness.summaries.find((summary) => summary.planId === planId)?.action, action, `${label}: buffering_action for ${planId}`);
    }
}

test("the vectors file has the sections and vocabulary this replay understands", () => {
    assert.deepEqual(Object.keys(raw as Record<string, unknown>).sort(), [...TOP_LEVEL_KEYS].sort());
    assert.ok(vectors.cases.length > 0);
    assert.deepEqual([...vectors.event_types].sort(), [...EVENT_TYPES].sort());
    assert.deepEqual([...vectors.output_types].sort(), [...OUTPUT_TYPES].sort());
    const actions = new Set(vectors.cases.flatMap((vectorCase) => Object.values(vectorCase.buffering_action ?? {})));
    assert.deepEqual([...actions].filter((action) => !KNOWN_ACTIONS.includes(action)), []);
});

test("constants and copy match the vectors", () => {
    assert.deepEqual(vectors.constants, {
        STARTUP_GRACE_MS,
        STALL_MIN_MS,
        RENDERER_WAIT_BUFFER_MS,
        STALLS_BEFORE_TRIGGER,
        STALL_WINDOW_MS,
        LONG_STALL_MS,
        PROMPT_SECONDS,
        REOFFER_MIN_MS,
        NO_LOWER_COOLDOWN_MS,
        REARM_AFTER_UNADOPTED_MS,
        STEP_DOWN_RATIO: 0.7,
        MIN_ESTIMATE_KBPS,
    });
    assert.deepEqual(vectors.copy, {
        prompt_title: COPY.promptTitle,
        prompt_lower: COPY.lowerAction,
        prompt_keep: COPY.keepAction,
        undo_caption: COPY.undoCaption,
        undo_action: COPY.undoAction,
        lowered: COPY.lowered,
        cant_lower: COPY.cantLower,
    });
});

for (const sendsFields of [true, false]) {
    test(`every vector case replays exactly (buffering_quality_v1 ${sendsFields ? "advertised" : "not advertised"})`, () => {
        for (const vectorCase of vectors.cases) {
            replay(vectorCase, sendsFields);
        }
    });
}

// Behaviour the vectors do not pin directly

test("the step-down estimate is exact integer arithmetic", () => {
    assert.equal(stepDownEstimate(22_120), 15_484);
    assert.equal(stepDownEstimate(63_000), 44_100);
    assert.equal(stepDownEstimate(142), null);
    assert.equal(stepDownEstimate(143), MIN_ESTIMATE_KBPS);
    assert.equal(stepDownEstimate(0), null);
    assert.equal(stepDownEstimate(null), null);
});

test("the lower rung is the highest real rung below the ceiling, the earlier entry on a tie", () => {
    assert.equal(lowerRung(plan("p", { deliveredKbps: 63_000 }))?.label, "1080p-high");
    assert.equal(lowerRung(plan("p", { deliveredKbps: 10_000 }))?.label, "1080p-medium");
    assert.equal(lowerRung(plan("p", { deliveredKbps: 4_000 })), null);
    assert.equal(lowerRung(plan("p", { deliveredKbps: null })), null);
    // A named rung lowers the ceiling to its bitrate, or to the delivered bitrate when that is lower.
    assert.equal(lowerRung(plan("p", { activeQuality: "1080p-medium" }))?.label, "720p-high");
    assert.equal(lowerRung(plan("p", { activeQuality: "1080p-high", deliveredKbps: 5_000 }))?.label, "720p-high");
    const tied = [
        { label: "a", bitrateKbps: 5_000 },
        { label: "b", bitrateKbps: 5_000 },
        { label: "c", bitrateKbps: 2_000 },
    ];
    assert.equal(lowerRung(plan("p", { deliveredKbps: 9_000, availableQualities: tied }))?.label, "a");
});

function pillKind(harness: Harness): string | undefined {
    return harness.controller.pill?.kind;
}

test("the prompt's timer freezes on pause and a competing pill, and its changes are reported", () => {
    const harness = new Harness("ask");
    const changes: (string | null)[] = [];
    harness.controller.onPillChange = (pill) => changes.push(pill === null ? null : `${pill.kind}:${pill.remainingMs}:${pill.deadlineMs}`);
    harness.startPlaying(plan("p1"));
    harness.at(125_000, (controller) => controller.waiting());
    harness.clock.advance(131_000);
    assert.deepEqual(harness.controller.pill, { kind: "prompt", deadlineMs: 146_000, remainingMs: 15_000, totalMs: 15_000 });

    harness.at(136_000, (controller) => controller.paused());
    assert.deepEqual(harness.controller.pill, { kind: "prompt", deadlineMs: null, remainingMs: 10_000, totalMs: 15_000 });
    harness.clock.advance(300_000);
    assert.equal(pillKind(harness), "prompt", "a paused pill does not time out");

    harness.at(300_000, (controller) => controller.setCompetingPillVisible(true));
    assert.equal(harness.controller.pill, null);
    harness.at(310_000, (controller) => controller.setCompetingPillVisible(false));
    harness.at(310_000, (controller) => controller.waiting());
    assert.deepEqual(harness.controller.pill, { kind: "prompt", deadlineMs: 320_000, remainingMs: 10_000, totalMs: 15_000 });
    assert.equal(harness.shown.filter((recorded) => recorded.output.kind === "pillShown").length, 2);
    harness.clock.advance(320_000);
    assert.equal(harness.controller.pill, null);
    assert.equal(changes.at(-1), null);
});

test("Keep answers the title: a later stall on a new plan neither prompts nor lowers", () => {
    const harness = new Harness("ask");
    harness.startPlaying(plan("p1"));
    harness.at(125_000, (controller) => controller.waiting());
    harness.at(131_000, (controller) => controller.selectKeep());
    harness.at(133_000, (controller) => {
        controller.planAdopted(plan("p2"));
        controller.playing();
    });
    harness.at(200_000, (controller) => controller.waiting());
    harness.clock.advance(300_000);
    assert.deepEqual(
        harness.shown.map((recorded) => recorded.output.kind),
        ["pillShown"],
    );
    assert.equal(harness.summaries[0]?.action, "kept");
});

test("reset forgets the answer, the once-per-title notice and the kept estimate", () => {
    const harness = new Harness("always");
    harness.startPlaying(plan("p1"));
    harness.at(125_000, (controller) => controller.waiting());
    harness.clock.advance(131_000);
    assert.equal(harness.controller.keptEstimateKbps, 44_100);

    harness.at(140_000, (controller) => controller.reset());
    assert.equal(harness.controller.keptEstimateKbps, null);
    assert.equal(harness.controller.clientReplan("track_change"), null);
    assert.equal(harness.summaries.length, 1);
});

test("a start deadline lowers Auto only on evidence the plan's media arrived too slowly", () => {
    const slow = new Harness("always");
    slow.at(0, (controller) => controller.planAdopted(plan("p1")));
    slow.at(20_000, (controller) => assert.equal(controller.startDeadlinePassed(), true));
    assert.deepEqual(slow.shown.map((recorded) => (recorded.output.kind === "replan" ? wireBody(recorded.output.request) : null)), [
        { operation: "quality_change", quality_preference: "auto", bandwidth_estimate_kbps: 44_100, bandwidth_estimate_source: "observed_rebuffer" },
    ]);
    const request = slow.shown[0]?.output;
    assert.equal(request?.kind === "replan" ? request.request.observedThroughputKbps : undefined, 1);

    const unmeasured = new Harness("always");
    unmeasured.measuredKbps = null;
    unmeasured.at(0, (controller) => controller.planAdopted(plan("p1")));
    unmeasured.at(20_000, (controller) => assert.equal(controller.startDeadlinePassed(), false));
    assert.deepEqual(unmeasured.shown, []);

    const picked = new Harness("always");
    picked.at(0, (controller) => controller.planAdopted(plan("p1", { quality: "1080p-high" })));
    picked.at(20_000, (controller) => assert.equal(controller.startDeadlinePassed(), false));
    assert.deepEqual(picked.shown, []);
});
