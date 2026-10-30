// The native browse screens, driven by remote keys in Chromium against the fake Silo household.
// Desktop Chromium is not the TV's Chromium 76: this proves behavior, not 2021 rendering.

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { fixture, problem } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

const BACK = 10009;
const IME_DONE = 65376;
const PAGE_SIZE = 24;

let browser: Browser;
before(async () => {
    browser = await launchBrowser();
});
after(async () => {
    await browser.close();
});

interface Start {
    readonly catalog?: FakeCatalog;
    readonly profile?: string;
    readonly pin?: string;
}

function browseTest(name: string, body: (tv: Tv, catalog: FakeCatalog) => Promise<void>, start: Start = {}): void {
    test(name, async () => {
        const tv = await openTv(browser, { app: "browse", ...(process.env.DISCOVERY_VIDEO !== undefined && name.startsWith("discovery flow") ? { video: process.env.DISCOVERY_VIDEO } : {}) });
        try {
            const catalog = start.catalog ?? new FakeCatalog();
            await signedInBrowse(tv, catalog, start.profile ?? "p-owner", start.pin);
            await body(tv, catalog);
            assert.deepEqual(tv.console, [], "the page logs nothing");
        } finally {
            await tv.page.context().close();
        }
    });
}

async function signedInBrowse(tv: Tv, catalog: FakeCatalog, profile: string, pin?: string): Promise<void> {
    tv.fake.catalog = catalog;
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "a device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(async () => (await tv.page.evaluate(() => window.browseHarness.loginPhase)) === "signed_in", "sign-in");
    assert.equal(await tv.page.evaluate(([id, code]) => window.browseHarness.selectProfile(id ?? "", code), [profile, pin]), pin === undefined ? "selected" : "verified");
    await tv.page.evaluate(() => window.browseHarness.mount());
    await showing(tv, "home");
}

function view(tv: Tv): Promise<string | null> {
    return tv.page.evaluate(() => document.querySelector(".browse")?.getAttribute("data-view") ?? null);
}

async function showing(tv: Tv, name: string): Promise<void> {
    await tv.eventually(async () => (await view(tv)) === name, `the ${name} view`);
}

async function shows(tv: Tv, text: string): Promise<void> {
    await tv.page.getByText(text).first().waitFor();
}

async function press(tv: Tv, ...keys: string[]): Promise<void> {
    for (const key of keys) {
        await tv.page.keyboard.press(key);
    }
}

/** Details regressions enter from an ordinary row; Continue Watching now resumes directly. */
async function activateDetails(tv: Tv, id = "movie:m0001"): Promise<void> {
    if (await view(tv) === "home") {
        await tv.page.locator(`[data-section="recently_added"] [data-focus="${id}"]`).focus();
    }
    await press(tv, "Enter");
}

function browseReads(tv: Tv, pathname?: string): { path: string; headers: Readonly<Record<string, string>> }[] {
    const browse = /^\/(user\/libraries|settings\/values|home\/|catalog)/;
    return tv.fake.requests.filter((request) => browse.test(request.path) && (pathname === undefined || request.path.split("?")[0] === pathname));
}

function cardIds(tv: Tv, selector = ".browse-card:not(.discovery-collection)"): Promise<string[]> {
    return tv.page.evaluate((query) => Array.from(document.querySelector(".browse")?.querySelectorAll(query) ?? []).map((node) => node.getAttribute("data-focus") ?? ""), selector);
}

browseTest("richer Details: facts, versions, people, bounded filmography, related titles and Back focus", async (tv) => {
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    if (process.env.DETAILS_CAPTURE_DIR !== undefined) {
        await tv.jump(240);
        await mkdir(process.env.DETAILS_CAPTURE_DIR, { recursive: true });
        await tv.page.screenshot({ path: `${process.env.DETAILS_CAPTURE_DIR}/details.png` });
    }
    await shows(tv, "IMDb 8.1");
    await tv.page.locator('[data-focus="version:short"]').focus();
    await press(tv, "Enter");
    await tv.page.locator('[data-focus="play"]').focus();
    await press(tv, "Enter");
    assert.equal((await tv.page.evaluate(() => window.browseHarness.plays))[0]?.fileId, "short");
    assert.equal((await tv.page.evaluate(() => window.browseHarness.plays))[0]?.startSeconds, undefined);
    const personal = tv.fake.hold("/capabilities/personal-lists");
    await tv.page.evaluate(() => window.browseHarness.resume());
    await shows(tv, "Loading personal actions.");
    personal.release();
    await tv.page.getByRole("button", { name: "Add favorite", exact: true }).waitFor();
    await tv.eventually(async () => await tv.page.locator('[data-detail-section="related"] .browse-card').count() === 24, "refreshed related titles");
    await tv.page.locator('[data-focus="person:river"]').first().focus();
    const reads = tv.fake.requests.length;
    await press(tv, "ArrowRight", "ArrowLeft");
    assert.equal(tv.fake.requests.length, reads, "focus performs no reads");
    await press(tv, "Enter");
    await showing(tv, "person:river");
    assert.equal(await tv.page.locator(".browse-card").count(), 24);
    await tv.remote(BACK);
    await showing(tv, "item:movie:m0001");
    assert.equal(await tv.focused(), "person:river");
    await tv.eventually(async () => await tv.page.locator('[data-detail-section="related"] .browse-card').count() === 24, "the bounded related rail");
    assert.equal(await tv.page.getByRole("button", { name: /trailer/i }).count(), 0);
}, { catalog: new FakeDetails() });

browseTest("S-D1 synopsis keeps its dialog and focus while optional Details settle", async (tv) => {
    const related = tv.fake.hold("/recommendations/similar/movie%3Am0001", true);
    const capability = tv.fake.hold("/capabilities/personal-lists", true);
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await tv.page.locator('[data-focus="synopsis"]').focus();
    await press(tv, "Enter");
    const dialog = tv.page.getByRole("dialog", { name: "Synopsis" });
    await dialog.getByRole("button", { name: "Close synopsis" }).focus();
    related.release(); capability.release();
    await tv.eventually(async () => tv.fake.requests.some((request) => request.path === "/favorites/movie%3Am0001/membership"), "optional membership reads");
    await tv.jump(240);
    assert.equal(await dialog.count(), 1, "optional responses must preserve the active synopsis");
    assert.equal(await tv.focused(), "close-synopsis");
    await tv.remote(BACK);
    assert.equal(await dialog.count(), 0);
    assert.equal(await tv.focused(), "synopsis");
    await tv.eventually(async () => await tv.page.locator('[data-detail-section="related"] .browse-card').count() === 24, "updated data after closing");
    await press(tv, "Enter");
    await dialog.getByRole("button", { name: "Close synopsis" }).click();
    assert.equal(await tv.focused(), "synopsis");
    await press(tv, "Enter");
    await tv.page.evaluate(() => window.browseHarness.clearProfile());
    assert.equal(await dialog.count(), 0);
    await tv.remote(BACK);
    assert.equal(await tv.page.locator("#successor").count(), 1);
}, { catalog: new FakeDetails() });

browseTest("S-D2 aggregate watched reconciles visible episodes in both directions", async (tv, catalog) => {
    assert.ok(catalog instanceof FakeDetails);
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "item:series:s1");
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "season:series:s1:1");
    assert.equal(await tv.page.locator(".browse-episode", { hasText: "Watched" }).count(), 3);
    await tv.page.getByRole("button", { name: "Mark all unwatched", exact: true }).click();
    await tv.page.getByRole("button", { name: "Mark all watched", exact: true }).waitFor();
    assert.equal(catalog.watchedEpisodes.has("episode:s1e11"), false);
    assert.equal(await tv.page.locator(".browse-episode", { hasText: "Watched" }).count(), 0, "authoritative rows must reflect aggregate unwatch");
    await tv.page.getByRole("button", { name: "Mark all watched", exact: true }).click();
    await tv.page.getByRole("button", { name: "Mark all unwatched", exact: true }).waitFor();
    assert.equal(await tv.page.locator(".browse-episode", { hasText: "Watched" }).count(), 3);
    assert.equal(browseReads(tv, "/catalog/series/series%3As1/seasons/1/episodes").length, 3);
}, { catalog: new FakeDetails() });

for (const kind of ["movie", "episode"]) {
    browseTest(`S-D3 never-played ${kind} can mark watched without a progress record`, async (tv, catalog) => {
        assert.ok(catalog instanceof FakeDetails);
        const id = kind === "movie" ? "movie:m0001" : "episode:s1e12";
        catalog.neverPlayed.add(id);
        catalog.progress.delete(id);
        catalog.watchedEpisodes.delete(id);
        await activateDetails(tv, id);
        await showing(tv, `item:${id}`);
        await tv.page.getByRole("button", { name: "Add favorite", exact: true }).waitFor();
        assert.equal(await tv.page.getByRole("button", { name: "Mark watched", exact: true }).count(), 1, "no progress is a valid unwatched state");
        catalog.mutationFailure = problem(503, "unavailable", "Unavailable");
        await tv.page.getByRole("button", { name: "Mark watched", exact: true }).click();
        await shows(tv, "Could not update watched.");
        await tv.jump(30000);
        assert.equal(catalog.mutations.length, 1);
        await tv.page.getByRole("button", { name: "Retry watched", exact: true }).click();
        await tv.page.getByRole("button", { name: "Mark unwatched", exact: true }).waitFor();
        assert.equal(catalog.mutations.length, 2);
        assert.equal(await tv.page.locator('[data-focus="watched"]').getAttribute("aria-pressed"), "true");
        await tv.page.getByRole("button", { name: "Mark unwatched", exact: true }).click();
        await tv.page.getByRole("button", { name: "Mark watched", exact: true }).waitFor();
        assert.equal(await tv.page.locator('[data-focus="watched"]').getAttribute("aria-pressed"), "false");
    }, { catalog: new FakeDetails() });
}

