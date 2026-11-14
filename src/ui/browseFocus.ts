// Remote focus for the browse screens. A view is a stack of zones, top to bottom: a row of
// cards, a grid of cards, a column of episodes or a row of buttons. Each zone has one focused
// item at a time. Arrows move inside the zone and, past its edge, into the next. Up and Down
// between content rows keep the column. An aligned row lands on the item closest to the focused
// item's left edge, and stays when they do not meet. Down from a landscape card into a poster
// row uses that card's position. Down from the top bar lands on the leftmost card.
// Focus is restored by zone id and item key, never by position, and a key press always
// brings lost focus back.
// The sign-in ScreenHost moves through one list; grids and stacked rows need two dimensions.

import { remoteKey } from "./keys.ts";
import { heldSelect, isFreshSelect, listenSelectRelease, moveSelect } from "./selectRelease.ts";
import { SkylineScroll } from "./skylineScroll.ts";

const SELECT_HOLD_MS = 650;

/** A press runs only on a control that was enabled when pressed and still is (aria-disabled controls stay focusable). */
function enabled(element: HTMLElement): boolean {
    return !element.matches(':disabled, [aria-disabled="true"]');
}
/** Scrolling panels whose position survives a repaint of their screen, keyed by data-scroll-key. */
const SCROLL_PANELS = ".browse-panel-list[data-scroll-key], .settings-modal-options[data-scroll-key], .settings-pane[data-scroll-key], .accounts-rail[data-scroll-key], .accounts-pane[data-scroll-key]";

interface VisitSnapshot {
    memory: Map<string, string>;
    lastZone: string | undefined;
    contentZone: string | undefined;
    top: number;
    rows: Map<string, number>;
    panels: Map<string, number>;
}

function visitKey(view: View): string {
    if (view.visitKey !== undefined) return view.visitKey;
    return /^library:[^:]+$/.test(view.name) ? view.transition?.key ?? view.name : view.name;
}

export interface FocusItem {
    /** Stable within its zone, e.g. a content id; restores focus across re-renders. */
    readonly key: string;
    readonly element: HTMLElement;
    readonly quickAction?: () => void;
    readonly play?: () => void;
}

export interface Zone {
    /** Restore the last enabled item on entry, otherwise this fallback, before geometry. */
    readonly restoreEntry?: string;
    /** An explicit entry target; clearing it returns the zone to remembered-item restoration. */
    readonly entry?: string | undefined;
    readonly onLeft?: () => void;
    /** A reading stop taller than the page: Up/Down scroll it a step at a time until that edge is visible, then leave. */
    readonly reading?: boolean;
    readonly id: string;
    readonly up?: string;
    readonly down?: string;
    readonly left?: string;
    readonly right?: string;
    /** row: Left/Right move. column: Up/Down move. grid: both, `columns` items per row. */
    readonly layout: "row" | "column" | "grid";
    readonly columns?: number;
    /** `true`: nearest centre between zones. `"aligned"`: the intersecting item closest to the focused item's left edge; otherwise the move stays. */
    readonly spatial?: boolean | "aligned";
    readonly items: readonly FocusItem[];
}

export interface FocusTarget {
    readonly zone: string;
    readonly key: string;
}

export interface View {
    /** A route presentation can retain its own position even for the same title. */
    readonly visitKey?: string;
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

/** Page scroll per Up/Down inside a reading stop: about a third of the 1080 px page, so no line is skipped. */
const READING_STEP = 360;
/** Gap kept between a reading stop's revealed edge and the page edge. */
const READING_INSET = 32;

export class FocusHost {
    private readonly container: HTMLElement;
    private view: View | undefined;
    /** zone id -> key last focused there, for the current view name. */
    private memory = new Map<string, string>();
    private lastZone: string | undefined;
    private contentZone: string | undefined;
    private navigationX: number | undefined;
    private navigationItem: FocusItem | undefined;
    private listening = false;
    private readonly scroll = new SkylineScroll();
    private readonly visits = new Map<string, VisitSnapshot>();
    private visitHeld = false;
    private outgoing: HTMLElement | undefined;
    private incoming: HTMLElement[] = [];
    private transitionTimer: number | undefined;
    private press: { item: FocusItem; started: number; timer: number | undefined; cancelled: boolean } | undefined;
    /** One Play claim per Details visit. tvOS retries it; a failed claim used to leave body focused until the next key. */
    private playClaim: { visit: string; attempts: number; waits: number; finished: boolean; timer: number | undefined; moved: boolean; awaitingPrimary: boolean } | undefined;
    private readonly detach = new MutationObserver(() => {
        if (this.press !== undefined && !this.press.item.element.isConnected) this.cancelPress();
    });

