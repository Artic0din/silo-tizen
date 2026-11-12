// Apple TV's library Browse page (TVLibraryGridView + TVBrowseFilterUI + TVAlphabetRail): a
// Sort / Filter control row over the whole library in one scrolling grid, the A–Z rail on the
// right edge, and the Sort and Filter panels over a dimmed page. Nothing here reads.

import type { FocusItem, Zone } from "./browseFocus.ts";
import type { Route, RouteHandlers } from "./browseRoutes.ts";
import { actionButton, errorView, failureError, zoneNode } from "./browseViews.ts";
import { feedGrid } from "./catalogFeed.ts";
import { activeFacetCount, canReset, cleared, directionLabel, effectiveOrder, FACETS, facetSummary, options, reset, selected, sortKey, sortKeysFor, toggled, withSort, type BrowseFilter } from "./libraryBrowse.ts";
import type { DiscoveryState } from "./libraryDiscovery.ts";
import { emptyState, type StateSymbol } from "./libraryStates.ts";
import { el } from "./screen.ts";

/** TVLibraryGridViewModel.pageSize and TVCatalogGrid's prefetch lead. */
export const BROWSE_PAGE_SIZE = 100;
/** Eight rows of the grid's columns (prefetchRowsRemaining × columns). */
export const BROWSE_LOAD_ROWS = 8;
const LETTERS = ["All", "#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

type LibraryRoute = Extract<Route, { kind: "library" }>;

const ICONS = {
    sort: '<path d="M7 4v15M3 8l4-4 4 4M17 20V5M13 16l4 4 4-4"/>',
    filter: '<path d="M3 6h18M6 12h12M10 18h4"/>',
    check: '<path d="M4 12.5l5 5L20 6.5"/>',
    up: '<path d="M12 20V4M5 11l7-7 7 7"/>',
    shuffle: '<path d="M3 7h3.5c2 0 3.2 1 4.3 2.7l2.4 4.6C14.3 16 15.5 17 17.5 17H21M3 17h3.5c1.4 0 2.4-.5 3.2-1.4M14.3 8.4C15.1 7.5 16.1 7 17.5 7H21M18 4l3 3-3 3M18 14l3 3-3 3"/>',
    checkbox: '<rect x="4" y="4" width="16" height="16" rx="3"/>',
    checkedBox: '<rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor" stroke="none"/><path d="M8 12.5l3 3 5-6" stroke="var(--icon-ink, #000)"/>',
    down: '<path d="M12 4v16M5 13l7 7 7-7"/>',
    chevronRight: '<path d="M9 5l7 7-7 7"/>',
    chevronLeft: '<path d="M15 5l-7 7 7 7"/>',
    clear: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v5h5"/>',
    circle: '<circle cx="12" cy="12" r="9"/>',
    selectedCircle: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M7.5 12.5l3 3 6-6.5" stroke="var(--icon-ink, #000)"/>',
} as const;

export function icon(name: keyof typeof ICONS): HTMLElement {
    const node = el("span", "browse-icon");
    node.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
    return node;
}

function row(key: string, parts: readonly (HTMLElement | string)[], onPress: () => void, label?: string): FocusItem {
    const item = actionButton(key, "", onPress);
    item.element.classList.add("browse-panel-row");
    for (const part of parts) item.element.append(typeof part === "string" ? el("span", "browse-panel-text", part) : part);
    if (label !== undefined) item.element.setAttribute("aria-label", label);
    return item;
}

export function shuffleAlert(content: HTMLElement[], zones: Zone[], handlers: RouteHandlers): BrowsePage | undefined {
    const failure = handlers.shuffle?.failure;
    if (failure === undefined || handlers.shuffle === undefined) return undefined;
    for (const node of content) { node.inert = true; node.setAttribute("aria-hidden", "true"); }
    // ShuffleFailureAlert: a modal "Couldn't Shuffle" with the reason and one OK; Back also closes it.
    const dismiss = handlers.shuffle.dismiss;
    const ok = actionButton("alert-ok", "OK", dismiss);
    const box = el("div", "browse-panel browse-alert");
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");
    const title = el("h2", "browse-alert-title", "Couldn't Shuffle");
    title.id = "browse-alert-title";
    const message = el("p", "browse-alert-message", failure);
    message.id = "browse-alert-message";
    box.setAttribute("aria-labelledby", title.id);
    box.setAttribute("aria-describedby", message.id);
    box.append(title, message, zoneNode("browse-alert-actions", [ok]));
    return { content: [...content, el("div", "browse-panel-scrim"), box], zones: [...zones.map(zone => ({ ...zone, items: [] })), { id: "panel", layout: "row", up: "panel", down: "panel", left: "panel", right: "panel", items: [ok] }], back: dismiss };
}

export interface BrowsePage {
    readonly content: HTMLElement[];
    readonly zones: Zone[];
    /** Back closes an open panel first. */
    readonly back: (() => void) | undefined;
}

export function browsePage(route: LibraryRoute, state: DiscoveryState, handlers: RouteHandlers): BrowsePage {
    const filter = state.filter;
    const apply = (next: BrowseFilter): void => handlers.browse(route, { filter: next, panel: undefined });
    const order = effectiveOrder(filter);
    const sortButton = row("sort", [icon("sort"), `Sort · ${sortKey(filter.sort).label}`, el("span", "browse-control-detail", directionLabel(filter.sort, order))], () => handlers.browse(route, { panel: { kind: "sort" } }));
    const count = activeFacetCount(filter);
    const filterButton = row("filter", [icon("filter"), "Filter", ...(count > 0 ? [el("span", "browse-control-count", String(count))] : [])], () => handlers.browse(route, { panel: { kind: "filter", draft: filter, facet: undefined, lastFacet: undefined } }), count > 0 ? `Filter, ${count} active` : "Filter");
    filterButton.element.setAttribute("aria-pressed", String(count > 0));
    const controls = [sortButton, filterButton];
    // TVBrowseControlRow's Shuffle: whole movie, series or mixed libraries only, never a narrowed tab view.
    if (handlers.shuffle !== undefined) {
        const shuffle = row("shuffle", [icon("shuffle"), "Shuffle"], () => handlers.shuffle?.start(route));
        if (handlers.shuffle.starting) shuffle.element.classList.add("browse-control-starting");
        controls.push(shuffle);
    }
    const letters = LETTERS.map(letter => {
        const value = letter === "All" ? undefined : letter;
        const item = actionButton(`letter:${letter}`, letter, () => handlers.browse(route, { filter: { ...filter, prefix: value } }));
        item.element.setAttribute("aria-label", letter === "All" ? "All titles" : letter === "#" ? "Titles starting with a number or symbol" : `Titles starting with ${letter}`);
        item.element.setAttribute("aria-pressed", String(filter.prefix === value));
        return item;
    });
    const content: HTMLElement[] = [zoneNode("browse-controls", controls)];
    // TVLibraryGridView's control row onMoveUp is the top bar, not a pill row.
    const controlZone: Zone = { id: "controls", layout: "row", down: "grid", up: "nav", items: controls };
    const zones: Zone[] = [controlZone];
    const page = route.pages.page;
    let railLeft = "controls";
    if (page !== undefined && page.items.length > 0) {
        const { preview, ...context } = handlers.context;
        void preview;
        const grid = feedGrid(route.pages, page, context, BROWSE_LOAD_ROWS * handlers.gridColumns, handlers.busy, () => handlers.more(route), handlers.gridColumns);
        content.push(...grid.content);
        // TVLibraryGridViewModel.swift:337-339: a failed later page keeps the grid and shows nothing.
        zones.push(...grid.zones.map(zone => ({ ...zone, up: "controls", down: "grid", right: "letters" })));
        railLeft = "grid";
    } else if (route.failure !== undefined) {
        // TVLibraryGridView.swift:204-205: Apple's ErrorView under the control row. Browse is a tab root, so no Go Back.
        const failure = errorView(`library:${route.library.id}`, failureError(route.failure, route.error), () => handlers.retry(route), undefined, handlers.signIn);
        content.push(...failure.content);
        zones.push(...failure.zones.map(zone => ({ ...zone, up: "controls", right: "letters" })));
        zones[0] = { ...controlZone, down: "status" };
        railLeft = "status";
    } else if (page === undefined) {
        // TVLibraryGridView.swift:188-203, PosterSkeletons.swift:3-12: twelve static placeholders, no shimmer.
        const skeleton = el("div", "catalog-grid catalog-skeleton");
        skeleton.setAttribute("role", "status");
        skeleton.setAttribute("aria-label", "Loading");
        for (let index = 0; index < 12; index++) skeleton.appendChild(el("div", "poster-skeleton"));
        content.push(skeleton);
    } else if (state.emptyReason === "noFilterMatches") {
        // TVLibraryGridView.emptyState .noFilterMatches (:268-284): Clear filters keeps the sort.
        const clear = row("clear-filters", [icon("clear"), "Clear filters"], () => handlers.browse(route, { filter: { ...reset(filter), prefix: undefined }, focus: { zone: "controls", key: "sort" } }));
        const empty = el("div", "browse-empty-state");
        empty.append(emptyState("line.3.horizontal.decrease.circle", "No titles match your filters"), zoneNode("browse-empty-actions", [clear]));
        content.push(empty);
        zones.push({ id: "empty", layout: "row", up: "controls", right: "letters", items: [clear] });
        zones[0] = { ...controlZone, down: "empty" };
        railLeft = "empty";
    } else {
        // TVLibraryGridView.emptyState .libraryEmpty (:262-267, :296-300): inert; the controls and rail keep focus.
        const symbol: StateSymbol = route.library.type === "series" ? "tv" : route.library.type === "audiobooks" ? "book.closed" : "film.stack";
        const empty = el("div", "browse-empty-state");
        empty.append(emptyState(symbol, "This library is empty", "There is nothing in this library yet."));
        content.push(empty);
    }
    const rail = zoneNode("browse-letters", letters);
    content.push(rail);
    zones.push({ id: "letters", layout: "column", left: railLeft, up: "letters", down: "letters", items: letters });
    const failure = handlers.shuffle?.failure;
    for (const node of content) {
        const modal = state.panel !== undefined || failure !== undefined;
        node.inert = modal;
        if (modal) node.setAttribute("aria-hidden", "true"); else node.removeAttribute("aria-hidden");
    }
    const alert = shuffleAlert(content, zones, handlers);
    if (alert !== undefined) return alert;
    const panel = state.panel;
    if (panel === undefined) return { content, zones, back: undefined };
    const scrim = el("div", "browse-panel-scrim");
    if (panel.kind === "sort") {
        const items = sortKeysFor(route.library.type).map(entry => {
            const current = entry.key === filter.sort;
            const parts: (HTMLElement | string)[] = [current ? icon("check") : el("span", "browse-icon"), entry.label];
            if (current) parts.push(el("span", "browse-panel-detail", directionLabel(entry.key, order)), icon(order === "asc" ? "up" : "down"));
            const item = row(`sort:${entry.key}`, parts, () => apply(withSort(filter, entry.key)), current ? `${entry.label}, ${directionLabel(entry.key, order)}` : entry.label);
            item.element.setAttribute("aria-checked", String(current));
            item.element.setAttribute("role", "menuitemradio");
            return item;
        });
        const box = el("div", "browse-panel browse-sort-panel");
        box.setAttribute("role", "menu");
        box.append(el("p", "browse-panel-eyebrow", "SORT BY"), ...items.map(item => item.element));
        return { content: [...content, scrim, box], zones: [...zones.map(zone => ({ ...zone, items: [] })), { id: "panel", layout: "column", up: "panel", down: "panel", items }], back: () => handlers.browse(route, { panel: undefined, focus: { zone: "controls", key: "sort" } }) };
    }
    const draft = panel.draft;
    const vocabulary = state.data?.filters;
    const edit = (next: BrowseFilter, facet = panel.facet): void => handlers.browse(route, { panel: { ...panel, draft: next, facet } });
    const done = (): void => handlers.browse(route, { filter: draft, panel: undefined, focus: { zone: "controls", key: "sort" } });
    const items: FocusItem[] = [];
    const body: HTMLElement[] = [];
    const section = (title: string): void => { body.push(el("p", "browse-panel-section", title)); };
    if (panel.facet === undefined) {
        const available = FACETS.filter(({ facet }) => options(facet, vocabulary).length > 0);
        if (available.length === 0) body.push(el("p", "browse-panel-note", "No filters available"));
        for (const { facet, title } of available) {
            const item = row(`facet:${facet}`, [title, el("span", "browse-panel-detail", facetSummary(draft, facet, vocabulary)), icon("chevronRight")], () => edit(draft, facet), `${title}, ${facetSummary(draft, facet, vocabulary)}`);
            items.push(item);
            body.push(item.element);
        }
        section("MATCH");
        for (const [all, title] of [[true, "All selected filters"], [false, "Any selected filter"]] as const) {
            const item = row(`match:${all ? "all" : "any"}`, [icon(draft.matchAll === all ? "selectedCircle" : "circle"), title], () => edit({ ...draft, matchAll: all }));
            item.element.setAttribute("role", "menuitemradio");
            item.element.setAttribute("aria-checked", String(draft.matchAll === all));
            items.push(item);
            body.push(item.element);
        }
        section("OPTIONS");
        const preserve = handlers.preserve(route);
        const preserveRow = row("preserve", [icon(preserve ? "checkedBox" : "checkbox"), "Preserve sort & filters"], () => handlers.browse(route, { preserve: !preserve }));
        preserveRow.element.setAttribute("role", "menuitemcheckbox");
        preserveRow.element.setAttribute("aria-checked", String(preserve));
        items.push(preserveRow);
        body.push(preserveRow.element);
        // Apple disables Reset when there is nothing to reset: shown, dimmed and not a focus stop.
        const resetRow = row("reset", [icon("reset"), "Reset filters"], () => handlers.browse(route, { panel: { ...panel, draft: reset(draft) }, focus: { zone: "panel", key: "done" } }));
        if (canReset(draft)) items.push(resetRow);
        else { resetRow.element.setAttribute("aria-disabled", "true"); resetRow.element.setAttribute("disabled", ""); }
        body.push(resetRow.element);
        const finish = row("done", [icon("check"), "Done"], done);
        finish.element.classList.add("browse-panel-done");
        items.push(finish);
        body.push(finish.element);
    } else {
        const facet = panel.facet;
        const back = row("facet-back", [icon("chevronLeft"), "All filters"], () => handlers.browse(route, { panel: { ...panel, facet: undefined, lastFacet: facet } }));
        items.push(back);
        body.push(back.element);
        if (selected(draft, facet).length > 0) {
            const title = FACETS.find(entry => entry.facet === facet)?.title ?? "";
            const first = options(facet, vocabulary)[0];
            const clear = row(`clear:${facet}`, [icon("clear"), `Clear ${title}`], () => handlers.browse(route, { panel: { ...panel, draft: cleared(draft, facet) }, focus: first === undefined ? { zone: "panel", key: "facet-back" } : { zone: "panel", key: `value:${first.value}` } }));
            items.push(clear);
            body.push(clear.element);
        }
        for (const option of options(facet, vocabulary)) {
            const on = selected(draft, facet).includes(option.value);
            const item = row(`value:${option.value}`, [icon(on ? "selectedCircle" : "circle"), option.label], () => edit(toggled(draft, facet, option.value)));
            item.element.setAttribute("role", "menuitemcheckbox");
            item.element.setAttribute("aria-checked", String(on));
            items.push(item);
            body.push(item.element);
        }
    }
    const facetTitle = panel.facet === undefined ? undefined : FACETS.find(entry => entry.facet === panel.facet)?.title;
    const box = el("div", "browse-panel browse-filter-panel");
    box.setAttribute("role", "menu");
    const list = el("div", "browse-panel-list");
    list.setAttribute("data-scroll-key", panel.facet ?? "filters");
    list.append(...body);
    box.append(el("p", "browse-panel-eyebrow", facetTitle === undefined ? "FILTER BY" : "FILTER"), el("h2", "browse-panel-title", facetTitle ?? "Filters"), el("div", "browse-panel-divider"), list);
    // Back on a facet's values returns to the list; on the list it applies and closes, as Apple's onExitCommand.
    const back = panel.facet === undefined ? done : () => handlers.browse(route, { panel: { ...panel, facet: undefined, lastFacet: panel.facet } });
    // Left on a facet's values returns to the list (TVBrowseFilterPanel.onMoveCommand).
    return { content: [...content, scrim, box], zones: [...zones.map(zone => ({ ...zone, items: [] })), { id: "panel", layout: "column", up: "panel", down: "panel", items, ...(panel.facet === undefined ? {} : { onLeft: back }) }], back };
}

/** Where focus lands when a panel opens or changes screen: the current choice, as Apple's claimFocus. */
export function panelFocus(state: DiscoveryState): { zone: string; key: string } | undefined {
    const panel = state.panel;
    if (panel === undefined) return undefined;
    if (panel.kind === "sort") return { zone: "panel", key: `sort:${state.filter.sort}` };
    if (panel.facet === undefined) {
        const facet = panel.lastFacet ?? FACETS.find(({ facet }) => options(facet, state.data?.filters).length > 0)?.facet;
        return facet === undefined ? { zone: "panel", key: "done" } : { zone: "panel", key: `facet:${facet}` };
    }
    return { zone: "panel", key: "facet-back" };
}
