import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { launchBrowser, openTv, readLive, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const YOUTUBE = { kind: "trailer", site: "YouTube", site_key: "abc_def-1", name: "Official Trailer", is_official: true };

for (const personId of ['7', undefined]) trailerTest(`duplicate cast focus survives trailer refresh reordering with person id ${personId}`, async (tv, catalog) => {
    const body = catalog.route('GET', '/catalog/items/movie%3Am0001', 'p-owner')?.body as Record<string, unknown>;
    const credits = [
        { person_id: personId, name: 'Same actor', character: 'First role', order: 0 },
        { person_id: 'other', name: 'Other actor', character: 'Other role', order: 1 },
        { person_id: personId, name: 'Same actor', character: 'Second role', order: 2 },
        { person_id: personId, name: 'Same actor', character: 'Second role', order: 3 },
    ];
    let refreshed = false;
    await tv.page.route('**/api/v2/catalog/items/movie%3Am0001/trailers/refresh', route => { refreshed = true; return route.fulfill({ status: 202, json: { status: 'queued' } }); });
    await tv.page.route('**/api/v2/catalog/items/movie%3Am0001?**', route => route.fulfill({ json: { ...body, cast: refreshed ? [credits[2], credits[3], credits[1], credits[0]] : credits, videos: refreshed ? [YOUTUBE] : [] } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.locator('[data-focus="find-trailers"]').click();
    const duplicate = tv.page.locator('.details-people [data-focus]').nth(3);
    await duplicate.focus();
    const key = await tv.focused();
    await tv.jump(3000);
    await tv.page.locator('.details-extras').waitFor();
    assert.equal(await tv.focused(), key);
    assert.equal(await tv.page.locator('.details-people [data-focus]').nth(1).getAttribute('data-focus'), key, 'second occurrence keeps its identity after reorder');
    assert.equal(await tv.page.locator(':focus .browse-card-subtitle').textContent(), 'Second role');
});


trailerTest("singleton cast focus stays put when a duplicate credit appears", async (tv, catalog) => {
    const body = catalog.route("GET", "/catalog/items/movie%3Am0001", "p-owner")?.body as Record<string, unknown>;
    const solo = [{ person_id: "7", name: "Same actor", character: "Only role", order: 0 }];
    const withDuplicate = [
        { person_id: "7", name: "Same actor", character: "Only role", order: 0 },
        { person_id: "7", name: "Same actor", character: "Extra role", order: 1 },
    ];
    let refreshed = false;
    await tv.page.route("**/api/v2/catalog/items/movie%3Am0001/trailers/refresh", route => { refreshed = true; return route.fulfill({ status: 202, json: { status: "queued" } }); });
    await tv.page.route("**/api/v2/catalog/items/movie%3Am0001?**", route => route.fulfill({ json: { ...body, cast: refreshed ? withDuplicate : solo, videos: refreshed ? [YOUTUBE] : [] } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.locator('[data-focus="find-trailers"]').click();
    await tv.page.locator(".details-people [data-focus]").first().focus();
    const key = await tv.focused();
    assert.match(key ?? "", /^credit:/, "singleton cast already uses the stable credit key");
    await tv.jump(3000);
    await tv.page.locator(".details-extras").waitFor();
    assert.equal(await tv.focused(), key, "adding another role must not rename the focused credit");
    assert.equal(await tv.page.locator(".details-people [data-focus]").count(), 2);
});

trailerTest("discovered trailers survive a late watched season readback", async (tv, catalog) => {
    const body = catalog.route("GET", "/catalog/items/series%3As1", "p-owner")?.body as Record<string, unknown>;
    let found = false;
    let holdEpisodes = false;
    let releaseEpisodes: (() => void) | undefined;
    let heldEpisodes = false;
    await tv.page.route("**/api/v2/catalog/items/series%3As1/trailers/refresh", route => route.fulfill({ status: 202, json: { status: "queued" } }));
    await tv.page.route("**/api/v2/catalog/items/series%3As1?**", route => route.fulfill({
        json: { ...body, user_data: { played: catalog.watched }, videos: found ? [YOUTUBE] : [] },
    }));
    await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons/*/episodes?**", async route => {
        if (holdEpisodes) {
            heldEpisodes = true;
            await new Promise<void>(resolve => { releaseEpisodes = resolve; });
        }
        return route.fallback();
    });
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.locator('[data-focus="find-trailers"]').click();
    await tv.page.locator(".details-trailer-status").waitFor();
    holdEpisodes = true;
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.locator('[data-focus="watched"]').click();
    await tv.eventually(async () => heldEpisodes, "watched readback awaits season episodes");
    found = true;
    await tv.jump(3000);
    await tv.eventually(async () => await tv.page.locator('[data-focus="remote:YouTube:abc_def-1"]').count() === 1, "discovery publishes while watched readback is held");
    holdEpisodes = false;
    releaseEpisodes?.();
    await tv.jump(0);
    // This fixture's series readback never confirms the watched write; its Couldn't Update Item alert covers the rail.
    const alert = tv.page.getByRole("alertdialog", { name: "Couldn't Update Item", exact: true });
    await alert.waitFor();
    await alert.getByRole("button", { name: "OK", exact: true }).click();
    await alert.waitFor({ state: "detached" });
    assert.equal(await tv.page.locator('[data-focus="remote:YouTube:abc_def-1"]').count(), 1, "late watched assignment must not wipe discovered trailers");
});

for (const path of ['playback', 'watched then navigate']) trailerTest(`interrupted trailer discovery survives ${path} owner replacement`, async (tv, catalog) => {
    const body = catalog.route('GET', '/catalog/items/movie%3Am0001', 'p-owner')?.body as Record<string, unknown>;
    let posts = 0; let found = false; let reads = 0;
    let holdWatchRead = path !== 'playback'; let heldWatchRead = false;
    const watchWaiters: Array<() => void> = [];
    await tv.page.route('**/api/v2/catalog/items/movie%3Am0001/trailers/refresh', route => { posts++; return route.fulfill({ status: 202, json: { status: 'queued' } }); });
    await tv.page.route('**/api/v2/catalog/items/movie%3Am0001?**', async route => {
        reads++;
        if (holdWatchRead && catalog.watched) {
            heldWatchRead = true;
            await new Promise<void>(resolve => watchWaiters.push(resolve));
        }
        return route.fulfill({ json: { ...body, user_data: { played: catalog.watched }, videos: found ? [YOUTUBE] : [] } });
    });
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.locator('[data-focus="find-trailers"]').click();
    await tv.page.locator('.details-trailer-status').waitFor();
    const before = reads;
    if (path === 'playback') {
        await tv.page.locator('[data-focus="play"][aria-disabled="false"]').click();
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.plays.length === 1), 'playback entered');
        await tv.jump(150000);
        await tv.page.evaluate(() => window.browseHarness.resume());
    } else {
        await tv.page.locator('[data-focus="more"]').click();
        await tv.page.locator('[data-focus="watched"]').click();
        await tv.eventually(async () => heldWatchRead, 'watched write committed before its readback');
        await tv.page.locator('.details-people [data-focus^="credit:"]').first().click();
        await tv.page.locator('[data-view^="person:"]').waitFor();
        await tv.jump(150000);
        holdWatchRead = false;
        for (const release of watchWaiters.splice(0)) release();
        await tv.remote(10009);
    }
    await tv.eventually(async () => reads > before && await tv.page.locator('[data-focus="more"]').count() === 1, 'Details reloaded');
    assert.equal(await tv.page.locator('.details-extras').count(), 0, 'return read precedes trailer arrival');
    found = true;
    await tv.jump(3000);
    await tv.eventually(async () => await tv.page.locator('[data-focus="remote:YouTube:abc_def-1"]').count() === 1, 'trailer arriving after return is published');
    assert.equal(posts, 1);
    if (path !== 'playback') assert.equal(catalog.watched, true);
});

function trailerTest(name: string, body: (tv: Tv, catalog: FakeDetails) => Promise<void>): void {
    test(name, async () => {
        const tv = await openTv(browser, { app: "browse" });
        const catalog = new FakeDetails();
        tv.fake.catalog = catalog;
        try {
            await tv.page.evaluate(() => window.browseHarness.connect());
            await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
            tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
            await tv.jump(5000);
            await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
            await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
            await tv.page.evaluate(() => window.browseHarness.mount());
            await body(tv, catalog);
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}

trailerTest("a movie with only a YouTube video shows Trailers & More and leaves playback alone", async (tv, catalog) => {
    catalog.videos = [YOUTUBE, { kind: "trailer", site: "vimeo", site_key: "v1", is_official: false }];
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator(".details-extras").waitFor();
    assert.deepEqual(await tv.page.locator(".details-extras [data-focus]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus"))), ["remote:YouTube:abc_def-1"]);
    // The section after the row can paint later, and the caption gap is measured to it.
    await tv.page.locator(".details-extras + *").waitFor();
    const metrics = await readLive(tv, () => {
        const row = document.querySelector(".details-extras");
        const card = row?.querySelector(".details-extra");
        const still = card?.querySelector(".browse-still");
        const title = card?.querySelector(".browse-card-title");
        const caption = card?.querySelector(".browse-card-subtitle");
        const next = row?.nextElementSibling;
        const badge = card?.querySelector(".details-extra-play");
        if (!(row instanceof HTMLElement) || !(card instanceof HTMLElement) || !(still instanceof HTMLElement) || !(title instanceof HTMLElement) || !(caption instanceof HTMLElement) || next === null || next === undefined || !(badge instanceof HTMLElement)) return null;
        if (![row, card, still, title, caption, next, badge].every(node => node.isConnected)) return null;
        const stillBox = still.getBoundingClientRect();
        const titleStyle = getComputedStyle(title);
        const captionStyle = getComputedStyle(caption);
        return {
            gap: next.getBoundingClientRect().top - caption.getBoundingClientRect().bottom,
            stillWidth: stillBox.width,
            stillHeight: stillBox.height,
            radius: getComputedStyle(still).borderRadius,
            titleGap: title.getBoundingClientRect().top - stillBox.bottom,
            captionGap: caption.getBoundingClientRect().top - title.getBoundingClientRect().bottom,
            titleSize: titleStyle.fontSize,
            titleWeight: titleStyle.fontWeight,
            titleColor: titleStyle.color,
            captionSize: captionStyle.fontSize,
            captionWeight: captionStyle.fontWeight,
            captionColor: captionStyle.color,
            titleText: title.textContent,
            captionText: caption.textContent,
            badge: badge.getBoundingClientRect().width,
        };
    }, null, value => value.titleText === "Official Trailer" && value.captionText === "YouTube" && Math.abs(value.gap - 76) < 1 && Math.abs(value.stillWidth - 470) < 1 && Math.abs(value.stillHeight - 264) < 1 && value.radius === "18px" && Math.abs(value.titleGap - 14) < 1 && Math.abs(value.captionGap - 5) < 1 && value.titleSize === "20.3385px" && value.titleWeight === "600" && value.titleColor === "rgba(237, 237, 237, 0.92)" && value.captionSize === "16.4645px" && value.captionWeight === "500" && value.captionColor === "rgba(237, 237, 237, 0.6)" && value.badge === 60, "trailer card geometry");
    assert.equal(metrics.titleText, "Official Trailer");
    assert.equal(metrics.captionText, "YouTube");
    assert.ok(Math.abs(metrics.gap - 76) < 1, JSON.stringify(metrics));
    assert.ok(Math.abs(metrics.stillWidth - 470) < 1, JSON.stringify(metrics));
    assert.ok(Math.abs(metrics.stillHeight - 264) < 1, JSON.stringify(metrics));
    assert.equal(metrics.radius, "18px");
    assert.ok(Math.abs(metrics.titleGap - 14) < 1, JSON.stringify(metrics));
    assert.ok(Math.abs(metrics.captionGap - 5) < 1, JSON.stringify(metrics));
    assert.equal(metrics.titleSize, "20.3385px");
    assert.equal(metrics.titleWeight, "600");
    assert.equal(metrics.titleColor, "rgba(237, 237, 237, 0.92)");
    assert.equal(metrics.captionSize, "16.4645px");
    assert.equal(metrics.captionWeight, "500");
    assert.equal(metrics.captionColor, "rgba(237, 237, 237, 0.6)");
    assert.equal(metrics.badge, 60);
    const before = tv.fake.requests.length;
    await tv.page.locator(".details-people [data-focus]").first().focus();
    await tv.remote(40);
    assert.equal(await tv.focused(), "remote:YouTube:abc_def-1");
    assert.equal(tv.fake.requests.length, before, "moving onto the rail must not fetch");
    await tv.page.locator('[data-focus="remote:YouTube:abc_def-1"]').click();
    assert.equal(await tv.focused(), "remote:YouTube:abc_def-1");
    assert.equal(tv.fake.requests.filter(request => request.path.includes("/playback/") || request.path.includes("/versions")).length, 0);
    assert.equal(await readLive(tv, () => {
        const node = document.querySelector(".details-extra:focus .browse-still");
        if (node === null || !node.isConnected) return null;
        return getComputedStyle(node).transform;
    }, null, value => value === "none", "focused trailer still"), "none");
});

trailerTest("a series with a YouTube video shows the rail and hides it when the list is empty", async (tv, catalog) => {
    catalog.videos = [YOUTUBE];
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator(".details-extras").waitFor();
    assert.equal(await tv.page.getByRole("heading", { name: "Trailers & More", exact: true }).count(), 1);
    catalog.videos = [];
    await tv.remote(10009);
    const fresh = tv.fake.hold("/catalog/items/series%3As1", true);
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="next-episode"]').waitFor();
    assert.equal(await tv.page.locator(".details-extras").count(), 1, "the cached rail remains while the fresh read is pending");
    fresh.release();
    await tv.eventually(async () => await tv.page.locator(".details-extras").count() === 0, "fresh empty videos remove the cached rail");
    assert.equal(await tv.page.locator(".details-extras").count(), 0);
});

trailerTest("local extras stay ahead of YouTube cards and keep a 48px gap", async (tv, catalog) => {
    catalog.extras = [{ content_id: "extra:1", file_id: 42, kind: "featurette", title: "Making Of", duration_seconds: 90, still_url: "/art/extra.svg" }];
    catalog.videos = [YOUTUBE];
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator(".details-extras").waitFor();
    const cards = await tv.page.locator(".details-extra").evaluateAll(nodes => nodes.map(node => ({
        key: node.getAttribute("data-focus"),
        caption: node.querySelector(".browse-card-subtitle")?.textContent,
    })));
    assert.deepEqual(cards, [
        { key: "extra:extra:1", caption: "1:30" },
        { key: "remote:YouTube:abc_def-1", caption: "YouTube" },
    ]);
    // A Details repaint can replace the row between resolving a locator and reading it, and a detached row measures 0.
    const gap = await readLive(tv, () => {
        const cards = [...document.querySelectorAll(".details-extras .details-extra")];
        const first = cards[0];
        const second = cards[1];
        if (first === undefined || second === undefined || !first.isConnected || !second.isConnected) return null;
        return second.getBoundingClientRect().left - first.getBoundingClientRect().right;
    }, null, value => Math.abs(value - 48) < 1, "trailer card gap");
    assert.ok(Math.abs(gap - 48) < 1, String(gap));
});

trailerTest("down from cast always enters Trailers & More on the first card", async (tv, catalog) => {
    catalog.extras = [{ content_id: "extra:1", file_id: 42, kind: "featurette", title: "Making Of", duration_seconds: 90, still_url: "/art/extra.svg" }];
    catalog.videos = [YOUTUBE];
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator(".details-extras").waitFor();
    await tv.page.locator(".details-related-placeholder").first().waitFor({ state: "hidden" });
    const firstCast = await tv.page.locator(".details-people [data-focus]").first().getAttribute("data-focus");
    await tv.page.locator(".details-people [data-focus]").first().focus();
    await tv.remote(40);
    assert.equal(await tv.focused(), "extra:extra:1");
    await tv.remote(39);
    assert.equal(await tv.focused(), "remote:YouTube:abc_def-1");
    await tv.remote(38);
    assert.equal(await tv.focused(), firstCast);
    await tv.remote(40);
    assert.equal(await tv.focused(), "extra:extra:1");
});
