import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { createServer } from "node:http";
import { once } from "node:events";
import { build } from "esbuild";
import { FakeCalendar } from "../native/support/fakeCalendar.ts";
import { FakeHome } from "../native/support/fakeHome.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { type SettingsKey, HIDDEN_KEY, TITLE_ART_KEY } from "../../src/contracts/v2/settings.ts";

const CARD_OVERLAYS_KEY = "ui.card_overlays" as SettingsKey;
const CARD_OVERLAYS_ENABLED_KEY = "ui.card_overlays_enabled" as SettingsKey;
const CARD_PRESENTATION_KEY = "ui.card_presentation" as SettingsKey;
import { detailReads, homeDetailsRead, launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

/** Every distinct title Home drew. */
const homeTitles = (tv: Tv): Promise<string[]> => tv.page.locator('[data-view="home"] [data-section] .browse-card:not(.skyline-explore)').evaluateAll(nodes => [...new Set(nodes.map(node => node.getAttribute("data-focus") ?? ""))]);
const detailsRead = homeDetailsRead;

function sectionReplyProduced(catalog: FakeHome): Promise<void> {
    return new Promise(resolve => {
        const read = catalog.route.bind(catalog);
        catalog.route = (method, path, profile, body) => {
            const reply = read(method, path, profile, body);
            if (path.startsWith("/catalog/query")) resolve();
            return reply;
        };
    });
}

function journey(name: string, body: (tv: Tv, catalog: FakeHome) => Promise<void>, setup?: (catalog: FakeHome) => void, settings?: (settings: FakeSettings, tv: Tv) => void, options: { readonly whileReading?: boolean; readonly beforeMount?: (tv: Tv) => void; readonly beforeReady?: (tv: Tv) => Promise<void>; readonly readyTimeout?: number } = {}): void {
    test(name, async () => {
        const tv = await openTv(browser, { app: "browse" });
        const catalog = new FakeHome();
        setup?.(catalog);
        tv.fake.catalog = catalog;
        if (settings !== undefined) settings(new FakeSettings(tv.fake), tv);
        try {
            await tv.page.emulateMedia({ reducedMotion: "reduce" });
            await tv.page.evaluate(() => window.browseHarness.connect());
            await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
            tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
            await tv.jump(5000);
            await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase) === "signed_in", "sign in");
            await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
            options.beforeMount?.(tv);
            await tv.page.evaluate(() => window.browseHarness.mount());
            if (options.beforeReady !== undefined) await options.beforeReady(tv);
            await tv.page.locator('[data-view="home"] [data-section]').first().waitFor(options.readyTimeout === undefined ? undefined : { timeout: options.readyTimeout });
            // Home reads detail for its titles as it loads; journeys start once those reads are out.
            if (options.whileReading !== true) await detailsRead(tv);
            await body(tv, catalog);
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}

let heldLibraries: { release(): void };
let heldSections: { release(): void };

journey("Home paints its rows while libraries are still out and does not say it is still waiting", async tv => {
    assert.equal(await tv.page.locator('[data-section="recent/12"]').count(), 1);
    assert.equal(await tv.page.getByText("Still waiting for the server.", { exact: true }).count(), 0);
    assert.equal(await tv.page.locator('[data-focus="movies"]').count(), 0, "library tabs wait for their own read");
    heldLibraries.release();
    await tv.eventually(async () => await tv.page.locator('[data-focus="movies"]').count() === 1, "library tabs follow the rows");
}, undefined, undefined, { beforeMount: tv => { heldLibraries = tv.fake.hold("/user/libraries", true); }, readyTimeout: 4000 });

let heldCalendarLibraries: { release(): void };
const focusPlace = (tv: Tv) => tv.page.evaluate(() => ({ key: document.activeElement?.getAttribute("data-focus") ?? null, connected: document.activeElement?.isConnected === true }));
journey("library tabs that arrive on Calendar keep Up on the new bar", async tv => {
    assert.equal(await tv.page.locator('[data-focus="movies"]').count(), 0);
    await tv.page.locator('[data-focus="calendar"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await tv.page.locator('.browse[data-view="calendar"] [data-focus="filter:following"]').count() === 1 && await tv.page.locator('.browse[data-view="calendar"] [data-focus="previous-week"]').count() === 1 && await tv.page.getByText("Loading the week.", { exact: true }).count() === 0, "Calendar settled");
    // The week chevron (`previous-week`) used to be the first focusable, and Up from it was expected to land on `calendar`.
    // That press now stops on the filter row (`filter:following`); the bar is the next Up from there.
    await tv.page.locator('[data-focus="filter:following"]').focus();
    heldCalendarLibraries.release();
    await tv.eventually(async () => await tv.page.locator('.browse-nav [data-focus="movies"]').count() === 1, "library tabs on Calendar");
    assert.deepEqual(await focusPlace(tv), { key: "filter:following", connected: true }, "late tabs leave focus on the filter row");
    await tv.page.keyboard.press("ArrowUp");
    assert.deepEqual(await focusPlace(tv), { key: "calendar", connected: true }, "Up from the filter row reaches Calendar; the old assertion expected calendar from previous-week");
}, undefined, undefined, { beforeMount: tv => { heldCalendarLibraries = tv.fake.hold("/user/libraries", true); }, readyTimeout: 4000 });

journey("Up from Calendar's filter row reaches the Calendar tab when library tabs are already on the bar", async tv => {
    await tv.eventually(async () => await tv.page.locator('.browse-nav [data-focus="movies"]').count() === 1, "library tabs before Calendar");
    await tv.page.locator('[data-focus="calendar"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await tv.page.locator('.browse[data-view="calendar"] [data-focus="filter:following"]').count() === 1 && await tv.page.getByText("Loading the week.", { exact: true }).count() === 0, "Calendar settled");
    await tv.page.locator('[data-focus="filter:following"]').focus();
    await tv.page.keyboard.press("ArrowUp");
    assert.deepEqual(await focusPlace(tv), { key: "calendar", connected: true });
});

let heldStaleLibraries: { release(): void };
let hiddenLibrarySettings: FakeSettings;
journey("a delayed Home libraries read cannot remove a library restored in Settings", async tv => {
    assert.equal(await tv.page.locator('[data-focus="movies"]').count(), 0);
    await tv.eventually(async () => tv.fake.requests.some(request => request.path.includes("ui.disabled_library_ids")), "initial hidden-libraries read");
    await tv.page.locator('[data-focus="calendar"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await tv.page.locator('.browse[data-view="calendar"] [data-focus="previous-week"]').count() === 1 && await tv.page.getByText("Loading the week.", { exact: true }).count() === 0, "Calendar settled");
    await tv.page.locator('[data-focus="profiles"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await tv.page.locator('[data-focus="server"]').click();
    await tv.page.locator('[data-focus="restore-libraries"]').click();
    await tv.eventually(async () => JSON.stringify(hiddenLibrarySettings.profile().get(HIDDEN_KEY)) === "[]", "library visibility restored");
    await tv.page.getByText("Saving…", { exact: true }).waitFor({ state: "hidden" });
    for (let step = 0; step < 4 && await tv.page.locator(".settings").count() > 0; step++) await tv.remote(10009);
    assert.equal(await tv.page.locator(".settings").count(), 0);
    assert.equal(await tv.page.locator('.browse[data-view="calendar"]').count(), 1);
    await tv.eventually(async () => await tv.page.locator('[data-focus="series"]').count() === 1 && await tv.page.locator('[data-focus="movies"]').count() === 1, "Calendar refresh restored libraries");
    heldStaleLibraries.release();
    const deadline = performance.now() + 1500;
    do {
        assert.equal(await tv.page.locator('[data-focus="series"]').count(), 1, "the delayed Home libraries read removed restored Series");
        await tv.page.evaluate(() => undefined);
    } while (performance.now() < deadline);
    assert.equal(await tv.page.locator('[data-focus="series"]').count(), 1);
}, catalog => {
    const calendar = new FakeCalendar();
    const read = catalog.route.bind(catalog);
    catalog.route = (method, path, profile, body) => path.startsWith("/calendar") ? calendar.route(method, path, profile, body) : read(method, path, profile, body);
}, settings => {
    hiddenLibrarySettings = settings;
    settings.profile().set(HIDDEN_KEY, [15]);
}, { beforeMount: tv => { heldStaleLibraries = tv.fake.hold("/user/libraries", true); }, readyTimeout: 4000 });

journey("a failed libraries read keeps Home and retries the tabs after the app returns", async tv => {
    const libraryReads = (): number => tv.fake.requests.filter(request => request.path === "/user/libraries").length;
    assert.equal(await tv.page.locator('[data-section="recent/12"]').count(), 1);
    await tv.jump(1000);
    await tv.eventually(async () => libraryReads() >= 2, "libraries read exhausted its retry");
    assert.equal(await tv.page.locator('[data-focus="movies"]').count(), 0);
    await tv.page.locator('[data-focus="calendar"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await tv.page.locator('.browse[data-view="calendar"]').count() === 1, "left Home");
    await tv.page.locator('[data-focus="home"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await tv.page.locator('.browse[data-view="home"] [data-section="recent/12"]').count() === 1, "Home again");
    assert.equal(libraryReads(), 2, "leaving Home and returning does not reread libraries");
    assert.equal(await tv.page.locator('[data-focus="movies"]').count(), 0);
    await tv.page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        document.dispatchEvent(new Event("visibilitychange"));
        Object.defineProperty(document, "hidden", { configurable: true, value: false });
        document.dispatchEvent(new Event("visibilitychange"));
    });
    await tv.eventually(async () => await tv.page.locator('[data-focus="movies"]').count() === 1, "library tabs after returning to the app");
    assert.equal(await tv.page.locator('[data-section="recent/12"]').count(), 1);
    assert.ok(libraryReads() > 2);
}, catalog => {
    catalog.failNext("/user/libraries", problem(503, "service_unavailable", "Unavailable"), problem(503, "service_unavailable", "Unavailable"));
});

journey("a failed libraries read after returning to a profile keeps that profile's Movies and Series", async (tv, catalog) => {
    const libraryReads = (): number => tv.fake.requests.filter(request => request.path === "/user/libraries").length;
    await tv.eventually(async () => await tv.page.locator('[data-focus="movies"]').count() === 1 && await tv.page.locator('[data-focus="series"]').count() === 1, "owner library tabs");
    const before = libraryReads();
    catalog.failNext("/user/libraries", problem(503, "service_unavailable", "Unavailable"), problem(503, "service_unavailable", "Unavailable"));
    await tv.page.evaluate(() => window.browseHarness.clearProfile());
    assert.equal(await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner")), "selected");
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.eventually(async () => await tv.page.locator('.browse[data-view="home"] [data-section="recent/12"]').count() === 1, "rows after returning");
    await tv.jump(1000);
    await tv.eventually(async () => libraryReads() >= before + 2, "libraries read exhausted its retry");
    assert.equal(libraryReads(), before + 2, "the failed read is not followed by a successful one");
    assert.equal(await tv.page.locator('[data-focus="movies"]').count(), 1);
    assert.equal(await tv.page.locator('[data-focus="series"]').count(), 1);
    assert.equal(await tv.page.locator('[data-section="recent/12"]').count(), 1);
    assert.equal(await tv.page.getByText("Still waiting for the server.", { exact: true }).count(), 0);
    assert.equal(await tv.page.locator('[data-view="home"] [role="alert"]').count(), 0);
});

journey("a failed libraries read after switching to a restricted profile drops the previous profile's Series", async (tv, catalog) => {
    const libraryReads = (): number => tv.fake.requests.filter(request => request.path === "/user/libraries").length;
    await tv.eventually(async () => await tv.page.locator('[data-focus="series"]').count() === 1, "owner Series tab");
    const before = libraryReads();
    catalog.failNext("/user/libraries", problem(503, "service_unavailable", "Unavailable"), problem(503, "service_unavailable", "Unavailable"));
    await tv.page.evaluate(() => window.browseHarness.clearProfile());
    assert.equal(await tv.page.evaluate(() => window.browseHarness.selectProfile("p-kid", "2468")), "verified");
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.eventually(async () => await tv.page.locator('.browse[data-view="home"] [data-section="kids_picks"]').count() === 1, "restricted profile rows");
    await tv.jump(1000);
    await tv.eventually(async () => libraryReads() >= before + 2, "libraries read exhausted its retry");
    assert.equal(libraryReads(), before + 2);
    assert.equal(await tv.page.locator('[data-focus="series"]').count(), 0, "the previous profile's Series stays off the bar");
    assert.equal(await tv.page.locator('[data-focus="movies"]').count(), 0, "this profile has no last-known tabs to keep");
    assert.equal(await tv.page.locator('[data-section="kids_picks"]').count(), 1);
    assert.equal(await tv.page.getByText("Still waiting for the server.", { exact: true }).count(), 0);
    assert.equal(await tv.page.locator('[data-view="home"] [role="alert"]').count(), 0);
});

journey("a delayed Home sections read never says it is still waiting", async tv => {
    assert.equal(await tv.page.locator('[data-section="recent/12"]').count(), 1);
    assert.equal(await tv.page.getByText("Still waiting for the server.", { exact: true }).count(), 0);
}, undefined, undefined, {
    beforeMount: tv => { heldSections = tv.fake.hold("/home/sections", true); },
    beforeReady: async tv => {
        await tv.jump(5000);
        assert.equal(await tv.page.getByText("Still waiting for the server.", { exact: true }).count(), 0);
        heldSections.release();
    },
});

let heldLoadingFocus: { release(): void };
journey("Loading home holds focus on the blank page, and Up and Back reach the bar before the rows do", async tv => {
    const landed = await tv.page.evaluate(() => ({ key: document.activeElement?.getAttribute("data-focus"), connected: document.activeElement?.isConnected === true }));
    assert.deepEqual(landed, { key: "movie:m0004", connected: true });
}, undefined, undefined, {
    beforeMount: tv => { heldLoadingFocus = tv.fake.hold("/home/sections", true); },
    beforeReady: async tv => {
        await tv.eventually(async () => await tv.focused() === "loading", "blank Loading home owns focus");
        assert.equal(await tv.page.locator('[aria-label="Loading home"]').count(), 1);
        await tv.page.keyboard.press("ArrowLeft");
        await tv.page.keyboard.press("ArrowRight");
        await tv.page.keyboard.press("Enter");
        assert.equal(await tv.focused(), "loading", "Left, Right and Enter stay on the blank page");
        await tv.page.keyboard.press("ArrowUp");
        assert.equal(await tv.focused(), "home");
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "loading");
        await tv.remote(10009);
        assert.equal(await tv.focused(), "home", "Back from the blank page lands on Home");
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "loading");
        heldLoadingFocus.release();
    },
    readyTimeout: 4000,
});

let heldBarFocus: { release(): void };
journey("Home rows that arrive while the bar is focused leave focus on Home", async tv => {
    const landed = await tv.page.evaluate(() => ({ key: document.activeElement?.getAttribute("data-focus"), connected: document.activeElement?.isConnected === true }));
    assert.deepEqual(landed, { key: "home", connected: true });
    assert.equal(await tv.page.locator('[data-section="recent/12"]').count(), 1);
}, undefined, undefined, {
    beforeMount: tv => { heldBarFocus = tv.fake.hold("/home/sections", true); },
    beforeReady: async tv => {
        await tv.eventually(async () => await tv.focused() === "loading", "blank page before the rows");
        await tv.page.keyboard.press("ArrowUp");
        assert.equal(await tv.focused(), "home");
        heldBarFocus.release();
    },
    readyTimeout: 4000,
});

let heldHomeLoading: { release(): void };
journey("while Home sections are out, the page is an empty Loading home and the library tabs are already up", async tv => {
    assert.equal(await tv.page.locator('[data-section="recent/12"]').count(), 1);
    assert.equal(await tv.page.locator('[aria-label="Loading home"]').count(), 0);
    assert.equal(await tv.page.locator(".skyline-content").getByRole("heading", { name: "Loading", exact: true }).count(), 0);
}, undefined, undefined, {
    beforeMount: tv => { heldHomeLoading = tv.fake.hold("/home/sections", true); },
    beforeReady: async tv => {
        await tv.eventually(async () => await tv.page.locator('[aria-label="Loading home"]').count() === 1, "empty Loading home page");
        assert.equal(await tv.page.locator(".skyline-content").getByRole("heading", { name: "Loading", exact: true }).count(), 0);
        assert.equal(await tv.page.locator(".skyline-content").getByRole("button", { name: "Profiles", exact: true }).count(), 0);
        assert.equal(await tv.page.getByText("Still waiting for the server.", { exact: true }).count(), 0);
        await tv.eventually(async () => await tv.page.locator('[data-focus="movies"]').count() === 1, "library tabs while Home is still loading");
        heldHomeLoading.release();
    },
    readyTimeout: 4000,
});

journey("Home asks for the server's row cap and does not wait on an uncapped sections read", async tv => {
    assert.equal(await tv.page.locator('[data-section="recent/12"]').count(), 1);
    assert.equal(await tv.page.getByText("Still waiting for the server.", { exact: true }).count(), 0);
    const sections = tv.fake.requests.filter(request => request.path.startsWith("/home/sections")).map(request => request.path);
    assert.ok(sections.some(path => path.includes("item_limit=20")), sections.join(" "));
    assert.equal(sections.filter(path => !path.includes("item_limit=")).length, 0, sections.join(" "));
}, catalog => {
    const read = catalog.route.bind(catalog);
    catalog.route = (method, path, profile, body) => {
        const url = new URL(path, "https://fake.invalid");
        if (url.pathname === "/home/capabilities") return { status: 200, body: { state: "available", section_item_limit_max: 100 } };
        return read(method, path, profile, body);
    };
}, undefined, {
    beforeMount: tv => {
        // image_size=small was the list size before sharp Home artwork. Cold Home now asks for large.
        tv.fake.hold("/home/sections?image_size=large", true);
        tv.fake.hold("/home/sections?image_size=large", true);
    },
    readyTimeout: 4000,
});

journey("Home reads sections again without the row cap when the server rejects it", async tv => {
    assert.equal(await tv.page.locator('[data-section="recent/12"]').count(), 1);
    const sections = tv.fake.requests.filter(request => request.path.startsWith("/home/sections")).map(request => request.path);
    // image_size=small was the list size before sharp Home artwork. Cold Home now asks for large.
    assert.deepEqual(sections, ["/home/sections?image_size=large&item_limit=20", "/home/sections?image_size=large"]);
}, catalog => {
    const read = catalog.route.bind(catalog);
    catalog.route = (method, path, profile, body) => {
        const url = new URL(path, "https://fake.invalid");
        if (url.pathname === "/home/capabilities") return { status: 200, body: { state: "available", section_item_limit_max: 100 } };
        if (url.pathname === "/home/sections" && url.searchParams.has("item_limit")) {
            return { status: 422, headers: { "Content-Type": "application/problem+json" }, body: { type: "https://siloserver.org/docs/api/v2/problems/validation_failed", title: "Validation failed", status: 422, errors: [{ location: "query.item_limit", code: "unknown_parameter" }] } };
        }
        return read(method, path, profile, body);
    };
});

let heldRowCap: { release(): void };
journey("returning to Home during a held row-cap read still paints rows", async tv => {
    assert.ok(await tv.page.locator('[data-view="home"] [data-section] .browse-card').count() > 0);
    assert.equal(await tv.page.locator('[data-view="home"] [role="alert"]').count(), 0);
    const caps = tv.fake.requests.filter(request => new URL(request.path, "https://fake.invalid").pathname === "/home/capabilities");
    assert.equal(caps.length, 2, "the return reads the row cap again after the cancelled join");
    const sections = tv.fake.requests.filter(request => request.path.startsWith("/home/sections")).map(request => request.path);
    assert.ok(sections.some(path => path.includes("item_limit=20")), sections.join(" "));
}, catalog => {
    const read = catalog.route.bind(catalog);
    catalog.route = (method, path, profile, body) => {
        const url = new URL(path, "https://fake.invalid");
        if (url.pathname === "/home/capabilities") return { status: 200, body: { state: "available", section_item_limit_max: 100 } };
        return read(method, path, profile, body);
    };
}, undefined, {
    beforeMount: tv => { heldRowCap = tv.fake.hold("/home/capabilities", true); },
    beforeReady: async tv => {
        try {
            await tv.eventually(async () => tv.fake.requests.some(request => new URL(request.path, "https://fake.invalid").pathname === "/home/capabilities"), "row-cap read started");
            assert.equal(await tv.page.locator('[data-view="home"] [data-section]').count(), 0);
            // One turn, so the return joins the read the leave is still cancelling.
            await tv.page.evaluate(() => {
                const press = (key: string): void => {
                    const button = document.querySelector<HTMLButtonElement>(`[data-focus="${key}"]`);
                    if (button === null) throw new Error(`missing ${key}`);
                    button.click();
                };
                press("calendar");
                press("home");
            });
            await tv.eventually(async () => await tv.page.locator('[data-view="home"] [data-section] .browse-card').count() > 0, "Home rows after returning during the held row-cap read");
        } finally { heldRowCap.release(); }
    },
    readyTimeout: 4000,
    whileReading: true,
});

journey("Home keeps the server's row order and shows featured rows as ordinary rows", async tv => {
    assert.deepEqual(await tv.page.locator('[data-section]').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-section"))), ["hero/opaque", "recent/12", "because/opaque", "resume/opaque", "future/opaque", "for/you"]);
    assert.equal(await tv.page.locator('[data-section="hero/opaque"] .browse-section-title').innerText(), "Featured");
    assert.equal(await tv.page.locator('[data-section="hero/opaque"] [data-focus="expand:hero/opaque"]').count(), 1);
    assert.equal(await tv.focused(), "movie:m0004");
    assert.equal(await tv.page.locator('.skyline-marquee h1').innerText(), "Movie 0004");
    const titles = await homeTitles(tv);
    assert.deepEqual(detailReads(tv).sort(), titles.sort(), "one detail read per distinct Home title, and none for anything else");
    const count = tv.fake.requests.length;
    await tv.page.keyboard.press("ArrowRight");
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(tv.fake.requests.length, count, "no focus reads");
    assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/recommendations")).length, 0, "no duplicate recommendations feed");
});

journey("Home uses the Apple row band and marquee frame without changing library geometry", async tv => {
    const frames = await tv.page.evaluate(() => {
        const frame = (selector: string): number[] => {
            const rect = document.querySelector(selector)?.getBoundingClientRect();
            if (rect === undefined) throw new Error(`Missing ${selector}`);
            return [rect.x, rect.y, rect.width, rect.height];
        };
        return { rows: frame(".skyline-content"), marquee: frame(".skyline-marquee"), title: frame(".home-section .browse-section-title") };
    });
    assert.deepEqual(frames.rows, [0, 596, 1920, 484]);
    assert.deepEqual(frames.marquee, [88, 256, 880, 280]);
    assert.equal(frames.title[0], 80);
});

journey("Home uses Apple's 360x200 still for TV episode rows and keeps mixed and series rows as 176x264 posters", async tv => {
    const art = async (section: string) => tv.page.locator(`[data-section="${section}"] .browse-card:not(.skyline-explore) .browse-art`).first().evaluate(node => ({
        width: (node as HTMLElement).offsetWidth,
        height: (node as HTMLElement).offsetHeight,
        src: node.querySelector("img")?.getAttribute("src") ?? "",
    }));
    const added = await art("recent-tv");
    assert.deepEqual({ width: added.width, height: added.height }, { width: 360, height: 200 });
    assert.match(added.src, /tv-still\.svg$/);
    assert.equal(await tv.page.locator('[data-section="recent-tv"] .skyline-progress').count(), 1);
    assert.equal(await tv.page.locator('[data-section="recent-tv"] .home-row-glyph').count(), 0);
    assert.equal(await tv.page.locator('[data-section="recent-tv"] .skyline-explore').evaluate(node => (node as HTMLElement).offsetWidth), 360);
    const mixed = await art("recent-mixed");
    assert.deepEqual({ width: mixed.width, height: mixed.height }, { width: 176, height: 264 });
    assert.doesNotMatch(mixed.src, /tv-still/);
    assert.equal((await art("series-only")).width, 176);
    assert.equal((await art("next-up")).width, 360);
    assert.equal((await art("in-progress")).width, 360);
    assert.equal(await tv.page.locator('[data-section="in-progress"] .home-row-glyph').count(), 1);
    assert.equal((await art("recent/12")).width, 176);
    assert.equal((await art("resume/opaque")).width, 360);
}, catalog => {
    const home = catalog.households.get("p-owner");
    assert.ok(home !== undefined);
    home.sections.push(
        { id: "recent-tv", sectionType: "recently_added", title: "Recently Added TV", items: ["episode:s1e11", "episode:s1e12"] },
        { id: "recent-mixed", sectionType: "recently_added", title: "Recently Added", items: ["movie:m0008", "episode:s1e21"] },
        { id: "series-only", sectionType: "recently_added", title: "Series", items: ["series:s1", "series:s2"] },
        { id: "next-up", sectionType: "next_up", title: "Next Up", items: ["movie:m0009"] },
        { id: "in-progress", sectionType: "in_progress", title: "In Progress", items: ["movie:m0010"] },
    );
    enrichHome(catalog, { "episode:s1e11": { backdrop_url: "/art/tv-still.svg", position_seconds: 30, duration_seconds: 1200 }, "episode:s1e12": { backdrop_url: "/art/tv-still.svg" } });
});

journey("a focused Home row sits on the top of Apple's row band", async tv => {
    const placed = () => tv.page.evaluate(() => {
        const band = document.querySelector(".skyline-content")?.getBoundingClientRect();
        const section = document.activeElement?.closest(".home-section")?.getBoundingClientRect();
        if (band === undefined || section === undefined) throw new Error("missing Home row");
        return section.top - band.top;
    });
    const rows = await tv.page.locator('[data-view="home"] [data-section]').count();
    for (let index = 0; index < rows; index += 1) {
        if (index > 0) await tv.page.keyboard.press("ArrowDown");
        const delta = await placed();
        assert.ok(Math.abs(delta) < 0.5, `row ${index} sits ${delta}px off the band top`);
    }
});

journey("Home caps each shelf at Apple's 20 media cards", async tv => {
    assert.equal(await tv.page.locator('[data-section="recent/12"] .browse-card:not(.skyline-explore)').count(), 20);
});

journey("expanded rows use the shared section catalog instead of a discrete pager", async (tv, catalog) => {
    await tv.page.locator('[data-focus="expand:recent/12"]').click();
    await tv.page.locator(".section-catalog-title").waitFor();
    await tv.page.locator(".section-catalog-grid .browse-card").first().waitFor();
    assert.equal(await tv.page.locator(".section-catalog-title").textContent(), "Recently Added in Movies");
    assert.equal(catalog.queries[0]?.limit, 60);
    assert.equal(await tv.page.locator(".section-catalog-grid .browse-card").count(), 60);
    assert.equal(await tv.page.getByRole("button", { name: "Next page", exact: true }).count(), 0);
    const reads = catalog.queries.length;
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(catalog.queries.length, reads);
    await tv.remote(10009);
    assert.equal(await tv.focused(), "expand:recent/12");
});

journey("Home's trailing Explore all card is remote reachable and restores its row after Back", async tv => {
    const tile = tv.page.locator('[data-focus="expand:recent/12"]');
    assert.equal(await tile.getAttribute("aria-label"), "Explore all, Recently Added in Movies");
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), "movie:m0001");
    for (let move = 0; move < 20; move++) await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.focused(), "expand:recent/12");
    const right = await tile.locator(".browse-art").evaluate(node => node.getBoundingClientRect().right);
    assert.ok(right <= 1920, "the last tile remains inside the viewport");
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-view="homeSection:recent/12"] .browse-card').first().waitFor();
    await tv.remote(10009);
    assert.equal(await tv.focused(), "expand:recent/12");
});

journey("Home chrome uses the shared Swift wordmark and control dimensions", async tv => {
    assert.equal(await tv.page.locator(".skyline-wordmark").evaluate(node => node.tagName), "IMG");
    assert.equal(await tv.page.locator(".skyline-wordmark").evaluate(node => node.getBoundingClientRect().width), 96);
    const tab = await tv.page.locator('.skyline-tabs [data-focus="home"]').evaluate(node => {
        const style = getComputedStyle(node);
        return [style.fontSize, style.fontWeight, node.getBoundingClientRect().height];
    });
    assert.deepEqual(tab, ["26px", "600", 56]);
    assert.equal(await tv.page.locator(".skyline-profile").evaluate(node => node.getBoundingClientRect().width), 58);
});

journey("Home keeps the packaged font and source weights under a simulator's global stylesheet", async tv => {
    await tv.page.addStyleTag({ content: "* { font-family: SamsungOne; font-weight: 600; }" });
    const subtitle = await tv.page.locator('.home-section [data-focus="movie:m0001"] .browse-card-subtitle').first().evaluate(node => {
        const style = getComputedStyle(node);
        return [style.fontFamily, style.fontWeight];
    });
    assert.match(subtitle[0] ?? "", /Inter/);
    assert.equal(subtitle[1], "400");
    assert.equal(await tv.page.locator(".home-section .browse-card:focus .browse-card-subtitle").evaluate(node => getComputedStyle(node).fontWeight), "400");
});

journey("Home fills omitted marquee rating and runtime from detail but preserves row values", async tv => {
    const meta = tv.page.locator(".skyline-marquee-layer:not(.skyline-outgoing) .skyline-meta-line");
    await tv.eventually(async () => (await meta.innerText()).includes("1h 54m"), "detail runtime");
    assert.equal(await meta.locator(".skyline-chip").innerText(), "R");
    const reads = tv.fake.requests.length;
    await tv.page.keyboard.press("ArrowRight");
    await tv.jump(300);
    assert.equal(await meta.locator(".skyline-chip").innerText(), "PG");
    assert.match(await meta.innerText(), /1h 39m/);
    assert.equal(tv.fake.requests.length, reads, "enrichment only looks up the Home-load cache on focus");
}, catalog => {
    const featured = catalog.households.get("p-owner")?.sections.find(row => row.id === "hero/opaque");
    assert.ok(featured);
    featured.items.push("movie:m0005");
    enrichHome(catalog, { "movie:m0004": { runtime: undefined, duration_seconds: undefined, content_rating: undefined }, "movie:m0005": { runtime: 99, content_rating: "PG" } });
    enrichDetails(catalog, { "movie:m0004": { runtime: 114, content_rating: "R" }, "movie:m0005": { runtime: 114, content_rating: "R" } });
});

for (const [cors, thumbhash] of [[true, undefined], [false, undefined], [false, "1QcSHQRnh493V4dIh4eXh1h4kJUI"]] as const) test(`Home backdrop displays cross-origin artwork when palette sampling CORS is ${cors ? "allowed" : "refused"}${thumbhash === undefined ? "" : " with ThumbHash"}`, async () => {
    let samplingRequests = 0;
    const server = createServer((request, response) => {
        if (request.headers.origin !== undefined) samplingRequests++;
        response.writeHead(200, { "Content-Type": "image/svg+xml", ...(cors ? { "Access-Control-Allow-Origin": "*" } : {}) });
        response.end('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/home.svg`;
    const pageServer = createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("<html><body></body></html>");
    });
    pageServer.listen(0, "127.0.0.1");
    await once(pageServer, "listening");
    const pageAddress = pageServer.address();
    assert.ok(pageAddress !== null && typeof pageAddress !== "string");
    const page = await browser.newPage();
    const failedRequests: string[] = [];
    page.on("requestfailed", request => failedRequests.push(request.failure()?.errorText ?? "unknown network failure"));
    page.on("console", message => { if (message.type() === "error") failedRequests.push(message.text()); });
    try {
        await page.goto(`http://127.0.0.1:${pageAddress.port}/tv`);
        const fixture = await build({ entryPoints: [new URL("../../src/ui/heroBackdrop.ts", import.meta.url).pathname], bundle: true, format: "iife", globalName: "HomeBackdropFixture", target: "chrome108", write: false });
        await page.addScriptTag({ content: fixture.outputFiles[0]?.text ?? "" });
        const sampling = cors
            ? page.waitForResponse(response => response.url() === url && response.request().headers().origin !== undefined)
            : page.waitForEvent("requestfailed", request => request.url() === url && request.headers().origin !== undefined);
        await page.evaluate(({ url, thumbhash }) => {
            const fixture = Reflect.get(window, "HomeBackdropFixture") as typeof import("../../src/ui/heroBackdrop.ts");
            document.body.appendChild(fixture.heroBackdrop(url, thumbhash, new Map()));
        }, { url, thumbhash });
        await Promise.all([sampling, page.waitForFunction(() => document.querySelector<HTMLImageElement>(".skyline-backdrop")?.naturalWidth === 64, undefined, { timeout: 5000 })]).catch((error: unknown) => { throw new Error(`Artwork fixture failed (${failedRequests.join(", ")}); server samples ${samplingRequests}: ${String(error)}`); });
        if (cors) await page.waitForFunction(() => document.querySelector<HTMLElement>(".skyline-tint-wash")?.style.background.includes("255, 0, 0") === true);
        else {
            const background = await page.locator(".skyline-tint-wash").evaluate(node => (node as HTMLElement).style.background);
            if (thumbhash === undefined) assert.equal(background, "rgb(0, 0, 0)");
            else assert.match(background, /linear-gradient/);
        }
        assert.ok(samplingRequests > 0, "an anonymous CORS request samples the image independently of display");
    } finally {
        await page.context().close();
        server.closeAllConnections();
        pageServer.closeAllConnections();
        await Promise.all([server, pageServer].map(server => new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))));
    }
});

/** Adds contract members (`CatalogItem` at the pinned SOURCE) the synthetic Home cards lack. */
function enrichHome(catalog: FakeHome, extra: Record<string, Record<string, unknown>>): void {
    const route = catalog.route.bind(catalog);
    catalog.route = (method, path, profile, body) => {
        const reply = route(method, path, profile, body);
        if (!path.startsWith("/home/sections") || reply?.status !== 200) return reply;
        const response = reply.body as { sections: { items: Record<string, unknown>[] }[] };
        return { ...reply, body: { ...response, sections: response.sections.map(row => ({ ...row, items: row.items.map(item => ({ ...item, ...extra[String(item.content_id)] })) })) } };
    };
}

/** Adds item-detail members (`CatalogItemDetail` at the pinned SOURCE) to the synthetic detail answers. */
function enrichDetails(catalog: FakeHome, extra: Record<string, Record<string, unknown>>): void {
    const route = catalog.route.bind(catalog);
    catalog.route = (method, path, profile, body) => {
        const reply = route(method, path, profile, body);
        const id = /^\/catalog\/items\/([^?]+)/.exec(path)?.[1];
        const fields = id === undefined ? undefined : extra[decodeURIComponent(id)];
        return fields === undefined || reply?.status !== 200 ? reply : { ...reply, body: { ...(reply.body as Record<string, unknown>), ...fields } };
    };
}

const savedFile = (resolution: string, extra: Record<string, unknown>) => ({ file_id: "chosen", resolution, codec_video: "hevc", codec_audio: "eac3", hdr: false, container: "mkv", file_size: 1, duration: 1200, bitrate: 1, added_at: "2026-01-01T00:00:00Z", ...extra });
const detailFields = {
    // Continue Watching: the episode's last-played file is a Dolby Vision 4K encode with 5.1 EAC3.
    "episode:s1e12": { versions: [savedFile("1080p", { file_id: "43" }), savedFile("2160p", { hdr: true, video_tracks: [{ dolby_vision: "dvhe.08.06", dv_config_present: true, dv_bl_compat_id_present: true, interlaced: false }], audio_tracks: [{ codec: "eac3", channels: 6, layout: "5.1(side)", default: true }] })] },
    // The movie's last file is gone, so its row summary stays.
    "movie:m0001": { user_data: { played: false, last_file_id: "deleted", position_seconds: 321.5 } },
    "movie:m0005": { air_date: "2026-03-12", cast: [{ name: "Anna Torv", character: "Tess", order: 2 }, { name: "Pedro Pascal", character: "Joel", order: 0 }, { name: "Gabriel Luna", character: "Tommy", order: 3 }, { name: "Bella Ramsey", character: "Ellie", order: 1 }] },
};

const heroFields = {
    "episode:s1e12": { content_rating: "tv-14", runtime: 22, duration_seconds: 1320, position_seconds: 480, overlay_summary: { resolution: "1080P", audio: "aac stereo" }, series_backdrop_url: "/art/series%3As1.svg", backdrop_url: "/art/still.svg" },
    "movie:m0001": { content_rating: "R", runtime: 170, overlay_summary: { resolution: "2160p", hdr: "Dolby Vision", audio: "TrueHD Atmos" } },
    "movie:m0005": { user_state: { played: true, is_favorite: false, in_watchlist: false, not_interested: false } },
};

journey("Home marquee headlines episodes with their series and shows rating, meta and file chips without an eyebrow", async tv => {
    const requests = tv.fake.requests.length;
    await tv.page.locator('[data-section="resume/opaque"] [data-focus="episode:s1e12"]').focus();
    await tv.jump(300);
    const layer = tv.page.locator(".skyline-marquee-layer:not(.skyline-outgoing)");
    assert.equal(await layer.locator("h1").innerText(), "Harbor Lights");
    assert.equal(await layer.locator(".skyline-eyebrow").count(), 0, "no visible eyebrow");
    assert.equal(await layer.locator(".skyline-row-name").textContent(), "Continue Watching", "row name stays for screen readers");
    assert.deepEqual(await layer.locator(".skyline-meta-line > *").allTextContents(), ["TV-14", "S1 E2 · Harbor Lights chapter 1.2 · 22m · 14m left"]);
    assert.deepEqual(await layer.locator(".skyline-badges > *").allInnerTexts(), ["4K", "DOLBY VISION", "EAC3 5.1"], "the file this viewer last played, not the best file");
    assert.equal(await layer.locator(".skyline-detail-line").textContent(), "Al Pacino", "the pinned detail fixture's billed cast, no air date");
    assert.match(await layer.locator(".skyline-backdrop").getAttribute("src") ?? "", /\/art\/series%3As1\.svg$/, "episodes use the series backdrop, not the still");
    await tv.page.locator('[data-section="resume/opaque"] [data-focus="movie:m0001"]').focus();
    await tv.jump(300);
    assert.equal(await layer.locator("h1").innerText(), "Movie 0001");
    assert.deepEqual(await layer.locator(".skyline-meta-line > *").allTextContents(), ["R", "1991 · Crime · 2h 50m"]);
    assert.deepEqual(await layer.locator(".skyline-badges > *").allInnerTexts(), ["4K", "DOLBY VISION", "ATMOS"]);
    await tv.page.locator('[data-section="recent/12"] [data-focus="movie:m0005"]').focus();
    await tv.jump(300);
    assert.deepEqual(await layer.locator(".skyline-meta-line > *").allTextContents(), ["1995 · Crime · 1h 30m"]);
    assert.equal(await layer.locator(".skyline-detail-line").textContent(), "Aired Mar 12, 2026 · Pedro Pascal, Bella Ramsey, Anna Torv");
    assert.equal(await layer.locator(".skyline-badges > *").count(), 0);
    assert.equal(tv.fake.requests.length, requests, "the marquee reads only answers Home already holds");
}, catalog => { enrichHome(catalog, heroFields); enrichDetails(catalog, detailFields); });

journey("Home refreshes the same title's marquee progress after playback", async (tv, catalog) => {
    const id = "episode:s1e12";
    const item = tv.page.locator(`[data-section="resume/opaque"] [data-focus="${id}"]`);
    await item.focus();
    await tv.jump(300);
    const meta = tv.page.locator(".skyline-marquee-layer:not(.skyline-outgoing) .skyline-meta");
    assert.match(await meta.innerText(), /14m left/);
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.plays.length) === 1, "player handoff");
    enrichHome(catalog, { [id]: { position_seconds: 900, progress_updated_at: "after-playback" } });
    await tv.page.evaluate(() => window.browseHarness.resume());
    await tv.jump(300);
    await tv.eventually(async () => /7m left/.test(await meta.innerText()), "refreshed marquee progress");
    assert.equal(await tv.focused(), id);
}, catalog => { enrichHome(catalog, heroFields); enrichDetails(catalog, detailFields); });

