import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeCatalogSubtitles, decodeSubtitlePreferences, type SubtitlePreferences } from "../../src/contracts/v2/preplaySubtitles.ts";
import { initialSubtitle, startSubtitleTrackId } from "../../src/player/preplaySubtitles.ts";
import type { AudioTrackInfo, SubtitleTrack } from "../../src/contracts/v2/playback.ts";
import type { PlayableFile } from "../../src/contracts/v2/catalog.ts";
import { withStartAudioLanguage } from "../../src/ui/browseModel.ts";

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

test("Auto omits the pre-start subtitle when the playing audio language is unknown", () => {
    const rows = [{ selectionIndex: 0, externalPath: "", source: "embedded" as const, language: "en", codec: "srt", label: "English", forced: false, hearingImpaired: false }];
    assert.equal(startSubtitleTrackId("42", { kind: "auto" }, rows, { ...prefs, audioLanguage: undefined }), undefined);
    assert.equal(startSubtitleTrackId("42", { kind: "auto" }, rows, { ...prefs, audioLanguage: "en" }), undefined);
    assert.equal(startSubtitleTrackId("42", { kind: "auto" }, rows, { ...prefs, audioLanguage: "ja" }), "file:42:subtitle:0");
    assert.equal(startSubtitleTrackId("42", { kind: "off" }, rows, prefs), undefined);
});

test("a server-shaped catalog names the signs track by the combined ordinal and does not name a downloaded row", () => {
    // Catalog order is every embedded row, then every external row. Downloaded rows exist only on the plan.
    const catalog = decodeCatalogSubtitles({
        subtitle_tracks: [
            { index: 97, external: false, language: "eng", codec: "ass", title: "English (Signs)", forced: true },
            { index: 1, external: false, language: "jpn", codec: "pgs", title: "Japanese" },
            { index: 2, external: false, language: "fre", codec: "dvd_subtitle", title: "French" },
            { external: true, language: "eng", codec: "srt", title: "English", file_name: "English.srt" },
        ],
    }, "version");
    const signs = catalog[0];
    const external = catalog[3];
    assert.ok(signs && external);
    assert.equal(startSubtitleTrackId("42", { kind: "track", signature: signs }, catalog), "file:42:subtitle:1");
    assert.equal(startSubtitleTrackId("42", { kind: "track", signature: external }, catalog), "file:42:subtitle:0");
    const downloaded = { selectionIndex: 4, externalPath: "", source: "downloaded" as const, language: "spa", codec: "srt", label: "Spanish (downloaded)", forced: false, hearingImpaired: false };
    assert.equal(startSubtitleTrackId("42", { kind: "track", signature: downloaded }, [...catalog, downloaded]), undefined);
});

test("a pre-start pick skips an embedded row the server cannot deliver and keeps later ordinals", () => {
    const unroutable = { selectionIndex: 0, externalPath: "", source: "embedded" as const, language: "en", codec: undefined, label: "English", forced: false, hearingImpaired: false };
    const routable = { ...unroutable, selectionIndex: 1, codec: "srt", label: "English SDH", hearingImpaired: true };
    for (const mode of ["auto", "always"] as const) {
        assert.equal(startSubtitleTrackId("42", { kind: "auto" }, [unroutable], { ...prefs, mode }), undefined, mode);
        assert.equal(startSubtitleTrackId("42", { kind: "auto" }, [unroutable, routable], { ...prefs, mode }), "file:42:subtitle:1", mode);
    }
    assert.equal(startSubtitleTrackId("42", { kind: "track", signature: unroutable }, [unroutable]), undefined);
    // After start the plan inventory goes through the same rule, so no track change names the row.
    const planRow: SubtitleTrack = { ...track, trackId: "file:42:subtitle:0", combinedIndex: 0, codec: undefined };
    assert.equal(initialSubtitle({ kind: "track", signature: { ...unroutable, codec: undefined } }, [planRow]), undefined);
    assert.equal(initialSubtitle({ kind: "auto" }, [planRow], { ...prefs, mode: "always" }), undefined);
});

test("a saved downloaded subtitle names no catalog row before start", () => {
    const spanish = { selectionIndex: 0, externalPath: "", source: "embedded" as const, language: "es", codec: "srt", label: "Spanish", forced: false, hearingImpaired: false };
    const downloaded = { ...spanish, source: "downloaded" as const, label: "Spanish (downloaded)" };
    assert.equal(startSubtitleTrackId("42", { kind: "auto" }, [spanish], { ...prefs, mode: "always", language: "es", signature: downloaded }), undefined);
    assert.equal(startSubtitleTrackId("42", { kind: "auto" }, [spanish], { ...prefs, mode: "always", language: "es" }), "file:42:subtitle:0");
    const forcedEnglish = { ...spanish, language: "en", forced: true, label: "English (Forced)" };
    assert.equal(startSubtitleTrackId("42", { kind: "auto" }, [forcedEnglish], { ...prefs, mode: "off", audioLanguage: "en", signature: downloaded }), "file:42:subtitle:0", "Off still names the forced track");
});

test("a Details audio pick decides which language Auto compares before start", () => {
    const audio = (language: string, isDefault: boolean): AudioTrackInfo => ({ isDefault, language, codec: "aac", channels: 2, title: undefined });
    const file = {
        fileId: "42", durationSeconds: 60, played: false, positionSeconds: undefined, lastFileId: undefined,
        effectiveAudioTrackIndex: 0, audio: [audio("en", true), audio("ja", false)],
        subtitles: [{ selectionIndex: 0, externalPath: "", source: "embedded" as const, language: "en", codec: "srt", label: "English", forced: false, hearingImpaired: false }],
        effectiveSubtitle: { ...prefs, audioLanguage: undefined },
    } as unknown as PlayableFile;
    const request = { contentId: "movie:1", fileId: "42", audioTrackId: "file:42:audio:1" };
    const hinted = withStartAudioLanguage(request as never, file) as { subtitlePreferences?: SubtitlePreferences };
    assert.equal(hinted.subtitlePreferences?.audioLanguage, "ja");
    const defaulted = withStartAudioLanguage({ contentId: "movie:1", fileId: "42" } as never, file) as { subtitlePreferences?: SubtitlePreferences };
    assert.equal(defaulted.subtitlePreferences?.audioLanguage, "en");
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
