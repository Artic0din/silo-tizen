import assert from "node:assert/strict";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { CARD_PRESENTATION_KEY, CARD_OVERLAYS_KEY } from "../../src/contracts/v2/settings.ts";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, pauseTvClock, readLive, type Tv } from "./support/tv.ts";

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

function liveScroll(_arg: null): number | null {
    const row = document.querySelector(".details-episodes");
    if (!(row instanceof HTMLElement) || !row.isConnected) return null;
    return row.scrollLeft;
}

/** Episode item reads are issued four at a time. Count focus only after every painted episode has been read. */
async function settledEpisodePrefetch(tv: Tv): Promise<void> {
    await tv.eventually(async () => {
        const ids = await tv.page.locator('.details-episodes [data-focus^="episode:"]').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus") ?? ""));
        if (ids.length === 0) return false;
        const read = new Set(tv.fake.requests.filter(request => request.path.startsWith("/catalog/items/")).map(request => decodeURIComponent((request.path.split("?")[0] ?? "").slice("/catalog/items/".length))));
        return ids.every(id => read.has(id));
    }, "opening episode prefetches settled");
}

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

detailTest('More is an anchored popover with Apple ordering and immediate Back focus', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.eventually(async () => await tv.page.locator('[data-focus="watchlist"]').count() === 1, 'personal actions loaded');
    await tv.page.locator('[data-focus="more"]').click();
    const panel = tv.page.getByRole('dialog', { name: 'More', exact: true });
    assert.equal(await panel.evaluate(node => node.classList.contains('details-track-popover')), true);
    assert.deepEqual(await panel.locator('button').allTextContents(), ['Add to Favorites', 'Mark as Watched']);
    assert.equal(await tv.focused(), 'favorites');
    const panelBox = await readLive(tv, () => {
        const dialog = document.querySelector(".details-more-popover");
        if (!(dialog instanceof HTMLElement) || !dialog.isConnected) return null;
        const buttons = [...dialog.querySelectorAll("button")].map(button => button instanceof HTMLElement ? button.offsetHeight : 0);
        return { width: dialog.offsetWidth, buttons };
    }, null, box => box.width === 560 && box.buttons.length === 2 && box.buttons.every(height => height === 54), "More panel geometry");
    assert.equal(panelBox.width, 560);
    assert.deepEqual(panelBox.buttons, [54, 54]);
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

detailTest('More uses available space below then above the trigger', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="watchlist"]').waitFor();
    for (const top of [250, 850]) {
        const style = await tv.page.addStyleTag({ content: `[data-focus="more"] { position: fixed !important; top: ${top}px !important; }` });
        await tv.page.locator('[data-focus="more"]').focus();
        await tv.page.keyboard.press('Enter');
        const placedBelow = top === 250;
        const placement = await readLive(tv, below => {
            const panel = document.querySelector<HTMLElement>(".details-more-popover");
            const anchor = document.querySelector('[data-focus="more"]');
            if (panel === null || anchor === null || !panel.isConnected || !anchor.isConnected) return null;
            const bounds = anchor.getBoundingClientRect();
            void below;
            return { top: parseFloat(panel.style.top), height: panel.offsetHeight, anchorTop: bounds.top, anchorBottom: bounds.bottom };
        }, placedBelow, sample => sample.top === (placedBelow ? sample.anchorBottom + 14 : sample.anchorTop - 14 - sample.height), "More popover placement");
        assert.equal(placement.top, placedBelow ? placement.anchorBottom + 14 : placement.anchorTop - 14 - placement.height);
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
    assert.deepEqual(await panel.locator('button').allTextContents(), ['Add to Favorites', 'Mark Series Watched', 'Mark Season Watched']);
    catalog.mutationFailure = problem(422, 'validation_failed', 'Unavailable action');
    await panel.locator('[data-focus="season-watched"]').click();
    assert.equal(await panel.count(), 0);
    assert.equal(await tv.focused(), 'more');
    await tv.page.locator('[data-focus="more"]').click();
    await panel.getByRole('button', { name: 'Retry season watched', exact: true }).waitFor();
    await panel.getByRole('alert').filter({ hasText: 'Could not update season watched.' }).waitFor();
    await tv.remote(10009);
    await tv.page.locator('[data-focus="person:7"]').first().click();
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

detailTest("episode boundary failure requires explicit Retry while loaded-season focus stays read-free", async tv => {
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
    await card(3, 13).focus();
    await tv.page.locator('[data-focus="audio"]').focus(); await tv.jump(100);
    assert.equal(reads.length, 3, "leaving the rail cancels boundary dwell");
    await card(3, 13).focus(); await tv.jump(100);
    const retry = tv.page.getByRole("button", { name: "Retry more episodes", exact: true });
    await retry.waitFor();
    assert.deepEqual(reads.slice(3), [4]);
    for (let index = 0; index < 3; index++) {
        await card(3, 12).focus(); await card(3, 13).focus(); await tv.jump(100);
    }
    assert.equal(reads.length, 4, "failed boundary revisits never retry");
    failBoundary = false;
    await retry.focus(); await tv.page.keyboard.press("Enter");
    await card(4, 13).waitFor();
    assert.deepEqual(reads.slice(3), [4, 4], "explicit Retry reads only the failed season");
    assert.equal(await retry.count(), 0);
    assert.notEqual(await tv.focused(), "retry-neighbors", "the removed Retry control cannot retain focus");
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

detailTest("Episode rail paints neighbouring stills to both screen edges without changing scroll steps", async tv => {
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
        return { left: box.left, right: box.right, visible: document.elementFromPoint(1, art.y + art.height / 2)?.closest("[data-focus]")?.getAttribute("data-focus") ?? null };
    }, null, value => value.left === 0 && value.right === 1920 && value.visible === "episode:edge0", "episode rail reaches both screen edges");
    assert.equal(bounds.left, 0);
    assert.equal(bounds.right, 1920);
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
        return last !== undefined && next !== undefined && Math.abs(last.frameX - 1158) < 1 && Math.abs(last.x - 1151) < 2 && Math.abs(next.right - 1817) < 1 && value.scroll === 3846;
    }, "E05 focus lift settled");
    // The row-local leading slot is now Swift's 100px, 7px left of its old
    // 107px slot. Keep painted focus bounds separate from the unscaled frame.
    // Integer scrollLeft rounds the 3845.6px terminal offset to 3846px.
    assert.ok(Math.abs(end.cards[14]!.frameX - 1158) < 1, JSON.stringify(end));
    assert.ok(Math.abs(end.cards[14]!.x - 1151) < 2, JSON.stringify(end));
    assert.ok(Math.abs(end.cards[15]!.right - 1817) < 1, JSON.stringify(end));
    assert.equal(end.scroll, 3846);
    await settledEpisodePrefetch(tv);
    const reads = tv.fake.requests.length;
    await card('s13e5').focus(); await tv.jump(500);
    const middle = await readLive(tv, liveRail, null, value => {
        const card = value.cards[4];
        return card !== undefined && Math.abs(card.x - 102) < 2 && Math.abs(value.scroll - 1398.4) < 1;
    }, "interior focus lift settled");
    assert.ok(Math.abs(middle.cards[4]!.x - 102) < 2, JSON.stringify(middle));
    assert.ok(Math.abs(middle.scroll - 1398.4) < 1, JSON.stringify(middle));
    await card('s13e1').focus(); await tv.jump(500); await tv.remote(37);
    const start = await readLive(tv, liveRail, null, value => {
        const card = value.cards[0];
        return card !== undefined && value.scroll === 0 && Math.abs(card.frameX - 109) < 1 && Math.abs(card.x - 102) < 2;
    }, "first focus lift settled");
    assert.equal(start.scroll, 0);
    assert.ok(Math.abs(start.cards[0]!.frameX - 109) < 1, JSON.stringify(start));
    assert.ok(Math.abs(start.cards[0]!.x - 102) < 2, JSON.stringify(start));
    assert.equal(await tv.focused(), 'episode:s13e1');
    assert.equal(tv.fake.requests.length, reads, 'loaded neighbour and interior focus start no reads');
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
    }, null, value => value === 111, "E05 frame x"), 111);
    await tv.page.locator('[data-focus="episode:s14e5"]').focus();
    await tv.jump(1500);
    await settledEpisodePrefetch(tv);
    const reads = tv.fake.requests.length;
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
    assert.equal(tv.fake.requests.length, reads, 'ordinary moves and terminal focus make no reads');
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
    }, null, value => value === "rgb(244, 245, 246)", "series overview colour"), "rgb(244, 245, 246)");
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

