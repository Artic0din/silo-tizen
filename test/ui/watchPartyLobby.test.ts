import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeWatchParty, ROOM_FILE_ID } from "../native/support/fakeWatchParty.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";
import { button, menuTitles, openHub, start } from "./support/watchParty.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const view = (tv: Tv, name: string) => tv.page.locator(`.browse[data-view="${name}"]`);
const texts = (tv: Tv, selector: string) => tv.page.locator(selector).allTextContents();

/** Opens the hub and creates a host-pick room, or joins as a guest, then waits for the lobby. */
async function enterLobby(tv: Tv, fake: FakeWatchParty, how: "create" | "join" = "create"): Promise<void> {
    await tv.eventually(async () => (await menuTitles(tv)).includes("Watch Party"), "entry offered");
    await openHub(tv);
    if (how === "join") {
        await tv.page.locator('[data-focus="code"]').fill("K7M2QX");
        await button(tv, "join").click();
    } else await button(tv, "create").click();
    await view(tv, "watchParty:lobby").waitFor();
    assert.ok(fake);
}

async function inLobby(role: "host" | "guest" = "host", configure: (fake: FakeWatchParty) => void = () => undefined): Promise<{ tv: Tv; fake: FakeWatchParty }> {
    const tv = await openTv(browser, { app: "browse" });
    const fake = new FakeWatchParty();
    fake.role = role;
    configure(fake);
    await start(tv, fake);
    await enterLobby(tv, fake, role === "host" ? "create" : "join");
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
        assert.equal(await tv.page.locator(".watch-party-eyebrow").first().textContent(), "Voting");
        assert.equal(await tv.page.locator(".watch-party-hero-title").textContent(), "What are we watching?");
        assert.match(await tv.page.locator(".watch-party-banner").textContent() ?? "", /^Voting isn't available on this TV yet\./);
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

test("Leave party as the host ends the open room and returns to the entry", async () => {
    const { tv, fake } = await inLobby();
    try {
        await button(tv, "options").click();
        await button(tv, "leave").click();
        await view(tv, "watchParty:hub").waitFor();
        await tv.eventually(async () => fake.closedRooms.length === 1, "room closed");
        assert.equal(await tv.focused(), "create");
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
    const { tv, fake } = await inLobby("guest");
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

test("Back from the lobby as the host returns to the entry and ends the room, as before", async () => {
    const { tv, fake } = await inLobby();
    try {
        await tv.remote(10009);
        await view(tv, "watchParty:hub").waitFor();
        assert.equal(await tv.focused(), "create");
        await tv.eventually(async () => fake.closedRooms.length === 1, "host Back ends the room");
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
