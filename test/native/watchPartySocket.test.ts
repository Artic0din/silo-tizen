import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../src/api/errors.ts";
import { SessionError } from "../../src/session/session.ts";
import { watchTogetherOperations } from "../../src/api/watchTogetherOperations.ts";
import { decodeRoom, type RoomAccess, type RoomSocketTicket, type RoomServerMessage, decodeRoomSocketTicket } from "../../src/contracts/v2/watchTogether.ts";
import { watchPartyApi } from "../../src/ui/watchPartyApi.ts";
import { PARTY_ENDED, PARTY_EXPIRED, PARTY_REPLACED, WatchPartyHub, type WatchPartyApi } from "../../src/ui/watchPartyHub.ts";
import {
    type ConnectionStatus, reconnectDelayMs, RoomClock, RoomConnection, type RoomEnd, type RoomHandlers, type RoomSocketApi, RoomState, type RoomWebSocket,
} from "../../src/ui/watchPartySocket.ts";
import { ManualClock } from "./support/clock.ts";
import { playbackCapabilities, ROOM_ID, roomAccess, roomCapabilities, unusedLobbyOperations } from "./support/watchPartyApi.ts";

const TICKET: RoomSocketTicket = { ticket: "tk_1", expiresIn: 30, maxConnectionSeconds: 300 };
const problem = (status: number): ApiError => new ApiError({ kind: "problem", problem: { id: "x", title: "Refused", status, detail: "", instance: "", errors: [] }, retryAfterSeconds: undefined });

/** A browser WebSocket stand-in: the test opens it, sends it frames and closes it. */
class FakeSocket implements RoomWebSocket {
    protocol = "";
    binaryType: BinaryType = "blob";
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    readonly sent: Record<string, unknown>[] = [];
    closedWith: number | undefined;
    readonly url: string;
    readonly protocols: string[];

    constructor(url: string, protocols: string[]) { this.url = url; this.protocols = protocols; }

    send(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
    /** As a browser's: a page may only close with 1000 or 3000 to 4999. */
    close(code?: number): void {
        if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) throw new DOMException("Invalid close code", "InvalidAccessError");
        this.closedWith = code ?? 1005;
    }

    open(protocol = "silo.room.v2"): void { this.protocol = protocol; this.onopen?.(new Event("open")); }
    frame(value: unknown): void { this.onmessage?.(new MessageEvent("message", { data: typeof value === "string" ? value : JSON.stringify(value) })); }
    drop(): void { this.onerror?.(new Event("error")); this.onclose?.(new CloseEvent("close", { code: 1006 })); }
}

const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

const wire = (room: Record<string, unknown> = {}): Record<string, unknown> => ({
    room_id: ROOM_ID, phase: "lobby", playback_state: "idle", selection_mode: "host_pick", selection_revision: 0, code: "K7M2QX",
    guest_control_policy: "host_only", is_paused: true, anchor_position_seconds: 0, anchor_updated_at: "2026-11-10T01:02:03.123Z",
    generation: 1, member_count: 1, host_connected: true, self_role: "host", self_can_control_transport: true, self_can_manage_room: true, self_ignore_wait: false,
    members: [{ user_id: "u1", profile_id: "p-owner", display_name: "Owner", is_host: true, is_self: true, connected: true }],
    ...room,
});

interface Rig {
    readonly clock: ManualClock;
    readonly sockets: FakeSocket[];
    readonly statuses: ConnectionStatus[];
    readonly ends: RoomEnd[];
    readonly messages: RoomServerMessage[];
    readonly calls: string[];
    readonly connection: RoomConnection;
    readonly last: () => FakeSocket;
}

