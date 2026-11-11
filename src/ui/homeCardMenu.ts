// The long-press menu on a Home card: Apple TV's native `.contextMenu` on MediaCard and EpisodeThumbCard
// (silo-apple Components/MediaCard.swift contextActions, EpisodeThumbCard.swift contextActions,
// MediaStateMenuItems.swift). It opens at once from the row's data, with no title, loading or retry rows, and
// closes when a row is chosen. A failed change shows Apple's alert in the shared centred dialog.

import { detailOperations, type PersonalAction } from "../api/detailOperations.ts";
import { operations, type HomeDismissal } from "../api/operations.ts";
import type { Card, HomeSection } from "../contracts/v2/catalog.ts";
import type { NativeSession } from "../session/session.ts";
import type { FocusItem, FocusTarget } from "./browseFocus.ts";
import { actionButton } from "./browseViews.ts";
import { centredDialog } from "./confirmationDialog.ts";
import { remoteKey } from "./keys.ts";
import { navigationIcon } from "./navigationIcon.ts";
import { el } from "./screen.ts";

export interface HomeCardMenuRequest {
    readonly card: Card;
    /** The card the menu is drawn beside. */
    readonly anchor: HTMLElement;
    /** Continue Watching only: Apple's Play or Resume row. */
    readonly play?: () => void;
    /** Continue Watching and Next Up cards the server can dismiss. */
    readonly dismissal?: HomeDismissal;
}

export type HomeCardChange =
    | { readonly kind: PersonalAction; readonly card: Card; readonly value: boolean }
    | { readonly kind: "dismissed"; readonly card: Card }
    /** A failed write may still have landed; Home reads again instead of trusting its rows. */
    | { readonly kind: "unconfirmed"; readonly card: Card };

interface Failure { readonly title: string; readonly message: string }

// HomeView.swift's alert for Home's watched and removal handlers (home.updateFailed.*).
const HOME_FAILURE: Failure = { title: "Couldn’t Update Item", message: "The item could not be updated. Try again." };
// PersonalStateNotice.failed(nil), which MediaActionFeedback shows for a card's favorite and watchlist toggles.
const PERSONAL_FAILURE: Failure = { title: "Couldn't Update Item", message: "Your change wasn't saved. Please try again." };
/** The menu keeps this far from the screen edge and the card. */
const SCREEN_INSET = 48;
const ANCHOR_GAP = 24;

const PLAYBACK_SECTION_TYPES = new Set(["continue_watching", "in_progress", "next_up"]);

/**
 * HomeSectionsMutation: a completed card leaves the rows built from playback state; a dismissal drops its whole
 * show from them, since the server drops the series. Rows left empty go.
 */
export function withoutPlaybackCards(sections: readonly HomeSection[], card: Pick<Card, "id" | "type" | "seriesId">, dismissed: boolean): HomeSection[] {
    const series = !dismissed ? undefined : card.type === "series" ? card.id : card.type === "episode" && card.seriesId !== undefined && card.seriesId !== "" ? card.seriesId : undefined;
    return sections
        .map(section => !PLAYBACK_SECTION_TYPES.has(section.sectionType.toLowerCase()) ? section
            : { ...section, items: section.items.filter(item => item.id !== card.id && (series === undefined || (item.id !== series && item.seriesId !== series))) })
        .filter(section => section.items.length > 0);
}

type Override = { -readonly [K in "played" | "favorite" | "inWatchlist"]?: boolean };

export class HomeCardMenu {
    private panel: HTMLElement | undefined;
    private alert: HTMLElement[] = [];
    /** Where focus was when the alert opened; the menu has closed by then. */
    private returnFocus: FocusTarget | undefined;
    /** A failure that arrived while a menu was open waits for it to close. */
    private queued: Failure | undefined;
    private items: FocusItem[] = [];
    private pressed = false;
    /** Apple MediaCardPersonalState: the value shown for a change until Home's rows are read again. */
    private readonly overrides = new Map<string, Override>();
    /** MediaStateMenuItems.isUpdating disables the state rows; Remove has its own guard. */
    private readonly writing = new Set<string>();
    private readonly dismissing = new Set<string>();
    /** The open menu's request, rebuilt when its card's change finishes. */
    private request: HomeCardMenuRequest | undefined;
    /** Counts settled changes, so a Home read that began before one cannot retire its override. */
    private epoch = 0;
    private readonly settledAt = new Map<string, number>();
    /** Swallows a chosen row's Select until it is released, ahead of FocusHost's hold detection. */
    private latch: (() => void) | undefined;
    private torn = false;

