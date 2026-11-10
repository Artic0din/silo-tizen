import assert from "node:assert/strict";
import { test } from "node:test";
import { watchTogetherOperations as operations } from "../../src/api/watchTogetherOperations.ts";
import { NativeHttp } from "../../src/api/http.ts";
import { parseServerUrl } from "../../src/api/serverUrl.ts";
import {
    decodeRoom,
    decodeRoomAccess,
    decodeRoomServerMessage,
    decodeRoomSocketTicket,
    decodeWatchTogetherCapabilities,
    encodeRoomClientMessage,
    parseRoomServerMessage,
    roomSocketHandshake,
    watchTogetherAvailable,
    watchTogetherSocketSupported,
} from "../../src/contracts/v2/watchTogether.ts";
import { WireError } from "../../src/contracts/v2/wire.ts";
import { ManualClock } from "./support/clock.ts";
import { fixture } from "./support/fakeSilo.ts";

const ROOM_ID = "0b6f3f0e-6c1d-4a39-9d52-3a1f7c7f9e10";
const TOKEN = "room-proof-one";

/** An HTTP v2 room body built from the WatchTogetherRoomSnapshot schema; ids are strings. */
function roomBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        room_id: ROOM_ID,
        phase: "lobby",
        playback_state: "idle",
        selection_mode: "host_pick",
        selection_revision: 0,
        code: "K7M2QX",
        guest_control_policy: "host_only",
        is_paused: true,
        anchor_position_seconds: 0,
        anchor_updated_at: "2026-11-10T01:02:03.123Z",
        generation: 3,
        member_count: 2,
        host_connected: true,
        self_role: "guest",
        self_can_control_transport: false,
        self_can_manage_room: false,
        self_ignore_wait: false,
        invite_path: "/rooms/join?token=abc",
        members: [
            { user_id: "7", profile_id: "p-host", display_name: "Host", is_host: true, is_self: false, connected: true, lobby_ready: false },
            { user_id: "9", profile_id: "p-me", display_name: "Me", is_host: false, is_self: true, connected: true, lobby_ready: true, is_ready: true },
        ],
        ...overrides,
    };
}

function throwsWire(action: () => unknown, path: string): void {
    assert.throws(action, (error: unknown) => error instanceof WireError && error.path === path, path);
}

test("the vendored capabilities document decodes and stays unavailable while allowed is false", () => {
    const capabilities = decodeWatchTogetherCapabilities(fixture("watch_together_capabilities"));
    assert.deepEqual(capabilities, {
        revision: "efa2c8c12c9ace1fbcf4c6e3e159a3f97ee59741f73d3ca9e303b0b1e0179cf2",
        state: "available",
        allowed: false,
        stagedSelection: true,
        lobbyReady: true,
        connectionReplaced: true,
        selectionModeSwitch: true,
        memberState: true,
        picker: true,
        voteHostOverride: true,
        stopPlayback: true,
        maxMemberStateIds: 200,
        socketProtocol: "silo.room.v2",
    });
    assert.equal(watchTogetherAvailable(capabilities), false);
    assert.equal(watchTogetherSocketSupported(capabilities), false);
});

test("Watch Together is offered only for an available, allowed server that speaks silo.room.v2 and announces replacement", () => {
    const base = fixture("watch_together_capabilities");
    const open = decodeWatchTogetherCapabilities({ ...base, allowed: true });
    assert.equal(watchTogetherAvailable(open), true);
    assert.equal(watchTogetherSocketSupported(open), true);
    for (const state of ["disabled", "not_configured", "unsupported", "future_state"]) {
        const closed = decodeWatchTogetherCapabilities({ ...base, allowed: true, state });
        assert.equal(watchTogetherAvailable(closed), false, state);
        assert.equal(watchTogetherSocketSupported(closed), false, state);
    }
    assert.equal(decodeWatchTogetherCapabilities({ ...base, state: "future_state" }).state, "unknown");
    assert.equal(watchTogetherSocketSupported(decodeWatchTogetherCapabilities({ ...base, allowed: true, socket_protocol: "silo.room.v3" })), false);
    assert.equal(watchTogetherSocketSupported(decodeWatchTogetherCapabilities({ ...base, allowed: true, connection_replaced: false })), false);
    assert.equal(watchTogetherAvailable(decodeWatchTogetherCapabilities({ state: "available" })), false, "a missing allowed is not allowed");
});