/** A connection over fake HTTP and a fake socket; `over` replaces the room read or ticket. */
function rig(over: Partial<RoomSocketApi> = {}): Rig {
    const clock = new ManualClock();
    const sockets: FakeSocket[] = [];
    const statuses: ConnectionStatus[] = [];
    const ends: RoomEnd[] = [];
    const messages: RoomServerMessage[] = [];
    const calls: string[] = [];
    let token = "room-proof";
    const api: RoomSocketApi = {
        room: async (id, sent) => { calls.push(`room ${id} ${sent}`); return roomAccess({}, "room-proof-renewed"); },
        socketTicket: async (id, sent) => { calls.push(`ticket ${id} ${sent}`); return TICKET; },
        socketHandshake: (id, ticket) => ({ url: `wss://silo.example/api/v2/watch-together/rooms/${id}/ws`, protocols: ["silo.room.v2", `silo.ticket.${ticket.ticket}`] }),
        ...over,
    };
    const handlers: RoomHandlers = {
        token: () => token,
        receipt: () => 0,
        access: answer => { token = answer.roomAccessToken; },
        message: message => { messages.push(message); },
        status: status => { statuses.push(status); },
        end: reason => { ends.push(reason); },
    };
    const connection = new RoomConnection(ROOM_ID, api, handlers, { clock, socket: (url, protocols) => { const socket = new FakeSocket(url, protocols); sockets.push(socket); return socket; } });
    return { clock, sockets, statuses, ends, messages, calls, connection, last: () => { const socket = sockets.at(-1); assert.ok(socket, "a socket opened"); return socket; } };
}

// --- Ticket (APIv2Client+WatchParty.swift watchPartySocketTicket) ---

test("the ticket is a POST to ws-ticket with the room token, and only a silo.room.v2, subprotocol-safe ticket is accepted", () => {
    const spec = watchTogetherOperations.socketTicket(ROOM_ID, "room-proof");
    assert.deepEqual([spec.method, spec.path, spec.roomToken, spec.retry], ["POST", `/watch-together/rooms/${ROOM_ID}/ws-ticket`, "room-proof", "safe"]);
    assert.deepEqual(decodeRoomSocketTicket({ ticket: "a-B_9", expires_in: 0, max_connection_seconds: 300, protocol: "silo.room.v2" }), { ticket: "a-B_9", expiresIn: 0, maxConnectionSeconds: 300 });
    for (const body of [
        { ticket: "a", expires_in: 30, max_connection_seconds: 300, protocol: "silo.room.v3" },
        { ticket: "a b", expires_in: 30, max_connection_seconds: 300, protocol: "silo.room.v2" },
        { ticket: "a", expires_in: -1, max_connection_seconds: 300, protocol: "silo.room.v2" },
        { ticket: "a", expires_in: 30, max_connection_seconds: 0, protocol: "silo.room.v2" },
    ]) assert.throws(() => decodeRoomSocketTicket(body));
});

test("the adapter builds the socket address from the server's API root; the UI never assembles it", async () => {
    const seen: { path: string; roomToken: string | undefined; profileScoped: boolean | undefined }[] = [];
    const api = watchPartyApi({
        http: { base: { apiRoot: "https://silo.example/base/api/v2" } } as never,
        call: async spec => { seen.push({ path: spec.path, roomToken: spec.roomToken, profileScoped: spec.profileScoped }); return TICKET as never; },
    });
    assert.deepEqual(await api.socketTicket(ROOM_ID, "room-proof", new AbortController().signal), TICKET);
    assert.deepEqual(seen, [{ path: `/watch-together/rooms/${ROOM_ID}/ws-ticket`, roomToken: "room-proof", profileScoped: true }]);
    assert.deepEqual(api.socketHandshake(ROOM_ID, TICKET), { url: `wss://silo.example/base/api/v2/watch-together/rooms/${ROOM_ID}/ws`, protocols: ["silo.room.v2", "silo.ticket.tk_1"] });
});

