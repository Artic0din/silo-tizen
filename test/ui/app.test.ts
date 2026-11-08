import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakePlayback } from "../native/support/fakePlayback.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { SEEK_BACK_KEY, SEEK_FORWARD_KEY } from "../../src/contracts/v2/settings.ts";
import { homeDetailsRead, launchBrowser, openTv, pauseTvClock, readLive, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

function appTest(name: string, body: (tv: Tv, playback: FakePlayback, catalog: FakeCatalog) => Promise<void>, production = false): void {
    test(name, async () => {
        const tv = await openTv(browser, { app: "application", production });
        const catalog = new FakeCatalog();
        catalog.fileIds.set("movie:m0001", "42");
        catalog.fileIds.set("movie:k1", "42");
        tv.fake.catalog = catalog;
        const playback = new FakePlayback(tv.fake);
        playback.items.set("movie:m0001", ["42"]);
        playback.items.set("movie:k1", ["42"]);
        try {
            await body(tv, playback, catalog);
            assert.deepEqual(tv.console, []);
        } finally {
            await tv.page.context().close();
        }
    });
}

async function signIn(tv: Tv, remember = false): Promise<void> {
    await tv.page.fill("#signin-address", "silo.example.test");
    await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
    await tv.page.locator('[data-screen="code"]').waitFor();
    const code = [...tv.fake.devices.keys()].pop();
    assert.ok(code !== undefined);
    await approveSignIn(tv, code);
    await tv.page.locator('[data-focus="profile:p-owner"]').click();
    await tv.page.locator(remember ? '[data-focus="remember"]' : '[data-focus="ask-every-launch"]').click();
    await tv.page.locator('[data-view="home"] [data-focus="movie:m0001"]').first().waitFor();
    await homeDetailsRead(tv);
}

appTest("unvisited offline For You uses Apple's centred error", async tv => {
    await signIn(tv);
    tv.offline = true;
    await tv.page.locator('[data-focus="for_you"]').click();
    await tv.jump(35000);
    await tv.page.locator('[data-view="for_you"] .details-failure').waitFor();
    await tv.page.getByRole("button", { name: "Try Again", exact: true }).waitFor();
});

appTest("cold saved session rejected by the server returns to sign-in", async tv => {
    await signIn(tv, true);
    tv.fake.revokeAllSessions();
    await tv.page.evaluate(() => window.appHarness.mount());
    await tv.jump(35000);
    await tv.page.locator('[data-screen="code"], [data-screen="expired"]').waitFor();
    assert.equal(await tv.page.locator('[data-view="home"]').count(), 0);
});

appTest("cold saved profile paints cached Home before discovery answers", async tv => {
    await signIn(tv, true);
    const hold = tv.fake.hold("/system/info");
    const codes = tv.fake.devices.size;
    await tv.page.evaluate(() => window.appHarness.mount());
    await tv.page.locator('[data-view="home"] .browse-card').first().waitFor({ timeout: 5000 });
    assert.equal(tv.fake.devices.size, codes);
    hold.release();
});

appTest("cold reconciliation refreshes remembered profile artwork without remounting Home", async tv => {
    await signIn(tv, true);
    const hold = tv.fake.hold("/system/info");
    await tv.page.evaluate(() => window.appHarness.mount());
    await tv.page.locator('[data-view="home"] .browse-card').first().waitFor({ timeout: 5000 });
    assert.equal(await tv.page.locator('[data-focus="profiles"] img').count(), 0, "offline handoff has no avatar URL yet");
    hold.release();
    await tv.eventually(async () => await tv.page.locator('[data-focus="profiles"] img').count() === 1, "reconcile paints the server avatar");
    assert.equal(await tv.page.locator('[data-view="home"] .browse-card').count() > 0, true, "Home stays painted");
    const source = await tv.page.locator('[data-focus="profiles"] img').getAttribute("src") ?? "";
    assert.match(source, /\/avatars\/presets\/fox\.png/);
});

appTest("cold reconciliation removes a deleted profile from Home", async tv => {
    await signIn(tv, true);
    const hold = tv.fake.hold("/system/info");
    tv.fake.profiles = { ...tv.fake.profiles, items: [] };
    await tv.page.evaluate(() => window.appHarness.mount());
    await tv.page.locator('[data-view="home"] .browse-card').first().waitFor({ timeout: 5000 });
    hold.release();
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    assert.equal(await tv.page.locator('[data-view="home"]').count(), 0);
});

appTest("cold reconciliation removes Home when the deployment changes", async tv => {
    await signIn(tv, true);
    const hold = tv.fake.hold("/system/identity");
    tv.fake.script("/system/identity", { status: 200, body: { server_id: "a9e16029-3344-4104-a222-d06456005128" } });
    await tv.page.evaluate(() => window.appHarness.mount());
    await tv.page.locator('[data-view="home"] .browse-card').first().waitFor({ timeout: 5000 });
    hold.release();
    await tv.page.locator('[data-screen="expired"], [data-screen="code"]').waitFor();
    assert.equal(await tv.page.locator('[data-view="home"]').count(), 0);
});

appTest("cold reconciliation removes Home when the remembered PIN proof is revoked", async tv => {
    await tv.page.fill("#signin-address", "silo.example.test");
    await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
    await tv.page.locator('[data-screen="code"]').waitFor();
    const code = [...tv.fake.devices.keys()].pop();
    assert.ok(code !== undefined);
    await approveSignIn(tv, code);
    await tv.page.locator('[data-focus="profile:p-kid"]').click();
    await tv.page.locator('#profile-pin').fill('2468');
    await tv.remote(65376);
    await tv.page.locator('[data-focus="unlock"]').click();
    await tv.page.locator('[data-focus="remember"]').click();
    await tv.page.locator('[data-view="home"] .browse-card').first().waitFor();
    const hold = tv.fake.hold("/system/info");
    tv.fake.changePin("p-kid", "1357");
    await tv.page.evaluate(() => window.appHarness.mount());
    await tv.page.locator('[data-view="home"] .browse-card').first().waitFor({ timeout: 5000 });
    hold.release();
    await tv.page.locator('[data-screen="pin"]').waitFor();
    assert.equal(await tv.page.locator('[data-view="home"]').count(), 0);
});

appTest("offline reconciliation retains the session and checks a removed profile on recovery", async tv => {
    await signIn(tv, true);
    const codes = tv.fake.devices.size;
    tv.offline = true;
    await tv.page.evaluate(() => window.appHarness.mount());
    await tv.page.locator('[data-view="home"] .browse-card').first().waitFor({ timeout: 5000 });
    await tv.jump(35000);
    assert.equal(await tv.page.locator('[data-view="home"] .browse-card').count() > 0, true);
    assert.equal(tv.fake.devices.size, codes);
    tv.fake.profiles = { ...tv.fake.profiles, items: [] };
    tv.offline = false;
    await tv.jump(50000);
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    assert.equal(await tv.page.locator('[data-view="home"]').count(), 0);
});

appTest("temporary discovery server errors retain the remembered profile", async tv => {
    await signIn(tv, true);
    // Two consecutive 503s exhaust NativeHttp's safe retry so reconcile must treat the failure as transient.
    tv.fake.script("/system/info", { status: 503, body: {} }, { status: 503, body: {} });
    await tv.page.evaluate(() => window.appHarness.mount());
    await tv.page.locator('[data-view="home"] .browse-card').first().waitFor();
    await tv.eventually(async () => tv.fake.paths().filter(path => path === "GET /system/info").length >= 2, "discovery retries exhausted");
    await tv.jump(35000);
    assert.equal(await tv.page.locator('[data-view="home"] .browse-card').count() > 0, true);
    tv.fake.scripted.delete("/system/info");
    await tv.jump(50000);
    await tv.page.locator('[data-view="home"] .browse-card').first().waitFor();
});

appTest("permanent discovery rejection removes Home even after the access token expires", async tv => {
    await signIn(tv, true);
    await tv.jump(3600000);
    const hold = tv.fake.hold("/system/info");
    tv.fake.script("/system/info", { status: 404, body: {} });
    await tv.page.evaluate(() => window.appHarness.mount());
    await tv.page.locator('[data-view="home"] .browse-card').first().waitFor();
    hold.release();
    await tv.page.locator('[data-screen="profiles-error"]').waitFor();
    assert.equal(await tv.page.locator('[data-view="home"]').count(), 0);
});

appTest("cold offline launch without a remembered profile does not invent a profile", async tv => {
    await signIn(tv);
    tv.offline = true;
    await tv.page.evaluate(() => window.appHarness.mount());
    await tv.jump(35000);
    await tv.page.getByText("Profiles didn't load", { exact: true }).waitFor();
    assert.equal(await tv.page.locator('[data-view="home"]').count(), 0);
    assert.equal(await tv.page.locator('[data-focus^="profile:"]').count(), 0);
});

appTest("first-time unreachable address retains the connect error", async tv => {
    tv.offline = true;
    await tv.page.fill("#signin-address", "https://first-time.invalid");
    await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
    await tv.jump(35000);
    await tv.page.getByText("Could not reach a Silo server at that address.", { exact: true }).waitFor();
    assert.equal(tv.fake.devices.size, 0);
});

for (const cached of [true, false]) appTest(`cold offline saved session opens Home (snapshot ${cached})`, async tv => {
    await signIn(tv, true);
    await tv.page.locator('[data-view="home"]').waitFor();
    if (!cached) await tv.page.evaluate(() => window.appHarness.storage.removeItem("silo.browseSnapshots.v1"));
    const codes = tv.fake.devices.size;
    tv.offline = true;
    await tv.page.evaluate(() => window.appHarness.mount());
    await tv.jump(35000);
    if (cached) await tv.page.locator('[data-view="home"] .browse-card').first().waitFor();
    else {
        await tv.page.locator('[data-view="home:failed"]').waitFor();
        await tv.page.getByRole("button", { name: "Try Again", exact: true }).waitFor();
        await tv.page.getByRole("button", { name: "Manage Servers", exact: true }).waitFor();
    }
    assert.equal(tv.fake.devices.size, codes);
    tv.offline = false;
    await tv.jump(50000);
    await tv.page.locator('[data-view="home"] .browse-card').first().waitFor();
});

async function approveSignIn(tv: Tv, code: string): Promise<void> {
    tv.fake.approve(code);
    await tv.jump(5000);
    // The poll and vault callbacks must finish before advancing the approval pause.
    await tv.page.locator('[data-screen="approved"], [data-screen="notice"], [data-screen="profiles"]').waitFor();
    if (await tv.screen() === "approved") await tv.jump(1000);
    await tv.page.locator('[data-screen="notice"], [data-screen="profiles"]').waitFor();
    if (await tv.screen() === "notice") await tv.page.getByRole("button", { name: "Continue", exact: true }).click();
    await tv.page.locator('[data-screen="profiles"]').waitFor();
}

appTest("pending account removal blocks Cancel and Back until it settles", async tv => {
    await signIn(tv);
    await tv.page.evaluate(() => {
        const storage = window.appHarness.storage;
        const saved = JSON.parse(storage.getItem("silo.native.accounts.v1")!);
        saved.accounts.push({ ...saved.accounts[0], id: "inactive", accountId: "inactive", username: "Inactive" });
        storage.setItem("silo.native.accounts.v1", JSON.stringify(saved));
    });
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.locator('[data-focus="settings"]').click();
    await tv.page.locator('[data-focus="server"]').click();
    await tv.page.getByRole("button", { name: "Accounts", exact: true }).click();
    await tv.page.locator('[data-focus="inactive"]').click();
    const hold = tv.fake.hold("/system/info");
    await tv.page.locator('[data-focus="confirm"]').click();
    assert.equal(await tv.page.locator('[data-focus="cancel"]').isDisabled(), true);
    await tv.remote(10009);
    assert.equal(await tv.page.locator('[data-view="accounts-confirm"]').count(), 1);
    hold.release();
    await tv.page.locator('[data-view="accounts-settings"]').waitFor();
});

appTest("session expiry releases Change Account and signs in with the username", async tv => {
    await signIn(tv);
    await tv.page.evaluate(() => window.appHarness.storage.setItem("silo.native.serverBranding.v1", JSON.stringify({ "https://silo.example.test": { serverName: "Living room library" } })));
    tv.fake.revokeAllSessions();
    const hold = tv.fake.hold("/auth/refresh");
    await tv.page.locator('[data-focus="movies"]').click();
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Change Account", exact: true }).click();
    hold.release();
    await tv.page.locator('[data-screen="code"]').waitFor({ timeout: 5000 });
    await tv.page.getByText("You were signed out of Living room library. Sign in again.").waitFor();
    assert.equal(await tv.page.locator('.accounts-screen').count(), 0);
    assert.equal(await tv.page.locator('[data-screen="expired"]').count(), 0);
    assert.equal(await tv.focused(), "password");
    await tv.page.getByRole("button", { name: "Sign in with a password", exact: true }).click();
    assert.equal(await tv.page.locator("#signin-username").inputValue(), "laura");
    assert.equal(await tv.page.getByRole("button", { name: "Change server", exact: true }).count(), 1);
});

function profileItems(tv: Tv): Record<string, unknown>[] {
    const items = tv.fake.profiles.items;
    if (!Array.isArray(items)) throw new Error("profiles");
    return items.flatMap(item => typeof item === "object" && item !== null ? [item as Record<string, unknown>] : []);
}

async function addAlex(tv: Tv): Promise<void> {
    tv.fake.nextUser = { id: "2", username: "alex" };
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Change Account", exact: true }).click();
    await tv.page.locator('[data-focus="add-account"]').click();
    await tv.page.locator('[data-screen="code"]').waitFor();
    const code = [...tv.fake.devices.keys()].pop();
    assert.ok(code !== undefined);
    await approveSignIn(tv, code);
    await tv.page.locator('[data-focus="profile:p-owner"]').click();
    await tv.page.locator('[data-focus="ask-every-launch"]').click();
    await tv.page.locator('[data-view="home"] [data-focus="movie:m0001"]').first().waitFor();
}

async function chooseAccount(tv: Tv, username: string): Promise<void> {
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Change Account", exact: true }).click();
    await tv.page.locator(".account-card").filter({ hasText: username }).click();
}

appTest("choosing another account opens its only PIN-less profile", async tv => {
    await signIn(tv);
    await addAlex(tv);
    const owner = profileItems(tv).find(item => item.id === "p-owner");
    assert.ok(owner);
    tv.fake.profiles = { ...tv.fake.profiles, items: [owner] };
    const home = await tv.page.locator('[data-view="home"]').elementHandle();
    assert.ok(home);
    await chooseAccount(tv, "laura");
    await tv.page.waitForFunction(node => !node.isConnected, home);
    await tv.page.locator('[data-view="home"] [data-focus="movie:m0001"]').first().waitFor();
    assert.equal(await tv.page.locator('[data-screen="profiles"]').count(), 0);
    assert.equal(await tv.page.locator('[data-screen="remember-profile"]').count(), 0);
});

appTest("choosing another account still asks for its only profile PIN", async tv => {
    await signIn(tv);
    await addAlex(tv);
    const kid = profileItems(tv).find(item => item.id === "p-kid");
    assert.ok(kid);
    tv.fake.profiles = { ...tv.fake.profiles, items: [kid] };
    await chooseAccount(tv, "laura");
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    assert.equal(await tv.page.locator('[data-screen="profiles"] .profile-avatar').count(), 1);
    await tv.page.locator('[data-focus="profile:p-kid"]').click();
    await tv.page.locator("#profile-pin").waitFor();
});

appTest("choosing another account shows the picker for two profiles", async tv => {
    await signIn(tv);
    await addAlex(tv);
    await chooseAccount(tv, "laura");
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    assert.equal(await tv.page.locator('[data-screen="profiles"] .profile-avatar').count(), 2);
    assert.equal(await tv.page.locator("#profile-pin").count(), 0);
});

appTest("Switch Profile still shows one PIN-less profile", async tv => {
    await signIn(tv);
    const owner = profileItems(tv).find(item => item.id === "p-owner");
    assert.ok(owner);
    tv.fake.profiles = { ...tv.fake.profiles, items: [owner] };
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.locator('[data-focus="switch-profile"]').click();
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    assert.equal(await tv.page.locator(".profile-avatar").count(), 1);
});

appTest("an expired session opens Change Account while another account is signed in", async tv => {
    await signIn(tv);
    await addAlex(tv);
    tv.fake.revokeAllSessions();
    const hold = tv.fake.hold("/auth/refresh");
    await tv.page.locator('[data-focus="movies"]').click();
    hold.release();
    await tv.page.locator('[data-view="change-account"]').waitFor();
    assert.equal(await tv.page.locator('[data-screen="code"]').count(), 0);
    assert.equal(await tv.page.locator('[data-screen="expired"]').count(), 0);
    assert.equal(await tv.page.locator(".account-badge").filter({ hasText: "SIGN IN AGAIN" }).count(), 1);
});

appTest("choosing an expired account opens sign-in and Back returns to Change Account", async tv => {
    await signIn(tv);
    await tv.page.evaluate(() => {
        const storage = window.appHarness.storage;
        const saved = JSON.parse(storage.getItem("silo.native.accounts.v1")!) as { accounts: Record<string, unknown>[] };
        const first = saved.accounts[0];
        if (first === undefined) throw new Error("account");
        saved.accounts.push({ ...first, id: "alex", accountId: "2", username: "alex", needsSignIn: true, profileCount: 1 });
        storage.setItem("silo.native.accounts.v1", JSON.stringify(saved));
    });
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Change Account", exact: true }).click();
    await tv.page.locator(".account-card").filter({ hasText: "alex" }).click();
    await tv.page.locator('[data-screen="code"]').waitFor();
    assert.equal(await tv.page.getByRole("button", { name: "Back to accounts", exact: true }).count(), 1);
    await tv.page.getByRole("button", { name: "Sign in with a password", exact: true }).click();
    assert.equal(await tv.page.locator("#signin-username").inputValue(), "alex");
    await tv.page.getByRole("button", { name: "Back to accounts", exact: true }).click();
    await tv.page.locator('[data-view="change-account"]').waitFor();
});

appTest("offline saved server offers Back to profiles while a saved account can open profiles", async tv => {
    await signIn(tv);
    const devices = tv.fake.devices.size;
    await tv.page.evaluate(() => {
        window.appHarness.destroy();
        const storage = window.appHarness.storage;
        const saved = JSON.parse(storage.getItem("silo.native.accounts.v1")!);
        const offline = { ...saved.accounts[0], id: "offline", baseUrl: "https://offline.invalid", accountId: "offline" };
        storage.setItem("silo.native.accounts.v1", JSON.stringify({ accounts: [offline, ...saved.accounts], selected: offline.id }));
        window.appHarness.mount();
    });
    await tv.page.locator('[data-screen="entry"]').waitFor();
    const change = tv.page.getByRole("button", { name: "Back to profiles", exact: true });
    assert.equal(await change.count(), 1);
    await change.click();
    await tv.page.locator('.accounts-rail button').filter({ hasText: "silo.example.test" }).click();
    await tv.page.locator('.account-card').first().click();
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    assert.equal(tv.fake.devices.size, devices);
});

for (const column of ["accounts-rail", "accounts-pane", "accounts-settings"]) appTest(`D-pad reveals overflowing ${column}`, async tv => {
    await signIn(tv);
    await tv.page.evaluate(() => {
        const storage = window.appHarness.storage;
        const saved = JSON.parse(storage.getItem("silo.native.accounts.v1")!);
        const first = saved.accounts[0];
        saved.accounts.push(...Array.from({ length: 14 }, (_, i) => ({ ...first, id: `extra-${i}`, accountId: `extra-${i}`, username: `Extra ${i}` })));
        saved.accounts.push(...Array.from({ length: 14 }, (_, i) => ({ ...first, id: `server-${i}`, baseUrl: `https://server-${i}.invalid` })));
        storage.setItem("silo.native.accounts.v1", JSON.stringify(saved));
    });
    await tv.page.locator('[data-focus="profiles"]').click();
    if (column === "accounts-settings") {
        await tv.page.locator('[data-focus="settings"]').click();
        await tv.page.locator('[data-focus="server"]').click();
        await tv.page.getByRole("button", { name: "Accounts", exact: true }).click();
    } else await tv.page.locator('[data-focus="switch-server"]').click();
    const first = tv.page.locator(`.${column} button`).first();
    await first.focus();
    const count = await tv.page.locator(`.${column} button`).count();
    let removalRevealed = false;
    for (let i = 1; i < count; i++) {
        await tv.page.keyboard.press("ArrowDown");
        if (column === "accounts-settings") {
            await tv.jump(300);
            const row = await tv.page.locator(":focus").evaluate(node => {
                const bounds = node.getBoundingClientRect();
                return { top: bounds.top, bottom: bounds.bottom, screen: window.innerHeight, key: node.getAttribute("data-focus") };
            });
            assert.ok(row.top >= 0 && row.bottom <= row.screen, JSON.stringify(row));
            if (row.key?.startsWith("remove:")) removalRevealed = true;
        }
        if (column === "accounts-rail" && i === count - 2) {
            await tv.jump(300);
            assert.ok(await tv.page.locator(".accounts-rail").evaluate(node => {
                const bounds = node.getBoundingClientRect();
                const focused = document.activeElement!.getBoundingClientRect();
                return focused.top >= bounds.top && focused.bottom <= bounds.bottom;
            }), "an intermediate server row stays visible after rebuilding the chooser");
        }
    }
    await tv.jump(300);
    if (column === "accounts-settings") assert.ok(removalRevealed, "the removal row was reached and visible");
    const bounds = await tv.page.locator(`.${column}`).evaluate(node => {
        const viewport = node.getBoundingClientRect();
        const focused = document.activeElement!.getBoundingClientRect();
        return { scroll: node.scrollTop, top: viewport.top, bottom: viewport.bottom, focusedTop: focused.top, focusedBottom: focused.bottom };
    });
    assert.ok(bounds.scroll > 0, "the overflowing column scrolls");
    assert.ok(bounds.focusedTop >= bounds.top && bounds.focusedBottom <= bounds.bottom, JSON.stringify(bounds));
});

appTest("unreadable account storage shows recovery and preserves the saved bytes", async tv => {
    await tv.page.evaluate(() => { window.appHarness.destroy(); window.appHarness.storage.failGet = true; window.appHarness.mount(); });
    await tv.page.locator('[data-screen="accounts-storage-error"]').waitFor();
    assert.equal(await tv.focused(), "retry");
    await tv.page.getByRole("button", { name: "Continue without saved accounts", exact: true }).click();
    await tv.page.locator('[data-screen="entry"]').waitFor();
    await tv.page.evaluate(() => { window.appHarness.storage.failGet = false; });
});

appTest("failed live account selection returns to profiles without another directory write", async tv => {
    await signIn(tv);
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Change Account", exact: true }).click();
    await tv.page.evaluate(() => { window.appHarness.storage.failSet = true; });
    await tv.page.locator('.account-card').first().click();
    await tv.page.locator('[data-screen="account-selection-error"]').waitFor();
    assert.equal(await tv.page.getByRole("button", { name: "Back to profiles", exact: true }).count(), 1);
    await tv.page.getByRole("button", { name: "Back to profiles", exact: true }).click();
    await tv.page.locator('[data-screen="profiles"]').waitFor();
});

appTest("a profile-count cache write failure still opens Switch Profile", async tv => {
    await signIn(tv);
    await tv.page.evaluate(() => { window.appHarness.storage.failSet = true; });
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.locator('[data-focus="switch-profile"]').click();
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    assert.equal(await tv.page.locator('.profile-avatar').count(), 2);
});

appTest("Change Account keeps a session-only account usable without signing in again", async tv => {
    await tv.page.evaluate(() => { window.appHarness.keyManager.failSave = true; });
    await signIn(tv);
    const devices = tv.fake.devices.size;
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Change Account", exact: true }).click();
    await tv.page.locator('[data-view="change-account"]').waitFor();
    await tv.page.locator('.account-card').first().click();
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    assert.equal(tv.fake.devices.size, devices);
    assert.equal(tv.fake.revokedSessions.size, 0);
});

appTest("a guarded replacement reuses its live session but cannot restore after restart", async tv => {
    await signIn(tv);
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Change Account", exact: true }).click();
    await tv.page.evaluate(() => { window.appHarness.keyManager.failSave = true; });
    await tv.page.locator('[data-focus="add-account"]').click();
    await tv.page.locator('[data-screen="code"]').waitFor();
    await approveSignIn(tv, [...tv.fake.devices.keys()].pop()!);
    const devices = tv.fake.devices.size;
    await tv.page.locator('[data-focus="change-server"]').click();
    await tv.page.locator('[data-view="change-account"]').waitFor();
    assert.equal(await tv.page.evaluate(() => JSON.parse(window.appHarness.storage.getItem("silo.native.accounts.v1")!).accounts[0].needsSignIn), true);
    await tv.page.locator('.account-card').first().click();
    await tv.page.locator('[data-screen="profiles"]').waitFor({ timeout: 3000 });
    assert.equal(tv.fake.devices.size, devices);
    await tv.page.evaluate(() => { window.appHarness.keyManager.failSave = false; window.appHarness.mount(); });
    await tv.page.locator('[data-screen="code"]').waitFor();
    assert.equal(await tv.page.locator('[data-screen="profiles"]').count(), 0);
});

appTest("a password reset refusal opens Change Account without signing out", async tv => {
    await signIn(tv);
    tv.fake.passwordChangeRequired = true;
    tv.fake.expireAccessTokens();
    await tv.page.evaluate(() => { window.appHarness.destroy(); window.appHarness.mount(); });
    await tv.page.locator('[data-screen="profiles-error"]').waitFor();
    await tv.page.getByText("Your password needs to be reset. Use the Silo mobile app or website to set a new one, then come back.").waitFor();
    assert.equal(await tv.focused(), "change-account");
    const revoked = tv.fake.revokedSessions.size;
    await tv.page.getByRole("button", { name: "Change account", exact: true }).click();
    await tv.page.locator('[data-view="change-account"]').waitFor();
    assert.equal(await tv.page.locator('[data-screen="entry"]').count(), 0, "Change account opens the account list, not server entry");
    assert.equal(tv.fake.revokedSessions.size, revoked, "changing account does not sign this one out");
    assert.equal(await tv.page.locator(".account-badge").textContent(), "CURRENT");
});

appTest("empty Change Account focuses Add server and Back returns to sign-in", async tv => {
    await tv.page.fill("#signin-address", "silo.example.test");
    await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
    await tv.page.locator('[data-screen="code"]').waitFor();
    await tv.remote(10009);
    await tv.page.locator('[data-view="change-account"]').waitFor();
    assert.equal(await tv.focused(), "add-server");
    assert.equal(await tv.page.getByRole("button", { name: "Add an account", exact: true }).count(), 0);
    await tv.remote(10009);
    await tv.page.locator('[data-screen="entry"]').waitFor();
});

appTest("the top bar shows a preset's flat PNG when the server's avatar URL is an SVG", async tv => {
    await tv.page.route("https://api.dicebear.com/**", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="58" height="58"/>' }));
    const items = (tv.fake.profiles.items as Record<string, unknown>[]).map(item => item.id === "p-owner" ? { ...item, avatar_url: "https://api.dicebear.com/9.x/bottts-neutral/svg?backgroundType=gradientLinear&seed=robot", avatar: "preset:dicebear:bottts-neutral:robot" } : item);
    tv.fake.profiles = { ...tv.fake.profiles, items };
    await signIn(tv);
    const source = await tv.page.locator('[data-focus="profiles"] img').getAttribute("src") ?? "";
    assert.equal(new URL(source).pathname, "/9.x/bottts-neutral/png");
    assert.equal(new URL(source).searchParams.get("backgroundType"), null);
});

appTest("Sign Out confirmation traps focus and cancellation preserves the session", async tv => {
    await signIn(tv);
    await tv.page.evaluate(() => window.appHarness.storage.setItem("silo.native.serverBranding.v1", JSON.stringify({ "https://silo.example.test": { serverName: "Living room library" } })));
    const writes = tv.fake.requests.filter(request => request.method !== "GET").length;
    await tv.page.locator('[data-focus="profiles"]').click();
    assert.equal(await tv.page.locator(".skyline-profile-server").textContent(), "LIVING ROOM LIBRARY");
    assert.equal(await tv.focused(), "switch-profile");
    await tv.page.locator('[data-focus="signout"]').focus();
    const focusColors = await tv.page.locator('[data-focus="signout"]').evaluate(node => [getComputedStyle(node).backgroundColor, getComputedStyle(node).color]);
    assert.deepEqual(focusColors, ["rgb(255, 255, 255)", "rgb(0, 0, 0)"], "Apple uses the common white focus platter for destructive menu rows");
    await tv.page.locator('[data-focus="signout"]').click();
    await tv.page.getByRole("alertdialog", { name: "Sign Out" }).waitFor();
    assert.equal(await tv.focused(), "cancel-signout");
    const dialogGeometry = await tv.page.getByRole("alertdialog", { name: "Sign Out" }).evaluate(node => {
        const style = getComputedStyle(node);
        const buttons = [...node.querySelectorAll("button")].map(button => button.getBoundingClientRect());
        return { width: style.width, topPadding: style.paddingTop, sidePadding: style.paddingLeft, titleSize: getComputedStyle(node.querySelector("h2") as HTMLElement).fontSize, row: Math.abs((buttons[0]?.y ?? 0) - (buttons[1]?.y ?? 1)) < 1 };
    });
    assert.deepEqual(dialogGeometry, { width: "632px", topPadding: "42px", sidePadding: "48px", titleSize: "38px", row: true });
    assert.equal(await tv.page.locator(".browse-nav").evaluate(node => (node as HTMLElement).inert), true);
    assert.equal(await tv.page.locator(".browse-nav").getAttribute("aria-hidden"), "true");
    const destination = tv.page.locator('.browse-nav [data-focus="movies"]');
    const bounds = await destination.boundingBox();
    assert.ok(bounds);
    await tv.page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    assert.equal(await tv.page.getByRole("alertdialog", { name: "Sign Out" }).isVisible(), false, "the source backdrop cancels without activating its covered destination");
    assert.equal(await tv.page.locator('.browse').getAttribute("data-view"), "home");
    assert.equal(await tv.focused(), "profiles");
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.locator('[data-focus="signout"]').click();
    for (const code of [38, 37]) await tv.remote(code);
    assert.equal(await tv.focused(), "cancel-signout");
    await tv.remote(39);
    assert.equal(await tv.focused(), "confirm-signout");
    await tv.remote(40);
    assert.equal(await tv.focused(), "confirm-signout");
    await tv.remote(37);
    assert.equal(await tv.focused(), "cancel-signout");
    await tv.remote(10009);
    assert.equal(await tv.focused(), "profiles");
    assert.equal(await tv.page.locator('[data-view="home"]').isVisible(), true);
    assert.equal(tv.fake.requests.filter(request => request.method !== "GET").length, writes);
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.locator('[data-focus="signout"]').click();
    await tv.page.locator('[data-focus="confirm-signout"]').click();
    await tv.page.locator('[data-screen="entry"]').waitFor();
    assert.equal(await tv.page.locator(".browse").count(), 0);
});

appTest("saved-server Select enters its pane and Back returns to its rail", async tv => {
    await signIn(tv);
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Change Account", exact: true }).click();
    await tv.remote(10009);
    assert.equal(await tv.focused(), tv.fake.origin);
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.page.locator('.account-card:focus').count(), 1);
    await tv.remote(40);
    assert.equal(await tv.focused(), "add-account");
    await tv.remote(37);
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.focused(), "add-account", "Select remembers the pane's last card");
    await tv.remote(10009);
    assert.equal(await tv.focused(), tv.fake.origin);
    assert.equal(tv.fake.revokedSessions.size, 0);
});

