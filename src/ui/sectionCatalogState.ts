import { ApiError } from "../api/errors.ts";
import type { Card, CatalogPage } from "../contracts/v2/catalog.ts";

const SECTION_PAGE_SIZE = 60;
const LOAD_MORE_LEAD = 6;

export interface SectionSnapshot {
    readonly page: CatalogPage;
    readonly cursors: ReadonlySet<string>;
    readonly unavailable: boolean;
}

/** Publish only completed batches, so failed refreshes leave the old snapshot usable. */
export async function readSectionCatalog(
    previous: SectionSnapshot | undefined,
    append: boolean,
    read: (cursor: string | undefined, limit: number) => Promise<CatalogPage>,
    signal: AbortSignal,
): Promise<SectionSnapshot> {
    let items: Card[] = append ? [...(previous?.page.items ?? [])] : [];
    let cursor = append ? previous?.page.nextCursor : undefined;
    let cursors = new Set(append ? previous?.cursors : undefined);
    let target = append ? items.length + LOAD_MORE_LEAD : Math.max(LOAD_MORE_LEAD, previous?.page.items.length ?? 0);
    let totalExact = !append || previous?.page.totalExact === true;
    let restarted = false;
    for (;;) {
        if (signal.aborted) throw new ApiError({ kind: "aborted" });
        if (cursor !== undefined) {
            if (cursors.has(cursor)) throw new ApiError({ kind: "invalid_response", path: "catalog.page.next_cursor" });
            cursors.add(cursor);
        }
        let page: CatalogPage;
        try {
            page = await read(cursor, SECTION_PAGE_SIZE);
        } catch (error) {
            if (signal.aborted) throw new ApiError({ kind: "aborted" });
            if (error instanceof ApiError && error.problemId === "invalid_cursor" && !restarted) {
                restarted = true;
                cursor = undefined;
                cursors = new Set();
                items = [];
                totalExact = true;
                target = Math.max(LOAD_MORE_LEAD, previous?.page.items.length ?? 0);
                continue;
            }
            if (error instanceof ApiError && error.problemId === "invalid_cursor") throw new ApiError({ kind: "invalid_response", path: "catalog.page.cursor" });
            if (error instanceof ApiError && error.status === 404) {
                return { page: { items: [], nextCursor: undefined, total: 0, totalExact: true }, cursors: new Set(), unavailable: true };
            }
            throw error;
        }
        if (signal.aborted) throw new ApiError({ kind: "aborted" });
        totalExact = totalExact && page.totalExact;
        const seen = new Set(items.map(card => card.id));
        for (const card of page.items) {
            if (seen.has(card.id)) continue;
            seen.add(card.id);
            items.push(card);
        }
        cursor = page.nextCursor;
        if (cursor !== undefined && cursors.has(cursor)) throw new ApiError({ kind: "invalid_response", path: "catalog.page.next_cursor" });
        if (cursor === undefined || items.length >= target) {
            return { page: { ...page, items, totalExact }, cursors, unavailable: false };
        }
    }
}

export function sectionCountLabel(page: CatalogPage): string | undefined {
    const count = page.totalExact ? page.total : page.nextCursor === undefined ? page.items.length : undefined;
    return count === undefined ? undefined : `${count.toLocaleString()} item${count === 1 ? "" : "s"}`;
}
