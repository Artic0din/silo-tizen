import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeHome } from "../native/support/fakeHome.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

function journey(name: string, body: (tv: Tv, catalog: FakeHome) => Promise<void>): void {
    test(name, async () => {
        const tv = await openTv(browser, { app: "browse" });
        const catalog = new FakeHome();
        tv.fake.catalog = catalog;
        try {
            await tv.page.emulateMedia({ reducedMotion: "reduce" });
            await tv.page.evaluate(() => window.browseHarness.connect());
            await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
            tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
            await tv.jump(5000);
            await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase) === "signed_in", "sign in");
            await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
            await tv.page.evaluate(() => window.browseHarness.mount());
            await tv.page.locator('[data-view="home"] [data-section]').first().waitFor();
            await body(tv, catalog);
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}

journey("Home folds existing recommendations after Continue, ignores featured and preserves additive rows", async tv => {
    assert.deepEqual(await tv.page.locator('[data-section]').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-section"))), ["resume/opaque", "because/opaque", "for/you", "recent/12", "future/opaque"]);
    assert.equal(await tv.focused(), "movie:m0001");
    assert.equal(await tv.page.locator('.skyline-marquee h1').innerText(), "Movie 0001");
    const count = tv.fake.requests.length;
    await tv.page.keyboard.press("ArrowRight");
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(tv.fake.requests.length, count, "no focus reads");
    assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/recommendations")).length, 0, "no duplicate recommendations feed");
});

journey("Home See All pages 24 cards, keeps opaque cursors and restores origin focus and scroll", async (tv, catalog) => {
    const expand = tv.page.locator('[data-section="recent/12"] [data-focus="expand:recent/12"]');
    assert.equal(await expand.count(), 1, "Home exposes row expansion");
    await expand.focus();
    await tv.page.keyboard.press("ArrowLeft");
    const card = await tv.focused();
    await tv.page.keyboard.press("ArrowRight");
    await tv.jump(300);
    const origin = await tv.page.locator('.skyline-content').evaluate(node => node.scrollTop);
    const rowLeft = await tv.page.locator('[data-section="recent/12"] .browse-row').evaluate(node => node.scrollLeft);
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-view="homeSection:recent/12"] .browse-card').first().waitFor();
    assert.equal(await tv.page.locator('.browse .browse-card').count(), 24);
    assert.deepEqual(catalog.queries[0], { source: "section", scope: "home", section_id: "recent/12", limit: 24 });
    await tv.page.getByRole("button", { name: "Next page", exact: true }).click();
    await tv.page.getByText("Page 2 of 3", { exact: true }).waitFor();
    assert.equal(await tv.page.locator('.browse .browse-card').count(), 24);
    assert.equal(catalog.queries[1]?.cursor, "opaque:/+second==");
    assert.equal(await tv.page.locator('.browse-card').first().getAttribute("data-focus"), "movie:m0025");
    const requests = tv.fake.requests.length;
    await tv.page.keyboard.press("ArrowUp");
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(tv.fake.requests.length, requests);
    await tv.remote(10009);
    assert.equal(await tv.focused(), "expand:recent/12");
    assert.equal(await tv.page.locator('.skyline-content').evaluate(node => node.scrollTop), origin);
    assert.equal(await tv.page.locator('[data-section="recent/12"] .browse-row').evaluate(node => node.scrollLeft), rowLeft);
    await tv.page.keyboard.press("ArrowLeft");
    assert.equal(await tv.focused(), card);
    const query = tv.fake.requests.find(request => request.path.startsWith("/catalog/query"));
    assert.equal(query?.headers["x-profile-id"], "p-owner");
    assert.match(query?.headers.authorization ?? "", /^Bearer /);
});

journey("Home playback return discards an abandoned expanded-row page turn", async (tv, catalog) => {
    await tv.page.locator('[data-focus="expand:recent/12"]').click();
    await tv.page.locator('[data-view="homeSection:recent/12"] .browse-card').first().waitFor();
    const held = tv.fake.hold("/catalog/query", true);
    await tv.page.locator('[data-focus="next"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => catalog.queries.length === 2, "pending second page");
    await tv.page.locator('.browse [data-focus="movie:m0001"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
    await tv.page.locator('.browse [data-focus="play"]').click();
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.plays.length) === 1, "playback handoff");
    await tv.page.evaluate(() => window.browseHarness.resume());
    await tv.page.locator('.browse [data-focus="play"]').waitFor();
    const refresh = tv.fake.hold("/catalog/query", true);
    await tv.remote(10009);
    await tv.eventually(async () => catalog.queries.length === 3, "held return refresh");
    const cached = await tv.page.locator('.browse [data-focus="movie:m0001"]').elementHandle();
    assert.ok(cached);
    held.release();
    refresh.release();
    await tv.eventually(async () => await cached.evaluate(node => !node.isConnected), "expanded-row refresh rendered");
    assert.equal(await tv.page.locator('.browse').getByText("Page 1 of 3", { exact: true }).count(), 1);
    assert.equal(await tv.focused(), "movie:m0001");
    assert.equal(catalog.queries[catalog.queries.length - 1]?.cursor, undefined, "return refreshes the committed page");
    assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 1);
});

