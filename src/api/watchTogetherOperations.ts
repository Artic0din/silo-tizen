// The /api/v2/watch-together operations Apple's tvOS Watch Party uses for a lobby: capabilities,
// create, join by code, room read, close and the room socket ticket.
// Pass each spec to `session.call({ ...spec, profileScoped: true })`; the session owns bearer,
// profile proof and cancellation. Read `capabilities()` first and offer nothing unless
// `watchTogetherAvailable` holds (see ../contracts/v2/watchTogether.ts).
//
// Retry classes are the contract's x-silo-retry-safety. `create` is unique_constraint: the caller's
// room_id makes an exact replay return the same room, so it may be resent. A guest has no HTTP
// leave; leaving is closing the room socket. `close` ends the room and is host-only.

import {
    type CreatableSelectionMode,
    decodeRoomAccess,
    decodeRoomSocketTicket,
    decodeWatchTogetherCapabilities,
    MAX_JOIN_CODE_LENGTH,
    MAX_ROOM_TOKEN_LENGTH,
    type RoomAccess,
    type RoomSocketTicket,
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
};
