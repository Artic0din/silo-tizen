import assert from "node:assert/strict";
import { test } from "node:test";
import type { RequestSpec } from "../../src/api/http.ts";
import { type Card, decodeMarqueeDetail } from "../../src/contracts/v2/catalog.ts";
import { FOR_YOU_PREWARM_CARDS, FOR_YOU_PREWARM_CONCURRENCY, FOR_YOU_PREWARM_ROWS, HomeEnrichment, MARQUEE_REST_MILLISECONDS, type HomeEnrichmentRow } from "../../src/ui/homeEnrichment.ts";
import { fixture } from "./support/fakeSilo.ts";
import { ManualClock, settle } from "./support/clock.ts";

function card(id: string, extra: Partial<Card> = {}): Card {
    return { id, type: "movie", title: id, year: undefined, posterUrl: undefined, seriesId: undefined, seriesTitle: undefined, seasonNumber: undefined, episodeNumber: undefined, ...extra };
}

/** Answers `/catalog/items/{id}` from the pinned detail fixture, one deferred reply per request. */
class DetailServer {
    readonly paths: string[] = [];
    inFlight = 0;
    maxInFlight = 0;
    details = new Map<string, Record<string, unknown>>();
    private readonly pending: (() => void)[] = [];
    readonly read = <T>(spec: RequestSpec<T>, signal: AbortSignal): Promise<T> => {
        this.paths.push(spec.path);
        const id = decodeURIComponent(/^\/catalog\/items\/([^?]+)/.exec(spec.path)?.[1] ?? "");
        this.inFlight++;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        return new Promise<T>((resolve, reject) => {
            const abort = (): void => {
                this.inFlight--;
                reject(new DOMException("aborted", "AbortError"));
            };
            if (signal.aborted) {
                abort();
                return;
            }
            signal.addEventListener("abort", abort, { once: true });
            this.pending.push(() => {
                if (signal.aborted) return;
                signal.removeEventListener("abort", abort);
                this.inFlight--;
                resolve(spec.decode({ ...fixture("get_catalog_item_ok"), content_id: id, ...this.details.get(id) }) as T);
            });
        });
    };
    /** Answers every request issued so far, then lets the owner issue the next ones. */
    async drain(): Promise<void> {
        while (this.pending.length > 0) {
            for (const answer of this.pending.splice(0)) answer();
            await settle();
        }
    }
    ids(): string[] { return this.paths.map(path => decodeURIComponent(/^\/catalog\/items\/([^?]+)/.exec(path)?.[1] ?? "")); }
}

function owner(server: DetailServer, landed: (id: string) => void = () => undefined, continuingSettled: () => void = () => undefined, clock = new ManualClock()): { enrichment: HomeEnrichment; clock: ManualClock } {
    return { enrichment: new HomeEnrichment(server.read, landed, continuingSettled, (fn, ms) => clock.schedule(fn, ms)), clock };
}

test("Home paints no item detail except Continue Watching, and a rested card reads once", async () => {
    const server = new DetailServer();
    const landed: string[] = [];
    let continuingSettled = 0;
    const { enrichment, clock } = owner(server, id => landed.push(id), () => { continuingSettled++; });
    const rows: HomeEnrichmentRow[] = [
        { cards: Array.from({ length: 9 }, (_, index) => card(`movie:m${index}`)), continuing: false },
        { cards: [card("movie:m2", { progressUpdatedAt: "2026-10-01T00:00:00.000Z" }), card("episode:e1", { type: "episode", progressUpdatedAt: "2026-10-02T00:00:00.000Z" })], continuing: true },
    ];
    enrichment.present(rows, false);
    await settle();
    assert.deepEqual(server.ids(), ["movie:m2", "episode:e1"], "only Continue Watching is read when the rows load");
    await server.drain();
    assert.equal(continuingSettled, 1);
    assert.deepEqual(landed, [], "those cards are not the focused marquee");

    enrichment.rest(card("movie:m0"), false);
    await clock.advance(MARQUEE_REST_MILLISECONDS - 1);
    assert.equal(server.paths.length, 2, "the rest delay has not elapsed");
    await clock.advance(1);
    assert.deepEqual(server.ids().slice(2), ["movie:m0"]);
    await server.drain();
    assert.equal(landed.at(-1), "movie:m0");

    enrichment.rest(card("movie:m0"), false);
    await clock.advance(MARQUEE_REST_MILLISECONDS);
    await server.drain();
    assert.equal(server.paths.length, 3, "a cached card is not read again");
});