for (const failure of ["read", "write"] as const) {
    journey(`Home still loads when its optional image cache cannot ${failure}`, async tv => {
        await tv.page.evaluate(mode => {
            window.browseHarness.destroy();
            window.browseHarness.failPublicStorage(mode === "read", mode === "write");
            window.browseHarness.mount();
        }, failure);
        await tv.page.locator('[data-view="home"] [data-section]').first().waitFor();
        assert.equal(await tv.page.locator('[data-view="home"] .browse-card').count() > 0, true);
    }, catalog => imageCapabilities(catalog, true));
}

journey("Home cards caption episodes by series, mark watched titles and label Continue Watching", async tv => {
    const caption = (id: string) => tv.page.locator(`[data-section="resume/opaque"] [data-focus="${id}"] :is(.browse-card-title, .browse-card-subtitle)`).allInnerTexts();
    assert.deepEqual(await caption("episode:s1e12"), ["Harbor Lights", "S01E02 · Harbor Lights chapter 1.2"]);
    assert.deepEqual(await caption("movie:m0001"), ["Movie 0001", "1991"]);
    const watched = tv.page.locator('[data-section="recent/12"] [data-focus="movie:m0005"]');
    assert.equal(await watched.locator(".browse-watched").count(), 1);
    assert.match(await watched.getAttribute("aria-label") ?? await watched.innerText(), /Watched/);
    assert.equal(await tv.page.locator('[data-section="recent/12"] [data-focus="movie:m0006"] .browse-watched').count(), 0);
    assert.equal(await tv.page.locator('[data-section="resume/opaque"] .browse-section-title .home-row-glyph').count(), 1);
    assert.equal(await tv.page.locator('[data-section="recent/12"] .browse-section-title .home-row-glyph').count(), 0);
    assert.equal(await tv.page.locator('[data-section="resume/opaque"] .browse-section-title').innerText(), "Continue Watching");
}, catalog => enrichHome(catalog, heroFields));

