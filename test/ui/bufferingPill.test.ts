// The buffering prompt, undo pill and notices on the player screen, over stub controls.
// Copy, order and timing follow silo-apple's PlayerBufferingPillCard, TVBufferingQualityPill and
// PlayerNoticeOverlay. Desktop Chromium is not the TV's Chromium 108: this proves behavior and
// layout, not TV rendering.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { type Browser, chromium, type Page } from "playwright";
import type { PlaybackView } from "../../src/player/controller.ts";
import type { BufferingNoticeView, BufferingPillView } from "../../src/player/bufferingBridge.ts";

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
const DOWN = 40;

const NO_TRACKS = { audio: { state: "loading" as const }, selectedAudioId: undefined, subtitles: [], selectedSubtitleId: undefined, subtitleMode: "off" as const, change: { state: "idle" as const }, notices: [] };
const PROMPT: BufferingPillView = { kind: "prompt", remainingMs: 15_000, totalMs: 15_000, running: true, revision: 1 };
const UNDO: BufferingPillView = { kind: "undo", remainingMs: 15_000, totalMs: 15_000, running: true, revision: 1 };
const LOWERED: BufferingNoticeView = { text: "Quality lowered to stop buffering", lowered: true };
const CANT_LOWER: BufferingNoticeView = { text: "Can't lower quality for this video", lowered: false };

const playing = (extra: { bufferingPill?: BufferingPillView; bufferingNotice?: BufferingNoticeView; buffering?: boolean } = {}): Extract<PlaybackView, { phase: "playing" | "paused" }> => ({
    phase: "playing", title: "The Movie", positionSeconds: 754, durationSeconds: 7200, buffering: true, seekIntervals: { backward: 10, forward: 10 }, tracks: NO_TRACKS, ...extra,
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

async function open(): Promise<{ page: Page; logs: string[] }> {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const logs: string[] = [];
    page.on("console", (message) => logs.push(message.text()));
    page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));
    await page.route("**/*", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/fonts/InterVariable.woff2") {
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
    await page.clock.install({ time: new Date("2026-11-05T00:00:00Z") });
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await page.goto(`${ORIGIN}/index.html`);
    return { page, logs };
}

const remote = (page: Page, keyCode: number): Promise<void> => page.evaluate((code) => {
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { keyCode: code, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { keyCode: code, bubbles: true, cancelable: true }));
}, keyCode);
const show = (page: Page, view: PlaybackView): Promise<void> => page.evaluate((next) => window.player.show(next), view);
const commands = (page: Page): Promise<string[]> => page.evaluate(() => window.player.commands.slice());
const focused = (page: Page): Promise<string | null> => page.evaluate(() => document.activeElement?.getAttribute("data-focus") ?? null);
const visibleText = (page: Page, selector: string): Promise<string | null> => page.locator(selector).isVisible().then(visible => visible ? page.locator(selector).innerText() : null);
const dismissing = (page: Page, value: boolean): Promise<void> => page.evaluate((next) => { window.player.dismissesBufferingPill = next; }, value);

/** Saves a capture outside the repository when PLAYER_CAPTURE_DIR is set, for the pull request's evidence. */
async function capture(page: Page, name: string): Promise<void> {
    const dir = process.env.PLAYER_CAPTURE_DIR;
    if (dir !== undefined) {
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation instanceof CSSTransition).map(animation => animation.finished)));
        await page.screenshot({ path: `${dir}/${name}.png` });
    }
}

test("the prompt says Playback keeps buffering with Lower quality and Keep quality, and the undo says Quality lowered to stop buffering with Restore quality", async () => {
    const { page, logs } = await open();
    try {
        await show(page, playing());
        assert.equal(await visibleText(page, ".player-buffering"), null);
        await capture(page, "buffering-none");

        await show(page, playing({ bufferingPill: PROMPT }));
        assert.equal(await page.locator(".player-buffering .player-alert-title").innerText(), "Playback keeps buffering");
        assert.equal(await page.locator(".player-buffering .player-alert-detail").innerText(), "Try a lower quality to keep watching");
        assert.deepEqual(await page.locator(".player-buffering-action:visible").allInnerTexts(), ["Lower quality", "Keep quality"]);
        assert.equal(await page.locator(".player-buffering").getAttribute("aria-label"), "Playback keeps buffering");
        await capture(page, "buffering-prompt");

        await show(page, playing({ bufferingPill: UNDO }));
        assert.equal(await page.locator(".player-buffering .player-alert-title").innerText(), "Quality lowered to stop buffering");
        assert.equal(await page.locator(".player-buffering .player-alert-detail").isVisible(), false);
        assert.deepEqual(await page.locator(".player-buffering-action:visible").allInnerTexts(), ["Restore quality"]);
        await capture(page, "buffering-undo");

        await show(page, playing());
        assert.equal(await visibleText(page, ".player-buffering"), null);
        assert.deepEqual(logs, []);
    } finally { await page.close(); }
});

