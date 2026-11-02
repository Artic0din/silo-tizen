// Text the Skyline marquee and Home cards show for a catalog card, from the card's own fields only.
// Ported (AGPL-3.0-or-later) from silo-apple 1a7cceeaf3b2bfc4f889c00487d19b2c6f843940:
// iosApp/iosApp/Components/MediaTextFormatting.swift, Components/EpisodeCardCaption.swift and
// tvOS/Components/TVFocusMarquee.swift (TVMarqueeContent) and Components/Ratings/DisplayRating.swift.

import type { Card, CardOverlay } from "../contracts/v2/catalog.ts";

/** "45m", "1h 0m" or "2h 15m"; nothing for a missing or non-positive runtime. */
export function runtimeText(minutes: number | undefined): string | undefined {
    if (minutes === undefined || minutes <= 0) return undefined;
    const hours = Math.floor(minutes / 60);
    return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** The metadata runtime, else the file duration the card carries. */
function lengthText(card: Card): string | undefined {
    const runtime = runtimeText(card.runtimeMinutes);
    if (runtime !== undefined || card.durationSeconds === undefined || card.durationSeconds <= 0) return runtime;
    return runtimeText(Math.round(card.durationSeconds / 60));
}

/** "23m left" for a genuinely started item that is not nearly finished. */
function timeLeftText(position: number | undefined, duration: number | undefined): string | undefined {
    if (position === undefined || duration === undefined || duration <= 0 || position <= 0 || position >= duration || position / duration >= 0.95) return undefined;
    const left = runtimeText(Math.max(Math.ceil((duration - position) / 60), 1));
    return left === undefined ? undefined : `${left} left`;
}

function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

export function resolutionLabel(value: string | undefined): string | undefined {
    const raw = nonEmpty(value);
    if (raw === undefined) return undefined;
    const lowered = raw.toLowerCase();
    if (["2160p", "4k", "uhd"].includes(lowered)) return "4K";
    if (["4320p", "8k"].includes(lowered)) return "8K";
    return /^[0-9]+p$/.test(lowered) ? lowered : raw.toUpperCase();
}

/** Resolution, dynamic range and audio chips (`4K · DOLBY VISION · ATMOS`). */
export function marqueeBadges(overlay: CardOverlay | undefined): string[] {
    if (overlay === undefined) return [];
    const badges: string[] = [];
    const resolution = resolutionLabel(overlay.resolution);
    if (resolution !== undefined) badges.push(resolution);
    const hdr = nonEmpty(overlay.hdr);
    if (hdr !== undefined) badges.push(/dv|dolby/i.test(hdr) ? "DOLBY VISION" : hdr.toUpperCase());
    const audio = nonEmpty(overlay.audio);
    if (audio !== undefined) badges.push(/atmos/i.test(audio) ? "ATMOS" : audio.toUpperCase());
    return badges;
}

function episodeToken(season: number | undefined, episode: number | undefined): string | undefined {
    if (season !== undefined && episode !== undefined) return `S${season} E${episode}`;
    if (season !== undefined) return `Season ${season}`;
    return episode === undefined ? undefined : `Episode ${episode}`;
}

/** Episodes headline with their series; the episode moves to the meta line. */
export function marqueeTitle(card: Card): string {
    return card.type === "episode" ? card.seriesTitle ?? card.title : card.title;
}

/** `year · genre · runtime` or `S2 E7 · episode title · 45m`; Continue Watching trails `23m left` after the rating. */
export function marqueeMeta(card: Card, continuing: boolean): { lead: string[]; trailing: string[] } {
    const lead: string[] = [];
    if (card.type === "episode") {
        const token = episodeToken(card.seasonNumber, card.episodeNumber);
        if (token !== undefined) lead.push(token);
        lead.push(card.title);
    } else {
        if (card.year !== undefined && card.year > 0) lead.push(String(card.year));
        const genre = card.genres?.find(value => value !== "");
        if (genre !== undefined) lead.push(genre);
    }
    const length = lengthText(card);
    if (length !== undefined) lead.push(length);
    const left = continuing ? timeLeftText(card.positionSeconds, card.durationSeconds) : undefined;
    return { lead, trailing: left === undefined ? [] : [left] };
}

/** The card's one external rating (IMDb, else TMDB, each out of 10); never for episodes (DisplayRating.primaryCard). */
export function marqueeRating(card: Card): { name: string; display: string } | undefined {
    if (card.type === "episode") return undefined;
    const usable = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0 && value <= 10;
    const [name, value] = usable(card.ratingImdb) ? ["IMDb", card.ratingImdb] : usable(card.ratingTmdb) ? ["TMDB", card.ratingTmdb] : [undefined, undefined];
    return name === undefined || value === undefined ? undefined : { name, display: (Math.round(value * 10) / 10).toFixed(1) };
}

/** The episode's own title, unless it is empty or merely repeats the series name. */
function episodeTitle(card: Card): string | undefined {
    const title = nonEmpty(card.title);
    if (card.type !== "episode" || title === undefined) return undefined;
    const series = nonEmpty(card.seriesTitle);
    return series !== undefined && series.toLowerCase() === title.toLowerCase() ? undefined : title;
}

/** "S01E02 · Pilot", or whichever part exists; nothing for non-episodes. */
function episodeLine(card: Card): string | undefined {
    const code = card.type === "episode" && card.seasonNumber !== undefined && card.episodeNumber !== undefined
        ? `S${String(card.seasonNumber).padStart(2, "0")}E${String(card.episodeNumber).padStart(2, "0")}`
        : undefined;
    const parts = [code, episodeTitle(card)].filter((part): part is string => part !== undefined);
    return parts.length === 0 ? undefined : parts.join(" · ");
}

/** Home card caption: episodes are captioned with their series and an `S01E02 · Pilot` line. */
export function homeCaption(card: Card, continuing: boolean): { title: string; line: string | undefined } {
    const series = nonEmpty(card.seriesTitle);
    const title = card.type === "episode" && series !== undefined ? series : continuing ? card.seriesTitle ?? card.title : card.title;
    const year = card.year === undefined ? undefined : String(card.year);
    const line = episodeLine(card) ?? (continuing && card.seriesTitle !== undefined ? card.title : year);
    return { title, line };
}
