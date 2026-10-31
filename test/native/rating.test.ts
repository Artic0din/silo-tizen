import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeRating, ratingOperations, RatingState } from "../../src/ui/ratingState.ts";
import { connected, signIn } from "./support/harness.ts";
import { FakeDetails } from "./support/fakeDetails.ts";
import { problem } from "./support/fakeSilo.ts";

test("rating contract checks identity, integer scale, and non-retryable writes", () => {
    assert.equal(decodeRating({ item_id: "a/b", rating: 4 }, "a/b"), 4);
    for (const rating of [0, 6, 1.5, "4"]) assert.throws(() => decodeRating({ item_id: "a/b", rating }, "a/b"));
    assert.throws(() => decodeRating({ item_id: "other", rating: 4 }, "a/b"));
    assert.equal(ratingOperations.read("a/b").path, "/ratings/a%2Fb");
    assert.deepEqual(ratingOperations.write("a", 5).body, { rating: 5 });
    assert.equal(ratingOperations.write("a", null).method, "DELETE");
    assert.equal(ratingOperations.write("a", 5).retry, "never");
});

test("rating confirms writes, isolates profiles, and reconciles only on explicit Retry", async () => {
    const h = await connected();
    await signIn(h);
    const catalog = new FakeDetails();
    h.fake.catalog = catalog;
    h.core.profiles.select({ id: "p-owner", name: "Owner", hasPin: false, isPrimary: true, isChild: false, avatarUrl: undefined });
    const state = new RatingState(h.core.session, "movie:m0001", () => undefined, () => false);
    state.start(); await h.clock.advance(0);
    assert.equal(state.value, null);
    state.save(4); assert.equal(state.value, null); await h.clock.advance(0);
    assert.equal(state.value, 4);
    catalog.ratingFailure = problem(500, "failed", "Failed");
    state.save(2); await h.clock.advance(0);
    assert.equal(state.failed, true); assert.equal(state.value, 4);
    assert.equal(catalog.mutations.length, 2);
    state.stop(); state.start(); await h.clock.advance(0);
    assert.equal(state.failedTarget, undefined, "a page reload must not retain an old write for a later read Retry");
    assert.equal(catalog.mutations.length, 2);
    state.save(2, true); await h.clock.advance(0);
    assert.equal(state.value, 2); assert.equal(state.failed, false);
    state.save(null); await h.clock.advance(0); assert.equal(state.value, null);
    state.stop();
    assert.equal(catalog.route("GET", "/ratings/movie%3Am0001", "p-kid")?.status, 404);
});
