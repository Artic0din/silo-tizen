import assert from "node:assert/strict";
import { test } from "node:test";
import type { RequestSpec } from "../../src/api/http.ts";
import { type Card, decodeMarqueeDetail } from "../../src/contracts/v2/catalog.ts";
import { HOME_DETAIL_CONCURRENCY, HomeEnrichment, type HomeTitle } from "../../src/ui/homeEnrichment.ts";
import { fixture } from "./support/fakeSilo.ts";
import { settle } from "./support/clock.ts";

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
            signal.addEventListener("abort", () => { this.inFlight--; reject(new DOMException("aborted", "AbortError")); }, { once: true });
            this.pending.push(() => {
                if (signal.aborted) return;
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

test("Home detail reads each drawn title once, Continue Watching first, at most four at a time", async () => {
    const server = new DetailServer();
    const landed: string[] = [];
    let continuingSettled = 0;
    const owner = new HomeEnrichment(server.read, id => landed.push(id), () => { continuingSettled++; });
    const titles: HomeTitle[] = [
        ...Array.from({ length: 9 }, (_, index) => ({ card: card(`movie:m${index}`), continuing: false })),
        { card: card("movie:m3"), continuing: false },
        { card: card("movie:m2", { progressUpdatedAt: "2026-10-01T00:00:00.000Z" }), continuing: true },
        { card: card("episode:e1", { type: "episode", progressUpdatedAt: "2026-10-02T00:00:00.000Z" }), continuing: true },
    ];
    owner.load(titles);
    await settle();
    assert.equal(server.paths.length, HOME_DETAIL_CONCURRENCY, "only four start");
    await server.drain();
    assert.equal(server.maxInFlight, HOME_DETAIL_CONCURRENCY);
    assert.deepEqual(server.ids().slice(0, 2), ["movie:m2", "episode:e1"], "Continue Watching first");
    assert.equal(server.paths.length, 10, "ten distinct titles, ten reads");
    assert.equal(new Set(server.paths).size, 10);
    assert.ok(server.paths.every(path => path.endsWith("?image_size=large")), "the same request Details sends");
    assert.equal(landed.length, 10);
    assert.equal(continuingSettled, 1);

    owner.load(titles);
    await server.drain();
    assert.equal(server.paths.length, 10, "a Home reload reuses every answer");

    owner.load([...titles.slice(0, 9), { card: card("movie:m2", { progressUpdatedAt: "2026-10-03T00:00:00.000Z" }), continuing: true }, { card: card("movie:m5", { progressUpdatedAt: "x" }), continuing: true }]);
    await server.drain();
    assert.deepEqual(server.ids().slice(10), ["movie:m2", "movie:m5"], "changed progress and first entry into Continue Watching both reread the last-played file");
});

test("a title first entering Continue Watching rereads the file chosen during playback", async () => {
    const server = new DetailServer();
    const id = "movie:m1";
    const file = (fileId: string, resolution: string) => ({ file_id: fileId, resolution, duration: 1200 });
    server.details.set(id, { user_data: { played: false, last_file_id: "old" }, versions: [file("old", "1080p"), file("new", "2160p")] });
    const owner = new HomeEnrichment(server.read, () => undefined, () => undefined);
    owner.load([{ card: card(id), continuing: false }]);
    await server.drain();
    server.details.set(id, { user_data: { played: false, last_file_id: "new" }, versions: [file("old", "1080p"), file("new", "2160p")] });
    const returned = card(id, { progressUpdatedAt: "after-playback" });
    owner.load([{ card: returned, continuing: true }]);
    await server.drain();
    assert.equal(server.paths.length, 2);
    assert.equal(owner.savedFile(returned)?.overlay.resolution, "2160p");
});

test("a newer Home load or teardown drops unfinished reads without applying them", async () => {
    const server = new DetailServer();
    const landed: string[] = [];
    const owner = new HomeEnrichment(server.read, id => landed.push(id), () => undefined);
    owner.load(Array.from({ length: 6 }, (_, index) => ({ card: card(`movie:a${index}`), continuing: false })));
    await settle();
    owner.stop();
    await server.drain();
    assert.deepEqual(landed, []);
    assert.equal(server.inFlight, 0);
    assert.equal(owner.detailLine("movie:a0"), undefined);
});

test("the marquee line is the aired date and the first three billed cast", async () => {
    const server = new DetailServer();
    server.details.set("episode:e1", { air_date: "2026-03-12", cast: [{ name: "Anna Torv", character: "Tess", order: 2 }, { name: "Pedro Pascal", character: "Joel", order: 0 }, { name: "Gabriel Luna", character: "Tommy", order: 3 }, { name: "Bella Ramsey", character: "Ellie", order: 1 }] });
    server.details.set("movie:m1", { cast: [] });
    const owner = new HomeEnrichment(server.read, () => undefined, () => undefined);
    owner.load([{ card: card("episode:e1"), continuing: false }, { card: card("movie:m1"), continuing: false }]);
    await server.drain();
    assert.equal(owner.detailLine("episode:e1"), "Aired Mar 12, 2026 · Pedro Pascal, Bella Ramsey, Anna Torv");
    assert.equal(owner.detailLine("movie:m1"), undefined);
});

test("Continue Watching shows the exact last-played file, never a guess", async () => {
    const server = new DetailServer();
    const file = (id: string, extra: Record<string, unknown>) => ({ file_id: id, resolution: "1080p", codec_video: "h264", codec_audio: "aac", hdr: false, container: "mp4", file_size: 1, duration: 60, bitrate: 1, added_at: "2026-01-01T00:00:00Z", ...extra });
    server.details.set("episode:e1", { user_data: { played: false, last_file_id: "uhd" }, versions: [file("hd", {}), file("uhd", { resolution: "2160p", codec_video: "hevc", hdr: true, container: "mkv", video_tracks: [{ dolby_vision: "dvhe.08.06", dv_config_present: true, dv_bl_compat_id_present: true, interlaced: false }], audio_tracks: [{ codec: "aac", channels: 2, default: false }, { codec: "eac3", channels: 6, layout: "5.1(side)", default: true }], effective_audio_track_index: 1, subtitle_tracks: [{}, {}] })] });
    server.details.set("movie:atmos", { user_data: { played: false, last_file_id: "a" }, versions: [file("a", { audio_tracks: [{ codec: "truehd", channels: 8, layout: "7.1 Atmos", default: true }] })] });
    server.details.set("movie:gone", { user_data: { played: false, last_file_id: "deleted" }, versions: [file("hd", {})] });
    server.details.set("movie:none", { user_data: { played: false }, versions: [file("hd", {})] });
    const owner = new HomeEnrichment(server.read, () => undefined, () => undefined);
    const base = { resolution: "1080p", hdr: undefined, audio: "AAC", releaseType: "WEB-DL" };
    const titles = ["episode:e1", "movie:atmos", "movie:gone", "movie:none"].map(id => ({ card: card(id, { progressUpdatedAt: "r1", overlay: base }), continuing: true }));
    owner.load(titles);
    await server.drain();
    const saved = owner.savedFile(titles[0]?.card ?? card("x"));
    assert.deepEqual(saved?.badges, ["4K", "DOLBY VISION", "EAC3 5.1"]);
    assert.deepEqual(saved?.overlay, { resolution: "2160p", hdr: "DV", audio: "EAC3", audioChannels: "5.1", videoCodec: "HEVC", container: "mkv", multiAudio: true, multiSub: true, releaseType: "WEB-DL" });
    assert.deepEqual(owner.savedFile(titles[1]?.card ?? card("x"))?.badges, ["1080p", "ATMOS"]);
    assert.equal(owner.savedFile(titles[2]?.card ?? card("x")), undefined, "a last file the item no longer has keeps the row's summary");
    assert.equal(owner.savedFile(titles[3]?.card ?? card("x")), undefined, "no last file keeps the row's summary");
});

test("the marquee detail decoder takes the pinned item-detail fixture", () => {
    const detail = decodeMarqueeDetail(fixture("get_catalog_item_ok"));
    assert.equal(typeof detail.id, "string");
    assert.ok(detail.versions.every(file => typeof file.fileId === "string"));
});
