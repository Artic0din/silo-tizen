import assert from "node:assert/strict";
import { test } from "node:test";
import { requestStateLabel } from "../../src/ui/requestStatus.ts";

test("every documented request state has a plain label", () => {
    const labels: Record<string, string> = {
        pending: "Pending",
        approved: "Approved",
        processing: "Processing",
        partially_available: "Partly available",
        available: "Available",
        declined: "Declined",
        cancelled: "Cancelled",
        failed: "Failed",
    };
    for (const [state, label] of Object.entries(labels)) assert.equal(requestStateLabel(state), label, state);
});

test("an unknown request state is shown as readable text", () => {
    assert.equal(requestStateLabel("on_hold"), "On hold");
    assert.equal(requestStateLabel("AWAITING_Review"), "Awaiting review");
    assert.equal(requestStateLabel(""), "");
});
