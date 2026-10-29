import assert from "node:assert/strict";
import { test } from "node:test";
import { forgetStoredCredential } from "../../src/session/core.ts";
import { CredentialVault, type StoredCredential } from "../../src/session/credentialVault.ts";
import { findTizenKeyManager, keyManagerStore, memoryStore, openSecretStore } from "../../src/session/secretStore.ts";
import { ManualClock } from "./support/clock.ts";
import { FakeSilo } from "./support/fakeSilo.ts";
import { connected, signIn } from "./support/harness.ts";
import { FakeKeyManager, MemoryPublicStorage } from "./support/keyManager.ts";

const BASE = "https://silo.example.test";

function credential(n: number): StoredCredential {
    return {
        baseUrl: BASE,
        serverId: "server-1",
        accountId: "1",
        username: "laura",
        accessToken: `acc-${n}`,
        refreshToken: `ref-${n}`,
        accessExpiresAt: 1000 * n,
    };
}

test("save, rotate and load through the KeyManager port", async () => {
    const keyManager = new FakeKeyManager();
    const vault = new CredentialVault(keyManagerStore(keyManager), new MemoryPublicStorage(), BASE);
    assert.equal(await vault.save(credential(1)), "saved");
    assert.equal(await vault.save(credential(2)), "saved");
    assert.equal(await vault.save(credential(3)), "saved");
    assert.equal(keyManager.items.size, 1, "the older slot is removed after each rotation");
    const reloaded = new CredentialVault(keyManagerStore(keyManager), new MemoryPublicStorage(), BASE);
    assert.deepEqual(await reloaded.load(), { status: "found", credential: credential(3) });
});

test("a failed rotation keeps the previous record loadable", async () => {
    const keyManager = new FakeKeyManager();
    const vault = new CredentialVault(keyManagerStore(keyManager), new MemoryPublicStorage(), BASE);
    await vault.save(credential(1));
    keyManager.failSave = true;
    assert.equal(await vault.save(credential(2)), "failed");
    const reloaded = new CredentialVault(keyManagerStore(keyManager), new MemoryPublicStorage(), BASE);
    assert.deepEqual(await reloaded.load(), { status: "found", credential: credential(1) });
});

test("a corrupt record is discarded and reported; a read failure discards nothing", async () => {
    const keyManager = new FakeKeyManager();
    const vault = new CredentialVault(keyManagerStore(keyManager), new MemoryPublicStorage(), BASE);
    await vault.save(credential(1));
    const [alias] = [...keyManager.items.keys()];
    assert.ok(alias !== undefined);
    keyManager.items.set(alias, "{not json");
    keyManager.failGet = true;
    assert.deepEqual(await new CredentialVault(keyManagerStore(keyManager), undefined, BASE).load(), { status: "unavailable" });
    assert.equal(keyManager.items.size, 1);
    keyManager.failGet = false;
    assert.deepEqual(await new CredentialVault(keyManagerStore(keyManager), undefined, BASE).load(), { status: "corrupt" });
    assert.equal(keyManager.items.size, 0);
});

test("a delete that KeyManager refuses can never bring the session back", async () => {
    const keyManager = new FakeKeyManager();
    const storage = new MemoryPublicStorage();
    const vault = new CredentialVault(keyManagerStore(keyManager), storage, BASE);
    await vault.save(credential(1));
    keyManager.failRemove = true;
    assert.equal(await vault.clear(), "guarded");
    assert.equal(keyManager.items.size, 1, "the record is still in KeyManager");
    keyManager.failRemove = false;
    const reloaded = new CredentialVault(keyManagerStore(keyManager), storage, BASE);
    assert.deepEqual(await reloaded.load(), { status: "none" });
    assert.equal(keyManager.items.size, 0, "the leftover is removed once KeyManager allows it");
    // A later sign-in still persists above the floor.
    assert.equal(await reloaded.save(credential(2)), "saved");
    assert.deepEqual(await new CredentialVault(keyManagerStore(keyManager), storage, BASE).load(), { status: "found", credential: credential(2) });
});

test("without KeyManager the session works for this run only and never touches localStorage", async () => {
    assert.equal(findTizenKeyManager({}), undefined);
    assert.equal(findTizenKeyManager({ tizen: { keymanager: { saveData: 1 } } }), undefined);
    const keyManager = new FakeKeyManager();
    assert.equal(findTizenKeyManager({ tizen: { keymanager: keyManager } }), keyManager);
    assert.equal(openSecretStore(undefined).persistent, false);
    assert.equal(memoryStore().persistent, false);

    const h = await connected({ keyManager: null });
    const login = h.core.createDeviceLogin();
    login.start();
    await h.clock.advance(0);
    const [code] = [...h.fake.devices.keys()];
    assert.ok(code !== undefined);
    h.fake.approve(code);
    await h.clock.advance(5000);
    assert.deepEqual(login.current, { phase: "signed_in", persistence: "session_only", previousSession: "cleared", passwordChangeRequired: false });
    assert.equal(h.core.session.persistence, "session_only");
    // Only the device id and the sign-in's logout floor, a number.
    assert.deepEqual(
        [...h.storage.items.entries()].filter(([key]) => key !== "silo.native.deviceId").map(([key, value]) => [key.startsWith("silo.native.clearedGeneration."), value]),
        [[true, "0"]],
    );

    const restarted = await connected({ keyManager: null, clock: h.clock, fake: h.fake, storage: h.storage });
    assert.equal(restarted.core.restore, "signed_out");
});

