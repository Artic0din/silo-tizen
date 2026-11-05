import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakePlayback } from "../native/support/fakePlayback.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";
import { object } from "../../src/contracts/v2/wire.ts";

class AudioPreferenceDetails extends FakeDetails {
    private readonly audioPreferences = new Map<string, Record<string, unknown>>();

    override route(...args: Parameters<FakeDetails["route"]>): ReturnType<FakeDetails["route"]> {
        const [method, path, profile, body] = args;
        if (!path.startsWith("/audio-prefs/") && !path.startsWith("/subtitle-prefs/")) return super.route(...args);
        const key = `${profile}:${path}`;
        if (method === "PUT") { this.audioPreferences.set(key, object(body, "audio_preference")); return { status: 204 }; }
        if (method === "DELETE") { this.audioPreferences.delete(key); return { status: 204 }; }
        const stored = this.audioPreferences.get(key);
        return stored === undefined ? { status: 404 } : { status: 200, body: { ...stored, series_id: decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)) } };
    }
}

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

async function details(tv: Tv): Promise<void> {
    await tv.page.fill("#signin-address", "silo.example.test");
    await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
    await tv.page.locator('[data-screen="code"]').waitFor();
    const code = [...tv.fake.devices.keys()].pop();
    assert.ok(code);
    tv.fake.approve(code);
    await tv.jump(5000);
    // "Signed in as …" holds for a second before sign-in moves on.
    await tv.jump(1000);
    await tv.page.locator('[data-focus="profile:p-owner"]').click();
    await tv.page.locator('[data-focus="ask-every-launch"]').click();
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="resume"]').waitFor();
}

