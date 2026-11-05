// The native sign-in screens, driven by remote keys in Chromium against the fake Silo.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { encode } from "uqr";
import { FAKE_PASSWORD, fixture, problem, type Reply } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

const BACK = 10009;
const IME_DONE = 65376;
const IME_CANCEL = 65385;
const MINUTE = 60000;
const CLOCK_PROTOCOL_MARGIN_MS = 1000;
const PLAIN = "http://silo.example.test";

let browser: Browser;
before(async () => {
    browser = await launchBrowser();
});
after(async () => {
    await browser.close();
});

function tvTest(name: string, body: (tv: Tv) => Promise<void>, options: { sessionOnly?: boolean; origin?: string } = {}): void {
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
    // The TV keyboard's Done moves from the address to Connect, as on the Apple TV app.
    await tv.remote(IME_DONE);
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

/** Approves the code on screen; "Signed in as …" holds for a second, then the account moves on. */
async function signIn(tv: Tv): Promise<void> {
    const before = await handoffs(tv);
    const code = await codeScreen(tv);
    tv.fake.approve(code);
    await tv.jump(5000);
    await tv.eventually(async () => {
        if ((await handoffs(tv)) === before + 1) {
            return true;
        }
        await tv.jump(1000);
        return false;
    }, "the handoff");
}

async function currentCode(tv: Tv): Promise<string> {
    await tv.page.locator('[data-screen="code"]').waitFor();
    return [...tv.fake.devices.keys()].pop() ?? "";
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
    await connectTo(tv, "ftp://silo.example.test");
    await shows(tv, "Use an address that starts with https:// or http://.");
    assert.equal(await tv.focused(), "connect");
    await connectTo(tv, "http://");
    await shows(tv, "Please enter a valid server host.");
    await connectTo(tv, "silo.example.test/api/v2");
    await shows(tv, "Enter the server address without /api at the end.");
    await connectTo(tv, "");
    await shows(tv, "Please enter a server host.");
    assert.equal(await tv.page.locator('[data-focus="forget"]').count(), 0, "nothing to forget for an address that can't be parsed");
    assert.deepEqual(tv.fake.requests, []);
});

for (const invalidPort of [false, true]) {
    tvTest(`offline saved sign-in removal uses Advanced options${invalidPort ? " and rejects an invalid port" : ""}`, async tv => {
        await connectTo(tv, `${PLAIN}:8090`);
        await signIn(tv);
        assert.equal(await tv.page.evaluate(() => window.harness.keyManager?.items.size), 1);
        await tv.page.evaluate(() => {
            window.harness.storage.removeItem("silo.native.server");
            window.harness.mount();
        });
        tv.offline = true;
        await tv.page.fill("#signin-address", "silo.example.test");
        await tv.page.getByRole("button", { name: "Advanced options", exact: true }).click();
        await tv.page.locator('[data-focus="scheme-http"]').click();
        await tv.page.fill("#signin-port", "8090");
        await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
        await connectFails(tv, "Could not reach a Silo server at that address.");
        if (invalidPort) {
            await tv.page.fill("#signin-port", "70000");
        }
        await tv.page.getByRole("button", { name: "Remove saved sign-in", exact: true }).click();
        if (invalidPort) {
            await tv.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
            assert.equal(await tv.page.getByText("Port must be a number between 1 and 65535.", { exact: true }).count(), 1);
            assert.equal(await tv.page.evaluate(() => window.harness.keyManager?.items.size), 1, "an invalid target never removes a credential");
        } else {
            await shows(tv, "Removed this server's saved sign-in from this TV.");
            assert.equal(await tv.page.evaluate(() => window.harness.keyManager?.items.size), 0, "the HTTP port's credential was removed");
        }
    }, { origin: `${PLAIN}:8090` });
}


tvTest("a typed http:// address connects over plain HTTP without asking, as on the Apple TV app", async (tv) => {
    await connectTo(tv, PLAIN);
    await signIn(tv);
    assert.equal(tv.blocked, 0, "nothing was tried over HTTPS");
    assert.equal(await tv.page.evaluate(() => window.harness.storage.getItem("silo.native.server")), PLAIN);
}, { origin: PLAIN });

/** Lets the HTTPS attempt and its one transport retry fail until the cleartext question shows. */
async function asksForCleartext(tv: Tv): Promise<void> {
    await tv.eventually(async () => {
        if ((await tv.screen()) === "insecure") {
            return true;
        }
        await tv.jump(1000);
        return false;
    }, "the cleartext question");
}

tvTest("an address without a scheme tries HTTPS first, then asks before connecting without encryption", async (tv) => {
    await connectTo(tv, "silo.example.test");
    await asksForCleartext(tv);
    await shows(tv, "Connect without encryption?");
    await shows(tv, "Your password and what you watch will be sent unencrypted to silo.example.test. Only do this on a network you trust.");
    assert.ok(tv.blocked > 0, "HTTPS was tried first");
    assert.deepEqual(tv.fake.requests, [], "nothing is sent unencrypted before the answer");
    assert.equal(await tv.focused(), "connect", "Connect is focused first, as on tvOS");
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.focused(), "connect", "Connect is the last button; focus stays");
    await tv.page.keyboard.press("ArrowLeft");
    assert.equal(await tv.focused(), "cancel", "Cancel sits left of Connect, as on tvOS");
    await tv.page.keyboard.press("Enter");
    await shows(tv, "Could not reach a Silo server at that address over HTTPS.");
    assert.deepEqual(tv.fake.requests, [], "declining sends nothing");

    await tv.page.keyboard.press("Enter");
    await asksForCleartext(tv);
    await tv.page.keyboard.press("Enter");
    await signIn(tv);
    assert.equal(await tv.page.evaluate(() => window.harness.storage.getItem("silo.native.server")), PLAIN, "the plain address is what restarts use");
}, { origin: PLAIN });

tvTest("the successful port fallback is retained when changing server and reconnecting", async (tv) => {
    await connectTo(tv, "silo.example.test");
    await asksForCleartext(tv);
    await tv.page.keyboard.press("Enter");
    await codeScreen(tv);
    await tv.page.getByRole("button", { name: "Change server" }).click();
    assert.equal(await tv.page.locator("#signin-address").inputValue(), `${PLAIN}:8090`);
    await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
    await codeScreen(tv);
    assert.equal(tv.fake.devices.size, 2, "reconnecting starts another code on the successful server");
}, { origin: `${PLAIN}:8090` });

tvTest("Back on the cleartext question sends nothing and returns to the address", async (tv) => {
    await connectTo(tv, "silo.example.test");
    await asksForCleartext(tv);
    await tv.remote(BACK);
    await shows(tv, "Could not reach a Silo server at that address over HTTPS.");
    assert.equal(await tv.screen(), "entry");
    assert.deepEqual(tv.fake.requests, []);
}, { origin: PLAIN });

