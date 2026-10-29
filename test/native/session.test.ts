import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../src/api/errors.ts";
import type { ProfileSummary } from "../../src/contracts/v2/wire.ts";
import type { AuthorityChange, AuthorizedSpec } from "../../src/session/session.ts";
import { SessionError } from "../../src/session/session.ts";
import { FakeSilo } from "./support/fakeSilo.ts";
import { connected, type Harness, latestDeviceCode, record, signIn } from "./support/harness.ts";

const probe: AuthorizedSpec<unknown> = { method: "GET", path: "/catalog/probe", retry: "safe", decode: (body) => body, profileScoped: true };
const owner: ProfileSummary = { id: "p-owner", name: "Laura", hasPin: false, isPrimary: true, isChild: false, avatarUrl: undefined };
const guest: ProfileSummary = { id: "p-guest", name: "Guest", hasPin: false, isPrimary: false, isChild: false, avatarUrl: undefined };

function isAborted(error: unknown): boolean {
    return error instanceof ApiError && error.aborted;
}

function probeProfiles(h: Harness): (string | undefined)[] {
    return h.fake.requests.filter((request) => request.path === "/catalog/probe").map((request) => request.headers["x-profile-id"]);
}

test("concurrent 401s share one refresh, and each request is replayed once with the new token", async () => {
    const h = await connected();
    await signIn(h);
    h.fake.expireAccessTokens();
    const results = await Promise.all([h.core.session.call(probe), h.core.session.call(probe), h.core.session.call(probe)]);
    assert.equal(results.length, 3);
    assert.equal(h.fake.paths().filter((path) => path === "POST /auth/refresh").length, 1);
    const probes = h.fake.requests.filter((request) => request.path === "/catalog/probe");
    assert.equal(probes.length, 6);
    const replayed = probes.slice(3).map((request) => request.headers.authorization);
    assert.equal(new Set(replayed).size, 1);
    assert.notEqual(replayed[0], probes[0]?.headers.authorization);
});

test("a refreshed pair is rotated into storage and survives a restart", async () => {
    const h = await connected();
    await signIn(h);
    h.fake.expireAccessTokens();
    await h.core.session.call(probe);
    const restarted = await connected({ clock: h.clock, fake: h.fake, keyManager: h.keyManager, storage: h.storage });
    assert.equal(restarted.core.restore, "signed_in");
    await restarted.core.session.call(probe);
    assert.equal(h.fake.paths().filter((path) => path === "POST /auth/refresh").length, 1, "the stored access token is current");
    assert.equal(h.keyManager?.items.size, 1, "one slot holds the record after rotation");
});

test("logout during an in-flight refresh clears local authority and the refresh cannot resurrect it", async () => {
    const h = await connected();
    await signIn(h);
    const changes: AuthorityChange[] = [];
    h.core.session.onAuthorityChange((change) => changes.push(change));
    const held = h.fake.hold("/auth/refresh", true);
    const refreshing = h.core.session.refresh();
    await h.clock.advance(0);

    const loggingOut = h.core.session.logout();
    held.release();
    const [outcome, logout] = await Promise.all([refreshing, loggingOut]);
    await h.clock.advance(0);

    assert.deepEqual(outcome, { status: "aborted" });
    assert.equal(logout.storage, "cleared");
    assert.equal(logout.server, "revoked");
    assert.equal(h.core.session.signedIn, false);
    assert.equal(h.keyManager?.items.size, 0, "nothing written back after logout");
    assert.deepEqual(changes.map((change) => change.reason), ["signed_out"]);
    const restarted = await connected({ clock: h.clock, fake: h.fake, keyManager: h.keyManager, storage: h.storage });
    assert.equal(restarted.core.restore, "signed_out");
});

test("logout while the server is unreachable still signs out locally", async () => {
    const h = await connected();
    await signIn(h);
    h.fake.dropNextAnswer("/auth/logout");
    h.fake.dropNextAnswer("/auth/logout");
    const logout = h.core.session.logout();
    await h.clock.advance(5000);
    assert.deepEqual(await logout, { storage: "cleared", server: "unreachable" });
    assert.equal(h.core.session.signedIn, false);
    await assert.rejects(h.core.session.call(probe), (error: unknown) => error instanceof SessionError && error.reason === "signed_out");
});

test("a refused refresh ends the session and notifies; an unavailable server keeps the tokens", async () => {
    const h = await connected();
    await signIn(h);
    h.fake.script("/auth/refresh", {
        status: 503,
        headers: { "Content-Type": "application/problem+json", "Retry-After": "4" },
        body: { type: "https://siloserver.org/docs/api/v2/problems/dependency_unavailable", title: "Dependency unavailable", status: 503, detail: "", instance: "urn:silo:request:1" },
    });
    assert.deepEqual(await h.core.session.refresh(), { status: "unavailable", retryAfterSeconds: 4 });
    assert.equal(h.core.session.signedIn, true);

    const changes: AuthorityChange[] = [];
    h.core.session.onAuthorityChange((change) => changes.push(change));
    h.fake.revokeAllSessions();
    h.fake.expireAccessTokens();
    await assert.rejects(h.core.session.call(probe), (error: unknown) => error instanceof SessionError && error.reason === "session_ended");
    assert.equal(h.core.session.signedIn, false);
    assert.deepEqual(changes.map((change) => change.reason), ["session_expired"]);
    assert.equal(h.keyManager?.items.size, 0);
});

