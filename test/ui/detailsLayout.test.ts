import assert from "node:assert/strict";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { CARD_PRESENTATION_KEY, CARD_OVERLAYS_KEY } from "../../src/contracts/v2/settings.ts";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { homeDetailsRead, launchBrowser, openTv, pauseTvClock, readLive, type Tv } from "./support/tv.ts";

detailTest("cached series Play retains its episode label offline", async tv => {
    const card = tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first();
    await card.click();
    const primary = tv.page.locator('[data-focus="next-episode"]');
    await tv.eventually(async () => /^Play S/.test(await primary.innerText()), "episode ready");
    const label = await primary.innerText();
    await tv.remote(10009);
    await tv.page.route("**/api/v2/**", route => route.abort("connectionrefused"));
    await card.click();
    await tv.jump(35000);
    assert.equal(await primary.innerText(), label);
    assert.equal(await primary.getAttribute("aria-disabled"), "false");
    const before = await tv.page.evaluate(() => window.browseHarness.plays.length);
    await primary.click();
    await tv.jump(35000);
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.plays.length) === before + 1, "cached episode reaches the ordinary playback handoff");
});

function ratingChipFrame(): { media: string; text: string; font: boolean; lineHeight: string; rowTop: number; rowBottom: number; rowHeight: number; chipTop: number; chipBottom: number; chipHeight: number; textTop: number; textBottom: number; heroRowTop: number; belowTop: number; logoReady: boolean; titleHeight: number; stack: number[] } | null {
    const row = document.querySelector(".details-editorial .browse-meta");
    const chip = row?.querySelector(".details-rating-badge:not([data-advisory-age])");
    const hero = row?.closest(".details-hero");
    const title = hero?.querySelector(".browse-title");
    const logo = title?.querySelector(".details-logo");
    if (!(row instanceof HTMLElement) || !(chip instanceof HTMLElement) || !(hero instanceof HTMLElement) || !(title instanceof HTMLElement) || !row.isConnected || !chip.isConnected || !title.isConnected) return null;
    const rowBox = row.getBoundingClientRect();
    const chipBox = chip.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(chip);
    const textBox = range.getBoundingClientRect();
    const heroTop = hero.getBoundingClientRect().top;
    const below = row.nextElementSibling;
    return {
        media: hero.dataset.mediaType ?? "",
        text: chip.textContent ?? "",
        font: document.fonts.check("700 18px Inter"),
        lineHeight: getComputedStyle(chip).lineHeight,
        rowTop: rowBox.top,
        rowBottom: rowBox.bottom,
        rowHeight: rowBox.height,
        chipTop: chipBox.top,
        chipBottom: chipBox.bottom,
        chipHeight: chipBox.height,
        textTop: textBox.top,
        textBottom: textBox.bottom,
        heroRowTop: rowBox.top - heroTop,
        belowTop: below instanceof HTMLElement ? below.getBoundingClientRect().top - heroTop : Number.NaN,
        logoReady: logo instanceof HTMLImageElement && logo.isConnected && logo.complete && logo.naturalWidth > 0,
        titleHeight: title.getBoundingClientRect().height,
        stack: [".browse-meta", ".browse-overview", ".details-director", ".details-playback-summary", ".browse-actions"].map(selector => {
            const node = document.querySelector(`.details-editorial ${selector}`);
            return node instanceof HTMLElement ? node.getBoundingClientRect().top - heroTop : Number.NaN;
        }),
    };
}

function liveRail(_arg: null): { left: number; width: number; scroll: number; padding: string; cards: { x: number; frameX: number; right: number; width: number }[] } | null {
    const row = document.querySelector(".details-episodes");
    if (!(row instanceof HTMLElement) || !row.isConnected) return null;
    return {
        left: row.getBoundingClientRect().left,
        width: row.clientWidth,
        scroll: row.scrollLeft,
        padding: getComputedStyle(row).paddingLeft,
        cards: [...row.querySelectorAll(".browse-art")].map(node => {
            const art = node.getBoundingClientRect();
            const frame = node.parentElement?.getBoundingClientRect();
            return { x: art.x, frameX: frame?.x ?? Number.NaN, right: art.right, width: art.width };
        }),
    };
}

detailTest("season Details automatically recovers an offline next episode", async tv => {
    await pauseTvClock(tv);
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="series:s1-S1"]').waitFor();
    let failures = 0;
    tv.page.on("requestfailed", request => { if (request.url().includes("/catalog/items/episode%3A")) failures++; });
    await tv.page.route("**/api/v2/catalog/items/episode%3A*", route => route.abort("connectionrefused"));
    await tv.page.locator('[data-focus="series:s1-S1"]').click();
    const primary = tv.page.locator('[data-focus="next-episode"]');
    await tv.eventually(async () => failures >= 1, "first episode transport failure");
    await tv.jump(1000);
    await tv.eventually(async () => failures >= 2, "episode transport retry exhausted");
    await tv.jump(0);
    await tv.eventually(async () => await primary.getAttribute("aria-disabled") === "true", "episode read failed offline");
    let seasonFailures = 0;
    tv.page.on("requestfailed", request => { if (request.url().includes("/seasons/1/episodes")) seasonFailures++; });
    await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons/1/episodes?**", route => route.abort("connectionrefused"));
    await tv.jump(15000);
    await tv.eventually(async () => seasonFailures >= 1, "automatic recovery attempted while still offline");
    await tv.jump(1000);
    await tv.eventually(async () => seasonFailures >= 2, "automatic recovery exhausted transport retry");
    await tv.jump(0);
    const beforeRetry = failures;
    await primary.dispatchEvent("click");
    await tv.eventually(async () => failures > beforeRetry, "visible episode owner remains active after failed recovery");
    await tv.jump(1000);
    await tv.eventually(async () => failures >= beforeRetry + 2, "manual episode transport retry exhausted");
    await tv.jump(0);
    const catalog = tv.fake.catalog;
    assert.ok(catalog instanceof FakeDetails);
    catalog.mutationFailure = problem(422, "validation_failed", "Unavailable action");
    await tv.page.locator('[data-focus="more"]').click();
    const panel = tv.page.getByRole("dialog", { name: "More", exact: true });
    await panel.locator('[data-focus="watched"]').click();
    await tv.page.locator('[data-focus="more"]').click();
    await panel.getByRole("button", { name: "Retry watched", exact: true }).waitFor();
    await tv.remote(10009);
    const mutations = [...catalog.mutations];
    await tv.page.unroute("**/api/v2/catalog/items/episode%3A*");
    await tv.page.unroute("**/api/v2/catalog/series/series%3As1/seasons/1/episodes?**");
    await tv.jump(15000);
    await tv.eventually(async () => await primary.getAttribute("aria-disabled") === "false", "season next episode recovered automatically");
    assert.match(await primary.innerText(), /Play S1:E1/);
    await tv.page.locator('[data-focus="more"]').click();
    await panel.getByRole("button", { name: "Retry watched", exact: true }).waitFor({ timeout: 1500 });
    assert.deepEqual(catalog.mutations, mutations, "automatic recovery never resends the failed write");
});

detailTest("stale season return restarts its personal action owner", async tv => {
    const catalog = tv.fake.catalog;
    assert.ok(catalog instanceof FakeDetails);
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="series:s1-S1"]').click();
    await tv.page.locator('[data-focus="episode:s1e12"]').click({ button: "right" });
    await tv.page.locator('[data-focus="episode-information"]').click();
    catalog.mutationFailure = problem(422, "validation_failed", "Unavailable action");
    const panel = tv.page.getByRole("dialog", { name: "More", exact: true });
    await tv.page.locator('[data-focus="more"]').click();
    await panel.locator('[data-focus="watched"]').click();
    await tv.page.locator('[data-focus="more"]').click();
    await panel.getByRole("button", { name: "Retry watched", exact: true }).waitFor();
    await tv.remote(10009);
    await tv.remote(10009);
    await tv.page.locator('.browse-episodes').waitFor();
    await tv.eventually(async () => /^Play S/.test(await tv.page.locator('[data-focus="next-episode"]').innerText()), "stale season refreshed");
    const before = catalog.mutations.length;
    await tv.page.locator('[data-focus="more"]').click();
    await panel.locator('[data-focus="watched"]').click();
    await tv.eventually(async () => catalog.mutations.length > before, "returned season action dispatched");
});

function liveScroll(_arg: null): number | null {
    const row = document.querySelector(".details-episodes");
    if (!(row instanceof HTMLElement) || !row.isConnected) return null;
    return row.scrollLeft;
}

detailTest("focused episode hero loads full versions after Apple's dwell and reuses them", async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    let detailReads = 0;
    for (const id of ['episode:s1e12', 'episode:s1e21']) {
        const reply = catalog.route('GET', `/catalog/items/${encodeURIComponent(id)}`, 'p-owner');
        const body = reply?.body as Record<string, unknown>;
        await tv.page.route(`**/api/v2/catalog/items/${encodeURIComponent(id)}?**`, route => { detailReads++; return route.fulfill({ json: {
            ...body, runtime: 11, versions: [{ file_id: `f-${id}`, duration: 1440, resolution: '1080p', audio_tracks: [], subtitle_tracks: [] }],
        } }); });
    }
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await settledEpisodePrefetch(tv);
    await pauseTvClock(tv);
    const reads = (): number => detailReads;
    const before = reads();
    await tv.page.locator('[data-focus="episode:s1e12"]').focus();
    await tv.jump(119);
    assert.equal(reads(), before, 'no request before 120ms');
    await tv.jump(1);
    await tv.eventually(async () => (await tv.page.locator('.details-editorial .details-fact').allTextContents()).includes('24m'), 'full episode duration');
    assert.deepEqual(await tv.page.locator('.details-playback-summary strong').allTextContents(), ['VERSION', 'AUDIO', 'SUBTITLES']);
    assert.deepEqual(await tv.page.locator('.details-playback-summary span').allTextContents(), ['Auto · 1080p', 'Auto · Unknown', 'Auto · None']);
    assert.equal(reads(), before + 1, 'one detail read for the settled episode');
    await settledEpisodePrefetch(tv);
    const loaded = reads();
    await tv.page.locator('[data-focus="episode:s1e11"]').focus();
    await tv.page.locator('[data-focus="episode:s1e12"]').focus();
    await tv.jump(200);
    assert.equal(reads(), loaded, 'cached focus never rereads');
    await tv.page.locator('[data-focus="episode:s1e21"]').focus();
    await tv.jump(119);
    await tv.page.locator('[data-focus="episode:s1e12"]').focus();
    await tv.jump(200);
    assert.equal(reads(), loaded, 'leaving before dwell cancels the read');
    await tv.page.locator('[data-focus="episode:s1e21"]').focus();
    await tv.jump(119);
    await tv.page.locator('[data-focus="more"]').focus();
    await tv.jump(200);
    assert.equal(reads(), loaded, 'leaving the rail for hero controls cancels the read');
    await tv.page.locator('[data-focus="season:2"]').click();
    await tv.page.locator('[data-focus="episode:s1e21"][aria-current="true"]').waitFor();
    await tv.page.locator('[data-focus="episode:s1e21"]').focus();
    await tv.jump(120);
    await tv.eventually(async () => (await tv.page.locator('.details-editorial .details-fact').allTextContents()).includes('24m'), 'neighbour full duration');
    assert.deepEqual(await tv.page.locator('.details-playback-summary strong').allTextContents(), ['VERSION', 'AUDIO', 'SUBTITLES']);
    assert.deepEqual(await tv.page.locator('.details-playback-summary span').allTextContents(), ['Auto · 1080p', 'Auto · Unknown', 'Auto · None']);
    assert.equal(reads(), before + 2, 'one detail read for each settled episode across seasons');
});

/** Season acceptance reads the playback episode, not every painted card. Count focus only after those replies, and every read they start, have finished. */
async function settledEpisodePrefetch(tv: Tv): Promise<void> {
    let stable = -1;
    await tv.eventually(async () => {
        const ids = await tv.page.locator('.details-episodes [data-focus^="episode:"]').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus") ?? ""));
        const count = tv.fake.requests.length;
        if (ids.length === 0 || tv.pendingReplies !== 0) {
            stable = -1;
            return false;
        }
        // Same count on the next turn: a delivered reply did not record another read.
        if (stable !== count) {
            stable = count;
            return false;
        }
        return true;
    }, "opening episode prefetches settled");
}

for (const media of ['movie:m0001', 'series:s1']) detailTest(`${media} hero Up restores every last action and More return`, async tv => {
    await tv.page.locator(`[data-section="recently_added"] [data-focus="${media}"]`).first().click();
    await tv.page.locator('[data-focus="version"][aria-disabled="false"]').waitFor();
    const primary = media.startsWith('movie') ? 'resume' : 'next-episode';
    const below = media.startsWith('movie') ? '.details-people [data-focus]' : '[data-focus="season:1"]';
    const keys = [primary, ...(media.startsWith('movie') ? ['play'] : []), 'version', 'audio', 'subtitles', 'watchlist', 'more'];
    for (const key of keys) {
        await tv.page.locator(`.browse-actions [data-focus="${key}"]`).focus();
        if (key === 'more') {
            await tv.page.keyboard.press('Enter');
            await tv.page.getByRole('dialog', { name: 'More', exact: true }).waitFor();
            await tv.remote(10009);
            assert.equal(await tv.focused(), 'more');
        }
        await tv.remote(40);
        await tv.page.locator(below).first().waitFor();
        assert.notEqual(await tv.focused(), key);
        await tv.remote(38);
        assert.equal(await tv.focused(), key, `return to ${key}`);
        const visible = await readLive(tv, () => {
            const node = document.activeElement;
            if (!(node instanceof HTMLElement) || !node.isConnected) return null;
            const box = node.getBoundingClientRect();
            return { key: node.dataset.focus, top: box.top, bottom: box.bottom };
        }, null, value => value.key === key && value.top >= 0 && value.bottom <= 1080, 'returned hero action is visible');
        assert.equal(visible.key, key);
        await tv.remote(38);
        assert.equal(await tv.focused(), key, 'Up at the hero boundary stays on the action');
    }
});

detailTest('hero Up falls back from vanished Start Over and disabled selectors to Play then Watchlist', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const body = catalog.route('GET', '/catalog/items/episode%3As1e11', 'p-owner')?.body as Record<string, unknown>;
    await tv.page.route('**/api/v2/catalog/items/episode%3As1e11?**', route => route.fulfill({ json: { ...body, user_data: { played: false, position_seconds: 120 } } }));
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons/2/episodes?**', route => route.fulfill({ json: { items: [] } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="start-over-episode"]').focus();
    await tv.remote(40);
    await tv.remote(38);
    assert.equal(await tv.focused(), 'start-over-episode');
    await tv.page.locator('[data-focus="episode:s1e12"]').focus();
    await tv.page.locator('[data-focus="start-over-episode"]').waitFor({ state: 'hidden' });
    await tv.page.locator('.details-playback-summary').waitFor();
    await settledEpisodePrefetch(tv);
    await pauseTvClock(tv);
    await tv.remote(38);
    await tv.remote(38);
    assert.equal(await tv.focused(), 'next-episode');
    for (const key of ['version', 'audio', 'subtitles']) {
        await tv.page.locator(`[data-focus="${key}"]`).focus();
        // A mounted selector can become unavailable while episode details load.
        await tv.page.locator(`[data-focus="${key}"]`).evaluate(node => node.setAttribute('aria-disabled', 'true'));
        await tv.remote(40);
        await tv.remote(38);
        assert.equal(await tv.focused(), 'next-episode', `${key} falls back to Play`);
    }
    await tv.page.locator('[data-focus="season:2"]').click();
    await tv.page.locator('[data-focus="next-episode"]').waitFor({ state: 'hidden' });
    await tv.remote(38);
    assert.equal(await tv.focused(), 'watchlist', 'no Play falls back to Watchlist');
});

