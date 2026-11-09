import assert from "node:assert/strict";
import { test } from "node:test";
import { connected, signIn } from "./support/harness.ts";
import { FakeDetails } from "./support/fakeDetails.ts";
import { FakeKeyManager, MemoryPublicStorage } from "./support/keyManager.ts";

test("timed profile selection expires only after an actual away interval", async () => {
    const h = await connected();
    await signIn(h);
    const profile = (await h.core.profiles.list()).find(item => !item.hasPin);
    assert.ok(profile);
    h.core.profiles.select(profile);
    for (const [behavior, seconds] of [["afterOneHour", 3600], ["afterTwelveHours", 43200]] as const) {
        await h.core.profileLaunch.setBehavior(behavior);
        assert.equal(h.core.profileLaunch.behavior, behavior);
        assert.equal(h.core.profileLaunch.requiresSelection(1e9), false);
        h.core.profileLaunch.recordAway(1000);
        assert.equal(h.core.profileLaunch.requiresSelection(1000 + seconds * 1000 - 1), false);
        assert.equal(h.core.profileLaunch.requiresSelection(1000 + seconds * 1000), true);
        h.core.profileLaunch.recordAway(2000);
        assert.equal(h.core.profileLaunch.requiresSelection(1000 + seconds * 1000), true, "pagehide preserves the first hidden timestamp");
        h.core.profileLaunch.requireSelection();
        h.core.profileLaunch.recordAway(1000 + seconds * 1000);
        assert.equal(h.core.profileLaunch.requiresSelection(1001 + seconds * 1000), true, "returning to the picker does not erase an expired choice");
        await h.core.profileLaunch.setRemember(true);
        h.core.profileLaunch.recordActive();
        assert.equal(h.core.profileLaunch.requiresSelection(1e9), false);
    }
});

test("a timed launch choice commits with its behavior in one storage record", async () => {
    const h = await connected();
    await signIn(h);
    const owner = (await h.core.profiles.list())[0]; assert.ok(owner);
    h.core.profiles.select(owner);
    const save = h.storage.setItem.bind(h.storage);
    let writes = 0;
    h.storage.setItem = (key, value) => {
        if (++writes > 1) throw new Error("Storage quota exhausted");
        save(key, value);
    };
    await assert.doesNotReject(h.core.profileLaunch.setBehavior("afterOneHour"));
    assert.equal(h.core.profileLaunch.behavior, "afterOneHour");
    assert.equal(h.core.profileLaunch.remembered, true);
});

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
    assert.doesNotThrow(() => h.core.profileLaunch.recordActive());
    assert.doesNotThrow(() => h.core.profileLaunch.recordAway(1000));
    assert.equal(h.core.profileLaunch.requiresSelection(1001), true);
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

test("signing in again drops a remembered profile for this run when storage refuses the clear", async () => {
    const h = await connected(); await signIn(h);
    const owner = (await h.core.profiles.list())[0]; assert.ok(owner);
    h.core.profiles.select(owner);
    await h.core.profileLaunch.setRemember(true);
    assert.equal(h.core.profileLaunch.remembered, true);
    h.storage.failSet = true;
    await signIn(h);
    assert.equal(h.core.profileLaunch.remembered, false);
    assert.equal(await h.core.profileLaunch.restore(await h.core.profiles.list(), new AbortController().signal), undefined);
    assert.equal(h.core.session.activeProfile, undefined);
    h.storage.failSet = false;
    await signIn(h);
    assert.equal(h.core.profileLaunch.remembered, false, "the next clear that storage accepts is saved");
    assert.equal(h.storage.getItem([...h.storage.items.keys()].find(key => key.startsWith("silo.native.profileLaunch:")) ?? ""), '{"remember":false}');
});

