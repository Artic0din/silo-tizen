// Browse focus and scroll parity. Desktop Chromium is not the TV's Chromium 76.

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeCalendar } from "../native/support/fakeCalendar.ts";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { type Reply } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

class SeamCatalog extends FakeDetails {
    override route(method: string, path: string, profile: string | undefined, body?: Record<string, unknown>): Reply | undefined {
        if (path.startsWith("/catalog/query") && body?.source === "watchlist") {
            const scoped = [...this.titles.values()].filter(title => title.type === "movie" || title.type === "series");
            const items = scoped.slice(0, 8).flatMap(title => {
                const reply = super.route("GET", `/catalog/items/${encodeURIComponent(title.id)}`, profile);
                return reply?.body === undefined ? [] : [reply.body];
            });
            return { status: 200, body: { window_cursor: "watchlist", items, total: items.length, total_exact: true, page: { has_more: false } } };
        }
        return super.route(method, path, profile, body);
    }
}

const BACK = 10009;
const ENTER = 13;

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

async function signedIn(tv: Tv, catalog: FakeCatalog = new FakeCatalog()): Promise<FakeCatalog> {
    tv.fake.catalog = catalog;
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase) === "signed_in", "sign-in");
    assert.equal(await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner")), "selected");
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.page.locator('[data-view="home"]').waitFor();
    return catalog;
}

async function showing(tv: Tv, name: string): Promise<void> {
    await tv.eventually(async () => await tv.page.locator(".browse").getAttribute("data-view") === name, name);
}

async function activate(tv: Tv, key: string): Promise<void> {
    await tv.page.locator(`[data-focus="${key}"]`).evaluate((node) => {
        if (!(node instanceof HTMLElement)) throw new Error("missing control");
        node.click();
    });
}

interface ScrollCommit { readonly top: number; readonly left: number; readonly key: string; readonly section: string }

async function commitScroll(tv: Tv, top: number): Promise<ScrollCommit> {
    const committed = await tv.page.evaluate((targetTop) => {
        const viewport = document.querySelector<HTMLElement>(".browse .skyline-content");
        const card = document.activeElement;
        const row = card instanceof HTMLElement ? card.closest<HTMLElement>(".browse-row") : null;
        if (viewport === null || !(card instanceof HTMLElement) || row === null) throw new Error("browse scroll target missing");
        viewport.scrollTop = targetTop;
        const room = Math.max(0, row.scrollWidth - row.clientWidth);
        const base = row.scrollLeft;
        const overlaps = (left: number): boolean => {
            row.scrollLeft = left;
            const cardBox = card.getBoundingClientRect();
            const viewBox = viewport.getBoundingClientRect();
            const rowBox = row.getBoundingClientRect();
            return cardBox.width > 0 && cardBox.bottom > viewBox.top + 1 && cardBox.top < viewBox.bottom - 1 && cardBox.right > rowBox.left + 1 && cardBox.left < rowBox.right - 1;
        };
        const candidates = [base + 48, base + 24, base - 36, base - 18].filter(value => value > 0 && value <= room && Math.abs(value - base) >= 12);
        const left = candidates.find(value => overlaps(value));
        if (left === undefined || viewport.scrollTop !== targetTop) {
            throw new Error(`setup could not commit top ${targetTop} (stuck at ${viewport.scrollTop}, room ${room}, base ${base})`);
        }
        row.scrollLeft = left;
        if (!overlaps(left)) throw new Error("committed card is not visible");
        return { top: viewport.scrollTop, left: row.scrollLeft, key: card.getAttribute("data-focus") ?? "", section: row.closest("[data-section]")?.getAttribute("data-section") ?? "" };
    }, top);
    assert.equal(committed.top, top, "setup commits the requested vertical scroll");
    assert.ok(committed.left > 0 && committed.key !== "" && committed.section !== "", "setup commits a visible scrolled card");
    return committed;
}