test("each attempt reads the room, mints a ticket with the renewed token, then opens the socket with the protocol and ticket", async () => {
    const r = rig();
    await settle();
    assert.deepEqual(r.calls, [`room ${ROOM_ID} room-proof`, `ticket ${ROOM_ID} room-proof-renewed`]);
    const socket = r.last();
    assert.equal(socket.url, `wss://silo.example/api/v2/watch-together/rooms/${ROOM_ID}/ws`);
    assert.deepEqual(socket.protocols, ["silo.room.v2", "silo.ticket.tk_1"]);
    assert.deepEqual(r.statuses, ["connecting"]);
    socket.open();
    assert.deepEqual(r.statuses, ["connecting", "connected"]);
    r.connection.close();
});

// --- Frames (WatchPartyServerMessage) ---

test("frames are decoded against the contract: a snapshot reaches the lobby and an unknown type is ignored", async () => {
    const r = rig();
    await settle();
    r.last().open();
    r.last().frame({ type: "snapshot", room: wire({ generation: 2 }) });
    r.last().frame({ type: "vote_tally", whatever: true });
    assert.deepEqual(r.messages.map(message => message.type), ["snapshot", "unknown"]);
    const snapshot = r.messages[0];
    assert.equal(snapshot?.type === "snapshot" ? snapshot.room.generation : undefined, 2);
    assert.deepEqual(r.ends, []);
    r.connection.close();
});

test("a frame that breaks the contract ends the party as Apple's DecodingError does, and nothing reconnects", async () => {
    for (const bad of ["not json", { type: "snapshot", room: { room_id: "" } }, { kind: "snapshot" }]) {
        const r = rig();
        await settle();
        r.last().open();
        r.last().frame(bad);
        await settle();
        assert.deepEqual(r.ends, ["expired"], JSON.stringify(bad));
        assert.equal(r.last().closedWith, 1000);
        await r.clock.advance(60_000);
        assert.equal(r.sockets.length, 1, "no reconnect after a terminal frame");
    }
});

test("a server that answers with another subprotocol is refused and ends the party", async () => {
    const r = rig();
    await settle();
    r.last().open("");
    await settle();
    assert.deepEqual(r.ends, ["expired"]);
    assert.equal(r.last().closedWith, 1000);
});

// --- Stale answers (WatchPartyRoomState) ---

test("a room older in generation or selection, or for another room, is dropped; an HTTP answer cannot replace a snapshot that arrived after it was asked", () => {
    const room = (over: Record<string, unknown>) => decodeRoom(wire(over));
    const state = new RoomState();
    assert.equal(state.accept(room({ generation: 3, selection_revision: 2 })), true);
    assert.equal(state.accept(room({ generation: 2, selection_revision: 2 })), false, "older generation");
    assert.equal(state.accept(room({ generation: 3, selection_revision: 1 })), false, "older selection revision");
    assert.equal(state.accept(room({ room_id: "other", generation: 9, selection_revision: 9 })), false, "another room");
    const asked = state.receipt;
    assert.equal(state.accept(room({ generation: 3, selection_revision: 2, member_count: 2 })), true, "a snapshot of the same generation");
    assert.equal(state.accept(room({ generation: 3, selection_revision: 2 }), asked), false, "the HTTP answer asked before that snapshot");
    assert.equal(state.accept(room({ generation: 4, selection_revision: 2 }), asked), true, "a newer generation always wins");
    assert.equal(state.accept(room({ generation: 5, selection_revision: 2, phase: "ended" })), true);
    assert.equal(state.terminal, true);
    assert.equal(state.accept(room({ generation: 6, selection_revision: 2 })), false, "nothing follows the end");
});

// --- Reconnect (WatchPartySession.startConnection) ---

