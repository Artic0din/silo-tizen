import { operations } from "../api/operations.ts";
import { ApiError } from "../api/errors.ts";
import type { RequestSpec } from "../api/http.ts";
import type { WatchDetail } from "../contracts/v2/catalog.ts";
import { resumeSeconds } from "../ui/browseModel.ts";
import type { PlayRequest } from "./controller.ts";

/** Home rows Apple treats as On Deck (`PlayerViewModel.resolveOnDeckItems`). */
const ON_DECK_SECTIONS = new Set(["continue_watching", "in_progress", "next_up"]);

type Read = <T>(spec: RequestSpec<T>) => Promise<T>;

function invalid(): never {
    throw new ApiError({ kind: "invalid_response", path: "next_episode.identity" });
}

function episode(detail: WatchDetail): { series: string; season: number; number: number } {
    const { seriesId, seasonNumber, episodeNumber } = detail;
    if (detail.type !== "episode" || !seriesId || seasonNumber === undefined || seasonNumber < 0 || episodeNumber === undefined || episodeNumber < 1) invalid();
    return { series: seriesId, season: seasonNumber, number: episodeNumber };
}

/** Fresh authorized data only. A failed read is never mistaken for an exhausted season. */
export async function nextEpisode(read: Read, contentId: string, effectiveFileId: string): Promise<PlayRequest | undefined> {
    const current = await read(operations.watchDetail(contentId));
    if (current.id !== contentId) invalid();
    const context = episode(current);
    const file = current.versions.find(version => version.fileId === effectiveFileId);
    if (file === undefined) invalid();
    if (file.multiEpisodeStart !== undefined && (file.multiEpisodeStart > context.number || (file.multiEpisodeEnd ?? 0) < context.number)) invalid();
    const lastCovered = file.multiEpisodeEnd ?? context.number;
    const seasons = await read(operations.listSeriesSeasons(context.series));
    const origin = seasons.find(season => season.seasonNumber === context.season);
    if (origin === undefined || new Set(seasons.map(season => season.seasonNumber)).size !== seasons.length || seasons.some(season => season.seasonNumber < 0)) invalid();
    const specials = origin.isSpecials === true || origin.seasonNumber === 0;
    const ordered = seasons.filter(season => season.seasonNumber === context.season || (!specials && !season.isSpecials && season.seasonNumber > context.season)).sort((a, b) => a.seasonNumber - b.seasonNumber);
    for (const season of ordered) {
        const rows = await read(operations.listSeasonEpisodes(context.series, season.seasonNumber));
        if (rows.some(row => row.seasonNumber !== season.seasonNumber || row.episodeNumber < 1) || new Set(rows.map(row => row.episodeNumber)).size !== rows.length) invalid();
        if (season.seasonNumber === context.season && !rows.some(row => row.id === current.id && row.episodeNumber === context.number)) invalid();
        for (const row of [...rows].sort((a, b) => a.episodeNumber - b.episodeNumber)) {
            if (season.seasonNumber === context.season && row.episodeNumber <= lastCovered) continue;
            const readable = (row.files ?? []).filter(file => !file.unreadable);
            if (readable.length === 0) continue;
            const detail = await read(operations.watchDetail(row.id));
            const next = episode(detail);
            if (detail.id !== row.id || next.series !== context.series || next.season !== season.seasonNumber || next.number !== row.episodeNumber) invalid();
            const allowed = detail.versions.filter(version => readable.some(file => file.fileId === version.fileId));
            const version = allowed.find(version => version.fileId === detail.watch?.lastFileId) ?? allowed[0];
            if (version === undefined) continue;
            const resume = detail.watch?.played === false ? resumeSeconds(detail.watch.positionSeconds, version.durationSeconds || undefined) : undefined;
            return { contentId: detail.id, fileId: version.fileId, title: detail.title, startSeconds: resume ?? 0, episode: true };
        }
    }
    return undefined;
}

/**
 * The first On Deck title when the series has no next episode. It is another
 * title, so it plays only from Play next. A failed read offers nothing.
 */
export async function onDeckPlay(read: Read, contentId: string): Promise<PlayRequest | undefined> {
    return (await onDeckPlays(read, contentId))[0];
}

export async function onDeckPlays(read: Read, contentId: string, publish?: (items: readonly PlayRequest[]) => void): Promise<PlayRequest[]> {
    let seriesId: string | undefined;
    try {
        const current = await read(operations.watchDetail(contentId));
        if (current.id !== contentId) return [];
        seriesId = current.seriesId;
    } catch {
        return [];
    }
    let sections;
    try {
        sections = await read(operations.listHomeSections());
    } catch {
        return [];
    }
    const result: PlayRequest[] = [];
    const seen = new Set<string>();
    for (const section of sections) {
        if (!ON_DECK_SECTIONS.has(section.sectionType)) continue;
        for (const card of section.items) {
            if (card.id === contentId || card.type !== "movie" && card.type !== "episode") continue;
            if (seriesId !== undefined && card.seriesId === seriesId) continue;
            if (seen.has(card.id)) continue;
            seen.add(card.id);
            if (seen.size > 12) return result;
            try {
                const detail = await read(operations.watchDetail(card.id));
                if (detail.id !== card.id || detail.type !== "movie" && detail.type !== "episode") continue;
                const file = detail.versions.find((version) => version.fileId === detail.watch?.lastFileId) ?? detail.versions[0];
                if (file === undefined) continue;
                const start = resumeSeconds(detail.watch?.positionSeconds, file.durationSeconds > 0 ? file.durationSeconds : undefined);
                result.push({
                    contentId: detail.id,
                    fileId: file.fileId,
                    title: detail.title,
                    overview: card.overview,
                    backdropUrl: card.backdropUrl,
                    startSeconds: start ?? 0,
                    ...(detail.type === "episode" ? { episode: true as const } : {}),
                });
                publish?.(result.slice());
            } catch {
                continue;
            }
        }
    }
    return result;
}
