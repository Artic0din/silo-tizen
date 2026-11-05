import assert from "node:assert/strict";
import { test } from "node:test";
import type { ItemVideo, LocalExtra } from "../../src/contracts/v2/catalog.ts";
import { trailerCards, youtubeStillUrl } from "../../src/ui/trailerRail.ts";

const video = (siteKey: string, site = "youtube", kind = "trailer", name?: string): ItemVideo => ({
    kind, site, siteKey, name, language: undefined, isOfficial: true,
});

const extra = (contentId: string, kind = "featurette", title?: string, durationSeconds?: number): LocalExtra => ({
    contentId, kind, title, durationSeconds, fileId: "1", stillUrl: undefined,
});

test("local extras lead remote YouTube videos and other sites are dropped", () => {
    const cards = trailerCards(
        [extra("extra:1"), extra("extra:2", "clip", "Clip")],
        [video("k1"), video("v1", "vimeo"), video("k2", "YouTube", "teaser")],
        true,
    );
    assert.deepEqual(cards.map(card => card.id), ["local:extra:1", "local:extra:2", "remote:youtube:k1", "remote:YouTube:k2"]);
    assert.equal(cards[2]?.caption, "YouTube");
    assert.equal(cards[2]?.stillUrl, "https://i.ytimg.com/vi/k1/hqdefault.jpg");
});

test("hiding remote videos keeps local extras and an empty answer stays empty", () => {
    assert.deepEqual(trailerCards([extra("extra:1")], [video("k1")], false).map(card => card.id), ["local:extra:1"]);
    assert.deepEqual(trailerCards(undefined, undefined, true), []);
    assert.deepEqual(trailerCards([], [], true), []);
});

test("card titles fall back to the kind label and local captions are runtimes", () => {
    const named = trailerCards([], [video("k1", "youtube", "trailer", "Official Trailer")], true);
    assert.equal(named[0]?.title, "Official Trailer");
    const blank = trailerCards([], [video("k2", "youtube", "behind_the_scenes", "   ")], true);
    assert.equal(blank[0]?.title, "Behind the Scenes");
    const local = trailerCards([
        extra("extra:1", "deleted_scene", undefined, 90),
        extra("extra:2", "opening_credits", "   ", 0),
        extra("extra:3", "featurette", "Making Of", 3661),
    ], [], true);
    assert.equal(local[0]?.title, "Deleted Scene");
    assert.equal(local[0]?.caption, "1:30");
    assert.equal(local[1]?.title, "Extra");
    assert.equal(local[1]?.caption, undefined);
    assert.equal(local[2]?.caption, "1:01:01");
    assert.equal(youtubeStillUrl("a-B_c1D2e3F"), "https://i.ytimg.com/vi/a-B_c1D2e3F/hqdefault.jpg");
});