test("a socket that fails backs off 1, 2, 4, 8, then 15 seconds, reading the room and a new ticket each time", async () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(reconnectDelayMs), [1000, 2000, 4000, 8000, 15000, 15000, 15000]);
    const r = rig();
    await settle();
    for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
        const before = r.sockets.length;
        r.last().drop();
        await settle();
        assert.equal(r.statuses.at(-1), "reconnecting");
        await r.clock.advance(delay - 1);
        assert.equal(r.sockets.length, before, `still waiting ${delay} ms`);
        await r.clock.advance(1);
        await settle();
        assert.equal(r.sockets.length, before + 1, `reconnected after ${delay} ms`);
    }
    assert.equal(r.calls.filter(call => call.startsWith("ticket")).length, 7, "every socket gets its own ticket");
    assert.deepEqual(r.ends, [], "Apple retries for as long as the party is open");
    r.connection.close();
});

test("a socket that stayed open 30 seconds reconnects at once, while one that closes sooner keeps backing off", async () => {
    const r = rig();
    await settle();
    r.last().drop();
    await settle();
    await r.clock.advance(1000);
    await settle();
    r.last().open();
    await r.clock.advance(29_999);
    r.last().drop();
    await settle();
    await r.clock.advance(1999);
    assert.equal(r.sockets.length, 2, "a short-lived socket counts as a second failure: 2 s");
    await r.clock.advance(1);
    await settle();
    assert.equal(r.sockets.length, 3);
    r.last().open();
    await r.clock.advance(30_000);
    const statuses = r.statuses.length;
    r.last().drop();
    await settle();
    assert.equal(r.sockets.length, 4, "the server's connection deadline: reconnect without waiting");
    assert.deepEqual(r.statuses.slice(statuses), ["connecting"], "and without showing Reconnecting");
    r.connection.close();
});

test("a network failure before the socket retries; 409 ends the party; 401, 403, 404, 410 and a refused session expire it", async () => {
    let failures = 1;
    const flaky = rig({ socketTicket: async () => { if (failures-- > 0) throw new ApiError({ kind: "network" }); return TICKET; } });
    await settle();
    assert.equal(flaky.sockets.length, 0);
    await flaky.clock.advance(1000);
    await settle();
    assert.equal(flaky.sockets.length, 1);
    flaky.connection.close();
    for (const [error, end] of [[problem(409), "ended"], [problem(401), "expired"], [problem(403), "expired"], [problem(404), "expired"], [problem(410), "expired"], [new ApiError({ kind: "invalid_response", path: "x" }), "expired"], [new SessionError("signed_out"), "expired"], [new SessionError("session_ended"), "expired"]] as const) {
        const r = rig({ room: async () => { throw error; } });
        await settle();
        assert.deepEqual(r.ends, [end]);
        await r.clock.advance(60_000);
        assert.equal(r.sockets.length, 0);
    }
});

test("a token refresh the server cannot answer for now reconnects instead of ending the party", async () => {
    let failures = 1;
    const r = rig({ room: async () => { if (failures-- > 0) throw new SessionError("unavailable", 2); return roomAccess(); } });
    await settle();
    assert.deepEqual(r.ends, []);
    await r.clock.advance(1000);
    await settle();
    assert.equal(r.sockets.length, 1);
    r.connection.close();
});

test("a host call that fails after the socket ended the party keeps the socket's reason on the entry", async () => {
    let fail: () => void = () => undefined;
    const r = hubRig({}, { closeRoom: () => new Promise((_resolve, reject) => { fail = () => reject(new ApiError({ kind: "timeout" })); }) });
    await r.hub.create("host_pick");
    await settle();
    r.sockets[0]?.open();
    const ending = r.hub.endParty();
    await settle();
    r.sockets[0]?.frame({ type: "room_closed", reason: "ended" });
    fail();
    await ending;
    assert.equal(r.hub.state.error, PARTY_ENDED);
    let refuse: () => void = () => undefined;
    const m = hubRig({}, { setGuestControlPolicy: () => new Promise((_resolve, reject) => { refuse = () => reject(problem(404)); }) });
    await m.hub.create("host_pick");
    await settle();
    m.sockets[0]?.open();
    const changing = m.hub.setPolicy("guest_play_pause");
    await settle();
    m.sockets[0]?.frame({ type: "connection_replaced" });
    refuse();
    await changing;
    assert.equal(m.hub.state.error, PARTY_REPLACED);
});

