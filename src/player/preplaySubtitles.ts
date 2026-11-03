import type { SubtitleIntent, SubtitlePreferences, SubtitleSignature } from "../contracts/v2/preplaySubtitles.ts";
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
