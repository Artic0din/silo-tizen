// Issue 13, against the one playback controller. Numbers are the protocol's, not derived
// from the implementation: delays 1/2/4/8/15 s, 12 attempts, 135 s, a 30 s carried budget.

import assert from "node:assert/strict";
import { test } from "node:test";
import { PlaybackController, type PlaybackView, type PlayRequest } from "../../src/player/controller.ts";
import { fixture, problem, type RecordedRequest } from "./support/fakeSilo.ts";
import { FakeAVPlay } from "./support/fakeAVPlay.ts";
import { FakePlayback } from "./support/fakePlayback.ts";
import { connected, type Harness, signIn } from "./support/harness.ts";

const MOVIE: PlayRequest = { contentId: "movie-1", fileId: "42", title: "Movie", startSeconds: 12.5 };

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

function playback(h: Harness): RecordedRequest[] {
    return h.fake.requests.filter((request) => request.path.startsWith("/playback"));
}

function bodies(h: Harness, suffix: string): Record<string, unknown>[] {
    return playback(h).filter((request) => request.path.endsWith(suffix)).map((request) => request.body ?? {});
}

function starts(h: Harness): number {
    return playback(h).filter((request) => request.method === "POST" && request.path === "/playback/start").length;
}

function stops(h: Harness): number {
    return playback(h).filter((request) => request.method === "DELETE").length;
}

function replans(h: Harness): Record<string, unknown>[] {
    return bodies(h, "/replan");
}

function last(views: readonly PlaybackView[]): PlaybackView {
    const view = views[views.length - 1];
    assert.ok(view !== undefined);
    return view;
}

async function play(r: Rig, request: PlayRequest = MOVIE): Promise<string> {
    r.controller.play(request);
    await r.h.clock.advance(0);
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    if (r.avplay.calls[r.avplay.calls.length - 1]?.startsWith("seekTo") === true) {
        r.avplay.finishSeek();
        await r.h.clock.advance(0);
    }
    assert.equal(r.avplay.state, "PLAYING");
    const id = [...r.server.sessions.keys()].pop();
    assert.ok(id !== undefined);
    return id;
}

async function resumePlan(r: Rig): Promise<void> {
    await r.h.clock.advance(0);
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    if (r.avplay.calls[r.avplay.calls.length - 1]?.startsWith("seekTo") === true) {
        r.avplay.finishSeek();
        await r.h.clock.advance(0);
    }
}

for (const change of ["audio", "quality"] as const) test(`late user ${change} response cannot reopen the retired session`, async () => {
    const r = await rig();
    r.server.next.push({ availableQualities: [{ label: "original", preserves_source: true }, { label: "1080p-medium", height: 1080, bitrate_kbps: 6000, preserves_source: false }] });
    const old = await play(r);
    const held = r.h.fake.hold(`/playback/${old}/replan`, true);
    if (change === "audio") r.controller.selectAudio("file:42:audio:1");
    else r.controller.selectQuality("1080p-medium");
    await r.h.clock.advance(0);
    r.server.sessions.delete(old);
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(1000);
    await resumePlan(r);
    assert.equal(starts(r.h), 2);
    const successor = [...r.server.sessions.keys()].pop();
    assert.ok(successor !== undefined && successor !== old);
    const urls = r.avplay.urls.length;
    held.release();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.urls.length, urls, "late user change cannot open its predecessor");
    assert.equal(r.avplay.state, "PLAYING");
    assert.deepEqual(r.exits, []);
    r.controller.back();
    await r.h.clock.advance(0);
    assert.notEqual(r.server.session(successor).receipt, undefined);
});

test("show before the initial capability answer waits for initialization", async () => {
    const r = await rig();
    const held = r.h.fake.hold("/playback/capabilities", true);
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    r.controller.suspend();
    r.controller.restore();
    await r.h.clock.advance(0);
    assert.notEqual(last(r.views).phase, "error", "an unset installation is not a changed installation");
    assert.equal(r.h.fake.requests.filter(q => q.path === "/playback/capabilities").length, 1);
    held.release();
    await resumePlan(r);
    assert.equal(r.avplay.state, "PLAYING");
    assert.equal(starts(r.h), 1);
    r.controller.destroy();
});