async function scrollOf(tv: Tv, section: string): Promise<{ top: number; left: number }> {
    return tv.page.evaluate((sectionId) => {
        const root = document.querySelector(".browse");
        return {
            top: root?.querySelector(".skyline-content")?.scrollTop ?? -1,
            left: root?.querySelector(`[data-section="${sectionId}"] .browse-row`)?.scrollLeft ?? -1,
        };
    }, section);
}

async function settleFocusMotion(tv: Tv): Promise<void> {
    await tv.page.evaluate(() => {
        for (const animation of document.getAnimations()) animation.finish();
    });
}

async function focusClip(tv: Tv): Promise<{ key: string; transform: string; inside: boolean; scale: number }> {
    return tv.page.evaluate(() => {
        const card = document.activeElement;
        if (!(card instanceof HTMLElement) || !card.classList.contains("browse-card")) throw new Error("focused browse card missing");
        const transform = getComputedStyle(card).transform;
        const rect = card.getBoundingClientRect();
        let inside = true;
        for (let node = card.parentElement; node !== null; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (!/hidden|clip|auto|scroll/.test(`${style.overflowX} ${style.overflowY}`)) continue;
            const bounds = node.getBoundingClientRect();
            if (bounds.width === 0 || bounds.height === 0) continue;
            if (rect.left < bounds.left - 0.5 || rect.top < bounds.top - 0.5 || rect.right > bounds.right + 0.5 || rect.bottom > bounds.bottom + 0.5) inside = false;
        }
        const matrix = /^matrix\(([^)]+)\)$/.exec(transform)?.[1]?.split(",").map(part => Number(part.trim())) ?? [];
        const scale = matrix.length === 6 ? matrix[0] ?? 1 : transform === "none" ? 1 : Number.NaN;
        return { key: card.getAttribute("data-focus") ?? "", transform, inside, scale };
    });
}

function visibleFocus(tv: Tv): Promise<boolean> {
    return tv.page.evaluate(() => {
        const card = document.activeElement;
        if (!(card instanceof HTMLElement)) return false;
        const viewport = card.closest(".details-audio-picker, .skyline-content, .settings") ?? document.querySelector(".browse");
        if (!(viewport instanceof HTMLElement)) return false;
        const rect = card.getBoundingClientRect();
        const bounds = viewport.getBoundingClientRect();
        const row = card.closest(".browse-row");
        const horizontal = row instanceof HTMLElement ? card.getBoundingClientRect().right > row.getBoundingClientRect().left && card.getBoundingClientRect().left < row.getBoundingClientRect().right : rect.right > bounds.left && rect.left < bounds.right;
        return rect.width > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom && horizontal;
    });
}

