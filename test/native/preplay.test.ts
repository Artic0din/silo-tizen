import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeItemDetail, decodeResumePosition, decodeSeasons, type ItemDetail } from "../../src/contracts/v2/catalog.ts";
import { SeriesEpisodes } from "../../src/ui/seriesEpisodes.ts";
import { decodeFileVersionTracks } from "../../src/contracts/v2/playback.ts";
import { object, WireError } from "../../src/contracts/v2/wire.ts";
import { DetailsState } from "../../src/ui/detailsState.ts";
import { playChoices, type PlayRequest } from "../../src/ui/browseModel.ts";
import { connected, signIn } from "./support/harness.ts";
import { settle } from "./support/clock.ts";
import { FakeDetails } from "./support/fakeDetails.ts";
import { fixture, problem } from "./support/fakeSilo.ts";

const ID = "movie:m0001";
const WATCH = "/watch/movie%3Am0001?file_id=42";

test("cached Series recovery revalidates its loaded episode owners", async () => {
    const r = await rig(); r.state.stop();
    const detail = decodeItemDetail(r.catalog.route('GET', '/catalog/items/series%3As1', 'p-owner')?.body);
    const seasons = decodeSeasons(r.catalog.route('GET', '/catalog/series/series%3As1/seasons', 'p-owner')?.body);
    const state = new DetailsState(detail, r.h.core.session, () => undefined, async () => undefined);
    state.series = new SeriesEpisodes(r.h.core.session, detail.id, seasons, () => state.warmSeriesEpisodes());
    state.start(); await settle();
    const id = 'episode:s1e12';
    const previous = state.cachedEpisode(id);
    assert.ok(previous);
    state.offline = true;
    state.acceptDetail(detail);
    await settle();
    assert.ok(state.cachedEpisode(id));
    assert.notEqual(state.cachedEpisode(id), previous, 'fresh recovery replaces stale episode metadata and preferences');
    state.stop();
});

test("returning from Episode information refreshes cached effective episode preferences", async () => {
    const r = await rig(); r.state.stop();
    const detail = decodeItemDetail(r.catalog.route('GET', '/catalog/items/series%3As1', 'p-owner')?.body);
    const seasons = decodeSeasons(r.catalog.route('GET', '/catalog/series/series%3As1/seasons', 'p-owner')?.body);
    const state = new DetailsState(detail, r.h.core.session, () => undefined, async () => undefined);
    state.series = new SeriesEpisodes(r.h.core.session, detail.id, seasons, () => state.warmSeriesEpisodes());
    state.start(); await settle();
    const id = 'episode:s1e12';
    assert.ok(state.cachedEpisode(id));
    state.stop();
    state.noteEpisodePreference(id, true);
    const raw = r.catalog.route('GET', '/catalog/items/episode%3As1e12', 'p-owner')?.body;
    assert.ok(raw && typeof raw === 'object');
    r.h.fake.script('/catalog/items/episode%3As1e12?image_size=large', { status: 200, body: { ...raw, effective_subtitle_mode: 'off', effective_show_forced_subtitles: false } });
    const writes = r.h.fake.requests.filter(request => request.method !== 'GET').length;
    state.start(); await settle();
    assert.equal(state.cachedEpisode(id)?.subtitleIntent().kind, 'off');
    const reads = r.h.fake.requests.length;
    state.focusEpisode(id);
    assert.equal(r.h.fake.requests.length, reads, 'focus remains read-free');
    assert.equal(r.h.fake.requests.filter(request => request.method !== 'GET').length, writes, 'return is read-only');
    state.stop();
});

