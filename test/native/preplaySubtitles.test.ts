import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeCatalogSubtitles, decodeSubtitlePreferences, type SubtitlePreferences } from "../../src/contracts/v2/preplaySubtitles.ts";
import { initialSubtitle } from "../../src/player/preplaySubtitles.ts";
import type { SubtitleTrack } from "../../src/contracts/v2/playback.ts";

const track: SubtitleTrack = { trackId: "file:42:subtitle:9", combinedIndex: 9, source: "embedded", delivery: "sidecar", label: "English", codec: "srt", language: "en", forced: false, hearingImpaired: false, url: undefined, streamIndex: undefined, containerTrackId: undefined, nativeSelectable: undefined, hlsRendition: undefined };
const forced: SubtitleTrack = { ...track, trackId: "file:42:subtitle:12", combinedIndex: 12, forced: true, label: "Forced" };
const prefs: SubtitlePreferences = { mode: "auto", language: "en", audioLanguage: "ja", showForced: true, signature: undefined };

test("subtitle Auto compares actual audio language and preserves explicit Off", () => {
    assert.equal(initialSubtitle({ kind: "auto" }, [forced, track], prefs), track.trackId);
    assert.equal(initialSubtitle({ kind: "auto" }, [forced, track], { ...prefs, audioLanguage: "eng" }), forced.trackId);
    assert.equal(initialSubtitle({ kind: "auto" }, [forced, track], { ...prefs, audioLanguage: "en", showForced: false }), undefined);
    assert.equal(initialSubtitle({ kind: "auto" }, [forced, track], { ...prefs, mode: "off", audioLanguage: "en" }), forced.trackId);
    assert.equal(initialSubtitle({ kind: "off" }, [forced, track], prefs), undefined);
    assert.equal(initialSubtitle({ kind: "auto" }, [forced, track], { ...prefs, language: "" }), undefined);
    assert.equal(initialSubtitle({ kind: "auto" }, [forced, track], { ...prefs, audioLanguage: undefined }), track.trackId);
});

test("subtitle identities come only from the actual inventory, with exact and regional preferences", () => {
    const british = { ...track, trackId: "file:73:subtitle:6", language: "en-GB" };
    assert.equal(initialSubtitle({ kind: "track", signature: british }, [british]), british.trackId);
    assert.equal(initialSubtitle({ kind: "auto" }, [track, british], { ...prefs, language: "en-GB" }), british.trackId);
    assert.equal(initialSubtitle({ kind: "auto" }, [track, british], { ...prefs, mode: "always", signature: british }), british.trackId);
    assert.throws(() => initialSubtitle({ kind: "track", signature: track }, []));
    assert.throws(() => initialSubtitle({ kind: "track", signature: track }, [track, { ...track, trackId: "file:42:subtitle:10" }]));
});

test("preplay subtitle decoders validate file identity and retain display metadata without inventing playback IDs", () => {
    const rows = decodeCatalogSubtitles({ subtitle_tracks: [{ index: 27, external: true, title: "English", language: "en", codec: "srt", forced: false }] }, "file");
    assert.equal("index" in (rows[0] ?? {}), false);
    assert.equal(rows[0]?.source, "external");
    assert.equal("trackId" in (rows[0] ?? {}), false);
    const body = { content_id: "movie:1", versions: [{ file_id: "42", audio_tracks: [{ default: true, language: "ja" }] }], effective_subtitle_mode: "always", effective_subtitle_language: "en", effective_show_forced_subtitles: false };
    assert.deepEqual(decodeSubtitlePreferences(body, "movie:1", "42", "file:42:audio:0"), { mode: "always", language: "en", audioLanguage: "ja", showForced: false, signature: undefined });
    assert.equal(decodeSubtitlePreferences({ ...body, effective_subtitle_track_signature: { language: "en", forced: false, hearing_impaired: false } }, "movie:1", "42", undefined).signature?.source, "unknown", "saved signatures can omit their source");
    for (const bad of [{ ...body, content_id: "other" }, { ...body, versions: [] }, { ...body, effective_subtitle_mode: "invalid" }, { ...body, effective_show_forced_subtitles: 1 }]) assert.throws(() => decodeSubtitlePreferences(bad, "movie:1", "42", undefined));
    assert.equal(decodeCatalogSubtitles({ subtitle_tracks: [{ language: "en" }] }, "file").length, 1, "zero stream indexes may be omitted");
    for (const value of [{ subtitle_tracks: {} }, { subtitle_tracks: [{ language: 1 }] }, { subtitle_tracks: [{ index: 0, external: "yes" }] }]) assert.throws(() => decodeCatalogSubtitles(value, "file"));
});

test("the automatic and initial pick never choose a track the plan flags unplayable", () => {
    const broken = { ...track, trackId: "file:42:subtitle:3", combinedIndex: 3, unplayable: true };
    const brokenForced = { ...forced, unplayable: true };
    assert.equal(initialSubtitle({ kind: "auto" }, [broken, track], prefs), track.trackId, "the preferred-language pick skips it");
    assert.equal(initialSubtitle({ kind: "auto" }, [broken], prefs), undefined, "nothing playable leaves subtitles off");
    assert.equal(initialSubtitle({ kind: "auto" }, [brokenForced, track], { ...prefs, audioLanguage: "en" }), undefined, "a forced pick skips it");
    assert.equal(initialSubtitle({ kind: "auto" }, [broken, track], { ...prefs, mode: "always", signature: broken }), track.trackId, "a saved signature never lands on it");
    assert.equal(initialSubtitle({ kind: "auto" }, [{ ...track, unplayable: false }], prefs), track.trackId, "an explicit false stays pickable");
    assert.throws(() => initialSubtitle({ kind: "track", signature: broken }, [broken]), "a chosen unplayable track is no longer available");
});
