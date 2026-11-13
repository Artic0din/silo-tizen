// Recommended and Collections on a library tab, against silo-apple 48a197d (tvOS) TVLibraryBrowseView and
// TVLibraryCollectionsView. Desktop Chromium proves behaviour and layout, not TV rendering.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { HIDDEN_KEY } from "../../src/contracts/v2/settings.ts";
import { homeDetailsRead, launchBrowser, openTv, type Tv } from "./support/tv.ts";
import { selectLibraryMode } from "./support/library.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const CAP = 0.9685;
const capped = (points: number): string => `${Math.round(points * CAP * 10000) / 10000}px`;
const cardIds = (tv: Tv, section: string) => tv.page.locator(`[data-section="${section}"] .browse-card`).evaluateAll(cards => cards.map(card => card.getAttribute("data-focus")).filter(id => id?.startsWith("expand:") === false));

async function start(tv: Tv, catalog: FakeCatalog, homeReady = true): Promise<void> {
    tv.fake.catalog = catalog;
    new FakeSettings(tv.fake).profile().set(HIDDEN_KEY, catalog.households.get("p-owner")?.hidden ?? null);
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "signed in");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(() => window.browseHarness.mount(false));
    if (!homeReady) return;
    await tv.page.locator('.browse[data-view="home"] .browse-card').first().waitFor();
    await homeDetailsRead(tv);
}

function page(name: string, body: (tv: Tv, catalog: FakeCatalog) => Promise<void>, prepare: (catalog: FakeCatalog) => void = () => undefined): void {
    test(name, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            const catalog = new FakeCatalog();
            prepare(catalog);
            await start(tv, catalog);
            await body(tv, catalog);
            assert.deepEqual(tv.console, [], "the page logs nothing");
        } finally { await tv.page.context().close(); }
    });
}

function mixed(catalog: FakeCatalog): void {
    const household = catalog.households.get("p-owner");
    const library = household?.libraries.find(item => item.id === "12");
    assert.ok(household && library);
    library.type = "mixed";
    household.librarySections = [
        { id: "mixed-row", sectionType: "recently_added", title: "Mixed Picks", items: ["movie:m0004", "series:s1", "movie:m0005", "series:s2"] },
    ];
}

const sectionQueries = (tv: Tv) => tv.fake.requests.filter(request => request.path.startsWith("/catalog/query") && request.body?.source === "section");

page("a mixed library's Movies tab shows only movies on Recommended, refilled from each row's section", async tv => {
    await tv.page.locator('[data-focus="movies"]').click();
    await tv.page.locator('[data-section="mixed-row"] .browse-card').first().waitFor();
    const ids = await cardIds(tv, "mixed-row");
    assert.equal(ids.filter(id => id?.startsWith("series:")).length, 0, "no series on the Movies tab");
    assert.deepEqual(ids.slice(0, 2), ["movie:m0001", "movie:m0002"], "the section source's order");
    assert.equal(ids.length, 20, "the shelf is refilled to its 20-title default");
    const [query] = sectionQueries(tv);
    assert.deepEqual(query?.body, { source: "section", scope: "library", section_id: "mixed-row", library_id: "12", limit: 100 });
    const sections = tv.fake.requests.find(request => request.path.startsWith("/library/12/sections"));
    assert.equal(new URL(query?.path ?? "", "https://x").search, new URL(sections?.path ?? "", "https://x").search, "refilled cards use Recommended's artwork sizes");
    assert.equal(await tv.page.locator(".library-incomplete").count(), 0);
}, mixed);

test("a mixed library opened before Home's rows arrive is still narrowed to the tab's type", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const held = tv.fake.hold("/home/sections", true);
    try {
        const catalog = new FakeCatalog();
        mixed(catalog);
        await start(tv, catalog, false);
        await tv.page.locator('.skyline-roots [data-focus="movies"]').click();
        await tv.page.locator('[data-section="mixed-row"] .browse-card').first().waitFor();
        assert.equal((await cardIds(tv, "mixed-row")).filter(id => id?.startsWith("series:")).length, 0);
        assert.equal(sectionQueries(tv).length > 0, true);
    } finally { held.release(); await tv.page.context().close(); }
});