test("an authority change aborts in-flight calls and drops late answers", async () => {
    const h = await connected();
    await signIn(h);
    const held = h.fake.hold("/catalog/probe", true);
    const pending = assert.rejects(h.core.session.call(probe), (error: unknown) => error instanceof ApiError && error.aborted);
    await h.clock.advance(0);
    const signal = h.core.session.authoritySignal;
    h.core.profiles.select({ id: "p-owner", name: "Laura", hasPin: false, isPrimary: true, isChild: false, avatarUrl: undefined });
    held.release();
    await pending;
    assert.equal(signal.aborted, true, "the player's linked work is told to stop");
});

test("a stored credential from another deployment at the same address is discarded, not sent", async () => {
    const h = await connected();
    await signIn(h);
    const other = new FakeSilo(h.clock, "another-deployment");
    const restarted = await connected({ clock: h.clock, fake: other, keyManager: h.keyManager, storage: h.storage });
    assert.equal(restarted.core.restore, "signed_out");
    assert.equal(h.keyManager?.items.size, 0);
    assert.ok(other.requests.every((request) => request.headers.authorization === undefined));
});

test("a profile switch during a proactive refresh aborts the call; it is never sent as the new profile", async () => {
    const h = await connected();
    await signIn(h);
    h.core.profiles.select(owner);
    // Inside the refresh window before the one-hour access token expires.
    await h.clock.advance(3570 * 1000);
    const held = h.fake.hold("/auth/refresh");
    const pending = h.core.session.call(probe);
    await h.clock.advance(0);
    assert.ok(h.fake.paths().includes("POST /auth/refresh"), "the call is waiting on its refresh");
    h.core.profiles.select(guest);
    held.release();
    await assert.rejects(pending, isAborted);
    assert.deepEqual(probeProfiles(h), [], "nothing was sent for the old profile's call");
});

test("a profile switch while a 401 waits on its refresh aborts the call instead of replaying it as the new profile", async () => {
    const h = await connected();
    await signIn(h);
    h.core.profiles.select(owner);
    h.fake.expireAccessTokens();
    const held = h.fake.hold("/auth/refresh");
    const pending = h.core.session.call(probe);
    await h.clock.advance(0);
    assert.ok(h.fake.paths().includes("POST /auth/refresh"), "the rejected call is waiting on the refresh");
    h.core.profiles.select(guest);
    held.release();
    await assert.rejects(pending, isAborted);
    assert.deepEqual(probeProfiles(h), ["p-owner"], "only the original request, as the old profile");
});

test("an answer that completes after the caller aborted is not returned", async () => {
    const h = await connected();
    await signIn(h);
    const held = h.fake.hold("/catalog/probe", true);
    const controller = new AbortController();
    const pending = h.core.session.call({ ...probe, signal: controller.signal });
    await h.clock.advance(0);
    assert.equal(probeProfiles(h).length, 1);
    controller.abort();
    held.release();
    await assert.rejects(pending, isAborted);
});

test("a refresh stored after an earlier failed save reports the session persistent again", async () => {
    const h = await connected();
    await signIn(h);
    const keyManager = h.keyManager;
    assert.ok(keyManager !== undefined);
    keyManager.failSave = true;
    assert.deepEqual(await h.core.session.refresh(), { status: "refreshed" });
    assert.equal(h.core.session.persistence, "session_only");
    keyManager.failSave = false;
    assert.deepEqual(await h.core.session.refresh(), { status: "refreshed" });
    assert.equal(h.core.session.persistence, "persistent");
    const restarted = await connected({ clock: h.clock, fake: h.fake, keyManager, storage: h.storage });
    assert.equal(restarted.core.restore, "signed_in");
    await restarted.core.session.call(probe);
    assert.equal(h.fake.paths().filter((path) => path === "POST /auth/refresh").length, 2, "the stored pair is the latest one");
});

test("without KeyManager a refresh never reports the session persistent", async () => {
    const h = await connected({ keyManager: null });
    await signIn(h);
    assert.deepEqual(await h.core.session.refresh(), { status: "refreshed" });
    assert.equal(h.core.session.persistence, "session_only");
});

test("a refresh whose save is still pending when the person signs out reports aborted and leaves persistence alone", async () => {
    const h = await connected();
    await signIn(h);
    const keyManager = h.keyManager;
    assert.ok(keyManager !== undefined);
    const saving = keyManager.holdSaves();
    keyManager.failSave = true;
    const refreshing = h.core.session.refresh();
    await h.clock.advance(0);
    assert.equal(saving.waiting(), 1, "the refreshed pair is being stored");

    const loggingOut = h.core.session.logout();
    saving.release();
    keyManager.failSave = false;
    const [outcome, logout] = await Promise.all([refreshing, loggingOut]);

    assert.deepEqual(outcome, { status: "aborted" });
    assert.equal(logout.storage, "cleared");
    assert.equal(h.core.session.signedIn, false);
    assert.equal(h.core.session.persistence, "persistent", "the signed-out account's failed save does not change it");
    const restarted = await connected({ clock: h.clock, fake: h.fake, keyManager, storage: h.storage });
    assert.equal(restarted.core.restore, "signed_out");
});

