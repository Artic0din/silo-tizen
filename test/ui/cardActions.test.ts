import { selectLibraryMode } from "./support/library.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { homeDetailsRead, launchBrowser, openTv, pauseTvClock, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });
/** Signs in and mounts Home; `rows` gives the cards their server `user_state`, as Apple's menu reads it. */
async function start(tv: Tv, rows = true): Promise<FakeDetails> {
    const catalog = new FakeDetails();
    catalog.cardUserState = rows;
    tv.fake.catalog = catalog;
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.page.locator('[data-section="recently_added"] .browse-card').first().waitFor();
    await homeDetailsRead(tv);
    return catalog;
}
const origin = (tv: Tv, continuing = false, id = "movie:m0001") => tv.page.locator(`[data-section="${continuing ? "continue_watching" : "recently_added"}"] [data-focus="${id}"]`);
const menu = (tv: Tv) => tv.page.getByRole("menu");
const row = (tv: Tv, name: string) => menu(tv).getByRole("menuitem", { name, exact: true });
const rowLabels = (tv: Tv) => menu(tv).locator(".card-menu-label").allInnerTexts();
const homeReads = (tv: Tv) => tv.fake.requests.filter(request => request.path.startsWith("/home/sections?")).length;
async function hold(tv: Tv, continuing = false, id = "movie:m0001"): Promise<void> {
    await origin(tv, continuing, id).focus();
    await tv.down(13);
    await tv.jump(650);
    await tv.up(13);
}

