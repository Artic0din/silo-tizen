// Apple's WatchPartyHubView on tvOS: the create-or-join entry and, once a room is open, a placeholder
// lobby (code and members from one room read). The full lobby, socket and playback come later.
// Metrics are Apple's tvOS values at 1920x1080 (WatchPartyMetrics).

import type { Room, RoomMember } from "../contracts/v2/watchTogether.ts";
import type { FocusItem, View } from "./browseFocus.ts";
import { actionButton } from "./browseViews.ts";
import { el } from "./screen.ts";
import type { WatchPartyHub } from "./watchPartyHub.ts";

/** What a route keeps across renders: the hub, and the code field so a focused field is never rebuilt. */
export interface WatchPartyScreen { readonly hub: WatchPartyHub; readonly input: HTMLInputElement }

export function watchPartyScreen(hub: WatchPartyHub): WatchPartyScreen {
    const input = el("input", "browse-input watch-party-input");
    input.type = "text";
    input.placeholder = "Party code or invite link";
    input.setAttribute("aria-label", "Party code or invite link");
    input.setAttribute("data-focus", "code");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocapitalize", "characters");
    input.spellcheck = false;
    return { hub, input };
}

const plusIcon = (): SVGSVGElement => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "watch-party-icon");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", "M12 3v18M3 12h18");
    svg.appendChild(path);
    return svg;
};

function eyebrow(text: string): HTMLElement { return el("p", "watch-party-eyebrow", text); }

function banner(message: string, warning: boolean): HTMLElement {
    const node = el("div", `watch-party-banner${warning ? " watch-party-banner-warning" : ""}`);
    node.setAttribute("role", "alert");
    node.append(el("span", "watch-party-banner-dot"), el("span", "watch-party-banner-text", message));
    return node;
}

function pill(item: FocusItem, kind: "primary" | "secondary", disabled: boolean): FocusItem {
    item.element.classList.add("watch-party-button", `watch-party-${kind}`);
    item.element.setAttribute("aria-disabled", String(disabled));
    return item;
}

export function watchPartyView(screen: WatchPartyScreen, back: () => void): View {
    const { hub } = screen;
    const room = hub.state.room;
    return room === undefined ? entryView(screen, back) : lobbyView(hub, room);
}

function entryView({ hub, input }: WatchPartyScreen, back: () => void): View {
    const { supported, checking, error } = hub.state;
    const unusable = !supported;
    const message = error ?? (unusable ? (checking ? "Checking Watch Party support…" : "Watch Party is not available for this profile on this server.") : undefined);
    const intro = el("div", "watch-party-intro");
    const headline = el("div", "watch-party-headline");
    headline.append(eyebrow("Watch Party"), el("h1", "watch-party-title", "Watch something\ntogether"), el("p", "watch-party-body", "Pick a title, share the code, and everyone's playback stays in step."));
    intro.append(headline);
    if (message !== undefined) intro.append(banner(message, error !== undefined));

    const create = pill(actionButton("create", "Start a party", () => { if (!unusable) void hub.create("host_pick"); }), "primary", unusable);
    create.element.prepend(plusIcon());
    const vote = pill(actionButton("vote", "Start a party and let everyone vote", () => { if (!unusable) void hub.create("vote"); }), "secondary", unusable);
    const joinable = (): boolean => !unusable && input.value.trim() !== "";
    const join = pill(actionButton("join", "Join party", () => { if (joinable()) void hub.join(input.value); }), "secondary", !joinable());
    // Typing must not rebuild the page, which would drop the field's focus; the one dependent control follows the text.
    input.oninput = () => join.element.setAttribute("aria-disabled", String(!joinable()));
    const retry = unusable ? pill(actionButton("retry", "Check again", () => { if (!checking) void hub.check(); }), "secondary", checking) : undefined;

    const host = el("div", "watch-party-section");
    host.append(eyebrow("Host"), create.element, vote.element);
    const joinSection = el("div", "watch-party-section");
    joinSection.append(eyebrow("Join"), input, join.element, ...(retry === undefined ? [] : [retry.element]));
    const actions = el("div", "watch-party-actions");
    actions.append(host, joinSection);
    const page = el("div", "watch-party");
    page.append(intro, actions);

    return {
        name: "watchParty:hub",
        content: [page],
        zones: [{ id: "party", layout: "column", items: [create, vote, { key: "code", element: input }, join, ...(retry === undefined ? [] : [retry])] }],
        focus: { zone: "party", key: "create" },
        back,
    };
}

// --- Placeholder lobby ---

type SeatState = "ready" | "notReady" | "away" | "watching" | "joining" | "buffering" | "syncing";

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

