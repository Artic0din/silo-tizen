// Full-screen playback: the AVPlay surface plus a readable overlay for loading, progress and
// errors. Remote: Enter pauses or resumes, Left/Right seek 10 s, Down opens audio and subtitles,
// Back leaves. In that menu Up/Down move within a list, Left/Right switch lists, Enter chooses
// and Back closes it; no key reaches playback while it is open. The screen owns one child of the
// root and removes only that child, so a screen the parent already showed (after a profile
// switch, say) is never erased.

import type { Clock } from "../api/clock.ts";
import { systemClock } from "../api/clock.ts";
import type { ConnectedServer } from "../session/core.ts";
import type { RandomBytes } from "../session/deviceIdentity.ts";
import { remoteKey } from "../ui/keys.ts";
import { el } from "../ui/screen.ts";
import type { AVPlay } from "./avplay.ts";
import { type PlaybackError, type PlaybackExits, PlaybackController, type PlaybackView, type PlayerControls, type PlayRequest, type TrackView } from "./controller.ts";

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

const OFF = "subtitles-off";
const RETRY = "audio-retry";

function changeText(tracks: TrackView): string {
    switch (tracks.change.state) {
        case "changing":
            return "Changing track";
        case "refused":
            return `Not available: ${tracks.change.message}`;
        case "failed":
            return "Couldn't change the track. Try again.";
        case "idle":
            return tracks.notices.join(" ");
    }
}

function choice(id: string, label: string, current: boolean): HTMLButtonElement {
    const button = el("button", "player-choice");
    button.type = "button";
    button.setAttribute("data-focus", id);
    button.setAttribute("aria-pressed", String(current));
    button.appendChild(el("span", "player-choice-label", label));
    if (current) {
        button.className = "player-choice player-choice-current";
    }
    return button;
}

function fillAudio(list: HTMLElement, tracks: TrackView): void {
    list.appendChild(el("h2", "player-menu-heading", "Audio"));
    const audio = tracks.audio;
    if (audio.state === "loading") {
        list.appendChild(el("p", "player-menu-note", "Loading audio tracks"));
    } else if (audio.state === "failed") {
        list.appendChild(el("p", "player-menu-note", "Couldn't load audio tracks."));
        list.appendChild(choice(RETRY, "Retry", false));
    } else if (audio.choices.length === 0) {
        list.appendChild(el("p", "player-menu-note", "No audio tracks listed"));
    } else {
        for (const track of audio.choices) {
            list.appendChild(choice(track.id, track.label, track.id === tracks.selectedAudioId));
        }
    }
}

