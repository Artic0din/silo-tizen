// Password sign-in (`login`), the fallback beside the device code. One request, never resent:
// the contract marks it non_retryable and every attempt spends the name's sign-in budget. The
// password goes only in that request's body; it is not kept, stored or logged here.
//
// The token pair is installed exactly as a device approval's. An answer that arrives after the
// caller gave up, or after another sign-in or sign-out took over, is revoked, never installed.

import { ApiError } from "../api/errors.ts";
import { operations } from "../api/operations.ts";
import type { TokenPair } from "../contracts/v2/wire.ts";
import { type InstallResult, type NativeSession, revokeIssuedTokens } from "./session.ts";

export type PasswordLoginResult =
    | ({ readonly status: "signed_in"; readonly passwordChangeRequired: boolean } & InstallResult)
    /** Abandoned, or another sign-in or sign-out replaced the account first. Nothing to show. */
    | { readonly status: "superseded" }
    | { readonly status: "failed"; readonly error: ApiError };

/**
 * `abandoned` does not cancel the request: a session the server already opened could then not
 * be ended. It only decides that the answer is revoked instead of installed.
 */
export async function passwordLogin(session: NativeSession, username: string, password: string, abandoned?: AbortSignal): Promise<PasswordLoginResult> {
    const generation = session.authorityGeneration;
    let pair: TokenPair;
    try {
        pair = await session.http.send(operations.login(username, password));
    } catch (error) {
        if (!(error instanceof ApiError)) {
            throw error;
        }
        return { status: "failed", error };
    }
    if (abandoned?.aborted === true || session.authorityGeneration !== generation) {
        void revokeIssuedTokens(session.http, pair.tokens);
        return { status: "superseded" };
    }
    const installed = await session.installDeviceLogin(pair.tokens, pair.account);
    if (installed === undefined) {
        return { status: "superseded" };
    }
    return { status: "signed_in", ...installed, passwordChangeRequired: pair.account.passwordChangeRequired };
}
