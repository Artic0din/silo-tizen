import type { DetailsState } from "./detailsState.ts";
import type { FocusItem, View } from "./browseFocus.ts";
import { zoneNode } from "./browseViews.ts";
import { el } from "./screen.ts";
import { remoteKey } from "./keys.ts";
import { icon as libraryIcon } from "./libraryBrowseViews.ts";

const ICONS: Readonly<Record<string, string>> = {
    play: "M8 4 21 12 8 20Z",
    resume: "M8 4 21 12 8 20Z",
    "next-episode": "M8 4 21 12 8 20Z",
    version: "M7 2H17M5 5H19M4 8H20V22H4Z",
    audio: "M3 9H7L13 4V20L7 15H3ZM17 8Q23 12 17 16",
    subtitles: "M5 4H19Q22 4 22 7V15Q22 18 19 18H10L5 22V18Q2 18 2 15V7Q2 4 5 4ZM6 9H11M6 13H10M14 9H18M13 13H18",
    watchlist: "M6 3H18V22L12 18 6 22Z",
    more: "M4 12H5M11 12H12M18 12H19",
};

export function detailAction(item: FocusItem): FocusItem {
    const startOver = item.key === "start-over-episode" || item.key === "play" && item.element.textContent === "Start Over";
    const path = startOver ? "M5 4V20M19 4 7 12 19 20Z" : ICONS[item.key];
    if (path === undefined) return item;
    const button = item.element;
    const accessibleLabel = startOver ? "Start Over" : button.textContent ?? "";
    const label = item.key === "version" ? "Versions" : item.key === "audio" ? "Audio Tracks" : item.key === "subtitles" ? "Subtitles" : item.key === "watchlist" ? "Watchlist" : accessibleLabel;
    button.textContent = "";
    button.setAttribute("aria-label", accessibleLabel);
    button.classList.add("details-action", !startOver && (item.key === "play" || item.key === "resume" || item.key === "next-episode") ? "details-play" : "details-circle");
    // Pointer focus would expand this pill between press and release, moving its click target.
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", () => button.focus({ preventScroll: true }), { capture: true });
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    if (item.key === "subtitles") icon.dataset.symbol = "captions.bubble";
    if (startOver) icon.dataset.symbol = "backward.end.fill";
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", item.key === "more" ? "4" : "1.8");
    const shape = document.createElementNS(icon.namespaceURI, "path");
    shape.setAttribute("d", path);
    if (startOver || ["play", "resume", "next-episode"].includes(item.key)) shape.setAttribute("fill", "currentColor");
    if (item.key === "watchlist" && button.getAttribute("aria-pressed") === "true") shape.setAttribute("fill", "currentColor");
    icon.appendChild(shape);
    if (item.key === "more") {
        icon.dataset.symbol = "ellipsis";
        shape.remove();
        for (const x of [5, 12, 19]) {
            const dot = document.createElementNS(icon.namespaceURI, "circle");
            dot.setAttribute("cx", String(x));
            dot.setAttribute("cy", "12");
            dot.setAttribute("r", "1.9");
            dot.setAttribute("fill", "currentColor");
            dot.setAttribute("stroke", "none");
            icon.append(dot);
        }
    }
    button.append(icon, el("span", "details-action-label", label));
    return item;
}