test("capabilities flags added after the first server default to false; a wrongly typed one is a contract break", () => {
    const minimal = decodeWatchTogetherCapabilities({ state: "available", allowed: true });
    assert.equal(minimal.stopPlayback, false);
    assert.equal(minimal.maxMemberStateIds, 0);
    assert.equal(minimal.socketProtocol, "");
    throwsWire(() => decodeWatchTogetherCapabilities({ state: "available", stop_playback: "yes" }), "watch_together_capabilities.stop_playback");
    throwsWire(() => decodeWatchTogetherCapabilities({ allowed: true }), "watch_together_capabilities.state");
    throwsWire(() => decodeWatchTogetherCapabilities({ state: "available", max_member_state_ids: -1 }), "watch_together_capabilities.max_member_state_ids");
});

test("a room decodes every consumed member and keeps unknown enum values as unknown", () => {
    const room = decodeRoom(roomBody({ selected_content_id: "movie:heat", selected_file_id: "41", selected_library_id: "2", attached_session_id: "s-1", phase: "paused_for_review" }));
    assert.equal(room.roomId, ROOM_ID);
    assert.equal(room.phase, "unknown");
    assert.equal(room.playbackState, "idle");
    assert.equal(room.selectionMode, "host_pick");
    assert.equal(room.code, "K7M2QX");
    assert.equal(room.anchorUpdatedAt, Date.parse("2026-11-10T01:02:03.123Z"));
    assert.equal(room.selectedContentId, "movie:heat");
    assert.equal(room.selectedFileId, "41");
    assert.equal(room.selectedLibraryId, "2");
    assert.equal(room.attachedSessionId, "s-1");
    assert.equal(room.invitePath, "/rooms/join?token=abc");
    assert.equal(room.members.length, 2);
    assert.deepEqual(room.members[1], { userId: "9", profileId: "p-me", displayName: "Me", isHost: false, isSelf: true, connected: true, isReady: true, isBuffering: false, isSyncing: false, lobbyReady: true });
    assert.equal(decodeRoom(roomBody({ selected_content_id: "" })).selectedContentId, undefined, "a migrated room can hold an empty selection");
    assert.equal(decodeRoom(roomBody({ selected_content_id: null })).selectedContentId, undefined);
    throwsWire(() => decodeRoom(roomBody({ selected_content_id: 7 })), "watch_together_room.selected_content_id");
    const bare = decodeRoom(roomBody({ members: undefined, invite_path: undefined }));
    assert.deepEqual(bare.members, []);
    assert.equal(bare.selectedContentId, undefined);
    assert.equal(bare.invitePath, undefined);
});

test("socket snapshots carry the legacy numeric ids and decode them to strings", () => {
    const room = decodeRoom(roomBody({
        selected_content_id: "episode:9",
        selected_file_id: 41,
        selected_library_id: 2,
        members: [{ user_id: 7, profile_id: "p-host", display_name: "Host", is_host: true, is_self: true, connected: true, lobby_ready: false }],
    }));
    assert.equal(room.selectedFileId, "41");
    assert.equal(room.selectedLibraryId, "2");
    assert.equal(room.members[0]?.userId, "7");
    throwsWire(() => decodeRoom(roomBody({ selected_file_id: 1.5 })), "watch_together_room.selected_file_id");
    throwsWire(() => decodeRoom(roomBody({ selected_file_id: "" })), "watch_together_room.selected_file_id");
});

