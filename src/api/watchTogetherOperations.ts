// The /api/v2/watch-together operations Apple's tvOS Watch Party uses for a lobby: capabilities,
// create, join by code, room read, close, the room socket ticket, the host's lobby calls (stage,
// select, start, stop, mode, policy), the picker and the vote-mode ballot (suggestions and votes).
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
    decodeSuggestionPage,
    decodeSuggestionReceipt,
    decodeWatchTogetherCapabilities,
    MAX_JOIN_CODE_LENGTH,
    MAX_ROOM_TOKEN_LENGTH,
    type Picker,
    type RoomAccess,
    type RoomSelection,
    type RoomSocketTicket,
    type GuestControlPolicy,
    type NewSuggestion,
    type SuggestionPage,
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

function suggestionPath(roomId: string, suggestionId: string): string {
    if (suggestionId === "") throw new RangeError("Suggestion id is required");
    return `${roomPath(roomId)}/suggestions/${encodeURIComponent(suggestionId)}`;
}

/** Apple reads the ballot 100 rows at a time. */
const SUGGESTION_PAGE_LIMIT = 100;

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

    // The ballot, for any member: every call needs the room token. Votes and suggestions change no room, so only promote answers with it.

    /** One page of the room's suggestions in creation order, with this profile's own votes, which the socket never carries. */
    suggestions: (roomId: string, token: string, cursor?: string): RequestSpec<SuggestionPage> => ({
        method: "GET",
        path: `${roomPath(roomId)}/suggestions?${new URLSearchParams({ limit: String(SUGGESTION_PAGE_LIMIT), ...(cursor === undefined ? {} : { cursor }) }).toString()}`,
        retry: "safe", roomToken: roomToken(token), decode: decodeSuggestionPage,
    }),

    /** Unique-constraint: the caller's suggestion id makes a resend return the same suggestion. 201 with the id. */
    addSuggestion: (roomId: string, token: string, suggestion: NewSuggestion): RequestSpec<string> => {
        if (!UUID.test(suggestion.suggestionId)) throw new RangeError("Suggestion id must be a UUID");
        if (suggestion.contentId === "" || suggestion.title === "") throw new RangeError("A suggestion needs a title and content id");
        return {
            method: "POST", path: `${roomPath(roomId)}/suggestions`, retry: "safe", roomToken: roomToken(token),
            body: {
                suggestion_id: suggestion.suggestionId, content_id: suggestion.contentId, content_type: suggestion.contentType, title: suggestion.title,
                ...(suggestion.subtitle === undefined || suggestion.subtitle === "" ? {} : { subtitle: suggestion.subtitle }),
                ...(suggestion.posterUrl === undefined || suggestion.posterUrl === "" ? {} : { poster_url: suggestion.posterUrl }),
            },
            decode: decodeSuggestionReceipt,
        };
    },

    /** POST votes, DELETE takes the vote back; 204 either way, and a vote already in that state is a no-op. */
    setVote: (roomId: string, token: string, suggestionId: string, voted: boolean): RequestSpec<undefined> =>
        ({ method: voted ? "POST" : "DELETE", path: `${suggestionPath(roomId, suggestionId)}/vote`, retry: "safe", roomToken: roomToken(token), decode: () => undefined }),

    /** Host only: plays the suggestion for everyone. Non-retryable; a lost answer is read back from the room. */
    promoteSuggestion: (roomId: string, token: string, suggestionId: string): RequestSpec<RoomAccess> => {
        if (suggestionId === "") throw new RangeError("Suggestion id is required");
        return { method: "POST", path: `${roomPath(roomId)}/suggestions/promote`, retry: "never", roomToken: roomToken(token), body: { suggestion_id: suggestionId }, decode: decodeRoomAccess };
    },
};