    constructor(container: HTMLElement) {
        this.container = container;
        listenSelectRelease();
    }

    get name(): string | undefined {
        return this.view?.name;
    }

    focusDefault(): void {
        const view = this.view;
        const visit = view === undefined || !/^library:[^:]+$/.test(view.name) ? undefined : this.visits.get(visitKey(view));
        const zone = view?.zones.find(candidate => candidate.id === visit?.contentZone);
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

    /** The next show of this view starts fresh: no remembered focus or scroll. */
    forgetVisit(name: string): void {
        this.visits.delete(name);
    }

    /** Drops every snapshot of one route presentation: its `View.visitKey` prefixes each of its view names. */
    forgetPresentation(visitKey: string): void {
        for (const name of [...this.visits.keys()]) if (name.startsWith(`${visitKey}:`)) this.visits.delete(name);
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
        const held = heldSelect();
        const holding = sameVisit && held !== undefined && held.element === document.activeElement ? this.focused() : undefined;
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
        // A Details focus scroll already on its way when this repaint starts. The repaint's own reveal cannot
        // stand in for it: the old focused node is gone by then, so it cannot tell an Up move from a Down one.
        const revealViewport = this.viewport();
        const revealing = sameVisit && view.name.startsWith("item:") ? this.scroll.motion(revealViewport) : undefined;
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
            this.navigationX = undefined;
            this.memory = new Map(visit?.memory);
            this.lastZone = visit?.lastZone;
            this.contentZone = visit?.contentZone;
        }
        this.view = view;
        this.container.setAttribute("data-view", view.name);
        view.prepare?.();
        // Moving the retained grid past rebuilt headings can blur its card; keep its reveal running.
        const retainedPerson = sameVisit && view.name.startsWith("person:") && kept !== undefined
            && (focus === undefined || (focus.zone === kept.zone && focus.key === kept.key))
            && view.zones.find(zone => zone.id === kept.zone)?.items.find(candidate => candidate.key === kept.key)?.element === previous?.item.element;
        place(this.container, view.content);
        this.applyVisit(visit);
        const restoring = !sameVisit && visit !== undefined;
        const target = focus ?? (restoring ? this.memoryTarget() : undefined);
        const item = target === undefined ? undefined : view.zones.find(zone => zone.id === target.zone)?.items.find(candidate => candidate.key === target.key);
        const offscreenShelf = restoring && item?.element.closest(".browse-row") != null && !this.intersects(item.element);
        const returnSnap = restoring && !offscreenShelf && item !== undefined && this.intersects(item.element) && this.insideRow(item.element);
        if (retainedPerson && previous !== undefined) {
            previous.item.element.focus({ preventScroll: true });
            this.scroll.reveal(previous.item.element, this.container);
        }
        else this.focusFirst(offscreenShelf ? [view.focus] : [focus, nearby === undefined ? kept : { zone: previous?.zone.id ?? "", key: nearby.key }, restoring ? this.memoryTarget() : undefined, view.focus]);
        this.settlePrimaryFocus(view);
        const focused = this.focused();
        // A repaint while Select is held keeps the press on the same item, so its release still runs it.
        const repainted = this.locate(document.activeElement)?.item.element;
        if (held !== undefined && holding !== undefined && focused?.zone === holding.zone && focused.key === holding.key && repainted !== undefined && heldSelect()?.element !== repainted) moveSelect(held, repainted);
        const sameIdentity = unchanged !== undefined && focused?.zone === unchanged.zone && focused.key === unchanged.key;
        if ((sameIdentity || returnSnap) && visit !== undefined && !retainedPerson) {
            // Repainting the same identity (including a dismissed modal) must keep its viewport, and a
            // Details focus scroll already on its way carries on along its own curve.
            this.scroll.stop();
            this.applyVisit(visit);
            if (revealing !== undefined) {
                // Rows the repaint added or removed above the focused one move its anchor: aim there, shifting the whole
                // curve so the move keeps its remaining time. The reveal's own focus direction wins over the scroll's:
                // an Up move that interrupted a move down can still scroll down.
                const element = this.locate(document.activeElement)?.item.element;
                const aim = element === undefined ? undefined : this.scroll.revealTarget(element, this.container, revealViewport, revealing.up ?? revealing.top < revealing.fromTop);
                this.scroll.resume(revealViewport, aim === undefined ? revealing : { ...revealing, fromLeft: revealing.fromLeft + aim.left - revealing.left, fromTop: revealing.fromTop + aim.top - revealing.top, left: aim.left, top: aim.top });
            }
            const element = this.locate(document.activeElement)?.item.element;
            if ((this.container.dataset.view === "search" || this.container.dataset.view?.startsWith("person:") || this.container.classList.contains("section-catalog") || this.container.classList.contains("library-browse") || this.container.classList.contains("requests-hub") || this.container.classList.contains("details-series-scene") || this.container.classList.contains("accounts-screen") || this.container.dataset.view === "watchParty:lobby" || element?.closest(".settings-modal-options") != null) && element !== undefined) {
                const viewport = element.closest<HTMLElement>(".browse-panel-list, .settings-modal-options, .settings-pane, .skyline-content, .accounts-rail, .accounts-pane, .accounts-settings") ?? this.container;
                const card = element.getBoundingClientRect(), bounds = viewport.getBoundingClientRect();
                if (card.top < bounds.top + 12 || card.bottom > bounds.bottom - 32 || !this.insideRow(element)) this.scroll.reveal(element, this.container);
            }
        }
        // Details anchors must win over a repaint's saved intermediate animation position.
        const element = this.locate(document.activeElement)?.item.element;
        if (view.name.startsWith("item:") && element !== undefined) this.scroll.restoreDetailsAnchor(element, this.container, true);
        if (animate) {
            this.incoming = Array.from(this.container.querySelectorAll<HTMLElement>(".skyline-content > :not(.skyline-pills), .skyline-marquee"));
            for (const node of this.incoming) node.classList.add(drift && !node.classList.contains("skyline-marquee") ? "skyline-content-drift" : "skyline-content-enter");
        }
        const current = this.locate(document.activeElement);
        if (press !== undefined && this.press === press && !changed && !document.hidden && current?.zone.id === pressed?.zone && current?.item.key === pressed?.key && current?.item.quickAction !== undefined && enabled(current.item.element)) {
            press.item = current.item;
            press.cancelled = false;
            this.armPress(press);
        }
    }