function preplay(name: string, body: (tv: Tv, catalog: FakeDetails, playback: FakePlayback) => Promise<void>, production = true, reduced = false, configure?: (catalog: FakeDetails) => void): void {
    test(name, async () => {
        const tv = await openTv(browser, { app: "application", production });
        const catalog = new AudioPreferenceDetails();
        catalog.progress.set("movie:m0001", 1200.5);
        configure?.(catalog);
        tv.fake.catalog = catalog;
        const playback = new FakePlayback(tv.fake);
        playback.items.set("movie:m0001", ["42", "43"]);
        playback.automaticAudioIndex = 2;
        try { await tv.page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" }); await details(tv); await body(tv, catalog, playback); assert.deepEqual(tv.console, []); }
        finally { await tv.page.context().close(); }
    });
}

preplay("stored nonzero progress + Play from start sends numeric zero", async (tv) => {
    await tv.page.locator('[data-focus="play"]').click();
    await tv.eventually(async () => tv.fake.requests.some(r => r.path === "/playback/start"), "start POST");
    assert.equal(tv.fake.requests.find(r => r.path === "/playback/start")?.body?.start_position, 0);
});

const WATCH = "/watch/movie%3Am0001?file_id=42";

preplay("switching episodes cannot bypass a held series subtitle save", async (tv, catalog, playback) => {
    for (const id of ['episode:s1e11', 'episode:s1e12']) { catalog.fileIds.set(id, '42'); playback.items.set(id, ['42']); }
    await series(tv);
    await tv.page.locator('[data-focus="episode:s1e12"]').focus();
    await tv.page.getByRole('button', { name: /Play S1:E2|Resume S1:E2/ }).waitFor();
    await tv.page.locator('[data-focus="episode:s1e11"]').focus();
    await tv.page.locator('[data-focus="subtitles"]').waitFor();
    const held = tv.fake.hold('/subtitle-prefs/series%3As1', true);
    await tv.page.locator('[data-focus="subtitles"]').click();
    await tv.page.locator('[data-focus="subtitle:off"]').click();
    await tv.page.locator('[data-focus="episode:s1e12"]').focus();
    await tv.page.getByRole('button', { name: /Play S1:E2|Resume S1:E2/ }).waitFor();
    assert.equal(await tv.page.locator('[data-focus="next-episode"]').getAttribute('aria-disabled'), 'true');
    await tv.page.locator('[data-focus="next-episode"]').evaluate(node => { if (node instanceof HTMLElement) node.click(); });
    await tv.jump(100);
    assert.equal(tv.fake.requests.filter(request => request.path === '/playback/start').length, 0);
    held.release();
});

preplay("a playback retry cannot bypass another episode's pending series preference", async (tv, catalog, playback) => {
    for (const id of ['episode:s1e11', 'episode:s1e12']) { catalog.fileIds.set(id, '42'); playback.items.set(id, ['42']); }
    catalog.progress.set('episode:s1e11', 630);
    await series(tv);
    const watch = '/watch/episode%3As1e11?file_id=42';
    tv.fake.script(watch, { status: 500 });
    await tv.page.locator('[data-focus="next-episode"]').click();
    await tv.page.locator('[data-focus="retry-play"]').waitFor();
    await tv.page.locator('[data-focus="episode:s1e12"]').focus();
    await tv.page.locator('[data-focus="subtitles"]').waitFor();
    const held = tv.fake.hold('/subtitle-prefs/series%3As1', true);
    await tv.page.locator('[data-focus="subtitles"]').click();
    await tv.page.locator('[data-focus="subtitle:off"]').click();
    await tv.page.locator('[data-focus="episode:s1e11"]').focus();
    const retry = tv.page.locator('[data-focus="retry-play"]');
    await retry.waitFor();
    assert.equal(await retry.getAttribute('aria-disabled'), 'true');
    const before = tv.fake.requests.filter(request => request.path === watch).length;
    await retry.evaluate(node => { if (node instanceof HTMLElement) node.click(); });
    await tv.jump(100);
    assert.equal(tv.fake.requests.filter(request => request.path === watch).length, before);
    held.release();
});

preplay("an in-flight resume lookup defers handoff if another episode starts a shared save", async (tv, catalog, playback) => {
    for (const id of ['episode:s1e11', 'episode:s1e12']) { catalog.fileIds.set(id, '42'); playback.items.set(id, ['42']); }
    catalog.progress.set('episode:s1e11', 630);
    await series(tv);
    const watch = tv.fake.hold('/watch/episode%3As1e11?file_id=42', true);
    await tv.page.locator('[data-focus="next-episode"]').click();
    await tv.page.locator('[data-focus="episode:s1e12"]').focus();
    await tv.page.locator('[data-focus="subtitles"]').waitFor();
    const preference = tv.fake.hold('/subtitle-prefs/series%3As1', true);
    await tv.page.locator('[data-focus="subtitles"]').click();
    await tv.page.locator('[data-focus="subtitle:off"]').click();
    watch.release();
    await tv.page.locator('[data-focus="episode:s1e11"]').focus();
    await tv.page.locator('[data-focus="retry-play"]').waitFor({ timeout: 3000 });
    assert.equal(tv.fake.requests.filter(request => request.path === '/playback/start').length, 0);
    preference.release();
    await tv.eventually(async () => await tv.page.locator('[data-focus="retry-play"]').getAttribute('aria-disabled') === 'false', 'deferred playback remains retryable after confirmation');
    await tv.page.locator('[data-focus="retry-play"]').click();
    await prepare(tv);
    assert.equal(tv.fake.requests.filter(request => request.path === '/playback/start').length, 1);
});

preplay("switching episodes keeps a failed shared subtitle save blocked until confirmation", async (tv, catalog, playback) => {
    for (const id of ['episode:s1e11', 'episode:s1e12']) { catalog.fileIds.set(id, '42'); playback.items.set(id, ['42']); }
    await series(tv);
    await tv.page.locator('[data-focus="episode:s1e12"]').focus();
    await tv.page.getByRole('button', { name: /Play S1:E2|Resume S1:E2/ }).waitFor();
    await tv.page.locator('[data-focus="episode:s1e11"]').focus();
    tv.fake.script('/subtitle-prefs/series%3As1', { status: 500 });
    await tv.page.locator('[data-focus="subtitles"]').click();
    await tv.page.locator('[data-focus="subtitle:off"]').click();
    await tv.page.locator('[data-focus="retry-subtitle-preference"]').waitFor();
    await tv.page.locator('[data-focus="episode:s1e12"]').focus();
    await tv.page.getByRole('button', { name: /Play S1:E2|Resume S1:E2/ }).waitFor();
    assert.equal(await tv.page.locator('[data-focus="next-episode"]').getAttribute('aria-disabled'), 'true');
    await tv.page.locator('[data-focus="next-episode"]').evaluate(node => { if (node instanceof HTMLElement) node.click(); });
    await tv.jump(100);
    assert.equal(tv.fake.requests.filter(request => request.path === '/playback/start').length, 0);
    await tv.page.locator('[data-focus="retry-subtitle-preference"]').click();
    await tv.eventually(async () => await tv.page.locator('[data-focus="next-episode"]').getAttribute('aria-disabled') === 'false', 'shared preference confirmed and refreshed');
});

preplay("a confirmed series preference refresh clears other episodes' stale track intents but retains versions", async (tv, catalog) => {
    for (const id of ['episode:s1e11', 'episode:s1e12']) catalog.fileIds.set(id, '42');
    await series(tv);
    await tv.page.locator('[data-focus="episode:s1e12"]').focus();
    await tv.page.getByRole('button', { name: /Play S1:E2|Resume S1:E2/ }).waitFor();
    await tv.page.locator('[data-focus="version"]').click();
    await tv.page.locator('[data-focus="version:42"]').click();
    await tv.page.locator('[data-focus="subtitles"]').click();
    await tv.page.locator('[data-focus="subtitle:off"]').click();
    await tv.eventually(async () => await tv.page.locator('[data-focus="next-episode"]').getAttribute('aria-disabled') === 'false', 'Off saved');
    await tv.page.locator('[data-focus="episode:s1e11"]').focus();
    await tv.page.locator('[data-focus="subtitles"]').click();
    await tv.page.locator('[data-focus="subtitle:auto"]').click();
    await tv.eventually(async () => await tv.page.locator('[data-focus="next-episode"]').getAttribute('aria-disabled') === 'false', 'Auto saved');
    await tv.page.locator('[data-focus="episode:s1e12"]').focus();
    await tv.page.getByRole('button', { name: /Play S1:E2|Resume S1:E2/ }).waitFor();
    assert.equal(await tv.page.locator('[data-track-summary="subtitles"] span').textContent(), 'Auto · None');
    await tv.page.locator('[data-focus="version"]').click();
    assert.equal(await tv.page.locator('[data-focus="version:42"]').getAttribute('aria-checked'), 'true');
});

preplay("an extra without a file ID retries version lookup without an accidental start", async (tv, _catalog, playback) => {
    playback.items.set("extra:1", ["42"]);
    tv.fake.script("/catalog/items/extra%3A1/versions", { status: 500 });
    await tv.page.locator('[data-focus="extra:extra:1"]').click();
    await tv.page.getByRole('button', { name: /Retry Trailer/ }).waitFor();
    assert.equal(tv.fake.requests.filter(request => request.path === '/playback/start').length, 0);
    await tv.page.locator('[data-focus="extra:extra:1"]').click();
    await prepare(tv);
    assert.equal(tv.fake.requests.find(request => request.path === '/playback/start')?.body?.start_position, 0);
}, true, false, catalog => { catalog.extras = [{ content_id: "extra:1", kind: "trailer", title: "Trailer" }]; });

preplay("Back cancels an extra's held version lookup", async (tv, _catalog, playback) => {
    playback.items.set("extra:1", ["42"]);
    const held = tv.fake.hold("/catalog/items/extra%3A1/versions", true);
    await tv.page.locator('[data-focus="extra:extra:1"]').click();
    await tv.page.getByRole('button', { name: /Loading extra/ }).waitFor();
    await tv.remote(10009);
    await tv.page.locator('[data-section="recently_added"]').first().waitFor();
    held.release();
    await tv.jump(100);
    assert.equal(tv.fake.requests.filter(request => request.path === '/playback/start').length, 0);
}, true, false, catalog => { catalog.extras = [{ content_id: "extra:1", kind: "trailer", title: "Trailer" }]; });
const starts = (tv: Tv) => tv.fake.requests.filter(r => r.path === "/playback/start");

for (const destination of ["series", "season"]) preplay(`${destination} Resume retains cached progress when its fresh lookup is unavailable`, async (tv, catalog, playback) => {
    catalog.fileIds.set("episode:s1e11", "42");
    catalog.progress.set("episode:s1e11", 630);
    playback.items.set("episode:s1e11", ["42"]);
    await series(tv);
    if (destination === "season") {
        await tv.page.locator('[data-focus="more"]').click();
        await tv.page.locator('[data-focus="season-info"]').click();
    }
    await tv.page.getByRole("button", { name: "Resume S1:E1", exact: true }).waitFor();
    const path = "/watch/episode%3As1e11?file_id=42";
    const before = tv.fake.requests.filter(request => request.path === path).length;
    tv.fake.script(path, { status: 503 });
    await tv.page.locator('[data-focus="next-episode"]').click();
    await prepare(tv);
    assert.ok(tv.fake.requests.filter(request => request.path === path).length > before);
    assert.equal(starts(tv)[0]?.body?.start_position, 630);
});

preplay("series Play refreshes progress saved after an initially unplayed episode loaded", async (tv, catalog, playback) => {
    catalog.fileIds.set("episode:s1e11", "42");
    catalog.progress.set("episode:s1e11", 0);
    playback.items.set("episode:s1e11", ["42"]);
    await series(tv);
    await tv.page.locator('[data-focus="next-episode"]').waitFor();
    catalog.progress.set("episode:s1e11", 630);
    await tv.page.locator('[data-focus="next-episode"]').click();
    await prepare(tv);
    assert.equal(starts(tv)[0]?.body?.start_position, 630);
});

for (const destination of ["series", "season"]) preplay(`${destination} keeps an explicit next-episode version through playback return`, async (tv, catalog, playback) => {
    catalog.fileIds.set("episode:s1e11", "42");
    playback.items.set("episode:s1e11", ["42"]);
    await series(tv);
    if (destination === "season") {
        await tv.page.locator('[data-focus="more"]').click();
        await tv.page.locator('[data-focus="season-info"]').click();
    }
    await tv.page.locator('[data-focus="version"]').click();
    await tv.page.locator('[data-focus="version:42"]').click();
    await tv.page.locator('[data-focus="next-episode"]').click();
    await prepare(tv);
    await tv.remote(10009);
    await tv.page.locator('[data-focus="version"]').click();
    assert.equal(await tv.page.locator('[data-focus="version:42"]').getAttribute("aria-checked"), "true");
});

for (const embeddedFile of [true, false]) preplay(`local extras ${embeddedFile ? "with" : "without"} embedded file ID start from zero and restore their card on Back`, async (tv, _catalog, playback) => {
    playback.items.set("extra:1", ["42"]);
    await tv.page.locator('[data-focus="extra:extra:1"]').click();
    await prepare(tv);
    assert.ok(tv.fake.requests.some(request => request.path.includes("extra%3A1")), "player resolves the extra watch target");
    assert.equal(starts(tv)[0]?.body?.file_id, "42");
    assert.equal(starts(tv)[0]?.body?.start_position, 0);
    await tv.remote(10009);
    await tv.page.locator('.details-extras').waitFor();
    assert.equal(await tv.focused(), "extra:extra:1");
}, true, false, catalog => { catalog.extras = [{ content_id: "extra:1", ...(embeddedFile ? { file_id: 42 } : {}), kind: "trailer", title: "Trailer", duration_seconds: 90 }]; });

async function savedAudio(tv: Tv): Promise<void> {
    await tv.page.getByText("Saving audio preference…", { exact: true }).waitFor({ state: "hidden" });
    assert.equal(await tv.page.locator('[data-focus="retry-audio-preference"]').count(), 0);
}

async function savedSubtitle(tv: Tv): Promise<void> {
    await tv.page.getByText("Saving subtitle preference…", { exact: true }).waitFor({ state: "hidden" });
    assert.equal(await tv.page.locator('[data-focus="retry-subtitle-preference"]').count(), 0);
}

async function prepare(tv: Tv): Promise<void> {
    await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.pendingPrepares > 0), "AVPlay preparation");
    await tv.page.evaluate(() => {
        const avplay = window.appHarness.avplay;
        avplay.finishPrepare();
        if (avplay.calls[avplay.calls.length - 1]?.startsWith("seekTo")) avplay.finishSeek();
    });
    await tv.page.getByRole("slider").waitFor();
}