test("a lost start that a snapshot proves while the room is read back still counts as a start", async () => {
    let reads = 0;
    let answer: (value: RoomAccess) => void = () => undefined;
    const staged = { selected_content_id: "movie:m0004", selection_revision: 1 };
    const r = hubRig(staged, {
        startPlayback: async () => { throw new ApiError({ kind: "network" }); },
        room: () => reads++ === 0 ? Promise.resolve(roomAccess(staged)) : new Promise(resolve => { answer = resolve; }),
    });
    await r.hub.create("host_pick");
    await settle();
    r.sockets[0]?.open();
    const starting = r.hub.start();
    await settle();
    r.sockets[0]?.frame({ type: "snapshot", room: wire({ ...staged, generation: 2, phase: "playing", playback_state: "playing", is_paused: false, selected_file_id: "42" }) });
    answer(roomAccess(staged));
    assert.equal(await starting, true, "the room the snapshot left shows the start happened");
    assert.equal(r.hub.state.error, undefined);
    r.hub.leave();
});

// --- Clock (WatchPartyClock) ---

test("the clock offset comes from the fastest round trip and survives one slow pong", () => {
    const clock = new RoomClock();
    assert.equal(clock.offset, 0);
    // Sent at 1000, server received at 6040 and sent at 6050, back at 1100: a 90 ms round trip, server 5000 ms ahead.
    assert.equal(clock.record(1000, 6040, 6050, 1100), true);
    assert.equal(clock.offset, 4995);
    assert.equal(clock.record(2000, 7010, 7020, 2030), true, "20 ms round trip");
    assert.equal(clock.offset, 5000);
    assert.equal(clock.record(3000, 8300, 8300, 3600), true, "a 600 ms round trip, still consistent");
    assert.equal(clock.offset, 5000, "the fastest sample wins");
    assert.equal(clock.record(4000, 9000, 9000, 9001), false, "beyond the five second limit");
    assert.equal(clock.record(4000, 9000, 9010, 4005), false, "a negative round trip beyond rounding");
    assert.equal(clock.record(4000, 9000, 9001, 4000), true, "-1 ms is rounding, taken as 0");
});

test("a sample that cannot agree with the kept ones means the device clock stepped, so the old samples go", () => {
    const clock = new RoomClock();
    clock.record(1000, 6010, 6010, 1020);
    clock.record(2000, 7010, 7010, 2020);
    assert.equal(clock.count, 2);
    clock.record(3000, 3010 + 60_000, 3010 + 60_000, 3020);
    assert.equal(clock.count, 1);
    assert.equal(clock.offset, 60_000);
    for (let i = 0; i < 10; i++) clock.record(4000 + i, 64_000 + i, 64_000 + i, 4000 + i);
    assert.equal(clock.count, RoomClock.SAMPLE_LIMIT, "eight samples are kept");
});

test("the open socket pings every 2 seconds until four pongs set the clock, then every 15, and pongs move the offset", async () => {
    const r = rig();
    await settle();
    const socket = r.last();
    socket.open();
    const pings = (): Record<string, unknown>[] => socket.sent.filter(frame => frame.type === "ping");
    assert.equal(pings().length, 1, "the first ping goes on open");
    assert.equal(pings()[0]?.client_sent_at, new Date(r.clock.now()).toISOString());
    const pong = (): void => {
        const sent = Date.parse(String(pings().at(-1)?.client_sent_at));
        socket.frame({ type: "pong", client_sent_at: new Date(sent).toISOString(), server_received_at: new Date(sent + 3000).toISOString(), server_sent_at: new Date(sent + 3000).toISOString() });
    };
    for (let i = 0; i < 3; i++) {
        pong();
        await r.clock.advance(2000);
        assert.equal(pings().length, i + 2);
    }
    pong();
    assert.equal(r.connection.clock.offset, 3000);
    assert.equal(r.messages.length, 0, "pongs are the clock's, not the lobby's");
    await r.clock.advance(14_500);
    assert.equal(pings().length, 4, "warm: no ping before 15 s");
    await r.clock.advance(500);
    assert.equal(pings().length, 5);
    r.connection.close();
});

