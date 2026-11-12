import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import type { Browser } from "playwright";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { FakeRequests } from "../native/support/fakeRequests.ts";
import type { Reply } from "../native/support/fakeSilo.ts";
import { PRIMARY_MENU_KEY, type PrimaryMenu } from "../../src/contracts/v2/navigation.ts";
import { HIDDEN_KEY } from "../../src/contracts/v2/settings.ts";
import { jumpUntil, launchBrowser, openTv, homeDetailsRead, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

class RecommendationsCatalog extends FakeCatalog {
    recommendationReply: Reply | undefined;
    override route(method: string, path: string, profile: string | undefined, body?: Record<string, unknown>): Reply | undefined {
        if (path.startsWith("/recommendations/discover")) {
            if (this.recommendationReply !== undefined) return this.recommendationReply;
            const card = super.route("GET", "/catalog/items/movie%3Am0001", profile)?.body;
            assert.ok(card);
            return { status: 200, body: { items: [
                { type: "popular", title: "Popular", kind: "popular", items: [card] },
                { type: "cluster", title: "For You", kind: "cluster", key: "0", items: [card] },
                { type: "future", title: "A new shelf", items: [card] },
            ] } };
        }
        if (path.startsWith("/recommendations/section/cluster")) {
            const card = super.route("GET", "/catalog/items/movie%3Am0001", profile)?.body;
            return { status: 200, body: { type: "cluster", title: "For You", kind: "cluster", key: "0", items: [card] } };
        }
        return super.route(method, path, profile, body);
    }
}

async function start(tv: Tv, menu: PrimaryMenu | null = null, catalog: FakeCatalog = new RecommendationsCatalog(), offerSignOut = false): Promise<void> {
    tv.fake.catalog = catalog;
    const settings = new FakeSettings(tv.fake);
    settings.profile().set(PRIMARY_MENU_KEY, menu);
    settings.profile().set(HIDDEN_KEY, catalog.households.get("p-owner")?.hidden ?? null);
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "signed in");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(offer => window.browseHarness.mount(offer), offerSignOut);
    await tv.page.locator('.browse[data-view="home"] .browse-card').first().waitFor();
    await homeDetailsRead(tv);
}

class ProfileDestinationsCatalog extends FakeRequests {
    constructor() {
        super();
        for (const id of ["movie:m0001", "movie:m0002"]) {
            const title = this.titles.get(id);
            assert.ok(title);
            this.titles.set(id, { ...title, backdrop: `/art/${id}.svg` });
        }
    }
    override route(method: string, path: string, profile: string | undefined, body?: Record<string, unknown>): Reply | undefined {
        if (path.startsWith("/catalog/query") && body?.source === "history") {
            const card = super.route("GET", "/catalog/items/movie%3Am0002", profile)?.body;
            return { status: 200, body: { window_cursor: "history", items: [card], total: 1, total_exact: true, page: { has_more: false } } };
        }
        return super.route(method, path, profile, body);
    }
}

for (const root of ["home", "movies"] as const) for (const destination of ["History", "Requests"] as const) test(`${destination} Back restores the selected ${root} tab and its hero`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv, null, new ProfileDestinationsCatalog());
        await tv.page.locator(`[data-focus="${root}"]`).click();
        const page = tv.page.locator(`.browse[data-view="${root === "home" ? "home" : "library:12"}"]`);
        await page.locator('.browse-card').first().waitFor();
        await page.locator('.browse-card').first().focus();
        await tv.jump(500);
        await page.locator('.skyline-marquee-art:not(.skyline-outgoing) .skyline-backdrop').evaluate(async image => { await (image as HTMLImageElement).decode(); });
        const hero = () => tv.page.locator('.skyline-marquee').evaluate(node => ({ title: node.querySelector('.skyline-marquee-layer .skyline-title')?.textContent, image: node.querySelector('.skyline-marquee-art:not(.skyline-outgoing) img')?.getAttribute('src') }));
        const expected = await hero();
        assert.ok(expected.image?.includes("/art/"), "origin has loaded backdrop artwork");
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.getByRole("menuitem", { name: destination, exact: true }).click();
        await tv.page.locator(destination === "History" ? '.browse[data-view="personal:history"] .browse-card' : '.requests-hub .browse-card').first().waitFor();
        if (destination === "History") {
            await tv.page.locator('.browse[data-view="personal:history"] .browse-card').last().focus();
            await tv.jump(500);
        }
        await tv.remote(10009);
        // Requests is a root page under the bar: the first Back reaches the bar, the second returns to the tab.
        if (destination === "Requests") { assert.equal(await tv.focused(), root); await tv.remote(10009); }
        assert.equal(await tv.focused(), root);
        assert.equal(await tv.page.locator('[data-focus="profiles"]').getAttribute("aria-expanded"), "false");
        await tv.jump(1000);
        assert.equal(await tv.focused(), root);
        assert.deepEqual(await hero(), expected, "Back restores the originating page's title and backdrop");
        await page.locator('.skyline-marquee-art:not(.skyline-outgoing) .skyline-backdrop').evaluate(async image => { await (image as HTMLImageElement).decode(); });
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.remote(10009);
        assert.equal(await tv.focused(), "profiles", "Back from the menu itself still restores the avatar");
    } finally { await tv.page.context().close(); }
});

