// Details hero, meta lines and screen states against silo-apple 85679e7 tvOS (issue #395).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser, Route } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { CARD_PRESENTATION_KEY } from "../../src/contracts/v2/settings.ts";
import { launchBrowser, openTv, pauseTvClock, readLive, type Tv } from "./support/tv.ts";

const CAP = 0.9685;
const px = (points: number): string => `${Math.round(points * CAP * 1e4) / 1e4}px`;
const near = (actual: string, expected: string): boolean => Math.abs(parseFloat(actual) - parseFloat(expected)) < 0.01;
const MOVIE = '[data-section="recently_added"] [data-focus="movie:m0001"]';
const SERIES = '[data-section="recently_added"] [data-focus="series:s1"]';

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

function detailTest(name: string, body: (tv: Tv) => Promise<void>, size?: "large"): void {
    test(name, async () => {
        const tv = await openTv(browser, { app: "browse" });
        tv.fake.catalog = new FakeDetails();
        if (size !== undefined) new FakeSettings(tv.fake).profile().set(CARD_PRESENTATION_KEY, { poster_size: size, caption: "title_metadata" });
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

/** Serves the fake's own answer for a GET after `edit` rewrites it. */
async function patchJson<T>(tv: Tv, glob: string, edit: (body: T) => T): Promise<void> {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    await tv.page.route(glob, async (route: Route) => {
        const url = new URL(route.request().url());
        const body = catalog.route("GET", url.pathname.replace(/^\/api\/v2/, "") + url.search, "p-owner")?.body;
        assert.ok(body && typeof body === "object", url.pathname);
        await route.fulfill({ json: edit(structuredClone(body) as T) });
    });
}

/** Rewrites one Home card, as a server would send it. */
async function patchCard(tv: Tv, id: string, fields: Record<string, unknown>): Promise<void> {
    await patchJson<{ sections: { items: Record<string, unknown>[] }[] }>(tv, "**/api/v2/home/sections**", body => {
        for (const section of body.sections) section.items = section.items.map(item => item.content_id === id ? { ...item, ...fields } : item);
        return body;
    });
}

/** Serves the item's detail with fields replaced. */
async function patchDetail(tv: Tv, id: string, fields: Record<string, unknown>): Promise<void> {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const body = catalog.route("GET", `/catalog/items/${encodeURIComponent(id)}`, "p-owner")?.body;
    assert.ok(body && typeof body === "object");
    await tv.page.route(`**/api/v2/catalog/items/${encodeURIComponent(id)}?**`, route => route.fulfill({ json: { ...body, ...fields } }));
}

/** Leaves the item's detail unanswered, Home's prefetch included, and remounts so no cached copy opens the page. */
async function holdDetail(tv: Tv, id: string): Promise<void> {
    await tv.page.route(`**/api/v2/catalog/items/${encodeURIComponent(id)}?**`, () => undefined);
    await tv.page.evaluate(() => { window.browseHarness.clearResponseCache(); window.browseHarness.destroy(); window.browseHarness.mount(); });
}

function skeleton(): Record<string, unknown> | null {
    const page = document.querySelector<HTMLElement>(".details-loading-page");
    const hero = page?.querySelector<HTMLElement>(".details-hero");
    if (page === null || page === undefined || hero === null || hero === undefined || !page.isConnected) return null;
    const box = (node: Element | null | undefined): { x: number; y: number; width: number; height: number } | null => {
        if (node === null || node === undefined) return null;
        const rect = node.getBoundingClientRect();
        return { x: Math.round(rect.x * 100) / 100, y: Math.round(rect.y * 100) / 100, width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100 };
    };
    const style = (node: Element | null | undefined) => {
        if (node === null || node === undefined) return null;
        const value = getComputedStyle(node);
        return { size: value.fontSize, weight: value.fontWeight, tracking: value.letterSpacing, color: value.color, line: value.lineHeight };
    };
    const bars = (selector: string) => Array.from(page.querySelectorAll(`${selector} .details-loading-bar`)).map(node => {
        const rect = node.getBoundingClientRect();
        return { width: rect.width, height: rect.height, radius: getComputedStyle(node).borderTopLeftRadius, fill: getComputedStyle(node).backgroundColor };
    });
    return {
        focus: document.activeElement === page, label: page.getAttribute("aria-label"), buttons: page.querySelectorAll("button, [data-focus]:not(.details-loading-page)").length,
        hero: box(hero), editorial: getComputedStyle(page.querySelector(".details-loading-editorial")!).paddingTop,
        title: box(page.querySelector(".details-loading-title")), titleText: page.querySelector(".details-loading-title-text")?.textContent ?? null, titleStyle: style(page.querySelector(".details-loading-title-text")),
        titleBars: bars(".details-loading-title"),
        meta: box(page.querySelector(".details-loading-meta")), metaText: page.querySelector(".details-loading-meta > span:not(.details-loading-bar)")?.textContent ?? null, metaStyle: style(page.querySelector(".details-loading-meta")), metaBars: bars(".details-loading-meta"),
        synopsis: box(page.querySelector(".details-loading-synopsis")), overview: style(page.querySelector(".details-loading-overview")), lines: bars(".details-loading-lines"),
        labels: Array.from(page.querySelectorAll(".details-loading-label")).map(node => node.textContent), labelStyle: style(page.querySelector(".details-loading-label")),
        columns: Array.from(page.querySelectorAll(".details-loading-readout > div")).map(node => node.getBoundingClientRect().width), readoutBars: bars(".details-loading-readout"),
        actions: bars(".details-loading-actions"), actionGap: getComputedStyle(page.querySelector(".details-loading-actions")!).columnGap,
        rail: box(page.querySelector(".details-loading-cards")), cards: bars(".details-loading-cards"), cardGap: getComputedStyle(page.querySelector(".details-loading-cards")!).columnGap,
        art: page.querySelector(".skyline-art-frame")?.className ?? null, artFill: page.querySelector(".details-loading-art") === null ? null : getComputedStyle(page.querySelector(".details-loading-art")!).backgroundColor,
    };
}

detailTest("a held Details page paints the card's seed in Apple's loading frame and takes no button focus", async tv => {
    await patchCard(tv, "movie:m0001", { year: 2024, genres: ["Drama", "Mystery"], runtime: 112, content_rating: "pg-13", overview: "A remote observatory hears a message.", backdrop_url: "/art/last-signal-backdrop.svg" });
    await holdDetail(tv, "movie:m0001");
    await tv.page.locator(MOVIE).first().click();
    await tv.page.locator('[data-view="item:loading"]').waitFor();
    const frame = await readLive(tv, skeleton, null, value => value.focus === true, "seeded skeleton");
    assert.equal(frame.buttons, 0, "TVItemDetailLoadingView has no buttons");
    assert.match(String(frame.label), /^Loading details for /);
    assert.deepEqual(frame.hero, { x: 0, y: 0, width: 1920, height: 690 });
    assert.equal(frame.editorial, "116px");
    assert.deepEqual(frame.title, { x: 100, y: 116, width: 700, height: 132 });
    const title = frame.titleStyle as { size: string; weight: string; tracking: string; color: string; line: string };
    assert.ok(near(title.size, px(64)), title.size); assert.equal(title.weight, "700"); assert.equal(title.tracking, "-0.8px"); assert.equal(title.color, "rgb(255, 255, 255)");
    assert.equal(frame.metaText, "2024  ·  Drama  ·  1h 52m  ·  PG-13", "year, first genre, runtime and the upper-cased rating");
    const meta = frame.metaStyle as { size: string; weight: string; color: string };
    assert.ok(near(meta.size, px(24)), meta.size); assert.equal(meta.weight, "600"); assert.equal(meta.color, "rgba(255, 255, 255, 0.76)");
    assert.deepEqual(frame.meta, { x: 100, y: 262, width: (frame.meta as { width: number }).width, height: 36 });
    assert.deepEqual(frame.synopsis, { x: 100, y: 312, width: 920, height: 104 });
    const overview = frame.overview as { size: string; color: string; line: string };
    assert.ok(near(overview.size, px(26)), overview.size); assert.equal(overview.color, "rgba(255, 255, 255, 0.72)"); assert.equal(overview.line, "35.62px");
    assert.deepEqual(frame.labels, ["VERSION", "AUDIO", "SUBTITLES"]);
    const label = frame.labelStyle as { size: string; weight: string; tracking: string; color: string };
    assert.ok(near(label.size, px(12)), label.size); assert.equal(label.weight, "700"); assert.equal(label.tracking, "1.1px"); assert.equal(label.color, "rgba(255, 255, 255, 0.42)");
    assert.deepEqual(frame.columns, [245, 285, 264]);
    assert.deepEqual((frame.readoutBars as { width: number; height: number }[]).map(bar => [bar.width, bar.height]), [[100, 14], [130, 14], [60, 14]]);
    assert.deepEqual((frame.actions as { width: number; height: number; radius: string; fill: string }[]).map(bar => [bar.width, bar.height, bar.radius, bar.fill]), [[340, 64, "14px", "rgba(255, 255, 255, 0.1)"], [190, 64, "14px", "rgba(255, 255, 255, 0.1)"], [64, 64, "14px", "rgba(255, 255, 255, 0.1)"]]);
    assert.equal(frame.actionGap, "14px");
    assert.deepEqual((frame.cards as { width: number; height: number }[]).map(card => [card.width, card.height]), Array(6).fill([220, 330]), "a movie rail is six 220x330 posters");
    assert.equal(frame.cardGap, "44px");
    assert.equal((frame.rail as { x: number }).x, 100);
    assert.match(String(frame.art), /hero-art-surface/, "the seeded backdrop loads on Apple's surface");
    await tv.remote(10009);
    await tv.page.locator('[data-view="home"]').waitFor();
});

detailTest("an unseeded Details frame shows Apple's placeholder bars and an empty art block", async tv => {
    await patchCard(tv, "movie:m0001", { year: undefined, genres: undefined, runtime: undefined, overview: undefined, backdrop_url: undefined });
    await holdDetail(tv, "movie:m0001");
    await tv.page.locator(MOVIE).first().click();
    const frame = await readLive(tv, skeleton, null, value => value.focus === true, "placeholder skeleton");
    assert.deepEqual((frame.metaBars as { width: number; height: number; radius: string }[]).map(bar => [bar.width, bar.height, bar.radius]), [[390, 22, "6px"]]);
    assert.deepEqual((frame.lines as { width: number; height: number; radius: string }[]).map(bar => [bar.width, bar.height, bar.radius]), [[860, 18, "5px"], [790, 18, "5px"], [610, 18, "5px"]]);
    assert.equal(frame.artFill, "rgba(255, 255, 255, 0.035)", "no seeded backdrop: a white .035 rectangle");
});

detailTest("a Large series route lifts its loading title 32 and shows a landscape rail", async tv => {
    await holdDetail(tv, "series:s1");
    await tv.page.locator(SERIES).first().click();
    const frame = await readLive(tv, skeleton, null, value => value.focus === true, "series skeleton");
    assert.equal(frame.editorial, "84px", "heroTopInset 116 less seriesHeroLift 32");
    assert.deepEqual((frame.cards as { width: number; height: number }[]).map(card => [card.width, card.height]), Array(4).fill([400, 225]));
    assert.equal(frame.cardGap, "34px");
}, "large");

detailTest("titles split on Apple's dash separators only when both halves are non-empty", async tv => {
    for (const [title, primary, secondary] of [["Heat - Director's Cut", "Heat", "Director's Cut"], ["Heat — Redux", "Heat", "Redux"], ["Heat – Redux", "Heat", "Redux"], ["Heat:Redux", "Heat:Redux", null], [" - Heat", " - Heat", null]] as const) {
        await tv.page.unroute("**/api/v2/catalog/items/movie%3Am0001?**");
        await patchDetail(tv, "movie:m0001", { title, logo_url: undefined });
        await tv.page.evaluate(() => window.browseHarness.clearResponseCache());
        await tv.page.locator(MOVIE).first().click();
        const shown = await readLive(tv, () => {
            const node = document.querySelector(".details-editorial .requests-detail-title");
            if (node === null || !node.isConnected || node.querySelector(".requests-title-primary") === null) return null;
            const second = node.querySelector(".requests-title-secondary");
            return { primary: node.querySelector(".requests-title-primary")?.textContent ?? "", secondary: second?.textContent ?? null, color: second === null ? null : getComputedStyle(second).color };
        }, null, value => value.primary !== "", `split of ${title}`);
        assert.deepEqual({ primary: shown.primary, secondary: shown.secondary }, { primary, secondary }, title);
        if (secondary !== null) assert.equal(shown.color, "rgba(255, 255, 255, 0.95)", "TVHeroTitle subtitle is white .95");
        await tv.remote(10009);
        await tv.page.locator('[data-view="home"]').waitFor();
    }
});

detailTest("a Details page without a backdrop keeps the page tint and never crops the poster", async tv => {
    await patchDetail(tv, "movie:m0001", { backdrop_url: undefined, poster_url: "/art/poster.svg" });
    await tv.page.locator(MOVIE).first().click();
    await tv.page.locator('[data-view="item:movie:m0001"] .details-hero').waitFor();
    assert.equal(await tv.page.locator(".details-hero .skyline-art-frame").count(), 0);
    assert.equal(await tv.page.locator('.details-hero img[src*="poster"]').count(), 0);
    assert.match(await tv.page.locator(".details-page-wash").evaluate(node => (node as HTMLElement).style.background), /rgba\(10, 31, 36, 0\.42\)/, "TVDetailPageSurface fallback (0.04, 0.12, 0.14) at .42");
});

detailTest("the backdrop sits on Apple's surface and ThumbHash, fades in, and shows a film mark when it fails", async tv => {
    await patchDetail(tv, "movie:m0001", { backdrop_thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI" });
    await tv.page.route("**/art/last-signal-backdrop.svg**", route => route.abort("failed"));
    await tv.page.locator(MOVIE).first().click();
    const failed = await readLive(tv, () => {
        const frame = document.querySelector<HTMLElement>(".details-hero .skyline-art-frame");
        if (frame === null || frame.dataset.art !== "failed") return null;
        const glyph = frame.querySelector(".hero-art-glyph");
        return { thumbhash: frame.querySelector("canvas.hero-art-thumbhash") !== null, surface: getComputedStyle(frame, "::before").backgroundColor, glyph: glyph === null ? null : { color: getComputedStyle(glyph).color, width: glyph.getBoundingClientRect().width }, image: frame.querySelector("img") !== null };
    }, null, () => true, "failed backdrop");
    assert.deepEqual(failed, { thumbhash: true, surface: "rgb(14, 15, 18)", glyph: { color: "rgba(237, 237, 237, 0.3)", width: 34.796875 }, image: false });
    await tv.remote(10009);
    await tv.page.unroute("**/art/last-signal-backdrop.svg**");
    await tv.page.locator(MOVIE).first().click();
    const loaded = await readLive(tv, () => {
        const image = document.querySelector<HTMLElement>(".details-hero .skyline-art-frame img");
        const frame = image?.parentElement;
        if (image === null || frame === null || frame === undefined || !["loaded", "cached"].includes(frame.dataset.art ?? "")) return null;
        return { opacity: getComputedStyle(image).opacity, transition: frame.dataset.art === "loaded" ? getComputedStyle(image).transitionDuration : "cached" };
    }, null, value => value.opacity === "1", "loaded backdrop");
    assert.ok(loaded.transition === "0.12s" || loaded.transition === "cached", JSON.stringify(loaded));
});

function readout(): { labels: { text: string; size: string; weight: string; tracking: string; color: string }[]; values: { text: string; size: string; weight: string; color: string; width: number; height: number; fill: string }[]; opacity: string } | null {
    const node = document.querySelector<HTMLElement>(".details-editorial .details-playback-summary");
    if (node === null || !node.isConnected) return null;
    return {
        labels: Array.from(node.querySelectorAll("strong")).map(label => { const style = getComputedStyle(label); return { text: label.textContent ?? "", size: style.fontSize, weight: style.fontWeight, tracking: style.letterSpacing, color: style.color }; }),
        values: Array.from(node.querySelectorAll("span")).map(value => { const style = getComputedStyle(value); const rect = value.getBoundingClientRect(); return { text: value.textContent ?? "", size: style.fontSize, weight: style.fontWeight, color: style.color, width: rect.width, height: rect.height, fill: style.backgroundColor }; }),
        opacity: getComputedStyle(node).opacity,
    };
}

detailTest("a movie with no playable file keeps the readout labels over skeleton bars", async tv => {
    await patchDetail(tv, "movie:m0001", { versions: [] });
    await tv.page.locator(MOVIE).first().click();
    await tv.page.locator('[data-view="item:movie:m0001"] .details-hero').waitFor();
    const shown = await readLive(tv, readout, null, value => value.labels.length === 3, "empty readout");
    assert.deepEqual(shown.labels.map(label => label.text), ["VERSION", "AUDIO", "SUBTITLES"]);
    assert.equal(shown.opacity, "1");
    assert.deepEqual(shown.values.map(value => [value.text, value.width, value.height, value.fill]), [["", 128, 18, "rgba(255, 255, 255, 0.14)"], ["", 166, 18, "rgba(255, 255, 255, 0.14)"], ["", 77, 18, "rgba(255, 255, 255, 0.14)"]]);
});

detailTest("readout labels, values, credit and ratings use Apple's type, colour and spacing", async tv => {
    await patchDetail(tv, "movie:m0001", { crew: [{ person_id: "7", name: "River Vale", job: "Director" }, { name: "A Director With A Name Long Enough To Run Past The Editorial Column Width Of The Hero", job: "Director" }] });
    await tv.page.locator(MOVIE).first().click();
    const shown = await readLive(tv, readout, null, value => value.values.every(item => item.text !== ""), "resolved readout");
    for (const label of shown.labels) assert.deepEqual([near(label.size, px(23)), label.weight, label.tracking, label.color], [true, "700", "0.9px", "rgba(255, 255, 255, 0.48)"], label.text);
    for (const value of shown.values) assert.deepEqual([value.weight, value.color], ["500", "rgba(255, 255, 255, 0.82)"], value.text);
    const credit = await readLive(tv, () => {
        const node = document.querySelector(".details-editorial .details-director");
        if (node === null || !node.isConnected) return null;
        const style = getComputedStyle(node);
        return { size: style.fontSize, weight: style.fontWeight, color: style.color, wrap: style.whiteSpace, height: node.getBoundingClientRect().height, overflow: style.textOverflow };
    }, null, value => value.size !== "", "credit line");
    assert.ok(near(credit.size, px(23)), `credit ${credit.size}`);
    assert.deepEqual({ ...credit, size: undefined }, { size: undefined, weight: "400", color: "rgba(255, 255, 255, 0.7)", wrap: "nowrap", height: 28, overflow: "ellipsis" }, "heroCredit is one line at white .70");
    const rating = await readLive(tv, () => {
        const node = document.querySelector(".details-editorial .details-external-rating");
        if (node === null || !node.isConnected) return null;
        const mark = node.querySelector("span:not(.details-rating-score)");
        const before = getComputedStyle(node, "::before");
        return { color: getComputedStyle(node).color, markOpacity: mark === null ? null : getComputedStyle(mark).opacity, dividerAfter: parseFloat(before.marginRight) + parseFloat(getComputedStyle(node).columnGap) };
    }, null, value => value.color !== "", "rating entry");
    assert.deepEqual(rating, { color: "rgb(255, 255, 255)", markOpacity: "0.72", dividerAfter: 14 }, "RatingEntryView draws white with its mark at .72, 14 after the divider");
});

detailTest("a long readout value shrinks toward 0.75 instead of cutting off", async tv => {
    const catalog = tv.fake.catalog; assert.ok(catalog instanceof FakeDetails);
    const file = catalog.audioFiles.get("42"); assert.ok(file !== undefined);
    catalog.audioFiles.set("42", { ...file, audio: file.audio.map((track, index) => index === 0 ? { ...track, codec: "eac3-joc", layout: "7.1.4 Atmos height" } : track) });
    await tv.page.locator(MOVIE).first().click();
    const audio = await readLive(tv, () => {
        const value = document.querySelector<HTMLElement>('.details-editorial [data-track-summary="audio"] span');
        if (value === null || value.textContent === "" || value.style.fontSize === "") return null;
        return { text: value.textContent, size: parseFloat(getComputedStyle(value).fontSize), tracking: getComputedStyle(value).letterSpacing };
    }, null, () => true, "shrunk audio value");
    assert.ok(audio.size < 23 * CAP && audio.size >= 23 * CAP * 0.75 - 0.01, JSON.stringify(audio));
    assert.equal(audio.tracking, "-0.5px", "allowsTightening runs first");
});

detailTest("ratings that do not fit drop whole from the end of the server's list", async tv => {
    // TMDB draws a logo that has no width until it loads, so the row is fitted again on its load.
    const ratings = [{ source: "tmdb", name: "TMDB", score: 75, display: "7.5" }, ...Array.from({ length: 14 }, (_, index) => ({ source: `source${index}`, name: `Source ${index}`, score: 80, display: `${index}.0` }))];
    await patchDetail(tv, "movie:m0001", { ratings });
    await tv.page.locator(MOVIE).first().click();
    const row = await readLive(tv, () => {
        const meta = document.querySelector<HTMLElement>(".details-editorial .browse-meta");
        if (meta === null || meta.querySelector(".details-external-rating") === null) return null;
        const right = meta.getBoundingClientRect().right;
        const shown = Array.from(meta.querySelectorAll(".details-external-rating"));
        return { names: shown.map(node => node.getAttribute("aria-label")), inside: shown.every(node => node.getBoundingClientRect().right <= right + 0.5), overflow: meta.scrollWidth > meta.clientWidth + 0.5 };
    }, null, value => !value.overflow, "fitted ratings");
    assert.ok(row.names.length > 0 && row.names.length < ratings.length, JSON.stringify(row));
    assert.deepEqual(row.names, ratings.slice(0, row.names.length).map(rating => `${rating.name} ${rating.display}`), "the first entries stay in server order");
    assert.equal(row.inside, true);
});

detailTest("the logo cross-fades over the text title in 0.2 s on first decode", async tv => {
    await tv.page.evaluate(() => {
        const seen: { animation: string; timing: string; exit: boolean }[] = [];
        (window as unknown as { logoFades: typeof seen }).logoFades = seen;
        new MutationObserver(() => {
            const logo = document.querySelector(".details-editorial .details-logo.details-logo-enter");
            if (logo === null || seen.length > 0 || logo.parentElement === null) return;
            seen.push({ animation: getComputedStyle(logo).animationDuration, timing: getComputedStyle(logo).animationTimingFunction, exit: logo.parentElement.querySelector(".details-title-exit .requests-title-primary") !== null });
        }).observe(document.body, { childList: true, subtree: true });
    });
    await tv.page.locator(MOVIE).first().click();
    await tv.page.locator(".details-editorial .details-logo").waitFor();
    const fade = await tv.page.evaluate(() => (window as unknown as { logoFades: { animation: string; timing: string; exit: boolean }[] }).logoFades[0]);
    assert.deepEqual(fade, { animation: "0.2s", timing: "ease-in-out", exit: true });
    await tv.jump(250);
    assert.equal(await tv.page.locator(".details-title-exit").count(), 0, "the text leaves once the fade ends");
});

detailTest("the series season count leaves out a season numbered 0", async tv => {
    await patchJson<{ items: Record<string, unknown>[] }>(tv, "**/api/v2/catalog/series/series%3As1/seasons?**", body => ({ ...body, items: [{ ...body.items[0], content_id: "series:s1-S0", season_number: 0, is_specials: false, title: "Season 0" }, ...body.items] }));
    await tv.page.locator(SERIES).first().click();
    const facts = await readLive(tv, () => {
        const values = Array.from(document.querySelectorAll(".details-editorial .details-fact")).map(node => node.textContent ?? "");
        return values.some(value => /Season/.test(value)) ? values : null;
    }, null, () => true, "season count");
    const count = await tv.page.evaluate(() => document.querySelectorAll('.details-season-chips [data-focus^="season:"]').length);
    assert.ok(facts.includes(`${count - 1} Season${count - 1 === 1 ? "" : "s"}`), JSON.stringify({ facts, count }));
});

for (const media of ["movie:m0001", "series:s1"] as const) detailTest(`returning to the ${media.split(":")[0]} hero scrolls on Apple's curve`, async tv => {
    // TVDetailFocusScroll: easeInOut 0.45 s. TVSeriesDetailView animatePage: 0.55 s on (0.4, 0) (0.2, 1).
    const [duration, half] = media === "movie:m0001" ? [450, 0.5] : [550, 0.77556];
    const scrollTop = (): Promise<number> => tv.page.evaluate(() => document.querySelector<HTMLElement>(".browse")?.scrollTop ?? 0);
    await tv.page.locator(`[data-section="recently_added"] [data-focus="${media}"]`).first().click();
    await tv.page.locator('[data-focus="more"]').waitFor();
    await tv.page.locator('[data-focus^="credit:"]').first().waitFor();
    await tv.eventually(async () => {
        if ((await tv.focused() ?? "").startsWith("credit:")) return true;
        await tv.remote(40);
        await tv.jump(300);
        return false;
    }, "a cast card takes focus");
    await tv.jump(1000);
    await tv.eventually(async () => await scrollTop() > 100, "the cast row scrolled the page");
    // A paused clock makes the sample below land exactly half-way through the move.
    await pauseTvClock(tv);
    const from = await scrollTop();
    while (!(await tv.page.evaluate(() => document.activeElement?.closest(".details-editorial") !== null))) await tv.remote(38);
    await tv.jump(duration / 2);
    const middle = await scrollTop();
    assert.ok(Math.abs(middle - from * (1 - half)) <= from * 0.05, JSON.stringify({ from, middle, expected: from * (1 - half) }));
    await tv.jump(duration);
    assert.equal(await scrollTop(), 0);
});

detailTest("a focused episode shows only its own detail's ratings, never the list's copy", async tv => {
    await patchJson<{ items: Record<string, unknown>[] }>(tv, "**/api/v2/catalog/series/series%3As1/seasons/1/episodes?**", body => ({ ...body, items: body.items.map(item => ({ ...item, ratings: [{ source: "imdb", name: "IMDb", score: 90, display: "9.0" }] })) }));
    // The episode's own detail never answers, neighbour prefetch included.
    await tv.page.route("**/api/v2/catalog/items/episode%3As1e12?**", () => undefined);
    await tv.page.locator(SERIES).first().click();
    const card = tv.page.locator('[data-focus="episode:s1e12"]');
    await card.waitFor();
    await card.focus();
    await tv.jump(600);
    await readLive(tv, () => Array.from(document.querySelectorAll(".details-editorial .details-source")).map(node => node.textContent).join(" "), null, value => /Episode \d/.test(value), "episode facts");
    assert.equal(await tv.page.locator(".details-editorial .details-external-rating").count(), 0, "TVSeriesDetailView heroRatings: none until the episode's detail arrives");
});