browseTest("S-D1 synopsis closes on browse destruction and optional failures remain retryable", async (tv) => {
    await tv.page.route("**/api/v2/recommendations/similar/**", async (route) => {
        await route.fulfill({ status: 400, json: problem(400, "unavailable", "Unavailable").body });
    });
    const related = tv.fake.hold("/capabilities/personal-lists", true);
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await tv.page.locator('[data-focus="synopsis"]').focus();
    await press(tv, "Enter");
    related.release();
    await tv.eventually(async () => tv.fake.requests.some((request) => request.path === "/favorites/movie%3Am0001/membership"), "membership answer");
    assert.equal(await tv.page.getByRole("dialog").count(), 1);
    await tv.remote(BACK);
    await tv.page.getByRole("button", { name: "Retry related titles", exact: true }).waitFor();
    await press(tv, "Enter");
    await tv.page.evaluate(() => window.browseHarness.destroy());
    assert.equal(await tv.page.getByRole("dialog").count(), 0);
    await tv.page.evaluate(() => window.browseHarness.mount());
    await showing(tv, "home");
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    assert.equal(await tv.page.getByRole("dialog").count(), 0);
    assert.equal(await tv.focused(), "resume");
}, { catalog: new FakeDetails() });

browseTest("S-D2 failed episode reconciliation retries reads without another aggregate write", async (tv, catalog) => {
    assert.ok(catalog instanceof FakeDetails);
    let fail = false;
    await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons/1/episodes?**", async (route) => {
        if (fail) await route.fulfill({ status: 400, json: problem(400, "unavailable", "Unavailable").body });
        else await route.fallback();
    });
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "item:series:s1");
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "season:series:s1:1");
    fail = true;
    await tv.page.getByRole("button", { name: "Mark all unwatched", exact: true }).click();
    await shows(tv, "Could not update watched.");
    assert.equal(catalog.mutations.length, 1);
    assert.equal(await tv.page.locator(".browse-episode", { hasText: "Watched" }).count(), 3, "failed read retains old rows with an explicit error");
    fail = false;
    await tv.page.getByRole("button", { name: "Retry watched", exact: true }).click();
    await tv.page.getByRole("button", { name: "Mark all watched", exact: true }).waitFor();
    assert.equal(await tv.page.locator(".browse-episode", { hasText: "Watched" }).count(), 0);
    assert.equal(catalog.mutations.length, 1);
}, { catalog: new FakeDetails() });

for (const aggregate of ["series", "season"]) {
    for (const played of [false, true]) {
        browseTest(`S-D2 ${aggregate} aggregate refreshes covered episode Details to ${played ? "watched" : "unwatched"}`, async (tv, catalog) => {
            assert.ok(catalog instanceof FakeDetails);
            if (played) catalog.watchedEpisodes.clear();
            else for (const title of catalog.titles.values()) if (title.type === "episode") catalog.watchedEpisodes.add(title.id);
            const episodeId = "episode:s1e12";
            const aggregateId = aggregate === "series" ? "series:s1" : "series:s1-S1";
            await tv.page.route("**/api/v2/recommendations/similar/episode%3As1e12?**", async (route) => {
                await route.fulfill({ status: 200, json: { ...fixture("list_catalog_items_ok"), items: [{ content_id: aggregateId, type: aggregate, title: "Harbor Lights", series_id: "series:s1", season_number: 1 }] } });
            });
            await activateDetails(tv, episodeId);
            await showing(tv, `item:${episodeId}`);
            await tv.page.getByRole("button", { name: played ? "Mark watched" : "Mark unwatched", exact: true }).waitFor();
            const related = tv.page.locator(`[data-detail-section="related"] [data-focus="${aggregateId}"]`);
            await related.focus();
            await press(tv, "Enter");
            await tv.page.getByRole("button", { name: played ? "Mark all watched" : "Mark all unwatched", exact: true }).click();
            await tv.page.getByRole("button", { name: played ? "Mark all unwatched" : "Mark all watched", exact: true }).waitFor();
            assert.equal(catalog.watchedEpisodes.has(episodeId), played);
            await tv.remote(BACK);
            await showing(tv, `item:${episodeId}`);
            await tv.eventually(async () => await tv.page.getByRole("button", { name: played ? "Mark unwatched" : "Mark watched", exact: true }).count() === 1, "covered episode reflects the aggregate change");
            assert.equal(browseReads(tv, "/catalog/items/episode%3As1e12").length, 2);
            assert.equal(catalog.mutations.length, 1);
        }, { catalog: new FakeDetails() });
    }
}

browseTest("S-D2 series aggregate invalidates a cached season before returning", async (tv, catalog) => {
    assert.ok(catalog instanceof FakeDetails);
    for (const title of catalog.titles.values()) if (title.type === "episode" && title.seriesId === "series:s1") catalog.watchedEpisodes.add(title.id);
    await tv.page.route("**/api/v2/recommendations/similar/series%3As1-S1?**", async (route) => {
        await route.fulfill({ status: 200, json: { ...fixture("list_catalog_items_ok"), items: [{ content_id: "series:s1", type: "series", title: "Harbor Lights" }] } });
    });
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "item:series:s1");
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "season:series:s1:1");
    await tv.page.locator('[data-detail-section="related"] [data-focus="series:s1"]').focus();
    await press(tv, "Enter");
    await showing(tv, "item:series:s1");
    await tv.page.getByRole("button", { name: "Mark all unwatched", exact: true }).click();
    await tv.page.getByRole("button", { name: "Mark all watched", exact: true }).waitFor();
    await tv.remote(BACK);
    await showing(tv, "season:series:s1:1");
    await tv.eventually(async () => await tv.page.locator(".browse-episode", { hasText: "Watched" }).count() === 0, "refreshed cached season");
    assert.equal(browseReads(tv, "/catalog/series/series%3As1/seasons/1/episodes").length, 2);
    await tv.page.locator('[data-detail-section="related"] [data-focus="series:s1"]').focus();
    await press(tv, "Enter");
    await showing(tv, "item:series:s1");
    const answer = tv.fake.hold("/watched/series%3As1", true);
    await tv.page.getByRole("button", { name: "Mark all watched", exact: true }).click();
    await tv.eventually(async () => catalog.mutations.length === 2, "committed aggregate before cancellation");
    await tv.remote(BACK);
    answer.release();
    await showing(tv, "season:series:s1:1");
    await tv.eventually(async () => await tv.page.locator(".browse-episode", { hasText: "Watched" }).count() === 3, "cached season after cancelling a committed answer");
    assert.equal(catalog.mutations.length, 2);
    assert.equal(browseReads(tv, "/catalog/series/series%3As1/seasons/1/episodes").length, 3);
}, { catalog: new FakeDetails() });

browseTest("S-D2 aggregate reconciliation cannot paint after profile authority ends", async (tv, catalog) => {
    assert.ok(catalog instanceof FakeDetails);
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "item:series:s1");
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "season:series:s1:1");
    const episodes = tv.fake.hold("/catalog/series/series%3As1/seasons/1/episodes", true);
    await tv.page.getByRole("button", { name: "Mark all unwatched", exact: true }).click();
    await tv.eventually(async () => browseReads(tv, "/catalog/series/series%3As1/seasons/1/episodes").length === 2, "reconciliation read");
    await tv.page.evaluate(() => window.browseHarness.clearProfile());
    episodes.release();
    await tv.jump(30000);
    assert.equal(await tv.page.locator(".browse").count(), 0);
    assert.equal(await tv.page.locator("#successor").count(), 1);
    assert.equal(catalog.mutations.length, 1);
}, { catalog: new FakeDetails() });

browseTest("S-D3 unknown or mismatched watched postconditions remain errors", async (tv, catalog) => {
    assert.ok(catalog instanceof FakeDetails);
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    let unknown = false;
    await tv.page.route("**/api/v2/catalog/items/movie%3Am0001?**", async (route) => {
        await route.fulfill({ status: 200, json: { ...fixture("get_catalog_item_ok"), content_id: "movie:m0001", user_data: undefined, user_state: unknown ? undefined : { played: false } } });
    });
    await tv.page.getByRole("button", { name: "Mark watched", exact: true }).click();
    await shows(tv, "Could not update watched.");
    unknown = true;
    await tv.page.getByRole("button", { name: "Retry watched", exact: true }).click();
    await shows(tv, "Could not update watched.");
    assert.equal(catalog.mutations.length, 1);
    assert.equal(await tv.page.locator('[data-focus="watched"]').getAttribute("aria-pressed"), "false");
}, { catalog: new FakeDetails() });

browseTest("Details portraits keep their circular geometry and combine one person's roles", async (tv) => {
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await tv.page.getByRole("button", { name: "Add favorite", exact: true }).waitFor();
    await tv.eventually(async () => await tv.page.locator('[data-detail-section="related"] .browse-card').count() === 24, "related titles");
    await tv.jump(240);
    assert.deepEqual(await tv.page.locator(".details-photo").first().evaluate((node) => ({ width: node.clientWidth, height: node.clientHeight })), { width: 200, height: 200 });
    assert.equal(await tv.page.locator(".details-hero").evaluate((node) => {
        const art = node.querySelector(".details-backdrop");
        return art !== null && art.getBoundingClientRect().bottom <= node.getBoundingClientRect().bottom;
    }), true, "hero artwork cannot paint over later rails");
    assert.equal(await tv.page.locator('[data-focus="person:river"]').count(), 1);
    await shows(tv, "Alex · Director");
}, { catalog: new FakeDetails() });

browseTest("long Details facts remain reachable with the remote", async (tv) => {
    await tv.page.route("**/api/v2/catalog/items/movie%3Am0001?**", async (route) => {
        await route.fulfill({ status: 200, json: { ...fixture("get_catalog_item_ok"), content_id: "movie:m0001", original_language: "en", crew: Array.from({ length: 35 }, (_, index) => ({ name: `Crew ${index}`, job: `Role ${index}` })) } });
    });
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await tv.page.getByRole("button", { name: "Add favorite", exact: true }).waitFor();
    await tv.eventually(async () => await tv.page.locator('[data-detail-section="related"] .browse-card').count() === 24, "related titles");
    const reached = new Set<string>();
    for (let index = 0; index < 45; index++) {
        await press(tv, "ArrowDown");
        await tv.jump(240);
        const fact = await tv.page.evaluate(() => {
            const node = document.activeElement;
            if (!node?.matches(".details-facts .browse-text")) return undefined;
            const box = node.getBoundingClientRect();
            return { text: node.textContent ?? "", visible: box.top >= 0 && box.bottom <= 1080 };
        });
        if (fact !== undefined) { assert.equal(fact.visible, true); reached.add(fact.text); }
    }
    assert.ok(reached.has("Role 34: Crew 34") && reached.has("Role 0: Crew 0") && reached.has("Original language: en"), JSON.stringify([...reached]));
}, { catalog: new FakeDetails() });

