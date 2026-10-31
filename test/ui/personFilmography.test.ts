import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });
const BACK = 10009;
const grid = (tv: Tv) => tv.page.locator(".browse-grid .browse-card");
const queries = (tv: Tv) => tv.fake.requests.filter(request => request.path.startsWith("/catalog/query") && request.body?.source === "person");
const lastQuery = (tv: Tv) => queries(tv)[queries(tv).length - 1];
const metadataReads = (tv: Tv) => tv.fake.requests.filter(request => request.path === "/catalog/people/7").length;

function population(): FakeDetails {
    const catalog = new FakeDetails();
    // Series is wholly absent from the first 24 newest credits.
    for (const title of catalog.titles.values()) {
        if (title.type === "movie") catalog.add({ ...title, year: 2030 });
    }
    catalog.add({ id: "movie:other-copy/+", title: "Movie 0002", type: "movie", libraryId: "12", year: 2030 });
    catalog.personCredits.get("7")?.push("movie:other-copy/+", "movie:m0002");
    return catalog;
}

async function start(tv: Tv, catalog: FakeDetails): Promise<void> {
    tv.fake.catalog = catalog;
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
    assert.equal(await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner")), "selected");
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-focus="person:7"]').first().focus();
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await tv.page.locator('.browse[data-view="person:7"] .browse-row .browse-card').count() === 24, "person preview");
}

async function all(tv: Tv): Promise<void> {
    const seeAll = tv.page.getByRole("button", { name: "See all", exact: true });
    assert.equal(await seeAll.count(), 1, "the 25th accessible credit needs an explicit See all action");
    await seeAll.focus();
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await grid(tv).count() === 24, "full filmography first page");
}

