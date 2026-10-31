import assert from "node:assert/strict";
import { test } from "node:test";
import { operations } from "../../src/api/operations.ts";
import { DetailsState } from "../../src/ui/detailsState.ts";
import { FakeDetails } from "./support/fakeDetails.ts";
import { connected, signIn } from "./support/harness.ts";

async function setup() {
    const h = await connected();
    await signIn(h);
    const catalog = new FakeDetails();
    h.fake.catalog = catalog;
    const profile = (await h.core.profiles.list())[0];
    assert.ok(profile);
    h.core.profiles.select(profile);
    const detail = await h.core.session.call({ ...operations.getCatalogItem("movie:m0001"), profileScoped: true });
    return { ...h, catalog, detail };
}

test("personal mutation owner blocks other kinds while any write is pending", async () => {
    const h = await setup();
    const state = new DetailsState(h.detail, h.core.session, () => undefined, async () => undefined);
    try {
        state.start();
        await h.clock.advance(0);
        const answer = h.fake.hold("/watched/movie%3Am0001", true);
        state.change("watched", true);
        state.change("favorites", true);
        state.change("watchlist", true);
        await h.clock.advance(0);
        assert.deepEqual(h.catalog.mutations, ["POST /watched/movie%3Am0001"]);
        answer.release();
        await h.clock.advance(0);
    } finally { state.stop(); }
});

test("stopped uncertain owner retains its target and reconciles before an explicit retry", async () => {
    const h = await setup();
    const state = new DetailsState(h.detail, h.core.session, () => undefined, async () => undefined);
    try {
        state.start();
        await h.clock.advance(0);
        h.fake.dropNextAnswer("/watched/movie%3Am0001");
        state.change("watched", true);
        await h.clock.advance(0);
        assert.equal(state.changes.get("watched")?.target, true);
        state.stop();
        state.start();
        const change = state.changes.get("watched");
        assert.ok(change?.failed);
        state.change("watched", change.target, true);
        await h.clock.advance(0);
        assert.equal(state.values.get("watched"), true);
        assert.equal(state.changes.size, 0);
        assert.deepEqual(h.catalog.mutations, ["POST /watched/movie%3Am0001"]);
    } finally { state.stop(); }
});

test("personal-only startup skips related/title-art and season membership without hiding watched", async () => {
    const h = await setup();
    for (const id of ["movie:m0001", "series:s1-S1"]) {
        const detail = await h.core.session.call({ ...operations.getCatalogItem(id), profileScoped: true });
        const state = new DetailsState(detail, h.core.session, () => undefined, async () => undefined);
        const before = h.fake.requests.length;
        try {
            state.start("personal");
            await h.clock.advance(0);
            assert.ok(state.values.has("watched"));
            assert.equal(h.fake.requests.slice(before).filter(r => /recommendations|settings/.test(r.path)).length, 0);
            if (detail.type === "season") {
                assert.deepEqual([...state.values.keys()], ["watched"]);
                assert.equal(h.fake.requests.length, before);
            } else assert.equal(state.values.get("favorites"), false);
        } finally { state.stop(); }
    }
});

test("synthetic personal flags stay per item and profile, including watched readback", () => {
    const catalog = new FakeDetails();
    catalog.route("PUT", "/favorites/movie%3Am0002", "p-owner");
    assert.deepEqual(catalog.route("GET", "/favorites/movie%3Am0002/membership", "p-owner")?.body, { item_id: "movie:m0002", is_member: true });
    assert.deepEqual(catalog.route("GET", "/favorites/movie%3Am0001/membership", "p-owner")?.body, { item_id: "movie:m0001", is_member: false });
    assert.deepEqual(catalog.route("GET", "/favorites/movie%3Am0002/membership", "p-kid")?.body, { item_id: "movie:m0002", is_member: false });
    catalog.route("POST", "/watched/movie%3Am0002", "p-owner");
    const owner = catalog.route("GET", "/catalog/items/movie%3Am0002", "p-owner")?.body;
    const other = catalog.route("GET", "/catalog/items/movie%3Am0001", "p-owner")?.body;
    assert.equal((owner as { user_state: { played: boolean } }).user_state.played, true);
    assert.equal((other as { user_state: { played: boolean } }).user_state.played, false);
});

test("a shared pending predicate serializes independent Details owners without losing targets", async () => {
    const h = await setup();
    const other = await h.core.session.call({ ...operations.getCatalogItem("movie:m0002"), profileScoped: true });
    const states: DetailsState[] = [];
    const pending = () => states.some(state => state.pending);
    const first = new DetailsState(h.detail, h.core.session, () => undefined, async () => undefined, pending);
    const second = new DetailsState(other, h.core.session, () => undefined, async () => undefined, pending);
    states.push(first, second);
    try {
        first.start("personal");
        second.start("personal");
        await h.clock.advance(0);
        const firstAnswer = h.fake.hold("/favorites/movie%3Am0001", true);
        first.change("favorites", true);
        second.change("watched", true);
        await h.clock.advance(0);
        assert.equal(second.busy, true);
        assert.equal(second.pending, false);
        assert.deepEqual(h.catalog.mutations, ["PUT /favorites/movie%3Am0001"]);
        firstAnswer.release();
        await h.clock.advance(0);
        assert.equal(second.busy, false);
        const secondAnswer = h.fake.hold("/watched/movie%3Am0002", true);
        second.change("watched", true);
        first.change("watchlist", true);
        await h.clock.advance(0);
        assert.equal(first.busy, true);
        assert.deepEqual(h.catalog.mutations, ["PUT /favorites/movie%3Am0001", "POST /watched/movie%3Am0002"]);
        secondAnswer.release();
        await h.clock.advance(0);
        assert.equal(first.values.get("favorites"), true);
        assert.equal(second.values.get("watched"), true);
        assert.equal(first.changes.size + second.changes.size, 0);
    } finally { first.stop(); second.stop(); }
});
