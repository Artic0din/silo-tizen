import type { PlaybackView } from "./controller.ts";
import type { SubtitleAppearance } from "../contracts/v2/subtitles.ts";

export function mountSubtitles(parent: HTMLElement): (view: PlaybackView) => void {
    const viewport = document.createElement("div");
    Object.assign(viewport.style, { position: "absolute", inset: "0", width: "1920px", height: "1080px", pointerEvents: "none", transformOrigin: "0 0" });
    parent.appendChild(viewport);
    const layer = document.createElement("div");
    layer.className = "player-captions";
    layer.setAttribute("aria-live", "off");
    const text = document.createElement("span");
    layer.appendChild(text);
    viewport.appendChild(layer);
    return view => {
        viewport.style.transform = (view.phase === "playing" || view.phase === "paused") && view.upNext !== undefined ? "translate(180px, 112px) scale(0.3958333333333333)" : "none";
        const captions = view.phase === "playing" || view.phase === "paused" ? view.captions : undefined;
        text.textContent = captions?.text ?? "";
        layer.hidden = !captions?.text;
        if (captions === undefined) return;
        applySubtitleAppearance(layer, text, captions.appearance);
    };
}

export function applySubtitleAppearance(layer: HTMLElement, text: HTMLElement, style: SubtitleAppearance): void {
        layer.style.top = style.position === "top" ? "8%" : "auto";
        layer.style.bottom = style.position === "top" ? "auto" : style.position === "lower-third" ? "25%" : "8%";
        // AetherSubtitleOverlay draws the generic families semibold and a named family at its own weight.
        // Samsung's generic sans-serif face has no semibold, so sans-serif uses the bundled Inter (theme.css).
        const bundledSans = style.fontFamily === "sans-serif";
        const generic = bundledSans || style.fontFamily === "serif" || style.fontFamily === "monospace";
        text.style.fontFamily = `${bundledSans ? "Inter" : style.fontFamily}, sans-serif`;
        text.style.fontWeight = generic ? "600" : "";
        text.style.fontSize = `${{ small: 28, medium: 36, large: 44, xlarge: 54, xxlarge: 64 }[style.fontSize]}px`;
        const rgba = (color: string, opacity: number): string => `rgba(${parseInt(color.slice(1, 3), 16)},${parseInt(color.slice(3, 5), 16)},${parseInt(color.slice(5, 7), 16)},${opacity / 100})`;
        text.style.color = rgba(style.fontColor, style.textOpacity);
        text.style.backgroundColor = style.backgroundStyle === "box" ? rgba(style.backgroundColor, style.backgroundOpacity) : "transparent";
        const outline = style.textOutline || style.backgroundStyle === "outline";
        text.style.textShadow = outline ? `-2px -2px 0 ${style.textOutlineColor},2px -2px 0 ${style.textOutlineColor},-2px 2px 0 ${style.textOutlineColor},2px 2px 0 ${style.textOutlineColor}` : style.backgroundStyle === "shadow" ? `2px 2px 4px ${rgba(style.backgroundColor, style.backgroundOpacity)}` : "none";
}