async function next(tv: Tv, number: number): Promise<void> {
    await tv.page.locator('[data-focus="next"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.getByText(`Page ${number} of 3`, { exact: true }).waitFor();
}

function journey(name: string, body: (tv: Tv, catalog: FakeDetails) => Promise<void>): void {
    test(name, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            const catalog = population();
            await start(tv, catalog);
            await body(tv, catalog);
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}

journey("card quick-actions refresh full Filmography's committed page and retain nearby identity", async (tv, catalog) => {
    await all(tv);
    await next(tv, 2);
    const cards = await grid(tv).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus")));
    const id = cards[5];
    const nearby = cards[6];
    assert.ok(id); assert.ok(nearby);
    const cursor = lastQuery(tv)?.body?.cursor;
    await grid(tv).nth(5).focus();
    await tv.down(13); await tv.jump(650); await tv.up(13);
    const panel = tv.page.getByRole("dialog", { name: "Card actions" });
    await panel.getByRole("button", { name: "Add favorite", exact: true }).click();
    await panel.getByRole("button", { name: "Remove favorite", exact: true }).waitFor();
    catalog.removed.add(id);
    await tv.remote(BACK);
    await tv.eventually(async () => await tv.focused() === nearby, "nearby Filmography focus");
    assert.equal(lastQuery(tv)?.body?.cursor, cursor);
    assert.equal(lastQuery(tv)?.body?.person_id, "7");
    await tv.page.getByText("Page 2 of 3", { exact: true }).waitFor();
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
    await tv.page.locator('.browse-grid [data-focus="movie:m0002"] .browse-art-missing').waitFor();
    await tv.page.locator('.browse-grid [data-focus="movie:m0003"] .browse-art-missing').waitFor();
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
    await tv.eventually(async () => lastQuery(tv)?.body?.type === "movie" && await grid(tv).count() === 24, "movies");
    await tv.page.locator('[data-focus="filter:video"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => lastQuery(tv)?.body?.type === "video" && await grid(tv).count() === 24, "All");
    await next(tv, 2);
    await next(tv, 3);
    assert.equal(await grid(tv).count(), 16);
    const card = grid(tv).last();
    const id = await card.getAttribute("data-focus");
    await card.focus();
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await tv.page.locator(".browse").getAttribute("data-view") === `item:${id}`, "third-page Details");
    await tv.remote(BACK);
    await tv.page.getByText("Page 3 of 3", { exact: true }).waitFor();
    assert.equal(await tv.focused(), id);
    await tv.remote(BACK);
    await tv.eventually(async () => await tv.focused() === "see-all", "Person See all restoration");
    assert.equal(metadataReads(tv), 1);
    await tv.remote(BACK);
    await tv.eventually(async () => await tv.focused() === "person:7", "origin credit restoration");
    for (const request of queries(tv)) {
        assert.equal(request.method, "POST");
        assert.equal(request.body?.sort, "year");
        assert.equal(request.body?.order, "desc");
        assert.equal(request.body?.limit, 24);
        assert.equal(request.body?.person_id, "7");
        assert.equal(request.headers["x-profile-id"], "p-owner");
    }
    assert.equal(tv.fake.requests.filter(request => /search\/capabilities/.test(request.path)).length, 0);
});

journey("failed Next retains visible page and target for explicit Retry", async (tv, catalog) => {
    await all(tv);
    const ids = await grid(tv).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus")));
    catalog.personReplies.push(problem(500, "internal_error", "Synthetic lookup failure"));
    await tv.page.locator('[data-focus="next"]').click();
    await tv.page.locator('[data-focus="retry"]').waitFor();
    const target = lastQuery(tv)?.body?.cursor;
    assert.equal(typeof target, "string");
    assert.deepEqual(await grid(tv).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus"))), ids);
    const before = queries(tv).length;
    await tv.page.locator('[data-focus="retry"]').click();
    await tv.page.getByText("Page 2 of 3", { exact: true }).waitFor();
    assert.equal(queries(tv).length, before + 1);
    assert.equal(lastQuery(tv)?.body?.cursor, target);
});

for (const continuation of ["missing", "empty", "repeated"]) journey(`malformed ${continuation} continuation is recoverable and cannot silently end or loop`, async (tv, catalog) => {
    await all(tv);
    await next(tv, 2);
    const previous = lastQuery(tv)?.body?.cursor;
    const before = await grid(tv).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus")));
    catalog.personReplies.push({ status: 200, body: { items: [], total: 64, total_exact: true, window_cursor: "synthetic", page: { has_more: true,
        ...(continuation === "missing" ? {} : { next_cursor: continuation === "empty" ? "" : previous }) } } });
    await tv.page.locator('[data-focus="next"]').click();
    await tv.page.getByText("The server sent an answer this TV could not read.", { exact: true }).waitFor();
    assert.deepEqual(await grid(tv).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus"))), before);
    const count = queries(tv).length;
    await tv.jump(2000);
    assert.equal(queries(tv).length, count, "no automatic protocol retry");
    await tv.page.locator('[data-focus="retry"]').click();
    await tv.page.getByText("Page 3 of 3", { exact: true }).waitFor();
});

journey("invalid cursor discards only filmography paging; one explicit Retry starts page zero", async (tv, catalog) => {
    await all(tv);
    await next(tv, 2);
    catalog.personReplies.push(problem(400, "invalid_cursor", "Invalid cursor"));
    await tv.page.locator('[data-focus="next"]').click();
    await tv.page.getByText("The list changed. Try again.", { exact: true }).waitFor();
    assert.equal(await grid(tv).count(), 0);
    const count = queries(tv).length;
    await tv.jump(2000);
    assert.equal(queries(tv).length, count);
    await tv.page.locator('[data-focus="retry"]').click();
    await tv.page.getByText("Page 1 of 3", { exact: true }).waitFor();
    assert.equal(queries(tv).length, count + 1);
    assert.equal(lastQuery(tv)?.body?.cursor, undefined);
    await tv.remote(BACK);
    assert.equal(metadataReads(tv), 1);
    assert.equal(await tv.focused(), "see-all");
});

journey("interrupted Next cannot advance after visible-card Details, one resume handoff, and playback return", async tv => {
    await all(tv);
    const held = tv.fake.hold("/catalog/query", true);
    const before = queries(tv).length;
    await tv.page.locator('[data-focus="next"]').click();
    await tv.eventually(async () => queries(tv).length === before + 1, "held Next");
    await tv.page.locator('.browse-grid [data-focus="movie:m0001"]').click();
    await tv.page.locator('[data-focus="resume"]').click();
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.plays.length) === 1, "fresh Resume handoff");
    assert.deepEqual(await tv.page.evaluate(() => window.browseHarness.plays), [{ contentId: "movie:m0001", fileId: "42", title: "The Last Signal", startSeconds: 1200 }]);
    await tv.page.evaluate(() => window.browseHarness.resume());
    await tv.page.locator('[data-focus="resume"]').waitFor();
    await tv.remote(BACK);
    await tv.page.getByText("Page 1 of 3", { exact: true }).waitFor();
    assert.equal(lastQuery(tv)?.body?.cursor, undefined, "Back refreshes committed page, never abandoned target");
    held.release();
    await tv.jump(300);
    assert.equal(await tv.focused(), "movie:m0001");
    assert.equal(await tv.page.getByText("Page 1 of 3", { exact: true }).count(), 1);
    assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 1);
    await tv.remote(BACK);
    await tv.eventually(async () => await tv.focused() === "see-all", "Person after playback");
    assert.equal(metadataReads(tv), 1, "valid metadata survives playback refresh");
});

journey("refresh uses nearby card fallback on a committed later page", async (tv, catalog) => {
    await all(tv);
    await next(tv, 2);
    const ids = await grid(tv).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus")));
    const removed = ids[5];
    assert.ok(removed);
    await tv.page.locator(`.browse-grid [data-focus="${removed}"]`).click();
    await tv.page.locator(".details-hero").waitFor();
    catalog.removed.add(removed);
    const count = queries(tv).length;
    await tv.remote(BACK);
    await tv.eventually(async () => queries(tv).length === count + 1 && !await tv.page.locator(`.browse-grid [data-focus="${removed}"]`).count(), "refreshed membership");
    assert.equal(await tv.focused(), ids[6]);
    assert.equal(await tv.page.getByText("Page 2 of 3", { exact: true }).count(), 1);
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
    await tv.page.locator('[data-focus="retry"]').waitFor();
    assert.equal(await tv.page.locator('[data-focus^="filter:"]').count(), 3);
    assert.equal(await tv.page.locator('[data-focus="filter:movie"]').getAttribute("aria-pressed"), "true");
    catalog.empty = true;
    await tv.page.locator('[data-focus="retry"]').click();
    await tv.page.getByText("No available titles for this filter.", { exact: true }).waitFor();
    await tv.page.keyboard.press("ArrowUp");
    assert.equal(await tv.focused(), "back");
    await tv.remote(BACK);
    assert.equal(await tv.focused(), "see-all");
});

for (const action of ["moved focus", "Back and menu", "profile", "logout"]) journey(`initial slow filmography answer respects ${action}`, async tv => {
    const held = tv.fake.hold("/catalog/query", true);
    await tv.page.locator('[data-focus="see-all"]').click();
    await tv.eventually(async () => queries(tv).length === 1, "initial read");
    await tv.jump(5000);
    await tv.page.getByText("Still waiting for the server.", { exact: true }).waitFor();
    if (action === "moved focus") {
        await tv.page.keyboard.press("ArrowRight");
        assert.equal(await tv.focused(), "filter:movie");
    } else if (action === "Back and menu") {
        await tv.remote(BACK); await tv.remote(BACK); await tv.remote(BACK);
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.keyboard.press("ArrowDown");
    } else if (action === "profile") await tv.page.evaluate(() => window.browseHarness.clearProfile());
    else await tv.page.evaluate(() => window.browseHarness.logout());
    const focus = await tv.focused();
    held.release();
    await tv.jump(300);
    if (action === "moved focus") {
        await tv.eventually(async () => await grid(tv).count() === 24, "settled read");
        assert.equal(await tv.focused(), focus);
    } else if (action === "Back and menu") {
        assert.equal(await tv.focused(), focus);
        assert.equal(await grid(tv).count(), 0);
    } else {
        assert.equal(await tv.page.locator(".browse").count(), 0);
        assert.equal(await tv.page.locator("#successor").count(), 1);
    }
});

for (const motion of ["no-preference", "reduce"] as const) journey(`Person rail and viewport restoration with ${motion} motion`, async tv => {
    await tv.page.emulateMedia({ reducedMotion: motion });
    await tv.page.locator('.browse-row .browse-card').first().focus();
    for (let i = 0; i < 17; i++) await tv.page.keyboard.press("ArrowRight");
    await tv.jump(300);
    const railX = await tv.page.locator(".browse-row").evaluate(node => node.scrollLeft);
    assert.ok(railX > 100);
    await tv.page.locator('[data-focus="see-all"]').focus();
    await tv.page.keyboard.press("ArrowRight");
    await tv.page.keyboard.press("ArrowLeft");
    await tv.jump(300);
    const y = await tv.page.locator(".browse").evaluate(node => node.scrollTop);
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await grid(tv).count() === 24, "full page");
    await tv.remote(BACK);
    await tv.jump(300);
    assert.equal(await tv.focused(), "see-all");
    assert.equal(await tv.page.locator(".browse-row").evaluate(node => node.scrollLeft), railX);
    assert.equal(await tv.page.locator(".browse").evaluate(node => node.scrollTop), y);
});

