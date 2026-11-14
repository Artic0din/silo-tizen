// Apple's card long-press menu: the tvOS `.contextMenu` of MediaCard and EpisodeThumbCard (silo-apple 85679e7,
// Components/MediaCard.swift:570-620, EpisodeThumbCard.swift:366-416). Rows come from the card's own row data, in
// MediaStateMenuItems order: Play or Resume, the watched, Favorites and Watchlist rows, then the destructive Remove.
// Choosing a row closes the menu and the change runs behind it; a failure shows HomeView's "Couldn't Update Item" alert.

import { operations } from "../api/operations.ts";
import { detailOperations, type HomeDismissal } from "../api/detailOperations.ts";
import type { Card } from "../contracts/v2/catalog.ts";
import type { NativeSession } from "../session/session.ts";
import { centredDialog } from "./confirmationDialog.ts";
import { remoteKey } from "./keys.ts";
import { el } from "./screen.ts";
import { heldSelect, listenSelectRelease, moveSelect, releasedSelect, swallowSelect } from "./selectRelease.ts";

/** What the opener knows about the card. A field it does not know is read from the item before the menu opens. */
export type MenuCard = Pick<Card, "id" | "title" | "type"> & Partial<Pick<Card, "played" | "favorite" | "watchlist" | "positionSeconds" | "seriesId">> & {
    /** A Details season pill, whose menu is Apple's season-only Mark Season Watched or Unwatched. */
    readonly seasonPill?: boolean;
};

export interface CardMenuOptions {
    /** Continue Watching's Play or Resume row (MediaRow.showsPlayInContextMenu). */
    readonly play?: (() => void) | undefined;
    /** Home's Continue Watching and Next Up rows offer Remove (SectionRow.offersHomeDismissal). */
    readonly dismissal?: HomeDismissal | undefined;
    /** Home injects its watched handler into every row, so its cards always get the watched row. */
    readonly home?: boolean | undefined;
}

export interface CardActionsHost {
    /** A change was applied; reread what shows it. `watched` is true for a landed watched change. */
    readonly applied: (id: string, watched: boolean) => void;
    /** A Home dismissal was accepted; drop the card from the playback rows before the reread, as HomeViewModel does. */
    readonly dismissed?: (card: MenuCard) => void;
    /** The menu or alert took the screen; remember where focus returns. */
    readonly opened: () => void;
    /** The menu or alert closed; return focus. */
    readonly closed: () => void;
    /**
     * Opens an episode's Details, the only way there from an episode rail. Apple's Home rows have no detail row
     * (SectionRow passes `onOpenContextDetail: nil`), so Home cards never show it.
     */
    readonly information?: (card: MenuCard) => void;
    /** A personal change from Details is still on its way; the menu's changes wait for it, as they did before. */
    readonly pendingElsewhere?: () => boolean;
    /** Whether an alert may take the screen now: not during playback, Settings or another menu. A refused alert waits. */
    readonly canAlert?: () => boolean;
}

type Row = { readonly key: string; readonly label: string; readonly icon: keyof typeof ICONS; readonly destructive?: boolean; readonly change?: boolean; readonly run: () => void };

const UPDATE_FAILED_TITLE = "Couldn’t Update Item";
const UPDATE_FAILED_MESSAGE = "The item could not be updated. Try again.";

/** SF Symbols the menu draws, on a 24 point grid. */
const ICONS = {
    "play.fill": '<path d="M7 4.5v15l12.5-7.5Z" fill="currentColor"/>',
    "checkmark.circle": '<circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m7.8 12.3 2.9 2.9 5.6-6.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    "circle": '<circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    "heart": '<path d="M12 20.3S3.5 15.1 3.5 9.1A4.6 4.6 0 0 1 12 6.6a4.6 4.6 0 0 1 8.5 2.5c0 6-8.5 11.2-8.5 11.2Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
    "heart.slash": '<path d="M12 20.3S3.5 15.1 3.5 9.1A4.6 4.6 0 0 1 12 6.6a4.6 4.6 0 0 1 8.5 2.5c0 6-8.5 11.2-8.5 11.2Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m3.5 3.5 17 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    "bookmark": '<path d="M6.5 3.5h11v17L12 16.6l-5.5 3.9Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
    "bookmark.slash": '<path d="M6.5 3.5h11v17L12 16.6l-5.5 3.9Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m3.5 3.5 17 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    "info.circle": '<circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 11v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.25" fill="currentColor"/>',
    "xmark.circle": '<circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m8.6 8.6 6.8 6.8m0-6.8-6.8 6.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
} as const;

