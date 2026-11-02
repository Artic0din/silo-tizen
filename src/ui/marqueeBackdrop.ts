// The Apple TV app's first-run backdrop (MarqueeBackdrop.swift): the mark's three colours as slow pools
// of light over black, mirrored on tvOS, a server's clamped accent tint, and fine grain. One instance
// sits behind every sign-in screen and survives screen changes.
//
// Ported exactly: the palettes' source colours and dim amounts, mesh points and their drift, stage
// values and the 30 fps timeline, the reference-date phase, the tint's alpha, centre and radius, and
// the grain's generator. Approximated: SwiftUI's MeshGradient interpolation is private, so the mesh is
// inverted bilinearly and its colours interpolated with Catmull-Rom cubics in device RGB; and
// `Color.mix`'s `.perceptual` space is not named by Apple, so it is taken as OKLab.

import type { Clock } from "../api/clock.ts";

/** Date.timeIntervalSinceReferenceDate counts from 1 January 2001, UTC. */
export const REFERENCE_DATE_MS = Date.UTC(2001, 0, 1);
export const GRAIN_SIDE = 96;
const FRAME_MS = 1000 / 30;
/** The drawn buffer, upscaled by the compositor; the light has no detail finer than this. */
const BUFFER_WIDTH = 64;
const BUFFER_HEIGHT = 36;
const STAGE_SPRING_SECONDS = 1.4;
const REDUCED_STAGE_MS = 150;

export type Rgb = readonly [number, number, number];
export type Point = readonly [number, number];

const BLUE = "#0034FB";
const RED = "#F50B4F";
const ORANGE = "#FD7403";
const BLACK = "#000000";

/** BrandLightLayer.palettes: row-major 3x3 per stage (server, sign-in, profiles), [colour, dim]. */
const PALETTES: readonly (readonly (readonly [string, number])[])[] = [
    [[BLUE, 0.46], [BLUE, 0.7], [RED, 0.8], [BLUE, 0.8], [BLUE, 0.86], [RED, 0.92], [BLACK, 0], [BLACK, 0], [BLACK, 0]],
    [[BLUE, 0.5], [RED, 0.58], [ORANGE, 0.58], [BLUE, 0.76], [RED, 0.74], [ORANGE, 0.82], [BLACK, 0], [BLACK, 0], [BLACK, 0]],
    [[RED, 0.56], [ORANGE, 0.52], [BLUE, 0.56], [ORANGE, 0.7], [RED, 0.66], [BLUE, 0.72], [BLUE, 0.9], [RED, 0.9], [ORANGE, 0.92]],
];
const MIDDLE = [0.42, 0.5, 0.6];
const CENTER_X = [0.3, 0.55, 0.5];

type Lab = readonly [number, number, number];