for (const failed of [false, true]) test(`hide during local seek suspends after ${failed ? "failure" : "success"}`, async () => {
    const r = await rig();
    await play(r);
    r.controller.seekToSeconds(90);
    r.controller.suspend();
    r.avplay.finishSeek(failed ? "UnknownError" : undefined);
    await r.h.clock.advance(0);
    assert.equal(r.avplay.calls.filter(c => c === "suspend").length, 1, "seek settlement must suspend the hidden pipeline");
    r.controller.restore();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.calls.filter(c => c.startsWith("restoreAsync")).length, 1);
    r.avplay.finishRestore();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.state, "PLAYING");
    assert.equal(r.avplay.positionMs, failed ? 12500 : 90000);
    r.controller.destroy();
});

test("missing progress during a local seek leaves successor controls usable", async () => {
    const r = await rig();
    const old = await play(r);
    const held = r.h.fake.hold(`/playback/${old}/progress`, true);
    r.h.fake.script(`/playback/${old}/progress`, { status: 404 });
    await r.h.clock.advance(10000);
    r.controller.seekToSeconds(90);
    r.server.sessions.delete(old);
    held.release();
    await r.h.clock.advance(0);
    r.avplay.finishSeek();
    for (let i = 0; i < 10 && r.avplay.pendingPrepares === 0; i++) await r.h.clock.advance(0);
    assert.ok(r.avplay.pendingPrepares > 0, "replacement preparation is dispatched after seek settles");
    await resumePlan(r);
    r.controller.seekToSeconds(60);
    assert.equal(r.avplay.calls[r.avplay.calls.length - 1], "seekTo 60000", "replacement must accept a new seek");
    r.avplay.finishSeek();
    r.controller.selectAudio("file:42:audio:1");
    await r.h.clock.advance(0);
    assert.equal(replans(r.h).length, 1, "replacement must accept audio selection");
    await resumePlan(r);
    r.controller.back();
    await r.h.clock.advance(0);
    assert.deepEqual(r.exits, ["back"]);
});

test("hide and show keep one held recovery request until its answer is adopted", async () => {
    const r = await rig();
    const id = await play(r);
    const held = r.h.fake.hold(`/playback/${id}/replan`, true);
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(1000);
    assert.equal(replans(r.h).length, 1);
    r.controller.suspend();
    r.controller.restore();
    await r.h.clock.advance(0);
    assert.equal(replans(r.h).length, 1, "show must not overlap the held request");
    held.release();
    await resumePlan(r);
    assert.equal(r.avplay.state, "PLAYING");
    assert.equal(starts(r.h), 1);
    assert.equal(stops(r.h), 0);
    r.controller.back();
    await r.h.clock.advance(0);
    assert.notEqual(r.server.session(id).receipt, undefined);
});

for (const status of [404, 410]) test(`late predecessor progress ${status} cannot replace or end its successor`, async () => {
    const r = await rig();
    const old = await play(r);
    const held = r.h.fake.hold(`/playback/${old}/progress`, true);
    r.h.fake.script(`/playback/${old}/progress`, { status });
    r.avplay.tick(32000);
    await r.h.clock.advance(10000);
    r.server.sessions.delete(old);
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(1000);
    await resumePlan(r);
    const successor = [...r.server.sessions.keys()].pop();
    assert.ok(successor !== undefined && successor !== old);
    assert.equal(starts(r.h), 2);
    held.release();
    await r.h.clock.advance(0);
    assert.equal(starts(r.h), 2, "old progress must not restart the successor");
    assert.equal(r.avplay.state, "PLAYING");
    assert.deepEqual(r.exits, []);
    r.controller.back();
    await r.h.clock.advance(0);
    assert.notEqual(r.server.session(successor).receipt, undefined);
});