page("a failed refill keeps the row's own titles and says some shelves could not be fully loaded", async tv => {
    await tv.page.route("**/api/v2/catalog/query**", route => route.fulfill({ status: 500, json: { type: "about:blank", title: "Server error", status: 500 } }));
    await tv.page.locator('[data-focus="movies"]').click();
    await tv.page.locator('[data-section="mixed-row"] .browse-card').first().waitFor();
    assert.deepEqual(await cardIds(tv, "mixed-row"), ["movie:m0004", "movie:m0005"]);
    const banner = tv.page.locator(".library-incomplete");
    assert.equal(await banner.innerText(), "Some shelves could not be fully loaded. Open Browse to see this media type.");
    const box = await banner.boundingBox();
    assert.ok(box !== null);
    assert.equal(Math.round(box.x + box.width / 2), 960, "centred at the bottom");
    assert.equal(Math.round(box.y + box.height), 1080);
    assert.equal(await banner.evaluate(node => getComputedStyle(node).fontSize), capped(25));
}, mixed);

page("a mixed library with nothing of the tab's type says so on Recommended", async tv => {
    await tv.page.route("**/api/v2/catalog/query**", route => route.fulfill({ json: { window_cursor: "w", items: [], total: 0, total_exact: true, page: { has_more: false } } }));
    await tv.page.locator('[data-focus="movies"]').click();
    await tv.page.locator(".library-empty").waitFor();
    assert.equal(await tv.page.locator(".library-empty-title").innerText(), "No titles for this tab");
    assert.equal(await tv.page.locator(".library-empty-body").innerText(), "Open Browse to see titles matching this tab.");
}, catalog => {
    mixed(catalog);
    const household = catalog.households.get("p-owner");
    assert.ok(household);
    household.librarySections = [{ id: "series-only", title: "Series Only", items: ["series:s1", "series:s2"] }];
});

page("Recommended loads behind Apple's page outline, which holds focus until the rows arrive", async tv => {
    await tv.page.locator('[data-focus="movies"]').click();
    await tv.page.locator('[data-view="library:12"] .home-section').first().waitFor();
    await selectLibraryMode(tv, "Collections");
    await tv.page.locator('[data-focus="collection:highlights"]').waitFor();
    const held = tv.fake.hold("/library/12/sections", true);
    try {
        await selectLibraryMode(tv, "Recommended");
        const loading = tv.page.locator(".library-loading");
        await loading.waitFor();
        assert.equal(await tv.page.locator(".discovery-skeleton").count(), 0, "no shimmering tile");
        assert.equal(await tv.page.locator(".library-loading-label").innerText(), "Loading Movies");
        const geometry = await loading.evaluate(node => {
            const size = (element: Element | null) => { const box = element?.getBoundingClientRect(); return box === undefined ? undefined : [box.width, box.height]; };
            return {
                title: size(node.querySelector(".requests-loading-marquee > .requests-loading-bar")),
                cards: [...node.querySelectorAll(".library-loading-card > .requests-loading-bar:first-child")].map(size),
                label: getComputedStyle(node.querySelector(".library-loading-label")!).fontSize,
            };
        });
        assert.deepEqual(geometry, { title: [520, 72], cards: Array(5).fill([330, 186]), label: "20px" });
        assert.equal(await tv.focused(), "library-page", "the outline takes page focus");
        await tv.remote(38);
        assert.equal(await tv.focused(), "movies", "Up reaches the bar");
    } finally { held.release(); }
});

page("an empty library's Recommended page uses Apple's empty state and holds focus", async (tv, catalog) => {
    catalog.failNext("/library/12/sections", { status: 200, body: { sections: [] } });
    await tv.page.locator('[data-focus="movies"]').click();
    const empty = tv.page.locator(".library-empty");
    await empty.waitFor();
    assert.equal(await tv.page.locator(".library-empty-title").innerText(), "Movies is empty");
    assert.equal(await tv.page.locator(".library-empty-body").innerText(), "Add media to this library on the server to see it here.");
    assert.equal(await tv.page.locator(".library-empty-icon").count(), 1);
    assert.equal(await tv.page.getByText("No titles", { exact: true }).count(), 0);
    const box = await empty.boundingBox();
    assert.ok(box !== null);
    assert.equal(Math.round(box.x + box.width / 2), 960);
    assert.deepEqual(await tv.page.locator(".library-empty-title").evaluate(node => [getComputedStyle(node).fontSize, getComputedStyle(node).fontWeight]), [capped(28), "600"]);
    assert.equal(await tv.page.locator(".library-empty-icon").evaluate(node => getComputedStyle(node).color), "rgba(237, 237, 237, 0.3)");
    await tv.eventually(async () => await tv.focused() === "library-page", "the empty page holds focus");
});

