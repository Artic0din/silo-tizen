import assert from "node:assert/strict";
import { test } from "node:test";
import { operations } from "../../src/api/operations.ts";
import { AUDIO_KEY, DOLBY_VISION_KEY, HDR_KEY, HIDDEN_KEY, SETTINGS_KEYS, decodeEffectiveSettings, decodeExplicitSettings, decodeSettingsCapabilities, decodeSettingsContract, decodeSettingValue, numericLibraryId, profileSettings, type SettingsKey } from "../../src/contracts/v2/settings.ts";
import { PlaybackController } from "../../src/player/controller.ts";
import { FakePlayback } from "./support/fakePlayback.ts";
import { FakeAVPlay } from "./support/fakeAVPlay.ts";
import { SettingsState } from "../../src/ui/settingsState.ts";
import { connected, signIn } from "./support/harness.ts";
import { FakeCatalog } from "./support/fakeCatalog.ts";
import { FakeSettings } from "./support/fakeSettings.ts";
import { fixture, problem } from "./support/fakeSilo.ts";

const QUALITY = "playback.preferred_quality" as SettingsKey;
const BITRATE = "playback.max_bitrate_kbps" as SettingsKey;
const SEEK_BACK = "player.video_skip_back_seconds" as SettingsKey;
const SEEK_FORWARD = "player.video_skip_forward_seconds" as SettingsKey;

test("device save leaves disagreeing profile intact and clear reveals profile", async () => {
    const { state, core, fakeSettings, fake } = await setup(true);
    const device = fakeSettings.device("p-owner", core.session.http.deviceId);
    fakeSettings.profile().set(QUALITY, "1080p");
    device.set(QUALITY, "480p");
    await state.load();
    assert.equal(state.effective.get(QUALITY)?.value, "480p");
    await state.save(QUALITY, "720p");
    assert.equal(device.get(QUALITY), "720p");
    assert.equal(fakeSettings.profile().get(QUALITY), "1080p");
    await state.reset(QUALITY);
    assert.equal(device.has(QUALITY), false);
    assert.equal(state.effective.get(QUALITY)?.value, "1080p");
    assert.deepEqual(fake.requests.filter(r => r.method === "PUT" || r.method === "DELETE").map(r => r.path), ["PUT", "DELETE"].map(() => `/settings/values/${QUALITY}?scope=profile_device`));
    state.stop();
});

test("video seek intervals are numeric enum members, never nullable or coerced", () => {
    for (const key of [SEEK_BACK, SEEK_FORWARD]) {
        for (const value of [5, 10, 15, 30, 45, 60, 90]) assert.equal(decodeSettingValue(key, value), value);
        for (const value of [null, undefined, "15", 15.5, 20, false, true]) assert.throws(() => decodeSettingValue(key, value), String(value));
    }
});

test("device null, unfamiliar audio and profile-only seek retain distinct semantics", async () => {
    const { state, core, fakeSettings, fake } = await setup(true);
    const device = fakeSettings.device("p-owner", core.session.http.deviceId);
    fakeSettings.profile().set(AUDIO_KEY, "fr");
    fakeSettings.profile().set(BITRATE, 6000);
    device.set(AUDIO_KEY, null);
    await state.load();
    assert.deepEqual(state.stored(AUDIO_KEY), { isSet: true, value: null, revision: 7 });
    await state.save(AUDIO_KEY, null);
    assert.equal(fake.requests.filter(r => r.method === "DELETE" || r.method === "PUT").length, 0);
    await state.save(AUDIO_KEY, "yue-Hant-HK");
    assert.equal(device.get(AUDIO_KEY), "yue-Hant-HK");
    await state.load();
    assert.equal(state.stored(AUDIO_KEY)?.isSet && device.get(AUDIO_KEY), "yue-Hant-HK");
    await state.save(AUDIO_KEY, null);
    assert.equal(device.has(AUDIO_KEY), false);
    assert.equal(state.effective.get(AUDIO_KEY)?.value, "fr");
    await state.save(BITRATE, null);
    assert.equal(device.has(BITRATE), true);
    assert.equal(device.get(BITRATE), null);
    assert.equal(state.effective.get(BITRATE)?.value, null);
    await state.reset(BITRATE);
    assert.equal(device.has(BITRATE), false);
    assert.equal(state.effective.get(BITRATE)?.value, 6000);
    for (const key of [SEEK_BACK, SEEK_FORWARD]) {
        await state.save(key, 45);
        assert.equal(fakeSettings.profile().get(key), 45);
        assert.equal(device.has(key), false);
        await state.reset(key);
        assert.equal(fakeSettings.profile().has(key), false);
    }
    assert.equal(fakeSettings.profile().get(AUDIO_KEY), "fr");
    assert.equal(fakeSettings.profile().get(BITRATE), 6000);
    state.stop();
});