    /** Browse's FocusHost replaces its container's children on every render, so the menu and alert sit beside it. */
    private readonly container: HTMLElement;
    private readonly session: NativeSession;
    private readonly applied: (change: HomeCardChange) => void;
    /** The menu or alert went away; focus returns to `focus`, or to the card the menu opened on. */
    private readonly closed: (focus?: FocusTarget) => void;
    private readonly focused: () => FocusTarget | undefined;
    /** False once Home is no longer the screen a failure would be reported on. */
    private readonly onHome: () => boolean;

    constructor(container: HTMLElement, session: NativeSession, applied: (change: HomeCardChange) => void, closed: (focus?: FocusTarget) => void, focused: () => FocusTarget | undefined, onHome: () => boolean) {
        this.container = container;
        this.session = session;
        this.applied = applied;
        this.closed = closed;
        this.focused = focused;
        this.onHome = onHome;
    }

    get active(): boolean { return this.panel !== undefined || this.alert.length > 0; }
    get pending(): boolean { return this.writing.size > 0 || this.dismissing.size > 0; }
    /** Pass to `refreshed` from a Home read that starts now. */
    get readEpoch(): number { return this.epoch; }
    private get menuCard(): string | undefined { return this.request?.card.id; }

    private get layer(): HTMLElement { return this.container.parentElement ?? this.container; }

    open(request: HomeCardMenuRequest): void {
        if (this.active || this.torn) return;
        this.request = request;
        const items = this.rows(request);
        if (items.length === 0) { this.request = undefined; return; }
        this.items = items;
        const panel = el("div", "skyline-selector card-menu");
        panel.setAttribute("role", "menu");
        panel.setAttribute("aria-label", request.card.title);
        panel.append(...items.map(item => item.element));
        this.panel = panel;
        this.layer.appendChild(panel);
        this.place(panel, request.anchor);
        this.listen(true);
        items[0]?.element.focus({ preventScroll: true });
    }

    /** Home's rows were read again: server values replace every override settled before that read began. */
    refreshed(readEpoch: number): void {
        for (const id of [...this.overrides.keys()]) {
            const settled = this.settledAt.get(id);
            if (this.writing.has(id) || settled === undefined || settled > readEpoch) continue;
            this.overrides.delete(id);
            this.settledAt.delete(id);
        }
    }

    destroy(): void {
        this.torn = true;
        this.latch?.();
        this.queued = undefined;
        this.dismiss();
        this.dismissAlert();
    }

    /** Apple's row order: Play or Resume, the watched, favorite and watchlist rows, then the destructive Remove. */
    private rows(request: HomeCardMenuRequest): FocusItem[] {
        const { card } = request;
        const state = this.state(card);
        const items: FocusItem[] = [];
        const play = request.play;
        if (play !== undefined) items.push(this.row("card-play", (card.positionSeconds ?? 0) > 0 ? "Resume" : "Play", "play.fill", () => play()));
        // Home passes its watched handler to every card, square audiobooks included (MediaCard.canSetWatched).
        items.push(this.row("watched", state.played ? "Mark as Unwatched" : "Mark as Watched", state.played ? "circle" : "checkmark.circle", () => this.write(card, "watched", !state.played), "state"));
        // Favorites and watchlist need the server's user state for the card (MediaCard.hasPersonalActions).
        if (state.favorite !== undefined && state.inWatchlist !== undefined) {
            const favorite = state.favorite;
            const inWatchlist = state.inWatchlist;
            items.push(this.row("favorites", favorite ? "Remove from Favorites" : "Add to Favorites", favorite ? "heart.slash" : "heart", () => this.write(card, "favorites", !favorite), "state"));
            items.push(this.row("watchlist", inWatchlist ? "Remove from Watchlist" : "Add to Watchlist", inWatchlist ? "bookmark.slash" : "bookmark", () => this.write(card, "watchlist", !inWatchlist), "state"));
        }
        const dismissal = request.dismissal;
        if (dismissal !== undefined) {
            // HomeDismissal.menuTitle: the label names the list the card leaves.
            const remove = this.row("remove", dismissal.surface === "next_up" ? "Remove from Next Up" : "Remove from Continue Watching", "xmark.circle", () => this.dismissCard(card, dismissal), "remove");
            remove.element.classList.add("skyline-destructive");
            items.push(remove);
        }
        return items;
    }