export function detailPanel(view: View, state: DetailsState, title: string, items: FocusItem[], notes: HTMLElement[] = []): View {
    const underlying = view.content.filter(node => !notes.includes(node));
    const name = state.panel ?? "more";
    const panel = el("div", "skyline-selector details-audio-picker");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", title);
    const popover = ["audio", "subtitles", "version", "more"].includes(name);
    panel.append(el("h2", "browse-section-title", popover ? title.toUpperCase() : title), ...notes, zoneNode("details-audio-options", items));
    if (popover) {
        panel.classList.add("details-track-popover");
        if (name === "more") panel.classList.add("details-more-popover");
        for (const item of items) {
            const title = item.element.firstChild;
            if (title?.nodeType === Node.TEXT_NODE) title.replaceWith(el("span", "details-option-title", title.textContent ?? ""));
            if (name === "more" && ["shuffle-series", "favorites", "watched", "season-watched", "series-overview", "find-trailers", "translate-description"].includes(item.key)) {
                const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                icon.setAttribute("viewBox", "0 0 24 24");
                icon.setAttribute("aria-hidden", "true");
                icon.setAttribute("fill", "none");
                icon.setAttribute("stroke", "currentColor");
                icon.setAttribute("stroke-width", "2");
                const path = document.createElementNS(icon.namespaceURI, "path");
                path.setAttribute("d", item.key === "favorites" ? "M12 21 3 12C-3 3 8-1 12 6 16-1 27 3 21 12Z" : item.key === "series-overview" ? "M12 11V17M12 7V8M22 12A10 10 0 1 1 2 12 10 10 0 0 1 22 12" : "M7 12 10 15 17 8M22 12A10 10 0 1 1 2 12 10 10 0 0 1 22 12");
                const selected = item.key === "favorites" ? state.values.get("favorites") === true : item.key === "season-watched" ? state.series?.seasonNumber !== undefined && state.seasonStates.get(state.series.seasonNumber)?.values.get("watched") === true : state.values.get("watched") === true;
                icon.dataset.symbol = item.key === "favorites" ? selected ? "heart.fill" : "heart" : item.key === "series-overview" ? "info.circle" : selected ? "checkmark.circle.fill" : "checkmark.circle";
                if (item.key === "favorites" && selected) path.setAttribute("fill", "currentColor");
                if (["watched", "season-watched"].includes(item.key) && selected) {
                    const circle = document.createElementNS(icon.namespaceURI, "circle");
                    circle.setAttribute("cx", "12"); circle.setAttribute("cy", "12"); circle.setAttribute("r", "10"); circle.setAttribute("fill", "currentColor");
                    icon.append(circle);
                    path.setAttribute("d", "M7 12 10 15 17 8");
                    path.setAttribute("stroke", "var(--icon-ink, #000)");
                }
                if (item.key === "shuffle-series") {
                    icon.dataset.symbol = "shuffle";
                    icon.replaceChildren(...Array.from(libraryIcon("shuffle").querySelector("svg")?.childNodes ?? []));
                }
                if (item.key === "find-trailers") {
                    icon.dataset.symbol = "film.stack";
                    path.setAttribute("d", "M3 6H21V21H3ZM6 3H18M3 11H21M3 16H21M7 6V21M17 6V21");
                }
                if (item.key === "translate-description") {
                    icon.dataset.symbol = "translate";
                    path.setAttribute("d", "M2 5H14M8 2V5M5 5C5 11 10 14 14 15M12 5C12 11 7 14 3 15M13 22 18 10 23 22M15 18H21");
                }
                if (item.key !== "shuffle-series") icon.append(path);
                item.element.prepend(icon);
                icon.classList.add("details-more-icon");
            }
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
        if (auto !== undefined && name !== "more") auto.element.append(el("small", "details-option-subtext", name === "audio" ? "Use your Playback audio preference" : name === "subtitles" ? "Use your subtitle preferences" : "Best match for this device"));
    }
    const scrim = el("div", "skyline-dropdown-scrim");
    if (popover) {
        const trigger = underlying.flatMap(node => Array.from(node.querySelectorAll<HTMLElement>(`[data-focus="${name}"]`)))[0];
        trigger?.setAttribute("aria-expanded", "true");
    }
    scrim.addEventListener("click", () => state.closePanel());
    if (name === "more") panel.addEventListener("keydown", event => {
        if (remoteKey(event) === "left" || remoteKey(event) === "right") {
            event.preventDefault(); event.stopPropagation(); state.closePanel();
        }
    });
    for (const node of underlying) { node.inert = true; node.setAttribute("aria-hidden", "true"); }
    const selected = popover ? items[0] : items.find(item => item.element.getAttribute("aria-checked") === "true") ?? items[0];
    return { name: `${view.name}:${name}`, content: [...underlying, ...popover ? [] : [scrim], panel], zones: [{ id: name, layout: "column", items }], focus: selected === undefined ? undefined : { zone: name, key: selected.key }, back: () => state.closePanel() };
}
