import assert from "node:assert/strict";
import { test } from "node:test";
import { watchTogetherOperations } from "../../src/api/watchTogetherOperations.ts";
import { decodeSuggestion, decodeSuggestionPage, decodeSuggestionReceipt, type Suggestion, type SuggestionPage } from "../../src/contracts/v2/watchTogether.ts";
import { WatchPartyHub, type WatchPartyApi } from "../../src/ui/watchPartyHub.ts";
import { RoomVotes, voteWinner } from "../../src/ui/watchPartyVotes.ts";
import { serverPoster } from "../../src/ui/watchPartyBallot.ts";
import type { RoomWebSocket } from "../../src/ui/watchPartySocket.ts";
import type { MediaChoice } from "../../src/ui/watchPartyChoice.ts";
import { ManualClock } from "./support/clock.ts";
import { playbackCapabilities, ROOM_ID, roomAccess, roomCapabilities, unusedLobbyOperations } from "./support/watchPartyApi.ts";

const SUGGESTION_ID = "5d0c3a52-8a4e-4c55-9a8e-0e1f2a3b4c5d";

const row = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id, room_id: ROOM_ID, suggester_user_id: 2, suggester_profile_id: "p-guest", content_id: `movie:${id}`, content_type: "movie",
    title: `Title ${id}`, subtitle: "", poster_url: `/images/${id}.jpg`, note: "", vote_count: 0, voted_by_me: false, created_at: "2026-11-10T01:00:00Z", ...over,
});
const suggestion = (id: string, over: Record<string, unknown> = {}): Suggestion => decodeSuggestion(row(id, over));

// --- The contract (APIv2Client+WatchParty.swift and internal/apiv2/watch_together_suggestion*.go) ---

test("the ballot read is a GET of 100 rows with the room token, continued by cursor, and a page that says more needs a cursor", () => {
    const first = watchTogetherOperations.suggestions(ROOM_ID, "room-proof");
    assert.deepEqual([first.method, first.path, first.roomToken, first.retry], ["GET", `/watch-together/rooms/${ROOM_ID}/suggestions?limit=100`, "room-proof", "safe"]);
    assert.equal(watchTogetherOperations.suggestions(ROOM_ID, "room-proof", "c/2").path, `/watch-together/rooms/${ROOM_ID}/suggestions?limit=100&cursor=c%2F2`);
    const page = decodeSuggestionPage({ items: [row("a", { vote_count: 2, voted_by_me: true, suggester_user_id: "2" })], page: { has_more: true, next_cursor: "c2" } });
    assert.deepEqual(page.items.map(item => [item.id, item.voteCount, item.votedByMe, item.suggesterUserId]), [["a", 2, true, "2"]]);
    assert.equal(page.nextCursor, "c2");
    assert.equal(decodeSuggestionPage({ items: [], page: { has_more: false, next_cursor: "" } }).nextCursor, undefined);
    assert.throws(() => decodeSuggestionPage({ items: [], page: { has_more: true, next_cursor: "" } }), "more rows need a continuation");
    assert.throws(() => decodeSuggestionPage({ items: [row("a", { vote_count: -1 })] }), "a tally is never negative");
});

test("a suggestion is a POST with the caller's UUID, a movie or episode, and the poster only when there is one; 201 answers its id", () => {
    const spec = watchTogetherOperations.addSuggestion(ROOM_ID, "room-proof", { suggestionId: SUGGESTION_ID, contentId: "movie:m1", contentType: "movie", title: "Dune", subtitle: "", posterUrl: "/p.jpg" });
    assert.deepEqual([spec.method, spec.path, spec.roomToken, spec.retry], ["POST", `/watch-together/rooms/${ROOM_ID}/suggestions`, "room-proof", "safe"]);
    assert.deepEqual(spec.body, { suggestion_id: SUGGESTION_ID, content_id: "movie:m1", content_type: "movie", title: "Dune", poster_url: "/p.jpg" });
    assert.equal(decodeSuggestionReceipt({ suggestion_id: SUGGESTION_ID }), SUGGESTION_ID);
    assert.throws(() => watchTogetherOperations.addSuggestion(ROOM_ID, "room-proof", { suggestionId: "not-a-uuid", contentId: "movie:m1", contentType: "movie", title: "Dune" }));
    assert.throws(() => watchTogetherOperations.addSuggestion(ROOM_ID, "room-proof", { suggestionId: SUGGESTION_ID, contentId: "movie:m1", contentType: "movie", title: "" }));
});

