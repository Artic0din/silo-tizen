// Decoders for the Silo /api/v2 browse members this client consumes: user libraries, the hidden
// libraries setting, Home sections, catalog pages, item detail, seasons and episodes.
// Handwritten from openapi.json at the commit in ./SOURCE; not generated. Unknown members are
// ignored and unknown item or library types decode to "unknown", so additive changes keep working.

import { boolean, integer, nonEmptyString, object, optionalString, string, WireError } from "./wire.ts";
import { decodeDetailExtras, type DetailExtras } from "./details.ts";
import { decodeAudioTracks, type AudioTrackInfo } from "./playback.ts";
import { decodeCatalogSubtitles, decodeSubtitlePreferences, type CatalogSubtitleTrack, type SubtitlePreferences } from "./preplaySubtitles.ts";

type WireObject = ReturnType<typeof object>;

function array(obj: WireObject, key: string, path: string): unknown[] {
    const value = obj[key];
    if (!Array.isArray(value)) {
        throw new WireError(`${path}.${key}`, "an array");
    }
    return value;
}

function optionalInteger(obj: WireObject, key: string, path: string): number | undefined {
    return obj[key] === undefined ? undefined : integer(obj, key, path);
}

function optionalNumber(obj: WireObject, key: string, path: string): number | undefined {
    const value = obj[key];
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new WireError(`${path}.${key}`, "a number");
    }
    return value;
}

function stringArray(obj: WireObject, key: string, path: string): string[] {
    return array(obj, key, path).map((value, index) => {
        if (typeof value !== "string") {
            throw new WireError(`${path}.${key}[${index}]`, "a string");
        }
        return value;
    });
}

function items<T>(value: unknown, path: string, decode: (entry: unknown, path: string) => T): T[] {
    const obj = object(value, path);
    return array(obj, "items", path).map((entry, index) => decode(entry, `${path}.items[${index}]`));
}

function oneOf<T extends string>(raw: string, known: readonly T[]): T | "unknown" {
    for (const value of known) {
        if (value === raw) {
            return value;
        }
    }
    return "unknown";
}

// --- listUserLibraries ---

const LIBRARY_TYPES = ["movies", "series", "mixed", "music"] as const;

export interface UserLibrary {
    readonly id: string;
    readonly name: string;
    /** Browsable library kinds; books and anything new are "unknown". */
    readonly type: (typeof LIBRARY_TYPES)[number] | "unknown";
    readonly sortOrder: number;
}

export function decodeUserLibraries(value: unknown): UserLibrary[] {
    return items(value, "user_libraries", (entry, path) => {
        const obj = object(entry, path);
        return {
            id: string(obj, "id", path),
            name: string(obj, "name", path),
            type: oneOf(string(obj, "type", path), LIBRARY_TYPES),
            sortOrder: integer(obj, "sort_order", path),
        };
    });
}

// --- listEffectiveSettings: ui.disabled_library_ids ---

export const HIDDEN_LIBRARIES_KEY = "ui.disabled_library_ids";

/** The libraries the profile hid from its own browsing (library-id-list.json: integers ≥ 1). */
export function decodeHiddenLibraries(value: unknown): string[] {
    const path = "effective_settings";
    const setting = items(value, path, (entry, itemPath) => object(entry, itemPath)).find(
        (entry) => entry.key === HIDDEN_LIBRARIES_KEY,
    );
    const ids = setting?.value;
    if (ids === undefined || ids === null) {
        return [];
    }
    if (!Array.isArray(ids)) {
        throw new WireError(`${path}.value`, "an array of library ids");
    }
    return ids.map((id: unknown, index: number) => {
        if (typeof id !== "number" || !Number.isInteger(id)) {
            throw new WireError(`${path}.value[${index}]`, "an integer");
        }
        // UserLibrary.id carries the same integer as an opaque string.
        return String(id);
    });
}

// --- Catalog cards (CatalogItem): listHomeSections, listCatalogItems ---

const CARD_TYPES = ["movie", "series", "season", "episode"] as const;

export type CardType = (typeof CARD_TYPES)[number] | "unknown";

