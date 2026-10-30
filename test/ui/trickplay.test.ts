import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { before, after, test } from "node:test";
import { build } from "esbuild";
import { chromium, type Browser, type Page, type Request } from "playwright";
import { ManualClock } from "../native/support/clock.ts";
import { FakeSilo, fixture } from "../native/support/fakeSilo.ts";
import { FakePlayback } from "../native/support/fakePlayback.ts";
import { FakeTrickplay } from "../native/support/fakeTrickplay.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { SEEK_BACK_KEY, SEEK_FORWARD_KEY } from "../../src/contracts/v2/settings.ts";

const ORIGIN = "https://silo.example.test";
const CAPTURE = process.env.TRICKPLAY_CAPTURE_DIR;
const BASELINE = process.env.TRICKPLAY_BASELINE_ROOT;
const CSS_ROOT = BASELINE ?? new URL("../../", import.meta.url).pathname;
const CSS = ["src/theme.css", "src/player/player.css"].map((path) => readFileSync(join(CSS_ROOT, path), "utf8")).join("\n");
const HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Silo</title><link rel="stylesheet" href="app.css"></head><body style="margin:0;background:#000"><main id="root"></main><script src="harness.js"></script></body></html>';
let browser: Browser;
let script: string;
const sprites = new Map<number, Buffer>();

before(async () => {
    const workspace = new URL("../../", import.meta.url).pathname;
    const built = await build({ entryPoints: [new URL("./trickplayHarness.ts", import.meta.url).pathname], bundle: true, format: "iife", target: "chrome76", write: false,
        plugins: BASELINE === undefined ? [] : [{ name: "matched-base", setup(build) {
            build.onResolve({ filter: /\.ts$/ }, (args) => {
                const path = resolve(dirname(args.importer), args.path);
                return path.startsWith(join(workspace, "src/")) ? { path: join(BASELINE, path.slice(workspace.length)) } : undefined;
            });
        } }], logLevel: "silent" });
    script = built.outputFiles[0]?.text ?? "";
    browser = await chromium.launch();
    const page = await browser.newPage();
    for (const sheet of [0, 1, 10]) {
        const encoded = await page.evaluate((sheetIndex) => {
            const canvas = document.createElement("canvas");
            canvas.width = 3000;
            canvas.height = 1260;
            const ctx = canvas.getContext("2d");
            if (ctx === null) throw new Error("Missing canvas");
            ctx.fillStyle = "black";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            for (let cell = 0; cell < 100; cell++) {
                const index = sheetIndex * 100 + cell;
                if (index >= 1020) break;
                const x = (cell % 10) * 300;
                const y = Math.floor(cell / 10) * 126;
                ctx.fillStyle = `hsl(${(index * 29) % 360},45%,24%)`;
                ctx.fillRect(x, y, 300, 126);
                ctx.fillStyle = "rgba(255,255,255,.14)";
                ctx.fillRect(x + 16, y + 16, 268, 4);
                ctx.fillStyle = "white";
                ctx.font = "bold 28px sans-serif";
                ctx.fillText(`Frame ${index}`, x + 20, y + 64);
                ctx.font = "20px sans-serif";
                ctx.fillText(`${index * 10}s`, x + 20, y + 99);
            }
            return canvas.toDataURL("image/jpeg", 0.9).split(",")[1] ?? "";
        }, sheet);
        sprites.set(sheet, Buffer.from(encoded, "base64"));
        if (CAPTURE !== undefined) { mkdirSync(CAPTURE, { recursive: true }); writeFileSync(join(CAPTURE, `sprite-${sheet}.jpg`), sprites.get(sheet) ?? Buffer.alloc(0)); }
    }
    await page.close();
});
after(async () => { await browser.close(); });

