import assert from "node:assert/strict";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { CARD_PRESENTATION_KEY, CARD_OVERLAYS_KEY } from "../../src/contracts/v2/settings.ts";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { homeDetailsRead, launchBrowser, openTv, type Tv } from "./support/tv.ts";

for (const current of [1, 5]) detailTest(`Measured five-card episode rail with E0${current} current`, async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const body = catalog.route('GET', '/catalog/series/series%3As1/seasons/1/episodes', 'p-owner')?.body as { items: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons/1/episodes?**', route => route.fulfill({ json: { items: Array.from({ length: 5 }, (_, i) => ({ ...body.items[0], content_id: `episode:s1e1${i + 1}`, episode_number: i + 1, user_data: { played: i + 1 < current, playback_position_seconds: i + 1 === current ? 60 : 0 } })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="episode:s1e15"]').waitFor();
    await tv.page.evaluate(() => document.fonts.ready);
    const measure = () => tv.page.locator('.details-episodes').evaluate(row => ({ left: row.getBoundingClientRect().left, width: row.clientWidth, scroll: row.scrollLeft, padding: getComputedStyle(row).paddingLeft, cards: [...row.querySelectorAll('.browse-art')].map(card => ({ x: card.getBoundingClientRect().x, width: card.getBoundingClientRect().width })) }));
    const rest = await measure();
    await tv.page.locator('[data-focus="episode:s1e11"]').focus();
    await tv.jump(500);
    await tv.eventually(async () => (await measure()).cards[0]!.width > 377, 'first card lift settled');
    assert.ok(Math.abs((await measure()).cards[0]!.x - 109) < 2);
    await tv.page.locator('[data-focus="episode:s1e15"]').focus();
    await tv.jump(500);
    await tv.eventually(async () => (await measure()).cards[4]!.width > 377, 'E05 lift settled');
    const focused = await measure();
    console.log('EPISODE MEASUREMENT', current, JSON.stringify({ rest, focused }));
    assert.ok(Math.abs(rest.cards[0]!.width - 360) < 1, JSON.stringify(rest));
    assert.equal(rest.scroll, current === 1 ? 0 : 400);
    assert.ok(Math.abs(focused.cards[4]!.x - 1309) < 2, JSON.stringify(focused));
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
    await tv.eventually(async () => tv.page.locator('.details-logo').evaluate(node => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0), 'title art decoded');
    const geometry = await tv.page.locator('.details-logo').evaluate(node => {
        const rect = node.getBoundingClientRect();
        const slot = node.parentElement!.getBoundingClientRect();
        return { top: rect.top, width: rect.width, height: rect.height, slotTop: slot.top, slotHeight: slot.height };
    });
    for (const [key, expected] of Object.entries({ top: art.top, width: art.width, height: art.height, slotTop: 116, slotHeight: 160 })) {
        assert.ok(Math.abs(geometry[key as keyof typeof geometry] - expected) < 0.5, `${key}: ${JSON.stringify(geometry)}`);
    }
});

detailTest('Hero uses measured series colours and genres only at rest', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="audio"]').waitFor();
    await tv.eventually(async () => tv.page.locator('.details-editorial .browse-meta').evaluateAll(nodes => nodes.length === 1 && getComputedStyle(nodes[0]!).color === 'rgb(225, 227, 228)'), 'series metadata colour after optional-data repaint');
    assert.equal(await tv.page.locator('.details-genres').count(), 1);
    assert.equal(await tv.page.locator('.details-editorial .browse-overview').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color)[0]), 'rgb(244, 245, 246)');
    await tv.page.locator('[data-focus="audio"]').focus();
    assert.equal(await tv.page.locator('.details-play').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(31, 51, 57)');
    assert.equal(await tv.page.locator('.details-playback-summary strong').first().evaluate(node => getComputedStyle(node).color), 'rgba(237, 237, 237, 0.5)');
});

detailTest('track picker truncates a long edition title within its 76px row', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const body = catalog.route('GET', '/catalog/items/movie%3Am0001', 'p-owner')?.body as { versions: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/items/movie%3Am0001?**', route => route.fulfill({ json: { ...body, versions: body.versions.map(file => ({ ...file, edition_raw: 'Extended Commentary Edition '.repeat(20) })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="version"]').click();
    const row = tv.page.locator('[data-focus="version:42"]');
    assert.equal(await row.locator('.details-option-title').count(), 1);
    assert.equal(await row.locator('.details-option-title').evaluate(node => getComputedStyle(node).textOverflow), 'ellipsis');
    assert.ok(await row.locator('.details-option-title').evaluate(node => node.scrollWidth > node.clientWidth));
    assert.equal(await row.evaluate(node => node instanceof HTMLElement ? node.offsetHeight : 0), 76);
});