const STATUS_TEXT: Partial<Record<SeatState, string>> = { notReady: "not ready", away: "reconnecting", syncing: "syncing", buffering: "buffering", joining: "joining" };

/** Host first, then this viewer, then by name. */
function ordered(members: readonly RoomMember[]): RoomMember[] {
    return [...members].sort((a, b) => a.isHost !== b.isHost ? (a.isHost ? -1 : 1) : a.isSelf !== b.isSelf ? (a.isSelf ? -1 : 1) : a.displayName.localeCompare(b.displayName));
}

const PALETTE: readonly (readonly [string, string])[] = [["#5A4A8A", "#2B2450"], ["#8A5A3A", "#4A2C1C"], ["#3A7A6A", "#1C3F36"], ["#7A3A5A", "#3F1C30"], ["#4A6A8A", "#213546"], ["#7A6A2A", "#3F3616"]];

/** WatchPartySeat.avatarGradient: djb2 over the id's scalars, in Swift's wrapping Int. */
export function avatarColors(id: string): readonly [string, string] {
    let hash = 5381n;
    for (const scalar of id) hash = BigInt.asIntN(64, hash * 33n + BigInt(scalar.codePointAt(0) ?? 0));
    const index = Number((hash < 0n ? -hash : hash) % BigInt(PALETTE.length));
    return PALETTE[index] ?? PALETTE[0] as readonly [string, string];
}

const SVG = "http://www.w3.org/2000/svg";

function seat(member: RoomMember, phase: Room["phase"]): HTMLElement {
    const state = seatState(member, phase);
    const node = el("div", "watch-party-seat");
    node.dataset.state = state;
    const [from, to] = avatarColors(member.userId);
    const disc = el("span", "watch-party-seat-disc", member.displayName.trim().slice(0, 1).toUpperCase());
    disc.style.background = `linear-gradient(135deg, ${from}, ${to})`;
    const ring = document.createElementNS(SVG, "svg");
    ring.setAttribute("viewBox", "0 0 146 146");
    ring.setAttribute("class", "watch-party-seat-ring");
    ring.setAttribute("aria-hidden", "true");
    const circle = document.createElementNS(SVG, "circle");
    circle.setAttribute("cx", "73"); circle.setAttribute("cy", "73"); circle.setAttribute("r", "70.75");
    circle.setAttribute("fill", "none");
    if (state === "away") circle.setAttribute("stroke-dasharray", "0.1 13.5");
    else if (state !== "ready" && state !== "watching") circle.setAttribute("stroke-dasharray", "13.5 9.9");
    ring.appendChild(circle);
    const avatar = el("span", "watch-party-seat-avatar");
    avatar.append(disc, ring);
    if (state === "ready" || state === "watching") {
        const tick = el("span", "watch-party-seat-tick");
        tick.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 10 17.5 19 7"/></svg>';
        avatar.appendChild(tick);
    }
    const detail = [member.isHost ? "Host" : undefined, member.isSelf ? "You" : undefined, STATUS_TEXT[state]].filter((part): part is string => part !== undefined).join(" · ");
    node.append(avatar, el("span", "watch-party-seat-name", member.displayName), ...(detail === "" ? [] : [el("span", "watch-party-seat-detail", detail)]));
    node.setAttribute("aria-label", [member.displayName, member.isSelf ? "you" : "", member.isHost ? "host" : "", STATUS_TEXT[state] ?? "ready"].filter(part => part !== "").join(", "));
    return node;
}

function lobbyView(hub: WatchPartyHub, room: Room): View {
    const code = actionButton("lobby-code", "", () => undefined);
    code.element.classList.add("watch-party-code-pill");
    code.element.setAttribute("aria-label", `Party code ${[...room.code].join(" ")}. Invite friends`);
    code.element.append(el("span", "watch-party-code-label", "Join with"), el("span", "watch-party-code", room.code));

    const members = ordered(room.members);
    const here = el("div", "watch-party-here");
    const heading = el("div", "watch-party-here-heading");
    heading.append(eyebrow("Here now"), el("span", "watch-party-presence", presenceSummary(room.members, room.phase)));
    const seats = el("div", "watch-party-seats");
    seats.append(...members.map(member => seat(member, room.phase)));
    here.append(heading, seats);
    here.setAttribute("role", "group");
    here.setAttribute("aria-label", "Members");

    const page = el("div", "watch-party watch-party-lobby");
    const column = el("div", "watch-party-lobby-column");
    column.append(eyebrow("Watch Party"), code.element, here);
    page.append(column);
    return {
        name: "watchParty:lobby",
        content: [page],
        zones: [{ id: "lobby", layout: "column", items: [code] }],
        focus: { zone: "lobby", key: "lobby-code" },
        back: () => hub.leave(),
    };
}
