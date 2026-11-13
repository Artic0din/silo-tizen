// Apple TV's library Browse page (TVLibraryGridView + TVBrowseFilterUI + TVAlphabetRail): a
// Sort / Filter control row over the whole library in one scrolling grid, the A–Z rail on the
// right edge, and the Sort and Filter panels over a dimmed page. Nothing here reads.

import type { FocusItem, Zone } from "./browseFocus.ts";
import type { Route, RouteHandlers } from "./browseRoutes.ts";
import { actionButton, errorView, failureError, zoneNode } from "./browseViews.ts";
import { feedGrid, feedGridMinWidth, feedGridWidth } from "./catalogFeed.ts";
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
const railLetters = new WeakMap<LibraryRoute, { readonly node: HTMLElement; readonly items: FocusItem[] }>();
/** The panel each Browse route last drew, so only opening or switching a panel fades it in. */
const shownPanels = new WeakMap<LibraryRoute, "sort" | "filter" | undefined>();
/** minimumScaleFactor (TVBrowseFilterUI.swift:284-285, :480-481 and :346-347). */
const LABEL_MINIMUM_SCALE = 0.85;
const FACET_SUMMARY_MINIMUM_SCALE = 0.8;

/** minimumScaleFactor: a line wider than its box shrinks to fit, down to `minimum`, then truncates. FocusHost places the view synchronously. */
function fitText(node: HTMLElement, minimum: number): void {
    queueMicrotask(() => {
        if (node.clientWidth === 0 || node.scrollWidth <= node.clientWidth) return;
        node.style.fontSize = `${parseFloat(getComputedStyle(node).fontSize) * Math.max(minimum, node.clientWidth / node.scrollWidth)}px`;
    });
}

/**
 * TVLibraryGridView.swift:114-121: the scrim and a closing Sort or Filter panel fade out with easeOut(0.18). Copies fade in a
 * layer beside the page, since each render replaces the page's children; the live panel closes at once, so focus moves now.
 */
export function leavePanel(container: HTMLElement): void {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const live = Array.from(container.querySelectorAll<HTMLElement>(".browse-panel-scrim, .browse-sort-panel, .browse-filter-panel"));
    if (live.length === 0) return;
    const layer = el("div", "browse library-browse browse-panel-layer");
    layer.setAttribute("aria-hidden", "true");
    layer.inert = true;
    const scrolled: [HTMLElement, number][] = [];
    for (const node of live) {
        const ghost = node.cloneNode(true) as HTMLElement;
        const originals = [node, ...Array.from(node.querySelectorAll<HTMLElement>("*"))];
        [ghost, ...Array.from(ghost.querySelectorAll<HTMLElement>("*"))].forEach((part, index) => {
            const original = originals[index];
            // Rows are styled by their focus keys and :focus; the copy keeps their look, focus fill included, without being found as a focus target.
            if (original !== undefined && original.closest("[data-focus]") !== null) {
                const look = getComputedStyle(original);
                for (const name of ["font-size", "font-weight", "width", "height", "margin", "opacity", "flex", "min-width", "background-color", "color", "--icon-ink"]) part.style.setProperty(name, look.getPropertyValue(name));
            }
            if (original !== undefined && original.scrollTop > 0) scrolled.push([part, original.scrollTop]);
            part.removeAttribute("id");
            part.removeAttribute("data-focus");
        });
        ghost.classList.add("browse-panel-leaving");
        layer.appendChild(ghost);
    }
    layer.lastElementChild?.addEventListener("animationend", () => layer.remove(), { once: true });
    container.after(layer);
    // cloneNode drops scroll offsets: a scrolled filter list fades from the rows on screen.
    for (const [part, top] of scrolled) part.scrollTop = top;
}

