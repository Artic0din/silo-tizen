// Native sign-in screens: the server address, then the eight-digit code, ending in one typed
// handoff of the signed-in server. The session core owns discovery, restore, polling, storage
// and logout; this module only shows its states and turns remote keys into its calls.

import { type Clock, systemClock } from "../api/clock.ts";
import { type ConnectedServer, type ConnectResult, connect, forgetStoredCredential, type SessionCoreDeps } from "../session/core.ts";
import type { DeviceLogin, DeviceLoginState } from "../session/deviceLogin.ts";
import type { LogoutResult } from "../session/session.ts";
import { codeScreen, type CodeScreen } from "./codeScreen.ts";
import { actions, button, type Control, el, type Note, noteNodes, ScreenHost } from "./screen.ts";
import * as text from "./signInText.ts";

export interface SignInOptions {
    readonly core: SessionCoreDeps;
    /** Receives the server once its account is signed in. The sign-in screens are gone by then. */
    readonly onSignedIn: (server: ConnectedServer) => void;
    /** After a sign-out: shown on the address screen, which then waits instead of reconnecting. */
    readonly signedOut?: LogoutResult;
}

export interface SignInScreens {
    destroy(): void;
}

/** The last server connected to, so a restart can restore its session. An address, not a secret. */
const SERVER_KEY = "silo.native.server";
const CLEANUP_WAIT_MS = 10000;

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
    code: CodeScreen | undefined;
}