test("device scope requires capability as well as definition and single-key effective reads remain supported", async () => {
    const { state, fake, fakeSettings } = await setup(true);
    fakeSettings.supportsBatchedEffective = false;
    await state.load();
    assert.equal(state.scope(QUALITY), "profile_device");
    await state.save(QUALITY, "720p");
    assert.equal(state.error, undefined);
    fake.script("/settings/contract/capabilities", { status: 200, body: {
        api_version: 1, revision: "opaque-24", manifest_revision: 24, state: "available", allowed: true,
        scopes: ["profile"], supports_batched_effective: false,
    } });
    await state.load();
    assert.equal(state.scope(QUALITY), "profile");
    await state.save(QUALITY, "1080p");
    assert.equal(fakeSettings.profile().get(QUALITY), "1080p");
    assert.equal(state.effective.get(QUALITY)?.value, "720p");
    assert.equal(fake.requests.filter(r => r.method === "PUT").length, 2);
    state.stop();
});

test("device uncertain committed write serializes activation, reads before retry, and fences replacement", async () => {
    const { state, core, fakeSettings, fake, clock } = await setup(true);
    const device = fakeSettings.device("p-owner", core.session.http.deviceId);
    fakeSettings.profile().set(QUALITY, "1080p");
    const path = operations.settingsValues([QUALITY], "profile_device").path;
    const hold = fake.hold(path);
    fake.dropNextAnswer(`/settings/values/${QUALITY}?scope=profile_device`);
    const saving = state.save(QUALITY, "720p");
    while (!fake.requests.some(r => r.path === path)) await new Promise<void>(resolve => setImmediate(resolve));
    await state.save(QUALITY, "2160p");
    fake.script(path, problem(429, "rate_limited", "Wait", { "Retry-After": "1" }));
    hold.release();
    await saving;
    assert.equal(device.get(QUALITY), "720p");
    assert.equal(state.canRetry, true);
    assert.ok(state.error);
    await state.retry();
    assert.equal(fake.requests.filter(r => r.method === "PUT").length, 1);
    await clock.advance(1000);
    await state.retry();
    assert.equal(state.error, undefined);
    assert.equal(fake.requests.filter(r => r.method === "PUT").length, 1);
    const late = fake.hold(`/settings/values/${QUALITY}?scope=profile_device`, true);
    const next = state.save(QUALITY, "480p");
    while (fake.requests.filter(r => r.method === "PUT").length < 2) await new Promise<void>(resolve => setImmediate(resolve));
    core.profiles.clear();
    late.release();
    await next;
    assert.equal(state.loaded, false);
    assert.equal(state.device.size, 0);
    assert.equal(state.explicit.size, 0);
    assert.equal(fakeSettings.profile().get(QUALITY), "1080p");
});

test("Settings confirmed seek writes and DELETE resets feed fresh real controller directions", async () => {
    const { state, fake, fakeSettings, core, clock } = await setup();
    const server = new FakePlayback(fake);
    const avplay = new FakeAVPlay();
    let serial = 0;
    const controller = new PlaybackController({ session: core.session, avplay, clock, randomBytes: bytes => bytes.fill(++serial), device: { model: "S95C", appVersion: "0.1.0" }, exits: { onBack() {}, onEnd() {}, onError(error) { assert.fail(error.kind); } } });
    let view: PlaybackViewForSeek | undefined;
    controller.subscribe(next => { if (next.phase === "playing" || next.phase === "paused") view = next; });
    try {
        await state.save(SEEK_BACK, 15);
        await state.save(SEEK_FORWARD, 45);
        assert.equal(fakeSettings.profile().get(SEEK_BACK), 15);
        assert.equal(fakeSettings.profile().get(SEEK_FORWARD), 45);
        for (const [backward, forward] of [[15, 45], [10, 45], [10, 30]] as const) {
            if (backward === 10) await state.reset(SEEK_BACK);
            if (forward === 30) await state.reset(SEEK_FORWARD);
            controller.play({ contentId: "movie-1", fileId: "42", title: "Synthetic movie", startSeconds: 100 });
            await clock.advance(0);
            avplay.finishPrepare();
            avplay.finishSeek();
            avplay.tick(100000);
            assert.deepEqual(view?.seekIntervals, { backward, forward });
            controller.seekBy(-backward);
            assert.equal(avplay.calls[avplay.calls.length - 1], `seekTo ${(100 - backward) * 1000}`);
            avplay.finishSeek();
            avplay.tick(100000);
            controller.seekBy(forward);
            assert.equal(avplay.calls[avplay.calls.length - 1], `seekTo ${(100 + forward) * 1000}`);
            avplay.finishSeek();
            controller.back();
            await clock.advance(0);
        }
        assert.equal(server.sessions.size, 3);
        const writes = fake.requests.filter(r => r.path.startsWith("/settings/values/") && (r.method === "PUT" || r.method === "DELETE"));
        assert.deepEqual(writes.map(r => r.method), ["PUT", "PUT", "DELETE", "DELETE"]);
        assert.deepEqual(writes.slice(0, 2).map(r => r.body), [{ value: 15 }, { value: 45 }]);
    } finally { controller.destroy(); state.stop(); }
});

