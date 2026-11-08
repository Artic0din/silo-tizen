// Household profile screens: choose a profile, unlock it with its PIN, switch later, sign out.
// The session core owns profile authority (headers, PIN proof, aborting a replaced profile's
// requests); these screens show its states and hand the chosen profile to the caller.

import { type Clock, systemClock } from "../api/clock.ts";
import { ApiError } from "../api/errors.ts";
import { operations } from "../api/operations.ts";
import type { ProfileSummary } from "../contracts/v2/wire.ts";
import type { ConnectedServer } from "../session/core.ts";
import type { ProfileLaunch } from "../session/profileLaunch.ts";
import { type AuthorityChange, type LogoutResult, SessionError } from "../session/session.ts";
import { pinProblem, pinScreen } from "./pinScreen.ts";
import { actions, button, type Control, el, type Note, type Screen, ScreenHost } from "./screen.ts";
import { navigationIcon } from "./navigationIcon.ts";
import { logoutCollectedAccount } from "./signIn.ts";
import { PASSWORD_CHANGE_REQUIRED_MESSAGE } from "./signInText.ts";
import { MarqueeBackdrop, marqueeScene } from "./marqueeBackdrop.ts";
import { profilePickerScreen } from "./profilePicker.ts";
import { createProfileFlow, type ProfileCreateFlow } from "./profileCreate.ts";
import { signOutConfirmationCopy, signOutRemovesServer } from "./signOutConfirmation.ts";

export interface ProfileHandoff {
    readonly profile: ProfileSummary;
    /** The session's authority generation this profile acts under. */
    readonly generation: number;
    /**
     * Aborts when this profile stops acting: another profile chosen, its PIN proof refused, or
     * the sign-in ended. Then stop playback and drop its content; the profile screens take the root.
     */
    readonly signal: AbortSignal;
}

export interface ProfileOptions {
    readonly pickerRequested?: boolean;
    readonly onChangeServer: () => void;
    readonly server: ConnectedServer;
    readonly clock?: Clock;
    readonly launch?: ProfileLaunch;
    /** A profile acts. The profile screens are gone; the caller owns the root until `signal` aborts. */
    readonly onSelected: (active: ProfileHandoff) => void;
    /** Fresh profile metadata after a local cold-start paint; do not remount content. */
    readonly onProfileUpdated?: (profile: ProfileSummary) => void;
    /** The account is signed out on this TV. The profile screens are gone; show sign-in, with the notice when given. */
    readonly onSignedOut: (notice: LogoutResult | undefined) => void;
    /** Branding name of the signed-in server, read when Sign out asks. */
    readonly serverName?: () => string | undefined;
}

export interface ProfileScreens {
    /** Shows the profiles over the caller's content; the current profile acts until another is chosen. */
    switchProfile(): void;
    signOut(): void;
    destroy(): void;
}

const TITLE = "Who's watching?";
const PROOF_ENDED = "The PIN for this profile changed, or its unlock ended. Enter the PIN again.";

