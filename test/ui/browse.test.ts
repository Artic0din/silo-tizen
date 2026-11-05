import { selectLibraryMode } from "./support/library.ts";
// The native browse screens, driven by remote keys in Chromium against the fake Silo household.
// Desktop Chromium is not the TV's Chromium 108: this proves behavior, not TV rendering.

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeRequests } from "../native/support/fakeRequests.ts";
import type { Reply } from "../native/support/fakeSilo.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { CARD_OVERLAYS_KEY, CARD_PRESENTATION_KEY } from "../../src/contracts/v2/settings.ts";
import { fixture, problem } from "../native/support/fakeSilo.ts";
import { homeDetailsRead, launchBrowser, openTv, type Tv } from "./support/tv.ts";

const BACK = 10009;
const IME_DONE = 65376;
const PAGE_SIZE = 24;

class SearchCatalog extends FakeRequests {
    peopleFailure = false;
    override route(method: string, path: string, profileId: string | undefined, body?: Record<string, unknown>): Reply | undefined {
        if (new URL(path, "https://fake.invalid").pathname === "/catalog/people") return this.peopleFailure
            ? problem(503, "unavailable", "Unavailable")
            : { status: 200, body: { items: [{ id: "7", name: "River Vale", photo_url: "/art/river.svg" }] } };
        return super.route(method, path, profileId, body);
    }
}

class SearchEdgeCatalog extends SearchCatalog {
    override route(method: string, path: string, profileId: string | undefined, body?: Record<string, unknown>): Reply | undefined {
        const pathname = new URL(path, "https://fake.invalid").pathname;
        if (pathname === "/catalog/people") return { status: 200, body: { items: Array.from({ length: 20 }, (_, index) => ({
            id: `edge-${index}`, name: index === 4 ? "Armando Tomas Mulato" : index === 5 ? "Berengaria Tomkies" : `Person ${index + 1}`,
        })) } };
        if (pathname === "/requests/search") return { status: 200, body: { page: 1, total_pages: 1, total_results: 12,
            results: Array.from({ length: 12 }, (_, index) => ({ ...this.title(), tmdb_id: 949 + index, title: `Request ${index + 1}` })),
        } };
        return super.route(method, path, profileId, body);
    }
}

browseTest("Search filter focus applies immediately and cancels superseded reads", async tv => {
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", "Movie 0001"); await tv.remote(IME_DONE);
    await tv.page.locator('.browse-grid [data-focus="movie:m0001"]').waitFor();
    const held = tv.fake.hold("/catalog", true);
    await tv.page.locator('[data-focus="search-filter:movie"]').focus();
    await tv.eventually(async () => browseReads(tv, "/catalog").length === 2, "Movies read on focus without Select");
    const cancelled = tv.page.waitForEvent("requestfailed", request => new URL(request.url()).pathname === "/api/v2/catalog");
    await press(tv, "ArrowRight");
    await cancelled;
    await tv.eventually(async () => browseReads(tv, "/catalog").length === 3, "Series supersedes Movies");
    held.release();
    await shows(tv, "Try a different search term");
    assert.equal(await tv.focused(), "search-filter:series");
    assert.equal(await tv.page.locator('[data-focus="search-filter:series"]').getAttribute("aria-pressed"), "true");
    assert.equal(await tv.page.locator('.browse-grid .browse-card').count(), 0, "late Movies answer cannot replace Series");
});

for (const reduced of [false, true]) {
    browseTest(`Search spatial entry and filter scroll preserve Back identity: ${reduced ? "reduced" : "normal"} motion`, async tv => {
        await tv.page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
        await tv.page.locator('[data-focus="search"]').click();
        await tv.page.fill("#browse-search", "Movie 0001"); await tv.remote(IME_DONE);
        await tv.page.locator('[data-focus="person:edge-1"]').waitFor({ state: "attached" });
        await tv.page.locator('.browse-grid .browse-card').waitFor();
        await tv.page.locator('[data-focus="person:edge-1"]').focus();
        await press(tv, "ArrowDown"); await tv.jump(250);
        assert.equal(await tv.focused(), "movie:m0001");
        const offset = await tv.page.locator('.browse').evaluate(node => node.scrollTop);
        assert.ok(offset > 0);
        assert.equal(await tv.page.locator('.search-navigation-title').evaluate(node => getComputedStyle(node).position), "absolute", "scrolling alone does not show the navigation title");
        assert.ok(await tv.page.locator('.browse-grid .browse-card').evaluate(node => node.getBoundingClientRect().bottom <= 978), "focused captions retain the native 103px bottom clearance");
        await press(tv, "Enter"); await showing(tv, "item:movie:m0001");
        await tv.remote(BACK); await showing(tv, "search"); await tv.jump(250);
        assert.equal(await tv.focused(), "movie:m0001", "Back keeps section and item identity");
        assert.equal(await tv.page.locator('.browse').evaluate(node => node.scrollTop), offset);
        await tv.eventually(async () => tv.page.locator('.search-navigation-title').evaluate(node => getComputedStyle(node).position === "fixed" && getComputedStyle(node).color === "rgba(237, 237, 237, 0.3)"), "restored scrolled navigation title");
        await press(tv, "ArrowUp", "ArrowUp"); await tv.jump(250);
        assert.equal(await tv.page.locator('.browse').evaluate(node => node.scrollTop), 0, "Up to filters restores the search field");
        await tv.page.fill("#browse-search", "Tom"); await tv.remote(IME_DONE);
        await tv.page.locator('[data-focus="movie:960"]').waitFor({ state: "attached" });
        await tv.page.locator('[data-focus="person:edge-3"]').focus();
        await press(tv, "ArrowDown"); await tv.jump(250);
        assert.equal(await tv.focused(), "movie:952", "Requests entry follows origin geometry");
    }, { catalog: new SearchEdgeCatalog() });
}

browseTest("Search spatial People entry chooses the nearest title column", async tv => {
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", "Movie 000"); await tv.remote(IME_DONE);
    await tv.page.locator('.browse-grid [data-focus="movie:m0002"]').waitFor();
    await tv.page.locator('[data-focus="person:edge-1"]').focus();
    const reads = tv.fake.requests.length;
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "movie:m0002");
    await press(tv, "ArrowUp");
    await tv.jump(250);
    await tv.page.waitForTimeout(260);
    const upFromFirst = await tv.page.evaluate(() => {
        const field = document.querySelector("#browse-search")?.getBoundingClientRect();
        const pills = document.querySelector(".search-filters")?.getBoundingClientRect();
        const focused = document.activeElement?.getBoundingClientRect();
        return {
            scroll: document.querySelector(".browse")?.scrollTop ?? -1,
            fieldTop: field?.top,
            fieldBottom: field?.bottom,
            pillsTop: pills?.top,
            pillsBottom: pills?.bottom,
            ringTop: focused?.top,
        };
    });
    assert.equal(upFromFirst.scroll, 0, "Up from the first title row returns to the top");
    assert.ok((upFromFirst.fieldTop ?? -1) >= 0 && (upFromFirst.fieldBottom ?? 0) > 40, `the keyboard stays visible, got ${upFromFirst.fieldTop}`);
    assert.ok((upFromFirst.pillsTop ?? -1) >= 0 && (upFromFirst.pillsBottom ?? 0) <= 1080, `the filter pills stay visible, got ${upFromFirst.pillsTop}`);
    assert.ok(Math.abs((upFromFirst.ringTop ?? 0) - 495) < 40, `Up from the first title row rests the ring near 495, got ${upFromFirst.ringTop}`);
    await tv.page.locator('[data-focus="movie:m0002"]').focus();
    await press(tv, "ArrowDown", "ArrowDown");
    assert.equal(await tv.focused(), "movie:950");
    await tv.jump(250);
    await press(tv, "ArrowUp");
    assert.equal(await tv.focused(), "movie:m0008", "Up from Requests enters the adjacent bottom grid row");
    await tv.jump(250);
    await tv.page.waitForTimeout(260);
    const revealed = await tv.page.evaluate(() => document.querySelector('[data-focus="movie:m0008"] .browse-art')?.getBoundingClientRect().top);
    // The old pin was 160.4px (before that, 171px), measured on a different path. Up rests this ring at 495.
    // The pills stay with the first-row return above: this bottom card sits a full results column below them.
    const searchRevealTop = 495;
    assert.ok(Math.abs((revealed ?? 0) - searchRevealTop) < 1, `Search upward reveal keeps the focused poster at ${searchRevealTop}px; the old pin was 160.4px, got ${revealed}`);
    assert.equal(await tv.page.locator('.search-navigation-title').evaluate(node => getComputedStyle(node).position), "absolute", "deep directional navigation does not show the navigation title");
    assert.equal(tv.fake.requests.length, reads);
}, { catalog: new SearchEdgeCatalog() });

browseTest("Search cards show the Returning badge Home and library already draw", async (tv, catalog) => {
    const read = catalog.route.bind(catalog);
    catalog.route = (method, path, profile, body) => {
        const reply = read(method, path, profile, body);
        const url = new URL(path, "https://fake.invalid");
        if (url.pathname !== "/catalog" || reply?.status !== 200 || url.searchParams.get("q") === null) return reply;
        const response = reply.body as { items?: Record<string, unknown>[] };
        if (!Array.isArray(response.items)) return reply;
        return { ...reply, body: { ...response, items: response.items.map(item => item.content_id === "series:s1" ? { ...item, show_status: "returning series" } : item) } };
    };
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", "Harbor");
    await tv.remote(IME_DONE);
    const card = tv.page.locator('.browse-grid [data-focus="series:s1"]');
    await card.waitFor();
    await tv.eventually(async () => await card.locator(".card-overlay").evaluate(node => node.textContent) === "Returning", "Search Returning badge");
}, { beforeConnect: tv => {
    const settings = new FakeSettings(tv.fake);
    settings.overlayConfig = { enabled: true };
    settings.profile().set(CARD_OVERLAYS_KEY, { version: 2, preset: "classic", order: ["show_status"], items: { show_status: { enabled: true, position: "top-right" } } });
} });

browseTest("Related shelf omits the watched badge Apple leaves off the similar card", async tv => {
    await tv.page.route("**/api/v2/recommendations/similar/**", async route => {
        const items = Array.from({ length: 24 }, (_, index) => ({
            content_id: `movie:m${String(index + 2).padStart(4, "0")}`,
            type: "movie",
            title: index === 0 ? "Mercy" : `Movie ${String(index + 2).padStart(4, "0")}`,
            poster_url: `/art/movie-${index + 2}.svg`,
            ...(index === 0 ? { user_state: { played: true } } : {}),
        }));
        await route.fulfill({ json: { items } });
    });
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    const mercy = tv.page.locator('[data-detail-section="related"] [data-focus="movie:m0002"]');
    await mercy.waitFor();
    assert.equal(await mercy.locator(".browse-watched").count(), 0, "user_state.played is set, and the related card still has no watched badge");
    assert.match(await mercy.innerText(), /Mercy/);
});

for (const coldStart of [false, true]) {
browseTest(`Search retains the filter column through default People and ragged grid entry${coldStart ? " from the field on a cold visit" : ""}`, async tv => {
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", "Movie 000"); await tv.remote(IME_DONE);
    await tv.page.locator('.browse-grid [data-focus="movie:m0002"]').waitFor();
    await tv.page.locator('[data-focus="person:edge-0"]').waitFor({ state: "attached" });
    await tv.page.locator('[data-focus="movie:951"]').waitFor({ state: "attached" });
    if (coldStart) {
        assert.equal(await tv.focused(), "query");
        await press(tv, "ArrowDown");
    } else await tv.page.locator('[data-focus="search-filter:all"]').focus();
    assert.equal(await tv.focused(), "search-filter:all");
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "person:edge-0", "People owns its default entry");
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "movie:m0002", "default People entry keeps All's horizontal navigation axis");
    await press(tv, "ArrowDown", "ArrowDown");
    assert.equal(await tv.focused(), "movie:951", "ragged grid entry keeps the same axis into Requests");
}, { catalog: new SearchEdgeCatalog(), beforeConnect: tv => {
    new FakeSettings(tv.fake).profile().set(CARD_PRESENTATION_KEY, { poster_size: "compact", caption: "title_metadata" });
} });
}

browseTest("Search field and no-results spacing use the native presentation", async tv => {
    await tv.page.locator('[data-focus="search"]').click();
    assert.deepEqual(await tv.page.locator('#browse-search').evaluate(node => {
        const style = getComputedStyle(node);
        return [style.fontSize, style.borderWidth, style.backgroundColor, getComputedStyle(node, '::-webkit-search-cancel-button').getPropertyValue('-webkit-appearance')];
    }), ["56px", "0px", "rgba(0, 0, 0, 0)", "none"]);
    assert.equal(await tv.page.locator('.search-field-icon svg').count(), 1);
    assert.deepEqual(await tv.page.locator('.search-field-icon svg').evaluate(node => {
        const rect = node.getBoundingClientRect();
        return [rect.width, rect.height];
    }), [56, 56]);
    const prompt = await tv.page.locator('.search-prompt').boundingBox();
    assert.equal(prompt?.y, 438, "true empty state keeps its existing position");
    await tv.page.fill("#browse-search", "bbbbbb"); await tv.remote(IME_DONE);
    await shows(tv, "No results");
    assert.equal(await tv.page.locator('.search-empty .search-state-icon').evaluate(node => node.getBoundingClientRect().top), 568);
    assert.equal(await tv.page.locator('.search-empty .search-state-title').evaluate(node => node.getBoundingClientRect().top), 628);
});

for (const reduced of [false, true]) {
    browseTest(`Search keeps a later request visible when People arrives: ${reduced ? "reduced" : "normal"} motion`, async tv => {
        await tv.page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
        const people = tv.fake.hold("/catalog/people", true);
        await tv.page.locator('[data-focus="search"]').click();
        await tv.page.fill("#browse-search", "Tom"); await tv.remote(IME_DONE);
        await tv.page.locator('[data-focus="movie:960"]').waitFor({ state: "attached" });
        await press(tv, "ArrowDown", "ArrowDown");
        for (let step = 0; step < 11; step++) await press(tv, "ArrowRight");
        await tv.jump(250);
        assert.equal(await tv.focused(), "movie:960");
        const visible = (): Promise<boolean> => tv.page.locator('[data-focus="movie:960"]').evaluate(card => {
            const row = card.closest('.browse-row')!.getBoundingClientRect();
            const viewport = document.querySelector('.browse')!.getBoundingClientRect();
            const rect = card.getBoundingClientRect();
            return rect.left >= row.left && rect.right <= row.right && rect.top >= viewport.top && rect.bottom <= viewport.bottom - 64;
        });
        await tv.eventually(visible, "later request revealed before People");
        const scroll = await tv.page.locator('.search-request-rail').evaluate(row => row.scrollLeft);
        const reads = tv.fake.requests.length;
        people.release();
        await tv.page.locator('[data-focus="person:edge-0"]').waitFor({ state: "attached" });
        assert.equal(await tv.focused(), "movie:960");
        assert.equal(await tv.page.locator('.search-request-rail').evaluate(row => row.scrollLeft), scroll, "rail insertion preserves horizontal scroll");
        await tv.jump(250);
        await tv.eventually(visible, "same-identity repaint reveals vertically displaced request");
        assert.equal(tv.fake.requests.length, reads);
    }, { catalog: new SearchEdgeCatalog() });
}

for (const reduced of [false, true]) {
    browseTest(`Search rails paint complete edge cards and preserve remote endpoints: ${reduced ? "reduced" : "normal"} motion`, async tv => {
        await tv.page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
        await tv.page.locator('[data-focus="search"]').click();
        await tv.page.fill("#browse-search", "Tom"); await tv.remote(IME_DONE);
        await tv.page.locator('[data-focus="person:edge-19"]').waitFor({ state: "attached" });
        await tv.page.locator('[data-focus="movie:960"]').waitFor({ state: "attached" });
        const paints = async (selector: string): Promise<boolean> => tv.page.locator(selector).evaluate(art => {
            const rect = art.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.right - 2, rect.top + rect.height / 2);
            return hit !== null && art.contains(hit);
        });
        assert.equal(await paints('[data-focus="person:edge-5"] .browse-art'), true, "the sixth portrait paints beyond the logical rail frame");
        const reads = tv.fake.requests.length;
        await press(tv, "ArrowDown", "ArrowDown");
        for (let step = 0; step < 5; step++) await press(tv, "ArrowRight");
        assert.equal(await tv.focused(), "person:edge-5");
        if (!reduced) {
            try { await tv.eventually(async () => Math.abs(await tv.page.locator('.search-people-rail').evaluate(row => row.scrollLeft) - 136) < 2, "native sixth-person scroll"); }
            catch (error) {
                console.error(await tv.page.locator('.search-people-rail').evaluate(row => ({ scroll: row.scrollLeft, right: getComputedStyle(row).getPropertyValue("--reveal-end"), card: document.activeElement?.getBoundingClientRect().toJSON() })));
                throw error;
            }
        }
        await press(tv, "ArrowDown");
        assert.equal(await tv.focused(), "movie:954", "entry follows the sixth person's centre");
        for (let step = 0; step < 5; step++) await press(tv, "ArrowLeft");
        await tv.eventually(async () => await paints('[data-focus="movie:955"] .browse-art'), "seventh poster paints completely");
        for (let step = 0; step < 6; step++) await press(tv, "ArrowRight");
        await tv.eventually(async () => Math.abs(await tv.page.locator('.search-request-rail').evaluate(row => row.scrollLeft) - 152) < 2, "native seventh-request scroll");
        for (let step = 0; step < 6; step++) await press(tv, "ArrowRight");
        assert.equal(await tv.focused(), "movie:960");
        await tv.eventually(async () => Math.abs(await tv.page.locator('.search-request-rail').evaluate(row => row.scrollLeft) - 1179) < 2, "native request end");
        assert.equal(await paints('[data-focus="movie:960"] .browse-art'), true);
        await press(tv, "ArrowUp");
        for (let step = 0; step < 15; step++) await press(tv, "ArrowRight");
        assert.equal(await tv.focused(), "person:edge-19");
        await tv.eventually(async () => Math.abs(await tv.page.locator('.search-people-rail').evaluate(row => row.scrollLeft) - 3696) < 2, "native People end");
        assert.equal(await paints('[data-focus="person:edge-19"] .browse-art'), true);
        if (reduced) assert.equal(await tv.page.locator('[data-focus="person:edge-19"]').evaluate(node => getComputedStyle(node).transform), "none");
        await press(tv, "ArrowUp", "ArrowUp");
        assert.equal(await tv.focused(), "query");
        await tv.eventually(async () => Math.abs(await tv.page.locator('#browse-search').evaluate(node => node.getBoundingClientRect().top) - 60) < 1, "native field position after returning Up");
        assert.equal(tv.fake.requests.length, reads, "painting and focus perform no API reads");
        await tv.remote(BACK); await showing(tv, "home");
    }, { catalog: new SearchEdgeCatalog(), beforeConnect: tv => {
        new FakeSettings(tv.fake).profile().set(CARD_PRESENTATION_KEY, { poster_size: "compact", caption: "title_metadata" });
    } });
}

browseTest("Search fills Person name lines without leaving a lone second-line word", async tv => {
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", "Tom"); await tv.remote(IME_DONE);
    const caption = tv.page.locator('[data-focus="person:edge-4"] .browse-card-title');
    await caption.waitFor();
    await tv.page.evaluate(async () => document.fonts.ready);
    await tv.eventually(async () => caption.evaluate(node => {
        const text = node.firstChild;
        if (text === null) return false;
        const top = (start: number, end: number): number => { const range = document.createRange(); range.setStart(text, start); range.setEnd(text, end); return range.getBoundingClientRect().top; };
        return top(0, 7) < top(8, 13) && top(8, 13) === top(14, 20);
    }), "native Armando / Tomas Mulato name balance");
    assert.equal(await caption.textContent(), "Armando Tomas Mulato");
}, { catalog: new SearchEdgeCatalog() });

for (const size of ["compact", "standard", "large"] as const) {
    browseTest(`Search ${size} posters use nonoverlapping columns and matching remote rows`, async tv => {
        await tv.page.locator('[data-focus="search"]').click();
        await tv.page.fill("#browse-search", "Movie"); await tv.remote(IME_DONE);
        const cards = tv.page.locator('.browse-grid .browse-card');
        await cards.first().waitFor();
        const columns = size === "large" ? 5 : 6;
        const geometry = await cards.evaluateAll(nodes => nodes.slice(0, 7).map(node => {
            const rect = node.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top };
        }));
        assert.equal(geometry.filter(card => card.top === geometry[0]?.top).length, columns);
        for (let index = 1; index < columns; index++) assert.ok(geometry[index]!.left >= geometry[index - 1]!.right, "adjacent posters do not overlap");
        const reads = tv.fake.requests.length;
        await cards.first().focus(); await press(tv, "ArrowDown");
        assert.equal(await tv.focused(), await cards.nth(columns).getAttribute("data-focus"));
        assert.equal(tv.fake.requests.length, reads, "row navigation performs no reads");
    }, { beforeConnect: tv => {
        new FakeSettings(tv.fake).profile().set(CARD_PRESENTATION_KEY, { poster_size: size, caption: "title_metadata" });
    } });
}

const pendingPeopleFailure = new SearchCatalog();
pendingPeopleFailure.searchCapabilities = { ...pendingPeopleFailure.searchCapabilities, people_media_scope: true };
browseTest("Search exposes catalog failure and remote retry while People is pending", async (tv, catalog) => {
    await tv.page.locator('[data-focus="search"]').click();
    const held = tv.fake.hold("/catalog/people", true);
    catalog.failNext("/catalog", problem(400, "validation_failed", "Unavailable"));
    await tv.page.fill("#browse-search", "Movie 0001"); await tv.remote(IME_DONE);
    await tv.eventually(async () => browseReads(tv, "/catalog/people").length === 1, "People remains held");
    await tv.page.getByRole("heading", { name: "Something went wrong", exact: true }).waitFor({ timeout: 2000 });
    assert.equal(await tv.page.getByRole("status", { name: "Searching", exact: true }).count(), 0);
    await tv.page.locator('[data-focus="search-filter:all"]').focus();
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "retry");
    await press(tv, "Enter");
    await tv.page.locator('.browse-grid [data-focus="movie:m0001"]').waitFor();
    held.release();
}, { catalog: pendingPeopleFailure });

browseTest("Search media filters use the native capsule shape", async tv => {
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", "Tom"); await tv.remote(IME_DONE);
    await tv.page.locator('[data-focus="person:edge-19"]').waitFor({ state: "attached" });
    await tv.page.locator('[data-focus="movie:960"]').waitFor({ state: "attached" });
    const shapes = await tv.page.evaluate(() => [".search-filters", '[data-focus="search-filter:all"]'].map(selector => {
        const node = document.querySelector<HTMLElement>(selector);
        if (node === null) throw new Error(`Missing ${selector}`);
        return { selector, radius: parseFloat(getComputedStyle(node).borderTopLeftRadius), height: node.clientHeight };
    }));
    for (const shape of shapes) assert.ok(shape.radius >= shape.height / 2, JSON.stringify(shape));
    const widths = await tv.page.locator('.search-filters button').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
    assert.ok(Math.max(...widths) - Math.min(...widths) < 1, "selection preserves equal media segments");
}, { catalog: new SearchEdgeCatalog() });

