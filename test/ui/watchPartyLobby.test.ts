import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeWatchParty, ROOM_FILE_ID, ROOM_ID } from "../native/support/fakeWatchParty.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { jumpUntil, launchBrowser, openTv, pauseTvClock, type Tv } from "./support/tv.ts";
import { button, menuTitles, openHub, start } from "./support/watchParty.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const view = (tv: Tv, name: string) => tv.page.locator(`.browse[data-view="${name}"]`);
const texts = (tv: Tv, selector: string) => tv.page.locator(selector).allTextContents();

/** Opens the hub and creates a host-pick room, or joins as a guest, then waits for the lobby. */
async function enterLobby(tv: Tv, fake: FakeWatchParty, how: "create" | "vote" | "join" = "create"): Promise<void> {
    await tv.eventually(async () => (await menuTitles(tv)).includes("Watch Party"), "entry offered");
    await openHub(tv);
    if (how === "join") {
        await tv.page.locator('[data-focus="code"]').fill("K7M2QX");
        await button(tv, "join").click();
    } else await button(tv, how).click();
    await view(tv, "watchParty:lobby").waitFor();
    await connected(tv, fake);
}

/** The room socket is open and the lobby says so: the dot leaves Connecting. */
async function connected(tv: Tv, fake: FakeWatchParty, sockets = 1): Promise<void> {
    await tv.eventually(async () => fake.sockets.length === sockets && !fake.sockets[sockets - 1]?.closed, "room socket open");
    await tv.eventually(async () => !["Connecting", "Reconnecting"].includes(await tv.page.locator(".watch-party-connection").textContent() ?? ""), "lobby connected");
}

async function inLobby(role: "host" | "guest" = "host", configure: (fake: FakeWatchParty) => void = () => undefined): Promise<{ tv: Tv; fake: FakeWatchParty }> {
    const tv = await openTv(browser, { app: "browse" });
    const fake = new FakeWatchParty();
    fake.role = role;
    configure(fake);
    await start(tv, fake);
    await enterLobby(tv, fake, role === "guest" ? "join" : fake.selectionMode === "vote" ? "vote" : "create");
    return { tv, fake };
}

/** Walks Choose a title > a movie > Choose for the party, ending back in the lobby with the title staged. */
async function stageMovie(tv: Tv, id = "movie:m0004"): Promise<void> {
    await button(tv, "choose").click();
    await view(tv, "watchParty:picker:shelves").waitFor();
    await button(tv, id).click();
    await view(tv, "watchParty:choice").waitFor();
    await button(tv, "confirm").click();
    await view(tv, "watchParty:lobby").waitFor();
}

test("the host's empty lobby is Apple's layout: header, code pill, Options, prompt, seats and Choose a title", async () => {
    const { tv } = await inLobby();
    try {
        assert.equal(await tv.page.locator(".browse-nav").isVisible(), false, "the room is a full-screen page with no top bar");
        assert.equal(await tv.page.locator(".watch-party-room-name").textContent(), "Watch Party");
        assert.equal(await tv.page.locator(".watch-party-connection").textContent(), "2 here");
        assert.equal(await tv.page.locator(".watch-party-code").textContent(), "K7M2QX");
        assert.equal(await tv.page.locator(".watch-party-code-label").textContent(), "Join with");
        assert.equal(await button(tv, "options").getAttribute("aria-label"), "Party options");
        assert.equal(await tv.page.locator(".watch-party-eyebrow").first().textContent(), "Your party is open");
        assert.equal(await tv.page.locator(".watch-party-hero-title").textContent(), "Pick something\nto watch");
        assert.equal(await tv.page.locator(".watch-party-lead").textContent(), "Friends can join now with the code. They'll see your pick the moment you choose.");
        assert.deepEqual(await texts(tv, ".watch-party-seat:not(.watch-party-seat-invite) .watch-party-seat-name"), ["Owner", "Sam"]);
        assert.deepEqual(await texts(tv, ".watch-party-seat-detail"), ["Host · You", "not ready"]);
        assert.equal(await tv.page.locator(".watch-party-presence").textContent(), "1 of 2 ready");
        assert.equal(await button(tv, "invite").getAttribute("aria-label"), "Invite friends");
        assert.equal(await button(tv, "choose").textContent(), "Choose a title");
        assert.equal(await tv.focused(), "choose", "focus opens on the primary action");
        assert.equal(await tv.page.locator(".watch-party-hint").count(), 0);
        // The 1920x1080 metrics: 76 px pills, 128 px seats, 88 px side inset.
        const box = async (selector: string) => await tv.page.locator(selector).first().boundingBox();
        assert.equal((await box('[data-focus="choose"]'))?.height, 76);
        assert.equal((await box(".watch-party-seat-disc"))?.width, 128, "seat disc diameter");
        assert.equal((await box(".watch-party-room-name"))?.x, 88);
    } finally { await tv.page.context().close(); }
});

test("the lobby's remote order: Options, the code and the seats above, the action under, Up and Down between them", async () => {
    const { tv } = await inLobby();
    try {
        assert.equal(await tv.focused(), "choose");
        await tv.remote(38);
        assert.equal(await tv.focused(), "invite", "Up from the action reaches the seats row");
        await tv.remote(38);
        assert.ok(["lobby-code", "options"].includes(await tv.focused() ?? ""), "Up again reaches the header");
        await tv.remote(39);
        assert.equal(await tv.focused(), "options");
        await tv.remote(37);
        assert.equal(await tv.focused(), "lobby-code");
        await tv.remote(40); await tv.remote(40);
        assert.equal(await tv.focused(), "choose");
    } finally { await tv.page.context().close(); }
});

test("Choose a title opens the picker with the group's shelves, read once with the room token", async () => {
    const { tv, fake } = await inLobby();
    try {
        await button(tv, "choose").click();
        await view(tv, "watchParty:picker:shelves").waitFor();
        await tv.page.locator(".watch-party-shelf").first().waitFor();
        assert.deepEqual(await texts(tv, ".watch-party-shelf .browse-section-title"), ["Continue Together", "On Your Watchlists"]);
        assert.equal(await texts(tv, ".watch-party-shelf .browse-card").then(cards => cards.length), 4);
        assert.deepEqual(fake.pickerTokens, ["room-proof-one"]);
        assert.equal(await tv.focused(), "movie:m0004", "focus opens on the first title");
        await tv.remote(10009);
        await view(tv, "watchParty:lobby").waitFor();
        assert.equal(await tv.focused(), "choose", "Back returns to the lobby's action");
    } finally { await tv.page.context().close(); }
});

