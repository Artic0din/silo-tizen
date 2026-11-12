// #397: the Details popovers, the More menu and failure alerts against silo-apple e792abd (tvOS):
// TVActionPopoverMenu.swift, TVTopMenuBar.swift TVSkylinePanelHeader, DetailPlaybackFormatting.swift,
// TVSeriesDetailView.swift moreMenu, ShuffleLauncher.swift and WatchPartyEntry.swift.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, readLive, type Tv } from "./support/tv.ts";
import { start } from "./support/watchParty.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const LEFT = 37, RIGHT = 39, DOWN = 40;
/** Apple's points times --silo-sf-cap-scale (0.9685). */
const scaled = (points: number): string => `${Number((points * 0.9685).toFixed(4))}px`;

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

/** Replaces the movie's tracks; every version gets the same lists. */
async function movieTracks(tv: Tv, details: FakeDetails, tracks: { audio?: Record<string, unknown>[]; subtitles?: Record<string, unknown>[] }): Promise<void> {
    const body = details.route("GET", "/catalog/items/movie%3Am0001", "p-owner")?.body as { versions: Record<string, unknown>[] };
    await tv.page.route("**/api/v2/catalog/items/movie%3Am0001?**", route => route.fulfill({ json: {
        ...body, versions: body.versions.map(version => ({ ...version, effective_audio_track_index: 0,
            ...(tracks.audio === undefined ? {} : { audio_tracks: tracks.audio }),
            ...(tracks.subtitles === undefined ? {} : { subtitle_tracks: tracks.subtitles }) })),
    } }));
}

async function openMovie(tv: Tv): Promise<void> {
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="watchlist"][aria-pressed]').waitFor();
}

/** Waits for the open scale to finish so boxes read at full size. */
async function settled(tv: Tv): Promise<void> {
    await readLive(tv, () => {
        const panel = document.querySelector(".details-track-popover");
        return panel === null || !panel.isConnected ? null : panel.getBoundingClientRect().width;
    }, null, width => Math.abs(width - 560) < .01, "popover open scale settled");
}

/** Apple's system alert: waits for it, then presses OK. */
async function dismissAlert(tv: Tv, title: string, message: string): Promise<void> {
    const alert = tv.page.getByRole("alertdialog", { name: title, exact: true });
    await alert.waitFor();
    assert.equal(await alert.locator(".signin-alert-text").textContent(), message);
    assert.equal(await tv.focused(), "alert-ok");
    await alert.getByRole("button", { name: "OK", exact: true }).click();
    await alert.waitFor({ state: "detached" });
}

