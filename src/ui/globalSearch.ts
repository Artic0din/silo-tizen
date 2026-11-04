import type { Person } from "../contracts/v2/details.ts";
import type { RequestTitle } from "../contracts/v2/requests.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { actionButton, artwork, searchLoading, zoneNode } from "./browseViews.ts";
import { newRoute, type Route, type RouteHandlers } from "./browseRoutes.ts";
import { requestCard, requestsState } from "./requests.ts";
import { requestProgress } from "./requestProgress.ts";
import { el } from "./screen.ts";
import { searchRail } from "./searchRail.ts";
import { balanceTwoLineText } from "./textLayout.ts";

export interface SearchSupplement {
    people?: readonly Person[];
    peoplePending?: boolean;
    peopleFailure?: boolean;
    requests?: readonly RequestTitle[] | undefined;
    requestsFor?: string | undefined;
}

export function searchRequestCatalogId(title: RequestTitle): string | undefined {
    return requestProgress(title)?.display === "inLibrary" && title.libraryContentId?.trim() ? title.libraryContentId : undefined;
}

/** Presentation boundary for the shared Requests card owner. No catalog identity is fabricated. */
export function searchRequestCard(title: RequestTitle, baseUrl: string, open: () => void): FocusItem {
    return requestCard(title, baseUrl, open);
}

export function globalSearchView(view: View, route: Extract<Route, { kind: "search" }>, h: RouteHandlers): View {
    const filters = ([[undefined, "All"], ["movie", "Movies"], ["series", "Series"]] as const).map(([value, label]) => {
        const item = actionButton(`search-filter:${value ?? "all"}`, label, () => h.searchFilter(route, value));
        item.element.setAttribute("aria-pressed", String(route.filter === value));
        return item;
    });
    const content = [...h.searchHead], zones: Zone[] = view.zones.slice(0, 1);
    if (route.query.trim() !== "") {
        content.push(zoneNode("browse-actions search-filters", filters));
        zones.push({ id: "search-filters", layout: "row", items: filters });
    }
    const current = route.query === route.resultsFor;
    const supplement = route.supplement;
    const people = supplement?.people ?? [];
    const waitingForPeople = route.failure === undefined && supplement?.peoplePending === true && people.length === 0 && (route.pages?.page?.items.length ?? 0) === 0;
    if (waitingForPeople && !view.content.some(node => node.classList.contains("search-progress"))) content.push(searchLoading());
    if (route.failure === undefined && people.length > 0) {
        const items = people.map(person => {
            const item = actionButton(`person:${person.id}`, person.name, () => h.push(newRoute({ kind: "person", id: person.id, title: person.name, data: undefined })));
            item.element.className = "browse-card details-person";
            item.element.replaceChildren(artwork("browse-art details-photo", person.photoUrl, h.context.baseUrl, ""), el("span", "browse-card-title", person.name));
            return item;
        });
        const rail = searchRail("details-people search-people-rail", items);
        requestAnimationFrame(() => {
            if (!rail.isConnected) return;
            for (const caption of rail.querySelectorAll<HTMLElement>(".browse-card-title")) balanceTwoLineText(caption);
        });
        content.push(el("h2", "browse-section-title search-people-heading", "People"), rail);
        zones.push({ id: "search-people", layout: "row", items });
    }
    if (route.failure === undefined && current && (route.pages?.page?.items.length ?? 0) > 0 && route.pages?.page !== undefined) {
        const total = route.pages.page.total;
        content.push(el("p", "browse-text search-count", `${total}${route.pages.page.totalExact ? "" : "+"} ${total === 1 ? "result" : "results"}`));
    }
    const hasPager = view.zones.some(zone => zone.id === "pager" && zone.items.length > 0);
    content.push(...view.content.slice(h.searchHead.length).filter(node => {
        if (node.classList.contains("search-empty") && (people.length > 0 || waitingForPeople)) return false;
        if (node.classList.contains("browse-grid")) node.style.setProperty("--search-columns", String(h.gridColumns));
        if (node.classList.contains("browse-page-status") && !hasPager) return false;
        return !((node.classList.contains("browse-grid") || node.classList.contains("browse-actions")) && node.childElementCount === 0);
    }));
    zones.push(...view.zones.slice(1).map(zone => zone.id === "grid" ? { ...zone, columns: h.gridColumns } : zone));
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
        content.push(heading,
            el("p", "search-requests-description", "Not in the library yet · tap to request"), searchRail("requests-rail search-request-rail", items));
        zones.push({ id: "search-requests", layout: "row", items });
    }
    return { ...view, content, zones };
}
