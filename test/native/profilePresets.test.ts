import assert from "node:assert/strict";
import { test } from "node:test";
import { PROFILE_STYLES, profilePresets } from "../../src/ui/profilePresets.ts";

test("TV avatar batches match the pinned Swift seed order and style IDs", () => {
    assert.deepEqual(PROFILE_STYLES.map(([id]) => id), ["identicon", "initials", "bottts-neutral", "fun-emoji", "pixel-art-neutral"]);
    const batch = profilePresets("fun-emoji", 0);
    assert.equal(batch.length, 18);
    assert.equal(new Set(batch).size, 18);
    assert.equal(batch[0], "preset:dicebear:fun-emoji:pepper-pebble");
    assert.equal(batch[17], "preset:dicebear:fun-emoji:fizzy-puffin");
    assert.equal(profilePresets("fun-emoji", 1)[0], "preset:dicebear:fun-emoji:sprout-sunset");
});