test("a room with a broken identity or timeline is rejected", () => {
    throwsWire(() => decodeRoom(roomBody({ room_id: "" })), "watch_together_room.room_id");
    throwsWire(() => decodeRoom(roomBody({ room_id: undefined })), "watch_together_room.room_id");
    throwsWire(() => decodeRoom(roomBody({ selection_revision: -1 })), "watch_together_room.selection_revision");
    throwsWire(() => decodeRoom(roomBody({ generation: 1.5 })), "watch_together_room.generation");
    throwsWire(() => decodeRoom(roomBody({ generation: "3" })), "watch_together_room.generation");
    throwsWire(() => decodeRoom(roomBody({ anchor_position_seconds: -0.5 })), "watch_together_room.anchor_position_seconds");
    throwsWire(() => decodeRoom(roomBody({ anchor_position_seconds: null })), "watch_together_room.anchor_position_seconds");
    throwsWire(() => decodeRoom(roomBody({ anchor_updated_at: "not a time" })), "watch_together_room.anchor_updated_at");
    throwsWire(() => decodeRoom(roomBody({ is_paused: "false" })), "watch_together_room.is_paused");
    throwsWire(() => decodeRoom(roomBody({ members: [{ user_id: "7" }] })), "watch_together_room.members[0].profile_id");
    throwsWire(() => decodeRoom(roomBody({ members: {} })), "watch_together_room.members");
    throwsWire(() => decodeRoom("room"), "watch_together_room");
});

test("create, join and read answers pair the room with its access token", () => {
    const access = decodeRoomAccess({ room: roomBody(), room_access_token: TOKEN });
    assert.equal(access.room.roomId, ROOM_ID);
    assert.equal(access.roomAccessToken, TOKEN);
    throwsWire(() => decodeRoomAccess({ room: roomBody() }), "watch_together_room_response.room_access_token");
    throwsWire(() => decodeRoomAccess({ room: roomBody(), room_access_token: "" }), "watch_together_room_response.room_access_token");
    throwsWire(() => decodeRoomAccess({ room_access_token: TOKEN }), "watch_together_room_response.room");
});

test("decode errors never echo the offending value", () => {
    try {
        decodeRoomAccess({ room: roomBody({ code: 42 }), room_access_token: TOKEN });
        assert.fail("expected a WireError");
    } catch (error) {
        assert.ok(error instanceof WireError);
        assert.ok(!error.message.includes(TOKEN));
        assert.ok(!error.message.includes("42"));
    }
});

test("a socket ticket must name silo.room.v2 and be safe as a subprotocol", () => {
    const body = { ticket: "Ab3_-xYz", expires_in: 30, max_connection_seconds: 3600, protocol: "silo.room.v2" };
    assert.deepEqual(decodeRoomSocketTicket(body), { ticket: "Ab3_-xYz", expiresIn: 30, maxConnectionSeconds: 3600 });
    assert.equal(decodeRoomSocketTicket({ ...body, expires_in: 0 }).expiresIn, 0, "the server clamps an about-to-expire bearer to 0");
    throwsWire(() => decodeRoomSocketTicket({ ...body, protocol: "silo.room.v1" }), "watch_together_socket_ticket.protocol");
    throwsWire(() => decodeRoomSocketTicket({ ...body, ticket: "" }), "watch_together_socket_ticket.ticket");
    for (const ticket of ["a b", "a,b", "a\nb", "a.b", "é"]) throwsWire(() => decodeRoomSocketTicket({ ...body, ticket }), "watch_together_socket_ticket.ticket");
    throwsWire(() => decodeRoomSocketTicket({ ...body, max_connection_seconds: 0 }), "watch_together_socket_ticket.max_connection_seconds");
    throwsWire(() => decodeRoomSocketTicket({ ...body, expires_in: -1 }), "watch_together_socket_ticket.expires_in");
});

test("the socket handshake offers the protocol first, then the ticket, on the server's path prefix", () => {
    const ticket = { ticket: "Ab3_-xYz", expiresIn: 30, maxConnectionSeconds: 3600 };
    assert.deepEqual(roomSocketHandshake("https://silo.example.test/media/api/v2", ROOM_ID, ticket), {
        url: `wss://silo.example.test/media/api/v2/watch-together/rooms/${ROOM_ID}/ws`,
        protocols: ["silo.room.v2", "silo.ticket.Ab3_-xYz"],
    });
    assert.equal(roomSocketHandshake("http://192.168.1.20:8091/api/v2", "a/b", ticket).url, "ws://192.168.1.20:8091/api/v2/watch-together/rooms/a%2Fb/ws");
    assert.throws(() => roomSocketHandshake("ftp://silo.example.test/api/v2", ROOM_ID, ticket), RangeError);
    assert.throws(() => roomSocketHandshake("https://silo.example.test/api/v2", "", ticket), RangeError);
});