test("KeyManager that fails to save leaves a usable session-only sign-in", async () => {
    const keyManager = new FakeKeyManager();
    keyManager.failSave = true;
    const h = await connected({ keyManager });
    await signIn(h);
    assert.equal(h.core.session.persistence, "session_only");
    assert.equal(h.core.session.signedIn, true);
});

test("a clear that can neither read nor delete the record still keeps it from coming back; a new sign-in persists after", async () => {
    const h = await connected();
    await signIn(h);
    const keyManager = h.keyManager;
    assert.ok(keyManager !== undefined);
    keyManager.failGet = true;
    keyManager.failRemove = true;
    assert.equal(await forgetStoredCredential(h.fake.origin, { publicStorage: h.storage, keyManager }), "guarded");
    assert.equal(keyManager.items.size, 1, "the record is still in KeyManager");

    keyManager.failGet = false;
    keyManager.failRemove = false;
    const restarted = await connected({ clock: h.clock, fake: h.fake, keyManager, storage: h.storage });
    assert.equal(restarted.core.restore, "signed_out");
    assert.equal(keyManager.items.size, 0, "the leftover is removed once KeyManager allows it");

    await signIn(restarted);
    assert.equal(restarted.core.session.persistence, "persistent");
    const again = await connected({ clock: h.clock, fake: h.fake, keyManager, storage: h.storage });
    assert.equal(again.core.restore, "signed_in");
});

test("while a record a clear could not read is still unreadable, a save is refused instead of hidden", async () => {
    const keyManager = new FakeKeyManager();
    const storage = new MemoryPublicStorage();
    await new CredentialVault(keyManagerStore(keyManager), storage, BASE).save(credential(1));
    keyManager.failGet = true;
    keyManager.failRemove = true;
    assert.equal(await new CredentialVault(keyManagerStore(keyManager), storage, BASE).clear(), "guarded");
    keyManager.failRemove = false;
    assert.equal(await new CredentialVault(keyManagerStore(keyManager), storage, BASE).save(credential(2)), "failed");
    keyManager.failGet = false;
    assert.deepEqual(await new CredentialVault(keyManagerStore(keyManager), storage, BASE).load(), { status: "none" });
});

function vaultOn(keyManager: FakeKeyManager, storage: MemoryPublicStorage): CredentialVault {
    return new CredentialVault(keyManagerStore(keyManager), storage, BASE);
}

function floorKey(storage: MemoryPublicStorage): string {
    const [key] = [...storage.items.keys()];
    assert.ok(key !== undefined, "a clear wrote its floor");
    return key;
}

for (const marker of ["number", "every generation"] as const) {
    test(`while the logout floor (${marker}) cannot be read, nothing is restored, saved or deleted`, async () => {
        const keyManager = new FakeKeyManager();
        const storage = new MemoryPublicStorage();
        await vaultOn(keyManager, storage).save(credential(1));
        keyManager.failRemove = true;
        keyManager.failGet = marker === "every generation";
        assert.equal(await vaultOn(keyManager, storage).clear(), "guarded");
        assert.equal(storage.items.get(floorKey(storage)), marker === "number" ? "1" : "Infinity");
        keyManager.failRemove = false;
        keyManager.failGet = false;
        const leftover = [...keyManager.items.entries()];
        assert.equal(leftover.length, 1, "the cleared record is still in KeyManager");

        storage.failGet = true;
        const launched = vaultOn(keyManager, storage);
        assert.deepEqual(await launched.load(), { status: "unavailable" }, "a cleared record is never restored");
        assert.equal(await launched.save(credential(2)), "failed", "no generation is allocated without the floor");
        assert.deepEqual(await vaultOn(keyManager, storage).load(), { status: "unavailable" });
        assert.deepEqual([...keyManager.items.entries()], leftover, "nothing is deleted or written while the floor is unreadable");

        storage.failGet = false;
        assert.equal(await launched.save(credential(3)), "saved", "a later sign-in persists once the floor reads");
        assert.deepEqual(await vaultOn(keyManager, storage).load(), { status: "found", credential: credential(3) });
    });
}

