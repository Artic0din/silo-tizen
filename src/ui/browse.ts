// Native Movies and Series browsing for the active profile: Home, libraries, search and item
// pages, ending in a typed handoff to the player. Every read is profile-scoped through
// `session.call`, so the server applies the profile's restrictions and the session owns
// credentials and refresh.
//
// Ownership: browse draws only inside a container it appends to `root`. When the account or
// profile authority changes, it aborts its requests, drops its data and removes that container,
// and does nothing else: whoever reacts to the change (the profile screens) owns the root then.

import { type Clock, systemClock } from "../api/clock.ts";
import { ApiError } from "../api/errors.ts";
import { requestOperations } from "../api/requestOperations.ts";
import type { RequestsCapability } from "../contracts/v2/requests.ts";
import { requestsState, type RequestsHandlers, type RequestsSource } from "./requests.ts";
import type { RequestSpec } from "../api/http.ts";
import { operations } from "../api/operations.ts";
import { detailOperations } from "../api/detailOperations.ts";
import type { ItemDetail } from "../contracts/v2/catalog.ts";
import { DetailsState } from "./detailsState.ts";
import { CardActions } from "./cardActions.ts";
import { Synopsis } from "./browseDetails.ts";
import type { ConnectedServer } from "../session/core.ts";
import type { PublicStorage } from "../session/deviceIdentity.ts";
import { Skyline } from "./skyline.ts";
import { FocusHost, type FocusTarget } from "./browseFocus.ts";
import { type Destination, type PlayRequest, playChoices, visibleLibraries } from "./browseModel.ts";
import { failureText, hasData, newPages, newRoute, PAGE_SIZE, type Pages, type Route, routeView } from "./browseRoutes.ts";
import type { ViewContext } from "./browseViews.ts";
import { el } from "./screen.ts";
import { discoveryState, genreGroups, libraryScope, readDiscovery, type LibraryMode } from "./libraryDiscovery.ts";
import { availableModes } from "./libraryDiscoveryViews.ts";
import { personalListCapability, readPersonalPage, type PersonalFilter } from "./personalLists.ts";
import type { MediaScope } from "../contracts/v2/discovery.ts";
import { personQuery } from "./personFilmography.ts";
import { mountSettings, type SettingsScreen } from "./settings.ts";
import { getCalendar } from "../api/calendarOperations.ts";
import { calendarEventKeys, calendarState, calendarWeek, CalendarTimezoneError, deviceTimezone, localDateKey, shiftDay } from "./calendarState.ts";
import type { CalendarHandlers } from "./calendarView.ts";

export type { PlayRequest } from "./browseModel.ts";

export interface BrowseOptions {
    /** Signed in, with a profile selected (and its PIN verified when it has one). */
    readonly server: ConnectedServer;
    /** Browse hides itself and ignores keys until `resumeAfterPlayback`. */
    readonly onPlay: (request: PlayRequest) => void;
    /** The person asked for the profile screens; browse has already removed itself. */
    readonly onChooseProfile: () => void;
    readonly onSignOut?: () => void;
    readonly profileName?: string;
    readonly clock?: Clock;
    readonly publicStorage?: PublicStorage;
}

export interface Browse {
    /** Shows browse again where it was, after the player closes, and refreshes what it shows. */
    resumeAfterPlayback(): void;
    /** Removes browse and its container; nothing else in `root` is touched. */
    destroy(): void;
}

const SEARCH_DELAY_MS = 600;
const SLOW_MS = 5000;

