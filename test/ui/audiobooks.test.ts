// The audiobook library cascade, card and detail, driven by remote keys in Chromium against a fake Silo
// that holds an audiobook library. Desktop Chromium is not the TV's Chromium 108: this proves behavior,
// not TV rendering. Set EVIDENCE_DIR to also write 1920x1080 screenshots.

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeAudiobooks } from "../native/support/fakeAudiobooks.ts";
import { selectLibraryMode } from "./support/library.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

const BACK = 10009;
const ENTER = 13;
const IME_DONE = 65376;
const TIDE = "audiobook:tide";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

function audiobookTest(name: string, body: (tv: Tv, catalog: FakeAudiobooks) => Promise<void>): void {
    test(name, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            const catalog = new FakeAudiobooks();
            tv.fake.catalog = catalog;
            await tv.page.emulateMedia({ reducedMotion: "reduce" });
            await tv.page.evaluate(() => window.browseHarness.connect());
            await tv.eventually(async () => tv.fake.devices.size > 0, "a device code");
            tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
            await tv.jump(5000);
            await tv.eventually(async () => (await tv.page.evaluate(() => window.browseHarness.loginPhase)) === "signed_in", "sign-in");
            assert.equal(await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner")), "selected");
            await tv.page.evaluate(() => window.browseHarness.mount());
            await showing(tv, "home");
            await body(tv, catalog);
            assert.deepEqual(tv.console, [], "the page logs nothing");
        } finally {
            await tv.page.context().close();
        }
    });
}

const view = (tv: Tv): Promise<string | null> => tv.page.evaluate(() => document.querySelector(".browse")?.getAttribute("data-view") ?? null);
const showing = (tv: Tv, name: string): Promise<void> => tv.eventually(async () => (await view(tv)) === name, `the ${name} view`);

async function shoot(tv: Tv, name: string): Promise<void> {
    const dir = process.env.EVIDENCE_DIR;
    if (dir === undefined) return;
    await mkdir(dir, { recursive: true });
    await tv.page.screenshot({ path: `${dir}/${name}.png` });
}

async function showAudiobooks(tv: Tv): Promise<void> {
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.locator('[data-focus="settings"]').click();
    const row = tv.page.locator('[data-focus="show-audiobooks"]');
    await row.waitFor();
    if (await row.getAttribute("aria-checked") !== "true") await row.click();
    assert.equal(await row.getAttribute("aria-checked"), "true");
    await leaveSettings(tv);
}

/** Back leaves the General pane for the category list, and the list for Home. */
async function leaveSettings(tv: Tv): Promise<void> {
    for (let presses = 0; presses < 3 && !(await tv.page.locator('[data-view="home"]').isVisible()); presses++) await tv.remote(BACK);
    await tv.page.locator('[data-view="home"]').waitFor();
}

audiobookTest("Home draws an all-audiobook row square, keeps Continue Listening as stills, and opens a card on its detail", async tv => {
    const shelf = tv.page.locator('[data-section="shelf"] .browse-card:not(.skyline-explore)');
    assert.equal(await shelf.count(), 4);
    for (const box of await shelf.locator(".browse-art").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect()))) {
        assert.ok(Math.abs(box.width - box.height) < 1, `a square cover, got ${box.width}x${box.height}`);
    }
    assert.equal(await tv.page.locator('[data-section="listen"] .browse-card').first().getAttribute("class").then(value => value?.includes("skyline-continue")), true);
    assert.equal(await tv.page.locator('[data-section="listen"] .browse-card-square').count(), 0, "Apple checks the still rows before the square rule");
    await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:dune"]').focus();
    await shoot(tv, "audiobook-card-home-row");
    await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:dune"]').click();
    await showing(tv, "audiobook:audiobook:dune");
});

