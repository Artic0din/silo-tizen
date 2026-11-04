import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeAudiobook, bookPosition, audiobookResume, decodeGroups } from "../../src/contracts/v2/audiobooks.ts";
import { navigationRoots } from "../../src/ui/navigation.ts";
import { AudiobookPreference } from "../../src/ui/audiobookPreference.ts";
import { MemoryPublicStorage } from "./support/keyManager.ts";

test("audiobook opt-in requires an accessible library and stays with its profile", () => {
    const library = { id: "3", name: "Audio", type: "audiobooks" as const, sortOrder: 1 };
    assert.equal(navigationRoots(null, [library], false).some(root => root.key === "audiobooks"), false);
    assert.equal(navigationRoots(null, [], false, true).some(root => root.key === "audiobooks"), false);
    assert.equal(navigationRoots(null, [library], false, true).find(root => root.key === "audiobooks")?.title, "Audiobooks (Beta)");
    const storage = new MemoryPublicStorage();
    const owner = new AudiobookPreference(storage, "owner");
    owner.set(true);
    assert.equal(new AudiobookPreference(storage, "owner").value, true);
    assert.equal(new AudiobookPreference(storage, "child").value, false);
    storage.failSet = true;
    owner.set(false);
    assert.equal(owner.value, true);
    assert.equal(owner.error, true);
});

const detail = { content_id: "book", type: "audiobook", title: "Book", user_data: { position_seconds: 140 }, versions: [
    { file_id: "b", presentation_part_index: 2, duration: 100, chapters: [{ index: 0, start_seconds: 0, end_seconds: 100 }] },
    { file_id: "a", presentation_part_index: 1, duration: 120, chapters: [{ index: 0, title: "Opening", start_seconds: 0, end_seconds: 120 }] },
] };
test("audiobook chapters stitch in part order and seek maps to local source time", () => {
    const book = decodeAudiobook(detail);
    assert.equal(book.duration, 220);
    assert.deepEqual(book.chapters.map(chapter => chapter.start), [0, 120]);
    assert.deepEqual(bookPosition(book, 140), { fileId: "b", startSeconds: 20, index: 1 });
    assert.deepEqual(bookPosition(book, 120), { fileId: "b", startSeconds: 0, index: 1 });
    assert.equal(book.position, 140);
});
test("Apple resume grace and end margin", () => {
    assert.equal(audiobookResume(30, 220), undefined);
    assert.equal(audiobookResume(31, 220), 31);
    assert.equal(audiobookResume(215, 220), undefined);
});
test("unknown durations use chapter edges and malformed external times fail", () => {
    assert.equal(decodeAudiobook({ ...detail, versions: [{ file_id: "a", chapters: [{ index: 0, start_seconds: 0, end_seconds: 90 }] }] }).duration, 90);
    assert.throws(() => decodeAudiobook({ ...detail, versions: [{ file_id: "a", duration: -2 }] }));
    assert.throws(() => decodeAudiobook({ ...detail, type: "movie" }));
    assert.throws(() => decodeGroups({ items: [], page: { next_cursor: 2 } }));
    assert.throws(() => decodeAudiobook({ ...detail, versions: [{ file_id: "1", codec_audio: "aac" }, { file_id: "2", duration: 100 }] }), /duration/);
    const unknown = decodeAudiobook({ ...detail, versions: [{ file_id: "1", codec_audio: "aac" }] });
    assert.equal(bookPosition(unknown, 45).startSeconds, 45);
});