for (const root of ["home", "movies"] as const) test(`Settings Back from ${root} selects the Home tab`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv, null, new ProfileDestinationsCatalog());
        await tv.page.locator(`[data-focus="${root}"]`).click();
        await tv.page.locator(`.browse[data-view="${root === "home" ? "home" : "library:12"}"] .browse-card`).first().waitFor();
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await tv.page.locator('[data-focus="general"]').waitFor();
        assert.equal(await tv.focused(), "general");
        await tv.remote(10009);
        assert.equal(await tv.page.locator(".settings").count(), 0);
        assert.equal(await tv.page.locator(".browse").getAttribute("data-view"), "home");
        assert.equal(await tv.focused(), "home");
        assert.equal(await tv.page.locator('[data-focus="profiles"]').getAttribute("aria-expanded"), "false");
    } finally { await tv.page.context().close(); }
});

test("Down from the avatar enters the open profile menu and leaves it for Continue Watching after Back", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        await tv.page.locator('[data-focus="profiles"]').focus();
        await tv.jump(250);
        assert.equal(await tv.page.locator('[data-focus="profiles"]').getAttribute("aria-expanded"), "true", "focus opens the profile menu");
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "switch-profile", "Down enters Switch Profile while the menu is open");
        await tv.remote(10009);
        assert.equal(await tv.focused(), "profiles");
        assert.equal(await tv.page.locator('[data-focus="profiles"]').getAttribute("aria-expanded"), "false");
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "movie:m0001", "after Back, Down reaches the first Continue Watching card");
        assert.equal(await tv.page.evaluate(() => document.activeElement?.closest("[data-section]")?.getAttribute("data-section")), "continue_watching");
        assert.equal(await tv.page.locator('[data-focus="profiles"]').getAttribute("aria-expanded"), "false", "the menu stays closed");
        assert.equal(await tv.page.locator(".skyline-selector:not(.skyline-flyout)").isVisible(), false);
    } finally { await tv.page.context().close(); }
});

test("Down from the avatar before the dwell opens Switch Profile", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        await tv.page.locator('[data-focus="profiles"]').focus();
        assert.equal(await tv.page.locator('[data-focus="profiles"]').getAttribute("aria-expanded"), "false", "the dwell has not opened the menu");
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "switch-profile", "Down before the dwell still enters Switch Profile");
        assert.equal(await tv.page.locator('[data-focus="profiles"]').getAttribute("aria-expanded"), "true");
    } finally { await tv.page.context().close(); }
});

test("focused avatar paints Apple's inset white ring above loaded artwork", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        const avatar = tv.page.locator('[data-focus="profiles"]');
        await avatar.locator('.navigation-avatar').evaluate(node => {
            const image = document.createElement("img");
            image.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="red"/></svg>';
            node.appendChild(image);
            return image.decode();
        });
        await avatar.focus();
        const paintedWhite = async (): Promise<boolean> => {
            const png = await avatar.screenshot({ animations: "disabled" });
            return tv.page.evaluate(async source => {
                const image = new Image(); image.src = source; await image.decode();
                const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
                const context = canvas.getContext("2d"); if (context === null) throw new Error("No canvas");
                context.drawImage(image, 0, 0);
                const pixel = context.getImageData(Math.floor(image.width / 2), 2, 1, 1).data;
                return pixel[0] === 255 && pixel[1] === 255 && pixel[2] === 255;
            }, `data:image/png;base64,${png.toString("base64")}`);
        };
        assert.equal(await paintedWhite(), true, "opaque white ring must paint above red artwork");
        await tv.page.locator('[data-focus="home"]').focus();
        assert.equal(await avatar.evaluate(node => getComputedStyle(node).outlineStyle), "none");
        assert.equal(await paintedWhite(), false, "unfocused avatar has no white ring");
    } finally { await tv.page.context().close(); }
});

test("Music is library-gated and opens an explicit unavailable page without video queries", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = new RecommendationsCatalog();
        catalog.households.get("p-owner")?.libraries.push({ id: "99", name: "Music", type: "music", sort_order: 3 });
        await start(tv, null, catalog);
        await tv.page.locator('[data-focus="music"]').click();
        await tv.page.getByText("Music browsing is not available on this TV.", { exact: true }).waitFor();
        assert.equal(tv.fake.requests.some(request => request.path.startsWith("/library/99/") || request.body?.library_id === "99"), false);
        await tv.remote(10009);
        assert.equal(await tv.focused(), "music");
        await tv.remote(10009);
        assert.equal(await tv.page.locator('.browse').getAttribute("data-view"), "home");
        assert.equal(await tv.focused(), "movie:m0001");
    } finally { await tv.page.context().close(); }
});

