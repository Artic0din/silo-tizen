// The profile PIN screen against tvOS PINEntryView (silo-apple 97ecec1, tvOS branches): the layout
// in points as CSS pixels, the number pad's key order and remote moves, and the entry, error and
// shake states.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { fixture } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

const BACK = 10009;
const IME_DONE = 65376;
const KID_PIN = "2468";
const APPLE_ERROR = "rgb(255, 105, 97)";
const APPLE_ON_SURFACE = "rgb(237, 237, 237)";

let browser: Browser;
before(async () => {
    browser = await launchBrowser();
});
after(async () => {
    await browser.close();
});

function tvTest(name: string, body: (tv: Tv) => Promise<void>, reducedMotion = true): void {
    test(name, async () => {
        const tv = await openTv(browser, { profiles: true });
        try {
            if (reducedMotion) await tv.page.emulateMedia({ reducedMotion: "reduce" });
            await body(tv);
            assert.deepEqual(tv.console, [], "the page logs nothing");
        } finally {
            await tv.page.context().close();
        }
    });
}

async function openPin(tv: Tv): Promise<void> {
    await tv.page.fill("#signin-address", "silo.example.test");
    await tv.remote(IME_DONE);
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-screen="code"]').waitFor();
    const code = [...tv.fake.devices.keys()].pop();
    assert.ok(code !== undefined);
    tv.fake.approve(code);
    await tv.jump(5000);
    await tv.jump(1000);
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    await tv.page.locator('[data-focus="profile:p-kid"]').click();
    await tv.page.locator('[data-screen="pin"]').waitFor();
}

interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

function box(tv: Tv, selector: string): Promise<Box> {
    return tv.page.locator(selector).first().evaluate((node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
    });
}

function style(tv: Tv, selector: string, property: string): Promise<string> {
    return tv.page.locator(selector).first().evaluate((node, name) => getComputedStyle(node).getPropertyValue(name), property);
}

const key = (name: string): string => `[data-focus="${name}"]`;
const filled = (tv: Tv): Promise<number> => tv.page.locator(".pin-dot-filled").count();

tvTest("the PIN screen is laid out like tvOS: 160 avatar, 26 dots, 34 status line, 100 keys, Cancel", async (tv) => {
    await openPin(tv);
    const avatar = await box(tv, ".pin-header .profile-avatar");
    const name = await box(tv, ".pin-name");
    const dots = await tv.page.locator(".pin-dot").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().x));
    const dotBox = await box(tv, ".pin-dot");
    const dotRow = await box(tv, ".pin-dots");
    const status = await box(tv, ".pin-status");
    const pad = await box(tv, ".pin-pad");
    const cancel = await box(tv, key("cancel"));

    assert.equal(avatar.width, 160);
    assert.equal(avatar.height, 160);
    assert.equal(name.y - (avatar.y + avatar.height), 14, "6 stack spacing plus 8 under the avatar");
    assert.equal(await style(tv, ".pin-name", "font-size"), "38px");
    assert.equal(await style(tv, ".pin-name", "font-weight"), "700");
    assert.equal(await tv.page.getByRole("heading", { name: "Kid", exact: true }).count(), 1);

    assert.equal(dots.length, 4);
    assert.deepEqual([dotBox.width, dotBox.height], [26, 26]);
    assert.deepEqual(dots.map((x, index) => x - (dots[0] ?? 0) - index * 54), [0, 0, 0, 0], "28 apart");
    assert.equal(dotRow.y - (name.y + name.height), 34);
    assert.equal(await style(tv, ".pin-dot", "box-shadow"), "rgba(237, 237, 237, 0.7) 0px 0px 0px 2.86px inset", "an empty dot is a 26 × 0.11 ring at 70%");

    assert.equal(status.y - (dotRow.y + dotRow.height), 18);
    assert.equal(status.height, 34);
    assert.equal(await style(tv, ".pin-status", "font-size"), "26px");
    assert.equal(await style(tv, ".pin-status", "color"), "rgba(237, 237, 237, 0.62)");
    assert.equal(await tv.page.locator(".pin-status").innerText(), "Enter your PIN");

    assert.equal(pad.y - (status.y + status.height), 30);
    assert.equal(pad.width, 3 * 100 + 2 * 24);
    assert.equal(pad.height, 4 * 100 + 3 * 20);
    assert.equal(cancel.y - (pad.y + pad.height), 30);
    assert.equal(await tv.page.locator(".pin-cancel").innerText(), "Cancel");

    for (const part of [avatar, name, dotRow, status, pad, cancel]) {
        assert.ok(Math.abs(part.x + part.width / 2 - 960) < 0.5, "centered on the screen");
    }
    assert.ok(Math.abs(avatar.y + (cancel.y + cancel.height) - 1080) < 1, "the stack is centered vertically");
    assert.equal(await tv.page.locator(".signin-wordmark").isVisible(), false, "the wordmark is not part of the prompt");
});

