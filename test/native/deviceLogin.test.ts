import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthorizedSpec } from "../../src/session/session.ts";
import { connected, latestDeviceCode, record, signIn } from "./support/harness.ts";
import type { FakeKeyManager } from "./support/keyManager.ts";

const SECOND = 1000;
const probe: AuthorizedSpec<unknown> = { method: "GET", path: "/catalog/probe", retry: "safe", decode: (body) => body, profileScoped: false };

test("code view, interval polling, opened signal and approval install a persistent session", async () => {
    const h = await connected();
    const login = h.core.createDeviceLogin();
    const states = record(login);
    login.start();
    await h.clock.advance(0);

    const waiting = login.current;
    assert.equal(waiting.phase, "waiting");
    if (waiting.phase === "waiting") {
        assert.equal(waiting.code.userCode, "4821 7730");
        assert.equal(waiting.code.verificationUriComplete, "https://silo.example.test/activate?code=48217730");
        assert.equal(waiting.code.expiresAt, h.clock.now() + 900 * SECOND);
        assert.equal(waiting.opened, false);
    }
    // Previously this list stopped at identity. That encoded connect before it read setup status.
    assert.deepEqual(h.fake.paths(), ["GET /system/info", "GET /system/identity", "GET /system/setup", "GET /auth/device/capability", "POST /auth/device/start"]);

    // Nothing is polled before the server's interval.
    await h.clock.advance(4 * SECOND);
    assert.equal(h.fake.paths().filter((path) => path === "POST /auth/device/poll").length, 0);
    await h.clock.advance(1 * SECOND);
    assert.equal(h.fake.paths().filter((path) => path === "POST /auth/device/poll").length, 1);

    h.fake.open(latestDeviceCode(h.fake));
    await h.clock.advance(5 * SECOND);
    assert.equal(login.current.phase === "waiting" && login.current.opened, true);

    h.fake.approve(latestDeviceCode(h.fake));
    await h.clock.advance(5 * SECOND);
    assert.deepEqual(login.current, { phase: "signed_in", persistence: "persistent", previousSession: "cleared", passwordChangeRequired: false });
    assert.equal(h.core.session.signedIn, true);
    assert.equal(h.core.session.account?.username, "laura");
    assert.deepEqual(
        states.map((state) => state.phase),
        ["starting", "waiting", "waiting", "waiting", "signed_in"],
    );
    // Device polls never carry a bearer; the collected session is stored in KeyManager only.
    assert.ok(h.fake.requests.filter((request) => request.path.startsWith("/auth/device")).every((request) => request.headers.authorization === undefined));
    assert.equal(h.keyManager?.items.size, 1);
    for (const value of h.storage.items.values()) {
        assert.ok(!value.includes("acc-") && !value.includes("ref-"), "no token in public storage");
    }
});

test("an approver opening the code extends the local deadline past the start answer's expiry", async () => {
    const h = await connected();
    const login = h.core.createDeviceLogin();
    login.start();
    await h.clock.advance(0);
    const code = latestDeviceCode(h.fake);

    await h.clock.advance(14 * 60 * SECOND);
    h.fake.open(code); // holds the code until now + 5 minutes
    await h.clock.advance(5 * SECOND);
    const extended = login.current;
    assert.equal(extended.phase, "waiting");
    if (extended.phase === "waiting") {
        assert.equal(extended.opened, true);
        assert.ok(extended.code.expiresAt > h.clock.now() + 4 * 60 * SECOND);
    }

    // Past the start answer's 15 minutes, still polling, and the approval lands.
    await h.clock.advance(2 * 60 * SECOND);
    assert.equal(login.current.phase, "waiting");
    h.fake.approve(code);
    await h.clock.advance(5 * SECOND);
    assert.equal(login.current.phase, "signed_in");
});

test("a code nobody opens expires after one last poll and is withdrawn", async () => {
    const h = await connected();
    const login = h.core.createDeviceLogin();
    login.start();
    await h.clock.advance(0);
    await h.clock.advance(900 * SECOND);
    await h.clock.advance(10 * SECOND);
    assert.equal(login.current.phase, "expired");
    await h.clock.advance(60 * SECOND);
    const pollsAfterExpiry = h.fake.paths().filter((path) => path === "POST /auth/device/poll").length;
    await h.clock.advance(60 * SECOND);
    assert.equal(h.fake.paths().filter((path) => path === "POST /auth/device/poll").length, pollsAfterExpiry);
});

