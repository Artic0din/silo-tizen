// Full-screen playback: the AVPlay surface plus a readable overlay for loading, progress and
// errors. Opening is a spinner on black. Remote matches the Apple TV transport: Left/Right
// step the profile skip interval, Select enters timeline scrub, Select again commits or
// resumes, Menu cancels, and a held arrow auto-seeks. Down from the scrubber focuses
// Play/Pause and Up returns. Up from hidden controls reveals that transport on the scrubber;
// Down from hidden opens the panel, which hides the transport until Back shows it again.
// In that panel Up/Down move within a list, Left/Right switch tabs, Enter chooses and Back
// closes it; no key reaches playback while it is open. The screen owns one child of the
// root and removes only that child, so a screen the parent already showed (after a profile
// switch, say) is never erased.

import type { Clock } from "../api/clock.ts";
import { systemClock } from "../api/clock.ts";
import type { ConnectedServer } from "../session/core.ts";
import type { PublicStorage, RandomBytes } from "../session/deviceIdentity.ts";
import { blurEpisodeStill, type EpisodeSpoilerSettings } from "../ui/episodeSpoilers.ts";
import { remoteKey } from "../ui/keys.ts";
import { el } from "../ui/screen.ts";
import { artworkUrl } from "../ui/browseModel.ts";
import type { AVPlay } from "./avplay.ts";
import { type PlaybackDeps, type PlaybackError, type PlaybackExits, PlaybackController, type PlaybackView, type PlayerControls, type PlayRequest, type SubtitleToolAction, type TrackView, UNSUPPORTED_FORMAT } from "./controller.ts";
import { fillSubtitleTools, overlayPicker, paneColumn, pickerFor, settingRow, type SubtitlePane } from "./subtitleMenu.ts";
import type { AppearanceMember } from "./subtitleAppearance.ts";
import { arrowDownCircleIcon, closeIcon, episodesIcon, infoCircleIcon, optionsIcon, pauseIcon, playIcon, skipIcon, skipToEndIcon, sparklesIcon, spinnerIcon, warningTriangleIcon } from "./playerIcons.ts";
import { COPY as BUFFERING_COPY } from "./bufferingQuality.ts";
import { SkipPrompt, type SkipActivity } from "./skipPrompt.ts";
import { mountSeekThumbnail } from "./seekThumbnailView.ts";
import { mountSubtitles } from "./subtitleView.ts";
import { fillHUDPane, fillVideoPane, videoPickerFor } from "./hudPanes.ts";
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