export interface Card {
    readonly backdropUrl?: string | undefined;
    readonly backdropThumbhash?: string | undefined;
    readonly overview?: string | undefined;
    readonly runtimeMinutes?: number | undefined;
    readonly durationSeconds?: number | undefined;
    readonly positionSeconds?: number | undefined;
    /** When the viewer's progress last changed; a new value may mean a newly chosen file. */
    readonly progressUpdatedAt?: string | undefined;
    /** On an episode card: the series backdrop, never the episode still. */
    readonly seriesBackdropUrl?: string | undefined;
    readonly contentRating?: string | undefined;
    readonly genres?: readonly string[] | undefined;
    /** Technical badges of the best file (`overlay_summary`). */
    readonly overlay?: CardOverlay | undefined;
    /** `user_state.played`; absent without a profile. */
    readonly played?: boolean | undefined;
    /** Title logo art (`logo_url`); shown only where the profile's title-art setting allows. */
    readonly logoUrl?: string | undefined;
    /** Fields the card overlay badges and the marquee rating read. */
    readonly ratingImdb?: number | undefined;
    readonly ratingTmdb?: number | undefined;
    readonly ratingRtCritic?: number | undefined;
    readonly ratingRtAudience?: number | undefined;
    readonly advisoryAge?: number | undefined;
    readonly originalLanguage?: string | undefined;
    readonly studios?: readonly string[] | undefined;
    readonly networks?: readonly string[] | undefined;
    readonly showStatus?: string | undefined;
    readonly id: string;
    readonly type: CardType;
    readonly title: string;
    readonly year: number | undefined;
    /** uri-reference: presigned or signed, short-lived; never needs a bearer. */
    readonly posterUrl: string | undefined;
    readonly seriesId: string | undefined;
    readonly seriesTitle: string | undefined;
    readonly seasonNumber: number | undefined;
    readonly episodeNumber: number | undefined;
}

export interface CardOverlay {
    readonly resolution: string | undefined;
    readonly hdr: string | undefined;
    readonly audio: string | undefined;
    readonly audioChannels?: string | undefined;
    readonly videoCodec?: string | undefined;
    readonly container?: string | undefined;
    readonly aspectRatio?: string | undefined;
    readonly releaseType?: string | undefined;
    readonly edition?: string | undefined;
    readonly multiAudio?: boolean | undefined;
    readonly multiSub?: boolean | undefined;
}

function optionalBoolean(obj: WireObject, key: string, path: string): boolean | undefined {
    return obj[key] === undefined ? undefined : boolean(obj, key, path);
}

function decodeCardOverlay(value: unknown, path: string): CardOverlay | undefined {
    if (value === undefined) return undefined;
    const obj = object(value, path);
    const text = (key: string): string | undefined => optionalString(obj, key, path);
    return {
        resolution: text("resolution"), hdr: text("hdr"), audio: text("audio"), audioChannels: text("audio_channels"), videoCodec: text("video_codec"),
        container: text("container"), aspectRatio: text("aspect_ratio"), releaseType: text("release_type"), edition: text("edition"),
        multiAudio: optionalBoolean(obj, "multi_audio", path), multiSub: optionalBoolean(obj, "multi_sub", path),
    };
}

