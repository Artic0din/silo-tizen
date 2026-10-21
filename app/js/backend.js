/**
 * Thin Silo v2-shaped adapter over the Jellyfin-compatible HTTP layer.
 * UI must use this module only — never build Jellyfin URLs in screens.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
    if (typeof window !== "undefined") {
        window.SiloBackend = api.createBackend();
        window.SiloBackendFactory = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    var APP_VERSION = "0.0.1";
    var CLIENT_NAME = "Silo";
    var DEFAULT_PORT = 8096;
    var REQUEST_TIMEOUT_MS = 10000;
    var STORAGE_DEVICE_ID = "silo.deviceId";
    var STORAGE_SESSIONS = "silo.sessions";
    var STORAGE_ACTIVE_SERVER = "silo.activeServer";

    function defaultStorage() {
        if (typeof localStorage !== "undefined") {
            return localStorage;
        }
        throw new Error("No storage available");
    }

    function readJson(storage, key, fallback) {
        try {
            var raw = storage.getItem(key);
            if (!raw) {
                return fallback;
            }
            return JSON.parse(raw);
        } catch (err) {
            return fallback;
        }
    }

    function writeJson(storage, key, value) {
        storage.setItem(key, JSON.stringify(value));
    }

    function generateDeviceId() {
        if (typeof crypto !== "undefined" && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        var hex = "0123456789abcdef";
        var id = "";
        for (var i = 0; i < 36; i++) {
            if (i === 8 || i === 13 || i === 18 || i === 23) {
                id += "-";
            } else if (i === 14) {
                id += "4";
            } else if (i === 19) {
                id += hex[(Math.random() * 4) | 8];
            } else {
                id += hex[(Math.random() * 16) | 0];
            }
        }
        return id;
    }

    function getDeviceId(storage) {
        var existing = storage.getItem(STORAGE_DEVICE_ID);
        if (existing) {
            return existing;
        }
        var id = generateDeviceId();
        storage.setItem(STORAGE_DEVICE_ID, id);
        return id;
    }

    function resolveDeviceName() {
        try {
            if (typeof webapis !== "undefined" && webapis.productinfo && webapis.productinfo.getRealModel) {
                return webapis.productinfo.getRealModel();
            }
        } catch (productErr) {
            /* Browser preview */
        }
        return "Samsung TV";
    }

    function normalizeServerUrl(input) {
        var trimmed = String(input || "").trim();
        if (!trimmed) {
            return "";
        }
        var withScheme = trimmed;
        if (!/^https?:\/\//i.test(withScheme)) {
            withScheme = "http://" + withScheme;
        }
        var parsed;
        try {
            parsed = new URL(withScheme);
        } catch (urlErr) {
            return "";
        }
        if (!parsed.hostname) {
            return "";
        }
        if (!parsed.port && parsed.protocol === "http:") {
            parsed.port = String(DEFAULT_PORT);
        }
        var pathPart = parsed.pathname || "/";
        pathPart = pathPart.replace(/\/+$/, "");
        if (pathPart === "/") {
            pathPart = "";
        }
        parsed.search = "";
        parsed.hash = "";
        var portSegment = parsed.port ? ":" + parsed.port : "";
        return parsed.protocol + "//" + parsed.hostname + portSegment + pathPart;
    }

    function joinServerPath(serverUrl, apiPath) {
        var base = String(serverUrl || "").replace(/\/+$/, "");
        var path = apiPath.charAt(0) === "/" ? apiPath : "/" + apiPath;
        return base + path;
    }

    function buildAuthHeader(deviceId, deviceName, accessToken) {
        var parts = [
            'MediaBrowser Client="' + CLIENT_NAME + '"',
            'Device="' + deviceName + '"',
            'DeviceId="' + deviceId + '"',
            'Version="' + APP_VERSION + '"'
        ];
        if (accessToken) {
            parts.push('Token="' + accessToken + '"');
        }
        return parts.join(", ");
    }

    function mapFetchError(err) {
        if (err && err.name === "AbortError") {
            return { code: "timeout", message: "Server did not respond in time." };
        }
        return { code: "unreachable", message: "Could not reach the server." };
    }

    function createBackend(options) {
        options = options || {};
        var storage = options.storage || defaultStorage();
        var fetchFn = options.fetch || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
        var deviceName = options.deviceName || resolveDeviceName();
        var deviceId = options.deviceId || getDeviceId(storage);
        var requestTimeoutMs = options.requestTimeoutMs || REQUEST_TIMEOUT_MS;

        if (!fetchFn) {
            throw new Error("fetch is not available");
        }

        function loadSessions() {
            return readJson(storage, STORAGE_SESSIONS, {});
        }

        function saveSessions(sessions) {
            writeJson(storage, STORAGE_SESSIONS, sessions);
        }

        function getSessionForUrl(serverUrl) {
            var sessions = loadSessions();
            return sessions[serverUrl] || null;
        }

        function setActiveSession(serverUrl, session) {
            var sessions = loadSessions();
            sessions[serverUrl] = session;
            saveSessions(sessions);
            storage.setItem(STORAGE_ACTIVE_SERVER, serverUrl);
        }

        function clearActiveSession(serverUrl) {
            var sessions = loadSessions();
            delete sessions[serverUrl];
            saveSessions(sessions);
            var active = storage.getItem(STORAGE_ACTIVE_SERVER);
            if (active === serverUrl) {
                storage.removeItem(STORAGE_ACTIVE_SERVER);
            }
        }

        function readResponseBody(response, timer, controller) {
            return response.text().then(
                function (bodyText) {
                    if (timer) {
                        clearTimeout(timer);
                    }
                    return bodyText;
                },
                function (err) {
                    if (timer) {
                        clearTimeout(timer);
                    }
                    throw err;
                }
            );
        }

        function jellyfinRequest(serverUrl, path, init, accessToken) {
            var url = joinServerPath(serverUrl, path);
            var headers = Object.assign({}, (init && init.headers) || {});
            headers.Authorization = buildAuthHeader(deviceId, deviceName, accessToken || "");
            if (init && init.body && !headers["Content-Type"]) {
                headers["Content-Type"] = "application/json";
            }
            var controller = new AbortController();
            var timer = setTimeout(function () {
                controller.abort();
            }, requestTimeoutMs);

            return fetchFn(url, Object.assign({}, init, { headers: headers, signal: controller.signal }))
                .then(function (response) {
                    return readResponseBody(response, timer, controller).then(function (bodyText) {
                        return { response: response, bodyText: bodyText };
                    });
                })
                .catch(function (err) {
                    if (timer) {
                        clearTimeout(timer);
                    }
                    throw err;
                });
        }

        function parseJsonBody(bodyText) {
            if (!bodyText) {
                return null;
            }
            try {
                return JSON.parse(bodyText);
            } catch (parseErr) {
                return null;
            }
        }

        function parsePublicInfo(data) {
            if (!data || typeof data !== "object") {
                return null;
            }
            var name = data.ServerName || data.serverName;
            if (!name && !data.Id && !data.id) {
                return null;
            }
            return {
                serverName: name || "Silo Server",
                id: data.Id || data.id || null
            };
        }

        function serverInfo(urlInput) {
            var serverUrl = normalizeServerUrl(urlInput);
            if (!serverUrl) {
                return Promise.resolve({ ok: false, error: { code: "invalid_url", message: "Enter a valid server address." } });
            }

            return jellyfinRequest(serverUrl, "/System/Info/Public", { method: "GET" }, "")
                .then(function (result) {
                    var response = result.response;
                    if (!response.ok) {
                        return { ok: false, error: { code: "not_silo", message: "Not a Silo or Jellyfin server." } };
                    }
                    var info = parsePublicInfo(parseJsonBody(result.bodyText));
                    if (!info) {
                        return { ok: false, error: { code: "not_silo", message: "Not a Silo or Jellyfin server." } };
                    }
                    return { ok: true, serverUrl: serverUrl, serverName: info.serverName };
                })
                .catch(function (err) {
                    return { ok: false, error: mapFetchError(err) };
                });
        }

        function signIn(urlInput, username, password) {
            var serverUrl = normalizeServerUrl(urlInput);
            if (!serverUrl) {
                return Promise.resolve({ ok: false, error: { code: "invalid_url", message: "Enter a valid server address." } });
            }
            if (!username || !password) {
                return Promise.resolve({ ok: false, error: { code: "invalid_credentials", message: "Enter username and password." } });
            }

            var body = JSON.stringify({ Username: username, Pw: password });

            return jellyfinRequest(serverUrl, "/Users/AuthenticateByName", { method: "POST", body: body }, "")
                .then(function (result) {
                    var response = result.response;
                    if (response.status === 401) {
                        return { ok: false, error: { code: "unauthorized", message: "Incorrect username or password." } };
                    }
                    if (!response.ok) {
                        return { ok: false, error: { code: "auth_failed", message: "Sign-in failed." } };
                    }
                    var data = parseJsonBody(result.bodyText);
                    var token = data && data.AccessToken;
                    var user = (data && data.User) || {};
                    if (!token || !user.Id) {
                        return { ok: false, error: { code: "auth_failed", message: "Sign-in failed." } };
                    }
                    return serverInfo(serverUrl).then(function (infoResult) {
                        var serverName = infoResult.ok ? infoResult.serverName : serverUrl;
                        var session = {
                            serverUrl: serverUrl,
                            userId: user.Id,
                            userName: user.Name || username,
                            accessToken: token,
                            serverName: serverName
                        };
                        setActiveSession(serverUrl, session);
                        return { ok: true, session: session };
                    });
                })
                .catch(function (err) {
                    return { ok: false, error: mapFetchError(err) };
                });
        }

        function signOut() {
            var session = currentSession();
            if (!session || !session.serverUrl) {
                return Promise.resolve();
            }
            var serverUrl = session.serverUrl;
            var token = session.accessToken;
            return jellyfinRequest(serverUrl, "/Sessions/Logout", { method: "POST" }, token)
                .catch(function () {
                    /* Best-effort server logout */
                })
                .then(function () {
                    clearActiveSession(serverUrl);
                });
        }

        function currentSession() {
            var activeUrl = storage.getItem(STORAGE_ACTIVE_SERVER);
            if (!activeUrl) {
                return null;
            }
            return getSessionForUrl(activeUrl);
        }

        function validateSession() {
            var session = currentSession();
            if (!session) {
                return Promise.resolve({ ok: false });
            }
            var userPath = "/Users/Me";
            return jellyfinRequest(session.serverUrl, userPath, { method: "GET" }, session.accessToken)
                .then(function (result) {
                    var response = result.response;
                    if (response.status === 401 || response.status === 403) {
                        clearActiveSession(session.serverUrl);
                        return { ok: false, error: { code: "unauthorized", message: "Session expired. Sign in again." } };
                    }
                    if (!response.ok) {
                        return {
                            ok: false,
                            offline: true,
                            session: session,
                            error: { code: "server_error", message: "Could not verify your session." }
                        };
                    }
                    var user = parseJsonBody(result.bodyText);
                    if (!user || !user.Id) {
                        clearActiveSession(session.serverUrl);
                        return { ok: false, error: { code: "unauthorized", message: "Session expired. Sign in again." } };
                    }
                    session.userName = user.Name || session.userName;
                    session.userId = user.Id;
                    setActiveSession(session.serverUrl, session);
                    return { ok: true, session: session };
                })
                .catch(function (err) {
                    var mapped = mapFetchError(err);
                    return {
                        ok: false,
                        offline: true,
                        session: session,
                        error: mapped
                    };
                });
        }

        return {
            serverInfo: serverInfo,
            signIn: signIn,
            signOut: signOut,
            currentSession: currentSession,
            validateSession: validateSession,
            normalizeServerUrl: normalizeServerUrl,
            joinServerPath: joinServerPath,
            buildAuthHeader: function (token) {
                return buildAuthHeader(deviceId, deviceName, token || "");
            },
            _deviceId: deviceId,
            _deviceName: deviceName
        };
    }

    return {
        createBackend: createBackend,
        APP_VERSION: APP_VERSION,
        CLIENT_NAME: CLIENT_NAME,
        DEFAULT_PORT: DEFAULT_PORT,
        REQUEST_TIMEOUT_MS: REQUEST_TIMEOUT_MS,
        normalizeServerUrl: normalizeServerUrl,
        joinServerPath: joinServerPath,
        buildAuthHeaderForTest: buildAuthHeader
    };
});
