// Apple's WatchPartyMediaPicker, WatchPartyEpisodePicker and WatchPartyMediaChoiceView on tvOS: the host
// chooses a title from group picks and watchlists, a series opens its episodes, and a confirmation page
// stages the choice. Not built: search, Home's discovery rows, recently added shelves, suggestions and
// each member's viewing history.

import type { Card, Episode, Season } from "../contracts/v2/catalog.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { actionButton, artwork, cardItem, zoneNode } from "./browseViews.ts";
import { el } from "./screen.ts";
import { backdrop, banner, checkIcon, eyebrow, labelled } from "./watchPartyParts.ts";
import { choiceFromCard, choiceFromEpisode, choiceFromNextUp, type MediaChoice } from "./watchPartyChoice.ts";
import type { WatchPartyHub } from "./watchPartyHub.ts";
import { runtimeText } from "./cardPresentation.ts";

export interface PickerContext { readonly hub: WatchPartyHub; readonly baseUrl: string }

const CLOSE = (hub: WatchPartyHub): FocusItem => actionButton("picker-close", "Close", () => { hub.show({ kind: "lobby" }); });

/** The strip over the shelves: the page name at the left and Close at the right, as the top bar sits over Home. */
function chrome(hub: WatchPartyHub): { node: HTMLElement; close: FocusItem } {
    const close = CLOSE(hub);
    close.element.classList.add("watch-party-button", "watch-party-secondary");
    const node = el("div", "watch-party-picker-chrome watch-party-ui");
    node.append(el("span", "watch-party-picker-name", "Choose a title"), close.element);
    return { node, close };
}

/** Select on a series the group is part-way through goes to its next episode; any other series opens its seasons. */
function open(hub: WatchPartyHub, card: Card, nextUp: Parameters<typeof choiceFromNextUp>[1] | undefined): void {
    if (card.type === "series") {
        if (nextUp !== undefined) hub.show({ kind: "choice", choice: choiceFromNextUp(card, nextUp) });
        else void hub.openEpisodes(card);
    } else hub.show({ kind: "choice", choice: choiceFromCard(card) });
}

export function pickerView({ hub, baseUrl }: PickerContext): View {
    const { shelves, shelvesLoading, shelvesError } = hub.state;
    const top = chrome(hub);
    const content: HTMLElement[] = [top.node];
    const zones: Zone[] = [{ id: "picker-top", layout: "row", items: [top.close] }];
    let firstShelf: FocusItem | undefined;
    for (const shelf of shelves) {
        // Each card opens its own shelf's entry: the same series can sit in both shelves, and only one has a next-up episode.
        const cards = shelf.entries.map(entry => cardItem(entry.card, {
            baseUrl, posterWidth: 220,
            cardDestination: card => ({ kind: "item" as const, id: card.id, title: card.title }),
            open: () => { open(hub, entry.card, entry.nextUp); },
        })).filter((card): card is FocusItem => card !== undefined);
        if (cards.length === 0) continue;
        firstShelf ??= cards[0];
        zones.push({ id: `shelf:${shelf.id}`, layout: "row", spatial: true, items: cards });
        const block = el("section", "browse-section watch-party-shelf watch-party-ui");
        block.append(el("h2", "browse-section-title", shelf.title), zoneNode("browse-row", cards));
        content.push(block);
    }
    // A failed read shows its reason and Try Again whether or not an earlier read left shelves on the page.
    const retry = shelvesError === undefined ? undefined : actionButton("picker-retry", "Try Again", () => { void hub.openPicker(); });
    const notice = el("div", "watch-party-picker-empty watch-party-ui");
    if (shelves.length === 0) {
        if (shelvesLoading) {
            const loading = el("p", "watch-party-lead", "Loading titles…");
            loading.setAttribute("role", "status");
            notice.appendChild(loading);
        } else {
            notice.append(el("h2", "watch-party-empty-title", "Nothing to pick from yet"), el("p", "watch-party-lead", "Add a title to a watchlist and it shows up here."));
        }
    }
    if (shelvesError !== undefined) notice.appendChild(banner(shelvesError, true));
    if (retry !== undefined) {
        retry.element.classList.add("watch-party-button", "watch-party-secondary");
        notice.appendChild(retry.element);
        zones.push({ id: "picker-retry", layout: "row", items: [retry] });
    }
    if (notice.childElementCount > 0) content.push(notice);
    const first = firstShelf ?? retry ?? top.close;
    const zone = zones.find(candidate => candidate.items.includes(first))?.id ?? "picker-top";
    // Shelves arriving is a new page for focus: the first title takes it, as the first card does on Home; the empty and loading page keeps the strip.
    return { name: `watchParty:picker:${firstShelf === undefined ? "empty" : "shelves"}`, content, zones, focus: { zone, key: first.key }, back: () => hub.back() };
}

