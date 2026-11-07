import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import type { Browser } from "playwright";
import { launchBrowser } from "./support/tv.ts";

const theme = readFileSync(new URL("../../src/theme.css", import.meta.url), "utf8");
const browse = readFileSync(new URL("../../src/ui/browse.css", import.meta.url), "utf8");
const accounts = readFileSync(new URL("../../src/ui/accounts.css", import.meta.url), "utf8");
const font = readFileSync(new URL("../../app/fonts/InterVariable.woff2", import.meta.url)).toString("base64");

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

async function styledPage(html: string) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.setContent(`<!doctype html><style>@font-face { font-family: Inter; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 100 900; }</style>${html}`);
    await page.addStyleTag({ content: `${theme}\n${browse}\n${accounts}\n* { transition: none !important; }` });
    await page.evaluate(() => document.fonts.ready);
    return page;
}

test("native scrollbars stay hidden while the app still scrolls", async () => {
    const page = await styledPage(`<main>
        <div class="accounts-rail" style="height:80px"><div style="height:400px;flex:none"></div></div>
        <div class="requests-scene"><div class="requests-rail" style="width:240px"><div style="width:900px;height:40px;flex:none"></div></div></div>
        <div class="personal-history"><div class="skyline-content" style="height:80px"><div style="height:400px"></div></div></div>
        <div class="settings-pane" style="height:80px"><div style="height:400px"></div></div>
    </main>`);
    try {
        const bars = await page.evaluate(() => [".accounts-rail", ".requests-rail", ".personal-history .skyline-content", ".settings-pane"].map(selector => {
            const node = document.querySelector(selector);
            if (!(node instanceof HTMLElement)) return selector;
            return getComputedStyle(node, "::-webkit-scrollbar").display;
        }));
        assert.deepEqual(bars, ["none", "none", "none", "none"]);
        const moved = await page.evaluate(() => {
            const vertical = document.querySelector(".accounts-rail");
            const horizontal = document.querySelector(".requests-rail");
            const history = document.querySelector(".personal-history .skyline-content");
            const settings = document.querySelector(".settings-pane");
            if (!(vertical instanceof HTMLElement) || !(horizontal instanceof HTMLElement) || !(history instanceof HTMLElement) || !(settings instanceof HTMLElement)) return null;
            vertical.scrollTop = 48;
            horizontal.scrollLeft = 64;
            history.scrollTop = 36;
            settings.scrollTop = 28;
            return { vertical: vertical.scrollTop, horizontal: horizontal.scrollLeft, history: history.scrollTop, settings: settings.scrollTop };
        });
        assert.deepEqual(moved, { vertical: 48, horizontal: 64, history: 36, settings: 28 });
    } finally { await page.close(); }
});

test("the returning badge draws an outlined television with a foot and a translucent screen", async () => {
    const bundled = await build({
        stdin: {
            contents: `import { overlayLayer, parseOverlayPrefs } from "./src/ui/cardOverlays.ts";
                const prefs = parseOverlayPrefs({ version: 2, preset: "vibrant", order: ["show_status"], items: { show_status: { enabled: true, position: "top-right", showIcon: true } } });
                const layer = overlayLayer({ id: "series:1", type: "series", title: "Show", year: 2014, posterUrl: undefined, seriesId: undefined, seriesTitle: undefined, seasonNumber: undefined, episodeNumber: undefined, showStatus: "returning series" }, prefs, "poster", 185);
                document.body.append(layer);`,
            resolveDir: new URL("../..", import.meta.url).pathname,
            loader: "ts",
        },
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
    });
    const page = await styledPage("<main></main>");
    try {
        await page.addScriptTag({ content: bundled.outputFiles[0]?.text ?? "" });
        await page.addStyleTag({ content: browse });
        const icon = await page.locator(".card-overlay-icon").evaluate(svg => {
            const paths = [...svg.querySelectorAll("path")].map(path => ({
                opacity: path.getAttribute("fill-opacity"),
                rule: path.getAttribute("fill-rule"),
                box: path.getBBox(),
            }));
            return { viewBox: svg.getAttribute("viewBox"), paths: paths.map(path => ({ ...path, box: { x: path.box.x, y: path.box.y, width: path.box.width, height: path.box.height } })) };
        });
        assert.equal(icon.viewBox, "0 0 73 58");
        const fill = icon.paths.find(path => path.opacity !== null);
        const outline = icon.paths.find(path => path.rule === "evenodd");
        assert.ok(fill !== undefined && outline !== undefined, JSON.stringify(icon.paths));
        assert.ok(Math.abs(Number(fill.opacity) - 63 / 255) < 0.002, fill.opacity ?? "");
        assert.ok(Math.abs(fill.box.x - 11) < 0.6 && Math.abs(fill.box.y - 9.688) < 0.6, JSON.stringify(fill.box));
        assert.ok(Math.abs(fill.box.width - 50.062) < 0.8 && Math.abs(fill.box.height - 30.812) < 0.8, JSON.stringify(fill.box));
        assert.ok(outline.box.y + outline.box.height > 53, JSON.stringify(outline.box));
        assert.ok(outline.box.width > fill.box.width + 4, JSON.stringify(outline.box));
    } finally { await page.close(); }
});

