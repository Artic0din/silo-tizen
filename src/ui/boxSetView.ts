// One movie box set, on the movie detail page's surfaces: hero, Play, then the member grid.

import type { CatalogBoxSetDetail } from "../contracts/v2/boxSets.ts";
import { boxSetFacts, boxSetNextMovie, boxSetPlayLabel } from "../contracts/v2/boxSets.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { actionButton, artwork, cardItems, GRID_COLUMNS, heading, type ViewContext, zoneNode } from "./browseViews.ts";
import { el } from "./screen.ts";

export function boxSetView(detail: CatalogBoxSetDetail, context: ViewContext, play: () => void, back: () => void): View {
    const label = boxSetPlayLabel(detail);
    const actions: FocusItem[] = [];
    if (label !== undefined && boxSetNextMovie(detail) !== undefined) actions.push(actionButton("play", label, play));
    if (actions.length === 0) actions.push(actionButton("back", "Back", back));
    const layout = el("div", "details-hero");
    layout.appendChild(artwork("details-backdrop", detail.boxSet.backdropUrl ?? detail.boxSet.posterUrl, context.baseUrl, ""));
    const info = el("div", "details-editorial");
    info.append(
        el("p", "browse-kicker", "Box set"),
        heading(detail.boxSet.title),
        el("p", "browse-meta", boxSetFacts(detail).join(" · ")),
    );
    if (detail.boxSet.overview !== undefined && detail.boxSet.overview !== "") info.appendChild(el("p", "browse-text browse-overview", detail.boxSet.overview));
    info.appendChild(zoneNode("browse-actions", actions));
    layout.appendChild(info);
    const movies = cardItems(detail.items, context);
    const grid = zoneNode("browse-grid", movies);
    const content = [layout, el("h2", "browse-section-title", "Movies"), grid];
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