for (const season of [1, 2, 30]) detailTest(`fresh season ${season} has no retained-reopen offset`, async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog);
    const seasons = catalog.route('GET', '/catalog/series/series%3As1/seasons', 'p-owner')?.body as { items: Record<string, unknown>[] };
    const episodes = catalog.route('GET', '/catalog/series/series%3As1/seasons/1/episodes', 'p-owner')?.body as { items: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons?**', route => route.fulfill({ json: { items: [season - 1, season].filter(number => number > 0).map(number => ({ ...seasons.items[0], content_id: `season:${number}`, season_number: number, title: `Season ${number}`, episode_count: 5, user_data: { played: number < season } })) } }));
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons/*/episodes?**', route => {
        const number = Number(new URL(route.request().url()).pathname.split('/').at(-2));
        return route.fulfill({ json: { items: Array.from({ length: 5 }, (_, index) => ({ ...episodes.items[0], content_id: `episode:geometry:${number}:${index}`, season_number: number, episode_number: index + 1 })) } });
    });
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator(`[data-focus="episode:geometry:${season}:4"]`).waitFor();
    await tv.page.locator(`[data-focus="season:${season}"]`).focus(); await tv.jump(500);
    const frame = await readLive(tv, liveRail, null, value => {
        const card = value.cards.at(-5);
        return card !== undefined && Math.abs(card.x - 109.7) <= 2 && Math.abs(value.cards.at(-1)!.right - 1818) <= 2;
    }, 'fresh first and final card geometry');
    assert.ok(Math.abs(frame.cards.at(-5)!.x - 109.7) <= 2, JSON.stringify(frame));
    assert.ok(Math.abs(frame.cards.at(-1)!.right - 1818) <= 2, JSON.stringify(frame));
    const pill = await readLive(tv, () => {
        const node = document.querySelector('.details-season-chips [aria-pressed="true"]');
        if (!(node instanceof HTMLElement)) return null;
        const style = getComputedStyle(node);
        return { padding: style.paddingLeft, gap: style.marginRight, weight: style.fontWeight };
    }, null, value => value.padding === '24px' && value.gap === '12px' && value.weight === '600', 'Swift pill padding gap and selected weight');
    assert.equal(pill.weight, '600');
}, 'compact');

detailTest('loaded season hero uses cached values or omits unavailable playback details without reads', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-track-summary="version"] span').waitFor();
    const original = await tv.page.locator('.details-playback-summary').textContent();
    const reads = tv.fake.requests.length;
    for (const season of [2, 1]) {
        await tv.page.locator(`[data-focus="season:${season}"]`).focus(); await tv.jump(3100);
        assert.equal(await tv.page.locator('.details-playback-summary span:empty').count(), 0);
    }
    assert.equal(tv.fake.requests.length, reads);
    assert.equal(await tv.page.locator('.details-playback-summary').textContent(), original);
});

detailTest('an empty selected season cannot play the series fallback episode', async tv => {
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons/2/episodes?**', route => route.fulfill({ json: { items: [] } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="season:2"]').focus(); await tv.jump(500);
    await tv.page.locator('[data-focus="season:2"][aria-pressed="true"]').waitFor();
    assert.equal(await tv.page.locator('[data-focus="next-episode"]').count(), 0);
    assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 0);
});

detailTest("reopening a series card keeps its season and returns to series text on Play", async tv => {
    const card = tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first();
    await card.click();
    const overview = await tv.page.locator('.browse-overview').textContent();
    await tv.page.locator('[data-focus="season:2"]').focus(); await tv.jump(500);
    await tv.page.keyboard.press('Escape');
    await card.click();
    await tv.page.locator('[data-focus="season:2"][aria-pressed="true"]').waitFor();
    assert.equal(await tv.focused(), 'next-episode');
    assert.equal(await tv.page.locator('.browse-overview').textContent(), overview);
});

detailTest("failed episode Retry retains focus without unresolved hero readout bars", async tv => {
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons/2/episodes?**', route => route.fulfill({ status: 422, json: { code: 'validation_failed', detail: 'Unavailable' } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="season:2"]').focus(); await tv.jump(500);
    const retry = tv.page.locator('[data-focus="retry-episodes"]');
    await retry.waitFor(); await retry.focus(); await tv.page.keyboard.press('Enter');
    await retry.waitFor(); await tv.jump(500);
    assert.equal(await tv.focused(), 'retry-episodes');
    assert.equal(await tv.page.locator('.details-playback-summary span:empty').count(), 0);
});

detailTest("season focus centers the selected pill and Down uses its E01 without Select", async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const seasons = catalog.route("GET", "/catalog/series/series%3As1/seasons", "p-owner")?.body as { items: Record<string, unknown>[] };
    const episodes = catalog.route("GET", "/catalog/series/series%3As1/seasons/1/episodes", "p-owner")?.body as { items: Record<string, unknown>[] };
    await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons?**", route => route.fulfill({ json: { items: Array.from({ length: 30 }, (_, index) => ({ ...seasons.items[0], content_id: `season:${index + 1}`, season_number: index + 1, title: `Series ${index + 1}`, user_data: { played: index < 17, in_progress_count: index === 17 ? 1 : 0 } })) } }));
    const reads: number[] = [];
    const item = catalog.route('GET', '/catalog/items/episode%3As1e11', 'p-owner')?.body as Record<string, unknown>;
    await tv.page.route('**/api/v2/catalog/items/episode%3A*%3A*?**', route => {
        const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
        const [, season, number] = id.split(':');
        return route.fulfill({ json: { ...item, content_id: id, season_number: Number(season), episode_number: Number(number) } });
    });
    await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons/*/episodes?**", route => {
        const season = Number(new URL(route.request().url()).pathname.split("/").at(-2));
        reads.push(season);
        return route.fulfill({ json: { items: Array.from({ length: 14 }, (_, index) => ({ ...episodes.items[0], content_id: `episode:${season}:${index + 1}`, season_number: season, episode_number: index + 1 })) } });
    });
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="episode:19:14"]').waitFor();
    assert.deepEqual([...reads].sort((a, b) => a - b), [17, 18, 19]);
    const centered = async (season: number) => tv.page.locator(`[data-focus="season:${season}"]`).evaluate(node => {
        const pill = node.getBoundingClientRect(), row = node.parentElement!.getBoundingClientRect();
        return Math.abs((pill.left + pill.right) / 2 - (row.left + row.right) / 2) <= 1;
    });
    await tv.eventually(() => centered(18), "initial selected pill centered");
    await tv.page.locator('[data-focus="season:18"]').focus();
    await tv.remote(37); await tv.jump(100);
    await tv.eventually(async () => await tv.page.locator('[data-focus="season:17"]').getAttribute("aria-pressed") === "true", "focus selects cached season");
    assert.equal(await tv.focused(), "season:17");
    assert.equal(reads.length, 3);
    await tv.eventually(() => centered(17), "focus-selected pill centered");
    await tv.eventually(async () => (await tv.page.locator('[data-focus="next-episode"]').textContent())?.includes('S17:E1') === true, 'summary supplies Play before item hydration');
    for (const season of [18, 19]) {
        await tv.page.locator(`[data-focus="season:${season}"]`).focus(); await tv.jump(60);
    }
    await tv.jump(100);
    await tv.eventually(async () => (await tv.page.locator('[data-focus="next-episode"]').textContent())?.includes('S19:E1') === true, 'burst leaves Play on the latest season');
    await tv.page.locator('[data-focus="season:17"]').focus(); await tv.jump(100);
    await tv.remote(40);
    assert.equal(await tv.focused(), "episode:17:1");
});

detailTest("short final season uses the continuous row end clamp and loaded predecessors", async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog);
    const seasons = catalog.route('GET', '/catalog/series/series%3As1/seasons', 'p-owner')?.body as { items: Record<string, unknown>[] };
    const episodes = catalog.route('GET', '/catalog/series/series%3As1/seasons/1/episodes', 'p-owner')?.body as { items: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons?**', route => route.fulfill({ json: { items: [3, 4].map(season => ({ ...seasons.items[0], content_id: `season:${season}`, season_number: season, episode_count: season === 3 ? 10 : 3, user_data: { played: false, in_progress_count: season === 3 ? 1 : 0 } })) } }));
    for (const season of [3, 4]) await tv.page.route(`**/api/v2/catalog/series/series%3As1/seasons/${season}/episodes?**`, route => route.fulfill({ json: { items: Array.from({ length: season === 3 ? 10 : 3 }, (_, index) => ({ ...episodes.items[0], content_id: `episode:short${season}:${index + 1}`, season_number: season, episode_number: index + 1 })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="episode:short4:3"]').waitFor();
    await tv.page.locator('[data-focus="season:4"]').focus(); await tv.jump(500);
    const visible = await tv.page.locator('.details-episodes .browse-card').evaluateAll(nodes => nodes.filter(node => {
        const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= 1920;
    }).map(node => node.getAttribute('data-focus')));
    assert.deepEqual(visible, ['episode:short3:9', 'episode:short3:10', 'episode:short4:1', 'episode:short4:2', 'episode:short4:3']);
    const frame = await readLive(tv, liveRail, null, value => value !== null && Math.abs(value.cards[8]!.x - 110) < 2, 'fresh pill selection has no reopen clearance');
    assert.ok(frame && Math.abs(frame.cards[10]!.x - 808.5) < 2 && Math.abs(frame.cards.at(-1)!.right - 1818) < 2);
    assert.equal(await tv.page.locator('[data-focus="season:3"]').evaluate(node => node.getBoundingClientRect().x), 100);
}, 'compact');

detailTest("an unhydrated episode uses its summary for Resume and Start Over", async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog);
    const held = tv.fake.hold('/catalog/items/episode%3Aresume-summary', true);
    const body = catalog.route('GET', '/catalog/series/series%3As1/seasons/1/episodes', 'p-owner')?.body as { items: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons/1/episodes?**', route => route.fulfill({ json: { items: body.items.map((episode, index) => ({ ...episode, ...(index === 1 ? { content_id: 'episode:resume-summary' } : {}), user_data: { played: false, is_in_progress: index === 1, position_seconds: index === 1 ? 60 : 0, duration_seconds: 3000 } })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="episode:s1e11"]').focus();
    await tv.page.locator('[data-focus="episode:resume-summary"]').focus();
    assert.equal(await tv.page.getByRole('button', { name: 'Resume S1:E2', exact: true }).count(), 1, await tv.page.locator('[data-focus="next-episode"]').textContent() ?? 'missing Play');
    assert.equal(await tv.page.getByRole('button', { name: 'Start Over', exact: true }).count(), 1);
    held.release();
});

for (const media of ['movie:m0001', 'series:s1']) detailTest(`${media} reveals supporting headings in both directions`, async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    catalog.videos = [{ site_key: 'trailer-key', site: 'YouTube', kind: 'trailer', name: 'Trailer' }];
    const body = catalog.route('GET', `/catalog/items/${encodeURIComponent(media)}`, 'p-owner')?.body as Record<string, unknown>;
    await tv.page.route(`**/api/v2/catalog/items/${encodeURIComponent(media)}?**`, route => route.fulfill({ json: {
        ...body, content_rating: 'PG', overview: 'A remote observatory receives a message that changes the lives of everyone on the night shift. '.repeat(3),
        studios: ['Studio'], countries: ['AU'], release_date: '2020-01-01',
        ...(media.startsWith('series') ? { networks: ['Network'], first_air_date: '2020-01-01', last_air_date: '2021-01-01' } : { networks: ['Network'] }),
    } }));
    await tv.page.locator(`[data-section="recently_added"] [data-focus="${media}"]`).first().click();
    await tv.page.locator('.details-extras [data-focus]').first().waitFor();
    await tv.page.locator('[data-detail-section="related"] [data-focus]').first().waitFor();
    await tv.page.evaluate(() => document.fonts.ready);
    await tv.jump(500);
    if (media.startsWith('movie')) {
        const stack = await readLive(tv, () => {
            const nodes = ['.browse-meta', '.browse-overview', '.details-director', '.details-playback-summary', '.browse-actions'].map(selector => document.querySelector(`.details-editorial ${selector}`));
            return nodes.some(node => !node?.isConnected) ? null : nodes.map(node => node!.getBoundingClientRect().top);
        }, null, value => value.length === 5, 'movie hero stack');
        assert.ok(stack.every((value, index) => Math.abs(value - [291, 334, 450, 492, 556][index]!) <= 3), JSON.stringify(stack));
    }
    const sample = (selector: string) => readLive(tv, selector => {
        const section = document.querySelector<HTMLElement>(selector);
        const page = document.querySelector<HTMLElement>('.browse');
        const header = section?.matches('.details-facts') ? section.firstElementChild : section?.previousElementSibling;
        if (!section?.isConnected || !page || !header) return null;
        return { heading: header.getBoundingClientRect().top, scroll: page.scrollTop, maximum: page.scrollHeight - page.clientHeight, height: page.scrollHeight, bottom: section.getBoundingClientRect().bottom, focused: section.contains(document.activeElement) };
    }, selector, value => value.focused, 'live supporting heading');
    const check = async (selector: string, target: number, key: number) => {
        await tv.remote(key); await tv.jump(500);
        const value = await sample(selector);
        assert.ok(Math.abs(value.heading - target) <= 3, `${selector}: ${JSON.stringify(value)} target ${target}`);
    };
    const series = media.startsWith('series');
    if (series) {
        await tv.remote(40); await tv.remote(40);
        assert.equal(await tv.page.locator('.browse').evaluate(node => node.scrollTop), 0);
    }
    await check('.details-people', series ? 367 : 546, 40);
    await check('.details-extras', 501, 40);
    await check('[data-detail-section="related"]', series ? 547 : 321, 40);
    await tv.remote(40); await tv.jump(500);
    const end = await sample('.details-facts');
    assert.equal(end.scroll, end.maximum);
    assert.ok(Math.abs(end.bottom - 940) <= 1, '140px total bottom padding');
    // Fake facts differ from the captured title: residuals +4.61 Movie / +5.41 Series.
    assert.ok(Math.abs(end.heading - (series ? 457.41 : 528.61)) <= 3, JSON.stringify(end));
    console.log(`${media} Details heading ${end.heading}, residual ${end.heading - (series ? 452 : 524)}, page height ${end.height}`);
    await check('[data-detail-section="related"]', series ? 111 : 321, 38);
    await check('.details-extras', 111, 38);
    await check('.details-people', series ? 367 : 690, 38);
    if (!series) assert.equal((await sample('.details-people')).scroll, 0);
    const reads = tv.fake.requests.length;
    await tv.remote(39); await tv.jump(500);
    assert.equal(tv.fake.requests.length, reads, 'horizontal focus does not fetch');
    await tv.remote(38); await tv.jump(500);
    if (series) { await tv.remote(38); await tv.remote(38); await tv.jump(500); }
    assert.equal(await readLive(tv, () => {
        const page = document.querySelector<HTMLElement>('.browse');
        return page === null ? null : page.scrollTop;
    }, null, value => value === 0, 'hero returns to scroll zero'), 0);
});


detailTest('nested presentations of one title preserve the ancestor visit', async tv => {
    await tv.page.route('**/api/v2/recommendations/similar/**', route => route.fulfill({ json: { items: ['movie:m0001', 'movie:m0002'].map(content_id => ({ content_id, type: 'movie', title: content_id })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    const related = () => tv.page.locator('[data-detail-section="related"] [data-focus]').first();
    await related().waitFor();
    await tv.jump(500);
    await tv.remote(40);
    await tv.remote(40);
    await tv.jump(500);
    const before = await readLive(tv, () => {
        const page = document.querySelector<HTMLElement>('.browse');
        return page === null ? null : { scroll: page.scrollTop, key: document.activeElement?.getAttribute('data-focus') };
    }, null, value => value.scroll > 0 && value.key === 'movie:m0002', 'ancestor Related focus');
    await tv.page.keyboard.press('Enter');
    await related().waitFor();
    await related().click();
    await tv.page.locator('.details-play').waitFor();
    await tv.jump(500);
    assert.equal(await tv.focused(), 'resume');
    assert.equal(await tv.page.locator('.browse').evaluate(node => node.scrollTop), 0);
    await tv.remote(40);
    await tv.jump(500);
    await tv.remote(10009);
    await tv.remote(10009);
    const restored = await readLive(tv, () => {
        const page = document.querySelector<HTMLElement>('.browse');
        return page === null ? null : { scroll: page.scrollTop, key: document.activeElement?.getAttribute('data-focus') };
    }, null, value => value.scroll === before.scroll && value.key === before.key, 'ancestor visit restored');
    assert.deepEqual(restored, before);
});

for (const id of ['movie:m0001', 'series:s1']) detailTest(`${id} reopening starts at the hero instead of a remembered supporting section`, async tv => {
    const open = async () => {
        await tv.page.locator(`[data-section="recently_added"] [data-focus="${id}"]`).first().click();
        await tv.page.locator('.details-people').waitFor();
        await tv.page.locator('[data-detail-section="related"] [data-focus]').first().waitFor();
        await tv.eventually(async () => await tv.page.locator('[data-focus="watchlist"]').count() === 1, 'personal actions loaded');
        await tv.page.evaluate(() => document.fonts.ready);
        await tv.page.waitForLoadState('networkidle');
        await tv.jump(500);
    };
    await open();
    for (let step = 0; step < (id.startsWith('series') ? 3 : 1); step++) await tv.remote(40);
    await tv.remote(39);
    await tv.jump(500);
    const measure = () => tv.page.evaluate(() => {
        const page = document.querySelector<HTMLElement>('.browse')!;
        return { scroll: page.scrollTop, hero: page.querySelector('.details-hero')!.getBoundingClientRect().top };
    });
    let seen = Number.NaN;
    const before = await readLive(tv, () => {
        const page = document.querySelector<HTMLElement>('.browse');
        const hero = page?.querySelector('.details-hero');
        if (page === null || !page.isConnected || hero === null || hero === undefined) return null;
        return { scroll: page.scrollTop, hero: hero.getBoundingClientRect().top };
    }, null, value => {
        const settled = value.scroll > 0 && value.scroll === seen;
        seen = value.scroll;
        return settled;
    }, 'settled non-zero scroll');
    assert.ok(before.scroll > 0);
    await tv.remote(10009);
    await open();
    assert.equal(await tv.focused(), id.startsWith('movie') ? 'resume' : 'next-episode');
    assert.equal((await measure()).scroll, 0);
    assert.equal((await measure()).hero, 0);
});

for (const id of ['movie:m0001', 'series:s1']) detailTest(`${id} Details omits controls absent from tvOS and keeps focus at the last section`, async tv => {
    await tv.page.locator(`[data-section="recently_added"] [data-focus="${id}"]`).first().click();
    await tv.page.locator('[data-focus="watchlist"]').waitFor();
    if (id === 'series:s1') await tv.page.locator('[data-focus="episode:s1e11"]').waitFor();
    assert.equal(await tv.page.getByRole('button', { name: /Read synopsis|Rate title|Season .* details/ }).count(), 0);
    const lastKey = id === 'movie:m0001' ? 'fact:0' : 'series:s1-S1';
    await tv.page.locator(`[data-focus="${lastKey}"]`).focus();
    await tv.remote(40);
    assert.equal(await tv.focused(), lastKey);
    await tv.remote(38);
    assert.ok(await tv.page.locator(id === 'movie:m0001' ? '[data-detail-section="related"] :focus' : '.details-people :focus').count(), `Up focused ${await tv.focused()}`);
    await tv.remote(40);
    assert.equal(await tv.focused(), lastKey);
    assert.equal(tv.fake.requests.filter(request => request.path.startsWith('/ratings/')).length, 0);
});

for (const media of ['movie:m0001', 'series:s1']) for (const count of [20, 25]) detailTest(`275 ${media} Cast ${count} preserves wire cast order and repeated credits without crew`, async tv => {
    const body = tv.fake.catalog?.route('GET', `/catalog/items/${encodeURIComponent(media)}`, 'p-owner')?.body as Record<string, unknown>;
    const cast = Array.from({ length: count }, (_, index) => ({ person_id: index < 2 ? 'same' : String(index), name: `Actor ${index}`, character: `Role ${index}`, order: count - index }));
    await tv.page.route(`**/api/v2/catalog/items/${encodeURIComponent(media)}?**`, route => route.fulfill({ json: { ...body, cast, crew: [{ person_id: 'director', name: 'Director', job: 'Director' }] } }));
    await tv.page.locator(`[data-section="recently_added"] [data-focus="${media}"]`).first().click();
    await tv.page.locator('.details-people').waitFor();
    assert.deepEqual(await tv.page.locator('.details-people .browse-card-title').allTextContents(), cast.slice(0, 24).map(person => person.name));
    assert.equal(new Set(await tv.page.locator('.details-people [data-focus]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-focus')))).size, Math.min(count, 24));
});

detailTest('275 More glass obscures the page with blur and pinned Swift tint stroke shadow', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="watchlist"]').waitFor();
    await tv.page.locator('[data-focus="more"]').click();
    const glass = await tv.page.locator('.details-more-popover').evaluate(node => {
        const style = getComputedStyle(node);
        return { blur: style.backdropFilter, tint: style.backgroundColor, border: style.borderTopColor, width: style.borderTopWidth, shadow: style.boxShadow };
    });
    assert.equal(glass.blur, 'blur(30px)');
    assert.equal(glass.tint, 'rgba(0, 0, 0, 0.45)');
    assert.equal(glass.border, 'rgba(255, 255, 255, 0.1)');
    assert.equal(glass.width, '1px');
    assert.equal(glass.shadow, 'rgba(0, 0, 0, 0.45) 0px 18px 32px 0px');
});

detailTest('More is an anchored popover with Apple ordering and immediate Back focus', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.eventually(async () => await tv.page.locator('[data-focus="watchlist"]').count() === 1, 'personal actions loaded');
    await tv.page.locator('[data-focus="more"]').click();
    const panel = tv.page.getByRole('dialog', { name: 'More', exact: true });
    assert.equal(await panel.evaluate(node => node.classList.contains('details-track-popover')), true);
    assert.deepEqual(await panel.locator('button').allTextContents(), ['Add to Favorites', 'Mark as Watched', 'Find Trailers']);
    assert.equal(await tv.focused(), 'favorites');
    const panelBox = await readLive(tv, () => {
        const dialog = document.querySelector(".details-more-popover");
        if (!(dialog instanceof HTMLElement) || !dialog.isConnected) return null;
        const buttons = [...dialog.querySelectorAll("button")].map(button => button instanceof HTMLElement ? button.offsetHeight : 0);
        return { width: dialog.offsetWidth, buttons };
    }, null, box => box.width === 560 && box.buttons.length === 3 && box.buttons.every(height => height === 54), "More panel geometry");
    assert.equal(panelBox.width, 560);
    assert.deepEqual(panelBox.buttons, [54, 54, 54]);
    await tv.remote(39);
    assert.equal(await panel.count(), 0);
    assert.equal(await tv.focused(), 'more');
    await tv.page.keyboard.press('Enter');
    await tv.remote(10009);
    assert.equal(await panel.count(), 0);
    assert.equal(await tv.focused(), 'more');
});

detailTest('More ellipsis has three round six-pixel dots at rest and focus', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="watchlist"]').waitFor();
    for (const focused of [false, true]) {
        await tv.page.locator(`[data-focus="${focused ? 'more' : 'watchlist'}"]`).focus();
        const dots = await readLive(tv, () => {
            const nodes = [...document.querySelectorAll('[data-focus="more"] svg circle')];
            if (nodes.length !== 3 || nodes.some(node => !node.isConnected)) return null;
            return nodes.map(dot => {
                const bounds = dot.getBoundingClientRect();
                return [Math.round(bounds.width), Math.round(bounds.height)];
            });
        }, null, value => value.every(([width, height]) => width === 6 && height === 6), "More dots");
        assert.deepEqual(dots, [[6, 6], [6, 6], [6, 6]]);
    }
});

detailTest('More uses available space below then above then bottom-pinned and clamps x', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="watchlist"]').waitFor();
    for (const [top, left, height] of [[250, 0, 0], [850, 1800, 0], [500, 800, 900]]) {
        const style = await tv.page.addStyleTag({ content: `[data-focus="more"] { position: fixed !important; top: ${top}px !important; left: ${left}px !important; } ${height ? `.details-more-popover { height: ${height}px !important; }` : ''}` });
        await tv.page.locator('[data-focus="more"]').focus();
        await tv.page.keyboard.press('Enter');
        const placedBelow = top === 250;
        const placement = await readLive(tv, below => {
            const panel = document.querySelector<HTMLElement>(".details-more-popover");
            const anchor = document.querySelector('[data-focus="more"]');
            if (panel === null || anchor === null || !panel.isConnected || !anchor.isConnected) return null;
            const bounds = anchor.getBoundingClientRect();
            void below;
            return { left: parseFloat(panel.style.left), top: parseFloat(panel.style.top), height: panel.offsetHeight, anchorTop: bounds.top, anchorBottom: bounds.bottom };
        }, placedBelow, sample => sample.top === (height ? 1080 - 48 - sample.height : placedBelow ? sample.anchorBottom + 14 : sample.anchorTop - 14 - sample.height), "More popover placement");
        assert.equal(placement.top, height ? 1080 - 48 - placement.height : placedBelow ? placement.anchorBottom + 14 : placement.anchorTop - 14 - placement.height);
        assert.equal(placement.left, Math.max(48, Math.min(left!, 1920 - 48 - 560)));
        await tv.remote(10009);
        await style.evaluate(node => node.parentNode?.removeChild(node));
    }
});

detailTest('Unfocused Play composites the shared white fill over warm neutral and cool backdrops', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('.details-play').waitFor();
    for (const [base, expected] of [ [[29, 22, 17], [52, 45, 41]], [[25, 23, 21], [48, 46, 44]], [[9, 27, 35], [34, 50, 57]] ]) {
        await tv.page.evaluate(base => {
            document.querySelector('#fill-sample')?.remove();
            const surface = document.createElement('div');
            surface.id = 'fill-sample'; surface.className = 'details-editorial';
            surface.style.cssText = `position:fixed;left:0;top:0;margin:0;padding:0;width:400px;height:100px;z-index:9999;background:rgb(${base!.join(',')})`;
            const play = document.querySelector('.details-play')!.cloneNode(true) as HTMLElement;
            play.style.cssText = 'position:absolute;left:0;top:0;width:340px;height:76px;margin:0';
            play.removeAttribute('data-focus'); play.textContent = ''; surface.append(play); document.body.append(surface);
        }, base!);
        const png = await tv.page.screenshot({ animations: 'disabled', clip: { x: 100, y: 30, width: 1, height: 1 } });
        const pixel = await tv.page.evaluate(async data => {
            const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
            const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
            return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
        }, png.toString('base64'));
        assert.ok(pixel.every((value, i) => Math.abs(value - expected![i]!) <= 2), `${pixel} versus ${expected}`);
    }
});

detailTest('Shuffle Series leads More, reports failure, and reuses shuffle playback', async tv => {
    await tv.page.route('**/api/v2/shuffles/capabilities', route => route.fulfill({ json: { allowed: true, state: 'available', scope_kinds: ['series'] } }));
    let fail = true;
    await tv.page.route('**/api/v2/shuffles', async route => {
        assert.deepEqual(route.request().postDataJSON(), { scope: { kind: 'series', id: 'series:s1' } });
        if (fail) await route.fulfill({ status: 503, json: problem(503, 'unavailable', 'Unavailable').body });
        else await route.fulfill({ status: 201, json: { id: 'series-shuffle', current: { content_id: 'episode:s1e11' }, next: { content_id: 'episode:s1e12' } } });
    });
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="watchlist"]').waitFor();
    await tv.page.locator('[data-focus="more"]').click();
    const shuffle = tv.page.getByRole('button', { name: 'Shuffle Series', exact: true });
    await shuffle.waitFor();
    assert.equal(await tv.focused(), 'shuffle-series');
    await shuffle.click();
    await tv.page.getByRole('alert').filter({ hasText: "Couldn't start the shuffle. Try again." }).waitFor();
    fail = false;
    await shuffle.click();
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.plays.length === 1), 'shuffle playback dispatched');
    assert.equal(await tv.page.evaluate(() => window.browseHarness.plays[0]?.shuffleId), 'series-shuffle');
});

for (const id of ['movie:m0001', 'series:s1']) detailTest(`${id} Start Over shares Apple's circle and symbol`, async tv => {
    if (id.startsWith('series')) {
        const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
        const body = catalog.route('GET', '/catalog/items/episode%3As1e11', 'p-owner')?.body as Record<string, unknown>;
        await tv.page.route('**/api/v2/catalog/items/episode%3As1e11?**', route => route.fulfill({ json: { ...body, user_data: { played: false, position_seconds: 120 } } }));
    }
    await tv.page.locator(`[data-section="recently_added"] [data-focus="${id}"]`).first().click();
    const start = tv.page.locator(`[data-focus="${id.startsWith('movie') ? 'play' : 'start-over-episode'}"]`);
    await start.waitFor();
    assert.equal(await start.getAttribute('aria-label'), 'Start Over');
    assert.equal(await start.locator('svg').getAttribute('data-symbol'), 'backward.end.fill');
    const startOver = await readLive(tv, selector => {
        const node = document.querySelector(selector);
        if (node === null || !node.isConnected) return null;
        const bounds = node.getBoundingClientRect();
        return [bounds.width, bounds.height];
    }, `[data-focus="${id.startsWith("movie") ? "play" : "start-over-episode"}"]`, bounds => bounds[0] === 76 && bounds[1] === 76, "Start Over circle");
    assert.deepEqual(startOver, [76, 76]);
    await start.focus();
    assert.equal(await start.locator('.details-action-label').textContent(), 'Start Over');
});

