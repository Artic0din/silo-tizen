import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { mkdir } from "node:fs/promises";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { problem, type Reply } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";
import { personalQuery, readPersonalPage } from "../../src/ui/personalLists.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { CARD_PRESENTATION_KEY } from "../../src/contracts/v2/settings.ts";

class PersonalCatalog extends FakeDetails {
    readonly excluded = new Set<string>();
    private readonly membershipState = new Map<string, Set<string>>();
    unavailable = false;
    capabilityReplies: Reply[] = [];
    pageReplies: Reply[] = [];
    override route(method: string, path: string, profile: string | undefined, body?: Record<string, unknown>): Reply | undefined {
        if (path.startsWith("/capabilities/personal-lists")) return this.capabilityReplies.shift() ?? { status: 200, body: { revision: "1", state: this.unavailable ? "unsupported" : "available", allowed: !this.unavailable, membership_supported: true } };
        const list = /^\/(watchlist|favorites)\?/.exec(path);
        if (method === "GET" && list?.[1] !== undefined) {
            const params = new URLSearchParams(path.split("?")[1]);
            assert.equal(params.get("limit"), "24");
            return this.route("POST", "/catalog/query", profile, { source: list[1], type: "video", limit: 24, ...(params.has("cursor") ? { cursor: params.get("cursor") } : {}) });
        }
        const personal = /^\/(watchlist|favorites)\/([^/?]+)(?:\/membership)?(?:\?.*)?$/.exec(path);
        if (personal?.[1] !== undefined && personal[2] !== undefined) {
            const members = this.members(profile, personal[1]);
            const id = decodeURIComponent(personal[2]);
            if (method === "GET") return { status: 200, body: { item_id: id, is_member: members.has(id) } };
            const reply = super.route(method, path, profile, body);
            if (reply?.status === 204) {
                if (method === "DELETE") members.delete(id);
                else members.add(id);
            }
            return reply;
        }
        if (path.startsWith("/catalog/query") && typeof body?.source === "string" && ["watchlist", "favorites", "history"].includes(body.source)) {
            assert.equal(method, "POST");
            const limit = body.source === "history" ? 60 : 24;
            assert.equal(body.limit, limit);
            const failure = this.pageReplies.shift();
            if (failure !== undefined) return failure;
            const scope = `${profile}:${body.source}:${body.type}`;
            // Unset scope queries media_items; episode history aggregates into series there.
            const scoped = [...this.titles.values()].filter(t => (profile === "p-kid" ? t.libraryId === "16" : ["12", "13"].includes(t.libraryId)) && (body.type === undefined || body.type === "video" ? ["movie", "series"].includes(t.type) : t.type === body.type));
            const members = body.source === "history" ? undefined : this.members(profile, body.source);
            const included = (id: string): boolean => !this.excluded.has(id) && (members?.has(id) ?? true);
            const ids = scoped.filter(t => included(t.id));
            const cursor = body.cursor;
            if (cursor !== undefined && (typeof cursor !== "string" || !cursor.startsWith(scope + ":"))) return problem(400, "invalid_cursor", "Invalid cursor");
            const offset = typeof cursor === "string" ? Number(cursor.slice(scope.length + 1)) : 0;
            // The immutable fixture order stands in for the server's fenced keyset.
            // A removed row before the anchor cannot shift a later page backwards.
            const remaining = scoped.slice(offset).filter(t => included(t.id));
            const selected = remaining.slice(0, limit);
            const last = selected[selected.length - 1];
            const next = last === undefined ? offset : scoped.indexOf(last) + 1;
            const cards = selected.map(t => {
                const reply = super.route("GET", `/catalog/items/${encodeURIComponent(t.id)}`, profile);
                return reply?.body;
            });
            return { status: 200, body: { window_cursor: scope, items: cards, total: ids.length, total_exact: true, page: remaining.length > limit ? { has_more: true, next_cursor: `${scope}:${next}` } : { has_more: false } } };
        }
        return super.route(method, path, profile, body);
    }
    private members(profile: string | undefined, source: string): Set<string> {
        const key = JSON.stringify([profile, source]);
        let members = this.membershipState.get(key);
        if (members === undefined) {
            members = new Set(this.titles.keys());
            this.membershipState.set(key, members);
        }
        return members;
    }
}
function listReads(tv: Tv) {
    return tv.fake.requests.map(request => {
        const url = new URL(request.path, "https://fixture.invalid");
        const source = url.pathname.slice(1);
        if (request.method !== "GET" || !["watchlist", "favorites"].includes(source)) return request;
        return { ...request, body: { source, cursor: url.searchParams.get("cursor") ?? undefined } };
    }).filter(request => request.path.startsWith("/catalog/query") || /^\/(watchlist|favorites)\?/.test(request.path));
}
function holdList(tv: Tv, source = "watchlist") { return tv.fake.hold(source === "history" ? "/catalog/query" : `/${source}`, true); }
let browser: Browser;
test("native comparison: saved-list requests use Apple's endpoint and preserve tied order", () => {
    const catalog = new PersonalCatalog();
    const reply = catalog.route("POST", "/catalog/query", "p-owner", { source: "watchlist", type: "video", limit: 24 });
    const items = (reply?.body as { items: Record<string, unknown>[] }).items;
    const reordered = [items[3], items[2], items[5], items[4]];
    for (const source of ["watchlist", "favorites"] as const) {
        const request = readPersonalPage(source, "movie", "opaque");
        assert.equal(request.method, "GET");
        const url = new URL(request.path, "https://fixture.invalid");
        assert.equal(url.pathname, `/${source}`);
        assert.equal(url.searchParams.get("cursor"), "opaque");
        assert.equal(url.searchParams.has("sort"), false);
        const result = request.decode({ items: reordered, page: { has_more: false } });
        assert.deepEqual(result.items.map(item => item.id), ["movie:m0004", "movie:m0003", "movie:m0006", "movie:m0005"]);
        assert.ok(result.items.every(item => item.showStatus === undefined));
        const supplied = request.decode({ items: [{ ...items[0], show_status: "Ended" }], page: { has_more: false } });
        assert.equal(supplied.items[0]?.showStatus, "Ended");
    }
});
for (const source of ["watchlist", "favorites"]) test(`native comparison: ${source} retains the opening root and uses two Back presses`, async () => {
    const { tv } = await setup();
    try {
        for (const root of ["home", "calendar"]) {
            await tv.page.locator(`[data-focus="${root}"]`).click();
            await tv.page.locator(`[data-view="${root}"]`).waitFor();
            await openList(tv, source);
            assert.equal(await tv.page.locator(`[data-focus="${root}"]`).getAttribute("aria-current"), "page");
            const geometry = await tv.page.locator(".personal-page").evaluate(node => {
                const title = node.querySelector("h1");
                const cards = node.querySelectorAll(".browse-card");
                return { titleHeight: title?.getBoundingClientRect().height, pitch: (cards[8]?.getBoundingClientRect().top ?? 0) - (cards[0]?.getBoundingClientRect().top ?? 0) };
            });
            assert.equal(geometry.titleHeight, 77);
            assert.equal(geometry.pitch, 403);
            await tv.remote(10009);
            assert.equal(await tv.focused(), root);
            assert.equal(await tv.page.locator(`[data-view="personal:${source}"]`).count(), 1);
            await tv.remote(10009);
            await tv.page.locator(`[data-view="${root}"]`).waitFor();
            assert.equal(await tv.page.locator('.skyline-selector:not([hidden])').count(), 0);
        }
    } finally { await tv.page.context().close(); }
});
test("native comparison: History uses the safe-area grid and preserves tied server order", async () => {
    const { tv, catalog } = await setup();
    try {
        const reply = catalog.route("POST", "/catalog/query", "p-owner", { source: "history", limit: 60 });
        const body = reply?.body as Record<string, unknown>;
        const items = body.items as Record<string, unknown>[];
        const reordered = [items[3], items[2], items[5], items[4], ...items.slice(6)];
        catalog.pageReplies.push({ status: 200, body: { ...body, items: reordered } });
        await openList(tv, "history");
        const frame = await tv.page.locator(".personal-page").evaluate(node => {
            const cards = node.querySelectorAll(".browse-card");
            return { countX: node.querySelector(".personal-count")?.getBoundingClientRect().x, pitch: (cards[1]?.getBoundingClientRect().x ?? 0) - (cards[0]?.getBoundingClientRect().x ?? 0), ids: [...cards].slice(0, 4).map(n => n.getAttribute("data-focus")) };
        });
        assert.equal(frame.countX, 128);
        assert.equal(frame.pitch, 284);
        assert.deepEqual(frame.ids, ["movie:m0004", "movie:m0003", "movie:m0006", "movie:m0005"]);
    } finally { await tv.page.context().close(); }
});
test("native comparison: History title matches the captured system title", async () => {
    const { tv } = await setup();
    try {
        await openList(tv, "history");
        assert.equal((await tv.page.locator(".personal-history > .browse-title").boundingBox())?.y, 65.5);
    } finally { await tv.page.context().close(); }
});
test("native comparison: History scrolls first, middle and last rows to the native focus anchor", async () => {
    const { tv, catalog } = await setup(false, "compact");
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        const reply = catalog.route("POST", "/catalog/query", "p-owner", { source: "history", limit: 60 });
        const body = reply?.body as { items: Record<string, unknown>[] };
        // Four compact rows end before the fourth poster can reach y554. Six rows leave that scroll room.
        catalog.pageReplies.push({ status: 200, body: { ...body, items: body.items.slice(0, 36), page: { has_more: false } } });
        await openList(tv, "history");
        // The signed compact poster is 224 wide. Its caption is the 22px history gap, 29px title, 4px title margin and 24px subtitle.
        const signedCaption = 22 + 29 + 4 + 24;
        await tv.eventually(async () => Math.abs(await tv.page.locator(".personal-history .browse-art").first().evaluate(node => node.getBoundingClientRect().width) - 224) < 1, "signed 224-wide poster");
        const row = await tv.page.locator(".personal-history").evaluate(node => {
            const cards = [...node.querySelectorAll(".browse-card")];
            const art = cards[0]?.querySelector(".browse-art")?.getBoundingClientRect();
            const first = cards[0]?.getBoundingClientRect().top ?? 0;
            const next = cards[6]?.getBoundingClientRect().top ?? 0;
            return { artWidth: art?.width ?? 0, artHeight: art?.height ?? 0, first, pitch: next - first };
        });
        assert.ok(Math.abs(row.artWidth - 224) < 1, "signed poster is 224 wide");
        assert.ok(Math.abs(row.pitch - (row.artHeight + signedCaption + 60)) < 1, "row height is the 224-wide poster plus its caption, not the taller 529px fake row");
        const geometry = () => tv.page.locator(".personal-history").evaluate(node => {
            const card = node.querySelector(".browse-card:focus");
            const art = card?.querySelector(".browse-art");
            return { card: card?.getBoundingClientRect().top, art: art?.getBoundingClientRect().top, scroll: node.querySelector(".skyline-content")?.scrollTop };
        });
        const applePosterTop = 554;
        assert.deepEqual(await geometry(), { card: 236, art: 236, scroll: 0 });
        for (const index of [1, 2, 3]) {
            await tv.remote(40);
            const got = await geometry();
            const scroll = row.first + index * row.pitch - applePosterTop;
            assert.ok(Math.abs((got.art ?? 0) - applePosterTop) < 1, `row ${index + 1} poster top is Apple's y554, replacing the old y564 anchor`);
            assert.ok(Math.abs((got.card ?? 0) - applePosterTop) < 1, `row ${index + 1} card top matches its poster`);
            assert.ok(Math.abs((got.scroll ?? 0) - scroll) < 1, `row ${index + 1} scroll uses the 224-wide row, replacing the old taller-row scroll`);
        }
        await tv.page.emulateMedia({ reducedMotion: "no-preference" });
        const lift = row.artHeight * 0.025;
        const contentTop = await tv.page.locator(".personal-history .skyline-content").evaluate(node => node.getBoundingClientRect().top);
        // The focus lift changes the painted frame, never the scroll anchor.
        await tv.eventually(async () => Math.abs(((await geometry()).art ?? 0) - (applePosterTop - lift)) < .2, "focused poster lift of the 224-wide poster; the old 554.25 was the 390px poster parked at y564");
        await tv.remote(38);
        await tv.eventually(async () => Math.abs(((await geometry()).art ?? 0) - (contentTop + 12 - lift)) < 1, "previous row top edge; the old 148.25 was the 390px lift");
        await tv.remote(38);
        await tv.eventually(async () => Math.abs(((await geometry()).art ?? 0) - (contentTop + 12 - lift)) < 1, "second row top edge; the old 148.25 was the 390px lift");
        await tv.remote(38);
        await tv.eventually(async () => (await geometry()).scroll === 0, "first row returns to the top");
    } finally { await tv.page.context().close(); }
});
for (const source of ["watchlist", "favorites"]) for (const gap of [500, 4000]) test(`Down from the retained For You tab opens the menu on Watchlist over ${source} after ${gap}ms`, async () => {
    const { tv } = await setup();
    try {
        await tv.page.locator('[data-focus="for_you"]').click();
        await tv.page.locator('[data-view="for_you"]').waitFor();
        await tv.page.locator('[data-focus="for_you"]').focus();
        await tv.remote(40);
        await tv.page.locator(`[data-focus="${source}"]`).click();
        const card = tv.page.locator(`[data-view="personal:${source}"] .browse-card`).first();
        await card.waitFor();
        await tv.remote(10009);
        assert.equal(await tv.focused(), "for_you");
        assert.equal(await tv.page.locator(`[data-view="personal:${source}"]`).count(), 1);
        await tv.jump(gap);
        await tv.remote(40);
        assert.equal(await tv.page.locator('.skyline-selector:not([hidden])[data-menu-kind="for_you"]').count(), 1, "Down opens the For You menu over the visible list");
        assert.equal(await tv.focused(), "watchlist", "Apple always enters the menu on Watchlist, including over Favorites");
        assert.equal(await tv.page.locator(`[data-view="personal:${source}"]`).count(), 1);
        await tv.remote(10009);
        assert.equal(await tv.focused(), "for_you");
        await tv.remote(10009);
        await tv.page.locator('[data-view="for_you"]').waitFor();
        assert.equal(await tv.page.locator(".skyline-selector:not([hidden])").count(), 0);
    } finally { await tv.page.context().close(); }
});
test("pinned History scope distinguishes aggregated media from episode queries", () => {
    const catalog = new PersonalCatalog();
    const query = (type?: string): Record<string, unknown>[] => {
        const reply = catalog.route("POST", "/catalog/query", "p-owner", { source: "history", limit: 60, ...(type === undefined ? {} : { type }) });
        return (reply?.body as { items: Record<string, unknown>[] }).items;
    };
    assert.ok(query().every(item => item.type !== "episode"));
    assert.ok(query("episode").some(item => item.type === "episode"));
});
test("History matches Apple's unfiltered 60-item query and continuation", () => {
    assert.deepEqual(personalQuery("history", "movie"), { source: "history", limit: 60 });
    assert.deepEqual(personalQuery("history", "movie", "opaque"), { source: "history", limit: 60, cursor: "opaque" });
});

