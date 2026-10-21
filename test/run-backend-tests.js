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
        return test("quickConnectEnabled true on mock", function () {
            return createMockJellyfinServer({ quickConnectEnabled: true }).then(function (mock) {
                var backend = makeBackend(trackingFetch);
                return backend.quickConnectEnabled(mock.baseUrl).then(function (result) {
                    assert.strictEqual(result.ok, true);
                    assert.strictEqual(result.enabled, true);
                    assert.ok(lastRequestUrl.indexOf("/QuickConnect/Enabled") !== -1);
                    assert.strictEqual(lastAuthHeader, EXPECTED_AUTH);
                    return mock.close();
                });
            });
        });
    },
    function () {
        return test("quickConnectEnabled false and 404 treated as disabled", function () {
            return createMockJellyfinServer({ quickConnectEnabled: false }).then(function (mock) {
                var backend = makeBackend(fetch);
                return backend
                    .quickConnectEnabled(mock.baseUrl)
                    .then(function (result) {
                        assert.strictEqual(result.ok, true);
                        assert.strictEqual(result.enabled, false);
                        return createMockJellyfinServer({ quickConnectEnabledStatus: 404 });
                    })
                    .then(function (mock404) {
                        return backend.quickConnectEnabled(mock404.baseUrl).then(function (result404) {
                            assert.strictEqual(result404.ok, true);
                            assert.strictEqual(result404.enabled, false);
                            return Promise.all([mock.close(), mock404.close()]);
                        });
                    });
            });
        });
    },
    function () {
        return test("quickConnectInitiate returns code and secret", function () {
            return createMockJellyfinServer({ quickConnectEnabled: true, quickConnectCode: "902184" }).then(
                function (mock) {
                    var backend = makeBackend(trackingFetch);
                    return backend.quickConnectInitiate(mock.baseUrl).then(function (result) {
                        assert.strictEqual(result.ok, true);
                        assert.strictEqual(result.code, "902184");
                        assert.ok(result.secret);
                        assert.strictEqual(lastAuthHeader, EXPECTED_AUTH);
                        return mock.close();
                    });
                }
            );
        });
    },
    function () {
        return test("quickConnectPoll until authenticated then authenticateWithQuickConnect stores token", function () {
            return createMockJellyfinServer({
                quickConnectEnabled: true,
                quickConnectPollsUntilAuth: 2
            }).then(function (mock) {
                var backend = makeBackend(trackingFetch);
                var secret = "mock-quick-connect-secret";
                return backend
                    .quickConnectPoll(mock.baseUrl, secret)
                    .then(function (first) {
                        assert.strictEqual(first.ok, true);
                        assert.strictEqual(first.authenticated, false);
                        return backend.quickConnectPoll(mock.baseUrl, secret);
                    })
                    .then(function (second) {
                        assert.strictEqual(second.ok, true);
                        assert.strictEqual(second.authenticated, true);
                        return backend.authenticateWithQuickConnect(mock.baseUrl, secret);
                    })
                    .then(function (auth) {
                        assert.strictEqual(auth.ok, true);
                        assert.strictEqual(auth.session.accessToken, "mock-qc-access-token");
                        assert.strictEqual(auth.session.userName, "QC User");
                        assert.strictEqual(backend.currentSession(), null);
                        var stored = backend.storeSession(auth.session);
                        assert.strictEqual(stored.ok, true);
                        assert.ok(backend.currentSession());
                        return mock.close();
                    });
            });
        });
    },
    function () {
        return test("quickConnectPoll returns expired on 400", function () {
            return createMockJellyfinServer({ quickConnectExpired: true }).then(function (mock) {
                var backend = makeBackend(fetch);
                return backend.quickConnectPoll(mock.baseUrl, "mock-quick-connect-secret").then(function (result) {
                    assert.strictEqual(result.ok, false);
                    assert.strictEqual(result.error.code, "expired");
                    return mock.close();
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
    },
    function () {
        return test("browseHome returns resume, latest, and libraries", function () {
            return createMockJellyfinServer().then(function (mock) {
                var backend = makeBackend(trackingFetch);
                return backend
                    .signIn(mock.baseUrl, "alice", "secret")
                    .then(function () {
                        return backend.browseHome();
                    })
                    .then(function (result) {
                        assert.strictEqual(result.ok, true);
                        var ids = result.sections.map(function (s) {
                            return s.id;
                        });
                        assert.ok(ids.indexOf("continue-watching") !== -1);
                        assert.ok(ids.some(function (id) {
                            return id.indexOf("latest-") === 0;
                        }));
                        assert.ok(ids.indexOf("my-libraries") !== -1);
                        assert.ok(lastAuthHeader.indexOf('Token="mock-access-token"') !== -1);
                        return mock.close();
                    });
            });
        });
    },
    function () {
        return test("browseLibraryItems pages with StartIndex and Limit", function () {
            var mockLib = require("./mock-jellyfin-server");
            return createMockJellyfinServer().then(function (mock) {
                var backend = makeBackend(trackingFetch);
                return backend
                    .signIn(mock.baseUrl, "alice", "secret")
                    .then(function () {
                        return backend.browseLibraryItems(mockLib.LIBRARY_MOVIES, { startIndex: 0, limit: 30 });
                    })
                    .then(function (page1) {
                        assert.strictEqual(page1.ok, true);
                        assert.strictEqual(page1.items.length, 30);
                        assert.strictEqual(page1.totalRecordCount, 75);
                        assert.ok(lastRequestUrl.indexOf("StartIndex=0") !== -1);
                        assert.ok(lastRequestUrl.indexOf("Limit=30") !== -1);
                        return backend.browseLibraryItems(mockLib.LIBRARY_MOVIES, { startIndex: 30, limit: 30 });
                    })
                    .then(function (page2) {
                        assert.strictEqual(page2.ok, true);
                        assert.strictEqual(page2.items.length, 30);
                        assert.ok(lastRequestUrl.indexOf("StartIndex=30") !== -1);
                        return mock.close();
                    });
            });
        });
    },
    function () {
        return test("primaryImageUrl includes api_key query param", function () {
            return createMockJellyfinServer().then(function (mock) {
                var backend = makeBackend(fetch);
                return backend.signIn(mock.baseUrl, "alice", "secret").then(function () {
                    var imageUrl = backend.primaryImageUrl("movie-001", { maxHeight: 200, quality: 80 });
                    assert.ok(imageUrl.indexOf("/Items/movie-001/Images/Primary") !== -1);
                    assert.ok(imageUrl.indexOf("maxHeight=200") !== -1);
                    assert.ok(imageUrl.indexOf("api_key=mock-access-token") !== -1);
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
