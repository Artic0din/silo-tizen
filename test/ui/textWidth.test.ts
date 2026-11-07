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
