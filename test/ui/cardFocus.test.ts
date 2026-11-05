import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { launchBrowser } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

test("season episode rows retain dark titles on their white focused background", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent('<main class="browse"><button class="browse-episode"><span class="browse-episode-info"><span class="browse-card-title">1. Episode</span><span class="browse-card-subtitle">45 min</span></span></button></main>');
        await page.addStyleTag({ content: readFileSync(new URL("../../src/theme.css", import.meta.url), "utf8") + readFileSync(new URL("../../src/ui/browse.css", import.meta.url), "utf8") });
        await page.addStyleTag({ content: "* { transition: none !important; }" });
        await page.locator("button").focus();
        assert.equal(await page.locator(".browse-card-title").evaluate(node => getComputedStyle(node).color), "rgb(0, 0, 0)");
        assert.equal(await page.locator(".browse-card-title").evaluate(node => getComputedStyle(node).fontWeight), "600");
    } finally { await page.close(); }
});

const surfaces = [
    ["Home", "skyline-home", "home-section", "", ""],
    ["Continue Watching", "skyline-home", "home-section", "", "skyline-continue"],
    ["Library Recommended", "skyline-library", "library-media-shelf", "browse-row", ""],
    ["Library grid", "library-browse", "", "catalog-grid", ""],
    ["Section and Person filmography", "section-catalog", "", "section-catalog-grid", ""],
    ["Search", "search-scene", "", "browse-grid", ""],
    ["Search requests", "search-scene", "", "search-request-rail", "requests-card"],
    ["Details", "", "", "browse-row", ""],
    ["Calendar", "", "calendar-shelf", "browse-row", "calendar-event"],
    ["Person", "", "", "browse-row", ""],
    ["Requests", "requests-scene", "", "requests-rail", "requests-card"],
] as const;

test("tvOS caption exceptions preserve colours, spacing and cast label lift", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(`<main class="browse">
            <div class="search-scene"><div class="browse-grid"><button class="browse-card"><div class="browse-art"></div><span class="browse-card-title">Search</span></button></div><div class="search-request-rail"><button class="browse-card requests-card"><div class="browse-art"></div><span class="browse-card-title">Request</span><span class="browse-card-subtitle">2026</span></button></div></div>
            <div class="browse-row" data-detail-section="related"><button class="browse-card"><div class="browse-art"></div><span class="browse-card-title">Related</span></button></div>
            <div class="browse-row details-people"><button class="browse-card details-person"><div class="browse-art details-photo"></div><span class="browse-card-title">Person</span><span class="browse-card-subtitle">Role</span></button></div>
            <div class="browse-row"><button class="browse-card calendar-event"><div class="browse-art"></div><span class="browse-card-title">Calendar</span><span class="browse-card-subtitle">Episode</span></button></div>
        </main>`);
        await page.addStyleTag({ content: readFileSync(new URL("../../src/theme.css", import.meta.url), "utf8") + readFileSync(new URL("../../src/ui/browse.css", import.meta.url), "utf8") });
        await page.addStyleTag({ content: "* { transition: none !important; }" });
        for (const [selector, gap] of [[".browse-grid", 16], [".search-request-rail", 22], ['[data-detail-section="related"]', 16]] as const) {
            assert.equal(await page.locator(`${selector} .browse-card-title`).evaluate(node => parseFloat(getComputedStyle(node).marginTop)), gap);
        }
        await page.locator('[data-detail-section="related"] button').focus();
        assert.equal(await page.locator('[data-detail-section="related"] .browse-card-title').evaluate(node => getComputedStyle(node).transform), "matrix(1, 0, 0, 1, 0, 0)");
        for (const selector of [".requests-card", ".calendar-event"]) {
            await page.locator(selector).focus();
            assert.deepEqual(await page.locator(`${selector} .browse-card-title, ${selector} .browse-card-subtitle`).evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color)), ["rgb(237, 237, 237)", "rgba(237, 237, 237, 0.6)"]);
        }
        await page.locator(".calendar-event").blur();
        assert.equal(await page.locator(".calendar-event .browse-card-title").evaluate(node => getComputedStyle(node).color), "rgba(237, 237, 237, 0.85)");
        const cast = page.locator(".details-person");
        const readCast = () => cast.evaluate(node => {
            const rect = node.getBoundingClientRect();
            return { center: rect.y + rect.height / 2, labels: Array.from(node.querySelectorAll<HTMLElement>(".browse-card-title, .browse-card-subtitle"), label => ({ y: label.getBoundingClientRect().y, color: getComputedStyle(label).color, glow: getComputedStyle(label).textShadow })) };
        });
        const rest = await readCast();
        await cast.evaluate(node => (node as HTMLElement).focus({ preventScroll: true }));
        const focused = await readCast();
        assert.deepEqual(focused.labels.map(label => label.color), ["rgb(237, 237, 237)", "rgba(237, 237, 237, 0.6)"]);
        for (const [index, label] of rest.labels.entries()) {
            const focusedLabel = focused.labels[index];
            assert.ok(focusedLabel);
            assert.ok(Math.abs(focusedLabel.y - (rest.center + (label.y - rest.center) * 1.05)) < 0.02, "the entire cast label scales around the button centre");
            assert.equal(focusedLabel.glow, "none");
        }
        await page.emulateMedia({ reducedMotion: "reduce" });
        const reduced = await readCast();
        assert.deepEqual(reduced.labels.map(label => label.y), rest.labels.map(label => label.y));
    } finally { await page.close(); }
});