test("returning to retained Series completes interrupted season prefetches before focus", async () => {
    const r = await rig();
    r.state.stop();
    const detail = decodeItemDetail(r.catalog.route('GET', '/catalog/items/series%3As1', 'p-owner')?.body);
    const seasons = decodeSeasons(r.catalog.route('GET', '/catalog/series/series%3As1/seasons', 'p-owner')?.body);
    const state = new DetailsState(detail, r.h.core.session, () => undefined, async () => undefined);
    state.series = new SeriesEpisodes(r.h.core.session, detail.id, seasons, () => state.warmSeriesEpisodes());
    const held = r.h.fake.hold('/catalog/items/episode%3As1e12?image_size=large', true);
    state.start();
    await settle();
    assert.equal(state.cachedEpisode('episode:s1e12'), undefined);
    state.stop();
    held.release();
    await settle();
    state.start();
    await settle();
    assert.ok(state.cachedEpisode('episode:s1e12'));
    const before = r.h.fake.requests.length;
    state.focusEpisode('episode:s1e12');
    assert.equal(state.nextEpisode?.id, 'episode:s1e12');
    assert.equal(r.h.fake.requests.length, before);
    state.stop();
});

test("season detail prefetch bounds concurrency and cancels queued and late work", async () => {
    const r = await rig(); r.state.stop();
    const detail = decodeItemDetail(r.catalog.route('GET', '/catalog/items/series%3As1', 'p-owner')?.body);
    const seasons = decodeSeasons(r.catalog.route('GET', '/catalog/series/series%3As1/seasons', 'p-owner')?.body);
    const state = new DetailsState(detail, r.h.core.session, () => undefined, async () => undefined);
    state.series = new SeriesEpisodes(r.h.core.session, detail.id, seasons, () => state.warmSeriesEpisodes());
    state.start(); await settle();
    const row = state.series.episodes?.[0], title = r.catalog.titles.get('episode:s1e11');
    assert.ok(row && title);
    const ids = Array.from({ length: 6 }, (_, index) => `episode:batch-${index}`);
    const held = ids.map(id => { r.catalog.titles.set(id, { ...title, id }); return r.h.fake.hold(`/catalog/items/${encodeURIComponent(id)}?image_size=large`, true); });
    state.series.replace(state.series.seasonNumber!, ids.map(id => ({ ...row, id })));
    state.warmSeriesEpisodes(); await settle();
    const reads = (): number => r.h.fake.requests.filter(request => request.path.startsWith('/catalog/items/episode%3Abatch-')).length;
    assert.equal(reads(), 4);
    state.focusEpisode(ids[5] ?? '');
    assert.equal(reads(), 4, 'focusing a queued episode starts no read');
    held[0]?.release(); await settle();
    assert.equal(reads(), 5, 'one completed read frees one worker');
    state.stop();
    for (const request of held) request.release();
    await settle();
    assert.equal(reads(), 5, 'cancellation does not launch the queued sixth read');
    assert.equal(state.cachedEpisode(ids[5] ?? ''), undefined);
});

test("confirming a shared preference requeues episodes whose detail read was interrupted", async () => {
    const r = await rig(); r.state.stop();
    const detail = decodeItemDetail(r.catalog.route('GET', '/catalog/items/series%3As1', 'p-owner')?.body);
    const seasons = decodeSeasons(r.catalog.route('GET', '/catalog/series/series%3As1/seasons', 'p-owner')?.body);
    const state = new DetailsState(detail, r.h.core.session, () => undefined, async () => undefined);
    state.series = new SeriesEpisodes(r.h.core.session, detail.id, seasons, () => state.warmSeriesEpisodes());
    const held = r.h.fake.hold('/catalog/items/episode%3As1e12?image_size=large', true);
    state.start(); await settle();
    const first = state.cachedEpisode('episode:s1e11');
    assert.ok(first);
    r.h.fake.script('/subtitle-prefs/series%3As1', { status: 204 }, { status: 200, body: { series_id: 'series:s1', subtitle_mode: 'off', subtitle_track_index: -1 } });
    state.noteEpisodePreference(first.detail.id);
    first.selectSubtitle('off'); await settle();
    assert.ok(state.cachedEpisode('episode:s1e12'), 'preference refresh must include unfinished episode reads');
    held.release(); state.stop(); await settle();
});