test("History is pushed without shell chrome and Back restores the profile anchor", async () => {
    const { tv } = await setup();
    try {
        await openList(tv, "history");
        assert.equal(await tv.page.locator(".browse-nav").count(), 0);
        assert.equal(await tv.page.locator(".personal-filters, [data-focus=back]").count(), 0);
        assert.equal(await tv.focused(), "movie:m0001");
        const title = tv.page.getByRole("heading", { name: "History", exact: true });
        const box = await title.boundingBox();
        assert.ok(box);
        assert.equal(box.x + box.width / 2, 960);
        await tv.page.keyboard.press("ArrowUp");
        assert.equal(await tv.focused(), "movie:m0001");
        await tv.remote(10009);
        await tv.page.locator('[data-view="home"]').waitFor();
        assert.equal(await tv.focused(), "home");
    } finally { await tv.page.context().close(); }
});

test("History count uses exact totals and ignores server estimates", async () => {
    const { tv, catalog } = await setup();
    try {
        const reply = catalog.route("POST", "/catalog/query", "p-owner", { source: "history", limit: 60 });
        const body = reply?.body as Record<string, unknown>;
        const items = body.items as Record<string, unknown>[];
        for (const scenario of [
            { total: 784, exact: true, more: true, items, label: "784 items" },
            { total: 999, exact: false, more: true, items, label: "60+ items" },
            { total: 999, exact: false, more: false, items: items.slice(0, 1), label: "1 item" },
        ]) {
            catalog.pageReplies.push({ status: 200, body: { ...body, items: scenario.items, total: scenario.total, total_exact: scenario.exact, page: scenario.more ? { has_more: true, next_cursor: "p-owner:history:undefined:60" } : { has_more: false } } });
            await openList(tv, "history");
            assert.equal(await tv.page.locator(".personal-count").innerText(), scenario.label);
            await tv.remote(10009);
            await tv.page.locator('[data-view="home"]').waitFor();
        }
    } finally { await tv.page.context().close(); }
});
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });
async function setup(record = false, poster: boolean | "compact" = false, configure?: (tv: Tv) => void): Promise<{ tv: Tv; catalog: PersonalCatalog }> {
    const tv = await openTv(browser, { app: "browse", ...(!record || process.env.PERSONAL_VIDEO === undefined ? {} : { video: process.env.PERSONAL_VIDEO }) });
    const catalog = new PersonalCatalog();
    tv.fake.catalog = catalog;
    const size = poster === true ? "large" : poster === "compact" ? "compact" : undefined;
    if (size !== undefined) new FakeSettings(tv.fake).profile().set(CARD_PRESENTATION_KEY, { poster_size: size, caption: "title_metadata" });
    configure?.(tv);
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.page.locator('[data-view="home"]').waitFor();
    return { tv, catalog };
}
async function openList(tv: Tv, source: string): Promise<void> {
    if (source === "history") await tv.page.locator('[data-focus="profiles"]').click();
    else { await tv.page.locator('[data-focus="for_you"]').focus(); await tv.remote(40); }
    await tv.page.locator(`[data-focus="${source}"]`).click({ timeout: 2000 });
    await tv.page.locator(`[data-view="personal:${source}"] .browse-card`).first().waitFor();
}
/** Scroll the last card into the grid's viewport so CatalogGrid's lead asks for the next page. */
async function revealEnd(tv: Tv): Promise<void> {
    await tv.page.locator('[data-view^="personal:"] .browse-card').last().evaluate(node => {
        const viewport = node.closest<HTMLElement>(".skyline-content");
        if (viewport === null) return;
        const card = node.getBoundingClientRect();
        const bounds = viewport.getBoundingClientRect();
        viewport.scrollTop += card.top - bounds.top;
    });
}
async function loadThrough(tv: Tv, minimum: number): Promise<void> {
    const cards = tv.page.locator('[data-view^="personal:"] .browse-card');
    // IntersectionObserver can prefetch before this helper starts; wait for the required rows.
    await tv.eventually(async () => {
        if (await cards.count() >= minimum) return true;
        await revealEnd(tv);
        return await cards.count() >= minimum;
    }, `${minimum} personal rows loaded`);
}

