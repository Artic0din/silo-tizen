// The native playback controller against the fake Silo's playback operations and a fake AVPlay
// that keeps the platform's state order and uncancellable callbacks. Each test checks the server
// requests and source positions, not only what the player shows.

import assert from "node:assert/strict";
import { test } from "node:test";
import { type PlaybackError, PlaybackController, type PlaybackView, type PlayRequest } from "../../src/player/controller.ts";
import { FakeAVPlay } from "./support/fakeAVPlay.ts";
import { FakePlayback } from "./support/fakePlayback.ts";
import { fixture, type RecordedRequest } from "./support/fakeSilo.ts";
import { connected, type Harness, signIn } from "./support/harness.ts";

const MOVIE: PlayRequest = { contentId: "movie-1", fileId: "42", title: "Movie", startSeconds: 12.5 };
const BOUNDED_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Rig {
    readonly h: Harness;
    readonly server: FakePlayback;
    readonly avplay: FakeAVPlay;
    readonly controller: PlaybackController;
    readonly exits: string[];
    readonly errors: PlaybackError[];
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
    const errors: PlaybackError[] = [];
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
            onError: (error) => {
                errors.push(error);
                exits.push(`error:${error.kind}`);
            },
        },
    });
    const views: PlaybackView[] = [];
    controller.subscribe((view) => views.push(view));
    return { h, server, avplay, controller, exits, errors, views };
}

function playbackRequests(h: Harness): RecordedRequest[] {
    return h.fake.requests.filter((request) => request.path.startsWith("/playback"));
}

/** "POST /playback/start", "DELETE /playback/S1" ... with session ids numbered by first use. */
function ops(h: Harness): string[] {
    const ids: string[] = [];
    return playbackRequests(h).map((request) => {
        const path = request.path.replace(/5e55\d{4}-0000-4000-8000-000000000000/, (id) => {
            if (ids.indexOf(id) === -1) {
                ids.push(id);
            }
            return `S${ids.indexOf(id) + 1}`;
        });
        return `${request.method} ${path}`;
    });
}

