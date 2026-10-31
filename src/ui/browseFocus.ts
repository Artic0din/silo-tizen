// Remote focus for the browse screens. A view is a stack of zones, top to bottom: a row of
// cards, a grid of cards, a column of episodes or a row of buttons. Each zone has one focused
// item at a time; arrows move inside the zone and, past its top or bottom edge, into the zone
// above or below, landing on the item last focused there. Focus is restored by zone id and item
// key, never by position, and a key press always brings lost focus back.
// The sign-in ScreenHost moves through one list; grids and stacked rows need two dimensions.

import { remoteKey } from "./keys.ts";
import { SkylineScroll } from "./skylineScroll.ts";

const SELECT_HOLD_MS = 650;

interface VisitSnapshot {
    memory: Map<string, string>;
    lastZone: string | undefined;
    top: number;
    rows: Map<string, number>;
}

function visitKey(view: View): string {
    return /^library:[^:]+$/.test(view.name) ? view.transition?.key ?? view.name : view.name;
}

export interface FocusItem {
    /** Stable within its zone, e.g. a content id; restores focus across re-renders. */
    readonly key: string;
    readonly element: HTMLElement;
    readonly quickAction?: () => void;
}

export interface Zone {
    readonly id: string;
    readonly up?: string;
    readonly down?: string;
    readonly left?: string;
    readonly right?: string;
    /** row: Left/Right move. column: Up/Down move. grid: both, `columns` items per row. */
    readonly layout: "row" | "column" | "grid";
    readonly columns?: number;
    readonly items: readonly FocusItem[];
}

export interface FocusTarget {
    readonly zone: string;
    readonly key: string;
}

export interface View {
    readonly prepare?: () => void;
    /** False while a library view has no committed data to remember. */
    readonly ready?: boolean;
    /** Stable through loading/data renders; a same-group change drifts incoming content. */
    readonly transition?: { readonly key: string; readonly group: string };
    /** Identifies the view; re-showing the same name keeps each zone's last focused item. */
    readonly name: string;
    readonly content: readonly HTMLElement[];
    readonly zones: readonly Zone[];
    /** Focused when the view first appears or the requested item is gone. */
    readonly focus: FocusTarget | undefined;
    /** Undefined: Back is not handled here and reaches the app's own handler (root exit). */
    readonly back: (() => boolean | void) | undefined;
}

export class FocusHost {
    private readonly container: HTMLElement;
    private view: View | undefined;
    /** zone id -> key last focused there, for the current view name. */
    private memory = new Map<string, string>();
    private lastZone: string | undefined;
    private listening = false;
    private readonly scroll = new SkylineScroll();
    private readonly visits = new Map<string, VisitSnapshot>();
    private visitHeld = false;
    private outgoing: HTMLElement | undefined;
    private incoming: HTMLElement[] = [];
    private transitionTimer: number | undefined;
    private press: { item: FocusItem; started: number; timer: number | undefined; cancelled: boolean } | undefined;
    private readonly detach = new MutationObserver(() => {
        if (this.press !== undefined && !this.press.item.element.isConnected) this.cancelPress();
    });

    constructor(container: HTMLElement) {
        this.container = container;
    }

    get name(): string | undefined {
        return this.view?.name;
    }

    focusDefault(): void {
        const view = this.view;
        const visit = view === undefined || !/^library:[^:]+$/.test(view.name) ? undefined : this.visits.get(visitKey(view));
        const zone = view?.zones.find(candidate => candidate.id === visit?.lastZone && !["nav", "selector", "flyout", "pills"].includes(candidate.id));
        const item = zone?.items.find(candidate => candidate.key === visit?.memory.get(zone.id));
        if (view?.ready !== false && visit !== undefined && zone !== undefined && item !== undefined) {
            this.applyVisit(visit);
            const intersects = this.intersects(item.element);
            if (intersects || item.element.closest(".browse-row") === null) {
                const snap = intersects && this.insideRow(item.element);
                this.focusItem(zone, item);
                if (snap) { this.scroll.stop(); this.applyVisit(visit); }
                return;
            }
        }
        this.focusFirst([this.view?.focus]);
    }

