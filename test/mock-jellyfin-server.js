"use strict";

var http = require("http");

function createMockJellyfinServer(options) {
    options = options || {};
    var auth401 = options.auth401 === true;
    var hang = options.hang === true;
    var pathPrefix = options.pathPrefix || "";
    var usersMe401 = options.usersMe401 === true;
    var usersMe503 = options.usersMe503 === true;
    var stallUsersMeBody = options.stallUsersMeBody === true;
    var logoutCalls = 0;
    var server = null;

    function pathMatches(url, suffix) {
        var pathOnly = url.split("?")[0];
        if (pathPrefix) {
            return pathOnly === pathPrefix + suffix;
        }
        return pathOnly === suffix;
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

        if (req.method === "POST" && pathMatches(req.url, "/Sessions/Logout")) {
            logoutCalls += 1;
            res.writeHead(204);
            res.end();
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

module.exports = { createMockJellyfinServer };