browseTest("personal writes require confirmed state and discard late replies after a profile change", async (tv, catalog) => {
    assert.ok(catalog instanceof FakeDetails);
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await tv.page.route("**/api/v2/favorites/movie%3Am0001/membership", async (route) => {
        await route.fulfill({ status: 200, json: { item_id: "movie:m0001", is_member: false } });
    });
    await tv.page.getByRole("button", { name: "Add favorite", exact: true }).click();
    await shows(tv, "Could not update favorites.");
    assert.equal(await tv.page.locator('[data-focus="favorites"]').getAttribute("aria-pressed"), "false");
    assert.equal(catalog.mutations.length, 1);
    const held = tv.fake.hold("/watchlist/movie%3Am0001", true);
    await tv.page.getByRole("button", { name: "Add to watchlist", exact: true }).click();
    await shows(tv, "Updating watchlist…");
    await tv.page.evaluate(() => window.browseHarness.clearProfile());
    held.release();
    await tv.jump(30000);
    assert.equal(await tv.page.locator(".browse").count(), 0);
    assert.equal(await tv.page.locator("#successor").count(), 1);
    assert.equal(catalog.mutations.length, 2);
    const writes = tv.fake.requests.filter((request) => /^\/(favorites|watchlist)\/movie%3Am0001$/.test(request.path));
    assert.equal(writes.length, 2);
    assert.ok(writes.every((request) => request.headers["x-profile-id"] === "p-owner"));
}, { catalog: new FakeDetails() });

browseTest("optional Details reads load independently, fail, retry and report empty results", async (tv, catalog) => {
    assert.ok(catalog instanceof FakeDetails);
    const related = tv.fake.hold("/recommendations/similar/movie%3Am0001", true);
    const capability = tv.fake.hold("/capabilities/personal-lists", true);
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    assert.equal(await tv.focused(), "resume", "optional reads do not block playback");
    await shows(tv, "Loading related titles.");
    await shows(tv, "Loading personal actions.");
    await tv.remote(BACK);
    await showing(tv, "home");
    related.release(); capability.release();
    await tv.jump(0);
    assert.equal(await view(tv), "home", "late optional reads cannot reopen Details");
    catalog.empty = true;
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await shows(tv, "No related titles available.");
    await tv.page.locator('[data-focus="person:river"]').focus();
    await press(tv, "Enter");
    await showing(tv, "person:river");
    await shows(tv, "No available titles for this person.");
    await tv.remote(BACK);
    await showing(tv, "item:movie:m0001");
    await tv.remote(BACK);
    catalog.capability = false;
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await tv.eventually(async () => tv.fake.requests.filter((request) => request.path === "/capabilities/personal-lists").length === 3, "unsupported capability");
    assert.equal(await tv.page.locator('[data-focus="watchlist"], [data-focus="favorites"]').count(), 0);
}, { catalog: new FakeDetails() });

browseTest("person, related and personal reads recover with explicit retries", async (tv) => {
    let relatedFail = true;
    let personalFail = true;
    await tv.page.route("**/api/v2/recommendations/similar/**", async (route) => {
        if (relatedFail) await route.fulfill({ status: 400, contentType: "application/problem+json", body: JSON.stringify({ type: "about:blank", title: "Unavailable", status: 400 }) });
        else await route.fallback();
    });
    await tv.page.route("**/api/v2/capabilities/personal-lists", async (route) => {
        if (personalFail) await route.fulfill({ status: 400, contentType: "application/problem+json", body: JSON.stringify({ type: "about:blank", title: "Unavailable", status: 400 }) });
        else await route.fallback();
    });
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await shows(tv, "Could not load related titles.");
    await shows(tv, "Could not load personal actions.");
    relatedFail = false; personalFail = false;
    await tv.page.getByRole("button", { name: "Retry related titles", exact: true }).click();
    await tv.page.getByRole("button", { name: "Retry personal actions", exact: true }).click();
    await tv.page.getByRole("button", { name: "Add favorite", exact: true }).waitFor();
    await tv.eventually(async () => await tv.page.locator('[data-detail-section="related"] .browse-card').count() === 24, "related retry");
    const person = tv.fake.hold("/catalog/people/river", true);
    await tv.page.locator('[data-focus="person:river"]').focus();
    await press(tv, "Enter");
    await showing(tv, "person:loading");
    await tv.page.evaluate(() => window.browseHarness.clearProfile());
    person.release();
    await tv.jump(0);
    assert.equal(await tv.page.locator(".browse").count(), 0);
    assert.equal(await tv.page.locator("#successor").count(), 1);
}, { catalog: new FakeDetails() });

for (const scenario of [{ outcome: "completed", played: false }, { outcome: "lost", played: true }, { outcome: "cancelled", played: false }]) {
    const fixtureCatalog = new FakeDetails();
    const title = fixtureCatalog.titles.get("movie:m0001");
    assert.ok(title);
    fixtureCatalog.add({ ...title, duration: 5400 });
    fixtureCatalog.watched = scenario.played;
    browseTest(`PR32 Home refreshes watched progress after a ${scenario.outcome} mutation`, async (tv, catalog) => {
        assert.ok(catalog instanceof FakeDetails);
        assert.equal(await tv.page.locator('[data-focus="movie:m0001"] .skyline-progress').count(), 1);
        await activateDetails(tv);
        await showing(tv, "item:movie:m0001");
        const path = "/watched/movie%3Am0001";
        const held = scenario.outcome === "cancelled" ? tv.fake.hold(path, true) : undefined;
        if (scenario.outcome === "lost") tv.fake.dropNextAnswer(path);
        await tv.page.getByRole("button", { name: scenario.played ? "Mark unwatched" : "Mark watched", exact: true }).click();
        await tv.eventually(async () => catalog.mutations.length === 1, "watched mutation committed");
        if (scenario.outcome === "completed") await tv.page.getByRole("button", { name: scenario.played ? "Mark watched" : "Mark unwatched", exact: true }).waitFor();
        if (scenario.outcome === "lost") await tv.page.getByRole("button", { name: "Retry watched", exact: true }).waitFor();
        await tv.remote(BACK);
        held?.release();
        await showing(tv, "home");
        assert.equal(catalog.progress.has("movie:m0001"), false);
        await tv.eventually(async () => await tv.page.locator('[data-focus="movie:m0001"] .skyline-progress').count() === 0, "Home discards obsolete progress");
        assert.equal(browseReads(tv, "/home/sections").length, 2);
        assert.equal(catalog.mutations.length, 1);
    }, { catalog: fixtureCatalog });
}

for (const kind of ["favorites", "watchlist"]) {
    browseTest(`PR32 returning from a person exposes reconciliation for cancelled ${kind}`, async (tv, catalog) => {
        assert.ok(catalog instanceof FakeDetails);
        await activateDetails(tv);
        await showing(tv, "item:movie:m0001");
        await tv.page.getByRole("button", { name: "Add favorite", exact: true }).waitFor();
        await tv.eventually(async () => await tv.page.locator('[data-detail-section="related"] .browse-card').count() === 24, "all optional reads finished");
        const path = `/${kind}/movie%3Am0001`;
        const held = tv.fake.hold(path, true);
        await tv.page.getByRole("button", { name: kind === "favorites" ? "Add favorite" : "Add to watchlist", exact: true }).click();
        await tv.eventually(async () => catalog.mutations.length === 1, "personal mutation committed");
        await tv.page.locator('[data-focus="person:river"]').first().focus();
        await press(tv, "Enter");
        await showing(tv, "person:river");
        await tv.remote(BACK);
        held.release();
        await showing(tv, "item:movie:m0001");
        await tv.eventually(async () => await tv.page.getByRole("button", { name: `Retry ${kind}`, exact: true }).count() === 1, "cancelled action becomes visibly retryable");
        assert.equal(await tv.page.locator(`[data-focus="${kind}"]`).getAttribute("aria-disabled"), "false");
        assert.equal(tv.fake.requests.filter(request => request.path === `${path}/membership`).length, 1);
        await tv.page.getByRole("button", { name: `Retry ${kind}`, exact: true }).click();
        await tv.page.getByRole("button", { name: kind === "favorites" ? "Remove favorite" : "Remove from watchlist", exact: true }).waitFor();
        assert.equal(tv.fake.requests.filter(request => request.path === `${path}/membership`).length, 2);
        assert.equal(catalog.mutations.length, 1, "Retry reconciles the committed state without another write");
    }, { catalog: new FakeDetails() });
}

browseTest("a lost watched answer is reconciled on Retry without repeating the non-retryable POST", async (tv, catalog) => {
    assert.ok(catalog instanceof FakeDetails);
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    tv.fake.dropNextAnswer("/watched/movie%3Am0001");
    await tv.page.getByRole("button", { name: "Mark watched", exact: true }).click();
    await shows(tv, "Could not update watched.");
    assert.equal(catalog.watched, true, "server committed the lost answer");
    await tv.jump(30000);
    assert.equal(catalog.mutations.length, 1);
    await tv.page.getByRole("button", { name: "Retry watched", exact: true }).click();
    await tv.page.getByRole("button", { name: "Mark unwatched", exact: true }).waitFor();
    assert.equal(catalog.mutations.length, 1, "retry reads the committed state instead of recording another watch");
}, { catalog: new FakeDetails() });

browseTest("season Details keeps episodes first, exposes real facts and restores the episode identity", async (tv) => {
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "item:series:s1");
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "season:series:s1:1");
    await shows(tv, "The first season follows the night shift at a coastal observatory.");
    assert.equal(await tv.focused(), "episode:s1e11");
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "item:episode:s1e12");
    await tv.remote(BACK);
    await showing(tv, "season:series:s1:1");
    assert.equal(await tv.focused(), "episode:s1e12");
}, { catalog: new FakeDetails() });

