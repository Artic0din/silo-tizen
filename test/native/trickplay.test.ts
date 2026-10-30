import assert from "node:assert/strict";
import { test } from "node:test";
import { decodePlaybackCapabilities } from "../../src/contracts/v2/playback.ts";
import { fixture } from "./support/fakeSilo.ts";
import { decodeTrickplay, decodeTrickplayFiles, thumbnailAt } from "../../src/contracts/v2/trickplay.ts";
import { operations } from "../../src/api/operations.ts";
import { PlaybackController, type PlaybackView } from "../../src/player/controller.ts";
import { SeekThumbnails, type ThumbnailSheetLoader } from "../../src/player/seekThumbnails.ts";
import { connected, signIn } from "./support/harness.ts";
import { FakePlayback } from "./support/fakePlayback.ts";
import { FakeTrickplay } from "./support/fakeTrickplay.ts";
import { FakeAVPlay } from "./support/fakeAVPlay.ts";

test("playback capability retains the server's trickplay availability feature", () => {
    const base = fixture("playback_capability_available");
    const raw = { ...base, features: ["trickplay_v1"] };
    assert.deepEqual(decodePlaybackCapabilities(raw), {
        state: base.state, allowed: base.allowed, installationId: base.installation_id,
        protocolVersions: base.protocol_versions, features: ["trickplay_v1"],
    });
});

const ORIGIN = "https://silo.example.test:9443";
const rawManifest = (): Record<string, unknown> => fixture("get_watch_trickplay_ok");
const decode = (raw: unknown) => decodeTrickplay(raw, "42", ORIGIN);

test("pinned JPEG layout uses source intervals, sheet boundaries and the final valid cell", () => {
    const manifest = decode(rawManifest());
    for (const [seconds, index, sheet, x, y] of [[0, 0, 0, 0, 0], [9.999, 0, 0, 0, 0], [10, 1, 0, 300, 0],
        [999.999, 99, 0, 2700, 1134], [1000, 100, 1, 0, 0], [1235, 123, 1, 900, 252],
        [10190, 1019, 10, 2700, 126], [10200, 1019, 10, 2700, 126], [Number.MAX_VALUE, 1019, 10, 2700, 126]]) {
        assert.ok(seconds !== undefined);
        const tile = thumbnailAt(manifest, seconds);
        assert.ok(tile !== undefined);
        assert.deepEqual([tile.index, tile.sheet, tile.x, tile.y, tile.width, tile.height, tile.sheetWidth, tile.sheetHeight], [index, sheet, x, y, 300, 126, 3000, 1260]);
        assert.ok(tile.url.startsWith(`${ORIGIN}/api/v2/artwork/`));
    }
    for (const seconds of [-1, NaN, Infinity]) assert.equal(thumbnailAt(manifest, seconds), undefined);
});

test("manifest indexes sort, root-relative URLs keep the port and cross-origin signatures stay opaque", () => {
    const raw = rawManifest();
    assert.ok(Array.isArray(raw.sheets));
    const absolute = "https://storage.example.test:8443/a%2Fb.jpg?sig=a%2Fb%2B%3D&exp=2";
    raw.sheets[1] = { index: 1, url: absolute };
    raw.sheets.reverse();
    const value = decode(raw);
    assert.equal(value.sheets[1], absolute);
    assert.equal(value.sheets[0], `${ORIGIN}/api/v2/artwork/trickplay/42/9913/0.9913.jpg?exp=1767409445&sig=a`);
});

for (const field of ["interval_ms", "thumbnail_width", "thumbnail_height", "tile_columns", "tile_rows", "thumbnail_count"]) {
    test(`manifest rejects invalid ${field}`, () => {
        for (const value of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "10", null]) assert.throws(() => decode({ ...rawManifest(), [field]: value }));
    });
}

test("manifest rejects overflow, mismatched file, bad expiry and incomplete/duplicate/holey indexes", () => {
    for (const bad of [{ tile_columns: Number.MAX_SAFE_INTEGER }, { thumbnail_count: Number.MAX_SAFE_INTEGER }, { file_id: "43" },
        { expires_at: "yesterday" }, { expires_at: "2026-02-30T03:04:05Z" }, { expires_at: "2026-01-02T25:04:05Z" },
        { sheets: [] }, { sheets: [{ index: 0, url: "/s.jpg?sig=a" }] }]) assert.throws(() => decode({ ...rawManifest(), ...bad }));
    for (const index of [0, 12, -1, 1.5]) {
        const raw = rawManifest();
        assert.ok(Array.isArray(raw.sheets));
        raw.sheets[1] = { index, url: "/s.jpg?sig=a" };
        assert.throws(() => decode(raw));
    }
});