test("cancel withdraws the code on the server and stops polling", async () => {
    const h = await connected();
    const login = h.core.createDeviceLogin();
    login.start();
    await h.clock.advance(6 * SECOND);
    login.cancel();
    await h.clock.advance(0);
    assert.equal(login.current.phase, "canceled");
    const code = latestDeviceCode(h.fake);
    assert.equal(h.fake.devices.get(code)?.status, "canceled");
    const sent = h.fake.requests.length;
    await h.clock.advance(60 * SECOND);
    assert.equal(h.fake.requests.length, sent);
    assert.equal(h.core.session.signedIn, false);
});

test("an approval that arrives for a cancelled attempt is revoked, never installed", async () => {
    const h = await connected();
    const login = h.core.createDeviceLogin();
    login.start();
    await h.clock.advance(0);
    const code = latestDeviceCode(h.fake);
    h.fake.approve(code);
    const held = h.fake.hold("/auth/device/poll", true);
    await h.clock.advance(5 * SECOND);
    login.cancel();
    held.release();
    await h.clock.advance(0);

    assert.equal(login.current.phase, "canceled");
    assert.equal(h.core.session.signedIn, false);
    assert.equal(h.keyManager?.items.size, 0);
    const logout = h.fake.requests.find((request) => request.path === "/auth/logout");
    assert.ok(logout?.headers.authorization?.startsWith("Bearer acc-"), "the orphaned session was revoked");
    assert.equal(h.fake.revokedSessions.size, 1);
});

test("starting again aborts the old attempt; its late answers cannot change the new one", async () => {
    const h = await connected();
    const login = h.core.createDeviceLogin();
    login.start();
    await h.clock.advance(0);
    const first = latestDeviceCode(h.fake);
    h.fake.deny(first);
    const held = h.fake.hold("/auth/device/poll", true);
    await h.clock.advance(5 * SECOND);
    login.start();
    held.release();
    await h.clock.advance(0);
    assert.equal(login.current.phase, "waiting", "the old attempt's denial is ignored");
    assert.notEqual(latestDeviceCode(h.fake), first);
});

test("429 and lost answers back off and poll again; Retry-After is honored", async () => {
    const h = await connected();
    const login = h.core.createDeviceLogin();
    login.start();
    await h.clock.advance(0);
    h.fake.script("/auth/device/poll", {
        status: 429,
        headers: { "Content-Type": "application/problem+json", "Retry-After": "30" },
        body: { type: "https://siloserver.org/docs/api/v2/problems/rate_limited", title: "Rate limited", status: 429, detail: "", instance: "urn:silo:request:1" },
    });
    await h.clock.advance(5 * SECOND);
    assert.equal(login.current.phase === "waiting" && login.current.retrying, "rate_limited");
    const afterLimit = h.fake.requests.length;
    await h.clock.advance(29 * SECOND);
    assert.equal(h.fake.requests.length, afterLimit, "waits the full Retry-After");
    await h.clock.advance(1 * SECOND);
    assert.equal(h.fake.requests.length, afterLimit + 1);
    assert.equal(login.current.phase === "waiting" && login.current.retrying, "none");
});

test("a lost approved answer is not re-collected: the next poll reads consumed and the attempt ends", async () => {
    const h = await connected();
    const login = h.core.createDeviceLogin();
    login.start();
    await h.clock.advance(0);
    h.fake.approve(latestDeviceCode(h.fake));
    // The server hands over the tokens, but the answer never reaches the TV.
    h.fake.dropNextAnswer("/auth/device/poll");
    await h.clock.advance(5 * SECOND);
    assert.equal(login.current.phase === "waiting" && login.current.retrying, "unreachable");
    await h.clock.advance(5 * SECOND);
    assert.equal(login.current.phase, "consumed");
    assert.equal(h.core.session.signedIn, false);
    await h.clock.advance(60 * SECOND);
    assert.equal(h.fake.paths().filter((path) => path === "POST /auth/device/start").length, 1, "no automatic new start");
    assert.equal(h.fake.paths().filter((path) => path === "POST /auth/device/poll").length, 2);
});