type PlaybackViewForSeek = { readonly seekIntervals?: { readonly backward: number; readonly forward: number } };

test("unsupported seek definitions never expose profile edits or request their values", async () => {
    for (const mode of ["revision8", "missing", "profile_client", "denied"] as const) {
        const { state, fake, fakeSettings } = await setup();
        if (mode === "revision8") fakeSettings.revision = 8;
        if (mode === "denied") fakeSettings.allowed = false;
        const contract = fixture("settings_contract_ok");
        assert.ok(Array.isArray(contract.definitions));
        contract.definitions = contract.definitions.flatMap(def => def.key !== SEEK_FORWARD ? [def] : mode === "missing" ? [] : mode === "profile_client" ? [{ ...def, allowed_scopes: ["profile_client"] }] : [def]);
        fake.script("/settings/contract", { status: 200, body: contract });
        const count = fake.requests.length;
        await state.load();
        assert.ok(!state.definitions.some(def => def.key === SEEK_BACK || def.key === SEEK_FORWARD));
        await state.save(SEEK_BACK, 15);
        await state.save(SEEK_FORWARD, 45);
        assert.equal(fake.requests.slice(count).filter(r => r.path.includes("player.video_skip")).length, 0, mode);
        state.stop();
    }
});

test("profile quality and bitrate are discovered from the supported manifest", () => {
    const keys = decodeSettingsContract(fixture("settings_contract_ok")).definitions.filter(def => def.profile).map(def => def.key);
    assert.ok(keys.includes(QUALITY), "preferred quality must be a supported profile control");
    assert.ok(keys.includes(BITRATE), "maximum bitrate must be a supported profile control");
});

test("quality reads preserve legacy strings and bitrate rejects coercion, missing values and invalid bounds", () => {
    for (const value of ["auto", "480p", "720p", "1080p", "2160p", "original", "future-quality"]) assert.equal(decodeSettingValue(QUALITY, value), value);
    for (const value of [null, 100, 6000, 200000]) assert.equal(decodeSettingValue(BITRATE, value), value);
    for (const value of [undefined, "", "100", 0, 99, 200001, 100.5, NaN, Infinity, false]) assert.throws(() => decodeSettingValue(BITRATE, value), String(value));
    for (const value of [null, "", " ", 720]) assert.throws(() => decodeSettingValue(QUALITY, value));
    assert.throws(() => decodeEffectiveSettings([BITRATE], { items: [{ key: BITRATE, source: "default", definition_revision: 24 }], revision: 24 }));
});

test("quality/cap discovery excludes incompatible schemas, platform aliases and unsupported profile scopes", async () => {
    for (const key of [QUALITY, BITRATE]) {
        for (const change of [
            { platforms: ["tvOS"] }, { platforms: ["tv"] }, { allowed_scopes: ["profile_device"] },
            { persistence: "client_local" }, { value_schema: { type: "string", nullable: true } }, { recommended_control: "unknown" },
        ]) {
            const contract = fixture("settings_contract_ok");
            assert.ok(Array.isArray(contract.definitions));
            contract.definitions = contract.definitions.map(def => def.key === key ? { ...def, ...change } : def);
            const supported = decodeSettingsContract(contract).definitions.filter(def => def.profile);
            assert.ok(!supported.some(def => def.key === key), JSON.stringify(change));
        }
    }
    const { state, fake } = await setup();
    const contract = fixture("settings_contract_ok");
    assert.ok(Array.isArray(contract.definitions));
    contract.definitions = contract.definitions.map(def => def.key === QUALITY || def.key === BITRATE ? { ...def, introduced_in: 25 } : def);
    fake.script("/settings/contract", { status: 200, body: contract });
    const count = fake.requests.length;
    await state.load();
    assert.equal(state.loaded, true);
    assert.ok(!state.definitions.some(def => def.key === QUALITY || def.key === BITRATE));
    assert.ok(fake.requests.slice(count).filter(r => r.path.startsWith("/settings/values")).every(r => !r.path.includes(QUALITY) && !r.path.includes(BITRATE)));
    state.stop();
});

