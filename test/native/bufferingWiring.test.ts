// "Lower quality when buffering" wired into the native player: AVPlay's buffering events drive
// silo-apple's BufferingQualityController (PlaybackSessionBridge, BufferingSignalMapper), and what
// it decides leaves as `quality_change` replans. These tests drive the whole controller through
// AVPlay sequences and read the replan bodies the fake server receives.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { BUFFERING_MODE_KEY } from "../../src/contracts/v2/settingsRows.ts";
import { COPY } from "../../src/player/bufferingQuality.ts";
import { PlaybackController, type PlaybackView, type PlayRequest } from "../../src/player/controller.ts";
import { ManualClock } from "./support/clock.ts";
import { FakeAVPlay } from "./support/fakeAVPlay.ts";
import { FakePlayback, type PlanShape } from "./support/fakePlayback.ts";
import { SettingsState } from "../../src/ui/settingsState.ts";
import { FakeCatalog } from "./support/fakeCatalog.ts";
import { FakeSettings } from "./support/fakeSettings.ts";
import { FakeSilo, fixture, problem } from "./support/fakeSilo.ts";
import { connected, signIn, type Harness } from "./support/harness.ts";

// Node's navigator has no onLine; a TV's webview does.
beforeEach(() => {
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>).onLine;
});

const MOVIE: PlayRequest = { contentId: "movie-1", fileId: "42", title: "Movie", startSeconds: 12.5 };
const FEATURE = "buffering_quality_v1";
const BASE_FEATURES = fixture("playback_start_opaque_ids").server_features as string[];
const LADDER = [
    { label: "original", preserves_source: true },
    { label: "1080p-medium", height: 1080, bitrate_kbps: 6000, preserves_source: false },
    { label: "720p", height: 720, bitrate_kbps: 3000, preserves_source: false },
];
/** The fixture plan delivers 8000 kb/s, so the step-down estimate is floor(8000 * 7 / 10). */
const STEP_DOWN_KBPS = 5600;

interface Rig {
    readonly h: Harness;
    readonly server: FakePlayback;
    readonly settings: FakeSettings;
    readonly avplay: FakeAVPlay;
    readonly controller: PlaybackController;
    readonly views: PlaybackView[];
}

async function rig(mode?: "never" | "ask" | "always", via: "profile" | "row" = "profile"): Promise<Rig> {
    const clock = new ManualClock();
    const h = await connected({ clock, fake: new FakeSilo(clock) });
    await signIn(h);
    const owner = (await h.core.profiles.list()).find((profile) => profile.id === "p-owner");
    assert.ok(owner !== undefined);
    h.core.profiles.select(owner);
    // The Settings state also loads the library list, which only the catalog fake answers.
    if (via === "row") h.fake.catalog = new FakeCatalog();
    const server = new FakePlayback(h.fake);
    const settings = new FakeSettings(h.fake);
    if (mode !== undefined) {
        settings.bufferingRows = true;
        if (via === "profile") settings.profile().set(BUFFERING_MODE_KEY as never, mode);
        else {
            // The Settings row's own write path: device scope for this TV, not the profile row.
            const state = new SettingsState(h.core.session, () => undefined, h.clock);
            await state.load();
            await state.save(BUFFERING_MODE_KEY, mode);
            state.stop();
            assert.equal(settings.profile().has(BUFFERING_MODE_KEY as never), false);
        }
    }
    const avplay = new FakeAVPlay();
    let serial = 0;
    const controller = new PlaybackController({
        session: h.core.session,
        avplay,
        clock: h.clock,
        randomBytes: (bytes) => bytes.fill(++serial),
        device: { model: "QN55Q60AAFXZA", appVersion: "0.1.0" },
        exits: { onBack() {}, onEnd() {}, onError: (error) => assert.fail(error.kind) },
    });
    const views: PlaybackView[] = [];
    controller.subscribe((view) => views.push(view));
    return { h, server, settings, avplay, controller, views };
}

function advertised(extra: Partial<PlanShape> = {}): PlanShape {
    return { availableQualities: LADDER, serverFeatures: [...BASE_FEATURES, FEATURE], ...extra };
}

