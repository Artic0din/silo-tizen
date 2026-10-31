// The one place that sends HTTPS requests to Silo's native /api/v2.
// Session code decides which credentials to attach; this module only transports them.

import { decodeProblem, type Problem, WireError } from "../contracts/v2/wire.ts";
import { type Clock, sleep } from "./clock.ts";
import { ApiError } from "./errors.ts";
import type { ServerBase } from "./serverUrl.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface DeviceHeaders {
    readonly id: string;
    readonly name: string;
    readonly platform: string;
}

export interface ProfileHeaders {
    readonly id: string;
    readonly token: string | undefined;
}

/**
 * `safe`: the operation may be sent again after no answer or a gateway/availability failure
 * (reads and operations the contract marks natural_idempotent).
 * `never`: the contract marks it non_retryable or domain_identity, or a replay could repeat an
 * effect (device start, poll, PIN check, refresh). The caller decides what happens next.
 */
export type RetryPolicy = "safe" | "never";

export type JsonValue = null | string | number | boolean | readonly JsonValue[] | { readonly [key: string]: JsonValue | undefined };

/** A JSON object body; members set to undefined are omitted on the wire. */
export type JsonBody = { readonly [key: string]: JsonValue | undefined };

export interface RequestSpec<T> {
    readonly method: "GET" | "POST" | "PUT" | "DELETE";
    /** Operation path below /api/v2, starting with "/". */
    readonly path: string;
    readonly retry: RetryPolicy;
    readonly decode: (body: unknown) => T;
    readonly body?: JsonBody;
    readonly bearer?: string;
    readonly profile?: ProfileHeaders | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1000;
/** A longer Retry-After is the caller's decision, not a transport retry. */
const MAX_RETRY_AFTER_SECONDS = 5;
const RETRYABLE_STATUSES = [502, 503, 504];

export class NativeHttp {
    async subtitleText(url: string, signal: AbortSignal): Promise<string> {
        const address = new URL(url);
        if (address.protocol !== "https:" || address.username || address.password) throw new Error("Invalid subtitle URL");
        const abort = new AbortController();
        const cancel = (): void => abort.abort();
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        const timeout = this.clock.schedule(cancel, DEFAULT_TIMEOUT_MS);
        try {
            const response = await this.fetch(address.href, { signal: abort.signal, credentials: "omit", redirect: "error" });
            if (!response.ok || Number(response.headers.get("Content-Length")) > 4 * 1024 * 1024) throw new Error("Subtitle download failed");
            const text = await response.text();
            if (text.length > 4 * 1024 * 1024) throw new Error("Subtitle file too large");
            return text;
        } finally {
            timeout();
            signal.removeEventListener("abort", cancel);
        }
    }
    readonly base: ServerBase;
    get deviceId(): string { return this.device.id; }
    private readonly device: DeviceHeaders;
    private readonly fetch: FetchLike;
    private readonly clock: Clock;

    constructor(base: ServerBase, device: DeviceHeaders, fetch: FetchLike, clock: Clock) {
        this.base = base;
        this.device = device;
        this.fetch = fetch;
        this.clock = clock;
    }

    async send<T>(spec: RequestSpec<T>): Promise<T> {
        for (let attempt = 1; ; attempt++) {
            try {
                return await this.sendOnce(spec);
            } catch (error) {
                if (!(error instanceof ApiError) || !this.mayRetry(spec, error, attempt)) {
                    throw error;
                }
                const delayMs = error.retryAfterSeconds === undefined ? RETRY_DELAY_MS : error.retryAfterSeconds * 1000;
                await sleep(this.clock, delayMs, spec.signal ?? neverAborts(), abortedError);
            }
        }
    }

    private mayRetry(spec: RequestSpec<unknown>, error: ApiError, attempt: number): boolean {
        if (spec.retry !== "safe" || attempt >= MAX_ATTEMPTS) {
            return false;
        }
        const kind = error.failure.kind;
        if (kind === "network" || kind === "timeout") {
            return true;
        }
        const status = error.status;
        const retryAfter = error.retryAfterSeconds;
        return (
            status !== undefined &&
            RETRYABLE_STATUSES.indexOf(status) !== -1 &&
            (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_SECONDS)
        );
    }

