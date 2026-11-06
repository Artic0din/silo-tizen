// Runs the sign-in harness in desktop Chromium against the fake Silo. The page is served from
// the fake server's origin, so requests need no CORS, as on the TV. Any other host fails as an
// unreachable server. Time is Playwright's fake clock, moved together with the fake's clock.
// Desktop Chromium is not the TV's Chromium 108: this proves behavior, not TV rendering.

import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { type Browser, chromium, type Page } from "playwright";
import { ManualClock } from "../../native/support/clock.ts";
import { FakeSilo } from "../../native/support/fakeSilo.ts";

const ORIGIN = "https://silo.example.test";
const EVENTUALLY_TIMEOUT_MS = 10000;
/** Which screens the page mounts: the sign-in harness or the browse harness. */
export type TvApp = "signIn" | "browse" | "application";
const ENTRY: Record<TvApp, string> = { signIn: "../harness.ts", browse: "../browseHarness.ts", application: "../appHarness.ts" };
const THEME = readFileSync(new URL("../../../src/theme.css", import.meta.url), "utf8");
const CSS: Record<TvApp, string> = {
    signIn: readFileSync(new URL("../../../src/ui/signIn.css", import.meta.url), "utf8"),
    browse: readFileSync(new URL("../../../src/ui/browse.css", import.meta.url), "utf8"),
    application: ["ui/signIn.css", "ui/browse.css", "ui/accounts.css", "player/player.css", "app.css"].map((name) => readFileSync(new URL(`../../../src/${name}`, import.meta.url), "utf8")).join("\n"),
};
const HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=1920, height=1080"><title>Silo</title>
<link rel="stylesheet" href="app.css"></head>
<body style="margin:0"><main id="root"></main><script src="harness.js"></script></body>
</html>`;

const bundles = new Map<TvApp, Promise<string>>();

/** Synthetic artwork: a coloured card with the file name, so screenshots show real images. */
function svgArt(name: string): string {
    let hue = 0;
    for (let i = 0; i < name.length; i++) {
        hue = (hue * 31 + name.charCodeAt(i)) % 360;
    }
    const label = name.replace(/[^A-Za-z0-9:.-]/g, " ").slice(0, 24);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750"><rect width="500" height="750" fill="hsl(${hue},45%,32%)"/><text x="250" y="400" font-family="sans-serif" font-size="40" fill="#fff" text-anchor="middle">${label}</text></svg>`;
}

/** The harness as the TV build bundles it: one classic script lowered to Chrome 108. */
export function harnessBundle(app: TvApp = "signIn"): Promise<string> {
    const cached = bundles.get(app);
    if (cached !== undefined) {
        return cached;
    }
    const bundle = build({
        entryPoints: [new URL(ENTRY[app], import.meta.url).pathname],
        bundle: true,
        format: "iife",
        target: "chrome108",
        // The packaged font sits beside js/ in the WGT; the stylesheet keeps its relative URL (scripts/build.mjs).
        external: ["../fonts/*"],
        write: false,
        outfile: "harness.js",
        define: { APP_VERSION: JSON.stringify(/<widget\b[^>]*\bversion="([^"]+)"/.exec(readFileSync(new URL("../../../app/config.xml", import.meta.url), "utf8"))?.[1]) },
        logLevel: "silent",
    }).then((result) => {
        const file = result.outputFiles[0];
        if (file === undefined) {
            throw new Error("esbuild produced no bundle");
        }
        return file.text;
    });
    bundles.set(app, bundle);
    return bundle;
}

export function launchBrowser(): Promise<Browser> {
    // Hinted glyph advances differ on Linux and shift text by a few pixels; geometry tests compare against Apple's values.
    return chromium.launch({ args: ["--font-render-hinting=none"] });
}

