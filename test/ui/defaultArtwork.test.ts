// Missing and failed artwork on cards, against silo-apple DefaultArtwork.swift (tvOS values).
// Desktop Chromium is not the TV's Chromium 108: this proves structure and computed style, not TV rendering.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { launchBrowser, openTv, homeDetailsRead, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

/** `before` runs ahead of Home mounting: an image Home already decoded is served from Chromium's cache, past any route. */
function artTest(name: string, body: (tv: Tv, catalog: FakeCatalog) => Promise<void>, before: (tv: Tv, catalog: FakeCatalog) => Promise<void> = async () => undefined): void {
    test(name, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            const catalog = new FakeCatalog();
            tv.fake.catalog = catalog;
            await before(tv, catalog);
            await tv.page.evaluate(() => window.browseHarness.connect());
            await tv.eventually(async () => tv.fake.devices.size > 0, "a device code");
            tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
            await tv.jump(5000);
            await tv.eventually(async () => (await tv.page.evaluate(() => window.browseHarness.loginPhase)) === "signed_in", "sign-in");
            await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner", undefined));
            await tv.page.evaluate(() => window.browseHarness.mount());
            await tv.page.locator('[data-view="home"]').waitFor();
            await homeDetailsRead(tv);
            await body(tv, catalog);
        } finally {
            await tv.page.context().close();
        }
    });
}

async function openLibrary(tv: Tv, nav: "movies" | "series", id: string): Promise<void> {
    await tv.page.locator(`[data-focus="${nav}"]`).click();
    await tv.page.locator(`[data-view="${id}"]`).waitFor();
}

interface Measured {
    readonly symbol: string | null;
    readonly text: string;
    readonly ariaHidden: string | null;
    readonly base: string;
    readonly glows: string;
    readonly markColor: string;
    readonly markOpacity: string;
    readonly markWidth: number;
    readonly markHeight: number;
    readonly markCentre: { readonly x: number; readonly y: number };
    readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    readonly boxFill: string;
}

function measure(page: Page, selector: string): Promise<Measured> {
    return page.locator(`${selector} .default-artwork`).evaluate((node): Measured => {
        const parent = node.parentElement!;
        const area = parent.getBoundingClientRect();
        // A focused card is scaled; the glow and mark are sized from the layout box.
        const scale = area.width / parent.offsetWidth;
        const mark = node.querySelector(".default-artwork-mark")!.getBoundingClientRect();
        const glow = node.querySelector(".default-artwork-glow")!;
        return {
            symbol: node.getAttribute("data-symbol"),
            text: node.textContent ?? "",
            ariaHidden: node.getAttribute("aria-hidden"),
            base: getComputedStyle(node).backgroundColor,
            glows: getComputedStyle(glow).backgroundImage,
            markColor: getComputedStyle(node.querySelector(".default-artwork-mark")!).color,
            markOpacity: getComputedStyle(node.querySelector(".default-artwork-mark")!).opacity,
            markWidth: mark.width / scale,
            markHeight: mark.height / scale,
            markCentre: { x: (mark.x + mark.width / 2 - area.x) / scale, y: (mark.y + mark.height / 2 - area.y) / scale },
            box: { x: area.x, y: area.y, width: parent.offsetWidth, height: parent.offsetHeight },
            boxFill: getComputedStyle(parent).backgroundColor,
        };
    });
}

/** `markWidth(for:)`: 24% of the box width, held to tvOS's 14...64 range. */
function expectedMarkWidth(boxWidth: number): number {
    return Math.min(Math.max(boxWidth * 0.24, 14), 64);
}

function assertAppleDefaultArtwork(found: Measured, symbol: string, ratio: number): void {
    assert.equal(found.symbol, symbol);
    assert.equal(found.text, "", "DefaultArtwork draws no title text");
    assert.equal(found.ariaHidden, "true");
    assert.equal(found.base, "rgb(22, 23, 28)", "#16171C base");
    // Chrome keeps colour alpha in 8 bits, so SwiftUI's .176/.144/.112 resolve to the nearest 1/255.
    const layers = [...found.glows.matchAll(/radial-gradient\(([\d.]+)px at ([^,]+), rgba\((\d+), (\d+), (\d+), ([\d.]+)\), rgba\(\d+, \d+, \d+, 0\)\)/g)]
        .map(layer => ({ radius: Number(layer[1]), at: layer[2], rgb: `${layer[3]},${layer[4]},${layer[5]}`, alpha: Number(layer[6]) }));
    const side = Math.max(found.box.width, found.box.height);
    // SwiftUI paints blue, then orange, then red on top; CSS lists the top layer first.
    const expected = [
        { radius: side * 0.5, at: "70% 30%", rgb: "245,11,79", alpha: 0.112 },
        { radius: side * 0.6, at: "100% 100%", rgb: "253,116,3", alpha: 0.144 },
        { radius: side * 0.75, at: "0px 0px", rgb: "0,52,251", alpha: 0.176 },
    ];
    assert.equal(layers.length, 3, found.glows);
    for (const [index, want] of expected.entries()) {
        const got = layers[index];
        assert.ok(got !== undefined && got.at === want.at && got.rgb === want.rgb, `${index}: ${JSON.stringify(got)}`);
        assert.ok(Math.abs(got.radius - want.radius) < 0.5, `glow ${index} radius ${got.radius}, wanted ${want.radius} of a ${side}px side`);
        assert.ok(Math.abs(got.alpha - want.alpha) <= 1 / 255, `glow ${index} alpha ${got.alpha}`);
    }
    assert.equal(found.markColor, "rgb(255, 255, 255)");
    assert.equal(found.markOpacity, "0.13");
    assert.ok(Math.abs(found.markWidth - expectedMarkWidth(found.box.width)) < 0.5, `mark width ${found.markWidth} in a ${found.box.width}px box`);
    assert.ok(Math.abs(found.markWidth / found.markHeight - ratio) < 0.02, `mark ratio ${found.markWidth / found.markHeight}`);
    assert.ok(Math.abs(found.markCentre.x - found.box.width / 2) < 0.5 && Math.abs(found.markCentre.y - found.box.height / 2) < 0.5, "mark is centred");
}