tvTest("the number pad has Apple's order, key size, spacing, digit and letter type", async (tv) => {
    await openPin(tv);
    const keys = await tv.page.locator(".pin-key").evaluateAll((nodes) => nodes.map((node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { key: node.getAttribute("data-focus"), x, y, width, height };
    }));
    assert.deepEqual(keys.map((entry) => entry.key), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "delete"]);
    const [first, second, third, , , , seventh, , , zero, remove] = keys;
    assert.ok(first && second && third && seventh && zero && remove);
    for (const entry of keys) assert.deepEqual([entry.width, entry.height], [100, 100]);
    assert.equal(second.x - (first.x + 100), 24, "24 between columns");
    assert.equal(seventh.y - (first.y + 200 + 20), 20, "20 between rows");
    assert.equal(zero.y - (seventh.y + 100), 20);
    assert.equal(zero.x, second.x, "0 sits under 2: the blank is bottom left");
    assert.equal(remove.x, third.x, "delete sits under 3");
    assert.equal(await tv.page.locator(".pin-key-blank").count(), 1);
    assert.deepEqual(await box(tv, ".pin-key-blank").then(({ x, y }) => [x, y]), [first.x, zero.y]);

    const letters = await tv.page.locator(".pin-key").evaluateAll((nodes) => nodes.map((node) => node.querySelector(".pin-key-letters")?.textContent ?? ""));
    assert.deepEqual(letters, ["", "ABC", "DEF", "GHI", "JKL", "MNO", "PQRS", "TUV", "WXYZ", "", ""]);
    assert.equal(await style(tv, `${key("2")} .pin-key-digit`, "font-size"), "44px");
    assert.equal(await style(tv, `${key("2")} .pin-key-digit`, "font-weight"), "400");
    assert.equal(await style(tv, `${key("2")} .pin-key-letters`, "font-size"), "12.32px");
    assert.equal(await style(tv, `${key("2")} .pin-key-letters`, "font-weight"), "700");
    assert.equal(await style(tv, `${key("2")} .pin-key-letters`, "letter-spacing"), "1.5px");
    assert.equal(await style(tv, `${key("2")} .pin-key-letters`, "opacity"), "0.62");
    assert.equal(await tv.page.locator(`${key("delete")} svg`).count(), 1);
    assert.equal(await tv.page.locator(`${key("delete")}`).getAttribute("aria-label"), "Delete");
});

tvTest("keys are translucent circles; the focused key fills with on-surface ink", async (tv) => {
    await openPin(tv);
    assert.equal(await tv.focused(), "5", "focus starts on the centre key");
    assert.equal(await style(tv, key("2"), "background-color"), "rgba(255, 255, 255, 0.13)");
    assert.equal(await style(tv, key("2"), "border-top-color"), "rgba(255, 255, 255, 0.1)");
    assert.equal(await style(tv, key("2"), "border-top-width"), "1px");
    assert.equal(await style(tv, key("2"), "border-top-left-radius"), "50%");
    assert.equal(await style(tv, key("2"), "color"), APPLE_ON_SURFACE);
    assert.equal(await style(tv, key("5"), "background-color"), APPLE_ON_SURFACE);
    assert.equal(await style(tv, key("5"), "color"), "rgb(0, 0, 0)");
    assert.equal(await style(tv, key("5"), "border-top-color"), "rgba(0, 0, 0, 0)");
});