test("restored episode focus and overview next-up can belong to different seasons", async () => {
    const r = await rig(); r.state.stop();
    const detail = decodeItemDetail(r.catalog.route('GET', '/catalog/items/series%3As1', 'p-owner')?.body);
    const seasons = decodeSeasons(r.catalog.route('GET', '/catalog/series/series%3As1/seasons', 'p-owner')?.body);
    const previous = new DetailsState(detail, r.h.core.session, () => undefined, async () => undefined);
    previous.series = new SeriesEpisodes(r.h.core.session, detail.id, seasons, () => previous.warmSeriesEpisodes());
    previous.start(); await settle(); previous.focusEpisode('episode:s1e12'); previous.stop();
    const state = new DetailsState({ ...detail, playContentId: 'episode:s1e21' }, r.h.core.session, () => undefined, async () => undefined);
    state.series = new SeriesEpisodes(r.h.core.session, detail.id, seasons, () => state.warmSeriesEpisodes(), 1);
    state.restore(previous); state.start(); await settle();
    assert.equal(state.nextEpisode?.id, 'episode:s1e12');
    state.showSeriesOverview(); await settle();
    assert.equal(state.nextEpisode?.id, 'episode:s1e21');
    state.stop();
});

test("preference confirmation recovers after an interrupted save and failed detail reload", async () => {
    const r = await rig(); r.state.stop();
    const detail = decodeItemDetail(r.catalog.route('GET', '/catalog/items/series%3As1', 'p-owner')?.body);
    const seasons = decodeSeasons(r.catalog.route('GET', '/catalog/series/series%3As1/seasons', 'p-owner')?.body);
    const previous = new DetailsState(detail, r.h.core.session, () => undefined, async () => undefined);
    previous.series = new SeriesEpisodes(r.h.core.session, detail.id, seasons, () => previous.warmSeriesEpisodes());
    previous.start(); await settle();
    const owner = previous.cachedEpisode('episode:s1e11'); assert.ok(owner);
    r.h.fake.script('/subtitle-prefs/series%3As1', { status: 204 }, { status: 200, body: { series_id: 'series:s1', subtitle_mode: 'off', subtitle_track_index: -1 } });
    const held = r.h.fake.hold('/subtitle-prefs/series%3As1', true);
    previous.noteEpisodePreference(owner.detail.id); owner.selectSubtitle('off'); await settle(); previous.stop(); held.release(); await settle();
    const state = new DetailsState(detail, r.h.core.session, () => undefined, async () => undefined);
    state.series = new SeriesEpisodes(r.h.core.session, detail.id, seasons, () => state.warmSeriesEpisodes());
    state.restore(previous);
    r.h.fake.script('/catalog/items/episode%3As1e11?image_size=large', { status: 500 });
    state.start(); await settle();
    assert.equal(state.episodePreferencesBlocked, true);
    const stopped = state.unsettledEpisode; assert.ok(stopped);
    state.retryPreference('subtitles', stopped); await settle();
    assert.ok(state.cachedEpisode('episode:s1e11'), 'confirmation must reload a stopped preference owner');
    assert.equal(state.episodePreferencesBlocked, false);
    state.stop();
});

test("repeated Series restores retain an unresolved episode choice until confirmation", async () => {
    const r = await rig(); r.state.stop();
    const detail = decodeItemDetail(r.catalog.route('GET', '/catalog/items/series%3As1', 'p-owner')?.body);
    const seasons = decodeSeasons(r.catalog.route('GET', '/catalog/series/series%3As1/seasons', 'p-owner')?.body);
    const create = (): DetailsState => {
        const state = new DetailsState(detail, r.h.core.session, () => undefined, async () => undefined);
        state.series = new SeriesEpisodes(r.h.core.session, detail.id, seasons, () => state.warmSeriesEpisodes());
        return state;
    };
    const original = create(); original.start(); await settle();
    const owner = original.cachedEpisode('episode:s1e11'); assert.ok(owner);
    const preferencePath = '/subtitle-prefs/series%3As1';
    r.h.fake.script(preferencePath, { status: 204 }, { status: 200, body: { series_id: 'series:s1', subtitle_mode: 'off', subtitle_track_index: -1 } });
    const held = r.h.fake.hold(preferencePath, true);
    original.noteEpisodePreference(owner.detail.id); owner.selectSubtitle('off'); await settle();
    original.stop(); held.release(); await settle();
    const writes = (): number => r.h.fake.requests.filter(request => request.path === preferencePath && request.method === 'PUT').length;
    assert.equal(writes(), 1);
    let previous = original;
    for (let visit = 0; visit < 2; visit++) {
        const state = create(); state.restore(previous);
        r.h.fake.script('/catalog/items/episode%3As1e11?image_size=large', { status: 500 });
        state.start(); await settle();
        assert.equal(state.episodePreferencesBlocked, true, `replacement ${visit + 1} must retain uncertain preference`);
        assert.equal(state.unsettledEpisode?.subtitleIntent().kind, 'off');
        assert.equal(state.cachedEpisode(owner.detail.id), undefined);
        assert.equal(writes(), 1, 'restoring never replays the uncertain mutation');
        state.stop(); previous = state;
    }
    const recovered = create(); recovered.restore(previous); recovered.start(); await settle();
    assert.ok(recovered.cachedEpisode(owner.detail.id));
    assert.equal(recovered.episodePreferencesBlocked, false);
    assert.equal(writes(), 1, 'confirmed readback recovers without another mutation');
    recovered.stop();
});