async function series(tv: Tv): Promise<void> {
    await tv.remote(10009);
    await tv.page.locator('[data-view="home"] .browse-card[data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="next-episode"]').waitFor();
    await tv.page.locator('.details-episodes [data-focus="episode:s1e12"]').waitFor();
    await tv.eventually(async () => await tv.page.locator('[data-focus="next-episode"]').getAttribute("aria-disabled") !== "true", "primary episode metadata");
}

preplay("direct episode activation refreshes cached-zero progress and returns to its rail", async (tv, catalog, playback) => {
    const id = "episode:s1e12", watch = "/watch/episode%3As1e12?file_id=42";
    catalog.fileIds.set(id, "42");
    catalog.progress.set(id, 420);
    const fresh = catalog.route("GET", watch, "p-owner");
    assert.ok(fresh);
    assert.equal(fresh.status, 200);
    catalog.progress.delete(id);
    tv.fake.script(watch, fresh);
    playback.items.set(id, ["42"]);
    await series(tv);
    await tv.page.locator('.details-episodes [data-focus="episode:s1e12"]').click();
    await tv.eventually(async () => starts(tv).length > 0 || await tv.page.locator('[data-view="item:episode:s1e12"]').count() > 0, "episode activation");
    assert.equal(await tv.page.locator('[data-view="item:episode:s1e12"]').count(), 0, "short Select must not open episode information");
    await prepare(tv);
    assert.equal(starts(tv).length, 1);
    assert.equal(starts(tv)[0]?.body?.file_id, "42");
    assert.equal(tv.fake.requests.filter(request => request.path === watch).length, 2);
    assert.equal(starts(tv)[0]?.body?.start_position, 420);
    assert.equal(starts(tv)[0]?.body?.audio_track_id, undefined);
    assert.equal(starts(tv)[0]?.body?.subtitle_track_id, undefined);
    await tv.remote(10009);
    await tv.page.locator('[data-view="item:series:s1"]').waitFor();
    await tv.eventually(async () => await tv.focused() === id, "originating episode focus");
    assert.equal(await tv.page.locator('[data-focus="season:1"]').getAttribute("aria-pressed"), "true");
    assert.equal(starts(tv).length, 1, "return must not replay the episode");
});