test("fast focus changes send no request, and the card that rests sends one", async () => {
    const server = new DetailServer();
    const { enrichment, clock } = owner(server);
    for (const id of ["movie:a", "movie:b", "movie:c"]) {
        enrichment.rest(card(id), false);
        if (id !== "movie:c") await clock.advance(40);
    }
    assert.deepEqual(server.paths, []);
    await clock.advance(MARQUEE_REST_MILLISECONDS - 1);
    assert.deepEqual(server.paths, []);
    await clock.advance(1);
    assert.deepEqual(server.ids(), ["movie:c"]);
});

test("a stale detail answer cannot fill a newer focus", async () => {
    const server = new DetailServer();
    server.details.set("movie:a", { cast: [{ name: "First", character: "A", order: 0 }] });
    server.details.set("movie:b", { cast: [{ name: "Second", character: "B", order: 0 }] });
    const landed: string[] = [];
    const { enrichment, clock } = owner(server, id => landed.push(id));
    enrichment.rest(card("movie:a"), false);
    await clock.advance(MARQUEE_REST_MILLISECONDS);
    assert.deepEqual(server.ids(), ["movie:a"]);
    enrichment.rest(card("movie:b"), false);
    await clock.advance(MARQUEE_REST_MILLISECONDS);
    await server.drain();
    assert.deepEqual(server.ids(), ["movie:a", "movie:b"]);
    assert.deepEqual(landed, ["movie:b"]);
    assert.equal(enrichment.detailLine("movie:a"), undefined);
    assert.equal(enrichment.detailLine("movie:b"), "Second");
});

test("leaving before the answer drops it, and coming back reads the title again", async () => {
    const server = new DetailServer();
    const landed: string[] = [];
    const { enrichment, clock } = owner(server, id => landed.push(id));
    enrichment.present([{ cards: [card("movie:cw", { progressUpdatedAt: "r1" })], continuing: true }], false);
    enrichment.rest(card("movie:a"), false);
    await clock.advance(MARQUEE_REST_MILLISECONDS);
    await settle();
    enrichment.suspend();
    await server.drain();
    assert.deepEqual(landed, []);
    assert.equal(enrichment.detailLine("movie:a"), undefined);
    assert.equal(enrichment.savedFile(card("movie:cw", { progressUpdatedAt: "r1" })), undefined);

    enrichment.present([{ cards: [card("movie:cw", { progressUpdatedAt: "r1" })], continuing: true }], false);
    enrichment.rest(card("movie:a"), false);
    await clock.advance(MARQUEE_REST_MILLISECONDS);
    await server.drain();
    assert.deepEqual(server.ids(), ["movie:cw", "movie:a", "movie:cw", "movie:a"]);
    assert.deepEqual(landed, ["movie:a"]);
});

test("For You warms two rows of eight unrated cards, three at a time, and Home does not", async () => {
    const server = new DetailServer();
    const { enrichment } = owner(server);
    const bare = (id: string): Card => card(id);
    const row = (prefix: string, count: number): Card[] => Array.from({ length: count }, (_, index) => bare(`${prefix}${index}`));
    const rows: HomeEnrichmentRow[] = [
        { cards: [...row("a", FOR_YOU_PREWARM_CARDS), bare("movie:ninth"), card("movie:rated", { contentRating: " PG " })], continuing: false },
        { cards: [...row("b", FOR_YOU_PREWARM_CARDS), card("movie:blank", { contentRating: "   " })], continuing: false },
        { cards: row("c", FOR_YOU_PREWARM_CARDS), continuing: false },
    ];
    enrichment.present(rows, false);
    await server.drain();
    assert.deepEqual(server.paths, [], "Home does not warm ratings");

    enrichment.present(rows, true);
    await settle();
    assert.equal(server.paths.length, FOR_YOU_PREWARM_CONCURRENCY);
    assert.equal(server.maxInFlight, FOR_YOU_PREWARM_CONCURRENCY);
    await server.drain();
    const ids = server.ids();
    assert.equal(ids.length, FOR_YOU_PREWARM_ROWS * FOR_YOU_PREWARM_CARDS);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every(id => id.startsWith("a") || id.startsWith("b")));
    assert.equal(ids.includes("movie:ninth"), false);
    assert.equal(ids.includes("movie:rated"), false);
    assert.equal(ids.includes("movie:blank"), false, "the blank rating is past the eight-card window");
    assert.ok(ids.every(id => !id.startsWith("c")), "the third row waits");
});

