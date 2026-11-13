import type { CatalogBoxSet } from "../contracts/v2/boxSets.ts";
import { boxSetAccessibilityLabel, boxSetCardCaption, boxSetFilmCount, boxSetWatchedProgress } from "../contracts/v2/boxSets.ts";
import type { Person } from "../contracts/v2/details.ts";
import type { RequestTitle } from "../contracts/v2/requests.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { actionButton, artwork, searchLoading, zoneNode } from "./browseViews.ts";
import { newRoute, type Route, type RouteHandlers } from "./browseRoutes.ts";
import type { SearchFilter } from "./browseModel.ts";
import { defaultArtwork } from "./defaultArtwork.ts";
import { requestCard, requestsState } from "./requests.ts";
import { requestProgress } from "./requestProgress.ts";
import { el } from "./screen.ts";
import { searchRail } from "./searchRail.ts";
import { balanceTwoLineText, fitCentredLine } from "./textLayout.ts";

export interface SearchSupplement {
    people?: readonly Person[];
    peoplePending?: boolean;
    peopleFailure?: boolean;
    /** Matching box sets, best match first, at most five. Absent until that lookup is asked. */
    boxSets?: readonly CatalogBoxSet[];
    boxSetsPending?: boolean;
    requests?: readonly RequestTitle[] | undefined;
    requestsFor?: string | undefined;
}

/**
 * TVCatalogGrid: poster-wide columns 40 apart (TVCatalogGrid.swift:39), 260px apart at the standard size. The track is
 * the poster itself, so the TV's browser cannot grow a `minmax(0, 1fr)` column, and the grid is as wide as its columns.
 * The count is a literal so `repeat(var())` cannot drop the declaration.
 */
function lockSearchColumns(node: HTMLElement, columns: number): void {
    node.style.setProperty("--search-columns", String(columns));
    node.style.gridTemplateColumns = `repeat(${columns}, calc(220px * var(--poster-scale, 1)))`;
    node.style.width = "max-content";
}

export function searchRequestCatalogId(title: RequestTitle): string | undefined {
    return requestProgress(title)?.display === "inLibrary" && title.libraryContentId?.trim() ? title.libraryContentId : undefined;
}

/** Presentation boundary for the shared Requests card owner. No catalog identity is fabricated. */
export function searchRequestCard(title: RequestTitle, baseUrl: string, open: () => void): FocusItem {
    return requestCard(title, baseUrl, open);
}

