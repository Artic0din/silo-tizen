import { startPlayback, type PlayerPlatform, type PlayerScreen } from "./player/playerScreen.ts";
import { connect, type ConnectedServer, type SessionCoreDeps } from "./session/core.ts";
import type { LogoutResult } from "./session/session.ts";
import { mountBrowse, type Browse, type PlayRequest } from "./ui/browse.ts";
import { mountExitDialog, type ExitDialog } from "./ui/exitDialog.ts";
import { remoteKey } from "./ui/keys.ts";
import { avatarReference } from "./ui/profilePicker.ts";
import { mountProfiles, type ProfileHandoff, type ProfileScreens } from "./ui/profiles.ts";
import { actions, button, el, ScreenHost } from "./ui/screen.ts";
import { mountSignIn, rememberServer, type SignInScreens } from "./ui/signIn.ts";
import { mountAccounts, type AccountsScreen } from "./ui/accounts.ts";
import { cachedBranding } from "./ui/brandingCache.ts";
import { AccountDirectory, AccountVault, type SavedAccount } from "./session/accounts.ts";
import { openSecretStore } from "./session/secretStore.ts";

export interface AppOptions {
    readonly core: SessionCoreDeps;
    readonly player: PlayerPlatform | undefined;
    readonly exit: () => void;
}

export interface SiloApp { destroy(): void; }

interface ProfileRoute {
    readonly pickerRequested?: boolean;
    readonly skipRemembered?: boolean;
    readonly returnToAccounts?: boolean;
    readonly sessionExpired?: boolean;
    /** The sign-in was opened from Change Account, so Back returns there. */
    readonly fromAccounts?: boolean;
}

