// A continuously scrolling card grid, as Apple TV's CatalogGrid and TVCatalogGrid: one node for
// the route's whole loaded list, appended in place so focus and scroll stay put, and a request for
// more only once the cards near the end are on screen. Focus moves never read; scrolling does.

import type { Card, CatalogPage } from "../contracts/v2/catalog.ts";
import type { FocusItem, Zone } from "./browseFocus.ts";
import { cardItem, type ViewContext } from "./browseViews.ts";
import { el } from "./screen.ts";

/** Apple tvOS grids use six columns at the standard card size. */
export const FEED_COLUMNS = 6;

interface FeedNode {
    readonly node: HTMLElement;
    readonly cards: Card[];
    readonly items: FocusItem[];
    observer: IntersectionObserver | undefined;
    more: () => void;
    readonly scale: number;
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
export function feedGrid(owner: object, page: CatalogPage, context: ViewContext, lead: number, busy: boolean, more: () => void, columns = FEED_COLUMNS): FeedGrid {
    let feed = feeds.get(owner);
    const scale = context.posterScale?.() ?? 1;
    const overlays = context.cardOverlays?.();
    const extends_ = feed !== undefined && feed.cards.length <= page.items.length && feed.cards.every((card, index) => page.items[index] === card);
    if (feed === undefined || !extends_ || feed.scale !== scale || feed.overlays !== overlays) {
        feed?.observer?.disconnect();
        feed = { node: el("div", "browse-grid catalog-grid"), cards: [], items: [], observer: undefined, more, scale, overlays };
        feeds.set(owner, feed);
    }
    feed.node.style.setProperty("--grid-columns", String(columns));
    feed.node.style.width = `${Math.max(1710, columns * 260 * scale + (columns - 1) * 40)}px`;
    feed.node.style.setProperty("--grid-lift", String((390 * scale + 38) / (390 * scale)));
    feed.more = more;
    const added = page.items.slice(feed.cards.length);
    for (const card of added) {
        feed.cards.push(card);
        const item = cardItem(card, { ...context, homeCaptions: true, overlays, posterWidth: 260 });
        if (item === undefined) continue;
        feed.items.push(item);
        feed.node.appendChild(item.element);
    }
    watchEnd(feed, !busy && page.nextCursor !== undefined, lead);
    const spinner = busy && feed.items.length > 0 ? [loadingMore()] : [];
    return { content: [feed.node, ...spinner], zones: [{ id: "grid", layout: "grid", columns, items: feed.items }] };
}

export function stopFeed(owner: object): void {
    const feed = feeds.get(owner);
    feed?.observer?.disconnect();
    if (feed !== undefined) feed.observer = undefined;
}

/** Re-arms only when the list grows, so a failed read waits for the end to scroll back into view. */
function watchEnd(feed: FeedNode, hasMore: boolean, lead: number): void {
    feed.observer?.disconnect();
    feed.observer = undefined;
    if (!hasMore || typeof IntersectionObserver === "undefined") return;
    const targets = feed.items.slice(Math.max(0, feed.items.length - lead)).map(item => item.element);
    const observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting && entry.target.isConnected)) feed.more();
    });
    for (const target of targets) observer.observe(target);
    feed.observer = observer;
}

function loadingMore(): HTMLElement {
    const node = el("div", "section-catalog-loading");
    node.setAttribute("role", "status");
    node.setAttribute("aria-label", "Loading more titles");
    return node;
}