for (const source of ["watchlist", "favorites", "history"]) test(`review: ${source} matches blank tvOS loading and retains focus`, async () => {
    const { tv } = await setup();
    try {
        const held = holdList(tv, source);
        if (source === "history") await tv.page.locator('[data-focus="profiles"]').click();
        else { await tv.page.locator('[data-focus="for_you"]').focus(); await tv.remote(40); }
        await tv.page.locator(`[data-focus="${source}"]`).click();
        await tv.page.locator(".personal-loading").waitFor();
        const loading = tv.page.locator(".personal-loading");
        assert.equal(await loading.innerText(), "");
        assert.equal(await loading.getAttribute("aria-label"), source === "history" ? null : `Loading ${source}`);
        await loading.focus();
        assert.equal(await tv.focused(), "status");
        assert.equal(await loading.evaluate(node => getComputedStyle(node).outlineStyle), "none");
        held.release();
    } finally { await tv.page.context().close(); }
});

for (const source of ["watchlist", "favorites", "history"]) for (const fails of [false, true]) test(`review: ${source} preserves scrolled viewport after page ${fails ? "failure" : "append"}`, async () => {
    const { tv, catalog } = await setup();
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await openList(tv, source);
        const held = holdList(tv, source);
        if (fails) catalog.pageReplies.push(problem(500, "internal_error", "Synthetic failure"));
        const reads = listReads(tv).length;
        const card = tv.page.locator('.browse .browse-card').last();
        const id = await card.getAttribute("data-focus");
        await card.focus();
        await revealEnd(tv);
        await tv.eventually(async () => listReads(tv).length > reads, "held next page");
        const oldPage = await tv.page.locator(".personal-page").elementHandle();
        assert.ok(oldPage);
        const top = await tv.page.locator(".skyline-content").evaluate(node => node.scrollTop);
        assert.ok(top > 0);
        held.release();
        await tv.eventually(async () => await oldPage.evaluate(node => !node.isConnected), "page repaint completed");
        assert.equal(await tv.focused(), id);
        assert.equal(await tv.page.locator(".skyline-content").evaluate(node => node.scrollTop), top);
        const visible = await tv.page.locator(`.browse-card[data-focus="${id}"]`).evaluate(node => {
            const bounds = node.closest(".skyline-content")?.getBoundingClientRect();
            const rect = node.getBoundingClientRect();
            return bounds !== undefined && rect.top >= bounds.top && rect.bottom <= bounds.bottom;
        });
        assert.ok(visible, "selected card stays inside the viewport");
    } finally { await tv.page.context().close(); }
});

