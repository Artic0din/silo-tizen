import assert from "node:assert/strict";
import { test } from "node:test";
import { audioPreferenceOperations } from "../../src/api/audioPreferenceOperations.ts";
import { decodeItemDetail } from "../../src/contracts/v2/catalog.ts";
import { fixture } from "./support/fakeSilo.ts";
import { PreplayAudioPreference } from "../../src/ui/preplayAudioPreference.ts";
import { DetailsState } from "../../src/ui/detailsState.ts";
import type { NativeSession } from "../../src/session/session.ts";
import type { RequestSpec } from "../../src/api/http.ts";
import { ApiError } from "../../src/api/errors.ts";
import { settle } from "./support/clock.ts";
import { systemClock } from "../../src/api/clock.ts";
import { decodeAudioTracks } from "../../src/contracts/v2/playback.ts";

test("audio metadata retains authored title, embedded title and layout independently", () => {
    const tracks = decodeAudioTracks({ audio_tracks: [{ default: true, title: "Display", embedded_title: "Authored", layout: "5.1" }] }, "version");
    assert.deepEqual(tracks[0], { isDefault: true, language: undefined, codec: undefined, channels: undefined, title: "Display", rawTitle: "Display", embeddedTitle: "Authored", layout: "5.1" });
});

function preferenceServer() {
    let stored: Record<string, unknown> | undefined;
    let release: (() => void) | undefined;
    let held: Promise<void> | undefined;
    let loseAnswer = false, failRead = false, failRefresh = false;
    const calls: { method: string; path: string; replay: boolean | undefined }[] = [];
    let authorityChanged: (() => void) | undefined;
    const session = { onAuthorityChange: (callback: () => void) => { authorityChanged = callback; return () => { authorityChanged = undefined; }; }, call: async <T>(spec: RequestSpec<T> & { replayAfterRefresh?: boolean }): Promise<T> => {
        calls.push({ method: spec.method, path: spec.path, replay: spec.replayAfterRefresh });
        const key = decodeURIComponent(spec.path.split("/").at(-1) ?? "");
        if (spec.method === "GET") {
            if (failRead) throw new Error("Read unavailable");
            if (stored === undefined) throw new ApiError({ kind: "http", status: 404, retryAfterSeconds: undefined });
            return spec.decode({ ...stored, series_id: key });
        }
        if (held !== undefined) await held;
        stored = spec.method === "DELETE" ? undefined : spec.body as Record<string, unknown>;
        if (loseAnswer) throw new Error("Delivery unknown");
        return spec.decode(undefined);
    } } as unknown as NativeSession;
    const owner = new PreplayAudioPreference(session, "series/a:b", () => undefined, async () => { if (failRefresh) throw new Error("Effective read unavailable"); });
    owner.start();
    return { owner, session, calls, changeProfile: () => authorityChanged?.(), hold: () => { held = new Promise<void>(resolve => { release = resolve; }); }, release: () => { release?.(); held = undefined; }, lose: (value: boolean) => { loseAnswer = value; }, failRead: (value: boolean) => { failRead = value; }, failRefresh: (value: boolean) => { failRefresh = value; } };
}

const track = { isDefault: false, language: "en", codec: "aac", channels: 2, title: "English", rawTitle: "English" };

test("rapid audio choices serialize and retain the latest explicit Auto", async () => {
    const r = preferenceServer();
    r.hold();
    r.owner.choose({ ordinal: 0, track });
    r.owner.choose({ ordinal: 1, track });
    r.owner.choose(undefined);
    await settle();
    assert.equal(r.owner.pending, true);
    assert.deepEqual(r.calls.map(call => call.method), ["PUT"]);
    r.release(); await settle();
    assert.deepEqual(r.calls.map(call => call.method), ["PUT", "GET", "DELETE", "GET"]);
    assert.equal(r.owner.pending, false);
    assert.equal(r.owner.failed, false);
    assert.ok(r.calls.filter(call => call.method !== "GET").every(call => call.replay === false));
    r.owner.stop();
});

test("uncertain audio writes require readback and never automatically replay", async () => {
    const r = preferenceServer();
    r.lose(true);
    r.owner.choose({ ordinal: 0, track }); await settle();
    assert.equal(r.owner.failed, true);
    assert.deepEqual(r.calls.map(call => call.method), ["PUT"]);
    r.failRead(true); r.owner.retry(); await settle();
    assert.equal(r.owner.failed, true);
    assert.deepEqual(r.calls.map(call => call.method), ["PUT", "GET"]);
    r.failRead(false); r.lose(false); r.owner.retry(); await settle();
    assert.equal(r.owner.failed, false);
    assert.equal(r.calls.filter(call => call.method === "PUT").length, 1);
    r.owner.stop();
});

test("failed effective readback blocks completion and restart is read-only", async () => {
    const r = preferenceServer();
    r.failRefresh(true); r.owner.choose({ ordinal: 0, track }); await settle();
    assert.equal(r.owner.failed, true);
    r.owner.stop(); r.failRefresh(false); r.owner.start(); await settle();
    assert.equal(r.owner.failed, false);
    assert.equal(r.calls.filter(call => call.method === "PUT").length, 1);
    r.owner.stop();
});

test("route stop fences late completion and retained return waits for the write", async () => {
    const r = preferenceServer();
    r.hold(); r.owner.choose({ ordinal: 0, track }); await settle();
    r.owner.stop(); r.owner.start(); await settle();
    assert.deepEqual(r.calls.map(call => call.method), ["PUT"]);
    assert.equal(r.owner.pending, true);
    assert.equal(r.owner.failed, false, "reconciliation must not expose a stale retry focus target");
    r.release(); await settle();
    assert.equal(r.owner.failed, false);
    assert.deepEqual(r.calls.map(call => call.method), ["PUT", "GET"]);
    r.owner.stop();
});