tvTest("the focused key scales to 1.08 once its transition settles", async (tv) => {
    await openPin(tv);
    const scale = await tv.page.locator(key("5")).evaluate((node) => {
        if (!(node instanceof HTMLElement)) throw new Error("key missing");
        node.style.transition = "none";
        return getComputedStyle(node).transform;
    });
    assert.equal(scale, "matrix(1.08, 0, 0, 1.08, 0, 0)");
}, false);

tvTest("the remote moves over the pad by position: the blank key is skipped, Cancel is below", async (tv) => {
    await openPin(tv);
    const press = async (arrow: string, expected: string, why: string): Promise<void> => {
        await tv.page.keyboard.press(arrow);
        assert.equal(await tv.focused(), expected, why);
    };
    await press("ArrowLeft", "4", "left of 5");
    await press("ArrowLeft", "4", "the pad's left edge keeps focus");
    await press("ArrowDown", "7", "below 4");
    await press("ArrowDown", "0", "7 is above the blank, so the nearest key is 0");
    await press("ArrowLeft", "0", "nothing left of 0");
    await press("ArrowRight", "delete", "right of 0");
    await press("ArrowRight", "delete", "the pad's right edge keeps focus");
    await press("ArrowUp", "9", "above delete");
    await press("ArrowDown", "delete", "back down");
    await press("ArrowDown", "cancel", "Cancel is below the pad");
    await press("ArrowDown", "cancel", "nothing below Cancel");
    await press("ArrowUp", "0", "Cancel is centered under 0");
    await press("ArrowUp", "8", "above 0");
    await press("ArrowUp", "5", "above 8");
    await press("ArrowUp", "2", "above 5");
    await press("ArrowUp", "2", "the top row keeps focus");
});

tvTest("OK on a key adds the digit, delete and Back remove one, and Back on an empty entry leaves", async (tv) => {
    await openPin(tv);
    const dots = tv.page.locator(".pin-dots");
    assert.equal(await dots.getAttribute("aria-label"), "0 of 4 digits entered");
    await tv.page.keyboard.press("Enter");
    assert.equal(await filled(tv), 1, "OK on the focused 5");
    await tv.page.locator(key("8")).click();
    assert.equal(await filled(tv), 2);
    assert.equal(await dots.getAttribute("aria-label"), "2 of 4 digits entered");
    await tv.page.locator(key("delete")).click();
    assert.equal(await filled(tv), 1, "delete removes one");
    await tv.remote(BACK);
    assert.equal(await filled(tv), 0, "Back removes a digit while there is one");
    assert.equal(await tv.screen(), "pin");
    await tv.page.locator(key("delete")).click();
    assert.equal(await filled(tv), 0, "delete on an empty entry does nothing");
    assert.equal(tv.fake.paths().includes("POST /profiles/p-kid/verify-pin"), false);
    await tv.remote(BACK);
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    assert.equal(await tv.focused(), "profile:p-kid");
});

tvTest("Cancel returns to the picker", async (tv) => {
    await openPin(tv);
    await tv.page.locator(key("cancel")).click();
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    assert.equal(await tv.focused(), "profile:p-kid");
});

