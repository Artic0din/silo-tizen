// Audio and subtitle selection through the one playback owner: every choice is a server
// track_change replan naming the server's own track identity, never an AVPlay track index.
// The fake server applies the pinned server's track rules (support/fakePlayback.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFileVersionTracks, decodePlaybackDecision, decodePlaybackDefaults } from "../../src/contracts/v2/playback.ts";
import { PlaybackController, type PlaybackView, type PlayRequest, type TrackView } from "../../src/player/controller.ts";
import { FakeAVPlay } from "./support/fakeAVPlay.ts";
import { FakeCatalog } from "./support/fakeCatalog.ts";
import { operations } from "../../src/api/operations.ts";
import { FakePlayback } from "./support/fakePlayback.ts";
import { fixture, problem, type RecordedRequest } from "./support/fakeSilo.ts";
import { connected, type Harness, signIn } from "./support/harness.ts";

const MOVIE: PlayRequest = { contentId: "movie-1", fileId: "42", title: "Movie", startSeconds: 12.5 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Rig {
    readonly h: Harness;
    readonly server: FakePlayback;
    readonly avplay: FakeAVPlay;
    readonly controller: PlaybackController;
    readonly exits: string[];
    readonly views: PlaybackView[];
}

async function rig(): Promise<Rig> {
    const h = await connected();
    await signIn(h);
    const owner = (await h.core.profiles.list()).find((profile) => profile.id === "p-owner");
    assert.ok(owner !== undefined);
    h.core.profiles.select(owner);
    const server = new FakePlayback(h.fake);
    const avplay = new FakeAVPlay();
    const exits: string[] = [];
    let serial = 0;
    const controller = new PlaybackController({
        session: h.core.session,
        avplay,
        clock: h.clock,
        randomBytes: (bytes) => bytes.fill(++serial),
        device: { model: "QN55Q60AAFXZA", appVersion: "0.1.0" },
        exits: {
            onBack: () => exits.push("back"),
            onEnd: (reason) => exits.push(`end:${reason}`),
            onError: (error) => exits.push(`error:${error.kind}`),
        },
    });
    const views: PlaybackView[] = [];
    controller.subscribe((view) => views.push(view));
    return { h, server, avplay, controller, exits, views };
}

function requests(h: Harness, suffix: string): RecordedRequest[] {
    return h.fake.requests.filter((request) => request.path.endsWith(suffix));
}

function replans(h: Harness): Record<string, unknown>[] {
    return requests(h, "/replan").map((request) => request.body ?? {});
}

function only<T>(items: readonly T[]): T {
    assert.equal(items.length, 1);
    const item = items[0];
    assert.ok(item !== undefined);
    return item;
}

function last(views: readonly PlaybackView[]): PlaybackView {
    const view = views[views.length - 1];
    assert.ok(view !== undefined);
    return view;
}

function tracks(r: Rig): TrackView {
    const view = last(r.views);
    assert.ok(view.phase === "playing" || view.phase === "paused", `expected playback, got ${view.phase}`);
    return view.tracks;
}

async function settle(r: Rig): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await r.h.clock.advance(0);
    }
}

/** Start, prepare, resume seek, play. */
async function playMovie(r: Rig, request: PlayRequest = MOVIE): Promise<string> {
    r.controller.play(request);
    await settle(r);
    r.avplay.finishPrepare();
    await settle(r);
    if (r.avplay.calls[r.avplay.calls.length - 1]?.startsWith("seekTo") === true) {
        r.avplay.finishSeek();
        await settle(r);
    }
    assert.equal(r.avplay.state, "PLAYING");
    const id = [...r.server.sessions.keys()].pop();
    assert.ok(id !== undefined);
    return id;
}

/** Prepares and plays the transport a track change opened. */
async function playReplacement(r: Rig): Promise<void> {
    r.avplay.finishPrepare();
    await settle(r);
    if (r.avplay.calls[r.avplay.calls.length - 1]?.startsWith("seekTo") === true) {
        r.avplay.finishSeek();
        await settle(r);
    }
}

test("the plan decoder reads the subtitle decision, its inventory and the effective edition", () => {
    const decision = decodePlaybackDecision(fixture("playback_start_opaque_ids"));
    assert.equal(decision.outcome, "playable");
    const plan = decision.outcome === "playable" ? decision.plan : undefined;
    assert.ok(plan !== undefined);
    assert.equal(plan.effectiveMediaFileId, "42");
    assert.equal(plan.subtitle.mode, "off");
    assert.equal(plan.subtitle.trackId, undefined);
    assert.deepEqual(
        plan.subtitle.inventory.map((entry) => [entry.trackId, entry.source, entry.delivery]),
        [
            ["file:42:subtitle:0", "external", "sidecar"],
            ["file:42:subtitle:1", "embedded", "sidecar"],
            ["file:42:subtitle:2", "embedded", "sidecar"],
            ["file:42:subtitle:3", "embedded", "burn_in_only"],
            ["file:42:subtitle:4", "downloaded", "sidecar"],
        ],
    );
    assert.deepEqual(plan.warnings, []);
});

