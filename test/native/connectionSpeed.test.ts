import assert from "node:assert/strict";
import { test } from "node:test";
import { operations } from "../../src/api/operations.ts";
import { probeDownloadUrl, probeRetryAfterSeconds, runManualSpeedTest, type SpeedTestClient, type SpeedTestNetwork } from "../../src/api/bandwidthProbe.ts";
import type { ServerBase } from "../../src/api/serverUrl.ts";
import { BUFFERING_QUALITY_FEATURE, decodePlaybackConnection } from "../../src/contracts/v2/connectionSpeed.ts";
import { decodePlaybackCapabilities } from "../../src/contracts/v2/playback.ts";
import { AccurateProbeMeter } from "../../src/player/bandwidthProbe.ts";
import {
    autoBudgetText,
    connectionAgeText,
    connectionRateText,
    connectionSpeedSkippedText,
    connectionSpeedText,
    learnedLimitText,
    playbackSampleText,
    tryAgainMessage,
} from "../../src/ui/connectionSpeed.ts";
import { connected, signIn, type Harness } from "./support/harness.ts";
import { fixture, problem, type FakeSilo, type Reply } from "./support/fakeSilo.ts";
import type { ManualClock } from "./support/clock.ts";

const NOW = Date.parse("2026-01-02T03:04:05.678Z");
const WIFI: SpeedTestNetwork = { online: true, metered: false, transport: "wifi" };
const HTTPS: ServerBase = { origin: "https://silo.example.test", baseUrl: "https://silo.example.test", apiRoot: "https://silo.example.test/api/v2" };

test("accurate probe counts settled windows after the ramp and caps the rate", () => {
    const settled = new AccurateProbeMeter();
    settled.receive(1000, 0);
    settled.receive(3_000_000, 500);
    settled.transferEnded(1000);
    assert.deepEqual(settled.result, { kbps: 48000, lowerBound: false, bytes: 3_000_000, durationMs: 500 });

    const slow = new AccurateProbeMeter();
    slow.receive(1000, 0);
    slow.receive(1000, 500);
    slow.transferEnded(1000);
    assert.equal(slow.result, undefined);

    const fast = new AccurateProbeMeter();
    fast.receive(1, 0);
    fast.receive(62_500_500, 500);
    fast.transferEnded(1000);
    assert.deepEqual(fast.result, { kbps: 1_000_000, lowerBound: true, bytes: 62_500_500, durationMs: 500 });

    const whole = new AccurateProbeMeter();
    whole.receive(1_000_000_000, 0);
    whole.transferEnded(400);
    assert.deepEqual(whole.result, { kbps: 1_000_000, lowerBound: true, bytes: 1_000_000_000, durationMs: 400 });

    const short = new AccurateProbeMeter();
    short.receive(1000, 0);
    short.transferEnded(100);
    assert.equal(short.result, undefined);
});

