import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser, CDPSession } from "playwright";
import { FakeCalendar } from "../native/support/fakeCalendar.ts";
import { fixture, problem } from "../native/support/fakeSilo.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { HIDDEN_KEY } from "../../src/contracts/v2/settings.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
const timezoneSessions = new WeakMap<Tv, CDPSession>();
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

async function start(tv: Tv, catalog = new FakeCalendar()): Promise<FakeCalendar> {
    tv.fake.catalog = catalog;
    const cdp = await tv.page.context().newCDPSession(tv.page);
    timezoneSessions.set(tv, cdp);
    await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "Australia/Melbourne" });
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "sign-in");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.eventually(async () => await tv.page.locator('.browse[data-view="home"] .browse-card').count() > 0, "Home");
    return catalog;
}

test("Calendar root opens a weekly catalog journey by remote", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        if (process.env.CALENDAR_BASELINE) await tv.page.screenshot({ path: process.env.CALENDAR_BASELINE });
        assert.equal(await tv.page.locator('.browse-nav [data-focus="calendar"]').count(), 1, "Skyline exposes the Calendar root destination");
        await tv.page.locator('[data-focus="calendar"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => await tv.page.locator('.browse[data-view="calendar"]').count() === 1, "Calendar root");
        assert.equal(tv.fake.requests.filter(r => r.path.startsWith("/calendar?")).length, 1, "one weekly read");
        assert.equal(await tv.page.locator(".calendar-day").count(), 7, "Monday through Sunday");
    } finally { await tv.page.context().close(); }
});

async function activate(tv: Tv, key: string): Promise<void> {
    await tv.page.locator(".browse").locator("[data-focus]").evaluateAll((nodes, key) => {
        const node = nodes.find(node => node.getAttribute("data-focus") === key);
        if (!(node instanceof HTMLElement)) throw new Error(`Missing target ${key}`);
        node.focus({ preventScroll: true });
    }, key);
    await tv.page.keyboard.press("Enter");
}
const reads = (tv: Tv) => tv.fake.requests.filter(request => request.path.startsWith("/calendar?"));
async function ready(tv: Tv, count?: number): Promise<void> {
    await tv.eventually(async () => await tv.page.locator('.browse[data-view="calendar"]').count() === 1 && await tv.page.getByText("Loading the week.", { exact: true }).count() === 0 && (count === undefined || await tv.page.locator(".calendar-event").count() === count), "loaded Calendar");
}
function calendarTest(name: string, body: (tv: Tv, catalog: FakeCalendar) => Promise<void>): void {
    test(name, async () => {
        const tv = await openTv(browser, { app: "browse", ...(process.env.CALENDAR_VIDEO && name.startsWith("Calendar complete") ? { video: process.env.CALENDAR_VIDEO } : {}) });
        try {
            const catalog = await start(tv);
            await body(tv, catalog);
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}

calendarTest("Calendar complete remote journey retains every event and restores exact scroll and context", async (tv) => {
    if (process.env.CALENDAR_CAPTURE) await tv.page.screenshot({ path: `${process.env.CALENDAR_CAPTURE}/after-home.png` });
    await activate(tv, "calendar"); await ready(tv, 3);
    assert.equal(new URL(reads(tv)[0]?.path ?? "", "https://fake.invalid").searchParams.get("filter"), "following");
    assert.match(reads(tv)[0]?.path ?? "", /timezone=Australia%2FMelbourne/);
    await activate(tv, "filter:everything"); await ready(tv, 32);
    const before = reads(tv).length;
    await activate(tv, "day:2025-12-29");
    for (let i = 0; i < 29; i++) await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.page.locator(":focus").getAttribute("data-content-id"), "movie:m0030", "event 30 is reachable without continuation");
    await tv.page.clock.runFor(260);
    const position = () => tv.page.locator(".browse").evaluate(node => ({ top: node.querySelector(".skyline-content")?.scrollTop, left: node.querySelector('[data-section="2025-12-29"] .browse-row')?.scrollLeft }));
    const saved = await position(); assert.ok((saved.left ?? 0) > 0);
    const origin = await tv.focused();
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await tv.page.locator('.browse[data-view="item:movie:m0030"]').count() === 1, "movie Details");
    await tv.remote(10009); await ready(tv, 32); await tv.page.clock.runFor(260);
    assert.equal(await tv.focused(), origin); assert.deepEqual(await position(), saved);
    await activate(tv, "day:2025-12-30");
    assert.equal(await tv.page.locator(":focus").getAttribute("data-content-id"), "episode:s1e22", "empty day chooses the next populated day");
    await tv.page.clock.runFor(260);
    const episodeScroll = await position(); assert.ok((episodeScroll.top ?? 0) > 0);
    if (process.env.CALENDAR_CAPTURE) { await tv.page.clock.runFor(260); await tv.page.screenshot({ path: `${process.env.CALENDAR_CAPTURE}/after-calendar.png` }); }
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await tv.focused() === "season:2", "Calendar focuses the relevant series season");
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await tv.focused() === "episode:s1e22", "Calendar focuses the relevant episode");
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await tv.page.locator('.browse[data-view="item:episode:s1e22"]').count() === 1, "episode Details");
    await activate(tv, "play");
    assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.slice(-1)[0]?.contentId), "episode:s1e22");
    await tv.page.evaluate(() => window.browseHarness.resume());
    await tv.remote(10009); await tv.eventually(async () => await tv.focused() === "episode:s1e22", "episode return");
    await tv.remote(10009); await tv.eventually(async () => await tv.focused() === "season:2", "season return");
    await tv.remote(10009); await ready(tv, 32);
    await tv.page.clock.runFor(260); assert.deepEqual(await position(), episodeScroll, "vertical and shelf scroll survive Details and playback");
    assert.equal(await tv.page.locator(":focus").getAttribute("data-content-id"), "episode:s1e22");
    const afterReturn = reads(tv).length;
    for (const key of ["ArrowUp", "ArrowUp", "ArrowUp", "ArrowLeft", "ArrowRight"]) await tv.page.keyboard.press(key);
    assert.equal(reads(tv).length, afterReturn, "focus movement performs no reads");
    assert.ok(afterReturn > before, "playback invalidates the current window");
    await tv.remote(10009); assert.equal(await tv.focused(), "calendar");
    await tv.remote(10009); assert.equal(await tv.page.locator('.browse[data-view="home"]').count(), 1);
    await activate(tv, "calendar"); await ready(tv, 32);
    assert.equal(await tv.page.locator('[data-focus="filter:everything"]').getAttribute("aria-pressed"), "true", "filter survives root/session return");
});

