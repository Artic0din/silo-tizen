// The audiobook detail page and its chapter picker, after silo-apple TVAudiobookDetailView,
// TVAudiobookDetailSections and TVAudiobookChaptersView. Playback is a later change: Play and Start Over
// are drawn and focusable but inert (aria-disabled) until the player can open an audiobook.

import type { Audiobook } from "../contracts/v2/audiobooks.ts";
import { audiobookPage, formatRuntime, type AudiobookPage, type PickerRow } from "./audiobookDetail.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { artworkUrl } from "./browseModel.ts";
import { actionButton, artwork, cardItem, type ViewContext, zoneNode } from "./browseViews.ts";
import { artworkSymbol, defaultArtwork } from "./defaultArtwork.ts";
import { el } from "./screen.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = { play: "M8 4 21 12 8 20Z", restart: "M5 4V20M19 4 7 12 19 20Z", chapters: "M8 6H21M8 12H21M8 18H21M3 6H4M3 12H4M3 18H4" } as const;

function glyph(name: keyof typeof ICONS): SVGSVGElement {
    const icon = document.createElementNS(SVG_NS, "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("fill", name === "chapters" ? "none" : "currentColor");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.8");
    const shape = document.createElementNS(SVG_NS, "path");
    shape.setAttribute("d", ICONS[name]);
    icon.appendChild(shape);
    return icon;
}

/** The pill Apple draws for Resume, Chapters and Start Over. */
function pill(key: string, label: string, icon: keyof typeof ICONS, onPress: (() => void) | undefined): FocusItem {
    const item = actionButton(key, label, onPress ?? (() => undefined));
    item.element.classList.add("audiobook-pill");
    item.element.replaceChildren(glyph(icon), el("span", "audiobook-pill-label", label));
    if (onPress === undefined) item.element.setAttribute("aria-disabled", "true");
    return item;
}

function ring(fraction: number, label: string): HTMLElement {
    const node = el("div", "audiobook-ring");
    node.style.setProperty("--audiobook-ring", `${Math.round(Math.min(1, Math.max(0, fraction)) * 360)}deg`);
    node.append(el("span", "audiobook-ring-label", label));
    return node;
}

function stateCluster(page: AudiobookPage): HTMLElement {
    const lines = el("div", "audiobook-state-lines");
    lines.append(el("p", "audiobook-state-line", page.state.line1));
    if (page.state.line2 !== undefined) lines.append(el("p", "audiobook-state-detail", page.state.line2));
    const cluster = el("div", "audiobook-state");
    cluster.dataset.state = page.state.kind;
    if (page.state.kind === "inProgress") cluster.append(ring(page.state.fraction, `${page.state.percent}%`));
    else if (page.state.kind === "finished") cluster.append(ring(1, "100%"));
    cluster.append(lines);
    return cluster;
}

function credits(page: AudiobookPage): HTMLElement | undefined {
    if (page.credits === undefined) return undefined;
    const line = el("p", "audiobook-credits");
    if (page.credits.author !== undefined) line.append("by ", el("strong", "", page.credits.author));
    if (page.credits.narrator !== undefined) {
        if (page.credits.author !== undefined) line.append("  ·  ");
        line.append("read by ", el("strong", "", page.credits.narrator));
    }
    return line;
}

function cover(book: Audiobook, context: ViewContext): HTMLElement {
    return artwork("audiobook-cover", book.posterUrl, context.baseUrl, defaultArtwork(artworkSymbol("audiobook")));
}

function backdrop(book: Audiobook, context: ViewContext): HTMLElement {
    const wash = el("div", "audiobook-backdrop");
    wash.setAttribute("aria-hidden", "true");
    const source = artworkUrl(book.posterUrl, context.baseUrl);
    if (source !== undefined) {
        const image = el("img", "audiobook-backdrop-image");
        image.alt = "";
        image.referrerPolicy = "no-referrer";
        image.addEventListener("error", () => image.remove());
        image.src = source;
        wash.append(image);
    }
    return wash;
}

function sectionTitle(text: string): HTMLElement {
    return el("h2", "audiobook-section-title", text);
}

/** About, other narrations and the discovery rails below the fold. */
function sections(page: AudiobookPage, context: ViewContext): { content: HTMLElement[]; zones: Zone[] } {
    const body = page.sections;
    const content: HTMLElement[] = [];
    const zones: Zone[] = [];
    if (body.about !== undefined || body.credits !== undefined) {
        // One reading stop, so the remote can reach text that sits below the first screen.
        const stop = actionButton("about", "", () => undefined);
        stop.element.classList.add("audiobook-about-stop");
        if (body.about !== undefined) stop.element.append(el("h2", "audiobook-section-title", "About"), el("p", "audiobook-about", body.about));
        if (body.credits !== undefined) stop.element.append(el("p", "audiobook-static-credits", body.credits));
        content.push(stop.element);
        zones.push({ id: "about", layout: "column", spatial: true, items: [stop] });
    }
    if (body.narrations.length > 0) {
        const items = body.narrations.map(narration => {
            const row = actionButton(`narration:${narration.id}`, "", () => context.open({ kind: "audiobook", id: narration.id, title: narration.label }));
            row.element.classList.add("audiobook-row");
            row.element.append(el("span", "audiobook-row-title", narration.label));
            if (narration.year !== undefined) row.element.append(el("span", "audiobook-row-detail", String(narration.year)));
            return row;
        });
        const block = el("section", "audiobook-section");
        block.append(sectionTitle("Narrations"), zoneNode("audiobook-rows", items));
        content.push(block);
        zones.push({ id: "narrations", layout: "column", spatial: true, items });
    }
    body.rails.forEach((rail, index) => {
        const items = rail.items.flatMap(entry => {
            const card = cardItem(
                { id: entry.id, type: "audiobook", title: entry.title, year: undefined, posterUrl: entry.posterUrl, seriesId: undefined, seriesTitle: undefined, seasonNumber: undefined, episodeNumber: undefined },
                { ...context, cardLayout: "square", homeCaptions: false },
            );
            if (card === undefined) return [];
            if (entry.caption !== undefined) {
                card.element.querySelector(".browse-card-subtitle")?.remove();
                card.element.append(el("span", "browse-card-subtitle", entry.caption));
            }
            return [card];
        });
        const block = el("section", "audiobook-section");
        block.append(sectionTitle(rail.title), zoneNode("browse-row audiobook-rail", items));
        content.push(block);
        zones.push({ id: `rail:${index}`, layout: "row", spatial: true, items });
    });
    return { content, zones };
}

