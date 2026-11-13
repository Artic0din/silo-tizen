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
        assert.equal(await tv.focused(), "history", "Down enters History, the first row, while the menu is open");
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

test("Down from the avatar before the dwell opens the menu on History", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        await tv.page.locator('[data-focus="profiles"]').focus();
        assert.equal(await tv.page.locator('[data-focus="profiles"]').getAttribute("aria-expanded"), "false", "the dwell has not opened the menu");
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "history", "Down before the dwell still enters History");
        assert.equal(await tv.page.locator('[data-focus="profiles"]').getAttribute("aria-expanded"), "true");
    } finally { await tv.page.context().close(); }
});

// TVProfileDropdown.panel (silo-apple 5780c84 `tvOS/Navigation/TVTopMenuBar.swift:1185-1215`): History, Requests and
// Watch Party, a divider, then Settings, the profile row, Change Account and Sign Out.
test("the profile menu lists Apple's rows in Apple's order with the divider before Settings", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv, null, new ProfileDestinationsCatalog(), true);
        await tv.page.locator('[data-focus="profiles"]').focus();
        await tv.jump(250);
        const rows = await tv.page.locator(".skyline-selector[data-menu-kind=\"profile\"] > *").evaluateAll(nodes => nodes.map(node =>
            node.classList.contains("skyline-menu-divider") ? "divider" : node.classList.contains("skyline-profile-header") ? "header" : node.textContent ?? ""));
        assert.deepEqual(rows, ["header", "History", "Requests", "divider", "Settings", "Switch Profile", "Sign Out"]);
    } finally { await tv.page.context().close(); }
});

// The dwell previews the menu with focus left on the avatar (TVMainTabView.swift:802-831); Select opens it and
// enters the first row, also when the dwell already opened it (openProfilePanelImmediately, :835-853).
for (const how of ["Select", "the dwell, then Select"] as const) test(`${how} on the avatar enters History`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        const avatar = tv.page.locator('[data-focus="profiles"]');
        await avatar.focus();
        if (how !== "Select") {
            await tv.jump(250);
            assert.equal(await avatar.getAttribute("aria-expanded"), "true", "the dwell opens the menu");
            await tv.jump(500);
            assert.equal(await tv.focused(), "profiles", "the dwell leaves focus on the avatar");
            assert.equal(await tv.page.locator(".skyline-selector .skyline-menu-item:focus").count(), 0, "no row is highlighted");
        }
        await tv.page.keyboard.press("Enter");
        assert.equal(await avatar.getAttribute("aria-expanded"), "true");
        assert.equal(await tv.focused(), "history", "Select enters the first row");
    } finally { await tv.page.context().close(); }
});

// The header's server line is SF Mono 14 with tracking 1.4 (TVTopMenuBar.swift:1240-1245). Roboto Mono advances 0.6em
// to SF Mono's 0.618em, so the line adds the 0.25 px difference to Apple's tracking.
test("the profile header's server line is the bundled mono face at Apple's tracking", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        await tv.page.locator('[data-focus="profiles"]').focus();
        await tv.jump(250);
        const style = await tv.page.locator(".skyline-profile-server").evaluate(node => { const css = getComputedStyle(node); return [css.fontFamily.split(",")[0]?.replace(/"/g, ""), css.fontSize, css.letterSpacing]; });
        assert.deepEqual(style, ["Roboto Mono", "14px", "1.65px"]);
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

const problem = (status: number, title: string): Reply => ({ status, body: { type: "about:blank", title, status } });

for (const [status, headline, buttons] of [[401, "Session expired", ["Sign In Again", "Try Again"]], [403, "Not allowed", ["Try Again"]], [404, "Not found", ["Try Again"]], [500, "Something went wrong", ["Try Again"]]] as const) {
    test(`For You with no rows shows Apple's ${status} error page with ${buttons.join(" and ")}`, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            await start(tv, null, new RecommendationsCatalog(), true);
            await tv.page.route("**/api/v2/recommendations/discover**", route => route.fulfill({ status, contentType: "application/problem+json", body: JSON.stringify({ type: "about:blank", title: headline, status }) }));
            await tv.page.locator('[data-focus="for_you"]').click();
            const page = tv.page.locator('[data-view="for_you"] .details-failure');
            await page.waitFor();
            assert.equal(await page.locator(".search-state-title").innerText(), headline);
            assert.deepEqual(await page.evaluate(node => { const box = node.getBoundingClientRect(); return [box.left + box.width / 2, box.top + box.height / 2]; }), [960, 510], "ErrorView fills the root page");
            assert.deepEqual(await page.locator(".browse-button").allInnerTexts(), buttons, "a root page has no Go Back");
            assert.equal(await tv.focused(), status === 401 ? "sign-in" : "retry");
            if (status !== 401) return;
            await tv.page.keyboard.press("ArrowDown");
            assert.equal(await tv.focused(), "retry");
            await tv.page.keyboard.press("ArrowUp");
            await tv.page.keyboard.press("Enter");
            await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.signOutCalls) === 1, "Sign In Again signs out");
        } finally { await tv.page.context().close(); }
    });
}

test("For You shares Home shelves and its rows end at their last card", async () => {
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
        assert.equal(await tv.page.locator(".browse > .skyline-content .skyline-explore").count(), 0, "RecommendationsView passes no onExploreAll");
        assert.equal(await tv.focused(), "movie:m0001");
        const reads = tv.fake.requests.length;
        await tv.remote(39);
        assert.equal(await tv.focused(), "movie:m0001", "the last card is the row's last stop");
        assert.equal(tv.fake.requests.length, reads, "focus does not read");
        assert.equal(tv.fake.requests.some(request => request.path.startsWith("/recommendations/section/")), false);
        assert.equal(tv.fake.requests.some(request => request.path.includes("/home/sections/recommendation")), false);
    } finally { await tv.page.context().close(); }
});