const ICONS = {
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

/** TVBrowseControlRow's SF Symbols at 24pt medium (TVBrowseFilterUI.swift:33-66, :77), traced in Apple's image frames so each pill keeps Apple's width. */
const PILL_SYMBOLS = {
    "arrow.up.arrow.down": [35, 28, '<path stroke-width="2.5" d="M10.5 24.6V3.6M4.25 9.85L10.5 3.6L16.75 9.85M24.5 3.6V24.4M18.25 18.15L24.5 24.4L30.75 18.15"/>'],
    "line.3.horizontal.decrease": [31, 19, '<path stroke-width="2.3" d="M4.15 3.4H26.6M6.65 9.55H24.1M9.15 15.7H21.6"/>'],
    shuffle: [34, 27, '<path stroke-width="2.41" d="M4.08 6.99H6.88C9.07 6.99 10.55 8.88 12.11 10.8L16.39 16.2C17.95 18.12 19.43 20.01 21.62 20.01H24.5M4.08 20.01H6.88C9.07 20.01 10.55 18.12 12.11 16.2L16.39 10.8C17.95 8.88 19.43 6.99 21.62 6.99H24.5"/><path fill="currentColor" stroke-width="2.08" d="M25.27 3.14L29.76 6.99L25.27 10.84ZM25.27 16.16L29.76 20.01L25.27 23.86Z"/>'],
} as const;

function pillSymbol(name: keyof typeof PILL_SYMBOLS): HTMLElement {
    const [width, height, paths] = PILL_SYMBOLS[name];
    const node = el("span", "browse-icon");
    node.style.width = `${width}px`;
    node.style.height = `${height}px`;
    node.innerHTML = `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
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
    const sortButton = row("sort", [pillSymbol("arrow.up.arrow.down"), `Sort · ${sortKey(filter.sort).label}`, el("span", "browse-control-detail", directionLabel(filter.sort, order))], () => handlers.browse(route, { panel: { kind: "sort" } }));
    const count = activeFacetCount(filter);
    const filterButton = row("filter", [pillSymbol("line.3.horizontal.decrease"), "Filter", ...(count > 0 ? [el("span", "browse-control-count", String(count))] : [])], () => handlers.browse(route, { panel: { kind: "filter", draft: filter, facet: undefined, lastFacet: undefined } }), count > 0 ? `Filter, ${count} active` : "Filter");
    filterButton.element.setAttribute("aria-pressed", String(count > 0));
    const controls = [sortButton, filterButton];
    // TVBrowseControlRow's Shuffle: whole movie, series or mixed libraries only, never a narrowed tab view.
    if (handlers.shuffle !== undefined) {
        const shuffle = row("shuffle", [pillSymbol("shuffle"), "Shuffle"], () => handlers.shuffle?.start(route));
        if (handlers.shuffle.starting) shuffle.element.classList.add("browse-control-starting");
        controls.push(shuffle);
    }
    // The rail and its letters outlive a render, so a held Select stays drawn pressed and the open rail keeps its width
    // and scroll while its choice reloads the grid.
    let rail = railLetters.get(route);
    if (rail === undefined) {
        const items = LETTERS.map(letter => {
            const value = letter === "All" ? undefined : letter;
            const item = actionButton(`letter:${letter}`, letter, () => handlers.browse(route, { filter: { ...(route.discovery?.filter ?? filter), prefix: value } }));
            item.element.setAttribute("aria-label", letter === "All" ? "All titles" : letter === "#" ? "Titles starting with a number or symbol" : `Titles starting with ${letter}`);
            return item;
        });
        rail = { node: zoneNode("browse-letters", items), items };
        railLetters.set(route, rail);
    }
    const letters = rail.items;
    for (const item of letters) item.element.setAttribute("aria-pressed", String(filter.prefix === (item.key === "letter:All" ? undefined : item.key.slice("letter:".length))));
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
        // TVLibraryGridView.swift:188-203, PosterSkeletons.swift:3-12: twelve static placeholders, no shimmer, in the loaded grid's columns.
        const skeleton = el("div", "catalog-grid catalog-skeleton");
        skeleton.style.setProperty("--grid-columns", String(handlers.gridColumns));
        skeleton.style.width = `${feedGridWidth(handlers.gridColumns, handlers.context.posterScale?.() ?? 1)}px`;
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
    // TVLibraryGridView.swift:98-108, :185, :230: the column is at least the grid plus 80 + 80 padding. With the rail (18 closed,
    // 96 open, TVAlphabetRail.swift:67) and 32 trailing it can overflow the 1920 screen, and the HStack centres, so the column
    // moves left by half the overflow and the rail right by the same.
    const minimum = feedGridMinWidth(handlers.gridColumns, handlers.context.posterScale?.() ?? 1) + 160;
    const shift = (railWidth: number): string => `${Math.max(0, minimum + railWidth + 32 - 1920) / 2}px`;
    for (const node of [...content, rail.node]) {
        node.style.setProperty("--browse-shift", shift(18));
        node.style.setProperty("--browse-shift-open", shift(96));
    }
    content.push(rail.node);
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
    const shownPanel = shownPanels.get(route);
    shownPanels.set(route, panel?.kind);
    if (panel === undefined) return { content, zones, back: undefined };
    // TVLibraryGridView.swift:121 animates on `openPanel` changing; a draft edit re-renders the same panel without a fade.
    const entering = shownPanel !== panel.kind ? " browse-panel-enter" : "";
    const scrim = el("div", `browse-panel-scrim${entering}`);
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
        const box = el("div", `browse-panel browse-sort-panel${entering}`);
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
            const summary = el("span", "browse-panel-detail", facetSummary(draft, facet, vocabulary));
            fitText(summary, FACET_SUMMARY_MINIMUM_SCALE);
            const item = row(`facet:${facet}`, [title, summary, icon("chevronRight")], () => edit(draft, facet), `${title}, ${facetSummary(draft, facet, vocabulary)}`);
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
            const label = item.element.querySelector<HTMLElement>(".browse-panel-text");
            if (label !== null) fitText(label, LABEL_MINIMUM_SCALE);
            item.element.setAttribute("role", "menuitemcheckbox");
            item.element.setAttribute("aria-checked", String(on));
            items.push(item);
            body.push(item.element);
        }
    }
    const facetTitle = panel.facet === undefined ? undefined : FACETS.find(entry => entry.facet === panel.facet)?.title;
    const box = el("div", `browse-panel browse-filter-panel${entering}`);
    box.setAttribute("role", "menu");
    const list = el("div", "browse-panel-list");
    list.setAttribute("data-scroll-key", panel.facet ?? "filters");
    list.append(...body);
    const panelTitle = el("h2", "browse-panel-title", facetTitle ?? "Filters");
    fitText(panelTitle, LABEL_MINIMUM_SCALE);
    box.append(el("p", "browse-panel-eyebrow", facetTitle === undefined ? "FILTER BY" : "FILTER"), panelTitle, el("div", "browse-panel-divider"), list);
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
