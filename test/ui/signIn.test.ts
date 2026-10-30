// The native sign-in screens, driven by remote keys in Chromium against the fake Silo.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { encode } from "uqr";
import { fixture } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

const BACK = 10009;
const IME_DONE = 65376;
const MINUTE = 60000;

let browser: Browser;
before(async () => {
    browser = await launchBrowser();
});
after(async () => {
    await browser.close();
});

function tvTest(name: string, body: (tv: Tv) => Promise<void>, options: { sessionOnly?: boolean } = {}): void {
    test(name, async () => {
        const tv = await openTv(browser, options);
        try {
            await body(tv);
            assert.deepEqual(tv.console, [], "the page logs nothing");
        } finally {
            await tv.page.context().close();
        }
    });
}

async function connectTo(tv: Tv, address = "silo.example.test"): Promise<void> {
    await tv.page.fill("#signin-address", address);
    await tv.page.keyboard.press("ArrowDown");
    await tv.page.keyboard.press("Enter");
}

async function shows(tv: Tv, text: string): Promise<void> {
    await tv.page.getByText(text).first().waitFor();
}

async function codeScreen(tv: Tv): Promise<string> {
    await tv.page.locator('[data-screen="code"]').waitFor();
    const codes = [...tv.fake.devices.keys()];
    const code = codes[codes.length - 1];
    assert.ok(code !== undefined, "a device request started");
    return code;
}

/** Lets a failing connect run its one transport retry, a second later, until the address screen returns. */
async function connectFails(tv: Tv, text: string): Promise<void> {
    await tv.eventually(async () => {
        if ((await tv.screen()) === "entry") {
            return true;
        }
        await tv.jump(1000);
        return false;
    }, "the connect to fail");
    await shows(tv, text);
}

function handoffs(tv: Tv): Promise<number> {
    return tv.page.evaluate(() => window.harness.handoffs.length);
}

async function signIn(tv: Tv): Promise<void> {
    const before = await handoffs(tv);
    const code = await codeScreen(tv);
    tv.fake.approve(code);
    await tv.jump(5000);
    await tv.eventually(async () => (await handoffs(tv)) === before + 1, "the handoff");
}

function polls(tv: Tv): number {
    return tv.fake.paths().filter((path) => path === "POST /auth/device/poll").length;
}

function rateLimited(retryAfterSeconds: number): { status: number; headers: Record<string, string>; body: unknown } {
    return {
        status: 429,
        headers: { "Content-Type": "application/problem+json", "Retry-After": String(retryAfterSeconds) },
        body: fixture("rate_limited"),
    };
}

tvTest("the address screen explains an unusable address without contacting anything", async (tv) => {
    assert.equal(await tv.focused(), "address");
    await connectTo(tv, "http://silo.example.test");
    await shows(tv, "Use an address that starts with https://.");
    assert.equal(await tv.focused(), "connect");
    await connectTo(tv, "silo.example.test/api/v2");
    await shows(tv, "Enter the server address without /api at the end.");
    await connectTo(tv, "");
    await shows(tv, "Enter your server address.");
    assert.equal(await tv.page.locator('[data-focus="forget"]').count(), 0, "nothing to forget for an address that can't be parsed");
    assert.deepEqual(tv.fake.requests, []);
});

tvTest("an unreachable server can be retried, and its saved sign-in removed while offline", async (tv) => {
    await connectTo(tv);
    await signIn(tv);
    assert.equal(await tv.page.evaluate(() => window.harness.keyManager?.items.size), 1);
    await tv.page.evaluate(() => {
        window.harness.storage.removeItem("silo.native.server");
        window.harness.mount();
    });
    tv.offline = true;
    await connectTo(tv);
    await connectFails(tv, "Could not reach the server.");
    assert.equal(await tv.focused(), "connect");
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), "forget");
    await tv.page.keyboard.press("Enter");
    await shows(tv, "Removed this server's saved sign-in from this TV.");
    assert.equal(await tv.page.evaluate(() => window.harness.keyManager?.items.size), 0);
    assert.equal(await tv.focused(), "connect");
    const blocked = tv.blocked;
    await tv.page.keyboard.press("Enter");
    await connectFails(tv, "Could not reach the server.");
    assert.ok(tv.blocked > blocked, "Connect tried again");
    tv.offline = false;
    await tv.page.keyboard.press("Enter");
    await codeScreen(tv);
    assert.equal(await handoffs(tv), 1, "the removed account cannot restore");
});

