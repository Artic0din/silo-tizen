import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountDirectory } from "../../src/session/accounts.ts";
import { AccountVault } from "../../src/session/accounts.ts";
import { CredentialVault } from "../../src/session/credentialVault.ts";
import { keyManagerStore, memoryStore } from "../../src/session/secretStore.ts";
import { connected, signIn } from "./support/harness.ts";
import { connect, forgetStoredCredential, signOutSavedAccount } from "../../src/session/core.ts";
import { MemoryPublicStorage } from "./support/keyManager.ts";

test("unreadable retained legacy storage keeps the account's sign-out guard", async () => {
    const h = await connected(); await signIn(h);
    const store = keyManagerStore(h.keyManager!);
    const saved = await new CredentialVault(store, h.storage, h.fake.origin, h.core.accounts.localAccountId).load();
    if (saved.status !== "found") throw Error("fixture missing");
    await new CredentialVault(store, h.storage, h.fake.origin).save(saved.credential);
    h.keyManager!.failGet = true; h.keyManager!.failRemove = true;
    assert.equal(await h.core.accounts.signOut(), "failed");
    assert.equal(h.core.accounts.directory.list()[0]?.needsSignIn, true);
    h.keyManager!.failGet = false; h.keyManager!.failRemove = false;
    const restarted = await connected({ clock: h.clock, fake: h.fake, keyManager: h.keyManager, storage: h.storage });
    assert.equal(restarted.core.restore, "signed_out");
    assert.equal(await restarted.core.accounts.signOut(), "cleared");
    assert.equal(restarted.core.accounts.directory.list().length, 0);
});

for (const legacy of [false, true]) for (const interrupted of [false, true]) test(`failed replacement cannot restore the old login (legacy=${legacy}, deleteFailure=${interrupted})`, async () => {
    const h = await connected(); await signIn(h);
    const store = keyManagerStore(h.keyManager!);
    const id = h.core.accounts.localAccountId!;
    const saved = await new CredentialVault(store, h.storage, h.fake.origin, id).load();
    if (saved.status !== "found") throw Error("fixture missing");
    if (legacy) {
        await new CredentialVault(store, h.storage, h.fake.origin).save(saved.credential);
        h.storage.removeItem("silo.native.accounts.v1");
    }
    const deps = { fetch: h.fake.fetch, publicStorage: h.storage, keyManager: h.keyManager,
        randomBytes: (bytes: Uint8Array) => { bytes.fill(7); }, deviceName: "Test TV", devicePlatform: "tizen", clock: h.clock };
    const next = await connect(h.fake.origin, { ...deps, addAccount: true });
    if (next.status !== "connected") throw Error("fixture missing");
    h.keyManager!.failSave = true;
    h.keyManager!.failRemove = interrupted;
    await signIn({ ...h, core: next });
    assert.equal(next.session.persistence, "session_only");
    h.keyManager!.failSave = false; h.keyManager!.failRemove = false;
    const restarted = await connect(h.fake.origin, deps);
    if (restarted.status !== "connected") throw Error("fixture missing");
    assert.equal(restarted.restore, "signed_out");
});

test("an interrupted replacement write leaves the previous login guarded and unrelated accounts intact", async () => {
    const h = await connected(); await signIn(h);
    const store = keyManagerStore(h.keyManager!);
    const first = await new CredentialVault(store, h.storage, h.fake.origin, h.core.accounts.localAccountId).load();
    if (first.status !== "found") throw Error("fixture missing");
    const other = new AccountVault(store, h.storage, h.fake.origin, bytes => { bytes.fill(8); }, undefined, true);
    await other.save({ ...first.credential, accountId: "other", username: "Other" });
    const replacement = new AccountVault(store, h.storage, h.fake.origin, bytes => { bytes.fill(9); }, undefined, true);
    await replacement.prepareSignIn(first.credential);
    const held = h.keyManager!.holdSaves();
    const pending = replacement.save(first.credential);
    while (held.waiting() === 0) await new Promise<void>(resolve => setImmediate(resolve));
    try {
        assert.equal((await new AccountVault(store, h.storage, h.fake.origin, bytes => { bytes.fill(10); }, h.core.accounts.localAccountId).load()).status, "none");
        assert.equal((await new CredentialVault(store, h.storage, h.fake.origin, other.localAccountId).load()).status, "found");
    } finally { held.release(); await pending; }
});