for (const url of ["http://storage.example.test/a.jpg?sig=a", "//storage.example.test/a.jpg", "data:image/jpeg;base64,AA==", "a.jpg", "https://user:pass@storage.example.test/a.jpg", "/a.jpg#fragment", "/\\evil.example.test/a.jpg", "https:/storage.example.test/a.jpg", "https:storage.example.test/a.jpg"]) {
    test(`manifest rejects unsupported signed URL ${url.split(":")[0]}`, () => {
        const raw = rawManifest();
        assert.ok(Array.isArray(raw.sheets));
        raw.sheets[0] = { index: 0, url };
        assert.throws(() => decode(raw));
    });
}

test("watch state explicitly opts files in; catalog fields and truthy strings cannot enable thumbnails", () => {
    assert.deepEqual(decodeTrickplayFiles(fixture("get_watch_state_ok")), []);
    assert.deepEqual(decodeTrickplayFiles({ versions: [{ file_id: "42" }, { file_id: "43", trickplay_available: true }, { file_id: "44", trickplay_available: false }] }), ["43"]);
    assert.throws(() => decodeTrickplayFiles({ versions: [{ file_id: "42", trickplay_available: "true" }] }));
    assert.throws(() => decodeTrickplayFiles(fixture("list_catalog_item_versions_ok")));
    assert.deepEqual(decodePlaybackCapabilities({ ...fixture("playback_capability_available"), features: undefined }).features, []);
    assert.throws(() => decodePlaybackCapabilities({ ...fixture("playback_capability_available"), features: [1] }));
});

test("typed operations encode the item and effective file exactly once", () => {
    assert.equal(operations.watchTrickplay("movie:/one", "file/42", ORIGIN).path, "/watch/movie%3A%2Fone/trickplay?file_id=file%2F42");
    assert.equal(operations.watchTrickplayFiles("movie:/one", "43").path, "/watch/movie%3A%2Fone?file_id=43");
});

async function rig(enabled = true) {
    const h = await connected();
    await signIn(h);
    const profiles = await h.core.profiles.list();
    const owner = profiles.find((profile) => profile.id === "p-owner");
    assert.ok(owner !== undefined);
    h.core.profiles.select(owner);
    const playback = new FakePlayback(h.fake);
    const previews = new FakeTrickplay(h.fake, h.clock);
    h.fake.script("/playback/capabilities", { status: 200, body: { ...fixture("playback_capability_available"), features: enabled ? ["trickplay_v1"] : [] } });
    const avplay = new FakeAVPlay();
    let serial = 0;
    const controller = new PlaybackController({ session: h.core.session, avplay, clock: h.clock, randomBytes: (bytes) => bytes.fill(++serial),
        device: { model: "synthetic", appVersion: "0.0.1" }, exits: { onBack() {}, onEnd() {}, onError() {} } });
    const views: PlaybackView[] = [];
    controller.subscribe((view) => views.push(view));
    const provider = new SeekThumbnails(h.core.session, h.clock, "movie-1", "42");
    return { h, playback, previews, avplay, controller, views, provider };
}

type Rig = Awaited<ReturnType<typeof rig>>;
const NO_IMAGE: ThumbnailSheetLoader = async () => undefined;
const liveSignal = (): AbortSignal => new AbortController().signal;

async function play(r: Rig): Promise<void> {
    r.controller.play({ contentId: "movie-1", fileId: "42", title: "Synthetic film", startSeconds: 0 });
    await r.h.clock.advance(0);
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    if (r.avplay.calls[r.avplay.calls.length - 1]?.startsWith("seekTo") === true) {
        r.avplay.finishSeek();
        await r.h.clock.advance(0);
    }
    assert.equal(r.avplay.state, "PLAYING");
}

