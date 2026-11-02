// The Apple TV app's "Sign in with a password" screen (TVLoginView.passwordScreen): the server card,
// headline, lead, username, password with show/hide, the error and the single sign-on hint, then
// Sign in, Use your phone instead and Change server; the keyboard card on the right. Rows: Down from
// a field reaches the next row, Right from the password reaches show/hide, and the TV keyboard's
// Done moves on as Down does.

import { actionRow, errorText, field, headline, keyboardCard, lead, marqueeButton, marqueeScreen, noteChips, serverCard, textInput } from "./marquee.ts";
import { type Control, el, type Note, type Screen } from "./screen.ts";
import * as text from "./signInText.ts";

export interface CredentialsView {
    /** The host until the server's branding name is read, as the Apple TV app falls back to. */
    readonly serverName: string;
    /** host[:port], for the server card. */
    readonly host: string;
    readonly secure: boolean;
    /** The server's resolved `mark_url`, when branding gave one. */
    readonly markUrl: string | undefined;
    readonly notes: readonly Note[];
    readonly passwordOnly: boolean;
    readonly hint: string | undefined;
    readonly username: string;
    readonly password: string;
    readonly shown: boolean;
    readonly error: string | undefined;
    /** Shake the fields: a sign-in was just refused. */
    readonly shake: boolean;
    readonly submitting: boolean;
    readonly onInput: (username: string, password: string) => void;
    readonly toggle: () => void;
    readonly submit: () => void;
    /** Undefined on a server without code sign-in: no phone route to point at. */
    readonly phone: (() => void) | undefined;
    readonly change: () => void;
    readonly back: () => void;
}

export interface CredentialsScreen extends Screen {
    usePasswordOnly(): void;
}

export function credentialsScreen(view: CredentialsView): CredentialsScreen {
    const username = textInput("signin-username", "username", "Username", "Username", view.username);
    username.autocomplete = "username";
    const password = textInput("signin-password", "secret", "Password", "Password", view.password);
    password.type = view.shown ? "text" : "password";
    password.autocomplete = "current-password";
    if (view.error !== undefined) {
        password.setAttribute("aria-invalid", "true");
    }
    const update = (): void => view.onInput(username.value, password.value);
    username.addEventListener("input", update);
    password.addEventListener("input", update);

    const toggle = marqueeButton("toggle", "", "glass", view.toggle, { glyph: view.shown ? "eyeSlash" : "eye" });
    toggle.element.classList.add("signin-toggle");
    toggle.element.setAttribute("aria-label", view.shown ? "Hide password" : "Show password");

    const passwordRow = el("div", "signin-password-row");
    passwordRow.appendChild(field(password, "lock", view.error !== undefined));
    passwordRow.appendChild(toggle.element);
    const fields = el("div", view.shake ? "signin-fields signin-shake" : "signin-fields");
    fields.appendChild(field(username, "person"));
    fields.appendChild(passwordRow);

    const lines: HTMLElement[] = [];
    if (view.error !== undefined) {
        lines.push(errorText(view.error));
    }
    // Shown with the error only when the error does not already say it.
    const hint = el("p", "signin-hint", view.hint ?? "");
    hint.hidden = view.hint === undefined || view.error?.includes(view.hint) === true;
    lines.push(hint);

    const signIn = marqueeButton("signin", view.submitting ? "Signing in…" : "Sign in", "primary", view.submit, { loading: view.submitting });
    const row: Control[] = [signIn];
    if (view.phone !== undefined) {
        row.push(marqueeButton("phone", "Use your phone instead", "plain", view.phone, { glyph: "qrcode" }));
    }
    row.push(marqueeButton("change", "Change server", "plain", view.change));
    // Nothing else may start, or leave, while a sign-in is in flight.
    for (const control of row.slice(1)) {
        control.element.toggleAttribute("disabled", view.submitting);
    }

    const controls: Control[] = [
        { key: "username", element: username, row: 0 },
        { key: "secret", element: password, row: 1 },
        { ...toggle, row: 1 },
        ...row.filter((control) => !control.element.hasAttribute("disabled")).map((control) => ({ ...control, row: 2, landing: control.key === "signin" })),
    ];
    const body = lead(text.passwordLead(view.serverName, view.passwordOnly));
    let back = view.back;
    const copy = [
        ...noteChips(view.notes),
        serverCard(view.serverName, view.host, view.secure, view.markUrl),
        headline(text.PASSWORD_TITLE),
        body,
        fields,
        ...lines,
        actionRow(row),
    ];
    return {
        name: "credentials", content: marqueeScreen(copy, keyboardCard()), controls, focus: "username", back: () => back(),
        usePasswordOnly: () => {
            body.textContent = text.passwordLead(view.serverName, true);
            hint.textContent = "";
            hint.hidden = true;
            back = view.submitting ? view.back : view.change;
            const phone = row.find(control => control.key === "phone");
            const focused = phone !== undefined && document.activeElement === phone.element;
            controls.splice(0, controls.length, ...controls.filter(control => control.key !== "phone"));
            phone?.element.remove();
            if (focused) {
                signIn.element.focus();
            }
        },
    };
}