// WatchPartyMediaPicker's shelves are a TVSkylineSectionFeed (Screens/WatchParty/WatchPartyMediaPicker.swift:372), whose MediaRow captions with CardYears.
test("the picker's shelves caption a series with the years it ran", async () => {
    const { tv } = await inLobby("host", fake => {
        for (const [id, fields] of [["series:s1", { showStatus: "returning" }], ["series:s2", { showStatus: "ended", lastAirDate: "2024-03-17" }]] as const) {
            const title = fake.titles.get(id);
            assert.ok(title);
            fake.add({ ...title, ...fields });
        }
    });
    try {
        await button(tv, "choose").click();
        await view(tv, "watchParty:picker:shelves").waitFor();
        await tv.page.locator('.watch-party-shelf [data-focus="series:s2"]').waitFor();
        const line = (id: string) => tv.page.locator(`.watch-party-shelf [data-focus="${id}"] .browse-card-subtitle`).textContent();
        assert.equal(await line("series:s1"), "2020 – Present");
        assert.equal(await line("series:s2"), "2021 – 2024");
    } finally { await tv.page.context().close(); }
});

test("choosing a movie confirms it, stages it with the staged-selection call and shows it in the lobby with Start for everyone", async () => {
    const { tv, fake } = await inLobby();
    try {
        await button(tv, "choose").click();
        await view(tv, "watchParty:picker:shelves").waitFor();
        await button(tv, "movie:m0004").click();
        await view(tv, "watchParty:choice").waitFor();
        assert.equal(await tv.page.locator(".watch-party-choice-title").textContent(), "Movie 0004");
        assert.equal(await tv.page.locator(".watch-party-eyebrow").first().textContent(), "Watch together");
        assert.equal(await button(tv, "confirm").textContent(), "Choose for the party");
        assert.equal(await tv.focused(), "confirm");
        await button(tv, "confirm").click();
        await view(tv, "watchParty:lobby").waitFor();
        assert.deepEqual(fake.roomChanges.map(change => [change.call, change.body, change.roomToken]), [["PUT /staged-selection", { content_id: "movie:m0004" }, undefined]]);
        await tv.eventually(async () => (await tv.page.locator(".watch-party-hero-title").textContent()) === "Movie 0004", "title shows");
        assert.equal(await tv.page.locator(".watch-party-eyebrow").first().textContent(), "Up next · together");
        assert.equal(await tv.page.locator(".watch-party-caption").first().textContent(), "You chose this");
        assert.equal(await button(tv, "start").textContent(), "Start for everyone");
        assert.equal(await button(tv, "change").textContent(), "Change title", "the secondary button changes the pick");
        assert.equal(await tv.focused(), "start");
        assert.equal(await tv.page.locator(".watch-party-hint").textContent(), "Sam hasn't marked ready. You can still start.");
        // Apple's siloSecondaryText (#EDEDED at 60%) at a further 70%.
        assert.deepEqual(await tv.page.locator(".watch-party-caption, .watch-party-hint").evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color)), ["rgba(237, 237, 237, 0.42)", "rgba(237, 237, 237, 0.42)"]);
    } finally { await tv.page.context().close(); }
});

test("Start for everyone starts the party and opens the player on the room's file", async () => {
    const { tv, fake } = await inLobby();
    try {
        await stageMovie(tv);
        await button(tv, "start").click();
        await tv.eventually(async () => (await tv.page.evaluate(() => window.browseHarness.plays.length)) === 1, "player opened");
        const play = await tv.page.evaluate(() => window.browseHarness.plays[0]);
        assert.deepEqual([play?.contentId, play?.fileId, play?.startSeconds], ["movie:m0004", ROOM_FILE_ID, 0]);
        assert.deepEqual(fake.roomChanges.map(change => change.call), ["PUT /staged-selection", "POST /playback/start"]);
    } finally { await tv.page.context().close(); }
});

test("a refused start stays in the lobby with the server's reason in the warning banner", async () => {
    const { tv, fake } = await inLobby();
    try {
        await stageMovie(tv);
        fake.roomChangeFailure = problem(409, "not_ready", "Everyone needs the title first.");
        await button(tv, "start").click();
        await tv.page.locator(".watch-party-banner").waitFor();
        assert.equal(await tv.page.locator(".watch-party-banner").textContent(), "Everyone needs the title first.");
        assert.equal(await tv.page.locator(".watch-party-banner").getAttribute("role"), "alert");
        assert.equal(await tv.page.evaluate(() => window.browseHarness.plays.length), 0);
        assert.equal(await tv.focused(), "start", "focus stays on the button that was pressed");
    } finally { await tv.page.context().close(); }
});

test("a series the group is part-way through goes straight to its next episode, laid out with the episode's title and the series underneath", async () => {
    const { tv, fake } = await inLobby();
    try {
        await button(tv, "choose").click();
        await view(tv, "watchParty:picker:shelves").waitFor();
        await button(tv, "series:s1").click();
        await view(tv, "watchParty:choice").waitFor();
        assert.equal(await tv.page.locator(".watch-party-choice-title").textContent(), "Harbor Lights");
        assert.equal(await tv.page.locator(".watch-party-choice-facts").textContent(), "S1 · E2 · Harbor Lights chapter 1.2");
        await button(tv, "confirm").click();
        await view(tv, "watchParty:lobby").waitFor();
        assert.deepEqual(fake.roomChanges.map(change => change.body), [{ content_id: "episode:s1e12" }]);
        await tv.eventually(async () => (await tv.page.locator(".watch-party-hero-title").textContent()) !== "Pick something\nto watch", "hero updates");
        assert.match(await tv.page.locator(".watch-party-facts").textContent() ?? "", /Harbor Lights · S1:E2/);
    } finally { await tv.page.context().close(); }
});

