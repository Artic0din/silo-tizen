// Which media version Details shows by default, and how versions are named.
// Ported from silo-apple DetailVersionSelection and DetailPlaybackFormatting.
// Apple ranks on resolution only, with the stored resolution cap as the one
// device-side input; HDR, codec, size, edition and name play no part.

import { audioCodec } from "../../player/trackLabels.ts";

export interface RankedVersion {
    readonly fileId: string;
    readonly resolution?: string | undefined;
}

export interface VersionFormat {
    readonly resolution?: string | undefined;
    readonly codecVideo?: string | undefined;
    readonly codecAudio?: string | undefined;
    readonly hdr?: boolean | undefined;
    readonly dolbyVision?: string | undefined;
}

/** Stored quality ids Apple recognises; anything else reads as Auto. */
const CAP_IDS = new Set(["1080p-high", "1080p-medium", "1080p", "1080p-8", "720p-high", "720p-medium", "720p", "480p", "328p"]);
const CAP_BONUS = 100;
const OVER_CAP_PENALTY = 50;
const RANK_WEIGHT = 10;

/** 4 for 2160p or 4K, 3 for 1080p, 2 for 720p, 1 for 480p, otherwise 0. */
function resolutionRank(value: string | undefined): number {
    const text = value?.toLowerCase() ?? "";
    if (text.includes("2160") || text.includes("4k")) return 4;
    if (text.includes("1080")) return 3;
    if (text.includes("720")) return 2;
    if (text.includes("480")) return 1;
    return 0;
}

/** The stored quality as a cap, or undefined when it caps nothing (Auto, 4K and unknown ids). */
function capQuality(stored: string | undefined): string | undefined {
    const lowered = (stored ?? "").trim().toLowerCase();
    const id = lowered === "420p" ? "328p" : lowered;
    return CAP_IDS.has(id) ? id : undefined;
}

function score(version: RankedVersion, cap: string | undefined): number {
    const rank = resolutionRank(version.resolution);
    let total = rank * RANK_WEIGHT;
    if (cap !== undefined) {
        const capRank = resolutionRank(cap);
        if (rank > 0 && rank <= capRank) total += CAP_BONUS;
        else if (rank > capRank) total -= OVER_CAP_PENALTY;
    }
    return total;
}

/**
 * The selected file, else the last-played file, else the highest-scoring one. The first listed
 * file wins a tie, as Swift's max(by:) does.
 */
export function displayVersion<T extends RankedVersion>(versions: readonly T[], selectedFileId: string | undefined, lastFileId: string | undefined, preferredQuality: string | undefined): T | undefined {
    const selected = selectedFileId === undefined ? undefined : versions.find(version => version.fileId === selectedFileId);
    if (selected !== undefined) return selected;
    const last = lastFileId === undefined ? undefined : versions.find(version => version.fileId === lastFileId);
    if (last !== undefined) return last;
    const cap = capQuality(preferredQuality);
    let best: T | undefined;
    let bestScore = 0;
    for (const version of versions) {
        const next = score(version, cap);
        if (best === undefined || next > bestScore) {
            best = version;
            bestScore = next;
        }
    }
    return best;
}

/**
 * The file a next-episode, On Deck or shuffle pick starts (silo-apple `PlaybackSessionBridge.selectVersion`,
 * called with no requested file). The best file at or under the cap wins, then the last-played file, then the
 * best-ranked file. Unlike `displayVersion`, the last-played file never outranks a file that fits the cap.
 */
export function startVersion<T extends RankedVersion>(versions: readonly T[], lastFileId: string | undefined, preferredQuality: string | undefined): T | undefined {
    const cap = capQuality(preferredQuality);
    const capRank = resolutionRank(cap);
    const fitting = cap === undefined ? [] : versions.filter(version => resolutionRank(version.resolution) > 0 && resolutionRank(version.resolution) <= capRank);
    if (fitting.length > 0) return displayVersion(fitting, undefined, undefined, preferredQuality);
    return displayVersion(versions, undefined, lastFileId, preferredQuality);
}

function present(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function videoCodec(codec: string | undefined): string | undefined {
    const lowered = present(codec)?.toLowerCase();
    if (lowered === undefined) return undefined;
    if (/hevc|h265/.test(lowered)) return "HEVC";
    if (lowered.includes("av1")) return "AV1";
    if (/avc|h264/.test(lowered)) return "H.264";
    return lowered.toUpperCase();
}

function dynamicRange(version: VersionFormat): string | undefined {
    if (present(version.dolbyVision) !== undefined) return "DV";
    return version.hdr === true ? "HDR" : undefined;
}

function join(parts: readonly (string | undefined)[]): string {
    return parts.filter(part => part !== undefined).join(" · ");
}

/** "2160p · HEVC · DV · EAC3": the picker's row title. Empty when the file publishes none of these. */
export function versionLabel(version: VersionFormat): string {
    return join([present(version.resolution), videoCodec(version.codecVideo), dynamicRange(version), audioCodec(present(version.codecAudio))]);
}

/** "2160p · HDR": the resting Version summary. */
export function compactVersionLabel(version: VersionFormat): string {
    return join([present(version.resolution), dynamicRange(version)]);
}
