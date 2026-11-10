// The Watch Party server surface the hub talks to: the playback-feature gate, the API over the active
// session, the failure wording and the new-room id. See watchPartyHub.ts for the session that uses them.

import { ApiError } from "../api/errors.ts";
import { operations } from "../api/operations.ts";
import type { RequestSpec } from "../api/http.ts";
import { watchTogetherOperations } from "../api/watchTogetherOperations.ts";
import type { CatalogPage, Episode, ItemDetail, Season } from "../contracts/v2/catalog.ts";
import type { PlaybackCapabilities } from "../contracts/v2/playback.ts";
import {
    type CreatableSelectionMode, type GuestControlPolicy, type NewSuggestion, type Picker, type RoomAccess, type RoomSelection, type SuggestionPage,
    roomSocketHandshake, type WatchTogetherCapabilities, watchTogetherSocketSupported,
} from "../contracts/v2/watchTogether.ts";
import type { NativeSession } from "../session/session.ts";
import { errorState } from "./browseRoutes.ts";
import type { RoomSocketApi } from "./watchPartySocket.ts";

/** The playback features Apple requires of a server before it offers a synchronized party. */
const PLAYBACK_FEATURES = ["watch_party_coordinator_v1", "fixed_media_file_v1"] as const;
/** Apple's picker reads 40 watchlist items when the server has no picker. */
const WATCHLIST_LIMIT = 40;

/** WatchPartySession.supportsSynchronizedParty: the room gate and socket, plus coordinated fixed-file playback. */
export function supportsSynchronizedParty(room: WatchTogetherCapabilities, playback: PlaybackCapabilities): boolean {
    return watchTogetherSocketSupported(room) && playback.state === "available" && playback.allowed
        && PLAYBACK_FEATURES.every(feature => playback.features.includes(feature));
}

export interface WatchPartyApi extends RoomSocketApi {
    capabilities(signal: AbortSignal): Promise<WatchTogetherCapabilities>;
    playbackCapabilities(signal: AbortSignal): Promise<PlaybackCapabilities>;
    createRoom(roomId: string, mode: CreatableSelectionMode, signal: AbortSignal): Promise<RoomAccess>;
    joinByCode(code: string, signal: AbortSignal): Promise<RoomAccess>;
    closeRoom(roomId: string, signal: AbortSignal): Promise<void>;
    stageSelection(roomId: string, selection: RoomSelection, signal: AbortSignal): Promise<RoomAccess>;
    selectItem(roomId: string, selection: RoomSelection, signal: AbortSignal): Promise<RoomAccess>;
    startPlayback(roomId: string, signal: AbortSignal): Promise<RoomAccess>;
    stopPlayback(roomId: string, signal: AbortSignal): Promise<RoomAccess>;
    setSelectionMode(roomId: string, mode: CreatableSelectionMode, signal: AbortSignal): Promise<RoomAccess>;
    setGuestControlPolicy(roomId: string, policy: Exclude<GuestControlPolicy, "unknown">, signal: AbortSignal): Promise<RoomAccess>;
    /** The room as it now stands, read with the room token, to reconcile after a change whose answer was lost. */
    room(roomId: string, token: string, signal: AbortSignal): Promise<RoomAccess>;
    picker(roomId: string, token: string, signal: AbortSignal): Promise<Picker>;
    suggestions(roomId: string, token: string, cursor: string | undefined, signal: AbortSignal): Promise<SuggestionPage>;
    addSuggestion(roomId: string, token: string, suggestion: NewSuggestion, signal: AbortSignal): Promise<string>;
    setVote(roomId: string, token: string, suggestionId: string, voted: boolean, signal: AbortSignal): Promise<void>;
    promoteSuggestion(roomId: string, token: string, suggestionId: string, signal: AbortSignal): Promise<RoomAccess>;
    item(contentId: string, signal: AbortSignal): Promise<ItemDetail>;
    seasons(seriesId: string, signal: AbortSignal): Promise<Season[]>;
    episodes(seriesId: string, seasonNumber: number, signal: AbortSignal): Promise<Episode[]>;
    watchlist(signal: AbortSignal): Promise<CatalogPage>;
}