test("the bar centers fixed roots despite authored order with fixed Search and avatar utilities", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await start(tv, { items: [
            { type: "builtin", destination: "home" }, { type: "builtin", destination: "series" },
            { type: "builtin", destination: "movies" }, { type: "builtin", destination: "for_you" },
            { type: "builtin", destination: "calendar" },
        ] });
        await tv.page.waitForFunction(() => document.querySelector(".skyline-roots")?.textContent === "HomeMoviesSeriesFor YouCalendar");
        assert.deepEqual(await tv.page.locator(".browse-nav [data-focus]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus"))), ["search", "home", "movies", "series", "for_you", "calendar", "profiles"]);
        const geometry = await tv.page.evaluate(() => {
            const roots = document.querySelector(".skyline-roots")?.getBoundingClientRect();
            const avatar = document.querySelector('[data-focus="profiles"]')?.getBoundingClientRect();
            if (roots === undefined || avatar === undefined) throw new Error("Missing bar");
            return { center: roots.x + roots.width / 2, avatar: [avatar.x, avatar.y, avatar.width, avatar.height] };
        });
        assert.ok(Math.abs(geometry.center - 960) < 1);
        assert.deepEqual(geometry.avatar, [1774, 59, 58, 58]);
        await tv.remote(38);
        assert.equal(await tv.focused(), "home");
        await tv.remote(37);
        assert.equal(await tv.focused(), "search");
    } finally { await tv.page.context().close(); }
});

test("an expired session on an expanded For You row offers Sign In Again first and Try Again second", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv, null, new RecommendationsCatalog(), true);
        await tv.page.route("**/api/v2/recommendations/section/**", route => route.fulfill({ status: 401, contentType: "application/problem+json", body: JSON.stringify({ type: "about:blank", title: "Unauthorized", status: 401 }) }));
        await tv.page.locator('[data-focus="for_you"]').click();
        await tv.page.locator('.browse[data-view="for_you"] .browse-card').first().waitFor();
        await tv.page.locator('[data-focus^="expand:recommendation:"]').first().click();
        const page = tv.page.locator('[data-view^="recommendationSection:"] .details-failure');
        await page.waitFor();
        assert.equal(await page.locator(".search-state-title").innerText(), "Session expired");
        assert.deepEqual(await page.locator(".browse-button").allInnerTexts(), ["Sign In Again", "Try Again"]);
        assert.equal(await tv.focused(), "sign-in");
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "retry");
        await tv.page.keyboard.press("ArrowUp");
        await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.signOutCalls) === 1, "Sign In Again signs out");
    } finally { await tv.page.context().close(); }
});

test("For You shares Home shelves and expands only rows with a supported locator", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = new RecommendationsCatalog();
        const title = catalog.titles.get("movie:m0001");
        assert.ok(title);
        catalog.titles.set(title.id, { ...title, backdrop: "/art/river.svg" });
        await start(tv, null, catalog);
        await tv.page.locator('[data-focus="for_you"]').click();
        await tv.page.locator('.browse[data-view="for_you"] .browse-card').first().waitFor();
        assert.deepEqual(await tv.page.locator(".browse > .skyline-content .browse-section-title").allTextContents(), ["For You", "Popular", "A new shelf"]);
        assert.equal(await tv.page.locator('.browse').evaluate(node => node.classList.contains("skyline-home")), true);
        assert.equal(await tv.page.locator(".browse > .skyline-marquee .skyline-marquee-art:not(.skyline-outgoing) .skyline-backdrop").count(), 1, "the fixture supplies backdrop artwork");
        assert.equal(await tv.page.locator(".browse > .skyline-marquee .skyline-marquee-art:not(.skyline-outgoing) .skyline-hero-backdrop").count(), 1, "For You uses Home's calibrated artwork and tint owner");
        assert.equal(await tv.page.locator('[data-focus^="expand:recommendation:"]').count(), 2);
        const reads = tv.fake.requests.length;
        await tv.remote(39);
        assert.equal(tv.fake.requests.length, reads, "focus does not read");
        await tv.page.locator('[data-focus^="expand:recommendation:"]').first().click();
        await tv.page.locator('[data-view^="recommendationSection:"] .browse-card').first().waitFor();
        assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/recommendations/section/cluster")).length, 1);
        assert.equal(tv.fake.requests.some(request => request.path.includes("/home/sections/recommendation")), false);
        await tv.remote(10009);
        await tv.page.locator('[data-view="for_you"] .browse-card').first().waitFor();
        assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/recommendations/discover")).length, 1);
    } finally { await tv.page.context().close(); }
});

