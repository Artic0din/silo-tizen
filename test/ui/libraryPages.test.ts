// Recommended and Collections on a library tab, against silo-apple 48a197d (tvOS) TVLibraryBrowseView and
// TVLibraryCollectionsView. Desktop Chromium proves behaviour and layout, not TV rendering.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { problem } from "../native/support/fakeSilo.ts";
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
            // The page fades in, so read its sizes to the pixel.
            const size = (element: Element | null) => { const box = element?.getBoundingClientRect(); return box === undefined ? undefined : [Math.round(box.width), Math.round(box.height)]; };
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

// Browse, against TVLibraryGridView and TVLibraryGridViewModel.
async function openBrowse(tv: Tv): Promise<void> {
    await tv.page.locator('[data-focus="movies"]').click();
    await tv.page.locator('[data-view="library:12"] .home-section').first().waitFor();
    await selectLibraryMode(tv, "Browse");
}
async function chooseLetter(tv: Tv, letter: string): Promise<void> {
    await tv.page.locator(`[data-focus="letter:${letter}"]`).focus();
    await tv.page.keyboard.press("Enter");
}
const emptyPage = { window_cursor: "w", items: [], total: 0, total_exact: true, page: { has_more: false } };

page("Browse's first load shows twelve static poster placeholders", async tv => {
    const held = tv.fake.hold("/catalog/query", true);
    try {
        await openBrowse(tv);
        const cards = tv.page.locator(".browse .catalog-skeleton .poster-skeleton");
        await cards.first().waitFor();
        assert.equal(await cards.count(), 12);
        assert.equal(await tv.page.locator(".discovery-skeleton").count(), 0);
        const style = await cards.first().evaluate(node => ({ background: getComputedStyle(node).backgroundColor, radius: getComputedStyle(node).borderRadius, animations: node.getAnimations().length, ratio: node.getBoundingClientRect().height / node.getBoundingClientRect().width }));
        assert.deepEqual({ ...style, ratio: Math.round(style.ratio * 100) / 100 }, { background: "rgba(255, 255, 255, 0.09)", radius: "12px", animations: 0, ratio: 1.5 });
    } finally { held.release(); }
});

page("Browse's placeholders sit in the loaded grid's columns", async tv => {
    // TVLibraryGridView.swift:188-203: the skeleton grid shares the loaded grid's column count, spacing and padding.
    const geometry = (selector: string) => tv.page.evaluate(tiles => {
        const nodes = [...document.querySelectorAll(tiles)].slice(0, 7).map(node => node.getBoundingClientRect());
        const grid = document.querySelector(tiles)?.closest(".catalog-grid")?.getBoundingClientRect();
        return { lefts: nodes.map(box => Math.round(box.left * 100) / 100), widths: nodes.map(box => box.width), grid: grid === undefined ? undefined : [grid.left, grid.right] };
    }, selector);
    const held = tv.fake.hold("/catalog/query", true);
    let skeleton;
    try {
        await openBrowse(tv);
        await tv.page.locator(".catalog-skeleton .poster-skeleton").first().waitFor();
        skeleton = await geometry(".catalog-skeleton .poster-skeleton");
    } finally { held.release(); }
    await tv.page.locator(".catalog-grid .browse-card").first().waitFor();
    const loaded = await geometry(".catalog-grid .browse-card .browse-art");
    // Apple TV at 5780c84 with the rail closed: columns from x55 on a 300 pitch, the last ending at x1815.
    assert.deepEqual(loaded, { lefts: [55, 355, 655, 955, 1255, 1555, 55], widths: [260, 260, 260, 260, 260, 260, 260], grid: [55, 1815] });
    assert.deepEqual(skeleton, loaded);
});

page("Browse's loading-more indicator spins under the grid", async tv => {
    await openBrowse(tv);
    await tv.eventually(async () => await tv.page.locator(".catalog-grid .browse-card").count() === 100, "first page");
    const held = tv.fake.hold("/catalog/query", true);
    try {
        await tv.page.locator(".catalog-grid .browse-card").last().focus();
        const spinner = tv.page.locator(".section-catalog-loading");
        await spinner.waitFor();
        assert.ok(await spinner.evaluate(node => node.getAnimations({ subtree: true }).length > 0), "the indicator animates");
    } finally { held.release(); }
}, catalog => { for (let i = 61; i <= 160; i++) catalog.add({ id: `movie:x${i}`, type: "movie", title: `Extra ${i}`, libraryId: "12" }); });

