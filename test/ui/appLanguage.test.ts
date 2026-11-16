// Apple TV's App Language row on the Tizen client: Settings > General, its picker and the storage it writes
// (silo-apple tvOS/Screens/Settings/TVGeneralSettingsView.swift).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { APP_LANGUAGE_KEY } from "../../src/contracts/v2/settings.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const PROFILE_WRITE = `PUT /settings/values/${APP_LANGUAGE_KEY}?scope=profile`;
const BACK = 10009;

async function withTv(revision: number, body: (tv: Tv, settings: FakeSettings) => Promise<void>, prepare?: (settings: FakeSettings) => void): Promise<void> {
    const tv = await openTv(browser, { app: "browse" });
    tv.fake.catalog = new FakeDetails();
    const settings = new FakeSettings(tv.fake);
    settings.revision = revision;
    prepare?.(settings);
    try {
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount(true));
        await tv.page.locator('[data-view="home"]').waitFor();
        await body(tv, settings);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

async function openGeneral(tv: Tv, anchor = '[data-focus="app-language"]'): Promise<void> {
    await tv.page.locator('[data-focus="profiles"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await tv.page.locator(anchor).waitFor();
}

test("Settings > General lists App Language after Profile Selection and before Title Pages, set to Match Device", async () => {
    await withTv(28, async tv => {
        await openGeneral(tv);
        await tv.page.locator('[data-focus="title-art"]').waitFor();
        const row = tv.page.locator('[data-focus="app-language"]');
        assert.match(await row.innerText(), /^App Language\s*Match Device$/);
        await tv.page.getByText("The language of Silo’s menus and buttons on this profile. Audio and subtitle languages are set in Playback.", { exact: true }).waitFor();
        const order = await tv.page.locator('.settings-section-header, [data-focus="app-language"], [data-focus="remember-profile"]').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus") ?? node.textContent ?? ""));
        assert.deepEqual(order.slice(order.indexOf("PROFILE AT LAUNCH"), order.indexOf("TITLE PAGES") + 1), ["PROFILE AT LAUNCH", "remember-profile", "LANGUAGE", "app-language", "TITLE PAGES"]);
    });
});

test("a server older than revision 28 does not offer the row", async () => {
    await withTv(27, async tv => {
        await openGeneral(tv, '[data-focus="title-art"]');
        assert.equal(await tv.page.locator('[data-focus="app-language"]').count(), 0);
        assert.equal(await tv.page.locator(".settings-section-header", { hasText: "LANGUAGE" }).count(), 0);
    });
});

test("the picker lists Match Device and English, marks the stored one, and Back closes it without a write", async () => {
    await withTv(28, async tv => {
        await openGeneral(tv);
        await tv.page.locator('[data-focus="app-language"]').click();
        const dialog = tv.page.getByRole("dialog", { name: "App Language" });
        await dialog.waitFor();
        const radios = dialog.getByRole("radio");
        assert.deepEqual(await radios.allInnerTexts(), ["Match Device", "English"]);
        assert.deepEqual(await radios.evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-checked"))), ["true", "false"]);
        await tv.remote(BACK);
        await dialog.waitFor({ state: "detached" });
        assert.equal(await tv.focused(), "app-language", "Back returns to the row");
        assert.equal(tv.fake.paths().some(path => path.startsWith("PUT ")), false);
    });
});

test("picking English closes the picker at once, keeps focus on the row and stores the profile's language", async () => {
    await withTv(28, async (tv, settings) => {
        await openGeneral(tv);
        await tv.page.locator('[data-focus="app-language"]').click();
        await tv.page.getByRole("radio", { name: "English", exact: true }).click();
        await tv.page.getByRole("dialog", { name: "App Language" }).waitFor({ state: "detached" });
        assert.equal(await tv.focused(), "app-language");
        await tv.eventually(async () => /English$/.test(await tv.page.locator('[data-focus="app-language"]').innerText()), "the row shows English");
        assert.equal(tv.fake.paths().includes(PROFILE_WRITE), true);
        assert.equal(settings.profile().get(APP_LANGUAGE_KEY), "en");
    });
});

test("a language another client stored that this build lacks shows as itself, with the unavailable footer", async () => {
    await withTv(28, async tv => {
        await openGeneral(tv);
        assert.match(await tv.page.locator('[data-focus="app-language"]').innerText(), /^App Language\s*Español$/);
        await tv.page.getByText("Silo isn’t available in Español yet, so it uses the device language.", { exact: true }).waitFor();
    }, settings => settings.profile().set(APP_LANGUAGE_KEY, "es"));
});

test("a failed save keeps the stored language and shows the reason under the row", async () => {
    await withTv(28, async tv => {
        await openGeneral(tv);
        tv.fake.script(`/settings/values/${APP_LANGUAGE_KEY}?scope=profile`, problem(500, "internal", "Unavailable"));
        await tv.page.locator('[data-focus="app-language"]').click();
        await tv.page.getByRole("radio", { name: "English", exact: true }).click();
        await tv.page.getByText("The server didn't save the app language. Try again.", { exact: true }).waitFor();
        assert.match(await tv.page.locator('[data-focus="app-language"]').innerText(), /^App Language\s*Match Device$/);
    });
});

test("reopening the picker while a save runs shows the saving note and takes no choice", async () => {
    await withTv(28, async tv => {
        await openGeneral(tv);
        const hold = tv.fake.hold(`/settings/values/${APP_LANGUAGE_KEY}?scope=profile`);
        await tv.page.locator('[data-focus="app-language"]').click();
        await tv.page.getByRole("radio", { name: "English", exact: true }).click();
        await tv.eventually(async () => tv.fake.paths().includes(PROFILE_WRITE), "the save started");
        await tv.page.locator('[data-focus="app-language"]').click();
        await tv.page.getByText("Saving the app language…", { exact: true }).waitFor();
        const radios = tv.page.getByRole("dialog", { name: "App Language" }).getByRole("radio");
        assert.deepEqual(await radios.evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-disabled"))), ["true", "true"]);
        await radios.first().click({ force: true });
        assert.deepEqual(tv.fake.paths().filter(path => path.startsWith("PUT ")), [PROFILE_WRITE]);
        hold.release();
        await tv.eventually(async () => await tv.page.getByText("Saving the app language…").count() === 0, "the note clears when the save lands");
    });
});

test("the remote opens the picker on the stored option, moves to English and picks it", async () => {
    await withTv(28, async (tv, settings) => {
        await openGeneral(tv);
        await tv.page.locator('[data-focus="app-language"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("dialog", { name: "App Language" }).waitFor();
        assert.equal(await tv.focused(), "language:device");
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "language:en");
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("dialog", { name: "App Language" }).waitFor({ state: "detached" });
        assert.equal(await tv.focused(), "app-language");
        await tv.eventually(async () => settings.profile().get(APP_LANGUAGE_KEY) === "en", "English stored");
    });
});

test("opening Settings reads again, so a launch read that missed does not hide the row", async () => {
    await withTv(28, async (tv, settings) => {
        settings.allowed = true;
        await openGeneral(tv);
        assert.match(await tv.page.locator('[data-focus="app-language"]').innerText(), /^App Language\s*Match Device$/);
    }, settings => { settings.allowed = false; });
});

// Apple's General pane refreshes the language in its own task (TVGeneralSettingsView.swift:136-142), whatever else loads.
test("opening Settings reads the language again even when another settings read fails", async () => {
    await withTv(28, async (tv, settings) => {
        settings.allowed = true;
        tv.fake.script("/user/libraries?include_hidden=true", problem(403, "forbidden", "Forbidden"));
        await tv.page.locator('[data-focus="profiles"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await tv.eventually(async () => tv.fake.requests.some(request => request.path === "/user/libraries?include_hidden=true"), "Settings reads the libraries");
        await tv.page.locator('[data-focus="app-language"]').waitFor();
        assert.match(await tv.page.locator('[data-focus="app-language"]').innerText(), /^App Language\s*Match Device$/);
    }, settings => { settings.allowed = false; });
});