async function openLibrary(tv: Tv): Promise<void> {
    await activate(tv, "movies");
    await showing(tv, "library:12");
    await tv.eventually(async () => await tv.focused() === "movie:m0001", "first library card");
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`library Back keeps committed scroll ${reducedMotion}`, async () => {
        const capture = process.env.FOCUS_PARITY_CAPTURE;
        const tv = await openTv(browser, { app: "browse", ...(capture === undefined ? {} : { video: `${capture}/${reducedMotion}` }) });
        try {
            await tv.page.emulateMedia({ reducedMotion });
            await signedIn(tv);
            await openLibrary(tv);
            await settleFocusMotion(tv);
            const entry = await focusClip(tv);
            if (capture !== undefined) {
                await mkdir(`${capture}/${reducedMotion}`, { recursive: true });
                await tv.page.screenshot({ path: `${capture}/${reducedMotion}/entry.png` });
            }
            if (reducedMotion === "reduce") {
                assert.equal(entry.transform, "none", "reduced motion does not grow the focused card");
                assert.equal(entry.inside, true, "reduced-motion focus border stays inside the clip on entry");
            } else {
                assert.ok(Math.abs(entry.scale - 1.05) < 0.02, `normal motion keeps the 1.05 focus scale (${entry.transform})`);
                assert.equal(entry.inside, true, "normal-motion focus border stays inside the clip on entry");
            }
            for (let step = 0; step < 8; step++) await tv.remote(39);
            await tv.jump(300);
            const committed = await commitScroll(tv, 140);
            await tv.remote(ENTER);
            await showing(tv, `item:${committed.key}`);
            await tv.remote(BACK);
            await showing(tv, "library:12");
            if (capture !== undefined) await tv.page.screenshot({ path: `${capture}/${reducedMotion}/return-140.png` });
            const returned = await scrollOf(tv, committed.section);
            assert.deepEqual(returned, { top: committed.top, left: committed.left });
            assert.equal(await tv.focused(), committed.key);
            await tv.jump(300);
            assert.deepEqual(await scrollOf(tv, committed.section), { top: committed.top, left: committed.left }, "return does not animate the committed scroll a second time");
            await activate(tv, committed.key);
            await showing(tv, `item:${committed.key}`);
            await tv.page.locator('[data-focus="play"]').click();
            await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.plays.length) === 1, "playback handoff");
            await tv.page.evaluate(() => window.browseHarness.resume());
            await tv.page.locator('[data-focus="play"]').waitFor();
            await tv.remote(BACK);
            await showing(tv, "library:12");
            await tv.eventually(async () => {
                const position = await scrollOf(tv, committed.section);
                return position.top === committed.top && position.left === committed.left && await tv.focused() === committed.key;
            }, "player return restores the committed card");
            await tv.jump(300);
            assert.deepEqual(await scrollOf(tv, committed.section), { top: committed.top, left: committed.left });
            assert.equal(await tv.page.locator(".browse").getAttribute("data-view"), "library:12");
            // Scroll 140 leaves this row above the library scroller. The border check uses a
            // committed position that keeps the card inside and is still not the reveal target.
            const fitted = await commitScroll(tv, 100);
            await tv.remote(ENTER);
            await showing(tv, `item:${fitted.key}`);
            await tv.remote(BACK);
            await showing(tv, "library:12");
            assert.deepEqual(await scrollOf(tv, fitted.section), { top: fitted.top, left: fitted.left });
            await tv.jump(300);
            assert.deepEqual(await scrollOf(tv, fitted.section), { top: fitted.top, left: fitted.left });
            await settleFocusMotion(tv);
            const afterReturn = await focusClip(tv);
            assert.equal(afterReturn.inside, true, "focus border stays inside the clip on return");
            if (reducedMotion === "reduce") assert.equal(afterReturn.transform, "none");
            else assert.ok(Math.abs(afterReturn.scale - 1.05) < 0.02);
            if (capture !== undefined) await tv.page.screenshot({ path: `${capture}/${reducedMotion}/return.png` });
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });

    test(`offscreen library card uses a visible fallback on Back ${reducedMotion}`, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            await tv.page.emulateMedia({ reducedMotion });
            await signedIn(tv);
            await openLibrary(tv);
            for (let step = 0; step < 12; step++) await tv.remote(39);
            await tv.jump(300);
            const hidden = await tv.focused();
            assert.equal(hidden, "movie:m0013");
            await tv.page.evaluate(() => {
                const viewport = document.querySelector<HTMLElement>(".browse .skyline-content");
                const row = document.activeElement?.closest<HTMLElement>(".browse-row");
                if (viewport === null || row == null) throw new Error("missing row");
                viewport.scrollTop = 0;
                row.scrollLeft = 0;
            });
            assert.equal(await visibleFocus(tv), false, "setup hides the focused card");
            await tv.remote(ENTER);
            await showing(tv, "item:movie:m0013");
            await tv.remote(BACK);
            await showing(tv, "library:12");
            await tv.jump(300);
            assert.notEqual(await tv.focused(), hidden);
            assert.equal(await visibleFocus(tv), true, "fallback focus is on screen");
            assert.equal(await tv.page.locator(`.browse [data-focus="${hidden}"]`).count(), 1, "the original card remains in the library");
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}

