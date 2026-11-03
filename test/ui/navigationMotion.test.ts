import assert from "node:assert/strict";
import { selectLibraryMode } from "./support/library.ts";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { homeDetailsRead, launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

async function start(tv: Tv, multiple = false, catalog = new FakeCatalog()): Promise<void> {
    const household = catalog.households.get("p-owner");
    assert.ok(household);
    if (multiple) household.hidden = [];
    tv.fake.catalog = catalog;
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "sign-in");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(() => window.browseHarness.mount());
    await ready(tv, "home");
    await homeDetailsRead(tv);
    await tv.page.clock.pauseAt(await tv.page.evaluate(() => Date.now() + 1000));
}

async function ready(tv: Tv, name: string): Promise<void> {
    await tv.eventually(async () => await tv.page.locator(".browse").getAttribute("data-view") === name, name);
}

async function keys(tv: Tv, ...codes: number[]): Promise<void> {
    for (const code of codes) await tv.remote(code);
}

test("an entered library dropdown keeps its anchor selected and the page undimmed", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await start(tv);
        await keys(tv, 38, 39);
        await tv.jump(250);
        await keys(tv, 40);
        assert.equal(await tv.focused(), "section:Recommended");
        const chrome = await tv.page.evaluate(() => {
            const bar = document.querySelector<HTMLElement>(".browse-nav");
            const anchor = document.querySelector<HTMLElement>('[data-focus="movies"]');
            const panel = document.querySelector<HTMLElement>(".skyline-selector:not(.skyline-flyout)");
            const scrim = document.querySelector<HTMLElement>(".skyline-dropdown-scrim");
            if (bar === null || anchor === null || panel === null || scrim === null) throw new Error("Missing navigation chrome");
            const a = anchor.getBoundingClientRect();
            const p = panel.getBoundingClientRect();
            return { dimmed: bar.classList.contains("skyline-muted"), expanded: anchor.getAttribute("aria-expanded"), scrim: scrim.hidden, anchorCenter: a.x + a.width / 2, panelCenter: p.x + p.width / 2, top: p.y };
        });
        assert.equal(chrome.dimmed, false);
        assert.equal(chrome.expanded, "true");
        assert.equal(chrome.scrim, true);
        assert.ok(Math.abs(chrome.anchorCenter - chrome.panelCenter) < 1);
        assert.equal(chrome.top, 132);
        await keys(tv, 10009);
        assert.equal(await tv.focused(), "movies");
        await tv.jump(500);
        assert.equal(await tv.page.locator(".skyline-selector:not(.skyline-flyout)").isVisible(), false);
    } finally { await tv.page.context().close(); }
});

