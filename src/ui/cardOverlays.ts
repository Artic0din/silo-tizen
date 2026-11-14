// Poster badges (`ui.card_overlays`): the document parser, the badge registry and the layout renderer.
// Ported (AGPL-3.0-or-later) from silo-apple 1a7cceeaf3b2bfc4f889c00487d19b2c6f843940:
// iosApp/iosApp/Overlays/{OverlayTypes,OverlaySchema,OverlayRegistry,OverlayExtractors,OverlayPresets,CardOverlays,OverlayIcon}.swift.
// Positions, presets, layout and the CardWatchStatus corner follow silo-apple 5780c84f4a9c1e2bff006e653dd787e01ca24480 (#1117). Its plate and
// band presets, style overrides and uploaded badge images are not drawn here.
// Generic badge icons are SF Symbols there and are not drawn here, except the
// series-status tv glyph: OverlayIcon's semibold "tv", outline and foot opaque,
// screen fill at the monochrome secondary opacity.
// Brand marks are text in both.

import type { Card } from "../contracts/v2/catalog.ts";
import { resolutionLabel, runtimeText } from "./cardPresentation.ts";
import { el } from "./screen.ts";

/** OverlayTypes.swift:44-65: the top-right corner belongs to the watch status, so badges use the side rails. */
type Position = "top-left" | "bottom-left" | "bottom-right" | "left-edge" | "right-edge";
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
    { id: "rating_imdb", position: "left-edge", enabled: false, accent: "#f5c518", iconCapable: false, value: card => decimalRating("IMDb", card.ratingImdb) },
    { id: "rating_tmdb", position: "left-edge", enabled: false, accent: "#01b4e4", iconCapable: false, value: card => decimalRating("TMDB", card.ratingTmdb) },
    { id: "rating_rt", position: "left-edge", enabled: false, accent: "#fa320a", iconCapable: false, value: card => percentRating("RT", card.ratingRtCritic) },
    { id: "rating_rt_audience", position: "left-edge", enabled: false, accent: "#fa6400", iconCapable: false, value: card => percentRating("RT Audience", card.ratingRtAudience) },
    { id: "content_rating", position: "bottom-right", enabled: false, iconCapable: true, staticIcon: "generic", value: card => card.contentRating },
    { id: "advisory_age", position: "bottom-right", enabled: false, iconCapable: true, staticIcon: "generic", value: card => card.advisoryAge !== undefined && card.advisoryAge > 0 ? `${card.advisoryAge}+` : undefined },
    { id: "year", position: "bottom-left", enabled: false, iconCapable: false, value: card => card.year !== undefined && card.year > 0 ? String(card.year) : undefined },
    { id: "runtime", position: "bottom-left", enabled: false, iconCapable: true, staticIcon: "generic", value: card => runtimeText(card.runtimeMinutes) },
    { id: "original_language", position: "bottom-left", enabled: false, iconCapable: true, staticIcon: "generic", value: card => languageName(card.originalLanguage) },
    { id: "studio", position: "bottom-right", enabled: false, iconCapable: true, staticIcon: "generic", value: card => firstNonEmpty(card.studios) },
    { id: "network", position: "bottom-right", enabled: false, iconCapable: true, staticIcon: "generic", value: card => firstNonEmpty(card.networks) },
    { id: "show_status", position: "right-edge", enabled: false, iconCapable: true, staticIcon: "tv", value: card => showStatus(card.showStatus) },
    // Ribbons whose data the server does not send yet; kept so stored documents keep their entries.
    { id: "imdb_top_250", position: "right-edge", enabled: false, accent: "#f5c518", iconCapable: true, staticIcon: "generic", value: () => undefined },
    { id: "rt_certified_fresh", position: "right-edge", enabled: false, accent: "#fa320a", iconCapable: false, value: () => undefined },
];

const POSITIONS: readonly Position[] = ["top-left", "bottom-left", "bottom-right", "left-edge", "right-edge"];

/** OverlayTypes.swift:58-64: a badge stored at top-right, from before that corner held watch status, draws on the right rail. */
function storedPosition(value: unknown): Position | undefined {
    return value === "top-right" ? "right-edge" : POSITIONS.find(position => position === value);
}
const PRESETS: readonly PresetId[] = ["minimal", "classic", "vibrant", "pill", "square"];

