import assert from "node:assert/strict";
import { test } from "node:test";
import { requestOperations } from "../../src/api/requestOperations.ts";
import { decodeMediaRequest, decodeRequestsCapability, decodeRequestTitle, type MediaRequest, type RequestsHub } from "../../src/contracts/v2/requests.ts";
import { canCancel, canRemove, focusAfterRemoval, isRemovable, neighborKey, REMOVE_CONFLICT_MESSAGE, REMOVED_NOTICE, RequestActionGate, REQUEST_NOTICE_MS, UNCONFIRMED_CANCEL_MESSAGE, UNCONFIRMED_REMOVE_MESSAGE } from "../../src/ui/requestRemoval.ts";
import { FakeRequests } from "./support/fakeRequests.ts";
import { fixture } from "./support/fakeSilo.ts";

function record(patch: Partial<MediaRequest> = {}): MediaRequest {
    return decodeMediaRequest({
        ...new FakeRequests().record,
        state: "failed",
        status: "approved",
        outcome: "failed",
        ...patch,
    });
}

test("remove_failed_supported is optional and only counts while requests are available", () => {
    assert.equal(decodeRequestsCapability(fixture("request_status_ok")).removeFailed, true);
    assert.equal(decodeRequestsCapability({ requests_enabled: true, allowed: true, state: "available", follow_supported: true }).removeFailed, false);
    assert.equal(decodeRequestsCapability({ requests_enabled: true, allowed: false, state: "available", follow_supported: true, remove_failed_supported: true }).removeFailed, false);
    assert.equal(decodeRequestsCapability({ requests_enabled: true, allowed: true, state: "disabled", follow_supported: true, remove_failed_supported: true }).removeFailed, false);
    assert.throws(() => decodeRequestsCapability({ requests_enabled: true, allowed: true, state: "available", follow_supported: true, remove_failed_supported: "true" }));
});

test("DELETE /requests/{id} percent-encodes the id and is never retried", () => {
    const spec = requestOperations.remove("a/b?c");
    assert.equal(spec.method, "DELETE");
    assert.equal(spec.path, "/requests/a%2Fb%3Fc");
    assert.equal(spec.retry, "never");
    assert.equal(spec.decode(undefined), undefined);
});

test("a failed request with nothing delivered can be removed", () => {
    assert.equal(isRemovable(record()), true);
    assert.equal(isRemovable(record({ targets: [] })), true);
    assert.equal(isRemovable(decodeMediaRequest({ ...new FakeRequests().record, state: "failed", status: "approved", outcome: "failed", targets: [{ quality: "1080p", status: "failed" }] })), true);
    assert.equal(isRemovable(decodeMediaRequest({ ...new FakeRequests().record, state: "failed", status: "approved", outcome: "failed", targets: [{ quality: "1080p", status: "completed" }, { quality: "2160p", status: "failed" }] })), false);
    for (const outcome of ["active", "declined", "cancelled"]) assert.equal(isRemovable(record({ outcome, state: outcome === "active" ? "pending" : outcome })), false);
    const failed = record();
    const pending = record({ id: "pending", state: "pending", status: "pending", outcome: "active" });
    assert.equal(canRemove(failed, true, undefined, []), true);
    assert.equal(canRemove(failed, false, undefined, []), false);
    assert.equal(canRemove(failed, true, "other", []), false);
    assert.equal(canRemove(failed, true, undefined, [failed.id]), false);
    assert.equal(canRemove(pending, true, undefined, []), false);
    assert.equal(canCancel(pending, undefined, []), true);
    assert.equal(canCancel(failed, undefined, []), false);
    assert.equal(canCancel(pending, "other", []), false);
    assert.equal(canCancel(pending, undefined, [pending.id]), false);
});

