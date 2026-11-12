import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import type { SettingsKey } from "../../src/contracts/v2/settings.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });
const BACK = 10009;
const grid = (tv: Tv) => tv.page.locator('.browse[data-view^="person:"] .browse-grid .browse-card');
const queries = (tv: Tv) => tv.fake.requests.filter(request => request.path.startsWith("/catalog/query") && request.body?.source === "person" && request.body?.limit !== 1);
const lastQuery = (tv: Tv) => queries(tv)[queries(tv).length - 1];
const metadataReads = (tv: Tv) => tv.fake.requests.filter(request => request.path === "/catalog/people/7").length;

function population(): FakeDetails {
    const catalog = new FakeDetails();
    // Series is wholly absent from the first 60 newest credits.
    for (const title of catalog.titles.values()) {
        if (title.type === "movie") catalog.add({ ...title, year: 2030 });
    }
    catalog.add({ id: "movie:other-copy/+", title: "Movie 0002", type: "movie", libraryId: "12", year: 2030 });
    catalog.personCredits.get("7")?.push("movie:other-copy/+", "movie:m0002");
    for (let index = 0; index < 60; index++) {
        const id = `movie:extra${index}`;
        catalog.add({ id, title: `Extra ${index}`, type: "movie", libraryId: "12", year: 2029 });
        catalog.personCredits.get("7")?.push(id);
    }
    return catalog;
}

async function start(tv: Tv, catalog: FakeDetails, statusOverlays = false, prepare?: () => void): Promise<void> {
    tv.fake.catalog = catalog;
    prepare?.();
    if (statusOverlays) new FakeSettings(tv.fake).profile().set("ui.card_overlays" as SettingsKey, { version: 2, items: { show_status: { enabled: true, position: "top-right" } } });
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
    assert.equal(await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner")), "selected");
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().focus();
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await tv.page.locator('.browse[data-view="person:7"] .browse-grid .browse-card').count() === 60, "inline person page");
}

test("late Person poster settings redraw the mounted grid", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const held = tv.fake.hold("/settings/values/effective?keys=ui.card_presentation", true);
        await start(tv, population(), false, () => {
            new FakeSettings(tv.fake).profile().set("ui.card_presentation" as SettingsKey, { poster_size: "large", caption: "title_metadata" });
        });
        // Metadata repaints the grid. A card detached by that paint has width 0, so read the live card.
        await tv.eventually(async () => await tv.page.evaluate(() => {
            const card = document.querySelector('.browse[data-view="person:7"] .browse-grid .browse-card');
            return card !== null && card.isConnected && card.getBoundingClientRect().width === 260;
        }), "default Person poster");
        held.release();
        await tv.eventually(async () => await tv.page.evaluate(() => document.querySelector<HTMLElement>('.browse[data-view="person:7"] .browse-grid .browse-card')?.offsetWidth) === 312, "late Person size");
    } finally { await tv.page.context().close(); }
});

async function all(tv: Tv): Promise<void> {
    assert.equal(await tv.page.locator('[data-focus="see-all"]').count(), 0);
    await tv.eventually(async () => await grid(tv).count() === 60, "inline filmography first page");
}

async function next(tv: Tv, number: number): Promise<void> {
    await grid(tv).nth((number - 1) * 60 - 48).scrollIntoViewIfNeeded();
    await tv.eventually(async () => await grid(tv).count() === Math.min(number * 60, 124), "near-end append");
}

/** Apple EmptyStateView(icon: "film.stack", title: personEmpty, subtitle: personEmptyBody), at least 420pt tall (PersonDetailView.swift:417-423). */
async function emptyFilmography(tv: Tv): Promise<void> {
    const state = tv.page.locator(".person-filmography-empty");
    await state.waitFor();
    const style = (selector: string, property: string): Promise<string> => state.locator(selector).evaluate((node, key) => getComputedStyle(node).getPropertyValue(key), property);
    assert.equal(await state.locator(".search-state-title").textContent(), "No titles found");
    assert.equal(await state.locator(".search-state-description").textContent(), "There are no movies or series linked to this person yet.");
    assert.equal(await state.locator(".search-state-icon svg").count(), 1);
    // film.stack draws filled sprocket strips with eight holes, not an outline frame.
    assert.equal(await state.locator(".search-state-icon svg path[fill-rule=\"evenodd\"]").count(), 1);
    assert.ok(await state.evaluate(node => node.getBoundingClientRect().height) >= 420, "Apple's 420pt minimum height");
    assert.equal(await style(".search-state-icon", "height"), "44px");
    assert.equal(await style(".search-state-icon", "margin-bottom"), "12px");
    assert.equal(await style(".search-state-icon", "color"), "rgba(237, 237, 237, 0.3)");
    // Apple's points times --silo-sf-cap-scale (0.9685, #418): siloSubheadline 28 semibold, siloCaption 22.
    assert.equal(await style(".search-state-title", "font-size"), "27.118px");
    assert.equal(await style(".search-state-title", "font-weight"), "600");
    assert.equal(await style(".search-state-title", "margin-bottom"), "12px");
    assert.equal(await style(".search-state-description", "font-size"), "21.307px");
    assert.equal(await style(".search-state-description", "color"), "rgba(237, 237, 237, 0.6)");
}

/** Apple ErrorView(state:onRetry:) in the Filmography area, at least 420pt tall (PersonDetailView.swift:414-416). */
async function failedFilmography(tv: Tv, message: string): Promise<void> {
    const state = tv.page.locator(".person-filmography-failure");
    await state.waitFor();
    assert.equal(await state.getAttribute("role"), "alert");
    assert.equal(await state.locator(".search-state-title").textContent(), "Something went wrong");
    assert.equal(await state.locator(".search-state-description").textContent(), message);
    assert.equal(await state.locator(".search-state-icon svg").count(), 1);
    assert.deepEqual(await state.locator("[data-focus]").evaluateAll(nodes => nodes.map(node => [node.getAttribute("data-focus"), node.textContent])), [["retry", "Try Again"]]);
    assert.ok(await state.evaluate(node => node.getBoundingClientRect().height) >= 420, "Apple's 420pt minimum height");
    assert.equal(await tv.page.locator(".details-person-hero").count(), 1, "the person stays on screen above the error");
}