export interface Tv {
    readonly page: Page;
    readonly fake: FakeSilo;
    /** What the page logged, apart from Chromium's failed-request lines. */
    readonly console: string[];
    /** While true, the fake server is unreachable. */
    offline: boolean;
    /** Requests that failed as unreachable. */
    blocked: number;
    /** API calls whose reply has not been delivered to the page. */
    pendingReplies: number;
    /** Moves both clocks; due timers fire once, so one poll runs per step. */
    jump(ms: number): Promise<void>;
    /** Sends a key code the way the TV remote does (Back is 10009). */
    remote(keyCode: number): Promise<void>;
    down(keyCode: number, repeat?: boolean): Promise<boolean>;
    up(keyCode: number): Promise<boolean>;
    screen(): Promise<string | null>;
    focused(): Promise<string | null>;
    /** Resolves once `check` holds; checks after each pending fake request and page task. */
    eventually(check: () => Promise<boolean>, what: string): Promise<void>;
}

export async function openTv(
    browser: Browser,
    /** `origin`: where the page and the fake server live; an http one serves Silo over plain HTTP. */
    options: { sessionOnly?: boolean; profiles?: boolean; production?: boolean; video?: string; app?: TvApp; origin?: string; time?: number } = {},
): Promise<Tv> {
    const app = options.app ?? "signIn";
    const origin = options.origin ?? ORIGIN;
    const script = await harnessBundle(app);
    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        ...(options.video === undefined ? {} : { recordVideo: { dir: options.video, size: { width: 1920, height: 1080 } } }),
    });
    const page = await context.newPage();
    const clock = new ManualClock(options.time);
    const fake = new FakeSilo(clock, undefined, origin);
    const logs: string[] = [];
    page.on("console", (message) => {
        // Chromium's own line for a failed or refused request, not something the app logged.
        if (!message.text().startsWith("Failed to load resource:")) {
            logs.push(message.text());
        }
    });
    page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));

    const tv: Tv = {
        page,
        fake,
        console: logs,
        offline: false,
        blocked: 0,
        pendingReplies: 0,
        async jump(ms) {
            await clock.advance(ms);
            await page.clock.fastForward(ms);
        },
        async remote(keyCode) {
            await tv.down(keyCode);
            await tv.up(keyCode);
        },
        async down(keyCode, repeat = false) {
            return page.evaluate(({ code, repeat }) => {
                const target = document.activeElement ?? document.body;
                return !target.dispatchEvent(new KeyboardEvent("keydown", { keyCode: code, repeat, bubbles: true, cancelable: true }));
            }, { code: keyCode, repeat });
        },
        async up(keyCode) {
            return page.evaluate(code => {
                const target = document.activeElement ?? document.body;
                return !target.dispatchEvent(new KeyboardEvent("keyup", { keyCode: code, bubbles: true, cancelable: true }));
            }, keyCode);
        },
        screen: () => page.evaluate(() => document.querySelector("[data-screen]")?.getAttribute("data-screen") ?? null),
        focused: () => page.evaluate(() => document.activeElement?.getAttribute("data-focus") ?? null),
        async eventually(check, what) {
            const deadline = performance.now() + EVENTUALLY_TIMEOUT_MS;
            while (performance.now() < deadline) {
                if (await check()) {
                    return;
                }
                // Host-only checks must yield to the browser and its routed network requests.
                await page.evaluate(() => undefined);
            }
            throw new Error(`timed out waiting for ${what}`);
        },
    };

    await page.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin || (tv.offline && url.pathname.startsWith("/api/"))) {
            tv.blocked++;
            await route.abort("internetdisconnected");
            return;
        }
        if (url.pathname === "/tv/index.html") {
            await route.fulfill({ status: 200, contentType: "text/html", body: HTML });
            return;
        }
        if (url.pathname === "/tv/harness.js") {
            await route.fulfill({ status: 200, contentType: "application/javascript", body: script });
            return;
        }
        if (url.pathname === "/tv/app.css") {
            await route.fulfill({ status: 200, contentType: "text/css", body: THEME + CSS[app] });
            return;
        }
        if (url.pathname === "/fonts/InterVariable.woff2") {
            // The stylesheet's ../fonts/ URL from /tv/app.css: the same file the WGT packages.
            await route.fulfill({ status: 200, contentType: "font/woff2", body: readFileSync(new URL("../../../app/fonts/InterVariable.woff2", import.meta.url)) });
            return;
        }
        if (url.pathname.startsWith("/tv/img/")) {
            // The packaged app's own images, as the .wgt ships them beside index.html.
            await route.fulfill({ status: 200, contentType: "image/png", body: readFileSync(new URL(`../../../app/img/${url.pathname.slice(8)}`, import.meta.url)) });
            return;
        }
        if (url.pathname.startsWith("/tv/third-party/")) {
            // Static marks shipped from app/, as the packaged app loads them beside index.html.
            await route.fulfill({ status: 200, contentType: "image/svg+xml", body: readFileSync(new URL(`../../../app/${url.pathname.slice("/tv/".length)}`, import.meta.url)) });
            return;
        }
        if (url.pathname.startsWith("/art/")) {
            await route.fulfill({ status: 200, contentType: "image/svg+xml", body: svgArt(decodeURIComponent(url.pathname.slice(5))) });
            return;
        }
        if (!url.pathname.startsWith("/api/v2/")) {
            await route.fulfill({ status: 404 });
            return;
        }
        tv.pendingReplies++;
        try {
            const body = request.postData();
            let response: Response;
            try {
                response = await fake.fetch(request.url(), {
                    method: request.method(),
                    headers: await request.allHeaders(),
                    ...(body === null ? {} : { body }),
                });
            } catch {
                // The fake processed the request but lost its answer (dropNextAnswer).
                await route.abort("connectionreset");
                return;
            }
            const headers: Record<string, string> = {};
            response.headers.forEach((value, key) => {
                headers[key] = value;
            });
            // The page may have abandoned the request while the fake held its answer.
            await route.fulfill({ status: response.status, headers, body: await response.text() }).catch(() => undefined);
        } finally {
            tv.pendingReplies--;
        }
    });
    await page.clock.install({ time: clock.now() });
    await page.goto(`${origin}/tv/index.html${options.profiles === true ? "?flow=profiles" : ""}${options.production === true ? "#production" : options.sessionOnly === true ? "#session-only" : ""}`);
    return tv;
}

