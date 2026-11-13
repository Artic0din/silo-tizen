// Poster badge layout against silo-apple 5780c84 CardOverlays.swift, OverlayPresets.swift and OverlayIcon.swift.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "./support/tv.ts";

const theme = readFileSync(new URL("../../src/theme.css", import.meta.url), "utf8");
const browse = readFileSync(new URL("../../src/ui/browse.css", import.meta.url), "utf8");
const font = readFileSync(new URL("../../app/fonts/InterVariable.woff2", import.meta.url)).toString("base64");
const CAP_SCALE = 0.9685;

let browser: Browser;
let bundle: string;
before(async () => {
    browser = await launchBrowser();
    const built = await build({
        stdin: { contents: `import { overlayLayer, parseOverlayPrefs } from "./src/ui/cardOverlays.ts"; Object.assign(window, { overlayLayer, parseOverlayPrefs });`, resolveDir: new URL("../..", import.meta.url).pathname, loader: "ts" },
        bundle: true, write: false, format: "iife", platform: "browser",
    });
    bundle = built.outputFiles[0]?.text ?? "";
});
after(async () => { await browser.close(); });

interface Badge { readonly text: string; readonly left: number; readonly right: number; readonly top: number; readonly bottom: number; readonly style: Record<string, string>; readonly ring: Record<string, string>; readonly labelShadow: string; readonly icon?: { readonly width: number; readonly height: number } }
interface Render { readonly badges: Badge[]; readonly stacks: Record<string, { left: number; right: number; top: number; bottom: number }> }

/** Renders one card's badge layer on a `width` × `height` artwork at the page origin. */
async function render(doc: unknown, card: Record<string, unknown>, width: number, height: number, variant: "poster" | "wide" = "poster"): Promise<Render> {
    const page: Page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    try {
        await page.setContent(`<!doctype html><style>@font-face { font-family: Inter; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 100 900; }</style><main><div class="browse-art" id="art" style="position:absolute;left:0;top:0;width:${width}px;height:${height}px"></div></main>`);
        await page.addStyleTag({ content: `${theme}\n${browse}\n* { transition: none !important; } body { margin: 0; }` });
        await page.addScriptTag({ content: bundle });
        await page.evaluate(() => document.fonts.ready);
        return await page.evaluate(({ doc, card, width, variant }) => {
            const api = window as unknown as { overlayLayer: (card: unknown, prefs: unknown, variant: string, width: number) => HTMLElement | undefined; parseOverlayPrefs: (raw: unknown) => unknown };
            const layer = api.overlayLayer({ id: "series:1", type: "series", title: "Show", ...card }, api.parseOverlayPrefs(doc), variant, width);
            const art = document.getElementById("art");
            if (layer === undefined || art === null) return { badges: [], stacks: {} };
            art.append(layer);
            const props = ["fontSize", "fontWeight", "letterSpacing", "lineHeight", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius", "backgroundColor", "backgroundImage", "color", "boxShadow", "textShadow", "textTransform"] as const;
            const badges = [...layer.querySelectorAll<HTMLElement>(".card-overlay")].map(node => {
                const rect = node.getBoundingClientRect();
                const style = getComputedStyle(node);
                const icon = node.querySelector("svg")?.getBoundingClientRect();
                const ring = getComputedStyle(node, "::before");
                const label = node.querySelector(".card-overlay-label");
                return { text: node.textContent ?? "", left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, style: Object.fromEntries(props.map(prop => [prop, style[prop]])), ring: { content: ring.content, boxShadow: ring.boxShadow, left: ring.left, right: ring.right, clipPath: ring.clipPath }, labelShadow: label === null ? "" : getComputedStyle(label).textShadow, ...(icon === undefined ? {} : { icon: { width: icon.width, height: icon.height } }) };
            });
            const stacks = Object.fromEntries([...layer.querySelectorAll<HTMLElement>(".card-overlay-stack")].map(stack => {
                const name = [...stack.classList].find(cls => cls !== "card-overlay-stack" && cls.startsWith("card-overlay-"))?.slice("card-overlay-".length) ?? "";
                const rect = stack.getBoundingClientRect();
                return [name, { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }];
            }));
            return { badges, stacks };
        }, { doc, card, width, variant });
    } finally { await page.close(); }
}

const near = (actual: number | undefined, expected: number, message: string, tolerance = 0.51): void => assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `${message}: ${actual} for ${expected}`);
const px = (value: string | undefined): number => parseFloat(value ?? "");
const only = (items: Record<string, unknown>) => ({ version: 2, preset: "classic", order: [], items: { resolution: { enabled: false, position: "top-left" }, hdr: { enabled: false, position: "top-left" }, audio: { enabled: false, position: "top-left" }, release_type: { enabled: false, position: "bottom-left" }, ...items } });
const RETURNING = { showStatus: "returning series" };

