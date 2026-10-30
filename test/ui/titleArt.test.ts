import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { problem } from "../native/support/fakeSilo.ts";
import type { SettingsKey } from "../../src/contracts/v2/settings.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

const TITLE = "ui.title_art" as SettingsKey;
let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

async function setup() {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeDetails();
    tv.fake.catalog = catalog;
    const settings = new FakeSettings(tv.fake);
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase) === "signed_in", "sign in");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.page.locator('[data-view="home"]').waitFor();
    return { tv, catalog, settings };
}
async function details(tv: Tv, _catalog: FakeDetails): Promise<void> {
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
}

test("confirmed false and pending title art keep accessible text and start zero logo requests", async () => {
    const { tv, settings, catalog } = await setup();
    let logos = 0;
    tv.page.on("request", r => { if (new URL(r.url()).pathname === "/art/last-signal-logo.svg") logos++; });
    const hold = tv.fake.hold("/settings/values/effective?keys=ui.title_art", true);
    try {
        settings.profile().set(TITLE, false);
        await details(tv, catalog);
        assert.equal(logos, 0, "pending is text-only");
        hold.release();
        await tv.jump(240);
        assert.equal(logos, 0, "confirmed false must never fetch a logo");
        assert.equal(await tv.page.locator(".details-editorial h1").textContent(), "The Last Signal");
        await tv.page.locator('[data-focus="play"]').waitFor();
    } finally { hold.release(); await tv.page.context().close(); }
});

test("returning from General rechecks Details and retains text after this-TV false", async () => {
    const { tv, catalog } = await setup();
    try {
        await details(tv, catalog);
        await tv.page.locator(".details-logo").waitFor();
        await tv.remote(10009);
        await settingsScreen(tv);
        await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).click();
        await tv.page.getByText("Off · This TV", { exact: true }).waitFor();
        await tv.remote(10009); await tv.remote(10009);
        let logos = 0;
        tv.page.on("request", r => { if (new URL(r.url()).pathname.endsWith("last-signal-logo.svg")) logos++; });
        await details(tv, catalog);
        await tv.jump(240);
        assert.equal(await tv.page.locator(".details-editorial h1").textContent(), "The Last Signal");
        assert.equal(logos, 0);
    } finally { await tv.page.context().close(); }
});

test("detailed seasons use the same false policy and leave episode navigation usable", async () => {
    const { tv, settings } = await setup();
    let logos = 0;
    tv.page.on("request", r => { if (new URL(r.url()).pathname.endsWith("season-logo.svg")) logos++; });
    try {
        settings.profile().set(TITLE, false);
        await tv.page.route("**/api/v2/catalog/items/series%3As1-S1?**", async route => {
            const base = tv.fake.catalog?.route("GET", "/catalog/items/series%3As1-S1", "p-owner");
            assert.ok(base);
            await route.fulfill({ status: 200, json: { ...base.body as Record<string, unknown>, logo_url: "/art/season-logo.svg" } });
        });
        await tv.page.locator('[data-focus="series"][role="tab"]').click();
        await tv.page.locator('[data-focus="series:s1"]').first().click();
        await tv.page.locator('[data-focus="season:1"]').click();
        await tv.page.locator('[data-view="season:series:s1:1"]').waitFor();
        await tv.jump(240);
        assert.equal(await tv.page.locator(".details-editorial h1").textContent(), "Harbor Lights · Season 1");
        assert.equal(logos, 0);
        assert.ok(await tv.page.locator('[data-focus^="episode:"]').count() > 0);
    } finally { await tv.page.context().close(); }
});

for (const mode of ["logo", "broken", "default-false"] as const) test(`Details supported title art: ${mode}`, async () => {
    const { tv, settings, catalog } = await setup();
    let logos = 0;
    tv.page.on("request", r => { if (new URL(r.url()).pathname.endsWith("last-signal-logo.svg")) logos++; });
    try {
        settings.titleDefault = mode !== "default-false";
        if (mode === "broken") await tv.page.route("**/art/last-signal-logo.svg", route => route.fulfill({ status: 200, contentType: "image/svg+xml", body: "broken image" }));
        await details(tv, catalog);
        if (mode === "logo") {
            await tv.page.locator(".details-logo").waitFor();
            assert.equal(await tv.page.getByRole("heading", { name: "The Last Signal" }).count(), 1);
        } else {
            if (mode === "broken") await tv.eventually(async () => logos > 0, "failed logo request");
            await tv.jump(240);
            assert.equal(await tv.page.locator(".details-editorial h1").textContent(), "The Last Signal");
            assert.equal(await tv.page.locator(".details-logo").count(), 0);
            if (mode === "default-false") assert.equal(logos, 0);
        }
        await tv.page.locator('[data-focus="play"]').focus();
        await tv.page.keyboard.press("Enter");
        assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 1);
    } finally { await tv.page.context().close(); }
});

