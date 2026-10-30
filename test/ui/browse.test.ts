// The native browse screens, driven by remote keys in Chromium against the fake Silo household.
// Desktop Chromium is not the TV's Chromium 76: this proves behavior, not 2021 rendering.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

const BACK = 10009;
const IME_DONE = 65376;
const PAGE_SIZE = 24;

let browser: Browser;
before(async () => {
    browser = await launchBrowser();
});
after(async () => {
    await browser.close();
});

interface Start {
    readonly catalog?: FakeCatalog;
    readonly profile?: string;
    readonly pin?: string;
}

function browseTest(name: string, body: (tv: Tv, catalog: FakeCatalog) => Promise<void>, start: Start = {}): void {
    test(name, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            const catalog = start.catalog ?? new FakeCatalog();
            await signedInBrowse(tv, catalog, start.profile ?? "p-owner", start.pin);
            await body(tv, catalog);
            assert.deepEqual(tv.console, [], "the page logs nothing");
        } finally {
            await tv.page.context().close();
        }
    });
}

async function signedInBrowse(tv: Tv, catalog: FakeCatalog, profile: string, pin?: string): Promise<void> {
    tv.fake.catalog = catalog;
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "a device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(async () => (await tv.page.evaluate(() => window.browseHarness.loginPhase)) === "signed_in", "sign-in");
    assert.equal(await tv.page.evaluate(([id, code]) => window.browseHarness.selectProfile(id ?? "", code), [profile, pin]), pin === undefined ? "selected" : "verified");
    await tv.page.evaluate(() => window.browseHarness.mount());
    await showing(tv, "home");
}

function view(tv: Tv): Promise<string | null> {
    return tv.page.evaluate(() => document.querySelector(".browse")?.getAttribute("data-view") ?? null);
}

async function showing(tv: Tv, name: string): Promise<void> {
    await tv.eventually(async () => (await view(tv)) === name, `the ${name} view`);
}

async function shows(tv: Tv, text: string): Promise<void> {
    await tv.page.getByText(text).first().waitFor();
}

async function press(tv: Tv, ...keys: string[]): Promise<void> {
    for (const key of keys) {
        await tv.page.keyboard.press(key);
    }
}

function browseReads(tv: Tv, pathname?: string): { path: string; headers: Readonly<Record<string, string>> }[] {
    const browse = /^\/(user\/libraries|settings\/values|home\/|catalog)/;
    return tv.fake.requests.filter((request) => browse.test(request.path) && (pathname === undefined || request.path.split("?")[0] === pathname));
}

function cardIds(tv: Tv, selector = ".browse-card"): Promise<string[]> {
    return tv.page.evaluate((query) => Array.from(document.querySelectorAll(query)).map((node) => node.getAttribute("data-focus") ?? ""), selector);
}

browseTest("Home lists visible video libraries and supported rows, and every row is reachable by remote", async (tv) => {
    const nav = await cardIds(tv, ".browse-nav .browse-button");
    assert.deepEqual(nav, ["search", "library:12", "library:13", "profiles"], "no audiobooks, no library the profile hid");
    const rows = await tv.page.evaluate(() => Array.from(document.querySelectorAll("[data-section]")).map((node) => node.getAttribute("data-section")));
    assert.deepEqual(rows, ["continue_watching", "recently_added"], "a row of only books is left out");
    assert.equal((await cardIds(tv)).indexOf("ebook:atlas"), -1, "the book card in a mixed row is left out");
    assert.equal(await tv.focused(), "movie:m0001", "focus starts on the first card");

    await press(tv, "ArrowRight");
    assert.equal(await tv.focused(), "episode:s1e12");
    await press(tv, "ArrowDown", "ArrowRight", "ArrowRight");
    assert.equal(await tv.focused(), "movie:m0001", "Recently Added: series first, then movies");
    await press(tv, "ArrowUp");
    assert.equal(await tv.focused(), "episode:s1e12", "back to the card last focused in the row above");
    await press(tv, "ArrowUp", "ArrowRight");
    assert.equal(await tv.focused(), "library:12");
    await press(tv, "ArrowUp");
    assert.equal(await tv.focused(), "library:12", "nothing above the top zone");

    const reads = browseReads(tv);
    assert.ok(reads.length >= 3);
    assert.ok(reads.every((read) => read.headers["x-profile-id"] === "p-owner" && read.headers.authorization?.startsWith("Bearer ")));
    assert.ok(reads.every((read) => read.path.indexOf("include_hidden") === -1));

    const before = tv.fake.requests.length;
    await press(tv, "ArrowDown", "ArrowRight", "ArrowLeft", "ArrowDown", "ArrowRight", "ArrowRight", "ArrowUp", "ArrowUp");
    assert.equal(tv.fake.requests.length, before, "moving focus fetches nothing");

    await tv.remote(BACK);
    assert.equal(await tv.page.evaluate(() => window.browseHarness.lastKeyPrevented), false, "Back on Home reaches the app's root exit handler");
    assert.equal(await view(tv), "home");
});

