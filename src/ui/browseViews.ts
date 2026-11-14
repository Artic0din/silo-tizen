// DOM for the browse screens: shared pieces, Home, catalog pages and search. Each view function
// returns a View for FocusHost: the nodes and their focus zones. Nothing here fetches; presses
// call the handlers passed in. Item and season pages are in browseDetails.ts.

import type { Card, CardOverlay, CatalogPage, HomeSection, UserLibrary } from "../contracts/v2/catalog.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { artworkUrl, type Destination, type EpisodeSelection, type SeriesLine, browseCardDestination, destinationOf } from "./browseModel.ts";
import { type CardOverlayPrefs, overlayLayer } from "./cardOverlays.ts";
import { homeCaption } from "./cardPresentation.ts";
import type { CardMenuOptions, MenuCard } from "./cardActions.ts";
import type { HomeDismissal } from "../api/detailOperations.ts";
import { artworkSymbol, defaultArtwork, type DefaultArtworkFactory } from "./defaultArtwork.ts";
import { blurEpisodeStill, cardUsesBackdrop, hidesCardImage, type EpisodeSpoilerSettings } from "./episodeSpoilers.ts";
import { thumbhashCanvas } from "./heroBackdrop.ts";
import { el } from "./screen.ts";
import type { MediaChoice } from "./watchPartyChoice.ts";

/** Home artwork widths in browse.css (Apple SiloTheme poster and EpisodeThumbCard widths); badges scale from them. */
const HOME_POSTER_WIDTH = 176;
const HOME_STILL_WIDTH = 360;
const HOME_ROW_CARDS = 20;

/** Cards per grid row; matches the fixed card width in browse.css. */
export const GRID_COLUMNS = 6;

export interface ViewContext {
    /** Resolves relative artwork references. */
    readonly baseUrl: string;
    readonly open: (destination: Destination) => void;
    readonly preview?: (card: Card, row: string, continuing?: boolean, featured?: boolean) => void;
    readonly continueWatching?: boolean;
    /** Apple `SectionRow.layout` on tvOS. Unset keeps the Continue Watching still and poster otherwise. */
    /** "grid" sizes each card by its own type: poster, or square for an audiobook. */
    readonly cardLayout?: "poster" | "thumbnail" | "square" | "grid";
    /** Home captions episodes with their series and an `S01E02 · Pilot` line, as Apple TV does. */
    readonly homeCaptions?: boolean;
    readonly posterScale?: () => number;
    /** Standard poster width for a section grid; Home keeps its existing row width. */
    readonly posterWidth?: number;
    /** The profile's poster badges, read when a Home row renders; undefined while unknown, failed or off. */
    readonly cardOverlays?: () => CardOverlayPrefs | undefined;
    /** A row may provide a captured preference document; otherwise catalog cards read the shared preferences. */
    readonly overlays?: CardOverlayPrefs | undefined;
    /** Continue Watching badges for the file the viewer last played, once Home's detail reads know it. */
    readonly savedFileOverlay?: (card: Card) => CardOverlay | undefined;
    readonly resume?: (id: string, title: string, line?: SeriesLine) => void;
    readonly playEpisode?: (id: string, title: string, startOver?: boolean, selection?: EpisodeSelection) => void;
    readonly quickActions?: (card: MenuCard, options: CardMenuOptions) => void;
    /** The server `section_type` of the feed row a card sits in; SectionRow gives every row's cards the watched row. */
    readonly homeRow?: string;
    /** Home's own rows, whose Continue Watching and Next Up cards can be removed. */
    readonly homeDismissals?: boolean;
    readonly cardDestination?: (card: Card) => Destination | undefined;
    /** Captions a series with the years it ran (Apple CardYears), as Home rows and catalog grids do; Watchlist, Favorites and More Like This show its year. */
    readonly seriesYears?: boolean;
    /** Whether a title's logo may replace its text title on Details: Home's remembered answer. Absent reads as off. */
    readonly titleArt?: () => boolean;
    /** Profile spoiler switches. Absent reads as both off. */
    readonly spoilers?: () => EpisodeSpoilerSettings;
    /** WatchPartyEntry: offered while the experimental switch is on and the server can host a party; open starts a room with the title. */
    readonly watchParty?: { readonly offered: () => boolean; readonly open: (choice: MediaChoice) => void };
}

