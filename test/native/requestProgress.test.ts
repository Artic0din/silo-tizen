import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMediaRequest, decodeRequestTitle } from "../../src/contracts/v2/requests.ts";
import { requestProgress } from "../../src/ui/requestProgress.ts";

test("request stage precedence and unknown labels never expose raw processing or object properties", () => {
    const title = (state: string | undefined, status: string | undefined, availability = "missing") => decodeRequestTitle({ media_type: "movie", tmdb_id: 949, title: "Heat", availability, request: { requestable: true, following: false, requested_by_viewer: false, state, status } });
    for (const [state, status, label, complete] of [
        ["processing", "queued", "Queued", 2], ["processing", "downloading", "Downloading", 2],
        ["processing", "completed", "Adding to library", 3], ["partially_available", "downloading", "Partly in library", 3],
        ["pending", "completed", "Pending", 1], ["available", "pending", "In library", 4],
        ["failed", "completed", "Failed", 2], ["cancelled", "downloading", "Unavailable", 0],
        ["constructor", "queued", "Queued", 2], ["__proto__", "queued", "Queued", 2],
    ] as const) {
        const progress = requestProgress(title(state, status));
        assert.equal(progress?.short, label); assert.equal(progress?.completed, complete);
    }
    assert.equal(requestProgress(title(undefined, undefined)), undefined);
    assert.equal(requestProgress(title("processing", "queued", "available"))?.short, "Queued");
    for (const state of ["pending", "failed", "declined", "partially_available", "cancelled"]) {
        assert.equal(requestProgress(title(state, "downloading", "available"))?.short, requestProgress(title(state, "downloading"))?.short);
    }
    assert.equal(requestProgress(title("new_state", "queued", "available"))?.short, "In library");
    assert.equal(requestProgress(title(undefined, "completed"))?.short, "In library");
    assert.equal(requestProgress(title(undefined, "new_stage"))?.short, "On the way");
    for (const [outcome, label] of [["declined", "Declined"], ["failed", "Failed"], ["cancelled", "Unavailable"]]) {
        const record = decodeMediaRequest({ id: "r1", media_type: "series", tmdb_id: 1, title: "Series", state: "new_state", status: "completed", outcome });
        assert.equal(requestProgress(record)?.short, label);
    }
});