detailTest('Series hero uses the selected season suggestion instead of play_content_id', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    catalog.watchedEpisodes.delete('episode:s1e12');
    const seasons = catalog.route('GET', '/catalog/series/series%3As1/seasons', 'p-owner')?.body as { items: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons?**', route => route.fulfill({ json: { items: seasons.items.map(season => ({ ...season, user_data: undefined })) } }));
    const body = catalog.route('GET', '/catalog/items/series%3As1', 'p-owner')?.body as Record<string, unknown>;
    await tv.page.route('**/api/v2/catalog/items/series%3As1?**', route => route.fulfill({ json: { ...body, play_content_id: 'episode:s1e11' } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="episode:s1e11"]').waitFor();
    await tv.eventually(async () => (await tv.page.locator('[data-focus="next-episode"]').textContent())?.includes('S1:E2') === true, 'hero follows suggested episode in selected season');
    await tv.page.locator('[data-focus="more"]').click();
    assert.equal(await tv.page.locator('[data-focus="season-watched"]').count(), 0, 'unknown season watch state cannot enable a write');
    await tv.remote(10009);
    await tv.page.locator('[data-focus="episode:s1e11"]').focus();
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.getByRole('button', { name: 'Show Series Info', exact: true }).click();
    await tv.eventually(async () => (await tv.page.locator('[data-focus="next-episode"]').textContent())?.includes('S1:E2') === true, 'overview suggestion is independent of rail focus memory');
    await tv.remote(10009);
    await tv.page.route("**/api/v2/**", route => route.abort("connectionrefused"));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.jump(35000);
    assert.match(await tv.page.locator('[data-focus="next-episode"]').innerText(), /S1:E2/);
    await tv.page.unroute("**/api/v2/**");
    await tv.jump(50000);
    assert.match(await tv.page.locator('[data-focus="next-episode"]').innerText(), /S1:E2/, "recovery retains the overview suggestion rather than rail focus memory");
});

detailTest('Series More keeps series and season watched writes separate and reconciles failure', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const seasons = catalog.route('GET', '/catalog/series/series%3As1/seasons', 'p-owner')?.body as { items: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons?**', route => route.fulfill({ json: { items: seasons.items.map(season => ({ ...season, user_data: { played: false, in_progress_count: season.season_number === 1 ? 1 : 0 } })) } }));
    for (const title of catalog.titles.values()) if (title.type === 'episode') catalog.watchedEpisodes.add(title.id);
    catalog.watchedEpisodes.delete('episode:s1e12');
    catalog.progress.set('episode:s1e12', 120);
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="start-over-episode"]').waitFor();
    await tv.page.locator('[data-focus="watchlist"]').waitFor();
    await tv.page.locator('[data-focus="more"]').click();
    const panel = tv.page.getByRole('dialog', { name: 'More', exact: true });
    assert.deepEqual(await panel.locator('button').allTextContents(), ['Add to Favorites', 'Mark Series Watched', 'Mark Season Watched', 'Find Trailers']);
    catalog.mutationFailure = problem(422, 'validation_failed', 'Unavailable action');
    await panel.locator('[data-focus="season-watched"]').click();
    assert.equal(await panel.count(), 0);
    assert.equal(await tv.focused(), 'more');
    await tv.page.locator('[data-focus="more"]').click();
    await panel.getByRole('button', { name: 'Retry season watched', exact: true }).waitFor();
    await panel.getByRole('alert').filter({ hasText: 'Could not update season watched.' }).waitFor();
    await tv.remote(10009);
    await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().click();
    await tv.page.locator('[data-view="person:7"]').waitFor();
    await tv.remote(10009);
    await tv.page.locator('[data-focus="more"]').click();
    await panel.getByRole('button', { name: 'Retry season watched', exact: true }).click();
    await tv.page.locator('[data-focus="more"]').click();
    await panel.getByRole('button', { name: 'Mark Season Unwatched', exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Mark Series Unwatched', exact: true }).waitFor();
    assert.deepEqual(catalog.mutations, ['POST /watched/series%3As1-S1', 'POST /watched/series%3As1-S1']);
    assert.equal(catalog.watchedEpisodes.has('episode:s1e12'), true);
    await tv.remote(10009);
    await tv.eventually(async () => await tv.page.locator('[data-focus="start-over-episode"]').count() === 0, 'season reconciliation clears stale resume controls');
    await tv.eventually(async () => (await tv.page.locator('[data-focus="next-episode"]').textContent())?.includes('S1:E1') === true, 'fully watched season recomputes its first episode suggestion');
});

detailTest('Series More restores fresh season watch state after changing it on the season page', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    catalog.watchedEpisodes.clear();
    const seasons = catalog.route('GET', '/catalog/series/series%3As1/seasons', 'p-owner')?.body as { items: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons?**', route => route.fulfill({ json: { items: seasons.items.map(season => ({ ...season, user_data: { played: catalog.watchedEpisodes.has('episode:s1e11'), in_progress_count: 0 } })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.getByRole('button', { name: 'Mark Season Watched', exact: true }).waitFor();
    await tv.remote(10009);
    await tv.page.locator('[data-focus="series:s1-S1"]').click();
    await tv.page.locator('[data-view="season:series:s1:1"]').waitFor();
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.getByRole('button', { name: 'Mark Season Watched', exact: true }).click();
    await tv.eventually(async () => catalog.watchedEpisodes.has('episode:s1e11'), 'season write committed');
    await tv.remote(10009);
    await tv.page.locator('[data-view="item:series:s1"]').waitFor();
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.getByRole('button', { name: 'Mark Season Unwatched', exact: true }).waitFor();
});

detailTest('Series watched confirmation reaches seasons first visited after the write', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    catalog.watchedEpisodes.clear();
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.getByRole('button', { name: 'Mark Series Watched', exact: true }).click();
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.getByRole('button', { name: 'Mark Series Unwatched', exact: true }).waitFor();
    await tv.remote(10009);
    await tv.page.locator('[data-focus="season:2"]').click();
    await tv.page.locator('[data-focus="episode:s1e21"]').waitFor();
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.getByRole('button', { name: 'Mark Season Unwatched', exact: true }).waitFor();
    assert.deepEqual(catalog.mutations, ['POST /watched/series%3As1']);
});

detailTest('Failed season episode reconciliation keeps the existing playback owner usable', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.eventually(async () => await tv.page.locator('[data-focus="next-episode"]').getAttribute('aria-disabled') === 'false', 'episode playback prepared');
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons/1/episodes?**', route => route.fulfill({ status: 400, json: problem(400, 'unavailable', 'Unavailable').body }));
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.locator('[data-focus="season-watched"]').click();
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.getByRole('button', { name: 'Retry season watched', exact: true }).waitFor();
    await tv.remote(10009);
    await tv.page.locator('[data-focus="next-episode"]').click();
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.plays.length === 1), 'retained owner still dispatches playback after reconciliation fails');
});

detailTest("episode boundary failure retries at the edge and on explicit Retry while loaded-season focus stays read-free", async tv => {
    await pauseTvClock(tv);
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const seasons = catalog.route("GET", "/catalog/series/series%3As1/seasons", "p-owner")?.body as { items: Record<string, unknown>[] };
    const episodes = catalog.route("GET", "/catalog/series/series%3As1/seasons/1/episodes", "p-owner")?.body as { items: Record<string, unknown>[] };
    await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons?**", route => route.fulfill({ json: { items: [1, 2, 3, 4, 5].map(number => ({ ...seasons.items[0], content_id: `season:${number}`, season_number: number, episode_count: 14, user_data: { played: number === 1, in_progress_count: number === 2 ? 1 : 0 } })) } }));
    const reads: number[] = [];
    let failBoundary = true;
    for (const season of [1, 2, 3, 4, 5]) await tv.page.route(`**/api/v2/catalog/series/series%3As1/seasons/${season}/episodes?**`, route => {
        reads.push(season);
        if (season === 4 && failBoundary) return route.fulfill({ status: 422, json: problem(422, "validation_failed", "Unavailable").body });
        return route.fulfill({ json: { items: Array.from({ length: 14 }, (_, index) => ({ ...episodes.items[0], content_id: `episode:rail:${season}:${index}`, season_number: season, episode_number: index + 1 })) } });
    });
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    const card = (season: number, index: number) => tv.page.locator(`[data-focus="episode:rail:${season}:${index}"]`);
    await card(3, 13).waitFor(); await card(1, 0).waitFor();
    assert.deepEqual([...reads].sort(), [1, 2, 3]);
    for (const [season, index] of [[2, 13], [3, 0], [3, 12], [2, 13], [3, 12]] as const) {
        await card(season, index).focus(); await tv.jump(100);
    }
    assert.equal(reads.length, 3, "crossing cached seasons starts no reads");
    // Keep departure before the dwell in one browser turn, even under protocol contention.
    await tv.page.evaluate(() => {
        document.querySelector<HTMLElement>('[data-focus="episode:rail:3:13"]')!.focus();
        document.querySelector<HTMLElement>('[data-focus="audio"]')!.focus();
    }); await tv.jump(100);
    assert.equal(reads.length, 3, "leaving the rail cancels boundary dwell");
    await card(3, 13).focus(); await tv.jump(100);
    const retry = tv.page.getByRole("button", { name: "Retry more episodes", exact: true });
    await retry.waitFor();
    assert.deepEqual(reads.slice(3), [4]);
    await card(3, 12).focus(); await card(3, 13).focus(); await tv.jump(100);
    await tv.eventually(async () => reads.length === 5, "reaching the failed boundary again retries it, as Apple TV does");
    await retry.focus(); await tv.page.keyboard.press("Enter"); await tv.jump(100);
    await tv.eventually(async () => reads.length === 6, "failed explicit neighbour Retry");
    await retry.waitFor();
    assert.equal(await tv.focused(), "episode:rail:3:13", "Retry hides while it runs; focus stays on the edge card and the error returns after the failure");
    failBoundary = false;
    // Drain the episode-detail dwell the edge card's focus armed, then activate Retry explicitly.
    await tv.jump(120);
    await retry.click();
    await tv.eventually(async () => await card(4, 13).count() === 1, "successful neighbour Retry paints season 4");
    assert.deepEqual(reads.slice(3), [4, 4, 4, 4], "boundary and explicit Retry read only the failed season");
    assert.equal(await retry.count(), 0);
    assert.notEqual(await tv.focused(), "retry-neighbors", "the removed Retry control cannot retain focus");
});

detailTest("Retry more episodes keeps focus on the selected season chip when the rail has no cards", async tv => {
    await pauseTvClock(tv);
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const seasons = catalog.route("GET", "/catalog/series/series%3As1/seasons", "p-owner")?.body as { items: Record<string, unknown>[] };
    const episodes = catalog.route("GET", "/catalog/series/series%3As1/seasons/1/episodes", "p-owner")?.body as { items: Record<string, unknown>[] };
    await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons?**", route => route.fulfill({ json: { items: [1, 2, 3, 4, 5].map(number => ({ ...seasons.items[0], content_id: `season:${number}`, season_number: number, episode_count: 14, user_data: { played: number === 1, in_progress_count: number === 2 ? 1 : 0 } })) } }));
    let releaseSeason5 = (): void => undefined;
    const season5 = new Promise<void>(resolve => { releaseSeason5 = resolve; });
    for (const season of [1, 2, 3, 4, 5]) await tv.page.route(`**/api/v2/catalog/series/series%3As1/seasons/${season}/episodes?**`, async route => {
        if (season === 4) return route.fulfill({ status: 422, json: problem(422, "validation_failed", "Unavailable").body });
        if (season === 5) await season5;
        return route.fulfill({ json: { items: Array.from({ length: 14 }, (_, index) => ({ ...episodes.items[0], content_id: `episode:rail:${season}:${index}`, season_number: season, episode_number: index + 1 })) } });
    });
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    const card = (season: number, index: number) => tv.page.locator(`[data-focus="episode:rail:${season}:${index}"]`);
    await card(3, 13).waitFor();
    await card(3, 13).focus(); await tv.jump(100);
    const retry = tv.page.getByRole("button", { name: "Retry more episodes", exact: true });
    await retry.waitFor();
    await tv.page.locator('[data-focus="season:5"]').focus(); await tv.jump(100);
    await tv.eventually(async () => await tv.page.locator('[data-focus^="episode:rail:"]').count() === 0, "the unloaded selected season leaves the rail without cards");
    await retry.waitFor();
    await retry.focus(); await tv.page.keyboard.press("Enter"); await tv.jump(100);
    assert.equal(await tv.focused(), "season:5", "Retry hides while it runs; with no cards beside it, focus stays on the selected season chip");
    releaseSeason5();
});

detailTest("an empty boundary response does not chain reads when the focused edge is restored", async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const seasons = catalog.route("GET", "/catalog/series/series%3As1/seasons", "p-owner")?.body as { items: Record<string, unknown>[] };
    const episodes = catalog.route("GET", "/catalog/series/series%3As1/seasons/1/episodes", "p-owner")?.body as { items: Record<string, unknown>[] };
    await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons?**", route => route.fulfill({ json: { items: [1, 2, 3, 4, 5, 6].map(number => ({ ...seasons.items[0], content_id: `season:${number}`, season_number: number, episode_count: 14, user_data: { played: number === 1, in_progress_count: number === 2 ? 1 : 0 } })) } }));
    const reads: number[] = [];
    for (const season of [1, 2, 3, 4, 5, 6]) await tv.page.route(`**/api/v2/catalog/series/series%3As1/seasons/${season}/episodes?**`, route => {
        reads.push(season);
        return route.fulfill({ json: { items: season > 3 ? [] : Array.from({ length: 14 }, (_, index) => ({ ...episodes.items[0], content_id: `episode:empty:${season}:${index}`, season_number: season, episode_number: index + 1 })) } });
    });
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="episode:empty:1:0"]').waitFor();
    const edge = tv.page.locator('[data-focus="episode:empty:3:13"]'); await edge.waitFor();
    await edge.focus(); await tv.jump(100);
    await tv.eventually(async () => reads.includes(4), "the one boundary read finishes");
    for (let index = 0; index < 4; index++) await tv.jump(100);
    assert.deepEqual([...reads].sort(), [1, 2, 3, 4], "restoring the same edge never chains into further empty seasons");
    assert.equal(await tv.focused(), "episode:empty:3:13");
});

detailTest("Episode rail reaches both screen edges, masks the lookbehind, and keeps scroll steps", async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog);
    const body = catalog.route('GET', '/catalog/series/series%3As1/seasons/1/episodes', 'p-owner')?.body as { items: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons/1/episodes?**', route => route.fulfill({ json: { items: Array.from({ length: 8 }, (_, index) => ({ ...body.items[0], content_id: `episode:edge${index}`, episode_number: index + 1 })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="episode:edge7"]').waitFor(); await tv.jump(500);
    const bounds = await readLive(tv, () => {
        const row = document.querySelector(".details-episodes");
        if (!(row instanceof HTMLElement) || !row.isConnected) return null;
        row.scrollLeft = 150;
        const art = row.querySelector(".browse-art")?.getBoundingClientRect();
        if (art === undefined) return null;
        const box = row.getBoundingClientRect();
        const y = art.y + art.height / 2;
        return {
            left: box.left,
            right: box.right,
            masked: document.elementFromPoint(1, y)?.closest("[data-focus]")?.getAttribute("data-focus") ?? null,
            visible: document.elementFromPoint(120, y)?.closest("[data-focus]")?.getAttribute("data-focus") ?? null,
        };
    }, null, value => value.left === 0 && value.right === 1920 && value.masked !== "episode:edge0" && value.visible === "episode:edge0", "episode rail masks the 100px lookbehind");
    assert.equal(bounds.left, 0);
    assert.equal(bounds.right, 1920);
    assert.equal(bounds.masked, null, JSON.stringify(bounds));
    assert.equal(bounds.visible, "episode:edge0", JSON.stringify(bounds));
    await tv.page.locator('[data-focus="episode:edge0"]').focus(); await tv.jump(500);
    assert.equal(await readLive(tv, () => {
        const row = document.querySelector(".details-episodes");
        if (!(row instanceof HTMLElement) || !row.isConnected) return null;
        return row.scrollLeft;
    }, null, value => value === 0, "edge focus restores scroll"), 0);
    await tv.remote(39); await tv.jump(500);
    assert.equal(await readLive(tv, () => {
        const row = document.querySelector(".details-episodes");
        if (!(row instanceof HTMLElement) || !row.isConnected) return null;
        return row.scrollLeft;
    }, null, value => value === 400, "one remote step scrolls 400"), 400);
    const lastVisible = await readLive(tv, () => {
        const row = document.querySelector(".details-episodes");
        const art = row?.querySelector(".browse-art")?.getBoundingClientRect();
        if (row === null || row === undefined || art === undefined || !row.isConnected) return null;
        return document.elementFromPoint(1919, art.y + art.height / 2)?.closest("[data-focus]")?.getAttribute("data-focus") ?? null;
    }, null, value => value === "episode:edge5", "right edge still");
    assert.equal(lastVisible, "episode:edge5");
});

detailTest("Episode resume bar uses TVEpisodeRail's exact bottom edge metrics and visibility rules", async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog);
    const body = catalog.route('GET', '/catalog/series/series%3As1/seasons/1/episodes', 'p-owner')?.body as { items: Record<string, unknown>[] };
    const states = [
        { played: false, position_seconds: 60, duration_seconds: 240 },
        { played: true, position_seconds: 60, duration_seconds: 240 },
        { played: false, position_seconds: 0, duration_seconds: 240 },
        { played: false, position_seconds: 240, duration_seconds: 240 },
        { played: false, position_seconds: 300, duration_seconds: 240 },
        { played: false, position_seconds: 60, duration_seconds: 0 },
        { played: false, position_seconds: 60 },
    ];
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons/1/episodes?**', route => route.fulfill({ json: { items: states.map((user_data, index) => ({ ...body.items[0], content_id: `episode:progress${index}`, episode_number: index + 1, user_data })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="episode:progress0"]').waitFor();
    assert.equal(await tv.page.locator('.details-episodes .skyline-progress').count(), 2);
    const progress = { height: "5px", bottom: "0px", left: "0px", right: "0px", background: "rgba(0, 0, 0, 0.6)", fill: "rgb(255, 255, 255)", width: "25%" };
    for (const index of [0, 1]) {
        const metrics = await readLive(tv, episode => {
            const node = document.querySelector(`[data-focus="episode:progress${episode}"] .skyline-progress`);
            const fill = node?.firstElementChild;
            if (node === null || fill === null || fill === undefined || !node.isConnected) return null;
            const style = getComputedStyle(node);
            return { height: style.height, bottom: style.bottom, left: style.left, right: style.right, background: style.backgroundColor, fill: getComputedStyle(fill).backgroundColor, width: fill instanceof HTMLElement ? fill.style.width : "" };
        }, index, value => value.height === "5px" && value.bottom === "0px" && value.left === "0px" && value.right === "0px" && value.background === "rgba(0, 0, 0, 0.6)" && value.fill === "rgb(255, 255, 255)" && value.width === "25%", "resume bar metrics");
        assert.deepEqual(metrics, progress);
    }
});

