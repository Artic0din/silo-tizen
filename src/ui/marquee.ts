// The Apple TV app's first-run layout (MarqueeTVScreen and its parts in MarqueeTV, MarqueeControls
// and MarqueeFields) for the sign-in screens: copy on the left, a glass card on the right. Icons are
// drawn here as plain SVG strokes; the app ships no system symbol font.

import { button, type Control, el, type Note } from "./screen.ts";
import { KEYBOARD_TEXT, KEYBOARD_TITLE } from "./signInText.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

const ICONS = {
    globe: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M3 12h18", "M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"],
    gear: ["M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z", "M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"],
    check: ["M4.5 12.5l5 5 10-11"],
    number: ["M9.5 3.5L7.5 20.5M16.5 3.5l-2 17M4 8.5h17M3 15.5h17"],
    person: ["M12 3.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M4 20.5c.8-4 4-6 8-6s7.2 2 8 6"],
    lock: ["M6 10.5h12v10H6z", "M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"],
    lockOpen: ["M6 10.5h12v10H6z", "M14 10.5V6a3.5 3.5 0 0 1 7 0v1.5"],
    eye: ["M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z", "M12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4z"],
    eyeSlash: ["M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z", "M12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4z", "M3 3l18 18"],
    key: ["M8 6.7a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z", "M12.5 11.2h8M17.5 11.2v3.3M20.5 11.2v2.5"],
    qrcode: ["M3.5 3.5h6v6h-6zM14.5 3.5h6v6h-6zM3.5 14.5h6v6h-6z", "M14.5 14.5h2.5v2.5h-2.5zM18 18h2.5v2.5H18zM14.5 18.5h1M19.5 14.5h1"],
    retry: ["M19.5 12a7.5 7.5 0 1 1-2.2-5.3", "M19.5 3.5v4.5H15"],
    clock: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 7.5V12l3.2 2"],
    rack: ["M5 3.5h14v17H5z", "M8 7.5h8", "M8 12h8", "M8 16.5h8"],
    alert: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 7.5v6M12 16.3v.2"],
    warning: ["M12 3.5L2.5 20h19z", "M12 9.5v5M12 17.3v.2"],
    declined: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M8.5 8.5l7 7M15.5 8.5l-7 7"],
    paused: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M10 8.5v7M14 8.5v7"],
    keyboard: ["M2.5 6.5h19v11h-19z", "M6 10h1M9.5 10h1M13 10h1M16.5 10h1M6 13.5h1M17 13.5h1M9.5 13.5h5"],
    tv: ["M3 5.5h18v11H3z", "M8.5 20h7M12 16.5V20"],
} as const;

export type IconName = keyof typeof ICONS;

/** One stroked 24x24 glyph, hidden from screen readers. */
export function icon(name: IconName, className = "marquee-icon"): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", className);
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    for (const d of ICONS[name]) {
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("d", d);
        svg.appendChild(path);
    }
    return svg;
}

/** The system activity indicator's stand-in. */
export function spinner(): HTMLElement {
    const node = el("span", "marquee-spinner");
    node.setAttribute("aria-hidden", "true");
    return node;
}

/** The copy column (900 wide) and, when given, the card on the right; `accessory` sits top right. */
export function marqueeScreen(copy: readonly HTMLElement[], card?: HTMLElement, accessory?: HTMLElement): HTMLElement[] {
    const column = el("div", "marquee-copy");
    for (const node of copy) {
        column.appendChild(node);
    }
    const body = el("div", "marquee-body");
    body.appendChild(column);
    if (card !== undefined) {
        body.appendChild(card);
    }
    return accessory === undefined ? [body] : [accessory, body];
}

/** 88 heavy, kerning -2; `\n` breaks lines as in the Apple TV strings. */
export function headline(text: string): HTMLHeadingElement {
    return el("h1", "signin-title marquee-hero", text);
}

/** MarqueeTVBody: 28, secondary ink. */
export function lead(text: string): HTMLParagraphElement {
    return el("p", "marquee-lead", text);
}

/** MarqueeErrorText: inline under its control, never a banner. */
export function errorText(text: string): HTMLParagraphElement {
    const node = el("p", "marquee-error");
    node.setAttribute("role", "alert");
    node.appendChild(icon("alert"));
    node.appendChild(el("span", "", text));
    return node;
}

/** MarqueeTVStatusChip. */
export function chip(text: string, glyph: IconName | undefined, role?: "status" | "alert"): HTMLElement {
    const node = el("div", "marquee-chip");
    if (glyph !== undefined) {
        node.appendChild(icon(glyph));
    }
    node.appendChild(el("span", "", text));
    if (role !== undefined) {
        node.setAttribute("role", role);
    }
    return node;
}

/** The session core's notices, as the Apple TV app's sign-in notice chip. */
export function noteChips(notes: readonly Note[]): HTMLElement[] {
    return notes.map((note) => chip(note.text, "alert", note.tone === "error" ? "alert" : "status"));
}

/** MarqueeTVCard: 640 wide glass. */
export function card(children: readonly HTMLElement[]): HTMLElement {
    const node = el("div", "marquee-card");
    for (const child of children) {
        node.appendChild(child);
    }
    return node;
}

export type SymbolTone = "neutral" | "warning" | "success";

