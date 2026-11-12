import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { launchBrowser } from "./support/tv.ts";

const font = readFileSync(new URL("../../app/fonts/InterVariable.woff2", import.meta.url)).toString("base64");
const theme = readFileSync(new URL("../../src/theme.css", import.meta.url), "utf8");
const browse = readFileSync(new URL("../../src/ui/browse.css", import.meta.url), "utf8");

/** Inter 500 at Apple's 24pt times --silo-sf-cap-scale. The sweep named "The Dog Stars"; the other five are the same face. */
const CAPTION_SIZE = `${Math.round(24 * 0.9685 * 1e4) / 1e4}px`;
const TITLES = ["The Dog Stars", "Horrible Bosses 2", "The Last Signal", "Harbor Lights", "Archived Feature", "Atlas of Rivers"];

test("one tracking token brings Inter titles to Apple's width", async () => {
    const browser = await launchBrowser();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await page.setContent(`<!doctype html>
<style>@font-face { font-family: Inter; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 100 900; }</style>
<main class="browse skyline-home">
  <section class="home-section"><div class="browse-row">
    ${TITLES.map((text, index) => `<button class="browse-card" style="width:480px"><span class="browse-card-title" id="t${index}">${text}</span></button>`).join("")}
  </div></section>
  <div class="calendar-shelf"><div class="browse-row"><button class="browse-card calendar-event"><div class="browse-art"></div><span class="browse-card-title">My Kitchen Rules</span></button></div></div>
  <h2 class="settings-section-header">Playback</h2>
</main>`);
        await page.addStyleTag({ content: `${theme}\n${browse}` });
        await page.evaluate(() => document.fonts.ready);
        const measured = await page.evaluate(() => {
            const ink = (node: Element) => {
                const range = document.createRange();
                range.selectNodeContents(node);
                const box = range.getBoundingClientRect();
                const style = getComputedStyle(node);
                return {
                    text: node.textContent,
                    width: box.width,
                    spacing: style.letterSpacing,
                    size: style.fontSize,
                    weight: style.fontWeight,
                    lines: range.getClientRects().length,
                };
            };
            const kitchen = document.querySelector(".calendar-event .browse-card-title");
            const header = document.querySelector(".settings-section-header");
            if (kitchen === null || kitchen.parentElement === null || header === null) {
                throw new Error("missing calendar title");
            }
            return {
                titles: [...document.querySelectorAll(".home-section .browse-card-title")].map(ink),
                kitchen: { ...ink(kitchen), card: kitchen.parentElement.getBoundingClientRect().width },
                header: getComputedStyle(header).letterSpacing,
            };
        });
        const dog = measured.titles[0];
        assert.ok(dog !== undefined);
        assert.equal(dog.text, "The Dog Stars");
        assert.equal(dog.size, CAPTION_SIZE);
        assert.equal(dog.weight, "500");
        assert.equal(Number.parseFloat(dog.spacing) || 0, 0, dog.spacing);
        // Apple measured 152px. Untracked Inter at 24px is 157.3px; at the cap-scaled size it lands just above 152.
        assert.ok(dog.width > 151.5 && dog.width < 153.5, String(dog.width));
        for (const title of measured.titles) {
            assert.equal(title.size, CAPTION_SIZE);
            assert.equal(title.weight, "500");
            assert.equal(Number.parseFloat(title.spacing) || 0, 0, `${title.text} ${title.spacing}`);
        }
        assert.equal(measured.kitchen.text, "My Kitchen Rules");
        assert.equal(measured.kitchen.size, "28px");
        assert.equal(measured.kitchen.weight, "600");
        assert.equal(measured.kitchen.lines, 1);
        assert.ok(measured.kitchen.width <= measured.kitchen.card, `${measured.kitchen.width} > ${measured.kitchen.card}`);
        assert.equal(measured.header, "1.2px");
    } finally {
        await browser.close();
    }
});

