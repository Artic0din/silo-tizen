// The native playback controller against the fake Silo's playback operations and a fake AVPlay
// that keeps the platform's state order and uncancellable callbacks. Each test checks the server
// requests and source positions, not only what the player shows.

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { type PlaybackDeps, type PlaybackError, PlaybackController, type PlaybackView, type PlayRequest } from "../../src/player/controller.ts";
import type { EpisodeSpoilerSettings } from "../../src/ui/episodeSpoilers.ts";
import { FakeAVPlay } from "./support/fakeAVPlay.ts";
import { FakePlayback } from "./support/fakePlayback.ts";
import { FakeSilo, fixture, problem, type RecordedRequest } from "./support/fakeSilo.ts";
import { ManualClock } from "./support/clock.ts";
import { FakeSettings } from "./support/fakeSettings.ts";
import { SettingsState } from "../../src/ui/settingsState.ts";
import { NEXT_UP_KEY } from "../../src/contracts/v2/settings.ts";
import { FakeCatalog } from "./support/fakeCatalog.ts";
import { HDR_KEY, SEEK_BACK_KEY, SEEK_FORWARD_KEY, SEEK_KEYS } from "../../src/contracts/v2/settings.ts";
import { clientCapabilities, playbackContext } from "../../src/player/capabilities.ts";
import { operations } from "../../src/api/operations.ts";
import { setAppLanguage } from "../../src/i18n/language.ts";
import { registerSourceCatalogs } from "./support/catalogs.ts";
import { connected, type Harness, signIn } from "./support/harness.ts";

const MOVIE: PlayRequest = { contentId: "movie-1", fileId: "42", title: "Movie", startSeconds: 12.5 };

test("READY foreground restore reapplies the selected speed and aspect", async () => {
    const r = await rig();
    const applied: string[] = [];
    Object.assign(r.avplay, {
        setSpeed: (value: number) => applied.push(`speed ${value}`),
        setDisplayMethod: (value: string) => applied.push(value),
    });
    await playMovie(r);
    r.controller.setVideo("speed", "2");
    r.controller.setVideo("aspect", "Stretch");
    r.avplay.listener?.onerror("PLAYER_ERROR_NOT_SUPPORTED_FORMAT");
    await r.h.clock.advance(0);
    r.controller.suspend();
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    if (r.avplay.calls.at(-1)?.startsWith("seekTo")) {
        r.avplay.finishSeek();
        await r.h.clock.advance(0);
    }
    applied.length = 0;
    r.controller.restore();
    await r.h.clock.advance(0);
    assert.deepEqual(applied, ["speed 2", "PLAYER_DISPLAY_MODE_FULL_SCREEN"]);
    r.controller.destroy();
});

test("HUD chapters read the effective watch file, expose failures and retry without restarting playback", async () => {
    const r = await rig();
    r.h.fake.script("/watch/movie-1?file_id=42", problem(404, "not_found", "Unavailable"));
    await playMovie(r);
    let view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.hud?.chapterState, "failed", JSON.stringify(r.h.fake.requests.filter(request => request.path.includes("watch"))));
    r.h.fake.script("/watch/movie-1?file_id=42", { status: 200, body: { versions: [{ file_id: "42", chapters: [{ index: 0, title: "First", start_seconds: 0, end_seconds: 90 }] }] } });
    r.controller.retryChapters();
    await r.h.clock.advance(0);
    view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.deepEqual(view.hud?.chapters, [{ title: "First", seconds: 0 }]);
    assert.equal(sessionIds(r.server).length, 1);
    r.controller.destroy();
});

test("live autoplay reflects the effective device override after a profile write", async () => {
    const r = await autoplayRig(true);
    await playMovie(r);
    r.h.fake.script("/settings/values/effective?keys=playback.auto_play_next", { status: 200, body: { revision: 24, items: [{ key: "playback.auto_play_next", value: true, source: "profile_device", definition_revision: 24 }] } });
    r.controller.toggleAutoNext();
    await r.h.clock.advance(0);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.hud?.autoNext, true);
    assert.match(view.hud?.message ?? "", /device|TV|override/i);
    r.controller.destroy();
});

test("live autoplay saves once while pending and retains the old value on refusal", async () => {
    const r = await autoplayRig(false);
    await playMovie(r);
    r.h.fake.script("/settings/values/playback.auto_play_next?scope=profile", problem(403, "forbidden", "Unavailable"));
    const hold = r.h.fake.hold("/settings/values/playback.auto_play_next?scope=profile");
    r.controller.toggleAutoNext();
    r.controller.toggleAutoNext();
    await r.h.clock.advance(0);
    let view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.hud?.busy, true);
    assert.equal(r.h.fake.requests.filter(request => request.method === "PUT" && request.path.includes("playback.auto_play_next")).length, 1);
    hold.release();
    await r.h.clock.advance(0);
    view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.hud?.autoNext, false);
    assert.match(view.hud?.message ?? "", /Could not save/);
    r.controller.destroy();
});

test("EOF waits for a pending Auto-play save before starting a countdown", async () => {
    const r = await autoplayRig(true);
    r.settings.overrides.delete("playback.auto_play_next");
    r.settings.profile().set("playback.auto_play_next", true);
    await playMovie(r, EPISODE);
    const hold = r.h.fake.hold("/settings/values/playback.auto_play_next?scope=profile");
    r.controller.toggleAutoNext();
    await r.h.clock.advance(0);
    r.settings.profile().set("playback.auto_play_next", true);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.equal(bodies(r.h, "/start").length, 1, "the old effective value must not start the next episode while the save is pending");
    assert.equal(completion(r).countdown, undefined);
    r.settings.profile().set("playback.auto_play_next", false);
    hold.release();
    await r.h.clock.advance(15000);
    assert.equal(completion(r).countdown, undefined);
    assert.equal(bodies(r.h, "/start").length, 1);
    r.controller.destroy();
});

test("a discovery settings read started before a save cannot overwrite Auto-play next", async () => {
    const r = await autoplayRig(true);
    r.settings.overrides.delete("playback.auto_play_next");
    r.settings.profile().set("playback.auto_play_next", true);
    // Discovery reads the preference at the first frame (as Apple's lookup starts once the item loads): hold it after the start's own reads.
    const path = "/settings/values/effective?keys=playback.auto_play_next";
    const hold = await playMovieWith(r, EPISODE, () => r.h.fake.hold(path));
    const view = last(r.views);
    assert.ok(view.phase === "playing" && view.durationSeconds !== undefined);
    r.avplay.tick((view.durationSeconds - 20) * 1000);
    await r.h.clock.advance(0);
    r.controller.toggleAutoNext();
    await r.h.clock.advance(0);
    const saved = last(r.views);
    assert.ok(saved.phase === "playing");
    assert.equal(saved.hud?.autoNext, false);
    hold.release();
    await r.h.clock.advance(0);
    const later = last(r.views);
    assert.ok(later.phase === "playing");
    assert.equal(later.hud?.autoNext, false);
    r.controller.destroy();
});

test("a completed Shuffle item advances the same server session before offering its next pick", async () => {
    const r = await rig();
    r.h.fake.script("/shuffles/sh1/advance", { status: 200, body: { id: "sh1", current: { content_id: MOVIE.contentId }, next: { content_id: MOVIE.contentId } } });
    scriptParts(r, [{ file_id: "42", duration_seconds: 3000 }]);
    await playMovie(r, { ...MOVIE, shuffleId: "sh1" });
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    const advance = r.h.fake.requests.filter(request => request.path === "/shuffles/sh1/advance");
    assert.equal(advance.length, 1);
    assert.deepEqual(advance[0]?.body, { from_content_id: MOVIE.contentId });
    assert.equal(last(r.views).phase, "completion");
    r.controller.destroy();
});

test("the next Shuffle pick starts and reports progress from zero although it has a saved position", async () => {
    const r = await episodeRig();
    r.h.fake.script("/shuffles/sh1/advance", { status: 200, body: { id: "sh1", current: { content_id: "episode:s1e13" }, next: { content_id: "episode:s1e13" } } });
    r.h.fake.script("/watch/episode%3As1e13", { status: 200, body: { content_id: "episode:s1e13", type: "episode", title: "Next", season_number: 1, episode_number: 13, versions: [{ file_id: "43", duration_seconds: 3000 }], user_data: { played: false, position_seconds: 900, last_file_id: "43" } } });
    await playMovie(r, { ...EPISODE, shuffleId: "sh1" });
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    const ready = completion(r);
    assert.equal(ready.state, "ready");
    assert.equal(ready.next?.startSeconds, 0);
    r.controller.playNext();
    await r.h.clock.advance(0);
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    const starts = bodies(r.h, "/start");
    assert.equal(starts[1]?.file_id, "43");
    assert.equal(starts[1]?.start_position, 0);
    assert.equal(r.avplay.calls.some(call => call.startsWith("seekTo")), false);
    r.controller.destroy();
});

const PART_VERSIONS = [
    { file_id: "42", duration_seconds: 3000, resolution: "1080p", presentation_group_key: "g", presentation_part_index: 1 },
    { file_id: "43", duration_seconds: 3000, resolution: "1080p", presentation_group_key: "g", presentation_part_index: 2 },
];

function scriptParts(r: Rig, versions: readonly Record<string, unknown>[] = PART_VERSIONS): void {
    r.h.fake.script("/watch/movie-1", { status: 200, body: { content_id: "movie-1", type: "movie", title: "Movie", versions, user_data: { played: false } } });
}

// Apple plays every part of a Shuffle pick before it advances (silo-apple 27cf4a2 PlayerViewModel.nextShufflePart / playShufflePart).
test("a Shuffle pick's next part plays from its beginning after the finished part is reported, and the Shuffle does not advance", async () => {
    const r = await rig();
    scriptParts(r);
    await playMovie(r, { ...MOVIE, shuffleId: "sh1", startSeconds: 0 });
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    assert.deepEqual(ops(r.h), ["GET /playback/capabilities", "POST /playback/start", "DELETE /playback/S1", "GET /playback/capabilities", "POST /playback/start"], "part 1 is stopped at its end before part 2 starts");
    const starts = bodies(r.h, "/start");
    assert.equal(starts.length, 2);
    assert.equal(starts[1]?.file_id, "43");
    assert.equal(starts[1]?.start_position, 0);
    assert.equal(r.h.fake.requests.some(request => request.path === "/shuffles/sh1/advance"), false);
    assert.equal(last(r.views).phase, "playing");
    r.controller.destroy();
});

test("the last part of a Shuffle pick advances the Shuffle from the item once, after the earlier part", async () => {
    const r = await rig();
    scriptParts(r);
    r.h.fake.script("/shuffles/sh1/advance", { status: 200, body: { id: "sh1", current: { content_id: MOVIE.contentId }, next: { content_id: MOVIE.contentId } } });
    await playMovie(r, { ...MOVIE, shuffleId: "sh1", startSeconds: 0 });
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    scriptParts(r);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    const advance = r.h.fake.requests.filter(request => request.path === "/shuffles/sh1/advance");
    assert.equal(advance.length, 1);
    assert.deepEqual(advance[0]?.body, { from_content_id: MOVIE.contentId });
    assert.equal(bodies(r.h, "/start").length, 2, "no third part");
    assert.equal(last(r.views).phase, "completion");
    r.controller.destroy();
});

test("a Shuffle pick with no later part advances the Shuffle", async () => {
    const r = await rig();
    scriptParts(r, [PART_VERSIONS[0] as Record<string, unknown>]);
    r.h.fake.script("/shuffles/sh1/advance", { status: 200, body: { id: "sh1", current: { content_id: MOVIE.contentId }, next: { content_id: MOVIE.contentId } } });
    await playMovie(r, { ...MOVIE, shuffleId: "sh1", startSeconds: 0 });
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.equal(r.h.fake.requests.filter(request => request.path === "/shuffles/sh1/advance").length, 1);
    assert.equal(bodies(r.h, "/start").length, 1);
    r.controller.destroy();
});

test("a Shuffle working out its next pick reads Up Next at Random over Picking at random, from the controller", async () => {
    const r = await rig();
    scriptParts(r, [PART_VERSIONS[0] as Record<string, unknown>]);
    const advance = r.h.fake.hold("/shuffles/sh1/advance");
    r.h.fake.script("/shuffles/sh1/advance", { status: 200, body: { id: "sh1", current: { content_id: MOVIE.contentId }, next: { content_id: MOVIE.contentId } } });
    await playMovie(r, { ...MOVIE, shuffleId: "sh1", startSeconds: 0 });
    r.avplay.listener?.onstreamcompleted();
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    assert.equal(r.h.fake.requests.filter(request => request.path === "/shuffles/sh1/advance").length, 1, "the next pick is being read");
    assert.equal(completion(r).state, "resolving");
    assert.equal(completion(r).status, "upNext.headingShuffle", "Apple's statusLabel for a Shuffle, not Playing Next");
    assert.equal(completion(r).shuffle, true, "so the title reads Picking at random");
    advance.release();
    r.controller.destroy();
});

test("a failed read of the pick's parts offers a retry that plays the next part, not the shuffle advance", async () => {
    const r = await rig();
    r.h.fake.script("/watch/movie-1", problem(500, "server_error", "Unavailable"));
    scriptParts(r);
    await playMovie(r, { ...MOVIE, shuffleId: "sh1", startSeconds: 0 });
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.equal(completion(r).state, "failed");
    assert.equal(completion(r).status, "upNext.headingFinished", "nothing follows: Apple's upNext.headingFinished");
    assert.equal(completion(r).failure, undefined, "the session ended; reading what follows failed");
    assert.equal(completion(r).shuffle, true, "the card words a Shuffle's end as Apple's does");
    r.controller.retryCompletion();
    await r.h.clock.advance(0);
    assert.equal(bodies(r.h, "/start")[1]?.file_id, "43");
    assert.equal(r.h.fake.requests.some(request => request.path === "/shuffles/sh1/advance"), false);
    r.controller.destroy();
});

// Apple's playShufflePart goes through beginFreshLoad(origin: .autoplay): a plain loading state, never the end screen.
test("the screens between a Shuffle pick's parts never show the completion screen", async () => {
    const r = await rig();
    scriptParts(r);
    await playMovie(r, { ...MOVIE, shuffleId: "sh1", startSeconds: 0 });
    const from = r.views.length;
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    const seen = r.views.slice(from);
    assert.equal(seen.some(view => view.phase === "completion"), false, JSON.stringify(seen.map(view => view.phase)));
    assert.equal(seen[0]?.phase, "loading");
    assert.equal(last(r.views).phase, "playing");
    r.controller.destroy();
});

test("a missing item at the between-parts read moves the Shuffle on instead of offering a retry", async () => {
    const r = await rig();
    r.h.fake.script("/watch/movie-1", problem(404, "not_found", "Unavailable"));
    r.h.fake.script("/shuffles/sh1/advance", { status: 200, body: { id: "sh1", current: { content_id: MOVIE.contentId }, next: { content_id: MOVIE.contentId } } });
    await playMovie(r, { ...MOVIE, shuffleId: "sh1", startSeconds: 0 });
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.equal(r.h.fake.requests.filter(request => request.path === "/shuffles/sh1/advance").length, 1);
    assert.notEqual(completion(r).state, "failed");
    r.controller.destroy();
});

test("a finished part's stop reports its end position", async () => {
    const r = await rig();
    scriptParts(r);
    await playMovie(r, { ...MOVIE, shuffleId: "sh1", startSeconds: 0 });
    r.avplay.listener?.oncurrentplaytime(2999000);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    const stop = only(playbackRequests(r.h).filter(request => request.method === "DELETE"));
    assert.equal(stop.body?.position, 2999);
    r.controller.destroy();
});

test("tearing down while the between-parts read is in flight paints nothing and sends nothing further", async () => {
    const r = await rig();
    scriptParts(r);
    await playMovie(r, { ...MOVIE, shuffleId: "sh1", startSeconds: 0 });
    const hold = r.h.fake.hold("/watch/movie-1");
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.ok(r.h.fake.requests.some(request => request.path === "/watch/movie-1"), "the read is in flight");
    r.controller.destroy();
    const viewsAfter = r.views.length;
    const requestsAfter = r.h.fake.requests.length;
    hold.release();
    await r.h.clock.advance(0);
    assert.equal(r.views.length, viewsAfter);
    assert.equal(r.h.fake.requests.length, requestsAfter);
});

// Apple's nextShufflePart is nil outside a Shuffle: a plain play of part 1 ends there.
test("a part played outside a Shuffle does not continue to the next part", async () => {
    const r = await rig();
    scriptParts(r);
    await playMovie(r, { ...MOVIE, startSeconds: 0 });
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.equal(bodies(r.h, "/start").length, 1);
    r.controller.destroy();
});

function scriptAI(r: Rig, translate = true): void {
    r.h.fake.script("/subtitles/ai/status", { status: 200, body: { state: "available", allowed: true, enabled: translate, transcribe_enabled: true } });
    r.h.fake.script("/subtitles/ai/quota", ...Array.from({ length: 3 }, () => ({ status: 200, body: { limited: true, limit: 5, used: 3, remaining: 2, period: "month" } })));
    r.h.fake.script("/settings/contract", { status: 200, body: { option_sets: { playback_subtitle_languages: { options: [{ value: "fr" }, { value: "en" }, { value: "ja" }] } } } });
}

test("the AI Subtitles… menu lists languages from the file's tracks and a language starts the job its tracks call for", async () => {
    const r = await rig();
    scriptAI(r);
    r.h.fake.script("/subtitles/ai/translate", { status: 202, body: { job: { id: "opaque-job", media_file_id: "42", kind: "translate", source_index: 0, target_language: "fr", status: "running", progress: 0.25, progress_message: "Translating cues" } } });
    await playMovie(r);
    await r.h.clock.advance(0);
    let view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.deepEqual(view.tracks.aiMenu?.menu.suggested.map(row => [row.code, row.hint]), [["en", "subtitleSearch.originalLanguage"]], "the spoken language is suggested");
    assert.deepEqual(view.tracks.aiMenu?.menu.other.map(row => row.code), ["fr", "ja"]);
    assert.equal(view.tracks.aiMenu?.quota, undefined, "every language has a text track to translate, so none spends transcription quota");
    r.controller.startSubtitleAI("fr");
    await r.h.clock.advance(0);
    // An English text track is the translation source: the first one, by its server index.
    assert.deepEqual(only(r.h.fake.requests.filter(request => request.path === "/subtitles/ai/translate")).body, { media_file_id: "42", kind: "translate", source_index: 0, source_language: "eng", target_language: "fr", start_position: 12.5 });
    view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.deepEqual(view.tracks.ai && { phase: view.tracks.ai.phase, progress: view.tracks.ai.progress }, { phase: "busy", progress: { percent: 25, message: "Translating cues" } });
    r.controller.startSubtitleAI("ja");
    assert.equal(r.h.fake.requests.filter(request => request.path === "/subtitles/ai/translate").length, 1, "one job at a time");
    r.controller.destroy();
});

test("with translation off the spoken language is transcribed and any other language is not offered", async () => {
    const r = await rig();
    scriptAI(r, false);
    r.h.fake.script("/subtitles/ai/translate", { status: 202, body: { job: { id: "opaque-job", media_file_id: "42", kind: "transcribe", source_index: 0, target_language: "", status: "running" } } });
    await playMovie(r);
    await r.h.clock.advance(0);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.deepEqual(view.tracks.aiMenu?.menu.suggested.concat(view.tracks.aiMenu.menu.other).map(row => [row.code, row.disabled]), [["en", false], ["fr", true], ["ja", true]]);
    assert.equal(view.tracks.aiMenu?.quota, "3 of 5 used / month", "every language relies on transcription");
    r.controller.startSubtitleAI("fr");
    assert.equal(r.h.fake.requests.some(request => request.path === "/subtitles/ai/translate"), false, "a disabled row sends nothing");
    r.controller.startSubtitleAI("en");
    await r.h.clock.advance(0);
    assert.deepEqual(only(r.h.fake.requests.filter(request => request.path === "/subtitles/ai/translate")).body, { media_file_id: "42", kind: "transcribe", source_index: 0, source_language: "", target_language: "", start_position: 12.5 });
    r.controller.destroy();
});

test("a plan with no selected audio index still transcribes the default audio, as Apple's server-default does", async () => {
    const r = await rig();
    scriptAI(r, false);
    r.h.fake.script("/subtitles/ai/translate", { status: 202, body: { job: { id: "opaque-job", media_file_id: "42", kind: "transcribe", source_index: 0, target_language: "", status: "running" } } });
    // A packaged stream: an original file without the ordinal is a failed route (#507).
    r.server.next.push({ omitAudioIndex: true, delivery: "server_remux_hls" });
    await playMovie(r);
    await r.h.clock.advance(0);
    r.controller.startSubtitleAI("en");
    await r.h.clock.advance(0);
    assert.equal(only(r.h.fake.requests.filter(request => request.path === "/subtitles/ai/translate")).body?.source_index, 0);
    r.controller.destroy();
});

