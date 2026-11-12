import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fixture } from "./support/fakeSilo.ts";
import { discoveryOperations as api } from "../../src/api/discoveryOperations.ts";
import { decodeCatalogFilters, decodeCatalogLetters, decodeCatalogQueryPage, decodeCatalogSearchCapabilities, decodeLibraryCollections, decodeLibrarySection } from "../../src/contracts/v2/discovery.ts";
import { decodeHomeSections, decodeCatalogPage, decodeCollectionItemsPage, type Card, type HomeSection } from "../../src/contracts/v2/catalog.ts";
import { inVideoScope, refillSection, refillSections } from "../../src/ui/libraryDiscovery.ts";
import { WireError } from "../../src/contracts/v2/wire.ts";
import { connected, signIn } from "./support/harness.ts";
import { ApiError } from "../../src/api/errors.ts";

test("collection items accept the server's paginated collection without totals", () => {
    const decode = api.getLibraryCollectionItems("12", "c1", { limit: 60 }).decode;
    // CatalogItemCollection + PageInfo at server 6d156247, returned by personal_collections_paging.go:146.
    const wire: unknown = JSON.parse(readFileSync(new URL("./fixtures/library-collection-items.json", import.meta.url), "utf8"));
    const page = decode(wire);
    assert.equal(page.total, undefined);
    assert.equal(page.totalExact, false);
    assert.equal(page.nextCursor, "next");
    assert.equal(page.items[0]?.title, "Heat");
    assert.throws(() => decode({ items: [], page: { has_more: true } }), WireError);
    assert.throws(() => decode({ items: [{ title: "broken" }], page: { has_more: false } }), WireError);
    assert.throws(() => decode({ items: [], total: "bad", page: { has_more: false } }), WireError);
});

test("personal-list API operations own opaque continuations and wire validation", () => {
    const card = { content_id: "movie:tied", type: "movie", title: "Tied" };
    for (const source of ["watchlist", "favorites"] as const) {
        const spec = api.listPersonalItems(source, { limit: 24, cursor: "opaque+/=" });
        assert.equal(spec.method, "GET");
        assert.equal(spec.path, `/${source}?limit=24&cursor=opaque%2B%2F%3D&image_size=small`);
        assert.equal(spec.retry, "safe");
        const page = spec.decode({ items: [card], page: { has_more: true, next_cursor: "next+/=" } });
        assert.equal(page.nextCursor, "next+/=");
        assert.deepEqual(page.items.map(item => item.id), ["movie:tied"]);
        assert.equal(page.totalExact, false);
        for (const invalid of [
            { items: {}, page: { has_more: false } },
            { items: [card] },
            { items: [card], page: { has_more: true, next_cursor: "" } },
            { items: [card], page: { has_more: true } },
        ]) assert.throws(() => spec.decode(invalid), WireError);
        for (const limit of [0, 201, 1.5, NaN]) assert.throws(() => api.listPersonalItems(source, { limit }), RangeError);
    }
});

test("discovery factories encode opaque paths and only contract-supported parameters", () => {
    assert.equal(api.listLibrarySections("lib/a ?").path, "/library/lib%2Fa%20%3F/sections?image_size=small");
    assert.equal(api.getLibrarySectionItems("a/b", "recent ?").path, "/library/a%2Fb/sections/recent%20%3F/items?image_size=small");
    assert.equal(api.getLibraryCollections("a/b").path, "/library/a%2Fb/collections");
    assert.equal(api.getLibraryCollectionItems("a/b", "c/d", { limit: 200, cursor: "opaque+/=" }).path,
        "/library/a%2Fb/collections/c%2Fd/items?limit=200&cursor=opaque%2B%2F%3D");
    assert.equal(api.getCatalogFilters({ library_id: "a/b", type: "movie", skip_technical: true }).path,
        "/catalog/filters?library_id=a%2Fb&type=movie&skip_technical=true");
    assert.equal(api.getCatalogSearchCapabilities().path, "/catalog/search/capabilities");
});

test("catalog queries carry an artwork query and keep the small fallback", () => {
    assert.equal(api.queryCatalogItems({ library_id: "12", limit: 1 }).path, "/catalog/query?image_size=small");
    assert.equal(api.queryCatalogItems({ library_id: "12", limit: 1 }, { image_size: "medium", backdrop_width: "1344" }).path, "/catalog/query?image_size=medium&backdrop_width=1344");
});