test("replacement Details audio owner inherits unresolved intent without replay", async () => {
    const r = preferenceServer();
    r.hold(); r.lose(true); r.owner.choose({ ordinal: 0, track }); await settle();
    r.owner.stop();
    const next = new PreplayAudioPreference(r.session, "series/a:b", () => undefined, async () => undefined);
    next.restore(r.owner); next.start(); await settle();
    assert.deepEqual(r.calls.map(call => call.method), ["PUT"]);
    assert.equal(next.pending, true);
    r.release(); await settle();
    assert.equal(next.failed, false);
    assert.deepEqual(r.calls.map(call => call.method), ["PUT", "GET"]);
    next.stop();
});

test("different Details owners for the same key cannot overtake a pending write", async () => {
    const r = preferenceServer();
    r.hold(); r.owner.choose({ ordinal: 0, track }); await settle();
    r.owner.stop();
    const next = new PreplayAudioPreference(r.session, "series/a:b", () => undefined, async () => undefined);
    next.start(); next.choose({ ordinal: 1, track }); await settle();
    assert.deepEqual(r.calls.map(call => call.method), ["PUT"]);
    r.release(); await settle();
    assert.deepEqual(r.calls.map(call => call.method), ["PUT", "PUT", "GET"]);
    assert.equal(next.failed, false);
    next.stop();
});

test("Details uses movie identity or nonempty series identity and blocks unsettled Play", async () => {
    for (const seriesId of [undefined, "", "series/a:b"]) {
        const r = preferenceServer();
        const detail = decodeItemDetail({ ...fixture("get_catalog_item_ok"), content_id: "movie/a:b", type: seriesId ? "episode" : "movie", series_id: seriesId, versions: [{ file_id: "f", duration: 100, audio_tracks: [{ default: false, language: "en" }] }] });
        const state = new DetailsState(detail, r.session, () => undefined, async () => undefined);
        state.start("personal");
        state.selectAudio(0); await settle();
        assert.equal(r.calls.find(call => call.method === "PUT")?.path, seriesId ? "/audio-prefs/series%2Fa%3Ab" : "/audio-prefs/movie%2Fa%3Ab");
        // The deliberately unavailable effective catalog read keeps this candidate unsettled.
        assert.equal(state.audioPreference.failed, true);
        let played = false;
        state.preparePlay({ contentId: detail.id, title: detail.title, fileId: "f", startSeconds: 0 }, systemClock, () => { played = true; });
        assert.equal(played, false);
        state.stop(); r.owner.stop();
    }
});

test("profile changes discard queued audio intent and fence readback", async () => {
    const r = preferenceServer();
    const detail = decodeItemDetail({ ...fixture("get_catalog_item_ok"), versions: [{ file_id: "f", duration: 100, audio_tracks: [{ default: false, language: "en" }, { default: true, language: "ja" }] }] });
    const state = new DetailsState(detail, r.session, () => undefined, async () => undefined);
    state.start("personal"); await settle();
    r.hold(); state.selectAudio(0); state.selectAudio(1); await settle();
    r.changeProfile(); r.release(); await settle();
    assert.equal(r.calls.filter(call => call.method === "PUT").length, 1);
    assert.equal(state.audioPreference.failed, true);
    state.stop(); r.owner.stop();
});

test("fresh effective audio seeds selectors, while Auto keeps visit intent", async () => {
    const r = preferenceServer();
    const detail = decodeItemDetail({ ...fixture("get_catalog_item_ok"), versions: [{ file_id: "f", duration: 100, effective_audio_track_index: 1, audio_tracks: [{ default: false, language: "en" }, { default: true, language: "ja" }] }] });
    const state = new DetailsState(detail, r.session, () => undefined, async () => undefined);
    assert.equal(state.audioTrackId(), "file:f:audio:1");
    state.selectAudio(undefined);
    assert.equal(state.audioTrackId(), undefined);
    const refreshed = new DetailsState(detail, r.session, () => undefined, async () => undefined);
    refreshed.restore(state);
    assert.equal(refreshed.audioTrackId(), undefined);
    assert.equal(r.calls.length, 0, "ordinary Auto preparation and selecting versions never write");
    state.stop(); r.owner.stop();
});

test("preplay audio persistence keeps opaque keys and the full signature", () => {
    const detail = decodeItemDetail({ ...fixture("get_catalog_item_ok"), versions: [{ file_id: "f", duration: 100, audio_tracks: [{ default: true, title: "English", embedded_title: "Surround", layout: "5.1", channels: 6, language: "en", codec: "eac3" }] }] });
    const track = detail.versions[0]?.audio?.[0];
    assert.ok(track);
    const put = audioPreferenceOperations.write("movie/a:b", { ordinal: 0, track });
    assert.equal(put.path, "/audio-prefs/movie%2Fa%3Ab");
    assert.equal(put.method, "PUT");
    assert.equal(put.retry, "never");
    assert.deepEqual(put.body, { audio_track_index: 0, audio_language: "en", track_signature: { language: "en", title: "English", embedded_title: "Surround", codec: "eac3", layout: "5.1", channels: 6, default: true } });
    const clear = audioPreferenceOperations.write("series/a:b", undefined);
    assert.equal(clear.method, "DELETE");
    assert.equal(clear.body, undefined);
    assert.equal(clear.path, "/audio-prefs/series%2Fa%3Ab");
});