export function decodeCard(value: unknown, path: string): Card {
    const obj = object(value, path);
    return {
        seriesBackdropUrl: optionalString(obj, "series_backdrop_url", path),
        contentRating: optionalString(obj, "content_rating", path),
        genres: obj.genres === undefined ? undefined : stringArray(obj, "genres", path),
        overlay: decodeCardOverlay(obj.overlay_summary, `${path}.overlay_summary`),
        played: obj.user_state === undefined ? undefined : boolean(object(obj.user_state, `${path}.user_state`), "played", `${path}.user_state`),
        logoUrl: optionalString(obj, "logo_url", path),
        ratingImdb: optionalNumber(obj, "rating_imdb", path),
        ratingTmdb: optionalNumber(obj, "rating_tmdb", path),
        ratingRtCritic: optionalInteger(obj, "rating_rt_critic", path),
        ratingRtAudience: optionalInteger(obj, "rating_rt_audience", path),
        advisoryAge: optionalInteger(obj, "advisory_age", path),
        originalLanguage: optionalString(obj, "original_language", path),
        studios: obj.studios === undefined ? undefined : stringArray(obj, "studios", path),
        networks: obj.networks === undefined ? undefined : stringArray(obj, "networks", path),
        showStatus: optionalString(obj, "show_status", path),
        backdropUrl: optionalString(obj, "backdrop_url", path),
        backdropThumbhash: optionalString(obj, "backdrop_thumbhash", path),
        overview: optionalString(obj, "overview", path),
        runtimeMinutes: optionalInteger(obj, "runtime", path),
        durationSeconds: optionalNumber(obj, "duration_seconds", path),
        positionSeconds: optionalNumber(obj, "position_seconds", path),
        progressUpdatedAt: optionalString(obj, "progress_updated_at", path),
        id: string(obj, "content_id", path),
        type: oneOf(string(obj, "type", path), CARD_TYPES),
        title: string(obj, "title", path),
        year: optionalInteger(obj, "year", path),
        posterUrl: optionalString(obj, "poster_url", path),
        seriesId: optionalString(obj, "series_id", path),
        seriesTitle: optionalString(obj, "series_title", path),
        seasonNumber: optionalInteger(obj, "season_number", path),
        episodeNumber: optionalInteger(obj, "episode_number", path),
    };
}

/** getHomeCapabilities: whether Home section reads accept `item_limit`. */
export interface HomeCapabilities {
    readonly state: string;
    /** Advertised maximum. Absent when the server does not offer the parameter. */
    readonly sectionItemLimitMax: number | undefined;
}

export function decodeHomeCapabilities(value: unknown): HomeCapabilities {
    const path = "home_capabilities";
    const obj = object(value, path);
    const max = obj.section_item_limit_max === undefined ? undefined : integer(obj, "section_item_limit_max", path);
    if (max !== undefined && max < 1) throw new WireError(`${path}.section_item_limit_max`, "a positive integer");
    return { state: string(obj, "state", path), sectionItemLimitMax: max };
}

export interface HomeSection {
    readonly featured?: boolean;
    readonly id: string;
    readonly sectionType: string;
    readonly title: string;
    readonly items: readonly Card[];
}

export function decodeHomeSections(value: unknown): HomeSection[] {
    const path = "home_sections";
    const obj = object(value, path);
    return array(obj, "sections", path).map((entry, index) => {
        const sectionPath = `${path}.sections[${index}]`;
        const section = object(entry, sectionPath);
        return {
            featured: section.featured === undefined ? false : boolean(section, "featured", sectionPath),
            id: string(section, "id", sectionPath),
            sectionType: string(section, "section_type", sectionPath),
            title: string(section, "title", sectionPath),
            items: array(section, "items", sectionPath).map((card, cardIndex) => decodeCard(card, `${sectionPath}.items[${cardIndex}]`)),
        };
    });
}

export interface CatalogPage {
    readonly items: readonly Card[];
    /** Absent on the last page. */
    readonly nextCursor: string | undefined;
    /** Items in the whole result; an estimate unless `totalExact`. */
    readonly total: number;
    readonly totalExact: boolean;
}

export function decodeCatalogCollection(value: unknown): { readonly items: readonly Card[] } {
    return { items: items(value, "catalog_collection", decodeCard) };
}

export function decodeCatalogPage(value: unknown): CatalogPage {
    const path = "catalog_page";
    const obj = object(value, path);
    const page = obj.page === undefined ? undefined : object(obj.page, `${path}.page`);
    const hasMore = page === undefined ? false : boolean(page, "has_more", `${path}.page`);
    const nextCursor = page !== undefined && hasMore ? string(page, "next_cursor", `${path}.page`) : undefined;
    if (nextCursor === "") throw new WireError(`${path}.page.next_cursor`, "a nonempty continuation");
    return {
        items: array(obj, "items", path).map((entry, index) => decodeCard(entry, `${path}.items[${index}]`)),
        nextCursor,
        total: integer(obj, "total", path),
        totalExact: boolean(obj, "total_exact", path),
    };
}

// --- getCatalogItem ---