test("the versions decoder keeps each file's audio_tracks in server order and tolerates none", () => {
    assert.deepEqual(decodeFileVersionTracks(fixture("list_catalog_item_versions_ok")), [{ fileId: "120", audio: [] }]);
    const decoded = decodeFileVersionTracks({
        items: [{ file_id: "7", audio_tracks: [{ default: false, language: "ja", codec: "aac", channels: 2 }, { default: true, embedded_title: "Director" }] }],
    });
    assert.deepEqual(decoded, [
        {
            fileId: "7",
            audio: [
                { isDefault: false, language: "ja", codec: "aac", channels: 2, title: undefined },
                { isDefault: true, language: undefined, codec: undefined, channels: undefined, title: "Director" },
            ],
        },
    ]);
});

test("the audio menu comes from the effective edition, with the server's canonical identities", async () => {
    const r = await rig();
    r.server.next.push({ effectiveFileId: "43" });
    await playMovie(r);
    const read = only(requests(r.h, "/versions"));
    assert.equal(read.path, "/catalog/items/movie-1/versions");
    assert.equal(read.headers["x-profile-id"], "p-owner");
    const view = tracks(r);
    assert.equal(view.audio.state, "ready");
    assert.deepEqual(
        view.audio.state === "ready" ? view.audio.choices.map((choice) => choice.id) : [],
        ["file:43:audio:0", "file:43:audio:1"],
        "the requested file 42 lists three tracks; the plan plays 43",
    );
    assert.equal(view.selectedAudioId, "file:43:audio:0");
    assert.deepEqual(
        view.subtitles.map((choice) => choice.id),
        ["file:43:subtitle:0", "file:43:subtitle:1"],
    );
    assert.equal(view.selectedSubtitleId, undefined);
});

test("an audio choice is a server track_change from the current source position; AVPlay is only reopened", async () => {
    const r = await rig();
    const id = await playMovie(r);
    r.avplay.tick(30000);
    const before = r.server.session(id);
    const planId = before.planId;
    const planKey = before.planKey;
    const callsBefore = r.avplay.calls.length;

    r.controller.selectAudio("file:42:audio:1");
    await settle(r);
    const body = only(replans(r.h));
    assert.equal(body.operation, "track_change");
    assert.deepEqual(body.selected_tracks, { audio: { id: "file:42:audio:1" } });
    assert.equal(body.position_seconds, 30);
    assert.equal(body.failed_plan_id, planId);
    assert.equal(body.plan_attempt_key, planKey);
    assert.equal(body.quality_preference, "auto");
    assert.match(String(body.replan_request_id), UUID);
    assert.equal("failure" in body, false);
    assert.ok(
        r.avplay.calls.slice(callsBefore).every((call) => /^(close|open |prepareAsync)/.test(call)),
        `only a new transport, never a local track switch: ${r.avplay.calls.slice(callsBefore).join(", ")}`,
    );

    await playReplacement(r);
    assert.equal(r.avplay.state, "PLAYING");
    assert.equal(tracks(r).selectedAudioId, "file:42:audio:1");
    assert.equal(tracks(r).change.state, "idle");
});

test("an embedded subtitle is burned in by the server and keeps the chosen audio", async () => {
    const r = await rig();
    await playMovie(r);
    r.controller.selectAudio("file:42:audio:2");
    await settle(r);
    await playReplacement(r);

    r.controller.selectSubtitle("file:42:subtitle:3");
    await settle(r);
    const body = replans(r.h)[1];
    assert.deepEqual(body?.selected_tracks, { audio: { id: "file:42:audio:2", index: 2 }, subtitle: { id: "file:42:subtitle:3" } });
    await playReplacement(r);
    const view = tracks(r);
    assert.equal(view.selectedSubtitleId, "file:42:subtitle:3");
    assert.equal(view.subtitleMode, "burn_in");
    assert.deepEqual(view.notices, ["Subtitles are burned into the video."]);
    assert.equal(view.selectedAudioId, "file:42:audio:2");
});

test("Off omits the subtitle and keeps the audio; the inventory stays listed", async () => {
    const r = await rig();
    r.server.next.push({ subtitle: 1 });
    await playMovie(r);
    assert.equal(tracks(r).selectedSubtitleId, "file:42:subtitle:1");

    r.controller.selectSubtitle(undefined);
    await settle(r);
    const body = only(replans(r.h));
    assert.equal(body.operation, "track_change");
    assert.deepEqual(body.selected_tracks, { audio: { id: "file:42:audio:0", index: 0 } });
    await playReplacement(r);
    const view = tracks(r);
    assert.equal(view.subtitleMode, "off");
    assert.equal(view.selectedSubtitleId, undefined);
    assert.equal(view.subtitles.length, 5);
    assert.deepEqual(view.notices, []);
});

test("a refused change keeps the current plan playing; the next change still names that plan", async () => {
    const r = await rig();
    const id = await playMovie(r);
    const planId = r.server.session(id).planId;
    const urls = r.avplay.urls.length;
    const calls = r.avplay.calls.length;

    r.controller.selectSubtitle("file:42:subtitle:0");
    await settle(r);
    assert.equal(replans(r.h).length, 1);
    assert.equal(r.avplay.urls.length, urls, "no new transport");
    assert.deepEqual(r.avplay.calls.slice(calls), [], "the playing transport is untouched");
    assert.equal(r.avplay.state, "PLAYING");
    assert.equal(last(r.views).phase, "playing");
    const view = tracks(r);
    assert.deepEqual(view.change, { state: "refused", message: "The selected subtitle source cannot be burned in by the installed transport." });
    assert.equal(view.selectedSubtitleId, undefined);
    assert.equal(requests(r.h, `/playback/${id}`).filter((request) => request.method === "DELETE").length, 0);
    assert.deepEqual(r.exits, []);

    r.controller.selectSubtitle("file:42:subtitle:2");
    await settle(r);
    const next = replans(r.h)[1];
    assert.equal(next?.failed_plan_id, planId);
    assert.notEqual(next?.replan_request_id, replans(r.h)[0]?.replan_request_id);
    await playReplacement(r);
    assert.equal(tracks(r).selectedSubtitleId, "file:42:subtitle:2");
    assert.equal(tracks(r).change.state, "idle");
});