detailTest("Track popovers share More's glass surface, mono header and padded rows", async (tv, details) => {
    await movieTracks(tv, details, { audio: [{ default: true, language: "en", codec: "eac3", channels: 6 }] });
    await openMovie(tv);
    await tv.page.locator('[data-focus="audio"]').click();
    await settled(tv);
    const metrics = await tv.page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>(".details-track-popover")!;
        const header = panel.querySelector<HTMLElement>(".browse-section-title")!;
        const auto = panel.querySelector<HTMLElement>('[data-focus="audio:auto"]')!;
        const title = auto.querySelector<HTMLElement>(".details-option-title")!;
        const detail = auto.querySelector<HTMLElement>(".details-option-subtext")!;
        const p = getComputedStyle(panel), h = getComputedStyle(header), r = getComputedStyle(auto), t = getComputedStyle(title), d = getComputedStyle(detail);
        const rowBox = auto.getBoundingClientRect();
        return {
            panel: { width: panel.getBoundingClientRect().width, padding: p.padding, radius: p.borderTopLeftRadius, background: p.backgroundColor, shadow: p.boxShadow, origin: p.transformOrigin.split(" ")[1] === "0px" ? "top" : p.transformOrigin },
            header: { family: h.fontFamily, size: h.fontSize, weight: h.fontWeight, tracking: h.letterSpacing, color: h.color, padding: h.padding, text: header.textContent },
            row: { radius: r.borderTopLeftRadius, padding: r.padding, width: rowBox.width, height: rowBox.height, textLeft: title.getBoundingClientRect().left - rowBox.left },
            title: { size: t.fontSize, weight: t.fontWeight, color: t.color },
            detail: { size: d.fontSize, weight: d.fontWeight, opacity: d.opacity },
        };
    });
    assert.deepEqual(metrics.panel, { width: 560, padding: "14px", radius: "22px", background: "rgba(0, 0, 0, 0.45)", shadow: "rgba(255, 255, 255, 0.1) 0px 0px 0px 1px inset, rgba(0, 0, 0, 0.45) 0px 18px 32px 0px", origin: "top" });
    assert.match(metrics.header.family, /monospace/);
    assert.deepEqual({ ...metrics.header, family: undefined }, { family: undefined, size: "14px", weight: "400", tracking: "3.64px", color: "rgba(255, 255, 255, 0.38)", padding: "8px 16px 10px", text: "AUDIO" });
    // A 13pt-padded row with a detail line is 76 tall; its text starts at 18 + 26 + 14.
    assert.deepEqual(metrics.row, { radius: "14px", padding: "13px 18px 13px 58px", width: 532, height: 76, textLeft: 58 });
    assert.deepEqual(metrics.title, { size: scaled(22), weight: "600", color: "rgb(0, 0, 0)" });
    assert.deepEqual(metrics.detail, { size: scaled(17), weight: "500", opacity: "0.7" });
    const resting = await tv.page.locator('[data-focus="audio:0"]').evaluate(node => getComputedStyle(node).color);
    assert.equal(resting, "rgba(255, 255, 255, 0.9)");
});

detailTest("A popover reopens on the selected row, and Left or Right closes it back to its trigger", async (tv, details) => {
    await movieTracks(tv, details, { audio: [{ default: true, language: "en", codec: "eac3", channels: 6 }, { default: false, language: "ja", codec: "aac", channels: 2 }] });
    await openMovie(tv);
    await tv.page.locator('[data-focus="audio"]').click();
    assert.equal(await tv.focused(), "audio:auto");
    await tv.page.locator('[data-focus="audio:1"]').click();
    await tv.page.locator('[data-focus="audio"]').click();
    assert.equal(await tv.focused(), "audio:1", "the selected track, not Auto");
    for (const [trigger, key] of [["audio", LEFT], ["version", RIGHT], ["subtitles", LEFT]] as const) {
        if (await tv.page.locator(".details-track-popover").count() === 0) await tv.page.locator(`[data-focus="${trigger}"]`).click();
        await tv.page.locator(".details-track-popover").waitFor();
        await tv.remote(key);
        await tv.page.locator(".details-track-popover").waitFor({ state: "detached" });
        assert.equal(await tv.focused(), trigger);
    }
});

detailTest("Subtitles Apple can't deliver stay listed, dimmed and unfocusable, and Default is labelled", async (tv, details) => {
    await movieTracks(tv, details, { subtitles: [
        { index: 2, language: "en", codec: "subrip", default: true },
        { index: 3, language: "fr", codec: "" },
        { language: "de", codec: "subrip", external: true, file_name: "movie.de.srt" },
        { index: 5, language: "es", codec: "subrip", hearing_impaired: true, title: "CC" },
    ] });
    await openMovie(tv);
    await tv.page.locator('[data-focus="subtitles"]').click();
    await settled(tv);
    const rows = await tv.page.locator('.details-audio-options [data-focus^="subtitle:"]').evaluateAll(nodes => nodes.map(node => ({
        key: node.getAttribute("data-focus"), title: node.querySelector(".details-option-title")?.textContent, detail: node.querySelector(".details-option-subtext")?.textContent,
        disabled: node.getAttribute("aria-disabled") === "true", opacity: getComputedStyle(node).opacity,
    })));
    const byTitle = new Map(rows.map(row => [row.title, row]));
    assert.deepEqual(byTitle.get("English"), { key: "subtitle:0", title: "English", detail: "SRT · Default", disabled: false, opacity: "1" });
    assert.deepEqual(byTitle.get("French"), { key: "subtitle:1", title: "French", detail: "Unsupported format", disabled: true, opacity: "0.4" });
    assert.deepEqual(byTitle.get("German"), { key: "subtitle:2", title: "German", detail: "SRT · External · Available in player", disabled: true, opacity: "0.4" });
    assert.equal(byTitle.get("Spanish")?.detail, "SRT · SDH", "a CC title reads as Apple's SDH");
    const order = rows.map(row => row.key);
    for (let step = 0; step < order.length; step++) await tv.remote(DOWN);
    const visited = new Set<string>();
    for (let step = 0; step < order.length + 2; step++) { visited.add(await tv.focused() ?? ""); await tv.remote(38); }
    assert.equal(visited.has("subtitle:1") || visited.has("subtitle:2"), false, `disabled rows take no focus: ${[...visited].join(", ")}`);
    await tv.page.locator('[data-focus="subtitle:1"]').dispatchEvent("click");
    assert.equal(await tv.page.locator(".details-track-popover").count(), 1, "a disabled track cannot be chosen");
});

