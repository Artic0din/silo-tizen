// The Skyline page wash sampled from the backdrop, against silo-apple 1a7ccee
// `Components/HeroBackdropPalette.swift` (sample, normalize, dominantHue). Expected values were computed
// independently from those formulas.
import assert from "node:assert/strict";
import { test } from "node:test";
import { backdropFrame, cssColor, samplePalette, washBackground, type RGB } from "../../src/ui/heroBackdrop.ts";

const close = (actual: RGB, expected: readonly [number, number, number], what: string): void => {
    for (const [index, channel] of (["r", "g", "b"] as const).entries()) {
        assert.ok(Math.abs(actual[channel] - (expected[index] ?? Number.NaN)) < 1e-6, `${what}.${channel}: ${actual[channel]} vs ${expected[index]}`);
    }
};
const px = (r: number, g: number, b: number): RGB => ({ r, g, b });

test("detail surfaces retain a uniform dimmed base beneath the shared accent and shadow", () => {
    const tints = { base: px(0.4, 0.3, 0.2), accent: px(0.5, 0.2, 0.1), shadow: px(0.1, 0.05, 0) };
    const detail = washBackground(tints, true);
    assert.equal(detail.includes("240.64deg"), false);
    assert.ok(detail.includes("rgba(102,77,51,0.42)"));
    assert.equal(detail.match(/radial-gradient/g)?.length, 2);
    assert.ok(washBackground(tints).includes("linear-gradient"), "root pages preserve their diagonal base wash");
    assert.equal(washBackground(undefined), "#000");
    assert.ok(washBackground(undefined, true).includes("rgba(10,31,36,0.42)"));
});

const CASES: readonly (readonly [string, readonly RGB[], readonly [number, number, number][]])[] = [
    ["a vivid red keeps its hue; its shadow drops to luminance 0.07", Array(4).fill(px(1, 0, 0)), [[1, 0, 0], [1, 0, 0], [0.329257, 0, 0]]],
    ["grey art has no accent hue, so the accent is the base", Array(4).fill(px(0.5, 0.5, 0.5)), [[0.22, 0.22, 0.22], [0.22, 0.22, 0.22], [0.07, 0.07, 0.07]]],
    ["black stays black", Array(4).fill(px(0, 0, 0)), [[0, 0, 0], [0, 0, 0], [0, 0, 0]]],
    ["a very dark tint is lifted, but too dark to count as an accent", Array(4).fill(px(0, 0, 0.1)), [[0, 0, 0.44], [0, 0, 0.44], [0, 0, 0.14]]],
    ["one vivid pixel outweighs three grey ones for the accent", [px(0.5, 0.5, 0.5), px(0.5, 0.5, 0.5), px(0.5, 0.5, 0.5), px(0, 1, 0)], [[0.148971, 0.248285, 0.148971], [0, 0.307606, 0], [0.07, 0.07, 0.07]]],
    ["mixed art: mean base, strongest-hue accent, darkest-quarter shadow", [px(0.9, 0.5, 0.1), px(0.2, 0.6, 0.6), px(0.05, 0.05, 0.08), px(0.6, 0.6, 0.6)], [[0.22341, 0.22341, 0.176175], [0.356013, 0.197785, 0.039557], [0.067094, 0.067094, 0.10735]]],
];

for (const [name, pixels, [base, accent, shadow]] of CASES) {
    test(`palette: ${name}`, () => {
        const tints = samplePalette(pixels);
        assert.ok(tints !== undefined);
        close(tints.base, base as [number, number, number], "base");
        close(tints.accent, accent as [number, number, number], "accent");
        close(tints.shadow, shadow as [number, number, number], "shadow");
    });
}

test("palette: no pixels gives no tints, so the page stays flat black", () => {
    assert.equal(samplePalette([]), undefined);
});

test("css colours round each channel to a byte", () => {
    assert.equal(cssColor(px(0.148971, 0.248285, 1), 0.5), "rgba(38,63,255,0.5)");
});

test("the art frame is 64% of the width and 70% of the 16:9 height, in the top-right corner (TVBackdropArtworkLayout)", () => {
    assert.deepEqual(backdropFrame(1920), { left: 691.2, top: 0, width: 1228.8, height: 756 });
});
