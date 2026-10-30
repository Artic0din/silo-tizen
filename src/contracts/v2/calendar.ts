// getCalendar at silo-server cc8514943289045e7b9f7ac8d36d4968bfe93926.
import { boolean, integer, nonEmptyString, object, optionalString, string, WireError } from "./wire.ts";

export type CalendarFilter = "following" | "trending" | "everything";
export interface CalendarEvent {
    readonly contentId: string;
    readonly type: string;
    readonly title: string;
    readonly episodeTitle: string | undefined;
    readonly seriesId: string | undefined;
    readonly seasonNumber: number | undefined;
    readonly episodeNumber: number | undefined;
    readonly airDate: string;
    readonly localAirDate: string;
    readonly airTime: string | undefined;
    readonly airAt: string | undefined;
    readonly airTimezone: string | undefined;
    readonly posterUrl: string | undefined;
    readonly posterThumbhash: string | undefined;
    readonly watched: boolean;
    readonly badges: readonly string[];
}
export interface CalendarDay { readonly date: string; readonly items: readonly CalendarEvent[] }

export function isDateKey(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8));
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const length = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    return year > 0 && length !== undefined && day >= 1 && day <= length;
}
function date(value: string, path: string): string {
    if (!isDateKey(value)) throw new WireError(path, "a calendar date");
    return value;
}
function array(value: unknown, path: string): unknown[] {
    if (!Array.isArray(value)) throw new WireError(path, "an array");
    return value;
}
function event(value: unknown, path: string, group: string): CalendarEvent {
    const obj = object(value, path);
    const number = (key: string): number | undefined => {
        if (obj[key] === undefined) return undefined;
        const value = integer(obj, key, path);
        if (value < 0) throw new WireError(`${path}.${key}`, "a nonnegative integer");
        return value;
    };
    const localAirDate = date(string(obj, "local_air_date", path), `${path}.local_air_date`);
    if (localAirDate !== group) throw new WireError(`${path}.local_air_date`, "the server group date");
    const airTime = optionalString(obj, "air_time", path), airAt = optionalString(obj, "air_at", path);
    if (airTime !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(airTime)) throw new WireError(`${path}.air_time`, "HH:MM");
    if (airAt !== undefined && (!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(airAt) || !isDateKey(airAt.slice(0, 10)) || !Number.isFinite(Date.parse(airAt)))) throw new WireError(`${path}.air_at`, "an RFC3339 instant");
    return {
        contentId: nonEmptyString(obj, "content_id", path), type: string(obj, "type", path), title: string(obj, "title", path),
        episodeTitle: optionalString(obj, "episode_title", path), seriesId: optionalString(obj, "series_id", path),
        seasonNumber: number("season_number"), episodeNumber: number("episode_number"),
        airDate: date(string(obj, "air_date", path), `${path}.air_date`), localAirDate, airTime, airAt,
        airTimezone: optionalString(obj, "air_timezone", path), posterUrl: optionalString(obj, "poster_url", path),
        posterThumbhash: optionalString(obj, "poster_thumbhash", path), watched: boolean(obj, "watched", path),
        badges: array(obj.badges, `${path}.badges`).map((badge, i) => {
            if (typeof badge !== "string") throw new WireError(`${path}.badges[${i}]`, "a string");
            return badge;
        }),
    };
}
export function decodeCalendar(value: unknown): CalendarDay[] {
    const obj = object(value, "calendar");
    const seen = new Set<string>();
    return array(obj.events, "calendar.events").map((value, i) => {
        const path = `calendar.events[${i}]`, day = object(value, path);
        const key = date(string(day, "date", path), `${path}.date`);
        if (seen.has(key)) throw new WireError(`${path}.date`, "a unique day");
        seen.add(key);
        return { date: key, items: array(day.items, `${path}.items`).map((v, n) => event(v, `${path}.items[${n}]`, key)) };
    });
}