page("a failed Browse append keeps the grid quietly and tries again when the end comes back", async tv => {
    await openBrowse(tv);
    await tv.eventually(async () => await tv.page.locator(".catalog-grid .browse-card").count() === 100, "first page");
    let appends = 0;
    await tv.page.route("**/api/v2/catalog/query?*", async route => {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        if (body.cursor !== undefined && appends++ === 0) await route.fulfill({ status: 422, contentType: "application/problem+json", json: problem(422, "validation_failed", "Could not read next page").body });
        else await route.fallback();
    });
    await tv.page.locator(".catalog-grid .browse-card").last().focus();
    await tv.eventually(async () => appends === 1 && await tv.page.locator(".section-catalog-loading").count() === 0, "the failed append");
    await tv.jump(500);
    assert.equal(appends, 1, "a re-armed grid does not read again while the end stays on screen");
    assert.equal(await tv.page.getByRole("alert").count(), 0);
    assert.equal(await tv.page.locator('[data-focus="retry"]').count(), 0);
    assert.equal(await tv.page.locator(".catalog-grid .browse-card").count(), 100);
    await tv.page.locator(".catalog-grid .browse-card").first().focus();
    // The observer must see the end leave the screen on a real frame before it can see it return.
    await tv.eventually(async () => { await tv.jump(100); const box = await tv.page.locator(".catalog-grid .browse-card").last().boundingBox(); return box === null || box.y > 1080; }, "the end leaves the screen");
    await tv.page.waitForTimeout(100);
    await tv.page.locator(".catalog-grid .browse-card").last().focus();
    await tv.jump(300);
    await tv.eventually(async () => await tv.page.locator(".catalog-grid .browse-card").count() > 100, "the next approach to the end reads again");
}, catalog => { for (let i = 61; i <= 160; i++) catalog.add({ id: `movie:x${i}`, type: "movie", title: `Extra ${i}`, libraryId: "12" }); });

page("an empty library's Browse grid uses Apple's empty state and leaves focus on the controls", async (tv, catalog) => {
    catalog.failNext("/catalog/query", { status: 200, body: emptyPage });
    await openBrowse(tv);
    const empty = tv.page.locator(".browse-empty-state .library-empty");
    await empty.waitFor();
    assert.equal(await empty.locator(".library-empty-title").innerText(), "This library is empty");
    assert.equal(await empty.locator(".library-empty-body").innerText(), "There is nothing in this library yet.");
    assert.equal(await empty.locator(".library-empty-icon").count(), 1);
    assert.deepEqual(await empty.locator(".library-empty-title").evaluate(node => [getComputedStyle(node).fontSize, getComputedStyle(node).fontWeight]), [capped(28), "600"]);
    assert.ok(((await tv.page.locator(".browse-empty-state").boundingBox())?.height ?? 0) >= 400);
    assert.equal(await tv.focused(), "sort");
});

page("no filter matches shows Apple's icon and a Clear filters pill that Left from the rail reaches", async (tv, catalog) => {
    await openBrowse(tv);
    await tv.page.locator(".catalog-grid .browse-card").first().waitFor();
    catalog.failNext("/catalog/query", { status: 200, body: emptyPage });
    await chooseLetter(tv, "Q");
    const empty = tv.page.locator(".browse-empty-state .library-empty");
    await empty.waitFor();
    assert.equal(await empty.locator(".library-empty-title").innerText(), "No titles match your filters");
    assert.equal(await empty.locator(".library-empty-icon").count(), 1);
    const clear = tv.page.locator('[data-focus="clear-filters"]');
    const pill = await clear.evaluate(node => ({ background: getComputedStyle(node).backgroundColor, border: `${getComputedStyle(node).borderTopWidth} ${getComputedStyle(node).borderTopColor}`, gap: Math.round(node.getBoundingClientRect().top - document.querySelector(".browse-empty-state .library-empty-title")!.getBoundingClientRect().bottom) }));
    assert.deepEqual(pill, { background: "rgba(255, 255, 255, 0.07)", border: "1px rgba(255, 255, 255, 0.09)", gap: 32 });
    await tv.page.locator('[data-focus="letter:Q"]').focus();
    await tv.remote(37);
    assert.equal(await tv.focused(), "clear-filters");
    await clear.focus();
    await tv.eventually(async () => await clear.evaluate(node => getComputedStyle(node).transform) === "matrix(1.04, 0, 0, 1.04, 0, 0)", "the pill grows on focus");
});