    /** `guard` names the in-flight set that disables the row; it is read live, so a finished change re-enables an open menu. */
    private row(key: string, label: string, icon: string, action: () => void, guard?: "state" | "remove"): FocusItem {
        const item = actionButton(key, label, () => {
            if (item.element.getAttribute("aria-disabled") === "true") return;
            this.choose();
            action();
        });
        item.element.classList.add("skyline-menu-item");
        item.element.setAttribute("role", "menuitem");
        item.element.replaceChildren(navigationIcon(icon), el("span", "skyline-menu-label", label));
        item.element.dataset.symbol = icon;
        if (guard !== undefined) item.element.dataset.guard = guard;
        this.guard(item.element);
        return item;
    }

    private guard(element: HTMLElement): void {
        const id = this.menuCard;
        const busy = id !== undefined && (element.dataset.guard === "state" ? this.writing.has(id) : element.dataset.guard === "remove" ? this.dismissing.has(id) : false);
        if (busy) element.setAttribute("aria-disabled", "true");
        else element.removeAttribute("aria-disabled");
    }

    /** A change finished: an open menu on that card is rebuilt from the settled values, keeping its focused row. */
    private settle(id: string): void {
        const panel = this.panel;
        const request = this.request;
        if (panel === undefined || request === undefined) return;
        if (request.card.id !== id) { for (const item of this.items) this.guard(item.element); return; }
        const focused = this.items.find(item => item.element === document.activeElement)?.key;
        this.items = this.rows(request);
        panel.replaceChildren(...this.items.map(item => item.element));
        (this.items.find(item => item.key === focused) ?? this.items[0])?.element.focus({ preventScroll: true });
    }

    private state(card: Card): { played: boolean; favorite: boolean | undefined; inWatchlist: boolean | undefined } {
        const current = this.overrides.get(card.id);
        return { played: current?.played ?? card.played ?? false, favorite: current?.favorite ?? card.favorite, inWatchlist: current?.inWatchlist ?? card.inWatchlist };
    }

    private write(card: Card, kind: PersonalAction, value: boolean): void {
        if (this.writing.has(card.id)) return;
        const field = kind === "watched" ? "played" : kind === "favorites" ? "favorite" : "inWatchlist";
        const override = this.overrides.get(card.id) ?? {};
        const previous = override[field];
        override[field] = value;
        this.overrides.set(card.id, override);
        this.writing.add(card.id);
        this.session.call({ ...detailOperations.setPersonal(kind, card.id, value), profileScoped: true, replayAfterRefresh: false }).then(() => {
            this.writing.delete(card.id);
            this.settledAt.set(card.id, ++this.epoch);
            this.settle(card.id);
            if (!this.torn) this.applied({ kind, card, value });
        }, () => {
            this.writing.delete(card.id);
            if (previous === undefined) delete override[field];
            else override[field] = previous;
            this.settle(card.id);
            if (!this.torn) this.applied({ kind: "unconfirmed", card });
            this.fail(kind === "watched" ? HOME_FAILURE : PERSONAL_FAILURE);
        });
    }

    private dismissCard(card: Card, dismissal: HomeDismissal): void {
        if (this.dismissing.has(card.id)) return;
        this.dismissing.add(card.id);
        this.session.call({ ...operations.dismissHomeItem(dismissal, card.id), profileScoped: true, replayAfterRefresh: false }).then(() => {
            this.dismissing.delete(card.id);
            this.settle(card.id);
            if (!this.torn) this.applied({ kind: "dismissed", card });
        }, () => {
            this.dismissing.delete(card.id);
            this.settle(card.id);
            if (!this.torn) this.applied({ kind: "unconfirmed", card });
            this.fail(HOME_FAILURE);
        });
    }

