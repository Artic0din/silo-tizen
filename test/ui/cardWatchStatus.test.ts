// The poster's watch-status corner against silo-apple 5780c84 Overlays/CardWatchStatus.swift.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import type { Browser } from "playwright";
import { launchBrowser } from "./support/tv.ts";

const theme = readFileSync(new URL("../../src/theme.css", import.meta.url), "utf8").replace(/@font-face\s*\{[^}]*\}/, "");
const browse = readFileSync(new URL("../../src/ui/browse.css", import.meta.url), "utf8");
const CAP_SCALE = 0.9685;

let browser: Browser;
let bundle: string;
before(async () => {
    browser = await launchBrowser();
    const built = await build({
        stdin: { contents: `import { watchStatus } from "./src/ui/cardOverlays.ts"; Object.assign(window, { watchStatus });`, resolveDir: new URL("../..", import.meta.url).pathname, loader: "ts" },
        bundle: true, write: false, format: "iife", platform: "browser",
    });
    bundle = built.outputFiles[0]?.text ?? "";
});
after(async () => { await browser.close(); });

interface Box { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }
interface Mark {
    readonly box: Box; readonly text: string; readonly style: Record<string, string>;
    readonly check?: { readonly box: Box; readonly points: string; readonly stroke: string; readonly strokeWidth: string; readonly cap: string; readonly join: string };
}

async function render(card: Record<string, unknown>, width: number): Promise<Mark | undefined> {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    try {
        await page.setContent(`<!doctype html><main><div class="browse-art" id="art" style="position:absolute;left:0;top:0;width:${width}px;height:${width * 1.5}px"></div></main>`);
        await page.addStyleTag({ content: `${theme}\n${browse}\nbody { margin: 0; }` });
        await page.addScriptTag({ content: bundle });
        return await page.evaluate(({ card, width }) => {
            const api = window as unknown as { watchStatus: (card: unknown, width: number) => HTMLElement | undefined };
            const node = api.watchStatus({ id: "series:1", type: "series", title: "Show", ...card }, width);
            if (node === undefined) return undefined;
            document.getElementById("art")?.append(node);
            const rect = (el: Element): Box => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
            const style = getComputedStyle(node);
            const props = ["backgroundColor", "boxShadow", "filter", "fontSize", "fontWeight", "fontVariantNumeric", "color", "paddingLeft", "paddingRight", "borderTopLeftRadius"] as const;
            const svg = node.querySelector("svg");
            const line = svg?.querySelector("polyline");
            const visible = [...node.childNodes].filter(child => !(child instanceof HTMLElement && child.classList.contains("silo-sr-only")));
            return {
                box: rect(node), text: visible.map(child => child.textContent ?? "").join(""), style: Object.fromEntries(props.map(prop => [prop, style[prop]])),
                ...(svg === null || line === null || line === undefined ? {} : { check: { box: rect(svg), points: line.getAttribute("points") ?? "", stroke: getComputedStyle(line).stroke, strokeWidth: getComputedStyle(line).strokeWidth, cap: getComputedStyle(line).strokeLinecap, join: getComputedStyle(line).strokeLinejoin } }),
            };
        }, { card, width });
    } finally { await page.close(); }
}

const near = (actual: number | undefined, expected: number, message: string, tolerance = 0.05): void => assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `${message}: ${actual} for ${expected}`);

test("a watched poster draws Apple's 22pt emerald disc with a white check in the top-right corner", async () => {
    const width = 260, scale = width / 185, size = 22 * scale;
    const mark = await render({ played: true }, width);
    assert.ok(mark !== undefined);
    near(mark.box.right, width - 8 * scale, "CardOverlays.edgeInset from the right (CardWatchStatus.swift:58-59)");
    near(mark.box.top, 8 * scale, "and from the top");
    near(mark.box.right - mark.box.left, size, "CardWatchStatus.size scaled from the 185pt poster (:14, :29-30)");
    near(mark.box.bottom - mark.box.top, size, "a circle");
    assert.equal(mark.style.backgroundColor, "rgb(0, 188, 125)", "emerald-500 as Apple writes it (:17)");
    assert.equal(mark.style.boxShadow, "rgba(255, 255, 255, 0.35) 0px 0px 0px 1px inset", "a 1pt white ring at 35% (:41)");
    assert.equal(mark.style.filter, "drop-shadow(rgba(0, 0, 0, 0.15) 0px 1px 3px)", "shadow radius 1.5 is a 3px CSS blur (:57)");
    assert.ok(mark.check !== undefined);
    near(mark.check.box.right - mark.check.box.left, size * 0.62, "the check's box (:38)");
    near((mark.check.box.left + mark.check.box.right) / 2, (mark.box.left + mark.box.right) / 2, "centred");
    assert.equal(mark.check.points, "20 6 9 17 4 12", "Lucide's check (:70-81)");
    assert.equal(mark.check.stroke, "rgb(255, 255, 255)");
    assert.equal(mark.check.strokeWidth, "3.25px", "3.25 units of the 24-unit box (:36)");
    assert.equal(mark.check.cap, "round");
    assert.equal(mark.check.join, "round");
    assert.equal(mark.text, "", "the check draws no text");
});

test("a started series shows its episodes left in a dark capsule; an untouched one shows nothing", async () => {
    const width = 185, size = 22;
    const mark = await render({ played: false, episodesLeft: 6 }, width);
    assert.ok(mark !== undefined);
    assert.equal(mark.text, "6");
    near(mark.box.bottom - mark.box.top, size, "the capsule's height (:52)");
    near(mark.box.right - mark.box.left, size, "a one-digit count keeps the minimum width (:51)");
    near(mark.box.right, width - 8, "top-right inset");
    assert.equal(mark.style.backgroundColor, "rgba(0, 0, 0, 0.65)", ":53");
    assert.equal(mark.style.boxShadow, "rgba(255, 255, 255, 0.2) 0px 0px 0px 1px inset", ":54");
    near(parseFloat(mark.style.fontSize ?? ""), 11 * CAP_SCALE, "11pt bold at SF's cap height (:43-45)", 0.01);
    assert.equal(mark.style.fontWeight, "700");
    assert.equal(mark.style.fontVariantNumeric, "tabular-nums", "monospacedDigit (:46)");
    assert.equal(mark.style.color, "rgb(255, 255, 255)");
    near(parseFloat(mark.style.paddingLeft ?? ""), 11 * 0.4, "padding of 0.4 of the font size (:50)", 0.01);
    const wide = await render({ played: false, episodesLeft: 128 }, width);
    assert.ok(wide !== undefined && wide.box.right - wide.box.left > size, "a longer count grows the capsule");
    near(wide.box.right, width - 8, "and keeps the right inset");
    assert.equal((await render({ played: false, episodesLeft: 1200 }, width))?.text, "1,200", "LocaleFormat.integer groups the count (:44)");
    assert.equal(await render({ played: false }, width), undefined, "nothing on an untouched title (:3-5)");
    assert.equal((await render({ played: true, episodesLeft: 3 }, width))?.text, "", "a watched title shows the check, not a count (:21, :32)");
});
