import assert from "node:assert/strict";
import { test } from "node:test";
import { operations } from "../../src/api/operations.ts";
import { decodeSettingValue, decodeSettingsContract, type SettingsKey } from "../../src/contracts/v2/settings.ts";
import { SettingsState } from "../../src/ui/settingsState.ts";
import { connected, signIn } from "./support/harness.ts";
import { FakeCatalog } from "./support/fakeCatalog.ts";
import { FakeSettings } from "./support/fakeSettings.ts";
import { fixture, problem } from "./support/fakeSilo.ts";
import { object } from "../../src/contracts/v2/wire.ts";
import { decodeItemDetail } from "../../src/contracts/v2/catalog.ts";
import { DetailsState } from "../../src/ui/detailsState.ts";

const TITLE = "ui.title_art" as SettingsKey;
async function setup() {
    const h = await connected();
    await signIn(h);
    h.fake.catalog = new FakeCatalog();
    const settings = new FakeSettings(h.fake);
    const profile = (await h.core.profiles.list())[0];
    assert.ok(profile);
    h.core.profiles.select(profile);
    const state = new SettingsState(h.core.session, () => undefined, h.clock);
    await state.load();
    return { ...h, settings, state };
}

test("title art adopts only the known advisory-platform boolean definition", () => {
    assert.ok(decodeSettingsContract(fixture("settings_contract_ok")).definitions.some(def => def.key === TITLE && def.profile));
    for (const value of [true, false]) assert.equal(decodeSettingValue(TITLE, value), value);
    for (const value of [null, undefined, 0, 1, "true", "false", {}]) assert.throws(() => decodeSettingValue(TITLE, value));
});

test("title-art definitions reject incompatible schemas, scopes and resolution without relaxing other platforms", () => {
    for (const change of [
        { persistence: "local" }, { introduced_in: 15 }, { default_value: false }, { recommended_control: "select" },
        { value_schema: { type: "boolean", nullable: true } }, { value_schema: { type: "string" } },
        { allowed_scopes: ["profile", "device"] }, { allowed_scopes: ["profile"] },
        { resolution_order: ["profile_device", "profile", "default"] },
    ]) {
        const contract = fixture("settings_contract_ok");
        assert.ok(Array.isArray(contract.definitions));
        contract.definitions = contract.definitions.map(raw => { const def = object(raw, "definition"); return def.key === TITLE ? { ...def, ...change } : def; });
        assert.ok(!decodeSettingsContract(contract).definitions.some(def => def.key === TITLE), JSON.stringify(change));
    }
    const contract = fixture("settings_contract_ok");
    assert.ok(Array.isArray(contract.definitions));
    const title = contract.definitions.find(raw => object(raw, "definition").key === TITLE);
    assert.ok(title);
    contract.definitions.push(title);
    assert.throws(() => decodeSettingsContract(contract));
    contract.definitions[contract.definitions.length - 1] = { ...object(title, "definition"), value_schema: { type: "string" } };
    assert.throws(() => decodeSettingsContract(contract), "a malformed duplicate cannot disappear during compatibility filtering");
});

test("title-art scoped writes retain the selected profile PIN proof and stable device identity", async () => {
    const { core, fake, state, clock } = await setup();
    state.stop();
    const profile = (await core.profiles.list()).find(profile => profile.id === "p-kid");
    assert.ok(profile);
    core.profiles.select(profile);
    assert.deepEqual(await core.profiles.verifyPin(profile.id, "2468"), { status: "verified" });
    const next = new SettingsState(core.session, () => undefined, clock);
    try {
        await next.load();
        await next.save(TITLE, false);
        await next.setTitleArtScope(true);
        const requests = fake.requests.filter(r => r.method === "PUT");
        assert.equal(requests.length, 2);
        const device = requests[0]?.headers["x-silo-device-id"];
        for (const request of requests) {
            assert.equal(request.headers["x-profile-id"], profile.id);
            assert.ok(request.headers["x-profile-token"]);
            assert.equal(request.headers["x-silo-device-id"], device);
            assert.deepEqual(request.body, { value: false });
        }
    } finally { next.stop(); }
});