test("retiring a stale predecessor still waits for its own progress sequence", async () => {
    const r = await rig();
    const old = await play(r);
    const held = r.h.fake.hold(`/playback/${old}/progress`, true);
    r.avplay.tick(32000);
    await r.h.clock.advance(10000);
    r.h.fake.script(`/playback/${old}/replan`, problem(409, "stale_playback_plan", "Stale plan"));
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(1000);
    await resumePlan(r);
    assert.equal(starts(r.h), 2);
    assert.equal(stops(r.h), 0, "old STOP must wait for the held progress");
    const successor = [...r.server.sessions.keys()].pop();
    assert.ok(successor !== undefined && successor !== old);
    held.release();
    await r.h.clock.advance(0);
    const oldProgress = playback(r.h).find(q => q.path === `/playback/${old}/progress`);
    const oldStop = playback(r.h).find(q => q.method === "DELETE" && q.path === `/playback/${old}`);
    assert.equal(oldProgress?.body?.sequence, 1);
    assert.equal(oldStop?.body?.sequence, 2);
    assert.equal(oldStop?.body?.position, 32);
    assert.notEqual(r.server.session(old).receipt, undefined);
    assert.equal(r.server.session(successor).receipt, undefined);
    assert.equal(r.avplay.state, "PLAYING");
    r.controller.back();
    await r.h.clock.advance(0);
    assert.notEqual(r.server.session(successor).receipt, undefined);
});

for (const exit of ["back", "destroy"] as const) test(`a replacement START answered after ${exit} stops its own session`, async () => {
    const r = await rig();
    const old = await play(r);
    r.avplay.tick(32000);
    r.server.sessions.delete(old);
    const held = r.h.fake.hold("/playback/start", true);
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(1000);
    assert.equal(starts(r.h), 2, "replacement START is in flight");
    r.controller[exit]();
    await r.h.clock.advance(0);
    held.release();
    await r.h.clock.advance(0);
    const replacement = [...r.server.sessions.keys()].pop();
    assert.ok(replacement !== undefined && replacement !== old);
    assert.notEqual(r.server.session(replacement).receipt, undefined, "late replacement is stopped");
    const cleanup = playback(r.h).filter(request => request.method === "DELETE" && request.path === `/playback/${replacement}`);
    assert.equal(cleanup.length, 1);
    assert.equal(cleanup[0]?.body?.sequence, 1, "replacement starts its own sequence");
    assert.equal(cleanup[0]?.body?.position, 32);
    assert.equal(starts(r.h), 2);
    r.controller.destroy();
});

test("an unreachable reopened transport rejoins the same reconnect budget", async () => {
    const r = await rig();
    const id = await play(r);
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(1000);
    assert.equal(replans(r.h).length, 1);
    r.h.fake.script(`/playback/${id}/replan`, ...Array.from({ length: 20 }, () => ({ status: 503 })));
    r.avplay.finishPrepare("InvalidAccessError");
    await r.h.clock.advance(3000);
    const view = last(r.views);
    assert.equal(view.phase, "loading");
    assert.equal(view.phase === "loading" && view.detail, "reconnecting");
    assert.equal(stops(r.h), 0);
    assert.ok(replans(r.h).some(body => body.operation === "failure_recovery"), "an unplayed replacement first follows route recovery");
    await r.h.clock.advance(2000);
    const latest = replans(r.h);
    assert.equal(latest[latest.length - 1]?.operation, "track_change", "an unanswered route recovery rejoins no-op reconnect");
    r.controller.destroy();
});

test("the stable reconnect window starts when the replacement plays", async () => {
    const r = await rig();
    await play(r);
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(1000);
    await r.h.clock.advance(29000);
    await resumePlan(r);
    await r.h.clock.advance(1000);
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(1999);
    assert.equal(replans(r.h).length, 1, "one second of stable playback keeps the previous attempt budget");
    await r.h.clock.advance(1);
    assert.equal(replans(r.h).length, 2);
    r.controller.destroy();
});

test("a hidden pending prepare retains its startup deadline", async () => {
    const r = await rig();
    await play(r);
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(1000);
    assert.equal(replans(r.h).length, 1);
    r.controller.suspend();
    await r.h.clock.advance(30000);
    r.controller.restore();
    await r.h.clock.advance(0);
    assert.equal(replans(r.h).length, 1, "show does not duplicate the pending preparation");
    await r.h.clock.advance(29999);
    assert.equal(replans(r.h).length, 1);
    await r.h.clock.advance(1);
    assert.equal(replans(r.h).length, 2, "the original 60-second startup deadline still fires");
    assert.equal(replans(r.h)[1]?.operation, "failure_recovery");
    r.controller.destroy();
});