function journey(name: string, body: (tv: Tv, catalog: FakeDetails) => Promise<void>): void {
    test(name, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            // Smooth scrolling would still be animating when a test scrolls natively, pushing tail cards through the viewport twice.
            await tv.page.emulateMedia({ reducedMotion: "reduce" });
            const catalog = population();
            await start(tv, catalog);
            await body(tv, catalog);
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}

journey("incomplete Person dispatches once and polls independently of filter and paging", async tv => {
    await tv.remote(BACK);
    let complete = false;
    let dispatches = 0;
    let reads = 0;
    await tv.page.route("**/api/v2/catalog/people/7", route => {
        reads++;
        return route.fulfill({ json: { id: "7", name: "River Vale", bio: "Updated biography", birth_date: "1980-04-12", ...(complete ? { photo_url: "/art/river.svg" } : {}) } });
    });
    await tv.page.route("**/api/v2/catalog/people/7/refresh", route => {
        dispatches++;
        assert.equal(route.request().method(), "POST");
        return route.fulfill({ status: 202, json: { status: "queued", person_id: "7" } });
    });
    await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().click();
    await tv.eventually(async () => dispatches === 1, "refresh dispatch");
    await tv.page.getByText("Loading metadata", { exact: true }).waitFor();
    await tv.page.locator('[data-focus="filter:series"]').click();
    await tv.eventually(async () => await grid(tv).count() === 3, "filter during refresh");
    complete = true;
    await tv.jump(3000);
    await tv.eventually(async () => reads === 2 && await tv.page.getByText("Loading metadata", { exact: true }).count() === 0, "complete metadata stops polling");
    assert.equal(await tv.focused(), "filter:series");
    await tv.jump(120000);
    assert.equal(dispatches, 1);
    assert.equal(reads, 2);
});

journey("a refused refresh dispatch is not resent after the sign-in refreshes", async tv => {
    await tv.remote(BACK);
    const dispatches = (): number => tv.fake.paths().filter(path => path === "POST /catalog/people/7/refresh").length;
    const refreshes = tv.fake.paths().filter(path => path.includes("/auth/refresh")).length;
    await tv.page.route("**/api/v2/catalog/people/7", route => route.fulfill({ json: { id: "7", name: "River Vale", birth_date: "1980-04-12", photo_url: "/art/river.svg" } }));
    tv.fake.script("/catalog/people/7/refresh", problem(401, "token_refresh_required", "Refresh required"));
    await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().click();
    await tv.eventually(async () => tv.fake.paths().filter(path => path.includes("/auth/refresh")).length === refreshes + 1, "session refresh after the 401");
    await tv.jump(5000);
    assert.equal(dispatches(), 1, "the queue request is sent once, like the other Silo writes");
});

journey("metadata polling that expands the hero preserves the settled card reveal", async tv => {
    // Reduced motion scrolls at once, so only normal motion exercises the unchanged-target guard in SkylineScroll.move.
    await tv.page.emulateMedia({ reducedMotion: "no-preference" });
    await tv.remote(BACK);
    let complete = false;
    let renamed = false;
    let polls = 0;
    let gate: Promise<void> = Promise.resolve();
    const biography = "A longer biography that expands the person header. ".repeat(35);
    await tv.page.route("**/api/v2/catalog/people/7", async route => {
        const name = complete ? "River Vale with a longer credited name ".repeat(4) : renamed ? "River Vold" : "River Vale";
        polls++;
        await gate;
        await route.fulfill({ json: { id: "7", name, photo_url: "/art/river.svg", birth_date: "1980-04-12", ...(complete ? { bio: biography } : {}) } });
    });
    await tv.page.route("**/api/v2/catalog/people/7/refresh", route => route.fulfill({ status: 202, json: { status: "queued", person_id: "7" } }));
    await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().click();
    await grid(tv).first().waitFor();
    await tv.page.locator('[data-focus="filter:video"]').focus();

    // A poll answer that changes only the name repaints the grid mid-scroll with the same reveal target; the scroll must not restart.
    renamed = true;
    let release = (): void => undefined;
    gate = new Promise<void>(resolve => { release = resolve; });
    const pollReads = polls;
    await tv.jump(3000);
    await tv.eventually(async () => polls === pollReads + 1, "held metadata poll");
    await tv.page.clock.pauseAt((await tv.page.evaluate(() => Date.now())) + 1000);
    await tv.page.keyboard.press("ArrowDown");
    await tv.page.clock.runFor(96);
    const partial = await tv.page.locator(".browse").evaluate(node => node.scrollTop);
    release();
    await tv.page.getByText("River Vold", { exact: true }).first().waitFor();
    await tv.page.clock.runFor(112);
    const arrived = await tv.page.locator(".browse").evaluate(node => node.scrollTop);
    await tv.page.clock.runFor(1000);
    const settled = await tv.page.locator(".browse").evaluate(node => node.scrollTop);
    assert.ok(partial > 0 && partial < settled, `the scroll is still moving when the poll repaints: ${partial} of ${settled}`);
    assert.equal(arrived, settled, "a repaint with the same reveal target leaves the running scroll on its original schedule");
    await tv.page.clock.resume();

    const id = await tv.focused();
    const before = await tv.page.evaluate(() => ({ bottom: document.activeElement?.getBoundingClientRect().bottom ?? 0, hero: document.querySelector(".details-person-hero")?.getBoundingClientRect().height ?? 0 }));
    complete = true;
    release = () => undefined;
    gate = Promise.resolve();
    await tv.jump(3000);
    await tv.page.getByText(biography, { exact: true }).waitFor();
    await tv.jump(250);
    assert.equal(await tv.focused(), id);
    const rect = await tv.page.evaluate(() => {
        const bounds = document.activeElement?.getBoundingClientRect();
        return { top: bounds?.top ?? -1, bottom: bounds?.bottom ?? 1081, hero: document.querySelector(".details-person-hero")?.getBoundingClientRect().height ?? 0 };
    });
    assert.ok(rect.hero > before.hero, "the metadata update must actually expand the header");
    assert.ok(rect.top >= 0 && rect.bottom <= 1080, `expanded metadata keeps the full focused card visible: ${JSON.stringify(rect)}`);
    assert.ok(Math.abs(rect.bottom - before.bottom) < 1, "the expanded header preserves the existing focused-card reveal margin");
});

journey("card quick-actions refresh full Filmography's committed page and retain nearby identity", async (tv, catalog) => {
    await all(tv);
    await next(tv, 2);
    const cards = await grid(tv).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus")));
    const id = cards[5];
    const nearby = cards[6];
    assert.ok(id); assert.ok(nearby);

    await grid(tv).nth(5).focus();
    await tv.down(13); await tv.jump(650); await tv.up(13);
    // The person grid reads the card's item before its menu opens; the removal lands before the change's reread.
    catalog.removed.add(id);
    await tv.page.getByRole("menu").getByRole("menuitem", { name: "Add to Favorites", exact: true }).click();
    await tv.eventually(async () => await tv.focused() === nearby, "nearby Filmography focus");
    assert.equal(queries(tv).slice(-2)[0]?.body?.cursor, undefined, "refresh starts at page one and retains loaded depth");
    assert.equal(lastQuery(tv)?.body?.person_id, "7");
    assert.equal(await grid(tv).count(), 120);
});

journey("Person has count, filters and page two without extra ready controls", async tv => {
    assert.equal(await tv.page.locator('.person-title-count').textContent(), "124 titles");
    assert.equal(await tv.page.locator('[data-focus^="filter:"]').count(), 3);
    for (const key of ["back", "see-all", "synopsis"]) assert.equal(await tv.page.locator(`[data-focus="${key}"]`).count(), 0);
    await next(tv, 2);
    assert.equal(await tv.page.locator('.details-person-hero').count(), 1);
    assert.equal(await tv.page.locator('.browse').getAttribute('data-view'), 'person:7');
});

journey("near-end append keeps mounted focus and allows only one page in flight", async tv => {
    for (const key of ["next", "previous"]) assert.equal(await tv.page.locator(`[data-focus="${key}"]`).count(), 0);
    assert.equal(await tv.page.locator(".browse-page-status").count(), 0);
    const held = tv.fake.hold("/catalog/query", true);
    const trigger = grid(tv).nth(12);
    await trigger.evaluate(node => node.setAttribute("data-retained", "yes"));
    await trigger.focus();
    await tv.eventually(async () => queries(tv).length === 2, "eight-row threshold");
    await tv.page.locator('[aria-label="Loading more titles"]').waitFor();
    const id = await tv.focused();
    await tv.page.keyboard.press("ArrowRight");
    await tv.page.keyboard.press("ArrowLeft");
    // Scrolling the tail out of view and back makes the armed observer report the trigger cards a second time while the first read is out.
    const frames = (): Promise<unknown> => tv.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await tv.page.locator(".browse").evaluate(node => { node.scrollTop = 0; });
    await frames();
    assert.equal(await grid(tv).last().evaluate(node => node.getBoundingClientRect().top > window.innerHeight), true, "the tail left the viewport");
    await grid(tv).last().scrollIntoViewIfNeeded();
    await frames();
    await tv.jump(300);
    assert.equal(queries(tv).length, 2, "visible trigger cards cannot overlap requests");
    held.release();
    await tv.eventually(async () => await grid(tv).count() === 120, "second batch appended");
    assert.equal(await tv.focused(), id);
    assert.equal(await trigger.getAttribute("data-retained"), "yes", "the focused card was appended around, not remounted");
    await tv.page.locator('[data-focus="filter:series"]').click();
    await tv.eventually(async () => await grid(tv).count() === 3, "filter replaces accumulated titles");
    assert.equal(lastQuery(tv)?.body?.cursor, undefined);
    assert.equal(await tv.focused(), "filter:series");
});

journey("Person uses the Apple source geometry and remote zones", async tv => {
    const style = async (selector: string, property: string): Promise<string> => tv.page.locator(selector).first().evaluate((node, key) => getComputedStyle(node).getPropertyValue(key), property);
    assert.equal(await style(".browse", "padding"), "108px 160px 132px");
    assert.equal(await style(".details-person-hero", "margin-bottom"), "48px");
    assert.equal(await style(".details-person-hero .browse-title", "margin-bottom"), "0px");
    assert.equal(await style(".person-facts", "margin-top"), "22px");
    assert.equal(await style(".person-facts", "column-gap"), "12px");
    assert.equal(await style(".browse-overview", "margin-top"), "22px");
    // Apple's points times --silo-sf-cap-scale (0.9685, #418).
    assert.equal(await style(".person-title-count", "font-size"), "21.307px");
    assert.equal(await style(".person-title-count", "color"), "rgba(237, 237, 237, 0.6)");
    assert.equal(await style(".person-filmography-heading h2", "font-size"), "34.866px");
    assert.equal(await style(".person-filmography-heading h2", "line-height"), "43px");
    assert.equal(await style(".person-filmography-heading h2", "font-weight"), "600");
    assert.equal(await style(".person-filmography-heading", "margin-bottom"), "20px");
    assert.equal(await style(".person-filmography-heading", "column-gap"), "60px");
    assert.equal(await style(".person-filmography-filters", "padding-top"), "8px");
    assert.equal(await style(".person-filmography-filters", "column-gap"), "8px");
    assert.equal(await style(".person-filmography-filters", "margin-bottom"), "28px");
    assert.equal(await style('[data-focus="filter:video"]', "font-size"), "21.307px");
    assert.equal(await style('[data-focus="filter:video"]', "font-weight"), "400");
    // Apple's 22/10 padding is measured to the stroke the chip draws over its frame; the 1px border sits inside the box.
    assert.equal(await style('[data-focus="filter:video"]', "padding"), "9px 21px");
    assert.equal(await style('[data-focus="filter:video"]', "border-top-width"), "1px");
    assert.equal(await style(".browse-grid", "width"), "1600px");
    assert.equal(await style(".browse-overview", "font-weight"), "400");
    assert.equal(await style(".browse-grid", "padding-left"), "0px");
    assert.equal(await style(".browse-grid", "column-gap"), "40px");
    assert.equal(await style(".browse-grid", "row-gap"), "60px");
    assert.equal(await style(".browse-grid .browse-art", "width"), "260px");
    assert.equal(await style(".browse-grid .browse-art", "height"), "390px");
    await tv.page.locator('[data-focus="filter:video"]').focus();
    const count = queries(tv).length;
    for (const key of ["ArrowLeft", "ArrowUp"]) {
        await tv.page.keyboard.press(key);
        assert.equal(await tv.focused(), "filter:video");
    }
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.focused(), "filter:movie");
    await tv.page.keyboard.press("ArrowDown");
    const first = await grid(tv).first().getAttribute("data-focus");
    assert.equal(await tv.focused(), first);
    await tv.jump(300);
    // Was 277 before #418 put the heading row and chips on Apple's 43 and 46 line boxes, which lifts the grid 3px.
    assert.equal(await tv.page.locator(".browse").evaluate(node => node.scrollTop), 274, "was 237 when the reveal used a 92px bottom margin");
    await tv.page.keyboard.press("ArrowLeft");
    assert.equal(await tv.focused(), first);
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.focused(), await grid(tv).nth(1).getAttribute("data-focus"));
    await tv.page.keyboard.press("ArrowUp");
    // Replaces `assert.equal(await tv.focused(), "filter:video", "was filter:movie when Up restored the focused chip; column 1 overlaps the row and All stays selected")`.
    assert.equal(await tv.focused(), "filter:series", "column 1's left edge meets Series; the selected All chip does not take Up");
    await grid(tv).nth(2).focus();
    const third = await tv.focused();
    await tv.page.keyboard.press("ArrowUp");
    assert.equal(await tv.focused(), third, "was filter:movie when Up restored the focused chip; no chip is above column 2");
    await grid(tv).first().focus();
    await tv.page.keyboard.press("ArrowUp");
    assert.equal(await tv.focused(), "filter:video", "column 0 meets All along its left edge, including when another chip was focused on the way down");
    await tv.jump(300);
    assert.equal(await tv.page.locator(".browse").evaluate(node => node.scrollTop), 0);
    assert.equal(queries(tv).length, count, "navigation away from the end never fetches");
    await tv.page.locator('[data-focus="filter:series"]').click();
    await tv.eventually(async () => await grid(tv).count() === 3, "ragged final row");
    const reads = queries(tv).length;
    await grid(tv).last().focus();
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.focused(), await grid(tv).last().getAttribute("data-focus"));
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), await grid(tv).last().getAttribute("data-focus"));
    await tv.page.keyboard.press("ArrowUp");
    assert.equal(await tv.focused(), await grid(tv).last().getAttribute("data-focus"));
    assert.equal(queries(tv).length, reads, "an exhausted grid never fetches on navigation");
});

