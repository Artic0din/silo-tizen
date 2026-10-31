// The native playback controller against the fake Silo's playback operations and a fake AVPlay
// that keeps the platform's state order and uncancellable callbacks. Each test checks the server
// requests and source positions, not only what the player shows.

import assert from "node:assert/strict";
import { test } from "node:test";
import { type PlaybackError, PlaybackController, type PlaybackView, type PlayRequest } from "../../src/player/controller.ts";
import { FakeAVPlay } from "./support/fakeAVPlay.ts";
import { FakePlayback } from "./support/fakePlayback.ts";
import { fixture, problem, type RecordedRequest } from "./support/fakeSilo.ts";
import { FakeSettings } from "./support/fakeSettings.ts";
import { FakeCatalog } from "./support/fakeCatalog.ts";
import { SEEK_BACK_KEY, SEEK_FORWARD_KEY, SEEK_KEYS } from "../../src/contracts/v2/settings.ts";
import { operations } from "../../src/api/operations.ts";
import { connected, type Harness, signIn } from "./support/harness.ts";

const MOVIE: PlayRequest = { contentId: "movie-1", fileId: "42", title: "Movie", startSeconds: 12.5 };

test("sidecar subtitles apply profile appearance and timing without blocking playback on failure", async () => {
    for (const fail of [false, true]) {
        const r = await rig();
        r.server.next.push({ subtitle: 0, subtitleArtifact: { url: `${r.h.fake.origin}/api/v2/captions?token=synthetic`, format: "vtt", timing_origin_seconds: 0 } });
        r.h.fake.script("/captions?token=synthetic", fail ? { status: 404 } : { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nHello" });
        r.h.fake.script("/settings/subtitle-appearance/effective", { status: 200, body: { profile_id: "p-owner", effective_value: JSON.stringify({ fontSize: "xxlarge", position: "top" }) } });
        r.h.fake.script("/settings/values/effective?keys=player.subtitle_sync_ms", { status: 200, body: { items: [{ key: "player.subtitle_sync_ms", value: 1000 }] } });
        await playMovie(r);
        r.avplay.tick(12500);
        let view = last(r.views);
        assert.ok(view.phase === "playing");
        assert.equal(view.captions?.text, "");
        r.avplay.tick(13500);
        view = last(r.views);
        assert.ok(view.phase === "playing");
        assert.equal(view.captions?.text, fail ? "" : "Hello");
        if (!fail) assert.equal(view.captions?.appearance.fontSize, "xxlarge");
        else assert.ok(view.tracks.notices.some(notice => notice.includes("Could not load")));
        r.controller.destroy();
    }
});

test("an audio replan with the same subtitle artifact keeps cues and preferences without refetching", async () => {
    const r = await rig();
    const artifact = { url: `${r.h.fake.origin}/api/v2/captions?token=synthetic`, format: "vtt", timing_origin_seconds: 0 };
    r.server.next.push({ subtitle: 0, subtitleArtifact: artifact }, { subtitle: 0, subtitleArtifact: artifact });
    r.h.fake.script("/captions?token=synthetic", { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:30.000\nHello" });
    r.h.fake.script("/settings/subtitle-appearance/effective", { status: 200, body: { profile_id: "p-owner", effective_value: JSON.stringify({ fontSize: "xxlarge" }) } });
    await playMovie(r);
    r.controller.selectAudio("file:42:audio:1");
    await r.h.clock.advance(0);
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    if (r.avplay.calls[r.avplay.calls.length - 1]?.startsWith("seekTo") === true) r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(r.h.fake.requests.filter(request => request.path.includes("/replan")).length, 1);
    r.avplay.tick(13000);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.captions?.text, "Hello");
    assert.equal(view.captions?.appearance.fontSize, "xxlarge");
    assert.equal(r.h.fake.requests.filter(request => request.path.startsWith("/captions")).length, 1);
    assert.equal(r.h.fake.requests.filter(request => request.path.startsWith("/settings/subtitle-appearance")).length, 1);
    r.controller.destroy();
});
const BOUNDED_IDENTIFIER =/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
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

async function rig(profileId = "p-owner"): Promise<Rig> {
    const h = await connected();
    await signIn(h);
    const owner = (await h.core.profiles.list()).find((profile) => profile.id === profileId);
    assert.ok(owner !== undefined);
    h.core.profiles.select(owner);
    if (owner.hasPin) assert.deepEqual(await h.core.profiles.verifyPin(owner.id, "2468"), { status: "verified" });
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

test("effective file markers follow source time and cannot replace an in-flight manual seek", async () => {
    const r = await rig();
    r.h.fake.scripted.set("/markers/files/42", [{ status: 200, body: {
        file_id: "42", marker_segments: [
            { kind: "recap", start_seconds: 0, end_seconds: 15 },
            { kind: "intro", start_seconds: 20, end_seconds: 60 },
            { kind: "credits", start_seconds: 90, end_seconds: 100 },
        ],
    } }]);
    await playMovie(r);
    for (const [seconds, kind] of [[12.5, "recap"], [15, undefined], [20, "intro"], [60, undefined], [90, "credits"], [100, undefined]] as const) {
        r.avplay.tick(seconds * 1000);
        const view = last(r.views);
        assert.ok(view.phase === "playing");
        assert.equal(view.skipMarker?.kind, kind);
    }
    r.avplay.tick(25000);
    r.controller.seekToSeconds(80);
    r.controller.seekToSeconds(60);
    assert.equal(r.avplay.calls[r.avplay.calls.length - 1], "seekTo 80000");
    r.avplay.finishSeek();
    assert.equal(r.avplay.positionMs, 80000);
    assert.equal(r.h.fake.requests.filter(request => request.path.startsWith("/markers/")).length, 1);
    r.controller.destroy();
});

test("failed markers are optional and a late response cannot escape a closed attempt", async () => {
    for (const late of [false, true]) {
        const r = await rig();
        r.h.fake.scripted.set("/markers/files/42", [{ status: late ? 200 : 404, body: late ? {
            file_id: "42", marker_segments: [{ kind: "intro", start_seconds: 0, end_seconds: 60 }],
        } : {} }]);
        const hold = late ? r.h.fake.hold("/markers/files/42", true) : undefined;
        await playMovie(r);
        const view = last(r.views);
        assert.ok(view.phase === "playing");
        assert.equal(view.skipMarker, undefined);
        assert.deepEqual(r.errors, []);
        r.controller.destroy();
        const count = r.views.length;
        hold?.release();
        await r.h.clock.advance(0);
        assert.equal(r.views.length, count);
    }
});

test("supported seek defaults are 10/30 and unbatched discovery uses legal single reads", async () => {
    for (const batched of [true, false]) {
        const r = await rig();
        const settings = new FakeSettings(r.h.fake);
        settings.supportsBatchedEffective = batched;
        try {
            await playMovie(r);
            const view = last(r.views);
            assert.ok(view.phase === "playing");
            assert.deepEqual(view.seekIntervals, { backward: 10, forward: 30 });
            const reads = r.h.fake.requests.filter(request => request.path.startsWith("/settings/values/effective?"));
            assert.equal(reads.length, batched ? 2 : 4);
            if (!batched) assert.ok(reads.every(request => new URL(request.path, "https://fake.invalid").searchParams.getAll("keys").length === 1));
            assert.ok(reads.every(request => request.headers["x-profile-id"] === "p-owner"));
        } finally { r.controller.destroy(); }
    }
});

test("confirmed 15/45 deltas clamp in the real controller at zero and source duration", async () => {
    const r = await rig();
    const settings = new FakeSettings(r.h.fake);
    settings.profile().set(SEEK_BACK_KEY, 15);
    settings.profile().set(SEEK_FORWARD_KEY, 45);
    r.server.next.push({ durationSeconds: 200, timeline: { source_start_seconds: 100, player_start_seconds: 100, timeline_offset_seconds: 0 } });
    try {
        await playMovie(r);
        r.avplay.tick(5000);
        r.controller.seekBy(-15);
        assert.equal(r.avplay.calls[r.avplay.calls.length - 1], "seekTo 0");
        r.avplay.finishSeek();
        r.avplay.tick(190000);
        r.controller.seekBy(45);
        assert.equal(r.avplay.calls[r.avplay.calls.length - 1], "seekTo 200000");
        r.avplay.finishSeek();
    } finally { r.controller.destroy(); }
});

test("unsupported seek contracts keep legacy 10/10 without requesting unknown keys", async () => {
    for (const unsupported of ["revision8", "denied", "missing", "profile_client", "integer", "enum20", "future-member", "missing-capability", "denied-capability"] as const) {
        const r = await rig();
        const settings = new FakeSettings(r.h.fake);
        if (unsupported === "revision8") settings.revision = 8;
        if (unsupported === "denied") settings.allowed = false;
        if (unsupported === "missing-capability" || unsupported === "denied-capability") r.h.fake.script("/settings/contract/capabilities", problem(unsupported === "missing-capability" ? 404 : 403, "not_available", "Unavailable"));
        const contract = fixture("settings_contract_ok");
        assert.ok(Array.isArray(contract.definitions));
        contract.definitions = contract.definitions.flatMap(def => {
            if (def.key !== SEEK_FORWARD_KEY) return [def];
            if (unsupported === "missing") return [];
            if (unsupported === "profile_client") return [{ ...def, allowed_scopes: ["profile_client"] }];
            if (unsupported === "integer") return [{ ...def, value_schema: { type: "integer", minimum: 5, maximum: 90 } }];
            if (unsupported === "enum20") return [{ ...def, value_schema: { type: "enum", values: [{ value: 20, label: "20 seconds" }] } }];
            if (unsupported === "future-member") return [{ ...def, value_schema: { type: "enum", values: [5, 10, 15, 30, 45, 60, 90].map(value => ({ value, label: `${value} seconds`, introduced_in: value === 45 ? 25 : 9 })) } }];
            return [def];
        });
        r.h.fake.script("/settings/contract", { status: 200, body: contract });
        try {
            await playMovie(r);
            const view = last(r.views);
            assert.ok(view.phase === "playing", unsupported);
            assert.deepEqual(view.seekIntervals, { backward: 10, forward: 10 });
            assert.equal(r.h.fake.requests.filter(request => request.path.startsWith("/settings/values") && request.path.includes("player.video_skip")).length, 0, unsupported);
        } finally { r.controller.destroy(); }
    }
});

test("supported seek read failures and malformed/missing/duplicate rows fail visibly and Retry re-reads", async () => {
    const path = operations.effectiveSettings(SEEK_KEYS).path;
    const row = (key: string, value: unknown) => ({ key, value, source: "profile", definition_revision: 24 });
    const valid = row(SEEK_BACK_KEY, 15);
    for (const items of [[], [valid], [valid, valid, row(SEEK_FORWARD_KEY, 45)], ...[null, "15", 15.5, 20, false].map(value => [row(SEEK_BACK_KEY, value), row(SEEK_FORWARD_KEY, 45)])]) {
        const r = await rig();
        new FakeSettings(r.h.fake);
        r.h.fake.script(path, { status: 200, body: { revision: 24, items } });
        try {
            r.controller.play(MOVIE);
            await r.h.clock.advance(0);
            const view = last(r.views);
            assert.ok(view.phase === "error");
            assert.equal(view.error.kind, "settings");
            assert.equal(bodies(r.h, "/start").length, 0);
            assert.equal(r.avplay.urls.length, 0);
            r.controller.retrySettings();
            await r.h.clock.advance(0);
            assert.equal(bodies(r.h, "/start").length, 1);
        } finally { r.controller.destroy(); }
    }
    for (const path of ["/settings/contract/capabilities", "/settings/contract", operations.effectiveSettings(SEEK_KEYS).path]) {
        const r = await rig();
        new FakeSettings(r.h.fake);
        r.h.fake.script(path, ...Array.from({ length: 3 }, () => problem(503, "unavailable", "Unavailable")));
        r.controller.play(MOVIE);
        await r.h.clock.advance(5000);
        assert.equal(last(r.views).phase, "error");
        assert.equal(bodies(r.h, "/start").length, 0);
        r.controller.destroy();
    }
});

test("profile and attempt replacement discard held seek answers before any old start", async () => {
    for (const replacement of ["profile", "attempt", "back"] as const) {
        const r = await rig();
        const settings = new FakeSettings(r.h.fake);
        settings.profile().set(SEEK_BACK_KEY, 15);
        settings.profile().set(SEEK_FORWARD_KEY, 45);
        const path = operations.effectiveSettings(SEEK_KEYS).path;
        const hold = r.h.fake.hold(path, true);
        r.controller.play(MOVIE);
        await r.h.clock.advance(0);
        assert.equal(last(r.views).phase, "loading");
        if (replacement === "profile") {
            const profiles = await r.h.core.profiles.list();
            const kid = profiles.find(profile => profile.id === "p-kid");
            assert.ok(kid);
            r.h.core.profiles.select(kid);
            await r.h.core.profiles.verifyPin(kid.id, "2468");
            settings.profile(kid.id).set(SEEK_FORWARD_KEY, 60);
            r.controller.play(MOVIE);
        } else if (replacement === "attempt") {
            settings.profile().set(SEEK_FORWARD_KEY, 90);
            r.controller.play(MOVIE);
        } else r.controller.back();
        await r.h.clock.advance(0);
        hold.release();
        await r.h.clock.advance(0);
        assert.equal(bodies(r.h, "/start").length, replacement === "back" ? 0 : 1);
        if (replacement !== "back") {
            r.avplay.finishPrepare();
            r.avplay.finishSeek();
            const view = last(r.views);
            assert.ok(view.phase === "playing");
            assert.deepEqual(view.seekIntervals, replacement === "profile" ? { backward: 10, forward: 60 } : { backward: 15, forward: 90 });
        }
        r.controller.destroy();
    }
});

test("explicit pause and play are idempotent and leave pending seeks alone", async () => {
    const r = await rig();
    await playMovie(r);
    assert.equal(typeof r.controller.setPaused, "function");
    const before = r.avplay.calls.length;
    r.controller.setPaused(false);
    r.controller.setPaused(true);
    r.controller.setPaused(true);
    r.controller.setPaused(false);
    assert.deepEqual(r.avplay.calls.slice(before), ["pause", "play"]);
    r.controller.seekBy(10);
    r.controller.setPaused(true);
    assert.equal(r.avplay.calls[r.avplay.calls.length - 1], "seekTo 22500");
    r.avplay.finishSeek();
    r.controller.destroy();
});

test("committing an absolute source seek does not drift with live progress", async () => {
    const r = await rig();
    await playMovie(r);
    assert.equal(typeof r.controller.seekToSeconds, "function");
    r.avplay.tick(30000);
    r.controller.seekToSeconds(45);
    assert.equal(r.avplay.calls[r.avplay.calls.length - 1], "seekTo 45000");
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    const view = last(r.views);
    assert.equal(view.phase === "playing" ? view.positionSeconds : -1, 45);
    r.controller.destroy();
});

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
    assert.equal("audio_track_id" in body, false, "automatic starts leave audio selection to the server preference");
    assert.equal("audio_track_index" in body, false);
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

test("a network failure before the first frame is not a failed route: no replan, the session is stopped", async () => {
    const r = await rig();
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    r.avplay.finishPrepare("InvalidAccessError");
    await r.h.clock.advance(0);
    assert.equal(bodies(r.h, "/replan").length, 0);
    const view = last(r.views);
    assert.deepEqual(view.phase === "error" ? view.error : undefined, { kind: "network" });
    assert.equal(ops(r.h)[ops(r.h).length - 1], "DELETE /playback/S1");
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

test("an old stream completing during a held seek reanchor cannot end the replacement", async () => {
    const r = await rig();
    r.server.next.push({ timeline: { can_seek_anywhere: false } });
    const id = await playMovie(r);
    r.avplay.tick(7190000);
    const oldListener = r.avplay.listener;
    assert.ok(oldListener !== undefined);
    const hold = r.h.fake.hold(`/playback/${id}/replan`);
    r.controller.seekBy(-10);
    await r.h.clock.advance(0);
    assert.equal(only(bodies(r.h, "/replan")).position_seconds, 7180);

    oldListener.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.deepEqual(r.exits, [], "the superseded stream must not complete the playback attempt");
    assert.equal(r.server.session(id).receipt, undefined);
    assert.equal(r.avplay.state, "NONE", "close the superseded transport while waiting for the plan");
    assert.equal(last(r.views).phase, "loading");

    hold.release();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.urls.length, 2);
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.state, "PLAYING");
    oldListener.onstreamcompleted();
    assert.deepEqual(r.exits, []);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.deepEqual(r.exits, ["end:completed"]);
    assert.notEqual(r.server.session(id).receipt, undefined);
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

test("404 for a session that already played starts one replacement and is distinct from an administrator's end", async () => {
    const r = await rig();
    const id = await playMovie(r);
    r.avplay.tick(20000);
    r.server.sessions.delete(id);
    await r.h.clock.advance(10000);
    await r.h.clock.advance(0);
    assert.equal(ops(r.h).filter((op) => op === "POST /playback/start").length, 2);
    assert.equal(ops(r.h).filter((op) => op.startsWith("DELETE")).length, 0);
    assert.equal(bodies(r.h, "/start")[1]?.start_position, 20);
    const replaced = last(r.views);
    assert.notEqual(replaced.phase === "error" ? replaced.error.kind : undefined, "session_expired");
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

test("EOF holds the handoff until pending progress and the exact final STOP receipt settle", async () => {
    const r = await rig();
    const id = await playMovie(r);
    const progress = r.h.fake.hold(`/playback/${id}/progress`);
    r.avplay.tick(7000000);
    await r.h.clock.advance(10000);
    const stop = r.h.fake.hold(`/playback/${id}`);
    r.avplay.tick(7199000);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.deepEqual(r.exits, [], "EOF must not hand off while progress is unresolved");
    assert.equal(bodies(r.h, `/playback/${id}`).length, 0);
    progress.release();
    await r.h.clock.advance(0);
    assert.deepEqual(r.exits, [], "EOF must not hand off while STOP is unresolved");
    const final = only(bodies(r.h, `/playback/${id}`));
    assert.equal(final.sequence, 2);
    assert.equal(final.position, 7199);
    assert.equal(final.is_paused, false);
    assert.equal(final.installation_id, r.server.installationId);
    assert.match(String(final.stop_id), UUID);
    stop.release();
    await r.h.clock.advance(0);
    assert.deepEqual(r.exits, ["end:completed"]);
    r.controller.destroy();
});

const EPISODE: PlayRequest = { contentId: "episode:s1e12", fileId: "42", title: "Harbor Lights chapter 1.2", startSeconds: 0, episode: true };

async function episodeRig(): Promise<Rig & { catalog: FakeCatalog }> {
    const r = await rig();
    const catalog = new FakeCatalog();
    catalog.fileIds.set(EPISODE.contentId, "42");
    catalog.fileIds.set("episode:s1e13", "43");
    r.h.fake.catalog = catalog;
    r.server.items.set(EPISODE.contentId, ["42"]);
    r.server.items.set("episode:s1e13", ["43"]);
    return { ...r, catalog };
}

function completion(r: Rig): Extract<PlaybackView, { phase: "completion" }> {
    const view = last(r.views);
    assert.equal(view.phase, "completion");
    assert.ok(view.phase === "completion");
    return view;
}

async function autoplayRig(enabled: boolean): Promise<Rig & { catalog: FakeCatalog }> {
    const r = await episodeRig();
    const settings = new FakeSettings(r.h.fake);
    settings.overrides.set("playback.auto_play_next", enabled);
    const contract = fixture("settings_contract_ok");
    assert.ok(Array.isArray(contract.definitions));
    contract.definitions.push({ key: "playback.auto_play_next", introduced_in: 1, persistence: "remote", allowed_scopes: ["profile", "profile_device"], resolution_order: ["profile_device", "profile", "default"], value_schema: { type: "boolean" }, default_value: true });
    r.h.fake.script("/settings/contract", { status: 200, body: contract });
    return r;
}

test("older settings manifests keep playback available when optional autoplay discovery fails", async () => {
    const r = await episodeRig();
    const settings = new FakeSettings(r.h.fake);
    settings.revision = 8;
    r.h.fake.script("/settings/contract", problem(400, "validation_failed", "Contract unavailable"));
    await playMovie(r, EPISODE);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(15000);
    assert.equal(completion(r).countdown, undefined);
    assert.equal(bodies(r.h, "/start").length, 1);
    r.controller.destroy();
});

test("autoplay waits for confirmed stop and authorized successor, then starts exactly once", async () => {
    const r = await autoplayRig(true);
    const id = await playMovie(r, EPISODE);
    const stop = r.h.fake.hold(`/playback/${id}`);
    const listener = r.avplay.listener;
    r.avplay.tick(5399000);
    listener?.onstreamcompleted();
    await r.h.clock.advance(2000);
    assert.equal(completion(r).countdown, undefined);
    assert.equal(bodies(r.h, "/start").length, 1);
    stop.release();
    await r.h.clock.advance(0);
    assert.equal(completion(r).countdown, 10);
    await r.h.clock.advance(9000);
    assert.equal(completion(r).countdown, 1);
    assert.equal(bodies(r.h, "/start").length, 1);
    await r.h.clock.advance(1000);
    listener?.onstreamcompleted();
    r.controller.playNext();
    assert.equal(bodies(r.h, "/start").length, 2);
    assert.equal(bodies(r.h, "/start")[1]?.file_id, "43");
    r.controller.destroy();
});

test("autoplay cancellation, disabled preference, suspension and authority changes prevent timed starts", async () => {
    for (const action of ["cancel", "disabled", "suspend", "authority", "back", "destroy"] as const) {
        const r = await autoplayRig(action !== "disabled");
        await playMovie(r, EPISODE);
        r.avplay.listener?.onstreamcompleted();
        await r.h.clock.advance(0);
        if (action === "cancel") r.controller.cancelAutoplay();
        if (action === "suspend") r.controller.suspend();
        if (action === "authority") r.h.core.profiles.clear();
        if (action === "back") r.controller.back();
        if (action === "destroy") r.controller.destroy();
        await r.h.clock.advance(15000);
        assert.equal(bodies(r.h, "/start").length, 1, action);
        if (action === "cancel" || action === "disabled") {
            assert.equal(completion(r).countdown, undefined);
            r.controller.playNext();
            await r.h.clock.advance(0);
            assert.equal(bodies(r.h, "/start").length, 2, "manual continuation remains available");
        }
        r.controller.destroy();
    }
});

test("autoplay stops at the series end and never starts after failed resolution", async () => {
    for (const mode of ["end", "failure"] as const) {
        const r = await autoplayRig(true);
        if (mode === "end") for (const id of ["episode:s1e13", "episode:s1e21", "episode:s1e22", "episode:s1e23"]) r.catalog.removed.add(id);
        await playMovie(r, EPISODE);
        if (mode === "failure") r.catalog.removed.add(EPISODE.contentId);
        r.avplay.listener?.onstreamcompleted();
        await r.h.clock.advance(15000);
        assert.equal(completion(r).next, undefined);
        assert.equal(completion(r).countdown, undefined);
        assert.equal(completion(r).state, mode === "end" ? "ready" : "failed");
        assert.equal(bodies(r.h, "/start").length, 1);
        r.controller.destroy();
    }
});

test("series subtitle choice persists the server index or explicit Off without interrupting playback", async () => {
    for (const off of [true, false]) {
        const r = await episodeRig();
        if (!off) r.server.next.push({ subtitle: 4 });
        r.h.fake.script("/subtitle-prefs/series%3As1", { status: 204 });
        await playMovie(r, EPISODE);
        r.controller.saveSeriesSubtitle();
        r.controller.saveSeriesSubtitle();
        await r.h.clock.advance(0);
        const writes = r.h.fake.requests.filter(request => request.path.startsWith("/subtitle-prefs/"));
        assert.equal(writes.length, 1);
        assert.equal(writes[0]?.headers["x-profile-id"], "p-owner");
        assert.equal(writes[0]?.body?.subtitle_track_index, off ? -1 : 4);
        assert.equal(writes[0]?.body?.subtitle_mode, off ? "off" : "always");
        if (off) assert.equal(writes[0]?.body?.show_forced_subtitles, false);
        const view = last(r.views);
        assert.ok(view.phase === "playing");
        assert.equal(view.tracks.seriesSubtitle?.message, "Subtitle choice saved for this series.");
        r.controller.destroy();
    }
});

test("series subtitle write is not resent after a 401 and token refresh", async () => {
    const r = await episodeRig();
    r.server.next.push({ subtitle: 4 });
    r.h.fake.script("/subtitle-prefs/series%3As1", problem(401, "authentication_required", "Authentication required"), { status: 204 });
    await playMovie(r, EPISODE);
    r.controller.saveSeriesSubtitle();
    await r.h.clock.advance(0);
    assert.ok(r.h.fake.paths().includes("POST /auth/refresh"));
    assert.equal(r.h.fake.requests.filter(request => request.path.startsWith("/subtitle-prefs/")).length, 1);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.match(view.tracks.seriesSubtitle?.message ?? "", /Could not confirm/);
    r.controller.destroy();
});

test("series subtitle save refuses when the shown track is missing from the inventory instead of saving Off", async () => {
    const r = await episodeRig();
    r.server.next.push({ subtitle: 9 });
    r.h.fake.script("/subtitle-prefs/series%3As1", { status: 204 });
    await playMovie(r, EPISODE);
    r.controller.saveSeriesSubtitle();
    await r.h.clock.advance(0);
    assert.equal(r.h.fake.requests.filter(request => request.path.startsWith("/subtitle-prefs/")).length, 0);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.match(view.tracks.seriesSubtitle?.message ?? "", /Could not confirm/);
    r.controller.destroy();
});

test("episode EOF orders held progress, final STOP, fresh watch and exactly one manual successor START", async () => {
    const r = await episodeRig();
    const id = await playMovie(r, EPISODE);
    const listener = r.avplay.listener;
    const progress = r.h.fake.hold(`/playback/${id}/progress`);
    r.avplay.tick(5000000);
    await r.h.clock.advance(10000);
    const stop = r.h.fake.hold(`/playback/${id}`);
    const watch = r.h.fake.hold(`/watch/${encodeURIComponent(EPISODE.contentId)}`);
    r.avplay.tick(5399000);
    listener?.onstreamcompleted();
    listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    r.controller.playNext();
    assert.equal(completion(r).state, "finalizing");
    assert.equal(bodies(r.h, "/start").length, 1);
    assert.equal(r.h.fake.requests.filter(q => q.path.startsWith("/watch/")).length, 0);
    progress.release();
    await r.h.clock.advance(0);
    const body = only(bodies(r.h, `/playback/${id}`));
    assert.equal(body.sequence, 2);
    assert.equal(body.position, 5399);
    assert.equal(body.is_paused, false);
    assert.equal(body.installation_id, r.server.installationId);
    stop.release();
    await r.h.clock.advance(0);
    assert.equal(completion(r).state, "resolving");
    r.controller.playNext();
    assert.equal(bodies(r.h, "/start").length, 1);
    watch.release();
    await r.h.clock.advance(0);
    assert.equal(completion(r).state, "ready");
    assert.equal(r.catalog.playbackWatched.has(EPISODE.contentId), true, "the fake STOP must update subsequent watch reads");
    r.controller.playNext();
    r.controller.playNext();
    listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    const starts = bodies(r.h, "/start");
    assert.equal(starts.length, 2);
    assert.equal(starts[1]?.file_id, "43");
    assert.equal(starts[1]?.start_position, 0);
    assert.notEqual(starts[0]?.playback_attempt_id, starts[1]?.playback_attempt_id);
    assert.equal(starts[1]?.selected_tracks, undefined);
    assert.equal(r.h.fake.requests.filter(q => q.method === "DELETE").length, 1);
    assert.deepEqual(r.exits, []);
    r.controller.destroy();
    await r.h.clock.advance(0);
});

test("a lost EOF STOP answer retries the identical body and identity before resolving", async () => {
    const r = await episodeRig();
    const id = await playMovie(r, EPISODE);
    r.h.fake.dropNextAnswer(`/playback/${id}`);
    r.avplay.tick(5399000);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.equal(completion(r).state, "finalizing");
    assert.equal(r.h.fake.requests.filter(q => q.path.startsWith("/watch/")).length, 0);
    await r.h.clock.advance(1000);
    const stops = bodies(r.h, `/playback/${id}`);
    assert.equal(stops.length, 2);
    assert.deepEqual(stops[0], stops[1]);
    assert.equal(stops[0]?.sequence, 1);
    assert.equal(stops[0]?.position, 5399);
    assert.equal(completion(r).state, "ready");
    assert.equal(r.server.session(id).receipt?.stop_id, stops[0]?.stop_id);
    r.controller.destroy();
});

test("EOF STOP failures retain the same body on explicit Retry and honor Retry-After", async () => {
    const r = await episodeRig();
    const id = await playMovie(r, EPISODE);
    r.h.fake.script(`/playback/${id}`, ...[1, 2, 3].map(() => ({ status: 503, headers: { "Retry-After": "4" }, body: {} })));
    r.avplay.tick(111250);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(8000);
    assert.equal(completion(r).state, "failed");
    assert.equal(completion(r).retryable, true);
    r.controller.retryCompletion();
    r.controller.retryCompletion();
    await r.h.clock.advance(3999);
    assert.equal(bodies(r.h, `/playback/${id}`).length, 3);
    assert.equal(bodies(r.h, "/start").length, 1);
    await r.h.clock.advance(1);
    const stops = bodies(r.h, `/playback/${id}`);
    assert.equal(stops.length, 4);
    assert.ok(stops.every(stop => JSON.stringify(stop) === JSON.stringify(stops[0])));
    assert.equal(stops[0]?.position, 111.25);
    assert.equal(completion(r).state, "ready");
    r.controller.destroy();
});

test("Back, background, teardown and profile loss cancel EOF resolution despite late answers", async () => {
    for (const action of ["back", "background", "destroy", "profile"] as const) {
        const r = await episodeRig();
        await playMovie(r, EPISODE);
        const hold = r.h.fake.hold(`/watch/${encodeURIComponent(EPISODE.contentId)}`, true);
        r.avplay.listener?.onstreamcompleted();
        await r.h.clock.advance(0);
        assert.equal(completion(r).state, "resolving");
        if (action === "profile") r.h.core.profiles.clear();
        else r.controller[action]();
        const count = r.views.length;
        hold.release();
        await r.h.clock.advance(0);
        r.controller.playNext();
        assert.equal(bodies(r.h, "/start").length, 1, action);
        assert.equal(r.views.length, count, action);
        if (action === "profile") assert.deepEqual(r.exits, ["end:authority_changed"]);
        r.controller.destroy();
    }
});

test("Back during held EOF STOP never resurrects continuation but still retires the old session", async () => {
    const r = await episodeRig();
    const id = await playMovie(r, EPISODE);
    const hold = r.h.fake.hold(`/playback/${id}`, true);
    const listener = r.avplay.listener;
    listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    r.controller.back();
    hold.release();
    listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.deepEqual(r.exits, ["back"]);
    assert.equal(r.h.fake.requests.some(q => q.path.startsWith("/watch/")), false);
    assert.equal(bodies(r.h, `/playback/${id}`).length, 1);
    assert.ok(r.server.session(id).receipt !== undefined);
    r.controller.destroy();
});

test("fresh unchanged played:false is authoritative and still permits a neutral next offer", async () => {
    const r = await episodeRig();
    r.catalog.persistStops = false;
    await playMovie(r, EPISODE);
    r.avplay.tick(5399000);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.equal(completion(r).state, "ready");
    assert.equal(completion(r).title, "Playback ended");
    assert.equal(r.catalog.playbackWatched.has(EPISODE.contentId), false);
    assert.equal(r.catalog.progress.has(EPISODE.contentId), false);
    r.controller.destroy();
});

test("an expired pending progress answer at EOF offers Back without an impossible Retry", async () => {
    const r = await episodeRig();
    const id = await playMovie(r, EPISODE);
    const progress = r.h.fake.hold(`/playback/${id}/progress`);
    r.server.sessions.delete(id);
    await r.h.clock.advance(10000);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.equal(completion(r).state, "finalizing");
    progress.release();
    await r.h.clock.advance(0);
    assert.equal(completion(r).state, "failed");
    assert.equal(completion(r).retryable, false);
    assert.equal(completion(r).next, undefined);
    r.controller.playNext();
    assert.equal(r.h.fake.requests.filter(request => request.method === "DELETE").length, 0);
    assert.equal(r.h.fake.requests.some(request => request.path.startsWith("/watch/")), false);
    assert.equal(bodies(r.h, "/start").length, 1);
    r.controller.back();
    assert.deepEqual(r.exits, ["back"]);
    r.controller.destroy();
});

test("a missing session during EOF STOP offers Back without a retry that can never succeed", async () => {
    const r = await episodeRig();
    const id = await playMovie(r, EPISODE);
    r.server.sessions.delete(id);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.equal(completion(r).state, "failed");
    assert.equal(completion(r).retryable, false);
    assert.equal(bodies(r.h, `/playback/${id}`).length, 1);
    r.controller.retryCompletion();
    r.controller.playNext();
    await r.h.clock.advance(0);
    assert.equal(bodies(r.h, `/playback/${id}`).length, 1);
    assert.equal(bodies(r.h, "/start").length, 1);
    assert.equal(r.h.fake.requests.some(q => q.path.startsWith("/watch/")), false);
    r.controller.back();
    assert.deepEqual(r.exits, ["back"]);
    r.controller.destroy();
});

for (const kind of ["audio", "quality"] as const) for (const result of ["refused", "accepted"] as const) {
    test(`EOF during a pending ${kind} change ${result === "refused" ? "completes the retained transport after refusal" : "does not complete its replacement"}`, async () => {
        const r = await episodeRig();
        r.server.next.push({ availableQualities: [{ label: "1080p-medium", height: 1080, bitrate_kbps: 6000, preserves_source: false }] });
        const id = await playMovie(r, EPISODE);
        const predecessor = r.avplay.listener;
        const response = r.h.fake.hold(`/playback/${id}/replan`);
        if (result === "refused") r.server.next.push({ terminal: "adaptation_unavailable" });
        if (kind === "audio") r.controller.selectAudio("file:42:audio:1");
        else r.controller.selectQuality("1080p-medium");
        await r.h.clock.advance(0);
        assert.equal(bodies(r.h, "/replan").length, 1);
        r.avplay.tick(5399000);
        predecessor?.onstreamcompleted();
        assert.equal(bodies(r.h, `/playback/${id}`).length, 0);
        response.release();
        await r.h.clock.advance(0);
        if (result === "refused") {
            assert.equal(completion(r).state, "ready");
            assert.equal(only(bodies(r.h, `/playback/${id}`)).position, 5399);
        } else {
            predecessor?.onstreamcompleted();
            assert.equal(bodies(r.h, `/playback/${id}`).length, 0);
            r.avplay.finishPrepare();
            await r.h.clock.advance(0);
            if (r.avplay.calls[r.avplay.calls.length - 1]?.startsWith("seekTo") === true) r.avplay.finishSeek();
            await r.h.clock.advance(0);
            assert.equal(last(r.views).phase, "playing");
            r.avplay.listener?.onstreamcompleted();
            await r.h.clock.advance(0);
            assert.equal(completion(r).state, "ready");
        }
        assert.equal(bodies(r.h, `/playback/${id}`).length, 1);
        assert.equal(bodies(r.h, "/start").length, 1);
        r.controller.destroy();
    });
}

test("EOF during a definitively failed track request still completes the retained transport", async () => {
    const r = await episodeRig();
    const id = await playMovie(r, EPISODE);
    const response = r.h.fake.hold(`/playback/${id}/replan`);
    r.h.fake.script(`/playback/${id}/replan`, problem(400, "validation_failed", "Track change refused"));
    r.controller.selectSubtitle("file:42:subtitle:0");
    await r.h.clock.advance(0);
    assert.equal(bodies(r.h, "/replan").length, 1);
    r.avplay.listener?.onstreamcompleted();
    response.release();
    await r.h.clock.advance(0);
    assert.equal(completion(r).state, "ready");
    assert.equal(bodies(r.h, `/playback/${id}`).length, 1);
    r.controller.destroy();
});

test("fresh watch failure offers Retry without resending confirmed STOP or leaking a next title", async () => {
    const r = await episodeRig();
    const id = await playMovie(r, EPISODE);
    r.catalog.removed.add(EPISODE.contentId);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.equal(completion(r).state, "failed");
    assert.equal(completion(r).next, undefined);
    assert.equal(completion(r).retryable, true);
    r.catalog.removed.delete(EPISODE.contentId);
    r.controller.retryCompletion();
    await r.h.clock.advance(0);
    assert.equal(completion(r).state, "ready");
    assert.equal(bodies(r.h, `/playback/${id}`).length, 1);
    r.controller.destroy();
});

test("STOP authorization, installation, administrator and malformed receipt refusals never offer a successor", async () => {
    for (const refusal of [problem(403, "forbidden", "Forbidden"), problem(410, "playback_session_ended", "Ended"), problem(409, "installation_changed", "Changed"), { status: 200, body: { outcome: "applied" } }, { status: 200, body: { outcome: "replayed", stop_id: "administrator-stop" } }, { status: 200, body: { outcome: "stopped", accepted: { sequence: 1, position: "bad", is_paused: false } } }]) {
        const r = await episodeRig();
        const id = await playMovie(r, EPISODE);
        r.h.fake.script(`/playback/${id}`, refusal);
        r.avplay.listener?.onstreamcompleted();
        await r.h.clock.advance(0);
        assert.equal(completion(r).state, "failed");
        r.controller.playNext();
        assert.equal(bodies(r.h, "/start").length, 1);
        assert.equal(r.h.fake.requests.some(q => q.path.startsWith("/watch/")), false);
        r.controller.destroy();
    }
});

test("unknown and different effective durations and premature EOF preserve the actual source sample", async () => {
    for (const duration of [0, 3600, 10000]) {
        const r = await episodeRig();
        r.server.next.push({ effectiveFileId: "43", durationSeconds: duration, timeline: { source_start_seconds: 100, player_start_seconds: 0, timeline_offset_seconds: 100 } });
        r.catalog.watchOverrides.set(EPISODE.contentId, { versions: [{ file_id: "42", duration_seconds: 5400 }, { file_id: "43", duration_seconds: duration, multi_episode_start: 2, multi_episode_end: 2 }] });
        const id = await playMovie(r, EPISODE);
        r.avplay.tick(11250);
        r.avplay.listener?.onstreamcompleted();
        await r.h.clock.advance(0);
        assert.equal(only(bodies(r.h, `/playback/${id}`)).position, 111.25);
        assert.equal(completion(r).state, "ready");
        assert.equal(r.catalog.playbackWatched.has(EPISODE.contentId), false);
        r.controller.destroy();
    }
});

test("a failed successor START retries through the existing planner with one fresh attempt", async () => {
    const r = await episodeRig();
    await playMovie(r, EPISODE);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    r.server.next.push({ terminal: "temporarily_unavailable", retryable: true });
    r.controller.playNext();
    await r.h.clock.advance(0);
    const error = last(r.views);
    assert.equal(error.phase, "error");
    assert.equal(error.phase === "error" && error.retryable, true);
    r.controller.retryCompletion();
    r.controller.retryCompletion();
    await r.h.clock.advance(0);
    assert.equal(bodies(r.h, "/start").length, 3);
    assert.equal(new Set(bodies(r.h, "/start").map(body => body.playback_attempt_id)).size, 3);
    assert.equal(last(r.views).phase, "loading");
    r.controller.destroy();
    await r.h.clock.advance(0);
});

test("EOF arriving during a pending backward seek cannot become episode continuation", async () => {
    const r = await episodeRig();
    await playMovie(r, EPISODE);
    r.avplay.tick(5399000);
    r.controller.seekBy(-45);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.equal(last(r.views).phase, "playing");
    assert.equal(r.h.fake.requests.some(q => q.method === "DELETE"), false);
    r.avplay.finishSeek();
    assert.equal(last(r.views).phase, "playing");
    r.controller.destroy();
    await r.h.clock.advance(0);
});

test("authority loss while STOP awaits retry prevents old-scope resends and next starts", async () => {
    for (const action of ["profile", "account"]) {
        const r = await episodeRig();
        const id = await playMovie(r, EPISODE);
        r.h.fake.dropNextAnswer(`/playback/${id}`);
        r.avplay.listener?.onstreamcompleted();
        await r.h.clock.advance(0);
        if (action === "profile") r.h.core.profiles.clear();
        else await r.h.core.session.logout();
        await r.h.clock.advance(10000);
        r.controller.retryCompletion();
        r.controller.playNext();
        assert.equal(bodies(r.h, `/playback/${id}`).length, 1);
        assert.equal(bodies(r.h, "/start").length, 1);
        assert.equal(r.h.fake.requests.some(q => q.path.startsWith("/watch/")), false);
        r.controller.destroy();
    }
});

test("a pending progress administrator refusal wins over a later EOF", async () => {
    const r = await episodeRig();
    const id = await playMovie(r, EPISODE);
    const hold = r.h.fake.hold(`/playback/${id}/progress`);
    r.server.endByAdmin(id);
    await r.h.clock.advance(10000);
    r.avplay.listener?.onstreamcompleted();
    hold.release();
    await r.h.clock.advance(0);
    assert.equal(completion(r).state, "failed");
    assert.equal(completion(r).retryable, false);
    assert.equal(bodies(r.h, `/playback/${id}`).length, 0);
    assert.equal(r.h.fake.requests.some(q => q.path.startsWith("/watch/")), false);
    r.controller.destroy();
});

test("revoked PIN proof during EOF finalization removes the old authority and cannot offer next", async () => {
    const r = await rig("p-kid");
    r.h.fake.catalog = new FakeCatalog();
    r.server.items.set(EPISODE.contentId, ["42"]);
    const id = await playMovie(r, EPISODE);
    r.h.fake.changePin("p-kid", "1357");
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.deepEqual(r.exits, ["end:authority_changed"]);
    assert.equal(r.h.core.session.activeProfile, undefined);
    assert.equal(bodies(r.h, `/playback/${id}`).length, 1);
    assert.equal(r.h.fake.requests.some(q => q.path.startsWith("/watch/")), false);
    r.controller.playNext();
    assert.equal(bodies(r.h, "/start").length, 1);
    r.controller.destroy();
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
