import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeCatalogSubtitles } from "../../src/contracts/v2/preplaySubtitles.ts";
import { subtitlePreferenceOperations } from "../../src/api/subtitlePreferenceOperations.ts";
import { PreplayTrackPreference } from "../../src/ui/preplayTrackPreference.ts";
import { DetailsState } from "../../src/ui/detailsState.ts";
import { decodeItemDetail } from "../../src/contracts/v2/catalog.ts";
import { fixture } from "./support/fakeSilo.ts";
import type { NativeSession } from "../../src/session/session.ts";
import type { RequestSpec } from "../../src/api/http.ts";
import { ApiError } from "../../src/api/errors.ts";
import { settle } from "./support/clock.ts";
import { systemClock } from "../../src/api/clock.ts";

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
    const owner = new PreplayTrackPreference(subtitlePreferenceOperations, session, "series/a:b", () => undefined, async () => { if (failRefresh) throw new Error("Effective read unavailable"); });
    owner.start();
    return { owner, session, calls, changeProfile: () => authorityChanged?.(), hold: () => { held = new Promise<void>(resolve => { release = resolve; }); }, release: () => { release?.(); held = undefined; }, lose: (value: boolean) => { loseAnswer = value; }, failRead: (value: boolean) => { failRead = value; }, failRefresh: (value: boolean) => { failRefresh = value; } };
}

const track = { source: "embedded" as const, selectionIndex: 97, externalPath: "", forced: false, hearingImpaired: false, language: "en", codec: "srt", label: "English" };