tvTest("an unreachable server can be retried, and its saved sign-in removed while offline", async (tv) => {
    await connectTo(tv);
    await signIn(tv);
    assert.equal(await tv.page.evaluate(() => window.harness.keyManager?.items.size), 1);
    await tv.page.evaluate(() => {
        window.harness.storage.removeItem("silo.native.server");
        window.harness.mount();
    });
    tv.offline = true;
    // A typed https:// is never offered plain HTTP, so the HTTPS failure is shown as it is.
    await connectTo(tv, "https://silo.example.test");
    await connectFails(tv, "Could not reach a Silo server at that address.");
    assert.equal(await tv.focused(), "connect");
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.focused(), "forget", "the TV's own Remove saved sign-in sits beside Connect");
    await tv.page.keyboard.press("Enter");
    await shows(tv, "Removed this server's saved sign-in from this TV.");
    assert.equal(await tv.page.evaluate(() => window.harness.keyManager?.items.size), 0);
    assert.equal(await tv.focused(), "connect");
    const blocked = tv.blocked;
    await tv.page.keyboard.press("Enter");
    await connectFails(tv, "Could not reach a Silo server at that address.");
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

tvTest("connecting keeps the address screen with Connecting… on Connect, and Back waits for it, as on the Apple TV app", async (tv) => {
    const hold = tv.fake.hold("/system/info");
    await connectTo(tv);
    await tv.page.locator('[data-screen="connecting"]').waitFor();
    assert.equal(await tv.focused(), "connect");
    const connect = tv.page.locator('[data-focus="connect"]');
    assert.equal(await connect.innerText(), "Connecting…");
    assert.equal(await connect.getAttribute("aria-busy"), "true");
    assert.equal(await connect.locator(".marquee-spinner").count(), 1, "the button shows its spinner");
    assert.equal(await tv.page.inputValue("#signin-address"), "silo.example.test", "the address stays on screen");
    await tv.remote(BACK);
    assert.equal(await tv.page.evaluate(() => window.harness.lastKeyPrevented), true, "Back is held while connecting");
    assert.equal(await tv.screen(), "connecting");
    await tv.page.keyboard.press("ArrowUp");
    assert.equal(await tv.focused(), "connect", "nothing else takes focus while connecting");
    hold.release();
    await codeScreen(tv);
});

tvTest("the code screen shows the grouped code, its address and a QR code of the approval link", async (tv) => {
    await connectTo(tv);
    const deviceCode = await codeScreen(tv);
    await shows(tv, "4821 7730");
    assert.equal(await tv.page.locator(".marquee-card .signin-typed-url").innerText(), "silo.example.test/activate");
    assert.equal(await tv.page.locator("h1").innerText(), "Sign in to silo.example.test");
    await shows(tv, "Scan the code with your phone's camera, or go to silo.example.test/activate and enter it. Approve on your phone and this TV signs in by itself.");
    await shows(tv, "Waiting for approval");
    assert.equal(await tv.page.locator(".signin-status .marquee-spinner").count(), 1, "waiting shows a spinner");
    assert.equal(await tv.page.getByText("Code expires", { exact: false }).count(), 0, "nothing counts down, as on the Apple TV app");
    assert.equal(await tv.focused(), "password", "the password button takes first focus, as on the Apple TV app");

    const qr = tv.page.locator('svg[role="img"]');
    assert.equal(await qr.getAttribute("aria-label"), "QR code that opens the sign-in page with this code");
    const expected = encode("https://silo.example.test/activate?code=48217730", { ecc: "M", border: 4 });
    assert.equal(await qr.getAttribute("viewBox"), `0 0 ${expected.size} ${expected.size}`);
    const dark: string[] = [];
    expected.data.forEach((row, y) => row.forEach((on, x) => on && dark.push(`M${x} ${y}h1v1h-1z`)));
    assert.equal(await qr.locator("path").getAttribute("d"), dark.join(""), "the QR code encodes the server's complete link");

    await tv.jump(5000);
    await tv.eventually(async () => polls(tv) === 1, "the first poll");
    assert.equal(await tv.focused(), "password", "a poll keeps focus where it was");
    const html = await tv.page.content();
    assert.equal(html.includes(deviceCode), false, "the device code never reaches the page");
});

tvTest("an opened code says to continue on the phone and its deadline moves later; the code is never replaced", async (tv) => {
    await connectTo(tv);
    const code = await codeScreen(tv);
    const displayedCode = await tv.page.locator(".signin-code").textContent();
    await tv.jump(12 * MINUTE);
    tv.fake.open(code);
    await tv.jump(5000);
    await shows(tv, "Continue on your phone");
    await tv.jump(4 * MINUTE);
    await shows(tv, "Continue on your phone");
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
    assert.equal(await tv.focused(), "password");
    assert.equal(await tv.page.locator("svg.signin-qr").count(), 0, "no QR code is drawn");
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
        await tv.jump(1000);
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
    await tv.jump(1000);
    await tv.page.locator('[data-screen="notice"]').waitFor();
    await shows(tv, "If that account appears after the app restarts, sign out of it.");
    await shows(tv, "you will need to sign in again after the app closes.");
});

async function retryButton(tv: Tv): Promise<string> {
    return tv.page.locator('[data-focus="retry"]').innerText();
}

tvTest("a declined code offers a new one; expired, withdrawn and lost codes renew themselves, as on the Apple TV app", async (tv) => {
    await connectTo(tv);
    tv.fake.deny(await codeScreen(tv));
    await tv.jump(5000);
    // Previously the status said "Sign-in was declined on your phone." and the scan lead stayed up with no code.
    await shows(tv, "Sign-in was declined.");
    await shows(tv, "Show a new code to try again.");
    assert.equal(await tv.page.locator(".marquee-lead").innerText(), "Show a new code to try again.");
    assert.equal(await tv.page.locator(".marquee-actions").evaluate((node) => getComputedStyle(node).flexDirection), "column", "the action labels wrap onto their own lines when they do not fit");
    assert.equal(await tv.page.locator("h1").innerText(), "Sign in to silo.example.test", "the headline stays");
    assert.equal(await tv.page.locator(".marquee-card .marquee-symbol").count(), 1, "the card shows the state's symbol instead of the code");
    assert.equal(await retryButton(tv), "Show a new code");
    assert.equal(await tv.focused(), "retry");
    await tv.page.keyboard.press("Enter");

    const second = await codeScreen(tv);
    await shows(tv, "Waiting for approval");
    assert.equal(await tv.page.locator(".marquee-actions").evaluate((node) => getComputedStyle(node).flexDirection), "row", "two actions still fit the copy column");
    assert.equal(await tv.focused(), "password");
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.focused(), "change");
    await tv.jump(15 * MINUTE);
    await tv.eventually(async () => tv.fake.devices.size === 3, "an expired code to renew");
    await shows(tv, "New code. Waiting for approval.");
    assert.notEqual(await currentCode(tv), second);
    assert.equal(await tv.focused(), "change", "a renewal keeps focus");
    assert.equal(await tv.page.locator('[data-focus="retry"]').count(), 0);

    const third = await currentCode(tv);
    const request = tv.fake.devices.get(third);
    assert.ok(request !== undefined);
    request.status = "canceled";
    await tv.jump(5000);
    await tv.eventually(async () => tv.fake.devices.size === 4, "a withdrawn code to renew");

    const fourth = await currentCode(tv);
    tv.fake.approve(fourth);
    tv.fake.dropNextAnswer("/auth/device/poll");
    await tv.jump(5000);
    await shows(tv, "New code. Waiting for approval.");
    assert.equal(await tv.page.getByText("Can't reach", { exact: false }).count(), 0, "one lost answer is inside the grace");
    await tv.jump(5000);
    await tv.eventually(async () => tv.fake.devices.size === 5, "a code whose approval was lost to renew");
    assert.equal(await handoffs(tv), 0);
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.screen(), "entry");
});

tvTest("codes renew for an hour, then pause until asked; Show a new code starts a fresh hour", async (tv) => {
    await connectTo(tv);
    await codeScreen(tv);
    for (let renewal = 2; renewal <= 4; renewal++) {
        await tv.jump(15 * MINUTE);
        await tv.eventually(async () => tv.fake.devices.size === renewal, `renewal ${renewal}`);
        await shows(tv, "New code. Waiting for approval.");
    }
    await tv.jump(15 * MINUTE);
    await shows(tv, "Sign-in paused.");
    assert.equal(tv.fake.devices.size, 4, "no code after the hour");
    assert.equal(await retryButton(tv), "Show a new code");
    assert.equal(await tv.focused(), "retry");
    assert.equal(await tv.page.locator(".marquee-card .marquee-symbol").count(), 1);
    const before = tv.fake.requests.length;
    await tv.jump(10 * MINUTE);
    assert.equal(tv.fake.requests.length, before, "a paused screen sends nothing");
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => tv.fake.devices.size === 5, "the new code");
    await shows(tv, "Waiting for approval");
    await tv.jump(15 * MINUTE);
    await tv.eventually(async () => tv.fake.devices.size === 6, "renewal in the new hour");
    await shows(tv, "New code. Waiting for approval.");
});

tvTest("a poll outage keeps the code and the password for 30 seconds before saying the server can't be reached", async (tv) => {
    await connectTo(tv);
    const code = await codeScreen(tv);
    tv.offline = true;
    for (const step of [5000, 5000, 10000]) {
        await tv.jump(step);
        await shows(tv, "Waiting for approval");
        assert.equal(await tv.page.getByText("Can't reach", { exact: false }).count(), 0, `inside the grace after ${step}`);
        assert.equal(await tv.page.locator(".signin-code").innerText(), "4821 7730");
        assert.equal(await tv.page.locator('[data-focus="retry"]').count(), 0);
    }
    // The fourth failing poll is sent 35 s after the first.
    await tv.jump(20000);
    await shows(tv, "Can't reach silo.example.test. Check this TV's connection.");
    assert.equal(await tv.page.locator(".signin-code").innerText(), "4821 7730", "the code stays while it recovers");
    assert.equal(await retryButton(tv), "Try again");
    assert.equal(await tv.focused(), "password", "retrying in the background does not take focus");
    assert.equal(await tv.page.getByRole("button", { name: "Sign in with a password" }).count(), 1);
    tv.offline = false;
    await tv.jump(30000);
    await shows(tv, "Waiting for approval");
    assert.equal(await tv.page.locator('[data-focus="retry"]').count(), 0);
    assert.equal(await currentCode(tv), code, "recovery keeps the same code");
});

tvTest("a failing start retries with backoff and says the server can't be reached after 10 seconds", async (tv) => {
    const outage = { status: 503 };
    tv.fake.script("/auth/device/start", outage, outage, outage, outage, outage);
    await connectTo(tv);
    await tv.page.locator('[data-screen="starting"]').waitFor();
    const starts = (): number => tv.fake.paths().filter((path) => path === "POST /auth/device/start").length;
    await tv.eventually(async () => starts() === 1, "the first start");
    for (const [wait, count] of [[1000, 2], [2000, 3], [4000, 4]] as const) {
        await tv.jump(wait);
        await tv.eventually(async () => starts() === count, `start ${count}`);
        await shows(tv, "Getting a sign-in code…");
        assert.equal(await tv.page.getByText("Can't reach", { exact: false }).count(), 0);
    }
    await tv.jump(8000);
    await tv.eventually(async () => starts() === 5, "start 5");
    await shows(tv, "Can't reach silo.example.test. Check this TV's connection.");
    assert.equal(await retryButton(tv), "Try again");
    assert.equal(await tv.focused(), "password");
    await tv.jump(16000);
    await codeScreen(tv);
    await shows(tv, "Waiting for approval");
    assert.equal(starts(), 6);
});

tvTest("a rate-limited start keeps trying, honouring Retry-After, and says so after a minute", async (tv) => {
    await holdClock(tv);
    const rateLimitedStart = async (send: () => Promise<void>): Promise<void> => {
        const answer = tv.page.waitForResponse(response => new URL(response.url()).pathname === "/api/v2/auth/device/start");
        await send();
        const response = await answer;
        assert.equal(response.status(), 429);
        assert.equal(await response.finished(), null);
        await tv.page.clock.runFor(0);
    };
    tv.fake.script("/auth/device/start", rateLimited(30), rateLimited(30), rateLimited(30));
    await rateLimitedStart(() => connectTo(tv));
    const starts = (): number => tv.fake.paths().filter((path) => path === "POST /auth/device/start").length;
    await tv.eventually(async () => starts() === 1, "the first start");
    await tv.jump(29000);
    assert.equal(starts(), 1, "waits the full Retry-After");
    await rateLimitedStart(() => tv.jump(1000));
    await tv.eventually(async () => starts() === 2, "start 2");
    await shows(tv, "Getting a sign-in code…");
    await rateLimitedStart(() => tv.jump(30000));
    await tv.eventually(async () => starts() === 3, "start 3");
    await shows(tv, "Too many sign-in attempts. Trying again shortly.");
    await tv.jump(30000);
    await codeScreen(tv);
});