test("library modes keep separate scroll and focus visits", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await signedIn(tv);
        await openLibrary(tv);
        for (let step = 0; step < 8; step++) await tv.remote(39);
        await tv.jump(300);
        const committed = await commitScroll(tv, 140);
        await activate(tv, "mode:Collections");
        await tv.page.locator('[data-focus="collection:highlights"]').waitFor();
        assert.equal(await tv.page.locator(".browse").getAttribute("data-view"), "library:12", "mode changes keep the public library view id");
        assert.notEqual(await tv.focused(), committed.key);
        assert.equal((await scrollOf(tv, committed.section)).top, 0);
        await activate(tv, "mode:Genres");
        await tv.page.locator('[data-focus="genre:Drama"]').waitFor();
        await tv.remote(39);
        assert.equal(await tv.focused(), "genre:Comedy");
        await activate(tv, "mode:Browse");
        await tv.page.locator(`[data-focus="${committed.key}"]`).waitFor();
        await tv.jump(300);
        assert.equal(await tv.focused(), committed.key, "Browse visit focus");
        assert.deepEqual(await scrollOf(tv, committed.section), { top: committed.top, left: committed.left });
        assert.equal(await tv.page.locator(".browse").getAttribute("data-view"), "library:12");
        await activate(tv, "mode:Genres");
        await tv.eventually(async () => await tv.focused() === "genre:Comedy", "Genres visit focus");
        assert.equal(await tv.page.locator(".browse").getAttribute("data-view"), "library:12");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("pointer-selected shelf cards are fully revealed on Back", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await signedIn(tv);
        await openLibrary(tv);
        await tv.jump(300);
        const key = await tv.page.evaluate(() => {
            const row = document.querySelector<HTMLElement>(".browse-row");
            if (row === null) throw new Error("missing shelf");
            const edge = row.getBoundingClientRect().right;
            const card = [...row.querySelectorAll<HTMLElement>(".browse-card[data-focus]")].find(item => {
                const box = item.getBoundingClientRect();
                return box.right > edge + 20 && box.left < edge - 60;
            });
            if (card === undefined) throw new Error("missing partly visible card");
            card.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
            card.focus({ preventScroll: true });
            card.click();
            return card.getAttribute("data-focus");
        });
        assert.ok(key);
        await showing(tv, `item:${key}`);
        await tv.remote(BACK);
        await showing(tv, "library:12");
        await tv.jump(300);
        await settleFocusMotion(tv);
        assert.equal(await tv.focused(), key);
        assert.equal((await focusClip(tv)).inside, true, "Back reveals the complete focus border");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const destination of ["mode", "settings"] as const) test(`pending library restoration survives leaving for ${destination}`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await signedIn(tv);
        new FakeSettings(tv.fake);
        await openLibrary(tv);
        for (let step = 0; step < 8; step++) await tv.remote(39);
        await tv.jump(300);
        const committed = await commitScroll(tv, 140);
        await activate(tv, "mode:Collections");
        await tv.page.locator('[data-focus="collection:highlights"]').waitFor();
        const before = tv.fake.requests.filter(request => request.path.startsWith("/library/12/sections")).length;
        const held = tv.fake.hold("/library/12/sections", true);
        await activate(tv, "mode:Browse");
        await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/library/12/sections")).length === before + 1, "Browse restore read dispatched");
        if (destination === "mode") {
            await activate(tv, "mode:Genres");
            await tv.page.locator('[data-focus="genre:Drama"]').waitFor();
            held.release();
            await activate(tv, "mode:Browse");
        } else {
            await tv.page.locator('[data-focus="profiles"]').focus();
            await tv.page.keyboard.press("Enter");
            await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
            await tv.page.locator('[data-focus="playback"]').waitFor();
            held.release();
            await tv.remote(BACK);
        }
        await tv.page.locator(`[data-focus="${committed.key}"]`).waitFor();
        await tv.jump(300);
        assert.equal(await tv.focused(), committed.key, "loading controls do not replace the saved card");
        assert.deepEqual(await scrollOf(tv, committed.section), { top: committed.top, left: committed.left });
        await activate(tv, "mode:Genres");
        await tv.page.locator('[data-focus="genre:Drama"]').waitFor();
        await activate(tv, "mode:Browse");
        await tv.eventually(async () => await tv.focused() === committed.key, "restored visit remains usable");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a pending shelf return reveals its saved partly clipped card", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await signedIn(tv);
        await openLibrary(tv);
        await tv.jump(300);
        const key = await tv.page.evaluate(() => {
            const row = document.querySelector<HTMLElement>(".browse-row");
            if (row === null) throw new Error("missing shelf");
            const edge = row.getBoundingClientRect().right;
            const card = [...row.querySelectorAll<HTMLElement>(".browse-card[data-focus]")].find(item => {
                const box = item.getBoundingClientRect();
                return box.right > edge + 20 && box.left < edge - 60;
            });
            if (card === undefined) throw new Error("missing partly visible card");
            card.focus({ preventScroll: true });
            return card.getAttribute("data-focus");
        });
        assert.ok(key);
        await activate(tv, "mode:Collections");
        await tv.page.locator('[data-focus="collection:highlights"]').waitFor();
        await activate(tv, "mode:Browse");
        await tv.page.locator(`.browse-row [data-focus="${key}"]`).waitFor();
        await tv.jump(300);
        await settleFocusMotion(tv);
        assert.equal(await tv.focused(), key, "a clipped saved card keeps its identity while being revealed");
        assert.equal((await focusClip(tv)).inside, true);
    } finally { await tv.page.context().close(); }
});

