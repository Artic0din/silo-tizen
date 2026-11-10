// Start/stop rules of Apple TV theme music (silo-apple ThemeMusicController and ThemeMusicCenter),
// with an audio output that records what the TV would hear.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThemePlayback, ThemeSongSet } from "../../src/contracts/v2/themeMusic.ts";
import { THEME_VOLUME, ThemeMusicCenter, ThemeMusicController, type ThemeAudioOutput, type ThemeMusicPage } from "../../src/ui/themeMusic.ts";
import { ManualClock, settle } from "./support/clock.ts";

class FakeOutput implements ThemeAudioOutput {
    volume = 1;
    loops = false;
    playing = false;
    tornDown = false;
    plays = 0;
    onEnded: (() => void) | undefined;
    onFailed: (() => void) | undefined;
    onProgress: (() => void) | undefined;
    readonly grant: ThemePlayback;
    constructor(grant: ThemePlayback) { this.grant = grant; }
    play(): void { this.playing = true; this.plays++; }
    pause(): void { this.playing = false; }
    tearDown(): void { this.tornDown = true; this.playing = false; this.onEnded = undefined; this.onFailed = undefined; this.onProgress = undefined; }
}

const set = (owner: string, ...themes: string[]): ThemeSongSet => ({ ownerId: owner, items: themes.map(id => ({ id })) });

function setup(options: { converted?: boolean; failGrants?: number } = {}) {
    const grants: { owner: string; theme: string }[] = [];
    const outputs: FakeOutput[] = [];
    const fades: { output: FakeOutput; target: number; done: () => void }[] = [];
    let failures = options.failGrants ?? 0;
    const controller = new ThemeMusicController(
        async (owner, theme) => {
            grants.push({ owner, theme });
            if (failures > 0) { failures--; throw new Error("refused"); }
            return { url: `https://tv.invalid/${owner}/${theme}/${grants.length}`, converted: options.converted ?? false };
        },
        grant => { const output = new FakeOutput(grant); outputs.push(output); return output; },
        (output, target, done) => { fades.push({ output: output as FakeOutput, target, done }); },
    );
    const finishFades = (): void => { for (const fade of fades.splice(0)) { fade.output.volume = fade.target; fade.done(); } };
    return { controller, grants, outputs, fades, finishFades };
}

test("select plays the first theme silently, then fades to the background level once audio advances", async () => {
    const { controller, grants, outputs, fades } = setup();
    controller.select(set("movie:1", "a", "b"), false);
    await controller.waitUntilSettled();
    assert.deepEqual(grants, [{ owner: "movie:1", theme: "a" }]);
    const output = outputs[0]!;
    assert.equal(output.volume, 0);
    assert.equal(output.plays, 1);
    assert.equal(fades.length, 0, "nothing fades in before audio is audible");
    output.onProgress?.();
    assert.deepEqual(fades.map(fade => fade.target), [THEME_VOLUME]);
    assert.equal(THEME_VOLUME, 0.35);
});

test("an empty or missing set stops the theme", async () => {
    const { controller, outputs, finishFades } = setup();
    controller.select(set("movie:1", "a"), false);
    await controller.waitUntilSettled();
    outputs[0]!.onProgress?.();
    finishFades();
    controller.select(set("movie:1"), false);
    finishFades();
    assert.equal(outputs[0]!.tornDown, true);
});

test("the same owner and theme keeps playing without a new grant; another theme replaces it", async () => {
    const { controller, grants, outputs, finishFades } = setup();
    controller.select(set("series:1", "a"), false);
    await controller.waitUntilSettled();
    controller.select(set("series:1", "a"), false);
    await controller.waitUntilSettled();
    assert.equal(grants.length, 1);
    controller.select(set("series:2", "z"), false);
    await controller.waitUntilSettled();
    assert.equal(grants.length, 2);
    finishFades();
    assert.equal(outputs[0]!.tornDown, true);
    assert.equal(outputs[1]!.tornDown, false);
});

test("original audio loops in place and a loop change reaches the playing output", async () => {
    const { controller, outputs } = setup();
    controller.select(set("movie:1", "a"), true);
    await controller.waitUntilSettled();
    assert.equal(outputs[0]!.loops, true);
    controller.select(set("movie:1", "a"), false);
    assert.equal(outputs[0]!.loops, false);
});

