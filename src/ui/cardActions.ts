import { operations } from "../api/operations.ts";
import type { Card } from "../contracts/v2/catalog.ts";
import type { NativeSession } from "../session/session.ts";
import { personalControls } from "./browseDetails.ts";
import { actionButton, lines, zoneNode } from "./browseViews.ts";
import type { FocusItem } from "./browseFocus.ts";
import { DetailsState } from "./detailsState.ts";
import { remoteKey } from "./keys.ts";
import { el } from "./screen.ts";

/** Transient UI; only unresolved DetailsState targets survive dismissal until authority ends. */
export class CardActions {
    private readonly retained = new Map<string, DetailsState>();
    private panel: HTMLElement | undefined;
    private controller: AbortController | undefined;
    private state: DetailsState | undefined;
    private items: FocusItem[] = [];
    private failed = false;
    private pressed = false;
    private card: Pick<Card, "id" | "title" | "type"> | undefined;
    private readonly container: HTMLElement;
    private readonly session: NativeSession;
    private readonly changed: (state: DetailsState) => void;
    private readonly closed: () => void;
    private readonly pendingElsewhere: () => boolean;

    constructor(container: HTMLElement, session: NativeSession, changed: (state: DetailsState) => void, closed: () => void, pendingElsewhere: () => boolean) {
        this.container = container;
        this.session = session;
        this.changed = changed;
        this.closed = closed;
        this.pendingElsewhere = pendingElsewhere;
    }

    get active(): boolean { return this.panel !== undefined; }
    get pending(): boolean { return this.state?.pending === true; }

    open(card: Pick<Card, "id" | "title" | "type">): void {
        if (this.active) return;
        this.card = card;
        this.panel = el("div", "card-actions-scrim");
        this.container.appendChild(this.panel);
        document.addEventListener("keydown", this.onKey, true);
        document.addEventListener("keyup", this.onRelease, true);
        this.load();
    }

    private load(): void {
        const card = this.card;
        if (card === undefined) return;
        this.controller?.abort();
        const controller = new AbortController();
        this.controller = controller;
        this.failed = false;
        const retained = this.retained.get(card.id);
        this.render();
        this.session.call({ ...operations.getCatalogItem(card.id), profileScoped: true, signal: controller.signal }).then(detail => {
            if (controller.signal.aborted || this.controller !== controller) return;
            if (detail.id !== card.id || detail.type !== card.type) throw new Error("Card identity changed");
            const state = new DetailsState(detail, this.session, () => {
                this.changed(state);
                if (this.state === state) this.render();
            }, async () => this.changed(state), this.pendingElsewhere);
            for (const [kind, change] of retained?.changes ?? []) state.changes.set(kind, change);
            this.state = state;
            state.start("personal");
            this.render();
        }).catch(() => {
            if (controller.signal.aborted || this.controller !== controller) return;
            this.failed = true;
            this.render();
        });
    }

    render(): void {
        const panel = this.panel;
        if (panel === undefined) return;
        const focused = panel.contains(document.activeElement) ? document.activeElement?.getAttribute("data-focus") : undefined;
        const content = el("div", "card-actions-panel");
        content.setAttribute("role", "dialog");
        content.setAttribute("aria-modal", "true");
        content.setAttribute("aria-label", "Card actions");
        content.appendChild(el("h1", "browse-section-title", this.state?.detail.title ?? this.card?.title ?? ""));
        const controls = this.state === undefined ? undefined : personalControls(this.state);
        this.items = [...controls?.items ?? [], ...(this.failed ? [actionButton("retry-card-actions", "Try again", () => this.load())] : []), actionButton("close-card-actions", "Close", () => this.close())];
        content.append(...(controls?.notes ?? lines([this.failed ? "Could not load card actions." : "Loading card actions."], this.failed ? "error" : "info")));
        if (this.state !== undefined && this.state.personalSupported === false) content.append(...lines(["List actions are unavailable for this title."]));
        if (this.state !== undefined && !this.state.values.has("watched")) content.append(...lines(["Watched state is unavailable."]));
        content.appendChild(zoneNode("card-actions-buttons", this.items));
        while (panel.firstChild !== null) panel.removeChild(panel.firstChild);
        panel.appendChild(content);
        (this.items.find(item => item.key === focused) ?? this.items[0])?.element.focus({ preventScroll: true });
    }

    close(): void {
        this.dismiss();
        this.closed();
    }

    private dismiss(): void {
        this.controller?.abort();
        this.controller = undefined;
        if (this.state !== undefined) {
            this.state.stop();
            if (this.state.changes.size > 0) this.retained.set(this.state.detail.id, this.state);
            else this.retained.delete(this.state.detail.id);
        }
        this.state = undefined;
        this.card = undefined;
        this.items = [];
        this.pressed = false;
        this.panel?.remove();
        this.panel = undefined;
        document.removeEventListener("keydown", this.onKey, true);
        document.removeEventListener("keyup", this.onRelease, true);
    }

    destroy(): void {
        this.dismiss();
        for (const state of this.retained.values()) state.stop();
        this.retained.clear();
    }

    private readonly onRelease = (event: KeyboardEvent): void => {
        if (remoteKey(event) === "enter") { this.pressed = false; event.preventDefault(); event.stopImmediatePropagation(); }
    };

    private readonly onKey = (event: KeyboardEvent): void => {
        if (!this.active) return;
        const key = remoteKey(event);
        if (key === undefined && event.key !== "Tab") return;
        event.stopImmediatePropagation();
        if (key === "back") { event.preventDefault(); this.close(); }
        else if (key === "up" || key === "down" || key === "left" || key === "right" || event.key === "Tab") {
            event.preventDefault();
            const index = this.items.findIndex(item => item.element === document.activeElement);
            const step = key === "up" || key === "left" || event.shiftKey ? -1 : 1;
            this.items[Math.max(0, Math.min(this.items.length - 1, index + step))]?.element.focus({ preventScroll: true });
        } else if (key === "enter") {
            event.preventDefault();
            if (this.pressed) return;
            this.pressed = true;
            this.items.find(item => item.element === document.activeElement)?.element.click();
        }
    };
}