test("a vote is POST and taking it back is DELETE on the suggestion's vote, and only promote answers with the room and never retries", () => {
    const vote = watchTogetherOperations.setVote(ROOM_ID, "room-proof", "s/1", true);
    const unvote = watchTogetherOperations.setVote(ROOM_ID, "room-proof", "s/1", false);
    assert.deepEqual([vote.method, vote.path, vote.roomToken, vote.retry], ["POST", `/watch-together/rooms/${ROOM_ID}/suggestions/s%2F1/vote`, "room-proof", "safe"]);
    assert.deepEqual([unvote.method, unvote.path], ["DELETE", `/watch-together/rooms/${ROOM_ID}/suggestions/s%2F1/vote`]);
    assert.equal(vote.decode(undefined), undefined, "204 has no body");
    const promote = watchTogetherOperations.promoteSuggestion(ROOM_ID, "room-proof", "s1");
    assert.deepEqual([promote.method, promote.path, promote.roomToken, promote.retry, promote.body], ["POST", `/watch-together/rooms/${ROOM_ID}/suggestions/promote`, "room-proof", "never", { suggestion_id: "s1" }]);
});

// --- WatchPartyVotes and WatchPartyLobbyPolicy.voteWinner ---

test("a socket update replaces the tallies but keeps this profile's votes from the last read, and never sets one", () => {
    const votes = new RoomVotes();
    assert.equal(votes.reconcile([suggestion("a", { vote_count: 1, voted_by_me: true }), suggestion("b")], 0), true);
    votes.receive([suggestion("a", { vote_count: 3 }), suggestion("b", { vote_count: 1 }), suggestion("c", { vote_count: 1 })]);
    assert.deepEqual(votes.rows.map(item => [item.id, item.voteCount, item.votedByMe]), [["a", 3, true], ["b", 1, false], ["c", 1, false]]);
    assert.equal(votes.voted("a"), true);
    assert.equal(votes.voted("b"), false);
    assert.equal(votes.voted("c"), undefined, "a suggestion the last read did not have is still loading");
});

test("a read that a socket update or a vote overtook is refused, so an older ballot never replaces a newer one", () => {
    const votes = new RoomVotes();
    const startedAt = votes.revision;
    votes.receive([suggestion("a", { vote_count: 2 })]);
    assert.equal(votes.reconcile([suggestion("a", { vote_count: 1, voted_by_me: true })], startedAt), false, "the update arrived after the read was sent");
    assert.equal(votes.rows[0]?.voteCount, 2);
    assert.equal(votes.voted("a"), undefined);
    const beforeVote = votes.revision;
    votes.invalidatePersonalReads();
    assert.equal(votes.reconcile([suggestion("a")], beforeVote), false, "a read from before a vote describes the ballot before it");
    assert.equal(votes.reconcile([suggestion("a", { vote_count: 3, voted_by_me: true })], votes.revision), true);
    assert.deepEqual([votes.rows[0]?.voteCount, votes.voted("a")], [3, true]);
});

test("the winner has the most votes, then the earlier suggestion, then the smaller id; nobody voting is no winner", () => {
    assert.equal(voteWinner([suggestion("a"), suggestion("b")]), undefined);
    assert.equal(voteWinner([suggestion("a", { vote_count: 1 }), suggestion("b", { vote_count: 2 })])?.id, "b");
    assert.equal(voteWinner([suggestion("b", { vote_count: 2, created_at: "2026-11-10T01:00:01Z" }), suggestion("a", { vote_count: 2, created_at: "2026-11-10T01:00:02Z" })])?.id, "b");
    assert.equal(voteWinner([suggestion("b", { vote_count: 2 }), suggestion("a", { vote_count: 2 })])?.id, "a");
});

// --- The hub over the room socket ---

class FakeSocket implements RoomWebSocket {
    protocol = "";
    binaryType: BinaryType = "blob";
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    readonly sent: Record<string, unknown>[] = [];
    send(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
    close(): void { this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    open(): void { this.protocol = "silo.room.v2"; this.onopen?.(new Event("open")); }
    frame(value: unknown): void { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) })); }
}