test("removal copy and the neighbor that receives focus match Apple TV", () => {
    assert.equal(REMOVED_NOTICE, "Request removed");
    assert.equal(UNCONFIRMED_REMOVE_MESSAGE, "We couldn't confirm the removal. Reopen My Requests to check it.");
    assert.equal(REMOVE_CONFLICT_MESSAGE, "This request changed since the list loaded, so it wasn't removed.");
    assert.equal(UNCONFIRMED_CANCEL_MESSAGE, "We couldn't confirm the cancellation. Reopen My Requests to check it.");
    assert.equal(REQUEST_NOTICE_MS, 3000);
    assert.equal(neighborKey(["a", "b", "c"], "a"), "b");
    assert.equal(neighborKey(["a", "b", "c"], "c"), "b");
    assert.equal(neighborKey(["a"], "a"), undefined);
    const title = decodeRequestTitle(new FakeRequests().title());
    const section = { key: "trending_movies", title: "Trending Movies", results: [title], page: 1, totalPages: 1, nextPage: 2 };
    const hub = (ids: string[]): RequestsHub => ({ sections: [section], mine: { items: ids.map(id => record({ id, title: id })), cursor: undefined } });
    assert.deepEqual(focusAfterRemoval(hub(["a", "b"]), "a"), { zone: "mine", key: "b" });
    assert.deepEqual(focusAfterRemoval(hub(["a", "b"]), "b"), { zone: "mine", key: "a" });
    assert.deepEqual(focusAfterRemoval(hub(["a"]), "a"), { zone: "row:trending_movies", key: "movie:949" });
    assert.deepEqual(focusAfterRemoval({ sections: [], mine: { items: [record({ id: "a" })], cursor: undefined } }, "a"), { zone: "page", key: "requests-page" });
    assert.deepEqual(focusAfterRemoval({ items: [record({ id: "a" }), record({ id: "b" })], cursor: undefined }, "a"), { zone: "mine", key: "b" });
    assert.deepEqual(focusAfterRemoval({ items: [record({ id: "a" })], cursor: undefined }, "a"), { zone: "actions", key: "refresh" });
});

test("one list action runs at a time, and a later read settles only the holds it covers", () => {
    const gate = new RequestActionGate();
    const first = gate.begin("a");
    assert.equal(typeof first, "number");
    assert.equal(gate.begin("b"), undefined);
    gate.release(first ?? 0);
    assert.equal(gate.actingId, undefined);
    const later = gate.begin("a");
    gate.release(first ?? 0);
    assert.equal(gate.actingId, "a");
    gate.release(later ?? 0);
    assert.equal(gate.actingId, undefined);
    gate.hold("a");
    const covered = gate.cover();
    gate.hold("b");
    gate.listMessage = UNCONFIRMED_REMOVE_MESSAGE;
    gate.releaseHolds(covered);
    assert.deepEqual(gate.heldIds(), ["b"]);
    assert.equal(gate.listMessage, UNCONFIRMED_REMOVE_MESSAGE);
    gate.releaseHolds(gate.cover());
    assert.deepEqual(gate.heldIds(), []);
    assert.equal(gate.listMessage, undefined);
    gate.listMessage = "Already requested";
    gate.hold("c");
    gate.releaseHolds(gate.cover());
    assert.equal(gate.listMessage, "Already requested");
    gate.drop("gone");
    assert.deepEqual(gate.filter([{ id: "gone" }, { id: "stay" }]).map(item => item.id), ["stay"]);
    assert.equal(gate.epoch, 1);
    gate.hold("held-a");
    gate.hold("held-b");
    gate.listMessage = UNCONFIRMED_CANCEL_MESSAGE;
    gate.releaseHold("held-a");
    assert.deepEqual(gate.heldIds(), ["held-b"]);
    assert.equal(gate.listMessage, UNCONFIRMED_CANCEL_MESSAGE);
    gate.releaseHold("held-b");
    assert.deepEqual(gate.heldIds(), []);
    assert.equal(gate.listMessage, undefined);
});
