// The Skyline page backdrop behind Home, For You and library landings. Ported (AGPL-3.0-or-later) from
// silo-apple 1a7cceeaf3b2bfc4f889c00487d19b2c6f843940 `tvOS/Components/TVRootHeroBackdrop.swift`
// (TVBackdropArtworkLayout, TVBackdropArtworkFadeMask, TVBackdropTintWash, the 190pt top scrim) and
// `Components/HeroBackdropPalette.swift` (the sampled base, accent and shadow tints):
// - The art is a 64% x 70% block in the top-right corner, fading toward the leading edge and the bottom.
// - The rest of the page carries colours sampled from that art over black, never a uniform black wash.
// - Apple samples a 64px decode redrawn at 24 x 24; Tizen samples the backdrop it already loaded the same
//   way, else the card's backdrop ThumbHash, else the page stays black (Apple's fallback when sampling fails).

import { decodeThumbhash } from "./thumbhash.ts";
import { el } from "./screen.ts";

export interface RGB { readonly r: number; readonly g: number; readonly b: number }
export interface Tints { readonly base: RGB; readonly accent: RGB; readonly shadow: RGB }

const SAMPLE_EDGE = 24;
const PALETTE_MAX_PIXEL = 64;
const BASE_LUMINANCE = 0.22;
const ACCENT_LUMINANCE = 0.22;
const SHADOW_LUMINANCE = 0.07;
const HUE_BINS = 12;

const luminance = (p: RGB): number => 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b;

function mean(pixels: readonly RGB[]): RGB {
    let r = 0, g = 0, b = 0;
    for (const p of pixels) { r += p.r; g += p.g; b += p.b; }
    return { r: r / pixels.length, g: g / pixels.length, b: b / pixels.length };
}

/** Dims bright samples and lifts very dark ones so the wash sits on black without overpowering the rows. */
function normalize(p: RGB, target: number): RGB {
    const value = luminance(p);
    const scale = value <= 0.001 ? 0 : value > target ? target / value : Math.max(1, target / Math.max(value, 0.05));
    return { r: Math.min(1, p.r * scale), g: Math.min(1, p.g * scale), b: Math.min(1, p.b * scale) };
}

/** Mean colour of the strongest hue bucket, each pixel weighted by (saturation x value)^2; none for grey art. */
function dominantHue(pixels: readonly RGB[]): RGB | undefined {
    const weights = new Array<number>(HUE_BINS).fill(0);
    const sums = Array.from({ length: HUE_BINS }, () => ({ r: 0, g: 0, b: 0 }));
    for (const p of pixels) {
        const max = Math.max(p.r, p.g, p.b);
        const chroma = max - Math.min(p.r, p.g, p.b);
        if (!(max > 0.15 && chroma > 0)) continue;
        const saturation = chroma / max;
        if (!(saturation > 0.2)) continue;
        let hue = max === p.r ? (p.g - p.b) / chroma : max === p.g ? (p.b - p.r) / chroma + 2 : (p.r - p.g) / chroma + 4;
        hue = (hue / 6) % 1;
        if (hue < 0) hue += 1;
        const bin = Math.min(HUE_BINS - 1, Math.floor(hue * HUE_BINS));
        const weight = (saturation * max) ** 2;
        weights[bin] = (weights[bin] ?? 0) + weight;
        const sum = sums[bin];
        if (sum !== undefined) { sum.r += p.r * weight; sum.g += p.g * weight; sum.b += p.b * weight; }
    }
    let best = 0;
    for (let bin = 1; bin < HUE_BINS; bin++) if ((weights[bin] ?? 0) > (weights[best] ?? 0)) best = bin;
    const weight = weights[best] ?? 0;
    const sum = sums[best];
    if (sum === undefined || weight < pixels.length * 0.01) return undefined;
    return { r: sum.r / weight, g: sum.g / weight, b: sum.b / weight };
}

/** HeroBackdropPalette.sample: base (mean), accent (strongest hue) and shadow (darkest quarter) tints. */
export function samplePalette(pixels: readonly RGB[]): Tints | undefined {
    if (pixels.length === 0) return undefined;
    const base = normalize(mean(pixels), BASE_LUMINANCE);
    const darkest = [...pixels].sort((a, b) => luminance(a) - luminance(b)).slice(0, Math.max(1, Math.floor(pixels.length / 4)));
    const shadow = normalize(mean(darkest), SHADOW_LUMINANCE);
    const hue = dominantHue(pixels);
    return { base, accent: hue === undefined ? base : normalize(hue, ACCENT_LUMINANCE), shadow };
}

export function cssColor(p: RGB, alpha = 1): string {
    const byte = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 255);
    return `rgba(${byte(p.r)},${byte(p.g)},${byte(p.b)},${alpha})`;
}

