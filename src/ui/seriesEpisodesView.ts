import type { Episode } from "../contracts/v2/catalog.ts";
import type { FocusItem, Zone } from "./browseFocus.ts";
import { actionButton, artwork, lines, mediaItem, type ViewContext, zoneNode } from "./browseViews.ts";
import { el } from "./screen.ts";
import type { SeriesEpisodes } from "./seriesEpisodes.ts";
import { episodeLabel } from "./browseModel.ts";

export function seriesEpisodesView(state: SeriesEpisodes, context: ViewContext): { content: HTMLElement[]; zones: Zone[] } {
    const seasons = state.seasons.map(season => {
        const item = actionButton(`season:${season.seasonNumber}`, season.title, () => state.select(season.seasonNumber));
        item.element.setAttribute("aria-pressed", String(season.seasonNumber === state.seasonNumber));
        return mediaItem(item, { id: season.id, title: season.title, type: "season" }, context);
    });
    const content = [zoneNode("browse-row details-season-chips", seasons)];
    const episodes = (state.episodes ?? []).map(episode => {
        const item = episodeCard(episode, context);
        item.element.addEventListener("focus", () => { state.entryEpisode = undefined; });
        return item;
    });
    const row = zoneNode("browse-row details-episodes", episodes);
    const section = el("section", "home-section details-series-rail");
    section.setAttribute("aria-label", "Episodes");
    if (state.failed) {
        const retry = actionButton("retry-episodes", "Retry episodes", () => state.retry());
        episodes.push(retry);
        section.append(...lines(["Could not load episodes."], "error"), zoneNode("browse-actions", [retry]));
    } else if (state.episodes === undefined) section.append(...lines(["Loading episodes…"]));
    else if (state.loading) section.append(...lines(["Refreshing episodes…"]));
    else if (episodes.length === 0) section.append(...lines(["This season has no episodes yet."]));
    section.appendChild(row);
    content.push(section);
    return { content, zones: [{ id: "seasons", layout: "row", items: seasons }, { id: "episodes", layout: "row", items: episodes, get entry() { return state.entryEpisode; } }] };
}

function episodeCard(episode: Episode, context: ViewContext): FocusItem {
    const element = el("button", "browse-card skyline-continue");
    element.type = "button";
    element.tabIndex = -1;
    element.setAttribute("data-focus", episode.id);
    element.append(artwork("browse-art browse-still", episode.stillUrl, context.baseUrl, episode.title), el("span", "browse-card-title", `${episodeLabel(episode.seasonNumber, episode.episodeNumber)} · ${episode.title}`));
    element.appendChild(el("span", "browse-card-subtitle", episode.runtimeMinutes > 0 ? `${episode.runtimeMinutes >= 60 ? `${Math.floor(episode.runtimeMinutes / 60)}h ` : ""}${episode.runtimeMinutes % 60}m` : ""));
    if (episode.played) { const badge = el("span", "browse-watched", "✓"); badge.setAttribute("aria-label", "Watched"); element.appendChild(badge); }
    element.addEventListener("click", () => context.playEpisode === undefined ? context.open({ kind: "item", id: episode.id, title: episode.title }) : context.playEpisode(episode.id, episode.title));
    return mediaItem({ key: episode.id, element }, { id: episode.id, title: episode.title, type: "episode" }, context);
}
