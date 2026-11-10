// Watch Together (Apple's Watch Party): the /api/v2/watch-together documents and the silo.room.v2
// socket frames. HTTP bodies follow openapi.json at SOURCE. Socket frames are not in OpenAPI; they
// follow internal/watchtogether and internal/api/handlers/watch_together.go at the same commit and
// Apple's WatchPartyServerMessage / WatchPartyClientMessage.
// Socket frames still carry the legacy numeric user, file and library ids, so those members accept
// a string or an integer and decode to a string, as Apple's decoders do.

import { boolean, instant, integer, nonEmptyString, object, string, WireError } from "./wire.ts";

type Obj = ReturnType<typeof object>;

export const ROOM_SOCKET_PROTOCOL = "silo.room.v2";
/** Longest join code the server accepts (WatchTogetherJoinInputBody.code). */
export const MAX_JOIN_CODE_LENGTH = 128;
/** Longest X-Room-Token the server accepts. */
export const MAX_ROOM_TOKEN_LENGTH = 4096;

const CAPABILITY_STATES = ["available", "disabled", "not_configured", "unsupported"] as const;
const PHASES = ["lobby", "playing", "ended"] as const;
const PLAYBACK_STATES = ["idle", "waiting", "paused", "playing"] as const;
const SELECTION_MODES = ["host_pick", "vote"] as const;
const GUEST_CONTROL_POLICIES = ["host_only", "guest_play_pause"] as const;
const MEMBER_ROLES = ["host", "guest"] as const;
const TRANSPORT_ACTIONS = ["play", "pause", "seek"] as const;

export type CapabilityState = (typeof CAPABILITY_STATES)[number] | "unknown";
export type RoomPhase = (typeof PHASES)[number] | "unknown";
export type RoomPlaybackState = (typeof PLAYBACK_STATES)[number] | "unknown";
export type SelectionMode = (typeof SELECTION_MODES)[number] | "unknown";
export type GuestControlPolicy = (typeof GUEST_CONTROL_POLICIES)[number] | "unknown";
export type MemberRole = (typeof MEMBER_ROLES)[number] | "unknown";
export type TransportAction = (typeof TRANSPORT_ACTIONS)[number] | "unknown";
/** The modes a client may ask a room to use. */
export type CreatableSelectionMode = Exclude<SelectionMode, "unknown">;
/** The actions a client may request over the socket. */
export type RequestableTransportAction = Exclude<TransportAction, "unknown">;

function additiveEnum<T extends string>(raw: string, known: readonly T[]): T | "unknown" {
    return known.find(value => value === raw) ?? "unknown";
}

function enumField<T extends string>(obj: Obj, key: string, path: string, known: readonly T[]): T | "unknown" {
    return additiveEnum(string(obj, key, path), known);
}

function optionalBoolean(obj: Obj, key: string, path: string): boolean {
    return obj[key] === undefined ? false : boolean(obj, key, path);
}