journey("reopening Person starts on All while Details Back preserves its visit", async tv => {
    await tv.page.locator('[data-focus="filter:series"]').click();
    await tv.eventually(async () => await grid(tv).count() === 3, "Series");
    await grid(tv).first().click();
    await tv.page.locator(".details-hero").waitFor();
    await tv.remote(BACK);
    assert.equal(await tv.page.locator('[data-focus="filter:series"]').getAttribute("aria-pressed"), "true");
    await tv.page.locator('[data-focus="filter:series"]').focus();
    await tv.remote(BACK);
    await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().click();
    await tv.eventually(async () => await grid(tv).count() === 60, "reopened All");
    assert.equal(await tv.focused(), "filter:video");
    assert.equal(await tv.page.locator('[data-focus="filter:video"]').getAttribute("aria-pressed"), "true");
});

journey("failed availability probes keep filters visible and late metadata cannot replace Back", async (tv, catalog) => {
    await tv.remote(BACK);
    const read = catalog.route.bind(catalog);
    catalog.route = (method, path, profile, body) => body?.limit === 1 ? problem(403, "permission_denied", "Synthetic probe failure") : read(method, path, profile, body);
    const held = tv.fake.hold("/catalog/people/7", true);
    await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().click();
    await tv.eventually(async () => await grid(tv).count() === 60, "credits before metadata");
    assert.equal(await tv.page.locator('[data-focus^="filter:"]').count(), 3);
    await tv.remote(BACK);
    held.release();
    await tv.jump(300);
    assert.match(await tv.focused() ?? "", /^credit:7:/);
    assert.equal(await tv.page.locator(".details-person-hero").count(), 0);
});