/** TVBackdropArtworkLayout: 64% of the width and 70% of the 16:9 height, anchored top-right. */
export function backdropFrame(viewportWidth: number): { left: number; top: number; width: number; height: number } {
    const width = Math.round(viewportWidth * 0.64 * 10) / 10;
    const height = Math.round(viewportWidth * 9 / 16 * 0.7 * 10) / 10;
    return { left: Math.round((viewportWidth - width) * 10) / 10, top: 0, width, height };
}

function rgbaPixels(data: ArrayLike<number>): RGB[] {
    const pixels: RGB[] = [];
    for (let index = 0; index + 2 < data.length; index += 4) pixels.push({ r: (data[index] ?? 0) / 255, g: (data[index + 1] ?? 0) / 255, b: (data[index + 2] ?? 0) / 255 });
    return pixels;
}

/** Samples a loaded image as Apple does (a 64px decode redrawn at 24 x 24); undefined when the canvas is tainted. */
export function sampleImage(image: HTMLImageElement): Tints | undefined {
    const width = image.naturalWidth, height = image.naturalHeight;
    if (width <= 0 || height <= 0) return undefined;
    try {
        const scale = Math.min(1, PALETTE_MAX_PIXEL / Math.max(width, height));
        const thumb = document.createElement("canvas");
        thumb.width = Math.max(1, Math.round(width * scale));
        thumb.height = Math.max(1, Math.round(height * scale));
        thumb.getContext("2d")?.drawImage(image, 0, 0, thumb.width, thumb.height);
        const edge = document.createElement("canvas");
        edge.width = SAMPLE_EDGE;
        edge.height = SAMPLE_EDGE;
        const context = edge.getContext("2d");
        if (context === null) return undefined;
        context.drawImage(thumb, 0, 0, SAMPLE_EDGE, SAMPLE_EDGE);
        return samplePalette(rgbaPixels(context.getImageData(0, 0, SAMPLE_EDGE, SAMPLE_EDGE).data));
    } catch {
        // A server that sends no CORS headers for artwork leaves the canvas tainted on some runtimes.
        return undefined;
    }
}

export function sampleThumbhash(encoded: string | undefined): Tints | undefined {
    const decoded = decodeThumbhash(encoded);
    return decoded === undefined ? undefined : samplePalette(rgbaPixels(decoded.rgba));
}

/** TVBackdropTintWash over black: base from the top-right, accent glow under the rows, shadow pooled bottom-left. */
export function washBackground(tints: Tints | undefined): string {
    if (tints === undefined) return "#000";
    // SwiftUI's topTrailing-to-bottomLeading axis is the 1920 x 1080 diagonal: 180deg + atan(1920 / 1080).
    return [
        `radial-gradient(806.4px 453.6px at 0% 100%, ${cssColor(tints.shadow, 0.55)}, ${cssColor(tints.shadow, 0)})`,
        `radial-gradient(576px 324px at 70% 100%, ${cssColor(tints.accent, 0.3)}, ${cssColor(tints.accent, 0)})`,
        `linear-gradient(240.64deg, ${cssColor(tints.base)} 0%, ${cssColor(tints.base, 0.5)} 45%, ${cssColor(tints.base, 0.18)} 100%)`,
        "#000",
    ].join(", ");
}

/**
 * The backdrop for one marquee selection: the tint wash, the masked art block and the top scrim. Tints
 * already sampled for the URL apply at once; otherwise they follow the image's load.
 */
export function heroBackdrop(url: string, thumbhash: string | undefined, cache: Map<string, Tints>): HTMLElement {
    const root = el("div", "skyline-hero-backdrop");
    const wash = el("div", "skyline-tint-wash");
    const paint = (tints: Tints | undefined): void => { wash.style.background = washBackground(tints); };
    paint(cache.get(url) ?? sampleThumbhash(thumbhash));
    const frame = el("div", "skyline-art-frame");
    const image = el("img", "skyline-backdrop");
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("load", () => {
        if (cache.has(url)) return;
        const apply = (tints: Tints | undefined): void => {
            if (tints === undefined) return;
            cache.set(url, tints);
            paint(tints);
        };
        const local = sampleImage(image);
        if (local !== undefined) { apply(local); return; }
        // Keep the visible image credential-free and usable when the server refuses CORS sampling.
        const sample = new Image();
        sample.crossOrigin = "anonymous";
        sample.referrerPolicy = "no-referrer";
        sample.addEventListener("load", () => apply(sampleImage(sample)));
        sample.src = url;
    });
    image.addEventListener("error", () => { image.remove(); frame.remove(); root.querySelector(".skyline-top-scrim")?.remove(); });
    image.src = url;
    frame.appendChild(image);
    root.append(wash, frame, el("div", "skyline-top-scrim"));
    return root;
}
