import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_APPEARANCE } from "../../src/contracts/v2/subtitles.ts";
import { appearanceSummary, appearanceValue, delayLabel, delayOptions, editAppearance, languageChoices, scoreTier, subtitleControlSupport, syncWriteScope } from "../../src/player/subtitleAppearance.ts";
import { SubtitleDisplay } from "../../src/player/subtitleDisplay.ts";
import { SubtitleSearch } from "../../src/player/subtitleSearch.ts";
import { decodeProviderStatus, decodeSearchResponse } from "../../src/contracts/v2/subtitleSearch.ts";
import { connected, signIn } from "./support/harness.ts";
import { problem } from "./support/fakeSilo.ts";

const FILE = "42";
const PROVIDERS = "/subtitles/providers/status";
const SEARCH = "/subtitles/search";
const DOWNLOAD = "/subtitles/download";
const APPEARANCE = "playback.subtitle_appearance";
const SYNC = "player.subtitle_sync_ms";

const available = { schema_version: 1, enabled: true, providers: ["opensubtitles"], revision: "r", state: "available", allowed: true };
const hit = { id: "opaque-result", provider: "opensubtitles", language: "en", release_name: "Example.Release", format: "srt", score: 82, downloads: 12, hearing_impaired: true };

function contract(revision: number, definitions: readonly Record<string, unknown>[]) {
    return { api_version: 1, revision, definitions };
}
function capability(revision: number, allowed = true) {
    return { api_version: 1, revision: "opaque", manifest_revision: revision, state: "available", allowed, scopes: ["profile", "profile_device"], supports_batched_effective: true, supports_atomic_shortcuts: true, client_families: ["tv"] };
}
const appearanceDef = { key: APPEARANCE, introduced_in: 1, allowed_scopes: ["profile", "profile_device"] };
const syncDef = { key: SYNC, introduced_in: 1, allowed_scopes: ["profile", "profile_device"] };

test("provider status is search only when allowed, available and enabled", () => {
    assert.equal(decodeProviderStatus(available).available, true);
    assert.equal(decodeProviderStatus({ ...available, allowed: false }).available, false);
    assert.equal(decodeProviderStatus({ ...available, enabled: false, state: "not_configured", providers: [] }).available, false);
    assert.equal(decodeProviderStatus({ ...available, state: "disabled" }).available, false);
    assert.equal(decodeProviderStatus({ ...available, state: "future_state" }).available, false);
    assert.throws(() => decodeProviderStatus({ schema_version: 1, enabled: true, providers: [] }));
});

test("search results keep provider identity, warnings and score tiers", () => {
    const decoded = decodeSearchResponse({ results: [hit, { id: "bare" }], warnings: ["One or more subtitle providers could not complete the search."] });
    assert.equal(decoded.results[0]?.key, "opensubtitles:opaque-result");
    assert.equal(decoded.results[1]?.key, ":bare");
    assert.deepEqual(decoded.warnings, ["One or more subtitle providers could not complete the search."]);
    assert.equal(scoreTier(70), "good");
    assert.equal(scoreTier(69.9), "fair");
    assert.equal(scoreTier(40), "fair");
    assert.equal(scoreTier(39.9), "poor");
    assert.throws(() => decodeSearchResponse({ results: [{}], warnings: [] }));
});

test("delay, size, position and appearance use Apple's picker values and write scope", () => {
    assert.equal(delayLabel(0), "0 ms");
    assert.equal(delayLabel(100), "+100 ms");
    assert.equal(delayLabel(-200), "-200 ms");
    const options = delayOptions(2500);
    assert.equal(options[0]?.id, "-2000");
    assert.equal(options.at(-2)?.id, "2000");
    assert.equal(options.at(-1)?.id, "2500");
    assert.equal(appearanceSummary(DEFAULT_APPEARANCE), "Box, Large, Bottom");
    assert.equal(editAppearance(DEFAULT_APPEARANCE, "textOutlineColor", "#374151").textOutline, true);
    const colored = editAppearance(DEFAULT_APPEARANCE, "backgroundColor", "#1e3a5f");
    assert.equal(colored.backgroundStyle, "box");
    assert.equal(colored.backgroundColor, "#1e3a5f");
    const restored = editAppearance({ ...DEFAULT_APPEARANCE, backgroundOpacity: 0 }, "backgroundStyle", "box");
    assert.equal(restored.backgroundOpacity, 75);
    assert.equal(editAppearance({ ...DEFAULT_APPEARANCE, backgroundStyle: "none" }, "backgroundOpacity", 50).backgroundStyle, "box");
    assert.equal(syncWriteScope(false, ["profile", "profile_device"], 19), "profile");
    assert.equal(syncWriteScope(true, ["profile", "profile_device"], 24), "profile_device");
    assert.equal(syncWriteScope(false, ["profile", "profile_device"], 18), "profile_device");
    assert.deepEqual(subtitleControlSupport(contract(24, [appearanceDef, syncDef]), capability(24)), { delay: true, styling: true, deviceScope: true, syncAtProfile: true, textOpacity: true });
    assert.equal(subtitleControlSupport(contract(13, [appearanceDef, syncDef]), capability(13)).textOpacity, false);
    assert.equal(subtitleControlSupport(contract(24, [syncDef]), capability(24)).styling, false);
    assert.equal(appearanceValue(DEFAULT_APPEARANCE, false).textOpacity, undefined);
});