test("For You retains cached recommendations after remount while unreachable", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        await tv.page.locator('[data-focus="for_you"]').click();
        await tv.page.locator('[data-view="for_you"] .browse-card').first().waitFor();
        let rejected = 0;
        await tv.page.route("**/api/v2/**", route => { rejected++; return route.abort("connectionrefused"); });
        await tv.page.evaluate(() => { window.browseHarness.destroy(); window.browseHarness.mount(); });
        await tv.page.locator('[data-focus="for_you"]').click();
        await tv.page.locator('[data-view="for_you"] .browse-card').first().waitFor();
        await jumpUntil(tv, 1000, () => tv.page.evaluate(() => window.browseHarness.cacheOffline("for_you")), "cached transport failure");
        assert.ok(await tv.page.locator('[data-view="for_you"] .browse-card').count() > 0);
        assert.ok(rejected > 0, "fresh mount attempted reads while unreachable");
        assert.doesNotMatch(await tv.page.locator(".browse").innerText(), /Can't reach server|showing cached content/);
    } finally { await tv.page.context().close(); }
});

test("library section rows use the Swift flyout text, padding and icon footprint", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await start(tv);
        await tv.page.locator('[data-focus="movies"]').focus();
        await tv.remote(40);
        assert.equal(await tv.focused(), "section:Recommended");
        const geometry = await tv.page.locator('.skyline-selector [data-focus="section:Recommended"]').evaluate(node => ({ font: getComputedStyle(node).fontSize, height: node.getBoundingClientRect().height, icon: node.querySelector("svg")?.getBoundingClientRect().width }));
        assert.deepEqual(geometry, { font: "20px", height: 50, icon: 26 });
    } finally { await tv.page.context().close(); }
});

test("For You dwell is passive, Down enters and Back suppresses reopening", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        await tv.page.locator('[data-focus="for_you"]').focus();
        await tv.jump(250);
        assert.equal(await tv.focused(), "for_you");
        assert.deepEqual(await tv.page.locator('.skyline-selector [role="menuitem"]').allTextContents(), ["Watchlist", "Favorites", "Recommendations"]);
        assert.equal(tv.fake.requests.some(request => request.path.startsWith("/recommendations/discover")), false);
        await tv.remote(40);
        assert.equal(await tv.focused(), "watchlist");
        await tv.remote(38);
        assert.equal(await tv.focused(), "for_you", "Up from the first row returns to its anchor");
        await tv.remote(40);
        assert.equal(await tv.focused(), "watchlist");
        await tv.remote(10009);
        assert.equal(await tv.focused(), "for_you");
        await tv.jump(500);
        assert.equal(await tv.page.locator(".skyline-selector:not(.skyline-flyout)").isVisible(), false);
        for (let i = 0; i < 4; i++) await tv.remote(40);
        assert.equal(await tv.focused(), "movie:m0001", "Down from the last action returns to content");
        assert.equal(tv.fake.requests.some(request => request.path.startsWith("/recommendations/discover")), false);
    } finally { await tv.page.context().close(); }
});

test("a late authored menu preserves content focus and cannot add a library shortcut", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const held = tv.fake.hold("/settings/values/effective?keys=nav.primary_menu", true);
    try {
        await start(tv, { items: [{ type: "builtin", destination: "home" }, { type: "library", library_id: 12, label: "Films" }, { type: "builtin", destination: "for_you" }] });
        const card = tv.page.locator(".browse > .skyline-content .browse-card").last();
        await card.focus();
        const focused = await tv.focused();
        held.release();
        await tv.page.clock.runFor(0);
        assert.equal(await tv.page.locator('.skyline-roots [data-focus="library:12"]').count(), 0);
        assert.equal(await tv.focused(), focused);
        await tv.page.locator('.skyline-roots [data-focus="movies"]').click();
        await tv.page.locator('[data-view="library:12"] .home-section').waitFor();
        assert.equal(await tv.page.locator('.skyline-roots [aria-current="page"]').getAttribute("data-focus"), "movies");
        await tv.page.locator('[data-focus="movies"]').first().focus();
        await tv.remote(40);
        assert.equal(await tv.focused(), "section:Recommended");
        await tv.remote(10009);
        assert.equal(await tv.focused(), "movies");
    } finally { held.release(); await tv.page.context().close(); }
});

test("a mixed library appears under Movies and keeps its video category when a mode is selected", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = new RecommendationsCatalog();
        const library = catalog.households.get("p-owner")?.libraries.find(item => item.id === "12");
        assert.ok(library);
        library.type = "mixed";
        await start(tv, { items: [{ type: "builtin", destination: "home" }, { type: "library", library_id: 12, label: "Mixed" }] }, catalog);
        assert.equal(await tv.page.locator('[data-focus="library:12"]').count(), 0);
        await tv.page.locator('[data-focus="movies"]').focus();
        await tv.remote(40); await tv.remote(40); await tv.remote(40);
        assert.equal(await tv.focused(), "section:browse");
        await tv.page.keyboard.press("Enter");
        await tv.page.locator('.library-browse .catalog-grid .browse-card').first().waitFor();
        const query = tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).pop();
        assert.ok(query);
        assert.equal(query.body?.type, "movie", "Movies narrows a mixed library to movies");
    } finally { await tv.page.context().close(); }
});

