// Native /api/v2 playback bodies (docs/playback-api.md) around protocol v3 planning
// (docs/architecture/playback-protocol-v3.md), at the server commit in ./SOURCE.
// Request bodies are typed in full; responses decode only the members the player reads.
// Plan identities are opaque: they are stored and echoed byte-for-byte, never parsed.

import { boolean, integer, nonEmptyString, object, optionalString, string, WireError } from "./wire.ts";

type WireObject = ReturnType<typeof object>;

function number(obj: WireObject, key: string, path: string): number {
    const value = obj[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new WireError(`${path}.${key}`, "a number");
    }
    return value;
}

function optionalNumber(obj: WireObject, key: string, path: string): number | undefined {
    return obj[key] === undefined ? undefined : number(obj, key, path);
}

function strings(obj: WireObject, key: string, path: string): string[] {
    const value = obj[key];
    if (!Array.isArray(value)) {
        throw new WireError(`${path}.${key}`, "an array");
    }
    return value.map((entry: unknown, index: number) => {
        if (typeof entry !== "string") {
            throw new WireError(`${path}.${key}[${index}]`, "a string");
        }
        return entry;
    });
}

function oneOf<T extends string>(raw: string, known: readonly T[]): T | "unknown" {
    for (const value of known) {
        if (value === raw) {
            return value;
        }
    }
    return "unknown";
}

// --- getPlaybackCapabilities ---

const CAPABILITY_STATES = ["available", "disabled", "not_configured", "unsupported"] as const;

export interface PlaybackCapabilities {
    readonly state: (typeof CAPABILITY_STATES)[number] | "unknown";
    readonly allowed: boolean;
    /** Echoed on every mutation; absent when playback is not configured. */
    readonly installationId: string | undefined;
    readonly protocolVersions: readonly number[];
}

export function decodePlaybackCapabilities(value: unknown): PlaybackCapabilities {
    const path = "playback_capabilities";
    const obj = object(value, path);
    const versions = obj.protocol_versions;
    if (!Array.isArray(versions) || !versions.every((entry: unknown) => typeof entry === "number")) {
        throw new WireError(`${path}.protocol_versions`, "an array of integers");
    }
    return {
        state: oneOf(string(obj, "state", path), CAPABILITY_STATES),
        allowed: boolean(obj, "allowed", path),
        installationId: optionalString(obj, "installation_id", path),
        protocolVersions: versions.filter((entry: unknown): entry is number => typeof entry === "number"),
    };
}

// --- startPlayback / replanPlayback decisions ---

const DELIVERIES = ["original_http", "server_remux_progressive", "server_remux_hls", "server_transcode_hls"] as const;

export type TrackIdentity = {
    readonly id: string;
    readonly index?: number;
};

export type SelectedTracks = {
    readonly audio?: TrackIdentity;
    readonly subtitle?: TrackIdentity;
};

/** Protocol v3 §5: four numbers a client keeps distinct. Seconds. */
export interface PlanTimeline {
    readonly sourceStartSeconds: number;
    readonly streamOriginSeconds: number;
    readonly playerStartSeconds: number;
    /** Player position + offset = source position. */
    readonly timelineOffsetSeconds: number;
    readonly canSeekAnywhere: boolean;
    readonly seekRestoration: string;
    readonly seekWindowStartSeconds: number | undefined;
    readonly seekWindowEndSeconds: number | undefined;
}

export interface PlaybackPlan {
    /** Opaque; echoed as failed_plan_id. */
    readonly planId: string;
    /** Opaque `v3:` loop-guard key; echoed and collected unchanged. */
    readonly planAttemptKey: string;
    readonly delivery: (typeof DELIVERIES)[number] | "unknown";
    /** As published: root-relative on the API origin or absolute on a node origin. */
    readonly streamUrl: string;
    readonly timeline: PlanTimeline;
    readonly selectedTracks: SelectedTracks;
    /** Full runtime; undefined when the server does not know it. Never the engine's duration. */
    readonly durationSeconds: number | undefined;
}