function bodies(h: Harness, suffix: string): Record<string, unknown>[] {
    return playbackRequests(h)
        .filter((request) => request.path.endsWith(suffix))
        .map((request) => request.body ?? {});
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

function sessionIds(server: FakePlayback): string[] {
    return [...server.sessions.keys()];
}

/** Plays MOVIE to the playing state: start, prepare, resume seek, play. */
async function playMovie(r: Rig, request: PlayRequest = MOVIE): Promise<string> {
    r.controller.play(request);
    await r.h.clock.advance(0);
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    if (r.avplay.calls[r.avplay.calls.length - 1]?.startsWith("seekTo") === true) {
        r.avplay.finishSeek();
        await r.h.clock.advance(0);
    }
    assert.equal(r.avplay.state, "PLAYING");
    const id = sessionIds(r.server).pop();
    assert.ok(id !== undefined);
    return id;
}

test("a start sends the v3 body under the active profile and plays the server's URL from the resume point", async () => {
    const r = await rig();
    r.controller.play(MOVIE);
    assert.equal(last(r.views).phase, "loading");
    await r.h.clock.advance(0);
    assert.deepEqual(ops(r.h), ["GET /playback/capabilities", "POST /playback/start"]);

    const start = only(playbackRequests(r.h).filter((request) => request.path === "/playback/start"));
    assert.equal(start.headers["x-profile-id"], "p-owner");
    const body = start.body ?? {};
    assert.equal(body.installation_id, r.server.installationId);
    assert.equal(body.protocol_version, 3);
    assert.equal(body.file_id, "42");
    assert.equal(body.profile_id, "p-owner");
    assert.equal(body.start_position, 12.5);
    assert.match(String(body.playback_attempt_id), BOUNDED_IDENTIFIER);
    const capabilities = JSON.stringify(body.client_capabilities);
    assert.ok(!capabilities.includes("dts"), "no DTS claim on 2021 TVs");
    assert.match(capabilities, /"video_evidence":"declared"/);
    assert.match(JSON.stringify(body.client_playback_context), /"audio_passthrough_codecs":\[\]/);

    const id = only(sessionIds(r.server));
    const token = start.headers.authorization?.replace(/^Bearer /, "") ?? "";
    // The plan's URL byte-for-byte, with the account bearer appended as the media-element `token`.
    assert.equal(r.avplay.urls.length, 1);
    assert.match(r.avplay.urls[0] ?? "", new RegExp(`^${r.h.fake.origin}/api/v2/stream/${id}\\?st=signed-\\d+&token=${token}$`));
    // close() is allowed in every state and releases anything a previous transport held.
    assert.deepEqual(r.avplay.calls, ["close", `open ${r.avplay.urls[0]}`, "prepareAsync"]);

    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    assert.deepEqual(r.avplay.calls.slice(3), ["seekTo 12500"], "seeks to player_start before playing; nothing else during the seek");
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.deepEqual(r.avplay.calls.slice(4), ["play"]);
    const view = last(r.views);
    assert.equal(view.phase, "playing");
    assert.equal(view.phase === "playing" ? view.positionSeconds : -1, 12.5);
    assert.equal(view.phase === "playing" ? view.durationSeconds : -1, 7200);
    assert.deepEqual(r.exits, []);
});

test("without a start position the server chooses the resume point", async () => {
    const r = await rig();
    r.controller.play({ ...MOVIE, startSeconds: undefined });
    await r.h.clock.advance(0);
    const body = only(bodies(r.h, "/start"));
    assert.equal("start_position" in body, false);
});

test("Back while the start is answering never plays; the late session is stopped, never reported", async () => {
    const r = await rig();
    const hold = r.h.fake.hold("/playback/start");
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    r.controller.back();
    assert.deepEqual(r.exits, ["back"]);
    hold.release();
    await r.h.clock.advance(0);
    assert.deepEqual(r.avplay.urls, []);
    assert.deepEqual(ops(r.h), ["GET /playback/capabilities", "POST /playback/start", "DELETE /playback/S1"]);
    assert.match(String(only(bodies(r.h, "/playback/" + only(sessionIds(r.server)))).stop_id), UUID);
    await r.h.clock.advance(60000);
    assert.equal(ops(r.h).length, 3, "no progress for the abandoned attempt");
    assert.deepEqual(r.exits, ["back"]);
});

test("a superseding start plays only the newer attempt and stops the older one's session", async () => {
    const r = await rig();
    const hold = r.h.fake.hold("/playback/start");
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    r.controller.play({ ...MOVIE, fileId: "43", title: "Other", startSeconds: 0 });
    await r.h.clock.advance(0);
    hold.release();
    await r.h.clock.advance(0);

    const [first, second] = sessionIds(r.server);
    assert.ok(first !== undefined && second !== undefined);
    assert.equal(r.avplay.urls.length, 1);
    assert.ok(r.avplay.urls[0]?.includes(second));
    assert.ok(ops(r.h).indexOf("DELETE /playback/S1") !== -1);
    assert.equal(ops(r.h).indexOf("DELETE /playback/S2"), -1);
    const starts = bodies(r.h, "/start");
    assert.notEqual(starts[0]?.playback_attempt_id, starts[1]?.playback_attempt_id);
    assert.deepEqual(r.exits, []);
});

test("Back during prepare closes AVPlay; the late prepare callback cannot play or report", async () => {
    const r = await rig();
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    r.controller.back();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.state, "NONE");
    assert.deepEqual(r.exits, ["back"]);
    const stop = only(bodies(r.h, "/playback/" + only(sessionIds(r.server))));
    assert.equal(stop.installation_id, r.server.installationId);
    assert.equal(stop.position, 12.5, "the final sample is the source position the plan started at");

    r.avplay.finishPrepare();
    await r.h.clock.advance(60000);
    assert.equal(r.avplay.calls.indexOf("play"), -1);
    assert.equal(ops(r.h).filter((op) => op.endsWith("/progress")).length, 0);
});