journey("Home expansion invalid cursor retains reachable Retry and Back and restarts only on activation", async (tv, catalog) => {
    const expand = tv.page.locator('[data-focus="expand:recent/12"]');
    assert.equal(await expand.count(), 1, "Home exposes row expansion");
    await expand.click();
    await tv.page.locator('[data-view="homeSection:recent/12"] .browse-card').first().waitFor();
    // Fail before dispatching the scoped fake's next reply.
    let invalid = true;
    await tv.page.route("**/api/v2/catalog/query?*", async route => {
        if (invalid) { invalid = false; await route.fulfill({ status: 400, contentType: "application/problem+json", json: problem(400, "invalid_cursor", "Invalid cursor").body }); }
        else await route.fallback();
    });
    await tv.page.getByRole("button", { name: "Next page", exact: true }).click();
    await tv.page.getByRole("alert").waitFor();
    const before = catalog.queries.length;
    await tv.jump(30000);
    assert.equal(catalog.queries.length, before);
    await tv.page.getByRole("button", { name: "Try again", exact: true }).click();
    await tv.page.locator('[data-view="homeSection:recent/12"] .browse-card').first().waitFor();
    assert.equal(catalog.queries[catalog.queries.length - 1]?.cursor, undefined);
    await tv.remote(10009);
    assert.equal(await tv.focused(), "expand:recent/12");
});

for (const [id, activation, position] of [["movie:m0001", "Enter", 321.5], ["episode:s1e12", "pointer", 1195]] as const) {
    journey(`Continue ${id} resolves authorised chosen version once (${activation})`, async (tv, catalog) => {
        catalog.progress.set(id, position);
        const item = tv.page.locator(`[data-section="resume/opaque"] [data-focus="${id}"]`);
        const held = tv.fake.hold(`/catalog/items/${encodeURIComponent(id)}`, true);
        await item.focus();
        if (activation === "pointer") await item.click(); else await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => tv.fake.requests.some(request => request.path.split("?")[0] === `/catalog/items/${encodeURIComponent(id)}`), "authorised detail resolution");
        assert.equal(await tv.page.locator('[data-view^="item:"]').count(), 0, "Details never flashes");
        assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 0);
        held.release();
        await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.plays.length) === 1, "one player handoff");
        assert.deepEqual(await tv.page.evaluate(() => window.browseHarness.plays[0]), { contentId: id, fileId: "chosen", title: id === "movie:m0001" ? "Movie 0001" : "Harbor Lights chapter 1.2", startSeconds: position === 1195 ? undefined : position, ...(id === "episode:s1e12" ? { episode: true } : {}) });
        await tv.page.keyboard.press("Enter");
        await tv.jump(30000);
        assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 1);
        const request = tv.fake.requests.find(request => request.path.split("?")[0] === `/catalog/items/${encodeURIComponent(id)}`);
        assert.equal(request?.headers["x-profile-id"], "p-owner");
        await tv.page.evaluate(() => window.browseHarness.resume());
        await tv.page.locator('[data-view="home"]').waitFor();
        assert.equal(await tv.focused(), id);
        assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 1, "returning never replays");
    });
}

