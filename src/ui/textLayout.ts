import { el } from "./screen.ts";

// Chromium 108 has no text-wrap: pretty. Native titles fill the first line, but never leave one word alone on the second.
export function balanceTwoLineText(heading: HTMLElement): void {
    const text = heading.textContent?.trim() ?? "", context = document.createElement("canvas").getContext("2d");
    if (context === null) return;
    context.font = getComputedStyle(heading).font;
    const available = heading.clientWidth;
    if (context.measureText(text).width <= available) return;
    const words = text.split(/\s+/), width = (from: number, to: number): number => context.measureText(words.slice(from, to).join(" ")).width;
    let split = 1;
    while (split < words.length - 1 && width(0, split + 1) <= available) split += 1;
    if (split === words.length - 1 && split > 1) split -= 1;
    heading.style.maxWidth = `${Math.ceil(Math.min(available, Math.max(width(0, split), width(split, words.length))))}px`;
}

/**
 * SwiftUI `.lineLimit(1)` with `.truncationMode(.tail)` in a centred frame shortens the text, then centres it. CSS
 * `text-overflow: ellipsis` lays an overflowing line out from its start edge instead, so this shortens the line itself.
 * The full text stays for assistive tech. A line already fitted at its current width is left alone.
 */
export function fitCentredLine(line: HTMLElement): void {
    const width = line.clientWidth;
    // A line fitted before the web font loaded is fitted again with it.
    const key = `${width}:${document.fonts.status}`;
    if (width === 0 || line.dataset.fittedWidth === key) return;
    const full = line.dataset.fullText ?? line.textContent ?? "";
    line.dataset.fullText = full;
    line.dataset.fittedWidth = key;
    line.textContent = full;
    if (line.scrollWidth <= width) return;
    const chars = Array.from(full);
    const shortened = (count: number): string => `${chars.slice(0, count).join("").trimEnd()}…`;
    let low = 0, high = chars.length - 1;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        line.textContent = shortened(mid);
        if (line.scrollWidth <= width) low = mid; else high = mid - 1;
    }
    const shown = el("span", "", shortened(low));
    shown.setAttribute("aria-hidden", "true");
    line.replaceChildren(shown, el("span", "silo-sr-only", full));
}
