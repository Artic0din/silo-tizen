import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { problem } from "../native/support/fakeSilo.ts";
import type { SettingsKey } from "../../src/contracts/v2/settings.ts";
import { launchBrowser, openTv, readLive, type Tv } from "./support/tv.ts";

const TITLE = "ui.title_art" as SettingsKey;
let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

/** `prepare` runs before Home mounts, so Home's own title-art read sees it and Details inherits that answer. */
async function setup(prepare?: (tv: Tv, settings: FakeSettings) => Promise<void> | void, settled = true) {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeDetails();
    tv.fake.catalog = catalog;
    const settings = new FakeSettings(tv.fake);
    await prepare?.(tv, settings);
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase) === "signed_in", "sign in");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.page.locator('[data-view="home"]').waitFor();
    // Home reads title art and poster badges when it loads; let those settle before scripting settings replies.
    if (settled) await tv.eventually(async () => ["keys=ui.title_art", "keys=ui.card_overlays"].every(key => tv.fake.requests.some(request => request.path.startsWith("/settings/values/effective?") && request.path.includes(key))), "Home settings reads");
    return { tv, catalog, settings };
}
async function details(tv: Tv, _catalog: FakeDetails): Promise<void> {
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
}

const LOGO = "/art/last-signal-logo.svg";
const titleArtReads = (tv: Tv): number => tv.fake.requests.filter(request => request.path === `/settings/values/effective?keys=${TITLE}`).length;

/** Gives Home's m0001 card the detail's logo, as a server would send it. */
async function cardLogo(tv: Tv): Promise<void> {
    await tv.page.route("**/api/v2/home/sections**", async route => {
        const url = new URL(route.request().url());
        const body = tv.fake.catalog?.route("GET", url.pathname.replace(/^\/api\/v2/, "") + url.search, "p-owner")?.body as { sections: { items: Record<string, unknown>[] }[] } | undefined;
        assert.ok(body);
        await route.fulfill({ json: { ...body, sections: body.sections.map(section => ({ ...section, items: section.items.map(item => item.content_id === "movie:m0001" ? { ...item, logo_url: LOGO } : item) })) } });
    });
}

/** Holds m0001's detail read until the returned release, so Details stays on its loading frame. */
async function holdDetail(tv: Tv): Promise<() => void> {
    let release = (): void => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    await tv.page.route("**/api/v2/catalog/items/movie%3Am0001?**", async route => { await held; await route.fallback().catch(() => undefined); });
    // Home prefetches the detail; a fresh mount without the cached copy opens the loading frame.
    const reads = titleArtReads(tv);
    await tv.page.evaluate(() => { window.browseHarness.clearResponseCache(); window.browseHarness.destroy(); window.browseHarness.mount(); });
    await tv.page.locator('[data-view="home"]').waitFor();
    // The remounted Home reads title art again; let that read land before a caller counts reads.
    await tv.eventually(async () => titleArtReads(tv) > reads, "remounted Home title-art read");
    await tv.jump(240);
    return release;
}

test("the loading frame shows the card's logo under the remembered answer and Details keeps it without its own read", async () => {
    const { tv } = await setup(cardLogo);
    try {
        const release = await holdDetail(tv);
        const reads = titleArtReads(tv);
        await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').click();
        await tv.page.locator(".details-loading-title .details-logo").waitFor();
        assert.equal(await tv.page.locator(".details-loading-title .details-logo").getAttribute("alt"), "Movie 0001", "the card's own title");
        release();
        await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
        // The loading frame already decoded this logo, so the loaded heading opens on it instead of its text.
        assert.equal(await tv.page.locator(".details-editorial h1 .details-logo").count(), 1);
        assert.equal(await tv.page.locator(".details-editorial h1 .requests-title-primary").count(), 0);
        assert.equal(titleArtReads(tv), reads, "Details reads no title-art setting of its own");
    } finally { await tv.page.context().close(); }
});