browseTest("Search releases rail visibility observers after query replacement and Back", async tv => {
    await tv.page.evaluate(() => {
        const Native = window.IntersectionObserver;
        let active = 0;
        const record = (): void => { document.documentElement.dataset.searchObservers = String(active); };
        window.IntersectionObserver = class extends Native {
            private active = true;
            constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) { super(callback, options); active++; record(); }
            override disconnect(): void { if (this.active) { this.active = false; active--; record(); } super.disconnect(); }
        };
        record();
    });
    const observers = (): Promise<string | undefined> => tv.page.evaluate(() => document.documentElement.dataset.searchObservers);
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", "Tom"); await tv.remote(IME_DONE);
    await tv.eventually(async () => await observers() === "2", "both accepted Search rails observed");
    await tv.page.fill("#browse-search", "x");
    await tv.eventually(async () => await observers() === "0", "obsolete rails released on edit");
    await tv.page.fill("#browse-search", "Tom"); await tv.remote(IME_DONE);
    await tv.eventually(async () => await observers() === "2", "replacement rails observed once");
    await tv.remote(BACK); await showing(tv, "home");
    await tv.eventually(async () => await observers() === "0", "Search observers released on Back");
}, { catalog: new SearchEdgeCatalog() });

const resumedPeople = new SearchCatalog();
resumedPeople.searchCapabilities = { ...resumedPeople.searchCapabilities, people_media_scope: true };
browseTest("Search resumes interrupted People independently on a retained later catalog page", async tv => {
    await tv.page.locator('[data-focus="search"]').click();
    const held = tv.fake.hold("/catalog/people", true);
    await tv.page.fill("#browse-search", "Movie"); await tv.remote(IME_DONE);
    await tv.eventually(async () => browseReads(tv, "/catalog/people").length === 1, "People started");
    await tv.page.getByRole("button", { name: "Next page", exact: true }).click();
    await tv.eventually(async () => browseReads(tv, "/catalog").length === 2, "second page");
    await tv.page.locator('.browse-grid .browse-card').first().click();
    await tv.eventually(async () => (await view(tv))?.startsWith("item:") === true, "title detail");
    const reads = browseReads(tv, "/catalog").length;
    held.release(); await tv.remote(BACK);
    await tv.page.locator('[data-focus="person:7"]').waitFor();
    assert.equal(browseReads(tv, "/catalog/people").length, 2);
    assert.equal(browseReads(tv, "/catalog").length, reads, "People resume preserves the catalog page");
}, { catalog: resumedPeople });

const peopleSearch = new SearchCatalog();
peopleSearch.searchCapabilities = { ...peopleSearch.searchCapabilities, people_media_scope: true };
browseTest("Search composition follows People, titles and supplementary Requests", async tv => {
    await tv.page.locator('[data-focus="search"]').click();
    assert.equal(await tv.page.locator('[data-focus="search-filter:all"]').count(), 0, "idle Search omits filters");
    await tv.page.fill("#browse-search", "Movie 0001"); await tv.remote(IME_DONE);
    await tv.page.locator('[data-focus="person:7"]').waitFor();
    await tv.page.locator('.browse-grid [data-focus="movie:m0001"]').waitFor();
    assert.equal(await tv.page.getByText("Page 1 of 1", { exact: true }).count(), 0, "a complete Search result needs no duplicate paging status");
    assert.equal(await tv.page.locator('[data-focus="person:7"]').evaluate(person => {
        const title = document.querySelector('.browse-grid [data-focus="movie:m0001"]');
        return title !== null && (person.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    }), true, "People appear before title results");
    await tv.page.fill("#browse-search", "River"); await tv.remote(IME_DONE);
    await tv.page.locator('[data-focus="person:7"]').waitFor();
    await tv.eventually(async () => browseReads(tv, "/catalog").length === 2, "People-only catalog response");
    assert.equal(await tv.page.getByText("0 results", { exact: true }).count(), 0, "People-only results omit the title count");
    assert.equal(await tv.page.getByText("No results", { exact: true }).count(), 0);
}, { catalog: peopleSearch });

browseTest("Search People is scoped, activates real identities and does not fetch on focus", async tv => {
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", "River"); await tv.remote(IME_DONE);
    await tv.page.locator('[data-focus="person:7"]').waitFor();
    assert.equal(await tv.page.getByText("No results", { exact: true }).count(), 0);
    const request = browseReads(tv, "/catalog/people")[0];
    assert.equal(new URL(request?.path ?? "", "https://fake.invalid").searchParams.get("media_scope"), "video_with_episodes");
    await tv.page.locator('[data-focus="person:7"] img').evaluate(image => image.dispatchEvent(new Event("error")));
    assert.equal(await tv.page.locator('[data-focus="person:7"] .browse-art-fallback').count(), 1, "failed portraits retain the person silhouette without repeating the name");
    assert.equal(await tv.page.locator('[data-focus="person:7"] img').count(), 0);
    const reads = tv.fake.requests.length;
    await tv.page.locator('[data-focus="person:7"]').focus(); await tv.remote(39);
    assert.equal(tv.fake.requests.length, reads);
    await tv.page.locator('[data-focus="person:7"]').click(); await showing(tv, "person:7");
    await tv.page.locator('[data-focus="filter:series"]').click();
    await tv.page.locator('[data-focus="filter:series"][aria-pressed="true"]').waitFor();
    await tv.remote(10009);
    await tv.page.locator('[data-focus="person:7"]').click(); await showing(tv, "person:7");
    assert.equal(await tv.focused(), "filter:video");
}, { catalog: peopleSearch });

const slowRequests = new SearchCatalog();
const interruptedRequests = new SearchCatalog();
browseTest("Search retries a cancelled background Requests refresh with cached cards", async tv => {
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", "Movie 0001"); await tv.remote(IME_DONE);
    await tv.page.locator('[data-focus="movie:949"]').click();
    await tv.page.locator('[data-focus="create"]:enabled').waitFor();
    const write = tv.fake.hold("/requests", true);
    await tv.page.locator('[data-focus="create"]').click();
    await tv.eventually(async () => interruptedRequests.created, "background write processed");
    await tv.remote(BACK); await showing(tv, "search");
    const reads = tv.fake.requests.filter(request => request.path.startsWith("/requests/search?")).length;
    const refresh = tv.fake.hold("/requests/search", true);
    write.release();
    await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/requests/search?")).length === reads + 1, "refresh started with cached cards");
    const cancelled = tv.page.waitForEvent("requestfailed", request => new URL(request.url()).pathname === "/api/v2/requests/search");
    await tv.page.locator('.browse-grid [data-focus="movie:m0001"]').click();
    await cancelled;
    await showing(tv, "item:movie:m0001");
    refresh.release();
    await tv.remote(BACK); await showing(tv, "search");
    await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/requests/search?")).length === reads + 2, "replacement Requests read after Back");
    await tv.page.getByRole("button", { name: "Heat · Pending", exact: true }).waitFor();
    assert.equal(tv.fake.requests.filter(request => request.method === "POST" && request.path === "/requests").length, 1);
}, { catalog: interruptedRequests });
for (const lost of [false, true]) {
    const catalog = new SearchCatalog();
    browseTest(`Search refreshes its Requests rail after a background ${lost ? "uncertain" : "settled"} write`, async tv => {
        await tv.page.locator('[data-focus="search"]').click();
        await tv.page.fill("#browse-search", "Heat"); await tv.remote(IME_DONE);
        await tv.page.locator('[data-focus="movie:949"]').click();
        await tv.page.locator('[data-focus="create"]:enabled').waitFor();
        const held = tv.fake.hold("/requests", true);
        if (lost) await tv.page.route("**/api/v2/requests", async route => {
            const request = route.request();
            // Lose the answer after the held write, so settlement really occurs after Back.
            await tv.fake.fetch(request.url(), { method: request.method(), headers: await request.allHeaders(), body: request.postData() });
            await route.abort("connectionreset");
        });
        await tv.page.locator('[data-focus="create"]').click();
        await tv.eventually(async () => catalog.created, "write processed before its answer");
        await tv.remote(BACK); await showing(tv, "search");
        const reads = tv.fake.requests.filter(request => request.path.startsWith("/requests/search?")).length;
        const titles = browseReads(tv, "/catalog").length, people = browseReads(tv, "/catalog/people").length;
        held.release();
        await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/requests/search?")).length === reads + 1, "visible Search supplement refreshed after settlement");
        await tv.page.getByRole("button", { name: "Heat · Pending", exact: true }).waitFor();
        assert.equal(await tv.focused(), "movie:949", "refresh retains the returned card identity");
        assert.equal(browseReads(tv, "/catalog").length, titles);
        assert.equal(browseReads(tv, "/catalog/people").length, people);
        assert.equal(tv.fake.requests.filter(request => request.method === "POST" && request.path === "/requests").length, 1, "uncertain writes never replay");
    }, { catalog });
}

for (const refusal of ["capability_disabled", "capability_not_configured", "capability_unsupported", "permission_denied"]) {
    const catalog = new SearchCatalog();
    browseTest(`Search supplementary ${refusal} rechecks capability without replacing primary results`, async tv => {
        await tv.page.locator('[data-focus="search"]').click();
        const probes = tv.fake.requests.filter(request => request.path === "/requests/status").length;
        const held = tv.fake.hold("/requests/search", true);
        tv.fake.script("/requests/search?q=Movie%200001&media_type=all&page=1", problem(403, refusal, "Requests unavailable"));
        await tv.page.fill("#browse-search", "Movie 0001"); await tv.remote(IME_DONE);
        await tv.page.locator('[data-focus="movie:m0001"]').waitFor();
        await tv.page.locator('[data-focus="person:7"]').waitFor();
        const titles = browseReads(tv, "/catalog").length, people = browseReads(tv, "/catalog/people").length;
        catalog.enabled = false; held.release();
        await tv.eventually(async () => tv.fake.requests.filter(request => request.path === "/requests/status").length === probes + 1, "supplement refusal probes capability");
        await tv.jump(0);
        assert.equal(await view(tv), "search");
        assert.equal(await tv.page.locator('[data-focus="movie:m0001"], [data-focus="person:7"]').count(), 2);
        assert.equal(browseReads(tv, "/catalog").length, titles);
        assert.equal(browseReads(tv, "/catalog/people").length, people);
        await tv.remote(BACK); await showing(tv, "home");
        assert.equal(await tv.page.locator('[data-focus="requests"]').count(), 0);
    }, { catalog });
}

const refusedSearch = new SearchCatalog();
browseTest("Search refusal rechecks an enabled status once without a supplement retry loop", async tv => {
    await tv.page.locator('[data-focus="search"]').click();
    const probes = tv.fake.requests.filter(request => request.path === "/requests/status").length;
    refusedSearch.requestFailure = problem(403, "permission_denied", "Unavailable");
    await tv.page.fill("#browse-search", "Movie 0001"); await tv.remote(IME_DONE);
    await tv.page.locator('[data-focus="movie:m0001"]').waitFor();
    await tv.eventually(async () => tv.fake.requests.filter(request => request.path === "/requests/status").length === probes + 1, "refusal rechecked");
    await tv.jump(2000);
    assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/requests/search?")).length, 1);
    assert.equal(tv.fake.requests.filter(request => request.path === "/requests/status").length, probes + 1);
    assert.equal(await tv.page.locator('[data-focus="movie:m0001"]').count(), 1);
}, { catalog: refusedSearch });

let lateSearchSize: { release(): void };
browseTest("late Search poster preferences keep the focused caption visible without new reads", async tv => {
    await tv.page.emulateMedia({ reducedMotion: "reduce" });
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", "Heat"); await tv.remote(IME_DONE);
    await tv.page.locator('[data-focus="movie:949"]').waitFor();
    await tv.page.locator('[data-focus="person:7"]').waitFor();
    await press(tv, "ArrowDown", "ArrowDown", "ArrowDown");
    assert.equal(await tv.focused(), "movie:949");
    const reads = tv.fake.requests.length;
    lateSearchSize.release();
    await tv.eventually(async () => await tv.page.locator('[data-focus="movie:949"] .browse-art').evaluate(node => Math.abs(node.getBoundingClientRect().width - 264) < 0.05), "late large Search posters");
    assert.equal(await tv.focused(), "movie:949");
    assert.equal(await tv.page.locator('[data-focus="movie:949"]').evaluate(card => card.getBoundingClientRect().bottom <= 1016), true, "resized focused caption retains native clearance");
    assert.equal(tv.fake.requests.length, reads);
}, { catalog: new SearchCatalog(), beforeConnect: tv => {
    new FakeSettings(tv.fake).profile().set(CARD_PRESENTATION_KEY, { poster_size: "large", caption: "title_metadata" });
    lateSearchSize = tv.fake.hold("/settings/values/effective?keys=ui.card_presentation", true);
} });

const editedSupplement = new SearchCatalog();
editedSupplement.searchCapabilities = { ...editedSupplement.searchCapabilities, people_media_scope: true };
browseTest("Search removes rendered supplementary cards immediately on edit", async tv => {
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", "Heat"); await tv.remote(IME_DONE);
    await tv.page.locator('[data-focus="movie:949"]').waitFor();
    await tv.page.locator('[data-focus="person:7"]').waitFor();
    await tv.page.fill("#browse-search", "x");
    assert.equal(await tv.page.locator('[data-focus="movie:949"], [data-focus="person:7"]').count(), 0);
    assert.equal(await tv.focused(), "query");
}, { catalog: editedSupplement });

const revokedInDetail = new SearchCatalog();
browseTest("Search drops retained Requests after detail status refuses capability", async tv => {
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", "Heat"); await tv.remote(IME_DONE);
    await tv.page.locator('[data-focus="movie:949"]').waitFor();
    revokedInDetail.enabled = false;
    await tv.page.locator('[data-focus="movie:949"]').click(); await showing(tv, "home");
    await tv.page.locator('[data-focus="search"]').click();
    assert.equal(await tv.page.locator('[data-focus="movie:949"]').count(), 0);
}, { catalog: revokedInDetail });

const revokedRequests = new SearchCatalog();
browseTest("Search drops retained Requests when capability is revoked on another root", async tv => {
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", "Heat"); await tv.remote(IME_DONE);
    await tv.page.locator('[data-focus="movie:949"]').waitFor();
    await tv.remote(BACK);
    await showing(tv, "home");
    revokedRequests.enabled = false;
    await tv.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await tv.eventually(async () => await tv.page.locator('[data-focus="requests"]').count() === 0, "Requests revoked");
    await tv.page.locator('[data-focus="search"]').click();
    assert.equal(await tv.page.locator('[data-focus="movie:949"]').count(), 0);
}, { catalog: revokedRequests });

slowRequests.requestedByOther = true;
browseTest("Search Requests is supplementary, includes existing requests and survives provider delay", async tv => {
    const held = tv.fake.hold("/requests/search", true);
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", "Movie 0001"); await tv.remote(IME_DONE);
    await tv.eventually(async () => (await cardIds(tv)).includes("movie:m0001"), "catalog without provider");
    const reads = browseReads(tv, "/catalog").length;
    held.release();
    await tv.page.locator('[data-focus="movie:949"]').waitFor();
    assert.equal(await tv.page.locator('[data-focus="movie:949"] .requests-status-badge').count(), 1);
    assert.equal(await tv.page.locator('[data-focus="movie:949"]').getAttribute("aria-label"), "Heat · Pending");
    assert.equal(browseReads(tv, "/catalog").length, reads);
    await tv.page.emulateMedia({ reducedMotion: "reduce" });
    await tv.page.locator('[data-focus="query"]').focus();
    await press(tv, "ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown");
    assert.equal(await tv.focused(), "movie:949");
    assert.equal(await tv.page.locator('[data-focus="movie:949"]').evaluate(card => {
        const viewport = document.querySelector(".browse");
        return viewport !== null && card.getBoundingClientRect().bottom <= viewport.getBoundingClientRect().bottom - 64;
    }), true, "focused Search captions retain the native bottom clearance");
    await tv.page.locator('[data-focus="movie:949"]').click();
    await tv.eventually(async () => (await view(tv))?.startsWith("requests:") === true, "request detail");
    await shows(tv, "Heat");
}, { catalog: slowRequests });

const failedPeople = new SearchCatalog();
failedPeople.searchCapabilities = { ...failedPeople.searchCapabilities, people_media_scope: true };
browseTest("Search People failure leaves usable titles without another error surface", async tv => {
    await tv.page.locator('[data-focus="search"]').click();
    tv.fake.script("/catalog/people", problem(400, "validation_failed", "Unavailable"));
    const failed = tv.page.waitForResponse(response => new URL(response.url()).pathname === "/api/v2/catalog/people");
    await tv.page.fill("#browse-search", "Movie 0001"); await tv.remote(IME_DONE);
    await (await failed).finished();
    await tv.jump(0);
    await tv.eventually(async () => (await cardIds(tv)).includes("movie:m0001"), "titles survive People failure");
    assert.ok((await cardIds(tv)).includes("movie:m0001"));
    assert.equal(await tv.page.getByText("Could not load people.", { exact: true }).count(), 0);
    assert.equal(await tv.page.locator('[data-focus="retry-people"]').count(), 0);
    const catalogReads = browseReads(tv, "/catalog").length;
    const requestsReads = tv.fake.requests.filter(request => request.path.startsWith("/requests/search?")).length;
    await tv.page.fill("#browse-search", "Movie 0002"); await tv.remote(IME_DONE);
    await tv.page.locator('[data-focus="person:7"]').waitFor();
    await tv.eventually(async () => (await cardIds(tv)).includes("movie:m0002"), "new query retains title search");
    assert.equal(browseReads(tv, "/catalog").length, catalogReads + 1, "the new query starts one catalog read");
    assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/requests/search?")).length, requestsReads + 1, "the new query starts one Requests read");
}, { catalog: failedPeople });

browseTest("Search uses shared progress and centered failure states without losing retry", async (tv, catalog) => {
    await tv.page.locator('[data-focus="search"]').click();
    const held = tv.fake.hold("/catalog", true);
    catalog.failNext("/catalog", problem(400, "validation_failed", "Unavailable"));
    await tv.page.fill("#browse-search", "Movie 0001"); await tv.remote(IME_DONE);
    await tv.eventually(async () => browseReads(tv, "/catalog").length === 1, "held catalog read");
    await tv.page.getByRole("status", { name: "Searching", exact: true }).waitFor();
    held.release();
    await tv.page.getByRole("heading", { name: "Something went wrong", exact: true }).waitFor();
    await tv.page.getByRole("button", { name: "Try Again", exact: true }).click();
    await tv.eventually(async () => (await cardIds(tv)).includes("movie:m0001"), "Retry keeps the query");
    assert.equal(await tv.page.getByRole("heading", { name: "Something went wrong", exact: true }).count(), 0);
});

const failedCatalog = new SearchCatalog();
failedCatalog.searchCapabilities = { ...failedCatalog.searchCapabilities, people_media_scope: true };
browseTest("Search catalog failure replaces People and title count but preserves Requests", async (tv, catalog) => {
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", "Movie"); await tv.remote(IME_DONE);
    await tv.page.locator('[data-focus="person:7"]').waitFor();
    await tv.page.locator('.search-count').waitFor();
    await tv.page.locator('.search-request-rail').waitFor();
    catalog.failNext("/catalog", problem(400, "validation_failed", "Unavailable"));
    await tv.page.getByRole("button", { name: "Next page", exact: true }).click();
    await tv.page.getByRole("heading", { name: "Something went wrong", exact: true }).waitFor();
    assert.equal(await tv.page.locator('.search-people-heading, .search-people-rail, .search-count').count(), 0, "failed main state replaces People and title results");
    assert.equal(await tv.page.locator('.browse-grid .browse-card').count(), 0);
    assert.equal(await tv.page.locator('.search-request-rail [data-focus="movie:949"]').count(), 1, "Requests remains independent");
    await tv.page.getByRole("button", { name: "Try Again", exact: true }).click();
    await tv.page.locator('.browse-grid .browse-card').first().waitFor();
    await tv.page.locator('[data-focus="person:7"]').waitFor();
    await tv.page.locator('.search-count').waitFor();
    assert.equal(await tv.page.inputValue("#browse-search"), "Movie");
}, { catalog: failedCatalog });

const waitingPeople = new SearchCatalog();
waitingPeople.searchCapabilities = { ...waitingPeople.searchCapabilities, people_media_scope: true };
browseTest("Search waits for People before showing an empty result", async tv => {
    await tv.page.locator('[data-focus="search"]').click();
    const held = tv.fake.hold("/catalog/people", true);
    const catalog = tv.page.waitForResponse(response => new URL(response.url()).pathname === "/api/v2/catalog");
    await tv.page.fill("#browse-search", "Nobodyparity"); await tv.remote(IME_DONE);
    await (await catalog).finished(); await tv.jump(0);
    await tv.page.getByRole("status", { name: "Searching", exact: true }).waitFor();
    assert.equal(await tv.page.getByText("No results", { exact: true }).count(), 0);
    held.release(); await tv.page.locator('[data-focus="person:7"]').waitFor();
    assert.equal(await tv.page.getByRole("status", { name: "Searching", exact: true }).count(), 0);
    assert.equal(await tv.page.getByText("No results", { exact: true }).count(), 0);
}, { catalog: waitingPeople });

const cancelledSupplement = new SearchCatalog();
cancelledSupplement.searchCapabilities = { ...cancelledSupplement.searchCapabilities, people_media_scope: true };
browseTest("Search cancels supplementary answers immediately on edit and profile teardown", async tv => {
    await tv.page.locator('[data-focus="search"]').click();
    const people = tv.fake.hold("/catalog/people", true), requests = tv.fake.hold("/requests/search", true);
    await tv.page.fill("#browse-search", "River"); await tv.remote(IME_DONE);
    await tv.eventually(async () => browseReads(tv, "/catalog/people").length === 1 && tv.fake.requests.some(request => request.path.startsWith("/requests/search?")), "both supplementary reads");
    await tv.page.fill("#browse-search", "x");
    people.release(); requests.release(); await tv.jump(0);
    assert.equal(await tv.page.locator('[data-focus="person:7"], [data-focus="movie:949"]').count(), 0);
    await tv.page.evaluate(() => window.browseHarness.clearProfile());
    await tv.jump(1000);
    assert.equal(await tv.page.locator(".browse").count(), 0);
}, { catalog: cancelledSupplement });

browseTest("Search parity keeps the field, filters the server query and reports its count", async tv => {
    await tv.page.locator('[data-focus="search"]').click();
    await shows(tv, "Find movies, series, and people");
    await tv.page.evaluate(() => { window.retainedNavigation = document.querySelector("#browse-search"); });
    await tv.page.fill("#browse-search", "Movie 0001");
    await tv.remote(IME_DONE);
    await tv.eventually(async () => (await cardIds(tv)).includes("movie:m0001"), "title result");
    await shows(tv, "1 result");
    await tv.page.locator('[data-focus="search-filter:series"]').click();
    await shows(tv, "No results");
    await shows(tv, "Try a different search term");
    assert.equal(new URL(browseReads(tv, "/catalog").slice(-1)[0]?.path ?? "", "https://fake.invalid").searchParams.get("type"), "series");
    assert.equal(await tv.page.evaluate(() => window.retainedNavigation === document.querySelector("#browse-search")), true);
    assert.equal(await tv.focused(), "search-filter:series");
});

for (const withMedia of [false, true]) {
    const catalog = new FakeCatalog();
    catalog.failNext("/library/12/sections", { status: 200, body: { sections: [
        { id: "featured", section_type: "featured", title: "Featured", featured: true, items: [{ content_id: "movie:m0001", type: "movie", title: "Featured title" }] },
        { id: "empty", section_type: "recently_added", title: "Empty", items: [] },
        { id: "unsupported", section_type: "recently_added", title: "Books", items: [{ content_id: "book:1", type: "ebook", title: "Book" }] },
        ...(withMedia ? [{ id: "visible", section_type: "recently_added", title: "Visible", items: [{ content_id: "movie:m0001", type: "movie", title: "Movie" }] }] : []),
    ] } });
    browseTest(`Recommended renders only server media shelves: ${withMedia}`, async tv => {
        await tv.page.locator('[data-focus="movies"]').click();
        await showing(tv, "library:12");
        assert.deepEqual(await tv.page.locator('.skyline-content [data-section]').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-section"))), withMedia ? ["visible"] : []);
        assert.equal(await tv.page.locator('[data-focus="collection:highlights"]').count(), 0);
        assert.equal(await tv.focused(), withMedia ? "movie:m0001" : "movies");
    }, { catalog });
}

let lateLibrarySize: { release(): void };
browseTest("late Recommended poster preferences keep the focused card", async tv => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await tv.remote(39);
    const focused = await tv.focused();
    lateLibrarySize.release();
    await tv.eventually(async () => await tv.page.locator(`[data-section="library-picks"] [data-focus="${focused}"] .browse-art`).evaluate(node => Math.abs(parseFloat(getComputedStyle(node).width) - 211.2) < 0.05), "large Recommended artwork applied");
    assert.equal(await tv.focused(), focused);
}, { beforeConnect: tv => {
    new FakeSettings(tv.fake).profile().set(CARD_PRESENTATION_KEY, { poster_size: "large", caption: "title_metadata" });
    lateLibrarySize = tv.fake.hold("/settings/values/effective?keys=ui.card_presentation", true);
} });

let lateLibraryImages: { release(): void };
const libraryImagesCatalog = new FakeCatalog();
const initialLibraryTitle = libraryImagesCatalog.titles.get("movie:m0001");
assert.ok(initialLibraryTitle);
libraryImagesCatalog.add({ ...initialLibraryTitle, backdrop: "/art/movie%3Am0001.svg" });
libraryImagesCatalog.failNext("/images/capabilities", { status: 200, body: {
    revision: "r1", state: "available", allowed: true, param: "image_size", sizes: ["small", "medium", "large", "original"], widths: {}, original_max_width_px: 3840,
    episode_still_provenance: true, episode_parent_artwork: true, extended_item_artwork: true, season_list_artwork_param: "include_artwork", storage_backend: "local", delivery: "server",
    slot_width_params: { poster: "poster_width", backdrop: "backdrop_width", logo: "logo_width", still: "still_width", photo: "photo_width" },
} });
browseTest("a late Recommended artwork probe upgrades only image fields", async (tv, catalog) => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    const focused = await tv.focused();
    const title = catalog.titles.get("movie:m0001");
    assert.ok(title);
    const image = tv.page.locator('.skyline-art-frame img').last();
    const before = await image.getAttribute("src");
    assert.ok(before);
    catalog.add({ ...title, title: "Changed server membership title", backdrop: `${new URL(before).pathname}?art=large` });
    const collections = tv.fake.requests.filter(request => request.path === "/library/12/collections").length;
    lateLibraryImages.release();
    await tv.eventually(async () => (await tv.page.locator('.skyline-art-frame img').last().getAttribute("src"))?.includes("art=large") === true, "current library artwork upgraded");
    assert.equal(await tv.focused(), focused);
    assert.equal(tv.fake.requests.filter(request => request.path === "/library/12/collections").length, collections);
    assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/library/12/sections")).length, 2);
    assert.equal(await tv.page.locator('[data-section="library-picks"] [data-focus="movie:m0001"] .browse-card-title').textContent(), title.title);
}, { catalog: libraryImagesCatalog, beforeConnect: tv => { lateLibraryImages = tv.fake.hold("/images/capabilities", true); } });