function bodies(r: Rig, suffix: string): Record<string, unknown>[] {
    return r.h.fake.requests.filter((request) => request.path.endsWith(suffix)).map((request) => request.body ?? {});
}

/** The `quality_change` replans: the buffering controller's, and the viewer's own pick. */
function qualityChanges(r: Rig): Record<string, unknown>[] {
    return bodies(r, "/replan").filter((body) => body.operation === "quality_change");
}

function last(r: Rig): PlaybackView {
    const view = r.views[r.views.length - 1];
    assert.ok(view !== undefined);
    return view;
}

function pill(r: Rig): { kind: string } | undefined {
    const view = last(r);
    return view.phase === "playing" || view.phase === "paused" || view.phase === "loading" ? view.bufferingPill : undefined;
}

function notice(r: Rig): string | undefined {
    const view = last(r);
    return view.phase === "playing" || view.phase === "paused" || view.phase === "loading" ? view.bufferingNotice?.text : undefined;
}

async function finishOpen(r: Rig): Promise<void> {
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    if (r.avplay.calls.at(-1)?.startsWith("seekTo") === true) {
        r.avplay.finishSeek();
        await r.h.clock.advance(0);
    }
    assert.equal(r.avplay.state, "PLAYING");
}

/** Plays MOVIE and lets the 10 s startup grace pass, so the next stall counts. */
async function playPastGrace(r: Rig): Promise<void> {
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    await finishOpen(r);
    r.avplay.tick(13_000);
    await r.h.clock.advance(11_000);
}

/** AVPlay buffers for `ms` and resumes. */
async function stall(r: Rig, ms: number): Promise<void> {
    r.avplay.listener?.onbufferingstart();
    await r.h.clock.advance(ms);
    r.avplay.listener?.onbufferingcomplete();
    await r.h.clock.advance(0);
}

test("a long stall on Auto lowers with Apple's quality_change fields, and the lowered plan offers an undo", async () => {
    const r = await rig();
    r.server.next.push(advertised(), advertised({ recipeKbps: STEP_DOWN_KBPS }));
    await playPastGrace(r);
    r.avplay.listener?.onbufferingstart();
    await r.h.clock.advance(6000);
    const replan = bodies(r, "/replan");
    assert.equal(replan.length, 1);
    const body = replan[0];
    assert.ok(body !== undefined);
    assert.equal(body.operation, "quality_change");
    assert.equal(body.quality_preference, "auto");
    assert.equal(body.bandwidth_estimate_kbps, STEP_DOWN_KBPS);
    assert.equal(body.bandwidth_estimate_source, "observed_rebuffer");
    assert.equal(Object.hasOwn(body, "learned_limit"), false);
    assert.equal(Object.hasOwn(body, "bandwidth_cap_kbps"), false);
    assert.ok((body.client_features as string[]).includes(FEATURE));
    await finishOpen(r);
    assert.deepEqual(pill(r)?.kind, "undo");
    r.controller.destroy();
});

test("Restore quality sends Auto with learned_limit clear and no estimate", async () => {
    const r = await rig();
    r.server.next.push(advertised(), advertised({ recipeKbps: STEP_DOWN_KBPS }), advertised());
    await playPastGrace(r);
    r.avplay.listener?.onbufferingstart();
    await r.h.clock.advance(6000);
    await finishOpen(r);
    r.controller.selectBufferingPrimary();
    await r.h.clock.advance(0);
    const replans = bodies(r, "/replan");
    assert.equal(replans.length, 2);
    const restore = replans[1];
    assert.ok(restore !== undefined);
    assert.equal(restore.operation, "quality_change");
    assert.equal(restore.quality_preference, "auto");
    assert.equal(restore.learned_limit, "clear");
    assert.equal(Object.hasOwn(restore, "bandwidth_estimate_kbps"), false);
    assert.equal(Object.hasOwn(restore, "bandwidth_estimate_source"), false);
    assert.equal(pill(r), undefined);
    r.controller.destroy();
});

