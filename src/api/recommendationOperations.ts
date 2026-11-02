import type { RequestSpec } from "./http.ts";
import { decodeRecommendations, decodeRecommendationRow, type RecommendationLocator } from "../contracts/v2/recommendations.ts";

export const recommendationOperations = {
    recommendations: (artworkQuery: Readonly<Record<string, string>> = { image_size: "small" }): RequestSpec<ReturnType<typeof decodeRecommendations>> => ({
        method: "GET", path: `/recommendations/discover?${Object.entries(artworkQuery).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}`, retry: "safe", decode: decodeRecommendations,
    }),
    recommendationSection: (locator: RecommendationLocator): RequestSpec<ReturnType<typeof decodeRecommendationRow>> => ({
        method: "GET", path: `/recommendations/section/${encodeURIComponent(locator.kind)}?limit=60&image_size=small${locator.key === undefined ? "" : `&key=${encodeURIComponent(locator.key)}`}`, retry: "safe", decode: decodeRecommendationRow,
    }),
};
