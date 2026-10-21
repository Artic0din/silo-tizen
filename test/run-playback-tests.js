"use strict";

/**
 * Playback tests: backend stream choice, AVPlay stub fallback, session reporting, UI back/focus.
 * Run: npm ci && npx playwright install chromium && node test/run-playback-tests.js
 */

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var http = require("http");
var { chromium } = require("playwright");
var {
    createMockJellyfinServer,
    LIBRARY_MOVIES,
    TRANSCODE_ONLY_ID
} = require("./mock-jellyfin-server");
var backendFactory = require("../app/js/backend.js");
var playerFactory = require("../app/js/player.js");

var APP_ROOT = path.join(__dirname, "..", "app");

function memoryStorage() {
    var map = Object.create(null);
    return {
        getItem: function (key) {
            return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
        },
        setItem: function (key, value) {
            map[key] = String(value);
        },
        removeItem: function (key) {
            delete map[key];
        }
    };
}

function makeBackend(mockBaseUrl, fetchFn) {
    return backendFactory.createBackend({
        storage: memoryStorage(),
        deviceId: "11111111-2222-4333-8444-555555555555",
        deviceName: "Test TV",
        fetch: fetchFn || fetch
    });
}

function startStaticServer() {
    var server = http.createServer(function (req, res) {
        var urlPath = req.url.split("?")[0];
        if (urlPath === "/") {
            urlPath = "/index.html";
        }
        if (urlPath === "/test/webapis-stub.js") {
            var stub = fs.readFileSync(path.join(__dirname, "webapis-stub.js"));
            res.writeHead(200, { "Content-Type": "application/javascript" });
            res.end(stub);
            return;
        }
        var filePath = path.join(APP_ROOT, urlPath);
        if (!filePath.startsWith(APP_ROOT)) {
            res.writeHead(403);
            res.end();
            return;
        }
        fs.readFile(filePath, function (err, data) {
            if (err) {
                res.writeHead(404);
                res.end();
                return;
            }
            var ext = path.extname(filePath);
            var type = ext === ".html" ? "text/html" : ext === ".css" ? "text/css" : "application/javascript";
            if (ext === ".html") {
                data = Buffer.from(
                    data
                        .toString("utf8")
                        .replace("$WEBAPIS/webapis/webapis.js", "/test/webapis-stub.js")
                );
            }
            res.writeHead(200, { "Content-Type": type });
            res.end(data);
        });
    });

    return new Promise(function (resolve) {
        server.listen(0, "127.0.0.1", function () {
            resolve({
                url: "http://127.0.0.1:" + server.address().port + "/index.html",
                close: function () {
                    return new Promise(function (res) {
                        server.close(function () {
                            res();
                        });
                    });
                }
            });
        });
    });
}

var passed = 0;
var failed = 0;

function ok(name) {
    passed += 1;
    console.log("ok - " + name);
}

function fail(name, err) {
    failed += 1;
    console.error("FAIL - " + name);
    console.error(err && err.stack ? err.stack : err);
}

async function runBackendTests(mock) {
    var backend = makeBackend(mock.baseUrl);
    await backend.signIn(mock.baseUrl, "alice", "secret");

    var direct = await backend.playbackStreamForItem("movie-000", { forceTranscode: false });
    assert.strictEqual(direct.ok, true);
    assert.strictEqual(direct.mode, "direct");
    assert.ok(direct.streamUrl.indexOf("static=true") !== -1);
    assert.ok(direct.streamUrl.indexOf("api_key=mock-access-token") !== -1);
    ok("playbackStreamForItem chooses direct play when supported");

    var transcode = await backend.playbackStreamForItem(TRANSCODE_ONLY_ID, { forceTranscode: false });
    assert.strictEqual(transcode.ok, true);
    assert.strictEqual(transcode.mode, "transcode");
    assert.ok(transcode.streamUrl.indexOf("master.m3u8") !== -1);
    ok("playbackStreamForItem chooses transcode when direct play unsupported");

    assert.strictEqual(
        backendFactory.resumePositionSeconds({ PlaybackPositionTicks: 6000000000 }, 72000000000),
        600
    );
    assert.strictEqual(
        backendFactory.resumePositionSeconds({ PlaybackPositionTicks: 71955000000 }, 72000000000),
        0
    );
    ok("resumePositionSeconds honors resume and skips near end");

    await backend.playbackStart({
        itemId: "movie-000",
        mediaSourceId: "ms-movie-000",
        playSessionId: "ps",
        positionTicks: 0,
        playMethod: "DirectPlay"
    });
    assert.strictEqual(mock.getPlayingStarts(), 1);
    await backend.playbackProgress({
        itemId: "movie-000",
        mediaSourceId: "ms-movie-000",
        playSessionId: "ps",
        positionTicks: 50000000,
        playMethod: "DirectPlay"
    });
    assert.ok(mock.getPlayingProgress() >= 1);
    await backend.playbackStop({
        itemId: "movie-000",
        mediaSourceId: "ms-movie-000",
        playSessionId: "ps",
        positionTicks: 50000000,
        playMethod: "DirectPlay"
    });
    assert.ok(mock.getPlayingStopped() >= 1);
    ok("playbackStart/progress/stop hit Sessions endpoints");
}