test("collection collage tiles outline the whole tile and cast portraits keep their lighter shadow", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent('<main class="browse"><div class="browse-row"><button class="browse-card discovery-collection"><span class="discovery-collection-art"></span><span class="discovery-collection-name">Collection</span></button></div><div class="browse-row details-people"><button class="browse-card details-person"><div class="browse-art details-photo"></div><span class="browse-card-title">Person</span></button></div></main>');
        await page.addStyleTag({ content: readFileSync(new URL("../../src/theme.css", import.meta.url), "utf8") + readFileSync(new URL("../../src/ui/browse.css", import.meta.url), "utf8") });
        await page.addStyleTag({ content: "* { transition: none !important; }" });
        const tile = page.locator(".discovery-collection");
        await tile.focus();
        assert.deepEqual(await tile.evaluate(node => { const style = getComputedStyle(node); return [style.transform, style.outline, style.boxShadow]; }), ["matrix(1.05, 0, 0, 1.05, 0, 0)", "rgba(255, 255, 255, 0.7) solid 4px", "rgba(0, 0, 0, 0.45) 0px 8px 36px 0px"]);
        await page.locator(".details-person").focus();
        assert.deepEqual(await page.locator(".details-photo").evaluate(node => { const style = getComputedStyle(node); return [style.transform, style.outline, style.boxShadow]; }), ["none", "rgba(255, 255, 255, 0.7) solid 4px", "rgba(0, 0, 0, 0.35) 0px 6px 28px 0px"]);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await tile.focus();
        assert.equal(await tile.evaluate(node => getComputedStyle(node).transform), "none");
    } finally { await page.close(); }
});

for (const [name, root, section, row, card] of surfaces) {
    test(`${name} shares the outlined card lift, fixed caption weight and reduced motion`, async t => {
        const page = await browser.newPage();
        try {
            await page.setContent(`<main class="browse ${root}"><section class="${section}"><div class="${row}"><button class="browse-card ${card}"><div class="browse-art"></div><span class="browse-card-title">A long title that truncates without reflow</span><span class="browse-card-subtitle">2026</span></button></div></section></main>`);
            await page.addStyleTag({ content: readFileSync(new URL("../../src/theme.css", import.meta.url), "utf8") + readFileSync(new URL("../../src/ui/browse.css", import.meta.url), "utf8") });
            await page.addStyleTag({ content: "* { transition: none !important; }" });
            const read = () => page.locator("button").evaluate(node => {
                const art = node.querySelector<HTMLElement>(".browse-art");
                const title = node.querySelector<HTMLElement>(".browse-card-title");
                const subtitle = node.querySelector<HTMLElement>(".browse-card-subtitle");
                if (!art || !title || !subtitle) throw new Error("missing card");
                const style = getComputedStyle(art);
                return { weight: [getComputedStyle(title).fontWeight, getComputedStyle(subtitle).fontWeight], transform: style.transform, outline: style.outline, shadow: style.boxShadow, drop: getComputedStyle(title).transform, glow: getComputedStyle(title).textShadow, pseudo: getComputedStyle(art, "::after").backgroundImage, height: art.offsetHeight, gap: parseFloat(getComputedStyle(title).marginTop) };
            });
            const rest = await read();
            await page.locator("button").focus();
            const focused = await read();
            await t.test("lift", () => assert.equal(focused.transform, "matrix(1.05, 0, 0, 1.05, 0, 0)"));
            await t.test("outline", () => assert.equal(focused.outline, "rgba(255, 255, 255, 0.7) solid 4px"));
            const posterShadow = "rgba(0, 0, 0, 0.45) 0px 8px 36px 0px";
            // Continue Watching used to share that single poster shadow.
            const continueShadow = `${posterShadow}, rgba(0, 0, 0, 0.5) 0px 10px 40px 0px`;
            await t.test("shadow", () => assert.equal(focused.shadow, card === "skyline-continue" ? continueShadow : posterShadow, card === "skyline-continue" ? `Continue Watching focused shadow; the old value was ${posterShadow}` : "focused poster shadow"));
            await t.test("fixed caption weight", () => assert.deepEqual(focused.weight, rest.weight, "focus never changes truncation weight"));
            const fixedCaption = card === "requests-card" || card === "calendar-event";
            const drop = Math.max(0, focused.height * 0.025 + 8 - focused.gap);
            await t.test("caption drop", () => assert.equal(focused.drop, fixedCaption ? "none" : `matrix(1, 0, 0, 1, 0, ${Number(drop.toFixed(4))})`));
            await t.test("caption glow", () => assert.equal(focused.glow, fixedCaption ? "none" : "rgba(255, 255, 255, 0.22) 0px 0px 8px, rgba(255, 255, 255, 0.12) 0px 0px 3px"));
            await t.test("no sheen", () => assert.equal(focused.pseudo, "none", "no system glass sheen"));
            await page.emulateMedia({ reducedMotion: "reduce" });
            const reduced = await read();
            await t.test("reduced motion", () => {
                assert.equal(reduced.transform, "none");
                assert.equal(reduced.drop, "none");
                assert.equal(reduced.outline, focused.outline);
            });
        } finally { await page.close(); }
    });
}
