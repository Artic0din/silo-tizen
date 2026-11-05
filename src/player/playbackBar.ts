import { el } from "../ui/screen.ts";

/** Shared accessible progress track; each player owns its remote seek policy. */
export function playbackBar(label: string): HTMLDivElement {
    const bar = el("div", "player-bar");
    bar.setAttribute("role", "slider");
    bar.setAttribute("aria-label", label);
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("data-focus", "position");
    bar.tabIndex = -1;
    return bar;
}
