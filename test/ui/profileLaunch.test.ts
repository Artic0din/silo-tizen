import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { pressPin } from "./support/pin.ts";
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

/** Remounts the app and returns the name of the profile that launch opens without the picker. */
async function relaunchedProfile(tv: Tv): Promise<string | null> {
    await tv.page.evaluate(() => window.appHarness.mount());
    await tv.page.locator('[data-view="home"]').waitFor();
    assert.equal(await tv.page.locator('[data-screen="profiles"]').count(), 0, "launch skips the picker");
    await tv.page.locator('[data-focus="profiles"]').click();
    return tv.page.locator(".skyline-profile-title").textContent();
}

async function selectKid(tv: Tv): Promise<void> {
    await tv.page.locator('[data-focus="profile:p-kid"]').click();
    await pressPin(tv.page, "2468");
}

test("one unprotected profile opens directly, including after Ask who's watching", async () => {
    const browser = await launchBrowser();
    const tv = await openTv(browser, { app: "application" });
    tv.fake.profiles = { ...tv.fake.profiles, items: (tv.fake.profiles.items as { id: string }[]).filter(p => p.id === "p-owner") };
    tv.fake.catalog = new FakeDetails();
    try {
        await tv.page.fill("#signin-address", "silo.example.test");
        await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
        await tv.page.locator('[data-screen="code"]').waitFor();
        tv.fake.approve([...tv.fake.devices.keys()].pop() ?? "");
        await tv.jump(5000);
        await tv.jump(1000);
        // ProfileSelectionView.openOnlyProfileIfNeeded: one profile and no PIN skips Who's watching.
        await tv.page.locator('[data-screen="remember-profile"]').waitFor();
        assert.equal(await tv.page.locator('[data-screen="profiles"]').count(), 0);
        await tv.page.locator('[data-focus="ask-every-launch"]').click();
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.page.evaluate(() => { window.appHarness.destroy(); window.appHarness.mount(); });
        await tv.page.locator('[data-view="home"]').waitFor();
        assert.equal(await tv.page.locator('[data-screen="profiles"]').count(), 0);
    } finally { await tv.page.context().close(); await browser.close(); }
});

