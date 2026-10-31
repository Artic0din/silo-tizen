import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../src/api/errors.ts";
import type { RequestSpec } from "../../src/api/http.ts";
import { decodeEpisodes, decodeSeasons, decodeWatchDetail } from "../../src/contracts/v2/catalog.ts";
import { nextEpisode } from "../../src/player/nextEpisode.ts";

const SERIES = "opaque/series+9";
const CURRENT = "unparseable-current";
const NEXT = "opaque-next+?/";
const seasonPath = (season: number): string => `/catalog/series/${encodeURIComponent(SERIES)}/seasons/${season}/episodes`;
const watchPath = (id: string): string => `/watch/${encodeURIComponent(id)}`;
const seasonsPath = `/catalog/series/${encodeURIComponent(SERIES)}/seasons`;

function row(id: string, season: number, number: number, files: unknown[] = [{ file_id: `file-${id}` }]): Record<string, unknown> {
    return { content_id: id, season_number: season, episode_number: number, title: id, runtime: 42, files };
}

function watch(id: string, season: number, number: number, fileId = `file-${id}`): Record<string, unknown> {
    return { content_id: id, type: "episode", title: `Title ${id}`, series_id: SERIES, season_number: season, episode_number: number, user_data: { played: false }, versions: [{ file_id: fileId, duration_seconds: 2500 }] };
}

function rig(season = 1, number = 1): { data: Map<string, unknown>; reads: string[]; read: <T>(spec: RequestSpec<T>) => Promise<T> } {
    const data = new Map<string, unknown>([
        [watchPath(CURRENT), watch(CURRENT, season, number, "effective")],
        [seasonsPath, { items: [{ content_id: "season-opaque", season_number: season, title: "Season", episode_count: 2 }] }],
        [seasonPath(season), { items: [row(NEXT, season, number + 1), row(CURRENT, season, number)] }],
        [watchPath(NEXT), watch(NEXT, season, number + 1)],
    ]);
    const reads: string[] = [];
    return { data, reads, async read<T>(spec: RequestSpec<T>): Promise<T> {
        const path = spec.path.split("?")[0] ?? "";
        reads.push(path);
        const body = data.get(path);
        if (body instanceof Error) throw body;
        assert.ok(body !== undefined, `unexpected read ${path}`);
        return spec.decode(body);
    } };
}

test("next playable episode uses explicit numeric order and a fresh allowed file, ignoring progress hints", async () => {
    const r = rig(1, 9);
    r.data.set(seasonPath(1), { items: [row("later", 1, 12), row(NEXT, 1, 10), row(CURRENT, 1, 9)] });
    r.data.set(watchPath(NEXT), watch(NEXT, 1, 10));
    const result = await nextEpisode(r.read, CURRENT, "effective");
    assert.deepEqual(result, { contentId: NEXT, fileId: `file-${NEXT}`, title: `Title ${NEXT}`, startSeconds: 0, episode: true });
    assert.equal(r.reads[r.reads.length - 1], watchPath(NEXT));
});

test("later regular seasons are sorted and successful empty or unreadable media are skipped", async () => {
    const r = rig();
    r.data.set(seasonsPath, { items: [10, 3, 2, 1, 0].map(n => ({ content_id: `s${n}`, season_number: n, title: "Season", episode_count: 10, is_specials: n === 0, play_content_id: "wrong-hint" })) });
    r.data.set(seasonPath(1), { items: [row(CURRENT, 1, 1), row("missing", 1, 2, []), row("unreadable", 1, 3, [{ file_id: "bad", unreadable: true }]), row("empty-watch", 1, 4)] });
    r.data.set(watchPath("empty-watch"), { ...watch("empty-watch", 1, 4), versions: [] });
    r.data.set(seasonPath(2), { items: [] });
    r.data.set(seasonPath(3), { items: [row(NEXT, 3, 1)] });
    r.data.set(watchPath(NEXT), watch(NEXT, 3, 1));
    assert.equal((await nextEpisode(r.read, CURRENT, "effective"))?.contentId, NEXT);
    assert.equal(r.reads.includes(watchPath("unreadable")), false);
    assert.equal(r.reads.includes(seasonPath(0)), false);
    assert.equal(r.reads.includes(seasonPath(10)), false);
});

test("an exhausted episode sequence has no cross-title fallback", async () => {
    const r = rig();
    r.data.set(seasonPath(1), { items: [row(CURRENT, 1, 1)] });
    assert.equal(await nextEpisode(r.read, CURRENT, "effective"), undefined);
});

test("explicit specials stay within their own season; a regular sequence never enters specials", async () => {
    for (const season of [0, 7]) {
        const r = rig(season);
        r.data.set(seasonsPath, { items: [{ content_id: "specials", season_number: season, title: "Specials", episode_count: 2, is_specials: true }, { content_id: "regular", season_number: season + 1, title: "Regular", episode_count: 3 }] });
        assert.equal((await nextEpisode(r.read, CURRENT, "effective"))?.contentId, NEXT);
        r.data.set(seasonPath(season), { items: [row(CURRENT, season, 1)] });
        assert.equal(await nextEpisode(r.read, CURRENT, "effective"), undefined);
        assert.equal(r.reads.includes(seasonPath(season + 1)), false);
    }
});

