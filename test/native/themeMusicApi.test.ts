// Theme music wire contract, settings rows and audio element, against the vendored v2 fixture and fakes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeItemDetail } from "../../src/contracts/v2/catalog.ts";
import { THEME_MUSIC_ENABLED_KEY, THEME_MUSIC_LOOP_KEY, type SettingsCapabilities } from "../../src/contracts/v2/settings.ts";
import { decodeThemeCapability, decodeThemePlayback, decodeThemeSongSet, themeAudioFormats } from "../../src/contracts/v2/themeMusic.ts";
import { operations } from "../../src/api/operations.ts";
import { ElementThemeOutput } from "../../src/ui/themeAudioOutput.ts";
import { THEME_MUSIC_INTRODUCED_IN, ThemeMusicPreferences, themeMusicSettingsSupported } from "../../src/ui/themeMusicPreferences.ts";
import { settle } from "./support/clock.ts";
import { FakeSettings } from "./support/fakeSettings.ts";
import { fixture, problem } from "./support/fakeSilo.ts";
import { connected, signIn } from "./support/harness.ts";

test("item detail carries the server-resolved theme set, and a malformed set reads as none", () => {
    const detail = decodeItemDetail(fixture("get_catalog_item_ok"));
    assert.deepEqual(detail.themes, { ownerId: "movie:heat-1995", items: [{ id: "7", title: "Opening", durationSeconds: 60 }] });
    assert.equal(decodeItemDetail({ ...fixture("get_catalog_item_ok"), themes: undefined }).themes, undefined);
    assert.equal(decodeItemDetail({ ...fixture("get_catalog_item_ok"), themes: { owner_id: "movie:heat-1995", items: "none" } }).themes, undefined);
    assert.deepEqual(decodeThemeSongSet({ owner_id: "series:s1", items: [] }), { ownerId: "series:s1", items: [] });
    assert.equal(decodeThemeSongSet({ owner_id: "", items: [] }), undefined);
});

test("the capability needs state available and a permitted profile", () => {
    assert.equal(decodeThemeCapability({ state: "available", allowed: true, delivery: "routed", transcode: true }), true);
    assert.equal(decodeThemeCapability({ state: "available" }), true);
    assert.equal(decodeThemeCapability({ state: "available", allowed: false }), false);
    assert.equal(decodeThemeCapability({ state: "unavailable" }), false);
    assert.throws(() => decodeThemeCapability({ allowed: true }));
});

test("a grant is original unless the server converted it", () => {
    assert.deepEqual(decodeThemePlayback({ url: "/api/v2/x", delivery: "converted", content_type: "audio/mp4", expires_at: "later" }), { url: "/api/v2/x", converted: true });
    assert.deepEqual(decodeThemePlayback({ url: "/api/v2/x" }), { url: "/api/v2/x", converted: false });
    assert.throws(() => decodeThemePlayback({ delivery: "original" }));
});

test("accepted formats are the pairs this Chromium says it can play", () => {
    const supported = new Set(["audio/mpeg", 'audio/mp4; codecs="mp4a.40.2"']);
    const formats = themeAudioFormats({ canPlayType: mime => supported.has(mime) ? "probably" : "" });
    assert.deepEqual(formats, [{ container: "mp3", audio_codec: "mp3" }, { container: "mp4", audio_codec: "aac" }, { container: "m4a", audio_codec: "aac" }]);
    assert.deepEqual(themeAudioFormats({ canPlayType: () => "" }), []);
});

test("the playback request lists accepted formats, and sends no body when there are none", () => {
    const withFormats = operations.themePlayback("series:s1", "7", [{ container: "mp3", audio_codec: "mp3" }]);
    assert.equal(withFormats.method, "POST");
    assert.equal(withFormats.path, "/catalog/items/series%3As1/themes/7/playback");
    assert.deepEqual(withFormats.body, { accepted_formats: [{ container: "mp3", audio_codec: "mp3" }] });
    assert.equal("body" in operations.themePlayback("movie:1", "7", []), false);
    assert.equal(operations.themeCapability().path, "/catalog/themes/capabilities");
});

