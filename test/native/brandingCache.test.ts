import assert from "node:assert/strict";
import { test } from "node:test";
import { cachedBranding, storeBranding } from "../../src/ui/brandingCache.ts";
import { MemoryPublicStorage } from "./support/keyManager.ts";

const BASE = "https://silo.example.test";
const KEY = "silo.native.serverBranding.v1";

test("branding is kept per server and read back validated, as ServerBrandingCache", () => {
    const storage = new MemoryPublicStorage();
    storeBranding(storage, BASE, { serverName: "Family Cinema", markUrl: "https://silo.example.test/art/mark", accentColor: "#ff0000" });
    storeBranding(storage, "http://192.168.1.20:8090", { serverName: "Basement", markUrl: undefined, accentColor: undefined });
    assert.deepEqual(cachedBranding(storage, BASE), { serverName: "Family Cinema", markUrl: "https://silo.example.test/art/mark", accentColor: "#ff0000" });
    assert.deepEqual(cachedBranding(storage, "http://192.168.1.20:8090"), { serverName: "Basement", markUrl: undefined, accentColor: undefined });
    assert.equal(cachedBranding(storage, "https://other.example.test"), undefined);
    storeBranding(storage, BASE, { serverName: undefined, markUrl: undefined, accentColor: undefined });
    assert.deepEqual(cachedBranding(storage, BASE), { serverName: undefined, markUrl: undefined, accentColor: undefined }, "a newer, emptier answer replaces the old one");
    assert.equal(cachedBranding(storage, "http://192.168.1.20:8090")?.serverName, "Basement", "other servers are kept");
});

test("a tampered or damaged cache is ignored rather than trusted", () => {
    const storage = new MemoryPublicStorage();
    storage.setItem(KEY, JSON.stringify({ [BASE]: { serverName: "  Family  ", markUrl: "https://evil.example/mark.png", accentColor: 7 } }));
    assert.deepEqual(cachedBranding(storage, BASE), { serverName: "Family", markUrl: undefined, accentColor: undefined }, "a mark from another origin is dropped again");
    for (const raw of ["not json", "[]", JSON.stringify({ [BASE]: "x" }), JSON.stringify({ [BASE]: null })]) {
        storage.setItem(KEY, raw);
        assert.equal(cachedBranding(storage, BASE), undefined, raw);
    }
    storage.setItem(KEY, "not json");
    storeBranding(storage, BASE, { serverName: "Fresh", markUrl: undefined, accentColor: undefined });
    assert.equal(cachedBranding(storage, BASE)?.serverName, "Fresh", "a damaged cache is replaced");
});

test("storage that refuses reads or writes leaves branding uncached without failing", () => {
    const broken = { getItem: (): string | null => { throw new Error("denied"); }, setItem: (): void => { throw new Error("full"); }, removeItem: (): void => undefined };
    assert.equal(cachedBranding(broken, BASE), undefined);
    assert.doesNotThrow(() => storeBranding(broken, BASE, { serverName: "x", markUrl: undefined, accentColor: undefined }));
    assert.equal(cachedBranding(undefined, BASE), undefined);
});
