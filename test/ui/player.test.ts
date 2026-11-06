// The player screen in Chromium with stub controls: remote keys, focus and readable states.
// Desktop Chromium is not the TV's Chromium 108; this proves behavior, not TV rendering.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { type Browser, chromium, type Page } from "playwright";
import type { PlaybackView, TrackView } from "../../src/player/controller.ts";
import { DEFAULT_APPEARANCE } from "../../src/contracts/v2/subtitles.ts";
import { readLive } from "./support/tv.ts";

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
    await page.clock.pauseAt(time);
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
    await remote(page, RIGHT);
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

test("transport focus re-arms five seconds then hides and hidden Up does nothing", async () => {
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
        assert.equal(await page.locator(".player-overlay-hidden").count(), 1);
    } finally { await page.close(); }
});

test("hidden Down opens Info and hidden Right returns to scrubber", async () => {
    const { page } = await open();
    try {
        await show(page, playing(TRACKS));
        await page.clock.runFor(5000);
        await remote(page, DOWN);
        assert.equal(await page.locator(".player-hud").isVisible(), true);
        await remote(page, BACK);
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
        assert.equal(await focused(page), "tab-info");
        await show(page, playing({ ...TRACKS, notices: ["Updated"] }));
        assert.equal(await focused(page), "tab-info");
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

test("episode footer shows series, title and episode tag without an empty status row", async () => {
    const { page } = await open();
    try {
        await show(page, { ...playing(TRACKS), title: "Going Green", ...{ seriesTitle: "The Series", seasonNumber: 1, episodeNumber: 25 } });
        assert.equal(await page.locator(".player-series").textContent(), "The Series");
        assert.equal(await page.locator(".player-title").first().textContent(), "Going Green");
        assert.equal(await page.locator(".player-episode").textContent(), "S1 · E25");
        assert.equal(await page.locator(".player-status").isVisible(), false);
    } finally { await page.close(); }
});

test("Info panel measured placement and Up Down Menu focus", async () => {
    const { page } = await open();
    try {
        await show(page, playing(TRACKS));
        await page.clock.runFor(5000);
        await remote(page, DOWN);
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
        await openPanel(page);
        await remote(page, RIGHT);
        await remote(page, RIGHT);
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
        await openPanel(page);
        await remote(page, RIGHT);
        await remote(page, RIGHT);
        for (let index = 0; index < TRACKS.subtitles.length + 1; index++) await remote(page, DOWN);
        assert.equal(await focused(page), "ai-translate");
        await remote(page, ENTER);
        await remote(page, DOWN);
        assert.equal(await focused(page), "ai-language:fr");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["startSubtitleAI translate fr"]);
        for (let index = 0; index < TRACKS.subtitles.length + 2; index++) await remote(page, DOWN);
        assert.equal(await focused(page), "ai-transcribe");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["startSubtitleAI translate fr"], "exhausted quota does not dispatch transcription");
        assert.match(await page.locator(".player-menu-status").innerText(), /Quota exhausted/);
        await remote(page, DOWN);
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

test("Skip counts down, activates with Enter or Play, and returns focus without taking manual seeks", async () => {
    const { page, logs } = await open();
    const view = { ...playing(TRACKS), positionSeconds: 25, skipMarker: { kind: "intro" as const, startSeconds: 20, endSeconds: 60 } };
    try {
        await show(page, view);
        // Old focus was "player". A visible skip pill takes first focus, as on Apple TV.
        assert.equal(await focused(page), "skip");
        assert.equal(await text(page, ".player-skip"), "Skip intro · 35 seconds");
        await page.clock.runFor(6000);
        assert.equal(await page.locator(".player-skip").isVisible(), true);
        await remote(page, UP);
        assert.equal(await focused(page), "skip");
        await show(page, { ...view, positionSeconds: 26.5 });
        assert.equal(await text(page, ".player-skip"), "Skip intro · 34 seconds");
        assert.equal(await focused(page), "skip");
        // Hidden Down opens Info; Left reveals the transport before testing visible Down.
        await remote(page, LEFT);
        await remote(page, BACK);
        await remote(page, DOWN);
        assert.equal(await focused(page), "pause");
        await remote(page, UP);
        // Old path: Up returned to Skip, and Back from Skip returned to Pause.
        assert.equal(await focused(page), "position");
        assert.deepEqual(await commands(page), []);
        await remote(page, UP);
        assert.equal(await focused(page), "skip");
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
        // Old focus was "player" after the pill left. Focus returns to the scrubber.
        assert.equal(await focused(page), "position");
        // Old Up from the scrubber focused Pause. Down does that now.
        await remote(page, DOWN);
        assert.equal(await focused(page), "pause");
        assert.deepEqual(logs, []);
    } finally { await page.close(); }
});

test("Enter on the default focus skips while a marker shows and pauses otherwise", async () => {
    const { page, logs } = await open();
    const view = { ...playing(TRACKS), positionSeconds: 25, skipMarker: { kind: "intro" as const, startSeconds: 20, endSeconds: 60 } };
    try {
        await show(page, view);
        // Old focus was "player". The skip pill is the select target while it shows.
        assert.equal(await focused(page), "skip");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["seekToSeconds 60"]);
        await show(page, { ...playing(TRACKS), positionSeconds: 60 });
        await remote(page, ENTER);
        // Old command was togglePause. Select on the scrubber enters timeline scrub and pauses.
        assert.deepEqual(await commands(page), ["seekToSeconds 60", "setPaused true"]);
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
        assert.deepEqual(await page.locator(".player-tab:not([hidden])").allTextContents(), ["Info", "Audio", "Subtitles"]);
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
        assert.equal(await text(page, ".player-status"), "Paused");
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
        // Old Down opened the panel.
        await openPanel(page);
        const panel = await page.locator(".player-menu").evaluate((node) => {
            const style = getComputedStyle(node);
            const box = node.getBoundingClientRect();
            return { width: box.width, height: box.height, radius: style.borderTopLeftRadius, border: style.borderTopColor, shadow: style.boxShadow };
        });
        assert.equal(panel.width, 1100);
        assert.equal(panel.height, 380);
        assert.equal(panel.radius, "28px");
        assert.equal(panel.border, "rgba(255, 255, 255, 0.14)");
        assert.match(panel.shadow, /rgba\(0, 0, 0, 0\.5\)/);
        // Old tabs were Audio, Subtitles, Video. Info leads, and Video follows Subtitles.
        assert.deepEqual(await page.locator(".player-tab:not([hidden])").allTextContents(), ["Info", "Audio", "Subtitles", "Video"]);
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
    } finally {
        await page.close();
    }
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

test("the remote crosses Audio while its choices are loading", async () => {
    const { page } = await open();
    try {
        await show(page, playing({ ...TRACKS, audio: { state: "loading" } }));
        await openPanel(page);
        await remote(page, RIGHT);
        assert.equal(await focused(page), "subtitles-off");
        await remote(page, LEFT);
        assert.equal(await focused(page), "info");
    } finally { await page.close(); }
});

test("Select activates a late Skip prompt while controls are hidden", async () => {
    const { page } = await open();
    try {
        await show(page, playing(TRACKS));
        await page.clock.runFor(6000);
        await show(page, { ...playing(TRACKS), positionSeconds: 25, skipMarker: { kind: "intro", startSeconds: 20, endSeconds: 60 } });
        assert.equal(await focused(page), "position");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["seekToSeconds 60"]);
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
        await remote(page, RIGHT);
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
        // Old path was Down then Right, from an Audio panel. Info is the first tab now.
        await openPanel(page);
        await remote(page, RIGHT);
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
        // Old path was Down then Right, from an Audio panel. Info is the first tab now.
        await openPanel(page);
        await remote(page, RIGHT);
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
        // Old path was Down, Right, Right from an Audio panel. Info is the first tab now.
        await openAudio(page);
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
        // Old focus was the first audio row. Info is the first usable pane when Video disappears.
        assert.equal(await focused(page), "info", "disappearing quality hands focus to a usable list");
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
        // Old path was Down, Right, Right from an Audio panel. Video is the tab after Subtitles.
        await openPanel(page);
        await remote(page, RIGHT);
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

test("an empty audio list does not trap remote movement between Info and Subtitles", async () => {
    const { page, logs } = await open();
    try {
        await show(page, playing({ ...TRACKS, audio: { state: "ready", choices: [] }, selectedAudioId: undefined }));
        await openPanel(page);
        assert.equal(await focused(page), "info");
        await remote(page, RIGHT);
        assert.equal(await focused(page), "audio-empty");
        assert.match(await text(page, ".player-menu-audio"), /No audio tracks listed/);
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), []);
        await remote(page, RIGHT);
        assert.equal(await focused(page), "subtitles-off");
        await remote(page, LEFT);
        assert.equal(await focused(page), "audio-empty");
        await remote(page, LEFT);
        assert.equal(await focused(page), "info");
        assert.deepEqual(logs, []);
    } finally {
        await page.close();
    }
});
