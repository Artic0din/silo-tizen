// A shuffle's next pick after an item finishes (silo-apple 1a7ccee SiloAPI.advanceShuffle).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RequestSpec } from "../../src/api/http.ts";
import { nextShuffle } from "../../src/player/nextShuffle.ts";

const card = (id: string) => ({ id, type: "movie", title: id, year: undefined, posterUrl: undefined, seriesId: undefined, seriesTitle: undefined, seasonNumber: undefined, episodeNumber: undefined });

function reader(current: string, watch: { played: boolean; positionSeconds?: number; lastFileId?: string }, versions: unknown[] = [{ fileId: "f1", durationSeconds: 6000 }, { fileId: "f2", durationSeconds: 6000 }]) {
    const specs: RequestSpec<unknown>[] = [];
    const read = async <T>(spec: RequestSpec<T>): Promise<T> => {
        specs.push(spec);
        if (spec.path.startsWith("/shuffles/")) return { id: "sh1", current: card(current), next: card("movie:after") } as T;
        return { id: current, type: "movie", title: "Picked", versions, watch } as T;
    };
    return { read, specs };
}

test("finishing a shuffle's item advances it from that item and plays the new pick in the same shuffle", async () => {
    const { read, specs } = reader("movie:next", { played: false, positionSeconds: 600, lastFileId: "f2" });
    const next = await nextShuffle(read, "sh1", "movie:done");
    assert.deepEqual(specs[0]?.body, { from_content_id: "movie:done" });
    assert.equal(specs[0]?.path, "/shuffles/sh1/advance");
    assert.equal(specs[0]?.retry, "safe", "advance is naturally idempotent");
    assert.deepEqual(next, { contentId: "movie:next", fileId: "f2", title: "Picked", startSeconds: 600, shuffleId: "sh1" });
});

test("a shuffle that stays on the finished item has nothing further to play", async () => {
    const { read } = reader("movie:done", { played: true });
    assert.equal(await nextShuffle(read, "sh1", "movie:done"), undefined);
});

test("a shuffle pick ranks its files by the Resolution cap, ahead of the last-played file", async () => {
    const versions = [{ fileId: "uhd", durationSeconds: 6000, resolution: "2160p" }, { fileId: "fhd", durationSeconds: 6000, resolution: "1080p" }];
    const { read } = reader("movie:next", { played: false, lastFileId: "uhd" }, versions);
    assert.equal((await nextShuffle(read, "sh1", "movie:done", "1080p"))?.fileId, "fhd");
    assert.equal((await nextShuffle(read, "sh1", "movie:done"))?.fileId, "uhd", "no cap keeps the last-played file");
});