interface Legibility { label: string; text: string; background: string; ratio: number }

/**
 * The label's colour against the fill actually behind it. Every translucent fill from the page down is
 * composited over white, the harness's page and the least favourable picture behind the card.
 */
const legibility = async (page: Page, selector: string): Promise<Legibility> => {
    // Colours ease in over 180 ms; measure where they settle, not partway.
    await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation instanceof CSSTransition).map(animation => animation.finished)));
    return page.locator(selector).evaluate((node): Legibility => {
        type Rgba = [number, number, number, number];
        const parse = (value: string): Rgba => {
            const [r = 0, g = 0, b = 0, a = 1] = (value.match(/[\d.]+/g) ?? []).map(Number);
            return [r, g, b, a];
        };
        const over = (top: Rgba, below: [number, number, number]): [number, number, number] => [0, 1, 2].map(i => (top[i] ?? 0) * top[3] + (below[i] ?? 0) * (1 - top[3])) as [number, number, number];
        const luminance = (rgb: [number, number, number]): number => {
            const [r = 0, g = 0, b = 0] = rgb.map(channel => {
                const unit = channel / 255;
                return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const chain: Element[] = [];
        for (let at: Element | null = node; at !== null; at = at.parentElement) chain.unshift(at);
        let background: [number, number, number] = [255, 255, 255];
        for (const element of chain) background = over(parse(getComputedStyle(element).backgroundColor), background);
        const text = over(parse(getComputedStyle(node).color), background);
        const [light, dark] = [luminance(text), luminance(background)].sort((a, b) => b - a);
        return {
            label: (node.textContent ?? "").trim(),
            text: getComputedStyle(node).color,
            background: getComputedStyle(node).backgroundColor,
            ratio: ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05),
        };
    });
};

const MIN_CONTRAST = 4.5;

function assertLegible(found: Legibility, expectedLabel: string, state: string): void {
    assert.equal(found.label, expectedLabel, `${state}: the label is drawn`);
    assert.ok(found.ratio >= MIN_CONTRAST, `${state}: ${found.text} on ${found.background} has contrast ${found.ratio.toFixed(2)}, below ${MIN_CONTRAST}`);
}

// Apple's TVPlayerPillButtonStyle: a black .65 capsule at every state, with a white label, fully white when focused.
const APPLE_PILL_FILL = "rgba(0, 0, 0, 0.65)";
const APPLE_FOCUSED_LABEL = "rgb(255, 255, 255)";

test("every button state in the prompt and the undo pill keeps a legible label on Apple's dark capsule", async () => {
    const { page } = await open();
    try {
        await show(page, playing());
        await show(page, playing({ bufferingPill: PROMPT }));
        assert.equal(await focused(page), "buffering-primary");
        const primary = '[data-focus="buffering-primary"]';
        const keep = '[data-focus="buffering-keep"]';

        const focusedPrimary = await legibility(page, primary);
        assertLegible(focusedPrimary, "Lower quality", "focused first button");
        assert.equal(focusedPrimary.text, APPLE_FOCUSED_LABEL, "the focused label is Apple's white");
        assert.equal(focusedPrimary.background, APPLE_PILL_FILL, "the focused fill is Apple's black capsule, not the generic white focus fill");
        assertLegible(await legibility(page, keep), "Keep quality", "unfocused second button");

        await remote(page, RIGHT);
        const focusedKeep = await legibility(page, keep);
        assertLegible(focusedKeep, "Keep quality", "focused second button");
        assert.equal(focusedKeep.text, APPLE_FOCUSED_LABEL);
        assert.equal(focusedKeep.background, APPLE_PILL_FILL);
        assertLegible(await legibility(page, primary), "Lower quality", "unfocused first button");

        await show(page, playing({ bufferingPill: PROMPT, buffering: false }));
        await page.clock.runFor(6000);
        await remote(page, LEFT);
        assert.equal(await page.locator(".player-buffering-lit").innerText(), "Lower quality");
        const litPrimary = await legibility(page, primary);
        assertLegible(litPrimary, "Lower quality", "first button lit as Select's target");
        assert.equal(litPrimary.text, APPLE_FOCUSED_LABEL);
        assert.equal(litPrimary.background, APPLE_PILL_FILL);

        await show(page, playing({ bufferingPill: UNDO }));
        assertLegible(await legibility(page, primary), "Restore quality", "undo pill's button");
    } finally { await page.close(); }
});

test("the notices and the card's own copy keep a legible label", async () => {
    const { page } = await open();
    try {
        await show(page, playing({ bufferingNotice: LOWERED, bufferingPill: PROMPT }));
        assertLegible(await legibility(page, ".player-alert-notice .player-alert-title"), "Quality lowered to stop buffering", "lowered notice");
        assertLegible(await legibility(page, ".player-buffering .player-alert-title"), "Playback keeps buffering", "prompt title");
        assertLegible(await legibility(page, ".player-buffering .player-alert-detail"), "Try a lower quality to keep watching", "prompt detail");
        await show(page, playing({ bufferingNotice: CANT_LOWER }));
        assertLegible(await legibility(page, ".player-alert-notice .player-alert-title"), "Can't lower quality for this video", "cannot-lower notice");
    } finally { await page.close(); }
});

test("the notices say Quality lowered to stop buffering and Can't lower quality for this video, above the pill, with no buttons", async () => {
    const { page } = await open();
    try {
        await show(page, playing({ bufferingNotice: LOWERED }));
        assert.equal(await visibleText(page, ".player-alert-notice"), "Quality lowered to stop buffering");
        assert.equal(await page.locator(".player-alert-notice button").count(), 0);
        await capture(page, "buffering-notice-lowered");
        await show(page, playing({ bufferingNotice: CANT_LOWER }));
        assert.equal(await visibleText(page, ".player-alert-notice"), "Can't lower quality for this video");
        await capture(page, "buffering-notice-cant-lower");
        await show(page, playing({ bufferingNotice: LOWERED, bufferingPill: PROMPT }));
        const tops = await page.evaluate(() => [".player-alert-notice", ".player-buffering"].map(selector => document.querySelector(selector)?.getBoundingClientRect().top ?? -1));
        assert.ok(tops[0] !== undefined && tops[1] !== undefined && tops[0] >= 0 && tops[0] < tops[1], `notice above pill: ${tops.join(",")}`);
        await capture(page, "buffering-notice-and-prompt");
        await show(page, playing());
        assert.equal(await visibleText(page, ".player-alert-notice"), null);
    } finally { await page.close(); }
});

test("the pill and notice also show over the loading screen of a lowered plan", async () => {
    const { page } = await open();
    try {
        await show(page, { phase: "loading", title: "The Movie", bufferingPill: UNDO, bufferingNotice: LOWERED });
        assert.equal(await visibleText(page, ".player-buffering .player-alert-title"), "Quality lowered to stop buffering");
        assert.deepEqual(await page.locator(".player-buffering-action:visible").allInnerTexts(), ["Restore quality"]);
        await capture(page, "buffering-loading-undo");
    } finally { await page.close(); }
});

test("sits at the top-trailing corner, 760px wide at most, with the countdown on its bottom edge", async () => {
    const { page } = await open();
    try {
        await show(page, playing({ bufferingPill: PROMPT }));
        const box = await page.locator(".player-buffering").evaluate(node => {
            const r = node.getBoundingClientRect();
            return { top: r.top, right: 1920 - r.right, width: r.width, bottom: r.bottom };
        });
        assert.ok(box.top < 200, `top ${box.top}`);
        assert.equal(box.right, 80);
        assert.ok(box.width <= 760, `width ${box.width}`);
        const track = await page.locator(".player-buffering-track").evaluate(node => ({ bottom: node.getBoundingClientRect().bottom, height: node.getBoundingClientRect().height }));
        assert.equal(track.height, 4);
        assert.ok(Math.abs(track.bottom - box.bottom) < 0.5);
    } finally { await page.close(); }
});

test("the countdown restarts from where the controller's timer stands and holds while it is frozen", async () => {
    const { page } = await open();
    try {
        await show(page, playing({ bufferingPill: { ...PROMPT, remainingMs: 9000, revision: 4 } }));
        const fill = page.locator(".player-buffering-fill");
        assert.equal(await fill.evaluate(node => getComputedStyle(node).animationDuration), "15s");
        assert.equal(await fill.evaluate(node => getComputedStyle(node).animationDelay), "-6s");
        assert.equal(await fill.evaluate(node => getComputedStyle(node).animationPlayState), "running");
        await show(page, playing({ bufferingPill: { ...PROMPT, remainingMs: 9000, revision: 5, running: false } }));
        assert.equal(await fill.evaluate(node => getComputedStyle(node).animationPlayState), "paused");
    } finally { await page.close(); }
});

test("with the controls hidden Select acts on the prompt, Left and Right choose the button, and Back is the pill's", async () => {
    const { page } = await open();
    try {
        await show(page, playing({ bufferingPill: PROMPT, buffering: false }));
        await page.clock.runFor(6000);
        assert.equal(await page.locator(".player-overlay-hidden").count(), 1, "the controls are hidden");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["selectBufferingPrimary"]);
        await remote(page, RIGHT);
        assert.equal(await page.locator(".player-buffering-lit").innerText(), "Keep quality");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["selectBufferingPrimary", "selectBufferingKeep"]);
        await remote(page, LEFT);
        assert.equal(await page.locator(".player-buffering-lit").innerText(), "Lower quality");
        await dismissing(page, true);
        await remote(page, BACK);
        assert.deepEqual((await commands(page)).slice(2), ["dismissBufferingPill"]);
        assert.equal(await page.locator(".player-overlay-hidden").count(), 1, "Back that took the pill does not reveal the controls");
    } finally { await page.close(); }
});

