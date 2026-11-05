import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

async function picker(tv: Tv): Promise<void> {
    await tv.page.fill("#signin-address", "silo.example.test");
    await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
    await tv.page.locator('[data-screen="code"]').waitFor();
    tv.fake.approve([...tv.fake.devices.keys()].pop() ?? "");
    await tv.jump(5000);
    // "Signed in as …" holds for a second before sign-in moves on.
    await tv.jump(1000);
    await tv.page.locator('[data-screen="profiles"]').waitFor();
}

async function selectKid(tv: Tv): Promise<void> {
    await tv.page.locator('[data-focus="profile:p-kid"]').click();
    await tv.page.fill("#profile-pin", "2468");
    await tv.page.locator('[data-focus="unlock"]').click();
}

test("one unprotected profile asks until Remember, including reload", async () => {
    const browser = await launchBrowser();
    const tv = await openTv(browser, { app: "application" });
    tv.fake.profiles = { ...tv.fake.profiles, items: (tv.fake.profiles.items as { id: string }[]).filter(p => p.id === "p-owner") };
    tv.fake.catalog = new FakeDetails();
    try {
        await picker(tv);
        await tv.page.locator('[data-focus="profile:p-owner"]').click();
        await tv.page.locator('[data-focus="ask-every-launch"]').click();
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.page.evaluate(() => { window.appHarness.destroy(); window.appHarness.mount(); });
        await tv.page.locator('[data-screen="profiles"]').waitFor();
        assert.equal(await tv.page.locator('[data-view="home"]').count(), 0);
    } finally { await tv.page.context().close(); await browser.close(); }
});

test("Change account from the composed picker preserves saved credentials and retires its screen", async () => {
    const browser = await launchBrowser();
    const tv = await openTv(browser, { app: "application" });
    try {
        await picker(tv);
        const saved = await tv.page.evaluate(() => window.appHarness.keyManager.items.size);
        assert.ok(saved > 0);
        await tv.page.getByRole("button", { name: "Change account", exact: true }).click();
        await tv.page.locator('[data-view="change-account"]').waitFor();
        assert.equal(await tv.page.locator('.account-card:focus').count(), 1);
        assert.equal(await tv.page.locator('[data-screen="profiles"]').count(), 0);
        assert.equal(await tv.page.evaluate(() => window.appHarness.keyManager.items.size), saved);
        assert.equal(tv.fake.revokedSessions.size, 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); await browser.close(); }
});

test("Change Account waits for a profile instead of reopening a remembered profile", async () => {
    const browser = await launchBrowser();
    const tv = await openTv(browser, { app: "application" });
    tv.fake.catalog = new FakeDetails();
    try {
        await picker(tv); await selectKid(tv);
        await tv.page.locator('[data-screen="remember-profile"]').waitFor();
        await tv.page.keyboard.press("Enter");
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.getByRole("menuitem", { name: "Change Account", exact: true }).click();
        await tv.page.locator('.account-card').first().click();
        await tv.page.locator('[data-screen="profiles"]').waitFor();
        assert.equal(await tv.page.locator('[data-view="home"]').count(), 0);
    } finally { await tv.page.context().close(); await browser.close(); }
});

test("Settings Accounts uses pane rows and Back returns to Settings", async () => {
    const browser = await launchBrowser();
    const tv = await openTv(browser, { app: "application" });
    tv.fake.catalog = new FakeDetails();
    try {
        await picker(tv); await selectKid(tv);
        await tv.page.locator('[data-focus="ask-every-launch"]').click();
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await tv.page.locator('[data-focus="server"]').click();
        assert.deepEqual(await tv.page.locator('.settings-pane').evaluate(node => [...node.children].filter(child => child.matches('h2, h3, button')).map(child => child.textContent)), ["Server", "ACTIVE SERVER", "Accounts", "Manage Servers", "ABOUT", "Acknowledgements"]);
        await tv.page.getByRole("button", { name: "Accounts", exact: true }).click();
        await tv.page.locator('[data-view="accounts-settings"]').waitFor();
        const pane = await tv.page.evaluate(() => {
            const row = document.querySelector('.accounts-settings button')!;
            const remove = document.querySelector('.accounts-settings [data-focus^="remove:"]')!;
            return { header: getComputedStyle(document.querySelector('.accounts-settings h1')!).fontSize,
                icon: document.querySelector('.accounts-settings-header [aria-hidden="true"]') !== null,
                x: row.getBoundingClientRect().x, y: row.getBoundingClientRect().y,
                addGap: document.querySelector('[data-focus="add-server"]')!.getBoundingClientRect().y - remove.getBoundingClientRect().y,
                footnote: getComputedStyle(document.querySelector('.accounts-settings > p')!).fontSize,
                height: row.getBoundingClientRect().height, chevron: row.querySelector('.accounts-chevron svg') !== null,
                arrow: row.querySelector('.accounts-chevron path')!.getBoundingClientRect().toJSON(),
                section: getComputedStyle(document.querySelector('.accounts-settings h2')!).fontSize,
                red: getComputedStyle(remove).color, destructiveChevron: remove.querySelector('.accounts-chevron') !== null };
        });
        assert.equal(pane.header, "42px");
        assert.equal(pane.icon, true);
        assert.equal(pane.height, 66);
        assert.equal(pane.chevron, true);
        assert.equal(pane.arrow.width, 7);
        assert.equal(pane.arrow.height, 14);
        // The 1.8px stroke adds 0.9px on each edge: painted bounds are 9 by 16 at x1231.
        assert.equal(pane.arrow.x, 1232);
        assert.equal(pane.section, "19px");
        assert.equal(pane.x, 186);
        assert.equal(pane.y, 290);
        assert.equal(pane.addGap, 92);
        assert.equal(pane.footnote, "20px");
        assert.equal(pane.red, "rgb(176, 0, 32)");
        assert.equal(pane.destructiveChevron, false);
        await tv.remote(10009);
        await tv.page.locator('[data-view="settings"]').waitFor();
        assert.equal(await tv.focused(), "general");
        await tv.page.locator('[data-focus="server"]').click();
        await tv.page.getByRole("button", { name: "Manage Servers", exact: true }).click();
        await tv.page.locator('[data-view="change-account"]').waitFor();
        await tv.remote(10009);
        await tv.remote(10009);
        await tv.page.locator('[data-view="settings"]').waitFor();
        assert.equal(await tv.focused(), "manage-servers");
        await tv.remote(10009);
        assert.equal(await tv.focused(), "server");
        await tv.remote(10009);
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.getByRole("menuitem", { name: "Change Account", exact: true }).click();
        await tv.page.locator('.account-card').first().click();
        await tv.page.locator('[data-screen="profiles"]').waitFor();
        await tv.page.locator('[data-focus="profile:p-kid"]').click();
        await tv.page.locator('[data-screen="pin"]').waitFor();
    } finally { await tv.page.context().close(); await browser.close(); }
});

