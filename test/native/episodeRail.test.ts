import assert from "node:assert/strict";
import { test } from "node:test";
import { episodeRailOffset, episodeWindow, retainEpisodePages } from "../../src/ui/episodeRail.ts";
import type { Episode } from "../../src/contracts/v2/catalog.ts";

test("Apple rail anchors selection and focus to whole steps, clamped at the terminal group", () => {
    // TVEpisodeRail.swift:400-414,458-468 at 7baff3ef.
    assert.equal(episodeRailOffset(0, 14, 360, 40, 1813), 0);
    assert.equal(episodeRailOffset(4, 14, 360, 40, 1813), 1600);
    assert.equal(episodeRailOffset(13, 14, 360, 40, 1813), 4000);
    assert.equal(episodeRailOffset(4, 5, 360, 40, 1813), 400);
    assert.equal(episodeRailOffset(0, 0, 360, 40, 1813), 0);
    // Prepending ten episodes rebases both card and anchor by 4000.
    assert.equal(episodeRailOffset(14, 24, 360, 40, 1813), 5600);
    assert.equal(episodeRailOffset(14, 24, 360, 40, 1813) - 1600, 4000);
    // A long season can pin E05; the measured final season has only six cards.
    assert.equal(episodeRailOffset(4, 14, 309.6, 40, 1813), 1398.4);
    assert.equal(109 + 4 * 349.6 - 1398.4, 109);
    assert.equal(episodeRailOffset(14, 16, 309.6, 40, 1820), 3845.6000000000004);
    assert.ok(Math.abs(109 + 14 * 349.6 - episodeRailOffset(14, 16, 309.6, 40, 1820) - 1157.8) < .001);
});

function page(season: number, count: number): Episode[] {
    return Array.from({ length: count }, (_, index) => ({ id: `${season}:${index}`, seasonNumber: season, episodeNumber: index + 1, title: "Episode", runtimeMinutes: 30, stillUrl: undefined, played: false }));
}

test("Apple window crosses empty pages, stops at missing pages and sorts and deduplicates episodes", () => {
    const pages = new Map([[13, page(13, 10).reverse()], [14, page(14, 14)], [15, []], [16, page(16, 1)], [18, page(18, 1)]]);
    pages.get(14)!.push(pages.get(13)![0]!);
    const episodes = episodeWindow([13, 14, 15, 16, 17, 18], 14, pages);
    assert.equal(episodes.length, 25);
    assert.equal(episodes[0]!.id, "13:0");
    assert.equal(episodes[10]!.id, "14:0");
    assert.equal(episodes.at(-1)!.id, "16:0");
    assert.deepEqual(episodeWindow([13, 14], 12, pages), []);
});

test("Apple retains five nearest nonempty pages and at least eight distinct episodes on each side", () => {
    const order = Array.from({ length: 21 }, (_, index) => index);
    const pages = new Map(order.map(number => [number, page(number, 1)]));
    retainEpisodePages(order, 10, pages);
    assert.deepEqual([...pages.keys()], order.slice(2, 19));
    const longPages = new Map(order.map(number => [number, page(number, 14)]));
    longPages.set(0, []);
    retainEpisodePages(order, 10, longPages);
    assert.deepEqual([...longPages.keys()], [0, 8, 9, 10, 11, 12]);
});