tvTest("unsupported, misrouted and failing servers are named, and a retry connects", async (tv) => {
    const info = fixture("get_system_info_ok");
    tv.fake.script("/system/info", { status: 200, body: { ...info, api_major: 1, request_origin: tv.fake.origin } });
    await connectTo(tv);
    await shows(tv, "It needs a Silo server with the version 2 API.");
    tv.fake.script("/system/info", { status: 200, body: info });
    await tv.page.keyboard.press("Enter");
    await shows(tv, "The server answered from a different address than the one entered.");
    tv.fake.script("/system/info", { status: 503 }, { status: 503 });
    await tv.page.keyboard.press("Enter");
    await connectFails(tv, "The server had a problem. Try again in a moment.");
    await tv.page.keyboard.press("Enter");
    await codeScreen(tv);
});

tvTest("connecting can be abandoned with Back, and its late answer changes nothing", async (tv) => {
    const hold = tv.fake.hold("/system/info");
    await connectTo(tv);
    await tv.page.locator('[data-screen="connecting"]').waitFor();
    assert.equal(await tv.focused(), "cancel");
    await tv.remote(BACK);
    assert.equal(await tv.screen(), "entry");
    assert.equal(await tv.focused(), "connect");
    hold.release();
    await hold.released;
    await tv.page.evaluate(() => undefined);
    assert.equal(await tv.screen(), "entry");
    assert.deepEqual(tv.fake.paths(), ["GET /system/info"], "no identity check or sign-in after abandoning");
});

tvTest("the code screen shows the grouped code, its address and a QR code of the approval link", async (tv) => {
    await connectTo(tv);
    const deviceCode = await codeScreen(tv);
    await shows(tv, "4821 7730");
    await shows(tv, "https://silo.example.test/activate");
    await shows(tv, "Waiting for approval");
    await shows(tv, "Code expires in 15:00");
    assert.equal(await tv.focused(), "change");

    const qr = tv.page.locator('svg[role="img"]');
    assert.equal(await qr.getAttribute("aria-label"), "QR code that opens the sign-in page with this code");
    const expected = encode("https://silo.example.test/activate?code=48217730", { ecc: "M", border: 4 });
    assert.equal(await qr.getAttribute("viewBox"), `0 0 ${expected.size} ${expected.size}`);
    const dark: string[] = [];
    expected.data.forEach((row, y) => row.forEach((on, x) => on && dark.push(`M${x} ${y}h1v1h-1z`)));
    assert.equal(await qr.locator("path").getAttribute("d"), dark.join(""), "the QR code encodes the server's complete link");

    await tv.jump(5000);
    await tv.eventually(async () => polls(tv) === 1, "the first poll");
    assert.equal(await tv.focused(), "change", "a poll keeps focus where it was");
    const html = await tv.page.content();
    assert.equal(html.includes(deviceCode), false, "the device code never reaches the page");
});

tvTest("an opened code says so and its deadline moves later; the code is never replaced", async (tv) => {
    await connectTo(tv);
    const code = await codeScreen(tv);
    const displayedCode = await tv.page.locator(".signin-code").textContent();
    await tv.jump(12 * MINUTE);
    await shows(tv, "Code expires in 3:00");
    tv.fake.open(code);
    await tv.jump(5000);
    await shows(tv, "Code opened");
    await shows(tv, "Code expires in 4:55");
    assert.equal(tv.fake.devices.size, 1);
    assert.equal(await tv.page.locator(".signin-code").textContent(), displayedCode);
});

