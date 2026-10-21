(function () {
    "use strict";

    var KEY_BACK = 10009;
    var KEY_EXIT = 10182;
    var KEY_ENTER = 13;
    var KEY_UP = 38;
    var KEY_DOWN = 40;
    var KEY_LEFT = 37;
    var KEY_RIGHT = 39;

    var LIBRARY_PAGE_SIZE = 60;
    var LIBRARY_COLUMNS = 6;
    var testConfig = window.SiloTestConfig || {};
    var QUICK_CONNECT_POLL_MS = testConfig.quickConnectPollMs || 5000;
    var QUICK_CONNECT_TIMEOUT_MS = testConfig.quickConnectTimeoutMs || 10 * 60 * 1000;

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
        libraryFetchGeneration: 0,
        submitOnNextEnter: "",
        homeSections: [],
        homeLoading: false,
        homeLoadFailed: false,
        homeFocus: { sectionId: "", itemId: "" },
        library: null,
        libraryFocusItemId: "",
        detailsItem: null,
        detailsReturnView: "home",
        quickConnectAvailable: false,
        quickConnectRetry: "",
        quickConnect: {
            secret: "",
            code: "",
            pollTimer: null,
            pollGeneration: 0,
            startedAt: 0
        }
    };

    function bumpRequestGeneration() {
        state.requestGeneration += 1;
        return state.requestGeneration;
    }

    function isStaleRequest(generation) {
        return generation !== state.requestGeneration;
    }

    function bumpLibraryFetchGeneration() {
        state.libraryFetchGeneration += 1;
        return state.libraryFetchGeneration;
    }

    function isStaleLibraryFetch(generation) {
        return generation !== state.libraryFetchGeneration;
    }

    function handleBrowseAuthFailure(result) {
        if (result && result.signedOut) {
            setError(result.error && result.error.message ? result.error.message : "Session expired. Sign in again.");
            renderServerScreen();
            return true;
        }
        return false;
    }

    function mergeLibraryItems(existing, incoming) {
        var seen = Object.create(null);
        var merged = [];
        existing.forEach(function (item) {
            seen[item.id] = true;
            merged.push(item);
        });
        incoming.forEach(function (item) {
            if (!seen[item.id]) {
                seen[item.id] = true;
                merged.push(item);
            }
        });
        return merged;
    }

    function focusLibraryScreenDefault() {
        var lib = state.library;
        if (!lib) {
            return;
        }
        if (lib.loadFailed && lib.items.length === 0) {
            var retryBtn = document.getElementById("library-retry");
            if (retryBtn) {
                retryBtn.focus();
            }
            return;
        }
        if (lib.items.length > 0) {
            focusLibraryTile(state.libraryFocusItemId || lib.items[0].id);
            return;
        }
        var backBtn = document.getElementById("library-back");
        if (backBtn) {
            backBtn.focus();
        }
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
            scrollFocusedIntoView(element);
        });
        element.addEventListener("blur", function () {
            element.classList.remove("focused");
        });
    }

    function scrollFocusedIntoView(element) {
        if (!element || !element.scrollIntoView) {
            return;
        }
        try {
            element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
        } catch (scrollErr) {
            element.scrollIntoView(false);
        }
    }

    function isFormView() {
        return (
            state.view === "server" ||
            state.view === "signin" ||
            state.view === "signin-choice" ||
            state.view === "quickconnect-code" ||
            state.view === "quickconnect-expired" ||
            state.view === "quickconnect-error" ||
            state.view === "connecting" ||
            state.view === "offline"
        );
    }

    function backToSignInChoiceFromQuickConnect() {
        stopQuickConnectPolling();
        state.quickConnect.secret = "";
        state.quickConnect.code = "";
        state.error = "";
        var session = backend.currentSession();
        if (session) {
            renderHomeScreen(session);
            return;
        }
        renderSignInChoiceScreen();
    }

    function collectFocusables() {
        var selector = isFormView()
            ? ".field-input, .tv-button"
            : ".tv-button, .browse-tile, .details-back, .browse-action";
        var nodes = screenEl.querySelectorAll(selector);
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
            if (state.view === "home") {
                focusHomeTile(state.homeFocus.sectionId, state.homeFocus.itemId);
            } else if (state.view === "library") {
                focusLibraryTile(state.libraryFocusItemId);
            } else {
                focusByIndex(state.focusIndex);
            }
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
        stopQuickConnectPolling();
    }

    function stopQuickConnectPolling() {
        if (state.quickConnect.pollTimer) {
            clearTimeout(state.quickConnect.pollTimer);
            state.quickConnect.pollTimer = null;
        }
        state.quickConnect.pollGeneration += 1;
    }

    function scheduleQuickConnectPoll() {
        var pollGen = state.quickConnect.pollGeneration;
        state.quickConnect.pollTimer = setTimeout(function () {
            state.quickConnect.pollTimer = null;
            if (pollGen !== state.quickConnect.pollGeneration) {
                return;
            }
            if (state.view !== "quickconnect-code") {
                return;
            }
            performQuickConnectPoll(pollGen);
        }, QUICK_CONNECT_POLL_MS);
    }

    function performQuickConnectPoll(pollGen) {
        if (Date.now() - state.quickConnect.startedAt >= QUICK_CONNECT_TIMEOUT_MS) {
            stopQuickConnectPolling();
            renderQuickConnectExpiredScreen();
            return;
        }

        backend.quickConnectPoll(state.serverUrl, state.quickConnect.secret).then(function (result) {
            if (pollGen !== state.quickConnect.pollGeneration) {
                return;
            }
            if (state.view !== "quickconnect-code") {
                return;
            }
            if (!result.ok) {
                stopQuickConnectPolling();
                if (result.error.code === "expired") {
                    renderQuickConnectExpiredScreen();
                    return;
                }
                renderQuickConnectErrorScreen(result.error.message, "poll");
                return;
            }
            if (result.authenticated) {
                stopQuickConnectPolling();
                completeQuickConnectAuth();
                return;
            }
            scheduleQuickConnectPoll();
        });
    }

    function completeQuickConnectAuth() {
        var generation = bumpRequestGeneration();
        backend.authenticateWithQuickConnect(state.serverUrl, state.quickConnect.secret).then(function (result) {
            if (isStaleRequest(generation)) {
                return;
            }
            if (!result.ok) {
                if (result.error.code === "expired") {
                    renderQuickConnectExpiredScreen();
                    return;
                }
                renderQuickConnectErrorScreen(result.error.message, "auth");
                return;
            }
            state.error = "";
            state.quickConnect.secret = "";
            state.quickConnect.code = "";
            renderHomeScreen(result.session);
        });
    }

    function submitForCurrentView() {
        if (state.view === "server") {
            onConnectClick();
        } else if (state.view === "signin") {
            onSignInClick();
        }
    }

    function posterUrl(itemId) {
        return backend.primaryImageUrl(itemId, { maxHeight: 420, quality: 90 });
    }

    function createPosterTile(item, sectionId, onActivate) {
        var tile = el("button", "browse-tile");
        tile.type = "button";
        tile.setAttribute("data-section-id", sectionId);
        tile.setAttribute("data-item-id", item.id);
        tile.setAttribute("data-item-type", item.type || "");

        var art = el("div", "browse-poster");
        if (item.imageTag) {
            var img = document.createElement("img");
            img.className = "browse-poster-img";
            img.alt = "";
            img.src = posterUrl(item.id);
            img.addEventListener("error", function () {
                img.remove();
                art.classList.add("browse-poster-fallback");
                art.setAttribute("data-fallback-title", item.title);
            });
            art.appendChild(img);
        } else {
            art.classList.add("browse-poster-fallback");
            art.setAttribute("data-fallback-title", item.title);
        }

        var caption = el("span", "browse-tile-label", item.title);
        tile.appendChild(art);
        tile.appendChild(caption);
        bindFocusable(tile);
        tile.addEventListener("click", function () {
            if (onActivate) {
                onActivate(item, sectionId);
            }
        });
        return tile;
    }

    function rememberHomeFocus(sectionId, itemId) {
        state.homeFocus = { sectionId: sectionId || "", itemId: itemId || "" };
    }

    function rememberLibraryFocus(itemId) {
        state.libraryFocusItemId = itemId || "";
    }

    function focusHomeTile(sectionId, itemId) {
        var selector =
            '.browse-tile[data-section-id="' + sectionId + '"][data-item-id="' + itemId + '"]';
        var node = screenEl.querySelector(selector);
        if (node) {
            rememberHomeFocus(sectionId, itemId);
            node.focus();
            return true;
        }
        var first = screenEl.querySelector(".browse-tile");
        if (first) {
            rememberHomeFocus(first.getAttribute("data-section-id"), first.getAttribute("data-item-id"));
            first.focus();
            return true;
        }
        var signOut = document.getElementById("home-signout");
        if (signOut) {
            signOut.focus();
        }
        return false;
    }

    function focusLibraryTile(itemId) {
        var node = screenEl.querySelector('.browse-tile[data-item-id="' + itemId + '"]');
        if (node) {
            rememberLibraryFocus(itemId);
            node.focus();
            return true;
        }
        var first = screenEl.querySelector(".browse-grid .browse-tile");
        if (first) {
            rememberLibraryFocus(first.getAttribute("data-item-id"));
            first.focus();
            return true;
        }
        var backBtn = document.getElementById("library-back");
        if (backBtn) {
            backBtn.focus();
        }
        return false;
    }

    function firstHomeFocusTarget() {
        for (var i = 0; i < state.homeSections.length; i++) {
            var section = state.homeSections[i];
            if (section.items && section.items.length > 0) {
                return { sectionId: section.id, itemId: section.items[0].id };
            }
        }
        return { sectionId: "", itemId: "" };
    }

    function renderConnectingScreen() {
        state.view = "connecting";
        clearScreen();
        screenEl.className = "screen screen-form";
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
        screenEl.className = "screen screen-form";
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
        screenEl.className = "screen screen-form";
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

    function renderSignInChoiceScreen() {
        invalidatePendingRequests();
        state.view = "signin-choice";
        clearScreen();
        screenEl.className = "screen screen-form";
        screenEl.appendChild(el("p", "eyebrow", "Sign in"));
        screenEl.appendChild(el("h1", "title", state.serverName || "Silo"));
        screenEl.appendChild(
            el("p", "subtitle", "Approve Quick Connect on your phone or web, or sign in with a password.")
        );

        var err = el("p", "error");
        err.id = "screen-error";
        err.hidden = !state.error;
        err.textContent = state.error;
        screenEl.appendChild(err);

        var stack = el("div", "form-stack");
        var quickBtn = makeButton("signin-quickconnect-start", "Quick Connect");
        var passwordBtn = makeButton("signin-use-password", "Sign in with password");
        stack.appendChild(quickBtn);
        stack.appendChild(passwordBtn);
        screenEl.appendChild(stack);

        [quickBtn, passwordBtn].forEach(bindFocusable);
        quickBtn.addEventListener("click", onQuickConnectStartClick);
        passwordBtn.addEventListener("click", function () {
            state.error = "";
            renderSignInScreen();
        });

        focusByIndex(0);
    }

    function renderQuickConnectCodeScreen() {
        stopQuickConnectPolling();
        state.view = "quickconnect-code";
        clearScreen();
        screenEl.className = "screen screen-form";
        screenEl.appendChild(el("p", "eyebrow", "Quick Connect"));
        screenEl.appendChild(el("h1", "title", state.serverName || "Silo"));

        var codeEl = el("p", "quickconnect-code", state.quickConnect.code);
        codeEl.id = "quickconnect-code-display";
        screenEl.appendChild(codeEl);

        screenEl.appendChild(
            el(
                "p",
                "quickconnect-instructions",
                "Enter this code in the Silo app or web UI under Quick Connect, then approve the request."
            )
        );

        var err = el("p", "error");
        err.id = "screen-error";
        err.hidden = !state.error;
        err.textContent = state.error;
        screenEl.appendChild(err);

        var cancelBtn = makeButton("quickconnect-cancel", "Cancel");
        screenEl.appendChild(cancelBtn);
        bindFocusable(cancelBtn);
        cancelBtn.addEventListener("click", onQuickConnectCancelClick);

        focusByIndex(0);
        scheduleQuickConnectPoll();
    }

    function renderQuickConnectExpiredScreen() {
        stopQuickConnectPolling();
        state.view = "quickconnect-expired";
        clearScreen();
        screenEl.className = "screen screen-form";
        screenEl.appendChild(el("p", "eyebrow", "Quick Connect"));
        screenEl.appendChild(el("h1", "title", "Expired"));
        screenEl.appendChild(
            el("p", "subtitle", "This code is no longer valid. Get a new code to try again.")
        );

        var renewBtn = makeButton("quickconnect-renew", "Get a new code");
        screenEl.appendChild(renewBtn);
        bindFocusable(renewBtn);
        renewBtn.addEventListener("click", onQuickConnectStartClick);
        focusByIndex(0);
    }

    function renderQuickConnectErrorScreen(message, retryMode) {
        stopQuickConnectPolling();
        state.view = "quickconnect-error";
        state.quickConnectRetry = retryMode || "poll";
        clearScreen();
        screenEl.className = "screen screen-form";
        screenEl.appendChild(el("p", "eyebrow", "Quick Connect"));
        screenEl.appendChild(el("h1", "title", "Connection problem"));

        var err = el("p", "error");
        err.id = "screen-error";
        err.textContent = message || "Could not reach the server.";
        screenEl.appendChild(err);

        var retryBtn = makeButton("quickconnect-retry", "Retry");
        var cancelBtn = makeButton("quickconnect-error-cancel", "Cancel");
        var stack = el("div", "form-stack");
        stack.appendChild(retryBtn);
        stack.appendChild(cancelBtn);
        screenEl.appendChild(stack);

        [retryBtn, cancelBtn].forEach(bindFocusable);
        retryBtn.addEventListener("click", onQuickConnectRetryClick);
        cancelBtn.addEventListener("click", onQuickConnectCancelClick);
        focusByIndex(0);
    }

    function renderSignInScreen() {
        invalidatePendingRequests();
        state.view = "signin";
        clearScreen();
        screenEl.className = "screen screen-form";
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

    function renderHomeShell(session) {
        state.view = "home";
        clearScreen();
        screenEl.className = "screen screen-browse";

        var header = el("header", "browse-header");
        header.appendChild(el("p", "eyebrow browse-eyebrow", "Home"));
        header.appendChild(el("h1", "browse-title", session.serverName || "Silo"));
        var meta = el(
            "p",
            "browse-meta",
            "Signed in as " + session.userName
        );
        header.appendChild(meta);
        var signOutBtn = makeButton("home-signout", "Sign out");
        header.appendChild(signOutBtn);
        bindFocusable(signOutBtn);
        signOutBtn.addEventListener("click", onSignOutClick);
        screenEl.appendChild(header);

        var err = el("p", "error");
        err.id = "screen-error";
        err.hidden = !state.error;
        err.textContent = state.error;
        screenEl.appendChild(err);

        var body = el("div", "browse-body");
        body.id = "browse-body";
        if (state.homeLoading) {
            body.appendChild(el("p", "browse-status", "Loading your libraries…"));
        } else if (state.homeLoadFailed) {
            body.appendChild(el("p", "browse-status", "Could not load your home rows."));
            var homeRetry = makeButton("home-retry", "Retry");
            homeRetry.classList.add("browse-action");
            homeRetry.addEventListener("click", onHomeRetryClick);
            bindFocusable(homeRetry);
            body.appendChild(homeRetry);
        } else if (state.homeSections.length === 0) {
            body.appendChild(el("p", "browse-status", "No rows to show yet."));
        } else {
            state.homeSections.forEach(function (section) {
                if (!section.items || section.items.length === 0) {
                    return;
                }
                var row = el("section", "browse-row");
                row.setAttribute("data-section-id", section.id);
                row.appendChild(el("h2", "browse-row-title", section.title));
                var strip = el("div", "browse-row-strip");
                section.items.forEach(function (item) {
                    strip.appendChild(
                        createPosterTile(item, section.id, function (tileItem, sectionId) {
                            onHomeTileActivate(tileItem, sectionId);
                        })
                    );
                });
                row.appendChild(strip);
                body.appendChild(row);
            });
        }
        screenEl.appendChild(body);
    }

    function loadHomeData(session, generation) {
        state.homeLoading = true;
        renderHomeShell(session);
        return backend.browseHome().then(function (result) {
            if (isStaleRequest(generation)) {
                return;
            }
            state.homeLoading = false;
            if (!result.ok) {
                if (handleBrowseAuthFailure(result)) {
                    return;
                }
                setError(result.error && result.error.message ? result.error.message : "Could not load home.");
                state.homeSections = [];
                state.homeLoadFailed = true;
            } else {
                state.error = "";
                state.homeLoadFailed = false;
                state.homeSections = result.sections || [];
            }
            renderHomeShell(session);
            if (!state.homeFocus.sectionId) {
                var first = firstHomeFocusTarget();
                rememberHomeFocus(first.sectionId, first.itemId);
            }
            focusHomeTile(state.homeFocus.sectionId, state.homeFocus.itemId);
        });
    }

    function renderHomeScreen(session) {
        invalidatePendingRequests();
        var generation = bumpRequestGeneration();
        state.homeSections = [];
        state.homeLoadFailed = false;
        return loadHomeData(session, generation);
    }

    function onHomeRetryClick() {
        var session = backend.currentSession();
        if (!session) {
            renderServerScreen();
            return;
        }
        var generation = bumpRequestGeneration();
        state.homeLoadFailed = false;
        setError("");
        loadHomeData(session, generation);
    }

    function onHomeTileActivate(item, sectionId) {
        rememberHomeFocus(sectionId, item.id);
        if (item.type === "Library") {
            openLibrary({
                id: item.id,
                title: item.title,
                collectionType: item.collectionType || "unknown"
            });
            return;
        }
        openDetails(item.id, "home");
    }

    function openLibrary(libraryMeta) {
        invalidatePendingRequests();
        var generation = bumpLibraryFetchGeneration();
        state.library = {
            id: libraryMeta.id,
            title: libraryMeta.title,
            collectionType: libraryMeta.collectionType,
            items: [],
            totalRecordCount: 0,
            startIndex: 0,
            loading: true,
            loadFailed: false
        };
        state.view = "library";
        renderLibraryScreen();
        focusLibraryScreenDefault();
        fetchLibraryPage(generation, 0, false);
    }

    function fetchLibraryPage(generation, startIndex, append) {
        if (!state.library) {
            return;
        }
        state.library.loading = true;
        var includeTypes = backend.itemTypesForLibrary(state.library.collectionType);
        backend
            .browseLibraryItems(state.library.id, {
                startIndex: startIndex,
                limit: LIBRARY_PAGE_SIZE,
                includeItemTypes: includeTypes
            })
            .then(function (result) {
                if (isStaleLibraryFetch(generation) || state.view !== "library" || !state.library) {
                    if (state.library) {
                        state.library.loading = false;
                    }
                    return;
                }
                state.library.loading = false;
                if (!result.ok) {
                    if (handleBrowseAuthFailure(result)) {
                        return;
                    }
                    state.library.loadFailed = true;
                    setError(result.error && result.error.message ? result.error.message : "Could not load library.");
                    renderLibraryScreen();
                    focusLibraryScreenDefault();
                    return;
                }
                state.error = "";
                state.library.loadFailed = false;
                if (append) {
                    state.library.items = mergeLibraryItems(state.library.items, result.items);
                } else {
                    state.library.items = result.items;
                }
                state.library.totalRecordCount = result.totalRecordCount;
                state.library.startIndex = startIndex;
                renderLibraryScreen();
                if (!state.libraryFocusItemId && state.library.items.length > 0) {
                    rememberLibraryFocus(state.library.items[0].id);
                }
                focusLibraryScreenDefault();
            });
    }

    function onLibraryLoadMoreClick() {
        if (!state.library || state.library.loading) {
            return;
        }
        if (state.library.items.length >= state.library.totalRecordCount) {
            return;
        }
        var generation = state.libraryFetchGeneration;
        var nextStart = state.library.items.length;
        fetchLibraryPage(generation, nextStart, true);
    }

    function onLibraryRetryClick() {
        if (!state.library) {
            return;
        }
        setError("");
        state.library.loadFailed = false;
        var generation = bumpLibraryFetchGeneration();
        fetchLibraryPage(generation, 0, false);
    }

    function renderLibraryScreen() {
        clearScreen();
        screenEl.className = "screen screen-browse";
        var lib = state.library;
        if (!lib) {
            return;
        }

        var header = el("header", "browse-header");
        header.appendChild(el("p", "eyebrow browse-eyebrow", "Library"));
        header.appendChild(el("h1", "browse-title", lib.title));
        var backBtn = makeButton("library-back", "Back");
        backBtn.classList.add("details-back");
        header.appendChild(backBtn);
        bindFocusable(backBtn);
        backBtn.addEventListener("click", function () {
            goBackOneScreen();
        });
        screenEl.appendChild(header);

        var err = el("p", "error");
        err.id = "screen-error";
        err.hidden = !state.error;
        err.textContent = state.error;
        screenEl.appendChild(err);

        var body = el("div", "browse-body browse-body-grid");
        if (lib.loading && lib.items.length === 0 && !lib.loadFailed) {
            body.appendChild(el("p", "browse-status", "Loading titles…"));
        } else if (lib.loadFailed && lib.items.length === 0) {
            body.appendChild(el("p", "browse-status", "Could not load this library."));
            var retryBtn = makeButton("library-retry", "Retry");
            retryBtn.classList.add("browse-action");
            bindFocusable(retryBtn);
            retryBtn.addEventListener("click", onLibraryRetryClick);
            body.appendChild(retryBtn);
        } else if (lib.items.length === 0) {
            body.appendChild(el("p", "browse-status", "This library is empty."));
        } else {
            var grid = el("div", "browse-grid");
            grid.style.setProperty("--browse-columns", String(LIBRARY_COLUMNS));
            lib.items.forEach(function (item) {
                grid.appendChild(
                    createPosterTile(item, "library-grid", function (tileItem) {
                        rememberLibraryFocus(tileItem.id);
                        openDetails(tileItem.id, "library");
                    })
                );
            });
            body.appendChild(grid);
            if (lib.items.length < lib.totalRecordCount) {
                var loadMoreBtn = makeButton("library-load-more", lib.loading ? "Loading more…" : "Load more titles");
                loadMoreBtn.classList.add("browse-action");
                loadMoreBtn.disabled = lib.loading;
                bindFocusable(loadMoreBtn);
                loadMoreBtn.addEventListener("click", onLibraryLoadMoreClick);
                body.appendChild(loadMoreBtn);
            }
        }
        screenEl.appendChild(body);
    }

    function openDetails(itemId, returnView) {
        var generation = bumpRequestGeneration();
        state.detailsReturnView = returnView === "library" ? "library" : "home";
        state.view = "details";
        state.detailsItem = { id: itemId, title: "Loading…", overview: "" };
        renderDetailsScreen();
        backend.browseItemDetails(itemId).then(function (result) {
            if (isStaleRequest(generation) || state.view !== "details") {
                return;
            }
            if (!result.ok) {
                if (handleBrowseAuthFailure(result)) {
                    return;
                }
                setError(result.error && result.error.message ? result.error.message : "Could not load details.");
                renderDetailsScreen();
                return;
            }
            state.error = "";
            state.detailsItem = result.item;
            renderDetailsScreen();
            var backBtn = document.getElementById("details-back");
            if (backBtn) {
                backBtn.focus();
            }
        });
    }

    function renderDetailsScreen() {
        clearScreen();
        screenEl.className = "screen screen-browse screen-details";
        var item = state.detailsItem || { title: "Item", overview: "" };

        var header = el("header", "browse-header");
        header.appendChild(el("p", "eyebrow browse-eyebrow", "Details"));
        header.appendChild(el("h1", "browse-title", item.title));
        var backBtn = makeButton("details-back", "Back");
        backBtn.classList.add("details-back");
        header.appendChild(backBtn);
        bindFocusable(backBtn);
        backBtn.addEventListener("click", function () {
            goBackOneScreen();
        });
        screenEl.appendChild(header);

        var err = el("p", "error");
        err.id = "screen-error";
        err.hidden = !state.error;
        err.textContent = state.error;
        screenEl.appendChild(err);

        var body = el("div", "browse-body browse-body-details");
        var layout = el("div", "details-layout");
        var art = el("div", "details-poster");
        if (item.id) {
            var img = document.createElement("img");
            img.className = "browse-poster-img";
            img.alt = "";
            img.src = posterUrl(item.id);
            img.addEventListener("error", function () {
                img.remove();
                art.classList.add("browse-poster-fallback");
                art.setAttribute("data-fallback-title", item.title);
            });
            art.appendChild(img);
        }
        layout.appendChild(art);

        var copy = el("div", "details-copy");
        copy.appendChild(el("p", "details-overview", item.overview || "No description available."));
        copy.appendChild(el("p", "details-placeholder", "Playback will be available in a future update."));
        layout.appendChild(copy);
        body.appendChild(layout);
        screenEl.appendChild(body);

        backBtn.focus();
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
            backend.quickConnectEnabled(state.serverUrl).then(function (qcResult) {
                if (isStaleRequest(generation)) {
                    return;
                }
                if (qcResult.ok && qcResult.enabled) {
                    state.quickConnectAvailable = true;
                    renderSignInChoiceScreen();
                    return;
                }
                state.quickConnectAvailable = false;
                renderSignInScreen();
            });
        });
    }

    function onQuickConnectStartClick() {
        var startBtn = document.getElementById("signin-quickconnect-start");
        var renewBtn = document.getElementById("quickconnect-renew");
        var activeBtn = startBtn || renewBtn;
        if (activeBtn && activeBtn.disabled) {
            return;
        }
        setError("");
        var generation = bumpRequestGeneration();
        stopQuickConnectPolling();
        if (activeBtn) {
            activeBtn.disabled = true;
        }

        backend.quickConnectInitiate(state.serverUrl).then(function (result) {
            if (isStaleRequest(generation)) {
                return;
            }
            if (activeBtn) {
                activeBtn.disabled = false;
            }
            if (!result.ok) {
                if (result.error.code === "unreachable" || result.error.code === "timeout") {
                    renderQuickConnectErrorScreen(result.error.message, "initiate");
                } else {
                    setError(result.error.message);
                    ensureScreenFocus();
                }
                return;
            }
            state.quickConnect.secret = result.secret;
            state.quickConnect.code = result.code;
            state.quickConnect.startedAt = Date.now();
            renderQuickConnectCodeScreen();
        });
    }

    function onQuickConnectCancelClick() {
        if (state.quickConnectAvailable) {
            backToSignInChoiceFromQuickConnect();
            return;
        }
        stopQuickConnectPolling();
        state.quickConnect.secret = "";
        state.quickConnect.code = "";
        state.error = "";
        if (backend.currentSession()) {
            renderHomeScreen(backend.currentSession());
        } else {
            renderSignInScreen();
        }
    }

    function onQuickConnectRetryClick() {
        if (state.quickConnectRetry === "initiate") {
            onQuickConnectStartClick();
            return;
        }
        if (!state.quickConnect.secret || !state.quickConnect.code) {
            onQuickConnectStartClick();
            return;
        }
        state.error = "";
        state.quickConnect.startedAt = Date.now();
        renderQuickConnectCodeScreen();
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
            renderHomeScreen(result.session);
        });
    }

    function onSignOutClick() {
        var signOutBtn = document.getElementById("home-signout") || document.getElementById("signedin-signout");
        if (signOutBtn) {
            signOutBtn.disabled = true;
        }
        invalidatePendingRequests();
        backend.signOut().then(function () {
            state.serverUrl = "";
            state.serverName = "";
            state.pendingServerUrl = "";
            state.error = "";
            state.homeSections = [];
            state.library = null;
            state.detailsItem = null;
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
            renderHomeScreen(result.session);
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
        if (state.view === "details") {
            invalidatePendingRequests();
            state.detailsItem = null;
            state.error = "";
            if (state.detailsReturnView === "library" && state.library) {
                state.view = "library";
                if (state.library.loading) {
                    state.library.loading = false;
                }
                renderLibraryScreen();
                focusLibraryScreenDefault();
            } else {
                state.view = "home";
                var sessionFromDetails = backend.currentSession();
                if (sessionFromDetails) {
                    renderHomeShell(sessionFromDetails);
                    focusHomeTile(state.homeFocus.sectionId, state.homeFocus.itemId);
                }
            }
            return true;
        }
        if (state.view === "library") {
            invalidatePendingRequests();
            state.view = "home";
            state.library = null;
            state.error = "";
            var session = backend.currentSession();
            if (session) {
                renderHomeShell(session);
                focusHomeTile(state.homeFocus.sectionId, state.homeFocus.itemId);
            }
            return true;
        }
        if (state.view === "signin-choice") {
            return false;
        }
        if (
            state.view === "quickconnect-code" ||
            state.view === "quickconnect-expired" ||
            state.view === "quickconnect-error"
        ) {
            if (state.quickConnectAvailable) {
                backToSignInChoiceFromQuickConnect();
            } else {
                invalidatePendingRequests();
                stopQuickConnectPolling();
                state.quickConnect.secret = "";
                state.quickConnect.code = "";
                state.error = "";
                if (backend.currentSession()) {
                    renderHomeScreen(backend.currentSession());
                } else {
                    renderServerScreen();
                }
            }
            return true;
        }
        invalidatePendingRequests();
        if (state.view === "signin") {
            state.error = "";
            if (state.quickConnectAvailable) {
                backToSignInChoiceFromQuickConnect();
            } else if (backend.currentSession()) {
                renderHomeScreen(backend.currentSession());
            } else {
                renderServerScreen();
            }
            return true;
        }
        if (state.view === "offline") {
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

    function homeRowsMeta() {
        var rows = [];
        state.homeSections.forEach(function (section) {
            if (!section.items || section.items.length === 0) {
                return;
            }
            rows.push({
                sectionId: section.id,
                items: section.items.map(function (item) {
                    return item.id;
                })
            });
        });
        return rows;
    }

    function handleHomeBrowseKey(code) {
        var active = document.activeElement;
        if (active && active.id === "home-signout") {
            if (code === KEY_DOWN) {
                var first = firstHomeFocusTarget();
                if (first.sectionId) {
                    focusHomeTile(first.sectionId, first.itemId);
                    return true;
                }
            }
            return false;
        }
        if (!active || !active.classList.contains("browse-tile")) {
            return false;
        }
        var sectionId = active.getAttribute("data-section-id");
        var itemId = active.getAttribute("data-item-id");
        var rows = homeRowsMeta();
        var rowIndex = -1;
        var colIndex = -1;
        rows.forEach(function (row, rIdx) {
            if (row.sectionId === sectionId) {
                rowIndex = rIdx;
                colIndex = row.items.indexOf(itemId);
            }
        });
        if (rowIndex < 0 || colIndex < 0) {
            return false;
        }

        if (code === KEY_LEFT && colIndex > 0) {
            focusHomeTile(sectionId, rows[rowIndex].items[colIndex - 1]);
            return true;
        }
        if (code === KEY_RIGHT && colIndex < rows[rowIndex].items.length - 1) {
            focusHomeTile(sectionId, rows[rowIndex].items[colIndex + 1]);
            return true;
        }
        if (code === KEY_UP) {
            if (rowIndex === 0) {
                var signOut = document.getElementById("home-signout");
                if (signOut) {
                    signOut.focus();
                }
                return true;
            }
            var targetRow = rows[rowIndex - 1];
            var nextCol = Math.min(colIndex, targetRow.items.length - 1);
            focusHomeTile(targetRow.sectionId, targetRow.items[nextCol]);
            return true;
        }
        if (code === KEY_DOWN) {
            if (rowIndex >= rows.length - 1) {
                return true;
            }
            var downRow = rows[rowIndex + 1];
            var downCol = Math.min(colIndex, downRow.items.length - 1);
            focusHomeTile(downRow.sectionId, downRow.items[downCol]);
            return true;
        }
        return false;
    }

    function handleLibraryBrowseKey(code) {
        var active = document.activeElement;
        if (active && active.id === "library-back") {
            if (code === KEY_DOWN && state.library && state.library.items.length > 0) {
                focusLibraryTile(state.library.items[0].id);
                return true;
            }
            return false;
        }
        if (active && active.id === "library-load-more") {
            if (code === KEY_UP && state.library && state.library.items.length > 0) {
                var lastIdx = state.library.items.length - 1;
                var lastCol = lastIdx % LIBRARY_COLUMNS;
                var lastRowStart = lastIdx - lastCol;
                focusLibraryTile(state.library.items[lastRowStart + Math.min(lastCol, LIBRARY_COLUMNS - 1)].id);
                return true;
            }
            return false;
        }
        if (!active || !active.classList.contains("browse-tile") || !state.library) {
            return false;
        }
        var itemId = active.getAttribute("data-item-id");
        var index = -1;
        state.library.items.forEach(function (item, idx) {
            if (item.id === itemId) {
                index = idx;
            }
        });
        if (index < 0) {
            return false;
        }
        var col = index % LIBRARY_COLUMNS;
        var row = Math.floor(index / LIBRARY_COLUMNS);
        var total = state.library.items.length;
        var maxRow = Math.floor((total - 1) / LIBRARY_COLUMNS);

        function focusIndex(nextIndex) {
            if (nextIndex >= 0 && nextIndex < total) {
                rememberLibraryFocus(state.library.items[nextIndex].id);
                focusLibraryTile(state.library.items[nextIndex].id);
            }
        }

        if (code === KEY_LEFT && col > 0) {
            focusIndex(index - 1);
            return true;
        }
        if (code === KEY_RIGHT && col < LIBRARY_COLUMNS - 1 && index + 1 < total) {
            focusIndex(index + 1);
            return true;
        }
        if (code === KEY_UP) {
            if (row === 0) {
                var backBtn = document.getElementById("library-back");
                if (backBtn) {
                    backBtn.focus();
                }
                return true;
            }
            focusIndex(index - LIBRARY_COLUMNS);
            return true;
        }
        if (code === KEY_DOWN) {
            if (row >= maxRow) {
                var loadMore = document.getElementById("library-load-more");
                if (loadMore && !loadMore.disabled) {
                    loadMore.focus();
                }
                return true;
            }
            var downIndex = index + LIBRARY_COLUMNS;
            if (downIndex < total) {
                focusIndex(downIndex);
            }
            return true;
        }
        return false;
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

        if (state.view === "home" && (code === KEY_UP || code === KEY_DOWN || code === KEY_LEFT || code === KEY_RIGHT)) {
            event.preventDefault();
            handleHomeBrowseKey(code);
            return;
        }

        if (state.view === "library" && (code === KEY_UP || code === KEY_DOWN || code === KEY_LEFT || code === KEY_RIGHT)) {
            event.preventDefault();
            handleLibraryBrowseKey(code);
            return;
        }

        if (code === KEY_UP || code === KEY_DOWN || code === KEY_LEFT || code === KEY_RIGHT) {
            if (isFormView()) {
                event.preventDefault();
                if (code === KEY_UP || code === KEY_DOWN) {
                    var focusables = collectFocusables();
                    if (focusables.length > 1) {
                        var delta = code === KEY_UP ? -1 : 1;
                        focusByIndex(state.focusIndex + delta);
                    }
                }
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
            if (active && (active.classList.contains("tv-button") || active.classList.contains("browse-tile"))) {
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
            if (!exitDialogOpen && isFormView()) {
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
