// A temporary password and a mailed reset link. The session owns both calls; the screens only
// show what they return. Passwords travel in the request body and are not stored or logged here.
//
// silo-server docs/auth-api.md: until the account chooses a new password, the session may call
// GET /account/me, GET /account/password/capability, POST /account/password and POST /auth/logout.
// After the change, the access token keeps the restriction until it is refreshed.

import { ApiError } from "../api/errors.ts";
import type { NativeHttp } from "../api/http.ts";
import { operations } from "../api/operations.ts";
import { NativeSession, SessionError } from "./session.ts";

/** silo-server's limits, used when the capability document can't be read. */
export interface PasswordLimits {
    readonly minimumLength: number;
    readonly maximumBytes: number;
}

export const DEFAULT_PASSWORD_LIMITS: PasswordLimits = { minimumLength: 8, maximumBytes: 72 };

/** A missing or non-positive limit keeps the server's documented default. */
export function passwordLimits(minimum: number | undefined, maximum: number | undefined): PasswordLimits {
    return {
        minimumLength: minimum !== undefined && minimum > 0 ? minimum : DEFAULT_PASSWORD_LIMITS.minimumLength,
        maximumBytes: maximum !== undefined && maximum > 0 ? maximum : DEFAULT_PASSWORD_LIMITS.maximumBytes,
    };
}

/** The server's limits, or the documented defaults when the capability can't be read. */
export async function readPasswordLimits(session: NativeSession): Promise<PasswordLimits> {
    try {
        const capability = await session.call({ ...operations.accountPasswordCapability(), profileScoped: false });
        return passwordLimits(capability.minimumPasswordLength, capability.maximumPasswordBytes);
    } catch (error) {
        if (error instanceof ApiError || error instanceof SessionError) {
            return DEFAULT_PASSWORD_LIMITS;
        }
        throw error;
    }
}

/** Replaces the account password. One request; a 401 is not replayed. */
export async function replacePassword(session: NativeSession, currentPassword: string, newPassword: string): Promise<void> {
    await session.call({
        ...operations.changePassword(currentPassword, newPassword),
        profileScoped: false,
        replayAfterRefresh: false,
    });
}

/**
 * Whether the account still holds its temporary password. Undefined when the account can't be
 * read. A server that doesn't report the flag counts as still holding it.
 */
export async function temporaryPasswordRemains(session: NativeSession): Promise<boolean | undefined> {
    try {
        const account = await session.call({ ...operations.currentAccount(), profileScoped: false });
        return account.passwordChangeRequired;
    } catch (error) {
        if (error instanceof ApiError || error instanceof SessionError) {
            return undefined;
        }
        throw error;
    }
}

/** Whether the sign-in screen offers "Forgot password?". A failure or a 404 offers nothing. */
export async function passwordResetOffered(http: NativeHttp): Promise<boolean> {
    try {
        const capability = await http.send(operations.passwordResetCapability());
        return capability.state === "available";
    } catch (error) {
        if (error instanceof ApiError) {
            return false;
        }
        throw error;
    }
}

/** Asks the server to email a reset link. The server answers alike whether or not an account matched. */
export async function requestPasswordReset(http: NativeHttp, login: string): Promise<void> {
    await http.send(operations.requestPasswordReset(login));
}
