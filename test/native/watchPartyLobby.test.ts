import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../src/api/errors.ts";
import { watchTogetherOperations } from "../../src/api/watchTogetherOperations.ts";
import { decodeCard } from "../../src/contracts/v2/catalog.ts";
import { decodePicker } from "../../src/contracts/v2/watchTogether.ts";
import type { PlayRequest } from "../../src/ui/browseModel.ts";
import { choiceFromCard, type MediaChoice } from "../../src/ui/watchPartyChoice.ts";
import { inviteUrl } from "../../src/ui/watchPartyInvite.ts";
import { WatchPartyHub, type WatchPartyApi } from "../../src/ui/watchPartyHub.ts";
import { primaryAction } from "../../src/ui/watchPartyPolicy.ts";
import { fixture } from "./support/fakeSilo.ts";
import { playbackCapabilities, ROOM_ID, roomAccess, roomCapabilities, unusedLobbyOperations } from "./support/watchPartyApi.ts";
import { decodeItemDetail } from "../../src/contracts/v2/catalog.ts";

const problem = (status: number, detail: string): ApiError => new ApiError({ kind: "problem", problem: { id: "x", title: "Failed", status, detail, instance: "", errors: [] }, retryAfterSeconds: undefined });

// --- Operations: method, path, body, retry class and no room token, from the pinned OpenAPI document ---

test("lobby operations send the contract's method, path and body with the class the server marks", () => {
    const stage = watchTogetherOperations.stageSelection(ROOM_ID, { contentId: "movie:m0004", fileId: "7", libraryId: "12" });
    assert.deepEqual([stage.method, stage.path, stage.retry, stage.body], ["PUT", `/watch-together/rooms/${ROOM_ID}/staged-selection`, "safe", { content_id: "movie:m0004", file_id: "7", library_id: "12" }]);
    const select = watchTogetherOperations.selectItem(ROOM_ID, { contentId: "movie:m0004" });
    assert.deepEqual([select.method, select.path, select.retry, select.body], ["PUT", `/watch-together/rooms/${ROOM_ID}/selection`, "never", { content_id: "movie:m0004" }]);
    const start = watchTogetherOperations.startPlayback(ROOM_ID);
    assert.deepEqual([start.method, start.path, start.retry, start.body], ["POST", `/watch-together/rooms/${ROOM_ID}/playback/start`, "never", undefined]);
    const stop = watchTogetherOperations.stopPlayback(ROOM_ID);
    assert.deepEqual([stop.method, stop.path, stop.retry], ["POST", `/watch-together/rooms/${ROOM_ID}/playback/stop`, "safe"]);
    const mode = watchTogetherOperations.setSelectionMode(ROOM_ID, "vote");
    assert.deepEqual([mode.method, mode.path, mode.retry, mode.body], ["PATCH", `/watch-together/rooms/${ROOM_ID}/selection-mode`, "safe", { selection_mode: "vote" }]);
    const policy = watchTogetherOperations.setGuestControlPolicy(ROOM_ID, "guest_play_pause");
    assert.deepEqual([policy.method, policy.path, policy.retry, policy.body], ["PATCH", `/watch-together/rooms/${ROOM_ID}/policy`, "safe", { guest_control_policy: "guest_play_pause" }]);
    for (const spec of [stage, select, start, stop, mode, policy]) assert.equal(spec.roomToken, undefined, "host-only calls take no room token");
});

test("the picker read carries the room token and decodes both shelves with the series' next-up episode", () => {
    const spec = watchTogetherOperations.picker(ROOM_ID, "room-proof");
    assert.deepEqual([spec.method, spec.path, spec.retry, spec.roomToken], ["GET", `/watch-together/rooms/${ROOM_ID}/picker`, "safe", "room-proof"]);
    const member = { user_id: "1", profile_id: "p-owner", display_name: "Owner", position_seconds: 600, duration_seconds: 5400 };
    const picker = spec.decode({
        members: [{ user_id: "1", profile_id: "p-owner", display_name: "Owner", is_host: true, is_self: true, connected: true }],
        continue_together: [{ item: { content_id: "series:s1", type: "series", title: "Harbor Lights" }, members: [member], next_up: { content_id: "episode:s1e12", season_number: 1, episode_number: 2, title: "Chapter", member_count: 2 } }],
        watchlist_union: [{ item: { content_id: "movie:m0005", type: "movie", title: "Movie 0005" }, members: [] }],
    });
    assert.equal(picker.continueTogether[0]?.card.id, "series:s1");
    assert.deepEqual(picker.continueTogether[0]?.nextUp, { contentId: "episode:s1e12", seasonNumber: 1, episodeNumber: 2, title: "Chapter", memberCount: 2 });
    assert.equal(picker.continueTogether[0]?.members[0]?.displayName, "Owner");
    assert.equal(picker.watchlistUnion[0]?.nextUp, undefined);
    assert.throws(() => decodePicker({ members: [], continue_together: [{ members: [] }], watchlist_union: [] }));
});

