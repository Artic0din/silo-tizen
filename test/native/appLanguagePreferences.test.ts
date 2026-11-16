// Settings > General's App Language row (`ui.app_language`), following silo-apple
// Networking/AppLanguagePreferences.swift against the fake server's settings routes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_LANGUAGE_KEY, type SettingsCapabilities } from "../../src/contracts/v2/settings.ts";
import { APP_LANGUAGE_INTRODUCED_IN, AppLanguagePreferences, appLanguageSettingsSupported } from "../../src/ui/appLanguagePreferences.ts";
import { settle } from "./support/clock.ts";
import { FakeSettings } from "./support/fakeSettings.ts";
import { problem } from "./support/fakeSilo.ts";
import { connected, signIn } from "./support/harness.ts";

function capability(revision: number, extras: Partial<SettingsCapabilities> = {}): SettingsCapabilities {
    return { apiVersion: 1, revision: "opaque", manifestRevision: revision, state: "available", allowed: true, scopes: ["profile", "profile_device"], supportsBatchedEffective: true, supportsAtomicShortcuts: true, clientFamilies: ["tv"], ...extras };
}

test("the row is offered only from manifest revision 28 on a server that is available, allowed and batches effective reads", () => {
    assert.equal(APP_LANGUAGE_INTRODUCED_IN, 28);
    assert.equal(appLanguageSettingsSupported(capability(28)), true);
    assert.equal(appLanguageSettingsSupported(capability(27)), false);
    assert.equal(appLanguageSettingsSupported(capability(28, { supportsBatchedEffective: false })), false);
    assert.equal(appLanguageSettingsSupported(capability(28, { allowed: false })), false);
    assert.equal(appLanguageSettingsSupported(capability(28, { state: "unavailable" })), false);
    assert.equal(appLanguageSettingsSupported(undefined), false);
});

const effectivePath = `/settings/values/effective?keys=${APP_LANGUAGE_KEY}`;
const profilePath = `/settings/values/${APP_LANGUAGE_KEY}?scope=profile`;
const devicePath = `/settings/values/${APP_LANGUAGE_KEY}?scope=profile_device`;

async function preferences(revision = 28) {
    const h = await connected();
    await signIn(h);
    const profile = (await h.core.profiles.list())[0];
    assert.ok(profile);
    h.core.profiles.select(profile);
    const settings = new FakeSettings(h.fake);
    settings.revision = revision;
    const store = new AppLanguagePreferences(h.core.session);
    await store.refresh();
    return { ...h, settings, store };
}

test("a profile with no language shows Match Device, with Match Device and English to pick from", async () => {
    const h = await preferences();
    try {
        assert.equal(h.store.isOffered, true);
        assert.deepEqual(h.store.currentChoice, { tag: null, isDeviceValue: false });
        assert.equal(h.store.selectedLabel, "Match Device");
        assert.deepEqual(h.store.options, [{ tag: null, label: "Match Device" }, { tag: "en", label: "English" }]);
        assert.equal(h.store.footer, "The language of Silo’s menus and buttons on this profile. Audio and subtitle languages are set in Playback.");
    } finally { h.store.stop(); }
});

test("a server older than revision 28 hides the row and never writes", async () => {
    const h = await preferences(27);
    try {
        assert.equal(h.store.isOffered, false);
        await h.store.select("en");
        assert.equal(h.fake.paths().some(path => path.startsWith("PUT ")), false);
    } finally { h.store.stop(); }
});

test("picking a language writes the profile's value and shows what the server then resolves", async () => {
    const h = await preferences();
    try {
        await h.store.select("en");
        assert.equal(h.fake.paths().includes(`PUT ${profilePath}`), true);
        assert.equal(h.settings.profile().get(APP_LANGUAGE_KEY), "en");
        assert.deepEqual(h.store.currentChoice, { tag: "en", isDeviceValue: false });
        assert.equal(h.store.selectedLabel, "English");
        await h.store.select(null);
        assert.equal(h.settings.profile().get(APP_LANGUAGE_KEY), null, "Match Device is stored as null");
        assert.equal(h.store.selectedLabel, "Match Device");
    } finally { h.store.stop(); }
});

test("choosing the language already stored does nothing", async () => {
    const h = await preferences();
    try {
        await h.store.select(null);
        assert.equal(h.fake.paths().some(path => path.startsWith("PUT ")), false);
    } finally { h.store.stop(); }
});