test("title-art boundaries reject wrong identities, key, scope, revisions and non-booleans; default false is valid", () => {
    const identity = { profileId: "p-owner", deviceId: "tv-a", manifestRevision: 24 };
    const row = { key: TITLE, scope: "profile_device", profile_id: "p-owner", device_id: "tv-a", is_set: true, value: false, revision: 8 };
    const explicit = operations.settingsValues([TITLE], "profile_device", identity);
    for (const change of [{ scope: "device" }, { profile_id: "p-other" }, { device_id: "tv-b" }, { key: "ui.other" }, { revision: 0 }, { value: null }, { value: "false" }, { client_family: "tv" }]) {
        assert.throws(() => explicit.decode({ revision: 24, items: [{ ...row, ...change }] }), JSON.stringify(change));
    }
    assert.throws(() => explicit.decode({ revision: 23, items: [row] }));
    assert.throws(() => explicit.decode({ revision: 24, items: [row, row] }));
    assert.deepEqual(explicit.decode({ revision: 24, items: [row] }).get(TITLE), { isSet: true, value: false, revision: 8 });
    const effective = operations.effectiveSettings([TITLE], identity);
    const resolved = { key: TITLE, value: false, source: "default", definition_revision: 16 };
    assert.equal(effective.decode({ revision: 24, items: [resolved] }).get(TITLE)?.value, false);
    const context = { profile_id: "p-owner", device_id: "tv-a" };
    assert.equal(effective.decode({ revision: 24, items: [{ ...row, source: "profile_device", definition_revision: 16, source_context: context }] }).get(TITLE)?.value, false);
    for (const change of [{ profile_id: "p-other" }, { device_id: "tv-b" }]) assert.throws(() => effective.decode({ revision: 24, items: [{ ...row, source: "profile_device", definition_revision: 16, source_context: { ...context, ...change } }] }));
    for (const change of [{ source: "device" }, { value: null }, { value: "false" }, { definition_revision: 15 }, { definition_revision: 25 }, { profile_id: "p-owner" }]) {
        assert.throws(() => effective.decode({ revision: 24, items: [{ ...resolved, ...change }] }));
    }
    for (const change of [{ profile_id: "p-other" }, { device_id: "tv-b" }, { scope: "profile" }]) {
        assert.throws(() => effective.decode({ revision: 24, items: [{ ...row, source: "profile_device", definition_revision: 16, ...change }] }));
    }
    assert.throws(() => operations.putSetting(TITLE, false, "profile_device", identity, 8).decode(row));
    assert.equal(operations.putSetting(TITLE, false, "profile_device", identity, 7).decode(row).revision, 8);
});

test("an incompatible supported definition leaves a reachable reload instead of silently hiding title-art support", async () => {
    const { fake, state } = await setup();
    try {
        const contract = fixture("settings_contract_ok");
        assert.ok(Array.isArray(contract.definitions));
        contract.definitions = contract.definitions.filter(raw => object(raw, "definition").key !== TITLE);
        fake.script("/settings/contract", { status: 200, body: contract });
        await state.load();
        assert.equal(state.loaded, true, "other supported controls remain usable");
        assert.ok(state.error);
        assert.equal(state.canRetry, false, "reload rather than repeat a mutation");
        await state.retry();
        assert.equal(state.error, undefined);
        assert.equal(state.effective.get(TITLE)?.value, true);
    } finally { state.stop(); }
});

