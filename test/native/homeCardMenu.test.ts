import assert from "node:assert/strict";
import { test } from "node:test";
import type { Card, HomeSection } from "../../src/contracts/v2/catalog.ts";
import { withoutPlaybackCards } from "../../src/ui/homeCardMenu.ts";

const card = (id: string, type: Card["type"], seriesId?: string): Card => ({ id, type, title: id, year: undefined, posterUrl: undefined, seriesId, seriesTitle: undefined, seasonNumber: undefined, episodeNumber: undefined });
const sections: HomeSection[] = [
    { id: "cw", sectionType: "continue_watching", title: "Continue Watching", items: [card("movie:a", "movie"), card("episode:s1e1", "episode", "series:s1")] },
    { id: "next", sectionType: "next_up", title: "Next Up", items: [card("episode:s1e2", "episode", "series:s1"), card("episode:s2e1", "episode", "series:s2")] },
    { id: "recent", sectionType: "recently_added", title: "Recently Added", items: [card("movie:a", "movie"), card("series:s1", "series")] },
];
const ids = (rows: HomeSection[]): Record<string, string[]> => Object.fromEntries(rows.map(row => [row.id, row.items.map(item => item.id)]));

test("HomeSectionsMutation: a watched card leaves only the playback rows", () => {
    assert.deepEqual(ids(withoutPlaybackCards(sections, card("movie:a", "movie"), false)), { cw: ["episode:s1e1"], next: ["episode:s1e2", "episode:s2e1"], recent: ["movie:a", "series:s1"] });
    assert.deepEqual(ids(withoutPlaybackCards(sections, card("episode:s1e1", "episode", "series:s1"), false)), { cw: ["movie:a"], next: ["episode:s1e2", "episode:s2e1"], recent: ["movie:a", "series:s1"] });
});

test("HomeSectionsMutation: dismissing an episode drops its whole show from the playback rows, and empty rows go", () => {
    assert.deepEqual(ids(withoutPlaybackCards(sections, card("episode:s1e2", "episode", "series:s1"), true)), { cw: ["movie:a"], next: ["episode:s2e1"], recent: ["movie:a", "series:s1"] });
    assert.deepEqual(ids(withoutPlaybackCards(withoutPlaybackCards(sections, card("movie:a", "movie"), true), card("episode:s1e1", "episode", "series:s1"), true)), { next: ["episode:s2e1"], recent: ["movie:a", "series:s1"] });
});
