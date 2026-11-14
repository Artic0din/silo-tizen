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
/** The control whose press this Enter keyup completes intact, for screens that own Enter themselves. */
let released: HTMLElement | undefined;
let listening = false;
/** Enter is physically down: set by any Enter keydown, cleared only by its keyup, so a window blur does not clear it. */
let enterDown = false;

/** A control Chromium would click on Enter keydown. */
function clickable(element: Element | null): element is HTMLElement {
    return (element instanceof HTMLButtonElement && !element.disabled) || (element instanceof HTMLAnchorElement && element.href !== "");
}

// aria-disabled marks a focusable control that ignores presses: a press made on it never runs, even if it enables before release.
function activatable(element: Element | null): element is HTMLElement {
    return clickable(element) && element.getAttribute("aria-disabled") !== "true";
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
    // A replacement that is disabled ends the press instead.
    if (!activatable(element)) { release(); return; }
    held = element;
    owned = press.owned;
    element.setAttribute("data-pressed", "");
}

// Focus leaving the held control ends the press, so focus returning to it cannot run it on release.
const onFocusOut = (event: FocusEvent): void => {
    if (event.target === held) release();
};

const onPress = (event: KeyboardEvent): void => {
    // Any other key, Tab included, ends the press, as moving focus off a held tvOS control does.
    if (remoteKey(event) !== "enter") { release(); return; }
    enterDown = true;
    if (event.repeat) return;
    release();
    const target = document.activeElement;
    if (!activatable(target)) return;
    held = target;
    target.setAttribute("data-pressed", "");
};

const onUnhandled = (event: KeyboardEvent): void => {
    if (remoteKey(event) !== "enter" || event.defaultPrevented || !clickable(document.activeElement)) return;
    // Auto-repeat keeps the default taken too, so a held Select never clicks again.
    event.preventDefault();
    if (!event.repeat && document.activeElement === held) owned = true;
};

// A screen may stop a keyup it owns, so the press ends at capture; only a release no screen took clicks.
const onReleaseStart = (event: KeyboardEvent): void => {
    if (remoteKey(event) !== "enter") return;
    enterDown = false;
    // The press runs only on the control it was made on, still focused and still enabled.
    released = document.hidden || held === undefined || !activatable(held) ? undefined : held;
    releasing = owned ? released : undefined;
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

/**
 * During an Enter keyup, the control the press was made on, if it held focus throughout and no other key,
 * window blur or hidden page ended it. A screen that owns Enter runs its control only when this is that control.
 */
export function releasedSelect(): HTMLElement | undefined {
    return released;
}

/**
 * An overlay that closes while Select is down consumes the rest of that press, its repeats and its release, so it cannot
 * reach what takes focus next. A fresh, non-repeat Select is a new press and goes through.
 */
export function swallowSelect(): void {
    if (!enterDown) return;
    const consume = (event: KeyboardEvent): void => {
        if (remoteKey(event) !== "enter") return;
        if (event.type === "keydown" && !event.repeat) { stop(); return; }
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.type === "keyup") stop();
    };
    const stop = (): void => {
        window.removeEventListener("keydown", consume, true);
        window.removeEventListener("keyup", consume, true);
    };
    window.addEventListener("keydown", consume, true);
    window.addEventListener("keyup", consume, true);
}

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