tvTest("a link too large for a QR code still shows manual sign-in and keeps polling", async (tv) => {
    tv.fake.script("/auth/device/start", {
        status: 201,
        body: { ...fixture("start_device_login_ok"), verification_uri_complete: `https://silo.example.test/activate?code=${"x".repeat(5000)}` },
    });
    await connectTo(tv);
    await tv.page.locator('[data-screen="code"]').waitFor();
    await shows(tv, "4821 7730");
    await shows(tv, "QR code unavailable.");
    assert.equal(await tv.focused(), "change");
    assert.equal(await tv.page.locator("svg").count(), 0);
    await tv.jump(5000);
    await tv.eventually(async () => polls(tv) === 1, "polling despite QR failure");
    await tv.remote(BACK);
    assert.equal(await tv.screen(), "entry");
});

tvTest("approval hands the server over once, removes the screens and keeps tokens off the page", async (tv) => {
    await connectTo(tv);
    await signIn(tv);
    const [handoff] = await tv.page.evaluate(() => window.harness.handoffs);
    assert.deepEqual(handoff, { restore: "signed_out", username: "laura", persistence: "persistent", rootChildren: 0 });
    const html = await tv.page.content();
    assert.equal(/acc-|ref-|dev-/.test(html), false);
    assert.equal(await tv.screen(), null);
});

tvTest("a restart restores the saved session without a code, and a damaged record asks to sign in again", async (tv) => {
    await connectTo(tv);
    await signIn(tv);
    const starts = tv.fake.devices.size;
    await tv.page.evaluate(() => window.harness.mount());
    await tv.eventually(async () => (await handoffs(tv)) === 2, "the restored handoff");
    const restored = await tv.page.evaluate(() => window.harness.handoffs[1]);
    assert.equal(restored?.restore, "signed_in");
    assert.equal(tv.fake.devices.size, starts, "no new code");

    await tv.page.evaluate(() => {
        const keyManager = window.harness.keyManager;
        for (const alias of keyManager?.items.keys() ?? []) {
            keyManager?.items.set(alias, "not a record");
        }
        window.harness.mount();
    });
    await codeScreen(tv);
    await shows(tv, "The sign-in saved on this TV could not be read, so it was removed. Sign in again.");
});

tvTest(
    "without protected storage the person is told the sign-in lasts this session, and must choose Continue",
    async (tv) => {
        await connectTo(tv);
        const code = await codeScreen(tv);
        tv.fake.approve(code);
        await tv.jump(5000);
        await tv.page.locator('[data-screen="notice"]').waitFor();
        await shows(tv, "Signed in as laura");
        await shows(tv, "you will need to sign in again after the app closes.");
        assert.equal(await tv.focused(), "continue");
        await tv.remote(BACK);
        assert.equal(await tv.screen(), "notice", "Back does not skip the notice");
        assert.equal(await tv.page.evaluate(() => window.harness.lastKeyPrevented), true);
        assert.equal(await handoffs(tv), 0);
        await tv.page.keyboard.press("Enter");
        const handoff = await tv.page.evaluate(() => window.harness.handoffs[0]);
        assert.equal(handoff?.persistence, "session_only");
    },
    { sessionOnly: true },
);

tvTest("a sign-in that could not remove the account saved before warns it may come back", async (tv) => {
    await connectTo(tv);
    await signIn(tv);
    await tv.page.evaluate(() => {
        const { keyManager, storage } = window.harness;
        for (const alias of keyManager?.items.keys() ?? []) {
            keyManager?.unreadable.add(alias);
        }
        if (keyManager !== undefined) {
            keyManager.failRemove = true;
        }
        storage.failSet = true;
        window.harness.mount();
    });
    const code = await codeScreen(tv);
    await shows(tv, "This TV could not read its saved sign-in. Sign in again.");
    tv.fake.approve(code);
    await tv.jump(5000);
    await tv.page.locator('[data-screen="notice"]').waitFor();
    await shows(tv, "If that account appears after the app restarts, sign out of it.");
    await shows(tv, "you will need to sign in again after the app closes.");
});