for (const change of ["audio", "quality"] as const) test(`an unanswered ${change} change cannot cut a reconnect budget short`, async () => {
    const r = await rig();
    r.server.next.push({ availableQualities: [{ label: "original", preserves_source: true }, { label: "1080p-medium", display_name: "1080p Medium", height: 1080, bitrate_kbps: 6000, preserves_source: false }] });
    const id = await play(r);
    r.h.fake.script(`/playback/${id}/replan`, ...Array.from({ length: 30 }, () => ({ status: 503 })));
    if (change === "audio") r.controller.selectAudio("file:42:audio:1");
    else r.controller.selectQuality("1080p-medium");
    await r.h.clock.advance(0);
    assert.equal(replans(r.h).length, 1, "user change was dispatched");
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(10000);
    const view = last(r.views);
    assert.equal(view.phase, "loading");
    assert.equal(view.phase === "loading" && view.detail, "reconnecting");
    assert.equal(stops(r.h), 0);
    assert.equal(starts(r.h), 1);
    assert.ok(replans(r.h).length > 3, "the reconnect loop outlives the user change's three sends");
    r.controller.destroy();
});

test("a pending preparation cannot play before foreground authority is revalidated", async () => {
    const r = await rig();
    await play(r);
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(1000);
    r.controller.suspend();
    const gate = r.h.fake.hold("/playback/capabilities", true);
    r.controller.restore();
    await r.h.clock.advance(0);
    await resumePlan(r);
    assert.equal(r.avplay.calls.filter(call => call === "play").length, 1, "the held foreground gate prevents playback");
    gate.release();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.calls.filter(call => call === "play").length, 2);
    assert.equal(r.avplay.state, "PLAYING");
    r.controller.destroy();
});

test("an obsolete restore cannot resume through a newer held authority check", async () => {
    const r = await rig();
    await play(r);
    r.controller.suspend();
    r.controller.restore();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.calls.filter(call => call.startsWith("restoreAsync")).length, 1);
    r.controller.suspend();
    const gate = r.h.fake.hold("/playback/capabilities", true);
    r.controller.restore();
    await r.h.clock.advance(0);
    r.avplay.finishRestore();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.calls.filter(call => call === "suspend").length, 3, "the obsolete auto-resume is suspended while the new gate is held");
    gate.release();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.calls.filter(call => call.startsWith("restoreAsync")).length, 2);
    r.avplay.finishRestore();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.state, "PLAYING");
    r.controller.destroy();
});

test("returning during an outage resumes the bounded reconnect timer", async () => {
    const r = await rig();
    const id = await play(r);
    r.h.fake.script(`/playback/${id}/replan`, ...Array.from({ length: 20 }, () => ({ status: 503 })));
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    r.controller.suspend();
    r.h.fake.script("/playback/capabilities", ...Array.from({ length: 5 }, () => ({ status: 503 })));
    r.controller.restore();
    await r.h.clock.advance(320000);
    assert.equal(replans(r.h).length, 12);
    const view = last(r.views);
    assert.equal(view.phase, "error");
    assert.equal(view.phase === "error" && view.retryable, true);
    assert.equal(stops(r.h), 0);
    r.controller.destroy();
});

test("a second hide fences a pending foreground capability check", async () => {
    const r = await rig();
    await play(r);
    r.avplay.tick(32000);
    r.controller.suspend();
    const gate = r.h.fake.hold("/playback/capabilities", true);
    r.controller.restore();
    await r.h.clock.advance(0);
    r.controller.suspend();
    const progress = bodies(r.h, "/progress").length;
    gate.release();
    await r.h.clock.advance(60000);
    assert.equal(r.avplay.calls.filter(call => call.startsWith("restoreAsync")).length, 0);
    assert.equal(r.avplay.calls.filter(call => call === "suspend").length, 2);
    assert.equal(bodies(r.h, "/progress").length, progress);
    r.controller.restore();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.calls.filter(call => call.startsWith("restoreAsync")).length, 1);
    r.avplay.finishRestore();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.state, "PLAYING");
    r.controller.destroy();
});

