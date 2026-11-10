// Shared check for the sign-out confirmations on Who's watching and in Settings.

import assert from "node:assert/strict";
import type { Page } from "playwright";

/** AccountRemovalConfirmation on tvOS: a centred TVSettingsConfirmationOverlay over a scrim and the inert screen, Cancel then Sign Out. */
export async function assertSignOutDialog(page: Page, title: string | RegExp): Promise<void> {
    const dialog = page.getByRole("alertdialog", { name: title });
    await dialog.waitFor();
    const layout = await dialog.evaluate(node => {
        const box = node.getBoundingClientRect();
        const siblings = [...(node.parentElement?.children ?? [])];
        const behind = siblings.filter((item): item is HTMLElement => item instanceof HTMLElement && item.classList.contains("dialog-behind"));
        const scrim = siblings.find(item => item.classList.contains("confirm-dialog-scrim"));
        const confirm = node.querySelector<HTMLElement>(".skyline-destructive");
        return {
            centre: [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)],
            width: Math.round(box.width),
            buttons: [...node.querySelectorAll("button")].map(button => button.textContent),
            destructive: confirm === null ? "" : getComputedStyle(confirm).color,
            scrim: scrim === undefined ? "" : getComputedStyle(scrim).backgroundColor,
            behind: behind.length > 0 && behind.every(item => item.inert && item.querySelector("[data-focus]") === null),
        };
    });
    assert.deepEqual(layout, { centre: [960, 540], width: 632, buttons: ["Cancel", "Sign Out"], destructive: "rgb(255, 69, 58)", scrim: "rgba(0, 0, 0, 0.62)", behind: true },
        "a centred confirmation over the inert screen, Cancel first and Sign Out in red");
}
