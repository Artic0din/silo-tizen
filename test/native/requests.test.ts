import assert from "node:assert/strict";
import { test } from "node:test";
import { requestOperations as operations } from "../../src/api/requestOperations.ts";
import { decodeDiscover, decodeMyRequests, decodeRequestsCapability, decodeRequestTitle, decodeRequestPage } from "../../src/contracts/v2/requests.ts";
import { FakeRequests } from "./support/fakeRequests.ts";

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