preplay("direct episode activation keeps information and selectors behind an explicit action", async (tv, catalog) => {
    catalog.fileIds.set("episode:s1e12", "42");
    await series(tv);
    await tv.page.locator('.details-episodes [data-focus="episode:s1e12"]').click({ button: "right" });
    const panel = tv.page.getByRole("dialog", { name: "Card actions", exact: true });
    await panel.waitFor();
    assert.equal(starts(tv).length, 0);
    assert.equal(await panel.locator('[data-focus="episode-information"]').count(), 1, "episode information remains an explicit choice");
    await panel.locator('[data-focus="episode-information"]').click();
    await tv.page.locator('[data-view="item:episode:s1e12"]').waitFor();
    await tv.page.locator('[data-focus="audio"]').click();
    assert.equal(await tv.page.getByRole("radio", { name: /Japanese/ }).count(), 1);
    assert.equal(starts(tv).length, 0);
});

preplay("series primary action resumes its actual numbered episode directly", async (tv, catalog, playback) => {
    catalog.fileIds.set("episode:s1e11", "42");
    catalog.progress.set("episode:s1e11", 630);
    playback.items.set("episode:s1e11", ["42"]);
    await series(tv);
    const primary = tv.page.locator('[data-focus="next-episode"]');
    assert.equal(await primary.textContent(), "Resume S1:E1");
    await primary.click();
    await prepare(tv);
    assert.equal(starts(tv).length, 1);
    assert.equal(starts(tv)[0]?.body?.file_id, "42");
    assert.equal(tv.fake.requests.filter(request => request.path === "/watch/episode%3As1e11?file_id=42").length, 2);
    assert.equal(starts(tv)[0]?.body?.start_position, 630);
});

