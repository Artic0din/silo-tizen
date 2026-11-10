import { FakeRequests } from "./fakeRequests.ts";
import { fixture, problem, type Reply } from "./fakeSilo.ts";

const ROOM_ID = "0b6f3f0e-6c1d-4a39-9d52-3a1f7c7f9e10";
const ROOM_TOKEN = "room-proof-one";
export const WATCH_PARTY_FEATURES = ["watch_party_coordinator_v1", "fixed_media_file_v1"];

/** The Watch Together HTTP surface and the playback capability features Apple's Watch Party gate reads. */
export class FakeWatchParty extends FakeRequests {
    state = "available";
    allowed = true;
    socketProtocol: string | undefined = "silo.room.v2";
    connectionReplaced = true;
    playbackFeatures = WATCH_PARTY_FEATURES;
    capabilitiesFailure: Reply | undefined;
    createFailure: Reply | undefined;
    joinFailure: Reply | undefined;
    roomFailure: Reply | undefined;
    readonly capabilityReads: string[] = [];
    readonly createdRooms: Record<string, unknown>[] = [];
    readonly joined: string[] = [];
    roomReads = 0;
    code = "K7M2QX";

    room(): Record<string, unknown> {
        return {
            room_id: ROOM_ID, phase: "lobby", playback_state: "idle", selection_mode: "host_pick", selection_revision: 0, code: this.code,
            guest_control_policy: "host_only", is_paused: true, anchor_position_seconds: 0, anchor_updated_at: "2026-11-10T01:02:03.123Z",
            generation: 1, member_count: 2, host_connected: true, self_role: "host", self_can_control_transport: true, self_can_manage_room: true,
            self_ignore_wait: false,
            members: [
                { user_id: "1", profile_id: "p-owner", display_name: "Owner", is_host: true, is_self: true, connected: true },
                { user_id: "2", profile_id: "p-guest", display_name: "Sam", is_host: false, is_self: false, connected: true },
            ],
        };
    }

    override route(method: string, path: string, profileId: string | undefined, body?: Record<string, unknown>, headers?: Readonly<Record<string, string>>): Reply | undefined {
        const pathname = new URL(path, "https://fake.invalid").pathname;
        if (method === "GET" && pathname === "/watch-together/capabilities") {
            this.capabilityReads.push("watch-together");
            if (this.capabilitiesFailure !== undefined) return this.capabilitiesFailure;
            return { status: 200, body: {
                revision: "r1", state: this.state, allowed: this.allowed, connection_replaced: this.connectionReplaced,
                ...(this.socketProtocol === undefined ? {} : { socket_protocol: this.socketProtocol }),
            } };
        }
        if (method === "GET" && pathname === "/playback/capabilities") {
            this.capabilityReads.push("playback");
            const base = fixture("playback_capability_available");
            return { status: 200, body: { ...base, features: [...(base.features as string[]), ...this.playbackFeatures] } };
        }
        if (method === "POST" && pathname === "/watch-together/rooms") {
            if (this.createFailure !== undefined) return this.createFailure;
            this.createdRooms.push(body ?? {});
            return { status: 201, body: { room: this.room(), room_access_token: ROOM_TOKEN } };
        }
        if (method === "POST" && pathname === "/watch-together/join") {
            if (this.joinFailure !== undefined) return this.joinFailure;
            this.joined.push(String(body?.code));
            return { status: 200, body: { room: this.room(), room_access_token: ROOM_TOKEN } };
        }
        if (method === "GET" && pathname === `/watch-together/rooms/${ROOM_ID}`) {
            if (this.roomFailure !== undefined) return this.roomFailure;
            if (headers?.["x-room-token"] !== ROOM_TOKEN) return problem(401, "room_token_invalid", "Room proof required");
            this.roomReads++;
            return { status: 200, body: { room: this.room(), room_access_token: ROOM_TOKEN } };
        }
        return super.route(method, path, profileId, body);
    }
}