test("both gates and the effective fallback file control preview requests, never planning or seeking", async () => {
    for (const enabled of [false, true]) {
        const r = await rig(enabled);
        r.playback.next.push({ effectiveFileId: "43" });
        r.previews.files.set("42", false);
        r.previews.files.set("43", enabled);
        await play(r);
        assert.equal(r.previews.watchReads, 0, "starting playback does not fetch previews");
        const before = r.avplay.calls.slice();
        const tile = await r.controller.seekThumbnail(1235, liveSignal(), NO_IMAGE);
        assert.equal(tile?.index, enabled ? 123 : undefined);
        assert.equal(r.previews.watchReads, enabled ? 1 : 0);
        assert.equal(r.previews.manifestReads, enabled ? 1 : 0);
        if (enabled) assert.match(r.h.fake.requests.find((request) => request.path.includes("/trickplay?"))?.path ?? "", /file_id=43$/);
        assert.deepEqual(r.avplay.calls, before, "decoration must never seek/pause/replan");
        assert.equal(r.h.fake.requests.filter((request) => request.path.endsWith("/replan")).length, 0);
        r.controller.destroy();
        r.provider.destroy();
    }
    const r = await rig();
    r.previews.files.set("42", false);
    await play(r);
    assert.equal(await r.controller.seekThumbnail(10, liveSignal(), NO_IMAGE), undefined);
    assert.equal(r.previews.watchReads, 1);
    assert.equal(r.previews.manifestReads, 0, "capability alone is insufficient");
    r.controller.destroy();
});

test("manifest reads retain captured profile, bearer and stable device headers through the existing session", async () => {
    const r = await rig();
    const profiles = await r.h.core.profiles.list();
    const locked = profiles.find((profile) => profile.id !== "p-owner");
    assert.ok(locked !== undefined);
    const selection = r.h.core.profiles.select(locked);
    assert.equal(selection.status, "pin_required");
    const pin = await r.h.core.profiles.verifyPin(locked.id, "2468");
    assert.equal(pin.status, "verified");
    const provider = new SeekThumbnails(r.h.core.session, r.h.clock, "movie-1", "42");
    const tile = await provider.load(0, liveSignal(), NO_IMAGE);
    assert.ok(tile !== undefined);
    const reads = r.h.fake.requests.filter((request) => request.path.startsWith("/watch/"));
    assert.equal(reads.length, 2);
    for (const request of reads) {
        assert.equal(request.headers["x-profile-id"], locked.id);
        assert.ok(request.headers["authorization"]?.startsWith("Bearer "));
        assert.ok(request.headers["x-profile-token"]);
        assert.ok(request.headers["x-silo-device-id"]);
        assert.equal(request.headers["x-silo-device-id"], reads[0]?.headers["x-silo-device-id"]);
    }
    provider.destroy();
    r.controller.destroy();
});

test("manifest reuse, near-expiry renewal and already-expired responses are bounded", async () => {
    const r = await rig();
    assert.ok(await r.provider.load(0, liveSignal(), NO_IMAGE));
    assert.ok(await r.provider.load(10, liveSignal(), NO_IMAGE));
    assert.equal(r.previews.manifestReads, 1);
    await r.h.clock.advance(90001);
    assert.ok(await r.provider.load(1000, liveSignal(), NO_IMAGE));
    assert.equal(r.previews.manifestReads, 2);
    r.provider.destroy();
    const expired = new SeekThumbnails(r.h.core.session, r.h.clock, "movie-1", "42");
    r.previews.manifests.push({ status: 200, body: { ...r.previews.manifest(), expires_at: new Date(r.h.clock.now() - 1).toISOString() } });
    let imageReads = 0;
    assert.equal(await expired.load(0, liveSignal(), async () => { imageReads++; }), undefined);
    assert.equal(imageReads, 0);
    expired.destroy();
    r.controller.destroy();
});

for (const status of [401, 403, 0]) {
    test(`sheet failure ${status} renews once, then backs off without changing playback`, async () => {
        const r = await rig();
        let images = 0;
        const failing: ThumbnailSheetLoader = async () => { images++; throw new Error(`synthetic image failure ${status}`); };
        assert.equal(await r.provider.load(1235, liveSignal(), failing), undefined);
        assert.equal(images, 2);
        assert.equal(r.previews.manifestReads, 2);
        assert.equal(await r.provider.load(1245, liveSignal(), failing), undefined);
        assert.equal(images, 2, "new targets must not retry during backoff");
        await r.h.clock.advance(30001);
        assert.ok(await r.provider.load(1235, liveSignal(), NO_IMAGE));
        assert.equal(r.previews.manifestReads, 3);
        r.provider.destroy();
        r.controller.destroy();
    });
}

