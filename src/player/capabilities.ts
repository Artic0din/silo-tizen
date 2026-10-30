// What this client tells the server it can play. The server plans the route from it
// (protocol v3 §3, §4); the client never chooses direct, remux or transcode itself.
//
// Conservative for every 2021-or-later Samsung TV: Samsung's 2021 TV video specification lists
// H.264 and HEVC (MP4, MKV and TS), AAC, AC3, E-AC3 and MP3, and no DTS. Tizen offers no decoder
// enumeration, so the evidence tier is `declared`, capped at 1080p SDR because panel size and
// HDR output are not probed. Audio passthrough is never claimed. Subtitles are off until #11.
// The progressive class is omitted (no proof AVPlay plays a forward-only chunked remux).

import type { ClientCapabilities, ClientPlaybackContext, DeliveryCapability } from "../contracts/v2/playback.ts";

const VIDEO_CODECS = ["h264", "hevc"];
const AUDIO_CODECS = ["aac", "ac3", "eac3", "mp3"];

const NO_SUBTITLES = {
    embedded_text: false,
    sidecar_text: false,
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

/** Start and replan send the same features; only the protocol marker is negotiated. */
export const CLIENT_FEATURES: readonly string[] = ["playback_plan_v3"];

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

export function playbackContext(model: string, appVersion: string): ClientPlaybackContext {
    return {
        protocol_version: 3,
        form_factor: "tv",
        app_version: appVersion,
        device: { platform: "tizen", manufacturer: "Samsung", model },
        output: {},
        deliveries: {
            original_http: delivery(["mp4", "m4v", "mkv", "matroska"], []),
            // MPEG-TS segments for copy remuxes, as AVPlay HLS plays them.
            hls: delivery(["m3u8", "hls"], ["hls_copy_mpegts_v1"]),
        },
    };
}