test("synthetic title-art resolution separates profiles and devices and gives profile rows precedence", async () => {
    const { fake, settings, state } = await setup();
    try {
        settings.titleDefault = false;
        settings.device("p-owner", "tv-a").set(TITLE, true);
        settings.device("p-owner", "tv-b").set(TITLE, false);
        settings.device("p-other", "tv-a").set(TITLE, false);
        const read = (profile: string, device: string) => {
            const reply = fake.catalog?.route("GET", `/settings/values/effective?keys=${TITLE}`, profile, undefined, { "x-silo-device-id": device });
            assert.ok(reply);
            return operations.effectiveSettings([TITLE], { profileId: profile, deviceId: device }).decode(reply.body).get(TITLE);
        };
        assert.equal(read("p-owner", "tv-a")?.value, true);
        assert.equal(read("p-owner", "tv-b")?.value, false);
        settings.profile().set(TITLE, true);
        assert.equal(read("p-owner", "tv-b")?.source, "profile");
        assert.equal(read("p-owner", "tv-b")?.value, true);
        assert.equal(read("p-other", "tv-a")?.value, false);
        settings.profile().delete(TITLE);
        assert.equal(read("p-owner", "tv-b")?.value, false);
        await state.load();
        assert.equal(state.effective.get(TITLE)?.value, false);
        assert.equal(state.effective.get(TITLE)?.source, "default");
    } finally { state.stop(); }
});

for (const status of [403, 422, 429]) test(`first title-art PUT refusal ${status} prevents profile DELETE`, async () => {
    const { fake, settings, state, clock } = await setup();
    try {
        settings.profile().set(TITLE, true);
        await state.load();
        fake.script(`/settings/values/${TITLE}?scope=profile_device`, problem(status, "refused", "Refused", { "Retry-After": "1" }));
        await state.setTitleArtScope(false);
        assert.ok(state.error);
        assert.equal(fake.requests.filter(r => r.method === "DELETE").length, 0);
        assert.equal(settings.profile().get(TITLE), true);
        if (status === 429) {
            const count = fake.requests.length;
            await state.retry();
            assert.equal(fake.requests.length, count);
            await clock.advance(1000);
            await state.retry();
            assert.equal(state.error, undefined);
            assert.equal(settings.profile().has(TITLE), false);
        }
    } finally { state.stop(); }
});

test("partial DELETE failure stays incomplete; Retry reads both scopes and skips the committed device PUT", async () => {
    const { fake, settings, state } = await setup();
    try {
        settings.profile().set(TITLE, false);
        await state.load();
        fake.script(`/settings/values/${TITLE}?scope=profile`, problem(500, "failed", "Failed"));
        await state.setTitleArtScope(false);
        assert.ok(state.error);
        assert.equal(state.canRetry, true);
        assert.equal(state.effective.get(TITLE)?.source, "profile");
        const count = fake.requests.length;
        await state.retry();
        assert.equal(state.error, undefined);
        const retried = fake.requests.slice(count);
        const mutation = retried.findIndex(r => r.method === "DELETE");
        assert.ok(mutation > 0);
        assert.ok(retried.slice(0, mutation).some(r => r.path.includes("scope=profile_device")));
        assert.ok(retried.slice(0, mutation).some(r => r.path.includes("scope=profile&")));
        assert.ok(retried.slice(0, mutation).some(r => r.path.includes("/effective?")));
        assert.equal(fake.requests.filter(r => r.method === "PUT").length, 1);
        assert.equal(fake.requests.filter(r => r.method === "DELETE").length, 2);
        assert.equal(settings.profile().has(TITLE), false);
    } finally { state.stop(); }
});

const titleReads = [
    `GET /settings/values?scope=profile&keys=${TITLE}`,
    `GET /settings/values/effective?keys=${TITLE}`,
    `GET /settings/values?scope=profile_device&keys=${TITLE}`,
];