page("a failed library probe keeps the no-matches message", async (tv, catalog) => {
    await openBrowse(tv);
    await tv.page.locator(".catalog-grid .browse-card").first().waitFor();
    catalog.failNext("/catalog/query", { status: 200, body: emptyPage }, problem(422, "validation_failed", "Browse unavailable"));
    await chooseLetter(tv, "Q");
    await tv.page.locator(".browse-empty-state .library-empty-title").waitFor();
    assert.equal(await tv.page.locator(".browse-empty-state .library-empty-title").innerText(), "No titles match your filters");
    assert.equal(await tv.page.getByRole("alert").count(), 0);
});

page("a failed first Browse read shows Apple's error page under the controls", async (tv, catalog) => {
    catalog.failNext("/catalog/query", problem(422, "validation_failed", "Browse unavailable"));
    await openBrowse(tv);
    const failure = tv.page.locator(".details-failure");
    await failure.waitFor();
    assert.equal(await failure.locator(".search-state-title").innerText(), "Something went wrong");
    assert.deepEqual(await failure.locator(".browse-button").allInnerTexts(), ["Try Again"]);
    assert.equal(await tv.page.locator('.browse-controls [data-focus="sort"]').count(), 1);
    await tv.page.locator('[data-focus="sort"]').focus();
    await tv.remote(40);
    assert.equal(await tv.focused(), "retry");
});

page("an expanded section's loading-more indicator spins too", async tv => {
    await tv.page.locator('[data-focus="movies"]').click();
    await tv.page.locator('[data-focus="expand:library-picks"]').click();
    const cards = tv.page.locator(".section-catalog-grid .browse-card");
    await cards.first().waitFor();
    const held = tv.fake.hold("/catalog/query", true);
    try {
        await cards.last().focus();
        const spinner = tv.page.locator(".section-catalog-loading");
        await spinner.waitFor();
        assert.ok(await spinner.evaluate(node => node.querySelector("svg") !== null && node.getAnimations({ subtree: true }).length > 0), "the indicator draws and animates");
    } finally { held.release(); }
}, catalog => { for (let i = 61; i <= 160; i++) catalog.add({ id: `movie:x${i}`, type: "movie", title: `Extra ${i}`, libraryId: "12" }); });
// Sort, Filter and the letter rail, against TVBrowseFilterUI, TVAlphabetRail and TVSkylinePanelChrome.
const LONG_GENRE = "Psychological Science Fiction Mystery Thriller Anthology Miniseries Special";
const style = (tv: Tv, selector: string, ...properties: string[]) => tv.page.locator(selector).first().evaluate((node, names) => Object.fromEntries(names.map(name => [name, getComputedStyle(node).getPropertyValue(name)])), properties);
async function browseReady(tv: Tv): Promise<void> {
    await openBrowse(tv);
    await tv.page.locator(".catalog-grid .browse-card").first().waitFor();
}

page("Sort and Filter panels use the top-bar panel chrome and fade in and out", async tv => {
    await browseReady(tv);
    await tv.page.locator('[data-focus="sort"]').focus();
    await tv.page.keyboard.press("Enter");
    const panel = tv.page.locator(".browse .browse-sort-panel");
    await panel.waitFor();
    const chrome = await style(tv, ".browse .browse-sort-panel", "background-image", "box-shadow", "border-top-width", "border-radius");
    assert.deepEqual(chrome, {
        "background-image": "linear-gradient(rgba(35, 37, 44, 0.92), rgba(20, 21, 25, 0.95))",
        "box-shadow": "rgba(0, 0, 0, 0.35) 0px 4px 16px 0px, rgba(0, 0, 0, 0.55) 0px 24px 80px 0px",
        "border-top-width": "0px",
        "border-radius": "22px",
    });
    // Declared timing, not running animations: a slow run can finish a 180 ms fade before it is read.
    const fades = await tv.page.evaluate(() => [".browse .browse-panel-scrim", ".browse .browse-sort-panel"].map(selector => {
        const node = document.querySelector(selector);
        return node === null ? undefined : [getComputedStyle(node).animationDuration, getComputedStyle(node).animationTimingFunction];
    }));
    assert.deepEqual(fades, [["0.18s", "ease-out"], ["0.18s", "ease-out"]]);
    const focused = { "background-color": "rgb(237, 237, 237)", color: "rgb(0, 0, 0)" };
    // The row's fill eases in over 120 ms.
    await tv.eventually(async () => JSON.stringify(await style(tv, '[data-focus="sort:title"]', "background-color", "color")) === JSON.stringify(focused), "the focused Sort row is white");
    await tv.remote(10009);
    const leaving = await tv.page.evaluate(() => [...document.querySelectorAll(".browse-panel-leaving")].map(node => [node.classList.contains("browse-panel-scrim") || node.classList.contains("browse-sort-panel"), getComputedStyle(node).animationDuration, node.querySelector("[data-focus]") === null]));
    assert.deepEqual(leaving, [[true, "0.18s", true], [true, "0.18s", true]]);
    // The fading copy keeps the focused row's white fill and dark text rather than dropping them at once.
    const ghostRow = await style(tv, ".browse-panel-leaving .browse-panel-row", "background-color", "color");
    assert.deepEqual(ghostRow, focused);
    assert.equal(await tv.focused(), "sort");
});

