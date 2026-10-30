// The player screen in Chromium with stub controls: remote keys, focus and readable states.
// Desktop Chromium is not the TV's Chromium 76; this proves behavior, not 2021 rendering.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { type Browser, chromium, type Page } from "playwright";
import type { PlaybackView, TrackView } from "../../src/player/controller.ts";

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
const playing = (tracks: TrackView): PlaybackView => ({ phase: "playing", title: "The Movie", positionSeconds: 754, durationSeconds: 7200, buffering: false, tracks });

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

async function open(hidden = false): Promise<{ page: Page; logs: string[] }> {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
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
const text = (page: Page, selector: string): Promise<string> => page.locator(selector).innerText();

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

test("loading, playing and paused are readable; the remote pauses, seeks and goes back with focus kept", async () => {
    const { page, logs } = await open();
    try {
        assert.equal(await text(page, ".player-status"), "Loading");
        assert.equal(await text(page, ".player-overlay .player-title"), "The Movie");
        assert.equal(await focused(page), "player");

        await show(page, { phase: "playing", title: "The Movie", positionSeconds: 754, durationSeconds: 7200, buffering: false, tracks: NO_TRACKS });
        assert.equal(await text(page, ".player-time"), "12:34 / 2:00:00");
        assert.equal(await page.locator(".player-overlay").getAttribute("class"), "player-overlay", "shown when playback starts");
        await page.clock.fastForward(5000);
        await show(page, { phase: "playing", title: "The Movie", positionSeconds: 759, durationSeconds: 7200, buffering: false, tracks: NO_TRACKS });
        assert.equal(await page.locator(".player-overlay").getAttribute("class"), "player-overlay player-overlay-hidden");

        await remote(page, ENTER);
        await remote(page, LEFT);
        await remote(page, RIGHT);
        assert.equal(await page.locator(".player-overlay").getAttribute("class"), "player-overlay", "a key brings the overlay back");
        await show(page, { phase: "paused", title: "The Movie", positionSeconds: 759, durationSeconds: undefined, buffering: false, tracks: NO_TRACKS });
        assert.equal(await text(page, ".player-status"), "Paused");
        assert.equal(await text(page, ".player-time"), "12:39");
        await capture(page, "player-paused");
        await remote(page, BACK);
        assert.deepEqual(await commands(page), ["togglePause", "seekBy -10", "seekBy 10", "back"]);
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
        await show(page, { phase: "playing", title: "The Movie", positionSeconds: 60, durationSeconds: 7200, buffering: false, tracks: NO_TRACKS });
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

test("backgrounding stops the attempt, shows a restart notice and removes its visibility listener on teardown", async () => {
    const { page, logs } = await open();
    try {
        await show(page, { phase: "playing", title: "The Movie", positionSeconds: 30, durationSeconds: 7200, buffering: false, tracks: NO_TRACKS });
        await page.evaluate(() => {
            Object.defineProperty(document, "hidden", { configurable: true, value: true });
            document.dispatchEvent(new Event("visibilitychange"));
        });
        assert.deepEqual(await commands(page), ["background"]);
        assert.equal(await text(page, ".player-error-text"), "Playback stopped when you left Silo. Go back and select the title to play again.");
        await capture(page, "player-backgrounded");
        await page.evaluate(() => {
            Object.defineProperty(document, "hidden", { configurable: true, value: false });
            document.dispatchEvent(new Event("visibilitychange"));
        });
        assert.deepEqual(await commands(page), ["background"], "returning never silently starts another attempt");
        assert.equal(await focused(page), "back");
        await page.evaluate(() => {
            window.player.destroy();
            Object.defineProperty(document, "hidden", { configurable: true, value: true });
            document.dispatchEvent(new Event("visibilitychange"));
        });
        assert.deepEqual(await commands(page), ["background"], "retired screen ignores visibility");
        assert.deepEqual(logs, []);
    } finally {
        await page.close();
    }
});

test("a screen mounted while hidden stops its loading attempt before normal controls are shown", async () => {
    const { page, logs } = await open(true);
    try {
        assert.deepEqual(await commands(page), ["background"]);
        assert.equal(await text(page, ".player-error-text"), "Playback stopped when you left Silo. Go back and select the title to play again.");
        assert.deepEqual(logs, []);
    } finally {
        await page.close();
    }
});
