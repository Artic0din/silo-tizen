import assert from "node:assert/strict";
import { test } from "node:test";
import { audiobookOperations as api } from "../../src/api/audiobookOperations.ts";
import { operations } from "../../src/api/operations.ts";
import {
    audiobookLibraries, AUDIOBOOK_SEEK_KEYS, bookPosition, currentChapterIndex, decodeAudiobook, decodeAudiobookGroups,
    decodeProgressSync, isFinished, resumePosition, SHOW_AUDIOBOOKS_DEFAULT, SHOW_AUDIOBOOKS_KEY,
} from "../../src/contracts/v2/audiobooks.ts";
import { decodeUserLibraries } from "../../src/contracts/v2/catalog.ts";
import { decodeCatalogQueryPage } from "../../src/contracts/v2/discovery.ts";
import { decodeProblem, WireError } from "../../src/contracts/v2/wire.ts";
import { fixture } from "./support/fakeSilo.ts";

// The server publishes no audiobook item fixture. This body follows CatalogItemDetail, FileVersion,
// VersionChapter, WatchRollup and AudiobookDetailExtension in openapi.json at SOURCE.
function twoPartBook(): Record<string, unknown> {
    return {
        content_id: "audiobook:dune", type: "audiobook", title: "Dune", overview: "Spice.", year: 1965, genres: ["Science Fiction"],
        poster_url: "/art/dune", cast: [], crew: [], ratings: [], subtitles: [], keywords: [], status: "matched",
        user_data: { watched_count: 0, unplayed_count: 1, in_progress_count: 1, played: false, position_seconds: 140.5 },
        versions: [
            { file_id: "12", presentation_kind: "audiobook_part", presentation_part_index: 2, duration: 100, codec_audio: "aac", chapters: [
                { index: 0, title: "Part Two Opening", start_seconds: 0, end_seconds: 40, source: "embedded" },
                { index: 1, title: "", start_seconds: 40, end_seconds: 100, source: "embedded" },
            ] },
            { file_id: "9", presentation_kind: "audiobook_part", presentation_part_index: 1, duration: 120, codec_audio: "aac", chapters: [
                { index: 0, title: "Opening", start_seconds: 0, end_seconds: 120, source: "embedded" },
            ] },
        ],
        audiobook: {
            authors: [{ name: "Frank Herbert", person_id: "p1", photo_url: "/art/frank" }],
            narrators: [{ name: "Scott Brick" }, { name: "Orlagh Cassidy" }],
            publisher: "Macmillan Audio", total_duration_seconds: 230,
            series: { name: "Dune", entries: [{ content_id: "audiobook:messiah", title: "Dune Messiah", series_index: 2, year: 1969, poster_url: "/art/messiah" }] },
            other_narrations: [{ content_id: "audiobook:dune-2", title: "Dune", narrators: ["Simon Vance"], year: 2007 }],
            related: { also_by_author: [{ content_id: "audiobook:children", title: "Children of Dune" }], similar: [] },
        },
    };
}

test("groups decode the server fixture, including its continuation", () => {
    const page = decodeAudiobookGroups(fixture("list_audiobook_groups_ok"));
    assert.deepEqual(page.items, [{ name: "Frank Herbert", itemCount: 3, totalDurationSeconds: 7200, inProgressCount: 0, finishedCount: 0, posterUrls: [] }]);
    assert.equal(page.total, 2);
    assert.equal(page.totalExact, true);
    assert.match(page.nextCursor ?? "", /^eyJ2/);
});

test("groups: a last page has no continuation, and malformed members fail", () => {
    const base = fixture("list_audiobook_groups_ok");
    assert.equal(decodeAudiobookGroups({ ...base, page: { has_more: false } }).nextCursor, undefined);
    assert.equal(decodeAudiobookGroups({ ...base, page: undefined }).nextCursor, undefined);
    const group = { name: "G", item_count: 1, total_duration_seconds: 5, in_progress_count: 0, finished_count: 0, poster_urls: ["/a"] };
    for (const invalid of [
        { ...base, page: { has_more: true } },
        { ...base, page: { has_more: true, next_cursor: "" } },
        { ...base, items: undefined },
        { ...base, total: -1 },
        { ...base, total_exact: "yes" },
        { ...base, items: [{ ...group, item_count: 1.5 }] },
        { ...base, items: [{ ...group, poster_urls: undefined }] },
        { ...base, items: [{ ...group, name: 3 }] },
    ]) assert.throws(() => decodeAudiobookGroups(invalid), WireError);
});

