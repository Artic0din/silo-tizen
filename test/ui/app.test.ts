import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakePlayback } from "../native/support/fakePlayback.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

function appTest(name: string, body: (tv: Tv, playback: FakePlayback, catalog: FakeCatalog) => Promise<void>, production = false): void {
    test(name, async () => {
        const tv = await openTv(browser, { app: "application", production });
        const catalog = new FakeCatalog();
        catalog.fileIds.set("movie:m0001", "42");
        catalog.fileIds.set("movie:k1", "42");
        tv.fake.catalog = catalog;
        const playback = new FakePlayback(tv.fake);
        playback.items.set("movie:m0001", ["42"]);
        playback.items.set("movie:k1", ["42"]);
        try {
            await body(tv, playback, catalog);
            assert.deepEqual(tv.console, []);
        } finally {
            await tv.page.context().close();
        }
    });
}

async function signIn(tv: Tv): Promise<void> {
    await tv.page.fill("#signin-address", "silo.example.test");
    await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
    await tv.page.locator('[data-screen="code"]').waitFor();
    const code = [...tv.fake.devices.keys()].pop();
    assert.ok(code !== undefined);
    tv.fake.approve(code);
    await tv.jump(5000);
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    await tv.page.locator('[data-focus="profile:p-owner"]').click();
    await tv.page.locator('[data-view="home"] [data-focus="movie:m0001"]').first().waitFor();
}

async function startMovie(tv: Tv, id = "movie:m0001"): Promise<void> {
    await tv.page.locator(`[data-focus="${id}"]`).first().click();
    await tv.page.locator('[data-focus="play"]').click();
    await prepare(tv);
}

async function prepare(tv: Tv): Promise<void> {
    await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.pendingPrepares > 0), "AVPlay preparation");
    await tv.page.evaluate(() => {
        const avplay = window.appHarness.avplay;
        avplay.finishPrepare();
        if (avplay.calls[avplay.calls.length - 1]?.startsWith("seekTo") === true) {
            avplay.finishSeek();
        }
    });
    await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.state === "PLAYING"), "playback");
}

appTest("the composed app signs in, selects a profile, plays and returns to the same title", async (tv, playback) => {
    await signIn(tv);
    await startMovie(tv);
    assert.equal(await tv.page.locator(".browse").isVisible(), false);
    assert.equal(await tv.page.locator("object.player-video").count(), 1);
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.state), "PAUSED");
    await tv.remote(10009);
    await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
    assert.equal(await tv.focused(), "play");
    assert.equal(await tv.page.locator('[data-screen="player"]').count(), 0);
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.state), "NONE");
    await tv.eventually(async () => [...playback.sessions.values()].every((session) => session.receipt !== undefined), "final stop receipt");
}, true);

appTest("completion and dismissed playback errors return to browse without opening an exit dialog", async (tv) => {
    await signIn(tv);
    await startMovie(tv);
    await tv.page.evaluate(() => window.appHarness.avplay.listener?.onstreamcompleted());
    await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
    await tv.page.locator('[data-focus="play"]').click();
    await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.pendingPrepares > 0), "second preparation");
    await tv.page.evaluate(() => window.appHarness.avplay.finishPrepare("InvalidAccessError"));
    await tv.page.locator(".player-error").waitFor();
    await tv.remote(10009);
    await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
    assert.equal(await tv.page.getByRole("dialog").count(), 0);
});

