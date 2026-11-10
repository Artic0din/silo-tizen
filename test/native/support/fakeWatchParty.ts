import type { WebSocketRoute } from "playwright";
import { FakeRequests } from "./fakeRequests.ts";
import { fixture, problem, type Reply } from "./fakeSilo.ts";

export const ROOM_ID = "0b6f3f0e-6c1d-4a39-9d52-3a1f7c7f9e10";
export const ROOM_TOKEN = "room-proof-one";
export const WATCH_PARTY_FEATURES = ["watch_party_coordinator_v1", "fixed_media_file_v1"];
/** The file the fake room plays once the host starts it. */
export const ROOM_FILE_ID = "9001";

const ROOM_PATH = `/watch-together/rooms/${ROOM_ID}`;

/** A ballot row as the fake stores it: who voted is by profile, so each member's own vote can be answered. */
export interface FakeSuggestion {
    readonly id: string;
    readonly contentId: string;
    readonly contentType: string;
    readonly title: string;
    readonly subtitle: string;
    readonly posterUrl: string;
    readonly suggesterProfileId: string;
    readonly createdAt: string;
    readonly voters: Set<string>;
}

/** The Watch Together HTTP surface and the playback capability features Apple's Watch Party gate reads. */
export class FakeWatchParty extends FakeRequests {
    state = "available";
    allowed = true;
    socketProtocol: string | undefined = "silo.room.v2";
    connectionReplaced = true;
    playbackFeatures = WATCH_PARTY_FEATURES;
    /** The optional capability flags the lobby reads; a missing flag is false. */
    flags: Record<string, boolean> = { staged_selection: true, selection_mode_switch: true, stop_playback: true, picker: true, lobby_ready: true };
    capabilitiesFailure: Reply | undefined;
    createFailure: Reply | undefined;
    joinFailure: Reply | undefined;
    closeFailure: Reply | undefined;
    /** Fails the next room mutation (stage, select, start, stop, mode, policy) once it is set. */
    roomChangeFailure: Reply | undefined;
    pickerFailure: Reply | undefined;
    /** Answers every season's episodes read in place of the catalog, for an empty or failing season. */
    episodesReply: Reply | undefined;
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
    /** Puts the series that Continue Together offers with a next-up episode on the watchlist shelf too, without one. */
    duplicateSeries = false;
    /** Every room read, by the room token it carried; the room socket reads the room before each ticket. */
    readonly roomReads: (string | undefined)[] = [];
    /** Answers the room read in place of the room, for a party that ended or a refused member. */
    roomReadFailure: Reply | undefined;
    readonly ticketTokens: (string | undefined)[] = [];
    /** Sam is in the room; false for a host waiting for someone to join. */
    guestJoined = true;
    generation = 1;
    /** The vote room's ballot, oldest first. */
    readonly suggestions: FakeSuggestion[] = [];
    /** Every ballot read, by its room token and cursor. */
    readonly suggestionReads: { readonly roomToken: string | undefined; readonly cursor: string | null }[] = [];
    /** Every ballot write as "METHOD /suffix", with its body and room token. */
    readonly ballotChanges: { readonly call: string; readonly body: Record<string, unknown> | undefined; readonly roomToken: string | undefined }[] = [];
    /** Rows per ballot page, so a test can make the read take several. */
    suggestionPageSize = 100;
    /** Fails the next ballot write once it is set. */
    ballotFailure: Reply | undefined;
    /** Every room socket the page opened, newest last, and the frames each one sent. */
    readonly sockets: { readonly route: WebSocketRoute; readonly protocols: readonly string[]; readonly sent: Record<string, unknown>[]; closed: boolean }[] = [];

    /** The room socket's server side, for Playwright's routeWebSocket: it answers pings and records what the page sends. */
    acceptSocket(route: WebSocketRoute, protocols: readonly string[]): void {
        const socket = { route, protocols, sent: [] as Record<string, unknown>[], closed: false };
        this.sockets.push(socket);
        route.onMessage(message => {
            const frame = JSON.parse(String(message)) as Record<string, unknown>;
            socket.sent.push(frame);
            if (frame.type === "ping") route.send(JSON.stringify({ type: "pong", client_sent_at: frame.client_sent_at, server_received_at: frame.client_sent_at, server_sent_at: frame.client_sent_at }));
            // The server marks the sender's seat and broadcasts the room; only a guest's readiness shows on a seat.
            if (frame.type === "lobby_ready" && this.role === "guest") { this.guestReady = frame.ready === true; this.snapshot(); }
        });
        route.onClose(() => { socket.closed = true; });
    }

