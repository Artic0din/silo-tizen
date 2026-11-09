import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { SeriesEpisodes } from "../../src/ui/seriesEpisodes.ts";
import { operations } from "../../src/api/operations.ts";
import { FakeDetails } from "./support/fakeDetails.ts";
import { connected, signIn } from "./support/harness.ts";
import { problem } from "./support/fakeSilo.ts";
import { decodeSeasons } from "../../src/contracts/v2/catalog.ts";
import { DetailsState } from "../../src/ui/detailsState.ts";
import { DescriptionTranslations, type DetailSurface, type ItemDescriptionTranslation } from "../../src/ui/descriptionTranslation.ts";

type SeriesEpisodeUpdate = Parameters<ConstructorParameters<typeof SeriesEpisodes>[3]>[0];

/** Focus resting on the rail's first card long enough for the edge dwell: the only retry Apple offers a failed edge. */
function restAtEdge(t: TestContext, state: SeriesEpisodes, id: string): void { state.focus(id); t.mock.timers.tick(70); }

for (const recovery of ["retry", "selection"] as const) test(`one neighbour success preserves the other edge's failure and ${recovery} recovery`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await connected(); await signIn(h);
    const profile = (await h.core.profiles.list()).find(profile => profile.id === "p-owner"); assert.ok(profile); h.core.profiles.select(profile);
    const catalog = new FakeDetails(); h.fake.catalog = catalog;
    const seasons = decodeSeasons({ items: [1, 2, 3].map(number => ({ content_id: `s${number}`, season_number: number, title: `Season ${number}`, episode_count: 14 })) });
    const body = catalog.route("GET", "/catalog/series/series%3As1/seasons/1/episodes", "p-owner")?.body as { items: Record<string, unknown>[] };
    const page = (season: number) => ({ items: Array.from({ length: 14 }, (_, index) => ({ ...body.items[0], content_id: `edge:${season}:${index}`, season_number: season, episode_number: index + 1 })) });
    h.fake.script(operations.listSeasonEpisodes("series:s1", 2).path, { status: 200, body: page(2) });
    h.fake.script(operations.listSeasonEpisodes("series:s1", 1).path, problem(422, "validation_failed", "Unavailable"));
    const held = h.fake.hold(operations.listSeasonEpisodes("series:s1", 3).path, true);
    h.fake.script(operations.listSeasonEpisodes("series:s1", 3).path, { status: 200, body: page(3) });
    const state = new SeriesEpisodes(h.core.session, "series:s1", seasons, () => undefined, 2);
    const settle = async (): Promise<void> => { for (let i = 0; i < 8; i++) await h.clock.advance(0); };
    state.start(); await settle();
    assert.equal(state.boundaryFailed, true);
    held.release(); await settle();
    assert.equal(state.boundaryFailed, true, "success on the right must not hide the left failure");
    const reads = h.fake.requests.length;
    state.focus("edge:2:1"); await settle();
    assert.equal(h.fake.requests.length, reads, "interior moves never retry");
    for (const id of ["edge:2:1", "edge:3:0", "edge:2:1"]) {
        state.focus(id); t.mock.timers.tick(100); await settle();
    }
    assert.equal(h.fake.requests.length, reads, "crossing loaded seasons never retries");
    assert.equal(state.boundaryFailed, true);
    h.fake.script(operations.listSeasonEpisodes("series:s1", 1).path, { status: 200, body: page(1) });
    if (recovery === "retry") restAtEdge(t, state, "edge:2:0"); else state.select(1);
    await settle();
    assert.equal(state.boundaryFailed, false);
    assert.equal(state.railEpisodes?.length, 42);
    state.stop();
});

async function episodeRailHarness(failedSeason?: number, emptySeason?: number, heldSeason?: number, seasonCount = 7, changed: (reason: SeriesEpisodeUpdate) => void = () => undefined) {
    const h = await connected(); await signIn(h);
    const profile = (await h.core.profiles.list()).find(profile => profile.id === "p-owner"); assert.ok(profile); h.core.profiles.select(profile);
    const catalog = new FakeDetails(); h.fake.catalog = catalog;
    const seasons = decodeSeasons({ items: Array.from({ length: seasonCount }, (_, index) => ({ content_id: `s${index + 1}`, season_number: index + 1, title: `Season ${index + 1}`, episode_count: 14 })) });
    const body = catalog.route("GET", "/catalog/series/series%3As1/seasons/1/episodes", "p-owner")?.body as { items: Record<string, unknown>[] };
    for (const season of seasons) {
        const response = { status: 200, body: { items: Array.from({ length: 14 }, (_, index) => ({ ...body.items[0], content_id: `rail:${season.seasonNumber}:${index}`, season_number: season.seasonNumber, episode_number: index + 1 })) } };
        h.fake.script(operations.listSeasonEpisodes("series:s1", season.seasonNumber).path, season.seasonNumber === failedSeason ? problem(422, "validation_failed", "Unavailable") : season.seasonNumber === emptySeason ? { status: 200, body: { items: [] } } : response, response, response);
    }
    const state = new SeriesEpisodes(h.core.session, "series:s1", seasons, changed, 2);
    const held = heldSeason === undefined ? undefined : h.fake.hold(operations.listSeasonEpisodes("series:s1", heldSeason).path, true);
    const settle = async (): Promise<void> => { for (let i = 0; i < 8; i++) await h.clock.advance(0); };
    const reads = () => h.fake.requests.filter(request => request.path.includes("/episodes")).map(request => request.path);
    state.start(); await settle();
    return { ...h, state, settle, reads, held };
}

