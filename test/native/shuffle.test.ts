import assert from "node:assert/strict";
import { test } from "node:test";
import { operations } from "../../src/api/operations.ts";

test("Shuffle operations retain the pinned retry and scope contracts", () => {
    assert.equal(operations.shuffleCapabilities().path, "/shuffles/capabilities");
    const create = operations.createShuffle("12");
    assert.equal(create.retry, "never");
    assert.deepEqual(create.body, { scope: { kind: "library", id: "12" } });
    const advance = operations.advanceShuffle("sh/1", "movie:done");
    assert.equal(advance.retry, "safe");
    assert.equal(advance.path, "/shuffles/sh%2F1/advance");
    assert.deepEqual(advance.body, { from_content_id: "movie:done" });
});

test("Shuffle decoding admits only the consumed typed fields", () => {
    const capability = operations.shuffleCapabilities().decode;
    assert.deepEqual(capability({ allowed: true, state: "available", scope_kinds: ["library"] }), { usable: true, scopeKinds: ["library"] });
    assert.throws(() => capability({ allowed: false, scope_kinds: ["library"] }));
    assert.throws(() => capability({ allowed: true, state: "available", scope_kinds: [null] }));
    const decode = operations.createShuffle("12").decode;
    assert.deepEqual(decode({ id: "sh1", current: { content_id: "movie:1" }, next: { content_id: "movie:2" } }), { id: "sh1", current: { id: "movie:1" }, next: { id: "movie:2" } });
    assert.throws(() => decode({ id: "", current: { id: "movie:1" }, next: { id: "movie:2" } }));
    assert.throws(() => decode({ id: "sh1", current: [], next: { id: "movie:2" } }));
});