test("Accounts Back stays usable after signing out the active account", async () => {
    const browser = await launchBrowser();
    const tv = await openTv(browser, { app: "application" });
    tv.fake.catalog = new FakeDetails();
    try {
        await picker(tv); await selectKid(tv);
        await tv.page.locator('[data-focus="ask-every-launch"]').click();
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await tv.page.locator('[data-focus="server"]').click();
        await tv.page.getByRole("button", { name: "Accounts", exact: true }).click();
        await tv.page.locator('.accounts-settings button').first().click();
        await tv.page.locator('[data-focus="confirm"]').click();
        await tv.page.locator('[data-view="accounts-settings"]').waitFor();
        await tv.remote(10009);
        await tv.page.locator('[data-view="change-account"]').waitFor();
        assert.equal(await tv.focused(), "add-server");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); await browser.close(); }
});

test("temporary creation from a remembered profile preserves its launch choice and picker badge", async () => {
    const browser = await launchBrowser();
    const tv = await openTv(browser, { app: "application" });
    tv.fake.catalog = new FakeDetails();
    try {
        await picker(tv); await selectKid(tv);
        await tv.page.locator('[data-screen="remember-profile"]').waitFor();
        await tv.page.keyboard.press("Enter");
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.locator('[data-focus="switch-profile"]').click();
        await tv.page.locator('[data-screen="profiles"]').waitFor();
        await tv.page.locator('[data-focus="profile:p-kid"] .profile-remembered').waitFor();
        await tv.page.getByRole("button", { name: "Add profile", exact: true }).click();
        await tv.page.locator('[data-screen="profile-create"]').waitFor();
        await tv.remote(10009);
        await tv.page.locator('[data-screen="profiles"]').waitFor();
        assert.equal(await tv.focused(), "add-profile");
        await tv.page.locator('[data-focus="profile:p-kid"] .profile-remembered').waitFor();
        const attempts = tv.fake.pinAttempts;
        await tv.page.evaluate(() => window.appHarness.mount());
        await tv.page.locator('[data-view="home"]').waitFor();
        assert.equal(tv.fake.pinAttempts, attempts);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); await browser.close(); }
});

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
        await tv.page.locator('[data-focus="remember-profile"]').click();
        await tv.page.getByRole("radio", { name: "Every Time", exact: true }).click();
        await tv.page.getByRole("button", { name: /Profile Selection.*Every Time/ }).waitFor();
        await tv.remote(10009); await tv.remote(10009);
        await tv.page.evaluate(() => window.appHarness.mount());
        await tv.page.locator('[data-screen="profiles"]').waitFor();
        await tv.page.locator('[data-focus="profile:p-kid"]').click();
        await tv.page.locator("#profile-pin").waitFor();
        assert.equal(tv.fake.pinAttempts, attempts);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); await browser.close(); }
});

test("dismissed Settings launch save preserves the current General control focus", async () => {
    const browser = await launchBrowser();
    const tv = await openTv(browser, { app: "application" });
    tv.fake.catalog = new FakeDetails();
    new FakeSettings(tv.fake);
    try {
        await picker(tv); await selectKid(tv);
        await tv.page.locator('[data-focus="ask-every-launch"]').click();
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.locator('[data-focus="settings"]').click();
        await tv.page.locator('[data-focus="remember-profile"]').click();
        await tv.page.evaluate(() => {
            const hold = window.appHarness.keyManager.holdSaves();
            Object.assign(window, { launchSaveHold: hold });
        });
        await tv.page.getByRole("radio", { name: "Automatic", exact: true }).click();
        await tv.page.getByText("Saving launch choice…", { exact: true }).waitFor();
        await tv.remote(10009);
        await tv.page.locator('[data-focus="hidden"]').focus();
        await tv.page.evaluate(() => {
            const held = window as unknown as { launchSaveHold: { waiting(): number; release(): void } };
            if (held.launchSaveHold.waiting() !== 1) throw new Error("expected one pending protected save");
            held.launchSaveHold.release();
        });
        await tv.page.getByRole("button", { name: /Profile Selection.*Automatic/ }).waitFor();
        assert.equal(await tv.focused(), "hidden");
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
