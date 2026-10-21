"use strict";

var http = require("http");
var url = require("url");

var LIBRARY_MOVIES = "lib-movies";
var LIBRARY_TV = "lib-tv";

function makeItem(id, name, type, extra) {
    extra = extra || {};
    return Object.assign(
        {
            Id: id,
            Name: name,
            Type: type,
            Overview: extra.overview || name + " overview.",
            ParentId: extra.parentId || null,
            ImageTags: extra.imageTags || (extra.noImage ? {} : { Primary: "tag-" + id }),
            UserData: extra.userData || null,
            RunTimeTicks: extra.runTimeTicks || 72000000000
        },
        extra.raw || {}
    );
}

function buildMovieItems(count, prefix) {
    prefix = prefix || "movie";
    var items = [];
    for (var i = 0; i < count; i++) {
        var id = prefix + "-" + String(i).padStart(3, "0");
        items.push(
            makeItem(id, "Movie " + (i + 1), "Movie", {
                parentId: LIBRARY_MOVIES,
                noImage: i === 2
            })
        );
    }
    return items;
}

var MOVIE_CATALOG = buildMovieItems(75, "movie");
var RESUME_ITEMS = [
    makeItem("resume-1", "Resume One", "Movie", {
        parentId: LIBRARY_MOVIES,
        userData: { PlaybackPositionTicks: 36000000000, PlayedPercentage: 50 }
    }),
    makeItem("resume-2", "Resume Two", "Episode", {
        parentId: LIBRARY_TV,
        userData: { PlaybackPositionTicks: 18000000000, PlayedPercentage: 25 }
    })
];
var LATEST_MOVIES = MOVIE_CATALOG.slice(0, 6);
var LATEST_TV = [
    makeItem("series-1", "Latest Series", "Series", { parentId: LIBRARY_TV }),
    makeItem("series-2", "Another Show", "Series", { parentId: LIBRARY_TV, noImage: true })
];
var LIBRARIES = [
    makeItem(LIBRARY_MOVIES, "Movies", "CollectionFolder", {
        raw: { CollectionType: "movies" },
        imageTags: { Primary: "lib-movies-tag" }
    }),
    makeItem(LIBRARY_TV, "TV Shows", "CollectionFolder", {
        raw: { CollectionType: "tvshows" },
        imageTags: { Primary: "lib-tv-tag" }
    })
];