test('Season invalidates cached shared preferences when an uncached episode in the same series changes', async () => {
    const r = await rig(); r.state.stop();
    const series = decodeItemDetail(r.catalog.route('GET', '/catalog/items/series%3As1', 'p-owner')?.body);
    const raw = r.catalog.route('GET', '/catalog/items/episode%3As1e11', 'p-owner')?.body as Record<string, unknown>;
    const path = '/catalog/items/episode%3As1e11?image_size=large';
    r.h.fake.script(path, { status: 200, body: { ...raw, effective_subtitle_mode: 'off', effective_show_forced_subtitles: false } });
    const state = new DetailsState({ ...series, id: 'series:s1-S1', type: 'season', seriesId: series.id }, r.h.core.session, () => undefined, async () => undefined);
    state.start(); await settle();
    assert.equal(state.nextEpisodeState?.subtitleIntent().kind, 'off');
    assert.equal(state.cachedEpisode('episode:s1e12'), undefined);
    state.stop();
    state.noteEpisodePreference('episode:s1e12', true, 'unrelated-series');
    state.start(); await settle();
    assert.equal(state.nextEpisodeState?.subtitleIntent().kind, 'off', 'unrelated series does not invalidate this visit');
    state.stop();
    state.noteEpisodePreference('episode:s1e12', true, series.id);
    r.h.fake.script(path, { status: 200, body: { ...raw, effective_subtitle_mode: 'auto', effective_show_forced_subtitles: false } });
    state.start(); await settle();
    assert.equal(state.nextEpisodeState?.subtitleIntent().kind, 'auto', 'shared preference invalidates the cached primary episode');
    state.stop();
});

async function rig() {
    const h = await connected();
    await signIn(h);
    const owner = (await h.core.profiles.list()).find(profile => profile.id === "p-owner");
    assert.ok(owner);
    h.core.profiles.select(owner);
    const catalog = new FakeDetails();
    catalog.progress.set(ID, 1200.5);
    h.fake.catalog = catalog;
    const detail = decodeItemDetail(catalog.route("GET", "/catalog/items/movie%3Am0001", "p-owner")?.body);
    const state = new DetailsState(detail, h.core.session, () => undefined, async () => undefined);
    state.start();
    await settle();
    const request = playChoices(detail)?.resume;
    assert.ok(request);
    const plays: PlayRequest[] = [];
    return { h, catalog, state, request, plays, handoff: (request: PlayRequest) => { plays.push(request); } };
}