test("a hidden app re-suspends an obsolete native restore callback", async () => {
    const r = await rig();
    await play(r);
    r.controller.suspend();
    r.controller.restore();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.calls.filter(call => call.startsWith("restoreAsync")).length, 1);
    r.controller.suspend();
    const progress = bodies(r.h, "/progress").length;
    r.avplay.finishRestore();
    await r.h.clock.advance(60000);
    assert.equal(r.avplay.calls.filter(call => call === "suspend").length, 3);
    assert.equal(bodies(r.h, "/progress").length, progress);
    r.controller.destroy();
});

test("a lost connection replans with a no-op track change and does not blacklist the route", async () => {
    const r = await rig();
    const id = await play(r);
    r.avplay.tick(32000);
    r.controller.setPaused(true);
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(999);
    assert.equal(replans(r.h).length, 0, "the first wait is one second");
    assert.equal(stops(r.h), 0);
    await r.h.clock.advance(1);
    const replan = replans(r.h)[0];
    assert.ok(replan !== undefined);
    assert.equal(replans(r.h).length, 1, "a second loss joins the cycle");
    assert.equal(replan.operation, "track_change");
    assert.equal("failure" in replan, false);
    assert.deepEqual(replan.attempted_plan_keys, []);
    assert.equal(replan.position_seconds, 32);
    assert.deepEqual(replan.selected_tracks, { audio: { id: "file:42:audio:0", index: 0 } });
    assert.equal(replan.playback_attempt_id, bodies(r.h, "/start")[0]?.playback_attempt_id);
    assert.equal(starts(r.h), 1);
    const loading = last(r.views);
    assert.equal(loading.phase, "loading");
    assert.equal(loading.phase === "loading" ? loading.detail : undefined, "reconnecting");
    r.server.next.push({ timeline: { source_start_seconds: 32, player_start_seconds: 32, timeline_offset_seconds: 0 } });
    await resumePlan(r);
    assert.equal(r.avplay.state, "PAUSED", "playing intent was paused");
    assert.equal(stops(r.h), 0);
    assert.equal(r.server.session(id).receipt, undefined);
    r.controller.destroy();
});

test("an offset timeline reconnects at source time, and a carried budget waits two seconds", async () => {
    const r = await rig();
    r.server.next.push({
        timeline: {
            source_start_seconds: 600,
            stream_origin_seconds: 594,
            player_start_seconds: 6,
            timeline_offset_seconds: 594,
            can_seek_anywhere: false,
        },
    });
    await play(r, { ...MOVIE, startSeconds: 600 });
    r.avplay.tick(16000);
    r.server.next.push({
        timeline: { source_start_seconds: 610, player_start_seconds: 16, timeline_offset_seconds: 594, can_seek_anywhere: false },
    });
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(1000);
    assert.equal(replans(r.h)[0]?.position_seconds, 610);
    await resumePlan(r);
    assert.equal(r.avplay.state, "PLAYING");
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(1999);
    assert.equal(replans(r.h).length, 1, "within 30s the next wait is the carried two seconds");
    await r.h.clock.advance(1);
    assert.equal(replans(r.h).length, 2);
    assert.equal(replans(r.h)[1]?.position_seconds, 610);
    assert.equal("failure" in (replans(r.h)[1] ?? {}), false);
    r.controller.destroy();
});

test("thirty stable seconds restore a full budget", async () => {
    const r = await rig();
    await play(r);
    r.avplay.tick(20000);
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(1000);
    await resumePlan(r);
    await r.h.clock.advance(30000);
    r.avplay.tick(40000);
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(999);
    assert.equal(replans(r.h).length, 1);
    await r.h.clock.advance(1);
    assert.equal(replans(r.h).length, 2);
    assert.equal(replans(r.h)[1]?.position_seconds, 40);
    r.controller.destroy();
});