test("failed supported title-art read keeps playback and reachable Retry, then recovers", async () => {
    const { tv, catalog } = await setup();
    try {
        tv.fake.script(`/settings/values/effective?keys=${TITLE}`, problem(429, "rate_limited", "Wait"));
        await details(tv, catalog);
        const retry = tv.page.getByRole("button", { name: "Retry title art", exact: true });
        await retry.waitFor();
        assert.equal(await tv.page.locator(".details-editorial h1").textContent(), "The Last Signal");
        assert.equal(await tv.page.locator(".details-logo").count(), 0);
        assert.ok(await tv.page.locator('[data-focus="play"]').isVisible());
        await retry.focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.locator(".details-logo").waitFor();
        assert.equal(await retry.count(), 0);
    } finally { await tv.page.context().close(); }
});

async function settingsScreen(tv: Tv): Promise<void> {
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).waitFor();
}

test("General switches show source/scope, serialize edits and keep focus without fetches on moves", async () => {
    const { tv, settings } = await setup();
    try {
        await settingsScreen(tv);
        await tv.page.getByText("On · Inherited default", { exact: true }).waitFor();
        assert.equal(await tv.page.getByText("Profile defaults", { exact: true }).count(), 0);
        const count = tv.fake.requests.length;
        await tv.page.keyboard.press("ArrowRight");
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "title-art-all");
        assert.equal(tv.fake.requests.length, count);
        await tv.page.keyboard.press("Enter");
        await tv.page.getByText("On · All devices", { exact: true }).waitFor();
        assert.equal(await tv.focused(), "title-art-all");
        await tv.page.keyboard.press("ArrowUp");
        await tv.page.keyboard.press("Enter");
        await tv.page.getByText("Off · All devices", { exact: true }).waitFor();
        assert.equal(settings.profile().get(TITLE), false);
        await tv.page.keyboard.press("ArrowDown");
        await tv.page.keyboard.press("Enter");
        await tv.page.getByText("Off · This TV", { exact: true }).waitFor();
        assert.equal(await tv.focused(), "title-art-all");
        assert.equal(settings.profile().has(TITLE), false);
        assert.deepEqual(tv.fake.requests.filter(r => r.method === "PUT" || r.method === "DELETE").map(r => [r.method, r.path]), [
            ["PUT", `/settings/values/${TITLE}?scope=profile`], ["PUT", `/settings/values/${TITLE}?scope=profile`],
            ["PUT", `/settings/values/${TITLE}?scope=profile_device`], ["DELETE", `/settings/values/${TITLE}?scope=profile`],
        ]);
        await tv.remote(10009); await tv.remote(10009);
        assert.equal(await tv.focused(), "profiles");
    } finally { await tv.page.context().close(); }
});

for (const conflict of ["profile", "device"] as const) test(`Settings recovers an observed ${conflict} conflict through the existing Reload control`, async () => {
    const { tv, settings } = await setup();
    try {
        settings.profile().set(TITLE, true);
        await settingsScreen(tv);
        const catalog = tv.fake.catalog;
        assert.ok(catalog);
        let pinned = false;
        let interleaved = false;
        if (conflict === "profile") tv.fake.catalog = { route: (method, path, profile, body, headers) => {
            const reply = catalog.route(method, path, profile, body, headers);
            if (method === "PUT" && path === `/settings/values/${TITLE}?scope=profile_device`) pinned = true;
            if (pinned && !interleaved && method === "GET" && path === `/settings/values?scope=profile&keys=${TITLE}`) {
                settings.profile().set(TITLE, false);
                settings.rowRevisions.set(JSON.stringify(["p-owner", "profile", undefined, TITLE]), 9);
                interleaved = true;
            }
            return reply;
        } };
        else tv.fake.script(`/settings/values/${TITLE}?scope=profile`, problem(500, "failed", "Failed"));
        await tv.page.getByRole("switch", { name: "Apply to All Devices", exact: true }).focus();
        await tv.page.keyboard.press("Enter");
        if (conflict === "device") {
            const retry = tv.page.getByRole("button", { name: "Check and retry", exact: true });
            await retry.waitFor();
            const device = tv.fake.requests.find(r => r.method === "PUT")?.headers["x-silo-device-id"];
            assert.ok(device);
            settings.device("p-owner", device).set(TITLE, false);
            settings.rowRevisions.set(JSON.stringify(["p-owner", "profile_device", device, TITLE]), 9);
            await retry.focus();
            await tv.page.keyboard.press("Enter");
        }
        await tv.page.getByRole("alert").filter({ hasText: "Title art changed on another device. Reload settings before changing it." }).waitFor();
        const reload = tv.page.getByRole("button", { name: "Reload settings", exact: true });
        await reload.waitFor();
        assert.equal(await tv.focused(), conflict === "profile" ? "title-art-all" : "general");
        assert.equal(await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).getAttribute("aria-checked"), String(conflict === "device"));
        assert.equal(tv.fake.requests.filter(r => r.method === "PUT").length, 1);
        assert.equal(tv.fake.requests.filter(r => r.method === "DELETE").length, conflict === "profile" ? 0 : 1);
        assert.equal(settings.profile().get(TITLE), conflict === "device");
        await reload.focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).waitFor();
        await tv.eventually(async () => await tv.page.getByRole("alert").count() === 0, "conflict reload");
        await tv.page.getByText(`${conflict === "device" ? "On" : "Off"} · All devices`, { exact: true }).waitFor();
        assert.equal(settings.profile().get(TITLE), conflict === "device");
        assert.equal(tv.fake.requests.filter(r => r.method === "PUT").length, 1);
        assert.equal(tv.fake.requests.filter(r => r.method === "DELETE").length, conflict === "profile" ? 0 : 1);
        await tv.remote(10009); await tv.remote(10009);
        assert.equal(await tv.focused(), "profiles");
    } finally { await tv.page.context().close(); }
});