test("a title first entering Continue Watching rereads the file chosen during playback", async () => {
    const server = new DetailServer();
    const id = "movie:m1";
    const file = (fileId: string, resolution: string) => ({ file_id: fileId, resolution, duration: 1200 });
    server.details.set(id, { user_data: { played: false, last_file_id: "old" }, versions: [file("old", "1080p"), file("new", "2160p")] });
    const { enrichment, clock } = owner(server);
    enrichment.rest(card(id), false);
    await clock.advance(MARQUEE_REST_MILLISECONDS);
    await server.drain();
    server.details.set(id, { user_data: { played: false, last_file_id: "new" }, versions: [file("old", "1080p"), file("new", "2160p")] });
    const returned = card(id, { progressUpdatedAt: "after-playback" });
    enrichment.present([{ cards: [returned], continuing: true }], false);
    await server.drain();
    assert.equal(server.paths.length, 2);
    assert.equal(enrichment.savedFile(returned)?.overlay.resolution, "2160p");
});

test("the marquee line is the aired date and the first three billed cast", async () => {
    const server = new DetailServer();
    server.details.set("episode:e1", { air_date: "2026-03-12", cast: [{ name: "Anna Torv", character: "Tess", order: 2 }, { name: "Pedro Pascal", character: "Joel", order: 0 }, { name: "Gabriel Luna", character: "Tommy", order: 3 }, { name: "Bella Ramsey", character: "Ellie", order: 1 }] });
    server.details.set("movie:m1", { cast: [] });
    const { enrichment, clock } = owner(server);
    enrichment.rest(card("episode:e1"), false);
    await clock.advance(MARQUEE_REST_MILLISECONDS);
    enrichment.rest(card("movie:m1"), false);
    await clock.advance(MARQUEE_REST_MILLISECONDS);
    await server.drain();
    assert.equal(enrichment.detailLine("episode:e1"), undefined, "moving on before the first answer cancels it");
    assert.equal(enrichment.detailLine("movie:m1"), undefined);
    enrichment.rest(card("episode:e1"), false);
    await clock.advance(MARQUEE_REST_MILLISECONDS);
    await server.drain();
    assert.equal(enrichment.detailLine("episode:e1"), "Aired Mar 12, 2026 · Pedro Pascal, Bella Ramsey, Anna Torv");
});

test("a 20-card Continue Watching row keeps 4 saved-file reads in flight, then completes and redraws every badge", async () => {
    const server = new DetailServer();
    let continuingSettled = 0;
    const { enrichment } = owner(server, () => undefined, () => { continuingSettled++; });
    const file = { file_id: "saved", resolution: "1080p", codec_video: "h264", codec_audio: "aac", hdr: false, container: "mp4", file_size: 1, duration: 60, bitrate: 1, added_at: "2026-01-01T00:00:00Z" };
    const cards = Array.from({ length: 20 }, (_, index) => {
        const id = `movie:cw${index}`;
        server.details.set(id, { user_data: { played: false, last_file_id: "saved" }, versions: [file] });
        return card(id, { progressUpdatedAt: "r1" });
    });
    enrichment.present([{ cards, continuing: true }], false);
    await settle();
    assert.equal(server.maxInFlight, 4);
    assert.equal(server.paths.length, 4);
    assert.equal(continuingSettled, 0);
    await server.drain();
    assert.equal(server.maxInFlight, 4);
    assert.equal(server.ids().length, 20);
    assert.equal(new Set(server.ids()).size, 20);
    assert.equal(continuingSettled, 1);
    for (const title of cards) assert.deepEqual(enrichment.savedFile(title)?.badges, ["1080p", "AAC"]);
});