detailTest('measured Apple movie typography and version popover geometry', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="version"]').focus();
    let styles: { color: string; maxHeight: string; lineHeight: string } | undefined;
    await tv.eventually(async () => {
        styles = await tv.page.locator('.details-editorial .browse-overview').evaluate(node => {
            const style = getComputedStyle(node);
            return { color: style.color, maxHeight: style.maxHeight, lineHeight: style.lineHeight };
        });
        return styles.color !== '';
    }, 'overview style sample survives optional-data repaint');
    assert.deepEqual(styles, { color: 'rgb(237, 237, 237)', maxHeight: '102px', lineHeight: '34px' });
    await tv.page.locator('[data-focus="version"]').click();
    assert.equal(await tv.page.locator('[data-focus="version"] .details-action-label').evaluate(node => getComputedStyle(node).position), 'static');
    await tv.eventually(async () => Math.abs((await tv.page.locator('.details-track-popover').boundingBox())!.width - 560) < .1, 'popover opening animation settled');
    const panel = await tv.page.locator('.details-track-popover').boundingBox();
    const row = await tv.page.locator('[data-focus="version:auto"]').boundingBox();
    assert.equal(panel?.width, 560);
    assert.equal(row?.width, 532);
    assert.equal(row?.height, 76);
});

detailTest('Details rail clearances and white focus styling follow the measured Apple layout', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-detail-section="related"] .browse-art').first().waitFor();
    const metrics = await tv.page.evaluate(() => {
        const related = document.querySelector('[data-detail-section="related"]')!;
        const previous = related.previousElementSibling!.previousElementSibling!;
        const facts = document.querySelector('.details-facts .browse-section-title')!;
        return {
            railGap: related.previousElementSibling!.getBoundingClientRect().top - previous.querySelector('.browse-card-subtitle')!.getBoundingClientRect().bottom,
            factsGap: facts.getBoundingClientRect().top - related.querySelector('.browse-card-title')!.getBoundingClientRect().bottom,
        };
    });
    assert.ok(Math.abs(metrics.railGap - 79) < 3, JSON.stringify(metrics));
    assert.ok(Math.abs(metrics.factsGap - 76) < 3, JSON.stringify(metrics));
    await tv.page.locator('[data-focus="version"]').focus();
    await tv.jump(400);
    const trigger = tv.page.locator('[data-focus="version"]');
    assert.equal(await trigger.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
    const width = (await trigger.boundingBox())!.width;
    const intrinsic = await trigger.evaluate(node => {
        const style = getComputedStyle(node);
        return node.querySelector('svg')!.getBoundingClientRect().width + node.querySelector('.details-action-label')!.getBoundingClientRect().width + parseFloat(style.columnGap) + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    });
    assert.ok(Math.abs(width - intrinsic) < 2, `Versions width ${width}, intrinsic ${intrinsic}`);
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
    const gap = await tv.page.locator('.details-series-rail').evaluate(rail => rail.nextElementSibling!.getBoundingClientRect().top - rail.querySelector('.browse-card-subtitle')!.getBoundingClientRect().bottom);
    assert.ok(Math.abs(gap - 79) < 3, `episode caption clearance ${gap}`);
});

detailTest('Details picker selection uses a check without a resting fill', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="audio"]').click();
    await tv.page.locator('[data-focus="audio:0"]').focus();
    const selected = tv.page.locator('[data-focus="audio:auto"]');
    assert.equal(await selected.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
    assert.equal(await selected.evaluate(node => getComputedStyle(node, '::before').content), '"✓"');
});

detailTest('Details More and Subtitles use white ellipsis and caption bubble glyphs', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="play"]').focus();
    assert.equal(await tv.page.locator('[data-focus="more"]').evaluate(node => getComputedStyle(node).color), 'rgb(255, 255, 255)');
    assert.equal(await tv.page.locator('[data-focus="subtitles"] svg').getAttribute('data-symbol'), 'captions.bubble');
});

