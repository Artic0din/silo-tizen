import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

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

detailTest('Series opens on Play with series facts and season Select enters its retargeted rail', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('.details-episodes [data-focus="episode:s1e11"]').waitFor();
    assert.equal(await tv.focused(), 'next-episode');
    assert.match(await tv.page.locator('.details-editorial .browse-meta').textContent() ?? '', /Seasons/);
    await tv.page.locator('[data-focus="season:2"]').click();
    await tv.eventually(async () => await tv.focused() === 'episode:s1e21', 'selected season enters rail');
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
    await tv.eventually(async () => (await tv.focused())?.startsWith('episode:') === true, 'season rail focused');
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

detailTest('Genres have spacing on unrated Movies and appear once in an episode hero', async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    for (const id of ['movie:m0001', 'series:s1']) {
        const reply = catalog.route('GET', `/catalog/items/${encodeURIComponent(id)}`, 'p-owner');
        const body = reply?.body as Record<string, unknown>;
        await tv.page.route(`**/api/v2/catalog/items/${encodeURIComponent(id)}?**`, route => route.fulfill({ json: { ...body, ratings: [], genres: ['Drama', 'Thriller'] } }));
        await tv.page.locator(`[data-section="recently_added"] [data-focus="${id}"]`).first().click();
        if (id === 'series:s1') await tv.page.locator('[data-focus="episode:s1e11"]').focus();
        const text = await tv.page.locator('.details-editorial .browse-meta').textContent() ?? '';
        assert.equal(text.split('Drama').length - 1, 1);
        assert.match(text, /\sDrama, Thriller/);
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
    const title = await tv.page.locator('.details-editorial .browse-title').boundingBox(); assert.equal(title?.y, 116);
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
});

detailTest('Track popovers anchor to the selector without dimming and focus Auto', async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="audio"]').click();
    assert.equal(await tv.focused(), 'audio:auto');
    assert.equal(await tv.page.locator('.skyline-dropdown-scrim').count(), 0);
    assert.match(await tv.page.locator('[data-focus="audio:auto"]').textContent() ?? '', /Use your Playback audio preference/);
});

detailTest('late Series episodes do not steal focus after remote navigation', async tv => {
    const held = tv.fake.hold('/catalog/series/series%3As1/seasons/1/episodes', true);
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="season:1"]').focus();
    await tv.remote(39);
    assert.equal(await tv.focused(), 'season:2');
    held.release();
    await tv.page.locator('[data-focus="episode:s1e11"]').waitFor();
    assert.equal(await tv.focused(), 'season:2');
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
    await tv.eventually(async () => tv.page.locator('.details-people').evaluate(node => { const rect = node.getBoundingClientRect(); return Math.abs((rect.top + rect.bottom) / 2 - 540) < 80; }), 'cast rail centred after its scroll animation');
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

function detailTest(name: string, body: (tv: Tv) => Promise<void>): void {
    test(name, async () => {
    const tv = await openTv(browser, { app: "browse" });
    tv.fake.catalog = new FakeDetails();
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

detailTest("subtitle choices retain their language when stream titles repeat the codec", async tv => {
    const catalog = tv.fake.catalog;
    assert.ok(catalog instanceof FakeDetails);
    catalog.subtitleFiles.set("42", [
        { language: "eng", codec: "subrip", title: "SUBRIP", external: false },
        { language: "fra", codec: "subrip", title: "SUBRIP", external: false },
    ]);
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="subtitles"]').click();
    assert.equal(await tv.page.locator('[data-focus="subtitle:0"]').textContent(), "English · SUBRIP");
    assert.equal(await tv.page.locator('[data-focus="subtitle:1"]').textContent(), "French · SUBRIP");
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

detailTest("series Details selects season chips explicitly and restores its inline episode rail", async tv => {
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-view="item:series:s1"]').waitFor();
    assert.equal(await tv.page.locator('[data-focus="season:1"].browse-card').count(), 0, "seasons are chips");
    await tv.page.locator('.details-episodes [data-focus="episode:s1e11"]').waitFor();
    const episodeReads = (): number => tv.fake.requests.filter(request => request.path.includes("/episodes")).length;
    const before = episodeReads();
    await tv.page.locator('[data-focus="season:1"]').focus();
    await tv.remote(39);
    assert.equal(await tv.focused(), "season:2");
    assert.equal(episodeReads(), before, "focus does not load another season");
    await tv.page.keyboard.press("Enter");
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

for (const media of ["movie:m0001", "series:s1"]) detailTest(`a wrapped ${media} title retains Apple's fixed hero and disclosure layout`, async tv => {
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
    assert.equal(bounds.height, 690);
    if (media.startsWith("series")) assert.ok(bounds.actionBottom !== undefined && bounds.bottom !== undefined && bounds.actionBottom <= bounds.bottom, JSON.stringify(bounds));
});