test("each visit to For You reads recommendations again, keeps the cached rows meanwhile and starts at the first row", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        const reads = (): number => tv.fake.requests.filter(request => request.path.startsWith("/recommendations/discover")).length;
        await tv.page.locator('[data-focus="for_you"]').click();
        await tv.page.locator('[data-view="for_you"] .browse-card').first().waitFor();
        assert.equal(reads(), 1);
        await tv.remote(40);
        assert.equal(await tv.page.evaluate(() => document.activeElement?.closest("[data-section]") === document.querySelectorAll(".skyline-content [data-section]")[1]), true, "Down reaches the second row");
        const held = tv.fake.hold("/recommendations/discover", true);
        try {
            await tv.page.locator('[data-focus="home"]').click();
            await tv.page.locator('[data-view="home"] .browse-card').first().waitFor();
            await tv.page.locator('[data-focus="for_you"]').click();
            await tv.eventually(async () => reads() === 2, "a second discover read");
            assert.ok(await tv.page.locator('[data-view="for_you"] > .skyline-content .browse-card').count() > 0, "cached rows stay on screen while the read runs");
            assert.equal(await tv.page.locator('[aria-label="Loading recommendations"]').count(), 0);
            assert.equal(await tv.page.evaluate(() => document.activeElement?.closest("[data-section]") === document.querySelector(".skyline-content [data-section]")), true, "the rebuilt page starts at its first row");
        } finally { held.release(); }
        await tv.jump(0);
        assert.equal(await tv.page.evaluate(() => document.activeElement?.closest("[data-section]") === document.querySelector(".skyline-content [data-section]")), true, "the answer keeps focus where it is");
    } finally { await tv.page.context().close(); }
});

test("a 403 or 404 on a later For You read keeps the rows on screen", async () => {
    for (const status of [403, 404]) {
        const tv = await openTv(browser, { app: "browse" });
        try {
            const catalog = new RecommendationsCatalog();
            await start(tv, null, catalog);
            await tv.page.locator('[data-focus="for_you"]').click();
            await tv.page.locator('[data-view="for_you"] .browse-card').first().waitFor();
            await tv.page.locator('[data-focus="home"]').click();
            await tv.page.locator('[data-view="home"] .browse-card').first().waitFor();
            catalog.recommendationReply = problem(status, "Refused");
            await tv.page.locator('[data-focus="for_you"]').click();
            await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/recommendations/discover")).length === 2, "second read");
            await tv.jump(0);
            assert.ok(await tv.page.locator('[data-view="for_you"] > .skyline-content .browse-card').count() > 0, `${status} keeps the rows`);
            assert.equal(await tv.page.locator(".details-failure").count(), 0);
        } finally { await tv.page.context().close(); }
    }
});

