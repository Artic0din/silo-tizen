// The PIN screen for one profile, laid out like tvOS PINEntryView: avatar and name, four dots, a
// status line, a number pad and Cancel. The fourth digit submits. Everything updates in place, so
// focus stays on the key it was on while a check runs and after an answer.

import type { ProfileSummary } from "../contracts/v2/wire.ts";
import type { PinResult } from "../session/profiles.ts";
import { profileAvatar } from "./profilePicker.ts";
import { button, type Control, el, type Note, type Screen } from "./screen.ts";
import { waitText } from "./signInText.ts";

const PIN_LENGTH = 4;
const AVATAR_SIZE = 160;
const DEFAULT_STATUS = "Enter your PIN";
const CHECKING = "Checking the PIN.";
const LETTERS: Readonly<Record<number, string>> = { 2: "ABC", 3: "DEF", 4: "GHI", 5: "JKL", 6: "MNO", 7: "PQRS", 8: "TUV", 9: "WXYZ" };
const SVG_NS = "http://www.w3.org/2000/svg";
/** Samsung remotes deliver the number keys as key codes 48 to 57. */
const KEY_CODE_ZERO = 48;
const KEY_CODE_NINE = 57;

export interface PinScreen {
    readonly screen: Screen;
    /**
     * Ends a check: the entry clears, the dots turn red and the line shows why. A wrong PIN or a
     * lockout also shakes the dots (PINEntryView `errorCount`).
     */
    reject(line: string, shake: boolean): void;
}

/** `onComplete` gets the PIN once and the screen then waits for `reject` or for the app to leave it. */
export function pinScreen(profile: ProfileSummary, baseUrl: string, notes: readonly Note[], onComplete: (pin: string) => void, onBack: () => void): PinScreen {
    let digits = "";
    let verifying = false;
    let error: string | undefined;
    const intro = notes.map((note) => note.text).join(" ") || DEFAULT_STATUS;

    const avatar = profileAvatar(profile, baseUrl, AVATAR_SIZE);
    const header = el("div", "pin-header");
    header.append(avatar, el("h1", "pin-name", profile.name));
    const dots = Array.from({ length: PIN_LENGTH }, () => el("span", "pin-dot"));
    const dotRow = el("div", "pin-dots");
    dotRow.setAttribute("role", "img");
    dotRow.append(...dots);
    const status = el("div", "pin-status");
    status.setAttribute("role", "status");
    const pad = el("div", "pin-pad");

    const render = (): void => {
        const filled = verifying ? PIN_LENGTH : digits.length;
        const failed = error !== undefined && digits === "";
        dotRow.classList.toggle("pin-dots-error", failed);
        dots.forEach((dot, index) => dot.classList.toggle("pin-dot-filled", failed || index < filled));
        dotRow.setAttribute("aria-label", `${filled} of ${PIN_LENGTH} digits entered`);
        status.classList.toggle("pin-status-error", error !== undefined);
        if (error !== undefined) {
            status.textContent = error;
        } else if (verifying) {
            const spinner = el("span", "marquee-spinner");
            spinner.setAttribute("role", "img");
            spinner.setAttribute("aria-label", CHECKING);
            status.replaceChildren(spinner);
        } else {
            status.textContent = intro;
        }
    };

    const append = (digit: string): void => {
        if (verifying || digits.length >= PIN_LENGTH) {
            return;
        }
        digits += digit;
        if (digits.length < PIN_LENGTH) {
            render();
            return;
        }
        const pin = digits;
        digits = "";
        verifying = true;
        error = undefined;
        render();
        onComplete(pin);
    };
    const remove = (): void => {
        if (verifying || digits === "") {
            return;
        }
        digits = digits.slice(0, -1);
        render();
    };
    // On TV a disabled control loses focus, so Cancel stays enabled and waits for the answer instead.
    const cancel = (): void => {
        if (!verifying) {
            onBack();
        }
    };

    const controls: Control[] = [];
    const addKey = (key: string, row: number, column: number, label: string, content: readonly Node[], press: () => void): void => {
        const element = el("button", "pin-key");
        element.type = "button";
        element.setAttribute("data-focus", key);
        element.setAttribute("aria-label", label);
        element.append(...content);
        element.addEventListener("click", press);
        pad.appendChild(element);
        controls.push({ key, element, row, column });
    };
    const digitKey = (digit: number, row: number, column: number): void => {
        const content: Node[] = [el("span", "pin-key-digit", String(digit))];
        const letters = LETTERS[digit];
        if (letters !== undefined) {
            content.push(el("span", "pin-key-letters", letters));
        }
        addKey(String(digit), row, column, String(digit), content, () => append(String(digit)));
    };
    for (let digit = 1; digit <= 9; digit++) {
        digitKey(digit, Math.floor((digit - 1) / 3), (digit - 1) % 3);
    }
    const blank = el("span", "pin-key-blank");
    blank.setAttribute("aria-hidden", "true");
    pad.appendChild(blank);
    digitKey(0, 3, 1);
    addKey("delete", 3, 2, "Delete", [deleteIcon()], remove);

    const cancelButton = button("cancel", "Cancel", cancel);
    cancelButton.element.classList.add("pin-cancel");
    controls.push({ ...cancelButton, row: 4, column: 1 });

    const root = el("div", "pin-screen");
    root.append(header, dotRow, status, pad, cancelButton.element);
    root.addEventListener("keydown", (event) => {
        if (event.keyCode >= KEY_CODE_ZERO && event.keyCode <= KEY_CODE_NINE) {
            event.preventDefault();
            append(String(event.keyCode - KEY_CODE_ZERO));
        }
    });
    render();

    return {
        screen: {
            name: "pin",
            content: [root],
            controls,
            // Apple focuses the centre key so the pad's four neighbours are one move away.
            focus: "5",
            // onExitCommand: Back deletes a digit, and leaves only when none is left.
            back: () => (digits === "" ? cancel() : remove()),
        },
        reject(line, shake) {
            verifying = false;
            digits = "";
            error = line;
            render();
            if (shake) {
                dotRow.classList.remove("pin-dots-shake");
                void dotRow.offsetWidth;
                dotRow.classList.add("pin-dots-shake");
            }
        },
    };
}

