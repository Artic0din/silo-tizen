// Full-screen playback: the AVPlay surface plus a readable overlay for loading, progress and
// errors. Remote matches the Apple TV transport: Left/Right step the skip interval, Select
// enters timeline scrub, Select again commits or resumes, Menu cancels, and a held arrow
// auto-seeks. Down from the scrubber focuses Play/Pause and Up returns. Options opens the
// panel. In that panel Up/Down move within a list, Left/Right switch tabs, Enter chooses
// and Back closes it; no key reaches playback while it is open. The screen owns one child of the
// root and removes only that child, so a screen the parent already showed (after a profile
// switch, say) is never erased.

import type { Clock } from "../api/clock.ts";
import { systemClock } from "../api/clock.ts";
import type { ConnectedServer } from "../session/core.ts";
import type { RandomBytes } from "../session/deviceIdentity.ts";
import { remoteKey } from "../ui/keys.ts";
import { el } from "../ui/screen.ts";
import { artworkUrl } from "../ui/browseModel.ts";
import type { AVPlay } from "./avplay.ts";
import { type PlaybackError, type PlaybackExits, PlaybackController, type PlaybackView, type PlayerControls, type PlayRequest, type TrackView } from "./controller.ts";
import { closeIcon, optionsIcon, pauseIcon, playIcon, skipIcon } from "./playerIcons.ts";
import { mountSeekThumbnail } from "./seekThumbnailView.ts";
import { mountSubtitles } from "./subtitleView.ts";
import { fillHUDPane } from "./hudPanes.ts";
import { currentChapter } from "./playerHUD.ts";

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

function choice(id: string, label: string, current: boolean, detail?: string): HTMLButtonElement {
    const button = el("button", "player-choice");
    button.type = "button";
    button.setAttribute("data-focus", id);
    button.setAttribute("aria-pressed", String(current));
    const copy = el("span", "player-choice-copy");
    copy.appendChild(el("span", "player-choice-label", label));
    if (detail !== undefined && detail !== "") copy.appendChild(el("span", "player-choice-detail", detail));
    button.appendChild(copy);
    if (current) {
        button.className = "player-choice player-choice-current";
    }
    return button;
}

function fillAudio(list: HTMLElement, tracks: TrackView): void {
    list.appendChild(el("h2", "player-menu-heading", "TRACKS"));
    const audio = tracks.audio;
    if (audio.state === "loading") {
        list.appendChild(el("p", "player-menu-note", "Loading audio tracks"));
    } else if (audio.state === "failed") {
        list.appendChild(el("p", "player-menu-note", "Couldn't load audio tracks."));
        list.appendChild(choice(RETRY, "Retry", false));
    } else if (audio.choices.length === 0) {
        const note = el("p", "player-menu-note", "No audio tracks listed");
        note.tabIndex = -1;
        note.setAttribute("data-focus", "audio-empty");
        list.appendChild(note);
    } else {
        for (const track of audio.choices) {
            list.appendChild(choice(track.id, track.label, track.id === tracks.selectedAudioId, track.detail));
        }
    }
}

function fillSubtitles(list: HTMLElement, tracks: TrackView, languages = false): void {
    list.appendChild(el("h2", "player-menu-heading", "TRACKS"));
    const ai = tracks.ai;
    if (languages && ai !== undefined) {
        list.appendChild(choice("ai-language-back", "Back to subtitles", false));
        for (const language of ai.languages) list.appendChild(choice(`ai-language:${language}`, `Translate to ${language.toUpperCase()}`, false));
        return;
    }
    list.appendChild(choice(OFF, "Off", tracks.selectedSubtitleId === undefined));
    for (const track of tracks.subtitles) {
        list.appendChild(choice(track.id, track.label, track.id === tracks.selectedSubtitleId, track.detail));
    }
    if (tracks.seriesSubtitle !== undefined) {
        const save = choice(SERIES_SUBTITLE, tracks.selectedSubtitleId === undefined ? "Keep subtitles off for this series" : "Use this subtitle choice for this series", false);
        save.setAttribute("aria-disabled", String(tracks.seriesSubtitle.busy));
        list.appendChild(save);
    }
    if (ai !== undefined) {
        if (ai.available.translate && tracks.aiTranslate && ai.languages.length > 0) list.appendChild(choice("ai-translate", "Translate current subtitles", false));
        if (ai.available.transcribe) list.appendChild(choice("ai-transcribe", "Transcribe current audio", false));
        for (const result of ai.results) list.appendChild(choice(`ai-result:${result.id}`, result.label, false));
    }
}

function fillQuality(list: HTMLElement, tracks: TrackView): void {
    const quality = tracks.quality;
    if (quality === undefined || quality.choices.length < 2) {
        return;
    }
    list.appendChild(el("h2", "player-menu-heading", "PLAYBACK"));
    for (const qualityChoice of quality.choices) {
        list.appendChild(choice(`quality:${qualityChoice.id}`, qualityChoice.label, qualityChoice.id === quality.selectedId));
    }
}

