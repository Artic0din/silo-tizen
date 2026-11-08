import type { CatalogSubtitleTrack, SubtitleIntent, SubtitlePreferences, SubtitleSignature } from "../contracts/v2/preplaySubtitles.ts";
import type { SubtitleTrack } from "../contracts/v2/playback.ts";

const normalized = (value: string | undefined): string => value?.trim().toLowerCase() ?? "";
function language(value: string | undefined): string {
    try { const locale = new Intl.Locale((value ?? "").replace(/_/g, "-")); return locale.language === "und" ? "" : locale.toString().toLowerCase(); }
    catch { return ""; }
}

export function matchesSubtitle(track: SubtitleSignature, signature: SubtitleSignature): boolean {
    return track.source === signature.source && language(track.language) === language(signature.language) && normalized(track.codec) === normalized(signature.codec)
        && (!signature.label || normalized(track.label) === normalized(signature.label)) && track.forced === signature.forced && track.hearingImpaired === signature.hearingImpaired;
}

/** Apple Details scoring requires a language or label hit before seeding a saved choice. */
export function preferredCatalogSubtitle(tracks: readonly SubtitleSignature[], signature: SubtitleSignature | undefined): SubtitleSignature | undefined {
    if (signature === undefined) return undefined;
    let best: SubtitleSignature | undefined;
    let bestScore = 0;
    for (const track of tracks) {
        if (track.source === "embedded" && !track.codec?.trim()) continue;
        const wanted = language(signature.language), actual = language(track.language);
        if (wanted && actual && wanted.split("-")[0] !== actual.split("-")[0]) continue;
        const languageHit = Boolean(wanted && actual && wanted.split("-")[0] === actual.split("-")[0]);
        const labelHit = Boolean(signature.label && normalized(track.label).includes(normalized(signature.label)));
        if (!languageHit && !labelHit) continue;
        const score = (languageHit ? 5 : 0) + (labelHit ? 2 : 0) + (signature.forced === track.forced ? 1 : 0)
            + (signature.hearingImpaired === track.hearingImpaired ? 1 : 0) + (signature.codec !== undefined && track.codec !== undefined && normalized(signature.codec) === normalized(track.codec) ? 1 : 0);
        if (score > bestScore) { best = track; bestScore = score; }
    }
    return best;
}

function preferred(tracks: readonly SubtitleTrack[], wanted: string | undefined, signature?: SubtitleSignature): SubtitleTrack | undefined {
    const tag = language(wanted);
    if (!tag) return undefined;
    const rank = (track: SubtitleTrack): number => {
        const candidate = language(track.language);
        if (!candidate || candidate.split("-")[0] !== tag.split("-")[0]) return Infinity;
        const languageRank = candidate === tag ? 0 : candidate.includes("-") ? 2 : 1;
        const priority = (track.delivery === "burn_in_only" ? 32 : 0) + (track.forced ? 16 : 0) + (track.hearingImpaired ? 8 : 0) + (track.source === "embedded" ? 0 : track.source === "external" ? 1 : 2);
        const likeness = signature === undefined ? 0 : (track.source === signature.source ? 4 : 0) + (track.forced === signature.forced ? 2 : 0) + (track.hearingImpaired === signature.hearingImpaired ? 2 : 0) + (normalized(track.codec) === normalized(signature.codec) ? 1 : 0) + (normalized(track.label) === normalized(signature.label) ? 1 : 0);
        return languageRank * 10000 - likeness * 100 + priority;
    };
    return tracks.filter(track => Number.isFinite(rank(track))).slice().sort((left, right) => rank(left) - rank(right))[0];
}

/**
 * Names a subtitle before start, the way Apple does once the version's rows are known.
 * External rows come first, then embedded, then downloaded. The plan inventory remains
 * authoritative: a guess that the plan does not echo is corrected by the existing replan.
 */
export function startSubtitleTrackId(fileId: string, intent: SubtitleIntent | undefined, tracks: readonly CatalogSubtitleTrack[] | undefined, preferences?: SubtitlePreferences): string | undefined {
    if (intent === undefined || intent.kind === "off" || tracks === undefined || tracks.length === 0) return undefined;
    // Catalog preferences decode with no audio id, so audioLanguage arrives blank.
    // Auto would then pick a full subtitle the matching audio does not need.
    if (intent.kind === "auto" && (preferences === undefined || preferences.audioLanguage === undefined || preferences.audioLanguage.trim() === "")) return undefined;
    try {
        return initialSubtitle(intent, provisionalInventory(fileId, tracks), preferences);
    } catch {
        return undefined;
    }
}

/** Combined ordinals before a plan exists. Catalog array order is kept inside each source. */
function provisionalInventory(fileId: string, tracks: readonly CatalogSubtitleTrack[]): readonly SubtitleTrack[] {
    const ordered = [
        ...tracks.filter(track => track.source === "external"),
        ...tracks.filter(track => track.source !== "external" && track.source !== "downloaded"),
        ...tracks.filter(track => track.source === "downloaded"),
    ];
    return ordered.map((track, index): SubtitleTrack => ({
        trackId: `file:${fileId}:subtitle:${index}`,
        combinedIndex: index,
        source: track.source,
        delivery: "unknown",
        label: track.label,
        language: track.language,
        codec: track.codec,
        forced: track.forced,
        hearingImpaired: track.hearingImpaired,
        url: undefined,
        streamIndex: undefined,
        containerTrackId: undefined,
        nativeSelectable: undefined,
        hlsRendition: undefined,
    }));
}

/** Only identities published by this plan may leave this resolver. */
export function initialSubtitle(intent: SubtitleIntent, inventory: readonly SubtitleTrack[], preferences?: SubtitlePreferences): string | undefined {
    if (intent.kind === "off") return undefined;
    if (intent.kind === "track") {
        const matches = inventory.filter(track => matchesSubtitle(track, intent.signature));
        if (matches.length !== 1) throw new Error("Selected subtitles are no longer uniquely available.");
        return matches[0]?.trackId;
    }
    if (preferences === undefined) throw new Error("Subtitle preferences are unavailable.");
    const forced = (): string | undefined => preferences.showForced ? preferred(inventory.filter(track => track.forced), preferences.audioLanguage)?.trackId : undefined;
    if (preferences.mode === "off") return forced();
    if (preferences.mode === "always") {
        const signature = preferences.signature;
        const exact = signature === undefined ? [] : inventory.filter(track => matchesSubtitle(track, signature));
        return (exact.length === 1 ? exact[0] : preferred(inventory, preferences.language, preferences.signature))?.trackId;
    }
    if (preferences.language === "") return undefined;
    const wanted = language(preferences.language);
    const audio = language(preferences.audioLanguage);
    if (!wanted || (audio && audio.split("-")[0] === wanted.split("-")[0])) return forced();
    return preferred(inventory, preferences.language, preferences.signature)?.trackId;
}