export interface AudiobookHandlers {
    readonly context: ViewContext;
    readonly pickerOpen: boolean;
    readonly setPicker: (open: boolean) => void;
    readonly back: () => void;
}

/** The page and its Chapters picker carry no marquee: nothing previews an audiobook on focus. */
function withoutPreview(context: ViewContext): ViewContext {
    const { preview, ...rest } = context;
    void preview;
    return rest;
}

export function audiobookView(book: Audiobook, given: AudiobookHandlers): View {
    const handlers = { ...given, context: withoutPreview(given.context) };
    const page = audiobookPage(book);
    return handlers.pickerOpen && page.showsChapters ? pickerView(book, page, handlers) : detailView(book, page, handlers);
}

function detailView(book: Audiobook, page: AudiobookPage, handlers: AudiobookHandlers): View {
    const { context } = handlers;
    const actions: FocusItem[] = [pill("play", page.primary.label, page.primary.icon, undefined)];
    if (page.showsChapters) actions.push(pill("chapters", "Chapters", "chapters", () => handlers.setPicker(true)));
    actions.push(pill("start-over", "Start Over", "restart", undefined));

    const identity = el("div", "audiobook-identity");
    const eyebrow = el("p", "audiobook-eyebrow");
    eyebrow.append(el("span", "audiobook-eyebrow-rule"), page.eyebrow);
    identity.append(eyebrow, el("h1", "audiobook-title", page.title));
    if (page.seriesLine !== undefined) identity.append(el("p", "audiobook-series", page.seriesLine.toUpperCase()));
    const byline = credits(page);
    if (byline !== undefined) identity.append(byline);
    identity.append(stateCluster(page), zoneNode("audiobook-actions", actions));

    const hero = el("section", "audiobook-hero");
    hero.append(cover(book, context), identity);
    const below = sections(page, context);
    const root = el("div", "audiobook-page");
    root.dataset.mediaType = "audiobook";
    root.append(backdrop(book, context), hero);
    if (below.content.length > 0) {
        const rest = el("div", "audiobook-sections");
        rest.append(...below.content);
        root.append(rest);
    }
    return {
        name: `audiobook:${book.id}`,
        content: [root],
        zones: [{ id: "actions", layout: "row", spatial: true, items: actions }, ...below.zones],
        focus: { zone: "actions", key: "play" },
        back: handlers.back,
    };
}

function rowNode(row: PickerRow): FocusItem {
    const item = actionButton(row.id, "", () => undefined);
    item.element.classList.add("audiobook-row", "audiobook-chapter");
    item.element.dataset.current = String(row.isCurrent);
    item.element.dataset.done = String(row.isDone);
    item.element.setAttribute("aria-label", `${row.number}. ${row.title}, ${formatRuntime(row.duration)}${row.isCurrent ? ", now" : ""}${row.isDone ? ", finished" : ""}`);
    item.element.append(el("span", "audiobook-chapter-number", String(row.number)), el("span", "audiobook-row-title", row.title));
    if (row.isDone) item.element.append(el("span", "audiobook-chapter-done", "✓"));
    if (row.isCurrent) item.element.append(el("span", "audiobook-chapter-now", "NOW"));
    item.element.append(el("span", "audiobook-row-detail", formatRuntime(row.duration)));
    if (row.isCurrent && row.progress !== undefined && row.progress > 0) {
        const underline = el("span", "audiobook-chapter-progress");
        underline.style.width = `${Math.round(row.progress * 1000) / 10}%`;
        item.element.append(underline);
    }
    return item;
}

function pickerView(book: Audiobook, page: AudiobookPage, handlers: AudiobookHandlers): View {
    const items = page.picker.rows.map(rowNode);
    const header = el("header", "audiobook-picker-header");
    const titles = el("div", "audiobook-picker-titles");
    titles.append(el("h1", "audiobook-picker-title", "Chapters"), el("p", "audiobook-picker-subline", page.picker.subline));
    header.append(cover(book, handlers.context), titles);
    const root = el("div", "audiobook-picker");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Chapters");
    root.append(header, zoneNode("audiobook-rows", items));
    return {
        name: `audiobook:${book.id}:chapters`,
        content: [root],
        zones: [{ id: "chapters", layout: "column", items }],
        focus: { zone: "chapters", key: page.picker.defaultRowId ?? items[0]?.key ?? "" },
        back: () => handlers.setPicker(false),
    };
}