journey("Home lifts the focused poster and Continue Watching still without clipping either", async tv => {
    await tv.page.emulateMedia({ reducedMotion: "no-preference" });
    for (const id of ['[data-section="resume/opaque"] [data-focus="movie:m0001"]', '[data-section="recent/12"] [data-focus="movie:m0004"]']) {
        await tv.page.locator(id).focus();
        await tv.jump(400);
        await tv.page.evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
        const box = await tv.page.locator(id).evaluate(card => {
            const art = card.querySelector(".browse-art");
            if (!(art instanceof HTMLElement)) throw new Error("art missing");
            const lifted = art.getBoundingClientRect();
            const clips = [card.closest(".browse-row"), card.closest(".skyline-content")].map(node => node?.getBoundingClientRect());
            const caption = card.querySelector(".browse-card-title")?.getBoundingClientRect();
            return { grew: lifted.width > art.offsetWidth, inside: clips.every(clip => clip !== undefined && lifted.left >= clip.left - 0.5 && lifted.right <= clip.right + 0.5 && lifted.top >= clip.top - 0.5), captionBelow: caption !== undefined && caption.top >= lifted.bottom };
        });
        assert.deepEqual(box, { grew: true, inside: true, captionBelow: true }, id);
    }
}, catalog => enrichHome(catalog, heroFields));

const badgeFields = {
    ...heroFields,
    "movie:m0006": { logo_url: "/art/m0006-logo.svg", rating_imdb: 8.46, rating_tmdb: 6.1, show_status: "returning series", overlay_summary: { resolution: "2160p", hdr: "HDR10", audio: "TrueHD Atmos", release_type: "WEB-DL" } },
    "movie:m0007": { rating_tmdb: 7.04 },
    "episode:s1e12": { ...heroFields["episode:s1e12"], rating_imdb: 9.1 },
};
const POSTER = '[data-section="future/opaque"] [data-focus="movie:m0006"]';
const corners = (tv: Tv, card: string) => tv.page.locator(card).evaluate(node => Object.fromEntries([...node.querySelectorAll(".card-overlay-stack")].map(stack => [
    [...stack.classList].find(name => name.startsWith("card-overlay-") && name !== "card-overlay-stack")?.slice("card-overlay-".length), [...stack.children].map(badge => badge.textContent)])));
