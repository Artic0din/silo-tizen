// Runs the sign-in harness in desktop Chromium against the fake Silo. The page is served from
// the fake server's origin, so requests need no CORS, as on the TV. Any other host fails as an
// unreachable server. Time is Playwright's fake clock, moved together with the fake's clock.
// Desktop Chromium is not the TV's Chromium 76: this proves behavior, not 2021 rendering.

import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { type Browser, chromium, type Page } from "playwright";
import { ManualClock } from "../../native/support/clock.ts";
import { FakeSilo } from "../../native/support/fakeSilo.ts";

const ORIGIN = "https://silo.example.test";
const PAGE = `${ORIGIN}/tv/index.html`;
const EVENTUALLY_TIMEOUT_MS = 10000;
/** Which screens the page mounts: the sign-in harness or the browse harness. */
export type TvApp = "signIn" | "browse" | "application";
const ENTRY: Record<TvApp, string> = { signIn: "../harness.ts", browse: "../browseHarness.ts", application: "../appHarness.ts" };
const THEME = readFileSync(new URL("../../../src/theme.css", import.meta.url), "utf8");
const CSS: Record<TvApp, string> = {
    signIn: readFileSync(new URL("../../../src/ui/signIn.css", import.meta.url), "utf8"),
    browse: readFileSync(new URL("../../../src/ui/browse.css", import.meta.url), "utf8"),
    application: ["ui/signIn.css", "ui/browse.css", "player/player.css", "app.css"].map((name) => readFileSync(new URL(`../../../src/${name}`, import.meta.url), "utf8")).join("\n"),
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

/** The harness as the TV build bundles it: one classic script lowered to Chrome 76. */
export function harnessBundle(app: TvApp = "signIn"): Promise<string> {
    const cached = bundles.get(app);
    if (cached !== undefined) {
        return cached;
    }
    const bundle = build({
        entryPoints: [new URL(ENTRY[app], import.meta.url).pathname],
        bundle: true,
        format: "iife",
        target: "chrome76",
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
    return chromium.launch();
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
    /** Moves both clocks; due timers fire once, so one poll runs per step. */
    jump(ms: number): Promise<void>;
    /** Sends a key code the way the TV remote does (Back is 10009). */
    remote(keyCode: number): Promise<void>;
    screen(): Promise<string | null>;
    focused(): Promise<string | null>;
    /** Resolves once `check` holds; checks after each pending fake request and page task. */
    eventually(check: () => Promise<boolean>, what: string): Promise<void>;
}

export async function openTv(browser: Browser, options: { sessionOnly?: boolean; profiles?: boolean; production?: boolean; video?: string; app?: TvApp } = {}): Promise<Tv> {
    const app = options.app ?? "signIn";
    const script = await harnessBundle(app);
    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        ...(options.video === undefined ? {} : { recordVideo: { dir: options.video, size: { width: 1280, height: 720 } } }),
    });
    const page = await context.newPage();
    const clock = new ManualClock();
    const fake = new FakeSilo(clock);
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
        async jump(ms) {
            await clock.advance(ms);
            await page.clock.fastForward(ms);
        },
        async remote(keyCode) {
            await page.evaluate((code) => {
                const target = document.activeElement ?? document.body;
                target.dispatchEvent(new KeyboardEvent("keydown", { keyCode: code, bubbles: true, cancelable: true }));
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
        if (url.origin !== ORIGIN || (tv.offline && url.pathname.startsWith("/api/"))) {
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
        if (url.pathname.startsWith("/art/")) {
            await route.fulfill({ status: 200, contentType: "image/svg+xml", body: svgArt(decodeURIComponent(url.pathname.slice(5))) });
            return;
        }
        if (!url.pathname.startsWith("/api/v2/")) {
            await route.fulfill({ status: 404 });
            return;
        }
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
    });
    await page.clock.install({ time: clock.now() });
    await page.goto(`${PAGE}${options.profiles === true ? "?flow=profiles" : ""}${options.production === true ? "#production" : options.sessionOnly === true ? "#session-only" : ""}`);
    return tv;
}
