import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeCatalogPage } from "../../src/contracts/v2/catalog.ts";
import { decodeCatalogQueryPage } from "../../src/contracts/v2/discovery.ts";
import { WireError } from "../../src/contracts/v2/wire.ts";
import { detailOperations } from "../../src/api/detailOperations.ts";
import { operations } from "../../src/api/operations.ts";
import { personQuery } from "../../src/ui/personFilmography.ts";
import { decodePerson } from "../../src/contracts/v2/details.ts";
import { FakeDetails } from "./support/fakeDetails.ts";
import { connected, signIn } from "./support/harness.ts";
import { ApiError } from "../../src/api/errors.ts";

test("catalog continuation: has_more requires a nonempty cursor at the shared wire boundary", () => {
    for (const decode of [decodeCatalogPage, decodeCatalogQueryPage]) {
        for (const next_cursor of [undefined, "", 42, null]) {
            assert.throws(() => decode({ items: [], total: 61, total_exact: true, window_cursor: "opaque", page: { has_more: true, next_cursor } }), WireError);
        }
        assert.equal(decode({ items: [], total: 0, total_exact: true, window_cursor: "opaque" }).nextCursor, undefined, "bounded collections can omit page");
        assert.equal(decode({ items: [], total: 0, total_exact: true, window_cursor: "opaque", page: { has_more: false } }).nextCursor, undefined);
    }
});

test("person query is a scoped safe POST; GET preview aligns year-desc without sharing its continuation", () => {
    const id = "person/a";
    const request = operations.queryCatalogItems(personQuery(id, "video", "opaque/+=="));
    assert.deepEqual(request.body, { source: "person", person_id: id, type: "video", sort: "year", order: "desc", limit: 24, cursor: "opaque/+==" });
    assert.equal(request.method, "POST");
    assert.equal(request.retry, "safe");
    assert.equal(request.path, "/catalog/query?image_size=small");
    const preview = new URL(detailOperations.filmography(id).path, "https://example.test");
    assert.equal(preview.searchParams.get("sort"), "-year");
    assert.equal(preview.searchParams.get("person_id"), id, "escaping proof only, not pinned server ID acceptance");
    assert.equal(personQuery("7", "series").type, "series");
    assert.equal(personQuery("7", "movie").type, "movie");
});

test("coherent person fake filters before paging, binds continuations, and preserves content identity", () => {
    const catalog = new FakeDetails();
    catalog.add({ id: "movie:copy/+", type: "movie", title: "Movie 0002", libraryId: "13", year: 2024 });
    catalog.personCredits.get("7")?.push("movie:copy/+", "movie:m0002", "movie:copy/+");
    catalog.personLibraryIds.set("movie:m0002", ["12", "13", "15"]);
    const page = (type: "video" | "movie" | "series", cursor?: string, profile = "p-owner") => {
        const reply = catalog.route("POST", "/catalog/query?image_size=small", profile, { ...personQuery("7", type, cursor) });
        assert.ok(reply);
        assert.equal(reply.status, 200);
        return decodeCatalogQueryPage(reply.body);
    };
    const first = page("video");
    const second = page("video", first.nextCursor);
    const third = page("video", second.nextCursor);
    const items = [...first.items, ...second.items, ...third.items];
    assert.equal(items.length, 64);
    assert.equal(new Set(items.map(item => item.id)).size, 64, "multiple credits and accessible libraries do not duplicate a content id");
    assert.equal(items.filter(item => item.title === "Movie 0002").length, 2, "equal title names with different IDs remain distinct");
    assert.equal(items.filter(item => item.id === "movie:m0002").length, 1, "one authoritative card across visible and hidden library memberships");
    assert.equal(items.some(item => item.id === "movie:archived"), false, "hidden library is excluded before paging");
    assert.ok(items.every((item, index) => index === 0 || (items[index - 1]?.year ?? 0) >= (item.year ?? 0)));
    assert.equal(page("series").items.length, 3);
    assert.equal(catalog.route("POST", "/catalog/query", "p-owner", { ...personQuery("7", "series", first.nextCursor) })?.status, 400);
    const preview = catalog.route("GET", detailOperations.filmography("7").path, "p-owner");
    assert.equal(preview?.status, 200);
    const previewPage = decodeCatalogPage(preview?.body);
    assert.deepEqual(previewPage.items, first.items);
    assert.equal(catalog.route("POST", "/catalog/query", "p-owner", { ...personQuery("7", "video", previewPage.nextCursor) })?.status, 400);
    catalog.matureTitles.add("movie:k1");
    assert.deepEqual(page("video", undefined, "p-kid").items.map(item => item.id).sort(), ["movie:k2", "movie:k3", "movie:k4", "movie:k5", "movie:k6", "movie:k7", "movie:k8"]);
    assert.equal(catalog.route("POST", "/catalog/query", "p-kid", { ...personQuery("7", "video", first.nextCursor) })?.status, 400);
    assert.equal(catalog.route("GET", "/catalog/people/8", "p-owner")?.status, 404);
    const empty = catalog.route("POST", "/catalog/query", "p-owner", { ...personQuery("8", "video") });
    assert.equal(empty?.status, 200);
    assert.equal(decodeCatalogPage(empty?.body).items.length, 0, "empty membership is not missing metadata");
});

test("person optional consumed facts are strict, unknown metadata remains compatible", () => {
    const person = { id: "7", name: "<script>synthetic</script>", future_field: { nested: true }, homepage: 7 };
    assert.equal(decodePerson(person).name, person.name);
    for (const field of ["bio", "photo_url", "birth_date", "death_date", "birthplace"]) assert.throws(() => decodePerson({ ...person, [field]: 7 }), WireError);
    assert.throws(() => decodePerson({ id: "7" }), WireError);
});

test("person POST obeys real session PIN proof, read retry, and authority cancellation", async () => {
    const h = await connected();
    await signIn(h);
    const catalog = new FakeDetails();
    h.fake.catalog = catalog;
    const kid = (await h.core.profiles.list()).find(profile => profile.id === "p-kid");
    assert.ok(kid);
    h.core.profiles.select(kid);
    assert.deepEqual(await h.core.profiles.verifyPin(kid.id, "2468"), { status: "verified" });
    h.fake.dropNextAnswer("/catalog/query?image_size=small");
    const pending = h.core.session.call({ ...operations.queryCatalogItems(personQuery("7", "video")), profileScoped: true });
    await h.clock.advance(1000);
    assert.equal((await pending).items.length, 8);
    const requests = h.fake.requests.filter(request => request.path.startsWith("/catalog/query"));
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0]?.body, requests[1]?.body);
    assert.equal(requests[0]?.headers["x-profile-id"], kid.id);
    assert.ok(requests[0]?.headers["x-profile-token"]);
    const held = h.fake.hold("/catalog/query", true);
    const abandoned = assert.rejects(h.core.session.call({ ...operations.queryCatalogItems(personQuery("7", "movie")), profileScoped: true }), (error: unknown) => error instanceof ApiError && error.aborted);
    await h.clock.advance(0);
    h.core.profiles.clear();
    held.release();
    await abandoned;
    h.core.profiles.select(kid);
    await h.core.profiles.verifyPin(kid.id, "2468");
    h.fake.changePin(kid.id, "1357");
    await assert.rejects(h.core.session.call({ ...operations.queryCatalogItems(personQuery("7", "video")), profileScoped: true }), (error: unknown) => error instanceof ApiError && error.problemId === "profile_verification_required");
    assert.equal(h.core.session.activeProfile, undefined, "revoked PIN ends browse authority");
});
