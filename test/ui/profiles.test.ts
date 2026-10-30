// The native profile screens, driven by remote keys in Chromium against the fake Silo: choosing,
// unlocking and switching household profiles, and leaving them when the sign-in ends.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { fixture } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

const BACK = 10009;
const IME_DONE = 65376;
const KID_PIN = "2468";

let browser: Browser;
before(async () => {
    browser = await launchBrowser();
});
after(async () => {
    await browser.close();
});

function tvTest(name: string, body: (tv: Tv) => Promise<void>): void {
    test(name, async () => {
        const tv = await openTv(browser, { profiles: true });
        try {
            await body(tv);
            assert.deepEqual(tv.console, [], "the page logs nothing");
        } finally {
            await tv.page.context().close();
        }
    });
}

async function shows(tv: Tv, text: string): Promise<void> {
    await tv.page.getByText(text).first().waitFor();
}

async function screenIs(tv: Tv, name: string): Promise<void> {
    await tv.page.locator(`[data-screen="${name}"]`).waitFor();
}

/** Connects and approves a code; the profile screens start once sign-in hands off. */
async function signIn(tv: Tv): Promise<void> {
    await tv.page.fill("#signin-address", "silo.example.test");
    await tv.page.keyboard.press("ArrowDown");
    await tv.page.keyboard.press("Enter");
    await screenIs(tv, "code");
    const code = [...tv.fake.devices.keys()].pop();
    assert.ok(code !== undefined);
    tv.fake.approve(code);
    await tv.jump(5000);
}

async function picker(tv: Tv): Promise<void> {
    await signIn(tv);
    await screenIs(tv, "profiles");
}

function handed(tv: Tv): Promise<{ readonly id: string; readonly generation: number }[]> {
    return tv.page.evaluate(() => window.harness.profiles);
}

async function handedCount(tv: Tv, count: number): Promise<void> {
    await tv.eventually(async () => (await handed(tv)).length === count, `${count} profile handoffs`);
}

function pinChecks(tv: Tv): number {
    return tv.fake.paths().filter((path) => path === "POST /profiles/p-kid/verify-pin").length;
}

/** Types a PIN on the TV keyboard, closes it with Done and presses Unlock. */
async function enterPin(tv: Tv, pin: string): Promise<void> {
    if ((await tv.focused()) === "unlock") {
        await tv.page.keyboard.press("ArrowUp");
    }
    assert.equal(await tv.focused(), "pin");
    await tv.page.keyboard.type(pin);
    await tv.remote(IME_DONE);
    assert.equal(await tv.focused(), "unlock");
    await tv.page.keyboard.press("Enter");
}

async function openKid(tv: Tv): Promise<void> {
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.focused(), "profile:p-kid");
    await tv.page.keyboard.press("Enter");
    await screenIs(tv, "pin");
}

function profile(id: string, name: string): Record<string, unknown> {
    const items = fixture("list_profiles_ok").items;
    const owner: unknown = Array.isArray(items) ? items[0] : undefined;
    if (typeof owner !== "object" || owner === null) {
        throw new Error("the fixture has no profile");
    }
    return { ...owner, id, name, has_pin: false, is_primary: false };
}

tvTest("long profile names remain fully visible and distinct", async (tv) => {
    const names = ["Alexandra Elizabeth Smith", "Alexandra Elizabeth Jones"];
    tv.fake.profiles = { ...tv.fake.profiles, items: names.map((name, index) => profile(`long-${index}`, name)) };
    await picker(tv);
    const geometry = await tv.page.locator(".profile-name").evaluateAll((nodes) => nodes.map((node) => ({
        height: node.clientHeight,
        fullHeight: node.scrollHeight,
        width: node.clientWidth,
        fullWidth: node.scrollWidth,
        overflow: getComputedStyle(node).overflow,
        textOverflow: getComputedStyle(node).textOverflow,
    })));
    assert.equal(geometry.length, 2);
    for (const name of geometry) {
        assert.ok(name.fullWidth <= name.width && name.fullHeight <= name.height, "the whole name must fit its visible box");
        assert.notEqual(name.textOverflow, "ellipsis");
    }
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.focused(), "profile:long-1");
});