test("a refresh whose save is still pending when another sign-in replaces the account reports aborted; the new account stays current", async () => {
    const h = await connected();
    await signIn(h);
    const keyManager = h.keyManager;
    assert.ok(keyManager !== undefined);
    const saving = keyManager.holdSaves();
    keyManager.failSave = true;
    const refreshing = h.core.session.refresh();
    await h.clock.advance(0);
    assert.equal(saving.waiting(), 1);

    const login = h.core.createDeviceLogin();
    login.start();
    await h.clock.advance(0);
    h.fake.approve(latestDeviceCode(h.fake));
    await h.clock.advance(5000);
    assert.equal(login.current.phase, "waiting", "its save waits behind the refresh's");
    saving.release();
    keyManager.failSave = false;
    const outcome = await refreshing;
    await h.clock.advance(0);

    assert.deepEqual(outcome, { status: "aborted" });
    assert.deepEqual(login.current, { phase: "signed_in", persistence: "persistent", previousSession: "cleared", passwordChangeRequired: false });
    assert.equal(h.core.session.persistence, "persistent");
    assert.equal(h.fake.revokedSessions.size, 1, "the replaced account's session is revoked, not the new one");
    await h.core.session.call(probe);
    const restarted = await connected({ clock: h.clock, fake: h.fake, keyManager, storage: h.storage });
    assert.equal(restarted.core.restore, "signed_in");
    await restarted.core.session.call(probe);
});

test("a refresh while fresh sign-in cleanup waits keeps the rotated credential after restart", async () => {
    const h = await connected();
    await signIn(h);
    const keyManager = h.keyManager;
    assert.ok(keyManager !== undefined);
    const saving = keyManager.holdSaves();
    const oldRefresh = h.core.session.refresh();
    await h.clock.advance(0);
    assert.equal(saving.waiting(), 1);

    const login = h.core.createDeviceLogin();
    login.start();
    await h.clock.advance(0);
    h.fake.approve(latestDeviceCode(h.fake));
    await h.clock.advance(5000);
    assert.equal(login.current.phase, "waiting", "cleanup waits behind the replaced account's save");

    const currentRefresh = h.core.session.refresh();
    await h.clock.advance(0);
    assert.equal(h.fake.paths().filter((path) => path === "POST /auth/refresh").length, 2);
    saving.release();
    assert.deepEqual(await oldRefresh, { status: "aborted" });
    assert.deepEqual(await currentRefresh, { status: "refreshed" });
    await h.clock.advance(0);
    assert.equal(login.current.phase, "signed_in");

    await h.core.session.call(probe);
    const currentBearer = h.fake.requests.filter((request) => request.path === "/catalog/probe").slice(-1)[0]?.headers.authorization;
    assert.ok(currentBearer !== undefined);
    const restarted = await connected({ clock: h.clock, fake: h.fake, keyManager, storage: h.storage });
    assert.equal(restarted.core.restore, "signed_in");
    await restarted.core.session.call(probe);
    const restoredBearer = h.fake.requests.filter((request) => request.path === "/catalog/probe").slice(-1)[0]?.headers.authorization;
    assert.equal(restoredBearer, currentBearer, "fresh installation must not overwrite the rotated pair");
});

test("signing out while a new sign-in waits to remove the replaced account's record stores neither account", async () => {
    const h = await connected();
    await signIn(h);
    const keyManager = h.keyManager;
    assert.ok(keyManager !== undefined);
    const saving = keyManager.holdSaves();
    const refreshing = h.core.session.refresh();
    await h.clock.advance(0);
    assert.equal(saving.waiting(), 1, "the refreshed pair is being stored");

    const login = h.core.createDeviceLogin();
    const states = record(login);
    login.start();
    await h.clock.advance(0);
    h.fake.approve(latestDeviceCode(h.fake));
    await h.clock.advance(5000);
    assert.equal(login.current.phase, "waiting", "the new sign-in's storage waits behind the refresh's save");
    const changes: AuthorityChange[] = [];
    h.core.session.onAuthorityChange((change) => changes.push(change));

    const loggingOut = h.core.session.logout();
    saving.release();
    const [outcome, logout] = await Promise.all([refreshing, loggingOut]);
    await h.clock.advance(0);

    assert.deepEqual(outcome, { status: "aborted" });
    assert.equal(logout.storage, "cleared");
    assert.ok(!states.some((state) => state.phase === "signed_in"), "no signed_in after the sign-out");
    assert.equal(login.current.phase, "canceled");
    assert.deepEqual(changes.map((change) => change.reason), ["signed_out"]);
    assert.equal(keyManager.items.size, 0, "nothing stored after the sign-out");
    const restarted = await connected({ clock: h.clock, fake: h.fake, keyManager, storage: h.storage });
    assert.equal(restarted.core.restore, "signed_out");
});