export interface PlaybackTerminal {
    readonly reason: string;
    readonly message: string;
    readonly retryable: boolean;
}

export type PlaybackDecision =
    | { readonly outcome: "playable"; readonly sessionId: string; readonly plan: PlaybackPlan }
    | { readonly outcome: "adaptation_unavailable"; readonly terminal: PlaybackTerminal }
    | { readonly outcome: "unknown" };

function decodeTrack(value: unknown, path: string): TrackIdentity | undefined {
    if (value === undefined) {
        return undefined;
    }
    const obj = object(value, path);
    const id = nonEmptyString(obj, "id", path);
    return obj.index === undefined ? { id } : { id, index: integer(obj, "index", path) };
}

function decodeTimeline(value: unknown, path: string): PlanTimeline {
    const obj = object(value, path);
    return {
        sourceStartSeconds: number(obj, "source_start_seconds", path),
        streamOriginSeconds: number(obj, "stream_origin_seconds", path),
        playerStartSeconds: number(obj, "player_start_seconds", path),
        timelineOffsetSeconds: number(obj, "timeline_offset_seconds", path),
        canSeekAnywhere: boolean(obj, "can_seek_anywhere", path),
        seekRestoration: string(obj, "seek_restoration", path),
        seekWindowStartSeconds: optionalNumber(obj, "seek_window_start_seconds", path),
        seekWindowEndSeconds: optionalNumber(obj, "seek_window_end_seconds", path),
    };
}

function decodePlan(value: unknown, path: string): PlaybackPlan {
    const obj = object(value, path);
    const tracks = object(obj.selected_tracks, `${path}.selected_tracks`);
    const audio = decodeTrack(tracks.audio, `${path}.selected_tracks.audio`);
    const subtitle = decodeTrack(tracks.subtitle, `${path}.selected_tracks.subtitle`);
    const source = object(obj.source, `${path}.source`);
    return {
        planId: nonEmptyString(obj, "plan_id", path),
        planAttemptKey: nonEmptyString(obj, "plan_attempt_key", path),
        delivery: oneOf(string(obj, "delivery", path), DELIVERIES),
        streamUrl: nonEmptyString(object(obj.stream, `${path}.stream`), "url", `${path}.stream`),
        timeline: decodeTimeline(obj.timeline, `${path}.timeline`),
        selectedTracks: { ...(audio === undefined ? {} : { audio }), ...(subtitle === undefined ? {} : { subtitle }) },
        durationSeconds: optionalNumber(source, "duration_seconds", `${path}.source`),
    };
}

export function decodePlaybackDecision(value: unknown): PlaybackDecision {
    const path = "playback_decision";
    const obj = object(value, path);
    if (integer(obj, "protocol_version", path) !== 3) {
        throw new WireError(`${path}.protocol_version`, "3");
    }
    const outcome = string(obj, "outcome", path);
    if (outcome === "playable") {
        return {
            outcome,
            sessionId: nonEmptyString(obj, "session_id", path),
            plan: decodePlan(obj.playback_plan, `${path}.playback_plan`),
        };
    }
    if (outcome === "adaptation_unavailable") {
        const terminal = object(obj.terminal, `${path}.terminal`);
        return {
            outcome,
            terminal: {
                reason: string(terminal, "reason", `${path}.terminal`),
                message: string(terminal, "message", `${path}.terminal`),
                retryable: boolean(terminal, "retryable", `${path}.terminal`),
            },
        };
    }
    return { outcome: "unknown" };
}

// --- updatePlaybackProgress / stopPlayback receipts ---

const MUTATION_OUTCOMES = ["applied", "stale_sample", "replayed", "stopped"] as const;

export interface PlaybackMutation {
    readonly outcome: (typeof MUTATION_OUTCOMES)[number] | "unknown";
    /** The latest committed sample. */
    readonly acceptedSequence: number | undefined;
}

export function decodePlaybackMutation(value: unknown): PlaybackMutation {
    const path = "playback_mutation";
    const obj = object(value, path);
    const accepted = obj.accepted === undefined ? undefined : object(obj.accepted, `${path}.accepted`);
    return {
        outcome: oneOf(string(obj, "outcome", path), MUTATION_OUTCOMES),
        acceptedSequence: accepted === undefined ? undefined : integer(accepted, "sequence", `${path}.accepted`),
    };
}