    /** Save before hiding library chrome can resize and clamp the viewport. */
    holdVisit(): void {
        if (this.view === undefined || this.view.ready === false) return;
        this.remember(visitKey(this.view));
        this.visitHeld = true;
    }

    /**
     * Focuses the first of `focus`, the item focused before (same view name only) and the view's
     * default that still exists; when none does, the first item of the first of their zones that
     * remains (the focused item disappeared), else the first item anywhere.
     */
    show(view: View, focus?: FocusTarget): void {
        const previousView = this.view;
        const sameVisit = previousView !== undefined && visitKey(previousView) === visitKey(view);
        const press = this.press?.cancelled === false && sameVisit ? this.press : undefined;
        const pressed = press === undefined ? undefined : this.focused();
        this.cancelPress();
        const changed = (this.view?.transition?.key ?? this.view?.name) !== (view.transition?.key ?? view.name);
        const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
        const animate = changed && this.view !== undefined && this.container.classList.contains("skyline-root") && !reduced;
        const drift = view.transition !== undefined && view.transition.group === this.view?.transition?.group;
        if (changed || reduced) {
            this.clearTransition();
            this.scroll.stop();
        }
        if (animate) {
            const outgoing = document.createElement("div");
            outgoing.className = [...this.container.classList].filter((name) => name !== "browse").concat("skyline-route-outgoing").join(" ");
            for (const child of this.container.childNodes) outgoing.appendChild(child.cloneNode(true));
            const originals = Array.from(this.container.querySelectorAll<HTMLElement>(".skyline-content, .browse-row"));
            const copies = Array.from(outgoing.querySelectorAll<HTMLElement>(".skyline-content, .browse-row"));
            outgoing.setAttribute("aria-hidden", "true");
            // Chrome stays mounted in the live container and must remain above the snapshot.
            outgoing.querySelectorAll(".browse-nav, .skyline-selector, .skyline-dropdown-scrim").forEach((node) => node.remove());
            outgoing.querySelectorAll("[id], [data-focus], [data-section], button, input").forEach((node) => {
                node.removeAttribute("id");
                node.removeAttribute("data-focus");
                node.removeAttribute("data-section");
                node.setAttribute("tabindex", "-1");
            });
            this.container.parentElement?.appendChild(outgoing);
            copies.forEach((node, index) => {
                const original = originals[index];
                if (original === undefined) return;
                node.scrollTop = original.scrollTop;
                node.scrollLeft = original.scrollLeft;
            });
            outgoing.scrollTop = this.container.scrollTop;
            this.outgoing = outgoing;
            this.transitionTimer = window.setTimeout(() => this.clearTransition(), 200);
        }
        const previous = sameVisit ? this.locate(document.activeElement) : undefined;
        const kept = previous === undefined ? undefined : { zone: previous.zone.id, key: previous.item.key };
        const unchanged = sameVisit ? kept ?? focus ?? this.memoryTarget() : undefined;
        const previousZone = view.zones.find(zone => zone.id === previous?.zone.id);
        const nearby = previous === undefined || previous.item.quickAction === undefined || previousZone?.items.some(item => item.key === previous.item.key)
            ? undefined : previousZone?.items[Math.min(previous.index, previousZone.items.length - 1)];
        if (!this.visitHeld && previousView !== undefined && previousView.ready !== false) this.remember(visitKey(previousView));
        this.visitHeld = false;
        const visit = this.visits.get(visitKey(view));
        if (!sameVisit) {
            this.scroll.stop();
            this.memory = new Map(visit?.memory);
            this.lastZone = visit?.lastZone;
        }
        this.view = view;
        this.container.setAttribute("data-view", view.name);
        view.prepare?.();
        place(this.container, view.content);
        this.applyVisit(visit);
        const restoring = !sameVisit && visit !== undefined;
        const target = focus ?? (restoring ? this.memoryTarget() : undefined);
        const item = target === undefined ? undefined : view.zones.find(zone => zone.id === target.zone)?.items.find(candidate => candidate.key === target.key);
        const offscreenShelf = restoring && item?.element.closest(".browse-row") != null && !this.intersects(item.element);
        const returnSnap = restoring && !offscreenShelf && item !== undefined && this.intersects(item.element) && this.insideRow(item.element);
        this.focusFirst(offscreenShelf ? [view.focus] : [focus, nearby === undefined ? kept : { zone: previous?.zone.id ?? "", key: nearby.key }, restoring ? this.memoryTarget() : undefined, view.focus]);
        const focused = this.focused();
        const sameIdentity = unchanged !== undefined && focused?.zone === unchanged.zone && focused.key === unchanged.key;
        if ((sameIdentity || returnSnap) && visit !== undefined) {
            // Repainting the same identity (including a dismissed modal) must keep its viewport.
            this.scroll.stop();
            this.applyVisit(visit);
        }
        if (animate) {
            this.incoming = Array.from(this.container.querySelectorAll<HTMLElement>(".skyline-content > :not(.skyline-pills), .skyline-marquee"));
            for (const node of this.incoming) node.classList.add(drift && !node.classList.contains("skyline-marquee") ? "skyline-content-drift" : "skyline-content-enter");
        }
        const current = this.locate(document.activeElement);
        if (press !== undefined && this.press === press && !changed && !document.hidden && current?.zone.id === pressed?.zone && current?.item.key === pressed?.key && current?.item.quickAction !== undefined) {
            press.item = current.item;
            press.cancelled = false;
            this.armPress(press);
        }
    }