detailTest('track picker truncates a long edition title within its 76px row', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const body = catalog.route('GET', '/catalog/items/movie%3Am0001', 'p-owner')?.body as { versions: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/items/movie%3Am0001?**', route => route.fulfill({ json: { ...body, versions: body.versions.map(file => ({ ...file, edition_raw: 'Extended Commentary Edition '.repeat(20) })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="version"]').click();
    const row = tv.page.locator('[data-focus="version:42"]');
    assert.equal(await row.locator('.details-option-title').count(), 1);
    const edition = await readLive(tv, () => {
        const title = document.querySelector('[data-focus="version:42"] .details-option-title');
        const option = document.querySelector('[data-focus="version:42"]');
        if (!(title instanceof HTMLElement) || !(option instanceof HTMLElement) || !title.isConnected || !option.isConnected) return null;
        return { overflow: getComputedStyle(title).textOverflow, clipped: title.scrollWidth > title.clientWidth, height: option.offsetHeight };
    }, null, value => value.overflow === "ellipsis" && value.clipped && value.height === 76, "edition row");
    assert.equal(edition.overflow, "ellipsis");
    assert.ok(edition.clipped);
    assert.equal(edition.height, 76);
});

detailTest('measured Apple movie typography and version popover geometry', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="version"]').focus();
    const styles = await readLive(tv, () => {
        const node = document.querySelector(".details-editorial .browse-overview");
        if (node === null || !node.isConnected) return null;
        const style = getComputedStyle(node);
        return { color: style.color, maxHeight: style.maxHeight, lineHeight: style.lineHeight };
    }, null, value => value.color === "rgb(237, 237, 237)" && value.maxHeight === "102px" && value.lineHeight === "34px", "overview style sample survives optional-data repaint");
    assert.deepEqual(styles, { color: "rgb(237, 237, 237)", maxHeight: "102px", lineHeight: "34px" });
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
    // The 360px frame starts at 111; the final 1.05 focus scale paints 9px left of it.
    const settled = await readLive(tv, () => {
        const card = document.querySelector('[data-focus="episode:s1e21"]');
        const art = card?.querySelector(".browse-art")?.getBoundingClientRect();
        if (card === null || art === undefined || !card.isConnected || card !== document.activeElement) return null;
        const box = card.getBoundingClientRect();
        return { x: box.x, artX: art.x, artWidth: art.width };
    }, null, value => Math.abs(value.x - 111) < 1 && Math.abs(value.artX - 102) < 2 && Math.abs(value.artWidth - 378) < 1, "episode artwork and focus scale settle at x102");
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
    assert.equal(await tv.focused(), 'more');
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
        assert.equal(await tv.page.locator('.details-genres').textContent(), id === 'series:s1' ? 'Drama, Thriller' : 'Drama, Thriller, Mystery');
        if (id === 'series:s1') await tv.page.locator('[data-focus="episode:s1e11"]').focus();
        const text = await tv.page.locator('.details-editorial .browse-meta').textContent() ?? '';
        assert.equal(text.split('Drama').length - 1, id === 'series:s1' ? 0 : 1);
        if (id !== 'series:s1') assert.match(text, /\sDrama, Thriller/);
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
    assert.equal(await tv.page.locator('[data-track-summary="version"] span').textContent(), 'Auto · 1080p');
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
    await tv.eventually(async () => tv.fake.requests.some(request => request.path.startsWith('/catalog/items/episode%3As1e12')), "season playback details prefetched");
    await tv.page.locator('[data-focus="episode:s1e12"]').focus();
    await tv.page.getByRole('button', { name: /Play S1:E2|Resume S1:E2/ }).waitFor();
    assert.match(await tv.page.locator('.details-editorial .browse-overview').textContent() ?? '', /Harbor Lights chapter 1\.2/);
    await settledEpisodePrefetch(tv);
    const before = tv.fake.requests.length;
    await tv.page.locator('[data-focus="episode:s1e11"]').focus();
    await tv.page.getByRole('button', { name: /Play S1:E1|Resume S1:E1/ }).waitFor();
    await tv.page.locator('[data-focus="episode:s1e12"]').focus();
    await tv.page.getByRole('button', { name: /Play S1:E2|Resume S1:E2/ }).waitFor();
    assert.equal(tv.fake.requests.length, before, "focus starts no reads");
    await tv.page.locator('[data-focus="next-episode"]').click();
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.plays.length > 0), 'handoff');
    assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.at(-1)?.contentId), 'episode:s1e12');
});

