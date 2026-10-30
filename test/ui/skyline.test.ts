import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { launchBrowser, openTv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

function luminance(rgb: readonly number[]): number {
    const linear = rgb.map((channel) => channel / 255 <= 0.04045 ? channel / 255 / 12.92 : ((channel / 255 + 0.055) / 1.055) ** 2.4);
    return (linear[0] ?? 0) * 0.2126 + (linear[1] ?? 0) * 0.7152 + (linear[2] ?? 0) * 0.0722;
}

test("an empty unfocused server field has a visible boundary against the Skyline background", async () => {
    const tv = await openTv(browser, { app: "application", production: true });
    try {
        await tv.page.locator('[data-screen="entry"]').waitFor();
        await tv.page.locator('[data-focus="connect"]').focus();
        const colors = await tv.page.locator("#signin-address").evaluate((input) => {
            const style = getComputedStyle(input);
            const background = getComputedStyle(document.querySelector(".signin") ?? document.body).backgroundColor;
            return { border: style.borderTopColor, background };
        });
        const border = luminance((colors.border.match(/\d+/g) ?? []).map(Number));
        const background = luminance((colors.background.match(/\d+/g) ?? []).map(Number));
        assert.ok((Math.max(border, background) + 0.05) / (Math.min(border, background) + 0.05) >= 3, "the input boundary needs 3:1 contrast");
        assert.equal(colors.background, "rgb(0, 0, 0)");
        assert.deepEqual(await tv.page.evaluate(() => window.appHarness.registeredKeys), ["MediaPlayPause"]);
    } finally {
        await tv.page.context().close();
    }
});

test("Reduced Motion removes screen and focus animation without delaying navigation", async () => {
    const tv = await openTv(browser, { app: "application", production: true });
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await tv.page.locator('[data-screen="entry"]').waitFor();
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "connect");
        const motion = await tv.page.locator(".signin-screen").evaluate((screen) => ({
            screen: getComputedStyle(screen).animationDuration,
            control: getComputedStyle(document.activeElement ?? screen).transitionDuration,
        }));
        assert.equal(motion.screen, "0s");
        assert.ok(motion.control.split(",").every((value) => value.trim() === "0s"));
        await tv.remote(10009);
        assert.equal(await tv.focused(), "cancel-exit");
        assert.equal(await tv.page.locator(".app-exit-panel").evaluate((panel) => getComputedStyle(panel).animationDuration), "0s");
        assert.deepEqual(tv.console, []);
    } finally {
        await tv.page.context().close();
    }
});
