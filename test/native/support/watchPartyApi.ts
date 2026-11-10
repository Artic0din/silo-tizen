import { decodePlaybackCapabilities, type PlaybackCapabilities } from "../../../src/contracts/v2/playback.ts";
import { decodeRoomAccess, decodeWatchTogetherCapabilities, type RoomAccess, type WatchTogetherCapabilities } from "../../../src/contracts/v2/watchTogether.ts";
import type { WatchPartyApi } from "../../../src/ui/watchPartyHub.ts";
import { fixture } from "./fakeSilo.ts";

export const ROOM_ID = "0b6f3f0e-6c1d-4a39-9d52-3a1f7c7f9e10";

export function roomCapabilities(overrides: Record<string, unknown> = {}): WatchTogetherCapabilities {
    return decodeWatchTogetherCapabilities({ state: "available", allowed: true, socket_protocol: "silo.room.v2", connection_replaced: true, ...overrides });
}

export function playbackCapabilities(overrides: Record<string, unknown> = {}): PlaybackCapabilities {
    const base = fixture("playback_capability_available");
    return decodePlaybackCapabilities({ ...base, features: [...(base.features as string[]), "watch_party_coordinator_v1", "fixed_media_file_v1"], ...overrides });
}

/** A room answer; `room` overrides members of the room document. */
export function roomAccess(room: Record<string, unknown> = {}, token = "room-proof"): RoomAccess {
    const host = room.self_can_manage_room !== false;
    return decodeRoomAccess({
        room_access_token: token,
        room: {
            room_id: ROOM_ID, phase: "lobby", playback_state: "idle", selection_mode: "host_pick", selection_revision: 0, code: "K7M2QX",
            guest_control_policy: "host_only", is_paused: true, anchor_position_seconds: 0, anchor_updated_at: "2026-11-10T01:02:03.123Z",
            generation: 1, member_count: 1, host_connected: true, self_role: host ? "host" : "guest", self_can_control_transport: host, self_can_manage_room: host,
            self_ignore_wait: false,
            members: [{ user_id: "u1", profile_id: "p-owner", display_name: "Owner", is_host: true, is_self: host, connected: true }],
            ...room,
        },
    });
}

const unexpected = (name: string) => (): never => { throw new Error(`unexpected ${name}`); };

/** Every operation the lobby adds, failing the test if a path calls one it did not set up. */
export const unusedLobbyOperations: Omit<WatchPartyApi, "capabilities" | "playbackCapabilities" | "createRoom" | "joinByCode" | "closeRoom"> = {
    stageSelection: unexpected("stageSelection"),
    selectItem: unexpected("selectItem"),
    startPlayback: unexpected("startPlayback"),
    stopPlayback: unexpected("stopPlayback"),
    setSelectionMode: unexpected("setSelectionMode"),
    setGuestControlPolicy: unexpected("setGuestControlPolicy"),
    room: unexpected("room"),
    picker: unexpected("picker"),
    item: unexpected("item"),
    seasons: unexpected("seasons"),
    episodes: unexpected("episodes"),
    watchlist: unexpected("watchlist"),
};