test("a search card's loading frame keeps its text title, as Apple's catalog cards carry no logo", async () => {
    const { tv } = await setup();
    try {
        // Search lists catalog items, which the server sends with logo_url; Apple's BrowseItem drops it.
        await tv.page.route(url => url.pathname === "/api/v2/catalog", async route => {
            const url = new URL(route.request().url());
            const reply = tv.fake.catalog?.route("GET", url.pathname.replace(/^\/api\/v2/, "") + url.search, "p-owner");
            const body = reply?.body as { items?: Record<string, unknown>[] } | undefined;
            assert.ok(reply?.status === 200 && Array.isArray(body?.items));
            await route.fulfill({ json: { ...body, items: body.items.map(item => item.content_id === "movie:m0001" ? { ...item, logo_url: LOGO } : item) } });
        });
        const release = await holdDetail(tv);
        await tv.page.locator('[data-focus="search"]').click();
        await tv.page.fill("#browse-search", "Movie 0001"); await tv.remote(65376);
        // Search's own hero preview may load this logo; the frame must not show it even once it has loaded.
        const loaded = tv.page.waitForEvent("requestfinished", request => new URL(request.url()).pathname === LOGO);
        await tv.page.locator('.browse-grid [data-focus="movie:m0001"]').click();
        await tv.page.locator('[data-view="item:loading"]').waitFor();
        await loaded;
        await tv.jump(240);
        assert.equal(await tv.page.locator(".details-loading-title .details-logo").count(), 0);
        assert.equal(await tv.page.locator(".details-loading-title-text").textContent(), "Movie 0001");
        release();
    } finally { await tv.page.context().close(); }
});

test("a remembered Off answer keeps the loading frame and Details as text with zero logo requests", async () => {
    const { tv } = await setup(async (page, settings) => { settings.profile().set(TITLE, false); await cardLogo(page); });
    let logos = 0;
    tv.page.on("request", r => { if (new URL(r.url()).pathname === LOGO) logos++; });
    try {
        const release = await holdDetail(tv);
        await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').click();
        await tv.page.locator('[data-view="item:loading"]').waitFor();
        assert.equal(await tv.page.locator(".details-loading-title-text").textContent(), "Movie 0001", "the card's own title");
        release();
        await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
        await tv.jump(240);
        assert.equal(await tv.page.locator(".details-editorial h1").textContent(), "The Last Signal");
        assert.equal(logos, 0, "confirmed false must never fetch a logo");
        await tv.page.locator('[data-focus="play"]').waitFor();
    } finally { await tv.page.context().close(); }
});

test("an Off answer that lands while Details is open turns its logo back to text", async () => {
    let hold: { release(): void } | undefined;
    // Holding the contract read delays Home's title-art answer until after the profile turns it off.
    const { tv, settings, catalog } = await setup(page => { hold = page.fake.hold("/settings/contract", true); }, false);
    try {
        await details(tv, catalog);
        await tv.page.locator(".details-editorial h1 .details-logo").waitFor();
        const focus = await tv.focused();
        settings.profile().set(TITLE, false);
        hold?.release();
        await tv.eventually(async () => await tv.page.locator(".details-editorial h1 .details-logo").count() === 0, "text title after Off");
        assert.equal(await tv.page.locator(".details-editorial h1").textContent(), "The Last Signal");
        assert.equal(await tv.focused(), focus, "the repaint keeps focus");
    } finally { hold?.release(); await tv.page.context().close(); }
});

test("a this-TV Off from General applies to the next Details visit at once", async () => {
    const { tv, catalog } = await setup();
    try {
        await details(tv, catalog);
        await tv.page.locator(".details-logo").waitFor();
        await tv.remote(10009);
        await settingsScreen(tv);
        await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).click();
        await tv.eventually(async () => await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).getAttribute("aria-checked") === "false", "title art confirmed off");
        assert.equal(await tv.page.getByRole("switch", { name: "Apply to All Devices", exact: true }).getAttribute("aria-checked"), "false");
        await tv.remote(10009); await tv.remote(10009);
        let logos = 0;
        tv.page.on("request", r => { if (new URL(r.url()).pathname.endsWith("last-signal-logo.svg")) logos++; });
        await details(tv, catalog);
        await tv.jump(240);
        assert.equal(await tv.page.locator(".details-editorial h1").textContent(), "The Last Signal");
        assert.equal(logos, 0);
    } finally { await tv.page.context().close(); }
});

