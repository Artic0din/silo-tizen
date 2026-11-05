// Poster badges (`ui.card_overlays`): the document parser, the badge registry and the corner renderer.
// Ported (AGPL-3.0-or-later) from silo-apple 1a7cceeaf3b2bfc4f889c00487d19b2c6f843940:
// iosApp/iosApp/Overlays/{OverlayTypes,OverlaySchema,OverlayRegistry,OverlayExtractors,OverlayPresets,CardOverlays,OverlayIcon}.swift.
// Generic badge icons are SF Symbols there and are not drawn here, except the
// series-status tv glyph: a flat screen in that symbol's layout box, without its foot.
// Brand marks are text in both.

import type { Card } from "../contracts/v2/catalog.ts";
import { resolutionLabel, runtimeText } from "./cardPresentation.ts";
import { el } from "./screen.ts";

type Position = "top-left" | "top-right" | "bottom-left" | "bottom-right";
type PresetId = "minimal" | "classic" | "vibrant" | "pill" | "square";
type Icon = "generic" | "tv" | "HDR" | "HDR10" | "DV" | "ATMOS" | "AV1";

interface ItemConfig { readonly enabled: boolean; readonly position: Position; readonly accentColor: string | undefined; readonly showIcon: boolean | undefined }
export interface CardOverlayPrefs { readonly preset: PresetId; readonly order: readonly string[]; readonly items: ReadonlyMap<string, ItemConfig> }

interface OverlayDef {
    readonly id: string;
    readonly position: Position;
    readonly enabled: boolean;
    readonly accent?: string;
    readonly iconCapable: boolean;
    /** The static icon; `icon` below overrides it. */
    readonly staticIcon?: Icon;
    readonly icon?: (card: Card) => Icon | undefined;
    readonly value: (card: Card) => string | undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
    return value === undefined || value === "" ? undefined : value;
}
const oneDecimal = (value: number): string => (Math.round(value * 10) / 10).toFixed(1);
const decimalRating = (mark: string, value: number | undefined): string | undefined => value === undefined ? undefined : `${mark} ${oneDecimal(value)}`;
const percentRating = (mark: string, value: number | undefined): string | undefined => value === undefined ? undefined : `${mark} ${value}%`;

function hdrIcon(value: string | undefined): Icon | undefined {
    if (nonEmpty(value) === undefined) return undefined;
    if (value?.includes("DV")) return "DV";
    return value === "HDR10" ? "HDR10" : value === "HDR" ? "HDR" : undefined;
}

function showStatus(value: string | undefined): string | undefined {
    const raw = nonEmpty(value);
    if (raw === undefined) return undefined;
    const lowered = raw.toLowerCase();
    if (["returning", "returning series", "continuing", "in_production", "in production"].includes(lowered)) return "Returning";
    if (lowered === "ended") return "Ended";
    if (lowered === "cancelled" || lowered === "canceled") return "Cancelled";
    return lowered === "upcoming" || lowered === "planned" ? "Upcoming" : raw;
}

export function languageName(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed === "") return undefined;
    try {
        const name = new Intl.DisplayNames(["en"], { type: "language" }).of(trimmed);
        if (name !== undefined && name !== trimmed) return name.replace(/\b\w/g, letter => letter.toUpperCase());
    } catch { /* an invalid tag falls back to its code */ }
    return trimmed.toUpperCase();
}

const firstNonEmpty = (values: readonly string[] | undefined): string | undefined => values?.find(value => value !== "");