/** Apple's seekRates ladder. A hold starts at ±1; further taps move one step. */
const SEEK_RATES = [-32, -16, -8, -4, -2, -1, 1, 2, 4, 8, 16, 32] as const;
/** PressCaptureUIView holdThreshold. A shorter press is a tap. */
const HOLD_MS = 300;
/** PlayerViewModel skipDebounceNanos. Rapid taps become one seek. */
const SKIP_DEBOUNCE_MS = 200;
/** PlayerViewModel holdSeekTickNanos, and the tvOS timeline auto-seek tick. */
const AUTO_SEEK_MS = 100;
/** TVPlayerScrubber timelineAutoSeekBaseStep. Each tick moves 2s times the rate. */
const AUTO_SEEK_STEP = 2;

/** Compact runtime for the Info pane. PlayerTimeFormatter.formatRuntime. */
export function runtimeText(seconds: number | undefined): string | undefined {
    if (seconds === undefined || !(seconds > 0)) return undefined;
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    return `${minutes}m`;
}

function infoRow(label: string, value: string): HTMLElement {
    const row = el("p", "player-info-row");
    row.append(el("span", "player-info-label", label), el("span", "player-info-value", value));
    return row;
}

export function clockText(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const two = (value: number): string => (value < 10 ? `0${value}` : String(value));
    return hours > 0 ? `${hours}:${two(minutes)}:${two(secs)}` : `${minutes}:${two(secs)}`;
}