tvTest("a profile without a PIN is chosen with the remote and handed to browse; Back on the first choice reaches the app", async (tv) => {
    const list = tv.fake.hold("/profiles");
    await signIn(tv);
    await screenIs(tv, "profiles-loading");
    assert.equal(await tv.focused(), "signout", "the loading screen has a focus target");
    list.release();
    await screenIs(tv, "profiles");
    await shows(tv, "Who's watching?");
    assert.equal(await tv.focused(), "profile:p-owner");
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.focused(), "profile:p-kid");
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.focused(), "profile:p-kid", "focus stops at the row's end");
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), "signout");
    await tv.page.keyboard.press("ArrowUp");
    assert.equal(await tv.focused(), "profile:p-owner");
    await tv.remote(BACK);
    assert.equal(await tv.page.evaluate(() => window.harness.lastKeyPrevented), false, "no profile to go back to: the app handles Back");

    await tv.page.keyboard.press("Enter");
    await handedCount(tv, 1);
    assert.equal((await handed(tv))[0]?.id, "p-owner");
    assert.equal(await tv.screen(), "browse");
    assert.equal(await tv.page.locator("[data-screen]").count(), 1, "the profile screens are gone");
    assert.equal(await tv.page.evaluate(() => window.harness.probe()), "painted");
    const probe = tv.fake.requests.filter((request) => request.path === "/catalog/probe").pop();
    assert.equal(probe?.headers["x-profile-id"], "p-owner");
});

tvTest("a large household wraps into rows that Up and Down move between", async (tv) => {
    const names = ["Ann", "Ben", "Cat", "Dan", "Eve", "Fay", "Gus"];
    tv.fake.profiles = { ...tv.fake.profiles, items: names.map((name, index) => profile(`p-${index + 1}`, name)) };
    await picker(tv);
    assert.equal(await tv.focused(), "profile:p-1");
    await tv.page.keyboard.press("ArrowRight");
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), "profile:p-7", "Down keeps the column where the next row has one");
    await tv.page.keyboard.press("ArrowLeft");
    assert.equal(await tv.focused(), "profile:p-6");
    await tv.page.keyboard.press("ArrowLeft");
    assert.equal(await tv.focused(), "profile:p-6", "Left does not wrap to the row above");
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), "signout");
    await tv.page.keyboard.press("ArrowUp");
    await tv.page.keyboard.press("ArrowUp");
    assert.equal(await tv.focused(), "profile:p-1");
});

tvTest("wrong PINs are reported, never kept or resent, and the right PIN unlocks the profile", async (tv) => {
    await tv.page.evaluate(() => {
        window.harness.storage.setItem("silo.native.deviceId", "01232468-89ab-4cde-8fab-0123456789ab");
    });
    await picker(tv);
    const deviceIdBeforePin = await tv.page.evaluate(() => window.harness.storage.getItem("silo.native.deviceId"));
    assert.equal(deviceIdBeforePin, "01232468-89ab-4cde-8fab-0123456789ab", "sign-in retains the synthetic install identity containing the PIN digits");
    await openKid(tv);
    await tv.page.getByRole("heading", { name: "Kid", exact: true }).waitFor();
    await tv.remote(IME_DONE);
    await tv.page.keyboard.press("Enter");
    await shows(tv, "Enter the PIN.");
    assert.equal(pinChecks(tv), 0, "an empty PIN is not sent");
    await tv.page.keyboard.press("ArrowUp");

    await enterPin(tv, "0000");
    await shows(tv, "That PIN is not right. Try again.");
    assert.equal(await tv.focused(), "unlock", "an asynchronous error does not move focus");
    assert.equal(await tv.page.inputValue("#profile-pin"), "", "the field is cleared after every check");
    assert.equal(pinChecks(tv), 1);

    await enterPin(tv, KID_PIN);
    await handedCount(tv, 1);
    assert.equal((await handed(tv))[0]?.id, "p-kid");
    assert.equal(pinChecks(tv), 2, "each PIN is sent once");
    assert.equal(await tv.page.evaluate(() => window.harness.probe()), "painted");
    const probe = tv.fake.requests.filter((request) => request.path === "/catalog/probe").pop();
    assert.equal(probe?.headers["x-profile-id"], "p-kid");
    assert.ok(probe?.headers["x-profile-token"]?.startsWith("pvt-"), "the proof goes with the profile");

    const kept = await tv.page.evaluate(() => {
        return {
            dom: document.documentElement.outerHTML,
            publicEntries: [...window.harness.storage.items],
            protectedValues: [...(window.harness.keyManager?.items.values() ?? [])],
        };
    });
    assert.equal(kept.publicEntries.find(([key]) => key === "silo.native.deviceId")?.[1], deviceIdBeforePin, "unlock leaves the public device ID unchanged");
    const stored = [
        ...kept.publicEntries.filter(([key]) => key !== "silo.native.deviceId").map(([, value]) => value),
        ...kept.protectedValues,
    ].join("\n");
    assert.ok(!kept.dom.includes(KID_PIN) && !stored.includes(KID_PIN), "the PIN stays nowhere except the unchanged public device ID's coincidental digits");
    const allStored = [...kept.publicEntries.map(([, value]) => value), ...kept.protectedValues].join("\n");
    assert.ok(!allStored.includes("pvt-"), "the PIN proof is kept in memory only");
});

