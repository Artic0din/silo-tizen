// The player screen in Chromium with stub controls: remote keys, focus and readable states.
// Desktop Chromium is not the TV's Chromium 108; this proves behavior, not TV rendering.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { type Browser, chromium, type Page } from "playwright";
import type { PlaybackView, TrackView } from "../../src/player/controller.ts";
import { DEFAULT_APPEARANCE } from "../../src/contracts/v2/subtitles.ts";
import type { SkipMarker } from "../../src/contracts/v2/markers.ts";
import { readLive } from "./support/tv.ts";

const ORIGIN = "https://tv.example.test";
const CSS = ["theme.css", "app.css", "player/player.css"].map((name) => readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8")).join("\n");
const HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Silo</title>
<link rel="stylesheet" href="player.css">
<style>#sibling { position: absolute; inset: 0; background: #000; }</style></head>
<body><main id="root"></main><script src="harness.js"></script></body></html>`;
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

test("Info Retry remains visible when Down is pressed on its focused action", async () => {
    const { page } = await open();
    try {
        await show(page, { ...playing(TRACKS), hud: { chapters: [], chapterState: "failed", overview: "Long overview. ".repeat(400), stats: [], speeds: [], aspects: [], speed: 1, aspect: "Fit", autoNext: false, busy: false } });
        await openPanel(page);
        const retry = page.locator('[data-focus="chapters-retry"]');
        await retry.focus();
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.clock.runFor(200);
        const before = await page.locator(".player-menu-info").evaluate(node => node.scrollTop);
        await remote(page, DOWN);
        assert.equal(await page.locator(".player-menu-info").evaluate(node => node.scrollTop), before);
        const visible = await retry.evaluate(node => {
            const r = node.getBoundingClientRect();
            const p = node.closest(".player-menu-info")!.getBoundingClientRect();
            return r.top >= p.top && r.bottom <= p.bottom;
        });
        assert.equal(visible, true);
    } finally { await page.close(); }
});

test("Up scrolls a long Info overview before returning to its tab", async () => {
    const { page } = await open();
    try {
        await show(page, { ...playing(TRACKS), hud: { chapters: [], chapterState: "ready", overview: "Long overview. ".repeat(400), stats: [], speeds: [], aspects: [], speed: 1, aspect: "Fit", autoNext: false, busy: false } });
        await openPanel(page);
        // TVPlayerInfoHUD.availableTabs hides Chapters when there are none.
        assert.deepEqual(await page.locator(".player-tab:not([hidden])").allTextContents(), ["Info", "Stats", "Video", "Audio", "Subtitles"]);
        await page.emulateMedia({ reducedMotion: "reduce" });
        assert.equal(await focused(page), "info");
        const pane = page.locator(".player-menu-info");
        const before = await pane.evaluate(node => {
            node.scrollTop = node.scrollHeight;
            return { scroll: node.scrollTop, overflow: node.scrollHeight > node.clientHeight };
        });
        assert.equal(before.overflow, true);
        assert.ok(before.scroll > 1);
        await remote(page, UP);
        const after = await pane.evaluate(node => node.scrollTop);
        assert.ok(after < before.scroll, `scroll stayed at ${before.scroll}`);
        assert.equal(await focused(page), "info");
    } finally { await page.close(); }
});

test("chapters seek in source time, close options and retain a remote focus target", async () => {
    const { page } = await open();
    try {
        await show(page, { ...playing(TRACKS), hud: { chapters: [{ title: "Opening", seconds: 0 }, { title: "Second", seconds: 800 }], chapterState: "ready", stats: [["Engine", "AVPlay"]], speeds: [1, 2], aspects: ["Fit", "Stretch"], speed: 1, aspect: "Fit", autoNext: false, busy: false } });
        await openPanel(page);
        assert.deepEqual(await page.locator(".player-tab:not([hidden])").allTextContents(), ["Info", "Stats", "Video", "Audio", "Subtitles", "Chapters"]);
        await remote(page, RIGHT);
        assert.equal(await focused(page), "info", "Right inside a pane does not change tabs");
        await nextTab(page, 5);
        assert.equal(await focused(page), "chapter:0");
        await remote(page, DOWN);
        await page.evaluate((code) => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { keyCode: code, bubbles: true, cancelable: true })), ENTER);
        await page.evaluate((code) => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { keyCode: code, repeat: true, bubbles: true, cancelable: true })), ENTER);
        assert.deepEqual(await commands(page), [], "a chapter waits for Select's release");
        await page.evaluate((code) => document.activeElement?.dispatchEvent(new KeyboardEvent("keyup", { keyCode: code, bubbles: true, cancelable: true })), ENTER);
        assert.deepEqual(await commands(page), ["seekToSeconds 800"]);
        assert.equal(await page.locator(".player-hud").isVisible(), false);
        assert.equal(await focused(page), "position");
    } finally { await page.close(); }
});

test("Video actions and Stats are remote reachable and updates preserve the selected control", async () => {
    const { page } = await open();
    try {
        const hud = { chapters: [], chapterState: "ready" as const, overview: "An overview.", stats: [["Engine", "AVPlay"]] as const, speeds: [1, 2], aspects: ["Fit", "Stretch"] as const, speed: 1, aspect: "Fit" as const, autoNext: false, busy: false };
        await show(page, { ...playing(TRACKS), hud });
        await openPanel(page);
        assert.match(await text(page, ".player-menu-info"), /An overview/);
        await nextTab(page, 1);
        assert.equal(await focused(page), "stat:Engine");
        assert.match(await text(page, ".player-menu-stats"), /Engine: AVPlay/);
        await nextTab(page, 1);
        // VideoPane PLAYBACK rows open pickers (TVPlayerInfoHUD.swift:825-879).
        assert.equal(await focused(page), "video-speed");
        assert.equal(await text(page, '[data-focus="video-speed"]'), "Speed\n1.0×");
        assert.equal(await text(page, '[data-focus="video-aspect"]'), "Aspect\nFit");
        await remote(page, ENTER);
        assert.equal(await text(page, ".player-menu-quality .player-menu-picker-title"), "Playback Speed");
        assert.equal(await focused(page), "subtitle-picker:1", "the picker opens on the current speed");
        await remote(page, DOWN);
        await remote(page, ENTER);
        assert.equal(await focused(page), "video-speed");
        await show(page, { ...playing(TRACKS), hud: { ...hud, speed: 2 } });
        assert.equal(await focused(page), "video-speed");
        assert.equal(await text(page, '[data-focus="video-speed"]'), "Speed\n2.00×");
        await remote(page, DOWN);
        await remote(page, ENTER);
        assert.equal(await text(page, ".player-menu-quality .player-menu-picker-title"), "Aspect");
        await remote(page, DOWN);
        await remote(page, ENTER);
        await remote(page, DOWN);
        assert.equal(await focused(page), "video-aspect", "Down stays in the PLAYBACK column");
        await remote(page, RIGHT);
        assert.equal(await focused(page), "auto-next");
        assert.equal(await text(page, '[data-focus="auto-next"]'), "Auto-play next\nOff");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["setVideo speed 2", "setVideo aspect Stretch", "toggleAutoNext"]);
        await show(page, { ...playing(TRACKS), hud: { ...hud, busy: true } });
        await remote(page, ENTER);
        assert.equal((await commands(page)).length, 3);
    } finally { await page.close(); }
});

let browser: Browser;
let script: string;
before(async () => {
    const result = await build({
        entryPoints: [new URL("./playerHarness.ts", import.meta.url).pathname],
        bundle: true,
        format: "iife",
        target: "chrome108",
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
        if (path === "/fonts/InterVariable.woff2") {
            // theme.css's ../fonts/ URL: the file the WGT packages.
            await route.fulfill({ status: 200, contentType: "font/woff2", body: readFileSync(new URL("../../app/fonts/InterVariable.woff2", import.meta.url)) });
            return;
        }
        const body = path === "/index.html" ? HTML : path === "/harness.js" ? script : path === "/player.css" ? CSS : undefined;
        if (body === undefined) {
            await route.abort("internetdisconnected");
            return;
        }
        const type = path.endsWith(".js") ? "application/javascript" : path.endsWith(".css") ? "text/css" : "text/html";
        await route.fulfill({ status: 200, contentType: type, body });
    });
    const time = new Date("2026-11-05T00:00:00Z");
    await page.clock.install({ time });
    // Real time passes between install and here on a slow runner, so a fixed target can already be past.
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    if (hidden) {
        await page.addInitScript(() => Object.defineProperty(document, "hidden", { configurable: true, value: true }));
    }
    await page.goto(`${ORIGIN}/index.html`);
    return { page, logs };
}

/** Down used to open the panel on Audio. Down now focuses Play/Pause, and Options opens Info. */
async function openPanel(page: Page): Promise<void> {
    await remote(page, DOWN);
    await remote(page, RIGHT);
    await remote(page, RIGHT);
    await remote(page, ENTER);
    await remote(page, DOWN);
}

/** Audio is the tab after Info, which is where the panel used to open. */
async function openAudio(page: Page): Promise<void> {
    await openPanel(page);
    await nextTab(page, 3);
}

/** Up to the tab rail, Right `steps` tabs, Down into that pane: as on Apple TV, panes change only on the rail. */
async function nextTab(page: Page, steps: number): Promise<void> {
    await remote(page, UP);
    for (let index = 0; index < steps; index++) await remote(page, RIGHT);
    await remote(page, DOWN);
}

const remote = (page: Page, keyCode: number): Promise<void> => page.evaluate((code) => {
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { keyCode: code, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { keyCode: code, bubbles: true, cancelable: true }));
}, keyCode);
const show = (page: Page, view: PlaybackView): Promise<void> => page.evaluate((next) => window.player.show(next), view);
const commands = (page: Page): Promise<string[]> => page.evaluate(() => window.player.commands.slice());
const focused = (page: Page): Promise<string | null> => page.evaluate(() => document.activeElement?.getAttribute("data-focus") ?? null);

test("measured Apple playback geometry", async () => {
    const { page } = await open();
    try {
        await show(page, playing(TRACKS));
        await page.evaluate(() => document.fonts.ready);
        await page.clock.runFor(200);
        const geometry = await readLive({ page, eventually: async (check, what) => { assert.ok(await check(), what); } }, () => {
            return [".player-bar-track", ".player-time-elapsed", ".player-time-remaining", ".player-transport"].map(selector => {
                const r = document.querySelector(selector)!.getBoundingClientRect();
                return { x: r.x, right: r.right, center: r.y + r.height / 2 };
            });
        }, undefined, () => true, "settled playback geometry");
        assert.deepEqual(geometry, [
            { x: 160, right: 1760, center: 820 },
            { x: 160, right: geometry[1]!.right, center: 877 },
            { x: geometry[2]!.x, right: 1760, center: 877 },
            { x: 160, right: 1760, center: 940 },
        ]);
    } finally { await page.close(); }
});

test("transport focus re-arms five seconds then hides and hidden Up reveals the scrubber", async () => {
    const { page } = await open();
    try {
        await show(page, playing(TRACKS));
        await remote(page, DOWN);
        await page.clock.runFor(4900);
        await remote(page, RIGHT);
        await page.clock.runFor(4900);
        assert.equal(await page.locator(".player-overlay-hidden").count(), 0);
        await page.clock.runFor(100);
        assert.equal(await page.locator(".player-overlay-hidden").count(), 1);
        await remote(page, UP);
        assert.equal(await page.locator(".player-overlay-hidden").count(), 0);
        assert.equal(await focused(page), "position");
    } finally { await page.close(); }
});

test("a Select held while the controls hide does not run on the scrubber it lands on", async () => {
    const { page } = await open();
    try {
        await show(page, playing(TRACKS));
        await remote(page, DOWN);
        await remote(page, RIGHT);
        await remote(page, RIGHT);
        const held = await focused(page);
        await page.evaluate((code) => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { keyCode: code, bubbles: true, cancelable: true })), ENTER);
        await page.clock.runFor(5000);
        assert.notEqual(await focused(page), held, "hiding the controls moved focus");
        await page.evaluate((code) => document.activeElement?.dispatchEvent(new KeyboardEvent("keyup", { keyCode: code, bubbles: true, cancelable: true })), ENTER);
        assert.deepEqual(await commands(page), [], "the release ran nothing");
        assert.equal(await page.locator(".player-hud").isVisible(), false);
    } finally { await page.close(); }
});

test("hidden Down opens Video when that tab is shown and options opens Info", async () => {
    const { page } = await open();
    try {
        const quality = { choices: [{ id: "auto", label: "Auto" }, { id: "1080p", label: "1080p" }], selectedId: "auto" };
        await show(page, playing({ ...TRACKS, quality }));
        await page.getByRole("button", { name: "Info and options", exact: true }).click();
        assert.equal(await focused(page), "tab-info");
        await remote(page, BACK);
        await page.clock.runFor(5000);
        await remote(page, DOWN);
        assert.equal(await focused(page), "tab-video");
        await remote(page, BACK);
        await page.getByRole("button", { name: "Info and options", exact: true }).click();
        assert.equal(await focused(page), "tab-video");
    } finally { await page.close(); }
});

test("hidden Down opens Info and hidden Right returns to scrubber", async () => {
    const { page } = await open();
    try {
        await show(page, playing(TRACKS));
        await page.clock.runFor(5000);
        await remote(page, DOWN);
        assert.equal(await page.locator(".player-hud").isVisible(), true);
        assert.equal(await page.locator(".player-overlay .player-title").isVisible(), false);
        assert.equal(await page.locator(".player-bar").isVisible(), false);
        assert.equal(await page.locator(".player-transport").isVisible(), false);
        await remote(page, BACK);
        assert.equal(await page.locator(".player-overlay .player-title").isVisible(), true);
        assert.equal(await page.locator(".player-bar").isVisible(), true);
        assert.equal(await page.locator(".player-transport").isVisible(), true);
        assert.equal(await focused(page), "position");
        await page.clock.runFor(5000);
        await remote(page, RIGHT);
        assert.equal(await focused(page), "position");
    } finally { await page.close(); }
});

test("Show Up Next is in the transport and its panel names the next episode", async () => {
    const { page } = await open();
    try {
        const view = playing(TRACKS);
        await show(page, { ...view, episodes: true });
        await remote(page, DOWN);
        await remote(page, RIGHT);
        await remote(page, RIGHT);
        assert.equal(await focused(page), "up-next");
        assert.equal(await page.getByRole("button", { name: "Show Up Next" }).count(), 1);
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["showUpNext"]);
        await show(page, { ...view, episodes: true, upNext: { next: undefined, deck: [], countdown: undefined, status: "Up Next", loading: true } });
        assert.equal(await page.locator(".player-next-up .player-title").innerText(), "Finding the next episode");
        assert.equal(await page.getByText("Loading Up Next").count(), 0);
        await show(page, { ...view, episodes: true, upNext: { next: { contentId: "episode:s1e13", fileId: "43", title: "Harbor Lights chapter 1.3", startSeconds: 0 }, deck: [], countdown: undefined, status: "Up Next" } });
        assert.equal(await page.locator(".player-next-up .player-title").innerText(), "Harbor Lights chapter 1.3");
        assert.equal(await page.getByText("Nothing to watch next").count(), 0);
        assert.equal(await page.getByText("Loading Up Next").count(), 0);
    } finally { await page.close(); }
});

test("hiding Close focus makes Select enter the scrubber instead of closing playback", async () => {
    const { page } = await open();
    try {
        await show(page, playing(TRACKS));
        await remote(page, DOWN);
        for (let i = 0; i < 3; i++) await remote(page, RIGHT);
        assert.equal(await focused(page), "close");
        await page.clock.runFor(5000);
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["setPaused true"]);
        assert.equal(await focused(page), "position");
    } finally { await page.close(); }
});

test("track updates preserve the focused HUD tab", async () => {
    const { page } = await open();
    try {
        await show(page, playing(TRACKS));
        await page.clock.runFor(5000);
        await remote(page, DOWN);
        assert.equal(await focused(page), "tab-video");
        await show(page, playing({ ...TRACKS, notices: ["Updated"] }));
        assert.equal(await focused(page), "tab-video");
    } finally { await page.close(); }
});

test("timeline scrub opacity takes precedence over focus", async () => {
    const { page } = await open();
    try {
        await show(page, playing(TRACKS));
        await remote(page, ENTER);
        assert.equal(await page.locator(".player-bar-track").evaluate(node => getComputedStyle(node).backgroundColor), "rgba(255, 255, 255, 0.48)");
    } finally { await page.close(); }
});

test("the playback clock keeps one line height before and after the app font loads", async () => {
    const { page } = await open();
    try {
        await show(page, playing(TRACKS));
        // The clock row sets where the scrubber sits. A face swap that changes its height moves the
        // scrubber after placeThumbnail has stored a pixel bottom for the preview card.
        assert.equal(await page.locator(".player-time").evaluate(node => getComputedStyle(node).lineHeight), "34px");
    } finally { await page.close(); }
});

test("scrub thumbnail follows the playhead and sits 101.0234375px above the handle", async () => {
    const { page } = await open();
    try {
        // TVScrubPreviewLayer at silo-apple 2ef3a171: card bottom is scrubPreviewBottomInset (300)
        // above the controls' bottom, and the handle centre is 198.9765625 above that same edge.
        const aboveHandle = 101.0234375;
        // padding 10 + image 180 + spacing 8 + 24pt rounded semibold line 28.265625 + padding 10.
        const cardHeight = 236.265625;
        const measure = async (seconds: number): Promise<{ x: number; bottom: number; height: number; width: number; barX: number; barRight: number; handle: number; puck: number }> => {
            await show(page, { ...playing(TRACKS), positionSeconds: seconds, durationSeconds: 7200 });
            await remote(page, ENTER);
            return page.evaluate(() => {
                const card = document.querySelector<HTMLElement>(".player-thumbnail");
                const bar = document.querySelector(".player-bar");
                const puck = document.querySelector(".player-puck");
                if (card === null || bar === null || puck === null) throw new Error("missing scrub preview");
                card.hidden = false;
                const cardBox = card.getBoundingClientRect();
                const barBox = bar.getBoundingClientRect();
                const puckBox = puck.getBoundingClientRect();
                return { x: cardBox.x, bottom: cardBox.bottom, height: cardBox.height, width: cardBox.width, barX: barBox.x, barRight: barBox.right, handle: barBox.y + barBox.height / 2, puck: puckBox.x + puckBox.width / 2 };
            });
        };
        const start = await measure(0);
        assert.ok(Math.abs(start.bottom - (start.handle - aboveHandle)) < 0.01, `thumbnail bottom ${start.bottom}, handle ${start.handle}`);
        assert.ok(Math.abs(start.height - cardHeight) < 0.01, `thumbnail height ${start.height}`);
        assert.ok(Math.abs(start.x - start.barX) < 1, `thumbnail x ${start.x}, track ${start.barX}`);
        await remote(page, BACK);
        const middle = await measure(3600);
        assert.ok(Math.abs(middle.x + middle.width / 2 - middle.puck) < 1, `thumbnail center ${middle.x + middle.width / 2}, puck ${middle.puck}`);
        assert.ok(Math.abs(middle.bottom - (middle.handle - aboveHandle)) < 0.01, `middle bottom ${middle.bottom}, handle ${middle.handle}`);
        assert.ok(Math.abs(middle.height - cardHeight) < 0.01, `middle height ${middle.height}`);
        await remote(page, BACK);
        const end = await measure(7200);
        assert.ok(Math.abs(end.x + end.width - end.barRight) < 1, `thumbnail right ${end.x + end.width}, track ${end.barRight}`);
    } finally { await page.close(); }
});

test("episode footer shows series, title and episode tag without an empty status row", async () => {
    const { page } = await open();
    try {
        await show(page, { ...playing(TRACKS), title: "Going Green", ...{ seriesTitle: "The Series", seasonNumber: 1, episodeNumber: 25 } });
        assert.equal(await page.locator(".player-series").textContent(), "The Series");
        assert.equal(await page.locator(".player-title").first().textContent(), "Going Green");
        assert.equal(await page.locator(".player-episode").textContent(), "S1 · E25");
        assert.equal(await page.locator(".player-status").isVisible(), false);
        const tops = async (): Promise<{ series: number; title: number; episode: number; episodeX: number }> => page.evaluate(() => {
            const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
            return { series: box(".player-series").y, title: box(".player-overlay .player-title").y, episode: box(".player-episode").y, episodeX: box(".player-episode").x };
        });
        const playingTops = await tops();
        assert.ok(Math.abs(playingTops.series - 711) < 0.5, `series y ${playingTops.series}`);
        assert.ok(Math.abs(playingTops.title - 737) < 0.5, `title y ${playingTops.title}`);
        assert.ok(Math.abs(playingTops.episode - 747) < 0.5, `episode y ${playingTops.episode}`);
        assert.equal(await page.locator(".player-series").evaluate((node) => node.getBoundingClientRect().x), 160);
        await show(page, { ...playing(TRACKS), phase: "paused", title: "Going Green", seriesTitle: "The Series", seasonNumber: 1, episodeNumber: 25 });
        assert.equal(await page.locator(".player-status").isVisible(), false);
        assert.deepEqual(await tops(), playingTops);
        await show(page, { ...playing(TRACKS), buffering: true, title: "Going Green", seriesTitle: "The Series", seasonNumber: 1, episodeNumber: 25 });
        assert.equal(await page.locator(".player-spinner").isVisible(), true);
        assert.equal(await page.locator(".player-status").isVisible(), false);
        assert.deepEqual(await tops(), playingTops);
    } finally { await page.close(); }
});

test("Info panel measured placement and Up Down Menu focus", async () => {
    const { page } = await open();
    try {
        await show(page, playing(TRACKS));
        await page.getByRole("button", { name: "Info and options", exact: true }).click();
        assert.equal(await focused(page), "tab-info");
        await remote(page, DOWN);
        assert.equal(await focused(page), "info");
        await remote(page, UP);
        assert.equal(await focused(page), "tab-info");
        await page.clock.runFor(200);
        const rect = await readLive({ page, eventually: async (check, what) => { assert.ok(await check(), what); } }, () => {
            const r = document.querySelector(".player-menu")!.getBoundingClientRect();
            return { y: r.y, width: r.width, height: r.height };
        }, undefined, () => true, "settled Info panel");
        assert.deepEqual(rect, { y: 155, width: 1100, height: 380 });
        await remote(page, BACK);
        assert.equal(await page.locator(".player-hud").isVisible(), false);
        assert.equal(await focused(page), "position");
    } finally { await page.close(); }
});

for (const commit of ["debounce", "select", "timeline"] as const) test(`pending ${commit} seek holds labels and accumulates another tap`, async () => {
    const { page } = await open();
    try {
        await show(page, { ...playing(TRACKS), previewKey: "plan" });
        if (commit === "timeline") await remote(page, ENTER);
        await remote(page, RIGHT);
        if (commit === "debounce") await page.clock.runFor(200);
        else await remote(page, ENTER);
        await show(page, { ...playing(TRACKS), previewKey: undefined });
        await page.clock.runFor(1000);
        assert.equal(await page.locator(".player-time-elapsed").textContent(), "12:44");
        assert.equal(await page.locator(".player-time-remaining").textContent(), "−1:47:16");
        await remote(page, RIGHT);
        assert.equal(await page.getByRole("slider").getAttribute("aria-valuenow"), "774");
    } finally { await page.close(); }
});

test("autoplay countdown and Cancel are remote-operable without losing manual Play next", async () => {
    const { page } = await open();
    const view: PlaybackView = { phase: "completion", title: "Playback ended", state: "ready", retryable: false, next: { contentId: "next", fileId: "43", title: "Next episode", startSeconds: 0, episode: true }, countdown: 10 };
    try {
        await show(page, view);
        assert.equal(await page.locator('[data-focus="play-next"]').innerText(), "Play Now");
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

test("Up Next cancels an armed scrub hold before it can pause behind the panel", async () => {
    const { page } = await open();
    try {
        await show(page, playing(TRACKS));
        await holdKey(page, RIGHT);
        const candidate = { contentId: "next", fileId: "43", title: "Next", startSeconds: 0, episode: true as const };
        await show(page, { ...playing(TRACKS), upNext: { next: candidate, deck: [], countdown: 30, status: "Up Next" } });
        await page.clock.runFor(2000);
        assert.deepEqual(await commands(page), []);
        assert.equal(await focused(page), "play-next");
    } finally { await page.close(); }
});

test("On Deck resolves relative artwork against the connected server", async () => {
    const { page } = await open();
    try {
        await page.route("**/api/v2/images/backdrop", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        const candidate = { contentId: "next", fileId: "43", title: "Next", startSeconds: 0, episode: true as const, backdropUrl: "/api/v2/images/backdrop" };
        await show(page, { ...playing(TRACKS), upNext: { next: candidate, deck: [candidate], countdown: 30, status: "Up Next" } });
        assert.equal(await page.locator(".player-next-card img").getAttribute("src"), "https://media.test/api/v2/images/backdrop");
    } finally { await page.close(); }
});

test("On Deck blurs an unwatched episode still and leaves other artwork sharp", async () => {
    const { page } = await open();
    try {
        await page.route("**/api/v2/images/**", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
        const still = { contentId: "still", fileId: "43", title: "Secret", startSeconds: 0, episode: true as const, backdropUrl: "/api/v2/images/still", hideBackdrop: true as const };
        const series = { contentId: "series-art", fileId: "44", title: "Key art", startSeconds: 0, episode: true as const, backdropUrl: "/api/v2/images/series" };
        await show(page, { ...playing(TRACKS), upNext: { next: still, deck: [still, series], countdown: undefined, status: "Up Next" } });
        assert.equal(await page.locator(".player-next-card .episode-spoiler-blur .player-next-still").count(), 1);
        assert.match(await page.locator(".player-next-still").evaluate(node => getComputedStyle(node).filter), /blur\(24px\)/);
        assert.equal(await page.locator(".player-next-card > img").count(), 1);
    } finally { await page.close(); }
});

for (const complete of [false, true]) {
    test(`On Deck preserves the focused content when later candidates arrive (${complete ? "EOF" : "pre-end"})`, async () => {
        const { page } = await open();
        const first = { contentId: "first", fileId: "43", title: "First", startSeconds: 0, episode: true as const };
        const second = { ...first, contentId: "second", title: "Second" };
        const view = (deck: readonly typeof first[]): PlaybackView => complete
            ? { phase: "completion", title: "Up Next", state: "ready", retryable: false, next: first, deck }
            : { ...playing(TRACKS), upNext: { next: first, deck, countdown: 30, status: "Up Next" } };
        try {
            await show(page, view([first]));
            for (let i = 0; i < 3 && await focused(page) !== "deck:first"; i++) await remote(page, DOWN);
            assert.equal(await focused(page), "deck:first");
            await show(page, view([{ ...first, fileId: "updated" }, second]));
            assert.equal(await focused(page), "deck:first");
            await remote(page, ENTER);
            assert.deepEqual(await commands(page), ["playNext first updated"]);
        } finally { await page.close(); }
    });
}

test("Up Next captures remote input, preserves focus and exposes Keep Watching and On Deck", async () => {
    const { page } = await open();
    const candidate = { contentId: "next", fileId: "43", title: "Next episode", overview: "The next chapter.", startSeconds: 0, episode: true as const };
    const cards = Array.from({ length: 12 }, (_, index) => ({ ...candidate, contentId: `deck-${index}`, title: `Title ${index}` }));
    const view: PlaybackView = { ...playing(TRACKS), upNext: { next: candidate, deck: cards, countdown: 30, status: "Up Next" } };
    try {
        await show(page, view);
        assert.equal(await focused(page), "play-next");
        assert.equal(await page.locator(".player-next-eyebrow").innerText(), "UP NEXT");
        assert.equal(await page.locator(".player-next-synopsis").innerText(), "The next chapter.");
        assert.equal(await page.locator(".player-next-card").count(), 12);
        await remote(page, 19);
        await remote(page, 415);
        await remote(page, 10252);
        await remote(page, 412);
        await remote(page, 417);
        assert.deepEqual(await commands(page), ["setPaused true", "setPaused false", "togglePause", "seekBy -10", "seekBy 10"]);
        await page.evaluate(() => { window.player.commands.length = 0; });
        await remote(page, DOWN);
        assert.equal(await focused(page), "keep-watching");
        await show(page, view);
        assert.equal(await focused(page), "keep-watching");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["keepWatching"]);
        await remote(page, DOWN);
        assert.equal(await focused(page), "back");
        await remote(page, DOWN);
        assert.equal(await focused(page), "deck:deck-0");
        await remote(page, RIGHT);
        await show(page, { ...playing(TRACKS), upNext: { next: candidate, deck: cards.map(card => ({ ...card, fileId: "new-file" })), countdown: 20, status: "Up Next" } });
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["keepWatching", "playNext deck-1 new-file"]);
        await remote(page, BACK);
        assert.equal((await commands(page)).at(-1), "keepWatching");
    } finally { await page.close(); }
});

test("Subtitles stays hidden without tracks or actionable sources like Apple TV", async () => {
    const { page } = await open();
    try {
        await show(page, playing({ ...NO_TRACKS, seriesSubtitle: { busy: false, message: "" } }));
        await openAudio(page);
        await nextTab(page, 1);
        assert.equal(await page.getByRole("button", { name: "Keep subtitles off for this series", exact: true }).isVisible(), false);
    } finally { await page.close(); }
});

test("Up Next captions stay inside the video preview and restore their full size", async () => {
    const { page } = await open();
    try {
        const view = { ...playing(TRACKS), captions: { text: "Dialogue", appearance: DEFAULT_APPEARANCE } };
        const full = async () => page.locator(".player-captions span").boundingBox();
        await show(page, view);
        const original = await full();
        await show(page, { ...view, upNext: { next: undefined, deck: [], countdown: undefined, status: "Up Next" } });
        const preview = await full();
        assert.ok(original !== null && preview !== null);
        assert.ok(preview.x >= 180 && preview.x + preview.width <= 940);
        assert.ok(preview.y >= 112 && preview.y + preview.height <= 540);
        assert.ok(Math.abs(preview.height / original.height - 760 / 1920) < 0.01);
        await show(page, view);
        assert.deepEqual(await full(), original);
    } finally { await page.close(); }
});

test("sans-serif captions use the bundled semibold face and leave other families unchanged", async () => {
    const { page } = await open();
    try {
        const face = (): Promise<{ family: string; weight: string }> => page.locator(".player-captions span").evaluate(node => {
            const style = getComputedStyle(node);
            return { family: style.fontFamily.replaceAll('"', ""), weight: style.fontWeight };
        });
        const showFace = async (fontFamily: string): Promise<{ family: string; weight: string }> => {
            await show(page, { ...playing(TRACKS), captions: { text: "Dialogue", appearance: { ...DEFAULT_APPEARANCE, fontFamily } } });
            return face();
        };
        assert.deepEqual(await showFace("sans-serif"), { family: "Inter, sans-serif", weight: "600" });
        assert.deepEqual(await showFace("serif"), { family: "serif, sans-serif", weight: "600" });
        assert.deepEqual(await showFace("monospace"), { family: "monospace, sans-serif", weight: "600" });
        assert.deepEqual(await showFace("Avenir Next"), { family: "Avenir Next, sans-serif", weight: "400" });
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

test("captions paint above the overlay gradient but below its controls and the menu", async () => {
    const { page } = await open();
    try {
        await show(page, { ...playing(TRACKS), captions: { text: "Hello", appearance: DEFAULT_APPEARANCE } });
        // Hit-testing skips pointer-events: none, so the layer opts in for this probe only.
        const stack = (): Promise<string[]> => page.evaluate(() => {
            const layer = document.querySelector<HTMLElement>(".player-captions");
            if (layer === null) throw new Error("no caption layer");
            layer.style.pointerEvents = "auto";
            const box = layer.querySelector("span")?.getBoundingClientRect();
            if (box === undefined) throw new Error("no caption text");
            const hits = document.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            layer.style.pointerEvents = "";
            return hits.map(element => element.className);
        });
        const order = await stack();
        const at = (names: readonly string[], name: string): number => names.findIndex(className => className.split(" ").includes(name));
        // Old overlap was the transport row on the full-height overlay. The clock row is the control over the default caption now.
        assert.ok(at(order, "player-transport") !== -1 && at(order, "player-transport") < at(order, "player-captions"), order.join(" > "));
        assert.ok(at(order, "player-overlay") !== -1 && at(order, "player-captions") < at(order, "player-overlay"), order.join(" > "));
        // Old path was Down, which opened the panel. Options opens it now.
        await openPanel(page);
        const menu = await page.evaluate(() => {
            const panel = document.querySelector(".player-menu");
            if (panel === null) throw new Error("no panel");
            const box = panel.getBoundingClientRect();
            return document.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2).map(element => element.className);
        });
        assert.ok(at(menu, "player-menu") !== -1 && (at(menu, "player-captions") === -1 || at(menu, "player-menu") < at(menu, "player-captions")), menu.join(" > "));
    } finally { await page.close(); }
});

test("series subtitle save stays focused while its write is pending", async () => {
    const { page } = await open();
    try {
        await show(page, playing({ ...TRACKS, seriesSubtitle: { busy: false, message: "" } }));
        // Old path was Down then Right, from an Audio panel. Info is the first tab now.
        await openAudio(page);
        await nextTab(page, 1);
        for (let index = 0; index < TRACKS.subtitles.length + 1; index++) await remote(page, DOWN);
        assert.equal(await focused(page), "series-subtitles");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["saveSeriesSubtitle"]);
        await show(page, playing({ ...TRACKS, seriesSubtitle: { busy: true, message: "Saving…" } }));
        assert.equal(await focused(page), "series-subtitles");
    } finally { await page.close(); }
});

test("AI language, quota and result actions stay remote-reachable without stopping playback", async () => {
    const { page } = await open();
    const ai = { available: { translate: true, transcribe: true }, languages: ["fr"], quota: { limited: true, remaining: 0, period: "month" }, busy: false, message: "AI subtitles are ready to select.", results: [{ id: "opaque-result", label: "AI-translated · FR" }] };
    try {
        await show(page, playing({ ...TRACKS, ai, aiTranslate: true }));
        // Old path was Down then Right, from an Audio panel. Info is the first tab now.
        await openAudio(page);
        await nextTab(page, 1);
        // AI actions sit in OPTIONS; AI results are tracks.
        await remote(page, RIGHT);
        assert.equal(await focused(page), "ai-translate");
        await remote(page, ENTER);
        await remote(page, DOWN);
        assert.equal(await focused(page), "ai-language:fr");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["startSubtitleAI translate fr"]);
        await remote(page, RIGHT);
        await remote(page, DOWN);
        assert.equal(await focused(page), "ai-transcribe");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["startSubtitleAI translate fr"], "exhausted quota does not dispatch transcription");
        assert.match(await page.locator(".player-menu-status").innerText(), /Quota exhausted/);
        await remote(page, LEFT);
        assert.equal(await focused(page), "file:42:subtitle:0", "Left lands on the track row level with the focused option");
        for (let index = 0; index < TRACKS.subtitles.length; index++) await remote(page, DOWN);
        assert.equal(await focused(page), "ai-result:opaque-result");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["startSubtitleAI translate fr", "selectAIResult opaque-result"]);
    } finally { await page.close(); }
});

test("translate-only AI shows no transcription quota line", async () => {
    const { page } = await open();
    const ai = { available: { translate: true, transcribe: false }, languages: ["fr"], quota: undefined, busy: false, message: "", results: [] };
    try {
        await show(page, playing({ ...TRACKS, ai, aiTranslate: true }));
        // Old path was Down, which opened the panel.
        await openPanel(page);
        assert.doesNotMatch(await page.locator(".player-menu-status").innerText(), /Transcription quota/);
    } finally { await page.close(); }
});
const text = (page: Page, selector: string): Promise<string> => page.locator(selector).innerText();

const INTRO = { kind: "intro" as const, startSeconds: 20, endSeconds: 60 };
const RECAP = { kind: "recap" as const, startSeconds: 0, endSeconds: 15 };
const CREDITS = { kind: "credits" as const, startSeconds: 7000, endSeconds: 7200 };
const inMarker = (skipMarker: SkipMarker, positionSeconds: number): Extract<PlaybackView, { phase: "playing" | "paused" }> => ({ ...playing(TRACKS), positionSeconds, skipMarker });
const pill = (page: Page): Promise<string | null> => page.locator(".player-skip").isVisible().then(visible => visible ? page.locator(".player-skip-label").innerText() : null);
const metrics = (page: Page): Promise<{ width: number; height: number; right: number; bottom: number; background: string; font: string }> => page.locator(".player-skip").evaluate(node => {
    const box = (node as HTMLElement).offsetParent?.getBoundingClientRect() ?? new DOMRect();
    const style = getComputedStyle(node);
    return { width: (node as HTMLElement).offsetWidth, height: (node as HTMLElement).offsetHeight, right: box.right - ((node as HTMLElement).offsetLeft + (node as HTMLElement).offsetWidth), bottom: box.bottom - ((node as HTMLElement).offsetTop + (node as HTMLElement).offsetHeight), background: style.backgroundColor, font: `${style.fontSize}/${style.fontWeight}` };
});

test("the skip pill says what Apple TV says for an intro, a recap and credits, with no countdown", async () => {
    const { page, logs } = await open();
    try {
        await show(page, inMarker(INTRO, 25));
        assert.equal(await pill(page), "Skip Intro");
        assert.equal(await page.locator(".player-skip").getAttribute("aria-label"), "Skip Intro");
        await show(page, inMarker(RECAP, 5));
        assert.equal(await pill(page), "Skip Recap");
        assert.equal(await page.locator(".player-skip svg").count(), 1, "recap and credits carry the forward-end icon");
        await show(page, inMarker(CREDITS, 7010));
        assert.equal(await pill(page), "Skip Credits");
        await show(page, playing(TRACKS));
        assert.equal(await pill(page), null);
        assert.deepEqual(logs, []);
    } finally { await page.close(); }
});

test("the Skip Intro offer lasts five seconds, does not return inside the same intro and comes back after leaving it", async () => {
    const { page } = await open();
    try {
        await show(page, inMarker(INTRO, 25));
        await page.clock.runFor(4900);
        await show(page, inMarker(INTRO, 29.9));
        assert.equal(await pill(page), "Skip Intro");
        await page.clock.runFor(100);
        assert.equal(await pill(page), null, "the timer alone takes it down");
        await show(page, inMarker(INTRO, 40));
        assert.equal(await pill(page), null, "timing out does not re-offer on the spot");
        await show(page, playing(TRACKS));
        await show(page, inMarker(INTRO, 21));
        assert.equal(await pill(page), "Skip Intro", "re-entering the intro offers it with a full timer");
        await page.clock.runFor(4900);
        assert.equal(await pill(page), "Skip Intro");
    } finally { await page.close(); }
});

test("the Skip Intro timer waits for playback, freezes on pause and rides out a short stall", async () => {
    const { page } = await open();
    try {
        const paused: PlaybackView = { ...inMarker(INTRO, 25), phase: "paused" };
        await show(page, paused);
        await page.clock.runFor(8000);
        assert.equal(await pill(page), null, "nothing is offered while the player is not playing");
        await show(page, inMarker(INTRO, 25));
        await page.clock.runFor(3000);
        await show(page, { ...inMarker(INTRO, 28), phase: "paused" });
        await page.clock.runFor(20000);
        assert.equal(await pill(page), "Skip Intro", "a pause freezes the timer");
        await show(page, inMarker(INTRO, 28));
        await page.clock.runFor(1900);
        assert.equal(await pill(page), "Skip Intro");
        await page.clock.runFor(100);
        assert.equal(await pill(page), null, "two seconds were left");
        await show(page, playing(TRACKS));
        await show(page, inMarker(INTRO, 21));
        await page.clock.runFor(1000);
        await show(page, { ...inMarker(INTRO, 22), buffering: true });
        await page.clock.runFor(1000);
        await show(page, inMarker(INTRO, 22));
        await page.clock.runFor(2900);
        assert.equal(await pill(page), "Skip Intro", "a stall shorter than 1.5 s leaves the deadline where it was");
        await page.clock.runFor(100);
        assert.equal(await pill(page), null);
        await show(page, playing(TRACKS));
        await show(page, inMarker(INTRO, 21));
        await page.clock.runFor(1000);
        await show(page, { ...inMarker(INTRO, 22), buffering: true });
        await page.clock.runFor(8000);
        assert.equal(await pill(page), "Skip Intro", "a longer stall freezes the timer at what it had left");
        await show(page, inMarker(INTRO, 22));
        await page.clock.runFor(3900);
        assert.equal(await pill(page), "Skip Intro");
        await page.clock.runFor(100);
        assert.equal(await pill(page), null);
    } finally { await page.close(); }
});

test("Skip Recap and Skip Credits stay up for the whole marker window and go when it ends", async () => {
    const { page } = await open();
    try {
        for (const [marker, label, inside, outside] of [[RECAP, "Skip Recap", 5, 15], [CREDITS, "Skip Credits", 7010, 7200]] as const) {
            await show(page, inMarker(marker, inside));
            await page.clock.runFor(60000);
            await show(page, inMarker(marker, inside + 1));
            assert.equal(await pill(page), label);
            assert.equal(await page.locator(".player-skip-track").isVisible(), false, "only Skip Intro and Watch Intro draw the creeping fill");
            await show(page, playing({ ...TRACKS }));
            await show(page, { ...playing(TRACKS), positionSeconds: outside });
            assert.equal(await pill(page), null);
        }
        await show(page, { phase: "loading", title: "The Movie" });
        assert.equal(await pill(page), null, "never while loading");
    } finally { await page.close(); }
});

test("Select on Skip Intro seeks to the end of the intro and the intro is not offered again", async () => {
    const { page } = await open();
    try {
        await show(page, inMarker(INTRO, 25));
        assert.equal(await focused(page), "skip");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["seekToSeconds 60"]);
        await show(page, inMarker(INTRO, 26));
        assert.equal(await pill(page), null, "a decided intro stays decided after scrubbing back into it");
        assert.equal(await focused(page), "position");
        // With the pill gone Select is the scrubber's again: it enters timeline scrub and pauses.
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["seekToSeconds 60", "setPaused true"]);
    } finally { await page.close(); }
});

test("Back takes the Skip Intro pill down without moving playback, and the next Back behaves normally", async () => {
    const { page } = await open();
    try {
        await show(page, inMarker(INTRO, 25));
        await remote(page, BACK);
        assert.equal(await pill(page), null);
        assert.deepEqual(await commands(page), []);
        await show(page, inMarker(INTRO, 26));
        assert.equal(await pill(page), null, "Back decided the intro");
        assert.equal(await focused(page), "position");
        await remote(page, BACK);
        assert.deepEqual(await commands(page), ["back"]);
    } finally { await page.close(); }
});

test("after an automatic skip the pill reads Intro skipped over Watch Intro and Select returns to the intro start", async () => {
    const { page } = await open();
    try {
        await show(page, { ...playing(TRACKS), positionSeconds: 61, undoSkipSeconds: 20 });
        assert.equal(await pill(page), "Watch Intro");
        assert.equal(await text(page, ".player-skip-caption"), "Intro skipped");
        assert.equal(await page.locator(".player-skip").getAttribute("aria-label"), "Intro skipped. Watch Intro");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["seekToSeconds 20"]);
        await show(page, { ...playing(TRACKS), positionSeconds: 21 });
        assert.equal(await pill(page), null);
        await show(page, { ...playing(TRACKS), positionSeconds: 61, undoSkipSeconds: 21 });
        await remote(page, BACK);
        assert.equal(await pill(page), null, "Back dismisses the undo without seeking");
        assert.deepEqual(await commands(page), ["seekToSeconds 20"]);
    } finally { await page.close(); }
});

test("the Intro skipped caption sits outside the pill, so the focused pill's scale leaves it alone", async () => {
    const { page } = await open();
    try {
        await page.addStyleTag({ content: ".player-skip, .player-skip-caption { transition: none !important; }" });
        await show(page, { ...playing(TRACKS), positionSeconds: 61, undoSkipSeconds: 20 });
        assert.equal(await page.locator(".player-skip .player-skip-caption").count(), 0);
        const gap = (): Promise<{ gap: number; right: number; scale: string }> => page.evaluate(() => {
            const pillNode = document.querySelector<HTMLElement>(".player-skip")!;
            const captionNode = document.querySelector<HTMLElement>(".player-skip-caption")!;
            const caption = captionNode.getBoundingClientRect();
            return { gap: pillNode.offsetTop - caption.bottom, right: 1920 - caption.right, scale: getComputedStyle(captionNode).transform };
        });
        // Apple: VStack spacing 10 above the pill, trailing padding 24 inside the 160 px inset.
        assert.deepEqual(await gap(), { gap: 10, right: 184, scale: "none" });
        await page.clock.runFor(10000);
        await show(page, { ...playing(TRACKS), positionSeconds: 62, undoSkipSeconds: 21 });
        assert.equal(await page.locator(".player-skip").evaluate(node => node.classList.contains("player-skip-lit")), true);
        assert.deepEqual(await gap(), { gap: 10, right: 184, scale: "none" });
        await remote(page, BACK);
        assert.equal(await pill(page), null);
        assert.equal(await page.locator(".player-skip-caption").isVisible(), false, "the caption goes with the pill");
    } finally { await page.close(); }
});

test("the Watch Intro pill draws the creeping fill and restarts it from empty for each undo window", async () => {
    const { page } = await open();
    try {
        const elapsed = (): Promise<number> => page.locator(".player-skip-fill").evaluate(node => Number(node.getAnimations()[0]?.currentTime ?? -1));
        await show(page, { ...playing(TRACKS), positionSeconds: 61, undoSkipSeconds: 20 });
        assert.equal(await page.locator(".player-skip-track").isVisible(), true, "Apple draws PlayerPillProgress for the undo pill too");
        await page.locator(".player-skip-fill").evaluate(node => { node.getAnimations()[0]!.currentTime = 3000; });
        assert.ok(await elapsed() >= 3000, "the fill is running");
        await show(page, { ...playing(TRACKS), positionSeconds: 62, undoSkipSeconds: 20 });
        assert.ok(await elapsed() >= 3000, "a redraw inside the same window does not restart the fill");
        await show(page, { ...playing(TRACKS), positionSeconds: 70 });
        await show(page, { ...playing(TRACKS), positionSeconds: 71, undoSkipSeconds: 21 });
        assert.ok(await elapsed() < 1000, "a new window starts from empty");
    } finally { await page.close(); }
});

test("the Watch Intro pill runs Skip Intro's timer: five seconds, frozen by a pause, a short stall rides out", async () => {
    const { page } = await open();
    try {
        const undo = (seconds: number, extra: Partial<Extract<PlaybackView, { phase: "playing" | "paused" }>> = {}): Extract<PlaybackView, { phase: "playing" | "paused" }> => ({ ...playing(TRACKS), positionSeconds: 61, undoSkipSeconds: seconds, ...extra });
        // The fill's own progress, which counts the negative delay the restart seeds it with.
        const elapsed = (): Promise<number> => page.locator(".player-skip-fill").evaluate(node => (node.getAnimations()[0]?.effect?.getComputedTiming().progress ?? -1) * 5000);
        await show(page, undo(20));
        await page.clock.runFor(3000);
        await show(page, { ...undo(20), phase: "paused" });
        await page.clock.runFor(20000);
        assert.equal(await pill(page), "Watch Intro", "a pause freezes the window");
        assert.equal(await page.locator(".player-skip-fill").evaluate(node => node.getAnimations()[0]?.playState), "paused", "and the fill with it");
        const frozen = await elapsed();
        assert.ok(frozen >= 2900 && frozen <= 3100, `the fill stops where the timer stopped, was ${frozen}`);
        await show(page, undo(20));
        await page.clock.runFor(1900);
        assert.equal(await pill(page), "Watch Intro");
        await page.clock.runFor(100);
        assert.equal(await pill(page), null, "two seconds were left");
        await show(page, { ...undo(20), positionSeconds: 62 });
        assert.equal(await pill(page), null, "the controller still holds the offer, but the window is over");
        await show(page, undo(21));
        await page.clock.runFor(1000);
        await show(page, undo(21, { buffering: true }));
        await page.clock.runFor(1000);
        await show(page, undo(21));
        await page.clock.runFor(2900);
        assert.equal(await pill(page), "Watch Intro", "a stall shorter than 1.5 s leaves the deadline where it was");
        await page.clock.runFor(100);
        assert.equal(await pill(page), null);
        await show(page, undo(22));
        await page.clock.runFor(1000);
        await show(page, undo(22, { buffering: true }));
        await page.clock.runFor(8000);
        assert.equal(await pill(page), "Watch Intro", "a longer stall freezes the window at what it had left");
    } finally { await page.close(); }
});

test("a Watch Intro window that ran out or was dismissed does not return after a loading view", async () => {
    const { page } = await open();
    try {
        const undo = (seconds: number): PlaybackView => ({ ...playing(TRACKS), positionSeconds: 61, undoSkipSeconds: seconds });
        await show(page, undo(20));
        await page.clock.runFor(5000);
        assert.equal(await pill(page), null);
        // A re-anchoring seek or a replan shows loading without detail; the controller still holds the offer afterwards.
        await show(page, { phase: "loading", title: "The Movie" });
        await show(page, undo(20));
        assert.equal(await pill(page), null, "the timed-out window stays decided");
        await show(page, undo(21));
        await remote(page, BACK);
        assert.equal(await pill(page), null);
        await show(page, { phase: "loading", title: "The Movie" });
        await show(page, undo(21));
        assert.equal(await pill(page), null, "so does a dismissed one");
    } finally { await page.close(); }
});

test("the next part of a Shuffle pick offers Skip Intro again at the same offset after the last part's was dismissed", async () => {
    const { page } = await open();
    try {
        await show(page, inMarker(INTRO, 25));
        assert.equal(await pill(page), "Skip Intro");
        await remote(page, BACK);
        assert.equal(await pill(page), null);
        await show(page, { phase: "loading", title: "The Movie", nextPart: true });
        await show(page, { phase: "loading", title: "The Movie" });
        await show(page, inMarker(INTRO, 25));
        assert.equal(await pill(page), "Skip Intro");
    } finally { await page.close(); }
});

test("a loading view freezes the Skip Intro and Watch Intro timers instead of running them down", async () => {
    const { page } = await open();
    try {
        for (const [view, label] of [[inMarker(INTRO, 25), "Skip Intro"], [{ ...playing(TRACKS), positionSeconds: 61, undoSkipSeconds: 20 } as PlaybackView, "Watch Intro"]] as const) {
            await show(page, view);
            await page.clock.runFor(1000);
            await show(page, { phase: "loading", title: "The Movie" });
            await page.clock.runFor(20000);
            await show(page, view);
            assert.equal(await pill(page), label, "a long reconnect does not use up the offer");
            await page.clock.runFor(3900);
            assert.equal(await pill(page), label);
            await page.clock.runFor(100);
            assert.equal(await pill(page), null, "the four seconds it had left");
            await show(page, playing(TRACKS));
        }
    } finally { await page.close(); }
});

test("a loading view shorter than the grace leaves the Skip Intro fill and expiry where the timer stands", async () => {
    const { page } = await open();
    try {
        const progress = (): Promise<number> => page.locator(".player-skip-fill").evaluate(node => node.getAnimations()[0]?.effect?.getComputedTiming().progress ?? -1);
        for (const [view, label] of [[inMarker(INTRO, 25), "Skip Intro"], [{ ...playing(TRACKS), positionSeconds: 61, undoSkipSeconds: 20 } as PlaybackView, "Watch Intro"]] as const) {
            await show(page, view);
            await page.clock.runFor(3000);
            await show(page, { phase: "loading", title: "The Movie" });
            await page.clock.runFor(1000);
            await show(page, view);
            assert.equal(await pill(page), label);
            const drawn = await progress();
            assert.ok(drawn >= 0.8 && drawn <= 1, `the fill shows the four elapsed seconds, not a restart (${drawn})`);
            // CSS animations run on real time, so the fill's start offset is what pins it to the fake-clock timer: 4 s in, 1 s to go.
            assert.equal(await page.locator(".player-skip-fill").evaluate(node => (node as HTMLElement).style.animationDelay), "-4000ms");
            await page.clock.runFor(900);
            assert.equal(await pill(page), label, "still up at 4.9 s");
            await page.clock.runFor(100);
            assert.equal(await pill(page), null, "gone at 5 s in total");
            await show(page, playing(TRACKS));
        }
    } finally { await page.close(); }
});

test("Skip Intro, Skip Recap and Watch Intro stay drawn and enabled over the options panel, at the hidden-controls offset, with focus kept in the panel", async () => {
    const { page } = await open();
    try {
        await page.addStyleTag({ content: ".player-skip, .player-skip-caption { transition: none !important; }" });
        const undo: PlaybackView = { ...playing(TRACKS), positionSeconds: 61, undoSkipSeconds: 20 };
        for (const [view, label] of [[inMarker(INTRO, 25), "Skip Intro"], [inMarker(RECAP, 5), "Skip Recap"], [undo, "Watch Intro"]] as const) {
            await show(page, view);
            assert.equal(await page.locator(".player-skip").isDisabled(), false, `${label} is an ordinary button with the transport up`);
            await openPanel(page);
            assert.equal(await page.locator(".player-hud").isVisible(), true);
            assert.equal(await pill(page), label, "still drawn over the panel");
            assert.equal(await page.locator(".player-skip").isDisabled(), false, "and enabled, as Apple's HUD leaves it");
            assert.equal((await metrics(page)).bottom, 156, "at Apple's HUD-up offset");
            const overlap = await page.evaluate(() => {
                const a = document.querySelector<HTMLElement>(".player-skip")!.getBoundingClientRect();
                const b = document.querySelector<HTMLElement>(".player-hud")!.getBoundingClientRect();
                return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
            });
            assert.equal(overlap, false, "the pill and the panel never overlap, so no stacking order is needed");
            for (const key of [UP, DOWN, LEFT, RIGHT]) {
                await remote(page, key);
                assert.notEqual(await focused(page), "skip", "the panel keeps the D-pad");
                assert.equal(await page.evaluate(() => document.activeElement !== document.body && document.querySelector(".player-hud")!.contains(document.activeElement)), true, "focus stays in the panel");
            }
            await remote(page, BACK);
            assert.equal(await page.locator(".player-hud").isVisible(), false);
            assert.equal(await pill(page), label);
            assert.equal(await page.locator(".player-skip").isDisabled(), false);
            assert.equal((await metrics(page)).bottom, label === "Skip Recap" ? 216 : 460);
            await show(page, playing(TRACKS));
        }
        assert.deepEqual(await commands(page), []);
    } finally { await page.close(); }
});

test("the Skip Intro timer keeps running while the options panel is open", async () => {
    const { page } = await open();
    try {
        await show(page, inMarker(INTRO, 25));
        await openPanel(page);
        await page.clock.runFor(4900);
        assert.equal(await pill(page), "Skip Intro", "still showing at 4.9 s with the panel open");
        await page.clock.runFor(100);
        assert.equal(await pill(page), null, "gone at 5 s: Apple keeps the timer running while the HUD is up");
    } finally { await page.close(); }
});

test("pills stay drawn and enabled during a seek preview, and Up reaches them while Select on the scrubber still seeks", async () => {
    const { page } = await open();
    try {
        for (const [view, label, skipTarget] of [[inMarker(INTRO, 25), "Skip Intro", 60], [inMarker(RECAP, 5), "Skip Recap", 15], [{ ...playing(TRACKS), positionSeconds: 61, undoSkipSeconds: 20 } as PlaybackView, "Watch Intro", 20]] as const) {
            await show(page, view);
            await remote(page, DOWN);
            await remote(page, UP);
            assert.equal(await focused(page), "position");
            await remote(page, RIGHT);
            assert.equal(await pill(page), label, "still drawn during the preview");
            assert.equal(await page.locator(".player-skip").isDisabled(), false, "and enabled: Apple only disables them in a timeline scrub");
            await remote(page, ENTER);
            const sent = await commands(page);
            assert.equal(sent.length, 1, "Select on the scrubber commits the preview seek");
            assert.notEqual(sent[0], `seekToSeconds ${skipTarget}`, "and does not press the pill");
            await page.evaluate(() => { window.player.commands.length = 0; });
            await show(page, playing(TRACKS));
        }
    } finally { await page.close(); }
});

test("Select on Skip Intro reached from a seek preview skips and drops the preview's pending seek", async () => {
    const { page } = await open();
    try {
        await show(page, inMarker(INTRO, 25));
        await remote(page, DOWN);
        await remote(page, UP);
        await remote(page, RIGHT);
        await remote(page, UP);
        assert.equal(await focused(page), "skip");
        await remote(page, ENTER);
        await page.clock.runFor(5000);
        assert.deepEqual(await commands(page), ["seekToSeconds 60"], "the debounced preview seek never lands after the skip");
    } finally { await page.close(); }
});

test("a skip pressed while an earlier seek is still pending shows the skip's position, not the stale target", async () => {
    const { page } = await open();
    try {
        await show(page, inMarker(INTRO, 25));
        await remote(page, DOWN);
        await remote(page, UP);
        await remote(page, RIGHT);
        await page.clock.runFor(300);
        assert.equal((await commands(page)).length, 1, "the tapped seek is in flight; the view has not caught up");
        await remote(page, UP);
        assert.equal(await focused(page), "skip");
        await remote(page, ENTER);
        assert.equal((await commands(page)).at(-1), "seekToSeconds 60");
        assert.equal(await page.locator(".player-time-elapsed").innerText(), "1:00");
    } finally { await page.close(); }
});

test("clicking a pill with the options panel open skips without taking focus from the panel", async () => {
    const { page } = await open();
    try {
        await show(page, inMarker(RECAP, 5));
        await openPanel(page);
        const inPanel = (): Promise<boolean> => page.evaluate(() => document.querySelector(".player-hud")!.contains(document.activeElement));
        assert.equal(await inPanel(), true);
        await page.locator(".player-skip").click();
        assert.deepEqual(await commands(page), ["seekToSeconds 15"]);
        assert.equal(await inPanel(), true, "the next Select operates the panel, not the pill again");
        assert.equal(await page.locator(".player-hud").isVisible(), true);
    } finally { await page.close(); }
});

test("pills are disabled, and focus never lands on them, during a timeline scrub", async () => {
    const { page } = await open();
    try {
        for (const [view, label] of [[inMarker(INTRO, 25), "Skip Intro"], [inMarker(RECAP, 5), "Skip Recap"], [{ ...playing(TRACKS), positionSeconds: 61, undoSkipSeconds: 20 } as PlaybackView, "Watch Intro"]] as const) {
            await show(page, view);
            await remote(page, DOWN);
            await remote(page, UP);
            assert.equal(await focused(page), "position");
            await remote(page, ENTER);
            assert.equal(await pill(page), label, "still drawn during the scrub");
            assert.equal(await page.locator(".player-skip").isDisabled(), true);
            await remote(page, UP);
            assert.equal(await focused(page), "position", "an upward drift cannot land on the disabled pill");
            await remote(page, BACK);
            assert.equal(await page.locator(".player-skip").isDisabled(), false, "the scrub ending hands the pill back");
            await page.evaluate(() => { window.player.commands.length = 0; });
            await show(page, playing(TRACKS));
        }
    } finally { await page.close(); }
});

test("exiting the player while Skip Intro shows leaves no timer to render the removed screen", async () => {
    const { page, logs } = await open();
    try {
        await show(page, inMarker(INTRO, 25));
        assert.equal(await pill(page), "Skip Intro");
        await page.evaluate(() => {
            const calls: number[] = [];
            (window as unknown as { focusCalls: number[] }).focusCalls = calls;
            const original = HTMLElement.prototype.focus;
            HTMLElement.prototype.focus = function (this: HTMLElement, ...args: Parameters<typeof original>) { calls.push(1); original.apply(this, args); };
            window.player.destroy();
        });
        await page.clock.runFor(10000);
        assert.equal(await page.evaluate(() => (window as unknown as { focusCalls: number[] }).focusCalls.length), 0, "no render after destroy");
        assert.deepEqual(logs, []);
    } finally { await page.close(); }
});

test("Back on Skip Recap and Skip Credits is the player's normal Back, as on Apple TV", async () => {
    const { page } = await open();
    try {
        for (const [marker, position] of [[RECAP, 5], [CREDITS, 7010]] as const) {
            await page.evaluate(() => { window.player.commands.length = 0; });
            await show(page, inMarker(marker, position));
            await remote(page, UP);
            assert.equal(await focused(page), "skip");
            await remote(page, BACK);
            assert.deepEqual(await commands(page), ["back"]);
            await show(page, playing(TRACKS));
        }
    } finally { await page.close(); }
});

test("the skip pills sit where Apple TV draws them: bottom right, above the transport while the controls show", async () => {
    const { page } = await open();
    try {
        // Measure where the pill settles, not mid-slide.
        await page.addStyleTag({ content: ".player-skip { transition: none !important; }" });
        await show(page, inMarker(INTRO, 25));
        // The label sets this pill's width, and Inter loads on first use: read once, after it has, and leave the width out.
        await page.evaluate(() => document.fonts.ready);
        // tvOS padding plus the 80 px side and 60 px top and bottom safe area.
        const { width: _labelWidth, ...intro } = await metrics(page);
        assert.deepEqual(intro, { height: 72, right: 160, bottom: 460, background: "rgba(0, 0, 0, 0.65)", font: "28px/600" });
        await show(page, playing(TRACKS));
        await show(page, inMarker(RECAP, 5));
        // 220 px label frame plus 20 px of padding a side (TVPillButtonStyle .compact).
        assert.deepEqual(await metrics(page), { width: 260, height: 76, right: 160, bottom: 216, background: "rgba(255, 255, 255, 0.1)", font: "26px/600" });
        // Focused it takes 70 px a side, so it grows leftward to 360 px.
        await remote(page, UP);
        await remote(page, UP);
        assert.equal(await focused(page), "skip");
        assert.deepEqual({ width: (await metrics(page)).width, right: (await metrics(page)).right }, { width: 360, right: 160 });
        // With the controls hidden both pills drop to the corner.
        await page.clock.runFor(10000);
        await show(page, inMarker(RECAP, 6));
        assert.equal((await metrics(page)).bottom, 156);
        assert.equal((await metrics(page)).width, 360, "lit as the Select target");
        await show(page, playing(TRACKS));
        await show(page, inMarker(INTRO, 25));
        assert.equal(await page.locator(".player-overlay").evaluate(node => node.classList.contains("player-overlay-hidden")), true);
        assert.equal((await metrics(page)).bottom, 156);
        assert.equal(await page.locator(".player-skip").evaluate(node => node.classList.contains("player-skip-lit")), true, "drawn lit as the Select target while the controls are hidden");
    } finally { await page.close(); }
});

test("Select activates a late Skip prompt while controls are hidden", async () => {
    const { page } = await open();
    try {
        await show(page, playing(TRACKS));
        await page.clock.runFor(6000);
        await show(page, inMarker(INTRO, 25));
        assert.equal(await focused(page), "position");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["seekToSeconds 60"]);
    } finally { await page.close(); }
});

test("Skip Intro takes first focus, Down hands focus to the transport and Up returns to the pill", async () => {
    const { page, logs } = await open();
    try {
        await show(page, inMarker(INTRO, 25));
        assert.equal(await focused(page), "skip");
        await remote(page, UP);
        assert.equal(await focused(page), "skip");
        await remote(page, DOWN);
        assert.equal(await focused(page), "pause");
        await remote(page, UP);
        assert.equal(await focused(page), "position");
        await remote(page, UP);
        assert.equal(await focused(page), "skip");
        await remote(page, 415);
        assert.deepEqual(await commands(page), ["seekToSeconds 60"]);
        await show(page, playing(TRACKS));
        assert.equal(await focused(page), "position");
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
        // Old Down opened the panel. Options does that now.
        await openPanel(page);
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
        // Old focus was "player". Cancelling a preview stays on the scrubber.
        assert.equal(await focused(page), "position", "discarding the preview restores the playback surface");
        assert.deepEqual(await commands(page), [command], "discarded preview never commits an absolute seek");
        await show(page, playing(TRACKS));
        await page.clock.fastForward(5000);
        await show(page, { ...playing(TRACKS), positionSeconds: 760 });
        assert.equal(await page.locator(".player-overlay").getAttribute("class"), "player-overlay player-overlay-hidden");
        await remote(page, RIGHT);
        await remote(page, BACK);
        // Old Up from the scrubber focused Pause. Down does that now.
        await remote(page, DOWN);
        await remote(page, code);
        assert.equal(await focused(page), "pause", "a media key without an active preview retains an explicitly focused control");
        assert.deepEqual(logs, []);
    } finally { await page.close(); }
});

const press = (page: Page, keyCode: number): Promise<void> => page.evaluate((code) => {
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { keyCode: code, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { keyCode: code, bubbles: true, cancelable: true }));
}, keyCode);

test("skip taps accumulate while the previous seek callback is pending", async () => {
    const { page } = await open();
    try {
        await show(page, { ...playing(TRACKS), previewKey: "ready" });
        await press(page, RIGHT);
        await page.clock.fastForward(200);
        await press(page, RIGHT);
        await page.clock.fastForward(200);
        assert.deepEqual(await commands(page), ["seekToSeconds 764", "seekToSeconds 774"]);
        await show(page, { ...playing(TRACKS), positionSeconds: 774, previewKey: "ready" });
        await press(page, RIGHT);
        await page.clock.fastForward(200);
        assert.deepEqual((await commands(page)).slice(-1), ["seekToSeconds 784"]);
    } finally { await page.close(); }
});

for (const landing of ["same-plan", "replacement-plan"] as const) test(`a scrub opened during a skip survives only a ${landing} landing`, async () => {
    const { page } = await open();
    try {
        await show(page, { ...playing(TRACKS), previewKey: "same-plan" });
        await press(page, RIGHT);
        await page.clock.fastForward(200);
        await show(page, { ...playing(TRACKS), previewKey: undefined });
        await press(page, ENTER);
        await show(page, { ...playing(TRACKS), phase: "paused", previewKey: undefined, resumePending: false });
        await press(page, RIGHT);
        await press(page, RIGHT);
        assert.equal(await page.getByRole("slider").getAttribute("aria-valuenow"), "774");
        await show(page, { ...playing(TRACKS), phase: "paused", positionSeconds: 764, previewKey: landing, resumePending: false });
        assert.equal(await page.getByRole("slider").getAttribute("aria-valuenow"), landing === "same-plan" ? "774" : "764");
        assert.equal(await page.locator(".player-bar-preview").count(), landing === "same-plan" ? 1 : 0);
        await press(page, ENTER);
        assert.deepEqual(await commands(page), ["seekToSeconds 764", "setPaused true", ...(landing === "same-plan" ? ["seekToSeconds 774", "setPaused false"] : [])]);
    } finally { await page.close(); }
});

for (const landing of ["same-plan", "replacement-plan"] as const) test(`a debounced skip survives only a ${landing} landing`, async () => {
    const { page } = await open();
    try {
        await show(page, { ...playing(TRACKS), positionSeconds: 22.5, previewKey: "same-plan" });
        await show(page, { ...playing(TRACKS), positionSeconds: 22.5, previewKey: undefined });
        await press(page, RIGHT);
        assert.equal(await page.getByRole("slider").getAttribute("aria-valuenow"), "32.5");
        await show(page, { ...playing(TRACKS), positionSeconds: 22.5, previewKey: landing });
        assert.equal(await page.getByRole("slider").getAttribute("aria-valuenow"), landing === "same-plan" ? "32.5" : "22.5");
        await page.clock.fastForward(200);
        assert.deepEqual(await commands(page), landing === "same-plan" ? ["seekToSeconds 32.5"] : []);
    } finally { await page.close(); }
});

test("reduced motion disables scrolling animation in the active track pane", async () => {
    const { page } = await open();
    try {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await show(page, playing(TRACKS));
        await openAudio(page);
        assert.equal(await page.locator(".player-menu-list.player-menu-pane-active").evaluate(el => getComputedStyle(el).scrollBehavior), "auto");
    } finally { await page.close(); }
});
const holdKey = (page: Page, keyCode: number): Promise<void> => page.evaluate((code) => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { keyCode: code, bubbles: true, cancelable: true }));
}, keyCode);

test("external playback resume drops a timeline preview and follows the playhead", async () => {
    const { page } = await open();
    try {
        await show(page, playing(TRACKS));
        await press(page, ENTER);
        await show(page, { ...playing(TRACKS), phase: "paused" });
        await holdKey(page, RIGHT);
        await page.clock.fastForward(400);
        await show(page, { ...playing(TRACKS), positionSeconds: 200 });
        assert.equal(await page.getByRole("slider").getAttribute("aria-valuenow"), "200");
        assert.equal(await page.locator(".player-bar-preview").count(), 0);
        await page.clock.fastForward(500);
        await show(page, { ...playing(TRACKS), positionSeconds: 201 });
        assert.equal(await page.getByRole("slider").getAttribute("aria-valuenow"), "201");
        assert.deepEqual(await commands(page), ["setPaused true"]);
        await page.clock.fastForward(5000);
        assert.equal(await page.locator(".player-overlay-hidden").count(), 1);
    } finally { await page.close(); }
});

for (const landing of ["same-plan", "replacement-plan"] as const) test(`a running hold survives only a ${landing} landing`, async () => {
    const { page } = await open();
    try {
        await show(page, { ...playing(TRACKS), previewKey: "same-plan" });
        await press(page, RIGHT);
        await page.clock.fastForward(200);
        await show(page, { ...playing(TRACKS), previewKey: undefined });
        await holdKey(page, RIGHT);
        await page.clock.fastForward(400);
        const held = await page.getByRole("slider").getAttribute("aria-valuenow");
        assert.notEqual(held, "754");
        await show(page, { ...playing(TRACKS), previewKey: landing });
        assert.equal(await page.getByRole("slider").getAttribute("aria-valuenow"), landing === "same-plan" ? held : "754");
        assert.equal(await page.locator(".player-bar-preview").count(), landing === "same-plan" ? 1 : 0);
        await press(page, ENTER);
        const committed = landing === "same-plan" ? ["seekToSeconds 764", `seekToSeconds ${held}`, "setPaused false"] : ["seekToSeconds 764", "setPaused true"];
        assert.deepEqual(await commands(page), committed);
    } finally { await page.close(); }
});

test("a Left or Right hold keeps active playback running", async () => {
    const { page } = await open();
    try {
        await show(page, playing(TRACKS));
        await holdKey(page, RIGHT);
        await page.clock.fastForward(400);
        assert.deepEqual(await commands(page), []);
        await show(page, { ...playing(TRACKS), positionSeconds: 760 });
        assert.equal(await page.locator(".player-bar-preview").count(), 1, "playing ticks retain a hold preview");
        await press(page, BACK);
        assert.equal(await page.getByRole("slider").getAttribute("aria-valuenow"), "760");
        assert.deepEqual(await commands(page), []);
    } finally { await page.close(); }
});

test("Select holds a pending resume and returns it on an unmoved commit", async () => {
    const { page } = await open();
    try {
        await show(page, { ...playing(TRACKS), phase: "paused", resumePending: true, transportCommandCount: 1 });
        await press(page, ENTER);
        assert.deepEqual(await commands(page), ["setPaused true"]);
        await show(page, { ...playing(TRACKS), phase: "paused", resumePending: false, transportCommandCount: 2 });
        await press(page, ENTER);
        assert.deepEqual(await commands(page), ["setPaused true", "setPaused false"]);
    } finally { await page.close(); }
});

for (const newerPause of [false, true]) test(`a hold returns a pending resume only without a newer Pause (${newerPause})`, async () => {
    const { page } = await open();
    try {
        await show(page, { ...playing(TRACKS), phase: "paused", resumePending: true, transportCommandCount: 1 });
        await holdKey(page, RIGHT);
        await page.clock.fastForward(400);
        assert.deepEqual(await commands(page), ["setPaused true"]);
        await show(page, { ...playing(TRACKS), phase: "paused", previewKey: "landed-seek", resumePending: false, transportCommandCount: newerPause ? 3 : 2 });
        await press(page, BACK);
        assert.deepEqual(await commands(page), newerPause ? ["setPaused true"] : ["setPaused true", "setPaused false"]);
    } finally { await page.close(); }
});

for (const newerPause of [false, true]) test(`a committed scrub does not send another resume when the controller lands (${newerPause})`, async () => {
    const { page } = await open();
    try {
        await show(page, { ...playing(TRACKS), phase: "paused", resumePending: true, transportCommandCount: 1 });
        await press(page, ENTER);
        await show(page, { ...playing(TRACKS), phase: "paused", resumePending: false, transportCommandCount: 2 });
        await press(page, RIGHT);
        await press(page, ENTER);
        const committed = ["setPaused true", "seekToSeconds 764", "setPaused false"];
        assert.deepEqual(await commands(page), committed, "the controller owns the committed target and intent");
        await show(page, { ...playing(TRACKS), phase: "paused", previewKey: "landed", resumePending: false, transportCommandCount: newerPause ? 3 : 2 });
        assert.deepEqual(await commands(page), committed);
    } finally { await page.close(); }
});

test("a committed automatic hold retains its exact target while the first seek lands", async () => {
    const { page } = await open();
    try {
        await show(page, { ...playing(TRACKS), phase: "paused", resumePending: true, transportCommandCount: 1 });
        await holdKey(page, RIGHT);
        await page.clock.fastForward(400);
        await show(page, { ...playing(TRACKS), phase: "paused", resumePending: false, transportCommandCount: 2 });
        const target = await page.getByRole("slider").getAttribute("aria-valuenow");
        await press(page, ENTER);
        await page.clock.fastForward(500);
        const committed = ["setPaused true", `seekToSeconds ${target}`, "setPaused false"];
        assert.deepEqual(await commands(page), committed);
        assert.equal(await page.locator(".player-rate:not([hidden])").count(), 0);
        await press(page, RIGHT);
        await show(page, { ...playing(TRACKS), phase: "paused", previewKey: "landed", transportCommandCount: 2 });
        assert.deepEqual(await commands(page), committed);
    } finally { await page.close(); }
});

for (const ending of ["back", "loading", "destroy"] as const) test(`a committed scrub sends no later input after ${ending}`, async () => {
    const { page } = await open();
    try {
        await show(page, { ...playing(TRACKS), phase: "paused", resumePending: true, transportCommandCount: 1 });
        await press(page, ENTER);
        await show(page, { ...playing(TRACKS), phase: "paused", resumePending: false, transportCommandCount: 2 });
        await press(page, RIGHT);
        await press(page, ENTER);
        if (ending === "back") await press(page, BACK);
        else if (ending === "loading") await show(page, { phase: "loading", title: "Replacement" });
        else await page.evaluate(() => window.player.destroy());
        await show(page, { ...playing(TRACKS), phase: "paused", previewKey: "landed", transportCommandCount: 2 });
        assert.deepEqual(await commands(page), ["setPaused true", "seekToSeconds 764", "setPaused false", ...(ending === "back" ? ["back"] : [])]);
    } finally { await page.close(); }
});

test("one Right in scrub mode steps the profile forward interval once", async () => {
    const { page } = await open();
    try {
        // 8:41. tvOS and the contract default the forward interval to 30, and one click steps once.
        await show(page, { ...playing(TRACKS), positionSeconds: 521, seekIntervals: { backward: 10, forward: 30 } });
        await remote(page, ENTER);
        await remote(page, RIGHT);
        assert.equal(await page.getByRole("slider").getAttribute("aria-valuenow"), "551");
        await remote(page, BACK);
        await show(page, { ...playing(TRACKS), positionSeconds: 521, seekIntervals: { backward: 10, forward: 60 } });
        await remote(page, ENTER);
        await remote(page, RIGHT);
        assert.equal(await page.getByRole("slider").getAttribute("aria-valuenow"), "581");
    } finally { await page.close(); }
});

test("skip digits match the 25pt semibold symbol", async () => {
    const { page } = await open();
    try {
        await show(page, { ...playing(TRACKS), seekIntervals: { backward: 30, forward: 30 } });
        await page.evaluate(() => document.fonts.ready);
        // SF Symbol goforward.30 at 25pt semibold has 9.25px of digit ink. The old mark used font-size 7 in this 25px icon.
        const height = await page.locator("[data-focus='forward'] text").evaluate((node) => {
            if (!(node instanceof SVGGraphicsElement) || node.ownerSVGElement === null) return 0;
            const fontSize = Number(node.getAttribute("font-size"));
            return fontSize * node.ownerSVGElement.getBoundingClientRect().height / node.ownerSVGElement.viewBox.baseVal.height;
        });
        assert.ok(Math.abs(height - 9.25) < 0.15, `digit height ${height}`);
    } finally { await page.close(); }
});

test("the scrubber steps, scrubs and seeks like the Apple TV remote", async () => {
    const { page, logs } = await open();
    try {
        await show(page, playing(TRACKS));
        await press(page, RIGHT);
        assert.equal(await page.getByRole("slider", { name: "Scrubber" }).getAttribute("aria-valuenow"), "764");
        assert.deepEqual(await commands(page), [], "the skip is visible before its 200 ms commit");
        await page.clock.fastForward(200);
        assert.deepEqual(await commands(page), ["seekToSeconds 764"]);
        await show(page, { ...playing(TRACKS), positionSeconds: 764 });

        await press(page, ENTER);
        assert.equal(await page.locator(".player-bar").getAttribute("class"), "player-bar player-bar-preview");
        assert.deepEqual(await commands(page), ["seekToSeconds 764", "setPaused true"]);
        await press(page, RIGHT);
        assert.equal(await page.getByRole("slider").getAttribute("aria-valuenow"), "774");
        assert.deepEqual(await commands(page), ["seekToSeconds 764", "setPaused true"], "timeline scrub waits for Select");
        await press(page, ENTER);
        assert.deepEqual(await commands(page), ["seekToSeconds 764", "setPaused true", "seekToSeconds 774", "setPaused false"]);

        await show(page, { ...playing(TRACKS), positionSeconds: 774 });
        await press(page, ENTER);
        await press(page, ENTER);
        assert.deepEqual(await commands(page), ["seekToSeconds 764", "setPaused true", "seekToSeconds 774", "setPaused false", "setPaused true", "setPaused false"], "Select with no movement resumes in place");

        await press(page, ENTER);
        await press(page, LEFT);
        await press(page, BACK);
        assert.equal(await page.getByRole("slider").getAttribute("aria-valuenow"), "774");
        assert.deepEqual((await commands(page)).slice(-1), ["setPaused true"], "Menu cancels a timeline scrub");

        await holdKey(page, RIGHT);
        await page.clock.fastForward(300);
        assert.match(await page.locator(".player-rate").innerText(), /1x/);
        await page.clock.fastForward(100);
        assert.equal(await page.getByRole("slider").getAttribute("aria-valuenow"), "778");
        await press(page, ENTER);
        assert.deepEqual((await commands(page)).slice(-2), ["seekToSeconds 778", "setPaused false"]);

        await show(page, playing(TRACKS));
        await press(page, DOWN);
        assert.equal(await focused(page), "pause");
        assert.equal(await menuShown(page), false);
        await press(page, UP);
        assert.equal(await focused(page), "position");
        await press(page, DOWN);
        await press(page, RIGHT);
        await press(page, RIGHT);
        assert.equal(await focused(page), "tracks");
        assert.equal(await page.getByRole("button", { name: "Info and options", exact: true }).count(), 1);
        await press(page, ENTER);
        assert.equal(await menuShown(page), true);
        assert.deepEqual(await page.locator(".player-tab:not([hidden])").allTextContents(), ["Info", "Stats", "Video", "Audio", "Subtitles"]);
        assert.match(await page.locator(".player-menu-info").innerText(), /The Movie/);
        assert.match(await page.locator(".player-menu-info").innerText(), /\b2h\b/);
        assert.match(await page.locator(".player-menu-info").innerText(), /Off/);
        await press(page, BACK);
        await press(page, DOWN);
        await press(page, RIGHT);
        await press(page, RIGHT);
        await press(page, RIGHT);
        assert.equal(await focused(page), "close");
        assert.equal(await page.getByRole("button", { name: "Close player", exact: true }).count(), 1);
        assert.equal(await page.locator(".player-glyph").first().locator("svg").count(), 1);
        assert.equal(await page.locator(".player-button-primary").innerText(), "");
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
        // Old accessible name was "Playback position". Apple's scrubber label is "Scrubber".
        assert.equal(await page.getByRole("slider", { name: "Scrubber" }).getAttribute("aria-valuenow"), "774");
        await show(page, { ...playing(TRACKS), positionSeconds: 760 });
        assert.equal(await page.getByRole("slider").getAttribute("aria-valuenow"), "774", "live progress must not move the preview");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["seekToSeconds 774"]);
        await remote(page, LEFT);
        await remote(page, BACK);
        assert.deepEqual(await commands(page), ["seekToSeconds 774"], "cancelling does not seek or leave playback");
        assert.equal(await page.getByRole("slider").getAttribute("aria-valuenow"), "774", "cancelling a newer preview retains the seek already sent");
        await remote(page, BACK);
        assert.deepEqual(await commands(page), ["seekToSeconds 774", "back"]);
        assert.deepEqual(logs, []);
    } finally { await page.close(); }
});

test("visible transport controls are reachable by remote and keep focus across progress", async () => {
    const { page, logs } = await open();
    try {
        await show(page, playing(TRACKS));
        // Old Up from the scrubber focused Pause. Down does that now.
        await remote(page, DOWN);
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
        // Old command was togglePause. Select enters timeline scrub and pauses.
        assert.deepEqual(await commands(page), ["setPaused true"], "loading clears the abandoned preview");
        await remote(page, DOWN);
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
        // Old Down opened the panel. Options does that now.
        await openPanel(page);
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
        // Let focus colour transitions finish so the capture shows the settled state.
        await page.waitForTimeout(300);
        // Desktop Chromium has no AVPlay plane; black stands in for a dark video frame behind the translucent glass.
        await page.evaluate(() => { document.documentElement.style.background = "#000"; });
        await page.screenshot({ path: `${dir}/${name}.png` });
        await page.evaluate(() => { document.documentElement.style.background = ""; });
    }
}

/** AVPlay draws behind the page, so a full-screen non-transparent layer hides the picture. */
const planeCoveredBy = (page: Page): Promise<string[]> => page.evaluate(() => {
    const video = document.querySelector("object.player-video");
    if (!(video instanceof HTMLElement)) return ["missing object"];
    const videoBox = video.getBoundingClientRect();
    const opaque = (style: CSSStyleDeclaration): boolean => {
        const image = style.backgroundImage;
        if (image !== "none") return !/rgba?\([^)]*,\s*0(?:\.0+)?\s*\)|transparent/.test(image);
        const match = style.backgroundColor.match(/rgba?\(([^)]+)\)/);
        const channels = match?.[1];
        if (channels === undefined) return style.backgroundColor !== "transparent";
        const parts = channels.split(",").map((part) => part.trim());
        const alpha = parts[3];
        return alpha === undefined || Number(alpha) > 0;
    };
    const paints = (element: Element): boolean => {
        if (!(element instanceof HTMLElement) || element.hidden) return false;
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
        return opaque(style) && Number(style.opacity) > 0;
    };
    const covers = (element: Element): boolean => {
        const box = element.getBoundingClientRect();
        return box.left <= videoBox.left + 0.5 && box.top <= videoBox.top + 0.5 && box.right >= videoBox.right - 0.5 && box.bottom >= videoBox.bottom - 0.5;
    };
    const name = (element: Element): string => `${element.tagName.toLowerCase()}${element.id === "" ? "" : `#${element.id}`}${element.className === "" ? "" : `.${String(element.className).trim().replace(/\s+/g, ".")}`}`;
    const offenders: string[] = [];
    for (let node = video.parentElement; node !== null; node = node.parentElement) {
        if (paints(node)) offenders.push(`ancestor ${name(node)}`);
    }
    for (const element of document.querySelectorAll("body *")) {
        if (element === video || video.contains(element) || element.contains(video)) continue;
        if (paints(element) && covers(element)) offenders.push(`full-screen ${name(element)}`);
    }
    return offenders;
});

test("the video plane stays clear once a frame can show, including replan, reconnect and restore", async () => {
    const { page, logs } = await open();
    try {
        const assertClear = async (state: string): Promise<void> => {
            assert.deepEqual(await planeCoveredBy(page), [], state);
        };
        const backdrop = page.locator(".player-backdrop");
        assert.equal(await backdrop.isVisible(), true, "the opening load is still black");
        assert.equal(await backdrop.evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(0, 0, 0)");
        await show(page, playing(NO_TRACKS));
        await assertClear("left loading");
        assert.equal(await backdrop.isVisible(), false, "the backdrop leaves with the loading phase");
        await show(page, { ...playing(NO_TRACKS), phase: "paused" });
        await assertClear("paused");
        await show(page, playing(NO_TRACKS));
        await page.locator(".player-bar").focus();
        await remote(page, ENTER);
        await remote(page, RIGHT);
        assert.equal(await page.locator(".player-bar").evaluate((node) => node.className), "player-bar player-bar-preview");
        await assertClear("seeking");
        await remote(page, BACK);
        await show(page, playing(TRACKS));
        await openPanel(page);
        assert.equal(await page.locator(".player-menu").isVisible(), true);
        await assertClear("panel");
        await show(page, { phase: "error", title: "The Movie", error: { kind: "network" } });
        await assertClear("error");
        await show(page, { phase: "loading", title: "The Movie" });
        await assertClear("replan");
        assert.equal(await backdrop.isVisible(), false, "a later load must not cover a picture that already showed");
        await show(page, { phase: "loading", title: "The Movie", detail: "reconnecting" });
        await assertClear("reconnect");
        assert.equal(await page.locator(".player-status").innerText(), "Reconnecting");
        await show(page, { phase: "loading", title: "The Movie", detail: "restoring" });
        await assertClear("restore");
        assert.equal(await page.locator(".player-status").innerText(), "Restoring");
        assert.deepEqual(logs, []);
    } finally {
        await page.close();
    }
});

test("loading, playing and paused are readable; the remote cancels a seek preview and goes back with focus kept", async () => {
    const { page, logs } = await open();
    try {
        assert.equal(await page.locator(".player-spinner").isVisible(), true);
        assert.equal(await page.locator(".player-spinner").getAttribute("aria-label"), "Loading");
        assert.equal(await page.locator(".player-overlay .player-title").isVisible(), false);
        assert.equal(await page.locator(".player-bar").isVisible(), false);
        assert.equal(await page.locator(".player-status").isVisible(), false);
        assert.equal(await focused(page), "player");

        await show(page, { phase: "playing", title: "The Movie", positionSeconds: 754, durationSeconds: 7200, buffering: false, seekIntervals: { backward: 10, forward: 10 }, tracks: NO_TRACKS });
        // Old value was "12:34 / 2:00:00" (elapsed slash duration). Apple's time row is elapsed and a minus remaining.
        assert.equal(await page.locator(".player-time-elapsed").innerText(), "12:34");
        assert.equal(await page.locator(".player-time-remaining").innerText(), "−1:47:26");
        assert.equal(await page.locator(".player-overlay").getAttribute("class"), "player-overlay", "shown when playback starts");
        await page.clock.fastForward(5000);
        await show(page, { phase: "playing", title: "The Movie", positionSeconds: 759, durationSeconds: 7200, buffering: false, seekIntervals: { backward: 10, forward: 10 }, tracks: NO_TRACKS });
        assert.equal(await page.locator(".player-overlay").getAttribute("class"), "player-overlay player-overlay-hidden");

        await remote(page, ENTER);
        await remote(page, LEFT);
        await remote(page, RIGHT);
        assert.equal(await page.locator(".player-overlay").getAttribute("class"), "player-overlay", "a key brings the overlay back");
        await show(page, { phase: "paused", title: "The Movie", positionSeconds: 759, durationSeconds: undefined, buffering: false, seekIntervals: { backward: 10, forward: 10 }, tracks: NO_TRACKS });
        assert.equal(await page.locator(".player-status").isVisible(), false);
        assert.equal(await text(page, ".player-time"), "12:39");
        await capture(page, "player-paused");
        await remote(page, BACK);
        await remote(page, BACK);
        // Old command was togglePause. Select enters timeline scrub and pauses.
        assert.deepEqual(await commands(page), ["setPaused true", "back"]);
        // Old focus was "player", the empty overlay. Resting focus is the scrubber.
        assert.equal(await focused(page), "position");
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

test("a retryable start failure focuses Retry, moves to Back, and only Retry starts again", async () => {
    const { page, logs } = await open();
    try {
        await show(page, { phase: "error", title: "The Movie", error: { kind: "server" }, retryable: true });
        assert.equal(await text(page, ".player-error-text"), "The server couldn't start playback. Try again.");
        assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).isVisible(), true);
        assert.equal(await page.getByRole("button", { name: "Go Back", exact: true }).isVisible(), true);
        assert.equal(await focused(page), "settings-retry");
        await remote(page, RIGHT);
        assert.equal(await focused(page), "back");
        await remote(page, LEFT);
        assert.equal(await focused(page), "settings-retry");
        await remote(page, ENTER);
        await remote(page, BACK);
        assert.deepEqual(await commands(page), ["retryCompletion", "dismissError"]);
        assert.deepEqual(logs, []);
    } finally {
        await page.close();
    }
});

test("a playback error uses the Apple TV wall: triangle, body text, and a row of actions", async () => {
    const { page, logs } = await open();
    try {
        await show(page, { phase: "error", title: "The Movie", error: { kind: "network" } });
        const measured = await page.evaluate(() => {
            const mark = document.querySelector(".player-error-mark");
            const copy = document.querySelector(".player-error-text");
            const actions = document.querySelector(".player-error-actions");
            const back = document.querySelector<HTMLElement>('[data-focus="back"]');
            if (!(mark instanceof Element) || !(copy instanceof HTMLElement) || !(actions instanceof HTMLElement) || back === null) {
                return undefined;
            }
            const markStyle = getComputedStyle(mark);
            const copyStyle = getComputedStyle(copy);
            const actionStyle = getComputedStyle(actions);
            const backStyle = getComputedStyle(back);
            return {
                mark: { width: markStyle.width, height: markStyle.height, color: markStyle.color },
                copy: { size: copyStyle.fontSize, weight: copyStyle.fontWeight, color: copyStyle.color, align: copyStyle.textAlign },
                gap: actionStyle.gap,
                direction: actionStyle.flexDirection,
                minWidth: backStyle.minWidth,
                label: back.textContent,
            };
        });
        assert.deepEqual(measured, {
            mark: { width: "40px", height: "40px", color: "rgb(176, 0, 32)" },
            copy: { size: "26px", weight: "400", color: "rgb(255, 255, 255)", align: "center" },
            gap: "16px",
            direction: "row",
            minWidth: "140px",
            label: "Go Back",
        });
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

test("the open panel is Apple's 1100 by 380 tabbed HUD and the clock is elapsed and remaining", async () => {
    const { page } = await open();
    try {
        const quality = { choices: [{ id: "auto", label: "Auto" }, { id: "1080p-medium", label: "1080p Medium (6 Mbps)" }], selectedId: "auto" };
        await show(page, playing({ ...TRACKS, quality }));
        const elapsed = page.locator(".player-time-elapsed");
        const remaining = page.locator(".player-time-remaining");
        assert.equal(await elapsed.innerText(), "12:34");
        assert.equal(await remaining.innerText(), "−1:47:26");
        await page.locator(".player-bar").focus();
        const puck = await page.locator(".player-puck").evaluate((node) => {
            const style = getComputedStyle(node);
            const box = node.getBoundingClientRect();
            return { width: box.width, height: box.height, color: style.backgroundColor, shown: style.display !== "none" };
        });
        assert.equal(puck.shown, true);
        assert.equal(puck.width, 30);
        assert.equal(puck.height, 30);
        assert.equal(puck.color, "rgb(255, 255, 255)");
        // Old Down opened the panel.
        await openPanel(page);
        const panel = await page.locator(".player-menu").evaluate((node) => {
            const style = getComputedStyle(node);
            const box = node.getBoundingClientRect();
            const glass = getComputedStyle(node, "::before");
            return { width: box.width, height: box.height, radius: style.borderTopLeftRadius, shadow: glass.boxShadow };
        });
        assert.equal(panel.width, 1100);
        assert.equal(panel.height, 380);
        assert.equal(panel.radius, "28px");
        // Apple's 14% stroke is an overlay, so it is drawn as an inset ring rather than a layout border.
        assert.match(panel.shadow, /rgba\(255, 255, 255, 0\.14\) 0px 0px 0px 1px inset/);
        assert.match(panel.shadow, /rgba\(0, 0, 0, 0\.5\)/);
        // Old tabs were Audio, Subtitles, Video. Info leads, and Video follows Subtitles.
        assert.deepEqual(await page.locator(".player-tab:not([hidden])").allTextContents(), ["Info", "Stats", "Video", "Audio", "Subtitles"]);
        assert.equal(await page.locator(".player-overlay .player-title").isVisible(), false);
        assert.equal(await page.locator(".player-bar").isVisible(), false);
        assert.equal(await page.locator(".player-time").isVisible(), false);
        assert.equal(await page.locator(".player-transport").isVisible(), false);
    } finally {
        await page.close();
    }
});

test("audio and quality stay disabled while a subtitle report is pending", async () => {
    const { page } = await open();
    try {
        const tracks: TrackView = {
            ...TRACKS,
            reporting: true,
            quality: { choices: [{ id: "auto", label: "Auto" }, { id: "1080p", label: "1080p" }], selectedId: "auto" },
        };
        await show(page, playing(tracks));
        await openAudio(page);
        assert.equal(await page.locator('[data-focus="file:42:audio:1"]').getAttribute("aria-disabled"), "true");
        assert.equal(await page.locator('[data-focus="subtitles-off"]').getAttribute("aria-disabled"), "false");
        assert.equal(await page.locator('[data-focus="video-quality"]').getAttribute("aria-disabled"), "true");
        await remote(page, DOWN);
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), [], "a disabled audio row does not select");
    } finally { await page.close(); }
});

test("Down opens audio and subtitles with focus on the current track; the menu keeps every key to itself", async () => {
    const { page, logs } = await open();
    try {
        await show(page, playing(TRACKS));
        assert.equal(await page.locator(".player-hint").count(), 0);
        // Old accessible name was "Audio and subtitles". Apple's options control is "Info and options".
        assert.equal(await page.getByRole("button", { name: "Info and options", exact: true }).count(), 1);
        assert.equal(await menuShown(page), false);
        await page.getByRole("button", { name: "Info and options", exact: true }).click();
        assert.equal(await menuShown(page), true);
        await remote(page, BACK);
        assert.equal(await menuShown(page), false);
        // Old Down opened the panel on the current audio track. Options opens Info, and Audio is next.
        await openAudio(page);
        assert.equal(await menuShown(page), true);
        assert.equal(await focused(page), "file:42:audio:0");
        // Old heading was "Audio" on the three-column dialog. Apple's column header is TRACKS.
        assert.equal(await text(page, ".player-menu-audio"), "TRACKS\nEnglish · 5.1 · EAC3\nJapanese · Stereo · AAC");
        assert.equal(await page.locator('[data-focus="file:42:audio:0"]').getAttribute("aria-pressed"), "true");
        await capture(page, "player-tracks-menu");

        await remote(page, UP);
        assert.equal(await focused(page), "tab-audio", "Up at the top returns to the active tab");
        await remote(page, DOWN);
        assert.equal(await focused(page), "file:42:audio:0");
        await remote(page, DOWN);
        assert.equal(await focused(page), "file:42:audio:1");
        await remote(page, ENTER);
        await remote(page, RIGHT);
        assert.equal(await focused(page), "file:42:audio:1", "Right inside a pane does not change tabs");
        await remote(page, UP);
        await remote(page, UP);
        await remote(page, RIGHT);
        await remote(page, DOWN);
        assert.equal(await focused(page), "subtitles-off", "Subtitles is entered at Off");
        await remote(page, DOWN);
        await remote(page, DOWN);
        assert.equal(await focused(page), "file:42:subtitle:1");
        await remote(page, ENTER);
        await remote(page, UP);
        await remote(page, UP);
        await remote(page, ENTER);
        await remote(page, UP);
        await remote(page, LEFT);
        await remote(page, DOWN);
        assert.equal(await focused(page), "file:42:audio:0", "a pane is entered at its top row");
        await remote(page, BACK);
        assert.equal(await menuShown(page), false);
        // Old focus was "player". Closing the panel returns to the scrubber.
        assert.equal(await focused(page), "position");
        assert.deepEqual(await commands(page), ["selectAudio file:42:audio:1", "selectSubtitle file:42:subtitle:1", "selectSubtitle off"]);

        await remote(page, ENTER);
        await remote(page, BACK);
        await remote(page, BACK);
        // Old commands were togglePause then one Back that left playback. Select now pauses into timeline scrub, so the first Back cancels that scrub.
        assert.deepEqual((await commands(page)).slice(3), ["setPaused true", "back"], "closed again, the keys drive playback");
        assert.deepEqual(logs, []);
    } finally {
        await page.close();
    }
});

test("the tab rail crosses Audio while its choices are loading", async () => {
    const { page } = await open();
    try {
        await show(page, playing({ ...TRACKS, audio: { state: "loading" } }));
        await openAudio(page);
        assert.equal(await focused(page), "tab-audio", "Down stays on the pill when the pane has nothing to focus");
        await remote(page, RIGHT);
        await remote(page, DOWN);
        assert.equal(await focused(page), "subtitles-off");
        await remote(page, UP);
        await remote(page, LEFT);
        await remote(page, LEFT);
        await remote(page, DOWN);
        assert.equal(await focused(page), "video-empty");
    } finally { await page.close(); }
});

test("the menu says what is happening: loading, a failed list with Retry, a change, a refusal and notices", async () => {
    const { page, logs } = await open();
    try {
        await show(page, playing({ ...TRACKS, audio: { state: "loading" } }));
        // Old Down opened the panel on Subtitles when audio had no row. The panel now opens on Info.
        await openPanel(page);
        // Old heading was "Audio".
        assert.equal(await lines(page, ".player-menu-audio"), "TRACKS\nLoading audio tracks");
        assert.equal(await focused(page), "info", "with no audio choice, focus starts on Info");

        await show(page, playing({ ...TRACKS, audio: { state: "failed" } }));
        // Old heading was "Audio".
        assert.equal(await lines(page, ".player-menu-audio"), "TRACKS\nCouldn't load audio tracks.\nRetry");
        await nextTab(page, 3);
        assert.equal(await focused(page), "audio-retry");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["retryTrackInfo"]);

        await show(page, playing({ ...TRACKS, change: { state: "changing" } }));
        assert.equal(await text(page, ".player-menu-status"), "Changing track");
        // Below the panel the status sits over video, so it carries Apple's non-sampling HUD fill to stay readable on bright frames.
        const plate = await page.locator(".player-menu-status").evaluate((node) => {
            const style = getComputedStyle(node);
            const box = node.getBoundingClientRect();
            const panel = document.querySelector(".player-menu")!.getBoundingClientRect();
            return { fill: style.backgroundColor, top: box.top, panelBottom: panel.bottom, width: box.width };
        });
        assert.equal(plate.fill, "rgba(26, 26, 26, 0.88)");
        assert.ok(plate.top >= plate.panelBottom && plate.width < 1044, "a plate under the panel, sized to its text");
        // Three lines of notices show in full: the remote cannot scroll the plate while focus stays on the menu.
        await show(page, playing({ ...TRACKS, notices: ["Subtitles are burned into the video while this version plays, so their style and timing follow the server's render. ".repeat(3).trim()] }));
        const fit = await page.locator(".player-menu-status").evaluate((node) => ({ scroll: node.scrollHeight, client: node.clientHeight, rows: Math.round((node.clientHeight - 12) / parseFloat(getComputedStyle(node).lineHeight)) }));
        assert.ok(fit.scroll <= fit.client, `three lines fit without clipping (${fit.scroll} > ${fit.client})`);
        assert.equal(fit.rows, 3);
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
        // Old path was Down then Right, from an Audio panel. Info is the first tab now.
        await openAudio(page);
        await nextTab(page, 1);
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
            const rows = document.querySelector(".player-menu-column-tracks .player-menu-column-rows");
            const status = document.querySelector(".player-menu-status");
            const focus = document.activeElement;
            if (!(player instanceof HTMLElement) || !(list instanceof HTMLElement) || !(rows instanceof HTMLElement) || status === null || focus === null) {
                throw new Error("Missing track menu");
            }
            return { playerScroll: player.scrollTop, listScroll: rows.scrollTop, list: list.getBoundingClientRect().toJSON(), status: status.getBoundingClientRect().toJSON(), focus: focus.getBoundingClientRect().toJSON() };
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
        // Old path was Down then Right, from an Audio panel. Info is the first tab now.
        await openAudio(page);
        await nextTab(page, 1);
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
        // Old focus was "player". Playback focus stays on the scrubber across suspend.
        assert.equal(await focused(page), "position");
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
        assert.equal(await page.locator(".player-spinner").isVisible(), true);
        assert.equal(await page.locator(".player-status").isVisible(), false);
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
        // Old path was Down, Right, Right from an Audio panel. Info is the first tab now.
        await openPanel(page);
        await nextTab(page, 2);
        assert.equal(await focused(page), "video-empty", "Video remains available when quality has no choice");
        await show(page, playing({ ...TRACKS, quality }));
        assert.equal(await focused(page), "video-quality");
        assert.equal(await text(page, '[data-focus="video-quality"]'), "Quality\nAuto");
        await remote(page, ENTER);
        assert.equal(await text(page, ".player-menu-quality .player-menu-picker-title"), "Quality");
        assert.equal(await focused(page), "subtitle-picker:auto");
        await remote(page, DOWN);
        assert.equal(await focused(page), "subtitle-picker:future-rung");
        assert.equal(await page.locator(".player-menu-picker .player-choice").last().innerText(), "Server Quality");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["selectQuality future-rung"]);
        assert.equal(await focused(page), "video-quality");
        await show(page, playing({ ...TRACKS, quality, change: { state: "changing", kind: "quality" } }));
        assert.equal(await focused(page), "video-quality");
        assert.equal(await text(page, '[data-focus="video-quality"]'), "Quality\nSwitching...");
        assert.equal(await text(page, ".player-menu-status"), "Changing quality");
        await show(page, playing({ ...TRACKS, quality, change: { state: "refused", message: "This quality is unavailable." } }));
        assert.match(await text(page, ".player-menu-status"), /This quality is unavailable/);
        assert.equal(await text(page, '[data-focus="video-quality"]'), "Quality\nAuto");
        await capture(page, "player-quality-after");
        await show(page, playing({ ...TRACKS, quality: { choices: [], selectedId: undefined } }));
        // Old focus was the first audio row. Info is the first usable pane when Video disappears.
        assert.equal(await focused(page), "video-empty", "disappearing quality hands focus to the Video empty state");
        await remote(page, BACK);
        // Old focus was "player". Closing the panel returns to the scrubber.
        assert.equal(await focused(page), "position");
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
        await openPanel(page);
        await nextTab(page, 2);
        await remote(page, ENTER);
        for (let index = 0; index < 16; index++) await remote(page, DOWN);
        assert.equal(await focused(page), "subtitle-picker:rung-15");
        await page.clock.resume();
        await page.waitForFunction(() => {
            const options = document.querySelector(".player-menu-picker-options");
            const focus = document.activeElement;
            if (options === null || focus === null) return false;
            const bounds = options.getBoundingClientRect();
            const item = focus.getBoundingClientRect();
            return item.top >= bounds.top && item.bottom <= bounds.bottom;
        });
        const geometry = await page.evaluate(() => {
            const panel = document.querySelector(".player-menu");
            const picker = document.querySelector(".player-menu-picker");
            const options = document.querySelector(".player-menu-picker-options");
            assertElement(panel);
            assertElement(picker);
            assertElement(options);
            return { panel: panel.getBoundingClientRect().toJSON(), picker: picker.getBoundingClientRect().toJSON(), scroll: options.scrollTop };
            function assertElement(value: Element | null): asserts value is HTMLElement {
                if (!(value instanceof HTMLElement)) throw new Error("missing element");
            }
        });
        assert.ok(geometry.scroll > 0, "only the picker's options scroll");
        assert.ok(geometry.picker.top >= geometry.panel.top && geometry.picker.bottom <= geometry.panel.bottom, "the picker stays inside the panel");
        await show(page, playing({ ...TRACKS, quality, change: { state: "changing", kind: "quality" } }));
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), [], "busy choices remain focusable but cannot send a second intent");
        await remote(page, RIGHT);
        assert.equal(await focused(page), "subtitle-picker:rung-15", "Right does not leave an open picker");
        await page.locator('[data-focus="subtitle-picker:rung-1"]').dispatchEvent("click");
        assert.deepEqual(await commands(page), []);
        await show(page, { phase: "loading", title: "The Movie" });
        assert.equal(await focused(page), "player");
        assert.equal(await menuShown(page), false);
        assert.deepEqual(logs, []);
    } finally {
        await page.close();
    }
});

test("an empty audio list does not trap remote movement between Info and Subtitles", async () => {
    const { page, logs } = await open();
    try {
        await show(page, playing({ ...TRACKS, audio: { state: "ready", choices: [] }, selectedAudioId: undefined }));
        await openPanel(page);
        assert.equal(await focused(page), "info");
        await nextTab(page, 1);
        assert.equal(await focused(page), "stat:Engine");
        await nextTab(page, 1);
        assert.equal(await focused(page), "video-empty");
        assert.equal(await page.locator(".player-tab:not([hidden])").allTextContents().then(names => names.includes("Audio")), false);
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), []);
        await nextTab(page, 1);
        assert.equal(await focused(page), "subtitles-off");
        for (const expected of ["video-empty", "stat:Engine", "info"]) {
            await remote(page, UP);
            await remote(page, LEFT);
            await remote(page, DOWN);
            assert.equal(await focused(page), expected);
        }
        assert.deepEqual(logs, []);
    } finally {
        await page.close();
    }
});

test("backing out of subtitle results restores the chosen language", async () => {
    const { page } = await open();
    const search = {
        offered: true, unavailableReason: "", phase: "results" as const,
        suggested: [{ code: "ja", label: "Japanese" }],
        other: [{ code: "en", label: "English" }],
        language: "ja", status: "", message: "", warnings: [], canRetry: false,
        results: [{ key: "opensubtitles:1", id: "1", provider: "opensubtitles", language: "ja", releaseName: "Example", format: "srt", score: 80, downloads: 1, hearingImpaired: false }],
        downloadingKey: undefined,
    };
    const tracks: TrackView = { ...TRACKS, subtitleTools: { search, overlay: false } };
    try {
        await show(page, playing(tracks));
        await openPanel(page);
        await nextTab(page, 4);
        await remote(page, BACK);
        assert.deepEqual(await commands(page), ['subtitleTool {"kind":"search-back"}']);
        await show(page, playing({ ...tracks, subtitleTools: { search: { ...search, phase: "languages", results: [] }, overlay: false } }));
        assert.equal(await focused(page), "subtitle-language:ja");
        assert.equal(await page.locator('[data-focus="subtitle-language:ja"]').getAttribute("aria-pressed"), "true");
        assert.equal(await page.locator('[data-focus="subtitle-language:en"]').getAttribute("aria-pressed"), "false");
    } finally { await page.close(); }
});

const CLOSED_SEARCH = { offered: true, unavailableReason: "", phase: "closed" as const, suggested: [], other: [], language: undefined, status: "", message: "", warnings: [], canRetry: false, results: [], downloadingKey: undefined };

test("subtitle search remains remote reachable without existing subtitle tracks", async () => {
    const { page } = await open();
    const tracks: TrackView = { ...TRACKS, subtitles: [], subtitleTools: {
        search: CLOSED_SEARCH,
        overlay: false,
    } };
    try {
        await show(page, playing(tracks));
        await openPanel(page);
        assert.equal(await page.getByRole("tab", { name: "Subtitles", exact: true }).isVisible(), true);
        await nextTab(page, 4);
        assert.equal(await focused(page), "subtitles-off");
        await remote(page, RIGHT);
        assert.equal(await focused(page), "subtitle-search");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ['subtitleTool {"kind":"search-open"}']);
    } finally { await page.close(); }
});

test("subtitle search stays reachable under a long track list and after a preference failure", async () => {
    const { page } = await open();
    const subtitles = Array.from({ length: 12 }, (_, index) => ({ id: `file:42:subtitle:${index}`, label: `Subtitle ${index + 1}` }));
    const failed = "Could not load subtitle preferences. Reopen playback to retry.";
    const tracks: TrackView = {
        ...TRACKS,
        subtitles,
        subtitleTools: {
            search: CLOSED_SEARCH,
            display: { delay: false, styling: false, deviceScope: false, textOpacity: false, delayMs: 0, appearance: DEFAULT_APPEARANCE, deviceOverride: false, busy: false, message: failed },
            overlay: true,
        },
    };
    try {
        await show(page, playing(tracks));
        await openPanel(page);
        await nextTab(page, 4);
        assert.match(await text(page, ".player-menu-status"), /Could not load subtitle preferences/);
        assert.equal(await focused(page), "subtitles-off");
        for (let index = 0; index < subtitles.length + 1; index += 1) await remote(page, DOWN);
        assert.equal(await focused(page), `file:42:subtitle:${subtitles.length - 1}`, "Down stays in the TRACKS column");
        await remote(page, RIGHT);
        assert.equal(await focused(page), "subtitle-search");
        assert.equal(await page.locator('[data-focus="subtitle-search"]').getAttribute("aria-disabled"), "false");
        await page.clock.resume();
        await page.waitForFunction(() => {
            const list = document.querySelector(".player-menu-subtitles");
            const focus = document.activeElement;
            if (list === null || focus === null) return false;
            const bounds = list.getBoundingClientRect();
            const item = focus.getBoundingClientRect();
            return item.top >= bounds.top && item.bottom <= bounds.bottom;
        });
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ['subtitleTool {"kind":"search-open"}']);
    } finally { await page.close(); }
});

test("an open picker keeps focus until Back closes it onto its row", async () => {
    const { page } = await open();
    const tracks: TrackView = { ...TRACKS, subtitleTools: {
        search: { offered: true, unavailableReason: "", phase: "closed", suggested: [], other: [], language: undefined, status: "", message: "", warnings: [], canRetry: false, results: [], downloadingKey: undefined },
        display: { delay: true, styling: true, deviceScope: true, textOpacity: true, delayMs: 0, appearance: DEFAULT_APPEARANCE, deviceOverride: false, busy: false, message: "" },
        overlay: true,
    } };
    try {
        await show(page, playing(tracks));
        await openPanel(page);
        await nextTab(page, 4);
        await page.locator('[data-focus="subtitle-size"]').focus();
        await remote(page, ENTER);
        assert.equal(await focused(page), "subtitle-picker:large");
        assert.equal(await page.locator('[data-focus="subtitle-picker-back"]').count(), 0, "Apple's picker has no Back row");
        for (const key of [LEFT, RIGHT, UP, UP, UP, UP, UP]) await remote(page, key);
        assert.match(await focused(page) ?? "", /^subtitle-picker:/, "the rail and the dimmed pane are out of reach");
        assert.equal(await page.locator(".player-menu-behind").evaluate(node => (node as HTMLElement).inert), true);
        await remote(page, BACK);
        assert.equal(await focused(page), "subtitle-size");
        assert.deepEqual(await commands(page), []);
    } finally { await page.close(); }
});

for (const origin of ["tracks", "appearance"] as const) for (const field of ["fontSize", "position"] as const) for (const ending of ["select", "remote-back"] as const) {
    test(`subtitle ${origin} ${field} picker restores its originating row after ${ending}`, async () => {
        const { page } = await open();
        const tracks: TrackView = { ...TRACKS, subtitleTools: {
            search: { offered: true, unavailableReason: "", phase: "closed", suggested: [], other: [], language: undefined, status: "", message: "", warnings: [], canRetry: false, results: [], downloadingKey: undefined },
            display: { delay: true, styling: true, deviceScope: true, textOpacity: true, delayMs: 0, appearance: DEFAULT_APPEARANCE, deviceOverride: false, busy: false, message: "" },
            overlay: true,
        } };
        try {
            await show(page, playing(tracks));
            await openPanel(page);
            await nextTab(page, 4);
            if (origin === "appearance") {
                await page.locator('[data-focus="subtitle-appearance"]').focus();
                await remote(page, ENTER);
            }
            const trigger = origin === "appearance" ? `subtitle-appearance:${field}` : field === "fontSize" ? "subtitle-size" : "subtitle-position";
            await page.locator(`[data-focus="${trigger}"]`).focus();
            await remote(page, ENTER);
            assert.equal(await focused(page), field === "fontSize" ? "subtitle-picker:large" : "subtitle-picker:bottom");
            assert.equal(await text(page, ".player-menu-subtitles .player-menu-picker-title"), field === "fontSize" ? "Subtitle Size" : "Subtitle Position");
            if (ending === "select") await remote(page, ENTER);
            else await remote(page, BACK);
            assert.equal(await focused(page), trigger);
            assert.equal(await page.locator('[data-focus="subtitle-appearance-back"]').count(), origin === "appearance" ? 1 : 0);
            assert.equal((await commands(page)).length, ending === "select" ? 1 : 0);
            if (origin === "appearance") {
                await remote(page, BACK);
                assert.equal(await focused(page), "subtitle-appearance");
            }
        } finally { await page.close(); }
    });
}

test("subtitle search and the delay, size, position and appearance rows are remote-operable", async () => {
    const { page, logs } = await open();
    const tracks: TrackView = {
        ...TRACKS,
        subtitleTools: {
            search: { offered: true, unavailableReason: "", phase: "closed", suggested: [], other: [], language: undefined, status: "", message: "", warnings: [], canRetry: false, results: [], downloadingKey: undefined },
            display: { delay: true, styling: true, deviceScope: true, textOpacity: true, delayMs: 0, appearance: DEFAULT_APPEARANCE, deviceOverride: false, busy: false, message: "" },
            overlay: true,
        },
    };
    try {
        await show(page, playing(tracks));
        await openPanel(page);
        await nextTab(page, 4);
        assert.equal(await page.locator('[data-focus="subtitle-search"] .player-setting-label').textContent(), "Search Subtitles…");
        assert.match(await text(page, ".player-menu-subtitles"), /Delay[\s\S]*0 ms/);
        assert.match(await text(page, ".player-menu-subtitles"), /Size[\s\S]*Large/);
        assert.match(await text(page, ".player-menu-subtitles"), /Position[\s\S]*Bottom/);
        assert.match(await text(page, ".player-menu-subtitles"), /Appearance[\s\S]*Box, Large, Bottom/);
        await remote(page, RIGHT);
        assert.equal(await focused(page), "subtitle-search");
        await remote(page, DOWN);
        assert.equal(await focused(page), "subtitle-delay");
        await remote(page, ENTER);
        assert.equal(await text(page, ".player-menu-subtitles .player-menu-picker-title"), "Subtitle Delay");
        assert.equal(await focused(page), "subtitle-picker:0");
        await remote(page, DOWN);
        assert.equal(await focused(page), "subtitle-picker:100");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ['subtitleTool {"kind":"delay","milliseconds":100}']);
        assert.equal(await focused(page), "subtitle-delay");
        assert.deepEqual(logs, []);
    } finally {
        await page.close();
    }
});

const ALL_TOOLS: NonNullable<TrackView["subtitleTools"]> = {
    search: CLOSED_SEARCH,
    display: { delay: true, styling: true, deviceScope: true, textOpacity: true, delayMs: 0, appearance: DEFAULT_APPEARANCE, deviceOverride: false, busy: false, message: "" },
    overlay: true,
};

test("Subtitles lays out TRACKS and OPTIONS like Apple TV, with right-aligned values, chevrons and the Aa glyph", async () => {
    const { page } = await open();
    try {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await show(page, playing({ ...TRACKS, subtitleTools: ALL_TOOLS }));
        await page.evaluate(() => document.fonts.ready);
        await openPanel(page);
        await nextTab(page, 4);
        assert.equal(await focused(page), "subtitles-off");
        const layout = await page.evaluate(() => {
            const pane = document.querySelector(".player-menu-subtitles");
            const box = (selector: string): DOMRect => {
                const node = pane?.querySelector(selector);
                if (!(node instanceof HTMLElement)) throw new Error(`missing ${selector}`);
                return node.getBoundingClientRect();
            };
            const row = (id: string): { label: DOMRect; value: DOMRect | undefined; chevron: DOMRect | undefined; glyph: string | undefined; row: DOMRect } => {
                const button = pane?.querySelector(`[data-focus="${id}"]`);
                if (!(button instanceof HTMLElement)) throw new Error(`missing ${id}`);
                const part = (name: string): DOMRect | undefined => button.querySelector(name)?.getBoundingClientRect();
                return { label: part(".player-setting-label")!, value: part(".player-setting-value"), chevron: part(".player-setting-chevron"), glyph: button.querySelector(".player-setting-glyph")?.textContent ?? undefined, row: button.getBoundingClientRect() };
            };
            return {
                headings: Array.from(pane?.querySelectorAll(".player-menu-column > .player-menu-heading") ?? []).map(node => node.textContent),
                tracks: box(".player-menu-column-tracks"),
                options: box(".player-menu-column-options"),
                panel: document.querySelector(".player-menu")!.getBoundingClientRect(),
                trackIds: Array.from(pane?.querySelectorAll(".player-menu-column-tracks [data-focus]") ?? []).map(node => node.getAttribute("data-focus")),
                optionIds: Array.from(pane?.querySelectorAll(".player-menu-column-options [data-focus]") ?? []).map(node => node.getAttribute("data-focus")),
                delay: row("subtitle-delay"), device: row("subtitle-device"), size: row("subtitle-size"), appearance: row("subtitle-appearance"),
            };
        });
        assert.deepEqual(layout.headings, ["TRACKS", "OPTIONS"]);
        assert.deepEqual(layout.trackIds, ["subtitles-off", "file:42:subtitle:0", "file:42:subtitle:1", "file:42:subtitle:2"]);
        assert.deepEqual(layout.optionIds, ["subtitle-search", "subtitle-delay", "subtitle-device", "subtitle-size", "subtitle-position", "subtitle-appearance"]);
        // SubtitlesPane: 470pt TRACKS, 58pt apart from 440pt OPTIONS, centred in the 28pt-padded panel.
        assert.equal(layout.tracks.width, 470);
        assert.equal(layout.options.width, 440);
        assert.equal(layout.options.left - layout.tracks.right, 58);
        assert.equal(layout.tracks.left - (layout.panel.left + 28), layout.panel.right - 28 - layout.options.right);
        assert.equal(layout.tracks.top, layout.options.top);
        for (const row of [layout.delay, layout.size, layout.appearance]) {
            assert.ok(row.value && row.chevron, "picker rows show a value and a chevron");
            assert.equal(Math.round(row.row.right - 14 - row.chevron.right), 0, "the chevron ends at the row's trailing padding");
            assert.equal(Math.round(row.chevron.left - row.value.right), 10, "the value sits 10px before the chevron");
        }
        assert.ok(layout.device.value && layout.device.chevron === undefined, "the device toggle has no chevron");
        assert.equal(Math.round(layout.device.row.right - 14 - layout.device.value.right), 0, "the toggle value is right-aligned");
        assert.equal(layout.appearance.glyph, "Aa");
        assert.equal(await text(page, '[data-focus="subtitle-delay"]'), "Delay\n0 ms");
    } finally { await page.close(); }
});

test("remote focus moves within each Subtitles column and Left/Right cross between them", async () => {
    const { page } = await open();
    try {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await show(page, playing({ ...TRACKS, subtitleTools: ALL_TOOLS }));
        await openPanel(page);
        await nextTab(page, 4);
        assert.equal(await focused(page), "subtitles-off");
        for (let step = 0; step < 6; step += 1) await remote(page, DOWN);
        assert.equal(await focused(page), "file:42:subtitle:2", "Down stops at the last track");
        await remote(page, RIGHT);
        assert.equal(await focused(page), "subtitle-size", "Right lands on the option level with the track");
        for (let step = 0; step < 6; step += 1) await remote(page, DOWN);
        assert.equal(await focused(page), "subtitle-appearance", "Down stops at the last option");
        await remote(page, LEFT);
        assert.equal(await focused(page), "file:42:subtitle:2");
        const trackMiddle = await page.evaluate(() => { const box = document.activeElement!.getBoundingClientRect(); return box.top + box.height / 2; });
        await remote(page, RIGHT);
        const nearest = await page.evaluate((middle) => {
            const gap = (node: Element): number => { const box = node.getBoundingClientRect(); return Math.abs(box.top + box.height / 2 - middle); };
            const rows = Array.from(document.querySelectorAll(".player-menu-column-options [data-focus]"));
            return rows.reduce((best, row) => gap(row) < gap(best) ? row : best).getAttribute("data-focus");
        }, trackMiddle);
        assert.equal(await focused(page), nearest, "Right picks the row level with the track, not the last-focused one");
        for (let step = 0; step < 6 && await focused(page) !== "subtitle-search"; step += 1) await remote(page, UP);
        assert.equal(await focused(page), "subtitle-search");
        await remote(page, UP);
        assert.equal(await focused(page), "tab-subtitles", "Up from the top of OPTIONS returns to its tab");
        await remote(page, DOWN);
        assert.equal(await focused(page), "subtitles-off", "Down from the pill enters at Off");
        await remote(page, LEFT);
        assert.equal(await focused(page), "subtitles-off", "Left past TRACKS does nothing; tabs change on the rail");
        await remote(page, RIGHT);
        await remote(page, RIGHT);
        assert.equal(await focused(page), "subtitle-search", "Right past OPTIONS does nothing");
        assert.equal(await page.locator(".player-menu-subtitles").evaluate(node => node.classList.contains("player-menu-pane-active")), true);
        assert.deepEqual(await commands(page), []);
    } finally { await page.close(); }
});

test("a menu update or picker round trip keeps the unfocused column's scroll position", async () => {
    const { page } = await open();
    const subtitles = Array.from({ length: 30 }, (_, index) => ({ id: `file:42:subtitle:${index}`, label: `Subtitle ${index + 1}` }));
    try {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await show(page, playing({ ...TRACKS, subtitles, subtitleTools: ALL_TOOLS }));
        await openPanel(page);
        await nextTab(page, 4);
        for (let step = 0; step < subtitles.length; step += 1) await remote(page, DOWN);
        await remote(page, RIGHT);
        const rows = page.locator(".player-menu-column-tracks .player-menu-column-rows");
        const before = await rows.evaluate(node => node.scrollTop);
        assert.ok(before > 0);
        await show(page, playing({ ...TRACKS, subtitles, subtitleTools: { ...ALL_TOOLS, display: { ...ALL_TOOLS.display!, delayMs: 100 } } }));
        assert.equal(await rows.evaluate(node => node.scrollTop), before, "the TRACKS column stays where it was");
        for (let step = 0; step < 6 && await focused(page) !== "subtitle-delay"; step += 1) await remote(page, UP);
        assert.equal(await focused(page), "subtitle-delay");
        await remote(page, ENTER);
        await remote(page, BACK);
        assert.equal(await focused(page), "subtitle-delay");
        assert.equal(await rows.evaluate(node => node.scrollTop), before, "a picker round trip keeps TRACKS where it was");
        await remote(page, LEFT);
        const landed = await focused(page);
        assert.ok(landed !== null && Number(landed.split(":").pop()) > 20, `Left lands on a visible track, not ${landed}`);
    } finally { await page.close(); }
});

test("pickers float over the dimmed pane, track rows carry only a checkmark, and Search and AI rows carry Apple's symbols", async () => {
    const { page } = await open();
    const ai = { available: { translate: true, transcribe: true }, languages: ["fr"], quota: { limited: false, remaining: 0, period: "month" }, busy: false, message: "", results: [] };
    try {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await show(page, playing({ ...TRACKS, ai, aiTranslate: true, subtitleTools: ALL_TOOLS }));
        await page.evaluate(() => document.fonts.ready);
        await openPanel(page);
        await nextTab(page, 4);
        await remote(page, DOWN);
        const rows = await page.evaluate(() => {
            const off = document.querySelector('[data-focus="subtitles-off"]')!;
            const glyph = (id: string): number | undefined => document.querySelector(`[data-focus="${id}"] .player-setting-glyph svg`)?.getBoundingClientRect().width;
            return {
                offWash: getComputedStyle(off).backgroundColor,
                offMark: getComputedStyle(off, "::after").webkitMaskImage.startsWith("url("),
                search: glyph("subtitle-search"), translate: glyph("ai-translate"), transcribe: glyph("ai-transcribe"),
            };
        });
        assert.equal(rows.offWash, "rgba(0, 0, 0, 0)", "HUDTrackRow has no selected wash");
        assert.equal(rows.offMark, true, "the checkmark is a drawn symbol, not a font glyph");
        assert.deepEqual([rows.search, rows.translate, rows.transcribe], [22, 22, 22]);
        await capture(page, "player-subtitles-two-columns");
        await page.locator('[data-focus="subtitle-delay"]').focus();
        await remote(page, ENTER);
        await remote(page, DOWN);
        const dialog = await page.evaluate(() => {
            const box = (selector: string): DOMRect => document.querySelector(selector)!.getBoundingClientRect();
            const style = (selector: string): CSSStyleDeclaration => getComputedStyle(document.querySelector(selector)!);
            return {
                panel: box(".player-menu"), picker: box(".player-menu-picker"),
                behind: style(".player-menu-subtitles .player-menu-behind").opacity,
                title: [style(".player-menu-picker-title").fontSize, style(".player-menu-picker-title").fontWeight],
                option: style('[data-focus="subtitle-picker:-100"]').fontSize,
                selectedWash: style('[data-focus="subtitle-picker:0"]').backgroundColor,
                columnsBehind: document.querySelectorAll(".player-menu-subtitles .player-menu-behind .player-menu-column").length,
            };
        });
        assert.equal(dialog.picker.width, 620);
        assert.equal(Math.round(dialog.picker.left - dialog.panel.left), Math.round(dialog.panel.right - dialog.picker.right), "centred across the panel");
        assert.ok(dialog.picker.top >= dialog.panel.top + 22 - 0.5 && dialog.picker.bottom <= dialog.panel.bottom - 22 + 0.5, "inside the panel's padded content");
        assert.equal(dialog.behind, "0.28");
        assert.equal(dialog.columnsBehind, 2, "TRACKS and OPTIONS stay behind the picker");
        assert.deepEqual(dialog.title, ["30px", "600"]);
        assert.equal(dialog.option, "24px");
        assert.equal(dialog.selectedWash, "rgba(255, 255, 255, 0.14)");
        await capture(page, "player-subtitle-delay-picker");
    } finally { await page.close(); }
});

test("the S95C findings: checkmark, column height, Appearance truncation and glass follow Apple's capture", async () => {
    const { page } = await open();
    // The tracks and options in Apple's capture (evidence/107-subtitle-hud/apple-subtitle-options.png).
    const rows: readonly (readonly [string, string])[] = [["Arabic", "SRT"], ["Chinese", "Traditional · SRT"], ["Czech", "SRT"], ["Danish", "SRT"], ["Dutch", "SRT"], ["English", "SRT"]];
    const subtitles = rows.map(([label, detail], index) => ({ id: `file:42:subtitle:${index}`, label, detail }));
    try {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await show(page, playing({ ...TRACKS, subtitles, subtitleTools: { ...ALL_TOOLS, search: { ...CLOSED_SEARCH, offered: false } } }));
        await page.evaluate(() => document.fonts.ready);
        await openPanel(page);
        await nextTab(page, 4);
        await remote(page, DOWN);
        const measured = await page.evaluate(() => {
            const box = (selector: string): DOMRect => document.querySelector(selector)!.getBoundingClientRect();
            const off = document.querySelector('[data-focus="subtitles-off"]')!;
            const mark = getComputedStyle(off, "::after");
            const appearance = document.querySelector('[data-focus="subtitle-appearance"]')!;
            const value = appearance.querySelector(".player-setting-value") as HTMLElement;
            const panel = getComputedStyle(document.querySelector(".player-menu")!, "::before");
            return {
                mark: [mark.width, mark.height, mark.webkitMaskImage.startsWith("url(")],
                offRight: off.getBoundingClientRect().right,
                panel: box(".player-menu"), rows: box(".player-menu-column-tracks .player-menu-column-rows"), status: box(".player-menu-status"),
                label: appearance.querySelector(".player-setting-label")!.getBoundingClientRect(),
                glyph: appearance.querySelector(".player-setting-glyph")!.getBoundingClientRect(),
                value: value.getBoundingClientRect(), chevron: appearance.querySelector(".player-setting-chevron")!.getBoundingClientRect(),
                truncated: value.scrollWidth > value.clientWidth, row: appearance.getBoundingClientRect(),
                glass: [panel.backgroundColor, panel.backdropFilter],
            };
        });
        // HUDTrackRowLabel's 20pt semibold checkmark: Apple's ink is 17x17 in a 24pt frame at the row's trailing padding.
        assert.deepEqual(measured.mark, ["24px", "24px", true]);
        // PaneColumn rows run to the panel's padded bottom (Apple clips the fifth track there, y 510 of 532).
        assert.equal(Math.round(measured.rows.bottom), Math.round(measured.panel.bottom - 22));
        assert.ok(measured.status.height === 0 || measured.status.top >= measured.panel.bottom, "the status line sits below the panel, not inside its 380px");
        // HUDSettingRowLabel: 28pt textformat frame, 14pt gaps around Spacer(minLength: 18), 10pt to an 11pt chevron.
        assert.equal(Math.round(measured.glyph.width), 28);
        assert.ok(measured.value.left - measured.label.right >= 46 - 0.5, "label and value keep 14 + 18 + 14 apart");
        assert.equal(Math.round(measured.row.right - 14 - measured.chevron.right), 0);
        assert.equal(Math.round(measured.chevron.left - measured.value.right), 10);
        assert.equal(Math.round(measured.chevron.width), 11);
        assert.equal(measured.truncated, true, "Box, Large, Bottom truncates as on Apple TV");
        // siloPlayerGlass over video: Apple's capture passes ~63% of the video and lifts black to 13.
        assert.deepEqual(measured.glass, ["rgba(32, 32, 32, 0.37)", "blur(30px)"]);
        await remote(page, UP);
        await remote(page, UP);
        assert.equal(await focused(page), "tab-subtitles");
        await capture(page, "player-subtitles-apple-state");
    } finally { await page.close(); }
});

test("a Video picker closes first on Back and leaves the Subtitles pane as it was", async () => {
    const { page } = await open();
    const ai = { available: { translate: true, transcribe: false }, languages: ["fr"], quota: undefined, busy: false, message: "", results: [] };
    const hud = { chapters: [], chapterState: "ready" as const, stats: [["Engine", "AVPlay"]] as const, speeds: [1, 2], aspects: ["Fit", "Stretch"] as const, speed: 1, aspect: "Fit" as const, autoNext: true, busy: false };
    try {
        await show(page, { ...playing({ ...TRACKS, ai, aiTranslate: true, subtitleTools: ALL_TOOLS }), hud });
        await openPanel(page);
        await nextTab(page, 4);
        await page.locator('[data-focus="subtitle-appearance"]').focus();
        await remote(page, ENTER);
        assert.equal(await focused(page), "subtitle-appearance-back");
        await remote(page, UP);
        await remote(page, LEFT);
        await remote(page, LEFT);
        await remote(page, DOWN);
        assert.equal(await focused(page), "video-speed");
        await remote(page, ENTER);
        assert.equal(await text(page, ".player-menu-picker-title"), "Playback Speed");
        assert.equal(await page.locator('.player-menu-subtitles [data-focus="subtitle-appearance-back"]').count(), 1, "Subtitles stays on Appearance behind the Video picker");
        await remote(page, BACK);
        assert.equal(await focused(page), "video-speed");
        assert.equal(await page.locator('.player-menu-subtitles [data-focus="subtitle-appearance-back"]').count(), 1, "closing the Video picker keeps Subtitles on Appearance");
        await remote(page, UP);
        await remote(page, RIGHT);
        await remote(page, RIGHT);
        await remote(page, DOWN);
        await remote(page, BACK);
        for (let step = 0; step < 10 && await focused(page) !== "ai-translate"; step += 1) await remote(page, UP);
        assert.equal(await focused(page), "ai-translate");
        await remote(page, ENTER);
        assert.equal(await focused(page), "ai-language-back");
        await remote(page, UP);
        await remote(page, LEFT);
        await remote(page, LEFT);
        await remote(page, DOWN);
        await remote(page, ENTER);
        assert.equal(await text(page, ".player-menu-picker-title"), "Playback Speed");
        await remote(page, BACK);
        assert.equal(await focused(page), "video-speed", "Back closes the open picker before the background AI language list");
        assert.equal(await page.locator('.player-menu-subtitles [data-focus="ai-language-back"]').count(), 1);
        assert.deepEqual(await commands(page), []);
    } finally { await page.close(); }
});

test("Video PLAYBACK lists Quality, Speed and Aspect as picker rows in Apple's order", async () => {
    const { page } = await open();
    const quality = { choices: [{ id: "auto", label: "Auto" }, { id: "1080p", label: "1080p" }], selectedId: "auto" };
    const hud = { chapters: [], chapterState: "ready" as const, stats: [["Engine", "AVPlay"]] as const, speeds: [1, 2], aspects: ["Fit", "Stretch"] as const, speed: 1, aspect: "Fit" as const, autoNext: true, busy: false };
    try {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await show(page, { ...playing({ ...TRACKS, quality, subtitleTools: ALL_TOOLS }), hud });
        await page.evaluate(() => document.fonts.ready);
        await openPanel(page);
        await nextTab(page, 2);
        assert.equal(await focused(page), "video-quality");
        assert.deepEqual(await page.locator(".player-menu-column-playback [data-focus]").evaluateAll(nodes => nodes.map(node => (node as HTMLElement).innerText.replace("\n", " = "))), ["Quality = Auto", "Speed = 1.0×", "Aspect = Fit"]);
        assert.equal(await page.locator(".player-menu-column-playback .player-setting-chevron").count(), 3);
        await capture(page, "player-video-sync");
        await remote(page, DOWN);
        await remote(page, ENTER);
        assert.equal(await text(page, ".player-menu-picker-title"), "Playback Speed");
        assert.deepEqual(await page.locator(".player-menu-picker [data-focus]").evaluateAll(nodes => nodes.map(node => (node as HTMLElement).innerText)), ["1.0×", "2.00×"]);
        await capture(page, "player-video-speed-picker");
        await remote(page, BACK);
        assert.equal(await focused(page), "video-speed");
        assert.deepEqual(await commands(page), []);
    } finally { await page.close(); }
});

test("Video SYNC offers Subtitle delay, which opens the Subtitle Delay picker and returns to its row", async () => {
    const { page } = await open();
    try {
        const hud = { chapters: [], chapterState: "ready" as const, stats: [["Engine", "AVPlay"]] as const, speeds: [1, 2], aspects: ["Fit", "Stretch"] as const, speed: 1, aspect: "Fit" as const, autoNext: true, busy: false };
        await page.emulateMedia({ reducedMotion: "reduce" });
        await show(page, { ...playing({ ...TRACKS, subtitleTools: ALL_TOOLS }), hud });
        await openPanel(page);
        await nextTab(page, 2);
        assert.equal(await focused(page), "video-speed");
        assert.deepEqual(await page.locator(".player-menu-quality .player-menu-column > .player-menu-heading").allTextContents(), ["PLAYBACK", "SYNC"]);
        assert.deepEqual(await page.locator(".player-menu-column-sync [data-focus]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus"))), ["subtitle-video-delay", "auto-next"]);
        assert.equal(await text(page, '[data-focus="subtitle-video-delay"]'), "Subtitle delay\n0 ms");
        assert.equal(await page.locator('[data-focus="subtitle-video-delay"] .player-setting-chevron').count(), 1);
        assert.equal(await page.locator('[data-focus="auto-next"] .player-setting-chevron').count(), 0);
        await remote(page, RIGHT);
        assert.equal(await focused(page), "subtitle-video-delay");
        await remote(page, ENTER);
        assert.equal(await text(page, ".player-menu-quality .player-menu-picker-title"), "Subtitle Delay");
        assert.equal(await focused(page), "subtitle-picker:0");
        await remote(page, DOWN);
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ['subtitleTool {"kind":"delay","milliseconds":100}']);
        assert.equal(await focused(page), "subtitle-video-delay");
        await remote(page, ENTER);
        await remote(page, BACK);
        assert.equal(await focused(page), "subtitle-video-delay", "Back closes the picker onto its row");
        assert.equal((await commands(page)).length, 1);
    } finally { await page.close(); }
});

for (const [trigger, heading] of [["subtitle-delay", "Subtitle Delay"], ["subtitle-size", "Subtitle Size"], ["subtitle-position", "Subtitle Position"], ["subtitle-appearance:fontColor", "Text Color"]] as const) {
    test(`the ${heading} picker keeps its heading in the panel while its options scroll`, async () => {
        const { page } = await open();
        const tracks: TrackView = { ...TRACKS, subtitleTools: {
            search: { offered: true, unavailableReason: "", phase: "closed", suggested: [], other: [], language: undefined, status: "", message: "", warnings: [], canRetry: false, results: [], downloadingKey: undefined },
            display: { delay: true, styling: true, deviceScope: true, textOpacity: true, delayMs: 0, appearance: DEFAULT_APPEARANCE, deviceOverride: false, busy: false, message: "" },
            overlay: true,
        } };
        try {
            await page.emulateMedia({ reducedMotion: "reduce" });
            await show(page, playing(tracks));
            await page.evaluate(() => document.fonts.ready);
            await openPanel(page);
            await nextTab(page, 4);
            if (trigger.startsWith("subtitle-appearance:")) {
                await page.locator('[data-focus="subtitle-appearance"]').focus();
                await remote(page, ENTER);
            }
            await page.locator(`[data-focus="${trigger}"]`).focus();
            await remote(page, ENTER);
            const geometry = await page.evaluate(() => {
                const box = (node: Element | null): DOMRect | undefined => node?.getBoundingClientRect();
                const panel = box(document.querySelector(".player-menu"));
                const pane = document.querySelector(".player-menu-subtitles");
                const heading = box(pane?.querySelector(".player-menu-picker-title") ?? null);
                const focus = box(document.activeElement);
                const options = pane?.querySelector(".player-menu-picker-options");
                return { panel, heading, focus, headingText: pane?.querySelector(".player-menu-picker-title")?.textContent, paneScroll: pane?.scrollTop ?? -1, scrolled: (options?.scrollTop ?? 0) > 0, overflows: options !== null && options !== undefined && options.scrollHeight > options.clientHeight };
            });
            assert.equal(geometry.headingText, heading);
            assert.ok(geometry.panel && geometry.heading && geometry.focus);
            assert.equal(geometry.paneScroll, 0);
            assert.ok(geometry.heading.top >= geometry.panel.top && geometry.heading.bottom <= geometry.panel.bottom, "heading is inside the panel");
            assert.ok(geometry.focus.top >= geometry.heading.bottom && geometry.focus.bottom <= geometry.panel.bottom, "focused option sits below the heading, inside the panel");
            if (trigger === "subtitle-delay") {
                assert.equal(await focused(page), "subtitle-picker:0");
                assert.ok(geometry.overflows && geometry.scrolled, "the middle delay value scrolls the options, not the heading");
            }
        } finally { await page.close(); }
    });
}

test("an unavailable subtitle row says why, stays focusable and Select does nothing", async () => {
    const { page } = await open();
    try {
        const subtitles = [{ id: "file:42:subtitle:0", label: "English" }, { id: "file:42:subtitle:1", label: "Japanese", detail: "Unsupported format", unavailable: true }];
        await show(page, playing({ ...TRACKS, subtitles }));
        await openAudio(page);
        await nextTab(page, 1);
        await remote(page, DOWN);
        await remote(page, DOWN);
        await remote(page, DOWN);
        assert.equal(await focused(page), "file:42:subtitle:1", "focus can rest on the row so the reason is readable");
        assert.equal(await page.locator('[data-focus="file:42:subtitle:1"]').getAttribute("aria-disabled"), "true");
        assert.equal(await page.locator('[data-focus="file:42:subtitle:0"]').getAttribute("aria-disabled"), "false");
        assert.match(await text(page, '[data-focus="file:42:subtitle:1"]'), /Unsupported format/);
        const before = await commands(page);
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), before);
        await remote(page, UP);
        await remote(page, ENTER);
        assert.deepEqual((await commands(page)).slice(before.length), ["selectSubtitle file:42:subtitle:0"]);
    } finally { await page.close(); }
});

test("an unavailable AI result says why, stays focusable and Select does nothing", async () => {
    const { page } = await open();
    const ai = { available: { translate: false, transcribe: false }, languages: [], quota: undefined, busy: false, message: "", results: [{ id: "opaque-result", label: "AI-transcribed", unavailable: true }] };
    try {
        await show(page, playing({ ...TRACKS, ai }));
        await openAudio(page);
        await nextTab(page, 1);
        for (let index = 0; index < TRACKS.subtitles.length + 2; index++) await remote(page, DOWN);
        assert.equal(await focused(page), "ai-result:opaque-result");
        assert.equal(await page.locator('[data-focus="ai-result:opaque-result"]').getAttribute("aria-disabled"), "true");
        assert.match(await text(page, '[data-focus="ai-result:opaque-result"]'), /Unsupported format/);
        const before = await commands(page);
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), before);
    } finally { await page.close(); }
});
