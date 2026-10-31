import type { CalendarDay, CalendarEvent, CalendarFilter } from "../contracts/v2/calendar.ts";
import type { CalendarQuery } from "../api/calendarOperations.ts";
import type { Destination } from "./browseModel.ts";

export interface CalendarState {
    start: string | undefined;
    timezone: string | undefined;
    selectedDay: string | undefined;
    filter: CalendarFilter;
    data: { readonly query: CalendarQuery; readonly days: readonly CalendarDay[] } | undefined;
}
export function calendarState(): CalendarState {
    return { start: undefined, timezone: undefined, selectedDay: undefined, filter: "following", data: undefined };
}
export function localDateKey(date: Date): string {
    return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function dayDate(key: string): Date {
    const date = new Date(0);
    date.setFullYear(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8)));
    date.setHours(12, 0, 0, 0);
    return date;
}
export function shiftDay(key: string, days: number): string {
    const date = dayDate(key);
    date.setDate(date.getDate() + days);
    return localDateKey(date);
}
export function calendarWeek(today: Date): string[] {
    const start = shiftDay(localDateKey(today), -((today.getDay() + 6) % 7));
    return Array.from({ length: 7 }, (_, i) => shiftDay(start, i));
}
export class CalendarTimezoneError extends Error {}
export function deviceTimezone(): string {
    try {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (!zone) throw new Error();
        new Intl.DateTimeFormat("en", { timeZone: zone, weekday: "short", hour: "2-digit" }).format(0);
        return zone;
    } catch { throw new CalendarTimezoneError("Could not read this TV’s timezone. Check its date and time settings, then try again."); }
}
export function calendarDestination(event: CalendarEvent): Destination | undefined {
    if (event.type !== "movie" && event.type !== "episode" && event.type !== "season_premiere") return undefined;
    const series = event.type !== "movie" && event.seriesId?.trim() ? event.seriesId : undefined;
    return { kind: "item", id: series ?? event.contentId, title: event.title,
        ...(series === undefined ? {} : { seriesContext: { seasonNumber: event.seasonNumber, episodeId: event.type === "episode" ? event.contentId : undefined } }) };
}
export function calendarEventKey(event: CalendarEvent): string {
    return JSON.stringify([event.localAirDate, event.type, event.contentId, event.seriesId, event.seasonNumber, event.episodeNumber, event.airAt, event.airTime]);
}
export function calendarEventKeys(events: readonly CalendarEvent[]): string[] {
    const occurrences = new Map<string, number>();
    return events.map(event => {
        const identity = calendarEventKey(event), occurrence = occurrences.get(identity) ?? 0;
        occurrences.set(identity, occurrence + 1);
        return `event:${identity}:${occurrence}`;
    });
}
export function eventTime(event: CalendarEvent, timezone: string): string | undefined {
    if (event.airAt !== undefined) {
        try { return new Intl.DateTimeFormat(undefined, { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(event.airAt)); }
        catch { throw new CalendarTimezoneError("Could not format this TV’s timezone. Try again."); }
    }
    // Without an instant the network wall time is not a viewer-local time.
    return event.airTime === undefined ? undefined : `${event.airTime}${event.airTimezone ? ` (${event.airTimezone})` : " (source time)"}`;
}
export function calendarDateLabel(date: string, weekday: "short" | "long"): string {
    try { return new Intl.DateTimeFormat(undefined, { weekday, month: "short", day: "numeric" }).format(dayDate(date)); }
    catch { throw new CalendarTimezoneError("Could not format this TV’s dates. Try again."); }
}