test("the server's group error fixtures decode as problems", () => {
    const badGroup = decodeProblem(fixture("list_audiobook_groups_invalid_group_by"));
    assert.deepEqual([badGroup.status, badGroup.id, badGroup.errors[0]?.location], [422, "validation_failed", "query.group_by"]);
    assert.equal(decodeProblem(fixture("list_audiobook_groups_profile_header_required")).errors[0]?.location, "header.x-profile-id");
});

test("listAudiobookGroups builds a bounded, encoded read", () => {
    const spec = api.listAudiobookGroups({ libraryId: "a/b", groupBy: "author", limit: 24, cursor: "c+/=", sort: "count", namePrefix: "Fr & ", skipTotal: true });
    assert.equal(spec.method, "GET");
    assert.equal(spec.retry, "safe");
    assert.equal(spec.path, "/catalog/audiobook-groups?library_id=a%2Fb&group_by=author&limit=24&image_size=small&cursor=c%2B%2F%3D&sort=count&q=Fr%20%26%20&skip_total=true");
    assert.equal(api.listAudiobookGroups({ libraryId: "3", groupBy: "series", limit: 1 }).path, "/catalog/audiobook-groups?library_id=3&group_by=series&limit=1&image_size=small");
    for (const limit of [0, 201, 1.5]) assert.throws(() => api.listAudiobookGroups({ libraryId: "3", groupBy: "series", limit }), RangeError);
    assert.deepEqual(spec.decode(fixture("list_audiobook_groups_ok")).items.map(group => group.name), ["Frank Herbert"]);
});

test("getAudiobook reads the catalog item and decodes it as a book", () => {
    const spec = api.getAudiobook("audiobook:du ne");
    assert.deepEqual([spec.method, spec.retry, spec.path], ["GET", "safe", "/catalog/items/audiobook%3Adu%20ne?image_size=large"]);
    assert.equal(spec.decode(twoPartBook()).id, "audiobook:dune");
});

test("queryAudiobooks omits the media type and filters one group by its name", () => {
    const spec = api.queryAudiobooks({ libraryId: "3", limit: 60, sort: "author", order: "asc", cursor: "next", namePrefix: "D", group: { by: "narrator", name: "Scott Brick" } });
    assert.deepEqual([spec.method, spec.retry, spec.path], ["POST", "safe", "/catalog/query?image_size=small"]);
    assert.deepEqual(spec.body, {
        library_id: "3", match: "all", sort: "author", order: "asc", limit: 60, cursor: "next", name_prefix: "D",
        groups: [{ match: "any", rules: [{ field: "narrator", op: "is", value: "Scott Brick" }] }],
    });
    assert.equal("type" in (api.queryAudiobooks({ libraryId: "3", limit: 100, sort: "title", order: "asc" }).body ?? {}), false);
    assert.throws(() => api.queryAudiobooks({ libraryId: "3", limit: 101, sort: "title", order: "asc" }), RangeError);
    assert.equal(spec.decode, decodeCatalogQueryPage);
});

test("every audiobook operation is part of the shared operations", () => {
    for (const name of ["listAudiobookGroups", "getAudiobook", "queryAudiobooks", "syncProgress"] as const) assert.equal(operations[name], api[name]);
});

test("audiobook parts and chapters stitch onto one whole-book timeline", () => {
    const book = decodeAudiobook(twoPartBook());
    assert.deepEqual(book.parts, [{ fileId: "9", duration: 120, offset: 0 }, { fileId: "12", duration: 100, offset: 120 }]);
    assert.deepEqual(book.chapters, [
        { title: "Opening", start: 0, end: 120, partIndex: 0 },
        { title: "Part Two Opening", start: 120, end: 160, partIndex: 1 },
        { title: "Chapter 3", start: 160, end: 220, partIndex: 1 },
    ]);
    assert.equal(book.duration, 230);
    assert.equal(book.position, 140.5);
    assert.equal(book.played, false);
    assert.deepEqual([book.title, book.overview, book.year, book.genres, book.posterUrl], ["Dune", "Spice.", 1965, ["Science Fiction"], "/art/dune"]);
});