detailTest("Final season E05 clamps with one successor while start and interior anchors remain bounded", async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog);
    const seasons = catalog.route('GET', '/catalog/series/series%3As1/seasons', 'p-owner')?.body as { items: Record<string, unknown>[] };
    const episodes = catalog.route('GET', '/catalog/series/series%3As1/seasons/1/episodes', 'p-owner')?.body as { items: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons?**', route => route.fulfill({ json: { items: [13, 14].map(season => ({ ...seasons.items[0], content_id: `season:${season}`, season_number: season, episode_count: season === 13 ? 10 : 6, user_data: { played: season === 13, in_progress_count: season === 14 ? 1 : 0 } })) } }));
    for (const season of [13, 14]) await tv.page.route(`**/api/v2/catalog/series/series%3As1/seasons/${season}/episodes?**`, route => route.fulfill({ json: { items: Array.from({ length: season === 13 ? 10 : 6 }, (_, index) => ({ ...episodes.items[0], content_id: `episode:s${season}e${index + 1}`, season_number: season, episode_number: index + 1, user_data: { played: season === 13 || index < 4, playback_position_seconds: season === 14 && index === 4 ? 60 : 0 } })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="episode:s13e10"]').waitFor();
    const card = (id: string) => tv.page.locator(`[data-focus="episode:${id}"]`);
    await card('s14e5').focus(); await tv.jump(1500);
    const end = await readLive(tv, liveRail, null, value => {
        const last = value.cards[14];
        const next = value.cards[15];
        return last !== undefined && next !== undefined && Math.abs(last.frameX - 1158) < 2 && Math.abs(last.x - 1151) < 2 && Math.abs(next.right - 1817) < 2 && value.scroll === 3846;
    }, "E05 focus lift settled");
    // Keep painted focus bounds separate from the unscaled frame.
    // Integer scrollLeft rounds the 3845.6px terminal offset to 3846px.
    // The slot is one spacing to the right of the old 100 + hover inset.
    assert.ok(Math.abs(end.cards[14]!.frameX - 1158) < 2, JSON.stringify(end));
    assert.ok(Math.abs(end.cards[14]!.x - 1151) < 2, JSON.stringify(end));
    assert.ok(Math.abs(end.cards[15]!.right - 1817) < 2, JSON.stringify(end));
    assert.equal(end.scroll, 3846);
    await settledEpisodePrefetch(tv);
    const seasonReads = (): number => tv.fake.requests.filter(request => request.path.includes('/seasons')).length;
    const reads = seasonReads();
    await card('s13e5').focus(); await tv.jump(500);
    const middle = await readLive(tv, liveRail, null, value => {
        const card = value.cards[4];
        return card !== undefined && Math.abs(card.x - 102) < 2 && Math.abs(value.scroll - 1398.4) < 1;
    }, "interior focus lift settled");
    assert.ok(Math.abs(middle.cards[4]!.x - 102) < 2, JSON.stringify(middle));
    assert.ok(Math.abs(middle.scroll - 1398.4) < 1, JSON.stringify(middle));
    // Compact still about 310px at 1.05. The window includes Season 13, the series start, so the slot is 40px left: still 102, ring 100, layout 110. The previous card ends at 70, under the mask, and its watched tick stays there too.
    const anchored = await readLive(tv, () => {
        const row = document.querySelector(".details-episodes");
        const focused = row?.querySelector(":focus");
        const art = focused?.querySelector(".browse-art");
        const previous = focused?.previousElementSibling;
        const previousArt = previous?.querySelector(".browse-art");
        const badge = previous?.querySelector(".browse-watched");
        if (!(art instanceof HTMLElement) || !(focused instanceof HTMLElement) || !(previous instanceof HTMLElement) || !(previousArt instanceof HTMLElement) || !(badge instanceof HTMLElement)) return null;
        const still = art.getBoundingClientRect();
        const frame = focused.getBoundingClientRect();
        const prev = previousArt.getBoundingClientRect();
        const y = still.top + still.height / 2;
        const outline = parseFloat(getComputedStyle(art).outlineWidth);
        const outlineOffset = parseFloat(getComputedStyle(art).outlineOffset);
        const sliverX = 100 + (prev.right - 100) / 2;
        const sliverHit = document.elementFromPoint(sliverX, y);
        const outside = document.elementFromPoint(70, y);
        return {
            still: still.left, frame: frame.left, ring: still.left - (outline + outlineOffset),
            previousRight: prev.right, badgeRight: badge.getBoundingClientRect().right,
            sliver: sliverHit !== null && previous.contains(sliverHit),
            clipped: outside === null || !previous.contains(outside),
        };
    }, null, value => Math.abs(value.still - 102) < 2 && Math.abs(value.frame - 110) < 2 && Math.abs(value.ring - 100) < 2 && Math.abs(value.previousRight - 70) < 2 && !value.sliver && value.clipped && value.badgeRight <= 100, "compact series-start slot hides the previous card");
    assert.ok(Math.abs(anchored.still - 102) < 2, JSON.stringify(anchored));
    assert.ok(Math.abs(anchored.frame - 110) < 2, JSON.stringify(anchored));
    assert.ok(Math.abs(anchored.ring - 100) < 2, JSON.stringify(anchored));
    assert.ok(Math.abs(anchored.previousRight - 70) < 2, JSON.stringify(anchored));
    assert.equal(anchored.sliver, false, JSON.stringify(anchored));
    assert.equal(anchored.clipped, true, JSON.stringify(anchored));
    assert.ok(anchored.badgeRight <= 100, JSON.stringify(anchored));
    await card('s13e1').focus(); await tv.jump(500); await tv.remote(37);
    const start = await readLive(tv, liveRail, null, value => {
        const card = value.cards[0];
        return card !== undefined && value.scroll === 0 && Math.abs(card.frameX - 109.7) < 1 && Math.abs(card.x - 102) < 2;
    }, "first focus lift settled");
    assert.equal(start.scroll, 0);
    assert.ok(Math.abs(start.cards[0]!.frameX - 109.7) < 1, JSON.stringify(start));
    assert.ok(Math.abs(start.cards[0]!.x - 102) < 2, JSON.stringify(start));
    assert.equal(await tv.focused(), 'episode:s13e1');
    assert.equal(seasonReads(), reads, 'loaded neighbour and interior focus start no season reads');
    await card('s14e6').focus(); await tv.jump(800);
    // Last focused still about 1823, ring 1826. The 40px series-start shift moves the terminal edge with the slot.
    const terminal = await readLive(tv, () => {
        const art = document.querySelector(".details-episodes :focus .browse-art");
        if (!(art instanceof HTMLElement) || !art.isConnected) return null;
        const box = art.getBoundingClientRect();
        const extension = parseFloat(getComputedStyle(art).outlineWidth) + parseFloat(getComputedStyle(art).outlineOffset);
        return { right: box.right, ring: box.right + extension, width: box.width };
    }, null, value => value.width > 320 && Math.abs(value.right - 1823) < 3 && Math.abs(value.ring - 1826) < 3, "last focused episode right edge");
    assert.ok(Math.abs(terminal.right - 1823) < 3, JSON.stringify(terminal));
    assert.ok(Math.abs(terminal.ring - 1826) < 3, JSON.stringify(terminal));
}, 'compact');

detailTest("Apple loaded-season window rebases E05 and retains remote focus across its boundaries", async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const seasonBody = catalog.route('GET', '/catalog/series/series%3As1/seasons', 'p-owner')?.body as { items: Record<string, unknown>[] };
    const episodeBody = catalog.route('GET', '/catalog/series/series%3As1/seasons/1/episodes', 'p-owner')?.body as { items: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons?**', route => route.fulfill({ json: { items: [13, 14].map(season => ({ ...seasonBody.items[0], content_id: `season:${season}`, season_number: season, episode_count: season === 13 ? 10 : 14, user_data: { played: season === 13, in_progress_count: season === 14 ? 1 : 0 } })) } }));
    for (const season of [13, 14]) await tv.page.route(`**/api/v2/catalog/series/series%3As1/seasons/${season}/episodes?**`, route => route.fulfill({ json: { items: Array.from({ length: season === 13 ? 10 : 14 }, (_, index) => ({ ...episodeBody.items[0], content_id: `episode:s${season}e${index + 1}`, season_number: season, episode_number: index + 1, user_data: { played: season === 13 || index < 4, playback_position_seconds: season === 14 && index === 4 ? 60 : 0 } })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="episode:s13e10"]').waitFor();
    const scrollTo = (expected: number, what: string) => readLive(tv, liveScroll, null, value => value === expected, what);
    assert.equal(await scrollTo(5600, "resume E05 rebased after ten predecessors"), 5600);
    assert.equal(await readLive(tv, () => {
        const node = document.querySelector('[data-focus="episode:s14e5"]');
        if (node === null || !node.isConnected) return null;
        return node.getBoundingClientRect().x;
    }, null, value => value === 111, "E05 frame x when the window includes the first season"), 111);
    await tv.page.locator('[data-focus="episode:s14e5"]').focus();
    await tv.jump(1500);
    await settledEpisodePrefetch(tv);
    const seasonReads = (): number => tv.fake.requests.filter(request => request.path.includes('/seasons')).length;
    const reads = seasonReads();
    await tv.remote(37);
    assert.equal(await tv.focused(), 'episode:s14e4');
    await tv.jump(400);
    assert.equal(await scrollTo(5200, "one step back stays in the loaded window"), 5200);
    await tv.remote(39);
    await tv.jump(400);
    assert.equal(await tv.focused(), 'episode:s14e5');
    assert.equal(await scrollTo(5600, "return to E05 restores its offset"), 5600);
    await tv.remote(40);
    await tv.remote(38);
    assert.equal(await tv.focused(), 'episode:s14e5', 'return from Cast retains episode identity');
    await tv.page.locator('[data-focus="episode:s14e14"]').focus();
    await tv.jump(400);
    assert.equal(await scrollTo(8000, "last episode stays in the terminal group"), 8000);
    await tv.remote(39);
    assert.equal(await tv.focused(), 'episode:s14e14');
    assert.equal(seasonReads(), reads, 'ordinary moves and terminal focus make no season reads');
    await tv.page.locator('[data-focus="season:13"]').click();
    await tv.page.locator('[data-focus="episode:s13e1"][aria-current="true"]').waitFor();
    await tv.remote(40);
    assert.equal(await tv.focused(), 'episode:s13e1');
    await tv.jump(400);
    assert.equal(await scrollTo(0, "reselected season opens at the start"), 0);
    await tv.remote(37);
    assert.equal(await tv.focused(), 'episode:s13e1');
    await tv.page.locator('[data-focus="episode:s14e1"]').focus();
    assert.equal(await tv.page.locator('[data-focus="season:14"]').getAttribute('aria-pressed'), 'true');
    await tv.remote(37);
    assert.equal(await tv.focused(), 'episode:s13e10', 'Left crosses the loaded season boundary');
    assert.equal(await tv.page.locator('[data-focus="season:13"]').getAttribute('aria-pressed'), 'true');
});

for (const current of [1, 5]) detailTest(`Measured five-card episode rail with E0${current} current`, async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const body = catalog.route('GET', '/catalog/series/series%3As1/seasons/1/episodes', 'p-owner')?.body as { items: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons/2/episodes?**', route => route.fulfill({ json: { items: [] } }));
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons/1/episodes?**', route => route.fulfill({ json: { items: Array.from({ length: 5 }, (_, i) => ({ ...body.items[0], content_id: `episode:s1e1${i + 1}`, episode_number: i + 1, user_data: { played: i + 1 < current, playback_position_seconds: i + 1 === current ? 60 : 0 } })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="episode:s1e15"]').waitFor();
    await tv.page.evaluate(() => document.fonts.ready);
    const rest = await readLive(tv, liveRail, null, value => {
        const card = value.cards[0];
        return card !== undefined && Math.abs(card.width - 360) < 1 && value.scroll === (current === 1 ? 0 : 400);
    }, "resting five-card rail");
    await tv.page.locator('[data-focus="episode:s1e11"]').focus();
    await tv.jump(500);
    const lifted = await readLive(tv, liveRail, null, value => {
        const card = value.cards[0];
        return card !== undefined && card.width > 377 && Math.abs(card.x - 102) < 2;
    }, "first card lift settled");
    assert.ok(Math.abs(lifted.cards[0]!.x - 102) < 2);
    await tv.page.locator('[data-focus="episode:s1e15"]').focus();
    await tv.jump(500);
    const focused = await readLive(tv, liveRail, null, value => {
        const card = value.cards[4];
        return card !== undefined && card.width > 377 && Math.abs(card.x - 1302) < 2;
    }, "E05 lift settled");
    assert.ok(Math.abs(rest.cards[0]!.width - 360) < 1, JSON.stringify(rest));
    assert.equal(rest.scroll, current === 1 ? 0 : 400);
    assert.ok(Math.abs(focused.cards[4]!.x - 1302) < 2, JSON.stringify(focused));
});

for (const art of [
    { type: 'series', id: 'series:s1', width: 650, height: 102, top: 174 },
    { type: 'movie', id: 'movie:m0001', width: 468, height: 160, top: 116 },
] as const) detailTest(`${art.type} title art retains Apple's measured Details geometry`, async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const body = catalog.route('GET', `/catalog/items/${encodeURIComponent(art.id)}`, 'p-owner')?.body;
    await tv.page.route(`**/api/v2/catalog/items/${encodeURIComponent(art.id)}?**`, route => route.fulfill({ json: { ...body as Record<string, unknown>, logo_url: '/art/measured-logo.svg' } }));
    await tv.page.route('**/art/measured-logo.svg*', route => route.fulfill({
        status: 200, contentType: 'image/svg+xml',
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="${art.width}" height="${art.height}"><rect width="100%" height="100%" fill="white"/></svg>`,
    }));
    await tv.page.locator(`[data-section="recently_added"] [data-focus="${art.id}"]`).first().click();
    await tv.page.locator('.details-logo').waitFor();
    await tv.page.evaluate(() => document.fonts.ready);
    const expectedArt = { top: art.top, width: art.width, height: art.height, slotTop: 116, slotHeight: 160 };
    const geometry = await readLive(tv, () => {
        const node = document.querySelector(".details-logo");
        if (!(node instanceof HTMLImageElement) || !node.isConnected || !node.complete || node.naturalWidth === 0 || node.parentElement === null) return null;
        const rect = node.getBoundingClientRect();
        const slot = node.parentElement.getBoundingClientRect();
        return { top: rect.top, width: rect.width, height: rect.height, slotTop: slot.top, slotHeight: slot.height };
    }, null, value => (["top", "width", "height", "slotTop", "slotHeight"] as const).every(key => Math.abs(value[key] - expectedArt[key]) < 0.5), "title art geometry");
    for (const [key, expected] of Object.entries({ top: art.top, width: art.width, height: art.height, slotTop: 116, slotHeight: 160 })) {
        assert.ok(Math.abs(geometry[key as keyof typeof geometry] - expected) < 0.5, `${key}: ${JSON.stringify(geometry)}`);
    }
});

detailTest('Hero uses measured series colours and genres only at rest', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="audio"]').waitFor();
    assert.equal(await readLive(tv, () => {
        const nodes = [...document.querySelectorAll(".details-editorial .browse-meta")];
        if (nodes.length !== 1 || nodes[0] === undefined || !nodes[0].isConnected) return null;
        return getComputedStyle(nodes[0]).color;
    }, null, value => value === "rgb(225, 227, 228)", "series metadata colour after optional-data repaint"), "rgb(225, 227, 228)");
    assert.equal(await tv.page.locator('.details-genres').count(), 1);
    assert.equal(await readLive(tv, () => {
        const overview = document.querySelector(".details-editorial .browse-overview");
        if (overview === null || !overview.isConnected) return null;
        return getComputedStyle(overview).color;
    }, null, value => value === "rgba(255, 255, 255, 0.92)", "series overview colour"), "rgba(255, 255, 255, 0.92)");
    await tv.page.locator('[data-focus="audio"]').focus();
    assert.equal(await readLive(tv, () => {
        const node = document.querySelector(".details-play");
        if (node === null || !node.isConnected) return null;
        return getComputedStyle(node).backgroundColor;
    }, null, value => value === "rgba(255, 255, 255, 0.1)", "unfocused Play fill"), "rgba(255, 255, 255, 0.1)");
    assert.equal(await readLive(tv, () => {
        const node = document.querySelector(".details-playback-summary strong");
        if (node === null || !node.isConnected) return null;
        return getComputedStyle(node).color;
    }, null, value => value === "rgba(237, 237, 237, 0.5)", "playback summary label"), "rgba(237, 237, 237, 0.5)");
});

detailTest('track picker truncates a long version title within its 76px row', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const body = catalog.route('GET', '/catalog/items/movie%3Am0001', 'p-owner')?.body as { versions: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/items/movie%3Am0001?**', route => route.fulfill({ json: { ...body, versions: body.versions.map(file => ({ ...file, codec_video: 'Extended Commentary Codec '.repeat(20) })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="version"]').click();
    const row = tv.page.locator('[data-focus="version:42"]');
    assert.equal(await row.locator('.details-option-title').count(), 1);
    const title = await readLive(tv, () => {
        const title = document.querySelector('[data-focus="version:42"] .details-option-title');
        const option = document.querySelector('[data-focus="version:42"]');
        if (!(title instanceof HTMLElement) || !(option instanceof HTMLElement) || !title.isConnected || !option.isConnected) return null;
        return { overflow: getComputedStyle(title).textOverflow, clipped: title.scrollWidth > title.clientWidth, height: option.offsetHeight };
    }, null, value => value.overflow === "ellipsis" && value.clipped && value.height === 76, "version row");
    assert.equal(title.overflow, "ellipsis");
    assert.ok(title.clipped);
    assert.equal(title.height, 76);
});

detailTest('measured Apple movie typography and version popover geometry', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="version"]').focus();
    const styles = await readLive(tv, () => {
        const node = document.querySelector(".details-editorial .browse-overview");
        if (node === null || !node.isConnected) return null;
        const style = getComputedStyle(node);
        return { color: style.color, maxHeight: style.maxHeight, lineHeight: style.lineHeight };
    }, null, value => value.color === "rgba(255, 255, 255, 0.92)" && value.maxHeight === "102px" && value.lineHeight === "34px", "overview style sample survives optional-data repaint");
    assert.deepEqual(styles, { color: "rgba(255, 255, 255, 0.92)", maxHeight: "102px", lineHeight: "34px" });
    await tv.page.locator('[data-focus="version"]').click();
    assert.equal(await readLive(tv, () => {
        const node = document.querySelector('[data-focus="version"] .details-action-label');
        if (node === null || !node.isConnected) return null;
        return getComputedStyle(node).position;
    }, null, value => value === "static", "version label position"), "static");
    const opened = await readLive(tv, () => {
        const panel = document.querySelector(".details-track-popover");
        const row = document.querySelector('[data-focus="version:auto"]');
        if (panel === null || row === null || !panel.isConnected || !row.isConnected) return null;
        const panelBox = panel.getBoundingClientRect();
        const rowBox = row.getBoundingClientRect();
        return { panelWidth: panelBox.width, rowWidth: rowBox.width, rowHeight: rowBox.height };
    }, null, value => Math.abs(value.panelWidth - 560) < .1 && value.rowWidth === 532 && value.rowHeight === 76, "popover opening animation settled");
    assert.equal(opened.panelWidth, 560);
    assert.equal(opened.rowWidth, 532);
    assert.equal(opened.rowHeight, 76);
});

detailTest('Details rail clearances and white focus styling follow the measured Apple layout', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-detail-section="related"] .browse-art').first().waitFor();
    await tv.page.locator('.details-facts .browse-section-title').waitFor();
    const metrics = await readLive(tv, () => {
        const related = document.querySelector('[data-detail-section="related"]');
        const previous = related?.previousElementSibling?.previousElementSibling;
        const facts = document.querySelector(".details-facts .browse-section-title");
        const caption = previous?.querySelector(".browse-card-subtitle");
        const title = related?.querySelector(".browse-card-title");
        const rail = related?.previousElementSibling;
        if (related === null || related === undefined || previous === null || previous === undefined || facts === null || caption === null || caption === undefined || title === null || title === undefined || rail === null || rail === undefined) return null;
        if (![related, previous, facts, caption, title, rail].every(node => node.isConnected)) return null;
        return {
            railGap: rail.getBoundingClientRect().top - caption.getBoundingClientRect().bottom,
            factsGap: facts.getBoundingClientRect().top - title.getBoundingClientRect().bottom,
        };
    }, null, value => Math.abs(value.railGap - 79) < 3 && Math.abs(value.factsGap - 76) < 3, "Details rail clearances");
    assert.ok(Math.abs(metrics.railGap - 79) < 3, JSON.stringify(metrics));
    assert.ok(Math.abs(metrics.factsGap - 76) < 3, JSON.stringify(metrics));
    await tv.page.locator('[data-focus="version"]').focus();
    await tv.jump(400);
    const versions = await readLive(tv, () => {
        const trigger = document.querySelector('[data-focus="version"]');
        const icon = trigger?.querySelector("svg");
        const label = trigger?.querySelector(".details-action-label");
        if (!(trigger instanceof HTMLElement) || icon === null || icon === undefined || label === null || label === undefined || !trigger.isConnected) return null;
        const style = getComputedStyle(trigger);
        const intrinsic = icon.getBoundingClientRect().width + label.getBoundingClientRect().width + parseFloat(style.columnGap) + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
        return { color: style.backgroundColor, width: trigger.getBoundingClientRect().width, intrinsic };
    }, null, value => value.color === "rgb(255, 255, 255)" && Math.abs(value.width - value.intrinsic) < 2, "focused Versions chip");
    assert.equal(versions.color, "rgb(255, 255, 255)");
    assert.ok(Math.abs(versions.width - versions.intrinsic) < 2, `Versions width ${versions.width}, intrinsic ${versions.intrinsic}`);
});

detailTest('Related posters omit status overlays enabled in profile settings', async tv => {
    new FakeSettings(tv.fake).profile().set(CARD_OVERLAYS_KEY, { version: 2, order: ['show_status'], items: { show_status: { enabled: true, position: 'top-right' } } });
    await tv.page.route('**/api/v2/recommendations/similar/**', route => route.fulfill({ json: { items: [{ content_id: 'series:related', type: 'series', title: 'Related Series', show_status: 'returning series' }] } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-detail-section="related"] .browse-card').waitFor();
    assert.equal(await tv.page.locator('[data-detail-section="related"] .card-overlay-layer').count(), 0);
    assert.equal(await tv.page.locator('[data-detail-section="related"]').getByText('RETURNING', { exact: false }).count(), 0);
});

detailTest('Series episode captions leave the measured 79px heading clearance', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('.details-episodes .browse-card-subtitle').first().waitFor();
    await tv.page.locator('.details-series-rail + *').waitFor();
    const gap = await readLive(tv, () => {
        const rail = document.querySelector(".details-series-rail");
        const caption = rail?.querySelector(".browse-card-subtitle");
        const next = rail?.nextElementSibling;
        if (rail === null || caption === null || caption === undefined || next === null || next === undefined || !rail.isConnected) return null;
        return next.getBoundingClientRect().top - caption.getBoundingClientRect().bottom;
    }, null, value => Math.abs(value - 79) < 3, "episode caption clearance");
    assert.ok(Math.abs(gap - 79) < 3, `episode caption clearance ${gap}`);
});

detailTest('Details picker selection uses a check without a resting fill', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="audio"]').click();
    await tv.page.locator('[data-focus="audio:0"]').focus();
    const selected = await readLive(tv, () => {
        const node = document.querySelector('[data-focus="audio:auto"]');
        if (node === null || !node.isConnected) return null;
        return { fill: getComputedStyle(node).backgroundColor, mark: getComputedStyle(node, "::before").content };
    }, null, value => value.fill === "rgba(0, 0, 0, 0)" && value.mark === '"✓"', "selected audio row");
    assert.equal(selected.fill, "rgba(0, 0, 0, 0)");
    assert.equal(selected.mark, '"✓"');
});

detailTest('Details More and Subtitles use white ellipsis and caption bubble glyphs', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="play"]').focus();
    assert.equal(await readLive(tv, () => {
        const node = document.querySelector('[data-focus="more"]');
        if (node === null || !node.isConnected) return null;
        return getComputedStyle(node).color;
    }, null, value => value === "rgb(255, 255, 255)", "More colour"), "rgb(255, 255, 255)");
    assert.equal(await tv.page.locator('[data-focus="subtitles"] svg').getAttribute('data-symbol'), 'captions.bubble');
});

detailTest('Down into an alternate season starts at its first episode and retargets the hero', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const reply = catalog.route('GET', '/catalog/series/series%3As1/seasons/2/episodes', 'p-owner');
    const body = reply?.body as { items: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons/2/episodes?**', route => route.fulfill({ json: { ...body, items: Array.from({ length: 14 }, (_, index) => ({ ...body.items[0], content_id: `episode:s1e2${index + 1}`, episode_number: index + 1, user_data: { played: index === 0, playback_position_seconds: index === 1 ? 60 : 0 } })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="season:2"]').focus();
    await tv.jump(100);
    await tv.page.locator('[data-focus="episode:s1e21"]').waitFor();
    await tv.remote(40);
    assert.equal(await tv.focused(), 'episode:s1e21');
    await tv.page.getByRole('button', { name: /Play S2:E1|Resume S2:E1/ }).waitFor();
    // The focused still sits at 100 + spacing + 2. The 9px hover growth is inside the slot.
    const settled = await readLive(tv, () => {
        const card = document.querySelector('[data-focus="episode:s1e21"]');
        const art = card?.querySelector(".browse-art")?.getBoundingClientRect();
        if (card === null || art === undefined || !card.isConnected || card !== document.activeElement) return null;
        const box = card.getBoundingClientRect();
        return { x: box.x, artX: art.x, artWidth: art.width };
    }, null, value => Math.abs(value.x - 111) < 1 && Math.abs(value.artX - 102) < 2 && Math.abs(value.artWidth - 378) < 1, "episode artwork settles at x102");
    assert.ok(Math.abs(settled.x - 111) < 1 && Math.abs(settled.artX - 102) < 2 && Math.abs(settled.artWidth - 378) < 1, JSON.stringify(settled));
});

detailTest('Selecting the already loaded season resets entry to E01 without another episode read', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="episode:s1e12"]').focus();
    await tv.page.getByRole('button', { name: /Play S1:E2|Resume S1:E2/ }).waitFor();
    const reads = tv.fake.requests.filter(request => request.path.includes('/episodes')).length;
    await tv.page.locator('[data-focus="season:1"]').click();
    await tv.remote(40);
    assert.equal(await tv.focused(), 'episode:s1e11');
    await tv.page.getByRole('button', { name: /Play S1:E1|Resume S1:E1/ }).waitFor();
    assert.equal(tv.fake.requests.filter(request => request.path.includes('/episodes')).length, reads);
});

detailTest('Select on the current season during its initial load supersedes resume entry', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const body = catalog.route('GET', '/catalog/series/series%3As1/seasons/1/episodes', 'p-owner')?.body as { items: Record<string, unknown>[] };
    let release: () => void = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons/1/episodes?**', async route => {
        await held;
        await route.fulfill({ json: { items: body.items.map((item, index) => ({ ...item, user_data: { played: index === 0 } })) } });
    });
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="season:1"]').click();
    release();
    await tv.page.locator('[data-focus="episode:s1e11"]').waitFor();
    await tv.remote(40);
    assert.equal(await tv.focused(), 'episode:s1e11');
});

detailTest('Select on a season before the opening Play claim settles keeps focus on that season', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const body = catalog.route('GET', '/catalog/series/series%3As1/seasons/1/episodes', 'p-owner')?.body as { items: Record<string, unknown>[] };
    let release: () => void = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons/1/episodes?**', async route => {
        await held;
        await route.fulfill({ json: { items: body.items } });
    });
    // The claim settles on a 50 ms timer; a paused clock keeps it open until the viewer selects a season.
    await pauseTvClock(tv);
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="season:1"]').click();
    release();
    await tv.page.locator('[data-focus="episode:s1e11"]').waitFor();
    assert.equal(await tv.focused(), 'season:1', 'the opening Play claim does not take focus back from a selected season');
    await tv.remote(40);
    assert.equal(await tv.focused(), 'episode:s1e11');
});

detailTest('Subtitle display order keeps original selection keys and separates language from format', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    catalog.subtitleFiles.set('42', [
        { language: 'fra', codec: 'subrip', title: 'SDH', index: 4 },
        { language: 'eng', codec: 'subrip', title: 'SDH', index: 5 },
        { language: 'fra', codec: 'subrip', index: 6 },
        { language: 'eng', codec: 'subrip', index: 7 },
    ]);
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="subtitles"]').click();
    assert.deepEqual(await tv.page.locator('.details-audio-options [data-focus^="subtitle:"]').allTextContents(), ['AutoUse your subtitle preferences', 'OffStart without subtitles', 'EnglishSRT', 'EnglishSRT · SDH', 'FrenchSRT', 'FrenchSRT · SDH']);
    assert.deepEqual(await tv.page.locator('.details-audio-options [data-focus^="subtitle:"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-focus'))), ['subtitle:auto', 'subtitle:off', 'subtitle:3', 'subtitle:1', 'subtitle:2', 'subtitle:0']);
});

detailTest('Auto audio marks its effective row with combined technical details', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const reply = catalog.route('GET', '/catalog/items/movie%3Am0001', 'p-owner');
    const body = reply?.body as { versions: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/items/movie%3Am0001?**', route => route.fulfill({ json: { ...body, versions: body.versions.map(file => ({ ...file, effective_audio_track_index: 0, audio_tracks: [{ language: 'eng', codec: 'eac3', channels: 6, default: true }] })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="audio"]').click();
    assert.equal(await tv.page.locator('[data-focus="audio:auto"]').getAttribute('aria-checked'), 'true');
    assert.equal(await tv.page.locator('[data-focus="audio:0"]').getAttribute('aria-checked'), 'true');
    assert.equal(await tv.page.locator('[data-focus="audio:0"] .details-option-subtext').textContent(), 'EAC3 · 5.1 · Default · Preferred');
});

detailTest('Details headings and selected season labels contribute painted pixels', async tv => {
    for (const [id, selector] of [['movie:m0001', '.browse-section-title'], ['series:s1', '[data-focus="season:1"]']] as const) {
        await tv.page.locator(`[data-section="recently_added"] [data-focus="${id}"]`).first().click();
        const target = tv.page.locator(selector).first();
        await target.waitFor();
        await tv.page.evaluate(() => document.fonts.ready);
        // page.screenshot clip uses the same box as boundingBox. getBoundingClientRect
        // is offset from that box when an ancestor is transformed, so a live read of
        // the rect photographs the wrong pixels. A detached node makes boundingBox
        // null; repeat until the connected node has one.
        let clip: { x: number; y: number; width: number; height: number } | null = null;
        await tv.eventually(async () => { clip = await target.boundingBox(); return clip !== null; }, "paint sample bounds survive optional-data repaint");
        assert.ok(clip);
        const painted = await tv.page.screenshot({ animations: 'disabled', clip });
        const hiddenText = await tv.page.addStyleTag({ content: `${selector} { color: transparent !important; }` });
        const hidden = await tv.page.screenshot({ animations: 'disabled', clip });
        await hiddenText.evaluate(node => node.parentNode?.removeChild(node));
        const changed = await tv.page.evaluate(async ([a, b]) => {
            const pixels = async (data: string): Promise<Uint8ClampedArray> => {
                const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
                const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
                const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
                return context.getImageData(0, 0, image.width, image.height).data;
            };
            const first = await pixels(a!), second = await pixels(b!);
            return first.reduce((count, value, index) => count + (Math.abs(value - second[index]!) > 20 ? 1 : 0), 0);
        }, [painted.toString('base64'), hidden.toString('base64')]);
        assert.ok(changed > 100, `${selector} must paint text, changed channels: ${changed}`);
        await tv.remote(10009);
    }
});

detailTest('Series opens on Play and season Select retains the pill until Down', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('.details-episodes [data-focus="episode:s1e11"]').waitFor();
    assert.equal(await tv.focused(), 'next-episode');
    assert.match(await tv.page.locator('.details-editorial .browse-meta').textContent() ?? '', /Seasons/);
    await tv.page.locator('[data-focus="season:2"]').click();
    await tv.page.locator('[data-focus="episode:s1e21"]').waitFor();
    assert.equal(await tv.focused(), 'season:2');
    await tv.remote(38);
    assert.equal(await tv.focused(), 'next-episode');
    await tv.remote(40);
    await tv.remote(40);
    assert.equal(await tv.focused(), 'episode:s1e21');
    await tv.page.getByRole('button', { name: /Play S2:E1|Resume S2:E1/ }).waitFor();
    await tv.remote(38);
    assert.equal(await tv.focused(), 'season:2');
});

detailTest('A delayed selected season does not steal focus after further remote navigation', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="episode:s1e11"]').waitFor();
    const held = tv.fake.hold('/catalog/series/series%3As1/seasons/2/episodes', true);
    await tv.page.locator('[data-focus="season:2"]').click();
    await tv.remote(38);
    const focused = await tv.focused();
    held.release();
    await tv.page.locator('[data-focus="episode:s1e21"]').waitFor();
    assert.equal(await tv.focused(), focused);
});

detailTest('Up returns to a selected season beyond the visible pill window and reveals it', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const reply = catalog.route('GET', '/catalog/series/series%3As1/seasons', 'p-owner');
    const body = reply?.body as { items: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons?**', route => route.fulfill({ json: { items: Array.from({ length: 14 }, (_, index) => ({ ...body.items[0], content_id: `season:long${index + 1}`, season_number: index + 1, title: `Season ${index + 1}` })) } }));
    const episodes = catalog.route('GET', '/catalog/series/series%3As1/seasons/1/episodes', 'p-owner')?.body as { items: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons/14/episodes?**', route => route.fulfill({ json: { items: episodes.items.map((episode, index) => ({ ...episode, content_id: `episode:s14e${index + 1}`, season_number: 14 })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="season:14"]').click();
    await tv.page.locator('.details-episodes [data-focus]').first().waitFor();
    assert.equal(await tv.focused(), 'season:14');
    await tv.remote(40);
    await tv.remote(38);
    assert.equal(await tv.focused(), 'season:14');
    const pill = await readLive(tv, () => {
        const node = document.querySelector('[data-focus="season:14"]');
        const row = node?.parentElement;
        if (node === null || row === null || row === undefined || !node.isConnected) return null;
        const rect = node.getBoundingClientRect();
        const bounds = row.getBoundingClientRect();
        return { left: rect.left, right: rect.right, rowLeft: bounds.left, rowRight: bounds.right };
    }, null, value => value.left >= value.rowLeft && value.right <= value.rowRight, "selected pill revealed");
    assert.ok(pill.left >= pill.rowLeft && pill.right <= pill.rowRight, JSON.stringify(pill));
});

detailTest('Movie never reserves a next-episode error and exposes a facts table', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    assert.equal(await tv.page.getByText('Could not load the next episode.', { exact: true }).count(), 0);
    assert.equal(await tv.page.locator('.details-facts dt').first().textContent(), 'DIRECTOR');
    assert.equal(await tv.page.getByRole('heading', { name: 'Related Movies', exact: true }).count(), 1);
});

for (const failed of [true, false]) detailTest(`Related ${failed ? 'failure' : 'empty result'} omits the rail and its focus stops`, async tv => {
    await tv.page.route('**/api/v2/recommendations/similar/movie%3Am0001?**', route => route.fulfill(failed ? { status: 500 } : { json: { items: [] } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="watchlist"]').waitFor();
    await tv.eventually(async () => await tv.page.getByText('Loading related titles.', { exact: true }).count() === 0, 'related response accepted');
    assert.equal(await tv.page.getByText('Could not load related titles.', { exact: true }).count(), 0);
    assert.equal(await tv.page.locator('[data-focus="retry-related"]').count(), 0);
    assert.equal(await tv.page.getByRole('heading', { name: 'Related Movies', exact: true }).count(), 0);
    assert.equal(await tv.page.locator('[data-detail-section="related"]').count(), 0);
});

detailTest('Genres have spacing on unrated Movies and stay omitted in the Series episode hero', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    for (const id of ['movie:m0001', 'series:s1']) {
        const reply = catalog.route('GET', `/catalog/items/${encodeURIComponent(id)}`, 'p-owner');
        const body = reply?.body as Record<string, unknown>;
        await tv.page.route(`**/api/v2/catalog/items/${encodeURIComponent(id)}?**`, route => route.fulfill({ json: { ...body, ratings: [], genres: ['Drama', 'Thriller', 'Mystery'] } }));
        await tv.page.locator(`[data-section="recently_added"] [data-focus="${id}"]`).first().click();
        await tv.page.locator('.details-genres').waitFor();
        assert.equal(await tv.page.locator('.details-genres').textContent(), 'Drama, Thriller');
        if (id === 'series:s1') await tv.page.locator('[data-focus="episode:s1e11"]').focus();
        const text = await tv.page.locator('.details-editorial .browse-meta').textContent() ?? '';
        assert.equal(text.split('Drama').length - 1, id === 'series:s1' ? 0 : 1);
        // A details repaint detaches the genres node between locator resolution and evaluate.
        // The replacement row is already painted with the divider; read that live node.
        if (id !== 'series:s1') assert.equal(await readLive(tv, () => {
            const node = document.querySelector('.details-genres');
            if (!(node instanceof HTMLElement) || !node.isConnected) return null;
            return getComputedStyle(node, '::before').content;
        }, null, value => value === '"·"', 'genre divider on the settled metadata row'), '"·"');
        await tv.remote(10009);
    }
});

detailTest('Movie uses rounded runtime, rating artwork, comma genres and compact resolved readouts', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const reply = catalog.route('GET', '/catalog/items/movie%3Am0001', 'p-owner');
    const body = reply?.body as { versions: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/items/movie%3Am0001?**', route => route.fulfill({ json: {
        ...body, genres: ['Drama', 'Thriller'], ratings: [{ name: 'TMDB', display: '6.8' }],
        versions: body.versions.map(version => ({ ...version, duration: 6599, resolution: '1080p', codec_video: 'h264', codec_audio: 'eac3', effective_audio_track_index: 0, audio_tracks: [{ default: true, language: 'en', codec: 'eac3', channels: 6, title: 'ATSC A/52B (AC-3, E-AC-3)' }] })),
    } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    assert.match(await tv.page.locator('.details-editorial .browse-meta').textContent() ?? '', /1h 50m.*6.8.*Drama, Thriller/);
    assert.equal(await tv.page.locator('.details-external-rating img').getAttribute('alt'), 'TMDB');
    assert.equal(await tv.page.locator('[data-track-summary="version"] span').textContent(), 'Auto · 1080p · HDR');
    assert.equal(await tv.page.locator('[data-track-summary="audio"] span').textContent(), 'Auto · English · EAC3 · 5.1');
    assert.equal(await readLive(tv, () => {
        const node = document.querySelector(".details-editorial .browse-title");
        if (node === null || !node.isConnected) return null;
        return node.getBoundingClientRect().y;
    }, null, value => value === 116, "title retains the y116 anchor after optional-data repaint"), 116);
});

detailTest('Auto subtitle readout resolves forced tracks using effective and explicitly selected audio', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const body = catalog.route('GET', '/catalog/items/movie%3Am0001', 'p-owner')?.body as { versions: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/items/movie%3Am0001?**', route => route.fulfill({ json: {
        ...body, effective_subtitle_mode: 'auto', effective_subtitle_language: 'en', effective_show_forced_subtitles: true,
        versions: body.versions.map(version => ({ ...version, effective_audio_track_index: 0,
            audio_tracks: [{ default: true, language: 'en', codec: 'aac' }, { default: false, language: 'ja', codec: 'aac' }],
            subtitle_tracks: [{ language: 'en', title: 'Dialogue', codec: 'subrip', external: false, forced: false }, { language: 'en', codec: 'subrip', external: false, forced: true }, { language: 'ja', codec: 'subrip', external: false, forced: true }],
        })),
    } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    const summary = tv.page.locator('[data-track-summary="subtitles"] span');
    assert.match(await summary.textContent() ?? '', /Auto · English.*Forced/);
    await tv.page.locator('[data-focus="audio"]').click();
    await tv.page.locator('[data-focus="audio:1"]').click();
    assert.match(await summary.textContent() ?? '', /Auto · English.*Dialogue/);
    assert.doesNotMatch(await summary.textContent() ?? '', /Forced/);
});

detailTest('Season hero and playback controls precede the episode list', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="series:s1-S1"]').click();
    await tv.page.locator('.browse-episodes').waitFor();
    assert.equal(await readLive(tv, () => {
        const hero = document.querySelector(".details-hero");
        const episodes = document.querySelector(".browse-episodes");
        if (hero === null || episodes === null || !hero.isConnected || !episodes.isConnected) return null;
        return Boolean(hero.compareDocumentPosition(episodes) & Node.DOCUMENT_POSITION_FOLLOWING);
    }, null, value => value, "season hero precedes the episode list"), true);
});

detailTest('Season primary playback refreshes a shared Auto change from another episode information page', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    let off = true;
    for (const id of ['episode:s1e11', 'episode:s1e12']) {
        const body = catalog.route('GET', `/catalog/items/${encodeURIComponent(id)}`, 'p-owner')?.body as Record<string, unknown>;
        await tv.page.route(`**/api/v2/catalog/items/${encodeURIComponent(id)}?**`, route => route.fulfill({ json: { ...body, effective_subtitle_mode: off ? 'off' : 'auto', effective_show_forced_subtitles: false } }));
    }
    await tv.page.route('**/api/v2/subtitle-prefs/**', route => {
        if (route.request().method() === 'DELETE') { off = false; return route.fulfill({ status: 204 }); }
        return route.fulfill(off ? { json: { series_id: 'series:s1', subtitle_mode: 'off', subtitle_track_index: -1 } } : { status: 404 });
    });
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="series:s1-S1"]').click();
    await tv.page.locator('[data-focus="episode:s1e12"]').click({ button: 'right' });
    await tv.page.locator('[data-focus="episode-information"]').click();
    await tv.page.locator('[data-focus="subtitles"]').click();
    await tv.page.locator('[data-focus="subtitle:auto"]').click();
    await tv.page.getByText('Saving subtitle preference…', { exact: true }).waitFor({ state: 'hidden' });
    await tv.remote(10009);
    await tv.page.locator('.browse-episodes').waitFor();
    await tv.page.locator('[data-focus="next-episode"]').click();
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.plays.length > 0), 'season primary handoff');
    assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.at(-1)?.subtitle?.kind), 'auto');
});

for (const [kind, id] of [['Movie', 'movie:m0001'], ['Episode', 'episode:s1e11'], ['Season', 'series:s1-S1']] as const) detailTest(`Long ${kind} titles keep every playback action inside a revealable hero`, async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const body = catalog.route('GET', `/catalog/items/${encodeURIComponent(id)}`, 'p-owner')?.body as Record<string, unknown>;
    await tv.page.route(`**/api/v2/catalog/items/${encodeURIComponent(id)}?**`, route => route.fulfill({ json: { ...body,
        title: `${'A Very Long Movie Title That Wraps Across Multiple Lines '.repeat(4)}: ${'The Complete Extended Story '.repeat(4)}`, logo_url: undefined,
        overview: 'A long synopsis with enough words to wrap across three lines. '.repeat(8),
    } }));
    if (kind === 'Movie') await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    else {
        await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
        if (kind === 'Episode') {
            await tv.page.locator('[data-focus="episode:s1e11"]').click({ button: 'right' });
            await tv.page.locator('[data-focus="episode-information"]').click();
        } else {
            await tv.page.locator('[data-focus="series:s1-S1"]').click();
        }
    }
    await tv.page.locator(`.details-hero[data-media-type="${kind.toLowerCase()}"]`).waitFor();
    await tv.page.evaluate(() => document.fonts.ready);
    const geometry = await readLive(tv, () => {
        const hero = document.querySelector(".details-hero");
        const actions = hero?.querySelector(".browse-actions");
        if (hero === null || actions === null || actions === undefined || !hero.isConnected) return null;
        return { heroBottom: hero.getBoundingClientRect().bottom, actionBottom: actions.getBoundingClientRect().bottom };
    }, null, value => value.actionBottom <= value.heroBottom, "playback actions stay inside the hero");
    assert.ok(geometry.actionBottom <= geometry.heroBottom, JSON.stringify(geometry));
    for (const key of [kind === 'Season' ? 'next-episode' : 'play', 'audio', 'subtitles', 'more']) {
        await tv.page.locator(`[data-focus="${key}"]`).focus();
        const revealed = await readLive(tv, focusKey => {
            const node = document.querySelector(`[data-focus="${focusKey}"]`);
            if (node === null || !node.isConnected || document.activeElement !== node) return null;
            const rect = node.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom };
        }, key, value => value.top >= 0 && value.bottom <= 1080, `${key} remains revealable`);
        assert.ok(revealed.top >= 0 && revealed.bottom <= 1080, JSON.stringify(revealed));
    }
    for (const key of ['version', 'audio', 'subtitles']) {
        await tv.page.locator(`[data-focus="${key}"]`).click();
        const rect = await readLive(tv, () => {
            const panel = document.querySelector(".details-track-popover");
            if (panel === null || !panel.isConnected) return null;
            const box = panel.getBoundingClientRect();
            return { y: box.y, height: box.height };
        }, null, value => value.y >= 48 && value.y + value.height <= 1032, `${key} picker stays within native screen insets`);
        assert.ok(rect.y >= 48 && rect.y + rect.height <= 1032, `${key} picker stays within native screen insets: ${JSON.stringify(rect)}`);
        await tv.remote(10009);
    }
});

detailTest("episode focus swaps cached hero and selectors without starting a read", async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="next-episode"]').waitFor();
    assert.equal(await tv.page.locator('[data-focus="episode:s1e11"] .browse-card-title').textContent(), "S01E01 · Harbor Lights chapter 1.1");
    assert.equal(await tv.page.locator('[data-focus="episode:s1e11"] .browse-card-subtitle').textContent(), "Feb 18, 2022  ·  57m");
    await tv.page.getByRole('button', { name: /Play S1:E1|Resume S1:E1/ }).waitFor();
    await tv.page.locator('.details-playback-summary').waitFor();
    await settledEpisodePrefetch(tv);
    await pauseTvClock(tv);
    await tv.page.locator('[data-focus="episode:s1e12"]').focus();
    await tv.jump(120);
    await tv.page.getByRole('button', { name: /Play S1:E2|Resume S1:E2/ }).waitFor();
    assert.match(await tv.page.locator('.details-editorial .browse-overview').textContent() ?? '', /Harbor Lights chapter 1\.2/);
    await tv.page.locator('.details-playback-summary').waitFor();
    await settledEpisodePrefetch(tv);
    const before = tv.fake.requests.length;
    await tv.page.locator('[data-focus="episode:s1e11"]').focus();
    await tv.page.getByRole('button', { name: /Play S1:E1|Resume S1:E1/ }).waitFor();
    await tv.page.locator('[data-focus="episode:s1e12"]').focus();
    await tv.page.getByRole('button', { name: /Play S1:E2|Resume S1:E2/ }).waitFor();
    assert.equal(tv.fake.requests.length, before, `focus starts no reads: ${JSON.stringify(tv.fake.requests.slice(before))}`);
    await tv.page.locator('[data-focus="next-episode"]').click();
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.plays.length > 0), 'handoff');
    assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.at(-1)?.contentId), 'episode:s1e12');
});

let browser: Browser;

detailTest('a Details repaint during the return to Play finishes at the hero anchor', async tv => {
    const held = tv.fake.hold('/recommendations/similar/movie%3Am0001', true);
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('.details-people').waitFor();
    await tv.page.locator('[data-focus="watchlist"]').waitFor();
    await tv.page.evaluate(() => document.fonts.ready);
    await pauseTvClock(tv);
    await tv.remote(40);
    await tv.jump(400);
    assert.ok(await tv.page.locator('.browse').evaluate(node => node.scrollTop > 0));
    await tv.remote(38);
    await tv.jump(50);
    held.release();
    await tv.page.locator('[data-detail-section="related"] [data-focus]').first().waitFor();
    // Immediate snap after the repaint; do not wait out a restarted 200 ms animation.
    await tv.jump(16);
    const result = await readLive(tv, () => {
        const viewport = document.querySelector<HTMLElement>('.browse');
        const hero = viewport?.querySelector('.details-hero');
        if (viewport === null || hero === undefined || hero === null || !hero.isConnected) return null;
        return { top: hero.getBoundingClientRect().top, scroll: viewport.scrollTop, primary: document.activeElement?.closest('.details-editorial') !== null };
    }, null, value => value.top === 0 && value.scroll === 0 && value.primary, 'hero top after delayed related repaint');
    assert.deepEqual(result, { top: 0, scroll: 0, primary: true });
});

for (const media of ['movie:m0001', 'series:s1']) detailTest(`${media} artwork stays inside Apple's shared top-right frame`, async tv => {
    await tv.page.locator(`[data-section="recently_added"] [data-focus="${media}"]`).first().click();
    await tv.page.locator(".details-hero .skyline-backdrop").waitFor();
    const bounds = await readLive(tv, () => {
        const node = document.querySelector(".details-hero .skyline-backdrop");
        const hero = node?.closest(".details-hero");
        if (node === null || node.parentElement === null || hero === null || hero === undefined || !node.isConnected) return null;
        const frame = node.parentElement.getBoundingClientRect();
        const art = node.getBoundingClientRect();
        return { heroTop: hero.getBoundingClientRect().top, frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height }, art: { x: art.x, y: art.y, width: art.width, height: art.height }, position: getComputedStyle(node).position };
    }, null, value => value.position === "static" && Math.abs(value.frame.x - 691.2) < 0.1 && value.frame.y === value.heroTop && Math.abs(value.frame.width - 1228.8) < 0.1 && value.frame.height === 756 && value.art.x === value.frame.x && value.art.y === value.frame.y && value.art.width === value.frame.width && value.art.height === value.frame.height, "attached artwork uses the frame instead of the viewport");
    assert.equal(bounds.position, 'static', 'the image must not inherit the viewport-fixed legacy backdrop');
    assert.ok(Math.abs(bounds.frame.x - 691.2) < 0.1, JSON.stringify(bounds));
    assert.equal(bounds.frame.y, bounds.heroTop, 'artwork scrolls with the hero, as TVDetailPageSurface requires');
    assert.ok(Math.abs(bounds.frame.width - 1228.8) < 0.1, JSON.stringify(bounds));
    assert.equal(bounds.frame.height, 756);
    assert.deepEqual(bounds.art, bounds.frame, 'crop and fade share one frame');
    assert.equal(await tv.page.locator('.details-hero .skyline-top-scrim').count(), 0, 'tvOS Details has no menu scrim');
});

detailTest('Details samples the artwork tint and presents the rating badge, runtime, credits and track readout', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const reply = catalog.route('GET', '/catalog/items/movie%3Am0001', 'p-owner');
    assert.ok(reply?.body && typeof reply.body === 'object');
    const body = reply.body;
    await tv.page.route('**/api/v2/catalog/items/movie%3Am0001?**', route => route.fulfill({ json: { ...body, content_rating: 'TV-MA', backdrop_url: '/art/details-purple.svg' } }));
    await tv.page.route('**/art/details-purple.svg*', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><path fill="#8040c0" d="M0 0h1600v900H0z"/></svg>' }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    const wash = await readLive(tv, () => {
        const node = document.querySelector(".details-page-wash");
        if (!(node instanceof HTMLElement) || !node.isConnected) return null;
        return node.style.background;
    }, null, value => value.includes("0.42") && !value.includes("10, 31, 36"), "sampled artwork replaces fallback tint");
    assert.ok(wash.includes("0.42") && !wash.includes("10, 31, 36"), wash);
    const badge = tv.page.locator('.details-rating-badge');
    assert.equal(await badge.textContent(), 'TV-MA');
    assert.equal(await readLive(tv, () => {
        const node = document.querySelector(".details-rating-badge");
        if (node === null || !node.isConnected) return null;
        return getComputedStyle(node).fontSize;
    }, null, value => value === "18px", "rating badge size"), "18px");
    assert.match(await tv.page.locator('.details-editorial .browse-meta').textContent() ?? '', /1h 30m/);
    assert.equal(await tv.page.locator('.details-director').textContent(), 'Directed by River Vale');
    assert.deepEqual(await tv.page.locator('.details-playback-summary strong').allTextContents(), ['VERSION', 'AUDIO', 'SUBTITLES']);
});

detailTest('the metadata row leads with outlined rating and advisory chips, then text facts', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    new FakeSettings(tv.fake).profile().set('catalog.show_advisory_age', true);
    const body = catalog.route('GET', '/catalog/items/movie%3Am0001', 'p-owner')?.body as Record<string, unknown>;
    await tv.page.route('**/api/v2/catalog/items/movie%3Am0001?**', route => route.fulfill({ json: {
        ...body, content_rating: 'PG', advisory_age: 13, advisory_source: 'commonsense',
        genres: ['Drama', 'Thriller', 'Mystery'],
        ratings: [{ name: 'TMDB', source: 'tmdb', score: 68, display: '6.8' }],
    } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    const row = await readLive(tv, () => {
        const node = document.querySelector('.details-editorial .browse-meta');
        const chip = node?.querySelector('[data-advisory-age]');
        const rating = node?.querySelector('.details-rating-badge:not([data-advisory-age])');
        if (!(node instanceof HTMLElement) || !(chip instanceof HTMLElement) || !(rating instanceof HTMLElement) || !node.isConnected) return null;
        const style = getComputedStyle(chip);
        const fact = node.querySelector('.details-fact:nth-of-type(n)');
        const secondFact = [...node.querySelectorAll('.details-fact')][1];
        const divider = secondFact === undefined ? '' : getComputedStyle(secondFact, '::before').content;
        return {
            order: [...node.children].map(child => child.classList.contains('details-external-rating') ? 'TMDB' : child.textContent).join('|'),
            rows: document.querySelectorAll('.details-editorial .browse-meta').length,
            gap: getComputedStyle(node).columnGap,
            size: style.fontSize,
            weight: style.fontWeight,
            radius: style.borderTopLeftRadius,
            border: style.borderTopWidth,
            padTop: style.paddingTop,
            padLeft: style.paddingLeft,
            ink: style.color,
            stroke: style.borderTopColor,
            divider,
            dividerSize: secondFact === undefined ? '' : getComputedStyle(secondFact, '::before').fontSize,
            factColor: fact instanceof HTMLElement ? getComputedStyle(fact).color : '',
            factWeight: fact instanceof HTMLElement ? getComputedStyle(fact).fontWeight : '',
            genres: node.querySelector('.details-genres')?.textContent ?? '',
        };
    }, null, value => value.order.startsWith('PG|Common Sense 13+|1991|1h 30m|TMDB|Drama, Thriller') && value.gap === '14px' && value.size === '18px' && value.rows === 1, 'outlined advisory chip in the one metadata row');
    assert.equal(row.order, 'PG|Common Sense 13+|1991|1h 30m|TMDB|Drama, Thriller');
    assert.equal(row.rows, 1);
    assert.equal(row.gap, '14px');
    assert.equal(row.size, '18px');
    assert.equal(row.weight, '700');
    assert.equal(row.radius, '5px');
    // Swift's stroke is 1.5. Chromium's used width for that specified border is 1px.
    assert.equal(row.border, '1px');
    assert.equal(row.padTop, '4px');
    assert.equal(row.padLeft, '10px');
    assert.equal(row.ink, 'rgb(255, 255, 255)');
    assert.equal(row.stroke, 'rgba(255, 255, 255, 0.78)');
    assert.equal(row.divider, '"·"');
    assert.equal(row.dividerSize, '22px');
    assert.equal(row.factColor, 'rgba(255, 255, 255, 0.88)');
    assert.equal(row.factWeight, '500');
    assert.equal(row.genres, 'Drama, Thriller');
});

detailTest('rating chips fit inside the clipped metadata row on movie, episode and series', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    for (const id of ['movie:m0001', 'series:s1', 'episode:s1e11']) {
        const body = catalog.route('GET', `/catalog/items/${encodeURIComponent(id)}`, 'p-owner')?.body as Record<string, unknown>;
        await tv.page.route(`**/api/v2/catalog/items/${encodeURIComponent(id)}?**`, route => route.fulfill({ json: { ...body, content_rating: 'PG-13' } }));
    }
    const open = async (id: string): Promise<void> => {
        await tv.page.locator(`[data-section="recently_added"] [data-focus="${id}"]`).first().click();
        await tv.page.locator('.details-rating-badge').waitFor();
        await tv.page.evaluate(() => document.fonts.ready);
    };
    const frames = [];
    await open('movie:m0001');
    // The movie title is 110px of text until its logo decodes, then the 160px slot.
    // That swap moves this row from 240 to 290. Apple shows the same text fallback
    // and does not reserve the slot, so the read waits for the decoded logo.
    frames.push(await readLive(tv, ratingChipFrame, null, value => value.media === 'movie' && value.text === 'PG-13' && value.font && Math.abs(value.rowHeight - 33) < 0.5 && value.logoReady && Math.abs(value.titleHeight - 160) < 0.5, 'movie settled rating chip'));
    await tv.remote(10009);
    await tv.page.locator('[data-view="home"]').waitFor();
    await open('series:s1');
    frames.push(await readLive(tv, ratingChipFrame, null, value => value.media === 'series' && value.text === 'PG-13' && value.font && Math.abs(value.rowHeight - 36) < 0.5, 'series settled rating chip'));
    await tv.page.locator('[data-focus="episode:s1e11"]').click({ button: 'right' });
    await tv.page.locator('[data-focus="episode-information"]').click();
    await tv.page.locator('[data-view="item:episode:s1e11"]').waitFor();
    await tv.page.evaluate(() => document.fonts.ready);
    frames.push(await readLive(tv, ratingChipFrame, null, value => value.media === 'episode' && value.text === 'PG-13' && value.font && Math.abs(value.rowHeight - 33) < 0.5, 'episode settled rating chip'));
    const clipped = frames.filter(frame => frame.chipTop < frame.rowTop - 0.01 || frame.chipBottom > frame.rowBottom + 0.01 || frame.textTop < frame.rowTop - 0.01 || frame.textBottom > frame.rowBottom + 0.01);
    assert.deepEqual(clipped, []);
    // SF Pro 18pt line height is 21.19921875. Chromium serializes the used value as 21.1992px.
    for (const frame of frames) assert.ok(Math.abs(parseFloat(frame.lineHeight) - 21.19921875) < 0.001, frame.lineHeight);
    // The row and the item under it stay put. Measured before the line-height change.
    assert.deepEqual(frames.map(frame => ({ media: frame.media, heroRowTop: frame.heroRowTop, belowTop: frame.belowTop })), [
        { media: 'movie', heroRowTop: 290, belowTop: 333 },
        { media: 'series', heroRowTop: 240, belowTop: 286 },
        { media: 'episode', heroRowTop: 293, belowTop: 336 },
    ]);
});

detailTest('Series thumbnail dimensions follow the Apple poster-size scale', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    const art = tv.page.locator('.details-episodes .browse-art').first();
    await art.waitFor();
    await tv.page.locator('.browse').evaluate(node => (node as HTMLElement).style.setProperty('--poster-scale', '0.86'));
    const size = await readLive(tv, () => {
        const node = document.querySelector(".details-episodes .browse-art");
        if (!(node instanceof HTMLElement) || !node.isConnected) return null;
        return { width: node.offsetWidth, height: node.offsetHeight };
    }, null, value => Math.abs(value.width - 360 * 0.86) < 1 && Math.abs(value.height - 200 * 0.86) < 1, "compact episode still");
    assert.ok(Math.abs(size.width - 360 * 0.86) < 1, `compact width ${size.width}`);
    assert.ok(Math.abs(size.height - 200 * 0.86) < 1, `compact height ${size.height}`);
});

detailTest('Series current episode occupies the leading slot when entering a long rail', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const reply = catalog.route('GET', '/catalog/series/series%3As1/seasons/1/episodes', 'p-owner');
    assert.ok(reply?.body && typeof reply.body === 'object');
    const body = reply.body as { items: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons/1/episodes?**', route => route.fulfill({ json: { items: Array.from({ length: 12 }, (_, index) => ({ ...body.items[0], content_id: `episode:window${index}`, episode_number: index + 1, user_data: { played: false, is_in_progress: index === 6 } })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="episode:window6"]').waitFor();
    await tv.eventually(async () => await tv.focused() === 'next-episode', 'Play focused on entry');
    assert.equal(await tv.focused(), 'next-episode');
    const anchored = await readLive(tv, () => {
        const node = document.querySelector('[data-focus="episode:window6"]');
        const row = node?.closest(".browse-row");
        if (!(node instanceof HTMLElement) || !(row instanceof HTMLElement) || !node.isConnected) return null;
        return Math.abs(node.getBoundingClientRect().left - row.getBoundingClientRect().left - parseFloat(getComputedStyle(row).paddingLeft));
    }, null, value => value < 2, "current episode anchored at the leading slot");
    assert.ok(anchored < 2, String(anchored));
    await tv.page.locator('[data-focus="episode:window9"]').focus();
    await tv.jump(400);
    assert.ok(await readLive(tv, liveScroll, null, value => value > 1000, "later episode leaves the first screen") > 1000);
    await tv.page.locator('[data-focus="season:1"]').click();
    await tv.jump(400);
    assert.equal(await tv.focused(), 'season:1');
    assert.equal(await readLive(tv, liveScroll, null, value => value === 0, "reselect reveals E01 before Down"), 0, "reselect reveals E01 before Down");
});

detailTest('Track popovers anchor to the selector without dimming and focus Auto', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="audio"]').click();
    assert.equal(await tv.focused(), 'audio:auto');
    assert.equal(await tv.page.locator('.skyline-dropdown-scrim').count(), 0);
    assert.match(await tv.page.locator('[data-focus="audio:auto"]').textContent() ?? '', /Use your Playback audio preference/);
});

detailTest('late Series episodes do not steal focus after remote navigation', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const reply = catalog.route('GET', '/catalog/series/series%3As1/seasons/1/episodes', 'p-owner');
    let release: () => void = () => {}, delivered: () => void = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const responseDelivered = new Promise<void>(resolve => { delivered = resolve; });
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons/1/episodes?**', async route => {
        await held;
        await route.fulfill({ json: reply?.body });
        delivered();
    });
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="season:1"]').focus();
    await tv.remote(39);
    assert.equal(await tv.focused(), 'season:2');
    await tv.jump(100);
    await tv.page.locator('[data-focus="episode:s1e21"]').waitFor();
    release();
    await responseDelivered;
    await tv.page.waitForLoadState('networkidle');
    await tv.page.locator('[data-focus="episode:s1e21"]').waitFor();
    assert.equal(await tv.focused(), 'season:2');
    assert.equal(await tv.page.locator('[data-focus="season:2"]').getAttribute('aria-pressed'), 'true');
});

