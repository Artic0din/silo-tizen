// A shuffle's next pick after an item finishes (silo-apple 1a7ccee SiloAPI.advanceShuffle).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RequestSpec } from "../../src/api/http.ts";
import { nextShuffle, shufflePick } from "../../src/player/nextShuffle.ts";

const card = (id: string) => ({ id, type: "movie", title: id, year: undefined, posterUrl: undefined, seriesId: undefined, seriesTitle: undefined, seasonNumber: undefined, episodeNumber: undefined });

function reader(current: string, watch: { played: boolean; positionSeconds?: number; lastFileId?: string }) {
    const specs: RequestSpec<unknown>[] = [];
    const read = async <T>(spec: RequestSpec<T>): Promise<T> => {
        specs.push(spec);
        if (spec.path.startsWith("/shuffles/")) return { id: "sh1", current: card(current), next: card("movie:after") } as T;
        return { id: current, type: "movie", title: "Picked", versions: [{ fileId: "f1", durationSeconds: 6000 }, { fileId: "f2", durationSeconds: 6000 }], watch } as T;
    };
    return { read, specs };
}

test("finishing a shuffle's item advances it from that item and plays the new pick from its beginning in the same shuffle", async () => {
    const { read, specs } = reader("movie:next", { played: false, positionSeconds: 600, lastFileId: "f2" });
    const next = await nextShuffle(read, "sh1", "movie:done");
    assert.deepEqual(specs[0]?.body, { from_content_id: "movie:done" });
    assert.equal(specs[0]?.path, "/shuffles/sh1/advance");
    assert.equal(specs[0]?.retry, "safe", "advance is naturally idempotent");
    assert.deepEqual(next, { contentId: "movie:next", fileId: "f2", title: "Picked", startSeconds: 0, shuffleId: "sh1" });
});

test("a shuffle that stays on the finished item has nothing further to play", async () => {
    const { read } = reader("movie:done", { played: true });
    assert.equal(await nextShuffle(read, "sh1", "movie:done"), undefined);
});

// Apple plays every shuffle pick from its beginning, at its first part (silo-apple 27cf4a2 PlayerViewModel.loadShufflePick).
test("a shuffle pick with saved progress starts at zero, never at the saved position", async () => {
    const { read } = reader("movie:next", { played: false, positionSeconds: 3000, lastFileId: "f1" });
    const shuffle = { id: "sh1", current: card("movie:next"), next: undefined };
    assert.equal((await shufflePick(read, shuffle as never))?.startSeconds, 0);
});

function partsReader(parts: readonly { fileId: string; group?: string; part?: number }[], lastFileId: string) {
    return async <T>(spec: RequestSpec<T>): Promise<T> => ({
        id: "movie:next", type: "movie", title: "Picked", watch: { played: false, positionSeconds: 900, lastFileId },
        versions: parts.map(part => ({ fileId: part.fileId, durationSeconds: 3000, presentationGroupKey: part.group, presentationPartIndex: part.part })),
    } as T);
}

test("a shuffle pick whose preferred file is a later part starts at the first part of that group", async () => {
    const read = partsReader([{ fileId: "cd1", group: "g", part: 1 }, { fileId: "cd2", group: "g", part: 2 }], "cd2");
    const pick = await shufflePick(read, { id: "sh1", current: card("movie:next"), next: undefined } as never);
    assert.equal(pick?.fileId, "cd1");
    assert.equal(pick?.startSeconds, 0);
});

test("a shuffle pick keeps its file when it is already the first part or not a part", async () => {
    const parted = partsReader([{ fileId: "cd1", group: "g", part: 1 }, { fileId: "cd2", group: "g", part: 2 }], "cd1");
    assert.equal((await shufflePick(parted, { id: "sh1", current: card("movie:next"), next: undefined } as never))?.fileId, "cd1");
    const plain = partsReader([{ fileId: "a" }, { fileId: "b" }], "b");
    assert.equal((await shufflePick(plain, { id: "sh1", current: card("movie:next"), next: undefined } as never))?.fileId, "b");
});

test("a shuffle pick with an empty group key is not part of a group", async () => {
    const read = partsReader([{ fileId: "cd1", group: "", part: 1 }, { fileId: "cd2", group: "", part: 2 }], "cd2");
    assert.equal((await shufflePick(read, { id: "sh1", current: card("movie:next"), next: undefined } as never))?.fileId, "cd2");
});