test("suspend cancels Continue Watching reads that have not started", async () => {
    const server = new DetailServer();
    let continuingSettled = 0;
    const { enrichment } = owner(server, () => undefined, () => { continuingSettled++; });
    const cards = Array.from({ length: 20 }, (_, index) => card(`movie:cw${index}`, { progressUpdatedAt: "r1" }));
    enrichment.present([{ cards, continuing: true }], false);
    await settle();
    assert.equal(server.paths.length, 4);
    enrichment.suspend();
    await server.drain();
    await settle();
    assert.equal(server.paths.length, 4);
    assert.equal(continuingSettled, 0);
    assert.equal(enrichment.savedFile(cards[0] ?? card("x")), undefined);
});

test("Continue Watching shows the exact last-played file, never a guess", async () => {
    const server = new DetailServer();
    const file = (id: string, extra: Record<string, unknown>) => ({ file_id: id, resolution: "1080p", codec_video: "h264", codec_audio: "aac", hdr: false, container: "mp4", file_size: 1, duration: 60, bitrate: 1, added_at: "2026-01-01T00:00:00Z", ...extra });
    server.details.set("episode:e1", { user_data: { played: false, last_file_id: "uhd" }, versions: [file("hd", {}), file("uhd", { resolution: "2160p", codec_video: "hevc", hdr: true, container: "mkv", video_tracks: [{ dolby_vision: "dvhe.08.06", dv_config_present: true, dv_bl_compat_id_present: true, interlaced: false }], audio_tracks: [{ codec: "aac", channels: 2, default: false }, { codec: "eac3", channels: 6, layout: "5.1(side)", default: true }], effective_audio_track_index: 1, subtitle_tracks: [{}, {}] })] });
    server.details.set("movie:atmos", { user_data: { played: false, last_file_id: "a" }, versions: [file("a", { audio_tracks: [{ codec: "truehd", channels: 8, layout: "7.1 Atmos", default: true }] })] });
    server.details.set("movie:gone", { user_data: { played: false, last_file_id: "deleted" }, versions: [file("hd", {})] });
    server.details.set("movie:none", { user_data: { played: false }, versions: [file("hd", {})] });
    const { enrichment } = owner(server);
    const base = { resolution: "1080p", hdr: undefined, audio: "AAC", releaseType: "WEB-DL" };
    const titles = ["episode:e1", "movie:atmos", "movie:gone", "movie:none"].map(id => card(id, { progressUpdatedAt: "r1", overlay: base }));
    enrichment.present([{ cards: titles, continuing: true }], false);
    await server.drain();
    const saved = enrichment.savedFile(titles[0] ?? card("x"));
    assert.deepEqual(saved?.badges, ["4K", "DOLBY VISION", "EAC3 5.1"]);
    assert.deepEqual(saved?.overlay, { resolution: "2160p", hdr: "DV", audio: "EAC3", audioChannels: "5.1", videoCodec: "HEVC", container: "mkv", multiAudio: true, multiSub: true, releaseType: "WEB-DL" });
    assert.deepEqual(enrichment.savedFile(titles[1] ?? card("x"))?.badges, ["1080p", "ATMOS"]);
    assert.equal(enrichment.savedFile(titles[2] ?? card("x")), undefined, "a last file the item no longer has keeps the row's summary");
    assert.equal(enrichment.savedFile(titles[3] ?? card("x")), undefined, "no last file keeps the row's summary");
});

test("the marquee detail decoder takes the pinned item-detail fixture", () => {
    const detail = decodeMarqueeDetail(fixture("get_catalog_item_ok"));
    assert.equal(typeof detail.id, "string");
    assert.ok(detail.versions.every(file => typeof file.fileId === "string"));
});