test("language rows float the preferred language and sort the rest by name", () => {
    const choices = languageChoices([{ code: "fr", label: "French" }, { code: "en", label: "English" }, { code: "ja" }], "en");
    assert.deepEqual(choices.suggested.map(choice => choice.code), ["en"]);
    assert.equal(choices.suggested[0]?.hint, "Preferred");
    assert.deepEqual(choices.other.map(choice => choice.code), ["fr", "ja"]);
    assert.equal(choices.other.find(choice => choice.code === "ja")?.label, "Japanese");
});

async function signed() {
    const h = await connected();
    await signIn(h);
    const profile = (await h.core.profiles.list())[0];
    assert.ok(profile);
    h.core.profiles.select(profile);
    return h;
}

test("search is offered until the server says providers are unavailable, then cancels and retries", async () => {
    const h = await signed();
    const search = new SubtitleSearch(h.core.session, h.clock, FILE, () => false, () => undefined);
    assert.equal(search.view.offered, true);
    h.fake.script(PROVIDERS, { status: 200, body: { ...available, enabled: false, state: "not_configured", providers: [] } });
    await search.refresh();
    assert.equal(search.view.offered, false);
    assert.equal(search.view.unavailableReason, "Not set up on this server");
    search.open();
    await search.pick("en");
    assert.equal(search.view.phase, "failed");
    assert.equal(h.fake.requests.some(request => request.path === SEARCH), false);
    h.fake.script(PROVIDERS, { status: 503, body: problem(503, "unavailable", "Down").body });
    await search.refresh();
    assert.equal(search.view.offered, false, "a failed probe is not an answer");
    search.destroy();
});

test("a language search can be cancelled and a failure can be retried without a second download", async () => {
    const h = await signed();
    const search = new SubtitleSearch(h.core.session, h.clock, FILE, () => false, () => undefined);
    h.fake.script(PROVIDERS, { status: 200, body: available });
    h.fake.script("/settings/contract", { status: 200, body: { option_sets: { playback_subtitle_languages: { options: [{ value: "en", label: "English" }, { value: "fr", label: "French" }] } } } });
    await search.refresh();
    search.open();
    await h.clock.advance(0);
    assert.equal(search.view.suggested[0]?.code ?? search.view.other[0]?.code, "en");
    const held = h.fake.hold(SEARCH);
    const pending = search.pick("fr");
    assert.equal(search.view.phase, "searching");
    assert.match(search.view.status, /half a minute/);
    search.back();
    held.release();
    await pending;
    assert.equal(search.view.phase, "languages");
    h.fake.script(SEARCH, { status: 200, body: { results: [], warnings: ["One provider failed."] } });
    await search.pick("fr");
    assert.equal(search.view.phase, "results");
    assert.match(search.view.message, /No subtitles found for French/);
    assert.deepEqual(search.view.warnings, ["One provider failed."]);
    h.fake.script(SEARCH, problem(503, "unavailable", "Providers unavailable"));
    await search.pick("fr");
    assert.equal(search.view.phase, "failed");
    assert.match(search.view.message, /Providers unavailable/);
    assert.equal(search.view.canRetry, true);
    search.destroy();
});