test("a remembered profile the server no longer lists stays dropped for this run when storage refuses the clear", async () => {
    const h = await connected(); await signIn(h);
    const owner = (await h.core.profiles.list())[0]; assert.ok(owner);
    h.core.profiles.select(owner);
    await h.core.profileLaunch.setRemember(true);
    h.storage.failSet = true;
    assert.equal(await h.core.profileLaunch.restore([], new AbortController().signal), undefined);
    assert.equal(h.core.profileLaunch.remembered, false);
    assert.equal(await h.core.profileLaunch.restore([owner], new AbortController().signal), undefined);
});

let counter = 0;
const distinctBytes = (bytes: Uint8Array): void => { counter++; bytes.fill(counter % 251); bytes[0] = counter % 256; bytes[1] = Math.floor(counter / 256) % 256; };

/** Refuses writes to the launch choice only, so the credential and account list still save. */
class LaunchChoiceRefusingStorage extends MemoryPublicStorage {
    refuse = false;
    override setItem(key: string, value: string): void {
        if (this.refuse && key.startsWith("silo.native.profileLaunch:")) throw new Error("QuotaExceededError");
        super.setItem(key, value);
    }
}

test("a sign-in invalidates a remembered profile across a restart when storage refuses the launch choice", async () => {
    const storage = new LaunchChoiceRefusingStorage();
    const h = await connected({ storage, randomBytes: distinctBytes }); await signIn(h);
    const owner = (await h.core.profiles.list())[0]; assert.ok(owner);
    h.core.profiles.select(owner);
    await h.core.profileLaunch.setRemember(true);
    assert.equal(h.core.profileLaunch.remembered, true);
    storage.refuse = true;
    await signIn(h);
    assert.equal(h.core.profileLaunch.remembered, false);
    const next = await connected({ fake: h.fake, storage, keyManager: h.keyManager, clock: h.clock, randomBytes: distinctBytes });
    assert.equal(next.core.restore, "signed_in");
    assert.equal(next.core.profileLaunch.remembered, false);
    assert.equal(await next.core.profileLaunch.restore(await next.core.profiles.list(), new AbortController().signal), undefined);
    assert.equal(next.core.session.activeProfile, undefined);
});

function launchKey(storage: MemoryPublicStorage): string {
    const key = [...storage.items.keys()].find(candidate => candidate.startsWith("silo.native.profileLaunch:") && !candidate.endsWith(":away"));
    assert.ok(key);
    return key;
}

test("a remembered profile saved before sign-in epochs existed is ignored and cleared at launch", async () => {
    const h = await connected({ randomBytes: distinctBytes }); await signIn(h);
    const owner = (await h.core.profiles.list())[0]; assert.ok(owner);
    h.core.profiles.select(owner);
    await h.core.profileLaunch.setRemember(true);
    const key = launchKey(h.storage);
    const { epoch: _epoch, ...legacy } = JSON.parse(h.storage.getItem(key) ?? "{}");
    h.storage.setItem(key, JSON.stringify(legacy));
    const next = await connected({ fake: h.fake, storage: h.storage, keyManager: h.keyManager, clock: h.clock, randomBytes: distinctBytes });
    assert.equal(next.core.profileLaunch.remembered, false);
    assert.equal(await next.core.profileLaunch.restore(await next.core.profiles.list(), new AbortController().signal), undefined);
    assert.equal(h.storage.getItem(key), '{"remember":false}');
});