test("a series with no next-up opens its seasons and episodes, and an episode is chosen from the rail", async () => {
    const { tv, fake } = await inLobby();
    try {
        await button(tv, "choose").click();
        await view(tv, "watchParty:picker:shelves").waitFor();
        await button(tv, "series:s2").click();
        await view(tv, "watchParty:episodes").waitFor();
        await tv.page.locator(".watch-party-season-tab").first().waitFor();
        assert.equal(await tv.page.locator(".watch-party-episodes-title").textContent(), "Night Shift");
        assert.equal(await tv.page.locator(".watch-party-eyebrow").first().textContent(), "Watch Party · Choose an episode");
        assert.deepEqual(await texts(tv, ".watch-party-season-tab"), ["Season 1", "Season 2"].map(label => label), "season tabs");
        assert.equal(await tv.page.locator('.watch-party-season-tab[aria-pressed="true"]').textContent(), "Season 1");
        await tv.page.locator(".watch-party-episode").first().waitFor();
        const rail = await tv.page.locator(".watch-party-episode").evaluateAll(nodes => nodes.slice(0, 2).map(node => { const box = node.getBoundingClientRect(); return [Math.round(box.x), Math.round(box.y)]; }));
        assert.equal(rail[0]?.[1], rail[1]?.[1], "episodes sit side by side");
        assert.ok((rail[1]?.[0] ?? 0) > (rail[0]?.[0] ?? 0));
        assert.equal(await tv.page.locator(".watch-party-season-tabs").evaluate(node => [node.classList.contains("browse-row"), getComputedStyle(node).overflowX]).then(value => value.join()), "true,hidden", "season tabs use the shared horizontal row, so focus reveals them");
        await button(tv, "season:2").click();
        await tv.eventually(async () => (await texts(tv, ".watch-party-episode-number"))[0] === "E1" && (await tv.page.locator('.watch-party-season-tab[aria-pressed="true"]').textContent()) === "Season 2", "season 2 episodes");
        await tv.page.locator(".watch-party-episode").first().click();
        await view(tv, "watchParty:choice").waitFor();
        assert.match(await tv.page.locator(".watch-party-choice-facts").textContent() ?? "", /^S2 · E1 · /);
        await tv.remote(10009);
        await view(tv, "watchParty:episodes").waitFor();
        await tv.remote(10009);
        await view(tv, "watchParty:picker:shelves").waitFor();
        await tv.remote(10009);
        await view(tv, "watchParty:lobby").waitFor();
        assert.deepEqual(fake.roomChanges, [], "browsing stages nothing");
    } finally { await tv.page.context().close(); }
});

test("a failed picker read shows the reason with Try Again, and an empty picker says what to do", async () => {
    const { tv, fake } = await inLobby("host", fake => { fake.pickerFailure = problem(503, "unavailable", "Down for maintenance."); });
    try {
        await button(tv, "choose").click();
        await view(tv, "watchParty:picker:empty").waitFor();
        await tv.page.locator(".watch-party-banner").waitFor();
        assert.equal(await tv.page.locator(".watch-party-banner").textContent(), "Down for maintenance.");
        assert.equal(await tv.focused(), "picker-close", "focus stays on the strip, where it opened");
        await tv.remote(40);
        assert.equal(await tv.focused(), "picker-retry", "Down reaches Try Again");
        fake.pickerFailure = undefined;
        await button(tv, "picker-retry").click();
        await tv.page.locator(".watch-party-shelf").first().waitFor();
        assert.equal(await tv.page.locator(".watch-party-banner").count(), 0);
    } finally { await tv.page.context().close(); }
});

test("Party options lists Apple's rows with their values, opens on Close and closes with Back", async () => {
    const { tv, fake } = await inLobby();
    try {
        await button(tv, "options").click();
        await view(tv, "watchParty:options").waitFor();
        assert.equal(await tv.page.locator(".watch-party-sheet-title").textContent(), "Party options");
        assert.deepEqual(await texts(tv, ".watch-party-option"), ["Who chooses" + "Host chooses", "Playback controls" + "Host only", "End party for everyone", "Leave party", "Close"]);
        assert.equal(await tv.focused(), "close");
        await tv.remote(10009);
        await view(tv, "watchParty:lobby").waitFor();
        assert.equal(await tv.focused(), "options", "closing returns focus to the Options button");
        assert.deepEqual(fake.closedRooms, []);
    } finally { await tv.page.context().close(); }
});

test("Who chooses and Playback controls change the room and show the value the room answered with", async () => {
    const { tv, fake } = await inLobby();
    try {
        await button(tv, "options").click();
        await button(tv, "policy").click();
        await tv.eventually(async () => (await button(tv, "policy").textContent()) === "Playback controlsGuests can play and pause", "policy value");
        await button(tv, "mode").click();
        await tv.eventually(async () => (await button(tv, "mode").textContent()) === "Who choosesEveryone votes", "mode value");
        assert.deepEqual(fake.roomChanges.map(change => [change.call, change.body]), [["PATCH /policy", { guest_control_policy: "guest_play_pause" }], ["PATCH /selection-mode", { selection_mode: "vote" }]]);
        assert.equal(await tv.focused(), "mode", "focus stays on the row that was changed");
        await tv.remote(10009);
        await view(tv, "watchParty:lobby").waitFor();
        assert.equal(await tv.page.locator(".watch-party-eyebrow").first().textContent(), "Voting · 0 titles");
        assert.equal(await tv.page.locator(".watch-party-hero-title").textContent(), "What are we watching?");
        assert.equal(await tv.page.locator(".watch-party-banner").count(), 0, "the switched room votes on this TV");
    } finally { await tv.page.context().close(); }
});

test("a server without the mode switch hides Who chooses", async () => {
    const { tv } = await inLobby("host", fake => { fake.flags = { staged_selection: true }; });
    try {
        await button(tv, "options").click();
        await view(tv, "watchParty:options").waitFor();
        assert.equal(await button(tv, "mode").count(), 0);
    } finally { await tv.page.context().close(); }
});

test("End party asks first, Cancel changes nothing, and End Party closes the room and says the party ended", async () => {
    const { tv, fake } = await inLobby();
    try {
        await button(tv, "options").click();
        await button(tv, "end").click();
        await view(tv, "watchParty:end").waitFor();
        assert.equal(await tv.page.locator(".watch-party-sheet-title").textContent(), "End this party for everyone?");
        assert.equal(await tv.focused(), "cancel");
        await button(tv, "cancel").click();
        await view(tv, "watchParty:lobby").waitFor();
        assert.deepEqual(fake.closedRooms, []);
        await button(tv, "options").click();
        await button(tv, "end").click();
        await button(tv, "confirm-end").click();
        await view(tv, "watchParty:hub").waitFor();
        assert.deepEqual(fake.closedRooms, ["0b6f3f0e-6c1d-4a39-9d52-3a1f7c7f9e10"]);
        assert.equal(await tv.page.locator(".watch-party-banner").textContent(), "This party has ended.");
        assert.equal(await tv.focused(), "create");
    } finally { await tv.page.context().close(); }
});

