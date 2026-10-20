"use strict";

var assert = require("assert");
var { createMockJellyfinServer } = require("./mock-jellyfin-server");
var factory = require("../app/js/backend.js");

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

var DEVICE_ID = "11111111-2222-4333-8444-555555555555";
var DEVICE_NAME = "Test TV";
var EXPECTED_AUTH =
    'MediaBrowser Client="Silo", Device="Test TV", DeviceId="11111111-2222-4333-8444-555555555555", Version="0.0.1"';

var lastAuthHeader = null;
var trackingFetch = function (url, init) {
    lastAuthHeader = (init.headers && init.headers.Authorization) || null;
    return fetch(url, init);
};

function makeBackend(fetchFn) {
    return factory.createBackend({
        storage: memoryStorage(),
        deviceId: DEVICE_ID,
        deviceName: DEVICE_NAME,
        fetch: fetchFn
    });
}

var passed = 0;
var failed = 0;

function test(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(function () {
            passed += 1;
            console.log("ok - " + name);
        })
        .catch(function (err) {
            failed += 1;
            console.error("FAIL - " + name);
            console.error(err && err.stack ? err.stack : err);
        });
}

var tests = [
    function () {
        return test("normalizeServerUrl adds scheme and default port", function () {
            assert.strictEqual(factory.normalizeServerUrl("192.168.1.5"), "http://192.168.1.5:8096");
            assert.strictEqual(factory.normalizeServerUrl("http://example.com"), "http://example.com:8096");
        });
    },
    function () {
        return test("serverInfo success against mock", function () {
            return createMockJellyfinServer().then(function (mock) {
                var backend = makeBackend(fetch);
                return backend.serverInfo(mock.baseUrl).then(function (result) {
                    assert.strictEqual(result.ok, true);
                    assert.strictEqual(result.serverName, "Mock Silo");
                    assert.strictEqual(result.serverUrl, mock.baseUrl);
                    return mock.close();
                });
            });
        });
    },
    function () {
        return test("signIn sends exact Authorization header without Token", function () {
            return createMockJellyfinServer().then(function (mock) {
                var backend = makeBackend(trackingFetch);
                return backend.signIn(mock.baseUrl, "alice", "secret").then(function (result) {
                    assert.strictEqual(result.ok, true);
                    assert.strictEqual(lastAuthHeader, EXPECTED_AUTH);
                    assert.strictEqual(result.session.accessToken, "mock-access-token");
                    return mock.close();
                });
            });
        });
    },
    function () {
        return test("signIn returns unauthorized on 401", function () {
            return createMockJellyfinServer({ auth401: true }).then(function (mock) {
                var backend = makeBackend(fetch);
                return backend.signIn(mock.baseUrl, "alice", "wrong").then(function (result) {
                    assert.strictEqual(result.ok, false);
                    assert.strictEqual(result.error.code, "unauthorized");
                    return mock.close();
                });
            });
        });
    },
    function () {
        return test("serverInfo unreachable when nothing listens", function () {
            var backend = makeBackend(fetch);
            return backend.serverInfo("127.0.0.1:1").then(function (result) {
                assert.strictEqual(result.ok, false);
                assert.strictEqual(result.error.code, "unreachable");
            });
        });
    },
    function () {
        return test("signOut clears session", function () {
            return createMockJellyfinServer().then(function (mock) {
                var backend = makeBackend(fetch);
                return backend.signIn(mock.baseUrl, "alice", "secret").then(function () {
                    assert.ok(backend.currentSession());
                    backend.signOut();
                    assert.strictEqual(backend.currentSession(), null);
                    return mock.close();
                });
            });
        });
    }
];

tests
    .reduce(function (chain, run) {
        return chain.then(run);
    }, Promise.resolve())
    .then(function () {
        console.log("\n" + passed + " passed, " + failed + " failed");
        process.exit(failed > 0 ? 1 : 0);
    });
