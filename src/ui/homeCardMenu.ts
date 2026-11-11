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
    | { readonly kind: "dismissed"; readonly card: Card };

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

type Field = "played" | "favorite" | "inWatchlist";
/** The value shown while a change is on its way, and the row value it replaced. */
type Override = { -readonly [K in Field]?: { readonly value: boolean; readonly base: boolean | undefined } };

export class HomeCardMenu {
    private panel: HTMLElement | undefined;
    private alert: HTMLElement[] = [];
    /** Where focus was when the alert opened; the menu has closed by then. */
    private returnFocus: FocusTarget | undefined;
    /** A failure that arrived while a menu was open waits for it to close. */
    private queued: Failure | undefined;
    private items: FocusItem[] = [];
    private pressed = false;
    /** Apple MediaCardPersonalState: overrides last until the row's server value changes. */
    private readonly overrides = new Map<string, Override>();
    /** MediaStateMenuItems.isUpdating disables the state rows; Remove has its own guard. */
    private readonly writing = new Set<string>();
    private readonly dismissing = new Set<string>();
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

    private get layer(): HTMLElement { return this.container.parentElement ?? this.container; }

    open(request: HomeCardMenuRequest): void {
        if (this.active || this.torn) return;
        const items = this.rows(request);
        if (items.length === 0) return;
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

    destroy(): void {
        this.torn = true;
        this.queued = undefined;
        this.dismiss();
        this.dismissAlert();
    }

    /** Apple's row order: Play or Resume, the watched, favorite and watchlist rows, then the destructive Remove. */
    private rows(request: HomeCardMenuRequest): FocusItem[] {
        const { card } = request;
        const state = this.state(card);
        const busy = this.writing.has(card.id);
        const items: FocusItem[] = [];
        const play = request.play;
        if (play !== undefined) items.push(this.row("card-play", (card.positionSeconds ?? 0) > 0 ? "Resume" : "Play", "play.fill", () => play()));
        // Home passes its watched handler to every card, square audiobooks included (MediaCard.canSetWatched).
        items.push(this.row("watched", state.played ? "Mark as Unwatched" : "Mark as Watched", state.played ? "circle" : "checkmark.circle", () => this.write(card, "watched", !state.played), busy));
        // Favorites and watchlist need the server's user state for the card (MediaCard.hasPersonalActions).
        if (state.favorite !== undefined && state.inWatchlist !== undefined) {
            const favorite = state.favorite;
            const inWatchlist = state.inWatchlist;
            items.push(this.row("favorites", favorite ? "Remove from Favorites" : "Add to Favorites", favorite ? "heart.slash" : "heart", () => this.write(card, "favorites", !favorite), busy));
            items.push(this.row("watchlist", inWatchlist ? "Remove from Watchlist" : "Add to Watchlist", inWatchlist ? "bookmark.slash" : "bookmark", () => this.write(card, "watchlist", !inWatchlist), busy));
        }
        const dismissal = request.dismissal;
        if (dismissal !== undefined) {
            // HomeDismissal.menuTitle: the label names the list the card leaves.
            const remove = this.row("remove", dismissal.surface === "next_up" ? "Remove from Next Up" : "Remove from Continue Watching", "xmark.circle", () => this.dismissCard(card, dismissal), this.dismissing.has(card.id));
            remove.element.classList.add("skyline-destructive");
            items.push(remove);
        }
        return items;
    }

    private row(key: string, label: string, icon: string, action: () => void, disabled = false): FocusItem {
        const item = actionButton(key, label, () => {
            if (disabled) return;
            this.choose();
            action();
        });
        item.element.classList.add("skyline-menu-item");
        item.element.setAttribute("role", "menuitem");
        item.element.replaceChildren(navigationIcon(icon), el("span", "skyline-menu-label", label));
        item.element.dataset.symbol = icon;
        if (disabled) item.element.setAttribute("aria-disabled", "true");
        return item;
    }

    private state(card: Card): { played: boolean; favorite: boolean | undefined; inWatchlist: boolean | undefined } {
        const override = this.overrides.get(card.id);
        if (override !== undefined && !this.writing.has(card.id)) {
            // MediaCardPersonalState.reset: a new server value, ours or another device's, replaces the override.
            for (const field of ["played", "favorite", "inWatchlist"] as const) if (override[field] !== undefined && override[field].base !== card[field]) delete override[field];
            if (Object.keys(override).length === 0) this.overrides.delete(card.id);
        }
        const current = this.overrides.get(card.id);
        return { played: current?.played?.value ?? card.played ?? false, favorite: current?.favorite?.value ?? card.favorite, inWatchlist: current?.inWatchlist?.value ?? card.inWatchlist };
    }

    private write(card: Card, kind: PersonalAction, value: boolean): void {
        if (this.writing.has(card.id)) return;
        const field = kind === "watched" ? "played" : kind === "favorites" ? "favorite" : "inWatchlist";
        const override = this.overrides.get(card.id) ?? {};
        const previous = override[field];
        override[field] = { value, base: card[field] };
        this.overrides.set(card.id, override);
        this.writing.add(card.id);
        this.session.call({ ...detailOperations.setPersonal(kind, card.id, value), profileScoped: true, replayAfterRefresh: false }).then(() => {
            this.writing.delete(card.id);
            if (!this.torn) this.applied({ kind, card, value });
        }, () => {
            this.writing.delete(card.id);
            if (previous === undefined) delete override[field];
            else override[field] = previous;
            this.fail(kind === "watched" ? HOME_FAILURE : PERSONAL_FAILURE);
        });
    }

    private dismissCard(card: Card, dismissal: HomeDismissal): void {
        if (this.dismissing.has(card.id)) return;
        this.dismissing.add(card.id);
        this.session.call({ ...operations.dismissHomeItem(dismissal, card.id), profileScoped: true, replayAfterRefresh: false }).then(() => {
            this.dismissing.delete(card.id);
            if (!this.torn) this.applied({ kind: "dismissed", card });
        }, () => {
            this.dismissing.delete(card.id);
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
        if (this.alert.length === 0) this.release();
    }

    private release(): void {
        this.items = [];
        this.pressed = false;
        this.listen(false);
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
