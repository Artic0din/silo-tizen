// The player screen in Chromium with stub controls: remote keys, focus and readable states.
// Desktop Chromium is not the TV's Chromium 76; this proves behavior, not 2021 rendering.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { type Browser, chromium, type Page } from "playwright";
import type { PlaybackView, TrackView } from "../../src/player/controller.ts";
import { DEFAULT_APPEARANCE } from "../../src/contracts/v2/subtitles.ts";

const ORIGIN = "https://tv.example.test";
const CSS = ["theme.css", "player/player.css"].map((name) => readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8")).join("\n");
const HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Silo</title>
<link rel="stylesheet" href="player.css"></head>
<body style="margin:0;background:#000"><main id="root"></main><script src="harness.js"></script></body></html>`;
const BACK = 10009;
const ENTER = 13;
const LEFT = 37;
const RIGHT = 39;
const UP = 38;
const DOWN = 40;

const NO_TRACKS: TrackView = { audio: { state: "loading" }, selectedAudioId: undefined, subtitles: [], selectedSubtitleId: undefined, subtitleMode: "off", change: { state: "idle" }, notices: [] };
const TRACKS: TrackView = {
    audio: {
        state: "ready",
        choices: [
            { id: "file:42:audio:0", label: "English · 5.1 · EAC3" },
            { id: "file:42:audio:1", label: "Japanese · Stereo · AAC" },
        ],
    },
    selectedAudioId: "file:42:audio:0",
    subtitles: [
        { id: "file:42:subtitle:0", label: "English" },
        { id: "file:42:subtitle:1", label: "English (Signs) · Forced" },
        { id: "file:42:subtitle:2", label: "Japanese" },
    ],
    selectedSubtitleId: undefined,
    subtitleMode: "off",
    change: { state: "idle" },
    notices: [],
};
const playing = (tracks: TrackView): Extract<PlaybackView, { phase: "playing" | "paused" }> => ({ phase: "playing", title: "The Movie", positionSeconds: 754, durationSeconds: 7200, buffering: false, seekIntervals: { backward: 10, forward: 10 }, tracks });

let browser: Browser;
let script: string;
before(async () => {
    const result = await build({
        entryPoints: [new URL("./playerHarness.ts", import.meta.url).pathname],
        bundle: true,
        format: "iife",
        target: "chrome76",
        write: false,
        logLevel: "silent",
    });
    script = result.outputFiles[0]?.text ?? "";
    browser = await chromium.launch();
});
after(async () => {
    await browser.close();
});

async function open(hidden = false, videoDir?: string): Promise<{ page: Page; logs: string[] }> {
    const context = videoDir === undefined ? undefined : await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: videoDir, size: { width: 1920, height: 1080 } } });
    const page = context === undefined ? await browser.newPage({ viewport: { width: 1920, height: 1080 } }) : await context.newPage();
    const logs: string[] = [];
    page.on("console", (message) => logs.push(message.text()));
    page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));
    await page.route("**/*", async (route) => {
        const path = new URL(route.request().url()).pathname;
        const body = path === "/index.html" ? HTML : path === "/harness.js" ? script : path === "/player.css" ? CSS : undefined;
        if (body === undefined) {
            await route.abort("internetdisconnected");
            return;
        }
        const type = path.endsWith(".js") ? "application/javascript" : path.endsWith(".css") ? "text/css" : "text/html";
        await route.fulfill({ status: 200, contentType: type, body });
    });
    await page.clock.install();
    if (hidden) {
        await page.addInitScript(() => Object.defineProperty(document, "hidden", { configurable: true, value: true }));
    }
    await page.goto(`${ORIGIN}/index.html`);
    return { page, logs };
}

const remote = (page: Page, keyCode: number): Promise<void> =>
    page.evaluate((code) => {
        (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { keyCode: code, bubbles: true, cancelable: true }));
    }, keyCode);
const show = (page: Page, view: PlaybackView): Promise<void> => page.evaluate((next) => window.player.show(next), view);
const commands = (page: Page): Promise<string[]> => page.evaluate(() => window.player.commands.slice());
const focused = (page: Page): Promise<string | null> => page.evaluate(() => document.activeElement?.getAttribute("data-focus") ?? null);

test("autoplay countdown and Cancel are remote-operable without losing manual Play next", async () => {
    const { page } = await open();
    const view: PlaybackView = { phase: "completion", title: "Playback ended", state: "ready", retryable: false, next: { contentId: "next", fileId: "43", title: "Next episode", startSeconds: 0, episode: true }, countdown: 10 };
    try {
        await show(page, view);
        assert.equal(await page.locator('[data-focus="play-next"]').innerText(), "Play next (10s)");
        await remote(page, DOWN);
        assert.equal(await focused(page), "cancel-autoplay");
        await show(page, { ...view, countdown: 9 });
        assert.equal(await focused(page), "cancel-autoplay");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["cancelAutoplay"]);
        await show(page, { ...view, countdown: undefined });
        assert.equal(await focused(page), "play-next");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["cancelAutoplay", "playNext"]);
    } finally { await page.close(); }
});

test("captions apply profile styles, stay safe text and clear during recovery", async () => {
    const { page } = await open();
    try {
        await show(page, { ...playing(TRACKS), captions: { text: '<img src=x onerror="alert(1)">', appearance: { ...DEFAULT_APPEARANCE, fontSize: "xxlarge", fontColor: "#00ff00", position: "top", backgroundOpacity: 50 } } });
        const layer = page.locator(".player-captions");
        assert.equal(await layer.innerText(), '<img src=x onerror="alert(1)">');
        assert.equal(await layer.locator("img").count(), 0);
        assert.equal(await layer.locator("span").evaluate(element => getComputedStyle(element).fontSize), "64px");
        assert.equal(await layer.locator("span").evaluate(element => getComputedStyle(element).color), "rgb(0, 255, 0)");
        await show(page, { phase: "loading", title: "Movie", detail: "reconnecting" });
        assert.equal(await layer.isVisible(), false);
    } finally { await page.close(); }
});

test("series subtitle save stays focused while its write is pending", async () => {
    const { page } = await open();
    try {
        await show(page, playing({ ...TRACKS, seriesSubtitle: { busy: false, message: "" } }));
        await remote(page, DOWN);
        await remote(page, RIGHT);
        for (let index = 0; index < TRACKS.subtitles.length + 1; index++) await remote(page, DOWN);
        assert.equal(await focused(page), "series-subtitles");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["saveSeriesSubtitle"]);
        await show(page, playing({ ...TRACKS, seriesSubtitle: { busy: true, message: "Saving…" } }));
        assert.equal(await focused(page), "series-subtitles");
    } finally { await page.close(); }
});
const text = (page: Page, selector: string): Promise<string> => page.locator(selector).innerText();

test("Skip counts down, activates with Enter or Play, and returns focus without taking manual seeks", async () => {
    const { page, logs } = await open();
    const view = { ...playing(TRACKS), positionSeconds: 25, skipMarker: { kind: "intro" as const, startSeconds: 20, endSeconds: 60 } };
    try {
        await show(page, view);
        assert.equal(await focused(page), "player");
        assert.equal(await text(page, ".player-skip"), "Skip intro · 35 seconds");
        await page.clock.runFor(6000);
        assert.equal(await page.locator(".player-skip").isVisible(), true);
        await remote(page, UP);
        assert.equal(await focused(page), "skip");
        await show(page, { ...view, positionSeconds: 26.5 });
        assert.equal(await text(page, ".player-skip"), "Skip intro · 34 seconds");
        assert.equal(await focused(page), "skip");
        await remote(page, DOWN);
        assert.equal(await focused(page), "pause");
        await remote(page, UP);
        await remote(page, BACK);
        assert.equal(await focused(page), "pause");
        assert.deepEqual(await commands(page), []);
        await remote(page, UP);
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["seekToSeconds 60"]);
        await remote(page, UP);
        await remote(page, 415);
        assert.deepEqual(await commands(page), ["seekToSeconds 60", "seekToSeconds 60"]);
        await remote(page, RIGHT);
        assert.equal(await focused(page), "position");
        assert.equal(await page.locator(".player-skip").isVisible(), false);
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["seekToSeconds 60", "seekToSeconds 60", "seekToSeconds 36.5"]);
        await remote(page, UP);
        await show(page, { ...playing(TRACKS), positionSeconds: 60 });
        assert.equal(await page.locator(".player-skip").isVisible(), false);
        assert.equal(await focused(page), "player");
        await remote(page, UP);
        assert.equal(await focused(page), "pause");
        assert.deepEqual(logs, []);
    } finally { await page.close(); }
});

test("saved 15/45 drives transport labels, repeated preview, dedicated keys and clamping", async () => {
    const { page, logs } = await open();
    const view = { ...playing(TRACKS), positionSeconds: 100, durationSeconds: 200, seekIntervals: { backward: 15, forward: 45 } };
    try {
        await show(page, view);
        assert.equal(await page.getByRole("button", { name: "Back 15 seconds", exact: true }).count(), 1);
        assert.equal(await page.getByRole("button", { name: "Forward 45 seconds", exact: true }).count(), 1);
        const position = () => page.getByRole("slider").getAttribute("aria-valuenow");
        await remote(page, LEFT);
        assert.equal(await position(), "85");
        await remote(page, RIGHT);
        assert.equal(await position(), "130");
        await remote(page, BACK);
        assert.equal(await position(), "100");
        assert.deepEqual(await commands(page), []);
        await remote(page, RIGHT);
        assert.equal(await position(), "145");
        await remote(page, ENTER);
        await remote(page, 412);
        await remote(page, 417);
        assert.deepEqual(await commands(page), ["seekToSeconds 145", "seekBy -15", "seekBy 45"]);
        await page.getByRole("button", { name: "Back 15 seconds", exact: true }).click();
        assert.equal(await position(), "85");
        await remote(page, BACK);
        await page.getByRole("button", { name: "Forward 45 seconds", exact: true }).click();
        assert.equal(await position(), "145");
        await remote(page, BACK);
        await show(page, { ...view, positionSeconds: 5 });
        await remote(page, LEFT);
        assert.equal(await position(), "0");
        await remote(page, BACK);
        await show(page, { ...view, positionSeconds: 190 });
        await remote(page, RIGHT);
        assert.equal(await position(), "200");
        assert.deepEqual(logs, []);
    } finally { await page.close(); }
});

test("settings read failure exposes Retry with remote focus and Back dismissal", async () => {
    const { page, logs } = await open();
    try {
        await show(page, { phase: "error", title: "Synthetic film", error: { kind: "settings" } });
        assert.equal(await focused(page), "settings-retry");
        assert.match(await page.getByRole("alert").innerText(), /seek intervals/);
        await remote(page, DOWN);
        assert.equal(await focused(page), "back");
        await remote(page, UP);
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["retrySettings"]);
        await remote(page, BACK);
        assert.deepEqual(await commands(page), ["retrySettings", "dismissError"]);
        assert.deepEqual(logs, []);
    } finally { await page.close(); }
});

test("dedicated media buttons set playback state and still work over the track menu", async () => {
    const { page, logs } = await open();
    try {
        await show(page, playing(TRACKS));
        for (const key of [415, 415, 19, 19]) await remote(page, key);
        await remote(page, DOWN);
        await page.evaluate(() => {
            for (const key of ["MediaPlay", "MediaPause"]) document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        });
        await remote(page, 412);
        await remote(page, 417);
        await remote(page, 413);
        assert.deepEqual(await commands(page), ["setPaused false", "setPaused false", "setPaused true", "setPaused true", "setPaused false", "setPaused true", "seekBy -10", "seekBy 10", "back"]);
        assert.deepEqual(logs, []);
    } finally { await page.close(); }
});

for (const [code, command] of [[415, "setPaused false"], [19, "setPaused true"], [10252, "togglePause"], [412, "seekBy -10"], [417, "seekBy 10"]] as const) test(`media key ${code} cancels a seek preview and restores playback focus`, async () => {
    const { page, logs } = await open();
    try {
        await show(page, playing(TRACKS));
        await remote(page, RIGHT);
        assert.equal(await focused(page), "position");
        await remote(page, code);
        assert.equal(await focused(page), "player", "discarding the preview restores the playback surface");
        assert.deepEqual(await commands(page), [command], "discarded preview never commits an absolute seek");
        await show(page, playing(TRACKS));
        await page.clock.fastForward(5000);
        await show(page, { ...playing(TRACKS), positionSeconds: 760 });
        assert.equal(await page.locator(".player-overlay").getAttribute("class"), "player-overlay player-overlay-hidden");
        await remote(page, UP);
        await remote(page, code);
        assert.equal(await focused(page), "pause", "a media key without an active preview retains an explicitly focused control");
        assert.deepEqual(logs, []);
    } finally { await page.close(); }
});

test("seeking previews source time without commands until commit and Back cancels", async () => {
    const { page, logs } = await open();
    try {
        await show(page, playing(TRACKS));
        await remote(page, RIGHT);
        await remote(page, RIGHT);
        assert.deepEqual(await commands(page), [], "preview must not send a seek");
        assert.equal(await page.getByRole("slider", { name: "Playback position" }).getAttribute("aria-valuenow"), "774");
        await show(page, { ...playing(TRACKS), positionSeconds: 760 });
        assert.equal(await page.getByRole("slider").getAttribute("aria-valuenow"), "774", "live progress must not move the preview");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["seekToSeconds 774"]);
        await remote(page, LEFT);
        await remote(page, BACK);
        assert.deepEqual(await commands(page), ["seekToSeconds 774"], "cancelling does not seek or leave playback");
        assert.equal(await page.getByRole("slider").getAttribute("aria-valuenow"), "760");
        await remote(page, BACK);
        assert.deepEqual(await commands(page), ["seekToSeconds 774", "back"]);
        assert.deepEqual(logs, []);
    } finally { await page.close(); }
});

test("visible transport controls are reachable by remote and keep focus across progress", async () => {
    const { page, logs } = await open();
    try {
        await show(page, playing(TRACKS));
        await remote(page, UP);
        assert.equal(await focused(page), "pause");
        await show(page, { ...playing(TRACKS), positionSeconds: 755 });
        assert.equal(await focused(page), "pause");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["togglePause"]);
        await remote(page, RIGHT);
        assert.equal(await focused(page), "forward");
        await remote(page, RIGHT);
        assert.equal(await focused(page), "tracks");
        await remote(page, ENTER);
        assert.equal(await menuShown(page), true);
        await remote(page, BACK);
        await page.getByRole("button", { name: "Back 10 seconds", exact: true }).click();
        assert.deepEqual(await commands(page), ["togglePause"], "visible seek controls preview before committing");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["togglePause", "seekToSeconds 745"]);
        assert.deepEqual(logs, []);
    } finally { await page.close(); }
});

test("seek previews clamp to the source bounds and disappear when playback leaves", async () => {
    const { page, logs } = await open();
    try {
        await show(page, { ...playing(TRACKS), positionSeconds: 5, durationSeconds: 20 });
        await remote(page, LEFT);
        await remote(page, LEFT);
        assert.equal(await page.getByRole("slider").getAttribute("aria-valuenow"), "0");
        for (let i = 0; i < 5; i++) await remote(page, RIGHT);
        assert.equal(await page.getByRole("slider").getAttribute("aria-valuenow"), "20");
        assert.deepEqual(await commands(page), []);
        await show(page, { phase: "loading", title: "The Movie" });
        await show(page, { ...playing(TRACKS), positionSeconds: 10 });
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["togglePause"], "loading clears the abandoned preview");
        await remote(page, UP);
        const bounds = await page.locator(".player-transport").evaluate(node => {
            const parent = node.getBoundingClientRect();
            return Array.from(node.children).every(child => { const r = child.getBoundingClientRect(); return r.top >= parent.top && r.bottom <= 1080 && r.left >= 0 && r.right <= 1920; });
        });
        assert.equal(bounds, true);
        assert.deepEqual(logs, []);
    } finally { await page.close(); }
});

test("the Samsung play-pause button operates playback without changing a track selection", async () => {
    const { page, logs } = await open();
    try {
        await show(page, playing(TRACKS));
        await remote(page, 10252);
        assert.deepEqual(await commands(page), ["togglePause"]);
        await remote(page, DOWN);
        await remote(page, 10252);
        assert.deepEqual(await commands(page), ["togglePause", "togglePause"]);
        assert.equal(await page.locator(".player-menu").isVisible(), true);
        assert.deepEqual(logs, []);
    } finally {
        await page.close();
    }
});

/** Saves a capture outside the repository when PLAYER_CAPTURE_DIR is set, for manual review. */
async function capture(page: Page, name: string): Promise<void> {
    const dir = process.env.PLAYER_CAPTURE_DIR;
    if (dir !== undefined) {
        await page.screenshot({ path: `${dir}/${name}.png` });
    }
}

test("loading, playing and paused are readable; the remote cancels a seek preview and goes back with focus kept", async () => {
    const { page, logs } = await open();
    try {
        assert.equal(await text(page, ".player-status"), "Loading");
        assert.equal(await text(page, ".player-overlay .player-title"), "The Movie");
        assert.equal(await focused(page), "player");

        await show(page, { phase: "playing", title: "The Movie", positionSeconds: 754, durationSeconds: 7200, buffering: false, seekIntervals: { backward: 10, forward: 10 }, tracks: NO_TRACKS });
        assert.equal(await text(page, ".player-time"), "12:34 / 2:00:00");
        assert.equal(await page.locator(".player-overlay").getAttribute("class"), "player-overlay", "shown when playback starts");
        await page.clock.fastForward(5000);
        await show(page, { phase: "playing", title: "The Movie", positionSeconds: 759, durationSeconds: 7200, buffering: false, seekIntervals: { backward: 10, forward: 10 }, tracks: NO_TRACKS });
        assert.equal(await page.locator(".player-overlay").getAttribute("class"), "player-overlay player-overlay-hidden");

        await remote(page, ENTER);
        await remote(page, LEFT);
        await remote(page, RIGHT);
        assert.equal(await page.locator(".player-overlay").getAttribute("class"), "player-overlay", "a key brings the overlay back");
        await show(page, { phase: "paused", title: "The Movie", positionSeconds: 759, durationSeconds: undefined, buffering: false, seekIntervals: { backward: 10, forward: 10 }, tracks: NO_TRACKS });
        assert.equal(await text(page, ".player-status"), "Paused");
        assert.equal(await text(page, ".player-time"), "12:39");
        await capture(page, "player-paused");
        await remote(page, BACK);
        await remote(page, BACK);
        assert.deepEqual(await commands(page), ["togglePause", "back"]);
        assert.equal(await focused(page), "player");
        assert.deepEqual(logs, []);
    } finally {
        await page.close();
    }
});

test("an error is shown in words with Back focused; Back or Enter dismisses it, other keys do nothing", async () => {
    const { page, logs } = await open();
    try {
        await show(page, { phase: "error", title: "The Movie", error: { kind: "network" } });
        assert.equal(await text(page, ".player-error-text"), "Can't reach the server. Check the TV's connection, then try again.");
        assert.equal(await page.locator(".player-overlay").isVisible(), false);
        assert.equal(await focused(page), "back");
        await capture(page, "player-error");
        await remote(page, LEFT);
        await remote(page, ENTER);
        await show(page, { phase: "error", title: "The Movie", error: { kind: "terminal", reason: "source_unreadable", message: "This file is damaged.", retryable: false } });
        assert.equal(await text(page, ".player-error-text"), "This file is damaged.");
        await remote(page, BACK);
        assert.deepEqual(await commands(page), ["dismissError", "dismissError"]);
        assert.equal(await focused(page), "back");
        assert.deepEqual(logs, []);
    } finally {
        await page.close();
    }
});

test("the AVPlay object stays hidden so its browser placeholder cannot cover native video", async () => {
    const { page } = await open();
    try {
        const surface = page.locator("object.player-video");
        assert.equal(await surface.count(), 1, "AVPlay retains its object");
        assert.equal(await surface.evaluate((node) => getComputedStyle(node).visibility), "hidden");
        await show(page, { phase: "playing", title: "The Movie", positionSeconds: 60, durationSeconds: 7200, buffering: false, seekIntervals: { backward: 10, forward: 10 }, tracks: NO_TRACKS });
        assert.equal(await surface.evaluate((node) => getComputedStyle(node).visibility), "hidden");
        assert.equal(await page.locator(".player-overlay").isVisible(), true);
    } finally {
        await page.close();
    }
});

test("teardown removes only the player's own node and stops listening for keys", async () => {
    const { page } = await open();
    try {
        await page.evaluate(() => window.player.destroy());
        assert.equal(await page.locator("[data-screen=player]").count(), 0);
        assert.equal(await page.locator("#sibling").count(), 1);
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), []);
    } finally {
        await page.close();
    }
});

const menuShown = (page: Page): Promise<boolean> => page.locator(".player-menu").isVisible();
/** innerText puts a blank line after paragraphs; compare lines only. */
const lines = async (page: Page, selector: string): Promise<string> => (await text(page, selector)).replace(/\n+/g, "\n");

test("Down opens audio and subtitles with focus on the current track; the menu keeps every key to itself", async () => {
    const { page, logs } = await open();
    try {
        await show(page, playing(TRACKS));
        assert.equal(await page.locator(".player-hint").count(), 0);
        assert.equal(await page.getByRole("button", { name: "Audio and subtitles", exact: true }).count(), 1);
        assert.equal(await menuShown(page), false);
        await page.getByRole("button", { name: "Audio and subtitles", exact: true }).click();
        assert.equal(await menuShown(page), true);
        await remote(page, BACK);
        assert.equal(await menuShown(page), false);
        await remote(page, DOWN);
        assert.equal(await menuShown(page), true);
        assert.equal(await focused(page), "file:42:audio:0");
        assert.equal(await text(page, ".player-menu-audio"), "Audio\nEnglish · 5.1 · EAC3\nJapanese · Stereo · AAC");
        assert.equal(await page.locator('[data-focus="file:42:audio:0"]').getAttribute("aria-pressed"), "true");
        await capture(page, "player-tracks-menu");

        await remote(page, UP);
        assert.equal(await focused(page), "file:42:audio:0", "the top of a list holds focus");
        await remote(page, DOWN);
        assert.equal(await focused(page), "file:42:audio:1");
        await remote(page, ENTER);
        await remote(page, RIGHT);
        assert.equal(await focused(page), "subtitles-off", "the current subtitle choice is Off");
        await remote(page, DOWN);
        await remote(page, DOWN);
        assert.equal(await focused(page), "file:42:subtitle:1");
        await remote(page, ENTER);
        await remote(page, UP);
        await remote(page, UP);
        await remote(page, ENTER);
        await remote(page, LEFT);
        assert.equal(await focused(page), "file:42:audio:0", "a list is entered at its current track");
        await remote(page, BACK);
        assert.equal(await menuShown(page), false);
        assert.equal(await focused(page), "player");
        assert.deepEqual(await commands(page), ["selectAudio file:42:audio:1", "selectSubtitle file:42:subtitle:1", "selectSubtitle off"]);

        await remote(page, ENTER);
        await remote(page, BACK);
        assert.deepEqual((await commands(page)).slice(3), ["togglePause", "back"], "closed again, the keys drive playback");
        assert.deepEqual(logs, []);
    } finally {
        await page.close();
    }
});

test("the menu says what is happening: loading, a failed list with Retry, a change, a refusal and notices", async () => {
    const { page, logs } = await open();
    try {
        await show(page, playing({ ...TRACKS, audio: { state: "loading" } }));
        await remote(page, DOWN);
        assert.equal(await lines(page, ".player-menu-audio"), "Audio\nLoading audio tracks");
        assert.equal(await focused(page), "subtitles-off", "with no audio choice, focus starts in subtitles");

        await show(page, playing({ ...TRACKS, audio: { state: "failed" } }));
        assert.equal(await lines(page, ".player-menu-audio"), "Audio\nCouldn't load audio tracks.\nRetry");
        await remote(page, LEFT);
        assert.equal(await focused(page), "audio-retry");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["retryTrackInfo"]);

        await show(page, playing({ ...TRACKS, change: { state: "changing" } }));
        assert.equal(await text(page, ".player-menu-status"), "Changing track");
        await show(page, playing({ ...TRACKS, change: { state: "refused", message: "The selected subtitle source cannot be burned in by the installed transport." } }));
        assert.equal(await text(page, ".player-menu-status"), "Not available: The selected subtitle source cannot be burned in by the installed transport.");
        await show(page, playing({ ...TRACKS, change: { state: "failed" } }));
        assert.equal(await text(page, ".player-menu-status"), "Couldn't change the track. Try again.");
        await show(page, playing({ ...TRACKS, selectedSubtitleId: "file:42:subtitle:2", subtitleMode: "burn_in", notices: ["Subtitles are burned into the video."] }));
        assert.equal(await text(page, ".player-menu-status"), "Subtitles are burned into the video.");
        await capture(page, "player-tracks-burned-in");
        assert.deepEqual(logs, []);
    } finally {
        await page.close();
    }
});

test("long track lists scroll within the panel and keep the focused choice and status visible", async () => {
    const { page } = await open();
    try {
        const subtitles = Array.from({ length: 12 }, (_, n) => ({ id: `file:42:subtitle:${n}`, label: `Subtitle ${n + 1}` }));
        await show(page, playing({ ...TRACKS, subtitles, change: { state: "failed" } }));
        await remote(page, DOWN);
        await remote(page, RIGHT);
        for (let i = 0; i < subtitles.length; i += 1) {
            await remote(page, DOWN);
        }
        assert.equal(await focused(page), "file:42:subtitle:11");
        await page.clock.resume();
        await page.waitForFunction(() => {
            const list = document.querySelector(".player-menu-subtitles");
            const focus = document.activeElement;
            if (list === null || focus === null) {
                return false;
            }
            const bounds = list.getBoundingClientRect();
            const item = focus.getBoundingClientRect();
            return item.top >= bounds.top && item.bottom <= bounds.bottom;
        });
        const geometry = await page.evaluate(() => {
            const player = document.querySelector(".player");
            const list = document.querySelector(".player-menu-subtitles");
            const status = document.querySelector(".player-menu-status");
            const focus = document.activeElement;
            if (!(player instanceof HTMLElement) || !(list instanceof HTMLElement) || status === null || focus === null) {
                throw new Error("Missing track menu");
            }
            return { playerScroll: player.scrollTop, listScroll: list.scrollTop, list: list.getBoundingClientRect().toJSON(), status: status.getBoundingClientRect().toJSON(), focus: focus.getBoundingClientRect().toJSON() };
        });
        assert.equal(geometry.playerScroll, 0, "the player surface must not scroll");
        assert.ok(geometry.listScroll > 0, "only the track list scrolls");
        assert.ok(geometry.focus.top >= geometry.list.top && geometry.focus.bottom <= geometry.list.bottom, "focused choice stays inside the list");
        assert.ok(geometry.status.top >= geometry.list.bottom && geometry.status.bottom <= 1080, "status remains below the list and on screen");
        await capture(page, "player-tracks-overflow");
    } finally {
        await page.close();
    }
});

test("an update keeps focus on the same track; leaving playback closes the menu", async () => {
    const { page } = await open();
    try {
        await show(page, playing(TRACKS));
        await remote(page, DOWN);
        await remote(page, RIGHT);
        await remote(page, DOWN);
        await remote(page, DOWN);
        await remote(page, DOWN);
        assert.equal(await focused(page), "file:42:subtitle:2");
        await show(page, playing({ ...TRACKS, change: { state: "changing" } }));
        assert.equal(await focused(page), "file:42:subtitle:2");
        await show(page, playing({ ...TRACKS, subtitles: TRACKS.subtitles.slice(0, 2) }));
        assert.equal(await focused(page), "subtitles-off", "a track that disappears hands focus to the current choice");
        await show(page, { phase: "loading", title: "The Movie" });
        assert.equal(await menuShown(page), false);
        assert.equal(await focused(page), "player");
        await show(page, playing(TRACKS));
        assert.equal(await menuShown(page), false, "the menu stays closed until asked for again");
    } finally {
        await page.close();
    }
});

test("hiding suspends playback and showing restores it, without a restart notice", async () => {
    const videoDir = process.env.PLAYER_VIDEO_DIR;
    const { page, logs } = await open(false, videoDir);
    const hold = async (): Promise<void> => {
        if (videoDir !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, 700));
        }
    };
    try {
        await show(page, { phase: "playing", title: "The Movie", positionSeconds: 30, durationSeconds: 7200, buffering: false, seekIntervals: { backward: 10, forward: 10 }, tracks: NO_TRACKS });
        await hold();
        await capture(page, "player-before-hide");
        await page.evaluate(() => {
            Object.defineProperty(document, "hidden", { configurable: true, value: true });
            document.dispatchEvent(new Event("visibilitychange"));
        });
        assert.deepEqual(await commands(page), ["suspend"]);
        assert.equal(await page.locator(".player-error").isVisible(), false);
        await page.evaluate(() => {
            Object.defineProperty(document, "hidden", { configurable: true, value: false });
            document.dispatchEvent(new Event("visibilitychange"));
        });
        assert.deepEqual(await commands(page), ["suspend", "restore"]);
        assert.equal(await focused(page), "player");
        await show(page, { phase: "loading", title: "The Movie", detail: "restoring" });
        assert.equal(await text(page, ".player-status"), "Restoring");
        await hold();
        await capture(page, "player-restoring");
        await show(page, { phase: "loading", title: "The Movie", detail: "reconnecting" });
        assert.equal(await text(page, ".player-status"), "Reconnecting");
        await hold();
        await capture(page, "player-reconnecting");
        await show(page, { phase: "error", title: "The Movie", error: { kind: "network" }, retryable: true });
        assert.equal(await text(page, ".player-error-text"), "Can't reach the server. Check the TV's connection, then try again.");
        assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).isVisible(), true);
        await hold();
        await capture(page, "player-connection-lost");
        await page.evaluate(() => {
            window.player.destroy();
            Object.defineProperty(document, "hidden", { configurable: true, value: true });
            document.dispatchEvent(new Event("visibilitychange"));
        });
        assert.deepEqual(await commands(page), ["suspend", "restore"], "retired screen ignores visibility");
        assert.deepEqual(logs, []);
    } finally {
        const video = page.video();
        await page.close();
        if (video !== null && videoDir !== undefined) {
            await video.saveAs(`${videoDir}/player-recovery.webm`);
        }
    }
});

test("a screen mounted while hidden suspends its loading attempt and restores when shown", async () => {
    const { page, logs } = await open(true);
    try {
        assert.deepEqual(await commands(page), ["suspend"]);
        assert.equal(await text(page, ".player-status"), "Loading");
        assert.equal(await page.locator(".player-error").isVisible(), false);
        await page.evaluate(() => {
            Object.defineProperty(document, "hidden", { configurable: true, value: false });
            document.dispatchEvent(new Event("visibilitychange"));
        });
        assert.deepEqual(await commands(page), ["suspend", "restore"]);
        assert.deepEqual(logs, []);
    } finally {
        await page.close();
    }
});

test("quality is server-gated, remote reachable and reports pending/refused state without stealing focus", async () => {
    const { page, logs } = await open();
    const quality = { choices: [{ id: "auto", label: "Auto" }, { id: "future-rung", label: "Server Quality" }], selectedId: "auto" };
    try {
        await show(page, playing(TRACKS));
        await remote(page, DOWN);
        await remote(page, RIGHT);
        await remote(page, RIGHT);
        assert.equal(await focused(page), "subtitles-off", "no quality stop when only Auto exists");
        await show(page, playing({ ...TRACKS, quality }));
        await remote(page, RIGHT);
        assert.equal(await focused(page), "quality:auto");
        await remote(page, DOWN);
        assert.equal(await focused(page), "quality:future-rung");
        assert.equal(await page.locator(".player-menu-quality .player-choice").last().innerText(), "Server Quality");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["selectQuality future-rung"]);
        await show(page, playing({ ...TRACKS, quality, change: { state: "changing", kind: "quality" } }));
        assert.equal(await focused(page), "quality:future-rung");
        assert.equal(await text(page, ".player-menu-status"), "Changing quality");
        await show(page, playing({ ...TRACKS, quality, change: { state: "refused", message: "This quality is unavailable." } }));
        assert.match(await text(page, ".player-menu-status"), /This quality is unavailable/);
        assert.equal(await page.locator('[data-focus="quality:auto"]').getAttribute("aria-pressed"), "true");
        await capture(page, "player-quality-after");
        await show(page, playing({ ...TRACKS, quality: { choices: [], selectedId: undefined } }));
        assert.equal(await focused(page), "file:42:audio:0", "disappearing quality hands focus to a usable list");
        await remote(page, BACK);
        assert.equal(await focused(page), "player");
        assert.deepEqual(logs, []);
    } finally {
        await page.close();
    }
});

test("long server quality lists scroll within the menu with focus and status kept on screen", async () => {
    const { page, logs } = await open();
    const quality = { choices: [{ id: "auto", label: "Auto" }, ...Array.from({ length: 16 }, (_, index) => ({ id: `rung-${index}`, label: `Server quality ${index + 1} with a longer label` }))], selectedId: "auto" };
    try {
        await show(page, playing({ ...TRACKS, quality }));
        await remote(page, DOWN);
        await remote(page, RIGHT);
        await remote(page, RIGHT);
        for (let index = 0; index < 16; index++) await remote(page, DOWN);
        assert.equal(await focused(page), "quality:rung-15");
        await page.clock.resume();
        await page.waitForFunction(() => {
            const list = document.querySelector(".player-menu-quality");
            const focus = document.activeElement;
            if (list === null || focus === null) return false;
            const bounds = list.getBoundingClientRect();
            const item = focus.getBoundingClientRect();
            return item.top >= bounds.top && item.bottom <= bounds.bottom;
        });
        const geometry = await page.evaluate(() => {
            const list = document.querySelector(".player-menu-quality");
            const status = document.querySelector(".player-menu-status");
            assertElement(list);
            assertElement(status);
            const focus = document.activeElement;
            assertElement(focus);
            return { list: list.getBoundingClientRect().toJSON(), focus: focus.getBoundingClientRect().toJSON(), status: status.getBoundingClientRect().toJSON(), scroll: list.scrollTop };
            function assertElement(value: Element | null): asserts value is HTMLElement {
                if (!(value instanceof HTMLElement)) throw new Error("missing element");
            }
        });
        assert.ok(geometry.scroll > 0);
        assert.ok(geometry.focus.top >= geometry.list.top && geometry.focus.bottom <= geometry.list.bottom);
        assert.ok(geometry.status.top >= geometry.list.bottom && geometry.status.bottom <= 1080);
        await show(page, playing({ ...TRACKS, quality, change: { state: "changing", kind: "quality" } }));
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), [], "busy choices remain focusable but cannot send a second intent");
        await remote(page, LEFT);
        assert.equal(await focused(page), "subtitles-off");
        await page.locator('[data-focus="quality:rung-1"]').dispatchEvent("click");
        assert.deepEqual(await commands(page), []);
        await show(page, { phase: "loading", title: "The Movie" });
        assert.equal(await focused(page), "player");
        assert.equal(await menuShown(page), false);
        assert.deepEqual(logs, []);
    } finally {
        await page.close();
    }
});
