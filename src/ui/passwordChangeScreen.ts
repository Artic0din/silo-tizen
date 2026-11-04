// "Choose a new password" after a temporary password (PasswordChangeView). The session stays
// signed in: this is the only thing it can do. Apple TV shows a refusal instead, because three
// passwords are a lot to type with a remote; this TV collects them with the same fields as its
// password screen. The whole group outlines on an error, as MarqueeFieldGroup does.

import { actionRow, errorText, field, headline, keyboardCard, lead, marqueeButton, marqueeScreen, textInput } from "./marquee.ts";
import { type Control, el, type Screen } from "./screen.ts";
import * as text from "./signInText.ts";

export interface PasswordChangeFormView {
    readonly accountName: string | undefined;
    readonly minimumLength: number;
    readonly current: string;
    readonly next: string;
    readonly confirmation: string;
    readonly error: string | undefined;
    readonly shake: boolean;
    readonly busy: boolean;
    readonly notes: readonly string[];
    readonly onInput: (current: string, next: string, confirmation: string) => void;
    readonly save: () => void;
    readonly signOut: () => void;
}

export function passwordChangeForm(view: PasswordChangeFormView): Screen {
    const current = secretField("signin-current-password", "current", "Temporary password", view.current, view.busy);
    const next = secretField("signin-new-password", "new", "New password", view.next, view.busy);
    const confirmation = secretField("signin-confirm-password", "confirm", "Confirm new password", view.confirmation, view.busy);
    const update = (): void => view.onInput(current.value, next.value, confirmation.value);
    for (const input of [current, next, confirmation]) {
        input.addEventListener("input", update);
        if (view.error !== undefined) {
            input.setAttribute("aria-invalid", "true");
        }
    }
    const fields = el("div", view.shake ? "signin-fields signin-change signin-shake" : "signin-fields signin-change");
    const outlined = view.error !== undefined;
    fields.append(field(current, "key", outlined), field(next, "lock", outlined), field(confirmation, "lock", outlined));

    const save = marqueeButton("save", view.busy ? "Saving…" : "Save password", "primary", view.save, { loading: view.busy });
    const signOut = marqueeButton("signout", "Sign out", "plain", view.signOut);
    signOut.element.toggleAttribute("disabled", view.busy);
    const actions = view.busy ? [save] : [save, signOut];
    const copy = [
        headline(text.PASSWORD_CHANGE_TITLE),
        lead(text.passwordChangeLead(view.accountName)),
        ...view.notes.map((line) => lead(line)),
        fields,
        el("p", "signin-hint", text.passwordRequirementsHint(view.minimumLength)),
        ...(view.error === undefined ? [] : [errorText(view.error)]),
        actionRow(actions),
    ];
    const controls: Control[] = [
        { key: "current", element: current, row: 0, done: "new" },
        { key: "new", element: next, row: 1, done: "confirm" },
        { key: "confirm", element: confirmation, row: 2, done: "save" },
        { ...save, row: 3, landing: true },
        ...(view.busy ? [] : [{ ...signOut, row: 3 }]),
    ];
    return {
        name: "password",
        content: marqueeScreen(copy, keyboardCard()),
        controls,
        focus: "current",
        back: view.busy ? () => undefined : view.signOut,
    };
}

export function passwordChangeNotice(
    name: string,
    title: string,
    message: string,
    primaryLabel: string,
    primaryBusy: boolean,
    onPrimary: () => void,
    onSignOut: () => void,
): Screen {
    const primary = marqueeButton("retry", primaryBusy ? "Trying again…" : primaryLabel, "primary", onPrimary, { loading: primaryBusy });
    const signOut = marqueeButton("signout", "Sign out", "plain", onSignOut);
    signOut.element.toggleAttribute("disabled", primaryBusy);
    const controls = primaryBusy ? [primary] : [primary, signOut];
    return {
        name,
        content: marqueeScreen([headline(title), lead(message), actionRow(controls)]),
        controls: controls.map((control, index) => ({ ...control, row: 0, ...(index === 0 ? { landing: true } : {}) })),
        focus: "retry",
        back: primaryBusy ? () => undefined : onSignOut,
    };
}

function secretField(id: string, key: string, label: string, value: string, busy: boolean): HTMLInputElement {
    const input = textInput(id, key, label, label, value);
    input.type = "password";
    input.autocomplete = key === "current" ? "current-password" : "new-password";
    input.readOnly = busy;
    return input;
}