appTest("the composed remote seeks and changes audio through the real playback owner", async (tv, playback) => {
    await signIn(tv);
    await startMovie(tv);
    await tv.page.evaluate(() => window.appHarness.avplay.tick(90000));
    await tv.page.keyboard.press("ArrowLeft");
    await tv.page.evaluate(() => window.appHarness.avplay.finishSeek());
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.positionMs), 80000);
    await tv.page.keyboard.press("ArrowDown");
    const id = [...playback.sessions.keys()][0];
    assert.ok(id !== undefined);
    const hold = tv.fake.hold(`/playback/${id}/replan`);
    await tv.page.locator('.player-menu [data-focus="file:42:audio:1"]').click();
    assert.equal(await tv.page.locator(".player-menu-status").innerText(), "Changing track", "a track button click must activate the same change as remote Enter");
    hold.release();
    await prepare(tv);
    const session = [...playback.sessions.values()][0];
    assert.equal(session?.audioIndex, 1);
    const change = tv.fake.requests.filter((request) => request.path.endsWith("/replan")).pop();
    assert.equal(change?.body?.operation, "track_change");
    assert.equal(change?.body?.position_seconds, 80);
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.page.locator('.player-menu [data-focus="file:42:audio:1"]').getAttribute("aria-pressed"), "true");
    await tv.remote(10009);
    assert.equal(await tv.page.locator(".player-menu").isVisible(), false);
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.state), "PLAYING", "menu Back does not exit playback");
});

appTest("destroy during preparation is idempotent and late callbacks cannot replace a restored picker", async (tv) => {
    await signIn(tv);
    await tv.page.locator('[data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="play"]').click();
    await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.pendingPrepares > 0), "held preparation");
    await tv.page.evaluate(() => { window.appHarness.destroy(); window.appHarness.destroy(); window.appHarness.mount(); });
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    await tv.page.evaluate(() => { window.appHarness.avplay.finishPrepare(); window.appHarness.avplay.listener?.onstreamcompleted(); });
    assert.equal(await tv.screen(), "profiles");
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.state), "NONE");
    assert.equal(await tv.focused(), "profile:p-owner");
});

appTest("native posters keep their shape and the exit modal covers the viewport", async (tv) => {
    await signIn(tv);
    const poster = await tv.page.locator('.browse-card:not(.skyline-continue) .browse-art').first().boundingBox();
    assert.ok(poster !== null);
    assert.ok(Math.abs(poster.height / poster.width - 1.5) < 0.001);
    await tv.remote(10009);
    assert.equal(await tv.focused(), "home");
    assert.equal(await tv.page.getByRole("dialog").count(), 0);
    await tv.remote(10009);
    const dialog = await tv.page.getByRole("dialog").boundingBox();
    assert.deepEqual(dialog, { x: 0, y: 0, width: 1920, height: 1080 });
    const exit = await tv.page.getByRole("button", { name: "Exit", exact: true }).boundingBox();
    const cancel = await tv.page.getByRole("button", { name: "Cancel", exact: true }).boundingBox();
    assert.ok(exit !== null && cancel !== null);
    assert.ok(cancel.x - exit.x - exit.width >= 24);
    assert.ok(cancel.y + cancel.height <= 1080);
});

appTest("a profile-proof refusal stops playback and leaves the PIN successor intact", async (tv) => {
    await signIn(tv);
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.locator('[data-focus="switch-profile"]').click();
    await tv.page.getByRole("button", { name: "Kid, PIN protected", exact: true }).waitFor();
    await tv.page.locator('[data-focus="profile:p-kid"]').click();
    await tv.page.fill("#profile-pin", "2468");
    await tv.page.getByRole("button", { name: "Unlock", exact: true }).click();
    await tv.page.locator('[data-view="home"] [data-focus="movie:k1"]').waitFor();
    await startMovie(tv, "movie:k1");
    tv.fake.changePin("p-kid", "1357");
    await tv.jump(10000);
    await tv.page.locator('[data-screen="pin"]').waitFor();
    assert.equal(await tv.page.locator('[data-screen="player"]').count(), 0);
    assert.equal(await tv.page.locator(".browse").count(), 0);
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.state), "NONE");
    await tv.page.evaluate(() => window.appHarness.avplay.listener?.onstreamcompleted());
    assert.equal(await tv.screen(), "pin", "stale completion cannot repaint over the PIN screen");
});

appTest("sign-out returns its notice to entry and relaunch cannot restore the removed account", async (tv) => {
    await signIn(tv);
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.locator('[data-focus="switch-profile"]').click();
    await tv.page.getByRole("button", { name: "Sign out", exact: true }).click();
    await tv.page.locator('[data-screen="entry"]').waitFor();
    await tv.page.evaluate(() => window.appHarness.mount());
    await tv.page.locator('[data-screen="code"]').waitFor();
    assert.equal(await tv.page.locator('[data-screen="profiles"]').count(), 0);
    assert.equal(await tv.page.locator(".browse").count(), 0);
});