for (const source of ["watchlist", "favorites", "history"]) test(`review: ${source} keeps card focus after later-page failure`, async () => {
    const { tv, catalog } = await setup();
    try {
        await openList(tv, source);
        const held = holdList(tv, source);
        const before = listReads(tv).length;
        catalog.pageReplies.push(problem(500, "internal_error", "Synthetic failure"));
        await tv.eventually(async () => {
            await revealEnd(tv);
            return listReads(tv).length > before;
        }, "later read");
        await tv.page.locator('.browse [data-focus="movie:m0020"]').focus();
        held.release();
        await tv.page.locator(".section-catalog-loading").waitFor({ state: "detached" });
        assert.equal(await tv.focused(), "movie:m0020");
    } finally { await tv.page.context().close(); }
});

for (const source of ["watchlist", "history"]) test(`review: ${source} 404 is an error rather than empty`, async () => {
    const { tv, catalog } = await setup();
    try {
        catalog.pageReplies.push(problem(404, "not_found", "Synthetic missing catalog"));
        if (source === "history") await tv.page.locator('[data-focus="profiles"]').click();
        else { await tv.page.locator('[data-focus="for_you"]').focus(); await tv.remote(40); }
        await tv.page.locator(`[data-focus="${source}"]`).click();
        await tv.eventually(async () => await tv.page.locator(".personal-failure, .personal-empty").count() > 0, "settled catalog");
        assert.equal(await tv.page.locator(".personal-failure").count(), 1);
    } finally { await tv.page.context().close(); }
});

for (const poster of ["compact", false, true] as const) test(`review: History outer posters fit the viewport at ${poster === true ? "large" : poster === false ? "standard" : poster} size`, async () => {
    const { tv } = await setup(false, poster);
    try {
        await openList(tv, "history");
        const columns = poster === true ? 5 : 6;
        const cards = tv.page.locator(".personal-page .browse-card");
        for (const index of [0, columns - 1]) {
            await cards.nth(index).focus();
            await tv.eventually(async () => await cards.nth(index).evaluate(node => {
                const bounds = node.closest(".skyline-content")!.getBoundingClientRect();
                const art = node.querySelector(".browse-art")!.getBoundingClientRect();
                return art.left - 4 >= bounds.left && art.right + 4 <= bounds.right;
            }), "outer poster and focus outline fit the scroll viewport");
        }
    } finally { await tv.page.context().close(); }
});

for (const poster of [false, true] as const) test(`review: History keeps the complete focused card visible at ${poster ? "large" : "standard"} size`, async () => {
    const { tv } = await setup(false, poster);
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await openList(tv, "history");
        await tv.remote(40);
        await tv.remote(40);
        await tv.page.emulateMedia({ reducedMotion: "no-preference" });
        await tv.eventually(async () => await tv.page.locator(".browse-card:focus").evaluate(node => {
            const viewport = node.closest(".skyline-content")!.getBoundingClientRect();
            return [...node.querySelectorAll(".browse-art, .browse-card-title, .browse-card-subtitle")].every(child => {
                const rect = child.getBoundingClientRect();
                return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
            });
        }), "focused artwork and captions fit the viewport");
    } finally { await tv.page.context().close(); }
});

for (const source of ["watchlist", "favorites", "history"]) test(`review: ${source} repaints after delayed presentation preferences`, async () => {
    let release = (): void => {};
    const { tv, catalog } = await setup(false, false, tv => {
        const settings = new FakeSettings(tv.fake);
        settings.overlayConfig = { enabled: false };
        settings.profile().set(CARD_PRESENTATION_KEY, { poster_size: "large", caption: "title_metadata" });
        const badges = tv.fake.hold("/settings/overlay-config", true);
        const posters = tv.fake.hold("/settings/values/effective?keys=ui.card_presentation", true);
        release = () => { badges.release(); posters.release(); };
    });
    try {
        const read = catalog.route.bind(catalog);
        catalog.route = (method, path, profile, body) => {
            const reply = read(method, path, profile, body), response = reply?.body;
            if (reply?.status === 200 && typeof response === "object" && response !== null && "items" in response && Array.isArray(response.items)) {
                return { ...reply, body: { ...response, items: response.items.map((item: unknown) => typeof item === "object" && item !== null ? { ...item, overlay_summary: { resolution: "2160p" } } : item) } };
            }
            return reply;
        };
        await openList(tv, source);
        const identity = await tv.focused();
        const badges = tv.page.locator(".personal-page .card-overlay");
        assert.ok(await badges.count() > 0);
        const reads = listReads(tv).length;
        release();
        await tv.eventually(async () => await badges.count() === 0, "disabled personal-list badges removed");
        assert.equal(await tv.focused(), identity);
        assert.equal(listReads(tv).length, reads);
        if (source === "history") {
            await tv.eventually(async () => await tv.page.locator(".catalog-grid").evaluate(node => node.style.getPropertyValue("--grid-columns")) === "5", "large History columns");
            await tv.remote(40);
            assert.equal(await tv.focused(), await tv.page.locator(".personal-page .browse-card").nth(5).getAttribute("data-focus"));
        }
    } finally { release(); await tv.page.context().close(); }
});

test("review: large History posters fit five columns and remote rows", async () => {
    const { tv } = await setup(false, true);
    try {
        await openList(tv, "history");
        const cards = tv.page.locator(".browse .browse-card");
        await tv.eventually(async () => await cards.first().evaluate(n => n.getBoundingClientRect().width) === 312, "large cards");
        const boxes = await cards.evaluateAll(nodes => nodes.slice(0, 6).map(n => n.getBoundingClientRect().toJSON()));
        assert.ok(boxes[5].top > boxes[0].top);
        assert.ok(boxes[4].right <= 1872);
        await cards.first().focus();
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), await cards.nth(5).getAttribute("data-focus"));
    } finally { await tv.page.context().close(); }
});

test("review: a failed continuation in one-row Favorites has an explicit retry", async () => {
    const { tv, catalog } = await setup();
    try {
        const first = catalog.route("POST", "/catalog/query", "p-owner", { source: "favorites", type: "video", limit: 24 });
        const body = first?.body as { items: Record<string, unknown>[] };
        const items = body.items.slice(0, 8);
        catalog.pageReplies.push({ status: 200, body: { ...body, items, page: { has_more: true, next_cursor: "p-owner:favorites:video:24" } } }, problem(500, "internal_error", "Synthetic failure"));
        await openList(tv, "favorites");
        const retry = tv.page.getByRole("button", { name: "Try Again", exact: true });
        await retry.waitFor();
        const reads = listReads(tv).length;
        assert.equal(await tv.page.locator(".personal-page .browse-card").count(), 8);
        assert.equal(await tv.page.locator(".skyline-content").evaluate(node => node.scrollHeight <= node.clientHeight), true);
        await tv.jump(1000);
        assert.equal(listReads(tv).length, reads, "failure does not start an automatic retry loop");
        await tv.page.locator(".personal-page .browse-card").first().focus();
        await tv.remote(40);
        assert.equal(await tv.focused(), "retry");
        await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => await tv.page.locator(".personal-page .browse-card").count() > 8, "retry recovers the remaining favorites");
    } finally { await tv.page.context().close(); }
});

