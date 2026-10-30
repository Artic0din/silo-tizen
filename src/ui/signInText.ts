// What the sign-in screens say for each outcome of the session core. Kept apart from the
// controller so every state's wording is in one place.

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
            return "Could not reach the server. Check the address and the TV's internet connection, then try again.";
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
        case "empty":
            return "Enter your server address.";
        case "invalid":
            return "That is not a valid server address. Check it and try again.";
        case "not_https":
            return "Use an address that starts with https://. This app signs in only over HTTPS.";
        case "has_credentials":
            return "Remove the user name and password from the address.";
        case "has_query_or_fragment":
            return "Remove everything from ? or # onwards in the address.";
        case "has_api_path":
            return "Enter the server address without /api at the end.";
    }
}

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

export function waitingStatus(state: Extract<DeviceLoginState, { readonly phase: "waiting" }>): string {
    if (state.retrying === "unreachable") {
        return "Lost contact with the server. Still trying.";
    }
    if (state.retrying === "rate_limited") {
        return "The server asked this TV to check less often. Still waiting.";
    }
    return state.opened ? "Code opened. Finish signing in on your phone or computer." : "Waiting for you to approve the code.";
}

export function remaining(ms: number): string {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    const rest = seconds % 60;
    return `Code expires in ${Math.floor(seconds / 60)}:${rest < 10 ? "0" : ""}${rest}`;
}

type EndedPhase = Exclude<DeviceLoginState["phase"], "idle" | "starting" | "waiting" | "signed_in">;

export interface Ended {
    readonly title: string;
    readonly detail: string;
    /** Whether the way forward is a new code ("Get a new code") rather than the same request again. */
    readonly newCode: boolean;
}

export function ended(state: Extract<DeviceLoginState, { readonly phase: EndedPhase }>): Ended {
    switch (state.phase) {
        case "denied":
            return { title: "Sign-in declined", detail: "The code was declined on the approving device.", newCode: true };
        case "expired":
            return { title: "Code expired", detail: "The code was not approved in time.", newCode: true };
        case "canceled":
            return { title: "Sign-in canceled", detail: "This code can no longer be used.", newCode: true };
        case "consumed":
            return {
                title: "Sign-in not received",
                detail: "The code was approved, but this TV lost the answer. Get a new code and approve it again.",
                newCode: true,
            };
        case "unavailable":
            return {
                title: "Code sign-in is off",
                detail: "This server does not offer sign-in with a code. Ask its administrator to turn on device sign-in.",
                newCode: false,
            };
        case "failed":
            return { title: "Sign-in stopped", detail: failure(state), newCode: false };
    }
}

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