test("PIN-authorised quality writes capture proof and ignore answers after profile replacement", async () => {
    const { state, core, fake, fakeSettings, clock } = await setup();
    state.stop();
    const profiles = await core.profiles.list();
    const kid = profiles.find(profile => profile.id === "p-kid");
    const owner = profiles.find(profile => profile.id === "p-owner");
    assert.ok(kid && owner);
    core.profiles.select(kid);
    assert.deepEqual(await core.profiles.verifyPin(kid.id, "2468"), { status: "verified" });
    const next = new SettingsState(core.session, () => undefined, clock);
    await next.load();
    const hold = fake.hold(`/settings/values/${QUALITY}`, true);
    const saving = next.save(QUALITY, "1080p");
    while (!fake.requests.some(r => r.method === "PUT")) await new Promise<void>(resolve => setImmediate(resolve));
    const write = fake.requests.find(r => r.method === "PUT");
    assert.equal(write?.headers["x-profile-id"], kid.id);
    assert.ok(write?.headers["x-profile-token"]);
    core.profiles.select(owner);
    hold.release();
    await saving;
    assert.equal(next.loaded, false);
    assert.equal(next.explicit.size, 0);
    assert.equal(next.effective.size, 0);
    assert.equal(fakeSettings.profile(kid.id).get(QUALITY), "1080p");
    assert.equal(fakeSettings.profile(owner.id).has(QUALITY), false);
    assert.equal(fake.requests.filter(r => r.method === "PUT").length, 1);
});

test("profile defaults keep explicit null/reset separate from device overrides and never rewrite legacy reads", async () => {
    const { state, fakeSettings, fake, core } = await setup();
    fakeSettings.profile().set(QUALITY, "original");
    fakeSettings.overrides.set(QUALITY, "480p");
    fakeSettings.overrides.set(BITRATE, 1500);
    await state.load();
    assert.equal(state.explicit.get(QUALITY)?.isSet, true);
    assert.equal(fake.requests.filter(r => r.method === "PUT").length, 0);
    await state.save(QUALITY, "2160p");
    await state.save(BITRATE, null);
    assert.deepEqual(state.explicit.get(BITRATE), { isSet: true, value: null, revision: 7 });
    assert.equal(state.effective.get(BITRATE)?.value, 1500);
    await state.reset(BITRATE);
    await state.reset(QUALITY);
    assert.equal(state.explicit.get(BITRATE)?.isSet, false);
    assert.equal(state.explicit.get(QUALITY)?.isSet, false);
    assert.equal(state.effective.get(QUALITY)?.source, "profile_device");
    assert.equal(fakeSettings.overrides.get(QUALITY), "480p");
    assert.equal(fakeSettings.overrides.get(BITRATE), 1500);
    const writes = fake.requests.filter(r => r.method === "PUT" || r.method === "DELETE");
    assert.equal(writes.length, 4);
    assert.deepEqual(writes.map(r => r.path), [QUALITY, BITRATE, BITRATE, QUALITY].map(key => `/settings/values/${key}?scope=profile`));
    for (const request of writes) {
        assert.equal(request.headers["x-profile-id"], core.session.activeProfile?.id);
        assert.ok(request.headers.authorization);
        assert.equal(request.headers["x-silo-device-id"], fake.requests.find(r => r.path === "/settings/contract/capabilities")?.headers["x-silo-device-id"]);
        assert.equal(request.headers["x-silo-client-family"], undefined);
    }
    state.stop();
});

test("quality/cap/seek lost write answers and failed readback reconcile on Retry without duplicate mutation", async () => {
    for (const [key, value] of [[QUALITY, "720p"], [BITRATE, 6000], [SEEK_BACK, 15], [SEEK_FORWARD, 45]] as const) {
        const { state, fake, clock } = await setup();
        fake.dropNextAnswer(`/settings/values/${key}?scope=profile`);
        const hold = fake.hold(operations.settingsValues([key]).path);
        const saving = state.save(key, value);
        while (!fake.requests.some(r => r.path === operations.settingsValues([key]).path)) await new Promise<void>(resolve => setImmediate(resolve));
        fake.script(operations.settingsValues([key]).path, problem(429, "rate_limited", "Wait", { "Retry-After": "1" }));
        hold.release();
        await saving;
        assert.ok(state.error);
        assert.equal(state.canRetry, true);
        assert.equal(fake.requests.filter(r => r.method === "PUT").length, 1);
        await clock.advance(1000);
        await state.retry();
        assert.equal(state.error, undefined);
        assert.deepEqual(state.explicit.get(key), { isSet: true, value, revision: 7 });
        assert.equal(fake.requests.filter(r => r.method === "PUT").length, 1);
        state.stop();
    }
});