/** SF Symbol `delete.backward`. */
function deleteIcon(): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "pin-key-delete");
    svg.setAttribute("viewBox", "0 0 38 30");
    svg.setAttribute("aria-hidden", "true");
    const outline = document.createElementNS(SVG_NS, "path");
    outline.setAttribute("d", "M12 2H34a3 3 0 0 1 3 3V25a3 3 0 0 1-3 3H12L1 15Z M19 11l8 8 M27 11l-8 8");
    svg.appendChild(outline);
    return svg;
}

export function pinProblem(result: Exclude<PinResult, { readonly status: "verified" }>): string {
    switch (result.status) {
        case "wrong_pin":
            return "Wrong PIN. Try again.";
        case "locked":
            return lockoutText(result.retryAfterSeconds);
        case "busy":
            return result.retryAfterSeconds === undefined
                ? "The server is busy. Wait a moment, then enter the PIN again."
                : `The server is busy. Wait ${waitText(result.retryAfterSeconds)}, then enter the PIN again.`;
        case "uncertain":
            return "No answer from the server. Check the TV's internet connection, then enter the PIN again.";
        case "enter_again":
            return "Enter the PIN again.";
        case "in_progress":
            return CHECKING;
        case "aborted":
        case "signed_out":
        case "failed":
            return "The PIN could not be checked. Try again.";
    }
}

/** ProfileTransitionError.pinLockedOut: whole minutes, rounded up, and "later" past a day. */
function lockoutText(seconds: number): string {
    if (!(seconds > 0 && seconds <= 86_400)) {
        return "Too many incorrect PINs. Try again later.";
    }
    const minutes = Math.ceil(seconds / 60);
    return `Too many incorrect PINs. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}
