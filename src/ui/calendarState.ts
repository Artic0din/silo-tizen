import type { CalendarDay, CalendarEvent, CalendarFilter } from "../contracts/v2/calendar.ts";
import type { CalendarQuery } from "../api/calendarOperations.ts";
import type { Destination } from "./browseModel.ts";
import type { ErrorState } from "./browseRoutes.ts";

export interface CalendarState {
    error?: ErrorState;
    emptyLinkFocus?: boolean;
    start: string | undefined;
    timezone: string | undefined;
    selectedDay: string | undefined;
    /** Today returns selection to today and leaves focus on that day's event card once it exists. */
    returnToEvent?: boolean;
    /** Day the next render should scroll to the top. CalendarView.selectDay uses anchor `.top`. */
    alignDay?: string;
    filter: CalendarFilter;
    data: { readonly query: CalendarQuery; readonly days: readonly CalendarDay[] } | undefined;
}
/** Apple `CalendarViewModel.filterDefaultsKey`. Unknown values open on Following. */
export const CALENDAR_FILTER_KEY = "calendar.filter";
export function storedCalendarFilter(stored: string | null | undefined): CalendarFilter {
    return stored === "following" || stored === "trending" || stored === "everything" ? stored : "following";
}
export function calendarState(filter: CalendarFilter = "following"): CalendarState {
    return { start: undefined, timezone: undefined, selectedDay: undefined, filter, data: undefined };
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
        try { return new Intl.DateTimeFormat(undefined, { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(event.airAt)); }
        catch { throw new CalendarTimezoneError("Could not format this TV’s timezone. Try again."); }
    }
    if (event.airTime === undefined) return undefined;
    const [hour, minute] = event.airTime.split(":").map(Number);
    const local = new Date(2000, 0, 1, hour, minute);
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", hour12: true }).format(local);
}
export function calendarDateLabel(date: string, weekday: "short" | "long"): string {
    try { return new Intl.DateTimeFormat(undefined, { weekday, month: "short", day: "numeric" }).format(dayDate(date)); }
    catch { throw new CalendarTimezoneError("Could not format this TV’s dates. Try again."); }
}
