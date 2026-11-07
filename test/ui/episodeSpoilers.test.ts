import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { SPOILER_IMAGE_KEY, SPOILER_OVERVIEW_KEY } from "../../src/contracts/v2/settings.ts";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { launchBrowser, openTv, readLive, type Tv } from "./support/tv.ts";
import { selectLibraryMode } from "./support/library.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

async function mount(options: { stills: boolean; images?: boolean; overviews?: boolean; revision?: number; gridEpisode?: boolean }): Promise<{ tv: Tv; settings: FakeSettings }> {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeCatalog();
    catalog.episodeStills = options.stills;
    tv.fake.catalog = options.gridEpisode ? { route: (method, path, profile, body) => {
        if (path.split("?")[0] === "/catalog/query") return { status: 200, body: {
            items: [{ content_id: "episode:s1e12", type: "episode", title: "Harbor Lights chapter 1.2", series_id: "series:s1", season_number: 1, episode_number: 2,
                poster_url: "/art/episode-still.svg", backdrop_url: "/art/episode-still.svg", poster_is_episode_still: true, backdrop_is_episode_still: true, user_state: { played: false } }],
            window_cursor: "window", total: 1, total_exact: true, page: { has_more: false },
        } };
        return catalog.route(method, path, profile, body);
    } } : catalog;
    const settings = new FakeSettings(tv.fake);
    if (options.revision !== undefined) settings.revision = options.revision;
    if (options.images === true) settings.profile().set(SPOILER_IMAGE_KEY, true);
    if (options.overviews === true) settings.profile().set(SPOILER_OVERVIEW_KEY, true);
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

test("unwatched episode stills blur and descriptions drop while series text stays", async () => {
    const { tv } = await mount({ stills: true, images: true, overviews: true });
    try {
        const still = tv.page.locator('[data-section="continue_watching"] [data-focus="episode:s1e12"] .episode-spoiler-blur .browse-art-image');
        await still.waitFor();
        assert.equal(await still.evaluate(node => getComputedStyle(node).filter), "blur(24px)");
        assert.equal(await tv.page.locator('[data-section="continue_watching"] [data-focus="movie:m0001"] .episode-spoiler-blur').count(), 0);
        await tv.page.locator('[data-section="continue_watching"] [data-focus="episode:s1e12"]').focus();
        await tv.eventually(async () => {
            const layer = tv.page.locator(".skyline-marquee-layer:not(.skyline-outgoing)");
            const title = await layer.locator(".skyline-title").innerText().catch(() => "");
            const meta = await layer.locator(".skyline-meta-line").innerText().catch(() => "");
            return title.includes("Harbor Lights") && meta.includes("chapter 1.2");
        }, "episode marquee");
        assert.equal(await tv.page.locator(".skyline-marquee-layer:not(.skyline-outgoing) .skyline-synopsis").count(), 0);
        assert.equal(await tv.page.locator(".skyline-marquee-layer:not(.skyline-outgoing) .skyline-backdrop").count(), 0);
        assert.equal(await tv.page.getByText("Secret chapter", { exact: true }).count(), 0);
        await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').click();
        await tv.page.locator(".details-episodes [data-focus='episode:s1e12']").waitFor();
        assert.match(await tv.page.locator(".details-editorial .browse-overview").innerText(), /A synthetic series/);
        assert.equal(await tv.page.locator(".details-episodes [data-focus='episode:s1e12'] .episode-spoiler-blur").count(), 1);
        assert.equal(await tv.page.locator(".details-episodes [data-focus='episode:s1e11'] .episode-spoiler-blur").count(), 0);
        await tv.page.locator(".details-episodes [data-focus='episode:s1e12']").click({ button: "right" });
        await tv.page.locator('[data-focus="episode-information"]').click();
        await tv.page.locator('[data-view="item:episode:s1e12"]').waitFor();
        await tv.page.getByRole("heading", { name: "Harbor Lights chapter 1.2" }).waitFor();
        assert.equal(await tv.page.locator(".browse-overview").count(), 0);
        assert.equal(await tv.page.locator('[data-focus="synopsis"]').count(), 0);
        assert.equal(await tv.page.getByText("A synthetic episode for the browse tests.", { exact: true }).count(), 0);
        const blur = await readLive(tv, () => {
            const node = document.querySelector(".details-hero .episode-spoiler-blur .skyline-backdrop");
            const frame = node?.parentElement;
            if (!(node instanceof HTMLElement) || !(frame instanceof HTMLElement) || !node.isConnected) return null;
            return { filter: getComputedStyle(node).filter, width: node.getBoundingClientRect().width, frame: frame.getBoundingClientRect().width, margin: getComputedStyle(node).marginLeft };
        }, undefined, value => value.filter === "blur(24px)" && value.width === value.frame + 48 && value.margin === "-24px", "spoiler hero blur");
        assert.equal(blur.filter, "blur(24px)");
        assert.equal(blur.width, blur.frame + 48);
        assert.equal(blur.margin, "-24px");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("returning from Settings repaints the same episode marquee after spoiler changes", async () => {
    const { tv } = await mount({ stills: true });
    try {
        const card = '[data-section="continue_watching"] [data-focus="episode:s1e12"]';
        await tv.page.locator(card).focus();
        await tv.jump(500);
        await readLive(tv, () => document.querySelector(".skyline-marquee-layer:not(.skyline-outgoing) .skyline-synopsis")?.textContent ?? null, undefined, text => text === "Secret chapter", "initial episode synopsis");
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="spoiler-images"][aria-disabled="false"]').click();
        await tv.page.locator('[data-focus="spoiler-overviews"]').click();
        await tv.remote(10009);
        await tv.remote(10009);
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.page.locator(card).focus();
        await readLive(tv, () => {
            const layer = document.querySelector(".skyline-marquee-layer:not(.skyline-outgoing)");
            return layer === null ? null : { text: layer.querySelector(".skyline-synopsis")?.textContent ?? "", backdrop: layer.querySelector(".skyline-backdrop") !== null };
        }, undefined, value => value.text === "" && !value.backdrop, "protected same-card marquee");
    } finally { await tv.page.context().close(); }
});

for (const destination of ["Explore All", "Browse"] as const) test(`${destination} retained episode cards update after a spoiler refresh`, async () => {
    const { tv, settings } = await mount({ stills: true, gridEpisode: true });
    try {
        if (destination === "Explore All") await tv.page.locator('[data-focus="expand:continue_watching"]').click();
        else {
            await tv.page.locator('[data-focus="series"]').click();
            await selectLibraryMode(tv, "Browse");
        }
        const selector = `${destination === "Explore All" ? ".section-catalog-grid" : ".catalog-grid"} [data-focus="episode:s1e12"] .browse-art-image`;
        await tv.page.locator(selector).waitFor();
        await readLive(tv, selector => {
            const node = document.querySelector(selector);
            return node?.isConnected ? getComputedStyle(node).filter : null;
        }, selector, filter => filter === "none", "initial sharp grid still");
        for (const enabled of [true, false]) {
            settings.profile().set(SPOILER_IMAGE_KEY, enabled);
            await tv.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
            await readLive(tv, selector => {
                const node = document.querySelector(selector);
                return node?.isConnected ? getComputedStyle(node).filter : null;
            }, selector, filter => filter === (enabled ? "blur(24px)" : "none"), "refreshed grid still");
        }
    } finally { await tv.page.context().close(); }
});

test("spoiler switches off leave the still and the description visible", async () => {
    const { tv } = await mount({ stills: true });
    try {
        const image = tv.page.locator('[data-section="continue_watching"] [data-focus="episode:s1e12"] .browse-art-image');
        await image.waitFor();
        await tv.eventually(async () => tv.fake.requests.some(request => request.path.includes("hide_unwatched")), "spoiler read");
        assert.equal(await tv.page.locator('[data-section="continue_watching"] [data-focus="episode:s1e12"] .episode-spoiler-blur').count(), 0);
        await tv.page.locator('[data-section="continue_watching"] [data-focus="episode:s1e12"]').focus();
        await tv.eventually(async () => (await tv.page.locator(".skyline-marquee-layer:not(.skyline-outgoing) .skyline-synopsis").allInnerTexts()).includes("Secret chapter"), "episode description");
        assert.match(await tv.page.locator(".skyline-marquee-layer:not(.skyline-outgoing) .skyline-backdrop").getAttribute("src") ?? "", /-still\.svg$/);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("an older server hides the switches and does not blur", async () => {
    const { tv } = await mount({ stills: true, images: true, overviews: true, revision: 16 });
    try {
        await tv.page.locator('[data-section="continue_watching"] [data-focus="episode:s1e12"] .browse-art-image').waitFor();
        await tv.eventually(async () => tv.fake.requests.some(request => request.path === "/settings/contract/capabilities"), "capabilities");
        await tv.jump(300);
        assert.equal(await tv.page.locator(".episode-spoiler-blur").count(), 0);
        assert.equal(tv.fake.requests.some(request => request.path.includes("hide_unwatched")), false);
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="playback"][aria-current="page"]').waitFor();
        assert.equal(await tv.page.locator('[data-focus="spoiler-images"], [data-focus="spoiler-overviews"]').count(), 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Playback saves the image switch for the profile", async () => {
    const { tv, settings } = await mount({ stills: false });
    try {
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await tv.page.locator('[data-focus="playback"]').click();
        const swatch = tv.page.locator('[data-focus="spoiler-images"][aria-disabled="false"]');
        await swatch.waitFor();
        assert.deepEqual(await tv.page.locator(".settings-pane .settings-section-header").allTextContents(), ["QUALITY", "STREAMING", "EPISODES", "SPOILERS", "VIDEO", "RESET"]);
        assert.equal(await tv.page.locator('[data-focus="spoiler-images"] .settings-row-value').innerText(), "Off");
        assert.equal(await tv.page.locator('[data-focus="spoiler-overviews"] .settings-row-value').innerText(), "Off");
        assert.match(await tv.page.getByText("Blur an episode's thumbnail until you start watching it, so the image does not give away the story.", { exact: false }).innerText(), /Blur an episode's thumbnail until you start watching it/);
        await swatch.click();
        await tv.eventually(async () => settings.profile().get(SPOILER_IMAGE_KEY) === true, "image setting saved");
        assert.equal(await tv.page.locator('[data-focus="spoiler-images"] .settings-row-value').innerText(), "On");
        assert.equal(await tv.page.locator('[data-focus="spoiler-overviews"] .settings-row-value').innerText(), "Off");
        assert.equal(await tv.page.locator('[data-focus="spoiler-images"]').getAttribute("aria-checked"), "true");
        const saved = tv.fake.requests.find(request => request.method === "PUT" && request.path === `/settings/values/${SPOILER_IMAGE_KEY}?scope=profile`);
        assert.deepEqual(saved?.body, { value: true });
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});
