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
import type { MediaRequest, MyRequests, RequestsCapability } from "../contracts/v2/requests.ts";
import { WireError } from "../contracts/v2/wire.ts";
import { requestsState, type RequestsHandlers, type RequestsSource } from "./requests.ts";
import type { RequestSpec } from "../api/http.ts";
import { operations } from "../api/operations.ts";
import { detailOperations } from "../api/detailOperations.ts";
import type { ItemDetail } from "../contracts/v2/catalog.ts";
import { DetailsState } from "./detailsState.ts";
import { freshPlayPosition } from "./playbackPreparation.ts";
import { SeriesEpisodes } from "./seriesEpisodes.ts";
import { CardActions } from "./cardActions.ts";
import { Synopsis } from "./browseDetails.ts";
import type { ConnectedServer } from "../session/core.ts";
import type { PublicStorage } from "../session/deviceIdentity.ts";
import { Skyline } from "./skyline.ts";
import { decodeImageCapabilities, type ImageCapabilities, homeArtworkQuery } from "../contracts/v2/images.ts";
import { FocusHost, type FocusTarget } from "./browseFocus.ts";
import { type Destination, type PlayRequest, destinationOf, playChoices, visibleLibraries } from "./browseModel.ts";
import { errorState, unconfirmedWriteMessage, writeFailureMessage, writeMayHaveApplied, failureText, hasData, newPages, newRoute, PAGE_SIZE, type Pages, type Route, routeView } from "./browseRoutes.ts";
import { homeRows, type ViewContext } from "./browseViews.ts";
import { HomeEnrichment } from "./homeEnrichment.ts";
import { el } from "./screen.ts";
import { discoveryState, genreGroups, libraryScope, librarySectionQuery, readDiscovery, type LibraryMode } from "./libraryDiscovery.ts";
import { availableModes } from "./libraryDiscoveryViews.ts";
import { personalListCapability, readPersonalPage, type PersonalFilter } from "./personalLists.ts";
import type { MediaScope } from "../contracts/v2/discovery.ts";
import type { CatalogQueryRequest } from "../contracts/v2/discovery.ts";
import { personQuery } from "./personFilmography.ts";
import { mountSettings, type SettingsScreen } from "./settings.ts";
import type { CardOverlayPrefs } from "./cardOverlays.ts";
import { PresentationSettings } from "./presentationSettings.ts";
import { NavigationSettings } from "./navigationSettings.ts";
import { cachedBranding } from "./brandingCache.ts";
import { getCalendar } from "../api/calendarOperations.ts";
import { calendarEventKeys, calendarState, calendarWeek, CalendarTimezoneError, deviceTimezone, localDateKey, shiftDay } from "./calendarState.ts";
import type { CalendarHandlers } from "./calendarView.ts";
import { isSectionRoute, SectionCatalog, type SectionRoute } from "./sectionCatalog.ts";
import { readSectionCatalog } from "./sectionCatalogState.ts";
import { BrowsePrefs, browseQuery } from "./libraryBrowse.ts";
import { stopFeed } from "./catalogFeed.ts";
import type { BrowseChange, DiscoveryState } from "./libraryDiscovery.ts";
import { shufflePick } from "../player/nextShuffle.ts";
import type { ShuffleCapability } from "../contracts/v2/shuffle.ts";

export type { PlayRequest } from "./browseModel.ts";

export interface BrowseOptions {
    /** Signed in, with a profile selected (and its PIN verified when it has one). */
    readonly server: ConnectedServer;
    /** Browse hides itself and ignores keys until `resumeAfterPlayback`. */
    readonly onPlay: (request: PlayRequest) => void;
    /** The person asked for the profile screens; browse has already removed itself. */
    readonly onChooseProfile: () => void;
    readonly onSignOut?: () => void;
    readonly onSwitchServer?: () => void;
    readonly profileName?: string;
    readonly profileAvatarUrl?: string;
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
const SEARCH_TITLE_COLLAPSE_OFFSET = 85;
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
    const sectionCatalogs = new WeakMap<SectionRoute, SectionCatalog>();
    let activeSection: SectionCatalog | undefined;
    let activeBrowse: Pages | undefined;
    const browsePrefs = new BrowsePrefs(options.publicStorage, `silo.browse:${JSON.stringify([server.server.serverId, session.activeProfile.id])}`);
    const navigation = new NavigationSettings((spec, signal) => session.call({ ...spec, profileScoped: true, signal }), () => {
        if (torn) return;
        const focus = host.focused();
        shell.setMenu(navigation.value);
        render(focus);
    });
    const sectionCatalog = (route: SectionRoute): SectionCatalog => {
        let catalog = sectionCatalogs.get(route);
        if (catalog === undefined) { catalog = new SectionCatalog(); sectionCatalogs.set(route, catalog); }
        return catalog;
    };
    // Title art and poster badges: Home renders at once and redraws as each answer lands.
    const presentation = new PresentationSettings(session, () => {
        if (torn) return;
        if (shownTitleArt !== presentation.showsTitleArt) { shownTitleArt = presentation.showsTitleArt; shell.repaint(); }
        const resized = shownScale !== presentation.posterScale;
        if (resized) { shownScale = presentation.posterScale; applyCardSize(); }
        const current = top();
        if (!playing && current !== undefined && (current.kind === "home" || current.kind === "for_you" || current.kind === "search" || current.kind === "recommendationSection" || isSectionRoute(current) || (current.kind === "library" && (current.discovery?.mode === "Browse" || current.discovery?.mode === "Recommended"))) && (resized || shownOverlays !== presentation.cardOverlays)) {
            shownOverlays = presentation.cardOverlays;
            render(host.focused());
            if (resized) host.revealFocused();
        }
    }, options.publicStorage, `silo.titleArt:${JSON.stringify([server.server.serverId, session.activeProfile.id])}`);
    let shownTitleArt = presentation.showsTitleArt;
    let shownScale = presentation.posterScale;
    const applyCardSize = (): void => {
        const scale = presentation.posterScale;
        container.style.setProperty("--poster-scale", String(scale));
    };
    applyCardSize();
    let shownOverlays: CardOverlayPrefs | undefined = presentation.cardOverlays;
    const previews = new WeakMap<Route, () => void>();
    const context: ViewContext = { baseUrl: server.server.http.base.baseUrl, cardOverlays: () => presentation.cardOverlays, posterScale: () => presentation.posterScale, savedFileOverlay: card => homeDetails.savedFile(card)?.overlay, open: (destination) => open(destination), preview: (card, row, continuing) => {
        const current = top();
        const preview = (): void => shell.preview(card, row, continuing);
        if (current !== undefined) previews.set(current, preview);
        preview();
    }, resume: (id, title) => {
        if (!torn && !playing && top()?.kind !== "resume") push(newRoute({ kind: "resume", id, title }));
    }, playEpisode: (id, title, startOver) => {
        if (!torn && !playing && top()?.kind !== "resume") push(newRoute({ kind: "resume", id, title, episode: true, startOver: startOver === true }));
    }, quickActions: card => {
        const current = top();
        if (current === undefined || torn || playing || cardActions.active) return;
        shuffleGeneration++;
        activeSection?.stop();
        if (activeBrowse !== undefined) stopFeed(activeBrowse);
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
    input.placeholder = "Search movies and series...";
    input.setAttribute("data-focus", "query");
    const searchLabel = el("label", "browse-label", "Search titles");
    searchLabel.htmlFor = input.id;
    // Kept across renders so the field, and the TV keyboard open on it, are never detached.
    const searchField = el("div", "search-field");
    const searchIcon = el("span", "search-field-icon");
    searchIcon.setAttribute("aria-hidden", "true");
    searchIcon.innerHTML = '<svg viewBox="0 0 48 48" fill="none"><circle cx="20" cy="20" r="15" stroke="currentColor" stroke-width="5"/><path d="m31 31 12 12" stroke="currentColor" stroke-width="6" stroke-linecap="round"/></svg>';
    searchField.append(searchIcon, input);
    const searchHead = [el("h1", "browse-title search-navigation-title", "Search"), searchLabel, searchField];
    container.addEventListener("scroll", () => { container.classList.toggle("search-scrolled", container.scrollTop >= SEARCH_TITLE_COLLAPSE_OFFSET); });

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
    }, personalPending, card => open({ kind: "item", id: card.id, title: card.title }));
    const synopsis = new Synopsis(container, () => {
        const current = top();
        const more = (current?.kind === "item" || current?.kind === "season") && current.data?.details?.panel === "more";
        render({ zone: more ? "more" : "actions", key: "synopsis" });
    });
    const stopDetails = (): void => { synopsis.destroy(); detailWork?.stop(); detailWork = undefined; };
    let inputRevision = 0;
    const recordInput = (): void => { inputRevision++; container.classList.remove("search-restored"); };
    document.addEventListener("keydown", recordInput, true);
    document.addEventListener("pointerdown", recordInput, true);