tvTest("rate limits slow polling without ending sign-in, and say so only after a minute of them", async (tv) => {
    await holdClock(tv);
    await connectTo(tv);
    await codeScreen(tv);
    tv.fake.script("/auth/device/poll", rateLimited(20), rateLimited(20), rateLimited(20), rateLimited(20));
    const pollAfter = async (ms: number, status: number): Promise<void> => {
        const next = tv.page.waitForResponse(reply => new URL(reply.url()).pathname.endsWith("/auth/device/poll"));
        await tv.jump(ms);
        const response = await next;
        assert.equal(response.status(), status);
        await response.finished();
        await tv.page.clock.runFor(0);
    };
    await pollAfter(5000, 429);
    await shows(tv, "Waiting for approval");
    const limited = polls(tv);
    await tv.jump(19999);
    assert.equal(polls(tv), limited, "the next poll waits for Retry-After");
    await pollAfter(1, 429);
    await pollAfter(20000, 429);
    await shows(tv, "Waiting for approval");
    // The fourth 429 is sent 60 s after the first.
    await tv.jump(19999);
    assert.equal(await tv.page.getByText("Too many sign-in attempts", { exact: false }).count(), 0);
    await pollAfter(1, 429);
    await shows(tv, "Too many sign-in attempts. Trying again shortly.");
    assert.equal(await retryButton(tv), "Try again");
    assert.equal(await tv.focused(), "password");
    await pollAfter(20000, 200);
    await shows(tv, "Waiting for approval");
});

tvTest("a server with code sign-in turned off opens the password screen, as on the Apple TV app", async (tv) => {
    tv.fake.script("/auth/device/capability", { status: 200, body: { ...fixture("get_device_login_capability_ok"), state: "disabled" } });
    await connectTo(tv);
    await tv.page.locator('[data-screen="credentials"]').waitFor();
    await shows(tv, "This server only supports password sign-in.");
    assert.equal(await tv.focused(), "username");
    assert.equal(await tv.page.getByRole("button", { name: "Use your phone instead" }).count(), 0, "no phone route to point at");
    assert.equal(await tv.page.getByText("If you sign in with Example SSO", { exact: false }).count(), 0, "no phone hint without a phone route");
    await tv.page.fill("#signin-username", "laura");
    await tv.page.fill("#signin-password", FAKE_PASSWORD);
    await tv.page.getByRole("button", { name: "Sign in", exact: true }).click();
    await tv.eventually(async () => (await handoffs(tv)) === 1, "the handoff");
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
        await tv.page.locator('[data-screen="entry"]').waitFor();
        assert.equal(await tv.page.locator("#signin-address").inputValue(), "", "an abandoned first account leaves no saved server");
        await tv.page.fill("#signin-address", "silo.example.test");
        await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
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
    await tv.jump(1000);
    await tv.page.locator('[data-screen="notice"]').waitFor();
    await tv.page.evaluate(() => window.harness.destroy());
    await tv.eventually(async () => tv.fake.revokedSessions.size === 1, "the unhanded account to be revoked");
    assert.equal(await handoffs(tv), 0);
}, { sessionOnly: true });

tvTest("an account that must reset its password still finishes sign-in, and the session stays", async (tv) => {
    await connectTo(tv);
    tv.fake.passwordChangeRequired = true;
    await signIn(tv);
    assert.equal(tv.fake.revokedSessions.size, 0, "the session stays; the profile picker shows the refusal");
    assert.equal(await tv.page.evaluate(() => window.harness.keyManager?.items.size), 1);
    assert.equal(tv.fake.paths().some((path) => path.includes("/password-resets") || path.includes("/account/password") || path.includes("/capabilities/password-reset")), false);
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
    assert.equal(await tv.page.inputValue("#signin-address"), "", "signing out of the only account removes the saved server");
    assert.equal(await tv.focused(), "address", "the removed server must be entered again");
    assert.equal(await tv.page.evaluate(() => window.harness.keyManager?.items.size), 0);

    const before = tv.fake.requests.length;
    tv.offline = false;
    assert.equal(tv.fake.requests.length, before, "no reconnect until asked");
    await tv.page.fill("#signin-address", "silo.example.test");
    await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
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
    assert.equal(await tv.focused(), "advanced", "Advanced options sits between the address and Connect");
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

    await tv.remote(IME_DONE);
    await tv.page.keyboard.press("Enter");
    await codeScreen(tv);
    await tv.remote(BACK);
    assert.equal(await tv.page.evaluate(() => window.harness.lastKeyPrevented), true);
    assert.equal(await tv.screen(), "entry");
});

// --- Password sign-in (the Apple TV app's "Sign in with a password") ---

async function passwordScreen(tv: Tv): Promise<void> {
    await tv.page.locator('[data-screen="credentials"]').waitFor();
}

async function openPassword(tv: Tv): Promise<string> {
    await connectTo(tv);
    const code = await codeScreen(tv);
    await tv.eventually(async () => (await tv.focused()) === "password", "the password button to take first focus");
    await tv.page.keyboard.press("Enter");
    await passwordScreen(tv);
    return code;
}

function loginRequests(tv: Tv): number {
    return tv.fake.paths().filter((path) => path === "POST /auth/login").length;
}

const SSO_HINT = "If you sign in with Example SSO, use your phone instead.";

tvTest("the code screen offers a password first; typing with the remote signs in, withdraws the code and hands over once", async (tv) => {
    await connectTo(tv);
    const code = await codeScreen(tv);
    await shows(tv, "Sign in with a password");
    await tv.eventually(async () => (await tv.focused()) === "password", "the password button to take first focus");
    await tv.page.keyboard.press("Enter");
    await passwordScreen(tv);
    assert.equal(await tv.focused(), "username", "choosing a password focuses the username");
    assert.equal(await tv.page.locator("h1").innerText(), "Sign in with\na password");
    await shows(tv, "Use your silo.example.test username and password.");
    await shows(tv, SSO_HINT);
    for (const name of ["Sign in", "Use your phone instead", "Change server", "Show password"]) {
        assert.equal(await tv.page.getByRole("button", { name }).count(), 1, name);
    }
    assert.equal(await tv.page.locator("#signin-password").getAttribute("type"), "password");

    await tv.page.keyboard.type("laura");
    await tv.remote(IME_CANCEL);
    assert.equal(await tv.focused(), "username", "the TV keyboard's Cancel leaves focus on the field");
    await tv.remote(IME_DONE);
    assert.equal(await tv.focused(), "secret", "Done on the username moves to the password");
    await tv.page.keyboard.type(FAKE_PASSWORD);
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.focused(), "toggle", "Right from the password reaches show-password");
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.page.locator("#signin-password").getAttribute("type"), "text");
    assert.equal(await tv.page.getByRole("button", { name: "Hide password" }).count(), 1);
    await tv.page.keyboard.press("ArrowLeft");
    assert.equal(await tv.focused(), "secret");
    await tv.remote(IME_DONE);
    assert.equal(await tv.focused(), "signin", "Done on the password moves to Sign in");
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => (await handoffs(tv)) === 1, "the handoff");
    assert.equal(await tv.page.evaluate(() => window.harness.handoffs[0]?.username), "laura");
    assert.equal(loginRequests(tv), 1);
    await tv.eventually(async () => tv.fake.devices.get(code)?.status === "canceled", "the code to be withdrawn");
    assert.equal((await tv.page.content()).includes(FAKE_PASSWORD), false, "the password is gone with the screens");
    const stored = await tv.page.evaluate(() => [...window.harness.storage.items.values()].join(" "));
    assert.equal(stored.includes(FAKE_PASSWORD), false, "the password is never stored");
});

tvTest("password sign-in uses server branding rather than the hostname", async (tv) => {
    tv.fake.script("/theme/branding", { status: 200, body: { server_name: "Family Cinema" } });
    await connectTo(tv);
    await codeScreen(tv);
    await tv.page.getByRole("button", { name: "Sign in with a password" }).click();
    await passwordScreen(tv);
    await shows(tv, "Use your Family Cinema username and password.");
});

tvTest("late branding updates the lead without replacing the active keyboard field", async (tv) => {
    const hold = tv.fake.hold("/theme/branding");
    tv.fake.script("/theme/branding", { status: 200, body: { server_name: "Family Cinema" } });
    await openPassword(tv);
    await shows(tv, SSO_HINT);
    const input = await tv.page.locator("#signin-username").elementHandle();
    assert.ok(input);
    await input.fill("laura");
    hold.release();
    await shows(tv, "Use your Family Cinema username and password.");
    assert.equal(await input.evaluate(node => node.isConnected), true);
    assert.equal(await tv.focused(), "username");
    assert.equal(await tv.page.locator("#signin-username").inputValue(), "laura");
    await input.dispose();
});

tvTest("vertical password navigation skips its Show/Hide accessory, as on Apple TV", async (tv) => {
    await connectTo(tv);
    await codeScreen(tv);
    await tv.page.getByRole("button", { name: "Sign in with a password" }).click();
    await passwordScreen(tv);
    await tv.page.locator("#signin-password").focus();
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.focused(), "toggle");
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), "signin");
    for (const name of ["Use your phone instead", "Change server"]) {
        await tv.page.getByRole("button", { name, exact: true }).focus();
        await tv.page.keyboard.press("ArrowUp");
        assert.equal(await tv.focused(), "secret");
    }
});

