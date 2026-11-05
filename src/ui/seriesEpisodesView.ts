import type { Episode } from "../contracts/v2/catalog.ts";
import type { FocusItem, Zone } from "./browseFocus.ts";
import { actionButton, artwork, lines, mediaItem, thumbnailProgress, type ViewContext, zoneNode } from "./browseViews.ts";
import { el } from "./screen.ts";
import type { SeriesEpisodes } from "./seriesEpisodes.ts";
import { episodeAirDate, episodeRuntime } from "./episodeCaption.ts";

interface EpisodeView { content: HTMLElement[]; zones: Zone[] }
const visits = new WeakMap<SeriesEpisodes, { context: ViewContext; episodes: readonly Episode[] | undefined; season: number | undefined; loading: boolean; failed: boolean; boundaryFailed: boolean; view: EpisodeView }>();

export function seriesEpisodesView(state: SeriesEpisodes, context: ViewContext, focusEpisode?: (id: string) => void, currentEpisode?: string): { content: HTMLElement[]; zones: Zone[] } {
    const previous = visits.get(state);
    // A hero repaint must not detach the episode receiving a pointer press or held Select.
    if (previous !== undefined && previous.context.baseUrl === context.baseUrl && previous.episodes === state.railEpisodes && previous.season === state.seasonNumber && previous.loading === state.loading && previous.failed === state.failed && previous.boundaryFailed === state.boundaryFailed) {
        for (const node of previous.view.content) { node.inert = false; node.removeAttribute("aria-hidden"); }
        for (const item of previous.view.zones[1]?.items ?? []) {
            if (item.key === currentEpisode) item.element.setAttribute("aria-current", "true"); else item.element.removeAttribute("aria-current");
        }
        const row = previous.view.zones[1]?.items[0]?.element.closest<HTMLElement>(".details-episodes");
        if (row !== null && row !== undefined && state.entryEpisode !== undefined) row.dataset.scrollEntry = state.entryEpisode;
        return previous.view;
    }
    const seasons = state.seasons.map(season => {
        const item = actionButton(`season:${season.seasonNumber}`, season.title, () => state.select(season.seasonNumber));
        let dwell: ReturnType<typeof setTimeout> | undefined;
        item.element.addEventListener("focus", () => {
            if (season.seasonNumber === state.seasonNumber) return;
            dwell = setTimeout(() => {
                if (item.element.isConnected && document.activeElement === item.element) state.select(season.seasonNumber);
            }, 70);
        });
        item.element.addEventListener("blur", () => clearTimeout(dwell));
        item.element.setAttribute("aria-pressed", String(season.seasonNumber === state.seasonNumber));
        return mediaItem(item, { id: season.id, title: season.title, type: "season" }, context);
    });
    const content = [zoneNode("browse-row details-season-chips", seasons)];
    content[0]!.dataset.scrollEntry = `season:${state.seasonNumber}`;
    const episodes = (state.railEpisodes ?? []).map(episode => {
        const item = episodeCard(episode, context);
        if (episode.id === currentEpisode) item.element.setAttribute("aria-current", "true");
        item.element.addEventListener("focus", () => { state.entryEpisode = episode.id; delete row.dataset.scrollEntry; focusEpisode?.(episode.id); state.focus(episode.id); });
        item.element.addEventListener("blur", () => state.blur());
        return item;
    });
    const row = zoneNode("browse-row details-episodes", episodes);
    if (state.entryEpisode !== undefined) row.dataset.scrollEntry = state.entryEpisode;
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
    if (state.boundaryFailed) {
        const retry = actionButton("retry-neighbors", "Retry more episodes", () => state.retryNeighbors());
        episodes.push(retry);
        section.append(...lines(["Could not load more episodes."], "error"), zoneNode("browse-actions", [retry]));
    }
    content.push(section);
    const view: EpisodeView = { content, zones: [{ id: "seasons", layout: "row", items: seasons, get entry() { return `season:${state.seasonNumber}`; } }, { id: "episodes", layout: "row", items: episodes, get entry() { return state.entryEpisode; } }] };
    visits.set(state, { context, episodes: state.railEpisodes, season: state.seasonNumber, loading: state.loading, failed: state.failed, boundaryFailed: state.boundaryFailed, view });
    return view;
}

function episodeCard(episode: Episode, context: ViewContext): FocusItem {
    const element = el("button", "browse-card skyline-continue");
    element.type = "button";
    element.tabIndex = -1;
    element.setAttribute("data-focus", episode.id);
    const code = `S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")}`;
    element.append(artwork("browse-art browse-still", episode.stillUrl, context.baseUrl, episode.title), el("span", "browse-card-title", `${code} · ${episode.title}`));
    element.appendChild(el("span", "browse-card-subtitle", [episodeAirDate(episode.airDate), episodeRuntime(episode.runtimeMinutes)].filter(Boolean).join("  ·  ")));
    const position = episode.positionSeconds, duration = episode.durationSeconds;
    if (position !== undefined && duration !== undefined && duration > 0 && position > 0 && position < duration) {
        element.firstElementChild?.appendChild(thumbnailProgress(position / duration));
    }
    if (episode.played) { const badge = el("span", "browse-watched"); badge.setAttribute("aria-label", "Watched"); element.firstElementChild?.appendChild(badge); }
    // Anchoring on mouse-down moves the button away before mouse-up can click it.
    element.addEventListener("mousedown", event => event.preventDefault());
    element.addEventListener("click", () => {
        element.focus({ preventScroll: true });
        if (context.playEpisode === undefined) context.open({ kind: "item", id: episode.id, title: episode.title });
        else context.playEpisode(episode.id, episode.title);
    });
    return mediaItem({ key: episode.id, element }, { id: episode.id, title: episode.title, type: "episode" }, context);
}