detailTest('Series watched episodes show a check badge without a text glyph', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const reply = catalog.route('GET', '/catalog/series/series%3As1/seasons/1/episodes', 'p-owner');
    assert.ok(reply?.body && typeof reply.body === 'object');
    const body = reply.body as { items: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons/1/episodes?**', route => route.fulfill({ json: { items: body.items.map(episode => ({ ...episode, user_data: { played: true } })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    const badge = tv.page.locator('.details-episodes [data-focus="episode:s1e11"] .browse-watched');
    await badge.waitFor();
    assert.equal(await badge.getAttribute('aria-label'), 'Watched');
    assert.equal(await badge.textContent(), '');
});

detailTest('Series remote navigation scrolls down to Cast and back to episodes', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="episode:s1e11"]').focus();
    await tv.remote(40);
    assert.match(await tv.focused() ?? '', /^(person:|credit:)/);
    const cast = await readLive(tv, () => {
        const photo = document.querySelector(".details-photo");
        const browse = document.querySelector(".browse");
        if (!(photo instanceof HTMLElement) || !(browse instanceof HTMLElement) || !photo.isConnected) return null;
        const rect = photo.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, scrollTop: browse.scrollTop };
    }, null, value => value.top >= 0 && value.bottom <= 1080 && value.scrollTop > 0, "cast visible after remote Down");
    assert.ok(cast.top >= 0 && cast.bottom <= 1080, JSON.stringify(cast));
    assert.ok(cast.scrollTop > 0, "Details owns vertical scrolling");
    await tv.jump(400);
    const resting = await readLive(tv, () => {
        const row = document.querySelector(".details-people");
        const card = row?.querySelector(".details-person");
        const photo = row?.querySelector(".details-photo");
        const heading = row?.previousElementSibling;
        if (!(row instanceof HTMLElement) || !(card instanceof HTMLElement) || photo === null || photo === undefined || heading === null || heading === undefined || !row.isConnected) return null;
        const rect = card.getBoundingClientRect();
        const portrait = photo.getBoundingClientRect();
        const bounds = row.getBoundingClientRect();
        return {
            headingTop: heading.getBoundingClientRect().top,
            restingTop: rect.top + (rect.height - card.offsetHeight) / 2,
            inside: portrait.top - 2 >= bounds.top && portrait.bottom + 2 <= bounds.bottom,
        };
    }, null, value => Math.abs(value.headingTop - 367) <= 3 && Math.abs(value.restingTop - 436) <= 3 && value.inside, "cast heading and portrait settle");
    assert.ok(Math.abs(resting.headingTop - 367) <= 3, "cast heading settles at the measured Apple anchor");
    // The image starts 69px below the centered heading, independently of focus padding.
    assert.ok(Math.abs(resting.restingTop - 436) <= 3, `resting cast circle top ${resting.restingTop}`);
    assert.ok(resting.inside, "scaled portrait and focus ring stay inside the row paint area");
    await tv.remote(38);
    assert.match(await tv.focused() ?? '', /^episode:/);
});