function registryDefaults(): Map<string, ItemConfig> {
    return new Map(REGISTRY.map(def => [def.id, { enabled: def.enabled, position: def.position, accentColor: undefined, showIcon: undefined }]));
}

function patch(base: ItemConfig, raw: unknown): ItemConfig {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return base;
    const entry = raw as Record<string, unknown>;
    return {
        enabled: typeof entry.enabled === "boolean" ? entry.enabled : base.enabled,
        position: storedPosition(entry.position) ?? base.position,
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

/** A straight-alpha sRGB colour: channels 0–255, alpha 0–1. */
type Rgba = readonly [number, number, number, number];
const css = ([r, g, b, a]: Rgba): string => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${Math.round(a * 1000) / 1000})`;
/** OverlayColor.swift:52-67, CSS `color-mix(in srgb, color share, other)` on premultiplied channels. */
function mixed(color: Rgba, share: number, other: Rgba): Rgba {
    const rest = 1 - share;
    const alpha = color[3] * share + other[3] * rest;
    if (alpha <= 0) return [0, 0, 0, 0];
    const channel = (index: 0 | 1 | 2): number => (color[index] * color[3] * share + other[index] * other[3] * rest) / alpha;
    return [channel(0), channel(1), channel(2), alpha];
}
const WHITE: Rgba = [255, 255, 255, 1];
const BLACK_60: Rgba = [0, 0, 0, 0.6];
const PILL_BASE: Rgba = [20, 20, 30, 0.7];
const WHITE_BORDER = "rgba(255,255,255,0.15)";

/** An offset shadow in points at the reference width. CSS blur is twice SwiftUI's radius (CardOverlays.swift:501-519). */
interface Shadow { readonly y: number; readonly blur: number; readonly color: string }
interface Paint { readonly background: string; readonly foreground: string; readonly border?: string; readonly bar?: string }
interface Preset {
    readonly fontSize: number; readonly weight: number;
    /** Letter spacing as a share of the font size. */
    readonly tracking: number;
    readonly padX: number; readonly padY: number;
    /** Undefined is a capsule. */
    readonly radius: number | undefined;
    readonly border: number | undefined;
    /** The accent bar on the badge's left side. */
    readonly bar: number | undefined;
    readonly textShadow: Shadow | undefined; readonly boxShadow: Shadow | undefined;
    readonly iconSize: number; readonly iconGap: number; readonly preferIcon: boolean; readonly gap: number;
    /** A filled badge on a rail is a tab flush against the card edge; a transparent one keeps the corner inset. */
    readonly flushRails: boolean;
    readonly paint: (accent: Rgba | undefined) => Paint;
}

/** Tailwind's `tracking-wide` and `tracking-widest` (OverlayPresets.swift:26-28). */
const TRACKING_WIDE = 0.025;
const TRACKING_WIDEST = 0.1;

/** OverlayPresets.swift:32-172 at 5780c84, the web's numbers with its default theme's radii. */
const PRESET_STYLES: Readonly<Record<PresetId, Preset>> = {
    minimal: { fontSize: 9, weight: 600, tracking: TRACKING_WIDEST, padX: 4, padY: 0, radius: 8, border: undefined, bar: undefined, textShadow: { y: 1, blur: 2, color: "rgba(0,0,0,0.85)" }, boxShadow: undefined, iconSize: 10, iconGap: 4, preferIcon: false, gap: 2, flushRails: false,
        paint: accent => ({ background: "transparent", foreground: accent === undefined ? "rgba(255,255,255,0.85)" : css(accent) }) },
    classic: { fontSize: 10, weight: 600, tracking: TRACKING_WIDE, padX: 8, padY: 2, radius: undefined, border: 1, bar: undefined, textShadow: undefined, boxShadow: undefined, iconSize: 11, iconGap: 4, preferIcon: false, gap: 4, flushRails: true,
        paint: accent => ({ background: css(accent === undefined ? BLACK_60 : mixed(accent, 0.28, BLACK_60)), foreground: css(WHITE), border: WHITE_BORDER }) },
    vibrant: { fontSize: 10, weight: 700, tracking: TRACKING_WIDE, padX: 8, padY: 2, radius: 10, border: undefined, bar: undefined, textShadow: undefined, boxShadow: { y: 1, blur: 2, color: "rgba(0,0,0,0.25)" }, iconSize: 12, iconGap: 4, preferIcon: true, gap: 4, flushRails: true,
        paint: accent => ({ background: css(accent ?? [220, 220, 220, 0.95]), foreground: accent === undefined ? "#000" : css(WHITE) }) },
    pill: { fontSize: 10, weight: 600, tracking: TRACKING_WIDE, padX: 10, padY: 4, radius: undefined, border: 1, bar: undefined, textShadow: undefined, boxShadow: undefined, iconSize: 12, iconGap: 4, preferIcon: true, gap: 4, flushRails: true,
        paint: accent => ({ background: css(accent === undefined ? PILL_BASE : mixed(accent, 0.2, PILL_BASE)), foreground: css(WHITE), border: WHITE_BORDER }) },
    square: { fontSize: 9, weight: 700, tracking: TRACKING_WIDEST, padX: 6, padY: 2, radius: 8, border: undefined, bar: 2, textShadow: undefined, boxShadow: undefined, iconSize: 10, iconGap: 4, preferIcon: false, gap: 2, flushRails: true,
        paint: accent => ({ background: "rgba(0,0,0,0.8)", foreground: css(accent ?? WHITE), ...(accent === undefined ? {} : { bar: css(accent) }) }) },
};

function hex(value: string): Rgba {
    return [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16), 1];
}

/** CardOverlays.swift:29-38: lengths are points at the 185pt web poster; wide (Continue Watching) badges stay at 1. */
const POSTER_REFERENCE_WIDTH = 185;
const EDGE_INSET = 8;
const EDGE_GAP = 8;
/** CardWatchStatus.size: the top row stops short of the watch-status corner on poster cards. */
const WATCH_STATUS_SIZE = 22;
const MAX_BADGES_PER_CORNER = 3;
const MAX_BADGES_PER_RAIL = 4;
const RAIL_MAX_WIDTH = "60%";
/** Wide cards leave room under the badges for a title block or progress bar (CardOverlays.swift:137-144). */
const WIDE_BOTTOM_INSET = 24;

/** CardWatchStatus.swift:17: Tailwind's `emerald-500` as Apple writes it, sRGB (0, 0.737, 0.49). */
const WATCHED_FILL = `rgb(0,${0.737 * 255},${0.49 * 255})`;
/** CardWatchStatus.swift:43: the episodes-left count's point size at the reference width. */
const EPISODES_LEFT_FONT_SIZE = 11;

/**
 * CardWatchStatus (silo-apple 5780c84 `Overlays/CardWatchStatus.swift:11-81`): the poster's top-right corner, a
 * check on a watched title or the episodes a started series or season has left, scaled from the card width the same
 * way the badges are. Shown whether or not badges are on; wide cards keep their own check.
 */
export function watchStatus(card: Card, artWidth: number): HTMLElement | undefined {
    const left = card.played === true ? undefined : card.episodesLeft;
    if (card.played !== true && left === undefined) return undefined;
    const scale = artWidth / POSTER_REFERENCE_WIDTH;
    const px = (value: number): string => `${Math.round(value * scale * 100) / 100}px`;
    const node = el("span", "card-watch-status");
    node.style.top = node.style.right = px(EDGE_INSET);
    node.style.height = node.style.minWidth = px(WATCH_STATUS_SIZE);
    if (left === undefined) {
        node.classList.add("card-watch-status-played");
        node.style.backgroundColor = WATCHED_FILL;
        node.appendChild(watchedCheck(px(WATCH_STATUS_SIZE * 0.62)));
        // The host card's own label says "Watched" there (TVMediaCard.swift:286-288).
        node.appendChild(el("span", "silo-sr-only", "Watched"));
        return node;
    }
    node.setAttribute("aria-hidden", "true");
    node.textContent = left.toLocaleString();
    node.style.fontSize = `calc(${px(EPISODES_LEFT_FONT_SIZE)} * var(--silo-sf-cap-scale))`;
    node.style.padding = `0 ${px(EPISODES_LEFT_FONT_SIZE * 0.4)}`;
    node.style.letterSpacing = px(interShortfall(EPISODES_LEFT_FONT_SIZE * scale, 700) * EPISODES_LEFT_FONT_SIZE);
    return node;
}

/** The web's check, Lucide's in a 24-unit box, stroked 3.25 units with round ends (CardWatchStatus.swift:33-38, :68-81). */
function watchedCheck(size: string): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.style.width = svg.style.height = size;
    const line = document.createElementNS(svg.namespaceURI, "polyline");
    line.setAttribute("points", "20 6 9 17 4 12");
    svg.appendChild(line);
    return svg;
}

type Rail = "left" | "right";
interface Resolved { readonly label: string; readonly mark: Icon | undefined; readonly tv: boolean; readonly accent: Rgba | undefined }

function resolve(card: Card, prefs: CardOverlayPrefs, preset: Preset, position: Position, limit: number): Resolved[] {
    return enabledAt(position, prefs).flatMap(def => {
        const label = def.value(card);
        if (label === undefined) return [];
        const config = prefs.items.get(def.id);
        const icon = def.icon?.(card) ?? def.staticIcon;
        const showIcon = icon !== undefined && def.iconCapable && (config?.showIcon ?? preset.preferIcon);
        const accent = config?.accentColor ?? def.accent;
        return [{ label, mark: showIcon && icon !== "generic" && icon !== "tv" ? icon : undefined, tv: showIcon && icon === "tv", accent: accent === undefined ? undefined : hex(accent) }];
    }).slice(0, limit);
}

/** The badge layer for one card's artwork, or undefined when no badge has a value. */
export function overlayLayer(card: Card, prefs: CardOverlayPrefs, variant: "poster" | "wide", artWidth: number): HTMLElement | undefined {
    const preset = PRESET_STYLES[prefs.preset];
    const scale = variant === "poster" ? artWidth / POSTER_REFERENCE_WIDTH : 1;
    const px = (value: number): string => `${Math.round(value * scale * 100) / 100}px`;
    const at = (position: Position, limit: number): Resolved[] => resolve(card, prefs, preset, position, limit);
    const layer = el("span", "card-overlays");
    layer.setAttribute("aria-hidden", "true");
    const stack = (name: string, badges: readonly Resolved[], align: "flex-start" | "flex-end" | "stretch", rail?: Rail): HTMLElement => {
        const node = el("span", `card-overlay-stack card-overlay-${name}`);
        node.style.gap = px(preset.gap);
        node.style.alignItems = align;
        for (const badge of badges) node.appendChild(badgeNode(badge, preset, scale, px, rail));
        return layer.appendChild(node);
    };
    const topLeft = at("top-left", MAX_BADGES_PER_CORNER);
    if (topLeft.length > 0) {
        const node = stack("top-left", topLeft, "flex-start");
        node.style.top = px(EDGE_INSET);
        node.style.left = px(EDGE_INSET);
        node.style.right = px(variant === "poster" ? EDGE_INSET + WATCH_STATUS_SIZE + EDGE_GAP : EDGE_INSET);
    }
    for (const side of ["left", "right"] as const) {
        const badges = at(`${side}-edge`, MAX_BADGES_PER_RAIL);
        if (badges.length === 0) continue;
        const node = stack(`${side}-edge`, badges, side === "left" ? "flex-start" : "flex-end", preset.flushRails ? side : undefined);
        node.style.setProperty(side, preset.flushRails ? "0" : px(EDGE_INSET));
        node.style.maxWidth = RAIL_MAX_WIDTH;
    }
    const left = at("bottom-left", MAX_BADGES_PER_CORNER);
    const right = at("bottom-right", MAX_BADGES_PER_CORNER);
    const levels = Math.max(left.length, right.length);
    if (levels > 0) {
        // BottomRows: one row per level from the bottom up, the shorter corner aligned with the bottom; a pair too wide wraps.
        const node = stack("bottom", [], "stretch");
        node.style.left = px(EDGE_INSET);
        node.style.right = px(EDGE_INSET);
        node.style.bottom = variant === "wide" ? `${WIDE_BOTTOM_INSET}px` : px(EDGE_INSET);
        for (let level = 0; level < levels; level += 1) {
            const row = node.appendChild(el("span", "card-overlay-row"));
            row.style.columnGap = px(EDGE_GAP);
            row.style.rowGap = px(preset.gap);
            const leading = left[left.length - levels + level];
            const trailing = right[right.length - levels + level];
            if (leading !== undefined) row.appendChild(badgeNode(leading, preset, scale, px));
            if (trailing !== undefined) row.appendChild(badgeNode(trailing, preset, scale, px)).classList.add("card-overlay-trailing");
        }
    }
    return layer.childElementCount === 0 ? undefined : layer;
}

/** OverlayBadgeView (CardOverlays.swift:364-439): padding, then the border outside it; a rail tab is open on its flush side. */
function badgeNode(badge: Resolved, preset: Preset, scale: number, px: (value: number) => string, rail?: Rail): HTMLElement {
    const paint = preset.paint(badge.accent);
    const node = el("span", "card-overlay");
    const style = node.style;
    const border = preset.border ?? 0;
    const bar = rail === "left" || paint.bar === undefined ? 0 : preset.bar ?? 0;
    // Apple's point size times --silo-sf-cap-scale, as Home's other text (Typography rule in theme.css).
    style.fontSize = `calc(${px(preset.fontSize)} * var(--silo-sf-cap-scale))`;
    // The web's leading-none: the line is as tall as the font size, so padding alone sets the height.
    style.lineHeight = px(preset.fontSize);
    style.fontWeight = String(preset.weight);
    // The border sits outside the padding and the leading side takes the wider of it and the accent bar.
    style.padding = `${px(preset.padY + border)} ${px(preset.padX + (rail === "right" ? 0 : border))} ${px(preset.padY + border)} ${px(preset.padX + (rail === "left" ? 0 : Math.max(border, bar)))}`;
    if (border > 0) {
        // Drawn as a ring, not a CSS border, which Chromium snaps to whole pixels.
        node.classList.add("card-overlay-framed");
        if (rail !== undefined) node.classList.add(`card-overlay-tab-${rail}`);
        style.setProperty("--card-overlay-border", px(border));
        style.setProperty("--card-overlay-border-color", paint.border ?? paint.foreground);
    }
    const radius = preset.radius === undefined ? "999px" : px(preset.radius);
    style.borderRadius = rail === "left" ? `0 ${radius} ${radius} 0` : rail === "right" ? `${radius} 0 0 ${radius}` : radius;
    style.backgroundColor = paint.background;
    if (bar > 0 && paint.bar !== undefined) style.backgroundImage = `linear-gradient(to right, ${paint.bar} ${px(bar)}, transparent ${px(bar)})`;
    style.color = paint.foreground;
    if (preset.boxShadow !== undefined) style.boxShadow = `0 ${px(preset.boxShadow.y)} ${px(preset.boxShadow.blur)} ${preset.boxShadow.color}`;
    // A brand mark draws its own token, so the label drops it ("DV HDR10" with the DV mark reads "HDR10").
    const label = badge.mark === undefined ? badge.label : badge.label.split(" ").filter(word => word.toLowerCase() !== badge.mark?.toLowerCase()).join(" ");
    if (badge.tv) {
        const glyph = tvIcon();
        // OverlayIcon.swift:29-36: the symbol at 85% of iconSize in an iconSize-high frame. "tv" is wider than the
        // frame's minimum width and a little taller than it, so the frame keeps the symbol's width and iconSize's height.
        const height = preset.iconSize * TV_SYMBOL_SCALE * TV_SYMBOL_HEIGHT;
        glyph.style.width = px(preset.iconSize * TV_SYMBOL_SCALE * TV_SYMBOL_WIDTH);
        glyph.style.height = px(height);
        glyph.style.marginTop = glyph.style.marginBottom = px((preset.iconSize - height) / 2);
        if (label !== "") glyph.style.marginRight = px(preset.iconGap);
        node.appendChild(glyph);
    }
    if (badge.mark !== undefined) {
        const mark = el("span", "card-overlay-mark", badge.mark);
        mark.style.fontSize = px(preset.iconSize * 0.78);
        if (label !== "") mark.style.marginRight = px(preset.iconGap);
        node.appendChild(mark);
    }
    if (label !== "") {
        const text = node.appendChild(el("span", "card-overlay-label", label));
        // Set on the label itself: theme.css gives every element its own tracking, so it would not inherit.
        text.style.letterSpacing = px((preset.tracking + interShortfall(preset.fontSize * scale, preset.weight)) * preset.fontSize);
        // The text shadow lifts the label only, not the icon (CardOverlays.swift:385-390).
        if (preset.textShadow !== undefined) text.style.textShadow = `0 ${px(preset.textShadow.y)} ${px(preset.textShadow.blur)} ${preset.textShadow.color}`;
    }
    return node;
}

/**
 * Inter's per-letter shortfall against SF Pro Text at badge sizes, in em of Apple's point size. SF Pro Text spaces
 * small sizes wider than Inter at the cap-scaled size: measured with CoreText (macOS SF Pro) against InterVariable
 * over twelve badge labels from 8 to 14pt, fitted within 0.002em. Larger text uses theme.css's tracking instead.
 */
function interShortfall(points: number, weight: number): number {
    return Math.max(0, (weight >= 700 ? 0.051 : 0.044) - 0.0062 * (points - 10));
}

/** OverlayIcon draws a generic symbol at this share of the icon size. */
const TV_SYMBOL_SCALE = 0.85;

/**
 * SF Symbol "tv" layout box divided by the font point size (`OverlayIcon` at 48pt
 * is 73×58).
 */
const TV_SYMBOL_WIDTH = 73 / 48;
const TV_SYMBOL_HEIGHT = 58 / 48;

/**
 * SF Symbol "tv" at 48pt semibold, in its 73×58 layout box. Measured from
 * SwiftUI `Image(systemName: "tv").foregroundStyle(.white)`: the screen outline
 * is a 5pt stroke (outer origin 6, 4.688, size 60.062×40.812, corner 10), the
 * screen fill is the secondary layer at 63/255, and the foot sits below the gap.
 */
const TV_SCREEN = { x: 6, y: 4.688, width: 60.062, height: 40.812, radius: 10 } as const;
const TV_STROKE = 5;
const TV_SCREEN_FILL = 63 / 255;
const TV_FOOT = { x: 21.562, y: 49.188, width: 28.875, height: 4.625, radius: 2.312 } as const;

function tvIcon(): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "card-overlay-icon");
    svg.setAttribute("viewBox", "0 0 73 58");
    svg.setAttribute("aria-hidden", "true");
    const inner = {
        x: TV_SCREEN.x + TV_STROKE,
        y: TV_SCREEN.y + TV_STROKE,
        width: TV_SCREEN.width - TV_STROKE * 2,
        height: TV_SCREEN.height - TV_STROKE * 2,
        radius: TV_SCREEN.radius - TV_STROKE,
    };
    const fill = document.createElementNS(svg.namespaceURI, "path");
    fill.setAttribute("fill-opacity", String(TV_SCREEN_FILL));
    fill.setAttribute("d", roundedRect(inner.x, inner.y, inner.width, inner.height, inner.radius));
    const outline = document.createElementNS(svg.namespaceURI, "path");
    outline.setAttribute("fill-rule", "evenodd");
    outline.setAttribute("d", [
        roundedRect(TV_SCREEN.x, TV_SCREEN.y, TV_SCREEN.width, TV_SCREEN.height, TV_SCREEN.radius),
        roundedRect(inner.x, inner.y, inner.width, inner.height, inner.radius),
        roundedRect(TV_FOOT.x, TV_FOOT.y, TV_FOOT.width, TV_FOOT.height, TV_FOOT.radius),
    ].join(""));
    svg.append(fill, outline);
    return svg;
}

function roundedRect(x: number, y: number, width: number, height: number, radius: number): string {
    const r = Math.min(radius, width / 2, height / 2);
    return `M${x + r} ${y}H${x + width - r}A${r} ${r} 0 0 1 ${x + width} ${y + r}V${y + height - r}A${r} ${r} 0 0 1 ${x + width - r} ${y + height}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + height - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
}
