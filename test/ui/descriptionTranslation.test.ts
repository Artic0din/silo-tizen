import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeCalendar } from "../native/support/fakeCalendar.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeHome } from "../native/support/fakeHome.ts";
import type { CatalogRoutes, FakeSilo, Reply } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, pauseTvClock, type Tv } from "./support/tv.ts";

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
    // The start answer arms the approval poll. Jumping before that answer lands
    // moves a paused clock past the poll, and the wall-clock wait cannot bring it back.
    await tv.eventually(() => tv.page.evaluate(() => {
        const loginPhase = window.browseHarness.loginPhase;
        return loginPhase === "waiting" || loginPhase === "signed_in";
    }), "login code");
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
        // DescriptionTranslationStatusLabel: the translate symbol 6 before the text, 21 medium, pulsing while translating.
        const status = await tv.page.locator(".description-translation-status").evaluate(node => {
            const style = getComputedStyle(node);
            const icon = node.querySelector("svg");
            return { gap: style.columnGap, size: style.fontSize, weight: style.fontWeight, icon: icon !== null && node.firstElementChild === icon, pulse: icon === null ? "" : getComputedStyle(icon).animationName };
        });
        assert.deepEqual(status, { gap: "6px", size: `${Math.round(21 * 0.9685 * 1e4) / 1e4}px`, weight: "500", icon: true, pulse: "details-symbol-pulse" });
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
        assert.equal(await tv.page.locator(".description-translation-status svg").evaluate(icon => getComputedStyle(icon).animationName), "none", "the symbol stops pulsing once translated");
        assert.match(await tv.page.locator(".details-editorial .browse-overview").textContent() ?? "", /Translated overview/);
        await tv.remote(10009);
        await tv.page.route("**/api/v2/**", route => route.abort("connectionrefused"));
        await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
        await tv.jump(35000);
        assert.match(await tv.page.locator(".details-editorial .browse-overview").textContent() ?? "", /Translated overview/);
        assert.equal(await tv.page.getByText("Translated by AI", { exact: true }).count(), 1);
        assert.equal(translation.posts().length, 1, "an offline revisit retains the completed readback without another write");
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