test("a codec-route failure replans once per failed plan with echoed opaque keys; old-listener events are ignored", async () => {
    const r = await rig();
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    const id = only(sessionIds(r.server));
    const firstListener = r.avplay.listener;
    const start = only(bodies(r.h, "/start"));
    const firstPlan = r.server.session(id);
    const failedPlanId = firstPlan.planId;
    const failedKey = firstPlan.planKey;

    r.avplay.finishPrepare("NotSupportedError");
    await r.h.clock.advance(0);
    const replan = only(bodies(r.h, "/replan"));
    assert.equal(replan.operation, "failure_recovery");
    assert.deepEqual(replan.failure, { classification: "avplay_prepare_failed" });
    assert.equal(replan.playback_attempt_id, start.playback_attempt_id);
    assert.equal(replan.failed_plan_id, failedPlanId);
    assert.equal(replan.plan_attempt_key, failedKey);
    assert.deepEqual(replan.attempted_plan_keys, [failedKey]);
    assert.equal(replan.attempt_count, 1);
    assert.equal(replan.position_seconds, 12.5);
    assert.deepEqual(replan.selected_tracks, { audio: { id: "file:42:audio:0", index: 0 } });
    assert.match(String(replan.replan_request_id), BOUNDED_IDENTIFIER);
    assert.match(String(replan.plan_attempt_id), BOUNDED_IDENTIFIER);
    assert.equal(r.avplay.urls.length, 2);
    assert.ok(r.avplay.urls[1]?.includes("st=signed-"));

    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.state, "PLAYING");

    // Events the replaced transport's listener still receives while the new one plays.
    firstListener?.onerror("PLAYER_ERROR_NOT_SUPPORTED_FORMAT");
    firstListener?.onstreamcompleted();
    firstListener?.oncurrentplaytime(99000);
    await r.h.clock.advance(0);
    assert.equal(bodies(r.h, "/replan").length, 1, "a late event from the replaced transport is ignored");
    assert.equal(r.avplay.state, "PLAYING");
    assert.deepEqual(r.exits, []);
    await r.h.clock.advance(10000);
    assert.equal(only(bodies(r.h, "/progress")).position, 12.5, "its time is not the new transport's");
});

test("a prepare that hangs is a failed route after 60 s; its late success cannot touch the replacement", async () => {
    const r = await rig();
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    await r.h.clock.advance(59999);
    assert.equal(bodies(r.h, "/replan").length, 0);
    await r.h.clock.advance(1);
    assert.deepEqual(only(bodies(r.h, "/replan")).failure, { classification: "avplay_startup_timeout" });
    assert.equal(r.avplay.urls.length, 2);
    const opened = r.avplay.calls.length;

    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    assert.deepEqual(r.avplay.calls.slice(opened), [], "the first transport's prepare callback does nothing");
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    assert.deepEqual(r.avplay.calls.slice(opened), ["seekTo 12500"]);
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.state, "PLAYING");
});

test("failure replans are bounded; then playback ends with an error and a stop", async () => {
    const r = await rig();
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    for (let failure = 0; failure < 4; failure++) {
        r.avplay.finishPrepare("UnknownError");
        await r.h.clock.advance(0);
    }
    const replans = bodies(r.h, "/replan");
    assert.deepEqual(replans.map((body) => body.attempt_count), [1, 2, 3]);
    assert.deepEqual(replans.map((body) => (Array.isArray(body.attempted_plan_keys) ? body.attempted_plan_keys.length : 0)), [1, 2, 3]);
    const view = last(r.views);
    assert.equal(view.phase, "error");
    assert.deepEqual(view.phase === "error" ? view.error : undefined, { kind: "playback_failed" });
    assert.equal(r.avplay.state, "NONE");
    assert.equal(ops(r.h)[ops(r.h).length - 1], "DELETE /playback/S1");
    assert.deepEqual(r.exits, []);
    r.controller.dismissError();
    assert.deepEqual(r.exits, ["error:playback_failed"]);
});

test("a terminal replan decision ends playback with the server's reason", async () => {
    const r = await rig();
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    r.server.next.push({ terminal: "adaptation_exhausted" });
    r.avplay.finishPrepare("NotSupportedError");
    await r.h.clock.advance(0);
    const view = last(r.views);
    assert.equal(view.phase, "error");
    assert.deepEqual(view.phase === "error" ? view.error : undefined, {
        kind: "terminal",
        reason: "adaptation_exhausted",
        message: "Cannot play: adaptation_exhausted",
        retryable: false,
    });
});

test("a network failure is not a failed route: no replan, the session is stopped", async () => {
    const r = await rig();
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    r.avplay.finishPrepare("InvalidAccessError");
    await r.h.clock.advance(0);
    assert.equal(bodies(r.h, "/replan").length, 0);
    const view = last(r.views);
    assert.deepEqual(view.phase === "error" ? view.error : undefined, { kind: "network" });
    assert.equal(ops(r.h)[ops(r.h).length - 1], "DELETE /playback/S1");

    const playing = await rig();
    await playMovie(playing);
    playing.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await playing.h.clock.advance(0);
    assert.equal(bodies(playing.h, "/replan").length, 0);
    assert.equal(last(playing.views).phase, "error");
});