test("confirmed title-art Off survives an offline cached Details revisit", async () => {
    const { tv, catalog } = await setup();
    try {
        await details(tv, catalog);
        await tv.page.locator(".details-logo").waitFor();
        await tv.remote(10009);
        await settingsScreen(tv);
        await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).click();
        await tv.eventually(async () => await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).getAttribute("aria-checked") === "false", "title art confirmed off");
        assert.equal(await tv.page.locator('[data-focus="title-art"] .settings-row-value').textContent(), "Off");
        assert.equal(await tv.page.getByRole("switch", { name: "Apply to All Devices", exact: true }).getAttribute("aria-checked"), "false");
        await tv.remote(10009); await tv.remote(10009);
        let logos = 0;
        tv.page.on("request", request => { if (new URL(request.url()).pathname.endsWith("last-signal-logo.svg")) logos++; });
        await tv.page.route("**/api/v2/**", route => route.abort("connectionrefused"));
        await details(tv, catalog);
        await tv.jump(35000);
        assert.equal(await tv.page.locator(".details-editorial h1").textContent(), "The Last Signal");
        assert.equal(await tv.page.locator(".details-logo").count(), 0);
        assert.equal(logos, 0);
    } finally { await tv.page.context().close(); }
});

test("detailed seasons use the same false policy and leave episode navigation usable", async () => {
    const { tv } = await setup((_tv, settings) => { settings.profile().set(TITLE, false); });
    let logos = 0;
    tv.page.on("request", r => { if (new URL(r.url()).pathname.endsWith("season-logo.svg")) logos++; });
    try {
        await tv.page.route("**/api/v2/catalog/items/series%3As1-S1?**", async route => {
            const base = tv.fake.catalog?.route("GET", "/catalog/items/series%3As1-S1", "p-owner");
            assert.ok(base);
            await route.fulfill({ status: 200, json: { ...base.body as Record<string, unknown>, logo_url: "/art/season-logo.svg" } });
        });
        await tv.page.locator('[data-focus="series"][role="tab"]').click();
        await tv.page.locator('[data-focus="series:s1"]').first().click();
        await tv.page.locator('[data-focus="season:1"]').click();
        await tv.page.locator('[data-focus="series:s1-S1"]').click();
        await tv.page.locator('[data-view="season:series:s1:1"]').waitFor();
        await tv.jump(240);
        assert.equal(await tv.page.locator(".details-editorial h1").textContent(), "Harbor Lights · Season 1");
        assert.equal(logos, 0);
        assert.ok(await tv.page.locator('[data-focus^="episode:"]').count() > 0);
    } finally { await tv.page.context().close(); }
});

test("an Off answer that lands while a detailed season is open turns its logo back to text", async () => {
    let hold: { release(): void } | undefined;
    const { tv, settings } = await setup(page => { hold = page.fake.hold("/settings/contract", true); }, false);
    try {
        await tv.page.route("**/api/v2/catalog/items/series%3As1-S1?**", async route => {
            const base = tv.fake.catalog?.route("GET", "/catalog/items/series%3As1-S1", "p-owner");
            assert.ok(base);
            await route.fulfill({ status: 200, json: { ...base.body as Record<string, unknown>, logo_url: "/art/season-logo.svg" } });
        });
        await tv.page.locator('[data-focus="series"][role="tab"]').click();
        await tv.page.locator('[data-focus="series:s1"]').first().click();
        await tv.page.locator('[data-focus="season:1"]').click();
        await tv.page.locator('[data-focus="series:s1-S1"]').click();
        await tv.page.locator('[data-view="season:series:s1:1"]').waitFor();
        await tv.page.locator(".details-editorial h1 .details-logo").waitFor();
        settings.profile().set(TITLE, false);
        hold?.release();
        await tv.eventually(async () => await tv.page.locator(".details-editorial h1 .details-logo").count() === 0, "season text title after Off");
        assert.equal(await tv.page.locator(".details-editorial h1").textContent(), "Harbor Lights · Season 1");
    } finally { hold?.release(); await tv.page.context().close(); }
});