test("a compact home title shows The Dog Stars and still truncates a longer line", async () => {
    const browser = await launchBrowser();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await page.setContent(`<!doctype html>
<style>@font-face { font-family: Inter; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 100 900; }</style>
<main class="browse skyline-home" style="--poster-scale:0.86">
  <section class="home-section"><div class="browse-row">
    <button class="browse-card"><div class="browse-art"></div><span class="browse-card-title">The Dog Stars</span><span class="browse-card-subtitle">2026</span></button>
    <button class="browse-card"><div class="browse-art"></div><span class="browse-card-title">Killers of the Flower Moon</span></button>
  </div></section>
</main>`);
        await page.addStyleTag({ content: `${theme}\n${browse}` });
        await page.evaluate(() => document.fonts.ready);
        const measured = await page.evaluate(() => {
            const read = (title: Element) => {
                const range = document.createRange();
                range.selectNodeContents(title);
                const ink = range.getBoundingClientRect();
                const box = title.getBoundingClientRect();
                const card = title.parentElement?.getBoundingClientRect();
                const style = getComputedStyle(title);
                return {
                    text: title.textContent,
                    card: card?.width ?? 0,
                    client: (title as HTMLElement).clientWidth,
                    scroll: (title as HTMLElement).scrollWidth,
                    ink: ink.width,
                    inkRight: ink.right,
                    boxRight: box.right,
                    overflow: style.overflow,
                    ellipsis: style.textOverflow,
                    size: style.fontSize,
                    weight: style.fontWeight,
                    spacing: style.letterSpacing,
                };
            };
            const titles = [...document.querySelectorAll(".home-section .browse-card-title")];
            const dog = titles[0];
            const long = titles[1];
            if (dog === undefined || long === undefined) throw new Error("missing titles");
            return { dog: read(dog), long: read(long) };
        });
        // Home dense artwork is SiloTheme.Skyline.densePosterCardWidth 176 times the compact poster scale 0.86.
        assert.ok(Math.abs(measured.dog.card - 176 * 0.86) < 0.05, String(measured.dog.card));
        assert.equal(measured.dog.size, CAPTION_SIZE);
        assert.equal(measured.dog.weight, "500");
        assert.equal(Number.parseFloat(measured.dog.spacing) || 0, 0, measured.dog.spacing);
        assert.ok(measured.dog.ink > 151.5 && measured.dog.ink < 153.5, String(measured.dog.ink));
        assert.ok(measured.dog.scroll <= measured.dog.client, JSON.stringify(measured.dog));
        assert.ok(measured.dog.inkRight <= measured.dog.boxRight + 0.5, JSON.stringify(measured.dog));
        assert.equal(measured.long.ellipsis, "ellipsis");
        assert.ok(measured.long.scroll > measured.long.client, JSON.stringify(measured.long));
    } finally {
        await browser.close();
    }
});

test("Home hero text matches the Apple TV capture's size, spacing and measure", async () => {
    const browser = await launchBrowser();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await page.setContent(`<!doctype html>
<style>@font-face { font-family: Inter; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 100 900; }</style>
<main class="browse skyline-home"><div class="skyline-marquee"><div class="skyline-marquee-layer">
  <div class="skyline-meta-line"><span class="skyline-chip">TV-Y</span><span class="skyline-meta"><span class="skyline-meta-lead">S1 E25 · Going Green · 11m</span><span class="skyline-meta-dot"> · </span><span class="skyline-meta-trailing">22m left</span></span></div>
  <p class="skyline-synopsis">Team Spidey must stop Green Goblin from spewing his green gas all over the park in order to make it safe for the trees again.</p>
  <div class="skyline-detail-line"><span class="skyline-detail-text">Aired 3 Dec 2021 · Nick Fisher, Benjamin Valic, Audrey Bennett</span></div>
  <div class="skyline-badges"><span class="skyline-chip">1080p</span><span class="skyline-chip">EAC3 5.1</span></div>
</div></div></main>`);
        await page.addStyleTag({ content: `${theme}\n${browse}` });
        await page.evaluate(() => document.fonts.ready);
        const measured = await page.evaluate(() => {
            const one = (selector: string): Element => {
                const node = document.querySelector(selector);
                if (node === null) throw new Error(selector);
                return node;
            };
            const type = (selector: string) => {
                const style = getComputedStyle(one(selector));
                return { size: Number.parseFloat(style.fontSize), weight: style.fontWeight, lineHeight: style.lineHeight, spacing: style.letterSpacing === "normal" ? 0 : Number.parseFloat(style.letterSpacing) };
            };
            const width = (selector: string) => {
                const range = document.createRange();
                range.selectNodeContents(one(selector));
                return range.getBoundingClientRect().width;
            };
            const synopsis = one(".skyline-synopsis");
            const text = synopsis.firstChild;
            if (text === null) throw new Error("synopsis text");
            const content = text.textContent ?? "";
            const park = document.createRange();
            park.setStart(text, content.indexOf("park"));
            park.setEnd(text, content.indexOf("park") + 4);
            const lines = document.createRange();
            lines.selectNodeContents(synopsis);
            const lineTops = [...new Set([...lines.getClientRects()].map(rect => Math.round(rect.top)))];
            const chips = [...document.querySelectorAll(".skyline-chip")].map(chip => [(chip as HTMLElement).offsetWidth, (chip as HTMLElement).offsetHeight]);
            return {
                meta: { ...type(".skyline-meta-lead"), width: width(".skyline-meta") },
                synopsis: { ...type(".skyline-synopsis"), lineTops, parkTop: Math.round(park.getBoundingClientRect().top) },
                detail: { ...type(".skyline-detail-text"), width: width(".skyline-detail-text") },
                chip: type(".skyline-chip"),
                chips,
            };
        });
        const near = (actual: number, expected: number, tolerance: number, label: string) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);
        // Apple's points (TVFocusMarquee, SiloTheme.Skyline) times SF Pro's cap height over Inter's, 0.7046 / 0.7275.
        near(measured.meta.size, 20 * 0.9685, 0.01, "meta size");
        assert.equal(measured.meta.weight, "500");
        near(measured.meta.spacing, 0, 0.001, "meta tracking");
        near(measured.synopsis.size, 22 * 0.9685, 0.01, "synopsis size");
        assert.equal(measured.synopsis.weight, "400");
        assert.equal(measured.synopsis.lineHeight, "33px");
        near(measured.synopsis.spacing, -0.35, 0.001, "synopsis tracking");
        near(measured.detail.size, 20 * 0.9685, 0.01, "detail size");
        assert.equal(measured.detail.weight, "500");
        assert.equal(measured.detail.lineHeight, "27px");
        near(measured.detail.spacing, -0.1, 0.001, "detail tracking");
        near(measured.chip.size, 15 * 0.9685, 0.01, "chip size");
        assert.equal(measured.chip.weight, "600");
        assert.equal(measured.chip.lineHeight, "18px");
        near(measured.chip.spacing, 1.65, 0.001, "chip tracking");
        // The Apple capture's measure: "park" ends line one, then a 33px pitch to line two.
        assert.equal(measured.synopsis.lineTops.length, 2, JSON.stringify(measured.synopsis));
        assert.equal(measured.synopsis.parkTop, measured.synopsis.lineTops[0], "park stays on line one");
        assert.equal((measured.synopsis.lineTops[1] ?? 0) - (measured.synopsis.lineTops[0] ?? 0), 33);
        // Apple's ink runs 326px for the meta text and 556px for the detail line.
        near(measured.meta.width, 326, 2, "meta width");
        near(measured.detail.width, 556, 2, "detail width");
        // Apple's chip boxes: TV-Y 60x28, 1080p 72x28, EAC3 5.1 93x28.
        assert.deepEqual(measured.chips.map(([, height]) => height), [28, 28, 28]);
        measured.chips.forEach(([chipWidth], index) => near(chipWidth ?? 0, [60, 72, 93][index] ?? 0, 2, `chip ${index} width`));
    } finally {
        await browser.close();
    }
});

