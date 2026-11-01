// What the sign-in screens say for each outcome of the session core. Kept apart from the
// controller so every state's wording is in one place.

import type { ApiError } from "../api/errors.ts";
import type { ServerUrlProblem } from "../api/serverUrl.ts";
import type { ConnectResult } from "../session/core.ts";
import type { VaultClear } from "../session/credentialVault.ts";
import type { DeviceLoginState } from "../session/deviceLogin.ts";
import type { LogoutResult, RestoreResult } from "../session/session.ts";

export function connectProblem(result: Exclude<ConnectResult, { readonly status: "connected" }>): string {
    switch (result.status) {
        case "invalid_url":
            return urlProblem(result.problem);
        case "unreachable":
            // ServerSetupViewModel's words once every address tried has failed.
            return "Could not reach a Silo server at that address.";
        case "not_silo_v2":
            return "This server can't be used with this app. It needs a Silo server with the version 2 API.";
        case "origin_mismatch":
            return "The server answered from a different address than the one entered. Check the address.";
        case "server_error":
            return "The server had a problem. Try again in a moment.";
    }
}

function urlProblem(problem: ServerUrlProblem): string {
    switch (problem) {
        // ServerSetupValidationError's missingHost and invalidHost, word for word.
        case "empty":
            return "Please enter a server host.";
        case "invalid":
            return "Please enter a valid server host.";
        case "unsupported_scheme":
            return "Use an address that starts with https:// or http://.";
        case "has_credentials":
            return "Remove the user name and password from the address.";
        case "has_query_or_fragment":
            return "Remove everything from ? or # onwards in the address.";
        case "has_api_path":
            return "Enter the server address without /api at the end.";
    }
}

// The Apple TV app's question before anything is sent over plain HTTP, word for word.
export const CLEARTEXT_TITLE = "Connect without encryption?";

export function cleartextWarning(host: string): string {
    return `Your password and what you watch will be sent unencrypted to ${host}. Only do this on a network you trust.`;
}

export const CLEARTEXT_DECLINED = "Could not reach a Silo server at that address over HTTPS.";

export function forgetResult(result: VaultClear): string {
    return result === "failed"
        ? "This TV could not remove the saved sign-in. Try again."
        : "Removed this server's saved sign-in from this TV.";
}

export function restoreNotice(restore: RestoreResult): string | undefined {
    switch (restore) {
        case "storage_corrupt":
            return "The sign-in saved on this TV could not be read, so it was removed. Sign in again.";
        case "storage_unavailable":
            return "This TV could not read its saved sign-in. Sign in again.";
        default:
            return undefined;
    }
}

export const PREVIOUS_SESSION_KEPT =
    "This TV could not remove the sign-in it saved before. If that account appears after the app restarts, sign out of it.";

export const SESSION_ONLY = "This TV can't store your sign-in securely, so you will need to sign in again after the app closes.";

export function signedOutNotice(result: LogoutResult): string[] {
    const lines = ["Signed out on this TV."];
    if (result.server === "unreachable") {
        lines.push("The server could not be reached, so it may still list this TV's session.");
    }
    if (result.storage === "failed") {
        lines.push(PREVIOUS_SESSION_KEPT);
    }
    return lines;
}

// The Apple TV app's code-screen copy (TVSignInPresentation, TVLoginView), with "this TV" for its
// platform noun.

/**
 * `<host>/activate` as people type it: the verification address (or the QR link without its
 * query when that is blank) with no trailing slash. Only https:// is dropped; browsers try https
 * for a bare host, so a plain-HTTP server keeps its scheme on screen.
 */
export function typedUrl(verificationUri: string, verificationUriComplete: string): string {
    let text = verificationUri.trim();
    if (text === "") {
        text = verificationUriComplete.split("?")[0]?.trim() ?? "";
    }
    text = text.replace(/\/+$/, "");
    return /^https:\/\//i.test(text) ? text.slice("https://".length) : text;
}

/** The host people recognise for a server, port included so two servers on one machine stay apart. */
export function serverHost(serverUrl: string): string {
    const text = serverUrl.trim();
    const scheme = text.indexOf("://");
    const rest = scheme === -1 ? text : text.slice(scheme + 3);
    return rest.split(/[/?]/)[0] ?? rest;
}