page("Sort keeps Apple's text: monospaced eyebrow, capped rows and a quiet direction on the focused row", async tv => {
    await browseReady(tv);
    assert.deepEqual(await style(tv, '[data-focus="sort"]', "font-size", "transition-property", "transition-duration"), { "font-size": capped(24), "transition-property": "transform, background-color, color", "transition-duration": "0.12s, 0.12s, 0.12s" });
    await tv.page.locator('[data-focus="sort"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-focus="sort:title"]').waitFor();
    assert.equal(await tv.focused(), "sort:title");
    const eyebrow = await style(tv, ".browse-sort-panel .browse-panel-eyebrow", "font-family", "font-size");
    assert.match(eyebrow["font-family"] ?? "", /monospace/);
    assert.equal(eyebrow["font-size"], "18px");
    assert.deepEqual(await style(tv, '[data-focus="sort:title"]', "font-size", "transition-property"), { "font-size": capped(26), "transition-property": "background-color, color" });
    assert.equal((await style(tv, '[data-focus="sort:title"] .browse-panel-detail', "color"))["color"], "rgba(237, 237, 237, 0.6)");
    assert.deepEqual(await style(tv, '[data-focus="sort:title"] .browse-panel-detail + .browse-icon', "width", "opacity"), { width: "26px", opacity: "1" });
});

page("Filter text is Apple's: capped rows, monospaced headers and count, and long labels shrink before truncating", async tv => {
    await browseReady(tv);
    await tv.page.locator('[data-focus="filter"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-focus="facet:genre"]').waitFor();
    assert.equal((await style(tv, ".browse-filter-panel .browse-panel-title", "font-size"))["font-size"], capped(34));
    const section = await style(tv, ".browse-filter-panel .browse-panel-section", "font-family", "font-size");
    assert.match(section["font-family"] ?? "", /monospace/);
    assert.equal(section["font-size"], "15px");
    for (const [key, points] of [["facet:genre", 25], ["match:all", 23], ["preserve", 23], ["done", 25]] as const) assert.equal((await style(tv, `[data-focus="${key}"]`, "font-size"))["font-size"], capped(points), key);
    await tv.page.keyboard.press("Enter");
    const value = tv.page.locator(`[data-focus="value:${LONG_GENRE}"] .browse-panel-text`);
    await value.waitFor();
    const size = parseFloat(await value.evaluate(node => getComputedStyle(node).fontSize));
    assert.ok(size < 24 * CAP && size >= 24 * CAP * 0.85 - 0.01, `value label shrinks to at most 85%: ${size}`);
    await tv.page.locator(`[data-focus="value:${LONG_GENRE}"]`).focus();
    await tv.page.keyboard.press("Enter");
    await tv.remote(37);
    const summary = tv.page.locator('[data-focus="facet:genre"] .browse-panel-detail');
    await tv.eventually(async () => (await summary.innerText()) === LONG_GENRE, "the facet summary names the value");
    const summarySize = parseFloat(await summary.evaluate(node => getComputedStyle(node).fontSize));
    assert.ok(summarySize < 25 * CAP && summarySize >= 25 * CAP * 0.8 - 0.01, `facet summary shrinks to at most 80%: ${summarySize}`);
    await tv.page.locator('[data-focus="done"]').focus();
    await tv.page.keyboard.press("Enter");
    // Done re-renders the controls; read the badge once it has settled (a detached node has no computed style).
    let badge: Record<string, string> = {};
    await tv.eventually(async () => { badge = await style(tv, ".browse-control-count", "font-family", "font-size"); return /monospace/.test(badge["font-family"] ?? ""); }, "the monospaced filter count");
    assert.equal(badge["font-size"], "18px");
}, catalog => {
    const original = catalog.route.bind(catalog);
    catalog.route = (method, path, profile, body) => path.startsWith("/catalog/filters") ? { status: 200, body: { ...(original(method, path, profile, body)?.body as Record<string, unknown>), genres: [LONG_GENRE, "Drama"] } } : original(method, path, profile, body);
});