browseTest("season Details keeps watched available when the server rejects list membership, and tolerates missing metadata", async (tv) => {
    await tv.page.route("**/api/v2/*/series%3As1-S1/membership", async (route) => {
        await route.fulfill({ status: 404, json: problem(404, "not_found", "Not found").body });
    });
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "item:series:s1");
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "season:series:s1:1");
    await tv.page.getByRole("button", { name: "Mark all unwatched", exact: true }).waitFor();
    await tv.eventually(async () => !await tv.page.getByText("Loading personal actions.", { exact: true }).count(), "membership rejection");
    assert.equal(await tv.page.locator('[data-focus="watchlist"], [data-focus="favorites"]').count(), 0);
    await tv.page.locator('[data-focus="next-episode"]').focus();
    await press(tv, "Enter");
    await showing(tv, "item:episode:s1e11");
    await tv.remote(BACK);
    await showing(tv, "season:series:s1:1");
    await tv.remote(BACK);
    await showing(tv, "item:series:s1");
    await tv.page.route("**/api/v2/catalog/items/series%3As1-S1?**", async (route) => {
        await route.fulfill({ status: 404, json: problem(404, "not_found", "Not found").body });
    });
    await press(tv, "Enter");
    await showing(tv, "season:series:s1:1");
    assert.equal(await tv.focused(), "episode:s1e11");
    assert.equal(await tv.page.locator(".browse-episode").count(), 3);
}, { catalog: new FakeDetails() });

browseTest("Details rejects insecure artwork and retains its text title when logo decoding fails", async (tv, catalog) => {
    catalog.failNext("/catalog/items/movie%3Am0001", { status: 200, body: { ...fixture("get_catalog_item_ok"), content_id: "movie:m0001", title: "Readable title", logo_url: "/broken-logo.svg", backdrop_url: "http://art.example.test/backdrop.jpg" } });
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await tv.jump(240);
    assert.equal(await tv.page.locator(".browse h1").textContent(), "Readable title");
    assert.equal(await tv.page.locator('.details-backdrop img, .details-logo').count(), 0);
    assert.equal(await tv.page.locator('img[src^="http:"]').count(), 0);
    assert.equal(await tv.focused(), "play");
}, { catalog: new FakeCatalog() });

browseTest("personal failure never repeats a write automatically and explicit retry reconciles state", async (tv, catalog) => {
    assert.ok(catalog instanceof FakeDetails);
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await tv.page.getByRole("button", { name: "Add to watchlist", exact: true }).waitFor();
    catalog.mutationFailure = problem(503, "unavailable", "Unavailable");
    await tv.page.getByRole("button", { name: "Add to watchlist", exact: true }).click();
    await shows(tv, "Could not update watchlist.");
    await tv.jump(30000);
    assert.equal(catalog.mutations.length, 1);
    await tv.page.getByRole("button", { name: "Retry watchlist", exact: true }).click();
    await tv.page.getByRole("button", { name: "Remove from watchlist", exact: true }).waitFor();
    assert.equal(catalog.mutations.length, 2);
    await tv.page.getByRole("button", { name: "Mark watched", exact: true }).click();
    await tv.page.getByRole("button", { name: "Mark unwatched", exact: true }).waitFor();
    assert.equal(await tv.page.locator('[data-focus="resume"]').count(), 0, "server refresh clears resume after watched");
}, { catalog: new FakeDetails() });

browseTest("entering a library flyout cancels its pending row dwell", async (tv) => {
    await tv.page.clock.pauseAt(await tv.page.evaluate(() => Date.now() + 1000));
    await press(tv, "ArrowUp", "ArrowRight");
    await tv.jump(250);
    await press(tv, "ArrowDown", "ArrowRight");
    assert.equal(await tv.focused(), "section:browse");
    const reads = tv.fake.requests.length;
    await tv.jump(150);
    assert.equal(await tv.focused(), "section:browse");
    assert.equal(tv.fake.requests.length, reads);
    await press(tv, "Enter");
    await showing(tv, "library:12");
});

browseTest("R2 cached library restores flyout modes without reads on focus", async (tv, catalog) => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    catalog.failNext("/catalog/search/capabilities", { status: 200, body: { ...fixture("get_catalog_search_capabilities_ok"), allowed: false, state: "unsupported" } });
    await tv.page.locator('[data-focus="series"]').click();
    await showing(tv, "library:13");
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    const reads = tv.fake.requests.length;
    await tv.page.locator('[data-focus="movies"]').focus();
    await tv.jump(250);
    await press(tv, "ArrowDown", "ArrowRight");
    assert.deepEqual(await tv.page.locator('.skyline-flyout [role="menuitem"]').allTextContents(), ["Browse", "Collections", "Genres", "A–Z", "Recently Added"]);
    assert.equal(tv.fake.requests.length, reads);
});

browseTest("a completed library read preserves navigation chosen while loading", async (tv) => {
    const pending = tv.fake.hold("/library/12/sections", true);
    await tv.page.locator('[data-focus="movies"]').click();
    await tv.page.locator('[aria-label="Loading"]').waitFor();
    await press(tv, "ArrowUp", "ArrowRight");
    const focused = await tv.focused();
    assert.equal(focused, "movies");
    pending.release();
    await tv.eventually(async () => (await cardIds(tv)).length > 0, "library sections");
    assert.equal(await tv.focused(), focused);
});

browseTest("a completed letter jump preserves a different focused letter", async (tv, catalog) => {
    catalog.add({ id: "movie:alpha", type: "movie", title: "Alpha", libraryId: "12" });
    catalog.add({ id: "movie:zulu", type: "movie", title: "Zulu", libraryId: "12" });
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await tv.page.locator('[data-focus="mode:A–Z"]').click();
    await tv.eventually(async () => (await tv.focused()) === "movie:alpha", "alphabetical grid");
    const pending = tv.fake.hold("/catalog/query", true);
    await tv.page.locator('[data-focus="letter:A"]').click();
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "letter:M");
    pending.release();
    await tv.eventually(async () => (await cardIds(tv)).length > 0, "letter results");
    assert.equal(await tv.focused(), "letter:M");
});

browseTest("a completed genre sort preserves its Sort control", async (tv) => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await tv.page.locator('[data-focus="mode:Genres"]').click();
    await tv.page.locator('[data-focus="genre:Drama"]').click();
    await tv.eventually(async () => (await cardIds(tv)).length > 0, "genre results");
    const pending = tv.fake.hold("/catalog/query", true);
    await tv.page.locator('[data-focus="sort"]').click();
    assert.equal(await tv.focused(), "sort");
    pending.release();
    await tv.eventually(async () => (await cardIds(tv)).length > 0, "sorted results");
    assert.equal(await tv.focused(), "sort");
});

browseTest("inline collection fans retain their width and contain their text", async (tv) => {
    await tv.page.emulateMedia({ reducedMotion: "reduce" });
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    const fan = tv.page.locator('.browse-row .discovery-collection').first();
    const geometry = await fan.evaluate(node => {
        const card = node.getBoundingClientRect();
        const text = Array.from(node.querySelectorAll('.discovery-collection-name, .discovery-collection-count')).map(item => item.getBoundingClientRect());
        return { width: getComputedStyle(node).width, contained: text.every(item => item.right <= card.right && item.left >= card.left) };
    });
    assert.deepEqual(geometry, { width: "430px", contained: true });
});

browseTest("A–Z first row returns directly to pills with multiple letters", async (tv, catalog) => {
    catalog.add({ id: "movie:alpha", type: "movie", title: "Alpha", libraryId: "12" });
    catalog.add({ id: "movie:zulu", type: "movie", title: "Zulu", libraryId: "12" });
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await tv.page.locator('[data-focus="mode:A–Z"]').click();
    await tv.eventually(async () => (await tv.focused()) === "movie:alpha", "first alphabetical card");
    assert.deepEqual(await tv.page.locator('.discovery-letters button').allTextContents(), ["A", "M", "Z"]);
    const reads = tv.fake.requests.length;
    await press(tv, "ArrowUp");
    assert.equal(await tv.page.locator('.skyline-pills :focus').count(), 1, "Up reaches the pills without traversing the rail");
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "movie:alpha");
    await press(tv, "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight");
    assert.equal(await tv.focused(), "letter:A");
    await press(tv, "ArrowDown", "ArrowDown");
    assert.equal(await tv.focused(), "letter:Z");
    await press(tv, "ArrowLeft");
    assert.equal(await tv.focused(), "movie:m0005");
    await press(tv, "ArrowRight");
    assert.equal(await tv.focused(), "letter:Z");
    await press(tv, "ArrowUp", "ArrowUp", "ArrowUp");
    assert.equal(await tv.page.locator('.skyline-pills :focus').count(), 1);
    assert.equal(tv.fake.requests.length, reads);
});

browseTest("R2 grid focus remains visible and remote enters right rail without reads", async (tv) => {
    await tv.page.emulateMedia({ reducedMotion: "reduce" });
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await tv.page.locator('[data-focus="mode:A–Z"]').click();
    await tv.eventually(async () => (await cardIds(tv)).length === 24, "grid page");
    const visible = await tv.page.locator('.browse .browse-card').first().evaluate(node => {
        const card = node.getBoundingClientRect();
        const viewport = node.closest('.skyline-content')?.getBoundingClientRect();
        return viewport !== undefined && card.top >= viewport.top && card.left >= viewport.left;
    });
    assert.equal(visible, true, "scaled focus border remains inside viewport");
    const rowTops = await tv.page.locator('.browse .browse-grid .browse-card').evaluateAll(nodes => nodes.slice(1, 6).map(node => node.getBoundingClientRect().top));
    assert.equal(new Set(rowTops).size, 1, "the six-column focus map matches the rendered row");
    const reads = tv.fake.requests.length;
    await press(tv, "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight");
    assert.equal(await tv.focused(), "letter:M");
    await press(tv, "ArrowLeft");
    assert.equal(await tv.focused(), "movie:m0006");
    assert.equal(tv.fake.requests.length, reads);
});

browseTest("R2 interrupted letter read resumes on cached library return", async (tv) => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await tv.page.locator('[data-focus="mode:A–Z"]').click();
    await tv.page.locator('[data-focus="letter:M"]').waitFor();
    const pending = tv.fake.hold("/catalog/query", true);
    const before = tv.fake.requests.length;
    await tv.page.locator('[data-focus="letter:M"]').click();
    await tv.eventually(async () => tv.fake.requests.length > before, "held letter read");
    await tv.page.locator('[data-focus="series"]').click();
    await showing(tv, "library:13");
    pending.release();
    await tv.page.locator('[data-focus="movies"]').click();
    await tv.eventually(async () => (await cardIds(tv)).length > 0, "replacement letter page");
    assert.equal(await tv.page.locator('[data-focus="letter:M"]').getAttribute("aria-pressed"), "true");
});

