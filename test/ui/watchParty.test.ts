import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeWatchParty } from "../native/support/fakeWatchParty.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";
import { button, menuTitles, openHub, pressDisabled, start } from "./support/watchParty.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

async function leaveSettings(tv: Tv): Promise<void> {
    for (let step = 0; step < 4 && !(await tv.page.locator('.browse[data-view="home"]').isVisible()); step++) await tv.remote(10009);
    await tv.page.locator('.browse[data-view="home"]').waitFor();
}
async function openServerSettings(tv: Tv): Promise<void> {
    await button(tv, "profiles").click();
    await button(tv, "settings").click();
    await tv.page.locator('[data-focus="server"]').click();
}

test("the profile menu hides Watch Party until the device turns it on", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv, new FakeWatchParty(), false);
        assert.deepEqual(await menuTitles(tv), ["Switch Profile", "History", "Requests", "Settings", "Sign Out"]);
    } finally { await tv.page.context().close(); }
});

test("with the toggle on and the server allowing it, Watch Party sits after Requests in the profile menu", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = await start(tv);
        await tv.eventually(async () => (await menuTitles(tv)).includes("Watch Party"), "Watch Party offered");
        assert.deepEqual(await menuTitles(tv), ["Switch Profile", "History", "Requests", "Watch Party", "Settings", "Sign Out"]);
        assert.deepEqual([...new Set(fake.capabilityReads)].sort(), ["playback", "watch-together"]);
    } finally { await tv.page.context().close(); }
});

test("the entry stays hidden unless the server gate, the room socket and both playback features all hold", async () => {
    const cases: [string, (fake: FakeWatchParty) => void][] = [
        ["state disabled", fake => { fake.state = "disabled"; }],
        ["not allowed", fake => { fake.allowed = false; }],
        ["no room socket protocol", fake => { fake.socketProtocol = undefined; }],
        ["no connection replacement", fake => { fake.connectionReplaced = false; }],
        ["no coordinator feature", fake => { fake.playbackFeatures = ["fixed_media_file_v1"]; }],
        ["no fixed-file feature", fake => { fake.playbackFeatures = ["watch_party_coordinator_v1"]; }],
    ];
    for (const [name, change] of cases) {
        const tv = await openTv(browser, { app: "browse" });
        try {
            const fake = new FakeWatchParty(); change(fake);
            await start(tv, fake);
            await tv.eventually(async () => fake.capabilityReads.length >= 2, `${name}: probed`);
            await tv.jump(100);
            assert.deepEqual(await menuTitles(tv), ["Switch Profile", "History", "Requests", "Settings", "Sign Out"], name);
        } finally { await tv.page.context().close(); }
    }
});

test("Settings > Server ends with EXTRA FEATURES and a Watch Party row that is Off by default and turns the entry on", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv, new FakeWatchParty(), false);
        await openServerSettings(tv);
        const headers = await tv.page.locator(".settings-section-header").allTextContents();
        assert.deepEqual(headers.slice(-2), ["ABOUT", "EXTRA FEATURES"]);
        const row = tv.page.getByRole("switch", { name: "Watch Party", exact: true });
        assert.equal(await row.getAttribute("aria-checked"), "false");
        assert.equal(await row.locator(".settings-row-value").textContent(), "Off");
        await row.click();
        assert.equal(await row.getAttribute("aria-checked"), "true");
        assert.equal(await row.locator(".settings-row-value").textContent(), "On");
        assert.equal(await tv.focused(), "experimental-watchParty", "focus stays on the toggled row");
        await leaveSettings(tv);
        await tv.eventually(async () => (await menuTitles(tv)).includes("Watch Party"), "entry appears after the toggle");
    } finally { await tv.page.context().close(); }
});

test("turning the toggle off removes the entry again", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        await tv.eventually(async () => (await menuTitles(tv)).includes("Watch Party"), "entry offered");
        await tv.page.keyboard.press("Escape");
        await openServerSettings(tv);
        const row = tv.page.getByRole("switch", { name: "Watch Party", exact: true });
        assert.equal(await row.getAttribute("aria-checked"), "true");
        await row.click();
        assert.equal(await row.getAttribute("aria-checked"), "false");
        await leaveSettings(tv);
        assert.ok(!(await menuTitles(tv)).includes("Watch Party"));
    } finally { await tv.page.context().close(); }
});