function spoilerSettings(context: ViewContext): EpisodeSpoilerSettings {
    return context.spoilers?.() ?? { hidesImages: false, hidesOverviews: false };
}

/** Only catalog media receives hold/right-click actions; navigation tiles keep their clicks. */
export function mediaItem(item: FocusItem, card: MenuCard, context: ViewContext, options: CardMenuOptions = {}): FocusItem {
    if (context.quickActions === undefined || !["movie", "series", "episode", "season", "audiobook"].includes(card.type)) return item;
    const quickAction = (): void => context.quickActions?.(card, options);
    item.element.addEventListener("contextmenu", event => { event.preventDefault(); item.element.focus({ preventScroll: true }); quickAction(); });
    return { ...item, quickAction };
}

export function actionButton(key: string, label: string, onPress: () => void): FocusItem {
    const element = el("button", "browse-button", label);
    element.type = "button";
    element.setAttribute("data-focus", key);
    element.addEventListener("click", onPress);
    return { key, element };
}

/** Apple ErrorView.recoveryPlan: a 401 offers sign-in, a 403 or 404 prefers leaving, and otherwise Try Again is the only action. */
export function recoveryActions(error: { readonly headline: string; readonly signIn: boolean }, retry: FocusItem, back?: FocusItem, signIn?: FocusItem): FocusItem[] {
    const items: FocusItem[] = [];
    if (error.signIn && signIn !== undefined) items.push(signIn);
    if (back !== undefined && (error.headline === "Not found" || error.headline === "Not allowed")) items.push(back);
    items.push(retry);
    return items;
}

/**
 * Apple ErrorView: icon, headline, message, then the recovery plan's buttons in a column. Manage Servers leads the
 * secondary buttons; Go Back appears only for Not found or Not allowed, since the remote's Back already leaves.
 */
type ShownError = { readonly headline: string; readonly message: string; readonly signIn: boolean };

/** Apple ErrorState: a 401, 403 or 404 keeps Apple's headline and copy; any other failure keeps the route's own message. */
export function failureError(failure: string, stored: ShownError | undefined): ShownError {
    return stored !== undefined && stored.headline !== "Something went wrong" ? stored : { headline: "Something went wrong", message: failure, signIn: false };
}

export function errorView(name: string, error: ShownError, retry: () => void, back?: () => void, signIn?: () => void, manageServers?: () => void): View {
    const [primary, ...secondary] = recoveryActions(
        error,
        actionButton("retry", "Try Again", retry),
        back === undefined ? undefined : actionButton("go-back", "Go Back", back),
        signIn === undefined ? undefined : actionButton("sign-in", "Sign In Again", signIn),
    );
    const manage = manageServers === undefined ? [] : [actionButton("manage-servers", "Manage Servers", manageServers)];
    const items = primary === undefined ? manage : [primary, ...manage, ...secondary];
    const page = searchState(error.headline, error.message, "details-failure", FAILURE_ICON);
    page.setAttribute("role", "alert");
    page.appendChild(zoneNode("browse-actions", items));
    return { name, content: [page], zones: [{ id: "status", layout: "column", items }], focus: { zone: "status", key: items[0]?.key ?? "retry" }, back };
}

const EXPLORE_MINIMUM_SCALE = 0.8;

/** SectionExploreAllCard keeps the current marquee while its row's trailing tile owns focus. */
export function exploreAllCard(rowTitle: string, key: string, wide: boolean, onPress: () => void): FocusItem {
    const element = el("button", "browse-card skyline-explore");
    element.type = "button";
    element.setAttribute("data-focus", key);
    element.setAttribute("aria-label", `Explore all, ${rowTitle}`);
    if (wide) element.classList.add("skyline-continue");
    const tile = el("span", "browse-art skyline-explore-tile");
    const icon = el("span", "skyline-explore-icon");
    icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 12h15M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const label = el("span", "skyline-explore-label", "Explore all");
    tile.append(icon, label);
    element.appendChild(tile);
    // minimumScaleFactor(0.8) (SectionExploreAllCard.swift:61): a label wider than the tile shrinks to fit, down to 80%.
    // FocusHost places the view synchronously, so the tile is laid out by the next microtask; a poster-size change redraws it.
    queueMicrotask(() => {
        if (label.clientWidth === 0) return;
        const fit = label.clientWidth / label.scrollWidth;
        if (fit < 1) label.style.fontSize = `${parseFloat(getComputedStyle(label).fontSize) * Math.max(EXPLORE_MINIMUM_SCALE, fit)}px`;
    });
    element.addEventListener("click", onPress);
    return { key, element };
}