test("server frames decode by type", () => {
    const snapshot = decodeRoomServerMessage({ type: "snapshot", room: roomBody({ selected_file_id: 41 }) });
    assert.ok(snapshot.type === "snapshot");
    assert.equal(snapshot.room.selectedFileId, "41");

    const command = decodeRoomServerMessage({
        type: "transport_command",
        command: { command_id: "c-1", selection_revision: 2, action: "seek", position_seconds: 61.5, execute_at: "2026-11-10T01:02:03.123456789Z", issued_at: "2026-11-10T01:02:02.5Z", playback_state: "waiting" },
    });
    assert.ok(command.type === "transport_command");
    assert.deepEqual(command.command, {
        commandId: "c-1",
        sessionId: undefined,
        selectionRevision: 2,
        action: "seek",
        positionSeconds: 61.5,
        executeAt: Date.parse("2026-11-10T01:02:03.123Z"),
        issuedAt: Date.parse("2026-11-10T01:02:02.5Z"),
        playbackState: "waiting",
    });

    const pong = decodeRoomServerMessage({ type: "pong", client_sent_at: "2026-11-10T01:00:00.000Z", server_received_at: "2026-11-10T01:00:00.050123456Z", server_sent_at: "2026-11-10T01:00:00.051Z" });
    assert.deepEqual(pong, { type: "pong", clientSentAt: Date.parse("2026-11-10T01:00:00Z"), serverReceivedAt: Date.parse("2026-11-10T01:00:00.050Z"), serverSentAt: Date.parse("2026-11-10T01:00:00.051Z") });

    assert.deepEqual(decodeRoomServerMessage({ type: "room_closed", reason: "host_left" }), { type: "room_closed", reason: "host_left" });
    assert.deepEqual(decodeRoomServerMessage({ type: "room_closed" }), { type: "room_closed", reason: "ended" });
    assert.deepEqual(decodeRoomServerMessage({ type: "connection_replaced", reason: "This profile joined the Watch Party on another device." }), { type: "connection_replaced", reason: "This profile joined the Watch Party on another device." });
    assert.deepEqual(decodeRoomServerMessage({ type: "connection_replaced" }), { type: "connection_replaced", reason: undefined });
    assert.deepEqual(decodeRoomServerMessage({ type: "error", code: "bad_request", message: "session_id is required" }), { type: "error", code: "bad_request", message: "session_id is required" });
    assert.deepEqual(decodeRoomServerMessage({ type: "future_frame", anything: 1 }), { type: "unknown" });
});

test("a command addressed to one session and an unknown action both decode", () => {
    const base = { command_id: "c-2", session_id: "s-1", selection_revision: 0, position_seconds: 0, execute_at: "2026-11-10T01:02:03Z", issued_at: "2026-11-10T01:02:03Z", playback_state: "playing" };
    const targeted = decodeRoomServerMessage({ type: "transport_command", command: { ...base, action: "play" } });
    assert.ok(targeted.type === "transport_command");
    assert.equal(targeted.command.sessionId, "s-1");
    const future = decodeRoomServerMessage({ type: "transport_command", command: { ...base, action: "rewind" } });
    assert.ok(future.type === "transport_command");
    assert.equal(future.command.action, "unknown");
    throwsWire(() => decodeRoomServerMessage({ type: "transport_command", command: { ...base, action: "play", position_seconds: Number.NaN } }), "watch_together_frame.command.position_seconds");
    throwsWire(() => decodeRoomServerMessage({ type: "transport_command", command: { ...base, action: "play", execute_at: "soon" } }), "watch_together_frame.command.execute_at");
    throwsWire(() => decodeRoomServerMessage({ type: "transport_command", command: { ...base, action: "play", command_id: "" } }), "watch_together_frame.command.command_id");
});

