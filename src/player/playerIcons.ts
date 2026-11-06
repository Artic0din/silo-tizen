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
