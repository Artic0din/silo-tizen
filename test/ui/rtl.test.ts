// Arabic shown right to left (silo-apple iOSApp.swift `AppLanguageEnvironment`, DesignSystem/MediaLayoutDirection.swift):
// the document takes dir="rtl" with the language, at launch and on a change, and Left and Right on the remote follow
// the mirrored layout, as `MoveCommandDirection.inLayout` makes them on tvOS.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { APP_LANGUAGE_KEY } from "../../src/contracts/v2/settings.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeHome } from "../native/support/fakeHome.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { openChangeAccount, withSignedInTv } from "./support/accounts.ts";
import { selectLibraryMode } from "./support/library.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

registerSourceCatalogs();

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const BACK = 10009;
const LEFT = 37;
const RIGHT = 39;
const DOWN = 40;

interface HomeOptions {
    readonly stored?: string;
    readonly cached?: string;
    /** Holds the profile's language answer, so only the kept language can have set the direction. */
    readonly holdLanguage?: boolean;
    /** Offers Switch Server in the profile menu. */
    readonly switchServer?: boolean;
}

async function withHome(options: HomeOptions, body: (tv: Tv, releaseLanguage: () => void) => Promise<void>): Promise<void> {
    const tv = await openTv(browser, { app: "browse" });
    tv.fake.catalog = new FakeHome();
    let held: { release(): void }[] = [];
    const settings = new FakeSettings(tv.fake);
    settings.revision = 28;
    if (options.stored !== undefined) settings.profile().set(APP_LANGUAGE_KEY, options.stored);
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        if (options.cached !== undefined) await tv.page.evaluate(choice => window.browseHarness.seedAppLanguage(choice), options.cached);
        if (options.holdLanguage === true) held = Array.from({ length: 8 }, () => tv.fake.hold("/settings/values/effective", true));
        if (options.switchServer === true) await tv.page.evaluate(() => { window.browseHarness.offerSwitchServer = true; });
        await tv.page.evaluate(() => window.browseHarness.mount(true));
        await tv.page.locator('[data-view="home"]').waitFor();
        await body(tv, () => held.forEach(hold => hold.release()));
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

const direction = (tv: Tv): Promise<string | null> => tv.page.evaluate(() => document.documentElement.getAttribute("dir"));
const waitForDirection = (tv: Tv, expected: string | null): Promise<void> => tv.eventually(async () => await direction(tv) === expected, `dir ${expected}`);
const left = (tv: Tv, selector: string): Promise<number> => tv.page.locator(selector).evaluate(node => node.getBoundingClientRect().left);
/** The card the focus is on, as its left edge, so a test can say which way a move went. */
const focusedLeft = (tv: Tv): Promise<number> => tv.page.evaluate(() => document.activeElement?.getBoundingClientRect().left ?? Number.NaN);

test("a kept Arabic mirrors the page at launch, before the server answers", async () => {
    await withHome({ cached: "ar", stored: "ar", holdLanguage: true }, async (tv, releaseLanguage) => {
        await waitForDirection(tv, "rtl");
        assert.equal(await tv.page.evaluate(() => getComputedStyle(document.body).direction), "rtl");
        releaseLanguage();
        await tv.eventually(async () => tv.pendingReplies === 0, "answers in");
        assert.equal(await direction(tv), "rtl", "the server's answer keeps it");
    });
});

test("English and German leave the page left to right", async () => {
    await withHome({}, async tv => {
        assert.equal(await direction(tv), null);
    });
    await withHome({ stored: "de" }, async tv => {
        await tv.eventually(async () => (await tv.page.locator(".skyline-roots [data-focus]").first().innerText()) !== "Home", "German top bar");
        assert.equal(await direction(tv), null);
    });
});

test("Arabic loses its direction when browse is torn down, so the English sign-in screens read left to right", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        assert.equal(await tv.page.evaluate(() => document.documentElement.getAttribute("lang")), "ar");
        await tv.page.evaluate(() => window.browseHarness.destroy());
        assert.equal(await direction(tv), null);
        assert.equal(await tv.page.evaluate(() => document.documentElement.getAttribute("lang")), "en", "torn down: the default lang");
    });
});

/** The category list is on the side the layout reads from. Polled: the panes settle a frame after the repaint that mirrors them. */
const categoriesLead = (tv: Tv, side: "left" | "right"): Promise<void> => tv.eventually(async () => {
    const categories = await left(tv, ".settings-categories"), rows = await left(tv, ".settings-pane.settings-controls");
    return side === "left" ? categories < rows : categories > rows;
}, `the categories lead on the ${side}`);

/** The first forward chevron's transform once the repaint has drawn it (a node read mid-repaint has none). */
const chevronTransform = (tv: Tv, expected: string): Promise<void> => tv.eventually(async () => await tv.page.locator(".settings .settings-chevron").first().evaluate(node => getComputedStyle(node).transform) === expected, `chevron transform ${expected}`);

