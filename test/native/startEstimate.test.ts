// bandwidth_estimate_kbps on playback start. silo-apple BandwidthProbeScheduler.freshEstimateKbps and
// PlayerViewModel's start at 27cf4a24: the highest current stored reading, no probe and no extra request.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { bandwidthReadings, readingsKey, readingsScope } from "../../src/player/bandwidthReadings.ts";
import { PlaybackController, type PlayRequest } from "../../src/player/controller.ts";
import { ConnectionSpeed } from "../../src/ui/connectionSpeed.ts";
import { FakeAVPlay } from "./support/fakeAVPlay.ts";
import { FakePlayback } from "./support/fakePlayback.ts";
import { fixture, type Reply } from "./support/fakeSilo.ts";
import { connected, signIn, type Harness } from "./support/harness.ts";

const MOVIE: PlayRequest = { contentId: "movie-1", fileId: "42", title: "Movie", startSeconds: 12.5 };
const MAX_AGE_SECONDS = 604800;

// Node's navigator has no onLine; a TV's webview does.
beforeEach(() => {
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

afterEach(() => {
    bandwidthReadings.clear();
    setConnection(undefined);
    delete (navigator as unknown as Record<string, unknown>).onLine;
});

function setConnection(connection: { type: string } | undefined): void {
    if (connection === undefined) delete (navigator as unknown as Record<string, unknown>).connection;
    else Object.defineProperty(navigator, "connection", { value: connection, configurable: true });
}

interface Rig {
    readonly h: Harness;
    readonly controller: PlaybackController;
}

async function rig(): Promise<Rig> {
    const h = await connected();
    await signIn(h);
    const owner = (await h.core.profiles.list()).find((profile) => profile.id === "p-owner");
    assert.ok(owner !== undefined);
    h.core.profiles.select(owner);
    new FakePlayback(h.fake);
    let serial = 0;
    const controller = new PlaybackController({
        session: h.core.session,
        avplay: new FakeAVPlay(),
        clock: h.clock,
        randomBytes: (bytes) => bytes.fill(++serial),
        device: { model: "QN55Q60AAFXZA", appVersion: "0.1.0" },
        exits: { onBack() {}, onEnd() {}, onError(error) { assert.fail(error.kind); } },
    });
    return { h, controller };
}

function key(r: Rig, transport = "other"): string {
    return readingsKey(r.h.core.session.http.base.baseUrl, r.h.core.session.account?.id, transport);
}

function ageMs(r: Rig, ms: number): number {
    return r.h.clock.now() - ms;
}

async function startBody(r: Rig): Promise<Record<string, unknown>> {
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    const starts = r.h.fake.requests.filter((request) => request.method === "POST" && request.path === "/playback/start");
    assert.equal(starts.length, 1);
    const body = starts[0]?.body;
    assert.ok(body !== undefined);
    r.controller.destroy();
    return body;
}

function capabilities(r: Rig, patch: Record<string, unknown>, drop: readonly string[] = []): void {
    const raw = fixture("playback_capability_available");
    const next: Record<string, unknown> = { ...raw, ...patch };
    for (const name of drop) delete next[name];
    const reply: Reply = { status: 200, body: next };
    r.h.fake.script("/playback/capabilities", reply);
}

test("a fresh stored reading goes out as the start's estimate with no extra request", async () => {
    const r = await rig();
    bandwidthReadings.adopt(key(r), { probe: { kbps: 48001, measuredAt: ageMs(r, 60_000) } });
    const body = await startBody(r);
    assert.equal(body.bandwidth_estimate_kbps, 48001);
    // The capability fixture advertises buffering_quality_v1, so the start opts in and names the probe as the source.
    assert.equal(body.bandwidth_estimate_source, "probe");
    assert.ok((body.client_features as string[]).includes("buffering_quality_v1"));
    assert.equal(Object.hasOwn(body, "learned_limit"), false);
    const paths = r.h.fake.requests.map((request) => `${request.method} ${request.path}`).filter((path) => path.includes("/playback"));
    assert.deepEqual(paths, ["GET /playback/capabilities", "POST /playback/start"]);
});

test("a server that does not advertise buffering_quality_v1 gets the estimate without the feature or a source", async () => {
    const r = await rig();
    const features = (fixture("playback_capability_available").features as string[]).filter((feature) => feature !== "buffering_quality_v1");
    capabilities(r, { features });
    bandwidthReadings.adopt(key(r), { probe: { kbps: 48001, measuredAt: ageMs(r, 60_000) } });
    const body = await startBody(r);
    assert.equal(body.bandwidth_estimate_kbps, 48001);
    assert.equal(Object.hasOwn(body, "bandwidth_estimate_source"), false);
    assert.equal((body.client_features as string[]).includes("buffering_quality_v1"), false);
});

test("a reading loaded by Settings reaches the next start", async () => {
    const r = await rig();
    r.h.fake.script("/playback/connection", { status: 200, body: { connection: "remote", probe: { kbps: 32000, lower_bound: false, measured_at: new Date(ageMs(r, 3_600_000)).toISOString(), transport: "wifi" } } });
    const speed = new ConnectionSpeed(r.h.core.session, () => {});
    speed.start();
    for (let step = 0; step < 20 && !r.h.fake.requests.some((request) => request.path === "/playback/connection"); step += 1) await r.h.clock.advance(0);
    await r.h.clock.advance(0);
    speed.stop();
    const body = await startBody(r);
    assert.equal(body.bandwidth_estimate_kbps, 32000);
});

test("the highest current reading wins over the probe and the playback sample", async () => {
    const r = await rig();
    bandwidthReadings.adopt(key(r), {
        probe: { kbps: 48000, measuredAt: ageMs(r, 1000) },
        sample: { kbps: 51200, measuredAt: ageMs(r, 1000) },
    });
    assert.equal((await startBody(r)).bandwidth_estimate_kbps, 51200);
});

test("a stale reading is dropped and a fresher one beside it still counts", async () => {
    const r = await rig();
    bandwidthReadings.adopt(key(r), {
        probe: { kbps: 90000, measuredAt: ageMs(r, MAX_AGE_SECONDS * 1000) },
        sample: { kbps: 20000, measuredAt: ageMs(r, MAX_AGE_SECONDS * 1000 - 1) },
    });
    assert.equal((await startBody(r)).bandwidth_estimate_kbps, 20000);
});

test("no reading, or only a stale one, sends no estimate", async () => {
    const none = await rig();
    assert.equal(Object.hasOwn(await startBody(none), "bandwidth_estimate_kbps"), false);
    const stale = await rig();
    bandwidthReadings.adopt(key(stale), { probe: { kbps: 48000, measuredAt: ageMs(stale, MAX_AGE_SECONDS * 1000 + 1) } });
    assert.equal(Object.hasOwn(await startBody(stale), "bandwidth_estimate_kbps"), false);
});

test("the server's bandwidth_probe_max_age_seconds sets the window, 7 days when it sends none", async () => {
    const short = await rig();
    capabilities(short, { bandwidth_probe_max_age_seconds: 600 });
    bandwidthReadings.adopt(key(short), { probe: { kbps: 48000, measuredAt: ageMs(short, 600_000) } });
    assert.equal(Object.hasOwn(await startBody(short), "bandwidth_estimate_kbps"), false);

    const fallback = await rig();
    capabilities(fallback, {}, ["bandwidth_probe_max_age_seconds"]);
    bandwidthReadings.adopt(key(fallback), { probe: { kbps: 48000, measuredAt: ageMs(fallback, 7 * 24 * 3_600_000 - 1) } });
    assert.equal((await startBody(fallback)).bandwidth_estimate_kbps, 48000);
});

test("a server with no speed test sends no estimate", async () => {
    const noFeature = await rig();
    const features = (fixture("playback_capability_available").features as string[]).filter((feature) => feature !== "connection_speed_v1");
    capabilities(noFeature, { features });
    bandwidthReadings.adopt(key(noFeature), { probe: { kbps: 48000, measuredAt: ageMs(noFeature, 1000) } });
    assert.equal(Object.hasOwn(await startBody(noFeature), "bandwidth_estimate_kbps"), false);

    const noUrl = await rig();
    capabilities(noUrl, {}, ["bandwidth_probe_url"]);
    bandwidthReadings.adopt(key(noUrl), { probe: { kbps: 48000, measuredAt: ageMs(noUrl, 1000) } });
    assert.equal(Object.hasOwn(await startBody(noUrl), "bandwidth_estimate_kbps"), false);
});

test("a metered or different network, or another server, sends no estimate", async () => {
    const metered = await rig();
    bandwidthReadings.adopt(key(metered, "cellular"), { probe: { kbps: 48000, measuredAt: ageMs(metered, 1000) } });
    setConnection({ type: "cellular" });
    assert.equal(Object.hasOwn(await startBody(metered), "bandwidth_estimate_kbps"), false);
    setConnection(undefined);

    const moved = await rig();
    bandwidthReadings.adopt(key(moved, "ethernet"), { probe: { kbps: 48000, measuredAt: ageMs(moved, 1000) } });
    assert.equal(Object.hasOwn(await startBody(moved), "bandwidth_estimate_kbps"), false);

    const other = await rig();
    bandwidthReadings.adopt(readingsKey("https://other.example.test", undefined, "other"), { probe: { kbps: 48000, measuredAt: ageMs(other, 1000) } });
    assert.equal(Object.hasOwn(await startBody(other), "bandwidth_estimate_kbps"), false);
});

test("a saved Test speed result replaces an older, higher playback sample", async () => {
    const r = await rig();
    bandwidthReadings.adopt(key(r), { sample: { kbps: 51200, measuredAt: ageMs(r, 60_000) } });
    bandwidthReadings.adoptMeasured(key(r), { kbps: 47999, measuredAt: ageMs(r, 1000) });
    assert.equal((await startBody(r)).bandwidth_estimate_kbps, 47999);
});

test("another account on the same server starts without the first account's reading", async () => {
    const r = await rig();
    bandwidthReadings.adopt(key(r), { probe: { kbps: 48000, measuredAt: ageMs(r, 1000) } });
    await r.h.core.session.logout();
    await signIn(r.h);
    const owner = (await r.h.core.profiles.list()).find((profile) => profile.id === "p-owner");
    assert.ok(owner !== undefined);
    r.h.core.profiles.select(owner);
    assert.equal(Object.hasOwn(await startBody(r), "bandwidth_estimate_kbps"), false);
});

test("another live account's sign-out leaves this account's reading", async () => {
    const r = await rig();
    const base = r.h.core.session.http.base.baseUrl;
    bandwidthReadings.adopt(key(r), { probe: { kbps: 48000, measuredAt: ageMs(r, 1000) } });
    bandwidthReadings.forget(readingsScope(base, "another-account"));
    bandwidthReadings.forget(readingsScope("https://other.example.test", r.h.core.session.account?.id));
    assert.equal((await startBody(r)).bandwidth_estimate_kbps, 48000);
    bandwidthReadings.forget(readingsScope(base, r.h.core.session.account?.id));
    assert.equal(bandwidthReadings.freshEstimateKbps(key(r), ageMs(r, 0), MAX_AGE_SECONDS), undefined);
});

test("a changed connection drops the old probe and a newer own probe survives an older server one", () => {
    bandwidthReadings.adoptMeasured("a", { kbps: 10000, measuredAt: 2000 });
    bandwidthReadings.adopt("a", { probe: { kbps: 20000, measuredAt: 1000 } });
    assert.equal(bandwidthReadings.freshEstimateKbps("a", 3000, 10), 10000);
    bandwidthReadings.adopt("b", {});
    assert.equal(bandwidthReadings.freshEstimateKbps("a", 3000, 10), undefined);
    assert.equal(bandwidthReadings.freshEstimateKbps("b", 3000, 10), undefined);
});