test("denied, start failure without replay, disabled capability and temporary sessions", async () => {
    const denied = await connected();
    const login = denied.core.createDeviceLogin();
    login.start();
    await denied.clock.advance(0);
    denied.fake.deny(latestDeviceCode(denied.fake));
    await denied.clock.advance(5 * SECOND);
    assert.equal(login.current.phase, "denied");

    const offline = await connected();
    offline.fake.script("/auth/device/start", { status: 503 });
    const failing = offline.core.createDeviceLogin();
    failing.start();
    await offline.clock.advance(60 * SECOND);
    assert.deepEqual(failing.current, { phase: "failed", reason: "server_error", retryAfterSeconds: undefined });
    assert.equal(offline.fake.paths().filter((path) => path === "POST /auth/device/start").length, 1);

    const disabled = await connected();
    disabled.fake.script("/auth/device/capability", { status: 200, body: { revision: "r", state: "disabled", remote_playback_handoff: false, jellyfin_quick_connect: false, protocol_versions: [2], cancel: true, opened_signal: true } });
    const off = disabled.core.createDeviceLogin();
    off.start();
    await disabled.clock.advance(0);
    assert.equal(off.current.phase, "unavailable");

    const temporary = await connected();
    const handoff = temporary.core.createDeviceLogin();
    handoff.start();
    await temporary.clock.advance(0);
    temporary.fake.script("/auth/device/poll", {
        status: 200,
        body: { status: "approved", poll_after: 5, opened: true, temporary: true, profile_id: "p-kid", profile_token: "pvt", session_expires_at: "2026-01-03T03:04:05.678Z", tokens: { access_token: "acc-t", refresh_token: "ref-t", expires_in: 3600, user: { id: "1", username: "laura", email: "", role: "user", permissions: [], download_allowed: true, password_change_required: false } } },
    });
    await temporary.clock.advance(5 * SECOND);
    assert.equal(handoff.current.phase === "failed" && handoff.current.reason, "temporary_session_refused");
    assert.equal(temporary.core.session.signedIn, false);
    assert.ok(temporary.fake.requests.some((request) => request.path === "/auth/logout" && request.headers.authorization === "Bearer acc-t"));
});

test("signing out stops a pending sign-in: the code is withdrawn and a later approval signs nobody in", async () => {
    const h = await connected();
    const login = h.core.createDeviceLogin();
    login.start();
    await h.clock.advance(0);
    const code = latestDeviceCode(h.fake);
    await h.core.session.logout();
    await h.clock.advance(0);
    assert.equal(login.current.phase, "canceled");
    assert.equal(h.fake.devices.get(code)?.status, "canceled", "the code is withdrawn on the server");
    const polls = h.fake.paths().filter((path) => path === "POST /auth/device/poll").length;
    h.fake.approve(code);
    await h.clock.advance(60 * SECOND);
    assert.equal(h.fake.paths().filter((path) => path === "POST /auth/device/poll").length, polls, "no poll after sign-out");
    assert.equal(h.core.session.signedIn, false);
    assert.equal(h.keyManager?.items.size, 0);
});

test("an approval already on its way when the person signs out is revoked, never installed or stored", async () => {
    const h = await connected();
    await signIn(h);
    const login = h.core.createDeviceLogin();
    login.start();
    await h.clock.advance(0);
    h.fake.approve(latestDeviceCode(h.fake));
    const held = h.fake.hold("/auth/device/poll", true);
    await h.clock.advance(5 * SECOND);
    const loggingOut = h.core.session.logout();
    held.release();
    await loggingOut;
    await h.clock.advance(0);

    assert.equal(login.current.phase, "canceled");
    assert.equal(h.core.session.signedIn, false);
    assert.equal(h.keyManager?.items.size, 0, "nothing stored after sign-out");
    assert.equal(h.fake.revokedSessions.size, 2, "the signed-out session and the late one are both revoked");
    const restarted = await connected({ clock: h.clock, fake: h.fake, keyManager: h.keyManager, storage: h.storage });
    assert.equal(restarted.core.restore, "signed_out");
});