test("Try again after a failed launch load still opens the only unprotected profile", async () => {
    const browser = await launchBrowser();
    const tv = await openTv(browser, { app: "application" });
    tv.fake.profiles = { ...tv.fake.profiles, items: (tv.fake.profiles.items as { id: string }[]).filter(p => p.id === "p-owner") };
    tv.fake.catalog = new FakeDetails();
    try {
        await tv.page.fill("#signin-address", "silo.example.test");
        await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
        await tv.page.locator('[data-screen="code"]').waitFor();
        tv.fake.approve([...tv.fake.devices.keys()].pop() ?? "");
        await tv.jump(5000);
        await tv.jump(1000);
        await tv.page.locator('[data-focus="ask-every-launch"]').click();
        await tv.page.locator('[data-view="home"]').waitFor();
        tv.offline = true;
        await tv.page.evaluate(() => { window.appHarness.destroy(); window.appHarness.mount(); });
        await tv.page.locator('[data-screen="profiles-error"]').waitFor({ timeout: 5000 });
        tv.offline = false;
        await tv.page.locator('[data-focus="retry"]').click();
        await tv.page.locator('[data-view="home"], [data-screen="profiles"]').first().waitFor({ timeout: 5000 });
        assert.equal(await tv.page.locator('[data-screen="profiles"]').count(), 0, "Retry keeps the single-profile skip");
        await tv.page.locator('[data-view="home"]').waitFor();
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
        assert.deepEqual(await tv.page.locator('.settings-pane').evaluate(node => [...node.children].filter(child => child.matches('h2, h3, button')).map(child => child.textContent)), ["ACTIVE SERVER", "Accounts", "ABOUT", "Privacy Policy", "Acknowledgements", "EXTRA FEATURES", "Watch PartyOff"]);
        await tv.page.getByRole("button", { name: "Accounts", exact: true }).click();
        await tv.page.locator('[data-view="accounts-settings"]').waitFor();
        const pane = await tv.page.evaluate(() => {
            const row = document.querySelector<HTMLElement>('.accounts-settings button')!;
            const remove = document.querySelector<HTMLElement>('.accounts-settings [data-focus^="remove:"]')!;
            // The focused row scales from its centre. Layout figures below divide that out.
            const painted = row.getBoundingClientRect();
            const scale = new DOMMatrix(getComputedStyle(row).transform).a || 1;
            const unscaled = (node: Element) => {
                const box = node.getBoundingClientRect();
                const cx = painted.x + painted.width / 2;
                const cy = painted.y + painted.height / 2;
                return { x: cx + (box.x - cx) / scale, y: cy + (box.y - cy) / scale, width: box.width / scale, height: box.height / scale };
            };
            const layout = unscaled(row);
            return { header: getComputedStyle(document.querySelector('.accounts-settings h1')!).fontSize,
                icon: document.querySelector('.accounts-settings-header [aria-hidden="true"]') !== null,
                x: layout.x, y: layout.y, scale,
                addGap: document.querySelector('[data-focus="add-server"]')!.getBoundingClientRect().y - remove.getBoundingClientRect().y,
                footnote: getComputedStyle(document.querySelector('.accounts-settings > p')!).fontSize,
                height: layout.height, chevron: row.querySelector('.accounts-chevron svg') !== null,
                arrow: unscaled(row.querySelector('.accounts-chevron path')!),
                section: getComputedStyle(document.querySelector('.accounts-settings h2')!).fontSize,
                red: getComputedStyle(remove).color, destructiveChevron: remove.querySelector('.accounts-chevron') !== null };
        });
        assert.equal(pane.header, "42px");
        assert.equal(pane.icon, true);
        assert.equal(pane.scale, 1.012);
        const near = (actual: number, expected: number, what: string): void => {
            assert.ok(Math.abs(actual - expected) < 0.05, `${what}: ${actual}`);
        };
        near(pane.height, 66, "row height");
        assert.equal(pane.chevron, true);
        near(pane.arrow.width, 7, "chevron width");
        near(pane.arrow.height, 14, "chevron height");
        // The 1.8px stroke adds 0.9px on each edge: painted bounds are 9 by 16 at x1231.
        near(pane.arrow.x, 1232, "chevron x");
        assert.equal(pane.section, "19px");
        near(pane.x, 186, "row x");
        near(pane.y, 290, "row y");
        assert.equal(pane.addGap, 92);
        assert.equal(pane.footnote, "20px");
        assert.equal(pane.red, "rgb(176, 0, 32)");
        assert.equal(pane.destructiveChevron, false);
        await tv.remote(10009);
        await tv.page.locator('[data-view="settings"]').waitFor();
        assert.equal(await tv.focused(), "general");
        await tv.page.locator('[data-focus="server"]').click();
        assert.equal(await tv.page.getByRole("button", { name: "Manage Servers", exact: true }).count(), 0, "Accounts owns server management");
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

test("Switch Profile during an outage shows retry and keeps the remembered profile's cached Home", async () => {
    const browser = await launchBrowser();
    const tv = await openTv(browser, { app: "application" });
    tv.fake.catalog = new FakeDetails();
    try {
        await picker(tv);
        await selectKid(tv);
        await tv.page.locator('[data-screen="remember-profile"]').waitFor();
        await tv.page.keyboard.press("Enter");
        await tv.page.locator('[data-view="home"] .browse-card').first().waitFor();
        const snapshot = await tv.page.evaluate(() => window.appHarness.storage.getItem("silo.browseSnapshots.v1"));
        assert.match(snapshot ?? "", /\/home\/sections/);
        const devices = tv.fake.devices.size;
        const revoked = tv.fake.revokedSessions.size;
        const secrets = await tv.page.evaluate(() => window.appHarness.keyManager.items.size);
        const accounts = await tv.page.evaluate(() => window.appHarness.storage.getItem("silo.native.accounts.v1"));
        tv.offline = true;
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.locator('[data-focus="switch-profile"]').click();
        await tv.page.locator('[data-screen="profiles-error"]').waitFor({ timeout: 5000 });
        assert.equal(await tv.page.locator('[data-view="home"]').count(), 0, "Switch Profile must not restore the remembered profile");
        assert.equal(await tv.focused(), "retry");
        await tv.page.getByText("Could not reach the server. Check the TV's internet connection, then try again.", { exact: true }).waitFor();
        assert.equal(await tv.page.evaluate(() => window.appHarness.storage.getItem("silo.browseSnapshots.v1")), snapshot);
        assert.equal(await tv.page.evaluate(() => window.appHarness.storage.getItem("silo.native.accounts.v1")), accounts);
        assert.equal(await tv.page.evaluate(() => window.appHarness.keyManager.items.size), secrets);
        assert.equal(tv.fake.devices.size, devices, "a network failure must not start a device code");
        assert.equal(tv.fake.revokedSessions.size, revoked, "a network failure must not sign out");
        await tv.remote(10009);
        await tv.page.locator('[data-view="home"] .browse-card').first().waitFor();
        assert.equal(await tv.page.evaluate(() => window.appHarness.storage.getItem("silo.browseSnapshots.v1")), snapshot);
        assert.equal(tv.fake.devices.size, devices);
        assert.equal(tv.fake.revokedSessions.size, revoked);
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
        assert.equal(await tv.page.locator('[data-focus="profile:p-kid"] .profile-remembered').textContent(), "TV user");
        assert.equal(await tv.page.locator('[data-focus="profile:p-kid"]').getAttribute("aria-label"), "Kid, Paired with this TV user, PIN protected, Kids profile");
        await tv.page.getByRole("button", { name: "Add", exact: true }).click();
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
        await tv.page.locator('[data-screen="pin"]').waitFor();
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
        await tv.page.locator('[data-focus="title-art"]').focus();
        await tv.page.evaluate(() => {
            const held = window as unknown as { launchSaveHold: { waiting(): number; release(): void } };
            if (held.launchSaveHold.waiting() !== 1) throw new Error("expected one pending protected save");
            held.launchSaveHold.release();
        });
        await tv.page.getByRole("button", { name: /Profile Selection.*Automatic/ }).waitFor();
        assert.equal(await tv.focused(), "title-art");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); await browser.close(); }
});

test("remember save failure is visible and Remember retries it", async () => {
    const browser = await launchBrowser();
    const tv = await openTv(browser, { app: "application" });
    tv.fake.catalog = new FakeDetails();
    try {
        await picker(tv); await selectKid(tv);
        await tv.page.locator('[data-screen="remember-profile"]').waitFor();
        await tv.page.evaluate(() => { window.appHarness.keyManager.failSave = true; });
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("alert").filter({ hasText: "couldn't securely remember" }).waitFor();
        assert.equal(await tv.page.locator('[data-view="home"]').count(), 0);
        assert.equal(await tv.focused(), "remember", "the failed offer keeps focus on Remember");
        await tv.page.evaluate(() => { window.appHarness.keyManager.failSave = false; });
        await tv.page.keyboard.press("Enter");
        await tv.page.locator('[data-view="home"]').waitFor();
        assert.equal(await relaunchedProfile(tv), "Kid", "the retried Remember was saved for Kid");
        assert.equal(tv.fake.requests.filter(request => request.path.endsWith("/verify-pin")).length, 1);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); await browser.close(); }
});

test("the remember offer is Apple TV's centred alert over the picker, and Back answers Ask Every Time", async () => {
    const browser = await launchBrowser();
    const tv = await openTv(browser, { app: "application" });
    tv.fake.catalog = new FakeDetails();
    try {
        await picker(tv);
        await tv.page.locator('[data-focus="profile:p-owner"]').click();
        const alert = tv.page.getByRole("alertdialog", { name: "Open Laura automatically?" });
        await alert.waitFor();
        assert.equal(await alert.locator("p").textContent(), "Silo can skip Who's Watching and open this profile when it starts on this TV. You can change this later in Settings > General > Profile Selection.");
        assert.deepEqual(await alert.locator("button").allTextContents(), ["Ask Every Time", "Remember"], "the cancel button comes first, as in the tvOS alert");
        assert.equal(await tv.focused(), "remember", "focus starts on Remember");
        const layout = await alert.evaluate(node => {
            const box = node.getBoundingClientRect();
            const behind = [...document.querySelectorAll<HTMLElement>('[data-screen="remember-profile"] .dialog-behind-dimmed')];
            return {
                centre: [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)],
                width: Math.round(box.width),
                picker: behind.map(node => node.querySelector(".profile-picker-title")?.textContent).find(text => text !== undefined),
                inert: behind.length > 0 && behind.every(node => node.inert && node.getAttribute("aria-hidden") === "true" && node.querySelector("[data-focus]") === null && [...node.querySelectorAll("button")].every(button => button.disabled)),
                wordmark: getComputedStyle(document.querySelector('[data-screen="remember-profile"] .signin-wordmark') ?? document.body).display,
            };
        });
        assert.deepEqual(layout, { centre: [960, 540], width: 586, picker: "Who's watching?", inert: true, wordmark: "none" }, "a small centred alert over the dimmed, unreachable picker, without the wordmark");
        await tv.page.keyboard.press("ArrowLeft");
        assert.equal(await tv.focused(), "ask-every-launch");
        await tv.page.keyboard.press("ArrowRight");
        assert.equal(await tv.focused(), "remember", "focus stays inside the alert");
        await tv.remote(10009);
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.eventually(async () => await tv.focused() !== null, "Home takes focus after the alert closes");
        await tv.page.evaluate(() => window.appHarness.mount());
        await tv.page.locator('[data-screen="profiles"]').waitFor();
        assert.equal(await tv.focused(), "profile:p-owner", "Ask Every Time shows the picker at the next launch, focused on a profile");
        assert.equal(await tv.page.locator(".profile-remembered").count(), 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); await browser.close(); }
});

