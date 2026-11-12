import assert from "node:assert/strict";
import { test } from "node:test";
import { operations } from "../../src/api/operations.ts";
import { decodeItemDetail, decodeSeasons, type Season } from "../../src/contracts/v2/catalog.ts";
import { DetailsState } from "../../src/ui/detailsState.ts";
import { SeriesEpisodes } from "../../src/ui/seriesEpisodes.ts";
import { FakeDetails } from "./support/fakeDetails.ts";
import { problem } from "./support/fakeSilo.ts";
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

test("a card menu owner neither holds an unanswered write nor raises an alert it cannot show", async () => {
    const h = await setup();
    const state = new DetailsState(h.detail, h.core.session, () => undefined, async () => undefined);
    try {
        state.start();
        await h.clock.advance(0);
        h.fake.dropNextAnswer("/watched/movie%3Am0001");
        state.change("watched", true);
        await h.clock.advance(0);
        assert.equal(state.changes.get("watched")?.failed, true);
        assert.equal(state.changes.get("watched")?.held, undefined);
        assert.equal(state.alert, undefined);
    } finally { state.stop(); }
});

test("a Details owner holds an unanswered write and never sends it again until discarded", async () => {
    const h = await setup();
    const state = new DetailsState(h.detail, h.core.session, () => undefined, async () => undefined);
    state.presentsAlerts = true;
    try {
        state.start();
        await h.clock.advance(0);
        h.fake.dropNextAnswer("/watched/movie%3Am0001");
        state.change("watched", true);
        await h.clock.advance(0);
        assert.equal(state.changes.get("watched")?.held, true);
        assert.equal(state.alert?.title, "Change Not Confirmed");
        state.dismissAlert();
        state.change("watched", true, true);
        await h.clock.advance(0);
        assert.equal(state.alert?.held, "watched");
        assert.deepEqual(h.catalog.mutations, ["POST /watched/movie%3Am0001"]);
        state.discardHeld();
        await h.clock.advance(0);
        assert.equal(state.changes.size, 0);
        assert.equal(state.values.get("watched"), true);
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

test("a failed series watched retry keeps each season rollup", async () => {
    const h = await setup();
    h.catalog.add({ id: "episode:s1e31", type: "episode", title: "Harbor Lights chapter 3.1", libraryId: "13", seriesId: "series:s1", season: 3, episode: 1 });
    for (const episode of [21, 22, 23]) h.catalog.watchedEpisodes.add(`episode:s1e${episode}`);
    const detail = decodeItemDetail(h.catalog.route("GET", "/catalog/items/series%3As1", "p-owner")?.body);
    const seasons = decodeSeasons(h.catalog.route("GET", "/catalog/series/series%3As1/seasons", "p-owner")?.body).map(season => seasonRollup(h.catalog, season));
    assert.equal(detail.played, false, "one unwatched episode leaves the series partial");
    assert.equal(seasons.find(season => season.seasonNumber === 1)?.userData?.played, true);
    assert.equal(seasons.find(season => season.seasonNumber === 2)?.userData?.played, true);
    const state = new DetailsState({ ...detail, playContentId: undefined }, h.core.session, () => undefined, async () => undefined);
    state.series = new SeriesEpisodes(h.core.session, detail.id, seasons, () => state.warmSeriesEpisodes(), 1);
    try {
        state.start("personal");
        state.warmSeriesEpisodes();
        await h.clock.advance(0);
        assert.equal(state.seasonStates.get(1)?.values.get("watched"), true);
        const failure = problem(422, "validation_failed", "Unavailable action");
        h.catalog.mutationFailure = failure;
        state.change("watched", true);
        await h.clock.advance(0);
        assert.equal(state.changes.get("watched")?.failed, true);
        h.catalog.mutationFailure = failure;
        const before = h.fake.requests.length;
        state.change("watched", true, true);
        await h.clock.advance(0);
        assert.equal(state.changes.get("watched")?.failed, true);
        assert.equal(state.values.get("watched"), false, "the series itself stays partial");
        assert.equal(state.seasonStates.get(1)?.values.get("watched"), true, "reconcile must not treat series played:false as an unwatched season");
        assert.equal(h.fake.requests.slice(before).filter(request => /\/catalog\/items\/series%3As1-S/.test(request.path)).length, 0, "reconciliation does not reread every season");
        state.series.start();
        state.series.select(2);
        assert.equal(state.seasonStates.get(2)?.values.get("watched"), true, "a later watched season keeps its own rollup");
        assert.deepEqual(h.catalog.mutations, ["POST /watched/series%3As1", "POST /watched/series%3As1"]);
    } finally { state.stop(); }
});

test("a lost series unwatched retry refreshes loaded season rollups", async () => {
    const h = await setup();
    for (const episode of [11, 12, 13, 21, 22, 23]) h.catalog.watchedEpisodes.add(`episode:s1e${episode}`);
    const detail = decodeItemDetail(h.catalog.route("GET", "/catalog/items/series%3As1", "p-owner")?.body);
    const seasons = decodeSeasons(h.catalog.route("GET", "/catalog/series/series%3As1/seasons", "p-owner")?.body).map(season => seasonRollup(h.catalog, season));
    assert.equal(detail.played, true, "every episode watched makes the series watched");
    assert.equal(seasons.find(season => season.seasonNumber === 2)?.userData?.played, true);
    const state = new DetailsState({ ...detail, playContentId: undefined }, h.core.session, () => undefined, async () => undefined);
    state.series = new SeriesEpisodes(h.core.session, detail.id, seasons, () => state.warmSeriesEpisodes(), 1);
    try {
        state.start("personal");
        state.warmSeriesEpisodes();
        await h.clock.advance(0);
        assert.equal(state.seasonStates.get(1)?.values.get("watched"), true);
        state.change("watched", true, true);
        await h.clock.advance(0);
        assert.equal(state.changes.size, 0, "a series that is already watched needs no write");
        assert.deepEqual(h.catalog.mutations, []);
        h.fake.dropNextAnswer("/watched/series%3As1");
        state.change("watched", false);
        await h.clock.advance(0);
        assert.equal(state.changes.get("watched")?.failed, true);
        assert.equal(state.values.get("watched"), true, "the lost answer leaves the series looking watched");
        assert.equal(state.seasonStates.get(1)?.values.get("watched"), true);
        const before = h.fake.requests.length;
        state.change("watched", false, true);
        await h.clock.advance(0);
        assert.equal(state.changes.size, 0, "the read shows the unwatched write already landed");
        assert.equal(state.values.get("watched"), false);
        assert.equal(state.seasonStates.get(1)?.values.get("watched"), false, "the open season takes its refreshed rollup");
        assert.deepEqual(h.catalog.mutations, ["DELETE /watched/series%3As1"], "retry does not send the write again");
        const during = h.fake.requests.slice(before);
        assert.equal(during.filter(request => /\/catalog\/series\/series%3As1\/seasons(?:\?|$)/.test(request.path)).length, 1, "loaded rollups refresh once");
        assert.equal(during.filter(request => /\/catalog\/items\/series%3As1-S/.test(request.path)).length, 0, "reconciliation does not reread every season");
        state.series.start();
        state.series.select(2);
        await h.clock.advance(0);
        assert.equal(state.seasonStates.get(2)?.values.get("watched"), false, "a later season uses its own rollup, not the stale series aggregate");
        assert.equal(h.fake.requests.slice(before).filter(request => /\/catalog\/items\/series%3As1-S/.test(request.path)).length, 0, "opening another season does not read every season");
    } finally { state.stop(); }
});

function seasonRollup(catalog: FakeDetails, season: Season): Season {
    const episodes = [...catalog.titles.values()].filter(title => title.seriesId === "series:s1" && title.season === season.seasonNumber);
    const watched = episodes.filter(episode => catalog.watchedEpisodes.has(episode.id)).length;
    return { ...season, userData: { played: episodes.length > 0 && watched === episodes.length, watchedCount: watched, inProgressCount: 0 } };
}
