// An in-process Silo /api/v2 for the operations this client uses. Bodies start from the
// vendored contract fixtures; the state machine follows the server's documented rules
// (device-login.md, auth-api.md, profile-verification-tokens.md). It proves client behavior
// against the contract, not against a running server.

import { readFileSync } from "node:fs";
import type { ManualClock } from "./clock.ts";

const FIXTURES = new URL("../../../src/contracts/v2/fixtures/", import.meta.url);

export function fixture(name: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`fixture ${name} is not an object`);
    }
    return { ...parsed };
}

export interface RecordedRequest {
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Record<string, unknown> | undefined;
    readonly redirect: RequestRedirect | undefined;
}

interface DeviceRequest {
    status: "pending" | "approved" | "denied" | "consumed" | "canceled";
    opened: boolean;
    startedAt: number;
    expiresAt: number;
}

interface Hold {
    readonly path: string;
    /** Deliver the answer even after the client aborted, as when it raced the abort. */
    readonly ignoreAbort: boolean;
    release: () => void;
    readonly released: Promise<void>;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

const PROBLEM_BASE = "https://siloserver.org/docs/api/v2/problems/";

function problem(status: number, id: string, title: string, headers?: Record<string, string>): Reply {
    return {
        status,
        headers: { "Content-Type": "application/problem+json", ...headers },
        body: { type: PROBLEM_BASE + id, title, status, detail: title, instance: "urn:silo:request:000000000000000000000001" },
    };
}

export class FakeSilo {
    readonly origin = "https://silo.example.test";
    readonly serverId: string;
    readonly requests: RecordedRequest[] = [];
    /** Replies that replace the next answer for a path, first in first out. */
    readonly scripted = new Map<string, Reply[]>();
    readonly devices = new Map<string, DeviceRequest>();
    /** refresh token -> session id; access token -> session id. */
    private readonly refreshTokens = new Map<string, number>();
    private readonly accessTokens = new Map<string, number>();
    readonly revokedSessions = new Set<number>();
    readonly pins = new Map<string, string>([["p-kid", "2468"]]);
    private readonly pinRevision = new Map<string, number>([["p-kid", 1]]);
    private readonly profileTokens = new Map<string, { profileId: string; revision: number }>();
    private readonly holds: Hold[] = [];
    /** Paths whose next request is processed but whose answer is lost on the way back. */
    private readonly dropped: string[] = [];
    pinAttempts = 0;
    lockedUntil = 0;
    private nextId = 1;
    private readonly clock: ManualClock;

    constructor(clock: ManualClock, serverId = "3f2a9d5e-6b1c-4c7e-9a0d-2f4b8c1e7a35") {
        this.clock = clock;
        this.serverId = serverId;
    }

    // --- test controls ---

    open(deviceCode: string): void {
        const request = this.mustDevice(deviceCode);
        request.opened = true;
        // Every lookup holds the code at least five more minutes, never past 30 after start.
        request.expiresAt = Math.min(request.startedAt + 30 * 60000, Math.max(request.expiresAt, this.clock.now() + 5 * 60000));
    }

    approve(deviceCode: string): void {
        this.mustDevice(deviceCode).status = "approved";
    }

    deny(deviceCode: string): void {
        this.mustDevice(deviceCode).status = "denied";
    }

    /** Revokes every login session, as an administrator's account-wide revocation would. */
    revokeAllSessions(): void {
        for (const session of [...this.accessTokens.values(), ...this.refreshTokens.values()]) {
            this.revokedSessions.add(session);
        }
    }

    /** Invalidates every access token, as their expiry would. */
    expireAccessTokens(): void {
        this.accessTokens.clear();
    }

    changePin(profileId: string, pin: string): void {
        this.pins.set(profileId, pin);
        this.pinRevision.set(profileId, (this.pinRevision.get(profileId) ?? 0) + 1);
    }

    hold(path: string, ignoreAbort = false): Hold {
        let release: () => void = () => undefined;
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        const hold: Hold = { path, ignoreAbort, release, released };
        this.holds.push(hold);
        return hold;
    }

    dropNextAnswer(path: string): void {
        this.dropped.push(path);
    }

    script(path: string, ...replies: Reply[]): void {
        this.scripted.set(path, [...(this.scripted.get(path) ?? []), ...replies]);
    }

    issued(sessionId: number): { accessToken: string; refreshToken: string } {
        for (const [refreshToken, id] of this.refreshTokens) {
            if (id === sessionId) {
                for (const [accessToken, accessId] of this.accessTokens) {
                    if (accessId === sessionId) {
                        return { accessToken, refreshToken };
                    }
                }
            }
        }
        throw new Error(`no live tokens for session ${sessionId}`);
    }