test("connection speed copy matches Apple TV", () => {
    assert.equal(connectionRateText(999), "999 kbps");
    assert.equal(connectionRateText(1000), "1 Mbps");
    assert.equal(connectionRateText(1500), "1.5 Mbps");
    assert.equal(connectionRateText(4000), "4 Mbps");
    assert.equal(connectionRateText(4500), "4.5 Mbps");
    assert.equal(connectionRateText(48000), "48 Mbps");
    assert.equal(connectionRateText(35280), "35 Mbps");
    assert.equal(connectionRateText(115000), "115 Mbps");
    assert.equal(connectionRateText(0), "0 kbps");
    assert.equal(connectionRateText(-5), "0 kbps");
    assert.equal(connectionAgeText(NOW, NOW), "just now");
    assert.equal(connectionAgeText(NOW, NOW + 59_999), "just now");
    assert.equal(connectionAgeText(NOW, NOW + 60_000), "1 minute ago");
    assert.equal(connectionAgeText(NOW, NOW + 3 * 60_000), "3 minutes ago");
    assert.equal(connectionAgeText(NOW, NOW + 60 * 60_000), "1 hour ago");
    assert.equal(connectionAgeText(NOW, NOW + 2 * 60 * 60_000), "2 hours ago");
    assert.equal(connectionAgeText(NOW, NOW + 24 * 60 * 60_000), "1 day ago");
    assert.equal(connectionAgeText(NOW, NOW + 2 * 24 * 60 * 60_000), "2 days ago");
    assert.equal(connectionAgeText(NOW, NOW - 1000), "just now");
    assert.equal(connectionSpeedText(48000, false, NOW, "wifi", NOW + 3 * 60_000), "48 Mbps · measured 3 minutes ago on Wi-Fi");
    assert.equal(connectionSpeedText(115000, true, NOW, "ethernet", NOW), "Faster than 115 Mbps · measured just now on Ethernet");
    assert.equal(connectionSpeedText(1000, false, NOW, "cellular", NOW), "1 Mbps · measured just now on cellular");
    assert.equal(connectionSpeedText(1000, false, NOW, "other", NOW), "1 Mbps · measured just now on this connection");
    assert.equal(playbackSampleText(51200, NOW, NOW + 2 * 60 * 60_000), "Faster than 51 Mbps · seen during playback 2 hours ago");
    assert.equal(autoBudgetText(35280), "Auto plays videos up to 35 Mbps without converting them.");
    assert.equal(tryAgainMessage(12), "Try again in 12 seconds");
    assert.equal(tryAgainMessage(1), "Try again in 1 second");
    const metered = { online: true, metered: true, transport: "other" as const, cellular: false };
    assert.equal(connectionSpeedSkippedText(metered), "Speed tests are skipped on metered networks.");
    assert.equal(connectionSpeedSkippedText({ ...metered, cellular: true, transport: "cellular" }), "Speed tests are skipped on cellular, and the Cellular Quality settings apply.");
    assert.equal(connectionSpeedSkippedText({ ...metered, metered: false }), undefined);
    assert.equal(connectionSpeedSkippedText({ ...metered, online: false }), undefined);
});

test("probe URL keeps the server origin and replaces size", () => {
    assert.equal(probeDownloadUrl("http://silo.example.test/api/v2/playback/bandwidth-probe", HTTPS, 1_000_000_000), undefined);
    assert.equal(probeDownloadUrl("https://other.example.test/probe", HTTPS, 1_000_000_000), undefined);
    assert.equal(
        probeDownloadUrl("https://silo.example.test/api/v2/playback/bandwidth-probe?size=10&media_path=true", HTTPS, 1_000_000_000),
        "https://silo.example.test/api/v2/playback/bandwidth-probe?media_path=true&size=1000000000",
    );
    assert.equal(
        probeDownloadUrl("/api/v2/playback/bandwidth-probe?media_path=true", HTTPS, 1_000_000_000),
        "https://silo.example.test/api/v2/playback/bandwidth-probe?media_path=true&size=1000000000",
    );
    const http: ServerBase = { origin: "http://silo.example.test", baseUrl: "http://silo.example.test", apiRoot: "http://silo.example.test/api/v2" };
    assert.equal(
        probeDownloadUrl("http://silo.example.test/api/v2/playback/bandwidth-probe", http, 1_000_000_000),
        "http://silo.example.test/api/v2/playback/bandwidth-probe?size=1000000000",
    );
});

test("Retry-After follows Apple's 30 second default and one second floor", () => {
    assert.equal(probeRetryAfterSeconds(null), 30);
    assert.equal(probeRetryAfterSeconds("12"), 12);
    assert.equal(probeRetryAfterSeconds(" 12 "), 12);
    assert.equal(probeRetryAfterSeconds("0"), 1);
    assert.equal(probeRetryAfterSeconds("-1"), 1);
    assert.equal(probeRetryAfterSeconds("soon"), 30);
});