test("a late authored menu waits for an entered dropdown to close", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const held = tv.fake.hold("/settings/values/effective?keys=nav.primary_menu", true);
    try {
        await start(tv, { items: [{ type: "builtin", destination: "home" }, { type: "builtin", destination: "movies" }, { type: "builtin", destination: "for_you" }] });
        await tv.page.locator('[data-focus="movies"]').focus();
        await tv.remote(40);
        const row = await tv.page.locator('.skyline-selector [data-focus="section:Recommended"]').elementHandle();
        assert.ok(row);
        const answer = tv.page.waitForResponse(response => new URL(response.url()).searchParams.get("keys") === PRIMARY_MENU_KEY);
        held.release();
        assert.equal(await (await answer).finished(), null);
        await tv.page.clock.runFor(0);
        assert.equal(await row.evaluate(node => node.isConnected), true);
        assert.equal(await tv.focused(), "section:Recommended");
        await tv.remote(10009);
        await tv.page.waitForFunction(() => document.querySelector(".skyline-roots")?.textContent === "HomeMoviesSeriesFor YouCalendar");
        assert.equal(await tv.focused(), "movies");
    } finally { held.release(); await tv.page.context().close(); }
});

test("returning to cached Home restarts enrichment cancelled by For You", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const path = "/catalog/items/movie%3Am0001";
    const held = tv.fake.hold(path, true);
    try {
        await start(tv);
        await tv.eventually(async () => tv.fake.requests.some(request => request.path.startsWith(path)), "Home enrichment in flight");
        await tv.page.locator('[data-focus="for_you"]').click();
        await tv.page.locator('[data-view="for_you"] .browse-card').first().waitFor();
        held.release();
        await tv.jump(0);
        const afterCancel = tv.fake.requests.filter(request => request.path.startsWith(path)).length;
        await tv.page.locator('[data-focus="home"]').click();
        await tv.page.locator('[data-view="home"] .browse-card').first().waitFor();
        await tv.jump(200);
        await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith(path)).length === afterCancel + 1, "unfinished Home detail restarted");
    } finally { held.release(); await tv.page.context().close(); }
});

test("a deferred menu keeps root focus when leaving a passive dropdown horizontally", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const held = tv.fake.hold("/settings/values/effective?keys=nav.primary_menu", true);
    try {
        await start(tv, { items: (["home", "movies", "series", "for_you"] as const).map(destination => ({ type: "builtin", destination })) });
        await tv.page.locator('[data-focus="movies"]').focus();
        await tv.jump(250);
        const answer = tv.page.waitForResponse(response => new URL(response.url()).searchParams.get("keys") === PRIMARY_MENU_KEY);
        held.release();
        assert.equal(await (await answer).finished(), null);
        await tv.page.clock.runFor(0);
        await tv.remote(39);
        assert.equal(await tv.focused(), "series");
        assert.equal(await tv.page.locator(".skyline-roots").textContent(), "HomeMoviesSeriesFor YouCalendar");
    } finally { held.release(); await tv.page.context().close(); }
});

test("horizontal navigation between passive dropdowns keeps normal dwell", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        await tv.page.locator('[data-focus="movies"]').focus();
        await tv.jump(250);
        await tv.remote(39);
        await tv.jump(250);
        assert.equal(await tv.focused(), "series");
        assert.equal(await tv.page.locator(".skyline-selector:not(.skyline-flyout)").evaluate(node => (node as HTMLElement).hidden), false);
        assert.equal(await tv.page.locator(".skyline-selector:not(.skyline-flyout)").getAttribute("aria-label"), "SHOWS menu");
    } finally { await tv.page.context().close(); }
});

test("a long authored menu cannot add roots and Search and the avatar remain fixed", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        const catalog = new RecommendationsCatalog();
        const household = catalog.households.get("p-owner");
        assert.ok(household);
        const shortcuts = Array.from({ length: 10 }, (_, index) => ({ type: "library" as const, library_id: 100 + index, label: `A long library label ${index}` }));
        for (const shortcut of shortcuts) household.libraries.push({ id: String(shortcut.library_id), name: shortcut.label, type: "movies", sort_order: 100 + shortcut.library_id });
        await start(tv, { items: [{ type: "builtin", destination: "home" }, ...shortcuts] }, catalog);
        assert.equal(await tv.page.locator('.skyline-roots [data-focus^="library:"]').count(), 0);
        await tv.page.locator('[data-focus="home"]').focus();
        const reads = tv.fake.requests.length;
        for (let i = 0; i < 4; i++) await tv.remote(39);
        assert.equal(await tv.focused(), "calendar");
        const geometry = await tv.page.evaluate(() => {
            const roots = document.querySelector<HTMLElement>(".skyline-roots");
            const search = document.querySelector('[data-focus="search"]')?.getBoundingClientRect();
            const avatar = document.querySelector('[data-focus="profiles"]')?.getBoundingClientRect();
            const focused = document.activeElement?.getBoundingClientRect();
            if (roots === null || search === undefined || avatar === undefined || focused === undefined) throw new Error("Missing bar");
            const bounds = roots.getBoundingClientRect();
            return { scroll: roots.scrollLeft, left: focused.left >= bounds.left - 1, right: focused.right <= bounds.right + 1, search: search.right <= bounds.left, avatar: avatar.x };
        });
        assert.equal(geometry.scroll, 0);
        assert.equal(geometry.left && geometry.right && geometry.search, true);
        assert.equal(geometry.avatar, 1774);
        assert.equal(tv.fake.requests.length, reads, "root focus never fetches");
    } finally { await tv.page.context().close(); }
});