/**
 * An <img> for signed or presigned artwork, or the fallback when it is missing or fails. A `defaultArtwork`
 * factory fills the box as Apple's DefaultArtwork does and is called only when the fallback shows; any
 * other fallback sits in the text placeholder.
 * A `thumbhash` is AsyncImageView's `.artwork` placeholder (silo-apple 85679e7
 * `Components/Images/AsyncImageView.swift:218-229`, `:338-344`): it shows while the image loads and
 * stays in place of DefaultArtwork when the image is missing.
 */
export function artwork(className: string, reference: string | undefined, baseUrl: string, fallback: string | Node | DefaultArtworkFactory, thumbhash?: string): HTMLElement {
    const box = el("div", className);
    const src = artworkUrl(reference, baseUrl);
    const drawn = typeof fallback === "function";
    const preview = drawn ? thumbhashCanvas(thumbhash, "browse-art-thumbhash") : undefined;
    if (preview !== undefined) box.appendChild(preview);
    const showFallback = (): void => {
        if (preview !== undefined) return;
        box.classList.add("browse-art-missing");
        if (drawn) {
            // Drawn artwork is absolutely placed: first, so badges and progress added to the box stay above it.
            box.prepend(fallback());
        } else {
            const placeholder = el("span", "browse-art-fallback");
            placeholder.append(fallback);
            box.appendChild(placeholder);
        }
    };
    if (drawn) box.classList.add("browse-art-default");
    if (src === undefined) {
        showFallback();
        return box;
    }
    const image = el("img", "browse-art-image");
    image.alt = "";
    image.loading = "lazy";
    // The signed URL authorizes itself; send nothing else about the app to the image host.
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => {
        if (image.parentNode === box) {
            box.removeChild(image);
        }
        showFallback();
    });
    // AsyncImageView fades a loaded image in with easeOut(fastDuration) unless a decode was already in memory
    // (silo-apple 85679e7 `Components/Images/AsyncImageView.swift:80-86`, `:123`; `Theme/SiloTheme.swift:164`).
    image.addEventListener("load", () => image.classList.add("is-loaded"));
    image.src = src;
    if (image.complete && image.naturalWidth > 0) image.classList.add("is-cached");
    box.appendChild(image);
    return box;
}

export function thumbnailProgress(fraction: number): HTMLElement {
    const progress = el("span", "skyline-progress");
    const fill = el("span", "skyline-progress-fill");
    fill.style.width = `${Math.min(100, Math.max(0, fraction * 100))}%`;
    progress.appendChild(fill);
    return progress;
}

function episodeLine(card: Card): SeriesLine | undefined {
    if (card.type !== "episode") return undefined;
    const seriesTitle = card.seriesTitle;
    const seasonNumber = card.seasonNumber;
    const episodeNumber = card.episodeNumber;
    if (seriesTitle === undefined && seasonNumber === undefined && episodeNumber === undefined) return undefined;
    return {
        ...(seriesTitle === undefined ? {} : { seriesTitle }),
        ...(seasonNumber === undefined ? {} : { seasonNumber }),
        ...(episodeNumber === undefined ? {} : { episodeNumber }),
    };
}