test("reopening Details keeps the fresh neighbor window, not a chip walk to the first season", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(undefined, undefined, undefined, 5);
    t.after(() => h.state.stop());
    for (const season of [4, 5]) {
        h.state.focusSeason(season);
        t.mock.timers.tick(70);
        await h.settle();
    }
    assert.equal(h.state.seasonNumber, 5);
    assert.equal(h.state.windowReachesSeriesStart, true);
    const reopened = new SeriesEpisodes(h.core.session, "series:s1", h.state.seasons, () => undefined, 5);
    reopened.restore(h.state, false, true);
    assert.equal(reopened.windowReachesSeriesStart, false);
    assert.equal(reopened.railEpisodes?.some(episode => episode.seasonNumber === 1), false);
    assert.equal(reopened.railEpisodes?.some(episode => episode.seasonNumber === 4), true);
    reopened.start();
    await h.settle();
    const before = h.reads().length;
    reopened.select(1);
    await h.settle();
    assert.equal(h.reads().length, before, "a season left out of the fresh window is reused, not refetched");
    assert.equal(reopened.railEpisodes?.some(episode => episode.seasonNumber === 1), true);
    reopened.stop();
    const refresh = new SeriesEpisodes(h.core.session, "series:s1", h.state.seasons, () => undefined, 5);
    refresh.restore(h.state, true);
    assert.equal(refresh.windowReachesSeriesStart, true);
});

test("a failed selected season does not leak its error into a loaded selection", async () => {
    const h = await episodeRailHarness(1);
    h.state.select(1, true); await h.settle();
    assert.equal(h.state.failed, true);
    h.state.select(3, true); await h.settle();
    assert.equal(h.state.failed, false);
    assert.equal(h.state.boundaryFailed, false);
    h.state.stop();
});

test("restoring requests keeps the failed row until explicit Retry reads it once", async () => {
    const h = await episodeRailHarness(1);
    h.state.select(1, true); await h.settle();
    const reads = h.reads().length;
    await h.settle();
    assert.equal(h.state.failed, true);
    assert.equal(h.reads().length, reads);
    h.state.retry(); await h.settle();
    assert.equal(h.state.failed, false);
    assert.equal(h.reads().length, reads + 1);
    assert.equal(h.reads().at(-1), operations.listSeasonEpisodes("series:s1", 1).path);
    h.state.stop();
});

test("a superseded automatic season is read by the next selection's neighbour prefetch, so its revisit sends no read", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    const held = h.fake.hold(operations.listSeasonEpisodes("series:s1", 4).path, true);
    h.state.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    h.state.focusSeason(3);
    assert.equal(h.state.failed, false, "supersession must not publish a selected-row error during dwell");
    t.mock.timers.tick(70); await h.settle();
    held.release(); await h.settle();
    assert.equal(h.state.boundaryFailed, false);
    const reads = h.reads();
    assert.deepEqual(reads.slice(3), [4, 5, 4].map(number => operations.listSeasonEpisodes("series:s1", number).path), "season 4's own aborted read, its missing neighbour 5, then season 4 as the missing neighbour of season 3");
    h.state.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    assert.deepEqual(h.reads(), reads);
    assert.equal(h.state.failed, false);
    assert.equal(h.state.entryEpisode, "rail:4:0");
});

test("failed Retry survives cached selection and visit restoration without warming", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    const path = operations.listSeasonEpisodes("series:s1", 4).path;
    h.fake.scripted.delete(path);
    h.fake.script(path, problem(422, "validation_failed", "Unavailable"), problem(422, "validation_failed", "Unavailable"));
    h.state.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    h.state.retry(); await h.settle();
    assert.equal(h.state.failed, true);
    h.state.focusSeason(3); t.mock.timers.tick(70); await h.settle();
    const reads = h.reads();
    h.state.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    assert.deepEqual(h.reads(), reads, "failed Retry must remain remembered");
    const restored = new SeriesEpisodes(h.core.session, "series:s1", h.state.seasons, () => undefined, 4);
    restored.restore(h.state); h.state.stop(); restored.start(); await h.settle();
    assert.deepEqual(h.reads(), reads, "return must not warm adjacent seasons");
    assert.equal(restored.failed, true); restored.stop();
});

for (const season of [2, 3]) test(`explicit season ${season} Select supersedes Calendar entry through revalidation`, async t => {
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    h.state.entryEpisode = "rail:2:1";
    h.state.select(season);
    await h.settle();
    assert.equal(h.state.selectionChanged, true);
    assert.equal(h.state.entryEpisode, `rail:${season}:0`);
    const refreshed = new SeriesEpisodes(h.core.session, "series:s1", h.state.seasons, () => undefined, season, `rail:${season}:1`);
    t.after(() => refreshed.stop());
    refreshed.restore(h.state, true);
    h.state.stop();
    refreshed.start(); await h.settle();
    assert.equal(refreshed.entryEpisode, `rail:${season}:0`);
    assert.equal(refreshed.selectionOwnsHero, true);
});

test("revalidation retries a selected season that failed during an outage", async t => {
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    h.fake.dropNextAnswer(operations.listSeasonEpisodes("series:s1", 4).path);
    h.state.select(4); await h.settle();
    assert.equal(h.state.failed, true);
    const refreshed = new SeriesEpisodes(h.core.session, "series:s1", h.state.seasons, () => undefined, 4);
    t.after(() => refreshed.stop());
    refreshed.restore(h.state, true); h.state.stop();
    refreshed.start(); await h.settle();
    assert.equal(refreshed.failed, false);
    assert.equal(refreshed.episodes?.[0]?.id, "rail:4:0");
});

test("another season's transport failure cannot clear a remembered HTTP refusal", async t => {
    const h = await episodeRailHarness(1); t.after(() => h.state.stop());
    const refused = operations.listSeasonEpisodes("series:s1", 1).path;
    h.fake.scripted.set(refused, []);
    h.fake.script(refused, ...Array.from({ length: 3 }, () => problem(422, "validation_failed", "Unavailable")));
    h.fake.dropNextAnswer(operations.listSeasonEpisodes("series:s1", 4).path);
    h.state.select(4); await h.settle();
    assert.equal(h.state.failed, true);
    h.state.select(3); await h.settle();
    h.state.select(1, true); await h.settle();
    assert.equal(h.state.failed, true);
    const reads = h.reads();
    const refreshed = new SeriesEpisodes(h.core.session, "series:s1", h.state.seasons, () => undefined, 1);
    t.after(() => refreshed.stop());
    refreshed.restore(h.state, true); h.state.stop();
    refreshed.start(); await h.settle();
    assert.equal(refreshed.failed, true);
    assert.deepEqual(h.reads(), reads, "revalidation cannot retry the remembered refusal");
});

