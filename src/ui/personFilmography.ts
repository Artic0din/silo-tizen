import type { CatalogQueryRequest, MediaScope } from "../contracts/v2/discovery.ts";
import type { View, Zone } from "./browseFocus.ts";
import { type Route, type RouteHandlers } from "./browseRoutes.ts";
import { actionButton, lines, zoneNode } from "./browseViews.ts";
import { feedGrid } from "./catalogFeed.ts";
import { personHero } from "./browseDetails.ts";
import { el } from "./screen.ts";

const PERSON_PAGE_SIZE = 60;
const LOAD_MORE_ROWS = 8;
const MIN_FILMOGRAPHY_HEIGHT_PX = 420;

export function personQuery(id: string, filter: MediaScope, cursor?: string): CatalogQueryRequest {
    return { source: "person", person_id: id, type: filter, sort: "year", order: "desc", limit: PERSON_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) };
}

export function personFilmographyView(route: Extract<Route, { kind: "person" }>, handlers: RouteHandlers): View {
    const actions = [];
    const empty = (route.pages.page?.items.length ?? 0) === 0;
    if ((route.failure !== undefined && empty) || route.metadataFailure !== undefined) actions.push(actionButton("retry", "Try again", () => handlers.retry(route)));
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
    const controls = zoneNode("browse-actions", actions);
    const content = [personHero(person, handlers.context.baseUrl, route.metadataLoading === true || route.metadataRefresh?.refreshing === true || (route.data === undefined && route.metadataFailure === undefined)), title, zoneNode("skyline-pills person-filmography-filters", filters), ...(actions.length === 0 ? [] : [controls])];
    const zones: Zone[] = [{ id: "filters", layout: "row", spatial: "aligned", items: filters }, { id: "actions", layout: "row", items: actions }];
    if (route.metadataFailure !== undefined) content.push(...lines([route.metadataFailure], "error"));
    if (route.failure !== undefined && empty) {
        controls.style.minHeight = `${MIN_FILMOGRAPHY_HEIGHT_PX}px`;
        controls.append(...lines([route.failure], "error"));
    }
    if (page !== undefined) {
        const columns = handlers.gridColumns;
        if (page.items.length === 0 && route.failure === undefined) {
            const state = el("div", "person-filmography-state");
            state.style.minHeight = `${MIN_FILMOGRAPHY_HEIGHT_PX}px`;
            state.append(...lines(["No titles found", "There are no movies or series linked to this person yet."]));
            content.push(state);
        }
        const grid = feedGrid(route.pages, page, handlers.context, LOAD_MORE_ROWS * columns, handlers.busy, () => handlers.morePerson(route), columns, 260, 1600);
        const scale = handlers.context.posterScale?.() ?? 1;
        const node = grid.content[0];
        node?.classList.add("catalog-grid");
        node?.style.setProperty("--grid-columns", String(columns));
        node?.style.setProperty("--poster-scale", String(scale));
        node?.style.setProperty("--grid-lift", String((390 * scale + 38) / (390 * scale)));
        content.push(...grid.content);
        zones.push(...grid.zones.map(zone => zone.id === "grid" ? { ...zone, columns, spatial: true as const } : zone));
    } else if (handlers.busy || route.failure === undefined) {
        const loading = el("div", "person-filmography-state");
        loading.style.minHeight = `${MIN_FILMOGRAPHY_HEIGHT_PX}px`;
        loading.setAttribute("role", "status");
        loading.setAttribute("aria-label", "Loading titles");
        content.push(loading);
    }
    const first = zones.find(zone => zone.id === "grid")?.items[0];
    return { name: `person:${route.id}`, content, zones,
        focus: first === undefined ? { zone: "filters", key: `filter:${route.filter}` } : { zone: "grid", key: first.key }, back: handlers.pop };
}
