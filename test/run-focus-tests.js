"use strict";

/**
 * Playwright checks for TV-style browse focus (section/item ids, back restores focus).
 * Run: npm ci && npx playwright install chromium && node test/run-focus-tests.js
 */

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var http = require("http");
var { chromium } = require("playwright");
var { createMockJellyfinServer, LIBRARY_MOVIES } = require("./mock-jellyfin-server");

var APP_ROOT = path.join(__dirname, "..", "app");

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

function seedSession(page, serverUrl) {
    return page.evaluate(function (url) {
        var session = {
            serverUrl: url,
            userId: "user-123",
            userName: "Test User",
            accessToken: "mock-access-token",
            serverName: "Mock Silo"
        };
        var sessions = {};
        sessions[url] = session;
        localStorage.setItem("silo.activeServer", url);
        localStorage.setItem("silo.sessions", JSON.stringify(sessions));
    }, serverUrl);
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

async function main() {
    var mock = await createMockJellyfinServer();
    var staticServer = await startStaticServer();

    var browser = await chromium.launch({ headless: true });
    var context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    var page = await context.newPage();

    try {
        await page.goto(staticServer.url, { waitUntil: "domcontentloaded" });
        await page.fill("#server-url", mock.baseUrl.replace("http://", ""));
        await page.click("#server-connect");
        await page.waitForSelector("#signin-username", { timeout: 10000 });
        await page.fill("#signin-username", "alice");
        await page.fill("#signin-password", "secret");
        await page.click("#signin-submit");
        await page.waitForSelector(".browse-row", { timeout: 10000 });

        var homeArrowRight = await page.evaluate(function () {
            var beforeId = document.activeElement && document.activeElement.getAttribute("data-item-id");
            var event = new KeyboardEvent("keydown", {
                key: "ArrowRight",
                keyCode: 39,
                which: 39,
                bubbles: true,
                cancelable: true
            });
            document.dispatchEvent(event);
            var afterId = document.activeElement && document.activeElement.getAttribute("data-item-id");
            return {
                beforeId: beforeId,
                afterId: afterId,
                defaultPrevented: event.defaultPrevented
            };
        });
        assert.strictEqual(homeArrowRight.beforeId, "resume-1");
        assert.strictEqual(homeArrowRight.afterId, "resume-2");
        assert.strictEqual(homeArrowRight.defaultPrevented, true);
        ok("home ArrowRight moves one tile and prevents default");

        var focusAfterRight = {
            sectionId: "continue-watching",
            itemId: homeArrowRight.afterId
        };
        assert.strictEqual(focusAfterRight.itemId, "resume-2");
        ok("home horizontal focus moves within row");

        var homeArrowDown = await page.evaluate(function () {
            var beforeId = document.activeElement && document.activeElement.getAttribute("data-item-id");
            var event = new KeyboardEvent("keydown", {
                key: "ArrowDown",
                keyCode: 40,
                which: 40,
                bubbles: true,
                cancelable: true
            });
            document.dispatchEvent(event);
            var afterId = document.activeElement && document.activeElement.getAttribute("data-item-id");
            return {
                beforeId: beforeId,
                afterId: afterId,
                defaultPrevented: event.defaultPrevented
            };
        });
        assert.strictEqual(homeArrowDown.defaultPrevented, true);
        assert.notStrictEqual(homeArrowDown.afterId, homeArrowDown.beforeId);
        ok("home ArrowDown moves one row and prevents default");

        await page.focus('.browse-tile[data-section-id="continue-watching"][data-item-id="resume-2"]');
        await page.keyboard.press("Enter");
        await page.waitForSelector("#details-back", { timeout: 5000 });
        await page.evaluate(function () {
            var event = new KeyboardEvent("keydown", { keyCode: 10009, bubbles: true });
            document.dispatchEvent(event);
        });
        await page.waitForSelector(".browse-row", { timeout: 5000 });
        var focusAfterBack = await page.evaluate(function () {
            var el = document.activeElement;
            return {
                sectionId: el && el.getAttribute("data-section-id"),
                itemId: el && el.getAttribute("data-item-id")
            };
        });
        assert.strictEqual(focusAfterBack.sectionId, "continue-watching");
        assert.strictEqual(focusAfterBack.itemId, "resume-2");
        ok("back from details restores home focus by section and item id");

        var libraryTileSelector =
            '.browse-tile[data-section-id="my-libraries"][data-item-id="' + LIBRARY_MOVIES + '"]';
        await page.focus(libraryTileSelector);
        await page.keyboard.press("Enter");
        await page.waitForSelector(".browse-grid", { timeout: 10000 });

        await page.focus('.browse-grid .browse-tile[data-item-id="movie-000"]');
        var gridArrowRight = await page.evaluate(function () {
            var beforeId = document.activeElement && document.activeElement.getAttribute("data-item-id");
            var event = new KeyboardEvent("keydown", {
                key: "ArrowRight",
                keyCode: 39,
                which: 39,
                bubbles: true,
                cancelable: true
            });
            document.dispatchEvent(event);
            var afterId = document.activeElement && document.activeElement.getAttribute("data-item-id");
            return {
                beforeId: beforeId,
                afterId: afterId,
                defaultPrevented: event.defaultPrevented
            };
        });
        assert.strictEqual(gridArrowRight.beforeId, "movie-000");
        assert.strictEqual(gridArrowRight.afterId, "movie-001");
        assert.strictEqual(gridArrowRight.defaultPrevented, true);
        ok("library ArrowRight moves one cell and prevents default");

        await page.keyboard.press("ArrowRight");
        var gridFocus = await page.evaluate(function () {
            return document.activeElement && document.activeElement.getAttribute("data-item-id");
        });
        assert.strictEqual(gridFocus, "movie-002");
        ok("library grid focus moves horizontally");

        await page.evaluate(function () {
            var event = new KeyboardEvent("keydown", { keyCode: 10009, bubbles: true });
            document.dispatchEvent(event);
        });
        await page.waitForSelector(libraryTileSelector, { timeout: 5000 });
        var homeFocus = await page.evaluate(function () {
            var el = document.activeElement;
            return el && el.getAttribute("data-item-id");
        });
        assert.strictEqual(homeFocus, LIBRARY_MOVIES);
        ok("back from library restores home library tile focus");
    } catch (err) {
        fail("focus navigation suite", err);
    }

    await browser.close();
    await staticServer.close();
    await mock.close();

    console.log("\n" + passed + " passed, " + failed + " failed");
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(function (err) {
    console.error(err);
    process.exit(1);
});