calendarTest("Calendar filters, empty weeks, Today, loading, decode failure and generic 404 recover", async (tv, catalog) => {
    const held = tv.fake.hold("/calendar", true);
    await activate(tv, "calendar");
    await tv.page.getByText("Loading the week.", { exact: true }).waitFor();
    assert.equal(await tv.page.locator('[data-focus="retry"]').count(), 1); assert.equal(await tv.page.locator('[data-focus="back"]').count(), 1);
    await activate(tv, "filter:trending"); await ready(tv, 2);
    held.release(); await tv.jump(0); assert.equal(await tv.page.locator(".calendar-event").count(), 2);
    await activate(tv, "next-week"); await ready(tv, 0);
    assert.equal(await tv.page.locator(".calendar-day").count(), 7); assert.equal(await tv.page.locator(".calendar-shelf").count(), 7);
    await tv.page.getByText("No releases or episodes this week. Try another filter.").waitFor();
    const noReads = reads(tv).length;
    await activate(tv, "day:2026-01-06"); assert.equal(await tv.focused(), "day:2026-01-06"); assert.equal(reads(tv).length, noReads);
    await activate(tv, "today"); await ready(tv, 2);
    assert.equal(await tv.page.locator('[data-focus="today"]').count(), 0);
    catalog.calendarFailure = problem(404, "not_found", "Not found");
    await activate(tv, "filter:everything");
    await tv.page.getByText("Could not load Calendar. Try again.").waitFor();
    assert.equal(await tv.page.getByText(/unsupported/i).count(), 0);
    catalog.calendarFailure = { status: 200, body: { events: null } };
    await activate(tv, "retry"); await tv.page.getByText("The server sent an answer this TV could not read.").waitFor();
    catalog.calendarFailure = undefined;
    await activate(tv, "retry"); await ready(tv, 32);
    assert.deepEqual(reads(tv).map(r => new URL(r.path, "https://fake.invalid").searchParams.get("filter")).slice(0, 3), ["following", "trending", "trending"]);
});