test("For You loading and empty states own focus without carrying Home's hero", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const held = tv.fake.hold("/recommendations/discover", true);
    try {
        const catalog = new RecommendationsCatalog();
        catalog.recommendationReply = { status: 200, body: { items: [] } };
        await start(tv, null, catalog);
        await tv.page.locator('[data-focus="for_you"]').click();
        await tv.page.getByText("Loading recommendations", { exact: true }).waitFor();
        assert.equal(await tv.page.locator(".browse > .skyline-marquee").count(), 0);
        assert.equal(await tv.focused(), "home");
        held.release();
        await tv.page.getByText("No recommendations yet", { exact: true }).waitFor();
        assert.equal(await tv.page.locator(".browse > .skyline-marquee").count(), 0);
        await tv.remote(10009);
        assert.equal(await tv.focused(), "for_you", "Back first returns to the current root");
        await tv.remote(10009);
        await tv.page.locator('[data-view="home"]').waitFor();
    } finally { held.release(); await tv.page.context().close(); }
});

test("For You failure has an explicit retry that waits for loaded shelves", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = new RecommendationsCatalog();
        catalog.recommendationReply = { status: 400, body: { type: "about:blank", title: "Bad request", status: 400, code: "invalid_argument" } };
        await start(tv, null, catalog);
        await tv.page.locator('[data-focus="for_you"]').click();
        await tv.page.locator('[data-view="for_you"] [data-focus="retry"]').waitFor();
        assert.equal(await tv.page.locator(".browse > .skyline-marquee").count(), 0);
        catalog.recommendationReply = undefined;
        await tv.page.locator('[data-focus="retry"]').click();
        await tv.page.locator('[data-view="for_you"] > .skyline-content .browse-card').first().waitFor();
        assert.equal(await tv.page.locator('[data-view="for_you"] [data-focus="retry"]').count(), 0);
    } finally { await tv.page.context().close(); }
});

// Issue #400: the bar, avatar and panels against silo-apple 7e478b2 tvOS (TVTopMenuBar.swift, TVMainTabView.swift).
const SPRING_EASING = "cubic-bezier(0.3, 0.25, 0.2, 1.02)";

interface LeavingCopy { kind: string | undefined; motion: string[]; focusable: number; inert: boolean | undefined; hidden: string | null | undefined }
/** The fading copies live for 200 ms of real time, so record each one as it is inserted rather than racing the timer. */
async function recordLeaving(tv: Tv): Promise<() => Promise<LeavingCopy[]>> {
    await tv.page.evaluate(() => {
        const holder = document.querySelector(".skyline-leaving");
        if (holder === null) throw new Error("Missing leaving holder");
        const records: LeavingCopy[] = [];
        (window as unknown as { leavingCopies: LeavingCopy[] }).leavingCopies = records;
        new MutationObserver(changes => {
            for (const change of changes) for (const node of Array.from(change.addedNodes)) {
                if (!(node instanceof HTMLElement)) continue;
                const style = getComputedStyle(node);
                records.push({ kind: node.classList[0], motion: [style.animationName, style.animationDuration, style.animationTimingFunction], focusable: node.querySelectorAll("[data-focus], [id]").length, inert: node.closest<HTMLElement>(".skyline-leaving")?.inert, hidden: node.closest(".skyline-leaving")?.getAttribute("aria-hidden") });
            }
        }).observe(holder, { childList: true });
    });
    return () => tv.page.evaluate(() => (window as unknown as { leavingCopies: LeavingCopy[] }).leavingCopies.splice(0));
}

test("on Home, Back from Search, a tab or the avatar returns to the Home tab before the exit prompt", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        for (const key of ["search", "movies", "profiles"]) {
            await tv.page.locator(`[data-focus="${key}"]`).focus();
            await tv.remote(10009);
            assert.equal(await tv.focused(), "home", `Back from ${key} focuses the Home tab`);
            assert.equal(await tv.page.locator(".browse").getAttribute("data-view"), "home");
        }
        await tv.page.locator('[data-focus="movies"]').focus();
        await tv.jump(250);
        assert.equal(await tv.page.locator('[data-focus="movies"]').getAttribute("aria-expanded"), "true");
        await tv.remote(10009);
        assert.equal(await tv.focused(), "movies", "the first Back closes the open panel");
        await tv.remote(10009);
        assert.equal(await tv.focused(), "home", "the next Back reaches the Home tab");
    } finally { await tv.page.context().close(); }
});