tvTest("a lockout's Retry-After is shown and honored without sending checks, then the PIN works", async (tv) => {
    await picker(tv);
    await openKid(tv);
    for (let attempt = 1; attempt <= 5; attempt++) {
        await enterPin(tv, "0000");
        await shows(tv, "That PIN is not right. Try again.");
        assert.equal(pinChecks(tv), attempt);
        assert.equal(await tv.focused(), "unlock");
    }
    await enterPin(tv, KID_PIN);
    await shows(tv, "Too many wrong PINs. Try again in 5 minutes.");
    assert.equal(pinChecks(tv), 6);

    await tv.jump(240 * 1000);
    await enterPin(tv, KID_PIN);
    await shows(tv, "Too many wrong PINs. Try again in 60 seconds.");
    assert.equal(pinChecks(tv), 6, "no check is sent while locked");

    await tv.jump(60 * 1000);
    await enterPin(tv, KID_PIN);
    await handedCount(tv, 1);
    assert.equal(pinChecks(tv), 7);
});

tvTest("a PIN check with no answer, or a busy server, asks for the PIN again instead of resending it", async (tv) => {
    await picker(tv);
    await openKid(tv);
    tv.fake.dropNextAnswer("/profiles/p-kid/verify-pin");
    await enterPin(tv, KID_PIN);
    await shows(tv, "No answer from the server. Check the TV's internet connection, then enter the PIN again.");
    assert.equal(pinChecks(tv), 1);
    tv.fake.script("/profiles/p-kid/verify-pin", { status: 503, headers: { "Content-Type": "application/problem+json", "Retry-After": "30" }, body: fixture("rate_limited") });
    await enterPin(tv, KID_PIN);
    await shows(tv, "The server is busy. Wait 30 seconds, then enter the PIN again.");
    assert.equal(pinChecks(tv), 2);
    assert.equal((await handed(tv)).length, 0);
});

tvTest("an unsuccessful PIN answer preserves navigation to Choose another profile", async (tv) => {
    await picker(tv);
    await openKid(tv);
    const check = tv.fake.hold("/profiles/p-kid/verify-pin", true);
    await enterPin(tv, "0000");
    await shows(tv, "Checking the PIN.");
    await tv.page.keyboard.press("ArrowRight");
    assert.equal(await tv.focused(), "other");
    check.release();
    await shows(tv, "That PIN is not right. Try again.");
    assert.equal(await tv.focused(), "other", "the existing focused button survives the answer");
    await tv.page.keyboard.press("Enter");
    await screenIs(tv, "profiles");
    assert.equal(pinChecks(tv), 1);
});