async function openSettings(tv: Tv): Promise<void> {
    await tv.page.locator('[data-focus="profiles"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('.skyline-selector [data-focus="settings"]').click();
    await tv.page.locator('[data-focus="app-language"]').waitFor();
}

test("picking Arabic in Settings mirrors the page in the repaint that changes its words, and picking English returns it", async () => {
    await withHome({}, async tv => {
        await openSettings(tv);
        assert.equal(await direction(tv), null);
        await categoriesLead(tv, "left");
        await tv.page.locator('[data-focus="app-language"]').click();
        await tv.page.getByRole("radio", { name: "العربية", exact: true }).click();
        await waitForDirection(tv, "rtl");
        await tv.eventually(async () => await tv.page.locator(".settings-panes h1.browse-title").innerText() !== "Settings", "Settings in Arabic");
        await categoriesLead(tv, "right");
        // The row's forward chevron points the way a forward chevron does in Arabic.
        await chevronTransform(tv, "matrix(-1, 0, 0, 1, 0, 0)");

        await tv.page.locator('[data-focus="app-language"]').click();
        await tv.page.getByRole("radio", { name: "English", exact: true }).click();
        await waitForDirection(tv, null);
        await tv.eventually(async () => await tv.page.locator(".settings-panes h1.browse-title").innerText() === "Settings", "Settings in English");
        await categoriesLead(tv, "left");
        await chevronTransform(tv, "none");
    });
});

test("in Arabic the top bar's Left press moves to the tab on its left, and Right returns", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        await tv.eventually(async () => await tv.page.locator('[data-focus="movies"]').innerText() !== "Movies", "Arabic top bar");
        await tv.page.locator('[data-focus="home"]').focus();
        const home = await left(tv, '[data-focus="home"]');
        assert.ok(await left(tv, '[data-focus="movies"]') < home, "Movies follows Home to its left");
        await tv.remote(LEFT);
        assert.equal(await tv.focused(), "movies");
        await tv.remote(RIGHT);
        assert.equal(await tv.focused(), "home");
    });
});

test("in English the same Right press moves to the next tab, as before", async () => {
    await withHome({}, async tv => {
        await tv.page.locator('[data-focus="home"]').focus();
        await tv.remote(RIGHT);
        assert.equal(await tv.focused(), "movies");
        await tv.remote(LEFT);
        assert.equal(await tv.focused(), "home");
    });
});

test("in Arabic a row steps toward the card on the left with Left and back with Right", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        const cards = tv.page.locator('[data-section="recent/12"] [data-focus]');
        await cards.first().focus();
        const first = await focusedLeft(tv);
        await tv.remote(LEFT);
        const second = await focusedLeft(tv);
        assert.ok(second < first, `Left moved from x ${first} to ${second}`);
        assert.equal(await tv.focused(), await cards.nth(1).getAttribute("data-focus"));
        await tv.remote(RIGHT);
        assert.equal(await focusedLeft(tv), first);
        await tv.remote(RIGHT);
        assert.equal(await focusedLeft(tv), first, "Right past the first card stays on it");
    });
});

test("in Arabic a long row scrolls to keep the focused card on screen as Left walks it", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        const cards = tv.page.locator('[data-section="recent/12"] [data-focus]');
        const total = await cards.count();
        assert.ok(total >= 12, `${total} cards`);
        await cards.first().focus();
        for (let step = 1; step < 12; step++) {
            await tv.remote(LEFT);
            const card = await tv.page.evaluate(() => { const rect = document.activeElement?.getBoundingClientRect(); return rect === undefined ? undefined : { left: rect.left, right: rect.right }; });
            assert.ok(card !== undefined && card.left >= 0 && card.right <= 1920, `card ${step} at ${card?.left}..${card?.right}`);
        }
        assert.equal(await tv.focused(), await cards.nth(11).getAttribute("data-focus"));
        for (let step = 0; step < 11; step++) await tv.remote(RIGHT);
        assert.equal(await tv.focused(), await cards.first().getAttribute("data-focus"));
    });
});

test("in Arabic Settings, Left from the category list enters the rows that lie to its left, and Right returns", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        await openSettings(tv);
        await tv.page.locator('.settings-categories [aria-selected="true"], .settings-categories [aria-current="true"], .settings-categories .browse-button').first().focus();
        assert.equal(await tv.page.evaluate(() => document.activeElement?.closest(".settings-categories") !== null), true);
        await tv.remote(LEFT);
        assert.equal(await tv.page.evaluate(() => document.activeElement?.closest(".settings-pane.settings-controls") !== null), true, "Left enters the rows");
        await tv.remote(RIGHT);
        assert.equal(await tv.page.evaluate(() => document.activeElement?.closest(".settings-categories") !== null), true, "Right returns to the categories");
        await tv.remote(DOWN);
        await tv.remote(BACK);
    });
});