/** Registry order is the default render order within a corner. */
const REGISTRY: readonly OverlayDef[] = [
    { id: "resolution", position: "top-left", enabled: true, iconCapable: true, staticIcon: "generic", value: card => resolutionLabel(card.overlay?.resolution) },
    { id: "hdr", position: "top-left", enabled: true, iconCapable: true, icon: card => hdrIcon(card.overlay?.hdr), value: card => nonEmpty(card.overlay?.hdr) },
    { id: "resolution_hdr", position: "top-left", enabled: false, iconCapable: true, icon: card => card.overlay?.hdr?.includes("DV") ? "DV" : undefined, value: card => {
        const resolution = resolutionLabel(card.overlay?.resolution);
        const hdr = nonEmpty(card.overlay?.hdr);
        return resolution === undefined ? undefined : hdr === undefined ? resolution : `${resolution} ${hdr.includes("DV") ? "DV" : "HDR"}`;
    } },
    { id: "audio", position: "top-left", enabled: true, iconCapable: true, icon: card => nonEmpty(card.overlay?.audio) === undefined ? undefined : card.overlay?.audio?.toLowerCase().includes("atmos") ? "ATMOS" : "generic", value: card => nonEmpty(card.overlay?.audio) },
    { id: "audio_channels", position: "top-left", enabled: false, iconCapable: true, staticIcon: "generic", value: card => nonEmpty(card.overlay?.audioChannels) },
    { id: "video_codec", position: "top-left", enabled: false, iconCapable: true, staticIcon: "generic", icon: card => nonEmpty(card.overlay?.videoCodec) === undefined ? undefined : card.overlay?.videoCodec === "AV1" ? "AV1" : "generic", value: card => nonEmpty(card.overlay?.videoCodec) },
    { id: "container", position: "bottom-left", enabled: false, iconCapable: false, value: card => nonEmpty(card.overlay?.container) },
    { id: "aspect_ratio", position: "bottom-right", enabled: false, iconCapable: true, staticIcon: "generic", value: card => nonEmpty(card.overlay?.aspectRatio) },
    { id: "release_type", position: "bottom-left", enabled: true, iconCapable: false, value: card => nonEmpty(card.overlay?.releaseType) },
    { id: "edition", position: "bottom-left", enabled: false, iconCapable: false, value: card => nonEmpty(card.overlay?.edition) },
    { id: "multi_audio", position: "bottom-right", enabled: false, iconCapable: true, staticIcon: "generic", value: card => card.overlay?.multiAudio === true ? "Multi-Audio" : undefined },
    { id: "multi_sub", position: "bottom-right", enabled: false, iconCapable: true, staticIcon: "generic", value: card => card.overlay?.multiSub === true ? "CC" : undefined },
    { id: "rating_imdb", position: "top-right", enabled: false, accent: "#f5c518", iconCapable: false, value: card => decimalRating("IMDb", card.ratingImdb) },
    { id: "rating_tmdb", position: "top-right", enabled: false, accent: "#01b4e4", iconCapable: false, value: card => decimalRating("TMDB", card.ratingTmdb) },
    { id: "rating_rt", position: "top-right", enabled: false, accent: "#fa320a", iconCapable: false, value: card => percentRating("RT", card.ratingRtCritic) },
    { id: "rating_rt_audience", position: "top-right", enabled: false, accent: "#fa6400", iconCapable: false, value: card => percentRating("RT Audience", card.ratingRtAudience) },
    { id: "content_rating", position: "bottom-right", enabled: false, iconCapable: true, staticIcon: "generic", value: card => card.contentRating },
    { id: "advisory_age", position: "bottom-right", enabled: false, iconCapable: true, staticIcon: "generic", value: card => card.advisoryAge !== undefined && card.advisoryAge > 0 ? `${card.advisoryAge}+` : undefined },
    { id: "year", position: "bottom-left", enabled: false, iconCapable: false, value: card => card.year !== undefined && card.year > 0 ? String(card.year) : undefined },
    { id: "runtime", position: "bottom-left", enabled: false, iconCapable: true, staticIcon: "generic", value: card => runtimeText(card.runtimeMinutes) },
    { id: "original_language", position: "bottom-left", enabled: false, iconCapable: true, staticIcon: "generic", value: card => languageName(card.originalLanguage) },
    { id: "studio", position: "bottom-right", enabled: false, iconCapable: true, staticIcon: "generic", value: card => firstNonEmpty(card.studios) },
    { id: "network", position: "bottom-right", enabled: false, iconCapable: true, staticIcon: "generic", value: card => firstNonEmpty(card.networks) },
    { id: "show_status", position: "top-right", enabled: false, iconCapable: true, staticIcon: "tv", value: card => showStatus(card.showStatus) },
    // Ribbons whose data the server does not send yet; kept so stored documents keep their entries.
    { id: "imdb_top_250", position: "top-right", enabled: false, accent: "#f5c518", iconCapable: true, staticIcon: "generic", value: () => undefined },
    { id: "rt_certified_fresh", position: "top-right", enabled: false, accent: "#fa320a", iconCapable: false, value: () => undefined },
];