const failedCollectionsCatalog = new FakeCatalog();
failedCollectionsCatalog.failNext("/library/12/collections", problem(422, "validation_failed", "Collections unavailable"));
browseTest("Recommended defers collections reads and Collections retries failures", async tv => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    assert.equal(tv.fake.requests.filter(request => request.path === "/library/12/collections").length, 0);
    await selectLibraryMode(tv, "Collections");
    await tv.page.getByRole("alert").waitFor();
    await tv.page.locator('[data-focus="retry"]').click();
    await tv.page.locator('[data-focus="collection:highlights"]').waitFor();
    assert.equal(await tv.page.getByRole("alert").count(), 0);
}, { catalog: failedCollectionsCatalog });

browseTest("Series Recommended shares Home stills, band alignment and the three-section menu", async (tv, catalog) => {
    const household = catalog.households.get("p-owner");
    assert.ok(household);
    household.librarySections = [
        { id: "next", sectionType: "next_up", title: "Next Up", items: ["episode:s1e12"] },
        { id: "recent", sectionType: "recently_added", title: "Recently Added", items: ["series:s1", "episode:s1e12"] },
    ];
    await tv.page.locator('[data-focus="series"]').click();
    await showing(tv, "library:13");
    assert.deepEqual(await tv.page.locator('.skyline-content [data-section]').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-section"))), ["next", "recent"]);
    for (const id of ["next", "recent"]) {
        assert.equal(await tv.page.locator(`[data-section="${id}"] .skyline-continue:not(.skyline-explore)`).count(), id === "next" ? 1 : 2);
        assert.equal(await tv.page.locator(`[data-section="${id}"] .browse-row > :last-child`).getAttribute("data-focus"), `expand:${id}`);
    }
    await tv.remote(40);
    await tv.eventually(async () => Math.abs(await tv.page.locator('[data-section="recent"] .browse-section-title').evaluate(node => node.getBoundingClientRect().top) - 596) < 1, "Recently Added heading aligns with Home band at 596");
    await tv.page.locator('[data-focus="expand:recent"]').click();
    await tv.page.locator('.section-catalog-grid .browse-card').first().waitFor();
    await tv.remote(BACK);
    assert.equal(await tv.focused(), "expand:recent");
    await tv.page.locator('[data-focus="series"]').focus();
    await tv.remote(40);
    assert.deepEqual(await tv.page.locator('.skyline-selector:not(.skyline-flyout) [role="menuitem"]').allTextContents(), ["Recommended", "Collections", "Browse"]);
    assert.deepEqual(await tv.page.locator('.skyline-selector:not(.skyline-flyout)').evaluate(node => { const style = getComputedStyle(node); return [style.width, style.padding, style.borderRadius]; }), ["460px", "14px", "22px"]);
    assert.equal(await tv.page.locator('.skyline-selector:not(.skyline-flyout) .skyline-menu-icon').count(), 3);
});

browseTest("Recommended shares Skyline rows and expands through a tile", async tv => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await tv.page.locator('[data-section="library-picks"] .browse-card').first().waitFor();
    assert.equal(await tv.page.locator('.skyline-pills').count(), 0);
    assert.equal(await tv.page.locator('[data-focus="section:library-picks"]').count(), 0);
    assert.equal(await tv.page.locator('.skyline-home [data-section="library-picks"] .browse-section-title').textContent(), "Library Picks");
    const art = await tv.page.locator('[data-section="library-picks"] .browse-art').first().evaluate(node => ({ width: parseFloat(getComputedStyle(node).width), height: parseFloat(getComputedStyle(node).height) }));
    assert.deepEqual(art, { width: 176, height: 264 });
    assert.equal(await tv.page.locator('[data-section="collections:inline"]').count(), 0);
    await tv.page.locator('[data-focus="expand:library-picks"]').click();
    await tv.page.locator('.section-catalog-grid .browse-card').first().waitFor();
    assert.deepEqual(tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).at(-1)?.body, { library_id: "12", limit: 60, source: "section", scope: "library", section_id: "library-picks" });
    await tv.remote(BACK);
    assert.equal(await tv.focused(), "expand:library-picks");
});

browseTest("Movies Continue Watching and other library headings open without a catalog overlay", async (tv, catalog) => {
    const household = catalog.households.get("p-owner");
    assert.ok(household);
    household.librarySections = [
        { id: "continue_watching", sectionType: "continue_watching", title: "Continue Watching", items: ["movie:m0001", "episode:s1e12"] },
        { id: "recently_added", sectionType: "recently_added", title: "Recently Added", items: ["movie:m0002", "movie:m0004"] },
    ];
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    for (const id of ["continue_watching", "recently_added"]) {
        const heading = tv.page.locator(`[data-section="${id}"] .browse-section-title`);
        await heading.waitFor();
        assert.equal(await heading.evaluate(node => node.tagName), "H2", `${id} heading is not a control`);
        assert.equal(await heading.getAttribute("data-focus"), null);
        assert.equal(await tv.page.locator(`[data-focus="section:${id}"]`).count(), 0);
    }
    await tv.page.locator('[data-focus="expand:continue_watching"]').click();
    const catalogCard = tv.page.locator(".section-catalog-grid .browse-card").first();
    const catalogError = tv.page.getByText("Something went wrong. Try again.");
    await Promise.race([catalogCard.waitFor(), catalogError.waitFor()]);
    const opened = tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).at(-1);
    assert.equal(opened?.path.startsWith("/catalog/query?image_size=small"), true);
    assert.deepEqual(opened?.body, { library_id: "12", limit: 60, source: "section", scope: "library", section_id: "continue_watching" });
    assert.equal(await catalogError.count(), 0);
    await catalogCard.waitFor();
    assert.equal(await tv.page.locator(".section-catalog-title").innerText(), "Continue Watching");
    await tv.remote(BACK);
    assert.equal(await tv.focused(), "expand:continue_watching");
    await tv.page.locator('[data-focus="expand:recently_added"]').click();
    await tv.page.locator(".section-catalog-title").waitFor();
    assert.equal(await tv.page.locator(".section-catalog-title").innerText(), "Recently Added");
    assert.deepEqual(tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).at(-1)?.body, { library_id: "12", limit: 60, source: "section", scope: "library", section_id: "recently_added" });
    assert.equal(await tv.page.getByText("Something went wrong. Try again.").count(), 0);
});

function videoOnlyCatalog(): FakeCatalog {
    const catalog = new FakeCatalog();
    delete catalog.searchCapabilities.video_with_episodes_scope;
    return catalog;
}

let browser: Browser;
before(async () => {
    browser = await launchBrowser();
});
after(async () => {
    await browser.close();
});

interface Start {
    readonly beforeConnect?: (tv: Tv) => void;
    readonly catalog?: FakeCatalog;
    readonly multipleLibraries?: boolean;
    readonly profile?: string;
    readonly pin?: string;
}

function browseTest(name: string, body: (tv: Tv, catalog: FakeCatalog) => Promise<void>, start: Start = {}): void {
    test(name, async () => {
        const tv = await openTv(browser, { app: "browse", ...(process.env.DISCOVERY_VIDEO !== undefined && name.startsWith("discovery flow") ? { video: process.env.DISCOVERY_VIDEO } : {}) });
        try {
            const catalog = start.catalog ?? new FakeCatalog();
            if (start.multipleLibraries) {
                const household = catalog.households.get(start.profile ?? "p-owner");
                assert.ok(household);
                household.hidden = [];
            }
            await signedInBrowse(tv, catalog, start.profile ?? "p-owner", start.pin, start.beforeConnect);
            if (await tv.page.locator('[data-view="home"]').count() === 1) await homeDetailsRead(tv);
            await body(tv, catalog);
            assert.deepEqual(tv.console, [], "the page logs nothing");
        } finally {
            await tv.page.context().close();
        }
    });
}

async function signedInBrowse(tv: Tv, catalog: FakeCatalog, profile: string, pin?: string, beforeConnect?: (tv: Tv) => void): Promise<void> {
    tv.fake.catalog = catalog;
    beforeConnect?.(tv);
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "a device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(async () => (await tv.page.evaluate(() => window.browseHarness.loginPhase)) === "signed_in", "sign-in");
    assert.equal(await tv.page.evaluate(([id, code]) => window.browseHarness.selectProfile(id ?? "", code), [profile, pin]), pin === undefined ? "selected" : "verified");
    await tv.page.evaluate(() => window.browseHarness.mount());
    await showing(tv, "home");
}

function view(tv: Tv): Promise<string | null> {
    return tv.page.evaluate(() => document.querySelector(".browse")?.getAttribute("data-view") ?? null);
}

async function showing(tv: Tv, name: string): Promise<void> {
    await tv.eventually(async () => (await view(tv)) === name, `the ${name} view`);
}

async function shows(tv: Tv, text: string): Promise<void> {
    await tv.page.getByText(text).first().waitFor();
}

async function press(tv: Tv, ...keys: string[]): Promise<void> {
    for (const key of keys) {
        await tv.page.keyboard.press(key);
    }
}

/** Details regressions enter from an ordinary row; Continue Watching now resumes directly. */
async function activateDetails(tv: Tv, id = "movie:m0001", information = false): Promise<void> {
    if (await view(tv) === "home") {
        await tv.page.locator(`[data-section="recently_added"] [data-focus="${id}"]`).focus();
    }
    if (information) {
        await tv.page.locator(`[data-section="recently_added"] [data-focus="${id}"]`).click({ button: "right" });
        await tv.page.locator('[data-focus="episode-information"]').click();
    } else await press(tv, "Enter");
}

function browseReads(tv: Tv, pathname?: string): { path: string; headers: Readonly<Record<string, string>> }[] {
    const browse = /^\/(user\/libraries|settings\/values|home\/|catalog)/;
    return tv.fake.requests.filter((request) => browse.test(request.path) && (pathname === undefined || request.path.split("?")[0] === pathname));
}

function cardIds(tv: Tv, selector = ".browse-card:not(.discovery-collection)"): Promise<string[]> {
    return tv.page.evaluate((query) => Array.from(document.querySelector(".browse")?.querySelectorAll(query) ?? []).map((node) => node.getAttribute("data-focus") ?? ""), selector);
}

async function detailsMore(tv: Tv): Promise<void> {
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.getByRole("dialog", { name: "More", exact: true }).waitFor();
}

async function seasonDetails(tv: Tv): Promise<void> {
    await detailsMore(tv);
    await tv.page.locator('[data-focus="season-info"]').click();
    await showing(tv, "season:series:s1:1");
}

browseTest("richer Details: facts, versions, people, bounded filmography, related titles and Back focus", async (tv) => {
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    if (process.env.DETAILS_CAPTURE_DIR !== undefined) {
        await tv.jump(240);
        await mkdir(process.env.DETAILS_CAPTURE_DIR, { recursive: true });
        await tv.page.screenshot({ path: `${process.env.DETAILS_CAPTURE_DIR}/details.png` });
    }
    await shows(tv, "IMDb 8.1");
    await tv.page.locator('[data-focus="version"]').click();
    await tv.page.locator('[data-focus="version:43"]').focus();
    await press(tv, "Enter");
    await tv.page.locator('[data-focus="play"]').focus();
    await press(tv, "Enter");
    assert.equal((await tv.page.evaluate(() => window.browseHarness.plays))[0]?.fileId, "43");
    assert.equal((await tv.page.evaluate(() => window.browseHarness.plays))[0]?.startSeconds, 0);
    const personal = tv.fake.hold("/capabilities/personal-lists");
    await tv.page.evaluate(() => window.browseHarness.resume());
    await shows(tv, "Loading personal actions.");
    personal.release();
    await tv.page.locator('[data-focus="watchlist"]').waitFor();
    await tv.eventually(async () => await tv.page.locator('[data-detail-section="related"] .browse-card').count() === 24, "refreshed related titles");
    await tv.page.locator('[data-focus="person:7"]').first().focus();
    const reads = tv.fake.requests.length;
    await press(tv, "ArrowRight", "ArrowLeft");
    assert.equal(tv.fake.requests.length, reads, "focus performs no reads");
    await press(tv, "Enter");
    await showing(tv, "person:7");
    await tv.eventually(async () => await tv.page.locator(".browse-grid .browse-card").count() === 24, "inline Person first page");
    assert.equal(await tv.page.locator(".browse-card").count(), 24);
    await tv.remote(BACK);
    await showing(tv, "item:movie:m0001");
    assert.equal(await tv.focused(), "person:7");
    await tv.eventually(async () => await tv.page.locator('[data-detail-section="related"] .browse-card').count() === 24, "the bounded related rail");
    assert.equal(await tv.page.getByRole("button", { name: /trailer/i }).count(), 0);
}, { catalog: new FakeDetails() });

browseTest("S-D1 synopsis keeps its dialog and focus while optional Details settle", async (tv) => {
    const related = tv.fake.hold("/recommendations/similar/movie%3Am0001", true);
    const capability = tv.fake.hold("/capabilities/personal-lists", true);
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await detailsMore(tv);
    await tv.page.locator('[data-focus="synopsis"]').focus();
    await press(tv, "Enter");
    const dialog = tv.page.getByRole("dialog", { name: "Synopsis" });
    await dialog.getByRole("button", { name: "Close synopsis" }).focus();
    related.release(); capability.release();
    await tv.eventually(async () => tv.fake.requests.some((request) => request.path === "/favorites/movie%3Am0001/membership"), "optional membership reads");
    await tv.jump(240);
    assert.equal(await dialog.count(), 1, "optional responses must preserve the active synopsis");
    assert.equal(await tv.focused(), "close-synopsis");
    await tv.remote(BACK);
    assert.equal(await dialog.count(), 0);
    assert.equal(await tv.focused(), "synopsis");
    await tv.eventually(async () => await tv.page.locator('[data-detail-section="related"] .browse-card').count() === 24, "updated data after closing");
    await press(tv, "Enter");
    await dialog.getByRole("button", { name: "Close synopsis" }).click();
    assert.equal(await tv.focused(), "synopsis");
    await press(tv, "Enter");
    await tv.page.evaluate(() => window.browseHarness.clearProfile());
    assert.equal(await dialog.count(), 0);
    await tv.remote(BACK);
    assert.equal(await tv.page.locator("#successor").count(), 1);
}, { catalog: new FakeDetails() });

browseTest("S-D2 aggregate watched reconciles visible episodes in both directions", async (tv, catalog) => {
    assert.ok(catalog instanceof FakeDetails);
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "item:series:s1");
    await seasonDetails(tv);
    assert.equal(await tv.page.locator(".browse-episode", { hasText: "Watched" }).count(), 3);
    await detailsMore(tv);
    await tv.page.getByRole("button", { name: "Mark all unwatched", exact: true }).click();
    await tv.page.getByRole("button", { name: "Mark all watched", exact: true }).waitFor();
    assert.equal(catalog.watchedEpisodes.has("episode:s1e11"), false);
    assert.equal(await tv.page.locator(".browse-episode", { hasText: "Watched" }).count(), 0, "authoritative rows must reflect aggregate unwatch");
    await tv.page.getByRole("button", { name: "Mark all watched", exact: true }).click();
    await tv.page.getByRole("button", { name: "Mark all unwatched", exact: true }).waitFor();
    assert.equal(await tv.page.locator(".browse-episode", { hasText: "Watched" }).count(), 3);
    assert.equal(browseReads(tv, "/catalog/series/series%3As1/seasons/1/episodes").length, 4);
}, { catalog: new FakeDetails() });

for (const kind of ["movie", "episode"]) {
    browseTest(`S-D3 never-played ${kind} can mark watched without a progress record`, async (tv, catalog) => {
        assert.ok(catalog instanceof FakeDetails);
        const id = kind === "movie" ? "movie:m0001" : "episode:s1e12";
        catalog.neverPlayed.add(id);
        catalog.progress.delete(id);
        catalog.watchedEpisodes.delete(id);
        await activateDetails(tv, id, kind === "episode");
        await showing(tv, `item:${id}`);
        await detailsMore(tv);
        await tv.page.getByRole("button", { name: "Add favorite", exact: true }).waitFor();
        assert.equal(await tv.page.getByRole("button", { name: "Mark watched", exact: true }).count(), 1, "no progress is a valid unwatched state");
        catalog.mutationFailure = problem(503, "unavailable", "Unavailable");
        await tv.page.getByRole("button", { name: "Mark watched", exact: true }).click();
        await shows(tv, "Could not update watched.");
        await tv.jump(30000);
        assert.equal(catalog.mutations.length, 1);
        await tv.page.getByRole("button", { name: "Retry watched", exact: true }).click();
        await tv.page.getByRole("button", { name: "Mark unwatched", exact: true }).waitFor();
        assert.equal(catalog.mutations.length, 2);
        assert.equal(await tv.page.locator('[data-focus="watched"]').getAttribute("aria-pressed"), "true");
        await tv.page.getByRole("button", { name: "Mark unwatched", exact: true }).click();
        await tv.page.getByRole("button", { name: "Mark watched", exact: true }).waitFor();
        assert.equal(await tv.page.locator('[data-focus="watched"]').getAttribute("aria-pressed"), "false");
    }, { catalog: new FakeDetails() });
}

browseTest("S-D1 synopsis closes on browse destruction and optional failures remain retryable", async (tv) => {
    await tv.page.route("**/api/v2/recommendations/similar/**", async (route) => {
        await route.fulfill({ status: 400, json: problem(400, "unavailable", "Unavailable").body });
    });
    const related = tv.fake.hold("/capabilities/personal-lists", true);
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await detailsMore(tv);
    await tv.page.locator('[data-focus="synopsis"]').focus();
    await press(tv, "Enter");
    related.release();
    await tv.eventually(async () => tv.fake.requests.some((request) => request.path === "/favorites/movie%3Am0001/membership"), "membership answer");
    assert.equal(await tv.page.getByRole("dialog", { name: "Synopsis" }).count(), 1);
    await tv.remote(BACK);
    await tv.remote(BACK);
    await tv.page.getByRole("button", { name: "Retry related titles", exact: true }).waitFor();
    await detailsMore(tv);
    await tv.page.locator('[data-focus="synopsis"]').click();
    await tv.page.evaluate(() => window.browseHarness.destroy());
    assert.equal(await tv.page.getByRole("dialog").count(), 0);
    await tv.page.evaluate(() => window.browseHarness.mount());
    await showing(tv, "home");
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    assert.equal(await tv.page.getByRole("dialog").count(), 0);
    assert.equal(await tv.focused(), "resume");
}, { catalog: new FakeDetails() });