const baseline = JSON.stringify({ version: 2, preset: "classic", order: [], items: { resolution: { enabled: false, position: "top-left" }, hdr: { enabled: false, position: "top-left" }, audio: { enabled: false, position: "top-left" }, release_type: { enabled: false, position: "bottom-left" }, rating_imdb: { enabled: true, position: "top-right" } } });
const REGISTRY_DEFAULTS = { "top-left": ["4K", "HDR10", "TrueHD Atmos"], "bottom-left": ["WEB-DL"] };

for (const [size, scale, columns] of [["compact", 0.86, 6], ["standard", 1, 6], ["large", 1.2, 5]] as const) {
    journey(`expanded section ${size} posters fit their tracks and focus columns`, async tv => {
        await tv.page.locator('[data-focus="expand:recent/12"]').click();
        const grid = tv.page.locator(".section-catalog-grid");
        await grid.waitFor();
        const frame = await grid.evaluate(node => {
            const cards = [...node.querySelectorAll<HTMLElement>(".browse-card")];
            const art = cards[0]?.querySelector<HTMLElement>(".browse-art");
            const rects = cards.slice(0, 6).map(card => card.getBoundingClientRect());
            return { width: art?.offsetWidth, gridWidth: (node as HTMLElement).offsetWidth, columns: getComputedStyle(node).gridTemplateColumns.split(" ").length,
                fits: rects.every((rect, index) => index === 0 || rect.top !== rects[index - 1]?.top || rect.left - (rects[index - 1]?.right ?? 0) >= 39) };
        });
        assert.ok(Math.abs((frame.width ?? 0) - 260 * scale) < 1);
        assert.equal(frame.columns, columns);
        assert.equal(frame.gridWidth, Math.max(1664, columns * 260 * scale + (columns - 1) * 40));
        assert.equal(frame.fits, true);
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), `movie:m${String(columns + 1).padStart(4, "0")}`);
    }, undefined, settings => settings.profile().set(CARD_PRESENTATION_KEY, { poster_size: size, caption: "title_metadata" }));
}

journey("section captions retain Apple's focus contrast under the simulator font reset", async tv => {
    await tv.page.addStyleTag({ content: "* { font-family: SamsungOne; font-weight: 600; }" });
    await tv.page.locator('[data-focus="expand:recent/12"]').click();
    const cards = tv.page.locator(".section-catalog-grid .browse-card");
    await cards.first().waitFor();
    const styles = await tv.page.locator(".section-catalog").evaluate(root => {
        const read = (selector: string) => { const node = root.querySelector(selector); if (node === null) throw new Error(selector); const style = getComputedStyle(node); return { weight: style.fontWeight, color: style.color, transform: style.transform }; };
        return { title: read(".browse-card:focus .browse-card-title"), subtitle: read(".browse-card:focus .browse-card-subtitle"), resting: read(".browse-card:not(:focus) .browse-card-title"), metadata: read(".browse-card:not(:focus) .browse-card-subtitle"), count: read(".section-catalog-count") };
    });
    assert.equal(styles.title.weight, "500");
    assert.equal(styles.title.color, "rgb(255, 255, 255)");
    assert.equal(styles.subtitle.weight, "400");
    assert.equal(styles.resting.weight, "500");
    assert.equal(styles.resting.color, "rgba(237, 237, 237, 0.45)");
    assert.equal(styles.metadata.weight, "400");
    assert.equal(styles.metadata.color, "rgba(237, 237, 237, 0.32)");
    assert.equal(styles.count.weight, "400");
    assert.equal(styles.title.transform, "none");
});

let heldSectionBadges: { release(): void };
journey("a late section badge answer repaints retained cards without changing focus or depth", async (tv, catalog) => {
    await tv.page.locator('[data-focus="expand:recent/12"]').click();
    const card = tv.page.locator('.section-catalog-grid [data-focus="movie:m0006"]');
    await card.focus();
    assert.ok(await card.locator(".card-overlay").count() > 0);
    const reads = catalog.queries.length;
    heldSectionBadges.release();
    await tv.eventually(async () => await card.locator(".card-overlay").count() === 0, "disabled section badges removed");
    assert.equal(await tv.focused(), "movie:m0006");
    assert.equal(await tv.page.locator(".section-catalog-grid .browse-card").count(), 60);
    assert.equal(catalog.queries.length, reads);
}, catalog => {
    const read = catalog.route.bind(catalog);
    catalog.route = (method, path, profile, body) => {
        const reply = read(method, path, profile, body);
        const response = reply?.body;
        if (path.startsWith("/catalog/query") && reply?.status === 200 && typeof response === "object" && response !== null && "items" in response && Array.isArray(response.items)) {
            return { ...reply, body: { ...response, items: response.items.map((item: unknown) => typeof item === "object" && item !== null ? { ...item, overlay_summary: { resolution: "2160p" } } : item) } };
        }
        return reply;
    };
}, (settings, tv) => { settings.overlayConfig = { enabled: false }; heldSectionBadges = tv.fake.hold("/settings/overlay-config", true); });

for (const [name, configure, expected] of [
    ["the registry defaults when neither the profile nor the administrator chose", () => undefined, REGISTRY_DEFAULTS],
    ["the administrator's baseline when the profile has no document", (settings: FakeSettings) => { settings.overlayConfig = { enabled: true, defaults: baseline }; }, { "top-right": ["IMDb 8.5"] }],
    ["the profile's document over the administrator's baseline", (settings: FakeSettings) => {
        settings.overlayConfig = { enabled: true, defaults: baseline };
        settings.profile().set(CARD_OVERLAYS_KEY, { version: 2, preset: "square", order: ["show_status", "rating_tmdb"], items: { resolution: { enabled: false, position: "top-left" }, hdr: { enabled: false, position: "top-left" }, audio: { enabled: false, position: "top-left" }, release_type: { enabled: false, position: "bottom-left" }, rating_tmdb: { enabled: true, position: "bottom-right" }, show_status: { enabled: true, position: "bottom-right", accentColor: "#00ff00" } } });
    }, { "bottom-right": ["Returning", "TMDB 6.1"] }],
    ["no badges when the administrator turned them off and the profile has not chosen", (settings: FakeSettings) => { settings.overlayConfig = { enabled: false }; }, {}],
    ["the profile's on over the administrator's off", (settings: FakeSettings) => { settings.overlayConfig = { enabled: false }; settings.profile().set(CARD_OVERLAYS_ENABLED_KEY, true); }, REGISTRY_DEFAULTS],
    ["no badges when the profile turned them off", (settings: FakeSettings) => { settings.profile().set(CARD_OVERLAYS_ENABLED_KEY, false); }, {}],
    ["the registry defaults when the server-wide default cannot be read (nothing known to be off)", (settings: FakeSettings) => { settings.overlayConfig = undefined; }, REGISTRY_DEFAULTS],
    ["no badges when the profile turned them off and the server-wide default cannot be read", (settings: FakeSettings) => { settings.overlayConfig = undefined; settings.profile().set(CARD_OVERLAYS_ENABLED_KEY, false); }, {}],
] as const) {
    journey(`Home poster badges use ${name}`, async tv => {
        await tv.eventually(async () => tv.fake.requests.some(request => request.path.startsWith("/settings/overlay-config")), "badge settings read");
        await tv.jump(300);
        assert.deepEqual(await corners(tv, POSTER), expected);
        assert.equal(await tv.page.locator('[data-section="recent/12"] [data-focus="movie:m0004"] .browse-art').count(), 1, "Home stays usable");
        const requests = tv.fake.requests.length;
        await tv.page.locator(POSTER).focus();
        await tv.page.keyboard.press("ArrowLeft");
        await tv.jump(300);
        assert.equal(tv.fake.requests.length, requests, "focus moves read nothing");
    }, catalog => enrichHome(catalog, badgeFields), configure);
}

journey("Home poster badges scale from Apple's 185pt poster and Continue Watching badges sit above the progress bar", async tv => {
    await tv.eventually(async () => await tv.page.locator(`${POSTER} .card-overlay`).count() > 0, "badges");
    const sizes = await tv.page.locator(`${POSTER} .card-overlay`).first().evaluate(node => { const style = getComputedStyle(node); return [style.fontSize, style.paddingTop, style.paddingLeft]; });
    assert.deepEqual(sizes, ["9.51px", "2.85px", "7.61px"], "classic preset at 176 / 185");
    const wide = tv.page.locator('[data-section="resume/opaque"] [data-focus="episode:s1e12"]');
    await tv.eventually(async () => JSON.stringify(await corners(tv, '[data-section="resume/opaque"] [data-focus="episode:s1e12"]')) === JSON.stringify({ "top-left": ["4K", "DV", "EAC3"] }), "saved-file badges");
    assert.deepEqual(await corners(tv, '[data-section="resume/opaque"] [data-focus="movie:m0001"]'), { "top-left": ["4K", "Dolby Vision", "TrueHD Atmos"] }, "an unknown last file keeps the summary");
    assert.equal(await wide.locator(".card-overlays + .skyline-progress").count(), 1, "the progress bar draws over the badges");
}, catalog => { enrichHome(catalog, badgeFields); enrichDetails(catalog, detailFields); }, () => undefined);

const badgePx = (value: number, artWidth: number): number => Math.round(value * artWidth / 185 * 100) / 100;
/** SF Symbol "tv" layout box at iconSize 12 times the poster scale. The old value was a square of that point size. */
const tvLayout = (artWidth: number): { width: string; height: string } => ({
    width: `${Math.round(12 * 73 / 48 * artWidth / 185 * 100) / 100}px`,
    height: `${Math.round(12 * 58 / 48 * artWidth / 185 * 100) / 100}px`,
});

journey("Home headings below a row use Skyline's 14px card padding plus the 10px row gap", async tv => {
    const measured = await tv.page.evaluate(() => {
        const row = document.querySelector('[data-section="resume/opaque"] .browse-row');
        const card = document.querySelector('[data-section="resume/opaque"] .browse-card:not(.skyline-explore)');
        const title = document.querySelector('[data-section="future/opaque"] .browse-section-title');
        if (!(row instanceof HTMLElement) || !(card instanceof HTMLElement) || !(title instanceof HTMLElement)) throw new Error("missing home row");
        return { paddingBottom: getComputedStyle(row).paddingBottom, gap: title.getBoundingClientRect().top - card.getBoundingClientRect().bottom };
    });
    // The previous 24px bottom padding was MediaRow's default vertical padding. Skyline passes rowBandCardVerticalPadding, 14.
    assert.equal(measured.paddingBottom, "14px", "Skyline card strip padding is 14px, not the 24px default");
    assert.ok(Math.abs(measured.gap - 24) < 1, `the next heading is 14px below the landscape card plus the 10px row gap, got ${measured.gap}`);
});

journey("series status badges draw the tv icon at Apple's scaled pill size", async (tv, catalog) => {
    const read = catalog.route.bind(catalog);
    catalog.route = (method, path, profile, body) => {
        const reply = read(method, path, profile, body);
        const response = reply?.body;
        if (!path.startsWith("/catalog/query") || reply?.status !== 200 || typeof response !== "object" || response === null || !("items" in response) || !Array.isArray(response.items)) return reply;
        return { ...reply, body: { ...response, items: response.items.map(item => typeof item === "object" && item !== null ? { ...item, show_status: "returning series" } : item) } };
    };
    const homeArt = 176 * 0.86;
    const badge = tv.page.locator(`${POSTER} .card-overlay`);
    await tv.eventually(async () => await badge.count() > 0, "home status badge");
    const home = await badge.evaluate(node => {
        const icon = node.querySelector("svg");
        const style = getComputedStyle(node);
        const iconStyle = icon === null ? undefined : getComputedStyle(icon);
        return { text: node.textContent, font: style.fontSize, pad: style.padding, radius: style.borderRadius, icon: icon === null || iconStyle === undefined ? undefined : { width: icon.style.width, height: icon.style.height, gap: icon.style.marginRight, used: iconStyle.width } };
    });
    assert.equal(home.text, "Returning");
    assert.equal(home.font, `${badgePx(10, homeArt)}px`, "pill text is fontSize 10 times the poster width over 185");
    assert.equal(home.pad, `${badgePx(4, homeArt)}px ${badgePx(10, homeArt)}px`);
    assert.equal(home.radius, "999px", "the pill preset is a capsule");
    // The old square icon was iconSize 12 times the scale (a point-size box). SF Symbol "tv" lays out at 73/48 by 58/48 of that point size.
    const homeIcon = tvLayout(homeArt);
    assert.equal(home.icon?.width, homeIcon.width);
    assert.equal(home.icon?.height, homeIcon.height);
    assert.equal(home.icon?.gap, `${badgePx(4, homeArt)}px`, "icon-to-text spacing is the 4pt HStack spacing times the scale");
    assert.ok(home.icon !== undefined && Math.abs(parseFloat(home.icon.used) - parseFloat(homeIcon.width)) < 0.05);
    assert.equal(await tv.page.locator('[data-section="hero/opaque"] .card-overlay').textContent(), "Ended");
    assert.equal(await tv.page.locator('[data-section="because/opaque"] .card-overlay').textContent(), "Cancelled");
    assert.equal(await tv.page.locator('[data-section="hero/opaque"] .card-overlay svg').count(), 1);
    assert.equal(await tv.page.locator('[data-section="because/opaque"] .card-overlay svg').count(), 1);
    await tv.page.locator('[data-focus="expand:recent/12"]').click();
    const gridCard = tv.page.locator('.section-catalog-grid [data-focus="movie:m0006"]');
    await gridCard.waitFor();
    const grid = await gridCard.locator(".browse-art").evaluate(node => {
        const badge = node.querySelector(".card-overlay");
        const icon = badge?.querySelector("svg");
        if (!(badge instanceof HTMLElement) || icon === null || icon === undefined) return { width: (node as HTMLElement).offsetWidth, badge: undefined };
        const style = getComputedStyle(badge);
        return { width: (node as HTMLElement).offsetWidth, badge: { text: badge.textContent, font: style.fontSize, pad: style.padding, radius: style.borderRadius, icon: { width: icon.style.width, height: icon.style.height, gap: icon.style.marginRight } } };
    });
    const gridArt = 260 * 0.86;
    assert.equal(grid.width, 224, "compact library posters are 260 times 0.86, which rounds to 224");
    assert.equal(grid.badge?.text, "Returning");
    // 10 * 223.6 / 185 is 12.09. The captured 15.8px is not this font size.
    assert.equal(grid.badge?.font, `${badgePx(10, gridArt)}px`, "12.09px text on the 224-wide card, from fontSize 10 times 260*0.86/185");
    assert.equal(grid.badge?.pad, `${badgePx(4, gridArt)}px ${badgePx(10, gridArt)}px`);
    assert.equal(grid.badge?.radius, "999px");
    // The old square icon was 14.5px (iconSize 12 times 260*0.86/185). The symbol box is wider than that point size.
    const gridIcon = tvLayout(gridArt);
    assert.equal(grid.badge?.icon?.width, gridIcon.width);
    assert.equal(grid.badge?.icon?.height, gridIcon.height);
    assert.equal(grid.badge?.icon?.gap, `${badgePx(4, gridArt)}px`);
}, catalog => enrichHome(catalog, { ...badgeFields, "movie:m0004": { show_status: "ended" }, "movie:m0005": { show_status: "cancelled" } }), settings => {
    settings.profile().set(CARD_OVERLAYS_KEY, { version: 2, preset: "pill", order: ["show_status"], items: { resolution: { enabled: false, position: "top-left" }, hdr: { enabled: false, position: "top-left" }, audio: { enabled: false, position: "top-left" }, release_type: { enabled: false, position: "bottom-left" }, show_status: { enabled: true, position: "top-right" } } });
    settings.profile().set(CARD_PRESENTATION_KEY, { poster_size: "compact", caption: "title_metadata" });
});