appTest("Add server Back returns to saved servers without changing credentials", async tv => {
    await signIn(tv);
    const saved = await tv.page.evaluate(() => [...window.appHarness.keyManager.items]);
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Change Account", exact: true }).click();
    await tv.page.getByRole("button", { name: "Add server", exact: true }).click();
    await tv.page.locator('[data-screen="entry"]').waitFor();
    await tv.remote(10009);
    assert.equal(await tv.page.locator('[data-view="change-account"]').count(), 1);
    assert.deepEqual(await tv.page.evaluate(() => [...window.appHarness.keyManager.items]), saved);
    assert.equal(tv.fake.revokedSessions.size, 0);
});

appTest("Remove Server holds focus while pending and reports protected-storage failure", async tv => {
    new FakeSettings(tv.fake);
    await signIn(tv);
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await tv.page.locator('[data-focus="server"]').click();
    await tv.page.getByRole("button", { name: "Accounts", exact: true }).click();
    await tv.page.getByRole("button", { name: "Remove Server", exact: true }).click();
    assert.equal(await tv.focused(), "cancel");
    await tv.page.evaluate(() => { window.appHarness.keyManager.failRemove = true; window.appHarness.storage.failSet = true; });
    const hold = tv.fake.hold("/auth/logout");
    await tv.page.locator('[data-focus="confirm"]').click();
    await tv.remote(10009);
    assert.equal(await tv.page.getByRole("alertdialog").count(), 1, "Back waits for removal");
    assert.equal(await tv.page.locator('[data-focus="confirm"]').innerText(), "Removing…");
    assert.equal(await tv.focused(), "confirm");
    hold.release();
    await tv.jump(100);
    await tv.page.locator('[data-view="accounts-error"]').waitFor();
    assert.equal(await tv.focused(), "retry");
    assert.match(await tv.page.locator('.accounts-title').innerText(), /Could not remove/);
    await tv.page.getByRole("button", { name: "Back", exact: true }).click();
    assert.equal(await tv.page.getByRole("button", { name: "Remove Server", exact: true }).count(), 1);
});

