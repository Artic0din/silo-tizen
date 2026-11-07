// Test speed: the accurate probe, then POST /playback/bandwidth-probe/results.
// BandwidthProbe.swift:31-45 and 228-354, BandwidthProbeScheduler.swift:469-473 and 762-839
// at silo-apple 2ef3a171. The quick automatic probe is not run; only the button starts a test.

import type { Clock } from "./clock.ts";
import { ApiError } from "./errors.ts";
import type { ServerBase } from "./serverUrl.ts";
import { CONNECTION_SPEED_FEATURE } from "../contracts/v2/connectionSpeed.ts";
import type { PlaybackCapabilities } from "../contracts/v2/playback.ts";
import {
    ACCURATE_PROBE_BYTES,
    AccurateProbeMeter,
    MAX_PROBE_KBPS,
    MIN_PROBE_KBPS,
    PROBE_FIRST_BYTE_DEADLINE_MS,
    PROBE_WINDOW_MS,
} from "../player/bandwidthProbe.ts";
import type { ProbeReportBody } from "./bandwidthProbeOperations.ts";

export type ProbeTransportName = "wifi" | "ethernet" | "cellular" | "other";

export interface SpeedTestNetwork {
    readonly online: boolean;
    readonly metered: boolean;
    readonly transport: ProbeTransportName;
}

export interface SpeedMeasurement {
    readonly kbps: number;
    readonly lowerBound: boolean;
    readonly bytes: number;
    readonly durationMs: number;
    readonly transport: ProbeTransportName;
    readonly measuredAt: number;
}

export type ManualSpeedTestResult =
    | { readonly kind: "measured"; readonly measurement: SpeedMeasurement }
    | { readonly kind: "notSaved"; readonly measurement: SpeedMeasurement }
    | { readonly kind: "rateLimited"; readonly seconds: number }
    | { readonly kind: "metered" }
    | { readonly kind: "failed" }
    | { readonly kind: "cancelled" };

export interface SpeedTestClient {
    readonly base: ServerBase;
    readonly clock: Clock;
    capabilities(signal: AbortSignal): Promise<PlaybackCapabilities>;
    download(url: string, signal: AbortSignal): Promise<Response>;
    /** Sent after a measurement, even if the viewer has already left. */
    report(body: ProbeReportBody): Promise<void>;
}

/**
 * The download URL: the server's `bandwidth_probe_url` plus `size` for the accurate test.
 * An https server never uses a cleartext probe URL. BandwidthProbe.swift:35-44.
 * A different origin is refused so the account token is not sent there.
 */
export function probeDownloadUrl(advertised: string, base: ServerBase, bytes: number): string | undefined {
    let url: URL;
    try {
        url = new URL(advertised, `${base.baseUrl}/`);
    } catch {
        return undefined;
    }
    const serverIsHttp = base.origin.startsWith("http:");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && serverIsHttp)) return undefined;
    if (url.username !== "" || url.password !== "" || url.hash !== "" || url.origin !== base.origin) return undefined;
    const kept = [...url.searchParams.entries()].filter(([name]) => name !== "size");
    kept.push(["size", String(bytes)]);
    url.search = "";
    for (const [name, value] of kept) url.searchParams.append(name, value);
    return url.href;
}

/** Missing or unreadable Retry-After is 30 seconds. Under a second counts as one. BandwidthProbe.swift:349-354. */
export function probeRetryAfterSeconds(header: string | null): number {
    const trimmed = header?.trim() ?? "";
    if (!/^-?\d+$/.test(trimmed)) return 30;
    return Math.max(Number(trimmed), 1);
}

/**
 * Runs Test speed against `client`. Offline, metered, unsupported and refused
 * downloads do not report a result. Leaving aborts the download and reports nothing.
 */
export async function runManualSpeedTest(client: SpeedTestClient, network: SpeedTestNetwork, signal: AbortSignal): Promise<ManualSpeedTestResult> {
    if (signal.aborted) return { kind: "cancelled" };
    if (!network.online) return { kind: "failed" };
    if (network.metered) return { kind: "metered" };
    let capabilities: PlaybackCapabilities;
    try {
        capabilities = await client.capabilities(signal);
    } catch (error) {
        if (signal.aborted || (error instanceof ApiError && error.aborted)) return { kind: "cancelled" };
        return { kind: "failed" };
    }
    if (signal.aborted) return { kind: "cancelled" };
    const advertised = capabilities.bandwidthProbeUrl;
    if (!capabilities.features.includes(CONNECTION_SPEED_FEATURE) || advertised === undefined) return { kind: "failed" };
    const url = probeDownloadUrl(advertised, client.base, ACCURATE_PROBE_BYTES);
    if (url === undefined) return { kind: "failed" };
    const download = await readAccurateProbe(client, url, signal);
    switch (download.kind) {
        case "cancelled":
            return { kind: "cancelled" };
        case "rateLimited":
            return download;
        case "failed":
            return { kind: "failed" };
        case "measured":
            break;
        default: {
            const never: never = download;
            return never;
        }
    }
    if (download.kbps < MIN_PROBE_KBPS || download.kbps > MAX_PROBE_KBPS) return { kind: "failed" };
    const measurement: SpeedMeasurement = {
        kbps: download.kbps,
        lowerBound: download.lowerBound,
        bytes: download.bytes,
        durationMs: download.durationMs,
        transport: network.transport,
        measuredAt: client.clock.now(),
    };
    const body: ProbeReportBody = {
        kbps: measurement.kbps,
        bytes: measurement.bytes,
        duration_ms: measurement.durationMs,
        transport: measurement.transport,
        manual: true,
        ...(measurement.lowerBound ? { lower_bound: true } : {}),
    };
    try {
        await client.report(body);
    } catch {
        return { kind: "notSaved", measurement };
    }
    return { kind: "measured", measurement };
}

