import assert from "node:assert/strict";
import { test } from "node:test";
import { DiagnosticLog, redactDiagnostics } from "../../src/diagnostics/log.ts";
import { decodeDiagnosticsCapabilities } from "../../src/contracts/v2/diagnostics.ts";

test("diagnostics redacts planted credentials and addresses before buffering", () => {
    const secrets = ["planted-access-value", "planted-password-value", "private.invalid", "private-user"];
    const log = new DiagnosticLog();
    log.sensitiveValues = secrets;
    log.append(`token=${secrets[0]} password="${secrets[1]}" https://${secrets[2]}/api user=${secrets[3]}`);
    const body = JSON.stringify(log.snapshot());
    for (const secret of secrets) assert.ok(!body.includes(secret), secret);
    assert.ok(!redactDiagnostics('Authorization: Bearer planted-bearer-value').includes("planted-bearer-value"));
    assert.ok(!redactDiagnostics('{"password":"a password with spaces"}').includes("a password"));
    for (const value of ["token=planted-token", 'password="planted-password"', "https://planted.invalid/private", "Cookie: planted-cookie"]) {
        assert.ok(!redactDiagnostics(value).includes("planted"), value);
    }
});

test("diagnostics buffer is bounded and clears all retained evidence", () => {
    const log = new DiagnosticLog();
    for (let i = 0; i < 4010; i++) log.append(String(i).repeat(1000));
    assert.equal(log.snapshot().length, 4000);
    assert.ok(log.snapshot().every(line => line.length <= 2048));
    assert.equal(log.dropped, 10);
    log.clear();
    assert.deepEqual(log.snapshot(), []);
    assert.equal(log.dropped, 0);
});

test("capability availability requires allowed and available; it does not claim platform support", () => {
    assert.equal(decodeDiagnosticsCapabilities({ allowed: true, state: "available" }).status, "Available");
    assert.equal(decodeDiagnosticsCapabilities({ allowed: false, state: "available" }).status, "Disabled by server");
    assert.equal(decodeDiagnosticsCapabilities({ allowed: true, state: "not_configured" }).status, "Storage unavailable");
    assert.throws(() => decodeDiagnosticsCapabilities({ allowed: "true", state: "available" }));
});
