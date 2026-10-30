// Decoders for the Silo /api/v2 browse members this client consumes: user libraries, the hidden
// libraries setting, Home sections, catalog pages, item detail, seasons and episodes.
// Handwritten from openapi.json at the commit in ./SOURCE; not generated. Unknown members are
// ignored and unknown item or library types decode to "unknown", so additive changes keep working.

import { boolean, integer, object, optionalString, string, WireError } from "./wire.ts";
import { decodeDetailExtras, type DetailExtras } from "./details.ts";

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

const LIBRARY_TYPES = ["movies", "series", "mixed"] as const;

export interface UserLibrary {
    readonly id: string;
    readonly name: string;
    /** Only the video kinds this client browses; books, music and anything new are "unknown". */
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
    readonly overview?: string | undefined;
    readonly runtimeMinutes?: number | undefined;
    readonly durationSeconds?: number | undefined;
    readonly positionSeconds?: number | undefined;
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

function decodeCard(value: unknown, path: string): Card {
    const obj = object(value, path);
    return {
        backdropUrl: optionalString(obj, "backdrop_url", path),
        overview: optionalString(obj, "overview", path),
        runtimeMinutes: optionalInteger(obj, "runtime", path),
        durationSeconds: optionalNumber(obj, "duration_seconds", path),
        positionSeconds: optionalNumber(obj, "position_seconds", path),
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

export interface HomeSection {
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

export function decodeCatalogPage(value: unknown): CatalogPage {
    const path = "catalog_page";
    const obj = object(value, path);
    const page = obj.page === undefined ? undefined : object(obj.page, `${path}.page`);
    const hasMore = page === undefined ? false : boolean(page, "has_more", `${path}.page`);
    return {
        items: array(obj, "items", path).map((entry, index) => decodeCard(entry, `${path}.items[${index}]`)),
        nextCursor: page !== undefined && hasMore ? optionalString(page, "next_cursor", `${path}.page`) : undefined,
        total: integer(obj, "total", path),
        totalExact: boolean(obj, "total_exact", path),
    };
}

// --- getCatalogItem ---

export interface PlayableFile {
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
            const label = [optionalString(version, "edition_raw", versionPath), optionalString(version, "resolution", versionPath), optionalString(version, "codec_video", versionPath), version.hdr === undefined ? undefined : boolean(version, "hdr", versionPath) ? "HDR" : undefined, optionalString(version, "codec_audio", versionPath)].filter((part) => part !== undefined && part !== "").join(" · ");
            return { fileId: string(version, "file_id", versionPath), durationSeconds: integer(version, "duration", versionPath), ...(label === "" ? {} : { label }) };
        }),
        watch,
    };
}

// --- listSeriesSeasons ---

export interface Season {
    readonly id: string;
    readonly seasonNumber: number;
    readonly title: string;
    readonly episodeCount: number;
    readonly posterUrl: string | undefined;
}

export function decodeSeasons(value: unknown): Season[] {
    return items(value, "seasons", (entry, path) => {
        const obj = object(entry, path);
        return {
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
        return {
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
