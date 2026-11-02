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
        const viewport = element.closest<HTMLElement>(".details-audio-picker, .skyline-content") ?? container;
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
        const rect = element.getBoundingClientRect();
        const bounds = viewport.getBoundingClientRect();
        const topEdge = bounds.top + 12;
        const bottomEdge = bounds.bottom - 32;
        const delta = rect.top < topEdge ? rect.top - topEdge : rect.bottom > bottomEdge ? rect.bottom - bottomEdge : 0;
        // Opening selectors scale their rectangles, while scrollTop stays in unscaled CSS pixels.
        const scale = bounds.height / viewport.offsetHeight;
        this.move(viewport, 0, Math.max(0, viewport.scrollTop + delta / scale));
    }

    stop(): void {
        for (const frame of this.frames.values()) cancelAnimationFrame(frame);
        this.frames.clear();
    }
}