const POSITIONS: readonly Position[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
const PRESETS: readonly PresetId[] = ["minimal", "classic", "vibrant", "pill", "square"];

function registryDefaults(): Map<string, ItemConfig> {
    return new Map(REGISTRY.map(def => [def.id, { enabled: def.enabled, position: def.position, accentColor: undefined, showIcon: undefined }]));
}

function patch(base: ItemConfig, raw: unknown): ItemConfig {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return base;
    const entry = raw as Record<string, unknown>;
    return {
        enabled: typeof entry.enabled === "boolean" ? entry.enabled : base.enabled,
        position: POSITIONS.find(position => position === entry.position) ?? base.position,
        accentColor: typeof entry.accentColor === "string" && /^#[0-9a-fA-F]{6}$/.test(entry.accentColor) ? entry.accentColor : undefined,
        showIcon: typeof entry.showIcon === "boolean" ? entry.showIcon : undefined,
    };
}

/**
 * The profile's stored document (a JSON object) or the administrator's baseline (a JSON string); anything
 * unreadable is the registry defaults. Unknown ids are dropped; version 1 flat documents are migrated.
 */
export function parseOverlayPrefs(raw: unknown): CardOverlayPrefs {
    let doc = raw;
    if (typeof raw === "string") {
        try { doc = raw === "" ? undefined : JSON.parse(raw); } catch { doc = undefined; }
    }
    const items = registryDefaults();
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { preset: "classic", order: [], items };
    const obj = doc as Record<string, unknown>;
    const v2 = obj.version === 2;
    const patches = v2 ? obj.items : obj;
    if (typeof patches === "object" && patches !== null) {
        for (const [id, base] of items) items.set(id, patch(base, (patches as Record<string, unknown>)[id]));
    }
    return {
        preset: (v2 && PRESETS.find(preset => preset === obj.preset)) || "classic",
        order: v2 && Array.isArray(obj.order) ? obj.order.filter((id): id is string => typeof id === "string" && REGISTRY.some(def => def.id === id)) : [],
        items,
    };
}

/** Enabled badges for a corner, in the document's order; the combined resolution badge hides its two parts. */
function enabledAt(position: Position, prefs: CardOverlayPrefs): OverlayDef[] {
    const combined = prefs.items.get("resolution_hdr")?.enabled === true;
    const candidates = REGISTRY.filter(def => {
        const config = prefs.items.get(def.id);
        return config !== undefined && config.enabled && config.position === position && !(combined && (def.id === "resolution" || def.id === "hdr"));
    });
    if (prefs.order.length === 0) return candidates;
    const rank = (id: string): number => { const index = prefs.order.indexOf(id); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
    return candidates.map((def, index) => ({ def, index })).sort((a, b) => rank(a.def.id) - rank(b.def.id) || a.index - b.index).map(entry => entry.def);
}

interface Preset {
    readonly fontSize: number; readonly weight: number; readonly tracking: number; readonly padX: number; readonly padY: number;
    /** Undefined is a capsule. */
    readonly radius: number | undefined;
    readonly iconSize: number; readonly preferIcon: boolean; readonly gap: number;
    readonly background: (accent: Rgb | undefined) => string;
    readonly foreground: (accent: Rgb | undefined) => string;
    readonly border: (accent: Rgb | undefined) => string | undefined;
    readonly blur: boolean; readonly shadow: boolean;
}
type Rgb = readonly [number, number, number];
const rgba = ([r, g, b]: Rgb, alpha = 1): string => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha})`;
const mix = (from: Rgb, to: Rgb, by: number): Rgb => [from[0] + (to[0] - from[0]) * by, from[1] + (to[1] - from[1]) * by, from[2] + (to[2] - from[2]) * by];
const BLACK: Rgb = [0, 0, 0];
const PILL_BASE: Rgb = [20, 20, 30];
const WHITE = "#fff";
const BORDER = "rgba(255,255,255,.15)";

const PRESET_STYLES: Readonly<Record<PresetId, Preset>> = {
    minimal: { fontSize: 9, weight: 600, tracking: 1.2, padX: 4, padY: 1, radius: 2, iconSize: 10, preferIcon: false, gap: 2, background: () => "transparent", foreground: accent => accent === undefined ? "rgba(255,255,255,.85)" : rgba(accent), border: () => undefined, blur: false, shadow: true },
    classic: { fontSize: 10, weight: 600, tracking: 0.6, padX: 8, padY: 3, radius: undefined, iconSize: 11, preferIcon: false, gap: 4, background: accent => accent === undefined ? "rgba(0,0,0,.6)" : rgba(mix(accent, BLACK, 0.28), 0.888), foreground: () => WHITE, border: () => BORDER, blur: false, shadow: false },
    vibrant: { fontSize: 10, weight: 700, tracking: 0.6, padX: 8, padY: 3, radius: 6, iconSize: 12, preferIcon: true, gap: 4, background: accent => accent === undefined ? rgba([219.3, 219.3, 219.3]) : rgba(accent), foreground: accent => accent === undefined ? "#000" : WHITE, border: () => undefined, blur: false, shadow: false },
    pill: { fontSize: 10, weight: 600, tracking: 0.6, padX: 10, padY: 4, radius: undefined, iconSize: 12, preferIcon: true, gap: 4, background: accent => accent === undefined ? rgba(PILL_BASE, 0.7) : rgba(mix(accent, PILL_BASE, 0.2), 0.94), foreground: () => WHITE, border: () => BORDER, blur: true, shadow: false },
    square: { fontSize: 9, weight: 700, tracking: 1.2, padX: 6, padY: 2, radius: 2, iconSize: 10, preferIcon: false, gap: 2, background: () => "rgba(0,0,0,.8)", foreground: accent => accent === undefined ? WHITE : rgba(accent), border: accent => accent === undefined ? undefined : rgba(accent), blur: false, shadow: false },
};

function hex(value: string): Rgb {
    return [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16)];
}

/** Apple scales poster badges from the 185pt web poster; wide (Continue Watching) badges stay at 1. */
const POSTER_REFERENCE_WIDTH = 185;

/** The badge layer for one card's artwork, or undefined when no badge has a value. */
export function overlayLayer(card: Card, prefs: CardOverlayPrefs, variant: "poster" | "wide", artWidth: number): HTMLElement | undefined {
    const preset = PRESET_STYLES[prefs.preset];
    const scale = variant === "poster" ? artWidth / POSTER_REFERENCE_WIDTH : 1;
    const px = (value: number): string => `${Math.round(value * scale * 100) / 100}px`;
    const layer = el("span", "card-overlays");
    layer.setAttribute("aria-hidden", "true");
    for (const position of POSITIONS) {
        const badges = enabledAt(position, prefs).flatMap(def => {
            const label = def.value(card);
            if (label === undefined) return [];
            const config = prefs.items.get(def.id);
            const icon = def.icon?.(card) ?? def.staticIcon;
            const showIcon = icon !== undefined && def.iconCapable && (config?.showIcon ?? preset.preferIcon);
            const accent = config?.accentColor ?? def.accent;
            return [{ label, mark: showIcon && icon !== undefined && icon !== "generic" && icon !== "tv" ? icon : undefined, tv: showIcon && icon === "tv", accent: accent === undefined ? undefined : hex(accent) }];
        });
        if (badges.length === 0) continue;
        const stack = el("span", `card-overlay-stack card-overlay-${position}`);
        const [vertical, horizontal] = position.split("-") as ["top" | "bottom", "left" | "right"];
        // Wide cards leave room under the badges for the progress bar.
        stack.style.setProperty(vertical, vertical === "bottom" && variant === "wide" ? "24px" : px(8));
        stack.style.setProperty(horizontal, px(8));
        stack.style.alignItems = horizontal === "left" ? "flex-start" : "flex-end";
        for (const badge of badges) {
            const node = el("span", "card-overlay");
            const style = node.style;
            style.marginTop = stack.childElementCount === 0 ? "0" : px(preset.gap);
            style.padding = `${px(preset.padY)} ${px(preset.padX)}`;
            style.borderRadius = preset.radius === undefined ? "999px" : px(preset.radius);
            style.background = preset.background(badge.accent);
            style.color = preset.foreground(badge.accent);
            style.fontSize = px(preset.fontSize);
            style.fontWeight = String(preset.weight);
            style.letterSpacing = px(preset.tracking);
            const border = preset.border(badge.accent);
            if (border !== undefined) style.boxShadow = `inset 0 0 0 ${px(1)} ${border}`;
            if (preset.blur) style.setProperty("backdrop-filter", "blur(20px)");
            if (preset.shadow) style.textShadow = `0 ${px(1)} ${px(1)} rgba(0,0,0,.85)`;
            // A brand mark draws its own token, so the label drops it ("DV HDR10" with the DV mark reads "HDR10").
            const label = badge.mark === undefined ? badge.label : badge.label.split(" ").filter(word => word.toLowerCase() !== badge.mark?.toLowerCase()).join(" ");
            if (badge.tv) {
                const glyph = tvIcon();
                // OverlayIcon draws SF Symbol "tv" at iconSize * scale. That image is not a
                // square of the point size: at 48pt the symbol's layout box is 73×58.
                glyph.style.width = px(preset.iconSize * TV_SYMBOL_WIDTH);
                glyph.style.height = px(preset.iconSize * TV_SYMBOL_HEIGHT);
                // OverlayBadgeView's HStack spacing, 4, separate from the stack gap.
                if (label !== "") glyph.style.marginRight = px(4);
                node.appendChild(glyph);
            }
            if (badge.mark !== undefined) {
                const mark = el("span", "card-overlay-mark", badge.mark);
                mark.style.fontSize = px(preset.iconSize * 0.78);
                if (label !== "") mark.style.marginRight = px(4);
                node.appendChild(mark);
            }
            if (label !== "") node.appendChild(document.createTextNode(label));
            stack.appendChild(node);
        }
        layer.appendChild(stack);
    }
    return layer.childElementCount === 0 ? undefined : layer;
}

/**
 * SF Symbol "tv" layout box divided by the font point size (`OverlayIcon` at 48pt
 * is 73×58). CardOverlays passes `iconSize * scale` as that point size.
 */
const TV_SYMBOL_WIDTH = 73 / 48;
const TV_SYMBOL_HEIGHT = 58 / 48;

/**
 * Flat screen of SF Symbol "tv", without its foot. The screen sits in the symbol's
 * layout box (measured at 48pt: origin 6,4.25, size 60.75×40.75, corner 10).
 */
function tvIcon(): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "card-overlay-icon");
    svg.setAttribute("viewBox", "0 0 73 58");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", roundedRect(6, 4.25, 60.75, 40.75, 10));
    svg.appendChild(path);
    return svg;
}

function roundedRect(x: number, y: number, width: number, height: number, radius: number): string {
    const r = Math.min(radius, width / 2, height / 2);
    return `M${x + r} ${y}H${x + width - r}A${r} ${r} 0 0 1 ${x + width} ${y + r}V${y + height - r}A${r} ${r} 0 0 1 ${x + width - r} ${y + height}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + height - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
}
