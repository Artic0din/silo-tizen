import { startPlayback, type PlayerPlatform, type PlayerScreen } from "./player/playerScreen.ts";
import type { ConnectedServer, SessionCoreDeps } from "./session/core.ts";
import type { LogoutResult } from "./session/session.ts";
import { mountBrowse, type Browse, type PlayRequest } from "./ui/browse.ts";
import { mountExitDialog, type ExitDialog } from "./ui/exitDialog.ts";
import { remoteKey } from "./ui/keys.ts";
import { mountProfiles, type ProfileHandoff, type ProfileScreens } from "./ui/profiles.ts";
import { actions, button, el, ScreenHost } from "./ui/screen.ts";
import { mountSignIn, type SignInScreens } from "./ui/signIn.ts";

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

    const showSignIn = (notice?: LogoutResult): void => {
        stopContent();
        profiles?.destroy();
        profiles = undefined;
        signIn = mountSignIn(root, {
            core: options.core,
            onSignedIn: (server) => {
                // Sign-in releases its root before handing over; its old destroy would clear the successor.
                signIn = undefined;
                profiles = mountProfiles(root, {
                    server,
                    launch: server.profileLaunch,
                    onSelected: (active) => showBrowse(server, active),
                    onSignedOut: (result) => {
                        profiles = undefined;
                        showSignIn(result);
                    },
                });
            },
            ...(notice === undefined ? {} : { signedOut: notice }),
        });
    };

    const showBrowse = (server: ConnectedServer, active: ProfileHandoff): void => {
        stopContent();
        if (destroyed || active.signal.aborted) {
            return;
        }
        profile = active;
        // The signal aborts before profile-screen listeners reclaim the root.
        active.signal.addEventListener("abort", stopContent, { once: true });
        const content = mountBrowse(root, {
            server,
            profileName: active.profile.name,
            ...(options.core.publicStorage === undefined ? {} : { publicStorage: options.core.publicStorage }),
            onSignOut: () => {
                stopContent();
                profiles?.signOut();
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
    };

    window.addEventListener("keydown", onBack);
    window.addEventListener("pagehide", destroy);
    showSignIn();
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
