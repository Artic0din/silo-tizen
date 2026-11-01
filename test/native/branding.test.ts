import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeServerBranding, resolveBrandingAsset } from "../../src/contracts/v2/branding.ts";

test("branding retains usable name, mark and accent text and ignores unrelated fields", () => {
    assert.deepEqual(decodeServerBranding({ server_name: "  Family Cinema  ", mark_url: " /branding/mark.png ", accent_color: " #3366ff ", storage_available: true }), {
        serverName: "Family Cinema",
        markUrl: "/branding/mark.png",
        accentColor: "#3366ff",
    });
});

test("absent, null and blank fields fall back", () => {
    for (const row of [{}, { server_name: null, mark_url: null, accent_color: null }, { server_name: "  ", mark_url: " ", accent_color: "" }]) {
        assert.deepEqual(decodeServerBranding(row), { serverName: undefined, markUrl: undefined, accentColor: undefined });
    }
});

test("malformed optional text invalidates branding as on Apple TV", () => {
    for (const key of ["server_name", "login_subtitle", "accent_color", "wordmark_url", "mark_url"]) {
        assert.throws(() => decodeServerBranding({ [key]: 7 }), new RegExp(`branding\\.${key}`));
    }
});

test("asset paths resolve under the server's base, same origin only, as ServerBranding.resolve", () => {
    const base = "https://silo.example.test/media";
    assert.equal(resolveBrandingAsset("/branding/mark.png", base), "https://silo.example.test/media/branding/mark.png", "site-relative paths keep the base path");
    assert.equal(resolveBrandingAsset("branding/mark.png", base), "https://silo.example.test/media/branding/mark.png");
    assert.equal(resolveBrandingAsset("https://silo.example.test:443/x.png", base), "https://silo.example.test/x.png", "the default port is the same origin");
    assert.equal(resolveBrandingAsset("HTTPS://SILO.example.test/x.png", "https://silo.example.test"), "https://silo.example.test/x.png");
    assert.equal(resolveBrandingAsset("/mark.png", "http://192.168.1.20:8090"), "http://192.168.1.20:8090/mark.png");
    // Apple drops one leading slash, so a scheme-relative value stays a path on this server.
    assert.equal(resolveBrandingAsset("//evil.example/x.png", "https://silo.example.test"), "https://silo.example.test/evil.example/x.png");
    for (const value of [
        "https://evil.example/x.png",
        "http://silo.example.test/x.png",
        "https://silo.example.test:8443/x.png",
        "javascript:alert(1)",
        "data:image/png;base64,AAAA",
        "\\\\evil.example\\x.png",
        "/\\evil.example/x.png",
        "https://user:pass@silo.example.test/x.png",
        "/mark .png",
        "/mark\n.png",
        "  ",
    ]) {
        assert.equal(resolveBrandingAsset(value, base), undefined, JSON.stringify(value));
    }
    assert.equal(resolveBrandingAsset(undefined, base), undefined);
});
