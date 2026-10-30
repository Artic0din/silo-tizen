// Household profile screens: choose a profile, unlock it with its PIN, switch later, sign out.
// The session core owns profile authority (headers, PIN proof, aborting a replaced profile's
// requests); these screens show its states and hand the chosen profile to the caller.

import { type Clock, systemClock } from "../api/clock.ts";
import { ApiError } from "../api/errors.ts";
import type { ProfileSummary } from "../contracts/v2/wire.ts";
import type { ConnectedServer } from "../session/core.ts";
import { type AuthorityChange, type LogoutResult, SessionError } from "../session/session.ts";
import { pinProblem, pinScreen } from "./pinScreen.ts";
import { actions, button, type Control, el, type Note, type Screen, ScreenHost } from "./screen.ts";
import { logoutCollectedAccount } from "./signIn.ts";
import * as text from "./signInText.ts";

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
    readonly server: ConnectedServer;
    readonly clock?: Clock;
    /** A profile acts. The profile screens are gone; the caller owns the root until `signal` aborts. */
    readonly onSelected: (active: ProfileHandoff) => void;
    /** The account is signed out on this TV. The profile screens are gone; show sign-in, with the notice when given. */
    readonly onSignedOut: (notice: LogoutResult | undefined) => void;
}

export interface ProfileScreens {
    /** Shows the profiles over the caller's content; the current profile acts until another is chosen. */
    switchProfile(): void;
    destroy(): void;
}

const PER_ROW = 5;
const TITLE = "Who's watching?";
const PROOF_ENDED = "The PIN for this profile changed, or its unlock ended. Enter the PIN again.";

export function mountProfiles(root: HTMLElement, options: ProfileOptions): ProfileScreens {
    const { server, onSelected, onSignedOut } = options;
    const clock = options.clock ?? systemClock;
    const session = server.session;
    let host: ScreenHost | undefined;
    /** Increases whenever the screens move on; an answer for an older view is dropped. */
    let view = 0;
    let pending: AbortController | undefined;
    let current: ProfileSummary | undefined;
    let leaving = false;
    let destroyed = false;

    const show = (screen: Screen): void => {
        if (host === undefined) {
            root.classList.add("signin");
            host = new ScreenHost(root);
        }
        host.show(screen);
    };

    const release = (): void => {
        if (host !== undefined) {
            host.destroy();
            host = undefined;
            root.classList.remove("signin");
        }
    };

    /** Starts a new view: the previous one's request is abandoned and its answer ignored. */
    const begin = (): number => {
        pending?.abort();
        pending = undefined;
        return ++view;
    };

    const message = (name: string, title: string, lines: readonly string[], controls: readonly Control[], back?: () => void, tone: Note["tone"] = "info"): void => {
        const body = lines.map((line) => el("p", tone === "error" ? "signin-text signin-error" : "signin-text", line));
        if (tone === "error") {
            body[0]?.setAttribute("role", "alert");
        }
        show({ name, content: [el("h1", "signin-title", title), ...body, actions(controls)], controls, focus: controls[0]?.key ?? "", back });
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

    const signOutButton = (): Control => button("signout", "Sign out", signOut);

    const load = (then: (list: ProfileSummary[]) => void, focus?: string): void => {
        const token = begin();
        const controller = new AbortController();
        pending = controller;
        message("profiles-loading", TITLE, ["Loading profiles."], [signOutButton()], resume());
        server.profiles.list(controller.signal).then(
            (list) => {
                if (token === view) {
                    pending = undefined;
                    then(list);
                }
            },
            (error: unknown) => {
                if (token === view) {
                    pending = undefined;
                    listFailed(error, focus);
                }
            },
        );
    };

    const showList = (focus?: string): void => load((list) => picker(list, focus), focus);

    const picker = (list: readonly ProfileSummary[], focus?: string): void => {
        begin();
        if (list.length === 0) {
            const lines = ["This account has no profiles to choose from. Add one in Silo on the web, then try again."];
            message("profiles-empty", "No profiles", lines, [button("retry", "Try again", () => showList()), signOutButton()], resume());
            return;
        }
        const grid = el("div", "profile-grid");
        const controls: Control[] = list.map((profile, index) => {
            const tile = el("button", "profile-tile");
            tile.type = "button";
            tile.setAttribute("data-focus", `profile:${profile.id}`);
            tile.appendChild(el("span", "profile-initial", (Array.from(profile.name)[0] ?? "?").toUpperCase()));
            tile.appendChild(el("span", "profile-name", profile.name));
            if (profile.hasPin) {
                const lock = el("span", "profile-lock");
                lock.setAttribute("aria-hidden", "true");
                tile.setAttribute("aria-label", `${profile.name}, PIN protected`);
                tile.appendChild(lock);
            }
            tile.addEventListener("click", () => choose(profile));
            grid.appendChild(tile);
            return { key: `profile:${profile.id}`, element: tile, row: Math.floor(index / PER_ROW) };
        });
        const out = signOutButton();
        controls.push({ ...out, row: Math.ceil(list.length / PER_ROW) });
        const first = `profile:${focus ?? current?.id ?? list[0]?.id ?? ""}`;
        show({ name: "profiles", content: [el("h1", "signin-title", TITLE), grid, actions([out])], controls, focus: first, back: resume() });
    };

    const listFailed = (error: unknown, focus?: string): void => {
        if (error instanceof ApiError && error.problemId === "password_change_required") {
            passwordChange();
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
        const retry = button("retry", "Try again", () => showList(focus));
        message("profiles-error", "Profiles didn't load", [detail], [retry, signOutButton()], resume(), "error");
    };

    const choose = (profile: ProfileSummary): void => {
        if (server.profiles.select(profile).status === "selected") {
            handOff(profile);
        } else {
            askPin(profile, []);
        }
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
                    handOff(profile);
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

    /** The account can do nothing here until its password changes, which ends this session anyway. */
    const passwordChange = (): void => {
        begin();
        current = undefined;
        leaving = true;
        const logout = logoutCollectedAccount(server);
        const again = button("signin", "Sign in again", () => {
            void logout.then(leave, () => leave(undefined));
        });
        message("password", "Choose a new password", text.passwordChange(session.http.base.baseUrl), [again]);
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
                proofEnded();
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
        begin();
        unsubscribe();
        release();
    };

    showList();
    return {
        switchProfile() {
            if (!destroyed && host === undefined) {
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
