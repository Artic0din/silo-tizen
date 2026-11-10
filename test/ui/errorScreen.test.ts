import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser, Route } from "playwright";
import { FakeHome } from "../native/support/fakeHome.ts";
import { PROBLEM_BASE } from "../native/support/fakeSilo.ts";
import { homeDetailsRead, launchBrowser, openTv, type Tv } from "./support/tv.ts";

const BACK = 10009;
const CARD = '[data-section="recent/12"] [data-focus="movie:m0004"]';
const NOT_FOUND = "We couldn't find what you were looking for. It may have been removed or moved.";
const SERVER_PROBLEM = { type: "about:blank", title: "Server error", status: 500 };

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

function journey(name: string, body: (tv: Tv, catalog: FakeHome) => Promise<void>, offerSignOut = false): void {
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
            await tv.page.evaluate(offer => window.browseHarness.mount(offer), offerSignOut);
            await tv.page.locator('[data-view="home"] [data-section]').first().waitFor();
            await homeDetailsRead(tv);
            await body(tv, catalog);
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}

/** The error page's headline, message and buttons, top to bottom. */
async function errorPage(tv: Tv): Promise<{ headline: string; message: string; buttons: string[]; title: number }> {
    const page = tv.page.locator(".details-failure");
    await page.waitFor();
    return {
        headline: await page.locator(".search-state-title").innerText(),
        message: await page.locator(".search-state-description").innerText(),
        buttons: await page.locator(".browse-button").evaluateAll(nodes => nodes.map(node => node.textContent ?? "")),
        title: await tv.page.locator(".browse-title, .section-catalog-title").count(),
    };
}

/** Every D-pad direction keeps focus on one of the page's buttons, and Up/Down walk the column. */
async function assertColumnFocus(tv: Tv, keys: readonly string[]): Promise<void> {
    assert.equal(await tv.focused(), keys[0]);
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp"]) {
        await tv.page.keyboard.press(key);
        assert.equal(await tv.focused(), keys[0], `${key} keeps focus on the first button`);
    }
    for (const key of keys.slice(1)) {
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), key);
    }
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), keys.at(-1), "Down at the last button keeps focus");
    for (const key of keys.slice(0, -1).reverse()) {
        await tv.page.keyboard.press("ArrowUp");
        assert.equal(await tv.focused(), key);
    }
}

journey("a missing title shows Apple's Not found page with Go Back first and Try Again second", async (tv, catalog) => {
    catalog.removed.add("movie:m0004");
    await tv.page.locator(CARD).click();
    await tv.page.locator('[data-view="item:failed"]').waitFor();
    assert.deepEqual(await errorPage(tv), { headline: "Not found", message: NOT_FOUND, buttons: ["Go Back", "Try Again"], title: 0 });
    assert.equal(await tv.page.locator(".details-failure").getAttribute("role"), "alert");
    await assertColumnFocus(tv, ["go-back", "retry"]);
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-view="home"]').waitFor();
    assert.equal(await tv.focused(), "movie:m0004", "Go Back restores the card that opened the title");
});

journey("Try Again on a missing title reads it again and opens it once it returns", async (tv, catalog) => {
    catalog.removed.add("movie:m0004");
    await tv.page.locator(CARD).click();
    await tv.page.locator('[data-view="item:failed"]').waitFor();
    catalog.removed.delete("movie:m0004");
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), "retry");
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-view="item:movie:m0004"]').waitFor();
    assert.equal(await tv.page.locator(".details-failure").count(), 0);
    assert.notEqual(await tv.focused(), null, "the opened title owns focus");
});

journey("the remote's Back leaves a Not found page to the card that opened it", async (tv, catalog) => {
    catalog.removed.add("movie:m0004");
    await tv.page.locator(CARD).click();
    await tv.page.locator('[data-view="item:failed"]').waitFor();
    await tv.remote(BACK);
    await tv.page.locator('[data-view="home"]').waitFor();
    assert.equal(await tv.focused(), "movie:m0004");
});

journey("a refused title shows Apple's Not allowed page with the server's reason, Go Back and Try Again", async tv => {
    const refusal = { type: `${PROBLEM_BASE}permission_denied`, title: "Forbidden", status: 403, detail: "This title is not available to this profile." };
    await tv.page.route("**/api/v2/catalog/items/movie%3Am0004**", route => route.fulfill({ status: 403, contentType: "application/problem+json", body: JSON.stringify(refusal) }));
    await tv.page.locator(CARD).click();
    await tv.page.locator('[data-view="item:failed"]').waitFor();
    assert.deepEqual(await errorPage(tv), { headline: "Not allowed", message: "This title is not available to this profile.", buttons: ["Go Back", "Try Again"], title: 0 });
    await assertColumnFocus(tv, ["go-back", "retry"]);
});