test("progress is sequenced source time every 10 s; stop waits for the sample in flight and goes last", async () => {
    const r = await rig();
    const id = await playMovie(r);
    r.avplay.tick(20000);
    await r.h.clock.advance(10000);
    r.avplay.tick(25000);
    r.controller.togglePause();
    assert.equal(r.avplay.state, "PAUSED");
    await r.h.clock.advance(10000);
    const hold = r.h.fake.hold(`/playback/${id}/progress`);
    await r.h.clock.advance(10000);

    r.controller.back();
    await r.h.clock.advance(0);
    assert.deepEqual(r.exits, ["back"]);
    assert.equal(r.avplay.state, "NONE");
    assert.equal(ops(r.h).indexOf("DELETE /playback/S1"), -1, "stop waits for the progress in flight");
    hold.release();
    await r.h.clock.advance(0);

    const progress = bodies(r.h, "/progress");
    assert.deepEqual(
        progress.map((body) => [body.sequence, body.position, body.is_paused]),
        [
            [1, 20, false],
            [2, 25, true],
            [3, 25, true],
        ],
    );
    assert.ok(progress.every((body) => body.installation_id === r.server.installationId));
    const stop = only(bodies(r.h, `/playback/${id}`));
    assert.equal(stop.sequence, 4);
    assert.equal(stop.position, 25);
    assert.equal(ops(r.h)[ops(r.h).length - 1], "DELETE /playback/S1");
    await r.h.clock.advance(60000);
    assert.equal(bodies(r.h, "/progress").length, 3, "no progress after the stop");
});

test("a stop whose answer is lost is resent with the same stop_id and gets the stored receipt", async () => {
    const r = await rig();
    const id = await playMovie(r);
    r.h.fake.dropNextAnswer(`/playback/${id}`);
    r.controller.back();
    await r.h.clock.advance(0);
    await r.h.clock.advance(1000);
    const stops = bodies(r.h, `/playback/${id}`);
    assert.equal(stops.length, 2);
    assert.deepEqual(stops[1], stops[0]);
    assert.equal(r.server.session(id).receipt?.stop_id, stops[0]?.stop_id);
    await r.h.clock.advance(60000);
    assert.equal(bodies(r.h, `/playback/${id}`).length, 2);
});

test("a replan whose answer is lost is resent unchanged; a new replan gets a new request id", async () => {
    const r = await rig();
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    const id = only(sessionIds(r.server));
    r.h.fake.dropNextAnswer(`/playback/${id}/replan`);
    r.avplay.finishPrepare("NotSupportedError");
    await r.h.clock.advance(0);
    await r.h.clock.advance(1000);
    const replans = bodies(r.h, "/replan");
    assert.equal(replans.length, 2);
    assert.deepEqual(replans[1], replans[0]);
    assert.equal(r.avplay.urls.length, 2);

    r.avplay.finishPrepare("NotSupportedError");
    await r.h.clock.advance(0);
    const next = bodies(r.h, "/replan")[2];
    assert.ok(next !== undefined);
    assert.notEqual(next.replan_request_id, replans[0]?.replan_request_id);
    assert.notEqual(next.plan_attempt_id, replans[0]?.plan_attempt_id, "each adopted plan gets its own plan_attempt_id");
    assert.equal(next.playback_attempt_id, replans[0]?.playback_attempt_id);
    assert.equal(next.attempt_count, 2);
});

test("an offset timeline reports source time and reanchors seeks through the server", async () => {
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
    const id = await playMovie(r, { ...MOVIE, startSeconds: 600 });
    assert.ok(r.avplay.calls.indexOf("seekTo 6000") !== -1, "the player starts at player_start, past the copied pre-roll");
    r.avplay.tick(16000);
    await r.h.clock.advance(10000);
    assert.equal(only(bodies(r.h, "/progress")).position, 610);

    const before = r.server.session(id);
    const planId = before.planId;
    const planKey = before.planKey;
    r.server.next.push({ timeline: { source_start_seconds: 600, player_start_seconds: 600, timeline_offset_seconds: 0, stream_origin_seconds: 0 } });
    r.controller.seekBy(-10);
    await r.h.clock.advance(0);
    const replan = only(bodies(r.h, "/replan"));
    assert.equal(replan.operation, "seek_reanchor");
    assert.equal(replan.position_seconds, 600);
    assert.equal(replan.failed_plan_id, planId);
    assert.equal(replan.plan_attempt_key, planKey);
    assert.deepEqual(replan.attempted_plan_keys, [], "a reanchor is not a failure");
    assert.equal("failure" in replan, false);
    assert.equal(r.avplay.urls.length, 2);
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.calls[r.avplay.calls.length - 1], "seekTo 600000");
});