test("rapid subtitle choices serialize and retain the latest explicit Auto", async () => {
    const r = preferenceServer();
    r.hold();
    r.owner.choose({ track });
    r.owner.choose("off");
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

test("uncertain subtitle writes require readback and never automatically replay", async () => {
    const r = preferenceServer();
    r.lose(true);
    r.owner.choose({ track }); await settle();
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
    r.failRefresh(true); r.owner.choose({ track }); await settle();
    assert.equal(r.owner.failed, true);
    r.owner.stop(); r.failRefresh(false); r.owner.start(); await settle();
    assert.equal(r.owner.failed, false);
    assert.equal(r.calls.filter(call => call.method === "PUT").length, 1);
    r.owner.stop();
});

test("route stop fences late completion and retained return waits for the write", async () => {
    const r = preferenceServer();
    r.hold(); r.owner.choose({ track }); await settle();
    r.owner.stop(); r.owner.start(); await settle();
    assert.deepEqual(r.calls.map(call => call.method), ["PUT"]);
    assert.equal(r.owner.pending, true);
    assert.equal(r.owner.failed, false, "reconciliation must not expose a stale retry focus target");
    r.release(); await settle();
    assert.equal(r.owner.failed, false);
    assert.deepEqual(r.calls.map(call => call.method), ["PUT", "GET"]);
    r.owner.stop();
});

test("replacement Details subtitle owner inherits unresolved intent without replay", async () => {
    const r = preferenceServer();
    r.hold(); r.lose(true); r.owner.choose({ track }); await settle();
    r.owner.stop();
    const next = new PreplayTrackPreference(subtitlePreferenceOperations, r.session, "series/a:b", () => undefined, async () => undefined);
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
    r.hold(); r.owner.choose({ track }); await settle();
    r.owner.stop();
    const next = new PreplayTrackPreference(subtitlePreferenceOperations, r.session, "series/a:b", () => undefined, async () => undefined);
    next.start(); next.choose("off"); await settle();
    assert.deepEqual(r.calls.map(call => call.method), ["PUT"]);
    r.release(); await settle();
    assert.deepEqual(r.calls.map(call => call.method), ["PUT", "PUT", "GET"]);
    assert.equal(next.failed, false);
    next.stop();
});

test("Details uses movie identity or nonempty series identity and blocks unsettled Play", async () => {
    for (const seriesId of [undefined, "", "series/a:b"]) {
        const r = preferenceServer();
        const detail = decodeItemDetail({ ...fixture("get_catalog_item_ok"), content_id: "movie/a:b", type: seriesId ? "episode" : "movie", series_id: seriesId, versions: [{ file_id: "f", duration: 100, subtitle_tracks: [{ default: false, language: "en" }] }] });
        const state = new DetailsState(detail, r.session, () => undefined, async () => undefined);
        state.start("personal");
        state.selectSubtitle(0); await settle();
        assert.equal(r.calls.find(call => call.method === "PUT")?.path, seriesId ? "/subtitle-prefs/series%2Fa%3Ab" : "/subtitle-prefs/movie%2Fa%3Ab");
        // The deliberately unavailable effective catalog read keeps this candidate unsettled.
        assert.equal(state.subtitlePreference.failed, true);
        let played = false;
        state.preparePlay({ contentId: detail.id, title: detail.title, fileId: "f", startSeconds: 0 }, systemClock, () => { played = true; });
        assert.equal(played, false);
        state.stop(); r.owner.stop();
    }
});

test("profile changes discard queued subtitle intent and fence readback", async () => {
    const r = preferenceServer();
    const detail = decodeItemDetail({ ...fixture("get_catalog_item_ok"), versions: [{ file_id: "f", duration: 100, subtitle_tracks: [{ default: false, language: "en" }, { default: true, language: "ja" }] }] });
    const state = new DetailsState(detail, r.session, () => undefined, async () => undefined);
    state.start("personal"); await settle();
    r.hold(); state.selectSubtitle(0); state.selectSubtitle("off"); await settle();
    r.changeProfile(); r.release(); await settle();
    assert.equal(r.calls.filter(call => call.method === "PUT").length, 1);
    assert.equal(state.subtitlePreference.failed, true);
    state.stop(); r.owner.stop();
});

test("subtitle preference payload preserves stream identity, external basename and signature without forced override", () => {
    for (const external of [false, true]) {
        const [track] = decodeCatalogSubtitles({ subtitle_tracks: [{ index: 97, external, file_name: "Movie.es.srt", language: "es", codec: "srt", title: "Spanish", forced: true, hearing_impaired: true }] }, "file");
        assert.ok(track);
        const put = subtitlePreferenceOperations.write("movie/a:b", { track });
        assert.equal(put.path, "/subtitle-prefs/movie%2Fa%3Ab");
        assert.equal(put.method, "PUT");
        assert.equal(put.retry, "never");
        assert.deepEqual(put.body, { subtitle_track_index: 97, subtitle_language: "es", external_subtitle_path: external ? "Movie.es.srt" : "", subtitle_mode: "always", track_signature: { source: external ? "external" : "embedded", language: "es", codec: "srt", label: "Spanish", forced: true, hearing_impaired: true } });
    }
    const embedded = decodeCatalogSubtitles({ subtitle_tracks: [{}] }, "file")[0];
    const external = decodeCatalogSubtitles({ subtitle_tracks: [{ external: true }] }, "file")[0];
    assert.equal(embedded?.selectionIndex, 0);
    assert.equal(external?.selectionIndex, undefined);
    assert.equal(subtitlePreferenceOperations.write("s", "off").body?.subtitle_track_index, -1);
    assert.deepEqual(subtitlePreferenceOperations.write("s", "off").body, { subtitle_track_index: -1, subtitle_language: "", external_subtitle_path: "", subtitle_mode: "off" });
    assert.equal(subtitlePreferenceOperations.write("s", undefined).method, "DELETE");
    assert.equal(subtitlePreferenceOperations.write("s", undefined).body, undefined);
});

test("effective subtitle seed follows Apple scoring and forced Off policy while explicit Auto survives reload", () => {
    const r = preferenceServer();
    const raw = { ...fixture("get_catalog_item_ok"), effective_subtitle_mode: "always", effective_show_forced_subtitles: false, effective_subtitle_track_signature: { source: "embedded", language: "en", label: "Signs", forced: false, hearing_impaired: false }, versions: [{ file_id: "f", duration: 100, subtitle_tracks: [{ index: 97, language: "en", title: "English Signs", codec: "srt" }] }] };
    const detail = decodeItemDetail(raw);
    const state = new DetailsState(detail, r.session, () => undefined, async () => undefined);
    const seeded = state.subtitleIntent();
    assert.equal(seeded.kind, "track");
    assert.equal(seeded.kind === "track" && seeded.saved, true, "a saved preference is marked so an unplayable row falls back instead of ending in Off");
    state.selectSubtitle(undefined);
    const refreshed = new DetailsState(detail, r.session, () => undefined, async () => undefined);
    refreshed.restore(state);
    assert.equal(refreshed.subtitleIntent().kind, "auto");
    for (const forced of [false, true]) {
        const off = new DetailsState(decodeItemDetail({ ...raw, effective_subtitle_mode: "off", effective_show_forced_subtitles: forced }), r.session, () => undefined, async () => undefined);
        assert.equal(off.subtitleIntent().kind, forced ? "auto" : "off");
    }
    assert.equal(r.calls.length, 0, "effective defaults and inactive selector changes do not write");
    r.owner.stop();
});

test("external subtitle without a stream index stays on the visit and is not written as Off", async () => {
    const r = preferenceServer();
    const detail = decodeItemDetail({ ...fixture("get_catalog_item_ok"), content_id: "movie/a:b", type: "movie", versions: [{ file_id: "f", duration: 100, subtitle_tracks: [{ external: true, file_name: "Movie.es.srt", language: "es", title: "Spanish" }] }] });
    const state = new DetailsState(detail, r.session, () => undefined, async () => undefined);
    state.start("personal");
    state.selectSubtitle(0);
    await settle();
    const picked = state.subtitleIntent();
    assert.equal(picked.kind, "track");
    assert.equal(picked.kind === "track" && picked.saved, undefined, "a pick made on Details is explicit, not a saved preference");
    assert.equal(r.calls.filter(call => call.method !== "GET").length, 0);
    state.stop();
    r.owner.stop();
});

test("subtitle confirmation accepts server omission of zero-value signature strings", () => {
    const [empty] = decodeCatalogSubtitles({ subtitle_tracks: [{ language: "", codec: "", title: "" }] }, "file");
    assert.ok(empty);
    const actual = subtitlePreferenceOperations.read("s").decode({ series_id: "s", subtitle_track_index: 0, subtitle_mode: "always", track_signature: { source: "embedded", forced: false, hearing_impaired: false } });
    assert.equal(subtitlePreferenceOperations.matches(actual, { track: empty }), true);
});

test("subtitle signature keeps an authored empty title instead of substituting the embedded title", () => {
    const [track] = decodeCatalogSubtitles({ subtitle_tracks: [{ title: "", embedded_title: "Embedded" }] }, "file");
    assert.equal(track?.label, "");
});

test("duplicate catalog signature seeds stay Auto instead of creating an ambiguous explicit playback choice", () => {
    const r = preferenceServer();
    const track = { language: "en", codec: "srt", title: "English" };
    const detail = decodeItemDetail({ ...fixture("get_catalog_item_ok"), effective_subtitle_mode: "always", effective_subtitle_track_signature: { source: "embedded", ...track, label: "English" }, versions: [{ file_id: "f", duration: 100, subtitle_tracks: [{ ...track, index: 2 }, { ...track, index: 3 }] }] });
    const state = new DetailsState(detail, r.session, () => undefined, async () => undefined);
    assert.equal(state.subtitleIntent().kind, "auto");
    r.owner.stop();
});