tvTest("declined, expired, server-canceled and lost approvals explain themselves and offer a new code", async (tv) => {
    await connectTo(tv);
    tv.fake.deny(await codeScreen(tv));
    await tv.jump(5000);
    await shows(tv, "Sign-in declined");
    assert.equal(await tv.focused(), "retry");
    await tv.page.keyboard.press("Enter");

    await codeScreen(tv);
    assert.equal(tv.fake.devices.size, 2);
    await tv.jump(15 * MINUTE);
    await shows(tv, "Code expired");
    await tv.page.keyboard.press("Enter");

    const third = await codeScreen(tv);
    const request = tv.fake.devices.get(third);
    assert.ok(request !== undefined);
    request.status = "canceled";
    await tv.jump(5000);
    await shows(tv, "Sign-in canceled");
    await tv.page.keyboard.press("Enter");

    const fourth = await codeScreen(tv);
    assert.notEqual(fourth, third);
    tv.fake.approve(fourth);
    tv.fake.dropNextAnswer("/auth/device/poll");
    await tv.jump(5000);
    await shows(tv, "Server unreachable. Retrying.");
    await tv.jump(5000);
    await shows(tv, "Sign-in not received");
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.focused(), "change");
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.screen(), "entry");
    assert.equal(await handoffs(tv), 0);
});

tvTest("rate limits slow polling without ending sign-in, and a refused start says how long to wait", async (tv) => {
    await connectTo(tv);
    await codeScreen(tv);
    tv.fake.script("/auth/device/poll", rateLimited(20));
    await tv.jump(5000);
    await shows(tv, "Waiting to retry.");
    const limited = polls(tv);
    await tv.jump(5000);
    assert.equal(polls(tv), limited, "the next poll waits for Retry-After");
    await tv.jump(15000);
    await shows(tv, "Waiting for approval");

    await tv.remote(BACK);
    tv.fake.script("/auth/device/start", rateLimited(30));
    await tv.page.keyboard.press("Enter");
    await shows(tv, "Too many sign-in attempts. Wait 30 seconds, then try again.");
    assert.equal(await tv.focused(), "retry");
    await tv.page.keyboard.press("Enter");
    await codeScreen(tv);
});

tvTest("a server with code sign-in turned off says so", async (tv) => {
    tv.fake.script("/auth/device/capability", { status: 200, body: { ...fixture("get_device_login_capability_ok"), state: "disabled" } });
    await connectTo(tv);
    await shows(tv, "Code sign-in is off");
    assert.equal(await tv.focused(), "retry");
    await tv.page.keyboard.press("Enter");
    await codeScreen(tv);
});

tvTest("leaving the code screen withdraws the code, and approving it later signs nobody in", async (tv) => {
    await connectTo(tv);
    const code = await codeScreen(tv);
    await tv.remote(BACK);
    assert.equal(await tv.screen(), "entry");
    assert.equal(await tv.focused(), "connect");
    await tv.eventually(async () => tv.fake.devices.get(code)?.status === "canceled", "the code to be withdrawn");
    const before = tv.fake.requests.length;
    tv.fake.approve(code);
    await tv.jump(30000);
    await tv.page.evaluate(() => undefined);
    assert.equal(tv.fake.requests.length, before, "no poll after leaving");
    assert.equal(await handoffs(tv), 0);
});

