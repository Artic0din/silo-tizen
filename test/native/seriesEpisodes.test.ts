import assert from "node:assert/strict";
import { test } from "node:test";
import { SeriesEpisodes } from "../../src/ui/seriesEpisodes.ts";
import { operations } from "../../src/api/operations.ts";
import { FakeDetails } from "./support/fakeDetails.ts";
import { connected, signIn } from "./support/harness.ts";
import { problem } from "./support/fakeSilo.ts";
import { decodeSeasons } from "../../src/contracts/v2/catalog.ts";
import { DetailsState } from "../../src/ui/detailsState.ts";
import { DescriptionTranslations, type DetailSurface, type ItemDescriptionTranslation } from "../../src/ui/descriptionTranslation.ts";

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
    for (const id of ["edge:2:0", "edge:2:1", "edge:3:0", "edge:2:0"]) {
        state.focus(id); t.mock.timers.tick(100); await settle();
    }
    assert.equal(h.fake.requests.length, reads, "revisiting a failed boundary and crossing loaded seasons never retries");
    assert.equal(state.boundaryFailed, true);
    h.fake.script(operations.listSeasonEpisodes("series:s1", 1).path, { status: 200, body: page(1) });
    if (recovery === "retry") state.retryNeighbors(); else state.select(1);
    await settle();
    assert.equal(state.boundaryFailed, false);
    assert.equal(state.railEpisodes?.length, 42);
    state.stop();
});

async function episodeRailHarness(failedSeason?: number, emptySeason?: number, heldSeason?: number, seasonCount = 7) {
    const h = await connected(); await signIn(h);
    const profile = (await h.core.profiles.list()).find(profile => profile.id === "p-owner"); assert.ok(profile); h.core.profiles.select(profile);
    const catalog = new FakeDetails(); h.fake.catalog = catalog;
    const seasons = decodeSeasons({ items: Array.from({ length: seasonCount }, (_, index) => ({ content_id: `s${index + 1}`, season_number: index + 1, title: `Season ${index + 1}`, episode_count: 14 })) });
    const body = catalog.route("GET", "/catalog/series/series%3As1/seasons/1/episodes", "p-owner")?.body as { items: Record<string, unknown>[] };
    for (const season of seasons) {
        const response = { status: 200, body: { items: Array.from({ length: 14 }, (_, index) => ({ ...body.items[0], content_id: `rail:${season.seasonNumber}:${index}`, season_number: season.seasonNumber, episode_number: index + 1 })) } };
        h.fake.script(operations.listSeasonEpisodes("series:s1", season.seasonNumber).path, season.seasonNumber === failedSeason ? problem(422, "validation_failed", "Unavailable") : season.seasonNumber === emptySeason ? { status: 200, body: { items: [] } } : response, response, response);
    }
    const state = new SeriesEpisodes(h.core.session, "series:s1", seasons, () => undefined, 2);
    const held = heldSeason === undefined ? undefined : h.fake.hold(operations.listSeasonEpisodes("series:s1", heldSeason).path, true);
    const settle = async (): Promise<void> => { for (let i = 0; i < 8; i++) await h.clock.advance(0); };
    const reads = () => h.fake.requests.filter(request => request.path.includes("/episodes")).map(request => request.path);
    state.start(); await settle();
    return { ...h, state, settle, reads, held };
}

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

test("superseded automatic season is read-free on revisit without a neighbour error", async t => {
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
    h.state.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    assert.deepEqual(h.reads(), reads);
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
    assert.equal(h.reads().length, 3);
    h.held?.release(); await h.settle();
    assert.equal(h.state.failed, true, "a finished failure must replace the selected loading state");
    assert.equal(h.state.boundaryFailed, false, "selected-season recovery belongs to Retry episodes");
    h.state.focusSeason(2); t.mock.timers.tick(70); await h.settle();
    h.state.focusSeason(3); t.mock.timers.tick(70); await h.settle();
    assert.equal(h.reads().length, 3, "failed prefetch is never retried by pill focus");
});