tvTest("a late PIN answer never unlocks a profile the viewer left, and a second Unlock is not sent", async (tv) => {
    await picker(tv);
    await openKid(tv);
    const check = tv.fake.hold("/profiles/p-kid/verify-pin", true);
    await enterPin(tv, KID_PIN);
    await shows(tv, "Checking the PIN.");
    await tv.page.keyboard.press("Enter");
    assert.equal(pinChecks(tv), 1, "Unlock is ignored while a check is out");

    await tv.remote(BACK);
    await screenIs(tv, "profiles");
    assert.equal(await tv.focused(), "profile:p-kid", "focus returns to the profile it left");
    await tv.page.keyboard.press("ArrowLeft");
    await tv.page.keyboard.press("Enter");
    await handedCount(tv, 1);
    check.release();
    await tv.jump(0);
    assert.deepEqual((await handed(tv)).map((entry) => entry.id), ["p-owner"]);
    assert.equal(await tv.screen(), "browse");
    assert.equal(await tv.page.evaluate(() => window.harness.probe()), "painted");
    const probe = tv.fake.requests.filter((request) => request.path === "/catalog/probe").pop();
    assert.equal(probe?.headers["x-profile-id"], "p-owner");
    assert.equal(probe?.headers["x-profile-token"], undefined);
});

tvTest("switching ends the old profile's work before the PIN, its late answers never paint, and Back keeps the profile", async (tv) => {
    await picker(tv);
    await tv.page.keyboard.press("Enter");
    await handedCount(tv, 1);
    const read = tv.fake.hold("/catalog/probe", true);
    const late = tv.page.evaluate(() => window.harness.probe());
    await tv.eventually(async () => tv.fake.paths().includes("GET /catalog/probe"), "the owner's read to start");

    await tv.page.evaluate(() => window.harness.switchProfile());
    await screenIs(tv, "profiles");
    assert.equal(await tv.focused(), "profile:p-owner", "the current profile is focused");
    assert.equal(await tv.page.evaluate(() => window.harness.profileEnded(0)), false, "opening the picker alone changes nothing");
    await openKid(tv);
    assert.equal(await tv.page.evaluate(() => window.harness.profileEnded(0)), true, "the owner stops acting as soon as the switch starts");
    read.release();
    assert.notEqual(await late, "painted");
    assert.equal(await tv.page.locator("#browse-probe").count(), 0, "the owner's late answer paints nothing");

    await enterPin(tv, KID_PIN);
    await handedCount(tv, 2);
    const [owner, kid] = await handed(tv);
    assert.equal(kid?.id, "p-kid");
    assert.ok(owner !== undefined && kid !== undefined && kid.generation > owner.generation);

    await tv.page.evaluate(() => window.harness.switchProfile());
    await screenIs(tv, "profiles");
    assert.equal(await tv.focused(), "profile:p-kid");
    await tv.remote(BACK);
    await handedCount(tv, 3);
    assert.deepEqual((await handed(tv))[2], kid, "Back returns the same profile and authority");
    assert.equal(await tv.page.evaluate(() => window.harness.profileEnded(1)), false);
    assert.equal(pinChecks(tv), 1, "Back asked for no PIN");
});

tvTest("a changed PIN ends the profile's proof; the TV asks for the new PIN and refuses the old one", async (tv) => {
    await picker(tv);
    await openKid(tv);
    await enterPin(tv, KID_PIN);
    await handedCount(tv, 1);
    tv.fake.changePin("p-kid", "1357");
    assert.notEqual(await tv.page.evaluate(() => window.harness.probe()), "painted");
    await screenIs(tv, "pin");
    await shows(tv, "The PIN for this profile changed, or its unlock ended. Enter the PIN again.");
    assert.equal(await tv.page.evaluate(() => window.harness.profileEnded(0)), true);
    assert.equal(await tv.page.locator('[data-screen="browse"]').count(), 0, "the profile's content is gone");

    await enterPin(tv, KID_PIN);
    await shows(tv, "That PIN is not right. Try again.");
    await enterPin(tv, "1357");
    await handedCount(tv, 2);
    assert.equal(await tv.page.evaluate(() => window.harness.probe()), "painted");
});