browseTest(
    "a large library pages by cursor, keeps one page in the DOM and never fetches on focus moves",
    async (tv) => {
        await press(tv, "ArrowUp", "ArrowRight", "Enter");
        await showing(tv, "library:12");
        await tv.eventually(async () => (await cardIds(tv)).length === PAGE_SIZE, "the first page");
        assert.deepEqual((await cardIds(tv)).slice(0, 2), ["movie:m0001", "movie:m0002"]);
        await shows(tv, "Page 1 of 209");
        const first = browseReads(tv, "/catalog").pop();
        assert.match(first?.path ?? "", /library_id=12&type=movie&limit=24&image_size=small$/);

        const before = tv.fake.requests.length;
        await press(tv, "ArrowRight", "ArrowRight", "ArrowDown", "ArrowDown", "ArrowDown");
        assert.equal(await tv.focused(), "movie:m0021", "Down moves one grid row of six");
        await press(tv, "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight");
        assert.equal(await tv.focused(), "movie:m0024", "Right stops at the row's end");
        assert.equal(tv.fake.requests.length, before, "moving focus fetches nothing");

        await press(tv, "ArrowDown");
        assert.equal(await tv.focused(), "next", "below the grid: the pager");
        for (let page = 2; page <= 4; page++) {
            await press(tv, "Enter");
            await shows(tv, `Page ${page} of 209`);
            assert.equal(await tv.focused(), "next", "focus stays on Next while the page changes");
            assert.equal((await cardIds(tv)).length, PAGE_SIZE, "only the shown page is in the DOM");
        }
        assert.equal((await cardIds(tv))[0], "movie:m0073");
        assert.match(browseReads(tv, "/catalog").pop()?.path ?? "", /cursor=cursor-72/);
        await press(tv, "ArrowLeft", "Enter");
        await shows(tv, "Page 3 of 209");
        assert.equal((await cardIds(tv))[0], "movie:m0049");
        assert.equal(browseReads(tv, "/catalog").length, 5, "one request per page shown");
        assert.ok(browseReads(tv, "/catalog").every((read) => /limit=24/.test(read.path)), "never the whole catalog");

        await press(tv, "ArrowUp");
        assert.equal(await tv.focused(), "movie:m0049", "the card focused before is not on this page: Up enters the grid at its first card");
        await press(tv, "ArrowRight", "Enter");
        await showing(tv, "item:movie:m0050");
        await press(tv, "Enter");
        await tv.page.evaluate(() => window.browseHarness.resume());
        await tv.remote(BACK);
        await showing(tv, "library:12");
        await tv.eventually(async () => browseReads(tv, "/catalog").length === 6, "the refresh after playback");
        await shows(tv, "Page 3 of 209");
        assert.match(browseReads(tv, "/catalog").pop()?.path ?? "", /cursor=cursor-48/, "the refresh reloads the page shown, not the first");
        assert.equal(await tv.focused(), "movie:m0050", "focus returns to the card that was opened");
        await tv.remote(BACK);
        await showing(tv, "home");
        assert.equal(await tv.focused(), "library:12", "Back restores the library button");
    },
    { catalog: new FakeCatalog(5000) },
);

browseTest("details hand the player the file and resume point; returning restores focus and refreshes progress", async (tv, catalog) => {
    await press(tv, "Enter");
    await showing(tv, "item:movie:m0001");
    assert.equal(await tv.focused(), "resume");
    await shows(tv, "Resume from 20:00");
    await press(tv, "Enter");
    assert.deepEqual(await tv.page.evaluate(() => window.browseHarness.plays), [
        { contentId: "movie:m0001", fileId: "f-movie:m0001", title: "Movie 0001", startSeconds: 1200 },
    ]);
    assert.equal(await tv.page.evaluate(() => document.querySelector<HTMLElement>(".browse")?.hidden), true, "browse hides for the player");
    await tv.remote(BACK);
    await press(tv, "ArrowRight");
    assert.equal(await tv.page.evaluate(() => window.browseHarness.lastKeyPrevented), false, "browse ignores keys while the player plays");
    assert.equal(await view(tv), "item:movie:m0001");

    catalog.progress.set("movie:m0001", 1300);
    await tv.page.evaluate(() => window.browseHarness.resume());
    await shows(tv, "Resume from 21:40");
    assert.equal(await tv.focused(), "resume", "focus returns to the button that started playback");
    await press(tv, "ArrowRight", "Enter");
    const fromStart = (await tv.page.evaluate(() => window.browseHarness.plays))[1];
    assert.equal(fromStart?.fileId, "f-movie:m0001");
    assert.equal(fromStart?.startSeconds, undefined, "Play from start");
    await tv.page.evaluate(() => window.browseHarness.resume());

    await tv.remote(BACK);
    await showing(tv, "home");
    assert.equal(await tv.focused(), "movie:m0001", "Back restores the card in its row");
});

