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
var lastRequestUrl = null;
var trackingFetch = function (url, init) {
    lastAuthHeader = (init.headers && init.headers.Authorization) || null;
    lastRequestUrl = url;
    return fetch(url, init);
};

function makeBackend(fetchFn, extraOptions) {
    var opts = {
        storage: memoryStorage(),
        deviceId: DEVICE_ID,
        deviceName: DEVICE_NAME,
        fetch: fetchFn
    };
    if (extraOptions) {
        Object.keys(extraOptions).forEach(function (key) {
            opts[key] = extraOptions[key];
        });
    }
    return factory.createBackend(opts);
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
        return test("normalizeServerUrl keeps path prefix", function () {
            assert.strictEqual(
                factory.normalizeServerUrl("http://media.example.com/silo/"),
                "http://media.example.com:8096/silo"
            );
            assert.strictEqual(
                factory.joinServerPath("http://host:8096/silo", "/Users/Me"),
                "http://host:8096/silo/Users/Me"
            );
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
        return test("serverInfo uses path prefix on mock", function () {
            return createMockJellyfinServer({ pathPrefix: "/silo" }).then(function (mock) {
                var backend = makeBackend(fetch);
                return backend.serverInfo(mock.baseUrl).then(function (result) {
                    assert.strictEqual(result.ok, true);
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
        return test("signOut calls Sessions/Logout then clears session", function () {
            return createMockJellyfinServer().then(function (mock) {
                var backend = makeBackend(trackingFetch);
                return backend
                    .signIn(mock.baseUrl, "alice", "secret")
                    .then(function () {
                        assert.ok(backend.currentSession());
                        return backend.signOut();
                    })
                    .then(function () {
                        assert.strictEqual(backend.currentSession(), null);
                        assert.ok(lastRequestUrl.indexOf("/Sessions/Logout") !== -1);
                        assert.strictEqual(mock.getLogoutCalls(), 1);
                        return mock.close();
                    });
            });
        });
    },
    function () {
        return test("validateSession uses Users/Me and clears on 401", function () {
            return createMockJellyfinServer({ usersMe401: true }).then(function (mock) {
                var backend = makeBackend(trackingFetch);
                return backend
                    .signIn(mock.baseUrl, "alice", "secret")
                    .then(function () {
                        return backend.validateSession();
                    })
                    .then(function (result) {
                        assert.strictEqual(result.ok, false);
                        assert.strictEqual(backend.currentSession(), null);
                        assert.ok(lastRequestUrl.indexOf("/Users/Me") !== -1);
                        return mock.close();
                    });
            });
        });
    },
    function () {
        return test("validateSession keeps session on network failure", function () {
            return createMockJellyfinServer().then(function (mock) {
                var backend = makeBackend(fetch);
                return backend
                    .signIn(mock.baseUrl, "alice", "secret")
                    .then(function () {
                        return mock.close();
                    })
                    .then(function () {
                        return backend.validateSession();
                    })
                    .then(function (result) {
                        assert.strictEqual(result.ok, false);
                        assert.strictEqual(result.offline, true);
                        assert.ok(backend.currentSession());
                        return Promise.resolve();
                    });
            });
        });
    },
    function () {
        return test("request timeout applies while response body is pending", function () {
            return createMockJellyfinServer({ stallUsersMeBody: true }).then(function (mock) {
                var backend = makeBackend(fetch, { requestTimeoutMs: 150 });
                return backend
                    .signIn(mock.baseUrl, "alice", "secret")
                    .then(function () {
                        var start = Date.now();
                        return backend.validateSession().then(function (result) {
                            var elapsed = Date.now() - start;
                            assert.strictEqual(result.ok, false);
                            assert.strictEqual(result.offline, true);
                            assert.ok(elapsed >= 140);
                            assert.ok(backend.currentSession());
                            return mock.close();
                        });
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