    focused(): FocusTarget | undefined {
        const found = this.locate(document.activeElement);
        return found === undefined ? undefined : { zone: found.zone.id, key: found.item.key };
    }

    revealFocused(): void {
        const element = this.locate(document.activeElement)?.item.element;
        if (element !== undefined) this.scroll.reveal(element, this.container);
    }

    scrollToTop(): void {
        // Commit the fallback viewport before optional repaints remember its position.
        this.scroll.stop();
        this.viewport().scrollTop = 0;
    }

    private viewport(): HTMLElement {
        return this.container.querySelector<HTMLElement>(".skyline-content") ?? this.container;
    }

    private remember(key: string): void {
        const focused = this.locate(document.activeElement);
        if (focused !== undefined) {
            this.memory.set(focused.zone.id, focused.item.key);
            this.lastZone = focused.zone.id;
            if (this.tracksContent(focused.zone.id)) this.contentZone = focused.zone.id;
        }
        // Settings recreates a category at the top; only the mounted pane survives a modal.
        const panels = this.container.classList.contains("settings") ? new Map<string, number>() : new Map(this.visits.get(key)?.panels);
        this.container.querySelectorAll<HTMLElement>(SCROLL_PANELS).forEach(panel => panels.set(panel.dataset.scrollKey ?? "", panel.scrollTop));
        this.visits.set(key, { memory: new Map(this.memory), lastZone: this.lastZone, contentZone: this.contentZone, top: this.viewport().scrollTop, rows: new Map(Array.from(this.container.querySelectorAll<HTMLElement>(".browse-row")).map((row, index) => [this.rowKey(row, index), row.scrollLeft])), panels });
    }