for (const mode of ["logo", "broken", "default-false"] as const) test(`Details supported title art: ${mode}`, async () => {
    const { tv, catalog } = await setup((_tv, settings) => { settings.titleDefault = mode !== "default-false"; });
    let logos = 0;
    tv.page.on("request", r => { if (new URL(r.url()).pathname.endsWith("last-signal-logo.svg")) logos++; });
    try {
        if (mode === "broken") await tv.page.route("**/art/last-signal-logo.svg", route => route.fulfill({ status: 200, contentType: "image/svg+xml", body: "broken image" }));
        await details(tv, catalog);
        if (mode === "logo") {
            await tv.page.locator(".details-logo").waitFor();
            assert.equal(await tv.page.getByRole("heading", { name: "The Last Signal" }).count(), 1);
        } else {
            if (mode === "broken") await tv.eventually(async () => logos > 0, "failed logo request");
            await tv.jump(240);
            assert.equal(await tv.page.locator(".details-editorial h1").textContent(), "The Last Signal");
            assert.equal(await tv.page.locator(".details-logo").count(), 0);
            if (mode === "default-false") assert.equal(logos, 0);
        }
        await tv.page.locator('[data-focus="play"]').focus();
        await tv.page.keyboard.press("Enter");
        assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 1);
    } finally { await tv.page.context().close(); }
});

test("a failed title-art read keeps Apple's logos-on fallback with no Details error", async () => {
    const { tv, catalog } = await setup(page => { page.fake.script(`/settings/values/effective?keys=${TITLE}`, ...Array.from({ length: 20 }, () => problem(429, "rate_limited", "Wait"))); });
    try {
        await details(tv, catalog);
        await tv.page.locator(".details-editorial h1 .details-logo").waitFor();
        assert.equal(await tv.page.getByText("Could not load title-art settings.").count(), 0);
        assert.equal(await tv.page.getByRole("button", { name: "Retry title art", exact: true }).count(), 0, "Apple's row has no title-art button");
        assert.ok(await tv.page.locator('[data-focus="play"]').isVisible());
    } finally { await tv.page.context().close(); }
});

async function settingsScreen(tv: Tv): Promise<void> {
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).waitFor();
}

test("General switches show source/scope, serialize edits and keep focus without fetches on moves", async () => {
    const { tv, settings } = await setup();
    try {
        await settingsScreen(tv);
        assert.equal(await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).getAttribute("aria-checked"), "true");
        assert.equal(settings.profile().has(TITLE), false);
        assert.equal(await tv.page.getByText("Profile defaults", { exact: true }).count(), 0);
        const count = tv.fake.requests.length;
        await tv.page.keyboard.press("ArrowRight");
        assert.equal(await tv.focused(), "paired-profile");
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "remember-profile");
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "title-art");
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "title-art-all");
        assert.equal(tv.fake.requests.length, count);
        await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => await tv.page.getByRole("switch", { name: "Apply to All Devices", exact: true }).getAttribute("aria-checked") === "true", "confirmed profile scope");
        assert.equal(settings.profile().get(TITLE), true);
        assert.equal(await tv.focused(), "title-art-all");
        await tv.page.keyboard.press("ArrowUp");
        await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).getAttribute("aria-checked") === "false", "confirmed title art off");
        assert.equal(settings.profile().get(TITLE), false);
        await tv.page.keyboard.press("ArrowDown");
        await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => await tv.page.getByRole("switch", { name: "Apply to All Devices", exact: true }).getAttribute("aria-checked") === "false", "confirmed device scope");
        assert.equal(await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).getAttribute("aria-checked"), "false");
        assert.equal(await tv.focused(), "title-art-all");
        assert.equal(settings.profile().has(TITLE), false);
        assert.deepEqual(tv.fake.requests.filter(r => r.method === "PUT" || r.method === "DELETE").map(r => [r.method, r.path]), [
            ["PUT", `/settings/values/${TITLE}?scope=profile`], ["PUT", `/settings/values/${TITLE}?scope=profile`],
            ["PUT", `/settings/values/${TITLE}?scope=profile_device`], ["DELETE", `/settings/values/${TITLE}?scope=profile`],
        ]);
        await tv.remote(10009); await tv.remote(10009);
        assert.equal(await tv.focused(), "home");
    } finally { await tv.page.context().close(); }
});