test("a suggestions update decodes the broadcast rows, tolerating the legacy numeric suggester id", () => {
    const row = { id: "sg-1", room_id: ROOM_ID, suggester_user_id: 7, suggester_profile_id: "p-host", content_id: "movie:heat", content_type: "movie", title: "Heat", vote_count: 2, voted_by_me: false, created_at: "2026-11-10T01:02:03.5Z" };
    const update = decodeRoomServerMessage({ type: "suggestions_update", suggestions: [row, { ...row, id: "sg-2", subtitle: "1995", poster_url: "/api/v2/artwork/k?exp=1&sig=2", note: "Friday?" }] });
    assert.ok(update.type === "suggestions_update");
    assert.equal(update.suggestions.length, 2);
    assert.deepEqual(update.suggestions[0], {
        id: "sg-1", roomId: ROOM_ID, suggesterUserId: "7", suggesterProfileId: "p-host", contentId: "movie:heat", contentType: "movie", title: "Heat",
        subtitle: "", posterUrl: "", note: "", voteCount: 2, votedByMe: false, createdAt: Date.parse("2026-11-10T01:02:03.5Z"),
    });
    assert.equal(update.suggestions[1]?.posterUrl, "/api/v2/artwork/k?exp=1&sig=2");
    assert.deepEqual(decodeRoomServerMessage({ type: "suggestions_update", suggestions: [] }), { type: "suggestions_update", suggestions: [] });
    throwsWire(() => decodeRoomServerMessage({ type: "suggestions_update" }), "watch_together_frame.suggestions");
    throwsWire(() => decodeRoomServerMessage({ type: "suggestions_update", suggestions: [{ ...row, vote_count: -1 }] }), "watch_together_frame.suggestions[0].vote_count");
});

test("a frame must be JSON with a string type", () => {
    assert.deepEqual(parseRoomServerMessage('{"type":"room_closed","reason":"not_found"}'), { type: "room_closed", reason: "not_found" });
    throwsWire(() => parseRoomServerMessage("{"), "watch_together_frame");
    throwsWire(() => parseRoomServerMessage("[]"), "watch_together_frame");
    throwsWire(() => parseRoomServerMessage("{}"), "watch_together_frame.type");
    throwsWire(() => parseRoomServerMessage('{"type":7}'), "watch_together_frame.type");
    throwsWire(() => parseRoomServerMessage('{"type":"snapshot"}'), "watch_together_frame.room");
    throwsWire(() => parseRoomServerMessage('{"type":"error","code":"x"}'), "watch_together_frame.message");
});

test("client frames use the server's member names and omit what is not set", () => {
    const encode = (message: Parameters<typeof encodeRoomClientMessage>[0]): unknown => JSON.parse(encodeRoomClientMessage(message));
    assert.deepEqual(encode({ type: "attach_session", sessionId: "s-1" }), { type: "attach_session", session_id: "s-1" });
    assert.deepEqual(encode({ type: "transport_request", action: "seek", positionSeconds: 120.5, isPaused: false }), { type: "transport_request", action: "seek", position_seconds: 120.5, is_paused: false });
    assert.deepEqual(encode({ type: "transport_request", action: "pause", isPaused: true }), { type: "transport_request", action: "pause", is_paused: true });
    assert.deepEqual(encode({ type: "state_report", sessionId: "s-1", positionSeconds: 10, isPaused: false, commandId: "c-1", isReady: true }), { type: "state_report", session_id: "s-1", position_seconds: 10, is_paused: false, command_id: "c-1", is_ready: true });
    assert.deepEqual(encode({ type: "state_report", sessionId: "s-1", positionSeconds: 0, isPaused: true }), { type: "state_report", session_id: "s-1", position_seconds: 0, is_paused: true });
    assert.deepEqual(encode({ type: "ready", sessionId: "s-1", positionSeconds: 3, isPaused: true, commandId: "c-2" }), { type: "ready", session_id: "s-1", position_seconds: 3, is_paused: true, command_id: "c-2" });
    assert.deepEqual(encode({ type: "buffering", sessionId: "s-1", positionSeconds: 3, isPaused: true }), { type: "buffering", session_id: "s-1", position_seconds: 3, is_paused: true });
    assert.deepEqual(encode({ type: "lobby_ready", ready: true }), { type: "lobby_ready", ready: true });
    assert.deepEqual(encode({ type: "ping", clientSentAt: Date.parse("2026-11-10T01:00:00.250Z") }), { type: "ping", client_sent_at: "2026-11-10T01:00:00.250Z" });
});