/**
 * Reads style or geometry from the node connected in that same browser turn.
 * A Details repaint can replace a node after a locator resolves and before
 * `locator.evaluate` runs; the detached node then reports 0, "" or null.
 * Repeats until the live node is connected and `accept` holds. A timeout
 * includes the last value read.
 */
export async function readLive<T, Arg>(tv: Pick<Tv, "page" | "eventually">, read: (arg: Arg) => T | null, arg: Arg, accept: (value: T) => boolean, what: string): Promise<T> {
    let last: T | null = null;
    try {
        await tv.eventually(async () => {
            // Playwright's evaluate argument is Unboxed<Arg>. A generic Arg does
            // not survive that conditional, so the call is typed directly.
            const evaluate = tv.page.evaluate.bind(tv.page) as <R, A>(pageFunction: (value: A) => R | Promise<R>, value: A) => Promise<R>;
            const value = await evaluate(read, arg);
            last = value;
            return value !== null && accept(value);
        }, what);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}; last ${JSON.stringify(last)}`);
    }
    if (last === null || !accept(last)) throw new Error(`timed out waiting for ${what}; last ${JSON.stringify(last)}`);
    return last;
}

/** Call before starting a deadline or intermediate animation under test. */
export async function pauseTvClock(tv: Tv): Promise<void> {
    // pauseAt advances existing timers; leave room for the protocol round trip
    // before starting the timed action, then fastForward keeps the clock paused.
    const protocolMarginMs = 1000;
    await tv.page.clock.pauseAt(await tv.page.evaluate(() => Date.now()) + protocolMarginMs);
}

/** The titles whose item detail was read, in request order. */
export function detailReads(tv: Tv): string[] {
    return tv.fake.requests.filter(request => request.path.startsWith("/catalog/items/")).map(request => decodeURIComponent(request.path.slice("/catalog/items/".length).split("?")[0] ?? ""));
}

/** Waits until Home has sent its detail read for every title it drew (Home reads them once as it loads). */
export async function homeDetailsRead(tv: Tv, previousReads = 0): Promise<string[]> {
    const titles = await tv.page.locator('[data-view="home"] [data-section] .browse-card:not(.skyline-explore)').evaluateAll(nodes => [...new Set(nodes.map(node => node.getAttribute("data-focus") ?? ""))]);
    await tv.eventually(async () => titles.every(id => detailReads(tv).slice(previousReads).includes(id)), "Home detail reads");
    await tv.jump(0);
    return titles;
}
