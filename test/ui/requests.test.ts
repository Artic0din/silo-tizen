import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeRequests } from "../native/support/fakeRequests.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

async function start(tv: Tv, catalog: FakeRequests): Promise<void> {
    tv.fake.catalog = catalog;
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "sign-in");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.eventually(async () => await tv.page.locator('.browse[data-view="home"] .browse-card').count() > 0, "Home");
}
function requestsTest(name: string, body: (tv: Tv, catalog: FakeRequests) => Promise<void>, setup?: (catalog: FakeRequests, tv: Tv) => void): void {
    test(name, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            const catalog = new FakeRequests();
            setup?.(catalog, tv);
            await start(tv, catalog);
            await body(tv, catalog);
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}
const view = (tv: Tv, name: string) => tv.page.locator(`.browse[data-view="${name}"]`);
async function shown(tv: Tv, name: string, text?: string): Promise<void> {
    await tv.eventually(async () => await view(tv, name).count() === 1 && (text === undefined || (await view(tv, name).textContent())?.includes(text) === true), `${name}${text === undefined ? "" : ` with ${text}`}`);
}
/** Focus by key then press Enter, as the remote does after arrowing to it. */
async function press(tv: Tv, key: string): Promise<void> {
    // A route entering its transition can refuse focus for a frame; only press once it has landed.
    await tv.eventually(async () => await tv.page.locator(".browse").locator("[data-focus]").evaluateAll((nodes, key) => {
        const node = nodes.find(node => node.getAttribute("data-focus") === key);
        if (!(node instanceof HTMLElement)) throw new Error(`Missing target ${key}`);
        node.focus({ preventScroll: true });
        return document.activeElement === node;
    }, key), `focus on ${key}`);
    await tv.page.keyboard.press("Enter");
}
const paths = (tv: Tv, from = 0) => tv.fake.requests.slice(from).filter(request => request.path.startsWith("/requests")).map(request => `${request.method} ${request.path}`);
async function openHub(tv: Tv): Promise<void> {
    await press(tv, "requests");
    await shown(tv, "requests:hub", "Trending Movies");
}

requestsTest("a disabled capability hides the Requests root and Home still works", async tv => {
    assert.equal(await tv.page.locator('.browse-nav [data-focus="requests"]').count(), 0);
    assert.deepEqual(paths(tv), ["GET /requests/status"], "only the capability is read");
}, catalog => catalog.disable());

requestsTest("an unreadable status keeps the root hidden without failing Home", async tv => {
    assert.equal(await tv.page.locator('.browse-nav [data-focus="requests"]').count(), 0);
    assert.deepEqual(paths(tv), ["GET /requests/status", "GET /requests/status"], "one transport retry, then Home carries on");
}, (_, tv) => { tv.fake.script("/requests/status", problem(503, "unavailable", "Down"), problem(503, "unavailable", "Down")); });

requestsTest("remote journey: hub rows, detail, one create, and focus returns to the card", async (tv, catalog) => {
    assert.equal(await tv.page.locator('.browse-nav [data-focus="requests"]').getAttribute("role"), "tab");
    await openHub(tv);
    assert.deepEqual(paths(tv).slice(1), ["GET /requests/status", "GET /requests/discover"]);
    const hub = view(tv, "requests:hub");
    assert.equal(await hub.locator('[data-section="trending_movies"] .browse-card').count(), 20);
    assert.equal(await hub.locator('[data-section="trending_movies"] [data-focus="more"]').count(), 1, "a long built-in row offers See all");
    assert.equal(await hub.getByText("Unknown row").count(), 0, "unknown row types are skipped");
    assert.deepEqual(await hub.locator('[data-focus^="brand:"]').allTextContents(), ["Studios", "Genres"]);
    const before = tv.fake.requests.length;
    await tv.page.locator('[data-section="trending_movies"] [data-focus="movie:1001"]').focus();
    for (let i = 0; i < 3; i++) await tv.page.keyboard.press("ArrowRight");
    await tv.page.keyboard.press("ArrowDown");
    await tv.page.keyboard.press("ArrowUp");
    assert.equal(tv.fake.requests.length, before, "focus moves never fetch");
    assert.equal(await tv.focused(), "movie:1004");
    await tv.page.keyboard.press("Enter");
    await shown(tv, "requests:detail:movie:1004", "Request Movie 4 overview.");
    assert.equal(await tv.focused(), "back", "focus stays where the loading view put it");
    await tv.page.keyboard.press("ArrowLeft");
    assert.equal(await tv.focused(), "create");
    await tv.page.keyboard.press("Enter");
    await shown(tv, "requests:detail:movie:1004", "Requested.");
    await tv.eventually(async () => await view(tv, "requests:detail:movie:1004").locator('[data-focus="cancel"]').count() === 1, "Cancel offered after the reread");
    assert.equal(paths(tv, before).filter(path => path === "POST /requests").length, 1);
    assert.equal(catalog.requests[0]?.profile, "p-owner");
    assert.equal(tv.fake.requests.find(request => request.path === "/requests")?.headers["x-profile-id"], "p-owner");
    await tv.remote(10009);
    await shown(tv, "requests:hub");
    assert.equal(await tv.focused(), "movie:1004", "Back restores the card that opened the detail");
    await tv.eventually(async () => (await tv.page.locator('[data-section="trending_movies"] [data-focus="movie:1004"]').textContent())?.includes("Pending") === true, "the stale hub rereads");
    await tv.remote(10009);
    assert.equal(await tv.focused(), "requests", "Back from the root content goes to its nav tab");
});

requestsTest("loading, failure, Retry and Back on the hub and the detail", async tv => {
    const hold = tv.fake.hold("/requests/discover");
    await press(tv, "requests");
    await shown(tv, "requests:hub", "Loading");
    hold.release();
    await shown(tv, "requests:hub", "Trending Movies");
    await press(tv, "movie:1002");
    await shown(tv, "requests:detail:movie:1002", "Request Movie 2 overview.");
    await tv.remote(10009);
    tv.fake.script("/requests/detail/movie/1002", problem(500, "internal", "Broken"));
    await press(tv, "movie:1002");
    await shown(tv, "requests:detail:movie:1002", "Try again in a moment");
    assert.equal(await tv.focused(), "back");
    await press(tv, "retry");
    await shown(tv, "requests:detail:movie:1002", "Request Movie 2 overview.");
    await tv.remote(10009);
    await shown(tv, "requests:hub");
    assert.equal(await tv.focused(), "movie:1002");
    await press(tv, "mine");
    await shown(tv, "requests:mine", "Heat");
    tv.fake.script("/requests/mine?limit=24", problem(503, "unavailable", "Down"), problem(503, "unavailable", "Down"));
    await tv.remote(10009);
    await press(tv, "mine");
    await shown(tv, "requests:mine", "The server had a problem");
    await press(tv, "retry");
    await shown(tv, "requests:mine", "Processing · 43%");
});

requestsTest("search submits once on Enter, shows empty results, and opens a result", async tv => {
    await openHub(tv);
    await press(tv, "find");
    await shown(tv, "requests:search");
    const field = tv.page.locator("#requests-search");
    await field.focus();
    const before = tv.fake.requests.length;
    await tv.page.keyboard.type("zzz");
    assert.equal(tv.fake.requests.length, before, "typing does not search");
    await tv.page.keyboard.press("Enter");
    await shown(tv, "requests:search", 'No results for "zzz".');
    await field.fill("northern");
    await tv.page.keyboard.press("Enter");
    await shown(tv, "requests:search", "Northern Line");
    assert.deepEqual(paths(tv, before), ["GET /requests/search?q=zzz&page=1", "GET /requests/search?q=northern&page=1"]);
    await press(tv, "series:1399");
    await shown(tv, "requests:detail:series:1399", "Approved");
    await tv.remote(10009);
    await shown(tv, "requests:search", "Northern Line");
    assert.equal(await tv.focused(), "series:1399");
    assert.equal(await field.inputValue(), "northern");
});

requestsTest("follow, unfollow and cancel are single explicit writes", async (tv, catalog) => {
    await openHub(tv);
    await press(tv, "find");
    await tv.page.locator("#requests-search").fill("northern");
    await tv.page.locator("#requests-search").focus();
    await tv.page.keyboard.press("Enter");
    await shown(tv, "requests:search", "Northern Line");
    await press(tv, "series:1399");
    await shown(tv, "requests:detail:series:1399", "Approved");
    await press(tv, "follow");
    await shown(tv, "requests:detail:series:1399", "Following.");
    await tv.eventually(async () => await tv.page.locator('[data-focus="unfollow"]').count() === 1, "Unfollow offered");
    await press(tv, "unfollow");
    await shown(tv, "requests:detail:series:1399", "No longer following.");
    await tv.eventually(async () => await tv.page.locator('[data-focus="follow"]').count() === 1, "Follow offered again");
    assert.deepEqual(paths(tv).filter(path => !path.startsWith("GET")), ["PUT /requests/follows/series/1399", "DELETE /requests/follows/series/1399"]);
    await tv.remote(10009); await tv.remote(10009);
    await shown(tv, "requests:hub");
    await press(tv, "mine");
    await shown(tv, "requests:mine", "Pending");
    await press(tv, "request:r-2");
    await shown(tv, "requests:detail:movie:950", "Pending");
    await press(tv, "cancel");
    await shown(tv, "requests:detail:movie:950", "Request cancelled.");
    assert.equal(catalog.requests.find(request => request.id === "r-2")?.outcome, "cancelled");
    await tv.remote(10009);
    await shown(tv, "requests:mine", "Cancelled");
    assert.equal(await tv.focused(), "request:r-2");
});

requestsTest("a lost create answer is reported, not replayed, and the reread shows it landed", async tv => {
    await openHub(tv);
    await press(tv, "movie:1003");
    await shown(tv, "requests:detail:movie:1003", "Request Movie 3 overview.");
    tv.fake.dropNextAnswer("/requests");
    await press(tv, "create");
    await shown(tv, "requests:detail:movie:1003", "did not confirm the change");
    await tv.eventually(async () => await tv.page.locator('[data-focus="cancel"]').count() === 1, "reread shows the landed request");
    assert.equal(paths(tv).filter(path => path === "POST /requests").length, 1);
    assert.equal(await tv.page.locator('[data-focus="create"]').count(), 0, "nothing to press twice");
});

requestsTest("the old state cannot be pressed again while the post-write reread is out", async tv => {
    await openHub(tv);
    await press(tv, "movie:1008");
    await shown(tv, "requests:detail:movie:1008", "Request Movie 8 overview.");
    const reread = tv.fake.hold("/requests/detail/movie/1008");
    await press(tv, "create");
    await shown(tv, "requests:detail:movie:1008", "Requested.");
    assert.equal(await tv.page.locator('[data-focus="create"]').getAttribute("aria-disabled"), "true");
    await press(tv, "create");
    await tv.remote(10009);
    await shown(tv, "requests:hub");
    await press(tv, "movie:1008");
    await shown(tv, "requests:detail:movie:1008", "Pending");
    reread.release();
    assert.equal(paths(tv).filter(path => path === "POST /requests").length, 1, "neither a second press nor a reopened detail resends");
});

requestsTest("a page turn abandoned for a detail completes on return", async tv => {
    await openHub(tv);
    await press(tv, "more");
    await shown(tv, "requests:results:trending_movies", "Page 1 of 3");
    const turn = tv.fake.hold("/requests/discover/trending_movies");
    await press(tv, "next");
    await shown(tv, "requests:results:trending_movies", "Loading the page.");
    await press(tv, "movie:1002");
    await shown(tv, "requests:detail:movie:1002", "Request Movie 2 overview.");
    turn.release();
    await tv.remote(10009);
    await shown(tv, "requests:results:trending_movies", "Page 2 of 3");
    await press(tv, "next");
    await shown(tv, "requests:results:trending_movies", "Page 3 of 3");
});

requestsTest("Requests turning off closes its routes and hides the root", async (tv, catalog) => {
    await openHub(tv);
    await press(tv, "movie:1005");
    await shown(tv, "requests:detail:movie:1005", "Request Movie 5 overview.");
    catalog.disable();
    await press(tv, "create");
    await shown(tv, "home");
    assert.equal(await tv.page.locator('.browse-nav [data-focus="requests"]').count(), 0);
    assert.equal(paths(tv).filter(path => path === "POST /requests").length, 1, "the refused write is not resent");
});

requestsTest("a capability refusal on any Requests read closes every Requests route", async (tv, catalog) => {
    await openHub(tv);
    await press(tv, "brand:genres");
    await shown(tv, "requests:brands:genres", "Drama");
    catalog.disable("not_configured");
    await press(tv, "brand:drama");
    await shown(tv, "home");
    assert.equal(await tv.page.locator('.browse-nav [data-focus="requests"]').count(), 0);
    await tv.remote(10009);
    assert.equal(await view(tv, "home").count(), 1, "no Requests route is left behind Home");
});

requestsTest("genre and studio browse pages page by provider page and keep focus on return", async tv => {
    await openHub(tv);
    await press(tv, "brand:genres");
    await shown(tv, "requests:brands:genres", "Comedy");
    await press(tv, "type:series");
    assert.equal(await tv.page.locator('[data-focus="type:series"]').getAttribute("aria-pressed"), "true");
    await press(tv, "brand:drama");
    await shown(tv, "requests:results:genres:drama", "Request Movie 11");
    assert.ok(paths(tv).includes("GET /requests/discover/browse/genre/drama?media_type=series&page=1"));
    await press(tv, "next");
    await shown(tv, "requests:results:genres:drama", "Request Movie 31");
    assert.equal(await tv.focused(), "movie:1031", "a new page starts at its first card");
    await press(tv, "previous");
    await shown(tv, "requests:results:genres:drama", "Page 1 of 2");
    await tv.remote(10009);
    await shown(tv, "requests:brands:genres");
    assert.equal(await tv.focused(), "brand:drama");
    await tv.remote(10009);
    await press(tv, "more");
    await shown(tv, "requests:results:trending_movies", "Page 1 of 3");
    assert.ok(paths(tv).includes("GET /requests/discover/trending_movies?page=1"));
});

requestsTest("late answers are dropped after Back and after a profile change", async tv => {
    await openHub(tv);
    const hold = tv.fake.hold("/requests/detail/movie/1006", true);
    await press(tv, "movie:1006");
    await shown(tv, "requests:detail:movie:1006", "Loading");
    await tv.remote(10009);
    await shown(tv, "requests:hub");
    hold.release();
    await tv.jump(0);
    assert.equal(await tv.focused(), "movie:1006");
    assert.equal(await view(tv, "requests:hub").count(), 1, "the late detail never draws");
    const second = tv.fake.hold("/requests/detail/movie/1007", true);
    await press(tv, "movie:1007");
    await shown(tv, "requests:detail:movie:1007", "Loading");
    await tv.page.evaluate(() => window.browseHarness.clearProfile());
    await tv.eventually(async () => await tv.page.locator("#successor").count() === 1 && await tv.page.locator(".browse").count() === 0, "profile change removes browse");
    second.release();
    await tv.jump(0);
    assert.equal(await tv.page.locator(".browse").count(), 0);
});
