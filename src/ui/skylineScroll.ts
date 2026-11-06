import { episodeRailOffset } from "./episodeRail.ts";

/** Apple's focused History rows 2 and 3 put the unlifted poster top here. */
const HISTORY_POSTER_TOP = 554;

// Measured from the running Apple TV app at 7baff3e, 6 Nov 2026: tvOS focus reveal, not Swift offsets.
const DETAILS_DOWN_HEADING = { cast: 546, trailers: 501, posters: 547 };
const DETAILS_UP_HEADING = 111;
// The local section heights differ from Swift's complete centered anchors.
const DETAILS_CENTER_HEADING = { moviePosters: 321, seriesCast: 367 };

/**
 * A Settings caption is not focusable. Extend the focused row through the
 * following footer so the last row cannot leave that caption below the pane
 * (measured shortfalls: Subtitles 617.5 of 732, Playback 119.5 of 194).
 */
function settingsRevealBottom(element: HTMLElement, rowBottom: number): number {
    const pane = element.closest(".settings-pane");
    if (pane === null) return rowBottom;
    let bottom = rowBottom;
    let node: HTMLElement | null = element;
    while (node !== null && node !== pane) {
        let sibling = node.nextElementSibling;
        while (sibling instanceof HTMLElement) {
            if (sibling.matches("[data-focus]") || sibling.querySelector("[data-focus]") !== null) return bottom;
            bottom = Math.max(bottom, sibling.getBoundingClientRect().bottom);
            sibling = sibling.nextElementSibling;
        }
        node = node.parentElement;
    }
    return bottom;
}

export class SkylineScroll {
    /** TVSeriesDetailView.swift:653-674 centers the selected mode. */
    static seasonOffset(row: HTMLElement, element: HTMLElement): number {
        return Math.max(0, Math.min(row.scrollWidth - row.clientWidth, element.offsetLeft - row.offsetLeft + element.offsetWidth / 2 - row.clientWidth / 2));
    }
    private readonly frames = new Map<HTMLElement, number>();
    /** Shelf already bottom-aligned. Horizontal moves inside it do not scroll again. */
    private pinnedShelf: HTMLElement | null = null;

    restoreDetailsAnchor(element: HTMLElement, viewport: HTMLElement): boolean {
        // TVDetailFocusScroll pins actions; TVSeriesDetailView pins the primary episode viewport.
        if (element.closest(".details-editorial, .details-season-chips, .details-episodes") === null) return false;
        this.move(viewport, 0, 0);
        return true;
    }

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
        // Extra right-edge paint must not move the stepped terminal boundary.
        const paintEnd = parseFloat(style.getPropertyValue("--episode-paint-end")) || 0;
        const viewport = row.clientWidth - paintEnd - inset + width * .025 + 2;
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

    reveal(element: HTMLElement, container: HTMLElement, previous?: Element | null): void {
        if (element.closest(".settings-categories") !== null) return;
        if (element.closest(".browse-nav, .skyline-selector:not(.details-audio-picker)") !== null) return;
        const viewport = element.closest<HTMLElement>(".browse-panel-list, .details-audio-picker, .settings-modal-options, .settings-pane, .skyline-content, .accounts-rail, .accounts-pane, .accounts-settings") ?? container;
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
            this.move(row, row.classList.contains("details-episodes") ? SkylineScroll.episodeOffset(row, element) : row.classList.contains("details-season-chips") && element.getAttribute("aria-pressed") === "true" ? SkylineScroll.seasonOffset(row, element) : Math.max(0, row.scrollLeft + delta), 0);
        }
        if (container.dataset.view === "search" && element.closest(".search-people-rail") !== null) {
            this.move(viewport, 0, 0);
            return;
        }
        const rect = element.getBoundingClientRect();
        const bounds = viewport.getBoundingClientRect();
        // tvOS pins the primary Series viewport; Large lifts the hero so its rail still fits.
        if (this.restoreDetailsAnchor(element, viewport)) return;
        const section = element.closest<HTMLElement>('.details-people, .details-extras, [data-detail-section="related"], .details-facts');
        if (section !== null) {
            if (previous !== undefined && previous !== element && section.contains(previous)) return;
            if (section.classList.contains('details-facts')) {
                this.move(viewport, 0, viewport.scrollHeight - viewport.clientHeight);
                return;
            }
            const header = section.previousElementSibling?.getBoundingClientRect();
            if (header === undefined) return;
            const headingTop = viewport.scrollTop + header.top - bounds.top;
            const up = previous?.isConnected === true && previous.getBoundingClientRect().top > rect.top;
            const series = container.querySelector('.details-hero')?.getAttribute('data-media-type') === 'series';
            const cast = section.classList.contains('details-people');
            const posters = section.hasAttribute('data-detail-section');
            const centered = series && cast ? DETAILS_CENTER_HEADING.seriesCast : !series && posters ? DETAILS_CENTER_HEADING.moviePosters : undefined;
            const target = centered ?? (up ? DETAILS_UP_HEADING : cast ? DETAILS_DOWN_HEADING.cast : posters ? DETAILS_DOWN_HEADING.posters : DETAILS_DOWN_HEADING.trailers);
            // A section fully reachable on the unscrolled page needs no upward reveal.
            const artwork = element.querySelector('.browse-art');
            const visibleAtTop = headingTop >= 0 && viewport.scrollTop + (artwork ?? element).getBoundingClientRect().bottom - bounds.top <= viewport.clientHeight;
            this.move(viewport, 0, up && visibleAtTop ? 0 : Math.max(0, headingTop - target));
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
        const revealBottom = viewport.classList.contains("settings-pane") ? settingsRevealBottom(element, rect.bottom) : rect.bottom;
        const delta = posterTop < topEdge ? posterTop - topEdge : revealBottom > bottomEdge ? revealBottom - bottomEdge : 0;
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