/**
 * Apple's context-menu preview, measured on the live tvOS Continue Watching capture (1920x1080, Spidey S01E25): the
 * 360 x 200 art at rest at (80, 673) is drawn at (86, 663), 396 x 220, while the menu is open. That is a 1.1 scale about
 * the art's centre, then a shift right of 24 px, a fifteenth of the art's width. browse.css draws the same transform.
 */
export const MENU_LIFT_SCALE = 1.1;
export const MENU_LIFT_SHIFT = 1 / 15;
/** The class that lifts the anchor card's art while its menu is open. */
export const MENU_LIFTED_CLASS = "card-menu-lifted";
/** The platter's rim sits 27 px right of the lifted art (art right 482, platter 509 on the same capture). */
const MENU_GAP = 27;
/** The safe area the menu stays inside. */
const MENU_MARGIN = 60;

export class CardActions {
    private panel: HTMLElement | undefined;
    private rows: HTMLButtonElement[] = [];
    private listening = false;
    /** The card drawn lifted while its menu is open, and its art's rest box measured before the lift. */
    private lifted: { readonly card: HTMLElement; readonly rest: Box } | undefined;
    /** A failure that arrived while the alert could not show; it shows once the screen is free. */
    private deferredAlert = false;
    private reading: AbortController | undefined;
    /** The open menu, so a change landing behind it can redraw its rows. */
    private shown: { readonly card: MenuCard; readonly options: CardMenuOptions; readonly anchor: HTMLElement | undefined; readonly source: MenuCard } | undefined;
    /**
     * Changes the server accepted, keyed by the row's own card object. Until a reread replaces that object, reopening
     * its menu shows the accepted state rather than the row's stale one; fresh rows bring the server's state instead.
     */
    private readonly accepted = new WeakMap<MenuCard, Pick<MenuCard, "played" | "favorite" | "watchlist">>();
    private readonly writes = new Map<string, AbortController>();
    private readonly container: HTMLElement;
    private readonly session: NativeSession;
    private readonly host: CardActionsHost;
    private readonly stopAuthority: () => void;

    constructor(container: HTMLElement, session: NativeSession, host: CardActionsHost) {
        this.container = container;
        this.session = session;
        this.host = host;
        // A change sent for one profile must not land on, or alert over, the next.
        this.stopAuthority = session.onAuthorityChange(() => {
            this.abortAll();
            if (this.active) this.close();
        });
    }

    get active(): boolean { return this.panel !== undefined || this.reading !== undefined; }
    /** A change is still on its way; Details keeps its own personal writes locked meanwhile. */
    get pending(): boolean { return this.writes.size > 0; }

    open(card: MenuCard, options: CardMenuOptions = {}): void {
        if (this.active) return;
        const anchor = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
        const known = card.played !== undefined && card.favorite !== undefined && card.watchlist !== undefined;
        const source = card;
        card = { ...card, ...this.accepted.get(source) };
        if (known || options.home === true) { this.show(card, options, anchor, source); return; }
        // Seasons, episode rails and the calendar hold no list membership; read it once, then open complete.
        const controller = new AbortController();
        this.reading = controller;
        this.capture();
        // Focus leaves the card while the read runs, so a fresh Select cannot activate the card underneath.
        const sink = el("div", "card-actions-scrim card-menu-loading");
        sink.tabIndex = -1;
        sink.setAttribute("aria-busy", "true");
        sink.setAttribute("aria-label", card.title);
        this.panel = sink;
        this.container.appendChild(sink);
        sink.focus({ preventScroll: true });
        const settle = (): void => {
            this.reading = undefined;
            sink.remove();
            if (this.panel === sink) this.panel = undefined;
            this.release();
        };
        this.session.call({ ...operations.getCatalogItem(card.id), profileScoped: true, signal: controller.signal }).then(detail => {
            if (this.reading !== controller) return;
            settle();
            if (detail.id !== card.id || detail.type !== card.type) { this.alert(); return; }
            this.show({ ...card, played: detail.played, favorite: detail.favorite, watchlist: detail.watchlist }, options, anchor, source);
        }, () => {
            if (this.reading !== controller) return;
            settle();
            this.alert();
        });
    }