/** WatchPartyMediaChoiceView: the title, and the one button that stages it. */
export function choiceView({ hub, baseUrl }: PickerContext, choice: MediaChoice): View {
    const room = hub.state.room;
    const staged = room?.phase === "lobby" && hub.state.capabilities?.stagedSelection === true;
    const confirm = labelled("confirm", staged ? "Choose for the party" : "Play for everyone", "primary", () => { void hub.stage(choice); }, checkIcon());
    const poster = artwork("watch-party-choice-poster", choice.posterUrl, baseUrl, "");
    const text = el("div", "watch-party-choice-text");
    const facts = [choice.subtitle, ...choice.facts].filter((fact): fact is string => fact !== undefined && fact !== "");
    text.append(eyebrow("Watch together"), el("h1", "watch-party-choice-title", choice.title), ...(facts.length === 0 ? [] : [el("p", "watch-party-choice-facts", facts.join(" · "))]));
    const head = el("div", "watch-party-choice-head");
    head.append(poster, text);
    const page = el("div", "watch-party-choice watch-party-ui");
    page.append(head);
    if (choice.overview !== undefined && choice.overview !== "") page.appendChild(el("p", "watch-party-choice-overview", choice.overview));
    page.appendChild(confirm.element);
    if (hub.state.error !== undefined) page.appendChild(banner(hub.state.error, true));
    return {
        name: "watchParty:choice",
        content: [backdrop(choice.backdropUrl ?? choice.posterUrl, baseUrl, choice.backdropUrl === undefined), page],
        zones: [{ id: "choice", layout: "row", items: [confirm] }],
        focus: { zone: "choice", key: "confirm" },
        back: () => hub.back(),
    };
}

function episodeCard(series: Card, episode: Episode, onPress: () => void): FocusItem {
    const item = actionButton(episode.id, "", onPress);
    item.element.classList.add("watch-party-episode");
    // The episode's own still can spoil it, and Apple's spoiler setting is not read here, so the tile is plain.
    const number = el("span", "watch-party-episode-number", `E${episode.episodeNumber}`);
    const caption = el("span", "watch-party-episode-title", `${episode.episodeNumber}. ${episode.title === "" ? `Episode ${episode.episodeNumber}` : episode.title}`);
    const meta = runtimeText(episode.runtimeMinutes);
    item.element.append(number, caption, ...(meta === undefined ? [] : [el("span", "watch-party-episode-meta", meta)]));
    item.element.setAttribute("aria-label", `${series.title}, season ${episode.seasonNumber}, episode ${episode.episodeNumber}`);
    return item;
}

const seasonLabel = (season: Season): string => season.isSpecials === true ? "Specials" : season.title;

/** WatchPartyEpisodePicker: the series' seasons as tabs over the chosen season's episodes. */
export function episodesView({ hub, baseUrl }: PickerContext, series: Card, season: Season | undefined): View {
    const { seasons, episodes, browseLoading, browseError } = hub.state;
    const back = actionButton("episodes-close", "Close", () => { hub.back(); });
    back.element.classList.add("watch-party-button", "watch-party-secondary");
    const tabs = (seasons ?? []).map(candidate => {
        const tab = actionButton(`season:${candidate.seasonNumber}`, seasonLabel(candidate), () => { if (candidate.seasonNumber !== season?.seasonNumber) void hub.openEpisodes(series, candidate); });
        tab.element.classList.add("watch-party-season-tab");
        tab.element.setAttribute("aria-pressed", String(candidate.seasonNumber === season?.seasonNumber));
        return tab;
    });
    const cards = (episodes ?? []).map(episode => episodeCard(series, episode, () => { hub.show({ kind: "choice", choice: choiceFromEpisode(series, episode), from: { kind: "episodes", series, season } }); }));
    const page = el("div", "watch-party-episodes watch-party-ui");
    const head = el("div", "watch-party-episodes-head");
    head.append(eyebrow("Watch Party · Choose an episode"), back.element);
    page.append(head, el("h1", "watch-party-episodes-title", series.title));
    const zones: Zone[] = [{ id: "episodes-top", layout: "row", items: [back] }];
    if (tabs.length > 0) {
        zones.push({ id: "seasons", layout: "row", items: tabs });
        page.appendChild(zoneNode("watch-party-season-tabs", tabs));
    }
    const retry = browseError === undefined ? undefined : actionButton("episodes-retry", "Reload episodes", () => { void hub.openEpisodes(series, season); });
    if (cards.length > 0) {
        zones.push({ id: "episode-rail", layout: "row", items: cards });
        page.appendChild(zoneNode("browse-row watch-party-episode-rail", cards));
    } else if (browseLoading) {
        const loading = el("p", "watch-party-lead", "Loading episodes…");
        loading.setAttribute("role", "status");
        page.appendChild(loading);
    } else {
        page.append(el("h2", "watch-party-empty-title", "No episodes in this season"));
        if (browseError !== undefined) page.appendChild(banner(browseError, true));
        if (retry !== undefined) { retry.element.classList.add("watch-party-button", "watch-party-secondary"); zones.push({ id: "episodes-retry", layout: "row", items: [retry] }); page.appendChild(retry.element); }
    }
    const first = cards[0] ?? tabs.find(tab => tab.key === `season:${season?.seasonNumber}`) ?? retry ?? back;
    const zone = zones.find(candidate => candidate.items.includes(first))?.id ?? "episodes-top";
    return {
        name: "watchParty:episodes",
        content: [backdrop(series.backdropUrl ?? series.posterUrl, baseUrl, series.backdropUrl === undefined), page],
        zones, focus: { zone, key: first.key }, back: () => hub.back(),
    };
}