    const top = (): Route | undefined => stack[stack.length - 1];
    let requestsCapability: RequestsCapability = { enabled: false, follow: false };
    let searchPeopleController: AbortController | undefined;
    let searchRequestsController: AbortController | undefined;
    const acceptRequestsCapability = (capability: RequestsCapability): void => {
        requestsCapability = capability;
        if (capability.enabled) return;
        searchRequestsController?.abort();
        for (const route of new Set([...roots.values(), ...stack])) {
            if (route.kind === "search" && route.supplement !== undefined) { route.supplement.requests = []; route.supplement.requestsFor = undefined; }
        }
    };
    const stopSearchSupplement = (): void => {
        searchPeopleController?.abort(); searchPeopleController = undefined;
        searchRequestsController?.abort(); searchRequestsController = undefined;
    };
    const searchRequests = (current: Extract<Route, { kind: "search" }>): void => {
        const query = current.query.trim();
        const supplement = current.supplement ??= {};
        if (!requestsCapability.enabled || query.length <= 1 || supplement.requestsFor === query) return;
        searchRequestsController?.abort();
        const controller = new AbortController(); searchRequestsController = controller;
        supplement.requestsFor = query;
        controller.signal.onabort = () => { supplement.requestsFor = undefined; };
        const owns = (): boolean => !torn && !controller.signal.aborted && top() === current && current.supplement === supplement && current.query.trim() === query;
        void read(requestOperations.search(query, 1), controller.signal).then(page => {
            if (!owns()) return;
            searchRequestsController = undefined;
            supplement.requests = page.results.filter(title => ["movie", "series"].includes(title.mediaType) && title.availability !== "available").slice(0, 12);
            render(host.focused());
        }, (error: unknown) => {
            if (!owns()) return;
            searchRequestsController = undefined;
            supplement.requestsFor = undefined; supplement.requests = [];
            render(host.focused());
            if (error instanceof ApiError && ["capability_disabled", "capability_not_configured", "capability_unsupported", "permission_denied"].includes(error.problemId ?? "")) void probeRequests(false);
        });
    };
    const searchPeople = (current: Extract<Route, { kind: "search" }>, type: "movie" | "series" | "video" | "video_with_episodes"): void => {
        searchPeopleController?.abort();
        const supplement = current.supplement ??= {};
        supplement.people = []; supplement.peopleFailure = false;
        if (!current.peopleSupported) { supplement.peoplePending = false; return; }
        const query = current.query;
        const controller = new AbortController(); searchPeopleController = controller;
        supplement.peoplePending = true;
        const owns = (): boolean => !torn && !controller.signal.aborted && top() === current && current.supplement === supplement && current.query === query;
        void read(detailOperations.people(query.trim(), type), controller.signal).then(people => {
            if (!owns()) return;
            supplement.people = people; supplement.peoplePending = false; render(host.focused());
        }, () => {
            if (!owns()) return;
            supplement.peoplePending = false; supplement.peopleFailure = true; render(host.focused());
        });
    };
    let probeOrdinal = 0;
    let requestWritePending = false;
    let shuffleCapability: ShuffleCapability = { usable: false, scopeKinds: [] };
    let shuffleProbe: Promise<void> | undefined;
    let shuffleStarting = false;
    // A retained route can return after another view has owned the screen.
    let shuffleGeneration = 0;
    let shuffleFailure: { route: Route; text: string } | undefined;
    const requestsController = new AbortController();
    const probeShuffles = (): Promise<void> => shuffleProbe ??= session.call({ ...operations.shuffleCapabilities(), profileScoped: true, signal: requestsController.signal }).then(capability => {
        if (torn) return;
        shuffleCapability = capability;
        const current = top();
        if (current?.kind === "library" && current.discovery?.mode === "Browse" && !playing) render(host.focused());
    }, () => undefined);
    const startShuffle = (current: Extract<Route, { kind: "library" }>): void => {
        if (torn || playing || top() !== current || shuffleStarting || !canShuffle(current)) return;
        const discovery = current.discovery, generation = shuffleGeneration;
        shuffleStarting = true; shuffleFailure = undefined;
        render({ zone: "controls", key: "shuffle" });
        const owns = (): boolean => !torn && !playing && generation === shuffleGeneration && top() === current && current.discovery === discovery && discovery?.mode === "Browse";
        void (async () => {
            try {
                const shuffle = await session.call({ ...operations.createShuffle(current.library.id), profileScoped: true, replayAfterRefresh: false, signal: requestsController.signal });
                if (!owns()) return;
                const request = await shufflePick(spec => read(spec, requestsController.signal), shuffle);
                if (!owns()) return;
                if (request === undefined) { shuffleFailure = { route: current, text: "Nothing here can be played." }; return; }
                play(request);
            } catch (error) {
                if (owns() && !(error instanceof ApiError && error.aborted)) shuffleFailure = { route: current, text: error instanceof ApiError && error.status === 404 ? "This is no longer available to shuffle." : "Couldn't start the shuffle. Try again." };
            } finally {
                shuffleStarting = false;
                if (owns()) render(host.focused());
            }
        })();
    };
    const canShuffle = (route: Extract<Route, { kind: "library" }>): boolean => {
        const original = home.kind === "home" ? home.data?.libraries.find(library => library.id === route.library.id) : undefined;
        return shuffleCapability.usable && shuffleCapability.scopeKinds.includes("library") && (original?.type !== "mixed" || route.library.type === "mixed");
    };
    const probeRequests = async (refreshSearch = true): Promise<void> => {
        const ordinal = ++probeOrdinal;
        try {
            const capability = await session.call({ ...requestOperations.status(), profileScoped: true, signal: requestsController.signal });
            if (torn || ordinal !== probeOrdinal) return;
            acceptRequestsCapability(capability);
            const searchRoute = top();
            if (refreshSearch && capability.enabled && searchRoute?.kind === "search") searchRequests(searchRoute);
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
    // Artwork sizing (Apple ImageSizeCapability): one probe per Browse. The last answer for this
    // server is remembered so Home does not wait for it; a failed probe leaves per-slot widths off.
    const imageKey = `silo.imageCapability:${server.server.serverId}`;
    let imageCapability: ImageCapabilities | undefined;
    try { imageCapability = rememberedImages(options.publicStorage?.getItem(imageKey)); }
    catch { /* Missing optional cache data leaves the capability probe in charge. */ }
    let imageProbe: Promise<ImageCapabilities | undefined> | undefined;
    let homeArtworkAttempt: Readonly<Record<string, string>> | undefined;
    const libraryArtworkAttempts = new WeakMap<Route, Readonly<Record<string, string>>>();
    function upgradeLibraryArtwork(): void {
        const current = top();
        if (current?.kind !== "library" || current.discovery?.mode !== "Recommended" || current.discovery.data === undefined || torn || playing || cardActions.active || loading !== undefined || current.failure !== undefined) return;
        const attempt = libraryArtworkAttempts.get(current);
        const query = homeArtworkQuery(imageCapability, window.devicePixelRatio);
        if (attempt === undefined || !Object.entries(query).some(([key, value]) => attempt[key] !== value)) return;
        load(current, signal => read(operations.listLibrarySections(current.library.id, query), signal).catch((error: unknown) => {
            if (error instanceof ApiError && !error.aborted) return undefined;
            throw error;
        }), sections => {
            libraryArtworkAttempts.set(current, query);
            const state = current.discovery;
            if (sections !== undefined && state?.mode === "Recommended" && state.data !== undefined) {
                const artwork = new Map(sections.map(section => [section.id, new Map(section.items.map(card => [card.id, card]))]));
                state.data = { ...state.data, sections: state.data.sections.map(section => ({ ...section, items: section.items.map(card => {
                    const sized = artwork.get(section.id)?.get(card.id);
                    return sized === undefined ? card : { ...card,
                        posterUrl: sized.posterUrl ?? card.posterUrl,
                        backdropUrl: sized.backdropUrl ?? card.backdropUrl,
                        backdropThumbhash: sized.backdropThumbhash ?? card.backdropThumbhash,
                        seriesBackdropUrl: sized.seriesBackdropUrl ?? card.seriesBackdropUrl,
                        logoUrl: sized.logoUrl ?? card.logoUrl,
                    };
                }) })) };
            }
            return host.focused();
        }, true);
    }
    function upgradeHomeArtwork(): void {
        if (home.kind !== "home") return;
        const data = home.data;
        if (torn || playing || cardActions.active || top() !== home || loading !== undefined || data === undefined || home.failure !== undefined || homeArtworkAttempt === undefined) return;
        const query = homeArtworkQuery(imageCapability, window.devicePixelRatio);
        if (!Object.entries(query).some(([key, value]) => homeArtworkAttempt?.[key] !== value)) return;
        load(home, signal => read(operations.listHomeSections(query), signal).catch((error: unknown) => {
            if (error instanceof ApiError && !error.aborted) return undefined;
            throw error;
        }), sections => {
            homeArtworkAttempt = query;
            if (sections !== undefined) {
                const artwork = new Map(sections.map(section => [section.id, new Map(section.items.map(card => [card.id, card]))]));
                home.data = { ...data, sections: data.sections.map(section => ({ ...section, items: section.items.map(card => {
                    const sized = artwork.get(section.id)?.get(card.id);
                    return sized === undefined ? card : { ...card,
                        posterUrl: sized.posterUrl ?? card.posterUrl,
                        backdropUrl: sized.backdropUrl ?? card.backdropUrl,
                        backdropThumbhash: sized.backdropThumbhash ?? card.backdropThumbhash,
                        seriesBackdropUrl: sized.seriesBackdropUrl ?? card.seriesBackdropUrl,
                        logoUrl: sized.logoUrl ?? card.logoUrl,
                    };
                }) })) };
            }
            return host.focused();
        }, true);
    }
    const probeImages = (): Promise<ImageCapabilities | undefined> => imageProbe ??= session.call({ ...operations.imageCapabilities(), profileScoped: true, signal: requestsController.signal }).then(found => {
        if (torn) return undefined;
        imageCapability = found;
        try { options.publicStorage?.setItem(imageKey, JSON.stringify({ state: found.state, param: found.param, sizes: found.sizes, slot_width_params: found.slotWidthParams })); }
        catch { /* Cache persistence cannot turn a successful capability probe into a failure. */ }
        upgradeHomeArtwork();
        upgradeLibraryArtwork();
        return found;
    }, () => undefined);
    void probeImages();
    const requestsVisibility = (): void => { if (!document.hidden) void probeRequests(); };
    document.addEventListener("visibilitychange", requestsVisibility);

    const teardown = (): void => {
        if (torn) {
            return;
        }
        torn = true;
        stopSearchSupplement();
        presentation.stop();
        activeSection?.stop();
        if (activeBrowse !== undefined) stopFeed(activeBrowse);
        homeDetails.stop();
        navigation.destroy();
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
        const enterResults = !quiet && (current.kind === "personal" || current.kind === "personFilmography" || (current.kind === "requests" && current.requests.data === undefined && current.requests.source.kind !== "search") || (current.kind === "library" && host.focused()?.key !== "sort"));
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
                if (current.kind === "calendar") current.calendar.error = error instanceof CalendarTimezoneError ? { headline: "Something went wrong", message: error.message, signIn: false } : errorState(error);
                if (current.kind === "requests") { current.requests.error = errorState(error); if (!current.requests.unconfirmed && !current.requests.writing) current.requests.action = undefined; }
                if (current.kind === "requests" && error instanceof ApiError && ["capability_disabled", "capability_not_configured", "capability_unsupported", "permission_denied"].includes(error.problemId ?? "")) void probeRequests();
                if (top() === current) {
                    render();
                }
            },
        );
    };