journey("availability comes from server probes, not the loaded first page", async (tv, catalog) => {
    catalog.personCredits.set("7", ["movie:m0001"]);
    await tv.remote(BACK);
    await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().click();
    await tv.eventually(async () => await grid(tv).count() === 1, "movie-only person");
    await tv.eventually(async () => await tv.page.locator('[data-focus="filter:series"]').count() === 0, "empty Series hidden");
    assert.equal(await tv.page.locator('[data-focus="filter:movie"]').count(), 1);
    assert.equal(await tv.page.locator(".browse-page-status").count(), 0, "no Page 1 of 1");
});

journey("selecting Series while availability probes are still out keeps that chip and its results", async (tv, catalog) => {
    catalog.personCredits.set("7", ["movie:m0001"]);
    const transport = tv.fake.fetch.bind(tv.fake);
    let releaseProbes = (): void => undefined;
    const probes = new Promise<void>((resolve) => { releaseProbes = resolve; });
    (tv.fake as { fetch: typeof tv.fake.fetch }).fetch = async (url, init) => {
        const body = typeof init.body === "string" ? JSON.parse(init.body) as { source?: string; limit?: number } : undefined;
        if (body?.source === "person" && body.limit === 1) await probes;
        return transport(url, init);
    };
    await tv.remote(BACK);
    await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().click();
    await tv.eventually(async () => await grid(tv).count() === 1, "movie credit before probes");
    assert.equal(await tv.page.locator('[data-focus^="filter:"]').count(), 3, "all chips stay while probes are out");
    const probeAnswers = Promise.all([0, 1].map(() => tv.page.waitForResponse((response) => {
        const data = response.request().postData() ?? "";
        return response.url().includes("/catalog/query") && data.includes('"limit":1');
    })));
    await tv.page.locator('[data-focus="filter:series"]').click();
    await tv.eventually(async () => lastQuery(tv)?.body?.type === "series" && await tv.page.getByText("No titles found", { exact: true }).count() === 1, "Series chosen before probes finish");
    assert.equal(await tv.focused(), "filter:series");
    releaseProbes();
    await probeAnswers;
    await tv.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)))));
    assert.equal(await tv.page.locator('[data-focus^="filter:"]').count(), 3, "a filter change drops the late probe, so Series stays");
    assert.equal(await tv.page.locator('[data-focus="filter:series"]').getAttribute("aria-pressed"), "true");
    assert.equal(lastQuery(tv)?.body?.type, "series");
    assert.equal(await tv.focused(), "filter:series");
    assert.equal(await tv.page.locator('[data-focus="filter:series"]').count(), 1);
});

journey("credits and hero shell remain usable while metadata is pending", async tv => {
    await tv.remote(BACK);
    const held = tv.fake.hold("/catalog/people/7", true);
    await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().click();
    await tv.eventually(async () => await grid(tv).count() === 60, "independent credits");
    assert.equal(await tv.page.locator(".details-person-hero").count(), 1);
    await tv.page.getByText("Loading metadata", { exact: true }).waitFor();
    assert.equal(await grid(tv).count(), 60);
    await next(tv, 2);
    assert.equal(await tv.page.locator(".details-person-hero").count(), 1);
    await tv.page.getByText("Loading metadata", { exact: true }).waitFor();
    await tv.page.locator('[data-focus="filter:series"]').click();
    await tv.eventually(async () => await grid(tv).count() === 3, "filter during pending metadata");
    assert.equal(metadataReads(tv), 2, "one completed visit plus one pending visit, not one per page or filter");
    held.release();
    await tv.eventually(async () => await tv.page.getByText("Loading metadata", { exact: true }).count() === 0, "metadata settled");
});

test("catalog Series cards use the shared configured status ribbons", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = population();
        const read = catalog.route.bind(catalog);
        catalog.route = (...args) => {
            const response = read(...args);
            const body = response?.body as { items?: Record<string, unknown>[] } | undefined;
            if (body?.items !== undefined) body.items = body.items.map((item, index) => ({ ...item, ...(item.type === "series" ? { show_status: index % 2 === 0 ? "returning series" : "ended" } : {}) }));
            return response;
        };
        await start(tv, catalog, true);
        await tv.page.locator('[data-focus="filter:series"]').click();
        await tv.eventually(async () => await grid(tv).count() === 3, "Series cards");
        assert.deepEqual(await tv.page.locator(".browse-grid .card-overlay").allTextContents(), ["Returning", "Ended", "Returning"]);
    } finally { await tv.page.context().close(); }
});