/** Undefined for media this client does not browse. */
export function cardItem(card: Card, context: ViewContext): FocusItem | undefined {
    const destination = context.cardDestination?.(card) ?? (card.type === "season" ? destinationOf(card) : browseCardDestination(card));
    if (destination === undefined) {
        return undefined;
    }
    const element = el("button", "browse-card");
    element.type = "button";
    element.setAttribute("data-focus", card.id);
    const continuing = context.continueWatching === true;
    const thumbnail = context.cardLayout === "thumbnail" || (context.cardLayout === undefined && continuing);
    // Rows follow their own layout (SectionRow.layout); a grid squares each audiobook cover (CatalogGrid).
    const square = !thumbnail && (context.cardLayout === "square" || ((context.cardLayout === undefined || context.cardLayout === "grid") && card.type === "audiobook"));
    if (square) element.classList.add("browse-card-square");
    const backdrop = cardUsesBackdrop(card, thumbnail);
    const art = artwork("browse-art", backdrop ? card.backdropUrl : card.posterUrl, context.baseUrl, defaultArtwork(artworkSymbol(card.type)), backdrop ? card.backdropThumbhash : card.posterThumbhash);
    if (hidesCardImage(card, spoilerSettings(context), thumbnail)) blurEpisodeStill(art);
    element.appendChild(art);
    if (thumbnail) {
        element.classList.add("skyline-continue");
        // EpisodeThumbCard draws ProgressBar on every thumbnail row, Continue Watching included.
        if (card.positionSeconds !== undefined && card.durationSeconds !== undefined && card.durationSeconds > 0 && card.positionSeconds > 0) {
            element.firstElementChild?.appendChild(thumbnailProgress(card.positionSeconds / card.durationSeconds));
        }
    }
    // Badges sit under the progress bar and the watched tick, which win a shared corner.
    const saved = continuing ? context.savedFileOverlay?.(card) : undefined;
    const scale = context.homeCaptions === true ? context.posterScale?.() ?? 1 : 1;
    const overlays = context.overlays ?? context.cardOverlays?.();
    const badges = overlays === undefined ? undefined : overlayLayer(saved === undefined ? card : { ...card, overlay: saved }, overlays, thumbnail ? "wide" : "poster", (thumbnail ? HOME_STILL_WIDTH : context.posterWidth ?? (context.homeCaptions === true ? HOME_POSTER_WIDTH : 260)) * scale);
    if (badges !== undefined) element.firstElementChild?.insertBefore(badges, element.firstElementChild.querySelector(".skyline-progress"));
    if (card.played === true) {
        const tick = el("span", "browse-watched");
        tick.appendChild(el("span", "silo-sr-only", "Watched"));
        element.firstElementChild?.appendChild(tick);
    }
    const caption = homeCaption(card, context.homeCaptions === true && thumbnail, context.seriesYears === true);
    element.appendChild(el("span", "browse-card-title", caption.title));
    if (caption.line !== undefined) {
        element.appendChild(el("span", "browse-card-subtitle", caption.line));
    }
    element.addEventListener("click", () => context.open(destination));
    element.addEventListener("focus", () => context.preview?.(card, "Browse"));
    const line = episodeLine(card);
    const play = card.type === "movie" || card.type === "episode" ? () => context.resume?.(card.id, card.title, line) : undefined;
    const home = context.homeRow !== undefined;
    return mediaItem({ key: card.id, element, ...(play === undefined ? {} : { play }) }, card, context, { play: continuing ? play : undefined, dismissal: context.homeDismissals === true ? homeDismissal(card, context.homeRow) : undefined, home });
}

export function cardItems(cards: readonly Card[], context: ViewContext): FocusItem[] {
    const result: FocusItem[] = [];
    for (const card of cards) {
        const item = cardItem(card, context);
        if (item !== undefined) {
            result.push(item);
        }
    }
    return result;
}

export function zoneNode(className: string, items: readonly FocusItem[]): HTMLElement {
    const node = el("div", className);
    for (const item of items) {
        node.appendChild(item.element);
    }
    return node;
}

export function heading(text: string): HTMLElement {
    return el("h1", "browse-title", text);
}

export function lines(texts: readonly string[], tone: "info" | "error" = "info"): HTMLElement[] {
    return texts.map((text, index) => {
        const node = el("p", tone === "error" ? "browse-text browse-error" : "browse-text", text);
        if (index === 0) {
            node.setAttribute("role", tone === "error" ? "alert" : "status");
        }
        return node;
    });
}

/** Loading, failure and empty pages: a title, a message and at least one button. */
export function statusView(name: string, title: string, texts: readonly string[], buttons: readonly FocusItem[], back: (() => void) | undefined, tone: "info" | "error" = "info"): View {
    return {
        name,
        content: [heading(title), ...lines(texts, tone), zoneNode("browse-actions", buttons)],
        zones: [{ id: "status", layout: "row", items: buttons }],
        focus: buttons[0] === undefined ? undefined : { zone: "status", key: buttons[0].key },
        back,
    };
}

