// Apple's WatchPartyLobbyView on tvOS, and the sheets it opens: Party options, the End confirmation and the
// invitation. Over HTTP only: the lobby is the room as the last answer left it, so presence does not update by
// itself, a guest cannot mark Ready and there is no ballot; those need the room socket.
// Metrics are Apple's tvOS values at 1920x1080 (WatchPartyMetrics).

import type { Room } from "../contracts/v2/watchTogether.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { actionButton } from "./browseViews.ts";
import { qrCode } from "./qr.ts";
import { el } from "./screen.ts";
import { backdrop, banner, circleButton, codeText, ellipsisIcon, eyebrow, labelled, playIcon } from "./watchPartyParts.ts";
import { inviteUrl } from "./watchPartyInvite.ts";
import { type PrimaryAction, primaryAction, waitingNames } from "./watchPartyPolicy.ts";
import { seatsRow } from "./watchPartySeats.ts";
import type { WatchPartyHub } from "./watchPartyHub.ts";
import type { LobbyItem } from "./watchPartyChoice.ts";

export interface LobbyContext { readonly hub: WatchPartyHub; readonly baseUrl: string }

const hostName = (room: Room): string => room.members.find(member => member.isHost)?.displayName ?? "The host";

/** Apple's connection dot, read from the room: with no socket the lobby is as live as its last answer. */
function connection(room: Room): { text: string; tone: "ok" | "warn" } {
    const here = room.members.filter(member => member.connected).length;
    if (!room.hostConnected && room.selfRole !== "host") return { text: "Host away", tone: "warn" };
    return { text: here <= 1 ? "Open" : `${here} here`, tone: "ok" };
}

function statusBanner(hub: WatchPartyHub, room: Room): HTMLElement | undefined {
    const { error, selectedUnavailable } = hub.state;
    if (error !== undefined) return banner(error, true);
    if (selectedUnavailable) {
        return banner(room.selfCanManageRoom
            ? "This title isn't available to your profile. Choose something else so everyone can watch."
            : `This title isn't available to your profile. ${hostName(room)} will need to pick something else.`, true);
    }
    if (room.selectionMode === "vote" && room.phase === "lobby") {
        return banner(room.selfCanManageRoom ? "Voting isn't available on this TV yet. Set Who chooses to Host chooses in Party options to pick a title." : "Voting isn't available on this TV yet.", false);
    }
    if (!room.hostConnected && room.selfRole !== "host") return banner(`${hostName(room)} lost connection. The party holds for two minutes while they come back.`, true);
    return undefined;
}

/** Eyebrow, title and facts, as WatchPartyLobbyView.heroText. */
function heroText(room: Room, item: LobbyItem | undefined, hub: WatchPartyHub): HTMLElement {
    const hero = el("div", "watch-party-hero");
    const manage = room.selfCanManageRoom;
    const caption = (text: string): HTMLElement => el("p", "watch-party-caption", text);
    if (room.selectionMode === "vote" && room.phase === "lobby") {
        hero.append(eyebrow("Voting"), el("h1", "watch-party-hero-title", "What are we watching?"),
            el("p", "watch-party-lead", manage ? "Everyone votes. You start the leader." : `Tap a title to vote. ${hostName(room)} starts the winner.`));
    } else if (item !== undefined) {
        const facts = el("p", "watch-party-facts");
        const parts = [item.subtitle, ...item.facts].filter((part): part is string => part !== undefined && part !== "");
        facts.append(...parts.flatMap((part, index) => index === 0 ? [part] : [el("span", "watch-party-facts-dot", "·"), part]));
        facts.append(...item.chips.map(chip => el("span", "watch-party-chip", chip)));
        hero.append(eyebrow(room.phase === "playing" ? "Now watching · together" : "Up next · together"), el("h1", "watch-party-hero-title", item.title), facts,
            caption(room.selfRole === "host" ? "You chose this" : `${hostName(room)} chose this`));
    } else if (room.selectedContentId !== undefined) {
        hero.append(eyebrow(room.phase === "playing" ? "Now watching · together" : "Up next · together"),
            el("h1", "watch-party-hero-title watch-party-hero-dim", hub.state.selectedUnavailable ? "A title you can't see" : "Loading title…"),
            caption(room.selfRole === "host" ? "You chose this" : `${hostName(room)} chose this`));
    } else {
        hero.append(eyebrow("Your party is open"), el("h1", "watch-party-hero-title", manage ? "Pick something\nto watch" : `Waiting for\n${hostName(room)}`),
            el("p", "watch-party-lead", manage
                ? "Friends can join now with the code. They'll see your pick the moment you choose."
                : `${hostName(room)} is choosing what to watch. You'll see it here the moment they do.`));
    }
    return hero;
}

