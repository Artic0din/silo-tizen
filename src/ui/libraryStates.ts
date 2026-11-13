// The library tab's loading and empty pages, after silo-apple 5780c84: EmptyStateView, tvPageFocusOwner and
// TVLibraryBrowseLoadingView. Nothing here reads.

import type { FocusItem } from "./browseFocus.ts";
import { artworkMark } from "./defaultArtwork.ts";
import { group, skeleton, SPINNER_ICON } from "./requestsScene.ts";
import { el } from "./screen.ts";

export type StateSymbol = "film.stack" | "tv" | "book.closed" | "square.stack" | "line.3.horizontal.decrease.circle";

/** Drawn stand-ins for the SF Symbols; tv and book.closed reuse the default-artwork marks. */
const STROKED: Readonly<Record<Exclude<StateSymbol, "tv" | "book.closed">, string>> = {
    "film.stack": '<path d="M6 3.5h12"/><rect x="3" y="7" width="18" height="14" rx="2.5"/><path d="M7.5 7v14M16.5 7v14M3 11.7h4.5M3 16.3h4.5M16.5 11.7H21M16.5 16.3H21"/>',
    "square.stack": '<path d="M9 2.5h6M6.5 5h11"/><rect x="4" y="8" width="16" height="13" rx="3"/>',
    "line.3.horizontal.decrease.circle": '<circle cx="12" cy="12" r="10"/><path d="M7 8.5h10M8.5 12h7M10.5 15.5h3"/>',
};

export function stateIcon(symbol: StateSymbol, className: string): Element {
    if (symbol === "tv" || symbol === "book.closed") return artworkMark(symbol, className);
    const icon = el("span", className);
    icon.setAttribute("aria-hidden", "true");
    icon.dataset.symbol = symbol;
    icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${STROKED[symbol]}</svg>`;
    return icon;
}

/** EmptyStateView (Components/EmptyStateView.swift:9-27): icon, title and an optional body, centred in its frame. */
export function emptyState(symbol: StateSymbol, title: string, subtitle?: string): HTMLElement {
    const state = el("div", "library-empty");
    state.append(stateIcon(symbol, "library-empty-icon"), el("h2", "library-empty-title", title));
    if (subtitle !== undefined) state.append(el("p", "library-empty-body", subtitle));
    return state;
}

/** tvPageFocusOwner: a page with nothing to act on still holds focus, so focus leaves the bar and the bar dims. */
export function pageOwner(page: HTMLElement, label: string): FocusItem {
    page.tabIndex = -1;
    page.setAttribute("data-focus", "library-page");
    page.setAttribute("aria-label", label);
    // The page is the whole tab body, so focusing it scrolls the content back to its top.
    page.setAttribute("data-scroll-top", "");
    return { key: "library-page", element: page };
}

/** TVLibraryBrowseLoadingView (TVLibraryBrowseView.swift:188-274): the marquee and first row's outline, and a loading line. */
export function recommendedLoading(libraryName: string): HTMLElement {
    const spinner = el("span", "requests-loading-spinner");
    spinner.setAttribute("aria-hidden", "true");
    spinner.innerHTML = SPINNER_ICON;
    const marquee = group("requests-loading-marquee", skeleton(520, 72, .14, 12),
        group("requests-loading-meta", skeleton(118, 22, .12), skeleton(82, 22, .12), skeleton(150, 22, .12)),
        group("requests-loading-copy", skeleton(720, 18, .12), skeleton(610, 18, .12)),
        group("requests-loading-status", spinner, el("span", "library-loading-label", `Loading ${libraryName}`)));
    const cards = Array.from({ length: 5 }, () => group("library-loading-card", skeleton(330, 186, .11, 16), skeleton(210, 16, .12)));
    const page = group("library-loading", marquee, group("requests-loading-rail", skeleton(300, 28, .12), group("library-loading-cards", ...cards)));
    page.setAttribute("role", "status");
    return page;
}