test("a missing pending target does not prevent saving the next visit", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await signedIn(tv);
        await openLibrary(tv);
        for (let step = 0; step < 8; step++) await tv.remote(39);
        await tv.jump(300);
        await commitScroll(tv, 140);
        await activate(tv, "mode:Collections");
        await tv.page.locator('[data-focus="collection:highlights"]').waitFor();
        catalog.removed.add("movie:m0009");
        const before = tv.fake.requests.filter(request => request.path.startsWith("/library/12/sections")).length;
        const held = tv.fake.hold("/library/12/sections", true);
        await activate(tv, "mode:Browse");
        await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/library/12/sections")).length === before + 1, "pending restore dispatched");
        await tv.remote(39);
        held.release();
        const first = tv.page.locator('.browse-row [data-focus="movie:m0001"]').first();
        await first.waitFor();
        await first.focus();
        await tv.remote(39);
        await tv.jump(300);
        const committed = await commitScroll(tv, 100);
        await tv.remote(ENTER);
        await showing(tv, `item:${committed.key}`);
        await tv.remote(BACK);
        await showing(tv, "library:12");
        await tv.jump(300);
        assert.equal(await tv.focused(), committed.key);
        assert.deepEqual(await scrollOf(tv, committed.section), { top: committed.top, left: committed.left });
    } finally { await tv.page.context().close(); }
});