test("a converted theme cannot seek back, so a loop replays it with a fresh grant", async () => {
    const { controller, grants, outputs } = setup({ converted: true });
    controller.select(set("movie:1", "a"), true);
    await controller.waitUntilSettled();
    assert.equal(outputs[0]!.loops, false);
    outputs[0]!.onProgress?.();
    outputs[0]!.onEnded?.();
    await controller.waitUntilSettled();
    assert.equal(grants.length, 2);
    assert.equal(outputs[0]!.tornDown, true);
    assert.equal(outputs.length, 2);
});

test("a converted theme that ends without ever playing replays once, not forever", async () => {
    const { controller, grants, outputs } = setup({ converted: true });
    controller.select(set("movie:1", "a"), true);
    await controller.waitUntilSettled();
    outputs[0]!.onEnded?.();
    await controller.waitUntilSettled();
    outputs[1]!.onEnded?.();
    await controller.waitUntilSettled();
    assert.equal(grants.length, 2);
});

test("without a loop, a finished theme is released and does not start again while the page stays", async () => {
    const { controller, grants, outputs } = setup();
    controller.select(set("movie:1", "a"), false);
    await controller.waitUntilSettled();
    outputs[0]!.onProgress?.();
    outputs[0]!.onEnded?.();
    assert.equal(outputs[0]!.tornDown, true);
    controller.select(set("movie:1", "a"), false);
    await controller.waitUntilSettled();
    assert.equal(grants.length, 1);
});

test("a failed stream retries once with a fresh grant; progress earns another retry", async () => {
    const { controller, grants, outputs } = setup();
    controller.select(set("movie:1", "a"), false);
    await controller.waitUntilSettled();
    outputs[0]!.onFailed?.();
    await controller.waitUntilSettled();
    assert.equal(grants.length, 2);
    outputs[1]!.onFailed?.();
    await controller.waitUntilSettled();
    assert.equal(grants.length, 2, "the single retry is spent");
    assert.equal(outputs[1]!.tornDown, true);
});

test("a refused grant leaves the page silent", async () => {
    const { controller, outputs } = setup({ failGrants: 1 });
    controller.select(set("movie:1", "a"), false);
    await controller.waitUntilSettled();
    assert.equal(outputs.length, 0);
});

test("suspend fades out and pauses; selecting the same theme resumes in place", async () => {
    const { controller, grants, outputs, fades, finishFades } = setup();
    controller.select(set("movie:1", "a"), false);
    await controller.waitUntilSettled();
    outputs[0]!.onProgress?.();
    finishFades();
    controller.suspend();
    assert.equal(fades.at(-1)?.target, 0);
    finishFades();
    assert.equal(outputs[0]!.playing, false);
    controller.select(set("movie:1", "a"), false);
    assert.equal(outputs[0]!.playing, true);
    assert.equal(outputs[0]!.plays, 2);
    assert.equal(grants.length, 1);
});

test("stop() fades a playing theme out before tearing it down", async () => {
    const { controller, outputs, fades, finishFades } = setup();
    controller.select(set("movie:1", "a"), false);
    await controller.waitUntilSettled();
    outputs[0]!.onProgress?.();
    finishFades();
    controller.stop();
    assert.equal(outputs[0]!.tornDown, false);
    assert.equal(fades.at(-1)?.target, 0);
    finishFades();
    assert.equal(outputs[0]!.tornDown, true);
});

test("stop('silence') tears down at once; a theme already fading out finishes its fade", async () => {
    const { controller, outputs, finishFades } = setup();
    controller.select(set("movie:1", "a"), false);
    await controller.waitUntilSettled();
    outputs[0]!.onProgress?.();
    finishFades();
    controller.stop();
    controller.select(set("movie:2", "b"), false);
    await controller.waitUntilSettled();
    controller.stop("silence");
    assert.equal(outputs[1]!.tornDown, true);
    assert.equal(outputs[0]!.tornDown, false);
});

test("stop('handOff') silences every output before a video opens, including one still fading", async () => {
    const { controller, outputs, finishFades } = setup();
    controller.select(set("movie:1", "a"), false);
    await controller.waitUntilSettled();
    outputs[0]!.onProgress?.();
    finishFades();
    controller.stop();
    controller.select(set("movie:2", "b"), false);
    await controller.waitUntilSettled();
    controller.stop("handOff");
    assert.equal(outputs[0]!.tornDown, true);
    assert.equal(outputs[1]!.tornDown, true);
});