test("the structural snapshot retains viewport and shelf scroll without per-card style reads", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = new FakeCatalog(120);
        const household = catalog.households.get("p-owner");
        assert.ok(household);
        household.sections = Array.from({ length: 6 }, (_, row) => ({ id: `shelf-${row}`, title: `Shelf ${row + 1}`, items: Array.from({ length: 20 }, (_, column) => `movie:m${String(row * 20 + column + 1).padStart(4, "0")}`) }));
        await start(tv, false, catalog);
        const held = tv.fake.hold("/library/12/sections", true);
        const snapshot = await tv.page.evaluate(() => {
            const viewport = document.querySelector<HTMLElement>(".browse .skyline-content");
            const shelf = document.querySelector<HTMLElement>(".browse .browse-row");
            if (viewport === null || shelf === null) throw new Error("missing populated Home");
            viewport.scrollTop = 180;
            shelf.scrollLeft = 720;
            const expected = { top: viewport.scrollTop, left: shelf.scrollLeft };
            const computed = window.getComputedStyle;
            let reads = 0;
            window.getComputedStyle = (node, pseudo) => { reads++; return computed(node, pseudo); };
            try {
                document.querySelector<HTMLButtonElement>('[data-focus="movies"]')?.click();
                const layer = document.querySelector(".skyline-route-outgoing");
                return { expected, actual: { top: layer?.querySelector(".skyline-content")?.scrollTop, left: layer?.querySelector(".browse-row")?.scrollLeft }, cards: layer?.querySelectorAll(".browse-card").length, reads, focus: document.activeElement?.getAttribute("data-focus") };
            } finally { window.getComputedStyle = computed; }
        });
        assert.deepEqual(snapshot.actual, snapshot.expected);
        assert.ok(snapshot.expected.top > 0 && snapshot.expected.left > 0);
        assert.equal(snapshot.cards, 126, "120 media cards and six Explore all cards survive the snapshot");
        assert.equal(snapshot.reads, 0);
        assert.equal(snapshot.focus, "movies", "the root owns focus until its sections arrive");
        held.release();
        await ready(tv, "library:12");
    } finally { await tv.page.context().close(); }
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`single-library dwell opens modes directly, with immediate remote input (${reducedMotion})`, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            await tv.page.emulateMedia({ reducedMotion });
            await start(tv);
            const reads = tv.fake.requests.length;
            await keys(tv, 38, 39);
            await tv.jump(249);
            assert.equal(await tv.page.locator(".skyline-selector").first().isVisible(), false);
            await tv.jump(1);
            assert.equal(await tv.focused(), "movies");
            assert.deepEqual(await tv.page.locator('.skyline-selector:not(.skyline-flyout) [role="menuitem"]').allTextContents(), ["Recommended", "Collections", "Browse"]);
            assert.equal(await tv.page.locator('.skyline-selector [data-focus^="library:"]').count(), 0);
            await keys(tv, 40);
            assert.equal(await tv.focused(), "section:Recommended");
            await keys(tv, 39);
            assert.equal(await tv.focused(), "section:Recommended", "Right cannot leave the single-level panel");
            await tv.jump(150);
            assert.equal(await tv.page.locator(".skyline-flyout").isVisible(), false);
            await keys(tv, 40);
            assert.equal(await tv.focused(), "section:Collections");
            assert.equal(tv.fake.requests.length, reads, "dwell and focus never fetch");
            await tv.page.keyboard.press("Enter");
            await ready(tv, "library:12");
            assert.equal(await tv.page.locator('.skyline-pills [aria-pressed="true"]').innerText(), "Collections");
            assert.equal(await tv.page.locator(".skyline-selector").first().isVisible(), false);
            const loadedReads = tv.fake.requests.length;
            await tv.page.locator('[data-focus="movies"]').focus();
            await tv.jump(250);
            assert.deepEqual(await tv.page.locator('.skyline-selector:not(.skyline-flyout) [role="menuitem"]').allTextContents(), ["Recommended", "Collections", "Browse", "Genres", "A–Z", "Recently Added"]);
            await keys(tv, 40, 40, 10009);
            assert.equal(await tv.focused(), "movies");
            assert.equal(tv.fake.requests.length, loadedReads);
            assert.equal(await tv.page.locator('.skyline-pills [aria-pressed="true"]').innerText(), "Collections", "Back dismisses without committing another mode");
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });

    test(`an open single-library panel gains loaded modes without moving focus (${reducedMotion})`, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            await tv.page.emulateMedia({ reducedMotion });
            await start(tv);
            const held = tv.fake.hold("/library/12/sections", true);
            await tv.page.locator('[data-focus="movies"]').click();
            await tv.eventually(async () => tv.fake.requests.some(request => request.path.split("?")[0] === "/library/12/sections"), "held library sections");
            await tv.page.locator('[data-focus="movies"]').focus();
            await tv.jump(250);
            await keys(tv, 40);
            assert.equal(await tv.focused(), "section:Recommended");
            const panel = tv.page.locator('.skyline-selector:not(.skyline-flyout)');
            assert.deepEqual(await panel.locator('[role="menuitem"]').allTextContents(), ["Recommended", "Collections", "Browse"]);
            const reads = tv.fake.requests.length;
            held.release();
            await panel.locator('[data-focus="section:Genres"]').waitFor();
            assert.deepEqual(await panel.locator('[role="menuitem"]').allTextContents(), ["Recommended", "Collections", "Browse", "Genres", "A–Z", "Recently Added"]);
            assert.equal(await tv.focused(), "section:Recommended");
            assert.equal(await tv.page.locator('.skyline-route-outgoing, .skyline-content-drift, .skyline-content-enter').count(), 0);
            assert.deepEqual(tv.fake.requests.slice(reads).map(request => request.path.split("?")[0]).filter(path => !path?.startsWith("/catalog/items/")), ["/library/12/collections"], "only discovery and bounded hero enrichment continue");
            const titles = await tv.page.locator('.home-section .browse-card:not(.skyline-explore)').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus") ?? ""));
            await tv.eventually(async () => titles.every(id => tv.fake.requests.some(request => request.path.split("?")[0] === `/catalog/items/${encodeURIComponent(id)}`)), "accepted library hero reads dispatched");
            const loadedReads = tv.fake.requests.length;
            await keys(tv, 40, 40, 40);
            assert.equal(await tv.focused(), "section:Genres");
            assert.equal(tv.fake.requests.length, loadedReads, "focus movement makes no requests");
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });

    test(`deliberate pills crossfade once while loading answers keep chrome focus (${reducedMotion})`, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            await tv.page.emulateMedia({ reducedMotion });
            await start(tv);
            await tv.page.locator('[data-focus="movies"]').click();
            await ready(tv, "library:12");
            await tv.jump(200);
            const held = tv.fake.hold("/library/12/collections", true);
            await selectLibraryMode(tv, "Collections");
            assert.equal(await tv.focused(), "mode:Collections");
            const layers = reducedMotion === "reduce" ? 0 : 1;
            assert.equal(await tv.page.locator(".skyline-route-outgoing").count(), layers, "same-name library mode must animate its deliberate switch");
            assert.equal(await tv.page.locator(".skyline-content-drift").count() > 0, reducedMotion !== "reduce");
            if (reducedMotion !== "reduce") {
                const animation = await tv.page.locator(".skyline-content-drift").first().evaluate(node => {
                    const effect = node.getAnimations()[0]?.effect;
                    return effect instanceof KeyframeEffect ? { duration: effect.getTiming().duration, frames: effect.getKeyframes().map(frame => ({ opacity: frame.opacity, transform: frame.transform })) } : undefined;
                });
                assert.deepEqual(animation, { duration: 200, frames: [{ opacity: "0", transform: "translateY(12px)" }, { opacity: "1", transform: "translateY(0px)" }] });
            }
            await keys(tv, 38);
            assert.equal(await tv.focused(), "movies", "Up restores the current root before the transition completes");
            await keys(tv, 39);
            assert.equal(await tv.focused(), "series", "Right follows the displayed bar order");
            await keys(tv, 37);
            assert.equal(await tv.focused(), "movies", "input works before the transition completes");
            await tv.jump(1000);
            assert.equal(await tv.focused(), "movies");
            held.release();
            await ready(tv, "library:12");
            assert.equal(await tv.focused(), "movies", "a slow answer cannot steal chrome focus");
            assert.equal(await tv.page.locator(".skyline-route-outgoing, .skyline-content-drift, .skyline-content-enter").count(), 0, "data completion starts no animation");
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });

    test(`multiple libraries keep the cascade, cancel row dwell and switch cached scopes (${reducedMotion})`, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            await tv.page.emulateMedia({ reducedMotion });
            await start(tv, true);
            const reads = tv.fake.requests.length;
            await keys(tv, 38, 39);
            await tv.jump(250);
            assert.deepEqual(await tv.page.locator('.skyline-selector [role="menuitemradio"]').allTextContents(), ["Movies", "Archive"]);
            await keys(tv, 40, 40);
            await tv.jump(149);
            assert.equal(await tv.page.locator(".skyline-flyout").isVisible(), false);
            await keys(tv, 38, 39);
            assert.equal(await tv.focused(), "section:Recommended");
            await tv.jump(150);
            assert.equal(await tv.focused(), "section:Recommended", "cancelled row dwell cannot replace the focused flyout");
            await keys(tv, 37);
            assert.equal(await tv.focused(), "library:12");
            await keys(tv, 40);
            await tv.jump(150);
            await keys(tv, 39, 40);
            assert.equal(await tv.focused(), "section:Collections");
            assert.equal(tv.fake.requests.length, reads);
            await tv.page.keyboard.press("Enter");
            await ready(tv, "library:15");
            assert.equal(await tv.page.locator('.skyline-pills [aria-pressed="true"]').innerText(), "Collections");
            await tv.page.locator('[data-focus="movies"]').focus();
            await tv.jump(250);
            await keys(tv, 40);
            assert.equal(await tv.focused(), "library:15", "Down restores the committed scope");
            await keys(tv, 38);
            await tv.page.keyboard.press("Enter");
            await ready(tv, "library:12");
            await tv.jump(200);
            const titles = await tv.page.locator('.home-section .browse-card:not(.skyline-explore)').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus") ?? ""));
            await tv.eventually(async () => titles.every(id => tv.fake.requests.some(request => request.path.split("?")[0] === `/catalog/items/${encodeURIComponent(id)}`)), "Recommended enrichment queue dispatched");
            const cachedReads = tv.fake.requests.length;
            await tv.page.locator('[data-focus="movies"]').focus();
            await tv.jump(250);
            await keys(tv, 40, 40);
            await tv.page.keyboard.press("Enter");
            await ready(tv, "library:15");
            assert.equal(tv.fake.requests.length, cachedReads, "cached scope switch starts no request");
            assert.equal(await tv.page.locator(".skyline-route-outgoing").count(), reducedMotion === "reduce" ? 0 : 1);
            assert.equal(await tv.page.locator(".skyline-content-drift").count() > 0, reducedMotion !== "reduce");
            await keys(tv, 38, 39);
            assert.ok(await tv.focused(), "remote focus survives an in-progress scope switch");
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });

    test(`rapid pills keep one inert snapshot and destroy clears motion work (${reducedMotion})`, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            await tv.page.emulateMedia({ reducedMotion });
            await start(tv);
            await tv.page.locator('[data-focus="movies"]').click();
            await ready(tv, "library:12");
            await tv.jump(200);
            await selectLibraryMode(tv, "Collections");
            await ready(tv, "library:12");
            const state = await tv.page.evaluate(() => {
                for (const key of ["mode:Collections", "mode:Genres", "mode:A–Z"]) {
                    document.querySelector<HTMLButtonElement>(`[data-focus="${key}"]`)?.click();
                }
                const snapshots = document.querySelectorAll(".skyline-route-outgoing");
                return { layers: snapshots.length, nested: document.querySelectorAll(".skyline-route-outgoing .skyline-route-outgoing").length, metadata: document.querySelectorAll(".skyline-route-outgoing [id], .skyline-route-outgoing [data-focus], .skyline-route-outgoing [data-section], .skyline-route-outgoing .browse-nav").length, tabbable: Array.from(document.querySelectorAll<HTMLElement>(".skyline-route-outgoing button, .skyline-route-outgoing input")).filter(node => node.tabIndex !== -1).length };
            });
            assert.deepEqual(state, { layers: reducedMotion === "reduce" ? 0 : 1, nested: 0, metadata: 0, tabbable: 0 });
            await ready(tv, "library:12");
            const reads = tv.fake.requests.length;
            await keys(tv, 39, 37);
            assert.equal(tv.fake.requests.length, reads, "focus movement during motion makes no request");
            const pending = await tv.page.evaluate(() => {
                const timers = new Set<number>();
                const frames = new Set<number>();
                const timeout = window.setTimeout;
                const clearTimeout = window.clearTimeout;
                const requestFrame = window.requestAnimationFrame;
                const cancelFrame = window.cancelAnimationFrame;
                Object.defineProperty(window, "setTimeout", { value: (handler: TimerHandler, ms?: number, ...args: unknown[]) => {
                    const id = timeout(handler, ms, ...args);
                    timers.add(id);
                    return id;
                } });
                Object.defineProperty(window, "clearTimeout", { value: (id?: number) => { if (id !== undefined) timers.delete(id); clearTimeout(id); } });
                window.requestAnimationFrame = callback => { const id = requestFrame(callback); frames.add(id); return id; };
                window.cancelAnimationFrame = id => { frames.delete(id); cancelFrame(id); };
                try {
                    document.querySelector<HTMLButtonElement>('[data-focus="home"]')?.click();
                    window.browseHarness.destroy();
                    return { timers: timers.size, frames: frames.size };
                } finally {
                    window.setTimeout = timeout;
                    window.clearTimeout = clearTimeout;
                    window.requestAnimationFrame = requestFrame;
                    window.cancelAnimationFrame = cancelFrame;
                }
            });
            assert.deepEqual(pending, { timers: 0, frames: 0 });
            await tv.jump(6000);
            assert.equal(await tv.page.locator(".browse, .skyline-route-outgoing, .skyline-content-enter, .skyline-content-drift").count(), 0);
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}