detailTest("Audio rows lead with the language and move the track's own title to the detail line", async (tv, details) => {
    await movieTracks(tv, details, { audio: [
        { default: true, language: "en", codec: "eac3", channels: 6, title: "Director Commentary" },
        { default: false, language: "ja", codec: "aac", channels: 2 },
    ] });
    await openMovie(tv);
    await tv.page.locator('[data-focus="audio"]').click();
    assert.equal(await tv.page.locator('[data-focus="audio:0"] .details-option-title').textContent(), "English");
    assert.equal(await tv.page.locator('[data-focus="audio:0"] .details-option-subtext').textContent(), "Director Commentary · EAC3 · 5.1 · Default · Preferred");
    assert.equal(await tv.page.locator('[data-focus="audio:1"] .details-option-title').textContent(), "Japanese");
});

detailTest("More than seven tracks scroll inside Apple's 504pt cap, opened with the selection centred", async (tv, details) => {
    const audio = Array.from({ length: 12 }, (_value, index) => ({ default: index === 0, language: ["en", "ja", "fr", "de", "es", "it", "ko", "pt", "ru", "sv", "pl", "nl"][index], codec: "aac", channels: 2 }));
    await movieTracks(tv, details, { audio });
    await openMovie(tv);
    await tv.page.locator('[data-focus="audio"]').click();
    await tv.page.locator('[data-focus="audio:6"]').click();
    await tv.page.locator('[data-focus="audio"]').click();
    await settled(tv);
    assert.equal(await tv.focused(), "audio:6");
    const list = await tv.page.evaluate(() => {
        const list = document.querySelector<HTMLElement>(".details-popover-scroll")!;
        const row = list.querySelector<HTMLElement>('[data-focus="audio:6"]')!;
        const box = list.getBoundingClientRect(), r = row.getBoundingClientRect();
        return { maxHeight: getComputedStyle(list).maxHeight, height: box.height, overflow: getComputedStyle(list).overflowY, centre: Math.round((r.top + r.height / 2) - (box.top + box.height / 2)) };
    });
    assert.deepEqual(list, { maxHeight: "504px", height: 504, overflow: "auto", centre: 0 });
    const heights = await tv.page.locator(".details-track-popover").evaluate(node => ({ panel: node.getBoundingClientRect().height, header: node.querySelector(".browse-section-title")!.getBoundingClientRect().height }));
    assert.equal(heights.panel, 14 + heights.header + 504 + 14, "the header stays fixed; only the list scrolls");
});

detailTest("Find Trailers' status pill sits 24 under a movie's action row", async (tv) => {
    await tv.page.route("**/api/v2/catalog/items/movie%3Am0001/trailers/refresh", route => route.fulfill({ status: 202, json: { status: "queued" } }));
    await openMovie(tv);
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.locator('[data-focus="find-trailers"]').click();
    const gap = await readLive(tv, () => {
        const pill = document.querySelector(".details-editorial .details-trailer-status");
        const row = document.querySelector(".details-editorial .browse-actions");
        return pill === null || row === null ? null : { gap: pill.getBoundingClientRect().top - row.getBoundingClientRect().bottom, size: getComputedStyle(pill).fontSize };
    }, null, () => true, "movie trailer pill");
    assert.deepEqual(gap, { gap: 24, size: scaled(24) });
});

