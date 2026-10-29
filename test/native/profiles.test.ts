import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../src/api/errors.ts";
import type { ProfileSummary } from "../../src/contracts/v2/wire.ts";
import type { AuthorityChange, AuthorizedSpec } from "../../src/session/session.ts";
import { connected, type Harness, signIn } from "./support/harness.ts";

const probe: AuthorizedSpec<unknown> = { method: "GET", path: "/catalog/probe", retry: "safe", decode: (body) => body, profileScoped: true };

async function household(): Promise<{ h: Harness; owner: ProfileSummary; kid: ProfileSummary; changes: AuthorityChange[] }> {
    const h = await connected();
    await signIn(h);
    const list = await h.core.profiles.list();
    const owner = list.find((profile) => profile.id === "p-owner");
    const kid = list.find((profile) => profile.id === "p-kid");
    assert.ok(owner !== undefined && kid !== undefined);
    const changes: AuthorityChange[] = [];
    h.core.session.onAuthorityChange((change) => changes.push(change));
    return { h, owner, kid, changes };
}

function lastProbe(h: Harness): Readonly<Record<string, string>> {
    const request = h.fake.requests.filter((candidate) => candidate.path === "/catalog/probe").pop();
    assert.ok(request !== undefined);
    return request.headers;
}

test("profile headers go only on profile-scoped calls; public calls carry no account bearer", async () => {
    const { h, owner } = await household();
    assert.deepEqual(h.core.profiles.select(owner), { status: "selected" });
    await h.core.session.call(probe);
    assert.equal(lastProbe(h)["x-profile-id"], "p-owner");
    assert.equal(lastProbe(h)["x-profile-token"], undefined);
    const list = h.fake.requests.filter((request) => request.path === "/profiles").pop();
    assert.equal(list?.headers["x-profile-id"], undefined);
    const publicCalls = h.fake.requests.filter((request) => request.path.startsWith("/system") || request.path.startsWith("/auth/device"));
    assert.ok(publicCalls.length > 0);
    assert.ok(publicCalls.every((request) => request.headers.authorization === undefined && request.headers["x-profile-id"] === undefined));
});

test("a PIN profile needs proof; the old profile stops acting as soon as the switch starts", async () => {
    const { h, owner, kid, changes } = await household();
    h.core.profiles.select(owner);
    assert.deepEqual(h.core.profiles.select(kid), { status: "pin_required" });
    assert.equal(h.core.session.activeProfile, undefined);
    await h.core.session.call(probe);
    assert.equal(lastProbe(h)["x-profile-id"], undefined, "no profile acts while the PIN is pending");

    assert.deepEqual(await h.core.profiles.verifyPin("p-kid", "2468"), { status: "verified" });
    await h.core.session.call(probe);
    assert.equal(lastProbe(h)["x-profile-id"], "p-kid");
    assert.ok(lastProbe(h)["x-profile-token"]?.startsWith("pvt-"));
    const pinRequest = h.fake.requests.find((request) => request.path === "/profiles/p-kid/verify-pin");
    assert.equal(pinRequest?.headers["x-profile-id"], undefined);
    assert.deepEqual(changes.map((change) => change.reason), ["profile_selected", "profile_cleared", "profile_selected"]);
});

test("wrong PINs are reported once each and never resent; the lockout's Retry-After is honored locally", async () => {
    const { h } = await household();
    for (let attempt = 1; attempt <= 5; attempt++) {
        assert.deepEqual(await h.core.profiles.verifyPin("p-kid", "0000"), { status: "wrong_pin" });
    }
    assert.equal(h.fake.pinAttempts, 5);
    assert.deepEqual(await h.core.profiles.verifyPin("p-kid", "2468"), { status: "locked", retryAfterSeconds: 300 });
    const sent = h.fake.requests.filter((request) => request.path.endsWith("/verify-pin")).length;
    assert.equal(sent, 6);

    // Locally locked: no request until Retry-After passes.
    await h.clock.advance(299 * 1000);
    assert.deepEqual(await h.core.profiles.verifyPin("p-kid", "2468"), { status: "locked", retryAfterSeconds: 1 });
    assert.equal(h.fake.requests.filter((request) => request.path.endsWith("/verify-pin")).length, sent);
    await h.clock.advance(1000);
    assert.deepEqual(await h.core.profiles.verifyPin("p-kid", "2468"), { status: "verified" });
});