for (const activation of ["rail", "primary", "start-over"] as const) preplay(`direct ${activation} resolves saved Auto subtitle preferences before playback`, async (tv, catalog, playback) => {
    const id = activation === "rail" ? "episode:s1e12" : "episode:s1e11";
    catalog.fileIds.set(id, "42");
    catalog.progress.set(id, 630);
    playback.items.set(id, ["42"]);
    await series(tv);
    const path = `/watch/${encodeURIComponent(id)}?file_id=42`;
    const reply = catalog.route("GET", path, "p-owner");
    assert.ok(reply);
    assert.ok(typeof reply.body === "object" && reply.body !== null);
    const preference = { status: 200, body: { ...reply.body, effective_subtitle_mode: "always", effective_subtitle_language: "fr", effective_show_forced_subtitles: false } };
    tv.fake.script(path, ...(activation === "start-over" ? [preference] : [reply, preference]));
    await tv.page.locator(activation === "rail" ? '.details-episodes [data-focus="episode:s1e12"]' : activation === "primary" ? '[data-focus="next-episode"]' : '[data-focus="start-over-episode"]').click();
    await prepare(tv);
    assert.equal(tv.fake.requests.filter(request => request.path === path).length, activation === "start-over" ? 1 : 2, "Auto reads effective preferences in addition to resume preparation");
    const replan = tv.fake.requests.find(request => request.path.endsWith("/replan"));
    assert.deepEqual(replan?.body?.selected_tracks, { audio: { id: "file:42:audio:2", index: 2 }, subtitle: { id: "file:42:subtitle:3" } });
});

for (const phase of ["catalog", "watch"] as const) {
    preplay(`direct episode ${phase} resolution ignores duplicate Select and an abandoned late answer`, async (tv, catalog) => {
        catalog.fileIds.set("episode:s1e12", "42");
        await series(tv);
        const path = phase === "catalog" ? "/catalog/items/episode%3As1e12?image_size=large" : "/watch/episode%3As1e12?file_id=42";
        const before = tv.fake.requests.filter(request => request.path === path).length;
        const held = tv.fake.hold(path, true);
        await tv.page.evaluate(() => {
            const card = document.querySelector<HTMLButtonElement>('.details-episodes [data-focus="episode:s1e12"]');
            if (card === null) throw new Error("episode card missing");
            card.focus(); card.click(); card.click();
        });
        await tv.eventually(async () => tv.fake.requests.filter(request => request.path === path).length > before, "held episode read");
        assert.equal(tv.fake.requests.filter(request => request.path === path).length, before + 1);
        assert.equal(starts(tv).length, 0);
        await tv.remote(10009);
        await tv.page.locator('[data-view="item:series:s1"]').waitFor();
        held.release();
        await tv.jump(4000);
        assert.equal(starts(tv).length, 0);
        assert.equal(await tv.page.locator(".player").count(), 0);
        assert.equal(await tv.focused(), "episode:s1e12");
    });
}

preplay("direct episode malformed watch offers Retry for the same target without an information page", async (tv, catalog, playback) => {
    catalog.fileIds.set("episode:s1e12", "42");
    playback.items.set("episode:s1e12", ["42"]);
    await series(tv);
    tv.fake.script("/watch/episode%3As1e12?file_id=42", { status: 200, body: { content_id: "episode:s1e12", type: "episode", versions: [] } });
    await tv.page.locator('.details-episodes [data-focus="episode:s1e12"]').click();
    const retry = tv.page.getByRole("button", { name: "Try again", exact: true });
    await retry.waitFor();
    assert.equal(starts(tv).length, 0);
    assert.equal(await tv.page.locator('[data-view="item:episode:s1e12"]').count(), 0);
    await retry.click();
    await prepare(tv);
    assert.equal(starts(tv).length, 1);
    assert.equal(starts(tv)[0]?.body?.file_id, "42");
});

preplay("series Start Over skips fresh resume and retains automatic selectors", async (tv, catalog, playback) => {
    catalog.fileIds.set("episode:s1e11", "42");
    catalog.progress.set("episode:s1e11", 630);
    playback.items.set("episode:s1e11", ["42"]);
    await series(tv);
    const before = tv.fake.requests.filter(request => request.path.startsWith("/watch/")).length;
    await tv.page.locator('[data-focus="start-over-episode"]').click();
    await prepare(tv);
    assert.equal(starts(tv).length, 1);
    assert.equal(starts(tv)[0]?.body?.start_position, 0);
    assert.equal(tv.fake.requests.filter(request => request.path.startsWith("/watch/")).length, before + 1, "Start Over reads subtitle preferences but does not look up resume");
});

for (const failure of ["identity", "files"] as const) {
    preplay(`direct episode ${failure} failure keeps Retry and Back without playback`, async (tv, catalog) => {
        await series(tv);
        const reply = catalog.route("GET", "/catalog/items/episode%3As1e12", "p-owner");
        assert.ok(reply);
        assert.ok(typeof reply.body === "object" && reply.body !== null);
        tv.fake.script("/catalog/items/episode%3As1e12?image_size=large", { status: 200, body: { ...reply.body, ...(failure === "identity" ? { content_id: "wrong-target" } : { versions: [] }) } });
        await tv.page.locator('.details-episodes [data-focus="episode:s1e12"]').click();
        await tv.page.getByRole("button", { name: "Try again", exact: true }).waitFor();
        assert.equal(starts(tv).length, 0);
        assert.equal(await tv.page.locator('[data-view="item:episode:s1e12"]').count(), 0);
        await tv.remote(10009);
        await tv.page.locator('[data-view="item:series:s1"]').waitFor();
        assert.equal(await tv.focused(), "episode:s1e12");
    });
}