browseTest("R2 invalid cursor resets only the active query and cached reopening starts fresh", async (tv, catalog) => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await tv.page.locator('[data-focus="mode:Recently Added"]').click();
    await tv.page.locator('.browse [data-focus="next"]').click();
    await shows(tv, "Page 2 of 3");
    catalog.failNext("/catalog/query", problem(400, "invalid_cursor", "Invalid cursor"));
    await tv.page.locator('.browse [data-focus="next"]').click();
    await shows(tv, "The list changed. Go back and open it again.");
    await tv.page.locator('[data-focus="home"]').click();
    await showing(tv, "home");
    await tv.page.locator('[data-focus="movies"]').click();
    await shows(tv, "Page 1 of 3");
    assert.equal(tv.fake.requests.filter(request => request.path === "/catalog/query").pop()?.body?.cursor, undefined);
});

browseTest("R2 activating current Browse reveals first card from lower shelf without reads", async (tv) => {
    await tv.page.emulateMedia({ reducedMotion: "reduce" });
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "collection:highlights");
    const reads = tv.fake.requests.length;
    await tv.page.locator('[data-focus="mode:Browse"]').click();
    assert.equal(await tv.focused(), "movie:m0001");
    assert.equal(tv.fake.requests.length, reads);
    assert.equal(await tv.page.locator('.browse .browse-card').first().evaluate(node => {
        const bounds = node.getBoundingClientRect();
        const viewport = node.closest('.skyline-content')?.getBoundingClientRect();
        return viewport !== undefined && bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
    }), true);
});

browseTest("R2 grid destinations retain pills without marquee and place rail on right", async (tv) => {
    await tv.page.emulateMedia({ reducedMotion: "reduce" });
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await tv.page.locator('[data-focus="mode:A–Z"]').click();
    await tv.page.locator('[data-focus="letter:M"]').waitFor();
    assert.equal(await tv.page.locator('.browse .skyline-marquee').count(), 0);
    const rail = await tv.page.locator('.browse .discovery-letters').boundingBox();
    assert.ok(rail !== null && rail.x > 1700);
    const content = await tv.page.locator('.browse .skyline-content').boundingBox();
    assert.ok(content !== null && content.y < 260);
});

browseTest("R2 Browse includes inline collections and Collections uses fan grid", async (tv) => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    assert.equal(await tv.page.locator('.browse [data-focus="collection:highlights"]').count(), 1);
    await tv.page.locator('[data-focus="collections:all"]').click();
    await tv.page.locator('.browse .discovery-collection').waitFor();
    const card = await tv.page.locator('.browse .discovery-collection').first().boundingBox();
    assert.ok(card !== null && card.width >= 430 && card.height >= 234);
    assert.equal(await tv.page.locator('.browse .discovery-collection-count').first().innerText(), "60 titles");
});

browseTest("R2 capability read failure renders Retry", async (tv, catalog) => {
    catalog.failNext("/catalog/search/capabilities", { status: 200, body: {} });
    await tv.page.locator('[data-focus="movies"]').click();
    await tv.page.locator('.browse [data-focus="retry"]').waitFor();
    await press(tv, "Enter");
    await showing(tv, "library:12");
    assert.equal(await tv.page.locator('.browse .skyline-pills button').count(), 5);
});

browseTest("R2 Collections fan geometry and focus border stay inside the viewport", async (tv) => {
    await tv.page.emulateMedia({ reducedMotion: "reduce" });
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await tv.page.locator('[data-focus="mode:Collections"]').click();
    await tv.page.locator('.browse .discovery-collection').waitFor();
    const geometry = await tv.page.locator('.browse .discovery-collection').first().evaluate(node => {
        const grid = node.parentElement;
        const viewport = node.closest('.skyline-content')?.getBoundingClientRect();
        const card = node.getBoundingClientRect();
        return { width: node.clientWidth + 4, height: node.clientHeight + 4, columns: grid === null ? "" : getComputedStyle(grid).gridTemplateColumns, gap: grid === null ? "" : getComputedStyle(grid).columnGap, visible: viewport !== undefined && card.top >= viewport.top && card.left >= viewport.left && card.bottom <= viewport.bottom };
    });
    assert.deepEqual(geometry, { width: 430, height: 234, columns: "430px 430px 430px", gap: "26px", visible: true });
});

browseTest("R2 personal collections retain server group and query source", async (tv, catalog) => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    catalog.failNext("/library/12/collections", { status: 200, body: fixture("get_library_collections_ok") });
    await tv.page.locator('[data-focus="mode:Collections"]').click();
    await tv.page.locator('[data-focus="collection:u1"]').waitFor();
    await shows(tv, "Mine");
    await tv.page.locator('[data-focus="collection:u1"]').click();
    await tv.eventually(async () => tv.fake.requests.some(request => request.body?.source === "user_collection"), "personal collection query");
    assert.deepEqual(tv.fake.requests.filter(request => request.body?.source === "user_collection").pop()?.body, { library_id: "12", type: "movie", limit: 24, sort: "title", order: "asc", source: "user_collection", scope: "library", collection_id: "u1" });
});

browseTest("R2 filtered genres keep library chrome", async (tv) => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await tv.page.locator('[data-focus="mode:Genres"]').click();
    await tv.page.locator('[data-focus="genre:Drama"]').click();
    await shows(tv, "Title A–Z");
    assert.equal(await tv.page.locator('.browse .skyline-pills button').count(), 5);
    assert.equal(await tv.page.locator('.browse .skyline-marquee').count(), 0);
});

browseTest("discovery exposes five real library destinations", async (tv) => {
    if (process.env.DISCOVERY_CAPTURE !== undefined) await tv.page.emulateMedia({ reducedMotion: "reduce" });
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    const evidence = process.env.DISCOVERY_OUTPUT;
    if (process.env.DISCOVERY_CAPTURE !== undefined) {
        assert.ok(evidence, "DISCOVERY_OUTPUT is required for capture");
        await mkdir(evidence, { recursive: true });
        await tv.page.clock.runFor(600);
        await tv.page.screenshot({ path: `${evidence}/${process.env.DISCOVERY_CAPTURE}.png` });
    }
    assert.deepEqual(await tv.page.locator(".browse .skyline-pills button").allTextContents(), ["Browse", "Collections", "Genres", "A–Z", "Recently Added"]);
});

if (process.env.DISCOVERY_PACED !== undefined) {
    browseTest("discovery flow evidence: paced remote library destinations", async (tv) => {
        const output = process.env.DISCOVERY_OUTPUT;
        assert.ok(output, "DISCOVERY_OUTPUT is required for evidence");
        await mkdir(output, { recursive: true });
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        const key = async (value: string): Promise<void> => {
            await tv.page.keyboard.press(value);
            await tv.page.clock.runFor(650);
            await tv.page.waitForTimeout(650);
        };
        await key("ArrowUp");
        await key("ArrowRight");
        await key("Enter");
        await showing(tv, "library:12");
        await tv.page.screenshot({ path: `${output}/after-browse.png` });
        await key("ArrowUp");
        await key("ArrowUp");
        await key("ArrowRight");
        await key("Enter");
        await tv.page.locator('.browse .discovery-collection-grid').waitFor();
        await tv.page.screenshot({ path: `${output}/after-collections.png` });
        await key("ArrowUp");
        await key("ArrowRight");
        await key("ArrowRight");
        await key("Enter");
        await tv.page.locator('.browse .discovery-letters').waitFor();
        await tv.page.screenshot({ path: `${output}/after-az.png` });
        for (let index = 0; index < 6; index++) await key("ArrowRight");
        await key("Enter");
        await key("ArrowLeft");
        await key("ArrowDown");
        await key("ArrowDown");
        await tv.page.screenshot({ path: `${output}/after-lower-grid.png` });
    });
}

for (const [tab, library, first] of [["movies", "12", "movie:m0001"], ["series", "13", "series:s1"]]) {
    browseTest(`discovery flow ${tab}: sections, collection, genre, letters and Recently Added use one library`, async tv => {
        await tv.page.locator(`[data-focus="${tab}"]`).click();
        await showing(tv, `library:${library}`);
        assert.equal(await tv.focused(), first);
        await tv.page.locator('[data-focus="section:library-picks"]').click();
        await shows(tv, "Page 1");
        assert.ok(tv.fake.requests.some(request => request.path.startsWith(`/library/${library}/sections/library-picks/items`)));
        assert.deepEqual(tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).slice(-1)[0]?.body, { library_id: library, type: tab === "movies" ? "movie" : "series", limit: 24, sort: "title", order: "asc", source: "section", scope: "library", section_id: "library-picks" });
        await tv.remote(BACK);
        assert.equal(await tv.focused(), "section:library-picks");
        await tv.page.locator('[data-focus="mode:Collections"]').click();
        await tv.page.locator('[data-focus="collection:highlights"]').waitFor();
        await press(tv, "Enter");
        await shows(tv, "Library Highlights");
        await tv.eventually(async () => tv.fake.requests.some(request => request.path.startsWith(`/library/${library}/collections/highlights/items?limit=24`)), "scoped collection items");
        await tv.remote(BACK);
        assert.equal(await tv.focused(), "collection:highlights");
        await tv.page.locator('[data-focus="mode:Genres"]').click();
        await tv.page.locator('[data-focus="genre:Drama"]').waitFor();
        await tv.page.locator('[data-focus="genre:Drama"]').click();
        await shows(tv, "Title A–Z");
        await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).slice(-1)[0]?.body?.groups !== undefined, "genre query");
        assert.deepEqual(tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).slice(-1)[0]?.body?.groups, [{ match: "all", rules: [{ field: "genre", op: "is", value: "Drama" }] }]);
        await tv.page.locator('[data-focus="sort"]').click();
        await shows(tv, "Title Z–A");
        await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).slice(-1)[0]?.body?.order === "desc", "sort query");
        assert.equal(tv.fake.requests.slice(-1)[0]?.body?.cursor, undefined);
        await tv.remote(BACK);
        await tv.page.locator('[data-focus="genre:Comedy"]').click();
        await shows(tv, "No titles");
        await tv.remote(BACK);
        await tv.page.locator('[data-focus="mode:A–Z"]').click();
        await showing(tv, `library:${library}`);
        const letter = tv.page.locator(".discovery-letters button").first();
        await letter.click();
        await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).slice(-1)[0]?.body?.seek === 0, "server letter seek");
        assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).slice(-1)[0]?.body?.cursor, "window");
        await tv.page.locator('[data-focus="mode:Recently Added"]').click();
        await showing(tv, `library:${library}`);
        const query = tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).slice(-1)[0];
        assert.deepEqual(query?.body, { library_id: library, type: tab === "movies" ? "movie" : "series", limit: 24, sort: "added_at", order: "desc" });
        const count = tv.fake.requests.length;
        await press(tv, "ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp");
        assert.equal(tv.fake.requests.length, count);
    });
}