journey("a failed Explore all page shows Apple's error with only Try Again, and Back and Try Again recover", async (tv, catalog) => {
    let failing = true;
    const failSection = async (route: Route): Promise<void> => {
        if (failing && route.request().method() === "POST" && route.request().postDataJSON()?.source === "section") {
            await route.fulfill({ status: 500, contentType: "application/problem+json", body: JSON.stringify(SERVER_PROBLEM) });
            return;
        }
        await route.fallback();
    };
    await tv.page.route("**/api/v2/catalog/query**", failSection);
    await tv.page.locator('[data-focus="expand:recent/12"]').click();
    const shown = await errorPage(tv);
    assert.equal(shown.headline, "Something went wrong");
    assert.deepEqual(shown.buttons, ["Try Again"], "no Back button: the remote's Back leaves");
    assert.equal(shown.title, 0, "the error replaces the page, title included");
    await assertColumnFocus(tv, ["retry"]);
    await tv.remote(BACK);
    await tv.page.locator('[data-view="home"]').waitFor();
    assert.equal(await tv.focused(), "expand:recent/12", "Back restores the Explore all card");
    await tv.page.keyboard.press("Enter");
    await errorPage(tv);
    failing = false;
    const reads = catalog.queries.length;
    await tv.page.keyboard.press("Enter");
    await tv.page.locator(".section-catalog-grid .browse-card").first().waitFor();
    assert.equal(catalog.queries.length, reads + 1, "Try Again reads the row once");
    assert.equal(await tv.page.locator(".details-failure").count(), 0);
    assert.match(await tv.focused() ?? "", /^movie:/, "focus moves to the first title once it loads");
});

journey("an expired session on Explore all offers Sign In Again first and Try Again second", async tv => {
    await tv.page.route("**/api/v2/catalog/query**", route => route.request().method() === "POST" && route.request().postDataJSON()?.source === "section"
        ? route.fulfill({ status: 401, contentType: "application/problem+json", body: JSON.stringify({ type: "about:blank", title: "Unauthorized", status: 401 }) })
        : route.fallback());
    await tv.page.locator('[data-focus="expand:recent/12"]').click();
    const shown = await errorPage(tv);
    assert.equal(shown.headline, "Session expired");
    assert.deepEqual(shown.buttons, ["Sign In Again", "Try Again"]);
    await assertColumnFocus(tv, ["sign-in", "retry"]);
    await tv.page.keyboard.press("ArrowUp");
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.signOutCalls) === 1, "Sign In Again signs out");
}, true);

/** The Samsung TV simulator's platform rule; the error page must still draw the app's body font. */
const PLATFORM_FONT = "*{font-family:SamsungOne;font-weight:600}";

async function assertAppFont(tv: Tv): Promise<void> {
    const fonts = await tv.page.evaluate(() => {
        // app.css gives body `var(--silo-font)`; this harness loads only theme and browse styles, so a probe stands in for body.
        const probe = document.createElement("span");
        probe.style.fontFamily = "var(--silo-font)";
        document.body.appendChild(probe);
        const body = getComputedStyle(probe).fontFamily;
        probe.remove();
        const page = document.querySelector(".details-failure");
        const nodes = page === null ? [] : [page.querySelector(".search-state-title"), page.querySelector(".search-state-description"), ...page.querySelectorAll(".browse-button")];
        return { body, nodes: nodes.map(node => node === null ? "missing" : getComputedStyle(node).fontFamily) };
    });
    assert.ok(fonts.nodes.length >= 3, "title, message and a button");
    for (const font of fonts.nodes) assert.equal(font, fonts.body);
    assert.equal(await tv.page.locator(".details-failure .search-state-description").evaluate(node => getComputedStyle(node).fontWeight), "400");
}

journey("the Not found and Explore all error pages keep the app's font under the platform's font rule", async (tv, catalog) => {
    await tv.page.addStyleTag({ content: PLATFORM_FONT });
    catalog.removed.add("movie:m0004");
    await tv.page.locator(CARD).click();
    await tv.page.locator('[data-view="item:failed"]').waitFor();
    await assertAppFont(tv);
    await tv.remote(BACK);
    await tv.page.locator('[data-view="home"]').waitFor();
    await tv.page.route("**/api/v2/catalog/query**", route => route.request().method() === "POST" && route.request().postDataJSON()?.source === "section"
        ? route.fulfill({ status: 500, contentType: "application/problem+json", body: JSON.stringify(SERVER_PROBLEM) })
        : route.fallback());
    await tv.page.locator('[data-focus="expand:recent/12"]').click();
    await errorPage(tv);
    await assertAppFont(tv);
});
