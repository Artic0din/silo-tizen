import assert from "node:assert/strict";
import { test } from "node:test";
import { cubicBezier } from "../../src/ui/skylineScroll.ts";

test("cubicBezier matches CSS timing curves at known points", () => {
    const easeInOut = cubicBezier(0.42, 0, 0.58, 1);
    assert.equal(easeInOut(0), 0);
    assert.equal(easeInOut(1), 1);
    assert.ok(Math.abs(easeInOut(0.5) - 0.5) < 1e-6, "SwiftUI easeInOut is symmetric");
    assert.ok(Math.abs(easeInOut(0.25) - 0.1291) < 1e-3, String(easeInOut(0.25)));
    const standard = cubicBezier(0.4, 0, 0.2, 1);
    assert.ok(Math.abs(standard(0.5) - 0.77556) < 1e-4, String(standard(0.5)));
    const linear = cubicBezier(0, 0, 1, 1);
    for (const x of [0.1, 0.33, 0.9]) assert.ok(Math.abs(linear(x) - x) < 1e-6);
});