test("S-TA1: an effective newer profile choice contradicting the explicit read prevents DELETE", async () => {
    const { fake, settings, state } = await setup();
    try {
        settings.profile().set(TITLE, true);
        await state.load();
        const catalog = fake.catalog;
        assert.ok(catalog);
        let pinned = false;
        let interleaved = false;
        fake.catalog = { route: (method, path, profile, body, headers) => {
            const reply = catalog.route(method, path, profile, body, headers);
            if (method === "PUT" && path === `/settings/values/${TITLE}?scope=profile_device`) pinned = true;
            if (pinned && !interleaved && method === "GET" && path === `/settings/values?scope=profile&keys=${TITLE}`) {
                assert.deepEqual(operations.settingsValues([TITLE]).decode(reply?.body).get(TITLE), { isSet: true, value: true, revision: 7 });
                settings.profile().set(TITLE, false);
                settings.rowRevisions.set(JSON.stringify(["p-owner", "profile", undefined, TITLE]), 9);
                interleaved = true;
            }
            return reply;
        } };
        const count = fake.requests.length;
        await state.setTitleArtScope(false);
        assert.equal(interleaved, true);
        assert.equal(fake.requests.filter(r => r.method === "DELETE").length, 0, "must not DELETE an already observed newer profile choice");
        assert.deepEqual(fake.requests.slice(count).map(r => `${r.method} ${r.path}`), [
            ...titleReads, `PUT /settings/values/${TITLE}?scope=profile_device`, ...titleReads,
        ]);
        assert.equal(settings.profile().get(TITLE), false);
        assert.equal(settings.rowRevisions.get(JSON.stringify(["p-owner", "profile", undefined, TITLE])), 9);
        assert.equal(state.effective.get(TITLE)?.value, false);
        assert.equal(state.effective.get(TITLE)?.source, "profile");
        assert.match(state.error ?? "", /changed on another device.*Reload settings/);
        assert.equal(state.canRetry, false, "existing recovery reloads rather than resuming the stale plan");
        await state.retry();
        assert.equal(state.error, undefined);
        assert.deepEqual(state.explicit.get(TITLE), { isSet: true, value: false, revision: 9 });
        assert.equal(state.effective.get(TITLE)?.value, false);
        assert.equal(fake.requests.filter(r => r.method === "PUT").length, 1);
        assert.equal(fake.requests.filter(r => r.method === "DELETE").length, 0);
    } finally { state.stop(); }
});

test("S-TA2: Retry rejects a changed device prerequisite instead of skipping historical done", async () => {
    const { fake, settings, state, core } = await setup();
    try {
        settings.profile().set(TITLE, true);
        await state.load();
        const count = fake.requests.length;
        fake.script(`/settings/values/${TITLE}?scope=profile`, problem(500, "failed", "Failed"));
        await state.setTitleArtScope(false);
        assert.ok(state.error);
        assert.equal(state.canRetry, true);
        assert.deepEqual(fake.requests.slice(count).map(r => `${r.method} ${r.path}`), [
            ...titleReads, `PUT /settings/values/${TITLE}?scope=profile_device`, ...titleReads,
            `DELETE /settings/values/${TITLE}?scope=profile`, ...titleReads,
        ]);
        const device = core.session.http.deviceId;
        settings.device("p-owner", device).set(TITLE, false);
        settings.rowRevisions.set(JSON.stringify(["p-owner", "profile_device", device, TITLE]), 9);
        const retryCount = fake.requests.length;
        await state.retry();
        assert.equal(fake.requests.filter(r => r.method === "DELETE").length, 1, "must not DELETE under an invalidated prerequisite");
        assert.deepEqual(fake.requests.slice(retryCount).map(r => `${r.method} ${r.path}`), titleReads);
        assert.equal(fake.requests.filter(r => r.method === "PUT").length, 1, "must not overwrite the newer device choice");
        assert.equal(settings.profile().get(TITLE), true);
        assert.equal(settings.device("p-owner", device).get(TITLE), false);
        assert.deepEqual(state.titleDevice, { isSet: true, value: false, revision: 9 });
        assert.equal(state.effective.get(TITLE)?.value, true);
        assert.match(state.error ?? "", /changed on another device.*Reload settings/);
        assert.equal(state.canRetry, false);
        await state.retry();
        assert.equal(state.error, undefined);
        assert.equal(settings.profile().get(TITLE), true);
        assert.deepEqual(state.titleDevice, { isSet: true, value: false, revision: 9 });
        assert.equal(fake.requests.filter(r => r.method === "PUT").length, 1);
        assert.equal(fake.requests.filter(r => r.method === "DELETE").length, 1);
    } finally { state.stop(); }
});

