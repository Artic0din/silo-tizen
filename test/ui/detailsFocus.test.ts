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