journey("person full journey reaches third page, server filters whole population, restores Details/Person/origin", async tv => {
    const capture = process.env.PERSON_CAPTURE_DIR;
    if (capture !== undefined) {
        await mkdir(capture, { recursive: true });
        const portrait = tv.page.locator(".details-person-hero .person-portrait");
        await tv.eventually(async () => await portrait.getAttribute("data-person-portrait") === "loaded" && await portrait.locator("img").evaluate(node => getComputedStyle(node).opacity) === "1", "settled person portrait");
        await tv.page.screenshot({ path: `${capture}/person.png`, animations: "disabled" });
    }
    if (process.env.PERSON_CAPTURE_BEFORE === "1") return;
    await all(tv);
    const firstIds = await grid(tv).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus")));
    assert.ok(firstIds.every(id => !id?.startsWith("series:")));
    assert.equal(queries(tv)[0]?.body?.cursor, undefined, "GET preview cursor cannot seed POST");
    const count = tv.fake.requests.length;
    await tv.page.locator('[data-focus="filter:series"]').focus();
    await tv.page.keyboard.press("ArrowLeft");
    assert.equal(tv.fake.requests.length, count, "arrows never fetch");
    await tv.page.locator('[data-focus="filter:series"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await grid(tv).count() === 3, "all server-filtered series");
    assert.equal(lastQuery(tv)?.body?.type, "series");
    await tv.page.locator('[data-focus="filter:movie"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => lastQuery(tv)?.body?.type === "movie" && await grid(tv).count() === 60, "movies");
    await tv.page.locator('[data-focus="filter:video"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => lastQuery(tv)?.body?.type === "video" && await grid(tv).count() === 60, "All");
    await next(tv, 2);
    await next(tv, 3);
    assert.equal(await grid(tv).count(), 124);
    await tv.page.locator('.browse-grid [data-focus="movie:m0002"] .browse-art-missing').waitFor();
    await tv.page.locator('.browse-grid [data-focus="movie:m0003"] .browse-art-missing').waitFor();
    const card = grid(tv).last();
    const id = await card.getAttribute("data-focus");
    await card.focus();
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await tv.page.locator(".browse").getAttribute("data-view") === `item:${id}`, "third-page Details");
    await tv.remote(BACK);
    assert.equal(await grid(tv).count(), 124);
    assert.equal(await tv.focused(), id);
    await tv.remote(BACK);
    assert.equal(metadataReads(tv), 1);
    await tv.eventually(async () => (await tv.focused())?.startsWith("credit:7:") === true, "origin credit restoration");
    for (const request of queries(tv)) {
        assert.equal(request.method, "POST");
        assert.equal(request.body?.sort, "year");
        assert.equal(request.body?.order, "desc");
        assert.equal(request.body?.limit, 60);
        assert.equal(request.body?.person_id, "7");
        assert.equal(request.headers["x-profile-id"], "p-owner");
    }
    // This journey used to make no capability request. Opening the movie asks once whether box sets exist.
    assert.equal(tv.fake.requests.filter(request => /search\/capabilities/.test(request.path)).length, 1);
});

journey("failed append retains cards without an error panel and waits for near-end reentry", async (tv, catalog) => {
    await all(tv);
    const ids = await grid(tv).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus")));
    catalog.personReplies.push(problem(500, "internal_error", "Synthetic lookup failure"));
    const end = grid(tv).last();
    const focused = await end.getAttribute("data-focus");
    await end.focus();
    await grid(tv).last().scrollIntoViewIfNeeded();
    await tv.eventually(async () => queries(tv).length === 2 && await tv.page.locator('[aria-label="Loading more titles"]').count() === 0, "failed append settled");
    assert.equal(await tv.focused(), focused, "failed append retains remote focus on the end card");
    assert.equal(await tv.page.locator('[data-focus="retry"]').count(), 0);
    const target = lastQuery(tv)?.body?.cursor;
    assert.equal(typeof target, "string");
    assert.deepEqual(await grid(tv).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus"))), ids);
    const before = queries(tv).length;
    await tv.jump(2000);
    assert.equal(queries(tv).length, before, "no timed pagination retries");
    await grid(tv).first().scrollIntoViewIfNeeded();
    await tv.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await next(tv, 2);
    assert.equal(queries(tv).length, before + 1);
    assert.equal(lastQuery(tv)?.body?.cursor, target);
});

journey("Details Back after a failed append keeps the loaded pages without reading them again", async (tv, catalog) => {
    await all(tv);
    catalog.personReplies.push(problem(500, "internal_error", "Synthetic lookup failure"));
    await grid(tv).last().scrollIntoViewIfNeeded();
    await tv.eventually(async () => queries(tv).length === 2 && await tv.page.locator('[aria-label="Loading more titles"]').count() === 0, "failed append settled");
    const ids = await grid(tv).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus")));
    const count = queries(tv).length;
    await grid(tv).first().click();
    await tv.page.locator(".details-hero").waitFor();
    await tv.remote(BACK);
    await tv.page.locator(".details-person-hero").waitFor();
    await tv.jump(300);
    assert.equal(queries(tv).length, count, "Back reads no filmography page");
    assert.deepEqual(await grid(tv).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus"))), ids);
});

for (const continuation of ["missing", "empty", "repeated"]) journey(`malformed ${continuation} continuation is recoverable and cannot silently end or loop`, async (tv, catalog) => {
    await all(tv);
    await next(tv, 2);
    const previous = lastQuery(tv)?.body?.cursor;
    const before = await grid(tv).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus")));
    catalog.personReplies.push({ status: 200, body: { items: [], total: 124, total_exact: true, window_cursor: "synthetic", page: { has_more: true,
        ...(continuation === "missing" ? {} : { next_cursor: continuation === "empty" ? "" : previous }) } } });
    await grid(tv).last().scrollIntoViewIfNeeded();
    await tv.eventually(async () => queries(tv).length === 3 && await tv.page.locator('[aria-label="Loading more titles"]').count() === 0, "malformed append settled");
    assert.deepEqual(await grid(tv).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus"))), before);
    const count = queries(tv).length;
    await tv.jump(2000);
    assert.equal(queries(tv).length, count, "no automatic protocol retry");
    assert.equal(await tv.page.locator('[data-focus="retry"]').count(), 0, "Apple keeps a nonempty grid visible without an error panel");
    await grid(tv).first().scrollIntoViewIfNeeded();
    await tv.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await next(tv, 3);
});

journey("invalid cursor restarts filmography once without reloading metadata", async (tv, catalog) => {
    await all(tv);
    await next(tv, 2);
    catalog.personReplies.push(problem(400, "invalid_cursor", "Invalid cursor"));
    await grid(tv).last().scrollIntoViewIfNeeded();
    await tv.eventually(async () => await grid(tv).count() === 60, "restarted first page");
    assert.equal(queries(tv).length, 4, "one rejected continuation and one fresh first page");
    assert.equal(lastQuery(tv)?.body?.cursor, undefined);
    assert.equal(metadataReads(tv), 1);
    assert.equal(await tv.page.locator(".details-person-hero").count(), 1);
});

journey("interrupted Next cannot advance after visible-card Details, one resume handoff, and playback return", async tv => {
    await all(tv);
    const held = tv.fake.hold("/catalog/query", true);
    const before = queries(tv).length;
    await grid(tv).last().scrollIntoViewIfNeeded();
    await tv.eventually(async () => queries(tv).length === before + 1, "held Next");
    await tv.page.locator('.browse-grid [data-focus="movie:m0001"]').click();
    await tv.page.locator('[data-focus="resume"]').click();
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.plays.length) === 1, "fresh Resume handoff");
    assert.deepEqual(await tv.page.evaluate(() => window.browseHarness.plays), [{ contentId: "movie:m0001", fileId: "42", title: "The Last Signal", startSeconds: 1200, subtitle: { kind: "auto" } }]);
    await tv.page.evaluate(() => window.browseHarness.resume());
    await tv.page.locator('[data-focus="resume"]').waitFor();
    await tv.remote(BACK);
    assert.equal(await grid(tv).count(), 60);
    assert.equal(lastQuery(tv)?.body?.cursor, undefined, "Back keeps the committed page; the abandoned target never lands");
    held.release();
    await tv.jump(300);
    assert.equal(await tv.focused(), "movie:m0001");
    assert.equal(await grid(tv).count(), 60);
    assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 1);
    await tv.remote(BACK);
    await tv.eventually(async () => (await tv.focused())?.startsWith("credit:7:") === true, "origin after playback");
    assert.equal(metadataReads(tv), 1, "valid metadata survives playback refresh");
});

// PersonDetailView loads once (loadInitial is guarded by person == nil, items.isEmpty); its onAppear only resumes the metadata refresh.
journey("Details Back keeps every loaded page and the focused card without re-reading", async tv => {
    await all(tv);
    await next(tv, 2);
    const ids = await grid(tv).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus")));
    const opened = ids[5];
    assert.ok(opened);
    await tv.page.locator(`.browse-grid [data-focus="${opened}"]`).click();
    await tv.page.locator(".details-hero").waitFor();
    const count = queries(tv).length;
    await tv.remote(BACK);
    await tv.page.locator(".details-person-hero").waitFor();
    await tv.jump(300);
    assert.equal(await tv.focused(), opened);
    assert.equal(await grid(tv).count(), 120);
    assert.equal(queries(tv).length, count, "Back reads no filmography page");
    assert.equal(metadataReads(tv), 1);
    // The near-end trigger still loads the next page after returning.
    await next(tv, 3);
    assert.equal(queries(tv).length, count + 1);
});

journey("Details Back restarts the availability probes that opening Details aborted", async (tv, catalog) => {
    catalog.personCredits.set("7", ["movie:m0001"]);
    const probes = (): number => tv.fake.requests.filter(request => request.path.startsWith("/catalog/query") && request.body?.source === "person" && request.body?.limit === 1).length;
    const transport = tv.fake.fetch.bind(tv.fake);
    let holding = true;
    let releaseProbes = (): void => undefined;
    const held = new Promise<void>(resolve => { releaseProbes = resolve; });
    (tv.fake as { fetch: typeof tv.fake.fetch }).fetch = async (url, init) => {
        const body = typeof init.body === "string" ? JSON.parse(init.body) as { source?: string; limit?: number } : undefined;
        if (holding && body?.source === "person" && body.limit === 1) await held;
        return transport(url, init);
    };
    await tv.remote(BACK);
    await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().click();
    await tv.eventually(async () => await grid(tv).count() === 1, "movie credit before probes");
    assert.equal(await tv.page.locator('[data-focus^="filter:"]').count(), 3, "all chips while probes are out");
    await grid(tv).first().click();
    await tv.page.locator(".details-hero").waitFor();
    holding = false;
    releaseProbes();
    await tv.jump(300);
    const sent = probes();
    await tv.remote(BACK);
    await tv.page.locator(".details-person-hero").waitFor();
    await tv.eventually(async () => await tv.page.locator('[data-focus="filter:series"]').count() === 0, "Series hidden after the probes restart");
    assert.equal(probes(), sent + 2, "one probe per type, sent again on Back");
    assert.equal(await tv.page.locator('[data-focus="filter:movie"]').count(), 1);
});

journey("Details Back resumes the unfinished metadata refresh without re-reading the filmography", async tv => {
    await tv.remote(BACK);
    let complete = false;
    let dispatches = 0;
    let reads = 0;
    await tv.page.route("**/api/v2/catalog/people/7", route => {
        reads++;
        return route.fulfill({ json: { id: "7", name: "River Vale", bio: "Updated biography", birth_date: "1980-04-12", ...(complete ? { photo_url: "/art/river.svg" } : {}) } });
    });
    await tv.page.route("**/api/v2/catalog/people/7/refresh", route => {
        dispatches++;
        return route.fulfill({ status: 202, json: { status: "queued", person_id: "7" } });
    });
    await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().click();
    await tv.eventually(async () => dispatches === 1, "refresh dispatch");
    await grid(tv).first().click();
    await tv.page.locator(".details-hero").waitFor();
    const away = reads;
    await tv.jump(9000);
    assert.equal(reads, away, "polling stops while Details is open");
    const count = queries(tv).length;
    await tv.remote(BACK);
    await tv.page.getByText("Loading metadata", { exact: true }).waitFor();
    complete = true;
    await tv.jump(3000);
    await tv.eventually(async () => reads === away + 1 && await tv.page.getByText("Loading metadata", { exact: true }).count() === 0, "resumed poll completes");
    assert.equal(dispatches, 1, "the refresh is dispatched once per visit");
    assert.equal(queries(tv).length, count, "Back reads no filmography page");
});

// loadInitial re-runs while person == nil, so Back reads the person again but not the filmography.
journey("Details Back reads the person again when Details interrupted the first read", async tv => {
    await tv.remote(BACK);
    // Held by exact path: Details' own artwork and title reads cannot use it up.
    const held = tv.fake.hold("/catalog/people/7");
    await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().click();
    await tv.eventually(async () => await grid(tv).count() === 60, "credits before metadata");
    await tv.page.getByText("Loading metadata", { exact: true }).waitFor();
    assert.equal(metadataReads(tv), 2, "the held person read is the only one out");
    await grid(tv).first().click();
    await tv.page.locator(".details-hero").waitFor();
    const count = queries(tv).length;
    for (let attempt = 0; attempt < 3 && await tv.page.locator(".details-person-hero").count() === 0; attempt++) await tv.remote(BACK);
    await tv.page.locator(".details-person-hero").waitFor();
    await tv.eventually(async () => metadataReads(tv) === 3 && await tv.page.getByText("Loading metadata", { exact: true }).count() === 0, "person read again and hero filled");
    held.release();
    await tv.jump(300);
    assert.equal(metadataReads(tv), 3, "exactly one more person read");
    assert.equal(queries(tv).length, count, "Back reads no filmography page");
    assert.equal(await grid(tv).count(), 60);
});

journey("filter race fences old answer; failed and empty filters keep controls reachable", async (tv, catalog) => {
    await all(tv);
    const held = tv.fake.hold("/catalog/query", true);
    await tv.page.locator('[data-focus="filter:movie"]').click();
    await tv.eventually(async () => lastQuery(tv)?.body?.type === "movie", "held movie filter");
    await tv.page.locator('[data-focus="filter:series"]').click();
    await tv.eventually(async () => await grid(tv).count() === 3, "series results");
    held.release();
    await tv.jump(300);
    assert.equal(await grid(tv).count(), 3);
    assert.equal(await tv.focused(), "filter:series");
    catalog.personReplies.push(problem(500, "internal_error", "Synthetic filter failure"));
    await tv.page.locator('[data-focus="filter:movie"]').click();
    await failedFilmography(tv, "The server ran into a problem. Try again in a moment.");
    assert.equal(await tv.page.locator('[data-focus^="filter:"]').count(), 3);
    assert.equal(await tv.page.locator('[data-focus="filter:movie"]').getAttribute("aria-pressed"), "true");
    catalog.empty = true;
    await tv.page.locator('[data-focus="retry"]').click();
    await emptyFilmography(tv);
    await tv.page.locator('[data-focus="filter:movie"]').focus();
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.focused(), "filter:series");
    await tv.remote(BACK);
    assert.match(await tv.focused() ?? "", /^credit:7:/);
});

for (const action of ["unchanged filter focus", "moved focus", "Back and menu", "profile", "logout"]) journey(`initial slow filmography answer respects ${action}`, async tv => {
    const before = queries(tv).length;
    const held = tv.fake.hold("/catalog/query", true);
    await tv.remote(BACK);
    await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().click();
    await tv.eventually(async () => queries(tv).length === before + 1, "new visit initial read");
    await tv.jump(5000);
    await tv.page.locator('[aria-label="Loading titles"]').waitFor();
    assert.equal(await tv.page.locator('[aria-label="Loading titles"]').textContent(), "", "Apple reserves a clear loading frame");
    assert.equal(await tv.page.locator('[aria-label="Loading titles"]').evaluate(node => node.getBoundingClientRect().height), 420);
    if (action === "moved focus") {
        await tv.page.keyboard.press("ArrowRight");
        assert.equal(await tv.focused(), "filter:movie");
    } else if (action === "unchanged filter focus") {
        assert.equal(await tv.focused(), "filter:video");
    } else if (action === "Back and menu") {
        await tv.remote(BACK); await tv.remote(BACK);
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.keyboard.press("ArrowDown");
    } else if (action === "profile") await tv.page.evaluate(() => window.browseHarness.clearProfile());
    else await tv.page.evaluate(() => window.browseHarness.logout());
    const focus = await tv.focused();
    held.release();
    await tv.jump(300);
    if (action === "moved focus" || action === "unchanged filter focus") {
        await tv.eventually(async () => await grid(tv).count() === 60, "settled read");
        assert.equal(await tv.focused(), focus);
    } else if (action === "Back and menu") {
        assert.equal(await tv.focused(), focus);
        assert.equal(await grid(tv).count(), 0);
    } else {
        assert.equal(await tv.page.locator(".browse").count(), 0);
        assert.equal(await tv.page.locator("#successor").count(), 1);
    }
});

for (const motion of ["no-preference", "reduce"] as const) journey(`Person grid and viewport restoration with ${motion} motion`, async tv => {
    await tv.page.emulateMedia({ reducedMotion: motion });
    await grid(tv).first().focus();
    for (let i = 0; i < 3; i++) await tv.page.keyboard.press("ArrowDown");
    await tv.jump(300);
    const id = await tv.focused();
    const y = await tv.page.locator(".browse").evaluate(node => node.scrollTop);
    assert.ok(y > 100);
    await tv.page.keyboard.press("Enter");
    await tv.page.locator(".details-hero").waitFor();
    await tv.remote(BACK);
    await tv.jump(300);
    assert.equal(await tv.focused(), id);
    assert.equal(await tv.page.locator(".browse").evaluate(node => node.scrollTop), y);
});

journey("Series filmography retains season, episode, and authorized playback owners", async tv => {
    await all(tv);
    await tv.page.locator('[data-focus="filter:series"]').click();
    await tv.page.locator('.browse-grid [data-focus="series:s1"]').click();
    await tv.page.locator('[data-focus="season:1"]').click();
    await tv.page.locator('[data-focus="episode:s1e11"]').click();
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.plays.length === 1), "direct filmography episode handoff");
    const plays = await tv.page.evaluate(() => window.browseHarness.plays);
    assert.equal(plays.length, 1);
    assert.equal(plays[0]?.contentId, "episode:s1e11");
    assert.ok(plays[0]?.fileId);
    await tv.page.evaluate(() => window.browseHarness.resume());
    await tv.remote(BACK);
    await tv.eventually(async () => await grid(tv).count() === 3, "Series filmography after playback");
    assert.equal(await tv.focused(), "series:s1");
    assert.equal(metadataReads(tv), 1);
});