page("the open letter rail keeps unfocused letters dim, spaces its chips and scrolls to the focused letter", async tv => {
    await tv.page.emulateMedia({ reducedMotion: "reduce" });
    await browseReady(tv);
    await tv.page.locator('[data-focus="letter:A"]').focus();
    assert.equal((await style(tv, '[data-focus="letter:B"]', "color"))["color"], "rgba(237, 237, 237, 0.6)");
    const gap = await tv.page.evaluate(() => {
        const a = document.querySelector('[data-focus="letter:A"]')!.getBoundingClientRect(), b = document.querySelector('[data-focus="letter:B"]')!.getBoundingClientRect();
        return [a.height, b.top - a.bottom];
    });
    assert.deepEqual(gap, [38, 4]);
    await tv.page.locator('[data-focus="letter:Z"]').focus();
    await tv.eventually(async () => {
        const box = await tv.page.locator('[data-focus="letter:Z"]').boundingBox();
        return box !== null && box.y >= 0 && box.y + box.height <= 1020;
    }, "the rail scrolls to the focused letter");
});

page("rail letters animate focus, growth and a held Select's 0.96 press", async tv => {
    await browseReady(tv);
    assert.deepEqual(await style(tv, '[data-focus="letter:Z"]', "transition-property"), { "transition-property": "background-color, color, transform, width, height, font-size, line-height" });
    await tv.page.locator('[data-focus="letter:M"]').focus();
    await tv.page.keyboard.down("Enter");
    const letter = tv.page.locator('[data-focus="letter:M"]');
    await tv.eventually(async () => await letter.getAttribute("data-pressed") === "", "the letter is drawn pressed");
    await tv.page.keyboard.up("Enter");
    await tv.eventually(async () => await letter.getAttribute("data-pressed") === null, "release clears the press");
});


page("re-entering the rail at a late letter scrolls it into view once the chips have grown", async tv => {
    await browseReady(tv);
    await tv.page.locator('[data-focus="letter:Z"]').focus();
    await tv.page.waitForTimeout(400);
    await tv.remote(37);
    assert.notEqual(await tv.focused(), "letter:Z");
    // Leave the rail so it collapses, then come back from the grid's last column.
    await tv.page.locator(".catalog-grid .browse-card").nth(5).focus();
    await tv.page.waitForTimeout(400);
    await tv.remote(39);
    assert.equal(await tv.focused(), "letter:Z");
    await tv.page.waitForTimeout(400);
    const box = await tv.page.locator('[data-focus="letter:Z"]').boundingBox();
    assert.ok(box !== null && box.y >= 0 && box.y + box.height <= 1020, JSON.stringify(box));
});

page("a closing Filter panel fades from what was on screen", async tv => {
    await browseReady(tv);
    await tv.page.locator('[data-focus="filter"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-focus="facet:genre"]').waitFor();
    await tv.page.locator('[data-focus="done"]').focus();
    await tv.eventually(async () => await tv.page.locator(".browse .browse-panel-list").evaluate(node => node.scrollTop > 0), "the list scrolls to Done");
    const live = await tv.page.evaluate(() => ({ top: document.querySelector(".browse .browse-panel-list")!.scrollTop, facet: getComputedStyle(document.querySelector('.browse [data-focus="facet:genre"]')!).fontSize }));
    await tv.page.keyboard.press("Enter");
    const ghost = await tv.page.evaluate(() => {
        const list = document.querySelector(".browse-panel-layer .browse-panel-list");
        const facet = list?.querySelector(".browse-panel-row");
        return { top: list?.scrollTop, facet: facet === null || facet === undefined ? undefined : getComputedStyle(facet).fontSize };
    });
    assert.deepEqual(ghost, live);
});

page("editing an open Filter panel does not replay its entrance fade", async tv => {
    await browseReady(tv);
    await tv.page.locator('[data-focus="filter"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-focus="match:any"]').waitFor();
    await tv.page.locator('[data-focus="match:any"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-focus="match:any"][aria-checked="true"]').waitFor();
    const running = await tv.page.evaluate(() => [".browse .browse-panel-scrim", ".browse .browse-filter-panel"].map(selector => document.querySelector(selector)?.getAnimations().length));
    assert.deepEqual(running, [0, 0]);
});

