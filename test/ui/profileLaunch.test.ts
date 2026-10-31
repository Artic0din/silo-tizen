import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

async function picker(tv: Tv): Promise<void> {
    await tv.page.fill("#signin-address", "silo.example.test");
    await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
    await tv.page.locator('[data-screen="code"]').waitFor();
    tv.fake.approve([...tv.fake.devices.keys()].pop() ?? "");
    await tv.jump(5000);
    await tv.page.locator('[data-screen="profiles"]').waitFor();
}

async function selectKid(tv: Tv): Promise<void> {
    await tv.page.locator('[data-focus="profile:p-kid"]').click();
    await tv.page.fill("#profile-pin", "2468");
    await tv.page.locator('[data-focus="unlock"]').click();
}

test("fresh TV offers remember; protected restart skips PIN; Settings opt-out restores picker", async () => {
    const browser = await launchBrowser();
    const tv = await openTv(browser, { app: "application" });
    tv.fake.catalog = new FakeDetails();
    try {
        await picker(tv); await selectKid(tv);
        await tv.page.locator('[data-screen="remember-profile"]').waitFor();
        assert.equal(await tv.focused(), "remember");
        await tv.page.keyboard.press("Enter");
        await tv.page.locator('[data-view="home"]').waitFor();
        const attempts = tv.fake.pinAttempts;
        await tv.page.evaluate(() => window.appHarness.mount());
        await tv.page.locator('[data-view="home"]').waitFor();
        assert.equal(tv.fake.pinAttempts, attempts);
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.locator('[data-focus="settings"]').click();
        await tv.page.getByRole("button", { name: "Launch profile: Remember this profile", exact: true }).click();
        await tv.page.getByRole("button", { name: "Launch profile: Ask who's watching", exact: true }).waitFor();
        await tv.remote(10009); await tv.remote(10009);
        await tv.page.evaluate(() => window.appHarness.mount());
        await tv.page.locator('[data-screen="profiles"]').waitFor();
        await tv.page.locator('[data-focus="profile:p-kid"]').click();
        await tv.page.locator("#profile-pin").waitFor();
        assert.equal(tv.fake.pinAttempts, attempts);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); await browser.close(); }
});

test("remember save failure is visible, Retry is explicit, and Back keeps picker usable", async () => {
    const browser = await launchBrowser();
    const tv = await openTv(browser, { app: "application" });
    tv.fake.catalog = new FakeDetails();
    try {
        await picker(tv); await selectKid(tv);
        await tv.page.locator('[data-screen="remember-profile"]').waitFor();
        await tv.page.evaluate(() => { window.appHarness.keyManager.failSave = true; });
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("alert").filter({ hasText: "Could not save" }).waitFor();
        assert.equal(await tv.page.locator('[data-view="home"]').count(), 0);
        await tv.remote(10009);
        await tv.page.locator('[data-screen="profiles"]').waitFor();
        await tv.page.locator('[data-focus="profile:p-kid"]').click();
        await tv.page.locator('[data-screen="remember-profile"]').waitFor();
        await tv.page.evaluate(() => { window.appHarness.keyManager.failSave = false; });
        await tv.page.keyboard.press("Enter");
        await tv.page.locator('[data-view="home"]').waitFor();
        assert.equal(tv.fake.requests.filter(request => request.path.endsWith("/verify-pin")).length, 1);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); await browser.close(); }
});

test("blocked preference storage offers Continue without saving and still asks after restart", async () => {
    const browser = await launchBrowser();
    const tv = await openTv(browser, { app: "application" });
    tv.fake.catalog = new FakeDetails();
    try {
        await picker(tv);
        await tv.page.locator('[data-focus="profile:p-owner"]').click();
        await tv.page.locator('[data-screen="remember-profile"]').waitFor();
        await tv.page.evaluate(() => { window.appHarness.storage.failSet = true; });
        await tv.page.locator('[data-focus="ask-every-launch"]').click();
        await tv.page.getByRole("alert").filter({ hasText: "Could not save" }).waitFor();
        await tv.page.locator('[data-focus="continue-session"]').click();
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.page.evaluate(() => { window.appHarness.storage.failSet = false; window.appHarness.mount(); });
        await tv.page.locator('[data-screen="profiles"]').waitFor();
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); await browser.close(); }
});