export function watchPartyApi(session: Pick<NativeSession, "call" | "http">): WatchPartyApi {
    const call = <T>(spec: RequestSpec<T>, signal: AbortSignal): Promise<T> => session.call({ ...spec, profileScoped: true, signal });
    return {
        capabilities: signal => call(watchTogetherOperations.capabilities(), signal),
        playbackCapabilities: signal => call(operations.playbackCapabilities(), signal),
        createRoom: (roomId, mode, signal) => call(watchTogetherOperations.createRoom(roomId, mode), signal),
        joinByCode: (code, signal) => call(watchTogetherOperations.joinByCode(code), signal),
        closeRoom: (roomId, signal) => call(watchTogetherOperations.closeRoom(roomId), signal),
        stageSelection: (roomId, selection, signal) => call(watchTogetherOperations.stageSelection(roomId, selection), signal),
        selectItem: (roomId, selection, signal) => call(watchTogetherOperations.selectItem(roomId, selection), signal),
        startPlayback: (roomId, signal) => call(watchTogetherOperations.startPlayback(roomId), signal),
        stopPlayback: (roomId, signal) => call(watchTogetherOperations.stopPlayback(roomId), signal),
        setSelectionMode: (roomId, mode, signal) => call(watchTogetherOperations.setSelectionMode(roomId, mode), signal),
        setGuestControlPolicy: (roomId, policy, signal) => call(watchTogetherOperations.setGuestControlPolicy(roomId, policy), signal),
        room: (roomId, token, signal) => call(watchTogetherOperations.room(roomId, token), signal),
        picker: (roomId, token, signal) => call(watchTogetherOperations.picker(roomId, token), signal),
        suggestions: (roomId, token, cursor, signal) => call(watchTogetherOperations.suggestions(roomId, token, cursor), signal),
        addSuggestion: (roomId, token, suggestion, signal) => call(watchTogetherOperations.addSuggestion(roomId, token, suggestion), signal),
        setVote: (roomId, token, suggestionId, voted, signal) => call(watchTogetherOperations.setVote(roomId, token, suggestionId, voted), signal),
        promoteSuggestion: (roomId, token, suggestionId, signal) => call(watchTogetherOperations.promoteSuggestion(roomId, token, suggestionId), signal),
        socketTicket: (roomId, token, signal) => call(watchTogetherOperations.socketTicket(roomId, token), signal),
        socketHandshake: (roomId, ticket) => roomSocketHandshake(session.http.base.apiRoot, roomId, ticket),
        item: (contentId, signal) => call(operations.getCatalogItem(contentId), signal),
        seasons: (seriesId, signal) => call(operations.listSeriesSeasons(seriesId), signal),
        episodes: (seriesId, seasonNumber, signal) => call(operations.listSeasonEpisodes(seriesId, seasonNumber), signal),
        watchlist: signal => call(operations.listPersonalItems("watchlist", { limit: WATCHLIST_LIMIT }), signal),
    };
}

/** Apple shows the server's own text for a refused create or join (APIv2Error.problem: detail, else title), where the shared wording hides it for 403 and 404. */
export function watchPartyFailureText(error: unknown): string {
    if (error instanceof ApiError && error.failure.kind === "problem" && (error.failure.problem.status === 403 || error.failure.problem.status === 404)) {
        const { detail, title } = error.failure.problem;
        const text = detail?.trim() || title.trim();
        if (text !== "") return text;
    }
    return errorState(error).message;
}

/** A random version 4 UUID, lower case, as Apple sends for a new room. */
export function uuidV4(fill: (bytes: Uint8Array<ArrayBuffer>) => void = bytes => { crypto.getRandomValues(bytes); }): string {
    const bytes = new Uint8Array(16);
    fill(bytes);
    bytes[6] = (bytes[6] ?? 0) & 0x0f | 0x40;
    bytes[8] = (bytes[8] ?? 0) & 0x3f | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