tvTest("empty fields and refusals read as on the Apple TV app; a missing username outlines that field", async (tv) => {
    await openPassword(tv);
    const signInButton = tv.page.getByRole("button", { name: "Sign in", exact: true });
    await signInButton.click();
    await shows(tv, "Please enter your username.");
    // Previously every failure, including a missing username, outlined and focused the password.
    assert.equal(await tv.page.locator(".signin-field-error #signin-username").count(), 1);
    assert.equal(await tv.page.locator(".signin-field-error #signin-password").count(), 0);
    assert.equal(await tv.focused(), "username");
    await tv.page.fill("#signin-username", "laura");
    await signInButton.click();
    await shows(tv, "Please enter your password.");
    assert.equal(await tv.page.locator(".signin-field-error #signin-password").count(), 1);
    assert.equal(await tv.page.locator(".signin-field-error #signin-username").count(), 0);
    assert.equal(await tv.focused(), "secret");
    assert.equal(loginRequests(tv), 0, "nothing is sent without both fields");

    await tv.page.fill("#signin-password", "wrong");
    await signInButton.click();
    await shows(tv, `Incorrect username or password. ${SSO_HINT}`);
    assert.equal(await tv.page.getByText(SSO_HINT, { exact: true }).isVisible(), false, "the hint is not repeated under the error");
    assert.equal(await tv.focused(), "secret");
    assert.equal(await tv.page.inputValue("#signin-username"), "laura");
    assert.equal(await tv.page.locator('[role="alert"]').count(), 1);

    const replies: [Reply, string][] = [
        [{ status: 403, headers: { "Content-Type": "application/problem+json" }, body: fixture("login_account_required") }, "You don't have an account on this server yet. Ask an admin to add you."],
        [problem(403, "local_login_disabled", "Local login disabled"), "Password sign-in is turned off on this server. Use your phone instead."],
        [problem(403, "permission_denied", "Forbidden"), "This account can't sign in. Contact your server administrator."],
        [rateLimited(30), "Too many sign-in attempts. Wait a moment, then try again."],
        [problem(503, "dependency_unavailable", "Unavailable", { "Retry-After": "1" }), "The server had a problem. Try again in a moment."],
    ];
    for (const [reply, message] of replies) {
        tv.fake.script("/auth/login", reply);
        await signInButton.click();
        await shows(tv, message);
    }
    assert.equal(loginRequests(tv), 6, "each press is one request; a failure is never resent");
    assert.equal(await handoffs(tv), 0);

    await tv.page.fill("#signin-password", FAKE_PASSWORD);
    await signInButton.click();
    await tv.eventually(async () => (await handoffs(tv)) === 1, "the retry to sign in");
});

tvTest("Back and Use your phone instead return to the same code; nothing leaves while a sign-in is in flight", async (tv) => {
    const code = await openPassword(tv);
    await tv.remote(BACK);
    assert.equal(await tv.page.evaluate(() => window.harness.lastKeyPrevented), true);
    assert.equal(await tv.screen(), "code");
    assert.equal(await tv.focused(), "password", "focus returns to the password button");
    assert.equal(tv.fake.devices.size, 1, "the same code, not a new one");
    await tv.page.keyboard.press("Enter");
    await passwordScreen(tv);
    await tv.page.getByRole("button", { name: "Use your phone instead" }).click();
    assert.equal(await tv.screen(), "code");
    assert.equal(await tv.focused(), "password");

    await tv.page.keyboard.press("Enter");
    await passwordScreen(tv);
    await tv.page.fill("#signin-username", "laura");
    await tv.page.fill("#signin-password", FAKE_PASSWORD);
    const hold = tv.fake.hold("/auth/login");
    await tv.page.getByRole("button", { name: "Sign in", exact: true }).click();
    await shows(tv, "Signing in…");
    await tv.remote(BACK);
    assert.equal(await tv.page.evaluate(() => window.harness.lastKeyPrevented), true, "Back is held, not passed to the app");
    assert.equal(await tv.page.getByRole("button", { name: "Change server" }).isDisabled(), true);
    assert.equal(await tv.page.getByRole("button", { name: "Use your phone instead" }).isDisabled(), true);
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.focused(), "signin", "disabled buttons take no focus");
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.screen(), "credentials", "a sign-in in flight keeps the screen");
    assert.equal(loginRequests(tv), 1, "a second press sends nothing");
    hold.release();
    await tv.eventually(async () => (await handoffs(tv)) === 1, "the handoff");
    await tv.eventually(async () => tv.fake.devices.get(code)?.status === "canceled", "the code to be withdrawn");
});

tvTest("a phone approval while the password screen is open signs in and moves on after a second", async (tv) => {
    const code = await openPassword(tv);
    await tv.page.fill("#signin-username", "laura");
    tv.fake.approve(code);
    await tv.jump(5000);
    await tv.eventually(async () => tv.fake.devices.get(code)?.status === "consumed" || (await tv.page.evaluate(() => window.harness.keyManager?.items.size)) === 1, "the approval to be stored");
    assert.equal(await tv.screen(), "credentials", "the password screen stays, as on the Apple TV app");
    assert.equal(await tv.page.inputValue("#signin-username"), "laura");
    assert.equal(await handoffs(tv), 0);
    await tv.jump(1000);
    await tv.eventually(async () => (await handoffs(tv)) === 1, "the handoff");
    assert.equal(loginRequests(tv), 0);
});

for (const sessionOnly of [false, true]) {
    for (const action of ["Back", "Use your phone instead"] as const) {
        tvTest(`${action} after phone approval keeps the pending ${sessionOnly ? "session-only" : "persistent"} handoff`, async tv => {
            await holdClock(tv);
            const code = await openPassword(tv);
            tv.fake.approve(code);
            await tv.jump(5000);
            await tv.eventually(async () => tv.fake.devices.get(code)?.status === "consumed", "the phone approval");
            const starts = tv.fake.paths().filter(path => path === "POST /auth/device/start").length;
            if (action === "Back") {
                await tv.remote(BACK);
            } else {
                await tv.page.getByRole("button", { name: action, exact: true }).click();
            }
            await tv.page.clock.runFor(16);
            assert.equal(tv.fake.paths().filter(path => path === "POST /auth/device/start").length, starts, "returning preserves approval instead of requesting another code");
            assert.equal(await tv.screen(), "approved");
            await tv.jump(983);
            assert.equal(await handoffs(tv), 0, "the original one-second pause is retained");
            await tv.jump(1);
            if (sessionOnly) {
                await tv.page.getByRole("button", { name: "Continue", exact: true }).click();
            }
            await tv.eventually(async () => (await handoffs(tv)) === 1, "exactly one handoff");
            assert.equal(tv.fake.paths().filter(path => path === "POST /auth/device/start").length, starts);
        }, { sessionOnly });
    }
}

for (const lateReply of ["superseded", "failed"] as const) {
    tvTest(`a completed phone handoff survives a late ${lateReply} password reply`, async tv => {
        await holdClock(tv);
        const code = await openPassword(tv);
        if (lateReply === "failed") {
            tv.fake.script("/auth/login", { status: 401, headers: { "Content-Type": "application/problem+json" }, body: fixture("login_invalid_credentials") });
        }
        const hold = tv.fake.hold("/auth/login", true);
        await tv.page.fill("#signin-username", "laura");
        await tv.page.fill("#signin-password", FAKE_PASSWORD);
        await tv.page.getByRole("button", { name: "Sign in", exact: true }).click();
        await shows(tv, "Signing in…");
        const approval = tv.page.waitForResponse(async reply => {
            if (!new URL(reply.url()).pathname.endsWith("/auth/device/poll")) return false;
            const body: unknown = await reply.json();
            return typeof body === "object" && body !== null && "status" in body && body.status === "approved";
        });
        tv.fake.approve(code);
        await tv.jump(5000);
        await tv.eventually(async () => tv.fake.devices.get(code)?.status === "consumed", "the phone approval");
        // The fake consumes the code before its response reaches the client.
        assert.equal(await (await approval).finished(), null);
        await tv.page.clock.runFor(0);
        await tv.jump(1000);
        await tv.page.getByRole("button", { name: "Continue", exact: true }).waitFor();
        const response = tv.page.waitForResponse(reply => new URL(reply.url()).pathname.endsWith("/auth/login"));
        hold.release();
        await (await response).finished();
        await tv.page.clock.runFor(16);
        assert.equal(await tv.page.getByRole("button", { name: "Continue", exact: true }).count(), 1, "the phone's completed handoff owns the screen");
        await tv.page.getByRole("button", { name: "Continue", exact: true }).click();
        await tv.eventually(async () => (await handoffs(tv)) === 1, "one handoff");
        if (lateReply === "superseded") {
            await tv.eventually(async () => tv.fake.revokedSessions.size === 1, "the superseded password session to be revoked");
        }
    }, { sessionOnly: true });
}

tvTest("leaving during a password sign-in revokes its late answer and hands nothing over", async (tv) => {
    await openPassword(tv);
    await tv.page.fill("#signin-username", "laura");
    await tv.page.fill("#signin-password", FAKE_PASSWORD);
    const hold = tv.fake.hold("/auth/login", true);
    await tv.page.getByRole("button", { name: "Sign in", exact: true }).click();
    await shows(tv, "Signing in…");
    await tv.page.evaluate(() => window.harness.destroy());
    hold.release();
    await tv.eventually(async () => tv.fake.revokedSessions.size === 1, "the late session to be revoked");
    assert.equal(await handoffs(tv), 0);
    assert.equal(await tv.page.evaluate(() => window.harness.keyManager?.items.size), 0);
});

tvTest("a password sign-in without secure storage warns before continuing, as a code sign-in does", async (tv) => {
    await openPassword(tv);
    await tv.page.fill("#signin-username", "laura");
    await tv.page.fill("#signin-password", FAKE_PASSWORD);
    await tv.page.getByRole("button", { name: "Sign in", exact: true }).click();
    await shows(tv, "Signed in as laura");
    await shows(tv, "This TV can't store your sign-in securely, so you will need to sign in again after the app closes.");
    assert.equal(await handoffs(tv), 0);
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => (await handoffs(tv)) === 1, "the handoff");
}, { sessionOnly: true });

