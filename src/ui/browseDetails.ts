// DOM for item pages (movie, series, episode) and a season's episode list.

import type { Episode, ItemDetail, Season } from "../contracts/v2/catalog.ts";
import type { Credit, Person } from "../contracts/v2/details.ts";
import type { Card } from "../contracts/v2/catalog.ts";
import type { DetailsState } from "./detailsState.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { artworkUrl, clockTime, episodeLabel, playChoices, type PlayRequest } from "./browseModel.ts";
import { actionButton, artwork, cardItem, heading, lines, mediaItem, type ViewContext, zoneNode } from "./browseViews.ts";
import { personMetadataBadges, personPortrait } from "./personHero.ts";
import { el } from "./screen.ts";
import { SkylineScroll } from "./skylineScroll.ts";
import { remoteKey } from "./keys.ts";
import { detailAction, detailPanel, ratingControls } from "./detailsActions.ts";
import { matchesSubtitle } from "../player/preplaySubtitles.ts";
import type { SubtitleSignature } from "../contracts/v2/preplaySubtitles.ts";
import { seriesEpisodesView } from "./seriesEpisodesView.ts";
import { languageName } from "./cardOverlays.ts";
import { heroBackdrop, type Tints } from "./heroBackdrop.ts";

const detailPalette = new Map<string, Tints>();

/** Browse owns the dialog across optional-data renders and stops it on route teardown. */
export class Synopsis {
    private panel: HTMLElement | undefined;
    private covered: { element: HTMLElement; inert: boolean; hidden: string | null }[] = [];
    private readonly scroll = new SkylineScroll();
    private readonly container: HTMLElement;
    private readonly closed: () => void;

    constructor(container: HTMLElement, closed: () => void) {
        this.container = container;
        this.closed = closed;
    }

    get active(): boolean { return this.panel !== undefined; }

    destroy(): void {
        this.scroll.stop();
        this.panel?.remove();
        this.panel = undefined;
        for (const { element, inert, hidden } of this.covered) {
            element.inert = inert;
            if (hidden === null) element.removeAttribute("aria-hidden"); else element.setAttribute("aria-hidden", hidden);
        }
        this.covered = [];
    }

    show(text: string): void {
        this.destroy();
        this.covered = Array.from(this.container.children).filter((node): node is HTMLElement => node instanceof HTMLElement).map(element => ({ element, inert: element.inert, hidden: element.getAttribute("aria-hidden") }));
        for (const { element } of this.covered) { element.inert = true; element.setAttribute("aria-hidden", "true"); }
        const panel = el("div", "skyline-synopsis-dialog");
        this.panel = panel;
        panel.tabIndex = 0;
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-modal", "true");
        panel.setAttribute("aria-label", "Synopsis");
        panel.appendChild(el("p", "browse-text", text));
        const close = (): void => {
            this.destroy();
            this.closed();
        };
        const closeButton = actionButton("close-synopsis", "Close synopsis", close);
        panel.prepend(closeButton.element);
        panel.addEventListener("keydown", (event) => {
            event.stopPropagation();
            const key = remoteKey(event);
            if (key === "down" || key === "up") {
                event.preventDefault();
                this.scroll.move(panel, 0, Math.max(0, Math.min(panel.scrollHeight - panel.clientHeight, panel.scrollTop + (key === "down" ? 240 : -240))));
            } else if (key === "back" || key === "enter") {
                event.preventDefault();
                close();
            } else if (event.key === "Tab") {
                event.preventDefault();
                closeButton.element.focus({ preventScroll: true });
            }
        });
        this.container.appendChild(panel);
        panel.focus({ preventScroll: true });
    }
}

