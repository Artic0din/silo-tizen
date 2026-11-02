import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../src/api/errors.ts";
import type { Card, CatalogPage } from "../../src/contracts/v2/catalog.ts";
import { readSectionCatalog, sectionCountLabel } from "../../src/ui/sectionCatalogState.ts";

const card = (id: string): Card => ({ id, title: id, type: "movie", year: undefined, posterUrl: undefined, seriesId: undefined, seriesTitle: undefined, seasonNumber: undefined, episodeNumber: undefined });
const page = (ids: string[], nextCursor?: string, totalExact = false): CatalogPage => ({ items: ids.map(card), nextCursor, total: 99, totalExact });
const signal = (): AbortSignal => new AbortController().signal;

test("section count uses exact totals or the final unique loaded count", () => {
    assert.equal(sectionCountLabel(page(["a"], "next")), undefined);
    assert.equal(sectionCountLabel(page(["a"], "next", true)), "99 items");
    assert.equal(sectionCountLabel(page(["a"])), "1 item");
});

test("a filtered earlier page cannot regain an unfiltered exact total on append", async () => {
    const before = await readSectionCatalog(undefined, false, async () => page(["a", "b", "c", "d", "e", "f"], "second"), signal());
    const result = await readSectionCatalog(before, true, async () => page(["g"], undefined, true), signal());
    assert.equal(result.page.totalExact, false);
    assert.equal(sectionCountLabel(result.page), "7 items");
});

test("a section starts with 60 and reads thin pages until six cards arrive", async () => {
    const calls: (string | undefined)[] = [];
    const result = await readSectionCatalog(undefined, false, async (cursor, limit) => {
        calls.push(cursor);
        assert.equal(limit, 60);
        return cursor === undefined ? page(["a", "b"], "second") : page(["c", "d", "e", "f"], "third");
    }, signal());
    assert.deepEqual(calls, [undefined, "second"]);
    assert.equal(result.page.items.length, 6);
    assert.equal(result.page.nextCursor, "third");
});

test("duplicate-only pages cannot stall the load-more trigger", async () => {
    const before = await readSectionCatalog(undefined, false, async () => page(["a", "b", "c", "d", "e", "f"], "second"), signal());
    const calls: (string | undefined)[] = [];
    const result = await readSectionCatalog(before, true, async cursor => {
        calls.push(cursor);
        return cursor === "second" ? page(["a", "a"], "third") : page(["g", "g", "h"]);
    }, signal());
    assert.deepEqual(calls, ["second", "third"]);
    assert.deepEqual(result.page.items.map(item => item.id), ["a", "b", "c", "d", "e", "f", "g", "h"]);
    assert.equal(result.page.items[0], before.page.items[0]);
});

test("a repeated cursor fails without following a loop", async () => {
    let reads = 0;
    await assert.rejects(readSectionCatalog(undefined, false, async () => {
        reads++;
        return page([String(reads)], "repeat");
    }, signal()), error => error instanceof ApiError && error.failure.kind === "invalid_response");
    assert.equal(reads, 2);
});

test("an invalid cursor restarts once and replaces the old sequence", async () => {
    const before = await readSectionCatalog(undefined, false, async () => page(["a", "b", "c", "d", "e", "f"], "old"), signal());
    const calls: (string | undefined)[] = [];
    const result = await readSectionCatalog(before, true, async cursor => {
        calls.push(cursor);
        if (cursor === "old") throw new ApiError({ kind: "problem", problem: { id: "invalid_cursor", title: "Invalid cursor", status: 400, instance: "test", errors: [] }, retryAfterSeconds: undefined });
        return page(["replacement"]);
    }, signal());
    assert.deepEqual(calls, ["old", undefined]);
    assert.deepEqual(result.page.items.map(item => item.id), ["replacement"]);
    assert.deepEqual(before.page.items.map(item => item.id), ["a", "b", "c", "d", "e", "f"]);
});

test("refresh starts at the first cursor and restores loaded depth", async () => {
    const before = await readSectionCatalog(undefined, false, async () => page(["a", "b", "c", "d", "e", "f"]), signal());
    const calls: (string | undefined)[] = [];
    const result = await readSectionCatalog(before, false, async cursor => {
        calls.push(cursor);
        return cursor === undefined ? page(["g", "h"], "next") : page(["i", "j", "k", "l"]);
    }, signal());
    assert.deepEqual(calls, [undefined, "next"]);
    assert.equal(result.page.items.length, before.page.items.length);
});

test("invalid-cursor recovery cannot restart indefinitely", async () => {
    let reads = 0;
    await assert.rejects(readSectionCatalog(undefined, false, async () => {
        reads++;
        throw new ApiError({ kind: "problem", problem: { id: "invalid_cursor", title: "Invalid cursor", status: 400, instance: "test", errors: [] }, retryAfterSeconds: undefined });
    }, signal()), error => error instanceof ApiError && error.failure.kind === "invalid_response");
    assert.equal(reads, 2);
});

test("a later-page failure leaves the previous snapshot unchanged", async () => {
    const before = await readSectionCatalog(undefined, false, async () => page(["a", "b", "c", "d", "e", "f"], "second"), signal());
    await assert.rejects(readSectionCatalog(before, true, async cursor => {
        if (cursor === "second") return page(["g"], "third");
        throw new ApiError({ kind: "network" });
    }, signal()));
    assert.equal(before.page.items.length, 6);
    assert.equal(before.page.items[0]?.id, "a");
});

test("a removed row is distinct from a valid empty row", async () => {
    const removed = await readSectionCatalog(undefined, false, async () => { throw new ApiError({ kind: "http", status: 404, retryAfterSeconds: undefined }); }, signal());
    const empty = await readSectionCatalog(undefined, false, async () => page([]), signal());
    assert.equal(removed.unavailable, true);
    assert.equal(empty.unavailable, false);
});

test("a removed row during append leaves the loaded snapshot usable", async () => {
    const before = await readSectionCatalog(undefined, false, async () => page(["a", "b", "c", "d", "e", "f"], "second"), signal());
    await assert.rejects(readSectionCatalog(before, true, async () => {
        throw new ApiError({ kind: "http", status: 404, retryAfterSeconds: undefined });
    }, signal()), error => error instanceof ApiError && error.status === 404);
    assert.equal(before.page.items.length, 6);
    assert.equal(before.unavailable, false);
});

test("cancellation prevents the following thin-page request", async () => {
    const controller = new AbortController();
    let reads = 0;
    await assert.rejects(readSectionCatalog(undefined, false, async () => {
        reads++;
        controller.abort();
        return page(["a"], "second");
    }, controller.signal), error => error instanceof ApiError && error.aborted);
    assert.equal(reads, 1);
});
