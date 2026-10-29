// The code screen: QR code, the address and grouped code to type instead, approval status and
// a countdown. It is built once per code and updated in place, so focus and the QR code stay put
// while polls report progress.

import type { Clock } from "../api/clock.ts";
import type { DeviceLoginState } from "../session/deviceLogin.ts";
import { qrCode } from "./qr.ts";
import { actions, type Control, el, type Note, noteNodes, type Screen } from "./screen.ts";
import { remaining, waitingStatus } from "./signInText.ts";

type Waiting = Extract<DeviceLoginState, { readonly phase: "waiting" }>;

export interface CodeScreen {
    readonly userCode: string;
    readonly screen: Screen;
    update(state: Waiting): void;
    stop(): void;
}

export function codeScreen(first: Waiting, notes: readonly Note[], clock: Clock, change: Control): CodeScreen {
    const code = first.code;
    const status = el("p", "signin-text signin-status");
    status.setAttribute("role", "status");
    // Outside the live region: a screen reader should not read every second.
    const countdown = el("p", "signin-text signin-countdown");
    const codeText = el("p", "signin-code", code.userCode);
    codeText.setAttribute("aria-label", `Code ${code.userCode.split("").join(" ")}`);

    const qrBox = el("div", "signin-qr-box");
    qrBox.appendChild(qrCode(code.verificationUriComplete, "QR code that opens the sign-in page with this code"));
    const info = el("div", "signin-code-info");
    for (const node of [
        el("p", "signin-text", "Scan the QR code with your phone, or go to"),
        el("p", "signin-uri", code.verificationUri),
        el("p", "signin-text", "and enter this code:"),
        codeText,
        status,
        countdown,
        ...noteNodes(notes),
        actions([change]),
    ]) {
        info.appendChild(node);
    }
    const layout = el("div", "signin-code-layout");
    layout.appendChild(qrBox);
    layout.appendChild(info);

    let expiresAt = code.expiresAt;
    let cancelTick: (() => void) | undefined;
    const tick = (): void => {
        const left = expiresAt - clock.now();
        countdown.textContent = remaining(left);
        cancelTick = left > 0 ? clock.schedule(tick, (left % 1000) || 1000) : undefined;
    };

    return {
        userCode: code.userCode,
        screen: { name: "code", content: [el("h1", "signin-title", "Sign in"), layout], controls: [change], focus: change.key, back: () => change.element.click() },
        update(state) {
            status.textContent = waitingStatus(state);
            // An approver opening the code extends it; restart the countdown from the new deadline.
            if (state.code.expiresAt !== expiresAt || cancelTick === undefined) {
                expiresAt = state.code.expiresAt;
                cancelTick?.();
                tick();
            }
        },
        stop() {
            cancelTick?.();
            cancelTick = undefined;
        },
    };
}
