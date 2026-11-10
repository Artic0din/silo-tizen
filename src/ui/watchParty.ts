// Apple's WatchPartyHubView on tvOS: the create-or-join entry and, once a room is open, the lobby and the
// pages it opens (watchPartyLobby.ts, watchPartyPicker.ts). Metrics are Apple's tvOS values at 1920x1080.

import type { FocusItem, View } from "./browseFocus.ts";
import { actionButton } from "./browseViews.ts";
import { el } from "./screen.ts";
import { banner, enabled, eyebrow, pill, plusIcon } from "./watchPartyParts.ts";
import { endView, inviteView, lobbyView, optionsView } from "./watchPartyLobby.ts";
import { choiceView, episodesView, pickerView } from "./watchPartyPicker.ts";
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

/** The IME Done key on the Tizen keyboard. */
const IME_DONE = 65376;

export function watchPartyView(screen: WatchPartyScreen, back: () => void, baseUrl: string): View {
    const { hub } = screen;
    const room = hub.state.room;
    if (room === undefined) return entryView(screen, back);
    const context = { hub, baseUrl };
    const page = hub.state.page;
    switch (page.kind) {
        case "options": return optionsView(context, room);
        case "end": return endView(context, room);
        case "invite": return inviteView(context, room);
        case "picker": return pickerView(context);
        case "choice": return choiceView(context, page.choice);
        case "episodes": return episodesView(context, page.series, page.season);
        case "lobby": return lobbyView(context, room);
    }
}

function entryView({ hub, input }: WatchPartyScreen, back: () => void): View {
    const { supported, checking, busy, error } = hub.state;
    const unusable = !supported;
    // Apple disables Start a party, vote and Join party while a request runs, and while the server cannot host a party.
    const locked = unusable || busy;
    const message = error ?? (unusable ? (checking ? "Checking Watch Party support…" : "Watch Party is not available for this profile on this server.") : undefined);
    const intro = el("div", "watch-party-intro");
    const headline = el("div", "watch-party-headline");
    headline.append(eyebrow("Watch Party"), el("h1", "watch-party-title", "Watch something\ntogether"), el("p", "watch-party-body", "Pick a title, share the code, and everyone's playback stays in step."));
    intro.append(headline);
    if (message !== undefined) intro.append(banner(message, error !== undefined));

    const create = pill(actionButton("create", "Start a party", () => { if (!locked) void hub.create("host_pick"); }), "primary", locked);
    create.element.prepend(plusIcon());
    const vote = pill(actionButton("vote", "Start a party and let everyone vote", () => { if (!locked) void hub.create("vote"); }), "secondary", locked);
    const joinable = (): boolean => !locked && input.value.trim() !== "";
    const join = pill(actionButton("join", "Join party", () => { if (joinable()) void hub.join(input.value); }), "secondary", !joinable());
    const retry = unusable ? pill(actionButton("retry", "Check again", () => { if (!checking) void hub.check(); }), "secondary", checking) : undefined;

    const host = el("div", "watch-party-section");
    host.append(eyebrow("Host"), create.element, vote.element);
    const joinSection = el("div", "watch-party-section");
    joinSection.append(eyebrow("Join"), input, join.element, ...(retry === undefined ? [] : [retry.element]));
    // A disabled button takes no focus, as on tvOS. Typing must not rebuild the page, which would drop the field's focus,
    // so the one control that depends on the text enters and leaves this list as it changes.
    const items: FocusItem[] = [];
    const listItems = (): void => {
        join.element.setAttribute("aria-disabled", String(!joinable()));
        items.splice(0, items.length, ...[create, vote, { key: "code", element: input }, join, ...(retry === undefined ? [] : [retry])].filter(enabled));
    };
    listItems();
    input.oninput = listItems;
    input.onkeydown = event => {
        if (event.keyCode !== IME_DONE || !joinable()) return;
        event.preventDefault();
        event.stopPropagation();
        join.element.focus();
    };
    const actions = el("div", "watch-party-actions");
    actions.append(host, joinSection);
    const page = el("div", "watch-party watch-party-ui");
    page.append(intro, actions);

    return {
        name: "watchParty:hub",
        content: [page],
        zones: [{ id: "party", layout: "column", items }],
        focus: { zone: "party", key: [create, retry].find(item => item !== undefined && enabled(item))?.key ?? "code" },
        back,
    };
}