calendarTest("Calendar held week, filter and timezone replies cannot publish stale data or take menu focus", async (tv) => {
    await activate(tv, "calendar"); await ready(tv, 3);
    const weekA = tv.fake.hold("/calendar", true);
    await activate(tv, "next-week");
    await tv.eventually(async () => reads(tv).length === 2, "held next week");
    await activate(tv, "previous-week"); await ready(tv, 3);
    weekA.release(); await tv.jump(0); assert.equal(await tv.page.locator(".calendar-event").count(), 3);
    const filterA = tv.fake.hold("/calendar", true);
    await activate(tv, "filter:everything");
    await tv.eventually(async () => reads(tv).length === 4, "held filter");
    await activate(tv, "filter:trending"); await ready(tv, 2);
    filterA.release(); await tv.jump(0); assert.equal(await tv.page.locator(".calendar-event").count(), 2);
    const zoneA = tv.fake.hold("/calendar", true);
    await activate(tv, "filter:everything");
    await tv.eventually(async () => reads(tv).length === 6, "held zone");
    const cdp = timezoneSessions.get(tv); assert.ok(cdp);
    await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "Pacific/Kiritimati" });
    await tv.page.locator('[data-focus="profiles"]').focus(); await tv.jump(300);
    await tv.page.keyboard.press("ArrowDown");
    const focus = await tv.focused(); zoneA.release(); await ready(tv, 32); await tv.jump(0);
    assert.equal(await tv.focused(), focus, "late zone reload preserves the profile menu focus");
    assert.equal(new URL(reads(tv).slice(-1)[0]?.path ?? "", "https://fake.invalid").searchParams.get("timezone"), "Pacific/Kiritimati");
    assert.equal(reads(tv).length, 7, "the old-zone response triggers one replacement query");
});

calendarTest("Calendar authority cancellation, PIN proof and server library restrictions stay coherent", async (tv, catalog) => {
    const held = tv.fake.hold("/calendar", true); await activate(tv, "calendar");
    await tv.eventually(async () => reads(tv).length === 1, "held profile query");
    await tv.page.evaluate(() => window.browseHarness.clearProfile());
    held.release(); await tv.jump(0);
    assert.equal(await tv.page.locator(".browse").count(), 0);
    assert.equal(await tv.page.evaluate(() => window.browseHarness.selectProfile("p-kid", "2468")), "verified");
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.eventually(async () => await tv.page.locator('.browse[data-view="home"] .browse-card').count() > 0, "child Home");
    await activate(tv, "calendar"); await ready(tv, 0);
    await activate(tv, "filter:everything"); await ready(tv, 1);
    assert.equal(await tv.page.locator(".calendar-event").getAttribute("data-content-id"), "movie:k1");
    assert.ok(reads(tv).slice(1).every(read => read.headers["x-profile-id"] === "p-kid" && read.headers["x-profile-token"]?.startsWith("pvt-")));
    await tv.page.evaluate(() => window.browseHarness.logout());
    assert.equal(await tv.page.locator(".calendar-event").count(), 0);
    assert.equal(catalog.households.get("p-owner")?.hidden?.includes(15), true);
});

calendarTest("Calendar metadata-only and missing targets retain safe Details and unknown events stay truthful", async (tv, catalog) => {
    catalog.events.push({ content_id: "movie:m0002", type: "new_kind", title: "New event type", air_date: "2026-01-04", local_air_date: "2026-01-04", watched: false, badges: ["future_badge"] });
    await activate(tv, "calendar"); await ready(tv, 3); await activate(tv, "filter:everything"); await ready(tv, 33);
    await activate(tv, "day:2026-01-04");
    assert.equal(await tv.page.locator(":focus").getAttribute("aria-disabled"), "true");
    const count = tv.fake.requests.length; await tv.page.keyboard.press("Enter"); assert.equal(tv.fake.requests.length, count);
    catalog.failNext("/catalog/items/movie%3Am0002", { status: 200, body: { ...fixture("get_catalog_item_ok"), content_id: "movie:m0002", versions: [] } });
    await tv.page.locator('.calendar-event[data-content-id="movie:m0002"]').first().focus(); await tv.page.keyboard.press("Enter");
    await tv.page.getByText("This title has no file this TV can play.").waitFor();
    assert.equal(await tv.page.locator('[data-focus="play"]').count(), 0);
    await tv.remote(10009); await ready(tv, 33);
    catalog.removed.add("movie:m0003");
    await tv.page.locator('.calendar-event[data-content-id="movie:m0003"]').focus(); await tv.page.keyboard.press("Enter");
    await tv.page.getByText("This title is no longer available.").waitFor();
    await activate(tv, "back"); await ready(tv, 33);
    assert.equal(await tv.page.locator(":focus").getAttribute("data-content-id"), "movie:m0003");
});