test("two stalls of a second each inside two minutes also lower", async () => {
    const r = await rig();
    r.server.next.push(advertised());
    await playPastGrace(r);
    await stall(r, 1000);
    assert.equal(bodies(r, "/replan").length, 0);
    await r.h.clock.advance(5000);
    await stall(r, 1000);
    assert.equal(bodies(r, "/replan").length, 1);
    r.controller.destroy();
});

test("a server that does not advertise buffering_quality_v1 gets the estimate but not the feature or its members", async () => {
    const r = await rig();
    r.server.next.push({ availableQualities: LADDER });
    await playPastGrace(r);
    r.avplay.listener?.onbufferingstart();
    await r.h.clock.advance(6000);
    const body = bodies(r, "/replan")[0];
    assert.ok(body !== undefined);
    assert.equal(body.bandwidth_estimate_kbps, STEP_DOWN_KBPS);
    for (const member of ["bandwidth_estimate_source", "learned_limit", "observed_throughput_kbps"]) assert.equal(Object.hasOwn(body, member), false, member);
    assert.equal((body.client_features as string[]).includes(FEATURE), false);
    r.controller.destroy();
});

test("never detects stalls and does nothing: no replan, no pill, and the start ignores a learned limit", async () => {
    const r = await rig("never");
    r.server.next.push(advertised());
    await playPastGrace(r);
    r.avplay.listener?.onbufferingstart();
    await r.h.clock.advance(20_000);
    r.avplay.listener?.onbufferingcomplete();
    await r.h.clock.advance(0);
    assert.equal(bodies(r, "/replan").length, 0);
    assert.equal(pill(r), undefined);
    const start = bodies(r, "/playback/start")[0];
    assert.ok(start !== undefined);
    assert.equal(start.learned_limit, "ignore");
    assert.ok((start.client_features as string[]).includes(FEATURE));
    r.controller.destroy();
});

test("ask offers Lower quality and Keep quality, and Lower sends the same replan", async () => {
    const r = await rig("ask");
    r.server.next.push(advertised(), advertised({ recipeKbps: STEP_DOWN_KBPS }));
    await playPastGrace(r);
    r.avplay.listener?.onbufferingstart();
    await r.h.clock.advance(6000);
    assert.equal(bodies(r, "/replan").length, 0);
    const shown = pill(r);
    assert.equal(shown?.kind, "prompt");
    r.controller.selectBufferingPrimary();
    await r.h.clock.advance(0);
    const body = bodies(r, "/replan")[0];
    assert.ok(body !== undefined);
    assert.equal(body.quality_preference, "auto");
    assert.equal(body.bandwidth_estimate_kbps, STEP_DOWN_KBPS);
    assert.equal(body.bandwidth_estimate_source, "observed_rebuffer");
    assert.equal(pill(r), undefined);
    r.controller.destroy();
});

test("the prompt waits while a skip pill is up, so the skip pill and the prompt are never both focus targets", async () => {
    const r = await rig("ask");
    r.server.next.push(advertised());
    await playPastGrace(r);
    r.controller.setSkipPillShown(true);
    r.avplay.listener?.onbufferingstart();
    await r.h.clock.advance(6000);
    assert.equal(pill(r), undefined);
    r.controller.setSkipPillShown(false);
    assert.equal(pill(r)?.kind, "prompt");
    r.controller.destroy();
});

test("Keep quality answers the prompt without a replan, and the prompt's 15 s timer ends it", async () => {
    const r = await rig("ask");
    r.server.next.push(advertised());
    await playPastGrace(r);
    r.avplay.listener?.onbufferingstart();
    await r.h.clock.advance(6000);
    assert.equal(pill(r)?.kind, "prompt");
    r.controller.selectBufferingKeep();
    await r.h.clock.advance(0);
    assert.equal(pill(r), undefined);
    assert.equal(bodies(r, "/replan").length, 0);
    r.controller.destroy();

    const timed = await rig("ask");
    timed.server.next.push(advertised());
    await playPastGrace(timed);
    timed.avplay.listener?.onbufferingstart();
    await timed.h.clock.advance(6000);
    assert.equal(pill(timed)?.kind, "prompt");
    await timed.h.clock.advance(14_000);
    assert.equal(pill(timed)?.kind, "prompt");
    await timed.h.clock.advance(1000);
    assert.equal(pill(timed), undefined);
    assert.equal(bodies(timed, "/replan").length, 0);
    timed.controller.destroy();
});