tvTest("the fourth digit sends the PIN; the dots stay filled with a spinner while it is checked", async (tv) => {
    await openPin(tv);
    const check = tv.fake.hold("/profiles/p-kid/verify-pin", true);
    for (const digit of "246") await tv.page.locator(key(digit)).click();
    assert.equal(await filled(tv), 3);
    assert.equal(tv.fake.paths().includes("POST /profiles/p-kid/verify-pin"), false, "three digits send nothing");
    await tv.page.locator(key("8")).click();
    await tv.page.locator(".pin-status .marquee-spinner").waitFor();
    assert.equal(await filled(tv), 4);
    assert.equal(await tv.page.locator(".pin-status").innerText(), "", "the spinner replaces the line");
    assert.equal(await tv.page.getByRole("img", { name: "Checking the PIN." }).count(), 1, "screen readers still hear the check");
    assert.equal(await tv.focused(), "8", "focus stays on the key that was pressed");
    check.release();
    await tv.eventually(async () => (await tv.page.evaluate(() => window.harness.profiles)).length === 1, "the profile to open");
});

tvTest("a wrong PIN turns the dots red, shows the red line, clears the entry and keeps focus", async (tv) => {
    await openPin(tv);
    for (const digit of "0000") await tv.page.locator(key(digit)).click();
    await tv.page.getByText("Wrong PIN. Try again.").waitFor();
    assert.equal(await tv.focused(), "0");
    assert.equal(await style(tv, ".pin-status", "color"), APPLE_ERROR);
    assert.equal(await tv.page.locator(".pin-status").innerText(), "Wrong PIN. Try again.");
    assert.equal(await filled(tv), 4, "every dot is filled red");
    for (const colors of await tv.page.locator(".pin-dot").evaluateAll((nodes) => nodes.map((node) => [getComputedStyle(node).backgroundColor, getComputedStyle(node).boxShadow]))) {
        assert.deepEqual(colors, [APPLE_ERROR, `${APPLE_ERROR} 0px 0px 0px 2.86px inset`]);
    }
    assert.equal(await tv.page.locator(".pin-dots").getAttribute("aria-label"), "0 of 4 digits entered");
    await tv.page.locator(key("1")).click();
    assert.equal(await filled(tv), 1, "the next digit starts a new entry");
    assert.equal(await tv.page.locator(".pin-dots-error").count(), 0);
    assert.equal(await tv.page.locator(".pin-status").innerText(), "Wrong PIN. Try again.", "the line stays until the next check");
    await tv.page.locator(key("delete")).click();
    for (const digit of KID_PIN) await tv.page.locator(key(digit)).click();
    await tv.eventually(async () => (await tv.page.evaluate(() => window.harness.profiles)).length === 1, "the right PIN to open the profile");
});

tvTest("a lockout reads like Apple's, in whole minutes", async (tv) => {
    await openPin(tv);
    for (let attempt = 0; attempt < 5; attempt++) {
        for (const digit of "0000") await tv.page.locator(key(digit)).click();
        await tv.page.getByText("Wrong PIN. Try again.").waitFor();
    }
    for (const digit of KID_PIN) await tv.page.locator(key(digit)).click();
    await tv.page.getByText("Too many incorrect PINs. Try again in 5 minutes.").waitFor();
    assert.equal(await tv.page.locator(".pin-dots-error").count(), 1);
});

tvTest("a wrong PIN shakes the dots with the sign-in shake: 0.37 s, -8, 8, -6, 4, 0", async (tv) => {
    await openPin(tv);
    assert.equal(await style(tv, ".pin-dots", "animation-name"), "none");
    for (const digit of "0000") await tv.page.locator(key(digit)).click();
    await tv.page.getByText("Wrong PIN. Try again.").waitFor();
    assert.equal(await style(tv, ".pin-dots", "animation-name"), "signin-shake");
    assert.equal(await style(tv, ".pin-dots", "animation-duration"), "0.37s");
    const offsets = await tv.page.locator(".pin-dots").evaluate((node) => node.getAnimations().flatMap((animation) => {
        const effect = animation.effect;
        return effect instanceof KeyframeEffect ? effect.getKeyframes().map((frame) => String(frame.transform)) : [];
    }));
    assert.deepEqual(offsets, ["none", "translateX(-8px)", "translateX(8px)", "translateX(-6px)", "translateX(4px)", "translateX(0px)"]);
}, false);