journey("Series filmography retains season, episode, and authorized playback owners", async tv => {
    await all(tv);
    await tv.page.locator('[data-focus="filter:series"]').click();
    await tv.page.locator('.browse-grid [data-focus="series:s1"]').click();
    await tv.page.locator('[data-focus="season:1"]').click();
    await tv.page.locator('[data-focus="episode:s1e11"]').click();
    await tv.page.locator('[data-focus="play"]').click();
    const plays = await tv.page.evaluate(() => window.browseHarness.plays);
    assert.equal(plays.length, 1);
    assert.equal(plays[0]?.contentId, "episode:s1e11");
    assert.ok(plays[0]?.fileId);
    await tv.page.evaluate(() => window.browseHarness.resume());
    await tv.remote(BACK); await tv.remote(BACK); await tv.remote(BACK);
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
    if (outcome === "lost") await tv.page.getByRole("button", { name: "Retry watchlist", exact: true }).waitFor();
    await tv.page.locator('[data-focus="person:7"]').first().click();
    await tv.page.locator('[data-focus="see-all"]').waitFor();
    await all(tv);
    await next(tv, 2);
    await tv.remote(BACK); await tv.remote(BACK);
    held?.release();
    await tv.page.getByRole("button", { name: "Retry watchlist", exact: true }).click();
    await tv.page.getByRole("button", { name: "Remove from watchlist", exact: true }).waitFor();
    assert.equal(catalog.mutations.length, 1);
});

