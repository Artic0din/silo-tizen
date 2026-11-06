import type { CollectionSummary } from "../contracts/v2/discovery.ts";
import type { View, Zone } from "./browseFocus.ts";
import { newPages, newRoute, type Route, type RouteHandlers } from "./browseRoutes.ts";
import { actionButton, artwork, homeView, homeRows, lines, pagedGrid, zoneNode } from "./browseViews.ts";
import { LIBRARY_MODES, type DiscoveryState, type LibrarySource } from "./libraryDiscovery.ts";
import { el } from "./screen.ts";
import { browsePage, icon, panelFocus, shuffleAlert } from "./libraryBrowseViews.ts";

type LibraryRoute = Extract<Route, { kind: "library" }>;
export function availableModes(caps: DiscoveryState["capabilities"]): readonly import("./libraryDiscovery.ts").LibraryMode[] {
    const available = caps?.allowed === true && caps.state === "available";
    return LIBRARY_MODES.filter(mode => mode === "Recommended" || mode === "Browse" || mode === "Collections" || (available && (mode === "Recently Added" || (mode === "Genres" ? caps.extendedQueryRules === true : caps.letterIndex === true))));
}
export function discoveryView(route: LibraryRoute, state: DiscoveryState, handlers: RouteHandlers): View {
    const pills = availableModes(state.data?.capabilities ?? state.capabilities).map(mode => {
        const item = actionButton(`mode:${mode}`, mode, () => handlers.mode(route, mode));
        item.element.setAttribute("aria-pressed", String(state.mode === mode));
        return item;
    });
    const pillRow = zoneNode("skyline-pills", pills);
    pillRow.appendChild(el("span", "skyline-scope", route.library.name));
    const primary = state.mode === "Recommended" || state.mode === "Collections" || state.genre !== undefined;
    const content: HTMLElement[] = primary ? [] : [pillRow];
    const zones: Zone[] = primary ? [] : [{ id: "pills", layout: "row", items: pills, ...(state.mode === "A–Z" ? { down: "grid" } : {}) }];
    const open = (title: string, source: LibrarySource): void => handlers.push(newRoute({ kind: "libraryResults", library: route.library, title, source, pages: newPages(), descending: false }));
    if (state.mode === "Browse") {
        const page = browsePage(route, state, handlers);
        // TVLibraryGridView (abf4ac45) draws no mode pills. The actions stay in
        // the document for Genres, A–Z and Recently Added, but they are not
        // shown and not a focus stop. Up from Sort is the top bar.
        pillRow.hidden = true;
        return { name: `library:${route.library.id}`, content: [pillRow, ...page.content], zones: page.zones, focus: panelFocus(state) ?? { zone: "controls", key: "sort" }, back: page.back ?? handlers.pop, ready: state.snapshot !== undefined };
    }
    if (route.failure !== undefined) {
        const retry = actionButton("retry", "Try again", () => handlers.retry(route));
        content.push(...lines([route.failure], "error"), zoneNode("browse-actions", [retry]));
        zones.push({ id: "status", layout: "row", items: [retry] });
    } else if (state.data === undefined) {
        const skeleton = el("div", "discovery-skeleton");
        skeleton.setAttribute("role", "status");
        skeleton.setAttribute("aria-label", state.mode === "Collections" ? "Loading collections" : "Loading");
        content.push(skeleton);
    } else if (state.mode === "Recommended") {
        const rows = homeRows(state.data.sections.filter(section => section.featured !== true)).filter(row => row.cards.length > 0);
        rows.forEach(({ section }) => {
            const row = homeView([], [section], handlers.context, {
                expand: value => open(value.title, { kind: "section", id: value.id }),
                search: () => handlers.push(newRoute({ kind: "search", query: "", pages: undefined, resultsFor: "" })),
                library: library => handlers.push(newRoute({ kind: "library", library, pages: newPages() })),
                chooseProfile: handlers.chooseProfile,
            });
            content.push(...row.content);
            zones.push(...row.zones);
        });
    } else if (state.mode === "Collections") {
        const collections = state.data.collections;
        const groups = collections?.groups ?? [];
        const types = new Map((collections?.collections ?? []).map(collection => [collection.id, collection.collectionType]));
        const blocks = groups.map(group => ({ ...group, ungrouped: false }));
        const grouped = new Set(groups.filter(group => group.kind === "admin").flatMap(group => group.collections.map(collection => collection.id)));
        const remaining = collections?.ungrouped?.collections ?? (collections?.collections ?? []).filter(collection => !grouped.has(collection.id));
        const ordered = [...blocks, { id: "ungrouped", name: "", kind: "admin" as const, sortOrder: collections?.ungrouped?.sortOrder ?? 9999, collections: remaining, ungrouped: true }].sort((a, b) => a.sortOrder - b.sortOrder);
        for (const group of ordered) {
            if (group.kind === "admin" || group.kind === "user_collections" || group.kind === "unknown") collectionRow(group.id, group.name, group.collections, group.kind === "user_collections" ? "user_collections" : "admin", true, types);
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
            zones.push({ id: "letters", layout: "column", left: "grid", up: "nav", items: letters });
        }
        if (route.pages.page !== undefined) {
            if (route.pages.page.items.length === 0) content.push(...lines(["No titles"]));
            const grid = pagedGrid({ page: route.pages.page, index: route.pages.index, pageSize: 24, loading: handlers.busy, previous: () => handlers.turn(route, route.pages, -1), next: () => handlers.turn(route, route.pages, 1) }, handlers.context);
            content.push(...grid.content);
            zones.push(...grid.zones.map(zone => state.mode === "A–Z" && zone.id === "grid" ? { ...zone, up: "nav", right: "letters" } : zone));
        } else if (handlers.busy) {
            const loading = el("div", "discovery-skeleton");
            loading.setAttribute("aria-label", "Loading");
            loading.setAttribute("role", "status");
            content.push(loading);
        }
    }
    if (state.data !== undefined && route.failure === undefined && zones.every(zone => zone.items.length === 0 || (zone.id === "pills" && state.mode === "Genres" && state.genre === undefined))) content.push(...lines(state.mode === "Collections" ? ["No collections yet", "Collections created on the server will appear here."] : ["No titles"]));
    const firstZone = zones.find(zone => (zone.id === "grid" || zone.id.startsWith("section:")) && zone.items.length > 0) ?? zones.find(zone => zone.id !== "pills" && zone.items.length > 0) ?? zones.find(zone => zone.items.length > 0);
    const first = firstZone?.items[0];
    return { name: state.data === undefined && route.failure === undefined ? "library:loading" : `library:${route.library.id}`, content, zones, focus: first === undefined ? { zone: "nav", key: route.library.type === "series" ? "series" : "movies" } : { zone: firstZone?.id ?? "nav", key: first.key }, back: handlers.pop };

    function collectionRow(id: string, title: string, collections: readonly CollectionSummary[], groupKind: "admin" | "user_collections", grid: boolean, types: ReadonlyMap<string, string | undefined>): void {
        if (collections.length === 0) return;
        const items = collections.map(collection => {
            const item = actionButton(`collection:${collection.id}`, "", () => open(collection.title, { kind: "collection", id: collection.id, groupKind }));
            item.element.classList.add("browse-card", "discovery-collection", ...(grid ? ["collection-poster"] : []));
            item.element.setAttribute("data-collage", String(collection.posterIsCollage));
            const fallback = el("span", "collection-stack");
            fallback.innerHTML = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M10 42 32 54 54 42M10 32 32 44 54 32M10 22 32 10 54 22 32 34Z" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/></svg>';
            const art = artwork(grid ? "browse-art" : "discovery-collection-art", collection.posterUrl, handlers.context.baseUrl, fallback);
            let hash = 2166136261;
            for (const byte of new TextEncoder().encode(collection.id)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
            art.style.background = `linear-gradient(to bottom right, hsl(${hash % 360} 33.3333% 31.5%), hsl(${hash % 360} 19.0476% 18.48%))`;
            item.element.setAttribute("aria-label", `${collection.title}, collection${collection.itemCount > 0 ? `, ${collection.itemCount} ${collection.itemCount === 1 ? "item" : "items"}` : ""}`);
            item.element.append(art, el("span", grid ? "browse-card-title" : "discovery-collection-name", collection.title));
            if (!grid) item.element.append(el("span", "discovery-collection-count", `${collection.itemCount} titles`));
            else if (collection.itemCount > 0) item.element.append(el("span", "browse-card-subtitle", countLine(collection.itemCount, types.get(collection.id))));
            item.element.addEventListener("focus", () => handlers.context.preview?.({ id: collection.id, type: "movie", title: collection.title, overview: `${collection.itemCount} titles`, backdropUrl: collection.posterUrl, posterUrl: collection.posterUrl, year: undefined, seriesId: undefined, seriesTitle: undefined, seasonNumber: undefined, episodeNumber: undefined }, "Collections"));
            return item;
        });
        if (!grid) items.push(actionButton("collections:all", "See All", () => handlers.mode(route, "Collections")));
        const block = el("section", "browse-section");
        block.setAttribute("data-section", `collections:${id}`);
        const columns = (handlers.context.posterScale?.() ?? 1) < 1 ? 7 : handlers.gridColumns;
        const cards = zoneNode(grid ? "catalog-grid discovery-collection-grid" : "browse-row", items);
        if (grid) cards.style.setProperty("--collection-columns", String(columns));
        if (title !== "") block.append(el("h2", grid ? "collection-group-title" : "browse-section-title", title));
        block.append(cards);
        content.push(block);
        zones.push({ id: `collections:${id}`, layout: grid ? "grid" : "row", columns: grid ? columns : 3, items });
    }
}

/** Management types such as manual/smart deliberately use Apple's neutral ITEM/ITEMS fallback. */
function countLine(count: number, type: string | undefined): string {
    const plural = count !== 1;
    switch (type?.toLowerCase()) {
        case "movie":
        case "movies":
            return `${count} ${plural ? "MOVIES" : "MOVIE"}`;
        case "series":
        case "show":
        case "shows":
        case "tvshows":
            return `${count} ${plural ? "SHOWS" : "SHOW"}`;
        case "album":
        case "albums":
            return `${count} ${plural ? "ALBUMS" : "ALBUM"}`;
        case "audiobook":
        case "audiobooks":
        case "book":
        case "books":
            return `${count} ${plural ? "BOOKS" : "BOOK"}`;
        default:
            return `${count} ${plural ? "ITEMS" : "ITEM"}`;
    }
}

export function resultsView(route: Extract<Route, { kind: "libraryResults" }>, grid: { content: HTMLElement[]; zones: Zone[] }, handlers: RouteHandlers): View {
    if (route.source.kind === "collection" && route.failure === undefined && (route.pages.page?.items.length ?? 0) > 0) {
        const shuffle = handlers.shuffle;
        const button = shuffle === undefined ? undefined : actionButton("shuffle", "Shuffle", () => shuffle.start(route));
        if (button !== undefined) {
            button.element.classList.add("browse-shuffle");
            button.element.prepend(icon("shuffle"));
            button.element.setAttribute("aria-busy", String(shuffle?.starting === true));
        }
        const page = route.pages.page;
        const count = page?.totalExact && page.total !== undefined && page.nextCursor === undefined ? page.total : route.pages.index * 60 + (page?.items.length ?? 0);
        const more = page?.nextCursor !== undefined;
        const controls = button === undefined ? [] : [button];
        const actions = zoneNode("browse-actions collection-detail-actions", controls);
        actions.append(el("span", "browse-text", `${count}${more ? "+" : ""} ${count === 1 && !more ? "item" : "items"}`));
        for (const node of grid.content) if (node.classList.contains("browse-grid")) {
            node.classList.add("collection-detail-grid");
            node.style.setProperty("--collection-detail-columns", String(handlers.gridColumns));
        }
        grid.zones = grid.zones.map(zone => zone.id === "grid" ? { ...zone, columns: handlers.gridColumns } : zone);
        const content = [el("h1", "browse-title collection-detail-title", route.title), actions, ...grid.content];
        const zones: Zone[] = [{ id: "controls", layout: "row", items: controls }, ...grid.zones];
        const alert = shuffleAlert(content, zones, handlers);
        if (alert !== undefined) return { name: `results:${route.library.id}:${route.title}`, ...alert, focus: { zone: "panel", key: "alert-ok" }, back: alert.back ?? handlers.pop };
        return { name: `results:${route.library.id}:${route.title}`, content: [el("h1", "browse-title collection-detail-title", route.title), actions, ...(shuffle?.failure === undefined ? [] : lines([shuffle.failure], "error")), ...grid.content],
            zones: [{ id: "controls", layout: "row", items: controls }, ...grid.zones],
            focus: button === undefined ? { zone: "grid", key: grid.zones[0]?.items[0]?.key ?? "" } : { zone: "controls", key: "shuffle" }, back: handlers.pop };
    }
    const back = actionButton("back", "Back", handlers.pop);
    const controls = [back];
    if (route.source.kind === "genre") controls.push(actionButton("sort", route.descending ? "Title Z–A" : "Title A–Z", () => handlers.sort(route)));
    if (route.failure !== undefined) controls.push(actionButton("retry", "Try again", () => handlers.retry(route)));
    const first = grid.zones.find(zone => zone.items.length > 0);
    return { name: `results:${route.library.id}:${route.title}`, content: [el("h1", "browse-title", route.title), zoneNode("browse-actions", controls), ...(route.failure === undefined ? [] : lines([route.failure], "error")), ...(grid.zones[0]?.items.length === 0 ? lines(route.source.kind === "collection" ? ["Collection is empty", "This collection does not have any items yet."] : ["No titles"]) : []), ...grid.content], zones: [{ id: "actions", layout: "row", items: controls }, ...grid.zones], focus: first?.items[0] === undefined ? { zone: "actions", key: "back" } : { zone: first.id, key: first.items[0].key }, back: handlers.pop };
}