test("series primary metadata is visit-owned, validates episode identity and retries explicitly", async () => {
    const r = await rig();
    r.state.stop();
    const raw = r.catalog.route("GET", "/catalog/items/series%3As1", "p-owner");
    assert.ok(raw);
    const detail = decodeItemDetail(raw.body);
    const state = new DetailsState(detail, r.h.core.session, () => undefined, async () => undefined);
    const target = (): ItemDetail | undefined => state.nextEpisode;
    const path = "/catalog/items/episode%3As1e11?image_size=large";
    const held = r.h.fake.hold(path, true);
    state.start();
    await settle();
    assert.equal(state.nextEpisodeLoading, true);
    state.stop();
    held.release();
    await settle();
    assert.equal(target(), undefined);
    assert.equal(state.nextEpisodeFailed, false);
    r.h.fake.script(path, { status: 200, body: raw.body });
    state.start();
    await settle();
    assert.equal(state.nextEpisodeFailed, true, "a series response cannot become the episode action");
    assert.equal(target(), undefined);
    state.loadNextEpisode();
    await settle();
    assert.equal(target()?.id, "episode:s1e11");
    assert.equal(state.nextEpisodeFailed, false);
    assert.equal(state.detail, detail, "episode preparation must not replace the series hero");
    const count = r.h.fake.requests.filter(request => request.path === path).length;
    state.stop(); state.start();
    await settle();
    assert.equal(r.h.fake.requests.filter(request => request.path === path).length, count, "ordinary return retains accepted metadata");
    state.stop();
});

for (const next of ["episode:s1e11", "episode:s1e12"]) test(`watched refresh reconciles primary episode ${next} and its cleared progress`, async () => {
    const r = await rig();
    r.state.stop();
    r.catalog.progress.set("episode:s1e11", 500);
    const reply = r.catalog.route("GET", "/catalog/items/series%3As1", "p-owner");
    assert.ok(reply);
    const state = new DetailsState(decodeItemDetail(reply.body), r.h.core.session, () => undefined, async () => undefined);
    state.start();
    await settle();
    const initial = state.nextEpisode;
    assert.ok(initial);
    assert.equal(playChoices(initial)?.resume?.startSeconds, 500);
    r.catalog.failNext("/catalog/items/series%3As1", { status: 200, body: { ...object(reply.body, "series"), play_content_id: next, user_state: { played: true }, user_data: { played: true } } });
    state.change("watched", true);
    await settle();
    assert.equal(state.changes.size, 0);
    const refreshed = state.nextEpisode;
    assert.ok(refreshed);
    assert.equal(refreshed.id, next);
    assert.equal(playChoices(refreshed)?.resume, undefined, "a watched mutation clears the old Resume/Start Over target");
    state.stop();
});

test("watched reconciliation replaces an older pending primary read within the same visit", async () => {
    const r = await rig();
    r.state.stop();
    r.catalog.progress.set("episode:s1e11", 500);
    const reply = r.catalog.route("GET", "/catalog/items/series%3As1", "p-owner");
    assert.ok(reply);
    const state = new DetailsState(decodeItemDetail(reply.body), r.h.core.session, () => undefined, async () => undefined);
    const held = r.h.fake.hold("/catalog/items/episode%3As1e11?image_size=large", true);
    state.start();
    await settle();
    assert.equal(state.nextEpisodeLoading, true);
    state.change("watched", true);
    await settle();
    const accepted = state.nextEpisode;
    assert.ok(accepted);
    assert.equal(playChoices(accepted)?.resume, undefined);
    held.release();
    await settle();
    assert.equal(state.nextEpisode, accepted, "the pre-mutation response cannot replace reconciled progress");
    state.stop();
});

test("Details reuses the per-file audio decoder and never invents omitted tracks", () => {
    const tracks = [{ default: false, embedded_title: "Dub", language: "ja", codec: "aac", channels: 2 }, { default: true, title: "Original" }];
    const raw = { ...fixture("get_catalog_item_ok"), versions: [{ file_id: "42", duration: 3000, audio_tracks: tracks, effective_audio_track_index: 1 }] };
    assert.deepEqual(decodeItemDetail(raw).versions[0]?.audio, decodeFileVersionTracks({ items: raw.versions })[0]?.audio);
    assert.deepEqual(decodeItemDetail({ ...raw, versions: [{ file_id: "42", duration: 3000 }] }).versions[0]?.audio, []);
    assert.throws(() => decodeItemDetail({ ...raw, versions: [{ file_id: "42", duration: 3000, audio_tracks: [{ language: "en" }] }] }), WireError);
});