    /** Apple's `.alert`: title, message and OK, over the dimmed screen. */
    private fail(failure: Failure): void {
        if (this.torn || !this.onHome()) return;
        if (this.active) {
            if (this.alert.length === 0) this.queued ??= failure;
            return;
        }
        this.returnFocus = this.focused();
        const ok = actionButton("alert-ok", "OK", () => this.closeAlert());
        this.items = [ok];
        const nodes = centredDialog({ style: "alert", id: "home-update-failed", title: failure.title, message: failure.message, buttons: [ok.element], behind: [] });
        for (const node of nodes) node.classList.add("home-card-alert");
        // Dim the screen without the shared dialog's clean-up of the nodes it covers, which browse still owns and redraws.
        this.container.inert = true;
        this.container.classList.add("home-card-alert-open");
        this.alert = nodes;
        this.layer.append(...nodes);
        this.listen(true);
        ok.element.focus({ preventScroll: true });
    }

    private closeAlert(): void {
        const target = this.returnFocus;
        this.dismissAlert();
        // Draws Home again, so a change that landed while the alert was up shows.
        this.closed(target);
    }

    private dismissAlert(): void {
        this.container.inert = false;
        this.container.classList.remove("home-card-alert-open");
        this.returnFocus = undefined;
        for (const node of this.alert) node.remove();
        this.alert = [];
        if (this.panel === undefined) this.release();
    }

    /** A chosen row closes the menu before its action runs, as a tvOS context menu does. */
    private choose(): void {
        this.close();
    }

    private close(): void {
        this.dismiss();
        this.closed();
        const queued = this.queued;
        this.queued = undefined;
        if (queued !== undefined) this.fail(queued);
    }

    private dismiss(): void {
        this.panel?.remove();
        this.panel = undefined;
        this.request = undefined;
        if (this.alert.length === 0) this.release();
    }

    private release(): void {
        if (this.pressed) this.hold();
        this.items = [];
        this.pressed = false;
        this.listen(false);
    }

    /** The Select that chose a row is still down: its repeats and release must not reach the card underneath. */
    private hold(): void {
        this.latch?.();
        const swallow = (event: KeyboardEvent): void => {
            if (remoteKey(event) !== "enter") return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (event.type === "keyup") this.latch?.();
        };
        window.addEventListener("keydown", swallow, true);
        window.addEventListener("keyup", swallow, true);
        this.latch = () => {
            window.removeEventListener("keydown", swallow, true);
            window.removeEventListener("keyup", swallow, true);
            this.latch = undefined;
        };
    }

    private listen(on: boolean): void {
        document.removeEventListener("keydown", this.onKey, true);
        document.removeEventListener("keyup", this.onRelease, true);
        if (!on) return;
        document.addEventListener("keydown", this.onKey, true);
        document.addEventListener("keyup", this.onRelease, true);
    }

    /** Beside the card, as the tvOS menu sits: right of it when it fits, otherwise left, kept on screen. */
    private place(panel: HTMLElement, anchor: HTMLElement): void {
        const card = anchor.getBoundingClientRect();
        const width = panel.offsetWidth;
        const height = panel.offsetHeight;
        const right = card.right + ANCHOR_GAP;
        const left = right + width <= window.innerWidth - SCREEN_INSET ? right : Math.max(SCREEN_INSET, card.left - ANCHOR_GAP - width);
        const top = Math.max(SCREEN_INSET, Math.min(card.top, window.innerHeight - SCREEN_INSET - height));
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
    }

    private readonly onRelease = (event: KeyboardEvent): void => {
        if (remoteKey(event) !== "enter") return;
        this.pressed = false;
        event.preventDefault();
        event.stopImmediatePropagation();
    };

    private readonly onKey = (event: KeyboardEvent): void => {
        if (!this.active) return;
        const key = remoteKey(event);
        if (key === undefined && event.key !== "Tab") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (key === "back") {
            if (this.alert.length > 0) this.closeAlert();
            else this.close();
        } else if (this.alert.length > 0) {
            if (key === "enter" && !this.pressed) { this.pressed = true; this.closeAlert(); }
            else this.items[0]?.element.focus({ preventScroll: true });
        } else if (key === "up" || key === "down" || event.key === "Tab") {
            // The tvOS menu is a single column: Left and Right do nothing.
            const index = this.items.findIndex(item => item.element === document.activeElement);
            const step = key === "up" || event.shiftKey ? -1 : 1;
            this.items[Math.max(0, Math.min(this.items.length - 1, index + step))]?.element.focus({ preventScroll: true });
        } else if (key === "enter") {
            if (this.pressed) return;
            this.pressed = true;
            this.items.find(item => item.element === document.activeElement)?.element.click();
        }
    };
}