tvTest("a password account that must reset its password is handed on, and the session stays", async (tv) => {
    tv.fake.passwordChangeRequired = true;
    await openPassword(tv);
    await tv.page.fill("#signin-username", "laura");
    await tv.page.fill("#signin-password", FAKE_PASSWORD);
    await tv.page.getByRole("button", { name: "Sign in", exact: true }).click();
    await tv.eventually(async () => (await handoffs(tv)) === 1, "the handoff");
    assert.equal(tv.fake.revokedSessions.size, 0, "the session stays; the profile picker shows the refusal");
    assert.equal(await tv.page.evaluate(() => window.harness.keyManager?.items.size), 1);
});

tvTest("a server that turned password sign-in off shows no password button", async (tv) => {
    tv.fake.script("/auth/providers", { status: 200, body: { ...fixture("list_auth_providers_ok"), password_login: false } });
    await connectTo(tv);
    await codeScreen(tv);
    await tv.eventually(async () => tv.fake.paths().includes("GET /auth/providers"), "discovery");
    await tv.page.evaluate(() => undefined);
    assert.equal(await tv.page.getByRole("button", { name: "Sign in with a password" }).count(), 0);
    assert.equal(await tv.focused(), "change");
});

tvTest("failed discovery keeps the password button, as on the Apple TV app", async (tv) => {
    tv.fake.script("/auth/providers", { status: 500, body: {} }, { status: 500, body: {} });
    await connectTo(tv);
    await codeScreen(tv);
    await shows(tv, "Sign in with a password");
});

const unavailableDeviceCases: readonly { name: string; path: string; reply: Reply; focus: "username" | "phone" }[] = [
    { name: "disabled capability", path: "/auth/device/capability", reply: { status: 200, body: { ...fixture("get_device_login_capability_ok"), state: "disabled" } }, focus: "username" },
    { name: "unsupported capability", path: "/auth/device/capability", reply: problem(404, "not_found", "Not found"), focus: "username" },
    { name: "refused start", path: "/auth/device/start", reply: problem(403, "not_permitted", "Not permitted"), focus: "username" },
    { name: "unsupported start", path: "/auth/device/start", reply: problem(404, "not_found", "Not found"), focus: "username" },
    { name: "disabled capability with phone focused", path: "/auth/device/capability", reply: { status: 200, body: { ...fixture("get_device_login_capability_ok"), state: "disabled" } }, focus: "phone" },
];

for (const scenario of unavailableDeviceCases) {
    tvTest(`late ${scenario.name} preserves the live password fields`, async tv => {
        const hold = tv.fake.hold(scenario.path);
        tv.fake.script(scenario.path, scenario.reply);
        await connectTo(tv);
        await tv.page.getByRole("button", { name: "Sign in with a password", exact: true }).click();
        await passwordScreen(tv);
        await tv.page.fill("#signin-username", "laura");
        await tv.page.fill("#signin-password", FAKE_PASSWORD);
        await tv.page.locator(`[data-focus="${scenario.focus}"]`).focus();
        const username = await tv.page.locator("#signin-username").elementHandle();
        const password = await tv.page.locator("#signin-password").elementHandle();
        assert.ok(username);
        assert.ok(password);
        hold.release();
        await shows(tv, "This server only supports password sign-in.");
        assert.equal(await username.evaluate(node => node.isConnected), true, "the active TV keyboard keeps its input");
        assert.equal(await password.evaluate(node => node.isConnected), true);
        assert.equal(await tv.page.locator("#signin-username").inputValue(), "laura");
        assert.equal(await tv.page.locator("#signin-password").inputValue(), FAKE_PASSWORD);
        assert.equal(await tv.focused(), scenario.focus === "phone" ? "signin" : "username");
        assert.equal(await tv.page.getByRole("button", { name: "Use your phone instead", exact: true }).count(), 0);
        assert.equal(await tv.page.locator(".signin-hint").isVisible(), false);
        if (scenario.focus === "username") {
            await tv.remote(IME_DONE);
            assert.equal(await tv.focused(), "secret");
            await tv.remote(IME_DONE);
            assert.equal(await tv.focused(), "signin");
        }
        await tv.page.keyboard.press("ArrowRight");
        assert.equal(await tv.focused(), "change", "the removed phone route is absent from remote navigation");
        await tv.remote(BACK);
        assert.equal(await tv.screen(), "entry", "Back uses the password-only route");
    });
}

tvTest("late device unavailability preserves an in-flight password form and its Back guard", async tv => {
    const capability = tv.fake.hold("/auth/device/capability");
    tv.fake.script("/auth/device/capability", { status: 200, body: { ...fixture("get_device_login_capability_ok"), state: "disabled" } });
    await connectTo(tv);
    await tv.page.getByRole("button", { name: "Sign in with a password", exact: true }).click();
    await passwordScreen(tv);
    await tv.page.fill("#signin-username", "laura");
    await tv.page.fill("#signin-password", FAKE_PASSWORD);
    const response = tv.fake.hold("/auth/login");
    await tv.page.getByRole("button", { name: "Sign in", exact: true }).click();
    await shows(tv, "Signing in…");
    const username = await tv.page.locator("#signin-username").elementHandle();
    assert.ok(username);
    capability.release();
    await shows(tv, "This server only supports password sign-in.");
    assert.equal(await username.evaluate(node => node.isConnected), true);
    await tv.remote(BACK);
    assert.equal(await tv.screen(), "credentials");
    assert.equal(await tv.page.evaluate(() => window.harness.lastKeyPrevented), true);
    assert.equal(loginRequests(tv), 1);
    response.release();
    await tv.eventually(async () => (await handoffs(tv)) === 1, "the original password handoff");
});

tvTest("late provider discovery updates the hint without replacing the active password fields", async tv => {
    const hold = tv.fake.hold("/auth/providers");
    await openPassword(tv);
    await tv.page.fill("#signin-username", "laura");
    await tv.page.fill("#signin-password", FAKE_PASSWORD);
    await tv.page.locator("#signin-username").focus();
    const username = await tv.page.locator("#signin-username").elementHandle();
    const password = await tv.page.locator("#signin-password").elementHandle();
    assert.ok(username);
    assert.ok(password);
    hold.release();
    await shows(tv, "If you sign in with Example SSO, use your phone instead.");
    assert.equal(await username.evaluate(node => node.isConnected), true, "provider discovery keeps the input and TV keyboard alive");
    assert.equal(await password.evaluate(node => node.isConnected), true);
    assert.equal(await tv.focused(), "username");
    assert.equal(await tv.page.locator("#signin-username").inputValue(), "laura");
    assert.equal(await tv.page.locator("#signin-password").inputValue(), FAKE_PASSWORD);
});

tvTest("late provider discovery preserves the session-only password handoff", async tv => {
    const hold = tv.fake.hold("/auth/providers");
    await openPassword(tv);
    await tv.page.fill("#signin-username", "laura");
    await tv.page.fill("#signin-password", FAKE_PASSWORD);
    await tv.page.getByRole("button", { name: "Sign in", exact: true }).click();
    await shows(tv, "This TV can't store your sign-in securely, so you will need to sign in again after the app closes.");
    const response = tv.page.waitForResponse(reply => new URL(reply.url()).pathname.endsWith("/auth/providers"));
    hold.release();
    await (await response).finished();
    await tv.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    assert.equal(await tv.page.getByRole("button", { name: "Continue", exact: true }).count(), 1, "the completed sign-in keeps its handoff action");
    await tv.page.getByRole("button", { name: "Continue", exact: true }).click();
    await tv.eventually(async () => (await handoffs(tv)) === 1, "the handoff");
}, { sessionOnly: true });

// --- The Apple TV Marquee layout (TVServerSetupView.manualEntry, TVLoginView, MarqueeTV*) ---

async function style(tv: Tv, selector: string, ...names: string[]): Promise<string[]> {
    return tv.page.locator(selector).first().evaluate((node, keys) => {
        const computed = getComputedStyle(node);
        return keys.map((key) => computed.getPropertyValue(key));
    }, names);
}

/** Layout box, before any focus transform: the source frame, not the scaled one. */
async function box(tv: Tv, selector: string): Promise<{ width: number; height: number; x: number }> {
    return tv.page.locator(selector).first().evaluate((node) => {
        if (!(node instanceof HTMLElement)) {
            throw new Error("not an element");
        }
        let x = 0;
        for (let at: HTMLElement | null = node; at !== null; at = at.offsetParent instanceof HTMLElement ? at.offsetParent : null) {
            x += at.offsetLeft;
        }
        return { width: node.offsetWidth, height: node.offsetHeight, x };
    });
}

tvTest("the address screen is the Apple TV manual entry: headline, lead, field, Advanced options and the keyboard card", async (tv) => {
    assert.equal(await tv.page.locator("h1").innerText(), "Enter your\nserver address");
    await shows(tv, "Type the address you use for Silo.");
    assert.equal(await tv.page.locator("#signin-address").getAttribute("placeholder"), "media.example.com");
    assert.equal(await tv.page.locator("#signin-address").getAttribute("aria-label"), "Server address");
    assert.equal(await tv.page.locator(".marquee-chip").innerText(), "Living room TV", "the TV's name sits top right");
    assert.equal(await tv.page.locator(".signin-wordmark").getAttribute("alt"), "Silo");
    await shows(tv, "Type with a keyboard");
    await shows(tv, "When you select a field, this TV's on-screen keyboard opens. You can also type on a USB or Bluetooth keyboard connected to the TV.");
    assert.equal(await tv.page.getByText("phone", { exact: false }).count(), 0, "no phone or notification is promised");

    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), "advanced");
    assert.equal(await tv.page.locator('[data-focus="advanced"]').innerText(), "Advanced options");
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.focused(), "advanced", "the toggle keeps focus");
    assert.equal(await tv.page.locator('[data-focus="advanced"]').innerText(), "Hide advanced options");
    assert.equal(await tv.page.locator("#signin-port").getAttribute("placeholder"), "Port: auto");
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), "scheme-auto", "entering the row lands on the chosen protocol");
    assert.equal(await tv.page.locator('[data-focus="scheme-auto"]').getAttribute("aria-pressed"), "true");
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.focused(), "scheme-https");
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.focused(), "scheme-http");
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.focused(), "port");
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), "connect", "entering the action row lands on Connect");
    await tv.page.keyboard.press("ArrowUp");
    assert.equal(await tv.focused(), "scheme-auto");
    await tv.page.keyboard.press("ArrowUp");
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.page.locator("#signin-port").count(), 0, "hiding the options removes them");
});

