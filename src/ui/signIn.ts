// Native sign-in screens: the server address, then the eight-digit code or a password, ending in
// one typed handoff of the signed-in server. The session core owns discovery, restore, polling, storage
// and logout; this module only shows its states and turns remote keys into its calls.

import { type Clock, systemClock } from "../api/clock.ts";
import { ApiError } from "../api/errors.ts";
import { operations } from "../api/operations.ts";
import type { ServerConnection } from "../api/discovery.ts";
import { type AdvancedScheme, advancedAddress, plainHttpFallbacks, portFieldFault } from "../api/serverUrl.ts";
import { resolveBrandingAsset } from "../contracts/v2/branding.ts";
import { type ConnectedServer, type ConnectResult, connect, forgetStoredCredential, openDiscoveredServer, type SessionCoreDeps } from "../session/core.ts";
import type { DeviceCodeView, DeviceLogin, DeviceLoginState } from "../session/deviceLogin.ts";
import { passwordLogin } from "../session/passwordLogin.ts";
import type { LogoutResult } from "../session/session.ts";
import { cachedBranding, storeBranding } from "./brandingCache.ts";
import { codeScreen, type CodeScreen } from "./codeScreen.ts";
import { credentialsScreen, type CredentialsScreen } from "./credentialsScreen.ts";
import { actionRow, chip, errorText, field, headline, keyboardCard, lead, marqueeButton, marqueeScreen, noteChips, setServerMark, setupNeededCard, textInput } from "./marquee.ts";
import { MarqueeBackdrop, marqueeScene } from "./marqueeBackdrop.ts";
import { type Control, el, type Note, type Screen, ScreenHost } from "./screen.ts";
import * as text from "./signInText.ts";
import { AccountDirectory, type SavedAccount } from "../session/accounts.ts";

export interface SignInOptions {
    readonly address?: string;
    readonly username?: string;
    readonly onChangeAccount?: () => void;
    /** Started from Change Account, so leaving returns there (AccountSignInRequest.returnsToChangeAccount). */
    readonly returnToAccounts?: boolean;
    /** The session just expired. The code screen explains it (LoginNotice.sessionExpired). */
    readonly sessionExpired?: boolean;
    readonly onCancel?: () => void;
    /** Explicit server switching preserves saved sign-ins and starts at server entry. */
    readonly chooseServer?: boolean;
    readonly core: SessionCoreDeps;
    /** Receives the server once its account is signed in. The sign-in screens are gone by then. */
    readonly onSignedIn: (server: ConnectedServer) => void;
    /** After a sign-out: shown on the address screen, which then waits instead of reconnecting. */
    readonly signedOut?: LogoutResult;
    /** Told each server sign-in connects to before any account is handed over (diagnostics, tests). */
    readonly onConnected?: (server: ConnectedServer) => void;
}

export interface SignInScreens {
    destroy(): void;
}

/** The last server connected to, so a restart can restore its session. An address, not a secret. */
const SERVER_KEY = "silo.native.server";
const CLEANUP_WAIT_MS = 10000;
const SCHEMES: readonly [AdvancedScheme, string][] = [["auto", "Auto"], ["https", "HTTPS"], ["http", "HTTP"]];
/** Screens before a server answers; the backdrop's brand light changes once one does. */
const SERVER_SCREENS: ReadonlySet<string> = new Set(["entry", "connecting", "insecure"]);

// QRLoginViewModel.Timing, in milliseconds.
/** Failures while getting a code before "Can't reach …". */
const UNREACHABLE_WHILE_STARTING_MS = 10000;
/** Failures while polling before "Can't reach …". */
const UNREACHABLE_WHILE_POLLING_MS = 30000;
/** 429 answers before "Too many sign-in attempts". */
const RATE_LIMITED_AFTER_MS = 60000;
/** How long codes renew themselves before the screen pauses. */
const RENEWAL_LIMIT_MS = 3600000;
const MAX_BACKOFF_SECONDS = 30;
/** TVLoginView: let "Signed in as …" register before moving on. */
const APPROVAL_PAUSE_MS = 1000;

// A new mount must not open another vault while an abandoned flow still clears the same aliases.
let pendingAccountCleanup: Promise<void> = Promise.resolve();

/** Signs the account out; a sign-in mounted meanwhile connects only after its storage is cleared. */
export function logoutCollectedAccount(server: ConnectedServer): Promise<LogoutResult> {
    const logout = server.session.logout();
    const settled = logout.then(() => undefined, () => undefined);
    pendingAccountCleanup = Promise.all([pendingAccountCleanup, settled]).then(() => undefined);
    return logout;
}

interface Active {
    readonly server: ConnectedServer;
    readonly login: DeviceLogin;
    readonly stop: () => void;
    readonly notes: readonly Note[];
    serverName?: string | undefined;
    /** The branding mark, resolved against this server; and its accent, unclamped. */
    markUrl?: string | undefined;
    accent?: string | undefined;
    code: CodeScreen | undefined;
    credentialsView?: CredentialsScreen;
    /** Where to type the latest code, kept after it ends, as the Apple TV app's lead keeps it. */
    typed: string | undefined;
    /** What the code screen says (QRLoginViewModel.Status). */
    status: text.CodeStatus;
    /** The latest code, while the status keeps it on screen. */
    shownCode: DeviceCodeView | undefined;
    /** The code on screen replaced an expired one. */
    renewed: boolean;
    /** Codes renew themselves until an hour after this. */
    windowStart: number;
    /** When the attempt now running was asked for: a failing start's streak counts from it. */
    startedAt: number;
    /** The attempt now running has shown a code; a failure before that is a failed start. */
    sawCode: boolean;
    /** A failing-start streak: since its first failing request, its 429 run, and the next wait. */
    startStreak: { readonly since: number; readonly limitedSince: number | undefined; readonly backoff: number } | undefined;
    /** Cancels the next start after a failed one, or the move on after an approval. */
    cancelTimer: (() => void) | undefined;
    /** A start waits after a failed one; hidden, it waits for the screen, never before `floor`. */
    pendingStart: { readonly floor: number } | undefined;
    /** Ends the provider read and makes a password answer still in flight be revoked. */
    readonly left: AbortController;
    /** listAuthProviders; undefined until read, and when the read failed (the password stays offered). */
    options: { readonly passwordLogin: boolean; readonly oauthProviders: readonly string[] } | undefined;
    /** The password screen is open; device-code states other than an approval wait behind it. */
    credentials: boolean;
    submitting: boolean;
    username: string;
    password: string;
    /** "Show password" pressed; kept while the screen is redrawn. */
    shown: boolean;
    error: string | undefined;
    /** A missing username. Any other error outlines the password. */
    errorField: "username" | undefined;
}