test("Back on the prompt answers like Keep and is consumed once", async () => {
    const r = await rig("ask");
    r.server.next.push(advertised());
    await playPastGrace(r);
    r.avplay.listener?.onbufferingstart();
    await r.h.clock.advance(6000);
    assert.equal(r.controller.dismissBufferingPill(), true);
    assert.equal(pill(r), undefined);
    assert.equal(r.controller.dismissBufferingPill(), false);
    r.controller.destroy();
});

test("a quality the viewer picked is asked about first, even in always, and lowers to the next rung", async () => {
    const r = await rig("always");
    r.server.next.push(advertised(), advertised({ activeQuality: "1080p-medium", recipeKbps: 6000 }), advertised({ activeQuality: "720p", recipeKbps: 3000 }));
    await playPastGrace(r);
    r.controller.selectQuality("1080p-medium");
    await r.h.clock.advance(0);
    await finishOpen(r);
    r.avplay.tick(20_000);
    await r.h.clock.advance(11_000);
    r.avplay.listener?.onbufferingstart();
    await r.h.clock.advance(6000);
    assert.equal(bodies(r, "/replan").length, 1);
    assert.equal(pill(r)?.kind, "prompt");
    r.controller.selectBufferingPrimary();
    await r.h.clock.advance(0);
    const replans = bodies(r, "/replan");
    assert.equal(replans.length, 2);
    const body = replans[1];
    assert.ok(body !== undefined);
    assert.equal(body.operation, "quality_change");
    assert.equal(body.quality_preference, "720p");
    assert.equal(body.bandwidth_cap_kbps, 3000);
    assert.equal(Object.hasOwn(body, "bandwidth_estimate_kbps"), false);
    r.controller.destroy();
});

test("a plan with no lower rung shows the cannot-lower notice for five seconds and sends nothing", async () => {
    const r = await rig();
    r.server.next.push({ serverFeatures: [...BASE_FEATURES, FEATURE], availableQualities: [{ label: "original", preserves_source: true }] });
    await playPastGrace(r);
    r.avplay.listener?.onbufferingstart();
    await r.h.clock.advance(6000);
    assert.equal(bodies(r, "/replan").length, 0);
    assert.equal(notice(r), COPY.cantLower);
    await r.h.clock.advance(4999);
    assert.equal(notice(r), COPY.cantLower);
    await r.h.clock.advance(1);
    assert.equal(notice(r), undefined);
    r.controller.destroy();
});

test("buffering that is not a stall never triggers", async () => {
    const r = await rig();
    r.server.next.push(advertised());
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    // The start's own wait, inside the startup grace.
    r.avplay.listener?.onbufferingstart();
    await r.h.clock.advance(8000);
    r.avplay.listener?.onbufferingcomplete();
    await finishOpen(r);
    r.avplay.tick(13_000);
    await r.h.clock.advance(11_000);
    // A sub-second hiccup.
    await stall(r, 900);
    // Buffering after the viewer paused.
    r.controller.setPaused(true);
    await r.h.clock.advance(0);
    r.avplay.listener?.onbufferingstart();
    await r.h.clock.advance(20_000);
    r.avplay.listener?.onbufferingcomplete();
    r.controller.setPaused(false);
    await r.h.clock.advance(0);
    assert.equal(bodies(r, "/replan").length, 0);
    assert.equal(pill(r), undefined);
    r.controller.destroy();
});

test("buffering after a seek belongs to the seek, not the network", async () => {
    const r = await rig();
    r.server.next.push(advertised());
    await playPastGrace(r);
    r.controller.seekToSeconds(300);
    await r.h.clock.advance(0);
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    r.avplay.listener?.onbufferingstart();
    await r.h.clock.advance(20_000);
    r.avplay.listener?.onbufferingcomplete();
    await r.h.clock.advance(0);
    assert.equal(qualityChanges(r).length, 0);
    r.controller.destroy();
});