for (const [size, scale] of [["compact", 0.86], ["standard", 1], ["large", 1.2]] as const) journey(`Home ${size} artwork and poster badges follow the profile's TV size`, async tv => {
    const sizes = await tv.page.locator(`${POSTER} .browse-art`).evaluate(node => {
        const badge = node.querySelector<HTMLElement>(".card-overlay");
        return { width: (node as HTMLElement).offsetWidth, height: (node as HTMLElement).offsetHeight, badgeFont: parseFloat(badge?.style.fontSize ?? "0") };
    });
    assert.ok(Math.abs(sizes.width - 176 * scale) < 1);
    assert.ok(Math.abs(sizes.height - 264 * scale) < 1);
    assert.ok(Math.abs(sizes.badgeFont - Math.round(10 * 176 * scale / 185 * 100) / 100) < 0.01);
    const still = tv.page.locator('[data-section="resume/opaque"] .browse-art').first();
    assert.ok(Math.abs(await still.evaluate(node => (node as HTMLElement).offsetWidth) - 360 * scale) < 1);
}, catalog => enrichHome(catalog, badgeFields), settings => settings.profile().set(CARD_PRESENTATION_KEY, { poster_size: size, caption: "title_metadata" }));

let posterAnswer: { release(): void };
journey("Compact Continue Watching focus uses Apple's shared 5% lift", async tv => {
    await tv.page.emulateMedia({ reducedMotion: "no-preference" });
    const still = tv.page.locator('[data-section="resume/opaque"] [data-focus="episode:s1e12"]');
    await still.focus();
    await tv.jump(500);
    await tv.page.evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
    const frame = await still.locator(".browse-art").boundingBox();
    assert.ok(frame !== null);
    assert.ok(Math.abs(frame.height - 180.6) < 1, `focused still height ${frame.height}`);
}, undefined, settings => settings.profile().set(CARD_PRESENTATION_KEY, { poster_size: "compact", caption: "title_metadata" }));

journey("a late Home poster-size answer resizes existing focus without fetching on navigation", async tv => {
    await tv.page.keyboard.press("ArrowRight");
    const focus = await tv.focused();
    posterAnswer.release();
    await tv.eventually(() => tv.page.locator(".browse").evaluate(node => node.style.getPropertyValue("--poster-scale") === "0.86"), "compact size applied");
    assert.equal(await tv.focused(), focus);
    const requests = tv.fake.requests.length;
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(tv.fake.requests.length, requests);
}, undefined, (settings, tv) => {
    settings.profile().set(CARD_PRESENTATION_KEY, { poster_size: "compact", caption: "title_metadata" });
    posterAnswer = tv.fake.hold("/settings/values/effective?keys=ui.card_presentation", true);
});

let largerPosterAnswer: { release(): void };
journey("late larger Home posters reveal the same focused card at the row edge", async tv => {
    await tv.page.keyboard.press("ArrowDown");
    for (let move = 0; move < 7; move++) await tv.page.keyboard.press("ArrowRight");
    const focus = await tv.focused();
    const reads = tv.fake.requests.length;
    largerPosterAnswer.release();
    await tv.eventually(() => tv.page.locator(".browse").evaluate(node => node.style.getPropertyValue("--poster-scale") === "1.2"), "large size applied");
    await tv.jump(500);
    assert.equal(await tv.focused(), focus);
    const bounds = await tv.page.locator('[data-section="recent/12"] :focus .browse-art').evaluate(node => {
        const art = node.getBoundingClientRect();
        const row = node.closest(".browse-row")?.getBoundingClientRect();
        if (row === undefined) throw new Error("missing focused row");
        return { left: art.left, right: art.right, rowLeft: row.left, rowRight: row.right };
    });
    assert.ok(bounds.left >= bounds.rowLeft && bounds.right <= bounds.rowRight, JSON.stringify(bounds));
    assert.equal(tv.fake.requests.length, reads, "resizing and revealing focus sends no requests");
}, undefined, (settings, tv) => {
    settings.profile().set(CARD_PRESENTATION_KEY, { poster_size: "large", caption: "title_metadata" });
    largerPosterAnswer = tv.fake.hold("/settings/values/effective?keys=ui.card_presentation", true);
});

journey("Home marquee scores titles with IMDb, else TMDB, and never episodes", async tv => {
    const layer = tv.page.locator(".skyline-marquee-layer:not(.skyline-outgoing)");
    const meta = async () => layer.locator(".skyline-meta").evaluate(node => [...node.children].map(child => child.getAttribute("aria-label") ?? child.textContent));
    await tv.page.locator(POSTER).focus();
    await tv.jump(300);
    assert.deepEqual(await meta(), ["1996 · Crime · 1h 30m", " · ", "IMDb 8.5"]);
    assert.deepEqual(await layer.locator(".skyline-rating > *").allTextContents(), ["IMDb", "8.5"]);
    await tv.page.locator('[data-section="for/you"] [data-focus="movie:m0007"]').focus();
    await tv.jump(300);
    assert.deepEqual(await meta(), ["1997 · Crime · 1h 30m", " · ", "TMDB 7.0"]);
    const mark = layer.locator(".skyline-rating img.skyline-rating-logo");
    assert.match(await mark.getAttribute("src") ?? "", /^third-party\/tmdb-logo\.svg$/, "TMDB's approved logo replaces its text mark");
    await tv.eventually(async () => await mark.evaluate(image => (image as HTMLImageElement).naturalWidth > 0), "TMDB logo decoded");
    assert.equal(await layer.locator(".skyline-rating-mark").count(), 0);
    await tv.page.locator('[data-section="resume/opaque"] [data-focus="episode:s1e12"]').focus();
    await tv.jump(300);
    assert.deepEqual(await meta(), ["S1 E2 · Harbor Lights chapter 1.2 · 22m", " · ", "14m left"]);
}, catalog => enrichHome(catalog, badgeFields));

for (const mode of ["on", "off", "pending", "failed"] as const) {
    let hold: { release(): void } | undefined;
    journey(`Home marquee title art ${mode}`, async tv => {
        let logos = 0;
        tv.page.on("request", request => { if (new URL(request.url()).pathname === "/art/m0006-logo.svg") logos++; });
        try {
            await tv.page.locator(POSTER).focus();
            await tv.jump(300);
            const title = tv.page.locator(".skyline-marquee-layer:not(.skyline-outgoing) h1");
            if (mode !== "off") {
                // Apple shows logos unless the last confirmed answer is off: pending and failed reads included.
                await title.locator("img.skyline-logo").waitFor({ timeout: 3000 });
                assert.equal(await title.locator("img").getAttribute("alt"), "Movie 0006");
                assert.equal(logos, 1);
                if (mode === "pending") assert.equal(tv.fake.requests.filter(request => request.path === "/settings/values/effective?keys=ui.title_art").length, 1, "the logo shows while the one title-art read is still held");
                return;
            }
            await tv.jump(300);
            assert.equal(await title.textContent(), "Movie 0006");
            assert.equal(logos, 0, "no logo is requested once the profile's off is known");
        } finally { hold?.release(); }
    }, catalog => enrichHome(catalog, badgeFields), (settings, tv) => {
        if (mode === "off") settings.profile().set(TITLE_ART_KEY as SettingsKey, false);
        if (mode === "pending") hold = tv.fake.hold("/settings/values/effective?keys=ui.title_art", true);
        if (mode === "failed") tv.fake.script("/settings/values/effective?keys=ui.title_art", problem(500, "internal", "Unavailable"));
    });
}

journey("Home poster badges show the registry defaults while their reads are pending, then the administrator's off", async tv => {
    assert.deepEqual(await corners(tv, POSTER), REGISTRY_DEFAULTS, "Apple draws its defaults until the reads answer");
    heldBadges?.release();
    await tv.eventually(async () => JSON.stringify(await corners(tv, POSTER)) === "{}", "administrator off");
}, catalog => enrichHome(catalog, badgeFields), (settings, tv) => { settings.overlayConfig = { enabled: false }; heldBadges = tv.fake.hold("/settings/overlay-config", true); });
let heldBadges: { release(): void } | undefined;

journey("Home detail reads go out once while Home loads, and focus moves start none", async tv => {
    // Focus roams while the reads are still going out.
    for (const key of ["ArrowRight", "ArrowRight", "ArrowDown", "ArrowRight", "ArrowDown", "ArrowLeft"]) { await tv.page.keyboard.press(key); await tv.jump(200); }
    const titles = await detailsRead(tv);
    assert.deepEqual(detailReads(tv).sort(), titles.sort(), "each Home title is read exactly once; focus added nothing");
    const count = tv.fake.requests.length;
    for (const key of ["ArrowRight", "ArrowRight", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft"]) { await tv.page.keyboard.press(key); await tv.jump(200); }
    assert.equal(tv.fake.requests.length, count, "after the reads settle, focus sends nothing");
}, undefined, undefined, { whileReading: true });

function imageCapabilities(catalog: FakeHome, slotWidths: boolean): void {
    const route = catalog.route.bind(catalog);
    catalog.route = (method, path, profile, body) => path !== "/images/capabilities" ? route(method, path, profile, body) : { status: 200, body: {
        revision: "r1", state: "available", allowed: true, param: "image_size", sizes: ["small", "medium", "large", "original"], widths: {}, original_max_width_px: 3840,
        episode_still_provenance: true, episode_parent_artwork: true, extended_item_artwork: true, season_list_artwork_param: "include_artwork", storage_backend: "local", delivery: "server",
        ...(slotWidths ? { slot_width_params: { poster: "poster_width", backdrop: "backdrop_width", logo: "logo_width", still: "still_width", photo: "photo_width" } } : {}),
    } };
}

/** Named `image_size` values are not numbers. A later answer that only renames one must still refetch, and that refetch keeps `item_limit`. */
function namedArtworkCapabilities(catalog: FakeHome, includeMedium: boolean): void {
    const route = catalog.route.bind(catalog);
    catalog.route = (method, path, profile, body) => {
        const url = new URL(path, "https://fake.invalid");
        if (url.pathname === "/home/capabilities") return { status: 200, body: { state: "available", section_item_limit_max: 100 } };
        if (url.pathname !== "/images/capabilities") return route(method, path, profile, body);
        return { status: 200, body: {
            revision: "r1", state: "available", allowed: true, param: "image_size",
            sizes: includeMedium ? ["small", "medium", "large", "original"] : ["small", "large", "original"],
            widths: {}, original_max_width_px: 3840,
            episode_still_provenance: true, episode_parent_artwork: true, extended_item_artwork: true,
            season_list_artwork_param: "include_artwork", storage_backend: "local", delivery: "server",
            slot_width_params: { poster: "poster_width", backdrop: "backdrop_width", logo: "logo_width", still: "still_width", photo: "photo_width" },
        } };
    };
}

function sectionParams(tv: Tv, imageSize: string, backdrop: string | null): URLSearchParams | undefined {
    return tv.fake.requests.map(request => new URL(request.path, "https://fake.invalid")).find(url => url.pathname === "/home/sections" && url.searchParams.get("image_size") === imageSize && url.searchParams.get("backdrop_width") === backdrop)?.searchParams;
}

let heldNamedArtwork: { release(): void };
journey("a named artwork size still refetches Home and keeps the row cap", async (tv, catalog) => {
    heldNamedArtwork.release();
    await tv.eventually(async () => sectionParams(tv, "medium", "1344")?.get("item_limit") === "20", "medium rows keep the row cap");
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.hasImageCapabilityCache()), "medium capability remembered");
    namedArtworkCapabilities(catalog, false);
    heldNamedArtwork = tv.fake.hold("/images/capabilities", true);
    await tv.page.evaluate(() => { window.browseHarness.destroy(); window.browseHarness.mount(); });
    await tv.page.locator('[data-view="home"] [data-section]').first().waitFor();
    assert.equal(sectionParams(tv, "large", "1344"), undefined, "a remembered medium size is not a numeric step up to large");
    heldNamedArtwork.release();
    await tv.eventually(async () => sectionParams(tv, "large", "1344")?.get("item_limit") === "20", "named size change refetches with the row cap");
}, catalog => namedArtworkCapabilities(catalog, true), (_settings, tv) => { heldNamedArtwork = tv.fake.hold("/images/capabilities", true); }, { whileReading: true });

let heldImageProbe: { release(): void };
journey("a late artwork probe defers to Card actions and preserves watched invalidation", async (tv, catalog) => {
    const reads = tv.fake.requests.filter(request => request.path.startsWith("/home/sections")).length;
    await tv.down(13); await tv.jump(650); await tv.up(13);
    const panel = tv.page.getByRole("dialog", { name: "Card actions" });
    await panel.getByRole("button", { name: "Mark watched", exact: true }).waitFor();
    const capability = tv.page.waitForResponse(reply => new URL(reply.url()).pathname === "/api/v2/images/capabilities");
    heldImageProbe.release();
    assert.equal(await (await capability).finished(), null);
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.hasImageCapabilityCache()), "image probe applied during Card actions");
    await tv.page.clock.runFor(0);
    assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/home/sections")).length, reads, "artwork waits for Card actions to close");
    await panel.getByRole("button", { name: "Mark watched", exact: true }).click();
    await panel.getByRole("button", { name: "Mark unwatched", exact: true }).waitFor();
    catalog.removed.add("movie:m0004");
    await tv.remote(10009);
    await tv.eventually(async () => !(await homeTitles(tv)).includes("movie:m0004"), "watched membership refresh retained");
    assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/home/sections")).length, reads + 1);
    assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/home/sections"))[reads]?.path, "/home/sections?image_size=medium&logo_width=880&backdrop_width=1344");
}, catalog => {
    imageCapabilities(catalog, true);
    const details = new FakeDetails();
    const route = catalog.route.bind(catalog);
    catalog.route = (method, path, profile, body) => /^\/(watched|favorites|watchlist|capabilities\/personal-lists|catalog\/items)/.test(path)
        ? details.route(method, path, profile, body) : route(method, path, profile, body);
}, (_settings, tv) => { heldImageProbe = tv.fake.hold("/images/capabilities", true); });

