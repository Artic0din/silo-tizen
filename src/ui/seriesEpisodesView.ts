import type { Episode, Season } from "../contracts/v2/catalog.ts";
import type { FocusItem, Zone } from "./browseFocus.ts";
import { actionButton, artwork, mediaItem, thumbnailProgress, type ViewContext, zoneNode } from "./browseViews.ts";
import { blurEpisodeStill, hidesEpisodeListStill } from "./episodeSpoilers.ts";
import { el } from "./screen.ts";
import type { SeriesEpisodes } from "./seriesEpisodes.ts";
import { episodeAirDate, episodeRuntime } from "./episodeCaption.ts";
import { defaultArtwork } from "./defaultArtwork.ts";
import { orderedEpisodeSeasons } from "./episodeRail.ts";

/** TVSeriesDetailView.seasonLabel: the season's title, else "Specials" or "Season N". */
export function seasonLabel(season: Season): string {
    if (season.title.trim() !== "") return season.title;
    return season.seasonNumber === 0 ? "Specials" : `Season ${season.seasonNumber}`;
}

/** SeriesEpisodeWindow.orderedSeasons: by number, Specials last, one pill per number. */
function orderedSeasons(seasons: readonly Season[]): Season[] {
    return orderedEpisodeSeasons(seasons).flatMap(number => seasons.find(season => season.seasonNumber === number) ?? []);
}

/** TVEpisodeRailPlaceholder: four still-sized cards with two caption bars. */
function episodePlaceholders(): HTMLElement {
    const row = el("div", "browse-row details-episodes details-episodes-placeholder");
    row.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 4; index++) {
        const card = el("div", "details-episode-placeholder");
        card.append(el("span", "details-episode-placeholder-still"), el("span", "details-episode-placeholder-title"), el("span", "details-episode-placeholder-meta"));
        row.append(card);
    }
    return row;
}

interface EpisodeView { content: HTMLElement[]; zones: Zone[] }
const visits = new WeakMap<SeriesEpisodes, { context: ViewContext; episodes: readonly Episode[] | undefined; season: number | undefined; loading: boolean; failed: boolean; boundaryFailed: boolean; hidesImages: boolean; view: EpisodeView }>();

/** TVSeriesDetailView.swift:578-589: four pills hold the row; they show only while seasons load. */
function seasonPlaceholders(loading: boolean): HTMLElement {
    const row = el("div", "browse-row details-season-placeholders");
    row.setAttribute("aria-hidden", "true");
    row.classList.toggle("details-season-placeholders-hidden", !loading);
    for (let index = 0; index < 4; index++) row.append(el("span", "details-season-placeholder"));
    return row;
}