export interface PlayableFile {
    readonly detailLabel?: string;
    readonly effectiveAudioTrackIndex?: number | undefined;
    readonly subtitles?: readonly CatalogSubtitleTrack[];
    readonly effectiveSubtitle?: SubtitlePreferences;
    readonly audio?: readonly AudioTrackInfo[];
    /** Metadata omitted from labels must still invalidate an ordinal picked from an older inventory. */
    readonly audioMetadata?: string;
    readonly label?: string;
    readonly fileId: string;
    /** Seconds; 0 when the server does not know. */
    readonly durationSeconds: number;
}

export interface WatchState {
    readonly played: boolean;
    readonly positionSeconds: number | undefined;
    readonly lastFileId: string | undefined;
}

export interface ItemDetail {
    readonly airDate?: string | undefined;
    readonly extras?: readonly LocalExtra[];
    readonly played: boolean | undefined;
    readonly extra?: DetailExtras;
    readonly id: string;
    readonly type: CardType;
    readonly title: string;
    readonly overview: string | undefined;
    readonly tagline: string | undefined;
    readonly year: number | undefined;
    readonly runtimeMinutes: number | undefined;
    readonly contentRating: string | undefined;
    readonly genres: readonly string[];
    readonly posterUrl: string | undefined;
    readonly backdropUrl: string | undefined;
    readonly durationSeconds: number | undefined;
    readonly seriesId: string | undefined;
    readonly seriesTitle: string | undefined;
    readonly seasonNumber: number | undefined;
    readonly episodeNumber: number | undefined;
    /** Series or season: the episode to play next. */
    readonly playContentId: string | undefined;
    readonly versions: readonly PlayableFile[];
    readonly watch: WatchState | undefined;
}

export interface LocalExtra {
    readonly contentId: string;
    readonly fileId: string | undefined;
    readonly kind: string;
    readonly title: string | undefined;
    readonly durationSeconds: number | undefined;
    readonly stillUrl: string | undefined;
}

function decodeExtras(obj: WireObject): LocalExtra[] {
    if (obj.extras === undefined) return [];
    return array(obj, "extras", "item_detail").map((entry, index) => {
        const path = `item_detail.extras[${index}]`, extra = object(entry, path);
        const fileId = optionalInteger(extra, "file_id", path);
        if (fileId !== undefined && (!Number.isSafeInteger(fileId) || fileId <= 0)) throw new WireError(`${path}.file_id`, "a positive safe integer");
        return { contentId: nonEmptyString(extra, "content_id", path), fileId: fileId === undefined ? undefined : String(fileId), kind: string(extra, "kind", path), title: optionalString(extra, "title", path), durationSeconds: optionalInteger(extra, "duration_seconds", path), stillUrl: optionalString(extra, "still_url", path) };
    });
}

function decodeWatch(value: unknown, path: string): WatchState | undefined {
    if (value === undefined) {
        return undefined;
    }
    const obj = object(value, path);
    return {
        played: boolean(obj, "played", path),
        positionSeconds: optionalNumber(obj, "position_seconds", path),
        lastFileId: optionalString(obj, "last_file_id", path),
    };
}