    const read = <T>(spec: RequestSpec<T>, signal: AbortSignal): Promise<T> => session.call({ ...spec, profileScoped: true, signal });
    // Detail fields Home shows but its rows lack, read once per Home load and never on focus.
    const homeDetails = new HomeEnrichment(read, id => { if (!torn) shell.refreshDetails(id); }, () => {
        // Continue Watching cards redraw once with saved-file badges, keeping focus where it is.
        const current = top();
        if (!torn && !playing && current !== undefined && (current.kind === "home" || isSectionRoute(current) || (current.kind === "library" && current.discovery?.mode === "Recommended")) && presentation.cardOverlays !== undefined) {
            activeSection?.invalidate();
            render(host.focused());
        }
    });

    const invalidateCalendar = (): void => {
        const calendar = roots.get("calendar");
        if (calendar !== undefined) calendar.stale = true;
    };

    const detailsChanged = (current: Route, returnKey?: string): void => {
        if (current.kind === "item" || current.kind === "season") {
            const changes = current.data?.details?.changes;
            if (changes !== undefined && [...changes.values()].some(change => change.pending)) {
                invalidateCalendar();
                for (const entry of new Set([...roots.values(), ...stack])) {
                    if (entry.kind === "library" && entry.discovery?.mode === "Browse") entry.stale = true;
                }
            }
        }
        if ((current.kind === "item" || current.kind === "season") && current.data?.details?.changes.get("watched")?.pending) {
            invalidateWatched(current, current.data.details.detail);
        }
        if (top() === current) {
            if (cardActions.active) cardActions.render();
            else render(returnKey === undefined ? undefined : { zone: returnKey === "rate" ? "more" : "actions", key: returnKey });
        }
    };

