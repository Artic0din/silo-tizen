import assert from "node:assert/strict";
import { test } from "node:test";
import { ExperimentalFeatures } from "../../src/session/experimentalFeatures.ts";
import { decodePlaybackCapabilities, type PlaybackCapabilities } from "../../src/contracts/v2/playback.ts";
import { decodeRoomAccess, decodeWatchTogetherCapabilities, type RoomAccess, type WatchTogetherCapabilities } from "../../src/contracts/v2/watchTogether.ts";
import { supportsSynchronizedParty, WatchPartyHub, type WatchPartyApi } from "../../src/ui/watchPartyHub.ts";
import { MemoryPublicStorage } from "./support/keyManager.ts";
import { fixture } from "./support/fakeSilo.ts";
import { ApiError } from "../../src/api/errors.ts";

const ROOM_ID = "0b6f3f0e-6c1d-4a39-9d52-3a1f7c7f9e10";

function roomCapabilities(overrides: Record<string, unknown> = {}): WatchTogetherCapabilities {
    return decodeWatchTogetherCapabilities({ state: "available", allowed: true, socket_protocol: "silo.room.v2", connection_replaced: true, ...overrides });
}

function playbackCapabilities(overrides: Record<string, unknown> = {}): PlaybackCapabilities {
    const base = fixture("playback_capability_available");
    return decodePlaybackCapabilities({ ...base, features: [...(base.features as string[]), "watch_party_coordinator_v1", "fixed_media_file_v1"], ...overrides });
}

function access(code = "K7M2QX"): RoomAccess {
    return decodeRoomAccess({
        room_access_token: "room-proof",
        room: {
            room_id: ROOM_ID, phase: "lobby", playback_state: "idle", selection_mode: "host_pick", selection_revision: 0, code,
            guest_control_policy: "host_only", is_paused: true, anchor_position_seconds: 0, anchor_updated_at: "2026-11-10T01:02:03.123Z",
            generation: 1, member_count: 1, host_connected: true, self_role: "host", self_can_control_transport: true, self_can_manage_room: true,
            self_ignore_wait: false,
            members: [{ user_id: "u1", profile_id: "p-owner", display_name: "Owner", is_host: true, is_self: true, connected: true }],
        },
    });
}

interface Calls { readonly names: string[]; readonly create: { roomId: string; mode: string }[]; readonly join: string[]; readonly read: { roomId: string; token: string }[] }

function fakeApi(over: Partial<WatchPartyApi> = {}): { api: WatchPartyApi; calls: Calls } {
    const calls: Calls = { names: [], create: [], join: [], read: [] };
    const api: WatchPartyApi = {
        capabilities: async () => { calls.names.push("capabilities"); return roomCapabilities(); },
        playbackCapabilities: async () => { calls.names.push("playback"); return playbackCapabilities(); },
        createRoom: async (roomId, mode) => { calls.names.push("create"); calls.create.push({ roomId, mode }); return access(); },
        joinByCode: async code => { calls.names.push("join"); calls.join.push(code); return access(code); },
        room: async (roomId, token) => { calls.names.push("room"); calls.read.push({ roomId, token }); return access("READ01"); },
        ...over,
    };
    return { api, calls };
}

const problem = (status: number, detail: string): ApiError => new ApiError({ kind: "problem", problem: { id: "x", title: "Failed", status, detail, instance: "", errors: [] }, retryAfterSeconds: undefined });

test("Watch Party is off until the device turns it on, and the choice is kept per device", () => {
    const storage = new MemoryPublicStorage();
    const features = new ExperimentalFeatures(storage);
    assert.equal(features.isEnabled("watchParty"), false);
    features.setEnabled("watchParty", true);
    assert.equal(new ExperimentalFeatures(storage).isEnabled("watchParty"), true);
    features.setEnabled("watchParty", false);
    assert.equal(new ExperimentalFeatures(storage).isEnabled("watchParty"), false);
});