browseTest("S-D2 failed episode reconciliation retries reads without another aggregate write", async (tv, catalog) => {
    assert.ok(catalog instanceof FakeDetails);
    let fail = false;
    await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons/1/episodes?**", async (route) => {
        if (fail) await route.fulfill({ status: 400, json: problem(400, "unavailable", "Unavailable").body });
        else await route.fallback();
    });
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "item:series:s1");
    await seasonDetails(tv);
    fail = true;
    await detailsMore(tv);
    await tv.page.getByRole("button", { name: "Mark all unwatched", exact: true }).click();
    await shows(tv, "Could not update watched.");
    assert.equal(catalog.mutations.length, 1);
    assert.equal(await tv.page.locator(".browse-episode", { hasText: "Watched" }).count(), 3, "failed read retains old rows with an explicit error");
    fail = false;
    await tv.page.getByRole("button", { name: "Retry watched", exact: true }).click();
    await tv.page.getByRole("button", { name: "Mark all watched", exact: true }).waitFor();
    assert.equal(await tv.page.locator(".browse-episode", { hasText: "Watched" }).count(), 0);
    assert.equal(catalog.mutations.length, 1);
}, { catalog: new FakeDetails() });

for (const aggregate of ["series", "season"]) {
    for (const played of [false, true]) {
        browseTest(`S-D2 ${aggregate} aggregate refreshes covered episode Details to ${played ? "watched" : "unwatched"}`, async (tv, catalog) => {
            assert.ok(catalog instanceof FakeDetails);
            if (played) catalog.watchedEpisodes.clear();
            else for (const title of catalog.titles.values()) if (title.type === "episode") catalog.watchedEpisodes.add(title.id);
            const episodeId = "episode:s1e12";
            const aggregateId = aggregate === "series" ? "series:s1" : "series:s1-S1";
            await tv.page.route("**/api/v2/recommendations/similar/episode%3As1e12?**", async (route) => {
                await route.fulfill({ status: 200, json: { ...fixture("list_catalog_items_ok"), items: [{ content_id: aggregateId, type: aggregate, title: "Harbor Lights", series_id: "series:s1", season_number: 1 }] } });
            });
            await activateDetails(tv, episodeId, true);
            await showing(tv, `item:${episodeId}`);
            await detailsMore(tv);
            await tv.page.getByRole("button", { name: played ? "Mark watched" : "Mark unwatched", exact: true }).waitFor();
            await tv.remote(BACK);
            const related = tv.page.locator(`[data-detail-section="related"] [data-focus="${aggregateId}"]`);
            await related.focus();
            await press(tv, "Enter");
            await detailsMore(tv);
            await tv.page.getByRole("button", { name: played ? "Mark all watched" : "Mark all unwatched", exact: true }).click();
            await tv.page.getByRole("button", { name: played ? "Mark all unwatched" : "Mark all watched", exact: true }).waitFor();
            assert.equal(catalog.watchedEpisodes.has(episodeId), played);
            await tv.remote(BACK);
            await tv.remote(BACK);
            await showing(tv, `item:${episodeId}`);
            await detailsMore(tv);
            await tv.eventually(async () => await tv.page.getByRole("button", { name: played ? "Mark unwatched" : "Mark watched", exact: true }).count() === 1, "covered episode reflects the aggregate change");
            assert.equal(browseReads(tv, "/catalog/items/episode%3As1e12").length, 4, "Home and Card actions, then Details and its refresh");
            assert.equal(catalog.mutations.length, 1);
        }, { catalog: new FakeDetails() });
    }
}

browseTest("S-D2 series aggregate invalidates a cached season before returning", async (tv, catalog) => {
    assert.ok(catalog instanceof FakeDetails);
    for (const title of catalog.titles.values()) if (title.type === "episode" && title.seriesId === "series:s1") catalog.watchedEpisodes.add(title.id);
    await tv.page.route("**/api/v2/recommendations/similar/series%3As1-S1?**", async (route) => {
        await route.fulfill({ status: 200, json: { ...fixture("list_catalog_items_ok"), items: [{ content_id: "series:s1", type: "series", title: "Harbor Lights" }] } });
    });
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "item:series:s1");
    await seasonDetails(tv);
    await tv.page.locator('[data-detail-section="related"] [data-focus="series:s1"]').focus();
    await press(tv, "Enter");
    await showing(tv, "item:series:s1");
    await detailsMore(tv);
    await tv.page.getByRole("button", { name: "Mark all unwatched", exact: true }).click();
    await tv.page.getByRole("button", { name: "Mark all watched", exact: true }).waitFor();
    const beforeReturn = browseReads(tv, "/catalog/series/series%3As1/seasons/1/episodes").length;
    await tv.remote(BACK);
    await tv.remote(BACK);
    await showing(tv, "season:series:s1:1");
    await tv.eventually(async () => await tv.page.locator(".browse-episode", { hasText: "Watched" }).count() === 0, "refreshed cached season");
    assert.equal(browseReads(tv, "/catalog/series/series%3As1/seasons/1/episodes").length, beforeReturn + 1);
    await tv.page.locator('[data-detail-section="related"] [data-focus="series:s1"]').focus();
    await press(tv, "Enter");
    await showing(tv, "item:series:s1");
    const answer = tv.fake.hold("/watched/series%3As1", true);
    await detailsMore(tv);
    await tv.page.getByRole("button", { name: "Mark all watched", exact: true }).click();
    await tv.eventually(async () => catalog.mutations.length === 2, "committed aggregate before cancellation");
    const beforeCancellation = browseReads(tv, "/catalog/series/series%3As1/seasons/1/episodes").length;
    await tv.remote(BACK);
    await tv.remote(BACK);
    answer.release();
    await showing(tv, "season:series:s1:1");
    await tv.eventually(async () => await tv.page.locator(".browse-episode", { hasText: "Watched" }).count() === 3, "cached season after cancelling a committed answer");
    assert.equal(catalog.mutations.length, 2);
    assert.equal(browseReads(tv, "/catalog/series/series%3As1/seasons/1/episodes").length, beforeCancellation + 1);
}, { catalog: new FakeDetails() });

browseTest("S-D2 aggregate reconciliation cannot paint after profile authority ends", async (tv, catalog) => {
    assert.ok(catalog instanceof FakeDetails);
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "item:series:s1");
    await seasonDetails(tv);
    const episodes = tv.fake.hold("/catalog/series/series%3As1/seasons/1/episodes", true);
    await detailsMore(tv);
    await tv.page.getByRole("button", { name: "Mark all unwatched", exact: true }).click();
    await tv.eventually(async () => browseReads(tv, "/catalog/series/series%3As1/seasons/1/episodes").length === 3, "reconciliation read");
    await tv.page.evaluate(() => window.browseHarness.clearProfile());
    episodes.release();
    await tv.jump(30000);
    assert.equal(await tv.page.locator(".browse").count(), 0);
    assert.equal(await tv.page.locator("#successor").count(), 1);
    assert.equal(catalog.mutations.length, 1);
}, { catalog: new FakeDetails() });

browseTest("S-D3 unknown or mismatched watched postconditions remain errors", async (tv, catalog) => {
    assert.ok(catalog instanceof FakeDetails);
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    let unknown = false;
    await detailsMore(tv);
    await tv.page.route("**/api/v2/catalog/items/movie%3Am0001?**", async (route) => {
        await route.fulfill({ status: 200, json: { ...fixture("get_catalog_item_ok"), content_id: "movie:m0001", user_data: undefined, user_state: unknown ? undefined : { played: false } } });
    });
    await tv.page.getByRole("button", { name: "Mark watched", exact: true }).click();
    await shows(tv, "Could not update watched.");
    unknown = true;
    await tv.page.getByRole("button", { name: "Retry watched", exact: true }).click();
    await shows(tv, "Could not update watched.");
    assert.equal(catalog.mutations.length, 1);
    assert.equal(await tv.page.locator('[data-focus="watched"]').getAttribute("aria-pressed"), "false");
}, { catalog: new FakeDetails() });

browseTest("Details portraits keep their circular geometry and combine one person's roles", async (tv) => {
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await tv.page.locator('[data-focus="watchlist"]').waitFor();
    await tv.eventually(async () => await tv.page.locator('[data-detail-section="related"] .browse-card').count() === 24, "related titles");
    await tv.jump(240);
    assert.deepEqual(await tv.page.locator(".details-photo").first().evaluate((node) => ({ width: node.clientWidth, height: node.clientHeight })), { width: 200, height: 200 });
    assert.equal(await tv.page.locator(".details-hero").evaluate((node) => {
        const art = node.querySelector(".details-backdrop");
        return art !== null && art.getBoundingClientRect().bottom <= node.getBoundingClientRect().bottom;
    }), true, "hero artwork cannot paint over later rails");
    assert.equal(await tv.page.locator('[data-focus="person:7"]').count(), 1);
    await shows(tv, "Alex · Director");
}, { catalog: new FakeDetails() });

browseTest("long Details facts remain reachable with the remote", async (tv) => {
    await tv.page.route("**/api/v2/catalog/items/movie%3Am0001?**", async (route) => {
        await route.fulfill({ status: 200, json: { ...fixture("get_catalog_item_ok"), content_id: "movie:m0001", original_language: "en", crew: Array.from({ length: 35 }, (_, index) => ({ name: `Crew ${index}`, job: `Role ${index}` })) } });
    });
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await tv.page.locator('[data-focus="watchlist"]').waitFor();
    await tv.eventually(async () => await tv.page.locator('[data-detail-section="related"] .browse-card').count() === 24, "related titles");
    const reached = new Set<string>();
    for (let index = 0; index < 45; index++) {
        await press(tv, "ArrowDown");
        await tv.jump(240);
        const fact = await tv.page.evaluate(() => {
            const node = document.activeElement;
            if (!node?.matches(".details-facts .browse-text")) return undefined;
            const box = node.getBoundingClientRect();
            return { text: node.textContent ?? "", visible: box.top >= 0 && box.bottom <= 1080 };
        });
        if (fact !== undefined) { assert.equal(fact.visible, true); reached.add(fact.text); }
    }
    assert.ok(reached.has("Role 34: Crew 34") && reached.has("Role 0: Crew 0") && reached.has("Original language: en"), JSON.stringify([...reached]));
}, { catalog: new FakeDetails() });

browseTest("personal writes require confirmed state and discard late replies after a profile change", async (tv, catalog) => {
    assert.ok(catalog instanceof FakeDetails);
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await tv.page.route("**/api/v2/favorites/movie%3Am0001/membership", async (route) => {
        await route.fulfill({ status: 200, json: { item_id: "movie:m0001", is_member: false } });
    });
    await detailsMore(tv);
    await tv.page.getByRole("button", { name: "Add favorite", exact: true }).click();
    await shows(tv, "Could not update favorites.");
    assert.equal(await tv.page.locator('[data-focus="favorites"]').getAttribute("aria-pressed"), "false");
    assert.equal(catalog.mutations.length, 1);
    const held = tv.fake.hold("/watchlist/movie%3Am0001", true);
    await tv.remote(BACK);
    await tv.page.getByRole("button", { name: "Add to watchlist", exact: true }).click();
    await shows(tv, "Updating watchlist…");
    await tv.page.evaluate(() => window.browseHarness.clearProfile());
    held.release();
    await tv.jump(30000);
    assert.equal(await tv.page.locator(".browse").count(), 0);
    assert.equal(await tv.page.locator("#successor").count(), 1);
    assert.equal(catalog.mutations.length, 2);
    const writes = tv.fake.requests.filter((request) => /^\/(favorites|watchlist)\/movie%3Am0001$/.test(request.path));
    assert.equal(writes.length, 2);
    assert.ok(writes.every((request) => request.headers["x-profile-id"] === "p-owner"));
}, { catalog: new FakeDetails() });

browseTest("optional Details reads load independently, fail, retry and report empty results", async (tv, catalog) => {
    assert.ok(catalog instanceof FakeDetails);
    const related = tv.fake.hold("/recommendations/similar/movie%3Am0001", true);
    const capability = tv.fake.hold("/capabilities/personal-lists", true);
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    assert.equal(await tv.focused(), "resume", "optional reads do not block playback");
    await shows(tv, "Loading related titles.");
    await shows(tv, "Loading personal actions.");
    await tv.remote(BACK);
    await showing(tv, "home");
    related.release(); capability.release();
    await tv.jump(0);
    assert.equal(await view(tv), "home", "late optional reads cannot reopen Details");
    catalog.empty = true;
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await shows(tv, "No related titles available.");
    await tv.page.locator('[data-focus="person:7"]').focus();
    await press(tv, "Enter");
    await showing(tv, "person:7");
    await shows(tv, "No available titles for this filter.");
    await shows(tv, "0 titles");
    await tv.remote(BACK);
    await showing(tv, "item:movie:m0001");
    await tv.remote(BACK);
    catalog.capability = false;
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await tv.eventually(async () => tv.fake.requests.filter((request) => request.path === "/capabilities/personal-lists").length === 3, "unsupported capability");
    assert.equal(await tv.page.locator('[data-focus="watchlist"], [data-focus="favorites"]').count(), 0);
}, { catalog: new FakeDetails() });

browseTest("series Details render related titles from the unpaginated server collection", async (tv) => {
    await activateDetails(tv, "series:s1");
    await showing(tv, "item:series:s1");
    await tv.eventually(async () => await tv.page.locator('[data-detail-section="related"] .browse-card').count() === 24, "series related collection");
    assert.equal(await tv.page.getByRole("button", { name: "Retry related titles", exact: true }).count(), 0);
}, { catalog: new FakeDetails() });

browseTest("person, related and personal reads recover with explicit retries", async (tv) => {
    let relatedFail = true;
    let personalFail = true;
    await tv.page.route("**/api/v2/recommendations/similar/**", async (route) => {
        if (relatedFail) await route.fulfill({ status: 400, contentType: "application/problem+json", body: JSON.stringify({ type: "about:blank", title: "Unavailable", status: 400 }) });
        else await route.fallback();
    });
    await tv.page.route("**/api/v2/capabilities/personal-lists", async (route) => {
        if (personalFail) await route.fulfill({ status: 400, contentType: "application/problem+json", body: JSON.stringify({ type: "about:blank", title: "Unavailable", status: 400 }) });
        else await route.fallback();
    });
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await shows(tv, "Could not load related titles.");
    await shows(tv, "Could not load personal actions.");
    relatedFail = false; personalFail = false;
    await tv.page.getByRole("button", { name: "Retry related titles", exact: true }).click();
    await detailsMore(tv);
    await tv.page.getByRole("button", { name: "Retry personal actions", exact: true }).click();
    await tv.page.getByRole("button", { name: "Add favorite", exact: true }).waitFor();
    await tv.remote(BACK);
    await tv.eventually(async () => await tv.page.locator('[data-detail-section="related"] .browse-card').count() === 24, "related retry");
    const person = tv.fake.hold("/catalog/people/7", true);
    await tv.page.locator('[data-focus="person:7"]').focus();
    await press(tv, "Enter");
    await showing(tv, "person:7");
    await shows(tv, "Loading metadata");
    await tv.page.evaluate(() => window.browseHarness.clearProfile());
    person.release();
    await tv.jump(0);
    assert.equal(await tv.page.locator(".browse").count(), 0);
    assert.equal(await tv.page.locator("#successor").count(), 1);
}, { catalog: new FakeDetails() });

for (const scenario of [{ outcome: "completed", played: false }, { outcome: "lost", played: true }, { outcome: "cancelled", played: false }]) {
    const fixtureCatalog = new FakeDetails();
    const title = fixtureCatalog.titles.get("movie:m0001");
    assert.ok(title);
    fixtureCatalog.add({ ...title, duration: 5400 });
    fixtureCatalog.watched = scenario.played;
    browseTest(`PR32 Home refreshes watched progress after a ${scenario.outcome} mutation`, async (tv, catalog) => {
        assert.ok(catalog instanceof FakeDetails);
        assert.equal(await tv.page.locator('[data-focus="movie:m0001"] .skyline-progress').count(), 1);
        await activateDetails(tv);
        await showing(tv, "item:movie:m0001");
        const path = "/watched/movie%3Am0001";
        const held = scenario.outcome === "cancelled" ? tv.fake.hold(path, true) : undefined;
        if (scenario.outcome === "lost") tv.fake.dropNextAnswer(path);
        await detailsMore(tv);
        await tv.page.getByRole("button", { name: scenario.played ? "Mark unwatched" : "Mark watched", exact: true }).click();
        await tv.eventually(async () => catalog.mutations.length === 1, "watched mutation committed");
        if (scenario.outcome === "completed") await tv.page.getByRole("button", { name: scenario.played ? "Mark watched" : "Mark unwatched", exact: true }).waitFor();
        if (scenario.outcome === "lost") await tv.page.getByRole("button", { name: "Retry watched", exact: true }).waitFor();
        await tv.remote(BACK);
        await tv.remote(BACK);
        held?.release();
        await showing(tv, "home");
        assert.equal(catalog.progress.has("movie:m0001"), false);
        await tv.eventually(async () => await tv.page.locator('[data-focus="movie:m0001"] .skyline-progress').count() === 0, "Home discards obsolete progress");
        assert.equal(browseReads(tv, "/home/sections").length, 2);
        assert.equal(catalog.mutations.length, 1);
    }, { catalog: fixtureCatalog });
}

for (const kind of ["favorites", "watchlist"]) {
    browseTest(`PR32 returning from a person exposes reconciliation for cancelled ${kind}`, async (tv, catalog) => {
        assert.ok(catalog instanceof FakeDetails);
        await activateDetails(tv);
        await showing(tv, "item:movie:m0001");
        await tv.page.locator('[data-focus="watchlist"]').waitFor();
        await tv.eventually(async () => await tv.page.locator('[data-detail-section="related"] .browse-card').count() === 24, "all optional reads finished");
        const path = `/${kind}/movie%3Am0001`;
        const held = tv.fake.hold(path, true);
        if (kind === "favorites") await detailsMore(tv);
        await tv.page.getByRole("button", { name: kind === "favorites" ? "Add favorite" : "Add to watchlist", exact: true }).click();
        await tv.eventually(async () => catalog.mutations.length === 1, "personal mutation committed");
        if (kind === "favorites") await tv.remote(BACK);
        await tv.page.locator('[data-focus="person:7"]').first().focus();
        await press(tv, "Enter");
        await showing(tv, "person:7");
        await tv.remote(BACK);
        held.release();
        await showing(tv, "item:movie:m0001");
        if (kind === "favorites") await detailsMore(tv);
        await tv.eventually(async () => await tv.page.getByRole("button", { name: `Retry ${kind}`, exact: true }).count() === 1, "cancelled action becomes visibly retryable");
        assert.equal(await tv.page.locator(`[data-focus="${kind}"]`).getAttribute("aria-disabled"), "false");
        assert.equal(tv.fake.requests.filter(request => request.path === `${path}/membership`).length, 1);
        await tv.page.getByRole("button", { name: `Retry ${kind}`, exact: true }).click();
        await tv.page.getByRole("button", { name: kind === "favorites" ? "Remove favorite" : "Remove from watchlist", exact: true }).waitFor();
        assert.equal(tv.fake.requests.filter(request => request.path === `${path}/membership`).length, 2);
        assert.equal(catalog.mutations.length, 1, "Retry reconciles the committed state without another write");
    }, { catalog: new FakeDetails() });
}

browseTest("a lost watched answer is reconciled on Retry without repeating the non-retryable POST", async (tv, catalog) => {
    assert.ok(catalog instanceof FakeDetails);
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    tv.fake.dropNextAnswer("/watched/movie%3Am0001");
    await detailsMore(tv);
    await tv.page.getByRole("button", { name: "Mark watched", exact: true }).click();
    await shows(tv, "Could not update watched.");
    assert.equal(catalog.watched, true, "server committed the lost answer");
    await tv.jump(30000);
    assert.equal(catalog.mutations.length, 1);
    await tv.page.getByRole("button", { name: "Retry watched", exact: true }).click();
    await tv.page.getByRole("button", { name: "Mark unwatched", exact: true }).waitFor();
    assert.equal(catalog.mutations.length, 1, "retry reads the committed state instead of recording another watch");
}, { catalog: new FakeDetails() });

browseTest("season Details keeps episodes first, exposes real facts and restores the episode identity", async (tv) => {
    const personal = tv.fake.hold("/favorites/series%3As1/membership");
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "item:series:s1");
    await detailsMore(tv);
    await tv.page.locator('[data-focus="season-info"]').focus();
    await tv.page.keyboard.down("Enter");
    personal.release();
    await showing(tv, "season:series:s1:1");
    await tv.page.keyboard.up("Enter");
    await showing(tv, "season:series:s1:1");
    await shows(tv, "The first season follows the night shift at a coastal observatory.");
    assert.equal(await tv.focused(), "episode:s1e11");
    await press(tv, "ArrowDown");
    await tv.page.locator('[data-focus="episode:s1e12"]').click({ button: "right" });
    await tv.page.locator('[data-focus="episode-information"]').click();
    await showing(tv, "item:episode:s1e12");
    await tv.remote(BACK);
    await showing(tv, "season:series:s1:1");
    assert.equal(await tv.focused(), "episode:s1e12");
}, { catalog: new FakeDetails() });

browseTest("season Details keeps watched available when the server rejects list membership, and tolerates missing metadata", async (tv) => {
    await tv.page.route("**/api/v2/*/series%3As1-S1/membership", async (route) => {
        await route.fulfill({ status: 404, json: problem(404, "not_found", "Not found").body });
    });
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "item:series:s1");
    await seasonDetails(tv);
    await detailsMore(tv);
    await tv.page.getByRole("button", { name: "Mark all unwatched", exact: true }).waitFor();
    await tv.eventually(async () => !await tv.page.getByText("Loading personal actions.", { exact: true }).count(), "membership rejection");
    assert.equal(await tv.page.locator('[data-focus="watchlist"], [data-focus="favorites"]').count(), 0);
    await tv.remote(BACK);
    await tv.page.locator('[data-focus="next-episode"]').focus();
    await press(tv, "Enter");
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.plays.length === 1), "season primary playback");
    assert.equal((await tv.page.evaluate(() => window.browseHarness.plays))[0]?.contentId, "episode:s1e11");
    await tv.page.evaluate(() => window.browseHarness.resume());
    await showing(tv, "season:series:s1:1");
    await tv.remote(BACK);
    await showing(tv, "item:series:s1");
    await tv.page.route("**/api/v2/catalog/items/series%3As1-S1?**", async (route) => {
        await route.fulfill({ status: 404, json: problem(404, "not_found", "Not found").body });
    });
    await seasonDetails(tv);
    assert.equal(await tv.focused(), "episode:s1e11");
    assert.equal(await tv.page.locator(".browse-episode").count(), 3);
}, { catalog: new FakeDetails() });

