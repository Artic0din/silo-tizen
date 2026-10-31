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

function optionalInteger(obj: WireObject, key: string, path: string): number | undefined {
    return obj[key] === undefined ? undefined : integer(obj, key, path);
}

function list(obj: WireObject, key: string, path: string): unknown[] {
    const value = obj[key];
    if (!Array.isArray(value)) {
        throw new WireError(`${path}.${key}`, "an array");
    }
    return value;
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
    readonly features: readonly string[];
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
        features: obj.features === undefined ? [] : strings(obj, "features", path),
    };
}

// --- startPlayback / replanPlayback decisions ---

const DELIVERIES = ["original_http", "server_remux_progressive", "server_remux_hls", "server_transcode_hls"] as const;
const SUBTITLE_MODES = ["off", "render", "convert", "burn_in"] as const;
const SUBTITLE_SOURCES = ["external", "embedded", "downloaded"] as const;
const SUBTITLE_DELIVERIES = ["sidecar", "burn_in_only"] as const;

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

/**
 * One entry of plan.subtitle.inventory (protocol v3 §8): the authoritative combined ordinal space.
 * Its track_id is echoed to select it; urls are not decoded because this client fetches none.
 */
export interface SubtitleTrack {
    readonly codec?: string | undefined;
    readonly trackId: string;
    readonly combinedIndex: number;
    readonly source: "external" | "embedded" | "downloaded" | "unknown";
    readonly delivery: "sidecar" | "burn_in_only" | "unknown";
    readonly label: string | undefined;
    readonly language: string | undefined;
    readonly forced: boolean;
    readonly hearingImpaired: boolean;
}

/** The current plan's subtitle decision; `off` carries no trackId even when the inventory lists tracks. */
export interface PlanSubtitle {
    readonly artifact?: { readonly url: string; readonly format: string; readonly origin: number } | undefined;
    readonly mode: "off" | "render" | "convert" | "burn_in" | "unknown";
    readonly trackId: string | undefined;
    readonly inventory: readonly SubtitleTrack[];
}

export interface DegradationWarning {
    readonly code: string;
    readonly message: string;
}

export interface PlaybackPlan {
    readonly availableQualities: readonly PlaybackQuality[];
    readonly activeQuality: string | undefined;
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
    /** The edition the plan plays; its track identities belong to this file, not the requested one. */
    readonly effectiveMediaFileId: string;
    readonly subtitle: PlanSubtitle;
    readonly warnings: readonly DegradationWarning[];
}

export interface PlaybackTerminal {
    readonly reason: string;
    readonly message: string;
    readonly retryable: boolean;
}

export type PlaybackDecision =
    | { readonly outcome: "playable"; readonly sessionId: string; readonly plan: PlaybackPlan; readonly serverFeatures: readonly string[] }
    | { readonly outcome: "adaptation_unavailable"; readonly terminal: PlaybackTerminal }
    | { readonly outcome: "unknown" };

export interface PlaybackQuality {
    readonly label: string;
    readonly displayName: string | undefined;
    readonly height: number | undefined;
    readonly bitrateKbps: number | undefined;
    readonly preservesSource: boolean;
}

function decodeQuality(value: unknown, path: string): PlaybackQuality {
    const obj = object(value, path);
    const label = nonEmptyString(obj, "label", path);
    if (label.trim() === "") {
        throw new WireError(`${path}.label`, "a nonblank string");
    }
    return {
        label,
        displayName: optionalString(obj, "display_name", path),
        height: optionalInteger(obj, "height", path),
        bitrateKbps: optionalInteger(obj, "bitrate_kbps", path),
        preservesSource: boolean(obj, "preserves_source", path),
    };
}

export interface PlaybackDefaults {
    readonly qualityPreference: string;
    readonly bandwidthCapKbps: number | undefined;
}

export const PLAYBACK_SETTING_KEYS: readonly string[] = ["playback.preferred_quality", "playback.max_bitrate_kbps"];