    private show(card: MenuCard, options: CardMenuOptions, anchor: HTMLElement | undefined, source: MenuCard): void {
        const rows = this.menuRows(card, options, source);
        // Apple attaches no menu to a card without actions.
        if (rows.length === 0) { this.host.closed(); return; }
        const busy = this.writes.has(card.id) || this.host.pendingElsewhere?.() === true;
        const scrim = el("div", "card-actions-scrim card-menu-scrim");
        for (const type of ["click", "contextmenu"]) scrim.addEventListener(type, event => {
            if (event.target !== scrim) return;
            event.preventDefault();
            event.stopPropagation();
            this.close();
        });
        const menu = el("div", "card-menu");
        menu.setAttribute("role", "menu");
        menu.setAttribute("aria-label", card.title);
        this.rows = rows.map(row => {
            const button = el("button", row.destructive === true ? "card-menu-row card-menu-destructive" : "card-menu-row");
            button.type = "button";
            button.tabIndex = -1;
            button.setAttribute("role", "menuitem");
            button.setAttribute("data-focus", row.key);
            if (busy && row.change === true) button.setAttribute("aria-disabled", "true");
            const icon = el("span", "card-menu-icon");
            icon.setAttribute("aria-hidden", "true");
            icon.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[row.icon]}</svg>`;
            button.append(menuLabel(row.label), icon);
            button.addEventListener("click", () => {
                if (button.getAttribute("aria-disabled") === "true") return;
                this.close();
                row.run();
            });
            return button;
        });
        menu.append(...this.rows);
        scrim.append(menu);
        if (this.panel === undefined) this.capture();
        this.panel = scrim;
        this.shown = { card, options, anchor, source };
        this.container.appendChild(scrim);
        // A redraw keeps the rest box measured before the lift; the lifted art would measure moved.
        const rest = this.lifted !== undefined && this.lifted.card === anchor ? this.lifted.rest : restArt(anchor);
        place(menu, anchor, rest);
        if (rest !== undefined && anchor !== undefined) { anchor.classList.add(MENU_LIFTED_CLASS); this.lifted = { card: anchor, rest }; }
        this.rows[0]?.focus({ preventScroll: true });
    }

    /** Something the rows depend on changed, such as a Details change finishing: redraw the open menu. */
    refresh(): void {
        if (this.shown !== undefined && this.panel !== undefined) this.redraw(this.shown.card);
    }

    /** Shows a failure alert that had to wait, once nothing else owns the screen. */
    showDeferredAlert(): void {
        if (!this.deferredAlert || this.active || this.host.canAlert?.() === false) return;
        this.deferredAlert = false;
        this.alert();
    }

    /** A change for the open menu's card landed: show its new state with the rows enabled, keeping the focused row. */
    private redraw(next: MenuCard | undefined): void {
        const shown = this.shown;
        if (shown === undefined) return;
        if (next === undefined) {
            this.close();
            return;
        }
        const focused = document.activeElement?.getAttribute("data-focus");
        const press = heldSelect();
        const held = press !== undefined && press.element === document.activeElement ? press : undefined;
        this.panel?.remove();
        this.panel = undefined;
        this.show(next, shown.options, shown.anchor, shown.source);
        const kept = this.rows.find(row => row.getAttribute("data-focus") === focused);
        kept?.focus({ preventScroll: true });
        // A held Select stays with its row through the redraw, unless the redrawn row is disabled.
        if (held !== undefined && kept !== undefined) moveSelect(held, kept);
    }

    private menuRows(card: MenuCard, options: CardMenuOptions, source: MenuCard): Row[] {
        const rows: Row[] = [];
        // TVSeriesDetailView.swift:632-643: a season pill's menu holds only Mark Season Watched or Unwatched.
        if (card.seasonPill === true) {
            if (card.played === undefined) return rows;
            const watched = card.played;
            rows.push({ change: true, key: "watched", label: watched ? "Mark Season Unwatched" : "Mark Season Watched", icon: watched ? "circle" : "checkmark.circle", run: () => this.send(card.id, detailOperations.setPersonal("watched", card.id, !watched), menu => ({ ...menu, played: !watched }), source) });
            return rows;
        }
        const play = options.play;
        if (play !== undefined) rows.push({ key: "card-play", label: (card.positionSeconds ?? 0) > 0 ? "Resume" : "Play", icon: "play.fill", run: play });
        // MediaCard's contextDetail slot, after Play.
        const information = this.host.information;
        if (information !== undefined && card.type === "episode" && options.home !== true) rows.push({ key: "episode-information", label: "Episode information", icon: "info.circle", run: () => information(card) });
        // MediaCard.canSetWatched: Home's handler, or a card with user state that is not a square audiobook cover.
        if (options.home === true || (card.played !== undefined && card.type !== "audiobook")) {
            const watched = card.played === true;
            rows.push({ change: true, key: "watched", label: watched ? "Mark as Unwatched" : "Mark as Watched", icon: watched ? "circle" : "checkmark.circle", run: () => this.send(card.id, detailOperations.setPersonal("watched", card.id, !watched), menu => ({ ...menu, played: !watched }), source) });
        }
        if (card.favorite !== undefined) {
            const favorite = card.favorite;
            rows.push({ change: true, key: "favorites", label: favorite ? "Remove from Favorites" : "Add to Favorites", icon: favorite ? "heart.slash" : "heart", run: () => this.send(card.id, detailOperations.setPersonal("favorites", card.id, !favorite), menu => ({ ...menu, favorite: !favorite }), source) });
        }
        if (card.watchlist !== undefined) {
            const watchlist = card.watchlist;
            rows.push({ change: true, key: "watchlist", label: watchlist ? "Remove from Watchlist" : "Add to Watchlist", icon: watchlist ? "bookmark.slash" : "bookmark", run: () => this.send(card.id, detailOperations.setPersonal("watchlist", card.id, !watchlist), menu => ({ ...menu, watchlist: !watchlist }), source) });
        }
        const dismissal = options.dismissal;
        if (dismissal !== undefined) {
            rows.push({ change: true, key: "remove", label: dismissal.surface === "next_up" ? "Remove from Next Up" : "Remove from Continue Watching", icon: "xmark.circle", destructive: true, run: () => this.send(card.id, detailOperations.dismissHomeItem(card.id, dismissal), () => undefined, source, () => this.host.dismissed?.(card)) });
        }
        return rows;
    }

    /** `landed` gives the card's state after the change, or undefined when the card leaves its row. */
    private send(id: string, spec: ReturnType<typeof detailOperations.setPersonal>, landed: (card: MenuCard) => MenuCard | undefined, source: MenuCard, accepted?: () => void): void {
        // HomeViewModel.pendingWatchedUpdates: one change per card at a time, and none beside a pending Details change.
        if (this.writes.has(id) || this.host.pendingElsewhere?.() === true) return;
        const controller = new AbortController();
        this.writes.set(id, controller);
        this.session.call({ ...spec, profileScoped: true, replayAfterRefresh: false, signal: controller.signal }).then(() => {
            if (this.writes.get(id) !== controller) return;
            this.writes.delete(id);
            accepted?.();
            const now = landed({ ...source, ...this.accepted.get(source) });
            if (now !== undefined) this.accepted.set(source, { played: now.played, favorite: now.favorite, watchlist: now.watchlist });
            const shown = this.shown;
            if (shown !== undefined && shown.card.id === id) this.redraw(landed(shown.card));
            this.host.applied(id, spec.path.startsWith("/watched/"));
        }, () => {
            if (this.writes.get(id) !== controller) return;
            this.writes.delete(id);
            if (this.shown?.card.id === id) this.redraw(this.shown.card);
            this.alert();
            // Even a lost answer may have landed; reread once the alert closes so the rows show what the server holds.
            this.host.applied(id, false);
        });
    }

    /** HomeView's `.alert`: the shared centred alert over the screen, with one OK. */
    private alert(): void {
        // A reopened menu keeps its focus and Resume action until it closes.
        if (this.shown !== undefined || this.host.canAlert?.() === false) { this.deferredAlert = true; return; }
        if (this.active) this.dismiss();
        const ok = el("button", "card-alert-button", "OK");
        ok.type = "button";
        ok.setAttribute("data-focus", "card-alert-ok");
        ok.addEventListener("click", () => this.close());
        const scrim = el("div", "card-actions-scrim card-alert-scrim");
        scrim.append(...centredDialog({ style: "alert", id: "card-update-failed", title: UPDATE_FAILED_TITLE, message: UPDATE_FAILED_MESSAGE, buttons: [ok], behind: [] }));
        this.capture();
        this.panel = scrim;
        this.shown = undefined;
        this.rows = [ok];
        this.container.appendChild(scrim);
        ok.focus({ preventScroll: true });
    }

    close(): void {
        const shown = this.active;
        this.dismiss();
        if (shown) this.host.closed();
    }

    private dismiss(): void {
        this.lifted?.card.classList.remove(MENU_LIFTED_CLASS);
        this.lifted = undefined;
        this.reading?.abort();
        this.reading = undefined;
        this.rows = [];
        this.shown = undefined;
        this.panel?.remove();
        this.panel = undefined;
        this.release();
    }

    private capture(): void {
        if (this.listening) return;
        this.listening = true;
        listenSelectRelease();
        this.host.opened();
        document.addEventListener("keydown", this.onKey, true);
        document.addEventListener("keyup", this.onRelease, true);
    }

    private release(): void {
        if (!this.listening) return;
        this.listening = false;
        // Select may still be down; the rest of that press must not reach what takes focus next.
        swallowSelect();
        document.removeEventListener("keydown", this.onKey, true);
        document.removeEventListener("keyup", this.onRelease, true);
    }

    private abortAll(): void {
        this.deferredAlert = false;
        for (const controller of this.writes.values()) controller.abort();
        this.writes.clear();
    }

    destroy(): void {
        this.abortAll();
        this.dismiss();
        this.stopAuthority();
    }

    private readonly onRelease = (event: KeyboardEvent): void => {
        if (remoteKey(event) !== "enter") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        // The shared Select release names the row the press was made on, enabled and focused throughout; anything else runs nothing.
        const chosen = releasedSelect();
        if (chosen !== undefined && chosen === document.activeElement && this.rows.some(row => row === chosen)) chosen.click();
    };

    private readonly onKey = (event: KeyboardEvent): void => {
        const key = remoteKey(event);
        if (key === undefined && event.key !== "Tab") return;
        event.stopImmediatePropagation();
        event.preventDefault();
        if (key === "back") { this.close(); return; }
        if (this.panel === undefined) return;
        // The tvOS menu is a single column: Left and Right stay put.
        if (key === "up" || key === "down" || event.key === "Tab") {
            const index = this.rows.findIndex(row => row === document.activeElement);
            const step = key === "up" || event.shiftKey ? -1 : 1;
            this.rows[Math.max(0, Math.min(this.rows.length - 1, index + step))]?.focus({ preventScroll: true });
        }
        // Enter waits for its release (onRelease); the long press that opened the menu never names a row.
    };
}

/**
 * A row's label. tvOS balances a two-line label ("Remove from / Continue Watching"); Chromium 108 has no
 * `text-wrap: balance`, so the last two words stay together, which gives the same break for Apple's labels.
 */
function menuLabel(text: string): HTMLElement {
    const label = el("span", "card-menu-label");
    const words = text.split(" ");
    if (words.length < 3) { label.textContent = text; return label; }
    label.append(`${words.slice(0, -2).join(" ")} `, el("span", "card-menu-keep", words.slice(-2).join(" ")));
    return label;
}

/** The tvOS menu opens beside the focused card, inside the safe area. */
export interface Box { readonly left: number; readonly top: number; readonly width: number; readonly height: number }

/** Where the art is drawn while lifted, from its rest box. */
export function liftedArt(art: Box): Box {
    const width = art.width * MENU_LIFT_SCALE, height = art.height * MENU_LIFT_SCALE;
    return { left: art.left + (art.width - width) / 2 + art.width * MENU_LIFT_SHIFT, top: art.top + (art.height - height) / 2, width, height };
}

/**
 * The platter's top-left: beside the lifted art (or the card, when it has none), centred on the card's button raised
 * by the lift, as Apple's platter centre is the button centre less the art's 10 px rise. Kept inside the safe area.
 */
export function menuPosition(card: Box, art: Box | undefined, menu: { readonly width: number; readonly height: number }, viewport: { readonly width: number; readonly height: number }): { left: number; top: number } {
    const lifted = art === undefined ? card : liftedArt(art);
    const rise = art === undefined ? 0 : art.top - lifted.top;
    const right = lifted.left + lifted.width + MENU_GAP;
    const left = right + menu.width <= viewport.width - MENU_MARGIN ? right : Math.max(MENU_MARGIN, lifted.left - MENU_GAP - menu.width);
    const centre = card.top + card.height / 2 - rise;
    const top = Math.max(MENU_MARGIN, Math.min(viewport.height - MENU_MARGIN - menu.height, centre - menu.height / 2));
    return { left: Math.round(left), top: Math.round(top) };
}

/** The anchor card's art at rest: its layout size about its drawn centre, which the focus scale does not move. */
function restArt(anchor: HTMLElement | undefined): Box | undefined {
    const art = anchor?.querySelector(".browse-art");
    if (!(art instanceof HTMLElement) || art.offsetWidth === 0) return undefined;
    const drawn = art.getBoundingClientRect();
    return { left: drawn.left + drawn.width / 2 - art.offsetWidth / 2, top: drawn.top + drawn.height / 2 - art.offsetHeight / 2, width: art.offsetWidth, height: art.offsetHeight };
}

function place(menu: HTMLElement, anchor: HTMLElement | undefined, rest: Box | undefined): void {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const size = { width: menu.offsetWidth, height: menu.offsetHeight };
    const rect = anchor?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) {
        menu.style.left = `${Math.round((viewport.width - size.width) / 2)}px`;
        menu.style.top = `${Math.round((viewport.height - size.height) / 2)}px`;
        return;
    }
    const position = menuPosition({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }, rest, size, viewport);
    menu.style.left = `${position.left}px`;
    menu.style.top = `${position.top}px`;
}
