import assert from "node:assert/strict";
import { test } from "node:test";
import { liftedArt, menuPosition } from "../../src/ui/cardActions.ts";

const round = (box: { left: number; top: number; width: number; height: number }) => ({ left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) });
const viewport = { width: 1920, height: 1080 };

test("the lifted art lands on Apple's measured preview, and scales with other art sizes", () => {
    // Live tvOS capture: 360 x 200 at (80, 673) at rest is drawn at (86, 663), 396 x 220, while the menu is open.
    assert.deepEqual(round(liftedArt({ left: 80, top: 673, width: 360, height: 200 })), { left: 86, top: 663, width: 396, height: 220 });
    // A poster keeps the same proportions: 1.1 about its centre, a fifteenth of its width to the right.
    assert.deepEqual(round(liftedArt({ left: 100, top: 300, width: 240, height: 360 })), { left: 104, top: 282, width: 264, height: 396 });
});

test("the platter sits 27 px right of the lifted art and centres on the button raised by the lift", () => {
    // Apple: lifted art right 482, platter left ~509 and top ~597 for a 271 px-tall Continue Watching button.
    const card = { left: 80, top: 673, width: 360, height: 271 };
    assert.deepEqual(menuPosition(card, { left: 80, top: 673, width: 360, height: 200 }, { width: 451, height: 406 }, viewport), { left: 509, top: 596 });
});

test("without art the platter sits beside the card, and it flips left and stays inside the safe area", () => {
    const pill = { left: 300, top: 500, width: 200, height: 60 };
    assert.deepEqual(menuPosition(pill, undefined, { width: 451, height: 406 }, viewport), { left: 527, top: 327 });
    const right = { left: 1500, top: 900, width: 360, height: 271 };
    const art = { left: 1500, top: 900, width: 360, height: 200 };
    const position = menuPosition(right, art, { width: 451, height: 406 }, viewport);
    assert.equal(position.left, Math.round(1500 + 24 - 18 - 27 - 451), "flips to the lifted art's left");
    assert.equal(position.top, 1080 - 60 - 406, "clamped to the bottom safe area");
});