const abandonmentActions: readonly ("Back" | "Change server" | "destroy")[] = ["Back", "Change server", "destroy"];
for (const action of abandonmentActions) {
    tvTest(`abandoning approval during storage with ${action} removes the unhanded account`, async (tv) => {
        await connectTo(tv);
        const code = await codeScreen(tv);
        await tv.page.evaluate(() => {
            const keyManager = window.harness.keyManager;
            if (keyManager === undefined) {
                throw new Error("protected storage required");
            }
            window.harness.saveHold = keyManager.holdSaves();
        });
        tv.fake.approve(code);
        await tv.jump(5000);
        await tv.eventually(async () => (await tv.page.evaluate(() => window.harness.saveHold?.waiting())) === 1, "credential storage to start");

        if (action === "Back") {
            await tv.remote(BACK);
        } else if (action === "Change server") {
            await tv.page.getByRole("button", { name: "Change server" }).click();
        } else {
            await tv.page.evaluate(() => window.harness.destroy());
        }
        await tv.page.evaluate(() => window.harness.saveHold?.release());
        assert.equal(await tv.page.evaluate(() => window.harness.keyManager?.items.size), 0, "an abandoned approval must not stay saved");
        assert.equal(await handoffs(tv), 0);
        await tv.eventually(async () => tv.fake.revokedSessions.size === 1, "the abandoned server session to be revoked");
        await tv.page.evaluate(() => window.harness.mount());
        await codeScreen(tv);
        assert.equal(await handoffs(tv), 0, "restart cannot restore the abandoned account");
    });
}

const replacementActions: readonly ("reconnect" | "remount")[] = ["reconnect", "remount"];
for (const action of replacementActions) {
    tvTest(`${action} waits for abandoned storage cleanup before opening another session`, async (tv) => {
        await connectTo(tv);
        const code = await codeScreen(tv);
        await tv.page.evaluate(() => {
            const keyManager = window.harness.keyManager;
            if (keyManager === undefined) {
                throw new Error("protected storage required");
            }
            window.harness.saveHold = keyManager.holdSaves();
        });
        tv.fake.approve(code);
        await tv.jump(5000);
        await tv.eventually(async () => (await tv.page.evaluate(() => window.harness.saveHold?.waiting())) === 1, "credential storage to start");

        if (action === "reconnect") {
            await tv.remote(BACK);
            await tv.page.keyboard.press("Enter");
        } else {
            await tv.page.evaluate(() => window.harness.mount());
        }
        assert.equal(await tv.page.evaluate(() => window.harness.discoveryRequests), 1, "replacement connection must wait for cleanup");
        assert.equal(await tv.screen(), "connecting");
        await tv.page.evaluate(() => window.harness.saveHold?.release());
        await codeScreen(tv);
        await signIn(tv);
        assert.equal(tv.fake.revokedSessions.size, 1, "only the abandoned session was revoked");
        assert.equal(await tv.page.evaluate(() => window.harness.handoffs[0]?.persistence), "persistent");
        assert.equal(await tv.page.evaluate(() => window.harness.keyManager?.items.size), 1);
        await tv.page.evaluate(() => window.harness.mount());
        await tv.eventually(async () => (await handoffs(tv)) === 2, "replacement account to restore");
        assert.equal(await tv.page.evaluate(() => window.harness.handoffs[1]?.restore), "signed_in");
    });
}

tvTest("stalled cleanup leaves Connecting with a retry and never bypasses pending storage", async (tv) => {
    await connectTo(tv);
    const code = await codeScreen(tv);
    await tv.page.evaluate(() => {
        const keyManager = window.harness.keyManager;
        if (keyManager === undefined) {
            throw new Error("protected storage required");
        }
        window.harness.saveHold = keyManager.holdSaves();
    });
    tv.fake.approve(code);
    await tv.jump(5000);
    await tv.eventually(async () => (await tv.page.evaluate(() => window.harness.saveHold?.waiting())) === 1, "credential storage to start");
    await tv.remote(BACK);
    await tv.page.keyboard.press("Enter");
    await tv.jump(10000);
    await shows(tv, "This TV is still removing the earlier sign-in. Try connecting again in a moment.");
    assert.equal(await tv.screen(), "entry");
    assert.equal(await tv.focused(), "connect");
    assert.equal(await tv.page.evaluate(() => window.harness.discoveryRequests), 1);
    await tv.page.keyboard.press("Enter");
    await tv.page.evaluate(() => window.harness.saveHold?.release());
    await codeScreen(tv);
    assert.equal(await tv.page.evaluate(() => window.harness.discoveryRequests), 2);
    await signIn(tv);
    assert.equal(await tv.page.evaluate(() => window.harness.handoffs[0]?.persistence), "persistent");
});

