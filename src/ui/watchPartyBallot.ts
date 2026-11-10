// Apple's WatchPartyBallot on tvOS: in a vote room's lobby, every suggestion as a poster card with its
// tally badge, a tick on the ones this profile voted for and an outline on the leader, then the dashed
// Suggest a title card. Pressing a card votes or takes the vote back. Metrics are Apple's tvOS values.
// Not built: the cards' long-press menu (Start this one, Remove suggestion).

import type { Suggestion } from "../contracts/v2/watchTogether.ts";
import type { FocusItem } from "./browseFocus.ts";
import { actionButton, artwork } from "./browseViews.ts";
import { el } from "./screen.ts";
import { checkIcon, plusIcon } from "./watchPartyParts.ts";
import type { WatchPartyHub } from "./watchPartyHub.ts";

const votes = (count: number): string => `${count} ${count === 1 ? "vote" : "votes"}`;

/** The card's label, as Apple's accessibility label: what pressing it does. */
function voteLabel(suggestion: Suggestion, voted: boolean | undefined): string {
    if (voted === undefined) return "Loading your vote";
    return voted ? `Remove vote for ${suggestion.title}` : `Vote for ${suggestion.title}`;
}

/** WatchPartyCandidateCard. Apple disables the card until this profile's vote is known or while a change runs; it stays focusable here so focus never drops, and a press then does nothing. */
function candidate(hub: WatchPartyHub, suggestion: Suggestion, leader: boolean, baseUrl: string): FocusItem {
    const voted = hub.state.votes.voted(suggestion.id);
    const usable = voted !== undefined && !hub.state.busy && hub.state.connection === "connected";
    const item = actionButton(`suggestion:${suggestion.id}`, "", () => { if (usable && voted !== undefined) void hub.vote(suggestion.id, !voted); });
    item.element.classList.add("watch-party-candidate");
    if (leader) item.element.classList.add("watch-party-candidate-leader");
    item.element.setAttribute("aria-disabled", String(!usable));
    item.element.setAttribute("aria-pressed", String(voted === true));
    item.element.setAttribute("aria-label", `${voteLabel(suggestion, voted)}, ${votes(suggestion.voteCount)}${leader ? ", leading" : ""}`);
    const poster = el("span", "watch-party-candidate-poster");
    poster.appendChild(artwork("watch-party-candidate-art", suggestion.posterUrl === "" ? undefined : suggestion.posterUrl, baseUrl, ""));
    const badge = el("span", "watch-party-vote-badge");
    badge.append(el("span", "watch-party-vote-count", String(suggestion.voteCount)), el("span", "watch-party-vote-label", suggestion.voteCount === 1 ? "VOTE" : "VOTES"));
    poster.appendChild(badge);
    if (voted === true) {
        const tick = el("span", "watch-party-candidate-tick");
        tick.appendChild(checkIcon());
        poster.appendChild(tick);
    }
    const line = suggestion.note !== "" ? `“${suggestion.note}”` : suggestion.subtitle;
    item.element.append(poster, el("span", "watch-party-candidate-title", suggestion.title), el("span", "watch-party-candidate-line", line === "" ? " " : line));
    return item;
}

/** WatchPartySuggestCardLabel: the dashed card that opens the picker to suggest a title. */
function suggestCard(hub: WatchPartyHub): FocusItem {
    const item = actionButton("ballot-suggest", "", () => { if (!hub.state.busy) void hub.openPicker("suggest"); });
    item.element.classList.add("watch-party-candidate", "watch-party-suggest-card");
    item.element.setAttribute("aria-label", "Suggest a title");
    const poster = el("span", "watch-party-candidate-poster");
    poster.appendChild(plusIcon());
    item.element.append(poster, el("span", "watch-party-candidate-title", "Suggest a title"), el("span", "watch-party-candidate-line", "Anyone can add one"));
    return item;
}

/** The ballot row and its cards, keyed by suggestion id so focus stays on a card while tallies change. */
export function ballotRow(hub: WatchPartyHub, baseUrl: string): { readonly node: HTMLElement; readonly items: readonly FocusItem[] } {
    const leader = hub.winner()?.id;
    const items = [...hub.state.votes.rows.map(row => candidate(hub, row, row.id === leader, baseUrl)), suggestCard(hub)];
    const node = el("div", "watch-party-ballot");
    node.setAttribute("role", "group");
    node.setAttribute("aria-label", "Suggestions");
    node.append(...items.map(item => item.element));
    return { node, items };
}