for (const conflict of ["profile", "device"] as const) test(`Settings recovers an observed ${conflict} conflict through the existing Reload control`, async () => {
    const { tv, settings } = await setup();
    try {
        settings.profile().set(TITLE, true);
        await settingsScreen(tv);
        const catalog = tv.fake.catalog;
        assert.ok(catalog);
        let pinned = false;
        let interleaved = false;
        if (conflict === "profile") tv.fake.catalog = { route: (method, path, profile, body, headers) => {
            const reply = catalog.route(method, path, profile, body, headers);
            if (method === "PUT" && path === `/settings/values/${TITLE}?scope=profile_device`) pinned = true;
            if (pinned && !interleaved && method === "GET" && path === `/settings/values?scope=profile&keys=${TITLE}`) {
                settings.profile().set(TITLE, false);
                settings.rowRevisions.set(JSON.stringify(["p-owner", "profile", undefined, TITLE]), 9);
                interleaved = true;
            }
            return reply;
        } };
        else tv.fake.script(`/settings/values/${TITLE}?scope=profile`, problem(500, "failed", "Failed"));
        await tv.page.getByRole("switch", { name: "Apply to All Devices", exact: true }).focus();
        await tv.page.keyboard.press("Enter");
        if (conflict === "device") {
            const retry = tv.page.getByRole("button", { name: "Check and retry", exact: true });
            await retry.waitFor();
            const device = tv.fake.requests.find(r => r.method === "PUT")?.headers["x-silo-device-id"];
            assert.ok(device);
            settings.device("p-owner", device).set(TITLE, false);
            settings.rowRevisions.set(JSON.stringify(["p-owner", "profile_device", device, TITLE]), 9);
            await retry.focus();
            await tv.page.keyboard.press("Enter");
        }
        await tv.page.getByRole("alert").filter({ hasText: "Title art changed on another device. Reload settings before changing it." }).waitFor();
        const reload = tv.page.getByRole("button", { name: "Reload settings", exact: true });
        await reload.waitFor();
        assert.equal(await tv.focused(), conflict === "profile" ? "title-art-all" : "general");
        assert.equal(await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).getAttribute("aria-checked"), String(conflict === "device"));
        assert.equal(tv.fake.requests.filter(r => r.method === "PUT").length, 1);
        assert.equal(tv.fake.requests.filter(r => r.method === "DELETE").length, conflict === "profile" ? 0 : 1);
        assert.equal(settings.profile().get(TITLE), conflict === "device");
        await reload.focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).waitFor();
        await tv.eventually(async () => await tv.page.getByRole("alert").count() === 0, "conflict reload");
        assert.equal(await tv.page.getByRole("switch", { name: "Apply to All Devices", exact: true }).getAttribute("aria-checked"), "true");
        assert.equal(await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).getAttribute("aria-checked"), String(conflict === "device"));
        assert.equal(settings.profile().get(TITLE), conflict === "device");
        assert.equal(tv.fake.requests.filter(r => r.method === "PUT").length, 1);
        assert.equal(tv.fake.requests.filter(r => r.method === "DELETE").length, conflict === "profile" ? 0 : 1);
        await tv.remote(10009); await tv.remote(10009);
        assert.equal(await tv.focused(), "home");
    } finally { await tv.page.context().close(); }
});

