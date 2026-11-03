// Subtitle menu labels: the server's own label wins, then the language's name, then a numbered fallback.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SubtitleTrack } from "../../src/contracts/v2/playback.ts";
import { subtitleLabel } from "../../src/player/controller.ts";

function track(overrides: Partial<SubtitleTrack>): SubtitleTrack {
    return { trackId: "t", combinedIndex: 0, source: "embedded", delivery: "sidecar", label: undefined, language: undefined, forced: false, hearingImpaired: false, ...overrides };
}

test("a server label is shown as sent", () => {
    assert.equal(subtitleLabel(track({ label: "English (Signs)", language: "eng" })), "English (Signs)");
});

test("without a label the language is named, not shown as a code", () => {
    assert.equal(subtitleLabel(track({ language: "en" })), "English");
    assert.equal(subtitleLabel(track({ language: "eng" })), "English");
    assert.equal(subtitleLabel(track({ language: "fre" })), "French");
    assert.equal(subtitleLabel(track({ language: "pt-BR" })), "Brazilian Portuguese");
});

test("forced and SDH flags follow the name", () => {
    assert.equal(subtitleLabel(track({ language: "en", forced: true })), "English · Forced");
    assert.equal(subtitleLabel(track({ language: "en", hearingImpaired: true })), "English · SDH");
    assert.equal(subtitleLabel(track({ label: "German", forced: true, hearingImpaired: true })), "German · Forced · SDH");
});

test("an unknown code is shown upper-cased", () => {
    assert.equal(subtitleLabel(track({ language: "xx" })), "XX");
});

test("no usable language falls back to the numbered track", () => {
    for (const language of [undefined, "", "und"]) {
        assert.equal(subtitleLabel(track({ language, combinedIndex: 2 })), "Subtitles 3");
    }
});