test("visit audio survives identical refresh, resets for a changed inventory or file, and only an explicit version pins", async () => {
    const r = await rig();
    try {
        r.state.selectAudio(1);
        assert.equal(r.state.audioTrackId(), "file:42:audio:1");
        const refreshed = new DetailsState(r.state.detail, r.h.core.session, () => undefined, async () => undefined);
        refreshed.restore(r.state);
        assert.equal(refreshed.audioTrackId(), "file:42:audio:1");
        assert.equal(playChoices(refreshed.detail, refreshed.selectedFileId)?.fromStart.allowAlternateVersions, undefined);
        const changed = new DetailsState({ ...r.state.detail, versions: r.state.detail.versions.map(file => ({ ...file, audio: [...file.audio ?? []].reverse() })) }, r.h.core.session, () => undefined, async () => undefined);
        changed.restore(r.state);
        assert.equal(changed.audioTrackId(), undefined);
        r.state.select("43");
        assert.equal(r.state.audioTrackId(), undefined);
        assert.equal(playChoices(r.state.detail, r.state.selectedFileId)?.fromStart.allowAlternateVersions, false);
        r.state.selectAudio(1);
        assert.equal(r.state.audioTrackId(), "file:43:audio:1");
        r.state.select("42");
        assert.equal(r.state.audioTrackId(), undefined);
        await settle();
        assert.equal(r.h.fake.requests.some(req => req.method === "PUT" && req.path === "/audio-prefs/movie%3Am0001"), true);
        assert.equal(r.h.fake.requests.some(req => req.path.startsWith("/version-prefs/")), false, "version selection remains visit-only");
    } finally { r.state.stop(); }
});

test("fresh progress and fresh no-progress replace cached progress using the captured file and audio", async () => {
    for (const fresh of [2400.25, undefined]) {
        const r = await rig();
        try {
            r.catalog.progress.delete(ID);
            if (fresh !== undefined) r.catalog.progress.set(ID, fresh);
            const held = r.h.fake.hold(WATCH);
            const captured = { ...r.request, audioTrackId: "file:42:audio:1" };
            r.state.preparePlay(captured, r.h.clock, r.handoff);
            await settle();
            r.state.select("43");
            r.state.selectAudio(0);
            r.state.selectSubtitle("off");
            await settle();
            assert.equal(r.h.fake.requests.some(req => req.method === "PUT" && (req.path.startsWith("/audio-prefs/") || req.path.startsWith("/subtitle-prefs/"))), false, "preparation keeps the captured choices and cannot start an unsettled save");
            r.state.preparePlay({ ...r.request, fileId: "43" }, r.h.clock, r.handoff);
            assert.equal(r.state.preparingPlay, true);
            assert.deepEqual(r.plays, []);
            held.release();
            await settle();
            assert.deepEqual(r.plays, [{ ...captured, startSeconds: fresh ?? 0 }]);
            assert.equal(r.h.fake.requests.filter(req => req.path === WATCH).length, 1);
        } finally { r.state.stop(); }
    }
});

test("three-second watch bound uses confirmed cached progress once and ignores a late answer", async () => {
    const r = await rig();
    try {
        const held = r.h.fake.hold(WATCH, true);
        r.state.preparePlay(r.request, r.h.clock, r.handoff);
        await r.h.clock.advance(2999);
        assert.deepEqual(r.plays, []);
        await r.h.clock.advance(1);
        assert.deepEqual(r.plays, [r.request]);
        held.release();
        await settle();
        assert.deepEqual(r.plays, [r.request]);
    } finally { r.state.stop(); }
});

test("unavailable watch falls back; auth, not-found, protocol and malformed answers show retry without a handoff", async () => {
    for (const status of [501, 503, 401, 403, 404, 409, 422, 200]) {
        const r = await rig();
        try {
            const reply = status === 200 ? { status, body: { content_id: ID, type: "movie", versions: [] } } : problem(status, "unavailable", "Unavailable");
            r.h.fake.script(WATCH, reply, reply, reply);
            r.state.preparePlay(r.request, r.h.clock, r.handoff);
            await r.h.clock.advance(3000);
            if (status === 501 || status === 503) assert.deepEqual(r.plays, [r.request]);
            else { assert.deepEqual(r.plays, []); assert.deepEqual(r.state.failedPlay, r.request); }
        } finally { r.state.stop(); }
    }
});