test("an unavailable device store leaves every experimental feature off", () => {
    assert.equal(new ExperimentalFeatures(undefined).isEnabled("watchParty"), false);
    const storage = new MemoryPublicStorage();
    storage.failGet = true; storage.failSet = true;
    const features = new ExperimentalFeatures(storage);
    assert.equal(features.isEnabled("watchParty"), false);
    assert.doesNotThrow(() => features.setEnabled("watchParty", true));
});

test("synchronized Watch Party needs the server gate, the room socket and both playback features, as Apple checks", () => {
    assert.equal(supportsSynchronizedParty(roomCapabilities(), playbackCapabilities()), true);
    for (const room of [
        { state: "disabled" }, { state: "unsupported" }, { state: "not_configured" }, { allowed: false }, { allowed: undefined },
        { socket_protocol: "silo.room.v1" }, { socket_protocol: undefined }, { connection_replaced: false }, { connection_replaced: undefined },
    ]) assert.equal(supportsSynchronizedParty(roomCapabilities(room), playbackCapabilities()), false, JSON.stringify(room));
    const base = fixture("playback_capability_available").features as string[];
    for (const features of [base, [...base, "watch_party_coordinator_v1"], [...base, "fixed_media_file_v1"]]) {
        assert.equal(supportsSynchronizedParty(roomCapabilities(), playbackCapabilities({ features })), false, features.join());
    }
    for (const playback of [{ state: "disabled" }, { state: "unsupported" }, { allowed: false }]) {
        assert.equal(supportsSynchronizedParty(roomCapabilities(), playbackCapabilities(playback)), false, JSON.stringify(playback));
    }
});

test("checking support reads both capability documents and reports the result", async () => {
    const { api, calls } = fakeApi();
    const seen: boolean[] = [];
    const hub = new WatchPartyHub(api, () => undefined, { onSupport: supported => seen.push(supported) });
    await hub.check();
    assert.deepEqual([...calls.names].sort(), ["capabilities", "playback"]);
    assert.equal(hub.state.supported, true);
    assert.equal(hub.state.checking, false);
    assert.equal(hub.state.error, undefined);
    assert.deepEqual(seen, [true]);
});

test("a server without the playback features reports unsupported with no error text", async () => {
    const { api } = fakeApi({ playbackCapabilities: async () => decodePlaybackCapabilities(fixture("playback_capability_available")) });
    const hub = new WatchPartyHub(api, () => undefined, { supported: true });
    await hub.check();
    assert.equal(hub.state.supported, false);
    assert.equal(hub.state.error, undefined);
});

test("a failed support check keeps the last answer and says why", async () => {
    const { api } = fakeApi({ capabilities: async () => { throw problem(503, "Down for maintenance."); } });
    const hub = new WatchPartyHub(api, () => undefined, { supported: true });
    await hub.check();
    assert.equal(hub.state.supported, true);
    assert.equal(hub.state.error, "Could not check Watch Party support. Down for maintenance.");
    assert.equal(hub.state.checking, false);
});