test("tabs use Apple's white label colours, cap-scaled size, 318 px capsule cap and spring", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        const style = (key: string) => tv.page.locator(`[data-focus="${key}"]`).evaluate(node => {
            const computed = getComputedStyle(node);
            return { color: computed.color, size: computed.fontSize, tracking: computed.letterSpacing, maxWidth: computed.maxWidth, property: computed.transitionProperty, duration: computed.transitionDuration, easing: computed.transitionTimingFunction };
        });
        const movies = await style("movies");
        assert.deepEqual(movies, { color: "rgba(255, 255, 255, 0.62)", size: "25.181px", tracking: "normal", maxWidth: "318px", property: "background-color, border-color, color", duration: "0.32s, 0.32s, 0.32s", easing: [SPRING_EASING, SPRING_EASING, SPRING_EASING].join(", ") });
        assert.equal((await style("home")).color, "rgb(255, 255, 255)", "the selected tab is white");
        assert.equal((await style("search")).color, "rgba(255, 255, 255, 0.62)", "the resting magnifier is white at 62%");
        assert.deepEqual(await tv.page.locator(".browse-nav").evaluate(node => [getComputedStyle(node).transitionDuration, getComputedStyle(node).transitionTimingFunction]), ["0.2s", "ease-in-out"]);
        await tv.page.locator('[data-focus="movies"]').press("Enter");
        await tv.page.locator('.browse[data-view="library:12"]').waitFor();
        const home = await style("home");
        assert.deepEqual([home.duration, home.easing], ["0.18s", "ease-in-out"], "losing selection without focus eases over 0.18 s");
        await tv.page.locator('[data-focus="home"]').focus();
        assert.equal((await style("home")).duration, "0.32s, 0.32s, 0.32s", "a focus change springs again");
    } finally { await tv.page.context().close(); }
});

for (const reduced of [false, true]) test(`the avatar keeps its white 18% disc on focus and ${reduced ? "snaps under Reduce Motion" : "springs to 1.05 with a 3 px ring"}`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        if (reduced) await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await start(tv);
        const avatar = tv.page.locator('[data-focus="profiles"]');
        const look = () => avatar.evaluate(node => {
            for (const animation of document.getAnimations()) animation.finish();
            const fallback = node.querySelector(".navigation-avatar-fallback") as HTMLElement;
            return { fill: getComputedStyle(node).backgroundColor, ink: getComputedStyle(node).color, transform: getComputedStyle(node).transform, ring: getComputedStyle(node, "::after").borderTopWidth, initial: getComputedStyle(fallback).fontSize, weight: getComputedStyle(fallback).fontWeight };
        });
        assert.deepEqual(await look(), { fill: "rgba(255, 255, 255, 0.18)", ink: "rgb(255, 255, 255)", transform: "none", ring: "0px", initial: "19.72px", weight: "600" });
        await avatar.focus();
        assert.deepEqual(await look(), { fill: "rgba(255, 255, 255, 0.18)", ink: "rgb(255, 255, 255)", transform: reduced ? "none" : "matrix(1.05, 0, 0, 1.05, 0, 0)", ring: "3px", initial: "19.72px", weight: "600" });
        await tv.jump(250);
        const header = await tv.page.locator(".skyline-profile-header .navigation-avatar").evaluate(node => ({ fill: getComputedStyle(node).backgroundColor, ink: getComputedStyle(node).color, initial: getComputedStyle(node.querySelector(".navigation-avatar-fallback") as HTMLElement).fontSize }));
        assert.deepEqual(header, { fill: "rgba(255, 255, 255, 0.16)", ink: "rgb(255, 255, 255)", initial: "14.96px" });
    } finally { await tv.page.context().close(); }
});

test("a nameless avatar draws the person glyph at Apple's 0.36 size in secondary text", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        const glyph = await tv.page.evaluate(() => {
            const avatar = document.createElement("span");
            avatar.className = "navigation-avatar";
            avatar.style.setProperty("--avatar-size", "58px");
            avatar.innerHTML = '<span class="navigation-avatar-fallback"><svg class="navigation-avatar-person" viewBox="0 0 92 100"></svg></span>';
            document.querySelector(".browse-nav")?.appendChild(avatar);
            const svg = avatar.querySelector("svg") as SVGSVGElement;
            const box = svg.getBoundingClientRect();
            return { width: Math.round(box.width * 100) / 100, height: Math.round(box.height * 100) / 100, color: getComputedStyle(svg).color };
        });
        assert.deepEqual(glyph, { width: 17.22, height: 18.72, color: "rgba(237, 237, 237, 0.6)" });
    } finally { await tv.page.context().close(); }
});