test("Home row heading matches the Apple TV capture's size, tracking and icon spacing", async () => {
    const browser = await launchBrowser();
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await page.setContent(`<!doctype html>
<style>@font-face { font-family: Inter; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 100 900; }</style>
<main class="browse skyline-home"><section class="browse-section home-section"><h2 class="browse-section-title"><span class="home-row-glyph" aria-hidden="true"></span>Continue Watching</h2></section></main>`);
        await page.addStyleTag({ content: `${theme}\n${browse}` });
        await page.evaluate(() => document.fonts.ready);
        const measured = await page.evaluate(() => {
            const title = document.querySelector(".home-section .browse-section-title");
            const glyph = title?.querySelector(".home-row-glyph");
            const text = title?.lastChild;
            if (title === null || title === undefined || glyph === null || glyph === undefined || text === null || text === undefined) throw new Error("missing heading");
            const style = getComputedStyle(title);
            const play = getComputedStyle(glyph, "::after");
            const box = title.getBoundingClientRect();
            const icon = glyph.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(text);
            const words = range.getBoundingClientRect();
            return {
                size: Number.parseFloat(style.fontSize),
                weight: style.fontWeight,
                lineHeight: style.lineHeight,
                spacing: Number.parseFloat(style.letterSpacing),
                height: box.height,
                icon: { left: icon.left - box.left, top: icon.top - box.top, width: icon.width, height: icon.height },
                play: { top: play.top, left: play.left, width: [play.borderTopWidth, play.borderRightWidth, play.borderBottomWidth, play.borderLeftWidth] },
                text: { left: words.left - box.left, width: words.width },
            };
        });
        const near = (actual: number, expected: number, tolerance: number, label: string) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);
        // Apple MediaRow: siloHeadline 36pt semibold times SF Pro's cap height over Inter's.
        near(measured.size, 36 * 0.9685, 0.01, "heading size");
        assert.equal(measured.weight, "600");
        assert.equal(measured.lineHeight, "43.2px");
        near(measured.spacing, 0.35, 0.001, "heading tracking");
        // The line box keeps its 43.2px height, so the cards below stay put.
        near(measured.height, 43.2, 0.1, "heading height");
        // play.circle.fill at 32pt: a 33px circle whose ink starts 3px into the header, as in the capture (x83 from x80).
        assert.deepEqual(measured.icon, { left: 3, top: 5, width: 33, height: 33 });
        assert.deepEqual(measured.play, { top: "10px", left: "11px", width: ["7px", "0px", "7px", "12px"] });
        // The capture's ink runs x134-439. The text box adds Inter's side bearings and the trailing tracking to that 306px of ink.
        near(measured.text.left, 53, 0.5, "text left");
        near(measured.text.width, 309, 1, "text width");
    } finally {
        await browser.close();
    }
});