browseTest("Details rejects insecure artwork and retains its text title when logo decoding fails", async (tv, catalog) => {
    catalog.failNext("/catalog/items/movie%3Am0001", { status: 200, body: { ...fixture("get_catalog_item_ok"), content_id: "movie:m0001", title: "Readable title", logo_url: "/broken-logo.svg", backdrop_url: "http://art.example.test/backdrop.jpg" } });
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await tv.jump(240);
    assert.equal(await tv.page.locator(".browse h1").textContent(), "Readable title");
    assert.equal(await tv.page.locator('.details-backdrop img, .details-logo').count(), 0);
    assert.equal(await tv.page.locator('img[src^="http:"]').count(), 0);
    assert.equal(await tv.focused(), "play");
}, { catalog: new FakeCatalog() });

browseTest("personal failure never repeats a write automatically and explicit retry reconciles state", async (tv, catalog) => {
    assert.ok(catalog instanceof FakeDetails);
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await tv.page.getByRole("button", { name: "Add to watchlist", exact: true }).waitFor();
    catalog.mutationFailure = problem(503, "unavailable", "Unavailable");
    await tv.page.getByRole("button", { name: "Add to watchlist", exact: true }).click();
    await shows(tv, "Could not update watchlist.");
    await tv.jump(30000);
    assert.equal(catalog.mutations.length, 1);
    await tv.page.getByRole("button", { name: "Retry watchlist", exact: true }).click();
    await tv.page.getByRole("button", { name: "Remove from watchlist", exact: true }).waitFor();
    assert.equal(catalog.mutations.length, 2);
    await detailsMore(tv);
    await tv.page.getByRole("button", { name: "Mark watched", exact: true }).click();
    await tv.page.getByRole("button", { name: "Mark unwatched", exact: true }).waitFor();
    assert.equal(await tv.page.locator('[data-focus="resume"]').count(), 0, "server refresh clears resume after watched");
}, { catalog: new FakeDetails() });

browseTest("entering a library flyout cancels its pending row dwell", async (tv) => {
    await tv.page.clock.pauseAt(await tv.page.evaluate(() => Date.now() + 1000));
    await press(tv, "ArrowUp", "ArrowRight");
    await tv.jump(250);
    await press(tv, "ArrowDown", "ArrowRight");
    assert.equal(await tv.focused(), "section:Recommended");
    const reads = tv.fake.requests.length;
    await tv.jump(150);
    assert.equal(await tv.focused(), "section:Recommended");
    assert.equal(tv.fake.requests.length, reads);
    await press(tv, "Enter");
    await showing(tv, "library:12");
}, { multipleLibraries: true });

browseTest("R2 cached library restores flyout modes without reads on focus", async (tv, catalog) => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    catalog.failNext("/catalog/search/capabilities", { status: 200, body: { ...fixture("get_catalog_search_capabilities_ok"), allowed: false, state: "unsupported" } });
    await tv.page.locator('[data-focus="series"]').click();
    await showing(tv, "library:13");
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    const reads = tv.fake.requests.length;
    await tv.page.locator('[data-focus="movies"]').focus();
    await tv.jump(250);
    await press(tv, "ArrowDown", "ArrowRight");
    assert.deepEqual(await tv.page.locator('.skyline-flyout [role="menuitem"]').allTextContents(), ["Recommended", "Collections", "Browse"]);
    assert.equal(tv.fake.requests.length, reads);
}, { multipleLibraries: true });

browseTest("a completed library read preserves navigation chosen while loading", async (tv) => {
    const pending = tv.fake.hold("/library/12/sections", true);
    await tv.page.locator('[data-focus="movies"]').click();
    await tv.page.locator('[aria-label="Loading"]').waitFor();
    await press(tv, "ArrowUp", "ArrowRight", "ArrowLeft");
    const focused = await tv.focused();
    assert.equal(focused, "movies");
    pending.release();
    await tv.eventually(async () => (await cardIds(tv)).length > 0, "library sections");
    assert.equal(await tv.focused(), focused);
});

browseTest("a completed letter jump preserves a different focused letter", async (tv, catalog) => {
    catalog.add({ id: "movie:alpha", type: "movie", title: "Alpha", libraryId: "12" });
    catalog.add({ id: "movie:zulu", type: "movie", title: "Zulu", libraryId: "12" });
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "A–Z");
    await tv.eventually(async () => (await tv.focused()) === "movie:alpha", "alphabetical grid");
    const pending = tv.fake.hold("/catalog/query", true);
    await tv.page.locator('[data-focus="letter:A"]').click();
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "letter:M");
    pending.release();
    await tv.eventually(async () => (await cardIds(tv)).length > 0, "letter results");
    assert.equal(await tv.focused(), "letter:M");
});

browseTest("a completed genre sort preserves its Sort control", async (tv) => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "Genres");
    await tv.page.locator('[data-focus="genre:Drama"]').click();
    await tv.eventually(async () => (await cardIds(tv)).length > 0, "genre results");
    const pending = tv.fake.hold("/catalog/query", true);
    await tv.page.locator('[data-focus="sort"]').click();
    assert.equal(await tv.focused(), "sort");
    pending.release();
    await tv.eventually(async () => (await cardIds(tv)).length > 0, "sorted results");
    assert.equal(await tv.focused(), "sort");
});

browseTest("Collections fans retain their width and contain their text", async (tv) => {
    await tv.page.emulateMedia({ reducedMotion: "reduce" });
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "Collections");
    const fan = tv.page.locator('.discovery-collection-grid .discovery-collection').first();
    const geometry = await fan.evaluate(node => {
        const card = node.getBoundingClientRect();
        const text = Array.from(node.querySelectorAll('.discovery-collection-name, .discovery-collection-count')).map(item => item.getBoundingClientRect());
        return { width: getComputedStyle(node).width, contained: text.every(item => item.right <= card.right && item.left >= card.left) };
    });
    assert.deepEqual(geometry, { width: "430px", contained: true });
});

browseTest("A–Z first row returns directly to pills with multiple letters", async (tv, catalog) => {
    catalog.add({ id: "movie:alpha", type: "movie", title: "Alpha", libraryId: "12" });
    catalog.add({ id: "movie:zulu", type: "movie", title: "Zulu", libraryId: "12" });
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "A–Z");
    await tv.eventually(async () => (await tv.focused()) === "movie:alpha", "first alphabetical card");
    assert.deepEqual(await tv.page.locator('.discovery-letters button').allTextContents(), ["A", "M", "Z"]);
    const reads = tv.fake.requests.length;
    await press(tv, "ArrowUp");
    assert.equal(await tv.page.locator('.skyline-pills :focus').count(), 1, "Up reaches the pills without traversing the rail");
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "movie:alpha");
    await press(tv, "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight");
    assert.equal(await tv.focused(), "letter:A");
    await press(tv, "ArrowDown", "ArrowDown");
    assert.equal(await tv.focused(), "letter:Z");
    await press(tv, "ArrowLeft");
    assert.equal(await tv.focused(), "movie:m0005");
    await press(tv, "ArrowRight");
    assert.equal(await tv.focused(), "letter:Z");
    await press(tv, "ArrowUp", "ArrowUp", "ArrowUp");
    assert.equal(await tv.page.locator('.skyline-pills :focus').count(), 1);
    assert.equal(tv.fake.requests.length, reads);
});

browseTest("R2 grid focus remains visible and remote enters right rail without reads", async (tv) => {
    await tv.page.emulateMedia({ reducedMotion: "reduce" });
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "A–Z");
    await tv.eventually(async () => (await cardIds(tv)).length === 24, "grid page");
    const visible = await tv.page.locator('.browse .browse-card').first().evaluate(node => {
        const card = node.getBoundingClientRect();
        const viewport = node.closest('.skyline-content')?.getBoundingClientRect();
        return viewport !== undefined && card.top >= viewport.top && card.left >= viewport.left;
    });
    assert.equal(visible, true, "scaled focus border remains inside viewport");
    const rowTops = await tv.page.locator('.browse .browse-grid .browse-card').evaluateAll(nodes => nodes.slice(1, 6).map(node => node.getBoundingClientRect().top));
    assert.equal(new Set(rowTops).size, 1, "the six-column focus map matches the rendered row");
    const reads = tv.fake.requests.length;
    await press(tv, "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight");
    assert.equal(await tv.focused(), "letter:M");
    await press(tv, "ArrowLeft");
    assert.equal(await tv.focused(), "movie:m0006");
    assert.equal(tv.fake.requests.length, reads);
});

browseTest("R2 interrupted letter read resumes on cached library return", async (tv) => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "A–Z");
    await tv.page.locator('[data-focus="letter:M"]').waitFor();
    const pending = tv.fake.hold("/catalog/query", true);
    const before = tv.fake.requests.length;
    await tv.page.locator('[data-focus="letter:M"]').click();
    await tv.eventually(async () => tv.fake.requests.length > before, "held letter read");
    await tv.page.locator('[data-focus="series"]').click();
    await showing(tv, "library:13");
    pending.release();
    await tv.page.locator('[data-focus="movies"]').click();
    await tv.eventually(async () => (await cardIds(tv)).length > 0, "replacement letter page");
    assert.equal(await tv.page.locator('[data-focus="letter:M"]').getAttribute("aria-pressed"), "true");
});

browseTest("full library Browse keeps Recommended and exposes the Swift control row and grid", async tv => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    assert.equal(await tv.page.locator('.skyline-pills').count(), 0);
    await selectLibraryMode(tv, "Browse");
    await tv.page.locator('.catalog-grid .browse-card').first().waitFor();
    assert.equal(await tv.page.locator('.browse-controls [data-focus="sort"]').count(), 1);
    assert.equal(await tv.page.locator('.browse-controls [data-focus="filter"]').count(), 1);
    assert.equal(await tv.page.locator('.browse-letters [data-focus="letter:T"]').count(), 1);
    assert.equal(await tv.page.locator('.catalog-grid .browse-art').first().evaluate(node => node.getBoundingClientRect().width), 260);
    const requests = tv.fake.requests.length;
    await tv.page.locator('.catalog-grid .browse-card').first().focus();
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(tv.fake.requests.length, requests);
});

browseTest("Browse filter edits are drafts and nested Back restores the facet list", async tv => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "Browse");
    await tv.page.locator('.catalog-grid .browse-card').first().waitFor();
    const count = () => tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length;
    const before = count();
    await tv.page.locator('.browse-controls [data-focus="filter"]').click();
    await tv.page.locator('[data-focus="facet:genre"]').click();
    assert.equal(await tv.focused(), "facet-back");
    await tv.page.locator('[data-focus="value:Drama"]').click();
    assert.equal(count(), before);
    await tv.remote(BACK);
    assert.equal(await tv.focused(), "facet:genre");
    await tv.page.locator('[data-focus="match:any"]').click();
    assert.equal(count(), before);
    await tv.page.locator('[data-focus="done"]').click();
    await tv.eventually(() => Promise.resolve(count() === before + 1), "one committed filter query");
    assert.equal(await tv.focused(), "sort");
});

browseTest("Browse typography survives the Samsung simulator font injection", async tv => {
    await tv.page.addStyleTag({ content: "* { font-family: SamsungOne; font-weight: 600; }" });
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "Browse");
    await tv.page.locator('.catalog-grid .browse-card').first().waitFor();
    const styles = await tv.page.locator('.browse.library-browse').evaluate(root => {
        const read = (selector: string) => { const node = root.querySelector(selector); if (node === null) throw new Error(selector); const style = getComputedStyle(node); return { font: style.fontFamily, weight: style.fontWeight, align: style.textAlign }; };
        return { direction: read('.browse-control-detail'), title: read('.catalog-grid .browse-card-title'), metadata: read('.catalog-grid .browse-card-subtitle') };
    });
    assert.equal(styles.direction.weight, "500");
    assert.equal(styles.direction.font.startsWith("Inter"), true);
    assert.equal(styles.title.weight, "500");
    assert.equal(styles.title.align, "center");
    assert.equal(styles.metadata.weight, "400");
});

browseTest("applying a Browse draft with unchanged query values reuses the loaded grid", async tv => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "Browse");
    await tv.page.locator('.catalog-grid .browse-card').first().waitFor();
    const before = tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length;
    await tv.page.locator('.browse-controls [data-focus="filter"]').click();
    await tv.page.locator('[data-focus="facet:genre"]').click();
    await tv.page.locator('[data-focus="value:Drama"]').click();
    await tv.page.locator('[data-focus="value:Drama"]').click();
    await tv.remote(BACK);
    await tv.page.locator('[data-focus="done"]').click();
    await tv.page.clock.runFor(0);
    assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length, before);
    assert.equal(await tv.focused(), "sort");
});

browseTest("Browse restores saved sort when entered from the navigation menu", async tv => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "Browse");
    await tv.page.locator('.catalog-grid .browse-card').first().waitFor();
    await tv.page.locator('.browse-controls [data-focus="sort"]').click();
    await tv.page.locator('[data-focus="sort:year"]').click();
    await tv.page.locator('.catalog-grid .browse-card').first().waitFor();
    await tv.page.locator('[data-focus="home"]').click();
    await tv.page.locator('[data-focus="movies"]').focus();
    await tv.jump(250); await press(tv, "ArrowDown");
    await tv.page.locator('.skyline-selector [data-focus="section:browse"]').click();
    await tv.page.locator('.catalog-grid .browse-card').first().waitFor();
    assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).pop()?.body?.sort, "year");
    assert.equal(await tv.page.locator('.browse-controls [data-focus="sort"]').textContent(), "Sort · YearNewest");
});

browseTest("entering Browse before Recommended finishes still discovers all existing library destinations", async tv => {
    const held = tv.fake.hold("/catalog/search/capabilities", true);
    await tv.page.locator('[data-focus="movies"]').click();
    await tv.eventually(async () => tv.fake.requests.some(request => request.path === "/catalog/search/capabilities"), "Recommended capability request");
    const cancelled = tv.page.waitForEvent("requestfailed", request => new URL(request.url()).pathname === "/api/v2/catalog/search/capabilities");
    await selectLibraryMode(tv, "Browse");
    await cancelled; held.release();
    await tv.page.locator('.catalog-grid .browse-card').first().waitFor();
    await tv.eventually(async () => await tv.page.locator('[data-focus="mode:Genres"]').count() === 1, "Browse retains the supported destinations");
    assert.deepEqual(await tv.page.locator('.skyline-pills [data-focus]').allTextContents(), ["Recommended", "Collections", "Browse", "Genres", "A–Z", "Recently Added"]);
});

browseTest("Browse preserves a long facet viewport after selecting its focused value", async (tv, catalog) => {
    const read = catalog.route.bind(catalog);
    catalog.route = (method, path, profile, body) => {
        const response = read(method, path, profile, body);
        if (path.startsWith("/catalog/filters") && response !== undefined && typeof response.body === "object" && response.body !== null) return { ...response, body: { ...response.body, studios: Array.from({ length: 80 }, (_, index) => `Studio ${String(index).padStart(3, "0")}`) } };
        return response;
    };
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "Browse");
    await tv.page.locator('.catalog-grid .browse-card').first().waitFor();
    await tv.page.locator('.browse-controls [data-focus="filter"]').click();
    await tv.page.locator('[data-focus="facet:studio"]').click();
    for (let step = 0; step < 41; step++) await tv.page.keyboard.press("ArrowDown");
    await tv.jump(300);
    const focus = await tv.focused();
    await tv.page.keyboard.press("Enter");
    await tv.jump(300);
    assert.equal(await tv.focused(), focus);
    assert.equal(await tv.page.locator('.browse-panel-row:focus').evaluate(node => {
        const row = node.getBoundingClientRect(), pane = node.closest(".browse-panel-list")?.getBoundingClientRect();
        return pane !== undefined && row.top >= pane.top && row.bottom <= pane.bottom;
    }), true);
});

browseTest("Browse renders its grid while optional facet choices are still pending", async tv => {
    const held = tv.fake.hold("/catalog/filters", true);
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "Browse");
    await tv.eventually(async () => await tv.page.locator('.catalog-grid .browse-card').count() > 0, "grid does not await facets");
    held.release();
});

browseTest("Browse Shuffle sends one create and keeps failure recovery remote reachable", async tv => {
    await tv.page.route("**/api/v2/shuffles/capabilities", route => route.fulfill({ json: { allowed: true, state: "available", scope_kinds: ["library"] } }));
    let release = (): void => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let creates = 0;
    await tv.page.route("**/api/v2/shuffles", async route => {
        creates++;
        assert.deepEqual(route.request().postDataJSON(), { scope: { kind: "library", id: "12" } });
        await gate;
        await route.fulfill({ status: 404, contentType: "application/problem+json", json: problem(404, "not_found", "Missing shuffle scope").body });
    });
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "Browse");
    const shuffle = tv.page.locator('.browse-controls [data-focus="shuffle"]');
    await shuffle.waitFor();
    await shuffle.click();
    await tv.page.keyboard.press("Enter");
    await tv.page.keyboard.press("Enter");
    assert.equal(creates, 1);
    assert.equal(await tv.focused(), "shuffle");
    release();
    await tv.page.getByRole("alertdialog", { name: "Couldn't Shuffle" }).waitFor();
    assert.equal(await tv.focused(), "alert-ok");
    await tv.page.keyboard.press("ArrowUp");
    assert.equal(await tv.focused(), "alert-ok");
    await tv.remote(BACK);
    assert.equal(await tv.focused(), "shuffle");
    assert.equal(await tv.page.getByRole("alertdialog").count(), 0);
});

browseTest("Browse Shuffle hands its server session to the normal playback owner", async tv => {
    await tv.page.route("**/api/v2/shuffles/capabilities", route => route.fulfill({ json: { allowed: true, state: "available", scope_kinds: ["library"] } }));
    await tv.page.route("**/api/v2/shuffles", route => route.fulfill({ status: 201, json: { id: "sh1", current: { content_id: "movie:m0001" }, next: { content_id: "movie:m0002" } } }));
    await tv.page.route("**/api/v2/watch/**", route => route.fulfill({ json: { content_id: "movie:m0001", type: "movie", title: "Movie 0001", versions: [{ file_id: "f-movie:m0001", duration_seconds: 6000 }] } }));
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "Browse");
    await tv.page.locator('.browse-controls [data-focus="shuffle"]').click();
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.plays.length) === 1, "shuffle handoff");
    assert.deepEqual(await tv.page.evaluate(() => window.browseHarness.plays[0]), { contentId: "movie:m0001", fileId: "f-movie:m0001", title: "Movie 0001", startSeconds: 0, shuffleId: "sh1" });
});

for (const departure of ["mode", "settings", "route"] as const) browseTest(`a pending Shuffle is discarded after leaving and returning through ${departure}`, async tv => {
    await tv.page.route("**/api/v2/shuffles/capabilities", route => route.fulfill({ json: { allowed: true, state: "available", scope_kinds: ["library"] } }));
    let release = (): void => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await tv.page.route("**/api/v2/shuffles", async route => { await gate; await route.fulfill({ status: 201, json: { id: "old", current: { content_id: "movie:m0001" }, next: { content_id: "movie:m0002" } } }); });
    await tv.page.route("**/api/v2/watch/**", route => route.fulfill({ json: { content_id: "movie:m0001", type: "movie", title: "Movie 0001", versions: [{ file_id: "f1", duration_seconds: 6000 }] } }));
    await tv.page.locator('[data-focus="movies"]').click(); await showing(tv, "library:12");
    await selectLibraryMode(tv, "Browse");
    await tv.page.locator('.browse-controls [data-focus="shuffle"]').click();
    if (departure === "mode") {
        await selectLibraryMode(tv, "Collections");
        await selectLibraryMode(tv, "Browse");
    } else if (departure === "settings") {
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.locator('[data-focus="settings"]').click();
        await tv.page.locator('.browse.library-browse').waitFor({ state: "hidden" });
        await tv.remote(BACK); await tv.page.locator('.browse.library-browse').waitFor({ state: "visible" });
    } else {
        await tv.page.locator('[data-focus="home"]').click();
        await tv.page.locator('[data-focus="movies"]').click();
    }
    const answer = tv.page.waitForResponse(response => new URL(response.url()).pathname === "/api/v2/shuffles" && response.request().method() === "POST");
    release(); assert.equal(await (await answer).finished(), null); await tv.page.clock.runFor(0);
    await tv.jump(300);
    assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 0);
    assert.equal(await view(tv), "library:12");
});

for (const [kind, value, label, lost] of [["favorites", "favorited", "favorite", false], ["watchlist", "watchlist", "from watchlist", false], ["favorites", "favorited", "favorite", true]] as const) {
    const catalog = new FakeDetails();
    if (kind === "favorites") catalog.favorite = true; else catalog.watchlist = true;
    const read = catalog.route.bind(catalog);
    catalog.route = (method, path, profile, body) => {
        const reply = read(method, path, profile, body), response = reply?.body;
        if (path.startsWith("/catalog/query") && (JSON.stringify(body?.groups) ?? "").includes(kind === "favorites" ? "favorited" : "in_watchlist") && response !== null && typeof response === "object" && "items" in response && Array.isArray(response.items)) {
            const items = (kind === "favorites" ? catalog.favorite : catalog.watchlist) ? response.items.slice(0, 1) : [];
            return { ...reply, status: 200, body: { ...response, items, total: items.length, total_exact: true, page: { has_more: false } } };
        }
        return reply;
    };
    browseTest(`Details ${kind} removal refreshes filtered Browse${lost ? " after a lost answer" : ""}`, async tv => {
        await tv.page.locator('[data-focus="movies"]').click(); await showing(tv, "library:12");
        await selectLibraryMode(tv, "Browse");
        await tv.page.locator('.browse-controls [data-focus="filter"]').click();
        await tv.page.locator('[data-focus="facet:watchStatus"]').click();
        await tv.page.locator(`[data-focus="value:${value}"]`).click(); await tv.remote(BACK); await tv.remote(BACK);
        await tv.eventually(async () => await tv.page.locator('.catalog-grid .browse-card').count() === 1, "filtered member");
        await tv.page.locator('.catalog-grid .browse-card').click(); await showing(tv, "item:movie:m0001");
        if (lost) tv.fake.dropNextAnswer(`/favorites/movie%3Am0001`);
        if (kind === "favorites") await detailsMore(tv);
        await tv.page.getByRole("button", { name: `Remove ${label}`, exact: true }).click();
        await tv.page.getByRole("button", { name: lost ? "Retry favorites" : kind === "favorites" ? "Add favorite" : "Add to watchlist", exact: true }).waitFor();
        if (kind === "favorites") await tv.remote(BACK);
        await tv.remote(BACK);
        await tv.eventually(async () => await tv.page.getByText("No titles match your filters", { exact: true }).isVisible(), "membership removal refreshes Browse");
        assert.equal(await tv.page.locator('.catalog-grid .browse-card').count(), 0);
    }, { catalog });
}

