// DOM for item pages (movie, series, episode) and a season's episode list.

import type { Episode, ItemDetail, Season } from "../contracts/v2/catalog.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { clockTime, episodeLabel, playChoices, type PlayRequest } from "./browseModel.ts";
import { actionButton, artwork, heading, lines, type ViewContext, zoneNode } from "./browseViews.ts";
import { el } from "./screen.ts";
import { SkylineScroll } from "./skylineScroll.ts";
import { remoteKey } from "./keys.ts";

function synopsisAction(text: string): FocusItem {
    const scroll = new SkylineScroll();
    const action = actionButton("synopsis", "Read synopsis", () => {
        const panel = el("div", "skyline-synopsis-dialog");
        panel.tabIndex = 0;
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-modal", "true");
        panel.setAttribute("aria-label", "Synopsis");
        panel.appendChild(el("p", "browse-text", text));
        const close = (): void => {
            scroll.stop();
            panel.remove();
            action.element.focus({ preventScroll: true });
        };
        const closeButton = actionButton("close-synopsis", "Close synopsis", close);
        panel.prepend(closeButton.element);
        panel.addEventListener("keydown", (event) => {
            event.stopPropagation();
            const key = remoteKey(event);
            if (key === "down" || key === "up") {
                event.preventDefault();
                scroll.move(panel, 0, Math.max(0, Math.min(panel.scrollHeight - panel.clientHeight, panel.scrollTop + (key === "down" ? 240 : -240))));
            } else if (key === "back" || key === "enter") {
                event.preventDefault();
                close();
            } else if (event.key === "Tab") {
                event.preventDefault();
                closeButton.element.focus({ preventScroll: true });
            }
        });
        action.element.closest(".browse")?.appendChild(panel);
        panel.focus({ preventScroll: true });
    });
    return action;
}

function metaLine(detail: ItemDetail): string {
    const parts: string[] = [];
    if (detail.year !== undefined) {
        parts.push(String(detail.year));
    }
    if (detail.runtimeMinutes !== undefined && detail.runtimeMinutes > 0) {
        parts.push(`${detail.runtimeMinutes} min`);
    }
    if (detail.contentRating !== undefined && detail.contentRating !== "") {
        parts.push(detail.contentRating);
    }
    return [...parts, ...detail.genres.slice(0, 3)].join(" · ");
}

function detailHeader(detail: ItemDetail, context: ViewContext): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    const label = episodeLabel(detail.seasonNumber, detail.episodeNumber);
    if (detail.type === "episode" && (detail.seriesTitle !== undefined || label !== undefined)) {
        nodes.push(el("p", "browse-kicker", [detail.seriesTitle, label].filter((part) => part !== undefined).join(" · ")));
    }
    nodes.push(heading(detail.title));
    const meta = metaLine(detail);
    if (meta !== "") {
        nodes.push(el("p", "browse-meta", meta));
    }
    if (detail.overview !== undefined && detail.overview !== "") {
        nodes.push(el("p", "browse-text browse-overview", detail.overview));
    }
    const layout = el("div", "browse-detail");
    layout.appendChild(artwork("browse-art browse-detail-art", detail.posterUrl, context.baseUrl, detail.title));
    const info = el("div", "browse-detail-info");
    for (const node of nodes) {
        info.appendChild(node);
    }
    layout.appendChild(info);
    return [layout];
}