async function open(timelineOffset = 0, intervals?: { backward: number; forward: number }) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 },
        ...(CAPTURE === undefined ? {} : { recordVideo: { dir: join(CAPTURE, "journeys"), size: { width: 1920, height: 1080 } } }) });
    const page = await context.newPage();
    const clock = new ManualClock();
    const fake = new FakeSilo(clock);
    const playback = new FakePlayback(fake);
    if (intervals !== undefined) {
        const settings = new FakeSettings(fake);
        settings.profile().set(SEEK_BACK_KEY, intervals.backward);
        settings.profile().set(SEEK_FORWARD_KEY, intervals.forward);
    }
    const previews = new FakeTrickplay(fake, clock);
    fake.script("/playback/capabilities", { status: 200, body: { ...fixture("playback_capability_available"), features: ["trickplay_v1"] } });
    playback.next.push({ timeline: { source_start_seconds: 1225, player_start_seconds: 1225 - timelineOffset, timeline_offset_seconds: timelineOffset },
        availableQualities: [{ label: "720p", bitrate_kbps: 4000, preserves_source: false }] });
    const sheets: { url: string; headers: Record<string, string> }[] = [];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let sheetStatus = 200;
    let offline = false;
    let holdImage: (() => Promise<void>) | undefined;
    await page.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname.endsWith(".jpg")) {
            sheets.push({ url: request.url(), headers: await request.allHeaders() });
            const hold = holdImage;
            holdImage = undefined;
            if (hold !== undefined) await hold();
            if (offline) { await route.abort("internetdisconnected"); return; }
            const index = Number(/\/(\d+)\.9913\.jpg$/.exec(url.pathname)?.[1] ?? "1");
            await route.fulfill({ status: sheetStatus, contentType: sheetStatus === 200 ? "image/jpeg" : "application/problem+json",
                body: sheetStatus === 200 ? (sprites.get(index) ?? sprites.get(1) ?? Buffer.alloc(0)) : JSON.stringify({ status: sheetStatus, title: "Synthetic signed image unavailable" }) }).catch(() => undefined);
            return;
        }
        if (url.origin !== ORIGIN) { await route.abort(); return; }
        const body = url.pathname === "/tv/index.html" ? HTML : url.pathname === "/tv/app.css" ? CSS : url.pathname === "/tv/harness.js" ? script : undefined;
        if (body !== undefined) { await route.fulfill({ contentType: url.pathname.endsWith(".css") ? "text/css" : url.pathname.endsWith(".js") ? "application/javascript" : "text/html", body }); return; }
        if (request.method() === "OPTIONS") { await route.fulfill({ status: 405 }); return; }
        const data = request.postData();
        const response = await fake.fetch(request.url(), { method: request.method(), headers: await request.allHeaders(), ...(data === null ? {} : { body: data }) });
        await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers.entries()), body: await response.text() }).catch(() => undefined);
    });
    await page.clock.install({ time: clock.now() });
    await page.goto(`${ORIGIN}/tv/index.html`);
    await page.evaluate(() => window.trickplay.connect());
    await page.waitForFunction(() => window.trickplay.loginPhase === "waiting");
    const code = [...fake.devices.keys()][0];
    assert.ok(code !== undefined);
    fake.approve(code);
    await clock.advance(5000);
    await page.clock.fastForward(5000);
    await page.waitForFunction(() => window.trickplay.loginPhase === "signed_in");
    await page.evaluate(() => window.trickplay.play());
    await page.waitForFunction(() => window.trickplay.avplay.state === "IDLE");
    await page.evaluate(() => window.trickplay.avplay.finishPrepare());
    await page.waitForFunction(() => window.trickplay.avplay.calls.some((call) => call.startsWith("seekTo")));
    await page.evaluate(() => window.trickplay.avplay.finishSeek());
    await page.waitForFunction(() => window.trickplay.avplay.state === "PLAYING");
    return { page, fake, playback, previews, sheets, errors,
        status(value: number) { sheetStatus = value; }, offline() { offline = true; },
        holdImage(fn: () => Promise<void>) { holdImage = fn; },
        async close() { await page.evaluate(() => window.trickplay.destroy()); await context.close(); } };
}

const remote = (page: Page, keyCode: number): Promise<void> => page.evaluate((code) => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { keyCode: code, bubbles: true, cancelable: true }));
}, keyCode);
const focus = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("data-focus"));
const capture = async (page: Page, name: string): Promise<void> => { if (CAPTURE !== undefined) await page.screenshot({ path: join(CAPTURE, `${name}.png`), animations: "disabled" }); };

test("15/45 previews select thumbnails by resulting source time, independently of ten-second sprite cadence", async () => {
    const r = await open(0, { backward: 15, forward: 45 });
    try {
        await remote(r.page, 37);
        assert.match(await r.page.locator(".player-time").innerText(), /^20:10/);
        await r.page.locator(".player-thumbnail:not([hidden]) img").waitFor();
        assert.equal(await r.page.locator(".player-thumbnail img").evaluate(image => (image as HTMLElement).style.left), "-320px");
        await remote(r.page, 39);
        assert.match(await r.page.locator(".player-time").innerText(), /^20:55/);
        await r.page.waitForFunction(() => (document.querySelector(".player-thumbnail img") as HTMLElement | null)?.style.left === "-1600px");
        await remote(r.page, 10009);
        assert.match(await r.page.locator(".player-time").innerText(), /^20:25/);
        assert.equal(await r.page.locator(".player-thumbnail:not([hidden])").count(), 0);
        assert.deepEqual(r.errors, []);
    } finally { await r.close(); }
});