export function mountProfiles(root: HTMLElement, options: ProfileOptions): ProfileScreens {
    const { server, onSelected, onProfileUpdated, onSignedOut } = options;
    const clock = options.clock ?? systemClock;
    const session = server.session;
    let host: ScreenHost | undefined;
    let backdrop: MarqueeBackdrop | undefined;
    let creation: ProfileCreateFlow | undefined;
    /** Increases whenever the screens move on; an answer for an older view is dropped. */
    let view = 0;
    let pending: AbortController | undefined;
    let current: ProfileSummary | undefined;
    let leaving = false;
    let destroyed = false;
    let restoring = false;
    let cancelReconcile: (() => void) | undefined;

    const show = (screen: Screen, focus?: string): void => {
        if (host === undefined) {
            root.classList.add("signin");
            root.classList.add("profiles-flow");
            backdrop = new MarqueeBackdrop(clock);
            marqueeScene.showServer();
            marqueeScene.focus = "profiles";
            backdrop.setStage(marqueeScene.stage);
            host = new ScreenHost(root, undefined, backdrop.element);
        }
        root.classList.toggle("profile-picker", screen.name === "profiles");
        root.classList.toggle("profile-editor", screen.name === "profile-create");
        host.show(screen, focus);
    };

    const release = (): void => {
        if (host !== undefined) {
            host.destroy();
            host = undefined;
            root.classList.remove("signin");
            root.classList.remove("profiles-flow", "profile-picker", "profile-editor");
            backdrop?.destroy();
            backdrop = undefined;
        }
    };

    /** Starts a new view: the previous one's request is abandoned and its answer ignored. */
    const begin = (): number => {
        const oldCreation = creation;
        creation = undefined;
        oldCreation?.destroy();
        restoring = false;
        pending?.abort();
        pending = undefined;
        return ++view;
    };

    const message = (name: string, title: string, lines: readonly string[], controls: readonly Control[], back?: () => void, tone: Note["tone"] = "info", focus?: string): void => {
        const body = lines.map((line) => el("p", tone === "error" ? "signin-text signin-error" : "signin-text", line));
        if (tone === "error") {
            body[0]?.setAttribute("role", "alert");
        }
        const key = focus ?? controls[0]?.key ?? "";
        show({ name, content: [el("h1", "signin-title", title), ...body, actions(controls)], controls, focus: key, back }, key);
    };

    /** Back from the profiles returns to the profile still acting, if any. */
    const resume = (): (() => void) | undefined => {
        const active = current;
        return active !== undefined && session.activeProfile?.id === active.id ? () => handOff(active) : undefined;
    };

    const handOff = (profile: ProfileSummary): void => {
        begin();
        current = profile;
        release();
        onSelected({ profile, generation: session.authorityGeneration, signal: session.authoritySignal });
    };

    const leave = (notice: LogoutResult | undefined): void => {
        if (!destroyed) {
            destroy();
            onSignedOut(notice);
        }
    };

    const signOut = (): void => {
        if (leaving || destroyed) {
            return;
        }
        begin();
        current = undefined;
        leaving = true;
        const status = el("h1", "signin-title signin-button", "Signing out");
        status.tabIndex = 0;
        status.setAttribute("data-focus", "signing-out");
        status.setAttribute("role", "status");
        show({ name: "signing-out", content: [status], controls: [{ key: "signing-out", element: status }], focus: "signing-out", back: undefined });
        void logoutCollectedAccount(server).then(leave, (error: unknown) => {
            leave(undefined);
            rethrow(clock, error);
        });
    };

    /** Apple's tvOS sign-out confirmation. Cancel stays focused; Back cancels and returns to Sign out. */
    const askSignOut = (restore: () => void): void => {
        if (leaving || destroyed) return;
        const removesServer = signOutRemovesServer(() => server.accounts.directory.list(), server.server.http.base.baseUrl);
        const copy = signOutConfirmationCopy(session.account?.username, options.serverName?.(), removesServer);
        const cancel = button("cancel-signout", "Cancel", restore);
        const accept = button("confirm-signout", "Sign Out", signOut);
        show({
            name: "profiles:signout",
            content: [el("h1", "signin-title", copy.title), el("p", "signin-text", copy.message), actions([cancel, accept])],
            controls: [cancel, accept],
            focus: "cancel-signout",
            back: restore,
        });
    };

    const signOutButton = (restore: () => void): Control => button("signout", "Sign out", () => askSignOut(restore));

    const load = (then: (list: ProfileSummary[]) => void, focus?: string, restoreRememberedOffline = false): void => {
        const token = begin();
        const controller = new AbortController();
        pending = controller;
        const showLoading = (): void => message("profiles-loading", TITLE, ["Loading profiles."], [signOutButton(showLoading)], resume(), "info", "signout");
        showLoading();
        server.profiles.list(controller.signal).then(
            (list) => {
                if (token === view) {
                    pending = undefined;
                    const id = server.accounts.localAccountId;
                    if (id) {
                        try { server.accounts.directory.update(id, { profileCount: list.length }); }
                        catch { /* The count is a display cache; the profile response remains usable. */ }
                    }
                    then(list);
                }
            },
            (error: unknown) => {
                if (token === view) {
                    pending = undefined;
                    // Launch may reopen a remembered profile offline. Switch Profile asked for the list.
                    if (error instanceof ApiError && ["network", "timeout"].includes(error.failure.kind) && restoreRememberedOffline && options.launch?.remembered) {
                        const restore = new AbortController();
                        pending = restore;
                        void options.launch.restoreOffline(restore.signal).then(profile => {
                            if (token !== view) return;
                            pending = undefined;
                            if (profile) handOff(profile);
                            else listFailed(error, focus);
                        }, failure => { if (token === view) { pending = undefined; listFailed(failure, focus); } });
                    } else listFailed(error, focus);
                }
            },
        );
    };

    const showList = (focus?: string): void => load((list) => picker(list, focus), focus);

    const showPicker = (list: readonly ProfileSummary[], focus?: string): void => {
        const preferred = focus ?? current?.id ?? options.launch?.rememberedProfileId ?? list[0]?.id;
        const focusKey = preferred === "signout" || preferred === "add-profile" || preferred === undefined ? (preferred ?? "add-profile") : `profile:${preferred}`;
        show(profilePickerScreen({ profiles: list, baseUrl: server.server.http.base.baseUrl,
            accountName: session.account?.username, rememberedId: options.launch?.rememberedProfileId,
            focus: focusKey,
            choose, changeServer: options.onChangeServer, signOut: () => askSignOut(() => showPicker(list, "signout")), back: resume(), add: () => {
                const token = begin();
                const flow = createProfileFlow({ server, profiles: list,
                    show: (screen, focus) => { if (!destroyed && token === view) show(screen, focus); }, finished: (id, uncertain) => {
                    if (destroyed || token !== view) return;
                    creation = undefined;
                    if (uncertain) message("profile-create-uncertain", "Check profiles", ["A creation request was sent. Check the profile list before trying again."], [button("retry", "Check profiles", () => showList("add-profile"))], () => showList("add-profile"));
                    else showList(id ?? "add-profile");
                } });
                if (!destroyed && token === view) creation = flow;
                else flow.destroy();
            },
        }));
    };

    const picker = (list: readonly ProfileSummary[], focus?: string): void => {
        begin();
        showPicker(list, focus);
    };

    const listFailed = (error: unknown, focus?: string): void => {
        if (error instanceof ApiError && error.problemId === "password_change_required") {
            // Apple TV does not hand this off (`handsOffToPasswordChange` is false). The empty
            // picker shows the refusal, and focus starts on Change account.
            passwordResetRequired();
            return;
        }
        if (error instanceof SessionError && error.reason !== "unavailable") {
            expired();
            return;
        }
        if (error instanceof ApiError && error.aborted) {
            return;
        }
        if (!(error instanceof ApiError) && !(error instanceof SessionError)) {
            rethrow(clock, error);
        }
        const offline = error instanceof ApiError && (error.failure.kind === "network" || error.failure.kind === "timeout");
        const detail = offline
            ? "Could not reach the server. Check the TV's internet connection, then try again."
            : "The server had a problem. Try again in a moment.";
        const showError = (focused = "retry"): void => {
            const retry = button("retry", "Try again", () => showList(focus));
            message("profiles-error", "Profiles didn't load", [detail], [retry, signOutButton(() => showError("signout"))], resume(), "error", focused);
        };
        showError();
    };

    const choose = (profile: ProfileSummary): void => {
        if (server.profiles.select(profile).status === "selected") {
            selected(profile);
        } else {
            askPin(profile, []);
        }
    };

    const selected = (profile: ProfileSummary): void => {
        const launch = options.launch;
        if (launch === undefined || (!launch.needsOffer && !launch.remembered)) { handOff(profile); return; }
        const offer = (error = false): void => {
            begin();
            message("remember-profile", `Remember ${profile.name} on this TV?`, error ? ["Could not save the launch choice. Try again or choose Ask who's watching."] : [], [
                button("remember", error ? "Retry remember profile" : "Remember this profile", () => save(true)),
                button("ask-every-launch", "Ask who's watching at launch", () => save(false)),
                ...(error ? [button("continue-session", "Continue without saving", () => { launch.continueWithoutSaving(); handOff(profile); })] : []),
            ], () => showList(profile.id), error ? "error" : "info");
        };
        const save = (remember: boolean): void => {
            const token = begin();
            const controller = new AbortController();
            pending = controller;
            message("remember-saving", "Saving launch choice", [], [button("back", "Back", () => showList(profile.id))], () => showList(profile.id));
            launch.setRemember(remember, controller.signal, profile).then(() => { if (token === view) handOff(profile); }, () => { if (token === view) offer(true); });
        };
        if (launch.needsOffer) offer();
        else save(true);
    };

    const askPin = (profile: ProfileSummary, notes: readonly Note[]): void => {
        const token = begin();
        let checking = false;
        const unlock = (): void => {
            const pin = screen.take();
            if (checking) {
                return;
            }
            if (pin === "") {
                screen.say("Enter the PIN.", "error");
                screen.focusPin();
                return;
            }
            checking = true;
            screen.say("Checking the PIN.", "info");
            const controller = new AbortController();
            pending = controller;
            server.profiles.verifyPin(profile.id, pin, controller.signal).then((result) => {
                if (token !== view) {
                    return;
                }
                checking = false;
                pending = undefined;
                if (result.status === "verified") {
                    selected(profile);
                } else if (result.status === "signed_out" && !session.signedIn) {
                    expired();
                } else {
                    screen.say(pinProblem(result), "error");
                }
            }, (error: unknown) => {
                if (token === view) {
                    checking = false;
                    pending = undefined;
                    screen.say(pinProblem({ status: "failed" }), "error");
                }
                rethrow(clock, error);
            });
        };
        const screen = pinScreen(profile, notes, unlock, () => showList(profile.id));
        show(screen.screen);
    };

    const expired = (): void => {
        begin();
        current = undefined;
        const lines = ["Your sign-in on this TV ended. Sign in again to continue."];
        message("expired", "Signed out", lines, [button("signin", "Sign in again", signOut)]);
    };

    /**
     * A temporary password. The session stays. Try Again reloads profiles; Change account and
     * Sign out are the picker's footer (`ProfileSelectionView` on tvOS). Focus is Change account,
     * including after a retry that is still refused.
     */
    const passwordResetRequired = (): void => {
        begin();
        const showReset = (focused = "change-account"): void => {
            const retry = button("retry", "Try Again", () => showList());
            const change = button("change-account", "Change account", options.onChangeServer);
            const out = signOutButton(() => showReset("signout"));
            change.element.prepend(navigationIcon("switch-server"));
            out.element.prepend(navigationIcon("signout"));
            const retryRow = actions([retry]);
            const footer = el("div", "profile-footer");
            footer.append(change.element, out.element);
            const detail = el("p", "signin-text signin-error", PASSWORD_CHANGE_REQUIRED_MESSAGE);
            detail.setAttribute("role", "alert");
            show({
                name: "profiles-error",
                content: [el("h1", "signin-title", "Not allowed"), detail, retryRow, footer],
                controls: [
                    { ...retry, row: 0 },
                    { ...change, row: 1, landing: true },
                    { ...out, row: 1 },
                ],
                focus: focused,
                back: undefined,
            }, focused);
        };
        showReset();
    };

    /** The server refused the profile's PIN proof: ask for the PIN again if the profile still has one. */
    const proofEnded = (): void => {
        const ended = current;
        current = undefined;
        load((list) => {
            const fresh = list.find((profile) => profile.id === ended?.id);
            if (fresh !== undefined && fresh.hasPin && server.profiles.select(fresh).status === "pin_required") {
                askPin(fresh, [{ text: PROOF_ENDED, tone: "info" }]);
            } else {
                picker(list, fresh?.id);
            }
        });
    };

    const onChange = (change: AuthorityChange): void => {
        if (destroyed) {
            return;
        }
        switch (change.reason) {
            case "session_expired":
                expired();
                return;
            case "signed_out":
                if (!leaving) {
                    expired();
                }
                return;
            case "profile_proof_revoked":
                if (!restoring) proofEnded();
                return;
            case "signed_in":
                current = undefined;
                showList();
                return;
            case "profile_selected":
            case "profile_cleared":
                // These screens make these changes themselves.
                return;
        }
    };
    const unsubscribe = session.onAuthorityChange(onChange);

    const destroy = (): void => {
        if (destroyed) {
            return;
        }
        destroyed = true;
        cancelReconcile?.();
        begin();
        unsubscribe();
        release();
    };

    const launchOnline = (): void => load(list => {
        if (options.pickerRequested) { picker(list); return; }
        const token = view;
        const controller = new AbortController();
        pending = controller;
        restoring = true;
        options.launch?.restore(list, controller.signal).then(profile => {
            if (token !== view) return;
            restoring = false;
            pending = undefined;
            if (profile === undefined) picker(list);
            else handOff(profile);
        }, error => {
            if (token !== view) return;
            restoring = false;
            pending = undefined;
            if (error instanceof SessionError && error.reason !== "unavailable") { expired(); return; }
            const showLaunchError = (focused = "retry"): void => message("profile-launch-error", "Remembered profile didn't open", ["Could not verify the remembered profile. Try again or choose who's watching."], [button("retry", "Retry", launchOnline), button("back", "Choose profile", () => picker(list)), signOutButton(() => showLaunchError("signout"))], () => picker(list), "error", focused);
            showLaunchError();
        });
    }, undefined, !options.pickerRequested);
    const launch = (): void => {
        if (!server.localRestore || options.pickerRequested || !options.launch?.remembered || options.launch.requiresSelection()) {
            launchOnline();
            return;
        }
        const token = begin();
        const controller = new AbortController();
        pending = controller;
        void options.launch.restoreOffline(controller.signal).then(profile => {
            if (token !== view) return;
            if (!profile) { launchOnline(); return; }
            // Offline paint is intentional (#266): temporary unreachability keeps the remembered
            // route; identity/account/profile/PIN rejection clears it once reconcile can ask.
            handOff(profile);
            const generation = session.authorityGeneration;
            const signal = session.authoritySignal;
            const stillOwns = (): boolean => !destroyed && generation === session.authorityGeneration && !signal.aborted;
            const revoke = (): void => {
                if (stillOwns()) session.setProfile(undefined, "profile_proof_revoked");
            };
            const reconcile = (): void => { void session.http.verifyConnection(signal).then(() => server.profiles.list(signal)).then(async list => {
                if (!stillOwns()) return;
                const fresh = list.find(row => row.id === profile.id);
                if (!fresh || (fresh.hasPin && session.activeProfile?.token === undefined)) {
                    revoke();
                    return;
                }
                await session.call({ ...operations.listUserLibraries(), profileScoped: true, signal });
                if (!stillOwns()) return;
                current = fresh;
                onProfileUpdated?.(fresh);
            }).catch((error: unknown) => {
                if (!stillOwns()) return;
                if ((error instanceof ApiError && error.transient) || (error instanceof SessionError && error.reason === "unavailable")) {
                    cancelReconcile = clock.schedule(reconcile, 15000);
                    return;
                }
                if (error instanceof ApiError && error.aborted) return;
                revoke();
            }); };
            signal.addEventListener("abort", () => cancelReconcile?.(), { once: true });
            reconcile();
        }, () => { if (token === view) launchOnline(); });
    };
    if (options.launch === undefined) showList();
    else launch();
    return {
        signOut,
        switchProfile() {
            if (!destroyed && (host === undefined || session.activeProfile === undefined)) {
                if (session.activeProfile === undefined) current = undefined;
                showList(current?.id);
            }
        },
        destroy,
    };
}

function rethrow(clock: Clock, error: unknown): void {
    // Surface a programming error as uncaught without breaking the screens.
    clock.schedule(() => {
        throw error;
    }, 0);
}
