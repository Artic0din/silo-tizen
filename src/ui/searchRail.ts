import type { FocusItem } from "./browseFocus.ts";
import { zoneNode } from "./browseViews.ts";

/** Swift's lazy rail draws whole intersecting cards outside its logical scroll frame. */
export function searchRail(className: string, items: readonly FocusItem[]): HTMLElement {
    const row = zoneNode(`browse-row search-overflow-rail ${className}`, items);
    requestAnimationFrame(() => {
        if (!row.isConnected) return;
        const style = getComputedStyle(row);
        const paint = new IntersectionObserver(entries => {
            for (const entry of entries) entry.target.classList.toggle("search-rail-outside", entry.intersectionRect.width === 0);
        }, { root: row, rootMargin: `0px -${style.paddingRight} 0px -${style.paddingLeft}` });
        for (const item of items) paint.observe(item.element);
        const detached = new MutationObserver(() => {
            if (row.isConnected) return;
            paint.disconnect(); detached.disconnect();
        });
        detached.observe(row.ownerDocument, { childList: true, subtree: true });
    });
    return row;
}