test("a refused End Party keeps the room and shows the reason in the lobby", async () => {
    const { tv, fake } = await inLobby();
    try {
        fake.closeFailure = problem(500, "server_error", "Try again in a moment.");
        await button(tv, "options").click();
        await button(tv, "end").click();
        await button(tv, "confirm-end").click();
        await view(tv, "watchParty:lobby").waitFor();
        await tv.page.locator(".watch-party-banner").waitFor();
        assert.equal(await tv.page.locator(".watch-party-banner").textContent(), "Try again in a moment.");
    } finally { await tv.page.context().close(); }
});

test("Leave party as the host is Apple's leaveRoom: no confirmation, this TV leaves and the party is not ended", async () => {
    const { tv, fake } = await inLobby();
    try {
        await button(tv, "options").click();
        await button(tv, "leave").click();
        await view(tv, "watchParty:hub").waitFor();
        assert.equal(await tv.focused(), "create");
        await tv.eventually(async () => fake.sockets[0]?.closed === true, "room socket closed");
        assert.deepEqual(fake.closedRooms, [], "the server holds the party while its host is away; End party ends it");
    } finally { await tv.page.context().close(); }
});

test("a season with no episodes says so in Apple's words, and Try Again reads it once more", async () => {
    const { tv, fake } = await inLobby("host", fake => { fake.episodesReply = { status: 200, body: { items: [] } }; });
    try {
        await button(tv, "choose").click();
        await view(tv, "watchParty:picker:shelves").waitFor();
        await button(tv, "series:s2").click();
        await view(tv, "watchParty:episodes").waitFor();
        await tv.page.locator(".watch-party-empty-title").waitFor();
        assert.equal(await tv.page.locator(".watch-party-empty-title").textContent(), "No episodes");
        assert.equal(await tv.page.locator(".watch-party-episodes .watch-party-lead").textContent(), "Nothing in this season is available to play.");
        assert.equal(await button(tv, "episodes-retry").textContent(), "Try Again", "offered with no error too");
        fake.episodesReply = undefined;
        await button(tv, "episodes-retry").click();
        await tv.page.locator(".watch-party-episode").first().waitFor();
    } finally { await tv.page.context().close(); }
});

test("a failed episodes read puts the reason under No episodes, with Try Again", async () => {
    const { tv } = await inLobby("host", fake => { fake.episodesReply = problem(503, "unavailable", "Down for maintenance."); });
    try {
        await button(tv, "choose").click();
        await view(tv, "watchParty:picker:shelves").waitFor();
        await button(tv, "series:s2").click();
        await tv.page.locator(".watch-party-empty-title").waitFor();
        assert.equal(await tv.page.locator(".watch-party-empty-title").textContent(), "No episodes");
        assert.equal(await tv.page.locator(".watch-party-episodes .watch-party-lead").textContent(), "Down for maintenance.");
        assert.equal(await tv.focused(), "episodes-close", "focus stays on the strip, where it opened");
        await tv.remote(40);
        assert.equal(await tv.focused(), "season:1", "the season tabs sit between Close and Try Again");
        await tv.remote(40);
        assert.equal(await tv.focused(), "episodes-retry");
        assert.equal(await button(tv, "episodes-retry").textContent(), "Try Again");
    } finally { await tv.page.context().close(); }
});

test("the code pill opens the invitation: the code, a QR for phones, and Done", async () => {
    const { tv } = await inLobby();
    try {
        await button(tv, "lobby-code").click();
        await view(tv, "watchParty:invite").waitFor();
        assert.equal(await tv.page.locator(".watch-party-eyebrow").first().textContent(), "Invite friends");
        assert.equal(await tv.page.locator(".watch-party-invite-title").textContent(), "Join with this code");
        assert.equal(await tv.page.locator(".watch-party-invite-code").textContent(), "K7M2QX");
        assert.equal(await tv.page.locator(".watch-party-qr svg").getAttribute("aria-label"), "Scan to join this party");
        assert.ok(Math.abs(await tv.page.locator(".watch-party-qr").evaluate(node => node.getBoundingClientRect().width) - (560 + 2 * 33.6)) < 0.5);
        assert.equal(await tv.focused(), "done");
        await tv.remote(10009);
        await view(tv, "watchParty:lobby").waitFor();
        assert.equal(await tv.focused(), "lobby-code", "focus returns to what opened the page");
        await button(tv, "invite").click();
        await view(tv, "watchParty:invite").waitFor();
        await button(tv, "done").click();
        await view(tv, "watchParty:lobby").waitFor();
    } finally { await tv.page.context().close(); }
});

test("a room with no invitation link shows the code without a QR", async () => {
    const { tv } = await inLobby("host", fake => { fake.invitePath = undefined; });
    try {
        await button(tv, "lobby-code").click();
        await view(tv, "watchParty:invite").waitFor();
        assert.equal(await tv.page.locator(".watch-party-qr").count(), 0);
        assert.equal(await tv.page.locator(".watch-party-invite-code").textContent(), "K7M2QX");
    } finally { await tv.page.context().close(); }
});

test("a playing party offers Return to playback and, with the stop capability, Return everyone to lobby", async () => {
    const { tv, fake } = await inLobby();
    try {
        await stageMovie(tv);
        await button(tv, "start").click();
        await tv.eventually(async () => (await tv.page.evaluate(() => window.browseHarness.plays.length)) === 1, "player opened");
        await tv.page.evaluate(() => window.browseHarness.resume());
        await view(tv, "watchParty:lobby").waitFor();
        assert.equal(await tv.page.locator(".watch-party-eyebrow").first().textContent(), "Now watching · together");
        assert.equal(await button(tv, "resume").textContent(), "Return to playback");
        assert.equal(await button(tv, "change").textContent(), "Choose something else");
        await button(tv, "options").click();
        assert.equal(await button(tv, "stop").count(), 1);
        await button(tv, "stop").click();
        await view(tv, "watchParty:lobby").waitFor();
        await tv.eventually(async () => (await tv.page.locator(".watch-party-eyebrow").first().textContent()) === "Up next · together", "back in the lobby");
        assert.equal(fake.phase, "lobby");
    } finally { await tv.page.context().close(); }
});

// --- A guest ---