appTest("Remove Server confirmation matches the settings alert and dismissal returns to the first account", async tv => {
    await signIn(tv);
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await tv.page.locator('[data-focus="server"]').click();
    await tv.page.getByRole("button", { name: "Accounts", exact: true }).click();
    const first = await tv.page.locator(".accounts-settings button").first().getAttribute("data-focus");
    assert.ok(first !== null && !first.startsWith("remove:"));
    await tv.page.getByRole("button", { name: "Remove Server", exact: true }).click();
    const alert = tv.page.getByRole("alertdialog");
    await alert.waitFor();
    assert.equal(await tv.focused(), "cancel");
    assert.equal(await alert.getByRole("button", { name: "Remove", exact: true }).count(), 1);
    assert.equal(await alert.getByRole("button", { name: "Remove Server", exact: true }).count(), 0);
    const presented = await alert.evaluate(node => {
        const style = getComputedStyle(node);
        const buttons = [...node.querySelectorAll("button")].map(button => button.getBoundingClientRect());
        const bounds = node.getBoundingClientRect();
        const behind = document.querySelector(".accounts-settings");
        return {
            title: node.querySelector("h2")?.textContent,
            message: node.querySelector("p")?.textContent,
            confirmation: node.getAttribute("data-confirmation"),
            width: style.width,
            topPadding: style.paddingTop,
            sidePadding: style.paddingLeft,
            titleSize: getComputedStyle(node.querySelector("h2") as HTMLElement).fontSize,
            buttonHeight: getComputedStyle(node.querySelector("button") as HTMLElement).height,
            row: Math.abs((buttons[0]?.y ?? 0) - (buttons[1]?.y ?? 1)) < 1,
            scrim: document.querySelector(".skyline-dropdown-scrim[data-confirmation]") !== null,
            behind: behind !== null,
            inert: behind instanceof HTMLElement && behind.inert,
            centerX: bounds.x + bounds.width / 2,
            centerY: bounds.y + bounds.height / 2,
        };
    });
    assert.deepEqual({
        title: presented.title,
        message: presented.message,
        confirmation: presented.confirmation,
        width: presented.width,
        topPadding: presented.topPadding,
        sidePadding: presented.sidePadding,
        titleSize: presented.titleSize,
        buttonHeight: presented.buttonHeight,
        row: presented.row,
        scrim: presented.scrim,
        behind: presented.behind,
        inert: presented.inert,
    }, {
        title: "Remove silo.example.test?",
        message: "This signs out of laura.",
        confirmation: "true",
        width: "632px",
        topPadding: "42px",
        sidePadding: "48px",
        titleSize: "38px",
        buttonHeight: "63px",
        row: true,
        scrim: true,
        behind: true,
        inert: true,
    });
    assert.ok(Math.abs(presented.centerX - 960) < 2, JSON.stringify(presented));
    assert.ok(Math.abs(presented.centerY - 540) < 2, JSON.stringify(presented));
    await tv.remote(39);
    assert.equal(await tv.focused(), "confirm");
    await tv.remote(37);
    assert.equal(await tv.focused(), "cancel");
    await tv.remote(38);
    assert.equal(await tv.focused(), "cancel");
    await tv.remote(40);
    assert.equal(await tv.focused(), "cancel");
    await tv.page.getByRole("button", { name: "Cancel", exact: true }).click();
    await tv.page.locator('[data-view="accounts-settings"]').waitFor();
    assert.equal(await tv.focused(), first, "Cancel returns to the first account");
    await tv.page.getByRole("button", { name: "Remove Server", exact: true }).click();
    await tv.remote(10009);
    assert.equal(await tv.page.locator('[data-view="accounts-settings"]').count(), 1);
    assert.equal(await tv.focused(), first, "Back returns to the first account");
    await tv.page.getByRole("button", { name: "Remove Server", exact: true }).click();
    await tv.page.mouse.click(80, 80);
    assert.equal(await tv.page.locator('[data-view="accounts-settings"]').count(), 1);
    assert.equal(await tv.focused(), first, "the scrim cancels without activating the account list");
});