test("a sign-in that lands first cancels another pending one; its late approval is revoked, not swapped in", async () => {
    const h = await connected();
    const first = h.core.createDeviceLogin();
    first.start();
    await h.clock.advance(0);
    const firstCode = latestDeviceCode(h.fake);
    const second = h.core.createDeviceLogin();
    second.start();
    await h.clock.advance(0);
    h.fake.approve(firstCode);
    h.fake.approve(latestDeviceCode(h.fake));
    // The first attempt polls first; its approved answer is held while the second one installs.
    const held = h.fake.hold("/auth/device/poll", true);
    await h.clock.advance(5 * SECOND);
    assert.equal(second.current.phase, "signed_in");
    held.release();
    await h.clock.advance(0);

    assert.equal(first.current.phase, "canceled");
    assert.equal(h.fake.revokedSessions.size, 1, "the first attempt's late session is revoked");
    await h.core.session.call(probe);
    const restarted = await connected({ clock: h.clock, fake: h.fake, keyManager: h.keyManager, storage: h.storage });
    assert.equal(restarted.core.restore, "signed_in");
    await restarted.core.session.call(probe);
});

test("signing out while an approved sign-in is still being stored publishes no late sign-in", async () => {
    const h = await connected();
    const keyManager = h.keyManager;
    assert.ok(keyManager !== undefined);
    const login = h.core.createDeviceLogin();
    const states = record(login);
    login.start();
    await h.clock.advance(0);
    h.fake.approve(latestDeviceCode(h.fake));
    const saving = keyManager.holdSaves();
    await h.clock.advance(5 * SECOND);
    assert.equal(saving.waiting(), 1, "the collected session is being stored");
    assert.equal(h.core.session.signedIn, true);

    const loggingOut = h.core.session.logout();
    saving.release();
    await loggingOut;
    await h.clock.advance(0);

    assert.ok(!states.some((state) => state.phase === "signed_in"), "no signed_in after the sign-out");
    assert.equal(login.current.phase, "canceled");
    assert.equal(h.core.session.signedIn, false);
    assert.equal(keyManager.items.size, 0);
    const restarted = await connected({ clock: h.clock, fake: h.fake, keyManager, storage: h.storage });
    assert.equal(restarted.core.restore, "signed_out");
});

test("starting again while an approved sign-in is still being stored leaves the new attempt alone", async () => {
    const h = await connected();
    const keyManager = h.keyManager;
    assert.ok(keyManager !== undefined);
    const login = h.core.createDeviceLogin();
    login.start();
    await h.clock.advance(0);
    const first = latestDeviceCode(h.fake);
    h.fake.approve(first);
    const saving = keyManager.holdSaves();
    await h.clock.advance(5 * SECOND);
    assert.equal(saving.waiting(), 1);

    login.start();
    await h.clock.advance(0);
    const replacement = login.current;
    assert.equal(replacement.phase, "waiting");
    assert.notEqual(latestDeviceCode(h.fake), first);
    const states = record(login);
    saving.release();
    await h.clock.advance(0);

    assert.deepEqual(states, [], "the old attempt's save publishes nothing");
    assert.equal(login.current, replacement);
    // The replacement can still sign in.
    h.fake.approve(latestDeviceCode(h.fake));
    await h.clock.advance(5 * SECOND);
    assert.deepEqual(login.current, { phase: "signed_in", persistence: "persistent", previousSession: "cleared", passwordChangeRequired: false });
});

test("another sign-in replacing the account while an approved one is still being stored ends the first, not the second", async () => {
    const h = await connected();
    const keyManager = h.keyManager;
    assert.ok(keyManager !== undefined);
    const first = h.core.createDeviceLogin();
    const firstStates = record(first);
    first.start();
    await h.clock.advance(0);
    h.fake.approve(latestDeviceCode(h.fake));
    const saving = keyManager.holdSaves();
    await h.clock.advance(5 * SECOND);
    assert.equal(saving.waiting(), 1);

    const second = h.core.createDeviceLogin();
    second.start();
    await h.clock.advance(0);
    h.fake.approve(latestDeviceCode(h.fake));
    await h.clock.advance(5 * SECOND);
    assert.equal(second.current.phase, "waiting", "its save waits behind the first one");
    saving.release();
    await h.clock.advance(0);

    assert.ok(!firstStates.some((state) => state.phase === "signed_in"), "the replaced sign-in never reports success");
    assert.equal(first.current.phase, "canceled");
    assert.deepEqual(second.current, { phase: "signed_in", persistence: "persistent", previousSession: "cleared", passwordChangeRequired: false });
    assert.equal(h.fake.revokedSessions.size, 1, "the replaced sign-in's session is revoked; the current one keeps working below");
    await h.core.session.call(probe);
    const restarted = await connected({ clock: h.clock, fake: h.fake, keyManager, storage: h.storage });
    assert.equal(restarted.core.restore, "signed_in");
    await restarted.core.session.call(probe);
});