tvTest("Sign out revokes the session and clears the TV; signing out while profiles load paints nothing late", async (tv) => {
    const list = tv.fake.hold("/profiles", true);
    await signIn(tv);
    await screenIs(tv, "profiles-loading");
    await tv.page.keyboard.press("Enter");
    await screenIs(tv, "entry");
    await shows(tv, "Signed out on this TV.");
    list.release();
    await tv.jump(0);
    assert.equal(await tv.screen(), "entry", "the late profile list is ignored");
    assert.deepEqual(await tv.page.evaluate(() => window.harness.signedOut), [{ storage: "cleared", server: "revoked" }]);
    assert.equal(tv.fake.revokedSessions.size, 1);
    assert.equal(await tv.page.evaluate(() => window.harness.keyManager?.items.size), 0);

    await picker(tv);
    await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), "signout");
    await tv.page.keyboard.press("Enter");
    await screenIs(tv, "entry");
    assert.equal(tv.fake.revokedSessions.size, 2);
    assert.equal((await handed(tv)).length, 0);
});

tvTest("an expired sign-in ends the profile and leads back to sign-in", async (tv) => {
    await picker(tv);
    await tv.page.keyboard.press("Enter");
    await handedCount(tv, 1);
    tv.fake.revokeAllSessions();
    tv.fake.expireAccessTokens();
    assert.notEqual(await tv.page.evaluate(() => window.harness.probe()), "painted");
    await screenIs(tv, "expired");
    await shows(tv, "Your sign-in on this TV ended. Sign in again to continue.");
    assert.equal(await tv.page.evaluate(() => window.harness.profileEnded(0)), true);
    assert.equal(await tv.focused(), "signin");
    assert.equal(await tv.page.evaluate(() => window.harness.keyManager?.items.size), 0);
    await tv.page.keyboard.press("Enter");
    await screenIs(tv, "entry");
    await shows(tv, "Signed out on this TV.");
    assert.equal(await tv.page.evaluate(() => window.harness.signedOut[0]?.storage), "cleared");
});

tvTest("signing out keeps a recoverable status focus without sending logout twice", async (tv) => {
    await picker(tv);
    const logout = tv.fake.hold("/auth/logout");
    await tv.page.keyboard.press("ArrowDown");
    await tv.page.keyboard.press("Enter");
    await screenIs(tv, "signing-out");
    assert.equal(await tv.focused(), "signing-out");
    await tv.page.keyboard.press("ArrowDown");
    await tv.page.keyboard.press("ArrowUp");
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.focused(), "signing-out");
    assert.equal(tv.fake.paths().filter((path) => path === "POST /auth/logout").length, 1);
    logout.release();
    await screenIs(tv, "entry");
});

tvTest("Sign in again waits for a queued credential clear before leaving profiles", async (tv) => {
    await picker(tv);
    await tv.page.keyboard.press("Enter");
    await handedCount(tv, 1);
    await tv.page.evaluate(() => {
        const { keyManager, server } = window.harness;
        if (keyManager === undefined || server === undefined) {
            throw new Error("protected signed-in session required");
        }
        window.harness.saveHold = keyManager.holdSaves();
        void server.session.refresh();
    });
    await tv.eventually(async () => (await tv.page.evaluate(() => window.harness.saveHold?.waiting())) === 1, "rotation storage to start");
    await tv.page.evaluate(() => { void window.harness.server?.session.logout(); });
    await screenIs(tv, "expired");
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.page.evaluate(() => window.harness.signedOut.length), 0, "handoff must wait for the older local clear");
    assert.equal(await tv.page.evaluate(() => window.harness.discoveryRequests), 1);
    await tv.page.evaluate(() => window.harness.saveHold?.release());
    await screenIs(tv, "entry");
    assert.equal(await tv.page.evaluate(() => window.harness.keyManager?.items.size), 0);
    assert.equal(await tv.page.evaluate(() => window.harness.signedOut[0]?.storage), "cleared");
    assert.equal(await tv.page.evaluate(() => window.harness.handoffs.length), 1, "no automatic restore");
});

tvTest("an expired account whose credential cannot be cleared reaches sign-in with the warning", async (tv) => {
    await picker(tv);
    await tv.page.keyboard.press("Enter");
    await handedCount(tv, 1);
    await tv.page.evaluate(() => {
        const { keyManager, storage } = window.harness;
        if (keyManager === undefined) { throw new Error("protected storage required"); }
        keyManager.failRemove = true;
        storage.failSet = true;
    });
    tv.fake.revokeAllSessions();
    tv.fake.expireAccessTokens();
    await tv.page.evaluate(() => window.harness.probe());
    await screenIs(tv, "expired");
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => (await tv.page.evaluate(() => window.harness.signedOut.length)) === 1, "the sign-out handoff");
    assert.equal(await tv.page.evaluate(() => window.harness.signedOut[0]?.storage), "failed");
    await screenIs(tv, "entry");
    await shows(tv, "If that account appears after the app restarts, sign out of it.");
    assert.equal(await tv.page.evaluate(() => window.harness.discoveryRequests), 1, "failed cleanup never reconnects automatically");
});

