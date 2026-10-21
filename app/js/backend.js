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

    function itemTypesForLibrary(collectionType) {
        var kind = String(collectionType || "").toLowerCase();
        if (kind === "movies") {
            return "Movie";
        }
        if (kind === "tvshows") {
            return "Series";
        }
        if (kind === "music") {
            return "MusicAlbum,Audio";
        }
        return "Movie,Series,Episode,Video";
    }

    var TICKS_PER_SECOND = 10000000;
    var RESUME_END_MARGIN_SEC = 5;

    function buildTizenDeviceProfile(deviceId, deviceName) {
        return {
            MaxStreamingBitrate: 120000000,
            MaxStaticBitrate: 100000000,
            MusicStreamingTranscodingBitrate: 384000,
            TimelineOffsetSeconds: 0,
            RequiresAvcEncoding: false,
            EnableSubtitlesInManifest: false,
            Id: deviceId,
            Name: deviceName,
            DirectPlayProfiles: [
                {
                    Type: "Video",
                    Container: "mp4,mkv,ts",
                    VideoCodec: "h264,hevc",
                    AudioCodec: "aac,ac3,eac3"
                }
            ],
            TranscodingProfiles: [
                {
                    Container: "ts",
                    Type: "Video",
                    VideoCodec: "h264",
                    AudioCodec: "aac,ac3,eac3",
                    Protocol: "hls",
                    Context: "Streaming",
                    MaxAudioChannels: "6"
                }
            ],
            CodecProfiles: [],
            SubtitleProfiles: [{ Format: "srt", Method: "External" }]
        };
    }

    function resumePositionSeconds(userData, runTimeTicks) {
        if (!userData || !userData.PlaybackPositionTicks) {
            return 0;
        }
        var positionTicks = userData.PlaybackPositionTicks;
        if (positionTicks <= 0) {
            return 0;
        }
        var runTicks = runTimeTicks || 0;
        if (runTicks > 0) {
            var remainingTicks = runTicks - positionTicks;
            if (remainingTicks <= RESUME_END_MARGIN_SEC * TICKS_PER_SECOND) {
                return 0;
            }
        }
        return Math.floor(positionTicks / TICKS_PER_SECOND);
    }

    function appendApiKeyToUrl(serverUrl, streamUrl, accessToken) {
        if (!streamUrl) {
            return "";
        }
        var absolute = streamUrl;
        if (streamUrl.indexOf("http://") !== 0 && streamUrl.indexOf("https://") !== 0) {
            absolute = joinServerPath(serverUrl, streamUrl);
        }
        if (absolute.indexOf("api_key=") !== -1) {
            return absolute;
        }
        var sep = absolute.indexOf("?") === -1 ? "?" : "&";
        return absolute + sep + "api_key=" + encodeURIComponent(accessToken);
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

        function mapBrowseItem(raw) {
            if (!raw || !raw.Id) {
                return null;
            }
            return {
                id: raw.Id,
                title: raw.Name || raw.SeriesName || "Untitled",
                type: raw.Type || "Unknown",
                overview: raw.Overview || "",
                imageTag: raw.ImageTags && raw.ImageTags.Primary ? raw.ImageTags.Primary : null,
                parentId: raw.ParentId || null,
                runTimeTicks: raw.RunTimeTicks || 0,
                userData: raw.UserData || null
            };
        }

        function mapBrowseItems(list) {
            if (!Array.isArray(list)) {
                return [];
            }
            var out = [];
            list.forEach(function (raw) {
                var mapped = mapBrowseItem(raw);
                if (mapped) {
                    out.push(mapped);
                }
            });
            return out;
        }

        function mapLibraryView(raw) {
            if (!raw || !raw.Id) {
                return null;
            }
            return {
                id: raw.Id,
                title: raw.Name || "Library",
                type: raw.CollectionType || raw.Type || "Unknown",
                imageTag: raw.ImageTags && raw.ImageTags.Primary ? raw.ImageTags.Primary : null
            };
        }

        function primaryImageUrl(itemId, options) {
            options = options || {};
            var session = currentSession();
            if (!session || !itemId) {
                return "";
            }
            var maxHeight = options.maxHeight != null ? options.maxHeight : 400;
            var quality = options.quality != null ? options.quality : 90;
            var query =
                "maxHeight=" +
                encodeURIComponent(String(maxHeight)) +
                "&quality=" +
                encodeURIComponent(String(quality)) +
                "&api_key=" +
                encodeURIComponent(session.accessToken);
            return joinServerPath(session.serverUrl, "/Items/" + encodeURIComponent(itemId) + "/Images/Primary?" + query);
        }

        function unauthorizedBrowseResult(session) {
            clearActiveSession(session.serverUrl);
            return {
                ok: false,
                signedOut: true,
                error: { code: "unauthorized", message: "Session expired. Sign in again." }
            };
        }

        function browseAuthFailure(session, response) {
            if (response.status === 401 || response.status === 403) {
                return unauthorizedBrowseResult(session);
            }
            return null;
        }

        function browseHome() {
            var session = currentSession();
            if (!session) {
                return Promise.resolve({ ok: false, error: { code: "unauthorized", message: "Sign in required." } });
            }
            var userId = session.userId;
            var token = session.accessToken;
            var serverUrl = session.serverUrl;

            return jellyfinRequest(serverUrl, "/Users/" + encodeURIComponent(userId) + "/Views", { method: "GET" }, token)
                .then(function (viewsResult) {
                    var authFail = browseAuthFailure(session, viewsResult.response);
                    if (authFail) {
                        return authFail;
                    }
                    if (!viewsResult.response.ok) {
                        return { ok: false, error: { code: "browse_failed", message: "Could not load libraries." } };
                    }
                    var viewsData = parseJsonBody(viewsResult.bodyText);
                    var libraries = [];
                    (viewsData.Items || []).forEach(function (raw) {
                        var lib = mapLibraryView(raw);
                        if (lib) {
                            libraries.push(lib);
                        }
                    });

                    var resumePath = "/Users/" + encodeURIComponent(userId) + "/Items/Resume?Limit=24&Fields=PrimaryImageAspectRatio,Overview";
                    return jellyfinRequest(serverUrl, resumePath, { method: "GET" }, token).then(function (resumeResult) {
                        var resumeAuthFail = browseAuthFailure(session, resumeResult.response);
                        if (resumeAuthFail) {
                            return resumeAuthFail;
                        }
                        var resumeItems = [];
                        if (resumeResult.response.ok) {
                            var resumeData = parseJsonBody(resumeResult.bodyText);
                            resumeItems = mapBrowseItems(resumeData.Items || []);
                        }

                        var latestPromises = libraries.map(function (lib) {
                            var latestPath =
                                "/Users/" +
                                encodeURIComponent(userId) +
                                "/Items/Latest?ParentId=" +
                                encodeURIComponent(lib.id) +
                                "&Limit=24&Fields=PrimaryImageAspectRatio,Overview";
                            return jellyfinRequest(serverUrl, latestPath, { method: "GET" }, token).then(function (latestResult) {
                                var latestAuthFail = browseAuthFailure(session, latestResult.response);
                                if (latestAuthFail) {
                                    return latestAuthFail;
                                }
                                if (!latestResult.response.ok) {
                                    return { library: lib, items: [] };
                                }
                                var latestData = parseJsonBody(latestResult.bodyText);
                                var items = mapBrowseItems(Array.isArray(latestData) ? latestData : latestData.Items || []);
                                return { library: lib, items: items };
                            });
                        });

                        return Promise.all(latestPromises).then(function (latestRows) {
                            for (var rowIdx = 0; rowIdx < latestRows.length; rowIdx++) {
                                if (latestRows[rowIdx] && latestRows[rowIdx].signedOut) {
                                    return latestRows[rowIdx];
                                }
                            }
                            var sections = [];
                            if (resumeItems.length > 0) {
                                sections.push({
                                    id: "continue-watching",
                                    title: "Continue Watching",
                                    items: resumeItems
                                });
                            }
                            latestRows.forEach(function (row) {
                                if (row.items.length > 0) {
                                    sections.push({
                                        id: "latest-" + row.library.id,
                                        title: "Latest in " + row.library.title,
                                        items: row.items
                                    });
                                }
                            });
                            if (libraries.length > 0) {
                                sections.push({
                                    id: "my-libraries",
                                    title: "My Libraries",
                                    items: libraries.map(function (lib) {
                                        return {
                                            id: lib.id,
                                            title: lib.title,
                                            type: "Library",
                                            overview: "",
                                            imageTag: lib.imageTag,
                                            parentId: null,
                                            runTimeTicks: 0,
                                            userData: null,
                                            collectionType: lib.type
                                        };
                                    })
                                });
                            }
                            return { ok: true, sections: sections };
                        });
                    });
                })
                .catch(function (err) {
                    return { ok: false, error: mapFetchError(err) };
                });
        }

        function browseLibraryItems(libraryId, options) {
            options = options || {};
            var session = currentSession();
            if (!session) {
                return Promise.resolve({ ok: false, error: { code: "unauthorized", message: "Sign in required." } });
            }
            if (!libraryId) {
                return Promise.resolve({ ok: false, error: { code: "invalid_library", message: "Missing library." } });
            }
            var startIndex = options.startIndex != null ? options.startIndex : 0;
            var limit = options.limit != null ? options.limit : 60;
            var includeTypes = options.includeItemTypes || "Movie,Series,Episode,Video";
            var userId = session.userId;
            var query =
                "ParentId=" +
                encodeURIComponent(libraryId) +
                "&SortBy=SortName&SortOrder=Ascending&Recursive=true" +
                "&IncludeItemTypes=" +
                encodeURIComponent(includeTypes) +
                "&StartIndex=" +
                encodeURIComponent(String(startIndex)) +
                "&Limit=" +
                encodeURIComponent(String(limit)) +
                "&Fields=PrimaryImageAspectRatio,Overview";
            var path = "/Users/" + encodeURIComponent(userId) + "/Items?" + query;

            return jellyfinRequest(session.serverUrl, path, { method: "GET" }, session.accessToken)
                .then(function (result) {
                    var authFail = browseAuthFailure(session, result.response);
                    if (authFail) {
                        return authFail;
                    }
                    if (!result.response.ok) {
                        return { ok: false, error: { code: "browse_failed", message: "Could not load library items." } };
                    }
                    var data = parseJsonBody(result.bodyText);
                    return {
                        ok: true,
                        items: mapBrowseItems(data.Items || []),
                        totalRecordCount: data.TotalRecordCount != null ? data.TotalRecordCount : 0,
                        startIndex: startIndex
                    };
                })
                .catch(function (err) {
                    return { ok: false, error: mapFetchError(err) };
                });
        }

        function browseItemDetails(itemId) {
            var session = currentSession();
            if (!session) {
                return Promise.resolve({ ok: false, error: { code: "unauthorized", message: "Sign in required." } });
            }
            if (!itemId) {
                return Promise.resolve({ ok: false, error: { code: "invalid_item", message: "Missing item." } });
            }
            var path =
                "/Users/" +
                encodeURIComponent(session.userId) +
                "/Items/" +
                encodeURIComponent(itemId) +
                "?Fields=Overview,PrimaryImageAspectRatio";
            return jellyfinRequest(session.serverUrl, path, { method: "GET" }, session.accessToken)
                .then(function (result) {
                    var authFail = browseAuthFailure(session, result.response);
                    if (authFail) {
                        return authFail;
                    }
                    if (!result.response.ok) {
                        return { ok: false, error: { code: "browse_failed", message: "Could not load item details." } };
                    }
                    var raw = parseJsonBody(result.bodyText);
                    var item = mapBrowseItem(raw);
                    if (!item) {
                        return { ok: false, error: { code: "browse_failed", message: "Could not load item details." } };
                    }
                    return { ok: true, item: item };
                })
                .catch(function (err) {
                    return { ok: false, error: mapFetchError(err) };
                });
        }

        function playbackInfoRequest(itemId) {
            var session = currentSession();
            if (!session) {
                return Promise.resolve({ ok: false, error: { code: "unauthorized", message: "Sign in required." } });
            }
            var path = "/Items/" + encodeURIComponent(itemId) + "/PlaybackInfo";
            var body = JSON.stringify({
                DeviceProfile: buildTizenDeviceProfile(deviceId, deviceName)
            });
            return jellyfinRequest(session.serverUrl, path, { method: "POST", body: body }, session.accessToken).then(
                function (result) {
                    var authFail = browseAuthFailure(session, result.response);
                    if (authFail) {
                        return authFail;
                    }
                    if (!result.response.ok) {
                        return { ok: false, error: { code: "playback_failed", message: "Could not load playback info." } };
                    }
                    var data = parseJsonBody(result.bodyText);
                    return { ok: true, data: data || {} };
                }
            );
        }

        function pickMediaSource(playbackData, forceTranscode) {
            var sources = playbackData && playbackData.MediaSources;
            if (!Array.isArray(sources) || sources.length === 0) {
                return null;
            }
            return sources[0];
        }

        function resolveStreamFromSource(session, itemId, mediaSource, forceTranscode) {
            if (!mediaSource) {
                return { ok: false, error: { code: "playback_failed", message: "No playable source for this item." } };
            }
            var mediaSourceId = mediaSource.Id;
            var supportsDirect = mediaSource.SupportsDirectPlay === true && !forceTranscode;
            if (supportsDirect) {
                var directPath =
                    "/Videos/" +
                    encodeURIComponent(itemId) +
                    "/stream?static=true&MediaSourceId=" +
                    encodeURIComponent(mediaSourceId);
                return {
                    ok: true,
                    mode: "direct",
                    playMethod: "DirectPlay",
                    streamUrl: appendApiKeyToUrl(session.serverUrl, directPath, session.accessToken),
                    mediaSourceId: mediaSourceId
                };
            }
            var transcodeUrl = mediaSource.TranscodingUrl || "";
            if (!transcodeUrl && mediaSource.SupportsDirectStream === false) {
                return { ok: false, error: { code: "playback_failed", message: "No transcoding stream available." } };
            }
            if (!transcodeUrl) {
                return { ok: false, error: { code: "playback_failed", message: "Direct play is not supported for this title." } };
            }
            return {
                ok: true,
                mode: "transcode",
                playMethod: "Transcode",
                streamUrl: appendApiKeyToUrl(session.serverUrl, transcodeUrl, session.accessToken),
                mediaSourceId: mediaSourceId
            };
        }

        function playbackStreamForItem(itemId, options) {
            options = options || {};
            var forceTranscode = options.forceTranscode === true;
            var session = currentSession();
            if (!session) {
                return Promise.resolve({ ok: false, error: { code: "unauthorized", message: "Sign in required." } });
            }
            return browseItemDetails(itemId)
                .then(function (detailsResult) {
                    if (!detailsResult.ok) {
                        return detailsResult;
                    }
                    var item = detailsResult.item;
                    if (item.type !== "Movie" && item.type !== "Episode" && item.type !== "Video") {
                        return { ok: false, error: { code: "not_playable", message: "This item cannot be played." } };
                    }
                    return playbackInfoRequest(itemId).then(function (infoResult) {
                        if (!infoResult.ok) {
                            return infoResult;
                        }
                        var playSessionId = infoResult.data.PlaySessionId || "";
                        var mediaSource = pickMediaSource(infoResult.data, forceTranscode);
                        var stream = resolveStreamFromSource(session, itemId, mediaSource, forceTranscode);
                        if (!stream.ok) {
                            return stream;
                        }
                        return {
                            ok: true,
                            itemId: itemId,
                            title: item.title,
                            playSessionId: playSessionId,
                            mediaSourceId: stream.mediaSourceId,
                            mode: stream.mode,
                            playMethod: stream.playMethod,
                            streamUrl: stream.streamUrl,
                            startSeconds: resumePositionSeconds(item.userData, item.runTimeTicks),
                            runTimeTicks: item.runTimeTicks
                        };
                    });
                })
                .catch(function (err) {
                    return { ok: false, error: mapFetchError(err) };
                });
        }

        function playbackSessionBody(fields) {
            var session = currentSession();
            if (!session) {
                return null;
            }
            return {
                ItemId: fields.itemId,
                MediaSourceId: fields.mediaSourceId,
                PlaySessionId: fields.playSessionId || "",
                PositionTicks: fields.positionTicks != null ? fields.positionTicks : 0,
                IsPaused: fields.isPaused === true,
                IsMuted: false,
                PlayMethod: fields.playMethod || "DirectPlay",
                CanSeek: true
            };
        }

        function playbackStart(fields) {
            var session = currentSession();
            if (!session) {
                return Promise.resolve({ ok: false });
            }
            var body = playbackSessionBody(fields);
            if (!body) {
                return Promise.resolve({ ok: false });
            }
            return jellyfinRequest(session.serverUrl, "/Sessions/Playing", { method: "POST", body: JSON.stringify(body) }, session.accessToken)
                .then(function (result) {
                    return { ok: result.response.ok };
                })
                .catch(function () {
                    return { ok: false };
                });
        }

        function playbackProgress(fields) {
            var session = currentSession();
            if (!session) {
                return Promise.resolve({ ok: false });
            }
            var body = playbackSessionBody(fields);
            if (!body) {
                return Promise.resolve({ ok: false });
            }
            return jellyfinRequest(
                session.serverUrl,
                "/Sessions/Playing/Progress",
                { method: "POST", body: JSON.stringify(body) },
                session.accessToken
            )
                .then(function (result) {
                    return { ok: result.response.ok };
                })
                .catch(function () {
                    return { ok: false };
                });
        }

        function playbackStop(fields) {
            var session = currentSession();
            if (!session) {
                return Promise.resolve({ ok: false });
            }
            var body = playbackSessionBody(fields);
            if (!body) {
                return Promise.resolve({ ok: false });
            }
            return jellyfinRequest(
                session.serverUrl,
                "/Sessions/Playing/Stopped",
                { method: "POST", body: JSON.stringify(body) },
                session.accessToken
            )
                .then(function (result) {
                    return { ok: result.response.ok };
                })
                .catch(function () {
                    return { ok: false };
                });
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
            browseHome: browseHome,
            browseLibraryItems: browseLibraryItems,
            browseItemDetails: browseItemDetails,
            playbackStreamForItem: playbackStreamForItem,
            playbackStart: playbackStart,
            playbackProgress: playbackProgress,
            playbackStop: playbackStop,
            resumePositionSeconds: resumePositionSeconds,
            primaryImageUrl: primaryImageUrl,
            itemTypesForLibrary: itemTypesForLibrary,
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
        buildAuthHeaderForTest: buildAuthHeader,
        itemTypesForLibrary: itemTypesForLibrary,
        buildTizenDeviceProfile: buildTizenDeviceProfile,
        resumePositionSeconds: resumePositionSeconds,
        TICKS_PER_SECOND: TICKS_PER_SECOND,
        RESUME_END_MARGIN_SEC: RESUME_END_MARGIN_SEC
    };
});
