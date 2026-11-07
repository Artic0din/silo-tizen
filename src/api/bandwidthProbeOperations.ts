// Connection-speed reads and the Test speed report.
// GET /api/v2/playback/connection and POST /api/v2/playback/bandwidth-probe/results.
// silo-apple APIv2Client+Playback.swift:91-115 at 2ef3a171. The report is non-retryable.

import type { JsonBody, RequestSpec } from "./http.ts";
import { decodePlaybackConnection, type PlaybackConnection } from "../contracts/v2/connectionSpeed.ts";

export const bandwidthProbeOperations = {
    /** Profile-scoped read of this device's reading on the connection in use. */
    playbackConnection: (): RequestSpec<PlaybackConnection> => ({
        method: "GET",
        path: "/playback/connection",
        retry: "safe",
        decode: decodePlaybackConnection,
    }),
    /**
     * One accurate measurement. `manual` is true because the viewer pressed Test speed.
     * `lower_bound` is omitted when false: that is the server's default.
     * APIv2PlaybackModels.swift:310-334.
     */
    reportBandwidthProbe: (body: ProbeReportBody): RequestSpec<undefined> => ({
        method: "POST",
        path: "/playback/bandwidth-probe/results",
        retry: "never",
        body: probeReportJson(body),
        decode: () => undefined,
    }),
};

function probeReportJson(body: ProbeReportBody): JsonBody {
    return {
        kbps: body.kbps,
        bytes: body.bytes,
        duration_ms: body.duration_ms,
        transport: body.transport,
        manual: body.manual,
        ...(body.lower_bound === undefined ? {} : { lower_bound: body.lower_bound }),
    };
}

export interface ProbeReportBody {
    readonly kbps: number;
    readonly bytes: number;
    readonly duration_ms: number;
    readonly transport: "wifi" | "ethernet" | "cellular" | "other";
    readonly manual: true;
    readonly lower_bound?: true;
}
