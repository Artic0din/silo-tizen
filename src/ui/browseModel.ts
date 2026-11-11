// Decisions the browse screens make about server data, kept free of the DOM so Node can test them.

import type { Route } from "./browseRoutes.ts";
import type { BrowseScope, TextSearchScope } from "../api/operations.ts";
import { isPermittedUrl } from "../api/serverUrl.ts";
import type { Card, ItemDetail, PlayableFile, UserLibrary } from "../contracts/v2/catalog.ts";
import type { CatalogSubtitleTrack, SubtitleIntent, SubtitlePreferences } from "../contracts/v2/preplaySubtitles.ts";
import { displayVersion } from "../contracts/v2/versions.ts";

/** What the player needs to call startPlayback: the item, one file and where to start. */
export interface PlayRequest {
    readonly shuffleId?: string;
    readonly episode?: true;
    readonly contentId: string;
    /** startPlayback's file_id. */
    readonly fileId: string;
    readonly title: string;
    /** Episode playback. The series page fills these when the episode item omits them. */
    readonly seriesTitle?: string | undefined;
    readonly seasonNumber?: number | undefined;
    readonly episodeNumber?: number | undefined;
    readonly audioTrackId?: string;
    readonly subtitle?: SubtitleIntent;
    /** Catalog rows used to name a subtitle before start. Absent when the version published none. */
    readonly subtitleTracks?: readonly CatalogSubtitleTrack[];
    /** Effective subtitle preferences already on the version, so Auto can be named before start. */
    readonly subtitlePreferences?: SubtitlePreferences;
    readonly allowAlternateVersions?: false;
    /** Source seconds; zero starts over, omission lets the server resume. */
    readonly startSeconds: number | undefined;
}

export type EpisodeSelection = Partial<Pick<PlayRequest, "fileId" | "audioTrackId" | "subtitle">>;

/** A place a card or row opens. Items open their detail page; seasons open their episode list. */
export type Destination =
    | { readonly kind: "person"; readonly id: string; readonly title: string }
    | { readonly kind: "audiobook"; readonly id: string; readonly title: string }
    | { readonly kind: "item"; readonly id: string; readonly title: string; readonly seriesContext?: SeriesContext; readonly seed?: DetailSeed }
    | { readonly kind: "season"; readonly seriesId: string; readonly seasonNumber: number; readonly title: string; readonly id?: string; readonly episodeId?: string };

/** Apple TVItemDetailRouteSeed: what the opening card already knows, painted in the loading frame. */
export interface DetailSeed {
    readonly type: string;
    readonly title: string;
    readonly year?: number | undefined;
    readonly overview?: string | undefined;
    readonly runtimeMinutes?: number | undefined;
    readonly contentRating?: string | undefined;
    readonly genre?: string | undefined;
    readonly backdropUrl?: string | undefined;
    readonly backdropThumbhash?: string | undefined;
    readonly backdropIsEpisodeStill?: boolean | undefined;
    /** Set only for episode seeds. */
    readonly episodeWatch?: { readonly played: boolean; readonly isInProgress: boolean; readonly positionSeconds?: number };
}

/** TVItemDetailRouteSeed(SectionItem): an episode card shows its series backdrop when it carries one (Apple's episodeSeriesBackdrop). */
export function detailSeed(card: Card): DetailSeed {
    const series = card.type === "episode" && card.seriesBackdropUrl !== undefined && card.seriesBackdropUrl !== "";
    return {
        type: card.type, title: card.title, year: card.year, overview: card.overview, runtimeMinutes: card.runtimeMinutes,
        contentRating: card.contentRating, genre: card.genres?.[0],
        backdropUrl: series ? card.seriesBackdropUrl : card.backdropUrl, backdropThumbhash: series ? undefined : card.backdropThumbhash,
        backdropIsEpisodeStill: series ? false : card.backdropIsEpisodeStill,
        ...(card.type === "episode" ? { episodeWatch: { played: card.played === true, isInProgress: card.played !== true && (card.positionSeconds ?? 0) > 0, ...(card.positionSeconds === undefined ? {} : { positionSeconds: card.positionSeconds }) } } : {}),
    };
}

