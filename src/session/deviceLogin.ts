// TV sign-in with an eight-digit code (device authorization, docs/architecture/device-login.md
// on the server). One attempt runs at a time; starting again or cancelling aborts the old one,
// and an answer that arrives for an abandoned attempt never signs anyone in.
//
// - Polls wait the start answer's `interval`, then each pending answer's `poll_after`.
// - A pending answer's `expires_at` moves the local deadline (an approver who opened the code
//   holds it longer). Past the deadline the code is polled once more before it is called expired.
// - No answer, 408, 429 and 5xx back off and poll again: a poll is a new request, not a replay.
//   If a lost answer had collected the tokens, the next poll reads `consumed`, which ends the
//   attempt: the tokens are handed over once and are never requested again.
// - Start is never resent after a failure; the person asks for a new code.

import { ApiError } from "../api/errors.ts";
import { sleep, type Clock } from "../api/clock.ts";
import { abortedError } from "../api/http.ts";
import { operations } from "../api/operations.ts";
import type { DeviceLoginPoll, DeviceLoginStart } from "../contracts/v2/wire.ts";
import type { VaultClear } from "./credentialVault.ts";
import { type NativeSession, type Persistence, revokeIssuedTokens } from "./session.ts";

export interface DeviceCodeView {
    /** Display form, grouped 4+4: "4821 7730". */
    readonly userCode: string;
    /** Where to type the code, e.g. https://silo.example.test/activate. */
    readonly verificationUri: string;
    /** The same page with the code filled in; the QR code's content. */
    readonly verificationUriComplete: string;
    /** Local clock, epoch ms. */
    readonly expiresAt: number;
}

export type DeviceLoginFailure =
    | "unreachable"
    | "rate_limited"
    | "server_error"
    | "unexpected_response"
    /** The server issued a temporary profile-bound session, which sign-in never asks for. */
    | "temporary_session_refused";

export type DeviceLoginState =
    | { readonly phase: "idle" }
    | { readonly phase: "starting" }
    | {
          readonly phase: "waiting";
          readonly code: DeviceCodeView;
          /** An approver has the code open: keep it on screen and say to continue on the phone. */
          readonly opened: boolean;
          readonly retrying: "none" | "rate_limited" | "unreachable";
      }
    | {
          readonly phase: "signed_in";
          readonly persistence: Persistence;
          /** `failed`: the account stored before may be restored after a restart; tell the person. */
          readonly previousSession: VaultClear;
          readonly passwordChangeRequired: boolean;
      }
    | { readonly phase: "denied" }
    | { readonly phase: "expired" }
    | { readonly phase: "canceled" }
    /** The approval was collected by an answer this TV never received. Start a new code. */
    | { readonly phase: "consumed" }
    /** The server has device sign-in turned off or does not offer it. */
    | { readonly phase: "unavailable" }
    | { readonly phase: "failed"; readonly reason: DeviceLoginFailure; readonly retryAfterSeconds: number | undefined };

export type DeviceLoginListener = (state: DeviceLoginState) => void;

interface Attempt {
    readonly controller: AbortController;
    deviceCode: string | undefined;
    cancelSupported: boolean;
    /** The server ended the request, or its tokens were collected: nothing to withdraw. */
    settled: boolean;
    stopListening: () => void;
}

const MAX_BACKOFF_SECONDS = 60;

function displayCode(userCode: string): string {
    return /^\d{4}-\d{4}$/.test(userCode) ? userCode.replace("-", " ") : userCode;
}

export class DeviceLogin {
    private readonly session: NativeSession;
    private readonly clock: Clock;
    private readonly deviceName: string;
    private readonly devicePlatform: string;
    private state: DeviceLoginState = { phase: "idle" };
    private attempt: Attempt | undefined;
    private readonly listeners: DeviceLoginListener[] = [];

    constructor(session: NativeSession, clock: Clock, deviceName: string, devicePlatform: string) {
        this.session = session;
        this.clock = clock;
        this.deviceName = deviceName;
        this.devicePlatform = devicePlatform;
    }

    get current(): DeviceLoginState {
        return this.state;
    }

    subscribe(listener: DeviceLoginListener): () => void {
        this.listeners.push(listener);
        return () => {
            const index = this.listeners.indexOf(listener);
            if (index !== -1) {
                this.listeners.splice(index, 1);
            }
        };
    }

