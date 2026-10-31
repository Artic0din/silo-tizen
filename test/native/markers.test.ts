import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMarkers, markerAt, type SkipMarker } from "../../src/contracts/v2/markers.ts";
import { operations } from "../../src/api/operations.ts";

test("segment window includes its start, excludes its end and uses source seconds", () => {
    const markers: readonly SkipMarker[] = [
        { kind: "recap", startSeconds: 0, endSeconds: 12.5 },
        { kind: "intro", startSeconds: 20, endSeconds: 60 },
        { kind: "credits", startSeconds: 900, endSeconds: 960 },
    ];
    for (const [seconds, index] of [[0, 0], [12.499, 0], [20, 1], [59.999, 1], [900, 2], [959.9, 2]] as const) {
        assert.equal(markerAt(markers, seconds), markers[index]);
    }
    for (const seconds of [-1, 12.5, 19.999, 60, 960, NaN, Infinity]) assert.equal(markerAt(markers, seconds), undefined);
    assert.equal(markerAt([], 20), undefined);
});

test("file marker read encodes the identity and decodes only supported published occurrences", () => {
    const spec = operations.fileMarkers("file/42");
    assert.equal(spec.path, "/markers/files/file%2F42");
    assert.equal(spec.method, "GET");
    const raw = { file_id: "file/42", marker_segments: [
        { kind: "intro", start_seconds: 20, end_seconds: 60 },
        { kind: "preview", start_seconds: 100, end_seconds: 120 },
        { kind: "recap", start_seconds: 200, end_seconds: 210 },
    ] };
    assert.deepEqual(spec.decode(raw), [
        { kind: "intro", startSeconds: 20, endSeconds: 60 },
        { kind: "recap", startSeconds: 200, endSeconds: 210 },
    ]);
    assert.throws(() => decodeMarkers(raw, "different-file"));
    for (const marker_segments of [null, [{ kind: "intro", start_seconds: -1, end_seconds: 5 }],
        [{ kind: "intro", start_seconds: 5, end_seconds: 5 }], [{ kind: "credits", start_seconds: 5, end_seconds: Infinity }],
        [{ kind: "recap", start_seconds: "0", end_seconds: 5 }]]) {
        assert.throws(() => decodeMarkers({ ...raw, marker_segments }, "file/42"));
    }
});
