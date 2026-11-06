import { type Route, type RouteHandlers, type Pages, newRoute, newPages } from "./browseRoutes.ts";
import { actionButton, homeView, statusView, searchState, FAILURE_ICON, zoneNode } from "./browseViews.ts";
import { SectionCatalog } from "./sectionCatalog.ts";
import type { View } from "./browseFocus.ts";
import { destinationOf } from "./browseModel.ts";

type RecommendationRoute = Extract<Route, { kind: "for_you" | "recommendationSection" }>;
const grids = new WeakMap<Pages, SectionCatalog>();

export function recommendationsView(current: RecommendationRoute, handlers: RouteHandlers): View {
    if (current.kind === "recommendationSection") {
        let grid = grids.get(current.pages);
        if (grid === undefined) { grid = new SectionCatalog(); grids.set(current.pages, grid); }
        const view = grid.view({ ...current, kind: "homeSection", id: JSON.stringify(current.locator), continuing: false, pendingIndex: undefined }, handlers.context, handlers.busy, handlers.pop, () => handlers.retry(current), () => undefined);
        return { ...view, name: `recommendationSection:${JSON.stringify(current.locator)}` };
    }
    const rows = current.data?.filter(row => row.items.some(card => destinationOf(card) !== undefined));
    if (rows === undefined || rows.length === 0) {
        const failed = current.failure !== undefined;
        const loading = rows === undefined && !failed;
        if (failed) {
            const retry = actionButton("retry", "Try Again", () => handlers.retry(current));
            const page = searchState("Something went wrong", current.failure ?? "", "details-failure", FAILURE_ICON);
            page.setAttribute("role", "alert");
            page.appendChild(zoneNode("browse-actions", [retry]));
            return { name: "for_you", content: [page], zones: [{ id: "status", layout: "row", items: [retry] }], focus: { zone: "status", key: "retry" }, back: handlers.pop };
        }
        const controls = failed ? [actionButton("retry", "Try again", () => handlers.retry(current))] : [actionButton("home", "Home", handlers.pop)];
        return statusView("for_you", failed ? "Something went wrong" : loading ? "Loading recommendations" : "No recommendations yet", failed ? [current.failure ?? ""] : loading ? [] : ["Watch or rate a few titles to build your personalised recommendations."], controls, handlers.pop, failed ? "error" : "info");
    }
    const view = homeView([], rows, handlers.context, {
        canExpand: section => rows.find(row => row.id === section.id)?.locator !== undefined,
        expand: section => {
            const locator = rows.find(row => row.id === section.id)?.locator;
            if (locator !== undefined) handlers.push(newRoute({ kind: "recommendationSection", locator, title: section.title, pages: newPages() }));
        },
        search: () => handlers.push(newRoute({ kind: "search", query: "", pages: undefined, resultsFor: "" })),
        library: library => handlers.push(newRoute({ kind: "library", library, pages: newPages() })),
        chooseProfile: handlers.chooseProfile,
    });
    return { ...view, name: "for_you", back: handlers.pop };
}
