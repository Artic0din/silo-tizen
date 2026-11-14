// Public entry point for screens and the player: connect to one server, restore its session,
// sign in with a device code, choose a profile, sign out.

import { type Clock, systemClock } from "../api/clock.ts";
import { clearBrowseCache } from "./browseCache.ts";
import { bandwidthReadings, readingsScope } from "../player/bandwidthReadings.ts";
import { discoverServer, failedDiscovery, type DiscoveryResult, type ServerConnection } from "../api/discovery.ts";
import { NativeHttp, type FetchLike } from "../api/http.ts";
import { ApiError } from "../api/errors.ts";
import { operations } from "../api/operations.ts";
import { parseServerUrl, type ServerUrlProblem } from "../api/serverUrl.ts";
import type { SetupStatus } from "../contracts/v2/wire.ts";
import { CredentialVault, type VaultClear } from "./credentialVault.ts";
import { DeviceLogin } from "./deviceLogin.ts";
import { deviceHeaders, loadDeviceId, type PublicStorage, type RandomBytes } from "./deviceIdentity.ts";
import { Profiles } from "./profiles.ts";
import { ProfileLaunch } from "./profileLaunch.ts";
import { openSecretStore, type TizenKeyManager } from "./secretStore.ts";
import { NativeSession, type RestoreResult } from "./session.ts";
import { AccountDirectory, AccountVault, type SavedAccount } from "./accounts.ts";
import type { SecretStore } from "./secretStore.ts";

export interface SessionCoreDeps {
    readonly allowOfflineRestore?: boolean;
    readonly transientAccounts?: { readonly secrets: SecretStore; readonly storage: PublicStorage };
    readonly fetch: FetchLike;
    /** localStorage; public device identity, account metadata and logout floors, never tokens. */
    readonly publicStorage: PublicStorage | undefined;
    /** `findTizenKeyManager()` on a TV; undefined keeps credentials in memory for this run. */
    readonly keyManager: TizenKeyManager | undefined;
    readonly randomBytes: RandomBytes;
    /** e.g. webapis.productinfo.getRealModel(); shown to the approver and in session lists. */
    readonly deviceName: string;
    readonly devicePlatform: string;
    readonly clock?: Clock;
    readonly localAccountId?: string;
    readonly addAccount?: boolean;
    readonly reuseAccount?: (baseUrl: string, accountId: string) => ConnectedServer | undefined;
    readonly beforeAccountSignIn?: (baseUrl: string, accountId: string) => Promise<void>;
    readonly beforeAccountSignOut?: (baseUrl: string, accountId: string) => Promise<void>;
}

export interface ConnectedServer {
    readonly status: "connected";
    readonly localRestore?: boolean;
    readonly server: ServerConnection;
    readonly session: NativeSession;
    readonly profiles: Profiles;
    readonly profileLaunch: ProfileLaunch;
    readonly restore: RestoreResult;
    readonly accounts: AccountVault;
    /** A fresh sign-in flow; call `start()` to show a code. */
    createDeviceLogin(): DeviceLogin;
}

/** The address answered, and `needs_setup` is still true. No session is opened. */
export interface ServerNeedsSetup {
    readonly status: "needs_setup";
    readonly server: ServerConnection;
}

export type ConnectResult = ConnectedServer | ServerNeedsSetup | Exclude<DiscoveryResult, { readonly status: "connected" }>;

/** Opens a session on a server discovery has already accepted. */
export async function openDiscoveredServer(server: ServerConnection, deps: SessionCoreDeps): Promise<ConnectedServer> {
    return openServerSession(server, deps, "online");
}

