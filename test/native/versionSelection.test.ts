import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeItemDetail } from "../../src/contracts/v2/catalog.ts";
import { compactVersionLabel, displayVersion, versionLabel, type RankedVersion } from "../../src/contracts/v2/versions.ts";
import { playChoices } from "../../src/ui/browseModel.ts";
import { DetailsState } from "../../src/ui/detailsState.ts";
import { fixture } from "./support/fakeSilo.ts";
import { settle } from "./support/clock.ts";
import type { NativeSession } from "../../src/session/session.ts";
import type { RequestSpec } from "../../src/api/http.ts";

// Expected values follow silo-apple DetailVersionSelection.displayVersion and
// DetailPlaybackFormatting.versionShortLabel / versionCompactLabel.

function files(...resolutions: (string | undefined)[]): RankedVersion[] {
    return resolutions.map((resolution, index) => ({ fileId: String.fromCharCode(97 + index), ...(resolution === undefined ? {} : { resolution }) }));
}

function best(versions: readonly RankedVersion[], options: { selected?: string | undefined; last?: string | undefined; quality?: string | undefined } = {}): string | undefined {
    return displayVersion(versions, options.selected, options.last, options.quality)?.fileId;
}

test("the default version is the highest resolution, whatever order the server lists", () => {
    assert.equal(best(files("720p", "2160p", "1080p")), "b");
    assert.equal(best(files("480p", "720p", "1080p")), "c");
    assert.equal(best(files("1080p", "480p", "720p")), "a");
});

test("4K and 2160p spellings share one rank, and the first listed file wins every tie", () => {
    assert.equal(best(files("4K", "2160p")), "a");
    assert.equal(best(files("2160p", "4k")), "a");
    assert.equal(best(files("1920x1080", "1080p", "1080i")), "a");
    assert.equal(best(files("1080p", "1080p")), "a");
    assert.equal(best(files("720p", "1080p", "1080p")), "b");
});

test("files without a recognised resolution rank last but stay selectable", () => {
    assert.equal(best(files(undefined, "480p")), "b");
    assert.equal(best(files("SD", undefined, "720p")), "c");
    assert.equal(best(files(undefined, undefined)), "a");
    assert.equal(best(files("")), "a");
    assert.equal(displayVersion([], undefined, undefined, undefined), undefined);
});

test("a selected file wins, then the last-played file, then the ranking", () => {
    const versions = files("2160p", "1080p", "720p");
    assert.equal(best(versions, { selected: "c", last: "b" }), "c");
    assert.equal(best(versions, { last: "b" }), "b");
    assert.equal(best(versions, { selected: "missing", last: "b" }), "b", "Apple falls back past a selection that is gone");
    assert.equal(best(versions, { selected: "missing", last: "missing" }), "a");
});

test("a stored resolution cap prefers files at or under it and demotes files above it", () => {
    const versions = files("2160p", "1080p", "720p");
    assert.equal(best(versions, { quality: "1080p" }), "b");
    assert.equal(best(versions, { quality: "720p" }), "c");
    assert.equal(best(files("2160p", "1080p"), { quality: "480p" }), "a", "every file is over the cap, so the smaller demotion loses nothing");
    assert.equal(best(files("1080p", "2160p"), { quality: "480p" }), "b");
    assert.equal(best(files("720p", "1080p", "1080p"), { quality: "1080p" }), "b", "ties under a cap keep server order");
    assert.equal(best(files("480p", "720p"), { quality: "1080p" }), "b", "under the cap, higher still wins");
    assert.equal(best(files(undefined, "2160p"), { quality: "1080p" }), "a", "an unranked file is never demoted, so it beats a file over the cap");
    assert.equal(best(files(undefined, "720p"), { quality: "1080p" }), "b", "an unranked file never gets the cap bonus");
});

test("stored quality spellings that cap nothing are ignored", () => {
    const versions = files("720p", "2160p", "1080p");
    for (const quality of [undefined, "", "  ", "auto", "AUTO", "original", "source", "max", "2160p", "4K", "uhd", "unknown"]) {
        assert.equal(best(versions, { quality }), "b", `quality ${JSON.stringify(quality)}`);
    }
});

test("stored quality tiers and their legacy spellings cap at their resolution", () => {
    const versions = files("2160p", "1080p", "720p", "480p");
    assert.equal(best(versions, { quality: "1080p-high" }), "b");
    assert.equal(best(versions, { quality: " 1080P-Medium " }), "b");
    assert.equal(best(versions, { quality: "1080p-8" }), "b");
    assert.equal(best(versions, { quality: "720p-high" }), "c");
    assert.equal(best(versions, { quality: "720p-medium" }), "c");
    assert.equal(best(versions, { quality: "480p" }), "d");
    assert.equal(best(versions, { quality: "328p" }), "a", "328p ranks nothing, so every ranked file is demoted equally");
    assert.equal(best(versions, { quality: "420p" }), "a", "420p is the old spelling of 328p");
});