export function decodeItemDetail(value: unknown): ItemDetail {
    const path = "item_detail";
    const obj = object(value, path);
    const watch = decodeWatch(obj.user_data, `${path}.user_data`);
    return {
        played: obj.user_state === undefined ? watch?.played : boolean(object(obj.user_state, `${path}.user_state`), "played", `${path}.user_state`),
        extra: decodeDetailExtras(value),
        extras: decodeExtras(obj),
        airDate: optionalString(obj, "air_date", path),
        id: string(obj, "content_id", path),
        type: oneOf(string(obj, "type", path), CARD_TYPES),
        title: string(obj, "title", path),
        overview: optionalString(obj, "overview", path),
        tagline: optionalString(obj, "tagline", path),
        year: optionalInteger(obj, "year", path),
        runtimeMinutes: optionalInteger(obj, "runtime", path),
        contentRating: optionalString(obj, "content_rating", path),
        genres: stringArray(obj, "genres", path),
        posterUrl: optionalString(obj, "poster_url", path),
        backdropUrl: optionalString(obj, "backdrop_url", path),
        durationSeconds: optionalNumber(obj, "duration_seconds", path),
        seriesId: optionalString(obj, "series_id", path),
        seriesTitle: optionalString(obj, "series_title", path),
        seasonNumber: optionalInteger(obj, "season_number", path),
        episodeNumber: optionalInteger(obj, "episode_number", path),
        playContentId: optionalString(obj, "play_content_id", path),
        versions: array(obj, "versions", path).map((entry, index) => {
            const versionPath = `${path}.versions[${index}]`;
            const version = object(entry, versionPath);
            const codec = optionalString(version, "codec_video", versionPath)?.toLowerCase();
            const normalizedCodec = codec === undefined ? undefined : /hevc|h265/.test(codec) ? "HEVC" : /avc|h264/.test(codec) ? "H.264" : codec.toUpperCase();
            const size = optionalInteger(version, "file_size", versionPath);
            const sizeLabel = size === undefined ? undefined : size >= 1_000_000_000 ? `${Number((size / 1_000_000_000).toFixed(2))} GB` : `${Number((size / 1_000_000).toFixed(1))} MB`;
            const detailLabel = [normalizedCodec, optionalString(version, "container", versionPath)?.toUpperCase(), sizeLabel].filter(Boolean).join(" · ");
            const label = [optionalString(version, "edition_raw", versionPath), optionalString(version, "resolution", versionPath), optionalString(version, "codec_video", versionPath), version.hdr === undefined ? undefined : boolean(version, "hdr", versionPath) ? "HDR" : undefined, optionalString(version, "codec_audio", versionPath)].filter((part) => part !== undefined && part !== "").join(" · ");
            return { detailLabel, ...(obj.effective_subtitle_mode === undefined && obj.effective_subtitle_track_signature === undefined ? {} : { effectiveSubtitle: decodeSubtitlePreferences(obj, string(obj, "content_id", path), string(version, "file_id", versionPath), undefined) }), fileId: string(version, "file_id", versionPath), effectiveAudioTrackIndex: optionalInteger(version, "effective_audio_track_index", versionPath), durationSeconds: integer(version, "duration", versionPath), audio: decodeAudioTracks(version, versionPath), ...(version.subtitle_tracks === undefined ? {} : { subtitles: decodeCatalogSubtitles(version, versionPath) }), ...(version.audio_tracks === undefined ? {} : { audioMetadata: JSON.stringify(version.audio_tracks) }), ...(label === "" ? {} : { label }) };
        }),
        watch,
    };
}

/** A fresh watch answer must name the captured item and file before it can replace cached progress. */
export function decodeResumePosition(value: unknown, contentId: string, fileId: string): { position: number | undefined; duration: number } {
    const path = "watch";
    const obj = object(value, path);
    if (string(obj, "content_id", path) !== contentId || !["movie", "episode"].includes(string(obj, "type", path))) throw new WireError(path, "the requested movie or episode");
    const versions = array(obj, "versions", path).map((entry) => object(entry, `${path}.versions`));
    const file = versions.find((entry) => string(entry, "file_id", `${path}.versions`) === fileId);
    if (file === undefined) throw new WireError(`${path}.versions`, "the requested file");
    const watch = decodeWatch(obj.user_data, `${path}.user_data`);
    const position = watch?.positionSeconds;
    const duration = integer(file, "duration_seconds", `${path}.versions`);
    if ((position !== undefined && (position < 0 || position > 31536000)) || duration < 0) throw new WireError(path, "nonnegative source seconds");
    return { position, duration };
}

// --- listSeriesSeasons ---

export interface Season {
    readonly userData?: { readonly played: boolean; readonly watchedCount: number; readonly inProgressCount: number };
    readonly isSpecials?: boolean;
    readonly id: string;
    readonly seasonNumber: number;
    readonly title: string;
    readonly episodeCount: number;
    readonly posterUrl: string | undefined;
}

export function decodeSeasons(value: unknown): Season[] {
    return items(value, "seasons", (entry, path) => {
        const obj = object(entry, path);
        const user = obj.user_data === undefined ? undefined : object(obj.user_data, `${path}.user_data`);
        return {
            ...(user === undefined ? {} : { userData: { played: user.played === undefined ? false : boolean(user, "played", path), watchedCount: optionalInteger(user, "watched_count", path) ?? 0, inProgressCount: optionalInteger(user, "in_progress_count", path) ?? 0 } }),
            isSpecials: obj.is_specials === undefined ? false : boolean(obj, "is_specials", path),
            id: string(obj, "content_id", path),
            seasonNumber: integer(obj, "season_number", path),
            title: string(obj, "title", path),
            episodeCount: integer(obj, "episode_count", path),
            posterUrl: optionalString(obj, "poster_url", path),
        };
    });
}