test("parts sort by part index, then numerically by file id", () => {
    const version = (file_id: string, presentation_part_index?: number) => ({ file_id, duration: 10, codec_audio: "aac", ...(presentation_part_index === undefined ? {} : { presentation_part_index }) });
    const book = decodeAudiobook({ ...twoPartBook(), versions: [version("10"), version("9"), version("2", 5), version("3", 1)] });
    assert.deepEqual(book.parts.map(part => part.fileId), ["3", "2", "9", "10"]);
});

test("the audiobook extension keeps credits, series, other narrations and related books", () => {
    const { detail } = decodeAudiobook(twoPartBook());
    assert.deepEqual(detail.authors, [{ name: "Frank Herbert", personId: "p1", photoUrl: "/art/frank" }]);
    assert.deepEqual(detail.narrators.map(person => person.name), ["Scott Brick", "Orlagh Cassidy"]);
    assert.equal(detail.publisher, "Macmillan Audio");
    assert.equal(detail.totalDurationSeconds, 230);
    assert.deepEqual(detail.series, { name: "Dune", entries: [{ id: "audiobook:messiah", title: "Dune Messiah", year: 1969, seriesIndex: 2, posterUrl: "/art/messiah" }] });
    assert.deepEqual(detail.otherNarrations, [{ id: "audiobook:dune-2", title: "Dune", year: 2007, narrators: ["Simon Vance"] }]);
    assert.deepEqual(detail.alsoByAuthor, [{ id: "audiobook:children", title: "Children of Dune", year: undefined, seriesIndex: undefined, posterUrl: undefined }]);
    assert.deepEqual(detail.similar, []);
});

test("a book without the extension, user data or versions still decodes", () => {
    const book = decodeAudiobook({ content_id: "audiobook:bare", type: "audiobook", title: "Bare" });
    assert.deepEqual([book.parts, book.chapters, book.duration, book.position, book.played, book.genres], [[], [], 0, 0, false, []]);
    assert.deepEqual(book.detail.authors, []);
    assert.equal(book.detail.series, undefined);
});

test("the total duration and the played flag come from the server; position never passes the end", () => {
    const longer = decodeAudiobook({ ...twoPartBook(), audiobook: { total_duration_seconds: 300 } });
    assert.equal(longer.duration, 300);
    const done = decodeAudiobook({ ...twoPartBook(), user_data: { played: true, position_seconds: 9999 } });
    assert.deepEqual([done.played, done.position], [true, 230]);
});

test("an item that is not an audiobook fails, but the extension alone identifies one", () => {
    assert.throws(() => decodeAudiobook({ ...twoPartBook(), type: "movie", audiobook: undefined }), WireError);
    assert.equal(decodeAudiobook({ ...twoPartBook(), type: "book" }).id, "audiobook:dune");
});

test("a part without audio facts is not a part", () => {
    const book = decodeAudiobook({ ...twoPartBook(), versions: [{ file_id: "1", duration: 5 }, { file_id: "2", resolution: "1080p" }] });
    assert.deepEqual(book.parts.map(part => part.fileId), ["1"]);
});

test("part length falls back to the furthest chapter end, never a chapter start", () => {
    const chapters = (...ends: (number | undefined)[]) => ends.map((end, index) => ({ index, title: "c", start_seconds: index * 30, ...(end === undefined ? {} : { end_seconds: end }), source: "embedded" }));
    const single = (list: unknown) => decodeAudiobook({ ...twoPartBook(), audiobook: undefined, versions: [{ file_id: "1", codec_audio: "aac", chapters: list }] });
    assert.equal(single(chapters(30, 90)).parts[0]?.duration, 90);
    assert.equal(single(chapters(30, undefined)).parts[0]?.duration, 30);
    assert.equal(single(chapters(undefined, undefined)).parts[0]?.duration, 0);
    // A multi-part book cannot place later parts without every length.
    assert.throws(() => decodeAudiobook({ ...twoPartBook(), versions: [{ file_id: "1", codec_audio: "aac", chapters: chapters(undefined, undefined) }, { file_id: "2", duration: 100 }] }), /versions/);
});