    focused(): FocusTarget | undefined {
        const found = this.locate(document.activeElement);
        return found === undefined ? undefined : { zone: found.zone.id, key: found.item.key };
    }

    private viewport(): HTMLElement {
        return this.container.querySelector<HTMLElement>(".skyline-content") ?? this.container;
    }

    private remember(key: string): void {
        const focused = this.locate(document.activeElement);
        if (focused !== undefined) {
            this.memory.set(focused.zone.id, focused.item.key);
            this.lastZone = focused.zone.id;
        }
        this.visits.set(key, { memory: new Map(this.memory), lastZone: this.lastZone, top: this.viewport().scrollTop, rows: new Map(Array.from(this.container.querySelectorAll<HTMLElement>(".browse-row")).map((row, index) => [this.rowKey(row, index), row.scrollLeft])) });
    }

    private applyVisit(visit: VisitSnapshot | undefined): void {
        this.viewport().scrollTop = visit?.top ?? 0;
        this.container.querySelectorAll<HTMLElement>(".browse-row").forEach((row, index) => { row.scrollLeft = visit?.rows.get(this.rowKey(row, index)) ?? 0; });
    }

    private intersects(element: HTMLElement): boolean {
        const viewport = element.closest<HTMLElement>(".details-audio-picker, .skyline-content") ?? this.container;
        const rect = element.getBoundingClientRect();
        const bounds = viewport.getBoundingClientRect();
        const row = element.closest<HTMLElement>(".browse-row")?.getBoundingClientRect() ?? bounds;
        return rect.width > 0 && rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom && rect.right > row.left && rect.left < row.right;
    }

    private insideRow(element: HTMLElement): boolean {
        const row = element.closest<HTMLElement>(".browse-row");
        if (row === null) return true;
        const rect = element.getBoundingClientRect();
        const bounds = row.getBoundingClientRect();
        return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
    }

    private rowKey(row: HTMLElement, index: number): string {
        return row.closest("[data-section]")?.getAttribute("data-section") ?? `row:${index}`;
    }

    /** Stops handling keys, e.g. while the player owns the screen; `listen` resumes. */
    stop(): void {
        this.cancelPress();
        this.detach.disconnect();
        this.clearTransition();
        this.scroll.stop();
        if (this.listening) {
            document.removeEventListener("keydown", this.onKey);
            document.removeEventListener("keydown", this.onPress, true);
            document.removeEventListener("keyup", this.onRelease, true);
            document.removeEventListener("focusout", this.cancelPress);
            document.removeEventListener("visibilitychange", this.cancelPress);
            window.removeEventListener("blur", this.cancelPress);
            this.press = undefined;
            this.listening = false;
        }
    }

    private clearTransition(): void {
        if (this.transitionTimer !== undefined) window.clearTimeout(this.transitionTimer);
        this.outgoing?.remove();
        for (const node of this.incoming) node.classList.remove("skyline-content-enter", "skyline-content-drift");
        this.incoming = [];
        this.outgoing = undefined;
        this.transitionTimer = undefined;
    }