journey("a failed artwork upgrade retains usable Home without retrying", async tv => {
    const titles = await homeTitles(tv);
    const focus = await tv.focused();
    const upgraded = tv.page.waitForResponse(reply => new URL(reply.url()).pathname === "/api/v2/home/sections" && new URL(reply.url()).searchParams.has("backdrop_width"));
    heldImageProbe.release();
    assert.equal(await (await upgraded).finished(), null);
    await tv.page.clock.runFor(0);
    assert.equal(await tv.page.getByRole("alert").count(), 0);
    assert.deepEqual(await homeTitles(tv), titles);
    assert.equal(await tv.focused(), focus);
    await tv.page.keyboard.press("ArrowRight"); await tv.jump(200);
    assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/home/sections")).length, 2);
}, catalog => {
    imageCapabilities(catalog, true);
    const read = catalog.route.bind(catalog);
    catalog.route = (method, path, profile, body) => path.startsWith("/home/sections") && path.includes("backdrop_width")
        ? problem(422, "validation_failed", "Artwork refresh failed") : read(method, path, profile, body);
}, (_settings, tv) => { heldImageProbe = tv.fake.hold("/images/capabilities", true); });

journey("an artwork upgrade preserves hidden libraries without rereading preferences", async tv => {
    const libraries = tv.fake.requests.filter(request => request.path === "/user/libraries").length;
    const hidden = tv.fake.requests.filter(request => request.path.includes("ui.disabled_library_ids")).length;
    const upgraded = tv.page.waitForResponse(reply => new URL(reply.url()).pathname === "/api/v2/home/sections" && new URL(reply.url()).searchParams.has("backdrop_width"));
    heldImageProbe.release();
    assert.equal(await (await upgraded).finished(), null);
    await tv.page.clock.runFor(0);
    assert.equal(tv.fake.requests.filter(request => request.path === "/user/libraries").length, libraries);
    assert.equal(tv.fake.requests.filter(request => request.path.includes("ui.disabled_library_ids")).length, hidden);
    await tv.page.locator('[data-focus="movies"]').focus();
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.page.getByRole("button", { name: "Archive", exact: true }).count(), 0);
}, catalog => imageCapabilities(catalog, true), (settings, tv) => {
    settings.profile().set(HIDDEN_KEY, [15]);
    heldImageProbe = tv.fake.hold("/images/capabilities", true);
});

let heldHomeDetail: { release(): void };
journey("an artwork upgrade preserves in-flight Home metadata reads", async tv => {
    await tv.eventually(async () => detailReads(tv).includes("movie:m0004"), "held Home detail started");
    const before = detailReads(tv).filter(id => id === "movie:m0004").length;
    const upgraded = tv.page.waitForResponse(reply => new URL(reply.url()).pathname === "/api/v2/home/sections" && new URL(reply.url()).searchParams.has("backdrop_width"));
    heldImageProbe.release();
    assert.equal(await (await upgraded).finished(), null);
    await tv.page.clock.runFor(0);
    assert.equal(detailReads(tv).filter(id => id === "movie:m0004").length, before);
    heldHomeDetail.release();
    await detailsRead(tv);
    assert.equal(detailReads(tv).filter(id => id === "movie:m0004").length, before);
}, catalog => imageCapabilities(catalog, true), (_settings, tv) => {
    heldImageProbe = tv.fake.hold("/images/capabilities", true);
    heldHomeDetail = tv.fake.hold("/catalog/items/movie%3Am0004", true);
}, { whileReading: true });

journey("fresh slot sizing upgrades incomplete remembered Home artwork", async (tv, catalog) => {
    const cached = tv.page.waitForResponse(reply => new URL(reply.url()).pathname === "/api/v2/images/capabilities");
    heldImageProbe.release();
    assert.equal(await (await cached).finished(), null);
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.hasImageCapabilityCache()), "one-size capability cached");
    await tv.eventually(async () => tv.fake.requests.filter(request => request.path === "/home/sections?image_size=large").length === 1, "one-size upgrade completed");
    await detailsRead(tv);
    imageCapabilities(catalog, true);
    heldImageProbe = tv.fake.hold("/images/capabilities", true);
    await tv.page.evaluate(() => { window.browseHarness.destroy(); window.browseHarness.mount(); });
    await tv.page.locator('[data-view="home"] [data-section]').first().waitFor();
    const focus = await tv.focused();
    heldImageProbe.release();
    await tv.eventually(async () => tv.fake.requests.some(request => request.path === "/home/sections?image_size=medium&logo_width=880&backdrop_width=1344"), "remembered artwork upgraded");
    assert.equal(await tv.focused(), focus);
}, catalog => imageCapabilities(catalog, false), (_settings, tv) => { heldImageProbe = tv.fake.hold("/images/capabilities", true); });

journey("a pending optional image probe cannot block cold Home", async tv => {
    const titles = await homeTitles(tv);
    assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/home/sections")).length, 1);
    assert.equal(tv.fake.requests.find(request => request.path.startsWith("/home/sections"))?.path, "/home/sections?image_size=large");
    await tv.page.locator('[data-section="recent/12"] [data-focus="movie:m0012"]').focus();
    await tv.jump(200);
    const focus = await tv.focused();
    const metadataReads = detailReads(tv).length;
    const upgraded = tv.page.waitForResponse(response => new URL(response.url()).pathname === "/api/v2/home/sections" && new URL(response.url()).searchParams.get("backdrop_width") === "1344");
    assert.equal(await tv.page.evaluate(() => window.browseHarness.hasImageCapabilityCache()), false);
    heldImageProbe.release();
    assert.equal(await (await upgraded).finished(), null);
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.hasImageCapabilityCache()), "image capability cached");
    assert.equal(await tv.focused(), focus);
    await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/home/sections")).length === 2, "cold artwork upgraded");
    assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/home/sections"))[1]?.path, "/home/sections?image_size=medium&logo_width=880&backdrop_width=1344");
    await tv.eventually(async () => (await tv.page.locator('.skyline-marquee-layer:not(.skyline-outgoing) .skyline-backdrop').getAttribute("src"))?.includes("width=1344") === true, "upgraded artwork displayed");
    assert.deepEqual(await homeTitles(tv), titles, "artwork changes cannot replace content or metadata");
    assert.equal(await tv.focused(), focus);
    assert.equal(detailReads(tv).length, metadataReads, "artwork refresh reuses completed metadata");
    const reads = tv.fake.requests.length;
    await tv.page.keyboard.press("ArrowRight"); await tv.jump(200);
    assert.equal(tv.fake.requests.length, reads, "focus moves neither reload nor probe");
}, catalog => {
    imageCapabilities(catalog, true);
    const read = catalog.route.bind(catalog);
    catalog.route = (method, path, profile, body) => {
        const reply = read(method, path, profile, body);
        if (!path.startsWith("/home/sections") || reply?.status !== 200) return reply;
        const width = new URL(path, "https://fake.invalid").searchParams.get("backdrop_width") ?? "300";
        const data = reply.body as { sections: { items: Record<string, unknown>[] }[] };
        return { ...reply, body: { ...data, sections: data.sections.map(row => ({ ...row, items: row.items.map(card => ({ ...card, ...(width === "300" ? {} : { title: "Changed during artwork read" }), backdrop_url: `/art/m0004.svg?width=${width}` })) })) } };
    };
}, (_settings, tv) => {
    heldImageProbe = tv.fake.hold("/images/capabilities", true);
});

for (const answer of ["failed", "non-improving"] as const) {
    journey(`a ${answer} image probe leaves cold Home intact`, async tv => {
        const focus = await tv.focused();
        const response = tv.page.waitForResponse(reply => new URL(reply.url()).pathname === "/api/v2/images/capabilities");
        heldImageProbe.release();
        assert.equal(await (await response).finished(), null);
        await tv.page.clock.runFor(0);
        assert.equal(await tv.focused(), focus);
        assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/home/sections")).length, 1);
        assert.equal(await tv.page.getByRole("alert").count(), 0);
    }, catalog => {
        imageCapabilities(catalog, true);
        const read = catalog.route.bind(catalog);
        catalog.route = (method, path, profile, body) => {
            const reply = read(method, path, profile, body);
            if (path !== "/images/capabilities") return reply;
            return answer === "failed" ? problem(422, "validation_failed", "Image capability unavailable") : {
                status: 200, body: { ...(reply?.body as Record<string, unknown>), state: "unavailable" },
            };
        };
    }, (_settings, tv) => { heldImageProbe = tv.fake.hold("/images/capabilities", true); });
}

journey("a late image answer waits for Home return without replacing Details", async tv => {
    const focus = await tv.focused();
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-view="item:movie:m0004"]').waitFor();
    const ready = tv.page.waitForResponse(reply => new URL(reply.url()).pathname === "/api/v2/images/capabilities");
    heldImageProbe.release();
    assert.equal(await (await ready).finished(), null);
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.hasImageCapabilityCache()), "capability cached while in Details");
    assert.equal(await tv.page.locator('[data-view="item:movie:m0004"]').count(), 1);
    assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/home/sections")).length, 1);
    const upgraded = tv.page.waitForResponse(reply => new URL(reply.url()).pathname === "/api/v2/home/sections" && new URL(reply.url()).searchParams.has("backdrop_width"));
    await tv.remote(10009);
    assert.equal(await (await upgraded).finished(), null);
    await tv.page.clock.runFor(0);
    assert.equal(await tv.focused(), focus);
    assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/home/sections")).length, 2);
}, catalog => imageCapabilities(catalog, true), (_settings, tv) => { heldImageProbe = tv.fake.hold("/images/capabilities", true); });

for (const [server, setup, expected] of [
    ["takes per-slot widths", (catalog: FakeHome) => imageCapabilities(catalog, true), "/home/sections?image_size=medium&logo_width=880&backdrop_width=1344"],
    ["takes one size only", (catalog: FakeHome) => imageCapabilities(catalog, false), "/home/sections?image_size=large"],
    ["has no image capability", () => undefined, "/home/sections?image_size=large"],
] as const) {
    journey(`Home asks for title logos at the marquee's width only when the server ${server}`, async tv => {
        assert.equal(tv.fake.requests.filter(request => request.path === "/images/capabilities").length, 1, "one probe per Home session");
        if (server === "has no image capability") {
            assert.deepEqual(tv.fake.requests.filter(request => request.path.startsWith("/home/sections")).map(request => request.path), ["/home/sections?image_size=large"]);
            return;
        }
        const initial = server === "takes per-slot widths" ? ["/home/sections?image_size=large", expected] : [expected];
        await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/home/sections")).length === initial.length, "cold Home sizing settled");
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.hasImageCapabilityCache()), "capability cached for next mount");
        const held = tv.fake.hold("/images/capabilities", true);
        await tv.page.evaluate(() => { window.browseHarness.destroy(); window.browseHarness.mount(); });
        await tv.page.locator('[data-view="home"] [data-section]').first().waitFor();
        assert.deepEqual(tv.fake.requests.filter(request => request.path.startsWith("/home/sections")).map(request => request.path), [...initial, expected], "cached sizing applies even while the refresh probe is pending");
        held.release();
    }, setup);
}

journey("card quick-actions abandon a pending Home turn and refresh the committed page with nearby focus", async (tv, catalog) => {
    const details = new FakeDetails();
    const route = catalog.route.bind(catalog);
    catalog.route = (method, path, profile, body) => /^\/(watched|favorites|watchlist|capabilities\/personal-lists|catalog\/items)/.test(path)
        ? details.route(method, path, profile, body) : route(method, path, profile, body);
    await tv.page.locator('[data-focus="expand:recent/12"]').click();
    await tv.page.locator('.browse .browse-grid .browse-card').first().waitFor();
    const pending = tv.fake.hold("/catalog/query", true);
    await tv.page.locator('.section-catalog-grid .browse-card').last().evaluate(node => node.scrollIntoView({ block: "end" }));
    await tv.eventually(async () => catalog.queries.length === 2, "pending append");
    await tv.page.locator('.browse [data-focus="movie:m0030"]').focus();
    await tv.down(13); await tv.jump(650); await tv.up(13);
    const panel = tv.page.getByRole("dialog", { name: "Card actions" });
    await panel.getByRole("button", { name: "Mark watched", exact: true }).click();
    await panel.getByRole("button", { name: "Mark unwatched", exact: true }).waitFor();
    catalog.removed.add("movie:m0030");
    await tv.remote(10009);
    await tv.eventually(async () => await tv.focused() === "movie:m0031", "nearby Home page focus");
    assert.equal(catalog.queries.slice(-1)[0]?.cursor, undefined);
    pending.release(); await tv.jump(0);
    assert.equal(await tv.focused(), "movie:m0031");
    assert.equal(await tv.page.locator('.section-catalog-grid [data-focus="movie:m0030"]').count(), 0);
});

journey("Home Explore all appends unique cards and restores origin focus and scroll", async (tv, catalog) => {
    const expand = tv.page.locator('[data-section="recent/12"] [data-focus="expand:recent/12"]');
    assert.equal(await expand.count(), 1, "Home exposes row expansion");
    await expand.focus();
    await tv.page.keyboard.press("ArrowLeft");
    const card = await tv.focused();
    await tv.page.keyboard.press("ArrowRight");
    await tv.jump(300);
    const origin = await tv.page.locator('.skyline-content').evaluate(node => node.scrollTop);
    const rowLeft = await tv.page.locator('[data-section="recent/12"] .browse-row').evaluate(node => node.scrollLeft);
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-view="homeSection:recent/12"] .browse-card').first().waitFor();
    assert.equal(await tv.page.locator('.browse .browse-card').count(), 60);
    assert.deepEqual(catalog.queries[0], { source: "section", scope: "home", section_id: "recent/12", limit: 60 });
    await tv.page.locator('.section-catalog-grid .browse-card').last().evaluate(node => node.scrollIntoView({ block: "end" }));
    await tv.eventually(async () => await tv.page.locator('.section-catalog-grid .browse-card').count() === 70, "append without repeated cards");
    assert.equal(catalog.queries[1]?.cursor, "opaque:/+second==");
    assert.equal(await tv.page.locator('.browse-card').first().getAttribute("data-focus"), "movie:m0001");
    const requests = tv.fake.requests.length;
    await tv.page.keyboard.press("ArrowUp");
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(tv.fake.requests.length, requests);
    await tv.remote(10009);
    assert.equal(await tv.focused(), "expand:recent/12");
    assert.equal(await tv.page.locator('.skyline-content').evaluate(node => node.scrollTop), origin);
    assert.equal(await tv.page.locator('[data-section="recent/12"] .browse-row').evaluate(node => node.scrollLeft), rowLeft);
    await tv.page.keyboard.press("ArrowLeft");
    assert.equal(await tv.focused(), card);
    const query = tv.fake.requests.find(request => request.path.startsWith("/catalog/query"));
    assert.equal(query?.headers["x-profile-id"], "p-owner");
    assert.match(query?.headers.authorization ?? "", /^Bearer /);
});

