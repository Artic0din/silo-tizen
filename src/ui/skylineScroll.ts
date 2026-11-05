import { episodeRailOffset } from "./episodeRail.ts";

/** Apple's focused History rows 2 and 3 put the unlifted poster top here. */
const HISTORY_POSTER_TOP = 554;

/** Retarget from the visible position; focus itself must never invoke browser scrolling. */
const DETAILS_CAST_HEADING_CENTRE_OFFSET = 6;

export class SkylineScroll {
    private readonly frames = new Map<HTMLElement, number>();
    /** Shelf already bottom-aligned. Horizontal moves inside it do not scroll again. */
    private pinnedShelf: HTMLElement | null = null;

    static prepareEpisodeRow(row: HTMLElement): number | undefined {
        if (!row.classList.contains("details-episodes")) return undefined;
        const cards = Array.from(row.children).filter((node): node is HTMLElement => node instanceof HTMLElement);
        const first = cards[0], last = cards.at(-1);
        if (first === undefined || last === undefined) return 0;
        const style = getComputedStyle(row), inset = parseFloat(style.paddingLeft);
        const cardStyle = getComputedStyle(first);
        // offsetWidth rounds Compact's 309.6px still before multiplying the pitch.
        const width = parseFloat(cardStyle.width), spacing = parseFloat(cardStyle.marginRight);
        const contentWidth = cards.length * width + (cards.length - 1) * spacing;
        const viewport = row.clientWidth - inset + width * .025 + 2;
        const maximum = episodeRailOffset(cards.length - 1, cards.length, width, spacing, viewport);
        row.style.paddingRight = `${Math.max(0, row.clientWidth + maximum - inset - contentWidth - spacing)}px`;
        return maximum;
    }

    static episodeOffset(row: HTMLElement, element: HTMLElement): number {
        const maximum = SkylineScroll.prepareEpisodeRow(row) ?? 0;
        const first = row.firstElementChild as HTMLElement | null;
        return first === null ? 0 : Math.min(maximum, Math.max(0, element.offsetLeft - first.offsetLeft));
    }

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
        if (element.closest("[data-scroll-top]") !== null) {
            this.pinnedShelf = null;
            this.move(viewport, 0, 0);
            return;
        }
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
            // Apple keeps a final group of cards; the terminal episode need not occupy the leading slot.
            const delta = card.left < bounds.left + left ? card.left - bounds.left - left : card.right > bounds.right - right ? card.right - bounds.right + right : 0;
            this.move(row, row.classList.contains("details-episodes") ? SkylineScroll.episodeOffset(row, element) : Math.max(0, row.scrollLeft + delta), 0);
        }
        if (container.dataset.view === "search" && element.closest(".search-people-rail") !== null) {
            this.move(viewport, 0, 0);
            return;
        }
        const rect = element.getBoundingClientRect();
        const bounds = viewport.getBoundingClientRect();
        // tvOS pins the primary Series viewport; Large lifts the hero so its rail still fits.
        if (element.closest(".details-editorial, .details-season-chips, .details-episodes") !== null) {
            this.move(viewport, 0, 0);
            return;
        }
        const related = element.closest<HTMLElement>('[data-detail-section="related"]');
        if (related !== null) {
            const rail = related.getBoundingClientRect();
            const header = related.previousElementSibling?.getBoundingClientRect();
            const centre = ((header?.top ?? rail.top) + rail.bottom) / 2;
            this.move(viewport, 0, Math.max(0, viewport.scrollTop + centre - (bounds.top + bounds.bottom) / 2));
            return;
        }
        const cast = element.closest<HTMLElement>(".details-people");
        if (cast !== null) {
            // tvOS centers the supporting section's leading anchor, not the full portrait rail.
            const header = cast.previousElementSibling?.getBoundingClientRect();
            this.move(viewport, 0, Math.max(0, viewport.scrollTop + (header?.top ?? rect.top) - bounds.top - bounds.height / 2 - DETAILS_CAST_HEADING_CENTRE_OFFSET));
            return;
        }
        const shelf = element.closest<HTMLElement>('[data-scroll-align="bottom"]');
        if (shelf !== null) {
            if (shelf.getAttribute("data-scroll-anchor") === "top") {
                shelf.removeAttribute("data-scroll-anchor");
                this.pinnedShelf = shelf;
                const section = shelf.getBoundingClientRect();
                this.move(viewport, 0, Math.max(0, viewport.scrollTop + section.top - bounds.top));
                return;
            }
            // CalendarView.shelfGainedFocus bottom-aligns only after the day
            // changes (CalendarView.swift:400-407). The first landing has no
            // previous day, so the focus engine reveals the card with the
            // least scrolling. A card already on screen stays put; one below
            // the page is revealed, then pinned so sideways moves do not scroll.
            if (shelf === this.pinnedShelf) return;
            const previous = this.pinnedShelf;
            this.pinnedShelf = shelf;
            if (previous === null) {
                const target = element.getBoundingClientRect();
                if (target.top >= bounds.top && target.bottom <= bounds.bottom) return;
                const delta = target.top < bounds.top ? target.top - bounds.top : target.bottom - bounds.bottom;
                this.move(viewport, 0, Math.max(0, viewport.scrollTop + delta));
                return;
            }
            const section = shelf.getBoundingClientRect();
            // CalendarView.shelfGainedFocus scrolls the day to anchor .bottom
            // (CalendarView.swift:400-407). The id is the shelf; its 6pt
            // bottom padding is outside that id (CalendarView.swift:339-344).
            // The page ignores only the top and horizontal safe areas, and the
            // settled shelf bottom is y1010: heading y455, poster top y541.
            const bottom = viewport.scrollTop + section.bottom - (bounds.bottom - 70);
            const heading = viewport.scrollTop + section.top - bounds.top;
            this.move(viewport, 0, Math.max(0, Math.min(bottom, heading)));
            return;
        }
        if (container.dataset.view === "personal:history" && element.closest(".catalog-grid") !== null) {
            // HistoryView's plain ScrollView uses native edge reveal, not Home's row alignment.
            // Keep the measured compact anchor, bounded by the complete focused card.
            // Use final focus geometry so animation frames cannot retarget the scroll.
            const art = element.querySelector<HTMLElement>(".browse-art");
            if (art !== null) {
                const height = parseFloat(getComputedStyle(art).height);
                const artRect = art.getBoundingClientRect();
                const top = artRect.top + (artRect.height - height) / 2;
                const gap = parseFloat(getComputedStyle(element).getPropertyValue("--card-caption-gap"));
                const captionLift = Math.max(0, height * .025 + 8 - gap);
                const focusedHeight = Math.max(height * 1.025, element.offsetHeight + captionLift);
                const anchor = Math.min(HISTORY_POSTER_TOP, bounds.bottom - 32 - focusedHeight);
                const firstRow = element.offsetTop === (element.parentElement?.firstElementChild as HTMLElement | null)?.offsetTop;
                const delta = top < bounds.top + 12 ? top - bounds.top - 12 : top > anchor ? top - anchor : 0;
                this.move(viewport, 0, firstRow ? 0 : Math.max(0, viewport.scrollTop + delta));
                return;
            }
        }
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
        this.pinnedShelf = null;
    }
}
