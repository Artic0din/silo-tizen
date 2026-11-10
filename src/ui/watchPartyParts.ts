// Pieces the Watch Party screens share: Apple's WatchPartyEyebrow, WatchPartyBanner, WatchPartyButtonStyle,
// WatchPartyBackdrop and the circle action button. Metrics are Apple's tvOS values at 1920x1080 (WatchPartyMetrics).

import type { FocusItem } from "./browseFocus.ts";
import { actionButton, artwork } from "./browseViews.ts";
import { el } from "./screen.ts";

export const SVG = "http://www.w3.org/2000/svg";

export function eyebrow(text: string): HTMLElement { return el("p", "watch-party-eyebrow", text); }

export function banner(message: string, warning: boolean): HTMLElement {
    const node = el("div", `watch-party-banner${warning ? " watch-party-banner-warning" : ""}`);
    node.setAttribute("role", "alert");
    node.append(el("span", "watch-party-banner-dot"), el("span", "watch-party-banner-text", message));
    return node;
}

export function icon(path: string): SVGSVGElement {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "watch-party-icon");
    svg.setAttribute("aria-hidden", "true");
    const shape = document.createElementNS(SVG, "path");
    shape.setAttribute("d", path);
    svg.appendChild(shape);
    return svg;
}

export const plusIcon = (): SVGSVGElement => icon("M12 3v18M3 12h18");
export const playIcon = (): SVGSVGElement => { const svg = icon("M7 4.5v15l12-7.5z"); svg.classList.add("watch-party-icon-solid"); return svg; };
export const checkIcon = (): SVGSVGElement => icon("M5 12.5 10 17.5 19 7");

export function pill(item: FocusItem, kind: "primary" | "secondary", disabled = false): FocusItem {
    item.element.classList.add("watch-party-button", `watch-party-${kind}`);
    item.element.setAttribute("aria-disabled", String(disabled));
    return item;
}

export const enabled = (item: FocusItem): boolean => item.element.getAttribute("aria-disabled") !== "true";

/** A pill button with an optional leading icon. */
export function labelled(key: string, label: string, kind: "primary" | "secondary", onPress: () => void, lead?: SVGSVGElement): FocusItem {
    const item = pill(actionButton(key, label, onPress), kind);
    if (lead !== undefined) item.element.prepend(lead);
    return item;
}

/** TVCircleActionButton: a round icon that opens into a labelled pill on focus. */
export function circleButton(key: string, label: string, glyph: SVGSVGElement, onPress: () => void): FocusItem {
    const item = actionButton(key, "", onPress);
    item.element.classList.add("watch-party-circle");
    item.element.setAttribute("aria-label", label);
    item.element.append(glyph, el("span", "watch-party-circle-label", label));
    return item;
}

export const ellipsisIcon = (): SVGSVGElement => {
    const svg = icon("");
    svg.replaceChildren(...[5, 12, 19].map(x => { const dot = document.createElementNS(SVG, "circle"); dot.setAttribute("cx", String(x)); dot.setAttribute("cy", "12"); dot.setAttribute("r", "2"); return dot; }));
    svg.classList.add("watch-party-icon-solid");
    return svg;
};

/** WatchPartyBackdrop: the film is the room, so its backdrop (or a blurred poster) tints the whole screen. */
export function backdrop(reference: string | undefined, baseUrl: string, poster = false): HTMLElement {
    const node = el("div", `watch-party-backdrop${poster ? " watch-party-backdrop-poster" : ""}`);
    node.setAttribute("aria-hidden", "true");
    if (reference !== undefined) node.appendChild(artwork("watch-party-backdrop-art", reference, baseUrl, ""));
    node.appendChild(el("div", "watch-party-backdrop-shade"));
    return node;
}

/** A party code in Apple's code pill: "JOIN WITH", the code and a QR mark. */
export function codeText(code: string): HTMLElement { return el("span", "watch-party-code", code); }
