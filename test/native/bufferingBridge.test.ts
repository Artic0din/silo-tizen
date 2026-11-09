// The bridge between the player and silo-apple's buffering controller: what a deferred replan and a
// queue of notices do while the player's own state moves under them.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlaybackPlan } from "../../src/contracts/v2/playback.ts";
import { BufferingBridge, NOTICE_MS, type BufferingHost } from "../../src/player/bufferingBridge.ts";
import { COPY, type ReplanRequest } from "../../src/player/bufferingQuality.ts";
import type { BufferingSnapshot } from "../../src/player/bufferingSignals.ts";
import { ManualClock } from "./support/clock.ts";

const PLAYING: BufferingSnapshot = {
    hasActiveLoad: true, wantsToPlay: true, started: true, buffering: false, seekInFlight: false, reloadInProgress: false,
    reachedEnd: false, playheadMs: 1000, suspended: false, connectionTrouble: false,
};

function plan(planId: string, kbps = 8000): PlaybackPlan {
    return {
        planId,
        recipe: { bitrateKbps: kbps },
        sourceBitrateKbps: 8000,
        activeQuality: undefined,
        availableQualities: [
            { label: "original", preservesSource: true },
            { label: "1080p-medium", bitrateKbps: 6000, preservesSource: false },
            { label: "720p", bitrateKbps: 3000, preservesSource: false },
        ],
        warnings: [],
    } as unknown as PlaybackPlan;
}

interface Rig {
    readonly clock: ManualClock;
    readonly bridge: BufferingBridge;
    readonly issued: { request: ReplanRequest; restore: boolean }[];
    /** What the player screen would draw at each `changed()`. */
    readonly drawnNotices: (string | undefined)[];
}

function rig(): Rig {
    const clock = new ManualClock();
    const issued: Rig["issued"] = [];
    const drawnNotices: Rig["drawnNotices"] = [];
    const host: BufferingHost = {
        issueReplan: (request, restore) => {
            issued.push({ request, restore });
            return true;
        },
        changed: () => drawnNotices.push(bridge.notice?.text),
    };
    const bridge = new BufferingBridge(clock, host);
    bridge.mode = "ask";
    return { clock, bridge, issued, drawnNotices };
}

/** Plays past the startup grace and stalls for the long-stall limit, so the prompt is up. */
async function promptUp(r: Rig): Promise<void> {
    r.bridge.planAdopted(plan("p1"), [], "auto", false);
    r.bridge.sync(PLAYING);
    await r.clock.advance(11_000);
    r.bridge.sync({ ...PLAYING, buffering: true });
    await r.clock.advance(6000);
    assert.equal(r.bridge.pill?.kind, "prompt");
}

test("a deferred Lower quality is dropped when another plan takes over before it runs", async () => {
    const r = rig();
    await promptUp(r);
    r.bridge.selectPrimary();
    r.bridge.planAdopted(plan("p2"), [], "auto", false);
    await r.clock.advance(0);
    assert.deepEqual(r.issued, []);
    assert.equal(r.bridge.pill, undefined, "nothing waits on a replan that was never sent");
});

test("a deferred Lower quality is dropped when the plan ends or the attempt restarts before it runs", async () => {
    for (const supersede of ["planEnded", "newAttempt", "pickSent"] as const) {
        const r = rig();
        await promptUp(r);
        r.bridge.selectPrimary();
        r.bridge[supersede]();
        await r.clock.advance(0);
        assert.deepEqual(r.issued, [], supersede);
    }
});

test("a deferred Lower quality that nothing superseded is sent", async () => {
    const r = rig();
    await promptUp(r);
    r.bridge.selectPrimary();
    assert.equal(r.issued.length, 0, "it waits for the next turn");
    await r.clock.advance(0);
    assert.equal(r.issued.length, 1);
    assert.equal(r.issued[0]?.restore, false);
});

test("Restore quality is the viewer's answer: a plan taking over before it runs does not drop it", async () => {
    const r = rig();
    r.bridge.mode = "always";
    r.bridge.planAdopted(plan("p1"), [], "auto", false);
    r.bridge.sync(PLAYING);
    await r.clock.advance(11_000);
    r.bridge.sync({ ...PLAYING, buffering: true });
    await r.clock.advance(6000);
    assert.equal(r.issued.length, 1, "the automatic lowering");
    r.bridge.planAdopted(plan("p2", 5600), [], "auto", true);
    assert.equal(r.bridge.pill?.kind, "undo");
    r.bridge.selectPrimary();
    r.bridge.planAdopted(plan("p3"), [], "auto", false);
    await r.clock.advance(0);
    assert.equal(r.issued.length, 2);
    assert.equal(r.issued[1]?.restore, true);
});

test("consecutive notices never show an empty notice between them", async () => {
    const r = rig();
    r.bridge.controller.onOutput?.({ kind: "notice", notice: "lowered" });
    r.bridge.controller.onOutput?.({ kind: "notice", notice: "cantLower" });
    assert.equal(r.bridge.notice?.text, COPY.lowered);
    await r.clock.advance(NOTICE_MS);
    assert.equal(r.bridge.notice?.text, COPY.cantLower);
    assert.deepEqual(r.drawnNotices, [COPY.lowered, COPY.cantLower]);
    await r.clock.advance(NOTICE_MS);
    assert.equal(r.bridge.notice, undefined);
    assert.deepEqual(r.drawnNotices, [COPY.lowered, COPY.cantLower, undefined], "the last notice clears");
});
