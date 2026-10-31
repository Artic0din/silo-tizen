import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { fixture, problem } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });
async function start(tv: Tv, catalog = new FakeDetails()): Promise<FakeDetails> {
    tv.fake.catalog = catalog;
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.page.locator('[data-section="recently_added"] .browse-card').first().waitFor();
    return catalog;
}
const origin = (tv: Tv, continuing = false) => tv.page.locator(`[data-section="${continuing ? "continue_watching" : "recently_added"}"] [data-focus="movie:m0001"]`);
const menu = (tv: Tv) => tv.page.getByRole("dialog", { name: "Card actions" });
async function hold(tv: Tv, continuing = false): Promise<void> {
    await origin(tv, continuing).focus();
    await tv.down(13);
    await tv.jump(650);
    await tv.up(13);
}
for (const reducedMotion of ["no-preference", "reduce"] as const) {
    for (const continuing of [false, true]) test(`card actions ${reducedMotion}: real Enter hold suppresses ${continuing ? "Continue playback" : "Details"} and release`, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            await tv.page.emulateMedia({ reducedMotion });
            await start(tv);
            await origin(tv, continuing).focus();
            await tv.page.keyboard.down("Enter");
            assert.equal(await tv.page.locator('.browse').getAttribute("data-view"), "home", "first Enter default must be prevented");
            await tv.jump(400);
            await tv.down(13, false);
            await tv.jump(250);
            await menu(tv).waitFor({ timeout: 1500 });
            await tv.page.keyboard.up("Enter");
            await menu(tv).getByRole("button", { name: "Mark watched", exact: true }).waitFor();
            assert.deepEqual(await tv.page.evaluate(() => window.browseHarness.plays), []);
            assert.deepEqual((tv.fake.catalog as FakeDetails).mutations, []);
            assert.equal(tv.fake.requests.filter(r => r.path.startsWith("/catalog/items/")).length, 1);
            assert.equal(tv.fake.requests.filter(r => /recommendations|settings\/contract/.test(r.path)).length, 0, "personal startup skips unrelated reads");
            await tv.remote(10009);
            assert.equal(await menu(tv).count(), 0, "modal Back precedes Skyline capture");
            assert.equal(await tv.focused(), "movie:m0001");
            await tv.page.keyboard.press("Enter");
            await tv.eventually(async () => continuing ? await tv.page.evaluate(() => window.browseHarness.plays.length === 1) : await tv.page.locator('.browse').getAttribute("data-view") === "item:movie:m0001", "one short activation");
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}

test("card actions confirm watched, refresh the Home origin and lock every action while pending", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await hold(tv);
        await menu(tv).getByRole("button", { name: "Mark watched", exact: true }).waitFor();
        const answer = tv.fake.hold("/watched/movie%3Am0001", true);
        await menu(tv).getByRole("button", { name: "Mark watched", exact: true }).click();
        await menu(tv).getByRole("button", { name: "Add favorite", exact: true }).dispatchEvent("click");
        await menu(tv).getByRole("button", { name: "Add to watchlist", exact: true }).dispatchEvent("click");
        assert.deepEqual(catalog.mutations, ["POST /watched/movie%3Am0001"]);
        answer.release();
        await menu(tv).getByRole("button", { name: "Mark unwatched", exact: true }).waitFor();
        const homeReads = tv.fake.requests.filter(r => r.path.startsWith("/home/sections?")).length;
        await tv.remote(10009);
        await tv.eventually(async () => tv.fake.requests.filter(r => r.path.startsWith("/home/sections?")).length === homeReads + 1, "actual Home refresh");
        assert.equal(await tv.focused(), "movie:m0001");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("card actions retain an uncertain watched target across close/reopen and read before Retry", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await hold(tv);
        await menu(tv).getByRole("button", { name: "Mark watched", exact: true }).waitFor();
        tv.fake.dropNextAnswer("/watched/movie%3Am0001");
        await menu(tv).getByRole("button", { name: "Mark watched", exact: true }).click();
        await menu(tv).getByRole("button", { name: "Retry watched", exact: true }).waitFor();
        await tv.remote(10009);
        await hold(tv);
        await menu(tv).getByRole("button", { name: "Retry watched", exact: true }).click();
        await menu(tv).getByRole("button", { name: "Mark unwatched", exact: true }).waitFor();
        assert.deepEqual(catalog.mutations, ["POST /watched/movie%3Am0001"]);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const reducedMotion of ["no-preference", "reduce"] as const) for (const cancel of ["arrow", "back", "blur", "hidden", "detach", "profile", "destroy"] as const) {
    test(`card hold ${reducedMotion}: ${cancel} cancels timer and short activation`, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            await tv.page.emulateMedia({ reducedMotion });
            await start(tv);
            await origin(tv).focus();
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
            assert.equal(tv.fake.requests.filter(r => r.path.startsWith("/catalog/items/")).length, 0);
            assert.deepEqual(await tv.page.evaluate(() => window.browseHarness.plays), []);
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}

test("card actions pointer contextmenu shares the menu, plain left click retains its activation", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        await origin(tv).click({ button: "right" });
        await menu(tv).getByRole("button", { name: "Add favorite", exact: true }).waitFor();
        await origin(tv).dispatchEvent("contextmenu");
        assert.equal(await menu(tv).count(), 1);
        assert.equal(tv.fake.requests.filter(r => r.path.startsWith("/catalog/items/")).length, 1);
        await menu(tv).getByRole("button", { name: "Close", exact: true }).click();
        await origin(tv).click();
        await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("card actions initial loading, bad identity and Retry keep Close reachable without invented state", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        const answer = tv.fake.hold("/catalog/items/movie%3Am0001", true);
        await hold(tv);
        await menu(tv).getByText("Loading card actions.").waitFor();
        await tv.remote(10009);
        answer.release();
        await tv.jump(0);
        assert.equal(await menu(tv).count(), 0);
        tv.fake.script("/catalog/items/movie%3Am0001?image_size=medium", { status: 200, body: { ...fixture("get_catalog_item_ok"), content_id: "movie:wrong" } });
        await hold(tv);
        await menu(tv).getByText("Could not load card actions.").waitFor();
        assert.equal(await menu(tv).getByRole("button").count(), 2);
        await menu(tv).getByRole("button", { name: "Try again", exact: true }).click();
        await menu(tv).getByRole("button", { name: "Mark watched", exact: true }).waitFor();
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const answer of ["unsupported", "unknown", "malformed", "membership-mismatch"] as const) test(`card actions ${answer} never invents mutation values`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        if (answer === "unsupported") catalog.capability = false;
        if (answer === "malformed") tv.fake.script("/capabilities/personal-lists", { status: 200, body: {} });
        if (answer === "membership-mismatch") tv.fake.script("/favorites/movie%3Am0001/membership", { status: 200, body: { item_id: "movie:wrong", is_member: false } });
        if (answer === "unknown") tv.fake.script("/catalog/items/movie%3Am0001?image_size=medium", { status: 200, body: { ...fixture("get_catalog_item_ok"), content_id: "movie:m0001", user_state: undefined, user_data: undefined } });
        await hold(tv);
        if (answer === "unsupported") await menu(tv).getByText("List actions are unavailable for this title.").waitFor();
        if (answer === "malformed" || answer === "membership-mismatch") {
            await menu(tv).getByRole("button", { name: "Retry personal actions", exact: true }).waitFor();
            assert.equal(await menu(tv).getByRole("button", { name: "Add favorite", exact: true }).count(), 0);
            await menu(tv).getByRole("button", { name: "Retry personal actions", exact: true }).click();
            await menu(tv).getByRole("button", { name: "Add favorite", exact: true }).waitFor();
        }
        if (answer === "unknown") {
            await menu(tv).getByText("Watched state is unavailable.").waitFor();
            assert.equal(await menu(tv).locator('[data-focus="watched"]').count(), 0);
        }
        assert.deepEqual(catalog.mutations, []);
        await tv.remote(10009);
        assert.equal(await menu(tv).count(), 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const path of ["/catalog/items/movie%3Am0001", "/capabilities/personal-lists", "/favorites/movie%3Am0001/membership", "/watched/movie%3Am0001"]) test(`card actions rejects old authority answer from ${path}`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        const held = tv.fake.hold(path, true);
        await hold(tv);
        if (path.startsWith("/watched/")) await menu(tv).getByRole("button", { name: "Mark watched", exact: true }).click();
        await tv.eventually(async () => tv.fake.requests.some(r => r.path.split("?")[0] === path), "held old-profile work");
        await tv.page.evaluate(() => window.browseHarness.clearProfile());
        held.release();
        await tv.jump(1000);
        assert.equal(await menu(tv).count(), 0);
        assert.equal(await tv.page.locator(".browse").count(), 0);
        assert.equal(await tv.page.locator("#successor").count(), 1);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("card actions failed writes keep explicit read-first Retry and Close", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await hold(tv);
        await menu(tv).getByRole("button", { name: "Add favorite", exact: true }).waitFor();
        catalog.mutationFailure = problem(400, "validation_failed", "Not applied");
        await menu(tv).getByRole("button", { name: "Add favorite", exact: true }).click();
        await menu(tv).getByRole("button", { name: "Retry favorites", exact: true }).waitFor();
        const before = tv.fake.requests.length;
        await menu(tv).getByRole("button", { name: "Retry favorites", exact: true }).click();
        await menu(tv).getByRole("button", { name: "Remove favorite", exact: true }).waitFor();
        assert.deepEqual(tv.fake.requests.slice(before).filter(r => r.path.startsWith("/favorites/")).map(r => r.method), ["GET", "PUT", "GET"]);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const reducedMotion of ["no-preference", "reduce"] as const) for (const outcome of ["failed", "pending"] as const) {
    test(`retained card actions refresh unrelated confirmed values after ${outcome} writes in ${reducedMotion}`, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            await tv.page.emulateMedia({ reducedMotion });
            const catalog = await start(tv);
            await hold(tv);
            await menu(tv).getByRole("button", { name: "Add favorite", exact: true }).waitFor();
            const pending = outcome === "pending" ? tv.fake.hold("/favorites/movie%3Am0001", true) : undefined;
            if (outcome === "failed") catalog.mutationFailure = problem(400, "validation_failed", "Not applied");
            await menu(tv).getByRole("button", { name: "Add favorite", exact: true }).click();
            if (outcome === "failed") await menu(tv).getByRole("button", { name: "Retry favorites", exact: true }).waitFor();
            await tv.remote(10009);
            pending?.release();
            await origin(tv).click();
            await tv.page.locator('.browse[data-view="item:movie:m0001"]').waitFor();
            await tv.page.getByRole("button", { name: "Mark watched", exact: true }).click();
            await tv.page.getByRole("button", { name: "Mark unwatched", exact: true }).waitFor();
            await tv.page.getByRole("button", { name: "Add to watchlist", exact: true }).click();
            await tv.page.getByRole("button", { name: "Remove from watchlist", exact: true }).waitFor();
            await tv.remote(10009);
            await origin(tv).waitFor();
            const favoriteWrites = tv.fake.requests.filter(r => r.method === "PUT" && r.path === "/favorites/movie%3Am0001").length;
            const fresh = tv.fake.hold("/catalog/items/movie%3Am0001");
            await hold(tv);
            assert.equal(await menu(tv).locator('[data-focus="watched"]').count(), 0, "reopening must wait for fresh confirmed values");
            fresh.release();
            await menu(tv).getByRole("button", { name: "Retry favorites", exact: true }).waitFor();
            assert.equal(await menu(tv).getByRole("button", { name: "Mark unwatched", exact: true }).count(), 1);
            assert.equal(await menu(tv).getByRole("button", { name: "Remove from watchlist", exact: true }).count(), 1);
            assert.equal(tv.fake.requests.filter(r => r.method === "PUT" && r.path === "/favorites/movie%3Am0001").length, favoriteWrites, "reopening cannot replay an unresolved write");
            await menu(tv).getByRole("button", { name: "Retry favorites", exact: true }).click();
            await menu(tv).getByRole("button", { name: "Remove favorite", exact: true }).waitFor();
            assert.equal(tv.fake.requests.filter(r => r.method === "PUT" && r.path === "/favorites/movie%3Am0001").length, favoriteWrites + (outcome === "failed" ? 1 : 0));
            assert.equal(tv.fake.requests.filter(r => r.method === "POST" && r.path === "/watched/movie%3Am0001").length, 1);
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`a same-view read preserves the original Select hold deadline in ${reducedMotion}`, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            await tv.page.emulateMedia({ reducedMotion });
            await start(tv);
            const personal = tv.fake.hold("/favorites/series%3As1/membership");
            await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').click();
            await tv.page.locator('[data-focus="season:1"]').focus();
            await tv.page.clock.pauseAt(await tv.page.evaluate(() => Date.now() + 1000));
            await tv.down(13);
            await tv.jump(400);
            personal.release();
            await tv.page.getByRole("button", { name: "Add favorite", exact: true }).waitFor();
            await tv.jump(249);
            assert.equal(await menu(tv).count(), 0);
            await tv.jump(1);
            await menu(tv).waitFor();
            await tv.up(13);
            assert.equal(await menu(tv).count(), 1);
            assert.equal(await tv.page.locator('.browse').getAttribute("data-view"), "item:series:s1");
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}

test("card actions pending close/reopen retains target, suppresses repeat-false updates, and reads first", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await hold(tv);
        await menu(tv).getByRole("button", { name: "Add favorite", exact: true }).waitFor();
        const held = tv.fake.hold("/watched/movie%3Am0001", true);
        await menu(tv).getByRole("button", { name: "Mark watched", exact: true }).focus();
        await tv.down(13);
        await tv.down(13, false); await tv.down(13, true);
        assert.deepEqual(await menu(tv).locator('[aria-disabled="true"]').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus"))), ["watched", "favorites", "watchlist"]);
        assert.deepEqual(catalog.mutations, ["POST /watched/movie%3Am0001"]);
        await tv.up(13);
        await tv.remote(10009);
        held.release();
        await origin(tv).waitFor();
        await hold(tv);
        await menu(tv).getByRole("button", { name: "Retry watched", exact: true }).click();
        await menu(tv).getByRole("button", { name: "Mark unwatched", exact: true }).waitFor();
        assert.deepEqual(catalog.mutations, ["POST /watched/movie%3Am0001"]);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const surface of ["library-shelf", "library-grid", "collection", "search", "related", "person-preview", "season", "episode"] as const) test(`card quick-actions reach ${surface} and exclude navigation/input`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        if (surface === "library-shelf" || surface === "library-grid" || surface === "collection") {
            await tv.page.locator('[data-focus="movies"]').click();
            await tv.page.locator('.browse[data-view="library:12"] .browse-card:not(.discovery-collection)').first().waitFor();
            if (surface === "library-grid") {
                await tv.page.locator('[data-focus="mode:Recently Added"]').click();
                await tv.page.locator('.browse .browse-grid .browse-card').first().waitFor();
            }
            if (surface === "collection") {
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
            if (surface === "person-preview") {
                await tv.page.locator('[data-focus="person:7"]').first().click();
                await tv.page.locator('.browse[data-view="person:7"] .browse-row .browse-card').first().waitFor();
            }
            if (surface === "episode") await tv.page.locator('[data-focus="season:1"]').click();
            if (surface === "related") await tv.page.locator('[data-detail-section="related"] .browse-card').first().waitFor();
        }
        const card = surface === "season" ? tv.page.locator('[data-focus="season:1"]') : surface === "episode" ? tv.page.locator('.browse .browse-episode').first() : surface === "related" ? tv.page.locator('.browse [data-detail-section="related"] .browse-card').first() : tv.page.locator('.browse .browse-card:not(.discovery-collection)').first();
        const id = surface === "season" ? "series:s1-S1" : await card.getAttribute("data-focus");
        const before = tv.fake.requests.length;
        await card.focus(); await tv.down(13); await tv.jump(650); await tv.up(13);
        await menu(tv).locator('[data-focus="watched"]').waitFor();
        if (surface === "season") assert.equal(await menu(tv).getByRole("button").count(), 2);
        assert.ok(tv.fake.requests.slice(before).some(r => r.path.startsWith(`/catalog/items/${encodeURIComponent(id ?? "")}`)));
        await tv.remote(10009);
        assert.equal(await menu(tv).count(), 0);
        assert.equal(await tv.focused(), await card.getAttribute("data-focus"));
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const reducedMotion of ["no-preference", "reduce"] as const) test(`card actions ${reducedMotion} restore origin scroll and preserve navigation during late refresh`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await tv.page.emulateMedia({ reducedMotion });
        await start(tv);
        const card = tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0011"]');
        await card.focus(); await tv.jump(300);
        const position = () => tv.page.locator('.browse').evaluate(node => ({ top: node.querySelector('.skyline-content')?.scrollTop, left: node.querySelector('[data-section="recently_added"] .browse-row')?.scrollLeft }));
        const saved = await position();
        assert.ok((saved.left ?? 0) > 0);
        await tv.down(13); await tv.jump(650); await tv.up(13);
        await menu(tv).getByRole("button", { name: "Add favorite", exact: true }).click();
        await menu(tv).getByRole("button", { name: "Remove favorite", exact: true }).waitFor();
        const held = tv.fake.hold("/home/sections", true);
        await tv.remote(10009); await tv.jump(300);
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

for (const outcome of ["failed", "empty"] as const) test(`card actions ${outcome} origin refresh retains recovery/navigation`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await hold(tv);
        await menu(tv).getByRole("button", { name: "Add favorite", exact: true }).click();
        await menu(tv).getByRole("button", { name: "Remove favorite", exact: true }).waitFor();
        if (outcome === "failed") catalog.failNext("/home/sections", problem(400, "validation_failed", "Unavailable"));
        else {
            const household = catalog.households.get("p-owner");
            assert.ok(household);
            household.sections = [];
        }
        await tv.remote(10009);
        if (outcome === "failed") {
            await tv.page.locator('.browse [data-focus="retry"]').waitFor();
            await tv.page.locator('.browse [data-focus="retry"]').click();
            await origin(tv).waitFor();
        } else {
            await tv.page.getByText("There is nothing to watch on this profile yet.").waitFor();
            assert.ok(["home", "profiles"].includes(await tv.focused() ?? ""));
        }
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const reducedMotion of ["no-preference", "reduce"] as const) for (const repeat of [false, true]) {
    test(`opening hold repeats ${repeat} cannot activate the new menu in ${reducedMotion}`, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            await tv.page.emulateMedia({ reducedMotion });
            const catalog = await start(tv);
            await origin(tv).focus();
            await tv.page.keyboard.down("Enter");
            await tv.jump(650);
            await menu(tv).getByRole("button", { name: "Mark watched", exact: true }).waitFor();
            assert.equal(await tv.focused(), "close-card-actions");
            await tv.down(13, repeat);
            assert.equal(await menu(tv).count(), 1, "the opening press still owns repeated Enter keydowns");
            assert.deepEqual(catalog.mutations, []);
            await tv.page.keyboard.up("Enter");
            assert.equal(await menu(tv).count(), 1, "opening release cannot activate Close");
            await tv.page.keyboard.press("Enter");
            assert.equal(await menu(tv).count(), 0, "a fresh Select can activate Close");
            assert.equal(await tv.focused(), "movie:m0001");
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`Details and card menu share one pending mutation in ${reducedMotion}`, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            await tv.page.emulateMedia({ reducedMotion });
            const catalog = await start(tv);
            await origin(tv).click();
            const favorite = tv.page.locator('.browse [data-focus="favorites"]').first();
            await favorite.waitFor({ timeout: 1500 });
            const first = tv.fake.hold("/favorites/movie%3Am0001", true);
            await favorite.click();
            await tv.eventually(() => Promise.resolve(catalog.mutations.length === 1), "Details write dispatched");
            const related = tv.page.locator('[data-detail-section="related"] [data-focus="movie:m0002"]');
            await related.focus();
            await tv.down(13);
            await tv.jump(650);
            await tv.up(13);
            const watched = menu(tv).getByRole("button", { name: "Mark watched", exact: true });
            await watched.waitFor();
            assert.equal(await watched.getAttribute("aria-disabled"), "true", "Details' pending write disables the menu actions");
            for (const key of ["watched", "favorites", "watchlist"]) await menu(tv).locator(`[data-focus="${key}"]`).dispatchEvent("click");
            assert.deepEqual(catalog.mutations, ["PUT /favorites/movie%3Am0001"]);
            first.release();
            await tv.eventually(async () => await watched.getAttribute("aria-disabled") === "false", "Details completion enables menu actions");
            const second = tv.fake.hold("/watched/movie%3Am0002", true);
            await watched.click();
            await tv.eventually(() => Promise.resolve(catalog.mutations.length === 2), "menu write dispatched");
            await favorite.dispatchEvent("click");
            assert.deepEqual(catalog.mutations, ["PUT /favorites/movie%3Am0001", "POST /watched/movie%3Am0002"], "the menu's pending write also blocks the underlying Details handler");
            second.release();
            await menu(tv).getByRole("button", { name: "Mark unwatched", exact: true }).waitFor();
            await tv.remote(10009);
            assert.equal(await menu(tv).count(), 0);
            assert.equal(await tv.focused(), "movie:m0002");
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`related-card mutation keeps its row and focus during Details refresh in ${reducedMotion}`, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            await tv.page.emulateMedia({ reducedMotion });
            await start(tv);
            await origin(tv).click();
            const related = tv.page.locator('[data-detail-section="related"] [data-focus="movie:m0002"]');
            await related.focus();
            await tv.down(13);
            await tv.jump(650);
            await tv.up(13);
            await menu(tv).getByRole("button", { name: "Mark watched", exact: true }).click();
            await menu(tv).getByRole("button", { name: "Mark unwatched", exact: true }).waitFor();
            const held = tv.fake.hold("/recommendations/similar/movie%3Am0001", true);
            const before = tv.fake.requests.filter(r => r.path.startsWith("/catalog/items/movie%3Am0001")).length;
            await tv.remote(10009);
            await tv.eventually(async () => tv.fake.requests.filter(r => r.path.startsWith("/catalog/items/movie%3Am0001")).length === before + 1, "Details return refresh");
            await tv.jump(0);
            assert.equal(await related.count(), 1, "the existing row remains while its new response is pending");
            assert.equal(await tv.focused(), "movie:m0002");
            held.release();
            await tv.jump(0);
            assert.equal(await tv.focused(), "movie:m0002");
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}
