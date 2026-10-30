// DOM for the browse screens: shared pieces, Home, catalog pages and search. Each view function
// returns a View for FocusHost: the nodes and their focus zones. Nothing here fetches; presses
// call the handlers passed in. Item and season pages are in browseDetails.ts.

import type { Card, CatalogPage, HomeSection, UserLibrary } from "../contracts/v2/catalog.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { artworkUrl, type Destination, destinationOf, episodeLabel } from "./browseModel.ts";
import { el } from "./screen.ts";

/** Cards per grid row; matches the fixed card width in browse.css. */
export const GRID_COLUMNS = 6;

export interface ViewContext {
    /** Resolves relative artwork references. */
    readonly baseUrl: string;
    readonly open: (destination: Destination) => void;
    readonly preview?: (card: Card, row: string) => void;
    readonly continueWatching?: boolean;
    readonly resume?: (id: string, title: string) => void;
}

export function actionButton(key: string, label: string, onPress: () => void): FocusItem {
    const element = el("button", "browse-button", label);
    element.type = "button";
    element.setAttribute("data-focus", key);
    element.addEventListener("click", onPress);
    return { key, element };
}

/** An <img> for signed or presigned artwork, or the title as a placeholder when it is missing or fails. */
export function artwork(className: string, reference: string | undefined, baseUrl: string, fallback: string): HTMLElement {
    const box = el("div", className);
    const src = artworkUrl(reference, baseUrl);
    const placeholder = el("span", "browse-art-fallback", fallback);
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

function cardSubtitle(card: Card): string | undefined {
    if (card.type === "episode") {
        const label = episodeLabel(card.seasonNumber, card.episodeNumber);
        return [card.seriesTitle, label].filter((part) => part !== undefined).join(" · ") || undefined;
    }
    return card.year === undefined ? undefined : String(card.year);
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
    element.appendChild(artwork("browse-art", continuing ? card.backdropUrl ?? card.posterUrl : card.posterUrl, context.baseUrl, card.title));
    if (continuing) {
        element.classList.add("skyline-continue");
        if (card.positionSeconds !== undefined && card.durationSeconds !== undefined && card.durationSeconds > 0) {
            const progress = el("span", "skyline-progress");
            const fill = el("span", "skyline-progress-fill");
            fill.style.width = `${Math.min(100, Math.max(0, card.positionSeconds / card.durationSeconds * 100))}%`;
            progress.appendChild(fill);
            element.firstElementChild?.appendChild(progress);
        }
    }
    element.appendChild(el("span", "browse-card-title", card.title));
    const subtitle = cardSubtitle(card);
    if (subtitle !== undefined) {
        element.appendChild(el("span", "browse-card-subtitle", subtitle));
    }
    element.addEventListener("click", () => {
        if (continuing && context.resume !== undefined && (card.type === "movie" || card.type === "episode")) context.resume(card.id, card.title);
        else context.open(destination);
    });
    element.addEventListener("focus", () => context.preview?.(card, "Browse"));
    return { key: card.id, element };
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
    readonly search: () => void;
    readonly library: (library: UserLibrary) => void;
    readonly chooseProfile: () => void;
}

export function homeView(libraries: readonly UserLibrary[], sections: readonly HomeSection[], context: ViewContext, handlers: HomeHandlers): View {
    const zones: Zone[] = [];
    const content: HTMLElement[] = [];
    const rows = sections.filter(section => section.featured !== true);
    const recommendations = ["recommended_for_you", "because_you_watched", "similar_users_liked", "taste_match"];
    const rank = (section: HomeSection): number => section.sectionType === "continue_watching" ? 0 : recommendations.includes(section.sectionType) ? 1 : 2;
    // Only guide-mandated groups move; each group's server preference order stays intact.
    const ordered = [0, 1, 2].flatMap(group => rows.filter(section => rank(section) === group));
    for (const section of ordered) {
        const cards = cardItems(section.items, { ...context, continueWatching: section.sectionType === "continue_watching", preview: (card) => context.preview?.(card, section.title) }).slice(0, 24);
        // A row of only books, podcasts or other media this client does not browse is left out.
        if (cards.length === 0) {
            continue;
        }
        const id = `section:${section.id}`;
        cards.push(actionButton(`expand:${section.id}`, "See All", () => handlers.expand(section)));
        zones.push({ id, layout: "row", items: cards });
        const block = el("section", "browse-section");
        block.setAttribute("data-section", section.id);
        block.appendChild(el("h2", "browse-section-title", section.title));
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
            break;
        case "searching":
            content.push(...lines(["Searching."]));
            break;
        case "failed": {
            const retry = actionButton("retry", "Try again", results.retry);
            content.push(...lines([results.text], "error"), zoneNode("browse-actions", [retry]));
            zones.push({ id: "status", layout: "row", items: [retry] });
            break;
        }
        case "ready":
            if (results.grid.zones[0]?.items.length === 0) {
                content.push(...lines([`No results for "${results.query}".`]));
            }
            content.push(...results.grid.content);
            zones.push(...results.grid.zones);
    }
    return { name: "search", content, zones, focus: { zone: "field", key: "query" }, back };
}
