import type { Card } from "../contracts/v2/catalog.ts";
import type { Route } from "./browseRoutes.ts";
import type { FocusItem, View } from "./browseFocus.ts";
import { actionButton, cardItem, type ViewContext } from "./browseViews.ts";
import { el } from "./screen.ts";
import { sectionCountLabel, type SectionSnapshot } from "./sectionCatalogState.ts";

const MIN_GRID_WIDTH = 1664;
const POSTER_WIDTH = 260;
const COLUMN_GAP = 40;

export type SectionRoute = Extract<Route, { kind: "homeSection" }> | (Extract<Route, { kind: "libraryResults" }> & { source: { readonly kind: "section"; readonly id: string } });

export function isSectionRoute(route: Route): route is SectionRoute {
    return route.kind === "homeSection" || (route.kind === "libraryResults" && route.source.kind === "section");
}

/** One retained grid per expanded row; the route's existing load owner publishes its snapshot. */
export class SectionCatalog {
    snapshot: SectionSnapshot | undefined;
    private grid = el("div", "browse-grid section-catalog-grid");
    private cards: readonly Card[] = [];
    private items: FocusItem[] = [];
    private observer: IntersectionObserver | undefined;
    private dirty = false;
    private overlays: ReturnType<NonNullable<ViewContext["cardOverlays"]>>;
    private scale = 0;
    private hidesImages = false;

    stop(): void { this.observer?.disconnect(); this.observer = undefined; }
    invalidate(): void { this.dirty = true; }

    view(route: SectionRoute, context: ViewContext, busy: boolean, back: () => void, retry: () => void, more: () => void): View {
        this.stop();
        const title = el("h1", "section-catalog-title", route.title);
        const page = route.pages.page;
        const scale = context.posterScale?.() ?? 1;
        const columns = scale > 1 ? 5 : 6;
        const width = Math.max(MIN_GRID_WIDTH, columns * POSTER_WIDTH * scale + (columns - 1) * COLUMN_GAP);
        const overlays = context.cardOverlays?.();
        const hidesImages = context.spoilers?.().hidesImages ?? false;
        const name = route.kind === "homeSection" ? `homeSection:${route.id}` : `libraryResults:${route.library.id}:${route.source.id}`;
        const content: HTMLElement[] = [title];
        if (page === undefined || page.items.length === 0) {
            const unavailable = this.snapshot?.unavailable === true;
            const message = unavailable ? "Row unavailable" : route.failure !== undefined ? "Something went wrong" : busy ? "Loading" : "Nothing here yet";
            const owner = el("div", "section-catalog-state", message);
            owner.tabIndex = 0;
            owner.setAttribute("role", route.failure === undefined ? "status" : "alert");
            owner.setAttribute("aria-label", busy ? `Loading ${route.title}` : message);
            owner.setAttribute("data-focus", "state");
            content.push(owner);
            if (route.failure !== undefined) content.push(el("p", "browse-text", route.failure));
            else if (unavailable) content.push(el("p", "browse-text", "This row is no longer available."));
            else if (!busy) content.push(el("p", "browse-text", "This row does not have any items right now."));
            const controls = route.failure === undefined ? [{ key: "state", element: owner }] : [actionButton("retry", "Try again", retry)];
            if (route.failure !== undefined) content.push(...controls.map(item => item.element));
            return { name, content, zones: [{ id: "state", layout: "column", items: controls }], focus: { zone: "state", key: controls[0]?.key ?? "state" }, back };
        }
        const count = sectionCountLabel(page);
        if (count !== undefined) {
            const label = el("p", "section-catalog-count", count);
            label.style.width = `${width}px`;
            content.push(label);
        }
        const retainsPrefix = this.cards.length <= page.items.length && this.cards.every((card, index) => page.items[index] === card);
        if (!retainsPrefix || this.dirty || this.overlays !== overlays || this.scale !== scale || this.hidesImages !== hidesImages) {
            // Keep the focused old node connected until FocusHost captures its identity/index.
            this.grid = el("div", "browse-grid section-catalog-grid");
            this.items = [];
            this.cards = [];
        }
        this.dirty = false;
        this.overlays = overlays;
        this.scale = scale;
        this.hidesImages = hidesImages;
        this.grid.style.setProperty("--section-columns", String(columns));
        this.grid.style.width = `${width}px`;
        this.grid.style.setProperty("--section-scale", String(scale));
        const { preview: _preview, ...gridContext } = context;
        for (const card of page.items.slice(this.cards.length)) {
            const saved = route.kind === "homeSection" && route.continuing ? context.savedFileOverlay?.(card) : undefined;
            const item = cardItem(saved === undefined ? card : { ...card, overlay: saved }, {
                ...gridContext, continueWatching: route.kind === "homeSection" && route.continuing, cardLayout: "grid", homeCaptions: true, overlays, posterWidth: POSTER_WIDTH,
            });
            if (item === undefined) continue;
            this.items.push(item);
            this.grid.appendChild(item.element);
        }
        this.cards = page.items;
        content.push(this.grid);
        if (busy) {
            const spinner = el("div", "section-catalog-loading");
            spinner.setAttribute("role", "status");
            spinner.setAttribute("aria-label", "Loading more titles");
            content.push(spinner);
        }
        const actions = route.failure === undefined ? [] : [actionButton("retry", "Try again", retry)];
        if (route.failure !== undefined) {
            const error = el("p", "browse-text", route.failure);
            error.setAttribute("role", "alert");
            content.push(error, ...actions.map(item => item.element));
        }
        if (!busy && route.failure === undefined && page.nextCursor !== undefined) {
            this.observer = new IntersectionObserver(entries => {
                if (entries.some(entry => entry.isIntersecting && entry.target.isConnected)) more();
            });
            for (const item of this.items.slice(-6)) this.observer.observe(item.element);
        }
        return { name, content, zones: [{ id: "grid", layout: "grid", columns, items: this.items }, ...(actions.length === 0 ? [] : [{ id: "actions", layout: "row" as const, items: actions }])], focus: this.items[0] === undefined ? undefined : { zone: "grid", key: this.items[0].key }, back };
    }
}
