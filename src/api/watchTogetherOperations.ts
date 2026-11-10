// The /api/v2/watch-together operations Apple's tvOS Watch Party uses for a lobby: capabilities,
// create, join by code, room read, close, the room socket ticket, and the host's lobby calls (stage,
// select, start, stop, mode, policy) and picker.
// Pass each spec to `session.call({ ...spec, profileScoped: true })`; the session owns bearer,
// profile proof and cancellation. Read `capabilities()` first and offer nothing unless
// `watchTogetherAvailable` holds (see ../contracts/v2/watchTogether.ts).
//
// Retry classes are the contract's x-silo-retry-safety. `create` is unique_constraint: the caller's
// room_id makes an exact replay return the same room, so it may be resent. A guest has no HTTP
// leave; leaving is closing the room socket. `close` ends the room and is host-only.

import {
    type CreatableSelectionMode,
    decodePicker,
    decodeRoomAccess,
    decodeRoomSocketTicket,
    decodeWatchTogetherCapabilities,
    MAX_JOIN_CODE_LENGTH,
    MAX_ROOM_TOKEN_LENGTH,
    type Picker,
    type RoomAccess,
    type RoomSelection,
    type RoomSocketTicket,
    type GuestControlPolicy,
    type WatchTogetherCapabilities,
} from "../contracts/v2/watchTogether.ts";
import type { RequestSpec } from "./http.ts";

const BASE = "/watch-together";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A room token is a JWT; this keeps it a legal header value.
const HEADER_SAFE = /^[\x21-\x7e]+$/;

function roomPath(roomId: string): string {
    if (roomId === "") throw new RangeError("Room id is required");
    return `${BASE}/rooms/${encodeURIComponent(roomId)}`;
}

const POSITIVE_ID = /^[1-9][0-9]*$/;

/** The body of a staged or live selection: a content id, and the file and library only when they are positive ids. */
function selectionBody(selection: RoomSelection): { content_id: string; file_id?: string; library_id?: string } {
    if (selection.contentId === "") throw new RangeError("Content id is required");
    for (const id of [selection.fileId, selection.libraryId]) if (id !== undefined && !POSITIVE_ID.test(id)) throw new RangeError("File and library ids must be positive");
    return { content_id: selection.contentId, ...(selection.fileId === undefined ? {} : { file_id: selection.fileId }), ...(selection.libraryId === undefined ? {} : { library_id: selection.libraryId }) };
}

function roomToken(token: string): string {
    if (token.length > MAX_ROOM_TOKEN_LENGTH || !HEADER_SAFE.test(token)) throw new RangeError("Invalid room token");
    return token;
}

export const watchTogetherOperations = {
    capabilities: (): RequestSpec<WatchTogetherCapabilities> => ({ method: "GET", path: `${BASE}/capabilities`, retry: "safe", decode: decodeWatchTogetherCapabilities }),

    /** `roomId` is a UUID the caller generates once per create attempt and reuses on any resend. */
    createRoom: (roomId: string, selectionMode: CreatableSelectionMode): RequestSpec<RoomAccess> => {
        if (!UUID.test(roomId)) throw new RangeError("Room id must be a UUID");
        return { method: "POST", path: `${BASE}/rooms`, retry: "safe", body: { room_id: roomId, selection_mode: selectionMode }, decode: decodeRoomAccess };
    },

    joinByCode: (code: string): RequestSpec<RoomAccess> => {
        const trimmed = code.trim();
        if (trimmed === "" || trimmed.length > MAX_JOIN_CODE_LENGTH) throw new RangeError("Invalid room code");
        return { method: "POST", path: `${BASE}/join`, retry: "safe", body: { code: trimmed }, decode: decodeRoomAccess };
    },

    /** The lobby state. The answer carries a fresh room token. */
    room: (roomId: string, token: string): RequestSpec<RoomAccess> =>
        ({ method: "GET", path: roomPath(roomId), retry: "safe", roomToken: roomToken(token), decode: decodeRoomAccess }),

    /** Host only, by account and profile: the contract takes no room token. Ends the room for everyone. 204 with no body; 409 when it already ended. */
    closeRoom: (roomId: string): RequestSpec<undefined> =>
        ({ method: "DELETE", path: roomPath(roomId), retry: "safe", decode: () => undefined }),

    /** A single-use ticket for one socket connection; mint a new one for every reconnect. */
    socketTicket: (roomId: string, token: string): RequestSpec<RoomSocketTicket> =>
        ({ method: "POST", path: `${roomPath(roomId)}/ws-ticket`, retry: "safe", roomToken: roomToken(token), decode: decodeRoomSocketTicket }),

    // The calls below are host-only, by account and profile: the contract takes no room token, and each answers with the room as it now stands.

    /** Lobby, host-pick rooms: stages a title for everyone to see. Natural-idempotent, so a lost answer may be resent. */
    stageSelection: (roomId: string, selection: RoomSelection): RequestSpec<RoomAccess> =>
        ({ method: "PUT", path: `${roomPath(roomId)}/staged-selection`, retry: "safe", body: selectionBody(selection), decode: decodeRoomAccess }),

    /** Chooses a title for a party that is already playing, which starts it for everyone. Non-retryable. */
    selectItem: (roomId: string, selection: RoomSelection): RequestSpec<RoomAccess> =>
        ({ method: "PUT", path: `${roomPath(roomId)}/selection`, retry: "never", body: selectionBody(selection), decode: decodeRoomAccess }),

    /** Starts the staged title for everyone. Non-retryable: callers read the room again after a lost answer. */
    startPlayback: (roomId: string): RequestSpec<RoomAccess> =>
        ({ method: "POST", path: `${roomPath(roomId)}/playback/start`, retry: "never", decode: decodeRoomAccess }),

    /** Returns everyone to the lobby. */
    stopPlayback: (roomId: string): RequestSpec<RoomAccess> =>
        ({ method: "POST", path: `${roomPath(roomId)}/playback/stop`, retry: "safe", decode: decodeRoomAccess }),

    setSelectionMode: (roomId: string, mode: CreatableSelectionMode): RequestSpec<RoomAccess> =>
        ({ method: "PATCH", path: `${roomPath(roomId)}/selection-mode`, retry: "safe", body: { selection_mode: mode }, decode: decodeRoomAccess }),

    setGuestControlPolicy: (roomId: string, policy: Exclude<GuestControlPolicy, "unknown">): RequestSpec<RoomAccess> =>
        ({ method: "PATCH", path: `${roomPath(roomId)}/policy`, retry: "safe", body: { guest_control_policy: policy }, decode: decodeRoomAccess }),

    /** What the connected members are mid-way through and what is on their watchlists. Needs the room token. */
    picker: (roomId: string, token: string): RequestSpec<Picker> =>
        ({ method: "GET", path: `${roomPath(roomId)}/picker`, retry: "safe", roomToken: roomToken(token), decode: decodePicker }),
};
