import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the packaged app requires Tizen 8.0", () => {
    const config = readFileSync(new URL("../../dist/wgt/config.xml", import.meta.url), "utf8");
    assert.match(config, /<tizen:application\b[^>]*\brequired_version="8\.0"/);
});

test("the package allows generated artwork and its own player without relaxing scripts", () => {
    const config = readFileSync(new URL("../../dist/wgt/config.xml", import.meta.url), "utf8");
    const policy = config.match(/<tizen:content-security-policy>([^<]+)<\/tizen:content-security-policy>/)?.[1];
    assert.ok(policy, "the package declares its content policy");
    const directives = Object.fromEntries(policy.split(";").filter(part => part.trim()).map(part => {
        const [name, ...sources] = part.trim().split(/\s+/);
        return [name, sources];
    }));
    assert.deepEqual(directives, {
        "default-src": ["*"],
        "script-src": ["'self'"],
        "style-src": ["'self'"],
        "img-src": ["*", "data:"],
        "object-src": ["'self'"],
    });
});
