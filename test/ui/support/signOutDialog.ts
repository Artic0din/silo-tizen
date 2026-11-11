// Shared check for the sign-out confirmations on Who's watching and in Settings.

import assert from "node:assert/strict";
import type { Page } from "playwright";

/** AccountRemovalConfirmation on tvOS: a centred TVSettingsConfirmationOverlay over a scrim and the inert screen, Cancel then Sign Out. */
/** `twoLines`: the message wraps once, the state captured on Apple TV (y 398 to 682); a longer message grows the card. */
export async function assertSignOutDialog(page: Page, title: string | RegExp, twoLines = true): Promise<void> {
    const dialog = page.getByRole("alertdialog", { name: title });
    await dialog.waitFor();
    const layout = await dialog.evaluate((node, twoLines) => {
        const box = node.getBoundingClientRect();
        const siblings = [...(node.parentElement?.children ?? [])];
        const behind = siblings.filter((item): item is HTMLElement => item instanceof HTMLElement && item.classList.contains("dialog-behind"));
        const scrim = siblings.find(item => item.classList.contains("confirm-dialog-scrim"));
        const confirm = node.querySelector<HTMLElement>(".skyline-destructive");
        return {
            centre: [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)],
            width: Math.round(box.width),
            appleSpan: !twoLines || (Math.round(box.top) === 398 && Math.abs(box.height - 284) <= 1),
            buttons: [...node.querySelectorAll("button")].map(button => button.textContent),
            destructive: confirm === null ? "" : getComputedStyle(confirm).color,
            messageWidth: Math.round(node.querySelector(".skyline-confirm-message")?.getBoundingClientRect().width ?? 0),
            scrim: scrim === undefined ? "" : getComputedStyle(scrim).backgroundColor,
            behind: behind.length > 0 && behind.every(item => item.inert && item.querySelector("[data-focus]") === null),
        };
    }, twoLines);
    // TVSettingsConfirmationOverlay: the sign-out message wraps at 820, so the card is 820 + 2 × 48 wide (Apple TV: x 503 to 1417, y 398 to 682),
    // and a resting destructive label is .siloError #B00020.
    assert.deepEqual(layout, { centre: [960, 540], width: 916, appleSpan: true, messageWidth: 820, buttons: ["Cancel", "Sign Out"], destructive: "rgb(176, 0, 32)", scrim: "rgba(0, 0, 0, 0.62)", behind: true },
        "a centred 916 px confirmation over the inert screen, Cancel first and Sign Out in Apple's red");
}
