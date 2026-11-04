// Public entry point for screens and the player: connect to one server, restore its session,
// sign in with a device code, choose a profile, sign out.

import { type Clock, systemClock } from "../api/clock.ts";
import { discoverServer, type DiscoveryResult, type ServerConnection } from "../api/discovery.ts";
import type { FetchLike } from "../api/http.ts";
import { parseServerUrl, type ServerUrlProblem } from "../api/serverUrl.ts";
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
    readonly beforeAccountSignIn?: (baseUrl: string, accountId: string) => Promise<void>;
}

export interface ConnectedServer {
    readonly status: "connected";
    readonly server: ServerConnection;
    readonly session: NativeSession;
    readonly profiles: Profiles;
    readonly profileLaunch: ProfileLaunch;
    readonly restore: RestoreResult;
    readonly accounts: AccountVault;
    /** A fresh sign-in flow; call `start()` to show a code. */
    createDeviceLogin(): DeviceLogin;
}

export type ConnectResult = ConnectedServer | Exclude<DiscoveryResult, { readonly status: "connected" }>;

export async function connect(serverAddress: string, deps: SessionCoreDeps, signal?: AbortSignal): Promise<ConnectResult> {
    const clock = deps.clock ?? systemClock;
    const device = deviceHeaders(loadDeviceId(deps.publicStorage, deps.randomBytes), deps.deviceName, deps.devicePlatform);
    const discovered = await discoverServer(serverAddress, device, deps.fetch, clock, signal);
    if (discovered.status !== "connected") {
        return discovered;
    }
    const server = discovered.server;
    let vault: AccountVault;
    const transient = deps.keyManager === undefined ? deps.transientAccounts : undefined;
    try { vault = new AccountVault(transient?.secrets ?? openSecretStore(deps.keyManager), transient?.storage ?? deps.publicStorage, server.http.base.baseUrl, deps.randomBytes, deps.localAccountId, deps.addAccount, transient?.storage); }
    catch {
        // Unreadable metadata must not overwrite saved accounts; sign-in can still be session-only.
        vault = new AccountVault(deps.transientAccounts?.secrets ?? openSecretStore(undefined), deps.transientAccounts?.storage, server.http.base.baseUrl, deps.randomBytes, undefined, true, deps.transientAccounts?.storage);
    }
    const session = new NativeSession(server, vault, clock, async accountId => {
        await deps.beforeAccountSignIn?.(server.http.base.baseUrl, accountId);
    });
    const restore = await session.restore();
    return {
        status: "connected",
        server,
        session,
        profiles: new Profiles(session, clock),
        profileLaunch: new ProfileLaunch(session, deps.publicStorage, openSecretStore(deps.keyManager), deps.randomBytes, server.serverId),
        restore,
        accounts: vault,
        createDeviceLogin: () => new DeviceLogin(session, clock, device.name, device.platform),
    };
}

/** Offline removal still clears local authority; reachable accounts also revoke their session. */
export async function signOutSavedAccount(account: SavedAccount, deps: SessionCoreDeps): Promise<VaultClear> {
    try {
        const connected = await connect(account.baseUrl, { ...deps, addAccount: true });
        if (connected.status === "connected") {
            const transient = deps.keyManager === undefined ? deps.transientAccounts : undefined;
            const vault = new CredentialVault(transient?.secrets ?? openSecretStore(deps.keyManager), transient?.storage ?? deps.publicStorage, account.baseUrl, account.id);
            const session = new NativeSession(connected.server, vault, deps.clock ?? systemClock);
            await session.restore();
            if (session.signedIn && (await session.logout()).storage === "failed") return "failed";
        }
    } catch {
        // Discovery can fail offline; protected storage remains the local sign-out authority.
    }
    const transient = deps.keyManager === undefined ? deps.transientAccounts : undefined;
    return new AccountVault(transient?.secrets ?? openSecretStore(deps.keyManager), transient?.storage ?? deps.publicStorage, account.baseUrl, deps.randomBytes, account.id, false, transient?.storage).signOut();
}

/** Deletes a server's stored credential without contacting it, e.g. while it is unreachable. */
export async function forgetStoredCredential(
    serverAddress: string,
    deps: Pick<SessionCoreDeps, "publicStorage" | "keyManager">,
): Promise<VaultClear | ServerUrlProblem> {
    const parsed = parseServerUrl(serverAddress);
    if (!parsed.ok) {
        return parsed.problem;
    }
    const store = openSecretStore(deps.keyManager);
    const directory = new AccountDirectory(deps.publicStorage, () => undefined);
    let result = await new CredentialVault(store, deps.publicStorage, parsed.base.baseUrl).clear();
    for (const row of directory.list().filter(row => row.baseUrl === parsed.base.baseUrl)) {
        const cleared = await new CredentialVault(store, deps.publicStorage, row.baseUrl, row.id).clear();
        if (cleared === "failed" || result === "failed") result = "failed";
        else if (cleared === "guarded") result = "guarded";
    }
    return result;
}
