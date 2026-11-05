// DOM for the browse screens: shared pieces, Home, catalog pages and search. Each view function
// returns a View for FocusHost: the nodes and their focus zones. Nothing here fetches; presses
// call the handlers passed in. Item and season pages are in browseDetails.ts.

import type { Card, CardOverlay, CatalogPage, HomeSection, UserLibrary } from "../contracts/v2/catalog.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { artworkUrl, type Destination, type EpisodeSelection, destinationOf } from "./browseModel.ts";
import { type CardOverlayPrefs, overlayLayer } from "./cardOverlays.ts";
import { homeCaption } from "./cardPresentation.ts";
import { el } from "./screen.ts";

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
    readonly preview?: (card: Card, row: string, continuing?: boolean) => void;
    readonly continueWatching?: boolean;
    /** Apple `SectionRow.layout` on tvOS. Unset keeps the Continue Watching still and poster otherwise. */
    readonly cardLayout?: "poster" | "thumbnail";
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
    readonly resume?: (id: string, title: string) => void;
    readonly playEpisode?: (id: string, title: string, startOver?: boolean, selection?: EpisodeSelection) => void;
    readonly quickActions?: (card: Pick<Card, "id" | "title" | "type">) => void;
}

/** Only catalog media receives hold/right-click actions; navigation tiles keep their clicks. */
export function mediaItem(item: FocusItem, card: Pick<Card, "id" | "title" | "type">, context: ViewContext): FocusItem {
    if (context.quickActions === undefined || !["movie", "series", "episode", "season"].includes(card.type)) return item;
    const quickAction = (): void => context.quickActions?.(card);
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

/** SectionExploreAllCard keeps the current marquee while its row's trailing tile owns focus. */
function exploreAllCard(rowTitle: string, key: string, wide: boolean, onPress: () => void): FocusItem {
    const element = el("button", "browse-card skyline-explore");
    element.type = "button";
    element.setAttribute("data-focus", key);
    element.setAttribute("aria-label", `Explore all, ${rowTitle}`);
    if (wide) element.classList.add("skyline-continue");
    const tile = el("span", "browse-art skyline-explore-tile");
    const icon = el("span", "skyline-explore-icon");
    icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 12h15M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    tile.append(icon, el("span", "skyline-explore-label", "Explore all"));
    element.appendChild(tile);
    element.addEventListener("click", onPress);
    return { key, element };
}

/** An <img> for signed or presigned artwork, or the title as a placeholder when it is missing or fails. */
export function artwork(className: string, reference: string | undefined, baseUrl: string, fallback: string | Node): HTMLElement {
    const box = el("div", className);
    const src = artworkUrl(reference, baseUrl);
    const placeholder = el("span", "browse-art-fallback");
    placeholder.append(fallback);
    if (src === undefined) {
        box.classList.add("browse-art-missing");
        box.appendChild(placeholder);
        return box;
    }
    const image = el("img", "browse-art-image");
    image.alt = "";
    image.loading = "lazy";
    // The signed URL authorizes itself; send nothing else about the app to the image host.
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => {
        box.classList.add("browse-art-missing");
        if (image.parentNode === box) {
            box.removeChild(image);
        }
        box.appendChild(placeholder);
    });
    image.src = src;
    box.appendChild(image);
    return box;
}