test("malformed times and shapes fail without echoing values", () => {
    for (const invalid of [
        { ...twoPartBook(), user_data: { played: false, position_seconds: -1 } },
        { ...twoPartBook(), user_data: { played: "no" } },
        { ...twoPartBook(), versions: [{ file_id: "1", duration: -2 }] },
        { ...twoPartBook(), versions: [{ file_id: "1", duration: 5, chapters: [{ title: "x" }] }] },
        { ...twoPartBook(), versions: [{ file_id: "", duration: 5 }] },
        { ...twoPartBook(), versions: {} },
        { ...twoPartBook(), audiobook: { authors: [{ name: 4 }] } },
        { ...twoPartBook(), audiobook: { total_duration_seconds: "long" } },
        { ...twoPartBook(), audiobook: { related: { similar: [{ content_id: "x" }] } } },
        { ...twoPartBook(), content_id: undefined },
    ]) assert.throws(() => decodeAudiobook(invalid), WireError);
});

test("resume uses Apple's 30 second grace and 5 second end margin", () => {
    assert.equal(resumePosition(30, 220), undefined);
    assert.equal(resumePosition(31, 220), 31);
    assert.equal(resumePosition(214.9, 220), 214.9);
    assert.equal(resumePosition(215, 220), undefined);
    assert.equal(resumePosition(500, 0), 500);
    assert.equal(resumePosition(Number.NaN, 220), undefined);
});

test("finished is the played flag or a position within 5 seconds of a known end", () => {
    assert.equal(isFinished(true, 0, 0), true);
    assert.equal(isFinished(false, 215, 220), true);
    assert.equal(isFinished(false, 214.9, 220), false);
    assert.equal(isFinished(false, 0, 220), false);
    assert.equal(isFinished(false, 500, 0), false);
});

test("the current chapter is the last one started; before the first it is the first", () => {
    const { chapters } = decodeAudiobook(twoPartBook());
    assert.equal(currentChapterIndex([], 10), undefined);
    assert.equal(currentChapterIndex(chapters, 0), 0);
    assert.equal(currentChapterIndex(chapters, 119.9), 0);
    assert.equal(currentChapterIndex(chapters, 120), 1);
    assert.equal(currentChapterIndex(chapters, 1000), 2);
    assert.equal(currentChapterIndex([{ title: "x", start: 50, end: undefined, partIndex: 0 }], 10), 0);
});

test("a whole-book position maps to the file and the seconds inside it", () => {
    const book = decodeAudiobook(twoPartBook());
    assert.deepEqual([bookPosition(book, 10).part.fileId, bookPosition(book, 10).localSeconds], ["9", 10]);
    assert.deepEqual([bookPosition(book, 119.5).partIndex, bookPosition(book, 119.5).localSeconds], [0, 119.5]);
    assert.deepEqual([bookPosition(book, 120).part.fileId, bookPosition(book, 120).localSeconds], ["12", 0]);
    assert.deepEqual([bookPosition(book, 140).part.fileId, bookPosition(book, 140).localSeconds], ["12", 20]);
    // The server total (230) exceeds the stitched parts (220): the seek stays inside the last file.
    assert.deepEqual([bookPosition(book, 9999).part.fileId, bookPosition(book, 9999).localSeconds], ["12", 100]);
    assert.equal(bookPosition(book, -5).localSeconds, 0);
    assert.throws(() => bookPosition(decodeAudiobook({ content_id: "a", type: "audiobook", title: "T" }), 0), WireError);
    const unknownLength = decodeAudiobook({ ...twoPartBook(), audiobook: undefined, versions: [{ file_id: "1", codec_audio: "aac" }] });
    assert.equal(bookPosition(unknownLength, 45).localSeconds, 45);
});

test("audiobook libraries need the audiobooks type and must not be hidden", () => {
    const libraries = decodeUserLibraries({ items: [
        { id: "1", name: "Movies", type: "movies", sort_order: 1 },
        { id: "3", name: "Audio", type: "audiobooks", sort_order: 2 },
        { id: "4", name: "More Audio", type: "audiobooks", sort_order: 3 },
        { id: "5", name: "Future", type: "future", sort_order: 4 },
    ] });
    assert.deepEqual(audiobookLibraries(libraries, []).map(library => library.id), ["3", "4"]);
    assert.deepEqual(audiobookLibraries(libraries, ["3"]).map(library => library.id), ["4"]);
    assert.deepEqual(audiobookLibraries(libraries.filter(library => library.type !== "audiobooks"), []), []);
});