test("connection document keeps a good probe and drops a malformed one", () => {
    const full = decodePlaybackConnection({
        connection: "remote",
        probe: { kbps: 48000, lower_bound: false, measured_at: "2026-01-02T03:04:05.678Z", transport: "wifi" },
        playback_sample: { kbps: 51200, measured_at: "2026-01-02T01:04:05.678Z" },
        auto_budget_kbps: 35280,
        learned_limit: { kbps: 1000 },
    });
    assert.equal(full.connection, "remote");
    assert.deepEqual(full.probe, { kbps: 48000, lowerBound: false, measuredAt: NOW, transport: "wifi" });
    assert.deepEqual(full.playbackSample, { kbps: 51200, measuredAt: Date.parse("2026-01-02T01:04:05.678Z") });
    assert.equal(full.autoBudgetKbps, 35280);
    const absent = decodePlaybackConnection({ connection: "local", probe: { kbps: 1000, measured_at: "2026-01-02T03:04:05.678Z", transport: "ethernet" } });
    assert.equal(absent.probe?.lowerBound, false);
    const malformed = decodePlaybackConnection({
        connection: "remote",
        probe: { kbps: "fast", lower_bound: true, measured_at: "2026-01-02T03:04:05.678Z", transport: "wifi" },
        playback_sample: { kbps: 1.5, measured_at: "2026-01-02T03:04:05.678Z" },
        auto_budget_kbps: 1.5,
    });
    assert.equal(malformed.probe, undefined);
    assert.equal(malformed.playbackSample, undefined);
    assert.equal(malformed.autoBudgetKbps, undefined);
    assert.equal(decodePlaybackConnection({
        connection: "remote",
        probe: { kbps: 1000, lower_bound: "yes", measured_at: "2026-01-02T03:04:05.678Z", transport: "wifi" },
    }).probe, undefined);
    assert.throws(() => decodePlaybackConnection({ probe: { kbps: 1 } }));
});

test("playback capabilities keep probe fields and ignore unreadable ones", () => {
    const raw = fixture("playback_capability_available");
    const kept = decodePlaybackCapabilities(raw);
    assert.equal(kept.bandwidthProbeUrl, raw.bandwidth_probe_url);
    assert.equal(kept.bandwidthProbeTargetKbps, 113750);
    assert.equal(kept.bandwidthProbeAutomatic, true);
    assert.equal(kept.bandwidthProbeMaxAgeSeconds, 604800);
    assert.equal(kept.installationId, raw.installation_id);
    assert.ok(kept.features.includes("connection_speed_v1"));
    const garbage = decodePlaybackCapabilities({
        ...raw,
        bandwidth_probe_url: 12,
        bandwidth_probe_target_kbps: 1.5,
        bandwidth_probe_automatic: "yes",
        bandwidth_probe_max_age_seconds: "604800",
    });
    assert.equal(garbage.bandwidthProbeUrl, undefined);
    assert.equal(garbage.bandwidthProbeTargetKbps, undefined);
    assert.equal(garbage.bandwidthProbeAutomatic, undefined);
    assert.equal(garbage.bandwidthProbeMaxAgeSeconds, undefined);
    assert.equal(garbage.installationId, raw.installation_id);
    const { bandwidth_probe_url, bandwidth_probe_target_kbps, bandwidth_probe_automatic, bandwidth_probe_max_age_seconds, ...rest } = raw;
    const missing = decodePlaybackCapabilities(rest);
    assert.equal(missing.bandwidthProbeUrl, undefined);
    assert.equal(missing.bandwidthProbeTargetKbps, undefined);
    assert.equal(missing.bandwidthProbeAutomatic, undefined);
    assert.equal(missing.bandwidthProbeMaxAgeSeconds, undefined);
});

async function signedIn(): Promise<Harness> {
    const harness = await connected();
    await signIn(harness);
    const profile = (await harness.core.profiles.list())[0];
    assert.ok(profile);
    assert.equal(profile.id, "p-owner");
    harness.core.profiles.select(profile);
    return harness;
}

