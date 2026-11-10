// A centred dialog over an inert copy of the screen it covers, in the two presentations Apple TV uses:
// "alert" is the system `.alert` (ProfileSelectionView's remember offer, silo-apple ProfileSelectionView.swift:115-139);
// "confirmation" is TVSettingsConfirmationOverlay, which AccountRemovalConfirmation shows for every sign-out on tvOS.
// The caller's screen host owns focus and Back; the buttons arrive in Apple's order.

import { el } from "./screen.ts";

export interface DialogOptions {
    readonly style: "alert" | "confirmation";
    /** Unique per screen; labels the dialog. */
    readonly id: string;
    readonly title: string;
    readonly message: string;
    /** Shown above the message, such as a failed save. */
    readonly problem?: string;
    readonly buttons: readonly HTMLElement[];
    /** The confirmation's destructive button, drawn in Apple's red. */
    readonly destructive?: HTMLElement;
    /** The screen underneath; it stays visible but cannot take focus or clicks. */
    readonly behind: readonly HTMLElement[];
}

export function centredDialog(options: DialogOptions): HTMLElement[] {
    const alert = options.style === "alert";
    for (const node of options.behind) {
        node.inert = true;
        node.setAttribute("aria-hidden", "true");
        node.classList.add(alert ? "dialog-behind-dimmed" : "dialog-behind");
        for (const inner of Array.from(node.querySelectorAll("[data-focus], [id]"))) {
            inner.removeAttribute("data-focus");
            inner.removeAttribute("id");
        }
        for (const control of Array.from(node.querySelectorAll("button"))) control.disabled = true;
    }
    const dialog = el("div", alert ? "signin-alert" : "confirm-dialog");
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", `${options.id}-title`);
    const title = el("h2", alert ? "signin-alert-title" : "skyline-confirm-title", options.title);
    title.id = `${options.id}-title`;
    const lines: HTMLElement[] = [];
    if (options.problem !== undefined) {
        const problem = el("p", alert ? "signin-alert-text signin-error" : "skyline-confirm-message signin-error", options.problem);
        problem.setAttribute("role", "alert");
        lines.push(problem);
    }
    lines.push(el("p", alert ? "signin-alert-text" : "skyline-confirm-message", options.message));
    options.destructive?.classList.add("skyline-destructive");
    const row = el("div", alert ? "signin-actions" : "skyline-confirm-actions");
    row.append(...options.buttons);
    if (alert) {
        dialog.append(title, ...lines, row);
        return [...options.behind, dialog];
    }
    const header = el("div", "skyline-confirm-header");
    header.append(title, ...lines);
    dialog.append(header, row);
    return [...options.behind, el("div", "confirm-dialog-scrim"), dialog];
}