test("watchlist, favorites and history are continuous Apple pages", async () => {
    const { tv, catalog } = await setup();
    try {
        await openList(tv, "watchlist");
        assert.equal(await tv.page.locator('[data-focus="next"], [data-focus="previous"], .browse-page-status').count(), 0);
        const before = listReads(tv).length;
        await tv.page.locator(".browse .browse-card").first().focus();
        await tv.page.keyboard.press("ArrowRight");
        assert.equal(listReads(tv).length, before);
        const next = catalog.route("POST", "/catalog/query", "p-owner", { source: "watchlist", type: "video", limit: 24, cursor: "p-owner:watchlist:video:24" });
        assert.ok(next);
        // Queue both outcomes before scrolling can prefetch beyond the next page.
        catalog.pageReplies.push(next, problem(503, "service_unavailable", "Unavailable"), problem(503, "service_unavailable", "Unavailable"));
        await tv.eventually(async () => {
            await revealEnd(tv);
            return await tv.page.locator(".browse .browse-card").count() > 24;
        }, "watchlist appended the next page");
        assert.equal(listReads(tv)[before]?.body?.cursor, "p-owner:watchlist:video:24");
        const shown = await tv.page.locator(".browse .browse-card").count();
        await tv.eventually(async () => {
            await revealEnd(tv);
            return listReads(tv).length > before + 1;
        }, "failed later page was attempted");
        await tv.jump(1000);
        assert.equal(await tv.page.locator(".browse .browse-card").count(), shown);
        assert.equal(await tv.page.getByRole("heading", { name: "Something went wrong" }).count(), 0);
        assert.equal(await tv.page.locator('[data-focus="retry"]').count(), 0);
        await tv.page.locator('[data-focus="for_you"]').focus(); await tv.remote(40);
        catalog.pageReplies.push(problem(503, "service_unavailable", "Unavailable"), problem(503, "service_unavailable", "Unavailable"));
        await tv.page.locator('[data-focus="watchlist"]').click();
        await tv.page.getByRole("heading", { name: "Something went wrong", exact: true }).waitFor();
        await tv.page.getByText("Unavailable", { exact: true }).waitFor();
        assert.equal(await tv.page.locator('[data-focus="retry"]').innerText(), "Try Again");
        for (const id of catalog.titles.keys()) catalog.excluded.add(id);
        await tv.page.locator('[data-focus="for_you"]').focus(); await tv.remote(40);
        await tv.page.locator('[data-focus="favorites"]').click();
        await tv.page.getByText("No favorites", { exact: true }).waitFor();
        await tv.page.getByText("Tap the heart icon on any item to add it here", { exact: true }).waitFor();
        assert.equal(await tv.page.locator('[data-focus="filter:movie"]').count(), 0);
        catalog.excluded.clear();
        await openList(tv, "history");
        assert.equal(await tv.page.locator('[data-focus="back"], [data-focus="filter:episode"]').count(), 0);
        const history = await tv.page.locator('[data-view="personal:history"]').evaluate(view => {
            const grid = view.querySelector<HTMLElement>(".browse-grid");
            const art = view.querySelector<HTMLElement>(".browse-art");
            const title = view.querySelector<HTMLElement>(".browse-title");
            const count = view.querySelector<HTMLElement>(".personal-count");
            const gridStyle = grid === null ? undefined : getComputedStyle(grid);
            const titleStyle = title === null ? undefined : getComputedStyle(title);
            const countStyle = count === null ? undefined : getComputedStyle(count);
            return {
                columns: gridStyle?.gridTemplateColumns.split(" ").length ?? 0,
                columnGap: gridStyle?.columnGap ?? "",
                rowGap: gridStyle?.rowGap ?? "",
                art: { width: art?.offsetWidth ?? 0, height: art?.offsetHeight ?? 0 },
                title: title?.textContent ?? "",
                titleSize: titleStyle?.fontSize ?? "",
                titleWeight: titleStyle?.fontWeight ?? "",
                count: count?.textContent ?? "",
                countSize: countStyle?.fontSize ?? "",
            };
        });
        assert.equal(history.columns, 6);
        assert.equal(history.columnGap, "40px");
        assert.equal(history.rowGap, "60px");
        assert.deepEqual(history.art, { width: 260, height: 390 });
        assert.equal(history.title, "History");
        assert.equal(history.titleSize, "56px");
        assert.equal(history.titleWeight, "700");
        assert.match(history.count, /^\d+ items$/);
        assert.equal(history.countSize, "22px");
        await tv.remote(10009);
        await tv.page.locator('[data-focus="for_you"]').focus();
        await tv.jump(250);
        await tv.page.locator('.skyline-selector [data-focus="watchlist"]').click();
        await tv.page.locator('[data-view="personal:watchlist"] .browse-card').first().waitFor();
        await tv.page.keyboard.press("ArrowUp");
        assert.equal(await tv.focused(), "home");
    } finally { await tv.page.context().close(); }
});