test("library section artwork slots preserve the unchanged small fallback", () => {
    assert.equal(api.listLibrarySections("12", { image_size: "medium", logo_width: "880", backdrop_width: "1344" }).path,
        "/library/12/sections?image_size=medium&logo_width=880&backdrop_width=1344");
    assert.equal(api.listLibrarySections("12").path, "/library/12/sections?image_size=small");
});

test("structured queries preserve scope, groups, cursor, prefix and server positions", () => {
    const body = { library_id: "opaque/1", type: "movie", limit: 100, cursor: "seed+/=", seek: 318,
        name_prefix: "H", sort: "title", order: "desc", match: "all",
        groups: [{ match: "any", rules: [{ field: "genre", op: "in", value: ["Crime", "Drama"] }] }] } as const;
    const spec = api.queryCatalogItems(body);
    assert.deepEqual(JSON.parse(JSON.stringify(spec.body)), body);
    assert.equal(spec.path, "/catalog/query?image_size=small");
    const letters = { library_id: "opaque/1", type: "movie", order: "desc", groups: body.groups } as const;
    assert.deepEqual(JSON.parse(JSON.stringify(api.queryCatalogLetters(letters).body)), letters);
    assert.deepEqual(api.queryCatalogItems({ library_id: "1", type: "movie", sort: "added_at", order: "desc" }).body,
        { library_id: "1", type: "movie", sort: "added_at", order: "desc" });
    for (const limit of [0, 101, 1.5, NaN]) assert.throws(() => api.queryCatalogItems({ type: "movie", limit }), RangeError);
    for (const limit of [0, 201]) assert.throws(() => api.getLibraryCollectionItems("1", "c", { limit }), RangeError);
    for (const seek of [-1, 10000001, 1.5]) assert.throws(() => api.queryCatalogItems({ type: "movie", seek }), RangeError);
});

test("all eight reads leave authentication to session.call and permit the existing safe retry", () => {
    const specs = [api.listLibrarySections("1"), api.getLibrarySectionItems("1", "r"), api.getLibraryCollections("1"),
        api.getLibraryCollectionItems("1", "c", { limit: 1 }), api.getCatalogFilters({ type: "movie" }),
        api.queryCatalogItems({ type: "movie" }), api.queryCatalogLetters({ type: "movie" }), api.getCatalogSearchCapabilities()];
    assert.deepEqual(specs.map(s => s.method), ["GET", "GET", "GET", "GET", "GET", "POST", "POST", "GET"]);
    for (const spec of specs) { assert.equal(spec.retry, "safe"); assert.equal(spec.bearer, undefined); assert.equal(spec.profile, undefined); }
    assert.equal(api.listLibrarySections("1").decode, decodeHomeSections);
    assert.equal(api.getLibraryCollectionItems("1", "c", { limit: 1 }).decode, decodeCollectionItemsPage);
});

test("public fixtures reuse catalog cards and preserve query window and effective order", () => {
    const raw = fixture("get_library_section_items_ok");
    assert.deepEqual(decodeLibrarySection(raw), decodeHomeSections({ sections: [raw] })[0]);
    const query = fixture("query_catalog_items_ok");
    assert.deepEqual(decodeCatalogQueryPage(query), { ...decodeCatalogPage(query), windowCursor: query.window_cursor,
        effectiveSort: { field: "title", order: "asc" } });
    assert.equal(api.listLibrarySections("1").decode(fixture("list_library_sections_ok"))[0]?.items[0]?.id, "movie:heat-1995");
});

test("facets decode structured technical data, tolerate additions and optional omission", () => {
    const raw = fixture("get_catalog_filters_ok");
    const result = decodeCatalogFilters({ ...raw, future: true });
    assert.deepEqual(result.genres, ["Crime"]);
    assert.deepEqual(result.technical, { resolutions: ["2160p"], audioLanguages: [], subtitleLanguages: ["en"] });
    delete raw.technical;
    assert.equal(decodeCatalogFilters(raw).technical, undefined);
    for (const value of [null, [7], "secret-value"]) assert.throws(() => decodeCatalogFilters({ ...raw, genres: value }), WireError);
});

test("letters keep discontiguous runs and positions without client alphabet sorting", () => {
    const raw = fixture("query_catalog_letters_ok");
    assert.deepEqual(decodeCatalogLetters({ ...raw, extra: 1 }), raw);
    assert.deepEqual(decodeCatalogLetters({ total: 0, letters: [], runs: [] }), { total: 0, letters: [], runs: [] });
    for (const position of [-1, 1.5, "secret-value"]) assert.throws(() => decodeCatalogLetters({ ...raw, runs: [{ letter: "H", position }] }), WireError);
});