test("a removed library card falls back to a visible title", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await signedIn(tv);
        await openLibrary(tv);
        for (let step = 0; step < 4; step++) await tv.remote(39);
        await tv.jump(300);
        const key = await tv.focused();
        assert.equal(key, "movie:m0005");
        await tv.remote(ENTER);
        await showing(tv, "item:movie:m0005");
        await tv.page.locator('[data-focus="play"]').click();
        await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.plays.length) === 1, "playback handoff");
        catalog.removed.add("movie:m0005");
        await tv.page.evaluate(() => window.browseHarness.resume());
        await tv.page.locator('[data-focus="play"]').waitFor();
        const reads = tv.fake.requests.filter(request => request.path.startsWith("/library/12/sections")).length;
        const held = tv.fake.hold("/library/12/sections", true);
        await tv.remote(BACK);
        await showing(tv, "library:12");
        await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/library/12/sections")).length === reads + 1, "return refresh dispatched");
        await tv.remote(39);
        held.release();
        await tv.eventually(async () => await tv.page.locator('.browse [data-focus="movie:m0005"]').count() === 0, "removed card leaves the shelf");
        assert.notEqual(await tv.focused(), "movie:m0005");
        assert.equal(await visibleFocus(tv), true);
        for (let step = 0; step < 8; step++) await tv.remote(39);
        await tv.jump(300);
        const nextVisit = await commitScroll(tv, 100);
        await tv.remote(ENTER);
        await showing(tv, `item:${nextVisit.key}`);
        await tv.remote(BACK);
        await showing(tv, "library:12");
        await tv.jump(300);
        assert.equal(await tv.focused(), nextVisit.key, "a removed-card fallback can save a new visit");
        assert.deepEqual(await scrollOf(tv, nextVisit.section), { top: nextVisit.top, left: nextVisit.left });
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("settings, audio, calendar, filmography, personal and card actions keep visible focus", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = new SeamCatalog();
        const file = catalog.audioFiles.get("42");
        assert.ok(file);
        catalog.audioFiles.set("42", { ...file, audio: Array.from({ length: 16 }, (_, index) => ({ default: index === 0, language: "en", title: `Audio ${index + 1}` })) });
        await signedIn(tv, catalog);
        new FakeSettings(tv.fake);
        await tv.page.locator('[data-focus="profiles"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="seek-forward"]').click();
        for (let step = 0; step < 7; step++) await tv.page.keyboard.press("ArrowDown");
        await tv.jump(250);
        assert.equal(await tv.focused(), "seek-forward:90");
        assert.equal(await visibleFocus(tv), true, "settings selector reveals the focused choice");
        await tv.remote(BACK);
        await tv.remote(BACK);
        await tv.remote(BACK);
        await showing(tv, "home");
        const card = tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]');
        await card.focus();
        await tv.down(ENTER);
        await tv.jump(650);
        await tv.up(ENTER);
        await tv.page.getByRole("dialog", { name: "Card actions" }).waitFor();
        await tv.remote(BACK);
        assert.equal(await tv.focused(), "movie:m0001");
        assert.equal(await visibleFocus(tv), true, "card actions return focus to the visible card");
        await card.click();
        await showing(tv, "item:movie:m0001");
        await tv.page.locator('[data-focus="audio"]').click();
        for (let step = 0; step < 16; step++) await tv.remote(40);
        await tv.jump(250);
        assert.equal(await tv.focused(), "audio:15");
        assert.equal(await visibleFocus(tv), true, "audio overflow keeps the focused track visible");
        await tv.remote(BACK);
        assert.equal(await tv.focused(), "audio");
        await tv.page.locator('[data-focus="person:7"]').first().click();
        await tv.page.locator('[data-focus="see-all"]').waitFor();
        await tv.page.locator('[data-focus="see-all"]').click();
        await tv.page.locator(".browse-grid .browse-card").first().waitFor();
        await tv.remote(BACK);
        assert.equal(await tv.focused(), "see-all");
        assert.equal(await visibleFocus(tv), true, "filmography return keeps See all visible");
        await tv.remote(BACK);
        await tv.remote(BACK);
        await showing(tv, "home");
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.locator('[data-focus="watchlist"]').click();
        const personalCard = tv.page.locator('[data-view="personal:watchlist"] .browse-card').first();
        await personalCard.waitFor();
        const personal = await personalCard.getAttribute("data-focus");
        await personalCard.click();
        await tv.page.locator("[data-view^='item:']").waitFor();
        await tv.remote(BACK);
        await tv.eventually(async () => await tv.focused() === personal, "personal Details return");
        assert.equal(await visibleFocus(tv), true, "personal return keeps the card visible");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("calendar return keeps the focused event visible", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        tv.fake.catalog = new FakeCalendar();
        const cdp = await tv.page.context().newCDPSession(tv.page);
        await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "Australia/Melbourne" });
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase) === "signed_in", "sign-in");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount());
        await showing(tv, "home");
        await tv.page.locator('[data-focus="calendar"]').click();
        await showing(tv, "calendar");
        const event = tv.page.locator(".browse-card.calendar-event[data-focus]").first();
        await event.waitFor();
        const key = await event.getAttribute("data-focus");
        assert.equal(typeof key, "string");
        await event.click();
        await tv.page.locator("[data-view^='item:']").waitFor();
        await tv.remote(BACK);
        await showing(tv, "calendar");
        assert.equal(await tv.focused(), key);
        assert.equal(await visibleFocus(tv), true, "calendar return keeps the event visible");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});