/** Undefined for media this client does not browse. */
export function cardItem(card: Card, context: ViewContext): FocusItem | undefined {
    const destination = destinationOf(card);
    if (destination === undefined) {
        return undefined;
    }
    const element = el("button", "browse-card");
    element.type = "button";
    element.setAttribute("data-focus", card.id);
    const continuing = context.continueWatching === true;
    const thumbnail = context.cardLayout === "thumbnail" || (context.cardLayout === undefined && continuing);
    element.appendChild(artwork("browse-art", thumbnail ? card.backdropUrl ?? card.posterUrl : card.posterUrl, context.baseUrl, card.title));
    if (thumbnail) {
        element.classList.add("skyline-continue");
        if (card.positionSeconds !== undefined && card.durationSeconds !== undefined && card.durationSeconds > 0 && card.positionSeconds > 0) {
            const progress = el("span", "skyline-progress");
            const fill = el("span", "skyline-progress-fill");
            fill.style.width = `${Math.min(100, Math.max(0, card.positionSeconds / card.durationSeconds * 100))}%`;
            progress.appendChild(fill);
            element.firstElementChild?.appendChild(progress);
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
    const caption = homeCaption(card, context.homeCaptions === true && continuing);
    element.appendChild(el("span", "browse-card-title", caption.title));
    if (caption.line !== undefined) {
        element.appendChild(el("span", "browse-card-subtitle", caption.line));
    }
    element.addEventListener("click", () => {
        if (card.type === "episode" && context.playEpisode !== undefined) context.playEpisode(card.id, card.title);
        else if (continuing && context.resume !== undefined && (card.type === "movie" || card.type === "episode")) context.resume(card.id, card.title);
        else context.open(destination);
    });
    element.addEventListener("focus", () => context.preview?.(card, "Browse"));
    return mediaItem({ key: card.id, element }, card, context);
}

function cardItems(cards: readonly Card[], context: ViewContext): FocusItem[] {
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
 * TV, so one episode does not turn a shared movie row into stills. An all-audiobook row is square
 * on Apple; this client does not browse audiobooks, so that row is omitted before layout.
 */
export function homeRowLayout(sectionType: string, cards: readonly Pick<Card, "type">[]): "poster" | "thumbnail" {
    const type = sectionType.toLowerCase();
    if (type.includes("next") || isContinueWatching(type)) return "thumbnail";
    if (cards.some(card => card.type === "episode") && cards.every(card => isTvItem(card.type))) return "thumbnail";
    return "poster";
}

/** SectionRowLimit.cards caps each Home shelf without changing the server's order. */
export function homeRows(sections: readonly HomeSection[]): { section: HomeSection; continuing: boolean; layout: "poster" | "thumbnail"; cards: Card[] }[] {
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
        const cards = cardItems(titles, { ...context, continueWatching: continuing, cardLayout: layout, homeCaptions: true, overlays: context.cardOverlays?.(), preview: (card) => context.preview?.(card, section.title, continuing) });
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
    if (zones.length === 0) {
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
export function pagedGrid(state: PagerState, context: ViewContext): { content: HTMLElement[]; zones: Zone[] } {
    const cards = cardItems(state.page.items, context).slice(0, state.pageSize);
    const pager: FocusItem[] = [];
    if (state.index > 0) {
        pager.push(actionButton("previous", "Previous page", state.previous));
    }
    if (state.page.nextCursor !== undefined) {
        pager.push(actionButton("next", "Next page", state.next));
    }
    const pages = Math.max(1, Math.ceil(state.page.total / state.pageSize));
    const position = state.loading
        ? "Loading the page."
        : `Page ${state.index + 1} of ${state.page.totalExact ? pages : `about ${pages}`}`;
    const status = el("p", "browse-text browse-page-status", position);
    status.setAttribute("role", "status");
    return {
        content: [zoneNode("browse-grid", cards), ...(cards.length === 0 && pager.length === 0 ? [] : [status]), zoneNode("browse-actions", pager)],
        zones: [
            { id: "grid", layout: "grid", columns: GRID_COLUMNS, items: cards },
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
    | { readonly status: "failed"; readonly text: string; readonly retry: () => void }
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
            const retry = actionButton("retry", "Try Again", results.retry);
            const failure = searchState("Something went wrong", results.text, "search-failure");
            failure.setAttribute("role", "alert");
            failure.appendChild(zoneNode("browse-actions", [retry]));
            content.push(failure);
            zones.push({ id: "status", layout: "row", items: [retry] });
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
