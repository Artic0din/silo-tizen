import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeRecommendations, decodeRecommendationRow } from "../../src/contracts/v2/recommendations.ts";
import { operations } from "../../src/api/operations.ts";

const card = { content_id: "movie:1", type: "movie", title: "A film" };
test("recommendations share catalog cards, omit empty rows and stably put For You first", () => {
    const rows = decodeRecommendations({ items: [
        { type: "popular", title: "Popular", kind: "popular", items: [card] },
        { type: "cluster", title: "FOR YOU", kind: "cluster", key: "1", items: [card] },
        { type: "genre", title: "Drama", kind: "genre", key: "Drama", items: [card] },
        { type: "genre", title: "Empty", items: [] },
    ] });
    assert.deepEqual(rows.map(row => row.title), ["FOR YOU", "Popular", "Drama"]);
    assert.equal(rows[0]?.items[0]?.id, "movie:1");
    assert.equal(new Set(rows.map(row => row.id)).size, 3);
    assert.ok(rows.every(row => row.id.startsWith("recommendation:")));
});

test("only supported complete recommendation locators are kept", () => {
    for (const extra of [{}, { kind: "future" }, { kind: "cluster" }, { kind: "genre", key: " " }]) {
        assert.equal(decodeRecommendationRow({ type: "cluster", title: "A row", items: [card], ...extra }).locator, undefined);
    }
    const row = decodeRecommendationRow({ type: "genre", title: "Drama", kind: "genre", key: "Drama & Crime/TV", items: [card] });
    assert.deepEqual(row.locator, { kind: "genre", key: "Drama & Crime/TV" });
    assert.equal("recommendationSection" in operations, false, "Apple's For You has no row page to read");
    assert.equal(operations.recommendations().path, "/recommendations/discover?image_size=small");
});

test("recommendations reject malformed row, card and locator values", () => {
    for (const value of [null, {}, { items: null }, { items: [{}] }, { items: [{ type: "x", title: "x", items: null }] }, { items: [{ type: "x", title: "x", kind: ["genre"], items: [card] }] }, { items: [{ type: "x", title: "x", items: [{}] }] }]) {
        assert.throws(() => decodeRecommendations(value));
    }
});

test("rows with unknown expansion kinds retain distinct content identities", () => {
    const rows = decodeRecommendations({ items: [
        { type: "future", title: "First", kind: "future", items: [card] },
        { type: "future", title: "Second", kind: "future", items: [{ ...card, content_id: "movie:2" }] },
    ] });
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0]?.id, rows[1]?.id);
    assert.ok(rows.every(row => row.locator === undefined));
});