test("the undo pill's one button is Select's target, and Left and Right still scrub", async () => {
    const { page } = await open();
    try {
        await show(page, playing({ bufferingPill: UNDO, buffering: false }));
        await page.clock.runFor(6000);
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["selectBufferingPrimary"]);
        await remote(page, RIGHT);
        assert.equal(await focused(page), "position");
    } finally { await page.close(); }
});

test("a pill that appears with the controls up takes focus on its first button, Left and Right move between them and Down returns to the transport", async () => {
    const { page } = await open();
    try {
        await show(page, playing());
        await show(page, playing({ bufferingPill: PROMPT }));
        assert.equal(await focused(page), "buffering-primary", "Select would act on the pill, not the scrubber");
        await remote(page, RIGHT);
        assert.equal(await focused(page), "buffering-keep");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["selectBufferingKeep"]);
        await remote(page, LEFT);
        assert.equal(await focused(page), "buffering-primary");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["selectBufferingKeep", "selectBufferingPrimary"]);
        await remote(page, DOWN);
        assert.equal(await page.evaluate(() => document.activeElement?.closest(".player-transport") !== null), true);
        await show(page, playing());
        assert.notEqual(await focused(page), "buffering-primary");
        assert.notEqual(await focused(page), null);
    } finally { await page.close(); }
});

test("while a plan loads Select, Left and Right act on the pill, and Back is the pill's", async () => {
    const { page } = await open();
    try {
        await show(page, { phase: "loading", title: "The Movie", bufferingPill: PROMPT });
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["selectBufferingPrimary"]);
        await remote(page, RIGHT);
        assert.equal(await page.locator(".player-buffering-lit").innerText(), "Keep quality");
        await remote(page, ENTER);
        assert.deepEqual(await commands(page), ["selectBufferingPrimary", "selectBufferingKeep"]);
        await dismissing(page, true);
        await remote(page, BACK);
        assert.deepEqual((await commands(page)).slice(2), ["dismissBufferingPill"]);
    } finally { await page.close(); }
});

test("a skip pill is reported so the buffering pill can wait for it", async () => {
    const { page } = await open();
    try {
        assert.equal(await page.evaluate(() => window.player.skipPillShown), false);
        await show(page, { ...playing(), skipMarker: { kind: "recap", startSeconds: 0, endSeconds: 15 }, positionSeconds: 5 });
        assert.equal(await page.evaluate(() => window.player.skipPillShown), true);
        await show(page, playing());
        assert.equal(await page.evaluate(() => window.player.skipPillShown), false);
    } finally { await page.close(); }
});