test("a room id or selection that is not usable is refused before anything is sent", () => {
    assert.throws(() => watchTogetherOperations.startPlayback(""), RangeError);
    assert.throws(() => watchTogetherOperations.stageSelection(ROOM_ID, { contentId: "" }), RangeError);
    assert.throws(() => watchTogetherOperations.stageSelection(ROOM_ID, { contentId: "movie:m1", fileId: "0" }), RangeError);
    assert.throws(() => watchTogetherOperations.stageSelection(ROOM_ID, { contentId: "movie:m1", libraryId: "-3" }), RangeError);
});

// --- The lobby's session state ---

const movie = (id = "movie:m0004"): MediaChoice => choiceFromCard(decodeCard({ content_id: id, type: "movie", title: `Title ${id}`, year: 1994, runtime: 126, poster_url: "/p.jpg", backdrop_url: "/b.jpg", overview: "Plot." }, "card"));
const episode = (): MediaChoice => choiceFromCard(decodeCard({ content_id: "episode:s1e12", type: "episode", title: "Chapter 1.2", series_id: "series:s1", series_title: "Harbor Lights", season_number: 1, episode_number: 2, poster_url: "/series.jpg", series_backdrop_url: "/series-b.jpg", backdrop_url: "/still.jpg", overview: "Spoiler." }, "card"));
const detail = (over: Record<string, unknown> = {}) => decodeItemDetail({ ...fixture("get_catalog_item_ok"), ...over });

interface Setup { hub: WatchPartyHub; calls: string[]; plays: PlayRequest[]; api: WatchPartyApi; renders: () => number }
function lobby(over: Partial<WatchPartyApi> = {}, flags: Record<string, unknown> = { staged_selection: true, selection_mode_switch: true, stop_playback: true, picker: true }, room: Record<string, unknown> = {}): Setup {
    const calls: string[] = [];
    const plays: PlayRequest[] = [];
    let renders = 0;
    const api: WatchPartyApi = {
        capabilities: async () => roomCapabilities(flags),
        playbackCapabilities: async () => playbackCapabilities(),
        createRoom: async () => roomAccess(room),
        joinByCode: async () => roomAccess(room),
        closeRoom: async id => { calls.push(`close ${id}`); },
        ...unusedLobbyOperations,
        item: async id => detail({ content_id: id, title: `Loaded ${id}` }),
        ...over,
    };
    const hub = new WatchPartyHub(api, () => { renders++; }, { supported: true, onPlay: request => plays.push(request) });
    return { hub, calls, plays, api, renders: () => renders };
}

test("the lobby keeps the capabilities the server answered with", async () => {
    const { hub } = lobby();
    await hub.create("host_pick");
    assert.equal(hub.state.capabilities?.stagedSelection, true);
    assert.equal(hub.state.capabilities?.picker, true);
    assert.equal(hub.state.capabilities?.lobbyReady, false, "a missing flag is false");
});