export function decodePlaybackDefaults(value: unknown): PlaybackDefaults {
    const path = "effective_settings";
    const entries = list(object(value, path), "items", path).map((entry, index) => object(entry, `${path}.items[${index}]`));
    const qualityEntry = entries.find((entry) => entry.key === PLAYBACK_SETTING_KEYS[0]);
    const quality = qualityEntry === undefined ? "auto" : string(qualityEntry, "value", path);
    const capEntry = entries.find((entry) => entry.key === PLAYBACK_SETTING_KEYS[1]);
    const cap = capEntry?.value;
    if (quality.trim() === "") {
        throw new WireError(`${path}.quality`, "a nonblank string");
    }
    if (capEntry !== undefined && cap !== null && (typeof cap !== "number" || !Number.isInteger(cap) || cap < 100 || cap > 200000)) {
        throw new WireError(`${path}.bandwidth`, "an integer from 100 to 200000 or null");
    }
    return { qualityPreference: quality === "original" ? "auto" : quality, bandwidthCapKbps: typeof cap === "number" ? cap : undefined };
}

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

function decodeSubtitleTrack(value: unknown, path: string): SubtitleTrack {
    const obj = object(value, path);
    return {
        codec: optionalString(obj, "codec", path),
        trackId: nonEmptyString(obj, "track_id", path),
        combinedIndex: integer(obj, "combined_index", path),
        source: oneOf(string(obj, "source", path), SUBTITLE_SOURCES),
        delivery: oneOf(string(obj, "delivery", path), SUBTITLE_DELIVERIES),
        label: optionalString(obj, "label", path),
        language: optionalString(obj, "language", path),
        forced: boolean(obj, "forced", path),
        hearingImpaired: boolean(obj, "hearing_impaired", path),
    };
}

function decodeSubtitle(value: unknown, path: string): PlanSubtitle {
    const obj = object(value, path);
    const artifact = obj.artifact === undefined ? undefined : object(obj.artifact, `${path}.artifact`);
    return {
        artifact: artifact === undefined ? undefined : { url: string(artifact, "url", path), format: string(artifact, "format", path), origin: number(artifact, "timing_origin_seconds", path) },
        mode: oneOf(string(obj, "mode", path), SUBTITLE_MODES),
        trackId: optionalString(obj, "track_id", path),
        inventory: list(obj, "inventory", path).map((entry, index) => decodeSubtitleTrack(entry, `${path}.inventory[${index}]`)),
    };
}

function decodeWarning(value: unknown, path: string): DegradationWarning {
    const obj = object(value, path);
    return { code: nonEmptyString(obj, "code", path), message: string(obj, "message", path) };
}