test("the hub is a root page under the bar with Apple's copy, Host and Join sections, and focus on Start a party", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        await tv.eventually(async () => (await menuTitles(tv)).includes("Watch Party"), "entry offered");
        await openHub(tv);
        assert.equal(await tv.page.locator(".browse-nav").count(), 1, "the top bar stays");
        assert.equal(await button(tv, "home").getAttribute("aria-current"), "page", "the tab underneath stays selected");
        assert.equal(await tv.page.locator(".watch-party-title").textContent(), "Watch something\ntogether");
        assert.equal(await tv.page.locator(".watch-party-body").textContent(), "Pick a title, share the code, and everyone's playback stays in step.");
        assert.deepEqual(await tv.page.locator(".watch-party-eyebrow").allTextContents(), ["Watch Party", "Host", "Join"]);
        assert.equal(await button(tv, "create").textContent(), "Start a party");
        assert.equal(await button(tv, "vote").textContent(), "Start a party and let everyone vote");
        assert.equal(await button(tv, "join").textContent(), "Join party");
        assert.equal(await tv.page.locator('[data-focus="code"]').getAttribute("placeholder"), "Party code or invite link");
        assert.equal(await tv.focused(), "create");
        assert.equal(await tv.page.locator(".watch-party-banner").count(), 0);
        assert.equal(await button(tv, "retry").count(), 0, "Check again shows only when the server cannot host a party");
    } finally { await tv.page.context().close(); }
});

test("remote order walks Start a party, vote and the code field, reaches Join party once a code is typed, and Up from the first row reaches the bar", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        await tv.eventually(async () => (await menuTitles(tv)).includes("Watch Party"), "entry offered");
        await openHub(tv);
        const seen: string[] = [];
        for (let step = 0; step < 3; step++) { await tv.remote(40); seen.push(await tv.focused() ?? ""); }
        assert.deepEqual(seen, ["vote", "code", "code"], "the disabled Join party takes no focus");
        await tv.page.locator('[data-focus="code"]').fill("K7M2QX");
        await tv.remote(40);
        assert.equal(await tv.focused(), "join", "Join party takes focus once a code is typed");
        await tv.remote(38); await tv.remote(38); await tv.remote(38);
        assert.equal(await tv.focused(), "create");
        await tv.remote(38);
        assert.equal(await tv.focused(), "home", "Up from the first row reaches the bar");
        await tv.remote(10009);
        await tv.page.locator('.browse[data-view="home"]').waitFor();
        assert.equal(await tv.focused(), "home", "Back from the bar returns to the tab underneath");
    } finally { await tv.page.context().close(); }
});

test("Done on the code field moves focus to Join party", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        await tv.eventually(async () => (await menuTitles(tv)).includes("Watch Party"), "entry offered");
        await openHub(tv);
        await tv.page.locator('[data-focus="code"]').focus();
        await tv.remote(65376);
        assert.equal(await tv.focused(), "code", "Done with no code has nowhere to go");
        await tv.page.locator('[data-focus="code"]').fill("K7M2QX");
        await tv.remote(65376);
        assert.equal(await tv.focused(), "join");
    } finally { await tv.page.context().close(); }
});

test("Join party is disabled until a code is typed", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = await start(tv);
        await tv.eventually(async () => (await menuTitles(tv)).includes("Watch Party"), "entry offered");
        await openHub(tv);
        assert.equal(await button(tv, "join").getAttribute("aria-disabled"), "true");
        await pressDisabled(tv, "join");
        assert.deepEqual(fake.joined, [], "a disabled Join party sends nothing");
        await tv.page.locator('[data-focus="code"]').fill("  k7m2qx ");
        assert.equal(await button(tv, "join").getAttribute("aria-disabled"), "false");
        await tv.page.locator('[data-focus="code"]').fill("   ");
        assert.equal(await button(tv, "join").getAttribute("aria-disabled"), "true");
    } finally { await tv.page.context().close(); }
});

