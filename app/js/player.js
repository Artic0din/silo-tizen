/**
 * AVPlay wrapper for Silo Tizen playback (direct play first, HLS transcode fallback).
 */
(function (root, factory) {
    var api = factory();
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
    if (typeof window !== "undefined") {
        window.SiloPlayerFactory = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    var TICKS_PER_SECOND = 10000000;
    var PROGRESS_INTERVAL_MS = 10000;
    var SEEK_BACK_SEC = 10;
    var SEEK_FORWARD_SEC = 30;

    function resolveAvPlay(customAvplay) {
        if (customAvplay) {
            return customAvplay;
        }
        try {
            if (typeof webapis !== "undefined" && webapis.avplay) {
                return webapis.avplay;
            }
        } catch (avErr) {
            /* Browser preview */
        }
        return null;
    }

    function createPlayer(options) {
        options = options || {};
        var backend = options.backend;
        var avplay = resolveAvPlay(options.avplay);
        var onUiUpdate = options.onUiUpdate || function () {};
        var onExit = options.onExit || function () {};
        var displayWidth = options.displayWidth != null ? options.displayWidth : 1920;
        var displayHeight = options.displayHeight != null ? options.displayHeight : 1080;

        var state = {
            active: false,
            itemId: "",
            title: "",
            playSessionId: "",
            mediaSourceId: "",
            playMethod: "",
            mode: "",
            streamUrl: "",
            startSeconds: 0,
            durationMs: 0,
            positionMs: 0,
            paused: false,
            error: "",
            triedTranscodeFallback: false,
            progressTimer: null,
            sessionStarted: false,
            returnContext: null
        };

        function clearProgressTimer() {
            if (state.progressTimer) {
                clearInterval(state.progressTimer);
                state.progressTimer = null;
            }
        }

        function positionTicks() {
            return Math.floor(state.positionMs * 10000);
        }

        function notifyUi() {
            onUiUpdate({
                active: state.active,
                title: state.title,
                error: state.error,
                positionMs: state.positionMs,
                durationMs: state.durationMs,
                paused: state.paused
            });
        }

        function reportProgress(isPaused) {
            if (!state.sessionStarted || !backend || !state.itemId) {
                return Promise.resolve();
            }
            return backend.playbackProgress({
                itemId: state.itemId,
                mediaSourceId: state.mediaSourceId,
                playSessionId: state.playSessionId,
                positionTicks: positionTicks(),
                isPaused: isPaused === true,
                playMethod: state.playMethod
            });
        }

        function startProgressTimer() {
            clearProgressTimer();
            state.progressTimer = setInterval(function () {
                if (!state.active || state.error || !avplay) {
                    return;
                }
                try {
                    state.positionMs = avplay.getCurrentTime();
                    var dur = avplay.getDuration();
                    if (dur > 0) {
                        state.durationMs = dur;
                    }
                } catch (timeErr) {
                    /* Stub or stopped */
                }
                notifyUi();
                reportProgress(state.paused);
            }, PROGRESS_INTERVAL_MS);
        }

        function closeAvPlay() {
            if (!avplay) {
                return;
            }
            try {
                avplay.stop();
            } catch (stopErr) {
                /* Already stopped */
            }
            try {
                avplay.close();
            } catch (closeErr) {
                /* Already closed */
            }
        }

        function setListener() {
            if (!avplay || !avplay.setListener) {
                return;
            }
            avplay.setListener({
                onerror: function (err) {
                    if (!state.active) {
                        return;
                    }
                    if (state.mode === "direct" && !state.triedTranscodeFallback) {
                        state.triedTranscodeFallback = true;
                        retryWithTranscode();
                        return;
                    }
                    state.error = "Playback failed. Try again later.";
                    notifyUi();
                }
            });
        }

        function openStream(url, mode, playMethod, startSec) {
            state.mode = mode;
            state.playMethod = playMethod;
            state.streamUrl = url;
            state.error = "";
            if (!avplay) {
                state.error = "Video playback is not available on this device.";
                notifyUi();
                return Promise.resolve(false);
            }
            closeAvPlay();
            setListener();
            try {
                avplay.open(url);
                avplay.setDisplayRect(0, 0, displayWidth, displayHeight);
            } catch (openErr) {
                if (state.mode === "direct" && !state.triedTranscodeFallback) {
                    state.triedTranscodeFallback = true;
                    return retryWithTranscode();
                }
                state.error = "Could not open the video stream.";
                notifyUi();
                return Promise.resolve(false);
            }

            return new Promise(function (resolve) {
                try {
                    avplay.prepareAsync(
                        function () {
                            if (startSec > 0) {
                                try {
                                    avplay.seekTo(startSec * 1000, function () {
                                        beginPlayAfterPrepare(resolve);
                                    }, function () {
                                        beginPlayAfterPrepare(resolve);
                                    });
                                } catch (seekErr) {
                                    beginPlayAfterPrepare(resolve);
                                }
                            } else {
                                beginPlayAfterPrepare(resolve);
                            }
                        },
                        function () {
                            if (state.mode === "direct" && !state.triedTranscodeFallback) {
                                state.triedTranscodeFallback = true;
                                retryWithTranscode().then(resolve);
                                return;
                            }
                            state.error = "Could not prepare playback.";
                            notifyUi();
                            resolve(false);
                        }
                    );
                } catch (prepErr) {
                    state.error = "Could not prepare playback.";
                    notifyUi();
                    resolve(false);
                }
            });
        }

        function beginPlayAfterPrepare(resolve) {
            try {
                avplay.play();
                state.paused = false;
                try {
                    state.durationMs = avplay.getDuration();
                    state.positionMs = avplay.getCurrentTime();
                } catch (durErr) {
                    /* optional */
                }
                if (!state.sessionStarted) {
                    state.sessionStarted = true;
                    backend
                        .playbackStart({
                            itemId: state.itemId,
                            mediaSourceId: state.mediaSourceId,
                            playSessionId: state.playSessionId,
                            positionTicks: positionTicks(),
                            playMethod: state.playMethod
                        })
                        .catch(function () {
                            /* Best-effort */
                        });
                }
                startProgressTimer();
                notifyUi();
                resolve(true);
            } catch (playErr) {
                state.error = "Could not start playback.";
                notifyUi();
                resolve(false);
            }
        }

        function retryWithTranscode() {
            return backend
                .playbackStreamForItem(state.itemId, { forceTranscode: true })
                .then(function (resolved) {
                    if (!resolved.ok) {
                        state.error =
                            (resolved.error && resolved.error.message) || "Transcoding playback failed.";
                        notifyUi();
                        return false;
                    }
                    state.mediaSourceId = resolved.mediaSourceId;
                    state.playSessionId = resolved.playSessionId;
                    return openStream(resolved.streamUrl, resolved.mode, resolved.playMethod, state.startSeconds);
                });
        }

        function stopSession() {
            clearProgressTimer();
            if (state.sessionStarted && backend) {
                return backend
                    .playbackStop({
                        itemId: state.itemId,
                        mediaSourceId: state.mediaSourceId,
                        playSessionId: state.playSessionId,
                        positionTicks: positionTicks(),
                        playMethod: state.playMethod
                    })
                    .catch(function () {
                        /* Best-effort */
                    })
                    .then(function () {
                        state.sessionStarted = false;
                    });
            }
            return Promise.resolve();
        }

        function stopAndExit() {
            var ctx = state.returnContext;
            state.active = false;
            return stopSession().then(function () {
                closeAvPlay();
                state.itemId = "";
                state.error = "";
                notifyUi();
                onExit(ctx);
            });
        }

        function togglePause() {
            if (!state.active || state.error || !avplay) {
                return;
            }
            try {
                if (state.paused) {
                    avplay.play();
                    state.paused = false;
                } else {
                    avplay.pause();
                    state.paused = true;
                    reportProgress(true);
                }
                notifyUi();
            } catch (pauseErr) {
                /* ignore */
            }
        }

        function seekBy(deltaSec) {
            if (!state.active || state.error || !avplay) {
                return;
            }
            var nextMs = state.positionMs + deltaSec * 1000;
            if (nextMs < 0) {
                nextMs = 0;
            }
            if (state.durationMs > 0 && nextMs > state.durationMs) {
                nextMs = state.durationMs;
            }
            try {
                avplay.seekTo(
                    nextMs,
                    function () {
                        state.positionMs = nextMs;
                        notifyUi();
                        reportProgress(state.paused);
                    },
                    function () {
                        /* ignore seek failure */
                    }
                );
            } catch (seekErr) {
                /* ignore */
            }
        }

        function handleVisibility(hidden) {
            if (!state.active || !avplay) {
                return;
            }
            try {
                if (hidden) {
                    if (avplay.pause) {
                        avplay.pause();
                    }
                    state.paused = true;
                    reportProgress(true);
                    notifyUi();
                    return;
                }
                if (state.streamUrl) {
                    var resumeSec = state.positionMs / 1000;
                    openStream(state.streamUrl, state.mode, state.playMethod, resumeSec);
                }
            } catch (visErr) {
                /* Browser preview */
            }
        }

        function start(itemId, returnContext) {
            if (!backend) {
                return Promise.resolve({ ok: false, error: { message: "Backend missing." } });
            }
            state.active = true;
            state.itemId = itemId;
            state.returnContext = returnContext || null;
            state.triedTranscodeFallback = false;
            state.sessionStarted = false;
            state.error = "";
            state.title = "Loading…";
            notifyUi();

            return backend.playbackStreamForItem(itemId, { forceTranscode: false }).then(function (resolved) {
                if (!resolved.ok) {
                    state.error = (resolved.error && resolved.error.message) || "Could not start playback.";
                    notifyUi();
                    return { ok: false, error: resolved.error };
                }
                state.title = resolved.title;
                state.playSessionId = resolved.playSessionId;
                state.mediaSourceId = resolved.mediaSourceId;
                state.startSeconds = resolved.startSeconds;
                if (resolved.runTimeTicks) {
                    state.durationMs = resolved.runTimeTicks / 10000;
                }
                notifyUi();
                return openStream(resolved.streamUrl, resolved.mode, resolved.playMethod, resolved.startSeconds).then(
                    function (started) {
                        return { ok: started !== false && !state.error, error: state.error ? { message: state.error } : null };
                    }
                );
            });
        }

        return {
            start: start,
            stopAndExit: stopAndExit,
            togglePause: togglePause,
            seekBack: function () {
                seekBy(-SEEK_BACK_SEC);
            },
            seekForward: function () {
                seekBy(SEEK_FORWARD_SEC);
            },
            handleVisibility: handleVisibility,
            getState: function () {
                return {
                    active: state.active,
                    itemId: state.itemId,
                    error: state.error,
                    mode: state.mode,
                    triedTranscodeFallback: state.triedTranscodeFallback
                };
            },
            SEEK_BACK_SEC: SEEK_BACK_SEC,
            SEEK_FORWARD_SEC: SEEK_FORWARD_SEC,
            TICKS_PER_SECOND: TICKS_PER_SECOND
        };
    }

    return {
        createPlayer: createPlayer,
        SEEK_BACK_SEC: SEEK_BACK_SEC,
        SEEK_FORWARD_SEC: SEEK_FORWARD_SEC
    };
});