test("a ping's echoed timestamp decodes back to the instant it was sent", () => {
    const sentAt = Date.parse("2026-11-10T01:00:00.250Z");
    const sent: unknown = JSON.parse(encodeRoomClientMessage({ type: "ping", clientSentAt: sentAt }));
    assert.ok(typeof sent === "object" && sent !== null && "client_sent_at" in sent);
    const pong = decodeRoomServerMessage({ type: "pong", client_sent_at: sent.client_sent_at, server_received_at: "2026-11-10T01:00:00.300Z", server_sent_at: "2026-11-10T01:00:00.301Z" });
    assert.ok(pong.type === "pong");
    assert.equal(pong.clientSentAt, sentAt);
});

test("client frames refuse an empty session or a position that is not a finite non-negative number", () => {
    assert.throws(() => encodeRoomClientMessage({ type: "attach_session", sessionId: "" }), RangeError);
    for (const positionSeconds of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(() => encodeRoomClientMessage({ type: "state_report", sessionId: "s-1", positionSeconds, isPaused: false }), RangeError);
        assert.throws(() => encodeRoomClientMessage({ type: "ready", sessionId: "s-1", positionSeconds, isPaused: false }), RangeError);
        assert.throws(() => encodeRoomClientMessage({ type: "buffering", sessionId: "s-1", positionSeconds, isPaused: false }), RangeError);
        assert.throws(() => encodeRoomClientMessage({ type: "transport_request", action: "seek", positionSeconds, isPaused: false }), RangeError);
    }
});

test("operations name the contract's paths, methods and retry classes", () => {
    const capabilities = operations.capabilities();
    assert.deepEqual([capabilities.method, capabilities.path, capabilities.retry, capabilities.body], ["GET", "/watch-together/capabilities", "safe", undefined]);

    const create = operations.createRoom(ROOM_ID, "vote");
    assert.deepEqual([create.method, create.path, create.retry], ["POST", "/watch-together/rooms", "safe"]);
    assert.deepEqual(create.body, { room_id: ROOM_ID, selection_mode: "vote" });

    const join = operations.joinByCode("  K7M2QX ");
    assert.deepEqual([join.method, join.path, join.retry], ["POST", "/watch-together/join", "safe"]);
    assert.deepEqual(join.body, { code: "K7M2QX" });

    const room = operations.room(ROOM_ID, TOKEN);
    assert.deepEqual([room.method, room.path, room.retry, room.roomToken, room.body], ["GET", `/watch-together/rooms/${ROOM_ID}`, "safe", TOKEN, undefined]);

    const close = operations.closeRoom(ROOM_ID);
    assert.deepEqual([close.method, close.path, close.retry, close.roomToken], ["DELETE", `/watch-together/rooms/${ROOM_ID}`, "safe", undefined]);
    assert.equal(close.decode(undefined), undefined);

    const ticket = operations.socketTicket(ROOM_ID, TOKEN);
    assert.deepEqual([ticket.method, ticket.path, ticket.retry, ticket.roomToken, ticket.body], ["POST", `/watch-together/rooms/${ROOM_ID}/ws-ticket`, "safe", TOKEN, undefined]);
});

