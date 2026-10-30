// The player screen in Chromium with stub controls: remote keys, focus and readable states.
// Desktop Chromium is not the TV's Chromium 76; this proves behavior, not 2021 rendering.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { type Browser, chromium, type Page } from "playwright";
import type { PlaybackView } from "../../src/player/controller.ts";

const ORIGIN = "https://tv.example.test";
const CSS = readFileSync(new URL("../../src/player/player.css", import.meta.url), "utf8");
const HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Silo</title>
<link rel="stylesheet" href="player.css"></head>
<body style="margin:0;background:#000"><main id="root"></main><script src="harness.js"></script></body></html>`;
const BACK = 10009;
const ENTER = 13;
const LEFT = 37;
const RIGHT = 39;

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

        await show(page, { phase: "playing", title: "The Movie", positionSeconds: 754, durationSeconds: 7200, buffering: false });
        assert.equal(await text(page, ".player-time"), "12:34 / 2:00:00");
        assert.equal(await page.locator(".player-overlay").getAttribute("class"), "player-overlay", "shown when playback starts");
        await page.clock.fastForward(5000);
        await show(page, { phase: "playing", title: "The Movie", positionSeconds: 759, durationSeconds: 7200, buffering: false });
        assert.equal(await page.locator(".player-overlay").getAttribute("class"), "player-overlay player-overlay-hidden");

        await remote(page, ENTER);
        await remote(page, LEFT);
        await remote(page, RIGHT);
        assert.equal(await page.locator(".player-overlay").getAttribute("class"), "player-overlay", "a key brings the overlay back");
        await show(page, { phase: "paused", title: "The Movie", positionSeconds: 759, durationSeconds: undefined, buffering: false });
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

test("backgrounding stops the attempt, shows a restart notice and removes its visibility listener on teardown", async () => {
    const { page, logs } = await open();
    try {
        await show(page, { phase: "playing", title: "The Movie", positionSeconds: 30, durationSeconds: 7200, buffering: false });
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