function storedAccessToken(keyManager: FakeKeyManager | undefined): string {
    const values = [...(keyManager?.items.values() ?? [])];
    assert.equal(values.length, 1);
    const parsed: unknown = JSON.parse(values[0] ?? "");
    assert.ok(typeof parsed === "object" && parsed !== null && "accessToken" in parsed && typeof parsed.accessToken === "string");
    return parsed.accessToken;
}

test("a sign-in that replaces the installed account revokes only the replaced account's session", async () => {
    const h = await connected();
    await signIn(h);
    const replaced = storedAccessToken(h.keyManager);
    const login = h.core.createDeviceLogin();
    login.start();
    await h.clock.advance(0);
    h.fake.approve(latestDeviceCode(h.fake));
    await h.clock.advance(5 * SECOND);

    assert.deepEqual(login.current, { phase: "signed_in", persistence: "persistent", previousSession: "cleared", passwordChangeRequired: false });
    const logouts = h.fake.requests.filter((request) => request.path === "/auth/logout");
    assert.deepEqual(logouts.map((request) => request.headers.authorization), [`Bearer ${replaced}`]);
    assert.equal(h.fake.revokedSessions.size, 1);
    assert.notEqual(storedAccessToken(h.keyManager), replaced);
    await h.core.session.call(probe);
    const restarted = await connected({ clock: h.clock, fake: h.fake, keyManager: h.keyManager, storage: h.storage });
    assert.equal(restarted.core.restore, "signed_in");
    await restarted.core.session.call(probe);
});

test("a replaced account's revocation that cannot reach the server does not hold up or undo the new sign-in", async () => {
    const h = await connected();
    await signIn(h);
    const unavailable = { status: 503 };
    h.fake.script("/auth/logout", unavailable, unavailable);
    const login = h.core.createDeviceLogin();
    login.start();
    await h.clock.advance(0);
    h.fake.approve(latestDeviceCode(h.fake));
    await h.clock.advance(5 * SECOND);
    assert.deepEqual(login.current, { phase: "signed_in", persistence: "persistent", previousSession: "cleared", passwordChangeRequired: false });
    await h.clock.advance(5 * SECOND);

    assert.equal(h.fake.paths().filter((path) => path === "POST /auth/logout").length, 2, "one best-effort request and its transport retry");
    assert.equal(h.fake.revokedSessions.size, 0);
    assert.equal(h.core.session.signedIn, true);
    await h.core.session.call(probe);
});

test("cancelling once the approved session is installed is too late: the sign-in completes as the account now in use", async () => {
    const h = await connected();
    const keyManager = h.keyManager;
    assert.ok(keyManager !== undefined);
    const login = h.core.createDeviceLogin();
    const states = record(login);
    login.start();
    await h.clock.advance(0);
    h.fake.approve(latestDeviceCode(h.fake));
    const saving = keyManager.holdSaves();
    await h.clock.advance(5 * SECOND);
    assert.equal(saving.waiting(), 1);
    assert.equal(h.core.session.signedIn, true);

    login.cancel();
    saving.release();
    await h.clock.advance(0);

    assert.ok(!states.some((state) => state.phase === "canceled"), "no canceled while the account is signed in");
    assert.deepEqual(login.current, { phase: "signed_in", persistence: "persistent", previousSession: "cleared", passwordChangeRequired: false });
    assert.equal(h.core.session.signedIn, true);
    await h.core.session.call(probe);
    const restarted = await connected({ clock: h.clock, fake: h.fake, keyManager, storage: h.storage });
    assert.equal(restarted.core.restore, "signed_in");
});

