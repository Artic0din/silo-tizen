// Apple TV theme music on the Tizen client: the Settings › General rows, and the Details page that plays
// the title's theme, hands off to the video player and stops when the page goes away.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { THEME_MUSIC_ENABLED_KEY, THEME_MUSIC_LOOP_KEY } from "../../src/contracts/v2/settings.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { FakeThemes } from "../native/support/fakeThemes.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

interface Options { readonly enabled?: boolean; readonly loop?: boolean; readonly available?: boolean }

async function withTv(options: Options, body: (tv: Tv, fakes: { settings: FakeSettings; themes: FakeThemes }) => Promise<void>): Promise<void> {
    const tv = await openTv(browser, { app: "browse" });
    tv.fake.catalog = new FakeDetails();
    const settings = new FakeSettings(tv.fake);
    const themes = new FakeThemes(tv.fake);
    if (options.enabled === true) settings.profile().set(THEME_MUSIC_ENABLED_KEY, true);
    if (options.loop === true) settings.profile().set(THEME_MUSIC_LOOP_KEY, true);
    if (options.available === false) themes.available = false;
    try {
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount(true));
        await tv.page.locator('[data-view="home"]').waitFor();
        await body(tv, { settings, themes });
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

const events = (tv: Tv): Promise<string[]> => tv.page.evaluate(() => [...window.browseHarness.themeEvents]);
const openMovie = (tv: Tv) => tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();

async function openGeneral(tv: Tv, anchor = '[data-focus="title-art"]'): Promise<void> {
    await tv.page.locator('[data-focus="profiles"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await tv.page.locator(anchor).waitFor();
}

test("Settings › General lists Play and Loop Theme Music with Apple's copy, off by default, Loop disabled until Play is on", async () => {
    await withTv({}, async (tv, { settings }) => {
        await openGeneral(tv);
        const play = tv.page.getByRole("switch", { name: "Play Theme Music", exact: true });
        const loop = tv.page.getByRole("switch", { name: "Loop Theme Music", exact: true });
        await play.waitFor();
        assert.equal(await tv.page.locator(".settings-section-header", { hasText: "THEME MUSIC" }).count(), 1);
        assert.equal(await play.getAttribute("aria-checked"), "false");
        assert.match(await play.innerText(), /^Play Theme Music\s*Off$/);
        assert.equal(await loop.getAttribute("aria-disabled"), "true");
        await tv.page.getByText("Play a title's theme song from your library while its page is open. Only affects this TV.", { exact: true }).waitFor();
        const order = await tv.page.locator('.settings-section-header, [data-focus="title-art"], [data-focus="theme-music"], [data-focus="theme-music-loop"]').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus") ?? node.textContent ?? ""));
        assert.deepEqual(order.slice(order.indexOf("TITLE PAGES"), order.indexOf("TITLE PAGES") + 4), ["TITLE PAGES", "title-art", "THEME MUSIC", "theme-music"]);
        await loop.click({ force: true });
        assert.equal(await loop.getAttribute("aria-checked"), "false", "a disabled Loop does nothing");
        assert.equal(tv.fake.paths().some(path => path.startsWith("PUT /settings/values/ui.theme_music_loop")), false);
        await play.click();
        await tv.eventually(async () => await play.getAttribute("aria-checked") === "true", "Play turns on");
        await tv.eventually(async () => tv.fake.paths().includes("PUT /settings/values/ui.theme_music_enabled?scope=profile_device"), "this TV's value is written");
        assert.equal(settings.profile().has(THEME_MUSIC_ENABLED_KEY), false, "the profile value is not written");
        assert.equal(await loop.getAttribute("aria-disabled"), null);
        await loop.click();
        await tv.eventually(async () => await loop.getAttribute("aria-checked") === "true", "Loop turns on");
        await tv.eventually(async () => tv.fake.paths().includes("PUT /settings/values/ui.theme_music_loop?scope=profile_device"), "Loop writes this TV's value");
    });
});

test("opening Details plays the title's first theme; Back fades it out and releases the audio", async () => {
    await withTv({ enabled: true }, async (tv, { themes }) => {
        await openMovie(tv);
        await tv.eventually(async () => (await events(tv)).includes("play"), "theme plays");
        const log = await events(tv);
        assert.match(log[0] ?? "", /^grant https?:\/\/[^/]+\/api\/v2\/catalog\/items\/movie%3Aheat-1995\/themes\/7\/audio\?token=signed$/);
        assert.deepEqual(themes.grants.map(grant => [grant.owner, grant.theme]), [["movie:heat-1995", "7"]]);
        assert.ok(Array.isArray(themes.grants[0]?.body?.accepted_formats) || themes.grants[0]?.body === undefined, "accepted formats come from canPlayType");
        await tv.remote(10009);
        await tv.jump(1000);
        await tv.eventually(async () => (await events(tv)).at(-1) === "teardown", "theme released");
    });
});

test("a profile that has not opted in never asks the server for themes", async () => {
    await withTv({}, async (tv, { themes }) => {
        await openMovie(tv);
        await tv.page.locator('[data-focus="play"]').waitFor();
        await tv.jump(2000);
        assert.deepEqual(await events(tv), []);
        assert.equal(themes.capabilityReads, 0);
        assert.deepEqual(themes.grants, []);
    });
});

test("a server that does not report the capability stays silent", async () => {
    await withTv({ enabled: true, available: false }, async (tv, { themes }) => {
        await openMovie(tv);
        await tv.eventually(async () => themes.capabilityReads > 0, "capability asked");
        await tv.jump(2000);
        assert.deepEqual(await events(tv), []);
        assert.deepEqual(themes.grants, []);
    });
});

test("starting playback releases the theme audio before the player opens", async () => {
    await withTv({ enabled: true }, async tv => {
        await openMovie(tv);
        await tv.eventually(async () => (await events(tv)).includes("play"), "theme plays");
        await tv.page.locator('[data-focus="play"]').click();
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.plays.length === 1), "player request");
        const log = await events(tv);
        assert.deepEqual(log.slice(-2), ["teardown", "player"], "audio is gone in the turn before AVPlay would open");
        assert.equal(log.filter(entry => entry === "teardown").length, 1);
        await tv.jump(2000);
        assert.deepEqual(await events(tv), log, "nothing starts again while the player is open");
    });
});

test("the app going to the background pauses the theme and coming back resumes it without a new grant", async () => {
    await withTv({ enabled: true }, async (tv, { themes }) => {
        await openMovie(tv);
        await tv.eventually(async () => (await events(tv)).includes("play"), "theme plays");
        const hide = (hidden: boolean): Promise<void> => tv.page.evaluate((value: boolean) => {
            Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
            document.dispatchEvent(new Event("visibilitychange"));
        }, hidden);
        await hide(true);
        await tv.jump(1000);
        await tv.eventually(async () => (await events(tv)).at(-1) === "pause", "theme paused");
        await hide(false);
        await tv.eventually(async () => (await events(tv)).at(-1) === "play", "theme resumes");
        assert.equal(themes.grants.length, 1);
    });
});