test("completed AI subtitles resolve through fresh sync identities before selecting the returned track", async () => {
    const r = await rig();
    scriptAI(r, false);
    r.h.fake.script("/subtitles/ai/translate", { status: 202, body: { job: { id: "opaque-job", media_file_id: "42", kind: "transcribe", source_index: 0, target_language: "", status: "completed", result_subtitle_id: "opaque-result" } } });
    // Sync is available: the first listing has the sidecar's key, the one after the replan also the AI result's.
    r.h.fake.script("/subtitles/sync/status", { status: 200, body: { revision: "r", state: "available", allowed: true, auto_sync: true, external: true } });
    const aiState = { key: "stored-opaque-result", media_file_id: "42", source: "downloaded", language: "en", format: "srt", label: "AI", timing: { offset_ms: 0, scale: 1 } };
    r.h.fake.script("/subtitles/42/sync", { status: 200, body: { subtitles: [{ ...aiState, key: "external-f903db1c5624c46c4a2c20f2fd8cd247fc0d46e6471c91d4ddb651ae4e039448", source: "external" }] } }, { status: 200, body: { subtitles: [aiState] } });
    await playMovie(r);
    await r.h.clock.advance(0);
    r.controller.startSubtitleAI("en");
    await r.h.clock.advance(0);
    let view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.tracks.ai?.results[0]?.label, "AI-transcribed");
    assert.equal(bodies(r.h, "/replan").length, 0, "job completion does not interrupt playback");
    const file = r.server.files.get("42");
    assert.ok(file);
    r.server.files.set("42", { ...file, inventory: file.inventory.map((track, index) => index === 4 ? { ...track, sync_key: "stored-opaque-result" } : track) });
    r.server.next.push({}, { subtitle: 4, subtitleArtifact: { url: `${r.h.fake.origin}/api/v2/captions?token=synthetic`, format: "vtt", timing_origin_seconds: 0 } });
    r.h.fake.script("/captions?token=synthetic", { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nAI text" });
    const opens = r.avplay.urls.length;
    const closes = r.avplay.calls.filter((call) => call === "close").length;
    r.controller.selectAIResult("opaque-result");
    for (let step = 0; step < 5; step++) await r.h.clock.advance(0);
    assert.equal(bodies(r.h, "/replan").length, 2, "refresh then select server-returned identity");
    const selected = bodies(r.h, "/replan")[1]?.selected_tracks;
    assert.equal(typeof selected, "object");
    assert.deepEqual((selected as { subtitle: unknown }).subtitle, { id: "file:42:subtitle:4" });
    // Both answers only renew `st` on the open direct-play path. The old prepare/seek steps
    // waited on a reopen that the renewed token caused.
    assert.equal(r.avplay.urls.length, opens);
    assert.equal(r.avplay.calls.filter((call) => call === "close").length, closes);
    assert.equal(r.avplay.state, "PLAYING");
    view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.tracks.selectedSubtitleId, "file:42:subtitle:4");
    assert.equal(view.tracks.subtitles.find(track => track.id === "file:42:subtitle:4")?.label, "AI-transcribed");
    assert.equal(r.h.fake.requests.filter(request => request.path === "/subtitles/42/sync").length, 2, "the kept stream's new subtitle is listed for sync");
    assert.equal(view.tracks.syncTiming?.key, "stored-opaque-result");
    r.controller.destroy();
});

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
        else {
            assert.equal(view.captions?.status, "failed");
            assert.ok(view.tracks.notices.includes("Subtitle data couldn’t be loaded. Turn subtitles off and on to retry."));
        }
        r.controller.destroy();
    }
});

test("a sidecar that ends early keeps its cues on screen, is refetched after 2 s and never shows the failure", async () => {
    const r = await rig();
    r.server.next.push({ subtitle: 0, subtitleArtifact: { url: `${r.h.fake.origin}/api/v2/captions?token=synthetic`, format: "vtt", timing_origin_seconds: 0 } });
    r.h.fake.script("/captions?token=synthetic", { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nFirst\n\n", cut: true });
    r.h.fake.script("/captions?token=synthetic", { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nFirst\n\n00:20.000 --> 00:22.000\nSecond" });
    await playMovie(r);
    r.avplay.tick(13000);
    let view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.captions?.text, "First", "the cues that arrived show while the file is fetched again");
    assert.equal(view.captions?.status, "ready");
    assert.ok(!view.tracks.notices.some(notice => /Subtitle data|Loading subtitles/.test(notice)));
    assert.equal(view.captions?.cueCount, 1);
    assert.equal(r.h.fake.requests.filter(request => request.path.startsWith("/captions")).length, 1);
    await r.h.clock.advance(2000);
    r.avplay.tick(21000);
    view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.captions?.text, "Second");
    assert.equal(view.captions?.cueCount, 2);
    assert.ok(!view.tracks.notices.some(notice => /Subtitle data|Loading subtitles/.test(notice)));
    assert.equal(r.h.fake.requests.filter(request => request.path.startsWith("/captions")).length, 2);
    r.controller.destroy();
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

async function rig(profileId = "p-owner", origin?: string, hdrProbeScopeOrSpoilers?: unknown, resolutionCap?: PlaybackDeps["resolutionCap"]): Promise<Rig> {
    const spoilers = typeof hdrProbeScopeOrSpoilers === "function" ? hdrProbeScopeOrSpoilers as () => EpisodeSpoilerSettings : undefined;
    const hdrProbeScope = typeof hdrProbeScopeOrSpoilers === "function" ? undefined : hdrProbeScopeOrSpoilers;
    const clock = new ManualClock();
    const h = await connected({ clock, fake: new FakeSilo(clock, undefined, origin) });
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
        device: { model: "QN55Q60AAFXZA", appVersion: "0.1.0", ...(hdrProbeScope === undefined ? {} : { hdrProbeScope }) },
        exits: {
            onBack: () => exits.push("back"),
            onEnd: (reason) => exits.push(`end:${reason}`),
            onError: (error) => {
                errors.push(error);
                exits.push(`error:${error.kind}`);
            },
        },
        ...(spoilers === undefined ? {} : { spoilers }),
        ...(resolutionCap === undefined ? {} : { resolutionCap }),
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

/**
 * playMovie with `setup` run after the start's own reads and before the first frame, where Up Next discovery begins (as Apple's lookup
 * starts once the item loads): a test that holds or fails a discovery read sets it up here.
 */
async function playMovieWith<T>(r: Rig, request: PlayRequest, setup: () => T): Promise<T> {
    r.controller.play(request);
    await r.h.clock.advance(0);
    const result = setup();
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    if (r.avplay.calls[r.avplay.calls.length - 1]?.startsWith("seekTo") === true) {
        r.avplay.finishSeek();
        await r.h.clock.advance(0);
    }
    assert.equal(r.avplay.state, "PLAYING");
    return result;
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

test("automatic skip undo starts after a six-second reanchor preparation", async () => {
    const r = await rig();
    const settings = new FakeSettings(r.h.fake);
    settings.remainingRows = true;
    settings.profile().set("playback.intro_skip_mode", "always");
    r.h.fake.scripted.set("/markers/files/42", [{ status: 200, body: { file_id: "42", marker_segments: [
        { kind: "intro", start_seconds: 20, end_seconds: 60 },
    ] } }]);
    r.server.next.push({ timeline: { can_seek_anywhere: false } });
    await playMovie(r);
    r.avplay.tick(20000);
    await r.h.clock.advance(0);
    assert.equal(last(r.views).phase, "loading");
    await r.h.clock.advance(6000);
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    let view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.undoSkipSeconds, 20);
    await r.h.clock.advance(4999);
    r.avplay.tick(61000);
    view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.undoSkipSeconds, 20);
    // The player screen's skip timer owns the five seconds, as Apple's IntroSkipPrompt does; the controller holds the offer.
    await r.h.clock.advance(60000);
    r.avplay.tick(62000);
    view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.undoSkipSeconds, 20);
    r.controller.destroy();
});

test("an automatic intro skip offers Watch Intro as the skip is issued, so the seek counts against its five seconds", async () => {
    const r = await rig();
    const settings = new FakeSettings(r.h.fake);
    settings.remainingRows = true;
    settings.profile().set("playback.intro_skip_mode", "always");
    r.h.fake.scripted.set("/markers/files/42", [{ status: 200, body: { file_id: "42", marker_segments: [
        { kind: "intro", start_seconds: 20, end_seconds: 60 },
    ] } }]);
    await playMovie(r);
    r.avplay.tick(20000);
    assert.equal(r.avplay.calls.at(-1), "seekTo 60000");
    let view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.undoSkipSeconds, 20, "offered while the seek is still in flight");
    r.avplay.finishSeek();
    view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.undoSkipSeconds, 20);
    r.controller.destroy();
});

test("a failed automatic skip seek offers no undo", async () => {
    const r = await rig();
    const settings = new FakeSettings(r.h.fake);
    settings.remainingRows = true;
    settings.profile().set("playback.intro_skip_mode", "always");
    r.h.fake.scripted.set("/markers/files/42", [{ status: 200, body: { file_id: "42", marker_segments: [
        { kind: "intro", start_seconds: 20, end_seconds: 60 },
    ] } }]);
    await playMovie(r);
    r.avplay.tick(20000);
    r.avplay.finishSeek("UnknownError");
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.undoSkipSeconds, undefined);
    r.controller.destroy();
});

test("intro and credits settings control markers and automatic skips can be undone", async () => {
    for (const mode of ["never", "ask", "always"] as const) {
        const r = await rig();
        const settings = new FakeSettings(r.h.fake);
        settings.remainingRows = true;
        settings.profile().set("playback.intro_skip_mode", mode);
        settings.profile().set("playback.auto_skip_credits", true);
        r.h.fake.scripted.set("/markers/files/42", [{ status: 200, body: { file_id: "42", marker_segments: [
            { kind: "intro", start_seconds: 20, end_seconds: 60 },
            { kind: "credits", start_seconds: 90, end_seconds: 100 },
        ] } }]);
        await playMovie(r);
        r.avplay.tick(20000);
        let view = last(r.views);
        assert.ok(view.phase === "playing");
        if (mode === "always") {
            assert.equal(r.avplay.calls.at(-1), "seekTo 60000");
            r.avplay.finishSeek();
            view = last(r.views);
            assert.ok(view.phase === "playing");
            assert.equal(view.undoSkipSeconds, 20);
            r.controller.seekToSeconds(20);
            r.avplay.finishSeek();
            r.avplay.tick(21000);
            assert.equal(r.avplay.positionMs, 21000);
        } else assert.equal(view.skipMarker?.kind, mode === "ask" ? "intro" : undefined);
        r.avplay.tick(90000);
        assert.equal(r.avplay.calls.at(-1), "seekTo 100000");
        r.avplay.finishSeek();
        r.controller.destroy();
    }
});

test("an automatic credits skip offers no undo, as on Apple TV", async () => {
    const r = await rig();
    const settings = new FakeSettings(r.h.fake);
    settings.remainingRows = true;
    settings.profile().set("playback.auto_skip_credits", true);
    r.h.fake.scripted.set("/markers/files/42", [{ status: 200, body: { file_id: "42", marker_segments: [
        { kind: "credits", start_seconds: 90, end_seconds: 100 },
    ] } }]);
    await playMovie(r);
    r.avplay.tick(90000);
    assert.equal(r.avplay.calls.at(-1), "seekTo 100000");
    r.avplay.finishSeek();
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.undoSkipSeconds, undefined);
    r.controller.destroy();
});

test("Skip automatically never offers Skip Intro, even after Watch Intro returns to the intro", async () => {
    const r = await rig();
    const settings = new FakeSettings(r.h.fake);
    settings.remainingRows = true;
    settings.profile().set("playback.intro_skip_mode", "always");
    r.h.fake.scripted.set("/markers/files/42", [{ status: 200, body: { file_id: "42", marker_segments: [
        { kind: "intro", start_seconds: 20, end_seconds: 60 },
    ] } }]);
    await playMovie(r);
    r.avplay.tick(20000);
    r.avplay.finishSeek();
    r.controller.seekToSeconds(20);
    r.avplay.finishSeek();
    r.avplay.tick(21000);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.skipMarker, undefined);
    r.controller.destroy();
});

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

test("a pending scrub resume publishes the latest transport command, including another Pause", async () => {
    const r = await rig();
    await playMovie(r);
    r.controller.setPaused(true);
    r.controller.seekToSeconds(45);
    r.controller.setPaused(false);
    const pending = last(r.views);
    assert.ok(pending.phase === "paused");
    assert.equal(pending.resumePending, true);
    const count = pending.transportCommandCount;
    assert.equal(count, 2);
    r.controller.setPaused(true);
    r.controller.setPaused(true);
    const paused = last(r.views);
    assert.ok(paused.phase === "paused");
    assert.equal(paused.resumePending, false);
    assert.equal(paused.transportCommandCount, 4);
    r.avplay.finishSeek();
    assert.equal(r.avplay.state, "PAUSED");
    r.controller.destroy();
});

for (const newerPause of [false, true]) test(`a committed scrub queues its target and latest intent behind a pending seek (${newerPause})`, async () => {
    const r = await rig();
    await playMovie(r);
    r.controller.setPaused(true);
    r.controller.seekToSeconds(45);
    r.controller.setPaused(false);
    r.controller.setPaused(true);
    const calls = r.avplay.calls.length;
    r.controller.seekToSeconds(60);
    r.controller.seekToSeconds(75);
    r.controller.setPaused(false);
    if (newerPause) r.controller.setPaused(true);
    assert.equal(r.avplay.calls.length, calls);
    r.avplay.finishSeek();
    assert.equal(r.avplay.calls.at(-1), "seekTo 75000");
    assert.equal(r.avplay.state, "PAUSED");
    r.avplay.finishSeek();
    assert.equal(r.avplay.positionMs, 75000);
    assert.equal(r.avplay.state, newerPause ? "PAUSED" : "PLAYING");
    r.controller.destroy();
});

for (const ending of ["back", "destroy", "suspend"] as const) test(`${ending} discards a scrub target queued behind a pending seek`, async () => {
    const r = await rig();
    await playMovie(r);
    r.controller.seekToSeconds(45);
    r.controller.seekToSeconds(75);
    const calls = r.avplay.calls.length;
    r.controller[ending]();
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.deepEqual(r.avplay.calls.slice(calls), [ending === "suspend" ? "suspend" : "close"]);
    assert.equal(r.avplay.state, ending === "suspend" ? "PLAYING" : "NONE");
    r.controller.destroy();
});

test("a queued scrub reanchor records resume without playing the outgoing stream", async () => {
    const r = await rig();
    r.server.next.push({ timeline: { can_seek_anywhere: true, seek_window_end_seconds: 60 } });
    await playMovie(r);
    r.controller.setPaused(true);
    r.controller.seekToSeconds(45);
    r.controller.seekToSeconds(75);
    r.controller.setPaused(false);
    const plays = r.avplay.calls.filter(call => call === "play").length;
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.calls.filter(call => call === "play").length, plays);
    assert.equal(only(bodies(r.h, "/replan")).operation, "seek_reanchor");
    r.avplay.finishPrepare();
    r.avplay.finishSeek();
    assert.equal(r.avplay.state, "PLAYING");
    r.controller.destroy();
});

test("a resume asked for during an in-flight seek plays once that seek settles", async () => {
    const r = await rig();
    await playMovie(r);
    r.controller.setPaused(true);
    assert.equal(last(r.views).phase, "paused");
    r.controller.seekToSeconds(45);
    r.controller.setPaused(false);
    assert.equal(r.avplay.calls[r.avplay.calls.length - 1], "seekTo 45000");
    assert.equal(r.avplay.state, "PAUSED");
    r.avplay.finishSeek();
    assert.equal(r.avplay.state, "PLAYING");
    const view = last(r.views);
    assert.equal(view.phase, "playing");
    assert.equal(view.phase === "playing" ? view.positionSeconds : undefined, 45);
    r.controller.destroy();
});

test("the latest pause request wins while a local seek is pending", async () => {
    const r = await rig();
    await playMovie(r);
    r.controller.setPaused(true);
    r.controller.seekToSeconds(45);
    r.controller.setPaused(false);
    r.controller.setPaused(true);
    r.avplay.finishSeek();
    assert.equal(r.avplay.state, "PAUSED");
    r.controller.seekToSeconds(60);
    r.controller.togglePause();
    r.controller.togglePause();
    r.avplay.finishSeek();
    assert.equal(r.avplay.state, "PAUSED");
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
    assert.ok(!capabilities.includes("dts"), "no DTS claim on Samsung TVs");
    assert.doesNotMatch(capabilities, /truehd|flac|pcm/i, "no lossless claim: AVPlay lists no TrueHD decoder and the server has no lossless target");
    assert.match(capabilities, /"codecs_audio":\["aac","ac3","eac3","mp3"\]/);
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
    assert.deepEqual(r.avplay.calls.slice(4), ["play", "getTotalTrackInfo", "getCurrentStreamInfo"], "the plan's audio ordinal already plays, so nothing is switched");
    const view = last(r.views);
    assert.equal(view.phase, "playing");
    assert.equal(view.phase === "playing" ? view.positionSeconds : -1, 12.5);
    assert.equal(view.phase === "playing" ? view.durationSeconds : -1, 7200);
    assert.deepEqual(r.exits, []);
});