test("route stop, profile change and sign-out cancel pending resume with no playback POST", async () => {
    for (const reason of ["route", "profile", "logout"]) {
        const r = await rig();
        const held = r.h.fake.hold(WATCH, true);
        try {
            r.state.preparePlay(r.request, r.h.clock, r.handoff);
            await settle();
            if (reason === "route") r.state.stop();
            else if (reason === "profile") r.h.core.profiles.clear();
            else await r.h.core.session.logout();
            held.release();
            await r.h.clock.advance(3000);
            assert.deepEqual(r.plays, []);
            assert.equal(r.h.fake.requests.some(req => req.path === "/playback/start"), false);
        } finally { held.release(); r.state.stop(); }
    }
});

test("fresh watch rejects wrong identity, missing file and invalid source seconds", () => {
    const base = { content_id: ID, type: "movie", versions: [{ file_id: "42", duration_seconds: 5400 }], user_data: { played: false, position_seconds: 12.5 } };
    assert.deepEqual(decodeResumePosition(base, ID, "42"), { position: 12.5, duration: 5400 });
    assert.deepEqual(decodeResumePosition({ ...base, user_data: { played: true, position_seconds: 12.5 } }, ID, "42"), { position: 12.5, duration: 5400 }, "rewatching a previously watched title retains fresh progress");
    for (const raw of [{ ...base, content_id: "other" }, { ...base, versions: [] }, { ...base, user_data: { played: false, position_seconds: -1 } }, { ...base, user_data: { played: false, position_seconds: NaN } }]) assert.throws(() => decodeResumePosition(raw, ID, "42"), WireError);
});

test("layout-only inventory changes reset an explicit audio choice while identical metadata retains it", async () => {
    const r = await rig();
    try {
        r.state.selectAudio(1);
        const same = new DetailsState(decodeItemDetail(r.catalog.route("GET", "/catalog/items/movie%3Am0001", "p-owner")?.body), r.h.core.session, () => undefined, async () => undefined);
        same.restore(r.state);
        assert.equal(same.audioTrackId(), "file:42:audio:1");
        const file = r.catalog.audioFiles.get("42");
        assert.ok(file);
        r.catalog.audioFiles.set("42", { ...file, audio: file.audio.map((track, index) => index === 1 ? { ...track, layout: "dual mono" } : track) });
        const changed = new DetailsState(decodeItemDetail(r.catalog.route("GET", "/catalog/items/movie%3Am0001", "p-owner")?.body), r.h.core.session, () => undefined, async () => undefined);
        changed.restore(r.state);
        assert.equal(changed.audioTrackId(), undefined, "changed server metadata invalidates the captured ordinal");
    } finally { r.state.stop(); }
});

test("fresh watch requires a nonnegative integer duration and accepts zero as unknown", () => {
    const raw = (duration: unknown) => ({ content_id: ID, type: "movie", versions: [{ file_id: "42", ...(duration === undefined ? {} : { duration_seconds: duration }) }], user_data: { played: false, position_seconds: 5398 } });
    for (const duration of [undefined, -1, 1.5, Infinity, NaN, "5400", null]) {
        assert.throws(() => decodeResumePosition(raw(duration), ID, "42"), WireError, `duration ${String(duration)}`);
    }
    assert.deepEqual(decodeResumePosition(raw(0), ID, "42"), { position: 5398, duration: 0 });
});

test("missing watch duration refuses near-end progress until a valid explicit retry", async () => {
    const r = await rig();
    try {
        r.h.fake.script(WATCH, { status: 200, body: { content_id: ID, type: "movie", versions: [{ file_id: "42" }], user_data: { played: false, position_seconds: 5398 } } });
        r.state.preparePlay(r.request, r.h.clock, r.handoff);
        await r.h.clock.advance(3000);
        assert.deepEqual(r.plays, [], "malformed duration cannot bypass the end margin or use cached fallback");
        assert.deepEqual(r.state.failedPlay, r.request);
        r.catalog.progress.set(ID, 5398);
        r.state.preparePlay(r.request, r.h.clock, r.handoff);
        await settle();
        assert.deepEqual(r.plays, [{ ...r.request, startSeconds: 0 }], "valid duration enforces the five-second end margin");
    } finally { r.state.stop(); }
});
