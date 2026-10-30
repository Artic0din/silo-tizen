import assert from "node:assert/strict";
import { test } from "node:test";
import { operations } from "../../src/api/operations.ts";
import { AUDIO_KEY, HIDDEN_KEY, SETTINGS_KEYS, decodeEffectiveSettings, decodeExplicitSettings, decodeSettingsCapabilities, decodeSettingsContract, decodeSettingValue, numericLibraryId, type SettingsKey } from "../../src/contracts/v2/settings.ts";
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

test("quality/cap lost write answers and failed readback reconcile on Retry without duplicate mutation", async () => {
    for (const [key, value] of [[QUALITY, "720p"], [BITRATE, 6000]] as const) {
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

async function setup() {
    const harness = await connected();
    await signIn(harness);
    harness.fake.catalog = new FakeCatalog();
    const fake = new FakeSettings(harness.fake);
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
    assert.ok(fake.requests.some(request => request.path === operations.settingsValues(SETTINGS_KEYS).path));
    state.stop();
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
