import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./support/fakeSilo.ts";
import { discoveryOperations as api } from "../../src/api/discoveryOperations.ts";
import { decodeCatalogFilters, decodeCatalogLetters, decodeCatalogQueryPage, decodeCatalogSearchCapabilities, decodeLibraryCollections, decodeLibrarySection } from "../../src/contracts/v2/discovery.ts";
import { decodeHomeSections, decodeCatalogPage } from "../../src/contracts/v2/catalog.ts";
import { WireError } from "../../src/contracts/v2/wire.ts";
import { connected, signIn } from "./support/harness.ts";
import { ApiError } from "../../src/api/errors.ts";

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
    assert.equal(api.getLibraryCollectionItems("1", "c", { limit: 1 }).decode, decodeCatalogPage);
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