// One screen pixel as [r, g, b], decoded in the page as topBar.test.ts does.
async function pixel(tv: Tv, x: number, y: number): Promise<number[]> {
    const png = await tv.page.screenshot({ clip: { x, y, width: 1, height: 1 }, animations: "disabled" });
    return tv.page.evaluate(async source => {
        const image = new Image(); image.src = source; await image.decode();
        const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
        const context = canvas.getContext("2d"); if (context === null) throw new Error("No canvas");
        context.drawImage(image, 0, 0);
        return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    }, `data:image/png;base64,${png.toString("base64")}`);
}
const painted = (rgb: number[]) => rgb.some(channel => channel > 24);

page("Browse sits in Apple's overflowing column and slides left as the letter rail opens", async tv => {
    // TVCatalogGrid.swift:102-143: each cell is at least its 260 card, so the 1760 grid and TVLibraryGridView's 80 + 80 padding
    // (:185, :230) make a 1920 column. The column, rail and 32 trailing overflow the screen in an HStack (:98-108) and centre:
    // 50 over with the 18 rail (content from x55), 128 over with the open 96 rail (content from x16, rail chips at the edge).
    await tv.page.emulateMedia({ reducedMotion: "reduce" });
    await browseReady(tv);
    const layout = () => tv.page.evaluate(() => {
        const box = (node: Element | null | undefined) => { const rect = node?.getBoundingClientRect(); return rect === undefined ? undefined : [Math.round(rect.left * 100) / 100, Math.round(rect.right * 100) / 100]; };
        const arts = [...document.querySelectorAll(".catalog-grid .browse-card .browse-art")];
        return { controls: box(document.querySelector(".browse-controls"))?.[0], first: box(arts[0]), sixth: box(arts[5]), rail: box(document.querySelector(".browse-letters")) };
    });
    assert.deepEqual(await layout(), { controls: 55, first: [55, 315], sixth: [1555, 1815], rail: [1895, 1913] });
    await tv.page.locator('[data-focus="letter:A"]').focus();
    await tv.page.waitForTimeout(300);
    assert.deepEqual(await layout(), { controls: 16, first: [16, 276], sixth: [1516, 1776], rail: [1856, 1952] });
    const chips = await tv.page.evaluate(() => Object.fromEntries(["All", "#", "A", "N", "X"].map(letter => {
        const rect = document.querySelector(`[data-focus="letter:${letter}"]`)!.getBoundingClientRect();
        return [letter, [rect.left, rect.right, rect.top + rect.height / 2]];
    })));
    // Apple TV at 5780c84: All, # and A centred at y19, 61 and 103 on a 42 pitch, against the screen edge; X shows below the 1020 frame.
    assert.deepEqual(chips, { All: [1885, 1923, 19], "#": [1885, 1923, 61], A: [1885, 1923, 103], N: [1885, 1923, 649], X: [1885, 1923, 1069] });
    await tv.page.locator(".catalog-grid .browse-card").nth(5).focus();
    await tv.page.waitForTimeout(300);
    assert.deepEqual(await layout(), { controls: 55, first: [55, 315], sixth: [1555, 1815], rail: [1895, 1913] });
});

page("the Browse column slides with the rail's easeOut(0.18)", async tv => {
    // TVAlphabetRail.swift:67-71: the rail's width animates, and the centred HStack moves the column with it.
    await browseReady(tv);
    const timing = await tv.page.evaluate(() => [".browse-controls", ".catalog-grid"].map(selector => {
        const style = getComputedStyle(document.querySelector(selector)!);
        return [style.transitionProperty, style.transitionDuration, style.transitionTimingFunction];
    }));
    assert.deepEqual(timing, [["translate", "0.18s", "ease-out"], ["translate", "0.18s", "ease-out"]]);
});