    listen(): void {
        if (!this.listening) {
            this.detach.observe(this.container, { childList: true, subtree: true });
            document.addEventListener("keydown", this.onKey);
            document.addEventListener("keydown", this.onPress, true);
            document.addEventListener("keyup", this.onRelease, true);
            document.addEventListener("focusout", this.cancelPress);
            document.addEventListener("visibilitychange", this.cancelPress);
            window.addEventListener("blur", this.cancelPress);
            this.listening = true;
        }
    }

    destroy(): void {
        this.stop();
        this.view = undefined;
        this.memory = new Map();
        this.visits.clear();
        this.visitHeld = false;
        this.lastZone = undefined;
        while (this.container.firstChild !== null) {
            this.container.removeChild(this.container.firstChild);
        }
    }

    private locate(element: Element | null): { zone: Zone; zoneIndex: number; item: FocusItem; index: number } | undefined {
        const zones = this.view?.zones ?? [];
        for (let zoneIndex = 0; zoneIndex < zones.length; zoneIndex++) {
            const zone = zones[zoneIndex];
            const index = zone === undefined ? -1 : zone.items.findIndex((item) => item.element === element);
            const item = zone?.items[index];
            if (zone !== undefined && item !== undefined) {
                return { zone, zoneIndex, item, index };
            }
        }
        return undefined;
    }

    private focusFirst(candidates: readonly (FocusTarget | undefined)[]): void {
        const zones = this.view?.zones ?? [];
        const zoneOf = (target: FocusTarget | undefined): Zone | undefined =>
            zones.find((zone) => zone.id === target?.zone && zone.items.length > 0);
        for (const target of candidates) {
            const zone = zoneOf(target);
            const item = zone?.items.find((candidate) => candidate.key === target?.key);
            if (item !== undefined) {
                this.focusItem(zone, item);
                return;
            }
        }
        for (const target of candidates) {
            const zone = zoneOf(target);
            if (zone !== undefined) {
                this.focusItem(zone, zone.items[0]);
                return;
            }
        }
        const zone = zones.find((candidate) => candidate.items.length > 0);
        this.focusItem(zone, zone?.items[0]);
    }

    private enterZone(zoneIndex: number, step: -1 | 1): boolean {
        const zones = this.view?.zones ?? [];
        for (let next = zoneIndex + step; next >= 0 && next < zones.length; next += step) {
            const zone = zones[next];
            if (zone !== undefined && zone.items.length > 0) {
                const remembered = this.memory.get(zone.id);
                this.focusItem(zone, zone.items.find((item) => item.key === remembered) ?? zone.items[0]);
                return true;
            }
        }
        return false;
    }

    private focusItem(zone: Zone | undefined, item: FocusItem | undefined): void {
        if (zone === undefined || item === undefined) {
            return;
        }
        this.memory.set(zone.id, item.key);
        this.lastZone = zone.id;
        item.element.focus({ preventScroll: true });
        this.scroll.reveal(item.element, this.container);
    }

    /** Where focus last was in this view, to return to after it was lost. */
    private memoryTarget(): FocusTarget | undefined {
        const zone = this.lastZone;
        const key = zone === undefined ? undefined : this.memory.get(zone);
        return zone === undefined || key === undefined ? undefined : { zone, key };
    }

    private readonly cancelPress = (): void => {
        if (this.press === undefined) return;
        if (this.press.timer !== undefined) window.clearTimeout(this.press.timer);
        this.press.timer = undefined;
        this.press.cancelled = true;
    };

    private readonly onPress = (event: KeyboardEvent): void => {
        const key = remoteKey(event);
        if (key !== "enter") { if (key !== undefined) this.cancelPress(); return; }
        if (this.press !== undefined) { event.preventDefault(); event.stopImmediatePropagation(); return; }
        if (event.defaultPrevented) return;
        const item = this.locate(document.activeElement)?.item;
        if (item?.quickAction === undefined) return;
        // Enter's default click runs on keydown, before a hold can be distinguished.
        event.preventDefault();
        const press = { item, started: performance.now(), timer: undefined as number | undefined, cancelled: false };
        this.press = press;
        this.armPress(press);
    };