let browser: Browser;

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
    assert.match(await tv.focused() ?? '', /^person:/);
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

detailTest("a failed prefetched episode only retries on Select, never on focus", async tv => {
    const catalog = tv.fake.catalog;
    assert.ok(catalog instanceof FakeDetails);
    const reply = catalog.route('GET', '/catalog/items/episode%3As1e12', 'p-owner');
    assert.ok(reply);
    let failed = true;
    await tv.page.route('**/api/v2/catalog/items/episode%3As1e12?**', route => route.fulfill(failed ? { status: 500 } : { status: 200, json: reply.body }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.getByRole('button', { name: /Play S1:E1|Resume S1:E1/ }).waitFor();
    await tv.page.locator('[data-focus="episode:s1e12"]').focus();
    await tv.page.getByRole('button', { name: 'Retry episode', exact: true }).waitFor();
    for (const key of ['version', 'audio', 'subtitles']) assert.equal(await tv.page.locator(`[data-focus="${key}"]`).getAttribute('aria-disabled'), 'true', `${key} keeps its disabled slot`);
    const reads = (): number => tv.fake.requests.filter(request => request.path.startsWith('/catalog/items/episode%3As1e12')).length;
    const before = reads();
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
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

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
    const before = episodeReads();
    await tv.page.locator('[data-focus="season:1"]').focus();
    await tv.remote(39);
    assert.equal(await tv.focused(), "season:2");
    await tv.jump(100);
    await tv.page.locator('.details-episodes [data-focus="episode:s1e21"]').waitFor();
    assert.equal(episodeReads(), before + 1);
    await tv.page.locator('[data-focus="episode:s1e21"]').click({ button: "right" });
    await tv.page.locator('[data-focus="episode-information"]').click();
    await tv.page.locator('[data-view="item:episode:s1e21"]').waitFor();
    await tv.remote(10009);
    await tv.page.locator('[data-view="item:series:s1"]').waitFor();
    assert.equal(await tv.focused(), "episode:s1e21");
    assert.equal(await tv.page.locator('[data-focus="season:2"]').getAttribute("aria-pressed"), "true");
    assert.equal(episodeReads(), before + 1, "ordinary Back reuses the loaded season");
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