test("Start a party creates a host-pick room and shows the code and members the create answered with", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = await start(tv);
        await tv.eventually(async () => (await menuTitles(tv)).includes("Watch Party"), "entry offered");
        await openHub(tv);
        await button(tv, "create").click();
        await tv.page.locator('.browse[data-view="watchParty:lobby"]').waitFor();
        assert.equal(fake.createdRooms.length, 1);
        assert.equal(fake.createdRooms[0]?.selection_mode, "host_pick");
        assert.match(String(fake.createdRooms[0]?.room_id), /^[0-9a-f-]{36}$/);
        assert.equal(await tv.page.locator(".watch-party-code").textContent(), "K7M2QX");
        assert.deepEqual(await tv.page.locator(".watch-party-seat:not(.watch-party-seat-invite) .watch-party-seat-name").allTextContents(), ["Owner", "Sam"]);
        assert.deepEqual(await tv.page.locator(".watch-party-seat-detail").allTextContents(), ["Host · You", "not ready"]);
        assert.equal(await tv.page.locator(".watch-party-presence").textContent(), "1 of 2 ready");
        await tv.remote(10009);
        await tv.page.locator('.browse[data-view="watchParty:hub"]').waitFor();
        assert.equal(await tv.focused(), "create", "Back returns to the entry on its first control");
        await tv.eventually(async () => fake.closedRooms.length === 1, "host Back ends the room");
        assert.deepEqual(fake.closedRooms, ["0b6f3f0e-6c1d-4a39-9d52-3a1f7c7f9e10"]);
    } finally { await tv.page.context().close(); }
});

test("Start a party and let everyone vote asks for a vote room", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = await start(tv);
        await tv.eventually(async () => (await menuTitles(tv)).includes("Watch Party"), "entry offered");
        await openHub(tv);
        await button(tv, "vote").click();
        await tv.page.locator('.browse[data-view="watchParty:lobby"]').waitFor();
        assert.equal(fake.createdRooms[0]?.selection_mode, "vote");
    } finally { await tv.page.context().close(); }
});

test("Join party sends the trimmed code and opens the lobby", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = await start(tv);
        await tv.eventually(async () => (await menuTitles(tv)).includes("Watch Party"), "entry offered");
        await openHub(tv);
        await tv.page.locator('[data-focus="code"]').fill(" k7m2qx ");
        await button(tv, "join").click();
        await tv.page.locator('.browse[data-view="watchParty:lobby"]').waitFor();
        assert.deepEqual(fake.joined, ["k7m2qx"]);
        assert.equal(await tv.page.locator(".watch-party-code").textContent(), "K7M2QX");
    } finally { await tv.page.context().close(); }
});

test("a refused join shows the server's reason in the warning banner and keeps the code", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = await start(tv);
        fake.joinFailure = problem(409, "party_closed", "That party has ended.");
        await tv.eventually(async () => (await menuTitles(tv)).includes("Watch Party"), "entry offered");
        await openHub(tv);
        await tv.page.locator('[data-focus="code"]').fill("OLD123");
        await button(tv, "join").click();
        await tv.page.locator(".watch-party-banner").waitFor();
        assert.equal(await tv.page.locator(".watch-party-banner").textContent(), "That party has ended.");
        assert.equal(await tv.page.locator(".watch-party-banner").getAttribute("role"), "alert");
        assert.equal(await tv.page.locator('[data-focus="code"]').inputValue(), "OLD123");
        assert.equal(await tv.page.locator('.browse[data-view="watchParty:hub"]').count(), 1);
        assert.ok(await tv.focused(), "focus is not lost");
    } finally { await tv.page.context().close(); }
});

test("a wrong code shows the server's own text, not the generic not-found wording", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = await start(tv);
        fake.joinFailure = problem(404, "room_not_found", "That party code was not found.");
        await tv.eventually(async () => (await menuTitles(tv)).includes("Watch Party"), "entry offered");
        await openHub(tv);
        await tv.page.locator('[data-focus="code"]').fill("NOPE00");
        await button(tv, "join").click();
        await tv.page.locator(".watch-party-banner").waitFor();
        assert.equal(await tv.page.locator(".watch-party-banner").textContent(), "That party code was not found.");
    } finally { await tv.page.context().close(); }
});