export function mountSignIn(root: HTMLElement, options: SignInOptions): SignInScreens {
    const core = options.core;
    const clock: Clock = core.clock ?? systemClock;
    const backdrop = new MarqueeBackdrop(clock);
    const host = new ScreenHost(root, () => {
        const wordmark = el("img", "signin-wordmark");
        wordmark.src = "img/silo-wordmark.png";
        wordmark.alt = "Silo";
        return wordmark;
    }, backdrop.element);
    root.classList.add("signin", "signin-auth");
    let address = options.address ?? readServer(core) ?? "";
    // The Apple TV app's Advanced options; reset once a server answers, whose address then says both.
    let scheme: AdvancedScheme = "auto";
    let port = "";
    let advanced = false;
    let connecting: AbortController | undefined;
    let active: Active | undefined;
    let destroyed = false;
    /** The server whose setup screen is showing. */
    let pendingSetup: ServerConnection | undefined;
    let setupProbe: AbortController | undefined;
    let checkingSetup = false;

    const destroy = (): void => {
        destroyed = true;
        connecting?.abort();
        connecting = undefined;
        setupProbe?.abort();
        setupProbe = undefined;
        leaveSignIn();
        document.removeEventListener("visibilitychange", onVisibility);
        backdrop.destroy();
        host.destroy();
        root.classList.remove("signin", "signin-auth");
    };

    /** MarqueeScene: choosing a server is generic; a confirmed server is the account stage. */
    const show = (screen: Screen, focus?: string): void => {
        const choosing = SERVER_SCREENS.has(screen.name);
        if (choosing) marqueeScene.showGeneric();
        else {
            marqueeScene.showServer();
            marqueeScene.focus = "account";
        }
        backdrop.setStage(marqueeScene.stage);
        backdrop.setAccent(choosing ? undefined : active?.accent);
        host.show(screen, focus);
        fitCodeActions(root);
    };

    /**
     * QRLoginViewModel.setActive: hidden, nothing is polled or started; back on screen is someone
     * at the TV again, so the code is polled at once and codes may renew for another hour.
     */
    const onVisibility = (): void => {
        const current = active;
        if (current === undefined) {
            return;
        }
        const visible = document.visibilityState !== "hidden";
        current.login.setActive(visible);
        const pending = current.pendingStart;
        if (!visible) {
            if (pending !== undefined) {
                current.cancelTimer?.();
                current.cancelTimer = undefined;
            }
            return;
        }
        if (!text.isTerminal(current.status)) {
            current.windowStart = clock.now();
        }
        if (pending !== undefined) {
            scheduleStart(current, Math.max(0, pending.floor - clock.now()));
        }
    };
    document.addEventListener("visibilitychange", onVisibility);

    const handOff = (server: ConnectedServer): void => {
        leaveSignIn(true);
        destroy();
        options.onSignedIn(server);
    };

    /**
     * The Apple TV manual entry. `busy`: a connect is running; Connect says so and holds focus,
     * and nothing else is reachable until it answers, as the Apple TV app waits for its probe.
     */
    const entryScreen = (notes: readonly Note[], offerForget: boolean, error?: string, busy = false, errorField?: "address" | "port"): Screen => {
        const input = textInput("signin-address", "address", "media.example.com", "Server address", address);
        input.type = "url";
        input.readOnly = busy;
        input.addEventListener("input", () => {
            address = input.value;
        });
        const connect = marqueeButton("connect", busy ? "Connecting…" : "Connect", "primary", () => {
            if (!busy) {
                address = input.value;
                submit();
            }
        }, { loading: busy });
        const toggle = marqueeButton("advanced", advanced ? "Hide advanced options" : "Advanced options", "plain", () => {
            advanced = !advanced;
            show(entryScreen(notes, offerForget, error, false, errorField), "advanced");
        }, { glyph: "gear", compact: true });
        const controls: Control[] = [
            { key: "address", element: input, row: 0, done: "connect" },
            { ...toggle, row: 1 },
        ];
        const addressError = error !== undefined && errorField !== "port";
        if (addressError) {
            input.setAttribute("aria-invalid", "true");
        }
        const copy: HTMLElement[] = [headline(text.ENTRY_TITLE), lead(text.ENTRY_LEAD), field(input, "globe", addressError)];
        if (error !== undefined) {
            copy.push(errorText(error));
        }
        const toggleRow = actionRow([toggle]);
        toggleRow.classList.add("signin-toggle-row");
        copy.push(...noteChips(notes), toggleRow);
        if (advanced) {
            const options = el("div", "signin-advanced");
            for (const [value, label] of SCHEMES) {
                const option = marqueeButton(`scheme-${value}`, label, "glass", () => {
                    scheme = value;
                    show(entryScreen(notes, offerForget, error, false, errorField), `scheme-${value}`);
                }, { compact: true, ...(scheme === value ? { glyph: "check" as const } : {}) });
                option.element.setAttribute("aria-pressed", String(scheme === value));
                options.appendChild(option.element);
                controls.push({ ...option, row: 2, landing: scheme === value });
            }
            const portInput = textInput("signin-port", "port", "Port: auto", "Port", port);
            portInput.inputMode = "numeric";
            portInput.readOnly = busy;
            portInput.addEventListener("input", () => {
                port = portInput.value;
            });
            const portError = errorField === "port";
            if (portError) {
                portInput.setAttribute("aria-invalid", "true");
            }
            const portField = field(portInput, "number", portError);
            portField.classList.add("signin-port");
            options.appendChild(portField);
            controls.push({ key: "port", element: portInput, row: 2, done: "connect" });
            copy.push(options);
        }
        const row = [connect];
        if (options.onCancel) row.push(marqueeButton("back", "Back", "plain", () => { destroy(); options.onCancel?.(); }));
        else if (options.onChangeAccount && opensAccountList()) {
            row.push(marqueeButton("change-account", options.returnToAccounts ? "Back to accounts" : savedAccounts().some(account => !account.needsSignIn) ? "Back to profiles" : "Change account", "plain", changeServer));
        }
        if (offerForget) {
            row.push(marqueeButton("forget", "Remove saved sign-in", "plain", () => void forget()));
        }
        copy.push(actionRow(row));
        controls.push(...row.map((control) => ({ ...control, row: 3, landing: control.key === "connect" })));
        if (busy) {
            for (const control of controls) {
                if (control.key !== "connect" && !(control.element instanceof HTMLInputElement)) {
                    control.element.setAttribute("disabled", "");
                }
            }
        }
        const tvName = core.deviceName.trim();
        return {
            name: busy ? "connecting" : "entry",
            content: marqueeScreen(copy, keyboardCard(), tvName === "" ? undefined : chip(tvName, "tv")),
            controls: busy ? controls.filter((control) => control.key === "connect") : controls,
            focus: address === "" ? "address" : "connect",
            // Leaving mid-probe would let a late connect pull the app on, so Back waits for it.
            back: busy ? () => undefined : options.onCancel ? () => { destroy(); options.onCancel?.(); } : undefined,
        };
    };

    const showEntry = (notes: readonly Note[], offerForget: boolean, focus?: string, error?: string, errorField?: "address" | "port"): void => {
        show(entryScreen(notes, offerForget, error, false, errorField), focus);
    };

    /**
     * A bad port is explained on the field it belongs to, and the Port field is opened so the
     * outline is in view. Focus stays on Connect. TVServerSetupView.connect does not move
     * focusedField, and the running Apple TV app stays on Connect.
     */
    const rejectPort = (offerForget: boolean, fault: "address" | "port"): void => {
        if (fault === "port") {
            advanced = true;
        }
        showEntry([], offerForget, "connect", text.INVALID_PORT, fault);
    };

    /** Applies Advanced options; a bad port is explained before anything is sent. */
    const submit = (): void => {
        const fault = portFieldFault(address, port);
        if (fault !== undefined) {
            rejectPort(false, fault);
            return;
        }
        const chosen = advancedAddress(address, scheme, port);
        if (!chosen.ok) {
            rejectPort(false, "port");
            return;
        }
        startConnect([], chosen.address, scheme);
    };

    const forget = async (): Promise<void> => {
        const fault = portFieldFault(address, port);
        if (fault !== undefined) {
            rejectPort(true, fault);
            return;
        }
        const chosen = advancedAddress(address, scheme, port);
        if (!chosen.ok) {
            rejectPort(true, "port");
            return;
        }
        const result = await forgetStoredCredential(chosen.address, core);
        if (destroyed || host.name !== "entry") {
            return;
        }
        if (result === "cleared" || result === "guarded" || result === "failed") {
            const failed = result === "failed";
            showEntry(failed ? [] : [{ text: text.forgetResult(result), tone: "info" }], failed, failed ? "forget" : "connect", failed ? text.forgetResult(result) : undefined);
            return;
        }
        showEntry([], false, "address", text.connectProblem({ status: "invalid_url", problem: result }));
    };

    /**
     * `fallbacks`: plain-HTTP addresses the person agreed to, tried in order after `target`.
     * `chosen`: the protocol picked in Advanced options; only Auto asks about plain HTTP.
     */
    const startConnect = (fallbacks: readonly string[] = [], target = address, chosen: AdvancedScheme = "auto", offlineRestore = false): void => {
        connecting?.abort();
        const controller = new AbortController();
        connecting = controller;
        show(entryScreen([], false, undefined, true), "connect");
        const cancelCleanupWait = clock.schedule(() => {
            if (connecting === controller && !controller.signal.aborted && !destroyed) {
                controller.abort();
                connecting = undefined;
                showEntry([], false, "connect", "This TV is still removing the earlier sign-in. Try connecting again in a moment.");
            }
        }, CLEANUP_WAIT_MS);
        pendingAccountCleanup.then(() => {
            cancelCleanupWait();
            if (!controller.signal.aborted && !destroyed) {
                return connectInOrder([target, ...fallbacks], controller.signal, offlineRestore);
            }
            return undefined;
        }).then(
            (result) => {
                if (result !== undefined && connecting === controller && !controller.signal.aborted && !destroyed) {
                    connecting = undefined;
                    // Only a failed connection (TLS included) suggests plain HTTP; a server that
                    // answered over HTTPS is never downgraded.
                    if (fallbacks.length === 0 && chosen === "auto" && result.status === "unreachable") {
                        const plain = plainHttpFallbacks(target);
                        if (plain.length > 0) {
                            askCleartext(plain);
                            return;
                        }
                    }
                    connected(result);
                }
            },
            (error: unknown) => {
                if (controller.signal.aborted || destroyed) {
                    return;
                }
                connecting = undefined;
                showEntry([], false, "connect", "Something went wrong while connecting. Try again.");
                clock.schedule(() => {
                    throw error;
                }, 0);
            },
        );
    };

    /** Like the Apple TV app, the first plain-HTTP address that answers as Silo wins. */
    const connectInOrder = async (addresses: readonly string[], signal: AbortSignal, offlineRestore: boolean): Promise<ConnectResult> => {
        let result: ConnectResult = { status: "unreachable" };
        for (const candidate of addresses) {
            result = await connect(candidate, { ...core, allowOfflineRestore: offlineRestore }, signal);
            if (result.status === "connected" || result.status === "needs_setup" || signal.aborted) {
                break;
            }
        }
        return result;
    };

    /**
     * Every HTTPS attempt for a scheme-less address failed; nothing is sent in the clear unasked.
     * Like the tvOS alert: centred over the dimmed address screen, Cancel then Connect, Connect focused.
     */
    const askCleartext = (plain: readonly string[]): void => {
        const decline = (): void => showEntry([], false, "connect", text.CLEARTEXT_DECLINED);
        const controls = [
            marqueeButton("cancel", "Cancel", "glass", decline),
            marqueeButton("connect", "Connect", "glass", () => {
                address = plain[0] ?? address;
                startConnect(plain.slice(1));
            }),
        ];
        // The address screen stays behind the alert, dimmed and out of reach.
        const behind = el("div", "signin-behind");
        behind.setAttribute("aria-hidden", "true");
        for (const node of entryScreen([], false).content) {
            behind.appendChild(node);
        }
        for (const node of Array.from(behind.querySelectorAll("input, button"))) {
            node.removeAttribute("id");
            node.removeAttribute("data-focus");
            node.setAttribute("disabled", "");
        }
        const alert = el("div", "signin-alert");
        alert.setAttribute("role", "alertdialog");
        alert.setAttribute("aria-labelledby", "signin-alert-title");
        const title = el("h2", "signin-alert-title", text.CLEARTEXT_TITLE);
        title.id = "signin-alert-title";
        for (const node of [title, el("p", "signin-alert-text", text.cleartextWarning(new URL(plain[0] ?? "").host)), actionRow(controls)]) {
            alert.appendChild(node);
        }
        show({ name: "insecure", content: [behind, alert], controls, focus: "connect", back: decline });
    };

    const cancelSetupCheck = (): void => {
        setupProbe?.abort();
        setupProbe = undefined;
        checkingSetup = false;
    };

    /** Check again found a ready server, or Back popped to the login screen underneath. */
    const enterSignIn = (server: ConnectedServer): void => {
        if (destroyed) {
            return;
        }
        pendingSetup = undefined;
        connected(server);
    };

    const showNeedsSetup = (checking: boolean, error?: string): void => {
        const server = pendingSetup;
        if (server === undefined) {
            return;
        }
        const base = server.http.base.baseUrl;
        const retry = marqueeButton("retry", checking ? "Checking…" : "Check again", "primary", () => {
            checkAgain();
        }, { glyph: "retry", loading: checking });
        const change = marqueeButton("change", "Change server", "plain", () => {
            leaveForAddress();
        });
        const copy = [
            setupNeededCard(text.serverHostLabel(base), base, text.SETUP_NEEDED),
            headline(text.SERVER_NOT_READY_TITLE),
            lead(text.SERVER_NOT_READY_BODY),
        ];
        if (error !== undefined) {
            copy.push(errorText(error));
        }
        copy.push(actionRow([retry, change]));
        show({
            name: "needs-setup",
            content: marqueeScreen(copy),
            controls: [
                { ...retry, row: 0, landing: true },
                { ...change, row: 0 },
            ],
            focus: "retry",
            back: () => {
                backToSignIn();
            },
        });
    };

    /** ServerNeedsSetupRetryModel.retry. A check already running is ignored, and the button stays enabled. */
    const checkAgain = (): void => {
        if (checkingSetup || pendingSetup === undefined) {
            return;
        }
        const expected = address;
        checkingSetup = true;
        setupProbe?.abort();
        const controller = new AbortController();
        setupProbe = controller;
        showNeedsSetup(true);
        void connect(expected, { ...core, allowOfflineRestore: false }, controller.signal).then((result) => {
            if (controller.signal.aborted || destroyed || address !== expected || host.name !== "needs-setup") {
                return;
            }
            checkingSetup = false;
            setupProbe = undefined;
            if (result.status === "needs_setup") {
                pendingSetup = result.server;
                showNeedsSetup(false, text.STILL_NEEDS_SETUP);
                return;
            }
            if (result.status !== "connected") {
                showNeedsSetup(false, text.SETUP_UNREACHABLE);
                return;
            }
            enterSignIn(result);
        }, (error: unknown) => {
            if (controller.signal.aborted || destroyed || host.name !== "needs-setup") {
                return;
            }
            checkingSetup = false;
            setupProbe = undefined;
            showNeedsSetup(false, text.SETUP_UNREACHABLE);
            if (!(error instanceof ApiError)) {
                clock.schedule(() => {
                    throw error;
                }, 0);
            }
        });
    };

    /** Menu pops to the login screen already under this one. The probe is cancelled first. */
    const backToSignIn = (): void => {
        const server = pendingSetup;
        if (server === undefined) {
            return;
        }
        cancelSetupCheck();
        // The screen stays up until sign-in replaces it. Ignore another check in that moment.
        checkingSetup = true;
        void openDiscoveredServer(server, core).then((opened) => {
            // Change server clears or replaces pendingSetup while the saved account is still being read.
            if (!destroyed && host.name === "needs-setup" && pendingSetup === server) {
                enterSignIn(opened);
            }
        }, (error: unknown) => {
            clock.schedule(() => {
                throw error;
            }, 0);
        });
    };

    const leaveForAddress = (): void => {
        cancelSetupCheck();
        pendingSetup = undefined;
        showEntry([], false, "connect");
    };

    const connected = (result: ConnectResult): void => {
        if (result.status === "needs_setup") {
            address = result.server.http.base.baseUrl;
            scheme = "auto";
            port = "";
            advanced = false;
            writeServer(core, address);
            pendingSetup = result.server;
            checkingSetup = false;
            showNeedsSetup(false);
            return;
        }
        if (result.status !== "connected") {
            showEntry([], result.status !== "invalid_url", "connect", text.connectProblem(result));
            return;
        }
        address = result.server.http.base.baseUrl;
        scheme = "auto";
        port = "";
        advanced = false;
        writeServer(core, address);
        if (result.restore === "signed_in") {
            handOff(result);
            return;
        }
        const notice = text.restoreNotice(result.restore);
        signIn(result, notice === undefined ? [] : [{ text: notice, tone: "info" }]);
    };

    let sessionExpired = options.sessionExpired === true;
    const signIn = (server: ConnectedServer, notes: readonly Note[]): void => {
        leaveSignIn();
        const login = server.createDeviceLogin();
        const baseUrl = server.server.http.base.baseUrl;
        const expired = sessionExpired
            ? [{ text: text.sessionExpiredNotice(cachedBranding(core.publicStorage, baseUrl)?.serverName ?? text.serverHost(baseUrl)), tone: "info" as const }]
            : [];
        notes = [...expired, ...notes];
        const stop = login.subscribe((state) => {
            if (active?.login === login) {
                render(state);
            }
        });
        options.onConnected?.(server);
        const base = server.server.http.base.baseUrl;
        const remembered = cachedBranding(core.publicStorage, base);
        const now = clock.now();
        const current: Active = {
            server, login, stop, notes, code: undefined, typed: undefined, left: new AbortController(), options: undefined,
            credentials: false, submitting: false, username: options.username ?? "", password: "", shown: false, error: undefined, errorField: undefined,
            status: { kind: "getting_code" }, shownCode: undefined, renewed: false, windowStart: now, startedAt: now,
            sawCode: false, startStreak: undefined, cancelTimer: undefined, pendingStart: undefined,
            // ServerBrandingCache: the last answer shows at once; the server's new one replaces it.
            serverName: remembered?.serverName, markUrl: remembered?.markUrl, accent: remembered?.accentColor,
        };
        active = current;
        login.setActive(document.visibilityState !== "hidden");
        login.start();
        readOptions(current);
        readBranding(current);
    };

    const readBranding = (current: Active): void => {
        const base = current.server.server.http.base.baseUrl;
        void current.server.server.http.send({ ...operations.serverBranding(), signal: current.left.signal }).then((branding) => {
            // Only the server this screen still signs in to may show or store its answer.
            if (active !== current || current.left.signal.aborted) return;
            const markUrl = resolveBrandingAsset(branding.markUrl, base);
            storeBranding(core.publicStorage, base, { serverName: branding.serverName, markUrl, accentColor: branding.accentColor });
            const name = branding.serverName ?? text.serverHost(base);
            current.serverName = branding.serverName;
            current.markUrl = markUrl;
            current.accent = branding.accentColor;
            if (!SERVER_SCREENS.has(host.name ?? "entry")) {
                backdrop.setAccent(current.accent);
            }
            // A failed read keeps what was remembered, as Apple's loader returns no branding.
            // In place: a redraw would close the TV keyboard and move the QR code.
            for (const node of Array.from(root.querySelectorAll<HTMLElement>(".marquee-server-name"))) node.textContent = name;
            for (const node of Array.from(root.querySelectorAll<HTMLElement>(".marquee-server-mark"))) setServerMark(node, name, current.markUrl);
            const title = root.querySelector<HTMLElement>("[data-server-headline]");
            if (title !== null) title.textContent = `Sign in to ${name}`;
            if (current.credentials) {
                const passwordLead = root.querySelector<HTMLElement>('[data-screen="credentials"] .marquee-lead');
                if (passwordLead !== null) passwordLead.textContent = text.passwordLead(name, passwordOnly(current));
            }
        }, () => undefined);
    };

    /** Like the Apple TV app: a server that predates discovery (404) takes passwords. */
    const readOptions = (current: Active): void => {
        current.server.server.http.send({ ...operations.authProviders(), signal: current.left.signal }).then(
            (options) => options,
            (error: unknown) => {
                if (!(error instanceof ApiError)) {
                    throw error;
                }
                return error.status === 404 ? { passwordLogin: true, oauthProviders: [] } : undefined;
            },
        ).then((options) => {
            if (active !== current || options === undefined) {
                return;
            }
            const offeredPassword = current.options?.passwordLogin !== false;
            current.options = options;
            if (current.server.session.signedIn) {
                return;
            }
            if (current.credentials) {
                if (host.name !== "credentials") {
                    return;
                }
                const hint = root.querySelector<HTMLElement>(".signin-hint");
                const value = passwordOnly(current) ? undefined : text.phoneHint(options.oauthProviders);
                if (hint !== null) {
                    hint.textContent = value ?? "";
                    hint.hidden = value === undefined || root.querySelector(".marquee-error")?.textContent?.includes(value) === true;
                }
            } else if (current.login.current.phase !== "unavailable" && offeredPassword !== (options.passwordLogin !== false)) {
                current.code = undefined;
                showCode(current);
            }
        }, (error: unknown) => {
            clock.schedule(() => {
                throw error;
            }, 0);
        });
    };

    /** Stops listening before withdrawal; an accepted account stays only on successful handoff. */
    const leaveSignIn = (keepAccount = false): void => {
        const current = active;
        active = undefined;
        if (current !== undefined) {
            current.cancelTimer?.();
            current.cancelTimer = undefined;
            current.left.abort();
            current.stop();
            current.login.cancel();
            if (!keepAccount && current.server.session.signedIn) {
                const abandonedAddress = address;
                void logoutCollectedAccount(current.server).then((result) => {
                    if (!destroyed && host.name === "entry" && address === abandonedAddress && (result.storage === "failed" || result.server === "unreachable")) {
                        showEntry(text.signedOutNotice(result).map((line) => ({ text: line, tone: "info" })), result.storage === "failed");
                    }
                }, (error: unknown) => {
                    clock.schedule(() => {
                        throw error;
                    }, 0);
                });
            }
        }
    };

    const savedAccounts = (): readonly SavedAccount[] => {
        try {
            return new AccountDirectory(options.core.publicStorage, options.core.randomBytes).list();
        } catch {
            return [];
        }
    };
    /** TVLoginView.leaveTitle at silo-apple 54cf0f34. The sign-in harness has nowhere else to go. */
    const leaveTitle = (): string => {
        if (!options.onChangeAccount && !options.returnToAccounts) return "Change server";
        if (options.returnToAccounts) return "Back to accounts";
        const rows = savedAccounts();
        if (rows.some(account => !account.needsSignIn)) return "Back to profiles";
        return rows.length > 1 ? "Change account" : "Change server";
    };
    /**
     * AppRouter.leaveSignIn. A first sign-in has no account yet, and Back still opens Change
     * Account. One expired account returns to the address. Anything else saved, or a sign-in
     * started from Change Account, goes back there.
     */
    const opensAccountList = (): boolean => {
        if (!options.onChangeAccount) return false;
        if (options.returnToAccounts) return true;
        const rows = savedAccounts();
        if (rows.some(account => !account.needsSignIn)) return true;
        return rows.length !== 1;
    };
    const changeServer = (): void => {
        if (opensAccountList()) { destroy(); options.onChangeAccount?.(); return; }
        // AppRouter.resetToServerSetup clears loginNotice: a new connection is not an expiry.
        sessionExpired = false;
        leaveSignIn();
        showEntry([], false, "connect");
    };

    /** Starts the next attempt; a renewal or a retry after a failed start keeps what the screen says. */
    const startAttempt = (current: Active): void => {
        current.cancelTimer?.();
        current.cancelTimer = undefined;
        current.pendingStart = undefined;
        current.sawCode = false;
        current.startedAt = clock.now();
        current.login.start();
    };

    /** "Try again" and "Show a new code": a fresh code and a fresh hour of renewals (QRLoginViewModel.retry). */
    const retry = (current: Active): void => {
        if (current.status.kind === "approved") {
            if (!current.credentials) {
                showCode(current);
            }
            return;
        }
        current.renewed = false;
        current.windowStart = clock.now();
        current.startStreak = undefined;
        current.shownCode = undefined;
        current.status = { kind: "getting_code" };
        startAttempt(current);
        if (!current.credentials) {
            showCode(current);
        }
    };

    /** Maps each device-login state onto the Apple TV app's status, then shows it. */
    const render = (state: DeviceLoginState): void => {
        const current = active;
        if (current === undefined) {
            return;
        }
        const now = clock.now();
        switch (state.phase) {
            case "signed_in":
                approved(current, state);
                return;
            case "unavailable":
                // A server without code sign-in opens on the password, as on the Apple TV app.
                if (host.name === "credentials" && current.credentialsView !== undefined) {
                    current.credentialsView.usePasswordOnly();
                    return;
                }
                current.credentials = true;
                current.code = undefined;
                showCredentials(current);
                return;
            case "idle":
            case "starting":
                // A renewal says it is getting a code; a failing start keeps its grace or its warning.
                if (current.status.kind === "waiting" || current.status.kind === "opened") {
                    current.status = { kind: "getting_code" };
                }
                current.shownCode = undefined;
                break;
            case "waiting": {
                current.sawCode = true;
                current.startStreak = undefined;
                current.shownCode = state.code;
                current.typed = text.typedUrl(state.code.verificationUri, state.code.verificationUriComplete);
                if (state.retrying === "none") {
                    current.status = state.opened ? { kind: "opened" } : current.status.kind === "opened" ? current.status : { kind: "waiting", renewed: current.renewed };
                } else if (state.retrying === "rate_limited") {
                    if (state.rateLimitedSince !== undefined && now - state.rateLimitedSince >= RATE_LIMITED_AFTER_MS) {
                        current.status = { kind: "rate_limited" };
                    }
                } else if (state.failingSince !== undefined && now - state.failingSince >= UNREACHABLE_WHILE_POLLING_MS) {
                    current.status = { kind: "unreachable" };
                }
                break;
            }
            case "denied":
                current.status = { kind: "denied" };
                current.shownCode = undefined;
                break;
            case "expired":
            case "canceled":
            case "consumed":
                // Ended on the server, or its approval was lost: renew in place within the hour.
                if (current.server.session.signedIn) {
                    return;
                }
                current.shownCode = undefined;
                current.renewed = true;
                if (now - current.windowStart >= RENEWAL_LIMIT_MS) {
                    current.status = { kind: "paused" };
                    break;
                }
                if (current.status.kind === "waiting" || current.status.kind === "opened") {
                    current.status = { kind: "getting_code" };
                }
                startAttempt(current);
                return;
            case "failed":
                current.shownCode = undefined;
                if (state.reason === "temporary_session_refused") {
                    current.status = { kind: "could_not_finish" };
                } else if (current.sawCode) {
                    current.status = { kind: "failed", message: text.failedMessage(state) };
                } else {
                    failedStart(current, state, now);
                }
                break;
        }
        if (!current.credentials) {
            showCode(current);
        }
    };

    /** A start that failed is sent again with backoff; the screen warns once its grace has passed. */
    const failedStart = (current: Active, state: Extract<DeviceLoginState, { readonly phase: "failed" }>, now: number): void => {
        const limited = state.reason === "rate_limited";
        const previous = current.startStreak;
        const since = previous?.since ?? current.startedAt;
        const limitedSince = limited ? previous?.limitedSince ?? current.startedAt : undefined;
        const backoff = previous === undefined ? 1 : Math.min(MAX_BACKOFF_SECONDS, previous.backoff * 2);
        current.startStreak = { since, limitedSince, backoff };
        if (limited) {
            if (limitedSince !== undefined && now - limitedSince >= RATE_LIMITED_AFTER_MS) {
                current.status = { kind: "rate_limited" };
            }
        } else if (now - since >= UNREACHABLE_WHILE_STARTING_MS) {
            current.status = { kind: "unreachable" };
        }
        const retryAfter = limited ? state.retryAfterSeconds ?? 0 : 0;
        current.pendingStart = { floor: now + retryAfter * 1000 };
        if (document.visibilityState !== "hidden") {
            scheduleStart(current, Math.max(backoff, retryAfter) * 1000);
        }
    };

    const scheduleStart = (current: Active, ms: number): void => {
        current.cancelTimer?.();
        current.cancelTimer = clock.schedule(() => {
            current.cancelTimer = undefined;
            if (active === current && !current.server.session.signedIn) {
                startAttempt(current);
            }
        }, ms);
    };

    const showCode = (current: Active): void => {
        const status = current.status;
        const action = text.stateAction(status);
        const code = status.kind === "waiting" || status.kind === "opened" || status.kind === "unreachable" || status.kind === "rate_limited" ? current.shownCode : undefined;
        const shown = current.code;
        const hasAction = root.querySelector('[data-screen] [data-focus="retry"]') !== null;
        if (shown !== undefined && code !== undefined && shown.userCode === code.userCode && host.name === "code" && hasAction === (action !== undefined)) {
            shown.update(status);
            return;
        }
        const base = current.server.server.http.base.baseUrl;
        const controls = [
            ...(action === undefined ? [] : [marqueeButton("retry", action, "primary", () => retry(current), { glyph: "retry" })]),
            ...codeActions(current),
        ];
        const view = codeScreen({
            status,
            code,
            serverName: current.serverName ?? text.serverHost(base),
            host: text.serverHost(base),
            secure: base.startsWith("https:"),
            markUrl: current.markUrl,
            typed: current.typed,
            notes: current.notes,
            controls,
            rest: controls.some((control) => control.key === "password") ? "password" : "change",
            back: changeServer,
        });
        current.code = view;
        // A state that ends the attempt takes focus to its action; otherwise focus stays where it was.
        const kept = document.activeElement?.getAttribute("data-focus") ?? undefined;
        const keep = view.screen.focus !== "retry" && controls.some((control) => control.key === kept);
        show(view.screen, keep ? kept : view.screen.focus);
    };

    /** "Sign in with a password" unless the server says no provider takes one; then "Change server". */
    const codeActions = (current: Active): Control[] => [
        ...(current.options?.passwordLogin === false ? [] : [marqueeButton("password", "Sign in with a password", "glass", () => openCredentials(current), { glyph: "key" })]),
        marqueeButton("change", leaveTitle(), "plain", changeServer),
    ];

    const openCredentials = (current: Active): void => {
        current.credentials = true;
        current.code = undefined;
        if (current.username === "") current.username = options.username ?? "";
        showCredentials(current, "username");
    };

    /** Back to the code it left; one that ended meanwhile is replaced, as on the Apple TV app. */
    const returnToCode = (current: Active): void => {
        if (current.submitting) {
            return;
        }
        current.credentials = false;
        if (text.isTerminal(current.status)) {
            retry(current);
        } else {
            current.code = undefined;
            showCode(current);
        }
    };

    const passwordOnly = (current: Active): boolean => current.login.current.phase === "unavailable";

    const showCredentials = (current: Active, focus?: string, shake = false): void => {
        const phoneRoute = !passwordOnly(current);
        const base = current.server.server.http.base.baseUrl;
        show(
            current.credentialsView = credentialsScreen({
                serverName: current.serverName ?? text.serverHost(base),
                host: text.serverHost(base),
                secure: base.startsWith("https:"),
                markUrl: current.markUrl,
                notes: current.notes,
                passwordOnly: !phoneRoute,
                hint: phoneRoute ? text.phoneHint(current.options?.oauthProviders ?? []) : undefined,
                username: current.username,
                password: current.password,
                shown: current.shown,
                error: current.error,
                errorField: current.errorField,
                shake,
                submitting: current.submitting,
                onInput: (username, password) => {
                    current.username = username;
                    current.password = password;
                },
                toggle: () => {
                    current.shown = !current.shown;
                    showCredentials(current);
                },
                submit: () => submitPassword(current),
                phone: phoneRoute ? () => returnToCode(current) : undefined,
                change: changeServer,
                changeLabel: leaveTitle(),
                back: current.submitting ? () => undefined : phoneRoute ? () => returnToCode(current) : changeServer,
            }),
            focus,
        );
    };

    const submitPassword = (current: Active): void => {
        if (current.submitting) {
            return;
        }
        const phoneRoute = !passwordOnly(current);
        const hint = phoneRoute ? text.phoneHint(current.options?.oauthProviders ?? []) : undefined;
        const refuse = (message: string, field: "username" | "password"): void => {
            current.error = message;
            current.errorField = field === "username" ? "username" : undefined;
            // A missing username outlines and focuses that field. Every other failure outlines the password.
            showCredentials(current, field === "username" ? "username" : "secret", true);
        };
        if (current.username.trim() === "") {
            refuse(text.ENTER_USERNAME, "username");
            return;
        }
        if (current.password === "") {
            refuse(text.ENTER_PASSWORD, "password");
            return;
        }
        current.submitting = true;
        current.error = undefined;
        current.errorField = undefined;
        showCredentials(current);
        passwordLogin(current.server.session, current.username, current.password, current.left.signal).then((result) => {
            if (active !== current) {
                return;
            }
            current.submitting = false;
            if (result.status !== "signed_in" && (current.server.session.signedIn || host.name !== "credentials")) {
                return;
            }
            switch (result.status) {
                case "signed_in":
                    signedIn(current, { phase: "signed_in", persistence: result.persistence, previousSession: result.previousSession, passwordChangeRequired: result.passwordChangeRequired });
                    return;
                case "failed":
                    refuse(text.passwordProblem(result.error, hint, phoneRoute), "password");
                    return;
                case "superseded":
                    showCredentials(current);
            }
        }, (error: unknown) => {
            clock.schedule(() => {
                throw error;
            }, 0);
        });
    };

    /**
     * A phone approval: "Signed in as …" for a second, then on (TVLoginView). Leaving, a new
     * sign-in, or the account's authority changing in that second cancels the move.
     */
    const approved = (current: Active, state: Extract<DeviceLoginState, { readonly phase: "signed_in" }>): void => {
        const session = current.server.session;
        const generation = session.authorityGeneration;
        current.status = { kind: "approved", account: session.account?.username || undefined };
        current.shownCode = undefined;
        if (!current.credentials) {
            showCode(current);
        }
        const stopWatching = session.onAuthorityChange(() => {
            if (active === current && !session.signedIn) {
                // Signed out meanwhile: there is nothing to hand over; start again.
                current.cancelTimer?.();
                signIn(current.server, []);
            }
        });
        const cancel = clock.schedule(() => {
            stopWatching();
            current.cancelTimer = undefined;
            if (active === current && !destroyed && session.signedIn && session.authorityGeneration === generation) {
                signedIn(current, state);
            }
        }, APPROVAL_PAUSE_MS);
        current.cancelTimer = () => {
            stopWatching();
            cancel();
        };
    };

    const signedIn = (current: Active, state: Extract<DeviceLoginState, { readonly phase: "signed_in" }>): void => {
        const server = current.server;
        const kept = state.previousSession === "failed" ? [text.PREVIOUS_SESSION_KEPT] : [];
        const lines = [...(state.persistence === "session_only" ? [text.SESSION_ONLY] : []), ...kept];
        if (lines.length === 0) {
            handOff(server);
            return;
        }
        const account = server.session.account;
        const title = account === undefined || account.username === "" ? "Signed in" : `Signed in as ${account.username}`;
        showMessage("notice", title, lines, [marqueeButton("continue", "Continue", "primary", () => handOff(server))], () => undefined);
    };

    /** A screen of its own for what only this TV says, such as a session it can't keep. */
    const showMessage = (name: string, title: string, lines: readonly string[], controls: readonly Control[], back: () => void = changeServer): void => {
        const copy = [headline(title), ...lines.map((line) => lead(line)), actionRow(controls)];
        show({ name, content: marqueeScreen(copy), controls, focus: controls[0]?.key ?? "", back });
    };

    if (options.signedOut !== undefined) {
        showEntry(text.signedOutNotice(options.signedOut).map((line) => ({ text: line, tone: "info" })), false);
    } else if (options.chooseServer === true) {
        showEntry([], false, "connect");
    } else if (address !== "") {
        startConnect([], address, "auto", true);
    } else {
        showEntry([], false);
    }
    return { destroy };
}

