/* Minimal stub for browser / headless UI tests (real firmware loads $WEBAPIS/webapis/webapis.js). */
(function () {
    "use strict";

    var currentUrl = "";
    var currentTimeMs = 0;
    var durationMs = 7200000;
    var isPaused = false;
    var listener = null;
    var failDirectPlayOnce = false;
    var failAllOpen = false;

    function avplay() {
        return {
            open: function (url) {
                currentUrl = url;
                if (failAllOpen) {
                    throw new Error("open failed");
                }
                if (failDirectPlayOnce && url.indexOf("static=true") !== -1) {
                    failDirectPlayOnce = false;
                    throw new Error("direct play failed");
                }
            },
            close: function () {
                currentUrl = "";
            },
            stop: function () {
                /* noop */
            },
            prepareAsync: function (success) {
                setTimeout(function () {
                    if (typeof success === "function") {
                        success();
                    }
                }, 0);
            },
            play: function () {
                isPaused = false;
            },
            pause: function () {
                isPaused = true;
            },
            seekTo: function (ms, success) {
                currentTimeMs = ms;
                if (typeof success === "function") {
                    success();
                }
            },
            getCurrentTime: function () {
                return currentTimeMs;
            },
            getDuration: function () {
                return durationMs;
            },
            setDisplayRect: function () {
                /* noop */
            },
            setListener: function (l) {
                listener = l;
            },
            _test: {
                getCurrentUrl: function () {
                    return currentUrl;
                },
                setDurationMs: function (ms) {
                    durationMs = ms;
                },
                setCurrentTimeMs: function (ms) {
                    currentTimeMs = ms;
                },
                setFailDirectPlayOnce: function (value) {
                    failDirectPlayOnce = value === true;
                },
                setFailAllOpen: function (value) {
                    failAllOpen = value === true;
                },
                fireError: function () {
                    if (listener && listener.onerror) {
                        listener.onerror("stub-error");
                    }
                },
                reset: function () {
                    currentUrl = "";
                    currentTimeMs = 0;
                    durationMs = 7200000;
                    isPaused = false;
                    failDirectPlayOnce = false;
                    failAllOpen = false;
                }
            }
        };
    }

    window.webapis = {
        productinfo: {
            getRealModel: function () {
                return "Test TV";
            }
        },
        avplay: avplay()
    };
})();
