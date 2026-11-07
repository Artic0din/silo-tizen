import assert from "node:assert/strict";
import { test } from "node:test";
import { pairedProfileDescription, pairedProfileLabel, profileSelectionCaption } from "../../src/ui/pairedProfile.ts";

test("paired profile uses Apple's values for the profile this TV reopens", () => {
    assert.equal(pairedProfileLabel(undefined, "p-owner", "Laura"), "Not paired");
    assert.equal(pairedProfileLabel("p-saved", "p-owner", "Laura"), "Saved profile");
    assert.equal(pairedProfileLabel("p-owner", undefined, "Laura"), "Saved profile");
    assert.equal(pairedProfileLabel("p-owner", "p-owner", "Laura"), "Laura");
});

test("Profile Selection caption follows each tvOS launch behavior", () => {
    assert.equal(profileSelectionCaption("automatic"), "Use the profile selected for the current TV user. A protected profile can reopen without asking for its PIN.");
    assert.equal(profileSelectionCaption("askEveryLaunch"), "Show Who's Watching whenever you return to Silo.");
    assert.equal(profileSelectionCaption("afterOneHour"), "Show Who's Watching when you've been away from Silo for 1 hour.");
    assert.equal(profileSelectionCaption("afterTwelveHours"), "Show Who's Watching when you've been away from Silo for 12 hours.");
});

test("paired profile describes this TV and adds Apple's Ask Every Time sentence only then", () => {
    assert.equal(pairedProfileDescription(false), "This TV user context is not set to keep separate app preferences. Silo uses the profile pairing available to the current app context, and you can change it here at any time.");
    assert.equal(pairedProfileDescription(true), "This TV user context is not set to keep separate app preferences. Silo uses the profile pairing available to the current app context, and you can change it here at any time. Ask Every Time is on, so Silo will still show Who's Watching at launch.");
});