// --- listSeasonEpisodes ---

export interface Episode {
    readonly inProgress?: boolean;
    readonly airDate?: string | undefined;
    readonly overview?: string | undefined;
    readonly ratings?: DetailExtras["ratings"];
    readonly files?: readonly { readonly fileId: string; readonly unreadable: boolean }[];
    readonly id: string;
    readonly seasonNumber: number;
    readonly episodeNumber: number;
    readonly title: string;
    readonly runtimeMinutes: number;
    readonly stillUrl: string | undefined;
    readonly played: boolean;
}

export function decodeEpisodes(value: unknown): Episode[] {
    return items(value, "episodes", (entry, path) => {
        const obj = object(entry, path);
        const user = obj.user_data === undefined ? undefined : object(obj.user_data, `${path}.user_data`);
        const inProgress = user !== undefined && (optionalInteger(user, "in_progress_count", `${path}.user_data`) ?? 0) > 0;
        return {
            ...(inProgress ? { inProgress: true } : {}),
            airDate: optionalString(obj, "air_date", path),
            overview: optionalString(obj, "overview", path),
            ratings: decodeDetailExtras(obj).ratings,
            files: (obj.files === undefined ? [] : array(obj, "files", path)).map((entry, index) => {
                const filePath = `${path}.files[${index}]`;
                const file = object(entry, filePath);
                return { fileId: nonEmptyString(file, "file_id", filePath), unreadable: file.unreadable === undefined ? false : boolean(file, "unreadable", filePath) };
            }),
            id: string(obj, "content_id", path),
            seasonNumber: integer(obj, "season_number", path),
            episodeNumber: integer(obj, "episode_number", path),
            title: string(obj, "title", path),
            runtimeMinutes: integer(obj, "runtime", path),
            stillUrl: optionalString(obj, "still_url", path),
            played: decodeWatch(obj.user_data, `${path}.user_data`)?.played ?? false,
        };
    });
}

/** The watch endpoint uses seconds, unlike catalog version `duration` and episode runtime. */
export interface WatchDetail {
    readonly id: string;
    readonly type: string;
    readonly title: string;
    readonly seriesId: string | undefined;
    readonly seasonNumber: number | undefined;
    readonly episodeNumber: number | undefined;
    readonly watch: WatchState | undefined;
    readonly versions: readonly {
        readonly fileId: string;
        readonly durationSeconds: number;
        readonly multiEpisodeStart: number | undefined;
        readonly multiEpisodeEnd: number | undefined;
    }[];
}

export function decodeWatchDetail(value: unknown): WatchDetail {
    const path = "watch_detail";
    const obj = object(value, path);
    return {
        id: nonEmptyString(obj, "content_id", path),
        type: string(obj, "type", path),
        title: string(obj, "title", path),
        seriesId: optionalString(obj, "series_id", path),
        seasonNumber: optionalInteger(obj, "season_number", path),
        episodeNumber: optionalInteger(obj, "episode_number", path),
        watch: decodeWatch(obj.user_data, `${path}.user_data`),
        versions: array(obj, "versions", path).map((entry, index) => {
            const versionPath = `${path}.versions[${index}]`;
            const version = object(entry, versionPath);
            const start = optionalInteger(version, "multi_episode_start", versionPath);
            const end = optionalInteger(version, "multi_episode_end", versionPath);
            const duration = integer(version, "duration_seconds", versionPath);
            if ((start === undefined) !== (end === undefined) || (start !== undefined && end !== undefined && (start < 1 || end < start)) || duration < 0) {
                throw new WireError(versionPath, "a nonnegative duration and a complete ordered episode range");
            }
            return { fileId: nonEmptyString(version, "file_id", versionPath), durationSeconds: duration, multiEpisodeStart: start, multiEpisodeEnd: end };
        }),
    };
}

