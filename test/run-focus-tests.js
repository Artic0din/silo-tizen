"use strict";

/**
 * Playwright checks for TV-style browse focus (section/item ids, back restores focus)
 * and for screen layout without the `aspect-ratio`, `inset` and flex `gap` that Chromium 76 lacks.
 * Run: npm ci && npx playwright install chromium && npm run build && node test/run-focus-tests.js
 */

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var http = require("http");
var { chromium } = require("playwright");
var { createMockJellyfinServer, LIBRARY_MOVIES } = require("./mock-jellyfin-server");

// Serve the staged package so tests exercise the real bundle (`npm run build`).
var APP_ROOT = path.join(__dirname, "..", "dist", "wgt");
if (!fs.existsSync(path.join(APP_ROOT, "index.html"))) {
    console.error("error: " + APP_ROOT + " is missing; run `npm run build` first");
    process.exit(1);
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

// 2021 TVs (Tizen 6.0) run Chromium 76, which drops `aspect-ratio` and `inset` and
// ignores `gap` in flex containers. Serving app.css without them makes the layout
// checks below fail if the stylesheet relies on any of these.
// shortcut: flex is detected per rule block, so a gap on a selector made flex by
// another rule slips through; use a CSS parser if the stylesheet starts doing that.
function withoutChromium76Unsupported(css) {
    return css.replace(/[^{}]+\{[^}]*\}/g, function (block) {
        var isFlex = /display:\s*(inline-)?flex\b/.test(block);
        return block.replace(/^\s*([a-z-]+)\s*:[^;]*;/gm, function (declaration, property) {
            var unsupported =
                property === "aspect-ratio" ||
                property === "inset" ||
                (isFlex && /^(row-|column-)?gap$/.test(property));
            return unsupported ? "" : declaration;
        });
    });
}

// Inline styles get the same treatment: Chromium 76 has no `inset` or `aspect-ratio`
// property, so assigning them through `element.style` does nothing.
function disableUnsupportedInlineProperties() {
    ["inset", "aspectRatio"].forEach(function (name) {
        Object.defineProperty(CSSStyleDeclaration.prototype, name, {
            configurable: true,
            get: function () {
                return "";
            },
            set: function () {}
        });
    });
}

// Flex gap parses in Chromium 76 but does nothing, so drop it from inline styles
// once the app has built the element.
function removeInlineFlexGap(page, selector) {
    return page.evaluate(function (rootSelector) {
        var root = document.querySelector(rootSelector);
        [root].concat(Array.prototype.slice.call(root.querySelectorAll("*"))).forEach(function (node) {
            if (getComputedStyle(node).display.indexOf("flex") !== -1) {
                ["gap", "row-gap", "column-gap"].forEach(function (property) {
                    node.style.removeProperty(property);
                });
            }
        });
    }, selector);
}

function pressRemoteKey(page, keyCode, key) {
    return page.evaluate(
        function (args) {
            var event = new KeyboardEvent("keydown", {
                key: args.key,
                keyCode: args.keyCode,
                which: args.keyCode,
                bubbles: true,
                cancelable: true
            });
            document.dispatchEvent(event);
            return event.defaultPrevented;
        },
        { keyCode: keyCode, key: key || "" }
    );
}

function activeElementId(page) {
    return page.evaluate(function () {
        return document.activeElement && document.activeElement.id;
    });
}

function childSpacing(page, selector, axis) {
    return page.evaluate(
        function (args) {
            var children = Array.prototype.slice.call(document.querySelector(args.selector).children);
            return children.slice(1).map(function (child, i) {
                var previous = children[i].getBoundingClientRect();
                var current = child.getBoundingClientRect();
                return args.axis === "x" ? current.left - previous.right : current.top - previous.bottom;
            });
        },
        { selector: selector, axis: axis }
    );
}

function posterBoxes(page, selector) {
    return page.evaluate(function (posterSelector) {
        return Array.prototype.map.call(document.querySelectorAll(posterSelector), function (poster) {
            var box = poster.getBoundingClientRect();
            var fallback = getComputedStyle(poster, "::after");
            return {
                width: box.width,
                height: box.height,
                innerWidth: poster.clientWidth,
                innerHeight: poster.clientHeight,
                fallback: poster.classList.contains("browse-poster-fallback")
                    ? { width: parseFloat(fallback.width), height: parseFloat(fallback.height) }
                    : null
            };
        });
    }, selector);
}