calendarTest("Calendar return revalidates mutations and preserves nearby identity when the origin disappears", async (tv, catalog) => {
    await activate(tv, "calendar"); await ready(tv, 3);
    await activate(tv, "day:2025-12-29"); await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await tv.page.locator('[data-focus="watched"]').count() === 1, "personal actions");
    await tv.page.getByText("Loading personal actions.", { exact: true }).waitFor({ state: "hidden" });
    await tv.page.getByText("Loading related titles.", { exact: true }).waitFor({ state: "hidden" });
    await activate(tv, "watched");
    await tv.eventually(async () => catalog.watched, "watched mutation");
    await tv.remote(10009); await ready(tv, 3);
    assert.match(await tv.page.locator('.calendar-event[data-content-id="movie:m0001"]').textContent() ?? "", /Watched/);
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await tv.page.locator('.browse[data-view="item:movie:m0001"]').count() === 1, "details again");
    catalog.events = catalog.events.filter(event => event.content_id !== "movie:m0001");
    await tv.remote(10009); await ready(tv, 2);
    assert.equal(await tv.page.locator(":focus").getAttribute("data-content-id"), "episode:s1e22", "removed day falls to the next populated shelf");
});

calendarTest("Calendar timezone discovery and formatting failures are recoverable without assuming UTC", async (tv) => {
    await tv.page.evaluate(() => {
        const original = Intl.DateTimeFormat;
        Object.defineProperty(window, "restoreCalendarIntl", { configurable: true, value: () => { Intl.DateTimeFormat = original; } });
        Object.defineProperty(Intl, "DateTimeFormat", { configurable: true, value: function () { throw new Error("timezone unavailable"); } });
    });
    await activate(tv, "calendar");
    await tv.page.getByText(/Could not read this TV’s timezone/).waitFor();
    assert.equal(reads(tv).length, 0, "no implicit UTC request");
    await tv.page.evaluate(() => { const restore = Reflect.get(window, "restoreCalendarIntl") as () => void; restore(); });
    await activate(tv, "retry"); await ready(tv, 3);
    await tv.page.evaluate(() => {
        const original = Intl.DateTimeFormat;
        Object.defineProperty(window, "restoreCalendarIntl", { configurable: true, value: () => { Intl.DateTimeFormat = original; } });
        Object.defineProperty(Intl, "DateTimeFormat", { configurable: true, value: function (locale?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
            if (locale === undefined && options?.weekday !== undefined) throw new RangeError("format unavailable");
            return new original(locale, options);
        } });
    });
    await activate(tv, "filter:trending");
    await tv.page.getByText("Could not format this TV’s dates. Try again.").waitFor();
    await tv.jump(0);
    assert.equal(await tv.page.locator('[data-focus="retry"]').count(), 1);
    await tv.page.evaluate(() => { const restore = Reflect.get(window, "restoreCalendarIntl") as () => void; restore(); });
    await activate(tv, "retry"); await ready(tv, 2);
});

calendarTest("Calendar failed revalidation retains only the current window with an explicit error and Retry", async (tv, catalog) => {
    await activate(tv, "calendar"); await ready(tv, 3);
    await activate(tv, "day:2025-12-29"); await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await tv.page.locator('.browse[data-view="item:movie:m0001"]').count() === 1, "Details");
    catalog.calendarFailure = problem(503, "service_unavailable", "Unavailable", { "Retry-After": "30" });
    await tv.remote(10009); await tv.jump(1000);
    await tv.page.getByText("The server had a problem. Try again in a moment.").waitFor();
    assert.equal(await tv.page.locator(".calendar-event").count(), 3);
    assert.equal(await tv.page.locator(":focus").getAttribute("data-content-id"), "movie:m0001");
    catalog.calendarFailure = undefined; await activate(tv, "retry"); await ready(tv, 3);
    assert.equal(await tv.page.getByRole("alert").count(), 0);
    await activate(tv, "next-week"); await ready(tv, 0);
    assert.equal(await tv.page.locator(".calendar-event").count(), 0, "no previous-window cache leaks into an empty week");
});