for (const change of ["removed", "recreated"] as const) test(`a ${change} profile between explicit and effective answers stops the plan`, async () => {
    const { fake, settings, state } = await setup();
    try {
        settings.profile().set(TITLE, true);
        await state.load();
        const catalog = fake.catalog;
        assert.ok(catalog);
        let pinned = false;
        let interleaved = false;
        fake.catalog = { route: (method, path, profile, body, headers) => {
            const interleave = pinned && !interleaved && method === "GET" && path === `/settings/values?scope=profile&keys=${TITLE}`;
            if (interleave && change === "recreated") settings.profile().delete(TITLE);
            const reply = catalog.route(method, path, profile, body, headers);
            if (method === "PUT" && path === `/settings/values/${TITLE}?scope=profile_device`) pinned = true;
            if (interleave) {
                settings.profile().delete(TITLE);
                if (change === "recreated") {
                    settings.profile().set(TITLE, false);
                    settings.rowRevisions.set(JSON.stringify(["p-owner", "profile", undefined, TITLE]), 9);
                }
                interleaved = true;
            }
            return reply;
        } };
        const count = fake.requests.length;
        await state.setTitleArtScope(false);
        assert.equal(interleaved, true);
        assert.deepEqual(fake.requests.slice(count).map(r => `${r.method} ${r.path}`), [
            ...titleReads, `PUT /settings/values/${TITLE}?scope=profile_device`, ...titleReads,
        ]);
        assert.match(state.error ?? "", /changed on another device/);
        assert.equal(state.canRetry, false);
        assert.equal(state.effective.get(TITLE)?.source, change === "removed" ? "profile_device" : "profile");
        await state.retry();
        assert.equal(state.error, undefined);
        assert.deepEqual(state.explicit.get(TITLE), change === "removed" ? { isSet: false } : { isSet: true, value: false, revision: 9 });
        assert.equal(fake.requests.filter(r => r.method === "DELETE").length, 0);
    } finally { state.stop(); }
});

for (const change of ["same-value-new-revision", "absent"] as const) test(`Retry validates the ${change} device prerequisite from fresh rows`, async () => {
    const { fake, settings, state, core } = await setup();
    try {
        settings.profile().set(TITLE, true);
        await state.load();
        fake.script(`/settings/values/${TITLE}?scope=profile`, problem(500, "failed", "Failed"));
        await state.setTitleArtScope(false);
        assert.equal(state.canRetry, true);
        const device = core.session.http.deviceId;
        if (change === "absent") settings.device("p-owner", device).delete(TITLE);
        else settings.rowRevisions.set(JSON.stringify(["p-owner", "profile_device", device, TITLE]), 9);
        const count = fake.requests.length;
        await state.retry();
        assert.deepEqual(fake.requests.slice(count).map(r => `${r.method} ${r.path}`), change === "absent" ? titleReads : [
            ...titleReads, `DELETE /settings/values/${TITLE}?scope=profile`, ...titleReads,
        ]);
        assert.equal(fake.requests.filter(r => r.method === "PUT").length, 1);
        assert.equal(fake.requests.filter(r => r.method === "DELETE").length, change === "absent" ? 1 : 2);
        assert.equal(settings.profile().has(TITLE), change === "absent");
        if (change === "absent") {
            assert.match(state.error ?? "", /changed on another device/);
            assert.deepEqual(state.titleDevice, { isSet: false });
        } else {
            assert.equal(state.error, undefined);
            assert.deepEqual(state.titleDevice, { isSet: true, value: true, revision: 9 });
            assert.equal(state.effective.get(TITLE)?.value, true);
            assert.equal(state.effective.get(TITLE)?.source, "profile_device");
        }
    } finally { state.stop(); }
});

