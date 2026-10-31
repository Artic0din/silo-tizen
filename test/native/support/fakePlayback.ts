// The native playback operations for FakeSilo, following docs/playback-api.md and
// playback-protocol-v3.md at the pinned commit: installation check, start idempotency on
// playback_attempt_id plus body, sequenced progress compare-and-set, first-stop-wins receipts,
// replan idempotency on replan_request_id, stale-plan refusal and 410 for an administrator's end.
// Bodies start from the vendored fixtures; plans the fixtures do not cover (offset timelines,
// terminals, problems without a fixture) are built from the OpenAPI schemas.
//
// Tracks follow the pinned server: ids are `file:{effective file}:{audio|subtitle}:{ordinal}`
// (internal/playback/tracks_v3.go), the audio ordinal indexes the file's audio_tracks
// (resolveV3AudioIndex), and with every subtitle capability false an embedded track is burned in
// while an external or downloaded one is refused (subtitle_policy_v3.go). A refused track_change
// keeps the session's current plan, as the server's terminal replan does.

import { fixture, type FakeSilo, problem, type Reply } from "./fakeSilo.ts";

const PROBLEM_JSON = { "Content-Type": "application/problem+json" };

/** One media file as the server knows it: AudioTrack bodies and its subtitle inventory. */
export interface FakeMediaFile {
    readonly id: string;
    readonly audio: readonly Record<string, unknown>[];
    readonly inventory: readonly Record<string, unknown>[];
}

const TRACK_ID = /^file:([1-9][0-9]*):(audio|subtitle):(0|[1-9][0-9]*)$/;

function inventoryFor(fileId: string, ordinals: readonly number[]): Record<string, unknown>[] {
    const plan = toRecord(fixture("playback_start_opaque_ids").playback_plan);
    const all = toRecord(plan.subtitle).inventory;
    if (!Array.isArray(all)) {
        throw new Error("fixture inventory");
    }
    return ordinals.map((ordinal, index) => {
        const entry = toRecord(all[ordinal]);
        return { ...entry, track_id: `file:${fileId}:subtitle:${index}`, combined_index: index };
    });
}

/** The fixture's file 42 and an alternate edition 43 of the same item, `movie-1`. */
export function defaultFiles(): Map<string, FakeMediaFile> {
    return new Map([
        [
            "42",
            {
                id: "42",
                audio: [
                    { default: true, language: "en", codec: "eac3", channels: 6, layout: "5.1", title: "English" },
                    { default: false, language: "ja", codec: "aac", channels: 2, layout: "stereo", title: "Japanese" },
                    { default: false, language: "en", codec: "aac", channels: 2, layout: "stereo", title: "Commentary" },
                ],
                inventory: inventoryFor("42", [0, 1, 2, 3, 4]),
            },
        ],
        [
            "43",
            {
                id: "43",
                audio: [
                    { default: true, language: "ja", codec: "aac", channels: 2, layout: "stereo" },
                    { default: false, language: "en", codec: "eac3", channels: 6, layout: "5.1", embedded_title: "English Dub" },
                ],
                inventory: inventoryFor("43", [0, 2]),
            },
        ],
    ]);
}

export interface PlanShape {
    readonly availableQualities?: readonly Record<string, unknown>[];
    readonly activeQuality?: string;
    readonly serverFeatures?: readonly string[];
    readonly delivery?: string;
    /** The edition the server plays; defaults to the session's current one (the requested file at start). */
    readonly effectiveFileId?: string;
    /** A subtitle ordinal the plan burns in. */
    readonly subtitle?: number;
    readonly subtitleArtifact?: { readonly url: string; readonly format: string; readonly timing_origin_seconds: number };
    readonly timeline?: Record<string, unknown>;
    /** Replaces the default `/api/v2/stream/<session>?st=<signed>` URL. */
    readonly url?: (sessionId: string) => string;
    readonly durationSeconds?: number;
}

export type NextDecision = PlanShape | { readonly terminal: string; readonly retryable?: boolean };

interface Session {
    readonly requestedFileId: string;
    readonly pinnedFileId: string | undefined;
    readonly id: string;
    readonly profileId: string;
    readonly attemptId: string;
    effectiveFileId: string;
    audioIndex: number;
    subtitle: number | undefined;
    warnings: { code: string; message: string }[];
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
    automaticAudioIndex = 0;
    /** Decisions for the next starts and replans, first in first out; default: a direct plan. */
    readonly next: NextDecision[] = [];
    readonly sessions = new Map<string, Session>();
    readonly files = defaultFiles();
    /** Catalog item id to its files, in version order. */
    readonly items = new Map<string, string[]>([["movie-1", ["42", "43"]]]);
    private readonly attempts = new Map<string, { digest: string; reply: Reply; sessionId: string | undefined }>();
    private serial = 0;
    private readonly fake: FakeSilo;