test("an offset plan sends source time, and the new plan starts at its own player position", async () => {
    const r = await rig();
    r.server.next.push({
        delivery: "server_remux_hls",
        timeline: {
            source_start_seconds: 600,
            stream_origin_seconds: 594,
            player_start_seconds: 6,
            timeline_offset_seconds: 594,
            can_seek_anywhere: false,
            seek_restoration: "source_position",
            seek_window_start_seconds: 594,
        },
    });
    await playMovie(r, { ...MOVIE, startSeconds: 600 });
    r.avplay.tick(16000);
    r.server.next.push({
        timeline: { source_start_seconds: 610, stream_origin_seconds: 604, player_start_seconds: 6, timeline_offset_seconds: 604 },
    });
    r.controller.selectAudio("file:42:audio:1");
    await settle(r);
    assert.equal(only(replans(r.h)).position_seconds, 610);
    r.avplay.finishPrepare();
    await settle(r);
    assert.equal(r.avplay.calls[r.avplay.calls.length - 1], "seekTo 6000", "player_start, never zero or the old position");
});

test("a paused viewer stays paused after a track change", async () => {
    const r = await rig();
    await playMovie(r);
    r.controller.togglePause();
    assert.equal(r.avplay.state, "PAUSED");
    r.controller.selectAudio("file:42:audio:1");
    await settle(r);
    await playReplacement(r);
    assert.equal(r.avplay.state, "PAUSED");
    assert.equal(last(r.views).phase, "paused");
    await r.h.clock.advance(10000);
    assert.equal(requests(r.h, "/progress").pop()?.body?.is_paused, true);
});

test("a change waiting on Retry-After resends the same request; a new choice gets a new id", async () => {
    const r = await rig();
    const id = await playMovie(r);
    r.avplay.tick(30000);
    r.h.fake.script(`/playback/${id}/replan`, { status: 503, headers: { "Retry-After": "30" } });
    r.controller.selectAudio("file:42:audio:1");
    await settle(r);
    assert.equal(replans(r.h).length, 1);
    assert.equal(tracks(r).change.state, "changing");
    r.avplay.tick(45000);
    await r.h.clock.advance(29999);
    assert.equal(replans(r.h).length, 1);
    assert.equal(requests(r.h, "/progress").pop()?.body?.position, 45);
    await r.h.clock.advance(1);
    await settle(r);
    const sent = replans(r.h);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1], sent[0]);
    assert.equal(sent[1]?.position_seconds, 30, "live progress never changes the retry body");
    await playReplacement(r);
    r.controller.selectAudio("file:42:audio:2");
    await settle(r);
    assert.notEqual(replans(r.h)[2]?.replan_request_id, sent[0]?.replan_request_id);
});

for (const ending of ["back", "background"]) {
    test(`a pending track change keeps live progress and the final ${ending} position`, async () => {
        const r = await rig();
        const id = await playMovie(r);
        r.avplay.tick(30000);
        const hold = r.h.fake.hold(`/playback/${id}/replan`, true);
        r.controller.selectAudio("file:42:audio:1");
        await settle(r);
        r.avplay.tick(45000);
        await r.h.clock.advance(10000);
        await settle(r);
        assert.equal(requests(r.h, "/progress").pop()?.body?.position, 45);
        assert.equal(only(replans(r.h)).position_seconds, 30, "the replan keeps its original position");
        r.avplay.tick(50000);
        if (ending === "back") {
            r.controller.back();
        } else {
            r.controller.background();
        }
        await settle(r);
        const stop = only(requests(r.h, `/playback/${id}`).filter((request) => request.method === "DELETE"));
        assert.equal(stop.body?.position, 50);
        hold.release();
        await settle(r);
        assert.equal(r.avplay.state, "NONE", "a late change cannot reopen playback");
        assert.equal(r.avplay.urls.length, 1);
    });
}

test("three lost track-change answers end the attempt instead of continuing with an obsolete plan", async () => {
    const r = await rig();
    const id = await playMovie(r);
    const path = `/playback/${id}/replan`;
    for (let i = 0; i < 3; i++) {
        r.h.fake.dropNextAnswer(path);
    }
    r.controller.selectAudio("file:42:audio:1");
    await settle(r);
    assert.equal(r.server.session(id).audioIndex, 1, "the first request committed before its answer was lost");
    await r.h.clock.advance(1000);
    await settle(r);
    await r.h.clock.advance(2000);
    await settle(r);
    const sent = replans(r.h);
    assert.equal(sent.length, 3);
    assert.deepEqual(sent[1], sent[0]);
    assert.deepEqual(sent[2], sent[0]);
    const view = last(r.views);
    assert.deepEqual(view.phase === "error" ? view.error : undefined, { kind: "network" });
    assert.equal(r.avplay.state, "NONE");
    assert.ok(r.server.session(id).receipt !== undefined, "the ambiguous server session is stopped");
    r.controller.selectAudio("file:42:audio:2");
    r.avplay.listener?.onerror("PLAYER_ERROR_NOT_SUPPORTED_FORMAT");
    await settle(r);
    assert.equal(replans(r.h).length, 3, "no new request can use the obsolete local plan");
});