preplay("direct activation accepts an opaque episode identity and its server-selected file", async (tv, catalog, playback) => {
    const id = "broadcast_7a";
    catalog.add({ id, title: "Opaque episode", type: "episode", libraryId: "13", seriesId: "series:s1", season: 1, episode: 4 });
    catalog.fileIds.set(id, "43");
    playback.items.set(id, ["43"]);
    await series(tv);
    await tv.page.locator('.details-episodes [data-focus="broadcast_7a"]').click();
    await prepare(tv);
    assert.equal(starts(tv).length, 1);
    assert.equal(starts(tv)[0]?.body?.file_id, "43");
    assert.equal(tv.fake.requests.filter(request => request.path === "/watch/broadcast_7a?file_id=43").length, 2);
    assert.equal(starts(tv)[0]?.body?.audio_track_id, undefined);
});

preplay("destroy during direct episode preparation rejects an already processed late answer", async (tv, catalog) => {
    catalog.fileIds.set("episode:s1e12", "42");
    await series(tv);
    const path = "/watch/episode%3As1e12?file_id=42";
    const held = tv.fake.hold(path, true);
    await tv.page.locator('.details-episodes [data-focus="episode:s1e12"]').click();
    await tv.eventually(async () => tv.fake.requests.some(request => request.path === path), "held watch before teardown");
    await tv.page.evaluate(() => window.appHarness.destroy());
    held.release();
    await tv.jump(4000);
    assert.equal(starts(tv).length, 0);
    assert.equal(await tv.page.locator(".player").count(), 0);
});

for (const reduced of [false, true]) {
    preplay(`production ${reduced ? "reduced" : "normal"}: remote Audio focus, captured Resume and one handoff`, async (tv, catalog) => {
        await tv.page.locator('[data-focus="audio"]').focus();
        await tv.page.keyboard.press("Enter");
        assert.equal(await tv.focused(), "audio:auto");
        await tv.remote(40);
        await tv.remote(40);
        await tv.page.keyboard.press("Enter");
        assert.equal(await tv.focused(), "audio");
        assert.equal(await tv.page.getByRole("dialog", { name: "Audio" }).count(), 0);
        await savedAudio(tv);
        catalog.progress.set("movie:m0001", 2400.25);
        const held = tv.fake.hold(WATCH, true);
        await tv.page.locator('[data-focus="resume"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("status").filter({ hasText: "Checking resume position" }).waitFor();
        await tv.page.keyboard.press("Enter");
        await tv.page.locator('[data-focus="version"]').click();
        await tv.page.locator('[data-focus="version:43"]').click();
        await tv.page.locator('[data-focus="audio"]').click();
        await tv.page.getByRole("radio", { name: /English Dub/ }).click();
        assert.equal(starts(tv).length, 0);
        held.release();
        await prepare(tv);
        assert.equal(starts(tv).length, 1);
        const body = starts(tv)[0]?.body;
        assert.equal(body?.file_id, "42");
        assert.equal(body?.audio_track_id, "file:42:audio:1");
        assert.equal(body?.start_position, 2400.25);
        assert.equal(body?.allow_alternate_versions, undefined);
        await tv.remote(10009);
        await tv.page.locator('[data-focus="play"]').waitFor();
        assert.equal(await tv.focused(), "play", "the initiating Resume disappeared on the newly selected short version");
        assert.equal(starts(tv).length, 1);
    }, true, reduced);
}

preplay("Auto keeps initial selectors omitted and resolves subtitles before adopting the server audio preference", async (tv) => {
    await tv.page.locator('[data-focus="audio"]').click();
    await tv.remote(10009);
    assert.equal(await tv.focused(), "audio");
    assert.equal(await tv.page.locator('[data-focus="subtitles"]').count(), 1);
    await tv.page.locator('[data-focus="play"]').click();
    await prepare(tv);
    const body = starts(tv)[0]?.body;
    for (const field of ["audio_track_id", "audio_track_index", "subtitle_track_id", "subtitle_track_index", "allow_alternate_versions"]) assert.equal(Object.prototype.hasOwnProperty.call(body, field), false, field);
    await tv.page.getByRole("button", { name: "Audio and subtitles", exact: true }).click();
    assert.equal(await tv.page.locator('[data-focus="file:42:audio:2"]').getAttribute("aria-pressed"), "true");
});

preplay("version change clears old audio, pins the new file and allows a fresh explicit pick", async (tv) => {
    await tv.page.locator('[data-focus="audio"]').click();
    await tv.page.getByRole("radio", { name: /Japanese/ }).click();
    await savedAudio(tv);
    await tv.page.locator('[data-focus="version"]').click();
    await tv.page.locator('[data-focus="version:43"]').click();
    assert.equal(await tv.page.locator('[data-focus="audio"]').textContent(), "Audio Tracks");
    assert.equal(await tv.page.locator('[data-focus="audio"]').getAttribute('aria-label'), 'Audio: Auto');
    await tv.page.locator('[data-focus="audio"]').click();
    assert.equal(await tv.page.getByRole("radio").count(), 3);
    await tv.page.getByRole("radio", { name: /English Dub/ }).click();
    await savedAudio(tv);
    await tv.page.locator('[data-focus="play"]').click();
    await prepare(tv);
    assert.equal(starts(tv)[0]?.body?.file_id, "43");
    assert.equal(starts(tv)[0]?.body?.audio_track_id, "file:43:audio:1");
    assert.equal(starts(tv)[0]?.body?.allow_alternate_versions, false);
});

preplay("Details subtitles resolve a catalog stream choice through the server inventory and restore their trigger", async tv => {
    await tv.page.locator('[data-focus="subtitles"]').focus();
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.focused(), "subtitle:auto");
    await tv.remote(40); await tv.remote(40);
    assert.equal(await tv.focused(), "subtitle:0");
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.focused(), "subtitles");
    await savedSubtitle(tv);
    const saved = tv.fake.requests.find(request => request.method === "PUT" && request.path === "/subtitle-prefs/movie%3Am0001");
    assert.equal(saved?.body?.subtitle_track_index, 97);
    assert.equal(saved?.body?.subtitle_mode, "always");
    assert.equal(Object.hasOwn(saved?.body ?? {}, "show_forced_subtitles"), false);
    await tv.page.locator('[data-focus="play"]').click();
    await prepare(tv);
    assert.equal(starts(tv)[0]?.body?.subtitle_track_id, undefined);
    const change = tv.fake.requests.find(request => request.path.endsWith("/replan"));
    assert.deepEqual(change?.body?.selected_tracks, { audio: { id: "file:42:audio:2", index: 2 }, subtitle: { id: "file:42:subtitle:1" } });
    await tv.remote(10009);
    await tv.page.locator('[data-focus="subtitles"]').click();
    assert.equal(await tv.page.locator('[data-focus="subtitle:0"]').getAttribute("aria-checked"), "true");
    await tv.remote(10009);
    await tv.page.locator('[data-focus="version"]').click();
    await tv.page.locator('[data-focus="version:43"]').click();
    assert.equal(await tv.page.locator('[data-focus="subtitles"]').getAttribute("aria-label"), "Subtitles: Auto");
}, true, false, catalog => catalog.subtitleFiles.set("42", [{ index: 97, external: false, language: "eng", codec: "ass", title: "English (Signs)", forced: true }]));

