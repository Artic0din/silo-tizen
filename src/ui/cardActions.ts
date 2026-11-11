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

/** What the opener knows about the card. A field it does not know is read from the item before the menu opens. */
export type MenuCard = Pick<Card, "id" | "title" | "type"> & Partial<Pick<Card, "played" | "favorite" | "watchlist" | "positionSeconds" | "seriesId">>;

export interface CardMenuOptions {
    /** Continue Watching's Play or Resume row (MediaRow.showsPlayInContextMenu). */
    readonly play?: (() => void) | undefined;
    /** Home's Continue Watching and Next Up rows offer Remove (SectionRow.offersHomeDismissal). */
    readonly dismissal?: HomeDismissal | undefined;
    /** Home injects its watched handler into every row, so its cards always get the watched row. */
    readonly home?: boolean | undefined;
}

export interface CardActionsHost {
    /** A change was applied; reread what shows it. */
    readonly applied: (id: string) => void;
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

/** The gap between the focused card and the menu beside it. */
const MENU_GAP = 40;
/** The safe area the menu stays inside. */
const MENU_MARGIN = 60;

export class CardActions {
    private panel: HTMLElement | undefined;
    private rows: HTMLButtonElement[] = [];
    private pressed = false;
    private listening = false;
    /** A failure that arrived while the alert could not show; it shows once the screen is free. */
    private deferredAlert = false;
    private reading: AbortController | undefined;
    /** The open menu, so a change landing behind it can redraw its rows. */
    private shown: { readonly card: MenuCard; readonly options: CardMenuOptions; readonly anchor: HTMLElement | undefined } | undefined;
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
        if (known || options.home === true) { this.show(card, options, anchor); return; }
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
            this.show({ ...card, played: detail.played, favorite: detail.favorite, watchlist: detail.watchlist }, options, anchor);
        }, () => {
            if (this.reading !== controller) return;
            settle();
            this.alert();
        });
    }

    private show(card: MenuCard, options: CardMenuOptions, anchor: HTMLElement | undefined): void {
        const rows = this.menuRows(card, options);
        // Apple attaches no menu to a card without actions.
        if (rows.length === 0) { this.host.closed(); return; }
        const busy = this.writes.has(card.id) || this.host.pendingElsewhere?.() === true;
        const scrim = el("div", "card-actions-scrim card-menu-scrim");
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
            button.append(el("span", "card-menu-label", row.label), icon);
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
        this.shown = { card, options, anchor };
        this.container.appendChild(scrim);
        place(menu, anchor);
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
        if (next === undefined) { this.close(); return; }
        const focused = document.activeElement?.getAttribute("data-focus");
        this.panel?.remove();
        this.panel = undefined;
        this.show(next, shown.options, shown.anchor);
        this.rows.find(row => row.getAttribute("data-focus") === focused)?.focus({ preventScroll: true });
    }

    private menuRows(card: MenuCard, options: CardMenuOptions): Row[] {
        const rows: Row[] = [];
        const play = options.play;
        if (play !== undefined) rows.push({ key: "card-play", label: (card.positionSeconds ?? 0) > 0 ? "Resume" : "Play", icon: "play.fill", run: play });
        // MediaCard's contextDetail slot, after Play.
        const information = this.host.information;
        if (information !== undefined && card.type === "episode" && options.home !== true) rows.push({ key: "episode-information", label: "Episode information", icon: "info.circle", run: () => information(card) });
        // MediaCard.canSetWatched: Home's handler, or a card with user state that is not a square audiobook cover.
        if (options.home === true || (card.played !== undefined && card.type !== "audiobook")) {
            const watched = card.played === true;
            rows.push({ change: true, key: "watched", label: watched ? "Mark as Unwatched" : "Mark as Watched", icon: watched ? "circle" : "checkmark.circle", run: () => this.send(card.id, detailOperations.setPersonal("watched", card.id, !watched), menu => ({ ...menu, played: !watched })) });
        }
        if (card.favorite !== undefined) {
            const favorite = card.favorite;
            rows.push({ change: true, key: "favorites", label: favorite ? "Remove from Favorites" : "Add to Favorites", icon: favorite ? "heart.slash" : "heart", run: () => this.send(card.id, detailOperations.setPersonal("favorites", card.id, !favorite), menu => ({ ...menu, favorite: !favorite })) });
        }
        if (card.watchlist !== undefined) {
            const watchlist = card.watchlist;
            rows.push({ change: true, key: "watchlist", label: watchlist ? "Remove from Watchlist" : "Add to Watchlist", icon: watchlist ? "bookmark.slash" : "bookmark", run: () => this.send(card.id, detailOperations.setPersonal("watchlist", card.id, !watchlist), menu => ({ ...menu, watchlist: !watchlist })) });
        }
        const dismissal = options.dismissal;
        if (dismissal !== undefined) {
            rows.push({ change: true, key: "remove", label: dismissal.surface === "next_up" ? "Remove from Next Up" : "Remove from Continue Watching", icon: "xmark.circle", destructive: true, run: () => this.send(card.id, detailOperations.dismissHomeItem(card.id, dismissal), () => undefined, () => this.host.dismissed?.(card)) });
        }
        return rows;
    }

    /** `landed` gives the card's state after the change, or undefined when the card leaves its row. */
    private send(id: string, spec: ReturnType<typeof detailOperations.setPersonal>, landed: (card: MenuCard) => MenuCard | undefined, accepted?: () => void): void {
        // HomeViewModel.pendingWatchedUpdates: one change per card at a time, and none beside a pending Details change.
        if (this.writes.has(id) || this.host.pendingElsewhere?.() === true) return;
        const controller = new AbortController();
        this.writes.set(id, controller);
        this.session.call({ ...spec, profileScoped: true, replayAfterRefresh: false, signal: controller.signal }).then(() => {
            if (this.writes.get(id) !== controller) return;
            this.writes.delete(id);
            accepted?.();
            const shown = this.shown;
            if (shown !== undefined && shown.card.id === id) this.redraw(landed(shown.card));
            this.host.applied(id);
        }, () => {
            if (this.writes.get(id) !== controller) return;
            this.writes.delete(id);
            this.alert();
            // Even a lost answer may have landed; reread once the alert closes so the rows show what the server holds.
            this.host.applied(id);
        });
    }

    /** HomeView's `.alert`: the shared centred alert over the screen, with one OK. */
    private alert(): void {
        if (this.host.canAlert?.() === false) { this.deferredAlert = true; return; }
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
        this.pressed = false;
        this.host.opened();
        document.addEventListener("keydown", this.onKey, true);
        document.addEventListener("keyup", this.onRelease, true);
    }

    private release(): void {
        if (!this.listening) return;
        this.listening = false;
        this.pressed = false;
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
        if (remoteKey(event) === "enter") { this.pressed = false; event.preventDefault(); event.stopImmediatePropagation(); }
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
        } else if (key === "enter") {
            // Select is still held from the long press that opened the menu; only a fresh press chooses a row.
            if (this.pressed || event.repeat) return;
            this.pressed = true;
            this.rows.find(row => row === document.activeElement)?.click();
        }
    };
}

/** The tvOS menu opens beside the focused card, inside the safe area. */
function place(menu: HTMLElement, anchor: HTMLElement | undefined): void {
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const rect = anchor?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) {
        menu.style.left = `${Math.round((viewportWidth - width) / 2)}px`;
        menu.style.top = `${Math.round((viewportHeight - height) / 2)}px`;
        return;
    }
    const right = rect.right + MENU_GAP;
    const left = right + width <= viewportWidth - MENU_MARGIN ? right : Math.max(MENU_MARGIN, rect.left - MENU_GAP - width);
    const top = Math.max(MENU_MARGIN, Math.min(viewportHeight - MENU_MARGIN - height, rect.top));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
}
