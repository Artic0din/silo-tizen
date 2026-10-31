import assert from "node:assert/strict";
import { test } from "node:test";
import { connected, signIn } from "./support/harness.ts";
import { FakeDetails } from "./support/fakeDetails.ts";

test("fresh TV asks; remembering stores a protected proof and restores without replaying PIN", async () => {
    const h = await connected();
    await signIn(h);
    h.fake.catalog = new FakeDetails();
    const list = await h.core.profiles.list();
    const kid = list.find(profile => profile.id === "p-kid");
    assert.ok(kid);
    assert.equal(h.core.profileLaunch.needsOffer, true);
    assert.equal(h.core.profileLaunch.remembered, false);
    assert.equal(h.core.profiles.select(kid).status, "pin_required");
    assert.equal((await h.core.profiles.verifyPin(kid.id, "2468")).status, "verified");
    await h.core.profileLaunch.setRemember(true);
    assert.equal(h.core.profileLaunch.remembered, true);
    assert.ok(![...h.storage.items.values()].join("").includes("pvt-"));
    const protectedValues = [...h.keyManager?.items.values() ?? []].join("");
    assert.ok(protectedValues.includes("pvt-"));
    assert.ok(!protectedValues.includes("2468"));
    const attempts = h.fake.pinAttempts;
    const next = await connected({ fake: h.fake, storage: h.storage, keyManager: h.keyManager, clock: h.clock });
    assert.equal(next.core.restore, "signed_in");
    assert.equal((await next.core.profileLaunch.restore(await next.core.profiles.list(), new AbortController().signal))?.id, kid.id);
    assert.equal(next.core.session.activeProfile?.id, kid.id);
    assert.equal(h.fake.pinAttempts, attempts);
    await next.core.profileLaunch.setRemember(false);
    assert.equal(next.core.profileLaunch.remembered, false);
    assert.ok(![...h.keyManager?.items.values() ?? []].join("").includes("pvt-"));
});

test("opting out keeps PIN proof transient; a changed PIN invalidates remembered authority", async () => {
    const h = await connected(); await signIn(h); h.fake.catalog = new FakeDetails();
    const list = await h.core.profiles.list();
    const kid = list.find(profile => profile.id === "p-kid"); assert.ok(kid);
    h.core.profiles.select(kid); await h.core.profiles.verifyPin(kid.id, "2468");
    await h.core.profileLaunch.setRemember(false);
    assert.equal(h.core.profileLaunch.needsOffer, false);
    assert.ok(![...h.keyManager?.items.values() ?? []].join("").includes("pvt-"));
    await h.core.profileLaunch.setRemember(true);
    h.core.session.setProfile(undefined, "profile_proof_revoked");
    assert.equal(h.core.profileLaunch.remembered, false);
    assert.equal(await h.core.profileLaunch.restore(list, new AbortController().signal), undefined);
    assert.equal(h.core.profiles.select(kid).status, "pin_required");
});

test("failed protected saves and cancelled saves never claim a remembered profile", async () => {
    const h = await connected(); await signIn(h);
    const kid = (await h.core.profiles.list()).find(profile => profile.id === "p-kid"); assert.ok(kid);
    h.core.profiles.select(kid); await h.core.profiles.verifyPin(kid.id, "2468");
    assert.ok(h.keyManager); h.keyManager.failSave = true;
    await assert.rejects(h.core.profileLaunch.setRemember(true));
    assert.equal(h.core.profileLaunch.remembered, false);
    h.keyManager.failSave = false;
    const hold = h.keyManager.holdSaves();
    const controller = new AbortController();
    const saving = h.core.profileLaunch.setRemember(true, controller.signal);
    controller.abort(); hold.release();
    await assert.rejects(saving);
    assert.equal(h.core.profileLaunch.remembered, false);
    assert.ok(![...h.keyManager.items.values()].join("").includes("pvt-"));
});

test("unavailable public storage permits an explicit session-only choice and never saves a proof", async () => {
    const h = await connected(); await signIn(h);
    const owner = (await h.core.profiles.list())[0]; assert.ok(owner);
    h.core.profiles.select(owner);
    h.storage.failSet = true;
    await assert.rejects(h.core.profileLaunch.setRemember(false));
    h.core.profileLaunch.continueWithoutSaving();
    assert.equal(h.core.profileLaunch.needsOffer, false);
    assert.equal(h.core.profileLaunch.remembered, false);
    assert.equal(h.core.session.activeProfile?.id, owner.id);
    assert.equal(await h.core.profileLaunch.restore([owner], new AbortController().signal), undefined);
});

test("restoring a server-revoked remembered proof fails closed without a PIN replay", async () => {
    const h = await connected(); await signIn(h); h.fake.catalog = new FakeDetails();
    const kid = (await h.core.profiles.list()).find(profile => profile.id === "p-kid"); assert.ok(kid);
    h.core.profiles.select(kid); await h.core.profiles.verifyPin(kid.id, "2468");
    await h.core.profileLaunch.setRemember(true);
    h.fake.changePin(kid.id, "1357");
    const requests = h.fake.requests.filter(request => request.path.endsWith("/verify-pin")).length;
    const next = await connected({ fake: h.fake, storage: h.storage, keyManager: h.keyManager, clock: h.clock });
    await assert.rejects(next.core.profileLaunch.restore(await next.core.profiles.list(), new AbortController().signal));
    assert.equal(next.core.session.activeProfile, undefined);
    assert.equal(next.core.profileLaunch.remembered, false);
    assert.equal(h.fake.requests.filter(request => request.path.endsWith("/verify-pin")).length, requests);
});
