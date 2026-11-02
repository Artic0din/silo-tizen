// Home's title-art and poster-badge answers follow silo-apple 1a7ccee TitleArtPreferences and
// OverlayPrefsStore while reads are pending, after they fail, and when a profile or administrator chose off.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SettingsKey } from "../../src/contracts/v2/settings.ts";
import { PresentationSettings } from "../../src/ui/presentationSettings.ts";
import { settle } from "./support/clock.ts";
import { FakeCatalog } from "./support/fakeCatalog.ts";
import { FakeSettings } from "./support/fakeSettings.ts";
import { problem } from "./support/fakeSilo.ts";
import { connected, type Harness, signIn } from "./support/harness.ts";
import type { MemoryPublicStorage } from "./support/keyManager.ts";

const TITLE = "ui.title_art" as SettingsKey;
const OVERLAYS = "ui.card_overlays" as SettingsKey;
const OVERLAYS_ENABLED = "ui.card_overlays_enabled" as SettingsKey;
const KEY = "silo.titleArt:test";
const CARDS = "ui.card_presentation" as SettingsKey;
const failure = problem(500, "internal", "Unavailable");

async function setup(storage?: MemoryPublicStorage): Promise<Harness & { settings: FakeSettings }> {
    const h = await connected(storage === undefined ? {} : { storage });
    await signIn(h);
    h.fake.catalog = new FakeCatalog();
    const settings = new FakeSettings(h.fake);
    const profile = (await h.core.profiles.list())[0];
    assert.ok(profile);
    h.core.profiles.select(profile);
    return { ...h, settings };
}

/** "off" when cards draw no badges, else the preset they draw; read through a call so assertions do not narrow it. */
const badges = (presentation: PresentationSettings): string => presentation.cardOverlays?.preset ?? "off";

async function loaded(h: Harness, run: (presentation: PresentationSettings) => void = presentation => presentation.ensure()): Promise<PresentationSettings> {
    const presentation = new PresentationSettings(h.core.session, () => undefined, h.storage, KEY);
    run(presentation);
    await settle();
    return presentation;
}

for (const [size, scale] of [["compact", 0.86], ["standard", 1], ["large", 1.2]] as const) test(`Home reads ${size} poster size for the TV client family`, async () => {
    const h = await setup();
    h.settings.profile().set(CARDS, { poster_size: size, caption: "title_metadata" });
    const presentation = await loaded(h);
    assert.equal(presentation.posterScale, scale);
    assert.equal(h.settings.cardClientFamily, "tv");
    const relaunch = new PresentationSettings(h.core.session, () => undefined, h.storage, KEY);
    assert.equal(relaunch.posterScale, scale, "the first frame retains the confirmed per-profile size");
    h.fake.script("/settings/values/effective?keys=ui.card_presentation", failure);
    relaunch.ensure();
    await settle();
    assert.equal(relaunch.posterScale, scale, "a transient failure keeps the last answer");
});

test("Home resets cached poster size when the server no longer supports TV-family customization", async () => {
    const h = await setup();
    h.settings.profile().set(CARDS, { poster_size: "compact", caption: "title_metadata" });
    const presentation = await loaded(h);
    assert.equal(presentation.posterScale, 0.86);
    h.settings.clientFamilies = [];
    presentation.reload();
    await settle();
    assert.equal(presentation.posterScale, 1);
});

for (const failure of ["read", "write"] as const) test(`Home applies poster size when its optional cache cannot ${failure}`, async () => {
    const h = await setup();
    h.settings.profile().set(CARDS, { poster_size: "compact", caption: "title_metadata" });
    h.storage.failGet = failure === "read";
    h.storage.failSet = failure === "write";
    let changes = 0;
    const presentation = new PresentationSettings(h.core.session, () => { changes++; }, h.storage, KEY);
    presentation.ensure();
    await settle();
    assert.equal(presentation.posterScale, 0.86);
    assert.equal(changes, 1);
});

test("a stopped Home cannot apply a late poster-size answer", async () => {
    const h = await setup();
    h.settings.profile().set(CARDS, { poster_size: "compact", caption: "title_metadata" });
    const presentation = await loaded(h);
    const held = h.fake.hold("/settings/values/effective?keys=ui.card_presentation", true);
    h.settings.profile().set(CARDS, { poster_size: "large", caption: "title_metadata" });
    presentation.reload();
    await settle();
    presentation.stop();
    held.release();
    await settle();
    assert.equal(presentation.posterScale, 0.86);
});

test("Home keeps confirmed poster size when the next answer is malformed", async () => {
    const h = await setup();
    h.settings.profile().set(CARDS, { poster_size: "compact", caption: "title_metadata" });
    const presentation = await loaded(h);
    h.settings.profile().set(CARDS, { poster_size: "huge", caption: "title_metadata" });
    presentation.reload();
    await settle();
    assert.equal(presentation.posterScale, 0.86);
});