test("download is sent once and a stored row is handed to track selection", async () => {
    const h = await signed();
    const added: string[] = [];
    const search = new SubtitleSearch(h.core.session, h.clock, FILE, id => { added.push(id); return true; }, () => undefined);
    h.fake.script(PROVIDERS, { status: 200, body: available });
    h.fake.script(SEARCH, { status: 200, body: { results: [hit], warnings: [] } });
    await search.refresh();
    search.open();
    await search.pick("en");
    h.fake.script(DOWNLOAD, { status: 200, body: { subtitle: { id: "7", media_file_id: FILE, provider: "opensubtitles", language: "en", format: "srt", release_name: hit.release_name, score: 82, hearing_impaired: true, created_at: "2026-01-02T03:04:05.678Z" } } });
    await search.download("opensubtitles:opaque-result");
    await search.download("opensubtitles:opaque-result");
    assert.deepEqual(added, ["7"]);
    const downloads = h.fake.requests.filter(request => request.path === DOWNLOAD);
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0]?.method, "POST");
    assert.deepEqual(downloads[0]?.body, { media_file_id: FILE, provider: "opensubtitles", subtitle_id: "opaque-result", language: "en", release_name: "Example.Release", score: 82, hearing_impaired: true });
    assert.equal(search.view.phase, "closed");
    search.destroy();
});