test("matched native-size seek journey: active JPEG, failure fallback and cancel", async () => {
    const r = await open();
    try {
        await capture(r.page, "01-playing");
        await remote(r.page, 39);
        assert.equal(await focus(r.page), "position");
        assert.match(await r.page.locator(".player-time").innerText(), /^20:35/);
        if (BASELINE === undefined) {
            await r.page.locator(".player-thumbnail:not([hidden]) img").waitFor();
            const geometry = await r.page.locator(".player-thumbnail img").evaluate((image) => {
                if (!(image instanceof HTMLImageElement)) throw new Error("Missing image");
                return { natural: [image.naturalWidth, image.naturalHeight], left: image.style.left, top: image.style.top, frame: image.parentElement?.getBoundingClientRect().toJSON(), focus: image.tabIndex };
            });
            assert.deepEqual(geometry.natural, [3000, 1260]);
            assert.equal(geometry.left, "-960px");
            assert.equal(geometry.top, "-268.8px");
            assert.equal(geometry.frame?.width, 320);
            assert.ok(geometry.frame !== undefined && geometry.frame.y >= 0 && geometry.frame.bottom < 1080);
            assert.equal(geometry.focus, -1);
            assert.equal(r.sheets.length, 1);
        }
        await capture(r.page, "02-active-preview");
        await remote(r.page, 10009);
        assert.equal(await focus(r.page), "player");
        assert.match(await r.page.locator(".player-time").innerText(), /^20:25/);
        assert.equal(await r.page.locator(".player-thumbnail:not([hidden])").count(), 0);
        await capture(r.page, "03-cancel");
        await r.page.evaluate(() => window.trickplay.avplay.tick(985000));
        r.status(403);
        const failed = BASELINE === undefined ? r.page.waitForResponse((response) => response.url().includes("sig=synthetic-2") && response.status() === 403) : Promise.resolve();
        await remote(r.page, 39);
        await failed.catch((error: unknown) => { throw new Error(`Synthetic failure journey: ${JSON.stringify({ sheets: r.sheets.map((sheet) => sheet.url), manifestReads: r.previews.manifestReads, watchReads: r.previews.watchReads })}: ${String(error)}`); });
        if (BASELINE === undefined) {
            await r.page.waitForFunction(() => document.querySelector(".player-thumbnail img") === null);
            assert.equal(r.previews.manifestReads, 2);
        }
        await capture(r.page, "04-request-failure");
        assert.match(await r.page.locator(".player-time").innerText(), /^16:35/);
        assert.equal(await focus(r.page), "position");
        assert.equal(await r.page.locator(".player-thumbnail:not([hidden])").count(), 0);
        await remote(r.page, 13);
        assert.equal(await focus(r.page), "player");
        assert.equal(await r.page.evaluate(() => window.trickplay.avplay.calls.filter((call) => call === "seekTo 995000").length), 1);
        await r.page.evaluate(() => window.trickplay.avplay.finishSeek());
        await capture(r.page, "05-commit");
        assert.deepEqual(r.errors, []);
    } finally { await r.close(); }
});

test("focus navigation never requests previews; one sheet is reused and carries only opaque signed authorization", { skip: BASELINE !== undefined }, async () => {
    const r = await open();
    try {
        await remote(r.page, 38);
        await remote(r.page, 39);
        await remote(r.page, 39);
        await remote(r.page, 37);
        assert.equal(r.previews.watchReads, 0);
        assert.equal(r.sheets.length, 0);
        await remote(r.page, 10009);
        const raw = r.previews.manifest();
        assert.ok(Array.isArray(raw.sheets));
        const opaque = "https://storage.example.test:8443/1.9913.jpg?exp=1&sig=a%2Fb%2B%3D";
        raw.sheets[1] = { index: 1, url: opaque };
        r.previews.manifests.push({ status: 200, body: raw });
        await remote(r.page, 39);
        await r.page.locator(".player-thumbnail:not([hidden])").waitFor();
        await remote(r.page, 39);
        await r.page.locator(".player-thumbnail:not([hidden])").waitFor();
        assert.equal(r.sheets.length, 1, "same-sheet target reuses the decoded image");
        const request = r.sheets[0];
        assert.ok(request !== undefined);
        assert.equal(request.url, opaque);
        for (const key of ["authorization", "x-profile-id", "x-profile-token", "x-silo-device-id", "referer", "cookie"]) assert.equal(request.headers[key], undefined, key);
        assert.equal(new URL(request.url).searchParams.has("token"), false);
        assert.equal(await focus(r.page), "position");
        assert.equal(await r.page.locator(".player-thumbnail").getAttribute("aria-hidden"), "true");
        assert.deepEqual(r.errors, []);
    } finally { await r.close(); }
});