test("a collapsed A-Z letter is a circle and the expanded label stays readable", async () => {
    const page = await styledPage(`<main class="browse"><div class="browse-letters"><button class="browse-button" aria-pressed="true">All</button><button class="browse-button">M</button><button class="browse-button">Z</button></div></main>`);
    try {
        const collapsed = await page.locator('[aria-pressed="true"]').evaluate(node => {
            const style = getComputedStyle(node);
            const range = document.createRange();
            range.selectNodeContents(node);
            return { radius: style.borderRadius, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, fontSize: style.fontSize, ink: range.getBoundingClientRect().width, text: node.textContent };
        });
        assert.equal(collapsed.radius, "50%");
        assert.equal(collapsed.width, 10);
        assert.equal(collapsed.height, 10);
        assert.equal(collapsed.fontSize, "0px");
        assert.equal(collapsed.ink, 0);
        assert.equal(collapsed.text, "All");
        await page.locator(".browse-button").nth(1).focus();
        const expanded = await page.locator(".browse-button").evaluateAll(nodes => nodes.map(node => {
            const style = getComputedStyle(node);
            return { fontSize: style.fontSize, radius: style.borderRadius, color: style.color, text: node.textContent };
        }));
        assert.deepEqual(expanded, [
            { fontSize: "15px", radius: "8px", color: "rgb(0, 0, 0)", text: "All" },
            { fontSize: "15px", radius: "8px", color: "rgb(0, 0, 0)", text: "M" },
            { fontSize: "15px", radius: "8px", color: "rgb(237, 237, 237)", text: "Z" },
        ]);
    } finally { await page.close(); }
});

test("related captions are centred on the poster", async () => {
    const page = await styledPage(`<main class="browse" style="--poster-scale:0.86"><div class="browse-row" data-detail-section="related"><button class="browse-card"><div class="browse-art"></div><span class="browse-card-title">Horrible Bosses 2</span><span class="browse-card-subtitle">2014</span></button></div></main>`);
    try {
        const caption = await page.locator(".browse-card-title").evaluate(node => {
            const style = getComputedStyle(node);
            const art = node.parentElement?.querySelector(".browse-art");
            return {
                align: style.textAlign,
                pad: style.paddingLeft,
                title: node.getBoundingClientRect().width,
                art: art instanceof HTMLElement ? art.getBoundingClientRect().width : 0,
            };
        });
        const subtitle = await page.locator(".browse-card-subtitle").evaluate(node => getComputedStyle(node).textAlign);
        assert.equal(caption.align, "center");
        assert.equal(subtitle, "center");
        assert.equal(caption.pad, "0px");
        assert.ok(Math.abs(caption.title - caption.art) < 0.5, JSON.stringify(caption));
        assert.ok(Math.abs(caption.art - 220 * 0.86) < 0.5, JSON.stringify(caption));
    } finally { await page.close(); }
});