test("this TV's own value shows, and picking a language replaces it with the profile's", async () => {
    const h = await preferences();
    try {
        h.settings.device("p-owner", h.core.session.http.deviceId).set(APP_LANGUAGE_KEY, "en");
        await h.store.refresh();
        assert.deepEqual(h.store.currentChoice, { tag: "en", isDeviceValue: true });
        await h.store.select("en");
        assert.equal(h.fake.paths().includes(`PUT ${profilePath}`), true, "the shown language over a device row still saves");
        assert.equal(h.fake.paths().includes(`DELETE ${devicePath}`), true);
        assert.equal(h.settings.device("p-owner", h.core.session.http.deviceId).has(APP_LANGUAGE_KEY), false);
        assert.deepEqual(h.store.currentChoice, { tag: "en", isDeviceValue: false });
    } finally { h.store.stop(); }
});

test("a language another client stored that this build lacks shows as itself, with Apple's footer", async () => {
    const h = await preferences();
    try {
        h.settings.profile().set(APP_LANGUAGE_KEY, "es");
        await h.store.refresh();
        assert.equal(h.store.selectedLabel, "Español");
        assert.deepEqual(h.store.options.map(option => option.tag), [null, "en", "es"], "re-saving never clears it");
        assert.equal(h.store.footer, "Silo isn’t available in Español yet, so it uses the device language.");
    } finally { h.store.stop(); }
});

test("a regional English tag counts as shipped", async () => {
    const h = await preferences();
    try {
        h.settings.profile().set(APP_LANGUAGE_KEY, "en-GB");
        await h.store.refresh();
        assert.equal(h.store.footer.startsWith("The language of Silo"), true);
        assert.deepEqual(h.store.options.map(option => option.tag), [null, "en", "en-GB"], "kept as stored, as Apple lists it");
    } finally { h.store.stop(); }
});

test("a failed save restores the stored language and says why", async () => {
    const cases: [ReturnType<typeof problem>, string][] = [
        [problem(500, "internal", "Unavailable"), "The server didn't save the app language. Try again."],
        [problem(422, "unknown_setting", "Unknown"), "This server can't save the app language."],
    ];
    for (const [reply, message] of cases) {
        const h = await preferences();
        try {
            h.fake.script(profilePath, reply);
            await h.store.select("en");
            assert.equal(h.store.error, message);
            assert.deepEqual(h.store.currentChoice, { tag: null, isDeviceValue: false });
            assert.equal(h.store.isBusy, false);
        } finally { h.store.stop(); }
    }
});

test("a save that never arrives names the connection", async () => {
    const h = await preferences();
    try {
        h.fake.dropNextAnswer(`${profilePath}`);
        await h.store.select("en");
        assert.equal(h.store.error, "Couldn't save the app language. Check the connection and try again.");
    } finally { h.store.stop(); }
});

test("a save in flight holds the picker, and a second pick waits for it", async () => {
    const h = await preferences();
    try {
        const write = h.fake.hold(profilePath);
        const first = h.store.select("en");
        await settle();
        assert.equal(h.store.isBusy, true);
        assert.equal(h.store.currentChoice?.tag, "en", "the choice shows at once");
        await h.store.select(null);
        assert.equal(h.fake.paths().filter(path => path === `PUT ${profilePath}`).length, 1);
        write.release();
        await first;
        assert.equal(h.store.isBusy, false);
        assert.equal(h.store.currentChoice?.tag, "en");
    } finally { h.store.stop(); }
});

test("a stale read cannot overwrite a completed save", async () => {
    const h = await preferences();
    try {
        const read = h.fake.hold(effectivePath);
        const refresh = h.store.refresh();
        await settle();
        await h.store.select("en");
        read.release();
        await refresh;
        await settle();
        assert.equal(h.store.currentChoice?.tag, "en");
    } finally { h.store.stop(); }
});

test("subscribers hear every change, and none after stop", async () => {
    const h = await preferences();
    let heard = 0;
    h.store.subscribe(() => heard++);
    await h.store.select("en");
    assert.ok(heard > 0);
    h.store.stop();
    const before = heard;
    await h.store.refresh();
    assert.equal(heard, before);
});
