import { remoteKey } from "./keys.ts";

/**
 * tvOS draws a focused control pressed while Select is held and runs it on release (`ButtonStyle.isPressed`).
 * Chromium clicks a focused button or link on Enter keydown instead, so this takes that default and clicks on
 * keyup. A screen that owns Enter itself prevents the keydown default, and its press stays its own.
 * Text fields keep the TV keyboard's Enter.
 */
let held: HTMLElement | undefined;
let owned = false;
/** The control a release is about to click, between the keyup's capture and bubble. */
let releasing: HTMLElement | undefined;
let listening = false;

function activatable(element: Element | null): element is HTMLElement {
    return (element instanceof HTMLButtonElement && !element.disabled) || (element instanceof HTMLAnchorElement && element.href !== "");
}

function release(): void {
    held?.removeAttribute("data-pressed");
    held = undefined;
    owned = false;
}

/** A Select press in progress: the control drawn pressed, and whether its release clicks it. */
export interface SelectPress { readonly element: HTMLElement; readonly owned: boolean }

/** The press Select is holding down, drawn pressed until release. */
export function heldSelect(): SelectPress | undefined {
    return held === undefined ? undefined : { element: held, owned };
}

/** A repaint replaced the held control with this one for the same item: it keeps the press, even if the repaint's focus change ended it. */
export function moveSelect(press: SelectPress, element: HTMLElement): void {
    held?.removeAttribute("data-pressed");
    held = element;
    owned = press.owned;
    element.setAttribute("data-pressed", "");
}

// Focus leaving the held control ends the press, so focus returning to it cannot run it on release.
const onFocusOut = (event: FocusEvent): void => {
    if (event.target === held) release();
};

const onPress = (event: KeyboardEvent): void => {
    const key = remoteKey(event);
    if (key === undefined) return;
    // Another remote key ends the press, as moving focus off a held tvOS control does.
    if (key !== "enter") { release(); return; }
    if (event.repeat) return;
    release();
    const target = document.activeElement;
    if (!activatable(target)) return;
    held = target;
    target.setAttribute("data-pressed", "");
};

const onUnhandled = (event: KeyboardEvent): void => {
    if (remoteKey(event) !== "enter" || event.defaultPrevented || !activatable(document.activeElement)) return;
    // Auto-repeat keeps the default taken too, so a held Select never clicks again.
    event.preventDefault();
    if (!event.repeat && document.activeElement === held) owned = true;
};

// A screen may stop a keyup it owns, so the press ends at capture; only a release no screen took clicks.
const onReleaseStart = (event: KeyboardEvent): void => {
    if (remoteKey(event) !== "enter") return;
    releasing = owned ? held : undefined;
    release();
};

const onRelease = (event: KeyboardEvent): void => {
    if (remoteKey(event) !== "enter") return;
    const target = releasing;
    releasing = undefined;
    // An untrusted Enter never had a default click to replace.
    if (target === undefined || !event.isTrusted || event.defaultPrevented || !target.isConnected || document.activeElement !== target || document.hidden) return;
    event.preventDefault();
    target.click();
};

/** Starts the app-wide Select release; later calls are no-ops. */
export function listenSelectRelease(): void {
    if (listening) return;
    listening = true;
    // Capture marks the press before any screen handles the key; bubble only sees Enter no screen took.
    window.addEventListener("keydown", onPress, true);
    window.addEventListener("keydown", onUnhandled);
    window.addEventListener("keyup", onReleaseStart, true);
    window.addEventListener("keyup", onRelease);
    window.addEventListener("blur", release);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("visibilitychange", release);
}
