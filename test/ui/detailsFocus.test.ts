import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { launchBrowser, openTv, pauseTvClock, type Tv } from "./support/tv.ts";

const IME_DONE = 65376;
const ENTER = 13;

function owner(tv: Tv): Promise<{ tag: string | null; key: string | null; play: boolean; body: boolean }> {
    return tv.page.evaluate(() => ({
        tag: document.activeElement?.tagName ?? null,
        key: document.activeElement?.getAttribute("data-focus") ?? null,
        play: document.activeElement?.classList.contains("details-play") === true,
        body: document.activeElement === document.body,
    }));
}

async function signedIn(tv: Tv): Promise<void> {
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(() => window.browseHarness.mount());
}

async function searchFor(tv: Tv, query: string, key: string): Promise<void> {
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", query);
    await tv.remote(IME_DONE);
    const card = tv.page.locator(`.browse-grid [data-focus="${key}"]`);
    await card.waitFor();
    await card.focus();
}

let browser: Browser;

before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

test("opening a movie from Search leaves Play focused when the opening claim does not stick", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeDetails();
    catalog.progress.delete("movie:m0001");
    tv.fake.catalog = catalog;
    try {
        await signedIn(tv);
        await searchFor(tv, "Movie 0001", "movie:m0001");
        const holds = [
            "/recommendations/similar/movie%3Am0001",
            "/watchlist/movie%3Am0001/membership",
            "/favorites/movie%3Am0001/membership",
            "/catalog/items/movie%3Am0001/box-set",
            "/capabilities/personal-lists",
            "/settings/contract/capabilities",
            "/settings/contract",
            "/settings/values/effective",
        ].map(path => tv.fake.hold(path));
        // The TV can drop the Play claim made while the search card is removed.
        // Reject every claim in that opening turn. The page clock otherwise keeps
        // running across the round trip, and the 50ms retry restores Play before
        // a later read. Hold the clock so this read is still that rejected claim,
        // then advance the window Apple retries inside (three attempts, 50ms apart).
        // That later read is the Play focus the viewer sees, with no remote key
        // and no follow-up repaint.
        await pauseTvClock(tv);
        await tv.page.evaluate(() => {
            document.documentElement.dataset.blockPlay = "1";
            document.addEventListener("focusin", event => {
                const target = event.target;
                if (document.documentElement.dataset.blockPlay !== "1" || !(target instanceof HTMLElement) || !target.classList.contains("details-play")) return;
                target.blur();
            }, true);
        });
        await tv.remote(ENTER);
        await tv.page.locator(".details-play").waitFor();
        await tv.page.evaluate(() => undefined);
        const dropped = await tv.page.evaluate(() => {
            const active = document.activeElement;
            const snapshot = {
                tag: active?.tagName ?? null,
                key: active?.getAttribute("data-focus") ?? null,
                play: active?.classList.contains("details-play") === true,
                body: active === document.body,
            };
            delete document.documentElement.dataset.blockPlay;
            return snapshot;
        });
        await tv.jump(200);
        const settled = await owner(tv);
        assert.equal(dropped.body, true, `opening claim stayed on ${dropped.key ?? dropped.tag}`);
        assert.equal(settled.body, false, JSON.stringify(settled));
        assert.equal(settled.play, true, JSON.stringify(settled));
        assert.equal(settled.key, "play", JSON.stringify(settled));
        for (const hold of holds) hold.release();
        await tv.eventually(async () => await tv.page.locator('[data-focus="watchlist"]').count() === 1, "personal actions settled");
        const repainted = await owner(tv);
        assert.equal(repainted.key, "play", `a supporting repaint left ${JSON.stringify(repainted)}`);
        assert.equal(repainted.play, true);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a card-actions dialog keeps focus while the Play claim is still retrying", async () => {
    const tv = await openTv(browser, { app: "browse" });
    tv.fake.catalog = new FakeDetails();
    try {
        await signedIn(tv);
        await searchFor(tv, "Movie 0001", "movie:m0001");
        await pauseTvClock(tv);
        await tv.remote(ENTER);
        const primary = tv.page.locator(".details-play");
        await primary.waitFor();
        await tv.eventually(async () => await primary.getAttribute("aria-disabled") !== "true", "movie Play ready");
        const related = tv.page.locator('[data-detail-section="related"] [data-focus]').first();
        await related.waitFor();
        await related.click({ button: "right" });
        await tv.page.locator(".card-actions-panel").waitFor();
        const dialog = await owner(tv);
        await tv.jump(200);
        const settled = await owner(tv);
        assert.equal(dialog.body, false, `dialog never took focus: ${JSON.stringify(dialog)}`);
        assert.equal(settled.key, dialog.key, `retry left ${JSON.stringify(settled)}`);
        assert.equal(settled.play, false, `retry focused Play behind the dialog: ${JSON.stringify(settled)}`);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

async function hideSeriesPlayTarget(tv: Tv): Promise<void> {
    const catalog = tv.fake.catalog;
    if (!(catalog instanceof FakeDetails)) throw new Error("expected details catalog");
    await tv.page.route("**/api/v2/catalog/items/series%3As1?**", route => {
        const reply = catalog.route("GET", "/catalog/items/series%3As1", "p-owner");
        const body = reply?.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("series detail missing");
        const detail: Record<string, unknown> = { ...body };
        delete detail.play_content_id;
        return route.fulfill({ json: detail });
    });
}

test("a late primary takes focus from the live control that held the opening focus", async () => {
    const tv = await openTv(browser, { app: "browse" });
    tv.fake.catalog = new FakeDetails();
    await hideSeriesPlayTarget(tv);
    try {
        await signedIn(tv);
        await searchFor(tv, "Harbor Lights", "series:s1");
        const episodes = tv.fake.hold("/catalog/series/series%3As1/seasons/1/episodes");
        await tv.remote(ENTER);
        await tv.page.locator('[data-view="item:series:s1"] [data-focus="season:1"]').waitFor();
        await tv.eventually(async () => await tv.page.locator('[data-focus="next-episode"]').count() === 0, "series opened before its primary existed");
        // Apple's entryAction stands Watchlist in while playTitle is nil, and
        // resetInitialPlayFocus attempt 0 still assigns Play (eb82bb86, lines
        // 597-602 and 635-643). The opening focus here is that live stand-in.
        await tv.eventually(async () => {
            const held = await owner(tv);
            return held.body === false && held.play === false && held.key !== null;
        }, "live control held focus before the primary existed");
        const before = await owner(tv);
        episodes.release();
        await tv.eventually(async () => await tv.page.locator('[data-focus="next-episode"]').count() === 1, "late primary rendered");
        await tv.eventually(async () => await tv.focused() === "next-episode", "late primary focused");
        const settled = await owner(tv);
        assert.equal(before.body, false, `opening focus was lost: ${JSON.stringify(before)}`);
        assert.equal(before.play, false, `primary was already present: ${JSON.stringify(before)}`);
        assert.ok(before.key, `no live control held focus: ${JSON.stringify(before)}`);
        assert.notEqual(settled.key, before.key, `late primary left ${JSON.stringify(before)}`);
        assert.equal(settled.key, "next-episode", JSON.stringify(settled));
        assert.equal(settled.play, true, JSON.stringify(settled));
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a primary action that appears after the viewer moves leaves that control focused", async () => {
    const tv = await openTv(browser, { app: "browse" });
    tv.fake.catalog = new FakeDetails();
    await hideSeriesPlayTarget(tv);
    try {
        await signedIn(tv);
        await searchFor(tv, "Harbor Lights", "series:s1");
        const episodes = tv.fake.hold("/catalog/series/series%3As1/seasons/1/episodes");
        await tv.remote(ENTER);
        await tv.page.locator('[data-view="item:series:s1"] [data-focus="season:1"]').waitFor();
        await tv.eventually(async () => await tv.page.locator('[data-focus="next-episode"]').count() === 0, "series opened before its primary existed");
        await tv.page.locator('[data-focus="season:1"]').focus();
        await tv.remote(39);
        const moved = await owner(tv);
        episodes.release();
        await tv.page.locator('[data-focus="next-episode"]').waitFor();
        await tv.jump(200);
        const settled = await owner(tv);
        assert.notEqual(moved.key, "next-episode");
        assert.equal(settled.key, moved.key, `late primary replaced ${JSON.stringify(moved)} with ${JSON.stringify(settled)}`);
        assert.equal(settled.play, false);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("opening a series keeps its primary action when focus has moved", async () => {
    const tv = await openTv(browser, { app: "browse" });
    tv.fake.catalog = new FakeDetails();
    try {
        await signedIn(tv);
        await searchFor(tv, "Harbor Lights", "series:s1");
        await tv.remote(ENTER);
        await tv.eventually(async () => await tv.focused() === "next-episode", "series primary action");
        await tv.page.locator('[data-focus="season:1"]').focus();
        await tv.jump(200);
        assert.equal(await tv.focused(), "season:1", "a later Play claim must not steal the season the viewer moved to");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Left through a loaded previous season after a fast chip walk sends no season read", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeDetails();
    for (let season = 3; season <= 25; season++) for (let episode = 1; episode <= (season === 25 ? 13 : 22); episode++) catalog.add({ id: `episode:s1e${season}x${episode}`, type: "episode", title: `Harbor chapter ${season}.${episode}`, libraryId: "13", seriesId: "series:s1", season, episode });
    tv.fake.catalog = catalog;
    const seasonReads = (): string[] => tv.fake.requests.filter(request => /\/seasons\/\d+\/episodes/.test(request.path)).map(request => /\/seasons\/(\d+)\//.exec(request.path)?.[1] ?? "");
    try {
        await signedIn(tv);
        await searchFor(tv, "Harbor Lights", "series:s1");
        await tv.remote(ENTER);
        await tv.page.locator('[data-focus="season:1"]').waitFor();
        await tv.jump(500);
        await tv.page.locator('[data-focus="season:1"]').focus();
        // Each held read is aborted by the next chip, as in a fast walk.
        const holds = Array.from({ length: 22 }, (_, index) => tv.fake.hold(`/catalog/series/series%3As1/seasons/${index + 3}/episodes`));
        for (let press = 0; press < 24; press++) { await tv.remote(39); await tv.jump(80); }
        for (const hold of holds) hold.release();
        await tv.jump(300);
        await tv.remote(ENTER); await tv.jump(500);
        await tv.page.locator('[data-focus="episode:s1e25x1"]').waitFor();
        await tv.remote(40); await tv.jump(500);
        assert.equal(await tv.focused(), "episode:s1e25x1");
        await tv.remote(37); await tv.jump(1500);
        // The season read answers over the routed network, after the fake clock has passed the dwell.
        await tv.eventually(async () => await tv.focused() === "episode:s1e24x22", "Left reaches the aborted previous season");
        assert.equal(await tv.focused(), "episode:s1e24x22", "Left at the first loaded card reaches the aborted previous season");
        const reads = seasonReads().length;
        assert.equal(seasonReads().filter(number => number === "24").length, 2, "the walk aborted one read of season 24 and the edge asked once more");
        for (let press = 0; press < 14; press++) { await tv.remote(37); await tv.jump(1500); }
        assert.equal(await tv.focused(), "episode:s1e24x8");
        assert.deepEqual(seasonReads().slice(reads), [], "moves inside the loaded season never read a season list");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});