// Search's 220 × 330 poster (issue #453): Apple draws the badge about 165 below the top.
test("a stored top-right status badge is a classic tab flush on the right rail, centred down the poster", async () => {
    const width = 220;
    const scale = width / 185;
    const { badges } = await render(only({ show_status: { enabled: true, position: "top-right" } }), RETURNING, width, 330);
    assert.equal(badges.length, 1);
    const [badge] = badges;
    assert.equal(badge?.text, "Returning");
    near(badge?.right, width, "flush against the right edge (CardOverlays.swift:75-78, :101-106)");
    near(((badge?.top ?? 0) + (badge?.bottom ?? 0)) / 2, 165, "centred on the side edge");
    // OverlayPresets.swift:57-85: 10pt semibold, tracking-wide, 8 × 2 padding, capsule, a 1pt white 15% border.
    near((badge?.bottom ?? 0) - (badge?.top ?? 0), (10 + 2 * 2 + 1 * 2) * scale, "font line, padding and border (CardOverlays.swift:392-398, :430-438)", 0.05);
    near(px(badge?.style.fontSize), 10 * scale * CAP_SCALE, "font size", 0.02);
    near(px(badge?.style.lineHeight), 10 * scale, "leading-none line", 0.02);
    near(px(badge?.style.letterSpacing), 0.025 * 10 * scale, "tracking-wide", 0.01);
    assert.equal(badge?.style.fontWeight, "600");
    assert.equal(badge?.style.textTransform, "uppercase");
    near(px(badge?.style.paddingLeft), (8 + 1) * scale, "inline padding and the border outside it", 0.02);
    near(px(badge?.style.paddingRight), 8 * scale, "no border padding on the flush side", 0.02);
    near(px(badge?.style.paddingTop), (2 + 1) * scale, "block padding and the border", 0.02);
    // strokeBorder at 1 × scale, unsnapped; on a tab it runs past the card edge and is clipped (CardOverlays.swift:409-418).
    assert.match(badge?.ring.boxShadow ?? "", /rgba\(255, 255, 255, 0\.15\) 0px 0px 0px 1\.19px inset/);
    assert.equal(badge?.ring.right, "-1.19px");
    assert.equal(badge?.ring.clipPath, "inset(0px 1.19px 0px 0px)");
    assert.equal(badge?.style.borderTopRightRadius, "0px", "a tab's flush corners are square");
    assert.equal(badge?.style.borderBottomRightRadius, "0px");
    assert.equal(badge?.style.borderTopLeftRadius, "999px", "capsule on the open side");
    assert.equal(badge?.style.backgroundColor, "rgba(0, 0, 0, 0.6)");
    assert.equal(badge?.style.color, "rgb(255, 255, 255)");
});

