import type { CatalogQueryRequest, MediaScope } from "../contracts/v2/discovery.ts";
import type { View, Zone } from "./browseFocus.ts";
import { PAGE_SIZE, type Route, type RouteHandlers } from "./browseRoutes.ts";
import { actionButton, lines, pagedGrid, zoneNode } from "./browseViews.ts";
import { personHero } from "./browseDetails.ts";
import { el } from "./screen.ts";

export function personQuery(id: string, filter: MediaScope, cursor?: string): CatalogQueryRequest {
    return { source: "person", person_id: id, type: filter, sort: "year", order: "desc", limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) };
}

export function personFilmographyView(route: Extract<Route, { kind: "person" }>, handlers: RouteHandlers): View {
    const actions = [];
    if (route.failure !== undefined || route.metadataFailure !== undefined) actions.push(actionButton("retry", "Try again", () => handlers.retry(route)));
    if (route.data === undefined && route.metadataFailure !== undefined) actions.push(actionButton("back", "Back", handlers.pop));
    const filters = (route.availableFilters ?? ["video", "movie", "series"] as const).map(filter => {
        const item = actionButton(`filter:${filter}`, filter === "video" ? "All" : filter === "movie" ? "Movies" : "Series", () => handlers.personFilter(route, filter));
        item.element.setAttribute("aria-pressed", String(route.filter === filter));
        return item;
    });
    const title = el("div", "person-filmography-heading");
    title.appendChild(el("h2", "browse-section-title", "Filmography"));
    const page = route.pages.page;
    if (page !== undefined) title.appendChild(el("span", "person-title-count", `${page.totalExact ? "" : "About "}${page.total} ${page.total === 1 ? "title" : "titles"}`));
    const person = route.data?.person ?? { id: route.id, name: route.title, bio: undefined, photoUrl: undefined, photoThumbhash: undefined, birthDate: undefined, deathDate: undefined, birthplace: undefined };
    const content = [personHero(person, handlers.context.baseUrl, route.metadataLoading === true || (route.data === undefined && route.metadataFailure === undefined)), title, zoneNode("skyline-pills person-filmography-filters", filters), ...(actions.length === 0 ? [] : [zoneNode("browse-actions", actions)])];
    const zones: Zone[] = [{ id: "filters", layout: "row", spatial: "aligned", items: filters }, { id: "actions", layout: "row", items: actions }];
    if (route.metadataFailure !== undefined) content.push(...lines([route.metadataFailure], "error"));
    if (route.failure !== undefined) content.push(...lines([route.failure], "error"));
    if (page !== undefined) {
        if (page.items.length === 0) content.push(...lines(["No available titles for this filter."]));
        const grid = pagedGrid({ page, index: route.pages.index, pageSize: PAGE_SIZE, loading: handlers.busy, previous: () => handlers.turn(route, route.pages, -1), next: () => handlers.turn(route, route.pages, 1) }, { ...handlers.context, posterWidth: 260 });
        if (route.pages.index === 0 && page.nextCursor === undefined) grid.content = grid.content.filter(node => !node.classList.contains("browse-page-status"));
        const columns = handlers.gridColumns;
        const scale = handlers.context.posterScale?.() ?? 1;
        const node = grid.content[0];
        node?.classList.add("catalog-grid");
        node?.style.setProperty("--grid-columns", String(columns));
        node?.style.setProperty("--poster-scale", String(scale));
        node?.style.setProperty("--grid-lift", String((390 * scale + 38) / (390 * scale)));
        content.push(...grid.content);
        zones.push(...grid.zones.map(zone => zone.id === "grid" ? { ...zone, columns, spatial: true as const } : zone));
    } else if (handlers.busy || route.failure === undefined) {
        const loading = el("p", "browse-text", route.slow ? "Still waiting for the server." : "Loading");
        loading.setAttribute("role", "status");
        content.push(loading);
    }
    const first = zones.find(zone => zone.id === "grid")?.items[0];
    return { name: `person:${route.id}`, content, zones,
        focus: first === undefined ? { zone: "filters", key: `filter:${route.filter}` } : { zone: "grid", key: first.key }, back: handlers.pop };
}