test("a second choice while one is pending is refused as busy, and a seek waits too", async () => {
    const r = await rig();
    const id = await playMovie(r);
    const hold = r.h.fake.hold(`/playback/${id}/replan`);
    r.controller.selectAudio("file:42:audio:1");
    await settle(r);
    r.controller.selectSubtitle("file:42:subtitle:2");
    r.controller.selectAudio("file:42:audio:2");
    const calls = r.avplay.calls.length;
    r.controller.seekBy(10);
    await settle(r);
    assert.equal(replans(r.h).length, 1);
    assert.deepEqual(r.avplay.calls.slice(calls), [], "no seek while the change is pending");
    assert.equal(tracks(r).change.state, "changing");
    hold.release();
    await settle(r);
    await playReplacement(r);
    assert.equal(tracks(r).selectedAudioId, "file:42:audio:1");
});

test("a change is refused while a seek is still pending on the transport", async () => {
    const r = await rig();
    await playMovie(r);
    r.avplay.tick(30000);
    r.controller.seekBy(-10);
    assert.equal(r.avplay.calls[r.avplay.calls.length - 1], "seekTo 20000");
    r.controller.selectAudio("file:42:audio:1");
    await settle(r);
    assert.equal(replans(r.h).length, 0);
    r.avplay.finishSeek();
    await settle(r);
    r.controller.selectAudio("file:42:audio:1");
    await settle(r);
    assert.equal(only(replans(r.h)).position_seconds, 20);
});

test("Back during a pending change never adopts its late answer", async () => {
    const r = await rig();
    const id = await playMovie(r);
    const hold = r.h.fake.hold(`/playback/${id}/replan`, true);
    r.controller.selectAudio("file:42:audio:1");
    await settle(r);
    r.controller.back();
    await settle(r);
    const urls = r.avplay.urls.length;
    hold.release();
    await settle(r);
    assert.equal(r.avplay.urls.length, urls);
    assert.equal(r.avplay.state, "NONE");
    assert.deepEqual(r.exits, ["back"]);
    assert.equal(last(r.views).phase, "closed");
});

test("a profile change during a pending change aborts it and acts no further", async () => {
    const r = await rig();
    const id = await playMovie(r);
    const hold = r.h.fake.hold(`/playback/${id}/replan`);
    r.controller.selectAudio("file:42:audio:1");
    await settle(r);
    r.h.core.profiles.clear();
    hold.release();
    await settle(r);
    assert.equal(r.avplay.urls.length, 1);
    assert.deepEqual(r.exits, ["end:authority_changed"]);
});

test("a failed route during a refused change is recovered once the change settles", async () => {
    const r = await rig();
    const id = await playMovie(r);
    const hold = r.h.fake.hold(`/playback/${id}/replan`);
    r.controller.selectSubtitle("file:42:subtitle:0");
    await settle(r);
    r.avplay.listener?.onerror("PLAYER_ERROR_NOT_SUPPORTED_FORMAT");
    await settle(r);
    assert.equal(replans(r.h).length, 1, "recovery waits for the pending change");
    hold.release();
    await settle(r);
    const recovery = replans(r.h)[1];
    assert.equal(recovery?.operation, "failure_recovery");
    assert.deepEqual(recovery?.failure, { classification: "avplay_playback_error" });
});

test("a seek failure after a refused track change recovers after the physical seek settles", async () => {
    const r = await rig();
    await playMovie(r);
    r.controller.selectSubtitle("file:42:subtitle:0");
    await settle(r);
    assert.equal(tracks(r).change.state, "refused");
    r.avplay.tick(30000);
    r.controller.seekBy(-10);
    const calls = r.avplay.calls.length;
    r.avplay.listener?.onerror("PLAYER_ERROR_NOT_SUPPORTED_FORMAT");
    assert.equal(replans(r.h).length, 1);
    assert.equal(r.avplay.calls.length, calls);
    r.avplay.finishSeek();
    await settle(r);
    const recovery = replans(r.h)[1];
    assert.equal(recovery?.operation, "failure_recovery");
    assert.equal(recovery?.position_seconds, 20);
    assert.deepEqual(recovery?.failure, { classification: "avplay_playback_error" });
    await playReplacement(r);
    assert.equal(r.avplay.state, "PLAYING");
    assert.equal(tracks(r).change.state, "idle");
});

test("backgrounding during a failed pending track change cancels deferred recovery and late adoption", async () => {
    const r = await rig();
    const id = await playMovie(r);
    const hold = r.h.fake.hold(`/playback/${id}/replan`, true);
    r.controller.selectSubtitle("file:42:subtitle:0");
    await settle(r);
    r.avplay.listener?.onerror("PLAYER_ERROR_NOT_SUPPORTED_FORMAT");
    r.controller.background();
    await settle(r);
    hold.release();
    await settle(r);
    assert.equal(replans(r.h).length, 1, "backgrounded attempts never dispatch deferred recovery");
    assert.equal(r.avplay.urls.length, 1);
    assert.equal(r.avplay.state, "NONE");
    const view = last(r.views);
    assert.deepEqual(view.phase === "error" ? view.error : undefined, { kind: "backgrounded" });
    const count = r.h.fake.requests.length;
    await r.h.clock.advance(30000);
    assert.equal(r.h.fake.requests.length, count);
    assert.deepEqual(r.exits, []);
});

