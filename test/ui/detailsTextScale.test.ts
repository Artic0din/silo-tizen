// Every Details text size is Apple's tvOS point size times --silo-sf-cap-scale (issue #399).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

const MOVIE = '[data-section="recently_added"] [data-focus="movie:m0001"]';
const SERIES = '[data-section="recently_added"] [data-focus="series:s1"]';
const YOUTUBE = { kind: "trailer", site: "YouTube", site_key: "abc_def-1", name: "Official Trailer", is_official: true };
const BOX_SET = {
    id: "1241", library_id: "12", title: "Harry Potter Collection", overview: "Wizards.", poster_url: "/art/potter.svg", movie_count: 2, played_count: 0, first_year: 2001, last_year: 2002,
    items: [{ content_id: "movie:m0001", type: "movie", title: "Philosopher's Stone", year: 2001, poster_url: "/art/hp1.svg" }, { content_id: "movie:m0002", type: "movie", title: "Chamber of Secrets", year: 2002, poster_url: "/art/hp2.svg" }],
};

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

function detailTest(name: string, body: (tv: Tv, details: FakeDetails) => Promise<void>): void {
    test(name, async () => {
        const tv = await openTv(browser, { app: "browse" });
        const details = new FakeDetails();
        tv.fake.catalog = details;
        try {
            await tv.page.evaluate(() => window.browseHarness.connect());
            await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
            tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
            await tv.jump(5000);
            await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
            await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
            await tv.page.evaluate(() => window.browseHarness.mount());
            await body(tv, details);
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}

/**
 * Rendered text under `root` whose size is not a whole Apple point times the cap scale, as "classes size".
 * The monospaced popover header is SF Mono on Apple TV, not SF Pro, so Inter's cap-height correction does not apply.
 */
function unscaledText(root: string): string[] {
    const cap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--silo-sf-cap-scale"));
    const found = new Set<string>();
    for (const node of document.querySelectorAll(`${root}, ${root} *`)) {
        if (node.getClientRects().length === 0) continue;
        const styles: [string, CSSStyleDeclaration][] = [];
        if ([...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim() !== "")) styles.push(["", getComputedStyle(node)]);
        const before = getComputedStyle(node, "::before");
        if (before.content !== "none" && before.content !== "normal" && before.content !== '""') styles.push(["::before", before]);
        for (const [pseudo, style] of styles) {
            if (style.fontFamily.includes("monospace") || style.visibility === "hidden") continue;
            const size = parseFloat(style.fontSize);
            if (size === 0) continue;
            const points = size / cap;
            if (Math.abs(points - Math.round(points)) > 0.002) found.add(`${node.tagName.toLowerCase()}.${[...node.classList].join(".")}${pseudo} ${style.fontSize}`);
        }
    }
    return [...found].sort();
}

/** The Last Signal with a two-part title, a YouTube trailer, a box set, cast, Related and facts. */
async function routeMovie(tv: Tv, details: FakeDetails): Promise<void> {
    details.searchCapabilities = { ...details.searchCapabilities, box_sets: true };
    const body = details.route("GET", "/catalog/items/movie%3Am0001", "p-owner")?.body as Record<string, unknown>;
    await tv.page.route("**/api/v2/catalog/items/movie%3Am0001?**", route => route.fulfill({ json: { ...body, title: "The Last Signal: Night Shift", logo_url: undefined, videos: [YOUTUBE], content_rating: "M" } }));
    await tv.page.route("**/api/v2/catalog/items/movie%3Am0001/box-set?**", route => route.fulfill({ json: { box_set: BOX_SET } }));
}

detailTest("movie Details text, rails and popovers use Apple's points times the cap scale", async (tv, details) => {
    await routeMovie(tv, details);
    await tv.page.locator(MOVIE).first().click();
    await tv.page.locator('.box-set-row [data-focus="box-set-explore"]').waitFor();
    await tv.page.locator('[data-detail-section="related"] .browse-card').first().waitFor();
    await tv.page.locator(".details-extras .browse-card").first().waitFor();
    await tv.page.locator(".details-facts-table").waitFor();
    await tv.page.locator(".details-editorial .requests-title-secondary").waitFor();
    await tv.page.locator(".details-editorial .details-rating-badge").waitFor();
    assert.deepEqual(await tv.page.evaluate(unscaledText, ".browse"), []);
    for (const action of ["audio", "subtitles", "version", "more"]) {
        await tv.page.locator(`[data-focus="${action}"]`).click();
        await tv.page.locator(".details-track-popover").waitFor();
        assert.deepEqual(await tv.page.evaluate(unscaledText, ".details-track-popover"), [], action);
        await tv.remote(10009);
        await tv.page.locator(".details-track-popover").waitFor({ state: "detached" });
    }
});

detailTest("series Details text and the episode rail use Apple's points times the cap scale", async (tv, details) => {
    details.extras = [{ content_id: "extra:1", kind: "trailer", title: "Trailer" }];
    await tv.page.locator(SERIES).first().click();
    await tv.page.locator('.details-episodes [data-focus="episode:s1e11"]').waitFor();
    await tv.page.locator(".details-extras .browse-card").first().waitFor();
    await tv.page.locator(".details-people .browse-card").first().waitFor();
    assert.deepEqual(await tv.page.evaluate(unscaledText, ".browse"), []);
});

detailTest("the box set Details page uses Apple's points times the cap scale", async (tv, details) => {
    await routeMovie(tv, details);
    await tv.page.route("**/api/v2/catalog/box-sets/1241?**", route => route.fulfill({ json: BOX_SET }));
    await tv.page.locator(MOVIE).first().click();
    const explore = tv.page.locator('.box-set-row [data-focus="box-set-explore"]');
    await explore.click();
    await tv.page.locator('.details-hero[data-media-type="box-set"] .box-set-facts').waitFor();
    await tv.page.locator(".details-editorial .box-set-play-film").waitFor();
    assert.deepEqual(await tv.page.evaluate(unscaledText, ".browse"), []);
});

detailTest("the Details failure page and the inline episode error use Apple's points times the cap scale", async tv => {
    const series = tv.page.locator(SERIES).first();
    await series.click();
    await tv.page.locator('.details-episodes [data-focus="episode:s1e11"]').waitFor();
    await tv.remote(10009);
    await tv.page.route("**/api/v2/**", route => route.abort("connectionrefused"));
    await series.click();
    await tv.jump(35000);
    await tv.page.locator(".details-episode-error").waitFor();
    assert.deepEqual(await tv.page.evaluate(unscaledText, ".details-episode-error"), []);
    await tv.remote(10009);
    const movie = tv.page.locator(MOVIE).first();
    await movie.click();
    await tv.jump(35000);
    await tv.page.locator(".details-failure .browse-button").first().waitFor();
    assert.deepEqual(await tv.page.evaluate(unscaledText, ".details-failure"), []);
});

/**
 * Typographic widths CoreText reports for SF Pro (NSFont.systemFont, the face tvOS draws) at Apple's tvOS size and
 * weight, plus Apple's own tracking per character. The title's lead and subtitle use SF Pro Compressed.
 */
const SF_WIDTHS: readonly { selector: string; text: string; width: number }[] = [
    { selector: ".details-editorial .requests-title-primary", text: "The Last Signal", width: 524.6 },
    { selector: ".details-editorial .requests-title-secondary", text: "Night Shift", width: 168.24 + 11 * 1.5 },
    { selector: ".browse > .browse-section-title", text: "Cast & Crew", width: 201.36 },
    { selector: ".browse > .browse-section-title", text: "Related Movies", width: 247.42 },
    { selector: ".details-editorial .details-director", text: "Directed by River Vale", width: 215.7 },
    { selector: '[data-focus="audio"] .details-action-label', text: "Audio Tracks", width: 151.9 },
    { selector: '[data-focus="resume"] .details-action-label', text: "Resume 20:00", width: 193.93 },
    { selector: ".details-people .browse-card-title", text: "Morgan Lane", width: 119.32 },
    { selector: ".details-people .browse-card-subtitle", text: "Sam", width: 33.71 },
    { selector: ".details-extras .browse-card-title", text: "Official Trailer", width: 133.05 },
    { selector: ".details-extras .browse-card-subtitle", text: "YouTube", width: 66.76 },
    { selector: ".box-set-row .browse-card-title", text: "Philosopher's Stone", width: 212.79 },
    { selector: ".details-fact-row dt", text: "COUNTRY", width: 88.38 + 7 * 2 },
    { selector: ".details-fact-row dd", text: "North Studio", width: 120.94 },
];

detailTest("movie Details text runs within 2% of SF Pro's width at Apple's size", async (tv, details) => {
    await routeMovie(tv, details);
    await tv.page.locator(MOVIE).first().click();
    await tv.page.locator(".box-set-row .browse-card-title").first().waitFor();
    await tv.page.locator(".details-extras .browse-card").first().waitFor();
    await tv.page.locator(".details-facts-table").waitFor();
    await tv.page.locator(".details-editorial .requests-title-secondary").waitFor();
    await tv.page.evaluate(() => document.fonts.ready);
    const widths = await tv.page.evaluate(rows => rows.map(({ selector, text }) => {
        const node = [...document.querySelectorAll(selector)].find(candidate => (candidate.textContent ?? "").trim() === text);
        if (node === undefined) return { text, width: Number.NaN };
        const range = document.createRange();
        range.selectNodeContents(node);
        return { text, width: Math.round(range.getBoundingClientRect().width * 10) / 10 };
    }), SF_WIDTHS.map(({ selector, text }) => ({ selector, text })));
    for (const [index, { text, width }] of widths.entries()) {
        const expected = SF_WIDTHS[index]!.width;
        assert.ok(Math.abs(width / expected - 1) < 0.02, `${text}: ${width}px against SF Pro's ${expected}px`);
    }
});