// --- Request bodies ---

export type DeliverySubtitles = {
    readonly embedded_text: boolean;
    readonly sidecar_text: boolean;
    readonly ass_styling: boolean;
    readonly embedded_bitmap: boolean;
    readonly sidecar_bitmap: boolean;
    readonly font_attachments: boolean;
};

/** DeliveryCapabilityV3 for one client class (original_http, progressive, hls). */
export type DeliveryCapability = {
    readonly enabled: boolean;
    readonly supported_on_device: boolean;
    readonly containers: readonly string[];
    readonly video_codecs: readonly string[];
    readonly audio_decode_codecs: readonly string[];
    readonly audio_passthrough_codecs: readonly string[];
    readonly subtitles: DeliverySubtitles;
    readonly features: readonly string[];
    readonly auth_header_refresh: boolean;
    readonly validated_claims: readonly string[];
    readonly transformations: readonly never[];
};

export type VideoDecodeCapability = {
    readonly codec: string;
    readonly hardware: boolean;
    readonly bit_depths?: readonly number[];
    readonly max_width?: number;
    readonly max_height?: number;
};

/** ClientCodecCapabilitiesV3. */
export type ClientCapabilities = {
    readonly video_evidence: "exact" | "platform_attested" | "declared";
    readonly audio_evidence: "exact" | "platform_attested" | "declared";
    readonly codecs_video: readonly string[];
    readonly codecs_video_hardware: readonly string[];
    readonly codecs_audio: readonly string[];
    readonly containers: readonly string[];
    readonly max_resolution: string;
    readonly hdr: boolean;
    readonly video_decode: readonly VideoDecodeCapability[];
};

/** ClientPlaybackContextV3. */
export type ClientPlaybackContext = {
    readonly protocol_version: 3;
    readonly form_factor: "tv";
    readonly app_version: string;
    readonly device: {
        readonly platform: string;
        readonly manufacturer: string;
        readonly model: string;
    };
    readonly output: { readonly [key: string]: never };
    readonly deliveries: { readonly [deliveryClass: string]: DeliveryCapability };
};

export type StartPlaybackBody = {
    readonly installation_id: string;
    readonly protocol_version: 3;
    readonly client_features: readonly string[];
    readonly file_id: string;
    readonly profile_id: string;
    readonly playback_attempt_id: string;
    readonly quality_preference: string;
    readonly subtitle_fidelity_preference: "preserve" | "compatible";
    /** Omitted: the server resumes from the profile's saved position. */
    readonly start_position?: number;
    readonly client_capabilities: ClientCapabilities;
    readonly client_playback_context: ClientPlaybackContext;
};

export type ReplanOperation = "failure_recovery" | "seek_reanchor";

export type ReplanPlaybackBody = {
    readonly installation_id: string;
    readonly protocol_version: 3;
    readonly client_features: readonly string[];
    readonly operation: ReplanOperation;
    readonly playback_attempt_id: string;
    readonly replan_request_id: string;
    readonly failed_plan_id: string;
    readonly plan_attempt_id: string;
    readonly plan_attempt_key: string;
    readonly attempted_plan_keys: readonly string[];
    readonly attempt_count: number;
    readonly quality_preference: string;
    readonly position_seconds: number;
    readonly selected_tracks: SelectedTracks;
    readonly failure?: { readonly classification: string };
    readonly client_capabilities: ClientCapabilities;
    readonly client_playback_context: ClientPlaybackContext;
};

export type ProgressBody = {
    readonly installation_id: string;
    readonly sequence: number;
    readonly position: number;
    readonly is_paused: boolean;
};

export type StopBody = {
    readonly installation_id: string;
    /** Canonical UUID minted once per stop and kept on every retry. */
    readonly stop_id: string;
    readonly sequence: number;
    readonly position: number;
    readonly is_paused: boolean;
};