test("a guest sees the host's room with no host controls: waiting copy, no action, and Leave party in Options", async () => {
    // Without lobby readiness a guest has no action at all; Ready is covered below.
    const { tv, fake } = await inLobby("guest", fake => { fake.flags = { ...fake.flags, lobby_ready: false }; });
    try {
        assert.equal(await tv.page.locator(".watch-party-eyebrow").first().textContent(), "Your party is open");
        assert.equal(await tv.page.locator(".watch-party-hero-title").textContent(), "Waiting for\nOwner");
        assert.equal(await tv.page.locator(".watch-party-lead").textContent(), "Owner is choosing what to watch. You'll see it here the moment they do.");
        assert.deepEqual(await texts(tv, ".watch-party-seat-detail"), ["Host", "You · not ready"]);
        assert.equal(await button(tv, "choose").count(), 0);
        assert.equal(await button(tv, "start").count(), 0);
        assert.equal(await tv.focused(), "lobby-code", "with no action the code pill takes focus");
        await button(tv, "options").click();
        assert.deepEqual(await texts(tv, ".watch-party-option"), ["Leave party", "Close"]);
        await button(tv, "leave").click();
        await view(tv, "watchParty:hub").waitFor();
        assert.deepEqual(fake.closedRooms, [], "a guest has no HTTP leave");
        assert.equal(await tv.focused(), "create");
    } finally { await tv.page.context().close(); }
});

test("a guest joining a room with a chosen title sees it, who chose it and the host's hint", async () => {
    const { tv } = await inLobby("guest", fake => { fake.selectedContentId = "movie:m0004"; });
    try {
        await tv.eventually(async () => (await tv.page.locator(".watch-party-hero-title").textContent()) === "Movie 0004", "title loads from the catalog");
        assert.equal(await tv.page.locator(".watch-party-caption").first().textContent(), "Owner chose this");
        assert.equal(await tv.page.locator(".watch-party-hint").textContent(), "Owner starts the movie when everyone's set.");
    } finally { await tv.page.context().close(); }
});

test("a guest whose host is away sees the host-away indicator and Apple's warning", async () => {
    const { tv } = await inLobby("guest", fake => { fake.hostConnected = false; });
    try {
        assert.equal(await tv.page.locator(".watch-party-connection").textContent(), "Host away");
        assert.equal(await tv.page.locator(".watch-party-banner").textContent(), "Owner lost connection. The party holds for two minutes while they come back.");
    } finally { await tv.page.context().close(); }
});

test("Back from the lobby as the host returns to the entry and leaves as Leave party does, closing nothing", async () => {
    const { tv, fake } = await inLobby();
    try {
        await tv.remote(10009);
        await view(tv, "watchParty:hub").waitFor();
        assert.equal(await tv.focused(), "create");
        await tv.eventually(async () => fake.sockets[0]?.closed === true, "room socket closed");
        assert.deepEqual(fake.closedRooms, []);
    } finally { await tv.page.context().close(); }
});

// --- Live over the room socket ---

test("the room socket opens with a room read and a ticket carrying the room token, offering silo.room.v2 and the ticket", async () => {
    const { tv, fake } = await inLobby();
    try {
        assert.deepEqual(fake.roomReads, ["room-proof-one"]);
        assert.deepEqual(fake.ticketTokens, ["room-proof-one"]);
        assert.deepEqual(fake.sockets[0]?.protocols, ["silo.room.v2", "silo.ticket.ticket-1"]);
        assert.equal(fake.sockets[0]?.route.url(), "wss://silo.example.test/api/v2/watch-together/rooms/0b6f3f0e-6c1d-4a39-9d52-3a1f7c7f9e10/ws");
        await tv.eventually(async () => fake.sockets[0]?.sent[0]?.type === "ping", "the clock warms up from the first moment");
    } finally { await tv.page.context().close(); }
});

test("a guest joining shows up in the host's lobby live: their seat, the presence count, the dot and the hint", async () => {
    const { tv, fake } = await inLobby("host", fake => { fake.guestJoined = false; });
    try {
        assert.equal(await tv.page.locator(".watch-party-connection").textContent(), "Open");
        assert.deepEqual(await texts(tv, ".watch-party-seat:not(.watch-party-seat-invite) .watch-party-seat-name"), ["Owner"]);
        await stageMovie(tv);
        assert.equal(await tv.page.locator(".watch-party-hint").count(), 0, "nobody to wait for");
        fake.guestJoined = true;
        fake.snapshot();
        await tv.eventually(async () => (await texts(tv, ".watch-party-seat:not(.watch-party-seat-invite) .watch-party-seat-name")).length === 2, "Sam's seat");
        assert.deepEqual(await texts(tv, ".watch-party-seat:not(.watch-party-seat-invite) .watch-party-seat-name"), ["Owner", "Sam"]);
        assert.equal(await tv.page.locator(".watch-party-connection").textContent(), "2 here");
        assert.equal(await tv.page.locator(".watch-party-presence").textContent(), "1 of 2 ready");
        assert.equal(await tv.page.locator(".watch-party-hint").textContent(), "Sam hasn't marked ready. You can still start.");
        assert.equal(await tv.focused(), "start", "focus stays on the action");
        fake.guestReady = true;
        fake.snapshot();
        await tv.eventually(async () => (await tv.page.locator(".watch-party-presence").textContent()) === "2 of 2 ready", "Sam ready");
        assert.equal(await tv.page.locator(".watch-party-hint").textContent(), "Everyone's ready.");
    } finally { await tv.page.context().close(); }
});

test("a guest sees the host's pick and policy arrive live, without reading anything", async () => {
    const { tv, fake } = await inLobby("guest");
    try {
        assert.equal(await tv.page.locator(".watch-party-hero-title").textContent(), "Waiting for\nOwner");
        fake.selectedContentId = "movie:m0004";
        fake.snapshot();
        await tv.eventually(async () => (await tv.page.locator(".watch-party-hero-title").textContent()) === "Movie 0004", "the host's pick");
        assert.equal(await tv.page.locator(".watch-party-caption").first().textContent(), "Owner chose this");
        assert.equal(await tv.page.locator(".watch-party-hint").textContent(), "Owner starts the movie when everyone's set.");
        assert.deepEqual(fake.roomReads, ["room-proof-one"], "the snapshot carried the room");
        fake.hostConnected = false;
        fake.snapshot();
        await tv.eventually(async () => (await tv.page.locator(".watch-party-connection").textContent()) === "Host away", "host away");
        assert.equal(await tv.page.locator(".watch-party-banner").textContent(), "Owner lost connection. The party holds for two minutes while they come back.");
    } finally { await tv.page.context().close(); }
});