test("a PIN check with no answer is uncertain and is not replayed", async () => {
    const { h } = await household();
    h.fake.dropNextAnswer("/profiles/p-kid/verify-pin");
    assert.deepEqual(await h.core.profiles.verifyPin("p-kid", "2468"), { status: "uncertain" });
    assert.equal(h.fake.requests.filter((request) => request.path.endsWith("/verify-pin")).length, 1);
    assert.equal(h.core.session.activeProfile, undefined);
});

test("a PIN check rejected for an expired access token refreshes but asks for the PIN again", async () => {
    const { h } = await household();
    h.fake.expireAccessTokens();
    assert.deepEqual(await h.core.profiles.verifyPin("p-kid", "2468"), { status: "enter_again" });
    assert.equal(h.fake.requests.filter((request) => request.path.endsWith("/verify-pin")).length, 1);
    assert.equal(h.fake.pinAttempts, 0, "the refused request never reached the PIN check");
    assert.deepEqual(await h.core.profiles.verifyPin("p-kid", "2468"), { status: "verified" });
});

test("a server-side PIN change revokes the proof: headers are dropped and the player is told to stop", async () => {
    const { h, kid, changes } = await household();
    h.core.profiles.select(kid);
    await h.core.profiles.verifyPin("p-kid", "2468");
    const signal = h.core.session.authoritySignal;
    h.fake.changePin("p-kid", "1357");
    await assert.rejects(h.core.session.call(probe), (error: unknown) => error instanceof ApiError && error.problemId === "profile_verification_required");
    assert.equal(h.core.session.activeProfile, undefined);
    assert.equal(signal.aborted, true);
    assert.equal(changes[changes.length - 1]?.reason, "profile_proof_revoked");
    await h.core.session.call(probe);
    assert.equal(lastProbe(h)["x-profile-token"], undefined);
});

test("signing out drops the profile proof with the account", async () => {
    const { h, kid } = await household();
    h.core.profiles.select(kid);
    await h.core.profiles.verifyPin("p-kid", "2468");
    await h.core.session.logout();
    assert.equal(h.core.session.activeProfile, undefined);
    assert.deepEqual(await h.core.profiles.verifyPin("p-kid", "2468"), { status: "signed_out" });
});

const teen: ProfileSummary = { id: "p-teen", name: "Teen", hasPin: true, isPrimary: false, isChild: true, avatarUrl: undefined };

/** With no profile active, a PIN check for the kid is out when `change` happens; its proof arrives after. */
async function lateProofAfter(change: (h: Harness) => void): Promise<void> {
    const { h } = await household();
    assert.equal(h.core.session.activeProfile, undefined);
    const held = h.fake.hold("/profiles/p-kid/verify-pin", true);
    const verifying = h.core.profiles.verifyPin("p-kid", "2468");
    await h.clock.advance(0);
    assert.equal(h.fake.requests.filter((request) => request.path === "/profiles/p-kid/verify-pin").length, 1);
    change(h);
    held.release();
    assert.deepEqual(await verifying, { status: "aborted" });
    assert.equal(h.core.session.activeProfile, undefined, "the late proof selects nobody");
}

test("choosing another locked profile discards a PIN proof still on its way", () =>
    lateProofAfter((h) => assert.deepEqual(h.core.profiles.select(teen), { status: "pin_required" })));

test("clearing the selection discards a PIN proof still on its way", () => lateProofAfter((h) => h.core.profiles.clear()));