export function mountPlayerScreen(root: HTMLElement, controls: PlayerControls, clock: Clock = systemClock, baseUrl = location.origin): PlayerScreen {
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
        if ((view.phase !== "playing" && view.phase !== "paused") || seekPreview !== undefined || menuOpen) return;
        const target = view.undoSkipSeconds ?? view.skipMarker?.endSeconds;
        if (target === undefined) return;
        controls.seekToSeconds(target);
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
    bar.setAttribute("aria-label", "Scrubber");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("data-focus", "position");
    bar.tabIndex = -1;
    const track = el("div", "player-bar-track");
    const fill = el("div", "player-bar-fill");
    const puck = el("div", "player-puck");
    track.appendChild(fill);
    const rate = el("p", "player-rate");
    rate.hidden = true;
    const rateValue = el("span", "player-rate-value");
    rate.append(rateValue);
    bar.append(track, puck, rate);
    const time = el("p", "player-time");
    const elapsed = el("span", "player-time-elapsed");
    const remaining = el("span", "player-time-remaining");
    time.append(elapsed, remaining);
    const tracksButton = el("button", "player-button player-tracks-button");
    tracksButton.type = "button";
    tracksButton.tabIndex = -1;
    tracksButton.setAttribute("data-focus", "tracks");
    tracksButton.setAttribute("aria-label", "Info and options");
    tracksButton.appendChild(el("span", "player-glyph"));
    tracksButton.firstElementChild?.setAttribute("aria-hidden", "true");
    tracksButton.addEventListener("click", () => openMenu());
    const closeButton = el("button", "player-button player-close-button");
    closeButton.type = "button";
    closeButton.tabIndex = -1;
    closeButton.setAttribute("data-focus", "close");
    closeButton.setAttribute("aria-label", "Close player");
    closeButton.appendChild(el("span", "player-glyph"));
    closeButton.firstElementChild?.setAttribute("aria-hidden", "true");
    closeButton.addEventListener("click", () => controls.back());
    const transport = el("div", "player-transport");
    const primaryGroup = el("div", "player-transport-group");
    const secondaryGroup = el("div", "player-transport-group player-transport-secondary");
    const backward = el("button", "player-button");
    const pause = el("button", "player-button player-button-primary");
    const forward = el("button", "player-button");
    const transportButtons = [backward, pause, forward, tracksButton, closeButton];
    for (const [index, button] of transportButtons.entries()) {
        button.type = "button";
        button.tabIndex = -1;
        button.setAttribute("data-focus", ["backward", "pause", "forward", "tracks", "close"][index] ?? "");
        if (button !== tracksButton && button !== closeButton) button.appendChild(el("span", "player-glyph"));
        button.firstElementChild?.setAttribute("aria-hidden", "true");
    }
    primaryGroup.append(backward, pause, forward);
    secondaryGroup.append(tracksButton, closeButton);
    transport.append(primaryGroup, secondaryGroup);
    backward.addEventListener("click", () => stepSkip("backward"));
    forward.addEventListener("click", () => stepSkip("forward"));
    pause.addEventListener("click", () => { controls.togglePause(); reveal(); render(); });
    overlay.appendChild(title);
    overlay.appendChild(status);
    overlay.appendChild(bar);
    overlay.appendChild(time);
    overlay.appendChild(transport);
    const hud = el("div", "player-hud");
    hud.hidden = true;
    const tablist = el("div", "player-tabs");
    tablist.setAttribute("role", "tablist");
    tablist.setAttribute("aria-label", "Player options");
    const tabNames = ["Info", "Stats", "Video", "Audio", "Subtitles", "Chapters"] as const;
    const tabs = tabNames.map((name) => {
        const tab = el("button", "player-tab", name);
        tab.type = "button";
        tab.tabIndex = -1;
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", "false");
        return tab;
    });
    for (const tab of tabs) tablist.appendChild(tab);
    const menu = el("div", "player-menu");
    const panes = el("div", "player-menu-panes");
    const lists = tabNames.map(name => el("div", `player-menu-list player-menu-${name === "Video" ? "quality" : name.toLowerCase()}`));
    const menuStatus = el("p", "player-menu-status");
    menuStatus.setAttribute("role", "status");
    for (const list of lists) panes.appendChild(list);
    menu.append(panes, menuStatus);
    hud.append(tablist, menu);
    const failure = el("div", "player-error");
    failure.setAttribute("role", "alert");
    const failureTitle = el("h1", "player-title");
    const eyebrow = el("p", "player-next-eyebrow");
    const synopsis = el("p", "player-next-synopsis");
    const deck = el("div", "player-next-deck");
    const keep = el("button", "player-button", "Keep Watching");
    keep.type = "button";
    keep.setAttribute("data-focus", "keep-watching");
    keep.addEventListener("click", () => controls.keepWatching());
    const failureText = el("p", "player-error-text");
    const back = el("button", "player-button", "Back");
    back.type = "button";
    back.setAttribute("data-focus", "back");
    back.addEventListener("click", () => view.phase === "completion" || ((view.phase === "playing" || view.phase === "paused") && view.upNext !== undefined) ? controls.keepWatching() : controls.dismissError());
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
    failure.appendChild(eyebrow);
    failure.appendChild(failureTitle);
    failure.appendChild(failureText);
    failure.appendChild(synopsis);
    failure.appendChild(next);
    failure.appendChild(keep);
    failure.appendChild(cancelAutoplay);
    failure.appendChild(retry);
    failure.appendChild(back);
    failure.appendChild(deck);
    section.appendChild(surface);
    section.appendChild(overlay);
    section.appendChild(skip);
    section.appendChild(failure);
    section.appendChild(hud);
    root.appendChild(section);

    let view: PlaybackView = { phase: "closed" };
    let cancelHide: (() => void) | undefined;
    let menuOpen = false;
    let seekPreview: number | undefined;
    let pendingSkipTarget: number | undefined;
    /** Select entered timeline scrub. Left/Right move the preview until Select or Menu. */
    let timeline = false;
    let timelineMoved = false;
    /** Playing when timeline scrub began, so a later Select resumes. */
    let resumeAfterTimeline = false;
    let readyPreviewKey: string | undefined;
    let holdPausedAtCommandCount: number | undefined;
    /** 0 when auto-seek is idle. Otherwise one of SEEK_RATES. */
    let autoRate = 0;
    let pendingTap: "left" | "right" | undefined;
    let cancelDebounce: (() => void) | undefined;
    let cancelHold: (() => void) | undefined;
    let cancelAuto: (() => void) | undefined;
    /** The list (0 info, 1 audio, 2 subtitles, 3 quality) that holds the menu's focus. */
    let column = 0;
    let drawn: string | undefined;
    let aiLanguages = false;

    const buttons = (index: number): HTMLElement[] => Array.from(lists[index]?.querySelectorAll<HTMLElement>("[data-focus]") ?? []);
    const focusedId = (): string | null => (menu.contains(document.activeElement) ? (document.activeElement?.getAttribute("data-focus") ?? null) : null);
    /** A list's current choice, else its first; undefined when it offers none. */
    const entry = (index: number): HTMLElement | undefined => {
        const all = buttons(index);
        return all.find((button) => button.className.indexOf("player-choice-current") !== -1) ?? all[0];
    };
    const showPane = (index: number): void => {
        column = index;
        for (const [pane, list] of lists.entries()) {
            list.classList.toggle("player-menu-pane-active", pane === index);
        }
        for (const [pane, tab] of tabs.entries()) {
            const available = lists[pane]?.style.display !== "none";
            tab.hidden = !available;
            tab.setAttribute("aria-selected", String(pane === index && available));
        }
    };
    const focusList = (index: number): boolean => {
        const target = entry(index);
        if (target === undefined) {
            return false;
        }
        showPane(index);
        target.focus();
        return true;
    };
    tabs.forEach((tab, index) => tab.addEventListener("click", () => { if (menuOpen) focusList(index); }));

    const fillInfo = (list: HTMLElement, tracks: TrackView): void => {
        if (view.phase !== "playing" && view.phase !== "paused") return;
        const body = el("div", "player-info");
        body.tabIndex = -1;
        body.setAttribute("data-focus", "info");
        const titleColumn = el("div", "player-info-column");
        titleColumn.appendChild(el("h2", "player-menu-heading", "TITLE"));
        titleColumn.appendChild(el("p", "player-info-title", view.title));
        const metadata = view.hud?.metadata;
        if (metadata?.seriesTitle) titleColumn.appendChild(infoRow("Series", metadata.seriesTitle));
        if (metadata?.year !== undefined) titleColumn.appendChild(infoRow("Year", String(metadata.year)));
        if (metadata?.contentRating) titleColumn.appendChild(infoRow("Rating", metadata.contentRating));
        if (metadata?.genres.length) titleColumn.appendChild(infoRow("Genres", metadata.genres.join(", ")));
        const runtime = runtimeText(view.durationSeconds);
        if (runtime !== undefined) titleColumn.appendChild(el("p", "player-info-meta", runtime));
        if (view.hud?.overview) titleColumn.appendChild(el("p", "player-info-meta", view.hud.overview));
        const stream = el("div", "player-info-column");
        stream.appendChild(el("h2", "player-menu-heading", "STREAM"));
        const selectedAudio = tracks.audio.state === "ready" ? tracks.audio.choices.find((choice) => choice.id === tracks.selectedAudioId) : undefined;
        if (selectedAudio !== undefined) {
            stream.appendChild(infoRow("Audio", selectedAudio.detail === undefined ? selectedAudio.label : `${selectedAudio.label} · ${selectedAudio.detail}`));
        }
        const selectedSubtitle = tracks.subtitles.find((choice) => choice.id === tracks.selectedSubtitleId);
        const subtitleText = selectedSubtitle === undefined ? "Off" : selectedSubtitle.detail === undefined ? selectedSubtitle.label : `${selectedSubtitle.label} · ${selectedSubtitle.detail}`;
        stream.appendChild(infoRow("Subtitles", subtitleText));
        const hud = view.hud;
        if (hud !== undefined) {
            const chapter = hud.chapters[currentChapter(hud.chapters, view.positionSeconds)];
            if (chapter !== undefined) stream.appendChild(infoRow("Chapter", chapter.title));
            if (hud.chapterState === "loading") stream.appendChild(el("p", "player-menu-note", "Loading chapters"));
            if (hud.chapterState === "failed") {
                stream.appendChild(el("p", "player-menu-note", "Couldn't load chapters."));
                stream.appendChild(choice("chapters-retry", "Retry chapters", false));
            }
            if (hud.metadataFailed && hud.chapterState !== "failed") {
                stream.appendChild(el("p", "player-menu-note", "Couldn't load title details."));
                stream.appendChild(choice("chapters-retry", "Retry details", false));
            }
        }
        body.append(titleColumn, stream);
        list.appendChild(body);
    };

    const drawMenu = (tracks: TrackView): void => {
        const identity = view.phase === "playing" || view.phase === "paused" ? [view.title, view.durationSeconds, view.hud, currentChapter(view.hud?.chapters ?? [], view.positionSeconds)] : [];
        const key = JSON.stringify([tracks, aiLanguages, identity]);
        if (key !== drawn) {
            drawn = key;
            const keep = focusedId();
            const hasQuality = (tracks.quality?.choices.length ?? 0) > 1;
            for (const [index, list] of lists.entries()) {
                list.textContent = "";
                const name = tabNames[index];
                const hud = view.phase === "playing" || view.phase === "paused" ? view.hud : undefined;
                const hidden = name === "Chapters" && (hud?.chapters.length ?? 0) === 0 || name === "Audio" && tracks.audio.state === "ready" && tracks.audio.choices.length === 0 || name === "Subtitles" && tracks.subtitles.length === 0 && !tracks.aiTranslate && !tracks.ai?.available.transcribe;
                list.style.display = hidden ? "none" : "";
                if (hidden) continue;
                if (name === "Info") fillInfo(list, tracks);
                else if (name === "Audio") fillAudio(list, tracks);
                else if (name === "Subtitles") fillSubtitles(list, tracks, aiLanguages);
                else {
                    fillHUDPane(list, name ?? "", hud, view.phase === "playing" || view.phase === "paused" ? view.positionSeconds : 0, choice, clockText);
                    if (name === "Video" && hasQuality) {
                        list.querySelector('[data-focus="video-empty"]')?.remove();
                        fillQuality(list, tracks);
                    }
                }
                for (const button of buttons(index)) {
                    const id = button.getAttribute("data-focus") ?? "";
                    const aiAction = id === "ai-translate" || id === "ai-transcribe" || id.startsWith("ai-language:");
                    const quota = tracks.ai?.quota;
                    const blocked = tracks.change.state === "changing" || (id === "auto-next" && hud?.busy === true) || (id === SERIES_SUBTITLE && tracks.seriesSubtitle?.busy === true) || (aiAction && tracks.ai?.busy === true) || (id === "ai-transcribe" && (quota === undefined || (quota.limited && quota.remaining <= 0)));
                    button.setAttribute("aria-disabled", String(blocked));
                }
            }
            const quota = tracks.ai?.quota;
            const quotaText = tracks.ai?.available.transcribe !== true ? "" : quota === undefined ? "Transcription quota unavailable." : quota.limited ? `Transcription quota: ${Math.max(0, quota.remaining)} remaining (${quota.period}).${quota.remaining <= 0 ? " Quota exhausted." : ""}` : "Transcription quota: unlimited.";
            menuStatus.textContent = [changeText(tracks), tracks.seriesSubtitle?.message, quotaText, tracks.ai?.message, view.phase === "playing" || view.phase === "paused" ? view.hud?.message : undefined].filter(Boolean).join(" ");
            const same = keep === null ? undefined : buttons(column).find((button) => button.getAttribute("data-focus") === keep);
            if (same !== undefined) {
                same.focus();
            } else if (!focusList(column)) {
                if (!focusList(0)) focusList(1);
            }
            showPane(column);
        }
    };

    const closeMenu = (): void => {
        aiLanguages = false;
        menuOpen = false;
        drawn = undefined;
    };

    const render = (): void => {
        renderSubtitles(view);
        const prompt = view.phase === "playing" || view.phase === "paused" ? view.upNext : undefined;
        const active = view.phase === "playing" || view.phase === "paused";
        if (!active && (seekPreview !== undefined || timeline || autoRate !== 0)) cancelScrub();
        const marker = view.phase === "playing" || view.phase === "paused" ? view.skipMarker : undefined;
        const undo = (view.phase === "playing" || view.phase === "paused") && view.undoSkipSeconds !== undefined;
        skip.hidden = (!undo && marker === undefined) || seekPreview !== undefined || menuOpen;
        if (marker !== undefined && (view.phase === "playing" || view.phase === "paused")) {
            skip.textContent = `Skip ${marker.kind} · ${Math.ceil(marker.endSeconds - view.positionSeconds)} seconds`;
        }
        if (undo) skip.textContent = "Undo skip";
        if (skip.hidden && document.activeElement === skip) bar.focus();
        if (seekPreview === undefined) thumbnail.clear();
        transport.hidden = !active;
        bar.setAttribute("aria-disabled", String(!active));
        const showing = view.phase === "error" || view.phase === "completion" || prompt !== undefined ? "error" : "overlay";
        failure.style.display = showing === "error" ? "block" : "none";
        overlay.style.display = showing === "overlay" ? "block" : "none";
        if (menuOpen && view.phase !== "playing" && view.phase !== "paused") {
            closeMenu();
        }
        hud.hidden = !menuOpen;
        tracksButton.setAttribute("aria-expanded", String(menuOpen));
        next.hidden = true;
        keep.hidden = prompt === undefined;
        eyebrow.hidden = view.phase !== "completion" && prompt === undefined;
        synopsis.hidden = eyebrow.hidden;
        deck.hidden = eyebrow.hidden;
        cancelAutoplay.hidden = view.phase !== "completion" || view.countdown === undefined;
        if (view.phase === "completion" || prompt !== undefined) {
            cancelScrub();
            closeMenu();
            hud.hidden = true;
            skip.hidden = true;
            const candidate = view.phase === "completion" ? view.next : prompt?.next;
            const cards = view.phase === "completion" ? view.deck ?? [] : prompt?.deck ?? [];
            const seconds = view.phase === "completion" ? view.countdown : prompt?.countdown;
            const status = view.phase === "completion" ? view.title : prompt?.status ?? "Up Next";
            failure.classList.add("player-next-up");
            eyebrow.textContent = status;
            synopsis.textContent = candidate?.overview ?? "";
            const identity = cards.map(card => card.contentId).join("|");
            if (deck.dataset.items !== identity) {
                const focusedCard = deck.contains(document.activeElement) ? document.activeElement?.getAttribute("data-focus") : undefined;
                deck.dataset.items = identity;
                deck.replaceChildren();
                if (cards.length > 0) deck.appendChild(el("h2", "player-menu-heading", "On Deck"));
                for (const card of cards) {
                    const button = el("button", "player-choice player-next-card", card.title);
                    button.type = "button";
                    button.setAttribute("data-focus", `deck:${card.contentId}`);
                    const backdrop = artworkUrl(card.backdropUrl, baseUrl);
                    if (backdrop !== undefined) {
                        const img = document.createElement("img");
                        img.src = backdrop;
                        img.alt = "";
                        img.addEventListener("error", () => img.remove(), { once: true });
                        button.prepend(img);
                    }
                    button.addEventListener("click", () => {
                        const current = view.phase === "completion" ? view.deck : view.phase === "playing" || view.phase === "paused" ? view.upNext?.deck : undefined;
                        const selected = current?.find(candidate => candidate.contentId === card.contentId);
                        if (selected !== undefined) controls.playNext(selected);
                    });
                    deck.appendChild(button);
                }
                if (focusedCard !== undefined) {
                    Array.from(deck.querySelectorAll<HTMLButtonElement>("button")).find(button => button.getAttribute("data-focus") === focusedCard)?.focus();
                }
            }
            if (view.phase !== "completion") {
                next.hidden = candidate === undefined;
                next.textContent = "Play Now";
                retry.hidden = true;
                cancelAutoplay.hidden = true;
                failureTitle.textContent = candidate?.title ?? "Almost finished";
                failureText.textContent = seconds === undefined ? "" : `Playing in ${seconds}s`;
                if (!failure.contains(document.activeElement)) (next.hidden ? keep : next).focus();
                return;
            }
            next.hidden = view.state !== "ready" || view.next === undefined;
            next.textContent = "Play Now";
            retry.hidden = view.state !== "failed" || !view.retryable;
            failureTitle.textContent = candidate?.title ?? (view.state === "ready" ? "End of playback" : view.title);
            failureText.textContent = view.state === "finalizing" ? "Ending playback…" : view.state === "resolving" ? "Finding the next episode…" : view.state === "failed" ? "Could not confirm playback or load the next episode." : view.next?.title ?? "No more playable episodes.";
            if (view.countdown !== undefined) failureText.textContent = `Playing in ${view.countdown}s`;
            if (!failure.contains(document.activeElement) || (document.activeElement as HTMLElement).hidden) {
                (!next.hidden ? next : !retry.hidden ? retry : back).focus();
            }
            return;
        }
        if (view.phase === "error") {
            failure.classList.remove("player-next-up");
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
            elapsed.textContent = "";
            remaining.hidden = true;
            remaining.textContent = "";
            tracksButton.hidden = true;
            fill.style.width = "0";
            puck.style.left = "0";
        } else {
            const backwardSeconds = view.seekIntervals.backward;
            const forwardSeconds = view.seekIntervals.forward;
            setIcon(backward, backwardSeconds === 1 ? "Back 1 second" : `Back ${backwardSeconds} seconds`, skipIcon("backward", backwardSeconds));
            setIcon(forward, forwardSeconds === 1 ? "Forward 1 second" : `Forward ${forwardSeconds} seconds`, skipIcon("forward", forwardSeconds));
            tracksButton.hidden = false;
            setIcon(tracksButton, "Info and options", optionsIcon());
            setIcon(closeButton, "Close player", closeIcon());
            setIcon(pause, view.phase === "paused" ? "Play" : "Pause", view.phase === "paused" ? playIcon() : pauseIcon());
            status.textContent = view.buffering ? "Buffering" : view.phase === "paused" ? "Paused" : "";
            const duration = view.durationSeconds;
            const position = seekPreview ?? view.positionSeconds;
            elapsed.textContent = clockText(position);
            if (duration === undefined || duration <= 0) {
                remaining.hidden = true;
                remaining.textContent = "";
            } else {
                remaining.hidden = false;
                remaining.textContent = `−${clockText(Math.max(0, duration - position))}`;
            }
            bar.setAttribute("aria-valuenow", String(position));
            bar.setAttribute("aria-valuetext", clockText(position));
            if (duration === undefined) bar.removeAttribute("aria-valuemax");
            else bar.setAttribute("aria-valuemax", String(duration));
            bar.className = timeline ? "player-bar player-bar-preview" : "player-bar";
            rate.hidden = autoRate === 0;
            rateValue.textContent = autoRate === 0 ? "" : `${Math.abs(autoRate)}x`;
            const fraction = duration === undefined || duration <= 0 ? 0 : Math.min(100, (position / duration) * 100);
            fill.style.width = `${fraction}%`;
            puck.style.left = `${fraction}%`;
        }
        const resting = document.activeElement === overlay || document.activeElement === bar;
        const hidden = view.phase === "playing" && !view.buffering && cancelHide === undefined && !menuOpen && seekPreview === undefined && resting;
        overlay.className = hidden ? "player-overlay player-overlay-hidden" : "player-overlay";
        if (menuOpen && view.phase !== "loading") {
            drawMenu(view.tracks);
        } else if (view.phase === "loading") {
            if (document.activeElement !== overlay) overlay.focus();
        } else if (active) {
            const focusedNode = document.activeElement;
            const held = (menuOpen && menu.contains(focusedNode)) || transport.contains(focusedNode) || focusedNode === bar || (focusedNode === skip && !skip.hidden);
            if (!held) {
                if (!skip.hidden) skip.focus();
                else bar.focus();
            }
        }
    };

    const setIcon = (button: HTMLButtonElement, label: string, mark: string): void => {
        button.setAttribute("aria-label", label);
        const glyph = button.querySelector(".player-glyph");
        if (glyph !== null) glyph.innerHTML = mark;
    };

    const stopSeekTimers = (): void => {
        cancelDebounce?.();
        cancelDebounce = undefined;
        cancelHold?.();
        cancelHold = undefined;
        cancelAuto?.();
        cancelAuto = undefined;
        pendingTap = undefined;
    };

    /** Drop a preview or timeline scrub without seeking. A timeline pause stays paused. */
    const cancelScrub = (returnHeldResume = false): void => {
        const resume = returnHeldResume && holdPausedAtCommandCount !== undefined && (view.phase === "playing" || view.phase === "paused") && view.transportCommandCount === holdPausedAtCommandCount;
        holdPausedAtCommandCount = undefined;
        stopSeekTimers();
        seekPreview = undefined;
        timeline = false;
        timelineMoved = false;
        resumeAfterTimeline = false;
        autoRate = 0;
        thumbnail.clear();
        if (resume) controls.setPaused(false);
    };

    const clampSeek = (raw: number): number => {
        const duration = view.phase === "playing" || view.phase === "paused" ? view.durationSeconds : undefined;
        if (duration !== undefined && duration > 0) return Math.min(Math.max(0, raw), duration);
        return Math.max(0, raw);
    };

    const scheduleSkipCommit = (): void => {
        cancelDebounce?.();
        cancelDebounce = clock.schedule(() => {
            cancelDebounce = undefined;
            if (timeline || seekPreview === undefined) return;
            const target = seekPreview;
            pendingSkipTarget = target;
            seekPreview = undefined;
            thumbnail.clear();
            controls.seekToSeconds(target);
            render();
        }, SKIP_DEBOUNCE_MS);
    };

    const stepSkip = (direction: "backward" | "forward"): void => {
        if (view.phase !== "playing" && view.phase !== "paused") return;
        const delta = view.seekIntervals[direction] * (direction === "backward" ? -1 : 1);
        seekPreview = clampSeek((seekPreview ?? pendingSkipTarget ?? view.positionSeconds) + delta);
        reveal();
        bar.focus();
        thumbnail.show(seekPreview);
        scheduleSkipCommit();
        render();
    };

    const stepTimeline = (delta: number): void => {
        if (view.phase !== "playing" && view.phase !== "paused") return;
        const duration = view.durationSeconds;
        if (duration === undefined || duration <= 0) return;
        const base = seekPreview ?? view.positionSeconds;
        const target = clampSeek(base + delta);
        if (target !== base) timelineMoved = true;
        seekPreview = target;
        thumbnail.show(target);
        render();
    };

    const startAutoSeek = (rate: number): void => {
        if (view.phase !== "playing" && view.phase !== "paused") return;
        const duration = view.durationSeconds;
        if (duration === undefined || duration <= 0) return;
        cancelDebounce?.();
        cancelDebounce = undefined;
        if (!timeline) {
            const pendingResume = view.resumePending === true;
            resumeAfterTimeline = view.phase === "playing" || pendingResume;
            if (pendingResume) {
                const command = view.transportCommandCount ?? 0;
                controls.setPaused(true);
                holdPausedAtCommandCount = command + 1;
            }
            timeline = true;
            timelineMoved = false;
            seekPreview = view.positionSeconds;
        }
        autoRate = rate;
        cancelAuto?.();
        const tick = (): void => {
            if (autoRate === 0) return;
            stepTimeline(AUTO_SEEK_STEP * autoRate);
            cancelAuto = clock.schedule(tick, AUTO_SEEK_MS);
        };
        tick();
    };

    const adjustAutoRate = (delta: number): void => {
        const index = SEEK_RATES.indexOf(autoRate as typeof SEEK_RATES[number]);
        if (index < 0) return;
        const next = Math.max(0, Math.min(SEEK_RATES.length - 1, index + delta));
        const rate = SEEK_RATES[next];
        if (rate === undefined) return;
        autoRate = rate;
        render();
    };

    const armHold = (direction: "left" | "right"): void => {
        pendingTap = direction;
        cancelHold?.();
        cancelHold = clock.schedule(() => {
            cancelHold = undefined;
            pendingTap = undefined;
            startAutoSeek(direction === "left" ? -1 : 1);
        }, HOLD_MS);
    };

    const enterTimeline = (): void => {
        if (view.phase !== "playing" && view.phase !== "paused") return;
        const duration = view.durationSeconds;
        if (duration === undefined || duration <= 0) return;
        cancelDebounce?.();
        cancelDebounce = undefined;
        resumeAfterTimeline = view.phase === "playing" || view.resumePending === true;
        if (resumeAfterTimeline) controls.setPaused(true);
        timeline = true;
        timelineMoved = false;
        autoRate = 0;
        seekPreview = view.positionSeconds;
        reveal();
        bar.focus();
        thumbnail.show(seekPreview);
        render();
    };

    const commitTimeline = (): void => {
        const moved = timelineMoved;
        const resume = resumeAfterTimeline;
        const target = seekPreview;
        cancelScrub();
        if (moved && target !== undefined) controls.seekToSeconds(target);
        if (resume) controls.setPaused(false);
        bar.focus();
        render();
    };

    const commitSkip = (): void => {
        cancelDebounce?.();
        cancelDebounce = undefined;
        const target = seekPreview;
        seekPreview = undefined;
        thumbnail.clear();
        if (target !== undefined) controls.seekToSeconds(target);
        bar.focus();
        render();
    };

    const onSelectScrubber = (): void => {
        if (timeline) commitTimeline();
        else if (seekPreview !== undefined) commitSkip();
        else enterTimeline();
    };

    const scrubberOwnsArrows = (): boolean => {
        if (menuOpen || (view.phase !== "playing" && view.phase !== "paused")) return false;
        return !transport.contains(document.activeElement);
    };

    const menuKey = (key: string): void => {
        if (key === "back") {
            if (aiLanguages) { aiLanguages = false; return; }
            closeMenu();
            reveal();
            return;
        }
        const all = buttons(column);
        const at = all.findIndex((button) => button === document.activeElement);
        if (key === "up" || key === "down") {
            const pane = lists[column];
            if (focusedId() === "info" && tabNames[column] === "Info" && pane !== undefined && pane.scrollHeight > pane.clientHeight) {
                const end = pane.scrollHeight - pane.clientHeight;
                if (key === "down" && pane.scrollTop < end - 1 || key === "up" && pane.scrollTop > 1) {
                    pane.scrollTop = Math.max(0, Math.min(end, pane.scrollTop + (key === "down" ? 1 : -1) * pane.clientHeight * 0.8));
                    return;
                }
            }
            all[Math.max(0, Math.min(all.length - 1, at + (key === "up" ? -1 : 1)))]?.focus();
        } else if (key === "left" || key === "right") {
            const direction = key === "left" ? -1 : 1;
            for (let index = column + direction; index >= 0 && index < lists.length; index += direction) {
                if (focusList(index)) break;
            }
        } else if (key === "enter") {
            if (document.activeElement?.getAttribute("aria-disabled") === "true") return;
            if ((view.phase === "playing" || view.phase === "paused") && view.tracks.change.state === "changing") {
                return;
            }
            const id = focusedId();
            if (id?.startsWith("chapter:") && (view.phase === "playing" || view.phase === "paused")) {
                const chapter = view.hud?.chapters[Number(id.slice(8))];
                if (chapter !== undefined) {
                    controls.seekToSeconds(chapter.seconds);
                    closeMenu();
                    bar.focus();
                    reveal();
                }
            } else if (id === "chapters-retry") controls.retryChapters();
            else if (id === "auto-next") controls.toggleAutoNext();
            else if (id?.startsWith("speed:")) controls.setVideo("speed", id.slice(6));
            else if (id?.startsWith("aspect:")) controls.setVideo("aspect", id.slice(7));
            else if (id === RETRY) {
                controls.retryTrackInfo();
            } else if (id === OFF) {
                controls.selectSubtitle(undefined);
            } else if (id === SERIES_SUBTITLE) {
                controls.saveSeriesSubtitle();
            } else if (id === "ai-translate") {
                aiLanguages = true;
            } else if (id === "ai-language-back") {
                aiLanguages = false;
            } else if (id === "ai-transcribe") {
                controls.startSubtitleAI("transcribe");
            } else if (id?.startsWith("ai-language:")) {
                controls.startSubtitleAI("translate", id.slice("ai-language:".length));
                aiLanguages = false;
            } else if (id?.startsWith("ai-result:")) {
                controls.selectAIResult(id.slice("ai-result:".length));
            } else if (id === "audio-empty") {
                return;
            } else if (id !== null) {
                if (tabNames[column] === "Audio") {
                    controls.selectAudio(id);
                } else if (tabNames[column] === "Subtitles") {
                    controls.selectSubtitle(id);
                } else if (tabNames[column] === "Video" && id.startsWith("quality:")) {
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
        if (timeline) cancelScrub(true);
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
        if ((view.phase === "playing" || view.phase === "paused") && view.upNext !== undefined) {
            if (key === "play_pause") { controls.togglePause(); return; }
            if (key === "play" || key === "pause") { controls.setPaused(key === "pause"); return; }
            if (key === "rewind" || key === "fast_forward") {
                controls.seekBy(key === "rewind" ? -view.seekIntervals.backward : view.seekIntervals.forward);
                return;
            }
        }
        if (view.phase === "completion" || ((view.phase === "playing" || view.phase === "paused") && view.upNext !== undefined)) {
            const buttons = [next, keep, cancelAutoplay, retry, back, ...Array.from(deck.querySelectorAll<HTMLButtonElement>("button"))].filter(button => !button.hidden);
            const index = buttons.findIndex(button => button === document.activeElement);
            if (key === "stop") controls.back();
            else if (key === "back") controls.keepWatching();
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
        const hiddenPrompt = overlay.classList.contains("player-overlay-hidden") && !menuOpen && !timeline;
        if (!skip.hidden && (document.activeElement === skip || hiddenPrompt) && (key === "enter" || key === "play")) {
            skip.click();
            return;
        }
        if (key === "play_pause" || key === "play" || key === "pause" || key === "stop" || key === "rewind" || key === "fast_forward") {
            if (timeline || seekPreview !== undefined || autoRate !== 0) {
                cancelScrub();
                bar.focus();
            }
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
        if ((key === "left" || key === "right") && scrubberOwnsArrows()) {
            if (!event.repeat) armHold(key);
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
        if (key === "up") {
            if (transport.contains(document.activeElement)) bar.focus();
            else if (!skip.hidden) skip.focus();
            render();
            return;
        }
        if (key === "back" && at >= 0) {
            bar.focus();
            render();
            return;
        }
        if (key === "enter" && at >= 0) {
            transportButtons[at]?.click();
            return;
        }
        if (key === "down") {
            if (timeline || seekPreview !== undefined || autoRate !== 0) return;
            pause.focus();
            render();
            return;
        }
        if (key === "back") {
            if (timeline || seekPreview !== undefined || autoRate !== 0) {
                cancelScrub(true);
                bar.focus();
                render();
                return;
            }
            controls.back();
        } else if (key === "enter") {
            onSelectScrubber();
        }
        render();
    };

    const onKeyUp = (event: KeyboardEvent): void => {
        const key = remoteKey(event);
        if ((key !== "left" && key !== "right") || pendingTap !== key) return;
        cancelHold?.();
        cancelHold = undefined;
        pendingTap = undefined;
        if (autoRate !== 0) {
            adjustAutoRate(key === "left" ? -1 : 1);
            return;
        }
        if (timeline) {
            const interval = view.phase === "playing" || view.phase === "paused" ? view.seekIntervals[key === "left" ? "backward" : "forward"] : 0;
            stepTimeline((key === "left" ? -1 : 1) * interval);
            return;
        }
        stepSkip(key === "left" ? "backward" : "forward");
    };

    const onVisibility = (): void => {
        if (document.hidden) {
            cancelScrub();
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
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("visibilitychange", onVisibility);
    const unsubscribe = controls.subscribe((next) => {
        if ((next.phase !== "playing" && next.phase !== "paused") || next.previewKey !== undefined) pendingSkipTarget = undefined;
        const starting = next.phase === "playing" && view.phase !== "playing" && view.phase !== "paused";
        if (next.phase === "playing" && view.phase === "paused" && timeline) {
            cancelScrub();
            reveal();
        }
        // A local seek hides the preview key while busy; its landing must not
        // discard a newer scrub, but a replacement plan still invalidates it.
        const heldLanding = timeline && next.phase === "paused" && view.phase === "paused" && view.previewKey === undefined && next.previewKey !== undefined && (readyPreviewKey === undefined || next.previewKey === readyPreviewKey);
        if (!heldLanding && (next.phase === "playing" || next.phase === "paused") && (view.phase === "playing" || view.phase === "paused") && next.previewKey !== view.previewKey) {
            cancelScrub();
        }
        view = next;
        if (next.phase !== "playing" && next.phase !== "paused") readyPreviewKey = undefined;
        else if (next.previewKey !== undefined) readyPreviewKey = next.previewKey;
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
            cancelScrub();
            thumbnail.clear();
            unsubscribe();
            cancelHide?.();
            document.removeEventListener("keydown", onKey);
            document.removeEventListener("keyup", onKeyUp);
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
    screen = mountPlayerScreen(root, controller, clock, server.server.http.base.baseUrl);
    controller.play(request);
    return { destroy: finish };
}
