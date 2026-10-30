// The native playback operations for FakeSilo, following docs/playback-api.md and
// playback-protocol-v3.md at the pinned commit: installation check, start idempotency on
// playback_attempt_id plus body, sequenced progress compare-and-set, first-stop-wins receipts,
// replan idempotency on replan_request_id, stale-plan refusal and 410 for an administrator's end.
// Bodies start from the vendored fixtures; plans the fixtures do not cover (offset timelines,
// terminals, problems without a fixture) are built from the OpenAPI schemas.

import { fixture, type FakeSilo, problem, type Reply } from "./fakeSilo.ts";

const PROBLEM_JSON = { "Content-Type": "application/problem+json" };

export interface PlanShape {
    readonly delivery?: string;
    readonly timeline?: Record<string, unknown>;
    /** Replaces the default `/api/v2/stream/<session>?st=<signed>` URL. */
    readonly url?: (sessionId: string) => string;
    readonly durationSeconds?: number;
}

export type NextDecision = PlanShape | { readonly terminal: string; readonly retryable?: boolean };

interface Session {
    readonly id: string;
    readonly profileId: string;
    readonly attemptId: string;
    planId: string;
    planKey: string;
    lastSequence: number;
    lastSample: { readonly position: unknown; readonly isPaused: unknown } | undefined;
    receipt: Record<string, unknown> | undefined;
    endedByAdmin: boolean;
    readonly replans: Map<string, { digest: string; reply: Reply }>;
}

export class FakePlayback {
    readonly installationId: string;
    configured = true;
    /** Decisions for the next starts and replans, first in first out; default: a direct plan. */
    readonly next: NextDecision[] = [];
    readonly sessions = new Map<string, Session>();
    private readonly attempts = new Map<string, { digest: string; reply: Reply; sessionId: string | undefined }>();
    private serial = 0;
    private readonly fake: FakeSilo;

    constructor(fake: FakeSilo) {
        this.fake = fake;
        this.installationId = String(fixture("playback_capability_available").installation_id);
        fake.extraRoutes.push((method, path, headers, body) => this.route(method, path, headers, body));
    }

    session(id: string): Session {
        const session = this.sessions.get(id);
        if (session === undefined) {
            throw new Error(`no playback session ${id}`);
        }
        return session;
    }

    /** An administrator terminates the session: progress and replan then answer 410. */
    endByAdmin(id: string): void {
        const session = this.session(id);
        session.endedByAdmin = true;
        session.receipt = { outcome: "stopped", stop_id: "00000000-0000-5000-8000-000000000000" };
    }

    private route(method: string, path: string, headers: Record<string, string>, body: Record<string, unknown> | undefined): Reply | undefined {
        if (!path.startsWith("/playback")) {
            return undefined;
        }
        if (this.fake.authenticate(headers) === undefined) {
            return problem(401, "authentication_required", "Authentication required");
        }
        const profileId = headers["x-profile-id"];
        if (profileId === undefined) {
            return problem(422, "validation_failed", "X-Profile-Id is required");
        }
        if (method === "GET" && path === "/playback/capabilities") {
            return { status: 200, body: fixture(this.configured ? "playback_capability_available" : "playback_capability_unconfigured") };
        }
        if (body === undefined) {
            return problem(422, "validation_failed", "Body required");
        }
        if (body.installation_id !== this.installationId) {
            return { status: 409, headers: PROBLEM_JSON, body: fixture("playback_installation_changed") };
        }
        if (method === "POST" && path === "/playback/start") {
            return this.start(profileId, body);
        }
        const match = /^\/playback\/([^/]+)(\/progress|\/replan)?$/.exec(path);
        const session = match?.[1] === undefined ? undefined : this.sessions.get(decodeURIComponent(match[1]));
        if (session === undefined || match === null) {
            return problem(404, "not_found", "Playback session not found");
        }
        if (session.profileId !== profileId) {
            return problem(403, "forbidden", "Forbidden");
        }
        if (method === "DELETE" && match[2] === undefined) {
            return this.stop(session, body);
        }
        if (session.endedByAdmin) {
            return problem(410, "playback_session_ended", "Playback session ended");
        }
        if (session.receipt !== undefined) {
            return problem(404, "not_found", "Playback session not found");
        }
        if (method === "POST" && match[2] === "/progress") {
            return this.progress(session, body);
        }
        if (method === "POST" && match[2] === "/replan") {
            return this.replan(session, body);
        }
        return undefined;
    }