    private applyVisit(visit: VisitSnapshot | undefined): void {
        this.viewport().scrollTop = visit?.top ?? 0;
        this.container.querySelectorAll<HTMLElement>(".browse-row").forEach((row, index) => {
            SkylineScroll.prepareEpisodeRow(row);
            row.scrollLeft = visit?.rows.get(this.rowKey(row, index)) ?? 0;
            const entry = row.dataset.scrollEntry === undefined ? undefined : Array.from(row.children).find((node): node is HTMLElement => node instanceof HTMLElement && node.dataset.focus === row.dataset.scrollEntry);
            if (entry !== undefined) {
                row.scrollLeft = row.classList.contains("details-episodes") ? SkylineScroll.episodeOffset(row, entry) : row.classList.contains("details-season-chips") ? SkylineScroll.seasonOffset(row, entry) : entry.offsetLeft - row.offsetLeft - parseFloat(getComputedStyle(row).paddingLeft);
            }
        });
        this.container.querySelectorAll<HTMLElement>(SCROLL_PANELS).forEach(panel => { panel.scrollTop = visit?.panels.get(panel.dataset.scrollKey ?? "") ?? 0; });
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
        this.cancelPlayClaim();
        this.scroll.stop();
        if (this.listening) {
            document.removeEventListener("keydown", this.onKey);
            document.removeEventListener("keydown", this.onPress, true);
            document.removeEventListener("keyup", this.onRelease, true);
            document.removeEventListener("focusout", this.cancelPress);
            this.container.removeEventListener("focusin", this.rememberContent);
            this.container.removeEventListener("click", this.endPlayClaim, true);
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
            this.container.addEventListener("focusin", this.rememberContent);
            this.container.addEventListener("click", this.endPlayClaim, true);
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
        this.contentZone = undefined;
        this.navigationX = undefined;
        this.navigationItem = undefined;
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

    /** Select by Enter or pointer is the viewer's choice, like a directional move (`userNavigated` in TVSeriesDetailView). */
    private readonly endPlayClaim = (): void => {
        if (this.playClaim !== undefined) this.playClaim.moved = true;
    };

    private readonly rememberContent = (event: FocusEvent): void => {
        if (event.target !== this.navigationItem?.element) this.navigationX = undefined;
        const focused = this.locate(event.target instanceof Element ? event.target : null);
        if (focused === undefined || ["nav", "selector", "flyout", "pills"].includes(focused.zone.id)) return;
        this.memory.set(focused.zone.id, focused.item.key);
        if (this.tracksContent(focused.zone.id)) this.contentZone = focused.zone.id;
    };

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

    private enterZone(zoneIndex: number, step: -1 | 1, from: FocusItem): boolean {
        const zones = this.view?.zones ?? [];
        for (let next = zoneIndex + step; next >= 0 && next < zones.length; next += step) {
            const zone = zones[next];
            if (zone !== undefined && zone.items.length > 0) {
                const restored = this.restoredEntry(zone);
                if (restored !== undefined) {
                    this.focusItem(zone, restored);
                    return true;
                }
                // Apple raises the first row's default-focus priority while the
                // top menu is focused (TVSkylineSectionFeed), so Down from the
                // bar ignores the card remembered in that row. Calendar shelves
                // do the same when entered from the filter or day strip.
                const sourceId = zones[zoneIndex]?.id;
                const fromChrome = sourceId === "nav" || (this.view?.name === "calendar" && (sourceId === "days" || sourceId === "filters" || sourceId === "status" || sourceId === "empty"));
                const remembered = fromChrome ? undefined : this.memory.get(zone.id);
                const spatial = zone.spatial && zones[zoneIndex]?.spatial;
                const columns = Math.max(1, zone.columns ?? 1);
                const edge = step === 1 ? 0 : Math.floor((zone.items.length - 1) / columns) * columns;
                const edgeItems = zone.layout === "grid" ? zone.items.slice(edge, edge + columns) : zone.items;
                // Selection and the last focused chip do not choose this landing. The item that
                // meets the focused item and sits closest to its left edge does; no meeting, no move.
                if (zone.spatial === "aligned") {
                    const origin = from.element.getBoundingClientRect();
                    let match: FocusItem | undefined;
                    let best = Number.POSITIVE_INFINITY;
                    for (const item of edgeItems) {
                        const target = item.element.getBoundingClientRect();
                        if (origin.left >= target.right || target.left >= origin.right) continue;
                        const distance = Math.max(0, target.left - origin.left);
                        if (distance < best) {
                            best = distance;
                            match = item;
                        }
                    }
                    if (match !== undefined) this.focusItem(zone, match);
                    return true;
                }
                // A landscape card is wider than the poster column it was reached from, so the
                // remembered axis points at a different poster. Measure this card instead.
                const fromWide = landscapeArt(from.element);
                const toPoster = edgeItems[0] !== undefined && !landscapeArt(edgeItems[0].element);
                if (fromWide && toPoster) {
                    const rect = from.element.getBoundingClientRect();
                    this.navigationX = rect.left + rect.width / 2;
                }
                const searchLanding = searchVerticalLanding(zones[zoneIndex], zone, from.element, edgeItems, this.navigationX);
                if (searchLanding === "stay") return true;
                const nearest = searchLanding ?? (spatial ? nearestItem(edgeItems, from.element, this.navigationX) : undefined);
                this.focusItem(zone, zone.items.find(item => item.key === zone.entry) ?? nearest ?? zone.items.find((item) => item.key === remembered) ?? zone.items[0]);
                return true;
            }
        }
        return false;
    }

    private restoredEntry(zone: Zone): FocusItem | undefined {
        if (zone.restoreEntry === undefined) return undefined;
        return zone.items.find(item => item.key === this.memory.get(zone.id) && !item.element.matches(':disabled, [aria-disabled="true"]'))
            ?? zone.items.find(item => item.key === zone.restoreEntry);
    }

    /** Play, Resume, or the series primary. Anything else is not the page's opening claim. */
    private primaryTarget(view: View): { zone: Zone; item: FocusItem } | undefined {
        const focus = view.focus;
        if (focus === undefined || (focus.key !== "resume" && focus.key !== "play" && focus.key !== "next-episode")) return undefined;
        const zone = view.zones.find(candidate => candidate.id === focus.zone && candidate.items.length > 0);
        const item = zone?.items.find(candidate => candidate.key === focus.key);
        return zone === undefined || item === undefined ? undefined : { zone, item };
    }

    private primaryReady(element: HTMLElement): boolean {
        return element.isConnected && element.offsetWidth > 0 && element.offsetHeight > 0 && !element.matches(":disabled, [aria-disabled='true']");
    }

    private clearPlayClaimTimer(): void {
        if (this.playClaim?.timer !== undefined) window.clearTimeout(this.playClaim.timer);
        if (this.playClaim !== undefined) this.playClaim.timer = undefined;
    }

    private cancelPlayClaim(): void {
        this.clearPlayClaimTimer();
        this.playClaim = undefined;
    }

    /**
     * One Play claim per Details visit (`TVDetailActionRow.resetInitialPlayFocus`,
     * silo-apple eb82bb86). While `playTitle` is nil the claim stays unused
     * (lines 504, 567-568, 571) and Watchlist is the live stand-in (lines 597-602).
     * The first attempt then assigns Play without reading that focus (lines 635–643).
     * A later attempt bails only when another action is focused and the page does
     * not track navigation (lines 622–641). Series tracks a directional move or a
     * Select (season tab, Play, Watchlist) instead (`TVSeriesDetailView.swift`
     * lines 311–326, 504–517, 528–529 and 615) and cancels the claim (lines 555-559).
     * A claim that does not stick leaves focus on body until the next key. Stop once
     * the viewer has moved or selected, or a dialog has taken focus.
     */
    private settlePrimaryFocus(view: View, fromTimer = false): void {
        if (!view.name.startsWith("item:")) {
            this.cancelPlayClaim();
            return;
        }
        const visit = visitKey(view);
        // A Details popover (`item:<id>:<panel>`) is part of its page's visit, so opening and closing one keeps the claim.
        const sameVisit = this.playClaim !== undefined && (this.playClaim.visit === visit || visit.startsWith(`${this.playClaim.visit}:`) || this.playClaim.visit.startsWith(`${visit}:`));
        if (this.playClaim !== undefined && sameVisit) this.playClaim.visit = visit;
        if (this.playClaim === undefined || !sameVisit) {
            this.cancelPlayClaim();
            this.playClaim = { visit, attempts: 0, waits: 0, finished: false, timer: undefined, moved: false, awaitingPrimary: false };
        }
        const claim = this.playClaim;
        if (claim.finished) return;
        if (claim.moved || this.focusInOverlay()) {
            claim.finished = true;
            this.clearPlayClaimTimer();
            return;
        }
        const primary = this.primaryTarget(view);
        const active = this.locate(document.activeElement);
        // The claim stays unused until Play exists. Its first assignment still
        // takes the live stand-in. A control the viewer has moved to is
        // claim.moved, handled above. This check is only for a claim that
        // started while Play was already the opening target.
        if (primary === undefined) {
            claim.awaitingPrimary = true;
            this.clearPlayClaimTimer();
            return;
        }
        // A late Play replaces only its row's stand-in, never an opening focus outside the row (a season context).
        if (active !== undefined && active.item.key !== primary.item.key && (!claim.awaitingPrimary || active.zone.id !== primary.zone.id)) {
            claim.finished = true;
            this.clearPlayClaimTimer();
            return;
        }
        const ready = this.primaryReady(primary.item.element);
        if (!ready) {
            if (fromTimer) claim.waits += 1;
            if (claim.waits < 3) this.armPlayClaim(visit);
            return;
        }
        claim.awaitingPrimary = false;
        if (document.activeElement !== primary.item.element) this.focusItem(primary.zone, primary.item);
        const held = document.activeElement === primary.item.element;
        if (fromTimer && held) {
            claim.finished = true;
            this.clearPlayClaimTimer();
            return;
        }
        if (fromTimer && !held) {
            claim.attempts += 1;
            if (claim.attempts >= 3) {
                claim.finished = true;
                this.clearPlayClaimTimer();
                return;
            }
        }
        this.armPlayClaim(visit);
    }

    /** Card actions and other menus focus controls that are not in the page's zones. */
    private focusInOverlay(): boolean {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement) || this.locate(active) !== undefined) return false;
        return active.closest("[role='dialog'], [role='alertdialog'], .card-actions-scrim") !== null;
    }