browseTest("series open seasons, seasons list episodes, and Back retraces each step by identity", async (tv) => {
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "item:series:s1");
    await shows(tv, "Harbor Lights");
    assert.equal(await tv.focused(), "next-episode");
    await press(tv, "ArrowDown", "ArrowRight");
    assert.equal(await tv.focused(), "season:2");
    await press(tv, "Enter");
    await showing(tv, "season:series:s1:2");
    await shows(tv, "Harbor Lights · Season 2");
    assert.equal(await tv.focused(), "episode:s1e21");
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "item:episode:s1e22");
    await shows(tv, "Harbor Lights · S2:E2");
    await press(tv, "Enter");
    assert.deepEqual((await tv.page.evaluate(() => window.browseHarness.plays))[0], {
        contentId: "episode:s1e22",
        fileId: "f-episode:s1e22",
        title: "Harbor Lights chapter 2.2",
        startSeconds: undefined,
    });
    await tv.page.evaluate(() => window.browseHarness.resume());
    await tv.remote(BACK);
    await showing(tv, "season:series:s1:2");
    assert.equal(await tv.focused(), "episode:s1e22");
    await tv.remote(BACK);
    await showing(tv, "item:series:s1");
    assert.equal(await tv.focused(), "season:2");
    await tv.remote(BACK);
    await showing(tv, "home");
    assert.equal(await tv.focused(), "series:s1");
});

browseTest("typing invalidates an in-flight search before the debounce expires", async (tv) => {
    await press(tv, "ArrowUp", "Enter");
    await showing(tv, "search");
    const first = tv.fake.hold("/catalog", true);
    await tv.page.fill("#browse-search", "Movie 0001");
    await tv.remote(IME_DONE);
    await tv.eventually(async () => browseReads(tv, "/catalog").length === 1, "the first search");
    await tv.page.fill("#browse-search", "night");
    first.release();
    await tv.jump(0);
    assert.deepEqual(await cardIds(tv), [], "an obsolete answer must not render before debounce");
    assert.equal(await tv.page.inputValue("#browse-search"), "night");
    assert.equal(browseReads(tv, "/catalog").length, 1, "replacement request is still debounced");
    await tv.jump(600);
    await shows(tv, "Night Shift");
    assert.deepEqual(await cardIds(tv), ["series:s2"]);
    assert.equal(await tv.focused(), "query");
});

browseTest("search uses the TV keyboard, shows only the latest query's answer, and recovers from failures", async (tv, catalog) => {
    await press(tv, "ArrowUp", "Enter");
    await showing(tv, "search");
    assert.equal(await tv.focused(), "query");

    const first = tv.fake.hold("/catalog", true);
    await tv.page.keyboard.type("Movie 0001");
    await tv.jump(600);
    await tv.eventually(async () => browseReads(tv, "/catalog").length === 1, "the first search");
    await shows(tv, "Searching.");
    await tv.page.fill("#browse-search", "night");
    await tv.remote(IME_DONE);
    await tv.eventually(async () => browseReads(tv, "/catalog").length === 2, "the second search");
    await shows(tv, "Night Shift");
    first.release();
    await tv.jump(0);
    assert.deepEqual(await cardIds(tv), ["series:s2"], "the late answer for the older query is dropped");
    assert.match(browseReads(tv, "/catalog")[1]?.path ?? "", /q=night&type=video&limit=24/);
    assert.equal(await tv.focused(), "query", "focus stays in the field while results arrive");
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "series:s2");

    await press(tv, "ArrowUp");
    await tv.page.fill("#browse-search", "zzz");
    await tv.remote(IME_DONE);
    await shows(tv, 'No results for "zzz".');

    catalog.failNext("/catalog", problem(503, "service_unavailable", "Unavailable"), problem(503, "service_unavailable", "Unavailable"));
    await tv.page.fill("#browse-search", "movie 000");
    await tv.remote(IME_DONE);
    await tv.jump(1000);
    await shows(tv, "The server had a problem. Try again in a moment.");
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "retry");
    await press(tv, "Enter");
    await tv.eventually(async () => (await cardIds(tv)).length === 9, "results after retry");
    assert.equal(await tv.focused(), "query", "the focused retry button is gone: focus returns to the field");
});