/** MarqueeTVCardSymbol: a glyph in a 112 glass circle; the approval's green check is 140. */
export function cardSymbol(glyph: IconName, tone: SymbolTone = "neutral"): HTMLElement {
    const node = el("div", `marquee-symbol marquee-symbol-${tone}`);
    node.setAttribute("aria-hidden", "true");
    node.appendChild(icon(glyph));
    return node;
}

/** MarqueeServerCard: the mark (the server's image, else its initial on the warm tile), name, address and badge. */
export function serverCard(name: string, address: string, secure: boolean, markUrl?: string): HTMLElement {
    const node = el("div", "marquee-server-card");
    const mark = el("div", "marquee-server-mark");
    mark.setAttribute("aria-hidden", "true");
    mark.appendChild(el("span", "marquee-mark-initial"));
    setServerMark(mark, name, markUrl);
    const names = el("div", "marquee-server-names");
    names.appendChild(el("div", "marquee-server-name", name));
    names.appendChild(el("div", "marquee-server-address", address));
    const badge = el("div", secure ? "marquee-badge" : "marquee-badge marquee-badge-warning");
    badge.appendChild(icon(secure ? "lock" : "lockOpen"));
    badge.appendChild(el("span", "", secure ? "Secure" : "HTTP"));
    for (const child of [mark, names, badge]) {
        node.appendChild(child);
    }
    return node;
}

/**
 * TVServerNeedsSetupView's card: host as the name, the full address, a warning badge,
 * and the rack mark (`showsInitial: false`).
 */
export function setupNeededCard(name: string, address: string, badge: string): HTMLElement {
    const node = el("div", "marquee-server-card");
    node.setAttribute("aria-label", `${name}, ${address}, ${badge}`);
    const mark = el("div", "marquee-server-mark marquee-server-mark-rack");
    mark.setAttribute("aria-hidden", "true");
    mark.appendChild(icon("rack"));
    const names = el("div", "marquee-server-names");
    names.appendChild(el("div", "marquee-server-name", name));
    names.appendChild(el("div", "marquee-server-address", address));
    const badgeNode = el("div", "marquee-badge marquee-badge-warning");
    badgeNode.appendChild(icon("clock"));
    badgeNode.appendChild(el("span", "", badge));
    for (const child of [mark, names, badgeNode]) {
        node.appendChild(child);
    }
    return node;
}

/**
 * MarqueeServerMark: the initial shows until the image loads (AsyncImage's fallback) and stays if
 * it fails. Updated in place, so branding that arrives late moves nothing else on the screen.
 */
export function setServerMark(mark: HTMLElement, name: string, url: string | undefined): void {
    const letter = mark.querySelector(".marquee-mark-initial");
    if (letter !== null) {
        letter.textContent = initial(name);
    }
    const shown = mark.querySelector("img");
    if (shown !== null && shown.getAttribute("src") === url) {
        return;
    }
    shown?.parentNode?.removeChild(shown);
    if (url === undefined) {
        return;
    }
    const image = el("img", "marquee-mark-image");
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("load", () => image.classList.add("marquee-mark-loaded"));
    image.addEventListener("error", () => image.parentNode?.removeChild(image));
    image.setAttribute("src", url);
    mark.appendChild(image);
}

export function initial(name: string): string {
    return name.trim().charAt(0).toUpperCase();
}

/** MarqueeTVField: the input with its leading glyph; focus fills it white. */
export function field(input: HTMLInputElement, glyph: IconName, isError = false): HTMLElement {
    const node = el("div", isError ? "marquee-field signin-field-error" : "marquee-field");
    node.appendChild(icon(glyph));
    node.appendChild(input);
    return node;
}

export function textInput(id: string, key: string, placeholder: string, label: string, value: string): HTMLInputElement {
    const input = el("input", "marquee-input");
    input.id = id;
    input.type = "text";
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("aria-label", label);
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("data-focus", key);
    return input;
}

export type ButtonKind = "primary" | "glass" | "plain";

/** MarqueeButtonStyle: a white pill once focused; glass, or plain text, at rest. */
export function marqueeButton(
    key: string,
    label: string,
    kind: ButtonKind,
    onPress: () => void,
    options: { readonly glyph?: IconName; readonly compact?: boolean; readonly loading?: boolean } = {},
): Control {
    const control = button(key, "", onPress);
    const node = control.element;
    node.classList.add("marquee-button", `marquee-${kind}`);
    if (options.compact === true) {
        node.classList.add("marquee-compact");
    }
    if (options.loading === true) {
        node.setAttribute("aria-busy", "true");
        node.appendChild(spinner());
    }
    if (options.glyph !== undefined) {
        node.appendChild(icon(options.glyph));
    }
    if (label !== "") {
        node.appendChild(el("span", "", label));
    }
    return control;
}

export function actionRow(controls: readonly Control[]): HTMLElement {
    const row = el("div", "signin-actions marquee-actions");
    for (const control of controls) {
        row.appendChild(control.element);
    }
    return row;
}

/** The supported keyboard equivalent of TVTypeOnPhoneCard. */
export function keyboardCard(): HTMLElement {
    return card([cardSymbol("keyboard"), el("h2", "marquee-card-title", KEYBOARD_TITLE), el("p", "marquee-card-text", KEYBOARD_TEXT)]);
}