/** TVItemDetailRouteSeed(parentSeriesFrom:): the series title and backdrop only, never the episode's metadata. */
function parentSeriesSeed(card: Card): DetailSeed {
    const backdrop = card.seriesBackdropUrl !== undefined && card.seriesBackdropUrl !== "" ? card.seriesBackdropUrl : undefined;
    return { type: "series", title: seriesCardTitle(card), backdropUrl: backdrop, ...(backdrop === undefined ? {} : { backdropIsEpisodeStill: false }) };
}

export interface SeriesContext {
    readonly seasonNumber: number | undefined;
    readonly episodeId: string | undefined;
}

/** Within this many seconds of the end, a stored position is treated as finished. */
export const RESUME_END_MARGIN_SECONDS = 5;
/** PlaybackResumePoint.position: a position of 30 s or less plays from the start. */
export const RESUME_MIN_SECONDS = 30;

/** Movies, series, seasons, episodes and audiobooks; other media on Home (podcasts, anything new) is left out. */
export function destinationOf(card: Card): Destination | undefined {
    switch (card.type) {
        case "movie":
        case "series":
        case "episode":
            return { kind: "item", id: card.id, title: card.title, seed: detailSeed(card) };
        case "audiobook":
            return { kind: "audiobook", id: card.id, title: card.title };
        case "season":
            return card.seriesId === undefined || card.seasonNumber === undefined
                ? undefined
                : { kind: "season", id: card.id, seriesId: card.seriesId, seasonNumber: card.seasonNumber, title: card.title };
        case "unknown":
            return undefined;
    }
}

/** A series id that names a different parent, as Apple `SeriesDetailContext.parentID`. */
function parentSeriesId(card: Card): string | undefined {
    const seriesId = card.seriesId?.trim();
    if (seriesId === undefined || seriesId === "" || seriesId === card.id) return undefined;
    return seriesId;
}

function seriesCardTitle(card: Card): string {
    const seriesTitle = card.seriesTitle?.trim();
    return seriesTitle === undefined || seriesTitle === "" ? card.title : seriesTitle;
}

/**
 * Browse Select follows Apple `Route.itemDetail(browseItem:)`.
 * An episode opens its series on that episode. A season opens the series
 * on that season. Movies and series open themselves.
 */
export function browseCardDestination(card: Card): Destination | undefined {
    const seriesId = parentSeriesId(card);
    // Unknown media stays omitted. An episode number on a season still names the parent series.
    if (card.type !== "unknown" && card.type !== "audiobook" && seriesId !== undefined && (card.type === "episode" || card.episodeNumber !== undefined)) {
        return { kind: "item", id: seriesId, title: seriesCardTitle(card), seriesContext: { seasonNumber: card.seasonNumber, episodeId: card.id }, seed: parentSeriesSeed(card) };
    }
    if (card.type === "season" && seriesId !== undefined && card.seasonNumber !== undefined) {
        return { kind: "item", id: seriesId, title: seriesCardTitle(card), seriesContext: { seasonNumber: card.seasonNumber, episodeId: undefined }, seed: parentSeriesSeed(card) };
    }
    return destinationOf(card);
}

/**
 * Libraries in the server's order, without those the profile hid itself. Audiobook libraries are kept; the bar
 * lists them only while Show Audiobooks is on. Access limits are
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

export type SearchFilter = "movie" | "series" | "audiobook";

/**
 * Apple SearchMediaType.queryValue. All names no scope while audiobooks take part. Without them it names a
 * video scope so a hidden audiobook library never leaks into unfiltered results.
 */
export function searchScope(filter: SearchFilter | undefined, audiobooksEnabled: boolean, includesEpisodes: boolean): TextSearchScope | SearchFilter | undefined {
    if (filter !== undefined) return filter;
    if (audiobooksEnabled) return undefined;
    return includesEpisodes ? "video_with_episodes" : "video";
}

