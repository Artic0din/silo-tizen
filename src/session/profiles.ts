// Household profile list, selection and PIN proof for the active session.
// Account and profile administration are out of scope.

import { ApiError } from "../api/errors.ts";
import type { Clock } from "../api/clock.ts";
import { operations } from "../api/operations.ts";
import type { ProfileSummary } from "../contracts/v2/wire.ts";
import { type NativeSession, SessionError } from "./session.ts";

export type ProfileSelection = { readonly status: "selected" } | { readonly status: "pin_required" };

export type PinResult =
    | { readonly status: "verified" }
    | { readonly status: "wrong_pin" }
    /** Too many wrong PINs; every check is refused until the delay passes. */
    | { readonly status: "locked"; readonly retryAfterSeconds: number }
    /** The server could not check it now (503); it may have counted. Ask the person to try again. */
    | { readonly status: "busy"; readonly retryAfterSeconds: number | undefined }
    /** No answer: the check may have counted toward the lockout, so it is not resent. */
    | { readonly status: "uncertain" }
    /** The access token was refreshed; the person enters the PIN again. */
    | { readonly status: "enter_again" }
    | { readonly status: "in_progress" }
    | { readonly status: "aborted" }
    | { readonly status: "signed_out" }
    | { readonly status: "failed" };

/** Used when a 429 carries no Retry-After: the server's lockout is five minutes. */
const DEFAULT_LOCKOUT_SECONDS = 300;

export class Profiles {
    private readonly session: NativeSession;
    private readonly clock: Clock;
    private readonly lockedUntil = new Map<string, number>();
    private checking = false;
    /** Increases on every select and clear; a PIN proof is installed only for the choice it was checked under. */
    private selection = 0;

    constructor(session: NativeSession, clock: Clock) {
        this.session = session;
        this.clock = clock;
    }

    list(signal?: AbortSignal): Promise<ProfileSummary[]> {
        return this.session.call({ ...operations.listProfiles(), profileScoped: false, signal });
    }

    select(profile: ProfileSummary): ProfileSelection {
        this.selection++;
        const active = this.session.activeProfile;
        if (active?.id === profile.id) {
            return { status: "selected" };
        }
        if (!profile.hasPin) {
            this.session.setProfile({ id: profile.id, token: undefined }, "profile_selected");
            return { status: "selected" };
        }
        // The old profile stops acting now, not when the PIN is accepted.
        if (active !== undefined) {
            this.session.setProfile(undefined, "profile_cleared");
        }
        return { status: "pin_required" };
    }

    clear(): void {
        this.selection++;
        if (this.session.activeProfile !== undefined) {
            this.session.setProfile(undefined, "profile_cleared");
        }
    }

    /** Seconds left on a lockout this client was told about, or 0. */
    lockoutRemainingSeconds(profileId: string): number {
        const until = this.lockedUntil.get(profileId);
        return until === undefined ? 0 : Math.max(0, Math.ceil((until - this.clock.now()) / 1000));
    }

    /** One check per call, never resent automatically. */
    async verifyPin(profileId: string, pin: string, signal?: AbortSignal): Promise<PinResult> {
        const remaining = this.lockoutRemainingSeconds(profileId);
        if (remaining > 0) {
            return { status: "locked", retryAfterSeconds: remaining };
        }
        if (this.checking) {
            return { status: "in_progress" };
        }
        this.checking = true;
        const selection = this.selection;
        try {
            const result = await this.session.call({
                ...operations.verifyProfilePin(profileId, pin),
                profileScoped: false,
                replayAfterRefresh: false,
                signal,
            });
            if (!result.valid) {
                return { status: "wrong_pin" };
            }
            this.lockedUntil.delete(profileId);
            if (this.selection !== selection) {
                return { status: "aborted" };
            }
            this.session.setProfile({ id: profileId, token: result.profileToken }, "profile_selected");
            return { status: "verified" };
        } catch (error) {
            return this.pinFailure(profileId, error);
        } finally {
            this.checking = false;
        }
    }

    private pinFailure(profileId: string, error: unknown): PinResult {
        if (error instanceof SessionError) {
            return error.reason === "unavailable"
                ? { status: "busy", retryAfterSeconds: error.retryAfterSeconds }
                : { status: "signed_out" };
        }
        if (!(error instanceof ApiError)) {
            throw error;
        }
        const kind = error.failure.kind;
        if (kind === "aborted") {
            return { status: "aborted" };
        }
        if (kind === "network" || kind === "timeout") {
            return { status: "uncertain" };
        }
        switch (error.status) {
            case 429: {
                const seconds = error.retryAfterSeconds ?? DEFAULT_LOCKOUT_SECONDS;
                this.lockedUntil.set(profileId, this.clock.now() + seconds * 1000);
                return { status: "locked", retryAfterSeconds: seconds };
            }
            case 401:
                return { status: "enter_again" };
            case 503:
                return { status: "busy", retryAfterSeconds: error.retryAfterSeconds };
            default:
                return error.status !== undefined && error.status >= 500 ? { status: "uncertain" } : { status: "failed" };
        }
    }
}