function readServer(core: SessionCoreDeps): string | undefined {
    try {
        return core.publicStorage?.getItem(SERVER_KEY) ?? undefined;
    } catch {
        return undefined;
    }
}

/** One row when the code actions fit the 900-wide copy column, else one button per line. */
function fitCodeActions(root: HTMLElement): void {
    const section = root.querySelector(".signin-screen");
    const name = section?.getAttribute("data-screen");
    if (section === null || (name !== "code" && name !== "starting" && name !== "ended" && name !== "approved")) {
        return;
    }
    const row = section.querySelector(".marquee-actions");
    if (!(row instanceof HTMLElement) || row.childElementCount < 2) {
        return;
    }
    const buttons = [...row.children].filter((node): node is HTMLElement => node instanceof HTMLElement);
    // A flex row shrinks the buttons to the column, so the laid-out widths always fit. Measure each label at its own width.
    for (const button of buttons) {
        button.style.flex = "none";
        button.style.width = "max-content";
    }
    const width = buttons.reduce((sum, button) => sum + button.offsetWidth, 0) + 22 * (buttons.length - 1);
    for (const button of buttons) {
        button.style.flex = "";
        button.style.width = "";
    }
    row.classList.toggle("marquee-actions-stack", width > 900);
}

function writeServer(core: SessionCoreDeps, baseUrl: string): void {
    try {
        core.publicStorage?.setItem(SERVER_KEY, baseUrl);
    } catch {
        // Not remembered: the next launch asks for the address again.
    }
}