page("a failed Recommended read shows Apple's error page with Try Again", async (tv, catalog) => {
    catalog.failNext("/library/12/sections", { status: 500, body: { type: "about:blank", title: "Server error", status: 500 } });
    await tv.page.locator('[data-focus="movies"]').click();
    const failure = tv.page.locator(".details-failure");
    await failure.waitFor();
    assert.equal(await failure.locator(".search-state-title").innerText(), "Something went wrong");
    assert.equal(await failure.locator("svg").count(), 1);
    assert.deepEqual(await failure.locator(".browse-button").allInnerTexts(), ["Try Again"]);
    assert.equal(await tv.page.getByText("Try again", { exact: true }).count(), 0);
});

page("Collections shows Apple's empty state when there are none and when the read fails", async (tv, catalog) => {
    await tv.page.locator('[data-focus="movies"]').click();
    await tv.page.locator('[data-view="library:12"] .home-section').first().waitFor();
    catalog.failNext("/library/12/collections", { status: 200, body: { library_id: "12", collections: [], groups: [], ungrouped: { sort_order: 1, collections: [] } } });
    await selectLibraryMode(tv, "Collections");
    const empty = tv.page.locator(".library-empty");
    await empty.waitFor();
    assert.equal(await tv.page.locator(".library-empty-title").innerText(), "No collections yet");
    assert.equal(await tv.page.locator(".library-empty-body").innerText(), "Collections created on the server will appear here.");
    await tv.eventually(async () => ((await tv.page.locator(".library-collections-state").boundingBox())?.height ?? 0) >= 400, "an area at least 400 tall");
    await tv.eventually(async () => await tv.focused() === "library-page", "the empty page holds focus");
    await selectLibraryMode(tv, "Recommended");
    await tv.page.locator('[data-view="library:12"] .home-section').first().waitFor();
    catalog.failNext("/library/12/collections", { status: 500, body: { type: "about:blank", title: "Server error", status: 500 } });
    await selectLibraryMode(tv, "Collections");
    await empty.waitFor();
    assert.equal(await tv.page.locator(".library-empty-title").innerText(), "No collections yet");
    assert.equal(await tv.page.getByText(/try again/i).count(), 0);
});

page("Collections loads behind a clear focusable area", async tv => {
    await tv.page.locator('[data-focus="movies"]').click();
    await tv.page.locator('[data-view="library:12"] .home-section').first().waitFor();
    const held = tv.fake.hold("/library/12/collections", true);
    try {
        await selectLibraryMode(tv, "Collections");
        const area = tv.page.locator('.library-collections-state[aria-label="Loading collections"]');
        await area.waitFor();
        assert.equal(await tv.page.locator(".discovery-skeleton, .library-empty").count(), 0);
        await tv.eventually(async () => ((await area.boundingBox())?.height ?? 0) >= 400, "an area at least 400 tall");
        await tv.eventually(async () => await tv.focused() === "library-page", "the loading area holds focus");
    } finally { held.release(); }
});

page("collection group headers and cards match Apple's grid", async tv => {
    await tv.page.emulateMedia({ reducedMotion: "reduce" });
    await tv.page.locator('[data-focus="movies"]').click();
    await tv.page.locator('[data-view="library:12"] .home-section').first().waitFor();
    await selectLibraryMode(tv, "Collections");
    const card = tv.page.locator('[data-focus="collection:highlights"]');
    await card.waitFor();
    const header = await tv.page.locator(".collection-group-title").evaluate(node => {
        const style = getComputedStyle(node);
        const art = node.parentElement?.querySelector(".browse-art")?.getBoundingClientRect();
        return { weight: style.fontWeight, wrap: style.whiteSpace, overflow: style.textOverflow, size: style.fontSize, gap: art === undefined ? undefined : Math.round(art.top - node.getBoundingClientRect().bottom) };
    });
    // Monospaced text keeps Apple's points, as the details popover header does.
    assert.deepEqual(header, { weight: "400", wrap: "nowrap", overflow: "ellipsis", size: "22px", gap: 20 });
    await card.focus();
    const ring = await card.locator(".browse-art").evaluate(node => ({ offset: getComputedStyle(node).outlineOffset, width: getComputedStyle(node).outlineWidth, shadow: getComputedStyle(node).boxShadow }));
    assert.deepEqual(ring, { offset: "-2px", width: "4px", shadow: "rgba(0, 0, 0, 0.45) 0px 8px 36px 0px" });
    const glyph = await card.locator(".collection-stack").evaluate(node => ({ symbol: node.getAttribute("data-symbol"), color: getComputedStyle(node).color, fill: node.querySelector("svg")?.getAttribute("fill") }));
    assert.deepEqual(glyph, { symbol: "square.stack.fill", color: "rgba(255, 255, 255, 0.85)", fill: "currentColor" });
});