artTest("a poster with no artwork URL draws DefaultArtwork's film mark and brand glows, not its title", async tv => {
    await openLibrary(tv, "movies", "library:12");
    const card = '[data-focus="movie:m0002"] .browse-art';
    await tv.page.locator(`${card}.browse-art-missing .default-artwork`).waitFor();
    assert.equal(await tv.page.locator(`${card} img`).count(), 0);
    assert.equal(await tv.page.locator(`${card} .browse-art-fallback`).count(), 0, "no title placeholder");
    assertAppleDefaultArtwork(await measure(tv.page, card), "film", 120 / 89);
});

artTest("a poster whose artwork fails to load draws the same DefaultArtwork", async tv => {
    await openLibrary(tv, "movies", "library:12");
    const card = '[data-focus="movie:m0003"] .browse-art';
    await tv.page.locator(`${card}.browse-art-missing .default-artwork`).waitFor();
    assert.equal(await tv.page.locator(`${card} img`).count(), 0, "the failed image is removed");
    assertAppleDefaultArtwork(await measure(tv.page, card), "film", 120 / 89);
});

let failLoading: () => void = () => undefined;
artTest("while artwork is loading the card shows Apple's #0E0F12 placeholder, and DefaultArtwork only after the load fails", async tv => {
    await openLibrary(tv, "movies", "library:12");
    const art = tv.page.locator('[data-focus="movie:m0004"] .browse-art');
    await art.locator("img").waitFor();
    assert.equal(await art.evaluate(node => node.classList.contains("browse-art-missing")), false);
    assert.equal(await art.locator(".default-artwork").count(), 0, "a pending load is not missing artwork");
    assert.equal(await art.evaluate(node => getComputedStyle(node).backgroundColor), "rgb(14, 15, 18)");
    failLoading();
    await art.locator(".default-artwork").waitFor();
    assert.equal(await art.locator("img").count(), 0);
}, async tv => {
    const gate = new Promise<void>(resolve => { failLoading = resolve; });
    await tv.page.route(/\/art\/movie%3Am0004\.svg/, async route => { await gate; await route.abort(); });
});

artTest("a series poster that fails draws the tv mark", async tv => {
    await openLibrary(tv, "series", "library:13");
    const card = '[data-focus="series:s1"] .browse-art';
    await tv.page.locator(`${card}.browse-art-missing .default-artwork`).waitFor();
    assertAppleDefaultArtwork(await measure(tv.page, card), "tv", 124 / 97);
}, async tv => { await tv.page.route(/\/art\/series%3As1\.svg/, route => route.abort()); });

artTest("a landscape episode thumbnail sizes the glow and mark from its own box", async tv => {
    await openLibrary(tv, "series", "library:13");
    const card = '[data-section="next"] [data-focus="episode:s1e12"] .browse-art';
    await tv.page.locator(`${card}.browse-art-missing .default-artwork`).waitFor();
    const found = await measure(tv.page, card);
    assert.ok(found.box.width > found.box.height, "a thumbnail is landscape");
    assertAppleDefaultArtwork(found, "tv", 124 / 97);
    const progress = tv.page.locator(`${card} .skyline-progress`);
    await progress.waitFor();
    assert.equal(await progress.evaluate(node => { const at = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(at.x + at.width / 2, at.y + at.height / 2)); }), true, "progress stays above the drawn artwork");
}, async (tv, catalog) => {
    const household = catalog.households.get("p-owner");
    assert.ok(household);
    household.librarySections = [{ id: "next", sectionType: "next_up", title: "Next Up", items: ["episode:s1e12"] }];
    const episode = catalog.titles.get("episode:s1e12");
    assert.ok(episode);
    catalog.titles.set(episode.id, { ...episode, duration: 1200 });
    catalog.progress.set(episode.id, 600);
    await tv.page.route(/\/art\/episode%3As1e12\.svg/, route => route.abort());
});