detailTest('Down into an alternate season starts at its first episode and retargets the hero', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const reply = catalog.route('GET', '/catalog/series/series%3As1/seasons/2/episodes', 'p-owner');
    const body = reply?.body as { items: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons/2/episodes?**', route => route.fulfill({ json: { ...body, items: body.items.map((item, index) => ({ ...item, user_data: { played: index === 0, playback_position_seconds: index === 1 ? 60 : 0 } })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="season:2"]').focus();
    await tv.jump(100);
    await tv.page.locator('[data-focus="episode:s1e21"]').waitFor();
    await tv.remote(40);
    assert.equal(await tv.focused(), 'episode:s1e21');
    await tv.page.getByRole('button', { name: /Play S2:E1|Resume S2:E1/ }).waitFor();
    await tv.eventually(async () => Math.abs(await tv.page.locator('[data-focus="episode:s1e21"] .browse-art').evaluate(node => node.getBoundingClientRect().x) - 109) < 2, 'episode artwork settles at x109');
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
        let clip: { x: number; y: number; width: number; height: number } | null = null;
        await tv.eventually(async () => { clip = await target.boundingBox(); return clip !== null; }, 'paint sample bounds survive optional-data repaint');
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
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons/14/episodes?**', route => route.fulfill({ json: { items: episodes.items.map(episode => ({ ...episode, season_number: 14 })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="season:14"]').click();
    await tv.page.locator('.details-episodes [data-focus]').first().waitFor();
    assert.equal(await tv.focused(), 'season:14');
    await tv.remote(40);
    await tv.remote(38);
    assert.equal(await tv.focused(), 'season:14');
    await tv.eventually(async () => tv.page.locator('[data-focus="season:14"]').evaluate(node => {
        const rect = node.getBoundingClientRect(), row = node.parentElement!.getBoundingClientRect();
        return rect.left >= row.left && rect.right <= row.right;
    }), 'selected pill revealed');
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
    await tv.eventually(async () => tv.page.locator('.details-editorial .browse-title').evaluate(node => node.isConnected && node.getBoundingClientRect().y === 116), 'title retains the y116 anchor after optional-data repaint');
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
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.locator('[data-focus="season-info"]').click();
    await tv.page.locator('.browse-episodes').waitFor();
    assert.equal(await tv.page.locator('.details-hero').evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector('.browse-episodes')!) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
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
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.locator('[data-focus="season-info"]').click();
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
            await tv.page.locator('[data-focus="more"]').click();
            await tv.page.locator('[data-focus="season-info"]').click();
        }
    }
    await tv.page.locator(`.details-hero[data-media-type="${kind.toLowerCase()}"]`).waitFor();
    await tv.page.evaluate(() => document.fonts.ready);
    const geometry = await tv.page.locator('.details-hero').evaluate(node => {
        const hero = node.getBoundingClientRect(), actions = node.querySelector('.browse-actions')!.getBoundingClientRect();
        return { heroBottom: hero.bottom, actionBottom: actions.bottom };
    });
    assert.ok(geometry.actionBottom <= geometry.heroBottom, JSON.stringify(geometry));
    for (const key of [kind === 'Season' ? 'next-episode' : 'play', 'audio', 'subtitles', 'more']) {
        await tv.page.locator(`[data-focus="${key}"]`).focus();
        await tv.eventually(async () => tv.page.locator(`[data-focus="${key}"]`).evaluate(node => {
            const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= 1080;
        }), `${key} remains revealable`);
    }
    for (const key of ['version', 'audio', 'subtitles']) {
        await tv.page.locator(`[data-focus="${key}"]`).click();
        const rect = await tv.page.locator('.details-track-popover').boundingBox();
        assert.ok(rect && rect.y >= 48 && rect.y + rect.height <= 1032, `${key} picker stays within native screen insets: ${JSON.stringify(rect)}`);
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
    const image = tv.page.locator('.details-hero .skyline-backdrop');
    await image.waitFor();
    const readBounds = () => image.evaluate(node => {
        const frame = node.parentElement!.getBoundingClientRect();
        const art = node.getBoundingClientRect();
        return { heroTop: node.closest('.details-hero')!.getBoundingClientRect().top, frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height }, art: { x: art.x, y: art.y, width: art.width, height: art.height }, position: getComputedStyle(node).position };
    });
    await tv.eventually(async () => (await readBounds()).position === 'static', 'attached artwork uses the frame instead of the viewport');
    const bounds = await readBounds();
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
    await tv.eventually(async () => tv.page.locator('.details-page-wash').evaluate(node => (node as HTMLElement).style.background.includes('0.42') && !(node as HTMLElement).style.background.includes('10, 31, 36')), 'sampled artwork replaces fallback tint');
    const badge = tv.page.locator('.details-rating-badge');
    assert.equal(await badge.textContent(), 'TV-MA');
    assert.equal(await badge.evaluate(node => getComputedStyle(node).fontSize), '18px');
    assert.match(await tv.page.locator('.details-editorial .browse-meta').textContent() ?? '', /1h 30m/);
    assert.equal(await tv.page.locator('.details-director').textContent(), 'Directed by River Vale');
    assert.deepEqual(await tv.page.locator('.details-playback-summary strong').allTextContents(), ['VERSION', 'AUDIO', 'SUBTITLES']);
});

