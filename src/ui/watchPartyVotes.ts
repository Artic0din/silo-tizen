// Apple's WatchPartyVotes and WatchPartyLobbyPolicy.voteWinner: the vote-mode ballot. The socket's
// suggestions_update carries every member's common rows with voted_by_me false, so only an HTTP read
// says how this profile voted. A read that began before a newer socket update or a vote is stale.

import type { Suggestion } from "../contracts/v2/watchTogether.ts";

export class RoomVotes {
    private rowsValue: readonly Suggestion[] = [];
    /** This profile's vote per suggestion, from the last HTTP read; a row missing here is still loading. */
    private personal = new Map<string, boolean>();
    /** Bumps on every socket update and every vote change, so an HTTP read can tell it was overtaken. */
    revision = 0;

    get rows(): readonly Suggestion[] { return this.rowsValue; }

    /** This profile's vote, or undefined until an HTTP read has said. */
    voted(id: string): boolean | undefined { return this.personal.get(id); }

    /** A socket update: the newest tallies, with this profile's votes kept from the last read. */
    receive(suggestions: readonly Suggestion[]): void {
        this.rowsValue = suggestions.map(row => ({ ...row, votedByMe: this.personal.get(row.id) ?? false }));
        this.revision++;
    }

    /** An HTTP read that started at `requestedAt`. Refused when anything newer arrived meanwhile. */
    reconcile(suggestions: readonly Suggestion[], requestedAt: number): boolean {
        if (this.revision !== requestedAt) return false;
        this.personal = new Map(suggestions.map(row => [row.id, row.votedByMe]));
        this.rowsValue = suggestions;
        return true;
    }

    /** The server accepted this profile's vote; it stands until a read says otherwise. */
    confirm(id: string, voted: boolean): void { this.personal.set(id, voted); }

    /** A vote or suggestion is being written: reads already out describe the ballot before it. */
    invalidatePersonalReads(): void { this.revision++; }
}

/** The most votes wins; a tie goes to the earlier suggestion, then the smaller id. Nobody voted is no winner. */
export function voteWinner(suggestions: readonly Suggestion[]): Suggestion | undefined {
    let winner: Suggestion | undefined;
    for (const row of suggestions) {
        if (row.voteCount <= 0) continue;
        if (winner === undefined || row.voteCount > winner.voteCount
            || (row.voteCount === winner.voteCount && (row.createdAt < winner.createdAt || (row.createdAt === winner.createdAt && row.id < winner.id)))) winner = row;
    }
    return winner;
}
