// The single owner of one server's native account session and the active profile's proof.
// Every authenticated /api/v2 call goes through `call`, so credentials are attached, refreshed
// and withdrawn in one place.
//
// Authority changes (sign-in, sign-out, session end, profile switch, revoked PIN proof) abort
// every request made under the old authority and notify listeners, so a late answer can never
// act for an account or profile that is no longer active. The player listens for these.

import { ApiError } from "../api/errors.ts";
import type { ServerConnection } from "../api/discovery.ts";
import type { Clock } from "../api/clock.ts";
import { abortedError, type NativeHttp, type RequestSpec } from "../api/http.ts";
import { operations } from "../api/operations.ts";
import type { AccountSummary, IssuedTokens } from "../contracts/v2/wire.ts";
import type { CredentialVault, StoredCredential, VaultClear } from "./credentialVault.ts";

export type AuthorityChangeReason =
    | "signed_in"
    | "signed_out"
    /** The server refused the refresh: signed out without asking. */
    | "session_expired"
    | "profile_selected"
    | "profile_cleared"
    /** The server stopped accepting the profile's PIN proof (PIN changed, proof expired). */
    | "profile_proof_revoked";

export interface AuthorityChange {
    readonly reason: AuthorityChangeReason;
    /** Increases on every change; work started under an older value must stop. */
    readonly generation: number;
}

export type AuthorityListener = (change: AuthorityChange) => void;

export type RestoreResult = "signed_in" | "signed_out" | "storage_corrupt" | "storage_unavailable";

export type Persistence = "persistent" | "session_only";

export type RefreshOutcome =
    | { readonly status: "refreshed" }
    | { readonly status: "session_ended" }
    /** Server or network unavailable; tokens kept, try again after the delay. */
    | { readonly status: "unavailable"; readonly retryAfterSeconds: number | undefined }
    | { readonly status: "aborted" }
    | { readonly status: "signed_out" };

export interface InstallResult {
    readonly persistence: Persistence;
    /** How the record of the session stored before was removed; `failed`: it may be restored after a restart. */
    readonly previousSession: VaultClear;
}

export interface LogoutResult {
    readonly storage: VaultClear;
    readonly server: "revoked" | "already_ended" | "unreachable" | "not_signed_in";
}

export interface ActiveProfile {
    readonly id: string;
    /** X-Profile-Token for a PIN-locked profile; held in memory only. */
    readonly token: string | undefined;
}

export type AuthorizedSpec<T> = Omit<RequestSpec<T>, "bearer" | "profile"> & {
    /** Attach X-Profile-Id/X-Profile-Token of the active profile. */
    readonly profileScoped: boolean;
    /** Resend once after a 401 and a successful refresh. False for non-retryable checks (PIN). */
    readonly replayAfterRefresh?: boolean;
};

export class SessionError extends Error {
    readonly reason: "signed_out" | "session_ended" | "unavailable";
    readonly retryAfterSeconds: number | undefined;

