(function () {
    "use strict";

    var KEY_BACK = 10009;
    var KEY_EXIT = 10182;
    var KEY_ENTER = 13;
    var KEY_LEFT = 37;
    var KEY_RIGHT = 39;

    var statusEl = document.getElementById("status");
    var focusAnchor = document.getElementById("focus-anchor");

    var exitDialog = null;
    var exitDialogYes = null;
    var exitDialogNo = null;
    var exitDialogOpen = false;

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

        var keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"];

        keys.forEach(function (keyName) {
            try {
                tizen.tvinputdevice.registerKey(keyName);
            } catch (registerErr) {
                /* Some keys are optional on older firmware. */
            }
        });

        setStatus("Pre-MVP scaffold — remote keys registered.");
    }

    function styleFocusableButton(button) {
        button.style.minWidth = "240px";
        button.style.padding = "28px 48px";
        button.style.border = "4px solid #4a4f6a";
        button.style.borderRadius = "12px";
        button.style.background = "#1e2030";
        button.style.color = "#f2f2f7";
        button.style.fontSize = "40px";
        button.style.fontWeight = "600";
        button.style.cursor = "pointer";
        button.style.outline = "none";
    }

    function applyFocusedButtonStyle(button, focused) {
        if (focused) {
            button.style.borderColor = "#5eb8ff";
            button.style.background = "#243048";
            button.style.boxShadow = "0 0 0 6px rgba(94, 184, 255, 0.35)";
        } else {
            button.style.borderColor = "#4a4f6a";
            button.style.background = "#1e2030";
            button.style.boxShadow = "none";
        }
    }

    function createExitDialog() {
        var overlay = document.createElement("div");
        overlay.id = "exit-dialog";
        overlay.hidden = true;
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-labelledby", "exit-dialog-title");
        overlay.style.position = "fixed";
        overlay.style.inset = "0";
        overlay.style.zIndex = "10";
        overlay.style.display = "flex";
        overlay.style.alignItems = "center";
        overlay.style.justifyContent = "center";
        overlay.style.background = "rgba(0, 0, 0, 0.72)";

        var panel = document.createElement("div");
        panel.style.maxWidth = "1200px";
        panel.style.padding = "64px 80px";
        panel.style.borderRadius = "16px";
        panel.style.background = "#1e2030";
        panel.style.border = "4px solid #4a4f6a";
        panel.style.textAlign = "center";

        var title = document.createElement("h2");
        title.id = "exit-dialog-title";
        title.textContent = "Exit Silo?";
        title.style.margin = "0 0 32px";
        title.style.fontSize = "56px";
        title.style.fontWeight = "700";
        title.style.color = "#f2f2f7";

        var message = document.createElement("p");
        message.textContent = "Do you want to close the app?";
        message.style.margin = "0 0 48px";
        message.style.fontSize = "42px";
        message.style.lineHeight = "1.35";
        message.style.color = "#c8cad8";

        var actions = document.createElement("div");
        actions.style.display = "flex";
        actions.style.gap = "32px";
        actions.style.justifyContent = "center";

        var yesButton = document.createElement("button");
        yesButton.type = "button";
        yesButton.id = "exit-dialog-yes";
        yesButton.textContent = "Yes";
        styleFocusableButton(yesButton);

        var noButton = document.createElement("button");
        noButton.type = "button";
        noButton.id = "exit-dialog-no";
        noButton.textContent = "No";
        styleFocusableButton(noButton);

        yesButton.addEventListener("focus", function () {
            applyFocusedButtonStyle(yesButton, true);
        });
        yesButton.addEventListener("blur", function () {
            applyFocusedButtonStyle(yesButton, false);
        });
        noButton.addEventListener("focus", function () {
            applyFocusedButtonStyle(noButton, true);
        });
        noButton.addEventListener("blur", function () {
            applyFocusedButtonStyle(noButton, false);
        });

        yesButton.addEventListener("click", function () {
            exitApp();
        });
        noButton.addEventListener("click", function () {
            closeExitDialog();
        });

        actions.appendChild(yesButton);
        actions.appendChild(noButton);
        panel.appendChild(title);
        panel.appendChild(message);
        panel.appendChild(actions);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        exitDialog = overlay;
        exitDialogYes = yesButton;
        exitDialogNo = noButton;
    }

    function openExitDialog() {
        if (!exitDialog) {
            createExitDialog();
        }
        exitDialogOpen = true;
        exitDialog.hidden = false;
        exitDialogNo.focus();
        applyFocusedButtonStyle(exitDialogNo, true);
    }

    function closeExitDialog() {
        if (!exitDialog) {
            return;
        }
        exitDialogOpen = false;
        exitDialog.hidden = true;
        applyFocusedButtonStyle(exitDialogYes, false);
        applyFocusedButtonStyle(exitDialogNo, false);
        if (focusAnchor) {
            focusAnchor.focus();
            focusAnchor.classList.add("focused");
        }
    }

    function focusDialogButton(button) {
        if (button) {
            button.focus();
        }
    }

    function handleExitDialogKeyDown(code) {
        if (code === KEY_BACK) {
            closeExitDialog();
            return true;
        }

        if (code === KEY_LEFT || code === KEY_RIGHT) {
            if (document.activeElement === exitDialogYes) {
                focusDialogButton(exitDialogNo);
            } else {
                focusDialogButton(exitDialogYes);
            }
            return true;
        }

        if (code === KEY_ENTER) {
            if (document.activeElement === exitDialogYes) {
                exitApp();
            } else {
                closeExitDialog();
            }
            return true;
        }

        return false;
    }

    function ensureFocus() {
        if (exitDialogOpen || !focusAnchor) {
            return;
        }
        if (document.activeElement !== focusAnchor) {
            focusAnchor.focus();
            focusAnchor.classList.add("focused");
        }
    }

    function onKeyDown(event) {
        var code = event.keyCode;

        if (exitDialogOpen) {
            if (handleExitDialogKeyDown(code)) {
                event.preventDefault();
            }
            return;
        }

        if (code === KEY_EXIT) {
            event.preventDefault();
            exitApp();
            return;
        }

        if (code === KEY_BACK) {
            event.preventDefault();
            openExitDialog();
            return;
        }

        if (code === KEY_ENTER && document.activeElement === focusAnchor) {
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
                if (!exitDialogOpen) {
                    focusAnchor.focus();
                    focusAnchor.classList.add("focused");
                }
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