    paths(): string[] {
        return this.requests.map((request) => `${request.method} ${request.path}`);
    }

    // --- transport ---

    readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
        const prefix = `${this.origin}/api/v2`;
        if (!url.startsWith(prefix)) {
            throw new TypeError("Failed to fetch");
        }
        const path = url.slice(prefix.length);
        const headers: Record<string, string> = {};
        new Headers(init.headers).forEach((value, key) => {
            headers[key.toLowerCase()] = value;
        });
        const body = typeof init.body === "string" ? toRecord(JSON.parse(init.body)) : undefined;
        const method = init.method ?? "GET";
        this.requests.push({ method, path, headers, body, redirect: init.redirect });

        const signal = init.signal ?? undefined;
        if (signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
        }
        // The server acts at once; a held answer is only delayed on its way back.
        const scripted = this.scripted.get(path)?.shift();
        const reply = scripted ?? this.route(method, path, headers, body);
        const dropIndex = this.dropped.indexOf(path);
        if (dropIndex !== -1) {
            this.dropped.splice(dropIndex, 1);
            throw new TypeError("Failed to fetch");
        }
        const holdIndex = this.holds.findIndex((candidate) => candidate.path === path);
        const hold = holdIndex === -1 ? undefined : this.holds.splice(holdIndex, 1)[0];
        if (hold !== undefined) {
            await waitOrAbort(hold.released, hold.ignoreAbort ? undefined : signal);
        }
        const responseHeaders = new Headers(reply.headers);
        if (reply.body !== undefined && !responseHeaders.has("Content-Type")) {
            responseHeaders.set("Content-Type", "application/json");
        }
        return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: responseHeaders });
    };

    private route(method: string, path: string, headers: Record<string, string>, body: Record<string, unknown> | undefined): Reply {
        const key = `${method} ${path}`;
        switch (key) {
            case "GET /system/info":
                return { status: 200, body: { ...fixture("get_system_info_ok"), request_origin: this.origin } };
            case "GET /system/identity":
                return { status: 200, body: { server_id: this.serverId } };
            case "GET /auth/device/capability":
                return { status: 200, body: fixture("get_device_login_capability_ok") };
            case "POST /auth/device/start":
                return this.startDevice();
            case "POST /auth/device/poll":
                return this.pollDevice(String(body?.device_code));
            case "POST /auth/device/cancel":
                return this.cancelDevice(String(body?.device_code));
            case "POST /auth/refresh":
                return this.refresh(String(body?.refresh_token));
            case "POST /auth/logout": {
                const session = this.authenticate(headers);
                if (session === undefined) {
                    return problem(401, "authentication_required", "Authentication required");
                }
                this.revokedSessions.add(session);
                return { status: 204 };
            }
            case "GET /profiles": {
                if (this.authenticate(headers) === undefined) {
                    return problem(401, "authentication_required", "Authentication required");
                }
                return { status: 200, body: this.profileCollection() };
            }
        }
        const pinMatch = /^\/profiles\/([^/]+)\/verify-pin$/.exec(path);
        if (method === "POST" && pinMatch?.[1] !== undefined) {
            return this.verifyPin(decodeURIComponent(pinMatch[1]), headers, String(body?.pin));
        }
        if (method === "GET" && path === "/catalog/probe") {
            return this.profileScopedRead(headers);
        }
        return problem(404, "not_found", "Not found");
    }

    private startDevice(): Reply {
        const deviceCode = `dev-${this.nextId++}`;
        const now = this.clock.now();
        this.devices.set(deviceCode, { status: "pending", opened: false, startedAt: now, expiresAt: now + 900000 });
        return {
            status: 201,
            body: { ...fixture("start_device_login_ok"), device_code: deviceCode, expires_at: new Date(now + 900000).toISOString() },
        };
    }

    private pollDevice(deviceCode: string): Reply {
        const request = this.devices.get(deviceCode);
        if (request === undefined) {
            return problem(404, "not_found", "Not found");
        }
        const base = { profile_id: "", profile_token: "", temporary: false, poll_after: 5, opened: request.opened };
        if (request.status === "pending" && this.clock.now() >= request.expiresAt) {
            return { status: 200, body: { ...base, status: "expired" } };
        }
        if (request.status === "pending") {
            return { status: 200, body: { ...fixture("poll_device_login_opened"), opened: request.opened, expires_at: new Date(request.expiresAt).toISOString() } };
        }
        if (request.status === "approved") {
            request.status = "consumed";
            const ok = fixture("poll_device_login_ok");
            const tokens = toRecord(ok.tokens);
            return { status: 200, body: { ...ok, tokens: { ...tokens, ...this.mintSession() } } };
        }
        return { status: 200, body: { ...base, status: request.status } };
    }

    private cancelDevice(deviceCode: string): Reply {
        const request = this.devices.get(deviceCode);
        if (request === undefined) {
            return { status: 404, headers: { "Content-Type": "application/problem+json" }, body: fixture("cancel_device_login_not_found") };
        }
        if (request.status === "pending" || request.status === "approved") {
            request.status = "canceled";
        }
        return { status: 200, body: { status: request.status } };
    }

    private mintSession(sessionId = this.nextId++): { access_token: string; refresh_token: string; expires_in: number } {
        const serial = this.nextId++;
        const access = `acc-${sessionId}-${serial}`;
        const refresh = `ref-${sessionId}-${serial}`;
        this.accessTokens.set(access, sessionId);
        this.refreshTokens.set(refresh, sessionId);
        return { access_token: access, refresh_token: refresh, expires_in: 3600 };
    }

    private refresh(refreshToken: string): Reply {
        const session = this.refreshTokens.get(refreshToken);
        if (session === undefined || this.revokedSessions.has(session)) {
            return { status: 401, headers: { "Content-Type": "application/problem+json" }, body: fixture("refresh_session_revoked") };
        }
        this.refreshTokens.delete(refreshToken);
        return { status: 200, body: this.mintSession(session) };
    }

    private authenticate(headers: Record<string, string>): number | undefined {
        const match = /^Bearer (.+)$/.exec(headers.authorization ?? "");
        const session = match?.[1] === undefined ? undefined : this.accessTokens.get(match[1]);
        return session === undefined || this.revokedSessions.has(session) ? undefined : session;
    }

    private profileCollection(): Record<string, unknown> {
        const collection = fixture("list_profiles_ok");
        const items = Array.isArray(collection.items) ? collection.items : [];
        const owner = toRecord(items[0]);
        return { ...collection, items: [owner, { ...owner, id: "p-kid", name: "Kid", has_pin: true, is_primary: false, is_child: true }] };
    }

    private verifyPin(profileId: string, headers: Record<string, string>, pin: string): Reply {
        if (this.authenticate(headers) === undefined) {
            return problem(401, "authentication_required", "Authentication required");
        }
        const now = this.clock.now();
        if (now < this.lockedUntil) {
            return problem(429, "rate_limited", "Rate limited", { "Retry-After": String(Math.ceil((this.lockedUntil - now) / 1000)) });
        }
        this.pinAttempts++;
        if (this.pins.get(profileId) !== pin) {
            if (this.pinAttempts >= 5) {
                this.lockedUntil = now + 300000;
            }
            return { status: 200, body: fixture("verify_profile_pin_wrong") };
        }
        this.pinAttempts = 0;
        const token = `pvt-${this.nextId++}`;
        this.profileTokens.set(token, { profileId, revision: this.pinRevision.get(profileId) ?? 0 });
        return { status: 200, body: { ...fixture("verify_profile_pin_ok"), profile_token: token } };
    }

    /** Stands for any profile-scoped catalog read the player or screens make. */
    private profileScopedRead(headers: Record<string, string>): Reply {
        if (this.authenticate(headers) === undefined) {
            return problem(401, "authentication_required", "Authentication required");
        }
        const profileId = headers["x-profile-id"];
        if (profileId !== undefined && this.pins.has(profileId)) {
            const proof = this.profileTokens.get(headers["x-profile-token"] ?? "");
            if (proof === undefined || proof.profileId !== profileId || proof.revision !== this.pinRevision.get(profileId)) {
                return { status: 403, headers: { "Content-Type": "application/problem+json" }, body: fixture("profile_verification_required") };
            }
        }
        return { status: 200, body: { profile: profileId ?? null } };
    }

    private mustDevice(deviceCode: string): DeviceRequest {
        const request = this.devices.get(deviceCode);
        if (request === undefined) {
            throw new Error(`unknown device code ${deviceCode}`);
        }
        return request;
    }
}

function toRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("expected an object");
    }
    return { ...value };
}

function waitOrAbort(released: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
    if (signal === undefined) {
        return released;
    }
    return new Promise<void>((resolve, reject) => {
        const abort = (): void => reject(new DOMException("The operation was aborted.", "AbortError"));
        if (signal.aborted) {
            abort();
            return;
        }
        signal.addEventListener("abort", abort, { once: true });
        released.then(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, reject);
    });
}