const settle = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

interface Rig { readonly hub: WatchPartyHub; readonly clock: ManualClock; readonly socket: () => FakeSocket; readonly reads: string[]; readonly calls: string[] }

/** A vote room over a fake socket; `pages` answers each ballot read in turn, the last one repeating. */
async function voteRoom(pages: (() => SuggestionPage)[], room: Record<string, unknown> = { selection_mode: "vote" }, over: Partial<WatchPartyApi> = {}, capabilities: Record<string, unknown> = {}): Promise<Rig> {
    const clock = new ManualClock();
    const sockets: FakeSocket[] = [];
    const reads: string[] = [];
    const calls: string[] = [];
    let read = 0;
    const api: WatchPartyApi = {
        capabilities: async () => roomCapabilities({ staged_selection: true, lobby_ready: true, ...capabilities }),
        playbackCapabilities: async () => playbackCapabilities(),
        createRoom: async () => roomAccess(room),
        joinByCode: async () => roomAccess(room),
        closeRoom: async () => undefined,
        ...unusedLobbyOperations,
        room: async () => roomAccess(room),
        socketTicket: async () => ({ ticket: "tk", expiresIn: 30, maxConnectionSeconds: 300 }),
        socketHandshake: () => ({ url: "wss://silo.example/ws", protocols: ["silo.room.v2", "silo.ticket.tk"] }),
        suggestions: async (roomId, token, cursor) => {
            reads.push(`${token} ${cursor ?? "-"}`);
            const page = pages[Math.min(read++, pages.length - 1)];
            assert.ok(page, "a ballot page");
            return page();
        },
        ...over,
    };
    const hub = new WatchPartyHub(api, () => undefined, { supported: true, clock, uuid: () => SUGGESTION_ID, socket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; } });
    await hub.create("vote");
    await settle();
    const socket = (): FakeSocket => { const last = sockets.at(-1); assert.ok(last, "a socket opened"); return last; };
    socket().open();
    return { hub, clock, socket, reads, calls };
}

const page = (items: Record<string, unknown>[], nextCursor?: string): () => SuggestionPage => () => decodeSuggestionPage({ items, page: { has_more: nextCursor !== undefined, ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }) } });

test("a vote room reads its ballot, every page, with the room token shortly after the socket opens", async () => {
    const r = await voteRoom([page([row("a", { voted_by_me: true, vote_count: 1 })], "c2"), page([row("b")])]);
    assert.deepEqual(r.reads, [], "Apple waits before reading");
    await r.clock.advance(200);
    await settle();
    assert.deepEqual(r.reads, ["room-proof -", "room-proof c2"]);
    assert.deepEqual(r.hub.state.votes.rows.map(item => item.id), ["a", "b"]);
    assert.deepEqual([r.hub.state.votes.voted("a"), r.hub.state.votes.voted("b")], [true, false]);
    assert.equal(r.hub.winner()?.id, "a");
    assert.equal(r.hub.canStart(), true, "the host can start once someone voted");
    r.hub.leave();
});

test("a host-pick room never reads the ballot, and one switched to voting reads it", async () => {
    const r = await voteRoom([page([row("a")])], { selection_mode: "host_pick" });
    await r.clock.advance(1000);
    await settle();
    assert.deepEqual(r.reads, []);
    r.socket().frame({ type: "snapshot", room: wireRoom({ selection_mode: "vote", generation: 2 }) });
    await r.clock.advance(200);
    await settle();
    assert.deepEqual(r.reads, ["room-proof -"]);
    r.hub.leave();
});

test("live tallies: an update moves the counts and the leader at once, an update for another room is dropped, then the ballot is read again", async () => {
    const r = await voteRoom([page([row("a", { voted_by_me: true, vote_count: 1 }), row("b")]), page([row("a", { voted_by_me: true, vote_count: 1 }), row("b", { vote_count: 2 })])]);
    await r.clock.advance(200);
    await settle();
    r.socket().frame({ type: "suggestions_update", suggestions: [row("a", { vote_count: 1 }), row("b", { vote_count: 2 })] });
    assert.deepEqual(r.hub.state.votes.rows.map(item => item.voteCount), [1, 2]);
    assert.equal(r.hub.winner()?.id, "b");
    assert.equal(r.hub.state.votes.voted("a"), true, "the socket's voted_by_me false does not clear this profile's vote");
    r.socket().frame({ type: "suggestions_update", suggestions: [row("a", { room_id: "another-room", vote_count: 9 })] });
    assert.equal(r.hub.state.votes.rows.length, 2, "another room's ballot is ignored");
    await r.clock.advance(200);
    await settle();
    assert.equal(r.reads.length, 2, "one read after the update");
    r.hub.leave();
});