tvTest("HTTP and a port chosen in Advanced options connect over plain HTTP without asking", async (tv) => {
    await tv.page.fill("#signin-address", "silo.example.test");
    await tv.page.keyboard.press("ArrowDown");
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-focus="scheme-http"]').focus();
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.page.locator('[data-focus="scheme-http"]').getAttribute("aria-pressed"), "true");
    assert.equal(await tv.focused(), "scheme-http", "choosing a protocol keeps focus on it");
    await tv.page.fill("#signin-port", "8096");
    await tv.remote(IME_DONE);
    assert.equal(await tv.focused(), "connect", "Done on the port moves to Connect");
    await tv.page.keyboard.press("Enter");
    await signIn(tv);
    assert.equal(tv.blocked, 0, "nothing was tried over HTTPS");
    assert.equal(await tv.page.evaluate(() => window.harness.storage.getItem("silo.native.server")), "http://silo.example.test:8096");
}, { origin: "http://silo.example.test:8096" });

tvTest("HTTPS chosen in Advanced options never offers plain HTTP, and a bad port sends nothing", async (tv) => {
    await tv.page.fill("#signin-address", "silo.example.test");
    await tv.page.keyboard.press("ArrowDown");
    await tv.page.keyboard.press("Enter");
    await tv.page.fill("#signin-port", "70000");
    await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
    await shows(tv, "Port must be a number between 1 and 65535.");
    assert.equal(await tv.page.locator(".marquee-error").count(), 1);
    // Previously a bad Port field outlined the address and took focus. The outline stays; focus stays on Connect.
    assert.equal(await tv.page.locator(".signin-field-error #signin-port").count(), 1, "the Port field shows the error");
    assert.equal(await tv.page.locator(".signin-field-error #signin-address").count(), 0);
    assert.equal(await tv.focused(), "connect", "a bad Port leaves focus on Connect");
    assert.equal(tv.blocked, 0);
    await tv.page.fill("#signin-port", "");
    await tv.page.locator('[data-focus="scheme-https"]').click();
    await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
    await connectFails(tv, "Could not reach a Silo server at that address.");
    assert.ok(tv.blocked > 0, "HTTPS was tried");
    assert.deepEqual(tv.fake.requests, [], "nothing was sent unencrypted");
}, { origin: PLAIN });

tvTest("a port typed into the address outlines the address and opens nothing", async (tv) => {
    await tv.page.fill("#signin-address", "silo.example.test:70000");
    await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
    await shows(tv, "Port must be a number between 1 and 65535.");
    assert.equal(await tv.page.locator(".signin-field-error #signin-address").count(), 1);
    assert.equal(await tv.page.locator("#signin-port").count(), 0, "advanced options stay closed");
    assert.equal(await tv.focused(), "connect", "a port typed into the address leaves focus on Connect");
    assert.equal(tv.blocked, 0);
});

tvTest("the code screen carries the server card, and late branding renames it in place", async (tv) => {
    const hold = tv.fake.hold("/theme/branding");
    tv.fake.script("/theme/branding", { status: 200, body: { server_name: "Family Cinema" } });
    await connectTo(tv);
    await codeScreen(tv);
    const card = tv.page.locator(".marquee-server-card");
    assert.equal(await card.locator(".marquee-server-name").innerText(), "silo.example.test");
    assert.equal(await card.locator(".marquee-server-address").innerText(), "silo.example.test");
    assert.equal(await card.locator(".marquee-badge").innerText(), "SECURE");
    assert.equal(await card.locator(".marquee-server-mark").innerText(), "S");
    const qr = await tv.page.locator(".signin-qr").elementHandle();
    assert.ok(qr);
    hold.release();
    await tv.eventually(async () => (await tv.page.locator("h1").innerText()) === "Sign in to Family Cinema", "the branded headline");
    assert.equal(await card.locator(".marquee-server-name").innerText(), "Family Cinema");
    assert.equal(await card.locator(".marquee-server-mark").innerText(), "F");
    assert.equal(await qr.evaluate((node) => node.isConnected), true, "the code is not redrawn");
    assert.equal(await tv.focused(), "password");
    await qr.dispose();
});

tvTest("a plain-HTTP server's card says HTTP", async (tv) => {
    await connectTo(tv, PLAIN);
    await codeScreen(tv);
    const badge = tv.page.locator(".marquee-server-card .marquee-badge");
    assert.equal(await badge.innerText(), "HTTP");
    assert.equal(await badge.evaluate((node) => node.classList.contains("marquee-badge-warning")), true);
    const open = await badge.locator("svg path").evaluateAll(paths => {
        const body = (paths[0] as SVGPathElement).getBBox();
        const shackle = paths[1] as SVGPathElement;
        const end = shackle.getPointAtLength(shackle.getTotalLength());
        return { right: body.x + body.width, top: body.y, x: end.x, y: end.y };
    });
    assert.ok(open.x >= open.right + 2 && open.y <= open.top - 2, "the open shackle is visibly outside the lock body");
}, { origin: PLAIN });

tvTest("the cleartext alert preserves the measured Apple dimming and translucent surface", async tv => {
    await connectTo(tv, "silo.example.test");
    await asksForCleartext(tv);
    const appearance = await tv.page.evaluate(() => {
        const behind = document.querySelector(".signin-behind");
        const alert = document.querySelector(".signin-alert");
        if (behind === null || alert === null) throw new Error("cleartext alert missing");
        const surface = getComputedStyle(alert);
        return { opacity: getComputedStyle(behind).opacity, background: surface.backgroundColor, blur: surface.backdropFilter };
    });
    assert.equal(appearance.opacity, "0.55");
    assert.equal(appearance.background, "rgba(17, 17, 20, 0.6)");
    assert.equal(appearance.blur, "blur(30px)");
}, { origin: PLAIN });

tvTest("the cleartext dialog and buttons match measured Apple frames", async tv => {
    await connectTo(tv, "silo.example.test");
    await asksForCleartext(tv);
    const frames = await tv.page.locator(".signin-alert").evaluate(node => {
        const b = node.getBoundingClientRect();
        const title = node.querySelector(".signin-alert-title")?.getBoundingClientRect();
        return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height), title: title === undefined ? undefined : { x: Math.round(title.x), y: Math.round(title.y), width: Math.round(title.width), height: Math.round(title.height) }, buttons: Array.from(node.querySelectorAll("button")).map(button => { const b = button.getBoundingClientRect(); return { y: Math.round(b.y), height: Math.round(b.height) }; }) };
    });
    assert.deepEqual(frames, { x: 667, y: 375, width: 586, height: 330, title: { x: 714, y: 421, width: 492, height: 37 }, buttons: [{ y: 608, height: 66 }, { y: 608, height: 66 }] });
    assert.deepEqual(await style(tv, '.signin-alert [data-focus="connect"]', "font-size"), ["30px"]);
}, { origin: PLAIN });

tvTest("code instructions use measured Apple line spacing with the licensed font", async tv => {
    await connectTo(tv);
    await codeScreen(tv);
    assert.deepEqual(await style(tv, ".marquee-lead", "font-size", "line-height"), ["27px", "35.5px"]);
    assert.deepEqual(await style(tv, ".marquee-actions", "margin-top"), ["98.4px"], "the unsupported nearby hint retains its reference layout space");
});

tvTest("code and server cards compensate for measured substitute-font advances", async tv => {
    await connectTo(tv);
    await codeScreen(tv);
    assert.deepEqual(await style(tv, ".marquee-server-address", "font-size", "line-height"), ["24px", "28px"]);
    assert.deepEqual(await style(tv, ".marquee-server-card", "padding-top", "padding-bottom"), ["23px", "23px"]);
    assert.deepEqual(await style(tv, ".marquee-badge .marquee-icon", "width", "height"), ["18px", "18px"]);
    assert.deepEqual(await style(tv, ".signin-code", "letter-spacing", "margin-top"), ["1.25px", "33px"]);
    assert.deepEqual(await style(tv, ".signin-typed-url", "font-size", "line-height"), ["22.7px", "29px"]);
    assert.deepEqual(await style(tv, ".signin-status", "margin-top", "line-height"), ["28px", "32px"]);
    assert.deepEqual(await style(tv, ".signin-status .marquee-spinner", "width", "height"), ["36px", "36px"]);
    assert.equal((await tv.page.locator(".signin-status").boundingBox())?.height, 32, "the measured indicator does not move the code card's text line");
    assert.deepEqual(await style(tv, ".marquee-card", "padding-top", "padding-bottom"), ["51px", "52.6px"]);
});

tvTest("the password screen keeps one supported keyboard paragraph in the companion card", async (tv) => {
    await openPassword(tv);
    // TVLoginView disables show/hide unless the password or the button has focus; disabled Marquee buttons draw at 0.45.
    assert.equal(await tv.focused(), "username");
    assert.deepEqual(await style(tv, ".signin-toggle", "opacity"), ["0.45"]);
    await tv.page.locator("#signin-password").focus();
    assert.deepEqual(await style(tv, ".signin-toggle", "opacity"), ["1"]);
    // Resting glass: the source's 8% white fill plus an 8% lift measured against Apple TV frames.
    assert.match((await style(tv, '[data-focus="signin"]', "background-image"))[0] ?? "", /rgba\(255, 255, 255, 0\.08\)/);
    // Apple TV frames: the show-password button is 124 wide, its eye about 38.
    assert.equal(await tv.page.locator(".signin-toggle .marquee-icon").evaluate((node) => node.getBoundingClientRect().width), 44);
    assert.equal(await tv.page.locator(".marquee-server-card").count(), 1);
    await shows(tv, "Type with a keyboard");
    assert.equal(await tv.page.locator(".marquee-card-text").count(), 1, "the replacement keeps Apple's single-paragraph card layout");
    assert.equal(await tv.page.locator("#signin-username").evaluate((node) => node.parentElement?.querySelector("svg") !== null), true, "fields carry their icon");
});