/** Apple's `exclamationmark.triangle.fill` at 40pt in `siloError`. Same glyph as `FAILURE_ICON`. */
function warningMark(): HTMLElement {
    const mark = el("span", "player-error-mark");
    mark.setAttribute("aria-hidden", "true");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 48 48");
    const triangle = document.createElementNS("http://www.w3.org/2000/svg", "path");
    triangle.setAttribute("class", "player-error-triangle");
    triangle.setAttribute("d", "M20 5a4.6 4.6 0 0 1 8 0l19 33a4.6 4.6 0 0 1-4 7H5a4.6 4.6 0 0 1-4-7Z");
    const bang = document.createElementNS("http://www.w3.org/2000/svg", "path");
    bang.setAttribute("class", "player-error-bang");
    bang.setAttribute("d", "M24 16v12m0 7v1");
    svg.append(triangle, bang);
    mark.append(svg);
    return mark;
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

function isAppearanceMember(field: string): field is AppearanceMember {
    switch (field) {
        case "fontSize":
        case "fontFamily":
        case "fontColor":
        case "textOpacity":
        case "textOutline":
        case "textOutlineColor":
        case "backgroundStyle":
        case "backgroundOpacity":
        case "backgroundColor":
        case "position":
            return true;
        default: return false;
    }
}

function pickerAction(field: string, id: string): SubtitleToolAction | undefined {
    if (field === "delay") {
        const milliseconds = Number(id);
        return Number.isInteger(milliseconds) ? { kind: "delay", milliseconds } : undefined;
    }
    if (field === "fontSize" && (id === "small" || id === "medium" || id === "large" || id === "xlarge" || id === "xxlarge")) return { kind: "size", size: id };
    if (field === "position" && (id === "bottom" || id === "lower-third" || id === "top")) return { kind: "position", position: id };
    if (!isAppearanceMember(field)) return undefined;
    const value = field === "textOutline" ? id === "true" : field === "textOpacity" || field === "backgroundOpacity" ? Number(id) : id;
    return { kind: "appearance", member: field, value };
}

function fillSubtitles(list: HTMLElement, tracks: TrackView, languages = false, pane: SubtitlePane = { kind: "tracks" }): void {
    const ai = tracks.ai;
    if (languages && ai !== undefined) {
        list.appendChild(el("h2", "player-menu-heading", "TRACKS"));
        list.appendChild(choice("ai-language-back", "Back to subtitles", false));
        for (const language of ai.languages) list.appendChild(choice(`ai-language:${language}`, `Translate to ${language.toUpperCase()}`, false));
        return;
    }
    const searching = tracks.subtitleTools !== undefined && tracks.subtitleTools.search.phase !== "closed";
    if (pane.kind !== "tracks" || searching) {
        fillSubtitleTools(list, tracks, pane, true);
        return;
    }
    // SubtitlesPane (TVPlayerInfoHUD.swift:1620, columns at 1653-1659): TRACKS beside OPTIONS. Choices that pick a track stay in TRACKS.
    const columns = el("div", "player-menu-columns player-menu-columns-subtitles");
    const trackColumn = paneColumn("TRACKS", "player-menu-column-tracks");
    const optionColumn = paneColumn("OPTIONS", "player-menu-column-options");
    trackColumn.rows.appendChild(choice(OFF, "Off", tracks.selectedSubtitleId === undefined));
    for (const track of tracks.subtitles) {
        const row = choice(track.id, track.label, track.id === tracks.selectedSubtitleId, track.detail);
        if (track.unavailable === true) row.setAttribute("data-unavailable", "true");
        trackColumn.rows.appendChild(row);
    }
    if (tracks.seriesSubtitle !== undefined) {
        const save = choice(SERIES_SUBTITLE, tracks.selectedSubtitleId === undefined ? "Keep subtitles off for this series" : "Use this subtitle choice for this series", false);
        save.setAttribute("aria-disabled", String(tracks.seriesSubtitle.busy));
        trackColumn.rows.appendChild(save);
    }
    if (ai !== undefined) {
        for (const result of ai.results) {
            const row = choice(`ai-result:${result.id}`, result.label, false, result.unavailable === true ? UNSUPPORTED_FORMAT : undefined);
            if (result.unavailable === true) row.setAttribute("data-unavailable", "true");
            trackColumn.rows.appendChild(row);
        }
        if (ai.available.translate && tracks.aiTranslate && ai.languages.length > 0) optionColumn.rows.appendChild(settingRow("ai-translate", "Translate current subtitles", "", { icon: sparklesIcon() }));
        if (ai.available.transcribe) optionColumn.rows.appendChild(settingRow("ai-transcribe", "Transcribe current audio", "", { chevron: false, icon: sparklesIcon() }));
    }
    fillSubtitleTools(optionColumn.rows, tracks, pane, false);
    columns.append(trackColumn.column, optionColumn.column);
    list.appendChild(columns);
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
    const backdrop = el("div", "player-backdrop");
    backdrop.hidden = true;
    const overlay = el("div", "player-overlay");
    overlay.setAttribute("data-focus", "player");
    overlay.tabIndex = -1;
    const skip = el("button", "player-button player-skip");
    skip.type = "button";
    skip.tabIndex = -1;
    skip.setAttribute("data-focus", "skip");
    const skipTrack = el("span", "player-skip-track");
    const skipFill = el("span", "player-skip-fill");
    skipTrack.append(skipFill);
    const skipGlyph = el("span", "player-skip-glyph");
    skipGlyph.innerHTML = skipToEndIcon();
    const skipLabel = el("span", "player-skip-label");
    const skipCaption = el("span", "player-skip-caption");
    skipCaption.setAttribute("aria-hidden", "true");
    skip.append(skipTrack, skipGlyph, skipLabel);
    // Apple's buffering prompt, undo pill and notices: cards stacked at the top-trailing corner.
    const alerts = el("div", "player-alerts");
    const noticeCard = el("p", "player-alert player-alert-notice");
    noticeCard.setAttribute("role", "status");
    noticeCard.hidden = true;
    const noticeMark = el("span", "player-alert-mark");
    noticeMark.setAttribute("aria-hidden", "true");
    const noticeTitle = el("span", "player-alert-title");
    noticeCard.append(noticeMark, noticeTitle);
    const bufferingCard = el("div", "player-alert player-buffering");
    bufferingCard.setAttribute("role", "group");
    bufferingCard.hidden = true;
    const bufferingMark = el("span", "player-alert-mark");
    bufferingMark.setAttribute("aria-hidden", "true");
    const bufferingTitle = el("span", "player-alert-title");
    const bufferingDetail = el("span", "player-alert-detail");
    const bufferingCopy = el("span", "player-alert-copy");
    bufferingCopy.append(bufferingTitle, bufferingDetail);
    const bufferingHead = el("div", "player-alert-head");
    bufferingHead.append(bufferingMark, bufferingCopy);
    const bufferingPrimary = el("button", "player-button player-buffering-action");
    bufferingPrimary.type = "button";
    bufferingPrimary.tabIndex = -1;
    bufferingPrimary.setAttribute("data-focus", "buffering-primary");
    const bufferingKeep = el("button", "player-button player-buffering-action");
    bufferingKeep.type = "button";
    bufferingKeep.tabIndex = -1;
    bufferingKeep.setAttribute("data-focus", "buffering-keep");
    const bufferingActions = el("div", "player-buffering-actions");
    bufferingActions.append(bufferingPrimary, bufferingKeep);
    const bufferingTrack = el("span", "player-buffering-track");
    const bufferingFill = el("span", "player-buffering-fill");
    bufferingTrack.append(bufferingFill);
    bufferingCard.append(bufferingHead, bufferingActions, bufferingTrack);
    alerts.append(noticeCard, bufferingCard);
    bufferingPrimary.addEventListener("click", () => controls.selectBufferingPrimary());
    bufferingKeep.addEventListener("click", () => controls.selectBufferingKeep());
    // A pointer press with the options panel up must not move focus off the panel.
    skip.addEventListener("mousedown", event => { if (menuOpen) event.preventDefault(); });
    skip.addEventListener("click", () => {
        if (skipKind === undefined || skipTarget === undefined) return;
        const target = skipTarget;
        // A tapped seek preview is dropped, so its debounced seek cannot land after the skip.
        if (seekPreview !== undefined) cancelScrub();
        decideSkip();
        pendingSkipTarget = target;
        controls.seekToSeconds(target);
        // The options panel keeps its focus.
        if (!menuOpen) {
            overlay.focus();
            reveal();
        }
        render();
    });
    const thumbnail = mountSeekThumbnail(overlay, controls, clock);
    const title = el("h1", "player-title");
    const footer = el("div", "player-footer");
    const footerSlot = el("div", "player-footer-slot");
    const series = el("p", "player-series");
    const titleRow = el("div", "player-title-row");
    const episode = el("span", "player-episode");
    titleRow.append(title, episode);
    footer.append(series, titleRow);
    const status = el("p", "player-status");
    status.setAttribute("role", "status");
    status.hidden = true;
    const spinner = el("div", "player-spinner");
    spinner.setAttribute("role", "progressbar");
    spinner.setAttribute("aria-label", "Loading");
    const spinnerMark = el("span", "player-spinner-mark");
    spinnerMark.innerHTML = spinnerIcon();
    spinner.appendChild(spinnerMark);
    spinner.hidden = true;
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
    const episodesButton = el("button", "player-button");
    episodesButton.hidden = true;
    const tracksButton = el("button", "player-button player-tracks-button");
    tracksButton.type = "button";
    tracksButton.tabIndex = -1;
    tracksButton.setAttribute("data-focus", "tracks");
    tracksButton.setAttribute("aria-label", "Info and options");
    tracksButton.appendChild(el("span", "player-glyph"));
    tracksButton.firstElementChild?.setAttribute("aria-hidden", "true");
    tracksButton.addEventListener("click", () => openMenu("remembered"));
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
    const transportButtons = [backward, pause, forward, episodesButton, tracksButton, closeButton];
    for (const [index, button] of transportButtons.entries()) {
        button.type = "button";
        button.tabIndex = -1;
        button.setAttribute("data-focus", ["backward", "pause", "forward", "up-next", "tracks", "close"][index] ?? "");
        if (button !== tracksButton && button !== closeButton) button.appendChild(el("span", "player-glyph"));
        button.firstElementChild?.setAttribute("aria-hidden", "true");
    }
    episodesButton.addEventListener("click", () => controls.showUpNext());
    primaryGroup.append(backward, pause, forward);
    secondaryGroup.append(episodesButton, tracksButton, closeButton);
    transport.append(primaryGroup, secondaryGroup);
    backward.addEventListener("click", () => stepSkip("backward"));
    forward.addEventListener("click", () => stepSkip("forward"));
    pause.addEventListener("click", () => { controls.togglePause(); reveal(); render(); });
    overlay.append(footer, footerSlot, bar, time, transport);
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
        tab.setAttribute("data-focus", `tab-${name.toLowerCase()}`);
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
    const mark = warningMark();
    mark.hidden = true;
    const actions = el("div", "player-error-actions");
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
    actions.append(next, keep, cancelAutoplay, retry, back);
    failure.append(eyebrow, failureTitle, mark, failureText, synopsis, actions, deck);
    section.append(surface, backdrop, spinner, overlay, status, skip, skipCaption, alerts, failure, hud);
    const covered = Array.from(root.children).flatMap((child) => child instanceof HTMLElement ? [{ element: child, display: child.style.display }] : []);
    for (const item of covered) item.element.style.display = "none";
    root.appendChild(section);

    let view: PlaybackView = { phase: "closed" };
    /** A playing or paused view means AVPlay can show a frame. Later loads must not cover it. */
    let pictureShown = false;
    let cancelHide: (() => void) | undefined;
    let menuOpen = false;
    let seekPreview: number | undefined;
    let pendingSkipTarget: number | undefined;
    /** Which skip pill is up, and the source second its action seeks to. */
    let skipKind: "intro" | "recap" | "credits" | "undo" | undefined;
    let skipTarget: number | undefined;
    let drawnFill = -1;
    const skipPrompt = new SkipPrompt(clock, () => render());
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
    let column = 0;
    let drawn: string | undefined;
    let aiLanguages = false;
    let subtitlePane: SubtitlePane = { kind: "tracks" };
    /** Video's own picker, so opening it leaves the Subtitles pane as it was. */
    let videoPicker: Extract<SubtitlePane, { kind: "picker" }> | undefined;
    /** The picker in the focused pane, if one is open. */
    const openPicker = (): Extract<SubtitlePane, { kind: "picker" }> | undefined => tabNames[column] === "Video" ? videoPicker : subtitlePane.kind === "picker" ? subtitlePane : undefined;
    let menuRestoreFocus: string | undefined;
    /** Each column scrolls on its own. Redraws and picker round trips keep the unfocused one where the viewer left it. */
    const columnScroll = new Map<string, number>();

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
        const key = JSON.stringify([tracks, aiLanguages, subtitlePane, videoPicker, identity]);
        if (key !== drawn) {
            drawn = key;
            const heldTab = tabs.find(tab => tab === document.activeElement);
            const keep = focusedId();
            const returnFocus = menuRestoreFocus;
            menuRestoreFocus = undefined;
            // A picker floats over the pane that opened it.
            const subtitlePicker = subtitlePane.kind === "picker" ? subtitlePane : undefined;
            for (const [index, list] of lists.entries()) {
                for (const column of list.querySelectorAll<HTMLElement>(".player-menu-column")) columnScroll.set(`${index} ${column.className}`, column.lastElementChild?.scrollTop ?? 0);
                list.textContent = "";
                const name = tabNames[index];
                const hud = view.phase === "playing" || view.phase === "paused" ? view.hud : undefined;
                const hidden = name === "Chapters" && (hud?.chapters.length ?? 0) === 0 || name === "Audio" && tracks.audio.state === "ready" && tracks.audio.choices.length === 0 || name === "Subtitles" && tracks.subtitles.length === 0 && !tracks.aiTranslate && !tracks.ai?.available.transcribe && tracks.subtitleTools?.search.offered !== true;
                list.style.display = hidden ? "none" : "";
                if (hidden) continue;
                if (name === "Info") fillInfo(list, tracks);
                else if (name === "Audio") fillAudio(list, tracks);
                else if (name === "Subtitles") {
                    fillSubtitles(list, tracks, aiLanguages, subtitlePicker === undefined ? subtitlePane : { kind: subtitlePicker.origin.pane === "appearance" ? "appearance" : "tracks" });
                    if (subtitlePicker !== undefined) overlayPicker(list, subtitlePicker);
                } else if (name === "Video") {
                    fillVideoPane(list, hud, tracks);
                    if (videoPicker !== undefined) overlayPicker(list, videoPicker);
                } else fillHUDPane(list, name ?? "", hud, view.phase === "playing" || view.phase === "paused" ? view.positionSeconds : 0, choice, clockText);
                for (const column of list.querySelectorAll<HTMLElement>(".player-menu-column")) {
                    const rows = column.lastElementChild;
                    const top = columnScroll.get(`${index} ${column.className}`);
                    if (!(rows instanceof HTMLElement) || top === undefined) continue;
                    rows.style.scrollBehavior = "auto";
                    rows.scrollTop = top;
                    rows.style.scrollBehavior = "";
                }
                for (const button of buttons(index)) {
                    const id = button.getAttribute("data-focus") ?? "";
                    const aiAction = id === "ai-translate" || id === "ai-transcribe" || id.startsWith("ai-language:");
                    const quota = tracks.ai?.quota;
                    const downloading = tracks.subtitleTools?.search.downloadingKey;
                    const toolBusy = tracks.subtitleTools?.display?.busy === true || downloading !== undefined;
                    const subtitlePick = name === "Subtitles" && id !== SERIES_SUBTITLE && !id.startsWith("ai-");
                    // Picker options act for the row that opened them: a subtitle setting, or Video's quality, speed or aspect.
                    const picker = name === "Video" ? videoPicker : subtitlePicker;
                    const videoOption = id.startsWith("subtitle-picker:") && picker !== undefined && (picker.field === "quality" || picker.field === "speed" || picker.field === "aspect");
                    const qualityAction = id === "video-quality" || videoOption && picker?.field === "quality";
                    const lockedByReport = tracks.reporting === true && !subtitlePick && (name === "Audio" || qualityAction || id === SERIES_SUBTITLE || id.startsWith("ai-"));
                    const blocked = tracks.change.state === "changing" || lockedByReport || (id === "auto-next" && hud?.busy === true) || (id === SERIES_SUBTITLE && tracks.seriesSubtitle?.busy === true) || (aiAction && tracks.ai?.busy === true) || (id === "ai-transcribe" && (quota === undefined || (quota.limited && quota.remaining <= 0))) || (toolBusy && id.startsWith("subtitle-") && !videoOption && id !== `subtitle-result:${downloading ?? ""}`) || (subtitlePick && tracks.subtitles.some((track) => track.id === id && track.unavailable === true)) || (id.startsWith("ai-result:") && tracks.ai?.results.some((result) => `ai-result:${result.id}` === id && result.unavailable === true) === true);
                    button.setAttribute("aria-disabled", String(blocked));
                }
            }
            const quota = tracks.ai?.quota;
            const quotaText = tracks.ai?.available.transcribe !== true ? "" : quota === undefined ? "Transcription quota unavailable." : quota.limited ? `Transcription quota: ${Math.max(0, quota.remaining)} remaining (${quota.period}).${quota.remaining <= 0 ? " Quota exhausted." : ""}` : "Transcription quota: unlimited.";
            menuStatus.textContent = [changeText(tracks), tracks.seriesSubtitle?.message, quotaText, tracks.ai?.message, tracks.subtitleTools?.search.status, tracks.subtitleTools?.search.message, tracks.subtitleTools?.display?.message, view.phase === "playing" || view.phase === "paused" ? view.hud?.message : undefined].filter(Boolean).join(" ");
            const choices = buttons(column);
            const same = (returnFocus === undefined ? undefined : choices.find(button => button.getAttribute("data-focus") === returnFocus))
                ?? (keep === null ? undefined : choices.find(button => button.getAttribute("data-focus") === keep));
            if (heldTab !== undefined && lists[tabs.indexOf(heldTab)]?.style.display !== "none") {
                heldTab.focus();
            } else if (same !== undefined) {
                same.focus();
            } else if (!focusList(column)) {
                if (!focusList(0)) focusList(1);
            }
            showPane(column);
        }
    };

    let focusScrubberOnRender = false;
    const closeMenu = (returnToScrubber = false): void => {
        aiLanguages = false;
        subtitlePane = { kind: "tracks" };
        videoPicker = undefined;
        menuRestoreFocus = undefined;
        const phase = view.phase === "playing" || view.phase === "paused" ? view.tracks.subtitleTools?.search.phase : undefined;
        if (phase !== undefined && phase !== "closed") controls.subtitleTool({ kind: "search-close" });
        menuOpen = false;
        drawn = undefined;
        columnScroll.clear();
        focusScrubberOnRender = returnToScrubber;
    };

    const restartFill = (elapsedMs: number): void => {
        skipFill.style.animation = "none";
        void skipFill.offsetWidth;
        skipFill.style.animation = "";
        skipFill.style.animationDelay = `-${elapsedMs}ms`;
    };

    /**
     * Apple's pills: Skip Intro and Watch Intro, over an "Intro skipped" caption, each on `IntroSkipPrompt`'s five-second timer,
     * and Skip Recap or Skip Credits for the whole marker window (`segmentSkipLayer`).
     */
    /** Drawn and enabled: the only state in which the pill may take focus or a press. */
    const skipUsable = (): boolean => !skip.hidden && !skip.disabled;

    const drawSkip = (): void => {
        const live = view.phase === "playing" || view.phase === "paused" ? view : undefined;
        const marker = live?.skipMarker;
        const undoSeconds = live?.undoSkipSeconds;
        if (live !== undefined) {
            const activity: SkipActivity = live.phase === "paused" ? "paused" : live.buffering ? "stalled" : "playing";
            const content = `${live.title}|${live.seasonNumber ?? ""}|${live.episodeNumber ?? ""}`;
            // The undo is anchored to the skip it undoes, not to the playhead, which has left the intro.
            if (undoSeconds !== undefined) skipPrompt.update(`${content}|undo|${undoSeconds}`, activity, "undo");
            else skipPrompt.update(marker?.kind === "intro" ? `${content}|${marker.startSeconds}` : undefined, activity);
        } else if (view.phase === "loading" && view.nextPart !== true) {
            // A reconnect, restore, re-anchoring seek or replan of the same content: the controller still holds an undo offer
            // across it, so decisions stand (keys carry the content, so a different title never collides) and the timer stalls.
            skipPrompt.stall();
        } else {
            skipPrompt.reset();
        }
        skipKind = undefined;
        skipTarget = undefined;
        if (undoSeconds !== undefined && skipPrompt.kind === "undo") {
            skipKind = "undo";
            skipTarget = undoSeconds;
        } else if (marker?.kind === "recap" || marker?.kind === "credits") {
            skipKind = marker.kind;
            skipTarget = marker.endSeconds;
        } else if (marker?.kind === "intro" && skipPrompt.kind === "skip") {
            skipKind = "intro";
            skipTarget = marker.endSeconds;
        }
        // Drawn over the panel and a scrub, as Apple draws it. Only a timeline scrub takes it out of the focus graph
        // (`.disabled(isTimelineScrubbing)`), so a drifting D-pad cannot land on it and cancel the scrub.
        skip.hidden = skipKind === undefined;
        skip.disabled = timeline;
        if (skipKind === undefined) {
            // Hidden pills lose their CSS animation; a later showing must restart it from where the timer stands.
            drawnFill = -1;
            return;
        }
        const label = skipKind === "undo" ? "Watch Intro" : skipKind === "intro" ? "Skip Intro" : skipKind === "recap" ? "Skip Recap" : "Skip Credits";
        skipLabel.textContent = label;
        skipCaption.textContent = skipKind === "undo" ? "Intro skipped" : "";
        skip.setAttribute("aria-label", skipKind === "undo" ? `Intro skipped. ${label}` : label);
        skipGlyph.hidden = skipKind === "intro" || skipKind === "undo";
        skipTrack.hidden = skipKind === "recap" || skipKind === "credits";
        if (skipKind === "intro" || skipKind === "undo") {
            const fill = skipPrompt.fill;
            if (fill.revision !== drawnFill) {
                // Restart the fill from where the timer stands; the fill and the timer share this one state.
                drawnFill = fill.revision;
                restartFill(fill.elapsedMs);
            }
            skipFill.style.animationPlayState = fill.running ? "running" : "paused";
        }
    };

    /** Which prompt button Select acts on while the controls are hidden and the pill is not focused. */
    let bufferingTarget: "primary" | "secondary" = "primary";
    let drawnBufferingRevision = -1;
    /** The pill that last took the buffering slot, so a new one can ask for focus. */
    let drawnBufferingKind: string | undefined;
    let focusPillOnRender = false;
    let skipShown = false;
    const bufferingButtons = (): HTMLButtonElement[] => [bufferingPrimary, bufferingKeep].filter(button => !bufferingCard.hidden && !button.hidden);

    /** Apple's buffering pill and notices, with the countdown on the controller's own timer. */
    const drawBuffering = (): void => {
        const live = view.phase === "playing" || view.phase === "paused" || view.phase === "loading" ? view : undefined;
        const pill = live?.bufferingPill;
        const notice = live?.bufferingNotice;
        noticeCard.hidden = notice === undefined;
        if (notice !== undefined) {
            noticeTitle.textContent = notice.text;
            noticeMark.innerHTML = notice.lowered ? arrowDownCircleIcon() : infoCircleIcon();
        }
        bufferingCard.hidden = pill === undefined;
        if (pill?.kind !== drawnBufferingKind) {
            drawnBufferingKind = pill?.kind;
            // Apple's controls move focus to the pill's first button when a pill appears with the controls shown.
            focusPillOnRender = pill !== undefined;
        }
        if (pill === undefined) {
            bufferingTarget = "primary";
            return;
        }
        const prompt = pill.kind === "prompt";
        bufferingTitle.textContent = prompt ? BUFFERING_COPY.promptTitle : BUFFERING_COPY.undoCaption;
        bufferingDetail.textContent = prompt ? BUFFERING_COPY.promptDetail : "";
        bufferingDetail.hidden = !prompt;
        bufferingMark.innerHTML = prompt ? warningTriangleIcon() : arrowDownCircleIcon();
        bufferingMark.className = prompt ? "player-alert-mark player-alert-warning" : "player-alert-mark";
        bufferingPrimary.textContent = prompt ? BUFFERING_COPY.lowerAction : BUFFERING_COPY.undoAction;
        bufferingKeep.textContent = BUFFERING_COPY.keepAction;
        bufferingKeep.hidden = !prompt;
        if (!prompt) bufferingTarget = "primary";
        bufferingCard.setAttribute("aria-label", prompt ? BUFFERING_COPY.promptTitle : BUFFERING_COPY.undoCaption);
        if (pill.revision !== drawnBufferingRevision) {
            // Restart the drain from where the timer stands; the countdown and the controller share one state.
            drawnBufferingRevision = pill.revision;
            bufferingFill.style.animation = "none";
            void bufferingFill.offsetWidth;
            bufferingFill.style.animation = "";
            bufferingFill.style.animationDuration = `${pill.totalMs}ms`;
            bufferingFill.style.animationDelay = `-${pill.totalMs - pill.remainingMs}ms`;
        }
        bufferingFill.style.animationPlayState = pill.running ? "running" : "paused";
    };

    /** Select or Back took the pill: an intro or its undo is decided for good. */
    const decideSkip = (): void => {
        if (skipKind === "intro" || skipKind === "undo") skipPrompt.resolve();
    };

    const render = (): void => {
        if (view.phase === "playing" || view.phase === "paused") pictureShown = true;
        backdrop.hidden = pictureShown || view.phase !== "loading";
        renderSubtitles(view);
        const prompt = view.phase === "playing" || view.phase === "paused" ? view.upNext : undefined;
        const active = view.phase === "playing" || view.phase === "paused";
        if (!active && (seekPreview !== undefined || timeline || autoRate !== 0)) cancelScrub();
        drawSkip();
        drawBuffering();
                if (!skipUsable() && document.activeElement === skip) bar.focus();
        if (bufferingCard.hidden && (document.activeElement === bufferingPrimary || document.activeElement === bufferingKeep)) bar.focus();
        if (skipShown !== skipUsable()) {
            skipShown = skipUsable();
            controls.setSkipPillShown(skipShown);
        }
        if (seekPreview === undefined) thumbnail.clear();
        transport.hidden = !active || menuOpen;
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
        failure.className = view.phase === "error" ? "player-error player-error-wall" : "player-error";
        failureTitle.hidden = view.phase === "error";
        mark.hidden = view.phase !== "error";
        back.textContent = view.phase === "error" ? "Go Back" : "Back";
        if (view.phase === "completion" || prompt !== undefined) {
            cancelScrub();
            closeMenu();
            hud.hidden = true;
            skip.hidden = true;
            const candidate = view.phase === "completion" ? view.next : prompt?.next;
            const cards = view.phase === "completion" ? view.deck ?? [] : prompt?.deck ?? [];
            const seconds = view.phase === "completion" ? view.countdown : prompt?.countdown;
            const nextStatus = view.phase === "completion" ? view.title : prompt?.status ?? "Up Next";
            failure.classList.add("player-next-up");
            eyebrow.textContent = nextStatus;
            synopsis.textContent = candidate?.overview ?? "";
            const identity = cards.map(card => `${card.contentId}:${card.hideBackdrop === true ? "1" : "0"}`).join("|");
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
                        if (card.hideBackdrop === true) {
                            img.className = "player-next-still";
                            const frame = el("span", "episode-spoiler-blur");
                            frame.append(img);
                            blurEpisodeStill(frame);
                            button.prepend(frame);
                        } else {
                            button.prepend(img);
                        }
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
                const loading = prompt?.loading === true;
                const failed = prompt?.failed === true;
                next.hidden = loading || failed || candidate === undefined;
                next.textContent = "Play Now";
                retry.hidden = true;
                cancelAutoplay.hidden = true;
                failureTitle.textContent = loading ? "Finding the next episode" : candidate?.title ?? "Almost finished";
                failureText.textContent = loading ? "" : failed ? "Couldn't load the next episode. Pick something from On Deck, or go back." : candidate === undefined ? "No next episode is available." : seconds === undefined ? "" : `Playing in ${seconds}s`;
                if (!failure.contains(document.activeElement)) (next.hidden ? keep : next).focus();
                spinner.hidden = true;
                status.hidden = true;
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
            spinner.hidden = true;
            status.hidden = true;
            return;
        }
        if (view.phase === "error") {
            failure.classList.remove("player-next-up");
            retry.hidden = view.error.kind !== "settings" && !view.retryable;
            failureTitle.textContent = "";
            failureText.textContent = errorText(view.error);
            if (document.activeElement !== back && document.activeElement !== retry) {
                (retry.hidden ? back : retry).focus();
            }
            spinner.hidden = true;
            status.hidden = true;
            return;
        }
        if (view.phase === "closed") {
            spinner.hidden = true;
            status.hidden = true;
            return;
        }
        title.textContent = view.title;
        const activeView = view.phase === "playing" || view.phase === "paused" ? view : undefined;
        series.textContent = activeView?.seriesTitle ?? "";
        series.hidden = !series.textContent;
        episode.textContent = activeView?.seasonNumber !== undefined && activeView.episodeNumber !== undefined ? `S${activeView.seasonNumber} · E${activeView.episodeNumber}` : "";
        episode.hidden = !episode.textContent;
        const namedStatus = view.phase === "loading" && view.detail !== undefined ? loadingText(view.detail) : "";
        status.textContent = namedStatus;
        status.hidden = namedStatus === "";
        const conceal = view.phase === "loading" || menuOpen;
        footer.hidden = conceal;
        footerSlot.hidden = conceal;
        bar.hidden = conceal;
        time.hidden = conceal;
        spinner.hidden = !(view.phase === "loading" || (active && view.buffering));
        if (view.phase === "loading") {
            elapsed.textContent = "";
            remaining.hidden = true;
            remaining.textContent = "";
            episodesButton.hidden = true;
            tracksButton.hidden = true;
            fill.style.width = "0";
            puck.style.left = "0";
        } else {
            const backwardSeconds = view.seekIntervals.backward;
            const forwardSeconds = view.seekIntervals.forward;
            setIcon(backward, backwardSeconds === 1 ? "Back 1 second" : `Back ${backwardSeconds} seconds`, skipIcon("backward", backwardSeconds));
            setIcon(forward, forwardSeconds === 1 ? "Forward 1 second" : `Forward ${forwardSeconds} seconds`, skipIcon("forward", forwardSeconds));
            episodesButton.hidden = view.episodes !== true;
            tracksButton.hidden = false;
            if (!episodesButton.hidden) setIcon(episodesButton, "Show Up Next", episodesIcon());
            setIcon(tracksButton, "Info and options", optionsIcon());
            setIcon(closeButton, "Close player", closeIcon());
            setIcon(pause, view.phase === "paused" ? "Play" : "Pause", view.phase === "paused" ? playIcon() : pauseIcon());
            const duration = view.durationSeconds;
            const position = seekPreview ?? pendingSkipTarget ?? view.positionSeconds;
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
        const hidden = view.phase === "playing" && !view.buffering && cancelHide === undefined && !menuOpen && seekPreview === undefined;
        overlay.className = ["player-overlay", hidden ? "player-overlay-hidden" : "", conceal ? "player-overlay-clear" : ""].filter(Boolean).join(" ");
        skip.className = ["player-button", "player-skip", skipKind === "recap" || skipKind === "credits" ? "player-skip-segment" : "player-skip-intro", hidden ? "player-skip-lit" : "", menuOpen ? "player-skip-hud" : ""].filter(Boolean).join(" ");
        // The controls hiding takes the pill out of the focus graph, as on tvOS: Select then acts on the button that held focus.
        if (hidden && (document.activeElement === bufferingPrimary || document.activeElement === bufferingKeep)) {
            bufferingTarget = document.activeElement === bufferingKeep ? "secondary" : "primary";
            bar.focus();
        }
        // With the controls hidden, or a load on screen, Select acts on the pill, so the button it acts on is drawn lit.
        const pillSelects = hidden || view.phase === "loading";
        bufferingPrimary.className = ["player-button", "player-buffering-action", pillSelects && bufferingTarget === "primary" ? "player-buffering-lit" : ""].filter(Boolean).join(" ");
        bufferingKeep.className = ["player-button", "player-buffering-action", pillSelects && bufferingTarget === "secondary" ? "player-buffering-lit" : ""].filter(Boolean).join(" ");
        if (hidden && transport.contains(document.activeElement)) bar.focus();
        if (menuOpen && view.phase !== "loading") {
            drawMenu(view.tracks);
        } else if (view.phase === "loading") {
            if (document.activeElement !== overlay) overlay.focus();
        } else if (active) {
            const focusedNode = document.activeElement;
            const held = (menuOpen && menu.contains(focusedNode)) || transport.contains(focusedNode) || focusedNode === bar || (focusedNode === skip && skipUsable()) || (focusedNode instanceof HTMLElement && bufferingButtons().includes(focusedNode as HTMLButtonElement));
            if (!held) {
                if (skipUsable()) skip.focus();
                else bar.focus();
            }
        }
        if (focusPillOnRender && active && !menuOpen && !hidden && !bufferingCard.hidden && seekPreview === undefined && !timeline && autoRate === 0 && (document.activeElement === bar || document.activeElement === overlay || document.activeElement === document.body)) {
            bufferingPrimary.focus();
        }
        focusPillOnRender = false;
        if (focusScrubberOnRender && active && !menuOpen) {
            focusScrubberOnRender = false;
            bar.focus();
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

    const showThumbnail = (seconds: number): void => {
        const duration = view.phase === "playing" || view.phase === "paused" ? view.durationSeconds ?? 0 : 0;
        thumbnail.show(seconds, duration);
    };

    const stepSkip = (direction: "backward" | "forward"): void => {
        if (view.phase !== "playing" && view.phase !== "paused") return;
        const delta = view.seekIntervals[direction] * (direction === "backward" ? -1 : 1);
        seekPreview = clampSeek((seekPreview ?? pendingSkipTarget ?? view.positionSeconds) + delta);
        reveal();
        bar.focus();
        showThumbnail(seekPreview);
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
        showThumbnail(target);
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
        showThumbnail(seekPreview);
        render();
    };

    const commitTimeline = (): void => {
        const moved = timelineMoved;
        const resume = resumeAfterTimeline;
        const target = seekPreview;
        cancelScrub();
        if (moved && target !== undefined) {
            pendingSkipTarget = target;
            controls.seekToSeconds(target);
        }
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
        if (target !== undefined) {
            pendingSkipTarget = target;
            controls.seekToSeconds(target);
        }
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

    const restoreSearchLanguage = (): void => {
        const code = view.phase === "playing" || view.phase === "paused" ? view.tracks.subtitleTools?.search.language : undefined;
        if (code !== undefined && code !== "") menuRestoreFocus = `subtitle-language:${code}`;
    };

    /** Closes the focused pane's picker onto the row that opened it. */
    const restoreSubtitlePicker = (): void => {
        const picker = openPicker();
        if (picker === undefined) return;
        if (picker === videoPicker) videoPicker = undefined;
        else subtitlePane = { kind: picker.origin.pane === "appearance" ? "appearance" : "tracks" };
        menuRestoreFocus = picker.origin.focusId;
    };

    /**
     * Left and Right cross between a pane's columns (each a `focusSection` in SubtitlesPane and VideoPane) and land on the
     * row nearest the focused one's height, as the tvOS focus engine does. Past the last column they switch panes.
     */
    const crossColumn = (direction: -1 | 1): boolean => {
        const from = document.activeElement;
        const own = from?.closest<HTMLElement>(".player-menu-column");
        if (from === null || from === undefined || own === null || own === undefined || own.parentElement === null) return false;
        const columns = Array.from(own.parentElement.children).filter((node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains("player-menu-column"));
        const middle = (node: Element): number => { const box = node.getBoundingClientRect(); return box.top + box.height / 2; };
        const height = middle(from);
        for (let index = columns.indexOf(own) + direction; index >= 0 && index < columns.length; index += direction) {
            const rows = Array.from(columns[index]!.querySelectorAll<HTMLElement>("[data-focus]"));
            const nearest = rows.reduce<HTMLElement | undefined>((best, row) => best === undefined || Math.abs(middle(row) - height) < Math.abs(middle(best) - height) ? row : best, undefined);
            if (nearest !== undefined) { nearest.focus(); return true; }
        }
        return false;
    };

    const menuKey = (key: string): void => {
        if (key === "back") {
            // An open picker closes first (its `onExitCommand`, TVPlayerInfoHUD.swift:1092).
            if (openPicker() !== undefined) { restoreSubtitlePicker(); return; }
            if (aiLanguages) { aiLanguages = false; return; }
            if (subtitlePane.kind !== "tracks") {
                subtitlePane = { kind: "tracks" };
                menuRestoreFocus = "subtitle-appearance";
                return;
            }
            const phase = view.phase === "playing" || view.phase === "paused" ? view.tracks.subtitleTools?.search.phase : undefined;
            if (phase !== undefined && phase !== "closed") {
                if (phase !== "languages") restoreSearchLanguage();
                controls.subtitleTool({ kind: "search-back" });
                return;
            }
            closeMenu(true);
            reveal();
            return;
        }
        // Up and Down stay inside the focused column of a two-column pane.
        const columnScope = document.activeElement?.closest<HTMLElement>(".player-menu-column");
        const all = columnScope ? Array.from(columnScope.querySelectorAll<HTMLElement>("[data-focus]")) : buttons(column);
        const at = all.findIndex((button) => button === document.activeElement);
        const atTab = tabs.findIndex(tab => tab === document.activeElement);
        const infoPane = lists[column];
        const infoCanScrollUp = key === "up" && focusedId() === "info" && tabNames[column] === "Info" && infoPane !== undefined && infoPane.scrollTop > 1;
        if (key === "up" && at <= 0 && !infoCanScrollUp) {
            // An open picker takes the rail out of the focus graph (TVPlayerInfoHUD.swift:139, :1709-1712).
            if (openPicker() === undefined) tabs[column]?.focus();
            return;
        }
        if (atTab >= 0) {
            if (key === "down" || key === "enter") {
                // Down from a pill enters the pane at its top row: the row under the pill, or Off in Subtitles
                // (`.defaultFocus($entryTrackFocused)`, TVPlayerInfoHUD.swift:1664, :1792), not the current choice.
                const top = buttons(column)[0];
                if (top !== undefined) { showPane(column); top.focus(); }
            }
            else if (key === "left" || key === "right") {
                const direction = key === "left" ? -1 : 1;
                for (let index = column + direction; index >= 0 && index < tabs.length; index += direction) {
                    if (tabs[index]?.hidden === false) { showPane(index); tabs[index]?.focus(); break; }
                }
            }
            return;
        }
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
            // Inside a pane Left/Right only cross its columns; panes change on the tab rail (TVPlayerInfoHUD.swift:9-16).
            crossColumn(key === "left" ? -1 : 1);
        } else if (key === "enter") {
            if (document.activeElement?.getAttribute("aria-disabled") === "true") return;
            if ((view.phase === "playing" || view.phase === "paused") && view.tracks.change.state === "changing") {
                return;
            }
            const id = focusedId();
            const picker = openPicker();
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
            } else if (id === "subtitle-search") {
                controls.subtitleTool({ kind: "search-open" });
            } else if (id?.startsWith("subtitle-language:")) {
                controls.subtitleTool({ kind: "search-language", code: id.slice("subtitle-language:".length) });
            } else if (id === "subtitle-search-back" || id === "subtitle-search-cancel") {
                const phase = view.phase === "playing" || view.phase === "paused" ? view.tracks.subtitleTools?.search.phase : undefined;
                if (phase !== undefined && phase !== "languages" && phase !== "closed") restoreSearchLanguage();
                controls.subtitleTool({ kind: "search-back" });
            } else if (id === "subtitle-search-retry") {
                controls.subtitleTool({ kind: "search-retry" });
            } else if (id?.startsWith("subtitle-result:")) {
                controls.subtitleTool({ kind: "search-download", key: id.slice("subtitle-result:".length) });
            } else if (id === "video-quality" || id === "video-speed" || id === "video-aspect") {
                const next = view.phase === "playing" || view.phase === "paused" ? videoPickerFor(view.hud, view.tracks, id.slice("video-".length)) : undefined;
                if (next !== undefined) videoPicker = { ...next, origin: { pane: "video", focusId: id } };
            } else if (id === "subtitle-delay" || id === "subtitle-video-delay" || id === "subtitle-size" || id === "subtitle-position") {
                const field = id === "subtitle-size" ? "fontSize" : id === "subtitle-position" ? "position" : "delay";
                const next = view.phase === "playing" || view.phase === "paused" ? pickerFor(view.tracks, field) : undefined;
                if (next !== undefined && id === "subtitle-video-delay") videoPicker = { ...next, origin: { pane: "video", focusId: id } };
                else if (next !== undefined) subtitlePane = { ...next, origin: { pane: "tracks", focusId: id } };
            } else if (id === "subtitle-appearance") {
                subtitlePane = { kind: "appearance" };
            } else if (id === "subtitle-appearance-back") {
                subtitlePane = { kind: "tracks" };
                menuRestoreFocus = "subtitle-appearance";
            } else if (id?.startsWith("subtitle-appearance:")) {
                const field = id.slice("subtitle-appearance:".length);
                const next = view.phase === "playing" || view.phase === "paused" ? pickerFor(view.tracks, field) : undefined;
                if (next !== undefined) subtitlePane = { ...next, origin: { pane: "appearance", focusId: id } };
            } else if (id?.startsWith("subtitle-picker:") && picker !== undefined) {
                const value = id.slice("subtitle-picker:".length);
                const field = picker.field;
                if (field === "speed" || field === "aspect") controls.setVideo(field, value);
                else if (field === "quality") controls.selectQuality(value);
                else {
                    const action = pickerAction(field, value);
                    if (action !== undefined) controls.subtitleTool(action);
                }
                restoreSubtitlePicker();
            } else if (id === "subtitle-device") {
                const enabled = view.phase === "playing" || view.phase === "paused" ? view.tracks.subtitleTools?.display?.deviceOverride === true : false;
                controls.subtitleTool({ kind: "device", enabled: !enabled });
            } else if (id === "audio-empty") {
                return;
            } else if (id !== null) {
                if (tabNames[column] === "Audio") {
                    controls.selectAudio(id);
                } else if (tabNames[column] === "Subtitles") {
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

    /** Options reopens the last tab, which starts on Info. Hidden Down opens Video, as `openSettingsHUD`. */
    const openMenu = (entry: "remembered" | "video"): void => {
        if (view.phase !== "playing" && view.phase !== "paused") {
            return;
        }
        if (timeline) cancelScrub(true);
        menuOpen = true;
        render();
        if (entry === "video") {
            const video = tabs.findIndex((tab) => tab.textContent === "Video");
            if (video >= 0 && tabs[video]?.hidden !== true) column = video;
        }
        if (!focusList(column)) {
            if (!focusList(0)) focusList(1);
        }
        tabs[column]?.focus();
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
        const pillButtons = bufferingButtons();
        if (pillButtons.length > 0 && !menuOpen && !timeline && seekPreview === undefined && autoRate === 0) {
            const at = pillButtons.findIndex(button => button === document.activeElement);
            const prompt = pillButtons.length > 1;
            if (key === "back" && controls.dismissBufferingPill()) {
                render();
                return;
            }
            if (at >= 0) {
                if (key === "enter") pillButtons[at]?.click();
                else if (key === "left" || key === "right") pillButtons[Math.max(0, Math.min(pillButtons.length - 1, at + (key === "left" ? -1 : 1)))]?.focus();
                else if (key === "down") pause.focus();
                if (key === "enter" || key === "left" || key === "right" || key === "down") {
                    render();
                    return;
                }
            } else if ((hiddenPrompt || view.phase === "loading") && key === "enter") {
                (bufferingTarget === "secondary" && prompt ? bufferingKeep : bufferingPrimary).click();
                return;
            } else if ((hiddenPrompt || view.phase === "loading") && prompt && (key === "left" || key === "right")) {
                bufferingTarget = key === "left" ? "primary" : "secondary";
                render();
                return;
            }
        }
        if (skipUsable() && (document.activeElement === skip || hiddenPrompt) && (key === "enter" || key === "play")) {
            skip.click();
            return;
        }
        if (key === "play_pause" || key === "play" || key === "pause" || key === "stop" || key === "rewind" || key === "fast_forward") {
            pendingSkipTarget = undefined;
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
        if (key === "back" && (skipKind === "intro" || skipKind === "undo") && skipUsable() && !timeline && seekPreview === undefined && autoRate === 0) {
            // Apple's most transient pill: Back takes it down and the press ends there, so it neither hides the controls nor exits.
            decideSkip();
            render();
            return;
        }
        if (hiddenPrompt) {
            if (key === "up") {
                reveal();
                if (skipUsable()) skip.focus();
                else bar.focus();
                render();
                return;
            }
            if (key === "down") { openMenu("video"); return; }
            if (key === "left" || key === "right") bar.focus();
        }
        reveal();
        if ((key === "left" || key === "right") && scrubberOwnsArrows()) {
            if (!event.repeat) armHold(key);
            return;
        }
        const visibleTransport = transportButtons.filter(button => !button.hidden);
        const at = visibleTransport.findIndex(button => button === document.activeElement);
        if (document.activeElement === skip && key === "down") {
            pause.focus();
            render();
            return;
        }
        if (at >= 0 && (key === "left" || key === "right")) {
            visibleTransport[Math.max(0, Math.min(visibleTransport.length - 1, at + (key === "left" ? -1 : 1)))]?.focus();
            render();
            return;
        }
        if (key === "up") {
            if (transport.contains(document.activeElement)) bar.focus();
            else if (skipUsable()) skip.focus();
            else if (pillButtons.length > 0) pillButtons[0]?.focus();
            render();
            return;
        }
        if (key === "back" && at >= 0) {
            bar.focus();
            render();
            return;
        }
        if (key === "enter" && at >= 0) {
            visibleTransport[at]?.click();
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
        // A local seek hides the preview key while busy. A same-plan landing must
        // keep a newer timeline or a skip that is still waiting out its debounce.
        // A replacement plan still invalidates that preview.
        const active = view.phase === "playing" || view.phase === "paused" ? view : undefined;
        const samePlanLanding = active !== undefined && next.phase === active.phase && active.previewKey === undefined && next.previewKey !== undefined && (readyPreviewKey === undefined || next.previewKey === readyPreviewKey);
        const heldLanding = samePlanLanding && (timeline || seekPreview !== undefined);
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
            skipPrompt.reset();
            unsubscribe();
            cancelHide?.();
            document.removeEventListener("keydown", onKey);
            document.removeEventListener("keyup", onKeyUp);
            document.removeEventListener("visibilitychange", onVisibility);
            if (section.parentNode === root) {
                root.removeChild(section);
            }
            for (const item of covered) item.element.style.display = item.display;
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
    spoilers?: () => EpisodeSpoilerSettings,
    storage?: PublicStorage,
    resolutionCap?: PlaybackDeps["resolutionCap"],
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
        ...(spoilers === undefined ? {} : { spoilers }),
        ...(storage === undefined ? {} : { publicStorage: storage }),
        ...(resolutionCap === undefined ? {} : { resolutionCap }),
    });
    screen = mountPlayerScreen(root, controller, clock, server.server.http.base.baseUrl);
    controller.play(request);
    return { destroy: finish };
}
