import type { RequestSpec } from "./http.ts";
import { decodeRecommendations } from "../contracts/v2/recommendations.ts";

export const recommendationOperations = {
    recommendations: (artworkQuery: Readonly<Record<string, string>> = { image_size: "small" }): RequestSpec<ReturnType<typeof decodeRecommendations>> => ({
        method: "GET", path: `/recommendations/discover?${Object.entries(artworkQuery).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}`, retry: "safe", decode: decodeRecommendations,
    }),
};