// --- The parts of item detail (CatalogItemDetail) the Home marquee and Continue Watching cards add ---

export interface MarqueeAudioTrack {
    /** Absent on the v2 wire today; Apple matches it first, then the position. */
    readonly index: number | undefined;
    readonly codec: string | undefined;
    readonly channels: number | undefined;
    readonly layout: string | undefined;
    readonly isDefault: boolean | undefined;
}

export interface MarqueeFile {
    readonly fileId: string;
    readonly resolution: string | undefined;
    readonly hdr: boolean | undefined;
    readonly codecVideo: string | undefined;
    readonly codecAudio: string | undefined;
    readonly container: string | undefined;
    readonly effectiveAudioTrackIndex: number | undefined;
    readonly audioTracks: readonly MarqueeAudioTrack[];
    readonly videoTracks: readonly { readonly dolbyVision: string | undefined; readonly videoRange: string | undefined }[];
    readonly subtitleTrackCount: number;
}

export interface MarqueeDetail {
    readonly id: string;
    readonly contentRating?: string | undefined;
    readonly runtimeMinutes?: number | undefined;
    /** Calendar date, `YYYY-MM-DD`. */
    readonly airDate: string | undefined;
    readonly cast: readonly { readonly name: string; readonly order: number | undefined }[];
    /** `user_data.last_file_id`: the file this viewer last played. */
    readonly lastFileId: string | undefined;
    readonly versions: readonly MarqueeFile[];
}

function optionalBooleanField(obj: WireObject, key: string, path: string): boolean | undefined {
    return obj[key] === undefined ? undefined : boolean(obj, key, path);
}

function optionalList(obj: WireObject, key: string, path: string): unknown[] {
    return obj[key] === undefined ? [] : array(obj, key, path);
}

export function decodeMarqueeDetail(value: unknown): MarqueeDetail {
    const path = "item_detail";
    const obj = object(value, path);
    const userData = obj.user_data === undefined ? undefined : object(obj.user_data, `${path}.user_data`);
    return {
        id: string(obj, "content_id", path),
        contentRating: optionalString(obj, "content_rating", path),
        runtimeMinutes: optionalInteger(obj, "runtime", path),
        airDate: optionalString(obj, "air_date", path),
        cast: optionalList(obj, "cast", path).map((entry, index) => {
            const castPath = `${path}.cast[${index}]`;
            const credit = object(entry, castPath);
            return { name: string(credit, "name", castPath), order: optionalInteger(credit, "order", castPath) };
        }),
        lastFileId: userData === undefined ? undefined : optionalString(userData, "last_file_id", `${path}.user_data`),
        versions: optionalList(obj, "versions", path).map((entry, index) => {
            const filePath = `${path}.versions[${index}]`;
            const file = object(entry, filePath);
            return {
                fileId: string(file, "file_id", filePath),
                resolution: optionalString(file, "resolution", filePath),
                hdr: optionalBooleanField(file, "hdr", filePath),
                codecVideo: optionalString(file, "codec_video", filePath),
                codecAudio: optionalString(file, "codec_audio", filePath),
                container: optionalString(file, "container", filePath),
                effectiveAudioTrackIndex: optionalInteger(file, "effective_audio_track_index", filePath),
                audioTracks: optionalList(file, "audio_tracks", filePath).map((track, trackIndex) => {
                    const trackPath = `${filePath}.audio_tracks[${trackIndex}]`;
                    const audio = object(track, trackPath);
                    return { index: optionalInteger(audio, "index", trackPath), codec: optionalString(audio, "codec", trackPath), channels: optionalInteger(audio, "channels", trackPath), layout: optionalString(audio, "layout", trackPath), isDefault: optionalBooleanField(audio, "default", trackPath) };
                }),
                videoTracks: optionalList(file, "video_tracks", filePath).map((track, trackIndex) => {
                    const trackPath = `${filePath}.video_tracks[${trackIndex}]`;
                    const video = object(track, trackPath);
                    return { dolbyVision: optionalString(video, "dolby_vision", trackPath), videoRange: optionalString(video, "video_range", trackPath) };
                }),
                subtitleTrackCount: optionalList(file, "subtitle_tracks", filePath).length,
            };
        }),
    };
}
