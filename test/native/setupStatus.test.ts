// Server entry reads GET /system/setup before a session is restored.
// Apple TV: ServerSetupViewModel.swift (needsSetup) and ServerNeedsSetupRetryModel.swift.

import assert from "node:assert/strict";
import { test } from "node:test";
import { connect } from "../../src/session/core.ts";
import { SERVER_NOT_READY_BODY, SERVER_NOT_READY_TITLE, serverHostLabel, SETUP_NEEDED, SETUP_UNREACHABLE, STILL_NEEDS_SETUP } from "../../src/ui/signInText.ts";
import { ManualClock } from "./support/clock.ts";
import { FakeSilo } from "./support/fakeSilo.ts";
import { FakeKeyManager, MemoryPublicStorage } from "./support/keyManager.ts";

const PENDING = { needs_setup: true, wizard_completed: false };

async function connectTo(fake: FakeSilo, clock = new ManualClock()) {
    return connect(fake.origin, {
        fetch: fake.fetch,
        publicStorage: new MemoryPublicStorage(),
        keyManager: new FakeKeyManager(),
        randomBytes: (bytes) => bytes.fill(0xab),
        deviceName: "Living room TV",
        devicePlatform: "tizen",
        clock,
    });
}

test("the recovery copy and host label match TVServerNeedsSetupView", () => {
    assert.equal(SERVER_NOT_READY_TITLE, "This server\nisn't ready");
    assert.equal(SERVER_NOT_READY_BODY, "Ask the server administrator to finish setup. When it is ready, check again.");
    assert.equal(SETUP_NEEDED, "Setup needed");
    assert.equal(STILL_NEEDS_SETUP, "This server still needs administrator setup.");
    assert.equal(SETUP_UNREACHABLE, "Couldn't reach the server. Check it's running and try again.");
    assert.equal(serverHostLabel("https://silo.example.test"), "silo.example.test");
    assert.equal(serverHostLabel("https://silo.example.test:8443/silo"), "silo.example.test:8443");
    assert.equal(serverHostLabel("http://silo.example.test"), "silo.example.test");
    assert.equal(serverHostLabel("not a url"), "not a url");
});

test("server entry reads setup status and does not open a session while setup is still pending", async () => {
    const fake = new FakeSilo(new ManualClock());
    fake.script("/system/setup", { status: 200, body: PENDING });
    const result = await connectTo(fake);
    assert.equal(result.status, "needs_setup");
    assert.deepEqual(fake.paths(), ["GET /system/info", "GET /system/identity", "GET /system/setup"]);
    const setup = fake.requests.find((request) => request.path === "/system/setup");
    assert.equal(setup?.headers.authorization, undefined, "setup status is public");
    assert.equal(fake.paths().some((path) => path.startsWith("POST ")), false, "account creation stays off the TV");
});

test("a failed setup read is a connection failure, the same way discovery reports one", async () => {
    const clock = new ManualClock();
    const down = new FakeSilo(clock);
    down.script("/system/setup", { status: 503 }, { status: 503 });
    const pending = connectTo(down, clock);
    await clock.advance(1000);
    assert.equal((await pending).status, "server_error");

    const lostClock = new ManualClock();
    const lost = new FakeSilo(lostClock);
    lost.dropNextAnswer("/system/setup");
    lost.dropNextAnswer("/system/setup");
    const dropped = connectTo(lost, lostClock);
    await lostClock.advance(1000);
    assert.equal((await dropped).status, "unreachable");

    const malformed = new FakeSilo(new ManualClock());
    malformed.script("/system/setup", { status: 200, body: { needs_setup: true } });
    assert.equal((await connectTo(malformed)).status, "not_silo_v2");
});