calendarTest("Calendar Settings hidden-library return reuses current route and coherent multi-library access", async (tv, catalog) => {
    const settings = new FakeSettings(tv.fake);
    settings.profile().set(HIDDEN_KEY, [15]);
    const routes = tv.fake.catalog; assert.ok(routes);
    tv.fake.catalog = { route: (method, path, profile, body) => {
        const household = catalog.households.get(profile ?? "");
        const hidden = settings.profile(profile).get(HIDDEN_KEY);
        if (household !== undefined && (hidden === null || Array.isArray(hidden))) household.hidden = hidden as number[] | null;
        return routes.route(method, path, profile, body);
    } };
    await activate(tv, "calendar"); await ready(tv, 3); await activate(tv, "filter:everything"); await ready(tv, 32);
    assert.equal(await tv.page.locator('.calendar-event[data-content-id="movie:archived"]').count(), 0);
    await activate(tv, "profiles"); await activate(tv, "settings");
    await tv.page.locator('[data-focus="hidden"]').click();
    await tv.page.locator('[data-focus="library:12"]').click();
    await tv.eventually(async () => JSON.stringify(settings.profile().get(HIDDEN_KEY)) === "[15,12]", "hidden library write");
    await tv.page.getByText("Saving…", { exact: true }).waitFor({ state: "hidden" });
    await tv.remote(10009); await tv.remote(10009); await tv.remote(10009); await ready(tv, 2);
    assert.equal(await tv.page.locator('[data-focus="filter:everything"]').getAttribute("aria-pressed"), "true");
    assert.ok((await tv.page.locator(".calendar-event").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-content-id")))).every(id => id?.startsWith("episode:") || id?.startsWith("season:")));
    assert.equal(await tv.focused(), "profiles", "Settings origin remains selected while revalidating");
    assert.equal(await tv.page.locator('.browse-nav [data-focus="movies"]').count(), 0, "hidden-library refresh also updates existing Skyline scopes");
});

calendarTest("Calendar premiere, episode context fallback, badges and distinct events retain server identity", async (tv, catalog) => {
    const episode = catalog.events.find(event => event.content_id === "episode:s1e22"); assert.ok(episode);
    catalog.events.push({ ...episode, air_at: "2026-01-01T22:00:00Z", badges: ["series_premiere", "toString"] });
    await activate(tv, "calendar"); await ready(tv, 4);
    const episodes = tv.page.locator('.calendar-event[data-content-id="episode:s1e22"]');
    assert.equal(await episodes.count(), 2);
    assert.notEqual(await episodes.nth(0).getAttribute("data-focus"), await episodes.nth(1).getAttribute("data-focus"));
    assert.match(await episodes.nth(0).textContent() ?? "", /S2:E2.*The Crossing.*08:00.*Finale/);
    assert.match(await episodes.nth(1).textContent() ?? "", /09:00.*Premiere/);
    assert.doesNotMatch(await episodes.nth(1).textContent() ?? "", /function/);
    await tv.page.locator('.calendar-event[data-content-id="season:s1:2"]').focus(); await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await tv.focused() === "season:2", "premiere season focus");
    await tv.page.keyboard.press("Enter"); await tv.eventually(async () => await tv.focused() === "episode:s1e21", "premiere episode list");
    await tv.remote(10009); await tv.remote(10009); await ready(tv, 4);
    catalog.events = catalog.events.map(event => event.type === "episode" ? { ...event, season_number: undefined } : event).map(event => {
        const { season_number, ...rest } = event;
        return season_number === undefined ? rest : { ...rest, season_number };
    });
    await activate(tv, "filter:trending"); await ready(tv, 3);
    await tv.page.locator('.calendar-event[data-content-id="episode:s1e22"]').first().focus(); await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await tv.focused() === "season:2", "missing season number resolved through existing item detail");
    await tv.page.keyboard.press("Enter"); await tv.eventually(async () => await tv.focused() === "episode:s1e22", "resolved episode focus");
});

