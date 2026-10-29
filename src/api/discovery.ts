// Confirms an address is a Silo server that speaks /api/v2 before any credential is sent to it.

import type { Clock } from "./clock.ts";
import { ApiError } from "./errors.ts";
import { type DeviceHeaders, type FetchLike, NativeHttp } from "./http.ts";
import { operations } from "./operations.ts";
import { parseServerUrl, type ServerUrlProblem } from "./serverUrl.ts";

const SUPPORTED_API_MAJOR = 2;

export interface ServerConnection {
    readonly http: NativeHttp;
    /** Stable deployment identity from getServerIdentity; self-asserted, never authorizes alone. */
    readonly serverId: string;
    readonly serverVersion: string;
}

export type DiscoveryResult =
    | { readonly status: "connected"; readonly server: ServerConnection }
    | { readonly status: "invalid_url"; readonly problem: ServerUrlProblem }
    | { readonly status: "unreachable" }
    /** Answers, but not as a Silo /api/v2 server (a v1-only alpha server, or not Silo). */
    | { readonly status: "not_silo_v2" }
    /** The request reached another origin than the one entered (redirect or misrouted proxy). */
    | { readonly status: "origin_mismatch" }
    | { readonly status: "server_error" };

export async function discoverServer(
    input: string,
    device: DeviceHeaders,
    fetch: FetchLike,
    clock: Clock,
    signal?: AbortSignal,
): Promise<DiscoveryResult> {
    const parsed = parseServerUrl(input);
    if (!parsed.ok) {
        return { status: "invalid_url", problem: parsed.problem };
    }
    const http = new NativeHttp(parsed.base, device, fetch, clock);
    try {
        const info = await http.send({ ...operations.systemInfo(), signal });
        if (info.apiMajor !== SUPPORTED_API_MAJOR) {
            return { status: "not_silo_v2" };
        }
        if (info.requestOrigin !== undefined && info.requestOrigin !== parsed.base.origin) {
            return { status: "origin_mismatch" };
        }
        const serverId = await http.send({ ...operations.serverIdentity(), signal });
        return { status: "connected", server: { http, serverId, serverVersion: info.serverVersion } };
    } catch (error) {
        if (!(error instanceof ApiError)) {
            throw error;
        }
        if (error.aborted) {
            throw error;
        }
        const kind = error.failure.kind;
        if (kind === "network" || kind === "timeout") {
            return { status: "unreachable" };
        }
        const status = error.status;
        if (kind === "invalid_response" || status === 404 || status === 410) {
            return { status: "not_silo_v2" };
        }
        return { status: "server_error" };
    }
}
