import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../src/api/errors.ts";
import { operations } from "../../src/api/operations.ts";
import { decodeAuthProviders, decodeTokenPair } from "../../src/contracts/v2/wire.ts";
import { passwordLogin } from "../../src/session/passwordLogin.ts";
import { FAKE_PASSWORD, fixture } from "./support/fakeSilo.ts";
import { connected, latestDeviceCode } from "./support/harness.ts";

test("login decodes the pinned TokenPair fixture and auth discovery decodes password_login and OAuth names", () => {
    const pair = decodeTokenPair(fixture("login_ok"));
    assert.deepEqual(pair, {
        tokens: { accessToken: "acc", refreshToken: "ref", expiresInSeconds: 3600 },
        account: { id: "1", username: "laura", role: "user", passwordChangeRequired: false },
    });
    assert.throws(() => decodeTokenPair({ ...fixture("login_ok"), user: undefined }), /token_pair\.user/);
    assert.deepEqual(decodeAuthProviders(fixture("list_auth_providers_ok")), { passwordLogin: true, oauthProviders: ["Example SSO"] });
    assert.throws(() => decodeAuthProviders({ items: [] }), /password_login/);

    const login = operations.login("laura", "secret value");
    assert.equal(login.method, "POST");
    assert.equal(login.path, "/auth/login");
    assert.equal(login.retry, "never", "login is non_retryable");
    assert.deepEqual(login.body, { username: "laura", password: "secret value" }, "no provider: the server's default");
    assert.equal(operations.authProviders().path, "/auth/providers");
});

test("a password sign-in installs the token pair in the secure vault only and never sends the password elsewhere", async () => {
    const h = await connected();
    const result = await passwordLogin(h.core.session, "laura", FAKE_PASSWORD);
    assert.deepEqual(result, { status: "signed_in", persistence: "persistent", previousSession: "cleared", passwordChangeRequired: false });
    assert.equal(h.core.session.signedIn, true);
    assert.equal(h.core.session.account?.username, "laura");
    const logins = h.fake.requests.filter((request) => request.path === "/auth/login");
    assert.equal(logins.length, 1);
    assert.equal(logins[0]?.headers.authorization, undefined, "no bearer on a public sign-in");
    assert.equal(logins[0]?.headers["x-silo-device-name"], "Living room TV", "the session records this TV");
    assert.ok(h.fake.requests.every((request) => !request.path.includes(FAKE_PASSWORD)), "the password is never in a URL");
    assert.equal(h.keyManager?.items.size, 1);
    for (const value of [...h.storage.items.values(), ...(h.keyManager?.items.values() ?? [])]) {
        assert.ok(!value.includes(FAKE_PASSWORD), "the password is never stored");
    }
    for (const value of h.storage.items.values()) {
        assert.ok(!value.includes("acc-") && !value.includes("ref-"), "no token in public storage");
    }
});

test("without secure storage the session stays in memory and says so", async () => {
    const h = await connected({ keyManager: null });
    const result = await passwordLogin(h.core.session, "laura", FAKE_PASSWORD);
    assert.equal(result.status, "signed_in");
    assert.equal(result.status === "signed_in" && result.persistence, "session_only");
});

test("a failed vault save is reported as session-only, never as stored", async () => {
    const h = await connected();
    if (h.keyManager !== undefined) {
        h.keyManager.failSave = true;
    }
    const result = await passwordLogin(h.core.session, "laura", FAKE_PASSWORD);
    assert.equal(result.status === "signed_in" && result.persistence, "session_only");
});

test("a wrong password and an unknown name get the same refusal and change nothing", async () => {
    const h = await connected();
    for (const [username, password] of [["laura", "wrong"], ["nobody", FAKE_PASSWORD]] as const) {
        const result = await passwordLogin(h.core.session, username, password);
        assert.equal(result.status, "failed");
        if (result.status === "failed") {
            assert.ok(result.error instanceof ApiError);
            assert.equal(result.error.status, 401);
            assert.equal(result.error.problemId, "invalid_token");
        }
    }
    assert.equal(h.core.session.signedIn, false);
    assert.equal(h.keyManager?.items.size, 0);
    assert.equal(h.fake.paths().filter((path) => path === "POST /auth/login").length, 2, "never resent");
});

test("a rate-limited sign-in is not resent and keeps Retry-After", async () => {
    const h = await connected();
    h.fake.script("/auth/login", { status: 429, headers: { "Content-Type": "application/problem+json", "Retry-After": "30" }, body: fixture("rate_limited") });
    const result = await passwordLogin(h.core.session, "laura", FAKE_PASSWORD);
    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" && result.error.retryAfterSeconds, 30);
    assert.equal(h.fake.paths().filter((path) => path === "POST /auth/login").length, 1);
});

test("an answer that arrives after the sign-in was abandoned is revoked, not installed", async () => {
    const h = await connected();
    const hold = h.fake.hold("/auth/login");
    const abandoned = new AbortController();
    const pending = passwordLogin(h.core.session, "laura", FAKE_PASSWORD, abandoned.signal);
    await h.clock.advance(0);
    abandoned.abort();
    hold.release();
    assert.deepEqual(await pending, { status: "superseded" });
    await h.clock.advance(0);
    assert.equal(h.core.session.signedIn, false);
    assert.equal(h.keyManager?.items.size, 0);
    assert.equal(h.fake.revokedSessions.size, 1, "the late session is ended on the server");
});

test("a device approval that wins the race keeps its account; the late password answer is revoked", async () => {
    const h = await connected();
    const device = h.core.createDeviceLogin();
    device.start();
    await h.clock.advance(0);
    const hold = h.fake.hold("/auth/login");
    const pending = passwordLogin(h.core.session, "laura", FAKE_PASSWORD);
    h.fake.approve(latestDeviceCode(h.fake));
    await h.clock.advance(5000);
    assert.equal(device.current.phase, "signed_in");
    const deviceToken = h.keyManager?.items.values().next().value;
    hold.release();
    assert.deepEqual(await pending, { status: "superseded" });
    await h.clock.advance(0);
    assert.equal(h.core.session.signedIn, true);
    assert.equal(h.keyManager?.items.values().next().value, deviceToken, "the stored account is the device approval's");
    assert.equal(h.fake.revokedSessions.size, 1);
});

test("a password sign-in withdraws a code still on screen", async () => {
    const h = await connected();
    const device = h.core.createDeviceLogin();
    device.start();
    await h.clock.advance(0);
    const code = latestDeviceCode(h.fake);
    const result = await passwordLogin(h.core.session, "laura", FAKE_PASSWORD);
    assert.equal(result.status, "signed_in");
    await h.clock.advance(0);
    assert.equal(h.fake.devices.get(code)?.status, "canceled");
    assert.equal(device.current.phase, "canceled");
});