browseTest("Browse retains 200 loaded cards, focus and scroll through an ordinary Details visit", async tv => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "Browse");
    await tv.eventually(async () => await tv.page.locator('.catalog-grid .browse-card').count() === 100, "first library batch");
    await tv.page.locator('.catalog-grid .browse-card').last().focus();
    await press(tv, "ArrowLeft", "ArrowRight");
    await tv.jump(300);
    await tv.eventually(async () => await tv.page.locator('.catalog-grid .browse-card').count() === 200, "second library batch");
    await tv.page.locator('.catalog-grid [data-focus="movie:m0121"]').focus();
    await press(tv, "ArrowRight", "ArrowLeft");
    await tv.jump(300);
    const scroll = await tv.page.locator('.skyline-content').evaluate(node => node.scrollTop);
    const beforeBounds = await tv.page.locator('.catalog-grid [data-focus="movie:m0121"]').evaluate(node => ({ card: node.getBoundingClientRect().toJSON(), viewport: node.closest('.skyline-content')?.getBoundingClientRect().toJSON() }));
    const reads = tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length;
    await tv.remote(13);
    await showing(tv, "item:movie:m0121");
    await tv.remote(BACK);
    assert.equal(await tv.focused(), "movie:m0121");
    assert.equal(await tv.page.locator('.catalog-grid .browse-card').count(), 200);
    assert.equal(await tv.page.locator('.skyline-content').evaluate(node => node.scrollTop), scroll, JSON.stringify({ beforeBounds, afterBounds: await tv.page.locator('.catalog-grid [data-focus="movie:m0121"]').evaluate(node => ({ card: node.getBoundingClientRect().toJSON(), viewport: node.closest('.skyline-content')?.getBoundingClientRect().toJSON() })) }));
    assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length, reads);
    await tv.remote(13);
    await showing(tv, "item:movie:m0121");
    await tv.page.locator('.browse [data-focus="play"]').click();
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.plays.length) === 1, "playback handoff");
    await tv.page.evaluate(() => window.browseHarness.resume());
    await tv.page.locator('.browse [data-focus="play"]').waitFor();
    await tv.remote(BACK);
    await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length === reads + 2, "playback invalidation refreshes retained depth");
    await tv.eventually(async () => await tv.page.locator('.catalog-grid .browse-card').count() === 200, "refreshed loaded depth");
    assert.equal(await tv.focused(), "movie:m0121");
}, { catalog: new FakeCatalog(260) });

for (const [size, scale, columns] of [["compact", .86, 6], ["standard", 1, 6], ["large", 1.2, 5]] as const) {
    browseTest(`Browse ${size} card tracks and D-pad columns follow the profile`, async tv => {
        await tv.page.locator('[data-focus="movies"]').click();
        await showing(tv, "library:12");
        await selectLibraryMode(tv, "Browse");
        const card = tv.page.locator('.catalog-grid .browse-card').first();
        await card.waitFor();
        const width = await card.locator('.browse-art').evaluate(node => (node as HTMLElement).offsetWidth);
        assert.ok(Math.abs(width - 260 * scale) < 1);
        if (size === "compact") {
            const positions = await tv.page.locator('.catalog-grid .browse-art').evaluateAll(nodes => nodes.slice(0, 7).map(node => { const frame = node.getBoundingClientRect(); return [Math.round(frame.x), Math.round(frame.y)]; }));
            assert.deepEqual(positions, [[94, 333], [386, 333], [677, 333], [969, 333], [1261, 333], [1552, 333], [94, 801]]);
        }
        await card.focus();
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), `movie:m${String(columns + 1).padStart(4, "0")}`);
    }, { beforeConnect: tv => { new FakeSettings(tv.fake).profile().set(CARD_PRESENTATION_KEY, { poster_size: size, caption: "title_metadata" }); } });
}

browseTest("a failed Browse append retains cards until a completed explicit retry", async tv => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "Browse");
    await tv.eventually(async () => await tv.page.locator('.catalog-grid .browse-card').count() === 100, "initial Browse batch");
    const retained = await cardIds(tv, '.catalog-grid .browse-card');
    let failed = false;
    await tv.page.route("**/api/v2/catalog/query?*", async route => {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        if (body.cursor !== undefined && !failed) { failed = true; await route.fulfill({ status: 422, contentType: "application/problem+json", json: problem(422, "validation_failed", "Could not read next page").body }); }
        else await route.fallback();
    });
    await tv.page.locator('.catalog-grid .browse-card').last().focus();
    await tv.page.keyboard.press("ArrowUp");
    await tv.page.getByRole("alert").waitFor();
    assert.deepEqual(await cardIds(tv, '.catalog-grid .browse-card'), retained);
    const recovered = tv.page.waitForResponse(response => new URL(response.url()).pathname === "/api/v2/catalog/query" && response.ok());
    await tv.page.getByRole("button", { name: "Try again", exact: true }).click();
    assert.equal(await (await recovered).finished(), null);
    assert.equal((await recovered).request().postDataJSON().cursor, undefined);
    try {
        await tv.eventually(async () => await tv.page.getByRole("alert").count() === 0 && await tv.page.locator('.section-catalog-loading').count() === 0, "retry finished");
        assert.deepEqual((await cardIds(tv, '.catalog-grid .browse-card')).slice(0, retained.length), retained);
    } catch (cause) {
        const cards = await tv.page.locator('.catalog-grid .browse-card').count();
        const alerts = await tv.page.getByRole("alert").count();
        const loading = await tv.page.locator('.section-catalog-loading').count();
        if (cause instanceof Error) cause.message += `; Browse retry retained ${cards} cards with ${alerts} alerts and ${loading} loading indicators`;
        throw cause;
    }
}, { catalog: new FakeCatalog(260) });

browseTest("Browse keeps Down in the final grid row while the next page is pending", async tv => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "Browse");
    await tv.eventually(async () => await tv.page.locator('.catalog-grid .browse-card').count() === 100, "first Browse page");
    const held = tv.fake.hold("/catalog/query", true);
    const before = tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length;
    await tv.page.locator('.catalog-grid .browse-card').last().focus();
    await press(tv, "ArrowLeft", "ArrowRight"); await tv.jump(300);
    await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length === before + 1, "pending Browse append");
    const focus = await tv.focused();
    const moves = await tv.page.evaluate(() => {
        const focused = [document.activeElement?.getAttribute("data-focus")];
        // Keep the key sequence together so a background redraw cannot repair stale focus memory.
        for (const [key, keyCode] of [["ArrowLeft", 37], ["ArrowRight", 39], ["ArrowDown", 40]] as const) {
            document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, keyCode, bubbles: true, cancelable: true }));
            focused.push(document.activeElement?.getAttribute("data-focus"));
        }
        return focused;
    });
    assert.deepEqual(moves, [focus, "movie:m0099", focus, focus]);
    assert.equal(await tv.focused(), focus);
    held.release();
    await tv.eventually(async () => await tv.page.locator('.catalog-grid .browse-card').count() === 200, "completed Browse append");
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "movie:m0106");
}, { catalog: new FakeCatalog(260) });

let browsePosterAnswer: { release(): void };
browseTest("a late larger Browse poster answer repaints retained cards and reveals the same focus", async tv => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "Browse");
    const card = tv.page.locator('.catalog-grid [data-focus="movie:m0012"]');
    await card.focus();
    const old = await card.elementHandle();
    const reads = tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length;
    browsePosterAnswer.release();
    await tv.eventually(async () => await card.locator('.browse-art').evaluate(node => (node as HTMLElement).offsetWidth) === 312, "large Browse card applied");
    await tv.jump(500);
    assert.equal(await tv.focused(), "movie:m0012");
    assert.equal(await old?.evaluate(node => node.isConnected), false);
    assert.equal(await card.evaluate(node => {
        const art = node.querySelector('.browse-art')?.getBoundingClientRect(), viewport = node.closest('.skyline-content')?.getBoundingClientRect();
        return art !== undefined && viewport !== undefined && art.top >= viewport.top && art.bottom <= viewport.bottom;
    }), true);
    assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length, reads);
}, { beforeConnect: tv => {
    new FakeSettings(tv.fake).profile().set(CARD_PRESENTATION_KEY, { poster_size: "large", caption: "title_metadata" });
    browsePosterAnswer = tv.fake.hold("/settings/values/effective?keys=ui.card_presentation", true);
} });

let browseBadgeAnswer: { release(): void };
browseTest("a late Browse overlay answer repaints existing cards without a query or focus change", async (tv, catalog) => {
    const read = catalog.route.bind(catalog);
    catalog.route = (method, path, profile, body) => {
        const reply = read(method, path, profile, body), response = reply?.body;
        if (path.startsWith("/catalog/query") && reply?.status === 200 && typeof response === "object" && response !== null && "items" in response && Array.isArray(response.items)) {
            return { ...reply, body: { ...response, items: response.items.map((item: unknown) => typeof item === "object" && item !== null ? { ...item, overlay_summary: { resolution: "2160p" } } : item) } };
        }
        return reply;
    };
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "Browse");
    const card = tv.page.locator('.catalog-grid [data-focus="movie:m0006"]');
    await card.focus();
    assert.ok(await card.locator('.card-overlay').count() > 0);
    const reads = tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length;
    browseBadgeAnswer.release();
    await tv.eventually(async () => await card.locator('.card-overlay').count() === 0, "disabled Browse badges removed");
    assert.equal(await tv.focused(), "movie:m0006");
    assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length, reads);
}, { beforeConnect: tv => {
    const settings = new FakeSettings(tv.fake); settings.overlayConfig = { enabled: false };
    browseBadgeAnswer = tv.fake.hold("/settings/overlay-config", true);
} });

browseTest("a pending Browse read cannot publish after a profile switch", async (tv, catalog) => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    const held = tv.fake.hold("/catalog/query", true);
    const produced = new Promise<void>(resolve => {
        const read = catalog.route.bind(catalog);
        catalog.route = (method, path, profile, body) => { const reply = read(method, path, profile, body); if (path.startsWith("/catalog/query")) resolve(); return reply; };
    });
    const cancelled = tv.page.waitForEvent("requestfailed", request => new URL(request.url()).pathname === "/api/v2/catalog/query");
    await selectLibraryMode(tv, "Browse");
    await tv.page.getByRole("status", { name: "Loading", exact: true }).waitFor();
    await tv.page.evaluate(() => window.browseHarness.clearProfile());
    await cancelled;
    assert.equal(await tv.page.evaluate(() => window.browseHarness.selectProfile("p-kid", "2468")), "verified");
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.page.locator('[data-view="home"] [data-section="kids_picks"]').waitFor();
    const focus = await tv.focused();
    held.release(); await produced; await tv.page.clock.runFor(0);
    assert.equal(await tv.focused(), focus);
    assert.equal(await tv.page.locator('.catalog-grid').count(), 0);
    assert.equal(await tv.page.locator('[data-section="kids_picks"]').count(), 1);
});

browseTest("R2 invalid cursor resets only the active query and cached reopening starts fresh", async (tv, catalog) => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "Recently Added");
    await tv.page.locator('.browse [data-focus="next"]').click();
    await shows(tv, "Page 2 of 3");
    catalog.failNext("/catalog/query", problem(400, "invalid_cursor", "Invalid cursor"));
    await tv.page.locator('.browse [data-focus="next"]').click();
    await shows(tv, "The list changed. Go back and open it again.");
    await tv.page.locator('[data-focus="home"]').click();
    await showing(tv, "home");
    await tv.page.locator('[data-focus="movies"]').click();
    await shows(tv, "Page 1 of 3");
    assert.equal(tv.fake.requests.filter(request => request.path === "/catalog/query").pop()?.body?.cursor, undefined);
});

browseTest("activating current Recommended restores its content without reads", async (tv, catalog) => {
    await tv.page.emulateMedia({ reducedMotion: "reduce" });
    const household = catalog.households.get("p-owner");
    assert.ok(household);
    household.librarySections = [
        { id: "first", title: "First", items: Array.from({ length: 24 }, (_, index) => `movie:m${String(index + 1).padStart(4, "0")}`) },
        { id: "second", title: "Second", items: ["movie:m0025"] },
    ];
    const paths = [13, 14, 15, 16].map(index => `/catalog/items/movie%3Am00${index}`);
    const held = paths.map(path => tv.fake.hold(path, true));
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await tv.eventually(async () => paths.every(path => tv.fake.requests.some(request => request.path.split("?")[0] === path)), "accepted enrichment workers held");
    held.forEach(gate => gate.release());
    const titles = await tv.page.locator('[data-view="library:12"] .home-section .browse-card:not(.skyline-explore)').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus") ?? ""));
    await tv.eventually(async () => titles.every(id => tv.fake.requests.some(request => request.path.split("?")[0] === `/catalog/items/${encodeURIComponent(id)}`)), "accepted enrichment queue dispatched");
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "movie:m0025");
    const reads = tv.fake.requests.length;
    await selectLibraryMode(tv, "Recommended");
    assert.equal(await tv.focused(), "movie:m0025");
    assert.equal(tv.fake.requests.length, reads);
    assert.equal(await tv.page.locator('.browse [data-focus="movie:m0025"]').evaluate(node => {
        const bounds = node.getBoundingClientRect();
        const viewport = node.closest('.skyline-content')?.getBoundingClientRect();
        return viewport !== undefined && bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
    }), true);
    const upward = await tv.page.evaluate(() => [1, 2].map(() => {
        document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", keyCode: 38, bubbles: true, cancelable: true }));
        return document.activeElement?.getAttribute("data-focus");
    }));
    assert.deepEqual(upward, ["movie:m0001", "movies"], "reselecting the current mode leaves a live path back to navigation");
    assert.equal(tv.fake.requests.length, reads);
});

browseTest("R2 grid destinations retain pills without marquee and place rail on right", async (tv) => {
    await tv.page.emulateMedia({ reducedMotion: "reduce" });
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "A–Z");
    await tv.page.locator('[data-focus="letter:M"]').waitFor();
    assert.equal(await tv.page.locator('.browse .skyline-marquee').count(), 0);
    const rail = await tv.page.locator('.browse .discovery-letters').boundingBox();
    assert.ok(rail !== null && rail.x > 1700);
    const content = await tv.page.locator('.browse .skyline-content').boundingBox();
    assert.ok(content !== null && content.y < 260);
});

browseTest("R2 Recommended omits collections and Collections uses fan grid", async (tv) => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    assert.equal(await tv.page.locator('.browse [data-focus="collection:highlights"]').count(), 0);
    await selectLibraryMode(tv, "Collections");
    await tv.page.locator('.browse .discovery-collection').waitFor();
    const card = await tv.page.locator('.browse .discovery-collection').first().boundingBox();
    assert.ok(card !== null && card.width >= 430 && card.height >= 234);
    assert.equal(await tv.page.locator('.browse .discovery-collection-count').first().innerText(), "60 titles");
});

browseTest("R2 capability read failure renders Retry", async (tv, catalog) => {
    catalog.failNext("/catalog/search/capabilities", { status: 200, body: {} });
    await tv.page.locator('[data-focus="movies"]').click();
    await tv.page.locator('.browse [data-focus="retry"]').waitFor();
    await tv.page.locator('.browse [data-focus="retry"]').click();
    await showing(tv, "library:12");
    await tv.page.locator('[data-view="library:12"] .home-section .browse-card').first().waitFor();
    await tv.page.locator('[data-focus="movies"]').focus();
    await tv.remote(40);
    assert.equal(await tv.page.locator('.skyline-selector [role="menuitem"]').count(), 3);
});

browseTest("R2 Collections fan geometry and focus border stay inside the viewport", async (tv) => {
    await tv.page.emulateMedia({ reducedMotion: "reduce" });
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "Collections");
    await tv.page.locator('.browse .discovery-collection').waitFor();
    const geometry = await tv.page.locator('.browse .discovery-collection').first().evaluate(node => {
        const grid = node.parentElement;
        const viewport = node.closest('.skyline-content')?.getBoundingClientRect();
        const card = node.getBoundingClientRect();
        return { width: node.clientWidth + 4, height: node.clientHeight + 4, columns: grid === null ? "" : getComputedStyle(grid).gridTemplateColumns, gap: grid === null ? "" : getComputedStyle(grid).columnGap, visible: viewport !== undefined && card.top >= viewport.top && card.left >= viewport.left && card.bottom <= viewport.bottom };
    });
    assert.deepEqual(geometry, { width: 430, height: 234, columns: "430px 430px 430px", gap: "26px", visible: true });
});

browseTest("R2 personal collections retain server group and query source", async (tv, catalog) => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    catalog.failNext("/library/12/collections", { status: 200, body: fixture("get_library_collections_ok") });
    await selectLibraryMode(tv, "Collections");
    await tv.page.locator('[data-focus="collection:u1"]').waitFor();
    await shows(tv, "Mine");
    await tv.page.locator('[data-focus="collection:u1"]').click();
    await tv.eventually(async () => tv.fake.requests.some(request => request.body?.source === "user_collection"), "personal collection query");
    assert.deepEqual(tv.fake.requests.filter(request => request.body?.source === "user_collection").pop()?.body, { library_id: "12", type: "movie", limit: 24, sort: "title", order: "asc", source: "user_collection", scope: "library", collection_id: "u1" });
});

browseTest("R2 filtered genres keep library chrome", async (tv) => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "Genres");
    await tv.page.locator('[data-focus="genre:Drama"]').click();
    await shows(tv, "Title A–Z");
    assert.equal(await tv.page.locator('.browse .skyline-pills button').count(), 6);
    assert.equal(await tv.page.locator('.browse .skyline-marquee').count(), 0);
});

browseTest("discovery exposes three library menu destinations", async (tv) => {
    if (process.env.DISCOVERY_CAPTURE !== undefined) await tv.page.emulateMedia({ reducedMotion: "reduce" });
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    const evidence = process.env.DISCOVERY_OUTPUT;
    if (process.env.DISCOVERY_CAPTURE !== undefined) {
        assert.ok(evidence, "DISCOVERY_OUTPUT is required for capture");
        await mkdir(evidence, { recursive: true });
        await tv.page.clock.runFor(600);
        await tv.page.screenshot({ path: `${evidence}/${process.env.DISCOVERY_CAPTURE}.png` });
    }
    await tv.page.locator('[data-focus="movies"]').focus();
    await tv.remote(40);
    assert.deepEqual(await tv.page.locator('.skyline-selector [role="menuitem"]').allTextContents(), ["Recommended", "Collections", "Browse"]);
});

if (process.env.DISCOVERY_PACED !== undefined) {
    browseTest("discovery flow evidence: paced remote library destinations", async (tv) => {
        const output = process.env.DISCOVERY_OUTPUT;
        assert.ok(output, "DISCOVERY_OUTPUT is required for evidence");
        await mkdir(output, { recursive: true });
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        const key = async (value: string): Promise<void> => {
            await tv.page.keyboard.press(value);
            await tv.page.clock.runFor(650);
            await tv.page.waitForTimeout(650);
        };
        await key("ArrowUp");
        await key("ArrowRight");
        await key("Enter");
        await showing(tv, "library:12");
        await tv.page.screenshot({ path: `${output}/after-browse.png` });
        await key("ArrowUp");
        await key("ArrowUp");
        await key("ArrowRight");
        await key("Enter");
        await tv.page.locator('.browse .discovery-collection-grid').waitFor();
        await tv.page.screenshot({ path: `${output}/after-collections.png` });
        await key("ArrowUp");
        await key("ArrowRight");
        await key("ArrowRight");
        await key("Enter");
        await tv.page.locator('.browse .discovery-letters').waitFor();
        await tv.page.screenshot({ path: `${output}/after-az.png` });
        for (let index = 0; index < 6; index++) await key("ArrowRight");
        await key("Enter");
        await key("ArrowLeft");
        await key("ArrowDown");
        await key("ArrowDown");
        await tv.page.screenshot({ path: `${output}/after-lower-grid.png` });
    });
}

for (const [tab, library, first] of [["movies", "12", "movie:m0001"], ["series", "13", "series:s1"]]) {
    browseTest(`discovery flow ${tab}: sections, collection, genre, letters and Recently Added use one library`, async tv => {
        await tv.page.locator(`[data-focus="${tab}"]`).click();
        await showing(tv, `library:${library}`);
        assert.equal(await tv.focused(), first);
        await tv.page.locator('[data-focus="expand:library-picks"]').click();
        await tv.page.locator(".section-catalog-title").waitFor();
        await tv.page.locator(".section-catalog-grid .browse-card").first().waitFor();
        assert.deepEqual(tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).slice(-1)[0]?.body, { library_id: library, limit: 60, source: "section", scope: "library", section_id: "library-picks" });
        await tv.remote(BACK);
        assert.equal(await tv.focused(), "expand:library-picks");
        await selectLibraryMode(tv, "Collections");
        await tv.page.locator('[data-focus="collection:highlights"]').waitFor();
        await press(tv, "Enter");
        await shows(tv, "Library Highlights");
        await tv.eventually(async () => tv.fake.requests.some(request => request.path.startsWith(`/library/${library}/collections/highlights/items?limit=24`)), "scoped collection items");
        await tv.remote(BACK);
        assert.equal(await tv.focused(), "collection:highlights");
        await selectLibraryMode(tv, "Genres");
        await tv.page.locator('[data-focus="genre:Drama"]').waitFor();
        await tv.page.locator('[data-focus="genre:Drama"]').click();
        await shows(tv, "Title A–Z");
        await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).slice(-1)[0]?.body?.groups !== undefined, "genre query");
        assert.deepEqual(tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).slice(-1)[0]?.body?.groups, [{ match: "all", rules: [{ field: "genre", op: "is", value: "Drama" }] }]);
        await tv.page.locator('[data-focus="sort"]').click();
        await shows(tv, "Title Z–A");
        await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).slice(-1)[0]?.body?.order === "desc", "sort query");
        assert.equal(tv.fake.requests.slice(-1)[0]?.body?.cursor, undefined);
        await tv.remote(BACK);
        await tv.page.locator('[data-focus="genre:Comedy"]').click();
        await shows(tv, "No titles");
        await tv.remote(BACK);
        await selectLibraryMode(tv, "A–Z");
        await showing(tv, `library:${library}`);
        const letter = tv.page.locator(".discovery-letters button").first();
        await letter.click();
        await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).slice(-1)[0]?.body?.seek === 0, "server letter seek");
        assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).slice(-1)[0]?.body?.cursor, "window");
        await selectLibraryMode(tv, "Recently Added");
        await showing(tv, `library:${library}`);
        const query = tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).slice(-1)[0];
        assert.deepEqual(query?.body, { library_id: library, type: tab === "movies" ? "movie" : "series", limit: 24, sort: "added_at", order: "desc" });
        const count = tv.fake.requests.length;
        await press(tv, "ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp");
        assert.equal(tv.fake.requests.length, count);
    });
}

