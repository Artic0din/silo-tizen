// MarqueeBackdrop's public values: the clamped accent, the grain tile and the mesh.

import assert from "node:assert/strict";
import { test } from "node:test";
import { clampedAccent, GRAIN_SIDE, grainTile, meshColors, meshPoints, REFERENCE_DATE_MS, sampleMesh } from "../../src/ui/marqueeBackdrop.ts";

test("accents are #RRGGBB only, clamped to saturation 0.7 and brightness 0.45 to 0.8 in HSB", () => {
    assert.deepEqual(clampedAccent("#FF0000"), [204, 61, 61]);
    assert.deepEqual(clampedAccent(" 00ff00 "), [61, 204, 61]);
    assert.deepEqual(clampedAccent("#101010"), [115, 115, 115], "dark accents brighten to 0.45");
    assert.deepEqual(clampedAccent("#ffffff"), [204, 204, 204]);
    for (const bad of ["red", "#fff", "#12345g", "#1234567", "", "rgb(1,2,3)"]) {
        assert.equal(clampedAccent(bad), undefined, bad);
    }
});

test("the grain tile is MarqueeGrain's 96-square LCG noise as premultiplied white", () => {
    const tile = grainTile();
    assert.equal(GRAIN_SIDE, 96);
    assert.equal(tile.length, 96 * 96 * 4);
    let state = 0x9e3779b9;
    for (let pixel = 0; pixel < 96 * 96; pixel++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const value = state >>> 24;
        const at = pixel * 4;
        // Canvas image data is unpremultiplied: premultiplied white of alpha v is white at alpha v.
        assert.deepEqual([tile[at], tile[at + 1], tile[at + 2], tile[at + 3]], [255, 255, 255, value], `pixel ${pixel}`);
    }
});

test("mesh points follow BrandLightLayer: staged middle and centre, drifting by sin(phase/13) and cos(phase/19)", () => {
    const still = meshPoints(0, 0);
    assert.deepEqual(still.slice(0, 3), [[0, 0], [0.5, 0], [1, 0]]);
    assert.deepEqual(still[3], [0, 0.42 + 0.06]);
    assert.deepEqual(still[4], [0.3 + 0.1, 0.42]);
    assert.deepEqual(still[5], [1, 0.42]);
    assert.deepEqual(still.slice(6), [[0, 1], [0.5 - 0.1, 1], [1, 1]]);
    const signIn = meshPoints(1, 13 * Math.PI / 2);
    const a = 1;
    const b = Math.cos((13 * Math.PI / 2) / 19);
    assert.ok(Math.abs((signIn[1]?.[0] ?? 0) - (0.5 + 0.12 * a)) < 1e-9);
    assert.ok(Math.abs((signIn[4]?.[0] ?? 0) - (0.55 + 0.1 * b)) < 1e-9);
    assert.ok(Math.abs((signIn[4]?.[1] ?? 0) - (0.5 - 0.08 * a)) < 1e-9);
    const halfway = meshPoints(0.5, 0);
    assert.ok(Math.abs((halfway[5]?.[1] ?? 0) - 0.46) < 1e-9, "stages interpolate linearly");
    assert.equal(REFERENCE_DATE_MS, Date.UTC(2001, 0, 1));
});

test("mesh colours are the staged palettes, black along the bottom, and the corners render exactly", () => {
    const server = meshColors(0);
    assert.equal(server.length, 9);
    assert.deepEqual(server.slice(6), [[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    const points = meshPoints(1, 0);
    const colors = meshColors(1);
    // tvOS mirrors the light: the screen's top-left is the mesh's top-right.
    assert.deepEqual(sampleMesh(0, 0, points, colors).map(Math.round), colors[2]?.map(Math.round));
    assert.deepEqual(sampleMesh(1, 0, points, colors).map(Math.round), colors[0]?.map(Math.round));
    assert.deepEqual(sampleMesh(0.5, 1, points, colors).map(Math.round), [0, 0, 0]);
});