function decodePlan(value: unknown, path: string): PlaybackPlan {
    const obj = object(value, path);
    const tracks = object(obj.selected_tracks, `${path}.selected_tracks`);
    const audio = decodeTrack(tracks.audio, `${path}.selected_tracks.audio`);
    const subtitle = decodeTrack(tracks.subtitle, `${path}.selected_tracks.subtitle`);
    const source = object(obj.source, `${path}.source`);
    return {
        availableQualities: obj.available_qualities === undefined ? [] : list(obj, "available_qualities", path).map((entry, index) => decodeQuality(entry, `${path}.available_qualities[${index}]`)),
        activeQuality: optionalString(obj, "active_quality", path),
        planId: nonEmptyString(obj, "plan_id", path),
        planAttemptKey: nonEmptyString(obj, "plan_attempt_key", path),
        delivery: oneOf(string(obj, "delivery", path), DELIVERIES),
        streamUrl: nonEmptyString(object(obj.stream, `${path}.stream`), "url", `${path}.stream`),
        timeline: decodeTimeline(obj.timeline, `${path}.timeline`),
        selectedTracks: { ...(audio === undefined ? {} : { audio }), ...(subtitle === undefined ? {} : { subtitle }) },
        durationSeconds: optionalNumber(source, "duration_seconds", `${path}.source`),
        // openapi.json types it as an opaque string id (the v3 design schema shows an integer).
        effectiveMediaFileId: nonEmptyString(obj, "effective_media_file_id", path),
        subtitle: decodeSubtitle(obj.subtitle, `${path}.subtitle`),
        warnings: list(obj, "degradation_warnings", path).map((entry, index) => decodeWarning(entry, `${path}.degradation_warnings[${index}]`)),
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
            serverFeatures: obj.server_features === undefined ? [] : strings(obj, "server_features", path),
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
    readonly stopId?: string;
    readonly outcome: (typeof MUTATION_OUTCOMES)[number] | "unknown";
    /** The latest committed sample. */
    readonly acceptedSequence: number | undefined;
}

export function decodePlaybackMutation(value: unknown): PlaybackMutation {
    const path = "playback_mutation";
    const obj = object(value, path);
    const accepted = obj.accepted === undefined ? undefined : object(obj.accepted, `${path}.accepted`);
    if (accepted !== undefined) {
        const position = number(accepted, "position", `${path}.accepted`);
        if (position < 0 || integer(accepted, "sequence", `${path}.accepted`) < 1) throw new WireError(`${path}.accepted`, "a positive sequence and nonnegative position");
        boolean(accepted, "is_paused", `${path}.accepted`);
    }
    return {
        ...(obj.stop_id === undefined ? {} : { stopId: nonEmptyString(obj, "stop_id", path) }),
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
    readonly bandwidth_cap_kbps?: number;
    readonly subtitle_fidelity_preference: "preserve" | "compatible";
    /** Omitted: the server resumes from the profile's saved position. */
    readonly start_position?: number;
    readonly audio_track_id?: string;
    /** Omitted when subtitles are off, so a replacement start does not turn them on. */
    readonly subtitle_track_id?: string;
    readonly allow_alternate_versions?: false;
    readonly client_capabilities: ClientCapabilities;
    readonly client_playback_context: ClientPlaybackContext;
};

export type ReplanOperation = "failure_recovery" | "seek_reanchor" | "track_change" | "quality_change";

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
    readonly bandwidth_cap_kbps?: number;
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

// --- listCatalogItemVersions ---
// Each version's audio_tracks is the server's copy of the file's probed audio streams, in order
// (internal/catalog/detail.go). The audio ordinal of `file:{id}:audio:{n}` indexes that same list
// (resolveV3AudioIndex in internal/api/handlers/playback_v3.go), so position n names track n.

export interface AudioTrackInfo {
    readonly isDefault: boolean;
    readonly language: string | undefined;
    readonly codec: string | undefined;
    readonly channels: number | undefined;
    readonly title: string | undefined;
}

export interface FileVersionTracks {
    readonly fileId: string;
    readonly audio: readonly AudioTrackInfo[];
}

function decodeAudioTrack(value: unknown, path: string): AudioTrackInfo {
    const obj = object(value, path);
    return {
        isDefault: boolean(obj, "default", path),
        language: optionalString(obj, "language", path),
        codec: optionalString(obj, "codec", path),
        channels: optionalInteger(obj, "channels", path),
        title: optionalString(obj, "title", path) ?? optionalString(obj, "embedded_title", path),
    };
}

export function decodeAudioTracks(value: unknown, path: string): readonly AudioTrackInfo[] {
    const obj = object(value, path);
    return (obj.audio_tracks === undefined ? [] : list(obj, "audio_tracks", path))
        .map((track, index) => decodeAudioTrack(track, `${path}.audio_tracks[${index}]`));
}

export function decodeFileVersionTracks(value: unknown): FileVersionTracks[] {
    const path = "file_versions";
    const obj = object(value, path);
    return list(obj, "items", path).map((entry, index) => {
        const itemPath = `${path}.items[${index}]`;
        const item = object(entry, itemPath);
        return {
            fileId: nonEmptyString(item, "file_id", itemPath),
            audio: decodeAudioTracks(item, itemPath),
        };
    });
}