browseTest("discovery loading, retry and late answers preserve route and profile authority", async (tv, catalog) => {
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    const pending = tv.fake.hold("/library/12/collections", true);
    await selectLibraryMode(tv, "Collections");
    await tv.page.locator('[aria-label="Loading"]').waitFor();
    await tv.page.locator('[data-focus="series"]').click();
    await showing(tv, "library:13");
    pending.release();
    await tv.jump(500);
    assert.equal(await view(tv), "library:13");
    catalog.failNext("/library/13/collections", problem(403, "forbidden", "Forbidden"));
    await selectLibraryMode(tv, "Collections");
    await tv.page.locator('[data-focus="retry"]').waitFor();
    await press(tv, "Enter");
    await tv.page.locator('[data-focus="collection:highlights"]').waitFor();
    const authority = tv.fake.hold("/catalog/query", true);
    const queries = tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length;
    await selectLibraryMode(tv, "Recently Added");
    await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length > queries, "pending query before authority changes");
    await tv.page.evaluate(() => window.browseHarness.clearProfile());
    authority.release();
    await tv.jump(500);
    assert.equal(await tv.page.locator(".browse").count(), 0);
    await shows(tv, "Who's watching?");
});

browseTest("discovery omits unsupported capabilities and has no dead controls", async (tv, catalog) => {
    catalog.failNext("/catalog/search/capabilities", { status: 200, body: { ...fixture("get_catalog_search_capabilities_ok"), allowed: false, state: "unsupported" } });
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await tv.page.locator('[data-focus="movies"]').focus();
    await tv.remote(40);
    assert.deepEqual(await tv.page.locator('.skyline-selector [role="menuitem"]').allTextContents(), ["Recommended", "Collections", "Browse"]);
});

browseTest("discovery uses nonzero letter positions and cancels an obsolete query without fetching on focus", async (tv, catalog) => {
    catalog.add({ id: "movie:aaa", type: "movie", title: "A River Beyond the Mountains and Across the Entire Continent", libraryId: "12" });
    await tv.page.emulateMedia({ reducedMotion: "reduce" });
    await tv.page.locator('[data-focus="movies"]').click();
    await showing(tv, "library:12");
    await selectLibraryMode(tv, "A–Z");
    await showing(tv, "library:12");
    assert.equal(await tv.page.locator('[data-focus="letter:M"]').getAttribute("aria-label"), "M, 60 titles");
    await tv.page.locator('[data-focus="letter:M"]').click();
    await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).slice(-1)[0]?.body?.seek === 1, "nonzero server seek");
    await tv.eventually(async () => (await cardIds(tv))[0] === "movie:m0001", "letter window starts on server position");
    const delayed = tv.fake.hold("/catalog/query", true);
    const queries = tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length;
    await selectLibraryMode(tv, "Recently Added");
    await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length > queries, "pending query before mode changes");
    await selectLibraryMode(tv, "Collections");
    await tv.page.locator('[data-focus="collection:highlights"]').waitFor();
    delayed.release();
    await tv.jump(500);
    assert.equal(await tv.page.locator('.browse .skyline-pills [aria-pressed="true"]').innerText(), "Collections");
    assert.deepEqual(await cardIds(tv), []);
    const requests = tv.fake.requests.length;
    await tv.remote(BACK);
    await tv.page.locator('[data-focus="movies"]').focus();
    await tv.jump(250);
    await press(tv, "ArrowDown", "ArrowRight");
    assert.deepEqual(await tv.page.locator('.skyline-flyout [role="menuitem"]').allTextContents(), ["Recommended", "Collections", "Browse"]);
    await tv.remote(18);
    assert.equal(await tv.fake.requests.length, requests);
}, { multipleLibraries: true });

browseTest("Skyline keeps bounded type tabs and a passive debounced marquee", async (tv) => {
    assert.deepEqual(await cardIds(tv, ".browse-nav .browse-button"), ["search", "home", "movies", "series", "for_you", "calendar", "profiles"]);
    const headline = (): Promise<string | null> => tv.page.locator(".skyline-marquee-layer:not(.skyline-outgoing) h1").textContent();
    assert.equal(await headline(), "Movie 0001");
    const reads = tv.fake.requests.length;
    // The installed page clock keeps flowing, so a loaded runner can pass 150 ms before the next
    // read. Pause it so only the jump below opens the debounced layer. The outgoing title stays
    // mounted through the crossfade, so the read is the current layer.
    await tv.page.clock.pauseAt(await tv.page.evaluate(() => Date.now()) + 1000);
    await press(tv, "ArrowRight");
    assert.equal(await tv.focused(), "episode:s1e12");
    assert.equal(await headline(), "Movie 0001");
    await tv.jump(150);
    assert.equal(await headline(), "Harbor Lights", "episodes headline with their series");
    assert.equal(tv.fake.requests.length, reads);
});

browseTest("row scrolling has intermediate frames without delaying focus", async (tv) => {
    await tv.page.clock.pauseAt(await tv.page.evaluate(() => Date.now() + 1000));
    await tv.page.evaluate(() => { document.querySelector(".browse")?.setAttribute("data-probe", "scroll"); });
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "series:s1");
    const start = await tv.page.locator(".browse .skyline-content").evaluate((node) => node.scrollTop);
    await tv.page.clock.runFor(80);
    const middle = await tv.page.locator(".browse .skyline-content").evaluate((node) => node.scrollTop);
    await tv.page.clock.runFor(300);
    const end = await tv.page.locator(".browse .skyline-content").evaluate((node) => node.scrollTop);
    assert.ok(start < middle && middle < end, `${start} < ${middle} < ${end}`);
});

browseTest("Continue Watching keeps landscape geometry when backdrop or progress metadata is missing", async (tv) => {
    const boxes = await tv.page.evaluate(() => Array.from(document.querySelectorAll('[data-section="continue_watching"] .browse-card:not(.skyline-explore) .browse-art')).map(node => ({ width: node.clientWidth, height: node.clientHeight })));
    assert.deepEqual(boxes, [{ width: 360, height: 200 }, { width: 360, height: 200 }]);
});

browseTest("Continue Watching uses section type rather than its opaque identity", async (tv, catalog) => {
    const household = catalog.households.get("p-owner");
    assert.ok(household !== undefined);
    const section = household.sections[0];
    assert.ok(section !== undefined);
    section.sectionType = "continue_watching";
    section.id = "shelf-resume-opaque";
    section.title = "Resume";
    await tv.page.evaluate(() => { window.browseHarness.destroy(); window.browseHarness.mount(); });
    await tv.page.locator('[data-section="shelf-resume-opaque"] .browse-art').first().waitFor();
    const boxes = await tv.page.evaluate(() => Array.from(document.querySelectorAll('[data-section="shelf-resume-opaque"] .browse-card:not(.skyline-explore) .browse-art')).map(node => ({ width: node.clientWidth, height: node.clientHeight })));
    assert.deepEqual(boxes, [{ width: 360, height: 200 }, { width: 360, height: 200 }]);
});

browseTest("a populated Home changes route without copying every descendant's computed styles", async (tv, catalog) => {
    const household = catalog.households.get("p-owner");
    assert.ok(household !== undefined);
    household.sections = Array.from({ length: 6 }, (_, row) => ({
        id: `shelf-${row}`,
        title: `Shelf ${row + 1}`,
        items: Array.from({ length: 20 }, (_, column) => `movie:m${String(row * 20 + column + 1).padStart(4, "0")}`),
    }));
    await tv.page.evaluate(() => { window.browseHarness.destroy(); window.browseHarness.mount(); });
    await showing(tv, "home");
    await tv.page.clock.pauseAt(await tv.page.evaluate(() => Date.now() + 1000));
    const response = tv.fake.hold("/library/12/sections", true);
    const reads = await tv.page.evaluate(() => {
        let calls = 0;
        const original = window.getComputedStyle;
        window.getComputedStyle = (element, pseudo) => { calls++; return original.call(window, element, pseudo); };
        try {
            document.querySelector<HTMLButtonElement>('[data-focus="movies"]')?.click();
        } finally {
            window.getComputedStyle = original;
        }
        return calls;
    });
    assert.ok(reads < 20, `navigation must not read computed styles for every card node: ${reads}`);
    await showing(tv, "library:loading");
    const snapshot = tv.page.locator(".skyline-route-outgoing");
    assert.equal(await snapshot.getAttribute("aria-hidden"), "true");
    assert.equal(await snapshot.locator(".browse-card:not(.skyline-explore)").count(), 120);
    assert.equal(await snapshot.locator(".skyline-explore").count(), 6);
    assert.equal(await snapshot.locator(".browse-nav, [data-focus]").count(), 0);
    assert.deepEqual(await snapshot.locator(".browse-art").first().evaluate((node) => ({ width: node.clientWidth, height: node.clientHeight })), { width: 176, height: 264 });
    response.release();
    await showing(tv, "library:12");
    assert.equal(await tv.focused(), "movie:m0001");
}, { catalog: new FakeCatalog(120) });

browseTest("Search removes root chrome and new visits clear its query while root menus keep Back priority", async (tv) => {
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", "night");
    await tv.remote(IME_DONE);
    await shows(tv, "Night Shift");
    assert.equal(await tv.page.locator('[data-focus="profiles"]').count(), 0, "Search has no hidden root menu targets");
    await tv.remote(BACK);
    await showing(tv, "home");
    await tv.page.locator('[data-focus="profiles"]').focus();
    await tv.jump(250);
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "switch-profile");
    const reads = tv.fake.requests.length;
    await tv.remote(BACK);
    assert.equal(await view(tv), "home");
    assert.equal(await tv.focused(), "profiles");
    assert.equal(await tv.page.locator(".skyline-selector").first().isVisible(), false);
    assert.equal(tv.fake.requests.length, reads);
    await tv.page.locator('[data-focus="search"]').click();
    assert.equal(await tv.page.inputValue("#browse-search"), "");
    await tv.page.getByText("Search Silo", { exact: true }).waitFor();
});

browseTest("sideways menu dismissal removes its hidden focus zone", async (tv) => {
    await press(tv, "ArrowUp", "ArrowRight");
    await tv.jump(250);
    assert.equal(await tv.page.locator(".skyline-selector").first().isVisible(), true);
    await press(tv, "ArrowLeft");
    assert.equal(await tv.focused(), "home");
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "movie:m0001");
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "series:s1");
});

browseTest("many libraries stay bounded; dwell and Back never commit; scope survives remount", async (tv, catalog) => {
    const household = catalog.households.get("p-owner");
    assert.ok(household);
    household.hidden = [];
    for (let index = 0; index < 20; index++) household.libraries.push({ id: String(index + 30), name: `Library ${index} with a long title`, type: "movies", sort_order: index + 10 });
    await tv.page.evaluate(() => { window.browseHarness.destroy(); window.browseHarness.mount(); });
    await showing(tv, "home");
    assert.equal(await tv.page.locator(".browse").evaluate((node) => node.scrollWidth), 1920);
    await tv.page.clock.pauseAt(await tv.page.evaluate(() => Date.now() + 1000));
    await tv.page.evaluate(() => { window.retainedNavigation = document.querySelector(".browse-nav"); });
    const reads = tv.fake.requests.length;
    await press(tv, "ArrowUp", "ArrowRight");
    await tv.jump(249);
    assert.equal(await tv.page.locator(".skyline-selector").first().isVisible(), false);
    await tv.jump(1);
    assert.equal(await tv.page.locator(".skyline-selector").first().isVisible(), true);
    assert.equal(await tv.focused(), "movies", "dwell does not steal focus");
    assert.equal(tv.fake.requests.length, reads);
    await press(tv, "ArrowDown", "ArrowDown");
    await tv.remote(BACK);
    assert.equal(await tv.focused(), "movies");
    assert.equal(await view(tv), "home");
    await tv.jump(500);
    assert.equal(await tv.page.locator(".skyline-selector").first().isVisible(), false, "Back keeps the menu dismissed until focus leaves its anchor");
    await press(tv, "ArrowLeft", "ArrowRight");
    await tv.jump(250);
    await press(tv, "ArrowDown", "ArrowDown", "Enter");
    await showing(tv, "library:15");
    assert.equal(await tv.page.evaluate(() => window.retainedNavigation === document.querySelector(".browse-nav")), true);
    await tv.page.evaluate(() => { window.browseHarness.destroy(); window.browseHarness.mount(); });
    await showing(tv, "home");
    await press(tv, "ArrowUp", "ArrowRight", "Enter");
    await showing(tv, "library:15");
});

browseTest("long synopsis expands and scrolls accessibly; empty search omits Page 1 of 1", async (tv, catalog) => {
    catalog.failNext("/catalog/items/movie%3Am0001", { status: 200, body: { ...fixture("get_catalog_item_ok"), content_id: "movie:m0001", overview: "A long synopsis. ".repeat(900) } });
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await detailsMore(tv);
    await tv.page.locator('[data-focus="synopsis"]').focus();
    await press(tv, "Enter");
    const dialog = tv.page.getByRole("dialog", { name: "Synopsis" });
    assert.equal(await dialog.isVisible(), true);
    await press(tv, "ArrowDown");
    await tv.page.clock.runFor(220);
    assert.ok(await dialog.evaluate((node) => node.scrollTop > 0));
    await tv.remote(BACK);
    assert.equal(await tv.focused(), "synopsis");
    await tv.remote(BACK);
    await tv.remote(BACK);
    await showing(tv, "home");
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", "no-such-title");
    await tv.remote(IME_DONE);
    await shows(tv, "No results");
    assert.equal(await tv.page.locator(".browse-page-status").count(), 0);
});

browseTest("reduced motion snaps scrolling and the real Browse flyout preserves scope on Back", async (tv) => {
    await tv.page.emulateMedia({ reducedMotion: "reduce" });
    await press(tv, "ArrowDown");
    const top = await tv.page.locator(".browse .skyline-content").evaluate((node) => node.scrollTop);
    assert.ok(top > 0);
    await tv.page.clock.runFor(100);
    assert.equal(await tv.page.locator(".browse .skyline-content").evaluate((node) => node.scrollTop), top);
    await tv.remote(BACK);
    await press(tv, "ArrowRight");
    await tv.jump(250);
    await tv.remote(40);
    await tv.remote(39);
    assert.equal(await tv.focused(), "section:Recommended");
    assert.equal(await tv.page.locator(".skyline-flyout").textContent(), "RecommendedCollectionsBrowse");
    await tv.remote(37);
    assert.equal(await tv.focused(), "library:12");
    await tv.remote(BACK);
    assert.equal(await view(tv), "home");
    await press(tv, "Enter");
    await showing(tv, "library:12");
}, { multipleLibraries: true });

browseTest("Home lists visible video libraries and supported rows, and every row is reachable by remote", async (tv) => {
    const nav = await cardIds(tv, ".browse-nav .browse-button");
    assert.deepEqual(nav, ["search", "home", "movies", "series", "for_you", "calendar", "profiles"], "video roots, For You and Calendar between fixed utilities");
    const rows = await tv.page.evaluate(() => Array.from(document.querySelectorAll("[data-section]")).map((node) => node.getAttribute("data-section")));
    assert.deepEqual(rows, ["continue_watching", "recently_added"], "a row of only books is left out");
    assert.equal((await cardIds(tv)).indexOf("ebook:atlas"), -1, "the book card in a mixed row is left out");
    assert.equal(await tv.focused(), "movie:m0001", "focus starts on the first card");

    await press(tv, "ArrowRight");
    assert.equal(await tv.focused(), "episode:s1e12");
    const added = await cardIds(tv, '[data-section="recently_added"] .browse-card');
    assert.deepEqual(added.slice(0, 3), ["series:s1", "series:s2", "movie:m0001"], "Recently Added: series first, then movies");
    await press(tv, "ArrowDown");
    // The old assertion pressed Right twice and expected movie:m0001, which encoded Down landing on the first card.
    assert.equal(await tv.focused(), "movie:m0001", "Down from the second Continue Watching still keeps that column");
    await press(tv, "ArrowUp");
    assert.equal(await tv.focused(), "episode:s1e12", "Up along the same column returns to the still above");
    await press(tv, "ArrowUp", "ArrowRight");
    assert.equal(await tv.focused(), "movies");
    await press(tv, "ArrowUp");
    assert.equal(await tv.focused(), "movies", "nothing above the top zone");

    const reads = browseReads(tv);
    assert.ok(reads.length >= 3);
    assert.ok(reads.every((read) => read.headers["x-profile-id"] === "p-owner" && read.headers.authorization?.startsWith("Bearer ")));
    assert.ok(reads.every((read) => read.path.indexOf("include_hidden") === -1));

    const before = tv.fake.requests.length;
    await press(tv, "ArrowDown", "ArrowRight", "ArrowLeft", "ArrowDown", "ArrowRight", "ArrowRight", "ArrowUp", "ArrowUp");
    assert.equal(tv.fake.requests.length, before, "moving focus fetches nothing");

    await tv.remote(BACK);
    assert.equal(await tv.page.evaluate(() => window.browseHarness.lastKeyPrevented), false, "Back on Home reaches the app's root exit handler");
    assert.equal(await view(tv), "home");
});

browseTest(
    "a large library pages by cursor, keeps one page in the DOM and never fetches on focus moves",
    async (tv) => {
        await press(tv, "ArrowUp", "ArrowRight", "Enter");
        await showing(tv, "library:12");
        await selectLibraryMode(tv, "A–Z");
        await showing(tv, "library:12");
        await tv.eventually(async () => (await cardIds(tv)).length === PAGE_SIZE, "the first page");
        assert.deepEqual((await cardIds(tv)).slice(0, 2), ["movie:m0001", "movie:m0002"]);
        await shows(tv, "Page 1 of 209");
        const first = tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).pop();
        assert.deepEqual(first?.body, { library_id: "12", type: "movie", limit: 24, sort: "title", order: "asc" });

        const before = tv.fake.requests.length;
        await press(tv, "ArrowRight", "ArrowRight", "ArrowDown", "ArrowDown", "ArrowDown");
        assert.equal(await tv.focused(), "movie:m0021", "Down moves one grid row of six");
        await press(tv, "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight");
        assert.equal(await tv.focused(), "letter:M", "Right enters the right-edge rail");
        await press(tv, "ArrowLeft");
        assert.equal(await tv.focused(), "movie:m0024", "Left restores the grid edge card");
        assert.equal(tv.fake.requests.length, before, "moving focus fetches nothing");

        await press(tv, "ArrowDown");
        assert.equal(await tv.focused(), "next", "below the grid: the pager");
        for (let page = 2; page <= 4; page++) {
            await press(tv, "Enter");
            await shows(tv, `Page ${page} of 209`);
            assert.equal(await tv.focused(), "next", "focus stays on Next while the page changes");
            assert.equal((await cardIds(tv)).length, PAGE_SIZE, "only the shown page is in the DOM");
        }
        assert.equal((await cardIds(tv))[0], "movie:m0073");
        assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).pop()?.body?.cursor, "cursor-72");
        await press(tv, "ArrowLeft", "Enter");
        await shows(tv, "Page 3 of 209");
        assert.equal((await cardIds(tv))[0], "movie:m0049");
        assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length, 6, "Browse entry plus one request per A–Z page shown");
        const queries = tv.fake.requests.filter(request => request.path.startsWith("/catalog/query"));
        assert.equal(queries[0]?.body?.limit, 100, "Browse entry stays bounded");
        assert.ok(queries.slice(1).every(request => request.body?.limit === 24), "A–Z reads only the shown page, never the whole catalog");

        await press(tv, "ArrowUp");
        assert.equal(await tv.focused(), "movie:m0049", "the card focused before is not on this page: Up enters the grid at its first card");
        await press(tv, "ArrowRight", "Enter");
        await showing(tv, "item:movie:m0050");
        await press(tv, "Enter");
        await tv.page.evaluate(() => window.browseHarness.resume());
        await tv.remote(BACK);
        await showing(tv, "library:12");
        await tv.eventually(async () => tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).length === 7, "the refresh after playback");
        await shows(tv, "Page 3 of 209");
        assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).pop()?.body?.cursor, "cursor-48", "the refresh reloads the page shown, not the first");
        assert.equal(await tv.focused(), "movie:m0050", "focus returns to the card that was opened");
        await tv.remote(BACK);
        assert.equal(await tv.focused(), "movies", "Back returns to the selected type tab");
        await tv.remote(BACK);
        await showing(tv, "home");
    },
    { catalog: new FakeCatalog(5000) },
);

browseTest("details hand the player the file and resume point; returning restores focus and refreshes progress", async (tv, catalog) => {
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    assert.equal(await tv.focused(), "resume");
    await shows(tv, "Resume from 20:00");
    await press(tv, "Enter");
    await tv.eventually(async () => (await tv.page.evaluate(() => window.browseHarness.plays.length)) === 1, "fresh Resume handoff");
    assert.deepEqual(await tv.page.evaluate(() => window.browseHarness.plays), [
        { contentId: "movie:m0001", fileId: "f-movie:m0001", title: "Movie 0001", startSeconds: 1200, subtitle: { kind: "auto" } },
    ]);
    assert.equal(await tv.page.evaluate(() => document.querySelector<HTMLElement>(".browse")?.hidden), true, "browse hides for the player");
    await tv.remote(BACK);
    await press(tv, "ArrowRight");
    assert.equal(await tv.page.evaluate(() => window.browseHarness.lastKeyPrevented), false, "browse ignores keys while the player plays");
    assert.equal(await view(tv), "item:movie:m0001");

    catalog.progress.set("movie:m0001", 1300);
    await tv.page.evaluate(() => window.browseHarness.resume());
    await shows(tv, "Resume from 21:40");
    assert.equal(await tv.focused(), "resume", "focus returns to the button that started playback");
    await press(tv, "ArrowRight", "Enter");
    const fromStart = (await tv.page.evaluate(() => window.browseHarness.plays))[1];
    assert.equal(fromStart?.fileId, "f-movie:m0001");
    assert.equal(fromStart?.startSeconds, 0, "Play from start");
    await tv.page.evaluate(() => window.browseHarness.resume());

    await tv.remote(BACK);
    await showing(tv, "home");
    assert.equal(await tv.focused(), "movie:m0001", "Back restores the card in its row");
});

