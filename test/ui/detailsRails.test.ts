// Details seasons, episodes and lower rails against Apple TV (silo-apple 85679e7, tvOS); issue #398.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { CARD_PRESENTATION_KEY } from "../../src/contracts/v2/settings.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

function railTest(name: string, body: (tv: Tv, details: FakeDetails) => Promise<void>, size?: "compact" | "standard" | "large"): void {
    test(name, async () => {
        // en-AU, as on the TV and in the Apple TV capture ("16 Oct 2018").
        const tv = await openTv(browser, { app: "browse", locale: "en-AU" });
        const details = new FakeDetails();
        tv.fake.catalog = details;
        if (size !== undefined) new FakeSettings(tv.fake).profile().set(CARD_PRESENTATION_KEY, { poster_size: size, caption: "title_metadata" });
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

const SERIES = '[data-section="recently_added"] [data-focus="series:s1"]';
const MOVIE = '[data-section="recently_added"] [data-focus="movie:m0001"]';

/** Replaces the series' seasons and gives each season five episodes. */
async function routeSeasons(tv: Tv, details: FakeDetails, seasons: readonly { number: number; title: string; played?: boolean }[], episode: (number: number, index: number) => Record<string, unknown> = () => ({})): Promise<void> {
    const listed = details.route("GET", "/catalog/series/series%3As1/seasons", "p-owner")?.body as { items: Record<string, unknown>[] };
    const episodes = details.route("GET", "/catalog/series/series%3As1/seasons/1/episodes", "p-owner")?.body as { items: Record<string, unknown>[] };
    await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons?**", route => route.fulfill({ json: { items: seasons.map(season => ({ ...listed.items[0], content_id: `season:${season.number}`, season_number: season.number, title: season.title, episode_count: 5, user_data: { played: season.played === true } })) } }));
    await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons/*/episodes?**", route => {
        const number = Number(/seasons\/(\d+)\/episodes/.exec(route.request().url())?.[1]);
        return route.fulfill({ json: { items: Array.from({ length: 5 }, (_, index) => ({ ...episodes.items[0], content_id: `episode:rail:${number}:${index}`, season_number: number, episode_number: index + 1, ...episode(number, index) })) } });
    });
}

railTest("season pills match Apple TV's text, padding and spacing", async (tv, details) => {
    await routeSeasons(tv, details, Array.from({ length: 8 }, (_, index) => ({ number: index + 1, title: `Season ${index + 1}` })));
    await tv.page.locator(SERIES).first().click();
    await tv.page.locator('[data-focus="episode:rail:1:0"]').waitFor();
    const pills = await tv.page.locator(".details-season-chips .browse-button").evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect(), style = getComputedStyle(node);
        return { left: box.left, right: box.right, height: box.height, color: style.color, size: style.fontSize, weight: style.fontWeight, border: style.borderTopWidth };
    }));
    assert.equal(pills.length, 8);
    // Apple TV capture, The Rookie: Season 1 to Season 8 spans x100 to x1297.
    assert.ok(Math.abs(pills[0]!.left - 100) <= 2, `first pill starts at ${pills[0]!.left}`);
    assert.ok(Math.abs(pills[7]!.right - 1297) <= 2, `last pill ends at ${pills[7]!.right}`);
    for (const pill of pills) {
        assert.equal(pill.height, 52);
        assert.equal(pill.border, "0px");
        assert.equal(pill.size, "21.307px");
        assert.equal(pill.color, "rgb(255, 255, 255)");
    }
    assert.deepEqual(pills.map(pill => pill.weight), ["600", "500", "500", "500", "500", "500", "500", "500"]);
    for (let index = 1; index < pills.length; index++) assert.ok(Math.abs(pills[index]!.left - pills[index - 1]!.right - 12) < 0.5, "12pt between pills");
});

railTest("episode captions use Apple TV's code, date line, still and watched styling", async (tv, details) => {
    await routeSeasons(tv, details, [{ number: 1, title: "Season 1" }], (_number, index) => ({ title: index === 1 ? "" : `Episode ${index + 1}`, air_date: "2018-10-16", runtime: 43, user_data: { played: index === 2 } }));
    await tv.page.locator(SERIES).first().click();
    await tv.page.locator('[data-focus="episode:rail:1:4"]').waitFor();
    await tv.jump(500);
    const card = (index: number) => tv.page.locator(`[data-focus="episode:rail:1:${index}"]`);
    // EpisodeCardCaption.railTitle: just the code when the episode has no title.
    assert.equal(await card(1).locator(".browse-card-title").innerText(), "S01E02");
    assert.equal(await card(3).locator(".browse-card-title").innerText(), "S01E04 · Episode 4");
    const meta = await card(3).locator(".details-episode-meta").evaluate(node => {
        const style = getComputedStyle(node), range = document.createRange();
        range.selectNodeContents(node);
        return { text: node.textContent, size: style.fontSize, weight: style.fontWeight, space: style.whiteSpace, width: range.getBoundingClientRect().width };
    });
    assert.equal(meta.text, "16 Oct 2018  ·  43m");
    assert.deepEqual([meta.size, meta.weight, meta.space], ["16.4645px", "500", "pre"]);
    // The Apple TV capture draws "16 Oct 2018  ·  43m" 150-152px wide.
    assert.ok(Math.abs(meta.width - 151) <= 2, `date line is ${meta.width}px wide`);
    const still = await card(2).locator(".browse-art").evaluate(node => {
        const dim = node.querySelector(".details-episode-dim"), badge = node.querySelector(".browse-watched");
        const box = node.getBoundingClientRect(), badgeBox = badge?.getBoundingClientRect();
        return { radius: getComputedStyle(node).borderTopLeftRadius, shadow: getComputedStyle(node).boxShadow, dim: dim === null ? null : getComputedStyle(dim).backgroundColor, inset: badgeBox === undefined ? null : [box.right - badgeBox.right, badgeBox.top - box.top] };
    });
    assert.deepEqual(still, { radius: "18px", shadow: "none", dim: "rgba(0, 0, 0, 0.35)", inset: [12, 12] });
    assert.equal(await card(3).locator(".details-episode-dim").count(), 0, "an unwatched still is not dimmed");
});

railTest("a loading season holds the rail with Apple TV's four skeleton cards", async (tv, details) => {
    await routeSeasons(tv, details, [{ number: 1, title: "Season 1" }]);
    let release: (() => Promise<void>) | undefined;
    await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons/1/episodes?**", route => { release = () => route.fallback(); });
    await tv.page.locator(SERIES).first().click();
    await tv.page.locator(".details-episodes-placeholder").waitFor();
    assert.equal(await tv.page.getByText("Loading episodes…", { exact: true }).count(), 0, "no loading sentence under the pills");
    const skeleton = await tv.page.locator(".details-episodes-placeholder").evaluate(row => {
        const box = (node: Element | null) => { const rect = node?.getBoundingClientRect(); return rect === undefined ? null : [rect.width, rect.height]; };
        const card = row.querySelector(".details-episode-placeholder"), still = card?.querySelector(".details-episode-placeholder-still");
        const second = row.querySelectorAll(".details-episode-placeholder")[1];
        return {
            cards: row.querySelectorAll(".details-episode-placeholder").length,
            height: row.getBoundingClientRect().height,
            hidden: row.getAttribute("aria-hidden"),
            still: box(still ?? null), radius: still === null || still === undefined ? null : getComputedStyle(still).borderTopLeftRadius, fill: still === null || still === undefined ? null : getComputedStyle(still).backgroundColor,
            left: still?.getBoundingClientRect().left, spacing: (second?.getBoundingClientRect().left ?? 0) - (card?.getBoundingClientRect().right ?? 0),
            title: box(card?.querySelector(".details-episode-placeholder-title") ?? null), titleFill: getComputedStyle(card!.querySelector(".details-episode-placeholder-title")!).backgroundColor,
            meta: box(card?.querySelector(".details-episode-placeholder-meta") ?? null), metaFill: getComputedStyle(card!.querySelector(".details-episode-placeholder-meta")!).backgroundColor,
        };
    });
    // TVEpisodeRailPlaceholder at the standard size: 360x200 stills 40 apart, radius 18, siloSurfaceElevated, at horizontalInset 100.
    assert.deepEqual(skeleton, { cards: 4, height: 298, hidden: "true", still: [360, 200], radius: "18px", fill: "rgb(21, 23, 28)", left: 100, spacing: 40, title: [112, 15], titleFill: "rgba(255, 255, 255, 0.22)", meta: [84, 13], metaFill: "rgba(255, 255, 255, 0.16)" });
    const railHeight = () => tv.page.locator(".details-series-rail").evaluate(node => node.getBoundingClientRect().height);
    const reserved = await railHeight();
    await release?.();
    await tv.page.locator('[data-focus="episode:rail:1:0"]').waitFor();
    assert.equal(await tv.page.locator(".details-episodes-placeholder").count(), 0);
    assert.equal(await railHeight(), reserved, "the reserved height keeps the rails below still");
});

railTest("an empty season reads No episodes available in the reserved rail height", async (tv, details) => {
    // A loaded empty season is crossed, so only a window with no episodes at all is empty (SeriesEpisodeWindow).
    await routeSeasons(tv, details, [{ number: 1, title: "Season 1" }]);
    await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons/1/episodes?**", route => route.fulfill({ json: { items: [] } }));
    await tv.page.locator(SERIES).first().click();
    const empty = tv.page.locator(".details-episodes-empty");
    await empty.waitFor();
    assert.equal(await tv.page.getByText("This season has no episodes yet.", { exact: true }).count(), 0);
    assert.deepEqual(await empty.evaluate(node => { const style = getComputedStyle(node), box = node.getBoundingClientRect(); return { text: node.textContent, size: style.fontSize, color: style.color, height: box.height, left: box.left + parseFloat(style.paddingLeft) }; }),
        { text: "No episodes available", size: "21.307px", color: "rgba(237, 237, 237, 0.6)", height: 298, left: 100 });
});

railTest("a series without seasons keeps the pill row and reads No episodes available", async (tv, details) => {
    await routeSeasons(tv, details, []);
    await tv.page.locator(SERIES).first().click();
    const empty = tv.page.locator(".details-episodes-empty");
    await empty.waitFor();
    assert.equal(await tv.page.getByText("This series has no seasons yet.", { exact: true }).count(), 0);
    // Loaded and empty, Apple's four placeholder pills keep their 60pt row at opacity 0.
    assert.deepEqual(await tv.page.locator(".details-season-placeholders").evaluate(row => ({ height: row.getBoundingClientRect().height, visibility: getComputedStyle(row).visibility, pills: [...row.children].map(pill => { const box = pill.getBoundingClientRect(); return [box.width, box.height, getComputedStyle(pill).borderTopLeftRadius]; }) })),
        { height: 60, visibility: "hidden", pills: Array.from({ length: 4 }, () => [170, 48, "10px"]) });
});

railTest("season pills sort by number with Specials last and fall back to Apple's labels", async (tv, details) => {
    await routeSeasons(tv, details, [{ number: 0, title: "" }, { number: 2, title: "" }, { number: 1, title: "Pilot Season" }, { number: 2, title: "Duplicate" }]);
    await tv.page.locator(SERIES).first().click();
    await tv.page.locator('[data-focus="season:1"]').waitFor();
    assert.deepEqual(await tv.page.locator(".details-season-chips .browse-button").allInnerTexts(), ["Pilot Season", "Season 2", "Specials"]);
});

railTest("a focused season pill takes Apple's shadow and an unselected one turns white after 70ms", async (tv, details) => {
    await routeSeasons(tv, details, [{ number: 1, title: "Season 1" }, { number: 2, title: "Season 2" }]);
    await tv.page.locator(SERIES).first().click();
    await tv.page.locator('[data-focus="episode:rail:1:0"]').waitFor();
    const style = (season: number) => tv.page.locator(`[data-focus="season:${season}"]`).evaluate(node => { const computed = getComputedStyle(node); return { shadow: computed.boxShadow, delay: computed.transitionDelay }; });
    await tv.page.locator('[data-focus="season:2"]').focus();
    assert.equal((await style(2)).delay, "0.07s");
    await tv.eventually(async () => (await style(2)).shadow === "rgba(0, 0, 0, 0.28) 0px 4px 20px 0px", "TVSeriesModeTabStyle focused shadow");
    await tv.page.locator('[data-focus="season:2"][aria-pressed="true"]').waitFor();
    assert.equal((await style(2)).delay, "0s", "the selected pill paints white at once");
    assert.equal((await style(1)).shadow, "none");
});

const YOUTUBE = { kind: "trailer", site: "YouTube", site_key: "abc_def-1", name: "Official Trailer", is_official: true };
const BOX_SET = {
    id: "1241", library_id: "12", title: "Harry Potter Collection", overview: "Wizards.", poster_url: "/art/potter.svg", movie_count: 2, played_count: 0, first_year: 2001, last_year: 2002,
    items: [{ content_id: "movie:m0001", type: "movie", title: "Philosopher's Stone", year: 2001, poster_url: "/art/hp1.svg" }, { content_id: "movie:m0002", type: "movie", title: "Chamber of Secrets", year: 2002, poster_url: "/art/hp2.svg" }],
};

/** The Last Signal with a YouTube trailer, a box set and the given cast. */
async function routeMovie(tv: Tv, details: FakeDetails, change: (body: Record<string, unknown>) => Record<string, unknown> = body => body): Promise<void> {
    details.searchCapabilities = { ...details.searchCapabilities, box_sets: true };
    const body = details.route("GET", "/catalog/items/movie%3Am0001", "p-owner")?.body as Record<string, unknown>;
    await tv.page.route("**/api/v2/catalog/items/movie%3Am0001?**", route => route.fulfill({ json: change({ ...body, videos: [YOUTUBE] }) }));
    await tv.page.route("**/api/v2/catalog/items/movie%3Am0001/box-set?**", route => route.fulfill({ json: { box_set: BOX_SET } }));
}

const headings = (tv: Tv): Promise<string[]> => tv.page.locator(".browse > .browse-section-title, .details-facts > .browse-section-title").allInnerTexts();

railTest("movie sections follow Apple TV's order and lower-rail radii", async (tv, details) => {
    await routeMovie(tv, details);
    await tv.page.locator(MOVIE).first().click();
    await tv.page.locator('.box-set-row [data-focus="box-set-explore"]').waitFor();
    await tv.page.locator('[data-detail-section="related"] .browse-card').first().waitFor();
    assert.deepEqual(await headings(tv), ["Cast & Crew", "Trailers & More", "Harry Potter Collection", "Related Movies", "Details"]);
    const radius = (selector: string) => tv.page.locator(selector).first().evaluate(node => getComputedStyle(node).borderTopLeftRadius);
    assert.equal(await radius(".box-set-row .browse-card:not(.skyline-explore) .browse-art"), "12px");
    assert.equal(await radius(".box-set-row .skyline-explore .browse-art"), "12px");
    await tv.page.locator(".details-facts-table").focus();
    assert.equal(await tv.page.locator(".details-facts-table").evaluate(node => getComputedStyle(node, "::before").borderTopLeftRadius), "8px");
});

for (const [size, width] of [["compact", 189.2], ["large", 264]] as const) railTest(`the box set row scales its cards at the ${size} card size`, async (tv, details) => {
    await routeMovie(tv, details);
    await tv.page.locator(MOVIE).first().click();
    await tv.page.locator('.box-set-row [data-focus="box-set-explore"]').waitFor();
    const boxes = await tv.page.locator(".box-set-row .browse-art").evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return [box.width, box.height]; }));
    // TVMediaCard.artworkSize: 220 times 0.86 or 1.2, with a 2:3 poster; Explore all takes the same size.
    assert.equal(boxes.length, 3);
    for (const [w, h] of boxes) { assert.ok(Math.abs(w! - width) < 0.05, `card ${w}px wide`); assert.ok(Math.abs(h! - width * 1.5) < 0.25, `card ${h}px tall`); }
}, size);

railTest("an empty facts list keeps the Details header, and a credit without a character has no role line", async (tv, details) => {
    await routeMovie(tv, details, body => ({ ...body, cast: [{ person_id: "7", name: "River Vale", character: "Alex", order: 0 }, { name: "Morgan Lane", character: "", order: 1 }], crew: [], studios: [], countries: [], original_language: undefined, genres: [], release_date: undefined, premiere_date: undefined, year: undefined }));
    await tv.page.locator(MOVIE).first().click();
    await tv.page.locator('.box-set-row [data-focus="box-set-explore"]').waitFor();
    assert.equal(await tv.page.locator(".details-facts > .browse-section-title").innerText(), "Details");
    assert.deepEqual(await tv.page.locator(".details-people .browse-card").evaluateAll(cards => cards.map(card => card.querySelectorAll(".browse-card-subtitle").length)), [1, 0]);
});

railTest("Cast and Related always enter on their first card", async (tv, details) => {
    await routeMovie(tv, details);
    await tv.page.locator(MOVIE).first().click();
    const people = tv.page.locator(".details-people [data-focus]");
    await people.nth(1).waitFor();
    await tv.page.locator('[data-detail-section="related"] .browse-card').nth(2).waitFor();
    await people.nth(1).focus();
    await tv.remote(38);
    assert.equal(await tv.page.locator(".details-people :focus").count(), 0, "Up leaves the cast rail");
    await tv.remote(40);
    assert.equal(await tv.focused(), await people.first().getAttribute("data-focus"), "Down re-enters the cast rail on the first person");
    const related = tv.page.locator('[data-detail-section="related"] .browse-card');
    await related.nth(2).focus();
    await tv.remote(38);
    assert.equal(await tv.page.locator('[data-detail-section="related"] :focus').count(), 0, "Up leaves the related rail");
    await tv.remote(40);
    assert.equal(await tv.focused(), await related.first().getAttribute("data-focus"), "Down re-enters the related rail on the first title");
});

railTest("Related loads behind four 220x330 placeholders and then shows twelve titles", async (tv, details) => {
    let release: (() => Promise<void>) | undefined, limit: string | null = null;
    await tv.page.route("**/api/v2/recommendations/similar/**", route => {
        limit = new URL(route.request().url()).searchParams.get("limit");
        release = () => route.fulfill({ json: { items: Array.from({ length: 15 }, (_, index) => index === 3 ? { content_id: "movie:m0001", type: "movie", title: "The Last Signal" } : { content_id: `movie:r${index}`, type: "movie", title: `Related ${index}` }) } });
    });
    await tv.page.locator(MOVIE).first().click();
    const placeholders = tv.page.locator(".details-related-placeholder");
    await placeholders.first().waitFor();
    assert.equal(await tv.page.getByText("Loading related titles.", { exact: true }).count(), 0, "no loading sentence");
    assert.deepEqual(await placeholders.evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(), style = getComputedStyle(node); return [box.width, box.height, style.borderTopLeftRadius, style.backgroundColor]; })),
        Array.from({ length: 4 }, () => [220, 330, "12px", "rgb(21, 23, 28)"]));
    assert.equal(limit, "12", "TVSimilarRail asks for 12");
    await release?.();
    await tv.page.locator('[data-detail-section="related"] .browse-card').first().waitFor();
    // TVSimilarRail keeps the server's first 12, including the title on screen.
    assert.deepEqual(await tv.page.locator('[data-detail-section="related"] .browse-card').evaluateAll(cards => cards.map(card => card.getAttribute("data-focus"))),
        Array.from({ length: 12 }, (_, index) => index === 3 ? "movie:m0001" : `movie:r${index}`));
}, "large");

