import { FakeRequests } from "./fakeRequests.ts";
import { fixture, problem, type Reply } from "./fakeSilo.ts";

export const ROOM_ID = "0b6f3f0e-6c1d-4a39-9d52-3a1f7c7f9e10";
export const ROOM_TOKEN = "room-proof-one";
export const WATCH_PARTY_FEATURES = ["watch_party_coordinator_v1", "fixed_media_file_v1"];
/** The file the fake room plays once the host starts it. */
export const ROOM_FILE_ID = "9001";

const ROOM_PATH = `/watch-together/rooms/${ROOM_ID}`;

/** The Watch Together HTTP surface and the playback capability features Apple's Watch Party gate reads. */
export class FakeWatchParty extends FakeRequests {
    state = "available";
    allowed = true;
    socketProtocol: string | undefined = "silo.room.v2";
    connectionReplaced = true;
    playbackFeatures = WATCH_PARTY_FEATURES;
    /** The optional capability flags the lobby reads; a missing flag is false. */
    flags: Record<string, boolean> = { staged_selection: true, selection_mode_switch: true, stop_playback: true, picker: true };
    capabilitiesFailure: Reply | undefined;
    createFailure: Reply | undefined;
    joinFailure: Reply | undefined;
    closeFailure: Reply | undefined;
    /** Fails the next room mutation (stage, select, start, stop, mode, policy) once it is set. */
    roomChangeFailure: Reply | undefined;
    pickerFailure: Reply | undefined;
    readonly capabilityReads: string[] = [];
    readonly createdRooms: Record<string, unknown>[] = [];
    readonly joined: string[] = [];
    readonly closedRooms: string[] = [];
    /** Every mutation as "METHOD /suffix", with its body when it has one. */
    readonly roomChanges: { readonly call: string; readonly body: Record<string, unknown> | undefined; readonly roomToken: string | undefined }[] = [];
    readonly pickerTokens: (string | undefined)[] = [];
    code = "K7M2QX";
    role: "host" | "guest" = "host";
    phase = "lobby";
    selectionMode = "host_pick";
    guestControlPolicy = "host_only";
    selectedContentId: string | undefined;
    selectedFileId: string | undefined;
    hostConnected = true;
    invitePath: string | undefined = "/rooms/join?token=invite-one";
    /** Members as the room reads them; the viewer's own row follows `role`. */
    guestReady = false;

    room(): Record<string, unknown> {
        const host = this.role === "host";
        return {
            room_id: ROOM_ID, phase: this.phase, playback_state: this.phase === "playing" ? "playing" : "idle", selection_mode: this.selectionMode,
            selection_revision: this.selectedContentId === undefined ? 0 : 1, code: this.code,
            ...(this.selectedContentId === undefined ? {} : { selected_content_id: this.selectedContentId }),
            ...(this.selectedFileId === undefined ? {} : { selected_file_id: this.selectedFileId }),
            guest_control_policy: this.guestControlPolicy, is_paused: this.phase !== "playing", anchor_position_seconds: 0, anchor_updated_at: "2026-11-10T01:02:03.123Z",
            generation: 1, member_count: 2, host_connected: this.hostConnected, self_role: this.role, self_can_control_transport: host, self_can_manage_room: host,
            self_ignore_wait: false,
            ...(this.invitePath === undefined ? {} : { invite_path: this.invitePath }),
            members: [
                { user_id: "1", profile_id: "p-owner", display_name: "Owner", is_host: true, is_self: host, connected: this.hostConnected },
                { user_id: "2", profile_id: "p-guest", display_name: "Sam", is_host: false, is_self: !host, connected: true, lobby_ready: this.guestReady },
            ],
        };
    }

    private access(): Reply { return { status: 200, body: { room: this.room(), room_access_token: ROOM_TOKEN } }; }

    private pickerBody(): Record<string, unknown> {
        const entry = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
            ({ item: this.card(id), members: [{ user_id: "1", profile_id: "p-owner", display_name: "Owner", position_seconds: 600, duration_seconds: 5400 }], ...extra });
        return {
            members: (this.room().members as unknown[]),
            continue_together: [entry("movie:m0004"), entry("series:s1", { next_up: { content_id: "episode:s1e12", season_number: 1, episode_number: 2, title: "Harbor Lights chapter 1.2", member_count: 2 } })],
            watchlist_union: [entry("movie:m0005"), entry("series:s2")],
        };
    }

    override route(method: string, path: string, profileId: string | undefined, body?: Record<string, unknown>, headers?: Readonly<Record<string, string>>): Reply | undefined {
        const pathname = new URL(path, "https://fake.invalid").pathname;
        if (method === "GET" && pathname === "/watch-together/capabilities") {
            this.capabilityReads.push("watch-together");
            if (this.capabilitiesFailure !== undefined) return this.capabilitiesFailure;
            return { status: 200, body: {
                revision: "r1", state: this.state, allowed: this.allowed, connection_replaced: this.connectionReplaced, ...this.flags,
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
            this.selectionMode = String(body?.selection_mode ?? "host_pick");
            this.role = "host";
            return { status: 201, body: { room: this.room(), room_access_token: ROOM_TOKEN } };
        }
        if (method === "POST" && pathname === "/watch-together/join") {
            if (this.joinFailure !== undefined) return this.joinFailure;
            this.joined.push(String(body?.code));
            return { status: 200, body: { room: this.room(), room_access_token: ROOM_TOKEN } };
        }
        if (method === "DELETE" && pathname === ROOM_PATH) {
            if (this.closeFailure !== undefined) return this.closeFailure;
            this.closedRooms.push(ROOM_ID);
            return { status: 204 };
        }
        if (method === "GET" && pathname === `${ROOM_PATH}/picker`) {
            this.pickerTokens.push(headers?.["x-room-token"]);
            return this.pickerFailure ?? { status: 200, body: this.pickerBody() };
        }
        if (pathname.startsWith(`${ROOM_PATH}/`)) {
            const suffix = pathname.slice(ROOM_PATH.length);
            const call = `${method} ${suffix}`;
            const handled = this.mutate(call, body);
            if (handled !== undefined) {
                this.roomChanges.push({ call, body, roomToken: headers?.["x-room-token"] });
                return this.roomChangeFailure ?? handled;
            }
        }
        return super.route(method, path, profileId, body);
    }

    private mutate(call: string, body: Record<string, unknown> | undefined): Reply | undefined {
        if (this.role !== "host") return problem(403, "forbidden", "Only the host can change the party.");
        switch (call) {
            case "PUT /staged-selection": case "PUT /selection":
                if (this.roomChangeFailure === undefined) this.selectedContentId = String(body?.content_id);
                return this.access();
            case "POST /playback/start":
                if (this.selectedContentId === undefined) return problem(409, "no_selection", "Choose a title first.");
                if (this.roomChangeFailure === undefined) { this.phase = "playing"; this.selectedFileId = ROOM_FILE_ID; }
                return this.access();
            case "POST /playback/stop":
                if (this.roomChangeFailure === undefined) this.phase = "lobby";
                return this.access();
            case "PATCH /selection-mode":
                if (this.roomChangeFailure === undefined) this.selectionMode = String(body?.selection_mode);
                return this.access();
            case "PATCH /policy":
                if (this.roomChangeFailure === undefined) this.guestControlPolicy = String(body?.guest_control_policy);
                return this.access();
            default: return undefined;
        }
    }
}