    private armPlayClaim(visit: string): void {
        const claim = this.playClaim;
        if (claim === undefined || claim.visit !== visit || claim.finished || claim.timer !== undefined) return;
        claim.timer = window.setTimeout(() => {
            if (this.playClaim?.visit !== visit) return;
            this.playClaim.timer = undefined;
            const current = this.view;
            if (current === undefined || visitKey(current) !== visit) return;
            this.settlePrimaryFocus(current, true);
        }, 50);
    }

    private focusItem(zone: Zone | undefined, item: FocusItem | undefined): void {
        if (zone === undefined || item === undefined) {
            return;
        }
        // The top bar is not a content column. Entering it or leaving it drops the
        // axis, so the next vertical move measures the card rather than the tab.
        // Calendar's filter and day strip are the same kind of chrome. A shelf's
        // first card is a default-focus landing (CalendarView prefers the first
        // item on every shelf), so the next Down must measure that card rather
        // than the day button the axis still holds.
        // Search People is the same kind of landing. TVDetailCastRail uses
        // tvDefaultFocus on the first person, so a filter pill's column must not
        // survive into the next row. A short title row keeps the column that
        // entered it: the next Down still measures that column, not the card
        // the row snapped to.
        const previousItem = this.navigationItem;
        const previousZone = this.lastZone;
        const axis = this.navigationX;
        const calendarChrome = this.view?.name === "calendar" && (zone.id === "filters" || zone.id === "days" || zone.id === "status" || zone.id === "empty" || this.lastZone === "filters" || this.lastZone === "days" || this.lastZone === "status" || this.lastZone === "empty");
        if (zone.id === "nav" || this.lastZone === "nav" || calendarChrome || zone.id === "search-people") this.navigationX = undefined;
        if (this.view?.name === "search" && zone.id === "grid") {
            const ragged = previousZone === "grid" && previousItem !== undefined && axis !== undefined && !framesMeet(previousItem.element, item.element);
            if (!ragged) this.navigationX = undefined;
        }
        this.memory.set(zone.id, item.key);
        this.lastZone = zone.id;
        // Opening the cascade must not replace the content return target.
        if (this.tracksContent(zone.id)) this.contentZone = zone.id;
        this.navigationItem = item;
        const previous = document.activeElement;
        item.element.focus({ preventScroll: true });
        this.scroll.reveal(item.element, this.container, previous);
        if (zone.reading === true) this.alignReading(item.element, previous);
    }