    /** Requests a new code, withdrawing any code shown before. */
    start(): void {
        this.stopAttempt();
        const attempt: Attempt = {
            controller: new AbortController(),
            deviceCode: undefined,
            cancelSupported: false,
            settled: false,
            stopListening: () => undefined,
        };
        this.attempt = attempt;
        // Signing out, or another sign-in taking over the account, abandons this attempt. A
        // session that merely expired does not: the person is likely signing in again.
        attempt.stopListening = this.session.onAuthorityChange((change) => {
            if ((change.reason === "signed_out" || change.reason === "signed_in") && this.attempt === attempt) {
                this.cancel();
            }
        });
        this.run(attempt).catch((error: unknown) => {
            this.clock.schedule(() => {
                throw error;
            }, 0);
        });
    }

    /**
     * Leaves sign-in: stops polling and withdraws the code so it cannot be approved later. Once
     * an approval is collected its account is already signed in; cancel does nothing then, and
     * signing out ends it.
     */
    cancel(): void {
        if (this.attempt === undefined || this.attempt.settled) {
            return;
        }
        this.stopAttempt();
        this.emit({ phase: "canceled" });
    }

    private stopAttempt(): void {
        const attempt = this.attempt;
        if (attempt === undefined) {
            return;
        }
        this.attempt = undefined;
        attempt.stopListening();
        attempt.controller.abort();
        this.withdraw(attempt);
    }

    private isCurrent(attempt: Attempt): boolean {
        return this.attempt === attempt && !attempt.controller.signal.aborted;
    }

    private set(attempt: Attempt, state: DeviceLoginState): void {
        if (this.isCurrent(attempt)) {
            this.emit(state);
        }
    }

    private emit(state: DeviceLoginState): void {
        this.state = state;
        for (const listener of this.listeners.slice()) {
            listener(state);
        }
    }

    private finish(attempt: Attempt, state: DeviceLoginState, settled: boolean): void {
        if (!this.isCurrent(attempt)) {
            return;
        }
        attempt.settled = settled;
        this.attempt = undefined;
        attempt.stopListening();
        if (!settled) {
            this.withdraw(attempt);
        }
        this.emit(state);
    }

    /** Best effort, only where the server supports cancel: an abandoned code can't be approved later. */
    private withdraw(attempt: Attempt): void {
        const deviceCode = attempt.deviceCode;
        if (deviceCode === undefined || !attempt.cancelSupported || attempt.settled) {
            return;
        }
        attempt.settled = true;
        this.session.http.send(operations.cancelDeviceLogin(deviceCode)).catch((error: unknown) => {
            if (!(error instanceof ApiError)) {
                throw error;
            }
        });
    }

    private fail(attempt: Attempt, error: unknown): void {
        if (!(error instanceof ApiError)) {
            throw error;
        }
        if (error.aborted) {
            return;
        }
        const kind = error.failure.kind;
        let reason: DeviceLoginFailure = "server_error";
        if (kind === "network" || kind === "timeout") {
            reason = "unreachable";
        } else if (kind === "invalid_response") {
            reason = "unexpected_response";
        } else if (error.status === 429) {
            reason = "rate_limited";
        }
        this.finish(attempt, { phase: "failed", reason, retryAfterSeconds: error.retryAfterSeconds }, false);
    }

    private async run(attempt: Attempt): Promise<void> {
        const http = this.session.http;
        const signal = attempt.controller.signal;
        this.set(attempt, { phase: "starting" });

        let started: DeviceLoginStart;
        try {
            const capability = await http.send({ ...operations.deviceLoginCapability(), signal });
            if (!this.isCurrent(attempt)) {
                return;
            }
            if (capability.state !== "available") {
                this.finish(attempt, { phase: "unavailable" }, true);
                return;
            }
            attempt.cancelSupported = capability.cancel;
            started = await http.send({ ...operations.startDeviceLogin(this.deviceName, this.devicePlatform), signal });
        } catch (error) {
            if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
                this.finish(attempt, { phase: "unavailable" }, true);
                return;
            }
            this.fail(attempt, error);
            return;
        }
        attempt.deviceCode = started.deviceCode;
        if (!this.isCurrent(attempt)) {
            this.withdraw(attempt);
            return;
        }
        if (started.temporary) {
            this.finish(attempt, { phase: "failed", reason: "temporary_session_refused", retryAfterSeconds: undefined }, false);
            return;
        }

