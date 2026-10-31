import { operations } from "../api/operations.ts";
import { ApiError } from "../api/errors.ts";
import type { RequestSpec } from "../api/http.ts";
import type { WatchDetail } from "../contracts/v2/catalog.ts";
import { resumeSeconds } from "../ui/browseModel.ts";
import type { PlayRequest } from "./controller.ts";

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