export function globalSearchView(view: View, route: Extract<Route, { kind: "search" }>, h: RouteHandlers): View {
    const choices: readonly (readonly [SearchFilter | undefined, string])[] = [[undefined, "All"], ["movie", "Movies"], ["series", "Series"], ...(h.audiobooksEnabled ? [["audiobook", "Audiobooks"] as const] : [])];
    const filters = choices.map(([value, label]) => {
        const item = actionButton(`search-filter:${value ?? "all"}`, label, () => h.searchFilter(route, value));
        item.element.addEventListener("focus", () => h.searchFilter(route, value));
        item.element.setAttribute("aria-pressed", String(route.filter === value));
        return item;
    });
    const content = [...h.searchHead], zones: Zone[] = view.zones.slice(0, 1);
    if (route.query.trim() !== "") {
        content.push(zoneNode("browse-actions search-filters", filters));
        zones.push({ id: "search-filters", layout: "row", items: filters });
    }
    const supplement = route.supplement;
    const people = supplement?.people ?? [];
    const boxSets = supplement?.boxSets ?? [];
    const titleCount = route.pages?.page?.items.length ?? 0;
    // SearchViewModel.contentState: a spinner only while a search runs with nothing to show; shown results stay until replaced.
    const waitingForSupplement = route.failure === undefined && titleCount === 0 && people.length === 0 && boxSets.length === 0
        && (h.busy || supplement?.peoplePending === true || supplement?.boxSetsPending === true);
    if (waitingForSupplement && !view.content.some(node => node.classList.contains("search-progress"))) content.push(searchLoading());
    if (route.failure === undefined && boxSets.length > 0) {
        const items = boxSets.map(set => boxSetSearchCard(set, h.context.baseUrl, () => h.push(newRoute({ kind: "boxSet", id: set.id, libraryId: set.libraryId, title: set.title, data: undefined }))));
        const grid = zoneNode("browse-grid", items);
        grid.dataset.section = "search-box-sets";
        lockSearchColumns(grid, h.gridColumns);
        content.push(el("h2", "browse-section-title search-box-sets-heading", "Box Sets"), grid);
        zones.push({ id: "search-box-sets", layout: "grid", spatial: true, columns: h.gridColumns, items });
    }
    if (route.failure === undefined && people.length > 0) {
        const items = people.map(person => {
            const item = actionButton(`person:${person.id}`, person.name, () => h.context.open({ kind: "person", id: person.id, title: person.name }));
            item.element.className = "browse-card details-person";
            item.element.replaceChildren(artwork("browse-art details-photo", person.photoUrl, h.context.baseUrl, ""), el("span", "browse-card-title", person.name));
            return item;
        });
        const rail = searchRail("details-people search-people-rail", items);
        rail.dataset.section = "search-people";
        requestAnimationFrame(() => {
            if (!rail.isConnected) return;
            for (const caption of rail.querySelectorAll<HTMLElement>(".browse-card-title")) balanceTwoLineText(caption);
        });
        content.push(el("h2", "browse-section-title search-people-heading", "People"), rail);
        zones.push({ id: "search-people", layout: "row", spatial: true, items });
    }
    const page = route.pages?.page;
    if (route.failure === undefined && page !== undefined && page.items.length > 0) {
        // SearchViewModel.total: the response total, or the loaded count when the server sends none (search.resultCount).
        const total = page.total ?? page.items.length;
        content.push(el("p", "browse-text search-count", `${total.toLocaleString("en-US")} ${total === 1 ? "result" : "results"}`));
    }
    content.push(...view.content.slice(h.searchHead.length).filter(node => {
        if (node.classList.contains("search-empty") && (people.length > 0 || boxSets.length > 0 || waitingForSupplement)) return false;
        if (node.classList.contains("browse-grid")) lockSearchColumns(node, h.gridColumns);
        return !(node.classList.contains("browse-grid") && node.childElementCount === 0);
    }));
    zones.push(...view.zones.slice(1).map(zone => zone.id === "grid" ? { ...zone, spatial: true, columns: h.gridColumns } : zone));
    if ((supplement?.requests?.length ?? 0) > 0) {
        const items = supplement?.requests?.map(title => searchRequestCard(title, h.context.baseUrl, () => {
            const id = searchRequestCatalogId(title);
            h.push(id === undefined ? newRoute({ kind: "requests", requests: requestsState({ kind: "media", title }) }) : newRoute({ kind: "item", id, title: title.title, data: undefined }));
        })) ?? [];
        const heading = el("h2", "browse-section-title search-requests-heading", "Available to request");
        const symbol = el("span", "search-requests-symbol");
        symbol.setAttribute("aria-hidden", "true");
        symbol.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m14 0 2 9 6 3-6 3-2 9-2-9-6-3 6-3 2-9ZM4 1l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3ZM4 16l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Z"/></svg>';
        heading.prepend(symbol);
        const rail = searchRail("requests-rail search-request-rail", items);
        rail.dataset.section = "search-requests";
        content.push(heading,
            el("p", "search-requests-description", "Not in the library yet · tap to request"), rail);
        zones.push({ id: "search-requests", layout: "row", spatial: true, items });
    }
    const grids = content.filter(node => node.classList.contains("browse-grid"));
    const fit = (): void => {
        for (const grid of grids) if (grid.isConnected) for (const line of grid.querySelectorAll<HTMLElement>(".browse-card-title, .browse-card-subtitle")) fitCentredLine(line);
    };
    requestAnimationFrame(() => {
        fit();
        if (document.fonts.status !== "loaded") void document.fonts.ready.then(fit);
    });
    return { ...view, content, zones };
}

/** A box set search result drawn with the title card, opening the box set page. */
function boxSetSearchCard(set: CatalogBoxSet, baseUrl: string, open: () => void): FocusItem {
    const item = actionButton(`box-set:${set.libraryId}:${set.id}`, set.title, open);
    item.element.className = "browse-card box-set-card";
    item.element.replaceChildren();
    item.element.setAttribute("aria-label", boxSetAccessibilityLabel(set));
    const sleeves = el("span", "box-set-sleeves");
    sleeves.setAttribute("aria-hidden", "true");
    sleeves.append(el("span", "box-set-sleeve box-set-sleeve-back"), el("span", "box-set-sleeve box-set-sleeve-front"));
    const art = artwork("browse-art", set.posterUrl, baseUrl, defaultArtwork("film"));
    const progress = boxSetWatchedProgress(set);
    if (progress !== undefined) {
        const bar = el("span", "skyline-progress");
        const fill = el("span", "skyline-progress-fill");
        fill.style.width = `${Math.min(100, progress * 100)}%`;
        bar.appendChild(fill);
        art.appendChild(bar);
    }
    const mark = el("span", "box-set-label", "Box set");
    const count = el("span", "box-set-count", boxSetFilmCount(set.movieCount));
    mark.setAttribute("aria-hidden", "true");
    count.setAttribute("aria-hidden", "true");
    art.append(mark, count);
    item.element.append(sleeves, art, el("span", "browse-card-title", set.title), el("span", "browse-card-subtitle", boxSetCardCaption(set)));
    return item;
}