/** WatchPartyLobbyView.hint: advisory text under the buttons. */
function hint(room: Room): string | undefined {
    if (room.phase !== "lobby" || room.selectionMode === "vote") return undefined;
    if (room.selfCanManageRoom) {
        if (room.selectedContentId === undefined) return undefined;
        const waiting = waitingNames(room.members);
        if (waiting.length === 0) return room.members.filter(member => member.connected).length > 1 ? "Everyone's ready." : undefined;
        return `${waiting.slice(0, 2).join(" and ")}${waiting.length > 2 ? " and others" : ""} ${waiting.length === 1 ? "hasn't" : "haven't"} marked ready. You can still start.`;
    }
    return room.selectedContentId === undefined ? undefined : `${hostName(room)} starts the movie when everyone's set.`;
}

function primaryButton(hub: WatchPartyHub, room: Room, action: PrimaryAction): FocusItem | undefined {
    switch (action) {
        case "chooseTitle": return labelled("choose", room.selectedContentId === undefined ? "Choose a title" : "Change title", "primary", () => { void hub.openPicker(); });
        case "start": return labelled("start", "Start for everyone", "primary", () => { void hub.start(); }, playIcon());
        case "returnToPlayback": return labelled("resume", "Return to playback", "primary", () => { hub.resume(); }, playIcon());
        case "returnToLobby": return labelled("return-lobby", "Return everyone to lobby", "primary", () => { void hub.stopPlayback(); });
        case "none": return undefined;
    }
}

function secondaryButton(hub: WatchPartyHub, room: Room, action: PrimaryAction): FocusItem | undefined {
    if (room.selectionMode !== "host_pick" || !room.selfCanManageRoom) return undefined;
    if (room.phase === "lobby" && room.selectedContentId !== undefined && action === "start") return labelled("change", "Change title", "secondary", () => { void hub.openPicker(); });
    if (room.phase === "playing") return labelled("change", "Choose something else", "secondary", () => { void hub.openPicker(); });
    return undefined;
}

