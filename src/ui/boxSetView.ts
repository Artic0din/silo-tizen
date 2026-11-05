// One movie box set, on the movie detail page's surfaces: hero, Play, then the member grid.
// tvOS: BoxSetDetailView.tvContent (BoxSetDetailView.swift:197-237) on TVDetailPageSurface and TVDetailHero.

import type { CatalogBoxSetDetail } from "../contracts/v2/boxSets.ts";
import { boxSetFacts, boxSetNextMovie, boxSetPlayVerb } from "../contracts/v2/boxSets.ts";
import { artworkUrl } from "./browseModel.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { actionButton, cardItems, GRID_COLUMNS, heading, type ViewContext, zoneNode } from "./browseViews.ts";
import { detailAction } from "./detailsActions.ts";
import { heroBackdrop, type Tints } from "./heroBackdrop.ts";
import { el } from "./screen.ts";

const boxSetTints = new Map<string, Tints>();

export function boxSetView(detail: CatalogBoxSetDetail, context: ViewContext, play: () => void, back: () => void): View {
    const next = boxSetNextMovie(detail);
    const verb = boxSetPlayVerb(detail);
    const actions: FocusItem[] = [];
    if (verb !== undefined && next !== undefined) {
        const button = detailAction(actionButton("play", verb, play));
        button.element.classList.add("box-set-play");
        const copy = el("span", "box-set-play-copy");
        // TVPrimaryPillLabel stacks the verb over the film (TVDetailActions.swift:58-67).
        copy.append(el("span", "box-set-play-verb", verb), el("span", "box-set-play-film", next.title));
        button.element.querySelector(".details-action-label")?.replaceWith(copy);
        button.element.setAttribute("aria-label", `${verb} ${next.title}`);
        actions.push(button);
    }
    if (actions.length === 0) actions.push(actionButton("back", "Back", back));
    const layout = el("div", "details-hero");
    layout.dataset.mediaType = "box-set";
    const backdrop = artworkUrl(detail.boxSet.backdropUrl, context.baseUrl) ?? "";
    const background = heroBackdrop(backdrop, detail.boxSet.backdropThumbhash, boxSetTints, true);
    if (backdrop === "") background.querySelector(".skyline-art-frame")?.remove();
    const wash = background.querySelector<HTMLElement>(".skyline-tint-wash");
    wash?.classList.add("details-page-wash");
    wash?.remove();
    layout.appendChild(background);
    const info = el("div", "details-editorial");
    info.append(
        el("p", "browse-kicker", "Box set"),
        heroTitle(detail.boxSet.title),
        factLine(boxSetFacts(detail)),
    );
    if (detail.boxSet.overview !== undefined && detail.boxSet.overview !== "") info.appendChild(el("p", "browse-text browse-overview", detail.boxSet.overview));
    // showsPlaybackSummary is false, and the 44pt readout stays in the stack (TVDetailHero.swift:267-268,786).
    const reserve = el("div", "details-playback-summary");
    reserve.setAttribute("aria-hidden", "true");
    info.append(reserve, zoneNode("browse-actions", actions));
    layout.appendChild(info);
    const movies = cardItems(detail.items, context);
    const grid = zoneNode("browse-grid box-set-grid", movies);
    const content = [wash, layout, el("h2", "browse-section-title", "Movies"), grid].filter((node): node is HTMLElement => node !== null && node !== undefined);
    const zones: Zone[] = [
        { id: "actions", layout: "row", items: actions },
        { id: "grid", layout: "grid", columns: GRID_COLUMNS, items: movies },
    ];
    const first = actions[0];
    return {
        name: `boxSet:${detail.boxSet.libraryId}:${detail.boxSet.id}`,
        content,
        zones,
        focus: first === undefined ? undefined : { zone: "actions", key: first.key },
        back,
    };
}

/** TVHeroTitle: one line, or a lead and a subtitle split on ": " (TVDetailHero.swift:486-520). */
function heroTitle(title: string): HTMLElement {
    const node = heading(title);
    node.classList.add("requests-detail-title");
    const split = title.indexOf(": ");
    node.textContent = "";
    node.appendChild(el("span", "requests-title-primary", split < 0 ? title : title.slice(0, split)));
    if (split >= 0) node.appendChild(el("span", "requests-title-secondary", title.slice(split + 2)));
    return node;
}

/** factsLine tokens separated by the metadata dot (TVDetailHero.swift:371,409-431). */
function factLine(tokens: readonly string[]): HTMLElement {
    const line = el("p", "browse-meta box-set-facts");
    for (const token of tokens) line.appendChild(el("span", "", token));
    return line;
}