test("a credential saved before sign-in epochs existed is stamped on load and can then be remembered", async () => {
    const h = await connected({ randomBytes: distinctBytes }); await signIn(h);
    assert.ok(h.keyManager);
    let stripped = 0;
    for (const [alias, value] of h.keyManager.items) {
        const record: unknown = JSON.parse(value);
        if (typeof record === "object" && record !== null && "signInEpoch" in record) {
            const { signInEpoch: _epoch, ...legacy } = record;
            h.keyManager.items.set(alias, JSON.stringify(legacy));
            stripped++;
        }
    }
    assert.ok(stripped > 0);
    h.fake.catalog = new FakeDetails();
    const next = await connected({ fake: h.fake, storage: h.storage, keyManager: h.keyManager, clock: h.clock, randomBytes: distinctBytes });
    assert.equal(next.core.restore, "signed_in");
    assert.ok(next.core.session.signInEpoch);
    const owner = (await next.core.profiles.list())[0]; assert.ok(owner);
    next.core.profiles.select(owner);
    await next.core.profileLaunch.setRemember(true);
    const again = await connected({ fake: h.fake, storage: h.storage, keyManager: h.keyManager, clock: h.clock, randomBytes: distinctBytes });
    assert.equal(again.core.session.signInEpoch, next.core.session.signInEpoch, "the stamped epoch was saved");
    assert.equal((await again.core.profileLaunch.restore(await again.core.profiles.list(), new AbortController().signal))?.id, owner.id);
});

test("a PIN proof the key store refuses to remove is kept on the cleared choice and removed on a later start", async () => {
    const keyManager = new RefusingProofKeyManager();
    const h = await connected({ keyManager, randomBytes: distinctBytes }); await signIn(h);
    const kid = (await h.core.profiles.list()).find(profile => profile.id === "p-kid"); assert.ok(kid);
    h.core.profiles.select(kid); await h.core.profiles.verifyPin(kid.id, "2468");
    await h.core.profileLaunch.setRemember(true);
    const proofAliases = (): string[] => [...keyManager.items.keys()].filter(alias => alias.startsWith("silo.profile."));
    assert.equal(proofAliases().length, 1);
    keyManager.refuseProofRemoval = true;
    await signIn(h);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(proofAliases().length, 1, "the old proof is still stored");
    const key = launchKey(h.storage);
    assert.equal(JSON.parse(h.storage.getItem(key) ?? "{}").proofAlias, proofAliases()[0], "the alias is kept for the retry");
    const stuck = await connected({ fake: h.fake, storage: h.storage, keyManager, clock: h.clock, randomBytes: distinctBytes });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stuck.core.profileLaunch.remembered, false);
    assert.equal(proofAliases().length, 1);
    keyManager.refuseProofRemoval = false;
    const retried = await connected({ fake: h.fake, storage: h.storage, keyManager, clock: h.clock, randomBytes: distinctBytes });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(retried.core.profileLaunch.remembered, false);
    assert.equal(proofAliases().length, 0);
    assert.equal(h.storage.getItem(key), '{"remember":false}');
});

test("a replaced PIN proof the key store refuses to remove is retried on later starts while the new choice keeps working", async () => {
    const keyManager = new RefusingProofKeyManager();
    const h = await connected({ keyManager, randomBytes: distinctBytes }); await signIn(h);
    h.fake.catalog = new FakeDetails();
    const kid = (await h.core.profiles.list()).find(profile => profile.id === "p-kid"); assert.ok(kid);
    h.core.profiles.select(kid); await h.core.profiles.verifyPin(kid.id, "2468");
    await h.core.profileLaunch.setRemember(true);
    const proofAliases = (): string[] => [...keyManager.items.keys()].filter(alias => alias.startsWith("silo.profile."));
    const [oldAlias] = proofAliases(); assert.ok(oldAlias);
    keyManager.refuseProofRemoval = true;
    await h.core.profileLaunch.setRemember(true);
    assert.equal(proofAliases().length, 2, "the replaced proof is still stored");
    const stuck = await connected({ fake: h.fake, storage: h.storage, keyManager, clock: h.clock, randomBytes: distinctBytes });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stuck.core.profileLaunch.remembered, true);
    assert.equal(proofAliases().length, 2, "a refused retry keeps naming the replaced proof");
    keyManager.refuseProofRemoval = false;
    const retried = await connected({ fake: h.fake, storage: h.storage, keyManager, clock: h.clock, randomBytes: distinctBytes });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(keyManager.items.has(oldAlias), false, "the replaced proof is removed");
    assert.equal(proofAliases().length, 1, "the new proof is kept");
    assert.equal(retried.core.profileLaunch.remembered, true);
    assert.equal((await retried.core.profileLaunch.restore(await retried.core.profiles.list(), new AbortController().signal))?.id, kid.id);
    assert.equal(retried.core.session.activeProfile?.id, kid.id);
    assert.equal(JSON.parse(h.storage.getItem(launchKey(h.storage)) ?? "{}").retiredAliases, undefined, "nothing left to retry");
});