preplay("fresh no-progress wins over cached Resume", async (tv, catalog) => {
    catalog.progress.delete("movie:m0001");
    await tv.page.locator('[data-focus="resume"]').click();
    await prepare(tv);
    assert.equal(starts(tv)[0]?.body?.start_position, 0);
});

preplay("Resume remains usable while the playback-return Details refresh is pending", async (tv) => {
    await tv.page.locator('[data-focus="audio"]').click();
    await tv.page.getByRole("radio", { name: /Japanese/ }).click();
    await savedAudio(tv);
    await tv.page.locator('[data-focus="play"]').click();
    await prepare(tv);
    const held = tv.fake.hold("/catalog/items/movie%3Am0001", true);
    await tv.remote(10009);
    const fresh = tv.fake.hold(WATCH, true);
    await tv.page.locator('[data-focus="resume"]').click();
    try {
        await tv.page.getByRole("status").filter({ hasText: "Checking resume position" }).waitFor({ timeout: 1000 });
        fresh.release();
        await prepare(tv);
        assert.equal(starts(tv).length, 2);
        assert.equal(starts(tv)[1]?.body?.audio_track_id, "file:42:audio:1");
        assert.equal(starts(tv)[1]?.body?.start_position, 1200.5);
    } finally { fresh.release(); held.release(); }
});

preplay("episode Details uses its file audio and restores the initiating Resume action", async (tv, catalog, playback) => {
    catalog.fileIds.set("episode:s1e12", "42");
    catalog.progress.set("episode:s1e12", 420);
    playback.items.set("episode:s1e12", ["42"]);
    await tv.remote(10009);
    await tv.page.locator('[data-view="home"] .browse-card[data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="season:1"]').click();
    await tv.page.locator('[data-focus="episode:s1e12"]').click({ button: "right" });
    await tv.page.locator('[data-focus="episode-information"]').click();
    await tv.page.locator('[data-focus="audio"]').click();
    await tv.page.getByRole("radio", { name: /Japanese/ }).click();
    await savedAudio(tv);
    await tv.page.locator('[data-focus="resume"]').click();
    await prepare(tv);
    assert.equal(starts(tv)[0]?.body?.file_id, "42");
    assert.equal(starts(tv)[0]?.body?.audio_track_id, "file:42:audio:1");
    assert.equal(starts(tv)[0]?.body?.start_position, 420);
    await tv.remote(10009);
    await tv.page.locator('[data-focus="resume"]').waitFor();
    assert.equal(await tv.focused(), "resume");
});

preplay("network-only watch failure uses cached Resume with explicit subtitle Off without changing authority", async (tv) => {
    await tv.page.locator('[data-focus="subtitles"]').click();
    await tv.page.locator('[data-focus="subtitle:off"]').click();
    await savedSubtitle(tv);
    await tv.page.route("**/api/v2/watch/movie%3Am0001?file_id=42", route => route.abort("internetdisconnected"));
    await tv.page.locator('[data-focus="resume"]').click();
    await tv.jump(3000);
    await prepare(tv);
    assert.equal(starts(tv).length, 1);
    assert.equal(starts(tv)[0]?.body?.start_position, 1200.5);
});