function openServerSession(server: ServerConnection, deps: SessionCoreDeps, mode: "online"): Promise<ConnectedServer>;
function openServerSession(server: ServerConnection, deps: SessionCoreDeps, mode: "offline"): Promise<ConnectedServer | { readonly status: "unreachable"; readonly restore?: RestoreResult }>;
async function openServerSession(server: ServerConnection, deps: SessionCoreDeps, mode: "online" | "offline"): Promise<ConnectedServer | { readonly status: "unreachable"; readonly restore?: RestoreResult }> {
    const clock = deps.clock ?? systemClock;
    const device = deviceHeaders(loadDeviceId(deps.publicStorage, deps.randomBytes), deps.deviceName, deps.devicePlatform);
    let session: NativeSession;
    const offlineDiscovery = mode === "offline";
    if (offlineDiscovery) {
        let verified = false;
        let checking: Promise<void> | undefined;
        const requireMatchingDeployment = async (generation: number): Promise<DiscoveryResult> => {
            const fresh = await discoverServer(server.http.base.baseUrl, device, deps.fetch, clock, session.authoritySignal);
            if (generation !== session.authorityGeneration) throw new ApiError({ kind: "aborted" });
            if (fresh.status !== "connected") return fresh;
            if (fresh.server.serverId !== server.serverId) {
                await session.deploymentChanged();
                throw new ApiError({ kind: "aborted" });
            }
            return fresh;
        };
        const verify = async (): Promise<void> => {
            if (verified) return;
            const generation = session.authorityGeneration;
            const fresh = await requireMatchingDeployment(generation);
            if (fresh.status !== "connected") {
                throw new ApiError(fresh.status === "unreachable" || (fresh.status === "server_error" && fresh.transient) ? { kind: "network" } : { kind: "invalid_response", path: "/system/identity" });
            }
            const setup = await fresh.server.http.send({ ...operations.setupStatus(), signal: session.authoritySignal });
            if (generation !== session.authorityGeneration) throw new ApiError({ kind: "aborted" });
            if (setup.needsSetup) throw new ApiError({ kind: "invalid_response", path: "/system/setup" });
            // Identity can change between setup and the first credentialed call; reconfirm before releasing them.
            const confirmed = await requireMatchingDeployment(generation);
            if (confirmed.status !== "connected") {
                throw new ApiError(confirmed.status === "unreachable" || (confirmed.status === "server_error" && confirmed.transient) ? { kind: "network" } : { kind: "invalid_response", path: "/system/identity" });
            }
            verified = true;
        };
        const check = (): Promise<void> => {
            checking ??= verify().finally(() => { checking = undefined; });
            return checking;
        };
        server = { ...server, http: new NativeHttp(server.http.base, device, deps.fetch, clock, check) };
    }
    let vault: AccountVault;
    const transient = deps.keyManager === undefined ? deps.transientAccounts : undefined;
    try { vault = new AccountVault(transient?.secrets ?? openSecretStore(deps.keyManager), transient?.storage ?? deps.publicStorage, server.http.base.baseUrl, deps.randomBytes, deps.localAccountId, deps.addAccount, transient?.storage); }
    catch {
        // Unreadable metadata must not overwrite saved accounts; sign-in can still be session-only.
        vault = new AccountVault(deps.transientAccounts?.secrets ?? openSecretStore(undefined), deps.transientAccounts?.storage, server.http.base.baseUrl, deps.randomBytes, undefined, true, deps.transientAccounts?.storage);
    }
    if (offlineDiscovery) {
        const saved = await vault.load();
        if (saved.status !== "found") return { status: "unreachable", ...(saved.status === "corrupt" ? { restore: "storage_corrupt" as const } : saved.status === "unavailable" ? { restore: "storage_unavailable" as const } : {}) };
        if (saved.credential.serverId !== server.serverId) return { status: "unreachable" };
    }
    session = new NativeSession(server, vault, clock, deps.randomBytes, async accountId => {
        await deps.beforeAccountSignIn?.(server.http.base.baseUrl, accountId);
    });
    watchBrowseCache(session, deps.publicStorage, deps.keyManager, server.serverId, vault.directory.list().find(row => row.id === vault.localAccountId)?.accountId);
    watchBandwidthReadings(session);
    const restore = await session.restore();
    if (offlineDiscovery && restore !== "signed_in") return { status: "unreachable" };
    // Offline restoration must keep the deployment gate; a live online session has none.
    if (!offlineDiscovery && restore === "signed_in" && session.account) {
        const cached = deps.reuseAccount?.(server.http.base.baseUrl, session.account.id);
        if (cached?.session.signedIn && cached.server.serverId === server.serverId) return { ...cached, restore: "signed_in" };
    }
    return {
        status: "connected",
        ...(offlineDiscovery ? { localRestore: true } : {}),
        server,
        session,
        profiles: new Profiles(session, clock),
        profileLaunch: new ProfileLaunch(session, deps.publicStorage, openSecretStore(deps.keyManager), deps.randomBytes, server.serverId),
        restore,
        accounts: vault,
        createDeviceLogin: () => new DeviceLogin(session, clock, device.name, device.platform),
    };
}