detailTest('Episode information subtitle changes refresh the retained Series cache on Back', async tv => {
    const catalog = tv.fake.catalog;
    assert.ok(catalog instanceof FakeDetails);
    const reply = catalog.route('GET', '/catalog/items/episode%3As1e11', 'p-owner');
    assert.ok(reply?.body && typeof reply.body === 'object');
    const body = reply.body;
    let off = false;
    await tv.page.route('**/api/v2/catalog/items/episode%3As1e11?**', route => route.fulfill({ json: { ...body, effective_subtitle_mode: off ? 'off' : 'auto', effective_show_forced_subtitles: false } }));
    await tv.page.route('**/api/v2/subtitle-prefs/**', route => {
        if (route.request().method() === 'PUT') { off = true; return route.fulfill({ status: 204 }); }
        return route.fulfill(off ? { status: 200, json: { series_id: 'series:s1', subtitle_mode: 'off', subtitle_track_index: -1 } } : { status: 404 });
    });
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="episode:s1e11"]').click({ button: 'right' });
    await tv.page.locator('[data-focus="episode-information"]').click();
    await tv.page.locator('[data-focus="subtitles"]').click();
    await tv.page.locator('[data-focus="subtitle:off"]').click();
    await tv.page.getByText('Saving subtitle preference…', { exact: true }).waitFor({ state: 'hidden' });
    await tv.remote(10009);
    await tv.page.locator('[data-view="item:series:s1"]').waitFor();
    await tv.eventually(async () => await tv.page.locator('[data-track-summary="subtitles"] span').textContent() === 'Off', 'refreshed shared subtitle preference');
});

for (const media of ['movie:m0001', 'episode:s1e11']) detailTest(`ordinary Play on ${media} leaves effective audio to playback resolution`, async tv => {
    const catalog = tv.fake.catalog;
    assert.ok(catalog instanceof FakeDetails);
    const reply = catalog.route('GET', `/catalog/items/${encodeURIComponent(media)}`, 'p-owner');
    assert.ok(reply?.body && typeof reply.body === 'object');
    const body = reply.body as { versions: Record<string, unknown>[] };
    await tv.page.route(`**/api/v2/catalog/items/${encodeURIComponent(media)}?**`, route => route.fulfill({ json: { ...body, versions: body.versions.map(version => ({ ...version, audio_tracks: [{ language: 'en', codec: 'aac', default: true }], effective_audio_track_index: 0 })) } }));
    if (media.startsWith('episode:')) {
        await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
        await tv.page.locator('[data-focus="episode:s1e11"]').click({ button: 'right' });
        await tv.page.locator('[data-focus="episode-information"]').click();
    } else await tv.page.locator(`[data-section="recently_added"] [data-focus="${media}"]`).first().click();
    await tv.page.locator('[data-focus="play"]').click();
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.plays.length > 0), 'handoff');
    assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.at(-1)?.audioTrackId), undefined);
});

detailTest("a failed explicitly requested episode only retries on Select, never on focus", async tv => {
    const catalog = tv.fake.catalog;
    assert.ok(catalog instanceof FakeDetails);
    const reply = catalog.route('GET', '/catalog/items/episode%3As1e12', 'p-owner');
    assert.ok(reply);
    let failed = true;
    await tv.page.route('**/api/v2/catalog/items/episode%3As1e12?**', route => route.fulfill(failed ? { status: 500 } : { status: 200, json: reply.body }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.getByRole('button', { name: /Play S1:E1|Resume S1:E1/ }).waitFor();
    await pauseTvClock(tv);
    await tv.page.locator('[data-focus="episode:s1e12"]').focus();
    await tv.page.locator('[data-focus="subtitles"]').click();
    await tv.page.clock.resume();
    await tv.page.getByRole('button', { name: 'Retry episode', exact: true }).waitFor();
    for (const key of ['version', 'audio', 'subtitles']) assert.equal(await tv.page.locator(`[data-focus="${key}"]`).getAttribute('aria-disabled'), 'true', `${key} keeps its disabled slot`);
    const reads = (): number => tv.fake.requests.filter(request => request.path.startsWith('/catalog/items/episode%3As1e12')).length;
    const before = reads();
    for (const key of ['version', 'audio', 'subtitles']) await tv.page.locator(`[data-focus="${key}"]`).evaluate(node => (node as HTMLElement).click());
    assert.equal(reads(), before, 'disabled selectors cannot retry the failed read');
    await tv.page.locator('[data-focus="episode:s1e11"]').focus();
    await tv.page.locator('[data-focus="episode:s1e12"]').focus();
    assert.equal(reads(), before);
    failed = false;
    await tv.page.getByRole('button', { name: 'Retry episode', exact: true }).click();
    await tv.page.getByRole('button', { name: /Play S1:E2|Resume S1:E2/ }).waitFor();
});

detailTest("episode rail Select carries its cached subtitle Off choice", async tv => {
    let off = false;
    await tv.page.route('**/api/v2/subtitle-prefs/**', async route => {
        if (route.request().method() === 'PUT') { off = true; await route.fulfill({ status: 204 }); }
        else await route.fulfill(off ? { status: 200, json: { series_id: 'series:s1', subtitle_mode: 'off', subtitle_track_index: -1 } } : { status: 404 });
    });
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="episode:s1e12"]').focus();
    await tv.page.getByRole('button', { name: /Play S1:E2|Resume S1:E2/ }).waitFor();
    await tv.page.locator('[data-focus="subtitles"]').click();
    await tv.page.locator('[data-focus="subtitle:off"]').click();
    await tv.page.getByText('Saving subtitle preference…', { exact: true }).waitFor({ state: 'hidden' });
    await tv.page.locator('[data-focus="episode:s1e12"]').click();
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.plays.length > 0), 'rail handoff');
    assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.at(-1)?.subtitle?.kind), 'off');
});
for (const media of ['movie:m0001', 'series:s1']) {
    detailTest(`275 signed Cast terminal inset on ${media}`, async tv => {
        const body = tv.fake.catalog?.route('GET', `/catalog/items/${encodeURIComponent(media)}`, 'p-owner')?.body as Record<string, unknown>;
        await tv.page.route(`**/api/v2/catalog/items/${encodeURIComponent(media)}?**`, route => route.fulfill({ json: { ...body, cast: Array.from({ length: 25 }, (_, order) => ({ person_id: String(order), name: `Actor ${order}`, character: 'Role', order })) } }));
        await tv.page.locator(`[data-section="recently_added"] [data-focus="${media}"]`).first().click();
        const cards = tv.page.locator('.details-people [data-focus]');
        await cards.last().focus();
        await tv.jump(1000);
        const focused = await readLive(tv, () => {
            const row = document.querySelector('.details-people');
            const last = row?.lastElementChild;
            if (!(row instanceof HTMLElement) || !(last instanceof HTMLElement)) return null;
            const box = last.getBoundingClientRect();
            return { right: box.right, width: box.width, railRight: row.getBoundingClientRect().right, scroll: row.scrollLeft, maximum: row.scrollWidth - row.clientWidth };
        }, null, value => Math.abs(value.width - 210) < 0.1, 'settled final Cast focus lift');
        assert.ok(Math.abs(focused.right - 1825) < 1, JSON.stringify(focused));
        assert.equal(focused.railRight, 1920, 'focus lift paints beyond the page inset');
        assert.ok(focused.right < focused.railRight, 'focused portrait is unclipped');
        const leadingCast = await readLive(tv, () => {
            const row = document.querySelector('.details-people');
            if (!(row instanceof HTMLElement)) return null;
            const cards = [...row.querySelectorAll('.details-person')].flatMap(node => {
                if (!(node instanceof HTMLElement)) return [];
                const box = node.getBoundingClientRect();
                return box.right > 0 && box.left < 1920 ? [{ left: box.left, right: box.right, node }] : [];
            }).sort((a, b) => a.left - b.left);
            const first = cards[0];
            const photo = first?.node.querySelector('.details-photo');
            if (first === undefined || !(photo instanceof HTMLElement)) return null;
            const portrait = photo.getBoundingClientRect();
            const y = portrait.top + portrait.height / 2;
            const hit = document.elementFromPoint(first.left + 10, y);
            return { left: first.left, right: first.right, shown: hit !== null && first.node.contains(hit) };
        }, null, value => Math.abs(value.left - 60) < 1 && Math.abs(value.right - 260) < 1 && value.shown, 'terminal Cast portrait is whole from 60');
        assert.ok(Math.abs(leadingCast.left - 60) < 1, JSON.stringify(leadingCast));
        assert.ok(Math.abs(leadingCast.right - 260) < 1, JSON.stringify(leadingCast));
        assert.equal(leadingCast.shown, true, JSON.stringify(leadingCast));
        await cards.nth(22).focus();
        await tv.jump(1000);
        const resting = await readLive(tv, () => {
            const last = document.querySelector('.details-people')?.lastElementChild;
            if (!(last instanceof HTMLElement)) return null;
            const box = last.getBoundingClientRect();
            return { right: box.right, width: box.width };
        }, null, value => Math.abs(value.width - 200) < 0.1, 'settled resting final Cast card');
        assert.ok(Math.abs(resting.right - 1820) < 1, JSON.stringify(resting));
    });

    detailTest(`275 signed More icons on ${media}`, async tv => {
        await tv.page.route('**/api/v2/shuffles/capabilities', route => route.fulfill({ json: { allowed: true, state: 'available', scope_kinds: ['series'] } }));
        await tv.page.route('**/api/v2/capabilities/metadata-ai', route => route.fulfill({ json: { allowed: true, on_view: 'button', revision: 'test', state: 'available' } }));
        const body = tv.fake.catalog?.route('GET', `/catalog/items/${encodeURIComponent(media)}`, 'p-owner')?.body as Record<string, unknown>;
        await tv.page.route(`**/api/v2/catalog/items/${encodeURIComponent(media)}?**`, route => route.fulfill({ json: { ...body, pending_translation_language: 'de' } }));
        await tv.page.locator(`[data-section="recently_added"] [data-focus="${media}"]`).first().click();
        if (media.startsWith('series')) {
            await tv.page.locator('[data-focus="episode:s1e12"]').focus();
            await tv.eventually(async () => await tv.page.getByRole('button', { name: /Play S1:E2|Resume S1:E2/ }).count() === 1, 'episode hero');
        }
        await tv.page.locator('[data-focus="more"]').click();
        await tv.page.locator('[data-focus="translate-description"]').waitFor();
        const symbols = await tv.page.locator('.details-more-popover [data-focus]').evaluateAll(nodes => nodes.map(node => [node.getAttribute('data-focus'), node.querySelector('svg')?.getAttribute('data-symbol')]));
        assert.deepEqual(symbols, [
            ...(media.startsWith('series') ? [['shuffle-series', 'shuffle'], ['series-overview', 'info.circle']] : []),
            ['favorites', 'heart'], ['watched', 'checkmark.circle'],
            ...(media.startsWith('series') ? [['season-watched', 'checkmark.circle']] : []),
            ['find-trailers', 'film.stack'], ['translate-description', 'translate'],
        ]);
    });

    detailTest(`275 signed More header and focus shape on ${media}`, async tv => {
        await tv.page.locator(`[data-section="recently_added"] [data-focus="${media}"]`).first().click();
        await tv.page.locator('[data-focus="more"]').click();
        await tv.jump(1000);
        const style = await readLive(tv, () => {
            const header = document.querySelector('.details-more-popover h2');
            const focused = document.querySelector('.details-more-popover :focus');
            if (header === null || focused === null) return null;
            const h = getComputedStyle(header); const f = getComputedStyle(focused);
            return { size: h.fontSize, weight: h.fontWeight, family: h.fontFamily, color: h.color, opacity: h.opacity, tracking: h.letterSpacing, padding: h.padding, margin: h.margin, radius: f.borderRadius };
        }, null, value => value.radius !== '', 'settled More focus');
        assert.equal(style.size, '14px'); assert.equal(style.weight, '400');
        assert.ok(style.family.includes('monospace'), JSON.stringify(style));
        assert.equal(style.color, 'rgba(255, 255, 255, 0.38)'); assert.equal(style.opacity, '1');
        assert.equal(style.tracking, '3.64px'); assert.equal(style.padding, '8px 16px 10px'); assert.equal(style.margin, '0px');
        assert.equal(style.radius, '14px');
    });

    detailTest(`275 signed regular synopsis on ${media}`, async tv => {
        // The Samsung simulator injects this rule; desktop Chromium does not.
        await tv.page.addStyleTag({ content: '* { font-family: SamsungOne; font-weight: 600; }' });
        await tv.page.locator(`[data-section="recently_added"] [data-focus="${media}"]`).first().click();
        await tv.page.evaluate(() => document.fonts.ready);
        const font = await readLive(tv, () => {
            const node = document.querySelector('.details-editorial .browse-overview');
            if (node === null) return null;
            const style = getComputedStyle(node);
            return { size: style.fontSize, weight: style.fontWeight, color: style.color, family: style.fontFamily, available: document.fonts.check('400 26px Inter') };
        }, null, value => value.available, 'loaded regular synopsis font');
        assert.equal(font.size, '26px'); assert.equal(font.weight, '400');
        assert.ok(font.family.includes('Inter'), JSON.stringify(font));
        assert.equal(font.color, 'rgba(255, 255, 255, 0.92)');
    });
}