page("open rail letters draw in the packaged monospaced face", async tv => {
    // TVAlphabetRail.swift:98-106: SF Mono semibold. The TV has no monospaced system face, so a generic monospace draws proportional.
    await browseReady(tv);
    await tv.page.locator('[data-focus="letter:I"]').focus();
    const face = await tv.page.evaluate(async () => {
        await document.fonts.ready;
        const letter = document.querySelector('[data-focus="letter:I"]')!;
        return { family: getComputedStyle(letter).fontFamily.split(",")[0]?.trim(), loaded: [...document.fonts].some(font => font.family.replace(/"/g, "") === "Roboto Mono" && font.status === "loaded") };
    });
    assert.deepEqual(face, { family: '"Roboto Mono"', loaded: true });
});

page("Browse pills keep Apple's padding, symbol frames and spacing", async tv => {
    // TVBrowseFilterUI.swift:31-77, :588-590: 22 inside a 1pt inner stroke, SF Symbols at 24pt medium, 10 between parts, 16 between pills.
    await tv.page.route("**/api/v2/shuffles/capabilities", route => route.fulfill({ json: { allowed: true, state: "available", scope_kinds: ["library"] } }));
    await browseReady(tv);
    await tv.page.locator('[data-focus="shuffle"]').waitFor();
    await tv.page.locator(".catalog-grid .browse-card").first().focus();
    await tv.page.waitForTimeout(300); // Sort's 1.04 focus scale eases out over 120 ms.
    const pills = await tv.page.evaluate(() => [...document.querySelectorAll(".browse-controls .browse-button")].map(pill => {
        const box = pill.getBoundingClientRect();
        const parts = [...pill.children].map(part => part.getBoundingClientRect());
        const icon = parts[0]!;
        return {
            key: pill.getAttribute("data-focus"), left: box.left, right: box.right,
            lead: icon.left - box.left, trail: box.right - parts[parts.length - 1]!.right, symbol: [icon.width, icon.height],
            gaps: parts.slice(1).map((part, index) => part.left - parts[index]!.right),
            strokes: [...pill.querySelectorAll("svg path")].map(path => path.getAttribute("stroke-width")),
        };
    }));
    assert.deepEqual(pills.map(({ key, lead, trail, symbol, gaps, strokes }) => ({ key, lead, trail, symbol, gaps, strokes })), [
        { key: "sort", lead: 22, trail: 22, symbol: [35, 28], gaps: [10, 10], strokes: ["2.5"] },
        { key: "filter", lead: 22, trail: 22, symbol: [31, 19], gaps: [10], strokes: ["2.3"] },
        { key: "shuffle", lead: 22, trail: 22, symbol: [34, 27], gaps: [10], strokes: ["2.41", "2.08"] },
    ]);
    assert.deepEqual(pills.slice(1).map((pill, index) => pill.left - pills[index]!.right), [16, 16]);
    // Apple TV at 5780c84, unfocused: Sort 252, Filter 139 and Shuffle 165 by its edge pixels; the S95C draws 251, 138 and 164.
    // Inter stands in for SF Pro, so allow a pixel.
    for (const [index, width] of [251, 138, 164].entries()) assert.ok(Math.abs(pills[index]!.right - pills[index]!.left - width) < 1, `${pills[index]?.key}: ${pills[index]!.right - pills[index]!.left}`);
});

page("the Sort panel keeps Apple's stack: 4 between parts, 58-point rows and SF Mono tracking", async tv => {
    // TVBrowseFilterUI.swift:125-155: a 4pt VStack inside 14 padding, centred on y510; rows 13 + 32 + 13; the eyebrow 18pt mono, tracking 2.
    await browseReady(tv);
    await tv.page.locator('[data-focus="sort"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-focus="sort:title"]').waitFor();
    const layout = await tv.page.evaluate(() => {
        const panel = document.querySelector(".browse-sort-panel")!.getBoundingClientRect();
        const eyebrow = document.querySelector(".browse-sort-panel .browse-panel-eyebrow")!;
        const rows = [...document.querySelectorAll(".browse-sort-panel .browse-panel-row")].map(row => row.getBoundingClientRect());
        const text = document.createRange(); text.selectNodeContents(eyebrow);
        return {
            top: panel.top, height: panel.height, eyebrow: eyebrow.getBoundingClientRect().top - panel.top, first: rows[0]!.top - panel.top,
            rows: rows.map(row => row.height), pitch: rows.slice(1).map((row, index) => row.top - rows[index]!.top), bottom: panel.bottom - rows[rows.length - 1]!.bottom,
            family: getComputedStyle(eyebrow).fontFamily.split(",")[0]?.trim(), tracking: getComputedStyle(eyebrow).letterSpacing, width: Math.round(text.getBoundingClientRect().width * 10) / 10,
        };
    });
    assert.deepEqual(layout, {
        top: 264.5, height: 491, eyebrow: 14, first: 14 + 21 + 8 + 4,
        rows: [58, 58, 58, 58, 58, 58, 58], pitch: [62, 62, 62, 62, 62, 62], bottom: 14,
        // SF Mono's advance is 0.618 em and Roboto Mono's 0.6 em; 0.33px more tracking keeps Apple's 91.9 SORT BY.
        family: '"Roboto Mono"', tracking: "2.33px", width: 91.9,
    });
});

page("choosing a letter keeps the open rail's size and scroll while the grid reloads", async tv => {
    // TVAlphabetRail.swift:42-72: the rail is one view that stays expanded under focus; choosing a letter does not rebuild it.
    await browseReady(tv);
    const letter = tv.page.locator('[data-focus="letter:Z"]');
    await tv.page.locator('[data-focus="letter:Y"]').focus();
    await tv.page.waitForTimeout(400);
    await tv.remote(40);
    await tv.eventually(async () => { const box = await letter.boundingBox(); return box !== null && box.height === 38 && box.y + box.height <= 1020; }, "the rail scrolls to Z");
    await tv.page.waitForTimeout(300);
    // Layout boxes, not client rects: Select's 0.96 press scale is a transform and may still be easing back.
    const chip = () => tv.page.evaluate(() => {
        const node = document.querySelector<HTMLElement>('[data-focus="letter:Z"]')!;
        const rail = node.parentElement!;
        return { top: node.offsetTop - rail.scrollTop, height: node.offsetHeight, scroll: rail.scrollTop, focused: document.activeElement === node };
    });
    const before = await chip();
    assert.equal(before.height, 38);
    await tv.page.keyboard.press("Enter");
    await tv.page.waitForTimeout(50);
    assert.deepEqual(await chip(), before);
    await tv.eventually(async () => await letter.getAttribute("aria-pressed") === "true", "Z is chosen");
    assert.deepEqual(await chip(), before);
});

// TVCollectionPosterCard.swift:108-123 and TVMediaCard.swift:258-276 (5780c84): one tail-truncated line, centred under the card.
const LONG_TITLE = "Trending Movies This Week Around the World";
async function centredCaption(tv: Tv, card: string): Promise<{ text: string; offset: number; full: string | null }> {
    const title = tv.page.locator(`${card} .browse-card-title`);
    await tv.eventually(async () => await title.locator("[aria-hidden]").count() === 1, "the caption is fitted");
    return title.evaluate(node => {
        const shown = node.querySelector("[aria-hidden]")!, range = document.createRange();
        range.selectNodeContents(shown);
        const text = range.getBoundingClientRect(), art = node.parentElement!.querySelector(".browse-art")!.getBoundingClientRect();
        return { text: shown.textContent ?? "", offset: Math.round(Math.abs((text.left + text.right) / 2 - (art.left + art.right) / 2)), full: node.querySelector(".silo-sr-only")?.textContent ?? null };
    });
}

page("a long collection name is shortened, then centred under its card", async tv => {
    await tv.page.locator('[data-focus="movies"]').click();
    await tv.page.locator('[data-view="library:12"] .home-section').first().waitFor();
    await selectLibraryMode(tv, "Collections");
    const caption = await centredCaption(tv, '[data-focus="collection:highlights"]');
    assert.match(caption.text, /^Trending Movies .*…$/);
    assert.ok(caption.offset <= 1, `centred: ${caption.offset}px off`);
    assert.equal(caption.full, LONG_TITLE);
}, catalog => {
    const original = catalog.route.bind(catalog);
    catalog.route = (method, path, profile, body) => {
        const answer = original(method, path, profile, body);
        return path.startsWith("/library/12/collections") && answer !== undefined ? { ...answer, body: JSON.parse(JSON.stringify(answer.body).replaceAll("Library Highlights", LONG_TITLE)) as unknown } : answer;
    };
});

page("a long Browse title is shortened, then centred under its card", async tv => {
    await tv.page.locator('[data-focus="movies"]').click();
    await tv.page.locator('[data-view="library:12"] .home-section').first().waitFor();
    await selectLibraryMode(tv, "Browse");
    const caption = await centredCaption(tv, '[data-focus="movie:long"]');
    assert.match(caption.text, /^AAA Trending .*…$/);
    assert.ok(caption.offset <= 1, `centred: ${caption.offset}px off`);
    assert.equal(caption.full, `AAA ${LONG_TITLE}`);
}, catalog => { catalog.add({ id: "movie:long", type: "movie", title: `AAA ${LONG_TITLE}`, libraryId: "12" }); });

page("Recommended captions stay leading-aligned, as Apple's MediaCard draws them", async tv => {
    // MediaCard.swift:632-650 (5780c84): the tvOS caption is .leading, so Chromium's ellipsis already matches it.
    await tv.page.locator('[data-focus="movies"]').click();
    await tv.page.locator('[data-view="library:12"] .home-section .browse-card').first().waitFor();
    await tv.page.waitForTimeout(100);
    assert.equal(await tv.page.locator('[data-view="library:12"] .home-section .browse-card-title [aria-hidden]').count(), 0);
});