test("malformed consumed optional members fail and opaque continuation survives unchanged", () => {
    const query = fixture("query_catalog_items_ok");
    const page = decodeCatalogQueryPage({ ...query, effective_sort: undefined,
        page: { has_more: true, next_cursor: "opaque+/= ?字" }, extra: "ignored" });
    assert.equal(page.nextCursor, "opaque+/= ?字");
    assert.equal(page.effectiveSort, undefined);
    assert.equal(decodeCatalogQueryPage({ ...query, effective_sort: { field: "future_sort", order: "future_order" } }).effectiveSort?.order, "unknown");
    for (const technical of [null, { resolutions: [], audio_languages: [], subtitle_languages: [7] }]) {
        assert.throws(() => decodeCatalogFilters({ ...fixture("get_catalog_filters_ok"), technical }), WireError);
    }
    const collection = { id: "opaque/字", title: "T", poster_url: "", item_count: 0, poster_is_collage: false,
        library_id: "opaque/1", library_ids: ["opaque/1"], group_id: null };
    for (const bad of [{ group_id: 7 }, { library_ids: [7] }, { poster_is_collage: null }, { item_count: -1 }, { poster_url: 7 }]) {
        assert.throws(() => decodeLibraryCollections({ library_id: "opaque/1", collections: [{ ...collection, ...bad }], groups: [] }), WireError);
    }
    assert.equal(decodeLibraryCollections({ library_id: "opaque/1", collections: [collection], groups: [], extra: true }).collections[0]?.id, "opaque/字");
    assert.throws(() => decodeLibrarySection({ id: "r", title: "R", items: [{ content_id: "m", type: "movie", title: 7 }] }), WireError);
});

test("collection tabs preserve full list, groups, nullable group and optional ungrouped", () => {
    const raw = fixture("get_library_collections_ok");
    const result = decodeLibraryCollections(raw);
    assert.equal(result.libraryId, "1");
    assert.equal(result.collections[0]?.id, "c1");
    assert.equal(result.collections[0]?.collectionType, "manual");
    assert.equal(result.ungrouped?.collections[0]?.collectionType, undefined);
    assert.equal(result.collections[0]?.groupId, null);
    assert.equal(result.groups[0]?.kind, "user_collections");
    assert.equal(result.ungrouped?.collections[0]?.itemCount, 12);
    assert.equal(decodeLibraryCollections({ ...raw, ungrouped: undefined }).ungrouped, undefined);
    assert.equal(decodeLibraryCollections({ ...raw, groups: [{ id: "g", name: "future", kind: "new_kind", sort_mode: "new_sort", sort_order: 0, collections: [] }] }).groups[0]?.kind, "unknown");
    assert.throws(() => decodeLibraryCollections({ ...raw, collections: [{ id: "secret-value", title: 1 }] }), WireError);
});

test("capabilities default absent optional flags to undefined and tolerate future enums", () => {
    assert.equal(decodeCatalogSearchCapabilities(fixture("get_catalog_search_capabilities_ok")).letterIndex, true);
    const minimal = { revision: "opaque", state: "future", allowed: false };
    assert.equal(decodeCatalogSearchCapabilities(minimal).state, "unknown");
    assert.equal(decodeCatalogSearchCapabilities(minimal).letterIndex, undefined);
    assert.equal(decodeCatalogSearchCapabilities({ ...minimal, provider: "future" }).provider, "unknown");
    for (const bad of [{ allowed: "secret-value" }, { letter_index: null }, { provider: 1 }]) {
        assert.throws(() => decodeCatalogSearchCapabilities({ ...minimal, ...bad }), error => error instanceof WireError && !error.message.includes("secret-value"));
    }
    assert.throws(() => decodeCatalogQueryPage({ ...fixture("query_catalog_items_ok"), window_cursor: 7 }), WireError);
    assert.throws(() => decodeCatalogQueryPage({ ...fixture("query_catalog_items_ok"), effective_sort: { field: "title", order: 7 } }), WireError);
});