calendarTest("Calendar loading status leaves the origin shelf geometry unchanged on return", async (tv) => {
    await activate(tv, "calendar"); await ready(tv, 3); await activate(tv, "day:2025-12-29");
    const shelfTop = () => tv.page.locator('.browse [data-section="2025-12-29"]').evaluate(node => node.getBoundingClientRect().top + (node.closest(".skyline-content")?.scrollTop ?? 0));
    const before = await shelfTop(); await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await tv.page.locator('.browse[data-view="item:movie:m0001"]').count() === 1, "Details");
    const held = tv.fake.hold("/calendar", true); await tv.remote(10009);
    await tv.page.getByText("Loading the week.", { exact: true }).waitFor();
    assert.equal(await shelfTop(), before, "a refresh status must not move event shelves above restored focus");
    held.release();
});

calendarTest("S-C1 Calendar updates Today across local midnight and a week boundary without moving the viewer", async (tv) => {
    await activate(tv, "calendar"); await ready(tv, 3);
    await activate(tv, "filter:everything"); await ready(tv, 32);
    await activate(tv, "day:2025-12-29");
    for (let index = 0; index < 29; index++) await tv.page.keyboard.press("ArrowRight");
    await tv.page.clock.runFor(260);
    const origin = await tv.focused();
    const position = () => tv.page.locator(".browse").evaluate(node => ({ top: node.querySelector(".skyline-content")?.scrollTop, left: node.querySelector('[data-section="2025-12-29"] .browse-row')?.scrollLeft }));
    const saved = await position(), count = reads(tv).length;
    assert.ok((saved.left ?? 0) > 0);
    assert.equal(await tv.page.locator('.calendar-day[aria-current="date"]').getAttribute("data-focus"), "day:2026-01-02");
    for (const day of [3, 5]) {
        await tv.jump(await tv.page.evaluate(day => new Date(2026, 0, day).getTime() - Date.now(), day));
        await tv.page.clock.runFor(260);
        const today = tv.page.locator('.calendar-day[aria-current="date"]');
        assert.equal(await today.count(), day === 3 ? 1 : 0);
        if (day === 3) assert.equal(await today.getAttribute("data-focus"), "day:2026-01-03");
        assert.equal(await tv.page.locator('[data-focus="today"]').count(), day === 3 ? 0 : 1);
        assert.equal(await tv.page.locator(".calendar-day").first().getAttribute("data-focus"), "day:2025-12-29");
        assert.equal(await tv.focused(), origin);
        assert.deepEqual(await position(), saved);
        assert.equal(reads(tv).length, count, "day rollover redraws the existing window without a read");
    }
});

async function homeDetails(tv: Tv, id = "movie:m0001"): Promise<void> {
    await activate(tv, "home");
    await tv.page.locator(`[data-section="recently_added"] [data-focus="${id}"]`).focus();
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await tv.page.locator(`.browse[data-view="item:${id}"]`).count() === 1
        && await tv.page.locator('[data-focus="watched"]').count() === 1
        && await tv.page.getByText("Loading personal actions.", { exact: true }).count() === 0
        && await tv.page.getByText("Loading related titles.", { exact: true }).count() === 0, "Home item Details");
}

calendarTest("S-C2 Calendar re-entry refreshes watched changes made through Home", async (tv, catalog) => {
    await activate(tv, "calendar"); await ready(tv, 3);
    assert.equal(reads(tv).length, 1);
    await homeDetails(tv);
    await activate(tv, "watched");
    await tv.eventually(async () => catalog.watched && await tv.page.getByRole("button", { name: "Mark unwatched", exact: true }).count() === 1, "confirmed watched state");
    await tv.remote(10009);
    await activate(tv, "calendar"); await ready(tv, 3);
    assert.equal(reads(tv).length, 2);
    assert.match(await tv.page.locator('.calendar-event[data-content-id="movie:m0001"]').textContent() ?? "", /Watched/);
});

for (const [action, id, expected] of [["favorites", "movie:m0001", 2], ["watchlist", "series:s1", 1]] as const) {
    calendarTest(`S-C2 Calendar Following re-entry refreshes ${action} changes through Home`, async (tv, catalog) => {
        if (action === "favorites") catalog.progress.delete(id);
        await activate(tv, "calendar"); await ready(tv, 3);
        await homeDetails(tv, id);
        await tv.page.getByRole("button", { name: action === "favorites" ? "Remove favorite" : "Remove from watchlist", exact: true }).waitFor();
        await activate(tv, action);
        await tv.eventually(async () => !(action === "favorites" ? catalog.favoriteIds : catalog.watchlistIds).has(id) && await tv.page.getByRole("button", { name: action === "favorites" ? "Add favorite" : "Add to watchlist", exact: true }).count() === 1, "confirmed membership removal");
        await tv.remote(10009);
        await activate(tv, "calendar"); await ready(tv);
        assert.equal(reads(tv).length, 2);
        assert.equal(await tv.page.locator(".calendar-event").count(), expected);
    });
}

