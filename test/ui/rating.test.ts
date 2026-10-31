import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv } from "./support/tv.ts";

test("title rating uses remote focus, confirmed saves, visible failure, explicit retry and Back", async () => {
    const browser = await launchBrowser();
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeDetails();
    tv.fake.catalog = catalog;
    try {
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(async () => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount());
        await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
        await tv.page.getByText("Your rating: Not rated", { exact: true }).waitFor();
        await tv.page.locator('[data-focus="watchlist"]').focus();
        await tv.remote(40);
        assert.equal(await tv.focused(), "rating:1");
        await tv.remote(39); await tv.page.keyboard.press("Enter");
        await tv.page.getByText("Your rating: 2 of 5 stars", { exact: true }).waitFor();
        catalog.ratingFailure = problem(500, "failed", "Failed");
        await tv.remote(39); await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("alert").filter({ hasText: "Could not confirm rating" }).waitFor();
        const count = catalog.mutations.length;
        await tv.jump(5000);
        assert.equal(catalog.mutations.length, count);
        await tv.page.locator('[data-focus="rating:retry"]').click();
        await tv.page.getByText("Your rating: 3 of 5 stars", { exact: true }).waitFor();
        await tv.page.locator('[data-focus="rating:clear"]').click();
        await tv.page.getByText("Your rating: Not rated", { exact: true }).waitFor();
        await tv.remote(10009);
        await tv.page.locator('[data-view="home"]').waitFor();
    } finally { await tv.page.context().close(); await browser.close(); }
});