function allowProbe(fake: FakeSilo, options: { patch?: Record<string, unknown>; probe?: Reply; report?: Reply } = {}): void {
    fake.extraRoutes.push((method, path) => {
        if (method === "GET" && path === "/playback/capabilities") {
            return { status: 200, body: { ...fixture("playback_capability_available"), bandwidth_probe_url: `${fake.origin}/api/v2/playback/bandwidth-probe?media_path=true`, ...options.patch } };
        }
        if (method === "GET" && path.split("?")[0] === "/playback/bandwidth-probe") return options.probe;
        if (method === "POST" && path === "/playback/bandwidth-probe/results") return options.report ?? { status: 204 };
        return undefined;
    });
}

function clientOf(harness: Harness, download?: SpeedTestClient["download"]): SpeedTestClient {
    const session = harness.core.session;
    return {
        base: session.http.base,
        clock: harness.clock,
        capabilities: (signal) => session.call({ ...operations.playbackCapabilities(), profileScoped: true, signal }),
        download: download ?? ((url, signal) => session.authorizedFetch(url, signal)),
        report: (body) => session.call({ ...operations.reportBandwidthProbe(body), profileScoped: true, replayAfterRefresh: false }),
    };
}

function paced(clock: ManualClock, seen: { url?: string }): SpeedTestClient["download"] {
    return async (url) => {
        seen.url = url;
        let phase = 0;
        const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (phase === 0) {
                    phase = 1;
                    controller.enqueue(new Uint8Array(1000));
                    return;
                }
                if (phase === 1) {
                    phase = 2;
                    await clock.advance(500);
                    controller.enqueue(new Uint8Array(3_000_000));
                    return;
                }
                await clock.advance(500);
                controller.close();
            },
        });
        return new Response(stream, { status: 200, headers: { "Content-Length": "3001000" } });
    };
}

function reports(fake: FakeSilo) {
    return fake.requests.filter(request => request.method === "POST" && request.path === "/playback/bandwidth-probe/results");
}

test("Test speed reports the settled accurate measurement once", async () => {
    const harness = await signedIn();
    allowProbe(harness.fake);
    const seen: { url?: string } = {};
    const result = await runManualSpeedTest(clientOf(harness, paced(harness.clock, seen)), WIFI, new AbortController().signal);
    assert.equal(result.kind, "measured");
    if (result.kind !== "measured") return;
    assert.equal(result.measurement.kbps, 48000);
    assert.equal(result.measurement.lowerBound, false);
    assert.equal(result.measurement.bytes, 3_000_000);
    assert.equal(result.measurement.durationMs, 500);
    assert.equal(result.measurement.transport, "wifi");
    assert.equal(result.measurement.measuredAt, harness.clock.now());
    assert.equal(seen.url, `${harness.fake.origin}/api/v2/playback/bandwidth-probe?media_path=true&size=1000000000`);
    const posted = reports(harness.fake);
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0]?.body, { kbps: 48000, bytes: 3_000_000, duration_ms: 500, transport: "wifi", manual: true });
    assert.equal(Object.hasOwn(posted[0]?.body ?? {}, "lower_bound"), false);
    assert.equal(posted[0]?.headers["x-profile-id"], "p-owner");
    assert.ok(posted[0]?.headers.authorization?.startsWith("Bearer "));
    assert.equal(posted[0]?.headers["x-silo-device-id"], harness.core.session.http.deviceId);
    const capability = harness.fake.requests.find(request => request.path === "/playback/capabilities");
    assert.equal(capability?.headers["x-profile-id"], "p-owner");
    assert.equal(capability?.headers["x-silo-device-id"], harness.core.session.http.deviceId);
});