tvTest("reduced motion keeps the red dots and drops the shake", async (tv) => {
    await openPin(tv);
    for (const digit of "0000") await tv.page.locator(key(digit)).click();
    await tv.page.getByText("Wrong PIN. Try again.").waitFor();
    assert.equal(await style(tv, ".pin-dots", "animation-name"), "none");
    assert.equal(await tv.page.locator(".pin-dots-error").count(), 1);
});

tvTest("a lockout with no Retry-After says to try later", async (tv) => {
    await openPin(tv);
    tv.fake.script("/profiles/p-kid/verify-pin", { status: 429, headers: { "Content-Type": "application/problem+json" }, body: fixture("rate_limited") });
    for (const digit of KID_PIN) await tv.page.locator(key(digit)).click();
    await tv.page.getByText("Too many incorrect PINs. Try again later.", { exact: true }).waitFor();
    assert.equal(await tv.page.locator(".pin-dots-error").count(), 1);
});

/** Chromium clicks a focused button on every Enter keydown, auto-repeats included; tvOS runs a press once, on release. */
tvTest("holding OK on a key draws it pressed and adds one digit on release, as a single tvOS press does", async (tv) => {
    await openPin(tv);
    const cdp = await tv.page.context().newCDPSession(tv.page);
    const enter = (type: "keyDown" | "keyUp", autoRepeat: boolean): Promise<unknown> =>
        cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}), autoRepeat });
    const focused = tv.page.locator(":focus");
    await enter("keyDown", false);
    await enter("keyDown", true);
    await enter("keyDown", true);
    assert.equal(await filled(tv), 0, "a held key waits for its release");
    assert.equal(await focused.getAttribute("data-pressed"), "");
    // PINEntryView.swift:355: a held key drops to 0.75 opacity.
    assert.equal(await focused.evaluate(node => getComputedStyle(node).opacity), "0.75");
    await enter("keyUp", false);
    assert.equal(await filled(tv), 1, "one press and two repeats enter one digit");
    assert.equal(await focused.getAttribute("data-pressed"), null, "release ends the pressed look");
    await enter("keyDown", false);
    await tv.page.keyboard.press("ArrowRight");
    await enter("keyUp", false);
    assert.equal(await filled(tv), 1, "moving off a held key cancels its press");
    assert.equal(tv.fake.paths().includes("POST /profiles/p-kid/verify-pin"), false);
});

function setKidAvatar(tv: Tv, avatar: string): void {
    const items = tv.fake.profiles.items as Record<string, unknown>[];
    tv.fake.profiles = { ...tv.fake.profiles, items: items.map((item) => (item.id === "p-kid" ? { ...item, avatar, avatar_url: undefined } : item)) };
}

tvTest("the avatar is Apple's ProfileAvatarView: a flat surface circle with a semibold initial", async (tv) => {
    setKidAvatar(tv, "");
    await openPin(tv);
    const avatar = ".pin-header .profile-avatar";
    assert.equal(await style(tv, avatar, "background-color"), "rgb(14, 15, 18)");
    assert.equal(await style(tv, avatar, "background-image"), "none");
    assert.equal(await style(tv, avatar, "border-top-width"), "0px");
    assert.equal(await style(tv, `${avatar} .navigation-avatar-fallback`, "font-size"), "54.4px", "160 × 0.34");
    assert.equal(await style(tv, `${avatar} .navigation-avatar-fallback`, "font-weight"), "600");
    assert.equal(await style(tv, `${avatar} .navigation-avatar-fallback`, "color"), APPLE_ON_SURFACE);
});

tvTest("an emoji avatar is 160 × 0.45 on the flat circle", async (tv) => {
    setKidAvatar(tv, "\u{1F98A}");
    await openPin(tv);
    const avatar = ".pin-header .profile-avatar";
    assert.equal(await style(tv, avatar, "background-color"), "rgb(14, 15, 18)");
    assert.equal(await style(tv, `${avatar} .navigation-avatar-fallback`, "font-size"), "72px");
});