before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

for (const media of ['movie:m0001', 'series:s1']) detailTest(`274 Find Trailers offers ${media} in Apple menu order and publishes the polled rail`, async tv => {
    let posts = 0; let queued = false;
    const encoded = encodeURIComponent(media);
    const body = tv.fake.catalog?.route('GET', `/catalog/items/${encoded}`, 'p-owner')?.body as Record<string, unknown>;
    await tv.page.route(`**/api/v2/catalog/items/${encoded}/trailers/refresh`, route => {
        posts++; queued = true; return route.fulfill({ status: 202, json: { status: 'queued' } });
    });
    await tv.page.route(`**/api/v2/catalog/items/${encoded}?**`, route => route.fulfill({ json: { ...body, ...(queued ? { extras: [{ content_id: 'extra:new', title: 'New trailer', kind: 'trailer', duration: 90 }] } : {}) } }));
    await tv.page.locator(`[data-section="recently_added"] [data-focus="${media}"]`).first().click();
    await tv.page.locator('[data-focus="more"]').click();
    const order = await tv.page.locator('.details-more-popover [data-focus]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-focus')));
    assert.ok(order.indexOf('find-trailers') > order.indexOf('watched'));
    assert.ok(!order.includes('translate-description') || order.indexOf('find-trailers') < order.indexOf('translate-description'));
    await tv.page.locator('[data-focus="find-trailers"]').click();
    await tv.page.locator('.details-trailer-status').waitFor();
    assert.equal(await tv.focused(), 'more');
    assert.equal(await tv.page.locator('.details-trailer-status').textContent(), 'Finding trailers…');
    await tv.jump(3000);
    await tv.page.locator('[data-focus="extra:extra:new"]').waitFor();
    assert.equal(posts, 1);
    assert.equal(await tv.page.locator('.details-trailer-status').count(), 0);
});

for (const check of ['cast', 'caption', 'season', 'description', 'menu', 'metadata', 'sparse metadata']) detailTest(`274 ${check} matches pinned tvOS Details`, async tv => {
    if (check === 'sparse metadata') {
        const catalog = tv.fake.catalog;
        await tv.page.route('**/api/v2/catalog/**', async route => {
            const url = new URL(route.request().url());
            const response = catalog?.route('GET', url.pathname.replace('/api/v2', '') + url.search, 'p-owner');
            if (response === undefined || response.status !== 200) { await route.fallback(); return; }
            const body = response.body as Record<string, unknown>;
            const clear = (item: Record<string, unknown>): Record<string, unknown> => ({ ...item, air_date: undefined, runtime: 0, ratings: [], content_rating: undefined, ...(Array.isArray(item.versions) ? { versions: item.versions.map(value => ({ ...value as Record<string, unknown>, duration: 0 })) } : {}) });
            await route.fulfill({ json: { ...clear(body), ...(Array.isArray(body.items) ? { items: body.items.map(item => clear(item as Record<string, unknown>)) } : {}) } });
        });
    }
    if (check === 'metadata') {
        const body = tv.fake.catalog?.route('GET', '/catalog/items/episode%3As1e11', 'p-owner')?.body as Record<string, unknown>;
        await tv.page.route('**/api/v2/catalog/items/episode%3As1e11?**', route => route.fulfill({ json: { ...body, ratings: [{ name: 'TMDB', source: 'tmdb', score: 80, display: '80%' }] } }));
    }
    await tv.page.locator(`[data-section="recently_added"] [data-focus="${check === 'cast' || check === 'menu' ? 'movie:m0001' : 'series:s1'}"]`).first().click();
    await tv.page.locator('[data-focus="version"][aria-disabled="false"]').waitFor();
    if (check === 'cast') {
        const rail = await readLive(tv, () => {
            const node = document.querySelector('.details-people');
            return node === null ? null : { right: node.getBoundingClientRect().right };
        }, null, value => value.right > 0, 'live Cast rail');
        assert.equal(rail.right, 1920);
    } else if (check === 'caption') {
        const caption = tv.page.locator('.details-episodes .browse-card-title').first();
        await caption.evaluate(node => { node.textContent = "S02E01 · Electro's Gotta Glow"; });
        const metrics = await caption.evaluate(node => ({ width: node.clientWidth, content: node.scrollWidth, padding: getComputedStyle(node).paddingLeft, weight: getComputedStyle(node).fontWeight }));
        assert.equal(metrics.padding, '0px');
        assert.equal(metrics.weight, '600');
        assert.ok(metrics.content <= metrics.width, JSON.stringify(metrics));
    } else if (check === 'season') {
        assert.equal(await tv.page.locator('[data-focus="season:1"]').evaluate(node => getComputedStyle(node).borderTopColor), 'rgba(0, 0, 0, 0)');
    } else if (check === 'description') {
        const color = await readLive(tv, () => {
            const node = document.querySelector('.details-editorial .browse-overview');
            return node === null ? null : { color: getComputedStyle(node).color };
        }, null, value => value.color !== '', 'live synopsis');
        assert.equal(color.color, 'rgba(255, 255, 255, 0.92)');
    } else if (check === 'menu') {
        await tv.page.locator('[data-focus="more"]').click();
        assert.equal(await tv.page.locator('.details-more-popover').evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0.45)');
    } else if (check === 'sparse metadata') {
        await tv.page.locator('[data-focus="episode:s1e11"]').focus();
        await tv.eventually(async () => {
            const tokens = await tv.page.locator('.details-editorial .details-source').allTextContents();
            return tokens.join('|') === 'Season 1|Episode 1';
        }, 'sparse episode identifiers');
    } else {
        await tv.page.locator('[data-focus="episode:s1e11"]').focus();
        await tv.eventually(async () => (await tv.page.locator('.details-editorial .browse-meta').textContent())?.includes('Season 1') === true, 'episode hero');
        await tv.page.locator('.details-editorial .browse-meta img[alt="TMDB"]').waitFor();
        const parts = await tv.page.locator('.details-editorial .browse-meta').evaluate(node => [...node.childNodes].map(child => child instanceof HTMLSpanElement ? child.querySelector('img')?.alt ?? child.textContent : child.textContent).join(''));
        assert.ok(parts.indexOf('TMDB') >= 0 && parts.indexOf('TMDB') < parts.indexOf('Season 1'), parts);
    }
});

function anchoredEpisodeSlot(): { ring: number; previousRight: number; frame: number; still: number; sliver: boolean } | null {
    const focused = document.activeElement;
    const art = focused?.querySelector(".browse-art");
    const previous = focused?.previousElementSibling;
    const previousArt = previous?.querySelector(".browse-art");
    if (!(focused instanceof HTMLElement) || !(art instanceof HTMLElement) || !(previous instanceof HTMLElement) || !(previousArt instanceof HTMLElement) || !focused.isConnected) return null;
    for (const animation of art.getAnimations()) animation.finish();
    const still = art.getBoundingClientRect();
    const prev = previousArt.getBoundingClientRect();
    const outline = parseFloat(getComputedStyle(art).outlineWidth);
    const outlineOffset = parseFloat(getComputedStyle(art).outlineOffset);
    const y = still.top + still.height / 2;
    const sliverX = 100 + Math.max(0, prev.right - 100) / 2;
    const sliverHit = document.elementFromPoint(sliverX, y);
    return {
        still: still.left,
        frame: focused.getBoundingClientRect().left,
        ring: still.left - (outline + outlineOffset),
        previousRight: prev.right,
        sliver: prev.right > 100 && sliverHit !== null && previous.contains(sliverHit),
    };
}

detailTest("episode rail uses state A when the loaded window starts at Season 1", async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog);
    const seasons = catalog.route("GET", "/catalog/series/series%3As1/seasons", "p-owner")?.body as { items: Record<string, unknown>[] };
    const episodes = catalog.route("GET", "/catalog/series/series%3As1/seasons/1/episodes", "p-owner")?.body as { items: Record<string, unknown>[] };
    await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons?**", route => route.fulfill({ json: { items: [1, 2].map(number => ({ ...seasons.items[0], content_id: `season:${number}`, season_number: number, episode_count: 8, user_data: { played: false, in_progress_count: 0 } })) } }));
    for (const season of [1, 2]) await tv.page.route(`**/api/v2/catalog/series/series%3As1/seasons/${season}/episodes?**`, route => route.fulfill({ json: { items: Array.from({ length: 8 }, (_, index) => ({ ...episodes.items[0], content_id: `episode:origin:${season}:${index + 1}`, season_number: season, episode_number: index + 1, user_data: { played: index === 0 } })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    const card = tv.page.locator('[data-focus="episode:origin:1:2"]');
    await card.waitFor();
    await card.focus();
    await tv.jump(500);
    const slot = await readLive(tv, anchoredEpisodeSlot, null, value => Math.abs(value.ring - 100) < 0.6 && Math.abs(value.previousRight - 70) < 0.6 && value.sliver === false, "Season 1 window is state A");
    assert.ok(Math.abs(slot.ring - 100) < 0.6, JSON.stringify(slot));
    assert.ok(Math.abs(slot.previousRight - 70) < 0.6, JSON.stringify(slot));
    assert.equal(slot.sliver, false, JSON.stringify(slot));
    assert.ok(Math.abs(slot.frame - 110) < 1, JSON.stringify(slot));
}, "compact");

detailTest("episode rail keeps state B when an earlier season page is not loaded", async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog);
    const seasons = catalog.route("GET", "/catalog/series/series%3As1/seasons", "p-owner")?.body as { items: Record<string, unknown>[] };
    const episodes = catalog.route("GET", "/catalog/series/series%3As1/seasons/1/episodes", "p-owner")?.body as { items: Record<string, unknown>[] };
    await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons?**", route => route.fulfill({ json: { items: [1, 13, 14].map(season => ({ ...seasons.items[0], content_id: `season:${season}`, season_number: season, episode_count: season === 13 ? 10 : season === 14 ? 6 : 10, user_data: { played: season !== 14, in_progress_count: season === 14 ? 1 : 0 } })) } }));
    for (const season of [13, 14]) await tv.page.route(`**/api/v2/catalog/series/series%3As1/seasons/${season}/episodes?**`, route => route.fulfill({ json: { items: Array.from({ length: season === 13 ? 10 : 6 }, (_, index) => ({ ...episodes.items[0], content_id: `episode:later:s${season}e${index + 1}`, season_number: season, episode_number: index + 1, user_data: { played: season === 13 || index < 4 } })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="episode:later:s13e10"]').waitFor();
    await tv.page.locator('[data-focus="episode:later:s13e5"]').focus();
    await tv.jump(500);
    const slot = await readLive(tv, anchoredEpisodeSlot, null, value => Math.abs(value.ring - 139) < 2 && value.previousRight > 100 && value.previousRight < 112 && value.sliver, "later season stays state B");
    assert.ok(Math.abs(slot.ring - 139) < 2, JSON.stringify(slot));
    assert.ok(slot.previousRight > 100 && slot.previousRight < 112, JSON.stringify(slot));
    assert.equal(slot.sliver, true, JSON.stringify(slot));
    await tv.page.locator('[data-focus="episode:later:s14e6"]').focus();
    await tv.jump(800);
    const terminal = await readLive(tv, () => {
        const art = document.querySelector(".details-episodes :focus .browse-art");
        if (!(art instanceof HTMLElement) || !art.isConnected) return null;
        const box = art.getBoundingClientRect();
        const extension = parseFloat(getComputedStyle(art).outlineWidth) + parseFloat(getComputedStyle(art).outlineOffset);
        return { ring: box.right + extension, width: box.width };
    }, null, value => value.width > 320 && Math.abs(value.ring - 1866) < 3, "state B terminal ring");
    assert.ok(Math.abs(terminal.ring - 1866) < 3, JSON.stringify(terminal));
}, "compact");

detailTest("paging Left into Season 1 flips the rail to state A under the focused card", async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog);
    const seasons = catalog.route("GET", "/catalog/series/series%3As1/seasons", "p-owner")?.body as { items: Record<string, unknown>[] };
    const episodes = catalog.route("GET", "/catalog/series/series%3As1/seasons/1/episodes", "p-owner")?.body as { items: Record<string, unknown>[] };
    // Season 2 holds eight episodes, so opening on Season 3 warms Season 2 but stops before Season 1.
    const counts: Record<number, number> = { 1: 3, 2: 8, 3: 4 };
    await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons?**", route => route.fulfill({ json: { items: [1, 2, 3].map(number => ({ ...seasons.items[0], content_id: `season:${number}`, season_number: number, episode_count: counts[number], user_data: { played: number < 3, in_progress_count: number === 3 ? 1 : 0 } })) } }));
    for (const season of [1, 2, 3]) await tv.page.route(`**/api/v2/catalog/series/series%3As1/seasons/${season}/episodes?**`, route => route.fulfill({ json: { items: Array.from({ length: counts[season]! }, (_, index) => ({ ...episodes.items[0], content_id: `episode:page:${season}:${index + 1}`, season_number: season, episode_number: index + 1, user_data: { played: season < 3 || index === 0 } })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="episode:page:2:8"]').waitFor();
    assert.equal(await tv.page.locator('[data-focus="episode:page:1:3"]').count(), 0, "Season 1 is not warmed");
    await tv.page.locator('[data-focus="episode:page:2:2"]').focus();
    await tv.jump(500);
    await readLive(tv, anchoredEpisodeSlot, null, value => Math.abs(value.ring - 139) < 2 && value.sliver, "opens in state B");
    await tv.page.locator('[data-focus="episode:page:2:1"]').focus();
    await tv.jump(300);
    await tv.remote(37);
    await tv.page.locator('[data-focus="episode:page:1:3"]').waitFor();
    await tv.jump(500);
    const focused = await tv.focused();
    assert.ok(focused === "episode:page:2:1" || focused === "episode:page:1:3", `focus kept on the rail: ${focused}`);
    assert.equal(await tv.page.locator(".details-episodes").getAttribute("data-window-origin"), "series-start");
    await tv.page.locator('[data-focus="episode:page:2:1"]').focus();
    await tv.jump(500);
    const slot = await readLive(tv, anchoredEpisodeSlot, null, value => Math.abs(value.ring - 100) < 0.6 && Math.abs(value.previousRight - 70) < 0.6 && !value.sliver, "paged window is state A");
    assert.ok(Math.abs(slot.ring - 100) < 0.6, JSON.stringify(slot));
    assert.equal(slot.sliver, false, JSON.stringify(slot));
}, "compact");

detailTest("walking season chips to Season 1 keeps state A until Details is reopened", async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog);
    const seasonBody = catalog.route("GET", "/catalog/series/series%3As1/seasons", "p-owner")?.body as { items: Record<string, unknown>[] };
    const episodeBody = catalog.route("GET", "/catalog/series/series%3As1/seasons/1/episodes", "p-owner")?.body as { items: Record<string, unknown>[] };
    const episode = (season: number, index: number): Record<string, unknown> => ({ ...episodeBody.items[0], content_id: `episode:walk:${season}:${index + 1}`, season_number: season, episode_number: index + 1, user_data: { played: index === 0 } });
    await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons?**", route => route.fulfill({ json: { items: [1, 2, 3, 4, 5].map(number => ({ ...seasonBody.items[0], content_id: `season:${number}`, season_number: number, title: `Season ${number}`, episode_count: 10, user_data: { played: number < 5, in_progress_count: number === 5 ? 1 : 0 } })) } }));
    for (const season of [1, 2, 3, 4, 5]) await tv.page.route(`**/api/v2/catalog/series/series%3As1/seasons/${season}/episodes?**`, route => route.fulfill({ json: { items: Array.from({ length: 10 }, (_, index) => episode(season, index)) } }));
    const open = async (): Promise<void> => {
        await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
        await tv.page.locator('[data-focus="episode:walk:5:1"]').waitFor();
    };
    const expectSlot = async (state: "A" | "B", episodeId: string): Promise<void> => {
        await tv.page.locator(`[data-focus="${episodeId}"]`).focus();
        await tv.jump(500);
        const slot = await readLive(tv, anchoredEpisodeSlot, null, value => state === "A" ? Math.abs(value.ring - 100) < 0.6 && Math.abs(value.previousRight - 70) < 0.6 && !value.sliver : Math.abs(value.ring - 139) < 2 && value.previousRight > 100 && value.sliver, `chip walk ${state}`);
        if (state === "A") {
            assert.ok(Math.abs(slot.ring - 100) < 0.6, JSON.stringify(slot));
            assert.ok(Math.abs(slot.previousRight - 70) < 0.6, JSON.stringify(slot));
            assert.equal(slot.sliver, false, JSON.stringify(slot));
        } else {
            assert.ok(Math.abs(slot.ring - 139) < 2, JSON.stringify(slot));
            assert.ok(slot.previousRight > 100, JSON.stringify(slot));
            assert.equal(slot.sliver, true, JSON.stringify(slot));
        }
    };
    await open();
    await tv.page.locator('[data-focus="episode:walk:4:10"]').waitFor();
    await expectSlot("B", "episode:walk:5:2");
    await tv.page.locator('[data-focus="season:5"]').focus();
    for (const season of [4, 3, 2, 1]) {
        await tv.remote(37);
        await tv.jump(120);
        await tv.page.locator(`[data-focus="episode:walk:${season}:1"]`).waitFor();
    }
    await expectSlot("A", "episode:walk:1:2");
    await tv.page.locator('[data-focus="season:1"]').focus();
    for (const season of [2, 3, 4, 5]) {
        await tv.remote(39);
        await tv.jump(120);
        await tv.page.locator(`[data-focus="season:${season}"][aria-pressed="true"]`).waitFor();
    }
    await tv.page.locator('[data-focus="episode:walk:4:10"]').waitFor();
    await expectSlot("A", "episode:walk:5:2");
    await tv.remote(10009);
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().waitFor();
    await open();
    await expectSlot("B", "episode:walk:5:2");
}, "compact");

function detailTest(name: string, body: (tv: Tv) => Promise<void>, size?: 'compact' | 'standard' | 'large'): void {
    test(name, async () => {
    const tv = await openTv(browser, { app: "browse" });
    tv.fake.catalog = new FakeDetails();
    if (size !== undefined) new FakeSettings(tv.fake).profile().set(CARD_PRESENTATION_KEY, { poster_size: size, caption: 'title_metadata' });
    try {
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount());
        await body(tv);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
    });
}

for (const size of ['compact', 'standard', 'large'] as const) detailTest(`Pinned ${size} episode rail keeps the entire focused card visible`, async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="episode:s1e11"]').waitFor();
    await tv.page.evaluate(() => document.fonts.ready);
    await tv.page.locator('[data-focus="next-episode"]').focus();
    await tv.remote(40);
    await tv.remote(40);
    const visibleEpisode = await readLive(tv, () => {
        const node = document.querySelector(".details-episodes :focus");
        const browse = node?.closest(".browse");
        if (!(node instanceof HTMLElement) || !(browse instanceof HTMLElement) || !node.isConnected) return null;
        const rect = node.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, scrollTop: browse.scrollTop };
    }, null, value => value.top >= 0 && value.bottom <= 1080 && value.scrollTop === 0, "complete focused episode visible");
    assert.ok(visibleEpisode.top >= 0 && visibleEpisode.bottom <= 1080, JSON.stringify(visibleEpisode));
    assert.equal(visibleEpisode.scrollTop, 0);
    await tv.remote(40);
    await tv.remote(38);
    const restored = await readLive(tv, () => {
        const node = document.querySelector(".details-episodes :focus");
        const browse = node?.closest(".browse");
        if (!(node instanceof HTMLElement) || !(browse instanceof HTMLElement) || !node.isConnected) return null;
        const rect = node.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, scrollTop: browse.scrollTop };
    }, null, value => value.top >= 0 && value.bottom <= 1080 && value.scrollTop === 0, "return from Cast restores the full pinned rail");
    assert.ok(restored.top >= 0 && restored.bottom <= 1080 && restored.scrollTop === 0, JSON.stringify(restored));
}, size);

detailTest("movie Details keeps playback and personal controls in one row with cast visible on entry", async tv => {
        await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
        await tv.page.locator('[data-focus="watchlist"]').waitFor();
        const row = tv.page.locator(".details-editorial .browse-actions");
        assert.equal(await row.locator('[data-focus="watchlist"]').count(), 1);
        assert.equal(await row.locator('[data-focus="version"]').count(), 1);
        assert.equal(await row.locator('[data-focus="more"]').count(), 1);
        assert.equal(await tv.page.locator('[data-focus="rating:1"]').count(), 0);
        assert.equal(await readLive(tv, () => {
            const node = document.querySelector(".details-editorial .browse-overview");
            if (node === null || !node.isConnected) return null;
            return getComputedStyle(node).webkitLineClamp;
        }, null, value => value === "3", "overview line clamp"), "3");
        const castFit = await readLive(tv, () => {
            const photos = [...document.querySelectorAll(".details-photo")];
            const first = photos[0];
            const second = photos[1];
            if (!(first instanceof HTMLElement) || !(second instanceof HTMLElement) || !first.isConnected || !second.isConnected) return null;
            const portrait = first.getBoundingClientRect();
            return { y: portrait.y, height: portrait.height, gap: second.getBoundingClientRect().left - portrait.right };
        }, null, value => value.y >= 0 && value.y + value.height <= 1080 && Math.abs(value.gap - 60) < 1, "cast portrait fits on entry");
        assert.ok(castFit.y >= 0 && castFit.y + castFit.height <= 1080, "cast portrait fits on entry");
        assert.ok(Math.abs(castFit.gap - 60) < 1, `cast portrait spacing ${castFit.gap}`);
        await tv.page.locator('[data-focus="version"]').click();
        await tv.page.getByRole("dialog", { name: "Version", exact: true }).waitFor();
        await tv.page.locator('[data-focus="version:43"]').click();
        assert.equal(await tv.focused(), "version");
});

detailTest('Details restores the hero from supporting rails and uses native selector presentation', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="version"]').focus();
    assert.equal(await tv.page.locator('[data-focus="version"] .details-action-label').textContent(), 'Versions');
    await tv.page.locator('[data-focus="version"]').click();
    const picker = tv.page.getByRole('dialog', { name: 'Version', exact: true });
    assert.equal(await picker.locator('h2').textContent(), 'VERSION');
    assert.match(await picker.locator('[data-focus="version:auto"]').textContent() ?? '', /Best match for this device/);
    await tv.remote(10009);
    await tv.page.locator('.details-people [data-focus]').first().focus();
    await tv.remote(38);
    assert.equal(await readLive(tv, () => {
        const node = document.querySelector(".browse");
        if (!(node instanceof HTMLElement) || !node.isConnected) return null;
        return node.scrollTop;
    }, null, value => value === 0, "hero scroll reset"), 0);
    assert.equal(await readLive(tv, () => {
        const node = document.querySelector(".details-facts-table");
        if (node === null || !node.isConnected) return null;
        return getComputedStyle(node).maxWidth;
    }, null, value => value === "1400px", "facts table width"), "1400px");
});

