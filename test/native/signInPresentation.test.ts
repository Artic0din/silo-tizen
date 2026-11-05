// The Apple TV sign-in copy (TVSignInPresentation) as the Tizen screens word it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { advancedAddress, portFieldFault } from "../../src/api/serverUrl.ts";
import { actionTakesFocus, codeLead, type CodeStatus, isTerminal, serverHost, stateAction, statusLine, typedUrl } from "../../src/ui/signInText.ts";

test("the typed address drops only https:// and trailing slashes, as on the Apple TV app", () => {
    assert.equal(typedUrl("https://silo.example.test/activate/", ""), "silo.example.test/activate");
    assert.equal(typedUrl("HTTPS://silo.example.test:8443/activate", ""), "silo.example.test:8443/activate");
    assert.equal(typedUrl("http://192.168.1.20:8090/activate", ""), "http://192.168.1.20:8090/activate", "plain HTTP keeps its scheme");
    assert.equal(typedUrl("  ", "https://silo.example.test/activate?code=1"), "silo.example.test/activate", "a blank address falls back to the QR link without its query");
});

test("the server host keeps its port so two servers on one machine stay apart", () => {
    assert.equal(serverHost("https://silo.example.test"), "silo.example.test");
    assert.equal(serverHost("http://192.168.1.20:8090/silo"), "192.168.1.20:8090");
});

test("the code lead names this TV and the typed address, and a declined sign-in withdraws it", () => {
    const waiting = { kind: "waiting", renewed: false } as const;
    assert.equal(
        codeLead(waiting, "silo.example.test/activate"),
        "Scan the code with your phone's camera, or go to silo.example.test/activate and enter it. Approve on your phone and this TV signs in by itself.",
    );
    // Previously codeLead took only the typed address, so a declined sign-in kept the scan lead.
    assert.equal(codeLead(waiting, undefined).includes("your server's /activate page"), true);
    assert.equal(codeLead({ kind: "denied" }, "silo.example.test/activate"), "Show a new code to try again.");
});

test("each code status reads as TVSignInPresentation.statusLine, with no countdown", () => {
    const host = "silo.example.test";
    const lines: [CodeStatus, string, string | undefined, boolean][] = [
        [{ kind: "getting_code" }, "Getting a sign-in code…", undefined, false],
        [{ kind: "waiting", renewed: false }, "Waiting for approval", undefined, false],
        [{ kind: "waiting", renewed: true }, "New code. Waiting for approval.", undefined, false],
        [{ kind: "opened" }, "Continue on your phone", undefined, false],
        [{ kind: "approved", account: "laura" }, "Signed in as laura", undefined, false],
        [{ kind: "approved", account: undefined }, "Signed in", undefined, false],
        [{ kind: "could_not_finish" }, "Couldn't finish signing in on this TV.", "Try again", true],
        // Previously: "Sign-in was declined on your phone."
        [{ kind: "denied" }, "Sign-in was declined.", "Show a new code", true],
        [{ kind: "paused" }, "Sign-in paused.", "Show a new code", true],
        [{ kind: "unreachable" }, "Can't reach silo.example.test. Check this TV's connection.", "Try again", false],
        [{ kind: "rate_limited" }, "Too many sign-in attempts. Trying again shortly.", "Try again", false],
        [{ kind: "failed", message: "The server had a problem." }, "The server had a problem.", "Try again", true],
    ];
    for (const [status, line, action, takesFocus] of lines) {
        assert.equal(statusLine(status, host), line);
        assert.equal(stateAction(status), action, line);
        assert.equal(actionTakesFocus(status), takesFocus, line);
    }
    assert.equal(isTerminal({ kind: "unreachable" }), false);
    assert.equal(isTerminal({ kind: "paused" }), true);
});

test("a bad port outlines the Port field, and a port typed into the address outlines the address", () => {
    assert.equal(portFieldFault("silo.example.test", "70000"), "port");
    assert.equal(portFieldFault("silo.example.test", "80a"), "port");
    assert.equal(portFieldFault("silo.example.test", ""), undefined);
    assert.equal(portFieldFault("silo.example.test", "8096"), undefined);
    assert.equal(portFieldFault("silo.example.test:70000", ""), "address");
    assert.equal(portFieldFault("silo.example.test:70000", "70000"), "address", "a port typed into the address wins");
    assert.equal(portFieldFault("https://silo.example.test:8443", "70000"), undefined, "a usable typed port is not the Port field's fault");
});

test("advanced options choose the scheme and port the way the Apple TV app builds its address", () => {
    assert.deepEqual(advancedAddress("silo.example.test", "auto", ""), { ok: true, address: "silo.example.test" });
    assert.deepEqual(advancedAddress("silo.example.test", "auto", " 8096 "), { ok: true, address: "silo.example.test:8096" });
    assert.deepEqual(advancedAddress("silo.example.test", "http", "8096"), { ok: true, address: "http://silo.example.test:8096" });
    assert.deepEqual(advancedAddress("http://silo.example.test/media", "https", ""), { ok: true, address: "https://silo.example.test/media" }, "a chosen protocol replaces a typed one");
    assert.deepEqual(advancedAddress("silo.example.test:8443", "https", "9000"), { ok: true, address: "https://silo.example.test:8443" }, "a typed port wins");
    for (const port of ["0", "65536", "80a", "-1"]) {
        assert.deepEqual(advancedAddress("silo.example.test", "auto", port), { ok: false, problem: "invalid_port" }, port);
    }
});
