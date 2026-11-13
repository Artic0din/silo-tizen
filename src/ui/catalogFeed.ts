// A continuously scrolling card grid, as Apple TV's CatalogGrid and TVCatalogGrid: one node for
// the route's whole loaded list, appended in place so focus and scroll stay put, and a request for
// more only once the cards near the end are on screen. Focus moves never read; scrolling does.

import type { Card, CatalogPage } from "../contracts/v2/catalog.ts";
import type { FocusItem, Zone } from "./browseFocus.ts";
import { cardItem, type ViewContext } from "./browseViews.ts";
import { SPINNER_ICON } from "./requestsScene.ts";
import { el } from "./screen.ts";

/** Apple tvOS grids use six columns at the standard card size. */
export const FEED_COLUMNS = 6;

interface FeedNode {
    readonly node: HTMLElement;
    readonly cards: Card[];
    readonly items: FocusItem[];
    observer: IntersectionObserver | undefined;
    /** Item count the live observer was armed for. A failed read keeps it, so only a newly shown card reads again. */
    watched: number;
    /** Where the grid sat when a read failed (TVLibraryGridViewModel.swift:337-339); until it moves, no card can newly come on screen. */
    failedTop: number | undefined;
    more: () => void;
    readonly scale: number;
    readonly hidesImages: boolean;
    readonly overlays: ReturnType<NonNullable<ViewContext["cardOverlays"]>>;
}

const feeds = new WeakMap<object, FeedNode>();

export interface FeedGrid {
    readonly content: HTMLElement[];
    readonly zones: Zone[];
}

/**
 * `owner` keys the node (one per route list); `lead` is how many cards from the end must be on
 * screen before `more` runs. A list that is not an extension of the shown one is rebuilt.
 */
/** The catalog grid's width for its columns at a poster scale; the Browse placeholders use it too. */
export function feedGridWidth(columns: number, scale: number): number {
    return Math.max(1710, feedGridMinWidth(columns, scale));
}

/** The cards and gaps alone, which Apple's grid cells never shrink below (TVCatalogGrid.swift:102-143). */
export function feedGridMinWidth(columns: number, scale: number): number {
    return columns * 260 * scale + (columns - 1) * 40;
}

export function feedGrid(owner: object, page: CatalogPage, context: ViewContext, lead: number, busy: boolean, more: () => void, columns = FEED_COLUMNS, posterWidth = 260, gridWidth?: number): FeedGrid {
    let feed = feeds.get(owner);
    const scale = context.posterScale?.() ?? 1;
    const overlays = context.cardOverlays?.();
    const hidesImages = context.spoilers?.().hidesImages ?? false;
    const extends_ = feed !== undefined && feed.cards.length <= page.items.length && feed.cards.every((card, index) => page.items[index] === card);
    if (feed === undefined || !extends_ || feed.scale !== scale || feed.overlays !== overlays || feed.hidesImages !== hidesImages) {
        feed?.observer?.disconnect();
        feed = { node: el("div", "browse-grid catalog-grid"), cards: [], items: [], observer: undefined, watched: 0, failedTop: undefined, more, scale, overlays, hidesImages };
        feeds.set(owner, feed);
    }
    feed.node.style.setProperty("--grid-columns", String(columns));
    feed.node.style.width = `${gridWidth ?? feedGridWidth(columns, scale)}px`;
    feed.more = more;
    const added = page.items.slice(feed.cards.length);
    for (const card of added) {
        feed.cards.push(card);
        const item = cardItem(card, { ...context, homeCaptions: true, overlays, posterWidth });
        if (item === undefined) continue;
        feed.items.push(item);
        feed.node.appendChild(item.element);
    }
    // Leave the armed observer alone while a page is in flight. Recreating it would see the same end and read again.
    if (!busy) watchEnd(feed, page.nextCursor !== undefined, lead);
    const spinner = busy && feed.items.length > 0 ? [loadingMore()] : [];
    return { content: [feed.node, ...spinner], zones: [{ id: "grid", layout: "grid", columns, items: feed.items }] };
}

/** After a failed read, only a card newly on screen reads again; a re-armed observer or cards already shown do not. */
export function waitForFeedEnd(owner: object): void {
    const feed = feeds.get(owner);
    if (feed !== undefined) feed.failedTop = feed.node.getBoundingClientRect().top;
}

export function stopFeed(owner: object): void {
    const feed = feeds.get(owner);
    feed?.observer?.disconnect();
    if (feed !== undefined) feed.observer = undefined;
}

/** Re-arms only when the list grows, so a failed read waits for a near-end card to come on screen. */
function watchEnd(feed: FeedNode, hasMore: boolean, lead: number): void {
    if (!hasMore) {
        feed.observer?.disconnect();
        feed.observer = undefined;
        feed.watched = 0;
        return;
    }
    if (feed.observer !== undefined && feed.watched === feed.items.length) return;
    feed.observer?.disconnect();
    const targets = feed.items.slice(Math.max(0, feed.items.length - lead)).map(item => item.element);
    const shown = new Set<Element>();
    // TVCatalogGrid.swift:131-133: each near-end cell's .onAppear reads more. After a failure the cards still showing stay quiet,
    // and the next card brought on screen by a scroll retries. A repaint re-inserts the grid, which reports every shown card
    // again, so an arrival counts only once the grid has moved.
    const observer = new IntersectionObserver(entries => {
        let appeared = false;
        for (const entry of entries) {
            if (entry.isIntersecting && entry.target.isConnected) {
                if (!shown.has(entry.target)) appeared = true;
                shown.add(entry.target);
            } else shown.delete(entry.target);
        }
        // Any scroll since the failure, cards leaving included, ends the wait; a card coming back then reads.
        if (feed.failedTop !== undefined && Math.abs(feed.node.getBoundingClientRect().top - feed.failedTop) >= 1) feed.failedTop = undefined;
        if (appeared && feed.failedTop === undefined) feed.more();
    });
    for (const target of targets) observer.observe(target);
    feed.observer = observer;
    feed.watched = feed.items.length;
}

/** TVCatalogGrid.swift:83-91: a spinning ProgressView centred under the grid, shared by every paged grid. */
export function loadingMore(): HTMLElement {
    const node = el("div", "section-catalog-loading");
    node.setAttribute("role", "status");
    node.setAttribute("aria-label", "Loading more titles");
    node.innerHTML = SPINNER_ICON;
    return node;
}
