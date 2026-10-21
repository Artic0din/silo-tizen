"use strict";

/**
 * Playwright UI tests for Quick Connect sign-in (focus, polling cleanup, flows).
 * Run: npm ci && npx playwright install chromium && node test/run-ui-tests.js
 */

var assert = require("assert");
var path = require("path");
var http = require("http");
var fs = require("fs");
var { chromium } = require("playwright");
var { createMockJellyfinServer } = require("./mock-jellyfin-server");

var APP_ROOT = path.join(__dirname, "..", "app");
var KEY_BACK = 10009;

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

async function connectToServer(page, baseUrl) {
    await page.fill("#server-url", baseUrl.replace("http://", ""));
    await page.click("#server-connect");
}

async function pressBack(page) {
    await page.evaluate(function (keyCode) {
        var event = new KeyboardEvent("keydown", { keyCode: keyCode, bubbles: true, cancelable: true });
        document.dispatchEvent(event);
    }, KEY_BACK);
}

async function openQuickConnectChoice(page, staticUrl, mock) {
    await page.goto(staticUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(function () {
        localStorage.clear();
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await connectToServer(page, mock.baseUrl);
    await page.waitForSelector("#signin-quickconnect-start", { timeout: 10000 });
}

var passed = 0;
var failed = 0;

async function runTest(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log("ok - " + name);
    } catch (err) {
        failed += 1;
        console.error("FAIL - " + name);
        console.error(err && err.stack ? err.stack : err);
    }
}

async function main() {
    var staticServer = await startStaticServer();
    var browser = await chromium.launch({ headless: true });
    var context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });

    await runTest("Quick Connect choice screen focuses Quick Connect first", async function () {
        var mock = await createMockJellyfinServer({ quickConnectEnabled: true });
        var page = await context.newPage();
        await openQuickConnectChoice(page, staticServer.url, mock);
        var focusedId = await page.evaluate(function () {
            return document.activeElement && document.activeElement.id;
        });
        assert.strictEqual(focusedId, "signin-quickconnect-start");
        await page.close();
        await mock.close();
    });

    await runTest("password fallback is one ArrowDown from Quick Connect choice", async function () {
        var mock = await createMockJellyfinServer({ quickConnectEnabled: true });
        var page = await context.newPage();
        await openQuickConnectChoice(page, staticServer.url, mock);
        await page.keyboard.press("ArrowDown");
        var focusedId = await page.evaluate(function () {
            return document.activeElement && document.activeElement.id;
        });
        assert.strictEqual(focusedId, "signin-use-password");
        await page.keyboard.press("Enter");
        await page.waitForSelector("#signin-username");
        await page.close();
        await mock.close();
    });

    await runTest("Back on sign-in choice opens exit confirmation", async function () {
        var mock = await createMockJellyfinServer({ quickConnectEnabled: true });
        var page = await context.newPage();
        await openQuickConnectChoice(page, staticServer.url, mock);
        await pressBack(page);
        await page.waitForSelector("#exit-dialog:not([hidden])", { timeout: 5000 });
        var focusedId = await page.evaluate(function () {
            return document.activeElement && document.activeElement.id;
        });
        assert.strictEqual(focusedId, "exit-dialog-no");
        await page.close();
        await mock.close();
    });

    await runTest("Back on Quick Connect code screen returns to choice and stops polling", async function () {
        var mock = await createMockJellyfinServer({ quickConnectEnabled: true, quickConnectPollsUntilAuth: 50 });
        var page = await context.newPage();
        await page.addInitScript(function () {
            window.SiloTestConfig = { quickConnectPollMs: 200, quickConnectTimeoutMs: 600000 };
        });
        await openQuickConnectChoice(page, staticServer.url, mock);
        await page.click("#signin-quickconnect-start");
        await page.waitForSelector("#quickconnect-cancel");
        await page.waitForTimeout(450);
        var pollsBeforeBack = mock.getQuickConnectPollCalls();
        await pressBack(page);
        await page.waitForSelector("#signin-quickconnect-start", { timeout: 5000 });
        var focusedId = await page.evaluate(function () {
            return document.activeElement && document.activeElement.id;
        });
        assert.strictEqual(focusedId, "signin-quickconnect-start");
        await page.waitForTimeout(700);
        assert.strictEqual(mock.getQuickConnectPollCalls(), pollsBeforeBack);
        await page.close();
        await mock.close();
    });

    await runTest("Back on password form returns to Quick Connect choice", async function () {
        var mock = await createMockJellyfinServer({ quickConnectEnabled: true });
        var page = await context.newPage();
        await openQuickConnectChoice(page, staticServer.url, mock);
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await page.waitForSelector("#signin-username");
        await pressBack(page);
        await page.waitForSelector("#signin-quickconnect-start", { timeout: 5000 });
        var focusedId = await page.evaluate(function () {
            return document.activeElement && document.activeElement.id;
        });
        assert.strictEqual(focusedId, "signin-quickconnect-start");
        await page.close();
        await mock.close();
    });

    await runTest("Quick Connect disabled shows password form only", async function () {
        var mock = await createMockJellyfinServer({ quickConnectEnabled: false });
        var page = await context.newPage();
        await page.goto(staticServer.url, { waitUntil: "domcontentloaded" });
        await connectToServer(page, mock.baseUrl);
        await page.waitForSelector("#signin-username", { timeout: 10000 });
        assert.strictEqual(await page.$("#signin-quickconnect-start"), null);
        await page.close();
        await mock.close();
    });

    await runTest("Quick Connect poll completes, stores token, and lands on Home", async function () {
        var mock = await createMockJellyfinServer({
            quickConnectEnabled: true,
            quickConnectPollsUntilAuth: 1
        });
        var page = await context.newPage();
        await page.addInitScript(function () {
            window.SiloTestConfig = { quickConnectPollMs: 150, quickConnectTimeoutMs: 600000 };
        });
        await openQuickConnectChoice(page, staticServer.url, mock);
        await page.click("#signin-quickconnect-start");
        await page.waitForSelector("#quickconnect-code-display", { timeout: 10000 });
        await page.waitForSelector("#home-signout", { timeout: 15000 });
        var session = await page.evaluate(function () {
            return JSON.parse(localStorage.getItem("silo.sessions") || "{}");
        });
        var urls = Object.keys(session);
        assert.ok(urls.length > 0);
        assert.strictEqual(session[urls[0]].accessToken, "mock-qc-access-token");
        await page.close();
        await mock.close();
    });

    await runTest("Quick Connect cancel stops polling", async function () {
        var mock = await createMockJellyfinServer({ quickConnectEnabled: true, quickConnectPollsUntilAuth: 50 });
        var page = await context.newPage();
        await page.addInitScript(function () {
            window.SiloTestConfig = { quickConnectPollMs: 200, quickConnectTimeoutMs: 600000 };
        });
        await openQuickConnectChoice(page, staticServer.url, mock);
        await page.click("#signin-quickconnect-start");
        await page.waitForSelector("#quickconnect-cancel");
        await page.waitForTimeout(450);
        var pollsBeforeCancel = mock.getQuickConnectPollCalls();
        await page.click("#quickconnect-cancel");
        await page.waitForSelector("#signin-quickconnect-start");
        await page.waitForTimeout(700);
        assert.strictEqual(mock.getQuickConnectPollCalls(), pollsBeforeCancel);
        await page.close();
        await mock.close();
    });

    await runTest("Quick Connect expired state after server 400", async function () {
        var mock = await createMockJellyfinServer({
            quickConnectEnabled: true,
            quickConnectExpired: true
        });
        var page = await context.newPage();
        await page.addInitScript(function () {
            window.SiloTestConfig = { quickConnectPollMs: 100, quickConnectTimeoutMs: 600000 };
        });
        await openQuickConnectChoice(page, staticServer.url, mock);
        await page.click("#signin-quickconnect-start");
        await page.waitForSelector("#quickconnect-renew", { timeout: 10000 });
        var title = await page.textContent("h1.title");
        assert.strictEqual(title, "Expired");
        await page.close();
        await mock.close();
    });

    await runTest("Quick Connect code screen keeps focus on cancel", async function () {
        var mock = await createMockJellyfinServer({ quickConnectEnabled: true, quickConnectPollsUntilAuth: 50 });
        var page = await context.newPage();
        await page.addInitScript(function () {
            window.SiloTestConfig = { quickConnectPollMs: 500, quickConnectTimeoutMs: 600000 };
        });
        await openQuickConnectChoice(page, staticServer.url, mock);
        await page.click("#signin-quickconnect-start");
        await page.waitForSelector("#quickconnect-cancel");
        var focusedId = await page.evaluate(function () {
            return document.activeElement && document.activeElement.id;
        });
        assert.strictEqual(focusedId, "quickconnect-cancel");
        await page.close();
        await mock.close();
    });

    await browser.close();
    await staticServer.close();

    console.log("\n" + passed + " passed, " + failed + " failed");
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(function (err) {
    console.error(err);
    process.exit(1);
});