    constructor(fake: FakeSilo) {
        this.fake = fake;
        this.installationId = String(fixture("playback_capability_available").installation_id);
        fake.extraRoutes.push((method, path, headers, body) => this.route(method, path, headers, body));
        fake.extraRoutes.push((method, path, headers) => this.versions(method, path, headers));
    }

    /** listCatalogItemVersions: the item's files with their audio_tracks, from the vendored version template. */
    private versions(method: string, path: string, headers: Record<string, string>): Reply | undefined {
        const match = /^\/catalog\/items\/([^/?]+)\/versions$/.exec(path);
        if (method !== "GET" || match?.[1] === undefined) {
            return undefined;
        }
        if (this.fake.authenticate(headers) === undefined) {
            return problem(401, "authentication_required", "Authentication required");
        }
        if (headers["x-profile-id"] === undefined) {
            return problem(422, "validation_failed", "X-Profile-Id is required");
        }
        const files = this.items.get(decodeURIComponent(match[1]));
        if (files === undefined) {
            return problem(404, "not_found", "Not found");
        }
        const collection = fixture("list_catalog_item_versions_ok");
        const template = Array.isArray(collection.items) ? toRecord(collection.items[0]) : {};
        return {
            status: 200,
            body: { ...collection, items: files.map((id) => ({ ...template, file_id: id, audio_tracks: this.file(id).audio })) },
        };
    }

    file(id: string): FakeMediaFile {
        const file = this.files.get(id);
        if (file === undefined) {
            throw new Error(`no media file ${id}`);
        }
        return file;
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
        if (method === "GET" && path.startsWith("/settings/values/effective?")) {
            const keys = new URL(path, "https://fake.invalid").searchParams.getAll("keys");
            if (!keys.every(key => key === "playback.preferred_quality" || key === "playback.max_bitrate_kbps")) return undefined;
            return { status: 200, body: { revision: 24, items: keys.map(key => ({ key, value: key === "playback.preferred_quality" ? "auto" : null, source: "default", definition_revision: 24 })) } };
        }
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
        const file = this.file(String(body.file_id));
        const index = body.audio_track_index;
        const audio = body.audio_track_id === undefined ? index ?? this.automaticAudioIndex
            : this.ordinal({ id: body.audio_track_id, ...(index === undefined ? {} : { index }) }, "audio", file.id);
        if (typeof audio !== "number" || !Number.isInteger(audio) || audio < 0 || audio > 10000) return problem(422, "validation_failed", "Invalid audio selection");
        if (body.start_position !== undefined && (typeof body.start_position !== "number" || !Number.isFinite(body.start_position) || body.start_position < 0 || body.start_position > 31536000)) return problem(422, "validation_failed", "Invalid start position");
        const decision = this.next.shift() ?? {};
        if ("terminal" in decision) {
            const reply = this.terminal(decision.terminal, decision.retryable ?? false, 201);
            this.attempts.set(attemptId, { digest, reply, sessionId: undefined });
            return reply;
        }
        const id = `5e55${String(++this.serial).padStart(4, "0")}-0000-4000-8000-000000000000`;
        const session: Session = {
            requestedFileId: String(body.file_id),
            id,
            profileId,
            attemptId,
            pinnedFileId: body.allow_alternate_versions === false ? file.id : undefined,
            effectiveFileId: String(body.file_id),
            audioIndex: audio < file.audio.length ? audio : 0,
            subtitle: undefined,
            warnings: [],
            planId: "",
            planKey: "",
            lastSequence: 0,
            lastSample: undefined,
            receipt: undefined,
            endedByAdmin: false,
            replans: new Map(),
        };
        this.sessions.set(id, session);
        const sourceStart = typeof body.start_position === "number" ? body.start_position : 0;
        const reply = this.playable(session, { ...decision, ...(body.allow_alternate_versions === false ? { effectiveFileId: file.id } : {}), timeline: { source_start_seconds: sourceStart, player_start_seconds: sourceStart, timeline_offset_seconds: 0, ...decision.timeline } }, 201);
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
        this.fake.catalog?.playbackStopped?.(session.requestedFileId, session.effectiveFileId, Number(session.lastSample?.position ?? 0));
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
        const queued = this.next.shift();
        const reply =
            queued === undefined && body.operation === "track_change"
                ? this.trackChange(session, body)
                : queued !== undefined && "terminal" in queued
                  ? this.terminal(queued.terminal, queued.retryable ?? false, 200)
                  : this.playable(session, queued ?? {}, 200);
        if (reply.status !== 400) {
            session.replans.set(requestId, { digest, reply });
        }
        return reply;
    }