browseTest("discovery loading, retry and late answers preserve route and profile authority", async (tv, catalog) => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    const pending = tv.fake.hold("/library/12/collections", true);
    await tv.page.locator('[data-focus="mode:Collections"]').click();
    await tv.page.locator('[aria-label="Loading"]').waitFor();
    await tv.page.locator('[data-focus="series"]').click();
    await showing(tv, "library:13");
    pending.release();
    await tv.jump(500);
    assert.equal(await view(tv), "library:13");
    catalog.failNext("/library/13/collections", problem(403, "forbidden", "Forbidden"));
    await tv.page.locator('[data-focus="mode:Collections"]').click();
    await tv.page.locator('[data-focus="retry"]').waitFor();
    await press(tv, "Enter");
    await tv.page.locator('[data-focus="collection:highlights"]').waitFor();
    const authority = tv.fake.hold("/catalog/query", true);
    const queries = tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length;
    await tv.page.locator('[data-focus="mode:Recently Added"]').click();
    await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length > queries, "pending query before authority changes");
    await tv.page.evaluate(() => window.browseHarness.clearProfile());
    authority.release();
    await tv.jump(500);
    assert.equal(await tv.page.locator(".browse").count(), 0);
    await shows(tv, "Who's watching?");
});

browseTest("discovery omits unsupported capabilities and has no dead controls", async (tv, catalog) => {
    catalog.failNext("/catalog/search/capabilities", { status: 200, body: { ...fixture("get_catalog_search_capabilities_ok"), allowed: false, state: "unsupported" } });
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    assert.deepEqual(await tv.page.locator(".browse .skyline-pills button").allTextContents(), ["Browse", "Collections"]);
});

browseTest("discovery uses nonzero letter positions and cancels an obsolete query without fetching on focus", async (tv, catalog) => {
    catalog.add({ id: "movie:aaa", type: "movie", title: "A River Beyond the Mountains and Across the Entire Continent", libraryId: "12" });
    await tv.page.emulateMedia({ reducedMotion: "reduce" });
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await tv.page.locator('[data-focus="mode:A–Z"]').click();
    await showing(tv, "library:12");
    assert.equal(await tv.page.locator('[data-focus="letter:M"]').getAttribute("aria-label"), "M, 60 titles");
    await tv.page.locator('[data-focus="letter:M"]').click();
    await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).slice(-1)[0]?.body?.seek === 1, "nonzero server seek");
    await tv.eventually(async () => (await cardIds(tv))[0] === "movie:m0001", "letter window starts on server position");
    const delayed = tv.fake.hold("/catalog/query", true);
    const queries = tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length;
    await tv.page.locator('[data-focus="mode:Recently Added"]').click();
    await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length > queries, "pending query before mode changes");
    await tv.page.locator('[data-focus="mode:Collections"]').click();
    await tv.page.locator('[data-focus="collection:highlights"]').waitFor();
    delayed.release();
    await tv.jump(500);
    assert.equal(await tv.page.locator('.browse .skyline-pills [aria-pressed="true"]').innerText(), "Collections");
    assert.deepEqual(await cardIds(tv), []);
    const requests = tv.fake.requests.length;
    await tv.remote(BACK);
    await tv.page.locator('[data-focus="movies"]').focus();
    await tv.jump(250);
    await press(tv, "ArrowDown", "ArrowRight");
    assert.deepEqual(await tv.page.locator('.skyline-flyout [role="menuitem"]').allTextContents(), ["Browse", "Collections", "Genres", "A–Z", "Recently Added"]);
    await tv.remote(18);
    assert.equal(await tv.fake.requests.length, requests);
});

browseTest("Skyline keeps bounded type tabs and a passive debounced marquee", async (tv) => {
    assert.deepEqual(await cardIds(tv, ".browse-nav .browse-button"), ["home", "movies", "series", "search", "profiles", "calendar"]);
    assert.equal(await tv.page.locator(".skyline-marquee h1").textContent(), "Movie 0001");
    const reads = tv.fake.requests.length;
    await press(tv, "ArrowRight");
    assert.equal(await tv.focused(), "episode:s1e12");
    assert.equal(await tv.page.locator(".skyline-marquee h1").textContent(), "Movie 0001");
    await tv.jump(150);
    assert.equal(await tv.page.locator(".skyline-marquee h1").last().textContent(), "Harbor Lights chapter 1.2");
    assert.equal(tv.fake.requests.length, reads);
});

browseTest("row scrolling has intermediate frames without delaying focus", async (tv) => {
    await tv.page.clock.pauseAt(await tv.page.evaluate(() => Date.now() + 1000));
    await tv.page.evaluate(() => { document.querySelector(".browse")?.setAttribute("data-probe", "scroll"); });
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "series:s1");
    const start = await tv.page.locator(".browse .skyline-content").evaluate((node) => node.scrollTop);
    await tv.page.clock.runFor(80);
    const middle = await tv.page.locator(".browse .skyline-content").evaluate((node) => node.scrollTop);
    await tv.page.clock.runFor(300);
    const end = await tv.page.locator(".browse .skyline-content").evaluate((node) => node.scrollTop);
    assert.ok(start < middle && middle < end, `${start} < ${middle} < ${end}`);
});

browseTest("Continue Watching keeps landscape geometry when backdrop or progress metadata is missing", async (tv) => {
    const boxes = await tv.page.locator('[data-section="continue_watching"] .browse-art').evaluateAll((nodes) => nodes.map((node) => ({ width: node.clientWidth, height: node.clientHeight })));
    assert.deepEqual(boxes, [{ width: 372, height: 209 }, { width: 372, height: 209 }]);
});

browseTest("Continue Watching uses section type rather than its opaque identity", async (tv, catalog) => {
    const household = catalog.households.get("p-owner");
    assert.ok(household !== undefined);
    const section = household.sections[0];
    assert.ok(section !== undefined);
    section.sectionType = "continue_watching";
    section.id = "shelf-resume-opaque";
    section.title = "Resume";
    await tv.page.evaluate(() => { window.browseHarness.destroy(); window.browseHarness.mount(); });
    await tv.page.locator('[data-section="shelf-resume-opaque"] .browse-art').first().waitFor();
    const boxes = await tv.page.locator('[data-section="shelf-resume-opaque"] .browse-art').evaluateAll((nodes) => nodes.map((node) => ({ width: node.clientWidth, height: node.clientHeight })));
    assert.deepEqual(boxes, [{ width: 372, height: 209 }, { width: 372, height: 209 }]);
});

browseTest("a populated Home changes route without copying every descendant's computed styles", async (tv, catalog) => {
    const household = catalog.households.get("p-owner");
    assert.ok(household !== undefined);
    household.sections = Array.from({ length: 6 }, (_, row) => ({
        id: `shelf-${row}`,
        title: `Shelf ${row + 1}`,
        items: Array.from({ length: 20 }, (_, column) => `movie:m${String(row * 20 + column + 1).padStart(4, "0")}`),
    }));
    await tv.page.evaluate(() => { window.browseHarness.destroy(); window.browseHarness.mount(); });
    await showing(tv, "home");
    await tv.page.clock.pauseAt(await tv.page.evaluate(() => Date.now() + 1000));
    const response = tv.fake.hold("/library/12/sections", true);
    const reads = await tv.page.evaluate(() => {
        let calls = 0;
        const original = window.getComputedStyle;
        window.getComputedStyle = (element, pseudo) => { calls++; return original.call(window, element, pseudo); };
        try {
            document.querySelector<HTMLButtonElement>('[data-focus="movies"]')?.click();
        } finally {
            window.getComputedStyle = original;
        }
        return calls;
    });
    assert.ok(reads < 20, `navigation must not read computed styles for every card node: ${reads}`);
    await showing(tv, "library:loading");
    const snapshot = tv.page.locator(".skyline-route-outgoing");
    assert.equal(await snapshot.getAttribute("aria-hidden"), "true");
    assert.equal(await snapshot.locator(".browse-card").count(), 120);
    assert.equal(await snapshot.locator(".browse-nav, [data-focus]").count(), 0);
    assert.deepEqual(await snapshot.locator(".browse-art").first().evaluate((node) => ({ width: node.clientWidth, height: node.clientHeight })), { width: 208, height: 312 });
    response.release();
    await showing(tv, "library:12");
    assert.equal(await tv.focused(), "movie:m0001");
}, { catalog: new FakeCatalog(120) });

browseTest("Back dismisses a profile menu on Search without leaving its results", async (tv) => {
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", "night");
    await tv.remote(IME_DONE);
    await shows(tv, "Night Shift");
    await tv.page.locator('[data-focus="profiles"]').focus();
    await tv.jump(250);
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "switch-profile");
    const reads = tv.fake.requests.length;
    await tv.remote(BACK);
    assert.equal(await view(tv), "search");
    assert.equal(await tv.focused(), "profiles");
    assert.equal(await tv.page.locator(".skyline-selector").first().isVisible(), false);
    assert.equal(await tv.page.inputValue("#browse-search"), "night");
    assert.equal(tv.fake.requests.length, reads);
});

browseTest("sideways menu dismissal removes its hidden focus zone", async (tv) => {
    await press(tv, "ArrowUp", "ArrowRight");
    await tv.jump(250);
    assert.equal(await tv.page.locator(".skyline-selector").first().isVisible(), true);
    await press(tv, "ArrowLeft");
    assert.equal(await tv.focused(), "home");
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "movie:m0001");
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "series:s1");
});