/** The lobby behind every room page. `interactive` is false behind an overlay, which owns focus. */
function lobbyPage(context: LobbyContext, room: Room, interactive: boolean): { node: HTMLElement; items: { top: FocusItem[]; seats: FocusItem[]; actions: FocusItem[] }; defaultKey: string } {
    const { hub } = context;
    const item = hub.state.selected;
    const action = primaryAction(room, hub.state.capabilities, hub.canStart(), hub.state.selectedUnavailable);
    const page = el("div", "watch-party-room watch-party-ui");
    const state = connection(room);
    const status = el("span", `watch-party-connection watch-party-connection-${state.tone}`);
    status.append(el("span", "watch-party-connection-dot"), state.text);
    const title = el("div", "watch-party-room-title");
    title.append(el("span", "watch-party-room-name", "Watch Party"), status);

    const code = actionButton("lobby-code", "", () => { hub.show({ kind: "invite" }); });
    code.element.classList.add("watch-party-button", "watch-party-secondary", "watch-party-code-pill");
    code.element.setAttribute("aria-label", `Party code ${[...room.code].join(" ")}. Invite friends`);
    code.element.append(el("span", "watch-party-code-label", "Join with"), codeText(room.code));
    const more = circleButton("options", "Options", ellipsisIcon(), () => { hub.show({ kind: "options" }); });
    more.element.setAttribute("aria-label", "Party options");
    const header = el("div", "watch-party-room-header");
    const tools = el("div", "watch-party-room-tools");
    tools.append(code.element, more.element);
    header.append(title, tools);

    const body = el("div", "watch-party-room-body");
    const copy = el("div", "watch-party-room-copy");
    copy.appendChild(heroText(room, item, hub));
    const overview = item?.overview;
    if (overview !== undefined && overview !== "") copy.appendChild(el("p", "watch-party-overview", overview));
    const notice = statusBanner(hub, room);
    if (notice !== undefined) copy.appendChild(notice);
    body.appendChild(copy);

    const seats = seatsRow(room.members, room.phase, () => { hub.show({ kind: "invite" }); });
    const primary = primaryButton(hub, room, action);
    const secondary = secondaryButton(hub, room, action);
    const actions = el("div", "watch-party-room-actions");
    const buttons = el("div", "watch-party-room-buttons");
    for (const button of [secondary, primary]) if (button !== undefined) buttons.appendChild(button.element);
    const text = hint(room);
    actions.append(buttons, ...(text === undefined ? [] : [el("p", "watch-party-hint", text)]));
    const footer = el("div", "watch-party-room-footer");
    footer.append(seats.node, actions);

    page.append(header, body, footer);
    if (!interactive) page.inert = true;
    return {
        node: page,
        items: { top: [code, more], seats: [seats.invite], actions: [secondary, primary].filter((button): button is FocusItem => button !== undefined) },
        defaultKey: primary?.key ?? "lobby-code",
    };
}

function roomBackdrop(context: LobbyContext): HTMLElement {
    const item = context.hub.state.selected;
    const reference = item?.backdropUrl ?? item?.posterUrl;
    return backdrop(reference, context.baseUrl, item?.backdropUrl === undefined);
}

export function lobbyView(context: LobbyContext, room: Room): View {
    const page = lobbyPage(context, room, true);
    const zones: Zone[] = [
        { id: "lobby-top", layout: "row", items: page.items.top },
        { id: "lobby-seats", layout: "row", items: page.items.seats },
        ...(page.items.actions.length === 0 ? [] : [{ id: "lobby-actions", layout: "row" as const, items: page.items.actions }]),
    ];
    return { name: "watchParty:lobby", content: [roomBackdrop(context), page.node], zones, focus: { zone: page.items.actions.length === 0 ? "lobby-top" : "lobby-actions", key: page.defaultKey }, back: () => context.hub.back() };
}

// --- Party options ---

function optionRow(key: string, title: string, value: string | undefined, destructive: boolean, onPress: () => void): FocusItem {
    const row = actionButton(key, "", onPress);
    row.element.classList.add("watch-party-option");
    if (destructive) row.element.classList.add("watch-party-option-destructive");
    row.element.append(el("span", "watch-party-option-title", title), ...(value === undefined ? [] : [el("span", "watch-party-option-value", value)]));
    return row;
}