test("a clear while the floor cannot be read still keeps the record from coming back", async () => {
    const keyManager = new FakeKeyManager();
    const storage = new MemoryPublicStorage();
    await vaultOn(keyManager, storage).save(credential(1));
    storage.failGet = true;
    keyManager.failRemove = true;
    assert.equal(await vaultOn(keyManager, storage).clear(), "guarded");
    storage.failGet = false;
    keyManager.failRemove = false;
    assert.deepEqual(await vaultOn(keyManager, storage).load(), { status: "none" });
    assert.equal(keyManager.items.size, 0);
    assert.equal(await vaultOn(keyManager, storage).save(credential(2)), "saved");
    assert.deepEqual(await vaultOn(keyManager, storage).load(), { status: "found", credential: credential(2) });
});

for (const malformed of ["garbage", "", "-1", "1.5", "99999999999999999999"]) {
    test(`a floor that is not a count (${JSON.stringify(malformed)}) excludes every record, then later sign-ins persist`, async () => {
        const keyManager = new FakeKeyManager();
        const storage = new MemoryPublicStorage();
        await vaultOn(keyManager, storage).save(credential(1));
        keyManager.failRemove = true;
        assert.equal(await vaultOn(keyManager, storage).clear(), "guarded");
        keyManager.failRemove = false;
        storage.items.set(floorKey(storage), malformed);

        assert.deepEqual(await vaultOn(keyManager, storage).load(), { status: "none" });
        assert.equal(keyManager.items.size, 0, "the leftover is removed");
        assert.equal(await vaultOn(keyManager, storage).save(credential(2)), "saved");
        assert.deepEqual(await vaultOn(keyManager, storage).load(), { status: "found", credential: credential(2) });
    });
}

test("no generation is allocated until every slot has been read: an older account in the other slot cannot win", async () => {
    const keyManager = new FakeKeyManager();
    const storage = new MemoryPublicStorage();
    const previous = vaultOn(keyManager, storage);
    await previous.save(credential(1));
    await previous.save(credential(2));
    assert.deepEqual(
        [...keyManager.items.keys()].map((alias) => alias.slice(-2)),
        [".b"],
        "generation 2 sits in slot b, slot a is empty",
    );

    keyManager.failGet = true;
    keyManager.failRemove = true;
    const launched = vaultOn(keyManager, storage);
    assert.deepEqual(await launched.load(), { status: "unavailable" });
    const other: StoredCredential = { ...credential(9), accountId: "2", username: "sam" };
    assert.equal(await launched.save(other), "failed", "slot a is writable, but generation 1 would sit under slot b's 2");
    assert.equal(keyManager.items.size, 1);

    keyManager.failGet = false;
    keyManager.failRemove = false;
    assert.equal(await launched.save(other), "saved", "the next save reads every slot again");
    assert.deepEqual(await vaultOn(keyManager, storage).load(), { status: "found", credential: other });
    assert.equal(keyManager.items.size, 1);
});

for (const newerSlot of ["a", "b"] as const) {
    test(`while slot ${newerSlot}, holding the newer account, cannot be read, the older account in the other slot is not restored`, async () => {
        const keyManager = new FakeKeyManager();
        const storage = new MemoryPublicStorage();
        const clock = new ManualClock();
        const fake = new FakeSilo(clock);
        const older: StoredCredential = { ...credential(1), serverId: fake.serverId };
        const newer: StoredCredential = { ...credential(2), serverId: fake.serverId, accountId: "2", username: "sam" };
        const vault = vaultOn(keyManager, storage);
        if (newerSlot === "a") {
            await vault.save(credential(0));
        }
        await vault.save(older);
        // A rotation whose delete failed leaves the older account's record in the other slot.
        keyManager.failRemove = true;
        assert.equal(await vault.save(newer), "saved");
        keyManager.failRemove = false;
        const aliases = [...keyManager.items.keys()];
        assert.equal(aliases.length, 2, "both accounts are stored");
        const newerAlias = aliases.find((alias) => alias.endsWith(`.${newerSlot}`));
        assert.ok(newerAlias !== undefined);

        keyManager.unreadable.add(newerAlias);
        assert.deepEqual(await vaultOn(keyManager, storage).load(), { status: "unavailable" });
        const launched = await connected({ fake, clock, keyManager, storage });
        assert.equal(launched.core.restore, "storage_unavailable");
        assert.equal(launched.core.session.signedIn, false);
        assert.equal(keyManager.items.size, 2, "nothing is discarded while a slot is unreadable");

        keyManager.unreadable.clear();
        assert.deepEqual(await vaultOn(keyManager, storage).load(), { status: "found", credential: newer });
        const recovered = await connected({ fake, clock, keyManager, storage });
        assert.equal(recovered.core.restore, "signed_in");
        assert.equal(recovered.core.session.account?.id, "2");
    });
}
