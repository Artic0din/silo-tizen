(function () {
    "use strict";

    var KEY_BACK = 10009;
    var KEY_EXIT = 10182;
    var KEY_ENTER = 13;
    var KEY_UP = 38;
    var KEY_DOWN = 40;
    var KEY_LEFT = 37;
    var KEY_RIGHT = 39;

    var backend = window.SiloBackend;
    var screenEl = document.getElementById("screen");

    var exitDialog = null;
    var exitDialogYes = null;
    var exitDialogNo = null;
    var exitDialogOpen = false;

    var state = {
        view: "loading",
        serverUrl: "",
        serverName: "",
        error: "",
        focusIds: [],
        focusIndex: 0,
        pendingServerUrl: "",
        requestGeneration: 0,
        submitOnNextEnter: ""
    };

    function bumpRequestGeneration() {
        state.requestGeneration += 1;
        return state.requestGeneration;
    }

    function isStaleRequest(generation) {
        return generation !== state.requestGeneration;
    }

    function clearScreen() {
        while (screenEl.firstChild) {
            screenEl.removeChild(screenEl.firstChild);
        }
    }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) {
            node.className = className;
        }
        if (text !== undefined && text !== null) {
            node.textContent = text;
        }
        return node;
    }

    function makeInput(id, labelText, inputType, value, placeholder) {
        var wrap = document.createElement("div");
        wrap.className = "field-wrap";
        var label = el("label", "field-label", labelText);
        label.setAttribute("for", id);
        var input = el("input", "field-input");
        input.id = id;
        input.type = inputType || "text";
        input.autocomplete = "off";
        input.spellcheck = false;
        if (value) {
            input.value = value;
        }
        if (placeholder) {
            input.placeholder = placeholder;
        }
        wrap.appendChild(label);
        wrap.appendChild(input);
        return { wrap: wrap, input: input };
    }

    function makeButton(id, label) {
        var button = el("button", "tv-button", label);
        button.type = "button";
        button.id = id;
        return button;
    }

    function bindFocusable(element) {
        element.addEventListener("focus", function () {
            element.classList.add("focused");
        });
        element.addEventListener("blur", function () {
            element.classList.remove("focused");
        });
    }

    function collectFocusables() {
        var nodes = screenEl.querySelectorAll(".field-input, .tv-button");
        state.focusIds = [];
        var list = [];
        nodes.forEach(function (node) {
            if (node.id) {
                state.focusIds.push(node.id);
            }
            list.push(node);
        });
        return list;
    }

    function focusByIndex(index) {
        var focusables = collectFocusables();
        if (focusables.length === 0) {
            return;
        }
        if (index < 0) {
            index = 0;
        }
        if (index >= focusables.length) {
            index = focusables.length - 1;
        }
        state.focusIndex = index;
        focusables[index].focus();
    }

    function ensureScreenFocus() {
        if (exitDialogOpen) {
            return;
        }
        var focusables = collectFocusables();
        if (focusables.length === 0) {
            return;
        }
        var active = document.activeElement;
        var inScreen = false;
        focusables.forEach(function (node) {
            if (node === active) {
                inScreen = true;
            }
        });
        if (!inScreen) {
            focusByIndex(state.focusIndex);
        }
    }

    function setError(message) {
        state.error = message || "";
        var errEl = document.getElementById("screen-error");
        if (errEl) {
            errEl.textContent = state.error;
            errEl.hidden = !state.error;
        }
    }

    function invalidatePendingRequests() {
        bumpRequestGeneration();
    }

    function submitForCurrentView() {
        if (state.view === "server") {
            onConnectClick();
        } else if (state.view === "signin") {
            onSignInClick();
        }
    }

    function renderConnectingScreen() {
        state.view = "connecting";
        clearScreen();
        screenEl.appendChild(el("p", "eyebrow", "Silo"));
        screenEl.appendChild(el("h1", "title", "Connecting…"));
        screenEl.appendChild(el("p", "subtitle", "Checking your saved session with the server."));
        var waitBtn = makeButton("connecting-wait", "Connecting…");
        waitBtn.setAttribute("aria-disabled", "true");
        screenEl.appendChild(waitBtn);
        bindFocusable(waitBtn);
        focusByIndex(0);
    }

    function renderOfflineScreen(session, message) {
        state.view = "offline";
        clearScreen();
        screenEl.appendChild(el("p", "eyebrow", "Offline"));
        screenEl.appendChild(el("h1", "title", "Could not reach server"));
        screenEl.appendChild(
            el(
                "p",
                "signed-in-line",
                "Signed in as " + session.userName + " on " + session.serverName
            )
        );
        var err = el("p", "error");
        err.id = "screen-error";
        err.textContent = message || "Server unreachable. Your session is still saved.";
        screenEl.appendChild(err);
        var retryBtn = makeButton("offline-retry", "Retry");
        screenEl.appendChild(retryBtn);
        bindFocusable(retryBtn);
        retryBtn.addEventListener("click", onOfflineRetryClick);
        focusByIndex(0);
    }

    function renderServerScreen() {
        invalidatePendingRequests();
        state.view = "server";
        clearScreen();
        screenEl.appendChild(el("p", "eyebrow", "Connect"));
        screenEl.appendChild(el("h1", "title", "Silo server"));
        screenEl.appendChild(el("p", "hint", "Example: http://192.168.x.x:8096 (port 8096 is used if omitted)"));

        var err = el("p", "error");
        err.id = "screen-error";
        err.hidden = !state.error;
        err.textContent = state.error;
        screenEl.appendChild(err);

        var stack = el("div", "form-stack");
        var urlField = makeInput("server-url", "Server URL", "text", state.serverUrl || state.pendingServerUrl, "192.168.0.10");
        stack.appendChild(urlField.wrap);
        var connectBtn = makeButton("server-connect", "Connect");
        stack.appendChild(connectBtn);
        screenEl.appendChild(stack);

        bindFocusable(urlField.input);
        bindFocusable(connectBtn);

        connectBtn.addEventListener("click", onConnectClick);

        focusByIndex(0);
    }

    function renderSignInScreen() {
        invalidatePendingRequests();
        state.view = "signin";
        clearScreen();
        screenEl.appendChild(el("p", "eyebrow", "Sign in"));
        screenEl.appendChild(el("h1", "title", state.serverName || "Silo"));
        screenEl.appendChild(el("p", "subtitle", "Enter your account for this server."));

        var err = el("p", "error");
        err.id = "screen-error";
        err.hidden = !state.error;
        err.textContent = state.error;
        screenEl.appendChild(err);

        var stack = el("div", "form-stack");
        var userField = makeInput("signin-username", "Username", "text", "", "");
        var passField = makeInput("signin-password", "Password", "password", "", "");
        var signInBtn = makeButton("signin-submit", "Sign in");
        stack.appendChild(userField.wrap);
        stack.appendChild(passField.wrap);
        stack.appendChild(signInBtn);
        screenEl.appendChild(stack);

        [userField.input, passField.input, signInBtn].forEach(bindFocusable);
        signInBtn.addEventListener("click", onSignInClick);

        focusByIndex(0);
    }

    function renderSignedInScreen(session) {
        invalidatePendingRequests();
        state.view = "signedin";
        clearScreen();
        screenEl.appendChild(el("p", "eyebrow", "Signed in"));
        screenEl.appendChild(el("h1", "title", "Silo"));

        var line = el(
            "p",
            "signed-in-line",
            "Signed in as " + session.userName + " on " + session.serverName
        );
        screenEl.appendChild(line);

        var signOutBtn = makeButton("signedin-signout", "Sign out");
        screenEl.appendChild(signOutBtn);
        bindFocusable(signOutBtn);
        signOutBtn.addEventListener("click", onSignOutClick);

        focusByIndex(0);
    }

    function onConnectClick() {
        var input = document.getElementById("server-url");
        if (!input) {
            return;
        }
        var connectBtn = document.getElementById("server-connect");
        if (connectBtn && connectBtn.disabled) {
            return;
        }
        setError("");
        var url = input.value;
        state.pendingServerUrl = url;
        var generation = bumpRequestGeneration();
        if (connectBtn) {
            connectBtn.disabled = true;
        }

        backend.serverInfo(url).then(function (result) {
            if (isStaleRequest(generation)) {
                return;
            }
            if (connectBtn) {
                connectBtn.disabled = false;
            }
            if (!result.ok) {
                setError(result.error.message);
                ensureScreenFocus();
                return;
            }
            state.serverUrl = result.serverUrl;
            state.serverName = result.serverName;
            state.error = "";
            renderSignInScreen();
        });
    }

    function onSignInClick() {
        var userInput = document.getElementById("signin-username");
        var passInput = document.getElementById("signin-password");
        if (!userInput || !passInput) {
            return;
        }
        var submit = document.getElementById("signin-submit");
        if (submit && submit.disabled) {
            return;
        }
        setError("");
        var generation = bumpRequestGeneration();
        if (submit) {
            submit.disabled = true;
        }

        backend.signIn(state.serverUrl, userInput.value, passInput.value).then(function (result) {
            if (isStaleRequest(generation)) {
                return;
            }
            if (submit) {
                submit.disabled = false;
            }
            if (!result.ok) {
                setError(result.error.message);
                ensureScreenFocus();
                return;
            }
            state.error = "";
            renderSignedInScreen(result.session);
        });
    }

    function onSignOutClick() {
        var signOutBtn = document.getElementById("signedin-signout");
        if (signOutBtn) {
            signOutBtn.disabled = true;
        }
        invalidatePendingRequests();
        backend.signOut().then(function () {
            state.serverUrl = "";
            state.serverName = "";
            state.pendingServerUrl = "";
            state.error = "";
            renderServerScreen();
        });
    }

    function onOfflineRetryClick() {
        var retryBtn = document.getElementById("offline-retry");
        if (retryBtn && retryBtn.disabled) {
            return;
        }
        var session = backend.currentSession();
        if (!session) {
            renderServerScreen();
            return;
        }
        var generation = bumpRequestGeneration();
        if (retryBtn) {
            retryBtn.disabled = true;
        }
        renderConnectingScreen();
        backend.validateSession().then(function (result) {
            if (isStaleRequest(generation)) {
                return;
            }
            if (retryBtn) {
                retryBtn.disabled = false;
            }
            handleValidationResult(result);
        });
    }

    function handleValidationResult(result) {
        if (result.ok && result.session) {
            renderSignedInScreen(result.session);
            return;
        }
        if (result.offline && result.session) {
            renderOfflineScreen(result.session, result.error && result.error.message);
            return;
        }
        var existing = backend.currentSession();
        if (existing) {
            state.serverUrl = existing.serverUrl;
            state.serverName = existing.serverName;
        }
        renderServerScreen();
    }

    function goBackOneScreen() {
        invalidatePendingRequests();
        if (state.view === "signin") {
            state.error = "";
            renderServerScreen();
            return true;
        }
        if (state.view === "signedin" || state.view === "offline") {
            state.error = "";
            renderSignInScreen();
            return true;
        }
        if (state.view === "connecting") {
            renderServerScreen();
            return true;
        }
        return false;
    }

    function exitApp() {
        try {
            var app = tizen.application.getCurrentApplication();
            app.exit();
        } catch (err) {
            /* Browser preview */
        }
    }

    function registerRemoteKeys() {
        if (!window.tizen || !tizen.tvinputdevice) {
            return;
        }
        var keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"];
        keys.forEach(function (keyName) {
            try {
                tizen.tvinputdevice.registerKey(keyName);
            } catch (registerErr) {
                /* Optional on older firmware */
            }
        });
    }

    function styleFocusableButton(button) {
        button.className = "tv-button";
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

        var yesButton = makeButton("exit-dialog-yes", "Yes");
        var noButton = makeButton("exit-dialog-no", "No");
        styleFocusableButton(yesButton);
        styleFocusableButton(noButton);

        yesButton.addEventListener("click", exitApp);
        noButton.addEventListener("click", closeExitDialog);
        [yesButton, noButton].forEach(bindFocusable);

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
    }

    function closeExitDialog() {
        if (!exitDialog) {
            return;
        }
        exitDialogOpen = false;
        exitDialog.hidden = true;
        ensureScreenFocus();
    }

    function handleExitDialogKeyDown(code) {
        if (code === KEY_BACK) {
            closeExitDialog();
            return true;
        }
        if (code === KEY_LEFT || code === KEY_RIGHT) {
            if (document.activeElement === exitDialogYes) {
                exitDialogNo.focus();
            } else {
                exitDialogYes.focus();
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

    function openKeyboardIfInput() {
        var active = document.activeElement;
        if (active && active.classList && active.classList.contains("field-input")) {
            active.click();
        }
    }

    function keyCodeFromEvent(event) {
        if (event.keyCode) {
            return event.keyCode;
        }
        var map = {
            ArrowUp: KEY_UP,
            ArrowDown: KEY_DOWN,
            ArrowLeft: KEY_LEFT,
            ArrowRight: KEY_RIGHT,
            Enter: KEY_ENTER
        };
        return map[event.key] || 0;
    }

    function onKeyDown(event) {
        var code = keyCodeFromEvent(event);

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
            if (!goBackOneScreen()) {
                openExitDialog();
            }
            return;
        }

        if (code === KEY_UP || code === KEY_DOWN) {
            var focusables = collectFocusables();
            if (focusables.length > 1) {
                event.preventDefault();
                var delta = code === KEY_UP ? -1 : 1;
                focusByIndex(state.focusIndex + delta);
            }
            return;
        }

        if (code === KEY_ENTER) {
            var active = document.activeElement;
            if (active && active.classList.contains("field-input")) {
                event.preventDefault();
                if (state.submitOnNextEnter === active.id) {
                    state.submitOnNextEnter = "";
                    submitForCurrentView();
                } else {
                    openKeyboardIfInput();
                    state.submitOnNextEnter = active.id;
                }
                return;
            }
            if (active && active.classList.contains("tv-button")) {
                event.preventDefault();
                if (!active.disabled) {
                    active.click();
                }
                return;
            }
        }

        ensureScreenFocus();
    }

    function bootstrap() {
        registerRemoteKeys();
        document.addEventListener("keydown", onKeyDown, false);
        document.addEventListener("focusin", function () {
            if (!exitDialogOpen) {
                var focusables = collectFocusables();
                focusables.forEach(function (node, idx) {
                    if (node === document.activeElement) {
                        state.focusIndex = idx;
                    }
                });
            }
        });

        var saved = backend.currentSession();
        if (!saved) {
            renderServerScreen();
            return;
        }

        var generation = bumpRequestGeneration();
        renderConnectingScreen();
        backend.validateSession().then(function (result) {
            if (isStaleRequest(generation)) {
                return;
            }
            handleValidationResult(result);
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", bootstrap);
    } else {
        bootstrap();
    }
})();