appTest("Remove Server names every account it will sign out", async tv => {
    await signIn(tv);
    await tv.page.evaluate(() => {
        const storage = window.appHarness.storage;
        const saved = JSON.parse(storage.getItem("silo.native.accounts.v1")!) as { accounts: Record<string, unknown>[] };
        saved.accounts.push({ ...saved.accounts[0], id: "other", accountId: "other", username: "Other" });
        storage.setItem("silo.native.accounts.v1", JSON.stringify(saved));
    });
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await tv.page.locator('[data-focus="server"]').click();
    await tv.page.getByRole("button", { name: "Accounts", exact: true }).click();
    await tv.page.getByRole("button", { name: "Remove Server", exact: true }).click();
    const alert = tv.page.getByRole("alertdialog");
    await alert.waitFor();
    assert.equal(await alert.locator("h2").innerText(), "Remove silo.example.test?");
    assert.equal(await alert.locator("p").innerText(), "This signs out of its 2 accounts.");
    assert.equal(await tv.focused(), "cancel");
});

appTest("an offline saved server reports failure and Back preserves both servers", async tv => {
    await signIn(tv);
    await tv.page.evaluate(() => {
        const storage = window.appHarness.storage;
        const directory = JSON.parse(storage.getItem("silo.native.accounts.v1")!) as { accounts: { id: string; baseUrl: string }[] };
        directory.accounts.push({ ...directory.accounts[0]!, id: "offline-account", baseUrl: "https://offline.example.test" });
        storage.setItem("silo.native.accounts.v1", JSON.stringify(directory));
    });
    const saved = await tv.page.evaluate(() => [...window.appHarness.keyManager.items]);
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Change Account", exact: true }).click();
    const reads = tv.fake.requests.length;
    await tv.remote(37);
    await tv.remote(40);
    assert.equal(await tv.focused(), "https://offline.example.test");
    assert.equal(tv.fake.requests.length, reads, "rail focus never fetches");
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.focused(), "offline-account");
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-screen="entry"] .marquee-error').waitFor();
    assert.equal(await tv.focused(), "connect");
    await tv.remote(10009);
    assert.equal(await tv.page.locator('.accounts-rail button').count(), 3);
    assert.deepEqual(await tv.page.evaluate(() => [...window.appHarness.keyManager.items]), saved);
    assert.equal(tv.fake.revokedSessions.size, 0);
});

appTest("an abandoned add-account answer cannot replace the saved-server selection", async tv => {
    await signIn(tv);
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Change Account", exact: true }).click();
    const hold = tv.fake.hold("/auth/device/start", true);
    await tv.page.locator('[data-focus="add-account"]').click();
    await tv.eventually(async () => tv.fake.devices.size === 2, "second device request");
    await tv.remote(10009);
    await tv.page.locator('[data-view="change-account"]').waitFor();
    await tv.page.locator('.account-card').first().click();
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    hold.release();
    await tv.jump(5000);
    assert.equal(await tv.screen(), "profiles");
    assert.equal(tv.fake.revokedSessions.size, 0);
});

for (const origin of ["home", "movies"] as const) appTest(`Change Account returns to ${origin} and opens saved accounts without signing out`, async tv => {
    await signIn(tv);
    await tv.page.locator(`[data-focus="${origin}"]`).click();
    const writes = tv.fake.requests.filter(request => request.method !== "GET").length;
    const sessions = tv.fake.devices.size;
    await tv.page.locator('[data-focus="profiles"]').click();
    assert.deepEqual(await tv.page.locator('.skyline-selector [role="menuitem"]').allTextContents(), ["Switch Profile", "History", "Settings", "Change Account", "Sign Out"]);
    assert.equal(await tv.page.getByRole("menuitem", { name: "Switch Server", exact: true }).count(), 0);
    await tv.page.getByRole("menuitem", { name: "Change Account", exact: true }).click();
    await tv.page.locator('[data-view="change-account"]').waitFor();
    assert.equal(await tv.page.locator(".browse").isVisible(), false);
    assert.equal(tv.fake.requests.filter(request => request.method !== "GET").length, writes);
    assert.equal(tv.fake.devices.size, sessions, "entry does not start another sign-in");
    assert.equal(await tv.page.locator('.account-badge').textContent(), "CURRENT");
    const geometry = await tv.page.evaluate(() => {
        const rail = document.querySelector('.accounts-rail button')!.getBoundingClientRect();
        const card = document.querySelector('.account-card')!.getBoundingClientRect();
        return { rail: [rail.width, rail.height], card: [card.width, card.height], headline: getComputedStyle(document.querySelector('.accounts-title')!).fontSize };
    });
    assert.deepEqual(geometry.rail, [520, 88]);
    const layout = await tv.page.evaluate(() => {
        const pane = document.querySelector('.accounts-pane')!;
        const rail = document.querySelector('.accounts-rail button')!;
        const add = document.querySelector('.accounts-rail [data-focus="add-server"]')!;
        const tile = document.querySelector('.accounts-pane [data-focus="add-account"] .account-initial')!;
        return { x: pane.getBoundingClientRect().x + 12, y: rail.getBoundingClientRect().y,
            plus: add.querySelector('[aria-hidden="true"]')?.textContent,
            fill: getComputedStyle(add).backgroundColor, gradient: getComputedStyle(tile).backgroundImage,
            scrim: document.querySelector('.accounts-scrim') !== null };
    });
    assert.equal(layout.x, 650);
    assert.ok(Math.abs(layout.y - 364) < 1, JSON.stringify(layout));
    assert.equal(layout.plus, "+");
    assert.equal(layout.fill, "rgba(0, 0, 0, 0)");
    assert.match(layout.gradient, /234, 166, 92/);
    assert.equal(layout.scrim, true);
    assert.equal(geometry.headline, "88px");
    // Focus grows the 760 by 128 card by Apple's 1.03 scale.
    assert.ok(Math.abs(geometry.card[0]! - 760 * 1.03) < .1);
    assert.ok(Math.abs(geometry.card[1]! - 128 * 1.03) < .1);
    assert.equal(await tv.page.getByRole('button', { name: 'Add', exact: true }).count(), 0, "tvOS has direct add-account and add-server actions");
    await tv.remote(10009);
    assert.equal(await tv.page.locator('.accounts-rail button:focus').evaluate(node => getComputedStyle(node).backgroundColor), "rgb(237, 237, 237)");
    await tv.remote(10009);
    assert.equal(await tv.focused(), origin);
    assert.equal(await tv.page.locator('[data-focus="profiles"]').getAttribute("aria-expanded"), "false");
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Change Account", exact: true }).click();
    await tv.page.locator('[data-view="change-account"]').waitFor();
    await tv.page.locator('.account-card').first().click();
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    assert.equal(await tv.page.locator('[data-screen="code"]').count(), 0, "the saved account restores");
});

async function startMovie(tv: Tv, id = "movie:m0001"): Promise<void> {
    await tv.page.locator(`.browse-card:not(.skyline-continue)[data-focus="${id}"]`).first().click();
    await tv.page.locator('[data-focus="play"]').click();
    await prepare(tv);
}

async function prepare(tv: Tv): Promise<void> {
    await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.pendingPrepares > 0), "AVPlay preparation");
    await tv.page.evaluate(() => {
        const avplay = window.appHarness.avplay;
        avplay.finishPrepare();
        if (avplay.calls[avplay.calls.length - 1]?.startsWith("seekTo") === true) {
            avplay.finishSeek();
        }
    });
    await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.state === "PLAYING"), "playback");
}

