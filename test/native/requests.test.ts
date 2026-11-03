import assert from "node:assert/strict";
import { test } from "node:test";
import { requestOperations as operations } from "../../src/api/requestOperations.ts";
import { decodeDiscover, decodeMediaRequest, decodeMyRequests, decodeRequestsCapability, decodeRequestTitle, decodeRequestPage } from "../../src/contracts/v2/requests.ts";
import { FakeRequests } from "./support/fakeRequests.ts";
import { artworkUrl, requestPosterUrl } from "../../src/ui/browseModel.ts";

test("Request posters resolve TMDB paths before normal image admission", () => {
    assert.equal(requestPosterUrl("/poster.jpg"), "https://image.tmdb.org/t/p/w342/poster.jpg");
    assert.equal(requestPosterUrl("https://images.example.test/poster.jpg"), "https://images.example.test/poster.jpg");
    for (const path of [undefined, "", "poster.jpg", "//images.example.test/poster.jpg", "javascript:alert(1)", "data:image/png;base64,AAAA"]) assert.equal(requestPosterUrl(path), undefined);
    assert.equal(artworkUrl(requestPosterUrl("http://images.example.test/poster.jpg"), "https://silo.example.test"), undefined);
    assert.equal(artworkUrl(requestPosterUrl("/poster.jpg"), "https://silo.example.test/prefix"), "https://image.tmdb.org/t/p/w342/poster.jpg");
});

test("Requests retains optional TMDB artwork on result, detail and record reads", () => {
    const fake = new FakeRequests();
    for (const title of [decodeRequestTitle({ ...fake.title(), poster_path: "/poster.jpg", backdrop_path: "/backdrop.jpg" }), decodeMediaRequest({ ...fake.record, poster_path: "/poster.jpg", backdrop_path: "/backdrop.jpg" })]) {
        assert.equal(title.posterPath, "/poster.jpg");
        assert.equal(title.backdropPath, "/backdrop.jpg");
    }
    assert.equal(decodeRequestTitle(fake.title()).posterPath, undefined);
    assert.throws(() => decodeRequestTitle({ ...fake.title(), poster_path: 42 }));
});

test("Requests contract consumes capability, ordered discovery, detail and cursor pages", () => {
    const fake = new FakeRequests();
    const title = decodeRequestTitle(fake.title());
    assert.equal(title.tmdbId, 949);
    assert.equal(decodeRequestsCapability({ requests_enabled: true, allowed: false, state: "available", follow_supported: true }).enabled, false);
    assert.equal(decodeRequestsCapability({ requests_enabled: false, allowed: true, state: "disabled", follow_supported: true }).enabled, false);
    assert.throws(() => decodeRequestsCapability({ requests_enabled: true }));
    assert.throws(() => decodeRequestTitle({ ...fake.title(), tmdb_id: -1 }));
    assert.throws(() => decodeMyRequests({ items: [], page: { has_more: true } }));
    assert.equal(decodeMyRequests({ items: [], page: { has_more: true, next_cursor: "opaque/+" } }).cursor, "opaque/+");
    const section = { key: "custom", title: "Custom", page: 1, total_pages: 9, next_page: 4, results: [fake.title()] };
    assert.equal(decodeRequestPage(section).nextPage, 4);
    assert.deepEqual(decodeDiscover({ items: [section], row_order: [{ key: "future", type: "future" }, { key: "custom", type: "tmdb_list" }] }).map(row => row.key), ["custom"]);
});
test("Requests writes have no automatic transport replay; paths and bodies match native API", () => {
    const title = decodeRequestTitle(new FakeRequests().title());
    for (const spec of [operations.create(title), operations.cancel("opaque/id"), operations.follow(title, true), operations.follow(title, false)]) assert.equal(spec.retry, "never");
    assert.deepEqual(operations.create(title).body, { media_type: "movie", tmdb_id: 949, title: "Heat" });
    assert.equal(operations.cancel("opaque/id").path, "/requests/opaque%2Fid/cancel");
    assert.equal(operations.follow(title, true).method, "PUT");
    assert.equal(operations.follow(title, false).method, "DELETE");
    assert.equal(operations.mine("opaque/+").path, "/requests/mine?limit=24&cursor=opaque%2F%2B");
    assert.equal(operations.search("Heat & ice", 2).path, "/requests/search?q=Heat%20%26%20ice&media_type=all&page=2");
});
