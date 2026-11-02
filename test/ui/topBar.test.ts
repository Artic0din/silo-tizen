import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import type { Browser } from "playwright";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import type { Reply } from "../native/support/fakeSilo.ts";
import { PRIMARY_MENU_KEY, type PrimaryMenu } from "../../src/contracts/v2/navigation.ts";
import { HIDDEN_KEY } from "../../src/contracts/v2/settings.ts";
import { launchBrowser, openTv, homeDetailsRead, type Tv } from "./support/tv.ts";

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

async function start(tv: Tv, menu: PrimaryMenu | null = null, catalog = new RecommendationsCatalog()): Promise<void> {
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
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.page.locator('.browse[data-view="home"] .browse-card').first().waitFor();
    await homeDetailsRead(tv);
}

test("the bar centers authored roots with fixed Search and avatar utilities", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await start(tv, { items: [
            { type: "builtin", destination: "home" }, { type: "builtin", destination: "series" },
            { type: "builtin", destination: "movies" }, { type: "builtin", destination: "for_you" },
            { type: "builtin", destination: "calendar" },
        ] });
        await tv.page.waitForFunction(() => document.querySelector(".skyline-roots")?.textContent === "HomeSeriesMoviesFor YouCalendar");
        assert.deepEqual(await tv.page.locator(".browse-nav [data-focus]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus"))), ["search", "home", "series", "movies", "for_you", "calendar", "profiles"]);
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
        assert.equal(await tv.page.locator(".browse > .skyline-marquee .skyline-marquee-layer:not(.skyline-outgoing) .skyline-backdrop").count(), 1, "the fixture supplies backdrop artwork");
        assert.equal(await tv.page.locator(".browse > .skyline-marquee .skyline-marquee-layer:not(.skyline-outgoing) .skyline-hero-backdrop").count(), 1, "For You uses Home's calibrated artwork and tint owner");
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

test("a late authored menu preserves content focus and a library shortcut keeps its own selection", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const held = tv.fake.hold("/settings/values/effective?keys=nav.primary_menu", true);
    try {
        await start(tv, { items: [{ type: "builtin", destination: "home" }, { type: "library", library_id: 12, label: "Films" }, { type: "builtin", destination: "for_you" }] });
        const card = tv.page.locator(".browse > .skyline-content .browse-card").last();
        await card.focus();
        const focused = await tv.focused();
        held.release();
        await tv.page.locator('.skyline-roots [data-focus="library:12"]').waitFor();
        assert.equal(await tv.focused(), focused);
        await tv.page.locator('.skyline-roots [data-focus="library:12"]').click();
        await tv.page.locator('[data-view="library:12"] .skyline-pills').waitFor();
        assert.equal(await tv.page.locator('.skyline-roots [aria-current="page"]').getAttribute("data-focus"), "library:12");
        await tv.page.locator('[data-focus="library:12"]').first().focus();
        await tv.remote(40);
        assert.equal(await tv.focused(), "section:Recommended");
        await tv.remote(10009);
        assert.equal(await tv.focused(), "library:12");
    } finally { held.release(); await tv.page.context().close(); }
});

test("a long authored menu scrolls roots while Search and the avatar remain fixed", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        const catalog = new RecommendationsCatalog();
        const household = catalog.households.get("p-owner");
        assert.ok(household);
        const shortcuts = Array.from({ length: 10 }, (_, index) => ({ type: "library" as const, library_id: 100 + index, label: `A long library label ${index}` }));
        for (const shortcut of shortcuts) household.libraries.push({ id: String(shortcut.library_id), name: shortcut.label, type: "movies", sort_order: 100 + shortcut.library_id });
        await start(tv, { items: [{ type: "builtin", destination: "home" }, ...shortcuts] }, catalog);
        await tv.page.locator('[data-focus="library:109"]').waitFor();
        await tv.page.locator('[data-focus="home"]').focus();
        const reads = tv.fake.requests.length;
        for (let i = 0; i < 10; i++) await tv.remote(39);
        assert.equal(await tv.focused(), "library:109");
        const geometry = await tv.page.evaluate(() => {
            const roots = document.querySelector<HTMLElement>(".skyline-roots");
            const search = document.querySelector('[data-focus="search"]')?.getBoundingClientRect();
            const avatar = document.querySelector('[data-focus="profiles"]')?.getBoundingClientRect();
            const focused = document.activeElement?.getBoundingClientRect();
            if (roots === null || search === undefined || avatar === undefined || focused === undefined) throw new Error("Missing bar");
            const bounds = roots.getBoundingClientRect();
            return { scroll: roots.scrollLeft, left: focused.left >= bounds.left - 1, right: focused.right <= bounds.right + 1, search: search.right <= bounds.left, avatar: avatar.x };
        });
        assert.ok(geometry.scroll > 0);
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