async function signInAgain(h: Awaited<ReturnType<typeof connected>>): Promise<ReturnType<typeof h.core.createDeviceLogin>> {
    const login = h.core.createDeviceLogin();
    login.start();
    await h.clock.advance(0);
    h.fake.approve(latestDeviceCode(h.fake));
    await h.clock.advance(5 * SECOND);
    return login;
}

test("a new sign-in whose save fails never lets the replaced account come back after a restart, even if its revocation failed", async () => {
    const h = await connected();
    await signIn(h);
    const keyManager = h.keyManager;
    assert.ok(keyManager !== undefined);
    const unavailable = { status: 503 };
    h.fake.script("/auth/logout", unavailable, unavailable);
    keyManager.failSave = true;
    const login = await signInAgain(h);
    await h.clock.advance(5 * SECOND);
    const state = login.current;
    assert.equal(state.phase, "signed_in");
    assert.equal(state.phase === "signed_in" ? state.persistence : undefined, "session_only");
    assert.equal(h.fake.revokedSessions.size, 0, "the replaced session is still valid on the server");

    keyManager.failSave = false;
    const restarted = await connected({ clock: h.clock, fake: h.fake, keyManager, storage: h.storage });
    assert.equal(restarted.core.restore, "signed_out", "the replaced account is not restored");
    assert.equal(keyManager.items.size, 0);
    assert.equal(state.phase === "signed_in" ? state.previousSession : undefined, "cleared");
});

test("a sign-in while the stored account cannot be read keeps that account from coming back once it can", async () => {
    const h = await connected();
    await signIn(h);
    const keyManager = h.keyManager;
    assert.ok(keyManager !== undefined);
    const [alias] = [...keyManager.items.keys()];
    assert.ok(alias !== undefined);
    keyManager.unreadable.add(alias);
    keyManager.failRemove = true;
    const launched = await connected({ clock: h.clock, fake: h.fake, keyManager, storage: h.storage });
    assert.equal(launched.core.restore, "storage_unavailable");
    assert.equal(launched.core.session.signedIn, false);

    const login = await signInAgain(launched);
    const state = login.current;
    assert.equal(state.phase, "signed_in");
    assert.equal(state.phase === "signed_in" ? state.persistence : undefined, "session_only", "the save is refused while a slot is unreadable");
    assert.equal(keyManager.items.size, 1, "the unreadable record is still in KeyManager");

    keyManager.unreadable.clear();
    keyManager.failRemove = false;
    const recovered = await connected({ clock: h.clock, fake: h.fake, keyManager, storage: h.storage });
    assert.equal(recovered.core.restore, "signed_out", "the account signed in before is not restored");
    assert.equal(keyManager.items.size, 0);
    assert.equal(state.phase === "signed_in" ? state.previousSession : undefined, "guarded");
});

test("a sign-in that can neither mark nor delete the replaced account's record says so instead of reporting it removed", async () => {
    const h = await connected();
    await signIn(h);
    const keyManager = h.keyManager;
    assert.ok(keyManager !== undefined);
    h.storage.failSet = true;
    keyManager.failRemove = true;
    keyManager.failSave = true;
    const login = await signInAgain(h);
    assert.deepEqual(login.current, { phase: "signed_in", persistence: "session_only", previousSession: "failed", passwordChangeRequired: false });
    assert.equal(h.core.session.signedIn, true);
    await h.core.session.call(probe);
});

test("a sign-in while KeyManager refuses deletes still stores the new account, and only it comes back", async () => {
    const h = await connected();
    await signIn(h);
    const keyManager = h.keyManager;
    assert.ok(keyManager !== undefined);
    keyManager.failRemove = true;
    const login = await signInAgain(h);
    assert.deepEqual(login.current, { phase: "signed_in", persistence: "persistent", previousSession: "guarded", passwordChangeRequired: false });

    keyManager.failRemove = false;
    const restarted = await connected({ clock: h.clock, fake: h.fake, keyManager, storage: h.storage });
    assert.equal(restarted.core.restore, "signed_in");
    await restarted.core.session.call(probe);
    assert.equal(keyManager.items.size, 1, "the replaced account's leftover is removed");
});

