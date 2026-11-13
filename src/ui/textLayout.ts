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
 * `text-overflow: ellipsis` lays an overflowing line out from its start edge instead, so these lines are shortened here.
 * Every layout read comes before any write, and text is measured on a canvas, so a page of cards reflows once.
 * The full text stays for assistive tech. A line already fitted at its current width and font state is left alone.
 */
let measuring: CanvasRenderingContext2D | null | undefined;

export function fitCentredLines(lines: Iterable<HTMLElement>): void {
    measuring ??= document.createElement("canvas").getContext("2d");
    const context = measuring;
    if (context === null) return;
    // One computed font per caption style (title, subtitle) rather than per line.
    const fonts = new Map<string, { font: string; spacing: number }>();
    const pending: { line: HTMLElement; key: string; full: string; width: number; font: string; spacing: number }[] = [];
    for (const line of lines) {
        const width = line.clientWidth;
        // A line fitted before the web font loaded is fitted again with it.
        const key = `${width}:${document.fonts.status}`;
        if (width === 0 || line.dataset.fittedWidth === key) continue;
        let style = fonts.get(line.className);
        if (style === undefined) {
            const computed = getComputedStyle(line);
            style = { font: `${computed.fontStyle} ${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`, spacing: parseFloat(computed.letterSpacing) || 0 };
            fonts.set(line.className, style);
        }
        pending.push({ line, key, full: line.dataset.fullText ?? line.textContent ?? "", width, ...style });
    }
    for (const { line, key, full, width, font, spacing } of pending) {
        context.font = font;
        const fits = (text: string): boolean => context.measureText(text).width + spacing * Array.from(text).length <= width;
        line.dataset.fullText = full;
        line.dataset.fittedWidth = key;
        if (fits(full)) {
            // A line shortened before the web font loaded can fit once it has.
            if (line.childElementCount > 0 || line.textContent !== full) line.textContent = full;
            continue;
        }
        const chars = Array.from(full);
        const shortened = (count: number): string => `${chars.slice(0, count).join("").trimEnd()}…`;
        let low = 0, high = chars.length - 1;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (fits(shortened(mid))) low = mid; else high = mid - 1;
        }
        const shown = el("span", "", shortened(low));
        shown.setAttribute("aria-hidden", "true");
        line.replaceChildren(shown, el("span", "silo-sr-only", full));
    }
}
