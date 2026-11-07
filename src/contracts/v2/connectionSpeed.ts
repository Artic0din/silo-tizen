// GET /api/v2/playback/connection, the phase-2 members the Connection row reads.
// silo-apple APIv2PlaybackModels.swift:246-307 and APIv2Client+Playback.swift:91-98 at 2ef3a171.
// The server design names the same document (docs/design/2026-10-17-buffering-quality.md).

import { integer, instant, object, string, WireError } from "./wire.ts";

/** Advertised on playback capabilities when Connection speed can be shown. */
export const CONNECTION_SPEED_FEATURE = "connection_speed_v1";

export interface ConnectionProbe {
    readonly kbps: number;
    readonly measuredAt: number;
    readonly transport: string;
    /** Absent on the wire means false. APIv2PlaybackModels.swift:267-277. */
    readonly lowerBound: boolean;
}

export interface ConnectionSample {
    readonly kbps: number;
    readonly measuredAt: number;
}

export interface PlaybackConnection {
    readonly connection: string;
    readonly probe?: ConnectionProbe;
    readonly playbackSample?: ConnectionSample;
    /** The server's figure. Clients display it and do not compute it. */
    readonly autoBudgetKbps?: number;
}

/**
 * `connection` is required. A malformed probe, sample, budget or learned limit
 * is absent, matching APIv2PlaybackModels.swift:302-306.
 */
export function decodePlaybackConnection(value: unknown): PlaybackConnection {
    const path = "playback_connection";
    const obj = object(value, path);
    const connection = string(obj, "connection", path);
    const probe = obj.probe === undefined || obj.probe === null ? undefined : decodeProbe(obj.probe);
    const playbackSample = obj.playback_sample === undefined || obj.playback_sample === null ? undefined : decodeSample(obj.playback_sample);
    const autoBudgetKbps = obj.auto_budget_kbps === undefined || obj.auto_budget_kbps === null ? undefined : decodeBudget(obj.auto_budget_kbps);
    return {
        connection,
        ...(probe === undefined ? {} : { probe }),
        ...(playbackSample === undefined ? {} : { playbackSample }),
        ...(autoBudgetKbps === undefined ? {} : { autoBudgetKbps }),
    };
}

function decodeProbe(value: unknown): ConnectionProbe | undefined {
    try {
        const path = "playback_connection.probe";
        const obj = object(value, path);
        const lower = obj.lower_bound;
        if (lower !== undefined && typeof lower !== "boolean") return undefined;
        return {
            kbps: integer(obj, "kbps", path),
            measuredAt: instant(obj, "measured_at", path),
            transport: string(obj, "transport", path),
            lowerBound: lower === true,
        };
    } catch (error) {
        if (error instanceof WireError) return undefined;
        throw error;
    }
}

function decodeSample(value: unknown): ConnectionSample | undefined {
    try {
        const path = "playback_connection.playback_sample";
        const obj = object(value, path);
        return { kbps: integer(obj, "kbps", path), measuredAt: instant(obj, "measured_at", path) };
    } catch (error) {
        if (error instanceof WireError) return undefined;
        throw error;
    }
}

function decodeBudget(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
    return value;
}