test("the host ending the party reaches a guest live: back to the entry with This party has ended.", async () => {
    const { tv, fake } = await inLobby("guest");
    try {
        fake.push({ type: "room_closed", reason: "ended" });
        await view(tv, "watchParty:hub").waitFor();
        assert.equal(await tv.page.locator(".watch-party-banner").textContent(), "This party has ended.");
        await tv.eventually(async () => fake.sockets[0]?.closed === true, "socket closed");
    } finally { await tv.page.context().close(); }
});

test("joining on another device takes over: this TV returns to the entry with Apple's take-over message", async () => {
    const { tv, fake } = await inLobby("guest");
    try {
        fake.push({ type: "connection_replaced", reason: "replaced" });
        await view(tv, "watchParty:hub").waitFor();
        assert.equal(await tv.page.locator(".watch-party-banner").textContent(), "This profile joined the party on another device. Rejoin here to take over playback.");
    } finally { await tv.page.context().close(); }
});

test("a dropped socket shows Reconnecting with Apple's banner, and reconnects with a fresh read and ticket", async () => {
    const { tv, fake } = await inLobby();
    try {
        await fake.sockets[0]?.route.close({ code: 1011 });
        await tv.eventually(async () => (await tv.page.locator(".watch-party-connection").textContent()) === "Reconnecting", "reconnecting dot");
        assert.equal(await tv.page.locator(".watch-party-banner").textContent(), "Reconnecting to the party…");
        assert.equal(await tv.focused(), "choose", "focus holds while the party reconnects");
        await tv.jump(1000);
        await connected(tv, fake, 2);
        assert.equal(await tv.page.locator(".watch-party-connection").textContent(), "2 here");
        assert.equal(await tv.page.locator(".watch-party-banner").count(), 0);
        assert.deepEqual(fake.ticketTokens, ["room-proof-one", "room-proof-one"], "every socket gets its own ticket");
        assert.equal(fake.roomReads.length, 2);
    } finally { await tv.page.context().close(); }
});

test("switching profile while in a party closes the room socket, and it does not come back", async () => {
    const { tv, fake } = await inLobby("guest");
    try {
        assert.equal(await tv.page.evaluate(() => window.browseHarness.selectProfile("p-kid", "2468")), "verified");
        await tv.eventually(async () => fake.sockets[0]?.closed === true, "socket closed");
        await tv.jump(20_000);
        assert.equal(fake.sockets.length, 1);
    } finally { await tv.page.context().close(); }
});

test("a series on both shelves opens the entry of the shelf it was chosen from", async () => {
    const { tv } = await inLobby("host", fake => { fake.duplicateSeries = true; });
    try {
        await button(tv, "choose").click();
        await view(tv, "watchParty:picker:shelves").waitFor();
        assert.equal(await tv.page.locator('[data-focus="series:s1"]').count(), 2);
        await tv.page.locator('[data-focus="series:s1"]').first().click();
        await view(tv, "watchParty:choice").waitFor();
        assert.equal(await tv.page.locator(".watch-party-choice-facts").textContent(), "S1 · E2 · Harbor Lights chapter 1.2", "Continue Together goes to its next-up episode");
    } finally { await tv.page.context().close(); }
});

test("a failed reload keeps the shelves, shows the reason and a Try Again that works", async () => {
    const { tv, fake } = await inLobby();
    try {
        await button(tv, "choose").click();
        await view(tv, "watchParty:picker:shelves").waitFor();
        await tv.remote(10009);
        await view(tv, "watchParty:lobby").waitFor();
        fake.pickerFailure = problem(503, "unavailable", "Down for maintenance.");
        await button(tv, "choose").click();
        await tv.page.locator(".watch-party-banner").waitFor();
        assert.equal(await tv.page.locator(".watch-party-shelf").count(), 2, "the shelves from the first read stay");
        assert.equal(await tv.page.locator(".watch-party-banner").textContent(), "Down for maintenance.");
        assert.equal(await button(tv, "picker-retry").count(), 1, "Try Again is on the page");
        fake.pickerFailure = undefined;
        await button(tv, "picker-retry").click();
        await tv.eventually(async () => await tv.page.locator(".watch-party-banner").count() === 0, "error clears");
        assert.equal(await tv.page.locator(".watch-party-shelf").count(), 2);
    } finally { await tv.page.context().close(); }
});

// --- Ready and the vote room's ballot ---

const cards = (tv: Tv) => texts(tv, ".watch-party-ballot .watch-party-candidate:not(.watch-party-suggest-card) .watch-party-candidate-title");
const tallies = (tv: Tv) => texts(tv, ".watch-party-ballot .watch-party-vote-count");

/** The ballot read has run (the page waits 200 ms after the socket opens) and shows `count` suggestions. */
async function ballotShows(tv: Tv, count: number): Promise<void> {
    await jumpUntil(tv, 250, async () => (await cards(tv)).length === count, `${count} suggestions`);
}

/** Every focus target is still a lobby control: focus never falls to the page. */
async function focusKept(tv: Tv): Promise<string> {
    const key = await tv.focused();
    assert.notEqual(key, null, "focus is on a control");
    return key ?? "";
}

test("a guest marks Ready over the room socket, sees You're ready once the room says so, and can undo it", async () => {
    const { tv, fake } = await inLobby("guest", fake => { fake.selectedContentId = "movie:m0004"; });
    try {
        await tv.eventually(async () => (await button(tv, "ready").textContent()) === "I'm ready", "Ready offered");
        assert.equal(await tv.focused(), "ready", "the lobby opens on Ready");
        await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => (await button(tv, "ready").textContent()) === "You're readytap to undo", "the room marked the seat");
        assert.deepEqual(fake.sockets[0]?.sent.filter(frame => frame.type === "lobby_ready"), [{ type: "lobby_ready", ready: true }]);
        assert.equal(await button(tv, "ready").getAttribute("aria-pressed"), "true");
        assert.deepEqual(await texts(tv, ".watch-party-seat-detail"), ["Host", "You"], "Sam's seat no longer says not ready");
        assert.equal(await tv.page.locator(".watch-party-presence").textContent(), "2 of 2 ready");
        assert.equal(await tv.focused(), "ready", "focus stays on the button while its label changes");
        await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => (await button(tv, "ready").textContent()) === "I'm ready", "undone");
        assert.deepEqual(fake.sockets[0]?.sent.filter(frame => frame.type === "lobby_ready").map(frame => frame.ready), [true, false]);
        assert.equal(await tv.focused(), "ready");
    } finally { await tv.page.context().close(); }
});

