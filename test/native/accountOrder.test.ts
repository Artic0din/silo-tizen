// Change Account lists the active server first, then the rest by last use, and each server's
// accounts most recent first. silo-apple 6587e57: ServerRegistry.sortedEntries (ServerRegistry.swift:260-266),
// AccountStore.mostRecentFirst (AccountStore.swift:779-782), ChangeAccountList.profileCount (ChangeAccountModel.swift:77-80).

import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountDirectory, accountsByRecentUse, profileCountLabel, serversByRecentUse, type SavedAccount } from "../../src/session/accounts.ts";
import { MemoryPublicStorage } from "./support/keyManager.ts";

const KEY = "silo.native.accounts.v1";
const row = (id: string, baseUrl: string, lastUsedAt?: number): SavedAccount => ({
    id, baseUrl, serverId: baseUrl, accountId: id, username: id, profileCount: 1, needsSignIn: false,
    ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
});
const random = (bytes: Uint8Array): void => { bytes.fill(1); };
const counter = (): (() => number) => { let tick = 1000; return () => ++tick; };

test("accounts are listed most recently used first, and ties keep their saved order", () => {
    const rows = [row("a", "https://one.invalid", 10), row("b", "https://one.invalid", 30), row("c", "https://one.invalid", 30), row("d", "https://one.invalid", 20)];
    assert.deepEqual(accountsByRecentUse(rows).map(account => account.id), ["b", "c", "d", "a"]);
});

test("an account saved before last-use stamps sorts after stamped ones and keeps its place among its peers", () => {
    const rows = [row("old1", "https://one.invalid"), row("new", "https://one.invalid", 5), row("old2", "https://one.invalid")];
    assert.deepEqual(accountsByRecentUse(rows).map(account => account.id), ["new", "old1", "old2"]);
});

test("the active server is first, then servers by their most recent account", () => {
    const rows = [
        row("a1", "https://a.invalid", 10), row("a2", "https://a.invalid", 50),
        row("b1", "https://b.invalid", 40),
        row("c1", "https://c.invalid", 60), row("c2", "https://c.invalid", 5),
    ];
    assert.deepEqual(serversByRecentUse(rows, "https://b.invalid"), ["https://b.invalid", "https://c.invalid", "https://a.invalid"]);
    assert.deepEqual(serversByRecentUse(rows, undefined), ["https://c.invalid", "https://a.invalid", "https://b.invalid"]);
    assert.deepEqual(serversByRecentUse(rows, "https://missing.invalid"), ["https://c.invalid", "https://a.invalid", "https://b.invalid"]);
});

test("servers with no stamped account keep the order they were saved in", () => {
    const rows = [row("x", "https://x.invalid"), row("y", "https://y.invalid"), row("z", "https://z.invalid")];
    assert.deepEqual(serversByRecentUse(rows, undefined), ["https://x.invalid", "https://y.invalid", "https://z.invalid"]);
});

test("adding and choosing an account stamps when it was last used", () => {
    const storage = new MemoryPublicStorage();
    let fill = 0;
    const directory = new AccountDirectory(storage, bytes => { bytes.fill(++fill); }, counter());
    const alice = directory.add("https://one.invalid", "one", "alice", "Alice");
    const bob = directory.add("https://one.invalid", "one", "bob", "Bob");
    assert.deepEqual([alice.lastUsedAt, bob.lastUsedAt], [1001, 1002]);
    assert.deepEqual(accountsByRecentUse(directory.list()).map(account => account.accountId), ["bob", "alice"]);
    new AccountDirectory(storage, random, () => 9000).select(alice.id);
    const reread = new AccountDirectory(storage, random);
    assert.deepEqual(reread.list().map(account => [account.accountId, account.lastUsedAt]), [["alice", 9000], ["bob", 1002]]);
    assert.deepEqual(accountsByRecentUse(reread.list()).map(account => account.accountId), ["alice", "bob"]);
});

test("saved data without last-use stamps still loads, and its order and fields survive a write", () => {
    const storage = new MemoryPublicStorage();
    const legacy = ["a", "b"].map(id => ({ id, baseUrl: "https://one.invalid", serverId: "one", accountId: id, username: id, profileCount: 2, needsSignIn: false }));
    storage.setItem(KEY, JSON.stringify({ accounts: legacy, selected: "a" }));
    const directory = new AccountDirectory(storage, random, () => 77);
    assert.deepEqual(directory.list().map(account => account.id), ["a", "b"]);
    assert.equal(directory.list()[0]?.lastUsedAt, undefined);
    assert.deepEqual(accountsByRecentUse(directory.list()).map(account => account.id), ["a", "b"]);
    directory.update("b", { profileCount: 3 });
    const saved = JSON.parse(storage.getItem(KEY)!) as { accounts: Record<string, unknown>[]; selected: string };
    assert.equal(saved.selected, "a");
    assert.deepEqual(saved.accounts.map(account => [account.id, account.profileCount, "lastUsedAt" in account]), [["a", 2, false], ["b", 3, false]]);
    directory.select("b");
    assert.equal(directory.list()[0]?.lastUsedAt, 77);
});

test("a last-use stamp that is not a number is rejected like any other bad field", () => {
    const storage = new MemoryPublicStorage();
    storage.setItem(KEY, JSON.stringify({ accounts: [{ ...row("a", "https://one.invalid"), lastUsedAt: "yesterday" }] }));
    assert.throws(() => new AccountDirectory(storage, random), /Account list unavailable/);
});

test("a profile count is hidden at zero and pluralised otherwise", () => {
    assert.equal(profileCountLabel(0), undefined);
    assert.equal(profileCountLabel(1), "1 profile");
    assert.equal(profileCountLabel(3), "3 profiles");
});