    private async sendOnce<T>(spec: RequestSpec<T>): Promise<T> {
        const controller = new AbortController();
        const callerSignal = spec.signal;
        if (callerSignal?.aborted) {
            throw abortedError();
        }
        let timedOut = false;
        const onCallerAbort = (): void => controller.abort();
        callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
        const cancelTimeout = this.clock.schedule(() => {
            timedOut = true;
            controller.abort();
        }, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);

        try {
            let response: Response;
            try {
                response = await this.fetch(this.base.apiRoot + spec.path, {
                    method: spec.method,
                    headers: this.headers(spec),
                    body: spec.body === undefined ? null : JSON.stringify(spec.body),
                    signal: controller.signal,
                    // A redirect could carry the bearer or the request body to another origin.
                    redirect: "error",
                    credentials: "omit",
                    cache: "no-store",
                });
            } catch {
                throw new ApiError(timedOut ? { kind: "timeout" } : controller.signal.aborted ? { kind: "aborted" } : { kind: "network" });
            }
            let text: string;
            try {
                text = await response.text();
            } catch {
                throw new ApiError(timedOut ? { kind: "timeout" } : controller.signal.aborted ? { kind: "aborted" } : { kind: "network" });
            }
            // A complete answer is returned even if the caller aborted meanwhile: callers check
            // whether it is still current, and an orphaned approval must be seen to be revoked.
            return decodeResponse(response, text, spec.decode);
        } finally {
            cancelTimeout();
            callerSignal?.removeEventListener("abort", onCallerAbort);
        }
    }

    private headers(spec: RequestSpec<unknown>): Record<string, string> {
        const headers: Record<string, string> = {
            Accept: "application/json, application/problem+json",
            "X-Silo-Device-Id": this.device.id,
            "X-Silo-Device-Name": this.device.name,
            "X-Silo-Device-Platform": this.device.platform,
        };
        if (spec.body !== undefined) {
            headers["Content-Type"] = "application/json";
        }
        if (spec.bearer !== undefined) {
            headers.Authorization = `Bearer ${spec.bearer}`;
        }
        if (spec.profile !== undefined) {
            headers["X-Profile-Id"] = spec.profile.id;
            if (spec.profile.token !== undefined) {
                headers["X-Profile-Token"] = spec.profile.token;
            }
        }
        return headers;
    }
}

function decodeResponse<T>(response: Response, text: string, decode: (body: unknown) => T): T {
    const mediaType = (response.headers.get("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    const retryAfterSeconds = parseRetryAfter(response.headers.get("Retry-After"));

    if (response.status >= 200 && response.status < 300) {
        if (response.status === 204 || text === "") {
            return wireDecode(decode, undefined);
        }
        if (mediaType !== "application/json") {
            throw new ApiError({ kind: "invalid_response", path: "content-type" });
        }
        return wireDecode(decode, parseJson(text));
    }

    const problem = mediaType === "application/problem+json" ? readProblem(text, response.status) : undefined;
    throw new ApiError(
        problem === undefined
            ? { kind: "http", status: response.status, retryAfterSeconds }
            : { kind: "problem", problem, retryAfterSeconds },
    );
}

/** A malformed problem body still reports its HTTP status rather than failing decoding. */
function readProblem(text: string, status: number): Problem | undefined {
    try {
        const problem = decodeProblem(JSON.parse(text));
        return problem.status === status ? problem : undefined;
    } catch (error) {
        if (error instanceof WireError || error instanceof SyntaxError) {
            return undefined;
        }
        throw error;
    }
}

function wireDecode<T>(decode: (body: unknown) => T, body: unknown): T {
    try {
        return decode(body);
    } catch (error) {
        if (error instanceof WireError) {
            throw new ApiError({ kind: "invalid_response", path: error.path });
        }
        throw error;
    }
}

function parseJson(text: string): unknown {
    try {
        const parsed: unknown = JSON.parse(text);
        return parsed;
    } catch {
        throw new ApiError({ kind: "invalid_response", path: "body" });
    }
}

/** Retry-After in delta-seconds, the only form v2 sends. */
function parseRetryAfter(value: string | null): number | undefined {
    if (value === null || !/^\d+$/.test(value.trim())) {
        return undefined;
    }
    return Number(value.trim());
}

export function abortedError(): ApiError {
    return new ApiError({ kind: "aborted" });
}

function neverAborts(): AbortSignal {
    return new AbortController().signal;
}
