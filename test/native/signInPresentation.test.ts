// The Apple TV sign-in copy (TVSignInPresentation) as the Tizen screens word it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { advancedAddress } from "../../src/api/serverUrl.ts";
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

test("the code lead names this TV and the typed address", () => {
    assert.equal(
        codeLead("silo.example.test/activate"),
        "Scan the code with your phone's camera, or go to silo.example.test/activate and enter it. Approve on your phone and this TV signs in by itself.",
    );
    assert.equal(codeLead(undefined).includes("your server's /activate page"), true);
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
        [{ kind: "denied" }, "Sign-in was declined on your phone.", "Show a new code", true],
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