export function itemView(detail: ItemDetail, seasons: readonly Season[], context: ViewContext, play: (request: PlayRequest) => void, back: () => void): View {
    const actions: FocusItem[] = [];
    const notes: string[] = [];
    const choices = playChoices(detail);
    if (choices?.resume !== undefined) {
        const resume = choices.resume;
        actions.push(actionButton("resume", `Resume from ${clockTime(resume.startSeconds ?? 0)}`, () => play(resume)));
        actions.push(actionButton("play", "Play from start", () => play(choices.fromStart)));
    } else if (choices !== undefined) {
        actions.push(actionButton("play", "Play", () => play(choices.fromStart)));
    } else if (detail.type === "movie" || detail.type === "episode") {
        notes.push("This title has no file this TV can play.");
    }
    const next = detail.playContentId;
    if (detail.type === "series" && next !== undefined) {
        actions.push(actionButton("next-episode", "Next episode", () => context.open({ kind: "item", id: next, title: detail.title })));
    }
    const seasonItems = detail.type === "series" ? seasons.map((season) => seasonItem(detail.id, detail.title, season, context)) : [];
    if (detail.overview) actions.push(synopsisAction(detail.overview));
    if (detail.type === "series" && seasonItems.length === 0) {
        notes.push("This series has no seasons yet.");
    }
    if (actions.length === 0 && seasonItems.length === 0) {
        actions.push(actionButton("back", "Back", back));
    }
    const content = [...detailHeader(detail, context), ...lines(notes), zoneNode("browse-actions", actions)];
    if (seasonItems.length > 0) {
        content.push(el("h2", "browse-section-title", "Seasons"), zoneNode("browse-row", seasonItems));
    }
    const zones: Zone[] = [
        { id: "actions", layout: "row", items: actions },
        { id: "seasons", layout: "row", items: seasonItems },
    ];
    const first = actions[0] ?? seasonItems[0];
    return { name: `item:${detail.id}`, content, zones, focus: first === undefined ? undefined : { zone: actions[0] === undefined ? "seasons" : "actions", key: first.key }, back };
}

function seasonItem(seriesId: string, seriesTitle: string, season: Season, context: ViewContext): FocusItem {
    const key = `season:${season.seasonNumber}`;
    const element = el("button", "browse-card");
    element.type = "button";
    element.setAttribute("data-focus", key);
    element.appendChild(artwork("browse-art", season.posterUrl, context.baseUrl, season.title));
    element.appendChild(el("span", "browse-card-title", season.title));
    element.appendChild(el("span", "browse-card-subtitle", season.episodeCount === 1 ? "1 episode" : `${season.episodeCount} episodes`));
    element.addEventListener("click", () => context.open({ kind: "season", seriesId, seasonNumber: season.seasonNumber, title: `${seriesTitle} · ${season.title}` }));
    return { key, element };
}

export function seasonView(name: string, title: string, episodes: readonly Episode[], context: ViewContext, back: () => void): View {
    const items = episodes.map((episode): FocusItem => {
        const element = el("button", "browse-episode");
        element.type = "button";
        element.setAttribute("data-focus", episode.id);
        element.appendChild(artwork("browse-art browse-still", episode.stillUrl, context.baseUrl, episode.title));
        const info = el("span", "browse-episode-info");
        info.appendChild(el("span", "browse-card-title", `${episode.episodeNumber}. ${episode.title}`));
        const runtime = episode.runtimeMinutes > 0 ? `${episode.runtimeMinutes} min` : "";
        info.appendChild(el("span", "browse-card-subtitle", [runtime, episode.played ? "Watched" : ""].filter((part) => part !== "").join(" · ")));
        element.appendChild(info);
        element.addEventListener("click", () => context.open({ kind: "item", id: episode.id, title: episode.title }));
        return { key: episode.id, element };
    });
    const content = [heading(title), ...(items.length === 0 ? lines(["This season has no episodes yet."]) : []), zoneNode("browse-episodes", items)];
    const fallback = items.length === 0 ? [actionButton("back", "Back", back)] : [];
    if (fallback.length > 0) {
        content.push(zoneNode("browse-actions", fallback));
    }
    const zones: Zone[] = [
        { id: "episodes", layout: "column", items },
        { id: "status", layout: "row", items: fallback },
    ];
    const first = items[0] ?? fallback[0];
    return { name, content, zones, focus: first === undefined ? undefined : { zone: items[0] === undefined ? "status" : "episodes", key: first.key }, back };
}
