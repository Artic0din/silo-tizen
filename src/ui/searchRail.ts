import type { FocusItem } from "./browseFocus.ts";
import { zoneNode } from "./browseViews.ts";

/**
 * A card is outside the logical rail when it misses the content box.
 * Chromium 108 clips an overflow root to that content box and then applies
 * `rootMargin`, so insetting the padding again reports the person at x 238,
 * width 200, as a zero-width intersection. Later Chromium uses the padding
 * box, which is why the same `rootMargin` kept the card on desktop.
 */
export function searchRailCardOutside(card: { readonly left: number; readonly right: number }, rail: { readonly left: number; readonly right: number }, paddingLeft: number, paddingRight: number): boolean {
    const frameLeft = rail.left + paddingLeft;
    const frameRight = rail.right - paddingRight;
    return card.right <= frameLeft || card.left >= frameRight;
}

/** Swift's lazy rail draws whole intersecting cards outside its logical scroll frame. */
export function searchRail(className: string, items: readonly FocusItem[]): HTMLElement {
    const row = zoneNode(`browse-row search-overflow-rail ${className}`, items);
    requestAnimationFrame(() => {
        if (!row.isConnected) return;
        const paint = (): void => {
            const style = getComputedStyle(row);
            const rail = row.getBoundingClientRect();
            const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
            const paddingRight = Number.parseFloat(style.paddingRight) || 0;
            for (const item of items) item.element.classList.toggle("search-rail-outside", searchRailCardOutside(item.element.getBoundingClientRect(), rail, paddingLeft, paddingRight));
        };
        const observed = new IntersectionObserver(() => paint(), { root: row });
        row.addEventListener("scroll", paint);
        for (const item of items) observed.observe(item.element);
        paint();
        const detached = new MutationObserver(() => {
            if (row.isConnected) return;
            observed.disconnect();
            detached.disconnect();
            row.removeEventListener("scroll", paint);
        });
        detached.observe(row.ownerDocument, { childList: true, subtree: true });
    });
    return row;
}