export function mountApp(root: HTMLElement, options: AppOptions): SiloApp {
    let signIn: SignInScreens | undefined;
    let profiles: ProfileScreens | undefined;
    let browse: Browse | undefined;
    let player: PlayerScreen | undefined;
    let profile: ProfileHandoff | undefined;
    let exitDialog: ExitDialog | undefined;
    let destroyed = false;
    let activeServer: ConnectedServer | undefined;
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
    activeCore = { ...activeCore, reuseAccount: (baseUrl, accountId) => liveAccounts.get(liveKey(baseUrl, accountId)), beforeAccountSignOut: async (baseUrl, accountId) => {
        const key = liveKey(baseUrl, accountId);
        await liveAccounts.get(key)?.session.retire();
        liveAccounts.delete(key);
    } };

    const closeExit = (): void => {
        exitDialog?.destroy();
        exitDialog = undefined;
    };

    const stopContent = (): void => {
        accounts?.destroy(); accounts = undefined;
        profile?.signal.removeEventListener("abort", stopContent);
        profile = undefined;
        closeExit();
        player?.destroy();
        player = undefined;
        browse?.destroy();
        browse = undefined;
    };

    const showSignIn = (notice?: LogoutResult, chooseServer = false, account?: SavedAccount, address?: string, pickerRequested = false, route?: ProfileRoute): void => {
        stopContent();
        if (connected?.session.activeProfile) connected.session.setProfile(undefined, "profile_cleared");
        profiles?.destroy();
        profiles = undefined;
        const live = account ? liveAccounts.get(liveKey(account.baseUrl, account.accountId)) : undefined;
        if (live?.session.signedIn && account) {
            try { live.accounts.directory.select(account.id); }
            catch {
                startup = new ScreenHost(root);
                const controls = [button("retry", "Retry", () => { startup?.destroy(); startup = undefined; showSignIn(notice, chooseServer, account, address, pickerRequested, route); }), button("accounts", "Back to profiles", () => { startup?.destroy(); startup = undefined; showProfiles(live, { pickerRequested: true }); })];
                startup.show({ name: "account-selection-error", content: [el("h1", "signin-title", "Could not save the account selection"), actions(controls)], controls, focus: "retry", back: undefined });
                return;
            }
            showProfiles(live, { pickerRequested, skipRemembered: route?.skipRemembered === true }); return;
        }
        signIn = mountSignIn(root, {
            core: { ...activeCore, ...(account ? { localAccountId: account.id } : {}), ...(address || account?.needsSignIn ? { addAccount: true } : {}),
                beforeAccountSignIn: async (baseUrl, accountId) => { await liveAccounts.get(liveKey(baseUrl, accountId))?.session.retire(); },
            },
            ...(address || account ? { address: address ?? account!.baseUrl } : {}),
            ...(account ? { username: account.username } : {}),
            onChangeAccount: () => showAccounts(),
            ...(route?.returnToAccounts ? { returnToAccounts: true } : {}),
            ...(route?.sessionExpired ? { sessionExpired: true } : {}),
            ...(pickerRequested || route?.fromAccounts || route?.returnToAccounts ? { onCancel: () => showAccounts() } : {}),
            ...(chooseServer ? { chooseServer: true } : {}),
            onSignedIn: server => showProfiles(server, { pickerRequested, skipRemembered: route?.skipRemembered === true }),
            ...(notice === undefined ? {} : { signedOut: notice }),
        });
    };

    function showProfiles(server: ConnectedServer, route: ProfileRoute = {}): void {
        connected = server;
        if (server.session.account) liveAccounts.set(liveKey(server.server.http.base.baseUrl, server.session.account.id), server);
        signIn = undefined;
        profiles = mountProfiles(root, {
            pickerRequested: route.pickerRequested === true, skipRemembered: route.skipRemembered === true,
            onSessionExpired: () => routeWithoutSignedInAccount(server),
            server, launch: server.profileLaunch,
            onChangeServer: () => showAccounts(),
            onSelected: active => showBrowse(server, active),
            onProfileUpdated: summary => {
                if (profile === undefined || profile.profile.id !== summary.id) return;
                profile = { ...profile, profile: summary };
                browse?.updateProfile(summary);
            },
            onSignedOut: result => {
                profiles = undefined;
                const account = result?.server === "not_signed_in" ? server.accounts.directory.list().find(row => row.id === server.accounts.localAccountId) : undefined;
                showSignIn(account ? undefined : result, false, account);
            },
            serverName: () => cachedBranding(activeCore.publicStorage, server.server.http.base.baseUrl)?.serverName,
        });
    }

    // A row can say "sign in again" while its session still works, when the key store refused to save it.
    const hasLiveSession = (row: SavedAccount): boolean => liveAccounts.get(liveKey(row.baseUrl, row.accountId))?.session.signedIn === true;

    // ChangeAccountModel.choose: a saved account that is not open yet opens while Change Account stays up and
    // spins on its card. One that cannot restore quietly (offline, expired, unreadable) goes to the sign-in screen.
    const openFromAccounts = (account: SavedAccount | undefined, address?: string, inPlace?: boolean): Promise<void> | void => {
        const open = account !== undefined && connected?.session.signedIn === true && connected.accounts.localAccountId === account.id;
        if (account !== undefined && inPlace === true && !account.needsSignIn && !open && !hasLiveSession(account)) return restoreFromAccounts(account);
        openWithSignIn(account, address);
    };

    const restoreFromAccounts = async (account: SavedAccount): Promise<void> => {
        const screen = accounts;
        const result = await connect(account.baseUrl, { ...activeCore, localAccountId: account.id }).catch(() => undefined);
        if (accounts !== screen) return;
        if (result?.status === "connected" && result.restore === "signed_in") {
            rememberServer(activeCore, result.server.http.base.baseUrl);
            stopContent();
            // The same cleanup showSignIn does: a Browse session opened this screen with its profile still active.
            if (connected?.session.activeProfile) connected.session.setProfile(undefined, "profile_cleared");
            profiles?.destroy();
            profiles = undefined;
            showProfiles(result, { skipRemembered: true });
            return;
        }
        openWithSignIn(account);
    };

    const openWithSignIn = (account: SavedAccount | undefined, address?: string): void => {
        accounts?.destroy();
        accounts = undefined;
        if (account?.needsSignIn && !hasLiveSession(account)) {
            // ChangeAccountModel.choose: signing in again ends at the picker, as for any chosen account.
            showSignIn(undefined, false, account, address, false, { returnToAccounts: true, skipRemembered: true });
            return;
        }
        // The open account is Switch Profile (picker). Another account skips a remembered
        // profile, except its only PIN-less profile, which opens (AppRouter.openAccount).
        const current = account !== undefined && connected?.session.signedIn === true && connected.accounts.localAccountId === account.id;
        const adding = account === undefined;
        showSignIn(undefined, adding && address === undefined, account, address, current, {
            fromAccounts: true,
            returnToAccounts: adding || account?.needsSignIn === true,
            skipRemembered: account !== undefined && !current,
        });
    };

    const routeWithoutSignedInAccount = (server: ConnectedServer): void => {
        // The vault may keep its accounts in memory only, so read the one it writes.
        const directory = server.accounts.directory;
        const expiredId = server.accounts.localAccountId;
        // The vault records this after the listener runs. The route has to see it now.
        try { if (expiredId !== undefined) directory.update(expiredId, { needsSignIn: true }); } catch { /* clear() writes the same flag. */ }
        let rows: readonly SavedAccount[] = [];
        try { rows = directory.list(); } catch { rows = []; }
        // AppRouter.signedOutDestination: another account that can open a profile opens Change Account.
        // The expired one never counts, even when its flag could not be saved.
        if (rows.some(row => row.id !== expiredId && (!row.needsSignIn || hasLiveSession(row)))) { showAccounts(); return; }
        const renewing = rows.find(row => row.id === expiredId) ?? rows.find(row => row.baseUrl === server.server.http.base.baseUrl && row.needsSignIn);
        showSignIn(undefined, false, renewing, undefined, false, { sessionExpired: true });
    };

    const switchServer = (server: ConnectedServer, back: () => void): void => {
        accounts = mountAccounts(root, activeCore, server, openFromAccounts, () => {
            accounts = undefined;
            back();
        });
    };

    const showAccounts = (manage = false): void => {
        stopContent();
        profiles?.destroy(); profiles = undefined;
        if (connected?.session.activeProfile) connected.session.setProfile(undefined, "profile_cleared");
        signIn?.destroy(); signIn = undefined;
        accounts?.destroy();
        accounts = mountAccounts(root, activeCore, connected, openFromAccounts, () => {
            accounts = undefined;
            if (connected?.session.signedIn) showProfiles(connected, { pickerRequested: true });
            else showSignIn(undefined, true);
        }, manage);
    };

    const showBrowse = (server: ConnectedServer, active: ProfileHandoff): void => {
        activeServer = server;
        server.profileLaunch.recordActive();
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
            onSwitchServer: back => switchServer(server, back),
            onAccounts: back => {
                accounts = mountAccounts(root, activeCore, server, openFromAccounts, () => { accounts = undefined; if (active.signal.aborted) showAccounts(); else back(); }, true,
                () => { active.signal.removeEventListener("abort", stopContent); profiles?.destroy(); profiles = undefined; });
            },
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
            : startPlayback(root, server, request, { onBack: resume, onEnd: resume, onError: resume }, options.player, () => content.spoilers(), activeCore.publicStorage);
    };

    const onBack = (event: KeyboardEvent): void => {
        if (destroyed || event.defaultPrevented || remoteKey(event) !== "back" || exitDialog !== undefined) {
            return;
        }
        event.preventDefault();
        exitDialog = mountExitDialog(root, () => {
            activeServer?.profileLaunch.recordAway();
            player?.destroy();
            player = undefined;
            options.exit();
            destroy();
        }, () => { exitDialog = undefined; });
    };

    const onVisibility = (): void => {
        if (activeServer === undefined || activeServer.session.activeProfile === undefined) return;
        if (document.hidden) { activeServer.profileLaunch.recordAway(); return; }
        const expired = activeServer.profileLaunch.requiresSelection();
        if (expired) {
            activeServer.profileLaunch.requireSelection();
            stopContent();
            activeServer.session.setProfile(undefined, "profile_cleared");
            profiles?.switchProfile();
        } else activeServer.profileLaunch.recordActive();
    };
    const onPageHide = (): void => { activeServer?.profileLaunch.recordAway(); destroy(); };
    const destroy = (): void => {
        if (destroyed) {
            return;
        }
        destroyed = true;
        window.removeEventListener("keydown", onBack);
        window.removeEventListener("pagehide", onPageHide);
        document.removeEventListener("visibilitychange", onVisibility);
        stopContent();
        profiles?.destroy();
        profiles = undefined;
        signIn?.destroy();
        signIn = undefined;
        accounts?.destroy(); accounts = undefined;
        startup?.destroy(); startup = undefined;
    };

    window.addEventListener("keydown", onBack);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
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