test("a seek on a direct plan stays local, at source time minus the offset", async () => {
    const r = await rig();
    await playMovie(r);
    r.avplay.tick(30000);
    r.controller.seekBy(-10);
    assert.equal(r.avplay.calls[r.avplay.calls.length - 1], "seekTo 20000");
    r.controller.seekBy(-10);
    assert.equal(r.avplay.calls[r.avplay.calls.length - 1], "seekTo 20000", "no second call while a seek is pending");
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(bodies(r.h, "/replan").length, 0);
    await r.h.clock.advance(10000);
    assert.equal(only(bodies(r.h, "/progress")).position, 20);
});

test("410 playback_session_ended leaves playback without a new session or stop", async () => {
    const r = await rig();
    const id = await playMovie(r);
    r.server.endByAdmin(id);
    await r.h.clock.advance(10000);
    assert.equal(r.avplay.state, "NONE");
    assert.deepEqual(r.exits, ["end:ended_by_server"]);
    const count = ops(r.h).length;
    await r.h.clock.advance(60000);
    assert.equal(ops(r.h).length, count);
    assert.equal(ops(r.h).filter((op) => op === "POST /playback/start").length, 1);
    assert.equal(ops(r.h).filter((op) => op.startsWith("DELETE")).length, 0);
});

test("404 for the session is an expired session, distinct from an administrator's end", async () => {
    const r = await rig();
    const id = await playMovie(r);
    r.server.sessions.delete(id);
    await r.h.clock.advance(10000);
    const view = last(r.views);
    assert.deepEqual(view.phase === "error" ? view.error : undefined, { kind: "session_expired" });
    assert.equal(r.avplay.state, "NONE");
    assert.equal(ops(r.h).filter((op) => op === "POST /playback/start").length, 1);
});

test("a profile change tears playback down at once and acts no further for the old profile", async () => {
    const r = await rig();
    await playMovie(r);
    const count = ops(r.h).length;
    r.h.core.profiles.clear();
    assert.equal(r.avplay.state, "NONE");
    assert.deepEqual(r.exits, ["end:authority_changed"]);
    await r.h.clock.advance(60000);
    assert.equal(ops(r.h).length, count, "no progress or stop under another authority");

    const starting = await rig();
    const hold = starting.h.fake.hold("/playback/start");
    starting.controller.play(MOVIE);
    await starting.h.clock.advance(0);
    starting.h.core.profiles.clear();
    hold.release();
    await starting.h.clock.advance(60000);
    assert.deepEqual(starting.avplay.urls, []);
    assert.deepEqual(starting.exits, ["end:authority_changed"]);
});

test("only the natural-completion callback completes playback, after a final stop", async () => {
    const r = await rig();
    const id = await playMovie(r);
    r.avplay.tick(7199000);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    const stop = only(bodies(r.h, `/playback/${id}`));
    assert.equal(stop.position, 7199);
    assert.deepEqual(r.exits, ["end:completed"]);
    assert.equal(r.avplay.state, "NONE");
});

test("refusals before playing: not configured, installation changed, terminal start", async () => {
    const unconfigured = await rig();
    unconfigured.server.configured = false;
    unconfigured.controller.play(MOVIE);
    await unconfigured.h.clock.advance(0);
    assert.deepEqual(ops(unconfigured.h), ["GET /playback/capabilities"]);
    const a = last(unconfigured.views);
    assert.deepEqual(a.phase === "error" ? a.error : undefined, { kind: "unavailable" });

    const moved = await rig();
    moved.h.fake.script("/playback/start", { status: 409, headers: { "Content-Type": "application/problem+json" }, body: fixture("playback_installation_changed") });
    moved.controller.play(MOVIE);
    await moved.h.clock.advance(0);
    const b = last(moved.views);
    assert.deepEqual(b.phase === "error" ? b.error : undefined, { kind: "installation_changed" });

    const terminal = await rig();
    terminal.server.next.push({ terminal: "source_unreadable" });
    terminal.controller.play(MOVIE);
    await terminal.h.clock.advance(0);
    const c = last(terminal.views);
    assert.deepEqual(c.phase === "error" ? c.error : undefined, {
        kind: "terminal",
        reason: "source_unreadable",
        message: "Cannot play: source_unreadable",
        retryable: false,
    });
    assert.deepEqual(terminal.avplay.urls, []);
});

