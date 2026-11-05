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

async function episodeRailHarness(failedSeason?: number) {
    const h = await connected(); await signIn(h);
    const profile = (await h.core.profiles.list()).find(profile => profile.id === "p-owner"); assert.ok(profile); h.core.profiles.select(profile);
    const catalog = new FakeDetails(); h.fake.catalog = catalog;
    const seasons = decodeSeasons({ items: [1, 2, 3, 4, 5, 6, 7].map(number => ({ content_id: `s${number}`, season_number: number, title: `Season ${number}`, episode_count: 14 })) });
    const body = catalog.route("GET", "/catalog/series/series%3As1/seasons/1/episodes", "p-owner")?.body as { items: Record<string, unknown>[] };
    for (const season of seasons) {
        const response = { status: 200, body: { items: Array.from({ length: 14 }, (_, index) => ({ ...body.items[0], content_id: `rail:${season.seasonNumber}:${index}`, season_number: season.seasonNumber, episode_number: index + 1 })) } };
        h.fake.script(operations.listSeasonEpisodes("series:s1", season.seasonNumber).path, season.seasonNumber === failedSeason ? problem(422, "validation_failed", "Unavailable") : response, response);
    }
    const state = new SeriesEpisodes(h.core.session, "series:s1", seasons, () => undefined, 2);
    const settle = async (): Promise<void> => { for (let i = 0; i < 8; i++) await h.clock.advance(0); };
    const reads = () => h.fake.requests.filter(request => request.path.includes("/episodes")).map(request => request.path);
    state.start(); await settle();
    return { ...h, state, settle, reads };
}

test("focus crosses loaded seasons without episode reads or chained prefetch", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await episodeRailHarness(); t.after(() => h.state.stop());
    assert.deepEqual(h.reads(), [2, 1, 3].map(number => operations.listSeasonEpisodes("series:s1", number).path));
    const before = h.reads();
    for (const id of ["rail:2:13", "rail:3:0", "rail:3:1", "rail:2:13", "rail:1:13", "rail:2:0"]) {
        h.state.focus(id); t.mock.timers.tick(100); await h.settle();
    }
    assert.deepEqual(h.reads(), before, "all cached-season crossings and interior moves send zero reads");
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
    await settle();
    state.select(1);
    await settle();
    held.release();
    await settle();
    assert.equal(state.seasonNumber, 1);
    assert.equal(state.episodes?.[0]?.id, "episode:s1e11");
    h.fake.script(path, problem(422, "validation_failed", "Unavailable season"));
    state.select(2);
    await settle();
    assert.equal(state.failed, true);
    state.retry();
    await settle();
    assert.equal(state.failed, false);
    assert.equal(state.episodes?.[0]?.id, "episode:s1e21");
    const late = h.fake.hold(operations.listSeasonEpisodes("series:s1", 1).path, true);
    state.select(1);
    await settle();
    state.stop();
    const before = changed;
    late.release();
    await settle();
    assert.equal(changed, before);
    assert.equal(state.episodes, undefined);
});