test("title art shows logos while unknown and after a failed read, and keeps a confirmed off across a failure", async () => {
    const h = await setup();
    h.settings.profile().set(TITLE, false);
    h.fake.script("/settings/contract/capabilities", failure);
    const first = new PresentationSettings(h.core.session, () => undefined, h.storage, KEY);
    assert.equal(first.showsTitleArt, true, "pending with nothing confirmed: logos, as Apple");
    first.ensure();
    await settle();
    assert.equal(first.showsTitleArt, true, "a failed read with nothing confirmed keeps logos");
    first.ensure();
    await settle();
    assert.equal(first.showsTitleArt, false, "the retry confirms the profile's off");
    assert.equal(h.storage.getItem(KEY), "false", "the confirmed answer is kept on the TV for this server and profile");

    h.fake.script("/settings/values/effective?keys=ui.title_art", failure);
    const relaunch = new PresentationSettings(h.core.session, () => undefined, h.storage, KEY);
    assert.equal(relaunch.showsTitleArt, false, "a launch paints the confirmed off before reading");
    relaunch.ensure();
    await settle();
    assert.equal(relaunch.showsTitleArt, false, "a failed read never turns a known off back on");
});

test("title art drops a confirmed answer when the server no longer offers the key", async () => {
    const h = await setup();
    h.storage.setItem(KEY, "false");
    h.settings.revision = 15;
    const old = await loaded(h);
    assert.equal(old.showsTitleArt, true);
    assert.equal(h.storage.getItem(KEY), null);
});

test("blocked title-art cache reads do not prevent successful settings from applying", async () => {
    const h = await setup();
    h.settings.profile().set(TITLE, false);
    h.storage.failGet = true;
    let changes = 0;
    const presentation = new PresentationSettings(h.core.session, () => { changes++; }, h.storage, KEY);
    presentation.ensure();
    await settle();
    assert.equal(presentation.showsTitleArt, false);
    assert.equal(changes, 1);
});

test("a failed title-art cache write still notifies and settles the successful answer", async () => {
    const h = await setup();
    h.settings.profile().set(TITLE, false);
    h.storage.failSet = true;
    let changes = 0;
    const presentation = new PresentationSettings(h.core.session, () => { changes++; }, h.storage, KEY);
    presentation.ensure();
    await settle();
    assert.equal(presentation.showsTitleArt, false);
    assert.equal(changes, 1);
    const requests = h.fake.requests.length;
    presentation.ensure();
    await settle();
    assert.equal(h.fake.requests.length, requests, "persistence failure does not discard a successful server answer");
});

test("a failed cache removal still applies an older server's title-art fallback", async () => {
    const h = await setup();
    h.storage.setItem(KEY, "false");
    h.settings.revision = 15;
    h.storage.removeItem = () => { throw new Error("SecurityError"); };
    let changes = 0;
    const presentation = new PresentationSettings(h.core.session, () => { changes++; }, h.storage, KEY);
    presentation.ensure();
    await settle();
    assert.equal(presentation.showsTitleArt, true);
    assert.equal(changes, 1);
});

test("poster badges show the registry defaults while pending and when the server-wide default cannot be read", async () => {
    const h = await setup();
    const presentation = new PresentationSettings(h.core.session, () => undefined, h.storage, KEY);
    assert.equal(badges(presentation), "classic", "registry defaults before any answer");
    h.settings.overlayConfig = undefined;
    presentation.ensure();
    await settle();
    assert.equal(badges(presentation), "classic", "nothing known to be off, so the defaults stay");
    assert.equal(presentation.cardOverlays?.items.get("resolution")?.enabled, true);
});

test("poster badges keep a known administrator off when a later read fails, and a profile's explicit choice wins either way", async () => {
    const h = await setup();
    h.settings.overlayConfig = { enabled: false };
    const presentation = await loaded(h);
    assert.equal(badges(presentation), "off", "the administrator turned badges off");
    h.settings.overlayConfig = undefined;
    presentation.reload();
    await settle();
    assert.equal(badges(presentation), "off", "a failed reread keeps the known off");

    h.settings.profile().set(OVERLAYS_ENABLED, true);
    presentation.reload();
    await settle();
    assert.equal(badges(presentation), "classic", "the profile's on wins over the remembered administrator off");

    h.settings.overlayConfig = { enabled: true };
    h.settings.profile().set(OVERLAYS_ENABLED, false);
    presentation.reload();
    await settle();
    assert.equal(badges(presentation), "off", "the profile's off wins over the administrator's on");
    h.fake.script("/settings/values/effective?keys=ui.card_overlays&keys=ui.card_overlays_enabled", failure);
    presentation.reload();
    await settle();
    assert.equal(badges(presentation), "off", "a failed profile read keeps the profile's known off");
});

test("poster badges keep the profile's document when its reread fails", async () => {
    const h = await setup();
    h.settings.profile().set(OVERLAYS, { version: 2, preset: "square", order: [], items: {} });
    const presentation = await loaded(h);
    assert.equal(badges(presentation), "square");
    h.fake.script("/settings/values/effective?keys=ui.card_overlays&keys=ui.card_overlays_enabled", failure);
    presentation.reload();
    await settle();
    assert.equal(badges(presentation), "square");
});