function metaLine(detail: ItemDetail, state?: DetailsState): string {
    const parts: string[] = [];
    if (detail.year !== undefined) {
        parts.push(String(detail.year));
    }
    if (detail.runtimeMinutes !== undefined && detail.runtimeMinutes > 0) {
        const file = detail.versions.find(file => file.fileId === playChoices(detail, state?.selectedFileId)?.fromStart.fileId);
        const minutes = file?.durationSeconds ? Math.floor(file.durationSeconds / 60) : detail.runtimeMinutes;
        parts.push(minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`);
    }
    const count = state?.series?.seasons.filter(season => !season.isSpecials).length;
    if (detail.type === "series" && count) parts.push(`${count} season${count === 1 ? "" : "s"}`);
    if (detail.contentRating !== undefined && detail.contentRating !== "") {
        parts.push(detail.contentRating);
    }
    return [...parts, ...detail.genres.slice(0, 3)].join(" · ");
}

function detailHeader(detail: ItemDetail, context: ViewContext, actions: readonly FocusItem[], state?: DetailsState, summary?: string): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    const label = episodeLabel(detail.seasonNumber, detail.episodeNumber);
    if (detail.type === "episode" && (detail.seriesTitle !== undefined || label !== undefined)) {
        nodes.push(el("p", "browse-kicker", [detail.seriesTitle, label].filter((part) => part !== undefined).join(" · ")));
    }
    const title = heading(detail.title);
    title.classList.add("requests-detail-title");
    const split = detail.title.indexOf(": ");
    title.textContent = "";
    title.appendChild(el("span", "requests-title-primary", split < 0 ? detail.title : detail.title.slice(0, split)));
    if (split >= 0) title.appendChild(el("span", "requests-title-secondary", detail.title.slice(split + 2)));
    const logo = artworkUrl(detail.extra?.logoUrl, context.baseUrl);
    const allowed = state?.titleArtGuard();
    if (logo !== undefined && allowed?.()) {
        const image = el("img", "details-logo");
        image.alt = detail.title;
        image.referrerPolicy = "no-referrer";
        image.addEventListener("load", () => {
            if (!allowed() || !title.isConnected || title.closest("[hidden]") !== null) return;
            title.textContent = "";
            title.appendChild(image);
        });
        image.src = logo;
    }
    nodes.push(title);
    const meta = metaLine(detail, state);
    const ratings = detail.extra?.ratings.map(rating => `${rating.name} ${rating.display}`).join(" · ");
    if (meta || ratings) nodes.push(el("p", "browse-meta", [meta, ratings].filter(Boolean).join(" · ")));
    if (detail.overview !== undefined && detail.overview !== "") {
        nodes.push(el("p", "browse-text browse-overview", detail.overview));
    }
    const directors = detail.extra?.crew.filter(credit => credit.role.toLowerCase() === "director").map(credit => credit.name);
    const credit = detail.type === "movie" ? directors?.length ? `Directed by ${directors.slice(0, 2).join(", ")}` : undefined : detail.extra?.cast.length ? `Starring ${detail.extra.cast.slice(0, 3).map(person => person.name).join(", ")}` : undefined;
    if (credit !== undefined) nodes.push(el("p", "details-director", credit));
    if (summary !== undefined) {
        const readout = el("div", "details-playback-summary");
        for (const part of summary.split(" | ")) {
            const at = part.indexOf(": ");
            const field = el("div", ""); field.dataset.trackSummary = part.slice(0, at).toLowerCase();
            field.append(el("strong", "", part.slice(0, at).toUpperCase()), el("span", "", part.slice(at + 2)));
            readout.appendChild(field);
        }
        nodes.push(readout);
    }
    const layout = el("div", "details-hero");
    layout.dataset.mediaType = detail.type;
    const backdrop = artworkUrl(detail.backdropUrl ?? detail.posterUrl, context.baseUrl);
    layout.appendChild(heroBackdrop(backdrop ?? "", undefined, detailPalette, true));
    const info = el("div", "details-editorial");
    for (const node of nodes) {
        info.appendChild(node);
    }
    info.appendChild(zoneNode("browse-actions", actions));
    layout.appendChild(info);
    return [layout];
}

export function itemView(detail: ItemDetail, seasons: readonly Season[], context: ViewContext, play: (request: PlayRequest) => void, back: () => void, synopsis: Synopsis, state?: DetailsState): View {
    detail = state === undefined ? detail : { ...detail, versions: state.detail.versions };
    const tracks = state?.nextEpisodeState ?? state;
    const playbackDetail = tracks?.detail ?? detail;
    const playbackChoices = playChoices(playbackDetail, tracks?.selectedFileId);
    const actions: FocusItem[] = [];
    const notes: string[] = [];
    if (tracks?.audioPreference.pending) notes.push("Saving audio preference…");
    if (tracks?.subtitlePreference.pending) notes.push("Saving subtitle preference…");
    if (tracks?.subtitlePreference.failed) {
        notes.push("Subtitle preference could not be confirmed.");
        actions.push(actionButton("retry-subtitle-preference", "Check subtitle preference", () => tracks.subtitlePreference.retry()));
    }
    if (tracks?.audioPreference.failed) {
        notes.push("Could not confirm the audio preference. Check before playing.");
        actions.push(actionButton("retry-audio-preference", "Check audio preference", () => tracks.audioPreference.retry()));
    }
    const choices = playChoices(detail, state?.selectedFileId);
    const choose = (request: PlayRequest): void => {
        const audioTrackId = state?.audioTrackId();
        play({ ...request, ...(audioTrackId === undefined ? {} : { audioTrackId }), ...(state === undefined ? {} : { subtitle: state.subtitleIntent() }) });
    };
    if (choices?.resume !== undefined) {
        const resume = choices.resume;
        actions.push(actionButton("resume", `Resume from ${clockTime(resume.startSeconds ?? 0)}`, () => choose(resume)));
        actions.push(actionButton("play", "Play from start", () => choose(choices.fromStart)));
    } else if (choices !== undefined) {
        actions.push(actionButton("play", "Play", () => choose(choices.fromStart)));
    } else if (detail.type === "movie" || detail.type === "episode") {
        notes.push("This title has no file this TV can play.");
    }
    const next = detail.playContentId;
    if ((detail.type === "series" || detail.type === "season") && next !== undefined) {
        const target = state?.nextEpisode;
        const targetChoices = playbackChoices;
        const playNext = (startOver = false): void => {
            if (target === undefined || targetChoices === undefined) return;
            const audioTrackId = tracks?.audioTrackId(true);
            play({ ...(targetChoices.resume ?? targetChoices.fromStart), startSeconds: startOver ? 0 : targetChoices.resume?.startSeconds, ...(audioTrackId === undefined ? {} : { audioTrackId }), ...(tracks === undefined ? {} : { subtitle: tracks.subtitleIntent() }) });
        };
        const label = target === undefined ? "Loading episode…" : `${targetChoices?.resume === undefined ? "Play" : "Resume"} ${episodeLabel(target.seasonNumber, target.episodeNumber) ?? target.title}`;
        const primary = actionButton("next-episode", state?.nextEpisodeFailed === true ? "Retry episode" : target !== undefined && targetChoices === undefined ? "Episode unavailable" : label, () => {
            if (state?.nextEpisodeFailed === true) state.loadNextEpisode();
            else playNext();
        });
        primary.element.setAttribute("aria-disabled", String(state?.nextEpisodeFailed !== true && targetChoices === undefined));
        actions.push(primary);
        if (targetChoices?.resume !== undefined && target !== undefined) actions.push(actionButton("start-over-episode", "Start Over", () => playNext(true)));
        if (target !== undefined && targetChoices === undefined) notes.push("This episode has no file this TV can play.");
    }
    const series = state?.series === undefined ? undefined : seriesEpisodesView(state.series, context);
    const seasonItems = series?.zones[0]?.items ?? (detail.type === "series" ? seasons.map((season) => seasonItem(detail.id, detail.title, season, context)) : []);
    const overview = detail.overview;
    const file = playbackDetail.versions.find(file => file.fileId === playbackChoices?.fromStart.fileId);
    const audio = file?.audio ?? [];
    const selectedAudio = tracks?.audioTrackId();
    const subtitle = tracks?.subtitleIntent();
    const subtitleLabel = (track: SubtitleSignature): string => [...new Set([languageName(track.language) ?? "Unknown language", track.label, track.codec?.toUpperCase(), track.forced ? "Forced" : undefined, track.hearingImpaired ? "SDH" : undefined].filter(Boolean))].join(" · ");
    const selectedSubtitleLabel = subtitle?.kind === "track" ? subtitleLabel(subtitle.signature) : subtitle?.kind === "off" ? "Off" : "Auto";
    const audioLabel = (index: number): string => {
        const track = audio[index];
        return [track?.title || track?.language?.toUpperCase() || `Track ${index + 1}`, track?.codec?.toUpperCase(), track?.channels ? `${track.channels} ch` : undefined].filter(Boolean).join(" · ");
    };
    if (playbackChoices !== undefined && state !== undefined) {
        const ordinal = audio.findIndex((_track, index) => selectedAudio === `file:${file?.fileId}:audio:${index}`);
        const trigger = actionButton("audio", `Audio: ${ordinal === -1 ? "Auto" : audioLabel(ordinal)}`, () => state.showAudio());
        trigger.element.setAttribute("aria-haspopup", "dialog");
        trigger.element.setAttribute("aria-expanded", String(state.audioOpen));
        actions.push(trigger);
        const subtitles = actionButton("subtitles", `Subtitles: ${selectedSubtitleLabel}`, () => state.showPanel("subtitles"));
        subtitles.element.setAttribute("aria-haspopup", "dialog");
        subtitles.element.setAttribute("aria-expanded", String(state.panel === "subtitles"));
        actions.push(subtitles);
    }
    if (detail.type === "series" && seasonItems.length === 0) {
        notes.push("This series has no seasons yet.");
    }
    if (actions.length === 0 && seasonItems.length === 0) {
        actions.push(actionButton("back", "Back", back));
    }
    if (state?.titleArtPolicy === "failed") actions.push(actionButton("retry-title-art", "Retry title art", () => state.loadTitleArt()));
    if (tracks?.failedPlay !== undefined) {
        const request = tracks.failedPlay;
        actions.push(actionButton("retry-play", "Try again", () => play(request)));
    }
    const personal = state === undefined ? undefined : personalControls(state);
    const watchlist = personal?.items.find(item => item.key === "watchlist");
    if (watchlist !== undefined) actions.push(watchlist);
    if (state !== undefined) {
        if (playbackDetail.versions.length > 0) {
            const version = actionButton("version", `Version: ${file?.label || "Auto"}`, () => state.showPanel("version"));
            version.element.setAttribute("aria-haspopup", "dialog");
            actions.splice(actions.findIndex(item => item.key === "audio"), 0, version);
        }
        const more = actionButton("more", "More", () => state.showPanel("more"));
        more.element.setAttribute("aria-haspopup", "dialog");
        actions.push(more);
    } else if (overview) actions.push(actionButton("synopsis", "Read synopsis", () => synopsis.show(overview)));
    const ordinal = audio.findIndex((_track, index) => selectedAudio === `file:${file?.fileId}:audio:${index}`);
    const summary = playbackChoices === undefined ? undefined : `Version: ${file?.label || "Auto"} | Audio: ${ordinal === -1 ? "Auto" : audioLabel(ordinal)} | Subtitles: ${selectedSubtitleLabel}`;
    const content = [...detailHeader(detail, context, actions.map(detailAction), state, summary), ...lines(notes), ...personal?.notes ?? []];
    if (tracks?.preparingPlay) {
        const status = el("p", "browse-text", "Checking resume position…");
        status.setAttribute("role", "status");
        content.push(status);
    }
    for (const action of actions.filter(action => ["play", "resume", "next-episode", "start-over-episode"].includes(action.key))) {
        if (playbackChoices !== undefined) action.element.setAttribute("aria-disabled", String(tracks?.preparingPlay || tracks?.audioPreference.pending || tracks?.audioPreference.failed || tracks?.subtitlePreference.pending || tracks?.subtitlePreference.failed));
    }
    if (tracks?.failedPlay !== undefined) {
        content.push(...lines(["Could not check resume position."], "error"));
    }
    if (state?.nextEpisodeFailed === true) content.push(...lines(["Could not load the next episode."], "error"));
    if (state?.titleArtPolicy === "failed") content.push(...lines(["Could not load title-art settings."], "error"));
    if (series !== undefined) content.push(...series.content);
    else if (seasonItems.length > 0) {
        content.push(el("h2", "browse-section-title", "Seasons"), zoneNode("browse-row", seasonItems));
    }
    const zones: Zone[] = [
        { id: "actions", layout: "row", items: actions },
        ...series?.zones ?? [{ id: "seasons", layout: "row" as const, items: seasonItems }],
    ];
    const credits: Credit[] = [];
    for (const credit of [...detail.extra?.cast ?? [], ...detail.extra?.crew ?? []]) {
        const index = credits.findIndex((previous) => credit.id ? previous.id === credit.id : previous.id === undefined && previous.name === credit.name);
        const previous = credits[index];
        if (previous === undefined) credits.push(credit);
        else credits[index] = { ...previous, role: [previous.role, credit.role].filter((role) => role !== "").join(" · ") };
    }
    if (credits.length > 0) {
        const people = credits.slice(0, 24).map((credit) => creditCard(credit, context));
        content.push(el("h2", "browse-section-title", "Cast & Crew"), zoneNode("browse-row details-people", people));
        zones.push({ id: "people", layout: "row", items: people });
    }
    if (state !== undefined) {
        const extras = (detail.extras ?? []).map(extra => {
            const key = `extra:${extra.contentId}`, element = el("button", "browse-card details-extra");
            element.type = "button"; element.tabIndex = -1; element.dataset.focus = key;
            const title = extra.title || extra.kind;
            element.append(artwork("browse-art browse-still", extra.stillUrl, context.baseUrl, title), el("span", "browse-card-title", title), el("span", "browse-card-subtitle", extra.durationSeconds === undefined ? extra.kind : `${extra.kind} · ${clockTime(extra.durationSeconds)}`));
            element.setAttribute("aria-disabled", String(extra.fileId === undefined));
            element.addEventListener("click", () => {
                if (extra.fileId !== undefined) play({ contentId: extra.contentId, fileId: extra.fileId, title, startSeconds: 0 });
            });
            return { key, element };
        });
        if (extras.length > 0) {
            content.push(el("h2", "browse-section-title", "Trailers & More"), zoneNode("browse-row details-extras", extras));
            zones.push({ id: "extras", layout: "row", items: extras });
        }
        const related = titleCards(state.related ?? [], context);
        const section = zoneNode("browse-row", related);
        section.setAttribute("data-detail-section", "related");
        content.push(el("h2", "browse-section-title", "Related titles"));
        if (state.relatedFailed) {
            const retry = actionButton("retry-related", "Retry related titles", () => state.loadRelated());
            content.push(...lines(["Could not load related titles."], "error"), zoneNode("browse-actions", [retry]));
            related.push(retry);
        } else if (state.related === undefined) content.push(...lines(["Loading related titles."]));
        else if (related.length === 0) content.push(...lines(["No related titles available."]));
        content.push(section);
        zones.push({ id: "related", layout: "row", items: related });
    }
    const facts = [...detail.extra?.facts ?? []];
    for (const credit of detail.extra?.crew ?? []) facts.unshift({ label: credit.role, value: credit.name });
    if (facts.length > 0) {
        const panel = el("div", "details-facts");
        panel.setAttribute("aria-label", "Details");
        panel.appendChild(el("h2", "browse-section-title", "Details"));
        const items = facts.map((fact, index): FocusItem => {
            const key = `fact:${index}`;
            const element = el("p", "browse-text", `${fact.label}: ${fact.value}`);
            element.tabIndex = -1;
            element.setAttribute("data-focus", key);
            panel.appendChild(element);
            return { key, element };
        });
        content.push(panel);
        zones.push({ id: "facts", layout: "column", items });
    }
    const first = actions[0] ?? seasonItems[0];
    const view: View = { name: `item:${detail.id}`, content, zones, focus: first === undefined ? undefined : { zone: actions[0] === undefined ? "seasons" : "actions", key: first.key }, back };
    if (state?.panel === "audio") {
        const options = [undefined, ...audio.map((_track, index) => index)].map(ordinal => {
            const item = actionButton(`audio:${ordinal ?? "auto"}`, ordinal === undefined ? "Auto" : audioLabel(ordinal), () => { tracks?.selectAudio(ordinal); if (tracks !== state) state.closePanel(); });
            item.element.setAttribute("role", "radio");
            item.element.setAttribute("aria-checked", String(ordinal === undefined ? selectedAudio === undefined : selectedAudio === `file:${file?.fileId}:audio:${ordinal}`));
            return item;
        });
        return detailPanel(view, state, "Audio", options);
    }
    if (state?.panel === "version") {
        const options = [undefined, ...playbackDetail.versions].map((version, index) => {
            const item = actionButton(`version:${version?.fileId ?? "auto"}`, version?.label || (version === undefined ? "Auto" : `Version ${index}`), () => { tracks?.select(version?.fileId); state.closePanel(); });
            item.element.setAttribute("role", "radio");
            item.element.setAttribute("aria-checked", String(version?.fileId === tracks?.selectedFileId));
            return item;
        });
        return detailPanel(view, state, "Version", options);
    }
    if (state?.panel === "subtitles") {
        const choices = [undefined, "off" as const, ...(file?.subtitles ?? []).map((_track, index) => index)];
        const options = choices.map(choice => {
            const track = typeof choice === "number" ? file?.subtitles?.[choice] : undefined;
            const item = actionButton(`subtitle:${choice ?? "auto"}`, track === undefined ? choice === "off" ? "Off" : "Auto" : subtitleLabel(track), () => { tracks?.selectSubtitle(choice); if (tracks !== state) state.closePanel(); });
            item.element.setAttribute("role", "radio");
            item.element.setAttribute("aria-checked", String(track === undefined ? subtitle?.kind === (choice === "off" ? "off" : "auto") : subtitle?.kind === "track" && matchesSubtitle(track, subtitle.signature)));
            return item;
        });
        return detailPanel(view, state, "Subtitles", options);
    }
    if (state?.panel === "more") {
        const items = personal?.items.filter(item => item.key !== "watchlist") ?? [];
        const season = seasons.find(season => season.seasonNumber === state.series?.seasonNumber);
        if (season !== undefined) items.push(actionButton("season-info", `${season.title} details`, () => context.open({ kind: "season", id: season.id, seriesId: detail.id, seasonNumber: season.seasonNumber, title: `${detail.title} · ${season.title}` })));
        if (overview) items.push(actionButton("synopsis", "Read synopsis", () => synopsis.show(overview)));
        if (["movie", "series"].includes(detail.type)) items.push(actionButton("rate", "Rate title", () => state.showPanel("rating")));
        return detailPanel(view, state, "More", items.length ? items : [actionButton("close-more", "Close", () => state.closePanel())], personal?.notes);
    }
    if (state?.panel === "rating") {
        const rating = ratingControls(state);
        return detailPanel(view, state, "Rate title", rating.items, [rating.note]);
    }
    return view;
}

export function personalControls(state: DetailsState): { items: FocusItem[]; notes: HTMLElement[] } {
    const items: FocusItem[] = [];
    const notes: HTMLElement[] = [];
    for (const kind of ["watched", "favorites", "watchlist"] as const) {
        const value = state.values.get(kind);
        if (value === undefined) continue;
        const change = state.changes.get(kind);
        const label = kind === "watched" ? `${state.detail.type === "series" || state.detail.type === "season" ? "Mark all" : "Mark"} ${value ? "unwatched" : "watched"}` : kind === "watchlist" ? value ? "Remove from watchlist" : "Add to watchlist" : value ? "Remove favorite" : "Add favorite";
        const item = actionButton(kind, change?.pending ? `Updating ${kind}…` : change?.failed ? `Retry ${kind}` : label, () => state.change(kind, change?.failed ? change.target : !value, change?.failed));
        item.element.setAttribute("aria-pressed", String(value));
        item.element.setAttribute("aria-disabled", String(state.busy));
        items.push(item);
        if (change?.failed) notes.push(...lines([`Could not update ${kind}.`], "error"));
    }
    if (state.personalFailed) items.push(actionButton("retry-personal", "Retry personal actions", () => { if (!state.busy) state.loadPersonal(); }));
    if (state.personalSupported === undefined) notes.push(...lines([state.personalFailed ? "Could not load personal actions." : "Loading personal actions."], state.personalFailed ? "error" : "info"));
    return { items, notes };
}

function creditCard(credit: Credit, context: ViewContext): FocusItem {
    const key = credit.id ? `person:${credit.id}` : `credit:${credit.name}:${credit.role}`;
    // A credit without a server person_id has facts, but no invented person route.
    const element = el(credit.id ? "button" : "div", "browse-card details-person");
    element.setAttribute("data-focus", key);
    element.tabIndex = -1;
    const id = credit.id;
    if (id) element.addEventListener("click", () => context.open({ kind: "person", id, title: credit.name }));
    element.appendChild(artwork("browse-art details-photo", credit.photoUrl, context.baseUrl, credit.name));
    element.appendChild(el("span", "browse-card-title", credit.name));
    element.appendChild(el("span", "browse-card-subtitle", credit.role));
    return { key, element };
}

function titleCards(cards: readonly Card[], context: ViewContext): FocusItem[] {
    const items: FocusItem[] = [];
    for (const card of cards.slice(0, 24)) {
        const { preview: _preview, ...titlesContext } = context;
        const item = cardItem(card, titlesContext);
        if (item !== undefined) items.push(item);
    }
    return items;
}

export function personView(person: Person, cards: readonly Card[], context: ViewContext, back: () => void, synopsis: Synopsis, seeAll: () => void): View {
    const actions = [actionButton("back", "Back", back)];
    const bio = person.bio;
    actions.push(actionButton("see-all", "See all", seeAll));
    if (bio) actions.push(actionButton("synopsis", "Read synopsis", () => synopsis.show(bio)));
    const hero = el("div", "browse-detail details-person-hero");
    hero.appendChild(personPortrait(person, context.baseUrl));
    const info = el("div", "browse-detail-info");
    info.appendChild(heading(person.name));
    const facts = personMetadataBadges(person, new Date());
    if (facts.length > 0) {
        const row = el("div", "person-facts");
        for (const fact of facts) row.appendChild(el("span", "person-fact", fact));
        info.appendChild(row);
    }
    if (person.bio) info.appendChild(el("p", "browse-text browse-overview", person.bio));
    info.appendChild(zoneNode("browse-actions", actions));
    hero.appendChild(info);
    const titles = titleCards(cards, context);
    return { name: `person:${person.id}`, content: [hero, el("h2", "browse-section-title", "Filmography"), ...(titles.length === 0 ? lines(["No available titles for this person."]) : []), zoneNode("browse-row", titles)], zones: [{ id: "actions", layout: "row", items: actions }, { id: "filmography", layout: "row", items: titles }], focus: { zone: "actions", key: "back" }, back };
}

function seasonItem(seriesId: string, seriesTitle: string, season: Season, context: ViewContext): FocusItem {
    const key = `season:${season.seasonNumber}`;
    const element = el("button", "browse-card");
    element.type = "button";
    element.setAttribute("data-focus", key);
    element.appendChild(artwork("browse-art", season.posterUrl, context.baseUrl, season.title));
    element.appendChild(el("span", "browse-card-title", season.title));
    element.appendChild(el("span", "browse-card-subtitle", season.episodeCount === 1 ? "1 episode" : `${season.episodeCount} episodes`));
    element.addEventListener("click", () => context.open({ kind: "season", id: season.id, seriesId, seasonNumber: season.seasonNumber, title: `${seriesTitle} · ${season.title}` }));
    return mediaItem({ key, element }, { id: season.id, title: season.title, type: "season" }, context);
}

export function seasonView(name: string, title: string, episodes: readonly Episode[], context: ViewContext, back: () => void, play: (request: PlayRequest) => void, synopsis: Synopsis, detail?: ItemDetail, state?: DetailsState): View {
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
        element.addEventListener("click", () => context.playEpisode === undefined ? context.open({ kind: "item", id: episode.id, title: episode.title }) : context.playEpisode(episode.id, episode.title));
        return mediaItem({ key: episode.id, element }, { id: episode.id, title: episode.title, type: "episode" }, context);
    });
    const header = detail === undefined ? undefined : itemView(detail, [], context, play, back, synopsis, state);
    const content = [...(header?.content.slice(0, 1) ?? [heading(title)]), ...(items.length === 0 ? lines(["This season has no episodes yet."]) : []), zoneNode("browse-episodes", items), ...header?.content.slice(1) ?? []];
    const fallback = items.length === 0 ? [actionButton("back", "Back", back)] : [];
    if (fallback.length > 0) {
        content.push(zoneNode("browse-actions", fallback));
    }
    if (header !== undefined && state?.panel !== undefined) {
        for (const node of content) if (!node.matches(".skyline-selector, .skyline-dropdown-scrim")) { node.inert = true; node.setAttribute("aria-hidden", "true"); }
        return { ...header, content };
    }
    const zones: Zone[] = [
        { id: "episodes", layout: "column", items },
        { id: "status", layout: "row", items: fallback },
    ];
    const first = items[0] ?? fallback[0];
    return { name, content, zones: [...header?.zones.filter((zone) => zone.id === "actions") ?? [], ...zones, ...header?.zones.filter((zone) => zone.id !== "actions") ?? []], focus: first === undefined ? undefined : { zone: items[0] === undefined ? "status" : "episodes", key: first.key }, back };
}
