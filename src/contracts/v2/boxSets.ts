// Movie box sets (silo-server docs/catalog-api.md, "Movie box sets").
// Handwritten from the server structs; unknown members are ignored.
// Display strings match Silo-Server/silo-apple BoxSetModels.swift at ffa6e51.

import { decodeCard, type Card } from "./catalog.ts";
import { integer, nonEmptyString, object, optionalString, string, WireError } from "./wire.ts";

type WireObject = ReturnType<typeof object>;

function array(obj: WireObject, key: string, path: string): unknown[] {
    const value = obj[key];
    if (!Array.isArray(value)) throw new WireError(`${path}.${key}`, "an array");
    return value;
}

function count(obj: WireObject, key: string, path: string): number {
    const value = integer(obj, key, path);
    if (value < 0) throw new WireError(`${path}.${key}`, "a nonnegative integer");
    return value;
}

function optionalYear(obj: WireObject, key: string, path: string): number | undefined {
    return obj[key] === undefined ? undefined : integer(obj, key, path);
}

/** A movie box set as one viewer sees it in one library. */
export interface CatalogBoxSet {
    readonly id: string;
    readonly libraryId: string;
    readonly title: string;
    readonly overview?: string | undefined;
    readonly posterUrl?: string | undefined;
    readonly posterThumbhash?: string | undefined;
    readonly backdropUrl?: string | undefined;
    readonly backdropThumbhash?: string | undefined;
    readonly movieCount: number;
    readonly playedCount: number;
    readonly firstYear?: number | undefined;
    readonly lastYear?: number | undefined;
}

/** `GET /catalog/box-sets/{id}`: the box set and its visible movies, in release order. */
export interface CatalogBoxSetDetail {
    readonly boxSet: CatalogBoxSet;
    readonly items: readonly Card[];
}

function decodeBoxSet(obj: WireObject, path: string): CatalogBoxSet {
    return {
        id: nonEmptyString(obj, "id", path),
        libraryId: nonEmptyString(obj, "library_id", path),
        title: string(obj, "title", path),
        overview: optionalString(obj, "overview", path),
        posterUrl: optionalString(obj, "poster_url", path),
        posterThumbhash: optionalString(obj, "poster_thumbhash", path),
        backdropUrl: optionalString(obj, "backdrop_url", path),
        backdropThumbhash: optionalString(obj, "backdrop_thumbhash", path),
        movieCount: count(obj, "movie_count", path),
        playedCount: count(obj, "played_count", path),
        firstYear: optionalYear(obj, "first_year", path),
        lastYear: optionalYear(obj, "last_year", path),
    };
}

export function decodeCatalogBoxSetDetail(value: unknown): CatalogBoxSetDetail {
    const path = "catalog_box_set";
    const obj = object(value, path);
    return {
        boxSet: decodeBoxSet(obj, path),
        items: array(obj, "items", path).map((entry, index) => decodeCard(entry, `${path}.items[${index}]`)),
    };
}

/**
 * `GET /catalog/items/{id}/box-set`: the movie page's row, or absent when the
 * title is in no box set the viewer sees. A missing field and JSON null are
 * the same answer.
 */
export function decodeCatalogItemBoxSet(value: unknown): CatalogBoxSetDetail | undefined {
    const path = "catalog_item_box_set";
    const obj = object(value, path);
    if (obj.box_set === undefined || obj.box_set === null) return undefined;
    return decodeCatalogBoxSetDetail(obj.box_set);
}

/** `GET /catalog/box-sets?q=`: best match first. `items` is empty, never null. */
export function decodeCatalogBoxSetList(value: unknown): CatalogBoxSet[] {
    const path = "catalog_box_set_list";
    const obj = object(value, path);
    return array(obj, "items", path).map((entry, index) => {
        const itemPath = `${path}.items[${index}]`;
        return decodeBoxSet(object(entry, itemPath), itemPath);
    });
}

function shownYear(year: number | undefined): number | undefined {
    return year !== undefined && year > 0 ? year : undefined;
}

/** "2001 – 2011", one year when the set spans one, or undefined without years. */
export function boxSetYears(first: number | undefined, last: number | undefined): string | undefined {
    const start = shownYear(first);
    const end = shownYear(last);
    if (start !== undefined && end !== undefined && start !== end) return `${start} – ${end}`;
    const only = start ?? end;
    return only === undefined ? undefined : String(only);
}

export function boxSetFilmCount(count: number): string {
    return `${count} ${count === 1 ? "film" : "films"}`;
}

/** Watched share for the card's progress bar; undefined before the first film. */
export function boxSetWatchedProgress(set: CatalogBoxSet): number | undefined {
    if (set.movieCount <= 0 || set.playedCount <= 0) return undefined;
    return Math.min(1, set.playedCount / set.movieCount);
}

/** A card's second line: watched progress once started, else the years, else the film count. */
export function boxSetCardCaption(set: CatalogBoxSet): string {
    if (set.playedCount > 0) return `${set.playedCount} / ${set.movieCount} watched`;
    return boxSetYears(set.firstYear, set.lastYear) ?? boxSetFilmCount(set.movieCount);
}

export function boxSetAccessibilityLabel(set: CatalogBoxSet): string {
    const parts = [set.title, `Box set of ${boxSetFilmCount(set.movieCount)}`];
    const years = boxSetYears(set.firstYear, set.lastYear);
    if (years !== undefined) parts.push(years);
    if (set.playedCount > 0) parts.push(`${set.playedCount} of ${set.movieCount} watched`);
    return parts.join(", ");
}

/** The movie Play starts: the first unplayed film, or the first once all are played. */
export function boxSetNextMovie(detail: CatalogBoxSetDetail): Card | undefined {
    return detail.items.find(item => item.played !== true) ?? detail.items[0];
}

function boxSetStarted(detail: CatalogBoxSetDetail): boolean {
    return detail.boxSet.playedCount > 0 && detail.boxSet.playedCount < detail.boxSet.movieCount;
}

/** tvOS splits this from the film title. "Continue" once started, otherwise "Play". */
export function boxSetPlayVerb(detail: CatalogBoxSetDetail): "Continue" | "Play" | undefined {
    if (boxSetNextMovie(detail) === undefined) return undefined;
    return boxSetStarted(detail) ? "Continue" : "Play";
}

/** "Continue · <title>" once started, otherwise "Play <title>"; undefined without movies. */
export function boxSetPlayLabel(detail: CatalogBoxSetDetail): string | undefined {
    const next = boxSetNextMovie(detail);
    if (next === undefined) return undefined;
    return boxSetStarted(detail) ? `Continue · ${next.title}` : `Play ${next.title}`;
}

/** Hero facts: film count, year range, and watched progress once started. */
export function boxSetFacts(detail: CatalogBoxSetDetail): string[] {
    const tokens = [boxSetFilmCount(detail.boxSet.movieCount)];
    const years = boxSetYears(detail.boxSet.firstYear, detail.boxSet.lastYear);
    if (years !== undefined) tokens.push(years);
    if (detail.boxSet.playedCount > 0) tokens.push(`${detail.boxSet.playedCount} of ${detail.boxSet.movieCount} watched`);
    return tokens;
}