test("a grant that arrives after stop is ignored", async () => {
    const { controller, grants, outputs } = setup();
    controller.select(set("movie:1", "a"), false);
    controller.stop("handOff");
    await controller.waitUntilSettled();
    assert.equal(grants.length, 1);
    assert.equal(outputs.length, 0, "no audio starts once video has taken over");
});

function pageOf(overrides: Partial<ThemeMusicPage> = {}): ThemeMusicPage {
    return { themes: set("movie:1", "a"), isLoading: false, isVisible: true, isOtherMediaActive: false, enabled: true, loop: false, ...overrides };
}

function centerSetup(options: { available?: boolean } = {}) {
    const inner = setup();
    const clock = new ManualClock();
    let asked = 0;
    let available = options.available ?? true;
    const center = new ThemeMusicCenter(inner.controller, async () => { asked++; return available; }, clock);
    return { ...inner, center, clock, asked: () => asked, setAvailable: (value: boolean) => { available = value; } };
}

test("the page plays only when the profile opted in and the server reports the capability", async () => {
    const { center, outputs, grants, asked } = centerSetup();
    center.update(pageOf({ enabled: false }));
    await center.waitUntilSettled();
    assert.equal(grants.length, 0);
    assert.equal(asked(), 0, "a disabled profile never asks the server");
    center.update(pageOf());
    await center.waitUntilSettled();
    assert.equal(outputs.length, 1);
});

test("a server without the capability stays silent", async () => {
    const { center, grants } = centerSetup({ available: false });
    center.update(pageOf());
    await center.waitUntilSettled();
    assert.equal(grants.length, 0);
});

test("the capability answer stands for a minute, then the next page asks again", async () => {
    const { center, clock, asked } = centerSetup();
    center.update(pageOf());
    await center.waitUntilSettled();
    center.update(pageOf({ loop: true }));
    await center.waitUntilSettled();
    assert.equal(asked(), 1);
    await clock.advance(61_000);
    center.update(pageOf());
    await center.waitUntilSettled();
    assert.equal(asked(), 2);
});

test("a loading or hidden page suspends instead of starting", async () => {
    const { center, outputs, grants, finishFades } = centerSetup();
    center.update(pageOf({ isLoading: true }));
    await center.waitUntilSettled();
    assert.equal(grants.length, 0);
    center.update(pageOf());
    await center.waitUntilSettled();
    outputs[0]!.onProgress?.();
    finishFades();
    center.update(pageOf({ isVisible: false }));
    finishFades();
    assert.equal(outputs[0]!.playing, false);
    center.update(pageOf());
    assert.equal(outputs[0]!.playing, true);
    assert.equal(grants.length, 1);
});

test("other media starting silences the theme at once, before the video opens", async () => {
    const { center, outputs, finishFades } = centerSetup();
    center.update(pageOf());
    await center.waitUntilSettled();
    outputs[0]!.onProgress?.();
    finishFades();
    center.update(pageOf({ isOtherMediaActive: true }));
    assert.equal(outputs[0]!.tornDown, true, "torn down in the same turn, with no fade");
    assert.equal(outputs[0]!.playing, false);
});

test("leaving the page fades the theme out; a page with no theme ends it", async () => {
    const { center, outputs, finishFades } = centerSetup();
    center.update(pageOf());
    await center.waitUntilSettled();
    outputs[0]!.onProgress?.();
    finishFades();
    center.update(undefined);
    finishFades();
    assert.equal(outputs[0]!.tornDown, true);
});

test("reset on sign-out or profile change silences the theme and forgets the capability", async () => {
    const { center, outputs, asked } = centerSetup();
    center.update(pageOf());
    await center.waitUntilSettled();
    center.reset();
    assert.equal(outputs[0]!.tornDown, true);
    center.update(pageOf());
    await center.waitUntilSettled();
    assert.equal(asked(), 2);
});

test("a capability answer that lands after the page was left starts nothing", async () => {
    const { center, outputs, grants } = centerSetup();
    center.update(pageOf());
    center.update(undefined);
    await center.waitUntilSettled();
    await settle();
    assert.equal(grants.length, 0);
    assert.equal(outputs.length, 0);
});