test("a read that a socket update overtakes is read again, so the ballot ends on the newest tallies", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    let count = 0;
    const r = await voteRoom([], { selection_mode: "vote" }, {
        suggestions: async () => {
            count++;
            if (count === 1) { await held; return page([row("a", { vote_count: 1 })])(); }
            return page([row("a", { vote_count: 4, voted_by_me: true })])();
        },
    });
    await r.clock.advance(200);
    await settle();
    r.socket().frame({ type: "suggestions_update", suggestions: [row("a", { vote_count: 4 })] });
    release();
    await settle();
    assert.equal(r.hub.state.votes.rows[0]?.voteCount, 4, "the late, older read did not replace the update");
    assert.equal(r.hub.state.votes.voted("a"), undefined);
    await r.clock.advance(200);
    await settle();
    assert.equal(count, 2);
    assert.deepEqual([r.hub.state.votes.rows[0]?.voteCount, r.hub.state.votes.voted("a")], [4, true]);
    r.hub.leave();
});

test("voting writes the vote with the room token, then reads the ballot for this profile's votes; an unknown vote is refused", async () => {
    const votes: string[] = [];
    let voted = false;
    const r = await voteRoom([() => page([row("a", { voted_by_me: voted, vote_count: voted ? 1 : 0 })])()], { selection_mode: "vote" }, {
        setVote: async (_roomId, token, id, value) => { votes.push(`${token} ${id} ${value}`); voted = value; },
    });
    assert.equal(await r.hub.vote("a", true), false, "nothing is known about a before the first read");
    await r.clock.advance(200);
    await settle();
    assert.equal(await r.hub.vote("a", true), true);
    assert.deepEqual(votes, ["room-proof a true"]);
    assert.deepEqual([r.hub.state.votes.voted("a"), r.hub.state.votes.rows[0]?.voteCount], [true, 1]);
    assert.equal(await r.hub.vote("a", false), true);
    assert.deepEqual(votes, ["room-proof a true", "room-proof a false"]);
    assert.equal(r.hub.state.votes.voted("a"), false);
    r.hub.leave();
});

test("a vote whose answer is lost reads the ballot back and shows the reason", async () => {
    const r = await voteRoom([page([row("a")]), page([row("a", { voted_by_me: true, vote_count: 1 })])], { selection_mode: "vote" }, {
        setVote: async () => { throw new TypeError("network down"); },
    });
    await r.clock.advance(200);
    await settle();
    assert.equal(await r.hub.vote("a", true), false);
    assert.equal(r.hub.state.votes.voted("a"), true, "the read shows the vote landed");
    assert.notEqual(r.hub.state.error, undefined);
    assert.equal(r.hub.state.busy, false);
    r.hub.leave();
});

test("Add suggestion posts the picked title with a fresh UUID, then reads the ballot and returns to the lobby", async () => {
    const added: unknown[] = [];
    const r = await voteRoom([page([]), page([row("new", { voted_by_me: false })])], { selection_mode: "vote" }, {
        addSuggestion: async (_roomId, token, body) => { added.push([token, body]); return body.suggestionId; },
    });
    await r.clock.advance(200);
    await settle();
    r.hub.state.pickerPurpose = "suggest";
    r.hub.show({ kind: "picker" });
    const lobby = { contentId: "movie:m1", title: "Dune", subtitle: undefined, posterUrl: "/p.jpg", backdropUrl: undefined, overview: undefined, facts: [], chips: [] };
    const choice: MediaChoice = { contentId: "movie:m1", type: "movie", title: "Dune", subtitle: undefined, posterUrl: "/p.jpg", backdropUrl: undefined, overview: undefined, facts: [], lobby };
    assert.equal(await r.hub.suggest(choice), true);
    assert.deepEqual(added, [["room-proof", { suggestionId: SUGGESTION_ID, contentId: "movie:m1", contentType: "movie", title: "Dune", posterUrl: "/p.jpg" }]]);
    assert.deepEqual(r.hub.state.votes.rows.map(item => item.id), ["new"]);
    assert.equal(r.hub.state.page.kind, "lobby");
    r.hub.leave();
});