    /** Apple's focus engine shows the leading edge of a tall reading stop: the top coming from above, the bottom from below. */
    private alignReading(element: HTMLElement, previous: Element | null): void {
        const rect = element.getBoundingClientRect();
        const bounds = this.container.getBoundingClientRect();
        if (rect.height <= bounds.height - 2 * READING_INSET || previous === null) return;
        const fromAbove = previous.getBoundingClientRect().top < rect.top;
        const delta = fromAbove ? rect.top - (bounds.top + READING_INSET) : rect.bottom - (bounds.bottom - READING_INSET);
        this.scroll.move(this.container, 0, this.clampScroll(this.container.scrollTop + delta));
    }

    /** Scrolls one step toward the hidden edge; false once that edge is visible, so the move leaves the zone. */
    private readOn(element: HTMLElement, key: "up" | "down"): boolean {
        const rect = element.getBoundingClientRect();
        const bounds = this.container.getBoundingClientRect();
        if (key === "down" ? rect.bottom <= bounds.bottom + 1 : rect.top >= bounds.top - 1) return false;
        const remaining = key === "down" ? rect.bottom - (bounds.bottom - READING_INSET) : (bounds.top + READING_INSET) - rect.top;
        const from = this.container.scrollTop;
        const to = this.clampScroll(from + (key === "down" ? 1 : -1) * Math.min(READING_STEP, remaining));
        if (Math.abs(to - from) < 1) return false;
        this.scroll.move(this.container, 0, to);
        return true;
    }