tvTest("a password-only server's keyboard card has no phone route", async (tv) => {
    tv.fake.script("/auth/device/capability", { status: 200, body: { ...fixture("get_device_login_capability_ok"), state: "disabled" } });
    await connectTo(tv);
    await passwordScreen(tv);
    await shows(tv, "Type with a keyboard");
    assert.equal(await tv.page.getByText("Rather not type?", { exact: false }).count(), 0);
});

tvTest("the sign-in screens use the Apple TV Marquee metrics", async (tv) => {
    // MarqueeTVScreen: 90 x 60 padding, the 150-wide wordmark asset, copy 900 wide.
    assert.deepEqual(await style(tv, ".signin-screen", "padding-top", "padding-left"), ["60px", "90px"]);
    await tv.eventually(async () => tv.page.locator(".signin-wordmark").evaluate((node) => node instanceof HTMLImageElement && node.complete && node.naturalWidth === 764), "the wordmark asset");
    // SiloWordmarkView(width: 150) scaled to fit the 64-high top row: the 764x400 asset draws 122x64.
    assert.deepEqual([(await box(tv, ".signin-wordmark")).width, (await box(tv, ".signin-wordmark")).height], [150, 64]);
    assert.deepEqual(await style(tv, ".signin-wordmark", "object-fit"), ["contain"]);
    assert.equal(await tv.page.locator(".marquee-body").evaluate((node) => node.getBoundingClientRect().top), 124, "the body starts under the 64-high top row");
    assert.equal((await box(tv, ".marquee-copy")).width, 900);
    assert.equal(await tv.page.locator("#root > .marquee-backdrop canvas").count(), 1, "the brand light sits behind the screen");
    // Hero 88 heavy, kerning -2; lead 28 at 62% ink.
    assert.deepEqual(await style(tv, "h1", "font-size", "font-weight", "letter-spacing"), ["88px", "800", "-2px"]);
    // SwiftUI sets no line height; Apple TV frames measure 106 px between the headline's baselines.
    assert.deepEqual(await style(tv, "h1", "line-height"), ["105.6px"]);
    assert.deepEqual(await style(tv, ".marquee-lead", "font-size", "color", "line-height"), ["28px", "rgba(237, 237, 237, 0.62)", "34px"]);
    // MarqueeTVField: 760 x 84, corner 16, font 30.
    const field = await box(tv, ".marquee-field");
    assert.deepEqual([field.width, field.height], [760, 84]);
    assert.deepEqual(await style(tv, ".marquee-field", "border-top-left-radius"), ["16px"]);
    assert.deepEqual(await style(tv, "#signin-address", "font-size"), ["30px"]);
    // MarqueeTVCard: 640 wide, padding 52, corner 40.
    assert.equal((await box(tv, ".marquee-card")).width, 640);
    assert.deepEqual(await style(tv, ".marquee-card", "padding-top", "border-top-left-radius"), ["52px", "40px"]);
    assert.equal((await box(tv, ".marquee-card .marquee-symbol")).width, 112);
    // Buttons 76 high, font 29.
    assert.equal((await box(tv, '[data-focus="connect"]')).height, 76);
    assert.deepEqual(await style(tv, '[data-focus="connect"]', "font-size"), ["29px"]);

    await connectTo(tv);
    await codeScreen(tv);
    // The QR code: 360 plus a 30 quiet zone on a white panel, corner 24; code 72 bold monospaced.
    const frame = await box(tv, ".signin-qr-frame");
    assert.deepEqual([frame.width, frame.height], [420, 420]);
    assert.deepEqual(await style(tv, ".signin-qr-frame", "background-color", "border-top-left-radius"), ["rgb(255, 255, 255)", "24px"]);
    assert.deepEqual(await style(tv, ".signin-code", "font-size", "font-weight"), ["72px", "700"]);
    assert.match((await style(tv, ".signin-code", "font-family"))[0] ?? "", /monospace/);
    assert.ok((await box(tv, ".marquee-card")).x > (await box(tv, ".marquee-copy")).x + 900, "the card sits right of the copy");
    // The substitute face uses 24px address text to match Apple's measured advance.
    assert.equal((await box(tv, ".marquee-server-mark")).width, 80);
    assert.deepEqual(await style(tv, ".marquee-server-name", "font-size", "font-weight"), ["34px", "700"]);
    assert.deepEqual(await style(tv, ".marquee-server-address", "font-size"), ["24px"]);
});

// --- Approval, branding and the backdrop ---

/** Stops the page clock flowing on its own, so only jumps move it. */
async function holdClock(tv: Tv): Promise<void> {
    // The target must remain in the future across the browser protocol round trip.
    await tv.page.clock.pauseAt(await tv.page.evaluate(() => Date.now()) + CLOCK_PROTOCOL_MARGIN_MS);
}

tvTest("an approval says Signed in as … for a second before the account moves on", async (tv) => {
    await connectTo(tv);
    const code = await codeScreen(tv);
    await holdClock(tv);
    tv.fake.approve(code);
    await tv.jump(5000);
    await shows(tv, "Signed in as laura");
    assert.equal(await tv.page.locator(".marquee-card .marquee-symbol-success").count(), 1, "the card shows the green check");
    assert.equal(await tv.page.locator(".signin-qr").count(), 0);
    await tv.jump(999);
    assert.equal(await handoffs(tv), 0, "the name stays up for a second");
    await tv.jump(1);
    await tv.eventually(async () => (await handoffs(tv)) === 1, "the handoff");
    await tv.jump(5000);
    assert.equal(await handoffs(tv), 1, "once");
});

for (const action of ["Change server", "Back", "destroy"] as const) {
    tvTest(`${action} during the second after approval signs the account out and hands nothing over`, async (tv) => {
        await connectTo(tv);
        const code = await codeScreen(tv);
        await holdClock(tv);
        tv.fake.approve(code);
        await tv.jump(5000);
        await shows(tv, "Signed in as laura");
        if (action === "Change server") {
            await tv.page.getByRole("button", { name: "Change server" }).click();
        } else if (action === "Back") {
            await tv.remote(BACK);
        } else {
            await tv.page.evaluate(() => window.harness.destroy());
        }
        await tv.jump(2000);
        assert.equal(await handoffs(tv), 0, "no late handoff");
        await tv.eventually(async () => tv.fake.revokedSessions.size === 1, "the session to be revoked");
        assert.equal(await tv.page.evaluate(() => window.harness.keyManager?.items.size), 0);
    });
}

tvTest("the server's mark and accent come from its branding, in place and same-origin only", async (tv) => {
    const hold = tv.fake.hold("/theme/branding");
    tv.fake.script("/theme/branding", { status: 200, body: { server_name: "Family Cinema", mark_url: "/art/mark", accent_color: "#FF0000" } });
    await connectTo(tv);
    await codeScreen(tv);
    assert.equal(await tv.page.locator(".marquee-backdrop-tint-on").count(), 0, "no accent before branding");
    const qr = await tv.page.locator(".signin-qr").elementHandle();
    assert.ok(qr);
    hold.release();
    const mark = tv.page.locator(".marquee-server-card .marquee-server-mark img");
    await mark.waitFor({ state: "attached" });
    assert.equal(await mark.getAttribute("src"), "https://silo.example.test/art/mark");
    await tv.eventually(async () => mark.evaluate((node) => node.classList.contains("marquee-mark-loaded")), "the mark to load");
    assert.equal(await qr.evaluate((node) => node.isConnected), true, "the code is not redrawn");
    const tint = tv.page.locator(".marquee-backdrop-tint");
    assert.equal(await tint.evaluate((node) => node.classList.contains("marquee-backdrop-tint-on")), true);
    assert.match(await tint.evaluate((node) => node.style.backgroundImage), /rgba\(204, 61, 61, 0\.32\)/);

    await tv.page.getByRole("button", { name: "Sign in with a password" }).click();
    await passwordScreen(tv);
    assert.equal(await tv.page.locator(".marquee-server-mark img").getAttribute("src"), "https://silo.example.test/art/mark", "the password screen keeps the mark");
    await tv.page.getByRole("button", { name: "Change server" }).click();
    assert.equal(await tint.evaluate((node) => node.classList.contains("marquee-backdrop-tint-on")), false, "choosing a server drops the accent");
    await qr.dispose();
});

tvTest("branding that arrives during typing adds its mark without replacing the field", async (tv) => {
    const hold = tv.fake.hold("/theme/branding");
    tv.fake.script("/theme/branding", { status: 200, body: { server_name: "Family Cinema", mark_url: "art/mark" } });
    await openPassword(tv);
    const input = await tv.page.locator("#signin-username").elementHandle();
    assert.ok(input);
    await input.fill("laura");
    hold.release();
    await tv.page.locator(".marquee-server-mark img").waitFor({ state: "attached" });
    assert.equal(await input.evaluate((node) => node.isConnected), true);
    assert.equal(await tv.focused(), "username");
    assert.equal(await tv.page.inputValue("#signin-username"), "laura");
    await input.dispose();
});

tvTest("a mark from another origin, or one that fails to load, keeps the initial tile", async (tv) => {
    tv.fake.script("/theme/branding", { status: 200, body: { server_name: "Family Cinema", mark_url: "https://evil.example/mark.png" } });
    await connectTo(tv);
    await codeScreen(tv);
    await tv.eventually(async () => (await tv.page.locator(".marquee-server-name").innerText()) === "Family Cinema", "branding");
    assert.equal(await tv.page.locator(".marquee-server-mark img").count(), 0);
    assert.equal(tv.blocked, 0, "nothing was requested from the other origin");
    assert.equal(await tv.page.locator(".marquee-server-mark").innerText(), "F");
}, {});