test("a 401 on a later For You read replaces the rows with Sign In Again", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = new RecommendationsCatalog();
        await start(tv, null, catalog, true);
        await tv.page.locator('[data-focus="for_you"]').click();
        await tv.page.locator('[data-view="for_you"] .browse-card').first().waitFor();
        await tv.page.locator('[data-focus="home"]').click();
        await tv.page.locator('[data-view="home"] .browse-card').first().waitFor();
        catalog.recommendationReply = problem(401, "Unauthorized");
        await tv.page.locator('[data-focus="for_you"]').click();
        const page = tv.page.locator('[data-view="for_you"] .details-failure');
        await page.waitFor();
        assert.equal(await page.locator(".search-state-title").innerText(), "Session expired");
        assert.deepEqual(await page.locator(".browse-button").allInnerTexts(), ["Sign In Again", "Try Again"]);
        assert.equal(await tv.page.locator('[data-view="for_you"] .browse-card').count(), 0, "the expired session replaces the retained rows");
        assert.equal(await tv.page.locator(".browse > .skyline-marquee").count(), 0, "no retained marquee behind the error");
        assert.equal(await tv.focused(), "sign-in");
        await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.signOutCalls) === 1, "Sign In Again signs out");
    } finally { await tv.page.context().close(); }
});

test("the For You menu is 460 wide, centred under its tab, with filled icons, scaled text, Apple's spoken name and a tab hint", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await start(tv);
        const tab = tv.page.locator('[data-focus="for_you"]');
        assert.equal(await tab.getAttribute("aria-description"), "Rest to choose Watchlist, Favorites, or Recommendations");
        await tab.focus();
        await tv.remote(40);
        assert.equal(await tv.focused(), "watchlist");
        const panel = tv.page.locator(".skyline-selector:not(.skyline-flyout)");
        assert.equal(await panel.getAttribute("aria-label"), "For You menu");
        assert.equal(await panel.locator(".skyline-menu-header").getAttribute("aria-hidden"), "true");
        const box = await panel.evaluate(node => node.getBoundingClientRect().width);
        const tabBox = await tab.evaluate(node => { const rect = node.getBoundingClientRect(); return rect.left + rect.width / 2; });
        const left = await panel.evaluate(node => node.getBoundingClientRect().left);
        assert.equal(box, 460);
        assert.ok(Math.abs(left + 230 - Math.max(88 + 230, Math.min(1832 - 230, tabBox))) < 0.5, `panel centred under the tab (${left} vs ${tabBox})`);
        for (const key of ["watchlist", "favorites", "recommendations"]) {
            assert.equal(await panel.locator(`[data-focus="${key}"] svg`).getAttribute("fill"), "currentColor", `${key} icon is filled`);
        }
        const scale = 0.9685;
        const label = await panel.locator('[data-focus="watchlist"] .skyline-menu-label').evaluate(node => parseFloat(getComputedStyle(node).fontSize));
        const header = await panel.locator(".skyline-menu-header").evaluate(node => ({ size: parseFloat(getComputedStyle(node).fontSize), tracking: parseFloat(getComputedStyle(node).letterSpacing) }));
        assert.ok(Math.abs(label - 22 * scale) < 0.01, `row label ${label}`);
        assert.ok(Math.abs(header.size - 14 * scale) < 0.01, `header ${header.size}`);
        assert.ok(Math.abs(header.tracking - 14 * scale * 0.26) < 0.01, `header tracking ${header.tracking}`);
    } finally { await tv.page.context().close(); }
});

test("the profile menu is 460 wide at the right safe area", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await start(tv);
        await tv.page.locator('[data-focus="profiles"]').focus();
        await tv.remote(40);
        const rect = await tv.page.locator(".skyline-selector:not(.skyline-flyout)").evaluate(node => { const box = node.getBoundingClientRect(); return [box.width, box.right]; });
        assert.deepEqual(rect, [460, 1832]);
    } finally { await tv.page.context().close(); }
});

test("a held Select dims a For You row to 0.75 over 0.12 s until release", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        await tv.page.locator('[data-focus="for_you"]').focus();
        await tv.remote(40);
        assert.equal(await tv.focused(), "watchlist");
        const row = tv.page.locator('.skyline-selector [data-focus="watchlist"]');
        assert.equal(await row.evaluate(node => getComputedStyle(node).transition.includes("opacity 0.12s ease-out")), true);
        // A synthetic Enter reaches the press owner without the browser's default click.
        await tv.page.evaluate(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
        assert.equal(await row.getAttribute("data-pressed"), "");
        await tv.page.evaluate(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true })));
        assert.equal(await row.getAttribute("data-pressed"), null);
        await row.evaluate(node => node.setAttribute("data-pressed", ""));
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        assert.equal(await row.evaluate(node => getComputedStyle(node).opacity), "0.75");
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