test("two overlapping replacements leave no proof unnamed", async () => {
    const keyManager = new RefusingProofKeyManager();
    const h = await connected({ keyManager, randomBytes: distinctBytes }); await signIn(h);
    const kid = (await h.core.profiles.list()).find(profile => profile.id === "p-kid"); assert.ok(kid);
    h.core.profiles.select(kid); await h.core.profiles.verifyPin(kid.id, "2468");
    await h.core.profileLaunch.setRemember(true);
    const proofAliases = (): string[] => [...keyManager.items.keys()].filter(alias => alias.startsWith("silo.profile."));
    keyManager.refuseProofRemoval = true;
    await Promise.all([h.core.profileLaunch.setRemember(true), h.core.profileLaunch.setRemember(true)]);
    keyManager.refuseProofRemoval = false;
    await connected({ fake: h.fake, storage: h.storage, keyManager, clock: h.clock, randomBytes: distinctBytes });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(proofAliases().length, 1, "only the newest proof is left");
});

test("continuing without saving keeps replaced proofs named so sign-in still removes them", async () => {
    const keyManager = new RefusingProofKeyManager();
    const h = await connected({ keyManager, randomBytes: distinctBytes }); await signIn(h);
    const kid = (await h.core.profiles.list()).find(profile => profile.id === "p-kid"); assert.ok(kid);
    h.core.profiles.select(kid); await h.core.profiles.verifyPin(kid.id, "2468");
    await h.core.profileLaunch.setRemember(true);
    const proofAliases = (): string[] => [...keyManager.items.keys()].filter(alias => alias.startsWith("silo.profile."));
    keyManager.refuseProofRemoval = true;
    await h.core.profileLaunch.setRemember(true);
    keyManager.refuseProofRemoval = false;
    h.core.profileLaunch.continueWithoutSaving();
    await signIn(h);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(proofAliases().length, 0, "both proofs are removed");
});

class RefusingProofKeyManager extends FakeKeyManager {
    refuseProofRemoval = false;
    override removeData(dataAlias: { readonly name: string }): void {
        if (this.refuseProofRemoval && dataAlias.name.startsWith("silo.profile.")) throw new Error("UnknownError");
        super.removeData(dataAlias);
    }
}

test("a stored PIN proof from another sign-in epoch is refused and removed", async () => {
    const h = await connected({ randomBytes: distinctBytes }); await signIn(h);
    h.fake.catalog = new FakeDetails();
    const kid = (await h.core.profiles.list()).find(profile => profile.id === "p-kid"); assert.ok(kid);
    h.core.profiles.select(kid); await h.core.profiles.verifyPin(kid.id, "2468");
    await h.core.profileLaunch.setRemember(true);
    assert.ok(h.keyManager);
    const [alias, value] = [...h.keyManager.items].find(([name]) => name.startsWith("silo.profile.")) ?? []; assert.ok(alias && value);
    h.keyManager.items.set(alias, JSON.stringify({ ...JSON.parse(value), epoch: "older-sign-in" }));
    const next = await connected({ fake: h.fake, storage: h.storage, keyManager: h.keyManager, clock: h.clock, randomBytes: distinctBytes });
    assert.equal(await next.core.profileLaunch.restore(await next.core.profiles.list(), new AbortController().signal), undefined);
    assert.equal(next.core.session.activeProfile, undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.keyManager.items.has(alias), false);
});