detailTest('Series thumbnail dimensions follow the Apple poster-size scale', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    const art = tv.page.locator('.details-episodes .browse-art').first();
    await art.waitFor();
    await tv.page.locator('.browse').evaluate(node => (node as HTMLElement).style.setProperty('--poster-scale', '0.86'));
    const size = await art.evaluate(node => ({ width: (node as HTMLElement).offsetWidth, height: (node as HTMLElement).offsetHeight }));
    assert.ok(Math.abs(size.width - 360 * 0.86) < 1, `compact width ${size.width}`);
    assert.ok(Math.abs(size.height - 200 * 0.86) < 1, `compact height ${size.height}`);
});

detailTest('Series current episode occupies the leading slot when entering a long rail', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const reply = catalog.route('GET', '/catalog/series/series%3As1/seasons/1/episodes', 'p-owner');
    assert.ok(reply?.body && typeof reply.body === 'object');
    const body = reply.body as { items: Record<string, unknown>[] };
    await tv.page.route('**/api/v2/catalog/series/series%3As1/seasons/1/episodes?**', route => route.fulfill({ json: { items: Array.from({ length: 12 }, (_, index) => ({ ...body.items[0], content_id: `episode:window${index}`, episode_number: index + 1, user_data: { played: false, in_progress_count: index === 6 ? 1 : 0 } })) } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="episode:window6"]').waitFor();
    await tv.eventually(async () => await tv.focused() === 'next-episode', 'Play focused on entry');
    assert.equal(await tv.focused(), 'next-episode');
    await tv.eventually(async () => tv.page.locator('[data-focus="episode:window6"]').evaluate(node => {
        const row = node.closest('.browse-row'); if (row === null) return false;
        return Math.abs(node.getBoundingClientRect().left - row.getBoundingClientRect().left - parseFloat(getComputedStyle(row).paddingLeft)) < 2;
    }), 'current episode anchored at the leading slot');
    await tv.page.locator('[data-focus="episode:window9"]').focus();
    await tv.jump(400);
    assert.ok(await tv.page.locator('.details-episodes').evaluate(node => node.scrollLeft > 1000));
    await tv.page.locator('[data-focus="season:1"]').click();
    await tv.jump(400);
    assert.equal(await tv.focused(), 'season:1');
    assert.equal(await tv.page.locator('.details-episodes').evaluate(node => node.scrollLeft), 0, 'reselect reveals E01 before Down');
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
    await tv.eventually(async () => tv.page.locator('.details-photo').first().evaluate(node => {
        const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= 1080;
    }), 'cast visible after remote Down');
    const scrolled = await tv.page.locator('.browse').evaluate(node => node.scrollTop);
    assert.ok(scrolled > 0, 'Details owns vertical scrolling');
    await tv.jump(400);
    assert.ok(await tv.page.locator('.details-people').evaluate(node => Math.abs((node.previousElementSibling?.getBoundingClientRect().top ?? 0) - 546) < 2), 'cast heading settles at the measured Apple anchor');
    const restingTop = await tv.page.locator('.details-people').evaluate(node => {
        const card = node.querySelector<HTMLElement>('.details-person')!;
        const rect = card.getBoundingClientRect();
        return rect.top + (rect.height - card.offsetHeight) / 2;
    });
    // The running Apple build measured 615; TVDetailCastRail includes 12px vertical padding.
    assert.ok(Math.abs(restingTop - 615) < 3, `resting cast circle top ${restingTop}`);
    assert.ok(await tv.page.locator('.details-people').evaluate(row => {
        const photo = row.querySelector('.details-photo')!.getBoundingClientRect();
        const bounds = row.getBoundingClientRect();
        return photo.top - 2 >= bounds.top && photo.bottom + 2 <= bounds.bottom;
    }), 'scaled portrait and focus ring stay inside the row paint area');
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
    await tv.eventually(async () => tv.page.locator('.details-episodes :focus').evaluate(node => {
        const rect = node.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= 1080;
    }), 'complete focused episode visible');
    assert.equal(await tv.page.locator('.browse').evaluate(node => node.scrollTop), 0);
    await tv.remote(40);
    await tv.remote(38);
    await tv.eventually(async () => tv.page.locator('.details-episodes :focus').evaluate(node => {
        const rect = node.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= 1080 && node.closest('.browse')?.scrollTop === 0;
    }), 'return from Cast restores the full pinned rail');
}, size);

detailTest("movie Details keeps playback and personal controls in one row with cast visible on entry", async tv => {
        await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
        await tv.page.locator('[data-focus="watchlist"]').waitFor();
        const row = tv.page.locator(".details-editorial .browse-actions");
        assert.equal(await row.locator('[data-focus="watchlist"]').count(), 1);
        assert.equal(await row.locator('[data-focus="version"]').count(), 1);
        assert.equal(await row.locator('[data-focus="more"]').count(), 1);
        assert.equal(await tv.page.locator('[data-focus="rating:1"]').count(), 0);
        assert.equal(await tv.page.locator(".details-editorial .browse-overview").evaluate(node => getComputedStyle(node).webkitLineClamp), "3");
        const portrait = await tv.page.locator(".details-photo").first().boundingBox();
        assert.ok(portrait && portrait.y >= 0 && portrait.y + portrait.height <= 1080, "cast portrait fits on entry");
        const gap = await tv.page.locator(".details-photo").evaluateAll(nodes => (nodes[1]?.getBoundingClientRect().left ?? 0) - (nodes[0]?.getBoundingClientRect().right ?? 0));
        assert.ok(Math.abs(gap - 60) < 1, `cast portrait spacing ${gap}`);
        await tv.page.locator('[data-focus="version"]').click();
        await tv.page.getByRole("dialog", { name: "Version", exact: true }).waitFor();
        await tv.page.locator('[data-focus="version:43"]').click();
        assert.equal(await tv.focused(), "version");
        await tv.page.locator('[data-focus="more"]').click();
        await tv.page.locator('[data-focus="rate"]').click();
        await tv.page.locator('[data-focus="rating:2"]').click();
        await tv.page.getByText("Your rating: 2 of 5 stars", { exact: true }).waitFor();
        await tv.remote(10009);
        assert.equal(await tv.focused(), "rate");
        await tv.remote(10009);
        assert.equal(await tv.focused(), "more");
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
    await tv.eventually(() => tv.page.locator('.browse').evaluate(node => node.scrollTop === 0), 'hero scroll reset');
    assert.equal(await tv.page.locator('.details-facts-table').evaluate(node => getComputedStyle(node).maxWidth), '1400px');
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
    await panel.getByRole("alert").filter({ hasText: "Could not update watched." }).waitFor();
    assert.equal(await panel.getByRole("alert").count(), 1);
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
    assert.equal(await current.locator(".browse-art").evaluate(node => getComputedStyle(node).outline), "rgba(255, 255, 255, 0.7) solid 4px");
    assert.equal(await current.locator(".browse-card-title").evaluate(node => getComputedStyle(node).color), "rgb(255, 255, 255)");
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
    const heroHeight = await tv.page.evaluate(() => document.querySelector('.details-hero')?.getBoundingClientRect().height);
    assert.equal(heroHeight, 690);
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
    const bounds = await tv.page.evaluate(() => {
        const hero = document.querySelector('.details-hero');
        const actions = hero?.querySelector('.browse-actions');
        return { height: hero?.getBoundingClientRect().height, bottom: hero?.getBoundingClientRect().bottom, actionBottom: actions?.getBoundingClientRect().bottom };
    });
    if (media.startsWith("series")) assert.equal(bounds.height, 690);
    else assert.ok(bounds.height !== undefined && bounds.height >= 690);
    assert.ok(bounds.actionBottom !== undefined && bounds.bottom !== undefined && bounds.actionBottom <= bounds.bottom, JSON.stringify(bounds));
});