test("the local opt-in and seek keys are the manifest key names", () => {
    assert.equal(SHOW_AUDIOBOOKS_KEY, "nav.show_audiobooks");
    assert.equal(SHOW_AUDIOBOOKS_DEFAULT, false);
    assert.deepEqual(AUDIOBOOK_SEEK_KEYS, ["player.audiobook_skip_back_seconds", "player.audiobook_skip_forward_seconds"]);
});

test("syncProgress writes whole milliseconds with overwrite and is never resent", () => {
    const spec = api.syncProgress([{ mediaItemId: "audiobook:dune", positionSeconds: 12.3456, durationSeconds: 230 }, { mediaItemId: "b", positionSeconds: 0, durationSeconds: Number.NaN }]);
    assert.deepEqual([spec.method, spec.retry, spec.path], ["POST", "never", "/sync/progress"]);
    assert.deepEqual(spec.body, { items: [
        { media_item_id: "audiobook:dune", position_ms: 12346, duration_ms: 230000, force_overwrite: true },
        { media_item_id: "b", position_ms: 0, duration_ms: 0, force_overwrite: true },
    ] });
    const write = { mediaItemId: "a", positionSeconds: 1, durationSeconds: 1 };
    assert.throws(() => api.syncProgress([]), RangeError);
    assert.throws(() => api.syncProgress(Array.from({ length: 101 }, (_, index) => ({ ...write, mediaItemId: String(index) }))), RangeError);
    assert.equal(api.syncProgress(Array.from({ length: 100 }, (_, index) => ({ ...write, mediaItemId: String(index) }))).method, "POST");
    assert.throws(() => api.syncProgress([write, write]), RangeError);
    assert.throws(() => api.syncProgress([{ ...write, mediaItemId: " " }]), RangeError);
    assert.throws(() => api.syncProgress([{ ...write, positionSeconds: -1 }]), RangeError);
    assert.throws(() => api.syncProgress([{ ...write, positionSeconds: Number.POSITIVE_INFINITY }]), RangeError);
    assert.throws(() => api.syncProgress([{ ...write, positionSeconds: 1e300 }]), RangeError);
});

test("syncProgress pairs one result with each written item, in request order", () => {
    const failure = { type: "https://siloserver.org/docs/api/v2/problems/not_found", title: "Not found", status: 404, detail: "No such item." };
    const wire = { items: [
        { index: 1, media_item_id: "b", status: "failure", failure },
        { index: 0, media_item_id: "a", status: "success" },
    ], summary: { total: 2, succeeded: 1, failed: 1 } };
    assert.deepEqual(decodeProgressSync(wire, ["a", "b"]), [
        { index: 0, mediaItemId: "a", failure: undefined },
        { index: 1, mediaItemId: "b", failure },
    ]);
    const spec = api.syncProgress([{ mediaItemId: "a", positionSeconds: 1, durationSeconds: 0 }, { mediaItemId: "b", positionSeconds: 1, durationSeconds: 0 }]);
    assert.equal(spec.decode(wire)[1]?.failure?.status, 404);
});

test("syncProgress treats any answer that does not match the batch as a contract break", () => {
    const ok = (index: number, id: string) => ({ index, media_item_id: id, status: "success" });
    for (const invalid of [
        { items: [] },
        { items: [ok(0, "a")] },
        { items: [ok(0, "a"), ok(1, "x")] },
        { items: [ok(0, "a"), ok(0, "b")] },
        { items: [ok(0, "a"), ok(2, "b")] },
        { items: [ok(0, "a"), { ...ok(1, "b"), status: "partial" }] },
        { items: [ok(0, "a"), { ...ok(1, "b"), failure: { type: "t", title: "t", status: 500, detail: "d" } }] },
        { items: [ok(0, "a"), { index: 1, media_item_id: "b", status: "failure" }] },
        { items: [ok(0, "a"), { index: 1, media_item_id: "b", status: "failure", failure: { type: "t", title: "t", status: "500", detail: "d" } }] },
        { items: [ok(0, "a"), ok(-1, "b")] },
    ]) assert.throws(() => decodeProgressSync({ summary: { total: 2, succeeded: 2, failed: 0 }, ...invalid }, ["a", "b"]), WireError);
    assert.throws(() => decodeProgressSync({ items: [ok(0, "a"), ok(1, "b")] }, ["a", "b"]), WireError);
    assert.throws(() => decodeProgressSync({ items: [ok(0, "a"), ok(1, "b")], summary: { total: 2, succeeded: 2 } }, ["a", "b"]), WireError);
});