test("a lost connection ends the stall in progress without lowering", async () => {
    const r = await rig();
    r.server.next.push(advertised(), advertised());
    await playPastGrace(r);
    r.avplay.listener?.onbufferingstart();
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(20_000);
    assert.equal(bodies(r, "/replan").filter((body) => body.operation === "quality_change").length, 0);
    r.controller.destroy();
});

test("Restore quality pressed while the lowered plan still loads goes out once it plays", async () => {
    const r = await rig();
    r.server.next.push(advertised(), advertised({ recipeKbps: STEP_DOWN_KBPS }), advertised());
    await playPastGrace(r);
    r.avplay.listener?.onbufferingstart();
    await r.h.clock.advance(6000);
    // The lowered plan is adopted and its undo shows while AVPlay is still preparing it.
    assert.equal(r.avplay.pendingPrepares, 1);
    assert.equal(pill(r)?.kind, "undo");
    r.controller.selectBufferingPrimary();
    await r.h.clock.advance(0);
    assert.equal(qualityChanges(r).length, 1, "not sent while the stream is loading");
    assert.equal(pill(r), undefined);
    // The stream plays, and the viewer's answer goes out at once, closing it again.
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    if (r.avplay.calls.at(-1)?.startsWith("seekTo") === true) r.avplay.finishSeek();
    await r.h.clock.advance(0);
    const restore = qualityChanges(r)[1];
    assert.ok(restore !== undefined);
    assert.equal(restore.learned_limit, "clear");
    r.controller.destroy();
});

test("a lowering holds across the player's own replans: a track change repeats the kept estimate without a source", async () => {
    const r = await rig();
    r.server.next.push(advertised(), advertised({ recipeKbps: STEP_DOWN_KBPS }), advertised({ recipeKbps: STEP_DOWN_KBPS }));
    await playPastGrace(r);
    r.avplay.listener?.onbufferingstart();
    await r.h.clock.advance(6000);
    await finishOpen(r);
    r.controller.selectAudio("file:42:audio:1");
    await r.h.clock.advance(0);
    const change = bodies(r, "/replan").find((body) => body.operation === "track_change");
    assert.ok(change !== undefined);
    assert.equal(change.bandwidth_estimate_kbps, STEP_DOWN_KBPS);
    assert.equal(Object.hasOwn(change, "bandwidth_estimate_source"), false);
    assert.equal(change.quality_preference, "auto");
    r.controller.destroy();
});

test("a backgrounded app neither waits nor lowers, and the stall does not carry over", async () => {
    const r = await rig();
    r.server.next.push(advertised());
    await playPastGrace(r);
    r.avplay.listener?.onbufferingstart();
    await r.h.clock.advance(3000);
    r.controller.suspend();
    await r.h.clock.advance(20_000);
    assert.equal(qualityChanges(r).length, 0);
    assert.equal(pill(r), undefined);
    r.controller.destroy();
});

test("an ask prompt does not run out of time while the app is backgrounded", async () => {
    const r = await rig("ask");
    r.server.next.push(advertised());
    await playPastGrace(r);
    r.avplay.listener?.onbufferingstart();
    await r.h.clock.advance(6000);
    assert.equal(pill(r)?.kind, "prompt");
    r.controller.suspend();
    await r.h.clock.advance(60_000);
    // Paused: the controller withdraws nothing and the title is not marked unanswered.
    r.controller.restore();
    await r.h.clock.advance(0);
    assert.equal(qualityChanges(r).length, 0);
    r.controller.destroy();
});