browseTest("Back from a result reloads a query edited before its debounce could run", async (tv) => {
    await press(tv, "ArrowUp", "Enter");
    await showing(tv, "search");
    await tv.page.fill("#browse-search", "Movie 0001");
    await tv.remote(IME_DONE);
    await tv.eventually(async () => (await cardIds(tv)).join() === "movie:m0001", "the original search result");
    await tv.page.fill("#browse-search", "night");
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "item:movie:m0001");
    const held = tv.fake.hold("/catalog", true);
    await tv.remote(BACK);
    await showing(tv, "search");
    assert.equal(await tv.page.inputValue("#browse-search"), "night");
    assert.deepEqual(await cardIds(tv), [], "the old query's cards cannot be restored under the edited query");
    await tv.eventually(async () => browseReads(tv, "/catalog").length === 2, "the edited query request");
    held.release();
    await shows(tv, "Night Shift");
    assert.deepEqual(await cardIds(tv), ["series:s2"]);
});

browseTest("loading, slow, offline, removed, empty and missing-artwork states all leave a way forward", async (tv, catalog) => {
    await tv.eventually(async () => (await tv.page.locator(".browse-art-missing").count()) >= 2, "placeholders");
    const missing = await tv.page.evaluate(() => Array.from(document.querySelectorAll(".browse-art-missing")).map((node) => node.parentElement?.getAttribute("data-focus")));
    assert.ok(missing.indexOf("movie:m0002") !== -1 && missing.indexOf("movie:m0003") !== -1, "no artwork and failed artwork both show the title");

    const hold = tv.fake.hold("/catalog/items/movie%3Am0001");
    await press(tv, "Enter");
    await showing(tv, "item:loading");
    assert.equal(await tv.focused(), "back");
    await tv.jump(5000);
    await shows(tv, "Still waiting for the server.");
    await press(tv, "Enter");
    await showing(tv, "home");
    hold.release();
    await tv.jump(0);
    assert.equal(await view(tv), "home", "the abandoned answer does not open the page");
    assert.equal(await tv.focused(), "movie:m0001");

    tv.offline = true;
    await press(tv, "Enter");
    await tv.jump(1000);
    await shows(tv, "Could not reach the server. Check the connection and try again.");
    assert.equal(await tv.focused(), "retry");
    tv.offline = false;
    await press(tv, "Enter");
    await showing(tv, "item:movie:m0001");
    await tv.remote(BACK);

    catalog.removed.add("movie:m0001");
    await press(tv, "Enter");
    await shows(tv, "This title is no longer available.");
    await press(tv, "ArrowRight", "Enter");
    await showing(tv, "home");

    const owner = catalog.households.get("p-owner");
    owner?.libraries.push({ id: "17", name: "New Shelf", type: "movies", sort_order: 9 });
    await tv.page.evaluate(() => {
        window.browseHarness.destroy();
        window.browseHarness.mount();
    });
    await showing(tv, "home");
    await press(tv, "ArrowUp", "ArrowRight", "ArrowRight", "ArrowRight", "Enter");
    await showing(tv, "library:17");
    await shows(tv, "This library is empty.");
    assert.equal(await tv.focused(), "back");
});

browseTest("an authority change removes only browse, aborts its reads, and the next profile sees only its own catalog", async (tv) => {
    await press(tv, "ArrowUp", "ArrowRight", "Enter");
    const held = tv.fake.hold("/catalog", true);
    await showing(tv, "library:loading");
    await tv.page.evaluate(() => window.browseHarness.clearProfile());
    held.release();
    await tv.jump(0);
    assert.equal(await tv.page.locator(".browse").count(), 0, "browse removed itself");
    assert.equal(await tv.page.locator("#successor").count(), 1, "the profile screen it left in the root is untouched");
    assert.equal(await tv.page.locator("img").count(), 0, "no artwork of the old profile remains");

    assert.equal(await tv.page.evaluate(() => window.browseHarness.selectProfile("p-kid", "2468")), "verified");
    await tv.page.evaluate(() => window.browseHarness.mount());
    await showing(tv, "home");
    assert.deepEqual(await cardIds(tv, ".browse-nav .browse-button"), ["search", "library:16", "profiles"]);
    const kidReads = browseReads(tv).filter((read) => read.headers["x-profile-id"] === "p-kid");
    assert.ok(kidReads.length >= 3 && kidReads.every((read) => read.headers["x-profile-token"]?.startsWith("pvt-")));

    await press(tv, "ArrowUp", "Enter");
    await tv.page.fill("#browse-search", "movie");
    await tv.remote(IME_DONE);
    await shows(tv, 'No results for "movie".');
    await tv.remote(BACK);
    await showing(tv, "home");

    await press(tv, "ArrowUp", "ArrowRight", "ArrowRight", "Enter");
    assert.deepEqual(await tv.page.evaluate(() => window.browseHarness.chooseProfileCalls), [false], "browse was gone before onChooseProfile ran");
    assert.equal(await tv.page.locator(".browse").count(), 0);
}, { profile: "p-owner" });