export function codeLead(typed: string | undefined): string {
    return `Scan the code with your phone's camera, or go to ${typed ?? "your server's /activate page"} and enter it. Approve on your phone and this TV signs in by itself.`;
}

/**
 * What the code screen shows: QRLoginViewModel.Status, for this TV. Device-login phases map onto it
 * in the sign-in controller, which also owns renewal, start retries and the failure grace periods.
 */
export type CodeStatus =
    | { readonly kind: "getting_code" }
    | { readonly kind: "waiting"; readonly renewed: boolean }
    | { readonly kind: "opened" }
    | { readonly kind: "unreachable" }
    | { readonly kind: "rate_limited" }
    | { readonly kind: "approved"; readonly account: string | undefined }
    | { readonly kind: "could_not_finish" }
    | { readonly kind: "denied" }
    | { readonly kind: "paused" }
    | { readonly kind: "failed"; readonly message: string };

/** States left only by a person's action. */
export function isTerminal(status: CodeStatus): boolean {
    return !["getting_code", "waiting", "opened", "unreachable", "rate_limited"].includes(status.kind);
}

/** The status line under the code (a polite live region). */
export function statusLine(status: CodeStatus, host: string): string {
    switch (status.kind) {
        case "getting_code":
            return "Getting a sign-in code…";
        case "waiting":
            return status.renewed ? "New code. Waiting for approval." : "Waiting for approval";
        case "opened":
            return "Continue on your phone";
        case "approved":
            return status.account === undefined ? "Signed in" : `Signed in as ${status.account}`;
        case "could_not_finish":
            return "Couldn't finish signing in on this TV.";
        case "denied":
            return "Sign-in was declined on your phone.";
        case "paused":
            return "Sign-in paused.";
        case "unreachable":
            return `Can't reach ${host}. Check this TV's connection.`;
        case "rate_limited":
            return "Too many sign-in attempts. Trying again shortly.";
        case "failed":
            return status.message;
    }
}

/** The one action beside a state, when it has one. */
export function stateAction(status: CodeStatus): "Try again" | "Show a new code" | undefined {
    switch (status.kind) {
        case "could_not_finish":
        case "unreachable":
        case "rate_limited":
        case "failed":
            return "Try again";
        case "denied":
        case "paused":
            return "Show a new code";
        default:
            return undefined;
    }
}

/** States that end the attempt take focus to their action; retrying in the background does not. */
export function actionTakesFocus(status: CodeStatus): boolean {
    return ["could_not_finish", "denied", "paused", "failed"].includes(status.kind);
}

/** A device-login failure this TV can't retry by itself, worded as before. */
export function failedMessage(state: Extract<DeviceLoginState, { readonly phase: "failed" }>): string {
    return failure(state);
}

// The card beside the address and password forms. The Apple TV app points at the keyboard
// notification on nearby iPhones; this TV offers its own on-screen keyboard and, per Samsung's
// 2023 TV e-Manual, USB and Bluetooth keyboards.
export const KEYBOARD_TITLE = "Type with a keyboard";
export const KEYBOARD_TEXT = "When you select a field, this TV's on-screen keyboard opens. You can also type on a USB or Bluetooth keyboard connected to the TV.";

// The Apple TV manual entry (TVServerSetupView.manualEntry).
export const ENTRY_TITLE = "Enter your\nserver address";
export const ENTRY_LEAD = "Type the address you use for Silo.";
export const INVALID_PORT = "Port must be a number between 1 and 65535.";

function failure(state: Extract<DeviceLoginState, { readonly phase: "failed" }>): string {
    switch (state.reason) {
        case "unreachable":
            return "Could not reach the server. Check the TV's internet connection, then try again.";
        case "rate_limited": {
            const wait = state.retryAfterSeconds;
            return wait === undefined
                ? "Too many sign-in attempts. Wait a minute, then try again."
                : `Too many sign-in attempts. Wait ${waitText(wait)}, then try again.`;
        }
        case "server_error":
            return "The server had a problem. Try again in a moment.";
        case "unexpected_response":
            return "The server sent an answer this app does not understand. Check that the server and this app are up to date.";
        case "temporary_session_refused":
            return "The server offered a temporary session, which this TV does not use. Try again.";
    }
}