railTest("a related pick replaces a page a related pick opened, so Back skips it", async (tv) => {
    // Each movie's similar list: the title on screen, the movie under it, then two others.
    const similar: Record<string, string[]> = { "movie%3Am0001": ["movie:m0004", "movie:m0005"], "movie%3Am0004": ["movie:m0004", "movie:m0001", "movie:m0005"], "movie%3Am0005": ["movie:m0006"], "movie%3Am0006": ["movie:m0004"] };
    await tv.page.route("**/api/v2/recommendations/similar/**", route => {
        const id = /similar\/([^?]+)/.exec(route.request().url())?.[1] ?? "";
        return route.fulfill({ json: { items: (similar[id] ?? []).map(content => ({ content_id: content, type: "movie", title: content })) } });
    });
    const view = () => tv.page.evaluate(() => document.querySelector(".browse")?.getAttribute("data-view") ?? null);
    const showing = (name: string) => tv.eventually(async () => await view() === name, `the ${name} view`);
    const pick = async (id: string) => { const card = tv.page.locator(`[data-detail-section="related"] [data-focus="${id}"]`); await card.waitFor(); await card.click(); };
    await tv.page.locator(MOVIE).first().click();
    await showing("item:movie:m0001");
    // A to B to C: Back from C returns to A.
    await pick("movie:m0005");
    await showing("item:movie:m0005");
    await pick("movie:m0006");
    await showing("item:movie:m0006");
    await tv.remote(10009);
    await showing("item:movie:m0001");
    // From B, the title already showing opens nothing, and A goes back to A.
    await pick("movie:m0004");
    await showing("item:movie:m0004");
    await pick("movie:m0004");
    await tv.jump(500);
    assert.equal(await view(), "item:movie:m0004");
    await pick("movie:m0001");
    await showing("item:movie:m0001");
    await tv.remote(10009);
    await tv.eventually(async () => !(await view() ?? "").startsWith("item:"), "Back from A leaves Details: B was not kept under it");
});

railTest("holding Select on a season pill offers only Mark Season Watched or Unwatched", async (tv, details) => {
    await tv.page.locator(SERIES).first().click();
    const pill = tv.page.locator('[data-focus="season:1"]');
    await tv.page.locator('[data-focus^="episode:"]').first().waitFor();
    await pill.focus();
    await tv.page.keyboard.down("Enter");
    await tv.jump(400);
    await tv.down(13, false);
    await tv.jump(250);
    await tv.page.keyboard.up("Enter");
    const menu = tv.page.locator(".card-actions-panel");
    await menu.getByRole("button", { name: "Mark Season Unwatched", exact: true }).waitFor();
    assert.deepEqual(await menu.locator(".card-actions-buttons .browse-button").allInnerTexts(), ["Mark Season Unwatched"]);
    assert.equal(await menu.getByText("List actions are unavailable for this title.", { exact: true }).count(), 0);
    const before = details.mutations.length;
    await menu.getByRole("button", { name: "Mark Season Unwatched", exact: true }).click();
    await tv.eventually(async () => details.mutations.length > before, "season watched change sent");
    await tv.remote(10009);
    await tv.eventually(async () => await menu.count() === 0, "Back dismisses the menu");
});