test("a failing poll streak is dated from its first failing send, backs off to 30 seconds, and clears on success", async () => {
    const h = await connected();
    const login = h.core.createDeviceLogin();
    login.start();
    await h.clock.advance(0);
    const outage = { status: 503 };
    h.fake.script("/auth/device/poll", outage, outage, outage, outage, outage, outage);
    const polls = (): number => h.fake.paths().filter((path) => path === "POST /auth/device/poll").length;
    const firstSend = h.clock.now() + 5 * SECOND;
    await h.clock.advance(5 * SECOND);
    const first = login.current;
    assert.equal(first.phase === "waiting" && first.failingSince, firstSend);
    assert.equal(first.phase === "waiting" && first.rateLimitedSince, undefined);
    // The Apple TV app's backoff: the poll interval, doubled, at most 30 seconds.
    for (const wait of [5, 10, 20, 30, 30]) {
        const before = polls();
        await h.clock.advance(wait * SECOND - 1);
        assert.equal(polls(), before, `waits ${wait} s`);
        await h.clock.advance(1);
        assert.equal(polls(), before + 1);
        const state = login.current;
        assert.equal(state.phase === "waiting" && state.failingSince, firstSend, "the streak keeps its first send");
    }
    await h.clock.advance(30 * SECOND);
    const recovered = login.current;
    assert.equal(recovered.phase === "waiting" && recovered.retrying, "none");
    assert.equal(recovered.phase === "waiting" && recovered.failingSince, undefined);
});

test("a 429 streak is dated separately and resets when another failure interrupts it", async () => {
    const h = await connected();
    const login = h.core.createDeviceLogin();
    login.start();
    await h.clock.advance(0);
    const limited = { status: 429, headers: { "Content-Type": "application/problem+json" }, body: { type: "https://siloserver.org/docs/api/v2/problems/rate_limited", title: "Rate limited", status: 429, detail: "", instance: "urn:silo:request:1" } };
    h.fake.script("/auth/device/poll", limited, { status: 503 }, limited);
    const firstSend = h.clock.now() + 5 * SECOND;
    await h.clock.advance(5 * SECOND);
    let state = login.current;
    assert.equal(state.phase === "waiting" && state.rateLimitedSince, firstSend);
    await h.clock.advance(5 * SECOND);
    state = login.current;
    assert.equal(state.phase === "waiting" && state.retrying, "unreachable");
    assert.equal(state.phase === "waiting" && state.rateLimitedSince, undefined);
    assert.equal(state.phase === "waiting" && state.failingSince, firstSend);
    const thirdSend = h.clock.now() + 10 * SECOND;
    await h.clock.advance(10 * SECOND);
    state = login.current;
    assert.equal(state.phase === "waiting" && state.rateLimitedSince, thirdSend);
    assert.equal(state.phase === "waiting" && state.failingSince, firstSend);
});

const pollCount = (h: { fake: { paths(): string[] } }): number => h.fake.paths().filter((path) => path === "POST /auth/device/poll").length;

test("starting while hidden sends no code request until the screen returns", async () => {
    const h = await connected();
    const login = h.core.createDeviceLogin();
    login.setActive(false);
    login.start();
    await h.clock.advance(0);
    const starts = (): number => h.fake.paths().filter((path) => path === "POST /auth/device/start").length;
    assert.equal(starts(), 0);
    login.setActive(true);
    await h.clock.advance(0);
    assert.equal(starts(), 1);
});

test("hidden, nothing is polled; back on screen the code is polled at once, as QRLoginViewModel.setActive", async () => {
    const h = await connected();
    const login = h.core.createDeviceLogin();
    login.start();
    await h.clock.advance(0);
    login.setActive(false);
    await h.clock.advance(60 * SECOND);
    assert.equal(pollCount(h), 0, "no poll while hidden");
    login.setActive(true);
    await h.clock.advance(0);
    assert.equal(pollCount(h), 1, "polled at once on return");
    await h.clock.advance(4 * SECOND);
    assert.equal(pollCount(h), 1);
    await h.clock.advance(1 * SECOND);
    assert.equal(pollCount(h), 2, "then the interval again");
});