test("catalog reads, track metadata and playback dispatch coexist on the same authenticated fake", async () => {
    const r = await rig();
    r.h.fake.catalog = new FakeCatalog();
    const home = await r.h.core.session.call({ ...operations.listHomeSections(), profileScoped: true });
    assert.ok(home.length > 0);
    await playMovie(r);
    const audio = tracks(r).audio;
    assert.ok(audio.state === "ready");
    assert.equal(audio.choices.length, 3);
    r.controller.selectAudio("file:42:audio:1");
    await settle(r);
    await playReplacement(r);
    assert.equal(tracks(r).selectedAudioId, "file:42:audio:1");
    assert.deepEqual(r.exits, []);
});

test("a track change that cannot be sent is a readable, non-fatal failure", async () => {
    const r = await rig();
    const id = await playMovie(r);
    r.h.fake.script(`/playback/${id}/replan`, problem(409, "replan_in_progress", "Replan in progress"));
    r.controller.selectAudio("file:42:audio:1");
    await settle(r);
    assert.equal(r.avplay.state, "PLAYING");
    assert.equal(tracks(r).change.state, "failed");
    assert.deepEqual(r.exits, []);
});

test("an audio choice the edition lacks plays its default track and says so", async () => {
    const r = await rig();
    await playMovie(r);
    r.server.files.set("42", { ...r.server.file("42"), audio: r.server.file("42").audio.slice(0, 1) });
    r.controller.selectAudio("file:42:audio:1");
    await settle(r);
    await playReplacement(r);
    assert.equal(tracks(r).selectedAudioId, "file:42:audio:0");
    assert.deepEqual(tracks(r).notices, ["The chosen audio track isn't in this version, so its default track is playing."]);
});

test("audio metadata failure keeps playback going and can be retried", async () => {
    const r = await rig();
    r.h.fake.script("/catalog/items/movie-1/versions", { status: 500 });
    await playMovie(r);
    assert.equal(r.avplay.state, "PLAYING");
    assert.equal(tracks(r).audio.state, "failed");
    r.controller.selectAudio("file:42:audio:1");
    await settle(r);
    assert.equal(replans(r.h).length, 0, "no choice without the server's track list");
    r.controller.retryTrackInfo();
    await settle(r);
    assert.equal(tracks(r).audio.state, "ready");
    r.controller.selectSubtitle("file:42:subtitle:9");
    await settle(r);
    assert.equal(replans(r.h).length, 0, "an identity outside the inventory is never sent");
});

test("a late versions answer after Back changes nothing", async () => {
    const r = await rig();
    const hold = r.h.fake.hold("/catalog/items/movie-1/versions", true);
    await playMovie(r);
    r.controller.back();
    hold.release();
    await settle(r);
    assert.equal(last(r.views).phase, "closed");
    assert.deepEqual(r.exits, ["back"]);
});

const QUALITY_SETTINGS = "/settings/values/effective?keys=playback.preferred_quality&keys=playback.max_bitrate_kbps";
const QUALITIES = [
    { label: "1080p-medium", display_name: "1080p Medium", height: 1080, bitrate_kbps: 6000, preserves_source: false },
    { label: "future-rung", preserves_source: true },
];

function qualityDecision(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const base = fixture("playback_start_opaque_ids");
    const plan = base.playback_plan;
    assert.ok(typeof plan === "object" && plan !== null && !Array.isArray(plan));
    return { ...base, server_features: ["plan_active_quality_v1"], playback_plan: { ...plan, available_qualities: QUALITIES, ...extra } };
}

test("quality decoding preserves server order, optional fields and additive labels", () => {
    const decision = decodePlaybackDecision(qualityDecision({ active_quality: "future-rung" }));
    assert.ok(decision.outcome === "playable");
    assert.deepEqual(decision.serverFeatures, ["plan_active_quality_v1"]);
    assert.deepEqual(decision.plan.availableQualities, [
        { label: "1080p-medium", displayName: "1080p Medium", height: 1080, bitrateKbps: 6000, preservesSource: false },
        { label: "future-rung", displayName: undefined, height: undefined, bitrateKbps: undefined, preservesSource: true },
    ]);
    assert.equal(decision.plan.activeQuality, "future-rung");
    for (const rung of [{ label: " ", preserves_source: false }, { label: "x" }, { label: "x", preserves_source: false, height: 1.5 }, { label: "x", preserves_source: false, bitrate_kbps: "6000" }]) {
        assert.throws(() => decodePlaybackDecision(qualityDecision({ available_qualities: [rung] })));
    }
});

test("effective quality and cap are read under the captured profile before start", async () => {
    const r = await rig();
    r.h.fake.script(QUALITY_SETTINGS, { status: 200, body: { items: [
        { key: "playback.preferred_quality", value: "1080p" },
        { key: "playback.max_bitrate_kbps", value: 6000 },
    ] } });
    await playMovie(r);
    const settings = only(requests(r.h, QUALITY_SETTINGS));
    assert.equal(settings.headers["x-profile-id"], "p-owner");
    assert.ok(settings.headers["x-silo-device-id"]);
    const start = only(requests(r.h, "/playback/start")).body;
    assert.equal(start?.quality_preference, "1080p");
    assert.equal(start?.bandwidth_cap_kbps, 6000);
    r.controller.selectAudio("file:42:audio:1");
    await settle(r);
    assert.equal(only(replans(r.h)).quality_preference, "1080p");
    assert.equal(only(replans(r.h)).bandwidth_cap_kbps, 6000);
});