tvTest("an authority callback destroyed by an earlier listener cannot replace its successor", async (tv) => {
    await picker(tv);
    const result = await tv.page.evaluate(async () => {
        const harness = window.harness;
        const server = harness.server;
        const root = document.getElementById("root");
        if (server === undefined || root === null) { throw new Error("profile flow required"); }
        harness.profileController?.destroy();
        let controller: ReturnType<typeof harness.mountProfiles> | undefined;
        const stop = server.session.onAuthorityChange((change) => {
            if (change.reason === "signed_out") {
                controller?.destroy();
                harness.mount({ storage: "cleared", server: "not_signed_in" });
            }
        });
        controller = harness.mountProfiles(root, { server, onSelected: () => undefined, onSignedOut: () => undefined });
        await server.session.logout();
        stop();
        return { screen: document.querySelector("[data-screen]")?.getAttribute("data-screen"), styled: root.classList.contains("signin") };
    });
    assert.deepEqual(result, { screen: "entry", styled: true });
});

tvTest("repeated profile teardown preserves a successor sign-in screen and its styling", async (tv) => {
    await picker(tv);
    const result = await tv.page.evaluate(async () => {
        const harness = window.harness;
        const server = harness.server;
        const root = document.getElementById("root");
        if (server === undefined || root === null) { throw new Error("profile flow required"); }
        harness.profileController?.destroy();
        let complete = (): void => undefined;
        const handedBack = new Promise<void>((resolve) => { complete = resolve; });
        const controller = harness.mountProfiles(root, { server, onSelected: () => undefined, onSignedOut: (notice) => { harness.mount(notice); complete(); } });
        const signOut = document.querySelector('[data-focus="signout"]');
        if (!(signOut instanceof HTMLElement)) { throw new Error("sign-out control required"); }
        signOut.click();
        await handedBack;
        controller.destroy();
        return { screen: document.querySelector("[data-screen]")?.getAttribute("data-screen"), styled: root.classList.contains("signin") };
    });
    assert.deepEqual(result, { screen: "entry", styled: true });
});

tvTest("a restored sign-in whose account must change its password is signed out and sent to the server's web page", async (tv) => {
    await picker(tv);
    tv.fake.passwordChangeRequired = true;
    tv.fake.expireAccessTokens();
    await tv.page.evaluate(() => window.harness.mount());
    await screenIs(tv, "password");
    await shows(tv, "In a web browser, open https://silo.example.test, sign in and choose a new password.");
    assert.equal(await tv.page.evaluate(() => window.harness.handoffs[1]?.restore), "signed_in");
    await tv.eventually(async () => tv.fake.revokedSessions.size === 1, "the restricted session to be revoked");
    assert.equal(await tv.page.evaluate(() => window.harness.keyManager?.items.size), 0);
    assert.equal(await tv.focused(), "signin");
    await tv.page.keyboard.press("Enter");
    await screenIs(tv, "entry");
    assert.equal((await handed(tv)).length, 0);
});

tvTest("an empty or failing profile list offers Try again", async (tv) => {
    tv.fake.script("/profiles", { status: 200, body: { ...tv.fake.profiles, items: [] } });
    await signIn(tv);
    await screenIs(tv, "profiles-empty");
    await shows(tv, "This account has no profiles");
    assert.equal(await tv.focused(), "retry");
    tv.fake.script("/profiles", { status: 500 });
    await tv.page.keyboard.press("Enter");
    await screenIs(tv, "profiles-error");
    await shows(tv, "The server had a problem. Try again in a moment.");
    assert.equal(await tv.focused(), "retry");
    await tv.page.keyboard.press("Enter");
    await screenIs(tv, "profiles");
});