test("an uncertain download is not sent again and a refusal can be retried", async () => {
    const h = await signed();
    const search = new SubtitleSearch(h.core.session, h.clock, FILE, () => false, () => undefined);
    h.fake.script(PROVIDERS, { status: 200, body: available });
    h.fake.script(SEARCH, { status: 200, body: { results: [hit], warnings: [] } });
    await search.refresh();
    await search.pick("en");
    h.fake.dropNextAnswer(DOWNLOAD);
    await search.download(hit.provider + ":" + hit.id);
    assert.match(search.view.message, /couldn't confirm/i);
    await search.download(hit.provider + ":" + hit.id);
    assert.equal(h.fake.requests.filter(request => request.path === DOWNLOAD).length, 1);
    h.fake.script(DOWNLOAD, problem(422, "validation_failed", "That subtitle is no longer offered."));
    const refused = new SubtitleSearch(h.core.session, h.clock, FILE, () => false, () => undefined);
    h.fake.script(PROVIDERS, { status: 200, body: available });
    h.fake.script(SEARCH, { status: 200, body: { results: [hit], warnings: [] } });
    await refused.refresh();
    await refused.pick("en");
    await refused.download(hit.provider + ":" + hit.id);
    assert.match(refused.view.message, /no longer offered/);
    assert.equal(refused.view.canRetry, true);
    search.destroy();
    refused.destroy();
});

function stored(key: string, scope: string, value: unknown, isSet = true) {
    return { status: 200, body: { key, scope, profile_id: "p-owner", ...(scope === "profile_device" ? { device_id: "device" } : {}), value, revision: 8, is_set: isSet } };
}

for (const missing of ["capability", "preferences"] as const) {
    test(`missing subtitle display ${missing} keeps unsupported edits disabled`, async () => {
        const h = await signed();
        if (missing === "preferences") {
            h.fake.script("/settings/contract/capabilities", { status: 200, body: capability(24) });
            h.fake.script("/settings/contract", { status: 200, body: contract(24, [appearanceDef]) });
            h.fake.script(`/settings/values?scope=profile_device&keys=${APPEARANCE}`, { status: 200, body: { revision: 24, items: [{ key: APPEARANCE, scope: "profile_device", profile_id: "p-owner", device_id: h.core.session.http.deviceId, is_set: false }] } });
        }
        const display = new SubtitleDisplay(h.core.session, "p-owner", () => undefined, () => undefined);
        await display.load();
        assert.equal(display.view?.styling, false);
        if (missing === "capability") assert.equal(display.view?.message, "");
        else assert.match(display.view?.message ?? "", /Could not load subtitle preferences/);
        display.destroy();
    });
}

for (const inherited of [false, true]) for (const supportedSync of [false, true]) {
    test(`appearance edits load effective values with inherited reset ${inherited} and sync ${supportedSync}`, async () => {
        const h = await signed();
        h.fake.script("/settings/contract/capabilities", { status: 200, body: capability(24) });
        h.fake.script("/settings/contract", { status: 200, body: contract(24, [appearanceDef, ...(supportedSync ? [syncDef] : [])]) });
        h.fake.script(`/settings/values?scope=profile_device&keys=${APPEARANCE}`, { status: 200, body: { revision: 24, items: [{ key: APPEARANCE, scope: "profile_device", profile_id: "p-owner", device_id: h.core.session.http.deviceId, is_set: inherited }] } });
        const effective = (color: string, sync: number): void => {
            h.fake.script("/settings/subtitle-appearance/effective", { status: 200, body: { profile_id: "p-owner", effective_value: JSON.stringify({ ...DEFAULT_APPEARANCE, fontColor: color }) } });
            if (supportedSync) h.fake.script(`/settings/values/effective?keys=${SYNC}`, { status: 200, body: { items: [{ key: SYNC, value: sync }] } });
        };
        effective("#00ff00", 400);
        const display = new SubtitleDisplay(h.core.session, "p-owner", () => undefined, () => undefined);
        await display.load();
        if (inherited) {
            effective("#ff0000", 100);
            h.fake.script(`/settings/values/${APPEARANCE}?scope=profile_device`, { status: 204 });
            h.fake.script(`/settings/values/${SYNC}?scope=profile_device`, { status: 204 });
            await display.setDeviceOverride(false);
        }
        h.fake.script(`/settings/values/${APPEARANCE}?scope=profile`, stored(APPEARANCE, "profile", DEFAULT_APPEARANCE));
        await display.setSize("small");
        const write = h.fake.requests.filter(request => request.method === "PUT").at(-1);
        assert.equal((write?.body?.value as { fontColor?: string }).fontColor, inherited ? "#ff0000" : "#00ff00");
        assert.equal(display.view?.delayMs, supportedSync ? inherited ? 100 : 400 : 0);
        if (!supportedSync) assert.equal(h.fake.requests.some(request => request.path === `/settings/values/effective?keys=${SYNC}`), false);
        display.destroy();
    });
}

test("delay and appearance write the advertised scope and a failed write is recoverable", async () => {
    const h = await signed();
    let applied: { appearance: typeof DEFAULT_APPEARANCE; sync: number } | undefined;
    h.fake.script("/settings/contract/capabilities", { status: 200, body: capability(24) });
    h.fake.script("/settings/contract", { status: 200, body: contract(24, [appearanceDef, syncDef]) });
    h.fake.script(`/settings/values?scope=profile_device&keys=${APPEARANCE}`, { status: 200, body: { revision: 24, items: [{ key: APPEARANCE, scope: "profile_device", profile_id: "p-owner", device_id: h.core.session.http.deviceId, is_set: false }] } });
    const display = new SubtitleDisplay(h.core.session, "p-owner", (appearance, sync) => { applied = { appearance, sync }; }, () => undefined);
    h.fake.script("/settings/subtitle-appearance/effective", { status: 200, body: { profile_id: "p-owner", effective_value: JSON.stringify(DEFAULT_APPEARANCE) } });
    h.fake.script(`/settings/values/effective?keys=${SYNC}`, { status: 200, body: { items: [{ key: SYNC, value: 0 }] } });
    await display.load();
    display.adopt(DEFAULT_APPEARANCE, 0);
    assert.equal(display.view?.delay, true);
    h.fake.script(`/settings/values/${SYNC}?scope=profile`, stored(SYNC, "profile", 100));
    await display.setDelay(100);
    assert.equal(applied?.sync, 100);
    assert.equal(h.fake.requests.filter(request => request.path === `/settings/values/${SYNC}?scope=profile`).at(-1)?.body?.value, 100);
    h.fake.script(`/settings/values/${SYNC}?scope=profile`, problem(503, "unavailable", "Unavailable"));
    await display.setDelay(200);
    assert.equal(display.view?.delayMs, 100);
    assert.match(display.view?.message ?? "", /Try again/);
    h.fake.script(`/settings/values/${APPEARANCE}?scope=profile`, stored(APPEARANCE, "profile", { ...DEFAULT_APPEARANCE, fontSize: "small" }));
    await display.setSize("small");
    assert.equal(applied?.appearance.fontSize, "small");
    h.fake.script(`/settings/values/${APPEARANCE}?scope=profile_device`, stored(APPEARANCE, "profile_device", DEFAULT_APPEARANCE));
    await display.setDeviceOverride(true);
    h.fake.script(`/settings/values/${APPEARANCE}?scope=profile_device`, stored(APPEARANCE, "profile_device", { ...DEFAULT_APPEARANCE, position: "top" }));
    await display.setPosition("top");
    const deviceWrite = h.fake.requests.filter(request => request.method === "PUT" && request.path === `/settings/values/${APPEARANCE}?scope=profile_device`).at(-1);
    assert.equal((deviceWrite?.body?.value as { position?: string }).position, "top");
    display.destroy();
});