test("an omitted explicit row fails readback without discarding valid state or repeating the committed PUT", async () => {
    const { fake, settings, state } = await setup();
    try {
        settings.profile().set(TITLE, true);
        await state.load();
        const catalog = fake.catalog;
        assert.ok(catalog);
        let pinned = false;
        let omitted = false;
        fake.catalog = { route: (method, path, profile, body, headers) => {
            const reply = catalog.route(method, path, profile, body, headers);
            if (method === "PUT" && path === `/settings/values/${TITLE}?scope=profile_device`) pinned = true;
            if (pinned && !omitted && method === "GET" && path === `/settings/values?scope=profile&keys=${TITLE}`) {
                omitted = true;
                return { status: 200, body: { revision: 24, items: [] } };
            }
            return reply;
        } };
        await state.setTitleArtScope(false);
        assert.equal(omitted, true);
        assert.match(state.error ?? "", /unreadable settings answer/);
        assert.equal(state.canRetry, true);
        assert.deepEqual(state.explicit.get(TITLE), { isSet: true, value: true, revision: 7 });
        assert.equal(state.effective.get(TITLE)?.value, true);
        assert.equal(fake.requests.filter(r => r.method === "DELETE").length, 0);
        const count = fake.requests.length;
        await state.retry();
        assert.equal(state.error, undefined);
        assert.deepEqual(fake.requests.slice(count).map(r => `${r.method} ${r.path}`), [
            ...titleReads, `DELETE /settings/values/${TITLE}?scope=profile`, ...titleReads,
        ]);
        assert.equal(fake.requests.filter(r => r.method === "PUT").length, 1);
        assert.equal(fake.requests.filter(r => r.method === "DELETE").length, 1);
    } finally { state.stop(); }
});

for (const lost of ["PUT", "DELETE"]) test(`lost title-art ${lost} and failed readback reconcile without repeating committed writes`, async () => {
    const { fake, settings, state, clock } = await setup();
    try {
        settings.profile().set(TITLE, true);
        await state.load();
        const scope = lost === "PUT" ? "profile_device" : "profile";
        fake.dropNextAnswer(`/settings/values/${TITLE}?scope=${scope}`);
        const path = operations.settingsValues([TITLE]).path;
        const hold = fake.hold(path);
        const edit = state.setTitleArtScope(false);
        await clock.advance(0);
        if (lost === "DELETE") fake.script(path, { status: 200, body: { revision: 24, items: [{ key: TITLE, scope: "profile", profile_id: "p-owner", is_set: true, value: true, revision: 7 }] } });
        fake.script(path, problem(429, "rate_limited", "Wait", { "Retry-After": "1" }));
        hold.release();
        await edit;
        assert.equal(state.canRetry, true);
        await clock.advance(1000);
        await state.retry();
        assert.equal(state.error, undefined);
        assert.equal(fake.requests.filter(r => r.method === "PUT").length, 1);
        assert.equal(fake.requests.filter(r => r.method === "DELETE").length, 1);
        assert.equal(settings.profile().has(TITLE), false);
    } finally { state.stop(); }
});

test("DELETE 404 is already absent and never retried as a mutation", async () => {
    const { fake, settings, state } = await setup();
    try {
        settings.profile().set(TITLE, true);
        await state.load();
        const catalog = fake.catalog;
        assert.ok(catalog);
        fake.catalog = { route: (method, path, profile, body, headers) => {
            if (method === "DELETE" && path === `/settings/values/${TITLE}?scope=profile`) settings.profile().delete(TITLE);
            return catalog.route(method, path, profile, body, headers);
        } };
        await state.setTitleArtScope(false);
        assert.equal(state.error, undefined);
        assert.equal(state.effective.get(TITLE)?.source, "profile_device");
        assert.equal(fake.requests.filter(r => r.method === "DELETE").length, 1);
    } finally { state.stop(); }
});

test("a newer same-value profile revision is reconciled rather than deleted after the device step", async () => {
    const { fake, settings, state, clock } = await setup();
    try {
        settings.profile().set(TITLE, true);
        await state.load();
        const hold = fake.hold(`/settings/values/${TITLE}?scope=profile_device`);
        const edit = state.setTitleArtScope(false);
        await clock.advance(0);
        settings.rowRevisions.set(JSON.stringify(["p-owner", "profile", undefined, TITLE]), 9);
        hold.release();
        await edit;
        assert.match(state.error ?? "", /changed on another device/);
        assert.equal(state.canRetry, false);
        assert.equal(fake.requests.filter(r => r.method === "DELETE").length, 0);
        assert.equal(settings.profile().get(TITLE), true);
    } finally { state.stop(); }
});