function createMockJellyfinServer(options) {
    options = options || {};
    var auth401 = options.auth401 === true;
    var hang = options.hang === true;
    var pathPrefix = options.pathPrefix || "";
    var usersMe401 = options.usersMe401 === true;
    var usersMe503 = options.usersMe503 === true;
    var stallUsersMeBody = options.stallUsersMeBody === true;
    var quickConnectEnabled = options.quickConnectEnabled;
    var quickConnectEnabledStatus = options.quickConnectEnabledStatus;
    var quickConnectInitiateFail = options.quickConnectInitiateFail === true;
    var quickConnectPollsUntilAuth = options.quickConnectPollsUntilAuth;
    var quickConnectExpired = options.quickConnectExpired === true;
    var quickConnectPollFail = options.quickConnectPollFail === true;
    var quickConnectAuth401 = options.quickConnectAuth401 === true;
    var quickConnectCode = options.quickConnectCode || "482913";
    var quickConnectSecret = options.quickConnectSecret || "mock-quick-connect-secret";
    var logoutCalls = 0;
    var quickConnectPollCalls = 0;
    var server = null;

    function pathMatches(reqUrl, suffix) {
        var pathOnly = reqUrl.split("?")[0];
        if (pathPrefix) {
            return pathOnly === pathPrefix + suffix;
        }
        return pathOnly === suffix;
    }

    function pathEndsWith(reqUrl, suffix) {
        var pathOnly = reqUrl.split("?")[0];
        if (pathPrefix) {
            return pathOnly === pathPrefix + suffix || pathOnly.endsWith(suffix);
        }
        return pathOnly.endsWith(suffix);
    }

    server = http.createServer(function (req, res) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }

        if (hang) {
            return;
        }

        if (req.method === "GET" && pathMatches(req.url, "/System/Info/Public")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ServerName: "Mock Silo", Id: "mock-server-id" }));
            return;
        }

        if (req.method === "GET" && pathMatches(req.url, "/Users/Me")) {
            if (usersMe401) {
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end("{}");
                return;
            }
            if (usersMe503) {
                res.writeHead(503, { "Content-Type": "application/json" });
                res.end("{}");
                return;
            }
            if (stallUsersMeBody) {
                res.writeHead(200, { "Content-Type": "application/json" });
                return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ Id: "user-123", Name: "Test User" }));
            return;
        }

        if (req.method === "GET" && pathEndsWith(req.url, "/Users/user-123/Views")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ Items: LIBRARIES }));
            return;
        }

        if (req.method === "GET" && pathEndsWith(req.url, "/Users/user-123/Items/Resume")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ Items: RESUME_ITEMS }));
            return;
        }

        if (req.method === "GET" && req.url.indexOf("/Users/user-123/Items/Latest") !== -1) {
            var parsedLatest = url.parse(req.url, true);
            var parentId = parsedLatest.query.ParentId;
            var latestItems = parentId === LIBRARY_TV ? LATEST_TV : LATEST_MOVIES;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(latestItems));
            return;
        }

        if (req.method === "GET" && req.url.indexOf("/Users/user-123/Items?") !== -1) {
            var parsedItems = url.parse(req.url, true);
            var q = parsedItems.query;
            var start = parseInt(q.StartIndex || "0", 10);
            var limit = parseInt(q.Limit || "60", 10);
            var parent = q.ParentId;
            var pool = parent === LIBRARY_TV ? LATEST_TV : MOVIE_CATALOG;
            var slice = pool.slice(start, start + limit);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({
                    Items: slice,
                    TotalRecordCount: pool.length,
                    StartIndex: start
                })
            );
            return;
        }

        if (req.method === "GET" && req.url.indexOf("/Users/user-123/Items/") !== -1) {
            var detailPath = req.url.split("?")[0];
            var itemId = detailPath.split("/").pop();
            var found = null;
            [].concat(MOVIE_CATALOG, LATEST_TV, RESUME_ITEMS, LIBRARIES).some(function (item) {
                if (item.Id === itemId) {
                    found = item;
                    return true;
                }
                return false;
            });
            if (found) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(found));
                return;
            }
        }

        if (req.method === "GET" && req.url.indexOf("/Items/") !== -1 && req.url.indexOf("/Images/Primary") !== -1) {
            res.writeHead(200, { "Content-Type": "image/png" });
            res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
            return;
        }

        if (req.method === "POST" && pathMatches(req.url, "/Sessions/Logout")) {
            logoutCalls += 1;
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.method === "GET" && pathMatches(req.url, "/QuickConnect/Enabled")) {
            if (quickConnectEnabledStatus) {
                res.writeHead(quickConnectEnabledStatus, { "Content-Type": "application/json" });
                res.end("{}");
                return;
            }
            var enabledValue = options.quickConnectEnabled === true;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(enabledValue));
            return;
        }

        if (req.method === "POST" && pathMatches(req.url, "/QuickConnect/Initiate")) {
            if (quickConnectInitiateFail) {
                res.writeHead(503, { "Content-Type": "application/json" });
                res.end("{}");
                return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({
                    Secret: quickConnectSecret,
                    Code: quickConnectCode
                })
            );
            return;
        }

        if (req.method === "GET" && pathMatches(req.url, "/QuickConnect/Connect")) {
            quickConnectPollCalls += 1;
            if (quickConnectPollFail) {
                res.writeHead(503, { "Content-Type": "application/json" });
                res.end("{}");
                return;
            }
            if (quickConnectExpired) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ Message: "Secret expired" }));
                return;
            }
            var threshold = typeof quickConnectPollsUntilAuth === "number" ? quickConnectPollsUntilAuth : 1;
            var authenticated = quickConnectPollCalls >= threshold;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ Authenticated: authenticated }));
            return;
        }

        if (req.method === "POST" && pathMatches(req.url, "/Users/AuthenticateWithQuickConnect")) {
            var qcChunks = [];
            req.on("data", function (chunk) {
                qcChunks.push(chunk);
            });
            req.on("end", function () {
                if (quickConnectAuth401) {
                    res.writeHead(401, { "Content-Type": "application/json" });
                    res.end("{}");
                    return;
                }
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(
                    JSON.stringify({
                        AccessToken: "mock-qc-access-token",
                        User: { Id: "user-qc-456", Name: "QC User" }
                    })
                );
            });
            return;
        }

        if (req.method === "POST" && pathMatches(req.url, "/Users/AuthenticateByName")) {
            var chunks = [];
            req.on("data", function (chunk) {
                chunks.push(chunk);
            });
            req.on("end", function () {
                if (auth401) {
                    res.writeHead(401, { "Content-Type": "application/json" });
                    res.end("{}");
                    return;
                }
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(
                    JSON.stringify({
                        AccessToken: "mock-access-token",
                        User: { Id: "user-123", Name: "Test User" }
                    })
                );
            });
            return;
        }

        res.writeHead(404);
        res.end();
    });

    return new Promise(function (resolve) {
        server.listen(0, "127.0.0.1", function () {
            var port = server.address().port;
            resolve({
                baseUrl: "http://127.0.0.1:" + port + pathPrefix,
                getLogoutCalls: function () {
                    return logoutCalls;
                },
                getQuickConnectPollCalls: function () {
                    return quickConnectPollCalls;
                },
                resetQuickConnectPollCalls: function () {
                    quickConnectPollCalls = 0;
                },
                close: function () {
                    return new Promise(function (resClose) {
                        server.close(function () {
                            resClose();
                        });
                    });
                }
            });
        });
    });
}

module.exports = {
    createMockJellyfinServer: createMockJellyfinServer,
    LIBRARY_MOVIES: LIBRARY_MOVIES,
    LIBRARY_TV: LIBRARY_TV
};