for (const mode of ["missing", "restricted", "unreadable", "mismatch"] as const) {
    journey(`Continue ${mode} leaves Retry and Back without playback`, async (tv, catalog) => {
        catalog.detailMode = mode;
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("alert").waitFor();
        assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 0);
        assert.equal(await tv.page.locator('[data-view^="item:"]').count(), 0);
        catalog.detailMode = "normal";
        await tv.page.getByRole("button", { name: "Try again", exact: true }).click();
        await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.plays.length) === 1, "explicit retry resolves");
    });
}

for (const cancel of ["Back", "profile", "logout"] as const) {
    journey(`Continue ${cancel} cancels an already processed late answer`, async tv => {
        const held = tv.fake.hold("/catalog/items/movie%3Am0001", true);
        await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => tv.fake.requests.some(request => request.path.split("?")[0] === "/catalog/items/movie%3Am0001"), "resolution");
        if (cancel === "Back") await tv.remote(10009);
        else if (cancel === "logout") await tv.page.evaluate(() => window.browseHarness.logout());
        else await tv.page.evaluate(() => window.browseHarness.clearProfile());
        held.release();
        await tv.jump(30000);
        assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 0);
        if (cancel === "Back") { assert.equal(await tv.focused(), "movie:m0001"); assert.equal(await tv.page.locator('[data-view="home"]').count(), 1); }
        else assert.equal(await tv.page.locator('.browse').count(), 0);
    });
}

journey("Continue network failure never sends playback and Retry resolves only on activation", async tv => {
    tv.offline = true;
    await tv.page.keyboard.press("Enter");
    await tv.jump(1000);
    await tv.page.getByRole("alert").waitFor();
    assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 0);
    tv.offline = false;
    await tv.jump(30000);
    assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 0);
    await tv.page.getByRole("button", { name: "Try again", exact: true }).click();
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.plays.length) === 1, "explicit network retry");
});

journey("expanded Continue keeps episode cards and resumes while ordinary rows still open Details", async tv => {
    await tv.page.locator('[data-focus="expand:resume/opaque"]').click();
    await tv.page.locator('[data-view="homeSection:resume/opaque"] [data-focus="episode:s1e12"]').click();
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.plays.length) === 1, "expanded episode handoff");
    await tv.page.evaluate(() => window.browseHarness.resume());
    await tv.page.locator('[data-view="homeSection:resume/opaque"] .browse-card').first().waitFor();
    assert.equal(await tv.focused(), "episode:s1e12");
    await tv.remote(10009);
    await tv.page.locator('[data-section="because/opaque"] .browse-card').click();
    await tv.page.locator('[data-view="item:movie:m0005"]').waitFor();
    assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 1);
});

journey("Home expansion empty, missing and failed reads retain reachable controls", async (tv, catalog) => {
    const home = catalog.households.get("p-owner");
    assert.ok(home);
    const recent = home.sections.find(row => row.id === "recent/12");
    assert.ok(recent);
    recent.items = [];
    await tv.page.locator('[data-focus="expand:recent/12"]').click();
    await tv.page.getByText("No titles available.", { exact: true }).waitFor();
    assert.equal(await tv.focused(), "back");
    await tv.remote(10009);
    home.sections = home.sections.filter(row => row !== recent);
    await tv.page.locator('[data-focus="expand:recent/12"]').click();
    await tv.page.getByRole("alert").waitFor();
    assert.equal(await tv.page.getByRole("button", { name: "Try again", exact: true }).count(), 1);
    await tv.remote(10009);
    assert.equal(await tv.focused(), "expand:recent/12");
});