test("the host starts the winner by promoting it with the room token, and the room it answers is taken", async () => {
    const promoted: string[] = [];
    const r = await voteRoom([page([row("a", { vote_count: 1 }), row("b", { vote_count: 2 })])], { selection_mode: "vote" }, {
        promoteSuggestion: async (_roomId, token, id) => { promoted.push(`${token} ${id}`); return roomAccess({ selection_mode: "vote", phase: "playing", generation: 2, selection_revision: 1, selected_content_id: "movie:b", selected_file_id: "9" }); },
        item: async () => { throw new Error("details are optional"); },
    });
    await r.clock.advance(200);
    await settle();
    assert.equal(await r.hub.start(), true);
    assert.deepEqual(promoted, ["room-proof b"]);
    assert.equal(r.hub.state.room?.phase, "playing");
    r.hub.leave();
});

test("Ready is a lobby_ready frame on the open socket; nothing is sent without the capability or before the socket opens", async () => {
    const guest = { selection_mode: "host_pick", self_can_manage_room: false };
    const r = await voteRoom([page([])], guest);
    assert.equal(r.hub.setReady(true), true);
    assert.equal(r.hub.setReady(false), true);
    assert.deepEqual(r.socket().sent.filter(frame => frame.type === "lobby_ready"), [{ type: "lobby_ready", ready: true }, { type: "lobby_ready", ready: false }]);
    assert.equal(r.hub.state.room?.members.find(member => member.isSelf)?.lobbyReady ?? false, false, "only the snapshot that follows marks the seat");
    r.hub.leave();
    const without = await voteRoom([page([])], guest, {}, { lobby_ready: false });
    assert.equal(without.hub.setReady(true), false);
    assert.deepEqual(without.socket().sent.filter(frame => frame.type === "lobby_ready"), []);
    without.hub.leave();
});

/** The wire form of a room snapshot, for frames. */
function wireRoom(over: Record<string, unknown>): Record<string, unknown> {
    return {
        room_id: ROOM_ID, phase: "lobby", playback_state: "idle", selection_mode: "host_pick", selection_revision: 0, code: "K7M2QX",
        guest_control_policy: "host_only", is_paused: true, anchor_position_seconds: 0, anchor_updated_at: "2026-11-10T01:02:03.123Z",
        generation: 1, member_count: 1, host_connected: true, self_role: "host", self_can_control_transport: true, self_can_manage_room: true, self_ignore_wait: false,
        members: [{ user_id: "u1", profile_id: "p-owner", display_name: "Owner", is_host: true, is_self: true, connected: true }], ...over,
    };
}

test("the host switching their own room to voting reads the ballot once the switch lands", async () => {
    const r = await voteRoom([page([row("a", { vote_count: 1 })])], { selection_mode: "host_pick" }, {
        setSelectionMode: async () => roomAccess({ selection_mode: "vote", generation: 2 }),
    }, { selection_mode_switch: true });
    assert.equal(await r.hub.setMode("vote"), true);
    await r.clock.advance(200);
    await settle();
    assert.deepEqual(r.reads, ["room-proof -"]);
    assert.equal(r.hub.canStart(), true, "the vote already cast is the winner");
    r.hub.leave();
});

test("a ballot update that arrives while another change runs is read once that change finishes", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const r = await voteRoom([page([]), page([row("a")])], { selection_mode: "vote" }, {
        setGuestControlPolicy: async () => { await held; return roomAccess({ selection_mode: "vote", generation: 2 }); },
    });
    await r.clock.advance(200);
    await settle();
    const policy = r.hub.setPolicy("guest_play_pause");
    r.socket().frame({ type: "suggestions_update", suggestions: [row("a")] });
    await r.clock.advance(400);
    await settle();
    assert.equal(r.reads.length, 1, "no read while the change runs");
    release();
    await policy;
    await r.clock.advance(200);
    await settle();
    assert.equal(r.reads.length, 2);
    assert.equal(r.hub.state.votes.voted("a"), false, "this profile's vote is known again");
    r.hub.leave();
});