type ProbeRead =
    | { readonly kind: "measured"; readonly kbps: number; readonly lowerBound: boolean; readonly bytes: number; readonly durationMs: number }
    | { readonly kind: "rateLimited"; readonly seconds: number }
    | { readonly kind: "failed" }
    | { readonly kind: "cancelled" };

async function readAccurateProbe(client: SpeedTestClient, url: string, signal: AbortSignal): Promise<ProbeRead> {
    const stop = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let deadlineHit = false;
    let stoppedByMeter = false;
    let firstByteAt: number | undefined;
    const onCaller = (): void => {
        stop.abort();
        void reader?.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", onCaller, { once: true });
    const deadline = client.clock.schedule(() => {
        if (firstByteAt !== undefined) return;
        deadlineHit = true;
        stop.abort();
        void reader?.cancel().catch(() => undefined);
    }, PROBE_FIRST_BYTE_DEADLINE_MS);
    const meter = new AccurateProbeMeter();
    let tick: (() => void) | undefined;
    const clearTick = (): void => {
        tick?.();
        tick = undefined;
    };
    const armTick = (): void => {
        clearTick();
        tick = client.clock.schedule(() => {
            tick = undefined;
            if (firstByteAt === undefined) return;
            if (meter.advance(client.clock.now() - firstByteAt)) {
                stoppedByMeter = true;
                void reader?.cancel().catch(() => undefined);
                return;
            }
            armTick();
        }, PROBE_WINDOW_MS);
    };
    const failedIfDeadline = (): ProbeRead | undefined => deadlineHit && firstByteAt === undefined ? { kind: "failed" } : undefined;
    try {
        let response: Response;
        try {
            response = await client.download(url, stop.signal);
        } catch (error) {
            if (signal.aborted) return { kind: "cancelled" };
            if (error instanceof ApiError && error.aborted && !deadlineHit) return { kind: "cancelled" };
            return failedIfDeadline() ?? { kind: "failed" };
        }
        if (signal.aborted) return { kind: "cancelled" };
        const missed = failedIfDeadline();
        if (missed !== undefined) return missed;
        if (response.status === 429) {
            await response.body?.cancel().catch(() => undefined);
            return { kind: "rateLimited", seconds: probeRetryAfterSeconds(response.headers.get("Retry-After")) };
        }
        if (response.status !== 200) {
            await response.body?.cancel().catch(() => undefined);
            return { kind: "failed" };
        }
        reader = response.body?.getReader();
        if (reader === undefined) return { kind: "failed" };
        const expected = contentLength(response);
        let received = 0;
        try {
            for (;;) {
                const chunk = await reader.read();
                if (signal.aborted) return { kind: "cancelled" };
                const missedByte = failedIfDeadline();
                if (missedByte !== undefined) return missedByte;
                if (stoppedByMeter) break;
                if (chunk.done) {
                    if (expected !== undefined && received < expected) return { kind: "failed" };
                    if (firstByteAt === undefined) return { kind: "failed" };
                    meter.transferEnded(client.clock.now() - firstByteAt);
                    break;
                }
                if (chunk.value.byteLength === 0) continue;
                if (firstByteAt === undefined) {
                    firstByteAt = client.clock.now();
                    deadline();
                    armTick();
                }
                received += chunk.value.byteLength;
                const elapsed = client.clock.now() - firstByteAt;
                meter.receive(chunk.value.byteLength, elapsed);
                if (meter.advance(elapsed)) {
                    stoppedByMeter = true;
                    break;
                }
            }
        } catch (error) {
            if (signal.aborted) return { kind: "cancelled" };
            if (error instanceof ApiError && error.aborted && !deadlineHit) return { kind: "cancelled" };
            if (!stoppedByMeter) return failedIfDeadline() ?? { kind: "failed" };
        }
        if (signal.aborted) return { kind: "cancelled" };
        const missedByte = failedIfDeadline();
        if (missedByte !== undefined) return missedByte;
        const measured = meter.result;
        if (measured === undefined) return { kind: "failed" };
        return { kind: "measured", kbps: measured.kbps, lowerBound: measured.lowerBound, bytes: measured.bytes, durationMs: measured.durationMs };
    } finally {
        deadline();
        clearTick();
        signal.removeEventListener("abort", onCaller);
        void reader?.cancel().catch(() => undefined);
    }
}

function contentLength(response: Response): number | undefined {
    const header = response.headers.get("Content-Length");
    if (header === null || !/^\d+$/.test(header.trim())) return undefined;
    return Number(header.trim());
}