test("an invalidated series refreshes restored episode pages", async t => {
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    const restored = new SeriesEpisodes(h.core.session, "series:s1", h.state.seasons, () => undefined, 2);
    restored.restore(h.state, true); h.state.stop();
    const before = h.reads().length;
    restored.start(); await h.settle();
    assert.equal(h.reads().length, before + 1, "stale routes refresh the selected page even when cached");
    restored.stop();
});

test("failed retained refresh never becomes an unrecoverable missing-page error", async t => {
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    const restored = new SeriesEpisodes(h.core.session, "series:s1", h.state.seasons, () => undefined, 2);
    restored.restore(h.state, true); h.state.stop();
    const path = operations.listSeasonEpisodes("series:s1", 2).path;
    h.fake.scripted.delete(path);
    h.fake.script(path, problem(422, "validation_failed", "Unavailable"));
    restored.start(); await h.settle();
    assert.equal(restored.failed, true);
    restored.select(1);
    assert.equal(restored.boundaryFailed, false);
    restored.stop();
});

test("selecting an in-flight neighbour exposes selected-season failure without duplicate reads", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(3, undefined, 3); t.after(() => h.state.stop());
    h.state.focusSeason(3); t.mock.timers.tick(70); await h.settle();
    assert.deepEqual(h.reads().slice(3), [operations.listSeasonEpisodes("series:s1", 4).path], "the pending season is not read twice; the selection reads only its missing neighbour 4");
    h.held?.release(); await h.settle();
    assert.equal(h.state.failed, true, "a finished failure must replace the selected loading state");
    assert.equal(h.state.boundaryFailed, false, "selected-season recovery belongs to Retry episodes");
    h.state.focusSeason(2); t.mock.timers.tick(70); await h.settle();
    h.state.focusSeason(3); t.mock.timers.tick(70); await h.settle();
    assert.equal(h.reads().length, 4, "failed prefetch is never retried by pill focus");
});

test("season pill dwell reuses cached pages and bounds a sweep to one cancellable read", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    const path = (number: number): string => operations.listSeasonEpisodes("series:s1", number).path;
    assert.equal(h.reads().length, 3);
    h.state.focusSeason(3); t.mock.timers.tick(69); await h.settle();
    assert.equal(h.state.seasonNumber, 2);
    t.mock.timers.tick(1); await h.settle();
    assert.equal(h.state.seasonNumber, 3);
    assert.equal(h.state.entryEpisode, "rail:3:0");
    assert.deepEqual(h.reads().slice(3), [path(4)], "a cached selection reads only its missing neighbour");
    for (const season of [7, 6, 5]) { h.state.focusSeason(season); t.mock.timers.tick(60); await h.settle(); }
    assert.equal(h.reads().length, 4, "holding across missing pills sends zero reads");
    const held = h.fake.hold(path(5), true);
    t.mock.timers.tick(10); await h.settle();
    assert.deepEqual(h.reads().slice(4), [path(5), path(6)], "the dwell reads the season and its missing neighbour");
    h.state.focusSeason(3); t.mock.timers.tick(70); await h.settle();
    held.release(); await h.settle();
    assert.equal(h.state.seasonNumber, 3, "abandoned read cannot select its season");
    h.state.focusSeason(5); t.mock.timers.tick(70); await h.settle();
    assert.deepEqual(h.reads().slice(6), [path(5)], "revisit reads the cancelled automatic season again, and its neighbours are already loaded");
});

test("a successful automatic season can load again after bounded cache eviction", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    for (const season of [4, 5, 6, 7, 1, 2, 7]) {
        h.state.focusSeason(season); t.mock.timers.tick(70); await h.settle();
        assert.equal(h.state.failed, false, `successful season ${season} remains available after eviction`);
        assert.equal(h.state.entryEpisode, `rail:${season}:0`);
    }
    assert.deepEqual(h.reads(), [2, 1, 3, 4, 5, 6, 7, 1, 2, 7, 6].map(season => operations.listSeasonEpisodes("series:s1", season).path), "each selection reads its missing neighbour; an evicted season is read again, with the neighbour it needs");
});

test("a cancelled season reloads after neighbour recovery once its page is evicted", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(undefined, undefined, undefined, 14); t.after(() => h.state.stop());
    const held = h.fake.hold(operations.listSeasonEpisodes("series:s1", 4).path, true);
    h.state.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    h.state.focusSeason(3); t.mock.timers.tick(70); await h.settle();
    held.release(); await h.settle();
    const restored = new SeriesEpisodes(h.core.session, "series:s1", h.state.seasons, () => undefined, 3);
    restored.restore(h.state, true); h.state.stop(); t.after(() => restored.stop());
    restored.start(); await h.settle();
    assert.equal(restored.railEpisodes?.some(episode => episode.id === "rail:4:0"), true, "restored refresh warms the cancelled neighbour");
    for (const season of [10, 11, 12, 13, 14]) { restored.focusSeason(season); t.mock.timers.tick(70); await h.settle(); }
    restored.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    assert.equal(restored.failed, false);
    assert.equal(restored.interrupted, false, "a successful neighbour page must not leave the cancellation marker");
    assert.equal(restored.entryEpisode, "rail:4:0");
    assert.deepEqual(h.reads(), [2, 1, 3, 4, 5, 4, 3, 10, 9, 11, 12, 13, 14, 4, 3, 5].map(season => operations.listSeasonEpisodes("series:s1", season).path));
});

test("the selection that supersedes an aborted automatic read reads that season as its previous neighbour, so Left needs no read", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    const held = h.fake.hold(operations.listSeasonEpisodes("series:s1", 4).path, true);
    h.state.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    h.state.focusSeason(5); t.mock.timers.tick(70); await h.settle();
    held.release(); await h.settle();
    assert.equal(h.state.seasonNumber, 5);
    assert.deepEqual(h.reads().slice(3), [4, 5, 4, 6].map(number => operations.listSeasonEpisodes("series:s1", number).path), "the aborted read of 4, its neighbour 5, then 4 and 6 as the missing neighbours of 5");
    const ids = h.state.railEpisodes?.map(episode => episode.id) ?? [];
    assert.equal(ids[ids.indexOf("rail:5:0") - 1], "rail:4:13", "the season joins the rail so focus can move on");
    const reads = h.reads().length;
    h.state.blurSeason();
    h.state.focus("rail:5:0"); t.mock.timers.tick(70); await h.settle();
    assert.equal(h.reads().length, reads, "the previous season is loaded, so Left asks for nothing");
});