    private clampScroll(top: number): number {
        return Math.max(0, Math.min(top, this.container.scrollHeight - this.container.clientHeight));
    }

    /** Chrome zones are not a page's content return target. */
    private tracksContent(zoneId: string): boolean {
        return !["nav", "selector", "flyout", "pills"].includes(zoneId);
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
        // A fresh press while a hold is still recorded means that hold's release was lost or swallowed: drop it.
        if (this.press !== undefined && isFreshSelect()) { this.cancelPress(); this.press = undefined; }
        if (this.press !== undefined) { event.preventDefault(); event.stopImmediatePropagation(); return; }
        // Only a fresh press can start a hold: a repeat belongs to a press made before focus arrived here.
        if (event.defaultPrevented || !isFreshSelect()) return;
        const item = this.locate(document.activeElement)?.item;
        // A disabled card takes no press; selectRelease takes Chromium's click from it.
        if (item?.quickAction === undefined || !enabled(item.element)) return;
        // This press is the card's own: a hold opens its menu, a release clicks it.
        event.preventDefault();
        const press = { item, started: performance.now(), timer: undefined as number | undefined, cancelled: false };
        this.press = press;
        this.armPress(press);
    };

    private armPress(press: NonNullable<FocusHost["press"]>): void {
        // A fixed 650 ms separates deliberate holds from ordinary Select presses; tune on TV.
        press.timer = window.setTimeout(() => {
            press.timer = undefined;
            // A card disabled when its hold completes ends the press, so a later release cannot run it either.
            if (!press.cancelled && !enabled(press.item.element)) { press.cancelled = true; return; }
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
        if (activate && press.item.element.isConnected && document.activeElement === press.item.element && enabled(press.item.element) && !document.hidden) {
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
        if ((key === "up" || key === "down" || key === "left" || key === "right") && this.playClaim !== undefined && !this.playClaim.finished) this.playClaim.moved = true;
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
        if ((key === "play" || key === "play_pause") && found.item.play !== undefined) {
            event.preventDefault();
            if (!event.repeat) found.item.play();
            return;
        }
        if (key !== "up" && key !== "down" && key !== "left" && key !== "right") {
            // Enter is left to the browser: selectRelease clicks a button on release, and a field opens the TV keyboard.
            return;
        }
        const inText = document.activeElement instanceof HTMLInputElement;
        if (inText && (key === "left" || key === "right")) {
            return;
        }
        event.preventDefault();
        const { zone, zoneIndex, index } = found;
        if (inText || key === "left" || key === "right" || this.navigationItem?.element !== found.item.element) this.navigationX = undefined;
        if (!inText && (key === "up" || key === "down")) {
            const rect = found.item.element.getBoundingClientRect();
            // A default entry target must not pull a vertical navigation column sideways.
            this.navigationX ??= rect.left + rect.width / 2;
        }
        if (key === "left" && zone.onLeft !== undefined) { zone.onLeft(); return; }
        if (zone.reading === true && (key === "up" || key === "down") && this.readOn(found.item.element, key)) return;
        const target = moveWithin(zone, zone.items.length, index, key);
        if (target !== undefined) {
            this.focusItem(zone, zone.items[target]);
        } else {
            const destination = zone[key];
            const next = view.zones.find(candidate => candidate.id === destination && candidate.items.length > 0);
            if (next !== undefined) this.focusItem(next, this.restoredEntry(next) ?? next.items.find(item => item.key === next.entry) ?? next.items.find(item => item.key === this.memory.get(next.id)) ?? next.items[0]);
            else if (key === "up" || key === "down") this.enterZone(zoneIndex, key === "up" ? -1 : 1, found.item);
        }
    };
}

/** Home stills are wider than they are tall; posters are the other way. Explore all uses the row's art box. */
function landscapeArt(element: HTMLElement): boolean {
    const art = element.querySelector(".browse-art");
    const box = art instanceof HTMLElement ? art : element;
    // Focus transforms can round a square's viewport width above its height.
    return box.offsetWidth > box.offsetHeight;
}

/**
 * People into the title grid take the first column whose left edge is at or past the
 * focused centre. A filter pill into that grid takes the card whose frame meets the pill.
 * Each title row is a full-width focus section, so a move into the row still lands when
 * no card meets. Requests move only onto a card that lines up. People takes a request
 * only when the first person meets it; otherwise the move stays.
 * A short title row keeps the column that entered it, so the next move uses that column.
 * Box sets keep the ordinary nearest-centre move.
 */
function searchVerticalLanding(source: Zone | undefined, destination: Zone, from: HTMLElement, edgeItems: readonly FocusItem[], axisX?: number): FocusItem | "stay" | undefined {
    if (source === undefined) return undefined;
    if (source.id === "search-people" && destination.id === "grid") {
        // A person past the last column still enters that column. The measured rows have a column at or past the centre.
        return columnAtOrPastCenter(edgeItems, from) ?? nearestItem(edgeItems, from);
    }
    if (source.id === "search-filters" && destination.id === "grid") {
        return overlappingNearest(edgeItems, from.getBoundingClientRect()) ?? nearestItem(edgeItems, from);
    }
    const intoRequests = destination.id === "search-requests" && (source.id === "search-people" || source.id === "grid");
    const outOfRequests = source.id === "search-requests" && (destination.id === "grid" || destination.id === "search-people");
    if (!intoRequests && !outOfRequests) return undefined;
    const origin = source.id === "grid" ? columnRect(from, axisX) : from.getBoundingClientRect();
    if (destination.id === "search-people") {
        const first = edgeItems[0];
        return first !== undefined && framesMeetRect(origin, first.element.getBoundingClientRect()) ? first : "stay";
    }
    const meet = overlappingNearest(edgeItems, origin);
    if (meet !== undefined) return meet;
    // TVCatalogGrid gives every row a full-width focus section, so the row catches the move.
    if (destination.id === "grid") return nearestItem(edgeItems, from, axisX) ?? "stay";
    return "stay";
}

function columnRect(element: HTMLElement, axisX: number | undefined): DOMRect {
    const rect = element.getBoundingClientRect();
    if (axisX === undefined) return rect;
    const dx = axisX - (rect.left + rect.width / 2);
    if (Math.abs(dx) < 0.5) return rect;
    return new DOMRect(rect.x + dx, rect.y, rect.width, rect.height);
}

function framesMeet(origin: HTMLElement, target: HTMLElement): boolean {
    return framesMeetRect(origin.getBoundingClientRect(), target.getBoundingClientRect());
}

function framesMeetRect(origin: DOMRect, target: DOMRect): boolean {
    return origin.left < target.right && target.left < origin.right;
}

function columnAtOrPastCenter(items: readonly FocusItem[], from: HTMLElement): FocusItem | undefined {
    const box = from.getBoundingClientRect();
    const center = box.left + box.width / 2;
    return items.find(item => item.element.getBoundingClientRect().left >= center - 0.5);
}

function overlappingNearest(items: readonly FocusItem[], origin: DOMRect): FocusItem | undefined {
    const center = origin.left + origin.width / 2;
    let best: FocusItem | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const item of items) {
        const target = item.element.getBoundingClientRect();
        if (origin.left >= target.right || target.left >= origin.right) continue;
        const distance = Math.abs(target.left + target.width / 2 - center);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = item;
        }
    }
    return best;
}

function nearestItem(items: readonly FocusItem[], from: HTMLElement, navigationX?: number): FocusItem | undefined {
    const centre = (element: HTMLElement): number => { const rect = element.getBoundingClientRect(); return rect.left + rect.width / 2; };
    const x = navigationX ?? centre(from);
    return items.reduce<FocusItem | undefined>((best, item) => best === undefined || Math.abs(centre(item.element) - x) < Math.abs(centre(best.element) - x) ? item : best, undefined);
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
    // Remove replaced siblings first so retained focus/press hosts never need a DOM move.
    const retained = new Set(nodes);
    for (const child of Array.from(container.children)) {
        if (child instanceof HTMLElement && !retained.has(child)) child.remove();
    }
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
