import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountDirectory } from "../../src/session/accounts.ts";
import { AccountVault } from "../../src/session/accounts.ts";
import { CredentialVault } from "../../src/session/credentialVault.ts";
import { keyManagerStore, memoryStore } from "../../src/session/secretStore.ts";
import { connected, signIn } from "./support/harness.ts";
import { connect } from "../../src/session/core.ts";
import { MemoryPublicStorage } from "./support/keyManager.ts";

test("session-only account storage survives connections within one app run", async () => {
    const h = await connected({ keyManager: null });
    const deps = { fetch: h.fake.fetch, publicStorage: h.storage, keyManager: undefined,
        randomBytes: (bytes: Uint8Array) => { bytes.fill(13); }, deviceName: "Test TV", devicePlatform: "tizen", clock: h.clock,
        transientAccounts: { secrets: memoryStore(), storage: new MemoryPublicStorage() } };
    const first = await connect(h.fake.origin, deps);
    if (first.status !== "connected") throw Error("fixture missing");
    await signIn({ ...h, core: first });
    assert.equal(first.session.persistence, "session_only");
    const second = await connect(h.fake.origin, deps);
    assert.equal(second.status, "connected");
    if (second.status === "connected") assert.equal(second.restore, "signed_in");
    assert.equal(h.storage.getItem("silo.native.accounts.v1"), null, "run-only metadata never reaches persistent storage");
    const restarted = await connect(h.fake.origin, { ...deps, transientAccounts: { secrets: memoryStore(), storage: new MemoryPublicStorage() } });
    if (restarted.status === "connected") assert.equal(restarted.restore, "signed_out");
});

for (const failure of ["protected-write", "index-write"] as const) {
    test(`migration retries after interrupted ${failure} without losing the legacy credential or using the network`, async () => {
        const h = await connected(); await signIn(h);
        const manager = h.keyManager!;
        const store = keyManagerStore(manager);
        const address = h.fake.origin;
        const id = h.core.accounts.localAccountId!;
        const saved = await new CredentialVault(store, h.storage, address, id).load();
        assert.equal(saved.status, "found");
        if (saved.status !== "found") throw Error("fixture missing");
        const legacy = new CredentialVault(store, h.storage, address);
        assert.equal(await legacy.save(saved.credential), "saved");
        h.storage.removeItem("silo.native.accounts.v1");
        const before = h.fake.requests.length;
        if (failure === "protected-write") manager.failSave = true;
        else h.storage.failSet = true;
        const interrupted = new AccountVault(store, h.storage, address, bytes => { bytes.fill(3); });
        assert.equal((await interrupted.load()).status, "unavailable");
        manager.failSave = false; h.storage.failSet = false;
        assert.equal((await legacy.load()).status, "found", "the original remains loadable");
        const restarted = new AccountVault(store, h.storage, address, bytes => { bytes.fill(4); });
        assert.equal((await restarted.load()).status, "found");
        assert.equal(restarted.directory.list().length, 1);
        assert.equal(h.fake.requests.length, before, "migration made no request");
    });
}

test("two accounts on one server retain separate protected credentials and the selected account", async () => {
    const h = await connected(); await signIn(h);
    const store = keyManagerStore(h.keyManager!);
    const firstId = h.core.accounts.localAccountId!;
    const first = await new CredentialVault(store, h.storage, h.fake.origin, firstId).load();
    if (first.status !== "found") throw Error("fixture missing");
    const adding = new AccountVault(store, h.storage, h.fake.origin, bytes => { bytes.fill(7); }, undefined, true);
    assert.equal(await adding.prepareSignIn(), "cleared");
    assert.equal(await adding.save({ ...first.credential, accountId: "second", username: "Second" }), "saved");
    assert.notEqual(adding.localAccountId, firstId);
    assert.equal((await new CredentialVault(store, h.storage, h.fake.origin, firstId).load()).status, "found");
    const reopened = new AccountVault(store, h.storage, h.fake.origin, bytes => { bytes.fill(8); }, firstId);
    assert.equal((await reopened.load()).status, "found");
    assert.equal(reopened.directory.selected, firstId);
    assert.equal(await reopened.clear(), "cleared");
    assert.equal(reopened.directory.list().find(row => row.id === firstId)?.needsSignIn, true);
    assert.equal((await new CredentialVault(store, h.storage, h.fake.origin, adding.localAccountId).load()).status, "found");
});

test("a retained legacy copy cannot overwrite the migrated account's newer credential", async () => {
    const h = await connected(); await signIn(h);
    const store = keyManagerStore(h.keyManager!);
    const id = h.core.accounts.localAccountId!;
    const account = new CredentialVault(store, h.storage, h.fake.origin, id);
    const first = await account.load();
    if (first.status !== "found") throw Error("fixture missing");
    await new CredentialVault(store, h.storage, h.fake.origin).save(first.credential);
    await account.save({ ...first.credential, accessExpiresAt: first.credential.accessExpiresAt + 10000 });
    const directory = new AccountDirectory(h.storage, bytes => { bytes.fill(9); });
    const other = directory.add("https://other.invalid", "other", "other", "Other");
    directory.select(other.id);
    const reopened = await new AccountVault(store, h.storage, h.fake.origin, bytes => { bytes.fill(10); }).load();
    assert.equal(reopened.status, "found");
    if (reopened.status === "found") assert.equal(reopened.credential.accessExpiresAt, first.credential.accessExpiresAt + 10000);
});

test("a late credential rotation cannot select the account that was left", async () => {
    const h = await connected(); await signIn(h);
    const store = keyManagerStore(h.keyManager!);
    const saved = await new CredentialVault(store, h.storage, h.fake.origin, h.core.accounts.localAccountId).load();
    if (saved.status !== "found") throw Error("fixture missing");
    const directory = new AccountDirectory(h.storage, bytes => { bytes.fill(11); });
    const other = directory.add("https://other.invalid", "other", "other", "Other");
    directory.select(other.id);
    assert.equal(await h.core.accounts.save(saved.credential), "saved");
    assert.equal(new AccountDirectory(h.storage, bytes => { bytes.fill(12); }).selected, other.id);
});

test("accounts retain distinct device IDs on one server and survive restart", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    const directory = new AccountDirectory(storage, bytes => { bytes.fill(values.size + 1); });
    const first = directory.add("https://one.invalid", "server", "alice", "Alice");
    const second = directory.add("https://one.invalid", "server", "bob", "Bob");
    assert.notEqual(first.id, second.id);
    assert.equal(new AccountDirectory(storage, bytes => { bytes.fill(3); }).list().length, 2);
    assert.equal(directory.add(first.baseUrl, first.serverId, "alice", "Alice").id, first.id);
});

test("interrupted directory write keeps the previous account index", () => {
    const values = new Map<string, string>();
    let fail = false;
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { if (fail) throw Error("interrupted"); values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    const directory = new AccountDirectory(storage, bytes => { bytes.fill(values.size + 1); });
    directory.add("https://one.invalid", "server", "alice", "Alice");
    fail = true;
    assert.throws(() => directory.add("https://one.invalid", "server", "bob", "Bob"), /interrupted/);
    assert.equal(directory.list().length, 1);
});