test("a Select pressed on Ready while it is disabled stays inert after the party reconnects, and one pressed enabled stays inert once it disables", async () => {
    const { tv, fake } = await inLobby("guest", fake => { fake.selectedContentId = "movie:m0004"; });
    try {
        await tv.eventually(async () => (await button(tv, "ready").textContent()) === "I'm ready", "Ready offered");
        await fake.sockets[0]?.route.close({ code: 1011 });
        await tv.eventually(async () => (await button(tv, "ready").getAttribute("aria-disabled")) === "true", "Ready disabled while reconnecting");
        assert.equal(await tv.focused(), "ready");
        await tv.page.keyboard.down("Enter");
        await tv.jump(1000);
        await connected(tv, fake, 2);
        await tv.eventually(async () => (await button(tv, "ready").getAttribute("aria-disabled")) === "false", "Ready enabled again");
        assert.equal(await tv.focused(), "ready");
        await tv.page.keyboard.up("Enter");
        await tv.jump(100);
        assert.deepEqual(fake.sockets[1]?.sent.filter(frame => frame.type === "lobby_ready"), [], "a press made while disabled does not mark ready");
        await tv.page.keyboard.down("Enter");
        await fake.sockets[1]?.route.close({ code: 1011 });
        await tv.eventually(async () => (await button(tv, "ready").getAttribute("aria-disabled")) === "true", "Ready disabled again");
        await tv.page.keyboard.up("Enter");
        await tv.jump(1000);
        await connected(tv, fake, 3);
        assert.deepEqual(fake.sockets.flatMap(socket => socket.sent.filter(frame => frame.type === "lobby_ready")), [], "a press whose button disabled before release does not mark ready");
        await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => fake.sockets[2]?.sent.some(frame => frame.type === "lobby_ready") === true, "a fresh press marks ready");
    } finally { await tv.page.context().close(); }
});

test("a server without lobby readiness offers a guest no Ready", async () => {
    const { tv } = await inLobby("guest", fake => { fake.flags = { ...fake.flags, lobby_ready: false }; });
    try {
        assert.equal(await tv.page.locator('[data-focus="ready"]').count(), 0);
    } finally { await tv.page.context().close(); }
});

test("an empty vote room asks the question, offers Suggest a title, and the picker adds one to the ballot", async () => {
    const { tv, fake } = await inLobby("host", fake => { fake.selectionMode = "vote"; });
    try {
        await ballotShows(tv, 0);
        assert.equal(await tv.page.locator(".watch-party-eyebrow").first().textContent(), "Voting · 0 titles");
        assert.equal(await tv.page.locator(".watch-party-hero-title").textContent(), "What are we watching?");
        assert.equal(await tv.page.locator(".watch-party-lead").textContent(), "Everyone votes. You start the leader.");
        assert.equal(await tv.page.locator(".watch-party-banner").count(), 0, "voting is available");
        assert.equal(await button(tv, "suggest").textContent(), "Suggest a title");
        assert.equal(await tv.page.locator(".watch-party-hint").textContent(), "Suggest a title to get the vote going.");
        assert.equal(await tv.page.locator(".watch-party-suggest-card .watch-party-candidate-title").textContent(), "Suggest a title");
        assert.equal(await tv.focused(), "suggest");
        await button(tv, "suggest").click();
        await view(tv, "watchParty:picker:shelves").waitFor();
        assert.equal(await tv.page.locator(".watch-party-picker-name").textContent(), "Suggest a title");
        await button(tv, "movie:m0004").click();
        await view(tv, "watchParty:choice").waitFor();
        assert.equal(await tv.page.locator(".watch-party-choice .watch-party-eyebrow").textContent(), "Suggest to the party");
        assert.equal(await button(tv, "confirm").textContent(), "Add suggestion");
        await button(tv, "confirm").click();
        await view(tv, "watchParty:lobby").waitFor();
        await ballotShows(tv, 1);
        const added = fake.ballotChanges.at(-1);
        assert.equal(added?.call, "POST /suggestions");
        assert.equal(added?.roomToken, "room-proof-one");
        assert.deepEqual([added?.body?.content_id, added?.body?.content_type, added?.body?.title], ["movie:m0004", "movie", "Movie 0004"]);
        assert.match(String(added?.body?.suggestion_id), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.deepEqual(await cards(tv), ["Movie 0004"]);
        assert.equal(await tv.page.locator(".watch-party-hint").textContent(), "Nobody has voted yet.");
        assert.deepEqual(fake.roomChanges, [], "a suggestion changes no room");
        await focusKept(tv);
    } finally { await tv.page.context().close(); }
});

test("the ballot shows each tally and the leader; Select votes and takes it back, and the leader starts with Start", async () => {
    const { tv, fake } = await inLobby("host", fake => {
        fake.selectionMode = "vote";
        fake.suggest("dune", "Dune", ["p-guest"], { subtitle: "Part One" });
        fake.suggest("heat", "Heat");
    });
    try {
        await ballotShows(tv, 2);
        assert.equal(await tv.page.locator(".watch-party-eyebrow").first().textContent(), "Voting · 2 titles");
        assert.deepEqual(await tallies(tv), ["1", "0"]);
        assert.deepEqual(await texts(tv, ".watch-party-ballot .watch-party-vote-label"), ["VOTE", "VOTES"]);
        assert.deepEqual(await texts(tv, ".watch-party-candidate-leader .watch-party-candidate-title"), ["Dune"]);
        assert.deepEqual(await texts(tv, ".watch-party-ballot .watch-party-candidate-line"), ["Part One", " ", "Anyone can add one"]);
        assert.equal(await button(tv, "start").textContent(), "Start Dune");
        assert.equal(await button(tv, "suggest").textContent(), "Suggest");
        assert.equal(await tv.page.locator(".watch-party-hint").textContent(), "Sam hasn't marked ready. You can still start.");
        assert.equal(await button(tv, "suggestion:heat").getAttribute("aria-label"), "Vote for Heat, 0 votes");
        // Up from the actions passes the seats and reaches the ballot.
        await tv.remote(38);
        await tv.remote(38);
        assert.ok((await tv.focused())?.startsWith("suggestion:") || await tv.focused() === "ballot-suggest", "the ballot row is reachable");
        await button(tv, "suggestion:heat").focus();
        await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => JSON.stringify(await tallies(tv)) === JSON.stringify(["1", "1"]), "my vote counted");
        await tv.eventually(async () => (await tv.page.locator('[data-focus="suggestion:heat"] .watch-party-candidate-tick').count()) === 1, "my tick");
        assert.equal(fake.ballotChanges.at(-1)?.call, "POST /suggestions/heat/vote");
        assert.equal(fake.ballotChanges.at(-1)?.roomToken, "room-proof-one");
        assert.equal(await button(tv, "suggestion:heat").getAttribute("aria-label"), "Remove vote for Heat, 1 vote");
        assert.equal(await tv.focused(), "suggestion:heat", "focus stays on the card it voted for");
        assert.equal(await button(tv, "start").textContent(), "Start Dune", "a tie goes to the earlier suggestion");
        // As on Apple, Start does nothing while a ballot change runs, and the server's broadcast can show the new tally before
        // the change has read the ballot back. Hold the take-back's answer until that tally shows: the read-back then
        // repaints the lobby once, in the same turn as the change ends, and Start waits for that repaint.
        await pauseTvClock(tv);
        const takeBack = tv.fake.hold(`/watch-together/rooms/${ROOM_ID}/suggestions/heat/vote`);
        await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => JSON.stringify(await tallies(tv)) === JSON.stringify(["1", "0"]), "my vote taken back");
        assert.equal(fake.ballotChanges.at(-1)?.call, "DELETE /suggestions/heat/vote");
        assert.equal(await tv.focused(), "suggestion:heat");
        const shown = await button(tv, "start").elementHandle();
        takeBack.release();
        await tv.eventually(async () => await shown?.evaluate(node => !node.isConnected) ?? false, "the take-back read the ballot back");
        await button(tv, "start").click();
        await tv.eventually(async () => (await tv.page.evaluate(() => window.browseHarness.plays.length)) === 1, "player opened");
        assert.equal(fake.ballotChanges.at(-1)?.call, "POST /suggestions/promote");
        assert.deepEqual(fake.ballotChanges.at(-1)?.body, { suggestion_id: "dune" });
        assert.equal((await tv.page.evaluate(() => window.browseHarness.plays[0]))?.contentId, "movie:dune");
    } finally { await tv.page.context().close(); }
});