test("Back after a failed re-save while switching keeps the remembered launch choice", async () => {
    const browser = await launchBrowser();
    const tv = await openTv(browser, { app: "application" });
    tv.fake.catalog = new FakeDetails();
    try {
        await picker(tv);
        await tv.page.locator('[data-focus="profile:p-owner"]').click();
        await tv.page.locator('[data-screen="remember-profile"]').waitFor();
        await tv.page.locator('[data-focus="remember"]').click();
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.locator('[data-focus="switch-profile"]').click();
        await tv.page.locator('[data-screen="profiles"]').waitFor();
        await tv.page.evaluate(() => { window.appHarness.keyManager.failSave = true; });
        await selectKid(tv);
        await tv.page.getByRole("alert").filter({ hasText: "couldn't securely remember" }).waitFor();
        await tv.remote(10009);
        await tv.page.locator('[data-screen="profiles"]').waitFor();
        assert.equal(await tv.focused(), "profile:p-kid", "Back returns focus to the chosen profile");
        await tv.page.evaluate(() => { window.appHarness.keyManager.failSave = false; });
        assert.equal(await relaunchedProfile(tv), "Laura", "Laura stays the remembered profile");
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
        await tv.page.getByRole("alert").filter({ hasText: "couldn't securely remember" }).waitFor();
        await tv.page.locator('[data-focus="continue-session"]').click();
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.page.evaluate(() => { window.appHarness.storage.failSet = false; window.appHarness.mount(); });
        await tv.page.locator('[data-screen="profiles"]').waitFor();
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); await browser.close(); }
});
