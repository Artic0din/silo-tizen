// What this client tells the server it can play. The server plans the route from it
// (protocol v3 §3, §4); the client never chooses direct, remux or transcode itself.
//
// Conservative for every Samsung TV on Tizen 8.0 or later. The OS version does not fix the panel's
// decoder generation, so this keeps to Samsung's 2021 TV video specification, which lists
// H.264 and HEVC (MP4, MKV and TS), AAC, AC3, E-AC3 and MP3, and no DTS. Tizen offers no decoder
// enumeration, so the evidence tier is `declared`, capped at 1080p SDR because panel size and
// HDR output are not probed. Audio passthrough is never claimed. Every subtitle capability
// uses the app's plain-text sidecar renderer for sidecars. Embedded text is selected with
// AVPlay setSelectTrack when the open stream lists a TEXT row; bitmap and ASS styling stay off.
// The progressive class is omitted (no proof AVPlay plays a forward-only chunked remux).

import type { ClientCapabilities, ClientPlaybackContext, DeliveryCapability } from "../contracts/v2/playback.ts";

const VIDEO_CODECS = ["h264", "hevc"];
const AUDIO_CODECS = ["aac", "ac3", "eac3", "mp3"];

const NO_SUBTITLES = {
    embedded_text: true,
    sidecar_text: true,
    ass_styling: false,
    embedded_bitmap: false,
    sidecar_bitmap: false,
    font_attachments: false,
};

function delivery(containers: readonly string[], features: readonly string[]): DeliveryCapability {
    return {
        enabled: true,
        supported_on_device: true,
        containers,
        video_codecs: VIDEO_CODECS,
        audio_decode_codecs: AUDIO_CODECS,
        audio_passthrough_codecs: [],
        subtitles: NO_SUBTITLES,
        features,
        // AVPlay cannot change a URL's credential without reopening it.
        auth_header_refresh: false,
        validated_claims: [],
        transformations: [],
    };
}

/** The server carries an embedded text track inside an HLS stream instead of a whole-file sidecar. */
export const HLS_SUBTITLE_RENDITIONS_FEATURE = "hls_subtitle_renditions_v1";
/** Same rendition on a copy remux, which `hls_subtitle_renditions_v1` does not cover. */
export const HLS_REMUX_SUBTITLE_RENDITIONS_FEATURE = "hls_remux_subtitle_renditions_v1";
/**
 * Every embedded text track is a rendition of the stream. Sent only after the server
 * advertises it, then repeated on every replan of that attempt.
 */
export const HLS_SUBTITLE_RENDITIONS_ALL_FEATURE = "hls_subtitle_renditions_all_v1";

/** Start and replan send the same base features. Renditions-all is attempt-sticky. */
export const CLIENT_FEATURES: readonly string[] = [
    "playback_plan_v3",
    "embedded_subtitles_v1",
    HLS_SUBTITLE_RENDITIONS_FEATURE,
    HLS_REMUX_SUBTITLE_RENDITIONS_FEATURE,
];

export function clientFeatures(renditionsAll: boolean): readonly string[] {
    return renditionsAll ? [...CLIENT_FEATURES, HLS_SUBTITLE_RENDITIONS_ALL_FEATURE] : CLIENT_FEATURES;
}

export const CLIENT_CAPABILITIES: ClientCapabilities = {
    video_evidence: "declared",
    audio_evidence: "declared",
    codecs_video: VIDEO_CODECS,
    codecs_video_hardware: VIDEO_CODECS,
    codecs_audio: AUDIO_CODECS,
    containers: ["mp4", "m4v", "mkv", "matroska", "m3u8", "hls"],
    max_resolution: "1080p",
    hdr: false,
    // On the declared tier these entries only narrow the flat lists.
    video_decode: [
        { codec: "h264", hardware: true, bit_depths: [8], max_width: 1920, max_height: 1080 },
        { codec: "hevc", hardware: true, bit_depths: [8, 10], max_width: 1920, max_height: 1080 },
    ],
};

export function playbackContext(model: string, appVersion: string, originalEmbeddedText = true): ClientPlaybackContext {
    const original = delivery(["mp4", "m4v", "mkv", "matroska"], []);
    return {
        protocol_version: 3,
        form_factor: "tv",
        app_version: appVersion,
        device: { platform: "tizen", manufacturer: "Samsung", model },
        output: {},
        deliveries: {
            original_http: { ...original, subtitles: { ...original.subtitles, embedded_text: originalEmbeddedText } },
            // MPEG-TS segments for copy remuxes, as AVPlay HLS plays them.
            hls: delivery(["m3u8", "hls"], ["hls_copy_mpegts_v1"]),
        },
    };
}