detailTest('Version options expose source codec, container and file size below the quality label', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const reply = catalog.route('GET', '/catalog/items/movie%3Am0001', 'p-owner');
    const body = reply?.body as { versions: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/items/movie%3Am0001?**', route => route.fulfill({ json: { ...body, versions: body.versions.map(file => ({ ...file, codec_video: 'h264', container: 'mkv', file_size: 8430000000 })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="version"]').click();
    assert.equal(await tv.page.locator('[data-focus="version:42"] .details-option-subtext').textContent(), 'H.264 · MKV · 8.43 GB');
});

detailTest('Version summary shows the best version while the picker lists every version in server order', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const reply = catalog.route('GET', '/catalog/items/movie%3Am0001', 'p-owner');
    const body = reply?.body as { versions: Record<string, unknown>[] };
    const [template] = body.versions;
    const versions = [
        { ...template, file_id: 'low', resolution: '720p', codec_video: 'h264', codec_audio: 'aac', hdr: false, edition_raw: 'Theatrical' },
        { ...template, file_id: 'uhd', resolution: '2160p', codec_video: 'hevc', codec_audio: 'eac3', hdr: true, video_tracks: [{ dolby_vision: 'profile 8' }], edition_raw: 'Director\'s Cut' },
        { ...template, file_id: 'mid', resolution: '1080p', codec_video: 'h264', codec_audio: 'aac', hdr: false },
    ];
    await tv.page.route('**/api/v2/catalog/items/movie%3Am0001?**', route => route.fulfill({ json: { ...body, versions, user_data: { played: false } } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    assert.equal(await tv.page.locator('[data-track-summary="version"] span').textContent(), 'Auto · 2160p · DV');
    await tv.page.locator('[data-focus="version"]').click();
    const picker = tv.page.getByRole('dialog', { name: 'Version', exact: true });
    await picker.locator('[data-focus="version:auto"]').waitFor();
    assert.deepEqual(await picker.locator('[role="radio"] .details-option-title').allTextContents(), ['Auto', '720p · H.264 · AAC', '2160p · HEVC · DV · EAC3', '1080p · H.264 · AAC']);
});

detailTest('Auto subtitle summary uses the Apple None fallback without effective preference fields', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const reply = catalog.route('GET', '/catalog/items/movie%3Am0001', 'p-owner');
    const body = reply?.body as Record<string, unknown>;
    await tv.page.route('**/api/v2/catalog/items/movie%3Am0001?**', route => route.fulfill({ json: { ...body, effective_subtitle_mode: undefined, effective_subtitle_track_signature: undefined } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    assert.equal(await tv.page.locator('[data-track-summary="subtitles"] span').textContent(), 'Auto · None');
});

detailTest("subtitle choices retain their language when stream titles repeat the codec", async tv => {
    const catalog = tv.fake.catalog;
    assert.ok(catalog instanceof FakeDetails);
    catalog.subtitleFiles.set("42", [
        { language: "eng", codec: "subrip", title: "SUBRIP", external: false },
        { language: "fra", codec: "subrip", title: "SUBRIP", external: false },
        { language: "eng", codec: "subrip", title: "Commentary", external: false },
    ]);
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="subtitles"]').click();
    assert.equal(await tv.page.locator('[data-focus="subtitle:0"]').textContent(), "EnglishSRT");
    assert.equal(await tv.page.locator('[data-focus="subtitle:1"]').textContent(), "FrenchSRT");
    assert.equal(await tv.page.locator('[data-focus="subtitle:2"] .details-option-subtext').textContent(), "Commentary · SRT");
});

detailTest("More owns accessible personal-action loading and failure announcements", async tv => {
    const held = tv.fake.hold("/capabilities/personal-lists", true);
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="more"]').click();
    const panel = tv.page.getByRole("dialog", { name: "More", exact: true });
    assert.equal(await panel.getByRole("status").filter({ hasText: "Loading personal actions." }).count(), 1);
    held.release();
    await panel.locator('[data-focus="favorites"]').waitFor();
    const catalog = tv.fake.catalog;
    assert.ok(catalog instanceof FakeDetails);
    catalog.mutationFailure = problem(422, "validation_failed", "Unavailable action");
    await panel.locator('[data-focus="watched"]').click();
    await tv.page.locator('[data-focus="more"]').click();
    await panel.getByRole("alert").filter({ hasText: "Could not update watched." }).waitFor();
    assert.equal(await panel.getByRole("alert").count(), 1);
});

for (const kind of ["favorites", "watchlist"] as const) detailTest(`online Details preserves unresolved ${kind} through automatic recovery`, async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="watchlist"]').waitFor();
    if (kind === "favorites") await tv.page.locator('[data-focus="more"]').click();
    const source = kind;
    let failures = 0;
    tv.page.on("requestfailed", request => { if (request.url().includes(`/${source}/movie%3Am0001/membership`)) failures++; });
    await tv.page.route(`**/api/v2/${source}/movie%3Am0001/membership`, route => route.abort("connectionrefused"));
    await tv.page.locator(`[data-focus="${kind}"]`).click();
    await tv.eventually(async () => failures >= 1, "membership readback failed");
    await tv.jump(1000);
    await tv.eventually(async () => failures >= 2, "membership retry exhausted");
    await tv.jump(0);
    if (kind === "favorites") await tv.page.locator('[data-focus="more"]').click();
    const retry = tv.page.getByRole("button", { name: `Retry ${kind}`, exact: true });
    await retry.waitFor();
    const reads = () => tv.fake.requests.filter(request => request.path.startsWith("/catalog/items/movie%3Am0001")).length;
    const before = reads();
    if (kind === "favorites") await tv.remote(10009);
    await tv.jump(15000);
    await tv.eventually(async () => reads() > before, "automatic recovery refreshed initially online Details");
    await tv.jump(1000);
    if (kind === "favorites") await tv.page.locator('[data-focus="more"]').click();
    assert.equal(await retry.count(), 1, "unconfirmed write retains its Retry control");
    await tv.page.unroute(`**/api/v2/${source}/movie%3Am0001/membership`);
    await retry.click();
    await tv.eventually(async () => !await retry.count(), "fresh membership reconciles the accepted write");
});

detailTest("cached Details recovery restores failed personal controls", async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().waitFor();
    await homeDetailsRead(tv);
    const personal = tv.fake.hold("/capabilities/personal-lists", true);
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
    await tv.remote(10009);
    personal.release();
    await tv.page.route("**/api/v2/**", route => route.abort("connectionrefused"));
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.jump(35000);
    await tv.page.locator('[data-focus="more"]').waitFor();
    await tv.page.unroute("**/api/v2/**");
    await tv.jump(35000);
    await tv.page.locator('[data-focus="watchlist"]').waitFor();
    assert.equal(await tv.page.locator('[data-focus="watchlist"]').count(), 1);
    assert.doesNotMatch(await tv.page.locator(".browse").innerText(), /Can't reach server/);
});

for (const id of ["movie:m0001", "series:s1"]) detailTest(`${id} retains full backdrop, logo and portrait URLs offline`, async tv => {
    const catalog = tv.fake.catalog;
    assert.ok(catalog instanceof FakeDetails);
    const route = catalog.route.bind(catalog);
    const url = (name: string): string => new URL(`/art/${name}.svg?signature=session`, tv.page.url()).href;
    catalog.route = (method, path, profile, body) => {
        const reply = route(method, path, profile, body);
        if (new URL(path, "https://fake.invalid").pathname !== `/catalog/items/${encodeURIComponent(id)}` || reply?.status !== 200) return reply;
        return { ...reply, body: { ...reply.body as Record<string, unknown>, backdrop_url: url("backdrop"), logo_url: url("logo"), cast: [{ person_id: "7", name: "River Vale", character: "Alex", order: 0, photo_url: url("portrait") }] } };
    };
    new FakeSettings(tv.fake);
    const card = tv.page.locator(`[data-section="recently_added"] [data-focus="${id}"]`).first();
    await card.click();
    const logo = tv.page.locator('.details-logo');
    await tv.page.locator('.details-editorial h1').waitFor();
    await tv.page.locator('.details-hero .skyline-backdrop').waitFor();
    assert.equal(await tv.page.locator('.details-hero .skyline-backdrop').getAttribute("src"), url("backdrop"));
    await logo.waitFor();
    await tv.remote(10009);
    await tv.page.route("**/api/v2/**", request => request.abort("connectionrefused"));
    await card.click();
    await tv.jump(35000);
    await logo.waitFor();
    assert.equal(await tv.page.locator('.details-hero .skyline-backdrop').getAttribute("src"), url("backdrop"));
    assert.equal(await logo.getAttribute("src"), url("logo"));
    assert.equal(await tv.page.locator('.details-photo img, img.details-photo').first().getAttribute("src"), url("portrait"));
});

detailTest("unvisited offline Details uses the centred warning and remote Back", async tv => {
    const card = tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first();
    await card.waitFor();
    await tv.page.route("**/api/v2/catalog/items/**", route => route.abort("connectionrefused"));
    await card.click();
    await tv.jump(35000);
    const retry = tv.page.getByRole("button", { name: "Try Again", exact: true });
    await retry.waitFor();
    assert.equal(await tv.page.locator('.details-failure svg').count(), 1);
    const box = await retry.boundingBox();
    assert.ok(box && Math.abs(box.x + box.width / 2 - 960) < 2);
    await tv.remote(10009);
    await card.waitFor();
});

for (const reducedMotion of ["reduce", "no-preference"] as const) detailTest(`cached episode Retry is inline below the rail and recovery reveals the hero (${reducedMotion})`, async tv => {
    await tv.page.emulateMedia({ reducedMotion });
    const card = tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first();
    await card.click();
    await tv.page.locator('.details-episodes [data-focus="episode:s1e11"]').waitFor();
    await tv.remote(10009);
    await tv.page.route("**/api/v2/**", route => route.abort("connectionrefused"));
    await card.click();
    await tv.jump(35000);
    const retry = tv.page.getByRole("button", { name: "Retry", exact: true });
    await retry.waitFor();
    const notice = tv.page.locator('.details-episode-error');
    assert.equal(await notice.innerText(), "Couldn't load episodes.\nRetry");
    assert.equal(await notice.evaluate(node => getComputedStyle(node).fontSize), "18px");
    assert.ok((await notice.boundingBox())!.y > (await tv.page.locator('.details-episodes').boundingBox())!.y);
    await tv.page.locator('[data-focus="season:1"]').focus();
    await tv.remote(40);
    assert.equal(await tv.focused(), "episode:s1e11");
    await tv.remote(40);
    assert.equal(await tv.focused(), "retry-episodes");
    await tv.page.unroute("**/api/v2/**");
    await retry.click();
    await tv.eventually(async () => await retry.count() === 0, "retry row removed");
    assert.equal(await tv.focused(), "next-episode");
    await tv.jump(250);
    assert.equal(await tv.page.locator('.browse').evaluate(node => node.scrollTop), 0);
});

detailTest("series current episode keeps its outline while season chips own focus", async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    const current = tv.page.locator('.details-episodes [aria-current="true"]');
    await current.waitFor();
    await tv.page.locator('[data-focus="season:1"]').focus();
    assert.equal(await current.getAttribute("data-focus"), "episode:s1e11");
    const currentPaint = await readLive(tv, () => {
        const card = document.querySelector('.details-episodes [aria-current="true"]');
        const art = card?.querySelector(".browse-art");
        const title = card?.querySelector(".browse-card-title");
        if (card === null || art === null || art === undefined || title === null || title === undefined || !card.isConnected) return null;
        return { outline: getComputedStyle(art).outline, color: getComputedStyle(title).color };
    }, null, value => value.outline === "rgba(255, 255, 255, 0.7) solid 4px" && value.color === "rgb(255, 255, 255)", "current episode outline");
    assert.equal(currentPaint.outline, "rgba(255, 255, 255, 0.7) solid 4px");
    assert.equal(currentPaint.color, "rgb(255, 255, 255)");
    await tv.page.locator('[data-focus="season:2"]').click();
    await tv.page.locator('.details-episodes [data-focus="episode:s1e21"]').waitFor();
    assert.equal(await current.getAttribute('data-focus'), 'episode:s1e21', "selected season highlights its retargeted episode");
});

detailTest("series Details activates season chips on focus and restores its inline episode rail", async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-view="item:series:s1"]').waitFor();
    assert.equal(await tv.page.locator('[data-focus="season:1"].browse-card').count(), 0, "seasons are chips");
    await tv.page.locator('.details-episodes [data-focus="episode:s1e11"]').waitFor();
    const episodeReads = (): number => tv.fake.requests.filter(request => request.path.includes("/episodes")).length;
    await tv.page.locator('.details-episodes [data-focus="episode:s1e21"]').waitFor();
    const before = episodeReads();
    await tv.page.locator('[data-focus="season:1"]').focus();
    await tv.remote(39);
    assert.equal(await tv.focused(), "season:2");
    await tv.jump(100);
    await tv.page.locator('.details-episodes [data-focus="episode:s1e21"]').waitFor();
    assert.equal(episodeReads(), before, "focus selects the already warmed season without rereading it");
    await tv.page.locator('[data-focus="episode:s1e21"]').click({ button: "right" });
    await tv.page.locator('[data-focus="episode-information"]').click();
    await tv.page.locator('[data-view="item:episode:s1e21"]').waitFor();
    await tv.remote(10009);
    await tv.page.locator('[data-view="item:series:s1"]').waitFor();
    assert.equal(await tv.focused(), "next-episode");
    assert.equal(await tv.page.locator('[data-focus="season:2"]').getAttribute("aria-pressed"), "true");
    assert.equal(episodeReads(), before, "ordinary Back reuses the loaded season");
});

detailTest("series shares the full detail hero and next-episode track selectors", async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="audio"]').waitFor({ timeout: 3000 });
    assert.equal(await tv.page.locator('.details-hero .skyline-hero-backdrop').count(), 1);
    assert.equal(await readLive(tv, () => {
        const hero = document.querySelector(".details-hero");
        if (hero === null || !hero.isConnected) return null;
        return hero.getBoundingClientRect().height;
    }, null, value => value === 690, "series hero height"), 690);
    assert.equal(await tv.page.locator('.details-playback-summary [data-track-summary]').count(), 3);
    await tv.page.locator('[data-focus="subtitles"]').click();
    await tv.page.locator('[data-focus="subtitle:off"]').click();
    assert.equal(await tv.focused(), "subtitles");
    await tv.page.getByText("Off", { exact: true }).waitFor();
    await tv.page.locator('[data-focus="next-episode"]').focus();
    await tv.remote(40);
    assert.match(await tv.focused() ?? "", /^season:/);
    await tv.remote(40);
    assert.match(await tv.focused() ?? "", /^episode:/);
});

for (const media of ["movie:m0001", "series:s1"]) detailTest(`a wrapped ${media} title keeps playback controls inside its hero`, async tv => {
    const catalog = tv.fake.catalog;
    assert.ok(catalog instanceof FakeDetails);
    const reply = catalog.route("GET", `/catalog/items/${encodeURIComponent(media)}`, "p-owner");
    assert.ok(reply?.body && typeof reply.body === "object");
    const body = reply.body;
    await tv.page.route(`**/api/v2/catalog/items/${encodeURIComponent(media)}?**`, async route => {
        await route.fulfill({ json: { ...body, title: "A Very Long Movie Title That Wraps Across Multiple Lines: The Complete Extended Story", logo_url: undefined, overview: "A long synopsis with enough words to wrap across three lines. ".repeat(8) } });
    });
    await tv.page.locator(`[data-section="recently_added"] [data-focus="${media}"]`).first().click();
    await tv.page.locator('[data-focus="more"]').waitFor();
    const bounds = await readLive(tv, series => {
        const hero = document.querySelector(".details-hero");
        const actions = hero?.querySelector(".browse-actions");
        if (hero === null || actions === null || actions === undefined || !hero.isConnected) return null;
        const box = hero.getBoundingClientRect();
        return { height: box.height, bottom: box.bottom, actionBottom: actions.getBoundingClientRect().bottom, series };
    }, media.startsWith("series"), value => value.actionBottom <= value.bottom && (value.series ? value.height === 690 : value.height >= 690), "wrapped title keeps actions inside the hero");
    if (media.startsWith("series")) assert.equal(bounds.height, 690);
    else assert.ok(bounds.height !== undefined && bounds.height >= 690);
    assert.ok(bounds.actionBottom !== undefined && bounds.bottom !== undefined && bounds.actionBottom <= bounds.bottom, JSON.stringify(bounds));
});

function readDetailEdges(): {
    rowLeft: number; rowRight: number; focusedLeft: number; stillLeft: number; layoutWidth: number; spacing: number; artScale: number;
    predecessorClipped: boolean; sliver: boolean; previousRight: number; badgeRight: number; liftPainted: boolean; probeY: number;
    castFirst: number; castEighth: number;
    extrasRight: number; extrasCardLeft: number; cardBackground: string; cardShadow: string; titleBackground: string;
    relatedRight: number; relatedCardLeft: number;
} | null {
    const row = document.querySelector(".details-episodes");
    const focused = row?.querySelector(":focus");
    const art = focused?.querySelector(".browse-art");
    const previous = focused?.previousElementSibling;
    const previousArt = previous?.querySelector(".browse-art");
    const badge = previous?.querySelector(".browse-watched");
    const people = document.querySelector(".details-people");
    const portraits = people?.querySelectorAll(".details-person") ?? [];
    const extras = document.querySelector(".details-extras");
    const extra = extras?.querySelector(".details-extra");
    const title = extra?.querySelector(".browse-card-title");
    const related = document.querySelector('[data-detail-section="related"]');
    const relatedCard = related?.querySelector(".browse-card");
    if (!(row instanceof HTMLElement) || !(focused instanceof HTMLElement) || !(art instanceof HTMLElement) || !(previous instanceof HTMLElement) || !(previousArt instanceof HTMLElement) || !(badge instanceof HTMLElement) || !(people instanceof HTMLElement) || portraits.length < 8 || !(extras instanceof HTMLElement) || !(extra instanceof HTMLElement) || !(title instanceof HTMLElement) || !(related instanceof HTMLElement) || !(relatedCard instanceof HTMLElement)) return null;
    if (![row, focused, art, previous, people, extras, extra, title, related, relatedCard].every(node => node.isConnected)) return null;
    for (const animation of art.getAnimations()) animation.finish();
    const still = art.getBoundingClientRect();
    const previousStill = previousArt.getBoundingClientRect();
    const probeY = still.top + still.height / 2;
    const leftOfInset = [20, 40, 70, 90].map(x => document.elementFromPoint(x, probeY));
    const sliverX = 100 + Math.max(0, previousStill.right - 100) / 2;
    const sliverHit = document.elementFromPoint(sliverX, probeY);
    const lift = document.elementFromPoint(focused.getBoundingClientRect().left - 4, probeY);
    return {
        rowLeft: row.getBoundingClientRect().left,
        rowRight: row.getBoundingClientRect().right,
        focusedLeft: focused.getBoundingClientRect().left,
        stillLeft: still.left,
        layoutWidth: art.offsetWidth,
        spacing: parseFloat(getComputedStyle(focused).marginRight),
        artScale: still.width / art.offsetWidth,
        predecessorClipped: leftOfInset.every(hit => hit === null || !previous.contains(hit)),
        sliver: sliverHit !== null && previous.contains(sliverHit),
        previousRight: previousStill.right,
        badgeRight: badge.getBoundingClientRect().right,
        liftPainted: lift !== null && art.contains(lift),
        probeY,
        castFirst: portraits[0]?.getBoundingClientRect().left ?? Number.NaN,
        castEighth: portraits[7]?.getBoundingClientRect().left ?? Number.NaN,
        extrasRight: extras.getBoundingClientRect().right,
        extrasCardLeft: extra.getBoundingClientRect().left,
        cardBackground: getComputedStyle(extra).backgroundColor,
        cardShadow: getComputedStyle(extra).boxShadow,
        titleBackground: getComputedStyle(title).backgroundColor,
        relatedRight: related.getBoundingClientRect().right,
        relatedCardLeft: relatedCard.getBoundingClientRect().left,
    };
}

detailTest("series detail rows match Apple's 100px inset, episode mask and still lift", async tv => {
    await tv.page.emulateMedia({ reducedMotion: "no-preference" });
    const catalog = tv.fake.catalog;
    assert.ok(catalog instanceof FakeDetails);
    const episodes = catalog.route("GET", "/catalog/series/series%3As1/seasons/1/episodes", "p-owner")?.body as { items: Record<string, unknown>[] };
    const item = catalog.route("GET", "/catalog/items/series%3As1", "p-owner")?.body as Record<string, unknown>;
    await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons/1/episodes?**", route => route.fulfill({ json: { items: episodes.items.map(episode => ({ ...episode, user_data: { played: true } })) } }));
    await tv.page.route("**/api/v2/catalog/items/series%3As1?**", route => route.fulfill({ json: {
        ...item,
        cast: Array.from({ length: 25 }, (_, order) => ({ person_id: String(order), name: `Actor ${order}`, character: "Role", order })),
        videos: [{ kind: "trailer", site: "YouTube", site_key: "abc_def-1", name: "Official Trailer", is_official: true }],
    } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="episode:s1e12"]').focus();
    await tv.page.locator(".details-extras").waitFor();
    await tv.page.locator('[data-detail-section="related"] .browse-card').first().waitFor();
    await tv.jump(400);
    await tv.page.evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
    const edge = await readLive(tv, readDetailEdges, null, value => value.artScale > 1.02 && value.probeY > 0 && value.probeY < 1080 && !value.sliver && value.previousRight < 100, "settled detail edges");
    const leading = 100 + edge.layoutWidth * 0.025 + 2;
    assert.ok(Math.abs(edge.focusedLeft - leading) < 1, JSON.stringify(edge));
    assert.ok(Math.abs(edge.stillLeft - (leading - edge.layoutWidth * 0.025)) < 1, JSON.stringify(edge));
    assert.equal(edge.predecessorClipped, true, JSON.stringify(edge));
    assert.equal(edge.sliver, false, JSON.stringify(edge));
    assert.ok(edge.previousRight > 60 && edge.previousRight < 80, JSON.stringify(edge));
    assert.ok(edge.badgeRight <= 100, JSON.stringify(edge));
    assert.ok(Math.abs(edge.artScale - 1.05) < 0.02, JSON.stringify(edge));
    assert.equal(edge.liftPainted, true, JSON.stringify(edge));
    assert.ok(Math.abs(edge.rowRight - 1920) < 1, JSON.stringify(edge));
    assert.ok(Math.abs(edge.castFirst - 100) < 1, JSON.stringify(edge));
    assert.ok(edge.castEighth >= 1920 - 0.5, JSON.stringify(edge));
    assert.ok(Math.abs(edge.extrasCardLeft - 100) < 1, JSON.stringify(edge));
    assert.ok(Math.abs(edge.extrasRight - 1920) < 1, JSON.stringify(edge));
    assert.equal(edge.cardBackground, "rgba(0, 0, 0, 0)", JSON.stringify(edge));
    assert.equal(edge.cardShadow, "none", JSON.stringify(edge));
    assert.equal(edge.titleBackground, "rgba(0, 0, 0, 0)", JSON.stringify(edge));
    assert.ok(Math.abs(edge.relatedCardLeft - 100) < 1, JSON.stringify(edge));
    assert.ok(Math.abs(edge.relatedRight - 1920) < 1, JSON.stringify(edge));
});
