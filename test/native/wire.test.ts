import assert from "node:assert/strict";
import { test } from "node:test";
import {
    decodeDeviceLoginCapability,
    decodeDeviceLoginCancel,
    decodeDeviceLoginPoll,
    decodeDeviceLoginStart,
    decodeProblem,
    decodeProfileCollection,
    decodeProfileVerification,
    decodeRefreshedTokens,
    decodeSystemInfo,
    WireError,
} from "../../src/contracts/v2/wire.ts";
import { fixture } from "./support/fakeSilo.ts";

test("vendored contract fixtures decode with the production decoders", () => {
    assert.deepEqual(decodeSystemInfo(fixture("get_system_info_ok")), {
        apiMajor: 2,
        serverVersion: "unavailable",
        requestOrigin: "http://api.example.test",
    });
    assert.deepEqual(decodeDeviceLoginCapability(fixture("get_device_login_capability_ok")), {
        state: "available",
        cancel: true,
        openedSignal: true,
    });
    const start = decodeDeviceLoginStart(fixture("start_device_login_ok"));
    assert.equal(start.userCode, "4821-7730");
    assert.equal(start.verificationUriComplete, "https://silo.example.test/activate?code=48217730");
    assert.equal(start.expiresAt, Date.parse("2026-01-02T03:19:05.678Z"));
    assert.equal(start.expiresInSeconds, 900);
    assert.equal(start.intervalSeconds, 5);

    assert.deepEqual(decodeDeviceLoginPoll(fixture("poll_device_login_opened")), {
        status: "pending",
        pollAfterSeconds: 5,
        opened: true,
        expiresAt: Date.parse("2026-01-02T03:14:05.678Z"),
    });
    const approved = decodeDeviceLoginPoll(fixture("poll_device_login_ok"));
    assert.equal(approved.status, "approved");
    if (approved.status === "approved") {
        assert.deepEqual(approved.tokens, { accessToken: "acc", refreshToken: "ref", expiresInSeconds: 3600 });
        assert.deepEqual(approved.account, { id: "1", username: "laura", passwordChangeRequired: false });
        assert.equal(approved.temporary, false);
    }
    assert.equal(decodeDeviceLoginCancel(fixture("cancel_device_login_ok")), "canceled");
    assert.deepEqual(decodeRefreshedTokens(fixture("refresh_session_ok")), { accessToken: "acc2", refreshToken: "ref2", expiresInSeconds: 3600 });
    assert.deepEqual(decodeProfileCollection(fixture("list_profiles_ok")), [
        { id: "p-owner", name: "Laura", hasPin: false, isPrimary: true, isChild: false, avatarUrl: "/avatars/presets/fox.png" },
    ]);
    assert.deepEqual(decodeProfileVerification(fixture("verify_profile_pin_ok")), {
        valid: true,
        profileToken: "pvt_fixture",
        expiresAt: Date.parse("2026-01-02T15:04:05.678Z"),
    });
    assert.deepEqual(decodeProfileVerification(fixture("verify_profile_pin_wrong")), { valid: false });
});

test("problem fixtures expose the identifier clients branch on", () => {
    const cases: [string, string, number][] = [
        ["refresh_session_revoked", "session_expired", 401],
        ["refresh_session_provider_unavailable", "provider_unavailable", 503],
        ["token_refresh_required", "token_refresh_required", 401],
        ["authentication_required", "authentication_required", 401],
        ["profile_verification_required", "profile_verification_required", 403],
        ["rate_limited", "rate_limited", 429],
        ["cancel_device_login_not_found", "not_found", 404],
    ];
    for (const [name, id, status] of cases) {
        const problem = decodeProblem(fixture(name));
        assert.equal(problem.id, id, name);
        assert.equal(problem.status, status, name);
    }
});

test("server additions are tolerated: unknown members and unknown enum values", () => {
    const poll = decodeDeviceLoginPoll({ ...fixture("poll_device_login_opened"), status: "quarantined", new_member: 1 });
    assert.deepEqual(poll, { status: "unknown" });
    const capability = decodeDeviceLoginCapability({ ...fixture("get_device_login_capability_ok"), state: "paused", extra: true });
    assert.equal(capability.state, "unknown");
});

test("missing or mistyped consumed members are rejected without echoing the value", () => {
    const leaked = "secret-refresh-token-value";
    const tokens = { ...fixture("refresh_session_ok"), refresh_token: 42, access_token: leaked };
    assert.throws(
        () => decodeRefreshedTokens(tokens),
        (error: unknown) => error instanceof WireError && error.path === "refreshed_tokens.refresh_token" && !error.message.includes(leaked),
    );
    const approved = fixture("poll_device_login_ok");
    assert.throws(() => decodeDeviceLoginPoll({ ...approved, tokens: undefined }), WireError);
    assert.throws(() => decodeDeviceLoginStart({ ...fixture("start_device_login_ok"), expires_at: "soon" }), WireError);
    assert.throws(() => decodeProfileVerification({ valid: true, expires_at: null }), WireError);
});
