import assert from "node:assert/strict";
import { test } from "node:test";
import { currentChapter, videoOptions } from "../../src/player/playerHUD.ts";
import { decodePlayerChapters } from "../../src/contracts/v2/chapters.ts";
import { HUDState } from "../../src/player/hudState.ts";
import { FakeAVPlay } from "./support/fakeAVPlay.ts";
import type { PlaybackPlan } from "../../src/contracts/v2/playback.ts";
import { decodePlaybackDecision } from "../../src/contracts/v2/playback.ts";
import { fixture } from "./support/fakeSilo.ts";

test("video settings validate before calling AVPlay, retain confirmed values on failure and restore after reopen", () => {
    const decision = decodePlaybackDecision(fixture("playback_start_opaque_ids"));
    assert.ok(decision.outcome === "playable");
    const plan: PlaybackPlan = decision.plan;
    const calls: string[] = [];
    let fail = false;
    const avplay = Object.assign(new FakeAVPlay(), {
        setSpeed(speed: number) { if (fail) throw new Error("Unsupported"); calls.push(`speed ${speed}`); },
        setDisplayMethod(mode: "PLAYER_DISPLAY_MODE_LETTER_BOX" | "PLAYER_DISPLAY_MODE_FULL_SCREEN") { calls.push(mode); },
    });
    const hud = new HUDState();
    hud.setVideo(avplay, plan, "speed", "1.5");
    assert.deepEqual(calls, []);
    hud.setVideo(avplay, plan, "speed", "2");
    hud.setVideo(avplay, plan, "aspect", "Stretch");
    assert.equal(hud.speed, 2);
    assert.equal(hud.aspect, "Stretch");
    fail = true;
    hud.setVideo(avplay, plan, "speed", "1");
    assert.equal(hud.speed, 2);
    assert.match(hud.message, /unavailable/);
    fail = false;
    hud.restore(avplay, plan);
    assert.deepEqual(calls, ["speed 2", "PLAYER_DISPLAY_MODE_FULL_SCREEN", "speed 2", "PLAYER_DISPLAY_MODE_FULL_SCREEN"]);
    avplay.setDisplayMethod = () => { throw new Error("Unsupported aspect"); };
    hud.restore(avplay, plan);
    assert.equal(hud.speed, 2, "an aspect error cannot change the successfully restored speed");
    assert.equal(hud.aspect, undefined, "a failed restore cannot claim an unconfirmed default");
});

test("chapters belong to the effective file and retain source seconds", () => {
    const chapters = decodePlayerChapters({ versions: [
        { file_id: "other", chapters: [{ index: 0, title: "Wrong", start_seconds: 0, end_seconds: 30 }] },
        { file_id: "42", chapters: [{ index: 0, title: "", start_seconds: 0, end_seconds: 30 }, { index: 1, title: "Second", start_seconds: 30, end_seconds: 80 }] },
    ] }, "42");
    assert.equal(chapters[0]?.title, "Chapter 1");
    assert.equal(currentChapter(chapters, 29.9), 0);
    assert.equal(currentChapter(chapters, 30), 1);
    assert.equal(currentChapter(chapters, -1), -1);
    assert.deepEqual(decodePlayerChapters({ versions: [{ file_id: "42" }] }, "42"), []);
    assert.throws(() => decodePlayerChapters({ versions: [{ file_id: "42", chapters: [{ index: 0, title: "Bad", start_seconds: -1, end_seconds: 2 }] }] }, "42"));
});

test("AVPlay speed options are the supported Apple intersection; omit unproven crop-to-fill", () => {
    assert.deepEqual(videoOptions(true, true, "http_progressive"), { speeds: [1, 2], aspects: ["Fit", "Stretch"] });
    assert.deepEqual(videoOptions(true, true, "hls").speeds, []);
    assert.deepEqual(videoOptions(false, false, "http"), { speeds: [], aspects: [] });
});