test("a plain-HTTP server's own stream plays with its token, as on the Apple TV app", async () => {
    const r = await rig("p-owner", "http://192.168.1.20:8091");
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    const id = only(sessionIds(r.server));
    assert.equal(r.avplay.urls.length, 1);
    assert.match(r.avplay.urls[0] ?? "", new RegExp(`^http://192\\.168\\.1\\.20:8091/api/v2/stream/${id}\\?st=signed-\\d+&token=`));
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

test("a prepare that hangs is a failed route after 15 s, before the TV gives up on the app; its late success cannot touch the replacement", async () => {
    const r = await rig();
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    await r.h.clock.advance(14999);
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

test("prepares that hang end in the playback error page within a bounded time, with AVPlay closed and nothing left running (#650)", async () => {
    // AVPlay never answers prepareAsync (an HLS transcode it cannot open): the app must show the error page rather than wait until the TV closes it.
    const r = await rig();
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    for (let hang = 0; hang < 4; hang++) {
        await r.h.clock.advance(15000);
    }
    const replans = bodies(r.h, "/replan");
    assert.deepEqual(replans.map((body) => (body.failure as { classification?: string }).classification), ["avplay_startup_timeout", "avplay_startup_timeout", "avplay_startup_timeout"]);
    const view = last(r.views);
    assert.equal(view.phase, "error");
    assert.deepEqual(view.phase === "error" ? view.error : undefined, { kind: "playback_failed" });
    assert.equal(r.avplay.state, "NONE", "AVPlay is closed, not left in its half-open state");
    assert.equal(r.avplay.calls.filter((call) => call.startsWith("open ")).length, 4, "one open per route tried");
    assert.equal(r.avplay.calls.filter((call) => call === "close").length >= 4, true, "every hung route was closed");
    assert.equal(ops(r.h)[ops(r.h).length - 1], "DELETE /playback/S1", "the server session is stopped");
    assert.equal(r.h.clock.scheduled, 0, "no timer is left behind");
    // Nothing keeps reporting for a session that never played: the keep-alive posts made while it hung are the last.
    const progressWhileHung = bodies(r.h, "/progress").length;
    const before = playbackRequests(r.h).length;
    await r.h.clock.advance(120000);
    assert.equal(playbackRequests(r.h).length, before, "no progress or other request after the error");
    assert.equal(bodies(r.h, "/progress").length, progressWhileHung, "reporting stopped with the error page");
    assert.deepEqual(r.exits, [], "the app is not closed");
    r.controller.dismissError();
    assert.deepEqual(r.exits, ["error:playback_failed"]);
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

test("route recovery that runs out of attempts offers Retry for a fresh start at the same position", async () => {
    const r = await rig();
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    for (let failure = 0; failure < 4; failure++) {
        r.avplay.finishPrepare("UnknownError");
        await r.h.clock.advance(0);
    }
    const view = last(r.views);
    assert.equal(view.phase, "error");
    assert.deepEqual(view.phase === "error" ? view.error : undefined, { kind: "playback_failed" });
    assert.equal(view.phase === "error" && view.retryable, true);
    r.controller.retryCompletion();
    await r.h.clock.advance(0);
    const starts = bodies(r.h, "/start");
    assert.equal(starts.length, 2);
    assert.equal(starts[1]?.file_id, MOVIE.fileId);
    assert.equal(starts[1]?.start_position, MOVIE.startSeconds);
    assert.notEqual(starts[0]?.playback_attempt_id, starts[1]?.playback_attempt_id);
    assert.equal(last(r.views).phase, "loading");
    r.controller.destroy();
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

test("a retryable first start offers Retry and replays that request at the same position", async () => {
    const terminal = await rig();
    terminal.server.next.push({ terminal: "temporarily_unavailable", retryable: true });
    terminal.controller.play(MOVIE);
    await terminal.h.clock.advance(0);
    const terminalError = last(terminal.views);
    assert.equal(terminalError.phase, "error");
    assert.equal(terminalError.phase === "error" && terminalError.retryable, true);
    assert.deepEqual(terminalError.phase === "error" ? terminalError.error : undefined, {
        kind: "terminal",
        reason: "temporarily_unavailable",
        message: "Cannot play: temporarily_unavailable",
        retryable: true,
    });
    terminal.controller.retryCompletion();
    terminal.controller.retryCompletion();
    await terminal.h.clock.advance(0);
    const terminalStarts = bodies(terminal.h, "/start");
    assert.equal(terminalStarts.length, 2);
    assert.equal(terminalStarts[1]?.file_id, MOVIE.fileId);
    assert.equal(terminalStarts[1]?.start_position, MOVIE.startSeconds);
    assert.notEqual(terminalStarts[0]?.playback_attempt_id, terminalStarts[1]?.playback_attempt_id);
    assert.equal(last(terminal.views).phase, "loading");
    terminal.controller.destroy();

    const server = await rig();
    server.h.fake.script("/playback/start", problem(400, "validation_failed", "Rejected"));
    server.controller.play(MOVIE);
    await server.h.clock.advance(0);
    const serverError = last(server.views);
    assert.equal(serverError.phase === "error" && serverError.error.kind, "server");
    assert.equal(serverError.phase === "error" && serverError.retryable, true);
    server.controller.retryCompletion();
    await server.h.clock.advance(0);
    const serverStarts = bodies(server.h, "/start");
    assert.equal(serverStarts.length, 2);
    assert.equal(serverStarts[1]?.file_id, MOVIE.fileId);
    assert.equal(serverStarts[1]?.start_position, MOVIE.startSeconds);
    assert.equal(last(server.views).phase, "loading");
    server.controller.destroy();

    const network = await rig();
    network.server.next.push({ timeline: { source_start_seconds: 1200, player_start_seconds: 1200, timeline_offset_seconds: 0 } });
    network.controller.play({ ...MOVIE, startSeconds: undefined });
    await network.h.clock.advance(0);
    assert.equal("start_position" in (bodies(network.h, "/start")[0] ?? {}), false);
    network.avplay.finishPrepare("InvalidAccessError");
    await network.h.clock.advance(0);
    const networkError = last(network.views);
    assert.deepEqual(networkError.phase === "error" ? networkError.error : undefined, { kind: "network" });
    assert.equal(networkError.phase === "error" && networkError.retryable, true);
    network.controller.retryCompletion();
    await network.h.clock.advance(0);
    const networkStarts = bodies(network.h, "/start");
    assert.equal(networkStarts.length, 2);
    assert.equal(networkStarts[1]?.file_id, MOVIE.fileId);
    assert.equal(networkStarts[1]?.start_position, 1200);
    network.controller.destroy();

    const refused = await rig();
    refused.server.next.push({ terminal: "source_unreadable", retryable: false });
    refused.controller.play(MOVIE);
    await refused.h.clock.advance(0);
    const refusedError = last(refused.views);
    assert.equal(refusedError.phase === "error" && refusedError.retryable === true, false);
    refused.controller.retryCompletion();
    await refused.h.clock.advance(0);
    assert.equal(bodies(refused.h, "/start").length, 1);
    refused.controller.destroy();
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
    assert.deepEqual(r.exits, []);
    assert.equal(completion(r).state, "ready", "movies retain the On Deck screen");
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
    assert.equal(r.avplay.calls[r.avplay.calls.length - 1], "seekTo 10000", "the second skip adds to the pending target (#724)");
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(bodies(r.h, "/replan").length, 0);
    await r.h.clock.advance(10000);
    assert.equal(only(bodies(r.h, "/progress")).position, 10);
});

// PlayerViewModel.queueSkipDebounce (silo-apple main 71a3beb9, PlayerViewModel.swift:7961-7985): each skip adds to the target still in
// flight (RelativeSeek.target(current:pending:delta:)), never to the position from before the skip (#724).
for (const [name, start, skips, landing] of [
    ["Fast Forward then Rewind", 30, [30, -10], 50],
    ["Rewind then Rewind", 60, [-10, -10], 40],
    ["Fast Forward then Fast Forward", 30, [30, 30], 90],
    ["three skips while the first is in flight", 30, [30, -10, -10], 40],
] as const) test(`${name} chained during a seek lands on the summed target, as on Apple TV`, async () => {
    const r = await rig();
    await playMovie(r);
    r.avplay.tick(start * 1000);
    const seeks = (): string[] => r.avplay.calls.filter(call => call.startsWith("seekTo "));
    const before = seeks().length;
    for (const skip of skips) r.controller.seekBy(skip);
    assert.deepEqual(seeks().slice(before), [`seekTo ${(start + (skips[0] ?? 0)) * 1000}`], "one seek at a time; the rest wait");
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.deepEqual(seeks().slice(before), [`seekTo ${(start + (skips[0] ?? 0)) * 1000}`, `seekTo ${landing * 1000}`], "no key is lost, and the queued seek adds every skip to the pending target");
    r.avplay.finishSeek();
    await r.h.clock.advance(10000);
    assert.equal(only(bodies(r.h, "/progress")).position, landing);
});

test("a skip queued behind a seek that fails measures from where playback really is", async () => {
    const r = await rig();
    await playMovie(r);
    r.avplay.tick(30000);
    r.controller.seekBy(30);
    r.controller.seekBy(-10);
    r.avplay.finishSeek("UnknownError");
    await r.h.clock.advance(0);
    assert.equal(r.avplay.calls.filter(call => call.startsWith("seekTo ")).at(-1), "seekTo 20000", "Fast Forward failed at 0:30, so the Rewind goes to 0:20, not 0:50");
});

test("an absolute seek queued behind a seek that fails keeps its own target", async () => {
    const r = await rig();
    await playMovie(r);
    r.avplay.tick(30000);
    r.controller.seekBy(30);
    r.controller.seekToSeconds(100);
    r.avplay.finishSeek("UnknownError");
    await r.h.clock.advance(0);
    assert.equal(r.avplay.calls.filter(call => call.startsWith("seekTo ")).at(-1), "seekTo 100000");
});

// Each queued skip is held at 0 and the duration as it is pressed, on both paths: a seek that lands and one that fails end in
// the same place (stand-in review of #725).
for (const [name, start, skips, outcome, landing] of [
    ["a chain that reaches 0 lands", 5, [-10, -10, 30], "lands", 30],
    ["a chain that reaches 0 behind a failed seek", 5, [-10, -10, 30], "fails", 30],
    ["a chain that reaches the end lands", 7180, [30, 30, -10], "lands", 7190],
    ["a chain that reaches the end behind a failed seek", 7180, [30, 30, -10], "fails", 7190],
    ["two skips behind a failed seek", 30, [30, -10, -10], "fails", 10],
] as const) test(`${name} where each press is held at 0 and the duration`, async () => {
    const r = await rig();
    await playMovie(r);
    r.avplay.tick(start * 1000);
    for (const skip of skips) r.controller.seekBy(skip);
    r.avplay.finishSeek(outcome === "fails" ? "UnknownError" : undefined);
    await r.h.clock.advance(0);
    assert.equal(r.avplay.calls.filter(call => call.startsWith("seekTo ")).at(-1), `seekTo ${landing * 1000}`);
});

test("a skip pressed after a queued absolute seek keeps that seek's target when the seek in flight fails", async () => {
    const r = await rig();
    await playMovie(r);
    r.avplay.tick(30000);
    r.controller.seekBy(30);
    r.controller.seekToSeconds(100);
    r.controller.seekBy(-10);
    r.avplay.finishSeek("UnknownError");
    await r.h.clock.advance(0);
    assert.equal(r.avplay.calls.filter(call => call.startsWith("seekTo ")).at(-1), "seekTo 90000");
});

test("Rewind after a finished Fast Forward measures from the Fast Forward's landing, as on Apple TV", async () => {
    const r = await rig();
    await playMovie(r);
    r.avplay.tick(30000);
    r.controller.seekBy(30);
    r.avplay.finishSeek();
    await r.h.clock.advance(3000);
    r.controller.seekBy(-10);
    assert.equal(r.avplay.calls.filter(call => call.startsWith("seekTo ")).at(-1), "seekTo 50000");
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
    assert.deepEqual(r.exits, []);
    assert.equal(completion(r).state, "ready", "movies retain the On Deck screen");
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
    assert.deepEqual(r.exits, []);
    assert.equal(completion(r).state, "ready", "movies retain the On Deck screen");
    r.controller.destroy();
});

/** Catalog watch reads (`/watch/<id>`): the successor lookup and the fresh watch read after a confirmed STOP. */
const watchReads = (r: Rig): number => r.h.fake.requests.filter(q => q.path.startsWith("/watch/") && !q.path.includes("?")).length;

const EPISODE: PlayRequest = { contentId: "episode:s1e12", fileId: "42", title: "Harbor Lights chapter 1.2", startSeconds: 0, episode: true };

async function episodeRig(spoilers?: () => EpisodeSpoilerSettings, resolutionCap?: PlaybackDeps["resolutionCap"]): Promise<Rig & { catalog: FakeCatalog }> {
    const r = await rig("p-owner", undefined, spoilers, resolutionCap);
    const catalog = new FakeCatalog();
    catalog.fileIds.set(EPISODE.contentId, "42");
    catalog.fileIds.set("episode:s1e13", "43");
    r.h.fake.catalog = catalog;
    r.server.items.set(EPISODE.contentId, ["42"]);
    r.server.items.set("episode:s1e13", ["43"]);
    return { ...r, catalog };
}

test("Retry after Play next preserves the position reached before exhausted recovery", async () => {
    const r = await episodeRig();
    await playMovie(r, EPISODE);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.equal(completion(r).state, "ready");
    r.controller.playNext();
    await r.h.clock.advance(0);
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    r.avplay.tick(120000);
    r.server.next.push(...Array.from({ length: 3 }, () => ({ timeline: { source_start_seconds: 120, player_start_seconds: 120, timeline_offset_seconds: 0 } })));
    r.avplay.listener?.onerror("PLAYER_ERROR_NOT_SUPPORTED_FORMAT");
    await r.h.clock.advance(0);
    for (let failure = 0; failure < 3; failure++) {
        r.avplay.finishPrepare("UnknownError");
        await r.h.clock.advance(0);
    }
    const view = last(r.views);
    assert.ok(view.phase === "error" && view.error.kind === "playback_failed" && view.retryable);
    r.controller.retryCompletion();
    await r.h.clock.advance(0);
    const starts = bodies(r.h, "/start");
    assert.equal(starts.length, 3);
    assert.equal(starts[2]?.file_id, "43");
    assert.equal(starts[2]?.start_position, 120);
    r.controller.destroy();
});

function completion(r: Rig): Extract<PlaybackView, { phase: "completion" }> {
    const view = last(r.views);
    assert.equal(view.phase, "completion");
    assert.ok(view.phase === "completion");
    return view;
}

async function autoplayRig(enabled: boolean, promptSeconds?: number, spoilers?: () => EpisodeSpoilerSettings): Promise<Rig & { catalog: FakeCatalog; settings: FakeSettings }> {
    const r = await episodeRig(spoilers);
    const settings = new FakeSettings(r.h.fake);
    settings.overrides.set("playback.auto_play_next", enabled);
    const contract = fixture("settings_contract_ok");
    assert.ok(Array.isArray(contract.definitions));
    if (promptSeconds !== undefined) {
        contract.definitions.push({ key: "playback.next_up_prompt_seconds", introduced_in: 1, persistence: "remote", allowed_scopes: ["profile", "profile_device"], resolution_order: ["profile_device", "profile", "default"], value_schema: { type: "integer", minimum: 0, maximum: 120 }, default_value: 30 });
        settings.overrides.set("playback.next_up_prompt_seconds", promptSeconds);
    }
    contract.definitions.push({ key: "playback.auto_play_next", introduced_in: 1, persistence: "remote", allowed_scopes: ["profile", "profile_device"], resolution_order: ["profile_device", "profile", "default"], value_schema: { type: "boolean" }, default_value: true });
    r.h.fake.script("/settings/contract", { status: 200, body: contract });
    return { ...r, settings };
}

test("EOF re-reads autoplay; unreadable or disabled settings never start a countdown", async () => {
    for (const unreadable of [false, true]) {
        const r = await autoplayRig(true);
        await playMovie(r, EPISODE);
        if (!unreadable) r.settings.overrides.set("playback.auto_play_next", false);
        if (unreadable) r.h.fake.script("/settings/values/effective?keys=playback.auto_play_next", problem(500, "internal_error", "Unavailable"));
        r.avplay.listener?.onstreamcompleted();
        await r.h.clock.advance(15000);
        assert.equal(completion(r).countdown, undefined);
        assert.equal(bodies(r.h, "/start").length, 1);
        r.controller.destroy();
    }
});

test("internal countdown teardown never publishes a manual Play Now frame", async () => {
    const r = await autoplayRig(true);
    await playMovie(r, EPISODE);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.equal(completion(r).countdown, 10);
    const offset = r.views.length;
    r.controller.back();
    assert.equal(r.views.slice(offset).some(view => view.phase === "completion" && view.countdown === undefined), false);
    r.controller.destroy();
});

test("late EOF preference answers cannot revive playback after Back or profile change", async () => {
    for (const action of ["back", "profile"] as const) {
        const r = await autoplayRig(true);
        await playMovie(r, EPISODE);
        const hold = r.h.fake.hold("/settings/values/effective?keys=playback.auto_play_next");
        r.avplay.listener?.onstreamcompleted();
        await r.h.clock.advance(0);
        if (action === "back") r.controller.back();
        else r.h.core.profiles.clear();
        hold.release();
        await r.h.clock.advance(15000);
        assert.equal(last(r.views).phase, "closed");
        assert.equal(bodies(r.h, "/start").length, 1);
        r.controller.destroy();
    }
});

test("a paused rewind out of the prompt window restores the full video rectangle", async () => {
    const r = await autoplayRig(true);
    await playMovie(r, EPISODE);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    const duration = view.durationSeconds!;
    r.avplay.tick((duration - 25) * 1000);
    await r.h.clock.advance(0);
    assert.ok("upNext" in last(r.views));
    r.controller.setPaused(true);
    r.controller.seekToSeconds(duration - 55);
    r.avplay.finishSeek();
    assert.equal(last(r.views).phase, "paused");
    assert.equal("upNext" in last(r.views), false);
    assert.deepEqual(r.avplay.displayRects.at(-1), [0, 0, 1920, 1080]);
    r.controller.destroy();
});

for (const preEnd of [false, true]) {
    test(`a playable On Deck choice is available before a later detail resolves (${preEnd ? "pre-end" : "EOF"})`, async () => {
        const r = await autoplayRig(true);
        const household = [...r.catalog.households.values()][0]!;
        household.sections = [{ id: "deck", sectionType: "continue_watching", title: "On Deck", items: ["movie:m0001", "movie:m0002", "movie:m0003"] }];
        r.catalog.fileIds.set("movie:m0001", "42");
        r.catalog.fileIds.set("movie:m0002", "43");
        r.server.items.set("movie:m0001", ["42"]);
        r.server.items.set("movie:m0002", ["43"]);
        const held = r.h.fake.hold(operations.watchDetail("movie:m0003").path);
        await playMovie(r, { ...MOVIE, contentId: "movie:m0001" });
        const view = last(r.views);
        assert.ok(view.phase === "playing");
        if (preEnd) r.avplay.tick((view.durationSeconds! - 20) * 1000);
        else r.avplay.listener?.onstreamcompleted();
        await r.h.clock.advance(0);
        const ready = last(r.views);
        if (preEnd) assert.ok("upNext" in ready);
        else assert.equal(completion(r).state, "ready");
        r.controller.playNext();
        await r.h.clock.advance(0);
        assert.equal(bodies(r.h, "/start").length, 2);
        held.release();
        r.controller.destroy();
    });
}

test("Up Next appears at Apple's default 30 seconds and Keep Watching suppresses redisplay", async () => {
    const r = await autoplayRig(true);
    await playMovie(r, EPISODE);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    const duration = view.durationSeconds!;
    r.avplay.tick((duration - 31) * 1000);
    await r.h.clock.advance(0);
    assert.equal("upNext" in last(r.views), false);
    r.avplay.tick((duration - 30) * 1000);
    await r.h.clock.advance(0);
    assert.ok("upNext" in last(r.views), "panel should appear before EOF");
    const shown = last(r.views);
    assert.ok(shown.phase === "playing");
    assert.deepEqual([shown.upNext?.countdown, shown.upNext?.countdownTotal], [30, 30], "the ring runs over the prompt's 30 seconds (Apple's nextUpPromptSeconds)");
    r.controller.cancelAutoplay();
    r.avplay.tick((duration - 10) * 1000);
    await r.h.clock.advance(0);
    assert.equal("upNext" in last(r.views), false);
    r.controller.destroy();
});

test("a saved Show Next Up value changes the before-end prompt time", async () => {
    const r = await autoplayRig(false, 30);
    r.settings.overrides.delete(NEXT_UP_KEY);
    r.settings.remainingRows = true;
    r.settings.profile().set(NEXT_UP_KEY, 30);
    const settings = new SettingsState(r.h.core.session, () => undefined, r.h.clock);
    await settings.load();
    assert.equal(settings.error, undefined);
    await settings.save(NEXT_UP_KEY, 60);
    assert.equal(settings.error, undefined);
    assert.equal(r.settings.device("p-owner", r.h.core.session.http.deviceId).get(NEXT_UP_KEY), 60);
    assert.equal(r.settings.profile().get(NEXT_UP_KEY), 30);
    await playMovie(r, EPISODE);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    r.avplay.tick((view.durationSeconds! - 61) * 1000);
    await r.h.clock.advance(0);
    assert.equal("upNext" in last(r.views), false);
    r.avplay.tick((view.durationSeconds! - 60) * 1000);
    await r.h.clock.advance(0);
    assert.ok("upNext" in last(r.views));
    settings.stop();
    r.controller.destroy();
});

test("all tvOS prompt choices use the effective setting, including At end", async () => {
    for (const seconds of [0, 10, 30, 60, 120]) {
        const r = await autoplayRig(false, seconds);
        await playMovie(r, EPISODE);
        const view = last(r.views);
        assert.ok(view.phase === "playing");
        r.avplay.tick((view.durationSeconds! - seconds - 1) * 1000);
        await r.h.clock.advance(0);
        assert.equal("upNext" in last(r.views), false);
        r.avplay.tick((view.durationSeconds! - Math.max(1, seconds)) * 1000);
        await r.h.clock.advance(0);
        assert.equal("upNext" in last(r.views), seconds > 0, String(seconds));
        r.controller.destroy();
    }
});

test("a delayed prompt cannot appear after seeking out of its window, and an open panel clears", async () => {
    const r = await autoplayRig(false);
    await playMovie(r, EPISODE);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    const hold = r.h.fake.hold("/watch/" + encodeURIComponent(EPISODE.contentId));
    r.avplay.tick((view.durationSeconds! - 20) * 1000);
    await r.h.clock.advance(0);
    r.avplay.tick(100000);
    hold.release();
    await r.h.clock.advance(0);
    assert.equal("upNext" in last(r.views), false);
    r.avplay.tick((view.durationSeconds! - 20) * 1000);
    await r.h.clock.advance(0);
    assert.ok("upNext" in last(r.views));
    r.avplay.tick(100000);
    assert.equal("upNext" in last(r.views), false);
    assert.deepEqual(r.avplay.displayRects.at(-1), [0, 0, 1920, 1080]);
    r.controller.destroy();
});

// PlayerViewModel.canShowNextUpScreen (silo-apple main f70e16a, :1598-1603) shows Show Up Next for On Deck items, and Apple reads them
// once the item loads (:6604-6607). A movie mid-playback with On Deck items therefore offers the button from the start (#698).
test("a movie with On Deck items offers Show Up Next from the start, without opening Up Next", async () => {
    const r = await autoplayRig(false);
    r.catalog.fileIds.set("movie:m0001", "42");
    r.server.items.set("movie:m0001", ["42"]);
    await playMovie(r, { ...MOVIE, contentId: "movie:m0001", fileId: "42", title: "Movie 0001" });
    await r.h.clock.advance(0);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.episodes, true, "the On Deck read ran at the first frame and found items");
    assert.equal("upNext" in view, false, "far from the end nothing opens by itself");
    assert.ok(r.h.fake.requests.some(q => q.path.startsWith("/home/sections")), "the On Deck read went out without Up Next being opened");
    r.controller.showUpNext();
    await r.h.clock.advance(0);
    const opened = last(r.views);
    assert.ok(opened.phase === "playing");
    assert.equal(opened.upNext?.loading, undefined, "the first-frame read had already settled");
    assert.equal(opened.upNext?.next?.contentId, opened.upNext?.deck[0]?.contentId, "a film offers its first On Deck item");
    assert.ok((opened.upNext?.deck.length ?? 0) > 0);
    assert.equal(opened.upNext?.deck.some(item => item.contentId === "movie:m0001"), false, "the playing film is not in its own deck");
    r.controller.destroy();
});

test("a film with nothing On Deck hides Show Up Next once the first-frame read settles (#698)", async () => {
    const r = await autoplayRig(false);
    r.catalog.fileIds.set("movie:m0001", "42");
    r.server.items.set("movie:m0001", ["42"]);
    for (const section of r.catalog.households.get("p-owner")?.sections ?? []) section.items.length = 0;
    await playMovie(r, { ...MOVIE, contentId: "movie:m0001", fileId: "42", title: "Movie 0001" });
    await r.h.clock.advance(0);
    assert.ok(r.h.fake.requests.some(q => q.path.startsWith("/home/sections")), "the On Deck read ran");
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.notEqual(view.episodes, true, "an empty settled deck hides the button");
    r.controller.destroy();
});

test("an On Deck read that fails after the episode retry is still read again in the prompt window (#698)", async () => {
    const r = await autoplayRig(false);
    r.catalog.households.get("p-owner")?.sections.find(section => section.id === "continue_watching")?.items.unshift("episode:s2e11");
    const watch = "/watch/" + encodeURIComponent(EPISODE.contentId);
    const sections = "/home/sections?image_size=small";
    // The first-frame episode read fails; On Deck's read is still out when the window opens, and fails after the episode retry.
    const held = await playMovieWith(r, EPISODE, () => { r.h.fake.script(watch, problem(500, "internal_error", "Unavailable")); const hold = r.h.fake.hold(sections); r.h.fake.script(sections, problem(500, "internal_error", "Unavailable")); return hold; });
    await r.h.clock.advance(0);
    const view = last(r.views);
    assert.ok(view.phase === "playing" && view.durationSeconds !== undefined);
    r.avplay.tick((view.durationSeconds - 25) * 1000);
    await r.h.clock.advance(0);
    held.release();
    await r.h.clock.advance(0);
    const reads = r.h.fake.requests.filter(q => q.path === sections).length;
    r.avplay.tick((view.durationSeconds - 24) * 1000);
    await r.h.clock.advance(0);
    await r.h.clock.advance(0);
    assert.equal(r.h.fake.requests.filter(q => q.path === sections).length, reads + 1, "On Deck is read once more");
    const prompt = last(r.views);
    assert.ok(prompt.phase === "playing");
    assert.ok(prompt.upNext?.deck.some(item => item.contentId === "episode:s2e11"), "and its items appear");
    r.controller.destroy();
});

test("a film's failed first-frame On Deck read is read again when the prompt window opens, without opening Up Next (#698)", async () => {
    const r = await autoplayRig(false);
    r.catalog.fileIds.set("movie:m0001", "42");
    r.server.items.set("movie:m0001", ["42"]);
    const sections = "/home/sections?image_size=small";
    await playMovieWith(r, { ...MOVIE, contentId: "movie:m0001", fileId: "42", title: "Movie 0001" }, () => r.h.fake.script(sections, problem(500, "internal_error", "Unavailable")));
    await r.h.clock.advance(0);
    const view = last(r.views);
    assert.ok(view.phase === "playing" && view.durationSeconds !== undefined);
    assert.equal(r.h.fake.requests.filter(q => q.path === sections).length, 1);
    r.avplay.tick((view.durationSeconds - 25) * 1000);
    await r.h.clock.advance(0);
    await r.h.clock.advance(0);
    assert.equal(r.h.fake.requests.filter(q => q.path === sections).length, 2, "the prompt window read On Deck again");
    const prompt = last(r.views);
    assert.ok(prompt.phase === "playing");
    assert.ok((prompt.upNext?.deck.length ?? 0) > 0, "On Deck appears");
    assert.equal(prompt.upNext?.next?.contentId, prompt.upNext?.deck[0]?.contentId);
    r.controller.destroy();
});

test("failed Up Next reads are read again only once in the prompt window (#698)", async () => {
    const r = await autoplayRig(false);
    const watch = "/watch/" + encodeURIComponent(EPISODE.contentId);
    const unavailable = problem(500, "internal_error", "Unavailable");
    // Every read of the playing episode fails: the first frame's episode and On Deck reads, then both window retries.
    await playMovieWith(r, EPISODE, () => r.h.fake.script(watch, unavailable, unavailable, unavailable, unavailable));
    await r.h.clock.advance(0);
    const view = last(r.views);
    assert.ok(view.phase === "playing" && view.durationSeconds !== undefined);
    const before = r.h.fake.requests.length;
    r.avplay.tick((view.durationSeconds - 25) * 1000);
    await r.h.clock.advance(0);
    await r.h.clock.advance(0);
    const retried = r.h.fake.requests.length;
    assert.equal(r.h.fake.requests.slice(before).filter(q => q.path === watch).length, 2, "each failed read is retried once");
    for (const left of [24, 20, 15, 10]) {
        r.avplay.tick((view.durationSeconds - left) * 1000);
        await r.h.clock.advance(0);
    }
    assert.deepEqual(r.h.fake.requests.slice(retried).map(q => q.path), [], "later ticks in the window send no more reads");
    r.controller.destroy();
});

test("a next-episode read that fails at the first frame is read again when the prompt window opens (#698)", async () => {
    const r = await autoplayRig(false);
    const path = "/watch/" + encodeURIComponent(EPISODE.contentId);
    await playMovieWith(r, EPISODE, () => r.h.fake.script(path, problem(500, "internal_error", "Unavailable")));
    await r.h.clock.advance(0);
    const view = last(r.views);
    assert.ok(view.phase === "playing" && view.durationSeconds !== undefined);
    assert.equal("upNext" in view, false);
    r.avplay.tick((view.durationSeconds - 25) * 1000);
    await r.h.clock.advance(0);
    await r.h.clock.advance(0);
    const prompt = last(r.views);
    assert.ok(prompt.phase === "playing");
    assert.equal(prompt.upNext?.failed, undefined);
    assert.equal(prompt.upNext?.next?.contentId, "episode:s1e13", "the card offers the next episode before the end");
    r.controller.destroy();
});

test("Show Up Next opens the manual panel on the next episode without a countdown far from the end", async () => {
    const r = await autoplayRig(false);
    await playMovie(r, EPISODE);
    const before = last(r.views);
    assert.ok(before.phase === "playing");
    assert.equal(before.episodes, true);
    assert.equal("upNext" in before, false);
    r.controller.showUpNext();
    await r.h.clock.advance(0);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.upNext?.loading, undefined);
    assert.equal(view.upNext?.failed, undefined);
    assert.equal(view.upNext?.status, "Up Next");
    assert.equal(view.upNext?.countdown, undefined);
    assert.equal(view.upNext?.countdownTotal, 100, "opened by hand, the ring would run over Apple's 100-second HUD threshold");
    assert.equal(view.upNext?.next?.contentId, "episode:s1e13");
    assert.equal(view.upNext?.next?.title, "Harbor Lights chapter 1.3");
    r.controller.playNext();
    await r.h.clock.advance(0);
    assert.equal(bodies(r.h, "/start").length, 2);
    r.controller.destroy();
});

test("playback ticks do not repeat the Up Next catalog read", async () => {
    const r = await autoplayRig(true);
    await playMovie(r, EPISODE);
    const view = last(r.views);
    assert.ok(view.phase === "playing" && view.durationSeconds !== undefined);
    const path = "/catalog/items/" + encodeURIComponent("episode:s1e13");
    const reads = (): number => r.h.fake.requests.filter(request => request.path.split("?")[0] === path).length;
    r.avplay.tick((view.durationSeconds - 20) * 1000);
    await r.h.clock.advance(0);
    const first = reads();
    assert.equal(first, 1);
    for (let tick = 0; tick < 5; tick++) r.avplay.tick((view.durationSeconds - 19 + tick) * 1000);
    await r.h.clock.advance(0);
    assert.equal(reads(), first);
    r.controller.destroy();
});

test("a seek during Up Next discovery does not leave the manual panel loading", async () => {
    const r = await autoplayRig(false);
    // Discovery starts at the first frame (as Apple's lookup starts once the item loads): hold its watch read after the start's own reads.
    const hold = await playMovieWith(r, EPISODE, () => r.h.fake.hold("/watch/" + encodeURIComponent(EPISODE.contentId)));
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    r.controller.showUpNext();
    await r.h.clock.advance(0);
    const loading = last(r.views);
    assert.ok(loading.phase === "playing" || loading.phase === "paused");
    assert.equal(loading.upNext?.loading, true);
    r.controller.seekToSeconds(40);
    hold.release();
    await r.h.clock.advance(0);
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    const done = last(r.views);
    assert.ok(done.phase === "playing" || done.phase === "paused");
    assert.equal(done.upNext?.loading, undefined);
    assert.equal(done.upNext?.next?.contentId, "episode:s1e13");
    assert.notEqual(done.upNext?.status, "Nothing to watch next");
    r.controller.destroy();
});

test("a failed On Deck read is not cached as nothing and a later read recovers", async () => {
    const r = await autoplayRig(false);
    r.catalog.fileIds.set("movie:m0001", "42");
    r.server.items.set("movie:m0001", ["42"]);
    // Discovery's On Deck read runs from the first frame and fails; opening Up Next retries it once, and that fails too.
    const unavailable = problem(500, "internal_error", "Unavailable");
    await playMovieWith(r, { ...MOVIE, contentId: "movie:m0001", fileId: "42", title: "Movie 0001" }, () => r.h.fake.script("/home/sections?image_size=small", unavailable, unavailable));
    r.controller.showUpNext();
    await r.h.clock.advance(0);
    const failed = last(r.views);
    assert.ok(failed.phase === "playing");
    assert.equal(failed.upNext?.loading, undefined);
    assert.equal(failed.upNext?.failed, true);
    assert.equal(failed.upNext?.next, undefined);
    assert.notEqual(failed.upNext?.status, "Nothing to watch next");
    r.controller.showUpNext();
    await r.h.clock.advance(0);
    const recovered = last(r.views);
    assert.ok(recovered.phase === "playing");
    assert.equal(recovered.upNext?.failed, undefined);
    assert.equal(recovered.upNext?.next?.contentId, "episode:s1e12");
    r.controller.destroy();
});

test("prompt discovery discarded during a local seek retries after the seek settles", async () => {
    const r = await autoplayRig(false);
    await playMovie(r, EPISODE);
    const view = last(r.views);
    assert.ok(view.phase === "playing" && view.durationSeconds !== undefined);
    const hold = r.h.fake.hold("/watch/" + encodeURIComponent(EPISODE.contentId));
    r.avplay.tick((view.durationSeconds - 25) * 1000);
    await r.h.clock.advance(0);
    r.controller.seekToSeconds(view.durationSeconds - 15);
    hold.release();
    await r.h.clock.advance(0);
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    r.avplay.tick((view.durationSeconds - 14) * 1000);
    await r.h.clock.advance(0);
    assert.ok("upNext" in last(r.views));
    r.controller.destroy();
});

test("stale prompt preference failure cannot override the EOF preference read", async () => {
    const r = await autoplayRig(true);
    // Discovery's preference read runs from the first frame: it is held and then refused from there.
    const path = "/settings/values/effective?keys=playback.auto_play_next";
    const hold = await playMovieWith(r, EPISODE, () => { const held = r.h.fake.hold(path); r.h.fake.script(path, problem(400, "invalid_request", "Unavailable")); return held; });
    const view = last(r.views);
    assert.ok(view.phase === "playing" && view.durationSeconds !== undefined);
    r.avplay.tick((view.durationSeconds - 25) * 1000);
    await r.h.clock.advance(0);
    const discovery = r.h.fake.hold("/watch/" + encodeURIComponent(EPISODE.contentId));
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    hold.release();
    await r.h.clock.advance(0);
    discovery.release();
    await r.h.clock.advance(0);
    assert.equal(completion(r).countdown, 10);
    r.controller.destroy();
});

test("transport recovery retains the Up Next preview rectangle", async () => {
    const r = await autoplayRig(false);
    await playMovie(r, EPISODE);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    r.avplay.tick((view.durationSeconds! - 20) * 1000);
    await r.h.clock.advance(0);
    assert.ok("upNext" in last(r.views));
    const preview = r.avplay.displayRects.at(-1);
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(1000);
    assert.equal(r.avplay.urls.length, 2);
    assert.deepEqual(r.avplay.displayRects.at(-1), preview);
    assert.notDeepEqual(preview, [0, 0, 1920, 1080]);
    r.controller.destroy();
});

test("the Up Next preview sits on the leading side: 180 px from the left in English, from the right in Arabic", async () => {
    registerSourceCatalogs();
    for (const [language, left] of [["en", 180], ["ar", 980]] as const) {
        setAppLanguage(language);
        try {
            const r = await autoplayRig(false);
            await playMovie(r, EPISODE);
            const view = last(r.views);
            assert.ok(view.phase === "playing");
            r.avplay.tick((view.durationSeconds! - 20) * 1000);
            await r.h.clock.advance(0);
            assert.ok("upNext" in last(r.views));
            assert.deepEqual(r.avplay.displayRects.at(-1), [left, 112, 760, 428], language);
            r.controller.destroy();
        } finally { setAppLanguage("en"); }
    }
});

test("a language that lands while Up Next is showing moves the video preview with the panel", async () => {
    registerSourceCatalogs();
    setAppLanguage("en");
    try {
        const r = await autoplayRig(false);
        await playMovie(r, EPISODE);
        const view = last(r.views);
        assert.ok(view.phase === "playing");
        r.avplay.tick((view.durationSeconds! - 20) * 1000);
        await r.h.clock.advance(0);
        assert.ok("upNext" in last(r.views));
        assert.deepEqual(r.avplay.displayRects.at(-1), [180, 112, 760, 428]);
        setAppLanguage("ar");
        r.controller.refreshView();
        assert.deepEqual(r.avplay.displayRects.at(-1), [980, 112, 760, 428], "Arabic");
        setAppLanguage("en");
        r.controller.refreshView();
        assert.deepEqual(r.avplay.displayRects.at(-1), [180, 112, 760, 428], "and back");
        r.controller.destroy();
    } finally { setAppLanguage("en"); }
});

test("optional On Deck reads never delay a playable successor before or after EOF", async () => {
    for (const eof of [false, true]) {
        const r = await autoplayRig(true);
        await playMovie(r, EPISODE);
        const view = last(r.views);
        assert.ok(view.phase === "playing");
        const hold = r.h.fake.hold("/home/sections");
        const metadata = r.h.fake.hold("/catalog/items/" + encodeURIComponent("episode:s1e13"));
        if (eof) r.avplay.listener?.onstreamcompleted();
        else r.avplay.tick((view.durationSeconds! - 20) * 1000);
        await r.h.clock.advance(0);
        if (eof) {
            assert.equal(completion(r).next?.contentId, "episode:s1e13");
            assert.equal(completion(r).countdown, 10);
        } else assert.ok("upNext" in last(r.views));
        hold.release();
        metadata.release();
        await r.h.clock.advance(0);
        r.controller.destroy();
    }
});

test("an empty successor and On Deck leave the pre-end video and progress unchanged", async () => {
    const r = await autoplayRig(false);
    for (const id of ["episode:s1e13", "episode:s1e21", "episode:s1e22", "episode:s1e23"]) r.catalog.removed.add(id);
    for (const household of r.catalog.households.values()) household.sections = [];
    await playMovie(r, EPISODE);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    r.avplay.tick((view.durationSeconds! - 20) * 1000);
    await r.h.clock.advance(10000);
    assert.equal("upNext" in last(r.views), false);
    assert.equal(only(bodies(r.h, "/progress")).position, view.durationSeconds! - 20);
    const requests = r.h.fake.requests.length;
    for (let second = 19; second > 10; second--) r.avplay.tick((view.durationSeconds! - second) * 1000);
    await r.h.clock.advance(0);
    assert.equal(r.h.fake.requests.length, requests, "empty discovery is not repeated on clock updates");
    assert.deepEqual(r.avplay.displayRects.at(-1), [0, 0, 1920, 1080]);
    r.controller.destroy();
});

test("Play Now outside the prompt window stops at the current position", async () => {
    const r = await autoplayRig(false);
    const id = await playMovie(r, EPISODE);
    const view = last(r.views);
    assert.ok(view.phase === "playing" && view.durationSeconds !== undefined && view.durationSeconds > 120);
    r.avplay.tick(60000);
    await r.h.clock.advance(0);
    assert.equal("upNext" in last(r.views), false);
    r.controller.showUpNext();
    await r.h.clock.advance(0);
    const shown = last(r.views);
    assert.ok(shown.phase === "playing");
    assert.equal(shown.upNext?.next?.contentId, "episode:s1e13");
    const stop = r.h.fake.hold(`/playback/${id}`);
    r.controller.playNext();
    await r.h.clock.advance(0);
    assert.equal(only(bodies(r.h, `/playback/${id}`)).position, 60);
    stop.release();
    r.controller.destroy();
});

test("a deck answer during a seek out of Up Next restores the full video", async () => {
    const r = await autoplayRig(false);
    await playMovie(r, EPISODE);
    const view = last(r.views);
    assert.ok(view.phase === "playing" && view.durationSeconds !== undefined);
    const hold = r.h.fake.hold("/home/sections");
    r.avplay.tick((view.durationSeconds - 20) * 1000);
    await r.h.clock.advance(0);
    assert.ok("upNext" in last(r.views));
    assert.notDeepEqual(r.avplay.displayRects.at(-1), [0, 0, 1920, 1080]);
    r.controller.seekToSeconds(60);
    hold.release();
    await r.h.clock.advance(0);
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal("upNext" in last(r.views), false);
    assert.deepEqual(r.avplay.displayRects.at(-1), [0, 0, 1920, 1080]);
    r.controller.destroy();
});

test("Up Next hides an unwatched episode synopsis when the profile asks and keeps a started one", async () => {
    const spoilers = (): EpisodeSpoilerSettings => ({ hidesImages: false, hidesOverviews: true });
    const hidden = await autoplayRig(false, undefined, spoilers);
    await playMovie(hidden, EPISODE);
    hidden.controller.showUpNext();
    await hidden.h.clock.advance(0);
    const concealed = last(hidden.views);
    assert.ok(concealed.phase === "playing");
    assert.equal(concealed.upNext?.next?.contentId, "episode:s1e13");
    assert.equal(concealed.upNext?.next?.overview, undefined);
    hidden.controller.destroy();

    const shown = await autoplayRig(false, undefined, spoilers);
    shown.catalog.progress.set("episode:s1e13", 30);
    await playMovie(shown, EPISODE);
    shown.controller.showUpNext();
    await shown.h.clock.advance(0);
    const visible = last(shown.views);
    assert.ok(visible.phase === "playing");
    assert.match(visible.upNext?.next?.overview ?? "", /synthetic episode/);
    shown.controller.destroy();
});

// The S95C captures (#721 reviews): S1E25 to S2E1 showed no still, then the series backdrop, behind the card, though the season 2 row had a still.
// Apple's backgroundArtwork (PlayerView.swift) takes the episode still first and the backdrop only when there is none.
for (const itemStill of ["still", "none", "series"] as const) {
    test(`a next episode from the next season keeps its season row's still behind the card (catalog item with ${itemStill === "still" ? "a still" : itemStill === "none" ? "no backdrop" : "the series backdrop"}) (#697)`, async () => {
        const r = await rig("p-owner");
        const catalog = new FakeCatalog();
        catalog.episodeStills = true;
        catalog.itemStill = itemStill;
        catalog.fileIds.set("episode:s1e13", "43");
        catalog.fileIds.set("episode:s1e21", "44");
        r.h.fake.catalog = catalog;
        r.server.items.set("episode:s1e13", ["43"]);
        r.server.items.set("episode:s1e21", ["44"]);
        await playMovie(r, { contentId: "episode:s1e13", fileId: "43", title: "Harbor Lights chapter 1.3", startSeconds: 0, episode: true, seriesTitle: "Harbor Lights", seasonNumber: 1, episodeNumber: 3 });
        r.controller.showUpNext();
        await r.h.clock.advance(0);
        await r.h.clock.advance(0);
        const view = last(r.views);
        assert.ok(view.phase === "playing");
        assert.equal(view.upNext?.next?.contentId, "episode:s1e21", "the next episode is season 2's first");
        assert.equal(view.upNext?.next?.backdropUrl, `/art/${encodeURIComponent("episode:s1e21")}-still.svg`, "its still is the season row's");
        assert.equal(view.upNext?.next?.backdropIsEpisodeStill, true, "and the still keeps its episode-still flag, so the spoiler setting still applies");
        r.controller.destroy();
    });
}

// #731: with no still from the season row (none sent, or an empty still_url), the card falls back to the item's backdrop, here the series
// backdrop, and keeps its "not an episode still" flag. episodeSpoilers.ts treats an empty URL as none (present()).
for (const rowStill of ["none", "empty"] as const) {
    test(`a next episode with ${rowStill === "none" ? "no season-row still" : "an empty season-row still"} shows the item's series backdrop behind the card (#731)`, async () => {
        const r = await rig("p-owner");
        const catalog = new FakeCatalog();
        catalog.episodeStills = true;
        catalog.itemStill = "series";
        catalog.rowStill = rowStill;
        catalog.fileIds.set("episode:s1e13", "43");
        catalog.fileIds.set("episode:s1e21", "44");
        r.h.fake.catalog = catalog;
        r.server.items.set("episode:s1e13", ["43"]);
        r.server.items.set("episode:s1e21", ["44"]);
        await playMovie(r, { contentId: "episode:s1e13", fileId: "43", title: "Harbor Lights chapter 1.3", startSeconds: 0, episode: true, seriesTitle: "Harbor Lights", seasonNumber: 1, episodeNumber: 3 });
        r.controller.showUpNext();
        await r.h.clock.advance(0);
        await r.h.clock.advance(0);
        const view = last(r.views);
        assert.ok(view.phase === "playing");
        assert.equal(view.upNext?.next?.contentId, "episode:s1e21");
        assert.equal(view.upNext?.next?.backdropUrl, `/art/${encodeURIComponent("series:s1")}-backdrop.svg`, "the item's series backdrop");
        assert.equal(view.upNext?.next?.backdropIsEpisodeStill, false, "flagged as not an episode still");
        r.controller.destroy();
    });
}

// #743 review (Kody): an item whose backdrop_url is empty is no backdrop either, even flagged as a still; with no row still the card has none.
test("an empty catalog-item backdrop does not replace a missing season-row still (#731)", async () => {
    const r = await rig("p-owner");
    const catalog = new FakeCatalog();
    catalog.episodeStills = true;
    catalog.itemStill = "empty";
    catalog.rowStill = "none";
    catalog.fileIds.set("episode:s1e13", "43");
    catalog.fileIds.set("episode:s1e21", "44");
    r.h.fake.catalog = catalog;
    r.server.items.set("episode:s1e13", ["43"]);
    r.server.items.set("episode:s1e21", ["44"]);
    await playMovie(r, { contentId: "episode:s1e13", fileId: "43", title: "Harbor Lights chapter 1.3", startSeconds: 0, episode: true, seriesTitle: "Harbor Lights", seasonNumber: 1, episodeNumber: 3 });
    r.controller.showUpNext();
    await r.h.clock.advance(0);
    await r.h.clock.advance(0);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.upNext?.next?.contentId, "episode:s1e21");
    assert.equal(view.upNext?.next?.backdropUrl, undefined, "no backdrop, rather than an empty one");
    r.controller.destroy();
});

test("On Deck blurs an unwatched episode still and leaves series art and a started episode sharp", async () => {
    const spoilers = (): EpisodeSpoilerSettings => ({ hidesImages: true, hidesOverviews: false });
    const hidden = await autoplayRig(false, undefined, spoilers);
    hidden.catalog.episodeStills = true;
    const home = hidden.catalog.households.get("p-owner");
    const row = home?.sections.find(section => section.id === "continue_watching");
    assert.ok(row);
    row.items.unshift("episode:s2e11");
    await playMovie(hidden, EPISODE);
    hidden.controller.showUpNext();
    await hidden.h.clock.advance(0);
    const concealed = last(hidden.views);
    assert.ok(concealed.phase === "playing");
    const still = concealed.upNext?.deck.find(item => item.contentId === "episode:s2e11");
    assert.ok(still);
    assert.equal(still.hideBackdrop, true);
    assert.equal(still.backdropIsEpisodeStill, true);
    hidden.controller.destroy();

    const sharp = await autoplayRig(false, undefined, spoilers);
    const existing = sharp.catalog.titles.get("episode:s2e11");
    assert.ok(existing);
    sharp.catalog.add({ ...existing, backdrop: "/art/series.svg", backdropStill: false });
    const sharpHome = sharp.catalog.households.get("p-owner");
    sharpHome?.sections.find(section => section.id === "continue_watching")?.items.unshift("episode:s2e11");
    await playMovie(sharp, EPISODE);
    sharp.controller.showUpNext();
    await sharp.h.clock.advance(0);
    const clear = last(sharp.views);
    assert.ok(clear.phase === "playing");
    const art = clear.upNext?.deck.find(item => item.contentId === "episode:s2e11");
    assert.equal(art?.backdropIsEpisodeStill, false);
    assert.equal(art?.hideBackdrop, undefined);
    sharp.controller.destroy();

    const started = await autoplayRig(false, undefined, spoilers);
    started.catalog.episodeStills = true;
    started.catalog.progress.set("episode:s2e11", 30);
    started.catalog.households.get("p-owner")?.sections.find(section => section.id === "continue_watching")?.items.unshift("episode:s2e11");
    await playMovie(started, EPISODE);
    started.controller.showUpNext();
    await started.h.clock.advance(0);
    const playing = last(started.views);
    assert.ok(playing.phase === "playing");
    assert.equal(playing.upNext?.deck.find(item => item.contentId === "episode:s2e11")?.hideBackdrop, undefined);
    started.controller.destroy();
});

test("Play Now before EOF waits for progress and final stop at duration", async () => {
    const r = await autoplayRig(true);
    const id = await playMovie(r, EPISODE);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    r.avplay.tick((view.durationSeconds! - 20) * 1000);
    await r.h.clock.advance(0);
    const stop = r.h.fake.hold(`/playback/${id}`);
    r.controller.playNext();
    await r.h.clock.advance(0);
    assert.equal(bodies(r.h, "/start").length, 1);
    assert.equal(only(bodies(r.h, `/playback/${id}`)).position, view.durationSeconds);
    stop.release();
    await r.h.clock.advance(0);
    assert.equal(bodies(r.h, "/start").length, 2);
    r.controller.destroy();
});

test("pre-end progress keeps ten-second cadence and Back after EOF replays the last ten seconds", async () => {
    const r = await autoplayRig(false);
    const id = await playMovie(r, EPISODE);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    r.avplay.tick((view.durationSeconds! - 20) * 1000);
    await r.h.clock.advance(9999);
    assert.equal(bodies(r.h, "/progress").length, 0);
    await r.h.clock.advance(1);
    assert.equal(only(bodies(r.h, "/progress")).position, view.durationSeconds);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.equal(only(bodies(r.h, `/playback/${id}`)).position, view.durationSeconds);
    r.controller.keepWatching();
    await r.h.clock.advance(0);
    assert.equal(bodies(r.h, "/start")[1]?.start_position, view.durationSeconds! - 10);
    assert.equal(bodies(r.h, "/start")[1]?.file_id, EPISODE.fileId);
    r.controller.destroy();
});

test("Keep Watching after a lost EOF STOP answer replays the last ten seconds of the same file", async () => {
    const r = await autoplayRig(false);
    const id = await playMovie(r, EPISODE);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    r.h.fake.dropNextAnswer(`/playback/${id}`);
    r.avplay.listener?.onstreamcompleted();
    for (let step = 0; step < 6; step++) await r.h.clock.advance(0);
    assert.equal(completion(r).state, "ready");
    r.controller.keepWatching();
    await r.h.clock.advance(0);
    assert.equal(bodies(r.h, "/start").length, 2, "the end card does not just go Back");
    assert.equal(bodies(r.h, "/start")[1]?.start_position, view.durationSeconds! - 10);
    assert.equal(bodies(r.h, "/start")[1]?.file_id, EPISODE.fileId);
    r.controller.destroy();
});

test("movies retain up to twelve distinct On Deck cards and never autoplay another title", async () => {
    const r = await autoplayRig(true);
    const household = [...r.catalog.households.values()][0]!;
    household.sections = [{ id: "deck", sectionType: "continue_watching", title: "On Deck", items: Array.from({ length: 15 }, (_, index) => `movie:m${String(index + 1).padStart(4, "0")}`) }];
    r.catalog.fileIds.set("movie:m0001", "42");
    r.server.items.set("movie:m0001", ["42"]);
    await playMovie(r, { ...MOVIE, contentId: "movie:m0001" });
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(15000);
    const done = completion(r);
    assert.equal(done.status, "upNext.heading");
    assert.equal(done.deck?.length, 12);
    assert.equal(done.deck?.[0]?.contentId, "movie:m0002");
    assert.equal(done.countdown, undefined);
    assert.equal(bodies(r.h, "/start").length, 1);
    r.controller.destroy();
});

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

test("an exhausted series offers the first On Deck title and does not count down into it", async () => {
    const r = await autoplayRig(true);
    for (const id of ["episode:s1e13", "episode:s1e21", "episode:s1e22", "episode:s1e23"]) r.catalog.removed.add(id);
    r.catalog.progress.set("movie:m0001", 600);
    r.catalog.playbackWatched.add("movie:m0001");
    await playMovie(r, EPISODE);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(15000);
    const done = completion(r);
    assert.equal(done.status, "upNext.heading");
    assert.equal(done.next?.contentId, "movie:m0001");
    assert.equal(done.next?.fileId, "f-movie:m0001");
    assert.equal(done.next?.episode, undefined);
    assert.equal(done.next?.startSeconds, 600);
    assert.equal(done.countdown, undefined);
    assert.equal(bodies(r.h, "/start").length, 1, "On Deck waits for Play next");
    r.controller.playNext();
    await r.h.clock.advance(0);
    assert.equal(bodies(r.h, "/start")[1]?.file_id, "f-movie:m0001");
    r.controller.destroy();
});

test("autoplay stops at the series end and never starts after failed resolution", async () => {
    for (const mode of ["end", "failure"] as const) {
        const r = await autoplayRig(true);
        if (mode === "end") for (const id of ["episode:s1e13", "episode:s1e21", "episode:s1e22", "episode:s1e23"]) r.catalog.removed.add(id);
        await playMovie(r, EPISODE);
        if (mode === "failure") r.catalog.removed.add(EPISODE.contentId);
        r.avplay.listener?.onstreamcompleted();
        await r.h.clock.advance(15000);
        if (mode === "end") {
            // Old series end left `next` undefined. On Deck is offered and does not start.
            assert.equal(completion(r).next?.contentId, "movie:m0001");
            assert.equal(completion(r).status, "upNext.heading");
        } else {
            assert.equal(completion(r).next, undefined);
        }
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
        // A failed preference read keeps the server's default track, which is the track these tests save.
        r.h.fake.script("/watch/episode%3As1e12?file_id=42", { status: 500 });
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
    // A failed preference read keeps the server's default track, which is the track these tests save.
    r.h.fake.script("/watch/episode%3As1e12?file_id=42", { status: 500 });
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
    // A failed preference read keeps the server's default track, which is the track these tests save.
    r.h.fake.script("/watch/episode%3As1e12?file_id=42", { status: 500 });
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
    const watchBefore = watchReads(r); // the next-episode lookup now runs from the start, as on Apple TV
    listener?.onstreamcompleted();
    listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    r.controller.playNext();
    assert.equal(completion(r).state, "finalizing");
    // PlayerView.statusLabel: an ended episode still working out what follows reads Playing Next, as Apple's loading card does.
    assert.equal(completion(r).status, "upNext.headingEnded");
    assert.equal(completion(r).shuffle, undefined);
    assert.equal(bodies(r.h, "/start").length, 1);
    assert.equal(watchReads(r) - watchBefore, 0, "no fresh watch read before the final STOP is confirmed");
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
    assert.equal(completion(r).status, "upNext.headingEnded");
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

test("a lost EOF STOP answer lets the advance go on and resends the identical body and identity in the background", async () => {
    const r = await episodeRig();
    const id = await playMovie(r, EPISODE);
    r.h.fake.dropNextAnswer(`/playback/${id}`);
    r.avplay.tick(5399000);
    r.avplay.listener?.onstreamcompleted();
    for (let step = 0; step < 6; step++) await r.h.clock.advance(0);
    assert.equal(completion(r).state, "ready", "the advance does not wait for the lost STOP");
    assert.equal(bodies(r.h, `/playback/${id}`).length, 1, "the resend waits its first retry delay");
    await r.h.clock.advance(1000);
    const stops = bodies(r.h, `/playback/${id}`);
    assert.equal(stops.length, 2);
    assert.deepEqual(stops[0], stops[1]);
    assert.equal(stops[0]?.sequence, 1);
    assert.equal(stops[0]?.position, 5399);
    assert.equal(r.server.session(id).receipt?.stop_id, stops[0]?.stop_id, "the old session still ends, with the same STOP");
    r.controller.destroy();
});

test("a STOP that times out at EOF does not keep the known next episode from starting, as on Apple TV", async () => {
    // PlaybackSessionBridge.stopSession (silo-apple main 71a3beb9): a failed DELETE is logged and the next load goes on; the server
    // times the old session out. On 20 Nov the S95C instead waited out three 15 s STOP timeouts and showed the failure card (#709).
    const r = await autoplayRig(true);
    const id = await playMovie(r, EPISODE);
    r.h.fake.hold(`/playback/${id}`);
    r.avplay.tick(5399000);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.equal(completion(r).state, "finalizing");
    await r.h.clock.advance(15000);
    for (let step = 0; step < 6; step++) await r.h.clock.advance(0);
    assert.equal(completion(r).state, "ready", "one timed-out STOP, and the next episode is offered, not the failure card");
    assert.equal(completion(r).next?.contentId, "episode:s1e13");
    for (let step = 0; step < 20 && bodies(r.h, "/start").length < 2; step++) await r.h.clock.advance(1000);
    assert.equal(bodies(r.h, "/start").length, 2, "the countdown starts the next episode");
    const stops = bodies(r.h, `/playback/${id}`);
    assert.ok(stops.length >= 2 && stops.every(stop => JSON.stringify(stop) === JSON.stringify(stops[0])), "the identical STOP kept trying in the background, so the old session still ends");
    assert.equal(r.server.session(id).receipt?.stop_id, stops[0]?.stop_id, "and it did end");
    r.controller.destroy();
});

test("refusals at EOF STOP still end the advance: no successor starts without the session's authority", async () => {
    // A 401 refreshes the token and sends the STOP again, so it is not a refusal here; an expired session is its own test below.
    for (const refusal of [problem(403, "forbidden", "Forbidden"), problem(410, "gone", "Gone")]) {
        const r = await autoplayRig(true);
        const id = await playMovie(r, EPISODE);
        r.h.fake.script(`/playback/${id}`, refusal);
        r.avplay.tick(5399000);
        r.avplay.listener?.onstreamcompleted();
        for (let step = 0; step < 6; step++) await r.h.clock.advance(0);
        assert.equal(completion(r).state, "failed", `${refusal.status}: the card says the session could not end`);
        assert.equal(completion(r).failure, "session");
        await r.h.clock.advance(30000);
        assert.equal(bodies(r.h, "/start").length, 1, `${refusal.status}: nothing new starts`);
        r.controller.destroy();
    }
});

test("an EOF STOP refused with 503 lets the advance go on, and the background resend keeps the same body and honors Retry-After", async () => {
    const r = await episodeRig();
    const id = await playMovie(r, EPISODE);
    r.h.fake.script(`/playback/${id}`, { status: 503, headers: { "Retry-After": "4" }, body: {} });
    r.avplay.tick(111250);
    r.avplay.listener?.onstreamcompleted();
    for (let step = 0; step < 6; step++) await r.h.clock.advance(0);
    assert.equal(completion(r).state, "ready", "a STOP that may clear later does not end the advance");
    assert.equal(completion(r).failure, undefined);
    await r.h.clock.advance(3999);
    assert.equal(bodies(r.h, `/playback/${id}`).length, 1, "Retry-After holds the resend back");
    await r.h.clock.advance(1);
    const stops = bodies(r.h, `/playback/${id}`);
    assert.equal(stops.length, 2);
    assert.ok(stops.every(stop => JSON.stringify(stop) === JSON.stringify(stops[0])));
    assert.equal(stops[0]?.position, 111.25);
    assert.equal(r.server.session(id).receipt?.stop_id, stops[0]?.stop_id);
    r.controller.destroy();
});

test("Retry after a failed lookup sends no STOP of its own while the background resend runs, and a missing title stays retryable", async () => {
    const warnings = mock.method(console, "warn", () => undefined);
    try {
        const r = await episodeRig();
        const id = await playMovie(r, EPISODE);
        r.h.fake.dropNextAnswer(`/playback/${id}`);
        r.catalog.removed.add(EPISODE.contentId);
        r.avplay.listener?.onstreamcompleted();
        for (let step = 0; step < 6; step++) await r.h.clock.advance(0);
        assert.equal(completion(r).state, "failed");
        assert.equal(completion(r).failure, undefined, "the lookup failed, not the session");
        assert.equal(completion(r).retryable, true, "a 404 lookup is not a missing session while the STOP is still being resent");
        r.catalog.removed.delete(EPISODE.contentId);
        r.controller.retryCompletion();
        for (let step = 0; step < 6; step++) await r.h.clock.advance(0);
        assert.equal(completion(r).state, "ready");
        await r.h.clock.advance(10000);
        assert.equal(bodies(r.h, `/playback/${id}`).length, 2, "the first STOP and one background resend; Retry adds none");
        assert.equal(r.server.session(id).receipt?.stop_id, bodies(r.h, `/playback/${id}`)[0]?.stop_id);
    } finally { warnings.mock.restore(); }
});

test("an EOF STOP that keeps failing is sent three times in all, as before, and the last failure is logged", async () => {
    const warnings = mock.method(console, "warn", () => undefined);
    try {
        const r = await episodeRig();
        const id = await playMovie(r, EPISODE);
        const unavailable = { status: 503, body: {} };
        r.h.fake.script(`/playback/${id}`, unavailable, unavailable, unavailable, unavailable);
        r.avplay.listener?.onstreamcompleted();
        for (let step = 0; step < 6; step++) await r.h.clock.advance(0);
        assert.equal(completion(r).state, "ready");
        await r.h.clock.advance(1000);
        assert.equal(bodies(r.h, `/playback/${id}`).length, 2);
        await r.h.clock.advance(2000);
        assert.equal(bodies(r.h, `/playback/${id}`).length, 3);
        await r.h.clock.advance(30000);
        assert.equal(bodies(r.h, `/playback/${id}`).length, 3, "no fourth STOP");
        assert.equal(warnings.mock.callCount(), 1, "the failed background STOP is logged once, as PlaybackSessionBridge does");
        r.controller.destroy();
    } finally { warnings.mock.restore(); }
});

test("authority loss while the background STOP resend waits sends no old-scope resend", async () => {
    for (const action of ["profile", "account"]) {
        const r = await episodeRig();
        const id = await playMovie(r, EPISODE);
        r.h.fake.dropNextAnswer(`/playback/${id}`);
        r.avplay.listener?.onstreamcompleted();
        for (let step = 0; step < 6; step++) await r.h.clock.advance(0);
        assert.equal(bodies(r.h, `/playback/${id}`).length, 1);
        if (action === "profile") r.h.core.profiles.clear();
        else await r.h.core.session.logout();
        await r.h.clock.advance(10000);
        assert.equal(bodies(r.h, `/playback/${id}`).length, 1, `${action}: the resend never goes out`);
        assert.equal(bodies(r.h, "/start").length, 1, `${action}: nothing new starts`);
        r.controller.destroy();
    }
});

test("a background STOP resend refused with 403 before the next episode starts shows the failure card and cancels autoplay", async () => {
    const warnings = mock.method(console, "warn", () => undefined);
    try {
        const r = await autoplayRig(true);
        const id = await playMovie(r, EPISODE);
        r.h.fake.script(`/playback/${id}`, { status: 503, body: {} }, problem(403, "forbidden", "Forbidden"));
        // The next-episode lookup is still out when the resend is refused; its answer, a good one, lands afterwards.
        const watch = "/watch/" + encodeURIComponent(EPISODE.contentId);
        const lookup = r.h.fake.hold(watch, true);
        const watchReads = (): number => r.h.fake.requests.filter(request => request.path === watch).length;
        const before = watchReads();
        r.avplay.listener?.onstreamcompleted();
        for (let step = 0; step < 6; step++) await r.h.clock.advance(0);
        assert.equal(bodies(r.h, `/playback/${id}`).length, 1);
        assert.notEqual(completion(r).state, "failed", "the advance goes on after the 503");
        assert.equal(watchReads(), before + 1, "the lookup started after the 503");
        assert.equal(r.h.fake.heldReplies, 1, "and its answer is held while the resend waits");
        await r.h.clock.advance(1000);
        for (let step = 0; step < 6; step++) await r.h.clock.advance(0);
        assert.equal(bodies(r.h, `/playback/${id}`).length, 2);
        assert.equal(completion(r).state, "failed", "the refused resend ends the advance");
        lookup.release();
        for (let step = 0; step < 6; step++) await r.h.clock.advance(0);
        assert.equal(completion(r).state, "failed", "the late lookup answer does not offer the next episode");
        assert.equal(completion(r).failure, "session");
        assert.equal(completion(r).retryable, false);
        assert.equal(completion(r).next, undefined);
        await r.h.clock.advance(30000);
        assert.equal(bodies(r.h, "/start").length, 1, "autoplay never starts the next episode");
        r.controller.destroy();
    } finally { warnings.mock.restore(); }
});

test("Back on the end card after a refused STOP resend leaves without replaying the episode, as after a refused first STOP", async () => {
    // The card's Back button and the remote's Back key both call keepWatching (playerScreen.ts).
    for (const refusal of [problem(403, "forbidden", "Forbidden"), problem(410, "gone", "Gone")]) {
        const warnings = mock.method(console, "warn", () => undefined);
        try {
            const r = await autoplayRig(true);
            const id = await playMovie(r, EPISODE);
            r.h.fake.script(`/playback/${id}`, { status: 503, body: {} }, refusal);
            r.avplay.listener?.onstreamcompleted();
            for (let step = 0; step < 6; step++) await r.h.clock.advance(0);
            await r.h.clock.advance(1000);
            for (let step = 0; step < 6; step++) await r.h.clock.advance(0);
            assert.equal(completion(r).state, "failed", `${refusal.status}: the failure card shows`);
            r.controller.keepWatching();
            for (let step = 0; step < 6; step++) await r.h.clock.advance(0);
            assert.equal(bodies(r.h, "/start").length, 1, `${refusal.status}: Back starts no replay on the refused session`);
            assert.deepEqual(r.exits, ["back"], `${refusal.status}: Back leaves the player`);
            r.controller.destroy();
        } finally { warnings.mock.restore(); }
    }
});

test("a background STOP resend answered 404 after a 503 still lets the next episode start, as the first STOP likely landed", async () => {
    const warnings = mock.method(console, "warn", () => undefined);
    try {
        const r = await autoplayRig(true);
        const id = await playMovie(r, EPISODE);
        r.h.fake.script(`/playback/${id}`, { status: 503, body: {} }, problem(404, "not_found", "Not found"));
        r.avplay.tick(5399000);
        r.avplay.listener?.onstreamcompleted();
        for (let step = 0; step < 6; step++) await r.h.clock.advance(0);
        await r.h.clock.advance(1000);
        for (let step = 0; step < 6; step++) await r.h.clock.advance(0);
        assert.equal(bodies(r.h, `/playback/${id}`).length, 2);
        assert.equal(completion(r).state, "ready");
        for (let step = 0; step < 20 && bodies(r.h, "/start").length < 2; step++) await r.h.clock.advance(1000);
        assert.equal(bodies(r.h, "/start").length, 2, "the countdown starts the next episode");
        assert.equal(warnings.mock.callCount(), 1, "the 404 is logged");
        r.controller.destroy();
    } finally { warnings.mock.restore(); }
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
    const watchBefore = watchReads(r); // the next-episode lookup now runs from the start, as on Apple TV
    listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    r.controller.back();
    hold.release();
    listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.deepEqual(r.exits, ["back"]);
    assert.equal(watchReads(r), watchBefore, "the end of playback looks up no successor");
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
    // Old completion title was "Playback ended". A series successor reads Playing Next.
    assert.equal(completion(r).status, "upNext.headingEnded");
    assert.equal(r.catalog.playbackWatched.has(EPISODE.contentId), false);
    assert.equal(r.catalog.progress.has(EPISODE.contentId), false);
    r.controller.destroy();
});

test("the next episode waits for a pending Resolution cap read and starts the file that fits it", async () => {
    let quality: string | undefined;
    let landed: () => void = () => undefined;
    const pending = new Promise<void>(resolve => { landed = resolve; });
    const r = await episodeRig(undefined, { get quality() { return quality; }, ready: () => pending });
    r.catalog.episodeFiles.set("episode:s1e13", [{ file_id: "43", resolution: "2160p" }, { file_id: "44", resolution: "1080p" }]);
    r.catalog.watchOverrides.set("episode:s1e13", { versions: [{ file_id: "43", resolution: "2160p", duration_seconds: 5400 }, { file_id: "44", resolution: "1080p", duration_seconds: 5400 }], user_data: { played: false, last_file_id: "43" } });
    await playMovie(r, EPISODE);
    r.avplay.tick(5399000);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.equal(completion(r).state, "resolving", "no pick is made while the cap read is out");
    quality = "1080p";
    landed();
    await r.h.clock.advance(0);
    assert.equal(completion(r).state, "ready");
    assert.equal(completion(r).next?.fileId, "44", "the 1080p file fits the cap; the last-played 2160p file does not");
    r.controller.destroy();
});

const CAP_1080P: PlaybackDeps["resolutionCap"] = { quality: "1080p", ready: async () => undefined };

test("the Up Next prompt during playback offers the next episode file that fits the Resolution cap", async () => {
    const r = await episodeRig(undefined, CAP_1080P);
    r.catalog.episodeFiles.set("episode:s1e13", [{ file_id: "43", resolution: "2160p" }, { file_id: "44", resolution: "1080p" }]);
    r.catalog.watchOverrides.set("episode:s1e13", { versions: [{ file_id: "43", resolution: "2160p", duration_seconds: 5400 }, { file_id: "44", resolution: "1080p", duration_seconds: 5400 }] });
    await playMovie(r, EPISODE);
    r.controller.showUpNext();
    await r.h.clock.advance(0);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.upNext?.next?.contentId, "episode:s1e13");
    assert.equal(view.upNext?.next?.fileId, "44", "the 1080p file fits the cap; the last-played 2160p file does not");
    r.controller.destroy();
});

test("the On Deck cards during playback start the file that fits the Resolution cap", async () => {
    const r = await episodeRig(undefined, CAP_1080P);
    const household = [...r.catalog.households.values()][0]!;
    household.sections = [{ id: "deck", sectionType: "continue_watching", title: "On Deck", items: ["movie:m0002"] }];
    r.catalog.fileIds.set("movie:m0001", "42");
    r.catalog.fileIds.set("movie:m0002", "uhd");
    r.server.items.set("movie:m0001", ["42"]);
    r.catalog.watchOverrides.set("movie:m0002", { versions: [{ file_id: "uhd", resolution: "2160p", duration_seconds: 5400 }, { file_id: "hd", resolution: "1080p", duration_seconds: 5400 }] });
    await playMovie(r, { ...MOVIE, contentId: "movie:m0001" });
    r.controller.showUpNext();
    await r.h.clock.advance(0);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.upNext?.deck[0]?.contentId, "movie:m0002");
    assert.equal(view.upNext?.deck[0]?.fileId, "hd", "the 1080p file fits the cap; the last-played 2160p file does not");
    r.controller.destroy();
});

test("an expired pending progress answer at EOF offers Back without an impossible Retry", async () => {
    const r = await episodeRig();
    const id = await playMovie(r, EPISODE);
    const progress = r.h.fake.hold(`/playback/${id}/progress`);
    r.server.sessions.delete(id);
    await r.h.clock.advance(10000);
    const watchBefore = watchReads(r); // the next-episode lookup now runs from the start, as on Apple TV
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.equal(completion(r).state, "finalizing");
    progress.release();
    await r.h.clock.advance(0);
    assert.equal(completion(r).state, "failed");
    assert.equal(completion(r).failure, "session", "the final progress was refused before any lookup");
    assert.equal(completion(r).retryable, false);
    assert.equal(completion(r).next, undefined);
    r.controller.playNext();
    assert.equal(r.h.fake.requests.filter(request => request.method === "DELETE").length, 0);
    assert.equal(watchReads(r), watchBefore, "the end of playback looks up no successor");
    assert.equal(bodies(r.h, "/start").length, 1);
    r.controller.back();
    assert.deepEqual(r.exits, ["back"]);
    r.controller.destroy();
});

test("a missing session during EOF STOP offers Back without a retry that can never succeed", async () => {
    const r = await episodeRig();
    const id = await playMovie(r, EPISODE);
    r.server.sessions.delete(id);
    const watchBefore = watchReads(r); // the next-episode lookup now runs from the start, as on Apple TV
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
    assert.equal(watchReads(r), watchBefore, "the end of playback looks up no successor");
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
        const watchBefore = watchReads(r); // the next-episode lookup now runs from the start, as on Apple TV
        r.avplay.listener?.onstreamcompleted();
        await r.h.clock.advance(0);
        assert.equal(completion(r).state, "failed");
        r.controller.playNext();
        assert.equal(bodies(r.h, "/start").length, 1);
        assert.equal(watchReads(r), watchBefore, "the end of playback looks up no successor");
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

test("authority loss while the EOF STOP is out prevents old-scope resends and next starts", async () => {
    for (const action of ["profile", "account"]) {
        const r = await episodeRig();
        const id = await playMovie(r, EPISODE);
        // The authority goes while the STOP is out, so its answer arrives under no authority at all.
        const stop = r.h.fake.hold(`/playback/${id}`);
        const watchBefore = watchReads(r); // the next-episode lookup now runs from the start, as on Apple TV
        r.avplay.listener?.onstreamcompleted();
        await r.h.clock.advance(0);
        if (action === "profile") r.h.core.profiles.clear();
        else await r.h.core.session.logout();
        stop.release();
        await r.h.clock.advance(10000);
        r.controller.retryCompletion();
        r.controller.playNext();
        assert.equal(bodies(r.h, `/playback/${id}`).length, 1);
        assert.equal(bodies(r.h, "/start").length, 1);
        assert.equal(watchReads(r), watchBefore, "the end of playback looks up no successor");
        r.controller.destroy();
    }
});

test("a pending progress administrator refusal wins over a later EOF", async () => {
    const r = await episodeRig();
    const id = await playMovie(r, EPISODE);
    const hold = r.h.fake.hold(`/playback/${id}/progress`);
    r.server.endByAdmin(id);
    await r.h.clock.advance(10000);
    const watchBefore = watchReads(r); // the next-episode lookup now runs from the start, as on Apple TV
    r.avplay.listener?.onstreamcompleted();
    hold.release();
    await r.h.clock.advance(0);
    assert.equal(completion(r).state, "failed");
    assert.equal(completion(r).retryable, false);
    assert.equal(bodies(r.h, `/playback/${id}`).length, 0);
    assert.equal(watchReads(r), watchBefore, "the end of playback looks up no successor");
    r.controller.destroy();
});

test("revoked PIN proof during EOF finalization removes the old authority and cannot offer next", async () => {
    const r = await rig("p-kid");
    r.h.fake.catalog = new FakeCatalog();
    r.server.items.set(EPISODE.contentId, ["42"]);
    const id = await playMovie(r, EPISODE);
    r.h.fake.changePin("p-kid", "1357");
    const watchBefore = watchReads(r); // the next-episode lookup now runs from the start, as on Apple TV
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.deepEqual(r.exits, ["end:authority_changed"]);
    assert.equal(r.h.core.session.activeProfile, undefined);
    assert.equal(bodies(r.h, `/playback/${id}`).length, 1);
    assert.equal(watchReads(r), watchBefore, "the end of playback looks up no successor");
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

test("a scrub resume survives server re-anchoring and replacement preparation", async () => {
    const r = await rig();
    r.server.next.push({ timeline: { can_seek_anywhere: false } });
    await playMovie(r);
    r.controller.setPaused(true);
    r.controller.seekToSeconds(45);
    r.controller.setPaused(false);
    await r.h.clock.advance(0);
    r.avplay.finishPrepare();
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(last(r.views).phase, "playing");
    assert.equal(r.avplay.state, "PLAYING");
    r.controller.destroy();
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

const HDR = { hdr10: true, hdr10_plus: false, hlg: false, dolby_vision_profiles: [] };

function hdrPanel(result: boolean | "throw"): unknown {
    return { webapis: { avinfo: { isHdrTvSupport: () => { if (result === "throw") throw new Error("unavailable"); return result; } } } };
}

test("a supporting panel claims HDR10 on start and leaves HDR10+, HLG and Dolby Vision unclaimed", async () => {
    const r = await rig("p-owner", undefined, hdrPanel(true));
    const settings = new FakeSettings(r.h.fake);
    settings.hdrRows = true;
    settings.device("p-owner", r.h.core.session.http.deviceId).set(HDR_KEY, true);
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    const start = only(bodies(r.h, "/playback/start"));
    const capabilities = start.client_capabilities as { hdr: boolean; hdr_details: unknown };
    const context = start.client_playback_context as { output: unknown; deliveries: { original_http: { hdr_details?: unknown }; hls: { hdr_details?: unknown } } };
    assert.equal(capabilities.hdr, true);
    assert.deepEqual(capabilities.hdr_details, HDR);
    assert.deepEqual(context.output, { hdr_details: HDR });
    assert.deepEqual(context.deliveries.original_http.hdr_details, HDR);
    assert.deepEqual(context.deliveries.hls.hdr_details, HDR);
    assert.equal(r.h.fake.requests.some(request => request.path.includes("player.dolby_vision_enabled")), false);
    r.controller.destroy();
});

test("HDR off, a throwing probe, or a missing probe sends today's SDR profile", async () => {
    for (const mode of ["off", "throw", "missing"] as const) {
        const r = await rig("p-owner", undefined, mode === "missing" ? { webapis: {} } : hdrPanel(mode === "throw" ? "throw" : true));
        const settings = new FakeSettings(r.h.fake);
        settings.hdrRows = true;
        settings.device("p-owner", r.h.core.session.http.deviceId).set(HDR_KEY, mode !== "off");
        r.controller.play(MOVIE);
        await r.h.clock.advance(0);
        const start = only(bodies(r.h, "/playback/start"));
        assert.deepEqual(start.client_capabilities, clientCapabilities());
        assert.deepEqual(start.client_playback_context, playbackContext("QN55Q60AAFXZA", "0.1.0"));
        r.controller.destroy();
    }
});

test("an unreadable HDR setting sends today's SDR profile on an HDR panel", async () => {
    const r = await rig("p-owner", undefined, hdrPanel(true));
    const settings = new FakeSettings(r.h.fake);
    settings.hdrRows = true;
    settings.device("p-owner", r.h.core.session.http.deviceId).set(HDR_KEY, true);
    r.h.fake.script(operations.effectiveSettings([HDR_KEY]).path, problem(403, "forbidden", "Setting unavailable"));
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    const start = only(bodies(r.h, "/playback/start"));
    assert.deepEqual(start.client_capabilities, clientCapabilities());
    assert.deepEqual(start.client_playback_context, playbackContext("QN55Q60AAFXZA", "0.1.0"));
    r.controller.destroy();
});

test("an HDR panel claims HDR10 when the server offers no HDR setting", async () => {
    const r = await rig("p-owner", undefined, hdrPanel(true));
    new FakeSettings(r.h.fake);
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    const start = only(bodies(r.h, "/playback/start"));
    assert.deepEqual((start.client_capabilities as { hdr_details: unknown }).hdr_details, HDR);
    r.controller.destroy();
});

function hdrClaim(body: Record<string, unknown>): unknown {
    const capabilities = body.client_capabilities as { hdr?: unknown; hdr_details?: unknown } | undefined;
    const context = body.client_playback_context as {
        output?: { hdr_details?: unknown };
        deliveries?: { original_http?: { hdr_details?: unknown }; hls?: { hdr_details?: unknown } };
    } | undefined;
    return {
        hdr: capabilities?.hdr,
        capabilities: capabilities?.hdr_details,
        output: context?.output?.hdr_details,
        original_http: context?.deliveries?.original_http?.hdr_details,
        hls: context?.deliveries?.hls?.hdr_details,
    };
}

async function finishReplacement(r: Rig): Promise<void> {
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    if (r.avplay.calls.at(-1)?.startsWith("seekTo") === true) {
        r.avplay.finishSeek();
        await r.h.clock.advance(0);
    }
    assert.equal(r.avplay.state, "PLAYING");
}

test("a generic replan, a recovery replan and a replacement restart repeat the start HDR details", async () => {
    const r = await rig("p-owner", undefined, hdrPanel(true));
    const settings = new FakeSettings(r.h.fake);
    settings.hdrRows = true;
    settings.device("p-owner", r.h.core.session.http.deviceId).set(HDR_KEY, true);
    r.server.next.push({ availableQualities: [{ label: "original", preserves_source: true }, { label: "1080p-medium", height: 1080, bitrate_kbps: 6000, preserves_source: false }] });
    const id = await playMovie(r);
    const start = only(bodies(r.h, "/playback/start"));
    const claimed = hdrClaim(start);
    assert.deepEqual(claimed, { hdr: true, capabilities: HDR, output: HDR, original_http: HDR, hls: HDR });

    r.controller.selectQuality("1080p-medium");
    await r.h.clock.advance(0);
    await finishReplacement(r);

    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(1000);
    await finishReplacement(r);

    r.server.sessions.delete(id);
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(2000);
    const starts = bodies(r.h, "/playback/start");
    const replans = bodies(r.h, "/replan");
    assert.deepEqual(replans.map(body => body.operation), ["quality_change", "track_change", "track_change"]);
    assert.equal(starts.length, 2);
    for (const body of [...replans, starts[1]]) {
        assert.ok(body);
        assert.deepEqual(hdrClaim(body), claimed);
    }
    r.controller.destroy();
});

test("an empty language catalog still offers the Spoken language row when translation is off and the spoken language is unknown", async () => {
    const r = await rig();
    r.h.fake.script("/subtitles/ai/status", { status: 200, body: { state: "available", allowed: true, enabled: false, transcribe_enabled: true } });
    r.h.fake.script("/subtitles/ai/quota", ...Array.from({ length: 3 }, () => ({ status: 200, body: { limited: true, limit: 5, used: 3, remaining: 2, period: "month" } })));
    r.h.fake.script("/settings/contract", { status: 200, body: { option_sets: { playback_subtitle_languages: { options: [] } } } });
    r.h.fake.script("/subtitles/ai/translate", { status: 202, body: { job: { id: "opaque-job", media_file_id: "42", kind: "transcribe", source_index: 0, target_language: "", status: "running" } } });
    const file = r.server.files.get("42");
    assert.ok(file);
    r.server.files.set("42", { ...file, audio: file.audio.map((track, index) => index === 0 ? { ...track, language: "und" } : track) });
    await playMovie(r);
    await r.h.clock.advance(0);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.deepEqual(view.tracks.aiMenu?.menu.detected && [view.tracks.aiMenu.menu.detected.code, view.tracks.aiMenu.menu.detected.disabled], ["ai-detected-spoken-language", false]);
    assert.deepEqual(view.tracks.aiMenu?.menu.other, []);
    r.controller.startSubtitleAI("ai-detected-spoken-language");
    await r.h.clock.advance(0);
    assert.deepEqual(only(r.h.fake.requests.filter(request => request.path === "/subtitles/ai/translate")).body, { media_file_id: "42", kind: "transcribe", source_index: 0, source_language: "", target_language: "", start_position: 12.5 });
    r.controller.destroy();
});

test("a failed audio versions read still offers transcription of the plan's selected audio", async () => {
    const r = await rig();
    r.h.fake.script("/subtitles/ai/status", { status: 200, body: { state: "available", allowed: true, enabled: false, transcribe_enabled: true } });
    r.h.fake.script("/subtitles/ai/quota", ...Array.from({ length: 3 }, () => ({ status: 200, body: { limited: true, limit: 5, used: 3, remaining: 2, period: "month" } })));
    r.h.fake.script("/settings/contract", { status: 200, body: { option_sets: { playback_subtitle_languages: { options: [] } } } });
    r.h.fake.script("/catalog/items/movie-1/versions", ...Array.from({ length: 4 }, () => problem(500, "internal", "Internal")));
    r.h.fake.script("/subtitles/ai/translate", { status: 202, body: { job: { id: "opaque-job", media_file_id: "42", kind: "transcribe", source_index: 0, target_language: "", status: "running" } } });
    await playMovie(r);
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    assert.ok(r.h.fake.requests.some(request => request.path === "/catalog/items/movie-1/versions"), "the versions read was made and failed");
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.deepEqual(view.tracks.aiMenu?.menu.detected && [view.tracks.aiMenu.menu.detected.code, view.tracks.aiMenu.menu.detected.disabled], ["ai-detected-spoken-language", false], "the menu stays, with the spoken-language row");
    r.controller.startSubtitleAI("ai-detected-spoken-language");
    await r.h.clock.advance(0);
    assert.deepEqual(only(r.h.fake.requests.filter(request => request.path === "/subtitles/ai/translate")).body, { media_file_id: "42", kind: "transcribe", source_index: 0, source_language: "", target_language: "", start_position: 12.5 }, "the plan's selected audio is transcribed");
    r.controller.destroy();
});

test("while the audio versions read is still loading, the spoken language is not guessed, so no translation goes out in its place", async () => {
    const r = await rig();
    r.h.fake.script("/subtitles/ai/status", { status: 200, body: { state: "available", allowed: true, enabled: true, transcribe_enabled: true } });
    r.h.fake.script("/subtitles/ai/quota", ...Array.from({ length: 3 }, () => ({ status: 200, body: { limited: false, remaining: 0, period: "month" } })));
    r.h.fake.script("/settings/contract", { status: 200, body: { option_sets: { playback_subtitle_languages: { options: [{ value: "ja" }] } } } });
    r.h.fake.script("/subtitles/ai/translate", { status: 202, body: { job: { id: "opaque-job", media_file_id: "42", kind: "transcribe", source_index: 0, target_language: "", status: "running" } } });
    const file = r.server.files.get("42");
    assert.ok(file);
    // No text track to translate from, and the spoken audio is Japanese.
    r.server.files.set("42", { ...file, inventory: [], audio: file.audio.map((track, index) => index === 0 ? { ...track, language: "ja" } : track) });
    const versions = r.h.fake.hold("/catalog/items/movie-1/versions");
    await playMovie(r);
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    r.controller.startSubtitleAI("ja");
    await r.h.clock.advance(0);
    assert.equal(r.h.fake.requests.filter(request => request.path === "/subtitles/ai/translate").length, 0, "nothing goes out before the spoken language is known");
    versions.release();
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    r.controller.startSubtitleAI("ja");
    await r.h.clock.advance(0);
    assert.deepEqual(only(r.h.fake.requests.filter(request => request.path === "/subtitles/ai/translate")).body, { media_file_id: "42", kind: "transcribe", source_index: 0, source_language: "", target_language: "", start_position: 12.5 }, "once known, Japanese is transcribed, not transcribed and translated");
    r.controller.destroy();
});

test("Audio Retry while a transcription runs keeps the AI menu and its Cancel, and still starts nothing new", async () => {
    const r = await rig();
    r.h.fake.script("/subtitles/ai/status", { status: 200, body: { state: "available", allowed: true, enabled: false, transcribe_enabled: true } });
    r.h.fake.script("/subtitles/ai/quota", ...Array.from({ length: 3 }, () => ({ status: 200, body: { limited: true, limit: 5, used: 3, remaining: 2, period: "month" } })));
    r.h.fake.script("/settings/contract", { status: 200, body: { option_sets: { playback_subtitle_languages: { options: [] } } } });
    r.h.fake.script("/catalog/items/movie-1/versions", ...Array.from({ length: 4 }, () => problem(500, "internal", "Internal")));
    r.h.fake.script("/subtitles/ai/translate", { status: 202, body: { job: { id: "opaque-job", media_file_id: "42", kind: "transcribe", source_index: 0, target_language: "", status: "running" } } });
    r.h.fake.script("/subtitles/ai/jobs/opaque-job", ...Array.from({ length: 20 }, () => ({ status: 200, body: { job: { id: "opaque-job", media_file_id: "42", kind: "transcribe", source_index: 0, target_language: "", status: "running", progress: 0.3 } } })));
    const file = r.server.files.get("42");
    assert.ok(file);
    r.server.files.set("42", { ...file, inventory: [] });
    await playMovie(r);
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    r.controller.startSubtitleAI("ai-detected-spoken-language");
    await r.h.clock.advance(0);
    let view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.tracks.ai?.phase, "busy");
    r.h.fake.scripted.delete("/catalog/items/movie-1/versions");
    const reload = r.h.fake.hold("/catalog/items/movie-1/versions");
    r.controller.retryTrackInfo();
    await r.h.clock.advance(0);
    r.avplay.tick(13000);
    view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.tracks.audio.state, "loading");
    assert.notEqual(view.tracks.aiMenu, undefined, "the running job's menu, and its Cancel, stay while the audio list reloads");
    const creates = r.h.fake.requests.filter(request => request.path === "/subtitles/ai/translate").length;
    r.controller.subtitleAIAction("cancel");
    r.controller.startSubtitleAI("ai-detected-spoken-language");
    await r.h.clock.advance(0);
    assert.equal(r.h.fake.requests.filter(request => request.path === "/subtitles/ai/translate").length, creates, "no new request while the audio is unknown");
    reload.release();
    r.controller.destroy();
});

test("Audio Retry after a transcription fails keeps the failed panel and its Dismiss, and still starts nothing new", async () => {
    const r = await rig();
    r.h.fake.script("/subtitles/ai/status", { status: 200, body: { state: "available", allowed: true, enabled: false, transcribe_enabled: true } });
    r.h.fake.script("/subtitles/ai/quota", ...Array.from({ length: 3 }, () => ({ status: 200, body: { limited: true, limit: 5, used: 3, remaining: 2, period: "month" } })));
    r.h.fake.script("/settings/contract", { status: 200, body: { option_sets: { playback_subtitle_languages: { options: [] } } } });
    r.h.fake.script("/catalog/items/movie-1/versions", ...Array.from({ length: 4 }, () => problem(500, "internal", "Internal")));
    r.h.fake.script("/subtitles/ai/translate", { status: 202, body: { job: { id: "opaque-job", media_file_id: "42", kind: "transcribe", source_index: 0, target_language: "", status: "failed", error_message: "Provider could not decode the audio." } } });
    const file = r.server.files.get("42");
    assert.ok(file);
    r.server.files.set("42", { ...file, inventory: [] });
    await playMovie(r);
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    r.controller.startSubtitleAI("ai-detected-spoken-language");
    await r.h.clock.advance(0);
    let view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.tracks.ai?.phase, "failed");
    r.h.fake.scripted.delete("/catalog/items/movie-1/versions");
    const reload = r.h.fake.hold("/catalog/items/movie-1/versions");
    r.controller.retryTrackInfo();
    await r.h.clock.advance(0);
    r.avplay.tick(13000);
    view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.tracks.audio.state, "loading");
    assert.notEqual(view.tracks.aiMenu, undefined, "the failed job's panel, and its Dismiss, stay while the audio list reloads");
    assert.equal(view.tracks.ai?.message, "Provider could not decode the audio.", "with its reason");
    const creates = r.h.fake.requests.filter(request => request.path === "/subtitles/ai/translate").length;
    r.controller.startSubtitleAI("ai-detected-spoken-language");
    await r.h.clock.advance(0);
    assert.equal(r.h.fake.requests.filter(request => request.path === "/subtitles/ai/translate").length, creates, "no new request while the audio is unknown");
    r.controller.subtitleAIAction("dismiss");
    r.avplay.tick(13500);
    view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.tracks.ai?.phase, "idle", "Dismiss still acts on the job");
    reload.release();
    r.controller.destroy();
});

test("opening AI Subtitles after a failed quota read brings the balance back to the menu", async () => {
    const r = await rig();
    r.h.fake.script("/subtitles/ai/status", { status: 200, body: { state: "available", allowed: true, enabled: true, transcribe_enabled: true } });
    r.h.fake.script("/subtitles/ai/quota", problem(500, "internal", "Internal"), { status: 200, body: { limited: true, limit: 5, used: 1, remaining: 4, period: "month" } });
    r.h.fake.script("/settings/contract", { status: 200, body: { option_sets: { playback_subtitle_languages: { options: [{ value: "en" }, { value: "fr" }] } } } });
    await playMovie(r);
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    let view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.tracks.ai?.quota, undefined, "the first read failed");
    r.controller.subtitleAIAction("open");
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.tracks.ai?.quota?.remaining, 4, "the menu's open read the balance again");
    r.controller.destroy();
});

test("a quota with no used count shows what remains, not zero used", async () => {
    const r = await rig();
    r.h.fake.script("/subtitles/ai/status", { status: 200, body: { state: "available", allowed: true, enabled: false, transcribe_enabled: true } });
    r.h.fake.script("/subtitles/ai/quota", ...Array.from({ length: 3 }, () => ({ status: 200, body: { limited: true, limit: 5, remaining: 2, period: "month" } })));
    r.h.fake.script("/settings/contract", { status: 200, body: { option_sets: { playback_subtitle_languages: { options: [{ value: "en" }] } } } });
    await playMovie(r);
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.tracks.aiMenu?.quota, "2 remaining", "2 of 5 left, so never \"0 of 5 used\"");
    r.controller.destroy();
});

test("an empty language catalog with nothing else to offer shows no AI Subtitles… row", async () => {
    const r = await rig();
    r.h.fake.script("/subtitles/ai/status", { status: 200, body: { state: "available", allowed: true, enabled: true, transcribe_enabled: true } });
    r.h.fake.script("/subtitles/ai/quota", ...Array.from({ length: 3 }, () => ({ status: 200, body: { limited: false, remaining: 0, period: "month" } })));
    r.h.fake.script("/settings/contract", { status: 200, body: { option_sets: { playback_subtitle_languages: { options: [] } } } });
    await playMovie(r);
    await r.h.clock.advance(0);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.tracks.aiMenu, undefined, "no language row could run, so the row would open an empty menu");
    r.controller.destroy();
});

test("with the transcription quota unreadable, rows that rely on transcription are dimmed and the menu says why", async () => {
    const r = await rig();
    r.h.fake.script("/subtitles/ai/status", { status: 200, body: { state: "available", allowed: true, enabled: false, transcribe_enabled: true } });
    r.h.fake.script("/subtitles/ai/quota", ...Array.from({ length: 6 }, () => problem(500, "internal", "Internal")));
    r.h.fake.script("/settings/contract", { status: 200, body: { option_sets: { playback_subtitle_languages: { options: [{ value: "en" }, { value: "fr" }] } } } });
    await playMovie(r);
    await r.h.clock.advance(5000);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.deepEqual(view.tracks.aiMenu?.menu.suggested.concat(view.tracks.aiMenu.menu.other).map(row => [row.code, row.disabled]), [["en", true], ["fr", true]], "SubtitleAI refuses transcription without a known balance, so the rows say so");
    assert.equal(view.tracks.aiMenu?.quota, "Transcription quota unavailable.");
    assert.equal(view.tracks.aiMenu?.quotaExhausted, false, "not the used-up warning");
    r.controller.destroy();
});

const SYNC_KEY = "external-f903db1c5624c46c4a2c20f2fd8cd247fc0d46e6471c91d4ddb651ae4e039448";
const syncState = (extra: Record<string, unknown> = {}) => ({ key: SYNC_KEY, media_file_id: "42", source: "external", language: "eng", format: "srt", label: "Movie.srt", timing: { offset_ms: 0, scale: 1 }, ...extra });
const syncJob = (status: string, extra: Record<string, unknown> = {}) => ({ id: "job-1", status, trigger: "manual", confidence: null, created_at: "2026-11-17T01:00:00.000Z", finished_at: null, ...extra });
function scriptSync(r: Rig, listed: Record<string, unknown>): void {
    r.h.fake.script("/subtitles/sync/status", { status: 200, body: { revision: "r", state: "available", allowed: true, auto_sync: true, external: true } });
    r.h.fake.script("/subtitles/42/sync", { status: 200, body: { subtitles: [listed] } });
}
const syncArtifact = (r: Rig) => ({ url: `${r.h.fake.origin}/api/v2/captions?token=synthetic`, format: "vtt", timing_origin_seconds: 0 });

test("a syncable subtitle shows its sync status after its attributes and its timing rows when selected", async () => {
    const r = await rig();
    scriptSync(r, syncState({ timing: { offset_ms: -3000, scale: 1 }, sync: syncJob("synced", { result: { offset_ms: -3000, scale: 1 } }) }));
    r.server.next.push({ subtitle: 0, subtitleArtifact: syncArtifact(r) });
    r.h.fake.script("/captions?token=synthetic", { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nHello" });
    await playMovie(r);
    await r.h.clock.advance(0);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    const syncable = view.tracks.subtitles.find(track => track.id === "file:42:subtitle:0");
    assert.match(syncable?.detail ?? "", /^.* · Synced −3\.0 s$/);
    assert.doesNotMatch(view.tracks.subtitles.find(track => track.id === "file:42:subtitle:1")?.detail ?? "", /Sync/, "a track the server cannot retime has no status");
    assert.equal(view.tracks.syncTiming?.key, SYNC_KEY);
    assert.equal(view.tracks.syncTiming?.canReset, true);
    assert.equal(r.h.fake.requests.filter(request => request.path === "/subtitles/sync/status").length, 1);
    r.controller.selectSubtitle(undefined);
    r.controller.destroy();
});

test("a plan whose inventory names no sync key never asks the server about sync", async () => {
    const r = await rig();
    const file = r.server.files.get("42");
    assert.ok(file);
    r.server.files.set("42", { ...file, inventory: file.inventory.map(({ sync_key: _unused, ...track }) => track) });
    await playMovie(r);
    assert.equal(r.h.fake.requests.some(request => request.path.startsWith("/subtitles/sync") || /^\/subtitles\/\d+\/sync/.test(request.path)), false);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.tracks.syncTiming, undefined);
    r.controller.destroy();
});

test("Sync to Audio reads the new timing and fetches the shown track's cues again", async () => {
    const r = await rig();
    scriptSync(r, syncState());
    r.server.next.push({ subtitle: 0, subtitleArtifact: syncArtifact(r) });
    r.h.fake.script("/captions?token=synthetic", ...Array.from({ length: 2 }, () => ({ status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nOld timing" })), { status: 200, text: "WEBVTT\n\n00:09.000 --> 00:11.000\nNew timing" });
    r.h.fake.script(`/subtitles/42/sync/${SYNC_KEY}`,
        { status: 202, body: { subtitle: syncState({ sync: syncJob("pending", { phase: "queued", progress: 0 }) }) } },
        { status: 200, body: { subtitle: syncState({ timing: { offset_ms: -3000, scale: 1 }, sync: syncJob("synced", { result: { offset_ms: -3000, scale: 1 } }) }) } });
    await playMovie(r);
    await r.h.clock.advance(0);
    r.avplay.tick(12500);
    let view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.captions?.text, "Old timing");
    r.controller.syncSubtitle(SYNC_KEY);
    await r.h.clock.advance(0);
    view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.tracks.syncTiming?.inProgress, true);
    await r.h.clock.advance(3000);
    await r.h.clock.advance(0);
    assert.deepEqual(r.h.fake.requests.filter(request => request.path === "/captions?token=synthetic").map(request => request.cache), [undefined, "reload", "reload"], "once for the first listing, then again once the timing changed, past the HTTP cache");
    r.avplay.tick(10000);
    view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.captions?.text, "New timing");
    assert.equal(view.tracks.syncTiming?.inProgress, false);
    r.controller.destroy();
});

test("Reset Timing writes the identity behind the read's validator and reads the shown cues again", async () => {
    const r = await rig();
    scriptSync(r, syncState({ timing: { offset_ms: -3000, scale: 1 } }));
    r.server.next.push({ subtitle: 0, subtitleArtifact: syncArtifact(r) });
    r.h.fake.script("/captions?token=synthetic", ...Array.from({ length: 2 }, () => ({ status: 200, text: "WEBVTT\n\n00:09.000 --> 00:11.000\nSynced timing" })), { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nOriginal timing" });
    r.h.fake.script(`/subtitles/42/sync/${SYNC_KEY}`, { status: 200, headers: { ETag: "\"v3\"" }, body: { subtitle: syncState({ timing: { offset_ms: -3000, scale: 1 } }) } });
    r.h.fake.script(`/subtitles/42/sync/${SYNC_KEY}/timing`, { status: 200, body: { subtitle: syncState() } });
    await playMovie(r);
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    let view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.tracks.syncTiming?.canReset, true);
    r.controller.resetSubtitleTiming(SYNC_KEY);
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    const put = r.h.fake.requests.find(request => request.method === "PUT" && request.path === `/subtitles/42/sync/${SYNC_KEY}/timing`);
    assert.equal(put?.headers["if-match"], "\"v3\"");
    assert.deepEqual(put?.body, { offset_ms: 0, scale: 1 });
    r.avplay.tick(12500);
    view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.tracks.syncTiming?.canReset, false);
    assert.equal(view.captions?.text, "Original timing");
    assert.equal(r.h.fake.requests.filter(request => request.path === "/captions?token=synthetic").at(-1)?.cache, "reload");
    r.controller.destroy();
});

test("cues read before the first sync listing are read again whatever timing it shows, then only when it changes", async () => {
    // The plan names no timing, so the cues playback reads may predate the first listing: here they carry a retime another device then reset.
    const r = await rig();
    scriptSync(r, syncState());
    r.server.next.push({ subtitle: 0, subtitleArtifact: syncArtifact(r) });
    r.h.fake.script("/captions?token=synthetic", { status: 200, text: "WEBVTT\n\n00:09.000 --> 00:11.000\nRetimed" }, { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nOriginal" });
    const hold = r.h.fake.hold("/subtitles/sync/status");
    await playMovie(r);
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    hold.release();
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    const reads = (): (RequestCache | undefined)[] => r.h.fake.requests.filter(request => request.path === "/captions?token=synthetic").map(request => request.cache);
    assert.deepEqual(reads(), [undefined, "reload"], "the first listing, at the original timing, still rereads cues read before it");
    r.avplay.tick(12500);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.captions?.text, "Original");
    // Sync to Audio answers at once with the timing already in place: a newer answer, unchanged.
    r.h.fake.script(`/subtitles/42/sync/${SYNC_KEY}`, { status: 200, body: { subtitle: syncState({ sync: syncJob("already_synced", { result: { offset_ms: 0, scale: 1 } }) }) } });
    r.controller.syncSubtitle(SYNC_KEY);
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    assert.equal(r.h.fake.requests.filter(request => request.method === "POST" && request.path === `/subtitles/42/sync/${SYNC_KEY}`).length, 1, "the newer answer arrived");
    assert.deepEqual(reads(), [undefined, "reload"], "an unchanged timing reads nothing more");
    r.controller.destroy();
});

test("a timing reread keeps the shown cues until the new ones load, and a failed one keeps them and the secondary", async () => {
    const r = await secondaryRig();
    const file = r.server.files.get("42");
    assert.ok(file);
    // The primary (track 0) has the sync key; track 4 is the secondary.
    scriptSync(r, syncState());
    r.h.fake.scripted.delete("/captions?token=synthetic");
    r.h.fake.script("/captions?token=synthetic", { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nShown cues" }, { status: 500 }, { status: 500 }, { status: 500 });
    r.h.fake.script(SECONDARY_PATH, { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nSecondary line" });
    const statusHold = r.h.fake.hold("/subtitles/sync/status");
    await playMovie(r);
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    r.controller.selectSecondarySubtitle("file:42:subtitle:4");
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    const refresh = r.h.fake.hold("/captions?token=synthetic");
    statusHold.release();
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    r.avplay.tick(12500);
    let view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.captions?.text, "Shown cues", "the cues stay while the reread is on its way");
    refresh.release();
    for (let step = 0; step < 8; step++) await r.h.clock.advance(5000);
    r.avplay.tick(12600);
    view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.captions?.text, "Shown cues", "a failed reread keeps the cues on screen");
    assert.notEqual(view.captions?.status, "failed");
    assert.equal(view.tracks.secondary?.selectedId, "file:42:subtitle:4", "and the secondary stays chosen");
    assert.equal(view.captions?.secondaryText, "Secondary line");
    r.controller.destroy();
});

test("a timing reread that arrives in parts keeps the shown cues until the whole file is in", async () => {
    const r = await rig();
    scriptSync(r, syncState());
    r.server.next.push({ subtitle: 0, subtitleArtifact: syncArtifact(r) });
    r.h.fake.script("/captions?token=synthetic",
        { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nOld timing" },
        { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nNew first\n\n", cut: true },
        { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nNew first\n\n00:20.000 --> 00:22.000\nNew second" });
    const hold = r.h.fake.hold("/subtitles/sync/status");
    await playMovie(r);
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    hold.release();
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    r.avplay.tick(12500);
    let view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.captions?.text, "Old timing", "a part of the reread does not replace the shown cues");
    await r.h.clock.advance(2000);
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    assert.equal(r.h.fake.requests.filter(request => request.path === "/captions?token=synthetic").length, 3);
    r.avplay.tick(12600);
    view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.captions?.text, "New first", "the whole reread replaces them");
    r.controller.destroy();
});

test("a timing reread that fails before any cues loaded takes the normal failure path, not an endless Loading", async () => {
    const r = await rig();
    scriptSync(r, syncState());
    r.server.next.push({ subtitle: 0, subtitleArtifact: syncArtifact(r) });
    const first = r.h.fake.hold("/captions?token=synthetic");
    r.h.fake.script("/captions?token=synthetic", { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nNever shown" }, ...Array.from({ length: 4 }, () => ({ status: 500 })));
    await playMovie(r);
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    for (let step = 0; step < 8; step++) await r.h.clock.advance(5000);
    first.release();
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    assert.ok(r.h.fake.requests.filter(request => request.path === "/captions?token=synthetic" && request.cache === "reload").length >= 1, "the first listing started a reread while the first download was held");
    r.avplay.tick(12500);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.captions?.status, "failed", "the viewer is told the subtitle could not load");
    r.controller.destroy();
});

test("a secondary timing reread that fails before any cues loaded clears the secondary, as a first read that fails does", async () => {
    const r = await secondaryRig();
    const file = r.server.files.get("42");
    assert.ok(file);
    r.server.files.set("42", { ...file, inventory: file.inventory.map(({ sync_key: _unused, ...track }, index) => index === 4 ? { ...track, sync_key: SYNC_KEY } : track) });
    scriptSync(r, syncState());
    const statusHold = r.h.fake.hold("/subtitles/sync/status");
    await playMovie(r);
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    const first = r.h.fake.hold(SECONDARY_PATH);
    r.h.fake.script(SECONDARY_PATH, { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nNever shown" }, ...Array.from({ length: 4 }, () => ({ status: 500 })));
    r.controller.selectSecondarySubtitle("file:42:subtitle:4");
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    statusHold.release();
    for (let step = 0; step < 8; step++) await r.h.clock.advance(5000);
    first.release();
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    assert.ok(r.h.fake.requests.filter(request => request.path === SECONDARY_PATH && request.cache === "reload").length >= 1, "the first listing started a reread while the first download was held");
    r.avplay.tick(12500);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.tracks.secondary?.selectedId, undefined, "no secondary is left chosen with no line");
    assert.equal(view.captions?.secondaryText, "");
    r.controller.destroy();
});

test("a failed timing reread of the secondary keeps its line and its selection", async () => {
    const r = await secondaryRig();
    const file = r.server.files.get("42");
    assert.ok(file);
    r.server.files.set("42", { ...file, inventory: file.inventory.map(({ sync_key: _unused, ...track }, index) => index === 4 ? { ...track, sync_key: SYNC_KEY } : track) });
    scriptSync(r, syncState());
    r.h.fake.script(SECONDARY_PATH, { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nSecondary line" }, ...Array.from({ length: 4 }, () => ({ status: 500 })));
    r.h.fake.script(`/subtitles/42/sync/${SYNC_KEY}`,
        { status: 202, body: { subtitle: syncState({ sync: syncJob("pending", { phase: "queued", progress: 0 }) }) } },
        { status: 200, body: { subtitle: syncState({ timing: { offset_ms: -3000, scale: 1 }, sync: syncJob("synced", { result: { offset_ms: -3000, scale: 1 } }) }) } });
    await playMovie(r);
    await r.h.clock.advance(0);
    r.controller.selectSecondarySubtitle("file:42:subtitle:4");
    await r.h.clock.advance(0);
    r.controller.syncSubtitle(SYNC_KEY);
    await r.h.clock.advance(0);
    await r.h.clock.advance(3000);
    for (let step = 0; step < 8; step++) await r.h.clock.advance(5000);
    assert.ok(r.h.fake.requests.filter(request => request.path === SECONDARY_PATH).length >= 2, "the reread was tried");
    r.avplay.tick(12500);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.tracks.secondary?.selectedId, "file:42:subtitle:4");
    assert.equal(view.captions?.secondaryText, "Secondary line");
    r.controller.destroy();
});

test("leaving playback stops following a running sync job", async () => {
    const r = await rig();
    scriptSync(r, syncState({ sync: syncJob("running", { phase: "analyzing", progress: 0.4 }) }));
    r.h.fake.script(`/subtitles/42/sync/${SYNC_KEY}`, ...Array.from({ length: 50 }, () => ({ status: 200, body: { subtitle: syncState({ sync: syncJob("running", { phase: "analyzing", progress: 0.4 }) }) } })));
    await playMovie(r);
    await r.h.clock.advance(0);
    await r.h.clock.advance(3000);
    const polls = (): number => r.h.fake.requests.filter(request => request.method === "GET" && request.path === `/subtitles/42/sync/${SYNC_KEY}`).length;
    assert.equal(polls(), 1, "the job is followed while playing");
    r.controller.destroy();
    await r.h.clock.advance(30000);
    assert.equal(polls(), 1, "no sync read after playback ends");
});

test("a track retimed while it is not shown is read again when chosen, not served from cues kept in memory", async () => {
    // #701.1: the client keeps no cues for a track it is not drawing, and the server sends retimeable subtitles as private, no-cache with no
    // validator, so choosing the track again reads the new timing. This pins the client's half.
    const r = await secondaryRig();
    const file = r.server.files.get("42");
    assert.ok(file);
    r.server.files.set("42", { ...file, inventory: file.inventory.map(({ sync_key: _unused, ...track }, index) => index === 4 ? { ...track, sync_key: SYNC_KEY } : track) });
    scriptSync(r, syncState());
    r.h.fake.script(SECONDARY_PATH, { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nOld timing" }, { status: 200, text: "WEBVTT\n\n00:09.000 --> 00:11.000\nNew timing" });
    r.h.fake.script(`/subtitles/42/sync/${SYNC_KEY}`,
        { status: 202, body: { subtitle: syncState({ sync: syncJob("pending", { phase: "queued", progress: 0 }) }) } },
        { status: 200, body: { subtitle: syncState({ timing: { offset_ms: -3000, scale: 1 }, sync: syncJob("synced", { result: { offset_ms: -3000, scale: 1 } }) }) } });
    await playMovie(r);
    await r.h.clock.advance(0);
    r.controller.selectSecondarySubtitle("file:42:subtitle:4");
    await r.h.clock.advance(0);
    r.controller.syncSubtitle(SYNC_KEY);
    await r.h.clock.advance(0);
    r.controller.selectSecondarySubtitle(undefined);
    await r.h.clock.advance(3000);
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    const reads = (): number => r.h.fake.requests.filter(request => request.path === SECONDARY_PATH).length;
    assert.equal(reads(), 1, "the retime landed while the track was not shown, so nothing was reread then");
    r.controller.selectSecondarySubtitle("file:42:subtitle:4");
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    assert.equal(reads(), 2, "choosing it again reads it");
    r.avplay.tick(10000);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.captions?.secondaryText, "New timing");
    r.controller.destroy();
});

test("the fake's HTTP cache keeps abort, holds and the request log: an aborted GET rejects even with a cached answer", async () => {
    const r = await rig();
    r.h.fake.modelHttpCache = true;
    const path = "/cache-probe";
    const url = `${r.h.fake.origin}/api/v2${path}`;
    r.h.fake.script(path, { status: 200, headers: { "Cache-Control": "max-age=60" }, text: "cached" });
    assert.equal(await (await r.h.fake.fetch(url, {})).text(), "cached");
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(r.h.fake.fetch(url, { signal: aborted.signal }), (error: unknown) => error instanceof DOMException && error.name === "AbortError", "a cache hit still honours an aborted signal");
    const hold = r.h.fake.hold(path);
    let answered = false;
    const held = r.h.fake.fetch(url, {}).then(response => { answered = true; return response.text(); });
    await r.h.clock.advance(0);
    assert.equal(answered, false, "a hold delays a cache hit like any read");
    hold.release();
    assert.equal(await held, "cached", "and it is still the cached copy, with the scripted replies untouched");
    assert.equal(r.h.fake.requests.filter(request => request.path === path).length, 1, "only the first read reached the network");
    assert.deepEqual(r.h.fake.cacheHits.filter(request => request.path === path).map(request => request.method), ["GET", "GET"], "the aborted and the held reads were cache hits, logged apart");
    // Browser rules: a no-cache answer is stored but never reused unrevalidated, and with no validator it goes to the network; a
    // force-cache or only-if-cached read takes any stored copy, fresh or not; reload goes to the network and replaces the copy.
    const stale = "/cache-probe-no-cache";
    const staleUrl = `${r.h.fake.origin}/api/v2${stale}`;
    r.h.fake.script(stale, { status: 200, headers: { "Cache-Control": "private, no-cache" }, text: "first" }, { status: 200, headers: { "Cache-Control": "private, no-cache" }, text: "second" }, { status: 200, headers: { "Cache-Control": "private, no-cache" }, text: "third" });
    assert.equal(await (await r.h.fake.fetch(staleUrl, {})).text(), "first");
    assert.equal(await (await r.h.fake.fetch(staleUrl, {})).text(), "second", "default mode does not reuse a no-cache copy");
    assert.equal(await (await r.h.fake.fetch(staleUrl, { cache: "force-cache" })).text(), "second", "force-cache reads the stored copy, stale or not");
    assert.equal(await (await r.h.fake.fetch(staleUrl, { cache: "only-if-cached", mode: "same-origin" })).text(), "second", "so does only-if-cached");
    assert.equal(await (await r.h.fake.fetch(staleUrl, { cache: "reload" })).text(), "third", "reload goes to the network");
    assert.equal(await (await r.h.fake.fetch(staleUrl, { cache: "force-cache" })).text(), "third", "and replaces the stored copy");
    await assert.rejects(r.h.fake.fetch(`${r.h.fake.origin}/api/v2/cache-probe-empty`, { cache: "only-if-cached", mode: "same-origin" }), TypeError, "only-if-cached with nothing stored fails, as in a browser");
    r.controller.destroy();
});

test("a hidden track's retime is not served from a stale cached copy: the server's no-cache sends the reread to the network", async () => {
    // The fake keeps a browser-style HTTP cache here (its rules are pinned by the cache probe test above). The server sends retimeable
    // subtitles as private, no-cache with no validator (silo-server internal/api/handlers/stream.go): the old cues stay stored, so a
    // client that read from the cache (force-cache, only-if-cached) would show them; the default mode goes to the network.
    // The new timing's cue is at 9 to 11 s, the old one at 12 to 14 s: the line at each time says which copy is drawn.
    const retimeHidden = async (cacheControl: string): Promise<{ reads: number; at10: string | undefined; at12: string | undefined }> => {
        const r = await secondaryRig();
        r.h.fake.modelHttpCache = true;
        const file = r.server.files.get("42");
        assert.ok(file);
        r.server.files.set("42", { ...file, inventory: file.inventory.map(({ sync_key: _unused, ...track }, index) => index === 4 ? { ...track, sync_key: SYNC_KEY } : track) });
        scriptSync(r, syncState());
        const headers = { "Cache-Control": cacheControl };
        r.h.fake.script(SECONDARY_PATH, { status: 200, headers, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nOld timing" }, { status: 200, headers, text: "WEBVTT\n\n00:09.000 --> 00:11.000\nNew timing" });
        r.h.fake.script(`/subtitles/42/sync/${SYNC_KEY}`,
            { status: 202, body: { subtitle: syncState({ sync: syncJob("pending", { phase: "queued", progress: 0 }) }) } },
            { status: 200, body: { subtitle: syncState({ timing: { offset_ms: -3000, scale: 1 }, sync: syncJob("synced", { result: { offset_ms: -3000, scale: 1 } }) }) } });
        await playMovie(r);
        await r.h.clock.advance(0);
        r.controller.selectSecondarySubtitle("file:42:subtitle:4");
        await r.h.clock.advance(0);
        r.controller.syncSubtitle(SYNC_KEY);
        await r.h.clock.advance(0);
        r.controller.selectSecondarySubtitle(undefined);
        await r.h.clock.advance(3000);
        for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
        r.controller.selectSecondarySubtitle("file:42:subtitle:4");
        for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
        const lineAt = (ms: number): string | undefined => {
            r.avplay.tick(ms);
            const view = last(r.views);
            return view.phase === "playing" ? view.captions?.secondaryText : undefined;
        };
        const result = { reads: r.h.fake.requests.filter(request => request.path === SECONDARY_PATH).length, at10: lineAt(10000), at12: lineAt(12500) };
        r.controller.destroy();
        return result;
    };
    assert.deepEqual(await retimeHidden("private, no-cache"), { reads: 2, at10: "New timing", at12: "" }, "the reread reaches the network past the stored old cues and shows the new timing");
});

test("Sync to Audio on a track shown as Secondary reads that track's cues again", async () => {
    const r = await secondaryRig();
    const file = r.server.files.get("42");
    assert.ok(file);
    r.server.files.set("42", { ...file, inventory: file.inventory.map(({ sync_key: _unused, ...track }, index) => index === 4 ? { ...track, sync_key: SYNC_KEY } : track) });
    scriptSync(r, syncState());
    r.h.fake.script(SECONDARY_PATH, { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nOld timing" }, { status: 200, text: "WEBVTT\n\n00:09.000 --> 00:11.000\nNew timing" });
    r.h.fake.script(`/subtitles/42/sync/${SYNC_KEY}`,
        { status: 202, body: { subtitle: syncState({ sync: syncJob("pending", { phase: "queued", progress: 0 }) }) } },
        { status: 200, body: { subtitle: syncState({ timing: { offset_ms: -3000, scale: 1 }, sync: syncJob("synced", { result: { offset_ms: -3000, scale: 1 } }) }) } });
    await playMovie(r);
    await r.h.clock.advance(0);
    r.controller.selectSecondarySubtitle("file:42:subtitle:4");
    await r.h.clock.advance(0);
    r.avplay.tick(12500);
    let view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.captions?.secondaryText, "Old timing");
    r.controller.syncSubtitle(SYNC_KEY);
    await r.h.clock.advance(0);
    await r.h.clock.advance(3000);
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    const reads = r.h.fake.requests.filter(request => request.path === SECONDARY_PATH);
    assert.equal(reads.length, 2, "the secondary track is read again once its timing changed");
    assert.deepEqual(reads.map(request => request.cache), [undefined, "reload"], "the second read skips the HTTP cache");
    assert.equal(r.h.fake.requests.filter(request => request.path === "/captions?token=synthetic").length, 1, "the primary, not retimed, is not read again");
    r.avplay.tick(10000);
    view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.captions?.secondaryText, "New timing");
    assert.equal(view.tracks.secondary?.selectedId, "file:42:subtitle:4");
    r.controller.destroy();
});

// SECONDARY (silo-apple main, TVPlayerInfoHUD SubtitlesPane): a second text track under the primary, where the app draws subtitles itself.
const SECONDARY_PATH = "/stream/11111111-1111-4111-8111-111111111111/subtitles/4.vtt?file_id=42&token=synthetic";
async function secondaryRig(): Promise<Rig> {
    const r = await rig();
    const file = r.server.files.get("42");
    assert.ok(file);
    r.server.files.set("42", { ...file, inventory: file.inventory.map((track, index) => index === 4 ? { ...track, url: `${String(track.url)}&token=synthetic` } : track) });
    r.server.next.push({ subtitle: 0, subtitleArtifact: { url: `${r.h.fake.origin}/api/v2/captions?token=synthetic`, format: "vtt", timing_origin_seconds: 0 } });
    r.h.fake.script("/captions?token=synthetic", { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nPrimary line" });
    return r;
}

test("Secondary lists the file's other text sidecars while an app-drawn subtitle is shown, the primary dimmed", async () => {
    const r = await secondaryRig();
    await playMovie(r);
    await r.h.clock.advance(0);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.tracks.selectedSubtitleId, "file:42:subtitle:0");
    assert.deepEqual(view.tracks.secondary?.choices.map(choice => [choice.id, choice.unavailable === true]), [["file:42:subtitle:0", true], ["file:42:subtitle:1", false], ["file:42:subtitle:4", false]], "bitmap and burn-in-only rows are not offered");
    assert.equal(view.tracks.secondary?.selectedId, undefined);
    r.controller.destroy();
});

test("Secondary reads the chosen sidecar, draws it under the primary and clears on Off", async () => {
    const r = await secondaryRig();
    r.h.fake.script(SECONDARY_PATH, { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nSecondary line" });
    await playMovie(r);
    await r.h.clock.advance(0);
    r.controller.selectSecondarySubtitle("file:42:subtitle:4");
    await r.h.clock.advance(0);
    r.avplay.tick(12500);
    let view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.captions?.text, "Primary line");
    assert.equal(view.captions?.secondaryText, "Secondary line");
    assert.equal(view.tracks.secondary?.selectedId, "file:42:subtitle:4");
    r.controller.selectSecondarySubtitle(undefined);
    r.avplay.tick(12600);
    view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.captions?.secondaryText, "");
    assert.equal(view.tracks.secondary?.selectedId, undefined);
    r.controller.destroy();
});

test("a secondary sidecar that ends early keeps its cues on screen and is refetched after 2 s, as the primary's is", async () => {
    const r = await secondaryRig();
    r.h.fake.script(SECONDARY_PATH, { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nFirst\n\n", cut: true });
    r.h.fake.script(SECONDARY_PATH, { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nFirst\n\n00:20.000 --> 00:22.000\nSecond" });
    await playMovie(r);
    await r.h.clock.advance(0);
    r.controller.selectSecondarySubtitle("file:42:subtitle:4");
    await r.h.clock.advance(0);
    r.avplay.tick(12500);
    let view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.captions?.secondaryText, "First", "the cues that arrived show while the file is fetched again");
    assert.equal(view.tracks.secondary?.selectedId, "file:42:subtitle:4", "the track stays chosen");
    assert.equal(r.h.fake.requests.filter(request => request.path.startsWith("/stream/") && request.path.includes("/subtitles/4.vtt")).length, 1);
    await r.h.clock.advance(2000);
    r.avplay.tick(21000);
    view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.captions?.secondaryText, "Second");
    assert.equal(r.h.fake.requests.filter(request => request.path.startsWith("/stream/") && request.path.includes("/subtitles/4.vtt")).length, 2);
    r.controller.destroy();
});

test("Secondary refuses the primary's own track and a track the app cannot draw", async () => {
    const r = await secondaryRig();
    await playMovie(r);
    await r.h.clock.advance(0);
    const reads = r.h.fake.requests.length;
    for (const id of ["file:42:subtitle:0", "file:42:subtitle:2", "file:42:subtitle:3", "file:42:subtitle:99"]) r.controller.selectSecondarySubtitle(id);
    await r.h.clock.advance(0);
    assert.equal(r.h.fake.requests.length, reads);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.tracks.secondary?.selectedId, undefined);
    r.controller.destroy();
});

test("turning the primary off, or choosing it as secondary's track, drops the secondary", async () => {
    const r = await secondaryRig();
    r.h.fake.script(SECONDARY_PATH, { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nSecondary line" });
    await playMovie(r);
    await r.h.clock.advance(0);
    r.controller.selectSecondarySubtitle("file:42:subtitle:4");
    await r.h.clock.advance(0);
    r.controller.selectSubtitle(undefined);
    for (let step = 0; step < 5; step++) await r.h.clock.advance(0);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.tracks.secondary, undefined, "no list without a primary");
    r.controller.destroy();
});

test("no Secondary list shows when the shown subtitle is not drawn by the app", async () => {
    const r = await rig();
    await playMovie(r);
    await r.h.clock.advance(0);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.tracks.secondary, undefined);
    r.controller.destroy();
});

test("a replan that moves the primary's timing origin reads the secondary track again at the new origin", async () => {
    const r = await secondaryRig();
    const artifact = (origin: number) => ({ url: `${r.h.fake.origin}/api/v2/captions?token=synthetic`, format: "vtt", timing_origin_seconds: origin });
    r.server.next.length = 0;
    r.server.next.push({ subtitle: 0, subtitleArtifact: artifact(0) }, { subtitle: 0, subtitleArtifact: artifact(5) });
    r.h.fake.script("/captions?token=synthetic", { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nPrimary line" }, { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nPrimary line" });
    r.h.fake.script(SECONDARY_PATH, { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nSecondary line" }, { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nSecondary line" });
    await playMovie(r);
    await r.h.clock.advance(0);
    r.controller.selectSecondarySubtitle("file:42:subtitle:4");
    await r.h.clock.advance(0);
    r.controller.selectAudio("file:42:audio:1");
    await r.h.clock.advance(0);
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    if (r.avplay.calls[r.avplay.calls.length - 1]?.startsWith("seekTo") === true) r.avplay.finishSeek();
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    assert.equal(r.h.fake.requests.filter(request => request.path === SECONDARY_PATH).length, 2, "read again for the new origin");
    r.avplay.tick(17500);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.captions?.secondaryText, "Secondary line", "placed 5 s later, with the primary");
    r.controller.destroy();
});

test("a primary subtitle load that fails takes the chosen secondary with it, so no caption is left without its control", async () => {
    const r = await secondaryRig();
    r.h.fake.scripted.delete("/captions?token=synthetic");
    const hold = r.h.fake.hold("/captions?token=synthetic");
    r.h.fake.script("/captions?token=synthetic", { status: 404 });
    r.h.fake.script(SECONDARY_PATH, { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nSecondary line" });
    await playMovie(r);
    r.controller.selectSecondarySubtitle("file:42:subtitle:4");
    await r.h.clock.advance(0);
    hold.release();
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    r.avplay.tick(12500);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.captions?.status, "failed");
    assert.equal(view.tracks.secondary, undefined, "no list without a drawn primary");
    assert.equal(view.captions?.secondaryText, "", "and no second line drawn without its control");
    r.controller.destroy();
});

test("a replan that gives the secondary track a new session URL reads it again from that URL", async () => {
    const r = await secondaryRig();
    const artifact = { url: `${r.h.fake.origin}/api/v2/captions?token=synthetic`, format: "vtt", timing_origin_seconds: 0 };
    r.server.next.length = 0;
    r.server.next.push({ subtitle: 0, subtitleArtifact: artifact }, { subtitle: 0, subtitleArtifact: artifact });
    r.h.fake.script("/captions?token=synthetic", { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nPrimary line" });
    r.h.fake.script(SECONDARY_PATH, { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nOld session" });
    const moved = SECONDARY_PATH.replace("token=synthetic", "token=synthetic2");
    r.h.fake.script(moved, { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nNew session" });
    await playMovie(r);
    await r.h.clock.advance(0);
    r.controller.selectSecondarySubtitle("file:42:subtitle:4");
    await r.h.clock.advance(0);
    const file = r.server.files.get("42");
    assert.ok(file);
    r.server.files.set("42", { ...file, inventory: file.inventory.map((track, index) => index === 4 ? { ...track, url: String(track.url).replace("token=synthetic", "token=synthetic2") } : track) });
    r.controller.selectAudio("file:42:audio:1");
    await r.h.clock.advance(0);
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    if (r.avplay.calls[r.avplay.calls.length - 1]?.startsWith("seekTo") === true) r.avplay.finishSeek();
    for (let step = 0; step < 4; step++) await r.h.clock.advance(0);
    assert.equal(r.h.fake.requests.filter(request => request.path === moved).length, 1, "read from the new session's URL");
    r.avplay.tick(12500);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.equal(view.captions?.secondaryText, "New session");
    r.controller.destroy();
});

test("an inventory URL that cannot be parsed is not offered as a secondary track and never breaks playback updates", async () => {
    const r = await secondaryRig();
    const file = r.server.files.get("42");
    assert.ok(file);
    r.server.files.set("42", { ...file, inventory: file.inventory.map((track, index) => index === 4 ? { ...track, url: "http://[bad" } : track) });
    await playMovie(r);
    await r.h.clock.advance(0);
    const view = last(r.views);
    assert.ok(view.phase === "playing");
    assert.deepEqual(view.tracks.secondary?.choices.map(choice => choice.id), ["file:42:subtitle:0", "file:42:subtitle:1"]);
    r.controller.destroy();
});

test("the HUD's Now playing and Stats rows name the plan's audio track and follow pause", async () => {
    const r = await rig();
    await playMovie(r);
    const stats = (): NonNullable<Extract<PlaybackView, { phase: "playing" | "paused" }>["hud"]>["stats"] => {
        const view = last(r.views);
        assert.ok((view.phase === "playing" || view.phase === "paused") && view.hud !== undefined);
        return view.hud.stats;
    };
    // Info names the fake's file 42 track (English, EAC3, six channels); Stats gives the format the plan's recipe delivers (AAC stereo).
    assert.equal(stats().nowPlaying.find(row => row.label === "Audio")?.value, "English · EAC3 5.1");
    assert.equal(stats().playback.find(row => row.label === "Audio")?.value, "English · AAC Stereo");
    assert.deepEqual(stats().stream, [{ label: "Playback status", value: "Playing" }]);
    assert.equal(stats().engine.find(row => row.label === "Source")?.value !== undefined, true);
    r.controller.setPaused(true);
    await r.h.clock.advance(0);
    assert.deepEqual(stats().stream, [{ label: "Playback status", value: "Paused" }]);
    r.controller.destroy();
});

// --- HLS playlists AVPlay cannot read (#650): the check runs before the blocking open and prepare ---

const DEFINE_PLAYLIST = [
    "#EXTM3U",
    "#EXT-X-VERSION:8",
    '#EXT-X-DEFINE:NAME="silo_query",VALUE="st=abc&token=xyz"',
    "#EXT-X-TARGETDURATION:2",
    "#EXTINF:2.000,",
    "segment/seg_0.ts?{$silo_query}",
    "#EXT-X-ENDLIST",
].join("\n");

const PLAIN_PLAYLIST = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:2",
    "#EXTINF:2.000,",
    "segment/seg_0.ts?st=abc",
    "#EXT-X-ENDLIST",
].join("\n");

const PLAYLIST_REPLY = (text: string) => ({ status: 200, text, headers: { "Content-Type": "application/vnd.apple.mpegurl" } });

function opens(r: Rig): string[] {
    return r.avplay.calls.filter(call => call.startsWith("open "));
}

async function playHls(r: Rig, delivery = "server_transcode_hls"): Promise<void> {
    r.server.next.push({ delivery, protocol: "hls", container: "mpegts", url: (id: string) => `/api/v2/stream/${id}?st=signed` });
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
}

test("an HLS playlist that needs variable substitution is refused before AVPlay opens it (#650)", async () => {
    const warnings = mock.method(console, "warn", () => undefined);
    try {
        const r = await rig();
        r.h.fake.streamPlaylist = PLAYLIST_REPLY(DEFINE_PLAYLIST);
        await playHls(r);
        assert.deepEqual(opens(r), [], "AVPlay is never given the stream");
        assert.deepEqual(r.avplay.calls.filter(call => call !== "close"), [], "nothing reaches AVPlay but the cleanup close");
        const view = last(r.views);
        assert.equal(view.phase === "error" && view.error.kind, "playback_failed");
        assert.equal(ops(r.h).at(-1), "DELETE /playback/S1", "the session is stopped");
        assert.deepEqual(warnings.mock.calls.map(call => call.arguments), [["Auger playback: the HLS playlist uses #EXT-X-DEFINE, which AVPlay cannot read (delivery server_transcode_hls)"]]);
        assert.equal(r.h.clock.scheduled, 0);
        r.controller.dismissError();
        assert.deepEqual(r.exits, ["error:playback_failed"]);
        r.controller.destroy();
    } finally {
        warnings.mock.restore();
    }
});

test("a segment address that still holds a variable is refused even without the define line (#650)", async () => {
    const r = await rig();
    r.h.fake.streamPlaylist = PLAYLIST_REPLY(PLAIN_PLAYLIST.replace("st=abc", "{$silo_query}"));
    await playHls(r, "server_remux_hls");
    assert.deepEqual(opens(r), []);
    const view = last(r.views);
    assert.equal(view.phase === "error" && view.error.kind, "playback_failed");
    r.controller.destroy();
});

test("an HLS playlist AVPlay can read is opened as before, with the same address the check read (#650)", async () => {
    const r = await rig();
    r.h.fake.streamPlaylist = PLAYLIST_REPLY(PLAIN_PLAYLIST);
    await playHls(r);
    const read = r.h.fake.requests.find(request => request.path.startsWith("/stream/"));
    assert.ok(read !== undefined);
    assert.equal(read.redirect, "error");
    assert.equal(read.headers.authorization, undefined, "the media token is in the address, as AVPlay would send it");
    assert.match(read.path, /\?st=signed&token=/);
    assert.equal(opens(r).length, 1);
    assert.equal(opens(r)[0], `open ${r.h.fake.origin}/api/v2${read.path}`);
    r.controller.destroy();
});

for (const [name, reply] of [["answers 404", { status: 404, text: "" }], ["answers 503", { status: 503, text: "" }]] as const) test(`a playlist the check cannot read (${name}) is left to AVPlay (#650)`, async () => {
    const r = await rig();
    r.h.fake.streamPlaylist = reply;
    await playHls(r);
    assert.equal(opens(r).length, 1);
    r.controller.destroy();
});

test("a playlist that never answers is left to AVPlay after five seconds (#650)", async () => {
    const r = await rig();
    r.h.fake.streamPlaylist = PLAYLIST_REPLY(DEFINE_PLAYLIST);
    r.h.fake.hold("/stream/5e550001-0000-4000-8000-000000000000");
    await playHls(r);
    assert.deepEqual(opens(r), []);
    await r.h.clock.advance(4999);
    assert.deepEqual(opens(r), []);
    await r.h.clock.advance(1);
    assert.equal(opens(r).length, 1);
    r.controller.destroy();
});

test("direct play reads no playlist (#650)", async () => {
    const r = await rig();
    r.h.fake.streamPlaylist = PLAYLIST_REPLY(DEFINE_PLAYLIST);
    await playMovie(r);
    assert.deepEqual(r.h.fake.requests.filter(request => request.path.startsWith("/stream/")), []);
    assert.equal(opens(r).length, 1);
    r.controller.destroy();
});

test("leaving while the playlist is being read opens nothing (#650)", async () => {
    const r = await rig();
    r.h.fake.streamPlaylist = PLAYLIST_REPLY(PLAIN_PLAYLIST);
    const held = r.h.fake.hold("/stream/5e550001-0000-4000-8000-000000000000", true);
    await playHls(r);
    r.controller.back();
    held.release();
    await r.h.clock.advance(0);
    assert.deepEqual(opens(r), []);
    r.controller.destroy();
});

// The real shape (S95C, 20 Nov): a version 3 master with no define, 31 subtitle renditions, and a version 8 video variant with the define on line 3.
const MASTER_PATH = (id: string): string => `/api/v2/stream/${id}/master.m3u8?st=signed`;
const VARIANT_URI = "master.m3u8?silo_rendition=video&st=signed";

function masterPlaylist(): string {
    const subtitles = Array.from({ length: 31 }, (_, index) => `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Track ${index}",LANGUAGE="en",URI="master.m3u8?silo_rendition=subtitles&silo_track=${index}&st=signed"`);
    return ["#EXTM3U", "#EXT-X-VERSION:3", ...subtitles, '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x800,SUBTITLES="subs"', VARIANT_URI].join("\n");
}

function streams(variant: string, master = masterPlaylist()): (path: string) => { status: number; text: string } {
    return path => path.includes("silo_rendition=video") ? { status: 200, text: variant } : path.includes("silo_rendition=") ? { status: 200, text: "#EXTM3U\n#EXT-X-VERSION:3\n" } : { status: 200, text: master };
}

async function playMaster(r: Rig): Promise<void> {
    r.server.next.push({ delivery: "server_transcode_hls", protocol: "hls", container: "mpegts", url: MASTER_PATH });
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
}

function streamReads(r: Rig): string[] {
    return r.h.fake.requests.filter(request => request.path.startsWith("/stream/")).map(request => request.path.replace(/&token=.*$/, ""));
}

test("a define that is only in the video variant is refused, reading the master and that one variant (#650)", async () => {
    const warnings = mock.method(console, "warn", () => undefined);
    try {
        const r = await rig();
        r.h.fake.streamPlaylist = streams(DEFINE_PLAYLIST);
        await playMaster(r);
        assert.deepEqual(opens(r), []);
        const view = last(r.views);
        assert.equal(view.phase === "error" && view.error.kind, "playback_failed");
        const id = sessionIds(r.server)[0] ?? "";
        assert.deepEqual(streamReads(r), [`/stream/${id}/master.m3u8?st=signed`, `/stream/${id}/master.m3u8?silo_rendition=video&st=signed`], "the master, then its first video variant; no subtitle rendition");
        assert.equal(warnings.mock.calls.length, 1);
        assert.equal(r.h.clock.scheduled, 0);
        r.controller.destroy();
    } finally {
        warnings.mock.restore();
    }
});

test("a master whose video variant is plain is opened after those two reads (#650)", async () => {
    const r = await rig();
    r.h.fake.streamPlaylist = streams(PLAIN_PLAYLIST);
    await playMaster(r);
    assert.equal(streamReads(r).length, 2);
    assert.equal(opens(r).length, 1);
    r.controller.destroy();
});

test("a variant the check cannot read is left to AVPlay (#650)", async () => {
    const r = await rig();
    r.h.fake.streamPlaylist = path => path.includes("silo_rendition=video") ? { status: 404, text: "" } : { status: 200, text: masterPlaylist() };
    await playMaster(r);
    assert.equal(opens(r).length, 1);
    r.controller.destroy();
});

test("a variant on another origin is not read (#650)", async () => {
    const r = await rig();
    r.h.fake.streamPlaylist = { status: 200, text: masterPlaylist().replace(VARIANT_URI, "http://other.example.test/video.m3u8") };
    await playMaster(r);
    assert.equal(streamReads(r).length, 1);
    assert.equal(opens(r).length, 1);
    r.controller.destroy();
});

test("the master and the variant share one five-second budget (#650)", async () => {
    const r = await rig();
    r.h.fake.streamPlaylist = streams(DEFINE_PLAYLIST);
    r.h.fake.hold("/stream/5e550001-0000-4000-8000-000000000000/master.m3u8?silo_rendition=video&st=signed");
    await playMaster(r);
    await r.h.clock.advance(4999);
    assert.deepEqual(opens(r), [], "the held variant read is still waiting");
    await r.h.clock.advance(1);
    assert.equal(opens(r).length, 1, "five seconds in all, then AVPlay gets it");
    r.controller.destroy();
});