    private start(profileId: string, body: Record<string, unknown>): Reply {
        if (body.protocol_version !== 3 || body.profile_id !== profileId) {
            return problem(422, "validation_failed", "Invalid start");
        }
        const attemptId = String(body.playback_attempt_id);
        const digest = JSON.stringify(body);
        const known = this.attempts.get(attemptId);
        if (known !== undefined) {
            if (known.digest !== digest) {
                return problem(409, "idempotency_conflict", "Attempt reused");
            }
            const ended = known.sessionId !== undefined && this.sessions.get(known.sessionId)?.receipt !== undefined;
            return ended ? this.terminal("session_expired", true, 201) : known.reply;
        }
        const decision = this.next.shift() ?? {};
        if ("terminal" in decision) {
            const reply = this.terminal(decision.terminal, decision.retryable ?? false, 201);
            this.attempts.set(attemptId, { digest, reply, sessionId: undefined });
            return reply;
        }
        const id = `5e55${String(++this.serial).padStart(4, "0")}-0000-4000-8000-000000000000`;
        const session: Session = {
            id,
            profileId,
            attemptId,
            planId: "",
            planKey: "",
            lastSequence: 0,
            lastSample: undefined,
            receipt: undefined,
            endedByAdmin: false,
            replans: new Map(),
        };
        this.sessions.set(id, session);
        const reply = this.playable(session, decision, 201);
        this.attempts.set(attemptId, { digest, reply, sessionId: id });
        return reply;
    }

    private progress(session: Session, body: Record<string, unknown>): Reply {
        const sequence = Number(body.sequence);
        const sample = { position: body.position, isPaused: body.is_paused };
        if (sequence === session.lastSequence) {
            return sample.position === session.lastSample?.position && sample.isPaused === session.lastSample?.isPaused
                ? { status: 200, body: { ...fixture("playback_progress_applied"), outcome: "replayed", accepted: this.accepted(session) } }
                : { status: 409, headers: PROBLEM_JSON, body: fixture("playback_progress_conflict") };
        }
        if (sequence < session.lastSequence) {
            return { status: 200, body: { ...fixture("playback_progress_stale"), accepted: this.accepted(session) } };
        }
        session.lastSequence = sequence;
        session.lastSample = sample;
        return { status: 200, body: { ...fixture("playback_progress_applied"), accepted: this.accepted(session) } };
    }

    private stop(session: Session, body: Record<string, unknown>): Reply {
        if (session.receipt !== undefined) {
            return { status: 200, body: { ...fixture("playback_stop_replayed"), ...session.receipt, outcome: "replayed" } };
        }
        if (body.sequence !== undefined && Number(body.sequence) > session.lastSequence) {
            session.lastSequence = Number(body.sequence);
            session.lastSample = { position: body.position, isPaused: body.is_paused };
        }
        session.receipt = { stop_id: body.stop_id, accepted: this.accepted(session) };
        return { status: 200, body: { ...fixture("playback_stop_completed"), ...session.receipt } };
    }

    private replan(session: Session, body: Record<string, unknown>): Reply {
        const requestId = String(body.replan_request_id);
        const digest = JSON.stringify(body);
        const known = session.replans.get(requestId);
        if (known !== undefined) {
            return known.digest === digest ? known.reply : problem(409, "idempotency_key_reused", "Replan id reused");
        }
        if (body.playback_attempt_id !== session.attemptId || body.failed_plan_id !== session.planId || body.plan_attempt_key !== session.planKey) {
            return problem(409, "stale_playback_plan", "Stale plan");
        }
        const decision = this.next.shift() ?? {};
        const reply = "terminal" in decision ? this.terminal(decision.terminal, decision.retryable ?? false, 200) : this.playable(session, decision, 200);
        session.replans.set(requestId, { digest, reply });
        return reply;
    }

    private playable(session: Session, shape: PlanShape, status: number): Reply {
        const n = ++this.serial;
        session.planId = `plan:${String(n).padStart(32, "0")}`;
        session.planKey = `v3:${String(n).padStart(16, "0")}`;
        const base = fixture("playback_start_opaque_ids");
        const plan = toRecord(base.playback_plan);
        const stream = toRecord(plan.stream);
        const source = toRecord(plan.source);
        return {
            status,
            body: {
                ...base,
                session_id: session.id,
                playback_plan: {
                    ...plan,
                    session_id: session.id,
                    plan_id: session.planId,
                    plan_attempt_key: session.planKey,
                    delivery: shape.delivery ?? plan.delivery,
                    stream: { ...stream, url: shape.url === undefined ? `/api/v2/stream/${session.id}?st=signed-${n}` : shape.url(session.id) },
                    timeline: { ...toRecord(plan.timeline), ...shape.timeline },
                    source: { ...source, duration_seconds: shape.durationSeconds ?? source.duration_seconds },
                },
            },
        };
    }

    private terminal(reason: string, retryable: boolean, status: number): Reply {
        const base = fixture("playback_start_opaque_ids");
        return {
            status,
            body: {
                protocol_version: 3,
                server_features: base.server_features,
                outcome: "adaptation_unavailable",
                terminal: { reason, message: `Cannot play: ${reason}`, retryable },
            },
        };
    }

    private accepted(session: Session): Record<string, unknown> | undefined {
        const sample = session.lastSample;
        return sample === undefined ? undefined : { sequence: session.lastSequence, position: sample.position, is_paused: sample.isPaused };
    }
}

function toRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("expected an object");
    }
    return { ...value };
}