for (const outcome of ["pending", "lost"]) journey(`Details reconciles ${outcome} membership after filmography without duplicating its write`, async (tv, catalog) => {
    await tv.remote(BACK);
    await tv.page.getByRole("button", { name: "Add to watchlist", exact: true }).waitFor();
    const path = "/watchlist/movie%3Am0001";
    const held = outcome === "pending" ? tv.fake.hold(path, true) : undefined;
    if (outcome === "lost") tv.fake.dropNextAnswer(path);
    await tv.page.getByRole("button", { name: "Add to watchlist", exact: true }).click();
    await tv.eventually(async () => catalog.mutations.length === 1, "membership write");
    // A lost answer is Apple's Change Not Confirmed alert; the Watchlist circle keeps its label.
    if (outcome === "lost") {
        const alert = tv.page.getByRole("alertdialog", { name: "Change Not Confirmed", exact: true });
        await alert.waitFor();
        await alert.getByRole("button", { name: "OK", exact: true }).click();
        await alert.waitFor({ state: "detached" });
    }
    await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().click();
    await grid(tv).first().waitFor();
    await all(tv);
    await next(tv, 2);
    await tv.remote(BACK);
    held?.release();
    await tv.page.locator('[data-focus="watchlist"]').waitFor();
    assert.equal(await tv.page.locator('[data-focus="watchlist"]').innerText(), "Watchlist");
    await tv.page.locator('[data-focus="watchlist"]').click();
    if (outcome === "lost") {
        // A held change is never re-sent: the press shows the alert, and Discard reloads the committed state.
        const alert = tv.page.getByRole("alertdialog", { name: "Change Not Confirmed", exact: true });
        await alert.getByRole("button", { name: "Discard Held Change", exact: true }).click();
        await alert.waitFor({ state: "detached" });
    }
    await tv.page.getByRole("button", { name: "Remove from watchlist", exact: true }).waitFor();
    assert.equal(catalog.mutations.length, 1);
});

