// Full-screen playback: the AVPlay surface plus a readable overlay for loading, progress and
// errors. Remote: Enter pauses or resumes, Left/Right seek 10 s, Back leaves. The screen owns
// one child of the root and removes only that child, so a screen the parent already showed
// (after a profile switch, say) is never erased. Not mounted by src/main.ts yet.

import type { Clock } from "../api/clock.ts";
import { systemClock } from "../api/clock.ts";
import type { ConnectedServer } from "../session/core.ts";
import type { RandomBytes } from "../session/deviceIdentity.ts";
import { remoteKey } from "../ui/keys.ts";
import { el } from "../ui/screen.ts";
import type { AVPlay } from "./avplay.ts";
import { type PlaybackError, type PlaybackExits, PlaybackController, type PlaybackView, type PlayerControls, type PlayRequest } from "./controller.ts";

const SEEK_STEP_SECONDS = 10;
/** While playing, the overlay hides this long after the last key. */
const OVERLAY_MS = 5000;

export interface PlayerScreen {
    destroy(): void;
}

export function errorText(error: PlaybackError): string {
    switch (error.kind) {
        case "terminal":
            // The server's sentence for its own refusal (protocol v3 §7.3).
            return error.message;
        case "unavailable":
            return "This server can't stream to this TV.";
        case "playback_failed":
            return "This video can't play on this TV.";
        case "network":
            return "Can't reach the server. Check the TV's connection, then try again.";
        case "session_expired":
            return "The server ended playback. Try again.";
        case "installation_changed":
            return "The server was reset or replaced. Try again.";
        case "backgrounded":
            return "Playback stopped when you left Silo. Go back and select the title to play again.";
        case "server":
            return "The server couldn't start playback. Try again.";
    }
}

export function clockText(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const two = (value: number): string => (value < 10 ? `0${value}` : String(value));
    return hours > 0 ? `${hours}:${two(minutes)}:${two(secs)}` : `${minutes}:${two(secs)}`;
}