test("season pill dwell reuses cached pages and bounds a sweep to one cancellable read", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    assert.equal(h.reads().length, 3);
    h.state.focusSeason(3); t.mock.timers.tick(69); await h.settle();
    assert.equal(h.state.seasonNumber, 2);
    t.mock.timers.tick(1); await h.settle();
    assert.equal(h.state.seasonNumber, 3);
    assert.equal(h.state.entryEpisode, "rail:3:0");
    assert.equal(h.reads().length, 3, "cached selection sends zero reads");
    for (const season of [7, 6, 5, 4]) { h.state.focusSeason(season); t.mock.timers.tick(60); await h.settle(); }
    assert.equal(h.reads().length, 3, "holding across missing pills sends zero reads");
    const held = h.fake.hold(operations.listSeasonEpisodes("series:s1", 4).path, true);
    t.mock.timers.tick(10); await h.settle();
    assert.equal(h.reads().length, 4);
    h.state.focusSeason(3); t.mock.timers.tick(70); await h.settle();
    held.release(); await h.settle();
    assert.equal(h.state.seasonNumber, 3, "abandoned read cannot select its season");
    h.state.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    assert.equal(h.reads().length, 4, "revisit never retries the cancelled automatic read");
});

test("a successful automatic season can load again after bounded cache eviction", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    for (const season of [4, 5, 6, 7, 1, 2, 7]) {
        h.state.focusSeason(season); t.mock.timers.tick(70); await h.settle();
        assert.equal(h.state.failed, false, `successful season ${season} remains available after eviction`);
        assert.equal(h.state.entryEpisode, `rail:${season}:0`);
    }
    assert.deepEqual(h.reads(), [2, 1, 3, 4, 5, 6, 7, 1, 2, 7].map(season => operations.listSeasonEpisodes("series:s1", season).path));
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
    assert.deepEqual(h.reads(), [2, 1, 3, 4, 3, 4, 10, 11, 12, 13, 14, 4].map(season => operations.listSeasonEpisodes("series:s1", season).path));
});

for (const outcome of ["failed", "cancelled"] as const) test(`rail boundaries cannot retry a ${outcome} automatic pill read`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(outcome === "failed" ? 4 : undefined); t.after(() => h.state.stop());
    const held = outcome === "cancelled" ? h.fake.hold(operations.listSeasonEpisodes("series:s1", 4).path, true) : undefined;
    h.state.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    h.state.focusSeason(3); t.mock.timers.tick(70); await h.settle();
    held?.release(); await h.settle();
    h.state.focus("rail:3:13"); t.mock.timers.tick(70); await h.settle();
    assert.equal(h.reads().length, 4, "rail entry cannot bypass pill failure or cancellation recovery");
    assert.equal(h.state.boundaryFailed, false, "a selected-season failure stays with that season");
});

for (const outcome of ["success", "empty", "failure"] as const) test(`missing season pill ${outcome} consumes one read without warming or revisit retries`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(outcome === "failure" ? 4 : undefined, outcome === "empty" ? 4 : undefined); t.after(() => h.state.stop());
    h.state.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    assert.equal(h.reads().length, 4);
    assert.equal(h.state.failed, outcome === "failure");
    if (outcome === "empty") assert.deepEqual(h.state.episodes, []);
    for (const season of [3, 4, 3, 4]) { h.state.focusSeason(season); t.mock.timers.tick(70); await h.settle(); }
    assert.equal(h.reads().length, 4, "completion and revisits never chain or retry reads");
});

for (const timing of ["pending", "completed"] as const) test(`Select confirms a ${timing} pill read across blur without warming neighbours`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    const held = h.fake.hold(operations.listSeasonEpisodes("series:s1", 4).path, true);
    h.state.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    assert.equal(h.reads().length, 4);
    if (timing === "completed") { held.release(); await h.settle(); }
    h.state.select(4); h.state.blurSeason(); await h.settle();
    held.release(); await h.settle();
    assert.equal(h.state.failed, false);
    assert.equal(h.state.entryEpisode, "rail:4:0");
    assert.equal(h.reads().length, 4, "confirmation reuses the pending read without neighbour reads");
});

test("Retry and selected-pill Select read only the failed season", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(4); t.after(() => h.state.stop());
    h.state.focusSeason(4); t.mock.timers.tick(70); await h.settle();
    h.state.retry(); await h.settle();
    h.state.select(4); await h.settle();
    assert.deepEqual(h.reads(), [2, 1, 3, 4, 4].map(number => operations.listSeasonEpisodes("series:s1", number).path));
});

test("immediate Select reuses a cached season before its focus dwell", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    h.state.focusSeason(3); h.state.select(3); await h.settle();
    assert.equal(h.reads().length, 3);
    assert.equal(h.state.entryEpisode, "rail:3:0");
});

test("a missing season paints its summary with one season read and zero item reads", async t => {
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
    assert.equal(reads.filter(request => request.path.includes("/episodes")).length, 1);
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
