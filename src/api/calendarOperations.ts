import { decodeCalendar, isDateKey, type CalendarFilter, type CalendarDay } from "../contracts/v2/calendar.ts";
import { WireError } from "../contracts/v2/wire.ts";
import type { RequestSpec } from "./http.ts";

export interface CalendarQuery {
    readonly start: string;
    readonly end: string;
    readonly timezone: string;
    readonly filter: CalendarFilter;
}
export function getCalendar(query: CalendarQuery): RequestSpec<CalendarDay[]> {
    const { start, end, timezone, filter } = query;
    if (!isDateKey(start) || !isDateKey(end) || end < start) throw new RangeError("Invalid Calendar window");
    const latest = new Date(`${start}T12:00:00`);
    latest.setDate(latest.getDate() + 30);
    if (new Date(`${end}T12:00:00`) > latest) throw new RangeError("Invalid Calendar window");
    if (!["following", "trending", "everything"].includes(filter) || timezone === "") throw new RangeError("Invalid Calendar query");
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
    const params = Object.entries({ start, end, timezone, filter }).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
    return { method: "GET", path: `/calendar?${params}`, retry: "safe", decode: value => {
        const days = decodeCalendar(value);
        if (days.some(day => day.date < start || day.date > end)) throw new WireError("calendar.events", "days inside the requested window");
        return days;
    } };
}