appTest("relaunch restores the protected account but still asks who is watching", async (tv) => {
    await signIn(tv);
    await tv.page.evaluate(() => window.appHarness.mount());
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    assert.equal(await tv.page.locator('[data-screen="code"]').count(), 0);
    assert.equal(await tv.focused(), "profile:p-owner");
    assert.equal(await tv.page.locator(".browse").count(), 0);
});

appTest("root Back opens an isolated exit dialog; Cancel restores focus and Exit tears down", async (tv) => {
    await tv.remote(10009);
    await tv.page.getByRole("dialog").waitFor();
    assert.equal(await tv.focused(), "cancel-exit");
    await tv.page.keyboard.press("ArrowLeft");
    assert.equal(await tv.focused(), "exit");
    await tv.remote(10009);
    assert.equal(await tv.page.getByRole("dialog").count(), 0);
    assert.equal(await tv.focused(), "address");
    await signIn(tv);
    const focused = await tv.focused();
    const requests = tv.fake.requests.length;
    await tv.remote(10009);
    assert.equal(await tv.focused(), "home");
    assert.equal(await tv.page.getByRole("dialog").count(), 0);
    await tv.remote(10009);
    await tv.page.keyboard.press("ArrowDown");
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(tv.fake.requests.length, requests, "modal keys never reach browse");
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.focused(), "home");
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), focused);
    await tv.remote(10009);
    await tv.remote(10009);
    await tv.page.keyboard.press("ArrowLeft");
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.page.evaluate(() => window.appHarness.exits), 1);
    assert.equal(await tv.page.locator("#root").evaluate((root) => root.childElementCount), 0);
    await tv.remote(10009);
    assert.equal(await tv.page.getByRole("dialog").count(), 0, "teardown removed the app key listener");
});

appTest("library scope survives a full app remount for the same server and profile", async (tv, _playback, catalog) => {
    const owner = catalog.households.get("p-owner");
    assert.ok(owner !== undefined);
    owner.hidden = null;
    await signIn(tv);
    await tv.page.locator('[data-focus="movies"]').focus();
    await tv.jump(250);
    await tv.page.locator('[data-focus="library:15"]').click();
    await tv.page.locator('[data-view="library:15"]').waitFor();
    await tv.page.evaluate(() => window.appHarness.mount());
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    await tv.page.locator('[data-focus="profile:p-owner"]').click();
    await tv.page.locator('[data-view="home"]').waitFor();
    await tv.page.locator('[data-focus="movies"]').click();
    await tv.page.locator('[data-view="library:15"]').waitFor();
    assert.equal(await tv.page.locator('.browse .skyline-scope').innerText(), "Archive");
});

appTest("the profile menu opens without changing content, stays dismissed after Back and signs out through its owner", async (tv) => {
    await signIn(tv);
    await tv.page.clock.pauseAt(await tv.page.evaluate(() => Date.now() + 1000));
    const requests = tv.fake.requests.length;
    await tv.page.locator('[data-focus="profiles"]').focus();
    await tv.jump(249);
    assert.equal(await tv.page.locator(".skyline-selector").first().isVisible(), false);
    await tv.jump(1);
    assert.equal(await tv.page.locator(".skyline-selector").first().isVisible(), true);
    assert.equal(await tv.focused(), "profiles");
    assert.equal(tv.fake.requests.length, requests);
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), "switch-profile");
    await tv.remote(10009);
    await tv.jump(500);
    assert.equal(await tv.page.locator(".skyline-selector").first().isVisible(), false);
    assert.equal(await tv.focused(), "profiles");
    await tv.page.keyboard.press("Enter");
    await tv.page.keyboard.press("ArrowDown");
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), "signout");
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-screen="entry"]').waitFor();
    assert.equal(tv.fake.revokedSessions.size, 1);
    assert.equal(await tv.page.locator(".browse").count(), 0);
});

