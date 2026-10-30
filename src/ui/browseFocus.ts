// Remote focus for the browse screens. A view is a stack of zones, top to bottom: a row of
// cards, a grid of cards, a column of episodes or a row of buttons. Each zone has one focused
// item at a time; arrows move inside the zone and, past its top or bottom edge, into the zone
// above or below, landing on the item last focused there. Focus is restored by zone id and item
// key, never by position, and a key press always brings lost focus back.
// The sign-in ScreenHost moves through one list; grids and stacked rows need two dimensions.

import { remoteKey } from "./keys.ts";
import { SkylineScroll } from "./skylineScroll.ts";

export interface FocusItem {
    /** Stable within its zone, e.g. a content id; restores focus across re-renders. */
    readonly key: string;
    readonly element: HTMLElement;
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
    private readonly visits = new Map<string, { memory: Map<string, string>; lastZone: string | undefined; top: number; rows: Map<string, number> }>();
    private outgoing: HTMLElement | undefined;
    private transitionTimer: number | undefined;

    constructor(container: HTMLElement) {
        this.container = container;
    }

    get name(): string | undefined {
        return this.view?.name;
    }

    focusDefault(): void {
        this.focusFirst([this.view?.focus]);
    }

    /**
     * Focuses the first of `focus`, the item focused before (same view name only) and the view's
     * default that still exists; when none does, the first item of the first of their zones that
     * remains (the focused item disappeared), else the first item anywhere.
     */
    show(view: View, focus?: FocusTarget): void {
        if (this.view?.name !== view.name && this.view !== undefined && this.container.classList.contains("skyline-root") && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
            this.clearTransition();
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
        const kept = this.view?.name === view.name ? this.focused() : undefined;
        if (this.view !== undefined) {
            this.visits.set(this.view.name, { memory: new Map(this.memory), lastZone: this.lastZone, top: this.viewport().scrollTop, rows: new Map(Array.from(this.container.querySelectorAll<HTMLElement>(".browse-row")).map((row, index) => [this.rowKey(row, index), row.scrollLeft])) });
        }
        const visit = this.visits.get(view.name);
        if (this.view?.name !== view.name) {
            this.scroll.stop();
            this.memory = new Map(visit?.memory);
            this.lastZone = visit?.lastZone;
        }
        this.view = view;
        this.container.setAttribute("data-view", view.name);
        view.prepare?.();
        place(this.container, view.content);
        this.viewport().scrollTop = visit?.top ?? 0;
        this.container.querySelectorAll<HTMLElement>(".browse-row").forEach((row, index) => { row.scrollLeft = visit?.rows.get(this.rowKey(row, index)) ?? 0; });
        this.focusFirst([focus, kept, view.focus]);
    }

    focused(): FocusTarget | undefined {
        const found = this.locate(document.activeElement);
        return found === undefined ? undefined : { zone: found.zone.id, key: found.item.key };
    }

    private viewport(): HTMLElement {
        return this.container.querySelector<HTMLElement>(".skyline-content") ?? this.container;
    }

    private rowKey(row: HTMLElement, index: number): string {
        return row.closest("[data-section]")?.getAttribute("data-section") ?? `row:${index}`;
    }

    /** Stops handling keys, e.g. while the player owns the screen; `listen` resumes. */
    stop(): void {
        this.clearTransition();
        this.scroll.stop();
        if (this.listening) {
            document.removeEventListener("keydown", this.onKey);
            this.listening = false;
        }
    }

    private clearTransition(): void {
        if (this.transitionTimer !== undefined) window.clearTimeout(this.transitionTimer);
        this.outgoing?.remove();
        this.outgoing = undefined;
        this.transitionTimer = undefined;
    }

    listen(): void {
        if (!this.listening) {
            document.addEventListener("keydown", this.onKey);
            this.listening = true;
        }
    }

    destroy(): void {
        this.stop();
        this.view = undefined;
        this.memory = new Map();
        this.visits.clear();
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