detailTest("A series draws the trailer pill under its episode rail", async (tv) => {
    await tv.page.route("**/api/v2/catalog/items/series%3As1/trailers/refresh", route => route.fulfill({ status: 202, json: { status: "queued" } }));
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="watchlist"][aria-pressed]').waitFor();
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.locator('[data-focus="find-trailers"]').click();
    await tv.page.locator(".details-trailer-status").waitFor();
    assert.equal(await tv.page.locator(".details-editorial .details-trailer-status").count(), 0);
    const placed = await tv.page.evaluate(() => {
        const pill = document.querySelector(".details-trailer-status")!;
        const rail = document.querySelector(".details-series-rail, .details-episodes")!;
        return pill.getBoundingClientRect().top >= rail.getBoundingClientRect().bottom;
    });
    assert.equal(placed, true);
});

detailTest("A failed favourite is Apple's Couldn't Update Item alert, and More keeps its label", async (tv, details) => {
    await openMovie(tv);
    details.mutationFailure = problem(422, "validation_failed", "Unavailable action");
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.locator('[data-focus="favorites"]').click();
    await dismissAlert(tv, "Couldn't Update Item", "Your change wasn't saved. Please try again.");
    assert.equal(await tv.focused(), "more");
    await tv.page.locator('[data-focus="more"]').click();
    const panel = tv.page.getByRole("dialog", { name: "More", exact: true });
    await panel.getByRole("button", { name: "Add to Favorites", exact: true }).waitFor();
    assert.equal(await panel.getByRole("alert").count(), 0);
    await tv.remote(LEFT);
    assert.equal(await tv.focused(), "more");
});

detailTest("An unanswered favourite is Apple's Change Not Confirmed alert, and Discard reloads it without re-sending", async (tv, details) => {
    await openMovie(tv);
    let writes = 0;
    await tv.page.route("**/api/v2/favorites/movie%3Am0001", async route => {
        if (route.request().method() === "GET") { await route.fallback(); return; }
        writes++;
        await route.abort("timedout");
    });
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.locator('[data-focus="favorites"]').click();
    const alert = tv.page.getByRole("alertdialog", { name: "Change Not Confirmed", exact: true });
    await alert.waitFor();
    assert.equal(await alert.locator(".signin-alert-text").textContent(), "Silo sent this change but the server didn't answer, so it won't be sent again. Discard the held change to reload this item and try again.");
    // PersonalStateNoticeAlert: the destructive Discard Held Change sits above OK, and OK keeps focus.
    assert.deepEqual(await alert.locator("button").allTextContents(), ["Discard Held Change", "OK"]);
    assert.equal(await tv.focused(), "alert-ok");
    // OK keeps the hold, across leaving and reopening the title too: pressing the control again shows the alert instead
    // of sending the write.
    await alert.getByRole("button", { name: "OK", exact: true }).click();
    await alert.waitFor({ state: "detached" });
    await tv.remote(10009);
    await openMovie(tv);
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.locator('[data-focus="favorites"]').click();
    await alert.waitFor();
    assert.equal(writes, 1, "a held change is never re-sent");
    const membershipReads = () => tv.fake.requests.filter(request => request.path === "/favorites/movie%3Am0001/membership").length;
    const before = membershipReads();
    const reload = tv.fake.hold("/favorites/movie%3Am0001/membership");
    await alert.getByRole("button", { name: "Discard Held Change", exact: true }).click();
    await alert.waitFor({ state: "detached" });
    await tv.eventually(async () => membershipReads() > before, "discard reloads the membership");
    // The control stays busy until the reload answers, so no press can act on the replaced state.
    await tv.page.locator('[data-focus="more"]').click();
    const panel = tv.page.getByRole("dialog", { name: "More", exact: true });
    assert.equal(await panel.locator('[data-focus="favorites"]').getAttribute("aria-disabled"), "true");
    reload.release();
    await tv.remote(10009);
    await tv.page.locator('[data-focus="more"]').click();
    await panel.getByRole("button", { name: "Add to Favorites", exact: true }).waitFor();
    assert.equal(writes, 1);
    void details;
});