test("Left inside an already-loaded previous season sends no new read", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    const holds = [4, 5, 6].map(season => h.fake.hold(operations.listSeasonEpisodes("series:s1", season).path, true));
    for (const season of [4, 5, 6, 7]) { h.state.focusSeason(season); t.mock.timers.tick(80); await h.settle(); }
    for (const hold of holds) hold.release();
    h.state.select(7); await h.settle();
    const reads = h.reads().length;
    h.state.blurSeason();
    h.state.focus("rail:7:0"); t.mock.timers.tick(1500); await h.settle();
    assert.equal(h.reads().length, reads, "each dwell selection already read the season beside it, so no edge read remains");
    for (let index = 13; index >= 1; index--) {
        h.state.focus(`rail:6:${index}`); t.mock.timers.tick(1500); await h.settle();
        assert.equal(h.state.seasonNumber, 6);
        assert.equal(h.reads().length, reads, `moving to card ${index} of the loaded season never reads`);
    }
});

test("rail boundaries cannot retry a failed automatic pill read", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(4); t.after(() => h.state.stop());
    h.state.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    h.state.focusSeason(3); t.mock.timers.tick(70); await h.settle();
    h.state.blurSeason();
    h.state.focus("rail:3:13"); t.mock.timers.tick(70); await h.settle();
    assert.equal(h.reads().length, 5, "the failed season 4 and its neighbour 5 are the only reads; rail entry cannot bypass pill failure recovery");
    assert.equal(h.state.boundaryFailed, false, "a selected-season failure stays with that season");
});

test("focus reaching the rail edge retries a neighbour whose prefetch failed", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(1); t.after(() => h.state.stop());
    assert.equal(h.state.boundaryFailed, true);
    assert.equal(h.state.railEpisodes?.[0]?.id, "rail:2:0", "the failed previous season is outside the rail");
    const reads = h.reads().length;
    h.state.focus("rail:2:0"); t.mock.timers.tick(70); await h.settle();
    assert.equal(h.reads().length, reads + 1, "the edge asks again once for the failed season");
    assert.equal(h.reads().at(-1), operations.listSeasonEpisodes("series:s1", 1).path);
    assert.equal(h.state.boundaryFailed, false);
    assert.equal(h.state.railEpisodes?.[0]?.id, "rail:1:0", "the retried season joins the rail");
});

test("the boundary error hides while its edge retry is in flight and returns if the retry fails", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(1); t.after(() => h.state.stop());
    const path = operations.listSeasonEpisodes("series:s1", 1).path;
    assert.equal(h.state.boundaryFailed, true);
    h.fake.scripted.set(path, []);
    h.fake.script(path, problem(422, "validation_failed", "Unavailable"));
    const held = h.fake.hold(path, true);
    restAtEdge(t, h.state, "rail:2:0"); await h.settle();
    assert.equal(h.state.boundaryFailed, false, "Apple clears carouselLoadFailed when the prefetch starts");
    held.release(); await h.settle();
    assert.equal(h.state.boundaryFailed, true, "a failed retry shows the error again");
    h.fake.script(path, { status: 200, body: { items: [] } });
    const second = h.fake.hold(path, true);
    restAtEdge(t, h.state, "rail:2:0"); await h.settle();
    assert.equal(h.state.boundaryFailed, false);
    second.release(); await h.settle();
    assert.equal(h.state.boundaryFailed, false);
});

for (const order of ["stop then restore", "restore then stop"] as const) test(`a retry aborted by leaving Details is read again when Details reappears (${order})`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(1);
    const path = operations.listSeasonEpisodes("series:s1", 1).path;
    const held = h.fake.hold(path, true);
    restAtEdge(t, h.state, "rail:2:0"); await h.settle();
    assert.equal(h.state.boundaryFailed, false);
    const restored = new SeriesEpisodes(h.core.session, "series:s1", h.state.seasons, () => undefined, 2);
    t.after(() => restored.stop());
    if (order === "stop then restore") { h.state.stop(); restored.restore(h.state); } else { restored.restore(h.state); h.state.stop(); }
    held.release(); await h.settle();
    assert.equal(restored.boundaryFailed, false, "Apple clears carouselLoadFailed when the view reappears");
    const reads = h.reads().length;
    restored.start(); await h.settle();
    assert.equal(h.reads().length, reads + 1, "the reappearing view reads the failed season at once");
    assert.equal(h.reads().at(-1), path);
    assert.equal(restored.railEpisodes?.[0]?.id, "rail:1:0", "the re-read season joins the rail");
});

test("a restored visit clears an edge failure and reads it again on start, and a second failure shows the error", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(1);
    const path = operations.listSeasonEpisodes("series:s1", 1).path;
    h.fake.scripted.set(path, []);
    h.fake.script(path, problem(422, "validation_failed", "Unavailable"));
    assert.equal(h.state.boundaryFailed, true);
    const reads = h.reads().length;
    const restored = new SeriesEpisodes(h.core.session, "series:s1", h.state.seasons, () => undefined, 2);
    t.after(() => restored.stop());
    restored.restore(h.state); h.state.stop();
    assert.equal(restored.boundaryFailed, false, "the failure is not carried into the new visit");
    assert.equal(h.reads().length, reads, "nothing is read before the visit starts");
    restored.start(); await h.settle();
    assert.equal(h.reads().length, reads + 1);
    assert.equal(restored.boundaryFailed, true, "a failed re-read shows the error again");
});

test("the edge dwell announces its retry to the view while the read is still held", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const changes: SeriesEpisodeUpdate[] = [];
    const h = await episodeRailHarness(1, undefined, undefined, 7, reason => changes.push(reason)); t.after(() => h.state.stop());
    const path = operations.listSeasonEpisodes("series:s1", 1).path;
    h.fake.hold(path, true);
    changes.length = 0;
    h.state.focus("rail:2:0"); t.mock.timers.tick(70); await h.settle();
    assert.equal(h.state.boundaryFailed, false, "the retry is running");
    assert.deepEqual(changes, ["neighbor"], "the view repaints as the dwell starts the retry, not only when it ends");
});

