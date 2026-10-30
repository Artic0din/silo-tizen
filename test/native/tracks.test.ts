// Audio and subtitle selection through the one playback owner: every choice is a server
// track_change replan naming the server's own track identity, never an AVPlay track index.
// The fake server applies the pinned server's track rules (support/fakePlayback.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFileVersionTracks, decodePlaybackDecision } from "../../src/contracts/v2/playback.ts";
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