test("twelve unanswered attempts span 135 seconds and then stop without a thirteenth", async () => {
    const r = await rig();
    const id = await play(r);
    const path = `/playback/${id}/replan`;
    r.h.fake.script(path, ...Array.from({ length: 20 }, () => ({ status: 503 })));
    r.avplay.tick(15000);
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    const waits = [1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000, 15000, 15000, 15000, 15000];
    for (const wait of waits) {
        const before = replans(r.h).length;
        await r.h.clock.advance(wait - 1);
        assert.equal(replans(r.h).length, before);
        await r.h.clock.advance(1);
        assert.equal(replans(r.h).length, before + 1);
    }
    assert.equal(replans(r.h).length, 12);
    assert.ok(replans(r.h).every((body) => body.operation === "track_change" && !("failure" in body)));
    await r.h.clock.advance(60000);
    assert.equal(replans(r.h).length, 12);
    assert.equal(starts(r.h), 1);
    assert.equal(stops(r.h), 0);
    const view = last(r.views);
    assert.equal(view.phase, "error");
    assert.deepEqual(view.phase === "error" ? view.error : undefined, { kind: "network" });
    assert.equal(view.phase === "error" ? view.retryable : false, true);
    r.controller.retryCompletion();
    await r.h.clock.advance(0);
    assert.equal(replans(r.h).length, 13, "try again spends a fresh budget immediately");
    r.controller.back();
    await r.h.clock.advance(0);
    assert.equal(stops(r.h), 1);
    const stop = playback(r.h).filter((request) => request.method === "DELETE")[0]?.body;
    assert.equal(stop?.position, 15);
    assert.equal(stop?.is_paused, false);
    assert.deepEqual(r.exits, ["back"]);
    r.controller.destroy();
});

test("a 404 replan starts one session at the saved position and tracks, and a terminal start does not start again", async () => {
    const recovered = await rig();
    const id = await play(recovered);
    recovered.controller.selectAudio("file:42:audio:1");
    await recovered.h.clock.advance(0);
    await resumePlan(recovered);
    recovered.avplay.tick(45000);
    recovered.server.sessions.delete(id);
    recovered.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await recovered.h.clock.advance(1000);
    await recovered.h.clock.advance(0);
    assert.equal(replans(recovered.h).length, 2, "the accepted audio change, then the no-op that 404s");
    assert.equal(starts(recovered.h), 2);
    const replacement = bodies(recovered.h, "/start")[1];
    assert.equal(replacement?.start_position, 45);
    assert.equal(replacement?.audio_track_id, "file:42:audio:1");
    assert.equal("subtitle_track_id" in (replacement ?? {}), false);
    assert.notEqual(replacement?.playback_attempt_id, bodies(recovered.h, "/start")[0]?.playback_attempt_id);
    assert.equal(stops(recovered.h), 0);
    recovered.controller.destroy();

    const terminal = await rig();
    const gone = await play(terminal);
    terminal.server.sessions.delete(gone);
    terminal.server.next.push({ terminal: "source_unreadable", retryable: false });
    terminal.avplay.tick(8000);
    terminal.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await terminal.h.clock.advance(1000);
    await terminal.h.clock.advance(0);
    assert.equal(starts(terminal.h), 2);
    await terminal.h.clock.advance(135000);
    assert.equal(starts(terminal.h), 2, "a terminal start is not retried");
    assert.equal(stops(terminal.h), 0);
    const view = last(terminal.views);
    assert.equal(view.phase === "error" && view.error.kind === "terminal" ? view.error.reason : "", "source_unreadable");
    terminal.controller.destroy();
});

test("410, a changed installation and a revoked login do not start a replacement", async () => {
    const ended = await rig();
    const endedId = await play(ended);
    ended.server.endByAdmin(endedId);
    ended.avplay.tick(10000);
    ended.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await ended.h.clock.advance(1000);
    assert.deepEqual(ended.exits, ["end:ended_by_server"]);
    assert.equal(starts(ended.h), 1);
    assert.equal(stops(ended.h), 0);
    await ended.h.clock.advance(60000);
    assert.equal(starts(ended.h), 1);

    const moved = await rig();
    const movedId = await play(moved);
    moved.h.fake.script(`/playback/${movedId}/replan`, { status: 409, headers: { "Content-Type": "application/problem+json" }, body: fixture("playback_installation_changed") });
    moved.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await moved.h.clock.advance(1000);
    await moved.h.clock.advance(60000);
    assert.equal(starts(moved.h), 1);
    assert.equal(stops(moved.h), 0);
    const movedView = last(moved.views);
    assert.deepEqual(movedView.phase === "error" ? movedView.error : undefined, { kind: "installation_changed" });

    const revoked = await rig();
    const revokedId = await play(revoked);
    revoked.h.fake.script(`/playback/${revokedId}/replan`, problem(403, "forbidden", "Forbidden"));
    revoked.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await revoked.h.clock.advance(1000);
    await revoked.h.clock.advance(60000);
    assert.equal(starts(revoked.h), 1);
    assert.equal(stops(revoked.h), 0);
    const revokedView = last(revoked.views);
    assert.deepEqual(revokedView.phase === "error" ? revokedView.error : undefined, { kind: "revoked" });
    revoked.controller.destroy();
    moved.controller.destroy();
});