test("only server alternatives expose Auto plus server labels; Original alone is hidden", async () => {
    for (const offered of [[], [{ label: "original", preserves_source: true }], QUALITIES]) {
        const r = await rig();
        r.server.next.push({ availableQualities: offered });
        await playMovie(r);
        assert.deepEqual(tracks(r).quality?.choices ?? [], offered === QUALITIES ? [
            { id: "auto", label: "Auto" }, { id: "1080p-medium", label: "1080p Medium" }, { id: "future-rung", label: "future-rung" },
        ] : []);
    }
});

test("quality highlighting distinguishes Auto, authoritative delivery and a legacy explicit pick", async () => {
    for (const features of [[], ["plan_active_quality_v1"]]) {
        const r = await rig();
        r.h.fake.script(QUALITY_SETTINGS, { status: 200, body: { items: [{ key: "playback.preferred_quality", value: "1080p" }] } });
        r.server.next.push({ availableQualities: QUALITIES, serverFeatures: features, activeQuality: "future-rung" });
        await playMovie(r);
        assert.equal(tracks(r).quality?.selectedId, features.length === 0 ? undefined : "future-rung");
        r.server.next.push({ availableQualities: QUALITIES, serverFeatures: features });
        r.controller.selectQuality("1080p-medium");
        await settle(r);
        await playReplacement(r);
        assert.equal(tracks(r).quality?.selectedId, features.length === 0 ? "1080p-medium" : undefined);
    }
    const auto = await rig();
    auto.server.next.push({ availableQualities: QUALITIES, activeQuality: "future-rung" });
    await playMovie(auto);
    assert.equal(tracks(auto).quality?.selectedId, "auto");
});

test("quality intent clears failure history, echoes opaque identities, preserves Off and retains the cap on later replans", async () => {
    const r = await rig();
    r.h.fake.script(QUALITY_SETTINGS, { status: 200, body: { items: [{ key: "playback.max_bitrate_kbps", value: 7000 }] } });
    r.server.next.push({ availableQualities: QUALITIES });
    const id = await playMovie(r);
    r.server.next.push({ availableQualities: QUALITIES });
    r.avplay.listener?.onerror("PLAYER_ERROR_NOT_SUPPORTED_FORMAT");
    await settle(r);
    await playReplacement(r);
    const predecessor = { id: r.server.session(id).planId, key: r.server.session(id).planKey };
    r.avplay.tick(42500);
    r.controller.togglePause();
    r.server.next.push({ availableQualities: QUALITIES, effectiveFileId: "43", timeline: { source_start_seconds: 42.5, player_start_seconds: 2.5, timeline_offset_seconds: 40 } });
    r.controller.selectQuality("1080p-medium");
    await settle(r);
    const change = replans(r.h)[1];
    assert.equal(change?.operation, "quality_change");
    assert.equal(change?.quality_preference, "1080p-medium");
    assert.equal(change?.bandwidth_cap_kbps, 6000);
    assert.equal(change?.position_seconds, 42.5);
    assert.equal(change?.failed_plan_id, predecessor.id);
    assert.equal(change?.plan_attempt_key, predecessor.key);
    assert.equal(change?.playback_attempt_id, only(requests(r.h, "/playback/start")).body?.playback_attempt_id);
    assert.deepEqual(change?.attempted_plan_keys, []);
    assert.equal(change?.attempt_count, 1);
    assert.equal(change?.failure, undefined);
    assert.deepEqual(change?.selected_tracks, { audio: { id: "file:42:audio:0", index: 0 } });
    await playReplacement(r);
    assert.equal(last(r.views).phase, "paused");
    assert.equal(tracks(r).selectedAudioId, "file:43:audio:0");
    assert.equal(tracks(r).selectedSubtitleId, undefined);
    r.avplay.tick(5000);
    const paused = last(r.views);
    assert.ok(paused.phase === "paused");
    assert.equal(paused.positionSeconds, 45);
    r.controller.selectAudio("file:43:audio:1");
    await settle(r);
    assert.equal(replans(r.h)[2]?.quality_preference, "1080p-medium");
    assert.equal(replans(r.h)[2]?.bandwidth_cap_kbps, 6000);
    await playReplacement(r);
    r.avplay.listener?.onerror("PLAYER_ERROR_NOT_SUPPORTED_FORMAT");
    await settle(r);
    assert.equal(replans(r.h)[3]?.quality_preference, "1080p-medium");
    assert.equal(replans(r.h)[3]?.bandwidth_cap_kbps, 6000);
});

test("a confirmed quality refusal alone keeps the predecessor and requested preference", async () => {
    const r = await rig();
    r.server.next.push({ availableQualities: QUALITIES });
    await playMovie(r);
    r.server.next.push({ terminal: "quality_unavailable" });
    r.controller.selectQuality("future-rung");
    await settle(r);
    assert.equal(r.avplay.state, "PLAYING");
    assert.equal(r.avplay.urls.length, 1);
    assert.equal(tracks(r).change.state, "refused");
    assert.equal(tracks(r).quality?.selectedId, "auto");
    r.controller.selectAudio("file:42:audio:1");
    await settle(r);
    assert.equal(replans(r.h)[1]?.quality_preference, "auto");
});

