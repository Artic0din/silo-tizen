// DOM for item pages (movie, series, episode) and a season's episode list.

import type { Episode, ItemDetail, Season } from "../contracts/v2/catalog.ts";
import type { Credit, Person } from "../contracts/v2/details.ts";
import type { Card } from "../contracts/v2/catalog.ts";
import type { DetailsState } from "./detailsState.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { artworkUrl, clockTime, episodeLabel, playChoices, type PlayRequest } from "./browseModel.ts";
import { actionButton, artwork, cardItem, heading, lines, type ViewContext, zoneNode } from "./browseViews.ts";
import { el } from "./screen.ts";
import { SkylineScroll } from "./skylineScroll.ts";
import { remoteKey } from "./keys.ts";

/** Browse owns the dialog across optional-data renders and stops it on route teardown. */
export class Synopsis {
    private panel: HTMLElement | undefined;
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
    }

    show(text: string): void {
        this.destroy();
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

function detailHeader(detail: ItemDetail, context: ViewContext, actions: readonly FocusItem[], state?: DetailsState): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    const label = episodeLabel(detail.seasonNumber, detail.episodeNumber);
    if (detail.type === "episode" && (detail.seriesTitle !== undefined || label !== undefined)) {
        nodes.push(el("p", "browse-kicker", [detail.seriesTitle, label].filter((part) => part !== undefined).join(" · ")));
    }
    const title = heading(detail.title);
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
    const meta = metaLine(detail);
    if (meta !== "") {
        nodes.push(el("p", "browse-meta", meta));
    }
    if (detail.extra?.ratings.length) nodes.push(el("p", "browse-meta", detail.extra.ratings.map((rating) => `${rating.name} ${rating.display}`).join(" · ")));
    if (detail.overview !== undefined && detail.overview !== "") {
        nodes.push(el("p", "browse-text browse-overview", detail.overview));
    }
    const layout = el("div", "details-hero");
    layout.appendChild(artwork("details-backdrop", detail.backdropUrl ?? detail.posterUrl, context.baseUrl, ""));
    const info = el("div", "details-editorial");
    for (const node of nodes) {
        info.appendChild(node);
    }
    info.appendChild(zoneNode("browse-actions", actions));
    layout.appendChild(info);
    return [layout];
}