test("a vote the server took stands when the read after it fails, so the next press takes it back", async () => {
    let reads = 0;
    const sent: boolean[] = [];
    const r = await voteRoom([], { selection_mode: "vote" }, {
        suggestions: async () => { reads++; if (reads === 1) return page([row("a")])(); throw new TypeError("network down"); },
        setVote: async (_roomId, _token, _id, voted) => { sent.push(voted); },
    });
    await r.clock.advance(200);
    await settle();
    assert.equal(await r.hub.vote("a", true), true);
    assert.match(r.hub.state.error ?? "", /^Your change was saved/);
    assert.equal(r.hub.state.votes.voted("a"), true);
    r.hub.leave();
});

test("a failed ballot read tries again after 1, 2 and 4 seconds, and a success clears its warning", async () => {
    let reads = 0;
    const r = await voteRoom([], { selection_mode: "vote" }, {
        suggestions: async () => { reads++; if (reads <= 2) throw new TypeError("network down"); return page([row("a")])(); },
    });
    await r.clock.advance(200);
    await settle();
    assert.equal(reads, 1);
    assert.match(r.hub.state.error ?? "", /^Could not refresh suggestions\./);
    await r.clock.advance(1000);
    await settle();
    assert.equal(reads, 2);
    await r.clock.advance(1999);
    await settle();
    assert.equal(reads, 2, "the second retry waits 2 seconds");
    await r.clock.advance(1);
    await settle();
    assert.equal(reads, 3);
    assert.equal(r.hub.state.votes.voted("a"), false);
    assert.equal(r.hub.state.error, undefined);
    r.hub.leave();
});

test("the host cannot start a winner while the socket is not connected, as Apple disables Start", async () => {
    const promoted: string[] = [];
    const r = await voteRoom([page([row("a", { vote_count: 1 })])], { selection_mode: "vote" }, {
        promoteSuggestion: async (_roomId, _token, id) => { promoted.push(id); return roomAccess({ selection_mode: "vote" }); },
    });
    await r.clock.advance(200);
    await settle();
    r.socket().close();
    await settle();
    assert.notEqual(r.hub.state.connection, "connected");
    assert.equal(await r.hub.start(), false);
    assert.deepEqual(promoted, []);
    r.hub.leave();
});

test("a suggestion's poster is drawn only from this server; any other address shows the blank poster", () => {
    const base = "https://silo.example/base";
    assert.equal(serverPoster("/api/v2/images/p.jpg", base), "https://silo.example/api/v2/images/p.jpg");
    assert.equal(serverPoster("https://silo.example/art/p.jpg", base), "https://silo.example/art/p.jpg");
    assert.equal(serverPoster("https://elsewhere.example/p.jpg", base), undefined);
    assert.equal(serverPoster("http://192.168.1.1/p.jpg", base), undefined);
    assert.equal(serverPoster("", base), undefined);
});

test("after a reconnect the host cannot start until the ballot is read again, so a pre-outage winner is not promoted", async () => {
    let reads = 0;
    const promoted: string[] = [];
    const r = await voteRoom([], { selection_mode: "vote" }, {
        suggestions: async () => { reads++; return page(reads === 1 ? [row("a", { vote_count: 1 }), row("b")] : [row("a", { vote_count: 1 }), row("b", { vote_count: 3 })])(); },
        promoteSuggestion: async (_roomId, _token, id) => { promoted.push(id); return roomAccess({ selection_mode: "vote" }); },
    });
    await r.clock.advance(200);
    await settle();
    assert.equal(r.hub.ballotCurrent(), true);
    r.socket().close();
    await r.clock.advance(1000);
    await settle();
    r.socket().open();
    assert.equal(r.hub.state.connection, "connected");
    assert.equal(r.hub.ballotCurrent(), false);
    assert.equal(await r.hub.start(), false, "the old winner a is not promoted");
    await r.clock.advance(200);
    await settle();
    assert.equal(r.hub.winner()?.id, "b");
    assert.equal(await r.hub.start(), true);
    assert.deepEqual(promoted, ["b"]);
    r.hub.leave();
});