test("watchlist and favorites use Apple's 8-column 176px grid without a Back button", async () => {
    const { tv } = await setup();
    try {
        const frameOf = (source: string): Promise<{ columns: number; columnGap: string; rowGap: string; art: { width: number; height: number }; title: { size: string; weight: string; top: number; left: number }; content: { top: number; left: number; width: number }; back: number }> => tv.page.locator(`[data-view="personal:${source}"]`).evaluate(view => {
            const grid = view.querySelector<HTMLElement>(".browse-grid");
            const art = view.querySelector<HTMLElement>(".browse-art");
            const title = view.querySelector<HTMLElement>(".browse-title");
            const content = view.closest<HTMLElement>(".browse")?.querySelector<HTMLElement>(".skyline-content");
            const gridStyle = grid === null ? undefined : getComputedStyle(grid);
            const titleStyle = title === null ? undefined : getComputedStyle(title);
            const titleBox = title?.getBoundingClientRect();
            const contentBox = content?.getBoundingClientRect();
            return {
                columns: gridStyle?.gridTemplateColumns.split(" ").length ?? 0,
                columnGap: gridStyle?.columnGap ?? "",
                rowGap: gridStyle?.rowGap ?? "",
                art: { width: art?.offsetWidth ?? 0, height: art?.offsetHeight ?? 0 },
                title: { size: titleStyle?.fontSize ?? "", weight: titleStyle?.fontWeight ?? "", top: titleBox?.top ?? -1, left: titleBox?.left ?? -1 },
                content: { top: contentBox?.top ?? -1, left: contentBox?.left ?? -1, width: contentBox?.width ?? 0 },
                back: view.querySelectorAll('[data-focus="back"]').length,
            };
        });
        await openList(tv, "watchlist");
        const watchlist = await frameOf("watchlist");
        assert.equal(watchlist.back, 0);
        assert.equal(watchlist.columns, 8);
        assert.equal(watchlist.columnGap, "40px");
        assert.equal(watchlist.rowGap, "60px");
        assert.deepEqual(watchlist.art, { width: 176, height: 264 });
        assert.equal(watchlist.title.size, "64px");
        assert.equal(watchlist.title.weight, "700");
        assert.equal(watchlist.content.top, 188);
        assert.equal(watchlist.content.left, 80);
        assert.equal(watchlist.content.width, 1760);
        assert.equal(watchlist.title.top, 188);
        assert.equal(watchlist.title.left, 80);
        for (let step = 0; step < 7; step++) await tv.page.keyboard.press("ArrowRight");
        assert.equal(await tv.focused(), "movie:m0008");
        await tv.page.keyboard.press("ArrowRight");
        assert.equal(await tv.focused(), "movie:m0008");
        for (let step = 0; step < 7; step++) await tv.page.keyboard.press("ArrowLeft");
        await tv.page.keyboard.press("ArrowUp");
        assert.equal(await tv.focused(), "home");
        await openList(tv, "favorites");
        assert.equal(await tv.focused(), "filter:movie");
        const favorites = await frameOf("favorites");
        assert.equal(favorites.back, 0);
        assert.equal(favorites.columns, 8);
        assert.deepEqual(favorites.art, { width: 176, height: 264 });
        const pill = await tv.page.locator('[data-focus="filter:movie"]').evaluate(node => {
            const style = getComputedStyle(node);
            const row = node.parentElement === null ? undefined : getComputedStyle(node.parentElement);
            return { size: style.fontSize, weight: style.fontWeight, padding: style.padding, gap: row?.gap ?? "" };
        });
        assert.deepEqual(pill, { size: "24px", weight: "600", padding: "12px 28px", gap: "14px" });
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "movie:m0001");
        await tv.page.keyboard.press("ArrowUp");
        assert.equal(await tv.focused(), "filter:movie");
        await tv.page.keyboard.press("ArrowUp");
        assert.equal(await tv.focused(), "home");
    } finally { await tv.page.context().close(); }
});