test("For You loading is a clear page labelled Loading recommendations, and empty is Apple's centred empty state; neither has a heading or button", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const held = tv.fake.hold("/recommendations/discover", true);
    try {
        const catalog = new RecommendationsCatalog();
        catalog.recommendationReply = { status: 200, body: { items: [] } };
        await start(tv, null, catalog);
        await tv.page.locator('[data-focus="for_you"]').click();
        await tv.page.locator('[data-view="for_you"] [aria-label="Loading recommendations"]').waitFor();
        assert.equal(await tv.focused(), "loading");
        assert.equal(await tv.page.locator(".browse > .skyline-marquee").count(), 0);
        assert.equal(await tv.page.locator(".browse > .skyline-content").innerText(), "", "no visible text while loading");
        assert.equal(await tv.page.locator(".browse > .skyline-content button").count(), 0);
        await tv.remote(38);
        assert.equal(await tv.focused(), "for_you", "Up from the loading page reaches the bar");
        held.release();
        const empty = tv.page.locator('[data-view="for_you"] .for-you-empty');
        await empty.waitFor();
        assert.equal(await tv.page.locator(".browse > .skyline-marquee").count(), 0);
        assert.equal(await tv.page.locator(".browse > .skyline-content button").count(), 0);
        assert.equal(await empty.locator(".search-state-title").innerText(), "No recommendations yet");
        assert.equal(await empty.locator(".search-state-description").innerText(), "Watch or rate a few titles to build your personalised recommendations.");
        assert.equal(await empty.getAttribute("aria-label"), "No recommendations yet");
        // One browser call: the focused tab's dwell can repaint the page between a locator's resolve and its evaluate.
        const shape = await tv.page.evaluate(() => {
            const node = document.querySelector('[data-view="for_you"] .for-you-empty');
            if (node === null) throw new Error("Missing empty state");
            const icon = node.querySelector(".search-state-icon");
            const title = node.querySelector(".search-state-title");
            const body = node.querySelector(".search-state-description");
            if (icon === null || title === null || body === null) throw new Error("Missing empty state parts");
            const box = node.getBoundingClientRect();
            const iconBox = icon.getBoundingClientRect();
            return {
                centre: [box.left + box.width / 2, box.top + box.height / 2],
                icon: [iconBox.width, getComputedStyle(icon).opacity === "1" ? getComputedStyle(icon).color : getComputedStyle(icon).opacity],
                titleSize: parseFloat(getComputedStyle(title).fontSize),
                titleWeight: getComputedStyle(title).fontWeight,
                body: parseFloat(getComputedStyle(body).fontSize),
                gap: title.getBoundingClientRect().top - iconBox.bottom,
            };
        });
        assert.deepEqual(shape.centre, [960, 510], "centred in the page above tvOS's 60 pt bottom safe area");
        assert.deepEqual(shape.icon, [44, "rgba(237, 237, 237, 0.3)"]);
        assert.ok(Math.abs(shape.titleSize - 28 * 0.9685) < 0.01, `title ${shape.titleSize}`);
        assert.equal(shape.titleWeight, "600");
        assert.ok(Math.abs(shape.body - 22 * 0.9685) < 0.01, `body ${shape.body}`);
        assert.equal(shape.gap, 12);
        await tv.page.locator('[data-focus="for_you"]').focus();
        await tv.remote(40); await tv.remote(40); await tv.remote(40); await tv.remote(40);
        assert.equal(await tv.focused(), "for-you-empty", "Down from the last action reaches the passive owner");
        await tv.remote(10009);
        assert.equal(await tv.focused(), "for_you", "Back first returns to the current root");
        await tv.remote(10009);
        await tv.page.locator('[data-view="home"]').waitFor();
    } finally { held.release(); await tv.page.context().close(); }
});