test("seek resets reconcile lost DELETE replies and Retry reads before any repeated write", async () => {
    for (const key of [SEEK_BACK, SEEK_FORWARD]) {
        const { state, fake, fakeSettings, clock } = await setup();
        await state.save(key, 45);
        fake.dropNextAnswer(`/settings/values/${key}?scope=profile`);
        const hold = fake.hold(operations.settingsValues([key]).path);
        const resetting = state.reset(key);
        await clock.advance(0);
        fake.script(operations.settingsValues([key]).path, problem(429, "rate_limited", "Wait", { "Retry-After": "1" }));
        hold.release();
        await resetting;
        assert.ok(state.error);
        assert.equal(state.canRetry, true);
        assert.equal(fakeSettings.profile().has(key), false);
        assert.equal(fake.requests.filter(r => r.method === "DELETE").length, 1);
        const requests = fake.requests.length;
        await state.retry();
        assert.equal(fake.requests.length, requests, "Retry-After locks requests");
        await clock.advance(1000);
        await state.retry();
        assert.equal(state.error, undefined);
        assert.equal(state.explicit.get(key)?.isSet, false);
        assert.equal(state.effective.get(key)?.value, key === SEEK_BACK ? 10 : 30);
        assert.equal(fake.requests.filter(r => r.method === "DELETE").length, 1);
        state.stop();
    }
});

test("seek refusal preserves confirmed pair and profile replacement fences an old save", async () => {
    const { state, fake, fakeSettings, core, clock } = await setup();
    await state.save(SEEK_BACK, 15);
    await state.save(SEEK_FORWARD, 45);
    fake.script(`/settings/values/${SEEK_BACK}?scope=profile`, problem(422, "validation_failed", "Refused"));
    await state.save(SEEK_BACK, 60);
    assert.ok(state.error);
    assert.equal(state.effective.get(SEEK_BACK)?.value, 15);
    assert.equal(state.effective.get(SEEK_FORWARD)?.value, 45);
    await state.load();
    const hold = fake.hold(`/settings/values/${SEEK_FORWARD}?scope=profile`, true);
    const saving = state.save(SEEK_FORWARD, 60);
    await clock.advance(0);
    core.profiles.clear();
    hold.release();
    await saving;
    assert.equal(state.loaded, false);
    assert.equal(state.explicit.size, 0);
    assert.equal(state.effective.size, 0);
    assert.equal(fakeSettings.profile().get(SEEK_BACK), 15);
});

test("Settings confirmed profile writes feed every new real PlaybackController start", async () => {
    const { state, fake, fakeSettings, core, clock } = await setup();
    const server = new FakePlayback(fake);
    const avplay = new FakeAVPlay();
    let serial = 0;
    const controller = new PlaybackController({ session: core.session, avplay, clock, randomBytes: bytes => bytes.fill(++serial), device: { model: "S95C", appVersion: "0.1.0" }, exits: { onBack() {}, onEnd() {}, onError(error) { assert.fail(error.kind); } } });
    try {
        for (const [quality, cap] of [["720p", 4321], ["2160p", 200000], ["auto", null]] as const) {
            await state.save(QUALITY, quality);
            await state.save(BITRATE, cap);
            assert.equal(state.error, undefined);
            assert.equal(fakeSettings.profile().get(QUALITY), quality);
            assert.equal(state.effective.get(BITRATE)?.value, cap);
            controller.play({ contentId: "movie-1", fileId: "42", title: "Synthetic movie", startSeconds: 0 });
            await clock.advance(0);
            const starts = fake.requests.filter(r => r.path === "/playback/start");
            const request = starts[starts.length - 1];
            assert.equal(request?.body?.quality_preference, quality);
            assert.equal(request?.body?.bandwidth_cap_kbps, cap ?? undefined);
            assert.equal(Object.prototype.hasOwnProperty.call(request?.body ?? {}, "bandwidth_cap_kbps"), cap !== null);
            controller.back();
            await clock.advance(0);
        }
        assert.equal(server.sessions.size, 3);
    } finally { controller.destroy(); state.stop(); }
});

test("the hidden-library editor can request hidden libraries explicitly", () => {
    const request = Reflect.apply(operations.listUserLibraries, undefined, [true]);
    assert.equal(request.path, "/user/libraries?include_hidden=true");
    assert.equal(operations.listUserLibraries().path, "/user/libraries");
});

async function setup(deviceScope = false, hdrRows = false) {
    const harness = await connected();
    await signIn(harness);
    harness.fake.catalog = new FakeCatalog();
    const fake = new FakeSettings(harness.fake);
    fake.devicePlayback = deviceScope;
    fake.hdrRows = hdrRows;
    const profile = (await harness.core.profiles.list())[0];
    assert.ok(profile);
    harness.core.profiles.select(profile);
    const state = new SettingsState(harness.core.session, () => undefined, harness.clock);
    await state.load();
    return { ...harness, fakeSettings: fake, state };
}