audiobookTest("the audiobook detail shows the cover, credits, state and a Play button that does nothing yet", async tv => {
    await tv.page.locator(`[data-section="shelf"] [data-focus="${TIDE}"]`).click();
    await showing(tv, `audiobook:${TIDE}`);
    assert.equal(await tv.page.locator(".audiobook-title").innerText(), "The Tide Owes");
    assert.equal(await tv.page.locator(".audiobook-eyebrow").innerText(), "AUDIOBOOK · FANTASY");
    assert.equal(await tv.page.locator(".audiobook-series").innerText(), "THE STORMLIGHT ARCHIVE · BOOK 5 OF 5");
    assert.equal(await tv.page.locator(".audiobook-credits").innerText(), "by Brandon Sanderson  ·  read by Michael Kramer & Kate Reading");
    assert.equal(await tv.page.locator(".audiobook-state-line").innerText(), "Chapter 2 · What the Tide Owes");
    assert.equal(await tv.page.locator(".audiobook-state-detail").innerText(), "8:32 into the chapter · 1h 51m left in the book");
    assert.equal(await tv.page.locator(".audiobook-ring-label").innerText(), "38%");
    const cover = await tv.page.locator(".audiobook-cover").evaluate(node => { const box = node.getBoundingClientRect(); return [box.width, box.height]; });
    assert.deepEqual(cover, [460, 460]);
    const play = tv.page.locator('[data-focus="play"]');
    assert.equal(await play.innerText(), "Resume");
    assert.equal(await play.getAttribute("aria-disabled"), "true");
    assert.equal(await tv.focused(), "play", "initial focus is the primary action, as on Apple");
    const before = tv.fake.requests.length;
    await tv.remote(ENTER);
    assert.equal(await view(tv), `audiobook:${TIDE}`, "Play opens nothing until playback lands");
    assert.equal(tv.fake.requests.slice(before).filter(request => /playback|stream|shuffle/.test(request.path)).length, 0);
    await shoot(tv, "audiobook-detail");
    await tv.remote(39);
    assert.equal(await tv.focused(), "chapters");
    await tv.remote(39);
    assert.equal(await tv.focused(), "start-over");
});

audiobookTest("Chapters opens a picker on the current chapter and Back returns to the button", async tv => {
    await tv.page.locator(`[data-section="shelf"] [data-focus="${TIDE}"]`).click();
    await showing(tv, `audiobook:${TIDE}`);
    await tv.page.locator('[data-focus="chapters"]').click();
    await showing(tv, `audiobook:${TIDE}:chapters`);
    assert.equal(await tv.page.locator(".audiobook-picker-subline").innerText(), "38% · Chapter 2 of 3 · 1h 51m left");
    assert.deepEqual(await tv.page.locator(".audiobook-chapter .audiobook-row-title").allInnerTexts(), ["Opening", "What the Tide Owes", "Chapter 3"]);
    assert.equal(await tv.focused(), "chapter-1");
    assert.equal(await tv.page.locator('[data-focus="chapter-1"] .audiobook-chapter-now').innerText(), "NOW");
    assert.equal(await tv.page.locator('[data-focus="chapter-0"] .audiobook-chapter-done').count(), 1);
    await shoot(tv, "audiobook-chapters");
    await tv.remote(BACK);
    await showing(tv, `audiobook:${TIDE}`);
    assert.equal(await tv.focused(), "chapters");
});

audiobookTest("below the fold the detail lists narrations and rails, and a selection opens that book", async tv => {
    await tv.page.locator(`[data-section="shelf"] [data-focus="${TIDE}"]`).click();
    await showing(tv, `audiobook:${TIDE}`);
    assert.equal(await tv.page.locator(".audiobook-about").innerText(), "The war for Roshar reaches its last turn, and the oaths that bound the Radiants are tested one more time.");
    assert.equal(await tv.page.locator(".audiobook-static-credits").innerText(), "Written by Brandon Sanderson · Narrated by Michael Kramer & Kate Reading · Tor Books · 2024");
    assert.deepEqual(await tv.page.locator(".audiobook-section-title").allInnerTexts(), ["About", "Narrations", "The Stormlight Archive", "More by Author"]);
    assert.equal(await tv.page.locator(".audiobook-rail .browse-card-square").count(), 4);
    assert.equal(await tv.page.locator(".audiobook-rail .browse-card-subtitle").first().innerText(), "Book 1");
    await tv.page.locator('[data-focus="narration:audiobook:fresh"]').click();
    await showing(tv, "audiobook:audiobook:fresh");
    await tv.remote(BACK);
    await showing(tv, `audiobook:${TIDE}`);
});

