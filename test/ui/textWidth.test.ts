import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { launchBrowser } from "./support/tv.ts";

const font = readFileSync(new URL("../../app/fonts/InterVariable.woff2", import.meta.url)).toString("base64");
const theme = readFileSync(new URL("../../src/theme.css", import.meta.url), "utf8");
const browse = readFileSync(new URL("../../src/ui/browse.css", import.meta.url), "utf8");

/** Inter 500 at 24px. The sweep named "The Dog Stars"; the other five are the same face. */
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
        assert.equal(dog.size, "24px");
        assert.equal(dog.weight, "500");
        assert.ok(Math.abs(Number.parseFloat(dog.spacing) - -0.36) < 0.02, dog.spacing);
        // Apple measured 152px. Untracked Inter is 157.3px; -0.015em lands just above 152.
        assert.ok(dog.width > 151.5 && dog.width < 153.5, String(dog.width));
        for (const title of measured.titles) {
            assert.equal(title.size, "24px");
            assert.equal(title.weight, "500");
            assert.ok(Math.abs(Number.parseFloat(title.spacing) - -0.36) < 0.02, `${title.text} ${title.spacing}`);
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
        assert.equal(measured.dog.size, "24px");
        assert.equal(measured.dog.weight, "500");
        assert.ok(Math.abs(Number.parseFloat(measured.dog.spacing) - -0.36) < 0.02, measured.dog.spacing);
        assert.ok(measured.dog.ink > 151.5 && measured.dog.ink < 153.5, String(measured.dog.ink));
        assert.ok(measured.dog.scroll <= measured.dog.client, JSON.stringify(measured.dog));
        assert.ok(measured.dog.inkRight <= measured.dog.boxRight + 0.5, JSON.stringify(measured.dog));
        assert.equal(measured.long.ellipsis, "ellipsis");
        assert.ok(measured.long.scroll > measured.long.client, JSON.stringify(measured.long));
    } finally {
        await browser.close();
    }
});