test("coming back never polls before a server's Retry-After", async () => {
    const h = await connected();
    const login = h.core.createDeviceLogin();
    login.start();
    await h.clock.advance(0);
    h.fake.script("/auth/device/poll", {
        status: 429,
        headers: { "Content-Type": "application/problem+json", "Retry-After": "30" },
        body: { type: "https://siloserver.org/docs/api/v2/problems/rate_limited", title: "Rate limited", status: 429, detail: "", instance: "urn:silo:request:1" },
    });
    await h.clock.advance(5 * SECOND);
    assert.equal(pollCount(h), 1);
    login.setActive(false);
    await h.clock.advance(5 * SECOND);
    login.setActive(true);
    await h.clock.advance(0);
    assert.equal(pollCount(h), 1, "the 30 s the server asked for still hold");
    // Sent at 5 s with Retry-After 30: nothing before 35 s, 25 s after coming back.
    await h.clock.advance(25 * SECOND - 1);
    assert.equal(pollCount(h), 1);
    await h.clock.advance(1);
    assert.equal(pollCount(h), 2);
});

test("a code that expires while hidden is polled once on return, then reported expired", async () => {
    const h = await connected();
    const login = h.core.createDeviceLogin();
    login.start();
    await h.clock.advance(0);
    login.setActive(false);
    await h.clock.advance(16 * 60 * SECOND);
    assert.equal(login.current.phase, "waiting");
    login.setActive(true);
    await h.clock.advance(0);
    assert.equal(pollCount(h), 1);
    assert.equal(login.current.phase, "expired");
});

test("a poll already sent when the screen hides still collects its approval", async () => {
    const h = await connected();
    const login = h.core.createDeviceLogin();
    login.start();
    await h.clock.advance(0);
    const hold = h.fake.hold("/auth/device/poll");
    h.fake.approve(latestDeviceCode(h.fake));
    await h.clock.advance(5 * SECOND);
    login.setActive(false);
    hold.release();
    await hold.released;
    await h.clock.advance(0);
    assert.equal(login.current.phase, "signed_in");
});

test("an unreadable answer or an unknown status is retried as Apple does; a request-shape refusal ends the attempt", async () => {
    const h = await connected();
    const login = h.core.createDeviceLogin();
    login.start();
    await h.clock.advance(0);
    h.fake.script("/auth/device/poll", { status: 200, body: { status: "something-new", poll_after: 5 } }, { status: 200, body: "<html>proxy</html>" });
    await h.clock.advance(5 * SECOND);
    let state = login.current;
    assert.equal(state.phase === "waiting" && state.retrying, "unreachable", "an unknown status keeps the code");
    await h.clock.advance(5 * SECOND);
    state = login.current;
    assert.equal(state.phase === "waiting" && state.retrying, "unreachable", "an unreadable answer keeps the code");
    await h.clock.advance(10 * SECOND);
    state = login.current;
    assert.equal(state.phase === "waiting" && state.retrying, "none", "a normal answer recovers");

    // pollDeviceLogin's 400/406/413/415/422 refuse the request itself; the same request can't pass.
    h.fake.script("/auth/device/poll", { status: 422, headers: { "Content-Type": "application/problem+json" }, body: { type: "https://siloserver.org/docs/api/v2/problems/validation_failed", title: "Invalid", status: 422, detail: "", instance: "urn:silo:request:2" } });
    await h.clock.advance(5 * SECOND);
    assert.equal(login.current.phase, "failed");
});

test("repeated unknown poll statuses expire after the code's final deadline poll", async () => {
    const h = await connected();
    const login = h.core.createDeviceLogin();
    h.fake.script("/auth/device/poll", ...Array.from({ length: 100 }, () => ({ status: 200, body: { status: "something-new", poll_after: 5 } })));
    login.start();
    await h.clock.advance(0);
    await h.clock.advance(20 * 60 * SECOND);
    assert.equal(login.current.phase, "expired", "an unknown status cannot keep an expired code alive");
    const polls = h.fake.paths().filter(path => path === "POST /auth/device/poll").length;
    await h.clock.advance(60 * SECOND);
    assert.equal(h.fake.paths().filter(path => path === "POST /auth/device/poll").length, polls, "a settled attempt sends no more polls");
});