test("the effective edition's explicit multi-episode range skips every covered number", async () => {
    const r = rig();
    r.data.set(watchPath(CURRENT), { ...watch(CURRENT, 1, 1), versions: [{ file_id: "requested", duration_seconds: 2500 }, { file_id: "effective", duration_seconds: 5000, multi_episode_start: 1, multi_episode_end: 3 }] });
    r.data.set(seasonPath(1), { items: [row("covered3", 1, 3), row(NEXT, 1, 4), row(CURRENT, 1, 1), row("covered2", 1, 2)] });
    r.data.set(watchPath(NEXT), watch(NEXT, 1, 4));
    assert.equal((await nextEpisode(r.read, CURRENT, "effective"))?.contentId, NEXT);
    assert.equal(r.reads.some(path => path.includes("covered")), false);
});

test("watched successors are offered from zero; confirmed partial progress uses existing resume semantics", async () => {
    for (const [played, position, duration, expected] of [[true, 120, 2500, 0], [false, 120, 2500, 120], [false, 2496, 2500, 0], [false, 120, 0, 120], [false, 0, 2500, 0]] as const) {
        const r = rig();
        r.data.set(watchPath(NEXT), { ...watch(NEXT, 1, 2), user_data: { played, position_seconds: position }, versions: [{ file_id: `file-${NEXT}`, duration_seconds: duration }] });
        assert.equal((await nextEpisode(r.read, CURRENT, "effective"))?.startSeconds, expected);
    }
});

test("request and authorization failures are errors, including an inaccessible intervening season", async () => {
    for (const status of [403, 404, 500]) {
        const r = rig();
        r.data.set(seasonPath(1), new ApiError({ kind: "http", status, retryAfterSeconds: undefined }));
        await assert.rejects(nextEpisode(r.read, CURRENT, "effective"), error => error instanceof ApiError && error.status === status);
    }
});

test("missing current identity, effective edition or current episode row must recover", async () => {
    for (const change of ["id", "file", "row", "series", "type"]) {
        const r = rig();
        const current = watch(CURRENT, 1, 1, "effective");
        if (change === "id") current.content_id = "another";
        if (change === "file") current.versions = [];
        if (change === "series") delete current.series_id;
        if (change === "type") current.type = "unknown";
        if (change === "row") r.data.set(seasonPath(1), { items: [] });
        r.data.set(watchPath(CURRENT), current);
        await assert.rejects(nextEpisode(r.read, CURRENT, "effective"));
        assert.equal(r.reads.includes(watchPath(NEXT)), false);
    }
});

test("the schema permits absent progress; a successful watch read then offers explicit zero without a saved claim", async () => {
    const r = rig();
    const current = watch(CURRENT, 1, 1, "effective");
    const candidate = watch(NEXT, 1, 2);
    delete current.user_data;
    delete candidate.user_data;
    r.data.set(watchPath(CURRENT), current);
    r.data.set(watchPath(NEXT), candidate);
    assert.equal((await nextEpisode(r.read, CURRENT, "effective"))?.startSeconds, 0);
});

test("a fresh candidate must match the authorized row and expose a readable permitted version", async () => {
    for (const change of ["id", "series", "season", "episode", "file"]) {
        const r = rig();
        const candidate = watch(NEXT, 1, 2);
        if (change === "id") candidate.content_id = "restricted";
        if (change === "series") candidate.series_id = "another-series";
        if (change === "season") candidate.season_number = 2;
        if (change === "episode") candidate.episode_number = 99;
        if (change === "file") candidate.versions = [{ file_id: "not-permitted-in-row", duration_seconds: 2500 }];
        r.data.set(watchPath(NEXT), candidate);
        if (change === "file") assert.equal(await nextEpisode(r.read, CURRENT, "effective"), undefined);
        else await assert.rejects(nextEpisode(r.read, CURRENT, "effective"));
    }
});

test("consumed malformed members fail visibly; no guessed range aliases or duration units", () => {
    for (const versions of [[{ file_id: "f", duration_seconds: 10, multi_episode_start: 1 }], [{ file_id: "f", duration_seconds: 10, multi_episode_start: 3, multi_episode_end: 1 }], [{ file_id: "f", duration_seconds: -1 }], [{ file_id: "f", duration: 42 }]]) {
        assert.throws(() => decodeWatchDetail({ ...watch(CURRENT, 1, 1), versions }));
    }
    assert.throws(() => decodeEpisodes({ items: [row(CURRENT, 1, 1, [{ file_id: "f", unreadable: "true" }])] }));
    assert.throws(() => decodeSeasons({ items: [{ content_id: "s", season_number: 1, title: "S", episode_count: 1, is_specials: "false" }] }));
});