    private armPress(press: NonNullable<FocusHost["press"]>): void {
        // A fixed 650 ms separates deliberate holds from ordinary Select presses; tune on TV.
        press.timer = window.setTimeout(() => {
            press.timer = undefined;
            if (!press.cancelled && press.item.element.isConnected && document.activeElement === press.item.element && !document.hidden) {
                press.cancelled = true;
                press.item.quickAction?.();
            }
        }, Math.max(0, SELECT_HOLD_MS - (performance.now() - press.started)));
    }

    private readonly onRelease = (event: KeyboardEvent): void => {
        if (remoteKey(event) !== "enter" || this.press === undefined) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const press = this.press;
        const activate = !press.cancelled;
        this.cancelPress();
        this.press = undefined;
        if (activate && press.item.element.isConnected && document.activeElement === press.item.element && !document.hidden) {
            if (performance.now() - press.started >= SELECT_HOLD_MS) press.item.quickAction?.();
            else press.item.element.click();
        }
    };

    private readonly onKey = (event: KeyboardEvent): void => {
        if (event.defaultPrevented) return;
        const view = this.view;
        const key = remoteKey(event);
        if (view === undefined || key === undefined) {
            return;
        }
        if (key === "back") {
            if (view.back !== undefined) {
                if (view.back() !== false) event.preventDefault();
            }
            return;
        }
        const found = this.locate(document.activeElement);
        if (found === undefined) {
            // Focus was lost (a pointer click, or the focused node was replaced): bring it back.
            event.preventDefault();
            this.focusFirst([this.memoryTarget(), view.focus]);
            return;
        }
        if (key !== "up" && key !== "down" && key !== "left" && key !== "right") {
            // Enter is left to the browser: it presses a button and opens the TV keyboard on a field.
            return;
        }
        const inText = document.activeElement instanceof HTMLInputElement;
        if (inText && (key === "left" || key === "right")) {
            return;
        }
        event.preventDefault();
        const { zone, zoneIndex, index } = found;
        const target = moveWithin(zone, zone.items.length, index, key);
        if (target !== undefined) {
            this.focusItem(zone, zone.items[target]);
        } else {
            const destination = zone[key];
            const next = view.zones.find(candidate => candidate.id === destination && candidate.items.length > 0);
            if (next !== undefined) this.focusItem(next, next.items.find(item => item.key === this.memory.get(next.id)) ?? next.items[0]);
            else if (key === "up" || key === "down") this.enterZone(zoneIndex, key === "up" ? -1 : 1);
        }
    };
}

/** The index the key moves to inside the zone, or undefined at its edge. */
export function moveWithin(zone: Pick<Zone, "layout" | "columns">, count: number, index: number, key: "up" | "down" | "left" | "right"): number | undefined {
    const columns = zone.layout === "grid" ? Math.max(1, zone.columns ?? 1) : zone.layout === "row" ? count : 1;
    const column = index % columns;
    switch (key) {
        case "left":
            return zone.layout !== "column" && column > 0 ? index - 1 : undefined;
        case "right":
            return zone.layout !== "column" && column < columns - 1 && index + 1 < count ? index + 1 : undefined;
        case "up":
            return zone.layout !== "row" && index - columns >= 0 ? index - columns : undefined;
        case "down": {
            if (zone.layout === "row") {
                return undefined;
            }
            if (index + columns < count) {
                return index + columns;
            }
            // A partly filled last row is still below: land on its last item.
            const lastRowStart = count - 1 - ((count - 1) % columns);
            return index < lastRowStart ? count - 1 : undefined;
        }
    }
}

/** Makes `nodes` the container's children; a node already in its place is not moved, so it keeps focus. */
function place(container: HTMLElement, nodes: readonly HTMLElement[]): void {
    nodes.forEach((node, index) => {
        const current = container.children[index];
        if (current !== node) {
            container.insertBefore(node, current ?? null);
        }
    });
    while (container.children.length > nodes.length) {
        const last = container.lastElementChild;
        if (last === null) {
            break;
        }
        container.removeChild(last);
    }
}
