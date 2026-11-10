// Quality labels from silo-apple 2ef3a171:
// SiloQualityPresets.resolutionLabel / normalizeResolution,
// ApplePlaybackQuality.formatBitrate, and SettingsViewModel.qualityFooterText.
// The footer describes the resolution and bitrate Playback already sends.

const CONCRETE_RESOLUTIONS = ["480p", "720p", "1080p", "2160p"];

/** Contract resolution, including older compound spellings, reduced the way Apple does. */
export function normalizeResolution(value: string | null | undefined): string {
    const trimmed = (value ?? "").trim().toLowerCase();
    if (trimmed === "" || trimmed === "auto" || trimmed === "original") return "auto";
    if (trimmed === "4k" || trimmed === "uhd") return "2160p";
    const dash = trimmed.indexOf("-");
    const head = dash === -1 ? trimmed : trimmed.slice(0, dash);
    if (CONCRETE_RESOLUTIONS.includes(head)) return head;
    if (head === "4k") return "2160p";
    return "auto";
}

export function resolutionLabel(value: string | null | undefined): string {
    const normalized = normalizeResolution(value);
    if (normalized === "auto") return "Auto";
    if (normalized === "2160p") return "4K";
    return normalized;
}

/** Maximum Bitrate picker and row. Null and non-positive caps are "No limit". */
export function bitrateLabel(kbps: number | null): string {
    if (kbps === null || kbps <= 0) return "No limit";
    if (kbps >= 1000) {
        const mbps = kbps / 1000;
        if (Math.trunc(mbps) === mbps) return `${mbps} Mbps`;
        return `${mbps.toFixed(1)} Mbps`;
    }
    return `${kbps} kbps`;
}

/** The manifest's label, description and option labels for `playback.buffering_quality_mode` (BufferingQualityMode.swift:26-32, SettingsViewModel.swift:85-87). */
export const BUFFERING_QUALITY_TITLE = "Lower quality when buffering";
export const BUFFERING_QUALITY_DESCRIPTION = "What Silo does on Auto when playback keeps buffering. Silo always asks before lowering a quality you picked.";
export const BUFFERING_QUALITY_MODES = [["never", "Never"], ["ask", "Ask first"], ["always", "Automatically"]] as const;

/** The sentence under Resolution and Maximum Bitrate, plus the buffering description when that row is shown (TVPlaybackSettingsView.swift:106-110). */
export function qualityFooter(resolution: string | null | undefined, bitrateKbps: number | null | undefined, bufferingRow = false): string {
    const normalized = normalizeResolution(resolution);
    let text = normalized === "auto"
        ? "Plays the original file whenever your device and connection can handle it."
        : `Plays the original file up to ${resolutionLabel(normalized)}. Larger files are converted.`;
    if (bitrateKbps !== null && bitrateKbps !== undefined && bitrateKbps > 0) text += " Files above this bitrate are converted to fit.";
    return bufferingRow ? `${text} ${BUFFERING_QUALITY_DESCRIPTION}` : text;
}
