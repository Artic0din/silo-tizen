(function () {
    "use strict";

    var KEY_BACK = 10009;
    var KEY_EXIT = 10182;

    var statusEl = document.getElementById("status");
    var focusAnchor = document.getElementById("focus-anchor");

    function setStatus(message) {
        if (statusEl) {
            statusEl.textContent = message;
        }
    }

    function exitApp() {
        try {
            var app = tizen.application.getCurrentApplication();
            app.exit();
        } catch (err) {
            setStatus("Exit requested (browser preview).");
        }
    }

    function registerRemoteKeys() {
        if (!window.tizen || !tizen.tvinputdevice) {
            setStatus("Pre-MVP scaffold — TV APIs unavailable in this preview.");
            return;
        }

        var keys = [
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
            "Enter",
            "MediaPlayPause",
            "MediaPlay",
            "MediaPause",
            "MediaStop",
            "MediaRewind",
            "MediaFastForward"
        ];

        keys.forEach(function (keyName) {
            try {
                tizen.tvinputdevice.registerKey(keyName);
            } catch (registerErr) {
                /* Some keys are optional on older firmware. */
            }
        });

        setStatus("Pre-MVP scaffold — remote keys registered.");
    }

    function ensureFocus() {
        if (document.activeElement !== focusAnchor && focusAnchor) {
            focusAnchor.focus();
            focusAnchor.classList.add("focused");
        }
    }

    function onKeyDown(event) {
        var code = event.keyCode;

        if (code === KEY_BACK || code === KEY_EXIT) {
            event.preventDefault();
            exitApp();
            return;
        }

        if (code === 13 && document.activeElement === focusAnchor) {
            setStatus("OK pressed — sign-in and playback arrive in a later release.");
        }

        ensureFocus();
    }

    function init() {
        registerRemoteKeys();

        if (focusAnchor) {
            focusAnchor.addEventListener("focus", function () {
                focusAnchor.classList.add("focused");
            });
            focusAnchor.addEventListener("blur", function () {
                focusAnchor.classList.remove("focused");
            });
            focusAnchor.addEventListener("click", function () {
                setStatus("OK pressed — sign-in and playback arrive in a later release.");
            });
        }

        document.addEventListener("keydown", onKeyDown, false);
        document.addEventListener("visibilitychange", function () {
            if (document.hidden) {
                setStatus("App hidden — playback suspend hooks will run here later.");
            } else {
                setStatus("App visible — playback restore hooks will run here later.");
            }
        });

        window.addEventListener("load", ensureFocus);
        ensureFocus();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