// --- Cancellation ---

test("closing goes away cleanly from the socket, the ticket request or the backoff, and nothing reconnects", async () => {
    const open = rig();
    await settle();
    open.last().open();
    open.connection.close();
    assert.equal(open.last().closedWith, 1000);
    await open.clock.advance(60_000);
    assert.equal(open.sockets.length, 1);
    assert.equal(open.last().sent.length, 1, "pings stop with the socket");

    let aborted: AbortSignal | undefined;
    const minting = rig({ socketTicket: (_id, _token, signal) => { aborted = signal; return new Promise<RoomSocketTicket>(() => undefined); } });
    await settle();
    minting.connection.close();
    assert.equal(aborted?.aborted, true, "the ticket request is abandoned");
    await minting.clock.advance(60_000);
    assert.equal(minting.sockets.length, 0);

    const waiting = rig();
    await settle();
    waiting.last().drop();
    await settle();
    waiting.connection.close();
    await waiting.clock.advance(60_000);
    assert.equal(waiting.sockets.length, 1, "the backoff does not reconnect after close");
});

// --- The hub over the socket ---

interface HubRig { readonly hub: WatchPartyHub; readonly clock: ManualClock; readonly sockets: FakeSocket[]; readonly leaves: () => number }

function hubRig(room: Record<string, unknown> = {}, over: Partial<WatchPartyApi> = {}): HubRig {
    const clock = new ManualClock();
    const sockets: FakeSocket[] = [];
    let leaves = 0;
    const access = (): RoomAccess => roomAccess(room);
    const api: WatchPartyApi = {
        capabilities: async () => roomCapabilities({ staged_selection: true }),
        playbackCapabilities: async () => playbackCapabilities(),
        createRoom: async () => access(),
        joinByCode: async () => access(),
        closeRoom: async () => undefined,
        ...unusedLobbyOperations,
        room: async () => access(),
        socketTicket: async () => TICKET,
        socketHandshake: (id, ticket) => ({ url: `wss://silo.example/api/v2/watch-together/rooms/${id}/ws`, protocols: ["silo.room.v2", `silo.ticket.${ticket.ticket}`] }),
        ...over,
    };
    const hub = new WatchPartyHub(api, () => undefined, {
        supported: true, clock, onLeave: () => { leaves++; },
        socket: (url, protocols) => { const socket = new FakeSocket(url, protocols); sockets.push(socket); return socket; },
    });
    return { hub, clock, sockets, leaves: () => leaves };
}

test("the lobby connects on entering and shows Apple's states: Connecting, then connected, Reconnecting after a drop", async () => {
    const r = hubRig();
    await r.hub.create("host_pick");
    assert.equal(r.hub.state.connection, "connecting");
    await settle();
    r.sockets[0]?.open();
    assert.equal(r.hub.state.connection, "connected");
    r.sockets[0]?.drop();
    await settle();
    assert.equal(r.hub.state.connection, "reconnecting");
    r.hub.leave();
    assert.equal(r.hub.state.connection, "idle");
});