test("settings boundaries retain unfamiliar language tags and reject unsafe library IDs", () => {
    for (const value of [null, "en-AU", "x-silo-original", "yue-Hant-HK", "de-CH-1901"]) assert.equal(decodeSettingValue(AUDIO_KEY, value), value);
    for (const value of ["", "English", "original", "English language", "en_US", "de-1901-1901", "en-u-ca-gregory-u-nu-latn", [], false]) assert.throws(() => decodeSettingValue(AUDIO_KEY, value));
    for (const value of [["12"], [0], [-1], [12, 12], [1.1], [Number.MAX_SAFE_INTEGER + 1]]) assert.throws(() => decodeSettingValue(HIDDEN_KEY, value));
    assert.equal(numericLibraryId("12"), 12);
    for (const id of ["12x", "0", "01", "1e2", "9007199254740993"]) assert.throws(() => numericLibraryId(id));
});

test("profile null is explicit, reset removes only the profile row, effective override remains", async () => {
    const { state, fakeSettings, core, fake } = await setup();
    fakeSettings.overrides.set(AUDIO_KEY, "fr");
    await state.load();
    assert.equal(state.explicit.get(AUDIO_KEY)?.isSet, false);
    assert.equal(state.effective.get(AUDIO_KEY)?.value, "fr");
    await state.save(AUDIO_KEY, null);
    assert.deepEqual(state.explicit.get(AUDIO_KEY), { isSet: true, value: null, revision: 7 });
    assert.equal(state.effective.get(AUDIO_KEY)?.value, "fr");
    await state.reset(AUDIO_KEY);
    assert.equal(state.explicit.get(AUDIO_KEY)?.isSet, false);
    assert.equal(state.effective.get(AUDIO_KEY)?.source, "profile_device");
    assert.equal(fakeSettings.overrides.get(AUDIO_KEY), "fr");
    const put = fake.requests.find(request => request.method === "PUT");
    assert.deepEqual(put?.body, { value: null });
    assert.equal(put?.headers["x-profile-id"], core.session.activeProfile?.id);
    assert.equal(put?.headers["x-silo-client-family"], undefined);
    assert.ok(fake.requests.some(request => request.path === operations.settingsValues(SETTINGS_KEYS.filter(key => state.definitions.some(def => def.key === key))).path));
    state.stop();
});

test("already-achieved metadata edits invalidate catalogs without another write", async () => {
    for (const reset of [false, true]) {
        const { state, fakeSettings, fake } = await setup();
        fakeSettings.remainingRows = true;
        fakeSettings.profile().set("catalog.metadata_language", "en");
        await state.load();
        if (reset) fakeSettings.profile().delete("catalog.metadata_language");
        else fakeSettings.profile().set("catalog.metadata_language", "fr");
        if (reset) await state.reset("catalog.metadata_language");
        else await state.save("catalog.metadata_language", "fr");
        assert.equal(state.error, undefined);
        assert.equal(fake.requests.filter(request => request.method === "PUT" || request.method === "DELETE").length, 0);
        assert.equal(state.hiddenChanged, true);
        state.stop();
    }
});

test("hidden edits rebase on explicit scope, preserve inaccessible IDs and serialize edits", async () => {
    const { state, fakeSettings, fake } = await setup();
    fakeSettings.profile().set(HIDDEN_KEY, [15, 999]);
    await state.load();
    fakeSettings.profile().set(HIDDEN_KEY, [15, 999, 888]);
    const hold = fake.hold(`/settings/values/${HIDDEN_KEY}`);
    const saving = state.setHidden("12", true);
    await new Promise<void>(resolve => setImmediate(resolve));
    await state.save(AUDIO_KEY, "en");
    assert.equal(fake.requests.filter(request => request.method === "PUT").length, 1);
    hold.release();
    await saving;
    assert.deepEqual(fakeSettings.profile().get(HIDDEN_KEY), [15, 999, 888, 12]);
    assert.equal(state.hiddenChanged, true);
    assert.ok(fake.requests.some(request => request.path === "/user/libraries?include_hidden=true"));
    state.stop();
});

test("a lost PUT/DELETE answer reconciles the explicit scope without a second write", async () => {
    const { state, fake, fakeSettings } = await setup();
    const path = `/settings/values/${AUDIO_KEY}?scope=profile`;
    fake.dropNextAnswer(path);
    await state.save(AUDIO_KEY, "en-AU");
    assert.equal(state.error, undefined);
    assert.equal(fakeSettings.profile().get(AUDIO_KEY), "en-AU");
    fake.dropNextAnswer(path);
    await state.reset(AUDIO_KEY);
    assert.equal(state.error, undefined);
    assert.equal(state.explicit.get(AUDIO_KEY)?.isSet, false);
    assert.equal(fake.requests.filter(request => request.method === "PUT").length, 1);
    assert.equal(fake.requests.filter(request => request.method === "DELETE").length, 1);
    state.stop();
});

