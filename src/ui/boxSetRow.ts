// The tvOS movie-page box set row. It owns its read so the details layout can
// keep a one-call hook while that screen is changing elsewhere.
// Apple: TVBoxSetRow, BoxSetRowWindow, TVMediaCard's current-film marker.

import { ApiError } from "../api/errors.ts";
import { boxSetOperations } from "../api/boxSetOperations.ts";
import type { Card } from "../contracts/v2/catalog.ts";
import type { CatalogBoxSetDetail } from "../contracts/v2/boxSets.ts";
import type { NativeSession } from "../session/session.ts";
import type { FocusItem, Zone } from "./browseFocus.ts";
import { cardItem, exploreAllCard, type ViewContext } from "./browseViews.ts";
import { el } from "./screen.ts";

/** TVBoxSetRow card width and the gap before the next poster. */
export const BOX_SET_ROW_CARD_WIDTH = 220;
export const BOX_SET_ROW_SPACING = 44;
/** Browse content width at 1920 with the 88px page inset on each side. */
export const BOX_SET_ROW_WIDTH = 1744;

/** How many poster cards of `cardWidth` fit across `width`, `spacing` apart. */
export function boxSetRowSlots(width: number, cardWidth: number, spacing: number): number {
    if (cardWidth <= 0 || width <= 0) return 0;
    return Math.floor((width + spacing) / (cardWidth + spacing));
}

/**
 * The index of the first of `count` films when `filmSlots` fit. The row
 * starts at the first film; when the film on screen would not fit, it slides
 * so that film shows after the one before it.
 */
export function boxSetRowStart(current: number | undefined, count: number, filmSlots: number): number {
    if (current === undefined || current < filmSlots || filmSlots <= 0) return 0;
    const before = filmSlots > 1 ? 1 : 0;
    return Math.min(Math.max(current - before, 0), count - filmSlots);
}

/** The films shown in `slots` cards, one of them kept for Explore all. */
export function boxSetRowFilms<T extends { readonly id: string }>(items: readonly T[], currentId: string, slots: number, endsWithExploreAll: boolean): T[] {
    const filmSlots = Math.max(0, slots - (endsWithExploreAll ? 1 : 0));
    const index = items.findIndex(item => item.id === currentId);
    const first = boxSetRowStart(index === -1 ? undefined : index, items.length, filmSlots);
    return items.slice(first, Math.min(items.length, first + filmSlots));
}

/** Loads one movie's box set beside the page. A failed reread keeps the row; "none" removes it. */
export class BoxSetRowState {
    detail: CatalogBoxSetDetail | undefined;
    /** Opens the box set page. The browse owner sets this; the row does not push routes itself. */
    open: (detail: CatalogBoxSetDetail) => void = () => undefined;
    private readonly session: NativeSession;
    private readonly contentId: string;
    private readonly supported: () => Promise<boolean>;
    private readonly changed: () => void;
    private controller: AbortController | undefined;
    private generation = 0;

    constructor(session: NativeSession, contentId: string, supported: () => Promise<boolean>, changed: () => void) {
        this.session = session;
        this.contentId = contentId;
        this.supported = supported;
        this.changed = changed;
    }

    restore(previous: BoxSetRowState | undefined): void {
        this.detail = previous?.detail;
    }

    start(): void {
        // A second start while this read is out would abort it and send another.
        if (this.controller !== undefined) return;
        const controller = new AbortController();
        this.controller = controller;
        const generation = ++this.generation;
        void this.load(controller, generation);
    }

    stop(): void {
        this.generation += 1;
        this.controller?.abort();
        this.controller = undefined;
    }

    private async load(controller: AbortController, generation: number): Promise<void> {
        const current = (): boolean => !controller.signal.aborted && generation === this.generation;
        try {
            const yes = await this.supported();
            if (!current()) return;
            if (!yes) return;
            const fresh = await this.session.call({ ...boxSetOperations.forItem(this.contentId), profileScoped: true, signal: controller.signal });
            if (!current()) return;
            this.detail = fresh;
            this.changed();
        } catch (error) {
            if (!current()) return;
            if (error instanceof ApiError && error.status === 404) {
                this.detail = undefined;
                this.changed();
            }
        } finally {
            // Only this read may release itself. A later start, including a watched refresh, can then proceed.
            if (this.controller === controller) this.controller = undefined;
        }
    }
}

export function boxSetMovieRow(row: BoxSetRowState, currentId: string, context: ViewContext): { readonly content: HTMLElement[]; readonly zone: Zone } | undefined {
    const detail = row.detail;
    if (detail === undefined || detail.items.length === 0) return undefined;
    // TVMediaCard.artworkSize: 220 times the card-size scale, here and in browse.css.
    const posterWidth = BOX_SET_ROW_CARD_WIDTH * (context.posterScale?.() ?? 1);
    const slots = boxSetRowSlots(BOX_SET_ROW_WIDTH, posterWidth, BOX_SET_ROW_SPACING);
    const films = boxSetRowFilms(detail.items, currentId, slots, true);
    const items: FocusItem[] = [];
    for (const movie of films) {
        const item = cardItem(movie, { ...context, posterWidth });
        if (item === undefined) continue;
        if (movie.id === currentId) markCurrentFilm(item, movie);
        items.push(item);
    }
    items.push(exploreAllCard(detail.boxSet.title, "box-set-explore", false, () => row.open(detail)));
    if (items.length === 0) return undefined;
    const node = el("div", "browse-row box-set-row");
    node.setAttribute("data-detail-section", "box-set");
    for (const item of items) node.appendChild(item.element);
    const entry = films.some(movie => movie.id === currentId) ? currentId : films[0]?.id;
    return {
        content: [el("h2", "browse-section-title", detail.boxSet.title), node],
        zone: { id: "box-set", layout: "row", entry, items },
    };
}

/** Outline and THIS FILM on the movie whose page this is. Focus hides the outline; the card does not open itself. */
function markCurrentFilm(item: FocusItem, movie: Card): void {
    item.element.addEventListener("click", event => {
        event.preventDefault();
        event.stopImmediatePropagation();
    }, true);
    const art = item.element.querySelector(".browse-art");
    if (art === null) return;
    const outline = el("span", "box-set-current-outline");
    outline.setAttribute("aria-hidden", "true");
    art.append(outline, el("span", "box-set-current-label", "This film"));
    item.element.setAttribute("aria-label", `${movie.title}, This film`);
}