function hexRgb(hex: string): Rgb {
    const value = Number.parseInt(hex.replace("#", ""), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function toLinear(channel: number): number {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function toGamma(channel: number): number {
    const c = Math.min(1, Math.max(0, channel));
    return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
}

function toLab([r, g, b]: Rgb): Lab {
    const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function fromLab([L, A, B]: Lab): Rgb {
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    return [
        toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ];
}

/** Color.mix(with: .black, by: amount): black is the origin of OKLab, so the mix scales it. */
const LAB_PALETTES: readonly (readonly Lab[])[] = PALETTES.map((palette) =>
    palette.map(([hex, dim]) => toLab(hexRgb(hex)).map((v) => v * (1 - dim)) as unknown as Lab),
);

/** BrandLightLayer's `staged`: values per stage, interpolated at a fractional stage. */
function staged<T>(values: readonly T[], stage: number, mix: (a: T, b: T, t: number) => T): T {
    const s = Math.min(Math.max(stage, 0), values.length - 1);
    const i = Math.min(Math.floor(s), values.length - 2);
    return mix(values[i] as T, values[i + 1] as T, s - i);
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** The nine mesh colours at `stage`, in device RGB 0-255. */
export function meshColors(stage: number): Rgb[] {
    return Array.from({ length: 9 }, (_, index) =>
        fromLab(staged(LAB_PALETTES.map((palette) => palette[index] as Lab), stage, (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)])),
    );
}

/** The nine mesh points at `stage` and timeline `phase` (seconds since the reference date). */
export function meshPoints(stage: number, phase: number): Point[] {
    // Two incommensurate periods so the drift never visibly loops.
    const a = Math.sin(phase / 13);
    const b = Math.cos(phase / 19);
    const middle = staged(MIDDLE, stage, lerp);
    const centerX = staged(CENTER_X, stage, lerp);
    return [
        [0, 0], [0.5 + 0.12 * a, 0], [1, 0],
        [0, middle + 0.06 * b], [centerX + 0.1 * b, middle - 0.08 * a], [1, middle - 0.06 * a],
        [0, 1], [0.5 - 0.1 * b, 1], [1, 1],
    ];
}

const cross = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;

/** (u, v) of `p` in the quad a-b-c-d (u along a-b, v along a-d), or undefined outside it. */
function inverseBilinear(px: number, py: number, a: Point, b: Point, c: Point, d: Point): [number, number] | undefined {
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const fx = d[0] - a[0], fy = d[1] - a[1];
    const gx = a[0] - b[0] + c[0] - d[0], gy = a[1] - b[1] + c[1] - d[1];
    const hx = px - a[0], hy = py - a[1];
    const k2 = cross(gx, gy, fx, fy);
    const k1 = cross(ex, ey, fx, fy) + cross(hx, hy, gx, gy);
    const k0 = cross(hx, hy, ex, ey);
    const solveU = (v: number): number => {
        const dx = ex + gx * v, dy = ey + gy * v;
        return Math.abs(dx) >= Math.abs(dy) ? (hx - fx * v) / dx : (hy - fy * v) / dy;
    };
    const inside = (u: number, v: number): boolean => u >= -1e-6 && u <= 1 + 1e-6 && v >= -1e-6 && v <= 1 + 1e-6;
    if (Math.abs(k2) < 1e-9) {
        const v = -k0 / k1;
        const u = solveU(v);
        return inside(u, v) ? [u, v] : undefined;
    }
    const root = k1 * k1 - 4 * k0 * k2;
    if (root < 0) {
        return undefined;
    }
    const w = Math.sqrt(root);
    for (const v of [(-k1 - w) / (2 * k2), (-k1 + w) / (2 * k2)]) {
        const u = solveU(v);
        if (inside(u, v)) {
            return [u, v];
        }
    }
    return undefined;
}

/** Catmull-Rom through three nodes with clamped ends, at s in [0, 2]. */
function cubic(p0: number, p1: number, p2: number, s: number): number {
    const nodes = [p0, p0, p1, p2, p2];
    const i = Math.min(Math.floor(s), 1);
    const w = s - i;
    const [q0, q1, q2, q3] = [nodes[i] ?? 0, nodes[i + 1] ?? 0, nodes[i + 2] ?? 0, nodes[i + 3] ?? 0];
    return 0.5 * (2 * q1 + (q2 - q0) * w + (2 * q0 - 5 * q1 + 4 * q2 - q3) * w * w + (3 * q1 - q0 - 3 * q2 + q3) * w * w * w);
}

/** The light at screen point (x, y), both 0-1. tvOS mirrors the layer, so x reads from the right. */
export function sampleMesh(x: number, y: number, points: readonly Point[], colors: readonly Rgb[]): [number, number, number] {
    const mx = 1 - x;
    let s = 0;
    let t = 0;
    search: for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 2; col++) {
            const at = (r: number, c: number): Point => points[r * 3 + c] ?? [0, 0];
            const uv = inverseBilinear(mx, y, at(row, col), at(row, col + 1), at(row + 1, col + 1), at(row + 1, col));
            if (uv !== undefined) {
                s = col + Math.min(1, Math.max(0, uv[0]));
                t = row + Math.min(1, Math.max(0, uv[1]));
                break search;
            }
        }
    }
    const out: [number, number, number] = [0, 0, 0];
    for (let channel = 0; channel < 3; channel++) {
        const rows = [0, 1, 2].map((row) => {
            const c = (col: number): number => colors[row * 3 + col]?.[channel] ?? 0;
            return cubic(c(0), c(1), c(2), s);
        });
        out[channel] = Math.min(255, Math.max(0, cubic(rows[0] ?? 0, rows[1] ?? 0, rows[2] ?? 0, t)));
    }
    return out;
}

/**
 * MarqueeScene.clampedAccent: `#?RRGGBB` only, kept dark and calm enough for text over it:
 * saturation at most 0.7, brightness between 0.45 and 0.8 (HSB).
 */
export function clampedAccent(hex: string): Rgb | undefined {
    const trimmed = hex.trim();
    if (!/^#?[0-9A-Fa-f]{6}$/.test(trimmed)) {
        return undefined;
    }
    const [r, g, b] = hexRgb(trimmed.replace("#", "")).map((c) => c / 255) as unknown as [number, number, number];
    const max = Math.max(r, g, b);
    const delta = max - Math.min(r, g, b);
    let hue = 0;
    if (delta > 0) {
        hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
        hue = (hue * 60 + 360) % 360;
    }
    const saturation = Math.min(max === 0 ? 0 : delta / max, 0.7);
    const brightness = Math.min(Math.max(max, 0.45), 0.8);
    const chroma = brightness * saturation;
    const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
    const sector = Math.floor(hue / 60) % 6;
    const sectors: readonly Rgb[] = [[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]];
    const [r1, g1, b1] = sectors[sector] ?? [0, 0, 0];
    const m = brightness - chroma;
    return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

/** MarqueeGrain's tile: 96 square, a 32-bit LCG's high byte as premultiplied white (unpremultiplied here). */
export function grainTile(): Uint8ClampedArray<ArrayBuffer> {
    const bytes = new Uint8ClampedArray(new ArrayBuffer(GRAIN_SIDE * GRAIN_SIDE * 4));
    let state = 0x9e3779b9;
    for (let pixel = 0; pixel < GRAIN_SIDE * GRAIN_SIDE; pixel++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const at = pixel * 4;
        bytes[at] = 255;
        bytes[at + 1] = 255;
        bytes[at + 2] = 255;
        bytes[at + 3] = state >>> 24;
    }
    return bytes;
}

let grainUrl: string | undefined;

function grainImage(): string | undefined {
    if (grainUrl === undefined) {
        const canvas = document.createElement("canvas");
        canvas.width = GRAIN_SIDE;
        canvas.height = GRAIN_SIDE;
        const context = canvas.getContext("2d");
        if (context === null) {
            return undefined;
        }
        context.putImageData(new ImageData(grainTile(), GRAIN_SIDE, GRAIN_SIDE), 0, 0);
        grainUrl = canvas.toDataURL("image/png");
    }
    return grainUrl;
}

/** SwiftUI's `.smooth(duration: 1.4)`: a spring without bounce, critically damped at 2π / duration. */
function smooth(elapsedSeconds: number): number {
    const omega = (2 * Math.PI) / STAGE_SPRING_SECONDS;
    return 1 - (1 + omega * elapsedSeconds) * Math.exp(-omega * elapsedSeconds);
}

function easeInOut(t: number): number {
    return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

export class MarqueeBackdrop {
    readonly element: HTMLElement;
    private readonly clock: Clock;
    private readonly canvas: HTMLCanvasElement;
    private readonly context: CanvasRenderingContext2D | null;
    private readonly image: ImageData | undefined;
    private readonly tint: HTMLElement;
    private readonly motion: MediaQueryList | undefined;
    private stage = 0;
    private from = 0;
    private target = 0;
    private changedAt = 0;
    private cancelFrame: (() => void) | undefined;
    private destroyed = false;

    constructor(clock: Clock) {
        this.clock = clock;
        this.element = document.createElement("div");
        this.element.className = "marquee-backdrop";
        this.element.setAttribute("aria-hidden", "true");
        this.element.setAttribute("data-stage", "0");
        this.canvas = document.createElement("canvas");
        this.canvas.className = "marquee-backdrop-light";
        this.canvas.width = BUFFER_WIDTH;
        this.canvas.height = BUFFER_HEIGHT;
        this.context = this.canvas.getContext("2d");
        this.image = this.context?.createImageData(BUFFER_WIDTH, BUFFER_HEIGHT);
        this.tint = document.createElement("div");
        this.tint.className = "marquee-backdrop-tint";
        const grain = document.createElement("div");
        grain.className = "marquee-backdrop-grain";
        const tile = grainImage();
        if (tile !== undefined) {
            grain.style.backgroundImage = `url("${tile}")`;
        }
        this.element.appendChild(this.canvas);
        this.element.appendChild(this.tint);
        this.element.appendChild(grain);
        this.motion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined;
        this.motion?.addListener(this.restart);
        document.addEventListener("visibilitychange", this.restart);
        this.restart();
    }

    /** 0 while choosing a server, 1 once one answered; moving between them is the light moving. */
    setStage(stage: number): void {
        if (stage === this.target) {
            return;
        }
        this.from = this.stage;
        this.target = stage;
        this.changedAt = this.clock.now();
        this.element.setAttribute("data-stage", String(stage));
        this.restart();
    }

    /** The confirmed server's accent (`accent_color`), or none. */
    setAccent(accent: string | undefined): void {
        const rgb = accent === undefined ? undefined : clampedAccent(accent);
        if (rgb !== undefined) {
            const [r, g, b] = rgb;
            this.tint.style.backgroundImage = `radial-gradient(circle 1344px at 50% 16%, rgba(${r}, ${g}, ${b}, 0.32), rgba(${r}, ${g}, ${b}, 0))`;
        }
        this.tint.classList.toggle("marquee-backdrop-tint-on", rgb !== undefined);
    }

    destroy(): void {
        this.destroyed = true;
        this.cancelFrame?.();
        this.cancelFrame = undefined;
        this.motion?.removeListener(this.restart);
        document.removeEventListener("visibilitychange", this.restart);
        this.element.parentNode?.removeChild(this.element);
    }

    private get reduced(): boolean {
        return this.motion?.matches === true;
    }

    private readonly restart = (): void => {
        this.cancelFrame?.();
        this.cancelFrame = undefined;
        if (!this.destroyed && document.visibilityState !== "hidden") {
            this.frame();
        }
    };

    /** One TimelineView tick: draws, then asks for the next only while something moves. */
    private readonly frame = (): void => {
        this.cancelFrame = undefined;
        const now = this.clock.now();
        const elapsed = now - this.changedAt;
        const eased = this.reduced ? easeInOut(Math.min(1, elapsed / REDUCED_STAGE_MS)) : smooth(elapsed / 1000);
        // The spring is at rest once it is within a thousandth of its target.
        const progress = eased > 0.999 ? 1 : eased;
        this.stage = lerp(this.from, this.target, progress);
        const drifts = !this.reduced;
        this.draw(drifts ? (now - REFERENCE_DATE_MS) / 1000 : 0);
        if (drifts || progress < 1) {
            this.cancelFrame = this.clock.schedule(this.frame, FRAME_MS);
        }
    };

    private draw(phase: number): void {
        const image = this.image;
        if (this.context === null || image === undefined) {
            return;
        }
        const points = meshPoints(this.stage, phase);
        const colors = meshColors(this.stage);
        const data = image.data;
        for (let y = 0; y < BUFFER_HEIGHT; y++) {
            for (let x = 0; x < BUFFER_WIDTH; x++) {
                const [r, g, b] = sampleMesh((x + 0.5) / BUFFER_WIDTH, (y + 0.5) / BUFFER_HEIGHT, points, colors);
                const at = (y * BUFFER_WIDTH + x) * 4;
                data[at] = r;
                data[at + 1] = g;
                data[at + 2] = b;
                data[at + 3] = 255;
            }
        }
        this.context.putImageData(image, 0, 0);
    }
}