appTest("an exit failure keeps the dialog usable and Cancel restores the app", async (tv) => {
    await tv.page.evaluate(() => window.appHarness.failExit());
    await tv.remote(10009);
    await tv.page.keyboard.press("ArrowLeft");
    await tv.page.keyboard.press("Enter");
    await tv.page.getByRole("alert").waitFor();
    await tv.remote(10009);
    assert.equal(await tv.focused(), "address");
    assert.equal(await tv.page.evaluate(() => window.appHarness.exits), 0);
});

appTest("profile loading cannot remove the exit dialog or steal its focus", async (tv) => {
    const hold = tv.fake.hold("/profiles");
    await tv.page.fill("#signin-address", "silo.example.test");
    await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
    await tv.page.locator('[data-screen="code"]').waitFor();
    const code = [...tv.fake.devices.keys()].pop();
    assert.ok(code !== undefined);
    tv.fake.approve(code);
    await tv.jump(5000);
    await tv.page.locator('[data-screen="profiles-loading"]').waitFor();
    await tv.remote(10009);
    await tv.page.getByRole("dialog").waitFor();
    await tv.page.keyboard.press("ArrowLeft");
    assert.equal(await tv.focused(), "exit");
    hold.release();
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    assert.equal(await tv.page.getByRole("dialog").isVisible(), true, "screen updates must preserve the modal");
    assert.equal(await tv.focused(), "exit", "screen updates must preserve modal focus");
    await tv.page.keyboard.press("ArrowRight");
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.page.getByRole("dialog").count(), 0);
    assert.equal(await tv.focused(), "profile:p-owner");
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-view="home"]').waitFor();
    assert.equal(await tv.page.evaluate(() => window.appHarness.exits), 0);
});

appTest("missing AVPlay gives a usable Back state without creating a playback session", async (tv, playback) => {
    await tv.page.evaluate(() => window.appHarness.mount(false));
    await signIn(tv);
    await tv.page.locator('[data-focus="movie:m0001"]').first().click();
    await tv.page.locator('[data-focus="play"]').click();
    await tv.page.getByRole("heading", { name: "Playback unavailable", exact: true }).waitFor();
    assert.equal(playback.sessions.size, 0);
    await tv.remote(10009);
    await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
    assert.equal(await tv.focused(), "play");
});

test("the production entry uses platform ports and stops at the native sign-in screen", async () => {
    const tv = await openTv(browser, { app: "application", production: true });
    try {
        await tv.page.locator('[data-screen="entry"]').waitFor();
        assert.equal(await tv.focused(), "address");
        assert.equal(await tv.page.locator("object").count(), 0, "the player, not the package, creates AVPlay objects");
        await tv.remote(10009);
        await tv.page.keyboard.press("ArrowLeft");
        await tv.page.keyboard.press("Enter");
        assert.equal(await tv.page.evaluate(() => window.appHarness.exits), 1);
        assert.deepEqual(tv.console, []);
    } finally {
        await tv.page.context().close();
    }
});

test("a secure-platform startup failure has a focused retry and can recover", async () => {
    const tv = await openTv(browser, { app: "application", production: true });
    try {
        await tv.page.addInitScript(() => {
            const real = globalThis.crypto;
            Object.defineProperty(globalThis, "crypto", { configurable: true, get() { throw new Error("platform unavailable"); } });
            Object.defineProperty(globalThis, "restoreCrypto", { value: () => Object.defineProperty(globalThis, "crypto", { value: real }) });
        });
        await tv.page.reload();
        await tv.page.locator('[data-screen="startup-failed"]').waitFor();
        assert.equal(await tv.focused(), "retry");
        await tv.page.evaluate(() => {
            const restore: unknown = Reflect.get(globalThis, "restoreCrypto");
            if (typeof restore === "function") { restore(); }
        });
        await tv.page.keyboard.press("Enter");
        await tv.page.locator('[data-screen="entry"]').waitFor();
        assert.equal(await tv.focused(), "address");
        assert.deepEqual(tv.console, []);
    } finally {
        await tv.page.context().close();
    }
});