test("live votes from others move the tallies and the leader while focus stays on its card, and a card that goes hands focus to the action", async () => {
    const { tv, fake } = await inLobby("guest", fake => {
        fake.selectionMode = "vote";
        fake.suggest("dune", "Dune", ["p-owner"]);
        fake.suggest("heat", "Heat");
        fake.suggest("alien", "Alien");
    });
    try {
        await ballotShows(tv, 3);
        assert.equal(await tv.page.locator(".watch-party-lead").textContent(), "Tap a title to vote. Owner starts the winner.");
        assert.equal(await tv.page.locator(".watch-party-hint").textContent(), "Owner starts Dune when voting settles.");
        assert.equal(await button(tv, "suggest").textContent(), "Suggest a title");
        await button(tv, "suggestion:heat").focus();
        fake.voteAs("p-other1", "heat", true);
        fake.voteAs("p-other2", "heat", true);
        await tv.eventually(async () => JSON.stringify(await tallies(tv)) === JSON.stringify(["1", "2", "0"]), "live tallies");
        await tv.eventually(async () => (await texts(tv, ".watch-party-candidate-leader .watch-party-candidate-title"))[0] === "Heat", "Heat leads");
        assert.equal(await tv.page.locator(".watch-party-hint").textContent(), "Owner starts Heat when voting settles.");
        assert.equal(await tv.focused(), "suggestion:heat", "focus is restored by suggestion id, not position");
        // The host removes the focused suggestion: focus goes to the lobby's action instead of falling to the page.
        fake.suggestions.splice(1, 1);
        fake.voteAs("p-other1", "alien", true);
        await tv.eventually(async () => (await cards(tv)).length === 2, "Heat removed");
        assert.equal(await focusKept(tv), "ready");
    } finally { await tv.page.context().close(); }
});

test("a ballot wider than the screen scrolls to keep the focused card in view, out to the Suggest card", async () => {
    const { tv } = await inLobby("host", fake => {
        fake.selectionMode = "vote";
        for (let index = 0; index < 9; index++) fake.suggest(`s${index}`, `Title ${index}`);
    });
    try {
        await ballotShows(tv, 9);
        await button(tv, "suggestion:s0").focus();
        for (let index = 0; index < 9; index++) await tv.remote(39);
        assert.equal(await tv.focused(), "ballot-suggest");
        await tv.eventually(async () => {
            const box = await button(tv, "ballot-suggest").boundingBox();
            return box !== null && box.x >= 0 && box.x + box.width <= 1920;
        }, "the Suggest card is on screen");
        await tv.remote(37);
        assert.equal(await tv.focused(), "suggestion:s8");
    } finally { await tv.page.context().close(); }
});

test("removing suggestions before the focused card keeps that card on screen", async () => {
    const { tv, fake } = await inLobby("host", fake => {
        fake.selectionMode = "vote";
        for (let index = 0; index < 20; index++) fake.suggest(`s${index}`, `Title ${index}`);
    });
    try {
        await ballotShows(tv, 20);
        await button(tv, "suggestion:s0").focus();
        for (let index = 0; index < 9; index++) await tv.remote(39);
        assert.equal(await tv.focused(), "suggestion:s9");
        // Let the reveal scroll settle first: a removal that lands mid-scroll can leave the card on screen by chance.
        await tv.jump(500);
        fake.suggestions.splice(0, 7);
        fake.voteAs("p-other", "s19", true);
        await tv.eventually(async () => (await cards(tv)).length === 13, "seven removed");
        assert.equal(await tv.focused(), "suggestion:s9");
        await tv.jump(500);
        const box = await tv.page.evaluate(() => {
            const card = document.activeElement as HTMLElement | null;
            const rect = card?.getBoundingClientRect();
            return { key: card?.dataset.focus, left: rect?.left ?? -1, right: rect?.right ?? -1 };
        });
        assert.equal(box.key, "suggestion:s9");
        assert.ok(box.left >= 0 && box.right <= 1920, `the focused card is on screen (${JSON.stringify(box)})`);
    } finally { await tv.page.context().close(); }
});
