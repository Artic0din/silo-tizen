import { decodeCard, type HomeSection } from "./catalog.ts";
import { object, string, optionalString, WireError } from "./wire.ts";

export const RECOMMENDATION_KINDS = ["for-you-main", "cluster", "similar-users", "popular", "recently-added", "top-rated", "genre"] as const;
export type RecommendationKind = typeof RECOMMENDATION_KINDS[number];
export interface RecommendationLocator { readonly kind: RecommendationKind; readonly key?: string }
export interface RecommendationRow extends HomeSection { readonly locator?: RecommendationLocator }

export function decodeRecommendationRow(value: unknown): RecommendationRow {
    const row = object(value, "recommendation_row");
    const type = string(row, "type", "recommendation_row");
    const title = string(row, "title", "recommendation_row");
    const kind = optionalString(row, "kind", "recommendation_row");
    const key = optionalString(row, "key", "recommendation_row");
    if (!Array.isArray(row.items)) throw new WireError("recommendation_row.items", "an array of catalog cards");
    const items = row.items.map((card, index) => decodeCard(card, `recommendation_row.items[${index}]`));
    const supported = RECOMMENDATION_KINDS.find(value => value === kind);
    const locator = supported !== undefined && (!(supported === "cluster" || supported === "genre") || (key !== undefined && key.trim() !== "")) ? { kind: supported, ...(key === undefined ? {} : { key }) } : undefined;
    return {
        id: `recommendation:${JSON.stringify([type, kind ?? null, key ?? null, ...(locator === undefined ? [items.map(card => card.id)] : [])])}`,
        sectionType: type, title, items, ...(locator === undefined ? {} : { locator }),
    };
}

export function decodeRecommendations(value: unknown): RecommendationRow[] {
    const collection = object(value, "recommendations");
    if (!Array.isArray(collection.items)) throw new WireError("recommendations.items", "an array of recommendation rows");
    const rows = collection.items.map(decodeRecommendationRow).filter(row => row.items.length > 0);
    const seen = new Set<string>();
    return rows.filter(row => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
    }).sort((a, b) => Number(b.title.toLowerCase() === "for you") - Number(a.title.toLowerCase() === "for you"));
}
