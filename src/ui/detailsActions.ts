import type { DetailsState } from "./detailsState.ts";
import type { FocusItem, View } from "./browseFocus.ts";
import { actionButton, zoneNode } from "./browseViews.ts";
import { el } from "./screen.ts";

const ICONS: Readonly<Record<string, string>> = {
    play: "M8 4 21 12 8 20Z",
    resume: "M8 4 21 12 8 20Z",
    version: "M3 4H21V20H3ZM3 9H21M8 4 11 9M15 4 18 9",
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
    const label = button.textContent ?? "";
    button.textContent = "";
    button.setAttribute("aria-label", label);
    button.classList.add("details-action", !startOver && (item.key === "play" || item.key === "resume") ? "details-play" : "details-circle");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", item.key === "more" ? "4" : "1.8");
    const shape = document.createElementNS(icon.namespaceURI, "path");
    shape.setAttribute("d", path);
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
    panel.append(el("h2", "browse-section-title", title), ...notes, zoneNode("details-audio-options", items));
    const scrim = el("div", "skyline-dropdown-scrim");
    scrim.addEventListener("click", () => state.closePanel());
    for (const node of underlying) { node.inert = true; node.setAttribute("aria-hidden", "true"); }
    const selected = items.find(item => item.element.getAttribute("aria-checked") === "true") ?? items[0];
    return { name: `${view.name}:${name}`, content: [...underlying, scrim, panel], zones: [{ id: name, layout: "column", items }], focus: selected === undefined ? undefined : { zone: name, key: selected.key }, back: () => state.closePanel() };
}