test("Start a party creates one room with a fresh UUID and shows the room from a single read", async () => {
    const { api, calls } = fakeApi();
    const hub = new WatchPartyHub(api, () => undefined, { supported: true });
    await hub.create("host_pick");
    assert.equal(calls.create.length, 1);
    assert.match(calls.create[0]?.roomId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(calls.create[0]?.mode, "host_pick");
    assert.deepEqual(calls.read, [{ roomId: ROOM_ID, token: "room-proof" }]);
    assert.equal(calls.names.filter(name => name === "room").length, 1);
    assert.equal(hub.state.room?.code, "READ01", "the lobby shows the room read, not the create answer");
    assert.equal(hub.state.error, undefined);
    assert.equal(hub.state.busy, false);
});

test("Start a party and let everyone vote asks for a vote room", async () => {
    const { api, calls } = fakeApi();
    await new WatchPartyHub(api, () => undefined, { supported: true }).create("vote");
    assert.equal(calls.create[0]?.mode, "vote");
});

test("each create attempt uses its own room id", async () => {
    const { api, calls } = fakeApi();
    const hub = new WatchPartyHub(api, () => undefined, { supported: true });
    await hub.create("host_pick"); hub.leave(); await hub.create("host_pick");
    assert.notEqual(calls.create[0]?.roomId, calls.create[1]?.roomId);
});

test("create and join check support again first and refuse an unsupported server with Apple's text", async () => {
    const { api, calls } = fakeApi({ playbackCapabilities: async () => decodePlaybackCapabilities(fixture("playback_capability_available")) });
    const hub = new WatchPartyHub(api, () => undefined, { supported: true });
    await hub.create("host_pick");
    assert.equal(hub.state.error, "This server needs an update to support synchronized Watch Party playback safely on this profile.");
    assert.equal(hub.state.supported, false);
    assert.deepEqual(calls.create, []);
    await hub.join("K7M2QX");
    assert.deepEqual(calls.join, []);
    assert.equal(hub.state.room, undefined);
});

test("Join party sends the typed code trimmed and shows the room from a single read", async () => {
    const { api, calls } = fakeApi();
    const hub = new WatchPartyHub(api, () => undefined, { supported: true });
    await hub.join("  k7m2qx \n");
    assert.deepEqual(calls.join, ["k7m2qx"]);
    assert.equal(calls.read.length, 1);
    assert.equal(hub.state.room?.code, "READ01");
});

test("an empty code and an invite link get Apple's messages without a request", async () => {
    const { api, calls } = fakeApi();
    const hub = new WatchPartyHub(api, () => undefined, { supported: true });
    await hub.join("   ");
    assert.equal(hub.state.error, "Enter a party code or invitation link.");
    await hub.join("https://silo.example.test/rooms/join?token=abc");
    assert.equal(hub.state.error, "This Watch Party invitation is invalid.");
    assert.deepEqual(calls.names, []);
});

test("a refused join shows the server's reason and stays on the hub", async () => {
    const { api } = fakeApi({ joinByCode: async () => { throw problem(409, "That party code was not found."); } });
    const hub = new WatchPartyHub(api, () => undefined, { supported: true });
    await hub.join("NOPE00");
    assert.equal(hub.state.error, "That party code was not found.");
    assert.equal(hub.state.room, undefined);
    assert.equal(hub.state.busy, false);
});

test("a failed room read leaves the hub with the reason", async () => {
    const { api } = fakeApi({ room: async () => { throw problem(500, "Room store unavailable."); } });
    const hub = new WatchPartyHub(api, () => undefined, { supported: true });
    await hub.create("host_pick");
    assert.equal(hub.state.error, "Room store unavailable.");
    assert.equal(hub.state.room, undefined);
});

test("a second tap while a request runs is ignored", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { api, calls } = fakeApi({ createRoom: async (roomId, mode) => { calls.create.push({ roomId, mode }); await gate; return access(); } });
    const hub = new WatchPartyHub(api, () => undefined, { supported: true });
    const first = hub.create("host_pick");
    await hub.create("host_pick");
    await hub.join("K7M2QX");
    assert.equal(hub.state.busy, true);
    release(); await first;
    assert.equal(calls.create.length, 1);
    assert.deepEqual(calls.join, []);
});

test("leaving the placeholder lobby returns to the entry and clears the message", async () => {
    const { api } = fakeApi();
    const hub = new WatchPartyHub(api, () => undefined, { supported: true });
    await hub.create("host_pick");
    hub.leave();
    assert.equal(hub.state.room, undefined);
    assert.equal(hub.state.error, undefined);
});

test("stopping the hub aborts the request in flight and ignores its answer", async () => {
    let signal: AbortSignal | undefined;
    const { api } = fakeApi({ createRoom: async (_id, _mode, s) => { signal = s; return await new Promise<RoomAccess>((_resolve, reject) => s.addEventListener("abort", () => reject(new Error("aborted")))); } });
    const hub = new WatchPartyHub(api, () => undefined, { supported: true });
    const pending = hub.create("host_pick");
    await new Promise(resolve => setTimeout(resolve, 0));
    hub.stop();
    await pending;
    assert.equal(signal?.aborted, true);
    assert.equal(hub.state.error, undefined);
    assert.equal(hub.state.room, undefined);
});