test("returning to an empty or failed For You shows the loading page until the new read answers", async () => {
    for (const reply of [{ status: 200, body: { items: [] } }, problem(500, "Broken")] satisfies Reply[]) {
        const tv = await openTv(browser, { app: "browse" });
        try {
            const catalog = new RecommendationsCatalog();
            catalog.recommendationReply = reply;
            await start(tv, null, catalog);
            await tv.page.locator('[data-focus="for_you"]').click();
            await tv.page.locator(reply.status === 200 ? ".for-you-empty" : '[data-view="for_you"] .details-failure').waitFor();
            await tv.page.locator('[data-focus="home"]').click();
            await tv.page.locator('[data-view="home"] .browse-card').first().waitFor();
            const held = tv.fake.hold("/recommendations/discover", true);
            try {
                await tv.page.locator('[data-focus="for_you"]').click();
                await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/recommendations/discover")).length === 2, "second read");
                assert.equal(await tv.page.locator('[data-view="for_you"] [aria-label="Loading recommendations"]').count(), 1, `status ${reply.status}: RecommendationsViewModel loads again with no sections`);
                assert.equal(await tv.page.locator(".for-you-empty, .details-failure").count(), 0);
                assert.equal(await tv.focused(), "loading");
            } finally { held.release(); }
            await tv.page.locator(reply.status === 200 ? ".for-you-empty" : '[data-view="for_you"] .details-failure').waitFor();
        } finally { await tv.page.context().close(); }
    }
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

/** Ink of each SF Symbol at Apple's 20 pt semibold, measured with AppKit (TVTopMenuBar.swift:1034-1037, :1183-1200; Sign Out :1214 at 5780c84). */
const APPLE_MENU_INK: Readonly<Record<string, readonly [number, number]>> = {
    "switch-profile": [26.8, 17.8], history: [20.4, 20.4], requests: [20.9, 20.9], settings: [21, 21],
    watchlist: [14, 21.8], favorites: [20, 18.5], recommendations: [18.5, 22.6], signout: [24.3, 21.1],
};

test("profile and For You menus draw Apple's filled glyphs at Apple's ink size in the same icon box", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv, null, new ProfileDestinationsCatalog(), true);
        const icons = (kind: string) => tv.page.locator(`.skyline-selector[data-menu-kind="${kind}"] [data-focus]`).evaluateAll(rows => rows.map(row => {
            // The panel's 0.96 open scale would shrink the measured box.
            for (const animation of document.getAnimations()) animation.finish();
            const svg = row.querySelector("svg") as SVGSVGElement;
            const box = svg.getBoundingClientRect();
            const ink = svg.getBBox();
            const scale = box.height / 24;
            return { key: row.getAttribute("data-focus"), filled: svg.classList.contains("skyline-menu-icon-filled"), box: [box.width, box.height], ink: [Math.round(ink.width * scale * 10) / 10, Math.round(ink.height * scale * 10) / 10] };
        }));
        await tv.page.locator('[data-focus="profiles"]').focus();
        await tv.jump(250);
        const profile = await icons("profile");
        await tv.page.locator('[data-focus="for_you"]').focus();
        await tv.jump(250);
        const forYou = await icons("for_you");
        assert.deepEqual(forYou.map(icon => icon.key), ["watchlist", "favorites", "recommendations"]);
        assert.ok(profile.some(icon => icon.key === "requests") && profile.some(icon => icon.key === "signout"), JSON.stringify(profile.map(icon => icon.key)));
        for (const icon of [...profile, ...forYou]) {
            assert.deepEqual(icon.box, [30, 20], `${icon.key}: the icon keeps its 30 by 20 box`);
            const apple = APPLE_MENU_INK[icon.key ?? ""];
            // Change Account mixes a filled badge with an outlined ring.
            if (apple === undefined) { assert.equal(icon.filled, icon.key === "switch-server", `${icon.key}: Apple draws it outlined`); continue; }
            assert.equal(icon.filled, true, `${icon.key}: drawn as Apple's measured glyph`);
            assert.ok(Math.abs((icon.ink[0] ?? 0) - apple[0]) <= 1.5 && Math.abs((icon.ink[1] ?? 0) - apple[1]) <= 1.5, `${icon.key}: ink ${icon.ink.join("×")} against Apple's ${apple.join("×")}`);
        }
    } finally { await tv.page.context().close(); }
});

for (const anchor of ["movies", "profiles"]) test(`a ${anchor} menu the dwell opened closes when focus is handed to the page`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        await tv.page.locator(`[data-focus="${anchor}"]`).focus();
        await tv.jump(250);
        assert.equal(await tv.page.locator(`[data-focus="${anchor}"]`).getAttribute("aria-expanded"), "true", "the dwell opens the menu without entering it");
        // A late load hands focus to the page the way FocusHost.focusDefault does.
        await tv.page.locator('[data-section="continue_watching"] .browse-card').first().evaluate(card => (card as HTMLElement).focus());
        // enterContentFromBar: closePanelForContentHandoff (TVMainTabView.swift:955-958).
        await tv.eventually(async () => !(await tv.page.locator(".skyline-selector:not(.skyline-flyout)").isVisible()), "the menu closes");
        assert.equal(await tv.page.locator(`[data-focus="${anchor}"]`).getAttribute("aria-expanded"), "false");
        assert.equal(await tv.page.evaluate(() => document.activeElement?.closest("[data-section]")?.getAttribute("data-section")), "continue_watching", "focus stays on the card");
        await tv.jump(500);
        assert.equal(await tv.page.locator(".skyline-selector:not(.skyline-flyout)").isVisible(), false, "the menu does not reopen");
    } finally { await tv.page.context().close(); }
});
