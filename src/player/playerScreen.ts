// Full-screen playback: the AVPlay surface plus a readable overlay for loading, progress and
// errors. Remote: Enter pauses or resumes, Left/Right preview seeking, Up enters transport,
// Enter commits a seek and Back cancels it; Down opens audio and subtitles,
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
import { mountSeekThumbnail } from "./seekThumbnailView.ts";
import { mountSubtitles } from "./subtitleView.ts";

/** While playing, the overlay hides this long after the last key. */
const OVERLAY_MS = 5000;

export interface PlayerScreen {
    destroy(): void;
}

export function errorText(error: PlaybackError): string {
    switch (error.kind) {
        case "settings":
            return "Could not read this profile's seek intervals. Check the connection and retry.";
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
        case "revoked":
            return "This profile no longer has access. Sign in again.";
        case "backgrounded":
            return "Playback stopped when you left Silo. Go back and select the title to play again.";
        case "server":
            return "The server couldn't start playback. Try again.";
    }
}

function loadingText(detail: "reconnecting" | "restoring" | undefined): string {
    switch (detail) {
        case undefined:
            return "Loading";
        case "reconnecting":
            return "Reconnecting";
        case "restoring":
            return "Restoring";
        default: {
            const never: never = detail;
            return never;
        }
    }
}

const OFF = "subtitles-off";
const SERIES_SUBTITLE = "series-subtitles";
const RETRY = "audio-retry";