detailTest("Leaving mid-discard keeps the hold, and a reopened title still refreshes its other memberships", async (tv) => {
    await openMovie(tv);
    let writes = 0;
    await tv.page.route("**/api/v2/favorites/movie%3Am0001", async route => {
        if (route.request().method() === "GET") { await route.fallback(); return; }
        writes++;
        await route.abort("timedout");
    });
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.locator('[data-focus="favorites"]').click();
    const alert = tv.page.getByRole("alertdialog", { name: "Change Not Confirmed", exact: true });
    await alert.waitFor();
    const favoriteReads = () => tv.fake.requests.filter(request => request.path === "/favorites/movie%3Am0001/membership").length;
    const before = favoriteReads();
    tv.fake.hold("/favorites/movie%3Am0001/membership");
    await alert.getByRole("button", { name: "Discard Held Change", exact: true }).click();
    await tv.eventually(async () => favoriteReads() > before, "discard starts its reload");
    await tv.remote(10009);
    const watchlistReads = () => tv.fake.requests.filter(request => request.path === "/watchlist/movie%3Am0001/membership").length;
    const watchlistBefore = watchlistReads();
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.eventually(async () => watchlistReads() > watchlistBefore, "the reopened title refreshes the watchlist beside the hold");
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.locator('[data-focus="favorites"]').click();
    await alert.waitFor();
    assert.equal(writes, 1, "the interrupted discard did not release the hold");
});

detailTest("A season watched failure that lands after switching seasons still shows its alert", async (tv, details) => {
    const seasons = details.route("GET", "/catalog/series/series%3As1/seasons", "p-owner")?.body as { items: { content_id: string; season_number: number }[] };
    const first = seasons.items.find(season => season.season_number === 1)?.content_id ?? "";
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="watchlist"][aria-pressed]').waitFor();
    details.mutationFailure = problem(422, "validation_failed", "Unavailable action");
    const write = tv.fake.hold(`/watched/${encodeURIComponent(first)}`, true);
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.locator('[data-focus="season-watched"]').click();
    await tv.page.locator('[data-focus="season:2"]').click();
    write.release();
    await dismissAlert(tv, "Couldn't Update Watched Status", "Please check your connection and try again.");
});

detailTest("Back dismisses the alert like OK", async (tv, details) => {
    await openMovie(tv);
    details.mutationFailure = problem(422, "validation_failed", "Unavailable action");
    await tv.page.locator('[data-focus="watchlist"]').click();
    await tv.page.getByRole("alertdialog", { name: "Couldn't Update Item", exact: true }).waitFor();
    await tv.remote(10009);
    await tv.page.getByRole("alertdialog").waitFor({ state: "detached" });
    assert.equal(await tv.page.locator('[data-view="item:movie:m0001"]').count(), 1, "Back closed the alert, not the page");
    assert.equal(await tv.focused(), "watchlist");
});