for (const reduced of [false, true]) test(`top-bar panels use Apple's panel chrome and ${reduced ? "snap under Reduce Motion" : "grow from and shrink toward their anchor"}`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        if (reduced) await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await start(tv);
        const leavingCopies = await recordLeaving(tv);
        for (const anchor of ["movies", "profiles"]) {
            await tv.page.locator(`[data-focus="${anchor}"]`).focus();
            await tv.jump(250);
            const chrome = await tv.page.evaluate(key => {
                const panel = document.querySelector<HTMLElement>(".skyline-selector:not(.skyline-flyout)");
                const flyout = document.querySelector<HTMLElement>(".skyline-flyout");
                const tab = document.querySelector<HTMLElement>(`[data-focus="${key}"]`);
                if (panel === null || flyout === null || tab === null) throw new Error("Missing panel");
                const style = getComputedStyle(panel);
                const hairline = getComputedStyle(panel, "::before");
                const rect = tab.getBoundingClientRect();
                return {
                    background: style.backgroundImage, shadow: style.boxShadow, material: style.backdropFilter,
                    hairline: hairline.backgroundImage, hairlineWidth: hairline.paddingTop,
                    motion: [style.animationName, style.animationDuration, style.animationTimingFunction],
                    flyout: [getComputedStyle(flyout).animationName, getComputedStyle(flyout).animationDuration, getComputedStyle(flyout).animationTimingFunction],
                    origin: style.transformOrigin.split(" ").map(parseFloat), expected: [rect.left + rect.width / 2 - panel.offsetLeft, 0],
                };
            }, anchor);
            assert.equal(chrome.background, "linear-gradient(rgba(35, 37, 44, 0.92), rgba(20, 21, 25, 0.95))");
            assert.equal(chrome.shadow, "rgba(0, 0, 0, 0.35) 0px 4px 16px 0px, rgba(0, 0, 0, 0.55) 0px 24px 80px 0px");
            assert.equal(chrome.material, "blur(30px)");
            assert.equal(chrome.hairline, "linear-gradient(rgba(255, 255, 255, 0.22), rgba(255, 255, 255, 0.05))");
            assert.equal(chrome.hairlineWidth, "1px");
            assert.deepEqual(chrome.motion, reduced ? ["none", "0s", "ease"] : ["skyline-panel", "0.12s", "ease-out"]);
            if (!reduced) assert.deepEqual(chrome.flyout, ["skyline-appear", "0.16s", "ease-in-out"]);
            assert.ok(Math.abs((chrome.origin[0] ?? Number.NaN) - (chrome.expected[0] ?? 0)) < 0.01 && chrome.origin[1] === 0, `${anchor}: the panel scales from under its anchor, ${chrome.origin.join(" ")}`);
            await tv.remote(10009);
            assert.equal(await tv.page.locator(".skyline-selector:not(.skyline-flyout)").isVisible(), false, "the live panel closes at once");
            const leaving = await leavingCopies();
            if (reduced) assert.deepEqual(leaving, [], "Reduce Motion leaves no fading copy");
            else {
                assert.deepEqual(leaving, [{ kind: "skyline-selector-leaving", motion: ["skyline-panel-leave", "0.12s", "ease-out"], focusable: 0, inert: true, hidden: "true" }]);
                await tv.page.waitForFunction(() => document.querySelector(".skyline-leaving")?.childElementCount === 0);
            }
        }
    } finally { await tv.page.context().close(); }
});

test("the top bar's sign-out confirmation fades in and out over Apple's easeOut(0.2)", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv, null, new RecommendationsCatalog(), true);
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.locator('[data-focus="signout"]').click();
        await tv.page.getByRole("alertdialog", { name: "Sign Out" }).waitFor();
        const motion = (selector: string) => tv.page.evaluate(selector => {
            const node = document.querySelector<HTMLElement>(selector);
            return node === null ? null : [getComputedStyle(node).animationName, getComputedStyle(node).animationDuration, getComputedStyle(node).animationTimingFunction];
        }, selector);
        assert.deepEqual(await motion(".skyline-selector[data-confirmation]"), ["skyline-appear", "0.2s", "ease-out"]);
        assert.deepEqual(await motion(".skyline-dropdown-scrim[data-confirmation]"), ["skyline-appear", "0.2s", "ease-out"]);
        const leavingCopies = await recordLeaving(tv);
        await tv.remote(10009);
        assert.equal(await tv.page.getByRole("alertdialog").count(), 0);
        // Both copies sit at z-index 6, so the backdrop has to come first to paint under its dialog.
        const fade = { motion: ["skyline-leave", "0.2s", "ease-out"], focusable: 0, inert: true, hidden: "true" };
        assert.deepEqual(await leavingCopies(), [{ kind: "skyline-dropdown-scrim-leaving", ...fade }, { kind: "skyline-selector-leaving", ...fade }]);
        assert.equal(await tv.page.evaluate(() => window.browseHarness.signOutCalls), 0);
    } finally { await tv.page.context().close(); }
});