    constructor(reason: SessionError["reason"], retryAfterSeconds?: number) {
        super(`Session ${reason}`);
        this.name = "SessionError";
        this.reason = reason;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

/** Refresh this long before the access token's stated expiry. */
const REFRESH_SKEW_MS = 30000;
const LOGOUT_TIMEOUT_MS = 5000;

export class NativeSession {
    readonly server: ServerConnection;
    private readonly vault: CredentialVault;
    private readonly clock: Clock;
    private credential: StoredCredential | undefined;
    private profile: ActiveProfile | undefined;
    private persistenceMode: Persistence;
    /** Increases on every sign-in and sign-out; a refresh from an older epoch is discarded. */
    private accountEpoch = 0;
    private generation = 0;
    /** Aborted when the account changes: refreshes. */
    private accountController = new AbortController();
    /** Aborted on any authority change: API calls. */
    private authorityController = new AbortController();
    private refreshing: Promise<RefreshOutcome> | undefined;
    private readonly listeners: AuthorityListener[] = [];

    constructor(server: ServerConnection, vault: CredentialVault, clock: Clock) {
        this.server = server;
        this.vault = vault;
        this.clock = clock;
        this.persistenceMode = vault.persistent ? "persistent" : "session_only";
    }

    get http(): NativeHttp {
        return this.server.http;
    }

    get signedIn(): boolean {
        return this.credential !== undefined;
    }

    get account(): { readonly id: string; readonly username: string } | undefined {
        const credential = this.credential;
        return credential === undefined ? undefined : { id: credential.accountId, username: credential.username };
    }

    get persistence(): Persistence {
        return this.persistenceMode;
    }

    get activeProfile(): ActiveProfile | undefined {
        return this.profile;
    }

    get authorityGeneration(): number {
        return this.generation;
    }

    /** Aborts when the current account or profile authority ends. */
    get authoritySignal(): AbortSignal {
        return this.authorityController.signal;
    }

    onAuthorityChange(listener: AuthorityListener): () => void {
        this.listeners.push(listener);
        return () => {
            const index = this.listeners.indexOf(listener);
            if (index !== -1) {
                this.listeners.splice(index, 1);
            }
        };
    }

    async restore(): Promise<RestoreResult> {
        const loaded = await this.vault.load();
        switch (loaded.status) {
            case "found":
                if (loaded.credential.serverId !== this.server.serverId) {
                    // Another deployment now answers at this address: its tokens are not ours to send.
                    await this.vault.clear();
                    return "signed_out";
                }
                this.beginAccount(loaded.credential);
                return "signed_in";
            case "none":
                return "signed_out";
            case "corrupt":
                return "storage_corrupt";
            case "unavailable":
                return "storage_unavailable";
        }
    }

    /**
     * Takes the tokens a device sign-in collected. Undefined when a sign-out or another sign-in
     * replaced this account while it was being stored.
     */
    async installDeviceLogin(tokens: IssuedTokens, account: AccountSummary): Promise<InstallResult | undefined> {
        const credential: StoredCredential = {
            baseUrl: this.http.base.baseUrl,
            serverId: this.server.serverId,
            accountId: account.id,
            username: account.username,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            accessExpiresAt: this.clock.now() + tokens.expiresInSeconds * 1000,
        };
        const replaced = this.credential;
        this.beginAccount(credential);
        if (replaced !== undefined) {
            // This TV drops the replaced session's tokens; end it on the server rather than leave it open.
            void revokeIssuedTokens(this.http, replaced);
        }
        const epoch = this.accountEpoch;
        // Whatever was stored before (even an account this run could not read) must not come
        // back after a restart if this save fails.
        const previousSession = await this.vault.clear();
        const current = this.credential;
        if (this.accountEpoch !== epoch || current === undefined) {
            return undefined;
        }
        // Refresh may rotate the pair while cleanup is pending.
        const saved = await this.vault.save(current);
        if (this.accountEpoch !== epoch) {
            return undefined;
        }
        this.persistenceMode = this.vault.persistent && saved === "saved" ? "persistent" : "session_only";
        return { persistence: this.persistenceMode, previousSession };
    }

    async call<T>(spec: AuthorizedSpec<T>): Promise<T> {
        // The call acts for the authority it started under; after every wait, a change of
        // authority or the caller's abort ends it (the transport returns answers that complete late).
        const generation = this.generation;
        const ensureCurrent = (): void => {
            if (this.generation !== generation || spec.signal?.aborted === true) {
                throw abortedError();
            }
        };
        let replayed = false;
        for (;;) {
            let credential = this.credential;
            if (credential === undefined) {
                throw new SessionError("signed_out");
            }
            if (credential.accessExpiresAt - this.clock.now() <= REFRESH_SKEW_MS) {
                throwUnlessRefreshed(await this.refresh());
                ensureCurrent();
                credential = this.credential;
                if (credential === undefined) {
                    throw new SessionError("signed_out");
                }
            }
            const profile = spec.profileScoped ? this.profile : undefined;
            const linked = linkSignals(this.authorityController.signal, spec.signal);
            try {
                const result = await this.http.send({ ...spec, bearer: credential.accessToken, profile, signal: linked.signal });
                ensureCurrent();
                return result;
            } catch (error) {
                if (!(error instanceof ApiError)) {
                    throw error;
                }
                ensureCurrent();
                if (error.status === 401 && !replayed) {
                    const outcome = await this.refreshAfterRejection(credential);
                    throwUnlessRefreshed(outcome);
                    ensureCurrent();
                    if (spec.replayAfterRefresh !== false) {
                        replayed = true;
                        continue;
                    }
                }
                if (error.status === 403 && error.problemId === "profile_verification_required" && profile?.token !== undefined && this.profile === profile) {
                    this.setProfile(undefined, "profile_proof_revoked");
                }
                throw error;
            } finally {
                linked.dispose();
            }
        }
    }

    /** Single-flight: concurrent callers share one refresh request. */
    refresh(): Promise<RefreshOutcome> {
        if (this.refreshing !== undefined) {
            return this.refreshing;
        }
        const credential = this.credential;
        if (credential === undefined) {
            return Promise.resolve<RefreshOutcome>({ status: "signed_out" });
        }
        const run = this.refreshNow(credential, this.accountEpoch).then((outcome) => {
            if (this.refreshing === run) {
                this.refreshing = undefined;
            }
            return outcome;
        });
        this.refreshing = run;
        return run;
    }

    /** Ends the session here first, so it holds even offline; then asks the server to revoke it. */
    async logout(): Promise<LogoutResult> {
        const credential = this.credential;
        const storage = await this.endAccount("signed_out");
        if (credential === undefined) {
            return { storage, server: "not_signed_in" };
        }
        return { storage, server: await revokeIssuedTokens(this.http, credential) };
    }

    /** Used by Profiles; switching aborts the old profile's requests and notifies listeners. */
    setProfile(profile: ActiveProfile | undefined, reason: AuthorityChangeReason): void {
        this.profile = profile;
        this.bump(reason);
    }

    private refreshAfterRejection(rejected: StoredCredential): Promise<RefreshOutcome> {
        const current = this.credential;
        if (current !== undefined && current.accessToken !== rejected.accessToken) {
            // Another caller already refreshed while this request was out.
            return Promise.resolve<RefreshOutcome>({ status: "refreshed" });
        }
        return this.refresh();
    }

    private async refreshNow(credential: StoredCredential, epoch: number): Promise<RefreshOutcome> {
        try {
            const tokens = await this.http.send({
                ...operations.refreshSession(credential.refreshToken),
                signal: this.accountController.signal,
            });
            if (this.accountEpoch !== epoch) {
                // The server may have rotated before the account change aborted this request.
                await revokeIssuedTokens(this.http, tokens);
                return { status: "aborted" };
            }
            const next: StoredCredential = {
                ...credential,
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                accessExpiresAt: this.clock.now() + tokens.expiresInSeconds * 1000,
            };
            this.credential = next;
            const saved = await this.vault.save(next);
            if (this.accountEpoch !== epoch) {
                return { status: "aborted" };
            }
            this.persistenceMode = this.vault.persistent && saved === "saved" ? "persistent" : "session_only";
            return { status: "refreshed" };
        } catch (error) {
            if (!(error instanceof ApiError)) {
                throw error;
            }
            if (this.accountEpoch !== epoch || error.aborted) {
                return { status: "aborted" };
            }
            const status = error.status;
            // 401: refused (session_expired, invalid_token). 400/422: this refresh token can never work.
            if (status === 401 || status === 400 || status === 422) {
                await this.endAccount("session_expired");
                return { status: "session_ended" };
            }
            return { status: "unavailable", retryAfterSeconds: error.retryAfterSeconds };
        }
    }

    private beginAccount(credential: StoredCredential): void {
        this.resetAccount();
        this.credential = credential;
        this.bump("signed_in");
    }

    private endAccount(reason: "signed_out" | "session_expired"): Promise<VaultClear> {
        this.resetAccount();
        this.bump(reason);
        return this.vault.clear();
    }

    private resetAccount(): void {
        this.credential = undefined;
        this.profile = undefined;
        this.refreshing = undefined;
        this.accountEpoch++;
        this.accountController.abort();
        this.accountController = new AbortController();
    }

    private bump(reason: AuthorityChangeReason): void {
        this.generation++;
        this.authorityController.abort();
        this.authorityController = new AbortController();
        const change: AuthorityChange = { reason, generation: this.generation };
        for (const listener of this.listeners.slice()) {
            try {
                listener(change);
            } catch (error) {
                // A failing listener must not stop the authority change; surface it as uncaught.
                this.clock.schedule(() => {
                    throw error;
                }, 0);
            }
        }
    }
}

function throwUnlessRefreshed(outcome: RefreshOutcome): void {
    switch (outcome.status) {
        case "refreshed":
            return;
        case "unavailable":
            throw new SessionError("unavailable", outcome.retryAfterSeconds);
        case "session_ended":
            throw new SessionError("session_ended");
        case "aborted":
            throw abortedError();
        case "signed_out":
            throw new SessionError("signed_out");
    }
}

/**
 * Best-effort server revocation of tokens this client will not keep (logout, an account another
 * sign-in replaced, or an approval that arrived for an abandoned sign-in). The tokens are never
 * stored or reused.
 */
export async function revokeIssuedTokens(
    http: NativeHttp,
    tokens: { readonly accessToken: string; readonly refreshToken: string },
): Promise<"revoked" | "already_ended" | "unreachable"> {
    try {
        await http.send({ ...operations.logout(), bearer: tokens.accessToken, timeoutMs: LOGOUT_TIMEOUT_MS });
        return "revoked";
    } catch (error) {
        if (!(error instanceof ApiError)) {
            throw error;
        }
        if (error.status !== 401) {
            return "unreachable";
        }
    }
    // The access token expired; exchange the refresh token once to revoke the session itself.
    try {
        const fresh = await http.send({ ...operations.refreshSession(tokens.refreshToken), timeoutMs: LOGOUT_TIMEOUT_MS });
        await http.send({ ...operations.logout(), bearer: fresh.accessToken, timeoutMs: LOGOUT_TIMEOUT_MS });
        return "revoked";
    } catch (error) {
        if (!(error instanceof ApiError)) {
            throw error;
        }
        return error.status === 401 ? "already_ended" : "unreachable";
    }
}

function linkSignals(authority: AbortSignal, caller: AbortSignal | undefined): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (authority.aborted || caller?.aborted) {
        controller.abort();
    }
    authority.addEventListener("abort", abort, { once: true });
    caller?.addEventListener("abort", abort, { once: true });
    return {
        signal: controller.signal,
        dispose: () => {
            authority.removeEventListener("abort", abort);
            caller?.removeEventListener("abort", abort);
        },
    };
}
