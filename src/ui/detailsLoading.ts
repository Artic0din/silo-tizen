// The passive first frame of a Details page, after silo-apple 85679e7 tvOS/Screens/Detail/TVItemDetailLoadingView.swift
// (cinematic layout). It paints what the opening card already knew in the loaded hero's geometry, with quiet
// placeholders for the rest. Apple's frame takes no focus; the remote still needs one owner here, so the page
// itself holds focus, as the Home loading page does, and Back leaves.

import type { View } from "./browseFocus.ts";
import { artworkUrl, type DetailSeed } from "./browseModel.ts";
import type { ViewContext } from "./browseViews.ts";
import { runtimeText } from "./cardPresentation.ts";
import { blurEpisodeStill, hidesEpisodeImage, hidesEpisodeOverview } from "./episodeSpoilers.ts";
import { heroBackdrop } from "./heroBackdrop.ts";
import { detailPalette } from "./browseDetails.ts";
import { el } from "./screen.ts";

export interface LoadingRoute {
    readonly id: string;
    readonly title: string;
    readonly seed?: DetailSeed | undefined;
    readonly seriesContext?: unknown;
}

function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function placeholder(width: number, height: number, radius: number): HTMLElement {
    const bar = el("span", "details-loading-bar");
    bar.style.width = `${width}px`;
    bar.style.height = `${height}px`;
    bar.style.borderRadius = `${radius}px`;
    return bar;
}

/** TVItemDetailLoadingView.metadataTokens: year, first genre, runtime and the upper-cased rating. */
function metadataTokens(seed: DetailSeed | undefined): string[] {
    if (seed === undefined) return [];
    const tokens: string[] = [];
    if (seed.year !== undefined && seed.year > 0) tokens.push(String(seed.year));
    const genre = nonEmpty(seed.genre);
    if (genre !== undefined) tokens.push(genre);
    const runtime = runtimeText(seed.runtimeMinutes);
    if (runtime !== undefined) tokens.push(runtime);
    const rating = nonEmpty(seed.contentRating);
    if (rating !== undefined) tokens.push(rating.toUpperCase());
    return tokens;
}

function isSeriesType(type: string | undefined): boolean {
    return ["series", "show", "shows", "tv", "tvshows"].includes(type?.trim().toLowerCase() ?? "");
}

function usesLandscapeRail(type: string | undefined): boolean {
    const value = type?.trim().toLowerCase();
    return isSeriesType(value) || value === "season" || value === "episode";
}

export function detailsLoadingView(route: LoadingRoute, context: ViewContext, back: () => void): View {
    const seed = route.seed;
    const settings = context.spoilers?.() ?? { hidesImages: false, hidesOverviews: false };
    const watch = seed?.episodeWatch;
    const hidesStill = watch !== undefined && hidesEpisodeImage(settings, watch, seed?.backdropIsEpisodeStill);
    const hidesOverview = watch !== undefined && hidesEpisodeOverview(settings, watch);
    const isSeries = route.seriesContext !== undefined || isSeriesType(seed?.type);
    const lift = isSeries && (context.posterScale?.() ?? 1) > 1 ? 32 : 0;

    const hero = el("div", "details-hero details-loading");
    hero.dataset.mediaType = "loading";
    const backdropUrl = artworkUrl(nonEmpty(seed?.backdropUrl), context.baseUrl);
    const background = heroBackdrop(backdropUrl ?? "", seed?.backdropThumbhash, detailPalette, true, true);
    const frame = background.querySelector<HTMLElement>(".skyline-art-frame");
    if (frame === null) background.appendChild(el("div", "skyline-art-frame details-loading-art"));
    else if (hidesStill) blurEpisodeStill(frame);
    const wash = background.querySelector<HTMLElement>(".skyline-tint-wash")!;
    wash.classList.add("details-page-wash");
    wash.remove();
    hero.appendChild(background);

    const editorial = el("div", "details-loading-editorial");
    editorial.style.paddingTop = `${116 - lift}px`;
    const titleSlot = el("div", "details-loading-title");
    const title = nonEmpty(seed?.title) ?? nonEmpty(route.title);
    if (title !== undefined) {
        // Apple seeds the logo here too. Tizen confirms the title-art setting per page after this frame, and an
        // unconfirmed setting is text-only with no logo request, so the frame keeps the text title.
        titleSlot.append(el("span", "details-loading-title-text", title));
    } else titleSlot.append(placeholder(520, 64, 10));

    const meta = el("div", "details-loading-meta");
    const tokens = metadataTokens(seed);
    meta.append(tokens.length > 0 ? el("span", "", tokens.join("  ·  ")) : placeholder(390, 22, 6));

    const synopsis = el("div", "details-loading-synopsis");
    const overview = hidesOverview ? undefined : nonEmpty(seed?.overview);
    if (overview !== undefined) synopsis.append(el("p", "details-loading-overview", overview));
    else {
        const bars = el("div", "details-loading-lines");
        bars.append(placeholder(860, 18, 5), placeholder(790, 18, 5), placeholder(610, 18, 5));
        synopsis.append(bars);
    }

    const readout = el("div", "details-loading-readout");
    for (const [label, width, bar] of [["VERSION", 245, 100], ["AUDIO", 285, 130], ["SUBTITLES", 264, 60]] as const) {
        const column = el("div", "");
        column.style.width = `${width}px`;
        column.append(el("span", "details-loading-label", label), placeholder(bar, 14, 4));
        readout.appendChild(column);
    }

    const actions = el("div", "details-loading-actions");
    actions.append(placeholder(340, 64, 14), placeholder(190, 64, 14), placeholder(64, 64, 14));
    editorial.append(titleSlot, meta, synopsis, readout, actions);
    hero.appendChild(editorial);

    const landscape = usesLandscapeRail(seed?.type ?? (route.seriesContext !== undefined ? "series" : undefined));
    const rail = el("div", "details-loading-rail");
    const cards = el("div", "details-loading-cards");
    cards.style.gap = `${landscape ? 34 : 44}px`;
    for (let index = 0; index < (landscape ? 4 : 6); index++) cards.append(landscape ? placeholder(400, 225, 12) : placeholder(220, 330, 12));
    rail.append(placeholder(220, 26, 6), cards);

    const page = el("div", "details-loading-page");
    page.tabIndex = 0;
    page.dataset.focus = "loading";
    page.setAttribute("aria-busy", "true");
    page.setAttribute("aria-label", title === undefined ? "Loading details" : `Loading details for ${title}`);
    page.append(hero, rail);
    return {
        name: "item:loading",
        content: [wash, page],
        zones: [{ id: "loading", layout: "row", items: [{ key: "loading", element: page }] }],
        focus: { zone: "loading", key: "loading" },
        back,
    };
}
