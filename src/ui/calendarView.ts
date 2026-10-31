import type { CalendarEvent, CalendarFilter } from "../contracts/v2/calendar.ts";
import type { FocusItem, FocusTarget, View, Zone } from "./browseFocus.ts";
import { actionButton, artwork, lines, zoneNode, type ViewContext } from "./browseViews.ts";
import { calendarDateLabel, calendarDestination, calendarEventKeys, calendarWeek, CalendarTimezoneError, eventTime, localDateKey, shiftDay, type CalendarState } from "./calendarState.ts";
import { el } from "./screen.ts";

export interface CalendarHandlers {
    readonly now: number;
    readonly busy: boolean;
    readonly failure: string | undefined;
    readonly context: ViewContext;
    readonly change: (step: -1 | 0 | 1 | CalendarFilter) => void;
    readonly focus: (target: FocusTarget) => void;
    readonly retry: () => void;
    readonly back: () => void;
}
const FILTERS = [["following", "Following"], ["trending", "Trending"], ["everything", "All"]] as const;
const BADGES: Readonly<Record<string, string>> = { series_premiere: "Premiere", season_premiere: "New season", finale: "Finale" };

function eventCard(event: CalendarEvent, key: string, timezone: string, context: ViewContext): FocusItem {
    const destination = calendarDestination(event);
    const item = actionButton(key, "", () => { if (destination !== undefined) context.open(destination); });
    item.element.className = "browse-card calendar-event";
    item.element.appendChild(artwork("browse-art", event.posterUrl, context.baseUrl, event.title));
    item.element.appendChild(el("span", "browse-card-title", event.title));
    const number = event.seasonNumber === undefined ? undefined : event.type === "season_premiere" ? `Season ${event.seasonNumber}` : event.episodeNumber === undefined ? `Season ${event.seasonNumber}` : `S${event.seasonNumber}:E${event.episodeNumber}`;
    const metadata = [number, event.episodeTitle, eventTime(event, timezone), ...event.badges.map(badge => Object.prototype.hasOwnProperty.call(BADGES, badge) ? BADGES[badge] : undefined).filter(label => label !== undefined), event.watched ? "Watched" : undefined, destination === undefined ? "Details unavailable for this event type" : undefined].filter(value => value !== undefined && value !== "");
    item.element.appendChild(el("span", "browse-card-subtitle", metadata.join(" · ")));
    if (destination === undefined) item.element.setAttribute("aria-disabled", "true");
    item.element.setAttribute("data-content-id", event.contentId);
    return item;
}

export function calendarView(state: CalendarState, handlers: CalendarHandlers): View {
    try { return calendarContent(state, handlers); }
    catch (error) {
        if (!(error instanceof CalendarTimezoneError)) throw error;
        return calendarContent({ ...state, start: undefined, data: undefined }, { ...handlers, busy: false, failure: error.message });
    }
}
function calendarContent(state: CalendarState, handlers: CalendarHandlers): View {
    const { busy, failure, context, change, focus, retry, back } = handlers;
    const today = localDateKey(new Date(handlers.now));
    const dates = state.start === undefined ? [] : Array.from({ length: 7 }, (_, i) => shiftDay(state.start ?? today, i));
    const controls = [actionButton("previous-week", "Previous week", () => change(-1)), actionButton("next-week", "Next week", () => change(1))];
    if (state.start !== undefined && state.start !== calendarWeek(new Date(handlers.now))[0]) controls.push(actionButton("today", "Today", () => change(0)));
    const filters = FILTERS.map(([value, label]) => {
        const item = actionButton(`filter:${value}`, label, () => change(value));
        item.element.setAttribute("aria-pressed", String(state.filter === value));
        return item;
    });
    const zones: Zone[] = [{ id: "week", layout: "row", items: controls }, { id: "filters", layout: "row", items: filters }];
    const content = [el("h1", "browse-title", "Calendar"), zoneNode("browse-actions calendar-week", controls), zoneNode("browse-actions calendar-filters", filters)];
    const status = el("div", "calendar-status");
    status.append(...lines(failure !== undefined ? [failure] : busy ? ["Loading the week."] : [], failure === undefined ? "info" : "error"));
    content.push(status);
    const shelves = dates.map(date => {
        const day = state.data?.days.find(day => day.date === date);
        const keys = calendarEventKeys(day?.items ?? []);
        return { date, items: (day?.items ?? []).map((event, i) => {
            return eventCard(event, keys[i] ?? "", state.data?.query.timezone ?? "", context);
        }) };
    });
    const days = dates.map(date => {
        const label = calendarDateLabel(date, "short");
        const item = actionButton(`day:${date}`, label, () => {
            state.selectedDay = date;
            const shelf = shelves.find(shelf => shelf.date >= date && shelf.items.length > 0) ?? [...shelves].reverse().find(shelf => shelf.date < date && shelf.items.length > 0);
            const first = shelf?.items[0];
            if (shelf !== undefined && first !== undefined) focus({ zone: shelf.date, key: first.key });
            else focus({ zone: "days", key: `day:${date}` });
        });
        item.element.classList.add("calendar-day");
        item.element.setAttribute("aria-pressed", String(state.selectedDay === date));
        if (date === today) item.element.setAttribute("aria-current", "date");
        return item;
    });
    content.push(zoneNode("calendar-strip", days));
    zones.push({ id: "days", layout: "row", items: days });
    if (state.data !== undefined && shelves.every(shelf => shelf.items.length === 0)) content.push(...lines(["No releases or episodes this week. Try another filter."]));
    for (const shelf of shelves) {
        const section = el("section", "calendar-shelf");
        section.setAttribute("data-section", shelf.date);
        section.appendChild(el("h2", "browse-section-title", calendarDateLabel(shelf.date, "long")));
        section.appendChild(shelf.items.length === 0 ? el("p", "browse-text", busy && state.data === undefined ? "Loading" : "No events") : zoneNode("browse-row", shelf.items));
        for (const item of shelf.items) item.element.addEventListener("focus", () => {
            state.selectedDay = shelf.date;
            for (const day of days) day.element.setAttribute("aria-pressed", String(day.key === `day:${shelf.date}`));
        });
        content.push(section);
        zones.push({ id: shelf.date, layout: "row", items: shelf.items });
    }
    const actions = [...(busy || failure !== undefined ? [actionButton("retry", "Try again", retry)] : []), actionButton("back", "Back", back)];
    content.push(zoneNode("browse-actions", actions));
    zones.push({ id: "status", layout: "row", items: actions });
    const first = days.find(day => day.key === `day:${state.selectedDay}`) ?? days[0];
    return { name: "calendar", content, zones, focus: first === undefined ? { zone: "status", key: failure === undefined ? "back" : "retry" } : { zone: "days", key: first.key }, back };
}