test("selecting a distant season clears the old edge failure and reads that season's own missing neighbours", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(1); t.after(() => h.state.stop());
    assert.equal(h.state.boundaryFailed, true);
    const reads = h.reads().length;
    h.state.select(5); await h.settle();
    assert.equal(h.state.seasonNumber, 5);
    assert.equal(h.state.boundaryFailed, false, "Apple clears carouselLoadFailed when the selected season changes");
    assert.deepEqual(h.reads().slice(reads), [5, 4, 6].map(number => operations.listSeasonEpisodes("series:s1", number).path), "the selected season, then each missing neighbour; season 1 is not beside it");
});

test("selecting a cached season reads a neighbour that never failed and clears an old failure beyond the full side", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const changes: SeriesEpisodeUpdate[] = [];
    const h = await episodeRailHarness(1, undefined, undefined, 7, reason => changes.push(reason)); t.after(() => h.state.stop());
    assert.equal(h.state.boundaryFailed, true);
    const reads = h.reads().length;
    changes.length = 0;
    h.state.select(3);
    assert.deepEqual(changes, ["load", "neighbor"], "the view repaints after the failure is cleared, before any read answers");
    await h.settle();
    assert.equal(h.state.seasonNumber, 3);
    assert.deepEqual(h.reads().slice(reads), [operations.listSeasonEpisodes("series:s1", 4).path], "season 4 was never read, so the selection reads it; season 2 already holds a full row, so the walk stops before season 1");
    assert.equal(h.state.boundaryFailed, false, "the failure is cleared and not re-read");
    assert.equal(h.state.railEpisodes?.at(-1)?.id, "rail:4:13", "the neighbour joins the rail");
});

test("a held edge retry is aborted by selecting a distant season and is not read or shown again", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(1); t.after(() => h.state.stop());
    const season1 = operations.listSeasonEpisodes("series:s1", 1).path;
    h.fake.hold(season1, true);
    restAtEdge(t, h.state, "rail:2:0"); await h.settle();
    assert.equal(h.state.boundaryFailed, false, "the retry is running");
    const reads = h.reads().length;
    h.state.select(7); await h.settle();
    assert.equal(h.state.seasonNumber, 7);
    assert.equal(h.state.boundaryFailed, false, "the new selection forgets the aborted retry's failure");
    assert.deepEqual(h.reads().slice(reads), [7, 6].map(number => operations.listSeasonEpisodes("series:s1", number).path), "season 1 is not read again: it is not beside season 7");
    assert.equal(h.reads().filter(path => path === season1).length, 2, "the failure and the held retry are its only reads");
});

test("Back to a cached Details clears the edge failure and reads the season again", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(1); t.after(() => h.state.stop());
    const path = operations.listSeasonEpisodes("series:s1", 1).path;
    assert.equal(h.state.boundaryFailed, true);
    const reads = h.reads().length;
    h.state.stop();
    h.state.start(); await h.settle();
    assert.deepEqual(h.reads().slice(reads), [path], "the same instance reads the failed season on reappearing, without a focus move");
    assert.equal(h.state.boundaryFailed, false);
    assert.equal(h.state.railEpisodes?.[0]?.id, "rail:1:0", "the re-read season joins the rail");
});

test("selecting the season whose edge retry is in flight leaves no stale edge error after it loads", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(1); t.after(() => h.state.stop());
    const held = h.fake.hold(operations.listSeasonEpisodes("series:s1", 1).path, true);
    restAtEdge(t, h.state, "rail:2:0"); await h.settle();
    h.state.select(1); await h.settle();
    assert.equal(h.state.failed, false);
    held.release(); await h.settle();
    assert.equal(h.state.seasonNumber, 1);
    assert.equal(h.state.boundaryFailed, false, "the loaded season is not a failed neighbour");
    h.state.select(2); await h.settle();
    assert.equal(h.state.boundaryFailed, false, "moving on does not resurrect the failure of a season that loaded");
});

test("a dwell back onto a season whose read was cancelled finds it loaded by the next selection's neighbour prefetch", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    const held = h.fake.hold(operations.listSeasonEpisodes("series:s1", 4).path, true);
    h.state.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    h.state.focusSeason(3); t.mock.timers.tick(70); await h.settle();
    held.release(); await h.settle();
    const reads = h.reads().length;
    h.state.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    assert.equal(h.reads().length, reads, "the selection of season 3 already read the cancelled season beside it");
    assert.equal(h.reads().filter(path => path === operations.listSeasonEpisodes("series:s1", 4).path).length, 2, "the aborted read and the neighbour read");
    assert.equal(h.state.interrupted, false);
    assert.equal(h.state.entryEpisode, "rail:4:0");
});

test("a failed re-read of a cancelled season shows the failure, not the interruption", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    const held = h.fake.hold(operations.listSeasonEpisodes("series:s1", 4).path, true);
    h.state.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    h.fake.dropNextAnswer(operations.listSeasonEpisodes("series:s1", 4).path);
    h.state.focusSeason(3); t.mock.timers.tick(70); await h.settle();
    held.release(); await h.settle();
    h.state.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    assert.equal(h.state.failed, true);
    assert.equal(h.state.interrupted, false, "the latest read failed; it was not cancelled");
});

async function restoredAfterCancelledSeason(t: TestContext, failRetry: boolean) {
    const h = await episodeRailHarness();
    const path = operations.listSeasonEpisodes("series:s1", 4).path;
    const abandoned = h.fake.hold(path, true);
    h.state.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    // Selecting season 3 reads season 4 as its neighbour; hold that read so the visit is left with season 4 still cancelled.
    const neighbour = h.fake.hold(path, true);
    h.state.focusSeason(3); t.mock.timers.tick(70); await h.settle();
    abandoned.release(); await h.settle();
    const restored = new SeriesEpisodes(h.core.session, "series:s1", h.state.seasons, () => undefined, 3);
    restored.restore(h.state, true); h.state.stop();
    neighbour.release(); await h.settle();
    const retry = failRetry ? undefined : h.fake.hold(path, true);
    if (failRetry) h.fake.dropNextAnswer(path);
    restored.start(); await h.settle();
    return { ...h, restored, retry };
}

