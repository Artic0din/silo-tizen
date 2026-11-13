import { type Route, type RouteHandlers, newRoute, newPages, pageLoadingView } from "./browseRoutes.ts";
import type { RecommendationRow } from "../contracts/v2/recommendations.ts";
import { homeView, errorView, failureError, emptyStateOwner } from "./browseViews.ts";
import type { View } from "./browseFocus.ts";
import { destinationOf } from "./browseModel.ts";

/** SF Symbol sparkles.tv. */
const SPARKLES_TV_ICON = '<svg viewBox="0 0 48 48" fill="none"><rect x="3" y="7" width="42" height="29" rx="5" stroke="currentColor" stroke-width="3"/><path d="M16 42h16" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path fill="currentColor" d="M21 13.5q1.4 6.6 8 8-6.6 1.4-8 8-1.4-6.6-8-8 6.6-1.4 8-8ZM32 11q.8 3.2 4 4-3.2.8-4 4-.8-3.2-4-4 3.2-.8 4-4Z"/></svg>';

/** Rows with at least one card this client opens; RecommendationsViewModel.sortedNonEmptySections. */
export function browsableRows(rows: readonly RecommendationRow[] | undefined): RecommendationRow[] | undefined {
    return rows?.filter(row => row.items.some(card => destinationOf(card) !== undefined));
}

/**
 * Rows to show: none once a read answered 401. Apple's failed token refresh posts siloSessionExpired, which leaves the
 * page for sign-in whatever rows it holds (HTTPClient.swift:2354-2357, ContentView.swift:220-232).
 */
export function shownRows(current: Extract<Route, { kind: "for_you" }>): RecommendationRow[] | undefined {
    return current.failure !== undefined && current.error?.signIn === true ? undefined : browsableRows(current.data);
}

/**
 * Apple RecommendationsView on tvOS (RecommendationsView.swift:111-157): the Skyline feed while it has rows, without
 * Explore all; otherwise ErrorView, then a clear page focus owner while loading, then EmptyStateView.
 */
export function recommendationsView(current: Extract<Route, { kind: "for_you" }>, handlers: RouteHandlers): View {
    const rows = shownRows(current);
    if (rows !== undefined && rows.length > 0) {
        const view = homeView([], rows, handlers.context, {
            canExpand: () => false,
            expand: () => undefined,
            search: () => handlers.push(newRoute({ kind: "search", query: "", pages: undefined, resultsFor: "" })),
            library: library => handlers.push(newRoute({ kind: "library", library, pages: newPages() })),
            chooseProfile: handlers.chooseProfile,
        });
        return { ...view, name: "for_you", back: handlers.pop };
    }
    // A root page: ErrorView offers no Go Back (ErrorView.swift:94-97).
    if (current.failure !== undefined) return errorView("for_you", failureError(current.failure, current.error), () => handlers.retry(current), undefined, handlers.signIn);
    if (current.data === undefined) return pageLoadingView("for_you", "Loading recommendations");
    const empty = emptyStateOwner("No recommendations yet", "Watch or rate a few titles to build your personalised recommendations.", "for-you-empty", SPARKLES_TV_ICON);
    return { name: "for_you", content: [empty.element], zones: [{ id: "empty", layout: "row", items: [empty] }], focus: { zone: "empty", key: empty.key }, back: undefined };
}