export function mountBrowse(root: HTMLElement, options: BrowseOptions): Browse {
    const server = options.server;
    const session = server.session;
    if (session.activeProfile === undefined) {
        throw new Error("mountBrowse needs a selected profile");
    }
    const clock = options.clock ?? systemClock;
    const container = el("div", "browse");
    root.appendChild(container);
    const host = new FocusHost(container);
    const context: ViewContext = { baseUrl: server.server.http.base.baseUrl, open: (destination) => open(destination), preview: (card, row) => shell.preview(card, row), resume: (id, title) => {
        if (!torn && !playing && top()?.kind !== "resume") push(newRoute({ kind: "resume", id, title }));
    }, quickActions: card => {
        const current = top();
        if (current === undefined || torn || playing || cardActions.active) return;
        loading?.abort();
        loading = undefined;
        cancelSlow();
        if (current.kind === "homeSection" || current.kind === "personFilmography" || current.kind === "personal") current.pendingIndex = undefined;
        menuOrigin = { route: current, focus: host.focused() };
        cardActions.open(card);
    } };
    const input = el("input", "browse-input");
    input.id = "browse-search";
    input.type = "search";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("data-focus", "query");
    const searchLabel = el("label", "browse-label", "Search titles");
    searchLabel.htmlFor = input.id;
    // Kept across renders so the field, and the TV keyboard open on it, are never detached.
    const searchHead = [el("h1", "browse-title", "Search"), searchLabel, input];

    let stack: Route[] = [];
    let loading: AbortController | undefined;
    let cancelSlow: () => void = () => undefined;
    let cancelSearch: () => void = () => undefined;
    let cancelCalendarDay: () => void = () => undefined;
    let playing = false;
    let torn = false;
    let detailWork: DetailsState | undefined;
    let settingsScreen: SettingsScreen | undefined;
    let calendarLibrariesStale = false;
    let menuOrigin: { route: Route; focus: FocusTarget | undefined } | undefined;
    const personalPending = (): boolean => detailWork?.pending === true || cardActions.pending;
    const cardActions = new CardActions(container, session, state => {
        if (state.changes.size === 0) return;
        // Delivery may be uncertain; retained roots must reread even after a dismissed write.
        for (const entry of new Set([...roots.values(), ...stack])) entry.stale = true;
    }, () => {
        const origin = menuOrigin;
        menuOrigin = undefined;
        if (!torn && origin !== undefined && top() === origin.route) {
            origin.route.focus = origin.focus;
            showRoute(origin.route, origin.focus);
            render(origin.focus);
        }
    }, personalPending);
    const synopsis = new Synopsis(container, () => render({ zone: "actions", key: "synopsis" }));
    const stopDetails = (): void => { synopsis.destroy(); detailWork?.stop(); detailWork = undefined; };
    let inputRevision = 0;
    const recordInput = (): void => { inputRevision++; };
    document.addEventListener("keydown", recordInput, true);
    document.addEventListener("pointerdown", recordInput, true);

    const top = (): Route | undefined => stack[stack.length - 1];
    let requestsCapability: RequestsCapability = { enabled: false, follow: false };
    let probeOrdinal = 0;
    let requestWritePending = false;
    const requestsController = new AbortController();
    const probeRequests = async (): Promise<void> => {
        const ordinal = ++probeOrdinal;
        try {
            const capability = await session.call({ ...requestOperations.status(), profileScoped: true, signal: requestsController.signal });
            if (torn || ordinal !== probeOrdinal) return;
            requestsCapability = capability;
            const focus = host.focused();
            shell.setRequestsEnabled(capability.enabled);
            if (!capability.enabled) {
                roots.delete("requests");
                if (stack.some(route => route.kind === "requests")) {
                    loading?.abort(); loading = undefined;
                    stack = [home];
                    showRoute(home, { zone: "nav", key: "home" });
                    return;
                }
            }
            render(focus?.key === "requests" && !capability.enabled ? { zone: "nav", key: "home" } : focus);
        } catch { /* A transient probe failure keeps the last confirmed capability. */ }
    };
    const requestsVisibility = (): void => { if (!document.hidden) void probeRequests(); };
    document.addEventListener("visibilitychange", requestsVisibility);

    const teardown = (): void => {
        if (torn) {
            return;
        }
        torn = true;
        requestsController.abort();
        document.removeEventListener("visibilitychange", requestsVisibility);
        cardActions.destroy();
        menuOrigin = undefined;
        stopDetails();
        settingsScreen?.destroy();
        settingsScreen = undefined;
        stopAuthority();
        loading?.abort();
        cancelSlow();
        cancelSearch();
        cancelCalendarDay();
        document.removeEventListener("keydown", recordInput, true);
        document.removeEventListener("pointerdown", recordInput, true);
        stack = [];
        roots.clear();
        shell.destroy();
        host.destroy();
        if (container.parentNode === root) {
            root.removeChild(container);
        }
    };
    const stopAuthority = session.onAuthorityChange(teardown);

    /** Runs one read for the top route; an answer for a route or query no longer shown is dropped. */
    const load = <T>(current: Route, read: (signal: AbortSignal) => Promise<T>, apply: (value: T) => FocusTarget | void, quiet = false): void => {
        loading?.abort();
        cancelSlow();
        const controller = new AbortController();
        loading = controller;
        const entryRevision = inputRevision;
        const enterResults = !quiet && (current.kind === "personal" || current.kind === "personFilmography" || (current.kind === "library" && host.focused()?.key !== "sort"));
        current.slow = false;
        if (!quiet) {
            cancelSlow = clock.schedule(() => {
                if (loading === controller && top() === current) {
                    current.slow = true;
                    render();
                }
            }, SLOW_MS);
        }
        read(controller.signal).then(
            (value) => {
                if (loading !== controller || torn) {
                    return;
                }
                loading = undefined;
                cancelSlow();
                current.failure = undefined;
                current.stale = false;
                const focus = apply(value);
                if (top() === current) {
                    const enterContent = enterResults && inputRevision === entryRevision;
                    const lateCalendarContext = (current.kind === "item" && current.seriesContext !== undefined) || (current.kind === "season" && current.episodeId !== undefined);
                    const nextFocus = lateCalendarContext && inputRevision !== entryRevision ? host.focused() : (current.kind === "library" || ((current.kind === "personal" || current.kind === "personFilmography") && !quiet)) && !enterContent ? host.focused() : focus;
                    render(nextFocus === undefined ? undefined : nextFocus);
                    if (enterContent) host.focusDefault();
                }
            },
            (error: unknown) => {
                if (loading !== controller || torn || controller.signal.aborted) {
                    return;
                }
                loading = undefined;
                cancelSlow();
                if (error instanceof ApiError && error.problemId === "invalid_cursor" && (current.kind === "homeSection" || current.kind === "personFilmography" || current.kind === "personal" || current.kind === "library" || current.kind === "libraryResults" || current.kind === "search") && current.pages !== undefined) {
                    Object.assign(current.pages, newPages());
                    current.focus = undefined;
                    if (current.kind === "personal" || current.kind === "homeSection" || current.kind === "personFilmography") current.pendingIndex = undefined;
                    if (current.kind === "library" && current.discovery !== undefined) {
                        current.discovery.windowCursor = undefined;
                        current.discovery.seek = undefined;
                        current.discovery.letter = undefined;
                    }
                }
                const text = error instanceof CalendarTimezoneError ? error.message : failureText(error, current);
                if (text === undefined) {
                    // A defect, not a server answer: offer a retry, and surface it as uncaught.
                    clock.schedule(() => {
                        throw error;
                    }, 0);
                }
                current.failure = text ?? "Something went wrong. Try again.";
                if (current.kind === "requests" && error instanceof ApiError && ["capability_disabled", "capability_not_configured", "capability_unsupported", "permission_denied"].includes(error.problemId ?? "")) void probeRequests();
                if (top() === current) {
                    render();
                }
            },
        );
    };

    const read = <T>(spec: RequestSpec<T>, signal: AbortSignal): Promise<T> => session.call({ ...spec, profileScoped: true, signal });

    const invalidateCalendar = (): void => {
        const calendar = roots.get("calendar");
        if (calendar !== undefined) calendar.stale = true;
    };

    const detailsChanged = (current: Route, audioClosed = false): void => {
        if (current.kind === "item" || current.kind === "season") {
            const changes = current.data?.details?.changes;
            if (changes !== undefined && [...changes.values()].some(change => change.pending)) invalidateCalendar();
        }
        if ((current.kind === "item" || current.kind === "season") && current.data?.details?.changes.get("watched")?.pending) {
            invalidateWatched(current, current.data.details.detail);
        }
        if (top() === current) {
            if (cardActions.active) cardActions.render();
            else render(audioClosed ? { zone: "actions", key: "audio" } : undefined);
        }
    };

    const invalidateWatched = (current: Route, detail: ItemDetail): void => {
        // Even a lost or cancelled answer may have committed; reread covered routes on return.
        current.stale = true;
        const seriesId = detail.type === "series" ? detail.id : detail.seriesId;
        for (const entry of new Set([...roots.values(), ...stack])) {
            if (entry === current) continue;
            if (entry.kind === "home" || entry.kind === "homeSection" || entry.kind === "calendar") entry.stale = true;
            if (entry.kind === "season" && entry.seriesId === seriesId && (detail.type !== "season" || entry.seasonNumber === detail.seasonNumber)) entry.stale = true;
            if (entry.kind === "item") {
                const covered = entry.data?.detail;
                const affectedEpisode = covered?.type === "episode" && seriesId !== undefined && covered.seriesId === seriesId
                    && (detail.type === "series" || (detail.type === "season" && detail.seasonNumber !== undefined && covered.seasonNumber === detail.seasonNumber));
                if (entry.id === detail.id || entry.id === seriesId || affectedEpisode) entry.stale = true;
            }
        }
    };

    const refreshWatched = async (current: Route, detail: ItemDetail, signal: AbortSignal): Promise<void> => {
        invalidateWatched(current, detail);
        if (current.kind === "season") {
            const episodes = await read(operations.listSeasonEpisodes(current.seriesId, current.seasonNumber), signal);
            if (signal.aborted || top() !== current || current.data === undefined) return;
            current.data.episodes = episodes;
        }
        current.stale = false;
    };

    const loadRoute = (current: Route, quiet = false): void => {
        switch (current.kind) {
            case "requests": {
                const state = current.requests, source = state.source;
                const capabilityOrdinal = ++probeOrdinal;
                const entryRevision = inputRevision;
                load(current, async signal => {
                    const capability = await read(requestOperations.status(), signal);
                    if (!capability.enabled) return { capability, data: undefined };
                    const data = source.kind === "hub" ? await read(requestOperations.discover(), signal)
                        : source.kind === "mine" ? await read(requestOperations.mine(source.cursor), signal)
                        : source.kind === "media" ? await read(requestOperations.detail(source.title), signal)
                        : source.kind === "request" ? await read(requestOperations.request(source.id), signal)
                        : source.kind === "row" ? await read(requestOperations.row(source.key, source.page), signal)
                        : source.query.trim() === "" ? undefined : await read(requestOperations.search(source.query.trim(), source.page), signal);
                    return { capability, data };
                }, result => {
                    if (capabilityOrdinal === probeOrdinal) {
                        requestsCapability = result.capability;
                        shell.setRequestsEnabled(result.capability.enabled);
                    }
                    if (!requestsCapability.enabled) { roots.delete("requests"); stack = [home]; showRoute(home, { zone: "nav", key: "home" }); return; }
                    state.data = result.data;
                    state.uncertain = false;
                    // Focus the person moved while the read was out stays where it is.
                    return inputRevision === entryRevision ? current.focus : host.focused();
                }, quiet);
                render(current.focus);
                return;
            }
            case "calendar": {
                const state = current.calendar;
                const focus = host.focused();
                const oldShelf = state.data?.days.find(day => day.date === focus?.zone);
                const oldIndex = calendarEventKeys(oldShelf?.items ?? []).indexOf(focus?.key ?? "");
                load(current, async signal => {
                    prepareCalendar(current);
                    const start = state.start, timezone = state.timezone;
                    if (start === undefined || timezone === undefined) throw new CalendarTimezoneError("Could not read this TV’s timezone. Try again.");
                    const query = { start, end: shiftDay(start, 6), timezone, filter: state.filter };
                    const [days, libraries] = await Promise.all([
                        read(getCalendar(query), signal),
                        calendarLibrariesStale ? Promise.all([read(operations.listUserLibraries(), signal), read(operations.hiddenLibraries(), signal)]) : undefined,
                    ]);
                    // Exercise all date/time formatting before publishing the snapshot.
                    for (const day of days) for (const event of day.items) if (event.airAt !== undefined) {
                        try { new Intl.DateTimeFormat(undefined, { timeZone: timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(event.airAt)); }
                        catch { throw new CalendarTimezoneError("Could not format this TV’s timezone. Try again."); }
                    }
                    return { query, days, libraries, deviceZone: deviceTimezone() };
                }, data => {
                    if (data.deviceZone !== data.query.timezone) {
                        state.timezone = data.deviceZone;
                        state.data = undefined;
                        loadRoute(current, true);
                        return host.focused();
                    }
                    const active = host.focused();
                    state.data = { query: data.query, days: data.days };
                    if (data.libraries !== undefined) {
                        const libraries = visibleLibraries(data.libraries[0], data.libraries[1]);
                        shell.update(libraries);
                        if (home.kind === "home" && home.data !== undefined) home.data.libraries = libraries;
                        calendarLibrariesStale = false;
                    }
                    if (active?.zone === focus?.zone && active?.key === focus?.key && oldIndex >= 0) {
                        const day = data.days.find(day => day.date === focus?.zone);
                        const keys = calendarEventKeys(day?.items ?? []);
                        if (keys.includes(active?.key ?? "")) return active;
                        const nearby = keys[Math.min(oldIndex, keys.length - 1)];
                        if (day !== undefined && nearby !== undefined) return { zone: day.date, key: nearby };
                        const next = data.days.find(day => day.date > (focus?.zone ?? "") && day.items.length > 0) ?? [...data.days].reverse().find(day => day.items.length > 0);
                        const key = calendarEventKeys(next?.items ?? [])[0];
                        if (next !== undefined && key !== undefined) return { zone: next.date, key };
                    }
                    return active;
                }, quiet);
                return;
            }
            case "resume":
                load(current, async signal => {
                    const detail = await read(operations.getCatalogItem(current.id), signal);
                    if (detail.id !== current.id || (detail.type !== "movie" && detail.type !== "episode")) throw new ApiError({ kind: "invalid_response", path: "resume.item" });
                    return playChoices(detail);
                }, choices => {
                    if (choices === undefined) { current.failure = "No playable version is available for this title."; return; }
                    // Discard the resolution route before handing off so returning cannot replay it.
                    stack.pop();
                    render(top()?.focus);
                    play(choices.resume ?? choices.fromStart);
                });
                return;
            case "homeSection":
            case "personFilmography":
                loadPage(current, current.pages, current.pendingIndex ?? current.pages.index, quiet);
                return;
            case "personal":
                loadPage(current, current.pages, current.pendingIndex ?? current.pages.index, quiet);
                return;
            case "home":
                load(current, (signal) => Promise.all([
                    read(operations.listUserLibraries(), signal),
                    // The hidden list is the profile's own preference, not an access limit: when it
                    // cannot be read, its libraries still show rather than Home failing.
                    read(operations.hiddenLibraries(), signal).catch((error: unknown) => {
                        if (error instanceof ApiError && !error.aborted) {
                            return [];
                        }
                        throw error;
                    }),
                    read(operations.listHomeSections(), signal),
                ]), ([libraries, hidden, sections]) => {
                    const focus = host.focused();
                    current.data = { libraries: visibleLibraries(libraries, hidden), sections };
                    shell.update(current.data.libraries);
                    // Changed tabs replace the nav nodes, including the still-present avatar.
                    return focus?.zone === "nav" ? focus : undefined;
                }, quiet);
                return;
            case "library":
                current.discovery ??= discoveryState();
                if (current.discovery.data !== undefined && (current.discovery.mode === "Recently Added" || current.discovery.mode === "A–Z" || current.discovery.genre !== undefined)) {
                    loadPage(current, current.pages, current.pages.index, quiet);
                    return;
                }
                load(current, async signal => {
                    const state = current.discovery ?? discoveryState();
                    const data = await readDiscovery(current.library, state.mode, spec => read(spec, signal));
                    const page = (state.mode === "Recently Added" || state.mode === "A–Z") && data.capabilities?.allowed === true
                        ? await read(operations.queryCatalogItems({ ...libraryScope(current.library), limit: PAGE_SIZE, sort: state.mode === "Recently Added" ? "added_at" : "title", order: state.mode === "Recently Added" ? "desc" : "asc" }), signal) : undefined;
                    return { data, page };
                }, ({ data, page }) => {
                    if (current.discovery !== undefined) {
                        current.discovery.data = data;
                        current.discovery.capabilities = data.capabilities;
                        shell.setLibraryModes(availableModes(data.capabilities));
                    }
                    current.pages.page = page;
                    current.pages.cursors = [undefined, page?.nextCursor];
                    if (current.discovery !== undefined) current.discovery.windowCursor = page?.windowCursor;
                }, quiet);
                return;
            case "libraryResults":
                loadPage(current, current.pages, current.pages.index, quiet);
                return;
            case "search":
                search(current, quiet);
                return;
            case "item":
                stopDetails();
                load(current, async (signal) => {
                    const detail = await read(operations.getCatalogItem(current.id), signal);
                    const seasons = detail.type === "series" ? await read(operations.listSeriesSeasons(detail.id), signal) : [];
                    const episodeId = current.seriesContext?.episodeId;
                    const episode = detail.type === "series" && current.seriesContext?.seasonNumber === undefined && episodeId !== undefined
                        ? await read(operations.getCatalogItem(episodeId), signal).catch((error: unknown) => { if (error instanceof ApiError && error.status === 404) return undefined; throw error; }) : undefined;
                    return { detail, seasons, contextSeason: current.seriesContext?.seasonNumber ?? (episode?.seriesId === detail.id ? episode.seasonNumber : undefined) };
                }, (data) => {
                    const previous = current.data?.details;
                    const details = new DetailsState(data.detail, session, (audioClosed) => detailsChanged(current, audioClosed), (detail, signal) => refreshWatched(current, detail, signal), personalPending);
                    details.restore(previous);
                    details.related = quiet ? previous?.related : undefined;
                    current.data = { ...data, details };
                    detailWork = details;
                    details.start();
                    if (details.related !== undefined) details.loadRelated();
                    const season = data.contextSeason;
                    if (current.focus === undefined && season !== undefined && data.seasons.some(item => item.seasonNumber === season)) return { zone: "seasons", key: `season:${season}` };
                }, quiet);
                return;
            case "person":
                load(current, (signal) => Promise.all([current.data?.person ?? read(detailOperations.person(current.id), signal), read(detailOperations.filmography(current.id), signal)]), ([person, titles]) => {
                    current.data = { person, titles };
                }, quiet);
                return;
            case "season":
                stopDetails();
                load(current, async (signal) => {
                    const [episodes, detail] = await Promise.all([
                        read(operations.listSeasonEpisodes(current.seriesId, current.seasonNumber), signal),
                        current.id === undefined ? undefined : read(operations.getCatalogItem(current.id), signal).catch((error: unknown) => {
                            if (error instanceof ApiError && error.status === 404) return undefined;
                            throw error;
                        }),
                    ]);
                    return { episodes, detail };
                }, (data) => {
                    current.data = data;
                    if (data.detail !== undefined) {
                        const details = new DetailsState(data.detail, session, (audioClosed) => detailsChanged(current, audioClosed), (detail, signal) => refreshWatched(current, detail, signal), personalPending);
                        current.data.details = details;
                        detailWork = details;
                        details.start();
                    }
                    if (current.focus === undefined && current.episodeId !== undefined && data.episodes.some(episode => episode.id === current.episodeId)) return { zone: "episodes", key: current.episodeId };
                }, quiet);
        }
    };

    const loadPage = (current: Route, pages: Pages, index: number, quiet = false): void => {
        if (current.kind === "personFilmography") {
            current.pendingIndex = index;
            load(current, async signal => {
                const page = await read(operations.queryCatalogItems(personQuery(current.id, current.filter, pages.cursors[index])), signal);
                if (page.nextCursor !== undefined && pages.cursors.slice(0, index + 1).includes(page.nextCursor)) {
                    throw new ApiError({ kind: "invalid_response", path: "personFilmography.page.next_cursor" });
                }
                return page;
            }, page => {
                const focus = host.focused();
                const oldIndex = pages.page?.items.findIndex(item => item.id === focus?.key) ?? -1;
                const nearby = index === pages.index && focus?.zone === "grid" && oldIndex >= 0 && !page.items.some(item => item.id === focus.key)
                    ? page.items[Math.min(oldIndex, page.items.length - 1)] : undefined;
                pages.page = page;
                pages.index = index;
                pages.cursors = [...pages.cursors.slice(0, index + 1), page.nextCursor];
                current.pendingIndex = undefined;
                return nearby === undefined ? undefined : { zone: "grid", key: nearby.id };
            }, quiet || pages.page !== undefined);
            return;
        }
        if (current.kind === "homeSection") {
            current.pendingIndex = index;
            load(current, signal => read(operations.queryCatalogItems({ source: "section", scope: "home", section_id: current.id, limit: PAGE_SIZE, ...(pages.cursors[index] === undefined ? {} : { cursor: pages.cursors[index] }) }), signal), page => {
                pages.page = page;
                pages.index = index;
                pages.cursors = [...pages.cursors.slice(0, index + 1), page.nextCursor];
                current.pendingIndex = undefined;
            }, quiet || pages.page !== undefined);
            return;
        }
        if (current.kind === "personal") {
            current.pendingIndex = index;
            load(current, async signal => {
                const capability = current.source === "history" ? undefined : await read(personalListCapability(), signal);
                const page = capability !== undefined && (!capability.allowed || capability.state !== "available") ? undefined : await read(readPersonalPage(current.source, current.filter, pages.cursors[index]), signal);
                return { capability, page };
            }, ({ capability, page }) => {
                const focus = host.focused();
                const oldIndex = pages.page?.items.findIndex(item => item.id === focus?.key) ?? -1;
                let replacement: FocusTarget | undefined;
                if (index === pages.index && focus?.zone === "grid" && oldIndex >= 0 && page !== undefined && !page.items.some(item => item.id === focus.key)) {
                    const nearby = page.items[Math.min(oldIndex, page.items.length - 1)];
                    if (nearby !== undefined) replacement = { zone: "grid", key: nearby.id };
                }
                current.capability = capability;
                pages.page = page;
                pages.index = index;
                pages.cursors = [...pages.cursors.slice(0, index + 1), page?.nextCursor];
                current.pendingIndex = undefined;
                return replacement;
            }, quiet || pages.page !== undefined);
            return;
        }
        if (current.kind === "library" || current.kind === "libraryResults") {
            load(current, async signal => {
                const cursor = pages.cursors[index];
                if (current.kind === "libraryResults" && current.source.kind === "collection" && current.source.groupKind === "admin") return read(operations.getLibraryCollectionItems(current.library.id, current.source.id, { limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) }), signal);
                if (current.kind === "libraryResults" && current.source.kind === "section" && index === 0) await read(operations.getLibrarySectionItems(current.library.id, current.source.id), signal);
                const state = current.kind === "library" ? current.discovery : undefined;
                const recent = state?.mode === "Recently Added";
                const source = current.kind === "libraryResults" ? current.source : undefined;
                const query = operations.queryCatalogItems({
                    ...libraryScope(current.library), limit: PAGE_SIZE,
                    sort: recent ? "added_at" : "title",
                    order: recent || state?.descending === true || (current.kind === "libraryResults" && current.descending) ? "desc" : "asc",
                    ...(cursor === undefined ? {} : { cursor }),
                    ...(state?.seek === undefined || index !== 0 ? {} : { seek: state.seek, ...(state.windowCursor === undefined ? {} : { cursor: state.windowCursor }) }),
                    ...(source?.kind === "genre" ? { groups: genreGroups(source.name) } : {}),
                    ...(state?.genre === undefined ? {} : { groups: genreGroups(state.genre) }),
                    ...(source?.kind === "collection" && source.groupKind === "user_collections" ? { source: "user_collection", scope: "library", collection_id: source.id } : {}),
                    ...(source?.kind === "section" ? { source: "section", scope: "library", section_id: source.id } : {}),
                });
                return read(query, signal);
            }, page => {
                pages.page = page;
                pages.index = index;
                pages.cursors = pages.cursors.slice(0, index + 1);
                pages.cursors.push(page.nextCursor);
                if (current.kind === "library" && current.discovery !== undefined && "windowCursor" in page && typeof page.windowCursor === "string") current.discovery.windowCursor = page.windowCursor;
            }, quiet || pages.page !== undefined);
            return;
        }
        if (current.kind !== "search") {
            return;
        }
        const query = current.query;
        load(current, async signal => {
            let type = current.searchType;
            if (type === undefined) {
                const capability = await read(operations.getCatalogSearchCapabilities(), signal);
                type = capability.allowed && capability.state === "available" && capability.videoWithEpisodesScope === true
                    ? "video_with_episodes" : "video";
                if (!signal.aborted && top() === current && current.query === query) {
                    current.searchType = type;
                }
            }
            return read(operations.listCatalogItems({ q: query, type, limit: PAGE_SIZE, cursor: pages.cursors[index] }), signal);
        }, (page) => {
            pages.page = page;
            pages.index = index;
            pages.cursors = pages.cursors.slice(0, index + 1);
            pages.cursors.push(page.nextCursor);
            current.resultsFor = query;
        }, quiet || pages.page !== undefined);
    };

    const search = (current: Extract<Route, { kind: "search" }>, quiet = false): void => {
        cancelSearch();
        current.failure = undefined;
        if (current.query.trim() === "") {
            loading?.abort();
            loading = undefined;
            current.pages = undefined;
            render();
            return;
        }
        const pages = quiet && current.pages !== undefined ? current.pages : newPages();
        current.pages = pages;
        loadPage(current, pages, pages.index, quiet);
        render();
    };

    input.addEventListener("input", () => {
        const current = top();
        if (current?.kind !== "search") {
            return;
        }
        loading?.abort();
        loading = undefined;
        cancelSlow();
        current.slow = false;
        current.query = input.value;
        cancelSearch();
        // Only the replacement request is debounced; an obsolete read stops immediately.
        cancelSearch = clock.schedule(() => search(current), SEARCH_DELAY_MS);
    });
    input.addEventListener("keydown", (event) => {
        const current = top();
        // The TV keyboard's Done key, or Enter on a desktop keyboard: search now.
        if (current?.kind === "search" && (event.keyCode === 65376 || event.key === "Enter") && input.value !== "") {
            current.query = input.value;
            search(current);
        }
    });

    const pop = (): void => {
        const active = top();
        if (active?.kind === "library" && active.discovery?.genre !== undefined) {
            genre(active, undefined);
            return;
        }
        if (stack.length <= 1) {
            return;
        }
        stopDetails();
        loading?.abort();
        loading = undefined;
        cancelSearch();
        stack.pop();
        const current = top();
        if (current !== undefined) {
            if (current.kind === "personal" || current.kind === "personFilmography" || current.kind === "calendar" || current.kind === "requests") {
                if (current.kind === "personal" || current.kind === "personFilmography") current.pendingIndex = undefined;
                current.stale = true;
            }
            showRoute(current, current.focus);
        }
    };

    const push = (next: Route): void => {
        stopDetails();
        const current = top();
        if (current !== undefined) {
            current.focus = host.focused();
            if (current.kind === "homeSection" || current.kind === "personFilmography") current.pendingIndex = undefined;
        }
        loading?.abort();
        loading = undefined;
        cancelSearch();
        stack.push(next);
        showRoute(next, undefined);
    };

    const showRoute = (current: Route, focus: FocusTarget | undefined): void => {
        if (current.kind === "calendar") {
            try { prepareCalendar(current); }
            catch (error) { current.failure = error instanceof Error ? error.message : "Could not read this TV’s timezone. Try again."; }
        }
        if (current.kind === "search") {
            input.value = current.query;
        }
        render(focus);
        if ((current.kind === "item" || current.kind === "season") && current.data?.details !== undefined && !current.stale) {
            detailWork = current.data.details;
            detailWork.start();
        }
        const queryChanged = current.kind === "search" && current.query !== current.resultsFor;
        if (!hasData(current) || current.stale || current.failure !== undefined || queryChanged) {
            loadRoute(current, hasData(current) && !queryChanged);
            if (current.kind === "calendar") render(focus);
        }
    };

    const open = (destination: Destination): void => {
        push(destination.kind === "item"
            ? newRoute({ kind: "item", id: destination.id, title: destination.title, ...(destination.seriesContext === undefined ? {} : { seriesContext: destination.seriesContext }), data: undefined })
            : destination.kind === "person" ? newRoute({ kind: "person", id: destination.id, title: destination.title, data: undefined })
            : newRoute({ kind: "season", ...(destination.id === undefined ? {} : { id: destination.id }), ...(destination.episodeId === undefined ? {} : { episodeId: destination.episodeId }), seriesId: destination.seriesId, seasonNumber: destination.seasonNumber, title: destination.title, data: undefined }));
    };

    const play = (request: PlayRequest): void => {
        const current = top();
        if (current === undefined || torn || playing) return;
        const details = current.kind === "item" ? current.data?.details : undefined;
        const focus = host.focused();
        if (details === undefined) handoff(request);
        else {
            loading?.abort();
            loading = undefined;
            cancelSlow();
            detailWork = details;
            details.start();
            details.preparePlay(request, clock, resolved => handoff(resolved, focus));
        }
    };

    const handoff = (request: PlayRequest, focus?: FocusTarget): void => {
        const current = top();
        if (current === undefined || torn || playing) {
            return;
        }
        current.focus = focus ?? host.focused();
        stopDetails();
        playing = true;
        cancelCalendarDay();
        host.holdVisit();
        shell.hide();
        host.stop();
        container.hidden = true;
        options.onPlay(request);
    };

    const chooseProfile = (): void => {
        teardown();
        options.onChooseProfile();
    };

    const render = (focus?: FocusTarget): void => {
        cancelCalendarDay();
        const current = top();
        if (current === undefined || torn || playing || synopsis.active || cardActions.active || settingsScreen !== undefined) {
            return;
        }
        if (current.kind === "calendar") {
            const midnight = new Date(clock.now());
            midnight.setHours(24, 0, 0, 0);
            cancelCalendarDay = clock.schedule(() => render(host.focused()), midnight.getTime() - clock.now());
        }
        if (current.kind === "library") shell.setLibraryModes(availableModes(current.discovery?.data?.capabilities ?? current.discovery?.capabilities));
        const handlers = { context, synopsis, focusDefault: () => host.focusDefault(), busy: loading !== undefined, searchHead, input, push, pop, play, chooseProfile, retry, turn, mode, jump, sort, genre, personalFilter, personFilter, calendar: calendarHandlers, requests: requestsHandlers };
        const view = routeView(current, handlers);
        const rootRoute = current.kind === "home" || current.kind === "library" || current.kind === "search" || current.kind === "personal" || current.kind === "calendar" || (current.kind === "requests" && current.requests.source.kind === "hub");
        if (rootRoute) {
            const selected = current.kind === "library" ? (current.library.type === "series" ? "series" : "movies") : current.kind === "personal" ? "profiles" : current.kind;
            const preview = current.kind === "home" || (current.kind === "library" && (current.discovery?.mode ?? "Browse") === "Browse");
            const decorated = shell.decorate(view, selected, preview, current.kind === "personal" || (current.kind === "library" && current.discovery?.genre !== undefined) ? pop : undefined, current.kind === "library" ? `library:${current.library.id}:${current.library.type}:${current.discovery?.mode ?? "Browse"}` : undefined);
            host.show({ ...decorated, ...(current.kind === "library" ? { ready: hasData(current), ...(current.discovery?.genre !== undefined ? { back: pop } : {}) } : {}) }, focus);
        } else {
            host.holdVisit();
            shell.hide();
            host.show(view, focus);
        }
    };

    const retry = (current: Route): void => {
        current.failure = undefined;
        render();
        loadRoute(current);
    };
    // Retained roots must reread too: a settled or uncertain write may have changed them.
    const markRequestsStale = (): void => { for (const route of new Set([...roots.values(), ...stack])) if (route.kind === "requests") route.stale = true; };
    const openRequests = (source: RequestsSource): void => { if (requestsCapability.enabled) push(newRoute({ kind: "requests", requests: requestsState(source) })); };
    const requestsHandlers = (current: Extract<Route, { kind: "requests" }>): RequestsHandlers => ({
        capability: requestsCapability, busy: loading !== undefined || requestWritePending, failure: current.failure,
        profileId: session.activeProfile?.id ?? "", back: pop, retry: () => { current.focus = host.focused(); retry(current); }, open: openRequests,
        edit: () => {
            if (top() !== current) return;
            loading?.abort(); loading = undefined; cancelSlow();
            current.requests.data = undefined; current.failure = undefined;
            render({ zone: "search", key: "query" });
        },
        search: () => {
            if (top() !== current || current.requests.source.kind !== "search") return;
            current.requests.source.page = 1; current.requests.data = undefined; current.focus = { zone: "search", key: "query" }; retry(current);
        },
        next: value => {
            const source = current.requests.source;
            if (source.kind === "mine" && typeof value === "string") source.cursor = value;
            else if ((source.kind === "row" || source.kind === "search") && typeof value === "number") source.page = value;
            else return;
            current.requests.data = undefined; current.focus = undefined; retry(current);
        },
        write: action => {
            const state = current.requests, data = state.data;
            if (top() !== current || torn || requestWritePending || state.writing || state.uncertain || loading !== undefined || data === undefined || !requestsCapability.enabled) return;
            const spec = action === "cancel" && "id" in data ? requestOperations.cancel(data.id)
                : "request" in data ? action === "create" ? requestOperations.create(data) : requestOperations.follow(data, action === "follow") : undefined;
            if (spec === undefined) return;
            requestWritePending = true; state.writing = true; state.uncertain = true; current.failure = undefined;
            current.focus = { zone: "actions", key: "refresh" }; render(current.focus);
            const writeRevision = inputRevision;
            // Focus the person moved while the write was out stays where it is.
            const keepMovedFocus = (route: Route): void => { if (inputRevision !== writeRevision) route.focus = host.focused() ?? route.focus; };
            // A write belongs to session authority, not route lifetime. Leaving never replays it.
            session.call({ ...spec, profileScoped: true, replayAfterRefresh: false }).then(() => {
                requestWritePending = false; state.writing = false;
                if (torn) return;
                markRequestsStale();
                const visible = top();
                if (visible?.kind === "requests") { keepMovedFocus(visible); visible.requests.uncertain = true; loadRoute(visible, true); }
                else render(host.focused());
            }, (error: unknown) => {
                requestWritePending = false; state.writing = false;
                if (torn) return;
                state.uncertain = true;
                current.failure = "Could not confirm the change. Refresh before trying again.";
                markRequestsStale();
                if (error instanceof ApiError && ["capability_disabled", "capability_not_configured", "capability_unsupported", "permission_denied"].includes(error.problemId ?? "")) void probeRequests();
                const visible = top();
                if (visible?.kind === "requests") keepMovedFocus(visible);
                if (visible === current) render(current.focus);
                else if (visible?.kind === "requests") { visible.requests.uncertain = true; loadRoute(visible, true); }
                else render(host.focused());
            });
        },
    });
    const prepareCalendar = (current: Extract<Route, { kind: "calendar" }>): void => {
        const state = current.calendar;
        let zone: string;
        try { zone = deviceTimezone(); }
        catch (error) { state.start = undefined; state.timezone = undefined; state.data = undefined; throw error; }
        if (zone !== state.timezone) {
            state.timezone = zone;
            state.start ??= calendarWeek(new Date(clock.now()))[0];
            state.selectedDay ??= localDateKey(new Date(clock.now()));
            state.data = undefined;
            current.stale = true;
        }
    };
    const calendarHandlers = (current: Extract<Route, { kind: "calendar" }>): CalendarHandlers => ({
        now: clock.now(), busy: loading !== undefined, failure: current.failure, context,
        focus: target => render(target), retry: () => retry(current), back: pop,
        change: value => {
            try { prepareCalendar(current); }
            catch (error) { current.failure = error instanceof Error ? error.message : "Could not read this TV’s timezone."; render(); return; }
            const state = current.calendar;
            if (typeof value === "string") { if (state.filter === value) return; state.filter = value; }
            else {
                state.start = value === 0 ? calendarWeek(new Date(clock.now()))[0] : shiftDay(state.start ?? localDateKey(new Date(clock.now())), value * 7);
                state.selectedDay = value === 0 ? localDateKey(new Date(clock.now())) : state.start;
            }
            state.data = undefined;
            current.failure = undefined;
            loadRoute(current, true);
            render();
        },
    });
    const personalFilter = (current: Extract<Route, { kind: "personal" }>, filter: PersonalFilter): void => {
        if (current.filter === filter) return;
        current.filter = filter;
        current.pages = newPages();
        current.pendingIndex = undefined;
        current.failure = undefined;
        loadRoute(current, true);
        render({ zone: "filters", key: `filter:${filter}` });
    };

    const personFilter = (current: Extract<Route, { kind: "personFilmography" }>, filter: MediaScope): void => {
        if (current.filter === filter) return;
        current.filter = filter;
        current.pages = newPages();
        current.pendingIndex = undefined;
        current.failure = undefined;
        loadRoute(current, true);
        render({ zone: "filters", key: `filter:${filter}` });
    };

    const mode = (current: Extract<Route, { kind: "library" }>, value: LibraryMode): void => {
        if (current.discovery?.mode === value && hasData(current)) {
            host.focusDefault();
            return;
        }
        current.discovery = { ...discoveryState(), mode: value, capabilities: current.discovery?.capabilities };
        current.pages = newPages();
        current.failure = undefined;
        loadRoute(current);
        render({ zone: "pills", key: `mode:${value}` });
    };
    const jump = (current: Extract<Route, { kind: "library" }>, letter: string, position: number): void => {
        const state = current.discovery;
        if (state === undefined) return;
        state.seek = position;
        state.letter = letter;
        current.pages = newPages();
        current.failure = undefined;
        loadPage(current, current.pages, 0);
        render({ zone: "letters", key: `letter:${letter}` });
    };
    const genre = (current: Extract<Route, { kind: "library" }>, name: string | undefined): void => {
        const state = current.discovery;
        if (state === undefined) return;
        const previous = state.genre;
        state.genre = name;
        state.descending = false;
        current.pages = newPages();
        current.failure = undefined;
        if (name !== undefined) loadPage(current, current.pages, 0);
        else { loading?.abort(); loading = undefined; cancelSlow(); }
        render(name === undefined && previous !== undefined ? { zone: "genres", key: `genre:${previous}` } : undefined);
    };
    const sort = (current: Extract<Route, { kind: "libraryResults" | "library" }>): void => {
        if (current.kind === "library") {
            if (current.discovery === undefined) return;
            current.discovery.descending = !current.discovery.descending;
        } else current.descending = !current.descending;
        current.pages = newPages();
        current.failure = undefined;
        loadRoute(current);
        render({ zone: "actions", key: "sort" });
    };

    const turn = (current: Route, pages: Pages, step: -1 | 1): void => {
        const index = pages.index + step;
        // One page request at a time; a press while one is out is ignored.
        if (loading !== undefined || index < 0 || index >= pages.cursors.length || (step === 1 && pages.cursors[index] === undefined)) {
            return;
        }
        current.failure = undefined;
        loadPage(current, pages, index);
        render();
    };

    const home = newRoute({ kind: "home", data: undefined });
    const roots = new Map<string, Route>([["home", home]]);
    const shell = new Skyline(container, clock, (target, destinationMode) => {
        const current = top();
        if (current !== undefined) current.focus = host.focused();
        const key = typeof target === "string" ? target : `library:${target.id}:${target.type}`;
        let route = roots.get(key);
        if (route === undefined) {
            route = typeof target === "string"
                ? target === "requests" ? newRoute({ kind: "requests", requests: requestsState({ kind: "hub" }) }) : target === "calendar" ? newRoute({ kind: "calendar", calendar: calendarState() }) : newRoute({ kind: "search", query: "", pages: undefined, resultsFor: "" })
                : newRoute({ kind: "library", library: target, pages: newPages() });
            roots.set(key, route);
        }
        if (route.kind === "library" && destinationMode !== undefined) {
            route.discovery = { ...discoveryState(), mode: destinationMode, capabilities: route.discovery?.capabilities };
            route.pages = newPages();
        }
        loading?.abort();
        loading = undefined;
        cancelSearch();
        stack = route === home ? [home] : [home, route];
        showRoute(route, route.focus?.zone === "nav" ? undefined : route.focus);
        if (hasData(route) && (route.focus === undefined || route.focus.zone === "nav")) host.focusDefault();
    }, {
        name: options.profileName ?? "Profiles",
        settings: () => {
            stopDetails();
            cancelCalendarDay();
            loading?.abort();
            loading = undefined;
            cancelSlow();
            cancelSearch();
            host.holdVisit();
            shell.hide();
            host.stop();
            container.hidden = true;
            settingsScreen = mountSettings(root, session, hiddenChanged => {
                settingsScreen = undefined;
                if (torn) return;
                container.hidden = false;
                if (hiddenChanged) {
                    const calendar = stack.find(entry => entry.kind === "calendar");
                    home.stale = true;
                    roots.clear();
                    roots.set("home", home);
                    if (calendar !== undefined) { calendar.stale = true; calendarLibrariesStale = true; roots.set("calendar", calendar); }
                    stack = calendar === undefined ? [home] : [home, calendar];
                }
                host.listen();
                const current = top();
                if (current !== undefined) showRoute(current, { zone: "nav", key: "profiles" });
            }, server.profileLaunch);
        },
        personal: source => {
            const origin = top();
            push(newRoute({ kind: "personal", source, filter: "movie", pages: newPages(), capability: undefined, pendingIndex: undefined }));
            if (origin !== undefined) origin.focus = { zone: "nav", key: "profiles" };
        },
        switchProfile: chooseProfile,
        ...(options.onSignOut === undefined ? {} : { signOut: options.onSignOut }),
    }, () => render(), options.publicStorage, `silo.skyline.scope:${JSON.stringify([server.server.serverId, session.activeProfile.id])}`, context.baseUrl);
    shell.update([]);
    void probeRequests();
    stack = [home];
    host.listen();
    const first = top();
    if (first !== undefined) {
        showRoute(first, undefined);
    }

    return {
        resumeAfterPlayback() {
            if (torn || !playing) {
                return;
            }
            playing = false;
            container.hidden = false;
            for (const entry of stack) {
                entry.stale = true;
            }
            invalidateCalendar();
            host.listen();
            const current = top();
            if (current !== undefined) {
                showRoute(current, current.focus);
            }
        },
        destroy: teardown,
    };
}