test("cancel, authority loss and a hidden timer do not send the reconnect, and stop stays last", async () => {
    const cancel = await rig();
    const id = await play(cancel);
    const held = cancel.h.fake.hold(`/playback/${id}/progress`);
    cancel.avplay.tick(22000);
    await cancel.h.clock.advance(10000);
    cancel.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await cancel.h.clock.advance(500);
    cancel.controller.back();
    held.release();
    await cancel.h.clock.advance(0);
    await cancel.h.clock.advance(60000);
    assert.equal(replans(cancel.h).length, 0);
    assert.equal(stops(cancel.h), 1);
    const stop = playback(cancel.h).filter((request) => request.method === "DELETE").pop()?.body;
    assert.equal(stop?.position, 22);
    assert.equal(stop?.is_paused, false);
    const progress = bodies(cancel.h, "/progress");
    assert.ok(progress.length >= 1);
    assert.ok(Number(stop?.sequence) > Number(progress[progress.length - 1]?.sequence));
    assert.deepEqual(cancel.exits, ["back"]);

    const authority = await rig();
    await play(authority);
    authority.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    authority.h.core.profiles.clear();
    await authority.h.clock.advance(60000);
    assert.equal(replans(authority.h).length, 0);
    assert.equal(stops(authority.h), 0);
    assert.deepEqual(authority.exits, ["end:authority_changed"]);

    const hidden = await rig();
    const hiddenId = await play(hidden);
    const progressBefore = bodies(hidden.h, "/progress").length;
    hidden.avplay.tick(18000);
    hidden.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    hidden.controller.suspend();
    await hidden.h.clock.advance(5000);
    assert.equal(replans(hidden.h).length, 0, "the hidden timer is not assumed to fire");
    assert.equal(bodies(hidden.h, "/progress").length, progressBefore);
    hidden.controller.restore();
    await hidden.h.clock.advance(0);
    await hidden.h.clock.advance(0);
    assert.equal(replans(hidden.h).length, 1);
    assert.equal(replans(hidden.h)[0]?.position_seconds, 18);
    assert.equal(hidden.server.session(hiddenId).receipt, undefined);
    hidden.controller.destroy();
});

test("a network failure before the first frame still stops, and an unanswered route recovery joins reconnect", async () => {
    const early = await rig();
    early.controller.play(MOVIE);
    await early.h.clock.advance(0);
    early.avplay.finishPrepare("InvalidAccessError");
    await early.h.clock.advance(0);
    assert.equal(replans(early.h).length, 0);
    assert.equal(stops(early.h), 1);
    const earlyView = last(early.views);
    assert.deepEqual(earlyView.phase === "error" ? earlyView.error : undefined, { kind: "network" });

    const route = await rig();
    const id = await play(route);
    route.h.fake.dropNextAnswer(`/playback/${id}/replan`);
    route.h.fake.dropNextAnswer(`/playback/${id}/replan`);
    route.h.fake.dropNextAnswer(`/playback/${id}/replan`);
    route.avplay.listener?.onerror("PLAYER_ERROR_NOT_SUPPORTED_FORMAT");
    await route.h.clock.advance(0);
    await route.h.clock.advance(1000);
    await route.h.clock.advance(2000);
    const failure = replans(route.h);
    assert.equal(failure.length, 3);
    assert.ok(failure.every((body) => body.operation === "failure_recovery"));
    await route.h.clock.advance(1000);
    const joined = replans(route.h)[3];
    assert.equal(joined?.operation, "track_change");
    assert.equal("failure" in (joined ?? {}), false);
    assert.deepEqual(joined?.attempted_plan_keys, []);
    assert.equal(stops(route.h), 1, "a stale plan's live predecessor is retired after replacement");
    assert.notEqual(route.server.session(id).receipt, undefined);
    const replacementId = [...route.server.sessions.keys()].pop();
    assert.ok(replacementId !== undefined && replacementId !== id);
    assert.equal(route.server.session(replacementId).receipt, undefined, "replacement remains open");
    route.controller.destroy();
});