async function visibility(tv: Tv, hidden: boolean): Promise<void> {
    await tv.page.evaluate((hidden) => {
        Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
        document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
}

appTest("profile selection expiry refreshes an open picker and retires its old Back action", async tv => {
    await signIn(tv);
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Switch Profile", exact: true }).click();
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    await visibility(tv, true);
    await visibility(tv, false);
    await tv.jump(0);
    await tv.remote(10009);
    await tv.jump(0);
    assert.equal(await tv.page.locator('[data-screen="profiles"]').count(), 1);
    assert.equal(await tv.page.locator('[data-view="home"]').count(), 0);
});

for (const reduced of [false, true]) {
    appTest(`foreground validation fences a second hide in ${reduced ? "reduced" : "normal"} motion`, async (tv, playback) => {
        await tv.page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
        await signIn(tv, true);
        await startMovie(tv);
        await tv.page.evaluate(() => window.appHarness.avplay.tick(32000));
        await tv.remote(19);
        await visibility(tv, true);
        const gate = tv.fake.hold("/playback/capabilities");
        const reads = tv.fake.requests.filter(r => r.path === "/playback/capabilities").length;
        await visibility(tv, false);
        await tv.eventually(async () => tv.fake.requests.filter(r => r.path === "/playback/capabilities").length === reads + 1, "foreground validation");
        assert.equal(await tv.page.getByText("Restoring", { exact: true }).count(), 1, "foreground validation has a loading state");
        await visibility(tv, true);
        gate.release();
        for (let i = 0; i < 5; i++) await tv.jump(0);
        assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.calls.filter(c => c.startsWith("restoreAsync")).length), 0);
        assert.equal(tv.fake.requests.filter(r => r.method === "DELETE" && r.path.startsWith("/playback/")).length, 0);
        await visibility(tv, false);
        await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.calls.some(c => c.startsWith("restoreAsync"))), "authorized restore");
        await tv.page.evaluate(() => window.appHarness.avplay.finishRestore());
        await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.state === "PAUSED"), "retained pause intent");
        assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.positionMs), 32000);
        assert.equal(tv.fake.requests.filter(r => r.path === "/playback/start").length, 1);
        await tv.remote(10009);
        await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
        await tv.eventually(async () => [...playback.sessions.values()].every(s => s.receipt !== undefined), "warm session stopped on Back");
    }, true);

    appTest(`connection recovery resumes the same session in ${reduced ? "reduced" : "normal"} motion`, async (tv, playback) => {
        await tv.page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
        await signIn(tv);
        await startMovie(tv);
        const id = [...playback.sessions.keys()][0];
        assert.ok(id !== undefined);
        const path = `/playback/${id}/replan`;
        tv.fake.script(path, { status: 503 });
        playback.next.push({ timeline: { source_start_seconds: 32, player_start_seconds: 32, timeline_offset_seconds: 0 } });
        await tv.page.evaluate(() => {
            window.appHarness.avplay.tick(32000);
            window.appHarness.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
        });
        await tv.page.getByText("Reconnecting", { exact: true }).waitFor();
        await tv.jump(1000);
        await tv.eventually(async () => tv.fake.requests.filter(r => r.path === path).length === 1, "first reconnect");
        await tv.jump(2000);
        await prepare(tv);
        const replans = tv.fake.requests.filter(r => r.path === path);
        assert.equal(replans.length, 2);
        assert.ok(replans.every(r => r.body?.operation === "track_change" && r.body.position_seconds === 32 && !("failure" in r.body)));
        assert.equal(tv.fake.requests.filter(r => r.path === "/playback/start").length, 1);
        assert.equal(playback.session(id).receipt, undefined);
        assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.positionMs), 32000);
        await tv.remote(10009);
        await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
        await tv.eventually(async () => playback.session(id).receipt !== undefined, "recovered session stopped on Back");
    }, true);
}

// Apple tvOS replaced the old "Play next" label with "Play Now".
appTest("natural episode EOF offers manual Play Now and Stop returns to origin", async (tv, playback, catalog) => {
    for (const id of ["episode:s1e12", "episode:s1e13"]) {
        catalog.fileIds.set(id, "42");
        playback.items.set(id, ["42"]);
    }
    await signIn(tv);
    await tv.page.locator('.skyline-continue[data-focus="episode:s1e12"]').focus();
    await tv.remote(415);
    await prepare(tv);
    await tv.page.evaluate(() => { window.appHarness.avplay.tick(5399000); window.appHarness.avplay.listener?.onstreamcompleted(); });
    await tv.page.getByRole("button", { name: "Play Now", exact: true }).waitFor();
    assert.equal(await tv.page.getByRole("heading", { name: "Harbor Lights chapter 1.3", exact: true }).count(), 1);
    assert.equal(tv.fake.requests.filter(r => r.path === "/playback/start").length, 1);
    assert.equal(tv.fake.requests.filter(r => r.method === "DELETE").length, 1);
    await tv.remote(413);
    await tv.page.locator('[data-view="home"]').waitFor();
    assert.equal(await tv.focused(), "episode:s1e12");
}, true);

async function startEpisode(tv: Tv, playback: FakePlayback, catalog: FakeCatalog, id = "episode:s1e12"): Promise<void> {
    catalog.fileIds.set(id, "42");
    catalog.fileIds.set("episode:s1e13", "43");
    playback.items.set(id, ["42"]);
    playback.items.set("episode:s1e13", ["43"]);
    const household = catalog.households.get("p-owner");
    assert.ok(household !== undefined);
    household.sections[0]?.items.push(id);
    await signIn(tv);
    await tv.page.locator(`.skyline-continue[data-focus="${id}"]`).first().focus();
    await tv.remote(415);
    await prepare(tv);
}

for (const reduced of [false, true]) {
    appTest(`EOF remote journey preserves focus, one START and origin in ${reduced ? "reduced" : "normal"} motion`, async (tv, playback, catalog) => {
        await tv.page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
        catalog.persistStops = false;
        await startEpisode(tv, playback, catalog);
        const watchReads = tv.fake.requests.filter(r => r.path.startsWith("/watch/")).length;
        const id = [...playback.sessions.keys()][0];
        assert.ok(id !== undefined);
        const stop = tv.fake.hold(`/playback/${id}`);
        const deck = tv.fake.hold("/home/sections");
        const deckReads = tv.fake.requests.filter(r => r.path.startsWith("/home/sections")).length;
        await tv.page.evaluate(() => { window.appHarness.avplay.tick(5399000); window.appHarness.avplay.listener?.onstreamcompleted(); });
        await tv.page.getByText("Ending playback…", { exact: true }).waitFor();
        assert.equal(await tv.focused(), "back");
        assert.equal(tv.fake.requests.filter(r => r.path.startsWith("/watch/")).length, watchReads, "EOF must wait for STOP before reading the next episode");
        stop.release();
        await tv.page.getByRole("button", { name: "Play Now", exact: true }).waitFor();
        assert.equal(await tv.focused(), "back", "adding a next action must not move surviving focus");
        // The old screen had no background On Deck reads; hold them outside the focus-only assertion.
        await tv.eventually(async () => tv.fake.requests.filter(r => r.path.startsWith("/home/sections")).length > deckReads, "On Deck read");
        const requests = tv.fake.requests.length;
        await tv.remote(38);
        assert.equal(await tv.focused(), "play-next");
        await tv.remote(40);
        await tv.remote(38);
        assert.equal(tv.fake.requests.length, requests, "focus movement must never fetch");
        deck.release();
        assert.equal(await tv.page.getByText(/saved|completed/i).count(), 0);
        await tv.remote(13);
        await tv.remote(13);
        await prepare(tv);
        const starts = tv.fake.requests.filter(r => r.path === "/playback/start");
        assert.equal(starts.length, 2);
        assert.equal(starts[1]?.body?.file_id, "43");
        assert.equal(starts[1]?.body?.start_position, 0);
        await tv.remote(10009);
        await tv.page.locator('[data-view="home"]').waitFor();
        assert.equal(await tv.focused(), "episode:s1e12");
        assert.equal(tv.fake.requests.filter(r => r.path === "/playback/start").length, 2);
    }, true);
}

appTest("Back during EOF STOP restores Browse and late answers cannot show continuation", async (tv, playback, catalog) => {
    await startEpisode(tv, playback, catalog);
    const watchReads = tv.fake.requests.filter(r => r.path.startsWith("/watch/")).length;
    const id = [...playback.sessions.keys()][0];
    assert.ok(id !== undefined);
    const stop = tv.fake.hold(`/playback/${id}`, true);
    await tv.page.evaluate(() => window.appHarness.avplay.listener?.onstreamcompleted());
    await tv.page.getByText("Ending playback…", { exact: true }).waitFor();
    await tv.remote(10009);
    await tv.page.locator('[data-view="home"]').waitFor();
    stop.release();
    await tv.jump(0);
    assert.equal(await tv.focused(), "episode:s1e12");
    assert.equal(await tv.page.getByRole("button", { name: "Play Now", exact: true }).count(), 0);
    assert.equal(tv.fake.requests.filter(r => r.path.startsWith("/watch/")).length, watchReads, "abandoned EOF must not read the next episode");
}, true);

for (const reduced of [false, true]) {
    appTest(`expired progress at EOF offers only Back in ${reduced ? "reduced" : "normal"} motion`, async (tv, playback, catalog) => {
        await tv.page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
        await startEpisode(tv, playback, catalog);
        const id = [...playback.sessions.keys()][0];
        assert.ok(id !== undefined);
        const progress = tv.fake.hold(`/playback/${id}/progress`);
        playback.sessions.delete(id);
        await tv.jump(10000);
        await tv.page.evaluate(() => window.appHarness.avplay.listener?.onstreamcompleted());
        await tv.page.getByText("Ending playback…", { exact: true }).waitFor();
        progress.release();
        await tv.page.getByText("Could not confirm playback or load the next episode.", { exact: true }).waitFor();
        assert.equal(await tv.page.getByRole("button", { name: "Retry", exact: true }).count(), 0);
        assert.equal(await tv.page.getByRole("button", { name: "Play Now", exact: true }).count(), 0);
        assert.equal(await tv.focused(), "back");
        assert.equal(tv.fake.requests.filter(request => request.method === "DELETE").length, 0);
        assert.equal(tv.fake.requests.filter(request => request.path === "/playback/start").length, 1);
        await tv.remote(13);
        await tv.page.locator('[data-view="home"]').waitFor();
        assert.equal(await tv.focused(), "episode:s1e12");
    }, true);
}

for (const reduced of [false, true]) {
    appTest(`EOF STOP on an expired session offers only Back in ${reduced ? "reduced" : "normal"} motion`, async (tv, playback, catalog) => {
        await tv.page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
        await startEpisode(tv, playback, catalog);
        const id = [...playback.sessions.keys()][0];
        assert.ok(id !== undefined);
        playback.sessions.delete(id);
        await tv.page.evaluate(() => window.appHarness.avplay.listener?.onstreamcompleted());
        await tv.page.getByText("Could not confirm playback or load the next episode.", { exact: true }).waitFor();
        assert.equal(await tv.page.getByRole("button", { name: "Retry", exact: true }).count(), 0);
        assert.equal(await tv.page.getByRole("button", { name: "Play Now", exact: true }).count(), 0);
        assert.equal(await tv.focused(), "back");
        assert.equal(tv.fake.requests.filter(r => r.method === "DELETE").length, 1);
        await tv.remote(13);
        await tv.page.locator('[data-view="home"]').waitFor();
    }, true);
}

appTest("EOF during a refused subtitle change still offers manual continuation", async (tv, playback, catalog) => {
    await startEpisode(tv, playback, catalog);
    const id = [...playback.sessions.keys()][0];
    assert.ok(id !== undefined);
    playback.next.push({ terminal: "adaptation_unavailable" });
    const response = tv.fake.hold(`/playback/${id}/replan`);
    // Down focuses Play/Pause. Show Up Next sits before Options on an episode, so three Rights reach Options. Enter opens Info. Stats and Video sit between Info and Audio in the expanded HUD.
    await tv.remote(40);
    await tv.remote(39);
    await tv.remote(39);
    await tv.remote(39);
    await tv.remote(13);
    for (let tab = 0; tab < 4; tab++) await tv.remote(39);
    assert.equal(await tv.page.getByRole("tab", { name: "Subtitles", exact: true }).getAttribute("aria-selected"), "true");
    await tv.page.locator('.player-menu [data-focus="file:42:subtitle:0"]').click();
    await tv.page.evaluate(() => window.appHarness.avplay.listener?.onstreamcompleted());
    assert.equal(tv.fake.requests.filter(r => r.method === "DELETE").length, 0);
    response.release();
    await tv.page.getByRole("button", { name: "Play Now", exact: true }).waitFor();
    assert.equal(tv.fake.requests.filter(r => r.method === "DELETE").length, 1);
    assert.equal(tv.fake.requests.filter(r => r.path === "/playback/start").length, 1);
}, true);

appTest("EOF read failure retries without a second STOP and Stop restores origin", async (tv, playback, catalog) => {
    await startEpisode(tv, playback, catalog);
    catalog.watchOverrides.set("episode:s1e12", { versions: "malformed" });
    await tv.page.evaluate(() => window.appHarness.avplay.listener?.onstreamcompleted());
    await tv.page.getByRole("button", { name: "Retry", exact: true }).waitFor();
    assert.equal(await tv.page.getByRole("button", { name: "Play Now", exact: true }).count(), 0);
    catalog.watchOverrides.delete("episode:s1e12");
    await tv.remote(38);
    assert.equal(await tv.focused(), "settings-retry");
    await tv.remote(13);
    await tv.page.getByRole("button", { name: "Play Now", exact: true }).waitFor();
    assert.equal(tv.fake.requests.filter(r => r.method === "DELETE" && r.path.startsWith("/playback/")).length, 1);
    await tv.remote(413);
    await tv.page.locator('[data-view="home"]').waitFor();
    assert.equal(await tv.focused(), "episode:s1e12");
}, true);