test("a lowering the server refuses leaves the plan playing and shows no error", async () => {
    for (const how of ["terminal", "refused"] as const) {
        const r = await rig();
        r.server.next.push(advertised());
        if (how === "terminal") r.server.next.push({ terminal: "adaptation_unavailable" });
        await playPastGrace(r);
        const id = [...r.server.sessions.keys()].pop();
        assert.ok(id !== undefined);
        // Exact path: a refusal, or a server that does not answer until the resends run out.
        if (how === "refused") r.h.fake.script(`/playback/${id}/replan`, problem(422, "validation_failed", "Refused"));
        r.avplay.listener?.onbufferingstart();
        await r.h.clock.advance(6000);
        await r.h.clock.advance(60_000);
        assert.equal(r.avplay.state, "PLAYING", `${how}: the transport that was playing is not closed`);
        const view = last(r);
        assert.ok(view.phase === "playing", `${how}: still playing, not ${view.phase}`);
        assert.equal(view.tracks.change.state, "idle", how);
        r.controller.destroy();
    }
});

/** The replan answer is lost or unusable, so the server may already have adopted the lowered plan. */
const AMBIGUOUS_ANSWERS = {
    unanswered: Array.from({ length: 3 }, () => ({ status: 503 })),
    malformed: [{ status: 200, body: { unexpected: true } }],
} as const;

test("a lowering whose answer is lost or unusable reconnects instead of keeping the old plan", async () => {
    for (const how of ["unanswered", "malformed"] as const) {
        const r = await rig();
        r.server.next.push(advertised(), advertised({ recipeKbps: STEP_DOWN_KBPS }));
        await playPastGrace(r);
        const id = [...r.server.sessions.keys()].pop();
        assert.ok(id !== undefined);
        r.h.fake.script(`/playback/${id}/replan`, ...AMBIGUOUS_ANSWERS[how]);
        r.avplay.listener?.onbufferingstart();
        await r.h.clock.advance(6000);
        await r.h.clock.advance(4000);
        const view = last(r);
        assert.equal(view.phase === "loading" && view.detail, "reconnecting", `${how}: the server may have adopted the new plan, so the old one is not kept`);
        assert.notEqual(r.avplay.state, "PLAYING", `${how}: the old transport is closed`);
        await r.h.clock.advance(0);
        await finishOpen(r);
        assert.equal(last(r).phase, "playing", `${how}: the plan the server holds plays`);
        r.controller.destroy();
    }
});

test("going offline mid-stall is an outage: the stall in progress does not lower", async () => {
    const listeners = new Map<string, () => void>();
    const target = globalThis as unknown as Record<string, unknown>;
    target.addEventListener = (type: string, listener: () => void) => { listeners.set(type, listener); };
    target.removeEventListener = (type: string) => { listeners.delete(type); };
    try {
        const r = await rig();
        r.server.next.push(advertised());
        await playPastGrace(r);
        r.avplay.listener?.onbufferingstart();
        await r.h.clock.advance(2000);
        Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
        listeners.get("offline")?.();
        await r.h.clock.advance(20_000);
        assert.equal(qualityChanges(r).length, 0);
        r.controller.destroy();
        assert.equal(listeners.size, 0, "destroy removes the connectivity listeners");
    } finally {
        delete target.addEventListener;
        delete target.removeEventListener;
    }
});

test("a mode that cannot be read falls back to the last one read, not to the default", async () => {
    const r = await rig("never");
    r.server.next.push(advertised(), advertised());
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    await finishOpen(r);
    r.controller.back();
    // The next attempt's settings read fails.
    r.h.fake.script("/settings/values/effective?keys=playback.buffering_quality_mode", problem(500, "internal", "Down"));
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    await finishOpen(r);
    r.avplay.tick(13_000);
    await r.h.clock.advance(11_000);
    r.avplay.listener?.onbufferingstart();
    await r.h.clock.advance(20_000);
    assert.equal(qualityChanges(r).length, 0);
    r.controller.destroy();
});

test("the mode the Settings row saves for this TV is the mode the player reads", async () => {
    const r = await rig("never", "row");
    r.server.next.push(advertised());
    await playPastGrace(r);
    r.avplay.listener?.onbufferingstart();
    await r.h.clock.advance(20_000);
    r.avplay.listener?.onbufferingcomplete();
    await r.h.clock.advance(0);
    assert.equal(bodies(r, "/replan").length, 0);
    assert.equal(pill(r), undefined);
    assert.equal(bodies(r, "/playback/start")[0]?.learned_limit, "ignore");
    r.controller.destroy();
});