test("delayed title-art policy while playback hides a connected node is discarded and re-read on return", async () => {
    const { tv, settings, catalog } = await setup();
    const hold = tv.fake.hold(`/settings/values/effective?keys=${TITLE}`, true);
    let logos = 0;
    tv.page.on("request", r => { if (new URL(r.url()).pathname.endsWith("last-signal-logo.svg")) logos++; });
    try {
        await details(tv, catalog);
        await tv.eventually(async () => tv.fake.requests.some(r => r.path === `/settings/values/effective?keys=${TITLE}`), "held policy read");
        await tv.page.locator('[data-focus="play"]').click();
        settings.profile().set(TITLE, false);
        hold.release();
        await tv.jump(240);
        assert.equal(await tv.page.locator(".browse[hidden]").count(), 1);
        assert.equal(await tv.page.locator(".details-editorial h1").textContent(), "The Last Signal");
        assert.equal(logos, 0);
        await tv.page.evaluate(() => window.browseHarness.resume());
        await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
        await tv.eventually(async () => tv.fake.requests.filter(r => r.path === `/settings/values/effective?keys=${TITLE}`).length === 2, "fresh policy after playback");
        await tv.jump(240);
        assert.equal(logos, 0);
        assert.equal(await tv.page.locator(".details-editorial h1").textContent(), "The Last Signal");
    } finally { hold.release(); await tv.page.context().close(); }
});

test("delayed image load cannot replace a hidden heading and a new generation restores logos", async () => {
    const { tv, catalog } = await setup();
    let release = (): void => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started = false;
    await tv.page.route("**/art/last-signal-logo.svg", async route => {
        started = true;
        await held;
        await route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="100"><text y="60" fill="white" font-size="40">The Last Signal</text></svg>' }).catch(() => undefined);
    });
    try {
        await details(tv, catalog);
        await tv.eventually(async () => started, "held logo");
        await tv.page.locator('[data-focus="play"]').click();
        release();
        await tv.jump(240);
        assert.equal(await tv.page.locator(".details-editorial h1").textContent(), "The Last Signal");
        assert.equal(await tv.page.locator(".details-logo").count(), 0);
        await tv.page.evaluate(() => window.browseHarness.resume());
        await tv.page.locator(".details-logo").waitFor();
    } finally { release(); await tv.page.context().close(); }
});

test("title-art policy settling preserves the open synopsis and its remote focus", async () => {
    const { tv, catalog } = await setup();
    const hold = tv.fake.hold(`/settings/values/effective?keys=${TITLE}`, true);
    try {
        await details(tv, catalog);
        await tv.page.locator('[data-focus="synopsis"]').click();
        const dialog = tv.page.getByRole("dialog", { name: "Synopsis" });
        await dialog.getByRole("button", { name: "Close synopsis" }).focus();
        hold.release();
        await tv.jump(240);
        assert.equal(await dialog.count(), 1);
        assert.equal(await tv.focused(), "close-synopsis");
        await tv.remote(10009);
        await tv.page.locator(".details-logo").waitFor();
        assert.equal(await tv.focused(), "synopsis");
    } finally { hold.release(); await tv.page.context().close(); }
});