test("version labels read resolution, video codec, dynamic range and audio codec, never the edition", () => {
    assert.equal(versionLabel({ resolution: "2160p", codecVideo: "hevc", hdr: true, dolbyVision: "profile 8", codecAudio: "eac3" }), "2160p · HEVC · DV · EAC3");
    assert.equal(versionLabel({ resolution: "2160p", codecVideo: "h265", hdr: true, codecAudio: "truehd" }), "2160p · HEVC · HDR · TrueHD");
    assert.equal(versionLabel({ resolution: "1080p", codecVideo: "h264", hdr: false, codecAudio: "aac" }), "1080p · H.264 · AAC");
    assert.equal(versionLabel({ resolution: "1080p", codecVideo: "avc1", codecAudio: "dts" }), "1080p · H.264 · DTS");
    assert.equal(versionLabel({ resolution: "2160p", codecVideo: "av1" }), "2160p · AV1");
    assert.equal(versionLabel({ codecVideo: "vp9", codecAudio: "opus" }), "VP9 · OPUS");
    assert.equal(versionLabel({ resolution: "  720p  ", dolbyVision: "  " }), "720p");
    assert.equal(versionLabel({}), "");
});

test("the compact label keeps only resolution and dynamic range", () => {
    assert.equal(compactVersionLabel({ resolution: "2160p", hdr: true, dolbyVision: "profile 5" }), "2160p · DV");
    assert.equal(compactVersionLabel({ resolution: "2160p", hdr: true }), "2160p · HDR");
    assert.equal(compactVersionLabel({ resolution: "1080p", hdr: false }), "1080p");
    assert.equal(compactVersionLabel({ hdr: true }), "HDR");
    assert.equal(compactVersionLabel({}), "");
});

const base = { ...fixture("get_catalog_item_ok"), duration_seconds: 7200 };

function detailWith(versions: object[], lastFileId?: string): ReturnType<typeof decodeItemDetail> {
    return decodeItemDetail({ ...base, versions, user_data: { played: false, ...(lastFileId === undefined ? {} : { last_file_id: lastFileId }) } });
}

test("decoded versions carry the resolution and the Apple label without the edition", () => {
    const detail = detailWith([
        { file_id: "x", duration: 7200, resolution: "2160p", codec_video: "hevc", codec_audio: "eac3", hdr: true, edition_raw: "Director's Cut", video_tracks: [{ dolby_vision: "profile 8" }] },
        { file_id: "y", duration: 7200, resolution: "1080p", codec_video: "h264", codec_audio: "aac", hdr: false, container: "mkv", file_size: 8_430_000_000 },
    ]);
    assert.deepEqual(detail.versions.map(file => [file.fileId, file.resolution, file.label, file.compactLabel]), [
        ["x", "2160p", "2160p · HEVC · DV · EAC3", "2160p · DV"],
        ["y", "1080p", "1080p · H.264 · AAC", "1080p"],
    ]);
    assert.equal(detail.versions[1]?.detailLabel, "H.264 · MKV · 8.43 GB");
});

test("Details starts the best version, not the first one the server lists", () => {
    const detail = detailWith([
        { file_id: "sd", duration: 7200, resolution: "720p" },
        { file_id: "uhd", duration: 7200, resolution: "2160p" },
        { file_id: "hd", duration: 7200, resolution: "1080p" },
    ]);
    assert.equal(playChoices(detail)?.fromStart.fileId, "uhd");
    assert.equal(playChoices(detail)?.fromStart.allowAlternateVersions, undefined);
    assert.equal(playChoices(detail, undefined, "1080p")?.fromStart.fileId, "hd");
    assert.equal(playChoices(detail, "sd", "1080p")?.fromStart.fileId, "sd");
    assert.equal(playChoices(detail, "sd")?.fromStart.allowAlternateVersions, false);
});

test("Details keeps the last-played version over a better-ranked one", () => {
    const detail = detailWith([
        { file_id: "uhd", duration: 7200, resolution: "2160p" },
        { file_id: "sd", duration: 7200, resolution: "720p" },
    ], "sd");
    assert.equal(playChoices(detail)?.fromStart.fileId, "sd");
    assert.equal(playChoices(detail, undefined, "2160p")?.fromStart.fileId, "sd");
});

test("a last-played file that is no longer listed falls back to the ranking", () => {
    const detail = detailWith([
        { file_id: "sd", duration: 7200, resolution: "720p" },
        { file_id: "uhd", duration: 7200, resolution: "2160p" },
    ], "gone");
    assert.equal(playChoices(detail)?.fromStart.fileId, "uhd");
});

test("Details ranks versions with the resolution cap stored for the profile", async () => {
    const detail = detailWith([
        { file_id: "uhd", duration: 7200, resolution: "2160p" },
        { file_id: "hd", duration: 7200, resolution: "1080p" },
    ]);
    const session = { onAuthorityChange: () => () => {}, call: async <T>(request: RequestSpec<T>): Promise<T> => {
        if (request.path.startsWith("/settings/values/effective") && request.path.includes("preferred_quality")) return new Map([["playback.preferred_quality", { value: "1080p-high" }]]) as T;
        throw new Error(`unexpected read ${request.path}`);
    } } as unknown as NativeSession;
    const state = new DetailsState(detail, session, () => {}, async () => {});
    assert.equal(playChoices(state.detail, undefined, state.preferredQuality)?.fromStart.fileId, "uhd");
    state.start();
    await settle();
    try {
        assert.equal(state.preferredQuality, "1080p-high");
        assert.equal(playChoices(state.detail, undefined, state.preferredQuality)?.fromStart.fileId, "hd");
    } finally { state.stop(); }
});