test("a Home card menu opens at once from the row, in Apple's order, with no title", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        const before = tv.fake.requests.length;
        await hold(tv, true);
        await menu(tv).waitFor();
        assert.deepEqual(await rowLabels(tv), ["Resume", "Mark as Watched", "Add to Favorites", "Add to Watchlist", "Remove from Continue Watching"]);
        assert.equal(tv.fake.requests.length, before, "the menu reads nothing; the row already holds its state");
        assert.equal(await menu(tv).locator("h1, h2").count(), 0, "a tvOS context menu has no title");
        assert.equal(await menu(tv).locator(".card-menu-icon svg").count(), 5, "every row carries its symbol");
        assert.equal(await menu(tv).locator(".card-menu-destructive").innerText(), "Remove from Continue Watching");
        assert.equal(await tv.focused(), "card-play");
        await tv.remote(10009);
        assert.equal(await menu(tv).count(), 0);
        assert.equal(await tv.focused(), "movie:m0001");
        await hold(tv, false);
        assert.deepEqual(await rowLabels(tv), ["Mark as Watched", "Add to Favorites", "Add to Watchlist"], "only Continue Watching offers Play and Remove");
        await tv.remote(10009);
        await hold(tv, true, "episode:s1e12");
        assert.deepEqual(await rowLabels(tv), ["Play", "Mark as Unwatched", "Add to Favorites", "Add to Watchlist", "Remove from Next Up"], "an episode without a progress time is a Next Up dismissal");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

const lifted = (tv: Tv, continuing = false, id = "movie:m0001") => origin(tv, continuing, id).evaluate(node => node.classList.contains("card-menu-lifted"));
const rect = (tv: Tv, selector: string) => tv.page.locator(selector).first().evaluate(node => { const b = node.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; });

test("the open menu lifts its card's art as Apple's preview and places the platter beside it", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        const art = '[data-section="continue_watching"] [data-focus="movie:m0001"] .browse-art';
        await origin(tv, true).focus();
        await tv.jump(300);
        await tv.page.waitForTimeout(300);
        await hold(tv, true);
        await menu(tv).waitFor();
        await tv.page.waitForTimeout(400);
        assert.equal(await lifted(tv, true), true);
        // Live tvOS capture: lifted art (86, 663) 396 x 220; platter left ~509, top ~597.
        assert.deepEqual(await rect(tv, art), [86, 663, 396, 220]);
        const platter = await rect(tv, ".card-menu");
        assert.equal(platter[0], 509);
        assert.ok(Math.abs((platter[1] ?? 0) - 597) <= 2, `platter top ${platter[1]}`);
        assert.equal(await tv.page.locator(art).evaluate(node => getComputedStyle(node).outlineColor), "rgba(0, 0, 0, 0)", "no focus outline on the preview");
        const caption = await rect(tv, '[data-section="continue_watching"] [data-focus="movie:m0001"] .browse-card-title');
        assert.equal(caption[0], 80, "the caption does not move");
        await tv.remote(10009);
        assert.equal(await lifted(tv, true), false, "Back drops the lift");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("the lift ends on every close: a chosen row, a redraw that closes, and the alert", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await hold(tv);
        const answer = tv.fake.hold("/favorites/movie%3Am0001", true);
        await row(tv, "Add to Favorites").click();
        assert.equal(await lifted(tv), false, "choosing a row drops the lift");
        await tv.eventually(async () => catalog.mutations.length === 1, "favorite sent");
        await hold(tv);
        assert.equal(await lifted(tv), true);
        answer.release();
        await row(tv, "Remove from Favorites").waitFor();
        assert.equal(await lifted(tv), true, "a redraw keeps the lift");
        await tv.remote(10009);
        assert.equal(await lifted(tv), false);
        await hold(tv, true);
        const dismissal = tv.fake.hold("/home/dismissals/continue_watching/movie%3Am0001", true);
        await row(tv, "Remove from Continue Watching").click();
        await tv.eventually(async () => catalog.mutations.length === 2, "dismissal sent");
        await hold(tv, true);
        assert.equal(await lifted(tv, true), true);
        dismissal.release();
        await tv.eventually(async () => await menu(tv).count() === 0, "the landed Remove closes the menu");
        assert.equal(await tv.page.locator(".card-menu-lifted").count(), 0, "a redraw that closes drops the lift");
        await hold(tv);
        catalog.mutationFailure = problem(400, "validation_failed", "Not applied");
        const write = tv.fake.hold("/watched/movie%3Am0001", true);
        await row(tv, "Mark as Watched").click();
        await hold(tv);
        assert.equal(await lifted(tv), true);
        write.release();
        await tv.page.getByRole("alertdialog").waitFor();
        assert.equal(await tv.page.locator(".card-menu-lifted").count(), 0, "the alert drops the lift");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("the menu sits beside its card and moves only Up and Down", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        await hold(tv);
        const card = await origin(tv).boundingBox();
        const platter = await tv.page.locator(".card-menu").boundingBox();
        assert.ok(card !== null && platter !== null);
        assert.ok(platter.x >= card.x + card.width || platter.x + platter.width <= card.x, "the menu does not cover its card");
        assert.equal(await tv.focused(), "watched");
        await tv.remote(39);
        assert.equal(await tv.focused(), "watched", "Right stays on the row");
        await tv.remote(40);
        assert.equal(await tv.focused(), "favorites");
        await tv.remote(37);
        assert.equal(await tv.focused(), "favorites", "Left stays on the row");
        await tv.remote(40); await tv.remote(40);
        assert.equal(await tv.focused(), "watchlist", "Down stops at the last row");
        await tv.remote(38);
        assert.equal(await tv.focused(), "favorites");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
    for (const continuing of [false, true]) test(`card actions ${reducedMotion}: real Enter hold suppresses ${continuing ? "Continue playback" : "Details"} and release`, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            await tv.page.emulateMedia({ reducedMotion });
            const catalog = await start(tv);
            await origin(tv, continuing).focus();
            const before = tv.fake.requests.length;
            await tv.page.keyboard.down("Enter");
            assert.equal(await tv.page.locator('.browse').getAttribute("data-view"), "home", "first Enter default must be prevented");
            await tv.jump(400);
            await tv.down(13, false);
            await tv.jump(250);
            await menu(tv).waitFor({ timeout: 1500 });
            await tv.page.keyboard.up("Enter");
            await row(tv, "Mark as Watched").waitFor();
            assert.deepEqual(await tv.page.evaluate(() => window.browseHarness.plays), []);
            assert.deepEqual(catalog.mutations, []);
            assert.equal(tv.fake.requests.slice(before).filter(r => r.path.startsWith("/catalog/items/")).length, 0);
            await tv.remote(10009);
            assert.equal(await menu(tv).count(), 0, "modal Back precedes Skyline capture");
            assert.equal(await tv.focused(), "movie:m0001");
            await tv.page.keyboard.press("Enter");
            await tv.eventually(async () => await tv.page.locator('.browse').getAttribute("data-view") === "item:movie:m0001", "short Select opens Details on either row");
            assert.deepEqual(await tv.page.evaluate(() => window.browseHarness.plays), []);
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}

for (const reducedMotion of ["no-preference", "reduce"] as const) for (const cancel of ["arrow", "back", "blur", "hidden", "detach", "profile", "destroy"] as const) {
    test(`card hold ${reducedMotion}: ${cancel} cancels timer and short activation`, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            await tv.page.emulateMedia({ reducedMotion });
            await start(tv);
            await origin(tv).focus();
            const before = tv.fake.requests.length;
            assert.equal(await tv.down(13), true, "first Select is cancelled");
            await tv.jump(300);
            if (cancel === "arrow") await tv.remote(39);
            if (cancel === "back") await tv.remote(10009);
            if (cancel === "blur") await tv.page.evaluate(() => window.dispatchEvent(new Event("blur")));
            if (cancel === "hidden") await tv.page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
            if (cancel === "detach") await origin(tv).evaluate(node => node.replaceWith(node.cloneNode(true)));
            if (cancel === "profile") await tv.page.evaluate(() => window.browseHarness.clearProfile());
            if (cancel === "destroy") await tv.page.evaluate(() => window.browseHarness.destroy());
            await tv.jump(1000);
            await tv.up(13);
            assert.equal(await menu(tv).count(), 0);
            const detail = tv.fake.requests.slice(before).filter(request => request.path.startsWith("/catalog/items/"));
            const focused = await tv.focused();
            if (cancel === "arrow") {
                assert.ok(detail.length <= 1, "the cancelled hold adds no read; resting may read the card the arrow landed on");
                if (detail.length === 1 && focused !== null) assert.equal(detail[0]?.path.split("?")[0], `/catalog/items/${encodeURIComponent(focused)}`);
            } else assert.equal(detail.length, 0);
            assert.deepEqual(await tv.page.evaluate(() => window.browseHarness.plays), []);
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}

for (const reducedMotion of ["no-preference", "reduce"] as const) for (const repeat of [false, true]) {
    test(`opening hold repeats ${repeat} cannot activate the new menu in ${reducedMotion}`, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            await tv.page.emulateMedia({ reducedMotion });
            const catalog = await start(tv);
            await origin(tv).focus();
            await tv.page.keyboard.down("Enter");
            await tv.jump(650);
            await row(tv, "Mark as Watched").waitFor();
            assert.equal(await tv.focused(), "watched");
            await tv.down(13, repeat);
            assert.equal(await menu(tv).count(), 1, "the opening press still owns repeated Enter keydowns");
            assert.deepEqual(catalog.mutations, []);
            await tv.page.keyboard.up("Enter");
            assert.equal(await menu(tv).count(), 1, "the opening release cannot choose a row");
            await tv.page.keyboard.press("Enter");
            assert.equal(await menu(tv).count(), 0, "a fresh Select chooses the row and closes the menu");
            await tv.eventually(async () => catalog.mutations.length === 1, "watched sent");
            assert.deepEqual(catalog.mutations, ["POST /watched/movie%3Am0001"]);
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}

test("choosing a row closes the menu, sends the change, and rereads Home with focus kept", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await hold(tv);
        const reads = homeReads(tv);
        const answer = tv.fake.hold("/watched/movie%3Am0001", true);
        await row(tv, "Mark as Watched").click();
        assert.equal(await menu(tv).count(), 0, "the menu closes on selection, as tvOS does");
        assert.equal(await tv.focused(), "movie:m0001");
        await tv.eventually(async () => catalog.mutations.length === 1, "watched sent");
        await hold(tv);
        assert.deepEqual(await menu(tv).locator('[aria-disabled="true"]').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus"))), ["watched", "favorites", "watchlist"], "MediaStateMenuItems.disabled(isUpdating)");
        await row(tv, "Add to Favorites").dispatchEvent("click");
        await tv.remote(10009);
        assert.deepEqual(catalog.mutations, ["POST /watched/movie%3Am0001"], "one change per card at a time");
        answer.release();
        await tv.eventually(async () => homeReads(tv) === reads + 1, "Home rereads after the change");
        await tv.eventually(async () => await origin(tv).locator(".browse-watched").count() === 1, "the row shows the new state");
        assert.equal(await tv.focused(), "movie:m0001");
        await hold(tv);
        assert.deepEqual(await rowLabels(tv), ["Mark as Unwatched", "Add to Favorites", "Add to Watchlist"]);
        await row(tv, "Add to Favorites").click();
        await tv.eventually(async () => catalog.favorite, "favorite applied");
        await tv.eventually(async () => homeReads(tv) === reads + 2, "Home rereads after each change");
        await hold(tv);
        assert.deepEqual(await rowLabels(tv), ["Mark as Unwatched", "Remove from Favorites", "Add to Watchlist"]);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a menu reopened while its card's change is pending updates and re-enables when the change lands", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await hold(tv);
        const answer = tv.fake.hold("/favorites/movie%3Am0001", true);
        await row(tv, "Add to Favorites").click();
        await tv.eventually(async () => catalog.mutations.length === 1, "favorite sent");
        await hold(tv);
        await row(tv, "Add to Watchlist").focus();
        assert.equal(await row(tv, "Add to Favorites").getAttribute("aria-disabled"), "true");
        answer.release();
        await row(tv, "Remove from Favorites").waitFor();
        assert.equal(await menu(tv).locator('[aria-disabled="true"]').count(), 0, "the landed change re-enables the open menu");
        assert.equal(await tv.focused(), "watchlist", "the focused row keeps focus");
        await row(tv, "Add to Watchlist").click();
        await tv.eventually(async () => catalog.watchlist, "the re-enabled row sends its change");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a Select held on Resume while a pending change redraws the menu plays on release", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await hold(tv, true);
        const answer = tv.fake.hold("/favorites/movie%3Am0001", true);
        await row(tv, "Add to Favorites").click();
        await tv.eventually(async () => catalog.mutations.length === 1, "favorite sent");
        await hold(tv, true);
        const resume = menu(tv).locator('[data-focus="card-play"]');
        await resume.focus();
        const before = await resume.elementHandle();
        assert.ok(before);
        await tv.down(13);
        answer.release();
        await row(tv, "Remove from Favorites").waitFor();
        assert.equal(await before.evaluate(node => node.isConnected), false, "the landed change redrew the menu");
        assert.equal(await tv.focused(), "card-play");
        await tv.up(13);
        assert.equal(await menu(tv).count(), 0, "release chose the redrawn Resume");
        await tv.eventually(async () => (await tv.page.evaluate(() => window.browseHarness.plays)).length === 1, "Resume plays");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("reopening a card before Home rereads shows the change the server accepted", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await hold(tv);
        const reread = tv.fake.hold("/home/sections", true);
        await row(tv, "Add to Favorites").click();
        await tv.eventually(async () => catalog.favorite, "favorite applied");
        await tv.jump(300);
        await hold(tv);
        assert.deepEqual(await rowLabels(tv), ["Mark as Watched", "Remove from Favorites", "Add to Watchlist"], "the row's stale state does not offer the same change again");
        await tv.remote(10009);
        reread.release();
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Select on a disabled row leaves the menu answering later presses once it re-enables", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await hold(tv);
        const answer = tv.fake.hold("/favorites/movie%3Am0001", true);
        await row(tv, "Add to Favorites").click();
        await tv.eventually(async () => catalog.mutations.length === 1, "favorite sent");
        await hold(tv);
        await row(tv, "Add to Watchlist").focus();
        await tv.page.keyboard.press("Enter");
        assert.equal(await menu(tv).count(), 1, "a disabled row does not close the menu");
        // A press made on the disabled row stays inert even when the row re-enables before its release.
        await tv.page.keyboard.down("Enter");
        answer.release();
        await row(tv, "Remove from Favorites").waitFor();
        assert.equal(await row(tv, "Add to Watchlist").getAttribute("aria-disabled"), null);
        await tv.page.keyboard.up("Enter");
        assert.equal(await menu(tv).count(), 1, "the release of a press made while disabled chooses nothing");
        assert.equal(catalog.watchlist, false);
        await row(tv, "Add to Watchlist").focus();
        await tv.page.keyboard.press("Enter");
        assert.equal(await menu(tv).count(), 0, "a fresh Select chooses the re-enabled row");
        await tv.eventually(async () => catalog.watchlist, "watchlist applied");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a held Select on a disabled row cannot reach the screen when a landed Remove closes the menu", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await hold(tv, true);
        const answer = tv.fake.hold("/home/dismissals/continue_watching/movie%3Am0001", true);
        await row(tv, "Remove from Continue Watching").click();
        await tv.eventually(async () => catalog.mutations.length === 1, "dismissal sent");
        await hold(tv, true);
        await row(tv, "Remove from Continue Watching").focus();
        await tv.down(13);
        assert.equal(await menu(tv).count(), 1, "the disabled row keeps the menu open");
        answer.release();
        await tv.eventually(async () => await menu(tv).count() === 0, "the landed Remove closes the menu");
        for (let repeat = 0; repeat < 4; repeat++) { await tv.jump(200); await tv.down(13, true); }
        await tv.up(13);
        await tv.jump(700);
        assert.equal(await tv.page.locator(".browse").getAttribute("data-view"), "home", "the release did not open Details");
        assert.equal(await menu(tv).count(), 0, "the held repeats did not reopen a menu");
        assert.deepEqual(await tv.page.evaluate(() => window.browseHarness.plays), []);
        assert.equal(catalog.mutations.length, 1);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const where of ["chosen row", "open menu"] as const) test(`losing window focus while Select is held on the ${where} leaves the next Select fresh`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await hold(tv);
        if (where === "chosen row") {
            await row(tv, "Mark as Watched").focus();
            await tv.down(13);
            await tv.page.evaluate(() => window.dispatchEvent(new Event("blur")));
            await tv.up(13);
            assert.equal(await menu(tv).count(), 1, "a press that lost window focus chooses nothing on release");
            assert.equal(catalog.mutations.length, 0);
            await tv.page.keyboard.press("Enter");
            assert.equal(await menu(tv).count(), 0, "the first Select after return chooses the row");
            await tv.eventually(async () => catalog.mutations.length === 1, "watched sent");
        } else {
            const answer = tv.fake.hold("/favorites/movie%3Am0001", true);
            await row(tv, "Add to Favorites").click();
            await tv.eventually(async () => catalog.mutations.length === 1, "favorite sent");
            await hold(tv);
            await row(tv, "Add to Watchlist").focus();
            await tv.down(13);
            await tv.page.evaluate(() => window.dispatchEvent(new Event("blur")));
            answer.release();
            await row(tv, "Remove from Favorites").waitFor();
            await row(tv, "Add to Watchlist").focus();
            await tv.page.keyboard.press("Enter");
            assert.equal(await menu(tv).count(), 0, "the first Select after return chooses the row");
            await tv.eventually(async () => catalog.watchlist, "watchlist applied");
        }
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a row is chosen on Select's release, and that release cannot reach the card", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await hold(tv);
        await row(tv, "Mark as Watched").waitFor();
        await tv.down(13);
        await tv.page.evaluate(hidden => { Object.defineProperty(document, "hidden", { configurable: true, value: hidden }); document.dispatchEvent(new Event("visibilitychange")); }, true);
        await tv.up(13);
        await tv.page.evaluate(hidden => { Object.defineProperty(document, "hidden", { configurable: true, value: hidden }); document.dispatchEvent(new Event("visibilitychange")); }, false);
        assert.equal(await menu(tv).count(), 1, "a press the hidden page lost chooses nothing");
        assert.equal(catalog.mutations.length, 0);
        // Focus leaving the held row and coming back without a key ends the press too.
        await tv.down(13);
        await row(tv, "Add to Favorites").focus();
        await row(tv, "Mark as Watched").focus();
        await tv.up(13);
        assert.equal(await menu(tv).count(), 1, "a press whose focus left its row chooses nothing");
        for (const other of ["Tab", "Shift"]) {
            await tv.down(13);
            await tv.page.keyboard.press(other);
            await row(tv, "Mark as Watched").focus();
            await tv.up(13);
            assert.equal(await menu(tv).count(), 1, `${other} ended the held press, so its release chooses nothing`);
        }
        assert.equal(catalog.mutations.length, 0);
        await tv.down(13);
        for (let repeat = 0; repeat < 4; repeat++) { await tv.jump(200); await tv.down(13, true); }
        assert.equal(await menu(tv).count(), 1, "a held row waits for release");
        assert.equal(catalog.mutations.length, 0);
        await tv.up(13);
        assert.equal(await menu(tv).count(), 0, "release chose the row");
        await tv.jump(700);
        assert.equal(await tv.page.locator(".browse").getAttribute("data-view"), "home", "the release did not open Details");
        assert.equal(await menu(tv).count(), 0, "the held repeats did not reopen the menu");
        await tv.eventually(async () => catalog.mutations.length === 1, "watched sent");
        assert.deepEqual(catalog.mutations, ["POST /watched/movie%3Am0001"]);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const outcome of ["refused", "lost"] as const) test(`a ${outcome} change shows Apple's Couldn't Update Item alert and OK returns to the card`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await hold(tv);
        if (outcome === "refused") catalog.mutationFailure = problem(400, "validation_failed", "Not applied");
        else tv.fake.dropNextAnswer("/favorites/movie%3Am0001");
        const reads = homeReads(tv);
        await row(tv, "Add to Favorites").click();
        const alert = tv.page.getByRole("alertdialog", { name: "Couldn’t Update Item" });
        await alert.waitFor({ timeout: 35000 });
        assert.equal(await alert.locator(".signin-alert-text").innerText(), "The item could not be updated. Try again.");
        assert.deepEqual(await alert.getByRole("button").allInnerTexts(), ["OK"]);
        assert.equal(await tv.focused(), "card-alert-ok");
        await tv.remote(39);
        assert.equal(await tv.focused(), "card-alert-ok");
        assert.equal(homeReads(tv), reads, "the screen under the alert waits");
        await tv.page.keyboard.press("Enter");
        assert.equal(await alert.count(), 0);
        assert.equal(await tv.focused(), "movie:m0001");
        await tv.eventually(async () => homeReads(tv) === reads + 1, "an uncertain change rereads Home once the alert closes");
        assert.deepEqual(catalog.mutations, ["PUT /favorites/movie%3Am0001"], "the alert never resends");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a failure that lands while Settings is open waits and alerts once Settings closes", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await hold(tv);
        const answer = tv.fake.hold("/favorites/movie%3Am0001", true);
        catalog.mutationFailure = problem(400, "validation_failed", "Not applied");
        await row(tv, "Add to Favorites").click();
        await tv.eventually(async () => tv.fake.requests.some(r => r.path === "/favorites/movie%3Am0001"), "favorite sent");
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.locator('[data-focus="settings"]').click();
        await tv.page.locator('[data-focus="show-audiobooks"]').waitFor();
        answer.release();
        await tv.jump(500);
        assert.equal(await tv.page.getByRole("alertdialog").count(), 0, "the alert never stacks over another owner");
        await tv.remote(10009);
        await tv.page.locator('[data-view="home"]').waitFor();
        const alert = tv.page.getByRole("alertdialog", { name: "Couldn’t Update Item" });
        await alert.waitFor();
        assert.equal(await tv.focused(), "card-alert-ok");
        await tv.page.keyboard.press("Enter");
        assert.equal(await alert.count(), 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a pending Details change keeps the card menu's changes locked until it lands", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await origin(tv).click();
        await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
        const watchlist = tv.page.locator('.browse [data-focus="watchlist"]').first();
        await watchlist.waitFor({ timeout: 1500 });
        await tv.eventually(async () => await watchlist.getAttribute("aria-disabled") !== "true", "Details personal actions ready");
        const first = tv.fake.hold("/watchlist/movie%3Am0001", true);
        await watchlist.click();
        await tv.eventually(async () => catalog.mutations.length === 1, "Details write dispatched");
        const related = tv.page.locator('[data-detail-section="related"] [data-focus="movie:m0002"]');
        await related.focus(); await tv.down(13); await tv.jump(650); await tv.up(13);
        const watched = row(tv, "Mark as Watched");
        await watched.waitFor();
        assert.equal(await watched.getAttribute("aria-disabled"), "true", "Details' pending write disables the menu's changes");
        await watched.dispatchEvent("click");
        assert.deepEqual(catalog.mutations, ["PUT /watchlist/movie%3Am0001"]);
        first.release();
        await tv.eventually(async () => await row(tv, "Mark as Watched").getAttribute("aria-disabled") === null, "Details completion re-enables the open menu");
        await row(tv, "Mark as Watched").click();
        await tv.eventually(async () => catalog.mutations.length === 2, "menu write dispatched");
        assert.equal(catalog.mutations[1], "POST /watched/movie%3Am0002");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Back dismisses the failure alert too", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await hold(tv);
        catalog.mutationFailure = problem(400, "validation_failed", "Not applied");
        await row(tv, "Mark as Watched").click();
        await tv.page.getByRole("alertdialog").waitFor();
        await tv.remote(10009);
        assert.equal(await tv.page.getByRole("alertdialog").count(), 0);
        assert.equal(await tv.focused(), "movie:m0001");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const [id, surface, body] of [["movie:m0001", "continue_watching", { progress_updated_at: "2026-11-01T10:00:00.123456Z" }], ["episode:s1e12", "next_up", { series_id: "series:s1" }]] as const) test(`Remove takes ${id} off Continue Watching through ${surface}`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await hold(tv, true, id);
        await row(tv, surface === "next_up" ? "Remove from Next Up" : "Remove from Continue Watching").click();
        assert.equal(await menu(tv).count(), 0);
        await tv.eventually(async () => await origin(tv, true, id).count() === 0, "card left Continue Watching");
        assert.deepEqual(catalog.mutations, [`PUT /home/dismissals/${surface}/${encodeURIComponent(id)} ${JSON.stringify(body)}`]);
        assert.equal(await origin(tv, false, id).count(), 1, "other rows keep the title");
        assert.notEqual(await tv.focused(), null, "focus stays on the page after its card leaves");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("an accepted Remove keeps the card off Continue Watching when the reread fails", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await hold(tv, true);
        catalog.failNext("/home/sections", problem(400, "validation_failed", "Unavailable"));
        const reads = homeReads(tv);
        await row(tv, "Remove from Continue Watching").click();
        await tv.eventually(async () => homeReads(tv) >= reads + 1, "Home reread");
        await tv.jump(300);
        assert.equal(await origin(tv, true).count(), 0, "HomeViewModel removes the card before reconciling");
        assert.equal(await origin(tv, true, "episode:s1e12").count(), 1, "other cards stay");
        assert.equal(await origin(tv).count(), 1, "Recently Added keeps the title");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("an empty Home after a remembered feed shows only the empty state, with no stale marquee or item read", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        // Home loaded once, so the snapshot and the marquee both remember a card.
        await origin(tv, true).focus();
        await tv.jump(1000);
        await tv.page.locator(".skyline-marquee .skyline-title").first().waitFor();
        const household = catalog.households.get("p-owner");
        assert.ok(household);
        household.sections = [];
        // The remount shows the remembered rows and arms their marquee rest. On the running clock a slow runner lets that
        // rest read the card before the empty refresh lands; paused, it can fire only in the jump below, once Home is empty.
        await pauseTvClock(tv);
        const before = tv.fake.requests.length;
        await tv.page.evaluate(() => { window.browseHarness.destroy(); window.browseHarness.mount(); });
        await tv.page.locator(".home-empty").waitFor();
        await tv.jump(3000);
        assert.equal(await tv.page.locator(".skyline-marquee .skyline-title:visible").count(), 0, "Apple's empty Home shows no marquee");
        assert.equal(await tv.page.locator(".skyline-preview").count(), 0);
        assert.deepEqual(tv.fake.requests.slice(before).filter(r => r.path.startsWith("/catalog/items/")).map(r => r.path), [], "the remembered item is not read");
        assert.equal(await tv.focused(), "home-empty");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("an empty Home whose refresh fails shows the error, not the empty state", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        const household = catalog.households.get("p-owner");
        assert.ok(household);
        household.sections = [];
        await hold(tv);
        await row(tv, "Add to Favorites").click();
        await tv.page.locator(".home-empty").waitFor();
        // A change elsewhere marks Home stale; returning to it refreshes, and that refresh fails.
        await tv.page.locator('[data-focus="movies"]').click();
        const card = tv.page.locator('.browse[data-view="library:12"] .browse-card:not(.discovery-collection)').first();
        await card.waitFor();
        await card.focus(); await tv.down(13); await tv.jump(650); await tv.up(13);
        const mutations = catalog.mutations.length;
        await row(tv, "Mark as Watched").click();
        await tv.eventually(async () => catalog.mutations.length === mutations + 1, "library change sent");
        catalog.failNext("/home/sections", problem(400, "validation_failed", "Unavailable"));
        await tv.page.locator('[data-focus="home"]').click();
        await tv.page.locator('[data-view="home:failed"]').waitFor();
        assert.equal(await tv.page.locator(".home-empty").count(), 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a change answered after the profile changes is dropped without an alert", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        await hold(tv);
        const held = tv.fake.hold("/watched/movie%3Am0001", true);
        await row(tv, "Mark as Watched").click();
        await tv.eventually(async () => tv.fake.requests.some(r => r.path === "/watched/movie%3Am0001"), "held old-profile write");
        await tv.page.evaluate(() => window.browseHarness.clearProfile());
        held.release();
        await tv.jump(1000);
        assert.equal(await tv.page.getByRole("alertdialog").count(), 0);
        assert.equal(await tv.page.locator(".browse").count(), 0);
        assert.equal(await tv.page.locator("#successor").count(), 1);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("card actions pointer contextmenu shares the menu, plain left click retains its activation", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        await origin(tv).click({ button: "right" });
        await row(tv, "Add to Favorites").waitFor();
        await origin(tv).dispatchEvent("contextmenu");
        assert.equal(await menu(tv).count(), 1);
        await tv.remote(10009);
        await origin(tv).click();
        await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const surface of ["library-shelf", "library-grid", "collection", "search", "related", "person-preview", "season", "episode"] as const) test(`card quick-actions reach ${surface} and exclude navigation/input`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv, false);
        if (surface === "library-shelf" || surface === "library-grid" || surface === "collection") {
            await tv.page.locator('[data-focus="movies"]').click();
            await tv.page.locator('.browse[data-view="library:12"] .browse-card:not(.discovery-collection)').first().waitFor();
            if (surface === "library-grid") {
                await selectLibraryMode(tv, "Browse");
                await tv.page.locator('.browse .browse-grid .browse-card').first().waitFor();
            }
            if (surface === "collection") {
                await selectLibraryMode(tv, "Collections");
                const fan = tv.page.locator('.browse .discovery-collection').first();
                await fan.focus(); await tv.down(13); await tv.jump(700); await tv.up(13);
                assert.equal(await menu(tv).count(), 0);
                await fan.click();
                await tv.page.locator('.browse .browse-grid .browse-card').first().waitFor();
            }
        } else if (surface === "search") {
            await tv.page.locator('[data-focus="search"]').click();
            await tv.page.fill("#browse-search", "Movie");
            await tv.down(13); await tv.jump(700); await tv.up(13);
            assert.equal(await menu(tv).count(), 0);
            await tv.page.locator('.browse .browse-grid .browse-card').first().waitFor();
        } else {
            await tv.page.locator(`[data-section="recently_added"] [data-focus="${surface === "season" || surface === "episode" ? "series:s1" : "movie:m0001"}"]`).click();
            if (surface === "season" || surface === "episode") await tv.eventually(async () => await tv.focused() === "next-episode", "Series Play entry focus settles before targeting a chip or card");
            if (surface === "person-preview") {
                await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().click();
                await tv.page.locator('.browse[data-view="person:7"] .browse-grid .browse-card').first().waitFor();
            }
            if (surface === "episode") await tv.page.locator('[data-focus="season:1"]').click();
            if (surface === "related") await tv.page.locator('[data-detail-section="related"] .browse-card').first().waitFor();
        }
        const card = surface === "season" ? tv.page.locator('[data-focus="season:1"]') : surface === "episode" ? tv.page.locator('.details-episodes .browse-card').first() : surface === "related" ? tv.page.locator('.browse [data-detail-section="related"] .browse-card').first() : tv.page.locator('.browse .browse-card:not(.discovery-collection)').first();
        const id = surface === "season" ? "series:s1-S1" : await card.getAttribute("data-focus");
        const before = tv.fake.requests.length;
        await card.focus(); await tv.down(13); await tv.jump(650); await tv.up(13);
        await menu(tv).locator('[data-focus="watched"]').waitFor();
        const read = tv.fake.requests.slice(before).some(r => r.path.startsWith(`/catalog/items/${encodeURIComponent(id ?? "")}`));
        if (surface === "library-shelf") {
            // A library shelf is a SectionRow like Home's: it opens from the row, and these rows carry no user state.
            assert.equal(read, false);
            assert.deepEqual(await rowLabels(tv), ["Mark as Watched"]);
        } else {
            // A card the opener knows no list membership for reads its item once, then opens complete.
            assert.ok(read);
            // TVSeriesDetailView.swift:632-643: the season pill's menu is Mark Season Watched or Unwatched alone.
            if (surface === "season") assert.deepEqual(await rowLabels(tv), ["Mark Season Unwatched"]);
            else if (surface === "episode") assert.deepEqual(await rowLabels(tv), ["Episode information", "Mark as Unwatched", "Add to Favorites", "Add to Watchlist"], "an episode rail keeps its only route to episode Details");
            else assert.equal(await menu(tv).getByRole("menuitem").count(), 3);
        }
        await tv.remote(10009);
        assert.equal(await menu(tv).count(), 0);
        assert.equal(await tv.focused(), await card.getAttribute("data-focus"));
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a fresh Select while a card's item is still reading cannot activate the card underneath", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv, false);
        await tv.page.locator('[data-focus="movies"]').click();
        await tv.page.locator('.browse[data-view="library:12"] .browse-card:not(.discovery-collection)').first().waitFor();
        await selectLibraryMode(tv, "Browse");
        const card = tv.page.locator('.browse .browse-grid .browse-card').first();
        await card.waitFor();
        const id = await card.getAttribute("data-focus") ?? "";
        const read = tv.fake.hold(`/catalog/items/${encodeURIComponent(id)}`, true);
        await card.focus(); await tv.down(13); await tv.jump(650); await tv.up(13);
        await tv.eventually(async () => tv.fake.requests.some(r => r.path.startsWith(`/catalog/items/${encodeURIComponent(id)}`)), "item read held");
        const view = await tv.page.locator(".browse").getAttribute("data-view");
        await tv.page.keyboard.press("Enter");
        await tv.jump(700);
        assert.equal(await tv.page.locator(".browse").getAttribute("data-view"), view, "the card underneath did not open");
        assert.deepEqual(await tv.page.evaluate(() => window.browseHarness.plays), []);
        read.release();
        await menu(tv).waitFor();
        await tv.remote(10009);
        assert.equal(await tv.focused(), id);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a card whose item cannot be read shows the alert instead of an empty menu", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv, false);
        await tv.page.locator('[data-focus="movies"]').click();
        await tv.page.locator('.browse[data-view="library:12"] .browse-card:not(.discovery-collection)').first().waitFor();
        await selectLibraryMode(tv, "Browse");
        const card = tv.page.locator('.browse .browse-grid .browse-card').first();
        await card.waitFor();
        const id = await card.getAttribute("data-focus") ?? "";
        tv.fake.script(`/catalog/items/${encodeURIComponent(id)}?image_size=large`, problem(404, "not_found", "Not found"));
        await card.focus(); await tv.down(13); await tv.jump(650); await tv.up(13);
        await tv.page.getByRole("alertdialog", { name: "Couldn’t Update Item" }).waitFor();
        assert.equal(await menu(tv).count(), 0);
        await tv.page.keyboard.press("Enter");
        assert.equal(await tv.focused(), id);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const reducedMotion of ["no-preference", "reduce"] as const) test(`card actions ${reducedMotion} restore origin scroll and preserve navigation during late refresh`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await tv.page.emulateMedia({ reducedMotion });
        const catalog = await start(tv);
        const card = tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0011"]');
        await card.focus(); await tv.jump(300);
        const position = () => tv.page.locator('.browse').evaluate(node => ({ top: node.querySelector('.skyline-content')?.scrollTop, left: node.querySelector('[data-section="recently_added"] .browse-row')?.scrollLeft }));
        const saved = await position();
        assert.ok((saved.left ?? 0) > 0);
        await tv.down(13); await tv.jump(650); await tv.up(13);
        const held = tv.fake.hold("/home/sections", true);
        await row(tv, "Add to Favorites").click();
        await tv.eventually(async () => catalog.mutations.length === 1, "favorite sent");
        await tv.jump(300);
        assert.equal(await tv.focused(), "movie:m0011");
        assert.deepEqual(await position(), saved);
        await tv.page.locator('[data-focus="search"]').focus();
        held.release();
        await tv.eventually(async () => await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0011"]').count() === 1, "refreshed Home");
        await tv.jump(300);
        assert.equal(await tv.focused(), "search", "late Home answer cannot reclaim card focus");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const outcome of ["failed", "empty"] as const) test(`card actions ${outcome} origin refresh keeps Apple's Home states`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await hold(tv);
        if (outcome === "failed") catalog.failNext("/home/sections", problem(400, "validation_failed", "Unavailable"));
        else {
            const household = catalog.households.get("p-owner");
            assert.ok(household);
            household.sections = [];
        }
        const reads = homeReads(tv);
        await row(tv, "Add to Favorites").click();
        await tv.eventually(async () => homeReads(tv) === reads + 1, "Home reread");
        if (outcome === "failed") {
            await tv.jump(300);
            await origin(tv).waitFor();
            assert.equal(await tv.page.locator('.browse [data-focus="retry"]').count(), 0, "tvOS Home shows only the feed while it has rows");
            assert.equal(await tv.page.locator(".browse .browse-text").count(), 0, "no refresh status under the rows");
        } else {
            await tv.page.locator(".home-empty").waitFor();
            assert.equal(await tv.focused(), "home-empty");
        }
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a pending card change keeps Details' own personal writes locked", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await hold(tv);
        const held = tv.fake.hold("/watched/movie%3Am0001", true);
        await row(tv, "Mark as Watched").click();
        await tv.eventually(async () => catalog.mutations.length === 1, "menu write dispatched");
        await origin(tv).click();
        const watchlist = tv.page.locator('.browse [data-focus="watchlist"]').first();
        await watchlist.waitFor({ timeout: 1500 });
        await watchlist.dispatchEvent("click");
        assert.deepEqual(catalog.mutations, ["POST /watched/movie%3Am0001"], "the menu's pending write blocks the Details handler");
        held.release();
        await tv.eventually(async () => await watchlist.getAttribute("aria-disabled") !== "true", "completion unlocks Details");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

// Apple keeps a series' last season only on its cached page (TVItemDetailView.swift:169). A watched change from a card
// refreshes that page, which picks the season again (MediaCardWatchedSync.swift:15); a favorite only writes back its flag.
for (const action of ["Mark as Watched", "Add to Favorites"] as const) test(`after ${action} on a series card, Details ${action === "Mark as Watched" ? "picks its season again" : "keeps the season last viewed"}`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        const series = origin(tv, false, "series:s1");
        const opened = async (): Promise<void> => { await series.click(); await tv.eventually(async () => await tv.focused() === "next-episode", "Series Play entry focus settles"); };
        await opened();
        await tv.page.locator('[data-focus="season:2"]').focus(); await tv.jump(500);
        await tv.page.locator('[data-focus="season:2"][aria-pressed="true"]').waitFor();
        await tv.remote(10009);
        await opened();
        await tv.page.locator('[data-focus="season:2"][aria-pressed="true"]').waitFor();
        await tv.remote(10009);
        await hold(tv, false, "series:s1");
        await row(tv, action).click();
        await tv.eventually(async () => catalog.mutations.length === 1 && await menu(tv).count() === 0, "card change lands");
        await opened();
        const season = action === "Mark as Watched" ? 1 : 2;
        await tv.page.locator(`[data-focus="season:${season}"][aria-pressed="true"]`).waitFor();
        assert.equal(await tv.page.locator('.details-season[aria-pressed="true"], [data-focus^="season:"][aria-pressed="true"]').count(), 1);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

// A series page still in the stack is Apple's cached page too: the watched change refreshes it, so Back shows the season
// picked again (PersonalStateSync.swift:200-210, ItemDetailCache.swift:68-79, ItemDetailViewModel.swift:490-512).
test("a watched change from a card above a series page makes Back show the season picked again", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await origin(tv, false, "series:s1").click();
        await tv.eventually(async () => await tv.focused() === "next-episode", "Series Play entry focus settles");
        await tv.page.locator('[data-focus="season:2"]').focus(); await tv.jump(500);
        await tv.page.locator('[data-focus="season:2"][aria-pressed="true"]').waitFor();
        await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().click();
        const card = tv.page.locator('.browse[data-view="person:7"] [data-focus="series:s1"]').first();
        await card.waitFor();
        await card.focus(); await tv.down(13); await tv.jump(650); await tv.up(13);
        await row(tv, "Mark as Watched").click();
        await tv.eventually(async () => catalog.mutations.length === 1 && await menu(tv).count() === 0, "watched change lands");
        await tv.remote(10009);
        await tv.page.locator('[data-focus="season:1"][aria-pressed="true"]').waitFor();
        assert.equal(await tv.page.locator('[data-focus^="season:"][aria-pressed="true"]').count(), 1);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("leaving a retained series page before its reread lands still picks the season again on the next visit", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        const series = origin(tv, false, "series:s1");
        await series.click();
        await tv.eventually(async () => await tv.focused() === "next-episode", "Series Play entry focus settles");
        await tv.page.locator('[data-focus="season:2"]').focus(); await tv.jump(500);
        await tv.page.locator('[data-focus="season:2"][aria-pressed="true"]').waitFor();
        await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().click();
        const card = tv.page.locator('.browse[data-view="person:7"] [data-focus="series:s1"]').first();
        await card.waitFor();
        await card.focus(); await tv.down(13); await tv.jump(650); await tv.up(13);
        await row(tv, "Mark as Watched").click();
        await tv.eventually(async () => catalog.mutations.length === 1 && await menu(tv).count() === 0, "watched change lands");
        const reread = tv.fake.hold("/catalog/items/series%3As1", true);
        await tv.remote(10009);
        await tv.page.locator('.browse[data-view="item:series:s1"]').waitFor();
        await tv.remote(10009);
        await series.waitFor();
        reread.release();
        await series.click();
        await tv.page.locator('[data-focus="season:1"][aria-pressed="true"]').waitFor();
        assert.equal(await tv.page.locator('[data-focus^="season:"][aria-pressed="true"]').count(), 1);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

// ItemDetailCache.swift:34: a Favorite change keeps Apple's cached series page, so the page and its season still leave
// after 20 other pages.
test("after a favorite change, a remembered season still ends once 20 other title pages open", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        const series = origin(tv, false, "series:s1");
        await series.click();
        await tv.eventually(async () => await tv.focused() === "next-episode", "Series Play entry focus settles");
        await tv.page.locator('[data-focus="season:2"]').focus(); await tv.jump(500);
        await tv.page.locator('[data-focus="season:2"][aria-pressed="true"]').waitFor();
        await tv.remote(10009);
        await hold(tv, false, "series:s1");
        await row(tv, "Add to Favorites").click();
        await tv.eventually(async () => catalog.mutations.length === 1 && await menu(tv).count() === 0, "favorite change lands");
        await tv.page.locator('[data-focus="movies"]').click();
        await tv.page.locator('.browse[data-view="library:12"] .browse-card:not(.discovery-collection)').first().waitFor();
        await selectLibraryMode(tv, "Browse");
        const grid = tv.page.locator('.browse .browse-grid .browse-card');
        await grid.first().waitFor();
        for (let index = 0; index < 20; index++) {
            const card = grid.nth(index);
            const id = await card.getAttribute("data-focus");
            await card.click();
            await tv.page.locator(`.browse[data-view="item:${id}"]`).waitFor();
            await tv.remote(10009);
            await grid.first().waitFor();
        }
        await tv.page.locator('[data-focus="home"]').click();
        await series.click();
        await tv.page.locator('[data-focus="season:1"][aria-pressed="true"]').waitFor();
        assert.equal(await tv.page.locator('[data-focus^="season:"][aria-pressed="true"]').count(), 1);
    } finally { await tv.page.context().close(); }
});

// TVItemDetailView.swift:166-170: Apple's cached page keeps its season however the visit ends, including a related
// title replacing it.
test("a series page replaced by a related title keeps its season for the next visit", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        await tv.page.route("**/api/v2/recommendations/similar/movie%3Am0001**", route => route.fulfill({ json: { items: [{ content_id: "series:s1", type: "series", title: "Harbor Lights" }, ...Array.from({ length: 11 }, (_, index) => ({ content_id: `movie:m${String(index + 2).padStart(4, "0")}`, type: "movie", title: `Movie ${String(index + 2).padStart(4, "0")}` }))] } }));
        await origin(tv).click();
        const related = tv.page.locator('.browse[data-view="item:movie:m0001"] [data-detail-section="related"] [data-focus="series:s1"]');
        await related.waitFor();
        await related.click();
        await tv.eventually(async () => await tv.focused() === "next-episode", "Series Play entry focus settles");
        await tv.page.locator('[data-focus="season:2"]').focus(); await tv.jump(500);
        await tv.page.locator('[data-focus="season:2"][aria-pressed="true"]').waitFor();
        const next = tv.page.locator('.browse[data-view="item:series:s1"] [data-detail-section="related"] .browse-card[data-focus^="movie:"]').first();
        await next.waitFor();
        const replacement = await next.getAttribute("data-focus");
        await next.click();
        await tv.page.locator(`.browse[data-view="item:${replacement}"]`).waitFor();
        await tv.remote(10009);
        await tv.page.locator('.browse[data-view="item:movie:m0001"]').waitFor();
        await tv.remote(10009);
        await origin(tv, false, "series:s1").click();
        await tv.page.locator('[data-focus="season:2"][aria-pressed="true"]').waitFor();
        assert.equal(await tv.page.locator('[data-focus^="season:"][aria-pressed="true"]').count(), 1);
    } finally { await tv.page.context().close(); }
});
