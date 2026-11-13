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
import { browseCache } from "../session/browseCache.ts";
import type { CatalogPage } from "../contracts/v2/catalog.ts";
import { requestOperations } from "../api/requestOperations.ts";
import type { MediaRequest, MyRequests, RequestsCapability } from "../contracts/v2/requests.ts";
import { WireError, type ProfileSummary } from "../contracts/v2/wire.ts";
import { requestsState, type RequestsHandlers, type RequestsSource } from "./requests.ts";
import { canCancel, canRemove, focusAfterRemoval, REMOVE_CONFLICT_MESSAGE, REMOVED_NOTICE, RequestActionGate, REQUEST_NOTICE_MS, UNCONFIRMED_CANCEL_MESSAGE, UNCONFIRMED_REMOVE_MESSAGE, visibleMineRequests } from "./requestRemoval.ts";
import { RequestRecordMenu } from "./requestRecordMenu.ts";
import type { RequestSpec } from "../api/http.ts";
import { operations, type TextSearchScope } from "../api/operations.ts";
import { ShowAudiobooks } from "./audiobookPreference.ts";
import { detailOperations } from "../api/detailOperations.ts";
import { BOX_SET_SEARCH_LIMIT, boxSetOperations } from "../api/boxSetOperations.ts";
import { BoxSetRowState } from "./boxSetRow.ts";
import type { ItemDetail, UserLibrary } from "../contracts/v2/catalog.ts";
import { DetailsState } from "./detailsState.ts";
import { DescriptionTranslations } from "./descriptionTranslation.ts";
import { freshPlayPosition } from "./playbackPreparation.ts";
import { SeriesEpisodes } from "./seriesEpisodes.ts";
import { CardActions } from "./cardActions.ts";
import type { ConnectedServer } from "../session/core.ts";
import type { PublicStorage } from "../session/deviceIdentity.ts";
import type { TizenKeyManager } from "../session/secretStore.ts";
import { Skyline } from "./skyline.ts";
import { decodeImageCapabilities, type ImageCapabilities, homeArtworkQuery } from "../contracts/v2/images.ts";
import { FocusHost, type FocusTarget } from "./browseFocus.ts";
import { type Destination, type PlayRequest, type SearchFilter, applySeriesLine, artworkUrl, destinationOf, searchScope, seriesLineFor, playChoices, visibleLibraries, withStartAudioLanguage } from "./browseModel.ts";
import { errorState, unconfirmedWriteMessage, writeFailureMessage, writeMayHaveApplied, failureText, hasData, newPages, newRoute, PAGE_SIZE, SEARCH_PAGE_SIZE, type Pages, type Route, routeView } from "./browseRoutes.ts";
import { browsableRows, shownRows } from "./recommendationsView.ts";
import { homeRows, removingDismissed, type ViewContext } from "./browseViews.ts";
import { HomeEnrichment } from "./homeEnrichment.ts";
import { el } from "./screen.ts";
import { discoveryState, genreGroups, libraryScope, librarySectionQuery, readDiscovery, readSections, type LibraryMode, type VideoScope } from "./libraryDiscovery.ts";
import { availableModes } from "./libraryDiscoveryViews.ts";
import { personalEndCanReenter, personalListCapability, readPersonalPage, type PersonalFilter } from "./personalLists.ts";
import type { MediaScope } from "../contracts/v2/discovery.ts";
import type { CatalogQueryRequest } from "../contracts/v2/discovery.ts";
import { personQuery } from "./personFilmography.ts";
import { PersonMetadataRefresh } from "./personMetadataRefresh.ts";
import { mountSettings, type SettingsScreen } from "./settings.ts";
import { signOutRemovesServer } from "./signOutConfirmation.ts";
import type { CardOverlayPrefs } from "./cardOverlays.ts";
import { PresentationSettings } from "./presentationSettings.ts";
import { ResolutionCap } from "./resolutionCap.ts";
import { EpisodeSpoilerPreferences, type EpisodeSpoilerSettings } from "./episodeSpoilers.ts";
import { themeAudioFormats, type ThemePlayback } from "../contracts/v2/themeMusic.ts";
import { ElementThemeOutput } from "./themeAudioOutput.ts";
import { ThemeMusicCenter, ThemeMusicController, createVolumeRamp, type ThemeAudioOutput, type ThemeMusicPage } from "./themeMusic.ts";
import { ThemeMusicPreferences } from "./themeMusicPreferences.ts";
import { NavigationSettings } from "./navigationSettings.ts";
import { cachedBranding } from "./brandingCache.ts";
import { getCalendar } from "../api/calendarOperations.ts";
import { CALENDAR_FILTER_KEY, calendarEventKeys, calendarState, calendarWeek, CalendarTimezoneError, deviceTimezone, localDateKey, shiftDay, storedCalendarFilter } from "./calendarState.ts";
import type { CalendarHandlers } from "./calendarView.ts";
import { isSectionRoute, SectionCatalog, type SectionRoute } from "./sectionCatalog.ts";
import { readSectionCatalog, type SectionSnapshot } from "./sectionCatalogState.ts";
import { BrowsePrefs, browseQuery } from "./libraryBrowse.ts";
import { stopFeed, waitForFeedEnd } from "./catalogFeed.ts";
import type { BrowseChange, DiscoveryState } from "./libraryDiscovery.ts";
import { shufflePick } from "../player/nextShuffle.ts";
import type { ShuffleCapability } from "../contracts/v2/shuffle.ts";
import { avatarReference, avatarText } from "./profilePicker.ts";
import { ExperimentalFeatures } from "../session/experimentalFeatures.ts";
import { WatchPartyHub, watchPartyApi } from "./watchPartyHub.ts";
import { watchPartyScreen } from "./watchParty.ts";
import type { MediaChoice } from "./watchPartyChoice.ts";

export type { PlayRequest } from "./browseModel.ts";

export interface BrowseOptions {
    /** Signed in, with a profile selected (and its PIN verified when it has one). */
    readonly server: ConnectedServer;
    /** Browse hides itself and ignores keys until `resumeAfterPlayback`. */
    readonly onPlay: (request: PlayRequest) => void;
    /** The person asked for the profile screens; browse has already removed itself. */
    readonly onChooseProfile: () => void;
    readonly onSignOut?: () => void;
    readonly onSwitchServer?: (back: () => void) => void;
    readonly onAccounts?: (back: () => void) => void;
    readonly profileName?: string;
    readonly profileAvatarUrl?: string;
    readonly profileAvatarText?: string;
    readonly clock?: Clock;
    readonly publicStorage?: PublicStorage;
    /** Protected storage for the Home and For You snapshot artwork, which is signed. */
    readonly keyManager?: TizenKeyManager;
    /** Replaces the `<audio>` element behind theme music. For tests. */
    readonly themeOutput?: (grant: ThemePlayback) => ThemeAudioOutput;
}

export interface Browse {
    /** Shows browse again where it was, after the player closes, and refreshes what it shows. */
    resumeAfterPlayback(): void;
    /** Updates the top-bar profile chrome without remounting painted content. */
    updateProfile(profile: Pick<ProfileSummary, "name" | "avatarUrl" | "avatar">): void;
    /** Removes browse and its container; nothing else in `root` is touched. */
    destroy(): void;
    /** The profile spoiler switches playback uses for Up Next. */
    spoilers(): EpisodeSpoilerSettings;
    /** The profile's Resolution cap, which ranks the files that next-episode, On Deck and shuffle picks start. */
    resolutionCap(): Pick<ResolutionCap, "quality" | "ready">;
}

/** SearchViewModel.onQueryChanged and RequestSearchSectionViewModel.onQueryChanged both wait 300 ms. */
const SEARCH_DELAY_MS = 300;
const SLOW_MS = 5000;
/** SectionRowLimit.cards (silo-apple SectionRowLimit.swift:6). */
const HOME_SECTION_CARDS = 20;

/** The server refused `item_limit` as an unknown query parameter (SectionRowLimit.swift:32). */
function unsupportedHomeItemLimit(error: unknown): boolean {
    return error instanceof ApiError && error.failure.kind === "problem" && error.status === 422
        && error.failure.problem.errors.some(item => item.location === "query.item_limit" && item.code === "unknown_parameter");
}

/**
 * Last libraries that painted the bar for one profile. Browse is removed when
 * the profile changes, so this is Apple's per-profile snapshot: `loadLibraries`
 * clears the bar when the authority changes (`TVMainTabView.swift:1008-1014`),
 * `clearPerProfileCaches` drops the in-memory `user:` list, and a failed fetch
 * keeps only what was reseeded for the profile that is current now
 * (`TVMainTabView.swift:1018-1036`). Another profile's libraries are never read
 * from here.
 */
const rememberedLibraryTabs = new Map<string, UserLibrary[]>();