test("the account token is never added to a media URL on another origin", async () => {
    const r = await rig();
    r.server.next.push({ url: (id) => `https://node.example.test/stream/v3/${id}?st=node-signed` });
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    const id = only(sessionIds(r.server));
    assert.deepEqual(r.avplay.urls, [`https://node.example.test/stream/v3/${id}?st=node-signed`]);
});

const SEEK_ENDINGS: readonly ("back" | "destroy")[] = ["back", "destroy"];
for (const ending of SEEK_ENDINGS) {
    test(`${ending} during a local seek waits for its callback before closing AVPlay`, async () => {
        const r = await rig();
        await playMovie(r);
        r.avplay.tick(30000);
        r.controller.seekBy(-10);
        const calls = r.avplay.calls.length;
        r.controller[ending]();
        assert.equal(r.avplay.calls.length, calls, "no AVPlay call during the pending seek");
        r.avplay.finishSeek();
        await r.h.clock.advance(0);
        assert.equal(r.avplay.state, "NONE", "the old stream must close after the seek settles");
        assert.deepEqual(r.avplay.calls.slice(calls), ["close"]);
        assert.deepEqual(r.exits, ending === "back" ? ["back"] : []);
    });
}

test("a replacement transport waits for the old resume seek, including its failure callback", async () => {
    const r = await rig();
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.state, "READY");
    r.controller.play({ ...MOVIE, fileId: "43", startSeconds: 0 });
    await r.h.clock.advance(0);
    assert.equal(r.avplay.urls.length, 1, "the new open must wait for the old seek");
    r.avplay.finishSeek("UnknownError");
    await r.h.clock.advance(0);
    assert.equal(r.avplay.urls.length, 2);
    assert.equal(bodies(r.h, "/replan").length, 0, "a stale seek failure cannot replan");
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    if (r.avplay.calls[r.avplay.calls.length - 1]?.startsWith("seekTo") === true) {
        r.avplay.finishSeek();
        await r.h.clock.advance(0);
    }
    assert.equal(r.avplay.state, "PLAYING");
    assert.equal(r.avplay.calls.filter((call) => call === "play").length, 1);
});

test("a paused seek that needs server re-anchoring remains paused after preparing the new plan", async () => {
    const r = await rig();
    r.server.next.push({ timeline: { can_seek_anywhere: false } });
    await playMovie(r);
    r.controller.togglePause();
    assert.equal(r.avplay.state, "PAUSED");
    r.controller.seekBy(10);
    await r.h.clock.advance(0);
    assert.equal(only(bodies(r.h, "/replan")).operation, "seek_reanchor");
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.state, "PAUSED");
    assert.equal(last(r.views).phase, "paused");
    await r.h.clock.advance(10000);
    assert.equal(only(bodies(r.h, "/progress")).is_paused, true);
});

test("a newly mounted controller also waits for the previous controller's pending seek", async () => {
    const r = await rig();
    await playMovie(r);
    r.controller.seekBy(10);
    r.controller.destroy();
    const replacement = new PlaybackController({
        session: r.h.core.session,
        avplay: r.avplay,
        clock: r.h.clock,
        randomBytes: (bytes) => bytes.fill(99),
        device: { model: "QN55Q60AAFXZA", appVersion: "0.1.0" },
        exits: { onBack: () => undefined, onEnd: () => undefined, onError: () => undefined },
    });
    replacement.play({ ...MOVIE, fileId: "43" });
    await r.h.clock.advance(0);
    assert.equal(r.avplay.urls.length, 1);
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.urls.length, 2);
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.state, "PLAYING");
    replacement.destroy();
    assert.equal(r.avplay.state, "NONE");
});

test("a start resend honors Retry-After and keeps its operation identity", async () => {
    const r = await rig();
    r.h.fake.script("/playback/start", { status: 503, headers: { "Retry-After": "30" } });
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    assert.equal(bodies(r.h, "/start").length, 1);
    await r.h.clock.advance(29999);
    assert.equal(bodies(r.h, "/start").length, 1, "the server requested thirty seconds");
    await r.h.clock.advance(1);
    const starts = bodies(r.h, "/start");
    assert.equal(starts.length, 2);
    assert.deepEqual(starts[1], starts[0]);
});