test("Start a party, vote and Join party are all disabled and unfocusable while a request runs", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = await start(tv);
        await tv.eventually(async () => (await menuTitles(tv)).includes("Watch Party"), "entry offered");
        await openHub(tv);
        await tv.page.locator('[data-focus="code"]').fill("K7M2QX");
        assert.equal(await button(tv, "join").getAttribute("aria-disabled"), "false");
        const hold = tv.fake.hold("/watch-together/rooms");
        await button(tv, "create").click();
        await tv.eventually(async () => await button(tv, "create").getAttribute("aria-disabled") === "true", "busy");
        assert.equal(await button(tv, "vote").getAttribute("aria-disabled"), "true");
        assert.equal(await button(tv, "join").getAttribute("aria-disabled"), "true");
        assert.ok(["code", "retry"].includes(await tv.focused() ?? ""), "focus left the disabled button");
        await pressDisabled(tv, "vote");
        await pressDisabled(tv, "join");
        hold.release();
        await tv.page.locator('.browse[data-view="watchParty:lobby"]').waitFor();
        assert.equal(fake.createdRooms.length, 1, "taps while busy send nothing");
        assert.deepEqual(fake.joined, []);
    } finally { await tv.page.context().close(); }
});

test("a link instead of a code gets Apple's invalid-invitation text and sends nothing", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = await start(tv);
        await tv.eventually(async () => (await menuTitles(tv)).includes("Watch Party"), "entry offered");
        await openHub(tv);
        await tv.page.locator('[data-focus="code"]').fill("https://silo.example.test/rooms/join?token=abc");
        await button(tv, "join").click();
        await tv.page.locator(".watch-party-banner").waitFor();
        assert.equal(await tv.page.locator(".watch-party-banner").textContent(), "This Watch Party invitation is invalid.");
        assert.deepEqual(fake.joined, []);
    } finally { await tv.page.context().close(); }
});

test("a server that stops supporting Watch Party shows the notice, disables the actions and offers Check again", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = await start(tv);
        await tv.eventually(async () => (await menuTitles(tv)).includes("Watch Party"), "entry offered");
        fake.state = "disabled";
        await openHub(tv);
        await tv.page.locator(".watch-party-banner").waitFor();
        assert.equal(await tv.page.locator(".watch-party-banner").textContent(), "Watch Party is not available for this profile on this server.");
        assert.equal(await button(tv, "create").getAttribute("aria-disabled"), "true");
        assert.equal(await button(tv, "vote").getAttribute("aria-disabled"), "true");
        assert.equal(await button(tv, "join").getAttribute("aria-disabled"), "true");
        assert.equal(await button(tv, "retry").textContent(), "Check again");
        assert.equal(await tv.focused(), "retry", "focus opens on Check again, the one enabled button");
        const visited = new Set<string>();
        for (const key of [40, 40, 38, 38, 38]) { await tv.remote(key); visited.add(await tv.focused() ?? ""); }
        for (const disabled of ["create", "vote", "join"]) assert.ok(!visited.has(disabled), `${disabled} is disabled and takes no focus`);
        fake.state = "available";
        await button(tv, "retry").click();
        await tv.eventually(async () => await tv.page.locator(".watch-party-banner").count() === 0, "banner clears");
        assert.equal(await button(tv, "create").getAttribute("aria-disabled"), "false");
        assert.equal(await button(tv, "retry").count(), 0);
    } finally { await tv.page.context().close(); }
});

test("a failed support check says so and keeps the entry usable", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = await start(tv);
        await tv.eventually(async () => (await menuTitles(tv)).includes("Watch Party"), "entry offered");
        fake.capabilitiesFailure = problem(409, "unavailable", "Down for maintenance.");
        await openHub(tv);
        await tv.page.locator(".watch-party-banner").waitFor();
        assert.equal(await tv.page.locator(".watch-party-banner").textContent(), "Could not check Watch Party support. Down for maintenance.");
        assert.equal(await button(tv, "create").getAttribute("aria-disabled"), "false");
    } finally { await tv.page.context().close(); }
});

test("a Watch Party row that appears while the profile menu is open leaves focus on the row it was on", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const capabilities = { hold: undefined as ReturnType<typeof tv.fake.hold> | undefined };
        await start(tv, new FakeWatchParty(), true, () => { capabilities.hold = tv.fake.hold("/watch-together/capabilities"); });
        await button(tv, "profiles").click();
        await button(tv, "settings").focus();
        assert.equal(await tv.focused(), "settings");
        capabilities.hold?.release();
        await tv.eventually(async () => await button(tv, "watch-party").count() > 0, "Watch Party row appears");
        assert.equal(await tv.focused(), "settings", "the rebuild keeps focus on the row it was on");
    } finally { await tv.page.context().close(); }
});