for (const end of ["back", "commit", "profile", "background", "file", "quality", "media", "destroy"] as const) {
    test(`pending image cannot appear after ${end}`, { skip: BASELINE !== undefined }, async () => {
        const r = await open();
        let release = (): void => undefined;
        const held = new Promise<void>((resolve) => { release = resolve; });
        try {
            r.holdImage(() => held);
            const requested = r.page.waitForRequest((request) => request.url().includes(".jpg"));
            await remote(r.page, 39);
            await requested;
            if (end === "back") await remote(r.page, 10009);
            else if (end === "commit") await remote(r.page, 13);
            else if (end === "media") await remote(r.page, 19);
            else if (end === "profile") await r.page.evaluate(() => window.trickplay.clearProfile());
            else if (end === "file") await r.page.evaluate(() => window.trickplay.play("43"));
            else if (end === "quality") await r.page.evaluate(() => window.trickplay.quality());
            else if (end === "destroy") await r.page.evaluate(() => window.trickplay.destroy());
            else await r.page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
            release();
            await r.page.evaluate(() => Promise.resolve());
            assert.equal(await r.page.locator(".player-thumbnail:not([hidden])").count(), 0);
            const seeks = await r.page.evaluate(() => window.trickplay.avplay.calls.filter((call) => call.startsWith("seekTo")));
            assert.equal(seeks.length, end === "commit" ? 2 : 1, "preview alone must never commit a physical seek");
            assert.deepEqual(r.errors, []);
        } finally { release(); await r.close(); }
    });
}

for (const failure of [401, 404, 503, "offline"] as const) {
    test(`image ${failure} renews at most once and leaves timestamp cancel/commit usable`, { skip: BASELINE !== undefined }, async () => {
        const r = await open();
        try {
            if (failure === "offline") r.offline();
            else r.status(failure);
            const failed = r.page.waitForResponse((response) => response.url().includes("/trickplay?file_id=42") && r.previews.manifestReads === 2);
            const predicate = (request: Request): boolean => request.url().includes(".jpg?exp=") && request.url().includes("sig=synthetic-2");
            const secondImage = failure === "offline" ? r.page.waitForEvent("requestfailed", { predicate }) : r.page.waitForEvent("requestfinished", { predicate });
            await remote(r.page, 39);
            await failed;
            await secondImage;
            await remote(r.page, 10009);
            assert.equal(await focus(r.page), "player");
            await remote(r.page, 39);
            assert.match(await r.page.locator(".player-time").innerText(), /^20:35/);
            assert.equal(await focus(r.page), "position");
            await remote(r.page, 13);
            assert.equal(await r.page.locator(".player-thumbnail:not([hidden])").count(), 0);
            assert.equal(await r.page.evaluate(() => window.trickplay.avplay.calls.filter((call) => call === "seekTo 1235000").length), 1);
            assert.ok(r.sheets.length <= 2);
            assert.equal(r.previews.manifestReads, 2);
            await r.page.evaluate(() => window.trickplay.avplay.finishSeek());
        } finally { await r.close(); }
    });
}

test("an older held sheet cannot paint the crop for the latest target", { skip: BASELINE !== undefined }, async () => {
    const r = await open();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    try {
        r.holdImage(() => held);
        const requested = r.page.waitForRequest((request) => request.url().includes(".jpg"));
        await remote(r.page, 39);
        await requested;
        await remote(r.page, 39);
        release();
        await r.page.locator(".player-thumbnail:not([hidden])").waitFor();
        assert.equal(await r.page.locator(".player-thumbnail img").evaluate((image) => image instanceof HTMLElement ? image.style.left : ""), "-1280px");
        assert.match(await r.page.locator(".player-time").innerText(), /^20:45/);
        assert.equal(await focus(r.page), "position");
        assert.equal(await r.page.evaluate(() => window.trickplay.avplay.calls.filter((call) => call.startsWith("seekTo")).length), 1);
    } finally { release(); await r.close(); }
});

test("offset streams preview and cancel in source time, then commit through the controller's player-time mapping", { skip: BASELINE !== undefined }, async () => {
    const r = await open(1222.5);
    try {
        await remote(r.page, 39);
        await r.page.locator(".player-thumbnail:not([hidden])").waitFor();
        assert.match(await r.page.locator(".player-time").innerText(), /^20:35/);
        assert.equal(await r.page.locator(".player-thumbnail img").evaluate((image) => image instanceof HTMLElement ? image.style.left : ""), "-960px");
        await remote(r.page, 10009);
        assert.match(await r.page.locator(".player-time").innerText(), /^20:25/);
        assert.equal(await r.page.evaluate(() => window.trickplay.avplay.calls.filter((call) => call.startsWith("seekTo")).length), 1);
        await remote(r.page, 39);
        await remote(r.page, 13);
        assert.equal(await r.page.evaluate(() => window.trickplay.avplay.calls.filter((call) => call === "seekTo 12500").length), 1);
        await r.page.evaluate(() => window.trickplay.avplay.finishSeek());
        assert.equal(await focus(r.page), "player");
    } finally { await r.close(); }
});
