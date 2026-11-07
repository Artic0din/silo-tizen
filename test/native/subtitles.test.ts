import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeAppearance, decodeCues, DEFAULT_APPEARANCE } from "../../src/contracts/v2/subtitles.ts";
import { playbackContext } from "../../src/player/capabilities.ts";

test("subtitle preferences merge sparse profile values and reject unsafe or invalid styles", () => {
    const body = (value: unknown) => ({ profile_id: "p1", effective_value: JSON.stringify(value) });
    assert.deepEqual(decodeAppearance(body({ fontSize: "xxlarge", position: "top", textOpacity: 20 }), "p1"), { ...DEFAULT_APPEARANCE, fontSize: "xxlarge", position: "top", textOpacity: 20 });
    for (const value of [{ fontFamily: "url(evil)" }, { fontColor: "red" }, { backgroundOpacity: 101 }, { textOpacity: 0 }, { position: "middle" }, { textOutline: "false" }]) assert.throws(() => decodeAppearance(body(value), "p1"));
    assert.throws(() => decodeAppearance(body({ fontSize: "large" }), "p2"));
});

test("text subtitles retain source timing, overlap and safe plain text without executable markup", () => {
    const embedded = [
        "\uFEFFWEBVTT",
        "X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0",
        "",
        "NOTE an arrow --> is not a cue",
        "",
        "21",
        "00:14:16.400 --> 00:14:19.800 line:90% align:middle",
        "<b>Good morning.</b>",
        "<00:14:17.200>from the east",
        "",
    ].join("\n");
    assert.deepEqual(decodeCues(embedded, "vtt", 0), [{ start: 856.4, end: 859.8, text: "Good morning.\nfrom the east" }]);
    const cues = decodeCues("WEBVTT\n\n00:01.000 --> 00:03.000\n<b>Hello</b> &amp; welcome\n\n00:02.000 --> 00:04.000\nSecond line\n\n00:05.000 --> 00:04.000\nInvalid", "vtt", 10);
    assert.deepEqual(cues, [{ start: 11, end: 13, text: "Hello & welcome" }, { start: 12, end: 14, text: "Second line" }]);
    assert.deepEqual(decodeCues("[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,{\\b1}Hello\\Nthere, friend", "ass", 0), [{ start: 1, end: 2, text: "Hello\nthere, friend" }]);
    assert.throws(() => decodeCues("text", "sup", 0));
    const caps = playbackContext("S95C", "0.1").deliveries.original_http;
    assert.equal(caps?.subtitles.sidecar_text, true);
    assert.equal(caps?.subtitles.embedded_bitmap, false);
    assert.equal(caps?.subtitles.ass_styling, false);
});
