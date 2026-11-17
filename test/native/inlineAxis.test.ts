// Geometry in start and end terms (src/ui/inlineAxis.ts): "at or past" runs toward the right left to right and toward the left right to left.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startOffset, startsAtOrPast } from "../../src/ui/inlineAxis.ts";

const box = (left: number, right: number): { left: number; right: number } => ({ left, right });

test("left to right: a box at or to the right of the position is at or past it", () => {
    assert.equal(startsAtOrPast(box(300, 500), 300, false), true);
    assert.equal(startsAtOrPast(box(299.6, 500), 300, false), true, "within half a pixel");
    assert.equal(startsAtOrPast(box(200, 400), 300, false), false);
    assert.equal(startsAtOrPast(box(600, 800), 300, false), true);
});

test("right to left: a box at or to the left of the position is at or past it", () => {
    assert.equal(startsAtOrPast(box(100, 300), 300, true), true);
    assert.equal(startsAtOrPast(box(100, 300.4), 300, true), true, "within half a pixel");
    assert.equal(startsAtOrPast(box(200, 400), 300, true), false);
    assert.equal(startsAtOrPast(box(-200, 0), 300, true), true);
});

test("a row of columns finds the same column in reading order either way", () => {
    // Three columns of 200 wide in a 600 wide line, the origin centred on the second column.
    const ltr = [box(0, 200), box(200, 400), box(400, 600)];
    const rtl = [box(400, 600), box(200, 400), box(0, 200)];
    assert.equal(ltr.findIndex(rect => startsAtOrPast(rect, 300, false)), 2, "the third column, to the right of the centre");
    assert.equal(rtl.findIndex(rect => startsAtOrPast(rect, 300, true)), 2, "the third column in reading order, to the left of the centre");
});

test("the aligned landing measures from the start edge: the left one left to right, the right one right to left", () => {
    // A 360 wide origin over a row of 176 wide items, the first at the start of the line.
    assert.equal(startOffset(box(0, 360), box(0, 176), false), 0, "left to right: the first item is aligned with the origin");
    assert.equal(startOffset(box(0, 360), box(216, 392), false), 216, "left to right: the second is 216 further along");
    assert.equal(startOffset(box(1560, 1920), box(1744, 1920), true), 0, "right to left: the first item ends where the origin does");
    assert.equal(startOffset(box(1560, 1920), box(1528, 1704), true), 216, "right to left: the second is 216 further along, to the left");
    assert.equal(startOffset(box(0, 360), box(-40, 100), false), 0, "never below zero");
});
