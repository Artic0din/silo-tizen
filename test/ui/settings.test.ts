import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { AUDIO_KEY, HIDDEN_KEY, QUALITY_KEY, BITRATE_KEY, SEEK_BACK_KEY, SEEK_FORWARD_KEY } from "../../src/contracts/v2/settings.ts";
import { fixture, problem } from "../native/support/fakeSilo.ts";
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

test("video intervals show numeric server labels, profile values and independent inherited resets", async () => {
    const { tv, settings } = await setup();
    try {
        settings.supportsBatchedEffective = false;
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.getByText("On this TV: 10 seconds · Inherited default", { exact: true }).waitFor();
        await tv.page.getByText("On this TV: 30 seconds · Inherited default", { exact: true }).waitFor();
        for (const [picker, seconds] of [["seek-back", 15], ["seek-forward", 45]] as const) {
            await tv.page.locator(`[data-focus="${picker}"]`).click();
            assert.deepEqual(await tv.page.getByRole("radio").allTextContents(), ["5 seconds", "10 seconds", "15 seconds", "30 seconds", "45 seconds", "60 seconds", "90 seconds"]);
            assert.equal(await tv.page.getByRole("radio", { name: "No preference", exact: true }).count(), 0);
            assert.equal(await tv.page.locator('[data-focus="reset"]').count(), 0);
            const count = tv.fake.requests.length;
            await tv.page.keyboard.press("ArrowDown");
            await tv.page.keyboard.press("ArrowDown");
            assert.equal(tv.fake.requests.length, count);
            for (let step = 0; step < 5; step++) await tv.page.keyboard.press("ArrowDown");
            await tv.jump(250);
            assert.equal(await tv.focused(), `${picker}:90`);
            const bounds = await tv.page.getByRole("radio", { name: "90 seconds", exact: true }).boundingBox();
            assert.ok(bounds !== null && bounds.y >= 0 && bounds.y + bounds.height <= 1080, "last numeric choice scrolls fully into view");
            assert.equal(tv.fake.requests.length, count);
            await tv.page.getByRole("radio", { name: `${seconds} seconds`, exact: true }).click();
            await tv.page.locator(`[data-focus="${picker}"]`).waitFor();
            assert.equal(await tv.focused(), picker);
        }
        for (const [picker, key, defaultSeconds] of [["seek-back", SEEK_BACK_KEY, 10], ["seek-forward", SEEK_FORWARD_KEY, 30]] as const) {
            await tv.page.locator(`[data-focus="${picker}"]`).click();
            await tv.page.locator('[data-focus="reset"]').click();
            await tv.page.locator(`[data-focus="${picker}"]`).waitFor();
            assert.equal(settings.profile().has(key), false);
            await tv.page.getByText(`On this TV: ${defaultSeconds} seconds · Inherited default`, { exact: true }).waitFor();
            if (key === SEEK_BACK_KEY) assert.equal(settings.profile().get(SEEK_FORWARD_KEY), 45);
        }
        assert.deepEqual(tv.fake.requests.filter(r => r.method === "DELETE").map(r => r.path), [`/settings/values/${SEEK_BACK_KEY}?scope=profile`, `/settings/values/${SEEK_FORWARD_KEY}?scope=profile`]);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

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
        const refreshedLibraries = tv.fake.hold("/user/libraries");
        await tv.remote(10009);
        await tv.remote(10009);
        await tv.remote(10009);
        await tv.eventually(async () => tv.fake.requests.filter(request => request.path === "/user/libraries").length === 2, "refreshed Home libraries");
        assert.ok(tv.fake.requests.some(request => request.path === "/user/libraries?include_hidden=true"));
        refreshedLibraries.release();
        await tv.page.locator('[role="tab"][data-focus="movies"]').waitFor({ state: "detached" });
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

test("quality picker uses server labels, keeps legacy current values honest and preserves overrides", async () => {
    const { tv, settings } = await setup();
    try {
        settings.profile().set(QUALITY_KEY, "original");
        settings.overrides.set(QUALITY_KEY, "480p");
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="quality"]').click();
        await tv.page.getByText("Current profile value: Original quality · Not offered", { exact: true }).waitFor();
        assert.equal(await tv.page.locator('[data-focus="quality:original"]').count(), 0);
        assert.deepEqual(await tv.page.getByRole("radio").allTextContents(), ["Auto", "480p", "720p", "1080p", "2160p / 4K"]);
        assert.equal(tv.fake.requests.filter(r => r.method === "PUT").length, 0);
        await tv.page.getByRole("radio", { name: "2160p / 4K", exact: true }).click();
        await tv.page.locator('[data-focus="quality"]').waitFor();
        assert.equal(await tv.focused(), "quality");
        assert.equal(settings.profile().get(QUALITY_KEY), "2160p");
        assert.equal(settings.overrides.get(QUALITY_KEY), "480p");
        await tv.page.getByText("On this TV: 480p · Device override", { exact: true }).waitFor();
        assert.equal(await tv.page.getByText("Saved", { exact: true }).count(), 0);
        await tv.page.locator('[data-focus="quality"]').click();
        await tv.page.locator('[data-focus="reset"]').click();
        await tv.page.locator('[data-focus="quality"]').waitFor();
        assert.equal(settings.profile().has(QUALITY_KEY), false);
        assert.equal(settings.overrides.get(QUALITY_KEY), "480p");
        settings.profile().set(QUALITY_KEY, "future-quality");
        await tv.remote(10009);
        await tv.remote(10009);
        await tv.remote(10009);
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="quality"]').click();
        await tv.page.getByText("Current profile value: future-quality · Not offered", { exact: true }).waitFor();
        assert.equal(await tv.page.locator('[data-focus="quality:future-quality"]').count(), 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("bitrate editor validates whole kbps, saves only explicitly, cancels and keeps null distinct from reset", async () => {
    const { tv, settings } = await setup();
    try {
        settings.profile().set(BITRATE_KEY, 6000);
        settings.overrides.set(BITRATE_KEY, 1500);
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="bitrate"]').click();
        const input = tv.page.getByRole("textbox", { name: "Maximum bitrate (kbps)" });
        assert.equal(await input.inputValue(), "6000", "edit the explicit profile row, not the device override");
        const count = tv.fake.requests.length;
        for (const value of ["", "0", "99", "200001", "100.5", "NaN", "1e3", "-100", " 100 "]) {
            await input.fill(value);
            await tv.page.getByRole("button", { name: "Save", exact: true }).click();
            await tv.page.getByRole("alert").waitFor();
            assert.equal(await input.getAttribute("aria-invalid"), "true");
        }
        assert.equal(tv.fake.requests.length, count, "invalid inputs never send reads or writes");
        await input.fill("100");
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "save");
        await tv.page.keyboard.press("Enter");
        await tv.page.locator('[data-focus="bitrate"]').waitFor();
        assert.equal(await tv.focused(), "bitrate");
        assert.equal(settings.profile().get(BITRATE_KEY), 100);
        await tv.page.keyboard.press("Enter");
        await input.fill("200000");
        await tv.page.getByRole("button", { name: "Save", exact: true }).click();
        await tv.page.locator('[data-focus="bitrate"]').waitFor();
        assert.equal(settings.profile().get(BITRATE_KEY), 200000);
        await tv.page.keyboard.press("Enter");
        await input.fill("1234");
        await tv.page.getByRole("button", { name: "Cancel", exact: true }).click();
        assert.equal(await tv.focused(), "bitrate");
        assert.equal(settings.profile().get(BITRATE_KEY), 200000);
        await tv.page.keyboard.press("Enter");
        await input.fill("4321");
        await tv.remote(10009);
        assert.equal(await tv.focused(), "bitrate");
        assert.equal(settings.profile().get(BITRATE_KEY), 200000);
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("button", { name: "No limit", exact: true }).click();
        await tv.page.locator('[data-focus="bitrate"]').waitFor();
        assert.equal(settings.profile().get(BITRATE_KEY), null);
        await tv.page.keyboard.press("Enter");
        assert.equal(await input.inputValue(), "");
        await tv.page.getByRole("button", { name: "Use inherited default", exact: true }).click();
        await tv.page.locator('[data-focus="bitrate"]').waitFor();
        assert.equal(settings.profile().has(BITRATE_KEY), false);
        assert.equal(settings.overrides.get(BITRATE_KEY), 1500);
        await tv.page.getByText("On this TV: 1500 kbps · Device override", { exact: true }).waitFor();
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("quality controls remain absent for unsupported manifests and empty Playback keeps Back reachable", async () => {
    const { tv } = await setup();
    try {
        const contract = fixture("settings_contract_ok");
        contract.definitions = [];
        const requests = tv.fake.requests.length;
        tv.fake.script("/settings/contract", { status: 200, body: contract });
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await tv.page.getByText("No supported settings in this category.", { exact: true }).waitFor();
        await tv.page.locator('[data-focus="playback"]').click();
        assert.equal(await tv.page.locator('[data-focus="quality"], [data-focus="bitrate"]').count(), 0);
        assert.equal(tv.fake.requests.slice(requests).filter(r => r.path.startsWith("/settings/values")).length, 0);
        await tv.page.keyboard.press("Enter");
        assert.equal(await tv.focused(), "playback");
    } finally { await tv.page.context().close(); }
});

test("bitrate uncertain readback keeps the draft and Retry checks the committed value without resending", async () => {
    const { tv, settings } = await setup();
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="bitrate"]').click();
        await tv.page.getByRole("textbox").fill("4321");
        const path = `/settings/values?scope=profile&keys=${BITRATE_KEY}`;
        const preflight = tv.fake.hold(path);
        tv.fake.dropNextAnswer(`/settings/values/${BITRATE_KEY}?scope=profile`);
        await tv.page.getByRole("button", { name: "Save", exact: true }).click();
        await tv.eventually(async () => tv.fake.requests.some(r => r.path === path), "preflight read");
        tv.fake.script(path, problem(429, "rate_limited", "Wait", { "Retry-After": "1" }));
        preflight.release();
        await tv.page.getByRole("alert").waitFor();
        assert.equal(settings.profile().get(BITRATE_KEY), 4321);
        assert.equal(await tv.page.getByRole("textbox").inputValue(), "4321");
        assert.equal(await tv.page.getByRole("textbox").getAttribute("readonly"), "");
        assert.equal(tv.fake.requests.filter(r => r.method === "PUT").length, 1);
        await tv.jump(1000);
        await tv.page.getByRole("button", { name: "Check and retry", exact: true }).click();
        await tv.page.getByRole("alert").waitFor({ state: "hidden" });
        await tv.page.getByText("Profile default: 4321 kbps", { exact: true }).waitFor();
        assert.equal(tv.fake.requests.filter(r => r.method === "PUT").length, 1);
        await tv.remote(10009);
        assert.equal(await tv.focused(), "bitrate");
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("textbox").fill("9999");
        const held = tv.fake.hold(`/settings/values/${BITRATE_KEY}`, true);
        await tv.page.getByRole("button", { name: "Save", exact: true }).click();
        await tv.eventually(async () => tv.fake.requests.filter(r => r.method === "PUT").length === 2, "pending write");
        await tv.page.evaluate(() => window.browseHarness.clearProfile());
        held.release();
        await tv.page.locator("#successor").waitFor();
        assert.equal(await tv.page.locator(".settings").count(), 0);
        assert.equal(tv.fake.requests.filter(r => r.method === "PUT").length, 2);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});
