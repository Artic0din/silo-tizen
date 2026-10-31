import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakePlayback } from "../native/support/fakePlayback.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

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
    await tv.page.locator('[data-focus="profile:p-owner"]').click();
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="resume"]').waitFor();
}

function preplay(name: string, body: (tv: Tv, catalog: FakeDetails, playback: FakePlayback) => Promise<void>, production = true, reduced = false): void {
    test(name, async () => {
        const tv = await openTv(browser, { app: "application", production });
        const catalog = new FakeDetails();
        catalog.progress.set("movie:m0001", 1200.5);
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
const starts = (tv: Tv) => tv.fake.requests.filter(r => r.path === "/playback/start");

async function prepare(tv: Tv): Promise<void> {
    await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.pendingPrepares > 0), "AVPlay preparation");
    await tv.page.evaluate(() => {
        const avplay = window.appHarness.avplay;
        avplay.finishPrepare();
        if (avplay.calls[avplay.calls.length - 1]?.startsWith("seekTo")) avplay.finishSeek();
    });
    await tv.page.getByRole("slider").waitFor();
}

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
        catalog.progress.set("movie:m0001", 2400.25);
        const held = tv.fake.hold(WATCH, true);
        await tv.page.locator('[data-focus="resume"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("status").filter({ hasText: "Checking resume position" }).waitFor();
        await tv.page.keyboard.press("Enter");
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

preplay("Auto omits audio and subtitles while the returned menu adopts the nonzero server preference", async (tv) => {
    await tv.page.locator('[data-focus="audio"]').click();
    await tv.remote(10009);
    assert.equal(await tv.focused(), "audio");
    assert.equal(await tv.page.locator('[data-focus*="subtitle"]').count(), 0);
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
    await tv.page.locator('[data-focus="version:43"]').click();
    assert.equal(await tv.page.locator('[data-focus="audio"]').textContent(), "Audio: Auto");
    await tv.page.locator('[data-focus="audio"]').click();
    assert.equal(await tv.page.getByRole("radio").count(), 3);
    await tv.page.getByRole("radio", { name: /English Dub/ }).click();
    await tv.page.locator('[data-focus="play"]').click();
    await prepare(tv);
    assert.equal(starts(tv)[0]?.body?.file_id, "43");
    assert.equal(starts(tv)[0]?.body?.audio_track_id, "file:43:audio:1");
    assert.equal(starts(tv)[0]?.body?.allow_alternate_versions, false);
});

preplay("fresh no-progress wins over cached Resume", async (tv, catalog) => {
    catalog.progress.delete("movie:m0001");
    await tv.page.locator('[data-focus="resume"]').click();
    await prepare(tv);
    assert.equal(starts(tv)[0]?.body?.start_position, 0);
});

preplay("Resume remains usable while the playback-return Details refresh is pending", async (tv) => {
    await tv.page.locator('[data-focus="audio"]').click();
    await tv.page.getByRole("radio", { name: /Japanese/ }).click();
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
    await tv.page.locator('[data-focus="episode:s1e12"]').click();
    await tv.page.locator('[data-focus="audio"]').click();
    await tv.page.getByRole("radio", { name: /Japanese/ }).click();
    await tv.page.locator('[data-focus="resume"]').click();
    await prepare(tv);
    assert.equal(starts(tv)[0]?.body?.file_id, "42");
    assert.equal(starts(tv)[0]?.body?.audio_track_id, "file:42:audio:1");
    assert.equal(starts(tv)[0]?.body?.start_position, 420);
    await tv.remote(10009);
    await tv.page.locator('[data-focus="resume"]').waitFor();
    assert.equal(await tv.focused(), "resume");
});

preplay("network-only watch failure uses the cached Resume without changing authority", async (tv) => {
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
