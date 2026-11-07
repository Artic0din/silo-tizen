import type { Episode, Season } from "../contracts/v2/catalog.ts";

/**
 * Scroll offset for the anchored episode rail.
 * TVEpisodeRail.swift:400-414,458-468 at abf4ac45aa0ded295dd1443b91457cdf42dffbf2.
 * The visible slot is not this offset. Leading padding is the lookbehind
 * (card width + spacing) plus the hover inset. The mask cancels the card
 * width, and the row shifts back by the spacing except when Details opens
 * on a mid-season episode. episodeRailSlot is that padding, before the shift.
 */
export function episodeRailOffset(index: number, count: number, width: number, spacing: number, viewport: number): number {
    if (count === 0) return 0;
    const step = width + spacing;
    const content = count * width + (count - 1) * spacing;
    const maximum = Math.ceil(Math.max(0, content - viewport) / step) * step;
    return Math.min(Math.max(0, index) * step, maximum);
}

/** Layout left of the focused card: mask inset, one card spacing, and the hover inset. */
export function episodeRailSlot(width: number, spacing: number, inset = 100): number {
    return inset + spacing + width * 0.025 + 2;
}

export function orderedEpisodeSeasons(seasons: readonly Season[]): number[] {
    return [...new Set([...seasons].sort((a, b) => Number(a.isSpecials || a.seasonNumber === 0) - Number(b.isSpecials || b.seasonNumber === 0) || a.seasonNumber - b.seasonNumber).map(season => season.seasonNumber))];
}

/** SeriesEpisodeWindow.swift:26-81 at the same revision. Missing pages break continuity. */
export function episodeWindow(order: readonly number[], selected: number | undefined, pages: ReadonlyMap<number, readonly Episode[]>): readonly Episode[] {
    if (selected === undefined || !pages.has(selected)) return [];
    let first = order.indexOf(selected), last = first;
    if (first < 0) return [];
    while (first > 0 && pages.has(order[first - 1]!)) first--;
    while (last + 1 < order.length && pages.has(order[last + 1]!)) last++;
    const seen = new Set<string>();
    return order.slice(first, last + 1).flatMap(season => [...pages.get(season)!].sort((a, b) => a.episodeNumber - b.episodeNumber)).filter(episode => !seen.has(episode.id) && !!seen.add(episode.id));
}

export function retainEpisodePages(order: readonly number[], selected: number, pages: Map<number, readonly Episode[]>): void {
    const index = order.indexOf(selected);
    const nearest = order.filter(number => (pages.get(number)?.length ?? 0) > 0).sort((a, b) => Math.abs(order.indexOf(a) - index) - Math.abs(order.indexOf(b) - index) || order.indexOf(a) - order.indexOf(b)).slice(0, 5);
    const keep = new Set(nearest);
    for (const direction of [-1, 1]) {
        const seen = new Set((pages.get(selected) ?? []).map(episode => episode.id));
        let count = 0;
        for (let neighbor = index + direction; neighbor >= 0 && neighbor < order.length && count < 8; neighbor += direction) {
            const number = order[neighbor]!, page = pages.get(number);
            if (page === undefined) break;
            keep.add(number);
            for (const episode of page) if (!seen.has(episode.id)) { seen.add(episode.id); count++; }
        }
    }
    for (const [number, page] of pages) if (!order.includes(number) || (page.length > 0 && !keep.has(number))) pages.delete(number);
}