function changeText(tracks: TrackView): string {
    switch (tracks.change.state) {
        case "changing":
            return tracks.change.kind === "quality" ? "Changing quality" : "Changing track";
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
    if (tracks.seriesSubtitle !== undefined) {
        const save = choice(SERIES_SUBTITLE, tracks.selectedSubtitleId === undefined ? "Keep subtitles off for this series" : "Use this subtitle choice for this series", false);
        save.setAttribute("aria-disabled", String(tracks.seriesSubtitle.busy));
        list.appendChild(save);
    }
}

function fillQuality(list: HTMLElement, tracks: TrackView): void {
    const quality = tracks.quality;
    if (quality === undefined || quality.choices.length < 2) {
        return;
    }
    list.appendChild(el("h2", "player-menu-heading", "Quality"));
    for (const qualityChoice of quality.choices) {
        list.appendChild(choice(`quality:${qualityChoice.id}`, qualityChoice.label, qualityChoice.id === quality.selectedId));
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
    const renderSubtitles = mountSubtitles(section);
    section.setAttribute("data-screen", "player");
    const surface = document.createElement("object");
    surface.type = "application/avplayer";
    surface.className = "player-video";
    surface.setAttribute("aria-hidden", "true");
    const overlay = el("div", "player-overlay");
    overlay.setAttribute("data-focus", "player");
    overlay.tabIndex = -1;
    const skip = el("button", "player-button player-skip");
    skip.type = "button";
    skip.tabIndex = -1;
    skip.setAttribute("data-focus", "skip");
    skip.addEventListener("click", () => {
        if ((view.phase !== "playing" && view.phase !== "paused") || view.skipMarker === undefined || seekPreview !== undefined || menuOpen) return;
        controls.seekToSeconds(view.skipMarker.endSeconds);
        overlay.focus();
        reveal();
        render();
    });
    const thumbnail = mountSeekThumbnail(overlay, controls, clock);
    const title = el("h1", "player-title");
    const status = el("p", "player-status");
    status.setAttribute("role", "status");
    const bar = el("div", "player-bar");
    bar.setAttribute("role", "slider");
    bar.setAttribute("aria-label", "Playback position");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("data-focus", "position");
    bar.tabIndex = -1;
    const fill = el("div", "player-bar-fill");
    bar.appendChild(fill);
    const time = el("p", "player-time");
    const tracksButton = el("button", "player-button player-tracks-button", "Audio and subtitles");
    tracksButton.type = "button";
    tracksButton.tabIndex = -1;
    tracksButton.setAttribute("data-focus", "tracks");
    tracksButton.addEventListener("click", () => openMenu());
    const transport = el("div", "player-transport");
    const backward = el("button", "player-button");
    const pause = el("button", "player-button", "Pause");
    const forward = el("button", "player-button");
    const transportButtons = [backward, pause, forward, tracksButton];
    for (const [index, button] of transportButtons.entries()) {
        button.type = "button";
        button.tabIndex = -1;
        button.setAttribute("data-focus", ["backward", "pause", "forward", "tracks"][index] ?? "");
        transport.appendChild(button);
    }
    backward.addEventListener("click", () => previewSeek("backward"));
    forward.addEventListener("click", () => previewSeek("forward"));
    pause.addEventListener("click", () => { controls.togglePause(); reveal(); render(); });
    overlay.appendChild(title);
    overlay.appendChild(status);
    overlay.appendChild(bar);
    overlay.appendChild(time);
    overlay.appendChild(transport);
    const menu = el("div", "player-menu");
    const lists = [el("div", "player-menu-list player-menu-audio"), el("div", "player-menu-list player-menu-subtitles"), el("div", "player-menu-list player-menu-quality")];
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
    back.addEventListener("click", () => view.phase === "completion" ? controls.back() : controls.dismissError());
    const retry = el("button", "player-button", "Retry");
    retry.type = "button";
    retry.setAttribute("data-focus", "settings-retry");
    retry.addEventListener("click", () => view.phase === "completion" || (view.phase === "error" && view.retryable) ? controls.retryCompletion() : controls.retrySettings());
    const next = el("button", "player-button", "Play next");
    next.type = "button";
    next.setAttribute("data-focus", "play-next");
    next.addEventListener("click", () => controls.playNext());
    const cancelAutoplay = el("button", "player-button", "Cancel autoplay");
    cancelAutoplay.type = "button";
    cancelAutoplay.setAttribute("data-focus", "cancel-autoplay");
    cancelAutoplay.addEventListener("click", () => controls.cancelAutoplay());
    failure.appendChild(failureTitle);
    failure.appendChild(failureText);
    failure.appendChild(next);
    failure.appendChild(cancelAutoplay);
    failure.appendChild(retry);
    failure.appendChild(back);
    section.appendChild(surface);
    section.appendChild(overlay);
    section.appendChild(skip);
    section.appendChild(failure);
    section.appendChild(menu);
    root.appendChild(section);

    let view: PlaybackView = { phase: "closed" };
    let cancelHide: (() => void) | undefined;
    let menuOpen = false;
    let seekPreview: number | undefined;
    /** The list (0 audio, 1 subtitles, 2 quality) that holds the menu's focus. */
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
            const hasQuality = (tracks.quality?.choices.length ?? 0) > 1;
            menu.className = hasQuality ? "player-menu player-menu-with-quality" : "player-menu";
            for (const [index, list] of lists.entries()) {
                list.textContent = "";
                list.style.display = index === 2 && !hasQuality ? "none" : "";
                (index === 0 ? fillAudio : index === 1 ? fillSubtitles : fillQuality)(list, tracks);
                for (const button of buttons(index)) {
                    button.setAttribute("aria-disabled", String(tracks.change.state === "changing"));
                }
            }
            menuStatus.textContent = [changeText(tracks), tracks.seriesSubtitle?.message].filter(Boolean).join(" ");
            const same = keep === null ? undefined : buttons(column).find((button) => button.getAttribute("data-focus") === keep);
            if (same !== undefined) {
                same.focus();
            } else if (!focusList(column)) {
                if (!focusList(0)) focusList(1);
            }
        }
    };

    const closeMenu = (): void => {
        menuOpen = false;
        drawn = undefined;
    };

    const render = (): void => {
        renderSubtitles(view);
        const active = view.phase === "playing" || view.phase === "paused";
        if (!active) seekPreview = undefined;
        const marker = view.phase === "playing" || view.phase === "paused" ? view.skipMarker : undefined;
        skip.hidden = marker === undefined || seekPreview !== undefined || menuOpen;
        if (marker !== undefined && (view.phase === "playing" || view.phase === "paused")) {
            skip.textContent = `Skip ${marker.kind} · ${Math.ceil(marker.endSeconds - view.positionSeconds)} seconds`;
        }
        if (skip.hidden && document.activeElement === skip) overlay.focus();
        if (seekPreview === undefined) thumbnail.clear();
        transport.hidden = !active;
        bar.setAttribute("aria-disabled", String(!active));
        const showing = view.phase === "error" || view.phase === "completion" ? "error" : "overlay";
        failure.style.display = showing === "error" ? "block" : "none";
        overlay.style.display = showing === "overlay" ? "block" : "none";
        if (menuOpen && view.phase !== "playing" && view.phase !== "paused") {
            closeMenu();
        }
        menu.style.display = menuOpen ? "block" : "none";
        tracksButton.setAttribute("aria-expanded", String(menuOpen));
        next.hidden = true;
        cancelAutoplay.hidden = view.phase !== "completion" || view.countdown === undefined;
        if (view.phase === "completion") {
            next.hidden = view.state !== "ready" || view.next === undefined;
            next.textContent = view.countdown === undefined ? "Play next" : `Play next (${view.countdown}s)`;
            retry.hidden = view.state !== "failed" || !view.retryable;
            failureTitle.textContent = view.title;
            failureText.textContent = view.state === "finalizing" ? "Ending playback…" : view.state === "resolving" ? "Finding the next episode…" : view.state === "failed" ? "Could not confirm playback or load the next episode." : view.next?.title ?? "No more playable episodes.";
            if (![back, retry.hidden ? undefined : retry, next.hidden ? undefined : next, cancelAutoplay.hidden ? undefined : cancelAutoplay].includes(document.activeElement as HTMLButtonElement)) {
                (!next.hidden ? next : !retry.hidden ? retry : back).focus();
            }
            return;
        }
        if (view.phase === "error") {
            retry.hidden = view.error.kind !== "settings" && !view.retryable;
            failureTitle.textContent = view.title;
            failureText.textContent = errorText(view.error);
            if (document.activeElement !== back && document.activeElement !== retry) {
                (retry.hidden ? back : retry).focus();
            }
            return;
        }
        if (view.phase === "closed") {
            return;
        }
        title.textContent = view.title;
        if (view.phase === "loading") {
            status.textContent = loadingText(view.detail);
            time.textContent = "";
            tracksButton.hidden = true;
            fill.style.width = "0";
        } else {
            backward.textContent = `Back ${view.seekIntervals.backward} seconds`;
            forward.textContent = `Forward ${view.seekIntervals.forward} seconds`;
            tracksButton.hidden = false;
            tracksButton.textContent = (view.tracks.quality?.choices.length ?? 0) > 1 ? "Audio, subtitles and quality" : "Audio and subtitles";
            pause.textContent = view.phase === "paused" ? "Play" : "Pause";
            status.textContent = view.buffering ? "Buffering" : view.phase === "paused" ? "Paused" : "";
            const duration = view.durationSeconds;
            const position = seekPreview ?? view.positionSeconds;
            time.textContent = duration === undefined ? clockText(position) : `${clockText(position)} / ${clockText(duration)}`;
            bar.setAttribute("aria-valuenow", String(position));
            bar.setAttribute("aria-valuetext", clockText(position));
            if (duration === undefined) bar.removeAttribute("aria-valuemax");
            else bar.setAttribute("aria-valuemax", String(duration));
            bar.className = seekPreview === undefined ? "player-bar" : "player-bar player-bar-preview";
            fill.style.width = duration === undefined || duration <= 0 ? "0" : `${Math.min(100, (position / duration) * 100)}%`;
        }
        const hidden = view.phase === "playing" && !view.buffering && cancelHide === undefined && !menuOpen && seekPreview === undefined && document.activeElement === overlay;
        overlay.className = hidden ? "player-overlay player-overlay-hidden" : "player-overlay";
        if (menuOpen && view.phase !== "loading") {
            drawMenu(view.tracks);
        } else if ((!overlay.contains(document.activeElement) && document.activeElement !== skip) || (view.phase === "loading" && document.activeElement !== overlay)) {
            overlay.focus();
        }
    };

    const previewSeek = (direction: "backward" | "forward"): void => {
        if (view.phase !== "playing" && view.phase !== "paused") return;
        const delta = view.seekIntervals[direction] * (direction === "backward" ? -1 : 1);
        seekPreview = Math.max(0, Math.min((seekPreview ?? view.positionSeconds) + delta, view.durationSeconds ?? Number.MAX_VALUE));
        reveal();
        render();
        bar.focus();
        thumbnail.show(seekPreview);
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
            focusList(Math.max(0, Math.min(lists.length - 1, column + (key === "left" ? -1 : 1))));
        } else if (key === "enter") {
            if ((view.phase === "playing" || view.phase === "paused") && view.tracks.change.state === "changing") {
                return;
            }
            const id = focusedId();
            if (id === RETRY) {
                controls.retryTrackInfo();
            } else if (id === OFF) {
                controls.selectSubtitle(undefined);
            } else if (id === SERIES_SUBTITLE) {
                controls.saveSeriesSubtitle();
            } else if (id !== null) {
                if (column === 0) {
                    controls.selectAudio(id);
                } else if (column === 1) {
                    controls.selectSubtitle(id);
                } else {
                    controls.selectQuality(id.slice("quality:".length));
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
        if (view.phase === "completion") {
            const buttons = [next, cancelAutoplay, retry, back].filter(button => !button.hidden);
            const index = buttons.findIndex(button => button === document.activeElement);
            if (key === "back" || key === "stop") controls.back();
            else if (key === "enter") (buttons[index] ?? buttons[0])?.click();
            else if (key === "up" || key === "left") buttons[Math.max(0, index - 1)]?.focus();
            else if (key === "down" || key === "right") buttons[Math.min(buttons.length - 1, index + 1)]?.focus();
            return;
        }
        if (view.phase === "error") {
            if (!retry.hidden && (key === "up" || key === "down" || key === "left" || key === "right")) {
                (document.activeElement === retry ? back : retry).focus();
            } else if (!retry.hidden && key === "enter" && document.activeElement === retry) {
                retry.click();
            } else if (key === "enter" || key === "back") {
                controls.dismissError();
            }
            return;
        }
        if (!skip.hidden && document.activeElement === skip && (key === "enter" || key === "play")) {
            skip.click();
            return;
        }
        if (key === "play_pause" || key === "play" || key === "pause" || key === "stop" || key === "rewind" || key === "fast_forward") {
            if (seekPreview !== undefined) overlay.focus();
            seekPreview = undefined;
            if (key === "stop") {
                controls.back();
                return;
            }
            if (key === "play_pause") controls.togglePause();
            else if (key === "play" || key === "pause") controls.setPaused(key === "pause");
            else if (view.phase === "playing" || view.phase === "paused") controls.seekBy(key === "rewind" ? -view.seekIntervals.backward : view.seekIntervals.forward);
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
        if (seekPreview !== undefined) {
            if (key === "left" || key === "right") previewSeek(key === "left" ? "backward" : "forward");
            else if (key === "enter" || key === "back") {
                const target = seekPreview;
                seekPreview = undefined;
                overlay.focus();
                if (key === "enter") controls.seekToSeconds(target);
            }
            render();
            return;
        }
        const at = transportButtons.findIndex(button => button === document.activeElement);
        if (document.activeElement === skip && (key === "down" || key === "back")) {
            pause.focus();
            render();
            return;
        }
        if (at >= 0 && (key === "left" || key === "right")) {
            transportButtons[Math.max(0, Math.min(transportButtons.length - 1, at + (key === "left" ? -1 : 1)))]?.focus();
            render();
            return;
        }
        if (key === "up" && (view.phase === "playing" || view.phase === "paused")) {
            (skip.hidden ? pause : skip).focus();
            render();
            return;
        }
        if (key === "back" && at >= 0) {
            overlay.focus();
            render();
            return;
        }
        if (key === "enter" && at >= 0) {
            transportButtons[at]?.click();
            return;
        }
        if (key === "down" || (key === "enter" && document.activeElement === tracksButton)) {
            openMenu();
            return;
        }
        if (key === "back") {
            controls.back();
        } else if (key === "enter") {
            controls.togglePause();
        } else if (key === "left") {
            previewSeek("backward");
        } else if (key === "right") {
            previewSeek("forward");
        }
        render();
    };

    const onVisibility = (): void => {
        if (document.hidden) {
            seekPreview = undefined;
            thumbnail.clear();
            cancelHide?.();
            cancelHide = undefined;
            if (view.phase !== "closed" && view.phase !== "error") {
                controls.suspend();
            }
        } else {
            controls.restore();
            render();
        }
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVisibility);
    const unsubscribe = controls.subscribe((next) => {
        const starting = next.phase === "playing" && view.phase !== "playing" && view.phase !== "paused";
        if ((next.phase === "playing" || next.phase === "paused") && (view.phase === "playing" || view.phase === "paused") && next.previewKey !== view.previewKey) {
            seekPreview = undefined;
            thumbnail.clear();
        }
        view = next;
        if (document.hidden && next.phase !== "closed" && next.phase !== "error") {
            onVisibility();
        }
        if (starting) {
            reveal();
        }
        render();
    });

    return {
        destroy() {
            thumbnail.clear();
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
