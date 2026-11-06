import { selectLibraryMode } from "./support/library.ts";
// Browse focus and scroll parity. Desktop Chromium is not the TV's Chromium 108.

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
        if (method === "GET" && path.startsWith("/watchlist?")) {
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

async function focusClip(tv: Tv): Promise<{ key: string; transform: string; inside: boolean; scale: number; artGrowth: number; captionClearance: number; border: string; clippedBy: string[] }> {
    return tv.page.evaluate(() => {
        const card = document.activeElement;
        if (!(card instanceof HTMLElement) || !card.classList.contains("browse-card")) throw new Error("focused browse card missing");
        const transform = getComputedStyle(card).transform;
        const art = card.querySelector<HTMLElement>(".browse-art");
        const caption = card.querySelector<HTMLElement>(".browse-card-title");
        if (art === null || caption === null) throw new Error("card artwork or caption missing");
        const rect = art.getBoundingClientRect();
        let inside = true;
        const clippedBy: string[] = [];
        for (let node: HTMLElement | null = card; node !== null; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (!/hidden|clip|auto|scroll/.test(`${style.overflowX} ${style.overflowY}`)) continue;
            const bounds = node.getBoundingClientRect();
            if (bounds.width === 0 || bounds.height === 0) continue;
            if (rect.left < bounds.left - 0.5 || rect.top < bounds.top - 0.5 || rect.right > bounds.right + 0.5 || rect.bottom > bounds.bottom + 0.5) {
                inside = false;
                clippedBy.push(`${node.className}: art ${rect.x},${rect.y},${rect.right},${rect.bottom}; clip ${bounds.x},${bounds.y},${bounds.right},${bounds.bottom}`);
            }
        }
        const matrix = /^matrix\(([^)]+)\)$/.exec(transform)?.[1]?.split(",").map(part => Number(part.trim())) ?? [];
        const scale = matrix.length === 6 ? matrix[0] ?? 1 : transform === "none" ? 1 : Number.NaN;
        return { key: card.getAttribute("data-focus") ?? "", transform, inside, scale, artGrowth: rect.height - art.offsetHeight, captionClearance: caption.getBoundingClientRect().top - rect.bottom, border: getComputedStyle(card).borderTopWidth === "0px" ? "rgba(0, 0, 0, 0)" : getComputedStyle(card).borderTopColor, clippedBy };
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
    test(`returning up between library shelves keeps artwork inside ${reducedMotion}`, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            await tv.page.emulateMedia({ reducedMotion });
            const catalog = new FakeCatalog();
            const household = catalog.households.get("p-owner");
            assert.ok(household);
            household.librarySections = [
                { id: "first", title: "First shelf", items: ["movie:m0001"] },
                { id: "second", title: "Second shelf", items: ["movie:m0004"] },
            ];
            await signedIn(tv, catalog);
            await openLibrary(tv);
            assert.equal(await tv.page.locator('[data-focus="collection:highlights"]').count(), 0);
            await tv.remote(40);
            assert.equal(await tv.focused(), "movie:m0004");
            await tv.jump(300);
            await tv.remote(38);
            await tv.jump(300);
            await settleFocusMotion(tv);
            assert.equal(await tv.focused(), "movie:m0001");
            const focused = await focusClip(tv);
            assert.equal(focused.inside, true, focused.clippedBy.join("; "));
            await selectLibraryMode(tv, "Collections");
            await tv.eventually(async () => await tv.focused() === "collection:highlights", "separate Collections page");
            await selectLibraryMode(tv, "Recommended");
            await tv.eventually(async () => await tv.focused() === "movie:m0001", "return to Recommended");
            await tv.jump(300);
            await settleFocusMotion(tv);
            const returned = await focusClip(tv);
            assert.equal(returned.inside, true, returned.clippedBy.join("; "));
        } finally { await tv.page.context().close(); }
    });
    test(`library shelf focus keeps captions and edge artwork clear ${reducedMotion}`, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            await tv.page.emulateMedia({ reducedMotion });
            await signedIn(tv);
            await openLibrary(tv);
            await tv.jump(300);
            const titles = await tv.page.locator('.home-section .browse-card:not(.skyline-explore)').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus") ?? ""));
            await tv.eventually(async () => titles.every(id => tv.fake.requests.some(request => request.path.split("?")[0] === `/catalog/items/${encodeURIComponent(id)}`)), "Recommended enrichment queue dispatched");
            const reads = tv.fake.requests.length;
            for (const moves of [0, 19]) {
                for (let step = 0; step < moves; step++) await tv.remote(39);
                await tv.jump(300);
                await settleFocusMotion(tv);
                const focused = await focusClip(tv);
                assert.equal(focused.inside, true, focused.clippedBy.join("; "));
                assert.ok(focused.captionClearance >= 7.5);
                const style = await tv.page.evaluate(() => {
                    const card = document.activeElement;
                    const art = card?.querySelector(".browse-art");
                    const title = card?.querySelector(".browse-card-title");
                    const neighbor = card?.parentElement?.querySelector(".browse-card:not(:focus) .browse-card-title");
                    if (art == null || title == null || neighbor == null) throw new Error("shelf captions missing");
                    const captions = [...card?.querySelectorAll(".browse-card-title, .browse-card-subtitle") ?? []];
                    return {
                        focused: getComputedStyle(title).color, unfocused: getComputedStyle(neighbor).color, cue: getComputedStyle(art).outline, shadow: getComputedStyle(art).boxShadow,
                        captions: captions.map(node => {
                            const style = getComputedStyle(node), matrix = new DOMMatrixReadOnly(style.transform);
                            return { linear: [matrix.a, matrix.b, matrix.c, matrix.d], scale: style.scale };
                        }),
                        transitions: [art, ...captions].map(node => getComputedStyle(node).transitionDuration),
                    };
                });
                assert.equal(style.focused, "rgb(255, 255, 255)");
                assert.equal(style.unfocused, "rgba(237, 237, 237, 0.45)");
                for (const caption of style.captions) {
                    assert.deepEqual(caption.linear, [1, 0, 0, 1], "captions translate without scaling");
                    assert.equal(caption.scale, "none", "captions have no independent scale");
                }
                if (reducedMotion === "reduce") {
                    assert.equal(focused.artGrowth, 0);
                    assert.equal(style.cue, "rgba(255, 255, 255, 0.7) solid 4px", "reduced motion keeps Apple's shared outline");
                    assert.equal(style.shadow, "rgba(0, 0, 0, 0.45) 0px 8px 36px 0px", "reduced motion retains the focused shadow");
                    assert.deepEqual(style.transitions, ["0s", "0s", "0s"], "reduced motion disables artwork and caption transitions");
                }
            }
            assert.equal(tv.fake.requests.length, reads, "shelf focus movement makes no requests");
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });

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
                assert.equal(entry.transform, "none", "the shelf button and its caption do not scale");
                assert.ok(Math.abs(entry.artGrowth - 13.2) < 1, `artwork alone gains 5% of its 264px height (${entry.artGrowth})`);
                assert.equal(entry.inside, true, `normal-motion artwork stays inside the clip on entry: ${entry.clippedBy.join("; ")}`);
            }
            assert.equal(entry.border, "rgba(0, 0, 0, 0)", "the button has no visible border");
            assert.ok(entry.captionClearance >= 7.5, "caption stays below the lifted artwork");
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
            // Keep the smaller shared row fully inside while testing a non-default scroll.
            const fitted = await commitScroll(tv, 20);
            assert.equal((await focusClip(tv)).inside, true, "setup fully contains the artwork");
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
            else {
                assert.equal(afterReturn.transform, "none");
                assert.ok(Math.abs(afterReturn.artGrowth - 13.2) < 1);
            }
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
        await selectLibraryMode(tv, "Collections");
        await tv.page.locator('[data-focus="collection:highlights"]').waitFor();
        assert.equal(await tv.page.locator(".browse").getAttribute("data-view"), "library:12", "mode changes keep the public library view id");
        assert.notEqual(await tv.focused(), committed.key);
        assert.equal((await scrollOf(tv, committed.section)).top, 0);
        await selectLibraryMode(tv, "Genres");
        await tv.page.locator('[data-focus="genre:Drama"]').waitFor();
        await tv.remote(39);
        assert.equal(await tv.focused(), "genre:Comedy");
        await selectLibraryMode(tv, "Recommended");
        await tv.page.locator(`[data-focus="${committed.key}"]`).waitFor();
        await tv.jump(300);
        assert.equal(await tv.focused(), committed.key, "Browse visit focus");
        assert.deepEqual(await scrollOf(tv, committed.section), { top: committed.top, left: committed.left });
        assert.equal(await tv.page.locator(".browse").getAttribute("data-view"), "library:12");
        await selectLibraryMode(tv, "Genres");
        await tv.eventually(async () => await tv.focused() === "genre:Comedy", "Genres visit focus");
        assert.equal(await tv.page.locator(".browse").getAttribute("data-view"), "library:12");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const reducedMotion of ["no-preference", "reduce"] as const) test(`pointer-selected shelf cards are fully revealed on Back ${reducedMotion}`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await tv.page.emulateMedia({ reducedMotion });
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

for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`returning from Home enters library content ${reducedMotion}`, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            await tv.page.emulateMedia({ reducedMotion });
            await signedIn(tv);
            await openLibrary(tv);
            await tv.page.locator('[data-focus="home"]').focus();
            await tv.page.keyboard.press("Enter");
            await showing(tv, "home");
            await tv.page.locator('[data-focus="movies"]').focus();
            await tv.page.keyboard.press("Enter");
            await showing(tv, "library:12");
            assert.equal(await tv.focused(), "movie:m0001", "default entry targets content, not the departing Home control");
            await tv.remote(ENTER);
            await showing(tv, "item:movie:m0001");
        } finally { await tv.page.context().close(); }
    });

    test(`an offscreen grid card remains revealed after Back ${reducedMotion}`, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            await tv.page.emulateMedia({ reducedMotion });
            await signedIn(tv);
            await openLibrary(tv);
            await selectLibraryMode(tv, "Recently Added");
            const card = tv.page.locator(".browse-grid .browse-card[data-focus]").last();
            await card.waitFor();
            await tv.jump(300);
            const key = await card.evaluate(node => {
                if (!(node instanceof HTMLElement)) throw new Error("missing grid card");
                const viewport = node.closest<HTMLElement>(".skyline-content");
                if (viewport === null) throw new Error("missing grid viewport");
                viewport.scrollTop = 0;
                node.focus({ preventScroll: true });
                return node.getAttribute("data-focus");
            });
            assert.ok(key);
            assert.equal(await visibleFocus(tv), false, "setup leaves the selected grid card offscreen");
            await tv.remote(ENTER);
            await showing(tv, `item:${key}`);
            await tv.remote(BACK);
            await showing(tv, "library:12");
            await tv.jump(300);
            await settleFocusMotion(tv);
            assert.equal(await tv.focused(), key);
            assert.equal((await focusClip(tv)).inside, true, "return does not undo the grid reveal");
        } finally { await tv.page.context().close(); }
    });
}

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
        await selectLibraryMode(tv, "Collections");
        await tv.page.locator('[data-focus="collection:highlights"]').waitFor();
        const before = tv.fake.requests.filter(request => request.path.startsWith("/library/12/sections")).length;
        const held = tv.fake.hold("/library/12/sections", true);
        await selectLibraryMode(tv, "Recommended");
        await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/library/12/sections")).length === before + 1, "Browse restore read dispatched");
        if (destination === "mode") {
            await selectLibraryMode(tv, "Genres");
            await tv.page.locator('[data-focus="genre:Drama"]').waitFor();
            held.release();
            await selectLibraryMode(tv, "Recommended");
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
        await selectLibraryMode(tv, "Genres");
        await tv.page.locator('[data-focus="genre:Drama"]').waitFor();
        await selectLibraryMode(tv, "Recommended");
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
        await selectLibraryMode(tv, "Collections");
        await tv.page.locator('[data-focus="collection:highlights"]').waitFor();
        await selectLibraryMode(tv, "Recommended");
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
        await selectLibraryMode(tv, "Collections");
        await tv.page.locator('[data-focus="collection:highlights"]').waitFor();
        catalog.removed.add("movie:m0009");
        const before = tv.fake.requests.filter(request => request.path.startsWith("/library/12/sections")).length;
        const held = tv.fake.hold("/library/12/sections", true);
        await selectLibraryMode(tv, "Recommended");
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
        const settings = new FakeSettings(tv.fake);
        settings.remainingRows = true;
        await tv.page.locator('[data-focus="profiles"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await tv.page.locator('[data-focus="subtitles"]').click();
        await tv.page.locator('[data-focus="appearance-textOpacity"]').click();
        for (let step = 0; step < 19; step++) await tv.page.keyboard.press("ArrowUp");
        for (let step = 0; step < 19; step++) await tv.page.keyboard.press("ArrowDown");
        await tv.jump(250);
        assert.equal(await tv.focused(), "choice:100");
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
        await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().click();
        const personCard = tv.page.locator(".browse-grid .browse-card").first();
        await personCard.waitFor();
        const personId = await personCard.getAttribute("data-focus");
        await personCard.click();
        await tv.page.locator(".details-hero").waitFor();
        await tv.remote(BACK);
        assert.equal(await tv.focused(), personId);
        assert.equal(await visibleFocus(tv), true, "Person return keeps its card visible");
        await tv.remote(BACK);
        assert.match(await tv.focused() ?? "", /^credit:7:/);
        await tv.remote(BACK);
        await showing(tv, "home");
        await tv.page.locator('[data-focus="for_you"]').focus(); await tv.remote(40);
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
        const reads = tv.fake.requests.filter(request => request.path.startsWith("/calendar?")).length;
        await tv.page.keyboard.press("ArrowUp");
        assert.equal(await tv.focused(), "day:2026-01-02", "shelf return preserves the selected date instead of changing it on card focus");
        assert.equal(await visibleFocus(tv), true, "selected strip day remains visible above the shelf");
        for (let index = 0; index < 5; index++) await tv.page.keyboard.press("ArrowLeft");
        assert.equal(await tv.focused(), "previous-week");
        assert.equal(await visibleFocus(tv), true, "the strip chevron has visible focus");
        assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/calendar?")).length, reads);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});