for (const source of ["watchlist", "favorites"]) test(`card quick-actions remove from ${source} on the committed third page with nearby focus`, async () => {
    const { tv } = await setup();
    try {
        await openList(tv, source);
        await loadThrough(tv, 60);
        const card = tv.page.locator('[data-focus="movie:m0050"]');
        await card.focus();
        await tv.down(13); await tv.jump(650); await tv.up(13);
        const panel = tv.page.getByRole("dialog", { name: "Card actions" });
        const remove = source === "watchlist" ? "Remove from watchlist" : "Remove favorite";
        await panel.getByRole("button", { name: remove, exact: true }).click();
        await panel.getByRole("button", { name: source === "watchlist" ? "Add to watchlist" : "Add favorite", exact: true }).waitFor();
        await tv.remote(10009);
        await tv.eventually(async () => await card.count() === 0 && await tv.focused() === "movie:m0051", "nearby removal focus");
        const last = listReads(tv).slice(-1)[0];
        assert.equal(last?.body?.cursor, `p-owner:${source}:video:48`);
        assert.equal(last?.body?.source, source);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});
for (const destination of ["unchanged", "navigation", "profile menu"]) test(`initial personal-list completion preserves ${destination} focus`, async () => {
    const { tv } = await setup();
    try {
        const held = holdList(tv);
        await tv.page.locator('[data-focus="for_you"]').focus(); await tv.remote(40);
        await tv.page.locator('[data-focus="watchlist"]').click();
        await tv.eventually(async () => listReads(tv).length > 0, "initial personal read held");
        assert.equal(await tv.focused(), "status");
        assert.equal(await tv.page.locator('[data-focus="status"]').getAttribute("aria-label"), "Loading watchlist");
        if (destination === "navigation") {
            await tv.page.keyboard.press("ArrowUp");
            await tv.page.keyboard.press("ArrowLeft");
        } else if (destination === "profile menu") {
            await tv.page.locator('[data-focus="profiles"]').click();
            await tv.page.keyboard.press("ArrowDown");
            await tv.page.keyboard.press("ArrowDown");
        }
        const focus = await tv.focused();
        if (destination !== "unchanged") assert.notEqual(focus, "status");
        held.release();
        await tv.page.locator('[data-view="personal:watchlist"] .browse-card').first().waitFor();
        assert.equal(await tv.focused(), destination === "unchanged" ? "movie:m0001" : focus);
        assert.equal(listReads(tv).length, 1);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const source of ["watchlist", "favorites"]) test(`uncovering ${source} reconciles membership changed through another personal list`, async () => {
    const { tv, catalog } = await setup();
    try {
        await openList(tv, source);
        await loadThrough(tv, 60);
        await tv.page.locator('.browse [data-focus="movie:m0050"]').focus();
        await openList(tv, source === "watchlist" ? "favorites" : "watchlist");
        await loadThrough(tv, 60);
        await tv.page.locator('.browse [data-focus="movie:m0050"]').click();
        if (source === "favorites") await tv.page.locator('[data-focus="more"]').click();
        await tv.page.getByRole("button", { name: source === "favorites" ? "Remove favorite" : "Remove from watchlist", exact: true }).click();
        await tv.page.getByRole("button", { name: source === "favorites" ? "Add favorite" : "Add to watchlist", exact: true }).waitFor();
        const innerRefresh = holdList(tv, source === "watchlist" ? "favorites" : "watchlist");
        if (source === "favorites") await tv.remote(10009);
        await tv.remote(10009);
        await tv.page.locator('[data-view^="personal:"]').waitFor();
        const cached = await tv.page.locator('.browse [data-focus="movie:m0050"]').elementHandle();
        assert.ok(cached);
        innerRefresh.release();
        await tv.eventually(async () => await cached.evaluate(node => !node.isConnected), "inner list refresh rendered");
        await tv.eventually(async () => await tv.focused() === "movie:m0050", "other list retains the title");
        const queries = listReads(tv).length;
        const held = holdList(tv, source);
        await tv.remote(10009);
        await tv.remote(10009);
        await tv.page.locator(`[data-view="personal:${source}"]`).waitFor();
        held.release();
        await tv.eventually(async () => await tv.page.locator('.browse [data-focus="movie:m0050"]').count() === 0, "uncovered list reconciles confirmed removal");
        assert.equal(listReads(tv).length, queries + 3);
        assert.equal(catalog.mutations.length, 1);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Details return discards an abandoned personal-page turn", async () => {
    const { tv } = await setup();
    try {
        holdList(tv).release();
        holdList(tv).release();
        const held = holdList(tv);
        await openList(tv, "watchlist");
        await loadThrough(tv, 48);
        await revealEnd(tv);
        await tv.eventually(async () => listReads(tv).some(request => request.body?.cursor === "p-owner:watchlist:video:48"), "pending later page");
        await tv.page.locator('[data-focus="movie:m0026"]').click();
        await tv.page.locator('[data-view="item:movie:m0026"]').waitFor();
        const refresh = holdList(tv);
        await tv.remote(10009);
        const cached = await tv.page.locator('.browse [data-focus="movie:m0026"]').elementHandle();
        assert.ok(cached);
        held.release();
        refresh.release();
        await tv.eventually(async () => await cached.evaluate(node => !node.isConnected), "personal-page refresh rendered");
        assert.equal(await tv.page.locator(".browse-page-status").count(), 0);
        assert.equal(await tv.focused(), "movie:m0026");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const source of ["watchlist", "favorites"]) test(`integrated Details removes ${source} membership without changing the other list`, async () => {
    const { tv, catalog } = await setup();
    try {
        await openList(tv, source);
        await loadThrough(tv, 60);
        await tv.page.locator('.browse [data-focus="movie:m0050"]').click();
        await tv.page.locator('[data-view="item:movie:m0050"]').waitFor();
        if (source === "favorites") await tv.page.locator('[data-focus="more"]').click();
        const remove = tv.page.getByRole("button", { name: source === "favorites" ? "Remove favorite" : "Remove from watchlist", exact: true });
        await tv.eventually(async () => await remove.count() === 1, "Details exposes authoritative list membership");
        const held = tv.fake.hold(`/${source}/movie%3Am0050/membership`, true);
        await remove.click();
        await tv.eventually(async () => catalog.mutations.length === 1, "Details removal committed");
        assert.equal(await tv.page.locator(`[data-focus="${source}"]`).getAttribute("aria-disabled"), "true");
        held.release();
        await tv.page.getByRole("button", { name: source === "favorites" ? "Add favorite" : "Add to watchlist", exact: true }).waitFor();
        if (source === "favorites") await tv.remote(10009);
        await tv.remote(10009);
        await tv.eventually(async () => await tv.page.locator('.browse [data-focus="movie:m0050"]').count() === 0, "confirmed removal reconciles the current page");
        assert.equal(await tv.focused(), "movie:m0051");
        assert.equal(catalog.mutations.length, 1);
        await tv.remote(10009);
        assert.equal(await tv.focused(), "home");
        await tv.remote(10009);
        await tv.page.locator('[data-view="home"]').waitFor();
        await openList(tv, source === "watchlist" ? "favorites" : "watchlist");
        await loadThrough(tv, 60);
        assert.equal(await tv.page.locator('.browse [data-focus="movie:m0050"]').count(), 1);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const removed of [false, true]) test(`later-page Details return ${removed ? "removes the item with nearby fallback" : "keeps unchanged page and identity"}`, async () => {
    const { tv, catalog } = await setup();
    try {
        await openList(tv, "watchlist");
        await loadThrough(tv, 60);
        await tv.page.locator('.browse [data-focus="movie:m0050"]').click();
        await tv.page.locator('[data-view="item:movie:m0050"]').waitFor();
        if (removed) catalog.excluded.add("movie:m0050");
        const held = holdList(tv);
        await tv.remote(10009);
        assert.equal(await tv.focused(), "movie:m0050");
        held.release();
        await tv.eventually(async () => listReads(tv).length >= 4, "refresh sent");
        await tv.page.waitForTimeout(200);
        assert.equal(await tv.focused(), removed ? "movie:m0051" : "movie:m0050");
        assert.equal(await tv.page.locator('.browse [data-focus="movie:m0050"]').count(), removed ? 0 : 1);
    } finally { await tv.page.context().close(); }
});
test("personal destinations page on the server, restore Details focus and reconcile changed membership", async () => {
    const { tv, catalog } = await setup();
    try {
        for (const source of ["watchlist", "favorites", "history"]) {
            await openList(tv, source);
            assert.equal(await tv.page.locator(".browse .browse-card").count(), source === "history" ? 60 : 24);
            const reads = tv.fake.requests.length;
            await tv.page.locator(".browse .browse-card").first().focus();
            await tv.page.keyboard.press("ArrowRight");
            assert.equal(tv.fake.requests.length, reads);
            await loadThrough(tv, 48);
            const id = await tv.page.locator(".browse .browse-card").last().getAttribute("data-focus");
            assert.ok(id);
            // Prefetch can change the last card between selecting an identity and clicking it.
            await loadThrough(tv, 60);
            await tv.page.locator(`.browse .browse-card[data-focus="${id}"]`).click();
            await tv.page.locator('[data-view^="item:"]').waitFor();
            await tv.remote(10009);
            await tv.page.locator('[data-view^="personal:"]').waitFor();
            await tv.eventually(async () => await tv.focused() === id, "unchanged later page identity");
            await tv.page.locator(".browse .browse-card").first().click();
            await tv.page.locator('[data-view^="item:movie:"]').waitFor();
            catalog.excluded.add(id);
            await tv.remote(10009);
            await tv.eventually(async () => await tv.page.locator(`.browse-card[data-focus="${id}"]`).count() === 0, "membership refresh");
            catalog.excluded.clear();
            if (source !== "history") {
                await tv.remote(10009);
                assert.equal(await tv.focused(), "home");
                assert.equal(await tv.page.locator(`[data-view="personal:${source}"]`).count(), 1);
            }
            await tv.remote(10009);
            try { await tv.page.locator('[data-view="home"]').waitFor(); }
            catch (error: unknown) {
                const state = await tv.page.evaluate(() => ({ view: document.querySelector('.browse')?.getAttribute('data-view'), focus: document.activeElement?.getAttribute('data-focus'), alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent), targets: [...document.querySelectorAll('.browse [data-focus]')].map(node => node.getAttribute('data-focus')) }));
                throw new Error(`${String(error)}; source=${source}; state=${JSON.stringify(state)}`);
            }
            assert.equal(await tv.focused(), "home");
        }
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Favorites filters the whole result before paging and retains opaque continuation", async () => {
    const { tv } = await setup();
    try {
        await openList(tv, "favorites");
        await loadThrough(tv, 60);
        const seen = await tv.page.locator(".browse .browse-card").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus") ?? ""));
        assert.equal(new Set(seen).size, 60);
        assert.ok(seen.every(id => id.startsWith("movie:")));
        await tv.page.locator('[data-focus="filter:series"]').click();
        await tv.eventually(async () => await tv.page.locator(".browse .browse-card").count() === 3, "server series filter");
        assert.deepEqual(await tv.page.locator(".browse .browse-card").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus"))), ["series:s1", "series:s2", "series:s3"]);
        const query = listReads(tv).pop();
        assert.equal(query?.method, "GET");
        assert.ok(query?.path.startsWith("/favorites?"));
        assert.equal(await tv.focused(), "filter:series");
    } finally { await tv.page.context().close(); }
});

test("a failed later page keeps the rows, and an invalid cursor restarts from the first page", async () => {
    const { tv, catalog } = await setup();
    try {
        await openList(tv, "watchlist");
        catalog.pageReplies.push(problem(503, "service_unavailable", "Unavailable"), problem(503, "service_unavailable", "Unavailable"));
        const before = listReads(tv).length;
        await tv.eventually(async () => {
            await revealEnd(tv);
            return listReads(tv).length > before;
        }, "later page attempted");
        await tv.jump(1000);
        assert.equal(await tv.page.locator(".browse .browse-card").count(), 24);
        assert.equal(await tv.page.locator(".browse .browse-card").first().getAttribute("data-focus"), "movie:m0001");
        assert.equal(await tv.page.locator('[data-focus="retry"]').count(), 0);
        assert.equal(await tv.page.getByRole("heading", { name: "Something went wrong" }).count(), 0);
        await tv.page.locator(".skyline-content").evaluate(node => { node.scrollTop = 0; });
        // The observer only reports the end leaving and re-entering view across rendered frames.
        await tv.page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
        await loadThrough(tv, 48);
        assert.equal(await tv.page.locator('.browse [data-focus="movie:m0025"]').count(), 1);
        assert.equal(listReads(tv).filter(request => request.body?.cursor === "p-owner:watchlist:video:24").length > 0, true);
        catalog.pageReplies.push(problem(400, "invalid_cursor", "Invalid cursor"));
        const mark = listReads(tv).length;
        await tv.eventually(async () => {
            await revealEnd(tv);
            return listReads(tv).slice(mark).some(request => request.body?.cursor === undefined);
        }, "invalid cursor restarted");
        assert.equal(await tv.page.locator('.browse [data-focus="movie:m0001"]').count(), 1);
        assert.equal(await tv.page.locator('[data-focus="retry"]').count(), 0);
    } finally { await tv.page.context().close(); }
});

test("capability failures are retryable errors, unsupported is explicit, empty remains navigable", async () => {
    const { tv, catalog } = await setup();
    try {
        catalog.capabilityReplies.push({ status: 200, body: { allowed: true } });
        await tv.page.locator('[data-focus="for_you"]').focus(); await tv.remote(40);
        await tv.page.locator('[data-focus="watchlist"]').click();
        await tv.page.getByRole("heading", { name: "Something went wrong", exact: true }).waitFor();
        await tv.page.getByText("The server response was in an unexpected format.", { exact: true }).waitFor();
        assert.equal(listReads(tv).length, 0);
        catalog.unavailable = true;
        await tv.page.locator('[data-focus="retry"]').click();
        await tv.page.getByText("Watchlist is unavailable.").waitFor();
        await tv.remote(10009);
        catalog.unavailable = false;
        for (const id of catalog.titles.keys()) catalog.excluded.add(id);
        await tv.page.locator('[data-focus="for_you"]').focus(); await tv.remote(40);
        await tv.page.locator('[data-focus="watchlist"]').click();
        await tv.page.getByText("Watchlist is empty", { exact: true }).waitFor();
        await tv.page.getByText("Tap the bookmark icon on any item to add it here", { exact: true }).waitFor();
        assert.equal(await tv.focused(), "status");
        await tv.page.keyboard.press("ArrowUp");
        assert.equal(await tv.focused(), "home");
    } finally { await tv.page.context().close(); }
});

test("profile change drops late personal answers and PIN-scopes the replacement list", async () => {
    const { tv } = await setup();
    try {
        const held = holdList(tv, "history");
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.locator('[data-focus="history"]').click();
        await tv.eventually(async () => listReads(tv).length > 0, "held personal read");
        await tv.page.evaluate(() => window.browseHarness.clearProfile());
        held.release();
        await tv.jump(0);
        assert.equal(await tv.page.locator(".browse").count(), 0);
        assert.equal(await tv.page.evaluate(() => window.browseHarness.selectProfile("p-kid", "2468")), "verified");
        await tv.page.evaluate(() => window.browseHarness.mount());
        await tv.page.locator('[data-view="home"]').waitFor();
        await openList(tv, "watchlist");
        assert.equal(await tv.page.locator(".browse .browse-card").count(), 8);
        const read = listReads(tv).pop();
        assert.equal(read?.headers["x-profile-id"], "p-kid");
        assert.ok(read?.headers["x-profile-token"]?.startsWith("pvt-"));
        assert.ok((await tv.page.locator(".browse .browse-card").evaluateAll(nodes => nodes.map(n => n.getAttribute("data-focus") ?? ""))).every(id => id.startsWith("movie:k")));
    } finally { await tv.page.context().close(); }
});

test("remote personal journey keeps scrolled focus visible with Reduced Motion and restores Details identity", async () => {
    const { tv } = await setup(true);
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        const step = async (key: string): Promise<void> => {
            await tv.page.keyboard.press(key);
            if (process.env.PERSONAL_VIDEO !== undefined) await tv.page.waitForTimeout(350);
        };
        await step("ArrowUp");
        for (let i = 0; i < 3; i++) await step("ArrowRight");
        await step("ArrowDown");
        const output = process.env.PERSONAL_CAPTURE;
        if (output !== undefined) {
            await mkdir(output, { recursive: true });
            await tv.page.screenshot({ path: `${output}/for-you-after.png` });
        }
        assert.equal(await tv.focused(), "watchlist");
        await step("Enter");
        await tv.page.locator('[data-view="personal:watchlist"] .browse-card').first().waitFor();
        if (output !== undefined) await tv.page.screenshot({ path: `${output}/watchlist.png` });
        for (let i = 0; i < 2; i++) await step("ArrowDown");
        for (let i = 0; i < 7; i++) await step("ArrowRight");
        assert.equal(await tv.focused(), "movie:m0024");
        const focus = await tv.page.evaluate(() => {
            const rect = document.activeElement?.getBoundingClientRect();
            return { top: rect?.top ?? -1, bottom: rect?.bottom ?? 2000, transition: getComputedStyle(document.activeElement ?? document.body).transitionDuration };
        });
        assert.ok(focus.top >= 0 && focus.bottom <= 1080, JSON.stringify(focus));
        assert.ok(focus.transition.split(",").every(s => s.trim() === "0s"));
        if (output !== undefined) await tv.page.screenshot({ path: `${output}/watchlist-scrolled.png` });
        await step("Enter");
        await tv.page.locator('[data-view="item:movie:m0024"]').waitFor();
        await tv.remote(10009);
        await tv.page.locator('[data-view="personal:watchlist"] .browse-card').first().waitFor();
        await tv.eventually(async () => await tv.focused() === "movie:m0024", "restored card identity");
        assert.ok(await tv.page.locator(".browse .browse-card").count() >= 24);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("History includes episodes and cached Details return remains visible during reconciliation", async () => {
    const { tv } = await setup();
    try {
        await openList(tv, "history");
        assert.equal(listReads(tv).pop()?.body?.type, undefined);
        await tv.page.locator('.browse [data-focus="movie:m0002"]').click();
        await tv.page.locator('[data-view="item:movie:m0002"]').waitFor();
        const held = holdList(tv, "history");
        await tv.remote(10009);
        await tv.page.locator('[data-view="personal:history"]').waitFor();
        assert.equal(await tv.page.locator(".browse .browse-card").count(), 60);
        assert.equal(await tv.focused(), "movie:m0002");
        held.release();
        await tv.eventually(async () => await tv.focused() === "movie:m0002", "refresh kept the open card");
        await loadThrough(tv, 63);
        assert.ok(await tv.page.locator('.browse .browse-card[data-focus^="series:"]').count() > 0);
        assert.equal(await tv.page.getByRole("button", { name: "Episodes", exact: true }).count(), 0);
        assert.equal(listReads(tv).every(request => request.body?.type !== "episode"), true);
    } finally { await tv.page.context().close(); }
});