journey("section append finishes revealing the focused card when its response interrupts scrolling", async tv => {
    await tv.page.emulateMedia({ reducedMotion: "no-preference" });
    await tv.page.locator('[data-focus="expand:recent/12"]').click();
    await tv.page.locator(".section-catalog-grid .browse-card").first().waitFor();
    for (let row = 0; row < 9; row++) await tv.page.keyboard.press("ArrowDown");
    await tv.page.clock.runFor(120);
    await tv.eventually(async () => await tv.page.locator(".section-catalog-grid .browse-card").count() === 70, "append during reveal");
    await tv.page.clock.runFor(500);
    assert.equal(await tv.focused(), "movie:m0055");
    assert.equal(await tv.page.locator(".section-catalog-grid .browse-card:focus").evaluate(node => {
        const card = node.getBoundingClientRect(), pane = node.closest(".browse")?.getBoundingClientRect();
        return pane !== undefined && card.top >= pane.top + 12 && card.bottom <= pane.bottom - 32;
    }), true);
});

journey("expanded rows retain depth, focus and scrolling through Details without a query", async (tv, catalog) => {
    await tv.page.locator('[data-focus="expand:recent/12"]').click();
    await tv.page.locator('.section-catalog-grid .browse-card').first().waitFor();
    await tv.page.locator('.section-catalog-grid .browse-card').last().evaluate(node => node.scrollIntoView({ block: "end" }));
    await tv.eventually(async () => await tv.page.locator('.section-catalog-grid .browse-card').count() === 70, "loaded depth");
    await tv.page.locator('.section-catalog-grid [data-focus="movie:m0065"]').focus();
    await tv.jump(300);
    const top = await tv.page.locator(".browse").evaluate(node => node.scrollTop);
    const queries = catalog.queries.length;
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-view="item:movie:m0065"]').waitFor();
    await tv.remote(10009);
    assert.equal(await tv.focused(), "movie:m0065");
    assert.equal(await tv.page.locator('.section-catalog-grid .browse-card').count(), 70);
    assert.equal(await tv.page.locator(".browse").evaluate(node => node.scrollTop), top);
    assert.equal(catalog.queries.length, queries);
});

journey("Home playback return discards an abandoned expanded-row page turn", async (tv, catalog) => {
    await tv.page.locator('[data-focus="expand:recent/12"]').click();
    await tv.page.locator('[data-view="homeSection:recent/12"] .browse-card').first().waitFor();
    const held = tv.fake.hold("/catalog/query", true);
    await tv.page.locator('.section-catalog-grid .browse-card').last().evaluate(node => node.scrollIntoView({ block: "end" }));
    await tv.eventually(async () => catalog.queries.length === 2, "pending second page");
    await tv.page.locator('.browse [data-focus="movie:m0001"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
    await tv.page.locator('.browse [data-focus="play"]').click();
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.plays.length) === 1, "playback handoff");
    await tv.page.evaluate(() => window.browseHarness.resume());
    await tv.page.locator('.browse [data-focus="play"]').waitFor();
    const refresh = tv.fake.hold("/catalog/query", true);
    await tv.remote(10009);
    await tv.eventually(async () => catalog.queries.length === 3, "held return refresh");
    const cached = await tv.page.locator('.browse [data-focus="movie:m0001"]').elementHandle();
    assert.ok(cached);
    held.release();
    refresh.release();
    await tv.eventually(async () => await cached.evaluate(node => !node.isConnected), "expanded-row refresh rendered");
    assert.equal(await tv.page.locator('.section-catalog-grid .browse-card').count(), 60);
    assert.equal(await tv.focused(), "movie:m0001");
    assert.equal(catalog.queries[catalog.queries.length - 1]?.cursor, undefined, "return refreshes the committed page");
    assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 1);
});

journey("Home expansion restarts an invalid cursor and keeps remote Back reachable", async (tv, catalog) => {
    const expand = tv.page.locator('[data-focus="expand:recent/12"]');
    assert.equal(await expand.count(), 1, "Home exposes row expansion");
    await expand.click();
    await tv.page.locator('[data-view="homeSection:recent/12"] .browse-card').first().waitFor();
    // Fail before dispatching the scoped fake's next reply.
    let invalid = true;
    await tv.page.route("**/api/v2/catalog/query?*", async route => {
        if (invalid) { invalid = false; await route.fulfill({ status: 400, contentType: "application/problem+json", json: problem(400, "invalid_cursor", "Invalid cursor").body }); }
        else await route.fallback();
    });
    await tv.page.locator('.section-catalog-grid .browse-card').last().evaluate(node => node.scrollIntoView({ block: "end" }));
    await tv.eventually(async () => catalog.queries.length >= 2, "fresh sequence after invalid cursor");
    assert.equal(catalog.queries[1]?.cursor, undefined);
    assert.equal(await tv.page.getByRole("alert").count(), 0);
    await tv.remote(10009);
    assert.equal(await tv.focused(), "expand:recent/12");
});

for (const [id, activation, position] of [["movie:m0001", "Enter", 321.5], ["episode:s1e12", "pointer", 1195]] as const) {
    journey(`Continue ${id} resolves authorised chosen version once (${activation})`, async (tv, catalog) => {
        catalog.progress.set(id, position);
        const item = tv.page.locator(`[data-section="resume/opaque"] [data-focus="${id}"]`);
        const held = tv.fake.hold(`/catalog/items/${encodeURIComponent(id)}`, true);
        await item.focus();
        if (activation === "pointer") await item.click(); else await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => tv.fake.requests.some(request => request.path.split("?")[0] === `/catalog/items/${encodeURIComponent(id)}`), "authorised detail resolution");
        assert.equal(await tv.page.locator('[data-view^="item:"]').count(), 0, "Details never flashes");
        assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 0);
        held.release();
        await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.plays.length) === 1, "one player handoff");
        assert.deepEqual(await tv.page.evaluate(() => window.browseHarness.plays[0]), { contentId: id, fileId: "chosen", title: id === "movie:m0001" ? "Movie 0001" : "Harbor Lights chapter 1.2", startSeconds: position === 1195 ? 0 : position, ...(id === "episode:s1e12" ? { episode: true, subtitle: { kind: "auto" } } : {}) });
        await tv.page.keyboard.press("Enter");
        await tv.jump(30000);
        assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 1);
        const request = tv.fake.requests.find(request => request.path.split("?")[0] === `/catalog/items/${encodeURIComponent(id)}`);
        assert.equal(request?.headers["x-profile-id"], "p-owner");
        await tv.page.evaluate(() => window.browseHarness.resume());
        await tv.page.locator('[data-view="home"]').waitFor();
        assert.equal(await tv.focused(), id);
        assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 1, "returning never replays");
    });
}

for (const mode of ["missing", "restricted", "unreadable", "mismatch"] as const) {
    journey(`Continue ${mode} leaves Retry and Back without playback`, async (tv, catalog) => {
        catalog.detailMode = mode;
        await tv.page.locator('[data-section="resume/opaque"] [data-focus="movie:m0001"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("alert").waitFor();
        assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 0);
        assert.equal(await tv.page.locator('[data-view^="item:"]').count(), 0);
        catalog.detailMode = "normal";
        await tv.page.getByRole("button", { name: "Try again", exact: true }).click();
        await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.plays.length) === 1, "explicit retry resolves");
    });
}

for (const cancel of ["Back", "profile", "logout"] as const) {
    journey(`Continue ${cancel} cancels an already processed late answer`, async tv => {
        const held = tv.fake.hold("/catalog/items/movie%3Am0001", true);
        await tv.page.locator('[data-section="resume/opaque"] [data-focus="movie:m0001"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => tv.fake.requests.some(request => request.path.split("?")[0] === "/catalog/items/movie%3Am0001"), "resolution");
        if (cancel === "Back") await tv.remote(10009);
        else if (cancel === "logout") await tv.page.evaluate(() => window.browseHarness.logout());
        else await tv.page.evaluate(() => window.browseHarness.clearProfile());
        held.release();
        await tv.jump(30000);
        assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 0);
        if (cancel === "Back") { assert.equal(await tv.focused(), "movie:m0001"); assert.equal(await tv.page.locator('[data-view="home"]').count(), 1); }
        else assert.equal(await tv.page.locator('.browse').count(), 0);
    });
}

journey("Continue network failure never sends playback and Retry resolves only on activation", async tv => {
    tv.offline = true;
    await tv.page.locator('[data-section="resume/opaque"] [data-focus="movie:m0001"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.jump(1000);
    await tv.page.getByRole("alert").waitFor();
    assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 0);
    tv.offline = false;
    await tv.jump(30000);
    assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 0);
    await tv.page.getByRole("button", { name: "Try again", exact: true }).click();
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.plays.length) === 1, "explicit network retry");
});

journey("expanded Continue keeps episode cards and resumes while ordinary rows still open Details", async tv => {
    await tv.page.locator('[data-focus="expand:resume/opaque"]').click();
    await tv.page.locator('[data-view="homeSection:resume/opaque"] [data-focus="episode:s1e12"]').click();
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.plays.length) === 1, "expanded episode handoff");
    await tv.page.evaluate(() => window.browseHarness.resume());
    await tv.page.locator('[data-view="homeSection:resume/opaque"] .browse-card').first().waitFor();
    assert.equal(await tv.focused(), "episode:s1e12");
    await tv.remote(10009);
    await tv.page.locator('[data-section="because/opaque"] [data-focus="movie:m0005"]').click();
    await tv.page.locator('[data-view="item:movie:m0005"]').waitFor();
    assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 1);
});

journey("an expanded loading row owns focus and Back discards its late answer", async (tv, catalog) => {
    const held = tv.fake.hold("/catalog/query", true);
    const produced = sectionReplyProduced(catalog);
    const cancelled = tv.page.waitForEvent("requestfailed", request => new URL(request.url()).pathname === "/api/v2/catalog/query");
    await tv.page.locator('[data-focus="expand:recent/12"]').click();
    await tv.page.getByRole("status", { name: "Loading Recently Added in Movies", exact: true }).waitFor();
    assert.equal(await tv.focused(), "state");
    await tv.remote(10009);
    await cancelled;
    held.release();
    await produced;
    await tv.page.clock.runFor(0);
    assert.equal(await tv.focused(), "expand:recent/12");
    assert.equal(await tv.page.locator(".section-catalog-grid").count(), 0);
});

journey("a failed section append retains its cards and offers an explicit retry", async tv => {
    await tv.page.locator('[data-focus="expand:recent/12"]').click();
    await tv.page.locator('.section-catalog-grid .browse-card').first().waitFor();
    let fail = true;
    await tv.page.route("**/api/v2/catalog/query?*", async route => {
        if (fail) { fail = false; await route.fulfill({ status: 422, contentType: "application/problem+json", json: problem(422, "validation_failed", "Could not read row").body }); }
        else await route.fallback();
    });
    await tv.page.locator('.section-catalog-grid .browse-card').last().evaluate(node => node.scrollIntoView({ block: "end" }));
    await tv.page.getByRole("alert").waitFor();
    assert.equal(await tv.page.locator('.section-catalog-grid .browse-card').count(), 60);
    const recovered = tv.page.waitForResponse(reply => new URL(reply.url()).pathname === "/api/v2/catalog/query" && reply.ok());
    await tv.page.getByRole("button", { name: "Try again", exact: true }).click();
    assert.equal(await (await recovered).finished(), null);
    assert.deepEqual((await recovered).request().postDataJSON(), { source: "section", scope: "home", section_id: "recent/12", limit: 60 });
    await tv.page.clock.runFor(0);
    await tv.eventually(async () => await tv.page.getByRole("alert").count() === 0 && await tv.page.locator('.section-catalog-grid .browse-card').count() >= 60, "row recovered");
});

journey("a late expanded row answer cannot cross a profile switch", async (tv, catalog) => {
    const held = tv.fake.hold("/catalog/query", true);
    const produced = sectionReplyProduced(catalog);
    const cancelled = tv.page.waitForEvent("requestfailed", request => new URL(request.url()).pathname === "/api/v2/catalog/query");
    await tv.page.locator('[data-focus="expand:recent/12"]').click();
    await tv.page.getByRole("status", { name: "Loading Recently Added in Movies", exact: true }).waitFor();
    await tv.page.evaluate(() => window.browseHarness.clearProfile());
    await cancelled;
    assert.equal(await tv.page.evaluate(() => window.browseHarness.selectProfile("p-kid", "2468")), "verified");
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.page.locator('[data-view="home"] [data-section="kids_picks"]').waitFor();
    const focus = await tv.focused();
    held.release();
    await produced;
    await tv.page.clock.runFor(0);
    assert.equal(await tv.focused(), focus);
    assert.equal(await tv.page.locator(".section-catalog-grid").count(), 0);
    assert.equal(await tv.page.locator('[data-section="recent/12"]').count(), 0);
    assert.equal(await tv.page.locator('[data-section="kids_picks"]').count(), 1);
});

journey("Home expansion empty, missing and failed reads retain reachable controls", async (tv, catalog) => {
    const home = catalog.households.get("p-owner");
    assert.ok(home);
    const recent = home.sections.find(row => row.id === "recent/12");
    assert.ok(recent);
    recent.items = [];
    await tv.page.locator('[data-focus="expand:recent/12"]').click();
    await tv.page.getByText("Nothing here yet", { exact: true }).waitFor();
    assert.equal(await tv.focused(), "state");
    await tv.remote(10009);
    home.sections = home.sections.filter(row => row !== recent);
    await tv.page.locator('[data-focus="expand:recent/12"]').click();
    await tv.page.getByText("Row unavailable", { exact: true }).waitFor();
    assert.equal(await tv.focused(), "state");
    await tv.remote(10009);
    assert.equal(await tv.focused(), "expand:recent/12");
});

interface CardBox { id: string; left: number; width: number }

/** Centres of the row's cards, including Explore all, in visual order. */
async function rowBoxes(tv: Tv, section: string): Promise<CardBox[]> {
    return tv.page.locator(`[data-section="${section}"] .browse-card`).evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect();
        return { id: node.getAttribute("data-focus") ?? "", left: rect.left, width: rect.width };
    }));
}

function nearestBox(boxes: readonly CardBox[], x: number): CardBox {
    const centre = (box: CardBox): number => box.left + box.width / 2;
    return boxes.reduce((best, box) => Math.abs(centre(box) - x) < Math.abs(centre(best) - x) ? box : best);
}