browseTest("series open seasons, episode Select plays directly, and playback returns by identity", async (tv) => {
    await press(tv, "ArrowDown", "Enter");
    await showing(tv, "item:series:s1");
    await shows(tv, "Harbor Lights");
    assert.equal(await tv.focused(), "next-episode");
    await press(tv, "ArrowDown", "ArrowRight");
    assert.equal(await tv.focused(), "season:2");
    await press(tv, "Enter");
    await detailsMore(tv);
    await tv.page.locator('[data-focus="season-info"]').click();
    await showing(tv, "season:series:s1:2");
    await shows(tv, "Harbor Lights · Season 2");
    assert.equal(await tv.focused(), "episode:s1e21");
    await press(tv, "ArrowDown", "Enter");
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.plays.length === 1), "direct season episode handoff");
    assert.equal(await tv.page.locator('[data-view="item:episode:s1e22"]').count(), 0);
    assert.deepEqual((await tv.page.evaluate(() => window.browseHarness.plays))[0], {
        contentId: "episode:s1e22",
        episode: true,
        fileId: "f-episode:s1e22",
        title: "Harbor Lights chapter 2.2",
        startSeconds: 0,
        subtitle: { kind: "auto" },
    });
    await tv.page.evaluate(() => window.browseHarness.resume());
    await showing(tv, "season:series:s1:2");
    assert.equal(await tv.focused(), "episode:s1e22");
    await tv.remote(BACK);
    await showing(tv, "item:series:s1");
    assert.equal(await tv.focused(), "more");
    await tv.remote(BACK);
    await showing(tv, "home");
    assert.equal(await tv.focused(), "series:s1");
}, { catalog: new FakeDetails() });

browseTest("episode-aware Search plays directly and preserves explicit information, query and Back focus", async (tv, catalog) => {
    catalog.progress.set("episode:s1e12", 420);
    await tv.page.locator('[data-focus="search"]').click();
    assert.equal(browseReads(tv, "/catalog/search/capabilities").length, 0, "empty Search performs no negotiation");
    await tv.page.fill("#browse-search", "chapter 1.2");
    await tv.remote(IME_DONE);
    await tv.eventually(async () => (await cardIds(tv)).includes("episode:s1e12"), "the episode-only match");
    assert.deepEqual(await cardIds(tv), ["episode:s1e12", "episode:s2e12"]);
    assert.match(browseReads(tv, "/catalog")[0]?.path ?? "", /q=chapter%201\.2&type=video_with_episodes&limit=24/);
    await tv.page.locator('[data-focus="episode:s1e12"]').focus();
    const reads = browseReads(tv).length;
    await press(tv, "ArrowRight", "ArrowLeft");
    assert.equal(browseReads(tv).length, reads, "focus never fetches");
    await press(tv, "Enter");
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.plays.length === 1), "direct Search episode handoff");
    assert.equal(await tv.page.locator('[data-view="item:episode:s1e12"]').count(), 0);
    assert.deepEqual((await tv.page.evaluate(() => window.browseHarness.plays))[0], {
        contentId: "episode:s1e12", fileId: "f-episode:s1e12", title: "Harbor Lights chapter 1.2", startSeconds: 420, episode: true, subtitle: { kind: "auto" },
    });
    await tv.page.evaluate(() => window.browseHarness.resume());
    await showing(tv, "search");
    assert.equal(await tv.focused(), "episode:s1e12");
    await tv.page.locator('[data-focus="episode:s1e12"]').click({ button: "right" });
    await tv.page.locator('[data-focus="episode-information"]').click();
    await showing(tv, "item:episode:s1e12");
    await tv.page.getByRole("button", { name: /^Resume/ }).click();
    await tv.eventually(async () => (await tv.page.evaluate(() => window.browseHarness.plays.length)) === 2, "fresh episode Resume handoff");
    assert.deepEqual((await tv.page.evaluate(() => window.browseHarness.plays))[1], {
        contentId: "episode:s1e12", fileId: "f-episode:s1e12", title: "Harbor Lights chapter 1.2", startSeconds: 420, episode: true, subtitle: { kind: "auto" },
    });
    await tv.page.evaluate(() => window.browseHarness.resume());
    await showing(tv, "item:episode:s1e12");
    await tv.remote(BACK);
    await showing(tv, "search");
    assert.equal(await tv.focused(), "episode:s1e12");
    assert.equal(await tv.page.inputValue("#browse-search"), "chapter 1.2");
    assert.equal(browseReads(tv, "/catalog/search/capabilities").length, 1);
}, { catalog: new FakeDetails() });

browseTest("episode-aware Search keeps movies, series and episode metadata without fetching on focus", async tv => {
    await tv.page.locator('[data-focus="search"]').click();
    for (const [query, ids] of [["Movie 0001", ["movie:m0001"]], ["Harbor Lights", ["series:s1", "episode:s1e11", "episode:s1e12", "episode:s1e13", "episode:s1e21", "episode:s1e22", "episode:s1e23"]]] as const) {
        await tv.page.fill("#browse-search", query);
        await press(tv, "Enter");
        await tv.eventually(async () => (await cardIds(tv)).join() === ids.join(), "the scoped results");
    }
    assert.equal(await tv.page.locator('[data-focus="episode:s1e12"] .browse-card-title').innerText(), "Harbor Lights");
    assert.equal(await tv.page.locator('[data-focus="episode:s1e12"] .browse-card-subtitle').innerText(), "S01E02 · Harbor Lights chapter 1.2");
    const requests = browseReads(tv, "/catalog");
    assert.equal(requests.length, 2);
    for (const request of requests) {
        assert.equal(new URL(request.path, "https://fake.invalid").searchParams.get("type"), "video_with_episodes");
        assert.equal(request.headers["x-profile-id"], "p-owner");
        assert.ok(request.headers.authorization?.startsWith("Bearer "));
    }
    assert.equal(browseReads(tv, "/catalog/search/capabilities").length, 1, "resolved route capability survives new queries");
});

for (const [name, capability] of [
    ["older response", { video_with_episodes_scope: undefined }],
    ["false flag", { video_with_episodes_scope: false }],
    ["disallowed", { allowed: false }],
    ["unsupported", { state: "unsupported" }],
    ["disabled", { state: "disabled" }],
    ["not configured", { state: "not_configured" }],
    ["unknown additive state", { state: "future" }],
] as const) {
    browseTest(`episode-aware Search uses video-only fallback after confirmed ${name}`, async (tv, catalog) => {
        catalog.searchCapabilities = { ...catalog.searchCapabilities, ...capability };
        await tv.page.locator('[data-focus="search"]').click();
        await tv.page.fill("#browse-search", "chapter 1.2");
        await tv.remote(IME_DONE);
        await shows(tv, "No results");
        assert.deepEqual(await cardIds(tv), []);
        assert.equal(new URL(browseReads(tv, "/catalog")[0]?.path ?? "", "https://fake.invalid").searchParams.get("type"), "video");
        await tv.page.fill("#browse-search", "Night Shift");
        await tv.remote(IME_DONE);
        await tv.eventually(async () => (await cardIds(tv)).join() === "series:s2", "video-only series");
        assert.equal(browseReads(tv, "/catalog/search/capabilities").length, 1);
    });
}

for (const failure of ["malformed flag", "malformed document", "server failure", "network failure"] as const) {
    browseTest(`episode-aware Search exposes recoverable capability ${failure} without silently narrowing`, async (tv, catalog) => {
        if (failure === "malformed flag") catalog.failNext("/catalog/search/capabilities", { status: 200, body: { ...catalog.searchCapabilities, video_with_episodes_scope: "true" } });
        if (failure === "malformed document") catalog.failNext("/catalog/search/capabilities", { status: 200, body: {} });
        if (failure === "server failure") catalog.failNext("/catalog/search/capabilities", ...Array.from({ length: 2 }, () => problem(503, "service_unavailable", "Unavailable")));
        await tv.page.locator('[data-focus="search"]').click();
        if (failure === "network failure") tv.offline = true;
        await tv.page.fill("#browse-search", "chapter 1.2");
        await tv.remote(IME_DONE);
        if (failure.endsWith("failure")) await tv.jump(1000);
        await tv.page.getByRole("button", { name: "Try Again", exact: true }).waitFor();
        assert.equal(browseReads(tv, "/catalog").length, 0, "failure cannot fabricate unsupported scope or an empty result");
        assert.equal(await tv.page.getByText("No results", { exact: true }).count(), 0);
        tv.offline = false;
        await press(tv, "ArrowDown", "ArrowDown", "Enter");
        await tv.eventually(async () => (await cardIds(tv)).includes("episode:s1e12"), "episode results after Retry");
        assert.equal(await tv.focused(), "query");
    });
}

browseTest("episode-aware Search drops a late old-query capability before debounce and retains the new scope", async (tv, catalog) => {
    await tv.page.locator('[data-focus="search"]').click();
    const held = tv.fake.hold("/catalog/search/capabilities", true);
    const supported = catalog.searchCapabilities;
    catalog.searchCapabilities = { ...supported, video_with_episodes_scope: false };
    await tv.page.fill("#browse-search", "Movie 0001");
    await tv.remote(IME_DONE);
    await tv.eventually(async () => browseReads(tv, "/catalog/search/capabilities").length === 1, "old capability request");
    await tv.page.fill("#browse-search", "chapter 1.2");
    held.release();
    await tv.jump(0);
    assert.deepEqual(await cardIds(tv), []);
    assert.equal(browseReads(tv, "/catalog").length, 0, "aborted negotiation cannot send the old query");
    catalog.searchCapabilities = supported;
    await tv.jump(600);
    await tv.eventually(async () => (await cardIds(tv)).includes("episode:s1e12"), "the new supported query");
    assert.equal(browseReads(tv, "/catalog/search/capabilities").length, 2);
    assert.equal(browseReads(tv, "/catalog").length, 1);
});

browseTest("episode-aware Search ignores a late episode result for an older query", async tv => {
    await tv.page.locator('[data-focus="search"]').click();
    const held = tv.fake.hold("/catalog", true);
    await tv.page.fill("#browse-search", "chapter 1.2");
    await tv.remote(IME_DONE);
    await tv.eventually(async () => browseReads(tv, "/catalog").length === 1, "held episode query");
    await tv.page.fill("#browse-search", "Movie 0001");
    await tv.remote(IME_DONE);
    await tv.eventually(async () => (await cardIds(tv)).join() === "movie:m0001", "new movie query");
    held.release();
    await tv.jump(0);
    assert.deepEqual(await cardIds(tv), ["movie:m0001"]);
    assert.equal(browseReads(tv, "/catalog/search/capabilities").length, 1);
});

for (const path of ["/catalog/search/capabilities", "/catalog"] as const) {
    browseTest(`episode-aware Search drops late profile answers from ${path}`, async tv => {
        await tv.page.locator('[data-focus="search"]').click();
        const held = tv.fake.hold(path, true);
        await tv.page.fill("#browse-search", "chapter 1.2");
        await tv.remote(IME_DONE);
        await tv.eventually(async () => browseReads(tv, path).length === 1, "held profile read");
        await tv.page.evaluate(() => window.browseHarness.clearProfile());
        assert.equal(await tv.page.evaluate(() => window.browseHarness.selectProfile("p-kid", "2468")), "verified");
        await tv.page.evaluate(() => window.browseHarness.mount());
        await showing(tv, "home");
        await tv.page.locator('[data-focus="search"]').click();
        await tv.page.fill("#browse-search", "chapter 1.2");
        await tv.remote(IME_DONE);
        await shows(tv, "No results");
        const reads = browseReads(tv, "/catalog").length;
        held.release();
        await tv.jump(0);
        assert.deepEqual(await cardIds(tv), []);
        assert.equal(browseReads(tv, "/catalog").length, reads, "old capability cannot start a query under the new profile");
        assert.equal(browseReads(tv, "/catalog").slice(-1)[0]?.headers["x-profile-id"], "p-kid");
    });
}

browseTest("episode-aware Search preserves opaque paging scope, invalid-cursor Retry and cached page focus", async (tv, catalog) => {
    for (let i = 1; i <= 50; i++) catalog.add({ id: `episode:signal${i}`, title: `Signal ${String(i).padStart(2, "0")}`, type: "episode", libraryId: "13", seriesId: "series:s1", season: 3, episode: i });
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", "Signal");
    await tv.remote(IME_DONE);
    await tv.eventually(async () => (await cardIds(tv)).length === 24, "first episode page");
    catalog.searchCapabilities = { ...catalog.searchCapabilities, allowed: false };
    await tv.page.getByRole("button", { name: "Next page", exact: true }).click();
    await tv.eventually(async () => (await cardIds(tv))[0] === "episode:signal25", "second episode page");
    const second = new URL(browseReads(tv, "/catalog").slice(-1)[0]?.path ?? "", "https://fake.invalid");
    assert.equal(second.searchParams.get("cursor"), "search+/= ?字:signal:video_with_episodes:24");
    assert.equal(second.searchParams.get("type"), "video_with_episodes");
    await tv.page.locator('[data-focus="episode:signal25"]').focus();
    await tv.page.locator('[data-focus="episode:signal25"]').click({ button: "right" });
    await tv.page.locator('[data-focus="episode-information"]').click();
    await showing(tv, "item:episode:signal25");
    await tv.remote(BACK);
    await showing(tv, "search");
    assert.equal(await tv.focused(), "episode:signal25");
    assert.equal((await cardIds(tv))[0], "episode:signal25");
    catalog.failNext("/catalog", problem(400, "invalid_cursor", "Invalid cursor"));
    await tv.page.getByRole("button", { name: "Next page", exact: true }).click();
    await tv.page.getByRole("button", { name: "Try Again", exact: true }).click();
    await tv.eventually(async () => (await cardIds(tv))[0] === "episode:signal1", "restarted episode cursor sequence");
    const retry = new URL(browseReads(tv, "/catalog").slice(-1)[0]?.path ?? "", "https://fake.invalid");
    assert.equal(retry.searchParams.get("cursor"), null);
    assert.equal(retry.searchParams.get("type"), "video_with_episodes");
    assert.equal(browseReads(tv, "/catalog/search/capabilities").length, 1, "pages and Details return keep resolved route facts");
    await tv.page.fill("#browse-search", "Movie 0001");
    await tv.remote(IME_DONE);
    await tv.eventually(async () => (await cardIds(tv)).join() === "movie:m0001", "new query starts without an incompatible cursor");
    assert.equal(new URL(browseReads(tv, "/catalog").slice(-1)[0]?.path ?? "", "https://fake.invalid").searchParams.get("cursor"), null);
    await tv.remote(BACK); await showing(tv, "home");
    await tv.page.locator('[data-focus="search"]').click();
    assert.equal(await tv.focused(), "query", "a new Search starts at its field");
    assert.equal(await tv.page.inputValue("#browse-search"), "");
    assert.equal((await cardIds(tv)).length, 0);
});

browseTest("typing invalidates an in-flight search before the debounce expires", async (tv) => {
    await press(tv, "ArrowUp", "ArrowLeft", "Enter");
    await showing(tv, "search");
    const first = tv.fake.hold("/catalog", true);
    await tv.page.fill("#browse-search", "Movie 0001");
    await tv.remote(IME_DONE);
    await tv.eventually(async () => browseReads(tv, "/catalog").length === 1, "the first search");
    await tv.page.fill("#browse-search", "night");
    first.release();
    await tv.jump(0);
    assert.deepEqual(await cardIds(tv), [], "an obsolete answer must not render before debounce");
    assert.equal(await tv.page.inputValue("#browse-search"), "night");
    assert.equal(browseReads(tv, "/catalog").length, 1, "replacement request is still debounced");
    await tv.jump(600);
    await shows(tv, "Night Shift");
    assert.deepEqual(await cardIds(tv), ["series:s2"]);
    assert.equal(await tv.focused(), "query");
}, { catalog: videoOnlyCatalog() });

browseTest("search uses the TV keyboard, shows only the latest query's answer, and recovers from failures", async (tv, catalog) => {
    await press(tv, "ArrowUp", "ArrowLeft", "Enter");
    await showing(tv, "search");
    assert.equal(await tv.focused(), "query");

    const first = tv.fake.hold("/catalog", true);
    await tv.page.keyboard.type("Movie 0001");
    await tv.jump(600);
    await tv.eventually(async () => browseReads(tv, "/catalog").length === 1, "the first search");
    await tv.page.getByRole("status", { name: "Searching", exact: true }).waitFor();
    await tv.page.fill("#browse-search", "night");
    await tv.remote(IME_DONE);
    await tv.eventually(async () => browseReads(tv, "/catalog").length === 2, "the second search");
    await shows(tv, "Night Shift");
    first.release();
    await tv.jump(0);
    assert.deepEqual(await cardIds(tv), ["series:s2"], "the late answer for the older query is dropped");
    assert.match(browseReads(tv, "/catalog")[1]?.path ?? "", /q=night&type=video&limit=24/);
    assert.equal(await tv.focused(), "query", "focus stays in the field while results arrive");
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "search-filter:all");
    await press(tv, "ArrowDown");
    assert.equal(await tv.focused(), "series:s2");

    await press(tv, "ArrowUp");
    await tv.page.fill("#browse-search", "zzz");
    await tv.remote(IME_DONE);
    await shows(tv, "No results");

    catalog.failNext("/catalog", problem(503, "service_unavailable", "Unavailable"), problem(503, "service_unavailable", "Unavailable"));
    await tv.page.fill("#browse-search", "movie 000");
    await tv.remote(IME_DONE);
    await tv.jump(1000);
    await shows(tv, "The server had a problem. Try again in a moment.");
    await press(tv, "ArrowDown", "ArrowDown");
    assert.equal(await tv.focused(), "retry");
    await press(tv, "Enter");
    await tv.eventually(async () => (await cardIds(tv)).length === 9, "results after retry");
    assert.equal(await tv.focused(), "query", "the focused retry button is gone: focus returns to the field");
}, { catalog: videoOnlyCatalog() });

browseTest("Back from a result reloads a query edited before its debounce could run", async (tv) => {
    await press(tv, "ArrowUp", "ArrowLeft", "Enter");
    await showing(tv, "search");
    await tv.page.fill("#browse-search", "Movie 0001");
    await tv.remote(IME_DONE);
    await tv.eventually(async () => (await cardIds(tv)).join() === "movie:m0001", "the original search result");
    await tv.page.fill("#browse-search", "night");
    await press(tv, "ArrowDown", "ArrowDown", "Enter");
    await showing(tv, "item:movie:m0001");
    const held = tv.fake.hold("/catalog", true);
    await tv.remote(BACK);
    await showing(tv, "search");
    assert.equal(await tv.page.inputValue("#browse-search"), "night");
    assert.deepEqual(await cardIds(tv), [], "the old query's cards cannot be restored under the edited query");
    await tv.eventually(async () => browseReads(tv, "/catalog").length === 2, "the edited query request");
    held.release();
    await shows(tv, "Night Shift");
    assert.deepEqual(await cardIds(tv), ["series:s2"]);
}, { catalog: videoOnlyCatalog() });

browseTest("loading, slow, offline, removed, empty and missing-artwork states all leave a way forward", async (tv, catalog) => {
    await tv.eventually(async () => (await tv.page.locator(".browse-art-missing").count()) >= 2, "placeholders");
    const missing = await tv.page.evaluate(() => Array.from(document.querySelectorAll(".browse-art-missing")).map((node) => node.parentElement?.getAttribute("data-focus")));
    assert.ok(missing.indexOf("movie:m0002") !== -1 && missing.indexOf("movie:m0003") !== -1, "no artwork and failed artwork both show the title");

    const hold = tv.fake.hold("/catalog/items/movie%3Am0001");
    await activateDetails(tv);
    await showing(tv, "item:loading");
    assert.equal(await tv.focused(), "back");
    await tv.jump(5000);
    await shows(tv, "Still waiting for the server.");
    await press(tv, "Enter");
    await showing(tv, "home");
    hold.release();
    await tv.jump(0);
    assert.equal(await view(tv), "home", "the abandoned answer does not open the page");
    assert.equal(await tv.focused(), "movie:m0001");

    tv.offline = true;
    await activateDetails(tv);
    await tv.jump(1000);
    await shows(tv, "Could not reach the server. Check the connection and try again.");
    assert.equal(await tv.focused(), "retry");
    tv.offline = false;
    await activateDetails(tv);
    await showing(tv, "item:movie:m0001");
    await tv.remote(BACK);

    catalog.removed.add("movie:m0001");
    await activateDetails(tv);
    await shows(tv, "This title is no longer available.");
    await press(tv, "ArrowRight", "Enter");
    await showing(tv, "home");

    const owner = catalog.households.get("p-owner");
    owner?.libraries.push({ id: "17", name: "New Shelf", type: "movies", sort_order: 9 });
    await tv.page.evaluate(() => {
        window.browseHarness.destroy();
        window.browseHarness.mount();
    });
    await showing(tv, "home");
    await press(tv, "ArrowUp", "ArrowRight");
    await tv.jump(250);
    await press(tv, "ArrowDown", "ArrowDown", "Enter");
    await showing(tv, "library:17");
    await shows(tv, "No titles");
    assert.equal(await tv.focused(), "movies", "empty scope retains its top-bar destination");
});

browseTest("an authority change removes only browse, aborts its reads, and the next profile sees only its own catalog", async (tv) => {
    const held = tv.fake.hold("/library/12/sections", true);
    await press(tv, "ArrowUp", "ArrowRight", "Enter");
    await showing(tv, "library:loading");
    await tv.page.evaluate(() => window.browseHarness.clearProfile());
    held.release();
    await tv.jump(0);
    assert.equal(await tv.page.locator(".browse").count(), 0, "browse removed itself");
    assert.equal(await tv.page.locator("#successor").count(), 1, "the profile screen it left in the root is untouched");
    assert.equal(await tv.page.locator("img").count(), 0, "no artwork of the old profile remains");

    assert.equal(await tv.page.evaluate(() => window.browseHarness.selectProfile("p-kid", "2468")), "verified");
    await tv.page.evaluate(() => window.browseHarness.mount());
    await showing(tv, "home");
    assert.deepEqual(await cardIds(tv, ".browse-nav .browse-button"), ["search", "home", "movies", "for_you", "calendar", "profiles"]);
    const kidReads = browseReads(tv).filter((read) => read.headers["x-profile-id"] === "p-kid");
    assert.ok(kidReads.length >= 3 && kidReads.every((read) => read.headers["x-profile-token"]?.startsWith("pvt-")));

    await press(tv, "ArrowUp", "ArrowLeft", "Enter");
    await tv.page.fill("#browse-search", "movie");
    await tv.remote(IME_DONE);
    await shows(tv, "No results");
    await tv.remote(BACK);
    await showing(tv, "home");

    assert.equal(await tv.focused(), "home", "Search Back restores its originating root tab");
    await press(tv, "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "Enter");
    assert.equal(await tv.focused(), "switch-profile");
    await press(tv, "Enter");
    assert.deepEqual(await tv.page.evaluate(() => window.browseHarness.chooseProfileCalls), [false], "browse was gone before onChooseProfile ran");
    assert.equal(await tv.page.locator(".browse").count(), 0);
}, { profile: "p-owner" });