journey("person metadata errors recover, artwork falls back, and facts render as plain text", async tv => {
    await tv.remote(BACK);
    let response: Record<string, unknown> = { id: "7", name: "<b>River Vale</b>", bio: 7 };
    await tv.page.route("**/api/v2/catalog/people/7", route => route.fulfill({ status: 200, json: response }));
    await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().click();
    await personFailure(tv, "Something went wrong", "The server sent an answer this TV could not read.", ["retry"]);
    response = { id: "7", name: "<b>River Vale</b>", bio: "<img src=x onerror=alert(1)>", birthplace: "<script>synthetic</script>", future_metadata: { value: 7 } };
    await tv.page.locator('[data-focus="retry"]').click();
    await tv.page.getByText(response.name as string, { exact: true }).first().waitFor();
    await tv.page.getByText(response.bio as string, { exact: true }).waitFor();
    await tv.page.locator(".details-person-hero .browse-art-missing").waitFor();
    assert.equal(await tv.page.locator("#root script, #root b, #root img[src=x]").count(), 0);
    await all(tv);
    assert.equal(await tv.page.locator("h1").textContent(), "<b>River Vale</b>");
});

/** Apple rootContent: with no person, the read's failure is the whole page's ErrorView (PersonDetailView.swift:358-359). */
async function personFailure(tv: Tv, headline: string, message: string, actions: string[]): Promise<void> {
    const page = tv.page.locator('.browse .details-failure[role="alert"]');
    await page.waitFor();
    assert.equal(await page.locator(".search-state-title").textContent(), headline);
    assert.equal(await page.locator(".search-state-description").textContent(), message);
    assert.deepEqual(await page.locator("[data-focus]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus"))), actions);
    assert.equal(await tv.focused(), actions[0]);
    assert.equal(await tv.page.locator(".details-person-hero, .person-filmography-heading, [data-focus^='filter:']").count(), 0, "the error replaces the page");
}