    /** Sends a frame on the newest open room socket. */
    push(frame: Record<string, unknown>): void {
        const socket = this.sockets.at(-1);
        if (socket === undefined || socket.closed) throw new Error("no open room socket");
        socket.route.send(JSON.stringify(frame));
    }

    /** Broadcasts the room as it now stands, as the server does after any change. */
    snapshot(): void {
        this.generation++;
        this.push({ type: "snapshot", room: this.room() });
    }

    /** Puts a title on the ballot as Sam, with votes from the given profiles, and broadcasts it when a socket is open. */
    suggest(id: string, title: string, voters: readonly string[] = [], extra: Partial<Pick<FakeSuggestion, "subtitle" | "posterUrl" | "contentType">> = {}): void {
        this.suggestions.push({
            id, contentId: `movie:${id}`, contentType: extra.contentType ?? "movie", title, subtitle: extra.subtitle ?? "", posterUrl: extra.posterUrl ?? `/art/${id}.svg`,
            suggesterProfileId: "p-guest", createdAt: new Date(Date.UTC(2026, 10, 10, 1, 0, this.suggestions.length)).toISOString(), voters: new Set(voters),
        });
        this.broadcastBallot();
    }

    /** Another member votes or takes their vote back. */
    voteAs(profileId: string, id: string, voted: boolean): void {
        const row = this.suggestions.find(candidate => candidate.id === id);
        if (row === undefined) throw new Error(`no suggestion ${id}`);
        if (voted) row.voters.add(profileId); else row.voters.delete(profileId);
        this.broadcastBallot();
    }

    private get selfProfile(): string { return this.role === "host" ? "p-owner" : "p-guest"; }

    private suggestionRow(row: FakeSuggestion, viewer: string | undefined): Record<string, unknown> {
        return {
            id: row.id, room_id: ROOM_ID, suggester_user_id: 2, suggester_profile_id: row.suggesterProfileId, content_id: row.contentId, content_type: row.contentType,
            title: row.title, subtitle: row.subtitle, poster_url: row.posterUrl, note: "", vote_count: row.voters.size, voted_by_me: viewer !== undefined && row.voters.has(viewer), created_at: row.createdAt,
        };
    }

    /** suggestions_update: every row with voted_by_me false, as the server strips it. */
    private broadcastBallot(): void {
        const socket = this.sockets.at(-1);
        if (socket === undefined || socket.closed) return;
        socket.route.send(JSON.stringify({ type: "suggestions_update", suggestions: this.suggestions.map(row => this.suggestionRow(row, undefined)) }));
    }

    private ballot(method: string, suffix: string, query: URLSearchParams, body: Record<string, unknown> | undefined, token: string | undefined): Reply | undefined {
        if (method === "GET" && suffix === "/suggestions") {
            const cursor = query.get("cursor");
            this.suggestionReads.push({ roomToken: token, cursor });
            const start = cursor === null ? 0 : Number(cursor);
            const rows = this.suggestions.slice(start, start + this.suggestionPageSize);
            const next = start + rows.length;
            return { status: 200, body: { items: rows.map(row => this.suggestionRow(row, this.selfProfile)), page: { has_more: next < this.suggestions.length, next_cursor: next < this.suggestions.length ? String(next) : "" } } };
        }
        const vote = /^\/suggestions\/([^/]+)\/vote$/.exec(suffix);
        const write = (method === "POST" && suffix === "/suggestions") || (vote !== null && (method === "POST" || method === "DELETE")) || (method === "POST" && suffix === "/suggestions/promote");
        if (!write) return undefined;
        this.ballotChanges.push({ call: `${method} ${suffix}`, body, roomToken: token });
        if (this.ballotFailure !== undefined) return this.ballotFailure;
        if (method === "POST" && suffix === "/suggestions") {
            this.suggestions.push({
                id: String(body?.suggestion_id), contentId: String(body?.content_id), contentType: String(body?.content_type), title: String(body?.title),
                subtitle: String(body?.subtitle ?? ""), posterUrl: String(body?.poster_url ?? ""), suggesterProfileId: this.selfProfile,
                createdAt: new Date(Date.UTC(2026, 10, 10, 1, 0, this.suggestions.length)).toISOString(), voters: new Set(),
            });
            this.broadcastBallot();
            return { status: 201, body: { suggestion_id: body?.suggestion_id } };
        }
        if (vote !== null) {
            const row = this.suggestions.find(candidate => candidate.id === decodeURIComponent(vote[1] ?? ""));
            if (row === undefined) return problem(404, "not_found", "The room or suggestion was not found.");
            if (method === "POST") row.voters.add(this.selfProfile); else row.voters.delete(this.selfProfile);
            this.broadcastBallot();
            return { status: 204 };
        }
        if (this.role !== "host") return problem(403, "forbidden", "Only the host account and profile may promote suggestions.");
        const row = this.suggestions.find(candidate => candidate.id === body?.suggestion_id);
        if (row === undefined) return problem(404, "not_found", "The room or suggestion was not found.");
        this.selectedContentId = row.contentId;
        this.phase = "playing";
        this.selectedFileId = ROOM_FILE_ID;
        return this.access();
    }