function capability(revision: number, extras: Partial<SettingsCapabilities> = {}): SettingsCapabilities {
    return { apiVersion: 1, revision: "opaque", manifestRevision: revision, state: "available", allowed: true, scopes: ["profile", "profile_device"], supportsBatchedEffective: true, supportsAtomicShortcuts: true, clientFamilies: ["tv"], ...extras };
}

test("theme music settings appear only when the server serves revision 11 with a device scope", () => {
    assert.equal(THEME_MUSIC_INTRODUCED_IN, 11);
    assert.equal(themeMusicSettingsSupported(capability(11)), true);
    assert.equal(themeMusicSettingsSupported(capability(10)), false);
    assert.equal(themeMusicSettingsSupported(capability(24, { scopes: ["profile"] })), false);
    assert.equal(themeMusicSettingsSupported(capability(24, { supportsBatchedEffective: false })), false);
    assert.equal(themeMusicSettingsSupported(capability(24, { allowed: false })), false);
    assert.equal(themeMusicSettingsSupported(undefined), false);
});

const effectivePath = `/settings/values/effective?keys=${THEME_MUSIC_ENABLED_KEY}&keys=${THEME_MUSIC_LOOP_KEY}`;
const enabledPath = `/settings/values/${THEME_MUSIC_ENABLED_KEY}?scope=profile_device`;
const loopPath = `/settings/values/${THEME_MUSIC_LOOP_KEY}?scope=profile_device`;

async function preferences(revision = 24) {
    const h = await connected();
    await signIn(h);
    const profile = (await h.core.profiles.list())[0];
    assert.ok(profile);
    h.core.profiles.select(profile);
    const settings = new FakeSettings(h.fake);
    settings.revision = revision;
    const store = new ThemeMusicPreferences(h.core.session);
    await store.refresh();
    return { ...h, settings, store };
}

test("both rows default to off and are offered on a server that serves them", async () => {
    const h = await preferences();
    try {
        assert.equal(h.store.isOffered, true);
        assert.equal(h.store.playsThemeMusic, false);
        assert.equal(h.store.loops, false);
    } finally { h.store.stop(); }
});

test("a server older than revision 11 hides the rows and plays nothing", async () => {
    const h = await preferences(10);
    try {
        assert.equal(h.store.isOffered, false);
        assert.equal(h.store.playsThemeMusic, false);
        h.store.setEnabled(true);
        await h.store.waitForPendingWrites();
        assert.equal(h.fake.paths().some(path => path.startsWith("PUT ")), false);
    } finally { h.store.stop(); }
});

test("a change writes this TV's device value, then adopts what the server resolves", async () => {
    const h = await preferences();
    try {
        h.settings.profile().set(THEME_MUSIC_ENABLED_KEY, false);
        await h.store.refresh();
        h.store.setEnabled(true);
        assert.equal(h.store.playsThemeMusic, true, "the switch moves at once");
        await h.store.waitForPendingWrites();
        assert.equal(h.fake.paths().includes(`PUT ${enabledPath}`), true);
        assert.equal(h.settings.device("p-owner", h.core.session.http.deviceId).get(THEME_MUSIC_ENABLED_KEY), true);
        assert.equal(h.settings.profile().get(THEME_MUSIC_ENABLED_KEY), false, "the profile value is left alone");
        assert.equal(h.store.playsThemeMusic, true);
        h.store.setLoop(true);
        await h.store.waitForPendingWrites();
        assert.equal(h.store.loops, true);
        assert.equal(h.fake.paths().includes(`PUT ${loopPath}`), true);
    } finally { h.store.stop(); }
});

test("a device value wins over the profile's choice when read back", async () => {
    const h = await preferences();
    try {
        h.settings.profile().set(THEME_MUSIC_ENABLED_KEY, true);
        h.settings.device("p-owner", h.core.session.http.deviceId).set(THEME_MUSIC_ENABLED_KEY, false);
        await h.store.refresh();
        assert.equal(h.store.playsThemeMusic, false);
    } finally { h.store.stop(); }
});