/** WatchPartyHostControlsOverlay: the only focus owner while it is up; Back closes it. */
export function optionsView(context: LobbyContext, room: Room): View {
    const { hub } = context;
    const capabilities = hub.state.capabilities;
    const rows: FocusItem[] = [];
    if (room.selfCanManageRoom) {
        if (room.phase === "lobby" && capabilities?.selectionModeSwitch === true) {
            rows.push(optionRow("mode", "Who chooses", room.selectionMode === "vote" ? "Everyone votes" : "Host chooses", false, () => { void hub.setMode(room.selectionMode === "vote" ? "host_pick" : "vote"); }));
        }
        rows.push(optionRow("policy", "Playback controls", room.guestControlPolicy === "guest_play_pause" ? "Guests can play and pause" : "Host only", false,
            () => { void hub.setPolicy(room.guestControlPolicy === "guest_play_pause" ? "host_only" : "guest_play_pause"); }));
        if (room.phase === "playing" && capabilities?.stopPlayback === true) {
            rows.push(optionRow("stop", "Return everyone to lobby", undefined, false, () => { void hub.stopPlayback(); hub.show({ kind: "lobby" }); }));
        }
        rows.push(optionRow("end", "End party for everyone", undefined, true, () => { hub.show({ kind: "end" }); }));
    }
    // With no room socket the host cannot step out and leave the room running, so Leave ends it: ask first, as End party does.
    rows.push(optionRow("leave", "Leave party", undefined, true, () => { if (room.selfCanManageRoom) hub.show({ kind: "end" }); else hub.leave(); }));
    const close = optionRow("close", "Close", undefined, false, () => { hub.show({ kind: "lobby" }); });
    rows.push(close);
    const card = el("div", "watch-party-sheet watch-party-options");
    card.append(el("h2", "watch-party-sheet-title", "Party options"), ...rows.map(row => row.element));
    const scrim = el("div", "watch-party-scrim watch-party-ui");
    scrim.appendChild(card);
    const behind = lobbyPage(context, room, false);
    return {
        name: "watchParty:options",
        content: [roomBackdrop(context), behind.node, scrim],
        zones: [{ id: "options", layout: "column", items: rows }],
        focus: { zone: "options", key: "close" },
        back: () => context.hub.show({ kind: "lobby" }),
    };
}

/** WatchPartyEndConfirmation. */
export function endView(context: LobbyContext, room: Room): View {
    const { hub } = context;
    const cancel = labelled("cancel", "Cancel", "secondary", () => { hub.show({ kind: "lobby" }); });
    const confirm = labelled("confirm-end", "End Party", "secondary", () => { hub.show({ kind: "lobby" }); void hub.endParty(); });
    const card = el("div", "watch-party-sheet watch-party-end");
    const row = el("div", "watch-party-end-actions");
    row.append(cancel.element, confirm.element);
    card.append(el("h2", "watch-party-sheet-title", "End this party for everyone?"), row);
    const scrim = el("div", "watch-party-scrim watch-party-ui");
    scrim.appendChild(card);
    const behind = lobbyPage(context, room, false);
    return {
        name: "watchParty:end",
        content: [roomBackdrop(context), behind.node, scrim],
        zones: [{ id: "end", layout: "row", items: [cancel, confirm] }],
        focus: { zone: "end", key: "cancel" },
        back: () => context.hub.show({ kind: "lobby" }),
    };
}

// --- Invitation ---

/** WatchPartyInviteView on tvOS: the code, a QR for phones when the room has an invitation link, and Done. */
export function inviteView(context: LobbyContext, room: Room): View {
    const { hub, baseUrl } = context;
    const link = room.invitePath === undefined ? undefined : inviteUrl(room.invitePath, baseUrl);
    const done = labelled("done", "Done", "secondary", () => { hub.show({ kind: "lobby" }); });
    const text = el("div", "watch-party-invite-copy");
    text.append(eyebrow("Invite friends"), el("h1", "watch-party-invite-title", "Join with this code"),
        el("p", "watch-party-lead", "Anyone with a profile on this Silo server can enter it from Watch Party."));
    const code = el("p", "watch-party-invite-code", room.code);
    code.setAttribute("aria-label", `Party code ${[...room.code].join(", ")}`);
    text.appendChild(code);
    if (link !== undefined) text.appendChild(el("p", "watch-party-caption", "Or scan to open the invitation on a phone."));
    text.appendChild(done.element);
    const layout = el("div", "watch-party-invite watch-party-ui");
    layout.appendChild(text);
    const qr = link === undefined ? undefined : qrCode(link, "Scan to join this party");
    if (qr !== undefined) {
        const card = el("div", "watch-party-qr");
        card.appendChild(qr);
        layout.appendChild(card);
    }
    return {
        name: "watchParty:invite",
        content: [roomBackdrop(context), layout],
        zones: [{ id: "invite", layout: "row", items: [done] }],
        focus: { zone: "invite", key: "done" },
        back: () => hub.show({ kind: "lobby" }),
    };
}