browseTest("many libraries stay bounded; dwell and Back never commit; scope survives remount", async (tv, catalog) => {
    const household = catalog.households.get("p-owner");
    assert.ok(household);
    household.hidden = [];
    for (let index = 0; index < 20; index++) household.libraries.push({ id: String(index + 30), name: `Library ${index} with a long title`, type: "movies", sort_order: index + 10 });
    await tv.page.evaluate(() => { window.browseHarness.destroy(); window.browseHarness.mount(); });
    await showing(tv, "home");
    assert.equal(await tv.page.locator(".browse").evaluate((node) => node.scrollWidth), 1920);
    await tv.page.clock.pauseAt(await tv.page.evaluate(() => Date.now() + 1000));
    await tv.page.evaluate(() => { window.retainedNavigation = document.querySelector(".browse-nav"); });
    const reads = tv.fake.requests.length;
    await press(tv, "ArrowUp", "ArrowRight");
    await tv.jump(249);
    assert.equal(await tv.page.locator(".skyline-selector").first().isVisible(), false);
    await tv.jump(1);
    assert.equal(await tv.page.locator(".skyline-selector").first().isVisible(), true);
    assert.equal(await tv.focused(), "movies", "dwell does not steal focus");
    assert.equal(tv.fake.requests.length, reads);
    await press(tv, "ArrowDown", "ArrowDown");
    await tv.remote(BACK);
    assert.equal(await tv.focused(), "movies");
    assert.equal(await view(tv), "home");
    await tv.jump(500);
    assert.equal(await tv.page.locator(".skyline-selector").first().isVisible(), false, "Back keeps the menu dismissed until focus leaves its anchor");
    await press(tv, "ArrowLeft", "ArrowRight");
    await tv.jump(250);
    await press(tv, "ArrowDown", "ArrowDown", "Enter");
    await showing(tv, "library:15");
    assert.equal(await tv.page.evaluate(() => window.retainedNavigation === document.querySelector(".browse-nav")), true);
    await tv.page.evaluate(() => { window.browseHarness.destroy(); window.browseHarness.mount(); });
    await showing(tv, "home");
    await press(tv, "ArrowUp", "ArrowRight", "Enter");
    await showing(tv, "library:15");
});

browseTest("long synopsis expands and scrolls accessibly; empty search omits Page 1 of 1", async (tv, catalog) => {
    catalog.failNext("/catalog/items/movie%3Am0001", { status: 200, body: { ...fixture("get_catalog_item_ok"), content_id: "movie:m0001", overview: "A long synopsis. ".repeat(900) } });
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await tv.page.locator('[data-focus="synopsis"]').focus();
    await press(tv, "Enter");
    const dialog = tv.page.getByRole("dialog", { name: "Synopsis" });
    assert.equal(await dialog.isVisible(), true);
    await press(tv, "ArrowDown");
    await tv.page.clock.runFor(220);
    assert.ok(await dialog.evaluate((node) => node.scrollTop > 0));
    await tv.remote(BACK);
    assert.equal(await tv.focused(), "synopsis");
    await tv.remote(BACK);
    await showing(tv, "home");
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", "no-such-title");
    await tv.remote(IME_DONE);
    await shows(tv, 'No results for "no-such-title".');
    assert.equal(await tv.page.locator(".browse-page-status").count(), 0);
});

browseTest("reduced motion snaps scrolling and the real Browse flyout preserves scope on Back", async (tv) => {
    await tv.page.emulateMedia({ reducedMotion: "reduce" });
    await press(tv, "ArrowDown");
    const top = await tv.page.locator(".browse .skyline-content").evaluate((node) => node.scrollTop);
    assert.ok(top > 0);
    await tv.page.clock.runFor(100);
    assert.equal(await tv.page.locator(".browse .skyline-content").evaluate((node) => node.scrollTop), top);
    await tv.remote(BACK);
    await press(tv, "ArrowRight");
    await tv.jump(250);
    await tv.remote(40);
    await tv.remote(39);
    assert.equal(await tv.focused(), "section:browse");
    assert.equal(await tv.page.locator(".skyline-flyout").textContent(), "BrowseCollections");
    await tv.remote(37);
    assert.equal(await tv.focused(), "library:12");
    await tv.remote(BACK);
    assert.equal(await view(tv), "home");
    await press(tv, "Enter");
    await showing(tv, "library:12");
});

browseTest("Home lists visible video libraries and supported rows, and every row is reachable by remote", async (tv) => {
    const nav = await cardIds(tv, ".browse-nav .browse-button");
    assert.deepEqual(nav, ["home", "movies", "series", "search", "profiles", "calendar"], "bounded video types and Calendar only");
    const rows = await tv.page.evaluate(() => Array.from(document.querySelectorAll("[data-section]")).map((node) => node.getAttribute("data-section")));
    assert.deepEqual(rows, ["continue_watching", "recently_added"], "a row of only books is left out");
    assert.equal((await cardIds(tv)).indexOf("ebook:atlas"), -1, "the book card in a mixed row is left out");
    assert.equal(await tv.focused(), "movie:m0001", "focus starts on the first card");

    await press(tv, "ArrowRight");
    assert.equal(await tv.focused(), "episode:s1e12");
    await press(tv, "ArrowDown", "ArrowRight", "ArrowRight");
    assert.equal(await tv.focused(), "movie:m0001", "Recently Added: series first, then movies");
    await press(tv, "ArrowUp");
    assert.equal(await tv.focused(), "episode:s1e12", "back to the card last focused in the row above");
    await press(tv, "ArrowUp", "ArrowRight");
    assert.equal(await tv.focused(), "movies");
    await press(tv, "ArrowUp");
    assert.equal(await tv.focused(), "movies", "nothing above the top zone");

    const reads = browseReads(tv);
    assert.ok(reads.length >= 3);
    assert.ok(reads.every((read) => read.headers["x-profile-id"] === "p-owner" && read.headers.authorization?.startsWith("Bearer ")));
    assert.ok(reads.every((read) => read.path.indexOf("include_hidden") === -1));

    const before = tv.fake.requests.length;
    await press(tv, "ArrowDown", "ArrowRight", "ArrowLeft", "ArrowDown", "ArrowRight", "ArrowRight", "ArrowUp", "ArrowUp");
    assert.equal(tv.fake.requests.length, before, "moving focus fetches nothing");

    await tv.remote(BACK);
    assert.equal(await tv.page.evaluate(() => window.browseHarness.lastKeyPrevented), false, "Back on Home reaches the app's root exit handler");
    assert.equal(await view(tv), "home");
});

browseTest(
    "a large library pages by cursor, keeps one page in the DOM and never fetches on focus moves",
    async (tv) => {
        await press(tv, "ArrowUp", "ArrowRight", "Enter");
        await showing(tv, "library:12");
        await tv.page.locator('[data-focus="mode:A–Z"]').click();
        await showing(tv, "library:12");
        await tv.eventually(async () => (await cardIds(tv)).length === PAGE_SIZE, "the first page");
        assert.deepEqual((await cardIds(tv)).slice(0, 2), ["movie:m0001", "movie:m0002"]);
        await shows(tv, "Page 1 of 209");
        const first = tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).pop();
        assert.deepEqual(first?.body, { library_id: "12", type: "movie", limit: 24, sort: "title", order: "asc" });

        const before = tv.fake.requests.length;
        await press(tv, "ArrowRight", "ArrowRight", "ArrowDown", "ArrowDown", "ArrowDown");
        assert.equal(await tv.focused(), "movie:m0021", "Down moves one grid row of six");
        await press(tv, "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight");
        assert.equal(await tv.focused(), "letter:M", "Right enters the right-edge rail");
        await press(tv, "ArrowLeft");
        assert.equal(await tv.focused(), "movie:m0024", "Left restores the grid edge card");
        assert.equal(tv.fake.requests.length, before, "moving focus fetches nothing");

        await press(tv, "ArrowDown");
        assert.equal(await tv.focused(), "next", "below the grid: the pager");
        for (let page = 2; page <= 4; page++) {
            await press(tv, "Enter");
            await shows(tv, `Page ${page} of 209`);
            assert.equal(await tv.focused(), "next", "focus stays on Next while the page changes");
            assert.equal((await cardIds(tv)).length, PAGE_SIZE, "only the shown page is in the DOM");
        }
        assert.equal((await cardIds(tv))[0], "movie:m0073");
        assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).pop()?.body?.cursor, "cursor-72");
        await press(tv, "ArrowLeft", "Enter");
        await shows(tv, "Page 3 of 209");
        assert.equal((await cardIds(tv))[0], "movie:m0049");
        assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length, 5, "one request per page shown");
        assert.ok(tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).every(request => request.body?.limit === 24), "never the whole catalog");

        await press(tv, "ArrowUp");
        assert.equal(await tv.focused(), "movie:m0049", "the card focused before is not on this page: Up enters the grid at its first card");
        await press(tv, "ArrowRight", "Enter");
        await showing(tv, "item:movie:m0050");
        await press(tv, "Enter");
        await tv.page.evaluate(() => window.browseHarness.resume());
        await tv.remote(BACK);
        await showing(tv, "library:12");
        await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length === 6, "the refresh after playback");
        await shows(tv, "Page 3 of 209");
        assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).pop()?.body?.cursor, "cursor-48", "the refresh reloads the page shown, not the first");
        assert.equal(await tv.focused(), "movie:m0050", "focus returns to the card that was opened");
        await tv.remote(BACK);
        assert.equal(await tv.focused(), "movies", "Back returns to the selected type tab");
        await tv.remote(BACK);
        await showing(tv, "home");
    },
    { catalog: new FakeCatalog(5000) },
);

