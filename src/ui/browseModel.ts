// Decisions the browse screens make about server data, kept free of the DOM so Node can test them.

import type { BrowseScope } from "../api/operations.ts";
import type { Card, ItemDetail, UserLibrary } from "../contracts/v2/catalog.ts";

/** What the player needs to call startPlayback: the item, one file and where to start. */
export interface PlayRequest {
    readonly contentId: string;
    /** startPlayback's file_id. */
    readonly fileId: string;
    readonly title: string;
    readonly audioTrackId?: string;
    readonly allowAlternateVersions?: false;
    /** Source seconds; zero starts over, omission lets the server resume. */
    readonly startSeconds: number | undefined;
}

/** A place a card or row opens. Items open their detail page; seasons open their episode list. */
export type Destination =
    | { readonly kind: "person"; readonly id: string; readonly title: string }
    | { readonly kind: "item"; readonly id: string; readonly title: string; readonly seriesContext?: SeriesContext }
    | { readonly kind: "season"; readonly seriesId: string; readonly seasonNumber: number; readonly title: string; readonly id?: string; readonly episodeId?: string };

export interface SeriesContext {
    readonly seasonNumber: number | undefined;
    readonly episodeId: string | undefined;
}

/** Within this many seconds of the end, a stored position is treated as finished. */
export const RESUME_END_MARGIN_SECONDS = 5;

/** Movies, series, seasons and episodes; other media on Home (books, podcasts, anything new) is left out. */
export function destinationOf(card: Card): Destination | undefined {
    switch (card.type) {
        case "movie":
        case "series":
        case "episode":
            return { kind: "item", id: card.id, title: card.title };
        case "season":
            return card.seriesId === undefined || card.seasonNumber === undefined
                ? undefined
                : { kind: "season", id: card.id, seriesId: card.seriesId, seasonNumber: card.seasonNumber, title: card.title };
        case "unknown":
            return undefined;
    }
}

/**
 * Video libraries in the server's order, without those the profile hid itself. Access limits are
 * the server's: it lists only libraries the profile may see. The hidden list is a preference.
 */
export function visibleLibraries(libraries: readonly UserLibrary[], hiddenIds: readonly string[]): UserLibrary[] {
    return libraries
        .filter((library) => library.type !== "unknown" && hiddenIds.indexOf(library.id) === -1)
        .sort((a, b) => a.sortOrder - b.sortOrder);
}

export function scopeOf(library: UserLibrary): BrowseScope {
    return library.type === "movies" ? "movie" : library.type === "series" ? "series" : "video";
}

/**
 * Artwork URLs are uri-references: signed server routes (often root-relative) or presigned
 * storage URLs. They authorize by their own query, so no credential is ever added. Only HTTPS
 * results are used; anything else shows the placeholder.
 */
export function artworkUrl(reference: string | undefined, baseUrl: string): string | undefined {
    if (reference === undefined || reference === "") {
        return undefined;
    }
    let url: URL;
    try {
        url = new URL(reference, `${baseUrl}/`);
    } catch {
        return undefined;
    }
    return url.protocol === "https:" ? url.href : undefined;
}

export function resumeSeconds(positionSeconds: number | undefined, durationSeconds: number | undefined): number | undefined {
    if (positionSeconds === undefined || positionSeconds <= 0) {
        return undefined;
    }
    if (durationSeconds !== undefined && durationSeconds > 0 && positionSeconds >= durationSeconds - RESUME_END_MARGIN_SECONDS) {
        return undefined;
    }
    return positionSeconds;
}

export interface PlayChoices {
    /** Present when there is a position worth resuming. */
    readonly resume: PlayRequest | undefined;
    readonly fromStart: PlayRequest;
}

/**
 * The version last played when it is still listed, else the first; startPlayback may still
 * switch to another version the profile may play. Undefined when nothing can be played here.
 */
export function playChoices(detail: ItemDetail, selectedFileId?: string): PlayChoices | undefined {
    if (detail.type !== "movie" && detail.type !== "episode") {
        return undefined;
    }
    const lastFileId = detail.watch?.lastFileId;
    const file = selectedFileId === undefined
        ? detail.versions.find((version) => version.fileId === lastFileId) ?? detail.versions[0]
        : detail.versions.find((version) => version.fileId === selectedFileId);
    if (file === undefined) {
        return undefined;
    }
    const duration = file.durationSeconds > 0 ? file.durationSeconds : detail.durationSeconds;
    const base = { contentId: detail.id, fileId: file.fileId, title: detail.title, ...(selectedFileId === undefined ? {} : { allowAlternateVersions: false as const }) };
    const start = resumeSeconds(detail.watch?.positionSeconds, duration);
    return {
        resume: start === undefined ? undefined : { ...base, startSeconds: start },
        fromStart: { ...base, startSeconds: 0 },
    };
}

/** "1:02:05" or "20:00". */
export function clockTime(totalSeconds: number): string {
    const seconds = Math.floor(totalSeconds);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    const pad = (value: number): string => (value < 10 ? `0${value}` : String(value));
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

export function episodeLabel(seasonNumber: number | undefined, episodeNumber: number | undefined): string | undefined {
    if (seasonNumber === undefined || episodeNumber === undefined) {
        return undefined;
    }
    return seasonNumber === 0 ? `Special ${episodeNumber}` : `S${seasonNumber}:E${episodeNumber}`;
}
