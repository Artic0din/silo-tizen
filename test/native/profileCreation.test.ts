import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeProfileCollection } from "../../src/contracts/v2/wire.ts";
import { operations } from "../../src/api/operations.ts";
import type { RequestSpec } from "../../src/api/http.ts";

test("profile summaries preserve the raw avatar for picker fallback", () => {
    const profile = decodeProfileCollection({ items: [{ id: "person", name: "Owner", has_pin: false, is_primary: true, is_child: false, avatar: "Fox", avatar_url: "/avatars/fox.png" }] })[0];
    assert.ok(profile);
    assert.equal(Reflect.get(profile, "avatar"), "Fox");
    assert.equal(profile.avatarUrl, "/avatars/fox.png");
});

test("creating a profile never retries and decodes its required identity", () => {
    const create = Reflect.get(operations, "createProfile") as ((body: { name: string }) => RequestSpec<unknown>) | undefined;
    assert.ok(create, "profile creation operation exists");
    const spec = create({ name: "Guest" });
    assert.equal(spec.method, "POST");
    assert.equal(spec.path, "/profiles");
    assert.equal(spec.retry, "never");
    assert.deepEqual(spec.body, { name: "Guest" });
    assert.deepEqual(spec.decode({ id: "guest", name: "Guest", has_pin: false, is_primary: false, is_child: false }), {
        id: "guest", name: "Guest", hasPin: false, isPrimary: false, isChild: false, avatarUrl: undefined,
    });
    assert.throws(() => spec.decode({ name: "Guest" }));
});
