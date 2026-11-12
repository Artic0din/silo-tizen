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
    /** Item count the live observer was armed for. A failed read keeps it, so the end must leave and return. */
    watched: number;
    /** A read failed while the end was on screen: wait for it to leave before reading again (TVLibraryGridViewModel.swift:337-339). */
    waitsForExit: boolean;
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
export function feedGrid(owner: object, page: CatalogPage, context: ViewContext, lead: number, busy: boolean, more: () => void, columns = FEED_COLUMNS, posterWidth = 260, gridWidth?: number): FeedGrid {
    let feed = feeds.get(owner);
    const scale = context.posterScale?.() ?? 1;
    const overlays = context.cardOverlays?.();
    const hidesImages = context.spoilers?.().hidesImages ?? false;
    const extends_ = feed !== undefined && feed.cards.length <= page.items.length && feed.cards.every((card, index) => page.items[index] === card);
    if (feed === undefined || !extends_ || feed.scale !== scale || feed.overlays !== overlays || feed.hidesImages !== hidesImages) {
        feed?.observer?.disconnect();
        feed = { node: el("div", "browse-grid catalog-grid"), cards: [], items: [], observer: undefined, watched: 0, waitsForExit: false, more, scale, overlays, hidesImages };
        feeds.set(owner, feed);
    }
    feed.node.style.setProperty("--grid-columns", String(columns));
    feed.node.style.width = `${gridWidth ?? Math.max(1710, columns * 260 * scale + (columns - 1) * 40)}px`;
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

/** After a failed read, the next request waits until the end has scrolled away and back; a re-armed observer alone does not read. */
export function waitForFeedEnd(owner: object): void {
    const feed = feeds.get(owner);
    if (feed !== undefined) feed.waitsForExit = true;
}

export function stopFeed(owner: object): void {
    const feed = feeds.get(owner);
    feed?.observer?.disconnect();
    if (feed !== undefined) feed.observer = undefined;
}

/** Re-arms only when the list grows, so a failed read waits for the end to scroll back into view. */
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
    const observer = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting && entry.target.isConnected) shown.add(entry.target); else shown.delete(entry.target);
        if (feed.waitsForExit) { feed.waitsForExit = shown.size > 0; return; }
        if (entries.some(entry => entry.isIntersecting && entry.target.isConnected)) feed.more();
    });
    for (const target of targets) observer.observe(target);
    feed.observer = observer;
    feed.watched = feed.items.length;
}

/** TVCatalogGrid.swift:83-91: a spinning ProgressView centred under the grid. */
function loadingMore(): HTMLElement {
    const node = el("div", "section-catalog-loading");
    node.setAttribute("role", "status");
    node.setAttribute("aria-label", "Loading more titles");
    node.innerHTML = SPINNER_ICON;
    return node;
}