function fillSubtitles(list: HTMLElement, tracks: TrackView): void {
    list.appendChild(el("h2", "player-menu-heading", "Subtitles"));
    list.appendChild(choice(OFF, "Off", tracks.selectedSubtitleId === undefined));
    for (const track of tracks.subtitles) {
        list.appendChild(choice(track.id, track.label, track.id === tracks.selectedSubtitleId));
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
    const tracksButton = el("button", "player-button player-tracks-button", "Audio and subtitles");
    tracksButton.type = "button";
    tracksButton.tabIndex = -1;
    tracksButton.addEventListener("click", () => openMenu());
    overlay.appendChild(title);
    overlay.appendChild(status);
    overlay.appendChild(bar);
    overlay.appendChild(time);
    overlay.appendChild(tracksButton);
    const menu = el("div", "player-menu");
    const lists = [el("div", "player-menu-list player-menu-audio"), el("div", "player-menu-list player-menu-subtitles")];
    const menuStatus = el("p", "player-menu-status");
    menuStatus.setAttribute("role", "status");
    for (const list of lists) {
        menu.appendChild(list);
    }
    menu.appendChild(menuStatus);
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
    section.appendChild(menu);
    root.appendChild(section);

    let view: PlaybackView = { phase: "closed" };
    let cancelHide: (() => void) | undefined;
    let menuOpen = false;
    /** The list (0 audio, 1 subtitles) that holds the menu's focus. */
    let column = 0;
    let drawn: string | undefined;

    const buttons = (index: number): HTMLElement[] => Array.from(lists[index]?.querySelectorAll<HTMLElement>("[data-focus]") ?? []);
    const focusedId = (): string | null => (menu.contains(document.activeElement) ? (document.activeElement?.getAttribute("data-focus") ?? null) : null);
    /** A list's current choice, else its first; undefined when it offers none. */
    const entry = (index: number): HTMLElement | undefined => {
        const all = buttons(index);
        return all.find((button) => button.className.indexOf("player-choice-current") !== -1) ?? all[0];
    };
    const focusList = (index: number): boolean => {
        const target = entry(index);
        if (target === undefined) {
            return false;
        }
        column = index;
        target.focus();
        return true;
    };

    const drawMenu = (tracks: TrackView): void => {
        const key = JSON.stringify(tracks);
        if (key !== drawn) {
            drawn = key;
            const keep = focusedId();
            for (const [index, list] of lists.entries()) {
                list.textContent = "";
                (index === 0 ? fillAudio : fillSubtitles)(list, tracks);
            }
            menuStatus.textContent = changeText(tracks);
            const same = keep === null ? undefined : buttons(column).find((button) => button.getAttribute("data-focus") === keep);
            if (same !== undefined) {
                same.focus();
            } else if (!focusList(column)) {
                focusList(1 - column);
            }
        }
    };

    const closeMenu = (): void => {
        menuOpen = false;
        drawn = undefined;
    };

    const render = (): void => {
        const showing = view.phase === "error" ? "error" : "overlay";
        failure.style.display = showing === "error" ? "block" : "none";
        overlay.style.display = showing === "overlay" ? "block" : "none";
        if (menuOpen && view.phase !== "playing" && view.phase !== "paused") {
            closeMenu();
        }
        menu.style.display = menuOpen ? "block" : "none";
        tracksButton.setAttribute("aria-expanded", String(menuOpen));
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
            tracksButton.hidden = true;
            fill.style.width = "0";
        } else {
            tracksButton.hidden = false;
            status.textContent = view.buffering ? "Buffering" : view.phase === "paused" ? "Paused" : "";
            const duration = view.durationSeconds;
            time.textContent = duration === undefined ? clockText(view.positionSeconds) : `${clockText(view.positionSeconds)} / ${clockText(duration)}`;
            fill.style.width = duration === undefined || duration <= 0 ? "0" : `${Math.min(100, (view.positionSeconds / duration) * 100)}%`;
        }
        const hidden = view.phase === "playing" && !view.buffering && cancelHide === undefined && !menuOpen;
        overlay.className = hidden ? "player-overlay player-overlay-hidden" : "player-overlay";
        if (menuOpen && view.phase !== "loading") {
            drawMenu(view.tracks);
        } else if (document.activeElement !== overlay) {
            overlay.focus();
        }
    };

    const menuKey = (key: string): void => {
        if (key === "back") {
            closeMenu();
            reveal();
            return;
        }
        const all = buttons(column);
        const at = all.findIndex((button) => button === document.activeElement);
        if (key === "up" || key === "down") {
            all[Math.max(0, Math.min(all.length - 1, at + (key === "up" ? -1 : 1)))]?.focus();
        } else if (key === "left" || key === "right") {
            focusList(key === "left" ? 0 : 1);
        } else if (key === "enter") {
            const id = focusedId();
            if (id === RETRY) {
                controls.retryTrackInfo();
            } else if (id === OFF) {
                controls.selectSubtitle(undefined);
            } else if (id !== null) {
                if (column === 0) {
                    controls.selectAudio(id);
                } else {
                    controls.selectSubtitle(id);
                }
            }
        }
    };

    menu.addEventListener("click", (event) => {
        if (!menuOpen || !(event.target instanceof Element)) {
            return;
        }
        const button = event.target.closest<HTMLButtonElement>("button[data-focus]");
        const index = button === null ? -1 : lists.findIndex((list) => list.contains(button));
        if (button !== null && index !== -1) {
            column = index;
            button.focus();
            menuKey("enter");
            render();
        }
    });

    const reveal = (): void => {
        cancelHide?.();
        cancelHide = clock.schedule(() => {
            cancelHide = undefined;
            render();
        }, OVERLAY_MS);
    };

    const openMenu = (): void => {
        if (view.phase !== "playing" && view.phase !== "paused") {
            return;
        }
        menuOpen = true;
        render();
        if (!focusList(0)) {
            focusList(1);
        }
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
        if (key === "play_pause") {
            controls.togglePause();
            reveal();
            render();
            return;
        }
        if (menuOpen) {
            menuKey(key);
            render();
            return;
        }
        reveal();
        if (key === "down" || (key === "enter" && document.activeElement === tracksButton)) {
            openMenu();
            return;
        }
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
