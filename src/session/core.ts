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

export interface SessionCoreDeps {
    readonly fetch: FetchLike;
    /** localStorage; holds only the public device id and logout floors, never tokens. */
    readonly publicStorage: PublicStorage | undefined;
    /** `findTizenKeyManager()` on a TV; undefined keeps credentials in memory for this run. */
    readonly keyManager: TizenKeyManager | undefined;
    readonly randomBytes: RandomBytes;
    /** e.g. webapis.productinfo.getRealModel(); shown to the approver and in session lists. */
    readonly deviceName: string;
    readonly devicePlatform: string;
    readonly clock?: Clock;
}

export interface ConnectedServer {
    readonly status: "connected";
    readonly server: ServerConnection;
    readonly session: NativeSession;
    readonly profiles: Profiles;
    readonly profileLaunch: ProfileLaunch;
    readonly restore: RestoreResult;
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
    const vault = new CredentialVault(openSecretStore(deps.keyManager), deps.publicStorage, server.http.base.baseUrl);
    const session = new NativeSession(server, vault, clock);
    const restore = await session.restore();
    return {
        status: "connected",
        server,
        session,
        profiles: new Profiles(session, clock),
        profileLaunch: new ProfileLaunch(session, deps.publicStorage, openSecretStore(deps.keyManager), deps.randomBytes, server.serverId),
        restore,
        createDeviceLogin: () => new DeviceLogin(session, clock, device.name, device.platform),
    };
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
    return new CredentialVault(openSecretStore(deps.keyManager), deps.publicStorage, parsed.base.baseUrl).clear();
}