test("refusals retain confirmed values, constraints stay visible and authority clears old data", async () => {
    const { state, fake, fakeSettings, core } = await setup();
    fakeSettings.profile().set(AUDIO_KEY, "en-AU");
    fakeSettings.constrained = true;
    await state.load();
    fake.script(`/settings/values/${AUDIO_KEY}?scope=profile`, problem(422, "validation_failed", "Invalid value"));
    await state.save(AUDIO_KEY, "fr");
    assert.ok(state.error);
    assert.equal(state.canRetry, false);
    assert.equal(state.effective.get(AUDIO_KEY)?.constrained, true);
    const stored = state.explicit.get(AUDIO_KEY);
    assert.equal(stored?.isSet && stored.value, "en-AU");
    core.profiles.clear();
    assert.equal(state.explicit.size, 0);
    assert.equal(state.libraries.length, 0);
    await state.save(AUDIO_KEY, "de");
    assert.equal(fake.requests.filter(request => request.method === "PUT").length, 1);
});

test("retry reconciles a committed write whose readback failed before sending anything else", async () => {
    const { state, fake, clock } = await setup();
    const hold = fake.hold(`/settings/values/${AUDIO_KEY}`);
    const saving = state.save(AUDIO_KEY, "en-AU");
    while (!fake.requests.some(request => request.method === "PUT")) await new Promise<void>(resolve => setImmediate(resolve));
    fake.script(operations.settingsValues([AUDIO_KEY]).path, problem(429, "rate_limited", "Wait", { "Retry-After": "5" }));
    hold.release();
    await saving;
    assert.ok(state.error?.includes("5 seconds"));
    assert.equal(state.canRetry, true);
    const count = fake.requests.length;
    await clock.advance(5000);
    await state.save(HIDDEN_KEY, null);
    assert.equal(fake.requests.length, count, "another setting waits for the uncertain edit to reconcile");
    fake.script(operations.settingsValues([AUDIO_KEY]).path, problem(429, "rate_limited", "Wait", { "Retry-After": "5" }));
    await state.retry();
    const delayed = fake.requests.length;
    await state.retry();
    assert.equal(fake.requests.length, delayed, "Retry-After prevents early requests");
    await clock.advance(5000);
    await state.retry();
    assert.equal(state.error, undefined);
    assert.equal(fake.requests.filter(request => request.method === "PUT").length, 1);
    state.stop();
});

test("late profile answers are discarded, and unsupported discovery never fetches values", async () => {
    const { state, fake, core, fakeSettings } = await setup();
    const hold = fake.hold("/settings/values", true);
    const loading = state.load();
    while (!state.busy) await new Promise<void>(resolve => setImmediate(resolve));
    core.profiles.clear();
    hold.release();
    await loading;
    assert.equal(state.loaded, false);
    assert.equal(state.explicit.size, 0);
    assert.equal(state.definitions.length, 0);
    const profile = (await core.profiles.list())[0];
    assert.ok(profile);
    core.profiles.select(profile);
    fakeSettings.allowed = false;
    const next = new SettingsState(core.session, () => undefined);
    const count = fake.requests.length;
    await next.load();
    assert.ok(next.error);
    assert.deepEqual(fake.requests.slice(count).map(request => request.path), ["/settings/contract/capabilities"]);
    next.stop();
});

test("HDR stays a device boolean and Dolby Vision is never read or written", async () => {
    const { state, fakeSettings, core, fake } = await setup(true, true);
    assert.equal(state.definitions.some(def => def.key === HDR_KEY && def.device && !def.profile), true);
    assert.equal(state.definitions.some(def => (def.key as string) === DOLBY_VISION_KEY), false);
    assert.equal(state.effective.get(HDR_KEY)?.value, true);
    assert.equal(state.scope(HDR_KEY), "profile_device");
    const profileReads = fake.requests.filter(request => {
        const scope = new URL(request.path, "https://fake.invalid").searchParams.get("scope");
        return request.path.startsWith("/settings/values?") && scope === "profile";
    });
    assert.equal(profileReads.some(request => request.path.includes(HDR_KEY)), false);
    const device = fakeSettings.device("p-owner", core.session.http.deviceId);
    await state.save(HDR_KEY, false);
    assert.equal(device.get(HDR_KEY), false);
    assert.equal(fakeSettings.profile().has(HDR_KEY), false);
    assert.equal([...device.keys()].join(" ").includes(DOLBY_VISION_KEY), false);
    assert.equal(state.effective.get(HDR_KEY)?.value, false);
    assert.equal(fake.requests.some(request => request.path.includes(DOLBY_VISION_KEY)), false);
    assert.equal(fake.requests.filter(request => request.method === "PUT").every(request => request.path.endsWith("?scope=profile_device")), true);
    state.stop();
});

