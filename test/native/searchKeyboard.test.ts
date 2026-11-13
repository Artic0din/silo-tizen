import assert from "node:assert/strict";
import { test } from "node:test";

test("delete removes one whole character, Indic conjuncts included, without relying on Intl.Segmenter", async () => {
    // Chromium 108's Intl.Segmenter (ICU 72) splits Indic conjuncts, so the result must not depend on it.
    const segmenter = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
    Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true });
    try {
        const { withoutLastCharacter } = await import("../../src/ui/searchKeyboard.ts");
        for (const [query, remaining] of [["łक्ष", "ł"], ["क्षि", ""], ["ł𠮷", "ł"], ["é", ""], ["가나", "가"], ["", ""]] as const) {
            assert.equal(withoutLastCharacter(query), remaining, query);
        }
    } finally {
        if (segmenter !== undefined) Object.defineProperty(Intl, "Segmenter", segmenter);
    }
});
