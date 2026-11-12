import assert from "node:assert/strict";
import { test } from "node:test";
import { detailOperations } from "../../src/api/detailOperations.ts";

test("dismissHomeItem sends the card's own progress time to Continue Watching and its series to Next Up", () => {
    const resume = detailOperations.dismissHomeItem("episode:a/b", { surface: "continue_watching", progressUpdatedAt: "2026-11-01T10:00:00.123456Z" });
    assert.equal(resume.method, "PUT");
    assert.equal(resume.path, "/home/dismissals/continue_watching/episode%3Aa%2Fb");
    assert.deepEqual(resume.body, { progress_updated_at: "2026-11-01T10:00:00.123456Z" });
    assert.equal(resume.retry, "never");
    const next = detailOperations.dismissHomeItem("episode:s1e2", { surface: "next_up", seriesId: "series:s1" });
    assert.equal(next.path, "/home/dismissals/next_up/episode%3As1e2");
    assert.deepEqual(next.body, { series_id: "series:s1" });
});

test("removingDismissed drops the card and its whole show from the playback rows only, and empty rows go", async () => {
    const { removingDismissed } = await import("../../src/ui/browseViews.ts");
    const card = (id: string, type: "movie" | "episode" | "series", seriesId?: string) => ({ id, type, title: id, year: undefined, posterUrl: undefined, seriesId, seriesTitle: undefined, seasonNumber: undefined, episodeNumber: undefined });
    const sections = [
        { id: "cw", sectionType: "continue_watching", title: "Continue Watching", items: [card("episode:a1", "episode", "series:a"), card("movie:m", "movie")] },
        { id: "nu", sectionType: "next_up", title: "Next Up", items: [card("episode:a2", "episode", "series:a")] },
        { id: "ra", sectionType: "recently_added", title: "Recently Added", items: [card("episode:a1", "episode", "series:a"), card("series:a", "series")] },
    ];
    const after = removingDismissed(sections, { id: "episode:a1", type: "episode", seriesId: "series:a" });
    assert.deepEqual(after.map(section => [section.id, section.items.map(item => item.id)]), [["cw", ["movie:m"]], ["ra", ["episode:a1", "series:a"]]]);
    assert.deepEqual(removingDismissed(sections, { id: "movie:m", type: "movie", seriesId: undefined })[0]?.items.map(item => item.id), ["episode:a1"]);
});