for (const [status, message] of [[409, "Nothing here can be played."], [404, "This is no longer available to shuffle."]] as const) {
    detailTest(`Shuffle Season leads More and a ${status} is the Couldn't Shuffle alert`, async (tv) => {
        await tv.page.route("**/api/v2/shuffles/capabilities", route => route.fulfill({ json: { allowed: true, state: "available", scope_kinds: ["series", "season"] } }));
        const posts: unknown[] = [];
        await tv.page.route("**/api/v2/shuffles", async route => { posts.push(route.request().postDataJSON()); await route.fulfill({ status, contentType: "application/problem+json", body: JSON.stringify(problem(status, "refused", "Refused").body) }); });
        await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
        await tv.page.locator('[data-focus="watchlist"][aria-pressed]').waitFor();
        await tv.page.locator('[data-focus="more"]').click();
        const panel = tv.page.getByRole("dialog", { name: "More", exact: true });
        assert.equal(await panel.locator('[data-focus="shuffle-season"]').count(), 0, "the series overview offers no season shuffle");
        await tv.remote(10009);
        await tv.page.locator('[data-focus="episode:s1e11"]').waitFor();
        await tv.page.locator('[data-focus="next-episode"]').focus();
        await tv.remote(DOWN); await tv.remote(DOWN);
        await tv.eventually(async () => (await tv.focused())?.startsWith("episode:") === true, "episode focused");
        await tv.page.locator('[data-focus="more"]').click();
        const keys = await panel.locator("button").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus")));
        assert.deepEqual(keys.slice(0, 2), ["shuffle-season", "shuffle-series"]);
        assert.equal(await panel.locator('[data-focus="shuffle-season"]').textContent(), "Shuffle Season 1");
        assert.equal(await panel.locator('[data-focus="shuffle-season"] svg').getAttribute("data-symbol"), "shuffle");
        await panel.locator('[data-focus="shuffle-season"]').click();
        assert.equal(await panel.count(), 0, "More closes at once");
        await dismissAlert(tv, "Couldn't Shuffle", message);
        assert.equal(await tv.focused(), "more");
        assert.equal((posts[0] as { scope: { kind: string } }).scope.kind, "season");
        // The alert leaves the cached season pills and episode rail intact, so they still take focus.
        const rail = await tv.page.locator(".details-episodes button").evaluateAll(nodes => nodes.map(node => ({ key: node.getAttribute("data-focus"), disabled: (node as HTMLButtonElement).disabled, dimmed: node.closest(".dialog-behind-dimmed") !== null })));
        assert.ok(rail.length > 0 && rail.every(card => card.key !== null && !card.disabled && !card.dimmed), JSON.stringify(rail));
        await tv.remote(DOWN); await tv.remote(DOWN);
        await tv.eventually(async () => (await tv.focused())?.startsWith("episode:") === true, "the episode rail takes focus after the alert");
    });
}

test("Watch Party ends More only while the off-by-default switch is on, and opens a room with the title", async () => {
    for (const enabled of [false, true]) {
        const tv = await openTv(browser, { app: "browse" });
        try {
            const fake = await start(tv, undefined, enabled);
            await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
            await tv.page.locator('[data-focus="watchlist"][aria-pressed]').waitFor();
            await tv.page.locator('[data-focus="more"]').click();
            const panel = tv.page.getByRole("dialog", { name: "More", exact: true });
            await panel.locator("button").first().waitFor();
            if (!enabled) {
                await tv.jump(1000);
                assert.equal(await panel.locator('[data-focus="watch-party"]').count(), 0);
                continue;
            }
            await tv.eventually(async () => {
                await tv.remote(10009);
                await tv.page.locator('[data-focus="more"]').click();
                return await panel.locator('[data-focus="watch-party"]').count() === 1;
            }, "Watch Party offered");
            const keys = await panel.locator("button").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus")));
            assert.equal(keys.at(-1), "watch-party");
            assert.equal(await panel.locator('[data-focus="watch-party"]').textContent(), "Watch Party");
            assert.equal(await panel.locator('[data-focus="watch-party"] svg').getAttribute("data-symbol"), "person.3");
            await panel.locator('[data-focus="watch-party"]').click();
            // The automatic create locks the entry at once, so Start a party cannot race it.
            assert.equal(await tv.page.locator('[data-focus="create"]').getAttribute("aria-disabled"), "true");
            await tv.page.locator('.browse[data-view="watchParty:lobby"]').waitFor();
            assert.equal(fake.createdRooms[0]?.selection_mode, "host_pick");
            await tv.eventually(async () => fake.selectedContentId === "movie:m0001", "the title is the room's selection");
            // tvOS pushes the lobby over Details: Back leaves the party to its entry, whose Back moves to the bar like the
            // profile-menu entry, and the next Back returns to the title.
            await tv.remote(10009);
            await tv.page.locator('.browse[data-view="watchParty:hub"]').waitFor();
            await tv.remote(10009);
            await tv.eventually(async () => (await tv.page.evaluate(() => document.activeElement?.closest(".browse-nav") !== null)), "Back focuses the bar");
            await tv.remote(10009);
            await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
        } finally { await tv.page.context().close(); }
    }
});