    room(): Record<string, unknown> {
        const host = this.role === "host";
        return {
            room_id: ROOM_ID, phase: this.phase, playback_state: this.phase === "playing" ? "playing" : "idle", selection_mode: this.selectionMode,
            selection_revision: this.selectedContentId === undefined ? 0 : 1, code: this.code,
            ...(this.selectedContentId === undefined ? {} : { selected_content_id: this.selectedContentId }),
            ...(this.selectedFileId === undefined ? {} : { selected_file_id: this.selectedFileId }),
            guest_control_policy: this.guestControlPolicy, is_paused: this.phase !== "playing", anchor_position_seconds: 0, anchor_updated_at: "2026-11-10T01:02:03.123Z",
            generation: this.generation, member_count: this.guestJoined ? 2 : 1, host_connected: this.hostConnected, self_role: this.role, self_can_control_transport: host, self_can_manage_room: host,
            self_ignore_wait: false,
            ...(this.invitePath === undefined ? {} : { invite_path: this.invitePath }),
            members: [
                { user_id: "1", profile_id: "p-owner", display_name: "Owner", is_host: true, is_self: host, connected: this.hostConnected },
                ...(this.guestJoined ? [{ user_id: "2", profile_id: "p-guest", display_name: "Sam", is_host: false, is_self: !host, connected: true, lobby_ready: this.guestReady }] : []),
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
            watchlist_union: [entry("movie:m0005"), entry("series:s2"), ...(this.duplicateSeries ? [entry("series:s1")] : [])],
        };
    }

    override route(method: string, path: string, profileId: string | undefined, body?: Record<string, unknown>, headers?: Readonly<Record<string, string>>): Reply | undefined {
        const pathname = new URL(path, "https://fake.invalid").pathname;
        if (method === "GET" && this.episodesReply !== undefined && /^\/catalog\/series\/[^/]+\/seasons\/\d+\/episodes$/.test(pathname)) return this.episodesReply;
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
        if (method === "GET" && pathname === ROOM_PATH) {
            this.roomReads.push(headers?.["x-room-token"]);
            return this.roomReadFailure ?? this.access();
        }
        if (method === "POST" && pathname === `${ROOM_PATH}/ws-ticket`) {
            this.ticketTokens.push(headers?.["x-room-token"]);
            return { status: 200, body: { ticket: `ticket-${this.ticketTokens.length}`, expires_in: 30, max_connection_seconds: 300, protocol: "silo.room.v2" } };
        }
        if (method === "GET" && pathname === `${ROOM_PATH}/picker`) {
            this.pickerTokens.push(headers?.["x-room-token"]);
            return this.pickerFailure ?? { status: 200, body: this.pickerBody() };
        }
        if (pathname.startsWith(`${ROOM_PATH}/suggestions`)) {
            const handled = this.ballot(method, pathname.slice(ROOM_PATH.length), new URL(path, "https://fake.invalid").searchParams, body, headers?.["x-room-token"]);
            if (handled !== undefined) return handled;
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