async function runPlayerFallbackTest(mock) {
    var backend = makeBackend(mock.baseUrl);
    await backend.signIn(mock.baseUrl, "alice", "secret");

    var avplay = {
        open: function (url) {
            this._url = url;
            if (url.indexOf("static=true") !== -1) {
                throw new Error("direct fail");
            }
        },
        close: function () {},
        stop: function () {},
        prepareAsync: function (success) {
            success();
        },
        play: function () {},
        pause: function () {},
        seekTo: function (_ms, success) {
            success();
        },
        getCurrentTime: function () {
            return 0;
        },
        getDuration: function () {
            return 7200000;
        },
        setDisplayRect: function () {},
        setListener: function () {}
    };

    var player = playerFactory.createPlayer({ backend: backend, avplay: avplay });
    var result = await player.start("movie-000", { returnView: "home", sectionId: "x", itemId: "movie-000" });
    assert.strictEqual(result.ok, true);
    assert.ok(avplay._url.indexOf("master.m3u8") !== -1 || avplay._url.indexOf("static=true") === -1);
    assert.strictEqual(player.getState().triedTranscodeFallback, true);
    ok("AVPlay direct open failure falls back to transcode once");
}

async function runUiTests(mock, staticServer) {
    var browser = await chromium.launch({ headless: true });
    var context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    var page = await context.newPage();

    await page.goto(staticServer.url, { waitUntil: "domcontentloaded" });
    await page.fill("#server-url", mock.baseUrl.replace("http://", ""));
    await page.click("#server-connect");
    await page.waitForSelector("#signin-username");
    await page.fill("#signin-username", "alice");
    await page.fill("#signin-password", "secret");
    await page.click("#signin-submit");
    await page.waitForSelector(".browse-row");

    await page.focus('.browse-tile[data-section-id="continue-watching"][data-item-id="resume-2"]');
    await page.keyboard.press("Enter");
    await page.waitForSelector(".playback-overlay, .playback-error-panel", { timeout: 10000 });

    var overlayVisible = await page.evaluate(function () {
        return !!document.querySelector(".playback-overlay");
    });
    assert.strictEqual(overlayVisible, true);
    ok("Enter on episode poster opens playback overlay");

    await page.evaluate(function () {
        var event = new KeyboardEvent("keydown", { keyCode: 10009, bubbles: true });
        document.dispatchEvent(event);
    });
    await page.waitForSelector(".browse-row", { timeout: 10000 });
    var focusAfter = await page.evaluate(function () {
        var el = document.activeElement;
        return {
            sectionId: el && el.getAttribute("data-section-id"),
            itemId: el && el.getAttribute("data-item-id")
        };
    });
    assert.strictEqual(focusAfter.sectionId, "continue-watching");
    assert.strictEqual(focusAfter.itemId, "resume-2");
    assert.ok(mock.getPlayingStopped() >= 1);
    ok("Back from playback stops session and restores tile focus");

    await page.focus('.browse-tile[data-section-id="my-libraries"][data-item-id="' + LIBRARY_MOVIES + '"]');
    await page.keyboard.press("Enter");
    await page.waitForSelector(".browse-grid");
    await page.evaluate(function () {
        window.webapis.avplay._test.setFailAllOpen(true);
    });
    await page.focus('.browse-grid .browse-tile[data-item-id="' + TRANSCODE_ONLY_ID + '"]');
    await page.keyboard.press("Enter");
    await page.waitForSelector(".playback-error-panel", { timeout: 10000 });
    var errText = await page.evaluate(function () {
        var el = document.querySelector(".playback-error-message");
        return el && el.textContent;
    });
    assert.ok(errText && errText.length > 0);
    ok("playback error screen shows message with Back target");

    await browser.close();
}

async function main() {
    var mock = await createMockJellyfinServer();
    var staticServer = await startStaticServer();
    try {
        await runBackendTests(mock);
        await runPlayerFallbackTest(mock);
        await runUiTests(mock, staticServer);
    } catch (err) {
        fail("playback suite", err);
    }
    await staticServer.close();
    await mock.close();
    console.log("\n" + passed + " passed, " + failed + " failed");
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(function (err) {
    console.error(err);
    process.exit(1);
});
