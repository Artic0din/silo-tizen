import type { HomeSection } from "../contracts/v2/catalog.ts";
import type { CollectionSummary } from "../contracts/v2/discovery.ts";
import type { View, Zone } from "./browseFocus.ts";
import { newPages, newRoute, type Route, type RouteHandlers } from "./browseRoutes.ts";
import { actionButton, artwork, cardItem, lines, pagedGrid, zoneNode } from "./browseViews.ts";
import { LIBRARY_MODES, type DiscoveryState, type LibrarySource } from "./libraryDiscovery.ts";
import { el } from "./screen.ts";

type LibraryRoute = Extract<Route, { kind: "library" }>;
export function availableModes(caps: DiscoveryState["capabilities"]): readonly import("./libraryDiscovery.ts").LibraryMode[] {
    const available = caps?.allowed === true && caps.state === "available";
    return LIBRARY_MODES.filter(mode => mode === "Browse" || mode === "Collections" || (available && (mode === "Recently Added" || (mode === "Genres" ? caps.extendedQueryRules === true : caps.letterIndex === true))));
}
export function discoveryView(route: LibraryRoute, state: DiscoveryState, handlers: RouteHandlers): View {
    const caps = state.data?.capabilities ?? state.capabilities;
    const modes = availableModes(caps);
    const pills = modes.map(mode => {
        const item = actionButton(`mode:${mode}`, mode, () => state.mode === "Browse" && mode === "Browse" && state.data !== undefined ? handlers.focusDefault() : handlers.mode(route, mode));
        item.element.setAttribute("aria-pressed", String(state.mode === mode));
        return item;
    });
    const pillRow = zoneNode("skyline-pills", pills);
    pillRow.appendChild(el("span", "skyline-scope", route.library.name));
    const content: HTMLElement[] = [pillRow];
    const zones: Zone[] = [{ id: "pills", layout: "row", items: pills, ...(state.mode === "A–Z" ? { down: "grid" } : {}) }];
    const open = (title: string, source: LibrarySource): void => handlers.push(newRoute({ kind: "libraryResults", library: route.library, title, source, pages: newPages(), descending: false }));
    if (route.failure !== undefined) {
        const retry = actionButton("retry", "Try again", () => handlers.retry(route));
        content.push(...lines([route.failure], "error"), zoneNode("browse-actions", [retry]));
        zones.push({ id: "status", layout: "row", items: [retry] });
    } else if (state.data === undefined) {
        const skeleton = el("div", "discovery-skeleton");
        skeleton.setAttribute("role", "status");
        skeleton.setAttribute("aria-label", "Loading");
        content.push(skeleton);
    } else if (state.mode === "Browse") {
        state.data.sections.forEach((section, index) => {
            sectionRow(section);
            if (index === 0) inlineCollections();
        });
        if (state.data.sections.length === 0) inlineCollections();
    } else if (state.mode === "Collections") {
        const collections = state.data.collections;
        const groups = collections?.groups ?? [];
        const blocks = groups.map(group => ({ ...group, ungrouped: false }));
        const grouped = new Set(groups.filter(group => group.kind === "admin").flatMap(group => group.collections.map(collection => collection.id)));
        const remaining = collections?.ungrouped?.collections ?? (collections?.collections ?? []).filter(collection => !grouped.has(collection.id));
        const ordered = [...blocks, { id: "ungrouped", name: "Collections", kind: "admin", sortOrder: collections?.ungrouped?.sortOrder ?? 9999, collections: remaining, ungrouped: true }].sort((a, b) => a.sortOrder - b.sortOrder);
        for (const group of ordered) {
            if (group.kind === "admin" || group.kind === "user_collections") collectionRow(group.id, group.name, group.collections, group.kind, true);
        }
    } else if (state.mode === "Genres" && state.genre === undefined) {
        const items = (state.data.filters?.genres ?? []).map(name => actionButton(`genre:${name}`, name, () => handlers.genre(route, name)));
        content.push(zoneNode("discovery-facets", items));
        zones.push({ id: "genres", layout: "grid", columns: 6, items });
    } else {
        if (state.genre !== undefined) {
            const sort = actionButton("sort", state.descending ? "Title Z–A" : "Title A–Z", () => handlers.sort(route));
            content.push(el("h2", "browse-section-title", state.genre), zoneNode("browse-actions", [sort]));
            zones.push({ id: "actions", layout: "row", items: [sort] });
        }
        if (state.mode === "A–Z") {
            const letters = (state.data.letters?.letters ?? []).map(letter => {
                const item = actionButton(`letter:${letter.letter}`, letter.letter, () => handlers.jump(route, letter.letter, letter.position));
                item.element.setAttribute("aria-label", `${letter.letter}, ${letter.count} titles`);
                item.element.setAttribute("aria-pressed", String(state.letter === letter.letter));
                return item;
            });
            content.push(zoneNode("discovery-letters", letters));
            zones.push({ id: "letters", layout: "column", left: "grid", items: letters });
        }
        if (route.pages.page !== undefined) {
            if (route.pages.page.items.length === 0) content.push(...lines(["No titles"]));
            const grid = pagedGrid({ page: route.pages.page, index: route.pages.index, pageSize: 24, loading: handlers.busy, previous: () => handlers.turn(route, route.pages, -1), next: () => handlers.turn(route, route.pages, 1) }, handlers.context);
            content.push(...grid.content);
            zones.push(...grid.zones.map(zone => state.mode === "A–Z" && zone.id === "grid" ? { ...zone, up: "pills", right: "letters" } : zone));
        } else if (handlers.busy) {
            const loading = el("div", "discovery-skeleton");
            loading.setAttribute("aria-label", "Loading");
            loading.setAttribute("role", "status");
            content.push(loading);
        }
    }
    if (state.data !== undefined && route.failure === undefined && zones.slice(1).every(zone => zone.items.length === 0)) content.push(...lines(["No titles"]));
    const firstZone = zones.find(zone => (zone.id === "grid" || zone.id.startsWith("section:")) && zone.items.length > 0) ?? zones.slice(1).find(zone => zone.items.length > 0) ?? zones[0];
    const first = firstZone?.items[0];
    return { name: state.data === undefined && route.failure === undefined ? "library:loading" : `library:${route.library.id}`, content, zones, focus: first === undefined ? undefined : { zone: firstZone?.id ?? "pills", key: first.key }, back: handlers.pop };

    function sectionRow(section: HomeSection): void {
        const more = actionButton(`section:${section.id}`, section.title, () => open(section.title, { kind: "section", id: section.id }));
        const cards = section.items.slice(0, 24).flatMap(card => {
            const item = cardItem(card, { ...handlers.context, preview: value => handlers.context.preview?.(value, section.title) });
            return item === undefined ? [] : [item];
        });
        const block = el("section", "browse-section");
        block.setAttribute("data-section", section.id);
        block.append(zoneNode("browse-actions", [more]), zoneNode("browse-row", cards));
        content.push(block);
        zones.push({ id: `section-link:${section.id}`, layout: "row", items: [more] }, { id: `section:${section.id}`, layout: "row", items: cards });
    }
    function inlineCollections(): void {
        const collections = [...(state.data?.collections?.collections ?? [])].sort((a, b) => b.itemCount - a.itemCount).slice(0, 8);
        collectionRow("inline", "Collections", collections, "admin", false);
    }
    function collectionRow(id: string, title: string, collections: readonly CollectionSummary[], groupKind: "admin" | "user_collections", grid: boolean): void {
        if (collections.length === 0) return;
        const items = collections.map(collection => {
            const item = actionButton(`collection:${collection.id}`, "", () => open(collection.title, { kind: "collection", id: collection.id, groupKind }));
            item.element.classList.add("browse-card", "discovery-collection");
            item.element.setAttribute("data-collage", String(collection.posterIsCollage));
            item.element.append(artwork("discovery-collection-art", collection.posterUrl, handlers.context.baseUrl, ""), el("span", "discovery-collection-name", collection.title), el("span", "discovery-collection-count", `${collection.itemCount} titles`));
            item.element.addEventListener("focus", () => handlers.context.preview?.({ id: collection.id, type: "movie", title: collection.title, overview: `${collection.itemCount} titles`, backdropUrl: collection.posterUrl, posterUrl: collection.posterUrl, year: undefined, seriesId: undefined, seriesTitle: undefined, seasonNumber: undefined, episodeNumber: undefined }, "Collections"));
            return item;
        });
        if (!grid) items.push(actionButton("collections:all", "See All", () => handlers.mode(route, "Collections")));
        const block = el("section", "browse-section");
        block.setAttribute("data-section", `collections:${id}`);
        block.append(el("h2", "browse-section-title", title), zoneNode(grid ? "discovery-collection-grid" : "browse-row", items));
        content.push(block);
        zones.push({ id: `collections:${id}`, layout: grid ? "grid" : "row", columns: 3, items });
    }
}

export function resultsView(route: Extract<Route, { kind: "libraryResults" }>, grid: { content: HTMLElement[]; zones: Zone[] }, handlers: RouteHandlers): View {
    const back = actionButton("back", "Back", handlers.pop);
    const controls = [back];
    if (route.source.kind === "genre") controls.push(actionButton("sort", route.descending ? "Title Z–A" : "Title A–Z", () => handlers.sort(route)));
    if (route.failure !== undefined) controls.push(actionButton("retry", "Try again", () => handlers.retry(route)));
    const first = grid.zones.find(zone => zone.items.length > 0);
    return { name: `results:${route.library.id}:${route.title}`, content: [el("h1", "browse-title", route.title), zoneNode("browse-actions", controls), ...(route.failure === undefined ? [] : lines([route.failure], "error")), ...(grid.zones[0]?.items.length === 0 ? lines(["No titles"]) : []), ...grid.content], zones: [{ id: "actions", layout: "row", items: controls }, ...grid.zones], focus: first?.items[0] === undefined ? { zone: "actions", key: "back" } : { zone: first.id, key: first.items[0].key }, back: handlers.pop };
}