preplay("Back during a pending watch read prevents every start, including its late answer", async (tv) => {
    const held = tv.fake.hold(WATCH, true);
    await tv.page.locator('[data-focus="resume"]').click();
    await tv.eventually(async () => tv.fake.requests.some(r => r.path === WATCH), "watch read");
    await tv.remote(10009);
    await tv.page.locator('[data-view="home"]').waitFor();
    held.release();
    await tv.jump(4000);
    assert.equal(starts(tv).length, 0);
    assert.equal(await tv.page.locator(".player").count(), 0);
});

preplay("malformed watch offers a reachable retry without fabricating playback", async (tv, catalog) => {
    tv.fake.script(WATCH, { status: 200, body: { content_id: "movie:m0001", type: "movie", versions: [] } });
    await tv.page.locator('[data-focus="resume"]').click();
    await tv.page.getByRole("button", { name: "Try again", exact: true }).waitFor();
    assert.equal(starts(tv).length, 0);
    await tv.page.locator('[data-focus="retry-play"]').focus();
    catalog.progress.set("movie:m0001", 1300);
    await tv.page.keyboard.press("Enter");
    await prepare(tv);
    assert.equal(starts(tv).length, 1);
    assert.equal(starts(tv)[0]?.body?.start_position, 1300);
});

preplay("bounded unavailable watch uses cached progress once and ignores a late success", async (tv) => {
    const held = tv.fake.hold(WATCH, true);
    await tv.page.locator('[data-focus="resume"]').click();
    await tv.eventually(async () => tv.fake.requests.some(r => r.path === WATCH), "watch read");
    await tv.page.keyboard.press("Enter");
    await tv.jump(2999);
    assert.equal(starts(tv).length, 0);
    await tv.jump(1);
    await prepare(tv);
    assert.equal(starts(tv).length, 1);
    assert.equal(starts(tv)[0]?.body?.start_position, 1200.5);
    held.release();
    await tv.jump(1000);
    assert.equal(starts(tv).length, 1);
});

preplay("preplay explicit audio reaches the one production start", async (tv) => {
    const audio = tv.page.locator('[data-focus="audio"]');
    assert.equal(await audio.count(), 1, "Details exposes the audio trigger");
    await audio.click();
    await tv.page.getByRole("radio", { name: /Japanese/ }).click();
    await savedAudio(tv);
    await tv.page.locator('[data-focus="play"]').click();
    await tv.eventually(async () => tv.fake.requests.some(r => r.path === "/playback/start"), "start POST");
    assert.equal(tv.fake.requests.find(r => r.path === "/playback/start")?.body?.audio_track_id, "file:42:audio:1");
});

for (const reduced of [false, true]) {
    preplay(`overflowing Audio options stay visible under remote focus in ${reduced ? "reduced" : "normal"} motion`, async (tv, catalog) => {
        const file = catalog.audioFiles.get("42");
        assert.ok(file);
        catalog.audioFiles.set("42", { ...file, audio: Array.from({ length: 16 }, (_, index) => ({ default: index === 0, language: "en", title: `Audio ${index + 1}` })) });
        await tv.remote(10009);
        await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
        await tv.page.locator('[data-focus="audio"]').click();
        assert.equal(await tv.focused(), "audio:auto");
        const visible = () => tv.page.evaluate(() => {
            const panel = document.querySelector<HTMLElement>(".details-audio-picker");
            const option = document.activeElement;
            if (panel === null || !(option instanceof HTMLElement)) throw new Error("audio focus missing");
            const p = panel.getBoundingClientRect();
            const o = option.getBoundingClientRect();
            return { visible: o.top >= p.top && o.bottom <= p.bottom, scrollTop: panel.scrollTop };
        });
        for (let index = 0; index < 16; index++) await tv.remote(40);
        await tv.jump(250);
        assert.equal(await tv.focused(), "audio:15");
        assert.equal((await visible()).visible, true, "the focused final track is inside the picker viewport");
        assert.ok((await visible()).scrollTop > 0);
        for (let index = 0; index < 16; index++) await tv.remote(38);
        await tv.jump(250);
        assert.equal(await tv.focused(), "audio:auto");
        assert.equal((await visible()).visible, true, "Auto is visible again after moving upward");
        await tv.remote(10009);
        assert.equal(await tv.focused(), "audio");
        assert.equal(starts(tv).length, 0);
    }, true, reduced);
}

preplay("missing watch duration shows Retry without a start and a valid retry retains the end margin", async (tv, catalog) => {
    catalog.progress.set("movie:m0001", 5398);
    tv.fake.script(WATCH, { status: 200, body: { content_id: "movie:m0001", type: "movie", versions: [{ file_id: "42" }], user_data: { played: false, position_seconds: 5398 } } });
    await tv.page.locator('[data-focus="resume"]').click();
    await tv.page.getByRole("button", { name: "Try again", exact: true }).waitFor();
    assert.equal(starts(tv).length, 0);
    await tv.page.locator('[data-focus="retry-play"]').click();
    await prepare(tv);
    assert.equal(starts(tv).length, 1);
    assert.equal(starts(tv)[0]?.body?.start_position, 0);
});