export function mountBrowse(root: HTMLElement, options: BrowseOptions): Browse {
    const server = options.server;
    const session = server.session;
    if (session.activeProfile === undefined) {
        throw new Error("mountBrowse needs a selected profile");
    }
    let profileName = options.profileName ?? "Profiles";
    let profileAvatarUrl = options.profileAvatarUrl;
    let profileAvatarText = options.profileAvatarText;
    const clock = options.clock ?? systemClock;
    const cache = browseCache(options.publicStorage, [server.server.serverId, session.account?.id ?? "", session.activeProfile.id], session.authoritySignal, options.keyManager);
    // Route reads already discard through cache.read. Card menus, episode owners and
    // other session.call readers do not, so a 403 or 404 from any of them drops the
    // title here too. A transport failure is not a refusal and leaves the cache.
    const originalCall = session.call;
    const call = originalCall.bind(session);
    const wrappedCall = ((spec: Parameters<typeof session.call>[0]) => call(spec).then((value) => value, (error: unknown) => {
        if (error instanceof ApiError && (error.status === 403 || error.status === 404) && refusedCatalogPath(spec.path)) cache.discard(spec);
        throw error;
    })) as typeof session.call;
    session.call = wrappedCall;
    const cachedDetailOwners = new WeakSet<DetailsState>();
    const visitedDetails = new Map<string, DetailsState>();
    const deferredDetails = new WeakSet<Route>();
    let cancelOfflineRefresh = (): void => {};
    let offlineRefreshRoute: Route | undefined;
    let offlineRefreshAt: number | undefined;
    const translations = new DescriptionTranslations(session, clock);
    // Details ranks versions by this cap, so a late answer repaints the Details on screen.
    const resolutionCap = new ResolutionCap(session, () => {
        const current = top();
        if (!torn && !playing && (current?.kind === "item" || current?.kind === "season") && current.data?.details !== undefined) render(host.focused());
    });
    const container = el("div", "browse");
    root.appendChild(container);
    const host = new FocusHost(container);
    const sectionCatalogs = new WeakMap<SectionRoute, SectionCatalog>();
    let activeSection: SectionCatalog | undefined;
    let activeBrowse: Pages | undefined;
    let activePersonal: object | undefined;
    const personalSnapshots = new WeakMap<Extract<Route, { kind: "personal" }>, SectionSnapshot>();
    const showAudiobooks = new ShowAudiobooks(options.publicStorage, `silo.nav.showAudiobooks:${JSON.stringify([server.server.serverId, session.account?.id ?? "", session.activeProfile.id])}`);
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
        if (!playing && current !== undefined && (current.kind === "home" || current.kind === "for_you" || current.kind === "personal" || current.kind === "search" || current.kind === "person" || isSectionRoute(current) || current.kind === "libraryResults" || (current.kind === "library" && (current.discovery?.mode === "Browse" || current.discovery?.mode === "Recommended" || current.discovery?.mode === "Collections"))) && (resized || shownOverlays !== presentation.cardOverlays)) {
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
    let episodeSpoilers: EpisodeSpoilerPreferences | undefined;
    const previews = new WeakMap<Route, () => void>();
    const context: ViewContext = { baseUrl: server.server.http.base.baseUrl, cardOverlays: () => presentation.cardOverlays, posterScale: () => presentation.posterScale, spoilers: () => episodeSpoilers?.settings ?? { hidesImages: false, hidesOverviews: false }, savedFileOverlay: card => homeDetails.savedFile(card)?.overlay, open: (destination) => open(destination), preview: (card, row, continuing, featured) => {
        const current = top();
        const preview = (): void => {
            // The read is armed first, so a row change the marquee reports during preview starts this card's read.
            if (enrichedScene()) homeDetails.rest(card, continuing === true);
            shell.preview(card, row, continuing ?? false, featured === true);
        };
        if (current !== undefined) previews.set(current, preview);
        preview();
    }, resume: (id, title, line) => {
        if (!torn && !playing && top()?.kind !== "resume") push(newRoute({ kind: "resume", id, title, ...(line === undefined ? {} : { seriesLine: line }) }));
    }, playEpisode: (id, title, startOver, selection) => {
        const current = top();
        if ((current?.kind === "item" || current?.kind === "season") && current.data?.details?.episodePreferencesBlocked) return;
        if (!torn && !playing && current?.kind !== "resume") {
            const seriesLine = current === undefined ? undefined : seriesLineFor(stack, current, id);
            push(newRoute({ kind: "resume", id, title, episode: true, startOver: startOver === true, ...(selection === undefined ? {} : { selection }), ...(seriesLine === undefined ? {} : { seriesLine }) }));
        }
    }, quickActions: (card, options) => {
        const current = top();
        if (current === undefined || torn || playing || cardActions.active) return;
        shuffleGeneration++;
        activeSection?.stop();
        if (activeBrowse !== undefined) stopFeed(activeBrowse);
        if (activePersonal !== undefined) stopFeed(activePersonal);
        loading?.abort();
        loading = undefined;
        cancelSlow();
        if (current.kind === "homeSection" || current.kind === "person" || current.kind === "personal") current.pendingIndex = undefined;
        menuOrigin = { route: current, focus: host.focused() };
        cardActions.open(card, options);
    }, watchParty: { offered: () => watchPartyOffered, open: choice => openWatchParty(choice) } };
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
    // Apple hides Search's navigation bar (SearchView.swift:65-69); the title stays only as the page's hidden heading.
    const searchHead = [el("h1", "browse-title", "Search"), searchLabel, searchField];

    let stack: Route[] = [];
    const seriesSeasons = new Map<string, number>();
    /** Series whose page was in the stack at a watched change: their next landed read picks the season again, as Apple's refreshed cached page does. */
    const repickSeasons = new Set<string>();
    /** The last 20 Details visits, in order, including ones a change dropped from `visitedDetails` (ItemDetailCache.swift:34). */
    const visitOrder = new Set<string>();
    let loading: AbortController | undefined;
    let personRead: { route: Route; controller: AbortController } | undefined;
    let personFilterGeneration = 0;
    let homeLibraries: AbortController | undefined;
    let cancelSlow: () => void = () => undefined;
    let cancelSearch: () => void = () => undefined;
    let cancelCalendarDay: () => void = () => undefined;
    let playing = false;
    let torn = false;
    let detailWork: DetailsState | undefined;
    let settingsScreen: SettingsScreen | undefined;
    let calendarLibrariesStale = false;
    let homeLibrariesFailed = false;
    let homeLibrariesNeedForeground = false;
    let retryHomeLibraries: (() => void) | undefined;
    let menuOrigin: { route: Route; focus: FocusTarget | undefined } | undefined;
    const discardVisitedDetails = (id: string): boolean => {
        if (detailWork?.detail.id === id) { detailWork.stop(); detailWork = undefined; }
        cache.discard(operations.getCatalogItem(id));
        cache.discard(operations.listSeriesSeasons(id));
        return visitedDetails.delete(id);
    };
    const personalPending = (): boolean => detailWork?.pending === true || cardActions.pending;
    const cardActions = new CardActions(container, session, {
        applied: (id, watched) => {
            visitedDetails.delete(id);
            // MediaCardWatchedSync.swift:15 refreshes Apple's cached page, which picks its season again; favorites keep it.
            if (watched) {
                seriesSeasons.delete(id);
                if (stack.some(entry => entry.kind === "item" && entry.id === id && entry.data?.details !== undefined)) repickSeasons.add(id);
            }
            cache.invalidate();
            // Delivery may be uncertain; retained roots must reread even after a failed change.
            for (const entry of new Set([...roots.values(), ...stack])) entry.stale = true;
            // HomeViewModel reloads its rows after each change; a menu or alert still open rereads when it closes.
            const current = top();
            if (!torn && !playing && !cardActions.active && settingsScreen === undefined && current !== undefined) showRoute(current, host.focused());
        },
        dismissed: card => {
            for (const entry of new Set([...roots.values(), ...stack])) {
                if (entry.kind === "home" && entry.data !== undefined) entry.data.sections = removingDismissed(entry.data.sections, { id: card.id, type: card.type, seriesId: card.seriesId });
            }
        },
        opened: () => {
            const current = top();
            if (current === undefined) return;
            menuOrigin ??= { route: current, focus: host.focused() };
        },
        closed: () => {
            const origin = menuOrigin;
            menuOrigin = undefined;
            if (!torn && origin !== undefined && top() === origin.route) {
                origin.route.focus = origin.focus;
                showRoute(origin.route, origin.focus);
                render(origin.focus);
            }
        },
        information: card => open({ kind: "item", id: card.id, title: card.title }),
        pendingElsewhere: () => detailWork?.pending === true,
        canAlert: () => !torn && !playing && settingsScreen === undefined && !requestMenu.active,
    });
    const requestGate = new RequestActionGate();
    const requestMenu = new RequestRecordMenu();
    let clearRequestNotice = (): void => undefined;
    const syncRequestActions = (route: Extract<Route, { kind: "requests" }>): void => {
        const state = route.requests;
        state.actingId = requestGate.actingId;
        state.heldIds = requestGate.heldIds();
        state.notice = requestGate.notice;
        state.listMessage = requestGate.listMessage;
    };
    const publishRequestNotice = (text: string): void => {
        clearRequestNotice();
        requestGate.notice = text;
        clearRequestNotice = clock.schedule(() => {
            clearRequestNotice = () => undefined;
            if (requestGate.notice !== text || torn) return;
            requestGate.notice = undefined;
            const current = top();
            if (current?.kind === "requests" && !requestMenu.active) { syncRequestActions(current); render(host.focused()); }
        }, REQUEST_NOTICE_MS);
    };
    const stopDetails = (): void => {
        if (detailWork !== undefined) {
            const id = detailWork.detail.id;
            visitedDetails.delete(id);
            visitedDetails.set(id, detailWork);
            // TVItemDetailView.swift:166-170: Apple's cached page keeps its season however the visit ends.
            const season = detailWork.series?.seasonNumber;
            if (season !== undefined && !repickSeasons.has(id)) seriesSeasons.set(id, season);
            // ItemDetailCache.swift:34: the page and its season leave after 20 others; a Favorite change does not reset that count.
            visitOrder.delete(id);
            visitOrder.add(id);
            if (visitOrder.size > 20) { const evicted = visitOrder.values().next().value!; visitOrder.delete(evicted); visitedDetails.delete(evicted); seriesSeasons.delete(evicted); }
        }
        detailWork?.stop(); detailWork = undefined;
        personRead?.controller.abort();
        if (personRead?.route.kind === "person") { personRead.route.metadataLoading = false; personRead.route.availabilityLoading = false; }
        personRead = undefined;
        boxSetRowWork?.stop(); boxSetRowWork = undefined;
    };
    let boxSetRowWork: BoxSetRowState | undefined;
    let boxSetsAnswer: Promise<boolean> | undefined;
    const boxSetsSupported = (): Promise<boolean> => {
        if (boxSetsAnswer !== undefined) return boxSetsAnswer;
        const pending = session.call({ ...operations.getCatalogSearchCapabilities(), profileScoped: true }).then(capability => {
            const yes = capability.boxSets === true;
            boxSetsAnswer = Promise.resolve(yes);
            return yes;
        }, () => {
            if (boxSetsAnswer === pending) boxSetsAnswer = undefined;
            return false;
        });
        boxSetsAnswer = pending;
        return pending;
    };
    let inputRevision = 0;
    const recordInput = (): void => { inputRevision++; };
    document.addEventListener("keydown", recordInput, true);
    document.addEventListener("pointerdown", recordInput, true);

    const top = (): Route | undefined => stack[stack.length - 1];
    const themePrefs = new ThemeMusicPreferences(session);
    const themeCenter = new ThemeMusicCenter(new ThemeMusicController(async (ownerId, themeId) => {
        const probe = document.createElement("audio");
        const grant = await session.call({ ...operations.themePlayback(ownerId, themeId, themeAudioFormats(probe)), profileScoped: true });
        // A root-relative URL is this server's audio route; an absolute one is a proxy's origin.
        const url = artworkUrl(grant.url, context.baseUrl);
        if (url === undefined) throw new Error("Theme audio URL not permitted");
        return { ...grant, url };
    }, grant => options.themeOutput?.(grant) ?? new ElementThemeOutput(grant), createVolumeRamp(clock)), () => session.call({ ...operations.themeCapability(), profileScoped: true }), clock);
    /** The open title page for theme music: a detail or season page, or none. A season that carries no set of its own keeps its series'. */
    const themePage = (): ThemeMusicPage | undefined => {
        const current = top();
        if (torn || settingsScreen !== undefined || (current?.kind !== "item" && current?.kind !== "season")) return undefined;
        const detail = current.data?.detail;
        const series = current.kind === "season" ? stack.find(route => route.kind === "item" && route.id === current.seriesId) : undefined;
        return {
            themes: detail?.themes ?? (series?.kind === "item" ? series.data?.detail.themes : undefined),
            isLoading: current.data === undefined,
            isVisible: !document.hidden,
            enabled: themePrefs.playsThemeMusic,
            loop: themePrefs.loops,
        };
    };
    const syncThemeMusic = (): void => themeCenter.update(themePage(), playing);
    const themeVisibility = (): void => syncThemeMusic();
    document.addEventListener("visibilitychange", themeVisibility);
    themePrefs.subscribe(syncThemeMusic);
    void themePrefs.refresh();
    let requestsCapability: RequestsCapability = { enabled: false, follow: false, removeFailed: false };
    let searchPeopleController: AbortController | undefined;
    let searchBoxSetController: AbortController | undefined;
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
        searchBoxSetController?.abort(); searchBoxSetController = undefined;
        searchRequestsController?.abort(); searchRequestsController = undefined;
    };
    const searchRequests = (current: Extract<Route, { kind: "search" }>): void => {
        const query = current.query.trim();
        const supplement = current.supplement ??= {};
        // RequestSearchSectionViewModel.onQueryChanged: a query of one character clears the matches; longer ones keep them until answered.
        if (!requestsCapability.enabled || query.length <= 1) { supplement.requests = query.length === 0 ? undefined : []; supplement.requestsFor = undefined; return; }
        if (supplement.requestsFor === query) return;
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
    /** Apple SearchView.audiobooksAvailable on tvOS: the opt-in is on and the profile can see an audiobook library. */
    const audiobooksInSearch = (): boolean => showAudiobooks.value && (pendingHomeLibraries ?? []).some(library => library.type === "audiobooks");
    const searchTypeFor = (current: Extract<Route, { kind: "search" }>, base: TextSearchScope): TextSearchScope | SearchFilter | undefined =>
        searchScope(current.filter, audiobooksInSearch(), base === "video_with_episodes");
    const searchPeople = (current: Extract<Route, { kind: "search" }>, type: TextSearchScope | SearchFilter | undefined): void => {
        searchPeopleController?.abort();
        const supplement = current.supplement ??= {};
        supplement.peopleFailure = false;
        // SearchViewModel.startPeopleSearch: the shown people stay until this lookup answers.
        if (!current.peopleSupported) { supplement.people = []; supplement.peoplePending = false; return; }
        const query = current.query;
        const controller = new AbortController(); searchPeopleController = controller;
        supplement.peoplePending = true;
        const owns = (): boolean => !torn && !controller.signal.aborted && top() === current && current.supplement === supplement && current.query === query;
        void read(detailOperations.people(query.trim(), type), controller.signal).then(people => {
            if (!owns()) return;
            supplement.people = people; supplement.peoplePending = false; render(host.focused());
        }, () => {
            if (!owns()) return;
            // SearchViewModel.matchingPeople answers none on failure, replacing the shown people.
            supplement.people = []; supplement.peoplePending = false; supplement.peopleFailure = true; render(host.focused());
        });
    };
    /** Box sets are movies, so only All and Movies ask. A failed read shows none and leaves titles alone. */
    const searchBoxSets = (current: Extract<Route, { kind: "search" }>): void => {
        searchBoxSetController?.abort();
        const supplement = current.supplement ??= {};
        const wants = current.boxSetsSupported === true && (current.filter === undefined || current.filter === "movie");
        if (!wants) {
            searchBoxSetController = undefined;
            supplement.boxSets = [];
            supplement.boxSetsPending = false;
            return;
        }
        const query = current.query.trim();
        if (query === "") {
            searchBoxSetController = undefined;
            supplement.boxSets = [];
            supplement.boxSetsPending = false;
            return;
        }
        const controller = new AbortController();
        searchBoxSetController = controller;
        supplement.boxSetsPending = true;
        const owns = (): boolean => !torn && !controller.signal.aborted && top() === current && current.supplement === supplement && current.query.trim() === query && (current.filter === undefined || current.filter === "movie");
        const miss = (): void => {
            if (!owns()) return;
            searchBoxSetController = undefined;
            supplement.boxSets = [];
            supplement.boxSetsPending = false;
            render(host.focused());
        };
        // search() throws before a request exists. That miss stays here, as Apple's
        // box-set task does, so the title search in load() is still sent.
        let request: ReturnType<typeof boxSetOperations.search>;
        try {
            request = boxSetOperations.search(query, BOX_SET_SEARCH_LIMIT);
        } catch {
            miss();
            return;
        }
        void read(request, controller.signal).then(found => {
            if (!owns()) return;
            searchBoxSetController = undefined;
            supplement.boxSets = found.slice(0, BOX_SET_SEARCH_LIMIT);
            supplement.boxSetsPending = false;
            render(host.focused());
        }, miss);
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
        if ((current?.kind === "library" && current.discovery?.mode === "Browse" || current?.kind === "libraryResults") && !playing) render(host.focused());
    }, () => undefined);
    const startShuffle = (current: Extract<Route, { kind: "library" | "libraryResults" }>): void => {
        if (torn || playing || top() !== current || shuffleStarting || !canShuffle(current)) return;
        const discovery = current.kind === "library" ? current.discovery : undefined, generation = shuffleGeneration;
        shuffleStarting = true; shuffleFailure = undefined;
        render({ zone: "controls", key: "shuffle" });
        const owns = (): boolean => !torn && !playing && generation === shuffleGeneration && top() === current && (current.kind === "libraryResults" || current.discovery === discovery && discovery?.mode === "Browse");
        void (async () => {
            try {
                const scope: { id: string; kind: "library" | "library_collection" | "user_collection" } = current.kind === "libraryResults" && current.source.kind === "collection" ? { id: current.source.id, kind: current.source.groupKind === "user_collections" ? "user_collection" : "library_collection" } : { id: current.library.id, kind: "library" };
                const shuffle = await session.call({ ...operations.createShuffle(scope.id, scope.kind), profileScoped: true, replayAfterRefresh: false, signal: requestsController.signal });
                if (!owns()) return;
                await resolutionCap.ready(requestsController.signal);
                if (!owns()) return;
                const request = await shufflePick(spec => read(spec, requestsController.signal), shuffle, resolutionCap.quality);
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
    // A tab narrows a mixed library to its type, so the route's library can differ from the server's. Tabs can be up before Home's rows.
    const serverLibrary = (id: string): UserLibrary | undefined => (pendingHomeLibraries ?? (home.kind === "home" ? home.data?.libraries : undefined))?.find(library => library.id === id);
    const canShuffle = (route: Extract<Route, { kind: "library" | "libraryResults" }>): boolean => {
        const original = serverLibrary(route.library.id);
        const kind = route.kind === "libraryResults" && route.source.kind === "collection" ? route.source.groupKind === "user_collections" ? "user_collection" : "library_collection" : "library";
        // Shuffle starts video; audiobook shuffle waits for audiobook playback.
        return route.library.type !== "audiobooks" && shuffleCapability.usable && shuffleCapability.scopeKinds.includes(kind) && (original?.type !== "mixed" || route.library.type === "mixed");
    };
    const isHubRoot = (route: Route | undefined): route is Extract<Route, { kind: "requests" }> => route?.kind === "requests" && route.requests.source.kind === "hub";
    // Apple's closeRequestsScreens closes only the Requests pages on top, then closesRequestsRoot closes the root hub once nothing covers it
    // and focus goes to the tab's content. A page above Requests (Search, Watchlist, a title) stays; pop() closes them when they are back in view.
    const closeRequests = (): void => {
        roots.delete("requests");
        if (top()?.kind !== "requests") return;
        let closedHub = false;
        while (stack.length > 1 && top()?.kind === "requests") closedHub = isHubRoot(stack.pop()) || closedHub;
        const origin = top();
        if (origin === undefined) return;
        showRoute(origin, closedHub ? undefined : origin.focus);
        if (closedHub && hasData(origin)) host.focusDefault();
    };
    const isPersonalRoot = (route: Route): boolean => route.kind === "personal" && route.source !== "history" || isHubRoot(route) || route.kind === "watchParty";
    // Apple's showPersonalRoot pops to the tab first, so Watchlist, Favorites and Requests replace each other and one Back pair returns to the tab.
    const clearPersonalRoot = (): void => {
        const index = stack.findIndex(isPersonalRoot);
        if (index < 1) return;
        stopSearchSupplement(); stopDetails(); loading?.abort(); loading = undefined; cancelSearch();
        for (const removed of stack.slice(index)) retireRoute(removed);
        stack.length = index;
    };
    // Apple WatchPartyEntry.isAvailable: the device switch is on and the server can host a synchronized party.
    const experimental = new ExperimentalFeatures(options.publicStorage);
    let watchPartyOffered = false;
    const setWatchPartyOffered = (supported: boolean): void => {
        watchPartyOffered = supported && experimental.isEnabled("watchParty");
        if (!torn) shell.setWatchPartyEnabled(watchPartyOffered);
    };
    let watchPartyProbe: WatchPartyHub | undefined;
    const probeWatchParty = (): void => {
        watchPartyProbe?.stop();
        watchPartyProbe = undefined;
        if (!experimental.isEnabled("watchParty")) { setWatchPartyOffered(false); return; }
        watchPartyProbe = new WatchPartyHub(watchPartyApi(session), () => undefined, { onSupport: setWatchPartyOffered });
        void watchPartyProbe.check();
    };
    const detailVisits = new WeakMap<Route, string>();
    let detailVisitSequence = 0;
    /** A route leaving the stack for good: stop its live party and drop its presentation's focus snapshots. */
    const retireRoute = (route: Route | undefined): void => {
        if (route === undefined) return;
        if (route.kind === "watchParty") route.watchParty.hub.stop();
        const visit = detailVisits.get(route);
        if (visit !== undefined) host.forgetPresentation(visit);
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
                if (top()?.kind === "requests") {
                    loading?.abort(); loading = undefined;
                    // Drop an open card menu without its onClose paint: the stack is about to leave Requests.
                    if (requestMenu.active) requestMenu.destroy();
                    closeRequests();
                    return;
                }
            }
            render(focus?.key === "requests" && !capability.enabled ? { zone: "nav", key: "home" } : focus);
        } catch { /* A transient probe failure keeps the last confirmed capability. */ }
    };
    // Artwork sizing (Apple ImageSizeCapability): one probe per Browse. The last answer for this
    // server is remembered so Home does not wait for it; a failed probe leaves per-slot widths off.
    const imageKey = `silo.imageCapability:${server.server.serverId}`;
    // Apple remembers section_item_limit_max per server (SectionItemLimitSupport.swift:54-90)
    // and sends min(max, 20) on the first Home read. Unknown stays unsent until the probe answers.
    const homeLimitKey = `silo.homeSectionItemLimit:${server.server.serverId}`;
    let homeLimitKnown = false;
    let homeLimitMax: number | null = null;
    try {
        const raw = options.publicStorage?.getItem(homeLimitKey);
        if (raw === "none") { homeLimitKnown = true; homeLimitMax = null; }
        else if (raw !== null && raw !== undefined && /^[1-9]\d*$/.test(raw)) { homeLimitKnown = true; homeLimitMax = Number(raw); }
    } catch { /* An unreadable optional cache leaves the probe in charge. */ }
    const homeItemLimit = (): number | undefined => homeLimitMax === null ? undefined : Math.min(homeLimitMax, HOME_SECTION_CARDS);
    const rememberHomeLimit = (max: number | null): void => {
        homeLimitKnown = true;
        homeLimitMax = max === null || max < 1 ? null : max;
        try { options.publicStorage?.setItem(homeLimitKey, homeLimitMax === null ? "none" : String(homeLimitMax)); }
        catch { /* The in-memory answer still decides this Browse. */ }
    };
    let imageCapability: ImageCapabilities | undefined;
    try { imageCapability = rememberedImages(options.publicStorage?.getItem(imageKey)); }
    catch { /* Missing optional cache data leaves the capability probe in charge. */ }
    let imageProbe: Promise<ImageCapabilities | undefined> | undefined;
    let homeArtworkAttempt: Readonly<Record<string, string>> | undefined;
    const libraryArtworkAttempts = new WeakMap<Route, Readonly<Record<string, string>>>();
    /** TVLibraryTypeTabView.mediaScope (:77-87): only a mixed library opened from the Movies or Series tab is narrowed. */
    function videoScope(library: UserLibrary): VideoScope | undefined {
        if (serverLibrary(library.id)?.type !== "mixed") return undefined;
        return library.type === "movies" ? "movie" : library.type === "series" ? "series" : undefined;
    }
    function upgradeLibraryArtwork(): void {
        const current = top();
        if (current?.kind !== "library" || current.discovery?.mode !== "Recommended" || current.discovery.data === undefined || torn || playing || cardActions.active || loading !== undefined || current.failure !== undefined) return;
        const attempt = libraryArtworkAttempts.get(current);
        const query = homeArtworkQuery(imageCapability, window.devicePixelRatio);
        if (attempt === undefined || !Object.entries(query).some(([key, value]) => attempt[key] !== value)) return;
        // A mixed tab's refilled cards were not in the inline rows, so the upgrade reads them through the same refill.
        load(current, signal => readSections(current.library, spec => read(spec, signal), query, videoScope(current.library)).then(result => result.sections).catch((error: unknown) => {
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
        // Named sizes such as "medium" and "large" are not numbers, so any changed query value refetches.
        // The row cap still goes with that read (listHomeSections item_limit).
        if (!Object.entries(query).some(([key, value]) => homeArtworkAttempt?.[key] !== value)) return;
        load(home, signal => read(operations.listHomeSections(query, homeItemLimit()), signal).catch((error: unknown) => {
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
    const requestsVisibility = (): void => {
        if (document.hidden) {
            // A libraries miss is read again on the next foreground, as Apple does
            // after backgrounding (TVMainTabView scenePhase, TVMainTabView.swift:334-342).
            homeLibrariesNeedForeground = true;
            return;
        }
        void probeRequests();
        const current = top();
        if (current !== undefined) recoverCachedRoute(current);
        if (!homeLibrariesFailed || !homeLibrariesNeedForeground) return;
        homeLibrariesNeedForeground = false;
        retryHomeLibraries?.();
    };
    document.addEventListener("visibilitychange", requestsVisibility);

    const teardown = (): void => {
        cancelOfflineRefresh();
        if (session.call === wrappedCall) session.call = originalCall;
        if (torn) {
            return;
        }
        torn = true;
        translations.reset();
        stopSearchSupplement();
        presentation.stop();
        resolutionCap.stop();
        episodeSpoilers?.stop();
        document.removeEventListener("visibilitychange", themeVisibility);
        themePrefs.stop();
        themeCenter.reset();
        activeSection?.stop();
        if (activeBrowse !== undefined) stopFeed(activeBrowse);
        if (activePersonal !== undefined) stopFeed(activePersonal);
        homeDetails.stop();
        navigation.destroy();
        requestsController.abort();
        watchPartyProbe?.stop();
        for (const route of stack) retireRoute(route);
        document.removeEventListener("visibilitychange", requestsVisibility);
        cardActions.destroy();
        requestMenu.destroy();
        clearRequestNotice();
        menuOrigin = undefined;
        stopDetails();
        settingsScreen?.destroy();
        settingsScreen = undefined;
        stopAuthority();
        loading?.abort();
        homeLibraries?.abort();
        cancelSlow();
        cancelSearch();
        cancelCalendarDay();
        document.removeEventListener("keydown", recordInput, true);
        document.removeEventListener("pointerdown", recordInput, true);
        stack = [];
        roots.clear();
        seriesSeasons.clear();
        repickSeasons.clear();
        visitOrder.clear();
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
        const enterResults = !quiet && (current.kind === "personal" || (current.kind === "requests" && current.requests.data === undefined && current.requests.source.kind !== "search") || (current.kind === "library" && host.focused()?.key !== "sort"));
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
                    const nextFocus = lateCalendarContext && inputRevision !== entryRevision ? host.focused() : (current.kind === "library" || ((current.kind === "personal" || current.kind === "person") && !quiet)) && !enterContent ? host.focused() : focus;
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
                if (error instanceof ApiError && error.problemId === "invalid_cursor" && (current.kind === "homeSection" || current.kind === "person" || current.kind === "personal" || current.kind === "library" || current.kind === "libraryResults" || current.kind === "search") && current.pages !== undefined) {
                    Object.assign(current.pages, newPages());
                    current.focus = undefined;
                    if (current.kind === "personal" || current.kind === "homeSection" || current.kind === "person") current.pendingIndex = undefined;
                    if (current.kind === "personal") personalSnapshots.delete(current);
                    if (current.kind === "library" && current.discovery !== undefined) {
                        current.discovery.windowCursor = undefined;
                        current.discovery.seek = undefined;
                        current.discovery.letter = undefined;
                    }
                }
                const text = error instanceof CalendarTimezoneError ? error.message : failureText(error, current);
                if ((current.kind === "item" || current.kind === "home") && error instanceof ApiError && (error.status === 403 || error.status === 404)) {
                    if (current.kind === "item") discardVisitedDetails(current.id);
                    current.data = undefined;
                    if (current.kind === "home") shell.update([]);
                }
                if (text === undefined) {
                    // A defect, not a server answer: offer a retry, and surface it as uncaught.
                    clock.schedule(() => {
                        throw error;
                    }, 0);
                }
                // Apple WatchlistView, FavoritesView and HistoryViewModel: a failed later page keeps the rows and does not become the error screen.
                if (current.kind === "personal" && (current.pages.page?.items.length ?? 0) > 0 && text !== undefined) {
                    current.failure = current.source === "favorites" && !personalEndCanReenter(container) ? text : undefined;
                    current.error = undefined;
                    if (top() === current) render(host.focused());
                    return;
                }
                // TVLibraryGridViewModel.swift:337-339: a failed later Browse page keeps the grid and shows nothing; the next approach to the end reads again.
                if (current.kind === "library" && current.discovery?.mode === "Browse" && (current.pages.page?.items.length ?? 0) > 0 && text !== undefined) {
                    waitForFeedEnd(current.pages);
                    current.failure = undefined;
                    current.error = undefined;
                    if (top() === current) render(host.focused());
                    return;
                }
                // Apple PersonDetailView: a failed later page keeps the cards; a stale failure would make Back read every loaded page again.
                if (current.kind === "person" && (current.pages.page?.items.length ?? 0) > 0 && text !== undefined) {
                    current.failure = undefined;
                    if (top() === current) render(host.focused());
                    return;
                }
                current.failure = text ?? "Something went wrong. Try again.";
                current.error = errorState(error);
                // Apple BoxSetDetailViewModel.errorState: a 404 keeps Not found but says why a box set can be missing.
                if (current.kind === "boxSet" && current.error.headline === "Not found" && text !== undefined) current.error = { ...current.error, message: text };
                // SearchViewModel.performSearch: a failed new search clears its titles, people and box sets; a failed next page keeps them behind the error.
                if (current.kind === "search" && current.appending !== true) {
                    current.pages = newPages();
                    searchPeopleController?.abort(); searchPeopleController = undefined;
                    searchBoxSetController?.abort(); searchBoxSetController = undefined;
                    if (current.supplement !== undefined) Object.assign(current.supplement, { people: [], peoplePending: false, boxSets: [], boxSetsPending: false });
                }
                if (current.kind === "search") current.appending = false;
                if (current.kind === "calendar") current.calendar.error = error instanceof CalendarTimezoneError ? { headline: "Something went wrong", message: error.message, signIn: false } : errorState(error);
                if (current.kind === "requests") { current.requests.error = errorState(error); if (!current.requests.unconfirmed && !current.requests.writing) current.requests.action = undefined; }
                if (current.kind === "requests" && error instanceof ApiError && ["capability_disabled", "capability_not_configured", "capability_unsupported", "permission_denied"].includes(error.problemId ?? "")) void probeRequests();
                if (top() === current) {
                    render();
                }
            },
        );
    };

    const read = <T>(spec: RequestSpec<T>, signal: AbortSignal): Promise<T> => cache.read({ ...spec, signal }, request => session.call({ ...request, profileScoped: true }));
    const routeOffline = (current: Route): boolean => {
        if ((current.kind === "item" || current.kind === "season") && current.data?.details?.offline === true) return true;
        const specs = current.kind === "home" ? [operations.listHomeSections(), operations.listUserLibraries(), operations.hiddenLibraries()]
            : current.kind === "for_you" ? [operations.recommendations()]
            : current.kind === "item" ? [operations.getCatalogItem(current.id), operations.listSeriesSeasons(current.id)]
            : current.kind === "season" ? [operations.listSeasonEpisodes(current.seriesId, current.seasonNumber), ...(current.id === undefined ? [] : [operations.getCatalogItem(current.id)])] : [];
        return specs.some(spec => cache.isOffline(spec));
    };
    const recoverCachedRoute = (current: Route): void => {
        offlineRefreshAt = undefined;
        cancelOfflineRefresh();
        if (torn || top() !== current || (!routeOffline(current) && !deferredDetails.has(current))) return;
        const details = current.kind === "item" || current.kind === "season" ? current.data?.details : undefined;
        if (playing || loading !== undefined || document.hidden || cardActions.active || settingsScreen !== undefined || details?.panel !== undefined || details?.busy || details?.preparingPlay) {
            cancelOfflineRefresh = clock.schedule(() => recoverCachedRoute(current), 15000);
            return;
        }
        loadRoute(current, true);
    };
    // Join the capabilities probe when this server's row cap is unknown, so the first
    // sections read can ask for short rows (SiloAPI.withSectionItemLimit, SiloAPI.swift:155).
    // A known answer is used at once; a later probe only updates the next visit.
    let homeLimitFlight: Promise<void> | undefined;
    const probeHomeLimit = (signal: AbortSignal): Promise<void> => {
        if (homeLimitKnown) return Promise.resolve();
        const flight = homeLimitFlight ?? session.call({ ...operations.homeCapabilities(), profileScoped: true, signal }).then(found => {
            const max = found.state === "available" && found.sectionItemLimitMax !== undefined && found.sectionItemLimitMax > 0 ? found.sectionItemLimitMax : null;
            rememberHomeLimit(max);
        }, (error: unknown) => {
            if (error instanceof ApiError && error.aborted) throw error;
            // A missing capabilities read means the server offers no row cap (SiloAPI.swift:179-180).
            if (error instanceof ApiError && error.status === 404) rememberHomeLimit(null);
        }).finally(() => { if (homeLimitFlight === flight) homeLimitFlight = undefined; });
        homeLimitFlight = flight;
        // The shared read keeps the first visit's signal. A return that joined it
        // after that visit left starts its own read instead of keeping the abort.
        return flight.catch((error: unknown) => {
            if (error instanceof ApiError && error.aborted && !signal.aborted) return probeHomeLimit(signal);
            throw error;
        });
    };
    // Library tabs are not part of the Home rows. Apple paints sections without waiting
    // for them (HomeViewModel.fetchAndApplySections, HomeViewModel.swift:237).
    const libraryTabsKey = JSON.stringify([server.server.serverId, session.account?.id, session.activeProfile.id]);
    const rememberLibraryTabs = (visible: readonly UserLibrary[]): void => {
        rememberedLibraryTabs.set(libraryTabsKey, visible.map(library => ({ ...library })));
    };
    let pendingHomeLibraries: UserLibrary[] | undefined = rememberedLibraryTabs.get(libraryTabsKey)?.map(library => ({ ...library }));
    const readHomeLibraries = (current: Extract<Route, { kind: "home" }>): void => {
        homeLibraries?.abort();
        const controller = new AbortController();
        homeLibraries = controller;
        const signal = controller.signal;
        void Promise.all([
            read(operations.listUserLibraries(), signal),
            read(operations.hiddenLibraries(), signal).catch((error: unknown) => {
                if (error instanceof ApiError && !error.aborted) return [];
                throw error;
            }),
        ]).then(([libraries, hidden]) => {
            if (signal.aborted || torn || current.kind !== "home") return;
            homeLibrariesFailed = false;
            const visible = visibleLibraries(libraries, hidden);
            rememberLibraryTabs(visible);
            pendingHomeLibraries = visible;
            // shell.update replaces the nav, including a focused tab. Keep the target captured
            // before that replacement so Back from Settings stays on Profiles.
            // Library tabs fill the bar while Home is still the empty loading page (TVMainTabView
            // seeds them before sections; waiting for rows left the bar short).
            const focus = host.focused();
            if (current.data !== undefined) current.data = { ...current.data, libraries: visible };
            shell.update(visible);
            const shown = top();
            const shownShell = shown?.kind === "home" || shown?.kind === "for_you" || shown?.kind === "library" || shown?.kind === "personal" || shown?.kind === "calendar";
            // The page in front has to take the new buttons. Calendar and For You can open
            // before this read finishes (TVMainTabView reconcileVisibleRootsChange, TVMainTabView.swift:1065).
            if (!playing && shownShell && settingsScreen === undefined && !cardActions.active) render(focus);
        }, (error: unknown) => {
            if (signal.aborted || torn || (error instanceof ApiError && error.aborted)) return;
            if (error instanceof ApiError) {
                // Home rows stay, and so does this profile's bar (seeded above, or empty
                // when this profile has never loaded). Apple keeps that bar and shows no
                // error (TVMainTabView.swift:1032-1036). The previous profile's libraries
                // were already dropped when the authority changed (TVMainTabView.swift:1008-1014).
                homeLibrariesFailed = true;
                return;
            }
            clock.schedule(() => { throw error; }, 0);
        });
    };
    // Detail the rows don't carry. Continue Watching reads its saved file when the row loads, four at a time.
    // Every other title waits until the marquee has rested (TVFocusMarquee.loadEnrichment).
    const homeDetails = new HomeEnrichment((spec, signal) => session.call({ ...spec, signal, profileScoped: true }), id => { if (!torn) shell.refreshDetails(id); }, () => {
        // Continue Watching cards redraw once with saved-file badges, keeping focus where it is.
        const current = top();
        if (!torn && !playing && current !== undefined && (current.kind === "home" || isSectionRoute(current) || current.kind === "libraryResults" || (current.kind === "library" && current.discovery?.mode === "Recommended")) && presentation.cardOverlays !== undefined) {
            activeSection?.invalidate();
            render(host.focused());
        }
    }, (fn, ms) => clock.schedule(fn, ms));
    const presentEnrichment = (sections: Parameters<typeof homeRows>[0], prewarmRatings: boolean): void => {
        homeDetails.present(homeRows(sections).map(row => ({ cards: row.cards, continuing: row.continuing })), prewarmRatings);
    };

    const invalidateCalendar = (): void => {
        const calendar = roots.get("calendar");
        if (calendar !== undefined) calendar.stale = true;
    };

    const detailsChanged = (current: Route, returnKey?: string): void => {
        if (current.kind === "item" || current.kind === "season") {
            const details = current.data?.details;
            for (const owner of details?.seasonStates.values() ?? []) if (owner.pending) invalidateWatched(current, owner.detail);
            if (details?.detail.type === "episode" && (details.audioPreference.pending || details.subtitlePreference.pending)) {
                for (const entry of stack) {
                    if (entry.kind === "item" || entry.kind === "season") entry.data?.details?.noteEpisodePreference(details.detail.id, true, details.detail.seriesId);
                }
            }
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
            // The card menu redraws its own rows; the screen under it rerenders when it closes.
            if (cardActions.active) cardActions.refresh();
            else {
                const focus = host.focused();
                const series = (current.kind === "item" || current.kind === "season") ? current.data?.details?.series : undefined;
                const retry = focus?.key === "retry-episodes" && series?.failed;
                render(returnKey === undefined ? retry ? focus : undefined : { zone: "actions", key: returnKey });
            }
            if (deferredDetails.has(current) && (current.kind === "item") && current.data?.details?.panel === undefined && !current.data?.details?.busy && !current.data?.details?.preparingPlay && loading === undefined) queueMicrotask(() => recoverCachedRoute(current));
        }
    };

    const createItemDetails = (current: Extract<Route, { kind: "item" }>, detail: ItemDetail): DetailsState => {
        let seasonFocus: { season: number | undefined; revision: number } | undefined;
        const details = new DetailsState(detail, session, (audioClosed) => {
            if (details.series?.focusSelectedEpisode && seasonFocus?.season !== details.series.seasonNumber) {
                seasonFocus = { season: details.series.seasonNumber, revision: inputRevision };
            }
            if (details.series?.focusSelectedEpisode && details.series.episodes !== undefined) {
                details.series.focusSelectedEpisode = false;
                const episode = details.series.entryEpisode;
                const enter = seasonFocus?.revision === inputRevision;
                seasonFocus = undefined;
                if (top() === current && enter && episode !== undefined) { render({ zone: "seasons", key: `season:${details.series.seasonNumber}` }); return; }
            }
            detailsChanged(current, audioClosed);
        }, (value, signal) => refreshWatched(current, value, signal), personalPending, translations, () => resolutionCap.quality, signal => resolutionCap.ready(signal));
        details.presentsAlerts = true;
        resolutionCap.ensure();
        return details;
    };

    const invalidateWatched = (current: Route, detail: ItemDetail): void => {
        cache.invalidate();
        // Even a lost or cancelled answer may have committed; reread covered routes on return.
        current.stale = true;
        const seriesId = detail.type === "series" ? detail.id : detail.seriesId;
        for (const entry of new Set([...roots.values(), ...stack])) {
            if (entry === current) continue;
            if (entry.kind === "home" || entry.kind === "for_you" || isSectionRoute(entry) || entry.kind === "calendar" || (entry.kind === "library" && entry.discovery?.mode === "Browse")) entry.stale = true;
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
        if (current.kind === "item" && current.data?.detail.type === "movie") current.data.boxSet?.start();
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
                // BrowseEmptyReason.classify (BrowseEmptyReason.swift:20-24): a failed check keeps the filter message.
                emptyReason = await read(operations.queryCatalogItems({ ...libraryScope(current.library), limit: 1 }), signal).then(probe => probe.items.length > 0 ? "noFilterMatches" : "libraryEmpty", (error: unknown) => {
                    if (error instanceof ApiError && error.aborted) throw error;
                    return "noFilterMatches";
                });
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
    const loadPersonal = (current: Extract<Route, { kind: "personal" }>, quiet: boolean, append: boolean): void => {
        const previous = personalSnapshots.get(current);
        load(current, async signal => {
            const capability = current.source === "history" ? undefined : append && current.capability !== undefined ? current.capability : await read(personalListCapability(), signal);
            const blocked = capability !== undefined && (!capability.allowed || capability.state !== "available");
            if (blocked) return { capability, snapshot: undefined as SectionSnapshot | undefined, elsewhere: false };
            // The personal query stays at its fenced page size. readSectionCatalog still appends that page when the end is on screen.
            const snapshot = await readSectionCatalog(previous, append, async cursor => read(readPersonalPage(current.source, current.filter, cursor), signal), signal);
            if (snapshot.unavailable) throw new ApiError({ kind: "http", status: 404, retryAfterSeconds: undefined });
            let elsewhere = false;
            if (!append && current.source === "favorites" && snapshot.page.items.length === 0 && snapshot.page.nextCursor === undefined) {
                const other = current.filter === "series" ? "movie" : "series";
                elsewhere = (await readSectionCatalog(undefined, false, async cursor => read(readPersonalPage("favorites", other, cursor), signal), signal)).page.items.length > 0;
            }
            return { capability, snapshot, elsewhere };
        }, ({ capability, snapshot, elsewhere }) => {
            const focus = host.focused();
            const oldItems = current.pages.page?.items ?? [];
            const oldIndex = oldItems.findIndex(item => item.id === focus?.key);
            current.capability = capability;
            current.elsewhere = elsewhere;
            current.error = undefined;
            current.pendingIndex = undefined;
            if (snapshot === undefined) {
                personalSnapshots.delete(current);
                current.pages = newPages();
                return focus;
            }
            personalSnapshots.set(current, snapshot);
            current.pages.page = snapshot.page;
            current.pages.index = 0;
            current.pages.cursors = [undefined, snapshot.page.nextCursor];
            if (focus?.zone === "grid" && oldIndex >= 0 && !snapshot.page.items.some(item => item.id === focus.key)) {
                const nearby = snapshot.page.items[Math.min(oldIndex, snapshot.page.items.length - 1)];
                if (nearby !== undefined) return { zone: "grid", key: nearby.id };
            }
            return focus;
        }, quiet || current.pages.page !== undefined);
    };
    const morePersonal = (current: Extract<Route, { kind: "personal" }>): void => {
        if (torn || playing || top() !== current || loading !== undefined || cardActions.active || settingsScreen !== undefined || current.failure !== undefined || current.pages.page?.nextCursor === undefined) return;
        loadPersonal(current, true, true);
    };
    const morePerson = (current: Extract<Route, { kind: "person" }>): void => {
        if (torn || playing || top() !== current || loading !== undefined || cardActions.active || settingsScreen !== undefined || current.pages.page?.nextCursor === undefined) return;
        loadPage(current, current.pages, current.pages.index + 1, true);
        render(host.focused());
    };
    const moreBrowse = (current: Extract<Route, { kind: "library" }>): void => {
        if (torn || playing || top() !== current || loading !== undefined || cardActions.active || settingsScreen !== undefined || current.discovery?.panel !== undefined || shuffleFailure?.route === current || current.failure !== undefined || current.discovery?.snapshot?.page.nextCursor === undefined) return;
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
                    const startedEpoch = requestGate.epoch;
                    const coveredHolds = requestGate.cover();
                    const capability = await read(source.kind === "hub" ? once(requestOperations.status()) : requestOperations.status(), signal);
                    if (!capability.enabled) return { capability, data: undefined, detail: undefined, detailFailed: false, startedEpoch, coveredHolds };
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
                    return { capability, data, detail, detailFailed, startedEpoch, coveredHolds };
                }, result => {
                    if (capabilityOrdinal === probeOrdinal) {
                        acceptRequestsCapability(result.capability);
                        shell.setRequestsEnabled(result.capability.enabled);
                    }
                    if (!requestsCapability.enabled) { closeRequests(); return; }
                    let data: typeof state.data = result.data;
                    // Apple's hub leaves a removed or cancelled request out of every answer. A My Requests read that started before the tombstone does not put it back.
                    if (data !== undefined && "sections" in data) data = { ...data, mine: { ...data.mine, items: requestGate.filter(data.mine.items) } };
                    else if (source.kind === "mine" && data !== undefined && "items" in data) data = result.startedEpoch === requestGate.epoch ? { ...data, items: requestGate.filter(data.items) } : state.data;
                    if ((source.kind === "hub" || source.kind === "mine") && result.startedEpoch === requestGate.epoch) requestGate.releaseHolds(result.coveredHolds);
                    // A successful request detail read settles that row's uncertain cancel hold without clearing unrelated holds.
                    if (source.kind === "request" && data !== undefined && "id" in data) requestGate.releaseHold(data.id);
                    state.data = data;
                    state.detail = result.detail;
                    state.detailFailed = result.detailFailed;
                    state.uncertain = false;
                    // The server's answer now decides the action (RequestDetailViewModel.swift:250).
                    if (!state.writing) { state.action = undefined; if (state.unconfirmed) state.actionMessage = undefined; state.unconfirmed = false; }
                    syncRequestActions(current);
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
                const entryRevision = inputRevision;
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
                        rememberLibraryTabs(libraries);
                        pendingHomeLibraries = libraries;
                        shell.update(libraries);
                        if (home.kind === "home" && home.data !== undefined) home.data.libraries = libraries;
                        calendarLibrariesStale = false;
                    }
                    if (state.returnToEvent) {
                        state.returnToEvent = false;
                        // A key pressed after Today started owns focus. The
                        // arriving week must not replace it.
                        if (inputRevision === entryRevision) {
                            const onShelf = data.days.some(day => day.date === active?.zone);
                            if (!onShelf) {
                                const today = localDateKey(new Date(clock.now()));
                                const populated = data.days.filter(day => day.items.length > 0);
                                const shelf = populated.find(day => day.date === today) ?? populated.find(day => day.date > today) ?? [...populated].reverse().find(day => day.date < today);
                                const key = shelf === undefined ? undefined : calendarEventKeys(shelf.items)[0];
                                if (shelf !== undefined && key !== undefined) return { zone: shelf.date, key };
                            }
                        }
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
                    const [detail] = await Promise.all([read(operations.getCatalogItem(current.id), signal), resolutionCap.ready(signal)]);
                    if (detail.id !== current.id || (detail.type !== "movie" && detail.type !== "episode") || (current.episode === true && detail.type !== "episode")) throw new ApiError({ kind: "invalid_response", path: "resume.item" });
                    const choices = playChoices(detail, current.selection?.fileId, resolutionCap.quality);
                    if (choices === undefined) return undefined;
                    let request = current.startOver === true ? choices.fromStart : choices.resume ?? choices.fromStart;
                    if (detail.type === "episode") request = applySeriesLine({ ...request, subtitle: { kind: "auto" }, ...current.selection }, current.seriesLine);
                    request = withStartAudioLanguage(request, detail.versions.find(file => file.fileId === request.fileId));
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
            case "person":
                loadPage(current, current.pages, current.pendingIndex ?? current.pages.index, quiet);
                return;
            case "homeSection":
                loadPage(current, current.pages, current.pendingIndex ?? current.pages.index, quiet);
                return;
            case "personal":
                loadPersonal(current, quiet, false);
                return;
            case "for_you":
                presentation.ensure();
                load(current, signal => read(operations.recommendations(homeArtworkQuery(imageCapability, window.devicePixelRatio)), signal), sections => {
                    current.data = sections;
                    presentEnrichment(sections, true);
                }, quiet);
                return;
            case "home": {
                presentation.ensure();
                const artworkQuery = homeArtworkQuery(imageCapability, window.devicePixelRatio);
                if (current.kind === "home") readHomeLibraries(current);
                load(current, async (signal) => {
                    await probeHomeLimit(signal);
                    const limit = homeItemLimit();
                    try {
                        return await read(operations.listHomeSections(artworkQuery, limit), signal);
                    } catch (error) {
                        if (limit === undefined || !unsupportedHomeItemLimit(error)) throw error;
                        rememberHomeLimit(null);
                        return await read(operations.listHomeSections(artworkQuery), signal);
                    }
                }, sections => {
                    const focus = host.focused();
                    const libraries = pendingHomeLibraries ?? (current.kind === "home" ? current.data?.libraries : undefined) ?? [];
                    current.data = { libraries, sections };
                    homeArtworkAttempt = artworkQuery;
                    shell.update(libraries);
                    presentEnrichment(sections, false);
                    // Changed tabs replace the nav nodes, including the still-present avatar.
                    queueMicrotask(upgradeHomeArtwork);
                    return quiet || focus?.zone === "nav" ? focus : undefined;
                }, quiet);
                return;
            }
            case "library":
                void probeShuffles();
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
                    const data = await readDiscovery(current.library, state.mode, spec => read(spec, signal), artworkQuery, videoScope(current.library));
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
                            presentEnrichment(data.sections.filter(section => section.featured !== true), false);
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
            case "item": {
                const previousRow = current.data?.boxSet;
                const startBoxSetRow = (): void => {
                    if (current.data?.detail.type !== "movie") return;
                    boxSetRowWork?.stop();
                    const row = new BoxSetRowState(session, current.id, boxSetsSupported, () => { if (top() === current && !playing) render(host.focused()); });
                    row.restore(previousRow);
                    row.open = found => { if (top() === current && !playing) push(newRoute({ kind: "boxSet", id: found.boxSet.id, libraryId: found.boxSet.libraryId, title: found.boxSet.title, data: undefined })); };
                    current.data.boxSet = row;
                    boxSetRowWork = row;
                    row.start();
                };
                if (current.data?.details === undefined) stopDetails();
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
                    if (previous?.panel !== undefined || previous?.busy || previous?.preparingPlay) { current.stale = true; deferredDetails.add(current); return; }
                    deferredDetails.delete(current);
                    if (previous !== undefined && ((quiet && detailWork === previous && previous.changes.size > 0) || cachedDetailOwners.has(previous))) {
                        const offline = cache.isOffline(operations.getCatalogItem(current.id));
                        const detail = offline ? previous.detail : data.detail;
                        if (!offline) cachedDetailOwners.delete(previous);
                        previous.acceptDetail(detail);
                        if (detail.played !== undefined) previous.values.set("watched", detail.played);
                        if (detail.type === "series") {
                            const series = previous.series;
                            series?.stop();
                            const repick = !offline && repickSeasons.delete(detail.id);
                            const season = repick ? undefined : series?.selectionChanged ? series.seasonNumber : data.contextSeason ?? series?.seasonNumber;
                            previous.series = new SeriesEpisodes(session, detail.id, data.seasons, reason => previous.warmSeriesEpisodes(reason === "load"), season, current.seriesContext?.episodeId);
                            previous.series.restore(repick ? undefined : series, true);
                            previous.series.start();
                        }
                        current.data = { ...data, detail, details: previous };
                        startBoxSetRow();
                        if (!previous.series?.selectionChanged && current.focus === undefined && data.contextSeason !== undefined && data.seasons.some(item => item.seasonNumber === data.contextSeason)) return { zone: "seasons", key: `season:${data.contextSeason}` };
                        return;
                    }
                    const details = createItemDetails(current, data.detail);
                    details.restore(previous);
                    const repick = repickSeasons.delete(data.detail.id);
                    if (data.detail.type === "series") details.series = new SeriesEpisodes(session, data.detail.id, data.seasons, reason => details.warmSeriesEpisodes(reason === "load"), repick ? previous === undefined ? data.contextSeason : undefined : previous?.series?.seasonNumber ?? data.contextSeason ?? (current.seriesContext === undefined ? seriesSeasons.get(data.detail.id) : undefined), current.seriesContext?.episodeId);
                    details.series?.restore(repick ? undefined : previous?.series, true);
                    details.restoreSeasonStates(previous);
                    details.focusedEpisodeId ??= current.seriesContext?.episodeId;
                    details.related = quiet ? previous?.related : undefined;
                    stopDetails();
                    current.data = { ...data, details };
                    detailWork = details;
                    details.start();
                    if (details.related !== undefined) details.loadRelated();
                    startBoxSetRow();
                    const season = data.contextSeason;
                    if (current.seriesContext?.episodeId === undefined && current.focus === undefined && season !== undefined && data.seasons.some(item => item.seasonNumber === season)) return { zone: "seasons", key: `season:${season}` };
                }, quiet);
                return;
            }
            case "audiobook": {
                const had = current.data !== undefined;
                load(current, signal => read(operations.getAudiobook(current.id), signal), book => {
                    current.data = book;
                    if (had) return host.focused() ?? current.focus;
                }, quiet || had);
                return;
            }
            case "boxSet": {
                const had = current.data !== undefined;
                load(current, async signal => {
                    try {
                        return await read(boxSetOperations.get(current.id, current.libraryId), signal);
                    } catch (error) {
                        if (signal.aborted || (error instanceof ApiError && error.aborted)) throw error;
                        const missing = error instanceof ApiError && error.status === 404;
                        if (!missing && current.data !== undefined) return current.data;
                        if (missing) current.data = undefined;
                        throw error;
                    }
                }, detail => {
                    current.data = detail;
                    if (had) return host.focused() ?? current.focus;
                }, quiet || had);
                return;
            }
            case "season":
                if (current.data?.details === undefined) stopDetails();
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
                    const previous = current.data?.details;
                    if (previous?.panel !== undefined || previous?.busy || previous?.preparingPlay) { current.stale = true; deferredDetails.add(current); return; }
                    deferredDetails.delete(current);
                    if (previous !== undefined && data.detail !== undefined) {
                        previous.acceptDetail(data.detail);
                        if (data.detail.played !== undefined) previous.values.set("watched", data.detail.played);
                        current.data = { ...data, details: previous };
                        detailWork = previous;
                        previous.start();
                        return;
                    }
                    stopDetails();
                    current.data = data;
                    if (data.detail !== undefined) {
                        const details = new DetailsState(data.detail, session, (audioClosed) => detailsChanged(current, audioClosed), (detail, signal) => refreshWatched(current, detail, signal), personalPending, translations, () => resolutionCap.quality, signal => resolutionCap.ready(signal));
                        details.presentsAlerts = true;
                        resolutionCap.ensure();
                        details.restore(previous);
                        current.data.details = details;
                        detailWork = details;
                        details.start();
                    }
                    if (current.focus === undefined && current.episodeId !== undefined && data.episodes.some(episode => episode.id === current.episodeId)) return { zone: "episodes", key: current.episodeId };
                }, quiet);
        }
    };

    /** PersonDetailView.onAppear: returning resumes only the metadata refresh; the loaded filmography is not read again. */
    const resumePersonRefresh = (current: Extract<Route, { kind: "person" }>): AbortSignal => {
        if (personRead?.route !== current) {
            personRead?.controller.abort();
            personRead = { route: current, controller: new AbortController() };
        }
        const signal = personRead.controller.signal;
        current.metadataRefresh ??= new PersonMetadataRefresh(clock, () => current.data?.person,
            refreshSignal => session.call({ ...detailOperations.refreshPerson(current.id), profileScoped: true, replayAfterRefresh: false, signal: refreshSignal }),
            readSignal => read(detailOperations.person(current.id), readSignal),
            person => {
                if (person !== undefined) current.data = { person };
                if (top() === current) render(host.focused());
            });
        current.metadataRefresh.start(signal);
        return signal;
    };

    /** The person's own metadata read; the caller sets metadataLoading first. */
    const readPersonMetadata = (current: Extract<Route, { kind: "person" }>, signal: AbortSignal): Promise<void> =>
        read(detailOperations.person(current.id), signal).then(person => {
            if (!signal.aborted) { current.data = { person }; current.metadataFailure = undefined; current.metadataError = undefined; current.metadataRefresh?.start(signal); }
        }, (error: unknown) => {
            if (!signal.aborted) { current.metadataFailure = failureText(error, current) ?? "Could not load metadata. Try again."; current.metadataError = errorState(error); }
        }).finally(() => { if (!signal.aborted) { current.metadataLoading = false; if (top() === current) render(); } });

    const availabilityPending = (current: Extract<Route, { kind: "person" }>): boolean => current.availableFilters === undefined && current.availabilityLoading !== true;

    /** PersonDetailView.refreshAvailableFilters: one single-item probe per type. A failed probe keeps its chip. */
    const probeAvailability = (current: Extract<Route, { kind: "person" }>, signal: AbortSignal): Promise<void> => {
        current.availabilityLoading = true;
        const probedGeneration = personFilterGeneration;
        return Promise.resolve().then(() => Promise.all((["movie", "series"] as const).map(async type => {
            try {
                const page = await read(operations.queryCatalogItems({ ...personQuery(current.id, type), limit: 1 }), signal);
                return page.items.length > 0 || (page.total ?? 0) > 0;
            } catch { return undefined; }
        }))).then(([movies, series]) => {
            // A filter chosen while these probes were out keeps its chip (PersonDetailView.swift refreshAvailableFilters).
            if (!signal.aborted && probedGeneration === personFilterGeneration) {
                current.availableFilters = ["video", ...(movies === false ? [] : ["movie" as const]), ...(series === false ? [] : ["series" as const])];
                current.availabilityLoading = false;
                if (top() === current) render();
            }
        });
    };

    const loadPage = (current: Route, pages: Pages, index: number, quiet = false): void => {
        if (current.kind === "person") {
            current.pendingIndex = index;
            const metadataSignal = resumePersonRefresh(current);
            const loadMetadata = current.data === undefined && current.metadataLoading !== true;
            const loadAvailability = availabilityPending(current);
            if (loadMetadata) current.metadataLoading = true;
            const commit = (page: CatalogPage, cursors: (string | undefined)[], committedIndex: number): void => {
                const focus = host.focused();
                const oldIndex = pages.page?.items.findIndex(item => item.id === focus?.key) ?? -1;
                const nearby = index === pages.index && focus?.zone === "grid" && oldIndex >= 0 && !page.items.some(item => item.id === focus.key)
                    ? page.items[Math.min(oldIndex, page.items.length - 1)] : undefined;
                pages.page = page;
                pages.index = committedIndex;
                pages.cursors = cursors.slice(0, committedIndex + 2);
                current.pendingIndex = undefined;
                render(nearby === undefined ? undefined : { zone: "grid", key: nearby.id });
            };
            load(current, async signal => {
                const repaint = (): void => { if (!metadataSignal.aborted && top() === current) render(); };
                const metadata = loadMetadata ? readPersonMetadata(current, metadataSignal) : Promise.resolve();
                const availability = loadAvailability ? probeAvailability(current, metadataSignal) : Promise.resolve();
                const credits = (async (): Promise<void> => {
                    const append = index > pages.index;
                    let items = append ? [...(pages.page?.items ?? [])] : [];
                    const cursors = append ? pages.cursors.slice(0, index + 1) : [undefined];
                    let page: CatalogPage | undefined;
                    let committedIndex = index;
                    for (let position = append ? index : 0; position <= index; position++) {
                        let startsOver = false;
                        try {
                            page = await read(operations.queryCatalogItems(personQuery(current.id, current.filter, cursors[position])), signal);
                        } catch (error) {
                            if (signal.aborted || position === 0 || !(error instanceof ApiError) || error.problemId !== "invalid_cursor") throw error;
                            // Apple nextCatalogPage replaces the list with a fresh first page once.
                            page = await read(operations.queryCatalogItems(personQuery(current.id, current.filter)), signal);
                            startsOver = true;
                            position = 0;
                            items = [];
                            cursors.splice(0, cursors.length, undefined);
                        }
                        if (signal.aborted) return;
                        if (page.nextCursor !== undefined && cursors.includes(page.nextCursor)) throw new ApiError({ kind: "invalid_response", path: "personFilmography.page.next_cursor" });
                        const seen = new Set(items.map(item => item.id));
                        items.push(...page.items.filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true; }));
                        cursors[position + 1] = page.nextCursor;
                        committedIndex = position;
                        if (startsOver || page.nextCursor === undefined) break;
                    }
                    if (page !== undefined) {
                        commit({ ...page, items }, cursors, committedIndex);
                    }
                })().catch((error: unknown) => {
                    if (!signal.aborted) { current.failure = failureText(error, current) ?? "Could not load titles. Try again."; repaint(); }
                    throw error;
                });
                void metadata;
                void availability;
                await credits;
            }, () => {}, quiet || pages.page !== undefined);
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
        if (current.kind === "library" || current.kind === "libraryResults") {
            load(current, async signal => {
                if (current.kind === "libraryResults" && current.source.kind === "collection") void probeShuffles();
                const cursor = pages.cursors[index];
                if (current.kind === "libraryResults" && current.source.kind === "section") {
                    return read(operations.queryCatalogItems({ ...librarySectionQuery(current.library.id, current.source.id), limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) }), signal);
                }
                const state = current.kind === "library" ? current.discovery : undefined;
                const recent = state?.mode === "Recently Added";
                const source = current.kind === "libraryResults" ? current.source : undefined;
                if (source?.kind === "collection") {
                    const original = serverLibrary(current.library.id);
                    const narrowed = original?.type === "mixed" && current.library.type !== "mixed";
                    return read(operations.queryCatalogItems({
                        source: source.groupKind === "user_collections" ? "user_collection" : "library_collection",
                        collection_id: source.id, limit: 60, match: "all",
                        ...(narrowed ? libraryScope(current.library) : {}),
                        ...(cursor === undefined ? {} : { cursor }),
                    }), signal);
                }
                const query = operations.queryCatalogItems({
                    ...libraryScope(current.library), limit: PAGE_SIZE,
                    sort: recent ? "added_at" : "title",
                    order: recent || state?.descending === true || (current.kind === "libraryResults" && current.descending) ? "desc" : "asc",
                    ...(cursor === undefined ? {} : { cursor }),
                    ...(state?.seek === undefined || index !== 0 ? {} : { seek: state.seek, ...(state.windowCursor === undefined ? {} : { cursor: state.windowCursor }) }),
                    ...(source?.kind === "genre" ? { groups: genreGroups(source.name) } : {}),
                    ...(state?.genre === undefined ? {} : { groups: genreGroups(state.genre) }),
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
        if (current.kind === "search") loadSearch(current, false, quiet);
    };

    /**
     * SearchViewModel.performSearch: a new search keeps the shown results until its first page answers, then replaces
     * them; `append` adds the next page to the same list (loadMore), or starts the list over when the server rejects
     * the cursor (SiloAPI.nextCatalogPage).
     */
    const loadSearch = (current: Extract<Route, { kind: "search" }>, append: boolean, quiet = false): void => {
        const query = current.query;
        const filter = current.filter;
        const shown = current.pages;
        // A quiet reread of the answered query and filter (a card change marks every route stale) keeps every loaded page.
        const depth = quiet && !append && shown?.page !== undefined && current.resultsFor === query && current.resultsFilter === filter ? shown.index + 1 : 1;
        current.appending = append;
        load(current, async signal => {
            if (append && shown?.page !== undefined) {
                const cursor = shown.cursors[shown.index + 1];
                const scope = searchTypeFor(current, current.searchType ?? "video");
                const first = (): Promise<CatalogPage> => read(operations.listCatalogItems({ q: query.trim(), type: scope, limit: SEARCH_PAGE_SIZE, cursor: undefined }), signal);
                let rejected: unknown;
                try {
                    const seen = new Set(shown.page.items.map(item => item.id));
                    const skipped: (string | undefined)[] = [];
                    for (let next = cursor; ;) {
                        const page = await read(operations.listCatalogItems({ q: query.trim(), type: scope, limit: SEARCH_PAGE_SIZE, cursor: next }), signal);
                        if (page.nextCursor !== undefined && (shown.cursors.includes(page.nextCursor) || skipped.includes(page.nextCursor))) {
                            rejected = new ApiError({ kind: "invalid_response", path: "search.page.next_cursor" });
                            break;
                        }
                        // The end observer asks again only when cards are added, so a page of cards already shown reads on.
                        if (page.nextCursor === undefined || page.items.some(item => !seen.has(item.id))) return { page, startsOver: false, skipped };
                        skipped.push(page.nextCursor);
                        next = page.nextCursor;
                    }
                } catch (error) {
                    if (signal.aborted || !(error instanceof ApiError) || error.problemId !== "invalid_cursor") throw error;
                    rejected = error;
                }
                // Restart once; a restarted list whose cursor is rejected again shows the error until Try Again, not an endless reread.
                if (current.restarted === true) throw rejected;
                return { page: await first(), startsOver: true };
            }
            let type = current.searchType;
            if (type === undefined) {
                const capability = await read(operations.getCatalogSearchCapabilities(), signal);
                type = capability.allowed && capability.state === "available" && capability.videoWithEpisodesScope === true
                    ? "video_with_episodes" : "video";
                if (!signal.aborted && top() === current && current.query === query) {
                    current.searchType = type;
                    current.peopleSupported = capability.allowed && capability.state === "available" && capability.peopleMediaScope === true;
                    current.boxSetsSupported = capability.boxSets === true;
                    boxSetsAnswer = Promise.resolve(current.boxSetsSupported);
                }
            }
            if (signal.aborted || top() !== current || current.query !== query) throw new DOMException("Aborted", "AbortError");
            searchPeople(current, searchTypeFor(current, type));
            searchBoxSets(current);
            let page = await read(operations.listCatalogItems({ q: query.trim(), type: searchTypeFor(current, type), limit: SEARCH_PAGE_SIZE, cursor: undefined }), signal);
            const cursors: (string | undefined)[] = [undefined, page.nextCursor];
            const items = [...page.items], seen = new Set(items.map(item => item.id));
            while (cursors.length - 1 < depth && page.nextCursor !== undefined) {
                try {
                    page = await read(operations.listCatalogItems({ q: query.trim(), type: searchTypeFor(current, type), limit: SEARCH_PAGE_SIZE, cursor: page.nextCursor }), signal);
                } catch (error) {
                    // The list changed under the refresh: keep the fresh pages read so far, as a restarted list does.
                    if (signal.aborted || !(error instanceof ApiError) || error.problemId !== "invalid_cursor") throw error;
                    break;
                }
                if (page.nextCursor !== undefined && cursors.includes(page.nextCursor)) throw new ApiError({ kind: "invalid_response", path: "search.page.next_cursor" });
                for (const item of page.items) if (!seen.has(item.id)) { seen.add(item.id); items.push(item); }
                cursors.push(page.nextCursor);
            }
            return { page: { ...page, items }, startsOver: true, cursors };
        }, ({ page, startsOver, cursors, skipped }) => {
            current.appending = false;
            // A restarted list keeps its guard until a new search or Try Again, so a good page between rejections cannot loop.
            current.restarted = append && (startsOver || current.restarted === true);
            current.resultsFor = query;
            current.resultsFilter = filter;
            if (startsOver || shown?.page === undefined) {
                current.pages = { page, index: (cursors?.length ?? 2) - 2, cursors: cursors ?? [undefined, page.nextCursor] };
                return;
            }
            const seen = new Set(shown.page.items.map(item => item.id));
            shown.page = { ...page, items: [...shown.page.items, ...page.items.filter(item => !seen.has(item.id))] };
            shown.index += 1 + (skipped?.length ?? 0);
            shown.cursors.push(...(skipped ?? []), page.nextCursor);
        }, quiet || shown?.page !== undefined);
    };

    let searchReturnFocus: { readonly route: Extract<Route, { kind: "search" }>; readonly target: FocusTarget } | undefined;
    /** SearchViewModel.resetState: an empty field clears every section at once. */
    const clearSearch = (current: Extract<Route, { kind: "search" }>): void => {
        loading?.abort();
        loading = undefined;
        stopSearchSupplement();
        current.pages = undefined;
        current.resultsFor = "";
        current.supplement = {};
        current.failure = undefined;
        current.error = undefined;
    };
    /** Titles, People, box sets and Requests each stay on screen until their own replacement answers. */
    const search = (current: Extract<Route, { kind: "search" }>, quiet = false): void => {
        searchReturnFocus = undefined;
        cancelSearch();
        stopSearchSupplement();
        current.failure = undefined;
        if (current.query.trim() === "") {
            clearSearch(current);
            render();
            return;
        }
        searchRequests(current);
        current.pages ??= newPages();
        loadSearch(current, false, quiet);
        render();
    };
    const moreSearch = (current: Extract<Route, { kind: "search" }>): void => {
        if (torn || playing || top() !== current || loading !== undefined || cardActions.active || settingsScreen !== undefined || current.failure !== undefined || current.query !== current.resultsFor || current.filter !== current.resultsFilter || current.pages?.page?.nextCursor === undefined) return;
        loadSearch(current, true, true);
        render(host.focused());
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
        cancelSearch();
        // Only the replacement request is debounced; an obsolete read stops immediately, and what it replaces stays shown.
        stopSearchSupplement();
        if (current.query.trim() === "") clearSearch(current);
        else if (current.query.trim().length <= 1) searchRequests(current);
        render(host.focused());
        if (current.query.trim() !== "") cancelSearch = clock.schedule(() => search(current), SEARCH_DELAY_MS);
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
        retireRoute(stack.pop());
        const current = top();
        if (current?.kind === "requests" && !requestsCapability.enabled) { closeRequests(); return; }
        if (current !== undefined) {
            if (current.kind === "personal" || current.kind === "calendar" || current.kind === "requests") {
                if (current.kind === "personal") current.pendingIndex = undefined;
                current.stale = true;
            }
            // Apple keeps the loaded filmography (loadInitial runs only while empty); a visit that never got its first page reads it now.
            if (current.kind === "person" && current.pages.page === undefined) current.stale = true;
            const fromProfileMenu = (active?.kind === "requests" && active.requests.source.kind === "hub") || active?.kind === "personal" || active?.kind === "watchParty";
            if (current.kind === "item" && current.data?.details?.series !== undefined && (active?.kind === "season" || active?.kind === "item" && active.data?.detail.type === "episode")) {
                const details = current.data.details, series = details.series;
                details.focusedEpisodeId = undefined;
                if (series !== undefined) { series.selectionOwnsHero = false; series.focusSelectedEpisode = false; }
                current.focus = { zone: "actions", key: "next-episode" };
                host.forgetVisit(`item:${current.id}`);
            }
            showRoute(current, fromProfileMenu ? tabFocus(current) : current.focus);
            if (current.kind === "person") {
                const signal = resumePersonRefresh(current);
                // A visit without its first page reads everything through load(); otherwise only what Details aborted or changed.
                if (current.pages.page !== undefined) {
                    // Deliberate improvement over Apple (its loadInitial needs the person and the items both missing): read a missing person once the titles are loaded, because Details can abort the first metadata read.
                    if (current.data === undefined && current.metadataLoading !== true) { current.metadataLoading = true; void readPersonMetadata(current, signal); }
                    if (availabilityPending(current)) void probeAvailability(current, signal);
                }
            }
        }
    };

    const push = (next: Route, focus?: FocusTarget): void => {
        stopSearchSupplement();
        shuffleGeneration++;
        const current = top();
        const panel = (current?.kind === "item" || current?.kind === "season") ? current.data?.details?.panel : undefined;
        // Capture before stopDetails clears fetching so Back reloads and restores observation.
        const trailerFetchInFlight = current?.kind === "item" && current.data?.details?.trailers.fetching === true;
        stopDetails();
        if (current !== undefined) {
            current.focus = panel === undefined ? host.focused() : { zone: "actions", key: panel };
            if (current.kind === "homeSection" || current.kind === "person") current.pendingIndex = undefined;
            if (current.kind === "boxSet" || trailerFetchInFlight) current.stale = true;
        }
        loading?.abort();
        loading = undefined;
        cancelSearch();
        stack.push(next);
        showRoute(next, focus);
    };

    /** push() without keeping the top page: Back from the new page returns to the one beneath. */
    const replaceTop = (next: Route): void => {
        stopSearchSupplement();
        shuffleGeneration++;
        stopDetails();
        loading?.abort();
        loading = undefined;
        cancelSearch();
        retireRoute(stack.pop());
        stack.push(next);
        showRoute(next, undefined);
    };

    const tabFocus = (current: Route): FocusTarget => ({ zone: "nav", key: current.kind === "library" ? (current.library.type === "music" ? "music" : current.library.type === "audiobooks" ? "audiobooks" : current.library.type === "series" ? "series" : "movies") : current.kind === "personal" ? current.anchor ?? "profiles" : current.kind === "requests" || current.kind === "watchParty" ? current.anchor ?? "home" : current.kind });

    const showRoute = (current: Route, focus: FocusTarget | undefined): void => {
        if (current.kind === "home" && current.data === undefined) {
            const sections = cache.peek(operations.listHomeSections());
            if (sections !== undefined) {
                const libraries = cache.peek(operations.listUserLibraries()) ?? [];
                current.data = { sections, libraries: visibleLibraries(libraries, cache.peek(operations.hiddenLibraries()) ?? []) };
                shell.update(current.data.libraries);
                current.stale = true;
            }
        } else if (current.kind === "for_you" && current.data === undefined) {
            // RecommendationsViewModel.init shows cached rows at once; with none, the page loads.
            const cached = cache.peek(operations.recommendations());
            if ((browsableRows(cached)?.length ?? 0) > 0) {
                current.data = cached;
                current.stale = true;
            }
        } else if (current.kind === "item" && current.data === undefined) {
            const cached = cache.peek(operations.getCatalogItem(current.id));
            const previous = visitedDetails.get(current.id);
            const detail = cached === undefined ? undefined : previous?.detail ?? cached;
            if (detail !== undefined) {
                const seasons = cache.peek(operations.listSeriesSeasons(current.id)) ?? [];
                const details = createItemDetails(current, detail);
                details.restore(previous);
                if (detail.type === "series") details.series = new SeriesEpisodes(session, detail.id, seasons, reason => details.warmSeriesEpisodes(reason === "load"), current.seriesContext?.seasonNumber ?? (current.seriesContext === undefined ? seriesSeasons.get(current.id) : undefined), current.seriesContext?.episodeId);
                details.series?.restore(previous?.series, false, true);
                if (detail.type === "series") details.focusedEpisodeId = current.seriesContext?.episodeId;
                current.data = { detail, seasons, details };
                cachedDetailOwners.add(details);
                current.stale = true;
            }
        }
        searchReturnFocus = current.kind === "search" && focus?.zone === "search-requests" && current.supplement?.requests === undefined
            ? { route: current, target: focus } : undefined;
        if (current.kind === "calendar") {
            try { prepareCalendar(current); }
            catch (error) { current.failure = error instanceof Error ? error.message : "Could not read this TV’s timezone. Try again."; }
        }
        if (current.kind === "search") {
            input.value = current.query;
            if (current.supplement?.peoplePending && current.searchType !== undefined && current.query === current.resultsFor) searchPeople(current, searchTypeFor(current, current.searchType));
            if (current.supplement?.boxSetsPending === true && current.boxSetsSupported === true && current.query === current.resultsFor) searchBoxSets(current);
            if (current.supplement !== undefined && current.supplement.requests === undefined) current.supplement.requestsFor = undefined;
            searchRequests(current);
        }
        homeDetails.suspend();
        render(focus);
        if ((current.kind === "item" || current.kind === "season") && current.data?.details !== undefined && (!current.stale || cachedDetailOwners.has(current.data.details))) {
            detailWork = current.data.details;
            detailWork.start();
        }
        // A query or filter whose answer an earlier push interrupted is searched again on return.
        const queryChanged = current.kind === "search" && (current.query !== current.resultsFor || current.filter !== current.resultsFilter);
        if (!hasData(current) || current.stale || current.failure !== undefined || queryChanged) {
            loadRoute(current, hasData(current) && !queryChanged);
            if (current.kind === "calendar") render(focus);
        } else if (current.kind === "item" && current.data !== undefined && current.data.detail.type === "movie" && current.data.boxSet !== undefined) {
            // push() stopped this read. The cached movie is not loaded again, so start it once.
            boxSetRowWork = current.data.boxSet;
            boxSetRowWork.start();
        } else if ((current.kind === "home" || current.kind === "for_you") && current.data !== undefined) {
            const sections = current.kind === "home" ? current.data.sections : current.data;
            presentEnrichment(sections, current.kind === "for_you");
            if (current.kind === "home") upgradeHomeArtwork();
        } else if (current.kind === "library" && current.discovery?.mode === "Recommended" && current.discovery.data !== undefined) {
            presentEnrichment(current.discovery.data.sections.filter(section => section.featured !== true), false);
            upgradeLibraryArtwork();
        }
    };

    const open = (destination: Destination): void => {
        if (destination.kind === "item" && destination.fromRelated === true) {
            // AppRouter.relatedTitleStep: the title on screen does nothing; from a page a related pick
            // opened, the title under it goes back and any other replaces the top page.
            // A related season or episode opens its series with a context, so the context is part of the title.
            // An episode id names the title on its own; the season number is optional on a card.
            const shows = (route: Route | undefined): boolean => {
                if (route?.kind !== "item" || route.id !== destination.id) return false;
                const here = route.seriesContext, there = destination.seriesContext;
                if (here?.episodeId !== undefined || there?.episodeId !== undefined) return here?.episodeId === there?.episodeId;
                return here?.seasonNumber === there?.seasonNumber;
            };
            const current = top(), start = stack[stack.length - 2];
            if (shows(current)) return;
            if (current?.kind === "item" && current.fromRelated === true) {
                if (shows(start)) { pop(); return; }
                host.forgetVisit(`item:${destination.id}`);
                replaceTop(newRoute({ kind: "item", id: destination.id, title: destination.title, ...(destination.seriesContext === undefined ? {} : { seriesContext: destination.seriesContext }), ...(destination.seed === undefined ? {} : { seed: destination.seed }), fromRelated: true, data: undefined }));
                return;
            }
        }
        if (destination.kind === "item") host.forgetVisit(`item:${destination.id}`);
        if (destination.kind === "person") host.forgetVisit(`person:${destination.id}`);
        if (destination.kind === "audiobook") { push(newRoute({ kind: "audiobook", id: destination.id, title: destination.title, data: undefined })); return; }
        push(destination.kind === "item"
            ? newRoute({ kind: "item", id: destination.id, title: destination.title, ...(destination.seriesContext === undefined ? {} : { seriesContext: destination.seriesContext }), ...(destination.seed === undefined ? {} : { seed: destination.seed }), ...(destination.fromRelated === true ? { fromRelated: true } : {}), data: undefined })
            : destination.kind === "person" ? newRoute({ kind: "person", id: destination.id, title: destination.title, data: undefined, filter: "video", pages: newPages(), pendingIndex: undefined })
            : newRoute({ kind: "season", ...(destination.id === undefined ? {} : { id: destination.id }), ...(destination.episodeId === undefined ? {} : { episodeId: destination.episodeId }), seriesId: destination.seriesId, seasonNumber: destination.seasonNumber, title: destination.title, data: undefined }));
    };

    const play = (request: PlayRequest): void => {
        activeSection?.stop();
        if (activeBrowse !== undefined) stopFeed(activeBrowse);
        const current = top();
        if (current === undefined || torn || playing) return;
        const details = current.kind === "item" || current.kind === "season" ? current.data?.details : undefined;
        if (request.episode === true && details?.episodePreferencesBlocked) return;
        const focus = host.focused();
        if (details === undefined) handoff(request);
        else {
            loading?.abort();
            loading = undefined;
            cancelSlow();
            detailWork = details;
            details.start();
            const playbackState = details.nextEpisodeState?.detail.id === request.contentId ? details.nextEpisodeState : details;
            playbackState.preparePlay(request, clock, resolved => {
                if (resolved.episode === true && details.episodePreferencesBlocked) { playbackState.deferPlay(request); return; }
                handoff(resolved, focus);
            });
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
        // Theme audio is gone before the player opens AVPlay.
        syncThemeMusic();
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
        syncThemeMusic();
        activeSection?.stop();
        if (activeBrowse !== undefined) stopFeed(activeBrowse);
        activeSection = undefined;
        activeBrowse = undefined;
        cancelCalendarDay();
        const current = top();
        if (current?.kind === "requests") syncRequestActions(current);
        if (current === undefined || torn || playing || cardActions.active || requestMenu.active || settingsScreen !== undefined) {
            return;
        }
        // A card-change failure that arrived while another owner held the screen shows once this render settles.
        queueMicrotask(() => cardActions.showDeferredAlert());
        if (searchReturnFocus?.route === current && current.kind === "search" && current.supplement?.requests !== undefined) {
            if (current.supplement.requests.some(title => `${title.mediaType}:${title.tmdbId}` === searchReturnFocus?.target.key)) focus = searchReturnFocus.target;
            searchReturnFocus = undefined;
        }
        if (current.kind === "calendar") {
            const midnight = new Date(clock.now());
            midnight.setHours(24, 0, 0, 0);
            cancelCalendarDay = clock.schedule(() => render(host.focused()), midnight.getTime() - clock.now());
        }
        shell.setAvatar(profileName, profileAvatarUrl, context.baseUrl, profileAvatarText);
        if (current.kind === "library") shell.setLibraryModes(availableModes(current.discovery?.data?.capabilities ?? current.discovery?.capabilities));
        const searchFilter = (route: Extract<Route, { kind: "search" }>, filter: SearchFilter | undefined): void => {
            if (top() !== route || route.filter === filter) return;
            loading?.abort(); loading = undefined; cancelSlow();
            route.filter = filter; search(route);
        };
        const handlers = { context, focusDefault: () => host.focusDefault(), busy: loading !== undefined, searchHead, input, searchFilter, audiobooksEnabled: audiobooksInSearch(), push, pop, play, chooseProfile, retry, turn, audiobookPicker, mode, jump, sort, genre, personalFilter, morePersonal, morePerson, moreSearch, signIn: options.onSignOut, personFilter, calendar: calendarHandlers, requests: requestsHandlers, browse: changeBrowse, more: moreBrowse, preserve: (route: Extract<Route, { kind: "library" }>) => browsePrefs.preserve(route.library), gridColumns: presentation.posterScale > 1 ? 5 : 6, shuffle: (current.kind === "library" || current.kind === "libraryResults" && current.source.kind === "collection") && canShuffle(current) ? { starting: shuffleStarting, failure: shuffleFailure?.route === current ? shuffleFailure.text : undefined, start: startShuffle, dismiss: () => { shuffleFailure = undefined; render({ zone: "controls", key: "shuffle" }); } } : undefined };
        container.classList.toggle("section-catalog", isSectionRoute(current));
        const browsing = current.kind === "library" && current.discovery?.mode === "Browse";
        container.classList.toggle("library-browse", browsing);
        container.classList.toggle("personal-lists", current.kind === "personal" && current.source !== "history");
        container.classList.toggle("personal-history", current.kind === "personal" && current.source === "history");
        container.classList.toggle("requests-scene", current.kind === "requests");
        container.classList.toggle("watch-party-scene", current.kind === "watchParty");
        container.classList.toggle("search-scene", current.kind === "search");
        // SearchView.searchPrompt: the field names audiobooks only while they take part in Search.
        if (current.kind === "search") input.placeholder = audiobooksInSearch() ? "Search movies, series, audiobooks..." : "Search movies and series...";
        container.classList.toggle("details-series-scene", current.kind === "item" && current.data?.detail.type === "series");
        container.classList.toggle("requests-hub", current.kind === "requests" && current.requests.source.kind === "hub");
        if (browsing) activeBrowse = current.pages;
        const feedOwner = current.kind === "personal" || current.kind === "person" || current.kind === "search" ? current.pages : undefined;
        if (feedOwner !== undefined) {
            if (activePersonal !== undefined && activePersonal !== feedOwner) stopFeed(activePersonal);
            activePersonal = feedOwner;
        } else if (activePersonal !== undefined) {
            stopFeed(activePersonal);
            activePersonal = undefined;
        }
        if (isSectionRoute(current)) activeSection = sectionCatalog(current);
        const view = activeSection !== undefined && isSectionRoute(current)
            ? activeSection.view(current, context, loading !== undefined, pop, () => retry(current), () => {
                if (top() !== current || torn || playing || loading !== undefined || cardActions.active || settingsScreen !== undefined || current.failure !== undefined || current.pages.page?.nextCursor === undefined) return;
                loadSection(current, true, true);
            }, options.onSignOut) : routeView(current, { ...handlers, manageServers: options.onSwitchServer === undefined ? undefined : () => { options.onSwitchServer?.(() => render()); }, retryPeople: route => {
                if (top() !== route || route.searchType === undefined || route.query.trim() === "") return;
                searchPeople(route, searchTypeFor(route, route.searchType));
                render(host.focused());
            } });
        // An open room is a full-screen page, as on tvOS; the entry stays under the bar.
        const rootRoute = current.kind === "home" || current.kind === "for_you" || current.kind === "library" || (current.kind === "personal" && current.source !== "history") || current.kind === "calendar" || isHubRoot(current) || (current.kind === "watchParty" && current.watchParty.hub.state.room === undefined);
        cancelOfflineRefresh();
        if (offlineRefreshRoute !== current) offlineRefreshAt = undefined;
        offlineRefreshRoute = current;
        if (routeOffline(current) || deferredDetails.has(current)) {
            // Optional response repaints must not postpone an already scheduled recovery.
            offlineRefreshAt ??= clock.now() + 15000;
            cancelOfflineRefresh = clock.schedule(() => recoverCachedRoute(current), Math.max(0, offlineRefreshAt - clock.now()));
        } else offlineRefreshAt = undefined;
        if (rootRoute) {
            const selected = tabFocus(current).key;
            // Apple's HomeView with no sections shows only EmptyStateView: no marquee, and no remembered card replayed into it.
            const preview = (current.kind === "home" && current.data !== undefined && !view.zones.some(zone => zone.id === "empty")) || (current.kind === "for_you" && (shownRows(current)?.length ?? 0) > 0) || (current.kind === "library" && current.library.type !== "music" && (current.discovery?.mode ?? "Recommended") === "Recommended");
            // A marquee rest armed on remembered rows must not read their card once Home is empty.
            if (current.kind === "home" && !preview) homeDetails.suspend();
            const modal = browsing && (current.discovery?.panel !== undefined || shuffleFailure?.route === current);
            const decorated = shell.decorate(view, selected, preview, modal ? () => { view.back?.(); } : current.kind === "personal" || isHubRoot(current) || current.kind === "watchParty" ? () => {
                if (host.focused()?.zone === "nav") pop();
                else render(tabFocus(current));
            } : (current.kind === "library" && current.discovery?.genre !== undefined) ? pop : undefined, current.kind === "library" ? `library:${current.library.id}:${current.library.type}:${current.discovery?.mode ?? "Recommended"}` : undefined);
            // A bar-focused return does not focus a card to restore this page's hero.
            if (preview && host.name !== view.name) previews.get(current)?.();
            const nav = container.querySelector<HTMLElement>(".browse-nav");
            if (nav !== null) { nav.inert = modal || nav.inert; if (nav.inert) nav.setAttribute("aria-hidden", "true"); else nav.removeAttribute("aria-hidden"); }
            host.show({ ...decorated, ...(current.kind === "library" ? { ready: hasData(current), ...(current.discovery?.genre !== undefined ? { back: pop } : {}) } : {}), ...(modal ? { zones: view.zones, back: view.back } : {}) }, focus);
        } else {
            const removedEpisodeRetry = host.focused()?.key === "retry-episodes" && !view.zones.some(zone => zone.items.some(item => item.key === "retry-episodes"));
            host.holdVisit();
            shell.hide();
            if (current.kind === "item" || current.kind === "audiobook") {
                let visitKey = detailVisits.get(current);
                if (visitKey === undefined) {
                    visitKey = `details-visit:${++detailVisitSequence}`;
                    detailVisits.set(current, visitKey);
                }
                host.show({ ...view, visitKey: `${visitKey}:${view.name}` }, focus);
            } else host.show(view, focus);
            if (removedEpisodeRetry && host.focused()?.zone === "actions") host.scrollToTop();
        }
    };

    const retry = (current: Route): void => {
        current.failure = undefined;
        current.error = undefined;
        // PersonDetailViewModel.reload clears the person's error too, so the page shows loading rather than the old failure.
        if (current.kind === "person") { current.metadataFailure = undefined; current.metadataError = undefined; }
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
    const requestListRoutes = (): Extract<Route, { kind: "requests" }>[] => [...new Set([...roots.values(), ...stack])].filter((route): route is Extract<Route, { kind: "requests" }> => route.kind === "requests");
    const dismissRequestNotice = (): void => {
        clearRequestNotice();
        clearRequestNotice = () => undefined;
        requestGate.notice = undefined;
    };
    const requestFocusSurvives = (route: Extract<Route, { kind: "requests" }>, target: FocusTarget | undefined): boolean => {
        if (target === undefined) return false;
        const data = route.requests.data;
        const state = route.requests;
        if (data !== undefined && "sections" in data) {
            if (visibleMineRequests(data.mine.items, state.actingId, state.heldIds ?? []).some(item => item.id === target.key)) return true;
            return data.sections.some(section => section.results.some(item => `${item.mediaType}:${item.tmdbId}` === target.key));
        }
        if (data !== undefined && "items" in data && route.requests.source.kind === "mine") {
            return visibleMineRequests(data.items, state.actingId, state.heldIds ?? []).some(item => item.id === target.key);
        }
        return true;
    };
    const showRequestList = (route: Extract<Route, { kind: "requests" }>, focus: FocusTarget, revision: number): void => {
        syncRequestActions(route);
        const moved = inputRevision !== revision ? host.focused() : undefined;
        // Keep moved focus only when that target still exists after cancel/remove paint; otherwise use the captured neighbor.
        const next = moved !== undefined && requestFocusSurvives(route, moved) ? moved : focus;
        route.focus = next;
        if (top() !== route || requestMenu.active) return;
        render(next);
    };
    const listFocusAfter = (route: Extract<Route, { kind: "requests" }>, id: string, fallback: FocusTarget): FocusTarget => {
        const data = route.requests.data;
        if (data !== undefined && ("sections" in data || (route.requests.source.kind === "mine" && "items" in data))) return focusAfterRemoval(data, id);
        return fallback;
    };
    let requestReread = 0;
    /** Apple's re-read after a remove, and the read that settles a hold. A stale answer installs nothing. */
    const rereadRequestList = async (route: Extract<Route, { kind: "requests" }>): Promise<boolean> => {
        const source = route.requests.source;
        if (source.kind !== "hub" && source.kind !== "mine") return false;
        const generation = ++requestReread;
        const startedEpoch = requestGate.epoch;
        const covered = requestGate.cover();
        const current = (): boolean => !torn && generation === requestReread && startedEpoch === requestGate.epoch;
        try {
            if (source.kind === "hub") {
                const [sections, mine] = await Promise.all([read(once(requestOperations.discover()), requestsController.signal), readMyRequests(requestsController.signal)]);
                if (!current()) return false;
                route.requests.data = { sections, mine: { ...mine, items: requestGate.filter(mine.items) } };
            } else {
                const page = await read(requestOperations.mine(source.cursor), requestsController.signal);
                if (!current()) return false;
                route.requests.data = { ...page, items: requestGate.filter(page.items) };
            }
            route.failure = undefined;
            requestGate.releaseHolds(covered);
            return true;
        } catch (error) {
            if (!current() || (error instanceof ApiError && error.aborted)) return false;
            if (error instanceof ApiError && ["capability_disabled", "capability_not_configured", "capability_unsupported", "permission_denied"].includes(error.problemId ?? "")) void probeRequests();
            return false;
        }
    };
    const dropRemovedRequest = (id: string): void => {
        requestGate.drop(id);
        const visible = top();
        for (const route of requestListRoutes()) {
            const data = route.requests.data;
            if (data !== undefined && "sections" in data) route.requests.data = { ...data, mine: { ...data.mine, items: requestGate.filter(data.mine.items) } };
            else if (data !== undefined && "items" in data && route.requests.source.kind === "mine") route.requests.data = { ...data, items: requestGate.filter(data.items) };
            if (route !== visible) route.stale = true;
        }
    };
    const paintRequestRecord = (updated: MediaRequest): void => {
        for (const route of requestListRoutes()) {
            const data = route.requests.data;
            if (data !== undefined && "sections" in data) route.requests.data = { ...data, mine: { ...data.mine, items: data.mine.items.map(item => item.id === updated.id ? updated : item) } };
            else if (data !== undefined && "items" in data && route.requests.source.kind === "mine") route.requests.data = { ...data, items: data.items.map(item => item.id === updated.id ? updated : item) };
        }
    };
    /** Apple's hub/mine actionRefresh: settle the Requests page that is on screen. */
    const visibleRequestList = (origin: Extract<Route, { kind: "requests" }>): Extract<Route, { kind: "requests" }> => {
        const visible = top();
        return visible?.kind === "requests" ? visible : origin;
    };
    const showVisibleRequestList = (origin: Extract<Route, { kind: "requests" }>, focus: FocusTarget, revision: number): Extract<Route, { kind: "requests" }> => {
        const target = visibleRequestList(origin);
        showRequestList(target, target === origin ? focus : (target.focus ?? focus), revision);
        return target;
    };
    /** Hub/mine reread, or detail reload when the visible page is a request detail. */
    const settleVisibleRequests = async (origin: Extract<Route, { kind: "requests" }>, focus: FocusTarget, revision: number): Promise<void> => {
        const target = showVisibleRequestList(origin, focus, revision);
        const source = target.requests.source.kind;
        if (source === "hub" || source === "mine") {
            await rereadRequestList(target);
            showVisibleRequestList(origin, focus, revision);
            return;
        }
        if (top() !== target || torn) return;
        // Detail-write completion reloads the visible detail after a list mutation.
        target.requests.uncertain = true;
        loadRoute(target, true);
    };
    const finishRemoval = async (route: Extract<Route, { kind: "requests" }>, id: string, fallback: FocusTarget, revision: number): Promise<void> => {
        // Neighbor focus must be taken from the pre-removal list (AGENTS.md restore by id).
        const focus = listFocusAfter(route, id, fallback);
        dropRemovedRequest(id);
        publishRequestNotice(REMOVED_NOTICE);
        await settleVisibleRequests(route, focus, revision);
    };
    const runListRemove = async (route: Extract<Route, { kind: "requests" }>, record: MediaRequest, origin: FocusTarget): Promise<void> => {
        dismissRequestNotice();
        const token = requestGate.begin(record.id);
        if (token === undefined || torn) return;
        const revision = inputRevision;
        showVisibleRequestList(route, origin, revision);
        try {
            await session.call({ ...requestOperations.remove(record.id), profileScoped: true, replayAfterRefresh: false });
            await finishRemoval(route, record.id, origin, revision);
        } catch (error) {
            if (torn) return;
            if (error instanceof ApiError && error.problemId === "not_found") {
                await finishRemoval(route, record.id, origin, revision);
                return;
            }
            if (writeMayHaveApplied(error)) {
                requestGate.hold(record.id);
                requestGate.release(token);
                // Capture the neighbor before readback, as finishRemoval does: if the server already
                // dropped the card, FocusHost cannot recover a replacement from the missing quick action.
                const focus = listFocusAfter(visibleRequestList(route), record.id, origin);
                if (!(error instanceof ApiError && error.aborted)) await settleVisibleRequests(route, focus, revision);
                if (requestGate.held.has(record.id)) requestGate.listMessage = UNCONFIRMED_REMOVE_MESSAGE;
                showVisibleRequestList(route, focus, revision);
                return;
            }
            const message = error instanceof ApiError && error.problemId === "conflict" ? REMOVE_CONFLICT_MESSAGE : writeFailureMessage(error);
            if (error instanceof ApiError && ["capability_disabled", "capability_not_configured", "capability_unsupported", "permission_denied"].includes(error.problemId ?? "")) void probeRequests();
            await settleVisibleRequests(route, origin, revision);
            requestGate.listMessage = message;
            showVisibleRequestList(route, origin, revision);
        } finally {
            requestGate.release(token);
            if (!torn) showVisibleRequestList(route, route.focus ?? origin, revision);
        }
    };
    const runListCancel = async (route: Extract<Route, { kind: "requests" }>, record: MediaRequest, origin: FocusTarget): Promise<void> => {
        dismissRequestNotice();
        const token = requestGate.begin(record.id);
        if (token === undefined || torn) return;
        const revision = inputRevision;
        showVisibleRequestList(route, origin, revision);
        try {
            const updated: unknown = await session.call({ ...requestOperations.cancel(record.id), profileScoped: true, replayAfterRefresh: false });
            const listed = visibleRequestList(route);
            const focus = listFocusAfter(listed, record.id, origin);
            // Tombstone + epoch so an ordinary hub/mine load that started before this cancel cannot put the pending row back (filter strips it; mine also fences on epoch).
            requestGate.drop(record.id);
            if (typeof updated === "object" && updated !== null && "id" in updated && "outcome" in updated) paintRequestRecord(updated as MediaRequest);
            // Apple's hub applies the cancel result in place and does not reload (RequestsHubViewModel.applyRequestUpdate). A reload here can put the pending row back.
            const kind = listed.requests.source.kind;
            if (kind === "hub" || kind === "mine") showRequestList(listed, focus, revision);
            else await settleVisibleRequests(route, focus, revision);
        } catch (error) {
            if (torn) return;
            if (writeMayHaveApplied(error)) {
                requestGate.hold(record.id);
                requestGate.release(token);
                const focus = listFocusAfter(visibleRequestList(route), record.id, origin);
                if (!(error instanceof ApiError && error.aborted)) await settleVisibleRequests(route, focus, revision);
                if (requestGate.held.has(record.id)) requestGate.listMessage = UNCONFIRMED_CANCEL_MESSAGE;
                showVisibleRequestList(route, focus, revision);
                return;
            }
            // Match detail-write refusals: RequestDetailViewModel refreshes capability and retires entry.
            if (error instanceof ApiError && ["capability_disabled", "capability_not_configured", "capability_unsupported", "permission_denied"].includes(error.problemId ?? "")) void probeRequests();
            requestGate.listMessage = writeFailureMessage(error);
            showVisibleRequestList(route, origin, revision);
        } finally {
            requestGate.release(token);
            if (!torn) showVisibleRequestList(route, route.focus ?? origin, revision);
        }
    };
    const openRequests = (source: RequestsSource): void => {
        if (!requestsCapability.enabled) return;
        // The profile menu's hub is a root page under the bar, like Watchlist: the tab it opened over stays selected.
        // Opening it replaces any other profile-menu root, including itself, so one Back pair still returns to that tab.
        if (source.kind === "hub") clearPersonalRoot();
        const origin = source.kind === "hub" ? top() : undefined;
        const anchor = origin === undefined ? undefined : tabFocus(origin).key;
        push(newRoute({ kind: "requests", requests: requestsState(source), ...(anchor === undefined ? {} : { anchor }) }));
        if (origin !== undefined && anchor !== undefined) origin.focus = { zone: "nav", key: anchor };
    };
    // Like Requests, Watch Party from the profile menu is a root page under the bar: the tab it opened over stays selected.
    // From Details the lobby is pushed over the title, as tvOS navigate(to: .watchParty) does, so Back returns to it.
    const openWatchParty = (choice?: MediaChoice): void => {
        if (!watchPartyOffered) return;
        if (choice === undefined) clearPersonalRoot();
        const origin = top();
        const anchor = origin === undefined || choice !== undefined ? undefined : tabFocus(origin).key;
        const hub: WatchPartyHub = new WatchPartyHub(watchPartyApi(session), () => { if (!torn && top() === route) render(hub.takeRefocus() ? undefined : host.focused()); }, { supported: true, onSupport: setWatchPartyOffered, onLeave: () => host.forgetVisit("watchParty:hub"), onPlay: request => { handoff(request); } });
        const route = newRoute({ kind: "watchParty", watchParty: watchPartyScreen(hub), ...(anchor === undefined ? {} : { anchor }) });
        push(route);
        if (origin !== undefined && anchor !== undefined) origin.focus = { zone: "nav", key: anchor };
        if (choice === undefined) { void hub.check(); return; }
        // WatchPartySession.create(selection:): a host-pick room that opens with the chosen title. create() reads support
        // itself and locks the entry at once, so a press on Start a party cannot race it.
        void (async () => {
            await hub.create("host_pick");
            if (hub.state.room !== undefined) await hub.stage(choice);
        })();
    };
    const requestsHandlers = (current: Extract<Route, { kind: "requests" }>): RequestsHandlers => ({
        // List cancel/remove and detail writes share one mutation lock so navigating between them cannot duplicate a POST.
        capability: requestsCapability, busy: loading !== undefined || requestWritePending || requestGate.actingId !== undefined, failure: current.failure,
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
        menu: record => {
            if (top() !== current || torn || requestMenu.active || requestWritePending || requestGate.actingId !== undefined) return;
            const origin = { zone: host.focused()?.zone ?? "mine", key: record.id };
            const held = requestGate.heldIds();
            const cancel = canCancel(record, requestGate.actingId, held);
            const remove = canRemove(record, requestsCapability.removeFailed, requestGate.actingId, held);
            if (!cancel && !remove) return;
            loading?.abort();
            loading = undefined;
            cancelSlow();
            requestMenu.open({
                container,
                title: record.title,
                ...(cancel ? { cancel: () => { void runListCancel(current, record, origin); } } : {}),
                ...(remove ? { remove: () => { void runListRemove(current, record, origin); } } : {}),
                onClose: () => {
                    if (torn) return;
                    // Capability loss may have replaced Requests with Home while the menu was open.
                    if (top() === current) render(origin);
                    else render(host.focused());
                },
            });
        },
        write: action => {
            const state = current.requests, data = state.data;
            if (top() !== current || torn || requestWritePending || requestGate.actingId !== undefined || state.writing || state.uncertain || loading !== undefined || data === undefined || !requestsCapability.enabled) return;
            const title = "request" in data ? data : state.detail;
            const spec = action === "cancel" && "id" in data ? requestOperations.cancel(data.id)
                : title === undefined || action === "cancel" ? undefined : action === "create" ? requestOperations.create(title) : requestOperations.follow(title, action === "follow");
            if (spec === undefined) return;
            // Claim the list gate for Cancel so a hub menu cannot start a second POST for the same request.
            const cancelId = action === "cancel" && "id" in data ? data.id : undefined;
            const gateToken = cancelId !== undefined ? requestGate.begin(cancelId) : undefined;
            if (cancelId !== undefined && gateToken === undefined) return;
            // The ended record is no longer the page's subject: a new request belongs to the title (RequestDetailViewModel.submitRequest reloads the title).
            const followTitle = (): void => { if (action === "create" && title !== undefined && state.source.kind === "request") state.source = { kind: "media", title }; };
            const releaseGate = (): void => { if (gateToken !== undefined) requestGate.release(gateToken); };
            requestWritePending = true; state.writing = true; state.uncertain = true; state.action = action; state.unconfirmed = false; state.actionMessage = undefined; current.failure = undefined;
            render(host.focused());
            current.focus = host.focused();
            const writeRevision = inputRevision;
            // Focus the person moved while the write was out stays where it is.
            const keepMovedFocus = (route: Route): void => { if (inputRevision !== writeRevision) route.focus = host.focused() ?? route.focus; };
            // A write belongs to session authority, not route lifetime. Leaving never replays it.
            session.call({ ...spec, profileScoped: true, replayAfterRefresh: false }).then(() => {
                // Do not tombstone or paint the hub here: list Cancel owns drop/paint, and a failed quiet
                // hub refresh after detail Cancel must keep its earlier cards (RequestsHubViewModel).
                requestWritePending = false; state.writing = false; releaseGate();
                if (torn) return;
                followTitle();
                markRequestsStale();
                const visible = top();
                if (visible?.kind === "requests") { keepMovedFocus(visible); visible.requests.uncertain = true; loadRoute(visible, true); }
                else render(host.focused());
            }, (error: unknown) => {
                requestWritePending = false; state.writing = false;
                if (torn) { releaseGate(); return; }
                const unconfirmed = writeMayHaveApplied(error);
                // Match list cancel: an uncertain Cancel stays held until a successful list/detail read settles it.
                if (unconfirmed && cancelId !== undefined) {
                    requestGate.hold(cancelId);
                    releaseGate();
                    if (requestGate.held.has(cancelId)) requestGate.listMessage = UNCONFIRMED_CANCEL_MESSAGE;
                } else {
                    releaseGate();
                }
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
            if (typeof value === "string") {
                if (state.filter === value) return;
                state.filter = value;
                state.returnToEvent = false;
                try { options.publicStorage?.setItem(CALENDAR_FILTER_KEY, value); }
                catch { /* The session keeps the filter when storage is blocked. */ }
            }
            else {
                state.start = value === 0 ? calendarWeek(new Date(clock.now()))[0] : shiftDay(state.start ?? localDateKey(new Date(clock.now())), value * 7);
                state.selectedDay = value === 0 ? localDateKey(new Date(clock.now())) : state.start;
                // Today selects today. Focus stays on an event card once the week arrives; the day strip only shows the selection.
                state.returnToEvent = value === 0;
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
        personalSnapshots.delete(current);
        current.pages = newPages();
        current.pendingIndex = undefined;
        current.failure = undefined;
        current.error = undefined;
        current.elsewhere = false;
        loadRoute(current, true);
        render({ zone: "filters", key: `filter:${filter}` });
    };

    const personFilter = (current: Extract<Route, { kind: "person" }>, filter: MediaScope): void => {
        if (current.filter === filter) return;
        personFilterGeneration += 1;
        current.filter = filter;
        current.pages = newPages();
        current.pendingIndex = undefined;
        current.failure = undefined;
        loadRoute(current, true);
        render({ zone: "filters", key: `filter:${filter}` });
    };

    const audiobookPicker = (current: Extract<Route, { kind: "audiobook" }>, open: boolean): void => {
        if (top() !== current || (current.picker === true) === open) return;
        current.picker = open;
        render(open ? undefined : { zone: "actions", key: "chapters" });
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
        render({ zone: "nav", key: current.library.type === "series" ? "series" : "movies" });
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

    const readCalendarFilter = (): ReturnType<typeof storedCalendarFilter> => {
        try { return storedCalendarFilter(options.publicStorage?.getItem(CALENDAR_FILTER_KEY)); }
        catch { return "following"; }
    };
    const home = newRoute({ kind: "home", data: undefined });
    const roots = new Map<string, Route>([["home", home]]);
    retryHomeLibraries = (): void => {
        const homeRoute = roots.get("home");
        if (homeRoute?.kind === "home") readHomeLibraries(homeRoute);
    };
    const shell = new Skyline(container, clock, (target, destinationMode) => {
        shuffleGeneration++;
        const current = top();
        if (current !== undefined) current.focus = host.focused();
        const key = typeof target === "string" ? target : `library:${target.id}:${target.type}`;
        let route = roots.get(key);
        if (route === undefined) {
            route = typeof target === "string"
                ? target === "for_you" ? newRoute({ kind: "for_you", data: undefined }) : target === "calendar" ? newRoute({ kind: "calendar", calendar: calendarState(readCalendarFilter()) }) : newRoute({ kind: "search", query: "", pages: undefined, resultsFor: "" })
                : newRoute({ kind: "library", library: target, pages: newPages() });
            roots.set(key, route);
        }
        // Apple rebuilds For You on each selection (`.id(selectedRoot)`): a new RecommendationsViewModel keeps only
        // rows to show over its new read (RecommendationsViewModel.swift:17-19, :31-36).
        if (route.kind === "for_you" && route !== current) {
            route.stale = true;
            route.focus = undefined;
            route.failure = undefined;
            route.error = undefined;
            if ((browsableRows(route.data)?.length ?? 0) === 0) route.data = undefined;
            host.forgetVisit("for_you");
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
            if (current !== undefined) current.focus = tabFocus(current);
            return;
        }
        loading?.abort();
        loading = undefined;
        cancelSearch();
        for (const covered of stack) retireRoute(covered);
        stack = route === home ? [home] : [home, route];
        stopSearchSupplement();
        showRoute(route, route.focus?.zone === "nav" ? undefined : route.focus);
        if (hasData(route) && (route.focus === undefined || route.focus.zone === "nav")) host.focusDefault();
    }, {
        requests: () => { host.forgetVisit("requests:hub"); openRequests({ kind: "hub" }); },
        watchParty: () => { host.forgetVisit("watchParty:hub"); openWatchParty(); },
        name: profileName,
        serverName: () => cachedBranding(options.publicStorage, context.baseUrl)?.serverName,
        settings: () => {
            const spoilersBeforeSettings = episodeSpoilers?.settings;
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
            settingsScreen = mountSettings(root, session, (hiddenChanged, titleArt) => {
                settingsScreen = undefined;
                if (torn) return;
                // Settings opens from root chrome, after pushed Details have left the stack.
                if (titleArt !== undefined) for (const details of visitedDetails.values()) details.acceptTitleArt(titleArt);
                container.hidden = false;
                shell.setShowAudiobooks(showAudiobooks.value);
                presentation.reload();
                resolutionCap.reload();
                void navigation.reload();
                if (hiddenChanged) {
                    cache.invalidate();
                    visitedDetails.clear();
                    // This read still has the hidden list from before Settings. A later
                    // Calendar visit applies the new one; the old answer must not put
                    // those tabs back. The visit itself waits: Back selects Home.
                    homeLibraries?.abort();
                    const calendar = stack.find(entry => entry.kind === "calendar");
                    home.stale = true;
                    roots.clear();
                    roots.set("home", home);
                    if (calendar !== undefined) { calendar.stale = true; calendarLibrariesStale = true; roots.set("calendar", calendar); }
                }
                // TVSettingsView.exitSettingsToHome calls switchTab(.home). selectRoot
                // then replaces whichever tab opened Settings, so the rail's Back
                // lands on Home.
                for (const covered of stack) retireRoute(covered);
                stack = [home];
                host.listen();
                showRoute(home, { zone: "nav", key: "home" });
                const spoilersAfterSettings = episodeSpoilers?.settings;
                if (spoilersBeforeSettings?.hidesImages !== spoilersAfterSettings?.hidesImages || spoilersBeforeSettings?.hidesOverviews !== spoilersAfterSettings?.hidesOverviews) shell.repaint();
                probeWatchParty();
            }, server.profileLaunch, {
                showAudiobooks,
                profileName,
                profileAvatarUrl,
                profileAvatarText,
                accountName: session.account?.username,
                switchProfile: chooseProfile,
                serverName: cachedBranding(options.publicStorage, context.baseUrl)?.serverName,
                removesServer: () => signOutRemovesServer(() => server.accounts.directory.list(), context.baseUrl),
                ...(options.onSignOut === undefined ? {} : { signOut: options.onSignOut }),
                ...(options.onSwitchServer === undefined ? {} : { switchServer: options.onSwitchServer }),
            }, options.onAccounts, episodeSpoilers, experimental, themePrefs);
            syncThemeMusic();
        },
        personal: (source, anchor = "profiles") => {
            if (source !== "history") clearPersonalRoot();
            const origin = top();
            const selected = source === "history" ? anchor : origin === undefined ? "home" : tabFocus(origin).key;
            push(newRoute({ kind: "personal", source, anchor: selected, filter: "movie", pages: newPages(), capability: undefined, pendingIndex: undefined }));
            if (origin !== undefined) origin.focus = { zone: "nav", key: selected };
        },
        switchProfile: chooseProfile,
        ...(options.onSwitchServer === undefined ? {} : { switchServer: () => {
            host.holdVisit();
            shell.hide();
            host.stop();
            container.hidden = true;
            playing = true;
            syncThemeMusic();
            options.onSwitchServer?.(() => {
                if (torn) return;
                playing = false;
                container.hidden = false;
                host.listen();
                const current = top();
                if (current !== undefined) showRoute(current, tabFocus(current));
            });
        } }),
        ...(options.onSignOut === undefined ? {} : { signOut: options.onSignOut }),
        ...(session.account ? { accountName: session.account.username } : {}),
        lastAccount: signOutRemovesServer(() => server.accounts.directory.list(), context.baseUrl),
    }, focus => render(focus), options.publicStorage, `silo.skyline.scope:${JSON.stringify([server.server.serverId, session.activeProfile.id])}`, context.baseUrl);
    shell.translations = translations;
    translations.subscribeMode(() => { if (!torn) shell.armTranslation(); });
    translations.cards.subscribe(() => { if (!torn) shell.refreshTranslation(); });
    void translations.ensure();
    resolutionCap.ensure();
    shell.titleArt = () => presentation.showsTitleArt;
    episodeSpoilers = new EpisodeSpoilerPreferences(session, options.publicStorage);
    shell.spoilers = () => episodeSpoilers?.settings ?? { hidesImages: false, hidesOverviews: false };
    let shownSpoilers = episodeSpoilers.settings;
    episodeSpoilers.subscribe(() => {
        const next = episodeSpoilers?.settings;
        if (next === undefined || (next.hidesImages === shownSpoilers.hidesImages && next.hidesOverviews === shownSpoilers.hidesOverviews)) return;
        shownSpoilers = next;
        if (torn || playing || settingsScreen !== undefined) return;
        render(host.focused());
        shell.repaint();
    });
    episodeSpoilers.start();
    const enrichedScene = (): boolean => { const current = top(); return current?.kind === "home" || current?.kind === "for_you" || (current?.kind === "library" && current.discovery?.mode === "Recommended"); };
    shell.details = (card, continuing) => !enrichedScene() ? { line: undefined, badges: undefined } : { line: homeDetails.detailLine(card.id), badges: continuing ? homeDetails.savedFile(card)?.badges : undefined };
    shell.filled = card => enrichedScene() ? homeDetails.filled(card) : card;
    shell.rowChangeRead = () => { if (enrichedScene()) homeDetails.readNow(); };
    // This profile's last bar, or no library tabs when it has none. An empty
    // update here would drop Movies and Series that a later failed read should keep.
    shell.setShowAudiobooks(showAudiobooks.value);
    shell.update(pendingHomeLibraries ?? []);
    void navigation.reload();
    void probeRequests();
    probeWatchParty();
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
            cache.invalidate();
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
        updateProfile(profile) {
            if (torn) return;
            profileName = profile.name;
            profileAvatarUrl = avatarReference(profile);
            profileAvatarText = avatarText(profile);
            shell.setAvatar(profileName, profileAvatarUrl, context.baseUrl, profileAvatarText);
        },
        destroy: teardown,
        spoilers: () => episodeSpoilers?.settings ?? { hidesImages: false, hidesOverviews: false },
        resolutionCap: () => resolutionCap,
    };
}

function refusedCatalogPath(path: string): boolean {
    const bare = path.split("?")[0] ?? "";
    return /^\/catalog\/items\/[^/]+$/.test(bare) || /^\/catalog\/series\/[^/]+\/seasons$/.test(bare);
}

function rememberedImages(raw: string | null | undefined): ImageCapabilities | undefined {
    if (raw === null || raw === undefined) return undefined;
    try { return decodeImageCapabilities(JSON.parse(raw)); } catch { return undefined; }
}
