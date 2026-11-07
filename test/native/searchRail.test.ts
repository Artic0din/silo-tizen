import assert from "node:assert/strict";
import { test } from "node:test";
import { searchRailCardOutside } from "../../src/ui/searchRail.ts";

test("the Search person at x 238 and width 200 is inside a 1920 rail padded by 238", () => {
    const rail = { left: 0, right: 1920 };
    assert.equal(searchRailCardOutside({ left: 238, right: 438 }, rail, 238, 238), false);
    assert.equal(searchRailCardOutside({ left: 0, right: 238 }, rail, 238, 238), true, "a card that only touches the content edge is outside");
    assert.equal(searchRailCardOutside({ left: 1682, right: 1882 }, rail, 238, 238), true, "a card past the right content edge is outside");
    assert.equal(searchRailCardOutside({ left: 1482, right: 1682 }, rail, 238, 238), false, "a card that ends on the content edge still intersects");
});