        const interval = Math.max(1, started.intervalSeconds);
        let deadline = this.clock.now() + Math.max(0, started.expiresInSeconds) * 1000;
        // Server clock minus local clock, to place later `expires_at` values on this clock.
        const serverOffset = started.expiresAt - deadline;
        const code = (): DeviceCodeView => ({
            userCode: displayCode(started.userCode),
            verificationUri: started.verificationUri,
            verificationUriComplete: started.verificationUriComplete,
            expiresAt: deadline,
        });
        let opened = false;
        let waitSeconds = interval;
        let backoffSeconds = 0;
        this.set(attempt, { phase: "waiting", code: code(), opened, retrying: "none" });

        for (;;) {
            try {
                await sleep(this.clock, waitSeconds * 1000, signal, abortedError);
            } catch {
                return;
            }
            const lastChance = this.clock.now() >= deadline;
            let answer: DeviceLoginPoll;
            try {
                answer = await http.send({ ...operations.pollDeviceLogin(started.deviceCode), signal });
            } catch (error) {
                if (!(error instanceof ApiError)) {
                    throw error;
                }
                if (!this.isCurrent(attempt) || error.aborted) {
                    return;
                }
                if (error.status === 404) {
                    // The server expired and removed the request.
                    this.finish(attempt, { phase: "expired" }, true);
                    return;
                }
                if (!error.transient) {
                    this.fail(attempt, error);
                    return;
                }
                if (lastChance) {
                    this.finish(attempt, { phase: "expired" }, false);
                    return;
                }
                backoffSeconds = backoffSeconds === 0 ? interval : Math.min(MAX_BACKOFF_SECONDS, backoffSeconds * 2);
                const rateLimited = error.status === 429;
                const retryAfter = error.retryAfterSeconds;
                waitSeconds = rateLimited && retryAfter !== undefined ? Math.max(interval, retryAfter) : backoffSeconds;
                this.set(attempt, { phase: "waiting", code: code(), opened, retrying: rateLimited ? "rate_limited" : "unreachable" });
                continue;
            }

            if (!this.isCurrent(attempt)) {
                if (answer.status === "approved") {
                    // Collected for an attempt nobody is waiting on: end that session on the server.
                    void revokeIssuedTokens(http, answer.tokens);
                }
                return;
            }
            backoffSeconds = 0;

            switch (answer.status) {
                case "pending":
                    opened = opened || answer.opened;
                    waitSeconds = Math.max(interval, answer.pollAfterSeconds);
                    if (answer.expiresAt !== undefined) {
                        deadline = answer.expiresAt - serverOffset;
                    }
                    if (this.clock.now() >= deadline) {
                        if (lastChance) {
                            this.finish(attempt, { phase: "expired" }, false);
                            return;
                        }
                        waitSeconds = 0;
                    }
                    this.set(attempt, { phase: "waiting", code: code(), opened, retrying: "none" });
                    continue;
                case "approved": {
                    attempt.settled = true;
                    if (answer.temporary) {
                        void revokeIssuedTokens(http, answer.tokens);
                        this.finish(attempt, { phase: "failed", reason: "temporary_session_refused", retryAfterSeconds: undefined }, true);
                        return;
                    }
                    // The install's own sign-in must not cancel this attempt. The attempt stays
                    // current while the tokens are stored, so starting again supersedes it.
                    attempt.stopListening();
                    const installed = await this.session.installDeviceLogin(answer.tokens, answer.account);
                    if (installed === undefined) {
                        // Signed out, or another sign-in took over the account, while storing.
                        this.finish(attempt, { phase: "canceled" }, true);
                        return;
                    }
                    this.finish(attempt, { phase: "signed_in", ...installed, passwordChangeRequired: answer.account.passwordChangeRequired }, true);
                    return;
                }
                case "denied":
                case "expired":
                case "canceled":
                case "consumed":
                    this.finish(attempt, { phase: answer.status }, true);
                    return;
                case "unknown":
                    this.finish(attempt, { phase: "failed", reason: "unexpected_response", retryAfterSeconds: undefined }, false);
                    return;
            }
        }
    }
}
