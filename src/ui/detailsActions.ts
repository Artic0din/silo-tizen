import type { DetailsState } from "./detailsState.ts";
import type { FocusItem, View } from "./browseFocus.ts";
import { actionButton, zoneNode } from "./browseViews.ts";
import { el } from "./screen.ts";

const ICONS: Readonly<Record<string, string>> = {
    play: "M8 4 21 12 8 20Z",
    resume: "M8 4 21 12 8 20Z",
    "next-episode": "M8 4 21 12 8 20Z",
    version: "M2 7 12 2 22 7 12 12ZM2 12 12 17 22 12M2 17 12 22 22 17",
    audio: "M3 9H7L13 4V20L7 15H3ZM17 8Q23 12 17 16",
    subtitles: "M3 5H21V19H3ZM6 11H10M6 14H11M14 11H18M14 14H18",
    watchlist: "M6 3H18V22L12 18 6 22Z",
    more: "M4 12H5M11 12H12M18 12H19",
};

export function detailAction(item: FocusItem): FocusItem {
    const startOver = item.key === "play" && item.element.textContent === "Play from start";
    const path = startOver ? "M5 4V20M19 4 7 12 19 20Z" : ICONS[item.key];
    if (path === undefined) return item;
    const button = item.element;
    const accessibleLabel = button.textContent ?? "";
    const label = item.key === "version" ? "Versions" : item.key === "audio" ? "Audio Tracks" : item.key === "subtitles" ? "Subtitles" : accessibleLabel;
    button.textContent = "";
    button.setAttribute("aria-label", accessibleLabel);
    button.classList.add("details-action", !startOver && (item.key === "play" || item.key === "resume" || item.key === "next-episode") ? "details-play" : "details-circle");
    // Pointer focus would expand this pill between press and release, moving its click target.
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", () => button.focus({ preventScroll: true }), { capture: true });
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", item.key === "more" ? "4" : "1.8");
    const shape = document.createElementNS(icon.namespaceURI, "path");
    shape.setAttribute("d", path);
    if (["play", "resume", "next-episode"].includes(item.key)) shape.setAttribute("fill", "currentColor");
    if (item.key === "watchlist" && button.getAttribute("aria-pressed") === "true") shape.setAttribute("fill", "currentColor");
    icon.appendChild(shape);
    button.append(icon, el("span", "details-action-label", label));
    return item;
}

export function ratingControls(state: DetailsState): { items: FocusItem[]; note: HTMLElement } {
    const rating = state.rating;
    const items = [1, 2, 3, 4, 5].map(stars => {
        const item = actionButton(`rating:${stars}`, `${stars} ${stars === 1 ? "star" : "stars"}`, () => rating.save(stars));
        item.element.setAttribute("aria-pressed", String(rating.value === stars));
        item.element.setAttribute("aria-disabled", String(state.busy || rating.loading || rating.value === undefined));
        return item;
    });
    const clear = actionButton("rating:clear", "Clear rating", () => rating.save(null));
    clear.element.setAttribute("aria-disabled", String(state.busy || rating.loading || rating.value === undefined));
    items.push(clear);
    if (rating.failed) {
        const retry = actionButton("rating:retry", "Retry rating", () => rating.failedTarget === undefined ? rating.load() : rating.save(rating.failedTarget, true));
        retry.element.setAttribute("aria-disabled", String(state.busy || rating.loading || rating.pending));
        items.push(retry);
    }
    const status = rating.failed ? "Could not confirm rating." : rating.pending ? "Saving rating…" : rating.loading ? "Loading rating…" : rating.value == null ? "Your rating: Not rated" : `Your rating: ${rating.value} of 5 stars`;
    const note = el("p", "browse-text", status);
    note.setAttribute("role", rating.failed ? "alert" : "status");
    return { items, note };
}

export function detailPanel(view: View, state: DetailsState, title: string, items: FocusItem[], notes: HTMLElement[] = []): View {
    const underlying = view.content.filter(node => !notes.includes(node));
    const name = state.panel ?? "more";
    const panel = el("div", "skyline-selector details-audio-picker");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", title);
    panel.append(el("h2", "browse-section-title", ["audio", "subtitles", "version"].includes(name) ? title.toUpperCase() : title), ...notes, zoneNode("details-audio-options", items));
    const popover = ["audio", "subtitles", "version"].includes(name);
    if (popover) {
        panel.classList.add("details-track-popover");
        for (const item of items) {
            const title = item.element.firstChild;
            if (title?.nodeType === Node.TEXT_NODE) title.replaceWith(el("span", "details-option-title", title.textContent ?? ""));
        }
        const anchor = document.querySelector<HTMLElement>(`.details-editorial [data-focus="${name}"]`)?.getBoundingClientRect();
        if (anchor !== undefined) {
            const screenInset = 48;
            const anchorGap = 14;
            panel.style.left = `${Math.max(screenInset, Math.min(anchor.left, 1920 - screenInset - 560))}px`;
            panel.style.top = `${anchor.bottom + 14}px`;
            panel.style.boxSizing = "border-box";
            panel.style.maxHeight = `${1080 - screenInset * 2}px`;
            // Measure after FocusHost attaches the panel, before the first paint.
            queueMicrotask(() => {
                if (!panel.isConnected) return;
                const height = panel.offsetHeight;
                const below = anchor.bottom + anchorGap;
                const above = anchor.top - anchorGap - height;
                const top = below + height <= 1080 - screenInset ? below : above >= screenInset ? above : Math.max(screenInset, 1080 - screenInset - height);
                panel.style.top = `${top}px`;
            });
        }
        const auto = items[0];
        if (auto !== undefined) auto.element.append(el("small", "details-option-subtext", name === "audio" ? "Use your Playback audio preference" : name === "subtitles" ? "Use your subtitle preferences" : "Best match for this device"));
    }
    const scrim = el("div", "skyline-dropdown-scrim");
    if (popover) {
        const trigger = underlying.flatMap(node => Array.from(node.querySelectorAll<HTMLElement>(`[data-focus="${name}"]`)))[0];
        trigger?.setAttribute("aria-expanded", "true");
    }
    scrim.addEventListener("click", () => state.closePanel());
    for (const node of underlying) { node.inert = true; node.setAttribute("aria-hidden", "true"); }
    const selected = popover ? items[0] : items.find(item => item.element.getAttribute("aria-checked") === "true") ?? items[0];
    return { name: `${view.name}:${name}`, content: [...underlying, ...popover ? [] : [scrim], panel], zones: [{ id: name, layout: "column", items }], focus: selected === undefined ? undefined : { zone: name, key: selected.key }, back: () => state.closePanel() };
}