export interface HomeHandlers {
    readonly expand: (section: HomeSection) => void;
    readonly canExpand?: (section: HomeSection) => boolean;
    readonly search: () => void;
    readonly library: (library: UserLibrary) => void;
    readonly chooseProfile: () => void;
    /** Only Home itself removes cards from Continue Watching and Next Up ("Home is the only caller with a removal handler"). */
    readonly dismisses?: boolean;
}

/** SF Symbol play.rectangle.on.rectangle. */
const PLAY_RECTANGLES_ICON = '<svg viewBox="0 0 54 44" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"><path d="M10 6.5h29a5 5 0 0 1 5 5"/><rect x="1.5" y="12.5" width="42.5" height="30" rx="5"/><path d="M18 21.5v12l10-6Z" fill="currentColor"/><path d="M17.5 1.5h29a5 5 0 0 1 5 5v22"/></svg>';

/**
 * Apple HomeSectionsMutation.removingDismissedItem: a dismissed card leaves the playback rows at once, and dismissing an
 * episode or series drops every card of that show from them; rows left empty go. Other rows keep the title.
 */
export function removingDismissed(sections: readonly HomeSection[], card: Pick<Card, "id" | "type" | "seriesId">): HomeSection[] {
    const series = card.type === "series" ? card.id : card.type === "episode" && card.seriesId !== undefined && card.seriesId !== "" ? card.seriesId : undefined;
    return sections.map(section => {
        const type = section.sectionType.toLowerCase();
        if (!(isContinueWatching(type) || type === "next_up")) return section;
        const items = section.items.filter(item => item.id !== card.id && (series === undefined || (item.id !== series && item.seriesId !== series)));
        return items.length === section.items.length ? section : { ...section, items };
    }).filter(section => section.items.length > 0);
}

/** Apple HomeDismissal for a card in a Continue Watching or Next Up row (SectionRow.offersHomeDismissal); otherwise none. */
function homeDismissal(card: Card, row: string | undefined): HomeDismissal | undefined {
    if (row === undefined || !(isContinueWatching(row) || row.toLowerCase() === "next_up")) return undefined;
    if (card.progressUpdatedAt !== undefined && card.progressUpdatedAt !== "") return { surface: "continue_watching", progressUpdatedAt: card.progressUpdatedAt };
    if (card.seriesId !== undefined && card.seriesId !== "") return { surface: "next_up", seriesId: card.seriesId };
    return undefined;
}

/** Resume rows. Apple `ResolvedSection.isContinueWatchingSection`: the server type, not the title. */
function isContinueWatching(sectionType: string): boolean {
    const type = sectionType.toLowerCase();
    return type === "continue_watching" || type === "in_progress";
}

function isTvItem(type: Card["type"]): boolean {
    switch (type) {
        case "episode":
        case "series":
        case "season":
            return true;
        case "movie":
        case "audiobook":
        case "unknown":
            return false;
        default: {
            const exhaustive: never = type;
            return exhaustive;
        }
    }
}

/**
 * Apple `SectionRow.layout(for:)` on tvOS (`SectionRow.swift`). The server sends the row type and
 * items; it does not send a card shape. A type containing "next", and Continue Watching, are
 * stills. Any other row is a still only when it contains an episode and every browsable item is
 * TV, so one episode does not turn a shared movie row into stills. A row of only audiobooks is square,
 * checked after the still rows as on Apple.
 */
export function homeRowLayout(sectionType: string, cards: readonly Pick<Card, "type">[]): "poster" | "thumbnail" | "square" {
    const type = sectionType.toLowerCase();
    if (type.includes("next") || isContinueWatching(type)) return "thumbnail";
    if (cards.some(card => card.type === "episode") && cards.every(card => isTvItem(card.type))) return "thumbnail";
    if (cards.length > 0 && cards.every(card => card.type === "audiobook")) return "square";
    return "poster";
}

/** SectionRowLimit.cards caps each Home shelf without changing the server's order. */
export function homeRows(sections: readonly HomeSection[]): { section: HomeSection; continuing: boolean; layout: "poster" | "thumbnail" | "square"; cards: Card[] }[] {
    return sections.map(section => {
        const cards = section.items.filter(card => destinationOf(card) !== undefined).slice(0, HOME_ROW_CARDS);
        return { section, continuing: isContinueWatching(section.sectionType), layout: homeRowLayout(section.sectionType, cards), cards };
    });
}