test("snapshots update the lobby live: a member joins, the pick changes and the policy changes; an older snapshot is dropped", async () => {
    const r = hubRig();
    await r.hub.create("host_pick");
    await settle();
    const socket = r.sockets[0];
    assert.ok(socket);
    socket.open();
    const sam = { user_id: "u2", profile_id: "p-guest", display_name: "Sam", is_host: false, is_self: false, connected: true };
    socket.frame({ type: "snapshot", room: wire({ generation: 2, member_count: 2, members: [...(wire().members as unknown[]), sam] }) });
    assert.deepEqual(r.hub.state.room?.members.map(member => member.displayName), ["Owner", "Sam"]);
    socket.frame({ type: "snapshot", room: wire({ generation: 3, selection_revision: 1, selected_content_id: "movie:m0004", guest_control_policy: "guest_play_pause", members: [...(wire().members as unknown[]), sam] }) });
    assert.equal(r.hub.state.room?.selectedContentId, "movie:m0004");
    assert.equal(r.hub.state.room?.guestControlPolicy, "guest_play_pause");
    socket.frame({ type: "snapshot", room: wire({ generation: 2 }) });
    assert.equal(r.hub.state.room?.generation, 3, "a late snapshot does not undo the newer one");
    r.hub.leave();
});

test("the party ending over the socket returns to the entry with Apple's reason", async () => {
    for (const [frame, text] of [
        [{ type: "room_closed", reason: "host_left" }, PARTY_ENDED],
        [{ type: "snapshot", room: wire({ generation: 2, phase: "ended" }) }, PARTY_ENDED],
        [{ type: "connection_replaced" }, PARTY_REPLACED],
        [{ type: "error", code: "connection_replaced", message: "Replaced." }, PARTY_REPLACED],
    ] as const) {
        const r = hubRig();
        await r.hub.create("host_pick");
        await settle();
        r.sockets[0]?.open();
        r.sockets[0]?.frame(frame);
        assert.equal(r.hub.state.room, undefined, frame.type);
        assert.equal(r.hub.state.error, text);
        assert.equal(r.leaves(), 1);
        assert.equal(r.sockets[0]?.closedWith, 1000, "the socket is closed");
        await r.clock.advance(60_000);
        assert.equal(r.sockets.length, 1, "and nothing reconnects");
    }
});

test("an error frame shows its message, except a bad_request, which the lobby never causes", async () => {
    const r = hubRig();
    await r.hub.create("host_pick");
    await settle();
    r.sockets[0]?.open();
    r.sockets[0]?.frame({ type: "error", code: "bad_request", message: "Report refused." });
    assert.equal(r.hub.state.error, undefined);
    r.sockets[0]?.frame({ type: "error", code: "rate_limited", message: "Slow down." });
    assert.equal(r.hub.state.error, "Slow down.");
    assert.notEqual(r.hub.state.room, undefined, "the party goes on");
    r.hub.leave();
});

test("a room the server refuses while reconnecting ends the party: 409 as ended, 404 as expired", async () => {
    for (const [status, text] of [[409, PARTY_ENDED], [404, PARTY_EXPIRED]] as const) {
        let reads = 0;
        const r = hubRig({}, { room: async () => { if (reads++ > 0) throw problem(status); return roomAccess(); } });
        await r.hub.create("host_pick");
        await settle();
        r.sockets[0]?.open();
        r.sockets[0]?.drop();
        await settle();
        await r.clock.advance(1000);
        await settle();
        assert.equal(r.hub.state.room, undefined);
        assert.equal(r.hub.state.error, text);
    }
});

test("Leave, and the page closing on sign-out or a profile switch, close the socket and nothing reconnects", async () => {
    for (const exit of ["leave", "stop"] as const) {
        const r = hubRig();
        await r.hub.create("host_pick");
        await settle();
        r.sockets[0]?.open();
        if (exit === "leave") r.hub.leave(); else r.hub.stop();
        assert.equal(r.sockets[0]?.closedWith, 1000, exit);
        await r.clock.advance(60_000);
        assert.equal(r.sockets.length, 1);
    }
});

test("leaving while the opening room read is still out drops its answer", async () => {
    let answer: (value: RoomAccess) => void = () => undefined;
    const r = hubRig({}, { room: () => new Promise(resolve => { answer = resolve; }) });
    await r.hub.create("host_pick");
    r.hub.leave();
    answer(roomAccess());
    await settle();
    assert.equal(r.hub.state.room, undefined);
    assert.equal(r.sockets.length, 0);
});