test("warm suspend restores the pipeline with a fresh token; a failed restore replans", async () => {
    const warm = await rig();
    const id = await play(warm);
    warm.avplay.tick(32000);
    warm.controller.setPaused(true);
    const progressBefore = bodies(warm.h, "/progress").length;
    const opened = warm.avplay.urls[0] ?? "";
    warm.controller.suspend();
    assert.ok(warm.avplay.calls.includes("suspend"));
    assert.equal(warm.avplay.state, "PAUSED");
    assert.equal(stops(warm.h), 0);
    await warm.h.clock.advance(3600000);
    assert.equal(bodies(warm.h, "/progress").length, progressBefore, "no progress while hidden");
    warm.controller.restore();
    await warm.h.clock.advance(0);
    await warm.h.clock.advance(0);
    const restoring = warm.avplay.calls.filter((call) => call.startsWith("restoreAsync"));
    assert.equal(restoring.length, 1);
    assert.match(restoring[0] ?? "", /prepare=false/);
    assert.match(restoring[0] ?? "", / 32000 /);
    assert.equal(starts(warm.h), 1);
    assert.ok(playback(warm.h).filter((request) => request.path === "/playback/capabilities").length >= 2);
    warm.avplay.finishRestore();
    await warm.h.clock.advance(0);
    assert.equal(warm.avplay.state, "PAUSED");
    const restoredUrl = warm.avplay.urls[warm.avplay.urls.length - 1];
    assert.notEqual(restoredUrl, opened);
    assert.match(restoredUrl ?? "", /token=/);
    assert.equal(warm.server.session(id).receipt, undefined);
    warm.controller.destroy();

    const cold = await rig();
    await play(cold);
    cold.avplay.tick(9000);
    cold.controller.suspend();
    cold.controller.restore();
    await cold.h.clock.advance(0);
    cold.avplay.finishRestore("InvalidAccessError");
    await cold.h.clock.advance(0);
    assert.equal(replans(cold.h).length, 0, "the failed restore waits out the reconnect delay");
    await cold.h.clock.advance(1000);
    assert.equal(replans(cold.h)[0]?.operation, "track_change");
    assert.equal(replans(cold.h)[0]?.position_seconds, 9);
    assert.equal("failure" in (replans(cold.h)[0] ?? {}), false);
    cold.controller.destroy();
});

test("a cold relaunch has nothing to restore, and hide during the next-episode handoff still cancels it", async () => {
    const cold = await rig();
    cold.controller.restore();
    await cold.h.clock.advance(60000);
    assert.equal(playback(cold.h).length, 0);
    assert.deepEqual(cold.avplay.calls, []);

    const ending = await rig();
    await play(ending, { ...MOVIE, episode: true });
    ending.avplay.listener?.onstreamcompleted();
    await ending.h.clock.advance(0);
    assert.equal(last(ending.views).phase, "completion");
    ending.controller.suspend();
    await ending.h.clock.advance(0);
    assert.equal(last(ending.views).phase, "closed");
    assert.deepEqual(ending.exits, ["back"]);
    ending.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await ending.h.clock.advance(60000);
    assert.equal(starts(ending.h), 1);
    ending.controller.destroy();
});

test("a refused subtitle stays a refusal, and natural end still completes", async () => {
    const r = await rig();
    const id = await play(r);
    r.controller.selectSubtitle("file:42:subtitle:0");
    await r.h.clock.advance(0);
    const view = last(r.views);
    assert.equal(view.phase === "playing" ? view.tracks.change.state : "", "refused");
    assert.equal(replans(r.h).length, 1);
    assert.equal(r.avplay.state, "PLAYING");
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.deepEqual(r.exits, ["end:completed"]);
    assert.equal(stops(r.h), 1);
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(60000);
    assert.equal(starts(r.h), 1);
    assert.equal(replans(r.h).length, 1);
    assert.notEqual(r.server.session(id).receipt, undefined);
    r.controller.destroy();
});