export function homeView(libraries: readonly UserLibrary[], sections: readonly HomeSection[], context: ViewContext, handlers: HomeHandlers): View {
    const zones: Zone[] = [];
    const content: HTMLElement[] = [];
    // Server order is the profile's order; featured rows render as ordinary rows (Apple HomeViewModel).
    for (const { section, continuing, layout, cards: titles } of homeRows(sections)) {
        const cards = cardItems(titles, { ...context, continueWatching: continuing, homeRow: section.sectionType, homeDismissals: handlers.dismisses === true, cardLayout: layout, homeCaptions: true, seriesYears: true, overlays: context.cardOverlays?.(), preview: (card) => context.preview?.(card, section.title, continuing, section.featured === true) });
        // A row of only books, podcasts or other media this client does not browse is left out.
        if (cards.length === 0) {
            continue;
        }
        const id = `section:${section.id}`;
        if (handlers.canExpand?.(section) !== false) cards.push(exploreAllCard(section.title, `expand:${section.id}`, layout === "thumbnail", () => handlers.expand(section)));
        // Apple `focusSection`: Up and Down between these rows stay geometric, including a row already visited.
        zones.push({ id, layout: "row", spatial: true, items: cards });
        const block = el("section", "browse-section home-section");
        block.setAttribute("data-section", section.id);
        const title = el("h2", "browse-section-title", section.title);
        if (continuing) {
            const glyph = el("span", "home-row-glyph");
            glyph.setAttribute("aria-hidden", "true");
            title.prepend(glyph);
        }
        block.appendChild(title);
        block.appendChild(zoneNode("browse-row", cards));
        content.push(block);
    }
    if (zones.length === 0 && handlers.dismisses === true) {
        // Apple HomeView: EmptyStateView under a page focus owner whose Up goes to the top bar.
        const empty = emptyStateOwner("Nothing to watch yet", "Add media to your libraries or start watching to see it here.", "home-empty", PLAY_RECTANGLES_ICON);
        content.push(empty.element);
        zones.push({ id: "empty", layout: "row", items: [empty] });
    } else if (zones.length === 0) {
        content.push(...lines(["There is nothing to watch on this profile yet."]));
    }
    const first = zones[0]?.items[0];
    return { name: "home", content, zones, focus: first === undefined ? { zone: "nav", key: "home" } : { zone: zones[0]?.id ?? "nav", key: first.key }, back: undefined };
}

export interface PagerState {
    readonly page: CatalogPage;
    /** Zero-based. */
    readonly index: number;
    readonly pageSize: number;
    readonly loading: boolean;
    readonly previous: () => void;
    readonly next: () => void;
}

/** One page of cards and the buttons that move between pages. */
export function pagedGrid(state: PagerState, context: ViewContext, columns = GRID_COLUMNS): { content: HTMLElement[]; zones: Zone[] } {
    const cards = cardItems(state.page.items, context).slice(0, state.pageSize);
    const pager: FocusItem[] = [];
    if (state.index > 0) {
        pager.push(actionButton("previous", "Previous page", state.previous));
    }
    if (state.page.nextCursor !== undefined) {
        pager.push(actionButton("next", "Next page", state.next));
    }
    const pages = Math.max(1, Math.ceil((state.page.total ?? state.page.items.length) / state.pageSize));
    const position = state.loading
        ? "Loading the page."
        : state.page.total === undefined ? `Page ${state.index + 1}` : `Page ${state.index + 1} of ${state.page.totalExact ? pages : `about ${pages}`}`;
    const status = el("p", "browse-text browse-page-status", position);
    status.setAttribute("role", "status");
    return {
        content: [zoneNode("browse-grid", cards), ...(cards.length === 0 && pager.length === 0 ? [] : [status]), zoneNode("browse-actions", pager)],
        zones: [
            { id: "grid", layout: "grid", columns, items: cards },
            { id: "pager", layout: "row", items: pager },
        ],
    };
}