test("quality retries are identical and exhaustion stops the uncertain attempt", async () => {
    const r = await rig();
    r.server.next.push({ availableQualities: QUALITIES });
    const id = await playMovie(r);
    const path = `/playback/${id}/replan`;
    for (let i = 0; i < 3; i++) r.h.fake.dropNextAnswer(path);
    r.controller.selectQuality("future-rung");
    await settle(r);
    assert.equal(tracks(r).change.state, "changing");
    r.avplay.tick(50000);
    await r.h.clock.advance(1000);
    await settle(r);
    await r.h.clock.advance(2000);
    await settle(r);
    const sent = replans(r.h);
    assert.equal(sent.length, 3);
    assert.deepEqual(sent[1], sent[0]);
    assert.deepEqual(sent[2], sent[0]);
    assert.equal(r.avplay.state, "NONE");
    assert.equal(last(r.views).phase, "error");
    assert.equal(r.avplay.urls.length, 1);
    assert.ok(r.server.session(id).receipt);
});

test("generic conflict and unusable quality successes tear down without reopening the predecessor", async () => {
    for (const reply of [problem(409, "conflict", "Conflict"), { status: 200, body: {} }, { status: 200, body: { protocol_version: 3, outcome: "future" } }, { status: 200, body: { ...qualityDecision(), session_id: "different-session" } }]) {
        const r = await rig();
        r.server.next.push({ availableQualities: QUALITIES });
        const id = await playMovie(r);
        r.h.fake.script(`/playback/${id}/replan`, reply);
        r.controller.selectQuality("future-rung");
        await settle(r);
        assert.equal(last(r.views).phase, "error");
        assert.equal(r.avplay.state, "NONE");
        assert.equal(r.avplay.urls.length, 1);
    }
});

test("replacement load failure recovers against the new identity, never the retired predecessor", async () => {
    const r = await rig();
    r.server.next.push({ availableQualities: QUALITIES });
    const id = await playMovie(r);
    const old = r.server.session(id).planId;
    r.controller.selectQuality("future-rung");
    await settle(r);
    const replacement = r.server.session(id).planId;
    assert.notEqual(replacement, old);
    r.avplay.finishPrepare("NotSupportedError");
    await settle(r);
    assert.equal(replans(r.h)[1]?.failed_plan_id, replacement);
    assert.equal(replans(r.h)[1]?.quality_preference, "future-rung");
    assert.equal(r.avplay.urls.filter(url => url === r.avplay.urls[0]).length, 1);
});

test("quality defaults decode null/missing caps and legacy Original, rejecting invalid saved values", () => {
    assert.deepEqual(decodePlaybackDefaults({ items: [] }), { qualityPreference: "auto", bandwidthCapKbps: undefined });
    assert.deepEqual(decodePlaybackDefaults({ items: [{ key: "playback.preferred_quality", value: "original" }, { key: "playback.max_bitrate_kbps", value: null }] }), { qualityPreference: "auto", bandwidthCapKbps: undefined });
    for (const value of [0, 99, 200001, 1.5, "6000"]) {
        assert.throws(() => decodePlaybackDefaults({ items: [{ key: "playback.max_bitrate_kbps", value }] }));
    }
    for (const value of [" ", null, 1080]) {
        assert.throws(() => decodePlaybackDefaults({ items: [{ key: "playback.preferred_quality", value }] }));
    }
});

test("a present bandwidth default requires a value", () => {
    assert.throws(() => decodePlaybackDefaults({ items: [{ key: "playback.max_bitrate_kbps" }] }));
});

test("a bandwidth default missing its value prevents playback startup", async () => {
    const r = await rig();
    r.h.fake.script(QUALITY_SETTINGS, { status: 200, body: { items: [{ key: "playback.max_bitrate_kbps" }] } });
    r.controller.play(MOVIE);
    await settle(r);
    assert.equal(last(r.views).phase, "error");
    assert.equal(requests(r.h, "/playback/start").length, 0);
});

test("source-preserving quality removes the current cap and Auto restores the saved cap", async () => {
    const r = await rig();
    r.h.fake.script(QUALITY_SETTINGS, { status: 200, body: { items: [{ key: "playback.max_bitrate_kbps", value: 9000 }] } });
    r.server.next.push({ availableQualities: QUALITIES });
    await playMovie(r);
    r.server.next.push({ availableQualities: QUALITIES });
    r.controller.selectQuality("future-rung");
    await settle(r);
    assert.equal(only(replans(r.h)).bandwidth_cap_kbps, undefined);
    await playReplacement(r);
    r.server.next.push({ availableQualities: QUALITIES });
    r.controller.selectQuality("auto");
    await settle(r);
    assert.equal(replans(r.h)[1]?.quality_preference, "auto");
    assert.equal(replans(r.h)[1]?.bandwidth_cap_kbps, 9000);
    await playReplacement(r);
    assert.equal(tracks(r).quality?.selectedId, "auto");
});

