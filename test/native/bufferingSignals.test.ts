// What AVPlay's facts mean to the buffering controller, after silo-apple's BufferingSignalMapper:
// only the network's own buffering during playback is a stall.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BufferingSignalMapper, type BufferingCall, type BufferingSnapshot } from "../../src/player/bufferingSignals.ts";

const PLAYING: BufferingSnapshot = {
    hasActiveLoad: true, wantsToPlay: true, started: true, buffering: false, seekInFlight: false, reloadInProgress: false,
    reachedEnd: false, playheadMs: 1000, suspended: false, connectionTrouble: false,
};
const waiting = (cause: string): BufferingCall => ({ kind: "waiting", cause: cause as never });

function adopted(): BufferingSignalMapper {
    const mapper = new BufferingSignalMapper();
    mapper.planAdopted();
    return mapper;
}

function ran(mapper: BufferingSignalMapper): void {
    assert.deepEqual(mapper.update(PLAYING), [{ kind: "playing" }]);
}

test("a new plan's start is a network wait until it plays, and a repeated state reports nothing", () => {
    const mapper = adopted();
    const loading = { ...PLAYING, started: false };
    assert.deepEqual(mapper.update(loading), [waiting("network")]);
    assert.deepEqual(mapper.update(loading), []);
    assert.deepEqual(mapper.update(PLAYING), [{ kind: "playing" }]);
    assert.deepEqual(mapper.update(PLAYING), []);
});

test("buffering after playback ran is a network stall that ends when buffering completes", () => {
    const mapper = adopted();
    ran(mapper);
    assert.deepEqual(mapper.update({ ...PLAYING, buffering: true }), [waiting("network")]);
    assert.deepEqual(mapper.update(PLAYING), [{ kind: "playing" }]);
});

test("pausing, the end of the stream and a suspended app are paused, not waiting", () => {
    for (const patch of [{ wantsToPlay: false }, { reachedEnd: true }, { suspended: true }]) {
        const mapper = adopted();
        ran(mapper);
        assert.deepEqual(mapper.update({ ...PLAYING, buffering: true, ...patch }), [{ kind: "paused" }], JSON.stringify(patch));
    }
});

test("a seek, and the buffering after it until the playhead moves on, belong to the seek", () => {
    const mapper = adopted();
    ran(mapper);
    assert.deepEqual(mapper.update({ ...PLAYING, seekInFlight: true }), [waiting("seek")]);
    // The seek landed at 300 s; AVPlay reports playing over the frame before its clock moves.
    const landed = { ...PLAYING, playheadMs: 300_000 };
    assert.deepEqual(mapper.update(landed), []);
    assert.deepEqual(mapper.update({ ...landed, buffering: true }), []);
    assert.deepEqual(mapper.update({ ...landed, playheadMs: 300_400 }), [{ kind: "playing" }]);
    assert.deepEqual(mapper.update({ ...landed, playheadMs: 300_900, buffering: true }), [waiting("network")]);
});

test("a reload of the source is a reload wait, and a reload before the plan ever ran is the start's", () => {
    const mapper = adopted();
    ran(mapper);
    assert.deepEqual(mapper.update({ ...PLAYING, started: false, reloadInProgress: true }), [waiting("reload")]);
    const fresh = adopted();
    assert.deepEqual(fresh.update({ ...PLAYING, started: false, reloadInProgress: true }), [waiting("network")]);
});

test("a lost connection or a failed media request is transport trouble until playback runs again", () => {
    const mapper = adopted();
    ran(mapper);
    assert.deepEqual(mapper.update({ ...PLAYING, buffering: true, connectionTrouble: true }), [{ kind: "trouble", trouble: true }, waiting("network")]);
    assert.deepEqual(mapper.update(PLAYING), [{ kind: "trouble", trouble: false }, { kind: "playing" }]);
    mapper.noteMediaRequestFailed();
    assert.deepEqual(mapper.update({ ...PLAYING, buffering: true }), [{ kind: "trouble", trouble: true }, waiting("network")]);
    assert.deepEqual(mapper.update({ ...PLAYING, buffering: true }), []);
    assert.deepEqual(mapper.update(PLAYING), [{ kind: "trouble", trouble: false }, { kind: "playing" }]);
});

test("a plan adopted while waiting hears the wait again, and invalidate repeats the last state", () => {
    const mapper = adopted();
    ran(mapper);
    mapper.invalidate();
    assert.deepEqual(mapper.update(PLAYING), [{ kind: "playing" }]);
    mapper.planAdopted();
    assert.deepEqual(mapper.update({ ...PLAYING, started: false }), [waiting("network")]);
});