const box = (tv: Tv, selector: string): Promise<{ left: number; right: number }> => tv.page.locator(selector).evaluate(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right }; });

test("in Arabic the profile menu opens under the profile button, at the left edge", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        await tv.page.locator('[data-focus="profiles"]').focus();
        await tv.remote(DOWN);
        const panel = tv.page.locator(".skyline-selector:not(.skyline-flyout)");
        await panel.waitFor();
        const button = await box(tv, '[data-focus="profiles"]');
        const menu = await box(tv, ".skyline-selector:not(.skyline-flyout)");
        assert.ok(Math.abs(menu.left - button.left) < 1, `menu at ${menu.left}, button at ${button.left}`);
    });
});

for (const [language, enter, leave] of [["ar", LEFT, RIGHT], ["en", RIGHT, LEFT]] as const) {
    test(`a library's sections open on its ${language === "ar" ? "left" : "right"} with ${language === "ar" ? "Left" : "Right"}, and the opposite key returns`, async () => {
        await withHome(language === "ar" ? { stored: "ar" } : {}, async tv => {
            if (language === "ar") await waitForDirection(tv, "rtl");
            await tv.page.locator('[data-focus="movies"]').focus();
            await tv.remote(DOWN);
            const panel = tv.page.locator(".skyline-selector:not(.skyline-flyout)");
            await panel.waitFor();
            const library = await tv.focused();
            await tv.remote(enter);
            const flyout = await box(tv, ".skyline-flyout");
            const menu = await box(tv, ".skyline-selector:not(.skyline-flyout)");
            if (language === "ar") assert.ok(flyout.right <= menu.left, `flyout ${flyout.left}..${flyout.right} beside menu ${menu.left}..${menu.right}`);
            else assert.ok(flyout.left >= menu.right, `flyout ${flyout.left}..${flyout.right} beside menu ${menu.left}..${menu.right}`);
            assert.equal(await tv.page.evaluate(() => document.activeElement?.closest(".skyline-flyout") !== null), true, "focus is in the sections");
            await tv.remote(leave);
            assert.equal(await tv.focused(), library, "the opposite key returns to the library");
        });
    });
}

/** How far the focused card sits inside the screen's `edge` side, after a step that had to scroll. */
const insetAfterScroll = (tv: Tv, edge: "left" | "right"): Promise<number> => tv.page.evaluate(edgeName => {
    const card = document.activeElement?.getBoundingClientRect();
    if (card === undefined) return Number.NaN;
    return edgeName === "left" ? card.left : 1920 - card.right;
}, edge);

for (const [language, key, edge] of [["ar", LEFT, "left"], ["en", RIGHT, "right"]] as const) {
    test(`${language === "ar" ? "in Arabic" : "in English"} a row keeps the card Apple's 80 px inside its end edge as ${key === LEFT ? "Left" : "Right"} scrolls it`, async () => {
        await withHome(language === "ar" ? { stored: "ar" } : {}, async tv => {
            if (language === "ar") await waitForDirection(tv, "rtl");
            const cards = tv.page.locator('[data-section="recent/12"] [data-focus]');
            await cards.first().focus();
            // A card well inside the row, so the end of the row's scroll range does not limit the reveal.
            for (let step = 0; step < 9; step++) await tv.remote(key);
            const inset = await insetAfterScroll(tv, edge);
            assert.ok(Math.abs(inset - 80) <= 1, `card ${inset} px inside the ${edge} edge`);
        });
    });
}