appTest("the final episode has a focusable Back action and no cross-title start", async (tv, playback, catalog) => {
    await startEpisode(tv, playback, catalog, "episode:s1e23");
    await tv.page.evaluate(() => window.appHarness.avplay.listener?.onstreamcompleted());
    // Old series end put "Up Next" in the heading; Apple uses a status above the candidate title.
    await tv.page.locator(".player-next-eyebrow", { hasText: "Up Next" }).waitFor();
    await tv.page.getByRole("heading", { name: "Movie 0001", exact: true }).waitFor();
    assert.equal(await tv.focused(), "back");
    assert.equal(await tv.page.getByRole("button", { name: "Play Now", exact: true }).count(), 1);
    await tv.remote(38);
    assert.equal(await tv.focused(), "play-next");
    assert.equal(tv.fake.requests.filter(r => r.method === "DELETE").length, 1);
    await tv.remote(413);
    await tv.page.locator('[data-view="home"]').waitFor();
    assert.equal(await tv.focused(), "episode:s1e23");
    assert.equal(tv.fake.requests.filter(r => r.path === "/playback/start").length, 1);
}, true);

appTest("saved server profile 15/45 reaches the composed controller and every remote seek surface", async (tv, playback) => {
    const settings = new FakeSettings(tv.fake);
    await signIn(tv);
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await tv.page.locator('[data-focus="playback"]').click();
    // The skip rows appear only after the settings contract loads. Counting immediately reads the empty pane.
    await tv.page.locator('[data-focus="seek-back"]').waitFor();
    await tv.page.locator('[data-focus="seek-forward"]').waitFor();
    assert.equal(await tv.page.locator('[data-focus="seek-back"], [data-focus="seek-forward"]').count(), 2);
    await tv.page.locator('[data-focus="seek-back"]').click();
    await tv.page.getByRole('radio', { name: '15 seconds', exact: true }).click();
    await tv.eventually(async () => settings.profile().get(SEEK_BACK_KEY) === 15, 'back interval saved');
    await tv.page.getByRole('dialog').waitFor({ state: 'detached' });
    await tv.page.locator('[data-focus="seek-forward"]').click();
    await tv.page.getByRole('radio', { name: '45 seconds', exact: true }).click();
    await tv.eventually(async () => settings.profile().get(SEEK_FORWARD_KEY) === 45, 'forward interval saved');
    await tv.page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal(settings.profile().get(SEEK_BACK_KEY), 15);
    assert.equal(settings.profile().get(SEEK_FORWARD_KEY), 45);
    await tv.remote(10009);
    assert.equal(await tv.focused(), "playback");
    await tv.remote(10009);
    await tv.page.locator('.settings').waitFor({ state: 'detached' });
    playback.next.push({ durationSeconds: 200, timeline: { source_start_seconds: 100, player_start_seconds: 100, timeline_offset_seconds: 0 } });
    await tv.page.locator('.skyline-continue[data-focus="movie:m0001"]').focus();
    await tv.remote(415);
    await prepare(tv);
    assert.equal(await tv.page.locator('[data-view^="item:"]').count(), 0);
    // Keep the debounce from committing between remote inputs on a slow host.
    await tv.page.clock.pauseAt(await tv.page.evaluate(() => Date.now() + 1000));
    const position = () => tv.page.getByRole("slider").getAttribute("aria-valuenow");
    assert.equal(await tv.page.getByRole("button", { name: "Back 15 seconds", exact: true }).count(), 1);
    assert.equal(await tv.page.getByRole("button", { name: "Forward 45 seconds", exact: true }).count(), 1);
    await tv.remote(37);
    assert.equal(await position(), "85");
    await tv.remote(39);
    assert.equal(await position(), "130");
    await tv.remote(10009);
    assert.equal(await position(), "100");
    await tv.remote(39);
    assert.equal(await position(), "145");
    await tv.remote(13);
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.calls.slice(-1)[0]), "seekTo 145000");
    await tv.page.evaluate(() => { window.appHarness.avplay.finishSeek(); window.appHarness.avplay.tick(100000); });
    await tv.remote(412);
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.calls.slice(-1)[0]), "seekTo 85000");
    await tv.page.evaluate(() => { window.appHarness.avplay.finishSeek(); window.appHarness.avplay.tick(100000); });
    await tv.remote(417);
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.calls.slice(-1)[0]), "seekTo 145000");
    await tv.page.evaluate(() => window.appHarness.avplay.finishSeek());
    await tv.remote(10009);
    await tv.page.locator('[data-view="home"]').waitFor();
    assert.equal(await tv.focused(), "movie:m0001");
    assert.equal(tv.fake.requests.filter(r => r.path === "/playback/start").length, 1);
});

appTest("the composed app signs in, selects a profile, plays and returns to the same title", async (tv, playback) => {
    await signIn(tv);
    await startMovie(tv);
    assert.equal(await tv.page.locator(".browse").isVisible(), false);
    assert.equal(await tv.page.locator("object.player-video").count(), 1);
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.state), "PAUSED");
    // Old path: Enter toggled pause, and one Back left playback. Select now enters timeline scrub, so the first Back cancels it.
    await tv.remote(10009);
    assert.equal(await tv.page.locator('[data-screen="player"]').count(), 1);
    await tv.remote(10009);
    await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
    assert.equal(await tv.focused(), "play");
    assert.equal(await tv.page.locator('[data-screen="player"]').count(), 0);
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.state), "NONE");
    await tv.eventually(async () => [...playback.sessions.values()].every((session) => session.receipt !== undefined), "final stop receipt");
}, true);

appTest("Home Continue uses the existing app player owner once and returns without replaying", async (tv, playback) => {
    await signIn(tv);
    const detail = tv.fake.hold("/catalog/items/movie%3Am0001", true);
    await tv.page.locator('.skyline-continue[data-focus="movie:m0001"]').focus();
    await tv.remote(415);
    await tv.page.locator('[data-view="resume:loading"]').waitFor();
    assert.equal(await tv.page.locator('[data-view^="item:"]').count(), 0);
    detail.release();
    await prepare(tv);
    assert.equal(playback.sessions.size, 1);
    const starts = tv.fake.requests.filter(request => request.path === "/playback/start");
    assert.equal(starts.length, 1);
    assert.equal(starts[0]?.method, "POST");
    assert.equal(starts[0]?.body?.file_id, "42");
    assert.equal(starts[0]?.body?.start_position, 1200);
    assert.equal(starts[0]?.headers["x-profile-id"], "p-owner");
    await tv.remote(10009);
    await tv.page.locator('[data-view="home"] [data-focus="movie:m0001"]').first().waitFor();
    assert.equal(await tv.focused(), "movie:m0001");
    assert.equal(tv.fake.requests.filter(request => request.path === "/playback/start").length, 1);
});

/** Apple's tvOS `errorView`: top-pinned, no title, 40pt siloError mark, siloBody, primary buttons. */
function readPlaybackFailure(): {
    titleShown: boolean;
    titleText: string;
    message: string;
    focused: string;
    markTop: number;
    playerTop: number;
    markWidth: number;
    markHeight: number;
    markColor: string;
    markCenter: number;
    playerCenter: number;
    copySize: string;
    copyWeight: string;
    copyColor: string;
    copyAlign: string;
    copyPad: string;
    belowMark: number;
    belowCopy: number;
    direction: string;
    gap: string;
    retryHidden: boolean;
    retryText: string;
    backText: string;
    retry: { minWidth: string; size: string; weight: string; line: string; background: string; color: string; radius: string; height: string; layoutWidth: number | null; layoutHeight: number | null; transform: string; ring: boolean };
    back: { minWidth: string; size: string; weight: string; line: string; background: string; color: string; radius: string; height: string; layoutWidth: number | null; layoutHeight: number | null; transform: string; ring: boolean };
    rowGap: number | null;
    rowCenter: number;
} | null {
    const player = document.querySelector(".player");
    const wall = document.querySelector(".player-error-wall");
    if (!(player instanceof HTMLElement) || !(wall instanceof HTMLElement)) return null;
    const title = wall.querySelector(".player-title");
    const mark = wall.querySelector(".player-error-mark");
    const copy = wall.querySelector(".player-error-text");
    const actions = wall.querySelector(".player-error-actions");
    const retry = wall.querySelector('[data-focus="settings-retry"]');
    const back = wall.querySelector('[data-focus="back"]');
    if (!(mark instanceof HTMLElement) || !(copy instanceof HTMLElement) || !(actions instanceof HTMLElement) || !(retry instanceof HTMLButtonElement) || !(back instanceof HTMLButtonElement)) return null;
    if (!player.isConnected || !wall.isConnected || !mark.isConnected || !copy.isConnected) return null;
    const button = (node: HTMLButtonElement) => {
        const style = getComputedStyle(node);
        return {
            minWidth: style.minWidth,
            size: style.fontSize,
            weight: style.fontWeight,
            line: style.lineHeight,
            background: style.backgroundColor,
            color: style.color,
            radius: style.borderRadius,
            height: style.height,
            layoutWidth: node.hidden ? null : node.offsetWidth,
            layoutHeight: node.hidden ? null : node.offsetHeight,
            transform: style.transform,
            ring: style.boxShadow.includes("rgb(255, 255, 255) 0px 0px 0px 2px"),
        };
    };
    const playerBox = player.getBoundingClientRect();
    const markBox = mark.getBoundingClientRect();
    const copyBox = copy.getBoundingClientRect();
    const actionBox = actions.getBoundingClientRect();
    const copyStyle = getComputedStyle(copy);
    const actionStyle = getComputedStyle(actions);
    const markStyle = getComputedStyle(mark);
    const first = retry.hidden ? back : retry;
    const parent = first.offsetParent instanceof HTMLElement ? first.offsetParent.getBoundingClientRect() : actionBox;
    return {
        titleShown: title instanceof HTMLElement && title.getClientRects().length > 0,
        titleText: title?.textContent ?? "",
        message: copy.textContent ?? "",
        focused: document.activeElement?.getAttribute("data-focus") ?? "",
        markTop: markBox.top,
        playerTop: playerBox.top,
        markWidth: markBox.width,
        markHeight: markBox.height,
        markColor: markStyle.color,
        markCenter: (markBox.left + markBox.right) / 2,
        playerCenter: (playerBox.left + playerBox.right) / 2,
        copySize: copyStyle.fontSize,
        copyWeight: copyStyle.fontWeight,
        copyColor: copyStyle.color,
        copyAlign: copyStyle.textAlign,
        copyPad: copyStyle.paddingLeft,
        belowMark: copyBox.top - markBox.bottom,
        belowCopy: actionBox.top - copyBox.bottom,
        direction: actionStyle.flexDirection,
        gap: actionStyle.gap,
        retryHidden: retry.hidden === true,
        retryText: retry.textContent ?? "",
        backText: back.textContent ?? "",
        retry: button(retry),
        back: button(back),
        rowGap: retry.hidden ? null : back.offsetLeft - (retry.offsetLeft + retry.offsetWidth),
        rowCenter: parent.left + (first.offsetLeft + back.offsetLeft + back.offsetWidth) / 2,
    };
}

const failureButton = {
    minWidth: "140px",
    size: "28px",
    weight: "600",
    line: "34px",
    background: "rgba(237, 237, 237, 0.72)",
    color: "rgb(0, 0, 0)",
    radius: "31px",
    height: "62px",
    layoutWidth: 140,
    layoutHeight: 62,
    transform: "none",
    ring: false,
};

