import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeItemDetail, decodeResumePosition, type ItemDetail } from "../../src/contracts/v2/catalog.ts";
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

test("attempt-only audio survives identical refresh, resets for a changed inventory or file, and only an explicit version pins", async () => {
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
        assert.equal(r.h.fake.requests.some(req => req.method === "PUT" || req.method === "DELETE"), false);
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
