import { startPlayback, type PlayerPlatform, type PlayerScreen } from "./player/playerScreen.ts";
import type { ConnectedServer, SessionCoreDeps } from "./session/core.ts";
import type { LogoutResult } from "./session/session.ts";
import { mountBrowse, type Browse, type PlayRequest } from "./ui/browse.ts";
import { mountExitDialog, type ExitDialog } from "./ui/exitDialog.ts";
import { remoteKey } from "./ui/keys.ts";
import { avatarReference } from "./ui/profilePicker.ts";
import { mountProfiles, type ProfileHandoff, type ProfileScreens } from "./ui/profiles.ts";
import { actions, button, el, ScreenHost } from "./ui/screen.ts";
import { mountSignIn, type SignInScreens } from "./ui/signIn.ts";
import { mountAccounts, type AccountsScreen } from "./ui/accounts.ts";
import { AccountDirectory, AccountVault, type SavedAccount } from "./session/accounts.ts";
import { openSecretStore } from "./session/secretStore.ts";

export interface AppOptions {
    readonly core: SessionCoreDeps;
    readonly player: PlayerPlatform | undefined;
    readonly exit: () => void;
}

export interface SiloApp { destroy(): void; }

export function mountApp(root: HTMLElement, options: AppOptions): SiloApp {
    let signIn: SignInScreens | undefined;
    let profiles: ProfileScreens | undefined;
    let browse: Browse | undefined;
    let player: PlayerScreen | undefined;
    let profile: ProfileHandoff | undefined;
    let exitDialog: ExitDialog | undefined;
    let destroyed = false;
    let accounts: AccountsScreen | undefined;
    let connected: ConnectedServer | undefined;
    let startup: ScreenHost | undefined;
    const transient = new Map<string, string>();
    let activeCore: SessionCoreDeps = { ...options.core, transientAccounts: {
        secrets: openSecretStore(undefined),
        storage: { getItem: key => transient.get(key) ?? null, setItem: (key, value) => { transient.set(key, value); }, removeItem: key => { transient.delete(key); } },
    } };
    const liveAccounts = new Map<string, ConnectedServer>();
    const liveKey = (baseUrl: string, accountId: string): string => JSON.stringify([baseUrl, accountId]);

    const closeExit = (): void => {
        exitDialog?.destroy();
        exitDialog = undefined;
    };

    const stopContent = (): void => {
        profile?.signal.removeEventListener("abort", stopContent);
        profile = undefined;
        closeExit();
        player?.destroy();
        player = undefined;
        browse?.destroy();
        browse = undefined;
    };

    const showSignIn = (notice?: LogoutResult, chooseServer = false, account?: SavedAccount, address?: string, pickerRequested = false): void => {
        stopContent();
        profiles?.destroy();
        profiles = undefined;
        const live = account && !account.needsSignIn ? liveAccounts.get(liveKey(account.baseUrl, account.accountId)) : undefined;
        if (live?.session.signedIn && account) {
            try { live.accounts.directory.select(account.id); }
            catch {
                startup = new ScreenHost(root);
                const controls = [button("retry", "Retry", () => { startup?.destroy(); startup = undefined; showSignIn(notice, chooseServer, account, address, pickerRequested); }), button("accounts", "Change account", () => { startup?.destroy(); startup = undefined; showAccounts(); })];
                startup.show({ name: "account-selection-error", content: [el("h1", "signin-title", "Could not save the account selection"), actions(controls)], controls, focus: "retry", back: undefined });
                return;
            }
            showProfiles(live, pickerRequested); return;
        }
        signIn = mountSignIn(root, {
            core: { ...activeCore, ...(account ? { localAccountId: account.id } : {}), ...(address || account?.needsSignIn ? { addAccount: true } : {}) },
            ...(address || account ? { address: address ?? account!.baseUrl } : {}),
            ...(account ? { username: account.username } : {}),
            onChangeAccount: () => showAccounts(),
            ...(pickerRequested ? { onCancel: () => showAccounts() } : {}),
            ...(chooseServer ? { chooseServer: true } : {}),
            onSignedIn: server => showProfiles(server, pickerRequested),
            ...(notice === undefined ? {} : { signedOut: notice }),
        });
    };

    function showProfiles(server: ConnectedServer, pickerRequested = false): void {
        connected = server;
        if (server.session.account) liveAccounts.set(liveKey(server.server.http.base.baseUrl, server.session.account.id), server);
        signIn = undefined;
        profiles = mountProfiles(root, {
            pickerRequested, server, launch: server.profileLaunch,
            onChangeServer: () => switchServer(server),
            onSelected: active => showBrowse(server, active),
            onSignedOut: result => {
                profiles = undefined;
                const account = result?.server === "not_signed_in" ? server.accounts.directory.list().find(row => row.id === server.accounts.localAccountId) : undefined;
                showSignIn(account ? undefined : result, false, account);
            },
        });
    }

    const switchServer = (server: ConnectedServer): void => {
        stopContent();
        profiles?.destroy();
        profiles = undefined;
        server.session.setProfile(undefined, "profile_cleared");
        showAccounts();
    };

    const showAccounts = (manage = false): void => {
        stopContent();
        profiles?.destroy(); profiles = undefined;
        if (connected?.session.activeProfile) connected.session.setProfile(undefined, "profile_cleared");
        signIn?.destroy(); signIn = undefined;
        accounts?.destroy();
        accounts = mountAccounts(root, activeCore, connected, (account, address) => {
            accounts = undefined;
            showSignIn(undefined, account === undefined && address === undefined, account, address, true);
        }, () => {
            accounts = undefined;
            if (connected?.session.signedIn) showProfiles(connected, true);
            else showSignIn(undefined, true);
        }, manage);
    };

    const showBrowse = (server: ConnectedServer, active: ProfileHandoff): void => {
        stopContent();
        if (destroyed || active.signal.aborted) {
            return;
        }
        profile = active;
        // The signal aborts before profile-screen listeners reclaim the root.
        active.signal.addEventListener("abort", stopContent, { once: true });
        const avatar = avatarReference(active.profile);
        const content = mountBrowse(root, {
            server,
            profileName: active.profile.name,
            ...(avatar === undefined ? {} : { profileAvatarUrl: avatar }),
            ...(activeCore.publicStorage === undefined ? {} : { publicStorage: activeCore.publicStorage }),
            onSignOut: () => {
                stopContent();
                profiles?.signOut();
            },
            onSwitchServer: () => switchServer(server),
            onAccounts: () => showAccounts(true),
            onChooseProfile: () => {
                stopContent();
                profiles?.switchProfile();
            },
            onPlay: (request) => play(server, active, content, request),
            ...(options.core.clock === undefined ? {} : { clock: options.core.clock }),
        });
        browse = content;
    };

    const play = (server: ConnectedServer, active: ProfileHandoff, content: Browse, request: PlayRequest): void => {
        const resume = (): void => {
            player = undefined;
            if (!destroyed && !active.signal.aborted && browse === content) {
                content.resumeAfterPlayback();
            }
        };
        player = options.player === undefined
            ? unavailablePlayer(root, resume)
            : startPlayback(root, server, request, { onBack: resume, onEnd: resume, onError: resume }, options.player);
    };

    const onBack = (event: KeyboardEvent): void => {
        if (destroyed || event.defaultPrevented || remoteKey(event) !== "back" || exitDialog !== undefined) {
            return;
        }
        event.preventDefault();
        exitDialog = mountExitDialog(root, () => {
            player?.destroy();
            player = undefined;
            options.exit();
            destroy();
        }, () => { exitDialog = undefined; });
    };

    const destroy = (): void => {
        if (destroyed) {
            return;
        }
        destroyed = true;
        window.removeEventListener("keydown", onBack);
        window.removeEventListener("pagehide", destroy);
        stopContent();
        profiles?.destroy();
        profiles = undefined;
        signIn?.destroy();
        signIn = undefined;
        accounts?.destroy(); accounts = undefined;
        startup?.destroy(); startup = undefined;
    };

    window.addEventListener("keydown", onBack);
    window.addEventListener("pagehide", destroy);
    const migrate = async (): Promise<void> => {
        startup?.destroy(); startup = undefined;
        try {
            const directory = new AccountDirectory(options.core.publicStorage, options.core.randomBytes);
            const selected = directory.list().find(row => row.id === directory.selected);
            const address = selected?.baseUrl ?? options.core.publicStorage?.getItem("silo.native.server");
            if (address) {
                const result = await new AccountVault(openSecretStore(options.core.keyManager), options.core.publicStorage, address, options.core.randomBytes).load();
                if (result.status === "unavailable") throw new Error("Saved accounts unavailable");
            }
            if (destroyed) return;
            const account = directory.list().find(row => row.id === directory.selected);
            if ((!account || account.needsSignIn) && directory.list().some(row => !row.needsSignIn)) showAccounts();
            else showSignIn(undefined, false, account);
        } catch {
            if (destroyed) return;
            startup = new ScreenHost(root);
            const controls = [button("retry", "Retry", () => { void migrate(); }), button("continue", "Continue without saved accounts", () => {
                startup?.destroy(); startup = undefined;
                activeCore = { ...activeCore, publicStorage: undefined, keyManager: undefined };
                showSignIn();
            })];
            startup.show({ name: "accounts-storage-error", content: [el("h1", "signin-title", "Saved accounts unavailable"), el("p", "signin-text", "Your saved sign-ins have been kept. Retry, or sign in for this session."), actions(controls)], controls, focus: "retry", back: undefined });
        }
    };
    void migrate();
    return { destroy };
}

function unavailablePlayer(root: HTMLElement, back: () => void): PlayerScreen {
    const container = el("div", "signin");
    root.appendChild(container);
    const host = new ScreenHost(container);
    const destroy = (): void => {
        host.destroy();
        container.remove();
    };
    const close = (): void => { destroy(); back(); };
    const control = button("back", "Back", close);
    host.show({ name: "playback-unavailable", content: [el("h1", "signin-title", "Playback unavailable"), actions([control])], controls: [control], focus: "back", back: close });
    return { destroy };
}