test("ratings default to the left rail as tabs and a filled accent mixes like CSS color-mix", async () => {
    const { badges } = await render(only({ rating_imdb: { enabled: true } }), { ratingImdb: 8.46 }, 185, 277.5);
    const [badge] = badges;
    assert.equal(badge?.text, "IMDb 8.5");
    near(badge?.left, 0, "flush against the left edge");
    near(((badge?.top ?? 0) + (badge?.bottom ?? 0)) / 2, 277.5 / 2, "centred on the side edge");
    assert.equal(badge?.ring.left, "-1px", "the left tab's ring runs past the left edge");
    assert.equal(badge?.style.paddingLeft, "8px", "no border padding on the flush side");
    assert.equal(badge?.style.borderTopLeftRadius, "0px");
    // #f5c518 at 28% over black 60%, premultiplied (OverlayColor.swift:52-67): alpha .712, which Chromium stores as 182 / 255.
    assert.equal(badge?.style.backgroundColor, "rgba(96, 77, 9, 0.714)");
});

test("the top-left corner stops short of the watch-status corner and draws three badges at most", async () => {
    const width = 260;
    const scale = width / 185;
    const doc = { version: 2, preset: "classic", order: [], items: { video_codec: { enabled: true, position: "top-left" } } };
    const { badges, stacks } = await render(doc, { overlay: { resolution: "2160p", hdr: "HDR10", audio: "TrueHD Atmos", videoCodec: "HEVC" } }, width, 390);
    assert.deepEqual(badges.map(badge => badge.text), ["4K", "HDR10", "TrueHD Atmos"], "maxBadgesPerCorner (CardOverlays.swift:35)");
    near(stacks["top-left"]?.left, 8 * scale, "edge inset");
    near(stacks["top-left"]?.top, 8 * scale, "edge inset");
    near(stacks["top-left"]?.right, width - (8 + 22 + 8) * scale, "inset plus CardWatchStatus.size plus the edge gap (CardOverlays.swift:68-72)");
    const wide = await render(doc, { overlay: { resolution: "2160p" } }, 400, 225, "wide");
    near(wide.stacks["top-left"]?.right, 400 - 8, "wide cards draw no watch status");
});

test("a rail draws four badges at most within 60% of the card width", async () => {
    const doc = only({ rating_imdb: { enabled: true }, rating_tmdb: { enabled: true }, rating_rt: { enabled: true }, rating_rt_audience: { enabled: true }, network: { enabled: true, position: "left-edge" } });
    const { badges } = await render(doc, { ratingImdb: 7, ratingTmdb: 6, ratingRtCritic: 90, ratingRtAudience: 80, networks: ["A Very Long Network Name Indeed"] }, 185, 277.5);
    assert.deepEqual(badges.map(badge => badge.text), ["IMDb 7.0", "TMDB 6.0", "RT 90%", "RT Audience 80%"], "maxBadgesPerRail (CardOverlays.swift:36)");
    const long = await render(only({ network: { enabled: true, position: "left-edge" } }), { networks: ["A Very Long Network Name Indeed"] }, 185, 277.5);
    assert.ok((long.badges[0]?.right ?? 999) <= 185 * 0.6 + 0.5, `railMaxWidth (CardOverlays.swift:38, :97): ${long.badges[0]?.right}`);
});

test("the bottom corners share a row and a pair too wide wraps the right badge onto its own line", async () => {
    const width = 220;
    const scale = width / 185;
    const doc = only({ release_type: { enabled: true, position: "bottom-left" }, content_rating: { enabled: true, position: "bottom-right" } });
    const shared = await render(doc, { overlay: { releaseType: "WEB-DL" }, contentRating: "PG-13" }, width, 330);
    const [left, right] = shared.badges;
    near(left?.left, 8 * scale, "bottom-left inset");
    near(right?.right, width - 8 * scale, "bottom-right inset");
    near(left?.bottom, 330 - 8 * scale, "bottom inset");
    near(right?.bottom, 330 - 8 * scale, "one row");
    const wrapped = await render(only({ edition: { enabled: true, position: "bottom-left" }, studio: { enabled: true, position: "bottom-right" } }), { overlay: { edition: "Extended Director's Cut" }, studios: ["Long Studio Name"] }, 120, 180);
    const [edition, studio] = wrapped.badges;
    assert.ok((studio?.top ?? 0) >= (edition?.bottom ?? 999) - 0.5, `the right badge wraps below (CardOverlays.swift:238-290): ${JSON.stringify(wrapped.badges.map(b => [b.top, b.bottom]))}`);
    near(studio?.right, 120 - 8 * 120 / 185, "the wrapped badge stays on the right");
    near(studio?.bottom, 180 - 8 * 120 / 185, "the lower row sits on the bottom inset");
});