test("an authority change aborts a Retry-After wait without resending", async () => {
    const r = await rig();
    r.h.fake.script("/playback/start", { status: 503, headers: { "Retry-After": "30" } });
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    r.h.core.profiles.clear();
    await r.h.clock.advance(30000);
    assert.equal(bodies(r.h, "/start").length, 1);
    assert.deepEqual(r.exits, ["end:authority_changed"]);
});

test("an HTTP media plan fails without sending its signed credential to AVPlay", async () => {
    const r = await rig();
    r.server.next.push({ url: (id) => `http://node.example.test/stream/${id}?st=node-signed` });
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    assert.deepEqual(r.avplay.urls, []);
    assert.equal(last(r.views).phase, "error");
    assert.equal(ops(r.h)[ops(r.h).length - 1], "DELETE /playback/S1");
    assert.equal(bodies(r.h, "/replan").length, 0, "an insecure URL must not trigger client route selection");
});

const SEEK_RESULTS: readonly ("success" | "failure")[] = ["success", "failure"];
for (const result of SEEK_RESULTS) {
    test(`a codec failure during a local seek is replanned after seek ${result}`, async () => {
        const r = await rig();
        await playMovie(r);
        r.avplay.tick(30000);
        r.controller.seekBy(-10);
        const calls = r.avplay.calls.length;
        r.avplay.listener?.onerror("PLAYER_ERROR_NOT_SUPPORTED_FORMAT");
        r.avplay.listener?.onerror("PLAYER_ERROR_NOT_SUPPORTED_FORMAT");
        assert.equal(bodies(r.h, "/replan").length, 0);
        assert.equal(r.avplay.calls.length, calls, "no transport call during seek");
        r.avplay.finishSeek(result === "failure" ? "NotSupportedError" : undefined);
        await r.h.clock.advance(0);
        const replan = only(bodies(r.h, "/replan"));
        assert.deepEqual(replan.failure, { classification: "avplay_playback_error" });
        assert.equal(replan.position_seconds, result === "success" ? 20 : 30);
        assert.equal(r.avplay.urls.length, 2, "the server's replacement transport opens once");
        r.avplay.finishPrepare();
        await r.h.clock.advance(0);
        r.avplay.finishSeek();
        await r.h.clock.advance(0);
        assert.equal(r.avplay.state, "PLAYING");
    });
}

test("backgrounding stops the session once and never reports progress or resumes afterward", async () => {
    const r = await rig();
    const id = await playMovie(r);
    r.avplay.tick(32000);
    r.controller.background();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.state, "NONE");
    const view = last(r.views);
    assert.deepEqual(view.phase === "error" ? view.error : undefined, { kind: "backgrounded" });
    assert.equal(only(bodies(r.h, `/playback/${id}`)).position, 32);
    const count = ops(r.h).length;
    r.controller.background();
    await r.h.clock.advance(60000);
    assert.equal(ops(r.h).length, count);
    assert.deepEqual(r.exits, []);
    r.controller.dismissError();
    assert.deepEqual(r.exits, ["error:backgrounded"]);
});

test("an approval to start playback received after backgrounding is stopped without opening AVPlay", async () => {
    const r = await rig();
    const held = r.h.fake.hold("/playback/start");
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    r.controller.background();
    held.release();
    await r.h.clock.advance(0);
    assert.deepEqual(r.avplay.urls, []);
    assert.equal(ops(r.h)[ops(r.h).length - 1], "DELETE /playback/S1");
    assert.equal(last(r.views).phase, "error");
    assert.deepEqual(r.exits, []);
});

test("backgrounding during a failed seek cancels its deferred replan and closes after settlement", async () => {
    const r = await rig();
    await playMovie(r);
    r.controller.seekBy(10);
    r.avplay.listener?.onerror("PLAYER_ERROR_NOT_SUPPORTED_FORMAT");
    const calls = r.avplay.calls.length;
    r.controller.background();
    assert.equal(r.avplay.calls.length, calls);
    r.avplay.finishSeek("NotSupportedError");
    await r.h.clock.advance(0);
    assert.equal(r.avplay.state, "NONE");
    assert.equal(bodies(r.h, "/replan").length, 0);
    const view = last(r.views);
    assert.deepEqual(view.phase === "error" ? view.error : undefined, { kind: "backgrounded" });
});
