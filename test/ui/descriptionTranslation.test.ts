import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeHome } from "../native/support/fakeHome.ts";
import type { CatalogRoutes, FakeSilo, Reply } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

/** Serves the metadata-AI capability and the description-translation write, and marks the chosen titles pending until that write lands. */
function install(fake: FakeSilo, catalog: CatalogRoutes, onView: "button" | "auto", pendingIds: readonly string[], fail = false): { posts(): { path: string; body: Record<string, unknown> | undefined; profile: string | undefined }[] } {
    const posted: { path: string; body: Record<string, unknown> | undefined; profile: string | undefined }[] = [];
    const translated = new Set<string>();
    fake.extraRoutes.push((method, path, headers, body) => {
        const url = new URL(path, "https://fake.invalid");
        if (method === "GET" && url.pathname === "/capabilities/metadata-ai") {
            return { status: 200, body: { allowed: true, on_view: onView, revision: "rev", state: "available" } };
        }
        const match = method === "POST" ? /^\/catalog\/items\/([^/]+)\/translate-description$/.exec(url.pathname) : undefined;
        const encoded = match?.[1];
        if (encoded === undefined) return undefined;
        const id = decodeURIComponent(encoded);
        posted.push({ path, body, profile: headers["x-profile-id"] });
        if (!fail) translated.add(id);
        const language = body?.target_language;
        return { status: 202, body: { id: "job-1", content_id: id, target_kind: "item", target_language: language, status: fail ? "failed" : "pending" } };
    });
    const read = catalog.route.bind(catalog);
    catalog.route = (method: string, path: string, profileId: string | undefined, body?: Record<string, unknown>, headers?: Readonly<Record<string, string>>): Reply | undefined => {
        const reply = read(method, path, profileId, body, headers);
        if (reply?.status !== 200 || reply.body === undefined) return reply;
        return { ...reply, body: decorate(reply.body, new Set(pendingIds), translated) };
    };
    return { posts: () => posted };
}

function decorate(value: unknown, pendingIds: ReadonlySet<string>, translated: ReadonlySet<string>): unknown {
    if (Array.isArray(value)) return value.map((entry) => decorate(entry, pendingIds, translated));
    if (typeof value !== "object" || value === null) return value;
    const row = value as Record<string, unknown>;
    const next: Record<string, unknown> = { ...row };
    if (typeof next.content_id === "string" && pendingIds.has(next.content_id)) {
        if (translated.has(next.content_id)) {
            next.overview = "Translated overview";
            next.machine_translated_fields = ["overview"];
            delete next.pending_translation_language;
        } else {
            next.pending_translation_language = "de";
        }
    }
    if (Array.isArray(next.items)) next.items = next.items.map((entry) => decorate(entry, pendingIds, translated));
    if (Array.isArray(next.sections)) next.sections = next.sections.map((entry) => decorate(entry, pendingIds, translated));
    return next;
}

async function signIn(tv: Tv): Promise<void> {
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
}

