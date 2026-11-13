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
import { centredDialog } from "./confirmationDialog.ts";
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
    /** Switch Profile, or choosing the account already open. The picker stays up. */
    readonly pickerRequested?: boolean;
    /**
     * Choosing another account waits for a profile instead of restoring a remembered one.
     * A single profile without a PIN still opens (ChangeAccountModel.open path, 54cf0f34).
     */
    readonly skipRemembered?: boolean;
    /** The account's sign-in ended. The app routes it; these screens do not draw their own page. */
    readonly onSessionExpired?: () => void;
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
    /** Opens profile creation over the caller's content, from a fresh list; it ends on the profiles. */
    addProfile(): void;
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
    /** Profile list result or failure kept while the sign-out confirmation is open. */
    let heldProfileLoad: (() => void) | undefined;
    let confirmingSignOut = false;

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
        // The sign-out dialog covers whichever screen opened it, so that screen's layout stays.
        if (screen.name !== "profiles:signout") root.classList.toggle("profile-picker", screen.name === "profiles" || screen.name === "remember-profile");
        root.classList.toggle("profile-editor", screen.name === "profile-create");
        root.classList.toggle("profile-pin", screen.name === "pin");
        host.show(screen, focus);
    };

    const release = (): void => {
        if (host !== undefined) {
            host.destroy();
            host = undefined;
            root.classList.remove("signin");
            root.classList.remove("profiles-flow", "profile-picker", "profile-editor", "profile-pin");
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
        confirmingSignOut = false;
        heldProfileLoad = undefined;
        pending?.abort();
        pending = undefined;
        return ++view;
    };

    const message = (name: string, title: string, lines: readonly string[], controls: readonly Control[], back?: () => void, tone: Note["tone"] = "info", focus?: string): void => {
        // Only the first line is the error; any later line is ordinary copy.
        const body = lines.map((line, index) => el("p", tone === "error" && index === 0 ? "signin-text signin-error" : "signin-text", line));
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

    /** Apple's tvOS sign-out confirmation. Cancel stays focused; Back cancels and returns to Sign out. A profile list that arrives while this is open waits, replays on Cancel or Back, and is dropped on Sign Out. */
    const askSignOut = (restore: () => void): void => {
        if (leaving || destroyed) return;
        confirmingSignOut = true;
        const dismiss = (): void => {
            confirmingSignOut = false;
            const replay = heldProfileLoad;
            heldProfileLoad = undefined;
            if (replay !== undefined) replay();
            else restore();
        };
        const removesServer = signOutRemovesServer(() => server.accounts.directory.list(), server.server.http.base.baseUrl);
        const copy = signOutConfirmationCopy(session.account?.username, options.serverName?.(), removesServer);
        const cancel = button("cancel-signout", "Cancel", dismiss);
        const accept = button("confirm-signout", "Sign Out", () => {
            confirmingSignOut = false;
            heldProfileLoad = undefined;
            signOut();
        });
        // AccountRemovalConfirmation on tvOS: TVSettingsConfirmationOverlay over the screen, Cancel then Sign Out, Cancel focused.
        show({
            name: "profiles:signout",
            content: centredDialog({ style: "confirmation", id: "profiles-signout", title: copy.title, message: copy.message,
                buttons: [cancel.element, accept.element], destructive: accept.element, behind: screenBehind() }),
            controls: [{ ...cancel, row: 0, column: 0 }, { ...accept, row: 0, column: 1 }],
            focus: "cancel-signout",
            back: dismiss,
        });
    };

    /** A launch result that lands while Sign out is being confirmed waits behind the dialog. */
    const hold = (token: number, apply: () => void): void => {
        if (token !== view) return;
        if (confirmingSignOut) {
            pending = undefined;
            heldProfileLoad = apply;
            return;
        }
        apply();
    };

    const signOutButton = (restore: () => void): Control => button("signout", "Sign out", () => askSignOut(restore));

    // `retry` re-runs whatever started this load, so a failed launch load retries through launch.
    const load = (then: (list: ProfileSummary[]) => void, retry: () => void, restoreRememberedOffline = false): void => {
        const token = begin();
        const controller = new AbortController();
        pending = controller;
        const showLoading = (): void => message("profiles-loading", TITLE, ["Loading profiles."], [signOutButton(showLoading)], resume(), "info", "signout");
        showLoading();
        const deliver = (apply: () => void): void => hold(token, apply);
        server.profiles.list(controller.signal).then(
            (list) => deliver(() => {
                if (token !== view) return;
                pending = undefined;
                const id = server.accounts.localAccountId;
                if (id) {
                    try { server.accounts.directory.update(id, { profileCount: list.length }); }
                    catch { /* The count is a display cache; the profile response remains usable. */ }
                }
                then(list);
            }),
            (error: unknown) => deliver(() => {
                if (token !== view) return;
                pending = undefined;
                // Launch may reopen a remembered profile offline. Switch Profile asked for the list.
                if (error instanceof ApiError && ["network", "timeout"].includes(error.failure.kind) && restoreRememberedOffline && options.launch?.remembered) {
                    const restore = new AbortController();
                    pending = restore;
                    void options.launch.restoreOffline(restore.signal).then(profile => hold(token, () => {
                        pending = undefined;
                        if (profile) handOff(profile);
                        else listFailed(error, retry);
                    }), failure => hold(token, () => { pending = undefined; listFailed(failure, retry); }));
                } else listFailed(error, retry);
            }),
        );
    };

    /** The picker's last list, drawn dimmed and inert behind an alert, as tvOS keeps Who's watching under `.alert`. */
    let shownList: readonly ProfileSummary[] | undefined;
    const pickerBehind = (): readonly HTMLElement[] => {
        if (shownList === undefined) return [];
        const inert = (): void => undefined;
        return profilePickerScreen({ profiles: shownList, baseUrl: server.server.http.base.baseUrl, accountName: session.account?.username,
            rememberedId: options.launch?.rememberedProfileId, focus: "", choose: inert, add: inert, changeServer: inert, signOut: inert, back: undefined }).content;
    };
    /** A copy of the screen on display, for a dialog to cover. */
    const screenBehind = (): HTMLElement[] => {
        const screen = Array.from(root.querySelectorAll<HTMLElement>("[data-screen]")).pop();
        return screen === undefined ? [] : Array.from(screen.children).filter((node): node is HTMLElement => node instanceof HTMLElement).map(node => node.cloneNode(true) as HTMLElement);
    };

    const showList = (focus?: string): void => load((list) => picker(list, focus), () => showList(focus));

    const showPicker = (list: readonly ProfileSummary[], focus?: string): void => {
        shownList = list;
        const preferred = focus ?? current?.id ?? options.launch?.rememberedProfileId ?? list[0]?.id;
        const focusKey = preferred === "signout" || preferred === "add-profile" || preferred === undefined ? (preferred ?? "add-profile") : `profile:${preferred}`;
        show(profilePickerScreen({ profiles: list, baseUrl: server.server.http.base.baseUrl,
            accountName: session.account?.username, rememberedId: options.launch?.rememberedProfileId,
            focus: focusKey,
            choose, changeServer: options.onChangeServer, signOut: () => askSignOut(() => showPicker(list, "signout")), back: resume(), add: () => createProfile(list),
        }));
    };

    const createProfile = (list: readonly ProfileSummary[]): void => {
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
    };

    // AppRouter.beginAddProfile (silo-apple 5780c84 `Navigation/AppRouter+Accounts.swift:220-245`): a fresh list, so a PIN
    // set on another device is asked for.
    const addProfile = (): void => load(list => { shownList = list; createProfile(list); }, addProfile);

    const picker = (list: readonly ProfileSummary[], focus?: string): void => {
        begin();
        showPicker(list, focus);
    };

    const listFailed = (error: unknown, retryLoad: () => void): void => {
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
            const retry = button("retry", "Try again", retryLoad);
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
        // ProfileSelectionView's tvOS remember offer (`.alert`), over the dimmed picker, with "this Apple TV" read as "this TV".
        // Ask Every Time is the cancel button, drawn first; focus starts on Remember. While the offer is pending, Back answers
        // Ask Every Time, as Menu runs the cancel button. Saving can fail on the TV, so the offer then also says why and can
        // continue unsaved; a failed silent re-save for an existing choice keeps that choice when Back leaves.
        const pendingOffer = launch.needsOffer;
        const offer = (error = false): void => {
            begin();
            const name = profile.name.trim();
            const ask = button("ask-every-launch", "Ask Every Time", () => save(false));
            const remember = button("remember", "Remember", () => save(true));
            const controls: Control[] = [{ ...ask, row: 0, column: 0 }, { ...remember, row: 0, column: 1 }];
            if (error) controls.push({ ...button("continue-session", "Continue without saving", () => { launch.continueWithoutSaving(); handOff(profile); }), row: 1, column: 0 });
            const content = centredDialog({ style: "alert", id: "remember-offer", title: name === "" ? "Open this profile automatically?" : `Open ${name} automatically?`,
                ...(error ? { problem: "Silo couldn't securely remember this profile. Please try again." } : {}),
                message: "Silo can skip Who's Watching and open this profile when it starts on this TV. You can change this later in Settings > General > Profile Selection.",
                buttons: controls.map(control => control.element), behind: pickerBehind() });
            show({ name: "remember-profile", content, controls, focus: "remember",
                back: pendingOffer ? () => save(false) : () => showList(profile.id) });
        };
        const save = (remember: boolean): void => {
            const token = begin();
            const controller = new AbortController();
            pending = controller;
            message("remember-saving", "Saving launch choice", [], [button("back", "Back", () => showList(profile.id))], () => showList(profile.id));
            launch.setRemember(remember, controller.signal, profile).then(() => { if (token === view) handOff(profile); }, () => { if (token === view) offer(true); });
        };
        if (pendingOffer) offer();
        else save(true);
    };

    const askPin = (profile: ProfileSummary, notes: readonly Note[]): void => {
        const token = begin();
        const check = (pin: string): void => {
            const controller = new AbortController();
            pending = controller;
            server.profiles.verifyPin(profile.id, pin, controller.signal).then((result) => {
                if (token !== view) {
                    return;
                }
                pending = undefined;
                if (result.status === "verified") {
                    selected(profile);
                } else if (result.status === "signed_out" && !session.signedIn) {
                    expired();
                } else {
                    screen.reject(pinProblem(result), result.status === "wrong_pin" || result.status === "locked");
                }
            }, (error: unknown) => {
                if (token === view) {
                    pending = undefined;
                    screen.reject(pinProblem({ status: "failed" }), false);
                }
                rethrow(clock, error);
            });
        };
        const screen = pinScreen(profile, server.server.http.base.baseUrl, notes, check, () => showList(profile.id));
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
            change.element.prepend(navigationIcon("switch-profile"));
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
        }, () => showList());
    };

    const onChange = (change: AuthorityChange): void => {
        if (destroyed) {
            return;
        }
        switch (change.reason) {
            case "session_expired":
                if (options.onSessionExpired === undefined) {
                    expired();
                    return;
                }
                // Answers still in flight must not repaint or hand off while the app routes the expiry.
                begin();
                current = undefined;
                options.onSessionExpired();
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
            default: {
                const exhaustive: never = change.reason;
                return exhaustive;
            }
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

    // ProfileSelectionView.openOnlyProfileIfNeeded / skipPickerIfSingleProfile (54cf0f34:207-218).
    // Switch Profile sets pickerRequested, so its picker stays. A PIN still has to be entered.
    const onlyUnprotected = (list: readonly ProfileSummary[]): ProfileSummary | undefined =>
        options.pickerRequested || list.length !== 1 || list[0] === undefined || list[0].hasPin ? undefined : list[0];
    const launchOnline = (): void => load(list => {
        const only = onlyUnprotected(list);
        if (only !== undefined) { choose(only); return; }
        if (options.pickerRequested || options.skipRemembered) { picker(list); return; }
        const token = view;
        const controller = new AbortController();
        pending = controller;
        restoring = true;
        options.launch?.restore(list, controller.signal).then(profile => hold(token, () => {
            restoring = false;
            pending = undefined;
            if (profile === undefined) picker(list);
            else handOff(profile);
        }), error => hold(token, () => {
            restoring = false;
            pending = undefined;
            if (error instanceof SessionError && error.reason !== "unavailable") { expired(); return; }
            const showLaunchError = (focused = "retry"): void => message("profile-launch-error", "Remembered profile didn't open", ["Could not verify the remembered profile. Try again or choose who's watching."], [button("retry", "Retry", launchOnline), button("back", "Choose profile", () => picker(list)), signOutButton(() => showLaunchError("signout"))], () => picker(list), "error", focused);
            showLaunchError();
        }));
    }, launchOnline, !options.pickerRequested && !options.skipRemembered);
    const launch = (): void => {
        if (options.skipRemembered || !server.localRestore || options.pickerRequested || !options.launch?.remembered || options.launch.requiresSelection()) {
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
        addProfile() {
            if (!destroyed && host === undefined && session.activeProfile !== undefined) addProfile();
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