export function mountSignIn(root: HTMLElement, options: SignInOptions): SignInScreens {
    const core = options.core;
    const clock: Clock = core.clock ?? systemClock;
    const host = new ScreenHost(root);
    root.classList.add("signin");
    let address = readServer(core) ?? "";
    let connecting: AbortController | undefined;
    let active: Active | undefined;
    let destroyed = false;

    const destroy = (): void => {
        destroyed = true;
        connecting?.abort();
        connecting = undefined;
        leaveSignIn();
        host.destroy();
        root.classList.remove("signin");
    };

    const handOff = (server: ConnectedServer): void => {
        leaveSignIn(true);
        destroy();
        options.onSignedIn(server);
    };

    const showEntry = (notes: readonly Note[], offerForget: boolean, focus?: string): void => {
        const input = el("input", "signin-input");
        input.id = "signin-address";
        input.type = "url";
        input.value = address;
        input.spellcheck = false;
        input.autocomplete = "off";
        input.setAttribute("autocapitalize", "off");
        input.setAttribute("data-focus", "address");
        input.addEventListener("input", () => {
            address = input.value;
        });
        const label = el("label", "signin-label", "Server address");
        label.htmlFor = input.id;
        const controls: Control[] = [
            { key: "address", element: input },
            button("connect", "Connect", () => {
                address = input.value;
                startConnect();
            }),
        ];
        if (offerForget) {
            controls.push(button("forget", "Remove saved sign-in", () => void forget()));
        }
        host.show(
            {
                name: "entry",
                content: [el("h1", "signin-title", "Connect to Silo"), label, input, ...noteNodes(notes), actions(controls.slice(1))],
                controls,
                focus: address === "" ? "address" : "connect",
                back: undefined,
            },
            focus,
        );
    };

    const forget = async (): Promise<void> => {
        const result = await forgetStoredCredential(address, core);
        if (destroyed || host.name !== "entry") {
            return;
        }
        if (result === "cleared" || result === "guarded" || result === "failed") {
            const failed = result === "failed";
            showEntry([{ text: text.forgetResult(result), tone: failed ? "error" : "info" }], failed, failed ? "forget" : "connect");
            return;
        }
        showEntry([{ text: text.connectProblem({ status: "invalid_url", problem: result }), tone: "error" }], false, "address");
    };

    const startConnect = (): void => {
        connecting?.abort();
        const controller = new AbortController();
        connecting = controller;
        host.show({
            name: "connecting",
            content: [el("h1", "signin-title", "Connecting"), el("p", "signin-text", "Checking the server."), actions([cancelConnect])],
            controls: [cancelConnect],
            focus: "cancel",
            back: cancelConnecting,
        });
        const cancelCleanupWait = clock.schedule(() => {
            if (connecting === controller && !controller.signal.aborted && !destroyed) {
                controller.abort();
                connecting = undefined;
                showEntry([{ text: "This TV is still removing the earlier sign-in. Try connecting again in a moment.", tone: "error" }], false, "connect");
            }
        }, CLEANUP_WAIT_MS);
        pendingAccountCleanup.then(() => {
            cancelCleanupWait();
            if (!controller.signal.aborted && !destroyed) {
                return connect(address, core, controller.signal);
            }
            return undefined;
        }).then(
            (result) => {
                if (result !== undefined && connecting === controller && !controller.signal.aborted && !destroyed) {
                    connecting = undefined;
                    connected(result);
                }
            },
            (error: unknown) => {
                if (controller.signal.aborted || destroyed) {
                    return;
                }
                connecting = undefined;
                showEntry([{ text: "Something went wrong while connecting. Try again.", tone: "error" }], false, "connect");
                clock.schedule(() => {
                    throw error;
                }, 0);
            },
        );
    };

    const cancelConnecting = (): void => {
        connecting?.abort();
        connecting = undefined;
        showEntry([], false, "connect");
    };
    const cancelConnect = button("cancel", "Cancel", cancelConnecting);

    const connected = (result: ConnectResult): void => {
        if (result.status !== "connected") {
            showEntry([{ text: text.connectProblem(result), tone: "error" }], result.status !== "invalid_url", "connect");
            return;
        }
        writeServer(core, result.server.http.base.baseUrl);
        if (result.restore === "signed_in") {
            handOff(result);
            return;
        }
        const notice = text.restoreNotice(result.restore);
        signIn(result, notice === undefined ? [] : [{ text: notice, tone: "info" }]);
    };

    const signIn = (server: ConnectedServer, notes: readonly Note[]): void => {
        leaveSignIn();
        const login = server.createDeviceLogin();
        const stop = login.subscribe((state) => {
            if (active?.login === login) {
                render(state);
            }
        });
        active = { server, login, stop, notes, code: undefined };
        login.start();
    };

    /** Stops listening before withdrawal; an accepted account stays only on successful handoff. */
    const leaveSignIn = (keepAccount = false): void => {
        const current = active;
        active = undefined;
        if (current !== undefined) {
            current.stop();
            current.code?.stop();
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

    const changeServer = (): void => {
        leaveSignIn();
        showEntry([], false, "connect");
    };

    const render = (state: DeviceLoginState): void => {
        const current = active;
        if (current === undefined) {
            return;
        }
        if (state.phase !== "waiting") {
            current.code?.stop();
            current.code = undefined;
        }
        switch (state.phase) {
            case "idle":
            case "starting":
                showMessage("starting", "Sign in", ["Getting a code."], current.notes, [button("change", "Change server", changeServer)]);
                return;
            case "waiting":
                if (current.code === undefined || current.code.userCode !== state.code.userCode || host.name !== "code") {
                    current.code?.stop();
                    current.code = codeScreen(state, current.notes, clock, button("change", "Change server", changeServer));
                    host.show(current.code.screen);
                }
                current.code.update(state);
                return;
            case "signed_in":
                signedIn(current, state);
                return;
            default: {
                const outcome = text.ended(state);
                const retry = button("retry", outcome.newCode ? "Get a new code" : "Try again", () => current.login.start());
                showMessage("ended", outcome.title, [outcome.detail], [], [retry, button("change", "Change server", changeServer)], "error");
            }
        }
    };

    const signedIn = (current: Active, state: Extract<DeviceLoginState, { readonly phase: "signed_in" }>): void => {
        const server = current.server;
        const kept = state.previousSession === "failed" ? [text.PREVIOUS_SESSION_KEPT] : [];
        if (state.passwordChangeRequired) {
            // The account can do nothing on this TV until its password changes, and the change
            // ends this session anyway: sign it out now rather than hand over a session that fails.
            leaveSignIn(true);
            const showPassword = (extra: readonly string[]): void => {
                const again = button("retry", "Get a new code", () => signIn(server, []));
                const lines = [...text.passwordChange(server.server.http.base.baseUrl), ...kept, ...extra];
                showMessage("password", "Choose a new password", lines, [], [again, button("change", "Change server", changeServer)]);
            };
            showPassword([]);
            void logoutCollectedAccount(server).then((result) => {
                if (!destroyed && host.name === "password" && result.storage === "failed" && state.previousSession !== "failed") {
                    showPassword([text.PREVIOUS_SESSION_KEPT]);
                }
            });
            return;
        }
        const lines = [...(state.persistence === "session_only" ? [text.SESSION_ONLY] : []), ...kept];
        if (lines.length === 0) {
            handOff(server);
            return;
        }
        const account = server.session.account;
        const title = account === undefined || account.username === "" ? "Signed in" : `Signed in as ${account.username}`;
        showMessage("notice", title, lines, [], [button("continue", "Continue", () => handOff(server))], "info", () => undefined);
    };

    const showMessage = (
        name: string,
        title: string,
        lines: readonly string[],
        notes: readonly Note[],
        controls: readonly Control[],
        tone: Note["tone"] = "info",
        back: () => void = changeServer,
    ): void => {
        const body = lines.map((line) => el("p", tone === "error" ? "signin-text signin-error" : "signin-text", line));
        if (tone === "error") {
            body[0]?.setAttribute("role", "alert");
        }
        host.show({ name, content: [el("h1", "signin-title", title), ...body, ...noteNodes(notes), actions(controls)], controls, focus: controls[0]?.key ?? "", back });
    };

    if (options.signedOut !== undefined) {
        showEntry(text.signedOutNotice(options.signedOut).map((line) => ({ text: line, tone: "info" })), false);
    } else if (address !== "") {
        startConnect();
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

function writeServer(core: SessionCoreDeps, baseUrl: string): void {
    try {
        core.publicStorage?.setItem(SERVER_KEY, baseUrl);
    } catch {
        // Not remembered: the next launch asks for the address again.
    }
}
