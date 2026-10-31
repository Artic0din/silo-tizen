import type { PlaybackView } from "./controller.ts";

export function mountSubtitles(parent: HTMLElement): (view: PlaybackView) => void {
    const layer = document.createElement("div");
    layer.className = "player-captions";
    layer.setAttribute("aria-live", "off");
    const text = document.createElement("span");
    layer.appendChild(text);
    parent.appendChild(layer);
    return view => {
        const captions = view.phase === "playing" || view.phase === "paused" ? view.captions : undefined;
        text.textContent = captions?.text ?? "";
        layer.hidden = !captions?.text;
        if (captions === undefined) return;
        const style = captions.appearance;
        layer.style.top = style.position === "top" ? "8%" : "auto";
        layer.style.bottom = style.position === "top" ? "auto" : style.position === "lower-third" ? "25%" : "8%";
        text.style.fontFamily = `${style.fontFamily}, sans-serif`;
        text.style.fontSize = `${{ small: 28, medium: 36, large: 44, xlarge: 54, xxlarge: 64 }[style.fontSize]}px`;
        const rgba = (color: string, opacity: number): string => `rgba(${parseInt(color.slice(1, 3), 16)},${parseInt(color.slice(3, 5), 16)},${parseInt(color.slice(5, 7), 16)},${opacity / 100})`;
        text.style.color = rgba(style.fontColor, style.textOpacity);
        text.style.backgroundColor = style.backgroundStyle === "box" ? rgba(style.backgroundColor, style.backgroundOpacity) : "transparent";
        const outline = style.textOutline || style.backgroundStyle === "outline";
        text.style.textShadow = outline ? `-2px -2px 0 ${style.textOutlineColor},2px -2px 0 ${style.textOutlineColor},-2px 2px 0 ${style.textOutlineColor},2px 2px 0 ${style.textOutlineColor}` : style.backgroundStyle === "shadow" ? `2px 2px 4px ${rgba(style.backgroundColor, style.backgroundOpacity)}` : "none";
    };
}