test("the host stages a title with the staged-selection call, keeps the answered room and lays out from the pick before the catalog answers", async () => {
    const seen: string[] = [];
    let release: (value: ReturnType<typeof detail>) => void = () => undefined;
    const { hub } = lobby({
        stageSelection: async (id, selection) => { seen.push(`stage ${id} ${selection.contentId}`); return roomAccess({ selected_content_id: selection.contentId, selection_revision: 1 }); },
        item: () => new Promise(resolve => { release = resolve; }),
    });
    await hub.create("host_pick");
    const pick = movie();
    assert.equal(await hub.stage(pick), true);
    assert.deepEqual(seen, [`stage ${ROOM_ID} movie:m0004`]);
    assert.equal(hub.state.room?.selectedContentId, "movie:m0004");
    assert.equal(hub.state.selected?.title, pick.lobby.title, "the picked title shows while the catalog read runs");
    release(detail({ content_id: "movie:m0004", title: "Loaded Heat" }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(hub.state.selected?.title, "Loaded Heat");
    assert.equal(hub.state.page.kind, "lobby");
    assert.equal(hub.state.busy, false);
});

test("without the staged-selection capability, or in a party that is already playing, the pick goes through the selection call", async () => {
    const calls: string[] = [];
    const selectItem = async (id: string, selection: { contentId: string }) => { calls.push(`select ${selection.contentId}`); return roomAccess({ selected_content_id: selection.contentId }); };
    const stageSelection = async () => { calls.push("stage"); return roomAccess(); };
    const old = lobby({ selectItem, stageSelection }, {});
    await old.hub.create("host_pick");
    await old.hub.stage(movie());
    const playing = lobby({ selectItem, stageSelection }, { staged_selection: true }, { phase: "playing", selected_content_id: "movie:m0001", selected_file_id: "42" });
    await playing.hub.create("host_pick");
    await playing.hub.stage(movie("movie:m0009"));
    assert.deepEqual(calls, ["select movie:m0004", "select movie:m0009"]);
});

test("a vote room, a guest and a closed lobby stage nothing", async () => {
    const calls: string[] = [];
    const stageSelection = async () => { calls.push("stage"); return roomAccess(); };
    for (const room of [{ selection_mode: "vote" }, { self_can_manage_room: false }]) {
        const { hub } = lobby({ stageSelection }, undefined, room);
        await hub.create("host_pick");
        assert.equal(await hub.stage(movie()), false, JSON.stringify(room));
    }
    assert.deepEqual(calls, []);
});

test("a refused stage shows the server's reason, leaves the room as it was and drops the preview", async () => {
    const { hub } = lobby({ stageSelection: async () => { throw problem(409, "That title is not available."); } });
    await hub.create("host_pick");
    assert.equal(await hub.stage(movie()), false);
    assert.equal(hub.state.error, "That title is not available.");
    assert.equal(hub.state.room?.selectedContentId, undefined);
    assert.equal(hub.state.selected, undefined);
    assert.equal(hub.state.busy, false);
});

test("a second change while one runs is ignored, as Apple's session does", async () => {
    let release: () => void = () => undefined;
    let stages = 0;
    const { hub } = lobby({ stageSelection: async () => { stages++; await new Promise<void>(resolve => { release = resolve; }); return roomAccess({ selected_content_id: "movie:m0004" }); } });
    await hub.create("host_pick");
    const first = hub.stage(movie());
    assert.equal(hub.state.busy, true);
    assert.equal(await hub.stage(movie("movie:m0009")), false);
    assert.equal(await hub.setPolicy("guest_play_pause"), false);
    release();
    assert.equal(await first, true);
    assert.equal(stages, 1);
});

test("Start for everyone starts playback once and opens the player on the file the room chose, from the room's anchor", async () => {
    let starts = 0;
    const { hub, plays } = lobby({
        startPlayback: async () => { starts++; return roomAccess({ phase: "playing", playback_state: "playing", selected_content_id: "movie:m0004", selected_file_id: "42", anchor_position_seconds: 12.5, is_paused: false }); },
    }, undefined, { selected_content_id: "movie:m0004" });
    await hub.create("host_pick");
    assert.equal(hub.canStart(), true);
    assert.equal(await hub.start(), true);
    assert.equal(starts, 1);
    assert.equal(hub.state.room?.phase, "playing");
    assert.equal(plays.length, 1);
    assert.deepEqual([plays[0]?.contentId, plays[0]?.fileId, plays[0]?.startSeconds], ["movie:m0004", "42", 12.5]);
});

test("Start waits for a chosen title, a host and a lobby, and a refused start stays in the lobby with the reason", async () => {
    let starts = 0;
    const startPlayback = async () => { starts++; throw problem(409, "Everyone needs the title."); };
    const empty = lobby({ startPlayback });
    await empty.hub.create("host_pick");
    assert.equal(empty.hub.canStart(), false, "nothing chosen");
    assert.equal(await empty.hub.start(), false);
    const guest = lobby({ startPlayback }, undefined, { self_can_manage_room: false, selected_content_id: "movie:m0004" });
    await guest.hub.create("host_pick");
    assert.equal(guest.hub.canStart(), false);
    const refused = lobby({ startPlayback }, undefined, { selected_content_id: "movie:m0004" });
    await refused.hub.create("host_pick");
    assert.equal(await refused.hub.start(), false);
    assert.equal(starts, 1);
    assert.equal(refused.hub.state.error, "Everyone needs the title.");
    assert.equal(refused.hub.state.room?.phase, "lobby");
    assert.deepEqual(refused.plays, []);
});

test("a start the server accepted without a file does not open the player", async () => {
    const { hub, plays } = lobby({ startPlayback: async () => roomAccess({ phase: "playing", selected_content_id: "movie:m0004" }) }, undefined, { selected_content_id: "movie:m0004" });
    await hub.create("host_pick");
    assert.equal(await hub.start(), true);
    assert.deepEqual(plays, []);
});

test("choosing a title for a party that is already playing opens the player on it, as Play for everyone says", async () => {
    const playing = { phase: "playing", selected_content_id: "movie:m0001", selected_file_id: "42" };
    const { hub, plays } = lobby({ selectItem: async () => roomAccess({ ...playing, selected_content_id: "movie:m0009", selected_file_id: "77" }) }, undefined, playing);
    await hub.create("host_pick");
    assert.equal(await hub.stage(movie("movie:m0009")), true);
    assert.deepEqual(plays.map(play => [play.contentId, play.fileId]), [["movie:m0009", "77"]]);
});

test("the player is pinned to the room's file so an alternate version cannot play instead", async () => {
    const { hub, plays } = lobby({ startPlayback: async () => roomAccess({ phase: "playing", selected_content_id: "movie:m0004", selected_file_id: "42" }) }, undefined, { selected_content_id: "movie:m0004" });
    await hub.create("host_pick");
    await hub.start();
    assert.equal(plays[0]?.allowAlternateVersions, false);
});

test("a start whose answer was lost reads the room again and, when the server did start it, carries on as a start; a refusal reads nothing", async () => {
    let reads = 0;
    const room = { selected_content_id: "movie:m0004" };
    const lost = lobby({
        startPlayback: async () => { throw new ApiError({ kind: "network" }); },
        room: async () => { reads++; return roomAccess({ ...room, phase: "playing", selected_file_id: "42" }); },
    }, undefined, room);
    await lost.hub.create("host_pick");
    assert.equal(await lost.hub.start(), true, "the room proves the start took effect");
    assert.equal(reads, 1);
    assert.equal(lost.hub.state.room?.phase, "playing");
    assert.equal(lost.hub.state.error, undefined, "a start the room confirms shows no failure");
    assert.deepEqual(lost.plays.map(play => play.fileId), ["42"]);
    const notStarted = lobby({ startPlayback: async () => { throw new ApiError({ kind: "timeout" }); }, room: async () => { reads++; return roomAccess(room); } }, undefined, room);
    await notStarted.hub.create("host_pick");
    assert.equal(await notStarted.hub.start(), false, "a room still in the lobby means the start did not happen");
    assert.equal(notStarted.hub.state.error !== undefined, true);
    const refused = lobby({ startPlayback: async () => { throw problem(409, "No."); }, room: async () => { reads++; return roomAccess(); } }, undefined, room);
    await refused.hub.create("host_pick");
    await refused.hub.start();
    assert.equal(reads, 2, "an answer from the server rules out the write, so nothing is read");
});

test("End party does not wait on reading the room back after a lost start", async () => {
    let reads = 0;
    let fail: () => void = () => undefined;
    const { hub, calls } = lobby({
        startPlayback: () => new Promise((_resolve, reject) => { fail = () => reject(new ApiError({ kind: "timeout" })); }),
        room: async () => { reads++; return roomAccess(); },
    }, undefined, { selected_content_id: "movie:m0004" });
    await hub.create("host_pick");
    const starting = hub.start();
    const ending = hub.endParty();
    fail();
    await Promise.all([starting, ending]);
    assert.equal(reads, 0, "the party is ending, so the lost start is not reconciled");
    assert.deepEqual(calls, [`close ${ROOM_ID}`]);
});

test("a lost start that was not read back because the party was ending is read once the close fails, without holding up End", async () => {
    let reads = 0;
    let closes = 0;
    let fail: () => void = () => undefined;
    let answer: () => void = () => undefined;
    const { hub } = lobby({
        startPlayback: () => new Promise((_resolve, reject) => { fail = () => reject(new ApiError({ kind: "timeout" })); }),
        room: () => new Promise(resolve => { reads++; answer = () => resolve(roomAccess({ selected_content_id: "movie:m0004", phase: "playing", selected_file_id: "42" })); }),
        closeRoom: async () => { closes++; throw problem(500, "Try again in a moment."); },
    }, undefined, { selected_content_id: "movie:m0004" });
    await hub.create("host_pick");
    const starting = hub.start();
    const ending = hub.endParty();
    fail();
    await Promise.all([starting, ending]);
    assert.equal(hub.state.error, "Try again in a moment.", "the failure shows while the room is still being read");
    assert.equal(reads, 1, "the room is read once, after the close failed");
    await hub.endParty();
    assert.equal(closes, 2, "End can be tried again without waiting for the read");
    answer();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(hub.state.room?.phase, "playing", "the lobby is no longer behind the start");
});

test("a live selection whose answer was lost and that the room confirms is a success, so Play for everyone is not sent twice", async () => {
    const playing = { phase: "playing", selected_content_id: "movie:m0001", selected_file_id: "42" };
    const { hub, plays } = lobby({
        selectItem: async () => { throw new ApiError({ kind: "network" }); },
        room: async () => roomAccess({ ...playing, selected_content_id: "movie:m0009", selected_file_id: "77" }),
    }, undefined, playing);
    await hub.create("host_pick");
    assert.equal(await hub.stage(movie("movie:m0009")), true);
    assert.equal(hub.state.page.kind, "lobby");
    assert.deepEqual(plays.map(play => play.contentId), ["movie:m0009"]);
});

test("backing out of the picker while it reloads does not strand the shelves it was reloading", async () => {
    const pick = (id: string) => ({ members: [], continueTogether: [{ card: decodeCard({ content_id: id, type: "movie", title: id }, "card"), members: [], nextUp: undefined }], watchlistUnion: [] });
    let release: (value: ReturnType<typeof pick>) => void = () => undefined;
    let first = true;
    const { hub } = lobby({ picker: () => first ? Promise.resolve(pick("movie:old")) : new Promise(resolve => { release = resolve; }) });
    await hub.create("host_pick");
    await hub.openPicker();
    first = false;
    const reload = hub.openPicker();
    hub.show({ kind: "choice", choice: movie("movie:old") });
    hub.back();
    release(pick("movie:new"));
    await reload;
    assert.deepEqual(hub.state.shelves.flatMap(shelf => shelf.entries.map(entry => entry.card.id)), ["movie:new"]);
    assert.equal(hub.state.shelvesLoading, false);
});

test("a picker answer that lands after Back does not claim focus from the lobby", async () => {
    let release: (value: Awaited<ReturnType<WatchPartyApi["picker"]>>) => void = () => undefined;
    const { hub } = lobby({ picker: () => new Promise(resolve => { release = resolve; }) });
    await hub.create("host_pick");
    const opening = hub.openPicker();
    hub.back();
    assert.equal(hub.state.page.kind, "lobby");
    release({ members: [], continueTogether: [{ card: decodeCard({ content_id: "movie:late", type: "movie", title: "Late" }, "card"), members: [], nextUp: undefined }], watchlistUnion: [] });
    await opening;
    assert.equal(hub.takeRefocus(), false, "the shelves are kept but the lobby keeps its focus");
    assert.equal(hub.state.shelves.length, 1);
});

test("a late picker answer for an older open does not replace the newer shelves", async () => {
    const releases: ((value: Awaited<ReturnType<WatchPartyApi["picker"]>>) => void)[] = [];
    const picker = (id: string) => ({ members: [], continueTogether: [{ card: decodeCard({ content_id: id, type: "movie", title: id }, "card"), members: [], nextUp: undefined }], watchlistUnion: [] });
    const { hub } = lobby({ picker: () => new Promise(resolve => { releases.push(resolve); }) });
    await hub.create("host_pick");
    const first = hub.openPicker();
    const second = hub.openPicker();
    releases[1]?.(picker("movie:new"));
    await second;
    releases[0]?.(picker("movie:old"));
    await first;
    assert.deepEqual(hub.state.shelves.flatMap(shelf => shelf.entries.map(entry => entry.card.id)), ["movie:new"]);
});

test("Back while the seasons are still loading is not undone when they arrive", async () => {
    const season = { id: "s1", seasonNumber: 1, title: "Season 1", episodeCount: 1, posterUrl: undefined, isSpecials: false };
    let release: (value: (typeof season)[]) => void = () => undefined;
    const { hub } = lobby({ seasons: () => new Promise(resolve => { release = resolve; }), episodes: async () => [] });
    await hub.create("host_pick");
    const series = decodeCard({ content_id: "series:s1", type: "series", title: "Harbor Lights" }, "card");
    const loading = hub.openEpisodes(series);
    hub.back();
    assert.equal(hub.state.page.kind, "picker");
    release([season]);
    await loading;
    assert.equal(hub.state.page.kind, "picker");
    assert.equal(hub.state.seasons === undefined || hub.state.episodes === undefined, true, "nothing from the abandoned page is kept");
});

test("End party while a change is still running closes the room once that change settles", async () => {
    let release: () => void = () => undefined;
    const { hub, calls } = lobby({ setGuestControlPolicy: () => new Promise(resolve => { release = () => resolve(roomAccess({ guest_control_policy: "guest_play_pause" })); }) });
    await hub.create("host_pick");
    const change = hub.setPolicy("guest_play_pause");
    const ending = hub.endParty();
    release();
    await Promise.all([change, ending]);
    assert.equal(hub.state.room, undefined, "the party ended instead of the confirmation being swallowed");
    assert.deepEqual(calls, [`close ${ROOM_ID}`]);
});

test("End party waits for a running change instead of racing it, and blocks new changes meanwhile", async () => {
    let release: () => void = () => undefined;
    const { hub, calls } = lobby({ setGuestControlPolicy: () => new Promise(resolve => { release = () => resolve(roomAccess({ guest_control_policy: "guest_play_pause" })); }) });
    await hub.create("host_pick");
    const change = hub.setPolicy("guest_play_pause");
    const ending = hub.endParty();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(calls, [], "the room is not closed while a change can still land");
    assert.equal(await hub.setMode("vote"), false, "no new change starts while the party is ending");
    release();
    await Promise.all([change, ending]);
    assert.deepEqual(calls, [`close ${ROOM_ID}`]);
});

test("Try Again on an empty season list asks the server for the seasons again", async () => {
    const season = { id: "s1", seasonNumber: 1, title: "Season 1", episodeCount: 1, posterUrl: undefined, isSpecials: false };
    let reads = 0;
    const { hub } = lobby({ seasons: async () => { reads++; return reads === 1 ? [] : [season]; }, episodes: async () => [] });
    await hub.create("host_pick");
    const series = decodeCard({ content_id: "series:s1", type: "series", title: "Harbor Lights" }, "card");
    await hub.openEpisodes(series);
    assert.deepEqual(hub.state.seasons, []);
    await hub.openEpisodes(series, undefined, true);
    assert.equal(reads, 2);
    assert.equal(hub.state.seasons?.length, 1);
});

test("Try Again on a failed season keeps the seasons it already has", async () => {
    const season = { id: "s1", seasonNumber: 1, title: "Season 1", episodeCount: 1, posterUrl: undefined, isSpecials: false };
    let seasonReads = 0;
    let episodeReads = 0;
    const { hub } = lobby({ seasons: async () => { seasonReads++; return [season]; }, episodes: async () => { if (++episodeReads === 1) throw problem(503, "Down."); return []; } });
    await hub.create("host_pick");
    const series = decodeCard({ content_id: "series:s1", type: "series", title: "Harbor Lights" }, "card");
    await hub.openEpisodes(series);
    assert.notEqual(hub.state.browseError, undefined);
    await hub.openEpisodes(series, season, true);
    assert.equal(seasonReads, 1, "only the episodes are read again");
    assert.equal(episodeReads, 2);
});

test("an older season's episodes cannot land after a newer season was asked for", async () => {
    const seasonOf = (n: number) => ({ id: `s${n}`, seasonNumber: n, title: `Season ${n}`, episodeCount: 1, posterUrl: undefined, isSpecials: false });
    const episodeOf = (n: number) => ({ id: `episode:${n}`, seasonNumber: n, episodeNumber: 1, title: "One", runtimeMinutes: 40, stillUrl: undefined, played: false });
    const releases = new Map<number, () => void>();
    const { hub } = lobby({ seasons: async () => [seasonOf(1), seasonOf(2)], episodes: (_id, n) => new Promise(resolve => { releases.set(n, () => resolve([episodeOf(n)])); }) });
    await hub.create("host_pick");
    const series = decodeCard({ content_id: "series:s1", type: "series", title: "Harbor Lights" }, "card");
    const first = hub.openEpisodes(series);
    await new Promise(resolve => setTimeout(resolve, 0));
    const second = hub.openEpisodes(series, seasonOf(2));
    await new Promise(resolve => setTimeout(resolve, 0));
    releases.get(2)?.();
    await second;
    releases.get(1)?.();
    await first;
    assert.deepEqual(hub.state.episodes?.map(entry => entry.id), ["episode:2"]);
});

test("Return everyone to lobby needs the stop capability and a playing room", async () => {
    let stops = 0;
    const stopPlayback = async () => { stops++; return roomAccess({ phase: "lobby", selected_content_id: "movie:m0004" }); };
    const playing = { phase: "playing", selected_content_id: "movie:m0004", selected_file_id: "42" };
    const without = lobby({ stopPlayback }, { staged_selection: true }, playing);
    await without.hub.create("host_pick");
    assert.equal(await without.hub.stopPlayback(), false);
    const inLobby = lobby({ stopPlayback });
    await inLobby.hub.create("host_pick");
    assert.equal(await inLobby.hub.stopPlayback(), false);
    const ready = lobby({ stopPlayback }, undefined, playing);
    await ready.hub.create("host_pick");
    assert.equal(await ready.hub.stopPlayback(), true);
    assert.equal(ready.hub.state.room?.phase, "lobby");
    assert.equal(stops, 1);
});

test("who chooses and who controls playback change with the host's calls and show the room that came back", async () => {
    const calls: string[] = [];
    const { hub } = lobby({
        setSelectionMode: async (_id, mode) => { calls.push(`mode ${mode}`); return roomAccess({ selection_mode: mode }); },
        setGuestControlPolicy: async (_id, policy) => { calls.push(`policy ${policy}`); return roomAccess({ guest_control_policy: policy }); },
    });
    await hub.create("host_pick");
    assert.equal(await hub.setMode("vote"), true);
    assert.equal(hub.state.room?.selectionMode, "vote");
    assert.equal(await hub.setPolicy("guest_play_pause"), true);
    assert.equal(hub.state.room?.guestControlPolicy, "guest_play_pause");
    assert.deepEqual(calls, ["mode vote", "policy guest_play_pause"]);
});

test("the mode switch needs its capability and a lobby, and a guest changes nothing", async () => {
    const calls: string[] = [];
    const ops = { setSelectionMode: async () => { calls.push("mode"); return roomAccess(); }, setGuestControlPolicy: async () => { calls.push("policy"); return roomAccess(); } };
    const without = lobby(ops, {});
    await without.hub.create("host_pick");
    assert.equal(await without.hub.setMode("vote"), false);
    const playing = lobby(ops, undefined, { phase: "playing", selected_content_id: "movie:m0004" });
    await playing.hub.create("host_pick");
    assert.equal(await playing.hub.setMode("vote"), false);
    const guest = lobby(ops, undefined, { self_can_manage_room: false });
    await guest.hub.create("host_pick");
    assert.equal(await guest.hub.setMode("vote"), false);
    assert.equal(await guest.hub.setPolicy("guest_play_pause"), false);
    assert.deepEqual(calls, []);
});

test("End party closes the room, leaves the room screen and says the party ended; a refused close keeps the room", async () => {
    const ended = lobby();
    await ended.hub.create("host_pick");
    await ended.hub.endParty();
    assert.deepEqual(ended.calls, [`close ${ROOM_ID}`]);
    assert.equal(ended.hub.state.room, undefined);
    assert.equal(ended.hub.state.error, "This party has ended.");
    const refused = lobby({ closeRoom: async () => { throw problem(500, "Try later."); } });
    await refused.hub.create("host_pick");
    await refused.hub.endParty();
    assert.notEqual(refused.hub.state.room, undefined);
    assert.equal(refused.hub.state.busy, false);
    assert.match(refused.hub.state.error ?? "", /Try later\./);
});

test("a guest has no End party; leaving just exits the room screen and calls nothing", async () => {
    const guest = lobby({}, undefined, { self_can_manage_room: false });
    await guest.hub.create("host_pick");
    await guest.hub.endParty();
    assert.notEqual(guest.hub.state.room, undefined);
    guest.hub.leave();
    assert.equal(guest.hub.state.room, undefined);
    assert.deepEqual(guest.calls, []);
});

test("the picker reads the shelves once with the room token and lists group picks before watchlists", async () => {
    const tokens: string[] = [];
    const entry = (id: string) => ({ card: decodeCard({ content_id: id, type: "movie", title: id }, "card"), members: [], nextUp: undefined });
    const { hub } = lobby({ picker: async (_id, token) => { tokens.push(token); return { members: [], continueTogether: [entry("movie:a")], watchlistUnion: [entry("movie:b")] }; } });
    await hub.create("host_pick");
    await hub.openPicker();
    assert.deepEqual(tokens, ["room-proof"]);
    assert.equal(hub.state.page.kind, "picker");
    assert.deepEqual(hub.state.shelves.map(shelf => [shelf.title, shelf.entries.map(entry => entry.card.id)]), [["Continue Together", ["movie:a"]], ["On Your Watchlists", ["movie:b"]]]);
    assert.equal(hub.state.shelvesLoading, false);
});

test("a server without the picker reads the viewer's own watchlist instead", async () => {
    let reads = 0;
    const { hub } = lobby({ watchlist: async () => { reads++; return { items: [decodeCard({ content_id: "movie:w", type: "movie", title: "Saved" }, "card")], nextCursor: undefined, total: 1, totalExact: true }; } }, { staged_selection: true });
    await hub.create("host_pick");
    await hub.openPicker();
    assert.equal(reads, 1);
    assert.deepEqual(hub.state.shelves.map(shelf => shelf.title), ["On Your Watchlists"]);
});

test("a failed picker read says so and can be tried again", async () => {
    let fail = true;
    const { hub } = lobby({ picker: async () => { if (fail) throw problem(503, "Down."); return { members: [], continueTogether: [], watchlistUnion: [] }; } });
    await hub.create("host_pick");
    await hub.openPicker();
    assert.equal(hub.state.shelvesError, "Down.");
    fail = false;
    await hub.openPicker();
    assert.equal(hub.state.shelvesError, undefined);
});

test("a series with no next-up opens its first season that is not specials, and another season reads its own episodes", async () => {
    const reads: string[] = [];
    const season = (n: number, over: Record<string, unknown> = {}) => ({ id: `series:s1-S${n}`, seasonNumber: n, title: n === 0 ? "Specials" : `Season ${n}`, episodeCount: 2, posterUrl: undefined, isSpecials: n === 0, ...over });
    const episode = (n: number, seasonNumber: number) => ({ id: `episode:${seasonNumber}${n}`, seasonNumber, episodeNumber: n, title: `Chapter ${n}`, runtimeMinutes: 45, stillUrl: undefined, played: false });
    const { hub } = lobby({
        seasons: async id => { reads.push(`seasons ${id}`); return [season(0), season(1), season(2)]; },
        episodes: async (id, number) => { reads.push(`episodes ${id} ${number}`); return [episode(1, number), episode(2, number)]; },
    });
    await hub.create("host_pick");
    const series = decodeCard({ content_id: "series:s1", type: "series", title: "Harbor Lights" }, "card");
    await hub.openEpisodes(series);
    assert.deepEqual(reads, ["seasons series:s1", "episodes series:s1 1"]);
    assert.equal(hub.state.page.kind === "episodes" && hub.state.page.season?.seasonNumber, 1);
    assert.deepEqual(hub.state.episodes?.map(entry => entry.id), ["episode:11", "episode:12"]);
    const second = hub.state.seasons?.find(entry => entry.seasonNumber === 2);
    assert.notEqual(second, undefined);
    if (second !== undefined) await hub.openEpisodes(series, second);
    assert.deepEqual(reads.slice(2), ["episodes series:s1 2"], "the seasons of the same series are not read again");
    assert.deepEqual(hub.state.episodes?.map(entry => entry.id), ["episode:21", "episode:22"]);
    assert.equal(hub.state.browseLoading, false);
});

test("a failed episode read says so and keeps the page open for another try", async () => {
    const { hub } = lobby({ seasons: async () => { throw problem(503, "Down."); } });
    await hub.create("host_pick");
    await hub.openEpisodes(decodeCard({ content_id: "series:s1", type: "series", title: "Harbor Lights" }, "card"));
    assert.equal(hub.state.browseError, "Down.");
    assert.equal(hub.state.browseLoading, false);
    assert.equal(hub.state.page.kind, "episodes");
});

test("shelves that arrive ask the next render to drop its carried focus, once", async () => {
    const { hub } = lobby({ picker: async () => ({ members: [], continueTogether: [{ card: decodeCard({ content_id: "movie:a", type: "movie", title: "A" }, "card"), members: [], nextUp: undefined }], watchlistUnion: [] }) });
    await hub.create("host_pick");
    assert.equal(hub.takeRefocus(), false);
    await hub.openPicker();
    assert.equal(hub.takeRefocus(), true);
    assert.equal(hub.takeRefocus(), false);
});

test("Back walks the room's pages one at a time and only leaves the room from the lobby", async () => {
    const { hub, calls } = lobby();
    await hub.create("host_pick");
    const pageKind = (): string => hub.state.page.kind;
    hub.show({ kind: "options" });
    hub.back();
    assert.equal(pageKind(), "lobby");
    hub.show({ kind: "choice", choice: movie() });
    hub.back();
    assert.equal(pageKind(), "picker", "a choice returns to the shelves");
    hub.back();
    assert.equal(pageKind(), "lobby");
    assert.notEqual(hub.state.room, undefined);
    hub.back();
    assert.equal(hub.state.room, undefined, "Back from the lobby leaves, and the host's room ends");
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(calls, [`close ${ROOM_ID}`]);
});

// --- What the lobby foregrounds, from WatchPartyLobbyPolicy.primaryAction ---

test("the primary action follows the room: choose, start, return to playback, return everyone to lobby, or nothing for a guest without Ready", async () => {
    const caps = roomCapabilities({ stop_playback: true });
    const room = (over: Record<string, unknown> = {}) => roomAccess(over).room;
    assert.equal(primaryAction(room(), caps, false), "chooseTitle");
    assert.equal(primaryAction(room({ selected_content_id: "movie:m1" }), caps, true), "start");
    assert.equal(primaryAction(room({ selected_content_id: "movie:m1" }), caps, false), "chooseTitle", "a title the host cannot start yet lays out as Change title");
    assert.equal(primaryAction(room({ phase: "playing", selected_content_id: "movie:m1" }), caps, false), "returnToPlayback");
    assert.equal(primaryAction(room({ self_can_manage_room: false }), caps, false), "none", "Ready needs the socket");
    assert.equal(primaryAction(room({ phase: "playing", self_can_manage_room: false, selected_content_id: "movie:m1" }), caps, false), "returnToPlayback");
    assert.equal(primaryAction(room({ phase: "ended" }), caps, false), "none");
    assert.equal(primaryAction(room({ selection_mode: "vote" }), caps, false), "none", "voting is not built");
});

test("a guest who cannot see the playing title has nothing to return to, as WatchPartyLobbyPolicy.primaryAction", () => {
    const caps = roomCapabilities({ stop_playback: true });
    const playing = (over: Record<string, unknown> = {}) => roomAccess({ phase: "playing", selected_content_id: "movie:m1", ...over }).room;
    assert.equal(primaryAction(playing({ self_can_manage_room: false }), caps, false, true), "none");
    assert.equal(primaryAction(playing(), caps, false, true), "returnToPlayback", "the host can still return to a title they cannot see");
    assert.equal(primaryAction(playing({ self_can_manage_room: false }), caps, false, false), "returnToPlayback", "a guest who can see it returns");
    assert.equal(primaryAction(playing(), caps, false, true, true), "returnToLobby", "a parked player still offers the host the lobby");
});

test("an episode lays out as Apple's lobby does: its own title, with the series and code underneath", () => {
    const pick = episode();
    assert.equal(pick.title, "Harbor Lights", "the picker page leads with the series");
    assert.equal(pick.subtitle, "S1 · E2 · Chapter 1.2");
    assert.equal(pick.lobby.title, "Chapter 1.2");
    assert.equal(pick.lobby.subtitle, "Harbor Lights · S1:E2");
    assert.equal(pick.lobby.backdropUrl, "/series-b.jpg", "an episode never shows its own still");
    assert.equal(pick.lobby.overview, undefined, "or its description");
    const film = movie();
    assert.deepEqual(film.lobby.facts, ["1994", "2h 6m"]);
    assert.equal(film.lobby.backdropUrl, "/b.jpg");
});

// --- The invitation link, from WatchPartyLobbyPolicy.inviteURL ---

test("the invite path becomes a link on this server, and only on this server", () => {
    assert.equal(inviteUrl("/rooms/join?token=abc", "https://silo.example"), "https://silo.example/rooms/join?token=abc");
    assert.equal(inviteUrl("/rooms/join?token=abc", "https://silo.example/media/"), "https://silo.example/media/rooms/join?token=abc", "a server under a path keeps it");
    assert.equal(inviteUrl("https://silo.example:443/rooms/join?token=abc", "https://silo.example"), "https://silo.example/rooms/join?token=abc");
    for (const refused of [
        "https://other.example/rooms/join?token=abc", "https://silo.example/rooms/join", "https://silo.example/rooms/join?token=", "https://silo.example/rooms/join?token=a&token=b",
        "https://silo.example/rooms/join?token=a#frag", "https://user@silo.example/rooms/join?token=a", "http://silo.example/rooms/join?token=a", "ftp://silo.example/rooms/join?token=a",
        "/rooms/other?token=a", "//silo.example/rooms/join?token=a", "https://silo.example/media/rooms/join?token=a", "",
    ]) assert.equal(inviteUrl(refused, "https://silo.example"), undefined, refused);
    assert.equal(inviteUrl("/rooms/join?token=abc", "not a url"), undefined);
});
