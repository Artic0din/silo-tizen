"use strict";

/**
 * Headless Chromium walkthrough of sign-in and browse screens against the mock Jellyfin server.
 * Run: npm ci && npx playwright install chromium && node test/run-ui-screenshots.js
 */

var fs = require("fs");
var os = require("os");
var path = require("path");
var http = require("http");
var { chromium } = require("playwright");
var { createMockJellyfinServer, LIBRARY_MOVIES } = require("./mock-jellyfin-server");

var ARTIFACT_DIR = process.env.SCREENSHOT_DIR || path.join(os.tmpdir(), "silo-screenshots");
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

function pressKey(page, key) {
    return page.keyboard.press(key);
}

function dispatchBack(page) {
    return page.evaluate(function () {
        var event = new KeyboardEvent("keydown", { keyCode: 10009, bubbles: true });
        document.dispatchEvent(event);
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

async function main() {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

    var mock = await createMockJellyfinServer();
    var staticServer = await startStaticServer();

    var browser = await chromium.launch({ headless: true });
    var context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    var page = await context.newPage();

    await page.goto(staticServer.url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#server-url");
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "01-server-screen.png") });

    await page.fill("#server-url", mock.baseUrl.replace("http://", ""));
    await page.focus("#server-url");
    await pressKey(page, "ArrowDown");
    await pressKey(page, "Enter");
    await page.waitForSelector("#signin-username", { timeout: 10000 });
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "02-signin-screen.png") });

    await page.fill("#signin-username", "alice");
    await page.fill("#signin-password", "secret");
    await page.click("#signin-submit");
    await page.waitForSelector(".browse-row", { timeout: 10000 });
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "03-home-screen.png") });

    await page.focus('.browse-tile[data-section-id="continue-watching"][data-item-id="resume-1"]');
    await page.keyboard.press("Enter");
    await page.waitForSelector(".playback-overlay", { timeout: 10000 });
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "11-playback-overlay.png") });
    await page.evaluate(function () {
        var event = new KeyboardEvent("keydown", { keyCode: 10009, bubbles: true });
        document.dispatchEvent(event);
    });
    await page.waitForSelector(".browse-row", { timeout: 10000 });

    await page.evaluate(function () {
        window.webapis.avplay._test.setFailAllOpen(true);
    });
    await page.focus('.browse-tile[data-section-id="continue-watching"][data-item-id="resume-1"]');
    await page.keyboard.press("Enter");
    await page.waitForSelector(".playback-error-panel", { timeout: 10000 });
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "12-playback-error.png") });
    await page.evaluate(function () {
        window.webapis.avplay._test.reset();
        var event = new KeyboardEvent("keydown", { keyCode: 10009, bubbles: true });
        document.dispatchEvent(event);
    });
    await page.waitForSelector(".browse-row", { timeout: 10000 });

    var librarySelector =
        '.browse-tile[data-section-id="my-libraries"][data-item-id="' + LIBRARY_MOVIES + '"]';
    await page.focus(librarySelector);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".browse-grid", { timeout: 10000 });
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "04-library-grid.png") });

    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "05-library-grid-focus-moved.png") });

    await dispatchBack(page);
    await page.waitForSelector(librarySelector, { timeout: 5000 });
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "06-home-focus-restored.png") });

    await seedSession(page, mock.baseUrl);
    await page.route("**/Users/Me", async function (route) {
        await new Promise(function (resolve) {
            setTimeout(resolve, 1500);
        });
        await route.continue();
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#connecting-wait", { timeout: 5000 });
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "07-connecting-screen.png") });
    await page.unroute("**/Users/Me");
    await page.waitForSelector(".browse-row", { timeout: 15000 });

    var mockOffline = await createMockJellyfinServer({ usersMe503: true });
    await seedSession(page, mockOffline.baseUrl);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#offline-retry", { timeout: 10000 });
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "08-offline-retry-screen.png") });

    await page.evaluate(function () {
        localStorage.clear();
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#server-url");
    await page.fill("#server-url", "127.0.0.1:1");
    await page.click("#server-connect");
    await page.waitForFunction(function () {
        var err = document.getElementById("screen-error");
        return err && err.textContent.indexOf("reach") !== -1;
    });
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "09-error-unreachable.png") });

    var mock401 = await createMockJellyfinServer({ auth401: true });
    await page.fill("#server-url", mock401.baseUrl.replace("http://", ""));
    await page.click("#server-connect");
    await page.waitForSelector("#signin-username");
    await page.fill("#signin-username", "alice");
    await page.fill("#signin-password", "wrong");
    await page.click("#signin-submit");
    await page.waitForFunction(function () {
        var err = document.getElementById("screen-error");
        return err && err.textContent.toLowerCase().indexOf("password") !== -1;
    });
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "10-error-unauthorized.png") });

    await browser.close();
    await staticServer.close();
    await mock.close();
    await mock401.close();
    await mockOffline.close();

    console.log("Screenshots saved under " + ARTIFACT_DIR);
}

main().catch(function (err) {
    console.error(err);
    process.exit(1);
});