const failureButtonFocus = {
    ...failureButton,
    background: "rgb(237, 237, 237)",
    transform: "matrix(1.055, 0, 0, 1.055, 0, 0)",
    ring: true,
};

/** "Go Back" at siloSubheadline exceeds the 140px minimum; "Retry" stays on it. Tracking makes the label 141px, so the row centre is half a pixel from the player. */
const failureBack = { ...failureButton, layoutWidth: 141 };
const failureBackFocus = { ...failureButtonFocus, layoutWidth: 141 };

async function showPlaybackFailure(tv: Tv, playback: FakePlayback, decision: { terminal: string; retryable?: boolean }): Promise<void> {
    await signIn(tv);
    playback.next.push(decision);
    await tv.page.locator('.skyline-continue[data-focus="movie:m0001"]').focus();
    await tv.remote(415);
    await tv.page.locator(".player-error-wall").waitFor();
    await tv.page.addStyleTag({ content: ".player-error-wall, .player-error-wall * { transition: none !important; }" });
    await tv.jump(0);
}

appTest("a terminal playback failure matches Apple's top-pinned error view and its server sentence", async (tv, playback) => {
    await showPlaybackFailure(tv, playback, { terminal: "source_unreadable" });
    const wall = await readLive(tv, readPlaybackFailure, null, (value) => value.message.length > 0, "terminal failure wall settled");
    assert.deepEqual(wall, {
        titleShown: false,
        titleText: "",
        message: "Cannot play: source_unreadable",
        focused: "back",
        markTop: wall.playerTop,
        playerTop: wall.playerTop,
        markWidth: 40,
        markHeight: 40,
        markColor: "rgb(176, 0, 32)",
        markCenter: wall.playerCenter,
        playerCenter: wall.playerCenter,
        copySize: "26px",
        copyWeight: "400",
        copyColor: "rgb(255, 255, 255)",
        copyAlign: "center",
        copyPad: "16px",
        belowMark: 16,
        belowCopy: 16,
        direction: "row",
        gap: "16px",
        retryHidden: true,
        retryText: "Retry",
        backText: "Go Back",
        retry: { ...failureButton, layoutWidth: null, layoutHeight: null },
        back: failureBackFocus,
        rowGap: null,
        rowCenter: wall.playerCenter + 0.5,
    });
});

appTest("a retryable playback failure keeps Retry focused and Back leaves without another start", async (tv, playback) => {
    await showPlaybackFailure(tv, playback, { terminal: "temporarily_unavailable", retryable: true });
    const wall = await readLive(tv, readPlaybackFailure, null, (value) => value.message.length > 0 && value.focused === "settings-retry", "retryable failure wall settled");
    assert.deepEqual(wall, {
        titleShown: false,
        titleText: "",
        message: "Cannot play: temporarily_unavailable",
        focused: "settings-retry",
        markTop: wall.playerTop,
        playerTop: wall.playerTop,
        markWidth: 40,
        markHeight: 40,
        markColor: "rgb(176, 0, 32)",
        markCenter: wall.playerCenter,
        playerCenter: wall.playerCenter,
        copySize: "26px",
        copyWeight: "400",
        copyColor: "rgb(255, 255, 255)",
        copyAlign: "center",
        copyPad: "16px",
        belowMark: 16,
        belowCopy: 16,
        direction: "row",
        gap: "16px",
        retryHidden: false,
        retryText: "Retry",
        backText: "Go Back",
        retry: failureButtonFocus,
        back: failureBack,
        rowGap: 16,
        rowCenter: wall.playerCenter + 0.5,
    });
    const starts = tv.fake.requests.filter((request) => request.path === "/playback/start").length;
    await tv.remote(10009);
    await tv.page.locator('[data-view="home"] [data-focus="movie:m0001"]').first().waitFor();
    assert.equal(await tv.focused(), "movie:m0001");
    assert.equal(await tv.page.locator('[data-screen="player"]').count(), 0);
    assert.equal(tv.fake.requests.filter((request) => request.path === "/playback/start").length, starts);
});

appTest("Home Continue keeps an unreadable playback source in the existing error owner without resending", async (tv, playback) => {
    await signIn(tv);
    playback.next.push({ terminal: "source_unreadable" });
    await tv.page.locator('.skyline-continue[data-focus="movie:m0001"]').focus();
    await tv.remote(415);
    await tv.page.locator('.player-error').waitFor();
    assert.equal(await tv.page.locator('[data-view^="item:"]').count(), 0);
    await tv.jump(30000);
    assert.equal(tv.fake.requests.filter(request => request.path === "/playback/start").length, 1, "a failed start never resends itself");
    await tv.remote(10009);
    await tv.page.locator('[data-view="home"] [data-focus="movie:m0001"]').first().waitFor();
    assert.equal(await tv.focused(), "movie:m0001");
    assert.equal(tv.fake.requests.filter(request => request.path === "/playback/start").length, 1);
});

appTest("completion Back replays the tail; Stop and dismissed errors restore origin without an exit dialog", async (tv, playback) => {
    await signIn(tv);
    await startMovie(tv);
    await tv.page.evaluate(() => window.appHarness.avplay.listener?.onstreamcompleted());
    // Old movie EOF closed immediately. Apple offers On Deck and Back replays the last ten seconds.
    await tv.page.getByRole("button", { name: "Play Now", exact: true }).waitFor();
    assert.equal(tv.fake.requests.filter(r => r.path === "/playback/start").length, 1);
    assert.equal(tv.fake.requests.filter(r => r.method === "DELETE").length, 1);
    await tv.remote(10009);
    await prepare(tv);
    const starts = tv.fake.requests.filter(r => r.path === "/playback/start");
    assert.equal(starts.length, 2);
    assert.equal(starts[1]?.body?.file_id, "42");
    assert.equal(starts[1]?.body?.start_position, 7190);
    await tv.remote(413);
    await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
    assert.equal(await tv.focused(), "play");
    await tv.eventually(async () => [...playback.sessions.values()].every(s => s.receipt !== undefined), "both playback attempts stopped");
    assert.equal(tv.fake.requests.filter(r => r.method === "DELETE").length, 2);
    await tv.page.locator('[data-focus="play"]').click();
    await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.pendingPrepares > 0), "second preparation");
    await tv.page.evaluate(() => window.appHarness.avplay.finishPrepare("InvalidAccessError"));
    await tv.page.locator(".player-error").waitFor();
    await tv.remote(10009);
    await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
    assert.equal(await tv.page.getByRole("dialog").count(), 0);
});

appTest("reopening a committed scrub holds its pending resume until Select", async tv => {
    await signIn(tv);
    await startMovie(tv);
    await pauseTvClock(tv);
    await tv.remote(13);
    await tv.remote(39);
    await tv.remote(13);
    const seeks = await tv.page.evaluate(() => window.appHarness.avplay.calls.filter(call => call.startsWith("seekTo ")).length);
    await tv.remote(13);
    await tv.page.evaluate(() => window.appHarness.avplay.finishSeek());
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.state), "PAUSED");
    assert.equal(await tv.page.locator(".player-bar-preview").count(), 1);
    await tv.remote(13);
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.state), "PLAYING");
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.calls.filter(call => call.startsWith("seekTo ")).length), seeks);
});

for (const [command, state] of [[415, "PLAYING"], [19, "PAUSED"], [10252, "PAUSED"]] as const) appTest(`a moved reopened scrub keeps its target and latest transport command (${command})`, async tv => {
    await signIn(tv);
    await startMovie(tv);
    await pauseTvClock(tv);
    await tv.remote(13);
    await tv.remote(39);
    await tv.remote(13);
    const seeks = await tv.page.evaluate(() => window.appHarness.avplay.calls.filter(call => call.startsWith("seekTo ")).length);
    await tv.remote(13);
    await tv.remote(39);
    const target = Number(await tv.page.getByRole("slider").getAttribute("aria-valuenow"));
    await tv.remote(13);
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.calls.filter(call => call.startsWith("seekTo ")).length), seeks);
    await tv.remote(command);
    await tv.page.evaluate(() => window.appHarness.avplay.finishSeek());
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.calls.filter(call => call.startsWith("seekTo ")).at(-1)), `seekTo ${target * 1000}`);
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.state), "PAUSED");
    await tv.page.evaluate(() => window.appHarness.avplay.finishSeek());
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.positionMs), target * 1000);
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.state), state);
});

appTest("the composed remote seeks and changes audio through the real playback owner", async (tv, playback) => {
    await signIn(tv);
    await startMovie(tv);
    await pauseTvClock(tv);
    await tv.page.evaluate(() => window.appHarness.avplay.tick(90000));
    await tv.page.keyboard.press("ArrowLeft");
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.positionMs), 90000, "preview leaves playback untouched");
    await tv.page.keyboard.press("Enter");
    await tv.page.evaluate(() => window.appHarness.avplay.finishSeek());
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.positionMs), 80000);
    // Old Down opened the panel on Audio. Down focuses Play/Pause; Options opens Info, and Audio is the next tab.
    await tv.page.keyboard.press("ArrowDown");
    await tv.page.keyboard.press("ArrowRight");
    await tv.page.keyboard.press("ArrowRight");
    await tv.page.keyboard.press("Enter");
    for (let index = 0; index < 3; index++) await tv.page.keyboard.press("ArrowRight");
    const id = [...playback.sessions.keys()][0];
    assert.ok(id !== undefined);
    const hold = tv.fake.hold(`/playback/${id}/replan`);
    assert.equal(await tv.page.getByRole("tab", { name: "Audio", exact: true }).getAttribute("aria-selected"), "true");
    await tv.page.locator('.player-menu [data-focus="file:42:audio:1"]').click();
    assert.equal(await tv.page.locator(".player-menu-status").innerText(), "Changing track", "a track button click must activate the same change as remote Enter");
    hold.release();
    await prepare(tv);
    const session = [...playback.sessions.values()][0];
    assert.equal(session?.audioIndex, 1);
    const change = tv.fake.requests.filter((request) => request.path.endsWith("/replan")).pop();
    assert.equal(change?.body?.operation, "track_change");
    assert.equal(change?.body?.position_seconds, 80);
    // Old second Down reopened the panel. A track change closes it while the new route loads, and Options opens Info.
    await tv.page.keyboard.press("ArrowDown");
    await tv.page.keyboard.press("ArrowRight");
    await tv.page.keyboard.press("ArrowRight");
    await tv.page.keyboard.press("Enter");
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.page.locator('.player-menu [data-focus="file:42:audio:1"]').getAttribute("aria-pressed"), "true");
    await tv.remote(10009);
    assert.equal(await tv.page.locator(".player-menu").isVisible(), false);
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.state), "PLAYING", "menu Back does not exit playback");
});

appTest("destroy during preparation is idempotent and late callbacks cannot replace a restored picker", async (tv) => {
    await signIn(tv);
    await tv.page.locator('.browse-card:not(.skyline-continue)[data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="play"]').click();
    await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.pendingPrepares > 0), "held preparation");
    await tv.page.evaluate(() => { window.appHarness.destroy(); window.appHarness.destroy(); window.appHarness.mount(); });
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    await tv.page.evaluate(() => { window.appHarness.avplay.finishPrepare(); window.appHarness.avplay.listener?.onstreamcompleted(); });
    assert.equal(await tv.screen(), "profiles");
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.state), "NONE");
    assert.equal(await tv.focused(), "profile:p-owner");
});