test("Details offers Translate Description and shows the translating and translated states", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeDetails();
    tv.fake.catalog = catalog;
    const translation = install(tv.fake, catalog, "button", ["movie:m0001"]);
    try {
        await signIn(tv);
        await tv.page.evaluate(() => window.browseHarness.mount());
        await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
        await tv.page.locator('[data-focus="more"]').click();
        const panel = tv.page.getByRole("dialog", { name: "More", exact: true });
        await panel.locator('[data-focus="translate-description"]').click();
        assert.equal(await tv.page.locator(".description-translation-status").textContent(), "Translating…");
        assert.equal(await tv.page.getByRole("dialog", { name: "More", exact: true }).count(), 0, "the menu closes so the synopsis status is visible");
        await tv.eventually(() => Promise.resolve(translation.posts().length === 1), "description translation");
        const post = translation.posts()[0];
        assert.equal(post?.path.split("?")[0], "/catalog/items/movie%3Am0001/translate-description");
        assert.deepEqual(post?.body, { target_language: "de" });
        assert.equal(post?.profile, "p-owner");
        await tv.page.locator('[data-focus="more"]').click();
        assert.equal(await tv.page.locator('[data-focus="translate-description"]').count(), 0, "the action hides while the run is in flight");
        await tv.remote(10009);
        await tv.jump(1000);
        await tv.page.getByText("Translated by AI", { exact: true }).waitFor();
        assert.match(await tv.page.locator(".details-editorial .browse-overview").textContent() ?? "", /Translated overview/);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("automatic Details translation starts with the page and a failed run offers the action again", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeDetails();
    tv.fake.catalog = catalog;
    const translation = install(tv.fake, catalog, "auto", ["movie:m0001"], true);
    try {
        await signIn(tv);
        const held = tv.fake.hold("/catalog/items/movie%3Am0001/translate-description");
        await tv.page.evaluate(() => window.browseHarness.mount());
        await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
        await tv.page.locator(".description-translation-status").waitFor();
        assert.equal(await tv.page.locator(".description-translation-status").textContent(), "Translating…");
        await tv.page.locator('[data-focus="more"]').click();
        assert.equal(await tv.page.locator('[data-focus="translate-description"]').count(), 0, "the action hides while the run is in flight");
        await tv.remote(10009);
        held.release();
        await tv.eventually(() => Promise.resolve(translation.posts().length === 1), "automatic description translation");
        await tv.page.locator('[data-focus="more"]').click();
        await tv.page.locator('[data-focus="translate-description"]').waitFor();
        assert.equal(translation.posts().length, 1, "opening More does not translate again");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("series episode focus does not request a description translation", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeDetails();
    tv.fake.catalog = catalog;
    const translation = install(tv.fake, catalog, "button", ["episode:s1e11", "episode:s1e12"]);
    try {
        await signIn(tv);
        await tv.page.evaluate(() => window.browseHarness.mount());
        await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
        await tv.page.locator('[data-focus="episode:s1e12"]').waitFor();
        const before = translation.posts().length;
        await tv.page.locator('[data-focus="episode:s1e11"]').focus();
        await tv.page.locator('[data-focus="episode:s1e12"]').focus();
        await tv.jump(3000);
        assert.equal(translation.posts().length, before);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("the featured marquee waits 1500ms and other cards never start a translation", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeHome();
    tv.fake.catalog = catalog;
    const translation = install(tv.fake, catalog, "auto", ["movie:m0004"]);
    try {
        await signIn(tv);
        const held = tv.fake.hold("/capabilities/metadata-ai");
        await tv.page.evaluate(() => window.browseHarness.mount());
        await tv.page.locator('[data-view="home"] .skyline-marquee h1').waitFor();
        held.release();
        await tv.jump(0);
        assert.equal(translation.posts().length, 0);
        await tv.jump(1499);
        assert.equal(translation.posts().length, 0, "the dwell has not elapsed");
        await tv.jump(1);
        await tv.eventually(() => Promise.resolve(translation.posts().length === 1), "featured dwell");
        assert.equal(translation.posts()[0]?.path.split("?")[0], "/catalog/items/movie%3Am0004/translate-description");
        await tv.page.locator(".skyline-translation-status").waitFor();
        assert.equal(await tv.page.locator(".skyline-translation-status").textContent(), "Translating…");
        await tv.jump(1000);
        await tv.eventually(async () => await tv.page.locator(".skyline-translation-status").textContent() === "Translated by AI", "landed marquee translation");
        assert.match(await tv.page.locator(".skyline-synopsis").textContent() ?? "", /Translated overview/);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("leaving a featured card before the dwell starts nothing", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeHome();
    tv.fake.catalog = catalog;
    const translation = install(tv.fake, catalog, "auto", ["movie:m0004"]);
    try {
        await signIn(tv);
        await tv.page.evaluate(() => window.browseHarness.mount());
        await tv.page.locator('[data-view="home"] .skyline-marquee h1').waitFor();
        await tv.eventually(() => Promise.resolve(tv.fake.requests.some((request) => request.path.startsWith("/capabilities/metadata-ai"))), "metadata AI capability");
        await tv.page.keyboard.press("ArrowDown");
        assert.notEqual(await tv.focused(), "movie:m0004");
        // The marquee keeps the previous card for its 150 ms rest. That rest has to land,
        // and cancel the featured dwell, before a longer jump can be mistaken for the card holding.
        await tv.jump(200);
        assert.notEqual(await tv.page.locator(".skyline-marquee-layer:not(.skyline-outgoing) h1").innerText(), "Movie 0004");
        assert.equal(translation.posts().length, 0);
        await tv.jump(2000);
        assert.equal(translation.posts().length, 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("an ordinary row never starts a description translation", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeHome();
    tv.fake.catalog = catalog;
    const translation = install(tv.fake, catalog, "auto", ["movie:m0005"]);
    try {
        await signIn(tv);
        await tv.page.evaluate(() => window.browseHarness.mount());
        await tv.page.locator('[data-view="home"] [data-section]').first().waitFor();
        await tv.eventually(() => Promise.resolve(tv.fake.requests.some((request) => request.path.startsWith("/capabilities/metadata-ai"))), "metadata AI capability");
        for (let step = 0; step < 6 && await tv.focused() !== "movie:m0005"; step++) await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "movie:m0005");
        await tv.jump(2000);
        assert.equal(translation.posts().length, 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});
