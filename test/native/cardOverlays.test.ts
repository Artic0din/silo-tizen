import assert from "node:assert/strict";
import { test } from "node:test";
import { languageName, parseOverlayPrefs } from "../../src/ui/cardOverlays.ts";

const enabled = (raw: unknown): string[] => [...parseOverlayPrefs(raw).items].filter(([, config]) => config.enabled).map(([id]) => id);

test("an absent or unreadable badge document is the registry defaults", () => {
    for (const raw of [undefined, null, "", "{not json", "[1]", 7]) {
        const prefs = parseOverlayPrefs(raw);
        assert.equal(prefs.preset, "classic");
        assert.deepEqual(prefs.order, []);
        assert.deepEqual(enabled(raw), ["resolution", "hdr", "audio", "release_type"], String(raw));
    }
});

test("a version 2 document patches known ids only and keeps valid accents", () => {
    const doc = { version: 2, preset: "pill", order: ["rating_imdb", "nope", "resolution"], items: {
        resolution: { enabled: false, position: "top-left" },
        rating_imdb: { enabled: true, position: "bottom-left", accentColor: "#ABCDEF", showIcon: true },
        rating_tmdb: { enabled: true, position: "middle", accentColor: "red" },
        request_status: { enabled: true, position: "top-left" },
    } };
    const prefs = parseOverlayPrefs(doc);
    assert.equal(prefs.preset, "pill");
    assert.deepEqual(prefs.order, ["rating_imdb", "resolution"]);
    assert.deepEqual(prefs.items.get("rating_imdb"), { enabled: true, position: "bottom-left", accentColor: "#ABCDEF", showIcon: true });
    assert.deepEqual(prefs.items.get("rating_tmdb"), { enabled: true, position: "left-edge", accentColor: undefined, showIcon: undefined }, "an invalid position keeps the default and a non-hex accent is dropped");
    assert.equal(prefs.items.has("request_status"), false);
    assert.deepEqual(parseOverlayPrefs(JSON.stringify(doc)), prefs, "the administrator's baseline arrives as a JSON string");
});

test("a version 1 flat document migrates and ignores preset and order", () => {
    const prefs = parseOverlayPrefs({ preset: "square", order: ["year"], year: { enabled: true, position: "top-right" }, audio: { enabled: false, position: "top-left" } });
    assert.equal(prefs.preset, "classic");
    assert.deepEqual(prefs.order, []);
    assert.deepEqual(enabled({ year: { enabled: true, position: "top-right" }, audio: { enabled: false, position: "top-left" } }), ["resolution", "hdr", "release_type", "year"]);
});

// OverlayRegistry.swift:275-292, :436-466 and OverlayTypes.swift:44-65 at silo-apple 5780c84.
test("ratings default to the left rail, ribbons to the right rail, and a stored top-right badge draws on the right rail", () => {
    const defaults = parseOverlayPrefs(undefined).items;
    for (const id of ["rating_imdb", "rating_tmdb", "rating_rt", "rating_rt_audience"]) assert.equal(defaults.get(id)?.position, "left-edge", id);
    for (const id of ["show_status", "imdb_top_250", "rt_certified_fresh"]) assert.equal(defaults.get(id)?.position, "right-edge", id);
    const stored = parseOverlayPrefs({ version: 2, items: { show_status: { enabled: true, position: "top-right" }, rating_imdb: { enabled: true, position: "right-edge" }, year: { enabled: true, position: "left-edge" } } }).items;
    assert.equal(stored.get("show_status")?.position, "right-edge");
    assert.equal(stored.get("rating_imdb")?.position, "right-edge");
    assert.equal(stored.get("year")?.position, "left-edge");
    assert.equal(parseOverlayPrefs({ year: { enabled: true, position: "top-right" } }).items.get("year")?.position, "right-edge", "a version 1 top-right badge moves too");
});

test("an original language shows its English name, and an unknown or invalid tag its code", () => {
    assert.equal(languageName("ja"), "Japanese");
    assert.equal(languageName(" pt-BR "), "Brazilian Portuguese");
    assert.equal(languageName("zz"), "ZZ");
    assert.equal(languageName("not a tag"), "NOT A TAG");
    assert.equal(languageName("  "), undefined);
    assert.equal(languageName(undefined), undefined);
});

test("the combined Resolution + HDR + Audio badge is a known id, off by default, so a stored document keeps it", () => {
    assert.deepEqual(parseOverlayPrefs(undefined).items.get("resolution_hdr_audio"), { enabled: false, position: "top-left", accentColor: undefined, showIcon: undefined });
    const prefs = parseOverlayPrefs({ version: 2, preset: "classic", order: ["resolution_hdr_audio"], items: { resolution_hdr_audio: { enabled: true, position: "bottom-left" } } });
    assert.deepEqual(prefs.order, ["resolution_hdr_audio"]);
    assert.equal(prefs.items.get("resolution_hdr_audio")?.enabled, true);
    assert.equal(prefs.items.get("resolution_hdr_audio")?.position, "bottom-left");
});
