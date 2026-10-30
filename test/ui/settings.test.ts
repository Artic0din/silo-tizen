import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { AUDIO_KEY, HIDDEN_KEY } from "../../src/contracts/v2/settings.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

async function setup() {
    const tv = await openTv(browser, { app: "browse", ...(process.env.SETTINGS_CAPTURE_DIR === undefined ? {} : { video: process.env.SETTINGS_CAPTURE_DIR }) });
    tv.fake.catalog = new FakeCatalog();
    const settings = new FakeSettings(tv.fake);
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase) === "signed_in", "sign in");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.page.locator('[data-view="home"]').waitFor();
    return { tv, settings };
}
async function openSettings(tv: Tv): Promise<void> {
    await tv.page.locator('[data-focus="profiles"]').focus();
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).count(), 1, "avatar menu exposes Settings");
    await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await tv.page.getByRole("button", { name: /Hidden libraries/ }).waitFor();
}

test("Settings uses category, row and picker Back focus with no requests on focus", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        assert.equal(await tv.focused(), "general");
        const requests = tv.fake.requests.length;
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "playback");
        await tv.page.keyboard.press("ArrowRight");
        assert.equal(await tv.focused(), "audio");
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("heading", { name: "Preferred audio" }).waitFor();
        await tv.remote(10009);
        assert.equal(await tv.focused(), "audio");
        await tv.remote(10009);
        assert.equal(await tv.focused(), "playback");
        assert.equal(tv.fake.requests.length, requests);
        await tv.remote(10009);
        assert.equal(await tv.focused(), "profiles");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("hidden libraries persist absent IDs and refresh Home and navigation on return", async () => {
    const { tv, settings } = await setup();
    try {
        settings.profile().set(HIDDEN_KEY, [15, 999]);
        await openSettings(tv);
        await tv.page.locator('[data-focus="hidden"]').click();
        await tv.page.locator('[data-focus="library:12"]').click();
        await tv.eventually(async () => JSON.stringify(settings.profile().get(HIDDEN_KEY)) === "[15,999,12]", "confirmed hidden libraries");
        await tv.page.getByText("Saving…", { exact: true }).waitFor({ state: "hidden" });
        await tv.remote(10009);
        await tv.remote(10009);
        await tv.remote(10009);
        await tv.eventually(async () => tv.fake.requests.filter(request => request.path === "/user/libraries").length === 2, "refreshed Home libraries");
        assert.ok(tv.fake.requests.some(request => request.path === "/user/libraries?include_hidden=true"));
        assert.equal(await tv.page.locator('[role="tab"][data-focus="movies"]').count(), 0);
        assert.equal(await tv.focused(), "profiles");
    } finally { await tv.page.context().close(); }
});

test("audio picker preserves unfamiliar explicit tags, null and inherited reset with narrower override", async () => {
    const { tv, settings } = await setup();
    try {
        settings.profile().set(AUDIO_KEY, "en-AU");
        settings.overrides.set(AUDIO_KEY, "fr");
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="audio"]').click();
        assert.equal(await tv.page.locator('[data-focus="audio:en-AU"][aria-checked="true"]').count(), 1);
        await tv.page.locator('[data-focus="audio:null"]').click();
        await tv.page.locator('[data-focus="audio"]').waitFor();
        assert.equal(settings.profile().get(AUDIO_KEY), null);
        await tv.page.getByText(/On this TV: fr/).waitFor();
        await tv.page.locator('[data-focus="audio"]').click();
        await tv.page.locator('[data-focus="reset"]').click();
        await tv.page.locator('[data-focus="audio"]').waitFor();
        assert.equal(settings.profile().has(AUDIO_KEY), false);
        assert.equal(settings.overrides.get(AUDIO_KEY), "fr");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("settings refusal is retryable by reload, and a late answer cannot outlive profile authority", async () => {
    const { tv } = await setup();
    try {
        tv.fake.script("/settings/contract/capabilities", problem(403, "permission_denied", "Denied"));
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await tv.page.getByRole("alert").waitFor();
        const hold = tv.fake.hold("/settings/contract/capabilities", true);
        await tv.page.getByRole("button", { name: "Reload settings" }).click();
        await tv.page.getByRole("status").waitFor();
        assert.ok(await tv.page.getByRole("button", { name: "Back", exact: true }).isVisible());
        await tv.page.evaluate(() => window.browseHarness.clearProfile());
        hold.release();
        await tv.page.locator("#successor").waitFor();
        assert.equal(await tv.page.locator(".settings").count(), 0);
        assert.equal(tv.fake.requests.filter(request => request.method === "PUT" || request.method === "DELETE").length, 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("empty hidden-library editor keeps Back and explicit-null controls reachable", async () => {
    const { tv } = await setup();
    try {
        const catalog = new FakeCatalog();
        const household = catalog.households.get("p-owner");
        assert.ok(household);
        household.libraries.splice(0);
        tv.fake.catalog = catalog;
        new FakeSettings(tv.fake);
        await openSettings(tv);
        await tv.page.locator('[data-focus="hidden"]').click();
        await tv.page.getByText("No accessible libraries.", { exact: true }).waitFor();
        assert.equal(await tv.focused(), "back");
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "clear-hidden");
        assert.equal(tv.fake.requests.filter(request => request.method === "PUT").length, 0);
    } finally { await tv.page.context().close(); }
});