test("a refused old sheet succeeds with the renewed opaque signature", async () => {
    const r = await rig();
    const urls: string[] = [];
    const tile = await r.provider.load(1235, liveSignal(), async (value) => {
        urls.push(value.url);
        if (urls.length === 1) throw new Error("Expired signature");
    });
    assert.equal(tile?.index, 123);
    assert.equal(urls.length, 2);
    assert.notEqual(urls[0], urls[1]);
    r.provider.destroy();
    r.controller.destroy();
});

for (const status of [404, 503]) {
    test(`manifest ${status} keeps seeking usable and permits a later retry`, async () => {
        const r = await rig();
        await play(r);
        r.previews.manifests.push({ status }, { status });
        const pending = r.controller.seekThumbnail(1235, liveSignal(), NO_IMAGE);
        await r.h.clock.advance(1000);
        assert.equal(await pending, undefined);
        assert.equal(r.previews.manifestReads, status === 503 ? 2 : 1);
        r.previews.manifests.length = 0;
        r.controller.seekToSeconds(1235);
        assert.equal(r.avplay.calls[r.avplay.calls.length - 1], "seekTo 1235000");
        r.avplay.finishSeek();
        await r.h.clock.advance(0);
        assert.ok(await r.controller.seekThumbnail(1245, liveSignal(), NO_IMAGE));
        r.controller.destroy();
    });
}

test("late old target and explicit cancellation cannot publish or poison the next target", async () => {
    const r = await rig();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const target = new AbortController();
    const old = r.provider.load(0, target.signal, async () => held);
    await r.h.clock.advance(0);
    const next = await r.provider.load(1235, liveSignal(), NO_IMAGE);
    assert.equal(next?.index, 123);
    release();
    assert.equal(await old, undefined);
    const canceled = new AbortController();
    const hold = r.h.fake.hold("/watch/movie-1/trickplay", true);
    r.provider.destroy();
    const fresh = new SeekThumbnails(r.h.core.session, r.h.clock, "movie-1", "42");
    const pending = fresh.load(10, canceled.signal, NO_IMAGE);
    await r.h.clock.advance(0);
    canceled.abort();
    hold.release();
    assert.equal(await pending, undefined);
    assert.ok(await fresh.load(20, liveSignal(), NO_IMAGE));
    fresh.destroy();
    r.controller.destroy();
});

for (const end of ["cancel", "file", "profile", "background", "exit", "quality", "physical-seek"] as const) {
    test(`${end} invalidates a late thumbnail without any preview seek`, async () => {
        const r = await rig();
        r.playback.next.push({ availableQualities: [{ label: "720p", bitrate_kbps: 4000, preserves_source: false }] });
        await play(r);
        const seeksBefore = r.avplay.calls.filter((call) => call.startsWith("seekTo")).length;
        const hold = r.h.fake.hold("/watch/movie-1/trickplay", true);
        const signal = new AbortController();
        let images = 0;
        const pending = r.controller.seekThumbnail(1235, signal.signal, async () => { images++; });
        await r.h.clock.advance(0);
        if (end === "cancel") signal.abort();
        else if (end === "file") r.controller.play({ contentId: "movie-1", fileId: "43", title: "Other synthetic file", startSeconds: 0 });
        else if (end === "profile") r.h.core.profiles.clear();
        else if (end === "background") r.controller.background();
        else if (end === "exit") r.controller.back();
        else if (end === "quality") r.controller.selectQuality("720p");
        else r.controller.seekBy(10);
        if (end === "quality" || end === "physical-seek") {
            const reads = r.previews.manifestReads;
            assert.equal(await r.controller.seekThumbnail(1245, liveSignal(), NO_IMAGE), undefined);
            assert.equal(r.previews.manifestReads, reads, "a preview cannot bypass the quality or physical seek barrier");
        }
        hold.release();
        await r.h.clock.advance(0);
        assert.equal(await pending, undefined);
        assert.equal(images, 0);
        assert.equal(r.avplay.calls.filter((call) => call.startsWith("seekTo")).length - seeksBefore, end === "physical-seek" ? 1 : 0);
        if (end === "physical-seek") r.avplay.finishSeek();
        r.controller.destroy();
        await r.h.clock.advance(0);
    });
}