    const invalidateWatched = (current: Route, detail: ItemDetail): void => {
        // Even a lost or cancelled answer may have committed; reread covered routes on return.
        current.stale = true;
        const seriesId = detail.type === "series" ? detail.id : detail.seriesId;
        for (const entry of new Set([...roots.values(), ...stack])) {
            if (entry === current) continue;
            if (entry.kind === "home" || entry.kind === "for_you" || entry.kind === "recommendationSection" || isSectionRoute(entry) || entry.kind === "calendar" || (entry.kind === "library" && entry.discovery?.mode === "Browse")) entry.stale = true;
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
        if (current.kind === "item" && current.data?.details?.series !== undefined) {
            const series = current.data.details.series;
            const season = series.seasonNumber;
            if (season !== undefined) {
                const episodes = await read(operations.listSeasonEpisodes(current.id, season), signal);
                if (signal.aborted || top() !== current) return;
                series.replace(season, episodes);
            }
        }
        current.stale = false;
    };

    const loadSection = (current: Route, quiet: boolean, append = false): boolean => {
        if (!isSectionRoute(current)) return false;
        const catalog = sectionCatalog(current);
        const mediaType = current.kind === "homeSection" ? undefined : libraryScope(current.library).type;
        // Section order is server-owned; this source rejects type and sort overlays.
        const query: CatalogQueryRequest = current.kind === "homeSection"
            ? { source: "section", scope: "home", section_id: current.id }
            : librarySectionQuery(current.library.id, current.source.id);
        load(current, signal => readSectionCatalog(catalog.snapshot, append, async (cursor, limit) => {
            const page = await read(operations.queryCatalogItems({ ...query, limit, ...(cursor === undefined ? {} : { cursor }) }), signal);
            const items = page.items.filter(card => destinationOf(card) !== undefined && (mediaType === undefined || mediaType === "video" || mediaType === card.type || (mediaType === "series" && card.type === "episode")));
            return { ...page, items, totalExact: page.totalExact && items.length === page.items.length };
        }, signal), snapshot => {
            catalog.snapshot = snapshot;
            current.pages.page = snapshot.page;
            return host.focused() ?? current.focus;
        }, quiet);
        render(host.focused());
        return true;
    };

    const loadBrowse = (current: Extract<Route, { kind: "library" }>, quiet = false, append = false): void => {
        const state = current.discovery;
        if (state === undefined || state.mode !== "Browse") return;
        void probeShuffles();
        if (!state.facetsRequested) {
            state.filter = browsePrefs.saved(current.library) ?? state.filter;
            state.facetsRequested = true;
            if (state.capabilities === undefined) void session.call({ ...operations.getCatalogSearchCapabilities(), profileScoped: true, signal: requestsController.signal }).then(capabilities => {
                if (torn || current.discovery !== state) return;
                state.capabilities = capabilities;
                if (state.data !== undefined) state.data = { ...state.data, capabilities };
                if (!playing && top() === current) render(host.focused());
            }, () => undefined);
            void session.call({ ...operations.getCatalogFilters({ library_id: current.library.id }), profileScoped: true, signal: requestsController.signal }).then(filters => {
                if (torn || current.discovery !== state) return;
                state.facets = filters;
                if (state.data !== undefined) state.data = { ...state.data, filters };
                if (!playing && top() === current) render(host.focused());
            }, () => undefined);
        }
        const query = browseQuery(state.filter, current.library, 100);
        load(current, async signal => {
            const snapshot = await readSectionCatalog(state.snapshot, append, async cursor => read(operations.queryCatalogItems({ ...query, ...(cursor === undefined ? {} : { cursor }) }), signal), signal);
            if (snapshot.unavailable) throw new ApiError({ kind: "http", status: 404, retryAfterSeconds: undefined });
            let emptyReason: DiscoveryState["emptyReason"] = "libraryEmpty";
            if (snapshot.page.items.length === 0 && (query.groups !== undefined || query.name_prefix !== undefined)) {
                const probe = await read(operations.queryCatalogItems({ ...libraryScope(current.library), limit: 1 }), signal);
                if (probe.items.length > 0) emptyReason = "noFilterMatches";
            }
            return { snapshot, emptyReason };
        }, result => {
            state.snapshot = result.snapshot; state.emptyReason = result.emptyReason;
            state.data = { capabilities: state.capabilities, sections: [], collections: undefined, filters: state.facets, letters: undefined };
            current.pages.page = result.snapshot.page;
            return host.focused() ?? current.focus;
        }, quiet);
        render(host.focused());
    };
    const moreBrowse = (current: Extract<Route, { kind: "library" }>): void => {
        if (torn || playing || top() !== current || loading !== undefined || cardActions.active || synopsis.active || settingsScreen !== undefined || current.discovery?.panel !== undefined || shuffleFailure?.route === current || current.failure !== undefined || current.discovery?.snapshot?.page.nextCursor === undefined) return;
        loadBrowse(current, true, true);
    };
    const changeBrowse = (current: Extract<Route, { kind: "library" }>, change: BrowseChange): void => {
        const state = current.discovery;
        if (torn || playing || top() !== current || state?.mode !== "Browse") return;
        if (change.preserve !== undefined) { browsePrefs.setPreserve(current.library, change.preserve); if (change.preserve) browsePrefs.save(current.library, state.filter); }
        if ("panel" in change) state.panel = change.panel;
        if (change.filter !== undefined) {
            const changed = JSON.stringify(browseQuery(change.filter, current.library, 100)) !== JSON.stringify(browseQuery(state.filter, current.library, 100));
            state.filter = change.filter;
            browsePrefs.save(current.library, state.filter);
            if (changed) {
                state.snapshot = undefined; current.pages = newPages(); current.failure = undefined;
                loadBrowse(current, true);
            }
        }
        render(change.focus ?? host.focused());
    };

    // Apple's hub sends each read once (RequestsHubViewModel.load); Try Again is its retry.
    const once = <T>(spec: RequestSpec<T>): RequestSpec<T> => ({ ...spec, retry: "never" });
    const readMyRequests = async (signal: AbortSignal): Promise<MyRequests> => {
        const maxPages = 100, pageSize = 50;
        const items: MediaRequest[] = [], cursors = new Set<string>();
        let cursor: string | undefined;
        for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
            signal.throwIfAborted();
            const page = await read(once(requestOperations.mine(cursor, pageSize)), signal);
            signal.throwIfAborted();
            items.push(...page.items);
            if (page.cursor === undefined) return { items, cursor: undefined };
            if (cursors.has(page.cursor)) throw new WireError("requests.mine.page.next_cursor", "an advancing cursor");
            cursors.add(page.cursor); cursor = page.cursor;
        }
        throw new WireError("requests.mine.page", `a list of at most ${maxPages} pages`);
    };