/**
 * Artwork URLs are uri-references: signed server routes (often root-relative) or presigned
 * storage URLs. They authorize by their own query, so no credential is ever added. Only HTTPS
 * results, or plain HTTP from a plain-HTTP server, are used; anything else shows the placeholder.
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
    return isPermittedUrl(url, baseUrl) ? url.href : undefined;
}

/** Request paths name TMDB images, not signed Silo routes (Apple RequestImageURL). */
export function requestPosterUrl(path: string | undefined): string | undefined {
    if (path === undefined || path === "") return undefined;
    if (/^https?:\/\//i.test(path)) return path;
    return path.startsWith("/") && !path.startsWith("//") ? `https://image.tmdb.org/t/p/w342${path}` : undefined;
}

export function resumeSeconds(positionSeconds: number | undefined, durationSeconds: number | undefined): number | undefined {
    if (positionSeconds === undefined || positionSeconds <= RESUME_MIN_SECONDS) {
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
 * The selected version, else the last played when it is still listed, else the best by Apple's
 * ranking; startPlayback may still switch to another version the profile may play. A selection
 * that is no longer listed plays nothing. Undefined when nothing can be played here.
 */
export function playChoices(detail: ItemDetail, selectedFileId?: string, preferredQuality?: string): PlayChoices | undefined {
    if (detail.type !== "movie" && detail.type !== "episode") {
        return undefined;
    }
    const lastFileId = detail.watch?.lastFileId;
    const file = selectedFileId === undefined
        ? displayVersion(detail.versions, undefined, lastFileId, preferredQuality)
        : detail.versions.find((version) => version.fileId === selectedFileId);
    if (file === undefined) {
        return undefined;
    }
    const duration = file.durationSeconds > 0 ? file.durationSeconds : detail.durationSeconds;
    const base = {
        contentId: detail.id,
        fileId: file.fileId,
        title: detail.title,
        ...(detail.type === "episode" ? { episode: true as const, seriesTitle: detail.seriesTitle, seasonNumber: detail.seasonNumber, episodeNumber: detail.episodeNumber } : {}),
        ...(selectedFileId === undefined ? {} : { allowAlternateVersions: false as const }),
        ...startTrackHints(file),
    };
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

/**
 * Language of the audio a start will play.
 * An explicit track id wins, then the version's effective index, then its default
 * track, then the first track. Details uses the same order (`browseDetails.ts`).
 * Apple's `startAudioLanguage` (`PlaybackSessionBridge.swift` at 2ef3a171) does too.
 * A blank language is unknown: Auto must not guess a full subtitle from it.
 */
export function startAudioLanguage(file: PlayableFile, audioTrackId?: string): string | undefined {
    const audio = file.audio ?? [];
    const explicit = audioTrackId === undefined ? -1 : audio.findIndex((_track, index) => audioTrackId === `file:${file.fileId}:audio:${index}`);
    const ordinal = explicit >= 0 ? explicit : file.effectiveAudioTrackIndex ?? audio.findIndex(track => track.isDefault);
    const track = audio[ordinal] ?? (explicit >= 0 ? undefined : audio[0]);
    const language = track?.language?.trim();
    return language === undefined || language === "" ? undefined : language;
}

/** Subtitle rows and preferences the version already published. An empty catalog list adds nothing. */
export function startTrackHints(file: PlayableFile | undefined, audioTrackId?: string): Pick<PlayRequest, "subtitleTracks" | "subtitlePreferences"> {
    if (file === undefined) return {};
    const tracks = file.subtitles;
    if (tracks === undefined || tracks.length === 0) return {};
    const preferences = file.effectiveSubtitle;
    if (preferences === undefined) return { subtitleTracks: tracks };
    return { subtitleTracks: tracks, subtitlePreferences: { ...preferences, audioLanguage: startAudioLanguage(file, audioTrackId) } };
}

/** The audio id can arrive after the hints. Auto needs the language of the track that will play. */
export function withStartAudioLanguage(request: PlayRequest, file: PlayableFile | undefined): PlayRequest {
    const hints = startTrackHints(file, request.audioTrackId);
    return hints.subtitlePreferences === undefined ? request : { ...request, ...hints };
}

function named(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * The player footer reads the play request. An episode item can omit the series name and
 * the season and episode numbers that the series page and its rail already show.
 * Apple TV takes the same line from the watch detail (`playerMetadata` at 2ef3a171).
 */
export function seriesPlayback(request: PlayRequest, page: Pick<ItemDetail, "type" | "title" | "seriesTitle">, rail: { readonly seasonNumber?: number; readonly episodeNumber?: number } | undefined): PlayRequest {
    if (request.episode !== true && page.type !== "series" && page.type !== "season") return request;
    const seriesTitle = named(request.seriesTitle) ?? (page.type === "series" ? named(page.title) : named(page.seriesTitle));
    const seasonNumber = request.seasonNumber ?? rail?.seasonNumber;
    const episodeNumber = request.episodeNumber ?? rail?.episodeNumber;
    return {
        ...request,
        episode: true,
        ...(seriesTitle === undefined ? {} : { seriesTitle }),
        ...(seasonNumber === undefined ? {} : { seasonNumber }),
        ...(episodeNumber === undefined ? {} : { episodeNumber }),
    };
}

/** Series name and episode numbers already shown on the page that started playback. */
export interface SeriesLine {
    readonly seriesTitle?: string;
    readonly seasonNumber?: number;
    readonly episodeNumber?: number;
}

/** Fills a footer the episode item left blank. A name or number the item already has stays. */
export function applySeriesLine(request: PlayRequest, line: SeriesLine | undefined): PlayRequest {
    if (line === undefined) return request;
    const seriesTitle = named(line.seriesTitle);
    const page: Pick<ItemDetail, "type" | "title" | "seriesTitle"> = seriesTitle === undefined
        ? { type: "episode", title: request.title, seriesTitle: undefined }
        : { type: "series", title: seriesTitle, seriesTitle: undefined };
    const rail = line.seasonNumber === undefined && line.episodeNumber === undefined ? undefined : line;
    return seriesPlayback(request, page, rail);
}

/** The series page and the episode row already show the line the player footer needs. */
export function seriesLineFor(routes: readonly Route[], current: Route, episodeId: string): SeriesLine | undefined {
    // Only this episode's own series may name it; a series page left on the stack from elsewhere must not.
    const seriesId = current.kind === "season" ? current.seriesId : current.kind === "item" ? (current.data?.detail.type === "series" ? current.id : current.data?.detail.seriesId) : undefined;
    const series = seriesId === undefined ? undefined : [...routes].reverse().find((route): route is Extract<Route, { kind: "item" }> => route.kind === "item" && route.id === seriesId && route.data?.detail.type === "series");
    const seriesTitle = series?.data?.detail.title.trim();
    const episode = current.kind === "item"
        ? current.data?.details?.series?.railEpisodes?.find(item => item.id === episodeId)
        : current.kind === "season" ? current.data?.episodes.find(item => item.id === episodeId) : undefined;
    const seasonNumber = episode?.seasonNumber ?? (current.kind === "season" ? current.seasonNumber : undefined);
    const episodeNumber = episode?.episodeNumber;
    const title = seriesTitle === undefined || seriesTitle === "" ? undefined : seriesTitle;
    if (title === undefined && seasonNumber === undefined && episodeNumber === undefined) return undefined;
    return { ...(title === undefined ? {} : { seriesTitle: title }), ...(seasonNumber === undefined ? {} : { seasonNumber }), ...(episodeNumber === undefined ? {} : { episodeNumber }) };
}

export function episodeLabel(seasonNumber: number | undefined, episodeNumber: number | undefined): string | undefined {
    if (seasonNumber === undefined || episodeNumber === undefined) {
        return undefined;
    }
    return seasonNumber === 0 ? `Special ${episodeNumber}` : `S${seasonNumber}:E${episodeNumber}`;
}