appTest("native posters keep their shape and the exit modal covers the viewport", async (tv) => {
    await signIn(tv);
    const poster = await tv.page.locator('.browse-card:not(.skyline-continue) .browse-art').first().boundingBox();
    assert.ok(poster !== null);
    assert.ok(Math.abs(poster.height / poster.width - 1.5) < 0.001);
    await tv.remote(10009);
    assert.equal(await tv.focused(), "home");
    assert.equal(await tv.page.getByRole("dialog").count(), 0);
    await tv.remote(10009);
    const dialog = await tv.page.getByRole("dialog").boundingBox();
    assert.deepEqual(dialog, { x: 0, y: 0, width: 1920, height: 1080 });
    const exit = await tv.page.getByRole("button", { name: "Exit", exact: true }).boundingBox();
    const cancel = await tv.page.getByRole("button", { name: "Cancel", exact: true }).boundingBox();
    assert.ok(exit !== null && cancel !== null);
    assert.ok(cancel.x - exit.x - exit.width >= 24);
    assert.ok(cancel.y + cancel.height <= 1080);
});

appTest("committing Change Account clears PIN authority while cancelling preserves it", async tv => {
    await signIn(tv);
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.locator('[data-focus="switch-profile"]').click();
    await tv.page.locator('[data-focus="profile:p-kid"]').click();
    await tv.page.fill("#profile-pin", "2468");
    await tv.page.getByRole("button", { name: "Unlock", exact: true }).click();
    await tv.page.locator('[data-view="home"] [data-focus="movie:k1"]').waitFor();
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Change Account", exact: true }).click();
    await tv.remote(10009); await tv.remote(10009);
    await tv.page.locator('[data-view="home"] [data-focus="movie:k1"]').waitFor();
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Change Account", exact: true }).click();
    await tv.page.locator('.account-card').first().click();
    await tv.page.locator('[data-focus="profile:p-kid"]').click();
    await tv.page.locator('[data-screen="pin"]').waitFor();
    await tv.page.fill("#profile-pin", "2468");
    await tv.page.getByRole("button", { name: "Unlock", exact: true }).click();
    await tv.page.locator('[data-view="home"] [data-focus="movie:k1"]').waitFor();
    assert.equal(tv.fake.paths().filter(path => path === "POST /profiles/p-kid/verify-pin").length, 2, "choosing the account again requires fresh PIN proof");
});

appTest("a profile-proof refusal stops playback and leaves the PIN successor intact", async (tv) => {
    await signIn(tv);
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.locator('[data-focus="switch-profile"]').click();
    await tv.page.getByRole("button", { name: "Kid, PIN protected", exact: true }).waitFor();
    await tv.page.locator('[data-focus="profile:p-kid"]').click();
    await tv.page.fill("#profile-pin", "2468");
    await tv.page.getByRole("button", { name: "Unlock", exact: true }).click();
    await tv.page.locator('[data-view="home"] [data-focus="movie:k1"]').waitFor();
    await startMovie(tv, "movie:k1");
    tv.fake.changePin("p-kid", "1357");
    await tv.jump(10000);
    await tv.page.locator('[data-screen="pin"]').waitFor();
    assert.equal(await tv.page.locator('[data-screen="player"]').count(), 0);
    assert.equal(await tv.page.locator(".browse").count(), 0);
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.state), "NONE");
    await tv.page.evaluate(() => window.appHarness.avplay.listener?.onstreamcompleted());
    assert.equal(await tv.screen(), "pin", "stale completion cannot repaint over the PIN screen");
});

appTest("sign-out returns its notice to entry and relaunch cannot restore the removed account", async (tv) => {
    await signIn(tv);
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.locator('[data-focus="switch-profile"]').click();
    await tv.page.getByRole("button", { name: "Sign out", exact: true }).click();
    await tv.page.locator('[data-screen="entry"]').waitFor();
    await tv.page.evaluate(() => window.appHarness.mount());
    await tv.page.locator('[data-screen="entry"]').waitFor();
    assert.equal(await tv.page.locator("#signin-address").inputValue(), "", "signing out of the last account removes its server");
    assert.equal(await tv.page.locator('[data-screen="profiles"]').count(), 0);
    assert.equal(await tv.page.locator(".browse").count(), 0);
});

appTest("relaunch restores the protected account but still asks who is watching", async (tv) => {
    await signIn(tv);
    await tv.page.evaluate(() => window.appHarness.mount());
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    assert.equal(await tv.page.locator('[data-screen="code"]').count(), 0);
    assert.equal(await tv.focused(), "profile:p-owner");
    assert.equal(await tv.page.locator(".browse").count(), 0);
});

appTest("root Back opens an isolated exit dialog; Cancel restores focus and Exit tears down", async (tv) => {
    await tv.remote(10009);
    await tv.page.getByRole("dialog").waitFor();
    assert.equal(await tv.focused(), "cancel-exit");
    await tv.page.keyboard.press("ArrowLeft");
    assert.equal(await tv.focused(), "exit");
    await tv.remote(10009);
    assert.equal(await tv.page.getByRole("dialog").count(), 0);
    assert.equal(await tv.focused(), "address");
    await signIn(tv);
    const focused = await tv.focused();
    const requests = tv.fake.requests.length;
    await tv.remote(10009);
    assert.equal(await tv.focused(), "home");
    assert.equal(await tv.page.getByRole("dialog").count(), 0);
    await tv.remote(10009);
    await tv.page.keyboard.press("ArrowDown");
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(tv.fake.requests.length, requests, "modal keys never reach browse");
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.focused(), "home");
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), focused);
    await tv.remote(10009);
    await tv.remote(10009);
    await tv.page.keyboard.press("ArrowLeft");
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.page.evaluate(() => window.appHarness.exits), 1);
    assert.equal(await tv.page.locator("#root").evaluate((root) => root.childElementCount), 0);
    await tv.remote(10009);
    assert.equal(await tv.page.getByRole("dialog").count(), 0, "teardown removed the app key listener");
});

appTest("library scope survives a full app remount for the same server and profile", async (tv, _playback, catalog) => {
    const owner = catalog.households.get("p-owner");
    assert.ok(owner !== undefined);
    owner.hidden = null;
    await signIn(tv);
    await tv.page.locator('[data-focus="movies"]').focus();
    await tv.jump(250);
    await tv.page.locator('[data-focus="library:15"]').click();
    await tv.page.locator('[data-view="library:15"]').waitFor();
    await tv.page.evaluate(() => window.appHarness.mount());
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    await tv.page.locator('[data-focus="profile:p-owner"]').click();
    await tv.page.locator('[data-view="home"]').waitFor();
    await tv.page.locator('[data-focus="movies"]').click();
    await tv.page.locator('[data-view="library:15"]').waitFor();
    assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/library/") && request.path.split("?")[0]?.endsWith("/sections")).at(-1)?.path.split("?")[0], "/library/15/sections");
    assert.equal(await tv.page.locator('.skyline-roots [aria-current="page"]').getAttribute("data-focus"), "movies");
});

appTest("the profile menu opens without changing content, stays dismissed after Back and signs out through its owner", async (tv) => {
    await signIn(tv);
    await tv.page.clock.pauseAt(await tv.page.evaluate(() => Date.now() + 1000));
    const requests = tv.fake.requests.length;
    await tv.page.locator('[data-focus="profiles"]').focus();
    await tv.jump(249);
    assert.equal(await tv.page.locator(".skyline-selector").first().isVisible(), false);
    await tv.jump(1);
    assert.equal(await tv.page.locator(".skyline-selector").first().isVisible(), true);
    assert.equal(await tv.focused(), "profiles");
    assert.equal(tv.fake.requests.length, requests);
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), "switch-profile");
    await tv.remote(10009);
    await tv.jump(500);
    assert.equal(await tv.page.locator(".skyline-selector").first().isVisible(), false);
    assert.equal(await tv.focused(), "profiles");
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.focused(), "switch-profile", "Select enters the menu immediately");
    for (const destination of ["history", "settings", "switch-server"]) {
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), destination);
    }
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), "signout");
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.focused(), "cancel-signout");
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.focused(), "confirm-signout");
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-screen="entry"]').waitFor();
    assert.equal(tv.fake.revokedSessions.size, 1);
    assert.equal(await tv.page.locator(".browse").count(), 0);
});

appTest("an exit failure keeps the dialog usable and Cancel restores the app", async (tv) => {
    await tv.page.evaluate(() => window.appHarness.failExit());
    await tv.remote(10009);
    await tv.page.keyboard.press("ArrowLeft");
    await tv.page.keyboard.press("Enter");
    await tv.page.getByRole("alert").waitFor();
    await tv.remote(10009);
    assert.equal(await tv.focused(), "address");
    assert.equal(await tv.page.evaluate(() => window.appHarness.exits), 0);
});

appTest("profile loading cannot remove the exit dialog or steal its focus", async (tv) => {
    const hold = tv.fake.hold("/profiles");
    await tv.page.fill("#signin-address", "silo.example.test");
    await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
    await tv.page.locator('[data-screen="code"]').waitFor();
    const code = [...tv.fake.devices.keys()].pop();
    assert.ok(code !== undefined);
    tv.fake.approve(code);
    await tv.jump(5000);
    // "Signed in as …" holds for a second before sign-in moves on.
    await tv.jump(1000);
    await tv.page.locator('[data-screen="profiles-loading"]').waitFor();
    await tv.remote(10009);
    await tv.page.getByRole("dialog").waitFor();
    await tv.page.keyboard.press("ArrowLeft");
    assert.equal(await tv.focused(), "exit");
    hold.release();
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    assert.equal(await tv.page.getByRole("dialog").isVisible(), true, "screen updates must preserve the modal");
    assert.equal(await tv.focused(), "exit", "screen updates must preserve modal focus");
    await tv.page.keyboard.press("ArrowRight");
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.page.getByRole("dialog").count(), 0);
    assert.equal(await tv.focused(), "profile:p-owner");
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-focus="ask-every-launch"]').click();
    await tv.page.locator('[data-view="home"]').waitFor();
    assert.equal(await tv.page.evaluate(() => window.appHarness.exits), 0);
});

appTest("missing AVPlay gives a usable Back state without creating a playback session", async (tv, playback) => {
    await tv.page.evaluate(() => window.appHarness.mount(false));
    await signIn(tv);
    await tv.page.locator('.browse-card:not(.skyline-continue)[data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="play"]').click();
    await tv.page.getByRole("heading", { name: "Playback unavailable", exact: true }).waitFor();
    assert.equal(playback.sessions.size, 0);
    await tv.remote(10009);
    await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
    assert.equal(await tv.focused(), "play");
});

test("the production entry uses platform ports and stops at the native sign-in screen", async () => {
    const tv = await openTv(browser, { app: "application", production: true });
    try {
        await tv.page.locator('[data-screen="entry"]').waitFor();
        assert.equal(await tv.focused(), "address");
        assert.equal(await tv.page.locator("object").count(), 0, "the player, not the package, creates AVPlay objects");
        await tv.remote(10009);
        await tv.page.keyboard.press("ArrowLeft");
        await tv.page.keyboard.press("Enter");
        assert.equal(await tv.page.evaluate(() => window.appHarness.exits), 1);
        assert.deepEqual(tv.console, []);
    } finally {
        await tv.page.context().close();
    }
});

test("a secure-platform startup failure has a focused retry and can recover", async () => {
    const tv = await openTv(browser, { app: "application", production: true });
    try {
        await tv.page.addInitScript(() => {
            const real = globalThis.crypto;
            Object.defineProperty(globalThis, "crypto", { configurable: true, get() { throw new Error("platform unavailable"); } });
            Object.defineProperty(globalThis, "restoreCrypto", { value: () => Object.defineProperty(globalThis, "crypto", { value: real }) });
        });
        await tv.page.reload();
        await tv.page.locator('[data-screen="startup-failed"]').waitFor();
        assert.equal(await tv.focused(), "retry");
        await tv.page.evaluate(() => {
            const restore: unknown = Reflect.get(globalThis, "restoreCrypto");
            if (typeof restore === "function") { restore(); }
        });
        await tv.page.keyboard.press("Enter");
        await tv.page.locator('[data-screen="entry"]').waitFor();
        assert.equal(await tv.focused(), "address");
        assert.deepEqual(tv.console, []);
    } finally {
        await tv.page.context().close();
    }
});