test("episode-search capability consumes only a boolean and retains confirmed absence", () => {
    const base = fixture("get_catalog_search_capabilities_ok");
    assert.equal(decodeCatalogSearchCapabilities({ ...base, future: { flag: 7 } }).videoWithEpisodesScope, true);
    assert.equal(decodeCatalogSearchCapabilities({ ...base, video_with_episodes_scope: false }).videoWithEpisodesScope, false);
    delete base.video_with_episodes_scope;
    assert.equal(decodeCatalogSearchCapabilities(base).videoWithEpisodesScope, undefined);
    for (const value of [null, "true", 1, [], {}]) {
        assert.throws(() => decodeCatalogSearchCapabilities({ ...base, video_with_episodes_scope: value }), WireError);
    }
});

test("discovery POST reads carry session profile headers, retry identically and cancel on profile change", async () => {
    const h = await connected();
    await signIn(h);
    const profiles = await h.core.profiles.list();
    const owner = profiles.find(p => !p.hasPin);
    assert.ok(owner);
    h.core.profiles.select(owner);
    h.fake.extraRoutes.push((_method, path) => {
        if (path.startsWith("/catalog/query")) return { status: 200, body: fixture("query_catalog_items_ok") };
        if (path === "/catalog/letters") return { status: 200, body: fixture("query_catalog_letters_ok") };
        return undefined;
    });
    h.fake.dropNextAnswer("/catalog/query?image_size=small");
    const body = { library_id: "opaque/1", type: "movie", limit: 24, sort: "added_at", order: "desc" } as const;
    const pending = h.core.session.call({ ...api.queryCatalogItems(body), profileScoped: true });
    await h.clock.advance(1000);
    assert.equal((await pending).items.length, 3);
    const requests = h.fake.requests.filter(r => r.path.startsWith("/catalog/query"));
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0]?.body, body);
    assert.deepEqual(requests[1]?.body, body);
    assert.equal(requests[0]?.headers["x-profile-id"], owner.id);
    assert.ok(requests[0]?.headers.authorization?.startsWith("Bearer "));
    const hold = h.fake.hold("/catalog/letters");
    const canceled = assert.rejects(h.core.session.call({
        ...api.queryCatalogLetters({ library_id: "opaque/1", type: "movie", order: "asc" }),
        profileScoped: true,
    }), (error: unknown) => error instanceof ApiError && error.aborted);
    await h.clock.advance(0);
    h.core.profiles.clear();
    hold.release();
    await canceled;
});

// Ported from silo-apple 48a197d iosApp/Tests/LibraryVideoScopeTests.swift.
type ScopedPage = { items: Card[]; next: string | undefined; startsOver?: boolean };
const scopedCard = (id: string, type: string, progress = 0): Card => {
    const card = decodeHomeSections({ sections: [{ id: "x", section_type: "x", title: "x", items: [{ content_id: id, type, title: id, position_seconds: progress }] }] })[0]?.items[0];
    assert.ok(card);
    return card;
};
const scopedRow = (items: Card[], total: number, limit = 20, id = "recent"): HomeSection => ({ id, sectionType: "recently_added", title: "Recent", featured: false, itemLimit: limit, totalCount: total, isCustom: false, customized: false, items });

test("library sections decode the server's shelf limits and customization flags", () => {
    const [section] = decodeHomeSections(fixture("list_library_sections_ok"));
    assert.deepEqual({ itemLimit: section?.itemLimit, totalCount: section?.totalCount, isCustom: section?.isCustom, customized: section?.customized }, { itemLimit: 20, totalCount: 1, isCustom: false, customized: false });
});

test("a movie tab keeps only movies and a series tab keeps series and episodes", () => {
    assert.deepEqual(["movie", "series", "episode", "season", "audiobook"].map(type => inVideoScope("movie", scopedCard("a", type))), [true, false, false, false, false]);
    assert.deepEqual(["movie", "series", "episode", "season", "audiobook"].map(type => inVideoScope("series", scopedCard("a", type))), [false, true, true, false, false]);
});

test("a series shelf refills beyond a first page of movies and drops the unfiltered total", async () => {
    const film = scopedCard("film", "movie"), show = scopedCard("show", "series");
    const cursors: (string | undefined)[] = [];
    const result = await refillSection(scopedRow([film], 2, 1), "series", async cursor => { cursors.push(cursor); return cursor === undefined ? { items: [film], next: "1" } : { items: [show], next: undefined }; });
    assert.deepEqual(cursors, [undefined, "1"]);
    assert.deepEqual(result.section.items.map(item => item.id), ["show"]);
    assert.equal(result.incomplete, false);
    assert.equal(result.section.totalCount, undefined);
});