audiobookTest("Audiobooks stays off until Show Audiobooks is on, then opens the library with square covers", async tv => {
    assert.equal(await tv.page.locator('[data-focus="audiobooks"]').count(), 0, "off by default");
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.locator('[data-focus="settings"]').click();
    const row = tv.page.locator('[data-focus="show-audiobooks"]');
    await row.waitFor();
    assert.equal(await row.getAttribute("aria-checked"), "false");
    assert.equal(await tv.page.locator(".settings-section-header", { hasText: "TOP MENU" }).count(), 1);
    assert.match(await tv.page.locator("body").innerText(), /Adds an Audiobooks tab when an audiobook library is available\./);
    await row.click();
    assert.equal(await row.getAttribute("aria-checked"), "true");
    await leaveSettings(tv);
    const tab = tv.page.locator('[data-focus="audiobooks"]');
    await tab.waitFor();
    assert.deepEqual(await tv.page.locator(".skyline-roots [role=tab]").allInnerTexts(), ["Home", "Movies", "Series", "Audiobooks", "For You", "Calendar"]);
    await tab.click();
    await showing(tv, "library:14");
    const covers = tv.page.locator('[data-section] .browse-card-square');
    await covers.first().waitFor();
    assert.equal(await covers.count(), 4);
    await shoot(tv, "audiobook-library");
    const first = await covers.first().getAttribute("data-focus");
    await covers.first().click();
    await showing(tv, `audiobook:${first}`);
});

audiobookTest("the Audiobooks library Browse grid queries by library alone and offers Apple's audiobook sorts", async tv => {
    await showAudiobooks(tv);
    await tv.page.locator('[data-focus="audiobooks"]').click();
    await showing(tv, "library:14");
    await selectLibraryMode(tv, "Browse");
    await tv.page.locator('.browse-grid .browse-card-square').first().waitFor();
    const query = tv.fake.requests.filter(request => request.path.startsWith("/catalog/query") && request.body?.library_id === "14").at(-1);
    assert.ok(query !== undefined);
    assert.equal(query.body?.type, undefined, "an audiobook library sends no type");
    await tv.page.locator('[data-focus="sort"]').click();
    assert.deepEqual(await tv.page.locator('.browse-sort-panel [data-focus^="sort:"]').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus"))), ["sort:title", "sort:author", "sort:narrator", "sort:series", "sort:added_at", "sort:runtime"]);
});

audiobookTest("with Show Audiobooks off, Search offers no Audiobooks filter and keeps to a video scope", async tv => {
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", "Dune"); await tv.remote(IME_DONE);
    await tv.page.getByText("Try a different search term").first().waitFor();
    assert.equal(await tv.page.locator('[data-focus="search-filter:audiobook"]').count(), 0, "no Audiobooks filter while the opt-in is off");
    const types = tv.fake.requests.filter(request => request.path.startsWith("/catalog?")).map(request => new URL(request.path, "https://fake.invalid").searchParams.get("type"));
    assert.ok(types.length > 0 && types.every(type => type === "video" || type === "video_with_episodes"), `search names a video scope, got ${types.join()}`);
});

audiobookTest("with Show Audiobooks on, Search offers Audiobooks, names no scope for All, and opens a result on its detail", async tv => {
    await showAudiobooks(tv);
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", "Dune"); await tv.remote(IME_DONE);
    const book = tv.page.locator('.browse-grid [data-focus="audiobook:dune"]');
    await book.waitFor();
    assert.ok((await book.getAttribute("class"))?.includes("browse-card-square"));
    const all = tv.fake.requests.filter(request => request.path.startsWith("/catalog?q=")).at(-1);
    assert.ok(all !== undefined);
    assert.equal(new URL(all.path, "https://fake.invalid").searchParams.get("type"), null, "All names no type while audiobooks take part");
    await tv.page.locator('[data-focus="search-filter:audiobook"]').focus();
    await tv.eventually(async () => tv.fake.requests.some(request => request.path.startsWith("/catalog?q=") && new URL(request.path, "https://fake.invalid").searchParams.get("type") === "audiobook"), "the Audiobooks read");
    await shoot(tv, "audiobook-search");
    await book.click();
    await showing(tv, "audiobook:audiobook:dune");
});