test("a title without a synopsis shows no translation status, as TVDetailHero draws it inside the synopsis", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeDetails();
    tv.fake.catalog = catalog;
    install(tv.fake, catalog, "auto", ["movie:m0001"], true);
    try {
        await signIn(tv);
        const body = catalog.route("GET", "/catalog/items/movie%3Am0001", "p-owner")?.body;
        assert.ok(body && typeof body === "object");
        await tv.page.route("**/api/v2/catalog/items/movie%3Am0001?**", route => route.fulfill({ json: { ...body, overview: "" } }));
        const held = tv.fake.hold("/catalog/items/movie%3Am0001/translate-description");
        await tv.page.evaluate(() => window.browseHarness.mount());
        await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
        await tv.page.locator('[data-view="item:movie:m0001"] .details-hero').waitFor();
        await tv.jump(500);
        assert.equal(await tv.page.locator(".details-editorial .browse-overview").count(), 0);
        assert.equal(await tv.page.locator(".description-translation-status").count(), 0);
        held.release();
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("fresh metadata starts automatic translation on a cached Details owner", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeDetails(); tv.fake.catalog = catalog;
    const pending: string[] = [];
    const translation = install(tv.fake, catalog, "auto", pending);
    try {
        await signIn(tv);
        await tv.page.evaluate(() => window.browseHarness.mount());
        const card = tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first();
        await card.click();
        await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
        await tv.remote(10009);
        pending.push("movie:m0001");
        const held = tv.fake.hold("/catalog/items/movie%3Am0001", true);
        await card.click();
        await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
        await tv.jump(0);
        assert.equal(translation.posts().length, 0);
        held.release();
        await tv.eventually(() => Promise.resolve(translation.posts().length === 1), "fresh cached-owner translation target");
    } finally { await tv.page.context().close(); }
});

for (const mode of ["button", "auto"] as const) test(`series episode focus does not request a description translation in ${mode} mode`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeDetails();
    tv.fake.catalog = catalog;
    const translation = install(tv.fake, catalog, mode, ["episode:s1e11", "episode:s1e12", "episode:s1e21", "episode:s1e22"]);
    try {
        await signIn(tv);
        await tv.page.evaluate(() => window.browseHarness.mount());
        await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
        await tv.page.locator('[data-focus="episode:s1e22"]').waitFor();
        if (mode === "auto") await tv.eventually(() => Promise.resolve(translation.posts().length === 1), "initial selected season translation");
        const before = translation.posts().length;
        await tv.page.locator('[data-focus="episode:s1e11"]').focus();
        await tv.page.locator('[data-focus="episode:s1e12"]').focus();
        await tv.page.locator('[data-focus="episode:s1e21"]').focus();
        await tv.page.locator('[data-focus="episode:s1e22"]').focus();
        await tv.jump(3000);
        assert.equal(translation.posts().length, before);
        if (mode === "auto") {
            await tv.page.locator('[data-focus="season:1"]').click();
            await tv.eventually(() => Promise.resolve(translation.posts().length === before + 1), "returning explicitly can resume the interrupted season translation");
            await tv.page.locator('[data-focus="season:2"]').click();
            await tv.eventually(() => Promise.resolve(translation.posts().length === before + 2), "explicit season activation still translates automatically");
        }
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const leave of [false, true]) test(leave ? "leaving a featured card at 1499ms cancels its dwell immediately" : "the featured marquee waits 1500ms and other cards never start a translation", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeHome();
    tv.fake.catalog = catalog;
    const translation = install(tv.fake, catalog, "auto", ["movie:m0004"]);
    try {
        await pauseTvClock(tv);
        const held = tv.fake.hold("/capabilities/metadata-ai");
        await signIn(tv);
        await tv.page.evaluate(() => window.browseHarness.mount());
        await tv.page.locator('[data-view="home"] .skyline-marquee h1').waitFor();
        const capability = tv.page.waitForResponse(response => response.url().includes('/capabilities/metadata-ai'));
        held.release();
        await (await capability).finished();
        await tv.jump(0);
        assert.equal(translation.posts().length, 0);
        await tv.jump(1499);
        assert.equal(translation.posts().length, 0, "the dwell has not elapsed");
        if (leave) {
            await tv.remote(40);
            assert.notEqual(await tv.focused(), "movie:m0004");
            await tv.jump(1);
            assert.equal(translation.posts().length, 0, "leaving cancels before the delayed preview applies");
            await tv.jump(149);
            await tv.jump(2000);
            assert.equal(translation.posts().length, 0, "ordinary cards never translate");
            assert.deepEqual(tv.console, []);
            return;
        }
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
        await pauseTvClock(tv);
        const held = tv.fake.hold("/capabilities/metadata-ai");
        await signIn(tv);
        await tv.page.evaluate(() => window.browseHarness.mount());
        await tv.page.locator('[data-view="home"] .skyline-marquee h1').waitFor();
        const capability = tv.page.waitForResponse(response => response.url().includes("/capabilities/metadata-ai"));
        held.release();
        await (await capability).finished();
        await tv.jump(0);
        await tv.remote(40);
        assert.notEqual(await tv.focused(), "movie:m0004");
        // The marquee keeps the previous card for its 150 ms rest. That rest has to land,
        // and cancel the featured dwell, before a longer jump can be mistaken for the card holding.
        await tv.jump(150);
        assert.notEqual(await tv.page.locator(".skyline-marquee-layer:not(.skyline-outgoing) h1").innerText(), "Movie 0004");
        assert.equal(translation.posts().length, 0);
        await tv.jump(2000);
        assert.equal(translation.posts().length, 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a replaced marquee keeps the new card's translation on the incoming layer", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeHome();
    tv.fake.catalog = catalog;
    install(tv.fake, catalog, "auto", ["movie:m0004"]);
    try {
        await pauseTvClock(tv);
        await signIn(tv);
        await tv.page.evaluate(() => window.browseHarness.mount());
        await tv.page.locator('[data-view="home"] .skyline-marquee h1').waitFor();
        await tv.eventually(() => Promise.resolve(tv.fake.requests.some((request) => request.path.startsWith("/capabilities/metadata-ai"))), "metadata AI capability");
        await tv.jump(1500);
        await tv.page.locator(".skyline-translation-status").waitFor();
        await tv.jump(1000);
        await tv.eventually(async () => await tv.page.locator(".skyline-synopsis").textContent() === "Translated overview", "landed marquee translation");
        await tv.page.locator('[data-view="home"] [data-section="recent/12"] .browse-card').first().focus();
        await tv.jump(200);
        await tv.page.locator('[data-section="hero/opaque"] [data-focus="movie:m0004"]').focus();
        await tv.jump(200);
        const crossing = await marqueeLayers(tv);
        assert.equal(crossing.incoming?.title, "Movie 0004");
        assert.equal(crossing.incoming?.synopsis, "Translated overview");
        assert.equal(crossing.incoming?.status, "Translated by AI");
        // Apple's foreground has no transition (TVFocusMarquee.swift:1262-1264): the previous card's text is already gone.
        assert.equal(crossing.outgoing, null);
        await tv.jump(300);
        const settled = await marqueeLayers(tv);
        assert.equal(settled.outgoing, null);
        assert.equal(settled.incoming?.synopsis, "Translated overview");
        assert.equal(settled.incoming?.status, "Translated by AI");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("returning from Settings rearms a featured dwell that hide cancelled", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeHome();
    tv.fake.catalog = catalog;
    const translation = install(tv.fake, catalog, "auto", ["movie:m0004"]);
    try {
        await pauseTvClock(tv);
        await signIn(tv);
        await tv.page.evaluate(() => window.browseHarness.mount());
        await tv.page.locator('[data-view="home"] .skyline-marquee h1').waitFor();
        await tv.eventually(() => Promise.resolve(tv.fake.requests.some((request) => request.path.startsWith("/capabilities/metadata-ai"))), "metadata AI capability");
        await tv.jump(0);
        assert.equal(translation.posts().length, 0);
        await openSettings(tv);
        await tv.jump(2000);
        assert.equal(translation.posts().length, 0, "Settings cancels the dwell");
        await leaveSettings(tv);
        await tv.page.locator('[data-view="home"] .skyline-marquee h1').waitFor();
        assert.equal(translation.posts().length, 0);
        await tv.jump(1499);
        assert.equal(translation.posts().length, 0, "the restored card waits out its dwell again");
        await tv.jump(1);
        await tv.eventually(() => Promise.resolve(translation.posts().length === 1), "restored featured dwell");
        assert.equal(translation.posts()[0]?.path.split("?")[0], "/catalog/items/movie%3Am0004/translate-description");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("leaving the marquee cancels the dwell and a late capability does not start it", async () => {
    const departed = await openTv(browser, { app: "browse" });
    const departedCatalog = new FakeHome();
    departed.fake.catalog = departedCatalog;
    const departedTranslation = install(departed.fake, departedCatalog, "auto", ["movie:m0004"]);
    serveCalendar(departedCatalog);
    try {
        await signIn(departed);
        await departed.page.evaluate(() => window.browseHarness.mount());
        await departed.page.locator('[data-view="home"] .skyline-marquee h1').waitFor();
        await departed.eventually(() => Promise.resolve(departed.fake.requests.some((request) => request.path.startsWith("/capabilities/metadata-ai"))), "metadata AI capability");
        await departed.jump(0);
        await openCalendar(departed);
        await departed.jump(2000);
        assert.equal(departedTranslation.posts().length, 0, "Calendar removes the marquee before the dwell");
        assert.deepEqual(departed.console, []);
    } finally { await departed.page.context().close(); }

    const delayed = await openTv(browser, { app: "browse" });
    const delayedCatalog = new FakeHome();
    delayed.fake.catalog = delayedCatalog;
    const delayedTranslation = install(delayed.fake, delayedCatalog, "auto", ["movie:m0004"]);
    try {
        await signIn(delayed);
        const held = delayed.fake.hold("/capabilities/metadata-ai");
        await delayed.page.evaluate(() => window.browseHarness.mount());
        await delayed.page.locator('[data-view="home"] .skyline-marquee h1').waitFor();
        await openSettings(delayed);
        held.release();
        await delayed.jump(0);
        await delayed.eventually(() => Promise.resolve(delayed.fake.requests.some((request) => request.path.startsWith("/capabilities/metadata-ai"))), "metadata AI capability");
        await delayed.jump(2000);
        assert.equal(delayedTranslation.posts().length, 0, "a capability answer after Settings must not start a hidden card");
        assert.deepEqual(delayed.console, []);
    } finally { await delayed.page.context().close(); }
});

async function marqueeLayers(tv: Tv): Promise<{ incoming: { title: string; synopsis: string; status: string } | null; outgoing: { title: string; synopsis: string; status: string } | null }> {
    return tv.page.locator(".skyline-marquee").evaluate((marquee) => {
        const read = (layer: Element | null): { title: string; synopsis: string; status: string } | null => layer === null ? null : {
            title: layer.querySelector("h1")?.textContent ?? "",
            synopsis: layer.querySelector(".skyline-synopsis")?.textContent ?? "",
            status: layer.querySelector(".skyline-translation-status")?.textContent ?? "",
        };
        return {
            incoming: read(marquee.querySelector(".skyline-marquee-layer:not(.skyline-outgoing)")),
            outgoing: read([...marquee.querySelectorAll(".skyline-marquee-layer.skyline-outgoing")].at(-1) ?? null),
        };
    });
}

async function openSettings(tv: Tv): Promise<void> {
    await tv.page.locator('[data-focus="profiles"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await tv.page.locator(".settings").waitFor();
}

async function leaveSettings(tv: Tv): Promise<void> {
    for (let step = 0; step < 4 && await tv.page.locator(".settings").count() > 0; step++) await tv.remote(10009);
    assert.equal(await tv.page.locator(".settings").count(), 0);
}

function serveCalendar(catalog: FakeHome): void {
    const calendar = new FakeCalendar();
    const read = catalog.route.bind(catalog);
    catalog.route = (method: string, path: string, profileId: string | undefined, body?: Record<string, unknown>): ReturnType<FakeHome["route"]> => path.startsWith("/calendar") ? calendar.route(method, path, profileId, body) : read(method, path, profileId, body);
}

async function openCalendar(tv: Tv): Promise<void> {
    await tv.page.locator('[data-focus="calendar"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await tv.page.locator('.browse[data-view="calendar"]').count() === 1, "Calendar");
}

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
