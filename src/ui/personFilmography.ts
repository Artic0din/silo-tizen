import type { CatalogQueryRequest, MediaScope } from "../contracts/v2/discovery.ts";
import type { View, Zone } from "./browseFocus.ts";
import { type Route, type RouteHandlers } from "./browseRoutes.ts";
import { actionButton, errorView, FAILURE_ICON, failureError, recoveryActions, searchState, zoneNode } from "./browseViews.ts";
import { feedGrid } from "./catalogFeed.ts";
import { personHero } from "./browseDetails.ts";
import { el } from "./screen.ts";

const PERSON_PAGE_SIZE = 60;
const LOAD_MORE_ROWS = 8;
const MIN_FILMOGRAPHY_HEIGHT_PX = 420;
/** SF Symbol film.stack: a film frame with sprocket strips and a centre divider, two cards stacked behind it. */
const FILM_STACK_ICON = '<svg viewBox="0 0 48 44"><g fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"><path d="M12 1.5h24M7 7.5h34"/><rect x="1.5" y="13.5" width="45" height="29" rx="4"/><path d="M11 28h26"/></g><path fill="currentColor" fill-rule="evenodd" d="M1.5 17.5a4 4 0 0 1 4-4H11v29H5.5a4 4 0 0 1-4-4ZM37 13.5h5.5a4 4 0 0 1 4 4v21a4 4 0 0 1-4 4H37ZM5 16.5h3.5V20H5ZM5 23h3.5v3.5H5ZM5 29.5h3.5V33H5ZM5 36h3.5v3.5H5ZM39.5 16.5H43V20h-3.5ZM39.5 23H43v3.5h-3.5ZM39.5 29.5H43V33h-3.5ZM39.5 36H43v3.5h-3.5Z"/></svg>';

export function personQuery(id: string, filter: MediaScope, cursor?: string): CatalogQueryRequest {
    return { source: "person", person_id: id, type: filter, sort: "year", order: "desc", limit: PERSON_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) };
}

export function personFilmographyView(route: Extract<Route, { kind: "person" }>, handlers: RouteHandlers): View {
    // Apple rootContent (PersonDetailView.swift:358-359): with no person, the failed read is the whole page's ErrorView.
    if (route.data === undefined && route.metadataFailure !== undefined) {
        return errorView(`person:${route.id}`, failureError(route.metadataFailure, route.metadataError), () => handlers.retry(route), handlers.pop, handlers.signIn);
    }
    const empty = (route.pages.page?.items.length ?? 0) === 0;
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
    const content = [personHero(person, handlers.context.baseUrl, route.metadataLoading === true || route.metadataRefresh?.refreshing === true || route.data === undefined), title, zoneNode("skyline-pills person-filmography-filters", filters)];
    const zones: Zone[] = [{ id: "filters", layout: "row", spatial: "aligned", items: filters }];
    if (route.failure !== undefined && empty) {
        // Apple ErrorView(state:onRetry:) in the Filmography area, at least 420pt tall (PersonDetailView.swift:414-416).
        const error = failureError(route.failure, route.error);
        const state = searchState(error.headline, error.message, "details-failure person-filmography-failure", FAILURE_ICON);
        state.setAttribute("role", "alert");
        state.style.minHeight = `${MIN_FILMOGRAPHY_HEIGHT_PX}px`;
        const actions = recoveryActions(error, actionButton("retry", "Try Again", () => handlers.retry(route)), actionButton("go-back", "Go Back", handlers.pop),
            handlers.signIn === undefined ? undefined : actionButton("sign-in", "Sign In Again", handlers.signIn));
        state.appendChild(zoneNode("browse-actions", actions));
        content.push(state);
        zones.push({ id: "status", layout: "column", items: actions });
    }
    if (page !== undefined) {
        const columns = handlers.gridColumns;
        if (page.items.length === 0 && route.failure === undefined) {
            // Apple EmptyStateView(icon: "film.stack"), at least 420pt tall (PersonDetailView.swift:417-423).
            const state = searchState("No titles found", "There are no movies or series linked to this person yet.", "person-filmography-empty", FILM_STACK_ICON);
            state.style.minHeight = `${MIN_FILMOGRAPHY_HEIGHT_PX}px`;
            content.push(state);
        }
        const grid = feedGrid(route.pages, page, handlers.context, LOAD_MORE_ROWS * columns, handlers.busy, () => handlers.morePerson(route), columns);
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