test("authority cancellation after device PUT never sends step two", async () => {
    const { fake, settings, state, clock, core } = await setup();
    settings.profile().set(TITLE, true);
    await state.load();
    const hold = fake.hold(`/settings/values/${TITLE}?scope=profile_device`, true);
    const edit = state.setTitleArtScope(false);
    await clock.advance(0);
    core.session.setProfile(undefined, "profile_cleared");
    hold.release();
    await edit;
    assert.equal(fake.requests.filter(r => r.method === "PUT").length, 1);
    assert.equal(fake.requests.filter(r => r.method === "DELETE").length, 0);
    assert.equal(state.loaded, false);
});

test("Details accepts administrator false, rejects malformed supported reads, and reserves compatibility for old servers", async () => {
    for (const mode of ["false", "malformed", "denied", "old", "missing-definition", "old-endpoint"] as const) {
        const { fake, settings, state, core, clock } = await setup();
        state.stop();
        settings.titleDefault = false;
        if (mode === "old") settings.revision = 15;
        if (mode === "denied") settings.allowed = false;
        if (mode === "old-endpoint") fake.script("/settings/contract/capabilities", problem(404, "not_found", "Old server"));
        if (mode === "missing-definition") fake.script("/settings/contract", { status: 200, body: { ...fixture("settings_contract_ok"), definitions: [] } });
        if (mode === "malformed") fake.script(`/settings/values/effective?keys=${TITLE}`, { status: 200, body: { revision: 24, items: [{ key: TITLE, value: "false", source: "default", definition_revision: 16 }] } });
        const details = new DetailsState(decodeItemDetail(fixture("get_catalog_item_ok")), core.session, () => undefined, async () => undefined);
        details.start();
        assert.equal(details.titleArtGuard()(), false);
        await clock.advance(0);
        assert.equal(details.titleArtPolicy, mode === "old" || mode === "old-endpoint" ? "compatibility" : mode === "false" ? "supported" : "failed", mode);
        assert.equal(details.titleArtGuard()(), mode === "old" || mode === "old-endpoint", mode);
        const guard = details.titleArtGuard();
        details.stop();
        assert.equal(guard(), false);
    }
});

test("title art changes use device scope until All Devices is on, then pin device before deleting profile", async () => {
    const { fake, settings, state } = await setup();
    try {
        assert.equal(state.effective.get(TITLE)?.value, true);
        await state.save(TITLE, false);
        await state.setTitleArtScope(true);
        await state.save(TITLE, true);
        await state.setTitleArtScope(false);
        const writes = fake.requests.filter(r => r.method === "PUT" || r.method === "DELETE");
        assert.deepEqual(writes.map(r => [r.method, r.path, r.body]), [
            ["PUT", `/settings/values/${TITLE}?scope=profile_device`, { value: false }],
            ["PUT", `/settings/values/${TITLE}?scope=profile`, { value: false }],
            ["PUT", `/settings/values/${TITLE}?scope=profile`, { value: true }],
            ["PUT", `/settings/values/${TITLE}?scope=profile_device`, { value: true }],
            ["DELETE", `/settings/values/${TITLE}?scope=profile`, undefined],
        ]);
        assert.equal(settings.profile().has(TITLE), false);
        const count = fake.requests.length;
        await state.setTitleArtScope(false);
        assert.equal(fake.requests.length, count);
        for (const request of writes) {
            assert.equal(request.headers["x-profile-id"], "p-owner");
            assert.ok(request.headers["x-silo-device-id"]);
            assert.ok(request.headers.authorization?.startsWith("Bearer "));
            assert.ok(!/[?&](profile_id|device_id|client_family)=/.test(request.path));
        }
    } finally { state.stop(); }
});