export function seriesEpisodesView(state: SeriesEpisodes, context: ViewContext, focusEpisode?: (id: string) => void, currentEpisode?: string, blurEpisode?: (id: string) => void): { content: HTMLElement[]; zones: Zone[] } {
    const previous = visits.get(state);
    const hidesImages = context.spoilers?.().hidesImages === true;
    // A hero repaint must not detach the episode receiving a pointer press or held Select.
    if (previous !== undefined && previous.context.baseUrl === context.baseUrl && previous.episodes === state.railEpisodes && previous.season === state.seasonNumber && previous.loading === state.loading && previous.failed === state.failed && previous.boundaryFailed === state.boundaryFailed && previous.hidesImages === hidesImages) {
        for (const node of previous.view.content) { node.inert = false; node.removeAttribute("aria-hidden"); }
        for (const item of previous.view.zones[1]?.items ?? []) {
            if (item.key === currentEpisode) item.element.setAttribute("aria-current", "true"); else item.element.removeAttribute("aria-current");
        }
        const row = previous.view.zones[1]?.items[0]?.element.closest<HTMLElement>(".details-episodes");
        if (row !== null && row !== undefined) {
            if (state.windowReachesSeriesStart) row.dataset.windowOrigin = "series-start";
            else delete row.dataset.windowOrigin;
            if (state.entryEpisode !== undefined) row.dataset.scrollEntry = state.entryEpisode;
        }
        return previous.view;
    }
    const seasons = orderedSeasons(state.seasons).map(season => {
        const retained = previous?.view.zones[0]?.items.find(item => item.key === `season:${season.seasonNumber}`);
        if (retained !== undefined) {
            retained.element.setAttribute("aria-pressed", String(season.seasonNumber === state.seasonNumber));
            return retained;
        }
        const item = actionButton(`season:${season.seasonNumber}`, seasonLabel(season), () => state.select(season.seasonNumber));
        item.element.addEventListener("focus", () => state.focusSeason(season.seasonNumber));
        item.element.addEventListener("blur", () => state.blurSeason());
        item.element.setAttribute("aria-pressed", String(season.seasonNumber === state.seasonNumber));
        return mediaItem(item, { id: season.id, title: seasonLabel(season), type: "season", seasonPill: true }, context);
    });
    const content = [seasons.length === 0 ? seasonPlaceholders(state.loading) : previous?.view.content[0]?.classList.contains("details-season-chips") === true ? previous.view.content[0] : zoneNode("browse-row details-season-chips", seasons)];
    if (seasons.length > 0) content[0]!.dataset.scrollEntry = `season:${state.seasonNumber}`;
    const episodes = (state.railEpisodes ?? []).map(episode => {
        const item = episodeCard(episode, context);
        if (episode.id === currentEpisode) item.element.setAttribute("aria-current", "true");
        item.element.addEventListener("focus", () => { state.entryEpisode = episode.id; delete row.dataset.scrollEntry; state.focus(episode.id); focusEpisode?.(episode.id); });
        item.element.addEventListener("blur", () => { state.blur(); blurEpisode?.(episode.id); });
        return item;
    });
    const row = zoneNode("browse-row details-episodes", episodes);
    if (state.windowReachesSeriesStart) row.dataset.windowOrigin = "series-start";
    if (state.entryEpisode !== undefined) row.dataset.scrollEntry = state.entryEpisode;
    const section = el("section", "home-section details-series-rail");
    section.setAttribute("aria-label", "Episodes");
    const zones: Zone[] = [{ id: "seasons", layout: "row", items: seasons, get entry() { return `season:${state.seasonNumber}`; } }, { id: "episodes", layout: "row", items: episodes, get entry() { return state.entryEpisode; } }];
    const waiting = episodes.length === 0 && !state.failed && !state.interrupted && (state.episodes === undefined ? state.seasons.length > 0 : state.loading);
    section.appendChild(waiting ? episodePlaceholders() : row);
    if (state.failed || state.interrupted) {
        const retry = actionButton("retry-episodes", "Retry", () => state.retry());
        if (state.failed) {
            const notice = el("div", episodes.length > 0 ? "details-episode-error" : "details-episode-error details-episode-error-empty");
            notice.setAttribute("role", "alert");
            notice.append(el("span", "", "Couldn't load episodes."), retry.element);
            section.appendChild(notice);
        } else section.append(zoneNode("browse-actions", [retry]));
        zones.push({ id: "episode-retry", layout: "row", items: [retry] });
    } else if (!waiting && episodes.length === 0) {
        // TVSeriesDetailView.swift:831-835: 22pt secondary text in the rail's reserved height.
        const empty = el("p", "details-episodes-empty", "No episodes available");
        empty.setAttribute("role", "status");
        section.appendChild(empty);
    }
    // TVSeriesDetailView.swift:590-592: 18pt secondary text, no button. Reaching the rail edge again retries.
    if (state.boundaryFailed) {
        const notice = el("p", "details-edge-error", "Couldn't load more episodes. Move away and back to retry.");
        notice.setAttribute("role", "status");
        section.appendChild(notice);
    }
    content.push(section);
    const view: EpisodeView = { content, zones };
    visits.set(state, { context, episodes: state.railEpisodes, season: state.seasonNumber, loading: state.loading, failed: state.failed, boundaryFailed: state.boundaryFailed, hidesImages, view });
    return view;
}

function episodeCard(episode: Episode, context: ViewContext): FocusItem {
    const element = el("button", "browse-card skyline-continue");
    element.type = "button";
    element.tabIndex = -1;
    element.setAttribute("data-focus", episode.id);
    const art = artwork("browse-art browse-still", episode.stillUrl, context.baseUrl, defaultArtwork("tv"));
    if (hidesEpisodeListStill(episode, context.spoilers?.() ?? { hidesImages: false, hidesOverviews: false })) blurEpisodeStill(art);
    const code = `S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")}`;
    const name = episode.title.trim();
    element.append(art, el("span", "browse-card-title", name === "" ? code : `${code} · ${name}`));
    // EpisodeCardCaption.railMetadata joins with two spaces each side; CSS keeps them.
    element.appendChild(el("span", "browse-card-subtitle details-episode-meta", [episodeAirDate(episode.airDate), episodeRuntime(episode.runtimeMinutes)].filter(Boolean).join("  ·  ")));
    // TVEpisodeRail.swift:764-767: a watched still dims under black .35, beneath the badge and progress.
    if (episode.played) art.appendChild(el("span", "details-episode-dim"));
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
    return mediaItem({ key: episode.id, element }, { id: episode.id, title: episode.title, type: "episode", played: episode.played }, context);
}