export function libraryView(library: UserLibrary, grid: { content: HTMLElement[]; zones: Zone[] }, back: () => void, focusDefault: () => void): View {
    const empty = grid.zones[0]?.items.length === 0;
    const browse = actionButton("browse", "Browse", focusDefault);
    const pills = zoneNode("skyline-pills", [browse]);
    pills.appendChild(el("span", "skyline-scope", library.name));
    const content = [pills, ...(empty ? lines(["This library is empty."]) : []), ...grid.content];
    const zones: Zone[] = [{ id: "pills", layout: "row", items: [browse] }, ...grid.zones];
    if (zones.every((zone) => zone.items.length === 0)) {
        const escape = actionButton("back", "Back", back);
        content.push(zoneNode("browse-actions", [escape]));
        zones.push({ id: "status", layout: "row", items: [escape] });
    }
    const first = grid.zones[0]?.items[0];
    return { name: `library:${library.id}`, content, zones, focus: first === undefined ? undefined : { zone: "grid", key: first.key }, back };
}

export type SearchResults =
    | { readonly status: "idle" }
    | { readonly status: "searching" }
    | { readonly status: "failed"; readonly error: ShownError; readonly retry: () => void; readonly signIn: (() => void) | undefined }
    | { readonly status: "ready"; readonly query: string; readonly grid: { content: HTMLElement[]; zones: Zone[] } };

/** `head` ends with the field and is the same nodes on every render. */
export function searchView(head: readonly HTMLElement[], input: HTMLInputElement, results: SearchResults, back: () => void): View {
    const field: FocusItem = { key: "query", element: input };
    const content: HTMLElement[] = [...head];
    const zones: Zone[] = [{ id: "field", layout: "row", items: [field] }];
    switch (results.status) {
        case "idle":
            content.push(searchState("Search Silo", "Find movies, series, and people", "search-prompt"));
            break;
        case "searching":
            content.push(searchLoading());
            break;
        case "failed": {
            // Search is a pushed page, so Back is available and a 403 or 404 offers Go Back (ErrorView.swift:77-97).
            const items = recoveryActions(
                results.error,
                actionButton("retry", "Try Again", results.retry),
                actionButton("go-back", "Go Back", back),
                results.signIn === undefined ? undefined : actionButton("sign-in", "Sign In Again", results.signIn),
            );
            const failure = searchState(results.error.headline, results.error.message, "search-failure");
            failure.setAttribute("role", "alert");
            failure.appendChild(zoneNode("browse-actions", items));
            content.push(failure);
            zones.push({ id: "status", layout: "column", items });
            break;
        }
        case "ready":
            if (results.grid.zones[0]?.items.length === 0) {
                content.push(searchState("No results", "Try a different search term", "search-empty"));
            }
            content.push(...results.grid.content);
            zones.push(...results.grid.zones);
    }
    return { name: "search", content, zones, focus: { zone: "field", key: "query" }, back };
}

export const FAILURE_ICON = '<svg viewBox="0 0 48 48"><path fill="currentColor" d="M20 5a4.6 4.6 0 0 1 8 0l19 33a4.6 4.6 0 0 1-4 7H5a4.6 4.6 0 0 1-4-7Z"/><path d="M24 16v12m0 7v1" stroke="#000" stroke-width="4" stroke-linecap="round"/></svg>';

export function searchLoading(): HTMLElement {
    const progress = el("div", "search-progress");
    progress.setAttribute("role", "status");
    progress.setAttribute("aria-label", "Searching");
    progress.appendChild(el("span", "search-progress-icon"));
    return progress;
}

/** Apple EmptyStateView under `tvPageFocusOwner`: a passive page that owns focus and is spoken as its title. */
export function emptyStateOwner(title: string, subtitle: string, key: string, iconMarkup: string): FocusItem {
    const page = searchState(title, subtitle, key, iconMarkup);
    page.tabIndex = -1;
    page.setAttribute("role", "status");
    page.setAttribute("aria-label", title);
    page.setAttribute("data-focus", key);
    return { key, element: page };
}

/** Apple EmptyStateView and ErrorView: an icon, a title and a line, sized by `className`. */
export function searchState(title: string, subtitle: string, className: string, iconMarkup?: string): HTMLElement {
    const state = el("div", `search-state ${className}`);
    const icon = el("span", "search-state-icon");
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = iconMarkup ?? (className === "search-failure"
        ? FAILURE_ICON
        : '<svg viewBox="0 0 48 48" fill="none"><circle cx="20" cy="20" r="13" stroke="currentColor" stroke-width="4"/><path d="m30 30 12 12" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>');
    state.append(icon, el("h2", "search-state-title", title), el("p", "search-state-description", subtitle));
    return state;
}