test("a failed write rolls back only its own switch and says why", async () => {
    const h = await preferences();
    try {
        h.fake.script(enabledPath, problem(500, "internal", "Unavailable"));
        h.store.setEnabled(true);
        await h.store.waitForPendingWrites();
        assert.equal(h.store.playsThemeMusic, false);
        assert.equal(h.store.error, "The server didn't save the theme music setting. Try again.");
    } finally { h.store.stop(); }
});

test("a stale read cannot overwrite a completed write", async () => {
    const h = await preferences();
    try {
        const read = h.fake.hold(effectivePath);
        const refresh = h.store.refresh();
        await settle();
        h.store.setEnabled(true);
        await h.store.waitForPendingWrites();
        read.release();
        await refresh;
        await settle();
        assert.equal(h.store.playsThemeMusic, true);
    } finally { h.store.stop(); }
});

class FakeAudio {
    src = "";
    volume = 1;
    loop = false;
    preload = "";
    currentTime = 0;
    paused = true;
    loads = 0;
    rejection: DOMException | undefined;
    private readonly listeners = new Map<string, Set<() => void>>();
    addEventListener(name: string, listener: () => void): void { (this.listeners.get(name) ?? this.listeners.set(name, new Set()).get(name))?.add(listener); }
    removeEventListener(name: string, listener: () => void): void { this.listeners.get(name)?.delete(listener); }
    fire(name: string): void { for (const listener of [...(this.listeners.get(name) ?? [])]) listener(); }
    listenerCount(): number { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
    play(): Promise<void> { if (this.rejection !== undefined) return Promise.reject(this.rejection); this.paused = false; return Promise.resolve(); }
    pause(): void { this.paused = true; }
    removeAttribute(name: string): void { if (name === "src") this.src = ""; }
    load(): void { this.loads++; }
}

const audioOf = (audio: FakeAudio): ConstructorParameters<typeof ElementThemeOutput>[1] => audio as unknown as ConstructorParameters<typeof ElementThemeOutput>[1];

test("the audio element loads the grant silently, reports progress once, and ends and fails through the callbacks", () => {
    const audio = new FakeAudio();
    const output = new ElementThemeOutput({ url: "https://tv.invalid/a", converted: false }, audioOf(audio));
    assert.equal(audio.src, "https://tv.invalid/a");
    assert.equal(audio.volume, 0);
    let progress = 0; let ended = 0; let failed = 0;
    output.onProgress = () => progress++;
    output.onEnded = () => ended++;
    output.onFailed = () => failed++;
    audio.fire("timeupdate");
    assert.equal(progress, 0, "no progress at time zero");
    audio.currentTime = 0.4;
    audio.fire("timeupdate");
    audio.fire("timeupdate");
    audio.fire("ended");
    audio.fire("error");
    assert.deepEqual([progress, ended, failed], [1, 1, 1]);
    output.loops = true;
    assert.equal(audio.loop, true);
    output.volume = 2;
    assert.equal(audio.volume, 1);
});

test("tearing down drops the source and reloads the element so AVPlay can take the decoder", async () => {
    const audio = new FakeAudio();
    const output = new ElementThemeOutput({ url: "https://tv.invalid/a", converted: false }, audioOf(audio));
    output.play();
    await settle();
    assert.equal(output.playing, true);
    assert.equal(audio.paused, false);
    let ended = 0;
    output.onEnded = () => ended++;
    output.tearDown();
    assert.equal(output.playing, false);
    assert.equal(audio.paused, true);
    assert.equal(audio.src, "");
    assert.equal(audio.loads, 1);
    assert.equal(audio.listenerCount(), 0);
    audio.fire("ended");
    assert.equal(ended, 0, "a torn-down output stays silent");
    output.play();
    assert.equal(output.playing, false, "and cannot be restarted");
});

test("a play() the platform refuses for a decode error reports failure; an aborted one does not", async () => {
    const audio = new FakeAudio();
    const output = new ElementThemeOutput({ url: "https://tv.invalid/a", converted: false }, audioOf(audio));
    let failed = 0;
    output.onFailed = () => failed++;
    audio.rejection = new DOMException("interrupted", "AbortError");
    output.play();
    await settle();
    assert.equal(failed, 0);
    audio.rejection = new DOMException("not supported", "NotSupportedError");
    output.play();
    await settle();
    assert.equal(failed, 1);
});