test("a selected season whose cancelled read is retried by a neighbour read is not interrupted while it loads", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await restoredAfterCancelledSeason(t, false); t.after(() => h.restored.stop());
    h.restored.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    assert.equal(h.restored.seasonNumber, 4);
    assert.equal(h.restored.episodes, undefined, "the retry has not answered yet");
    assert.equal(h.restored.interrupted, false, "a read is in flight, so nothing is interrupted");
    h.retry?.release(); await h.settle();
    assert.equal(h.restored.interrupted, false);
    assert.equal(h.restored.entryEpisode, "rail:4:0");
});

test("a failed neighbour retry of a cancelled season reads as failed, not interrupted", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await restoredAfterCancelledSeason(t, true); t.after(() => h.restored.stop());
    h.restored.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    assert.equal(h.restored.seasonNumber, 4);
    assert.equal(h.restored.failed, true);
    assert.equal(h.restored.interrupted, false, "the retry failed; the cancellation no longer applies");
});

test("a chip dwell onto a neighbour whose retry is in flight shows loading, not failure", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(1); t.after(() => h.state.stop());
    const held = h.fake.hold(operations.listSeasonEpisodes("series:s1", 1).path, true);
    h.state.focus("rail:2:0"); t.mock.timers.tick(70); await h.settle();
    h.state.blur();
    h.state.focusSeason(1); t.mock.timers.tick(70); await h.settle();
    assert.equal(h.state.failed, false, "the retry is still running");
    held.release(); await h.settle();
    assert.equal(h.state.failed, false);
    assert.equal(h.state.entryEpisode, "rail:1:0");
});

test("reaching one rail edge also retries the failed season at the other edge", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(1); t.after(() => h.state.stop());
    h.state.focus("rail:3:13"); t.mock.timers.tick(70); await h.settle();
    const seasons = h.reads().slice(3).map(path => /seasons\/(\d+)\//.exec(path)?.[1]).sort();
    assert.deepEqual(seasons, ["1", "4"], "Apple re-runs the prefetch on both sides");
    assert.equal(h.state.boundaryFailed, false);
});

for (const outcome of ["success", "empty", "failure"] as const) test(`missing season pill ${outcome} reads the season and its missing neighbour once, with no revisit retries`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(outcome === "failure" ? 4 : undefined, outcome === "empty" ? 4 : undefined); t.after(() => h.state.stop());
    h.state.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    assert.equal(h.reads().length, 5, "the season, then its missing neighbour 5");
    assert.equal(h.state.failed, outcome === "failure");
    if (outcome === "empty") assert.deepEqual(h.state.episodes, []);
    for (const season of [3, 4, 3, 4]) { h.state.focusSeason(season); t.mock.timers.tick(70); await h.settle(); }
    assert.equal(h.reads().length, 5, "completion and revisits never chain or retry reads");
});

for (const timing of ["pending", "completed"] as const) test(`Select confirms a ${timing} pill read across blur without further reads`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    const held = h.fake.hold(operations.listSeasonEpisodes("series:s1", 4).path, true);
    h.state.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    assert.equal(h.reads().length, 5, "the pill read and its missing neighbour");
    if (timing === "completed") { held.release(); await h.settle(); }
    h.state.select(4); h.state.blurSeason(); await h.settle();
    held.release(); await h.settle();
    assert.equal(h.state.failed, false);
    assert.equal(h.state.entryEpisode, "rail:4:0");
    assert.equal(h.reads().length, 5, "confirmation reuses the pending read and sends no further reads");
});

test("Retry and selected-pill Select read only the failed season; the pill selection read its neighbour once", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(4); t.after(() => h.state.stop());
    h.state.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    h.state.retry(); await h.settle();
    h.state.select(4); await h.settle();
    assert.deepEqual(h.reads(), [2, 1, 3, 4, 5, 4].map(number => operations.listSeasonEpisodes("series:s1", number).path));
});

test("immediate Select reuses a cached season before its focus dwell", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    h.state.focusSeason(3); h.state.select(3); await h.settle();
    assert.deepEqual(h.reads().slice(3), [operations.listSeasonEpisodes("series:s1", 4).path], "season 3 is reused; only its missing neighbour 4 is read");
    assert.equal(h.state.entryEpisode, "rail:3:0");
});

test("a missing season paints its summary with its season read, its neighbour read and zero item reads", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness();
    const detail = await h.core.session.call({ ...operations.getCatalogItem("series:s1"), profileScoped: true });
    const details = new DetailsState(detail, h.core.session, () => undefined, async () => undefined);
    details.series = h.state; details.start(); await h.settle();
    t.after(() => details.stop());
    const before = h.fake.requests.length;
    h.state.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    details.warmSeriesEpisodes(); await h.settle();
    const reads = h.fake.requests.slice(before);
    assert.deepEqual(reads.filter(request => request.path.includes("/episodes")).map(request => request.path), [4, 5].map(number => operations.listSeasonEpisodes("series:s1", number).path));
    assert.equal(reads.filter(request => request.path.startsWith("/catalog/items/")).length, 0);
    assert.equal(details.heroEpisodeId, "rail:4:0");
    assert.equal(details.playbackTargetId, "rail:4:0");
});

test("rate-limited season sweep and Retry never invoke transport retries", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    for (const number of [4, 5, 6, 7]) {
        const path = operations.listSeasonEpisodes("series:s1", number).path;
        h.fake.scripted.delete(path);
        h.fake.script(path, problem(503, "unavailable", "Unavailable"), problem(503, "unavailable", "Unavailable"));
    }
    for (const number of [4, 5, 6, 7]) {
        h.state.focusSeason(number); t.mock.timers.tick(150); await h.settle();
        await h.clock.advance(2000); await h.settle();
    }
    h.state.retry(); await h.settle(); await h.clock.advance(2000); await h.settle();
    assert.equal(h.state.failed, true);
    for (const number of [4, 5, 6, 7, 4, 5, 6, 7]) {
        h.state.focusSeason(number); t.mock.timers.tick(70); await h.settle();
        assert.equal(h.state.failed, true);
    }
    assert.deepEqual(h.reads(), [2, 1, 3, 4, 5, 6, 7, 7].map(number => operations.listSeasonEpisodes("series:s1", number).path));
});