calendarTest("S-C2 Calendar re-entry refreshes playback completed through Home", async (tv, catalog) => {
    await activate(tv, "calendar"); await ready(tv, 3);
    await homeDetails(tv);
    await activate(tv, "play");
    assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 1);
    catalog.watched = true;
    await tv.page.evaluate(() => window.browseHarness.resume());
    await tv.eventually(async () => await tv.page.locator('.browse[data-view="item:movie:m0001"]:not([hidden])').count() === 1, "playback return");
    await tv.remote(10009);
    await activate(tv, "calendar"); await ready(tv, 3);
    assert.equal(reads(tv).length, 2);
    assert.match(await tv.page.locator('.calendar-event[data-content-id="movie:m0001"]').textContent() ?? "", /Watched/);
});

for (const [start, nextDay, hours] of [["2026-04-04T13:00:00Z", "2026-04-06", 25], ["2026-10-03T14:00:00Z", "2026-10-05", 23]] as const) {
    calendarTest(`S-C1 Calendar redraw follows the ${hours}-hour Melbourne day`, async tv => {
        let remaining = await tv.page.evaluate(start => Date.parse(start) - Date.now(), start);
        // Playwright coerces each fast-forward duration to a signed 32-bit value.
        const maxClockStepMs = 2_000_000_000;
        while (remaining > 0) {
            const step = Math.min(remaining, maxClockStepMs);
            await tv.jump(step);
            remaining -= step;
        }
        await tv.page.clock.pauseAt(await tv.page.evaluate(() => Date.now() + 1000));
        await activate(tv, "calendar"); await ready(tv, 0);
        const timing = await tv.page.evaluate(day => {
            const now = new Date();
            const next = new Date(now.getFullYear(), now.getMonth(), day).getTime();
            return { delay: next - now.getTime(), dayLength: next - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() };
        }, Number(nextDay.slice(-2)));
        assert.equal(timing.dayLength, hours * 60 * 60 * 1000);
        const count = reads(tv).length, origin = await tv.focused();
        await tv.jump(timing.delay - 1);
        assert.equal(await tv.page.locator('.calendar-day[aria-current="date"]').count(), 1);
        await tv.jump(1);
        assert.equal(await tv.page.locator('.calendar-day[aria-current="date"]').count(), 0);
        assert.equal(await tv.page.locator('[data-focus="today"]').count(), 1);
        assert.equal(await tv.focused(), origin);
        assert.equal(reads(tv).length, count);
    });
}

calendarTest("S-C1 Calendar owns one day timer and cancels it on root exit and teardown", async tv => {
    await tv.page.evaluate(() => {
        const set = window.setTimeout, clear = window.clearTimeout;
        const timers = new Set<unknown>();
        Object.defineProperty(window, "setTimeout", { configurable: true, value: (handler: TimerHandler, ms?: number, ...args: unknown[]) => {
            const handle: unknown = Reflect.apply(set, window, [handler, ms, ...args]);
            if (ms !== undefined && ms > 60 * 60 * 1000) timers.add(handle);
            return handle;
        } });
        Object.defineProperty(window, "clearTimeout", { configurable: true, value: (handle: unknown) => {
            timers.delete(handle); Reflect.apply(clear, window, [handle]);
        } });
        Reflect.set(window, "calendarDayTimers", () => timers.size);
    });
    const count = () => tv.page.evaluate(() => (Reflect.get(window, "calendarDayTimers") as () => number)());
    await activate(tv, "calendar"); await ready(tv, 3);
    assert.equal(await count(), 1);
    await activate(tv, "filter:everything"); await ready(tv, 32);
    assert.equal(await count(), 1);
    await activate(tv, "home");
    assert.equal(await count(), 0);
    await activate(tv, "calendar"); await ready(tv, 32);
    assert.equal(await count(), 1);
    await tv.page.evaluate(() => window.browseHarness.destroy());
    assert.equal(await count(), 0);
    await tv.jump(await tv.page.evaluate(() => new Date(2026, 0, 3).getTime() - Date.now()));
    assert.equal(await tv.page.locator(".browse").count(), 0);
});