test("a rate limit is the server's Retry-After and is not reported", async () => {
    const harness = await signedIn();
    allowProbe(harness.fake, { probe: { status: 429, headers: { "Retry-After": "12" }, body: { title: "wait" } } });
    const result = await runManualSpeedTest(clientOf(harness), WIFI, new AbortController().signal);
    assert.deepEqual(result, { kind: "rateLimited", seconds: 12 });
    assert.equal(reports(harness.fake).length, 0);
    const probe = harness.fake.requests.find(request => request.path.startsWith("/playback/bandwidth-probe"));
    assert.ok(probe?.path.includes("size=1000000000"));
    assert.equal(probe?.redirect, "error");
    assert.equal(probe?.headers["x-profile-id"], "p-owner");
    assert.ok(probe?.headers["x-silo-device-id"]);
});

test("leaving during the download reports nothing", async () => {
    const harness = await signedIn();
    allowProbe(harness.fake);
    const hold = harness.fake.hold("/playback/bandwidth-probe");
    const controller = new AbortController();
    const pending = runManualSpeedTest(clientOf(harness), WIFI, controller.signal);
    for (let step = 0; step < 20 && !harness.fake.requests.some(request => request.path.startsWith("/playback/bandwidth-probe")); step += 1) {
        await harness.clock.advance(0);
    }
    assert.ok(harness.fake.requests.some(request => request.path.startsWith("/playback/bandwidth-probe")));
    controller.abort();
    assert.deepEqual(await pending, { kind: "cancelled" });
    assert.equal(reports(harness.fake).length, 0);
    hold.release();
});

test("no first byte within 10 seconds fails and reports nothing", async () => {
    const harness = await signedIn();
    allowProbe(harness.fake);
    const hold = harness.fake.hold("/playback/bandwidth-probe");
    const pending = runManualSpeedTest(clientOf(harness), WIFI, new AbortController().signal);
    for (let step = 0; step < 20 && !harness.fake.requests.some(request => request.path.startsWith("/playback/bandwidth-probe")); step += 1) {
        await harness.clock.advance(0);
    }
    await harness.clock.advance(10_000);
    assert.deepEqual(await pending, { kind: "failed" });
    assert.equal(reports(harness.fake).length, 0);
    hold.release();
});

test("a server without connection_speed_v1 is not probed", async () => {
    const harness = await signedIn();
    const raw = fixture("playback_capability_available");
    const features = Array.isArray(raw.features) ? raw.features.filter(feature => feature !== "connection_speed_v1") : [];
    allowProbe(harness.fake, { patch: { features } });
    const result = await runManualSpeedTest(clientOf(harness), WIFI, new AbortController().signal);
    assert.deepEqual(result, { kind: "failed" });
    assert.equal(harness.fake.requests.some(request => request.path.startsWith("/playback/bandwidth-probe")), false);
    assert.equal(reports(harness.fake).length, 0);
});

test("an http probe URL on an https server is not downloaded", async () => {
    const harness = await signedIn();
    allowProbe(harness.fake, { patch: { bandwidth_probe_url: "http://silo.example.test/api/v2/playback/bandwidth-probe?media_path=true" } });
    const result = await runManualSpeedTest(clientOf(harness), WIFI, new AbortController().signal);
    assert.deepEqual(result, { kind: "failed" });
    assert.equal(harness.fake.requests.some(request => request.path.startsWith("/playback/bandwidth-probe")), false);
});

test("a refused report keeps the measurement off the next playback decision", async () => {
    const harness = await signedIn();
    allowProbe(harness.fake, { report: problem(500, "unavailable", "Not stored") });
    const result = await runManualSpeedTest(clientOf(harness, paced(harness.clock, {})), WIFI, new AbortController().signal);
    assert.equal(result.kind, "notSaved");
    if (result.kind !== "notSaved") return;
    assert.equal(result.measurement.kbps, 48000);
    assert.equal(reports(harness.fake).length, 1);
});

test("offline and metered checks do not download", async () => {
    const harness = await signedIn();
    allowProbe(harness.fake);
    const before = harness.fake.requests.length;
    assert.deepEqual(await runManualSpeedTest(clientOf(harness), { online: false, metered: false, transport: "other" }, new AbortController().signal), { kind: "failed" });
    assert.deepEqual(await runManualSpeedTest(clientOf(harness), { online: true, metered: true, transport: "cellular" }, new AbortController().signal), { kind: "metered" });
    assert.equal(harness.fake.requests.length, before);
});