browseTest("details hand the player the file and resume point; returning restores focus and refreshes progress", async (tv, catalog) => {
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    assert.equal(await tv.focused(), "resume");
    await shows(tv, "Resume from 20:00");
    await press(tv, "Enter");
    assert.deepEqual(await tv.page.evaluate(() => window.browseHarness.plays), [
        { contentId: "movie:m0001", fileId: "f-movie:m0001", title: "Movie 0001", startSeconds: 1200 },
    ]);
    assert.equal(await tv.page.evaluate(() => document.querySelector<HTMLElement>(".browse")?.hidden), true, "browse hides for the player");
    await tv.remote(BACK);
    await press(tv, "ArrowRight");
    assert.equal(await tv.page.evaluate(() => window.browseHarness.lastKeyPrevented), false, "browse ignores keys while the player plays");
    assert.equal(await view(tv), "item:movie:m0001");

    catalog.progress.set("movie:m0001", 1300);
    await tv.page.evaluate(() => window.browseHarness.resume());
    await shows(tv, "Resume from 21:40");
    assert.equal(await tv.focused(), "resume", "focus returns to the button that started playback");
    await press(tv, "ArrowRight", "Enter");
    const fromStart = (await tv.page.evaluate(() => window.browseHarness.plays))[1];
    assert.equal(fromStart?.fileId, "f-movie:m0001");
    assert.equal(fromStart?.startSeconds, undefined, "Play from start");
    await tv.page.evaluate(() => window.browseHarness.resume());

    await tv.remote(BACK);
    await showing(tv, "home");
    assert.equal(await tv.focused(), "movie:m0001", "Back restores the card in its row");
});

browseTest("series open seasons, seasons list episodes, and Back retraces each step by identity", async (tv) => {
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "item:series:s1");
    await shows(tv, "Harbor Lights");
    assert.equal(await tv.focused(), "next-episode");
    await press(tv, "ArrowDown", "ArrowRight");
    assert.equal(await tv.focused(), "season:2");
    await press(tv, "Enter");
    await showing(tv, "season:series:s1:2");
    await shows(tv, "Harbor Lights · Season 2");
    assert.equal(await tv.focused(), "episode:s1e21");
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "item:episode:s1e22");
    await shows(tv, "Harbor Lights · S2:E2");
    await press(tv, "Enter");
    assert.deepEqual((await tv.page.evaluate(() => window.browseHarness.plays))[0], {
        contentId: "episode:s1e22",
        fileId: "f-episode:s1e22",
        title: "Harbor Lights chapter 2.2",
        startSeconds: undefined,
    });
    await tv.page.evaluate(() => window.browseHarness.resume());
    await tv.remote(BACK);
    await showing(tv, "season:series:s1:2");
    assert.equal(await tv.focused(), "episode:s1e22");
    await tv.remote(BACK);
    await showing(tv, "item:series:s1");
    assert.equal(await tv.focused(), "season:2");
    await tv.remote(BACK);
    await showing(tv, "home");
    assert.equal(await tv.focused(), "series:s1");
});

browseTest("typing invalidates an in-flight search before the debounce expires", async (tv) => {
    await press(tv, "ArrowUp", "ArrowRight", "ArrowRight", "ArrowRight", "Enter");
    await showing(tv, "search");
    const first = tv.fake.hold("/catalog", true);
    await tv.page.fill("#browse-search", "Movie 0001");
    await tv.remote(IME_DONE);
    await tv.eventually(async () => browseReads(tv, "/catalog").length === 1, "the first search");
    await tv.page.fill("#browse-search", "night");
    first.release();
    await tv.jump(0);
    assert.deepEqual(await cardIds(tv), [], "an obsolete answer must not render before debounce");
    assert.equal(await tv.page.inputValue("#browse-search"), "night");
    assert.equal(browseReads(tv, "/catalog").length, 1, "replacement request is still debounced");
    await tv.jump(600);
    await shows(tv, "Night Shift");
    assert.deepEqual(await cardIds(tv), ["series:s2"]);
    assert.equal(await tv.focused(), "query");
});

browseTest("search uses the TV keyboard, shows only the latest query's answer, and recovers from failures", async (tv, catalog) => {
    await press(tv, "ArrowUp", "ArrowRight", "ArrowRight", "ArrowRight", "Enter");
    await showing(tv, "search");
    assert.equal(await tv.focused(), "query");

    const first = tv.fake.hold("/catalog", true);
    await tv.page.keyboard.type("Movie 0001");
    await tv.jump(600);
    await tv.eventually(async () => browseReads(tv, "/catalog").length === 1, "the first search");
    await shows(tv, "Searching.");
    await tv.page.fill("#browse-search", "night");
    await tv.remote(IME_DONE);
    await tv.eventually(async () => browseReads(tv, "/catalog").length === 2, "the second search");
    await shows(tv, "Night Shift");
    first.release();
    await tv.jump(0);
    assert.deepEqual(await cardIds(tv), ["series:s2"], "the late answer for the older query is dropped");
    assert.match(browseReads(tv, "/catalog")[1]?.path ?? "", /q=night&type=video&limit=24/);
    assert.equal(await tv.focused(), "query", "focus stays in the field while results arrive");
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "series:s2");

    await press(tv, "ArrowUp");
    await tv.page.fill("#browse-search", "zzz");
    await tv.remote(IME_DONE);
    await shows(tv, 'No results for "zzz".');

    catalog.failNext("/catalog", problem(503, "service_unavailable", "Unavailable"), problem(503, "service_unavailable", "Unavailable"));
    await tv.page.fill("#browse-search", "movie 000");
    await tv.remote(IME_DONE);
    await tv.jump(1000);
    await shows(tv, "The server had a problem. Try again in a moment.");
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "retry");
    await press(tv, "Enter");
    await tv.eventually(async () => (await cardIds(tv)).length === 9, "results after retry");
    assert.equal(await tv.focused(), "query", "the focused retry button is gone: focus returns to the field");
});

browseTest("Back from a result reloads a query edited before its debounce could run", async (tv) => {
    await press(tv, "ArrowUp", "ArrowRight", "ArrowRight", "ArrowRight", "Enter");
    await showing(tv, "search");
    await tv.page.fill("#browse-search", "Movie 0001");
    await tv.remote(IME_DONE);
    await tv.eventually(async () => (await cardIds(tv)).join() === "movie:m0001", "the original search result");
    await tv.page.fill("#browse-search", "night");
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "item:movie:m0001");
    const held = tv.fake.hold("/catalog", true);
    await tv.remote(BACK);
    await showing(tv, "search");
    assert.equal(await tv.page.inputValue("#browse-search"), "night");
    assert.deepEqual(await cardIds(tv), [], "the old query's cards cannot be restored under the edited query");
    await tv.eventually(async () => browseReads(tv, "/catalog").length === 2, "the edited query request");
    held.release();
    await shows(tv, "Night Shift");
    assert.deepEqual(await cardIds(tv), ["series:s2"]);
});

browseTest("loading, slow, offline, removed, empty and missing-artwork states all leave a way forward", async (tv, catalog) => {
    await tv.eventually(async () => (await tv.page.locator(".browse-art-missing").count()) >= 2, "placeholders");
    const missing = await tv.page.evaluate(() => Array.from(document.querySelectorAll(".browse-art-missing")).map((node) => node.parentElement?.getAttribute("data-focus")));
    assert.ok(missing.indexOf("movie:m0002") !== -1 && missing.indexOf("movie:m0003") !== -1, "no artwork and failed artwork both show the title");

    const hold = tv.fake.hold("/catalog/items/movie%3Am0001");
    await activateDetails(tv);
    await showing(tv, "item:loading");
    assert.equal(await tv.focused(), "back");
    await tv.jump(5000);
    await shows(tv, "Still waiting for the server.");
    await press(tv, "Enter");
    await showing(tv, "home");
    hold.release();
    await tv.jump(0);
    assert.equal(await view(tv), "home", "the abandoned answer does not open the page");
    assert.equal(await tv.focused(), "movie:m0001");

    tv.offline = true;
    await activateDetails(tv);
    await tv.jump(1000);
    await shows(tv, "Could not reach the server. Check the connection and try again.");
    assert.equal(await tv.focused(), "retry");
    tv.offline = false;
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await tv.remote(BACK);

    catalog.removed.add("movie:m0001");
    await activateDetails(tv);
    await shows(tv, "This title is no longer available.");
    await press(tv, "ArrowRight", "Enter");
    await showing(tv, "home");

    const owner = catalog.households.get("p-owner");
    owner?.libraries.push({ id: "17", name: "New Shelf", type: "movies", sort_order: 9 });
    await tv.page.evaluate(() => {
        window.browseHarness.destroy();
        window.browseHarness.mount();
    });
    await showing(tv, "home");
    await press(tv, "ArrowUp", "ArrowRight");
    await tv.jump(250);
    await press(tv, "ArrowDown", "ArrowDown", "Enter");
    await showing(tv, "library:17");
    await shows(tv, "No titles");
    assert.equal(await tv.focused(), "mode:Browse", "empty scope retains its destinations");
});

browseTest("an authority change removes only browse, aborts its reads, and the next profile sees only its own catalog", async (tv) => {
    const held = tv.fake.hold("/library/12/sections", true);
    await press(tv, "ArrowUp", "ArrowRight", "Enter");
    await showing(tv, "library:loading");
    await tv.page.evaluate(() => window.browseHarness.clearProfile());
    held.release();
    await tv.jump(0);
    assert.equal(await tv.page.locator(".browse").count(), 0, "browse removed itself");
    assert.equal(await tv.page.locator("#successor").count(), 1, "the profile screen it left in the root is untouched");
    assert.equal(await tv.page.locator("img").count(), 0, "no artwork of the old profile remains");

    assert.equal(await tv.page.evaluate(() => window.browseHarness.selectProfile("p-kid", "2468")), "verified");
    await tv.page.evaluate(() => window.browseHarness.mount());
    await showing(tv, "home");
    assert.deepEqual(await cardIds(tv, ".browse-nav .browse-button"), ["home", "movies", "search", "profiles", "calendar"]);
    const kidReads = browseReads(tv).filter((read) => read.headers["x-profile-id"] === "p-kid");
    assert.ok(kidReads.length >= 3 && kidReads.every((read) => read.headers["x-profile-token"]?.startsWith("pvt-")));

    await press(tv, "ArrowUp", "ArrowRight", "ArrowRight", "Enter");
    await tv.page.fill("#browse-search", "movie");
    await tv.remote(IME_DONE);
    await shows(tv, 'No results for "movie".');
    await tv.remote(BACK);
    await showing(tv, "home");

    await press(tv, "ArrowRight", "Enter");
    await press(tv, "ArrowDown", "Enter");
    assert.deepEqual(await tv.page.evaluate(() => window.browseHarness.chooseProfileCalls), [false], "browse was gone before onChooseProfile ran");
    assert.equal(await tv.page.locator(".browse").count(), 0);
}, { profile: "p-owner" });