export function mountPlayerScreen(root: HTMLElement, controls: PlayerControls, clock: Clock = systemClock): PlayerScreen {
    const section = el("section", "player");
    section.setAttribute("data-screen", "player");
    const surface = document.createElement("object");
    surface.type = "application/avplayer";
    surface.className = "player-video";
    surface.setAttribute("aria-hidden", "true");
    const overlay = el("div", "player-overlay");
    overlay.setAttribute("data-focus", "player");
    overlay.tabIndex = -1;
    const title = el("h1", "player-title");
    const status = el("p", "player-status");
    status.setAttribute("role", "status");
    const bar = el("div", "player-bar");
    const fill = el("div", "player-bar-fill");
    bar.appendChild(fill);
    const time = el("p", "player-time");
    overlay.appendChild(title);
    overlay.appendChild(status);
    overlay.appendChild(bar);
    overlay.appendChild(time);
    const failure = el("div", "player-error");
    failure.setAttribute("role", "alert");
    const failureTitle = el("h1", "player-title");
    const failureText = el("p", "player-error-text");
    const back = el("button", "player-button", "Back");
    back.type = "button";
    back.setAttribute("data-focus", "back");
    back.addEventListener("click", () => controls.dismissError());
    failure.appendChild(failureTitle);
    failure.appendChild(failureText);
    failure.appendChild(back);
    section.appendChild(surface);
    section.appendChild(overlay);
    section.appendChild(failure);
    root.appendChild(section);

    let view: PlaybackView = { phase: "closed" };
    let cancelHide: (() => void) | undefined;

    const render = (): void => {
        const showing = view.phase === "error" ? "error" : "overlay";
        failure.style.display = showing === "error" ? "block" : "none";
        overlay.style.display = showing === "overlay" ? "block" : "none";
        if (view.phase === "error") {
            failureTitle.textContent = view.title;
            failureText.textContent = errorText(view.error);
            if (document.activeElement !== back) {
                back.focus();
            }
            return;
        }
        if (view.phase === "closed") {
            return;
        }
        title.textContent = view.title;
        if (view.phase === "loading") {
            status.textContent = "Loading";
            time.textContent = "";
            fill.style.width = "0";
        } else {
            status.textContent = view.buffering ? "Buffering" : view.phase === "paused" ? "Paused" : "";
            const duration = view.durationSeconds;
            time.textContent = duration === undefined ? clockText(view.positionSeconds) : `${clockText(view.positionSeconds)} / ${clockText(duration)}`;
            fill.style.width = duration === undefined || duration <= 0 ? "0" : `${Math.min(100, (view.positionSeconds / duration) * 100)}%`;
        }
        const hidden = view.phase === "playing" && !view.buffering && cancelHide === undefined;
        overlay.className = hidden ? "player-overlay player-overlay-hidden" : "player-overlay";
        if (document.activeElement !== overlay) {
            overlay.focus();
        }
    };

    const reveal = (): void => {
        cancelHide?.();
        cancelHide = clock.schedule(() => {
            cancelHide = undefined;
            render();
        }, OVERLAY_MS);
    };

    const onKey = (event: KeyboardEvent): void => {
        const key = remoteKey(event);
        if (key === undefined || view.phase === "closed") {
            return;
        }
        event.preventDefault();
        if (view.phase === "error") {
            if (key === "enter" || key === "back") {
                controls.dismissError();
            }
            return;
        }
        reveal();
        if (key === "back") {
            controls.back();
        } else if (key === "enter") {
            controls.togglePause();
        } else if (key === "left") {
            controls.seekBy(-SEEK_STEP_SECONDS);
        } else if (key === "right") {
            controls.seekBy(SEEK_STEP_SECONDS);
        }
        render();
    };

    const onVisibility = (): void => {
        if (document.hidden) {
            cancelHide?.();
            cancelHide = undefined;
            if (view.phase !== "closed" && view.phase !== "error") {
                controls.background();
            }
        } else {
            render();
        }
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVisibility);
    const unsubscribe = controls.subscribe((next) => {
        const starting = next.phase === "playing" && view.phase !== "playing" && view.phase !== "paused";
        view = next;
        if (document.hidden && next.phase !== "closed" && next.phase !== "error") {
            onVisibility();
            return;
        }
        if (starting) {
            reveal();
        }
        render();
    });

    return {
        destroy() {
            unsubscribe();
            cancelHide?.();
            document.removeEventListener("keydown", onKey);
            document.removeEventListener("visibilitychange", onVisibility);
            if (section.parentNode === root) {
                root.removeChild(section);
            }
        },
    };
}

export interface PlayerPlatform {
    /** `findAVPlay()` on a TV. */
    readonly avplay: AVPlay;
    readonly randomBytes: RandomBytes;
    /** `webapis.productinfo.getRealModel()`. */
    readonly model: string;
    readonly appVersion: string;
    readonly clock?: Clock;
}

/**
 * Plays one file for the signed-in server's active profile. Each exit removes the player before
 * the parent's callback runs; `destroy` stops playback without one.
 */
export function startPlayback(
    root: HTMLElement,
    server: ConnectedServer,
    request: PlayRequest,
    exits: PlaybackExits,
    platform: PlayerPlatform,
): PlayerScreen {
    const clock = platform.clock ?? systemClock;
    let screen: PlayerScreen | undefined;
    const finish = (): void => {
        screen?.destroy();
        controller.destroy();
    };
    const controller = new PlaybackController({
        session: server.session,
        avplay: platform.avplay,
        clock,
        randomBytes: platform.randomBytes,
        device: { model: platform.model, appVersion: platform.appVersion },
        exits: {
            onBack: () => {
                finish();
                exits.onBack();
            },
            onEnd: (reason) => {
                finish();
                exits.onEnd(reason);
            },
            onError: (error) => {
                finish();
                exits.onError(error);
            },
        },
    });
    screen = mountPlayerScreen(root, controller, clock);
    controller.play(request);
    return { destroy: finish };
}