tvTest("a mark that fails to load is removed and the initial stays", async (tv) => {
    tv.fake.script("/theme/branding", { status: 200, body: { server_name: "Family Cinema", mark_url: "/missing/mark.png" } });
    await connectTo(tv);
    await codeScreen(tv);
    await tv.eventually(async () => (await tv.page.locator(".marquee-server-name").innerText()) === "Family Cinema", "branding");
    await tv.eventually(async () => (await tv.page.locator(".marquee-server-mark img").count()) === 0, "the broken mark to go");
    assert.equal(await tv.page.locator(".marquee-server-mark").innerText(), "F");
});

async function lightSample(tv: Tv): Promise<number[]> {
    return tv.page.locator(".marquee-backdrop canvas").evaluate((node) => {
        // A fresh copy per read, so the app's canvas is never read back.
        const source = node as HTMLCanvasElement;
        const copy = document.createElement("canvas");
        copy.width = source.width;
        copy.height = source.height;
        const context = copy.getContext("2d");
        context?.drawImage(source, 0, 0);
        return Array.from(context?.getImageData(0, 0, copy.width, copy.height).data ?? []);
    });
}

tvTest("one backdrop stays behind every sign-in screen, its light moving with the stage, drifting, under grain and glass", async (tv) => {
    const backdrop = await tv.page.locator("#root > .marquee-backdrop").elementHandle();
    assert.ok(backdrop);
    assert.equal(await backdrop.getAttribute("data-stage"), "0");
    const grain = await tv.page.locator(".marquee-backdrop-grain").evaluate((node) => {
        const style = getComputedStyle(node);
        return [style.backgroundImage.slice(0, 26), style.backgroundSize, style.opacity];
    });
    assert.deepEqual(grain, ['url("data:image/png;base64', "48px 48px", "0.045"]);
    const first = await lightSample(tv);
    await tv.jump(2000);
    assert.notDeepEqual(await lightSample(tv), first, "the light drifts");

    await connectTo(tv);
    await codeScreen(tv);
    assert.equal(await backdrop.evaluate((node) => node.isConnected), true, "the same backdrop, not a new one");
    assert.equal(await backdrop.getAttribute("data-stage"), "1");
    assert.notEqual((await style(tv, ".marquee-card", "backdrop-filter"))[0], "none", "the card is glass");
    await tv.page.getByRole("button", { name: "Sign in with a password" }).click();
    await passwordScreen(tv);
    assert.equal(await backdrop.evaluate((node) => node.isConnected), true);

    // Hidden, nothing draws; visible again, it carries on.
    await tv.page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
    });
    const hidden = await lightSample(tv);
    await tv.jump(2000);
    assert.deepEqual(await lightSample(tv), hidden, "no frames while hidden");
    await tv.page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
    });
    await tv.jump(2000);
    assert.notDeepEqual(await lightSample(tv), hidden);

    await tv.page.evaluate(() => window.harness.destroy());
    assert.equal(await backdrop.evaluate((node) => node.isConnected), false, "teardown removes it");
    await backdrop.dispose();
});

tvTest("with Reduced Motion the light holds still", async (tv) => {
    await tv.page.emulateMedia({ reducedMotion: "reduce" });
    await tv.jump(100);
    const still = await lightSample(tv);
    await tv.jump(3000);
    assert.deepEqual(await lightSample(tv), still);
});

// --- Hidden screens, external sign-out and remembered branding ---

async function setHidden(tv: Tv, hidden: boolean): Promise<void> {
    await tv.page.evaluate((value) => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (value ? "hidden" : "visible") });
        document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
}

tvTest("sign-in started while hidden waits for visibility before requesting its first code", async (tv) => {
    await setHidden(tv, true);
    await connectTo(tv);
    await tv.page.waitForTimeout(200);
    const starts = (): number => tv.fake.paths().filter((path) => path === "POST /auth/device/start").length;
    assert.equal(starts(), 0);
    await setHidden(tv, false);
    await codeScreen(tv);
    assert.equal(starts(), 1);
});

tvTest("hidden, the code is not polled; back on screen it polls at once and codes renew for another hour", async (tv) => {
    await connectTo(tv);
    await codeScreen(tv);
    for (let renewal = 2; renewal <= 4; renewal++) {
        await tv.jump(15 * MINUTE);
        await tv.eventually(async () => tv.fake.devices.size === renewal, `renewal ${renewal}`);
    }
    const beforeHidePoll = polls(tv);
    await tv.jump(5 * MINUTE);
    await tv.eventually(async () => polls(tv) > beforeHidePoll, "poll triggered before hiding reaches the fake server");
    await setHidden(tv, true);
    const before = polls(tv);
    await tv.jump(20 * MINUTE);
    await tv.jump(20 * MINUTE);
    assert.equal(polls(tv), before, "nothing is polled while hidden");
    await setHidden(tv, false);
    await tv.eventually(async () => polls(tv) === before + 1, "a poll at once on return");
    // The code ran out while hidden; the hour restarted on return, so it renews instead of pausing.
    await tv.eventually(async () => tv.fake.devices.size === 5, "a renewal after return");
    await shows(tv, "New code. Waiting for approval.");
    assert.equal(await tv.page.getByText("Sign-in paused.").count(), 0);
});

tvTest("a failing start waits while hidden and tries again on return", async (tv) => {
    const outage = { status: 503 };
    tv.fake.script("/auth/device/start", outage);
    await connectTo(tv);
    const starts = (): number => tv.fake.paths().filter((path) => path === "POST /auth/device/start").length;
    await tv.eventually(async () => starts() === 1, "the first start");
    // Let the refusal land and its one-second retry be scheduled before hiding.
    await tv.page.waitForTimeout(200);
    await setHidden(tv, true);
    await tv.jump(60000);
    await tv.page.waitForTimeout(200);
    assert.equal(starts(), 1, "no start while hidden");
    await setHidden(tv, false);
    await codeScreen(tv);
    assert.equal(starts(), 2);
});

tvTest("a sign-out from elsewhere during the second after approval starts a new code and never hands the old account over", async (tv) => {
    await connectTo(tv);
    const code = await codeScreen(tv);
    await holdClock(tv);
    tv.fake.approve(code);
    await tv.jump(5000);
    await shows(tv, "Signed in as laura");
    await tv.page.evaluate(() => window.harness.signOutElsewhere());
    await tv.eventually(async () => tv.fake.devices.size === 2, "a new code");
    await codeScreen(tv);
    await shows(tv, "Waiting for approval");
    await tv.jump(2000);
    assert.equal(await handoffs(tv), 0, "no late handoff of the signed-out account");
    assert.equal(await tv.page.evaluate(() => window.harness.keyManager?.items.size), 0);
});

const BRANDING_KEY = "silo.native.serverBranding.v1";

tvTest("a server's branding is remembered between launches and shown at once, then refreshed", async (tv) => {
    tv.fake.script("/theme/branding", { status: 200, body: { server_name: "Family Cinema", mark_url: "/art/mark", accent_color: "#FF0000" } });
    await connectTo(tv);
    await codeScreen(tv);
    await tv.eventually(async () => (await tv.page.evaluate((key) => window.harness.storage.getItem(key), BRANDING_KEY)) !== null, "the branding to be remembered");

    const hold = tv.fake.hold("/theme/branding");
    tv.fake.script("/theme/branding", { status: 200, body: { server_name: "Family Cinema 2" } });
    await tv.page.evaluate(() => window.harness.mount());
    await codeScreen(tv);
    assert.equal(await tv.page.locator("h1").innerText(), "Sign in to Family Cinema", "the remembered name, before the server answers");
    assert.equal(await tv.page.locator(".marquee-server-mark img").getAttribute("src"), "https://silo.example.test/art/mark");
    assert.equal(await tv.page.locator(".marquee-backdrop-tint-on").count(), 1, "the remembered accent");
    hold.release();
    await tv.eventually(async () => (await tv.page.locator("h1").innerText()) === "Sign in to Family Cinema 2", "the fresh name");
    await tv.eventually(async () => (await tv.page.locator(".marquee-server-mark img").count()) === 0, "a mark the server no longer names goes");
    assert.equal(await tv.page.locator(".marquee-backdrop-tint-on").count(), 0);
});

tvTest("branding answered after leaving the server is neither shown nor remembered", async (tv) => {
    const hold = tv.fake.hold("/theme/branding");
    tv.fake.script("/theme/branding", { status: 200, body: { server_name: "Family Cinema" } });
    await connectTo(tv);
    await codeScreen(tv);
    await tv.page.getByRole("button", { name: "Change server" }).click();
    hold.release();
    await hold.released;
    // Give a late answer time to land: it must change nothing.
    await tv.page.waitForTimeout(300);
    await tv.jump(0);
    assert.equal(await tv.page.evaluate((key) => window.harness.storage.getItem(key), BRANDING_KEY), null);
    assert.equal(await tv.page.getByText("Family Cinema").count(), 0);
});

tvTest("a platform stylesheet that sets every element's font cannot replace Inter or the source weights", async (tv) => {
    // The Samsung TV simulator adds `*{font-family:SamsungOne;font-weight:600}` to the app's document.
    await tv.page.addStyleTag({ content: "*{font-family:SamsungOne;font-weight:600}" });
    await connectTo(tv);
    await codeScreen(tv);
    for (const [selector, weight] of [["h1", "800"], [".marquee-lead", "400"], [".marquee-server-name", "700"], [".marquee-server-address", "400"], [".signin-status-text", "400"], ['[data-focus="change"]', "500"]] as const) {
        const [family, actual] = await style(tv, selector, "font-family", "font-weight");
        assert.match(family ?? "", /^"?Inter"?,/, `${selector} keeps Inter`);
        assert.equal(actual, weight, `${selector} keeps its source weight`);
    }
    assert.match((await style(tv, ".signin-code", "font-family"))[0] ?? "", /monospace/, "the code stays monospaced");
});