test("an inline total equal to the slice still pages, and the inline copy keeps its progress", async () => {
    const film = scopedCard("film", "movie"), episode = scopedCard("episode", "episode", 73);
    const result = await refillSection(scopedRow([film, episode], 2), "series", async () => ({ items: [film, scopedCard("episode", "episode"), scopedCard("older", "series")], next: undefined }));
    assert.deepEqual(result.section.items.map(item => item.id), ["episode", "older"]);
    assert.equal(result.section.items[0]?.positionSeconds, 73);
    assert.equal(result.incomplete, false);
});

test("a full scoped inline slice is not read again", async () => {
    const shows = [scopedCard("show0", "series"), scopedCard("show1", "series")];
    const result = await refillSection(scopedRow(shows, 50, 2), "series", async () => { throw new Error("no refill"); });
    assert.deepEqual(result.section.items.map(item => item.id), ["show0", "show1"]);
    assert.equal(result.incomplete, false);
});

test("a profile-customized shelf keeps its own items and is complete only when its window is", async () => {
    const film = scopedCard("film", "movie"), show = scopedCard("show", "series");
    for (const [customized, isCustom, total, incomplete] of [[true, false, 21, true], [false, true, 21, true], [true, false, 2, false], [false, true, 2, false]] as const) {
        const result = await refillSection({ ...scopedRow([film, show], total), customized, isCustom }, "series", async () => { throw new Error("no refill"); });
        assert.deepEqual(result.section.items.map(item => item.id), ["show"]);
        assert.equal(result.incomplete, incomplete);
    }
});

test("an empty page with a continuation keeps paging, and paging stops after eight reads", async () => {
    const film = scopedCard("film", "movie"), show = scopedCard("show", "series");
    const kept = await refillSection(scopedRow([film], 1), "series", async cursor => cursor === undefined ? { items: [], next: "1" } : { items: [show], next: undefined });
    assert.deepEqual(kept.section.items.map(item => item.id), ["show"]);
    let reads = 0;
    const bounded = await refillSection(scopedRow([film], 10000), "series", async () => { reads += 1; return { items: [film], next: String(reads) }; });
    assert.equal(reads, 8);
    assert.equal(bounded.incomplete, true);
    assert.deepEqual(bounded.section.items, []);
});

test("a restart then a failure does not bring back the old window", async () => {
    const removed = scopedCard("removed", "series"), current = scopedCard("retained", "episode", 90);
    const cursors: (string | undefined)[] = [];
    const result = await refillSection(scopedRow([removed, scopedCard("retained", "episode", 10), scopedCard("film", "movie")], 10), "series", async (cursor): Promise<ScopedPage> => {
        cursors.push(cursor);
        if (cursor === undefined) return { items: [removed], next: "1" };
        if (cursor === "1") return { items: [current], next: "2", startsOver: true };
        throw new Error("timed out");
    });
    assert.deepEqual(cursors, [undefined, "1", "2"]);
    assert.equal(result.incomplete, true);
    assert.deepEqual(result.section.items.map(item => [item.id, item.positionSeconds]), [["retained", 90]]);
});

test("a failed shelf keeps its inline titles and an aborted read is not a partial shelf", async () => {
    const film = scopedCard("film", "movie"), show = scopedCard("show", "series");
    const results = await refillSections([scopedRow([film, show], 3, 20, "failed"), scopedRow([film], 2, 20, "healthy")], "series", async row => {
        if (row.id === "failed") throw new Error("timed out");
        return { items: [show], next: undefined };
    });
    assert.deepEqual(results.map(result => [result.section.id, result.incomplete, result.section.items.map(item => item.id)]), [["failed", true, ["show"]], ["healthy", false, ["show"]]]);
    const aborted = new ApiError({ kind: "aborted" });
    await assert.rejects(refillSection(scopedRow([film], 2), "series", async () => { throw aborted; }), error => error === aborted);
});

test("shelves refill three at a time in layout order", async () => {
    const film = scopedCard("film", "movie"), show = scopedCard("show", "series");
    let active = 0, peak = 0;
    const rows = Array.from({ length: 6 }, (_, index) => scopedRow([film], 2, 1, String(index)));
    const results = await refillSections(rows, "series", async (_row, cursor) => {
        active += 1; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 1));
        active -= 1;
        return cursor === undefined ? { items: [film], next: "1" } : { items: [show], next: undefined };
    });
    assert.equal(peak, 3);
    assert.deepEqual(results.map(result => result.section.id), rows.map(row => row.id));
    assert.deepEqual(results.flatMap(result => result.section.items.map(item => item.id)), Array(6).fill("show"));
});
