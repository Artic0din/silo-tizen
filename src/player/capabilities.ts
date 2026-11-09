// What this client tells the server it can play. The server plans the route from it
// (protocol v3 §3, §4); the client never chooses direct, remux or transcode itself.
//
// Conservative for every Samsung TV on Tizen 8.0 or later. The OS version does not fix the panel's
// decoder generation, so this keeps to Samsung's 2021 TV video specification, which lists
// H.264 and HEVC (MP4, MKV and TS), AAC, AC3, E-AC3 and MP3, and no DTS. Tizen offers no decoder
// enumeration, so the evidence tier is `declared` and the resolution cap stays 1080p. HDR is
// claimed only when webapis.avinfo.isHdrTvSupport() returns true and the HDR setting is on.
// That call is one boolean. A true result claims HDR10 only. HDR10+ and HLG stay unclaimed:
// Samsung documents no per-format probe, and the year specifications do not list those formats
// for every TV on Tizen 8.0 or later. dolby_vision_profiles stays empty. Audio passthrough is never claimed.
// Every subtitle capability
// uses the app's plain-text sidecar renderer for sidecars. Embedded text is selected with AVPlay setSelectTrack
// when the open stream lists a TEXT row; bitmap and ASS styling stay off. The progressive class
// is omitted (no proof AVPlay plays a forward-only chunked remux).

import type { ClientCapabilities, ClientPlaybackContext, DeliveryCapability, HdrDetails } from "../contracts/v2/playback.ts";

/** What the panel reported. Dolby Vision stays false: Samsung does not document a probe for it. */
export interface HdrPanel {
    readonly hdr10: boolean;
    readonly hlg: boolean;
    readonly dolbyVision: boolean;
}

/** Effective `player.hdr_enabled`. Apple's default is on. Dolby Vision is not read. */
export interface HdrPreference {
    readonly hdrEnabled: boolean;
}

export interface HdrReport {
    readonly panel: HdrPanel;
    readonly preference: HdrPreference;
}

const NO_HDR: HdrPanel = { hdr10: false, hlg: false, dolbyVision: false };

function field(value: unknown, key: string): unknown {
    return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

/**
 * `webapis.avinfo.isHdrTvSupport()` (AvInfo API, since 2.3). True means the TV supports HDR.
 * A missing object, a non-boolean, or a throw is SDR. The method lists no privilege.
 *
 * The call is one boolean and does not name a format. Product info, AVPlay stream properties,
 * AVPlay track info and both system-info APIs do not either, and the year video specifications
 * do not list HDR10+ or HLG for every model on Tizen 8.0 or later. A true result reports HDR10
 * only. HLG stays false. Dolby Vision stays false. See docs/settings.md.
 */
export function probeHdrPanel(scope: unknown = globalThis): HdrPanel {
    try {
        const avinfo = field(field(scope, "webapis"), "avinfo");
        const read = field(avinfo, "isHdrTvSupport");
        if (typeof read !== "function") return NO_HDR;
        const supported: unknown = read.call(avinfo);
        return supported === true ? { hdr10: true, hlg: false, dolbyVision: false } : NO_HDR;
    } catch {
        return NO_HDR;
    }
}

/**
 * ApplePlaybackV3Capabilities.swift:439-483. The wire object is hdr10, hdr10_plus, hlg and
 * dolby_vision_profiles. HDR10 and HLG need the HDR setting and a panel report, as Apple fills
 * them (lines 440-441). The probe reports HDR10 only, so HLG stays unclaimed. hdr10_plus stays
 * false: nothing reports HDR10+. Apple hardcodes hdr10Plus false (lines 479-480).
 * dolby_vision_profiles stays empty. Apple sends [5, 8] when Dolby Vision is on (line 482); this
 * client claims no profile. No claim omits hdr_details.
 */
export function hdrDetails(report: HdrReport): HdrDetails | undefined {
    const hdr10 = report.preference.hdrEnabled && report.panel.hdr10;
    const hlg = report.preference.hdrEnabled && report.panel.hlg;
    if (!hdr10 && !hlg) return undefined;
    return { hdr10, hdr10_plus: false, hlg, dolby_vision_profiles: [] };
}

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

function delivery(containers: readonly string[], features: readonly string[], hdr?: HdrDetails): DeliveryCapability {
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
        ...(hdr === undefined ? {} : { hdr_details: hdr }),
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

/** The SDR profile when the report claims nothing. Otherwise the same lists, with HDR details on the output and both deliveries. */
export function clientCapabilities(report?: HdrReport): ClientCapabilities {
    const details = report === undefined ? undefined : hdrDetails(report);
    if (details === undefined) return CLIENT_CAPABILITIES;
    return { ...CLIENT_CAPABILITIES, hdr: true, hdr_details: details };
}

export function playbackContext(model: string, appVersion: string, report?: HdrReport, originalEmbeddedText = true): ClientPlaybackContext {
    const details = report === undefined ? undefined : hdrDetails(report);
    const original = delivery(["mp4", "m4v", "mkv", "matroska"], [], details);
    const context: ClientPlaybackContext = {
        protocol_version: 3,
        form_factor: "tv",
        app_version: appVersion,
        device: { platform: "tizen", manufacturer: "Samsung", model },
        output: {},
        deliveries: {
            original_http: { ...original, subtitles: { ...original.subtitles, embedded_text: originalEmbeddedText } },
            // MPEG-TS segments for copy remuxes, as AVPlay HLS plays them.
            hls: delivery(["m3u8", "hls"], ["hls_copy_mpegts_v1"], details),
        },
    };
    if (details === undefined) return context;
    return { ...context, output: { hdr_details: details } };
}
