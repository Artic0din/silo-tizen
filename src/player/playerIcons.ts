/** Drawn stand-ins for the Apple TV transport symbols. SF Symbols are not on Tizen. */

const NUMBERED_SECONDS = new Set([5, 10, 15, 30, 45, 60, 75, 90]);

function svg(body: string): string {
    return `<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">${body}</svg>`;
}

export function playIcon(): string {
    return svg(`<path fill="currentColor" d="M8 5.2v13.6L19 12 8 5.2z"/>`);
}

export function pauseIcon(): string {
    return svg(`<path fill="currentColor" d="M6 5h4.2v14H6zm7.8 0H18v14h-4.2z"/>`);
}

/** tvOS `ProgressView` scaled by `PlayerLoadingSpinner`'s 2×, drawn as the same spoke spinner. */
export function spinnerIcon(): string {
    const spokes = [1, 0.35, 0.35, 0.35, 0.4, 0.5, 0.65, 0.8].map((opacity, spoke) => `<path d="M20 3v8" opacity="${opacity}" transform="rotate(${spoke * 45} 20 20)"/>`).join("");
    return `<svg viewBox="0 0 40 40" focusable="false" aria-hidden="true" stroke="currentColor" stroke-width="4.5" stroke-linecap="round">${spokes}</svg>`;
}

export function closeIcon(): string {
    return svg(`<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/>`);
}

/** `forward.end.fill`: the Skip Recap and Skip Credits symbol. */
export function skipToEndIcon(): string {
    return svg(`<g fill="currentColor"><path d="M3.5 5.6v12.8L14 12z"/><rect x="15.6" y="5.6" width="3.4" height="12.8" rx="1"/></g>`);
}

/** `arrow.down.circle.fill`: the undo pill's and the lowered notice's symbol. */
export function arrowDownCircleIcon(): string {
    return svg(`<circle cx="12" cy="12" r="10" fill="currentColor"/><path fill="none" stroke="#000" stroke-opacity="0.85" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 7v9m-4-4 4 4 4-4"/>`);
}

/** `info.circle.fill`: the information tone's symbol. */
export function infoCircleIcon(): string {
    return svg(`<circle cx="12" cy="12" r="10" fill="currentColor"/><path fill="none" stroke="#000" stroke-opacity="0.85" stroke-width="2" stroke-linecap="round" d="M12 11v6m0-9.4v.1"/>`);
}

/** `exclamationmark.triangle.fill`: the warning tone's symbol. */
export function warningTriangleIcon(): string {
    return svg(`<path fill="currentColor" d="M10.3 3.6a2 2 0 0 1 3.4 0l8.2 14.3a2 2 0 0 1-1.7 3H3.8a2 2 0 0 1-1.7-3z"/><path fill="none" stroke="#000" stroke-opacity="0.85" stroke-width="2" stroke-linecap="round" d="M12 9.5v4.5m0 3v.1"/>`);
}

/** `rectangle.stack.fill`: the tvOS Show Up Next episodes icon. */
export function episodesIcon(): string {
    return svg(`<g fill="currentColor"><path opacity="0.55" d="M7 3.2h11.2A1.6 1.6 0 0 1 19.8 4.8V6H6.2V4.8A1.6 1.6 0 0 1 7 3.2z"/><path opacity="0.8" d="M5 6.2h13.2A1.6 1.6 0 0 1 19.8 7.8V9H4.2V7.8A1.6 1.6 0 0 1 5 6.2z"/><rect x="3" y="9" width="18" height="11" rx="1.8"/></g>`);
}

/** `slider.horizontal.3`: three rules with a knob on each. */
export function optionsIcon(): string {
    return svg(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></g><g fill="currentColor"><circle cx="9" cy="7" r="1.8"/><circle cx="15" cy="12" r="1.8"/><circle cx="8" cy="17" r="1.8"/></g>`);
}

/**
 * Numbered `gobackward.N` / `goforward.N` when Apple has that symbol, otherwise the plain arrow.
 * SeekIntervals.swift numberedSymbolSeconds.
 */
export function skipIcon(direction: "backward" | "forward", seconds: number): string {
    const arc = direction === "backward"
        ? `<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M19 8.2A7 7 0 1 0 19 16"/><path fill="currentColor" d="M16.6 4.6 20.2 8l-4.6.4z"/>`
        : `<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M5 8.2A7 7 0 1 1 5 16"/><path fill="currentColor" d="M7.4 4.6 3.8 8l4.6.4z"/>`;
    // Digit box of SF Symbol goforward.30 at TVPlayerTransportCluster's 25pt semibold: 9.25px tall.
    const number = NUMBERED_SECONDS.has(seconds) ? `<text x="12" y="15.2" text-anchor="middle" font-size="8.88" font-weight="600" fill="currentColor">${seconds}</text>` : "";
    return svg(`${arc}${number}`);
}

/** `chevron.forward` at `HUDSettingRowLabel`'s 15pt bold: an 11x15 frame around 8x13 of ink, as in Apple's capture. */
export function chevronForwardIcon(): string {
    return `<svg viewBox="0 0 11 15" focusable="false" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M2.7 2.2 8.3 7.5 2.7 12.8"/></svg>`;
}

/** `magnifyingglass`: the Search Subtitles row's symbol. */
export function magnifyingGlassIcon(): string {
    return svg(`<g fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="10.2" cy="10.2" r="6.6"/><path d="M15.2 15.2 21 21"/></g>`);
}

/** `sparkles`: the AI subtitle rows' symbol. One large and two small four-point stars. */
export function sparklesIcon(): string {
    const star = (x: number, y: number, r: number): string => {
        const k = r * 0.22;
        return `M${x} ${y - r}C${x + k} ${y - k} ${x + k} ${y - k} ${x + r} ${y}C${x + k} ${y + k} ${x + k} ${y + k} ${x} ${y + r}C${x - k} ${y + k} ${x - k} ${y + k} ${x - r} ${y}C${x - k} ${y - k} ${x - k} ${y - k} ${x} ${y - r}Z`;
    };
    return svg(`<path fill="currentColor" d="${star(9.5, 13.5, 8)}${star(18.5, 5.5, 3.6)}${star(19, 18, 2.6)}"/>`);
}