test("operations refuse malformed identities before anything is sent", () => {
    assert.throws(() => operations.createRoom("not-a-uuid", "host_pick"), RangeError);
    assert.throws(() => operations.joinByCode("   "), RangeError);
    assert.throws(() => operations.joinByCode("x".repeat(129)), RangeError);
    assert.equal(operations.joinByCode("x".repeat(128)).body?.code, "x".repeat(128));
    assert.throws(() => operations.room("", TOKEN), RangeError);
    assert.equal(operations.room("a/b ?", TOKEN).path, "/watch-together/rooms/a%2Fb%20%3F");
    for (const token of ["", "a b", "a\r\nX-Evil: 1", "é", "x".repeat(4097)]) {
        assert.throws(() => operations.room(ROOM_ID, token), RangeError, JSON.stringify(token));
        assert.throws(() => operations.socketTicket(ROOM_ID, token), RangeError);
    }
    assert.equal(operations.room(ROOM_ID, "x".repeat(4096)).roomToken?.length, 4096);
});

test("the transport sends the room token and profile proof, and decodes room, ticket and 204 answers", async () => {
    const clock = new ManualClock();
    const sent: { method: string; url: string; headers: Record<string, string>; body: string | null }[] = [];
    const answers = [
        () => new Response(JSON.stringify({ room: roomBody(), room_access_token: TOKEN }), { status: 201, headers: { "Content-Type": "application/json" } }),
        () => new Response(JSON.stringify({ room: roomBody(), room_access_token: `${TOKEN}2` }), { status: 200, headers: { "Content-Type": "application/json" } }),
        () => new Response(JSON.stringify({ ticket: "Ab3_-xYz", expires_in: 30, max_connection_seconds: 3600, protocol: "silo.room.v2" }), { status: 200, headers: { "Content-Type": "application/json" } }),
        () => new Response(null, { status: 204 }),
    ];
    const fetchStub = (url: string, init: RequestInit): Promise<Response> => {
        sent.push({ method: String(init.method), url, headers: { ...(init.headers as Record<string, string>) }, body: typeof init.body === "string" ? init.body : null });
        const answer = answers.shift();
        assert.ok(answer !== undefined, "an unexpected extra request");
        return Promise.resolve(answer());
    };
    const parsed = parseServerUrl("https://silo.example.test/media");
    assert.ok(parsed.ok);
    const http = new NativeHttp(parsed.base, { id: "abababab", name: "Living room TV", platform: "tizen" }, fetchStub, clock);
    const profile = { id: "p-me", token: undefined };

    const created = await http.send({ ...operations.createRoom(ROOM_ID, "host_pick"), bearer: "access", profile });
    assert.equal(created.roomAccessToken, TOKEN);
    const read = await http.send({ ...operations.room(ROOM_ID, TOKEN), bearer: "access", profile });
    assert.equal(read.roomAccessToken, `${TOKEN}2`);
    const ticket = await http.send({ ...operations.socketTicket(ROOM_ID, TOKEN), bearer: "access", profile });
    assert.equal(ticket.ticket, "Ab3_-xYz");
    assert.equal(await http.send({ ...operations.closeRoom(ROOM_ID), bearer: "access", profile }), undefined);

    assert.deepEqual(sent.map(request => [request.method, request.url]), [
        ["POST", "https://silo.example.test/media/api/v2/watch-together/rooms"],
        ["GET", `https://silo.example.test/media/api/v2/watch-together/rooms/${ROOM_ID}`],
        ["POST", `https://silo.example.test/media/api/v2/watch-together/rooms/${ROOM_ID}/ws-ticket`],
        ["DELETE", `https://silo.example.test/media/api/v2/watch-together/rooms/${ROOM_ID}`],
    ]);
    assert.equal(sent[0]?.headers["X-Room-Token"], undefined, "creating a room has no proof yet");
    assert.equal(sent[0]?.body, JSON.stringify({ room_id: ROOM_ID, selection_mode: "host_pick" }));
    for (const request of sent) {
        assert.equal(request.headers["X-Profile-Id"], "p-me");
        assert.equal(request.headers.Authorization, "Bearer access");
    }
    for (const request of sent.slice(1, 3)) assert.equal(request.headers["X-Room-Token"], TOKEN);
    assert.equal(sent[3]?.headers["X-Room-Token"], undefined, "closing a room is by host account and profile");
    for (const request of sent.slice(1)) assert.equal(request.body, null);
});