for (const legacy of [false, true]) test(`forget selected sign-in preserves another account (legacy=${legacy})`, async () => {
    const h = await connected(); await signIn(h);
    const store = keyManagerStore(h.keyManager!);
    const id = h.core.accounts.localAccountId!;
    const first = await new CredentialVault(store, h.storage, h.fake.origin, id).load();
    if (first.status !== "found") throw Error("fixture missing");
    const second = new AccountDirectory(h.storage, bytes => { bytes.fill(8); }).add(h.fake.origin, first.credential.serverId, "second", "Second");
    const other = new CredentialVault(store, h.storage, h.fake.origin, second.id);
    await other.save({ ...first.credential, accountId: "second", username: "Second" });
    if (legacy) await new CredentialVault(store, h.storage, h.fake.origin).save({ ...first.credential, accountId: "second", username: "Second" });
    assert.equal((await other.load()).status, "found");
    await forgetStoredCredential(h.fake.origin, { publicStorage: h.storage, keyManager: h.keyManager, localAccountId: id });
    assert.equal((await new CredentialVault(store, h.storage, h.fake.origin, id).load()).status, "none");
    assert.equal((await other.load()).status, "found");
    if (legacy) assert.equal((await new CredentialVault(store, h.storage, h.fake.origin).load()).status, "found");
});

test("retiring an inactive account preserves the current account selection", async () => {
    const h = await connected(); await signIn(h);
    const account = h.core.accounts.directory.list()[0]!;
    const directory = new AccountDirectory(h.storage, bytes => { bytes.fill(9); });
    const current = directory.add(h.fake.origin, account.serverId, "other", "Other");
    directory.select(current.id);
    await h.core.session.retire();
    assert.equal(directory.selected, current.id);
    await h.core.accounts.signOut();
    assert.equal(directory.selected, current.id);
    assert.equal(directory.list()[0]?.needsSignIn, false);
});

test("retirement drains a refresh write already queued in the account vault", async () => {
    const h = await connected(); await signIn(h);
    const saving = h.keyManager!.holdSaves();
    const refreshing = h.core.session.refresh();
    await h.clock.advance(0);
    assert.equal(saving.waiting(), 1);
    let retired = false;
    const retiring = h.core.session.retire().then(() => { retired = true; });
    try {
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(retired, false, "retirement waits for the queued write");
    } finally { saving.release(); }
    await retiring;
    assert.deepEqual(await refreshing, { status: "aborted" });
    assert.equal(retired, true);
});

test("removing an inactive cached account fences its late refresh writes", async () => {
    const h = await connected(); await signIn(h);
    const account = h.core.accounts.directory.list()[0]!;
    const held = h.fake.hold("/auth/refresh", true);
    const refreshing = h.core.session.refresh();
    await h.clock.advance(0);
    const deps = {
        fetch: h.fake.fetch, publicStorage: h.storage, keyManager: h.keyManager,
        randomBytes: (bytes: Uint8Array) => { bytes.fill(7); }, deviceName: "Test TV", devicePlatform: "tizen", clock: h.clock,
        beforeAccountSignOut: async () => { await h.core.session.retire(); },
    };
    assert.equal(await signOutSavedAccount(account, deps), "cleared");
    h.core.accounts.directory.remove(account.id);
    const saved = [...h.keyManager!.items];
    held.release(); await refreshing;
    assert.deepEqual([...h.keyManager!.items], saved, "no credentials written after removal");
    assert.deepEqual(h.core.accounts.directory.list(), []);
    assert.equal(h.core.session.signedIn, false);
});

for (const refused of [false, true]) test(`replacing a saved account fences its old ${refused ? "refused" : "successful"} refresh`, async () => {
    const h = await connected();
    await signIn(h);
    if (refused) h.fake.revokeAllSessions();
    const held = h.fake.hold("/auth/refresh", true);
    const refreshing = h.core.session.refresh();
    await h.clock.advance(0);
    const next = await connect(h.fake.origin, {
        fetch: h.fake.fetch, publicStorage: h.storage, keyManager: h.keyManager,
        randomBytes: bytes => { bytes.fill(7); }, deviceName: "Test TV", devicePlatform: "tizen", clock: h.clock,
        addAccount: true,
        beforeAccountSignIn: async () => { await h.core.session.retire(); },
    });
    assert.equal(next.status, "connected");
    if (next.status !== "connected") throw Error("fixture missing");
    await signIn({ ...h, core: next });
    const saved = [...h.keyManager!.items];
    held.release();
    await refreshing;
    assert.deepEqual([...h.keyManager!.items], saved, "the old session cannot overwrite or clear the new login");
    assert.equal(h.core.session.signedIn, false);
    assert.equal(next.session.signedIn, true);
    assert.equal(next.accounts.directory.list()[0]?.needsSignIn, false);
});

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