for (const status of [404, 500]) journey(`person metadata ${status} shows Apple's ErrorView for the page`, async tv => {
    await tv.remote(BACK);
    await tv.page.route("**/api/v2/catalog/people/7", route => route.fulfill({ status, json: problem(status, status === 404 ? "not_found" : "internal_error", "Synthetic person failure").body }));
    await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().click();
    // ErrorView.recoveryPlan: a 404 leads with Go Back and keeps Try Again; any other failure offers only Try Again.
    if (status === 404) {
        await personFailure(tv, "Not found", "We couldn't find what you were looking for. It may have been removed or moved.", ["go-back", "retry"]);
        await tv.page.keyboard.press("Enter");
    } else {
        await personFailure(tv, "Something went wrong", "The server ran into a problem. Try again in a moment.", ["retry"]);
        // PersonDetailViewModel.reload clears the error first (PersonDetailView.swift:97): Try Again shows the loading page, not the old error.
        await tv.page.unroute("**/api/v2/catalog/people/7");
        const held = tv.fake.hold("/catalog/people/7", true);
        await tv.page.keyboard.press("Enter");
        await tv.jump(0);
        assert.equal(await tv.page.locator(".details-failure").count(), 0, "the old error stays up while the person reloads");
        assert.equal(await tv.page.locator(".details-person-hero").count(), 1);
        held.release();
        await tv.page.getByText("River Vale", { exact: true }).first().waitFor();
        await tv.remote(BACK);
    }
    assert.match(await tv.focused() ?? "", /^credit:7:/);
});

journey("filmography filter controls occupy their own space above the grid", async tv => {
    await all(tv);
    const bounds = await tv.page.locator(".browse").evaluate(node => {
        const filters = node.querySelector(".skyline-pills")?.getBoundingClientRect();
        const heading = node.querySelector(".person-filmography-heading")?.getBoundingClientRect();
        const cards = node.querySelector(".browse-grid")?.getBoundingClientRect();
        return { filtersTop: filters?.top ?? 0, filtersBottom: filters?.bottom ?? 0, headingBottom: heading?.bottom ?? 0, gridTop: cards?.top ?? 0 };
    });
    assert.ok(bounds.filtersTop >= bounds.headingBottom, "Person filters must not overlap the heading");
    assert.ok(bounds.gridTop >= bounds.filtersBottom, "filters reserve space before the cards");
    const reads = queries(tv).length;
    for (const key of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowUp", "ArrowUp", "ArrowUp", "ArrowUp", "ArrowUp"]) {
        await tv.page.keyboard.press(key);
        await tv.jump(250);
        const rect = await tv.page.evaluate(() => {
            const bounds = document.activeElement?.getBoundingClientRect();
            return { top: bounds?.top ?? -1, bottom: bounds?.bottom ?? 1081, focus: document.activeElement?.getAttribute("data-focus"), scroll: document.querySelector(".browse")?.scrollTop, time: performance.now() };
        });
        assert.ok(rect.top >= 0 && rect.bottom <= 1080, `remote focus remains in the viewport after ${key}: ${JSON.stringify(rect)}`);
    }
    assert.equal(queries(tv).length, reads + 1, "scrolling into the final eight rows loads one additional page");
});

journey("Person count labels preserve exact, approximate, singular and empty totals", async (tv, catalog) => {
    for (const [total, exact, label] of [[1, true, "1 title"], [37, false, "About 37 titles"], [0, true, "0 titles"]] as const) {
        catalog.personReplies.push({ status: 200, body: { items: [], total, total_exact: exact, window_cursor: "synthetic", page: { has_more: false } } });
        const filter = lastQuery(tv)?.body?.type === "movie" ? "series" : "movie";
        await tv.page.locator(`[data-focus="filter:${filter}"]`).click();
        await tv.page.getByText(label, { exact: true }).waitFor();
        assert.equal(metadataReads(tv), 1);
        assert.equal(await tv.page.locator(".details-person-hero").count(), 1);
    }
});

journey("failed initial works read retains metadata and filter recovery", async (tv, catalog) => {
    await tv.remote(BACK);
    catalog.personReplies.push(problem(500, "internal_error", "Synthetic first page failure"));
    await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().click();
    await failedFilmography(tv, "The server ran into a problem. Try again in a moment.");
    assert.equal(await tv.page.locator(".details-person-hero").count(), 1);
    assert.equal(await tv.page.locator('[data-focus^="filter:"]').count(), 3);
    const reads = metadataReads(tv);
    await tv.page.locator('[data-focus="filter:video"]').focus();
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), "retry", "Down follows the visible chips-to-Retry order");
    await tv.page.keyboard.press("Enter");
    await tv.page.getByText("124 titles", { exact: true }).waitFor();
    assert.equal(metadataReads(tv), reads);
});