test("Show Series Info restores the series overview after episode focus takes over a pill", async () => {
    const h = await episodeRailHarness();
    const detail = await h.core.session.call({ ...operations.getCatalogItem("series:s1"), profileScoped: true });
    const details = new DetailsState(detail, h.core.session, () => undefined, async () => undefined);
    details.series = h.state;
    details.start();
    await h.settle();
    h.state.select(3, true);
    details.warmSeriesEpisodes();
    await h.settle();
    assert.equal(h.state.focusSelectedEpisode, true);
    assert.equal(h.state.selectionOwnsHero, true);
    assert.equal(details.heroEpisodeId, "rail:3:0");
    h.state.focus("rail:3:1");
    details.focusEpisode("rail:3:1");
    assert.equal(h.state.focusSelectedEpisode, true, "episode focus leaves the pill flag set");
    assert.equal(h.state.selectionOwnsHero, false);
    assert.equal(details.heroEpisodeId, "rail:3:1");
    details.warmSeriesEpisodes();
    assert.equal(details.heroEpisodeId, "rail:3:1", "a refresh must not put the pill's first episode back over episode focus");
    details.showSeriesOverview();
    await h.settle();
    assert.equal(details.heroEpisodeId, undefined, "Show Series Info restores the series overview");
    assert.equal(details.playbackTargetId, "rail:3:0", "Play stays on the selected season suggestion");
    details.stop();
    h.state.stop();
});

test("a late superseded item read cannot overwrite a cached season's hero target", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    const detail = await h.core.session.call({ ...operations.getCatalogItem("series:s1"), profileScoped: true });
    const details = new DetailsState(detail, h.core.session, () => undefined, async () => undefined);
    details.series = h.state;
    const itemPath = (id: string): string => operations.getCatalogItem(id).path;
    const raw = h.fake.catalog?.route("GET", "/catalog/items/episode%3As1e11", "p-owner")?.body;
    assert.ok(raw && typeof raw === "object");
    for (const season of [1, 3]) h.fake.script(itemPath(`rail:${season}:0`), { status: 200, body: { ...raw, content_id: `rail:${season}:0`, season_number: season, episode_number: 1 } });
    const held = h.fake.hold(itemPath("rail:1:0"), true);
    details.start(); t.after(() => details.stop());
    h.state.select(1, true); details.warmSeriesEpisodes(); details.loadNextEpisode(); await h.settle();
    const before = h.fake.requests.filter(request => request.path.startsWith("/catalog/items/rail")).length;
    h.state.select(3, true); details.warmSeriesEpisodes(); details.loadNextEpisode(); await h.settle();
    h.state.focusSelectedEpisode = false;
    details.focusEpisode("rail:1:0");
    assert.equal(details.heroEpisodeId, "rail:3:0", "late focus from the previous rendering cannot replace pill selection");
    held.release(); await h.settle();
    assert.equal(details.playbackTargetId, "rail:3:0");
    assert.equal(details.nextEpisode?.id, "rail:3:0");
    assert.equal(h.fake.requests.filter(request => request.path.startsWith("/catalog/items/rail")).length, before + 1, "only the selected playback episode is hydrated");
});

test("focus crosses loaded seasons without episode reads or chained prefetch", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    assert.deepEqual(h.reads(), [2, 1, 3].map(number => operations.listSeasonEpisodes("series:s1", number).path));
    const before = h.reads();
    for (const id of ["rail:2:13", "rail:3:0", "rail:3:1", "rail:2:13", "rail:1:13", "rail:2:0"]) {
        h.state.focus(id); t.mock.timers.tick(100); await h.settle();
    }
    assert.deepEqual(h.reads(), before, "all cached-season crossings and interior moves send zero reads");
    assert.equal(h.state.selectionChanged, true, "cached recovery preserves a season selected through the continuous rail");
});

test("an unloaded outer boundary debounces one immediate neighbour read and never stacks requests", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    const held = h.fake.hold(operations.listSeasonEpisodes("series:s1", 4).path, true);
    h.state.focus("rail:3:12"); t.mock.timers.tick(100); await h.settle();
    assert.equal(h.reads().length, 3);
    h.state.focus("rail:3:13"); t.mock.timers.tick(69); await h.settle();
    assert.equal(h.reads().length, 3, "a quick boundary visit sends nothing");
    h.state.focus("rail:3:12"); t.mock.timers.tick(100); await h.settle();
    assert.equal(h.reads().length, 3, "leaving before the dwell cancels the read");
    h.state.focus("rail:3:13"); t.mock.timers.tick(70); await h.settle();
    assert.deepEqual(h.reads(), [2, 1, 3, 4].map(number => operations.listSeasonEpisodes("series:s1", number).path));
    for (let index = 0; index < 5; index++) {
        h.state.focus("rail:3:12"); h.state.focus("rail:3:13"); t.mock.timers.tick(100); await h.settle();
    }
    assert.equal(h.reads().length, 4, "holding or revisiting an in-flight boundary never stacks reads");
    held.release(); await h.settle(); t.mock.timers.tick(100); await h.settle();
    assert.equal(h.reads().length, 4, "completion does not chain-load the next season");
    assert.equal(h.state.railEpisodes?.at(-1)?.id, "rail:4:13");
});

test("a long rail round trip can reload successful neighbours evicted by the bounded cache", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    for (const id of ["rail:3:13", "rail:4:13", "rail:5:13", "rail:6:13", "rail:3:0", "rail:2:0", "rail:5:13"]) {
        assert.ok(h.state.railEpisodes?.some(episode => episode.id === id), `the next focused card ${id} is loaded`);
        h.state.focus(id); t.mock.timers.tick(70); await h.settle();
    }
    assert.deepEqual(h.reads(), [2, 1, 3, 4, 5, 6, 7, 2, 1, 6].map(number => operations.listSeasonEpisodes("series:s1", number).path));
    assert.equal(h.state.railEpisodes?.at(-1)?.id, "rail:6:13");
});

class CapturedTranslations extends DescriptionTranslations {
    surface: DetailSurface | undefined;
    override open(surface: DetailSurface): ItemDescriptionTranslation {
        this.surface = surface;
        return super.open(surface);
    }
}