function assertPosterBoxes(posters) {
    assert.ok(posters.length > 0, "no posters rendered");
    posters.forEach(function (poster) {
        assert.ok(
            Math.abs(poster.height - poster.width * 1.5) < 0.1,
            "poster " + poster.width + "x" + poster.height + " is not 2:3"
        );
        if (poster.fallback) {
            assert.ok(
                Math.abs(poster.fallback.width - poster.innerWidth) <= 1 &&
                    Math.abs(poster.fallback.height - poster.innerHeight) <= 1,
                "fallback title " + poster.fallback.width + "x" + poster.fallback.height +
                    " does not fill poster " + poster.innerWidth + "x" + poster.innerHeight
            );
        }
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

async function main() {
    var mock = await createMockJellyfinServer();
    var staticServer = await startStaticServer();

    var browser = await chromium.launch({ headless: true });
    var context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    var page = await context.newPage();
    await page.route("**/css/app.css", async function (route) {
        var response = await route.fetch();
        await route.fulfill({ response: response, body: withoutChromium76Unsupported(await response.text()) });
    });
    await page.addInitScript(disableUnsupportedInlineProperties);

    try {
        await page.goto(staticServer.url, { waitUntil: "domcontentloaded" });
        await page.fill("#server-url", mock.baseUrl.replace("http://", ""));
        await page.click("#server-connect");
        await page.waitForSelector("#signin-username", { timeout: 10000 });
        assert.deepStrictEqual(await childSpacing(page, ".form-stack", "y"), [28, 28]);
        ok("sign-in form rows keep 28px spacing without flex gap");

        await page.fill("#signin-username", "alice");
        await page.fill("#signin-password", "secret");
        await page.click("#signin-submit");
        await page.waitForSelector(".browse-row", { timeout: 10000 });

        assert.deepStrictEqual(await childSpacing(page, ".browse-row-strip", "x"), [28]);
        var homePosters = await posterBoxes(page, ".browse-row-strip .browse-poster");
        assertPosterBoxes(homePosters);
        assert.ok(homePosters.some(function (poster) { return poster.fallback; }), "no fallback poster on home");
        ok("home tiles keep 28px spacing and 2:3 posters, including title fallbacks");

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
        assert.deepStrictEqual(await childSpacing(page, ".details-layout", "x"), [48]);
        var detailsPosters = await posterBoxes(page, ".details-poster");
        assertPosterBoxes(detailsPosters);
        assert.strictEqual(detailsPosters[0].width, 360);
        ok("details keeps a 360x540 poster 48px from the copy");

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

        var gridPosters = await posterBoxes(page, ".browse-grid .browse-poster");
        assertPosterBoxes(gridPosters);
        assert.ok(gridPosters.some(function (poster) { return poster.fallback; }), "no fallback poster in grid");
        ok("library grid keeps 2:3 posters, including title fallbacks");

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

        var inlineSimulation = await page.evaluate(function () {
            var probe = document.createElement("div");
            probe.style.inset = "0";
            return probe.style.top;
        });
        assert.strictEqual(inlineSimulation, "", "inline inset simulation is not active");

        assert.strictEqual(await pressRemoteKey(page, 10009), true);
        await page.waitForSelector("#exit-dialog:not([hidden])", { timeout: 5000 });
        await removeInlineFlexGap(page, "#exit-dialog");
        var exitDialog = await page.evaluate(function () {
            var overlay = document.getElementById("exit-dialog").getBoundingClientRect();
            var yes = document.getElementById("exit-dialog-yes").getBoundingClientRect();
            var no = document.getElementById("exit-dialog-no").getBoundingClientRect();
            return {
                overlay: [overlay.left, overlay.top, overlay.width, overlay.height],
                buttonSpacing: no.left - yes.right,
                focused: document.activeElement && document.activeElement.id
            };
        });
        assert.deepStrictEqual(exitDialog, {
            overlay: [0, 0, 1920, 1080],
            buttonSpacing: 32,
            focused: "exit-dialog-no"
        });
        ok("exit dialog covers the screen, spaces its buttons 32px apart and focuses No");

        assert.strictEqual(await pressRemoteKey(page, 37, "ArrowLeft"), true);
        assert.strictEqual(await activeElementId(page), "exit-dialog-yes");
        assert.strictEqual(await pressRemoteKey(page, 39, "ArrowRight"), true);
        assert.strictEqual(await activeElementId(page), "exit-dialog-no");
        ok("exit dialog Left and Right move focus between Yes and No");

        assert.strictEqual(await pressRemoteKey(page, 10009), true);
        var afterExitDialog = await page.evaluate(function () {
            var el = document.activeElement;
            return {
                hidden: document.getElementById("exit-dialog").hidden,
                sectionId: el && el.getAttribute("data-section-id"),
                itemId: el && el.getAttribute("data-item-id")
            };
        });
        assert.deepStrictEqual(afterExitDialog, { hidden: true, sectionId: "my-libraries", itemId: LIBRARY_MOVIES });
        ok("Back closes the exit dialog and restores home focus");
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
