// The Apple TV app's code screen (TVLoginView.codeScreen): the server card, "Sign in to <server>"
// and how to sign in on the left; the QR code, the code, where to type it and the status in the card
// on the right. Without a code the card shows a spinner, or the symbol of a state that ended.
// Status changes for the same code update the screen in place, so focus and the QR code stay put.

import type { DeviceCodeView } from "../session/deviceLogin.ts";
import { actionRow, card, cardSymbol, headline, type IconName, lead, marqueeScreen, noteChips, serverCard, type SymbolTone, spinner } from "./marquee.ts";
import { qrCode } from "./qr.ts";
import { type Control, el, type Note, type Screen } from "./screen.ts";
import { actionTakesFocus, codeLead, type CodeStatus, isTerminal, statusLine } from "./signInText.ts";

export interface CodeView {
    readonly status: CodeStatus;
    /** The code to show; only while the status keeps one on screen (QRLoginViewModel.showsCode). */
    readonly code: DeviceCodeView | undefined;
    readonly serverName: string;
    /** host[:port], for the server card and "Can't reach …". */
    readonly host: string;
    readonly secure: boolean;
    /** The server's resolved `mark_url`, when branding gave one. */
    readonly markUrl: string | undefined;
    /** Where to type the latest code, kept after it ends; undefined before the first one. */
    readonly typed: string | undefined;
    readonly notes: readonly Note[];
    /** Remote order: the state's action ("retry") first, then the screen's buttons. */
    readonly controls: readonly Control[];
    /** Focused when nothing on the screen holds focus: the password button, else Change server. */
    readonly rest: string;
    readonly back: () => void;
}

export interface CodeScreen {
    /** The code on screen, if any. */
    readonly userCode: string | undefined;
    readonly screen: Screen;
    /** The next status for the same code and actions: the status line changes, nothing is redrawn. */
    update(status: CodeStatus): void;
}

const SPINNING: ReadonlySet<CodeStatus["kind"]> = new Set(["getting_code", "waiting", "opened"]);

export function codeScreen(view: CodeView): CodeScreen {
    const status = el("div", "signin-status");
    status.setAttribute("role", "status");
    const statusText = el("span", "signin-status-text");
    status.appendChild(statusText);
    const setStatus = (next: CodeStatus): void => {
        const current = status.firstChild;
        const spinning = current !== null && current !== statusText;
        if (SPINNING.has(next.kind) && !spinning) {
            status.insertBefore(spinner(), statusText);
        } else if (!SPINNING.has(next.kind) && spinning) {
            status.removeChild(current);
        }
        statusText.textContent = statusLine(next, view.host);
    };
    setStatus(view.status);

    const cardContent: HTMLElement[] = [];
    if (view.code !== undefined) {
        cardContent.push(...codeCard(view.code, view.typed));
    } else if (view.status.kind === "approved") {
        cardContent.push(cardSymbol("check", "success"));
    } else if (isTerminal(view.status)) {
        const [glyph, tone] = terminalSymbol(view.status);
        cardContent.push(cardSymbol(glyph, tone));
    } else {
        const frame = qrFrame();
        frame.appendChild(spinner());
        frame.setAttribute("aria-hidden", "true");
        cardContent.push(frame);
    }
    cardContent.push(status);

    const title = headline(`Sign in to ${view.serverName}`);
    title.setAttribute("data-server-headline", "");
    const copy = [
        ...noteChips(view.notes),
        serverCard(view.serverName, view.host, view.secure, view.markUrl),
        title,
        lead(codeLead(view.status, view.typed)),
        actionRow(view.controls),
    ];
    const name = view.code !== undefined ? "code" : view.status.kind === "approved" ? "approved" : isTerminal(view.status) ? "ended" : "starting";
    const hasAction = view.controls.some((control) => control.key === "retry");
    return {
        userCode: view.code?.userCode,
        screen: {
            name,
            content: marqueeScreen(copy, card(cardContent)),
            controls: view.controls,
            focus: hasAction && actionTakesFocus(view.status) ? "retry" : view.rest,
            back: view.back,
        },
        update: setStatus,
    };
}

function codeCard(code: DeviceCodeView, typed: string | undefined): HTMLElement[] {
    const frame = qrFrame();
    const qr = qrCode(code.verificationUriComplete, "QR code that opens the sign-in page with this code");
    frame.appendChild(qr ?? el("p", "signin-qr-missing", "QR code unavailable."));
    const userCode = el("p", "signin-code", code.userCode);
    userCode.setAttribute("aria-label", `Code ${code.userCode.split("").join(" ")}`);
    return [frame, userCode, el("p", "signin-typed-url", typed ?? "")];
}

/** 360 square plus a 30 quiet zone on white, corner 24. */
function qrFrame(): HTMLElement {
    return el("div", "signin-qr-frame");
}

function terminalSymbol(status: CodeStatus): [IconName, SymbolTone] {
    switch (status.kind) {
        case "paused":
            return ["paused", "warning"];
        case "denied":
            return ["declined", "warning"];
        default:
            return ["warning", "warning"];
    }
}