/** Arabic Details for the series with `seasons` seasons of `episodes` episodes each, on the first season's page. */
async function withArabicSeries(seasons: number, episodes: number, body: (tv: Tv) => Promise<void>): Promise<void> {
    const tv = await openTv(browser, { app: "browse", locale: "en-AU" });
    const details = new FakeDetails();
    tv.fake.catalog = details;
    const settings = new FakeSettings(tv.fake);
    settings.revision = 28;
    settings.profile().set(APP_LANGUAGE_KEY, "ar");
    try {
        const listed = details.route("GET", "/catalog/series/series%3As1/seasons", "p-owner")?.body as { items: Record<string, unknown>[] };
        const first = details.route("GET", "/catalog/series/series%3As1/seasons/1/episodes", "p-owner")?.body as { items: Record<string, unknown>[] };
        await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons?**", route => route.fulfill({ json: { items: Array.from({ length: seasons }, (_, index) => ({ ...listed.items[0], content_id: `season:${index + 1}`, season_number: index + 1, title: `Season ${index + 1}` })), next_cursor: null } }));
        await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons/*/episodes?**", route => {
            const number = Number(/seasons\/(\d+)\/episodes/.exec(route.request().url())?.[1]);
            return route.fulfill({ json: { items: Array.from({ length: episodes }, (_, index) => ({ ...first.items[0], content_id: `episode:rail:${number}:${index}`, season_number: number, episode_number: index + 1 })), next_cursor: null } });
        });
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount());
        await waitForDirection(tv, "rtl");
        await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
        await tv.page.locator('[data-focus="episode:rail:1:0"]').waitFor();
        await body(tv);
    } finally { await tv.page.context().close(); }
}

const onScreen = (tv: Tv): Promise<{ left: number; right: number } | undefined> => tv.page.evaluate(() => { const rect = document.activeElement?.getBoundingClientRect(); return rect === undefined ? undefined : { left: rect.left, right: rect.right }; });

test("in Arabic Left walks a Details episode rail to its last episode and keeps each card on screen", async () => {
    await withArabicSeries(1, 12, async tv => {
        await tv.page.locator('[data-focus="episode:rail:1:0"]').focus();
        for (let step = 1; step < 12; step++) {
            await tv.remote(LEFT);
            const card = await onScreen(tv);
            assert.equal(await tv.focused(), `episode:rail:1:${step}`);
            const row = await tv.page.locator(".details-episodes").evaluate(node => { const style = getComputedStyle(node); return { sl: node.scrollLeft, sw: node.scrollWidth, cw: node.clientWidth, pl: style.paddingLeft, pr: style.paddingRight, ml: style.marginLeft, mr: style.marginRight, rect: node.getBoundingClientRect().left + ".." + node.getBoundingClientRect().right }; });
            assert.ok(card !== undefined && card.left >= 0 && card.right <= 1920, `episode ${step} at ${card?.left}..${card?.right}`);
        }
        for (let step = 0; step < 11; step++) await tv.remote(RIGHT);
        assert.equal(await tv.focused(), "episode:rail:1:0");
        const back = await onScreen(tv);
        assert.ok(back !== undefined && back.left >= 0 && back.right <= 1920, `episode 0 back at ${back?.left}..${back?.right}`);
    });
});

test("in Arabic the selected season pill is brought on screen when it is picked, with 16 seasons", async () => {
    await withArabicSeries(16, 3, async tv => {
        const pills = tv.page.locator(".details-season-chips .browse-button");
        assert.equal(await pills.count(), 16);
        await pills.first().focus();
        for (let step = 1; step < 16; step++) await tv.remote(LEFT);
        const last = await onScreen(tv);
        assert.ok(last !== undefined && last.left >= 0 && last.right <= 1920, `pill 16 at ${last?.left}..${last?.right}`);
        // Select it: the picked pill is the one the rail centres (TVSeriesDetailView).
        await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => await tv.page.locator('.details-season-chips .browse-button[aria-pressed="true"]').innerText() === "Season 16", "Season 16 picked");
        await tv.page.locator('[data-focus="episode:rail:16:0"]').waitFor();
        const picked = await tv.page.locator('.details-season-chips .browse-button[aria-pressed="true"]').evaluate(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right }; });
        assert.ok(picked.left >= 0 && picked.right <= 1920, `picked pill at ${picked.left}..${picked.right}`);
    });
});

test("a screen opened over Arabic browse (Add Profile, Switch Server) keeps the mirrored page, as on Apple TV", async () => {
    await withHome({ stored: "ar", switchServer: true }, async tv => {
        await waitForDirection(tv, "rtl");
        await tv.page.locator('[data-focus="profiles"]').focus();
        await tv.remote(DOWN);
        await tv.page.locator('.skyline-selector [data-focus="switch-server"]').click();
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.coverBack !== undefined), "the covering screen opened");
        assert.equal(await direction(tv), "rtl", "browse covered: the page stays right to left");
        await tv.page.evaluate(() => window.browseHarness.coverBack?.());
        await tv.page.locator('[data-view="home"]').waitFor();
        assert.equal(await direction(tv), "rtl");
    });
});

test("in Arabic the views that are not mirrored yet stay left to right under a mirrored top bar, and read the remote that way", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        const directions = (): Promise<{ view: string | null; bar: string; content: string[] }> => tv.page.evaluate(() => ({
            view: document.querySelector("[data-view]")?.getAttribute("data-view") ?? null,
            bar: getComputedStyle(document.querySelector(".browse-nav") ?? document.documentElement).direction,
            content: Array.from(document.querySelectorAll("[data-view] > :not(.browse-nav, .skyline-selector, .skyline-dropdown-scrim, .skyline-leaving, .skyline-marquee)")).map(node => getComputedStyle(node).direction),
        }));
        const home = await directions();
        assert.equal(home.view, "home");
        assert.ok(home.content.length > 0 && home.content.every(direction => direction === "rtl"), `Home ${home.content}`);
        await tv.page.locator('[data-focus="search"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.locator('[data-view="search"]').waitFor();
        const search = await directions();
        assert.equal(search.bar, "rtl", "the top bar stays mirrored");
        assert.ok(search.content.length > 0 && search.content.every(direction => direction === "ltr"), `Search ${search.content}`);
        // A key pressed in a pinned view is read left to right: Right on the field is Right.
        assert.equal(await tv.page.evaluate(() => {
            const field = document.querySelector('[data-view="search"] input') as HTMLElement;
            return field.closest("[dir]")?.getAttribute("dir");
        }), "ltr");
        await tv.remote(BACK);
        await tv.page.locator('[data-view="home"]').waitFor();
        assert.ok((await directions()).content.every(direction => direction === "rtl"), "Home is mirrored again");
    });
});

for (const [language, options, step] of [["ar", { stored: "ar" }, LEFT], ["en", {}, RIGHT]] as const) {
    test(`${language === "ar" ? "in Arabic" : "in English"} a library's Browse grid reads ${language === "ar" ? "right to left, with its letter rail on the left" : "left to right, with its letter rail on the right"}, and ${language === "ar" ? "Left" : "Right"} at the last column enters the rail (TVLibraryGridView.swift:100-108)`, async () => {
        await withHome(options, async tv => {
            if (language === "ar") await waitForDirection(tv, "rtl");
            await tv.page.locator('[data-focus="movies"]').click();
            await tv.page.locator('[data-view="library:12"] .home-section').first().waitFor();
            await selectLibraryMode(tv, "Browse");
            const cards = tv.page.locator(".browse-grid [data-focus]");
            await cards.first().waitFor();
            const columns = await cards.evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().top === nodes[0]?.getBoundingClientRect().top).length);
            assert.ok(columns > 1, `${columns} columns`);
            const rail = await box(tv, ".browse-letters");
            const first = await box(tv, ".browse-grid [data-focus] >> nth=0");
            if (language === "ar") {
                assert.ok(rail.right < 960, `the rail is on the left (${rail.left}..${rail.right})`);
                assert.ok(first.left > 960, `the first card is on the right (${first.left})`);
                assert.ok(Math.abs(first.right - (1920 - 55)) <= 2, `the grid mirrors English's 55 px edge: first card ends at ${first.right}`);
            } else {
                assert.ok(rail.left > 960, `the rail is on the right (${rail.left}..${rail.right})`);
                assert.ok(first.right < 960, `the first card is on the left (${first.right})`);
                assert.ok(Math.abs(first.left - 55) <= 2, `the first card starts at ${first.left}`);
            }
            await cards.first().focus();
            for (let move = 0; move < columns - 1; move++) await tv.remote(step);
            assert.equal(await tv.page.evaluate(() => document.activeElement?.closest(".browse-grid") !== null), true, "the move walks the row to its last column");
            await tv.remote(step);
            assert.match(await tv.focused() ?? "", /^letter:/, "one more enters the letter rail");
            // The top bar is part of this view's content but is not the library's: it stays mirrored above the grid.
            const bar = await tv.page.evaluate(() => getComputedStyle(document.querySelector(".browse-nav") as Element).direction);
            assert.equal(bar, language === "ar" ? "rtl" : "ltr");
            if (language === "ar") {
                await tv.page.locator('[data-focus="home"]').focus();
                await tv.remote(LEFT);
                assert.equal(await tv.focused(), "movies", "Left in the mirrored top bar moves to the tab on its left");
            }
        });
    });
}

test("Change Account, opened from the profile menu in a right-to-left page, is mirrored as on Apple TV", async () => {
    await withSignedInTv(browser, async tv => {
        // The page direction is set by hand: the account screens are what is under test, not the language.
        await tv.page.evaluate(() => document.documentElement.setAttribute("dir", "rtl"));
        await openChangeAccount(tv);
        const screen = await tv.page.evaluate(() => ({
            direction: getComputedStyle(document.querySelector('[data-view="change-account"] .accounts-screen') ?? document.body).direction,
            rail: document.querySelector(".accounts-rail")?.getBoundingClientRect().left ?? Number.NaN,
            pane: document.querySelector(".accounts-pane")?.getBoundingClientRect().left ?? Number.NaN,
        }));
        assert.equal(screen.direction, "rtl");
        assert.ok(screen.rail > screen.pane, `the server rail leads on the right (${screen.rail} vs ${screen.pane})`);
    });
});

for (const [language, options] of [["ar", { stored: "ar" }], ["en", {}]] as const) {
    test(`${language === "ar" ? "in Arabic" : "in English"} Details' compressed text title keeps its edge on the column's leading side`, async () => {
        await withHome(options, async tv => {
            if (language === "ar") await waitForDirection(tv, "rtl");
            await tv.page.locator('[data-section="recent/12"] [data-focus]').nth(1).focus();
            await tv.page.keyboard.press("Enter");
            await tv.page.locator(".details-editorial .requests-title-primary").waitFor();
            const edges = await tv.page.evaluate(() => {
                const title = document.querySelector(".details-editorial .requests-title-primary")?.getBoundingClientRect();
                const column = document.querySelector(".details-editorial")?.getBoundingClientRect();
                return title === undefined || column === undefined ? undefined : { title: { left: title.left, right: title.right }, column: { left: column.left, right: column.right } };
            });
            assert.ok(edges !== undefined);
            if (language === "ar") assert.ok(Math.abs(edges.title.right - edges.column.right) <= 2, `title right ${edges.title.right}, column right ${edges.column.right}`);
            else assert.ok(Math.abs(edges.title.left - edges.column.left) <= 2, `title left ${edges.title.left}, column left ${edges.column.left}`);
        });
    });
}

test("in Arabic every layer of the hero artwork fades toward the text, which is on the right, and in English toward the left", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        // The artwork layers Details draws (heroBackdrop.ts), built bare so the page's own stylesheet decides their masks.
        const masks = (): Promise<{ name: string; mask: string }[]> => tv.page.evaluate(() => {
            const hero = document.createElement("div");
            hero.className = "details-hero";
            hero.innerHTML = '<div class="skyline-art-frame hero-art-surface"><canvas class="hero-art-thumbhash"></canvas><img class="skyline-backdrop" alt=""><div class="hero-art-missing"></div></div>';
            document.body.append(hero);
            const frame = hero.querySelector(".hero-art-surface") as Element;
            const layers: [string, CSSStyleDeclaration][] = [["frame backing", getComputedStyle(frame, "::before")]];
            for (const [name, selector] of [["preview", ".hero-art-thumbhash"], ["image", ".skyline-backdrop"], ["missing", ".hero-art-missing"]] as const) layers.push([name, getComputedStyle(frame.querySelector(selector) as Element)]);
            const result = layers.map(([name, style]) => ({ name, mask: style.maskImage }));
            hero.remove();
            return result;
        });
        for (const layer of await masks()) assert.match(layer.mask, /to right/, `${layer.name}: ${layer.mask}`);
        await tv.page.evaluate(() => document.documentElement.removeAttribute("dir"));
        for (const layer of await masks()) assert.match(layer.mask, /to left/, `${layer.name}: ${layer.mask}`);
    });
});

test("the document's lang follows the shown language: ar for Arabic, and the default again for Match Device", async () => {
    await withHome({}, async tv => {
        const lang = (): Promise<string | null> => tv.page.evaluate(() => document.documentElement.getAttribute("lang"));
        assert.equal(await lang(), "en");
        await openSettings(tv);
        await tv.page.locator('[data-focus="app-language"]').click();
        await tv.page.getByRole("radio", { name: "العربية", exact: true }).click();
        await tv.eventually(async () => await lang() === "ar", "lang ar");
        await waitForDirection(tv, "rtl");
        // Match Device is the picker's first row; the TV's language here is English.
        await tv.page.locator('[data-focus="app-language"]').click();
        await tv.page.getByRole("radio").first().click();
        await tv.eventually(async () => await lang() === "en", "lang back to en");
        await waitForDirection(tv, null);
    });
});

test("in Arabic Left from season 1's first episode to season 2's last (Big Mood's S02E06) keeps every card on screen and shows season 2", async () => {
    await withArabicSeries(2, 6, async tv => {
        await tv.page.locator('[data-focus="episode:rail:1:0"]').focus();
        const trail: string[] = [];
        for (let step = 1; step < 12; step++) {
            await tv.remote(LEFT);
            await tv.eventually(async () => (await tv.focused())?.startsWith("episode:rail:") === true, "an episode has focus");
            const card = await onScreen(tv);
            trail.push(`${await tv.focused()} ${Math.round(card?.left ?? NaN)}..${Math.round(card?.right ?? NaN)}`);
            assert.ok(card !== undefined && card.left >= 0 && card.right <= 1920, trail.join(" | "));
        }
        assert.equal(await tv.focused(), "episode:rail:2:5", "the last episode, S02E06");
        const pressed = await tv.page.locator('.details-season-chips .browse-button[aria-pressed="true"]').innerText();
        assert.equal(pressed, "Season 2", "the season pills follow the focused episode");
    });
});

test("Change Account, over Arabic browse, is marked lang=en on its own root while the document says ar", async () => {
    await withSignedInTv(browser, async tv => {
        // The document's language is set by hand: the cover screen is what is under test, not the language.
        await tv.page.evaluate(() => { document.documentElement.setAttribute("lang", "ar"); document.documentElement.setAttribute("dir", "rtl"); });
        await openChangeAccount(tv);
        const langs = await tv.page.evaluate(() => ({
            document: document.documentElement.getAttribute("lang"),
            screen: document.querySelector('[data-view="change-account"]')?.getAttribute("lang") ?? null,
            direction: getComputedStyle(document.querySelector('[data-view="change-account"]') as Element).direction,
        }));
        assert.deepEqual(langs, { document: "ar", screen: "en", direction: "rtl" }, "English text, mirrored layout");
    });
});

test("the sign-in and profile screens (Add Profile among them) are marked lang=en while the document says ar", async () => {
    const tv = await openTv(browser);
    try {
        await tv.page.evaluate(() => { document.documentElement.setAttribute("lang", "ar"); document.documentElement.setAttribute("dir", "rtl"); });
        await tv.page.locator("section.signin-screen").first().waitFor();
        const langs = await tv.page.evaluate(() => Array.from(document.querySelectorAll("section.signin-screen")).map(node => node.getAttribute("lang")));
        assert.ok(langs.length > 0 && langs.every(lang => lang === "en"), JSON.stringify(langs));
    } finally { await tv.page.context().close(); }
});

test("in Arabic Home's artwork placeholder layers fade toward the text, like its loaded image", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        const masks = await tv.page.evaluate(() => {
            const home = document.querySelector(".skyline-home") as Element;
            const frame = document.createElement("div");
            frame.className = "skyline-art-frame hero-art-surface";
            frame.innerHTML = '<canvas class="hero-art-thumbhash"></canvas><img class="skyline-backdrop" alt=""><div class="hero-art-missing"></div>';
            home.append(frame);
            const layers: [string, CSSStyleDeclaration][] = [["frame backing", getComputedStyle(frame, "::before")]];
            for (const [name, selector] of [["preview", ".hero-art-thumbhash"], ["image", ".skyline-backdrop"], ["missing", ".hero-art-missing"]] as const) layers.push([name, getComputedStyle(frame.querySelector(selector) as Element)]);
            const result = layers.map(([name, style]) => ({ name, mask: style.maskImage }));
            frame.remove();
            return result;
        });
        for (const layer of masks) assert.match(layer.mask, /to right/, `${layer.name}: ${layer.mask}`);
    });
});

test("in Arabic an aspect-fitted title logo sits against the mirrored marquee's right edge", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        const position = await tv.page.evaluate(() => {
            const logo = document.createElement("img");
            logo.className = "skyline-logo";
            document.querySelector(".skyline-marquee")?.append(logo);
            const value = getComputedStyle(logo).objectPosition;
            logo.remove();
            return value;
        });
        assert.match(position, /^(100%|right)/, position);
    });
});

test("a Home shelf scrolled in Arabic keeps its card on screen when the server's English overrules the kept language", async () => {
    await withHome({ cached: "ar", stored: "en", holdLanguage: true }, async (tv, releaseLanguage) => {
        await waitForDirection(tv, "rtl");
        const cards = tv.page.locator('[data-section="recent/12"] [data-focus]');
        await cards.first().focus();
        for (let step = 0; step < 9; step++) await tv.remote(LEFT);
        const before = await tv.focused();
        releaseLanguage();
        await waitForDirection(tv, null);
        await tv.eventually(async () => await tv.focused() === before, "focus stays on the viewer's card");
        const card = await onScreen(tv);
        assert.ok(card !== undefined && card.left >= 0 && card.right <= 1920, `${before} at ${card?.left}..${card?.right}`);
    });
});

/** True when the words of `text` read in the order written: the leading number is left of the first word, as on Apple TV. */
const readsAsWritten = (tv: Tv, selector: string, number: string, word: string): Promise<{ text: string; unicodeBidi: string; textAlign: string; asWritten: boolean } | undefined> => tv.page.evaluate(([css, first, second]) => {
    // Details draws its title in capitals, so the words are matched without case.
    const has = (node: Node): boolean => node.textContent?.toLowerCase().includes((second as string).toLowerCase()) === true;
    // The element that holds the words itself, not one of its ancestors in the list.
    const owner = (node: Element): ChildNode | undefined => Array.from(node.childNodes).find(child => child.nodeType === Node.TEXT_NODE && has(child));
    const element = Array.from(document.querySelectorAll(css as string)).find(node => owner(node) !== undefined);
    const text = element === undefined ? undefined : owner(element);
    if (element === undefined || text === undefined) return undefined;
    const content = (text.textContent ?? "").toLowerCase();
    const rect = (from: number, length: number): DOMRect => { const range = document.createRange(); range.setStart(text, from); range.setEnd(text, from + length); return range.getBoundingClientRect(); };
    const numberAt = content.indexOf(first as string), wordAt = content.indexOf((second as string).toLowerCase());
    return { text: text.textContent ?? "", unicodeBidi: getComputedStyle(element).unicodeBidi, textAlign: getComputedStyle(element).textAlign, asWritten: rect(numberAt, (first as string).length).left < rect(wordAt, (second as string).length).left };
}, [selector, number, word] as const);

test("in Arabic a server title that starts with a number keeps its words in the order written, on Home, Details and Search", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeHome();
    const movie = catalog.titles.get("movie:m0004");
    assert.ok(movie);
    catalog.titles.set(movie.id, { ...movie, title: "10 Cloverfield Lane" });
    tv.fake.catalog = catalog;
    const settings = new FakeSettings(tv.fake);
    settings.revision = 28;
    settings.profile().set(APP_LANGUAGE_KEY, "ar");
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount(true));
        await tv.page.locator('[data-view="home"]').waitFor();
        await waitForDirection(tv, "rtl");

        // Search is not mirrored yet: its content is pinned left to right, where the words read as written without isolation.
        const check = async (where: string, selector: string, pinned = false): Promise<void> => {
            let found: Awaited<ReturnType<typeof readsAsWritten>>;
            await tv.eventually(async () => { found = await readsAsWritten(tv, selector, "10", "Cloverfield"); return found !== undefined; }, `${where}: the title is drawn`);
            assert.ok(found?.asWritten, `${where}: "${found?.text}" reads reordered`);
            if (pinned) return;
            assert.match(found?.unicodeBidi ?? "", /plaintext/, `${where}: the title takes its direction from its own first letter`);
            // Apple aligns by the layout, not by the letters: a Latin title in Arabic sits on the right or is centred, never pushed to the left.
            assert.match(found?.textAlign ?? "", /^(right|center)$/, `${where}: the line is aligned by the layout, not by its letters`);
        };
        await check("Home card", '[data-section="recent/12"] .browse-card-title');
        await check("Home hero", ".skyline-title");

        await tv.page.locator('[data-section="recent/12"] [data-focus="movie:m0004"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.locator('[data-view^="item:"]').waitFor();
        await check("Details", ".details-editorial .requests-title-primary, .details-editorial .browse-title");
        await tv.remote(BACK);
        await tv.page.locator('[data-view="home"]').waitFor();

        await tv.page.locator('[data-focus="search"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.locator("#browse-search").waitFor();
        await tv.page.fill("#browse-search", "Cloverfield");
        await tv.remote(65376);
        await check("Search", '[data-view="search"] .browse-card-title', true);
        await tv.remote(BACK);
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.page.locator('[data-focus="movies"]').click();
        await tv.page.locator('[data-view="library:12"] .home-section').first().waitFor();
        await selectLibraryMode(tv, "Browse");
        await check("Browse", ".browse-grid .browse-card-title");
    } finally { await tv.page.context().close(); }
});

test("in Arabic a library, profile or person name that starts with a number keeps its words in order in the menus and on Settings", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeHome();
    const library = catalog.households.get("p-owner")?.libraries.find(item => item.id === "12");
    assert.ok(library);
    library.name = "4K Movies";
    tv.fake.catalog = catalog;
    const settings = new FakeSettings(tv.fake);
    settings.revision = 28;
    settings.profile().set(APP_LANGUAGE_KEY, "ar");
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount(true));
        await tv.page.locator('[data-view="home"]').waitFor();
        await waitForDirection(tv, "rtl");
        await tv.page.locator('[data-focus="movies"]').focus();
        await tv.remote(DOWN);
        await tv.eventually(async () => await readsAsWritten(tv, ".skyline-menu-label", "4k", "Movies") !== undefined, "the library menu is drawn");
        const menu = await readsAsWritten(tv, ".skyline-menu-label", "4k", "Movies");
        assert.ok(menu?.asWritten, `"${menu?.text}" reads reordered in the library menu`);
        assert.match(menu?.unicodeBidi ?? "", /plaintext/);
        // Profile, Settings and person names share the same rule: their classes take the same isolation.
        const isolated = await tv.page.evaluate(() => [".skyline-profile-title", ".settings-profile-name", ".collection-detail-title", ".details-person-hero .browse-title"].map(selector => {
            const holder = document.createElement("div");
            holder.innerHTML = selector.includes("details-person-hero") ? '<div class="details-person-hero"><h1 class="browse-title">2 Fast</h1></div>' : `<span class="${selector.slice(1)}">2 Fast</span>`;
            document.body.append(holder);
            const style = getComputedStyle(holder.querySelector(selector) as Element);
            const result = { selector, bidi: style.unicodeBidi, align: style.textAlign };
            holder.remove();
            return result;
        }));
        for (const item of isolated) assert.match(item.bidi, /plaintext/, `${item.selector}: ${item.bidi}`);
    } finally { await tv.page.context().close(); }
});

test("in Arabic Search's People rail still lands Down on the title column at or past that person (the second person on the third poster)", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        // People for the query, as browse.test.ts's Search fixtures serve them.
        await tv.page.route("**/api/v2/catalog/people**", route => route.fulfill({ json: { items: Array.from({ length: 20 }, (_, index) => ({ id: `edge-${index}`, name: `Person ${index + 1}` })) } }));
        await tv.page.locator('[data-focus="search"]').click();
        await tv.page.fill("#browse-search", "Movie 000");
        await tv.remote(65376);
        await tv.page.locator('.browse-grid [data-focus="movie:m0002"]').waitFor();
        await tv.page.locator('[data-focus="person:edge-1"]').focus();
        await tv.remote(DOWN);
        assert.equal(await tv.focused(), "movie:m0003", "the second person lands on the third poster, as in English");
    });
});
