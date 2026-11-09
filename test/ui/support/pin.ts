import type { Page } from "playwright";

/** Presses the on-screen key for each digit, as a viewer pressing OK on it. */
export async function pressPin(page: Page, pin: string): Promise<void> {
    for (const digit of pin) {
        await page.locator(`[data-focus="${digit}"]`).click();
    }
}
