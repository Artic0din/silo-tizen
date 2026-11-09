import assert from "node:assert/strict";
import { test } from "node:test";
import { seriesLineFor } from "../../src/ui/browseModel.ts";
import type { Route } from "../../src/ui/browseRoutes.ts";

// Routes carry full catalog payloads; the footer lookup reads only these fields.
const seriesPage = (id: string, title: string): Route => ({ kind: "item", id, title, data: { detail: { type: "series", title }, seasons: [] } }) as unknown as Route;
const seasonPage = (seriesId: string, seasonNumber: number, episodeId: string): Route => ({ kind: "season", seriesId, seasonNumber, title: "Season", data: { episodes: [{ id: episodeId, seasonNumber, episodeNumber: 3 }], detail: undefined } }) as unknown as Route;

test("a season route takes the title of its own series", () => {
    const stack = [seriesPage("series:a", "Alpha"), seriesPage("series:b", "Bravo")];
    const season = seasonPage("series:a", 2, "episode:a2e3");
    assert.deepEqual(seriesLineFor([...stack, season], season, "episode:a2e3"), { seriesTitle: "Alpha", seasonNumber: 2, episodeNumber: 3 });
});

test("a season route does not borrow the title of an unrelated series on the stack", () => {
    const season = seasonPage("series:b", 4, "episode:b4e3");
    assert.deepEqual(seriesLineFor([seriesPage("series:a", "Alpha"), season], season, "episode:b4e3"), { seasonNumber: 4, episodeNumber: 3 });
});

test("a series page uses its own title", () => {
    const page = seriesPage("series:a", "Alpha");
    assert.equal(seriesLineFor([seriesPage("series:z", "Zulu"), page], page, "episode:a1e1")?.seriesTitle, "Alpha");
});
