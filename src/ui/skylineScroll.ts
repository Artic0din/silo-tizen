/** Retarget from the visible position; focus itself must never invoke browser scrolling. */
export class SkylineScroll {
    private readonly frames = new Map<HTMLElement, number>();

    move(node: HTMLElement, left: number, top: number): void {
        const previous = this.frames.get(node);
        if (previous !== undefined) cancelAnimationFrame(previous);
        const fromLeft = node.scrollLeft;
        const fromTop = node.scrollTop;
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
            node.scrollLeft = left;
            node.scrollTop = top;
            return;
        }
        const start = performance.now();
        const frame = (now: number): void => {
            if (!node.isConnected) {
                this.frames.delete(node);
                return;
            }
            const progress = Math.min(1, (now - start) / 200);
            const eased = 1 - Math.pow(1 - progress, 3);
            node.scrollLeft = fromLeft + (left - fromLeft) * eased;
            node.scrollTop = fromTop + (top - fromTop) * eased;
            if (progress < 1) this.frames.set(node, requestAnimationFrame(frame));
            else this.frames.delete(node);
        };
        this.frames.set(node, requestAnimationFrame(frame));
    }

    reveal(element: HTMLElement, container: HTMLElement): void {
        if (element.closest(".browse-nav, .skyline-selector:not(.details-audio-picker)") !== null) return;
        const viewport = element.closest<HTMLElement>(".browse-panel-list, .details-audio-picker, .skyline-content, .accounts-rail, .accounts-pane, .accounts-settings") ?? container;
        if (element.closest(".person-filmography-filters") !== null ||
            (container.dataset.view === "search" && element.closest(".search-filters, .search-field") !== null)) {
            this.move(viewport, 0, 0);
            return;
        }
        const row = element.closest<HTMLElement>(".browse-row");
        if (row !== null) {
            const bounds = row.getBoundingClientRect();
            const card = element.getBoundingClientRect();
            // Rows padded for a focus lift keep the lifted card inside that padding.
            const style = getComputedStyle(row);
            const left = Math.max(12, parseFloat(style.paddingLeft));
            const right = Math.max(12, parseFloat(style.getPropertyValue("--reveal-end")) || parseFloat(style.paddingRight));
            const delta = card.left < bounds.left + left ? card.left - bounds.left - left : card.right > bounds.right - right ? card.right - bounds.right + right : 0;
            this.move(row, Math.max(0, row.scrollLeft + delta), 0);
        }
        if (container.dataset.view === "search" && element.closest(".search-people-rail") !== null) {
            this.move(viewport, 0, 0);
            return;
        }
        const rect = element.getBoundingClientRect();
        const bounds = viewport.getBoundingClientRect();
        // Apple's Requests band is view-aligned: the focused row's top sits on the band's top.
        // Apple view-aligns a Home row (`scrollTargetBehavior(.viewAligned)` on TVSkylineSectionFeed)
        // and a Requests row, so the focused row's top sits on the band's top.
        const aligned = element.closest<HTMLElement>(".requests-row") ?? element.closest<HTMLElement>(".skyline-home .home-section");
        if (aligned !== null) {
            this.move(viewport, 0, viewport.scrollTop + aligned.getBoundingClientRect().top - bounds.top);
            return;
        }
        const margins = getComputedStyle(element);
        let posterTop = rect.top;
        const searchPoster = container.dataset.view === "search" && element.closest(".browse-grid") !== null;
        if (searchPoster) {
            const art = element.querySelector<HTMLElement>(".browse-art");
            if (art !== null) {
                const artRect = art.getBoundingClientRect();
                const style = getComputedStyle(art);
                // Reveal the final focused bounds, independent of the current lift animation frame.
                const focusedHeight = parseFloat(style.height) * parseFloat(style.getPropertyValue("--card-focus-scale"));
                posterTop = artRect.top + (artRect.height - focusedHeight) / 2;
            }
        }
        // Up in Search rests the focused poster ring at 495 so the field and filter pills stay
        // on screen. The removed 160.4 scroll-margin pinned a different path and clipped those pills.
        const topEdge = bounds.top + (searchPoster ? 495 : Math.max(12, parseFloat(margins.scrollMarginTop)));
        const bottomEdge = bounds.bottom - (container.dataset.view === "search"
            ? Math.max(32, parseFloat(getComputedStyle(viewport).scrollPaddingBottom) || 0)
            : Math.max(32, parseFloat(margins.scrollMarginBottom)));
        const delta = posterTop < topEdge ? posterTop - topEdge : rect.bottom > bottomEdge ? rect.bottom - bottomEdge : 0;
        // Opening selectors scale their rectangles, while scrollTop stays in unscaled CSS pixels.
        const scale = bounds.height / viewport.offsetHeight;
        this.move(viewport, 0, Math.max(0, viewport.scrollTop + delta / scale));
    }

    stop(): void {
        for (const frame of this.frames.values()) cancelAnimationFrame(frame);
        this.frames.clear();
    }
}