export function waitText(seconds: number): string {
    if (seconds <= 1) {
        return "1 second";
    }
    if (seconds < 90) {
        return `${seconds} seconds`;
    }
    return `${Math.ceil(seconds / 60)} minutes`;
}

export function passwordChange(baseUrl: string): string[] {
    return [
        "An administrator set a temporary password for this account. This TV can't use the account until it has a new password.",
        `In a web browser, open ${baseUrl}, sign in and choose a new password. Then get a new code here.`,
    ];
}

// The Apple TV app's password screen (TVLoginView, LoginViewModel), word for word.
export const PASSWORD_TITLE = "Sign in with\na password";
export const ENTER_USERNAME = "Please enter your username.";
export const ENTER_PASSWORD = "Please enter your password.";

/** `serverName` is the host (and port) until the server's branding name is read. */
export function passwordLead(serverName: string, passwordOnly: boolean): string {
    return passwordOnly ? "This server only supports password sign-in." : `Use your ${serverName} username and password.`;
}

/** Single sign-on accounts have no Silo password; one provider is named, several read as single sign-on. */
export function phoneHint(oauthProviders: readonly string[]): string | undefined {
    const first = oauthProviders[0];
    if (first === undefined) {
        return undefined;
    }
    return `If you sign in with ${oauthProviders.length === 1 ? providerName(first) : "single sign-on"}, use your phone instead.`;
}

function providerName(displayName: string): string {
    const name = displayName.trim();
    for (const prefix of ["sign in with ", "log in with ", "login with ", "continue with "]) {
        const rest = name.toLowerCase().startsWith(prefix) ? name.slice(prefix.length).trim() : "";
        if (rest !== "") {
            return rest;
        }
    }
    return name === "" ? "single sign-on" : name;
}

const REFUSALS: Readonly<Record<string, string>> = {
    not_permitted: "Your account at the sign-in provider isn't allowed to use this server.",
    email_in_use: "An account with this email already exists. Ask an admin to connect it to the sign-in provider.",
    identity_linked_elsewhere: "That provider account is already connected to another account.",
    provider_unavailable: "The sign-in provider can't be reached right now. Try again later.",
    password_expired: "Your directory password has expired. Change it with your organization, then try again.",
    account_required: "You don't have an account on this server yet. Ask an admin to add you.",
};

/**
 * A refused password sign-in. Only a problem document blames the credentials: a bare 401 or 403
 * comes from something in front of the server. `hint` follows a wrong password.
 */
export function passwordProblem(error: ApiError, hint: string | undefined, phoneRoute: boolean): string {
    const id = error.problemId;
    if (id === "local_login_disabled") {
        const off = "Password sign-in is turned off on this server.";
        return phoneRoute ? `${off} Use your phone instead.` : off;
    }
    const refusal = id === undefined ? undefined : REFUSALS[id];
    if (refusal !== undefined) {
        return refusal;
    }
    const status = error.status;
    if (status === 429) {
        return "Too many sign-in attempts. Wait a moment, then try again.";
    }
    if (id !== undefined && status === 401) {
        const wrong = "Incorrect username or password.";
        return hint === undefined ? wrong : `${wrong} ${hint}`;
    }
    if (id !== undefined && status === 403) {
        return "This account can't sign in. Contact your server administrator.";
    }
    if (id !== undefined && (status === 400 || status === 422)) {
        return "Check your username and password, then try again.";
    }
    // Where the Apple TV app shows the system's description of the failure.
    const kind = error.failure.kind;
    if (kind === "network" || kind === "timeout") {
        return failure({ phase: "failed", reason: "unreachable", retryAfterSeconds: undefined });
    }
    if (kind === "invalid_response") {
        return failure({ phase: "failed", reason: "unexpected_response", retryAfterSeconds: undefined });
    }
    return failure({ phase: "failed", reason: "server_error", retryAfterSeconds: undefined });
}