    /** The viewer's new tracks, applied only when a plan can play them. */
    private trackChange(session: Session, body: Record<string, unknown>): Reply {
        const selected = body.selected_tracks === undefined ? {} : toRecord(body.selected_tracks);
        const file = this.file(session.effectiveFileId);
        const audio = selected.audio === undefined ? session.audioIndex : this.ordinal(selected.audio, "audio", file.id);
        const subtitle = selected.subtitle === undefined ? undefined : this.ordinal(selected.subtitle, "subtitle", file.id);
        if (audio === undefined || (selected.subtitle !== undefined && subtitle === undefined)) {
            return problem(400, "bad_request", "Invalid track identity");
        }
        const warnings: { code: string; message: string }[] = [];
        let audioIndex = audio;
        if (audioIndex >= file.audio.length) {
            audioIndex = 0;
            warnings.push({ code: "audio_track_unavailable", message: "The selected audio track is not on this file; its default track plays." });
        }
        let burn: number | undefined;
        if (subtitle !== undefined) {
            const entry = file.inventory[subtitle];
            if (entry === undefined) {
                warnings.push({ code: "subtitle_track_unavailable", message: "The selected subtitle is not on this file." });
            } else if (entry.source !== "embedded") {
                return this.terminal("subtitle_burn_in_source_unsupported", false, 200, "The selected subtitle source cannot be burned in by the installed transport.");
            } else {
                burn = subtitle;
            }
        }
        session.audioIndex = audioIndex;
        session.subtitle = burn;
        session.warnings = warnings;
        return this.playable(session, burn === undefined ? {} : { delivery: "server_transcode_hls" }, 200);
    }

    /** A canonical identity of this kind on this file; index, when sent, must agree. */
    private ordinal(value: unknown, kind: string, fileId: string): number | undefined {
        const track = toRecord(value);
        const match = TRACK_ID.exec(String(track.id));
        if (match === null || match[1] !== fileId || match[2] !== kind) {
            return undefined;
        }
        const ordinal = Number(match[3]);
        return track.index === undefined || track.index === ordinal ? ordinal : undefined;
    }

    private playable(session: Session, shape: PlanShape, status: number): Reply {
        if (shape.effectiveFileId !== undefined) {
            session.effectiveFileId = session.pinnedFileId ?? shape.effectiveFileId;
        }
        if (shape.subtitle !== undefined) {
            session.subtitle = shape.subtitle;
        }
        const file = this.file(session.effectiveFileId);
        const subtitleId = session.subtitle === undefined ? undefined : `file:${file.id}:subtitle:${session.subtitle}`;
        const warnings = session.subtitle === undefined ? session.warnings : [...session.warnings, { code: "subtitle_burn_in", message: "Subtitles rendered into the video" }];
        session.warnings = [];
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
                server_features: shape.serverFeatures ?? base.server_features,
                session_id: session.id,
                playback_plan: {
                    ...plan,
                    available_qualities: shape.availableQualities ?? [],
                    active_quality: shape.activeQuality,
                    session_id: session.id,
                    plan_id: session.planId,
                    plan_attempt_key: session.planKey,
                    delivery: shape.delivery ?? plan.delivery,
                    stream: { ...stream, url: shape.url === undefined ? `/api/v2/stream/${session.id}?st=signed-${n}` : shape.url(session.id) },
                    timeline: { ...toRecord(plan.timeline), ...shape.timeline },
                    source: { ...source, duration_seconds: shape.durationSeconds ?? source.duration_seconds },
                    effective_media_file_id: file.id,
                    selected_tracks: {
                        audio: { id: `file:${file.id}:audio:${session.audioIndex}`, index: session.audioIndex },
                        ...(subtitleId === undefined ? {} : { subtitle: { id: subtitleId, index: session.subtitle } }),
                    },
                    subtitle: {
                        mode: shape.subtitleArtifact !== undefined ? "render" : subtitleId === undefined ? "off" : "burn_in",
                        ...(shape.subtitleArtifact === undefined ? {} : { artifact: shape.subtitleArtifact }),
                        ...(subtitleId === undefined ? {} : { track_id: subtitleId }),
                        inventory: file.inventory,
                    },
                    degradation_warnings: warnings,
                },
            },
        };
    }

    private terminal(reason: string, retryable: boolean, status: number, message = `Cannot play: ${reason}`): Reply {
        const base = fixture("playback_start_opaque_ids");
        return {
            status,
            body: {
                protocol_version: 3,
                server_features: base.server_features,
                outcome: "adaptation_unavailable",
                terminal: { reason, message, retryable },
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