test("a decoded Details title logo stays in place across a repaint", async () => {
    const { tv, catalog } = await setup();
    const held = tv.fake.hold("/recommendations/similar/movie%3Am0001", true);
    try {
        await details(tv, catalog);
        // The first decode may still swap from the 110px text fallback to the 160px slot.
        // This sample starts only after that swap has settled.
        const settled = await readLive(tv, () => {
            const hero = document.querySelector(".details-hero");
            const title = hero?.querySelector(".browse-title");
            const row = hero?.querySelector(".browse-meta");
            if (!(hero instanceof HTMLElement) || !(title instanceof HTMLElement) || !(row instanceof HTMLElement) || !title.isConnected || !row.isConnected) return null;
            const logo = title.querySelector(".details-logo");
            if (!(logo instanceof HTMLImageElement) || !logo.complete || logo.naturalWidth === 0) return null;
            return {
                titleHeight: title.getBoundingClientRect().height,
                rowTop: row.getBoundingClientRect().top - hero.getBoundingClientRect().top,
            };
        }, null, value => Math.abs(value.titleHeight - 160) < 0.5 && Math.abs(value.rowTop - 290) < 0.5, "decoded movie logo before the forced repaint");
        assert.ok(Math.abs(settled.titleHeight - 160) < 0.5, JSON.stringify(settled));
        assert.ok(Math.abs(settled.rowTop - 290) < 0.5, JSON.stringify(settled));
        await tv.page.evaluate(() => {
            const samples: { titleHeight: number; rowTop: number; logo: boolean }[] = [];
            const read = (): void => {
                const hero = document.querySelector(".details-hero");
                const title = hero?.querySelector(".browse-title");
                const row = hero?.querySelector(".browse-meta");
                if (!(hero instanceof HTMLElement) || !(title instanceof HTMLElement) || !(row instanceof HTMLElement)) return;
                if (!hero.isConnected || !title.isConnected || !row.isConnected) return;
                samples.push({
                    titleHeight: title.getBoundingClientRect().height,
                    rowTop: row.getBoundingClientRect().top - hero.getBoundingClientRect().top,
                    logo: title.querySelector(".details-logo") !== null,
                });
            };
            const observer = new MutationObserver(read);
            observer.observe(document.body, { childList: true, subtree: true });
            Object.assign(window, { __titleLogoWatch: { samples, stop: (): typeof samples => { observer.disconnect(); return samples; } } });
            read();
        });
        held.release();
        await tv.page.locator('[data-detail-section="related"] [data-focus]').first().waitFor();
        const samples = await tv.page.evaluate(() => {
            const watch = (window as unknown as { __titleLogoWatch: { stop(): { titleHeight: number; rowTop: number; logo: boolean }[] } }).__titleLogoWatch;
            return watch.stop();
        });
        assert.ok(samples.length > 1, `the forced repaint produced no connected samples: ${JSON.stringify(samples)}`);
        const flashed = samples.filter(sample => !sample.logo || Math.abs(sample.titleHeight - 160) >= 0.5 || Math.abs(sample.rowTop - 290) >= 0.5);
        assert.deepEqual(flashed, []);
    } finally { held.release(); await tv.page.context().close(); }
});

test("delayed image load cannot replace a hidden heading and a new generation restores logos", async () => {
    const { tv, catalog } = await setup();
    let release = (): void => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started = false;
    await tv.page.route("**/art/last-signal-logo.svg", async route => {
        started = true;
        await held;
        await route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="100"><text y="60" fill="white" font-size="40">The Last Signal</text></svg>' }).catch(() => undefined);
    });
    try {
        await details(tv, catalog);
        await tv.eventually(async () => started, "held logo");
        await tv.page.locator('[data-focus="play"]').click();
        release();
        await tv.jump(240);
        assert.equal(await tv.page.locator(".details-editorial h1").textContent(), "The Last Signal");
        assert.equal(await tv.page.locator(".details-logo").count(), 0);
        await tv.page.evaluate(() => window.browseHarness.resume());
        await tv.page.locator(".details-logo").waitFor();
    } finally { release(); await tv.page.context().close(); }
});
