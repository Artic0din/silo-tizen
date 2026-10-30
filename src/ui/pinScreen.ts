// The PIN screen for one profile: the field, Unlock and a way back. The status line updates in
// place, so focus stays put while a check runs, and the PIN leaves the field as soon as it is read.

import type { ProfileSummary } from "../contracts/v2/wire.ts";
import type { PinResult } from "../session/profiles.ts";
import { actions, button, el, type Note, noteNodes, type Screen } from "./screen.ts";
import { waitText } from "./signInText.ts";

export interface PinScreen {
    readonly screen: Screen;
    /** The typed PIN; the field is emptied. */
    take(): string;
    say(line: string, tone: Note["tone"]): void;
    focusPin(): void;
}

export function pinScreen(profile: ProfileSummary, notes: readonly Note[], onUnlock: () => void, onBack: () => void): PinScreen {
    const input = el("input", "signin-input");
    input.id = "profile-pin";
    input.type = "password";
    input.autocomplete = "off";
    input.setAttribute("data-focus", "pin");
    const label = el("label", "signin-label", "PIN");
    label.htmlFor = input.id;
    const status = el("p", "signin-text signin-status");
    status.setAttribute("role", "status");
    const unlock = button("unlock", "Unlock", onUnlock);
    const other = button("other", "Choose another profile", onBack);
    return {
        screen: {
            name: "pin",
            content: [el("h1", "signin-title", profile.name), ...noteNodes(notes), label, input, status, actions([unlock, other])],
            controls: [{ key: "pin", element: input }, unlock, other],
            focus: "pin",
            back: onBack,
        },
        take() {
            const pin = input.value;
            input.value = "";
            return pin;
        },
        say(line, tone) {
            status.textContent = line;
            status.className = tone === "error" ? "signin-text signin-error" : "signin-text signin-status";
        },
        focusPin() {
            input.focus();
        },
    };
}

export function pinProblem(result: Exclude<PinResult, { readonly status: "verified" }>): string {
    switch (result.status) {
        case "wrong_pin":
            return "That PIN is not right. Try again.";
        case "locked":
            return `Too many wrong PINs. Try again in ${waitText(result.retryAfterSeconds)}.`;
        case "busy":
            return result.retryAfterSeconds === undefined
                ? "The server is busy. Wait a moment, then enter the PIN again."
                : `The server is busy. Wait ${waitText(result.retryAfterSeconds)}, then enter the PIN again.`;
        case "uncertain":
            return "No answer from the server. Check the TV's internet connection, then enter the PIN again.";
        case "enter_again":
            return "Enter the PIN again.";
        case "in_progress":
            return "Checking the PIN.";
        case "aborted":
        case "signed_out":
        case "failed":
            return "The PIN could not be checked. Try again.";
    }
}