function nonNegativeNumber(obj: Obj, key: string, path: string): number {
    const value = obj[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new WireError(`${path}.${key}`, "a finite non-negative number");
    return value;
}

function nonNegativeInteger(obj: Obj, key: string, path: string): number {
    const value = integer(obj, key, path);
    if (value < 0) throw new WireError(`${path}.${key}`, "a non-negative integer");
    return value;
}

function array(obj: Obj, key: string, path: string): unknown[] {
    const value = obj[key];
    if (!Array.isArray(value)) throw new WireError(`${path}.${key}`, "an array");
    return value;
}

/** An opaque id: a non-empty string, or the legacy integer form. */
function opaqueId(obj: Obj, key: string, path: string): string {
    const value = obj[key];
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
    return nonEmptyString(obj, key, path);
}

function optionalOpaqueId(obj: Obj, key: string, path: string): string | undefined {
    return obj[key] === undefined || obj[key] === null ? undefined : opaqueId(obj, key, path);
}

function optionalString(obj: Obj, key: string, path: string): string | undefined {
    return obj[key] === undefined || obj[key] === null ? undefined : string(obj, key, path);
}

function optionalNonEmptyString(obj: Obj, key: string, path: string): string | undefined {
    return obj[key] === undefined || obj[key] === null ? undefined : nonEmptyString(obj, key, path);
}

// --- Capabilities ---

export interface WatchTogetherCapabilities {
    readonly revision: string;
    readonly state: CapabilityState;
    /** A missing flag is false: only an explicit true allows the principal. */
    readonly allowed: boolean;
    readonly stagedSelection: boolean;
    readonly lobbyReady: boolean;
    readonly connectionReplaced: boolean;
    readonly selectionModeSwitch: boolean;
    readonly memberState: boolean;
    readonly picker: boolean;
    readonly voteHostOverride: boolean;
    readonly stopPlayback: boolean;
    readonly maxMemberStateIds: number;
    readonly socketProtocol: string;
}

export function decodeWatchTogetherCapabilities(value: unknown): WatchTogetherCapabilities {
    const path = "watch_together_capabilities";
    const body = object(value, path);
    return {
        revision: body.revision === undefined ? "" : string(body, "revision", path),
        state: enumField(body, "state", path, CAPABILITY_STATES),
        allowed: optionalBoolean(body, "allowed", path),
        stagedSelection: optionalBoolean(body, "staged_selection", path),
        lobbyReady: optionalBoolean(body, "lobby_ready", path),
        connectionReplaced: optionalBoolean(body, "connection_replaced", path),
        selectionModeSwitch: optionalBoolean(body, "selection_mode_switch", path),
        memberState: optionalBoolean(body, "member_state", path),
        picker: optionalBoolean(body, "picker", path),
        voteHostOverride: optionalBoolean(body, "vote_host_override", path),
        stopPlayback: optionalBoolean(body, "stop_playback", path),
        maxMemberStateIds: body.max_member_state_ids === undefined ? 0 : nonNegativeInteger(body, "max_member_state_ids", path),
        socketProtocol: body.socket_protocol === undefined ? "" : string(body, "socket_protocol", path),
    };
}

/** Every Watch Together entry point is hidden unless this holds. */
export function watchTogetherAvailable(capabilities: WatchTogetherCapabilities): boolean {
    return capabilities.state === "available" && capabilities.allowed;
}

/**
 * Whether live rooms can run: the room socket speaks the protocol this client implements and
 * announces a displaced connection before it closes, as Apple requires before it joins a room.
 */
export function watchTogetherSocketSupported(capabilities: WatchTogetherCapabilities): boolean {
    return watchTogetherAvailable(capabilities) && capabilities.socketProtocol === ROOM_SOCKET_PROTOCOL && capabilities.connectionReplaced;
}

// --- Room ---

export interface RoomMember {
    readonly userId: string;
    readonly profileId: string;
    readonly displayName: string;
    readonly isHost: boolean;
    readonly isSelf: boolean;
    readonly connected: boolean;
    readonly isReady: boolean;
    readonly isBuffering: boolean;
    readonly isSyncing: boolean;
    readonly lobbyReady: boolean;
}

export interface Room {
    readonly roomId: string;
    readonly phase: RoomPhase;
    readonly playbackState: RoomPlaybackState;
    readonly selectionMode: SelectionMode;
    readonly selectionRevision: number;
    readonly selectedContentId: string | undefined;
    readonly selectedFileId: string | undefined;
    readonly selectedLibraryId: string | undefined;
    /** The code a guest types to join. */
    readonly code: string;
    readonly guestControlPolicy: GuestControlPolicy;
    readonly isPaused: boolean;
    readonly anchorPositionSeconds: number;
    /** Epoch milliseconds. */
    readonly anchorUpdatedAt: number;
    readonly generation: number;
    readonly memberCount: number;
    readonly hostConnected: boolean;
    readonly selfRole: MemberRole;
    readonly selfCanControlTransport: boolean;
    readonly selfCanManageRoom: boolean;
    readonly selfIgnoreWait: boolean;
    readonly attachedSessionId: string | undefined;
    readonly invitePath: string | undefined;
    readonly members: readonly RoomMember[];
}

/** A room read, create or join answer. The token is proof of membership; never log or persist it. */
export interface RoomAccess {
    readonly room: Room;
    readonly roomAccessToken: string;
}

export function decodeRoomMember(value: unknown, path = "watch_together_member"): RoomMember {
    const body = object(value, path);
    return {
        userId: opaqueId(body, "user_id", path),
        profileId: string(body, "profile_id", path),
        displayName: string(body, "display_name", path),
        isHost: boolean(body, "is_host", path),
        isSelf: boolean(body, "is_self", path),
        connected: boolean(body, "connected", path),
        isReady: optionalBoolean(body, "is_ready", path),
        isBuffering: optionalBoolean(body, "is_buffering", path),
        isSyncing: optionalBoolean(body, "is_syncing", path),
        lobbyReady: optionalBoolean(body, "lobby_ready", path),
    };
}

export function decodeRoom(value: unknown, path = "watch_together_room"): Room {
    const body = object(value, path);
    return {
        roomId: nonEmptyString(body, "room_id", path),
        phase: enumField(body, "phase", path, PHASES),
        playbackState: enumField(body, "playback_state", path, PLAYBACK_STATES),
        selectionMode: enumField(body, "selection_mode", path, SELECTION_MODES),
        selectionRevision: nonNegativeInteger(body, "selection_revision", path),
        // A room migrated from the legacy content_id column can hold "", which means nothing is selected.
        selectedContentId: optionalString(body, "selected_content_id", path) || undefined,
        selectedFileId: optionalOpaqueId(body, "selected_file_id", path),
        selectedLibraryId: optionalOpaqueId(body, "selected_library_id", path),
        code: string(body, "code", path),
        guestControlPolicy: enumField(body, "guest_control_policy", path, GUEST_CONTROL_POLICIES),
        isPaused: boolean(body, "is_paused", path),
        anchorPositionSeconds: nonNegativeNumber(body, "anchor_position_seconds", path),
        anchorUpdatedAt: instant(body, "anchor_updated_at", path),
        generation: nonNegativeInteger(body, "generation", path),
        memberCount: nonNegativeInteger(body, "member_count", path),
        hostConnected: boolean(body, "host_connected", path),
        selfRole: enumField(body, "self_role", path, MEMBER_ROLES),
        selfCanControlTransport: boolean(body, "self_can_control_transport", path),
        selfCanManageRoom: boolean(body, "self_can_manage_room", path),
        selfIgnoreWait: boolean(body, "self_ignore_wait", path),
        attachedSessionId: optionalNonEmptyString(body, "attached_session_id", path),
        invitePath: optionalNonEmptyString(body, "invite_path", path),
        members: body.members === undefined ? [] : array(body, "members", path).map((member, index) => decodeRoomMember(member, `${path}.members[${index}]`)),
    };
}

export function decodeRoomAccess(value: unknown): RoomAccess {
    const path = "watch_together_room_response";
    const body = object(value, path);
    return { room: decodeRoom(body.room, `${path}.room`), roomAccessToken: nonEmptyString(body, "room_access_token", path) };
}

// --- Socket ticket ---

export interface RoomSocketTicket {
    /** Single use; offered as the silo.ticket.<ticket> subprotocol. */
    readonly ticket: string;
    /** Seconds until an unused ticket expires. 0 when the bearer is about to expire. */
    readonly expiresIn: number;
    readonly maxConnectionSeconds: number;
}

const TICKET_CHARACTERS = /^[A-Za-z0-9_-]+$/;

export function decodeRoomSocketTicket(value: unknown): RoomSocketTicket {
    const path = "watch_together_socket_ticket";
    const body = object(value, path);
    if (string(body, "protocol", path) !== ROOM_SOCKET_PROTOCOL) throw new WireError(`${path}.protocol`, ROOM_SOCKET_PROTOCOL);
    const ticket = nonEmptyString(body, "ticket", path);
    // The ticket becomes a WebSocket subprotocol token, which allows only these characters.
    if (!TICKET_CHARACTERS.test(ticket)) throw new WireError(`${path}.ticket`, "a subprotocol-safe ticket");
    const maxConnectionSeconds = nonNegativeInteger(body, "max_connection_seconds", path);
    if (maxConnectionSeconds === 0) throw new WireError(`${path}.max_connection_seconds`, "a positive integer");
    return { ticket, expiresIn: nonNegativeInteger(body, "expires_in", path), maxConnectionSeconds };
}

/**
 * The WebSocket address and subprotocol list for a room: the protocol first, then the ticket.
 * `apiRoot` is the server's `<base>/api/v2`; http(s) becomes ws(s).
 */
export function roomSocketHandshake(apiRoot: string, roomId: string, ticket: RoomSocketTicket): { readonly url: string; readonly protocols: readonly string[] } {
    const root = new URL(apiRoot);
    if (root.protocol !== "https:" && root.protocol !== "http:") throw new RangeError("Room sockets need an http(s) server");
    if (roomId === "") throw new RangeError("Room id is required");
    const scheme = root.protocol === "https:" ? "wss:" : "ws:";
    return {
        url: `${scheme}//${root.host}${root.pathname.replace(/\/+$/, "")}/watch-together/rooms/${encodeURIComponent(roomId)}/ws`,
        protocols: [ROOM_SOCKET_PROTOCOL, `silo.ticket.${ticket.ticket}`],
    };
}

// --- Socket frames from the server ---

export interface TransportCommand {
    readonly commandId: string;
    /** Absent for a command addressed to every attached session. */
    readonly sessionId: string | undefined;
    readonly selectionRevision: number;
    readonly action: TransportAction;
    readonly positionSeconds: number;
    /** Epoch milliseconds on the server's clock. */
    readonly executeAt: number;
    readonly issuedAt: number;
    readonly playbackState: RoomPlaybackState;
}

/** The common rows the socket broadcasts; `votedByMe` is false here and is read over HTTP. */
export interface Suggestion {
    readonly id: string;
    readonly roomId: string;
    readonly suggesterUserId: string;
    readonly suggesterProfileId: string;
    readonly contentId: string;
    readonly contentType: string;
    readonly title: string;
    readonly subtitle: string;
    readonly posterUrl: string;
    readonly note: string;
    readonly voteCount: number;
    readonly votedByMe: boolean;
    readonly createdAt: number;
}

export type RoomServerMessage =
    | { readonly type: "snapshot"; readonly room: Room }
    | { readonly type: "transport_command"; readonly command: TransportCommand }
    | { readonly type: "suggestions_update"; readonly suggestions: readonly Suggestion[] }
    | { readonly type: "pong"; readonly clientSentAt: number; readonly serverReceivedAt: number; readonly serverSentAt: number }
    /** `reason` is the server's: ended, host_left or not_found. */
    | { readonly type: "room_closed"; readonly reason: string }
    | { readonly type: "connection_replaced"; readonly reason: string | undefined }
    | { readonly type: "error"; readonly code: string; readonly message: string }
    | { readonly type: "unknown" };

export function decodeTransportCommand(value: unknown, path = "watch_together_command"): TransportCommand {
    const body = object(value, path);
    return {
        commandId: nonEmptyString(body, "command_id", path),
        sessionId: optionalNonEmptyString(body, "session_id", path),
        selectionRevision: nonNegativeInteger(body, "selection_revision", path),
        action: enumField(body, "action", path, TRANSPORT_ACTIONS),
        positionSeconds: nonNegativeNumber(body, "position_seconds", path),
        executeAt: instant(body, "execute_at", path),
        issuedAt: instant(body, "issued_at", path),
        playbackState: enumField(body, "playback_state", path, PLAYBACK_STATES),
    };
}

export function decodeSuggestion(value: unknown, path = "watch_together_suggestion"): Suggestion {
    const body = object(value, path);
    return {
        id: nonEmptyString(body, "id", path),
        roomId: nonEmptyString(body, "room_id", path),
        suggesterUserId: opaqueId(body, "suggester_user_id", path),
        suggesterProfileId: string(body, "suggester_profile_id", path),
        contentId: nonEmptyString(body, "content_id", path),
        contentType: string(body, "content_type", path),
        title: string(body, "title", path),
        subtitle: body.subtitle === undefined ? "" : string(body, "subtitle", path),
        posterUrl: body.poster_url === undefined || body.poster_url === null ? "" : string(body, "poster_url", path),
        note: body.note === undefined ? "" : string(body, "note", path),
        voteCount: nonNegativeInteger(body, "vote_count", path),
        votedByMe: boolean(body, "voted_by_me", path),
        createdAt: instant(body, "created_at", path),
    };
}

/** Decodes one parsed frame. An unrecognised `type` is `unknown`; a frame without a string `type` throws. */
export function decodeRoomServerMessage(value: unknown): RoomServerMessage {
    const path = "watch_together_frame";
    const body = object(value, path);
    switch (string(body, "type", path)) {
        case "snapshot":
            return { type: "snapshot", room: decodeRoom(body.room, `${path}.room`) };
        case "transport_command":
            return { type: "transport_command", command: decodeTransportCommand(body.command, `${path}.command`) };
        case "suggestions_update":
            return { type: "suggestions_update", suggestions: array(body, "suggestions", path).map((entry, index) => decodeSuggestion(entry, `${path}.suggestions[${index}]`)) };
        case "pong":
            return { type: "pong", clientSentAt: instant(body, "client_sent_at", path), serverReceivedAt: instant(body, "server_received_at", path), serverSentAt: instant(body, "server_sent_at", path) };
        case "room_closed":
            return { type: "room_closed", reason: body.reason === undefined ? "ended" : string(body, "reason", path) };
        case "connection_replaced":
            return { type: "connection_replaced", reason: body.reason === undefined ? undefined : string(body, "reason", path) };
        case "error":
            return { type: "error", code: string(body, "code", path), message: string(body, "message", path) };
        default:
            return { type: "unknown" };
    }
}

/** Parses and decodes one text frame. */
export function parseRoomServerMessage(frame: string): RoomServerMessage {
    let parsed: unknown;
    try {
        parsed = JSON.parse(frame);
    } catch {
        throw new WireError("watch_together_frame", "JSON");
    }
    return decodeRoomServerMessage(parsed);
}

// --- Socket frames from the client ---

export type RoomClientMessage =
    | { readonly type: "attach_session"; readonly sessionId: string }
    | { readonly type: "transport_request"; readonly action: RequestableTransportAction; readonly positionSeconds?: number; readonly isPaused: boolean }
    /** `isReady` with `commandId` acknowledges a waiting command, so a lost `ready` heals on the next report. */
    | { readonly type: "state_report"; readonly sessionId: string; readonly positionSeconds: number; readonly isPaused: boolean; readonly commandId?: string; readonly isReady?: boolean }
    | { readonly type: "ready"; readonly sessionId: string; readonly positionSeconds: number; readonly isPaused: boolean; readonly commandId?: string }
    | { readonly type: "buffering"; readonly sessionId: string; readonly positionSeconds: number; readonly isPaused: boolean }
    | { readonly type: "lobby_ready"; readonly ready: boolean }
    /** `clientSentAt` is epoch milliseconds on this device's clock. */
    | { readonly type: "ping"; readonly clientSentAt: number };

function requireSession(sessionId: string): string {
    if (sessionId === "") throw new RangeError("A playback session id is required");
    return sessionId;
}

function requirePosition(seconds: number): number {
    if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError("Position must be a finite number of seconds, zero or more");
    return seconds;
}

/** The JSON text of one client frame, with the server's snake_case members. */
export function encodeRoomClientMessage(message: RoomClientMessage): string {
    switch (message.type) {
        case "attach_session":
            return JSON.stringify({ type: message.type, session_id: requireSession(message.sessionId) });
        case "transport_request":
            return JSON.stringify({
                type: message.type,
                action: message.action,
                position_seconds: message.positionSeconds === undefined ? undefined : requirePosition(message.positionSeconds),
                is_paused: message.isPaused,
            });
        case "state_report":
            return JSON.stringify({
                type: message.type,
                session_id: requireSession(message.sessionId),
                position_seconds: requirePosition(message.positionSeconds),
                is_paused: message.isPaused,
                command_id: message.commandId,
                is_ready: message.isReady,
            });
        case "ready":
            return JSON.stringify({
                type: message.type,
                session_id: requireSession(message.sessionId),
                position_seconds: requirePosition(message.positionSeconds),
                is_paused: message.isPaused,
                command_id: message.commandId,
            });
        case "buffering":
            return JSON.stringify({
                type: message.type,
                session_id: requireSession(message.sessionId),
                position_seconds: requirePosition(message.positionSeconds),
                is_paused: message.isPaused,
            });
        case "lobby_ready":
            return JSON.stringify({ type: message.type, ready: message.ready });
        case "ping":
            return JSON.stringify({ type: message.type, client_sent_at: new Date(message.clientSentAt).toISOString() });
    }
}