tvTest("destroying a sign-in notice revokes the account instead of handing it over", async (tv) => {
    await connectTo(tv);
    const code = await codeScreen(tv);
    tv.fake.approve(code);
    await tv.jump(5000);
    await tv.page.locator('[data-screen="notice"]').waitFor();
    await tv.page.evaluate(() => window.harness.destroy());
    await tv.eventually(async () => tv.fake.revokedSessions.size === 1, "the unhanded account to be revoked");
    assert.equal(await handoffs(tv), 0);
}, { sessionOnly: true });

tvTest("an account that must change its password is signed out here and sent to the server's web page", async (tv) => {
    await connectTo(tv);
    const code = await codeScreen(tv);
    tv.fake.passwordChangeRequired = true;
    tv.fake.approve(code);
    await tv.jump(5000);
    await tv.page.locator('[data-screen="password"]').waitFor();
    await shows(tv, "In a web browser, open https://silo.example.test, sign in and choose a new password.");
    assert.equal(await tv.focused(), "retry");
    await tv.eventually(async () => tv.fake.revokedSessions.size === 1, "the login session to be revoked");
    await tv.eventually(async () => (await tv.page.evaluate(() => window.harness.keyManager?.items.size)) === 0, "the stored account to be removed");
    assert.equal(await handoffs(tv), 0);
    await tv.page.keyboard.press("Enter");
    await codeScreen(tv);
});

tvTest("signing out offline still clears the TV, and the address screen says what the server was not told", async (tv) => {
    await connectTo(tv);
    await signIn(tv);
    tv.offline = true;
    const result = await tv.page.evaluate(() => window.harness.logout());
    assert.deepEqual(result, { storage: "cleared", server: "unreachable" });
    assert.equal(await tv.screen(), "entry");
    await shows(tv, "Signed out on this TV.");
    await shows(tv, "The server could not be reached, so it may still list this TV's session.");
    assert.equal(await tv.page.inputValue("#signin-address"), "https://silo.example.test");
    assert.equal(await tv.focused(), "connect");
    assert.equal(await tv.page.evaluate(() => window.harness.keyManager?.items.size), 0);

    const before = tv.fake.requests.length;
    tv.offline = false;
    assert.equal(tv.fake.requests.length, before, "no reconnect until asked");
    await tv.page.keyboard.press("Enter");
    await codeScreen(tv);
});

tvTest("remote keys move focus only between controls, never lose it, and leave Back on the first screen to the app", async (tv) => {
    assert.equal(await tv.focused(), "address");
    await tv.page.keyboard.type("silo.example.test");
    await tv.page.keyboard.press("ArrowLeft");
    assert.equal(await tv.focused(), "address", "Left moves the caret in the field");
    await tv.page.keyboard.type("X");
    assert.equal(await tv.page.inputValue("#signin-address"), "silo.example.tesXt", "Left changed the insertion position");
    await tv.page.keyboard.press("Backspace");
    await tv.remote(IME_DONE);
    assert.equal(await tv.focused(), "connect", "the TV keyboard's Done moves on to Connect");
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), "connect", "focus stops at the last control");
    await tv.page.keyboard.press("ArrowUp");
    assert.equal(await tv.focused(), "address");
    await tv.page.evaluate(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement) {
            active.blur();
        }
    });
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), "address", "a lost focus comes back to the screen's first control");

    await tv.remote(BACK);
    assert.equal(await tv.page.evaluate(() => window.harness.lastKeyPrevented), false, "Back on the first screen reaches the app");
    assert.equal(await tv.screen(), "entry");

    await tv.page.keyboard.press("ArrowDown");
    await tv.page.keyboard.press("Enter");
    await codeScreen(tv);
    await tv.remote(BACK);
    assert.equal(await tv.page.evaluate(() => window.harness.lastKeyPrevented), true);
    assert.equal(await tv.screen(), "entry");
});