test("settings failure or authority loss before start never silently replaces saved defaults", async () => {
    const failed = await rig();
    failed.h.fake.script(QUALITY_SETTINGS, problem(403, "forbidden", "Forbidden"));
    failed.controller.play(MOVIE);
    await settle(failed);
    assert.equal(last(failed.views).phase, "error");
    assert.equal(requests(failed.h, "/playback/start").length, 0);
    const cancelled = await rig();
    const hold = cancelled.h.fake.hold(QUALITY_SETTINGS, true);
    cancelled.controller.play(MOVIE);
    await settle(cancelled);
    assert.equal(last(cancelled.views).phase, "loading");
    cancelled.h.core.profiles.clear();
    hold.release();
    await settle(cancelled);
    assert.equal(requests(cancelled.h, "/playback/start").length, 0);
    assert.deepEqual(cancelled.exits, ["end:authority_changed"]);
});

test("quality preserves a nondefault audio and burned subtitle; pending pause intent wins at replacement load", async () => {
    const r = await rig();
    r.server.next.push({ availableQualities: QUALITIES });
    const id = await playMovie(r);
    r.controller.selectAudio("file:42:audio:1");
    await settle(r);
    await playReplacement(r);
    r.controller.selectSubtitle("file:42:subtitle:1");
    await settle(r);
    await playReplacement(r);
    // Server alternatives are per plan, not a cached list from the initial file.
    r.server.next.push({ availableQualities: QUALITIES });
    r.controller.selectAudio("file:42:audio:2");
    await settle(r);
    await playReplacement(r);
    const hold = r.h.fake.hold(`/playback/${id}/replan`);
    r.controller.selectQuality("future-rung");
    await settle(r);
    r.controller.togglePause();
    const changes = replans(r.h);
    const change = changes[changes.length - 1];
    assert.deepEqual(change?.selected_tracks, { audio: { id: "file:42:audio:1", index: 1 }, subtitle: { id: "file:42:subtitle:1", index: 1 } });
    hold.release();
    await settle(r);
    await playReplacement(r);
    assert.equal(last(r.views).phase, "paused");
    assert.equal(tracks(r).selectedAudioId, "file:42:audio:1");
    assert.equal(tracks(r).selectedSubtitleId, "file:42:subtitle:1");
});

test("explicit pause remains idempotent during a quality change and survives replacement", async () => {
    const r = await rig();
    r.server.next.push({ availableQualities: QUALITIES });
    const id = await playMovie(r);
    const hold = r.h.fake.hold(`/playback/${id}/replan`);
    r.server.next.push({ availableQualities: QUALITIES });
    r.controller.selectQuality("future-rung");
    await settle(r);
    const pauses = r.avplay.calls.filter(call => call === "pause").length;
    r.controller.setPaused(true);
    r.controller.setPaused(true);
    assert.equal(last(r.views).phase, "paused");
    assert.equal(r.avplay.calls.filter(call => call === "pause").length, pauses + 1);
    hold.release();
    await settle(r);
    await playReplacement(r);
    assert.equal(last(r.views).phase, "paused");
    assert.equal(tracks(r).quality?.selectedId, "future-rung");
});

test("quality serializes with local seeks and other choices, and accepts a repeated route key for new intent", async () => {
    const r = await rig();
    r.server.next.push({ availableQualities: QUALITIES });
    const id = await playMovie(r);
    r.controller.seekBy(10);
    r.controller.selectQuality("future-rung");
    await settle(r);
    assert.equal(replans(r.h).length, 0);
    r.avplay.finishSeek();
    await settle(r);
    r.controller.selectQuality("not-offered");
    r.controller.selectQuality("auto");
    assert.equal(replans(r.h).length, 0);
    const previousKey = r.server.session(id).planKey;
    const body = qualityDecision({ plan_id: "Replacement:Case-SENSITIVE", plan_attempt_key: previousKey });
    const start = only(requests(r.h, "/playback/start"));
    r.h.fake.script(`/playback/${id}/replan`, { status: 200, body: { ...body, session_id: id } });
    const hold = r.h.fake.hold(`/playback/${id}/replan`);
    r.controller.selectQuality("future-rung");
    await settle(r);
    r.controller.selectAudio("file:42:audio:1");
    r.controller.selectSubtitle("file:42:subtitle:1");
    r.controller.selectQuality("1080p-medium");
    r.controller.seekBy(10);
    assert.equal(replans(r.h).length, 1);
    assert.equal(only(replans(r.h)).playback_attempt_id, start.body?.playback_attempt_id);
    hold.release();
    await settle(r);
    await playReplacement(r);
    assert.equal(last(r.views).phase, "playing");
});

for (const ending of ["back", "background", "authority"]) {
    test(`late quality success after ${ending} never opens a retired transport`, async () => {
        const r = await rig();
        r.server.next.push({ availableQualities: QUALITIES });
        const id = await playMovie(r);
        const hold = r.h.fake.hold(`/playback/${id}/replan`, true);
        r.controller.selectQuality("future-rung");
        await settle(r);
        r.avplay.tick(60000);
        if (ending === "back") r.controller.back();
        else if (ending === "background") r.controller.background();
        else r.h.core.profiles.clear();
        await settle(r);
        if (ending !== "authority") {
            const stop = only(requests(r.h, `/playback/${id}`).filter(request => request.method === "DELETE"));
            assert.equal(stop.body?.position, 60);
        }
        hold.release();
        await settle(r);
        assert.equal(r.avplay.urls.length, 1);
        assert.equal(r.avplay.state, "NONE");
        const count = r.h.fake.requests.length;
        await r.h.clock.advance(30000);
        assert.equal(r.h.fake.requests.length, count);
    });
}
