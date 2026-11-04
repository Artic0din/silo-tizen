import type { CalendarEvent, CalendarFilter } from "../contracts/v2/calendar.ts";
import type { FocusItem, FocusTarget, View, Zone } from "./browseFocus.ts";
import { actionButton, artwork, lines, mediaItem, zoneNode, type ViewContext } from "./browseViews.ts";
import { calendarDateLabel, calendarDestination, calendarEventKeys, calendarWeek, CalendarTimezoneError, dayDate, eventTime, localDateKey, shiftDay, type CalendarState } from "./calendarState.ts";
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
const BADGES: Readonly<Record<string, string>> = { series_premiere: "PREMIERE", season_premiere: "NEW SEASON", finale: "FINALE" };

function eventCard(event: CalendarEvent, key: string, timezone: string, context: ViewContext): FocusItem {
    const destination = calendarDestination(event);
    const item = actionButton(key, "", () => { if (destination !== undefined) context.open(destination); });
    item.element.className = "browse-card calendar-event";
    const art = artwork("browse-art", event.posterUrl, context.baseUrl, event.title);
    const time = eventTime(event, timezone);
    const badges = event.badges.map(badge => Object.prototype.hasOwnProperty.call(BADGES, badge) ? BADGES[badge] : undefined).filter(label => label !== undefined);
    const releases = el("span", "calendar-releases");
    for (const badge of badges) releases.appendChild(el("span", "calendar-release", badge));
    art.appendChild(releases);
    if (event.watched) {
        const watched = el("span", "calendar-watched", "✓");
        watched.setAttribute("aria-label", "Watched");
        art.appendChild(watched);
    }
    if (time !== undefined) art.appendChild(el("span", "calendar-time", time));
    item.element.appendChild(art);
    item.element.appendChild(el("span", "browse-card-title", event.title));
    const number = event.seasonNumber === undefined ? undefined : event.type === "season_premiere" ? `Season ${event.seasonNumber}` : event.type === "episode" && event.episodeNumber !== undefined ? `S${event.seasonNumber} · E${event.episodeNumber}` : undefined;
    const metadata = [number, event.type === "episode" ? event.episodeTitle : undefined, event.type === "movie" ? "Movie" : undefined, destination === undefined ? "Details unavailable for this event type" : undefined].filter(value => value !== undefined && value !== "");
    item.element.appendChild(el("span", "browse-card-subtitle", metadata.join(" · ")));
    item.element.setAttribute("aria-label", [event.title, ...metadata, time, ...badges, event.watched ? "Watched" : undefined].filter(Boolean).join(" · "));
    if (destination === undefined) item.element.setAttribute("aria-disabled", "true");
    item.element.setAttribute("data-content-id", event.contentId);
    const type = event.type === "season_premiere" ? "season" : event.type === "movie" || event.type === "episode" ? event.type : "unknown";
    return mediaItem(item, { id: event.contentId, title: event.title, type }, context);
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
    for (const [i, control] of controls.entries()) {
        control.element.setAttribute("aria-label", i === 0 ? "Previous week" : "Next week");
        control.element.textContent = i === 0 ? "‹" : "›";
        control.element.classList.add("calendar-chevron");
    }
    if (state.start !== undefined && state.start !== calendarWeek(new Date(handlers.now))[0]) {
        const todayControl = actionButton("today", "Today", () => change(0));
        todayControl.element.setAttribute("aria-label", "Jump to today");
        controls.push(todayControl);
    }
    const filters = FILTERS.map(([value, label]) => {
        const item = actionButton(`filter:${value}`, label, () => change(value));
        item.element.setAttribute("aria-pressed", String(state.filter === value));
        return item;
    });
    const zones: Zone[] = [{ id: "filters", layout: "row", items: filters, entry: `filter:${state.filter}` }];
    const content = [zoneNode("browse-actions calendar-filters", filters)];
    const status = el("div", `calendar-status${state.data === undefined && (busy || failure !== undefined) ? " calendar-pending" : ""}`);
    status.append(...lines(failure !== undefined ? [failure] : busy ? ["Loading the week."] : [], failure === undefined ? "info" : "error"));
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
        item.element.setAttribute("aria-label", label);
        item.element.textContent = "";
        item.element.append(el("span", "calendar-weekday", new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(dayDate(date))), el("span", "calendar-day-number", new Intl.DateTimeFormat(undefined, { day: "numeric" }).format(dayDate(date))));
        if (state.data !== undefined) {
            const hasEvents = shelves.some(shelf => shelf.date === date && shelf.items.length > 0);
            item.element.setAttribute("data-has-events", String(hasEvents));
            if (hasEvents) {
                const dot = el("span", "calendar-event-dot");
                dot.setAttribute("aria-hidden", "true");
                item.element.appendChild(dot);
            }
        }
        item.element.setAttribute("aria-pressed", String(state.selectedDay === date));
        if (date === today) item.element.setAttribute("aria-current", "date");
        return item;
    });
    const stripItems = [...controls.slice(0, 1), ...days, ...controls.slice(1)];
    const strip = zoneNode("calendar-week", stripItems);
    if (dates[3] !== undefined) strip.appendChild(el("span", "calendar-month", new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(dayDate(dates[3]))));
    content.push(strip, status);
    const dayZone: Zone = { id: "days", layout: "row", items: stripItems, get entry() { return `day:${state.selectedDay ?? dates[0]}`; } };
    zones.push(dayZone);
    const empty = state.data !== undefined && !busy && failure === undefined && shelves.every(shelf => shelf.items.length === 0);
    if (empty) {
        const copy = state.filter === "following" ? ["Nothing from shows you follow", "No upcoming releases this week from shows you watch, favorite, or watchlist."] : state.filter === "trending" ? ["Nothing trending this week", "No trending movie releases or episode airings in this week."] : ["Nothing scheduled this week", "No movie releases or episode airings in this week."];
        const panel = el("section", "calendar-empty");
        panel.append(el("h2", "calendar-empty-title", copy[0]), el("p", "calendar-empty-subtitle", copy[1]));
        const links = FILTERS.filter(([value]) => value !== state.filter).map(([value, label]) => actionButton(`empty:${value}`, label, () => change(value)));
        panel.appendChild(zoneNode("calendar-empty-links", links));
        content.push(panel);
        zones.push({ id: "empty", layout: "row", items: links });
    }
    for (const shelf of empty || state.data === undefined ? [] : shelves) {
        const section = el("section", "calendar-shelf");
        section.style.setProperty("--calendar-scale", String(context.posterScale?.() ?? 1));
        section.setAttribute("data-section", shelf.date);
        const heading = shelf.date === today ? "Today" : shelf.date === shiftDay(today, 1) ? "Tomorrow" : new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(dayDate(shelf.date));
        section.appendChild(el("h2", "browse-section-title", heading));
        section.classList.toggle("calendar-shelf-empty", shelf.items.length === 0);
        section.appendChild(shelf.items.length === 0 ? el("p", "browse-text", "Nothing scheduled") : zoneNode("browse-row", shelf.items));
        for (const item of shelf.items) item.element.addEventListener("focus", () => {
            state.selectedDay = shelf.date;
            for (const day of days) day.element.setAttribute("aria-pressed", String(day.key === `day:${shelf.date}`));
        });
        content.push(section);
        zones.push({ id: shelf.date, layout: "row", items: shelf.items, entry: shelf.items[0]?.key });
    }
    const actions = [...(busy || failure !== undefined ? [actionButton("retry", "Try again", retry)] : []), actionButton("back", "Back", back)];
    content.push(zoneNode("browse-actions", actions));
    zones.push({ id: "status", layout: "row", items: actions });
    const first = days.find(day => day.key === `day:${state.selectedDay}`) ?? days[0];
    return { name: "calendar", content, zones, focus: first === undefined ? { zone: "status", key: failure === undefined ? "back" : "retry" } : { zone: "filters", key: `filter:${state.filter}` }, back };
}
