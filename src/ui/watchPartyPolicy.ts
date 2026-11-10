// Apple's WatchPartyLobbyPolicy for the parts the lobby uses before the room socket exists.

import type { Room, RoomMember, WatchTogetherCapabilities } from "../contracts/v2/watchTogether.ts";

export type SeatState = "ready" | "notReady" | "away" | "watching" | "joining" | "buffering" | "syncing";

/** WatchPartyLobbyPolicy.seatState. The host starts playback, so the host never has to mark ready. */
export function seatState(member: RoomMember, phase: Room["phase"]): SeatState {
    if (!member.connected) return "away";
    if (phase === "lobby") return member.isHost || member.lobbyReady ? "ready" : "notReady";
    if (member.isBuffering) return "buffering";
    if (member.isSyncing) return "syncing";
    return member.isReady ? "watching" : "joining";
}

/** WatchPartyLobbyPolicy.presenceSummary: "2 of 3 ready". */
export function presenceSummary(members: readonly RoomMember[], phase: Room["phase"]): string {
    const here = members.filter(member => member.connected);
    if (here.length <= 1) return here.length === 1 ? "only you so far" : "nobody connected";
    const wanted: SeatState = phase === "lobby" ? "ready" : "watching";
    return `${here.filter(member => seatState(member, phase) === wanted).length} of ${here.length} ${phase === "lobby" ? "ready" : "watching"}`;
}

/** WatchPartyLobbyPolicy.waitingNames: connected guests who have not marked ready, for the host's advisory hint. */
export function waitingNames(members: readonly RoomMember[]): string[] {
    return members.filter(member => member.connected && !member.isHost && !member.lobbyReady).map(member => member.displayName);
}

/**
 * The one action the lobby foregrounds, WatchPartyLobbyPolicy.primaryAction without voting and without
 * Ready, which both need the room socket. `canStart` is WatchPartySession.canStartPlayback.
 */
export type PrimaryAction = "chooseTitle" | "start" | "returnToPlayback" | "returnToLobby" | "none";

export function primaryAction(room: Room, capabilities: WatchTogetherCapabilities | undefined, canStart: boolean, playbackEnded = false): PrimaryAction {
    if (room.phase === "playing") {
        if (playbackEnded) return room.selfCanManageRoom && capabilities?.stopPlayback === true ? "returnToLobby" : "none";
        return "returnToPlayback";
    }
    if (room.phase !== "lobby" || !room.selfCanManageRoom || room.selectionMode !== "host_pick") return "none";
    if (room.selectedContentId === undefined) return "chooseTitle";
    return canStart ? "start" : "chooseTitle";
}
