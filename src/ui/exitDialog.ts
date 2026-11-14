import { remoteKey } from "./keys.ts";
import { actions, button, el } from "./screen.ts";

export interface ExitDialog { destroy(): void; }

export function mountExitDialog(root: HTMLElement, exit: () => void, closed: () => void): ExitDialog {
    let previous = document.activeElement;
    const overlay = el("section", "app-exit");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "exit-title");
    const panel = el("div", "app-exit-panel");
    const title = el("h1", "signin-title", "Exit Silo?");
    title.id = "exit-title";
    const status = el("p", "signin-text signin-error");
    status.setAttribute("role", "alert");
    let destroyed = false;
    let pressed = false;
    const destroy = (): void => {
        if (!destroyed) {
            destroyed = true;
            window.removeEventListener("keydown", onKey, true);
            window.removeEventListener("keyup", onRelease, true);
            window.removeEventListener("blur", endPress);
            document.removeEventListener("visibilitychange", endPress);
            document.removeEventListener("focusin", onFocus, true);
            overlay.remove();
            closed();
        }
    };
    const cancel = (): void => {
        destroy();
        if (previous instanceof HTMLElement && previous.isConnected) {
            previous.focus();
        }
    };
    const confirm = (): void => {
        try {
            exit();
            destroy();
        } catch {
            status.textContent = "Could not exit Silo.";
        }
    };
    const yes = button("exit", "Exit", confirm);
    const no = button("cancel-exit", "Cancel", cancel);
    let focused = no.element;
    const onFocus = (event: FocusEvent): void => {
        if (event.target instanceof HTMLElement) {
            if (overlay.contains(event.target)) {
                focused = event.target;
            } else {
                previous = event.target;
                focused.focus();
            }
        }
    };
    const onKey = (event: KeyboardEvent): void => {
        const key = remoteKey(event);
        if (key === undefined) {
            return;
        }
        // The dialog is modal; the underlying screen must not also navigate on this key.
        event.preventDefault();
        event.stopImmediatePropagation();
        // Any other key ends a held Select, so its release cannot run a button it did not press.
        if (key !== "enter") {
            pressed = false;
        }
        if (key === "back") {
            cancel();
        } else if (key === "left" || key === "up") {
            yes.element.focus();
        } else if (key === "right" || key === "down") {
            no.element.focus();
        } else if (key === "enter") {
            // tvOS runs the focused button when Select is released; a repeat is the same press.
            if (!event.repeat) {
                pressed = true;
            }
        }
    };
    // A lost window or a hidden page loses Select's release, so the next press is a fresh one.
    const endPress = (): void => {
        pressed = false;
    };
    const onRelease = (event: KeyboardEvent): void => {
        if (remoteKey(event) !== "enter") {
            return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!pressed) {
            return;
        }
        pressed = false;
        if (document.activeElement === yes.element) {
            confirm();
        } else {
            cancel();
        }
    };
    for (const node of [title, status, actions([yes, no])]) {
        panel.appendChild(node);
    }
    overlay.appendChild(panel);
    // Screen owners replace the app root while asynchronous requests settle.
    root.ownerDocument.body.appendChild(overlay);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onRelease, true);
    window.addEventListener("blur", endPress);
    document.addEventListener("visibilitychange", endPress);
    document.addEventListener("focusin", onFocus, true);
    no.element.focus();
    return { destroy };
}