journey("Home Down keeps the column across poster and still rows, including a row already visited", async tv => {
    const stills = await rowBoxes(tv, "recent-tv");
    const posters = await rowBoxes(tv, "recent-movies");
    assert.equal(await tv.focused(), stills[0]?.id);
    await tv.page.keyboard.press("ArrowDown");
    const firstLanding = await tv.focused();
    assert.equal(firstLanding, nearestBox(posters, (stills[0]?.left ?? 0) + (stills[0]?.width ?? 0) / 2).id);
    await tv.page.keyboard.press("ArrowUp");
    assert.equal(await tv.focused(), stills[0]?.id);
    await tv.page.keyboard.press("ArrowRight");
    await tv.page.keyboard.press("ArrowRight");
    const origin = await tv.focused();
    const source = (await rowBoxes(tv, "recent-tv")).find(box => box.id === origin);
    assert.ok(source !== undefined);
    assert.notEqual(origin, stills[0]?.id);
    const posterBoxes = await rowBoxes(tv, "recent-movies");
    await tv.page.keyboard.press("ArrowDown");
    const landed = await tv.focused();
    const column = nearestBox(posterBoxes, source.left + source.width / 2).id;
    assert.equal(landed, column, "Down from a later still lands on the poster nearest that column");
    assert.notEqual(landed, firstLanding, "a poster row visited before does not restore its first card");
    await tv.page.keyboard.press("ArrowRight");
    await tv.page.keyboard.press("ArrowRight");
    const movedId = await tv.focused();
    const moved = (await rowBoxes(tv, "recent-movies")).find(box => box.id === movedId);
    assert.ok(moved !== undefined);
    const stillTargets = await rowBoxes(tv, "recent-tv");
    await tv.page.keyboard.press("ArrowUp");
    assert.equal(await tv.focused(), nearestBox(stillTargets, moved.left + moved.width / 2).id, "Up follows the column rather than the still last focused in that row");
}, catalog => {
    const home = catalog.households.get("p-owner");
    assert.ok(home !== undefined);
    home.sections = [
        { id: "recent-tv", sectionType: "recently_added", title: "Recently Added TV", items: ["episode:s1e11", "episode:s1e12", "episode:s1e13", "episode:s1e21"] },
        { id: "recent-movies", sectionType: "recently_added", title: "Recently Added", items: ["movie:m0008", "movie:m0009", "movie:m0010", "movie:m0011", "movie:m0012", "movie:m0013", "movie:m0014"] },
    ];
});

journey("Down from a landscape card uses that card, and Up from a poster still uses the column", async tv => {
    const stills = await rowBoxes(tv, "resume");
    const posters = await rowBoxes(tv, "recent-movies");
    const posterColumn = posters[1];
    assert.ok(stills[0] !== undefined && posterColumn !== undefined);
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), posters[0]?.id, "the first Down from the wide card uses that card");
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.focused(), posterColumn.id);
    await tv.page.keyboard.press("ArrowUp");
    const focusedWide = await tv.focused();
    const wide = (await rowBoxes(tv, "resume")).find(box => box.id === focusedWide);
    assert.ok(wide !== undefined);
    assert.equal(wide.id, nearestBox(await rowBoxes(tv, "resume"), posterColumn.left + posterColumn.width / 2).id, "Up from a poster lands on the still nearest that column");
    await tv.page.keyboard.press("ArrowDown");
    const landed = await tv.focused();
    assert.equal(landed, nearestBox(posters, wide.left + wide.width / 2).id, "Down from the landscape card uses its own position");
    assert.notEqual(landed, posterColumn.id, "the remembered poster column does not pull the landing sideways");
}, catalog => {
    const home = catalog.households.get("p-owner");
    assert.ok(home !== undefined);
    home.sections = [
        { id: "resume", sectionType: "continue_watching", title: "Continue Watching", items: ["episode:s1e11", "episode:s1e12", "episode:s1e13"] },
        { id: "recent-movies", sectionType: "recently_added", title: "Recently Added", items: ["movie:m0008", "movie:m0009", "movie:m0010", "movie:m0011", "movie:m0012", "movie:m0013", "movie:m0014"] },
    ];
});

function logoSvg(width: number, height: number): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#fff"/></svg>`;
}

/** Painted logo inside the slot. `object-fit: contain` and `object-position: left center`. */
async function paintedLogo(tv: Tv): Promise<{ slotTop: number; slotLeft: number; slotWidth: number; slotHeight: number; paintTop: number; paintLeft: number; paintWidth: number; paintHeight: number; fit: string }> {
    const image = tv.page.locator(".skyline-marquee-layer:not(.skyline-outgoing) img.skyline-logo");
    await image.waitFor();
    return image.evaluate(node => {
        const art = node as HTMLImageElement;
        const box = art.getBoundingClientRect();
        const slot = art.parentElement?.getBoundingClientRect();
        if (slot === undefined) throw new Error("missing logo slot");
        const scale = Math.min(box.width / art.naturalWidth, box.height / art.naturalHeight);
        const paintWidth = art.naturalWidth * scale;
        const paintHeight = art.naturalHeight * scale;
        const position = getComputedStyle(art).objectPosition.trim().split(/\s+/);
        const horizontal = position[0] === "left" || position[0] === "0%" ? 0 : position[0] === "center" || position[0] === "50%" ? 0.5 : position[0] === "right" || position[0] === "100%" ? 1 : Number.NaN;
        const vertical = position[1] === "top" || position[1] === "0%" ? 0 : position[1] === "center" || position[1] === "50%" ? 0.5 : position[1] === "bottom" || position[1] === "100%" ? 1 : Number.NaN;
        return {
            slotTop: slot.top, slotLeft: slot.left, slotWidth: slot.width, slotHeight: slot.height,
            paintLeft: box.left + horizontal * (box.width - paintWidth),
            paintTop: box.top + vertical * (box.height - paintHeight),
            paintWidth, paintHeight, fit: getComputedStyle(art).objectFit,
        };
    });
}

function near(actual: number, expected: number, label: string): void {
    assert.ok(Math.abs(actual - expected) < 0.5, `${label}: ${actual} vs ${expected}`);
}

journey("Down from the top bar lands on the leftmost card", async tv => {
    const posters = () => rowBoxes(tv, "recent-movies");
    const first = (await posters())[0];
    assert.ok(first !== undefined);
    assert.equal(await tv.focused(), first.id);
    await tv.page.keyboard.press("ArrowRight");
    await tv.page.keyboard.press("ArrowRight");
    const remembered = await tv.focused();
    assert.notEqual(remembered, first.id);
    await tv.page.keyboard.press("ArrowUp");
    assert.equal(await tv.focused(), "home");
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), first.id, "Down from the bar ignores the card remembered in the row");
    await tv.page.keyboard.press("ArrowDown");
    const next = await rowBoxes(tv, "because-movies");
    assert.equal(await tv.focused(), nearestBox(next, first.left + first.width / 2).id, "the next Down keeps that card's column");
    await tv.page.keyboard.press("ArrowUp");
    await tv.page.keyboard.press("ArrowRight");
    const opened = await tv.focused();
    await tv.page.keyboard.press("Enter");
    await tv.page.locator(`[data-view="item:${opened}"]`).waitFor();
    await tv.remote(10009);
    assert.equal(await tv.focused(), opened, "Back from a pushed page restores the card");
}, catalog => {
    const home = catalog.households.get("p-owner");
    assert.ok(home !== undefined);
    home.sections = [
        { id: "recent-movies", sectionType: "recently_added", title: "Recently Added", items: ["movie:m0008", "movie:m0009", "movie:m0010", "movie:m0011"] },
        { id: "because-movies", sectionType: "because_you_watched", title: "Because you watched", items: ["movie:m0012", "movie:m0013", "movie:m0014", "movie:m0015"] },
    ];
});

journey("Home Highway Patrol aspect art retains Apple's measured slot and painted top", async tv => {
    await tv.page.route("**/art/highway-logo.svg*", route => route.fulfill({ status: 200, contentType: "image/svg+xml", body: logoSvg(650, 102) }));
    await tv.page.locator('[data-section="because/opaque"] [data-focus="movie:m0005"]').focus();
    await tv.jump(300);
    const logo = await paintedLogo(tv);
    near(logo.slotTop, 143, "measured Home slot top");
    near(logo.slotHeight, 200, "fixed Home slot height");
    near(logo.paintTop, 174.3, "measured Home Highway Patrol painted top");
    near(logo.paintWidth, 880, "Home fits wide art to its width");
}, catalog => {
    enrichHome(catalog, { "movie:m0005": { logo_url: "/art/highway-logo.svg", overview: "A two-line hero synopsis that fills the marquee stack the signed comparison measured." } });
    enrichDetails(catalog, { "movie:m0005": { logo_url: "/art/highway-logo.svg" } });
});

journey("Hero title art scales to fit and centres in Apple's home logo slot", async tv => {
    await tv.page.route("**/art/full-logo.svg*", route => route.fulfill({ status: 200, contentType: "image/svg+xml", body: logoSvg(880, 200) }));
    await tv.page.route("**/art/wide-logo.svg*", route => route.fulfill({ status: 200, contentType: "image/svg+xml", body: logoSvg(880, 130) }));
    await tv.page.route("**/art/small-logo.svg*", route => route.fulfill({ status: 200, contentType: "image/svg+xml", body: logoSvg(296, 124) }));
    const show = async (selector: string): Promise<void> => {
        await tv.page.locator(selector).focus();
        await tv.jump(300);
    };
    await show('[data-section="hero/opaque"] [data-focus="movie:m0004"]');
    const full = await paintedLogo(tv);
    await show('[data-section="because/opaque"] [data-focus="movie:m0005"]');
    const wide = await paintedLogo(tv);
    await show('[data-section="for/you"] [data-focus="movie:m0007"]');
    const small = await paintedLogo(tv);
    const homeMarquee = await tv.page.locator(".browse > .skyline-marquee").evaluate(node => {
        const rect = node.getBoundingClientRect();
        return [rect.x, rect.y, rect.width, rect.height];
    });
    assert.equal(full.slotHeight, 200, "Apple SiloTheme.Skyline.marqueeLogoMaxHeightHome");
    assert.equal(wide.slotHeight, 200);
    assert.equal(full.slotWidth, 880, "Apple SiloTheme.Skyline.marqueeLogoMaxWidth");
    assert.equal(wide.fit, "contain", "Apple titleSlot uses aspectRatio contentMode fit");
    // Replaced assertions that encoded the old pin: wide.imageHeight < 200, wide.imageTop === full.imageTop,
    // and wide.imageTop === wide.slotTop. Those measured the image element pinned to the top of the slot.
    // Replaced the measured slot top of 146. TVFocusMarquee's 27pt stack rows put the slot at y143.
    near(full.slotTop, 143, "the home logo slot uses the marquee stack");
    near(wide.paintHeight, 130, "wide art keeps its aspect inside the slot");
    near(wide.paintTop, wide.slotTop + (200 - 130) / 2, "short art is vertically centred in the 200px slot");
    near(wide.paintTop, 143 + 35, "centred wide art follows the slot");
    near(wide.paintLeft, wide.slotLeft, "fitted art stays on the leading edge");
    near(wide.slotTop, full.slotTop, "the slot stays full height, so short art does not drop the block");
    near(small.paintHeight, 200, "small art scales up to the home slot height");
    near(small.paintWidth, 296 * 200 / 124, "small art scales up with its aspect");
    near(small.paintLeft, small.slotLeft, "upscaled art stays on the leading edge");
    assert.deepEqual(homeMarquee, [88, 256, 880, 280]);

    await tv.page.locator('[data-focus="movies"]').click();
    await tv.page.locator('[data-view="library:12"] .browse-card').first().focus();
    await tv.jump(300);
    const library = await paintedLogo(tv);
    const libraryMarquee = await tv.page.locator(".browse > .skyline-marquee").evaluate(node => {
        const rect = node.getBoundingClientRect();
        return [rect.x, rect.y, rect.width, rect.height];
    });
    assert.equal(await tv.page.locator(".browse").evaluate(node => node.classList.contains("skyline-home")), true, "library Recommended uses the shared home scene");
    assert.equal(library.slotHeight, 200, "library Recommended uses the home logo slot, not the unused 150px library scale");
    near(library.paintTop, library.slotTop + (200 - 130) / 2, "library art is centred in the same slot");
    assert.deepEqual(libraryMarquee, homeMarquee, "TVSkylineSectionFeed uses the home marquee on library Recommended");

    await tv.page.locator('[data-focus="for_you"]').click();
    await tv.page.locator('[data-view="for_you"] .browse-card').first().focus();
    await tv.jump(300);
    const forYou = await paintedLogo(tv);
    assert.equal(forYou.slotHeight, 200, "For You uses the home logo slot");
    near(forYou.paintHeight, 200, "For You scales small art up to the slot");
    near(forYou.paintWidth, 296 * 200 / 124, "For You keeps the small art's aspect");

    await tv.page.keyboard.press("Enter");
    await tv.page.locator(".details-logo").waitFor();
    const details = await tv.page.locator(".details-logo").evaluate(node => {
        const art = node.getBoundingClientRect();
        const slot = node.parentElement?.getBoundingClientRect();
        return { art: art.bottom, slot: slot?.bottom, height: art.height };
    });
    assert.equal(details.art, details.slot, "Details title art stays at the bottom of its 160px heading");
    assert.ok(details.height < 180);
}, catalog => {
    const overview = "A two-line hero synopsis that fills the marquee stack the signed comparison measured.";
    enrichHome(catalog, {
        "movie:m0004": { logo_url: "/art/full-logo.svg", overview },
        "movie:m0005": { logo_url: "/art/wide-logo.svg", overview },
        "movie:m0007": { logo_url: "/art/small-logo.svg", overview },
    });
    enrichDetails(catalog, { "movie:m0001": { logo_url: "/art/wide-logo.svg" } });
    const route = catalog.route.bind(catalog);
    catalog.route = (method, path, profile, body) => {
        const pathname = new URL(path, "https://fake.invalid").pathname;
        if (pathname === "/recommendations/discover") {
            return { status: 200, body: { items: [{ type: "popular", title: "For You", kind: "popular", items: [{ content_id: "movie:m0001", type: "movie", title: "Movie 0001", logo_url: "/art/small-logo.svg" }] }] } };
        }
        const reply = route(method, path, profile, body);
        if (reply?.status !== 200 || !/^\/library\/[^/]+\/sections$/.test(pathname)) return reply;
        const data = reply.body as { sections: { items: Record<string, unknown>[] }[] };
        return { ...reply, body: { ...data, sections: data.sections.map((row, rowIndex) => rowIndex > 0 ? row : { ...row, items: row.items.map((item, index) => index === 0 ? { ...item, logo_url: "/art/wide-logo.svg" } : item) }) } };
    };
});