    const loadRoute = (current: Route, quiet = false): void => {
        if (loadSection(current, quiet)) return;
        if (current.kind === "library" && current.discovery?.mode === "Browse") { loadBrowse(current, quiet); return; }
        switch (current.kind) {
            case "requests": {
                presentation.ensure();
                const state = current.requests, source = state.source;
                const capabilityOrdinal = ++probeOrdinal;
                const entryRevision = inputRevision;
                load(current, async signal => {
                    const capability = await read(source.kind === "hub" ? once(requestOperations.status()) : requestOperations.status(), signal);
                    if (!capability.enabled) return { capability, data: undefined, detail: undefined, detailFailed: false };
                    const hub = source.kind === "hub" ? await Promise.allSettled([read(once(requestOperations.discover()), signal), readMyRequests(signal)]) : undefined;
                    const isRefusal = (error: unknown): boolean => error instanceof ApiError && ["capability_disabled", "capability_not_configured", "capability_unsupported", "permission_denied"].includes(error.problemId ?? "");
                    for (const result of hub ?? []) if (result.status === "rejected" && isRefusal(result.reason)) throw result.reason;
                    // Apple's hub reads both together: either failing fails the load (RequestsHubViewModel.load).
                    const answered = <T>(result: PromiseSettledResult<T>): T => { if (result.status === "rejected") throw result.reason; return result.value; };
                    const data = hub !== undefined ? { sections: answered(hub[0]), mine: answered(hub[1]) }
                        : source.kind === "mine" ? await read(requestOperations.mine(source.cursor), signal)
                        : source.kind === "media" ? await read(requestOperations.detail(source.title), signal)
                        : source.kind === "request" ? await read(requestOperations.request(source.id), signal)
                        : source.kind !== "search" || source.query.trim() === "" ? undefined : await read(requestOperations.search(source.query.trim(), source.page), signal);
                    let detail: import("../contracts/v2/requests.ts").RequestTitle | undefined;
                    let detailFailed = false;
                    if (source.kind === "request" && data !== undefined && "tmdbId" in data) {
                        try { detail = await read(requestOperations.detail(data), signal); }
                        catch (error) { if (isRefusal(error)) throw error; detailFailed = true; }
                    }
                    return { capability, data, detail, detailFailed };
                }, result => {
                    if (capabilityOrdinal === probeOrdinal) {
                        acceptRequestsCapability(result.capability);
                        shell.setRequestsEnabled(result.capability.enabled);
                    }
                    if (!requestsCapability.enabled) { roots.delete("requests"); stack = [home]; showRoute(home, { zone: "nav", key: "home" }); return; }
                    state.data = result.data;
                    state.detail = result.detail;
                    state.detailFailed = result.detailFailed;
                    state.uncertain = false;
                    // The server's answer now decides the action (RequestDetailViewModel.swift:250).
                    if (!state.writing) { state.action = undefined; if (state.unconfirmed) state.actionMessage = undefined; state.unconfirmed = false; }
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
                    if (detail.id !== current.id || (detail.type !== "movie" && detail.type !== "episode") || (current.episode === true && detail.type !== "episode")) throw new ApiError({ kind: "invalid_response", path: "resume.item" });
                    const choices = playChoices(detail);
                    if (choices === undefined) return undefined;
                    let request = current.startOver === true ? choices.fromStart : choices.resume ?? choices.fromStart;
                    if (detail.type === "episode") request = { ...request, subtitle: { kind: "auto" } };
                    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
                    return detail.type === "episode" && current.startOver !== true ? { ...request, startSeconds: await freshPlayPosition(session, request, clock, signal) } : request;
                }, request => {
                    if (request === undefined) { current.failure = "No playable version is available for this title."; return; }
                    // Discard the resolution route before handing off so returning cannot replay it.
                    stack.pop();
                    render(top()?.focus);
                    handoff(request);
                });
                return;
            case "homeSection":
            case "personFilmography":
                loadPage(current, current.pages, current.pendingIndex ?? current.pages.index, quiet);
                return;
            case "personal":
                loadPage(current, current.pages, current.pendingIndex ?? current.pages.index, quiet);
                return;
            case "for_you":
                presentation.ensure();
                load(current, signal => read(operations.recommendations(homeArtworkQuery(imageCapability, window.devicePixelRatio)), signal), sections => {
                    current.data = sections;
                    homeDetails.load(homeRows(sections).flatMap(row => row.cards.map(card => ({ card, continuing: false }))));
                }, quiet);
                return;
            case "recommendationSection":
                load(current, signal => read(operations.recommendationSection(current.locator), signal), row => {
                    current.pages.page = { items: row.items.filter(card => destinationOf(card) !== undefined), total: row.items.length, totalExact: false, nextCursor: undefined };
                }, quiet);
                return;
            case "home": {
                presentation.ensure();
                const artworkQuery = homeArtworkQuery(imageCapability, window.devicePixelRatio);
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
                    read(operations.listHomeSections(artworkQuery), signal),
                ]), ([libraries, hidden, sections]) => {
                    const focus = host.focused();
                    current.data = { libraries: visibleLibraries(libraries, hidden), sections };
                    homeArtworkAttempt = artworkQuery;
                    shell.update(current.data.libraries);
                    homeDetails.load(homeRows(sections).flatMap(row => row.cards.map(card => ({ card, continuing: row.continuing }))));
                    // Changed tabs replace the nav nodes, including the still-present avatar.
                    queueMicrotask(upgradeHomeArtwork);
                    return quiet || focus?.zone === "nav" ? focus : undefined;
                }, quiet);
                return;
            }
            case "library":
                if (current.library.type === "music") return;
                current.discovery ??= discoveryState();
                if (current.discovery.mode === "Recommended") presentation.ensure();
                if (current.discovery.data !== undefined && (current.discovery.mode === "Recently Added" || current.discovery.mode === "A–Z" || current.discovery.genre !== undefined)) {
                    loadPage(current, current.pages, current.pages.index, quiet);
                    return;
                }
                load(current, async signal => {
                    const state = current.discovery ?? discoveryState();
                    const artworkQuery = homeArtworkQuery(imageCapability, window.devicePixelRatio);
                    const data = await readDiscovery(current.library, state.mode, spec => read(spec, signal), artworkQuery);
                    const page = (state.mode === "Recently Added" || state.mode === "A–Z") && data.capabilities?.allowed === true
                        ? await read(operations.queryCatalogItems({ ...libraryScope(current.library), limit: PAGE_SIZE, sort: state.mode === "Recently Added" ? "added_at" : "title", order: state.mode === "Recently Added" ? "desc" : "asc" }), signal) : undefined;
                    return { data, page, artworkQuery };
                }, ({ data, page, artworkQuery }) => {
                    if (current.discovery !== undefined) {
                        current.discovery.data = data;
                        current.discovery.capabilities = data.capabilities;
                        shell.setLibraryModes(availableModes(data.capabilities));
                        if (current.discovery.mode === "Recommended") {
                            libraryArtworkAttempts.set(current, artworkQuery);
                            homeDetails.load(homeRows(data.sections.filter(section => section.featured !== true)).flatMap(row => row.cards.map(card => ({ card, continuing: row.continuing }))));
                            queueMicrotask(upgradeLibraryArtwork);
                        }
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
                    // Slots follow response fields: backdrop_width also sizes a still returned in backdrop_url.
                    const detail = await read(operations.getCatalogItem(current.id, imageCapability?.state === "available" ? homeArtworkQuery(imageCapability, window.devicePixelRatio) : {}), signal);
                    const seasons = detail.type === "series" ? await read(operations.listSeriesSeasons(detail.id), signal) : [];
                    const episodeId = current.seriesContext?.episodeId;
                    const episode = detail.type === "series" && current.seriesContext?.seasonNumber === undefined && episodeId !== undefined
                        ? await read(operations.getCatalogItem(episodeId), signal).catch((error: unknown) => { if (error instanceof ApiError && error.status === 404) return undefined; throw error; }) : undefined;
                    return { detail, seasons, contextSeason: current.seriesContext?.seasonNumber ?? (episode?.seriesId === detail.id ? episode.seasonNumber : undefined) };
                }, (data) => {
                    const previous = current.data?.details;
                    const details = new DetailsState(data.detail, session, (audioClosed) => detailsChanged(current, audioClosed), (detail, signal) => refreshWatched(current, detail, signal), personalPending);
                    details.restore(previous);
                    if (data.detail.type === "series") details.series = new SeriesEpisodes(session, data.detail.id, data.seasons, () => detailsChanged(current), previous?.series?.seasonNumber ?? data.contextSeason, current.seriesContext?.episodeId);
                    details.series?.restore(previous?.series);
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
                if (current.kind === "libraryResults" && current.source.kind === "section") {
                    return read(operations.queryCatalogItems({ ...librarySectionQuery(current.library.id, current.source.id), limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) }), signal);
                }
                if (current.kind === "libraryResults" && current.source.kind === "collection" && current.source.groupKind === "admin") return read(operations.getLibraryCollectionItems(current.library.id, current.source.id, { limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) }), signal);
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
                    current.peopleSupported = capability.allowed && capability.state === "available" && capability.peopleMediaScope === true;
                }
            }
            if (signal.aborted || top() !== current || current.query !== query) throw new DOMException("Aborted", "AbortError");
            if (current.supplement?.people === undefined) searchPeople(current, current.filter ?? type);
            return read(operations.listCatalogItems({ q: query.trim(), type: current.filter ?? type, limit: PAGE_SIZE, cursor: pages.cursors[index] }), signal);
        }, (page) => {
            pages.page = page;
            pages.index = index;
            pages.cursors = pages.cursors.slice(0, index + 1);
            pages.cursors.push(page.nextCursor);
            current.resultsFor = query;
        }, quiet || pages.page !== undefined);
    };

    let searchReturnFocus: { readonly route: Extract<Route, { kind: "search" }>; readonly target: FocusTarget } | undefined;
    const search = (current: Extract<Route, { kind: "search" }>, quiet = false): void => {
        searchReturnFocus = undefined;
        cancelSearch();
        stopSearchSupplement();
        current.supplement = {};
        searchRequests(current);
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
        searchReturnFocus = undefined;
        const current = top();
        if (current?.kind !== "search") {
            return;
        }
        loading?.abort();
        loading = undefined;
        cancelSlow();
        current.slow = false;
        current.query = input.value;
        stopSearchSupplement();
        current.supplement = {};
        render(host.focused());
        cancelSearch();
        // Only the replacement request is debounced; an obsolete read stops immediately.
        cancelSearch = clock.schedule(() => search(current), SEARCH_DELAY_MS);
    });
    input.addEventListener("blur", () => { searchReturnFocus = undefined; });
    input.addEventListener("keydown", (event) => {
        const current = top();
        // The TV keyboard's Done key, or Enter on a desktop keyboard: search now.
        if (current?.kind === "search" && (event.keyCode === 65376 || event.key === "Enter") && input.value !== "") {
            current.query = input.value;
            search(current);
        }
    });

    const pop = (): void => {
        stopSearchSupplement();
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
            container.classList.toggle("search-restored", current.kind === "search");
            if (current.kind === "personal" || current.kind === "personFilmography" || current.kind === "calendar" || current.kind === "requests") {
                if (current.kind === "personal" || current.kind === "personFilmography") current.pendingIndex = undefined;
                current.stale = true;
            }
            const fromProfileMenu = (active?.kind === "requests" && active.requests.source.kind === "hub") || (active?.kind === "personal" && active.anchor === "profiles");
            showRoute(current, fromProfileMenu ? tabFocus(current) : current.focus);
        }
    };

    const push = (next: Route, focus?: FocusTarget): void => {
        stopSearchSupplement();
        shuffleGeneration++;
        const current = top();
        const panel = (current?.kind === "item" || current?.kind === "season") ? current.data?.details?.panel : undefined;
        stopDetails();
        if (current !== undefined) {
            current.focus = panel === undefined ? host.focused() : { zone: "actions", key: panel === "rating" ? "more" : panel };
            if (current.kind === "homeSection" || current.kind === "personFilmography") current.pendingIndex = undefined;
        }
        loading?.abort();
        loading = undefined;
        cancelSearch();
        stack.push(next);
        showRoute(next, focus);
    };

    const tabFocus = (current: Route): FocusTarget => ({ zone: "nav", key: current.kind === "library" ? (current.library.type === "music" ? "music" : current.library.type === "series" ? "series" : "movies") : current.kind === "personal" ? current.anchor ?? "profiles" : current.kind });

    const showRoute = (current: Route, focus: FocusTarget | undefined): void => {
        searchReturnFocus = current.kind === "search" && focus?.zone === "search-requests" && current.supplement?.requests === undefined
            ? { route: current, target: focus } : undefined;
        if (current.kind === "calendar") {
            try { prepareCalendar(current); }
            catch (error) { current.failure = error instanceof Error ? error.message : "Could not read this TV’s timezone. Try again."; }
        }
        if (current.kind === "search") {
            input.value = current.query;
            if (current.supplement?.peoplePending && current.searchType !== undefined && current.query === current.resultsFor) searchPeople(current, current.filter ?? current.searchType);
            if (current.supplement !== undefined && current.supplement.requests === undefined) current.supplement.requestsFor = undefined;
            searchRequests(current);
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
        } else if ((current.kind === "home" || current.kind === "for_you") && current.data !== undefined) {
            const sections = current.kind === "home" ? current.data.sections : current.data;
            homeDetails.load(homeRows(sections).flatMap(row => row.cards.map(card => ({ card, continuing: current.kind === "home" && row.continuing }))));
            if (current.kind === "home") upgradeHomeArtwork();
        } else if (current.kind === "library" && current.discovery?.mode === "Recommended" && current.discovery.data !== undefined) {
            homeDetails.load(homeRows(current.discovery.data.sections.filter(section => section.featured !== true)).flatMap(row => row.cards.map(card => ({ card, continuing: row.continuing }))));
            upgradeLibraryArtwork();
        }
    };

    const open = (destination: Destination): void => {
        push(destination.kind === "item"
            ? newRoute({ kind: "item", id: destination.id, title: destination.title, ...(destination.seriesContext === undefined ? {} : { seriesContext: destination.seriesContext }), data: undefined })
            : destination.kind === "person" ? newRoute({ kind: "person", id: destination.id, title: destination.title, data: undefined })
            : newRoute({ kind: "season", ...(destination.id === undefined ? {} : { id: destination.id }), ...(destination.episodeId === undefined ? {} : { episodeId: destination.episodeId }), seriesId: destination.seriesId, seasonNumber: destination.seasonNumber, title: destination.title, data: undefined }));
    };

    const play = (request: PlayRequest): void => {
        activeSection?.stop();
        if (activeBrowse !== undefined) stopFeed(activeBrowse);
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
        stopSearchSupplement();
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
        activeSection?.stop();
        if (activeBrowse !== undefined) stopFeed(activeBrowse);
        activeSection = undefined;
        activeBrowse = undefined;
        cancelCalendarDay();
        const current = top();
        if (current === undefined || torn || playing || synopsis.active || cardActions.active || settingsScreen !== undefined) {
            return;
        }
        if (searchReturnFocus?.route === current && current.kind === "search" && current.supplement?.requests !== undefined) {
            if (current.supplement.requests.some(title => `${title.mediaType}:${title.tmdbId}` === searchReturnFocus?.target.key)) focus = searchReturnFocus.target;
            searchReturnFocus = undefined;
        }
        if (current.kind === "calendar") {
            const midnight = new Date(clock.now());
            midnight.setHours(24, 0, 0, 0);
            cancelCalendarDay = clock.schedule(() => render(host.focused()), midnight.getTime() - clock.now());
        }
        shell.setAvatar(options.profileName ?? "Profiles", options.profileAvatarUrl, context.baseUrl);
        if (current.kind === "library") shell.setLibraryModes(availableModes(current.discovery?.data?.capabilities ?? current.discovery?.capabilities));
        const searchFilter = (route: Extract<Route, { kind: "search" }>, filter: "movie" | "series" | undefined): void => {
            if (top() !== route || route.filter === filter) return;
            loading?.abort(); loading = undefined; cancelSlow();
            route.filter = filter; route.pages = undefined; search(route);
        };
        const handlers = { context, synopsis, focusDefault: () => host.focusDefault(), busy: loading !== undefined, searchHead, input, searchFilter, push, pop, play, chooseProfile, retry, turn, mode, jump, sort, genre, personalFilter, personFilter, calendar: calendarHandlers, requests: requestsHandlers, browse: changeBrowse, more: moreBrowse, preserve: (route: Extract<Route, { kind: "library" }>) => browsePrefs.preserve(route.library), gridColumns: presentation.posterScale > 1 ? 5 : 6, shuffle: current.kind === "library" && canShuffle(current) ? { starting: shuffleStarting, failure: shuffleFailure?.route === current ? shuffleFailure.text : undefined, start: startShuffle, dismiss: () => { shuffleFailure = undefined; render({ zone: "controls", key: "shuffle" }); } } : undefined };
        container.classList.toggle("section-catalog", isSectionRoute(current) || current.kind === "recommendationSection");
        const browsing = current.kind === "library" && current.discovery?.mode === "Browse";
        container.classList.toggle("library-browse", browsing);
        container.classList.toggle("requests-scene", current.kind === "requests");
        container.classList.toggle("search-scene", current.kind === "search");
        container.classList.toggle("requests-hub", current.kind === "requests" && current.requests.source.kind === "hub");
        if (browsing) activeBrowse = current.pages;
        if (isSectionRoute(current)) activeSection = sectionCatalog(current);
        const view = activeSection !== undefined && isSectionRoute(current)
            ? activeSection.view(current, context, loading !== undefined, pop, () => retry(current), () => {
                if (top() !== current || torn || playing || loading !== undefined || cardActions.active || synopsis.active || settingsScreen !== undefined || current.failure !== undefined || current.pages.page?.nextCursor === undefined) return;
                loadSection(current, true, true);
            }) : routeView(current, { ...handlers, retryPeople: route => {
                if (top() !== route || route.searchType === undefined || route.query.trim() === "") return;
                searchPeople(route, route.filter ?? route.searchType);
                render(host.focused());
            } });
        const rootRoute = current.kind === "home" || current.kind === "for_you" || current.kind === "library" || current.kind === "personal" || current.kind === "calendar";
        if (rootRoute) {
            const selected = tabFocus(current).key;
            const preview = current.kind === "home" || (current.kind === "for_you" && (current.data?.some(row => row.items.some(card => destinationOf(card) !== undefined)) ?? false)) || (current.kind === "library" && current.library.type !== "music" && (current.discovery?.mode ?? "Recommended") === "Recommended");
            const modal = browsing && (current.discovery?.panel !== undefined || shuffleFailure?.route === current);
            const decorated = shell.decorate(view, selected, preview, modal ? () => { view.back?.(); } : current.kind === "personal" || (current.kind === "library" && current.discovery?.genre !== undefined) ? pop : undefined, current.kind === "library" ? `library:${current.library.id}:${current.library.type}:${current.discovery?.mode ?? "Recommended"}` : undefined);
            // A bar-focused return does not focus a card to restore this page's hero.
            if (preview && host.name !== view.name) previews.get(current)?.();
            const nav = container.querySelector<HTMLElement>(".browse-nav");
            if (nav !== null) { nav.inert = modal || nav.inert; if (nav.inert) nav.setAttribute("aria-hidden", "true"); else nav.removeAttribute("aria-hidden"); }
            host.show({ ...decorated, ...(current.kind === "library" ? { ready: hasData(current), ...(current.discovery?.genre !== undefined ? { back: pop } : {}) } : {}), ...(modal ? { zones: view.zones, back: view.back } : {}) }, focus);
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
    const markRequestsStale = (): void => {
        searchRequestsController?.abort();
        const visible = top();
        for (const route of new Set([...roots.values(), ...stack])) {
            if (route.kind === "requests") route.stale = true;
            if (route.kind === "search" && route.supplement !== undefined) {
                if (route !== visible) route.supplement.requests = undefined;
                route.supplement.requestsFor = undefined;
            }
        }
        if (visible?.kind === "search") searchRequests(visible);
    };
    const openRequests = (source: RequestsSource): void => { if (requestsCapability.enabled) push(newRoute({ kind: "requests", requests: requestsState(source) })); };
    const requestsHandlers = (current: Extract<Route, { kind: "requests" }>): RequestsHandlers => ({
        capability: requestsCapability, busy: loading !== undefined || requestWritePending, failure: current.failure,
        profileId: session.activeProfile?.id ?? "", back: pop, signIn: options.onSignOut, open: openRequests,
        retry: () => {
            current.focus = host.focused();
            // The hub's Try Again only exists with no rows, and Apple's retry returns to the loading page.
            if (current.requests.source.kind === "hub") current.requests.data = undefined;
            retry(current);
        },
        openCatalog: (id, title) => open({ kind: "item", id, title }),
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
            else if (source.kind === "search" && typeof value === "number") source.page = value;
            else return;
            current.requests.data = undefined; current.focus = undefined; retry(current);
        },
        write: action => {
            const state = current.requests, data = state.data;
            if (top() !== current || torn || requestWritePending || state.writing || state.uncertain || loading !== undefined || data === undefined || !requestsCapability.enabled) return;
            const title = "request" in data ? data : state.detail;
            const spec = action === "cancel" && "id" in data ? requestOperations.cancel(data.id)
                : title === undefined || action === "cancel" ? undefined : action === "create" ? requestOperations.create(title) : requestOperations.follow(title, action === "follow");
            if (spec === undefined) return;
            // The ended record is no longer the page's subject: a new request belongs to the title (RequestDetailViewModel.submitRequest reloads the title).
            const followTitle = (): void => { if (action === "create" && title !== undefined && state.source.kind === "request") state.source = { kind: "media", title }; };
            requestWritePending = true; state.writing = true; state.uncertain = true; state.action = action; state.unconfirmed = false; state.actionMessage = undefined; current.failure = undefined;
            render(host.focused());
            current.focus = host.focused();
            const writeRevision = inputRevision;
            // Focus the person moved while the write was out stays where it is.
            const keepMovedFocus = (route: Route): void => { if (inputRevision !== writeRevision) route.focus = host.focused() ?? route.focus; };
            // A write belongs to session authority, not route lifetime. Leaving never replays it.
            session.call({ ...spec, profileScoped: true, replayAfterRefresh: false }).then(() => {
                requestWritePending = false; state.writing = false;
                if (torn) return;
                followTitle();
                markRequestsStale();
                const visible = top();
                if (visible?.kind === "requests") { keepMovedFocus(visible); visible.requests.uncertain = true; loadRoute(visible, true); }
                else render(host.focused());
            }, (error: unknown) => {
                requestWritePending = false; state.writing = false;
                if (torn) return;
                const unconfirmed = writeMayHaveApplied(error);
                if (unconfirmed) followTitle();
                state.uncertain = unconfirmed; state.unconfirmed = unconfirmed;
                state.actionMessage = unconfirmed ? unconfirmedWriteMessage(action) : writeFailureMessage(error);
                if (!unconfirmed) state.action = undefined;
                markRequestsStale();
                if (error instanceof ApiError && ["capability_disabled", "capability_not_configured", "capability_unsupported", "permission_denied"].includes(error.problemId ?? "")) void probeRequests();
                const visible = top();
                if (visible?.kind === "requests") keepMovedFocus(visible);
                if (visible === current) {
                    // Apple reads back an unconfirmed write, unless the answer was lost to a change of owner (RequestDetailViewModel.swift:397).
                    if (unconfirmed && !(error instanceof ApiError && error.aborted)) loadRoute(current, true);
                    render(current.focus);
                }
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
            render(value === 0 ? { zone: "days", key: `day:${state.selectedDay}` } : undefined);
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
        shuffleGeneration++;
        const current = top();
        if (current !== undefined) current.focus = host.focused();
        const key = typeof target === "string" ? target : `library:${target.id}:${target.type}`;
        let route = roots.get(key);
        if (route === undefined) {
            route = typeof target === "string"
                ? target === "for_you" ? newRoute({ kind: "for_you", data: undefined }) : target === "calendar" ? newRoute({ kind: "calendar", calendar: calendarState() }) : newRoute({ kind: "search", query: "", pages: undefined, resultsFor: "" })
                : newRoute({ kind: "library", library: target, pages: newPages() });
            roots.set(key, route);
        }
        if (route.kind === "library" && destinationMode !== undefined) {
            if (route === current && route.discovery?.mode === destinationMode && hasData(route)) { render(); host.focusDefault(); return; }
            route.discovery = { ...discoveryState(), mode: destinationMode, capabilities: route.discovery?.capabilities };
            route.pages = newPages();
        }
        if (route.kind === "search") {
            route = newRoute({ kind: "search", query: "", pages: undefined, resultsFor: "" });
            roots.set(key, route);
            push(route, { zone: "field", key: "query" });
            if (current !== undefined) current.focus = { zone: "nav", key: current.kind === "library" ? current.library.type === "music" ? "music" : current.library.type === "series" ? "series" : "movies" : current.kind === "personal" ? current.anchor ?? "profiles" : current.kind };
            return;
        }
        loading?.abort();
        loading = undefined;
        cancelSearch();
        stack = route === home ? [home] : [home, route];
        stopSearchSupplement();
        showRoute(route, route.focus?.zone === "nav" ? undefined : route.focus);
        if (hasData(route) && (route.focus === undefined || route.focus.zone === "nav")) host.focusDefault();
    }, {
        requests: () => { host.forgetVisit("requests:hub"); openRequests({ kind: "hub" }); },
        name: options.profileName ?? "Profiles",
        serverName: () => cachedBranding(options.publicStorage, context.baseUrl)?.serverName,
        settings: () => {
            stopSearchSupplement();
            shuffleGeneration++;
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
                presentation.reload();
                void navigation.reload();
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
                if (current !== undefined) showRoute(current, tabFocus(current));
            }, server.profileLaunch);
        },
        personal: (source, anchor = "profiles") => {
            const origin = top();
            push(newRoute({ kind: "personal", source, anchor, filter: "movie", pages: newPages(), capability: undefined, pendingIndex: undefined }));
            if (origin !== undefined) origin.focus = { zone: "nav", key: anchor };
        },
        switchProfile: chooseProfile,
        ...(options.onSwitchServer === undefined ? {} : { switchServer: () => { teardown(); options.onSwitchServer?.(); } }),
        ...(options.onSignOut === undefined ? {} : { signOut: options.onSignOut }),
    }, focus => render(focus), options.publicStorage, `silo.skyline.scope:${JSON.stringify([server.server.serverId, session.activeProfile.id])}`, context.baseUrl);
    shell.titleArt = () => presentation.showsTitleArt;
    const enrichedScene = (): boolean => { const current = top(); return current?.kind === "home" || current?.kind === "for_you" || (current?.kind === "library" && current.discovery?.mode === "Recommended"); };
    shell.details = (card, continuing) => !enrichedScene() ? { line: undefined, badges: undefined } : { line: homeDetails.detailLine(card.id), badges: continuing ? homeDetails.savedFile(card)?.badges : undefined };
    shell.filled = card => enrichedScene() ? homeDetails.filled(card) : card;
    shell.update([]);
    void navigation.reload();
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

function rememberedImages(raw: string | null | undefined): ImageCapabilities | undefined {
    if (raw === null || raw === undefined) return undefined;
    try { return decodeImageCapabilities(JSON.parse(raw)); } catch { return undefined; }
}