export async function connect(serverAddress: string, deps: SessionCoreDeps, signal?: AbortSignal): Promise<ConnectResult> {
    const clock = deps.clock ?? systemClock;
    const device = deviceHeaders(loadDeviceId(deps.publicStorage, deps.randomBytes), deps.deviceName, deps.devicePlatform);
    const savedServer = (): ServerConnection | undefined => {
        if (deps.allowOfflineRestore === false || deps.addAccount || signal?.aborted) return;
        const parsed = parseServerUrl(serverAddress);
        if (!parsed.ok) return;
        try {
            const transient = deps.keyManager === undefined ? deps.transientAccounts : undefined;
            const directory = new AccountDirectory(transient?.storage ?? deps.publicStorage, deps.randomBytes);
            const saved = directory.list().find(row => row.id === (deps.localAccountId ?? directory.selected) && row.baseUrl === parsed.base.baseUrl && !row.needsSignIn);
            if (saved !== undefined) return { http: new NativeHttp(parsed.base, device, deps.fetch, clock), serverId: saved.serverId, serverVersion: "" };
        } catch { /* Unreadable local identity cannot authorize an offline restore. */ }
        return;
    };
    let localFailure: RestoreResult | undefined;
    if (deps.allowOfflineRestore === true) {
        const saved = savedServer();
        if (saved !== undefined) {
            const local = await openServerSession(saved, deps, "offline");
            if (signal?.aborted) throw new ApiError({ kind: "aborted" });
            if (local.status === "connected") return local;
            localFailure = local.restore;
        }
    }
    const discovered = await discoverServer(serverAddress, device, deps.fetch, clock, signal);
    if (discovered.status === "unreachable") {
        const saved = savedServer();
        return saved === undefined ? discovered : openServerSession(saved, deps, "offline");
    }
    if (discovered.status !== "connected") {
        return discovered;
    }
    // Apple TV commits a server only after GET /api/v2/system/setup succeeds (AuthService.checkServer).
    let setup: SetupStatus;
    try {
        setup = await discovered.server.http.send({ ...operations.setupStatus(), signal });
    } catch (error) {
        if (error instanceof ApiError && !error.aborted && ["network", "timeout"].includes(error.failure.kind)) {
            const saved = savedServer();
            if (saved?.serverId === discovered.server.serverId) return openServerSession(discovered.server, deps, "offline");
        }
        return failedDiscovery(error);
    }
    if (setup.needsSetup) {
        return { status: "needs_setup", server: discovered.server };
    }
    const opened = await openDiscoveredServer(discovered.server, deps);
    return localFailure !== undefined && opened.restore === "signed_out" ? { ...opened, restore: localFailure } : opened;
}

/** Offline removal still clears local authority; reachable accounts also revoke their session. */
export async function signOutSavedAccount(account: SavedAccount, deps: SessionCoreDeps): Promise<VaultClear> {
    await deps.beforeAccountSignOut?.(account.baseUrl, account.accountId);
    clearBrowseCache(deps.publicStorage, [account.serverId, account.accountId], deps.keyManager);
    try {
        const connected = await connect(account.baseUrl, { ...deps, addAccount: true });
        if (connected.status === "connected") {
            const transient = deps.keyManager === undefined ? deps.transientAccounts : undefined;
            const vault = new CredentialVault(transient?.secrets ?? openSecretStore(deps.keyManager), transient?.storage ?? deps.publicStorage, account.baseUrl, account.id);
            const session = new NativeSession(connected.server, vault, deps.clock ?? systemClock, deps.randomBytes);
            watchBrowseCache(session, deps.publicStorage, deps.keyManager, account.serverId, account.accountId);
            await session.restore();
            if (session.signedIn && (await session.logout()).storage === "failed") return "failed";
        }
    } catch {
        // Discovery can fail offline; protected storage remains the local sign-out authority.
    }
    const transient = deps.keyManager === undefined ? deps.transientAccounts : undefined;
    return new AccountVault(transient?.secrets ?? openSecretStore(deps.keyManager), transient?.storage ?? deps.publicStorage, account.baseUrl, deps.randomBytes, account.id, false, transient?.storage).signOut();
}

/** Clears only the selected sign-in, or the legacy sign-in when no account is selected. */
export async function forgetStoredCredential(
    serverAddress: string,
    deps: Pick<SessionCoreDeps, "publicStorage" | "keyManager" | "localAccountId">,
): Promise<VaultClear | ServerUrlProblem> {
    const parsed = parseServerUrl(serverAddress);
    if (!parsed.ok) {
        return parsed.problem;
    }
    const store = openSecretStore(deps.keyManager);
    const vault = new AccountVault(store, deps.publicStorage, parsed.base.baseUrl, () => undefined, deps.localAccountId);
    const account = vault.directory.list().find(row => row.id === vault.localAccountId);
    if (account) clearBrowseCache(deps.publicStorage, [account.serverId, account.accountId], deps.keyManager);
    return vault.clear();
}

/** Apple forgets every speed reading when the server, sign-in or profile changes (BandwidthProbeScheduler.setActiveSession). */
function watchBandwidthReadings(session: NativeSession): void {
    let accountId = session.account?.id;
    session.onAuthorityChange(change => {
        accountId = session.account?.id ?? accountId;
        if (["signed_in", "signed_out", "session_expired", "profile_selected"].includes(change.reason)) bandwidthReadings.forget(readingsScope(session.http.base.baseUrl, accountId));
    });
}

function watchBrowseCache(session: NativeSession, storage: PublicStorage | undefined, keyManager: TizenKeyManager | undefined, serverId: string, accountId?: string): void {
    session.onAuthorityChange(change => {
        accountId = session.account?.id ?? accountId;
        if (accountId && (change.reason === "signed_out" || change.reason === "session_expired")) clearBrowseCache(storage, [serverId, accountId], keyManager);
    });
}