test("minimal keeps its rails inset with the text shadow; vibrant and pill paint the web's colours", async () => {
    const scale = 220 / 185;
    const minimal = await render({ ...only({ show_status: { enabled: true } }), preset: "minimal" }, RETURNING, 220, 330);
    near(minimal.badges[0]?.right, 220 - 8 * scale, "a transparent badge keeps the corner inset (CardOverlays.swift:75-78)");
    assert.equal(minimal.badges[0]?.style.color, "rgba(255, 255, 255, 0.85)");
    near(px(minimal.badges[0]?.style.letterSpacing), 0.1 * 9 * scale, "tracking-widest", 0.01);
    assert.match(minimal.badges[0]?.labelShadow ?? "", /rgba\(0, 0, 0, 0\.85\) 0px 1\.19px 2\.38px/);
    const vibrant = await render({ ...only({ show_status: { enabled: true } }), preset: "vibrant" }, RETURNING, 220, 330);
    assert.equal(vibrant.badges[0]?.style.backgroundColor, "rgba(220, 220, 220, 0.95)");
    assert.equal(vibrant.badges[0]?.style.color, "rgb(0, 0, 0)");
    assert.equal(vibrant.badges[0]?.style.fontWeight, "700");
    assert.match(vibrant.badges[0]?.style.boxShadow ?? "", /rgba\(0, 0, 0, 0\.25\) 0px 1\.19px 2\.38px/);
    near(px(vibrant.badges[0]?.style.borderTopLeftRadius), 10 * scale, "the web default theme's vibrant radius", 0.02);
    // OverlayIcon.swift:29-36: the symbol at 85% of iconSize, at least iconSize wide.
    near(vibrant.badges[0]?.icon?.width, 12 * 0.85 * 73 / 48 * scale, "tv symbol width", 0.05);
    const pill = await render({ ...only({ show_status: { enabled: true, accentColor: "#00ff00" } }), preset: "pill" }, RETURNING, 220, 330);
    assert.equal(pill.badges[0]?.style.backgroundColor, "rgba(15, 82, 22, 0.76)", "#00ff00 at 20% over rgb(20 20 30 / .7), premultiplied");
    near(px(pill.badges[0]?.style.paddingTop), (4 + 1) * scale, "pill block padding and border", 0.02);
    near(px(pill.badges[0]?.style.paddingLeft), (10 + 1) * scale, "pill inline padding and border", 0.02);
});

test("square draws its accent bar on the left side except on a left-rail tab", async () => {
    const scale = 185 / 185;
    const right = await render({ ...only({ show_status: { enabled: true, accentColor: "#ff0000" } }), preset: "square" }, RETURNING, 185, 277.5);
    assert.equal(right.badges[0]?.style.color, "rgb(255, 0, 0)");
    assert.equal(right.badges[0]?.style.backgroundColor, "rgba(0, 0, 0, 0.8)");
    assert.match(right.badges[0]?.style.backgroundImage ?? "", /linear-gradient/);
    near(px(right.badges[0]?.style.paddingLeft), (6 + 2) * scale, "inline padding plus the 2pt bar", 0.02);
    near(px(right.badges[0]?.style.borderTopLeftRadius), 8 * scale, "the web default theme's square radius", 0.02);
    const left = await render({ ...only({ rating_imdb: { enabled: true } }), preset: "square" }, { ratingImdb: 7 }, 185, 277.5);
    assert.equal(left.badges[0]?.style.backgroundImage, "none", "a left tab drops the bar (CardOverlays.swift:374)");
    assert.equal(left.badges[0]?.ring.content, "none", "square has no border");
    near(px(left.badges[0]?.style.paddingLeft), 6 * scale, "no bar padding", 0.02);
});
