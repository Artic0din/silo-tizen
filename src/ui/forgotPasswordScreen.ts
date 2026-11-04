// "Forgot password?" (ForgotPasswordView). The server emails a link to its web reset screen;
// this TV cannot open that page. The person chooses the new password from the email, then signs
// in here. Offered only when the server's password-reset capability is `available`.

import { actionRow, errorText, field, headline, keyboardCard, lead, marqueeButton, marqueeScreen, textInput } from "./marquee.ts";
import { type Control, el, type Screen } from "./screen.ts";
import * as text from "./signInText.ts";

export interface ForgotPasswordView {
    readonly login: string;
    readonly phase: "editing" | "sending" | "sent" | "unavailable";
    readonly error: string | undefined;
    readonly onInput: (login: string) => void;
    readonly send: () => void;
    readonly done: () => void;
}

export function forgotPasswordScreen(view: ForgotPasswordView): Screen {
    if (view.phase === "sent") {
        return result(text.FORGOT_SENT_TITLE, text.forgotSentLead(view.login), text.FORGOT_SENT_NOTE, view.done);
    }
    if (view.phase === "unavailable") {
        return result(text.FORGOT_TITLE, text.FORGOT_UNAVAILABLE_LEAD, undefined, view.done);
    }
    const sending = view.phase === "sending";
    const login = textInput("signin-reset-login", "login", "Username or email", "Username or email", view.login);
    login.autocomplete = "username";
    login.readOnly = sending;
    login.addEventListener("input", () => view.onInput(login.value));
    if (view.error !== undefined) {
        login.setAttribute("aria-invalid", "true");
    }
    const send = marqueeButton("send", sending ? "Sending…" : "Send reset link", "primary", view.send, { loading: sending });
    const copy = [
        headline(text.FORGOT_TITLE),
        lead(text.FORGOT_LEAD),
        field(login, "person", view.error !== undefined),
        ...(view.error === undefined ? [] : [errorText(view.error)]),
        actionRow([send]),
    ];
    const controls: Control[] = [
        { key: "login", element: login, row: 0, done: "send" },
        { ...send, row: 1, landing: true },
    ];
    return {
        name: "forgot",
        content: marqueeScreen(copy, keyboardCard()),
        controls,
        focus: view.login === "" ? "login" : "send",
        back: sending ? () => undefined : view.done,
    };
}

function result(title: string, message: string, note: string | undefined, done: () => void): Screen {
    const back = marqueeButton("done", "Back to sign in", "primary", done);
    const copy = [headline(title), lead(message), ...(note === undefined ? [] : [el("p", "signin-hint", note)]), actionRow([back])];
    return {
        name: title === text.FORGOT_SENT_TITLE ? "forgot-sent" : "forgot-unavailable",
        content: marqueeScreen(copy, keyboardCard()),
        controls: [{ ...back, row: 0, landing: true }],
        focus: "done",
        back: done,
    };
}