journey("person metadata errors recover, artwork falls back, and facts render as plain text", async tv => {
    await tv.remote(BACK);
    let response: Record<string, unknown> = { id: "7", name: "<b>River Vale</b>", bio: 7 };
    await tv.page.route("**/api/v2/catalog/people/7", route => route.fulfill({ status: 200, json: response }));
    await tv.page.locator('[data-focus="person:7"]').first().click();
    await tv.page.getByText("The server sent an answer this TV could not read.", { exact: true }).waitFor();
    assert.equal(await tv.page.locator('[data-focus="back"]').count(), 1);
    response = { id: "7", name: "<b>River Vale</b>", bio: "<img src=x onerror=alert(1)>", birthplace: "<script>synthetic</script>", future_metadata: { value: 7 } };
    await tv.page.locator('[data-focus="retry"]').click();
    await tv.page.getByText(response.name as string, { exact: true }).first().waitFor();
    await tv.page.getByText(response.bio as string, { exact: true }).waitFor();
    await tv.page.locator(".details-person-hero .browse-art-missing").waitFor();
    assert.equal(await tv.page.locator("#root script, #root b, #root img[src=x]").count(), 0);
    await all(tv);
    assert.equal(await tv.page.locator("h1").textContent(), "<b>River Vale</b> · Filmography");
});

for (const status of [404, 500]) journey(`person metadata ${status} keeps explicit retry and Back`, async tv => {
    await tv.remote(BACK);
    await tv.page.route("**/api/v2/catalog/people/7", route => route.fulfill({ status, json: problem(status, status === 404 ? "not_found" : "internal_error", "Synthetic person failure").body }));
    await tv.page.locator('[data-focus="person:7"]').first().click();
    await tv.page.locator('[data-focus="retry"]').waitFor();
    if (status === 404) await tv.page.getByText("This person is no longer available.", { exact: true }).waitFor();
    await tv.remote(BACK);
    assert.equal(await tv.focused(), "person:7");
});

journey("filmography filter controls occupy their own space above the grid", async tv => {
    await all(tv);
    const bounds = await tv.page.locator(".browse").evaluate(node => {
        const filters = node.querySelector(".skyline-pills")?.getBoundingClientRect();
        const actions = node.querySelector(".browse-actions")?.getBoundingClientRect();
        const cards = node.querySelector(".browse-grid")?.getBoundingClientRect();
        return { filtersTop: filters?.top ?? 0, filtersBottom: filters?.bottom ?? 0, actionsBottom: actions?.bottom ?? 0, gridTop: cards?.top ?? 0 };
    });
    assert.ok(bounds.filtersTop >= bounds.actionsBottom, "pushed-page filters must not overlap Back and Retry");
    assert.ok(bounds.gridTop >= bounds.filtersBottom, "filters reserve space before the cards");
    const reads = tv.fake.requests.length;
    for (const key of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowUp", "ArrowUp", "ArrowUp", "ArrowUp", "ArrowUp"]) {
        await tv.page.keyboard.press(key);
        await tv.jump(250);
        const rect = await tv.page.evaluate(() => {
            const bounds = document.activeElement?.getBoundingClientRect();
            return { top: bounds?.top ?? -1, bottom: bounds?.bottom ?? 1081 };
        });
        assert.ok(rect.top >= 0 && rect.bottom <= 1080, "remote focus remains in the viewport");
    }
    assert.equal(tv.fake.requests.length, reads, "remote movement never loads another page");
});