function hdrDefinition(extra: Record<string, unknown> = {}) {
    const contract = structuredClone(fixture("settings_contract_ok"));
    const definition = {
        key: HDR_KEY, introduced_in: 1, persistence: "remote", allowed_scopes: ["profile_device"], resolution_order: ["profile_device", "default"],
        value_schema: { type: "boolean" }, default_value: true, platforms: ["ios", "tvos", "macos", "android", "android_tv"], recommended_control: "switch", ...extra,
    };
    return { ...contract, definitions: [...(contract.definitions as object[]), definition] };
}

test("the HDR definition is device-only and a mismatched contract hides it", () => {
    assert.equal(decodeSettingValue(HDR_KEY, true), true);
    const withDolby = hdrDefinition();
    (withDolby.definitions as object[]).push({ ...(withDolby.definitions as object[]).at(-1), key: DOLBY_VISION_KEY });
    assert.equal(decodeSettingsContract(withDolby).definitions.some(def => (def.key as string) === DOLBY_VISION_KEY), false);
    for (const value of [null, "true", 1]) assert.throws(() => decodeSettingValue(HDR_KEY, value), String(value));
    const accepted = decodeSettingsContract(hdrDefinition());
    assert.equal(accepted.definitions.some(def => def.key === HDR_KEY && def.device && !def.profile), true);
    const offered = decodeSettingsCapabilities({ api_version: 1, revision: "opaque", manifest_revision: 24, state: "available", allowed: true, scopes: ["profile", "profile_device"] });
    assert.equal(profileSettings(accepted, offered).some(def => def.key === HDR_KEY), true);
    const profileOnly = decodeSettingsCapabilities({ api_version: 1, revision: "opaque", manifest_revision: 24, state: "available", allowed: true, scopes: ["profile"] });
    assert.equal(profileSettings(accepted, profileOnly).some(def => def.key === HDR_KEY), false);
    for (const extra of [{ default_value: false }, { allowed_scopes: ["profile"] }, { value_schema: { type: "boolean", nullable: true } }, { recommended_control: "select" }]) {
        assert.equal(decodeSettingsContract(hdrDefinition(extra)).definitions.some(def => def.key === HDR_KEY), false, JSON.stringify(extra));
    }
    assert.throws(() => decodeSettingsContract({ ...hdrDefinition(), definitions: [...hdrDefinition().definitions as object[], hdrDefinition().definitions.at(-1)] }));
});

test("settings expose typed discovery, explicit/effective reads, nullable writes and reset", () => {
    for (const operation of ["settingsCapabilities", "settingsContract", "settingsValues", "effectiveSettings", "putSetting", "deleteSetting"]) {
        assert.ok(operation in operations, `missing native operation: ${operation}`);
    }
});

test("decoders retain policy metadata, require all requested rows and use opaque capability revision", () => {
    const capability = decodeSettingsCapabilities({ api_version: 1, revision: "opaque", manifest_revision: 24, state: "available", allowed: true, scopes: ["profile"] });
    assert.equal(capability.revision, "opaque");
    assert.equal(capability.manifestRevision, 24);
    assert.throws(() => decodeSettingsCapabilities({ ...capability, api_version: 1, revision: 24 }));
    const contract = decodeSettingsContract(fixture("settings_contract_ok"));
    assert.equal(contract.definitions.find(def => def.key === AUDIO_KEY)?.options.find(option => option.value === "fr-CA")?.introducedIn, 8);
    const raw = { key: AUDIO_KEY, value: "en", source: "profile_device", definition_revision: 24, constrained: true, requested_value: "fr", stored_value: "fr", permitted_values: [null, "en"], suggested_values: ["en", "fr"] };
    const effective = decodeEffectiveSettings([AUDIO_KEY], { items: [raw], revision: 24 }).get(AUDIO_KEY);
    assert.deepEqual(effective?.permittedValues, [null, "en"]);
    assert.equal(effective?.requestedValue, "fr");
    assert.equal(effective?.storedValue, "fr");
    assert.equal(effective?.source, "profile_device");
    assert.throws(() => decodeEffectiveSettings(SETTINGS_KEYS, { items: [raw], revision: 24 }));
    assert.throws(() => decodeExplicitSettings([AUDIO_KEY], { items: [], revision: 24 }));
    assert.throws(() => decodeExplicitSettings([AUDIO_KEY], { items: [{ key: AUDIO_KEY, scope: "profile", is_set: true }], revision: 24 }));
});