test("a body shorter than Content-Length measures nothing", async () => {
    const harness = await signedIn();
    allowProbe(harness.fake);
    const download: SpeedTestClient["download"] = async () => new Response(new Uint8Array(1000), { status: 200, headers: { "Content-Length": "5000" } });
    assert.deepEqual(await runManualSpeedTest(clientOf(harness, download), WIFI, new AbortController().signal), { kind: "failed" });
    assert.equal(reports(harness.fake).length, 0);
});

test("connection document keeps a valid learned limit and reads a malformed or null one as absent", () => {
    const limit = { kbps: 44000, observed_at: "2026-10-17T05:00:00Z", expires_at: "2026-10-24T05:00:00Z" };
    assert.deepEqual(decodePlaybackConnection({ connection: "remote", learned_limit: limit }).learnedLimit, {
        kbps: 44000,
        observedAt: Date.parse("2026-10-17T05:00:00Z"),
        expiresAt: Date.parse("2026-10-24T05:00:00Z"),
    });
    assert.equal(decodePlaybackConnection({ connection: "remote", learned_limit: null }).learnedLimit, undefined);
    assert.equal(decodePlaybackConnection({ connection: "remote" }).learnedLimit, undefined);
    assert.equal(decodePlaybackConnection({ connection: "remote", learned_limit: { ...limit, kbps: 44.5 } }).learnedLimit, undefined);
    assert.equal(decodePlaybackConnection({ connection: "remote", learned_limit: { kbps: 44000, observed_at: "soon", expires_at: limit.expires_at } }).learnedLimit, undefined);
    assert.equal(decodePlaybackConnection({ connection: "remote", learned_limit: { kbps: 44000, observed_at: limit.observed_at } }).learnedLimit, undefined);
    // A malformed limit leaves the rest of the document intact (APIv2PlaybackModels.swift:302-306).
    const mixed = decodePlaybackConnection({ connection: "remote", learned_limit: "x", auto_budget_kbps: 35280 });
    assert.equal(mixed.autoBudgetKbps, 35280);
    assert.equal(BUFFERING_QUALITY_FEATURE, "buffering_quality_v1");
});

test("resetPlaybackLearnedLimit is a DELETE that is never retried", () => {
    const spec = operations.resetPlaybackLearnedLimit();
    assert.equal(spec.method, "DELETE");
    assert.equal(spec.path, "/playback/connection/learned-limit");
    assert.equal(spec.retry, "never");
    assert.equal(spec.decode(undefined), undefined);
});

test("learned limit text names the rate and the local day of the last lowering", () => {
    const limit = { kbps: 44000, observedAt: Date.parse("2026-10-17T05:00:00Z"), expiresAt: Date.parse("2026-10-24T05:00:00Z") };
    assert.equal(learnedLimitText(limit, "en-US", "Australia/Melbourne"), "Limited to 44 Mbps after buffering on Oct 17");
    // 23:30 UTC on the 16th is already the 17th in Melbourne: the day is local, never UTC-derived.
    assert.equal(learnedLimitText({ ...limit, observedAt: Date.parse("2026-10-16T23:30:00Z") }, "en-US", "Australia/Melbourne"), "Limited to 44 Mbps after buffering on Oct 17");
    assert.equal(learnedLimitText({ ...limit, observedAt: Date.parse("2026-10-16T23:30:00Z") }, "en-US", "UTC"), "Limited to 44 Mbps after buffering on Oct 16");
    assert.equal(learnedLimitText({ ...limit, kbps: 4500 }, "en-US", "UTC"), "Limited to 4.5 Mbps after buffering on Oct 17");
    assert.equal(learnedLimitText({ ...limit, kbps: 800 }, "en-US", "UTC"), "Limited to 800 kbps after buffering on Oct 17");
});