for (const boundary of ["pending", "failed"] as const) test(`translation polls retain the loaded episode window and its ${boundary} neighbour`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(boundary === "failed" ? 4 : undefined); t.after(() => h.state.stop());
    const held = boundary === "pending" ? h.fake.hold(operations.listSeasonEpisodes("series:s1", 4).path, true) : undefined;
    h.state.focus("rail:3:13"); t.mock.timers.tick(70); await h.settle();
    const translations = new CapturedTranslations(h.core.session, h.clock);
    const detail = await h.core.session.call({ ...operations.getCatalogItem("series:s1"), profileScoped: true });
    const details = new DetailsState(detail, h.core.session, () => undefined, async () => undefined, () => false, translations);
    details.series = h.state;
    assert.ok(translations.surface);
    const reads = h.reads(), ids = h.state.railEpisodes?.map(episode => episode.id);
    const translated = h.state.episodes!.map(episode => ({ ...episode, title: "Translated title", pendingTranslationLanguage: "de" }));
    for (let index = 0; index < 3; index++) {
        assert.equal(translations.surface.replaceEpisodes(3, translated), false);
        await h.settle();
        assert.deepEqual(h.state.railEpisodes?.map(episode => episode.id), ids);
        assert.deepEqual(h.reads(), reads, "translation publication never starts neighbour reads");
        assert.equal(h.state.boundaryFailed, boundary === "failed");
        assert.equal(h.state.episodes?.[0]?.title, "Translated title");
    }
    held?.release(); await h.settle();
    if (held !== undefined) assert.equal(h.state.railEpisodes?.at(-1)?.id, "rail:4:13", "translation did not cancel the pending neighbour");
});

test('series entry follows the current season instead of the first season', async () => {
    const h = await connected();
    const seasons = decodeSeasons({ items: [1, 14].map(number => ({ content_id: `s${number}`, season_number: number, title: `Season ${number}`, episode_count: 10, user_data: { played: number === 1, watched_count: number === 1 ? 10 : 4, in_progress_count: number === 14 ? 1 : 0 } })) });
    const state = new SeriesEpisodes(h.core.session, 'series', seasons, () => undefined);
    assert.equal(state.seasonNumber, 14);
    const explicit = new SeriesEpisodes(h.core.session, 'series', seasons, () => undefined, 1);
    assert.equal(explicit.seasonNumber, 1, 'explicit context still wins');
});

test('episode row entry uses the current episode after the selected season loads', async () => {
    const h = await connected(); await signIn(h);
    const profile = (await h.core.profiles.list()).find(profile => profile.id === 'p-owner'); assert.ok(profile); h.core.profiles.select(profile);
    const catalog = new FakeDetails(); h.fake.catalog = catalog;
    const seasons = await h.core.session.call({ ...operations.listSeriesSeasons('series:s1'), profileScoped: true });
    const raw = catalog.route('GET', '/catalog/series/series%3As1/seasons/1/episodes', 'p-owner');
    assert.ok(raw?.body && typeof raw.body === 'object');
    const body = raw.body as { items: Record<string, unknown>[] };
    h.fake.script(operations.listSeasonEpisodes('series:s1', 1).path, { status: 200, body: { items: body.items.map((episode, index) => ({ ...episode, user_data: { played: false, is_in_progress: index === 1 } })) } });
    const state = new SeriesEpisodes(h.core.session, 'series:s1', seasons, () => undefined);
    state.start(); for (let index = 0; index < 5; index++) await h.clock.advance(0);
    assert.equal(state.entryEpisode, 'episode:s1e12');
    state.stop();
});

test("series episodes retain accepted data and reject abandoned or replaced season reads", async () => {
    const h = await connected();
    await signIn(h);
    const profile = (await h.core.profiles.list()).find(profile => profile.id === "p-owner");
    assert.ok(profile);
    h.core.profiles.select(profile);
    h.fake.catalog = new FakeDetails();
    const seasons = await h.core.session.call({ ...operations.listSeriesSeasons("series:s1"), profileScoped: true });
    let changed = 0;
    const state = new SeriesEpisodes(h.core.session, "series:s1", seasons, () => changed++, 1, "episode:s1e12");
    const settle = async (): Promise<void> => { for (let index = 0; index < 5; index++) await h.clock.advance(0); };
    const initial = h.fake.hold(operations.listSeasonEpisodes("series:s1", 1).path, true);
    state.start();
    await settle();
    state.select(1);
    await settle();
    assert.equal(h.fake.requests.filter(request => request.path.includes("/episodes")).length, 1, "reselecting a loading chip keeps its existing read");
    assert.equal(state.entryEpisode, undefined, "explicit Select supersedes resume while the current season is loading");
    initial.release();
    await settle();
    assert.equal(state.seasonNumber, 1);
    assert.equal(state.episodes?.[0]?.id, "episode:s1e11");
    assert.equal(state.entryEpisode, "episode:s1e11");
    const reads = h.fake.requests.filter(request => request.path.includes("/episodes")).length;
    state.stop(); state.start();
    await settle();
    assert.equal(h.fake.requests.filter(request => request.path.includes("/episodes")).length, reads);
    const path = operations.listSeasonEpisodes("series:s1", 2).path;
    const held = h.fake.hold(path, true);
    state.select(2);
    state.retry();
    await settle();
    state.select(1);
    await settle();
    held.release();
    await settle();
    assert.equal(state.seasonNumber, 1);
    assert.equal(state.episodes?.[0]?.id, "episode:s1e11");
    h.fake.script(path, problem(422, "validation_failed", "Unavailable season"));
    state.select(2);
    state.retry();
    await settle();
    assert.equal(state.failed, true);
    state.retry();
    await settle();
    assert.equal(state.failed, false);
    assert.equal(state.episodes?.[0]?.id, "episode:s1e21");
    const late = h.fake.hold(operations.listSeasonEpisodes("series:s1", 1).path, true);
    state.select(1);
    state.retry();
    await settle();
    state.stop();
    const before = changed;
    late.release();
    await settle();
    assert.equal(changed, before);
    assert.equal(state.episodes?.[0]?.id, "episode:s1e11");
});