export function itemView(detail: ItemDetail, seasons: readonly Season[], context: ViewContext, play: (request: PlayRequest) => void, back: () => void, synopsis: Synopsis, state?: DetailsState): View {
    const actions: FocusItem[] = [];
    const notes: string[] = [];
    const choices = playChoices(detail, state?.selectedFileId);
    const choose = (request: PlayRequest): void => {
        const audioTrackId = state?.audioTrackId();
        play({ ...request, ...(audioTrackId === undefined ? {} : { audioTrackId }) });
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
        actions.push(actionButton("next-episode", "Next episode", () => context.open({ kind: "item", id: next, title: detail.title })));
    }
    const seasonItems = detail.type === "series" ? seasons.map((season) => seasonItem(detail.id, detail.title, season, context)) : [];
    const overview = detail.overview;
    const file = detail.versions.find(file => file.fileId === choices?.fromStart.fileId);
    const audio = file?.audio ?? [];
    const selectedAudio = state?.audioTrackId();
    const audioLabel = (index: number): string => {
        const track = audio[index];
        return [track?.title || track?.language?.toUpperCase() || `Track ${index + 1}`, track?.codec?.toUpperCase(), track?.channels ? `${track.channels} ch` : undefined].filter(Boolean).join(" · ");
    };
    if (choices !== undefined && state !== undefined) {
        const ordinal = audio.findIndex((_track, index) => selectedAudio === `file:${file?.fileId}:audio:${index}`);
        const trigger = actionButton("audio", `Audio: ${ordinal === -1 ? "Auto" : audioLabel(ordinal)}`, () => state.showAudio());
        trigger.element.setAttribute("aria-haspopup", "dialog");
        trigger.element.setAttribute("aria-expanded", String(state.audioOpen));
        actions.push(trigger);
    }
    if (overview) actions.push(actionButton("synopsis", "Read synopsis", () => synopsis.show(overview)));
    if (detail.type === "series" && seasonItems.length === 0) {
        notes.push("This series has no seasons yet.");
    }
    if (actions.length === 0 && seasonItems.length === 0) {
        actions.push(actionButton("back", "Back", back));
    }
    if (state?.titleArtPolicy === "failed") actions.push(actionButton("retry-title-art", "Retry title art", () => state.loadTitleArt()));
    if (state?.failedPlay !== undefined) {
        const request = state.failedPlay;
        actions.push(actionButton("retry-play", "Try again", () => play(request)));
    }
    const content = [...detailHeader(detail, context, actions, state), ...lines(notes)];
    if (state?.preparingPlay) {
        const status = el("p", "browse-text", "Checking resume position…");
        status.setAttribute("role", "status");
        content.push(status);
    }
    for (const action of actions.filter(action => action.key === "play" || action.key === "resume")) action.element.setAttribute("aria-disabled", String(state?.preparingPlay ?? false));
    if (state?.failedPlay !== undefined) {
        content.push(...lines(["Could not check resume position."], "error"));
    }
    if (state?.titleArtPolicy === "failed") content.push(...lines(["Could not load title-art settings."], "error"));
    if (seasonItems.length > 0) {
        content.push(el("h2", "browse-section-title", "Seasons"), zoneNode("browse-row", seasonItems));
    }
    const zones: Zone[] = [
        { id: "actions", layout: "row", items: actions },
        { id: "seasons", layout: "row", items: seasonItems },
    ];
    if (state !== undefined) {
        const versions = detail.versions.length > 1 ? detail.versions.map((file, index) => {
            const item = actionButton(`version:${file.fileId}`, file.label || `Version ${index + 1}`, () => state.select(file.fileId));
            item.element.setAttribute("aria-pressed", String(file.fileId === choices?.fromStart.fileId));
            return item;
        }) : [];
        if (versions.length > 0) {
            content.push(el("h2", "browse-section-title", "Versions"), zoneNode("browse-row details-versions", versions));
            zones.push({ id: "versions", layout: "row", items: versions });
        }
        const personal: FocusItem[] = [];
        for (const [kind, value] of state.values) {
            const change = state.changes.get(kind);
            const label = kind === "watched" ? `${detail.type === "series" || detail.type === "season" ? "Mark all" : "Mark"} ${value ? "unwatched" : "watched"}` : kind === "watchlist" ? value ? "Remove from watchlist" : "Add to watchlist" : value ? "Remove favorite" : "Add favorite";
            const item = actionButton(kind, change?.pending ? `Updating ${kind}…` : change?.failed ? `Retry ${kind}` : label, () => state.change(kind, change?.failed ? change.target : !value, change?.failed));
            item.element.setAttribute("aria-pressed", String(value));
            item.element.setAttribute("aria-disabled", String(change?.pending ?? false));
            personal.push(item);
            if (change?.failed) content.push(...lines([`Could not update ${kind}.`], "error"));
        }
        if (state.personalFailed) personal.push(actionButton("retry-personal", "Retry personal actions", () => state.loadPersonal()));
        if (state.personalSupported === undefined) content.push(...lines([state.personalFailed ? "Could not load personal actions." : "Loading personal actions."], state.personalFailed ? "error" : "info"));
        content.push(zoneNode("browse-actions", personal));
        zones.push({ id: "personal", layout: "row", items: personal });
    }
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
    if (state?.audioOpen) {
        const panel = el("div", "skyline-selector details-audio-picker");
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-modal", "true");
        panel.setAttribute("aria-label", "Audio");
        panel.appendChild(el("h2", "browse-section-title", "Audio"));
        const options = [undefined, ...audio.map((_track, index) => index)].map(ordinal => {
            const item = actionButton(`audio:${ordinal ?? "auto"}`, ordinal === undefined ? "Auto" : audioLabel(ordinal), () => state.selectAudio(ordinal));
            item.element.setAttribute("role", "radio");
            item.element.setAttribute("aria-checked", String(ordinal === undefined ? selectedAudio === undefined : selectedAudio === `file:${file?.fileId}:audio:${ordinal}`));
            return item;
        });
        panel.appendChild(zoneNode("details-audio-options", options));
        const scrim = el("div", "skyline-dropdown-scrim");
        scrim.addEventListener("click", () => state.closeAudio());
        content.push(scrim, panel);
        const selected = options.find(item => item.element.getAttribute("aria-checked") === "true") ?? options[0];
        return { name: `item:${detail.id}:audio`, content, zones: [{ id: "audio", layout: "column", items: options }], focus: selected === undefined ? undefined : { zone: "audio", key: selected.key }, back: () => state.closeAudio() };
    }
    return { name: `item:${detail.id}`, content, zones, focus: first === undefined ? undefined : { zone: actions[0] === undefined ? "seasons" : "actions", key: first.key }, back };
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
        const item = cardItem(card, { baseUrl: context.baseUrl, open: context.open });
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
    hero.appendChild(artwork("browse-art browse-detail-art", person.photoUrl, context.baseUrl, person.name));
    const info = el("div", "browse-detail-info");
    info.appendChild(heading(person.name));
    for (const text of [person.birthDate ? `Born ${person.birthDate}` : undefined, person.birthplace, person.deathDate ? `Died ${person.deathDate}` : undefined]) if (text) info.appendChild(el("p", "browse-meta", text));
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
    return { key, element };
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
        element.addEventListener("click", () => context.open({ kind: "item", id: episode.id, title: episode.title }));
        return { key: episode.id, element };
    });
    const header = detail === undefined ? undefined : itemView(detail, [], context, play, back, synopsis, state);
    const content = [...(header?.content.slice(0, 1) ?? [heading(title)]), ...(items.length === 0 ? lines(["This season has no episodes yet."]) : []), zoneNode("browse-episodes", items), ...header?.content.slice(1) ?? []];
    const fallback = items.length === 0 ? [actionButton("back", "Back", back)] : [];
    if (fallback.length > 0) {
        content.push(zoneNode("browse-actions", fallback));
    }
    const zones: Zone[] = [
        { id: "episodes", layout: "column", items },
        { id: "status", layout: "row", items: fallback },
    ];
    const first = items[0] ?? fallback[0];
    return { name, content, zones: [...header?.zones.filter((zone) => zone.id === "actions") ?? [], ...zones, ...header?.zones.filter((zone) => zone.id !== "actions") ?? []], focus: first === undefined ? undefined : { zone: items[0] === undefined ? "status" : "episodes", key: first.key }, back };
}
