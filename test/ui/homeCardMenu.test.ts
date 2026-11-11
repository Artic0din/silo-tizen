import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { problem, type Reply } from "../native/support/fakeSilo.ts";
import { homeDetailsRead, jumpUntil, launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const PROGRESS_STAMP = "2026-11-01T09:30:00Z";

/** Home rows carry `user_state` and Continue Watching's progress stamp; dismissals hide cards as the server does. */
class HomeMenuFake extends FakeDetails {
    readonly dismissals: { surface: string; id: string; body: Record<string, unknown> | undefined }[] = [];
    dismissalFailure: Reply | undefined;
    private readonly dismissed = new Set<string>();

    constructor() {
        super();
        this.add({ id: "audiobook:tide", type: "audiobook", title: "Tide Tables", libraryId: "14" });
        const home = this.households.get("p-owner");
        assert.ok(home);
        home.sections = [
            { id: "continue_watching", title: "Continue Watching", items: ["movie:m0001", "episode:s1e12"] },
            { id: "next_up", title: "Next Up", items: ["episode:s2e11"] },
            { id: "recently_added", title: "Recently Added", items: ["movie:m0002", "movie:m0004", "series:s2"] },
            { id: "audiobooks", sectionType: "recently_added_audiobooks", title: "Recently Added Audiobooks", items: ["audiobook:tide"] },
        ];
    }

    override route(method: string, path: string, profileId: string | undefined, body?: Record<string, unknown>): Reply | undefined {
        const url = new URL(path, "https://example.test");
        const dismissal = /^\/home\/dismissals\/([^/]+)\/([^/]+)$/.exec(url.pathname);
        if (dismissal !== null && method === "PUT") {
            const id = decodeURIComponent(dismissal[2] ?? "");
            this.dismissals.push({ surface: dismissal[1] ?? "", id, body });
            if (this.dismissalFailure !== undefined) { const failure = this.dismissalFailure; this.dismissalFailure = undefined; return failure; }
            this.dismissed.add(id);
            return { status: 204 };
        }
        const reply = super.route(method, path, profileId, body);
        if (method !== "GET" || url.pathname !== "/home/sections" || reply?.status !== 200) return reply;
        const response = reply.body as { sections: { section_type: string; items: Record<string, unknown>[] }[] };
        const hidden = (card: Record<string, unknown>): boolean => this.dismissed.has(String(card.content_id)) || this.dismissed.has(String(card.series_id));
        // Only the card menu's own writes count; the base fake marks season 1 as watched for Details.
        const watched = (id: string): boolean => this.personalMembers(profileId, "watched").has(id);
        return { status: 200, body: { ...response, sections: response.sections.map(section => ({ ...section, items: section.items
            .filter(card => !hidden(card) && !(section.section_type === "continue_watching" && watched(String(card.content_id))))
            .map(card => ({ ...card,
                ...(section.section_type === "continue_watching" && card.position_seconds !== undefined ? { progress_updated_at: PROGRESS_STAMP } : {}),
                user_state: { played: watched(String(card.content_id)), is_favorite: this.personalMembers(profileId, "favorites").has(String(card.content_id)), in_watchlist: this.personalMembers(profileId, "watchlist").has(String(card.content_id)), not_interested: false } })) }))
            .filter(section => section.items.length > 0) } };
    }
}

async function start(tv: Tv, catalog = new HomeMenuFake()): Promise<HomeMenuFake> {
    tv.fake.catalog = catalog;
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.page.locator('[data-section="continue_watching"] .browse-card').first().waitFor();
    await homeDetailsRead(tv);
    return catalog;
}

const card = (tv: Tv, section: string, id: string) => tv.page.locator(`[data-section="${section}"] [data-focus="${id}"]`);
const menu = (tv: Tv) => tv.page.getByRole("menu");
const rows = (tv: Tv) => menu(tv).getByRole("menuitem").evaluateAll(nodes => nodes.map(node => `${node.textContent ?? ""} [${node.getAttribute("data-symbol") ?? ""}]`));

async function hold(tv: Tv, section: string, id: string): Promise<void> {
    await card(tv, section, id).focus();
    await tv.down(13);
    await tv.jump(650);
    await tv.up(13);
    await menu(tv).waitFor();
}

test("Home card menus list Apple's rows, labels, icons and order for each card type, with no title or loading rows", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        const reads = tv.fake.requests.length;
        await hold(tv, "continue_watching", "movie:m0001");
        assert.deepEqual(await rows(tv), [
            "Resume [play.fill]", "Mark as Watched [checkmark.circle]", "Add to Favorites [heart]", "Add to Watchlist [bookmark]", "Remove from Continue Watching [xmark.circle]",
        ]);
        assert.equal(await menu(tv).getAttribute("aria-label"), "Movie 0001");
        assert.equal(await menu(tv).locator("h1, h2").count(), 0, "the menu has no title");
        assert.equal(await menu(tv).locator('[data-focus="remove"]').getAttribute("class").then(value => value?.includes("skyline-destructive")), true);
        assert.equal(tv.fake.requests.slice(reads).filter(request => request.path.startsWith("/catalog/items/")).length, 0, "the menu opens from the row's data");
        await tv.remote(10009);
        // A Continue Watching card without a progress stamp is a merged Next Up card (HomeDismissal).
        await hold(tv, "continue_watching", "episode:s1e12");
        assert.deepEqual(await rows(tv), ["Play [play.fill]", "Mark as Watched [checkmark.circle]", "Add to Favorites [heart]", "Add to Watchlist [bookmark]", "Remove from Next Up [xmark.circle]"]);
        await tv.remote(10009);
        await hold(tv, "next_up", "episode:s2e11");
        assert.deepEqual(await rows(tv), ["Mark as Watched [checkmark.circle]", "Add to Favorites [heart]", "Add to Watchlist [bookmark]", "Remove from Next Up [xmark.circle]"]);
        await tv.remote(10009);
        await hold(tv, "recently_added", "movie:m0002");
        assert.deepEqual(await rows(tv), ["Mark as Watched [checkmark.circle]", "Add to Favorites [heart]", "Add to Watchlist [bookmark]"]);
        await tv.remote(10009);
        await hold(tv, "audiobooks", "audiobook:tide");
        assert.deepEqual(await rows(tv), ["Mark as Watched [checkmark.circle]", "Add to Favorites [heart]", "Add to Watchlist [bookmark]"], "square audiobook cards keep Home's watched row");
        await tv.remote(10009);
        assert.equal(await tv.page.getByText(/Loading card actions|Try again|Close|Episode information/).count(), 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Home card menu opens beside its card, moves only vertically, and Back returns focus to the card", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        await hold(tv, "recently_added", "movie:m0002");
        assert.equal(await tv.page.locator(".card-actions-scrim, .confirm-dialog-scrim").count(), 0, "no scrim");
        const origin = await card(tv, "recently_added", "movie:m0002").boundingBox();
        const panel = await menu(tv).boundingBox();
        assert.ok(origin !== null && panel !== null);
        assert.ok(panel.x >= origin.x + origin.width, "the menu sits to the right of the card");
        assert.ok(panel.width < 600, "a compact menu, not a centred panel");
        assert.equal(await tv.focused(), "watched");
        await tv.remote(40);
        assert.equal(await tv.focused(), "favorites");
        await tv.remote(39);
        assert.equal(await tv.focused(), "favorites", "Right does nothing");
        await tv.remote(37);
        assert.equal(await tv.focused(), "favorites", "Left does nothing");
        await tv.remote(40);
        await tv.remote(40);
        assert.equal(await tv.focused(), "watchlist", "Down stops at the last row");
        await tv.remote(38);
        assert.equal(await tv.focused(), "favorites");
        await tv.remote(10009);
        assert.equal(await menu(tv).count(), 0);
        assert.equal(await tv.focused(), "movie:m0002");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("choosing a row closes the menu, and the next menu shows the changed favorite and watchlist state", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await hold(tv, "recently_added", "movie:m0002");
        const homeReads = (): number => tv.fake.requests.filter(request => request.path.startsWith("/home/sections?")).length;
        const before = homeReads();
        await menu(tv).getByRole("menuitem", { name: "Add to Favorites" }).click();
        assert.equal(await menu(tv).count(), 0, "a chosen row closes the menu");
        await jumpUntil(tv, 250, async () => catalog.mutations.includes("PUT /favorites/movie%3Am0002") && homeReads() > before, "favorite write and Home read");
        await card(tv, "recently_added", "movie:m0002").waitFor();
        assert.equal(await tv.focused(), "movie:m0002");
        await hold(tv, "recently_added", "movie:m0002");
        await menu(tv).getByRole("menuitem", { name: "Remove from Favorites" }).waitFor();
        const watchlistBefore = homeReads();
        await menu(tv).getByRole("menuitem", { name: "Add to Watchlist" }).click();
        await jumpUntil(tv, 250, async () => catalog.mutations.includes("PUT /watchlist/movie%3Am0002") && homeReads() > watchlistBefore, "watchlist write and Home read");
        await card(tv, "recently_added", "movie:m0002").waitFor();
        await hold(tv, "recently_added", "movie:m0002");
        assert.deepEqual(await rows(tv), ["Mark as Watched [checkmark.circle]", "Remove from Favorites [heart.slash]", "Remove from Watchlist [bookmark.slash]"]);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Mark as Watched and Remove take the card out of the playback rows and read Home again", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        const homeReads = (): number => tv.fake.requests.filter(request => request.path.startsWith("/home/sections?")).length;
        let before = homeReads();
        await hold(tv, "continue_watching", "movie:m0001");
        await menu(tv).getByRole("menuitem", { name: "Mark as Watched" }).click();
        await tv.eventually(async () => await card(tv, "continue_watching", "movie:m0001").count() === 0, "watched card leaves Continue Watching");
        assert.deepEqual(catalog.mutations, ["POST /watched/movie%3Am0001"]);
        await jumpUntil(tv, 250, async () => homeReads() > before, "Home read again");
        await card(tv, "continue_watching", "episode:s1e12").waitFor();
        assert.notEqual(await tv.focused(), null, "focus stays on the page");
        before = homeReads();
        await hold(tv, "continue_watching", "episode:s1e12");
        await menu(tv).getByRole("menuitem", { name: "Remove from Next Up" }).click();
        await tv.eventually(async () => await tv.page.locator('[data-section="continue_watching"]').count() === 0, "the emptied row goes");
        assert.deepEqual(catalog.dismissals, [{ surface: "next_up", id: "episode:s1e12", body: { series_id: "series:s1" } }]);
        await jumpUntil(tv, 250, async () => homeReads() > before, "Home read again");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Remove from Continue Watching sends the card's progress stamp", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        await hold(tv, "continue_watching", "movie:m0001");
        await menu(tv).getByRole("menuitem", { name: "Remove from Continue Watching" }).click();
        await tv.eventually(async () => await card(tv, "continue_watching", "movie:m0001").count() === 0, "dismissed card leaves the row");
        assert.deepEqual(catalog.dismissals, [{ surface: "continue_watching", id: "movie:m0001", body: { progress_updated_at: PROGRESS_STAMP } }]);
        assert.deepEqual(catalog.mutations, []);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const failure of ["watched", "remove", "favorites"] as const) test(`a failed ${failure} change shows Apple's Couldn't Update Item alert, and OK or Back returns to the card`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        for (const close of ["enter", "back"] as const) {
            if (failure === "remove") catalog.dismissalFailure = problem(500, "internal_error", "Failed to save dismissal");
            else catalog.mutationFailure = problem(500, "internal_error", "Failed");
            await hold(tv, "continue_watching", "movie:m0001");
            await menu(tv).getByRole("menuitem", { name: failure === "watched" ? "Mark as Watched" : failure === "remove" ? "Remove from Continue Watching" : "Add to Favorites" }).click();
            const alert = tv.page.getByRole("alertdialog");
            await alert.waitFor();
            const home = failure !== "favorites";
            assert.equal(await alert.locator("h2").innerText(), home ? "Couldn’t Update Item" : "Couldn't Update Item");
            assert.equal(await alert.locator("p").innerText(), home ? "The item could not be updated. Try again." : "Your change wasn't saved. Please try again.");
            assert.deepEqual(await alert.getByRole("button").allInnerTexts(), ["OK"]);
            assert.equal(await tv.focused(), "alert-ok");
            assert.equal(await tv.page.locator(".signin-alert").count(), 1, "the shared centred alert");
            await tv.remote(40);
            assert.equal(await tv.focused(), "alert-ok", "the alert keeps focus");
            if (close === "enter") await tv.page.keyboard.press("Enter");
            else await tv.remote(10009);
            assert.equal(await alert.count(), 0);
            assert.equal(await tv.focused(), "movie:m0001");
            assert.equal(await card(tv, "continue_watching", "movie:m0001").count(), 1, "a failed change keeps the card");
        }
        await hold(tv, "continue_watching", "movie:m0001");
        assert.ok((await rows(tv)).includes(failure === "favorites" ? "Add to Favorites [heart]" : "Mark as Watched [checkmark.circle]"), "the row shows the unchanged state");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a failure during a Home refresh keeps Apple's alert, its focus and its keys when the rows redraw", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        const homeReads = (): number => tv.fake.requests.filter(request => request.path.startsWith("/home/sections?")).length;
        // A confirmed change leaves Home stale, so the next menu's close starts a read.
        let before = homeReads();
        await hold(tv, "recently_added", "movie:m0004");
        await menu(tv).getByRole("menuitem", { name: "Add to Watchlist" }).click();
        await jumpUntil(tv, 250, async () => homeReads() > before, "Home read after the change");
        await card(tv, "recently_added", "movie:m0004").waitFor();
        await hold(tv, "recently_added", "movie:m0002");
        const held = tv.fake.hold("/home/sections", true);
        catalog.mutationFailure = problem(500, "internal_error", "Failed");
        before = homeReads();
        await menu(tv).getByRole("menuitem", { name: "Mark as Watched" }).click();
        const alert = tv.page.getByRole("alertdialog");
        await alert.waitFor();
        held.release();
        await jumpUntil(tv, 250, async () => homeReads() >= before, "Home read");
        await tv.jump(1000);
        assert.equal(await alert.count(), 1, "the redrawn rows leave the alert in place");
        await tv.remote(40);
        assert.equal(await tv.focused(), "alert-ok");
        await tv.page.keyboard.press("Enter");
        assert.equal(await alert.count(), 0);
        assert.equal(await tv.focused(), "movie:m0002");
        assert.equal(await tv.page.locator(".browse").evaluate(node => (node as HTMLElement).inert), false);
        await tv.remote(39);
        assert.equal(await tv.focused(), "movie:m0004", "the remote moves again after OK");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Resume in the Continue Watching menu starts playback from the row", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        await hold(tv, "continue_watching", "movie:m0001");
        await menu(tv).getByRole("menuitem", { name: "Resume" }).click();
        assert.equal(await menu(tv).count(), 0);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.plays.length === 1), "Resume hands off to playback");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a Home refresh shows only the rows, with no status line or Try again, while it runs or after it fails", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = await start(tv);
        const homeReads = (): number => tv.fake.requests.filter(request => request.path.startsWith("/home/sections?")).length;
        const held = tv.fake.hold("/home/sections", true);
        let before = homeReads();
        await hold(tv, "recently_added", "movie:m0002");
        await menu(tv).getByRole("menuitem", { name: "Add to Watchlist" }).click();
        await jumpUntil(tv, 250, async () => homeReads() > before, "Home refresh starts");
        assert.equal(await tv.page.getByText(/Refreshing titles/).count(), 0);
        assert.equal(await tv.page.locator('.browse [data-focus="retry"]').count(), 0);
        held.release();
        await tv.jump(500);
        catalog.failNext("/home/sections", problem(500, "internal_error", "Unavailable"));
        before = homeReads();
        await hold(tv, "recently_added", "movie:m0002");
        await menu(tv).getByRole("menuitem", { name: "Add to Favorites" }).click();
        await jumpUntil(tv, 250, async () => homeReads() > before, "Home refresh runs");
        await tv.jump(1000);
        assert.equal(await card(tv, "recently_added", "movie:m0002").count(), 1, "the rows stay");
        assert.equal(await tv.page.locator('.browse [data-focus="retry"]').count(), 0, "a failed refresh with rows on screen shows only the rows");
        assert.equal(await tv.page.getByText("Unavailable").count(), 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("an empty Home shows Apple's EmptyStateView under a page focus owner whose Up reaches the top bar", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = new HomeMenuFake();
        const home = catalog.households.get("p-owner");
        assert.ok(home);
        home.sections = [];
        tv.fake.catalog = catalog;
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount());
        const empty = tv.page.locator(".home-empty");
        await empty.waitFor();
        assert.equal(await empty.locator(".search-state-title").innerText(), "Nothing to watch yet");
        assert.equal(await empty.locator(".search-state-description").innerText(), "Add media to your libraries or start watching to see it here.");
        assert.equal(await empty.locator(".search-state-icon svg").count(), 1);
        const styles = await empty.evaluate(node => {
            const read = (selector: string) => getComputedStyle(node.querySelector(selector) ?? node);
            const scale = Number(getComputedStyle(document.documentElement).getPropertyValue("--silo-sf-cap-scale"));
            return { scale, icon: [read(".search-state-icon").width, read(".search-state-icon").color], title: [read(".search-state-title").fontSize, read(".search-state-title").fontWeight], line: [read(".search-state-description").fontSize, read(".search-state-description").color] };
        });
        assert.deepEqual(styles.icon, ["44px", "rgba(237, 237, 237, 0.3)"]);
        assert.ok(Math.abs(parseFloat(styles.title[0] ?? "") - 28 * styles.scale) < 0.01, "28 pt title times the cap scale");
        assert.equal(styles.title[1], "600");
        assert.ok(Math.abs(parseFloat(styles.line[0] ?? "") - 22 * styles.scale) < 0.01, "22 pt line times the cap scale");
        assert.equal(styles.line[1], "rgba(237, 237, 237, 0.6)");
        assert.equal(await tv.page.getByText("There is nothing to watch on this profile yet.").count(), 0);
        assert.equal(await tv.focused(), "home-empty");
        await tv.page.keyboard.press("ArrowUp");
        assert.equal(await tv.focused(), "home");
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "home-empty");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});
