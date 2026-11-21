// The one owner of native playback: capability read, server planning (start, replan), the AVPlay
// transport, progress, stop, timers and cancellation. The server chooses every route; this client
// reports failures and positions and replays opaque plan identities unchanged.
//
// Identities (protocol v3 §6, §9): one playback_attempt_id per play() for its start and every
// replan; one plan_attempt_id per adopted plan; a fresh replan_request_id per replan, kept on its
// resends; a fresh stop_id per stop, kept on its resends. Every AVPlay callback and every answer
// is checked against the attempt and transport it was made for, because the platform cannot
// cancel them: a late one is dropped, never played or reported.
//
// Authority: every request carries the authority signal from when the attempt began, so a
// sign-out or profile switch aborts it and nothing more is sent for the old profile.
//
// Tracks (#11): a choice is a server track_change replan naming the server's own identity: a
// subtitle inventory track_id, or `file:{effective file}:audio:{n}` for the version's nth
// audio_tracks entry. The server request never carries an AVPlay index. When the open stream
// already lists the embedded text row, AVPlay setSelectTrack switches it without a new open.
// A direct-play sidecar or Off on the same stream path stays on that open picture too: this
// overlay draws the VTT, so the plan does not need a new AVPlay open. A renewed `st` on that
// path is the same media. A different path, an audio change, a native embedded selection, or
// a burn-in still reopens. A refused change leaves the current plan playing.
// On an original file, AVPlay then plays the plan's audio ordinal (client_selected_audio_track_v1, #507).

import { shownLocale } from "../i18n/format.ts";
import { type MessageKey, translate } from "../i18n/translate.ts";
import { type Clock, sleep } from "../api/clock.ts";
import { ApiError } from "../api/errors.ts";
import { abortedError, type RequestSpec } from "../api/http.ts";
import { operations } from "../api/operations.ts";
import { isPermittedUrl } from "../api/serverUrl.ts";
import { CONNECTION_SPEED_FEATURE } from "../contracts/v2/connectionSpeed.ts";
import type { FileVersionTracks, PlaybackCapabilities, PlaybackDecision, PlaybackDefaults, PlaybackMutation, PlaybackPlan, ReplanOperation, ReplanPlaybackBody, SelectedTracks, StartPlaybackBody, SubtitleTrack, TrackIdentity } from "../contracts/v2/playback.ts";
import type { PublicStorage, RandomBytes } from "../session/deviceIdentity.ts";
import type { NativeSession } from "../session/session.ts";
import type { AVPlay, AVPlayListener, AVPlayTrackInfo } from "./avplay.ts";
import { bandwidthReadings, FALLBACK_MAX_AGE_SECONDS, readingsKey } from "./bandwidthReadings.ts";
import { BUFFERING_QUALITY_FEATURE, clientCapabilities, clientFeatures, HLS_SUBTITLE_RENDITIONS_ALL_FEATURE, playbackContext, probeHdrPanel, type HdrPanel } from "./capabilities.ts";
import { BufferingBridge, type BufferingNoticeView, type BufferingPillView } from "./bufferingBridge.ts";
import { AUTO_QUALITY, DEFAULT_BUFFERING_QUALITY_MODE, type BufferingQualityMode, type ReplanRequest } from "./bufferingQuality.ts";
import type { BufferingSnapshot } from "./bufferingSignals.ts";
import { SeekThumbnails, type ThumbnailSheetLoader } from "./seekThumbnails.ts";
import { AUTO_NEXT_KEY, HDR_KEY, QUALITY_KEY, BITRATE_KEY, SEEK_BACK_KEY, SEEK_FORWARD_KEY, SEEK_KEYS, profileSettings } from "../contracts/v2/settings.ts";
import type { SeekThumbnail } from "../contracts/v2/trickplay.ts";
import { markerAt, type SkipMarker } from "../contracts/v2/markers.ts";
import { currentNetwork } from "../ui/connectionSpeed.ts";
import { episodeDetailPresentation, type EpisodeSpoilerSettings, present } from "../ui/episodeSpoilers.ts";
import { nextEpisode, onDeckPlays, readOnDeck } from "./nextEpisode.ts";
import type { ResolutionCap } from "../ui/resolutionCap.ts";
import { NEXT_UP_KEY } from "../contracts/v2/settings.ts";
import { BUFFERING_MODE_KEY, INTRO_SKIP_KEY, CREDITS_SKIP_KEY } from "../contracts/v2/settingsRows.ts";
import { nextShuffle, nextShufflePart } from "./nextShuffle.ts";
import { SubtitleAI, type SubtitleAIView } from "./subtitleAI.ts";
import { aiMenu, aiRoute, hasActionableSource, quotaText, relyOnTranscription, type AIInputs, type AIMenu } from "./subtitleAIRoute.ts";
import { SubtitleSync, type SyncTimingView } from "./subtitleSync.ts";
import { type AppearanceMember } from "./subtitleAppearance.ts";
import { SubtitleDisplay, type SubtitleDisplayView } from "./subtitleDisplay.ts";
import { STORED, SubtitleSearch, type SubtitleSearchView } from "./subtitleSearch.ts";
import { downloadSubtitle } from "./subtitleRefetch.ts";
import { DEFAULT_APPEARANCE, decodeCues, type SubtitleAppearance, type SubtitleCue } from "../contracts/v2/subtitles.ts";
import type { CatalogSubtitleTrack, SubtitleIntent, SubtitlePreferences } from "../contracts/v2/preplaySubtitles.ts";
import { defaultSubtitle, initialSubtitle, matchesSubtitle, playableIntent, startSubtitleTrackId } from "./preplaySubtitles.ts";
import { PlaybackRecovery, recoveryVerdict, type RecoveryStep, type RecoveryVerdict, unanswered } from "./playbackRecovery.ts";
import { audioRow, canonicalLanguageKey, orderSubtitles, qualityMenuLabel, subtitleRow } from "./trackLabels.ts";
import { HUDState } from "./hudState.ts";
import { textIsRightToLeft } from "../i18n/direction.ts";
import { UP_NEXT_PREVIEW, upNextPreviewLeft } from "./upNextPreview.ts";
import { type LiveStats, planStats, videoOptions, type PlayerHUD } from "./playerHUD.ts";

/** What browse hands over: one file of one catalog item. */
export interface PlayRequest {
    readonly overview?: string | undefined;
    readonly backdropUrl?: string | undefined;
    /** False for series key art. Absent or true is an episode still. */
    readonly backdropIsEpisodeStill?: boolean | undefined;
    /** On Deck blurs this still. Series art stays sharp. */
    readonly hideBackdrop?: true;
    readonly seriesTitle?: string | undefined;
    readonly seasonNumber?: number | undefined;
    readonly episodeNumber?: number | undefined;
    readonly shuffleId?: string;
    readonly episode?: true;
    /** Watch progress for the Up Next synopsis. Absent means the episode has not started. */
    readonly watch?: { readonly played: boolean; readonly isInProgress?: boolean; readonly positionSeconds?: number };
    readonly audioTrackId?: string;
    readonly subtitle?: SubtitleIntent;
    /** Catalog rows used to name a subtitle before start. Absent when the version published none. */
    readonly subtitleTracks?: readonly CatalogSubtitleTrack[];
    /** Effective subtitle preferences already on the version, so Auto can be named before start. */
    readonly subtitlePreferences?: SubtitlePreferences;
    readonly allowAlternateVersions?: false;
    readonly contentId: string;
    readonly fileId: string;
    readonly title: string;
    /** Source seconds; undefined lets the server resume from the profile's saved position. */
    readonly startSeconds: number | undefined;
}

export type EndReason = "completed" | "ended_by_server" | "authority_changed";

export type PlaybackError =
    | { readonly kind: "settings" }
    /** The server has no native playback for this client (not configured, not allowed, no protocol 3). */
    | { readonly kind: "unavailable" }
    /** The server decided this file cannot play here. */
    | { readonly kind: "terminal"; readonly reason: string; readonly message: string; readonly retryable: boolean }
    /** Every route the server offered failed on this TV. */
    | { readonly kind: "playback_failed" }
    /** Media or API unreachable. Reconnecting belongs to recovery (#13). */
    | { readonly kind: "network" }
    /** The server no longer knows the session (expired or restarted). Recovery belongs to #13. */
    | { readonly kind: "session_expired" }
    | { readonly kind: "installation_changed" }
    | { readonly kind: "revoked" }
    | { readonly kind: "backgrounded" }
    | { readonly kind: "server" };

export interface PlaybackExits {
    onBack(): void;
    /** `completed` comes only from AVPlay's stream-completed callback. */
    onEnd(reason: EndReason): void;
    /** After the viewer dismissed the error the player showed. */
    onError(error: PlaybackError): void;
}

export interface TrackChoice {
    readonly id: string;
    /** Language, else a meaningful title. The format line is `detail`. */
    readonly label: string;
    /** Codec, layout and flags. Absent when the name already says everything. */
    readonly detail?: string;
    /** Shown but not choosable: the server has no route to show this track. */
    readonly unavailable?: boolean;
}

/** Apple's `PlayerTrack.unsupportedFormatLabel`. */
export const unsupportedFormat = (): string => translate("detail.trackUnsupported");

/** An inventory row the plan lists, minus the ones its `unplayable` flag says the server cannot show. */
const CAPTION_LOADING = "Loading subtitles…";
/** Kept in `captionNotice` as an id; `captionNoticeText` gives its words. Turning the track off and on fetches it again. */
const CAPTION_FAILED = "caption-failed";

/** A caption notice as the menu shows it: the failure is Apple's `player.subtitles.dataLoadFailed`. */
function captionNoticeText(notice: string): string {
    return notice === CAPTION_FAILED ? translate("player.subtitles.dataLoadFailed") : notice;
}

function selectableSubtitle(plan: PlaybackPlan, trackId: string): boolean {
    return plan.subtitle.inventory.some((entry) => entry.trackId === trackId && entry.unplayable !== true);
}

/** What the AI Subtitles… menu chooses from: the text subtitles the server can translate and every audio track, by the server's index. */
function aiInputs(attempt: Attempt, plan: PlaybackPlan): AIInputs | undefined {
    const view = attempt.ai?.view;
    if (view === undefined) return undefined;
    const shown = shownSubtitle(attempt, plan);
    const tracks = attempt.tracks;
    const version = tracks?.state === "ready" ? tracks.versions.find(candidate => candidate.fileId === plan.effectiveMediaFileId) : undefined;
    const selectedAudio = plan.selectedTracks.audio?.index;
    return {
        translateEnabled: view.available.translate,
        transcribeEnabled: view.available.transcribe,
        // The inventory carries no default flag.
        sources: plan.subtitle.inventory.filter(track => textSubtitle(track.codec) && track.combinedIndex >= 0).map(track => ({ index: track.combinedIndex, language: track.language, selected: track.trackId === shown, isDefault: false })),
        // Once the versions read has failed, or answered without this file, the plan's selected audio is still known, only its language is not:
        // a missing label must not disable transcription. While it loads, nothing is guessed, so a spoken language is never mistaken for another.
        audio: version === undefined ? (selectedAudio === undefined || tracks === undefined || tracks.state === "loading" ? [] : [{ index: selectedAudio, language: "", selected: true, isDefault: false }]) : version.audio.map((track, ordinal) => ({ index: ordinal, language: track.language, selected: ordinal === selectedAudio, isDefault: track.isDefault })),
        quotaKnown: view.quota !== undefined,
        quotaExhausted: view.quota?.limited === true && view.quota.remaining <= 0,
    };
}

let cachedAIMenu: { readonly key: string; readonly menu: AIMenu } | undefined;

function aiMenuView(attempt: Attempt, plan: PlaybackPlan): TrackView["aiMenu"] {
    const inputs = aiInputs(attempt, plan);
    const view = attempt.ai?.view;
    if (inputs === undefined || view === undefined) return undefined;
    // A running or failed job's panel (Cancel, Dismiss, Discard) stays reachable while the audio list reloads; with no audio known,
    // the menu offers no language, so nothing new can start.
    const jobPanel = view.phase === "busy" || view.phase === "failed";
    if (!hasActionableSource(inputs)) return jobPanel ? { menu: { detected: undefined, suggested: [], other: [] }, quota: undefined, quotaExhausted: inputs.quotaExhausted } : undefined;
    // The view is rebuilt on every playback tick and every language label is an Intl lookup: build the menu once per input.
    const key = JSON.stringify([inputs, view.languages, view.preferred]);
    if (cachedAIMenu?.key !== key) cachedAIMenu = { key, menu: aiMenu(inputs, view.languages, view.preferred) };
    const menu = cachedAIMenu.menu;
    // The Spoken language row needs no catalog, so an empty or failed one hides the menu only when no row is left.
    if (menu.detected === undefined && menu.suggested.length === 0 && menu.other.length === 0 && !jobPanel) return undefined;
    // An unreadable balance blocks transcription, so the menu says that instead of showing nothing.
    const relies = relyOnTranscription(inputs, view.languages);
    // "used of limit" needs both numbers; without the used count, quotaText falls back to what remains.
    const quota = view.quota?.used === undefined && view.quota !== undefined ? { ...view.quota, limit: undefined } : view.quota;
    return { menu, quota: relies ? quotaText(quota) ?? (inputs.quotaKnown ? undefined : "Transcription quota unavailable.") : undefined, quotaExhausted: inputs.quotaExhausted };
}

/** Marks an AI result whose stored track the plan cannot show, so its row says why instead of doing nothing. */
function aiView(attempt: Attempt, plan: PlaybackPlan): SubtitleAIView | undefined {
    const view = attempt.ai?.view;
    if (view === undefined || !plan.subtitle.inventory.some(entry => entry.unplayable === true)) return view;
    return { ...view, results: view.results.map(result => plan.subtitle.inventory.some(entry => entry.syncKey === `stored-${result.id}` && entry.unplayable === true) ? { ...result, unavailable: true } : result) };
}

const orderedInventories = new WeakMap<readonly SubtitleTrack[], { readonly language: string | undefined; readonly locale: string; readonly ordered: readonly SubtitleTrack[] }>();

/** The plan's subtitle rows in display order, sorted once per inventory, preferred language and shown locale (names collate in it): the view is rebuilt on every playback tick. The inventory carries no default flag. */
export function orderedInventory(inventory: readonly SubtitleTrack[], language: string | undefined): readonly SubtitleTrack[] {
    const cached = orderedInventories.get(inventory);
    const locale = shownLocale();
    if (cached !== undefined && cached.language === language && cached.locale === locale) return cached.ordered;
    const ordered = orderSubtitles(inventory, language, entry => ({ language: entry.language, codec: entry.codec, forced: entry.forced, hearingImpaired: entry.hearingImpaired, isDefault: false }));
    orderedInventories.set(inventory, { language, locale, ordered });
    return ordered;
}

/**
 * The plan row of the file's default (else forced) subtitle that Apple's start freezes; the plan inventory carries no default flag.
 * The catalog rows describe the requested file only, so another version keeps its plan's selection. Rows the plan flags unplayable
 * are skipped, as Apple skips rows the server cannot deliver.
 */
function startingDefault(request: PlayRequest, plan: PlaybackPlan): string | undefined {
    if (plan.effectiveMediaFileId !== request.fileId) return undefined;
    const unplayable = plan.subtitle.inventory.filter(entry => entry.unplayable === true);
    const catalog = request.subtitleTracks === undefined ? undefined : defaultSubtitle(request.subtitleTracks.filter(track => !unplayable.some(entry => matchesSubtitle(entry, track))));
    if (catalog === undefined) return undefined;
    const rows = plan.subtitle.inventory.filter(entry => matchesSubtitle(entry, catalog));
    return rows.length === 1 ? rows[0]?.trackId : undefined;
}

function subtitleChoice(entry: SubtitleTrack, generated: string | undefined): TrackChoice {
    const choice: TrackChoice = generated === undefined ? { id: entry.trackId, ...subtitleRow(entry, entry.combinedIndex) } : { id: entry.trackId, label: generated };
    if (entry.unplayable !== true) return choice;
    return { ...choice, detail: choice.detail === undefined || choice.detail === "" ? unsupportedFormat() : `${choice.detail} · ${unsupportedFormat()}`, unavailable: true };
}

export type AudioTracks = { readonly state: "loading" } | { readonly state: "failed" } | { readonly state: "ready"; readonly choices: readonly TrackChoice[] };

export type TrackChange =
    | { readonly state: "idle" }
    | { readonly state: "changing"; readonly kind?: "quality" }
    /** The server refused the choice; the current plan keeps playing. */
    | { readonly state: "refused"; readonly message: string }
    | { readonly state: "failed" };

export interface TrackView {
    readonly ai?: SubtitleAIView | undefined;
    /** The AI Subtitles… menu, present only when the server and this file offer something to run. */
    readonly aiMenu?: { readonly menu: AIMenu; /** Shown while a language relies on transcription. */ readonly quota: string | undefined; readonly quotaExhausted: boolean } | undefined;
    readonly seriesSubtitle?: { readonly busy: boolean; readonly message: string } | undefined;
    readonly quality?: { readonly choices: readonly TrackChoice[]; readonly selectedId: string | undefined };
    readonly audio: AudioTracks;
    readonly selectedAudioId: string | undefined;
    readonly subtitles: readonly TrackChoice[];
    /** Undefined: subtitles off. */
    readonly selectedSubtitleId: string | undefined;
    readonly subtitleMode: string;
    readonly change: TrackChange;
    /** A subtitle report is in flight. Subtitle choices can still queue; other track actions wait. */
    readonly reporting?: boolean;
    readonly notices: readonly string[];
    readonly subtitleTools?: { readonly search: SubtitleSearchView; readonly display?: SubtitleDisplayView; readonly overlay: boolean };
    /** The selected subtitle's Sync to Audio and Reset Timing state, when the server can retime it. */
    readonly syncTiming?: SyncTimingView | undefined;
    /** SECONDARY: other text tracks the app can draw under the primary one; present only while the app draws the primary. */
    readonly secondary?: { readonly choices: readonly TrackChoice[]; readonly selectedId: string | undefined } | undefined;
}

export type SubtitleToolAction =
    | { readonly kind: "search-open" }
    | { readonly kind: "search-language"; readonly code: string }
    | { readonly kind: "search-back" }
    | { readonly kind: "search-close" }
    | { readonly kind: "search-download"; readonly key: string }
    | { readonly kind: "search-retry" }
    | { readonly kind: "delay"; readonly milliseconds: number }
    | { readonly kind: "size"; readonly size: SubtitleAppearance["fontSize"] }
    | { readonly kind: "position"; readonly position: SubtitleAppearance["position"] }
    | { readonly kind: "device"; readonly enabled: boolean }
    | { readonly kind: "appearance"; readonly member: AppearanceMember; readonly value: string | number | boolean };

/** Apple's buffering prompt, undo pill and notice, drawn over loading and playback alike. */
export interface BufferingOverlay {
    readonly bufferingPill?: BufferingPillView | undefined;
    readonly bufferingNotice?: BufferingNoticeView | undefined;
}

export type PlaybackView =
    /**
     * `status` is the card's status line (Apple's statusLabel) as a catalog key, so a language change redraws it; `shuffle` words the card
     * for a Shuffle, as Apple's does; `failure: "session"` marks a failed state that came from ending the session, before any lookup.
     */
    | { readonly phase: "completion"; readonly status: MessageKey; readonly state: "finalizing" | "resolving" | "ready" | "failed"; readonly next: PlayRequest | undefined; readonly retryable: boolean; readonly countdown?: number | undefined; readonly deck?: readonly PlayRequest[]; readonly shuffle?: true; readonly failure?: "session" }
    | ({ readonly phase: "loading"; readonly title: string; readonly detail?: "reconnecting" | "restoring"; /** A different file of a Shuffle pick follows: the screen forgets the last file's skip decisions. */ readonly nextPart?: true } & BufferingOverlay)
    | ({
          readonly phase: "playing" | "paused";
          readonly seriesTitle?: string | undefined;
          readonly seasonNumber?: number | undefined;
          readonly episodeNumber?: number | undefined;
          readonly title: string;
          /** Source time. */
          readonly positionSeconds: number;
          readonly durationSeconds: number | undefined;
          readonly buffering: boolean;
          /** Apple's episodes icon: a next episode, On Deck row, in-flight read, or a failed read that can be tried again. */
          readonly episodes?: boolean;
          readonly upNext?: { readonly next: PlayRequest | undefined; readonly deck: readonly PlayRequest[]; readonly countdown: number | undefined; /** The countdown's full length, for the ring (Apple's `nextUpCountdownTotalSeconds`). */ readonly countdownTotal?: number; readonly status: string; readonly loading?: boolean; readonly failed?: boolean };
          readonly resumePending?: boolean;
          readonly transportCommandCount?: number;
          readonly tracks: TrackView;
          readonly hud?: PlayerHUD;
          readonly seekIntervals: { readonly backward: number; readonly forward: number };
          readonly previewKey?: string | undefined;
          /** `status`, `cueCount` and `instant` expose why the layer is empty: no sidecar, still loading, failed, or ready at this clock reading. */
          readonly captions?: { readonly text: string; /** The second line, from Secondary. */ readonly secondaryText?: string; readonly appearance: SubtitleAppearance; readonly status?: "none" | "loading" | "failed" | "ready"; readonly cueCount?: number; readonly instant?: number } | undefined;
          readonly skipMarker?: SkipMarker | undefined;
          readonly undoSkipSeconds?: number | undefined;
      } & BufferingOverlay)
    | { readonly phase: "error"; readonly title: string; readonly error: PlaybackError; readonly retryable?: boolean }
    | { readonly phase: "closed" };

/** What the player screen drives. */
export interface PlayerControls {
    setVideo(kind: "speed" | "aspect", value: string): void;
    toggleAutoNext(): void;
    retryChapters(): void;
    subscribe(listener: (view: PlaybackView) => void): () => void;
    togglePause(): void;
    setPaused(paused: boolean): void;
    /** Source seconds, negative to go back. */
    seekBy(seconds: number): void;
    seekToSeconds(seconds: number): void;
    back(): void;
    /** Ends the attempt. Visibility uses suspend/restore instead. */
    background(): void;
    /** App hide: suspend AVPlay, keep the session, and do not rely on timers firing. */
    suspend(): void;
    /** App show: revalidate authority, then restore the pipeline or reconnect. */
    restore(): void;
    dismissError(): void;
    selectAudio(trackId: string): void;
    /** Undefined turns subtitles off. */
    selectSubtitle(trackId: string | undefined): void;
    selectQuality(preference: string): void;
    retryTrackInfo(): void;
    retrySettings(): void;
    retryCompletion(): void;
    playNext(request?: PlayRequest): void;
    /** Opens the manual Up Next panel. Apple tvOS `showNextUpNow`. */
    showUpNext(): void;
    cancelAutoplay(): void;
    keepWatching(): void;
    saveSeriesSubtitle(): void;
    /** AI Subtitles…: one language choice; the controller picks translate, transcribe or both. */
    startSubtitleAI(language: string): void;
    /** Open: the viewer opened AI Subtitles…. Cancel stops the running job, Dismiss clears a failure or a finished job, Discard lets a request go out after one whose outcome is unknown. */
    subtitleAIAction(action: "open" | "cancel" | "dismiss" | "discard"): void;
    selectAIResult(id: string): void;
    subtitleTool(action: SubtitleToolAction): void;
    /** Sync to Audio for the subtitle with this sync key. */
    syncSubtitle(key: string): void;
    /** Reset Timing for the subtitle with this sync key. */
    resetSubtitleTiming(key: string): void;
    /** SECONDARY: undefined turns the second line off. */
    selectSecondarySubtitle(trackId: string | undefined): void;
    seekThumbnail(seconds: number, signal: AbortSignal, loadSheet: ThumbnailSheetLoader): Promise<SeekThumbnail | undefined>;
    /** Select on the buffering pill: Lower quality on the prompt, Restore quality on the undo. */
    selectBufferingPrimary(): void;
    /** Keep quality on the buffering prompt. */
    selectBufferingKeep(): void;
    /** Back with a buffering pill up. True when it took the pill down, so the press ends there. */
    dismissBufferingPill(): boolean;
    /** A skip pill is on screen: a buffering pill waits for it, as Apple's does. */
    setSkipPillShown(shown: boolean): void;
    /** A language landed: send the current playback view again, so the names built into it read in that language. */
    refreshView(): void;
}

export interface PlaybackDeps {
    readonly session: NativeSession;
    readonly avplay: AVPlay;
    readonly clock: Clock;
    readonly randomBytes: RandomBytes;
    /** `webapis.productinfo.getRealModel()` and the package version, for the server's device-quirk match. */
    readonly device: { readonly model: string; readonly appVersion: string; readonly hdrProbeScope?: unknown };
    readonly exits: PlaybackExits;
    /** The profile spoiler owner. Absent reads as both switches off. */
    readonly spoilers?: () => EpisodeSpoilerSettings;
    /** Public per-install storage for the once-only leftover subtitle-delay clear. Never tokens. */
    readonly publicStorage?: PublicStorage;
    /** The profile's Resolution cap. Absent reads as no cap. Next-episode, On Deck and shuffle picks rank files by it. */
    readonly resolutionCap?: Pick<ResolutionCap, "quality" | "ready">;
}

const PROGRESS_INTERVAL_MS = 10000;
/**
 * How long AVPlay may take to prepare a stream before the route counts as failed: a backstop for a prepare that hangs while the page still
 * runs. It cannot catch a playlist that freezes the page's JavaScript, which is checked before `open` instead (`playlistUnreadable`, #650).
 * A failed route is replanned, and the third replan that fails ends in the error page. The server keeps a fresh plan 90 s (protocol v3 §2.5).
 */
const STARTUP_TIMEOUT_MS = 15000;
/** Failed routes this client replans before giving up; the protocol allows up to 8. */
const MAX_RECOVERY_REPLANS = 3;
/** Apple's typed failure for a track its engine could not select (AetherEngine PlaybackErrorKind). */
const AUDIO_TRACK_SWITCH_FAILED = "audioTrackSwitchFailed";
/** Waits before resending an identical start, replan or stop that got no usable answer. */
const RESEND_DELAYS_MS = [1000, 2000];
/** AVPlay's display coordinates are in the app's 1920x1080 space. */
const SCREEN = { width: 1920, height: 1080 };
/** Apple tvOS `nextUpHUDCountdownThresholdSeconds`: a manual panel counts down only inside this. */
const MANUAL_COUNTDOWN_THRESHOLD_SECONDS = 100;
/** The countdown after a video ends before the next one starts (Apple's `nextUpCountdownDefaultSeconds`). */
export const AUTOPLAY_COUNTDOWN_SECONDS = 10;

type TrackInfo = { readonly state: "loading" | "failed" } | { readonly state: "ready"; readonly versions: readonly FileVersionTracks[] };

/** Plain-text notices for the plan's degradation warnings a viewer can notice (protocol v3 §7.2). */
const WARNING_NOTICES: Readonly<Record<string, string>> = {
    subtitle_burn_in: "Subtitles are burned into the video.",
    audio_track_unavailable: "The chosen audio track isn't in this version, so its default track is playing.",
    subtitle_track_unavailable: "The chosen subtitles aren't available in this version, so subtitles are off.",
};

interface Attempt {
    readonly hud: HUDState;
    /** Lower quality when buffering: the decision controller, its pill and notice. */
    readonly bufferingQuality: BufferingBridge;
    /** `playback.buffering_quality_mode`; Apple's default until the profile's value is read. */
    bufferingMode: BufferingQualityMode;
    /** The server advertises `buffering_quality_v1`: the capability response at start, then each decision. */
    bufferingAdvertised: boolean;
    /** Restore quality pressed while a replan or reload is in flight; it goes out once the player can send it. */
    bufferingRestore: ReplanRequest | undefined;
    /** The screen is drawing a skip pill. */
    skipPillShown: boolean;
    autoNextSupported: boolean;
    promptSeconds: number;
    promptSupported: boolean;
    promptDismissed: boolean;
    promptPending: boolean;
    promptLookedUp: boolean;
    prompt: { next: PlayRequest | undefined; deck: readonly PlayRequest[]; fromDeck: boolean; loading?: boolean; failed?: boolean } | undefined;
    /** AVPlay refused the picture rectangle, usually during an outstanding seek. */
    rectPending: boolean;
    /** Discovery shared by the episodes icon and the pre-end prompt. A seek does not cancel it. */
    offer: {
        started: boolean;
        manual: boolean;
        episodeLoading: boolean;
        deckLoading: boolean;
        episodeSettled: boolean;
        episodeFailed: boolean;
        episode: PlayRequest | undefined;
        deckSettled: boolean;
        deckFailed: boolean;
        episodeWindowRetried: boolean;
        deckWindowRetried: boolean;
        deck: PlayRequest[];
        /** Successor whose catalog presentation was requested. Ticks must not read it again. */
        presentationFor: string | undefined;
    };
    transportCommandCount: number;
    autoNext: boolean;
    /** Confirmed Auto-play saves advance this so an older settings read cannot overwrite them. */
    settingsEpoch: number;
    /** The in-flight Auto-play save. EOF waits for it before reading the effective value. */
    autoNextSave: Promise<void> | undefined;
    introMode: "never" | "ask" | "always";
    skipCredits: boolean;
    skippedMarkers: Set<SkipMarker>;
    /** Where Watch Intro returns to. The player screen's skip timer decides how long it is offered, as Apple's IntroSkipPrompt does. */
    undoSkip: number | undefined;
    pendingSkipUndo: number | undefined;
    ai: SubtitleAI | undefined;
    search: SubtitleSearch | undefined;
    sync: SubtitleSync | undefined;
    display: SubtitleDisplay | undefined;
    readonly aiBlockedFiles: Set<string>;
    pendingAIResult: string | undefined;
    /** A downloaded subtitle waiting for the refreshed inventory, reported even when AI is unavailable. */
    pendingDownloadId: string | undefined;
    appearance: SubtitleAppearance;
    subtitleSync: number;
    cues: readonly SubtitleCue[];
    /** SECONDARY: the inventory row drawn under the primary, and its cues. */
    secondaryId: string | undefined;
    secondaryCues: readonly SubtitleCue[];
    /** The primary artifact's timing origin, and the sidecar URL, the cues were read with. */
    secondaryOrigin: number;
    secondaryUrl: string | undefined;
    /** The sync timing versions the primary's and the secondary's cue reads started under. */
    captionTiming: number;
    secondaryTiming: number;
    secondaryAbort: AbortController | undefined;
    captionAbort: AbortController | undefined;
    captionNotice: string;
    /** An embedded track whose file failed before AVPlay could list its tracks: AVPlay draws it at the first frame. */
    captionFallback: string | undefined;
    captionPreferenceNotice: string;
    /** The artifact the cues came from; a replan naming the same one keeps them. */
    captionKey: string | undefined;
    captionPreferencesRead: boolean;
    seriesSubtitle: { readonly busy: boolean; readonly message: string } | undefined;
    readonly request: PlayRequest;
    playbackAttemptId: string;
    /** The session's authority signal when the attempt began. */
    readonly signal: AbortSignal;
    live: boolean;
    installationId: string | undefined;
    profileId: string | undefined;
    sessionId: string | undefined;
    plan: PlaybackPlan | undefined;
    planAttemptId: string;
    readonly attemptedKeys: string[];
    recoveries: number;
    sequence: number;
    sourceSeconds: number;
    paused: boolean;
    qualityPreference: string;
    bandwidthCapKbps: number | undefined;
    autoBandwidthCapKbps: number | undefined;
    qualityPicked: boolean;
    seekIntervals: { readonly backward: number; readonly forward: number };
    /** Apple's default is on. A failed read of an offered HDR key forces it off. */
    hdrEnabled: boolean;
    hdrPanel: HdrPanel;
    batchedSettings: boolean;
    serverFeatures: readonly string[];
    /** The capability response advertised `hls_subtitle_renditions_all_v1`. */
    renditionsAll: boolean;
    nativeSubtitleUnavailable: boolean;
    /** A subtitle applied on the open stream ahead of the plan. `id` undefined is Off. */
    subtitleOverride: { readonly id: string | undefined } | undefined;
    /** `effective_subtitle_language` from the watch read: the language the track list floats to the top. */
    orderingLanguage: string | undefined;
    /** What was showing before the in-stream report, restored if the server refuses it. */
    subtitleRestore: { readonly id: string | undefined } | undefined;
    /** A subtitle report is out and the current transport keeps playing. */
    reporting: boolean;
    /** A newer in-stream pick made while a report was out. Latest wins. */
    pendingSubtitle: { readonly id: string | undefined; readonly applied: boolean } | undefined;
    /** Applied after a reopened plan when a newer pick arrived during the report. */
    queuedSubtitle: { readonly id: string | undefined } | undefined;
    trickplayEnabled: boolean;
    thumbnails: SeekThumbnails | undefined;
    markers: { readonly fileId: string; segments: readonly SkipMarker[] } | undefined;
    /** The current transport is playing or paused. */
    started: boolean;
    /** A transport of this attempt has shown a frame. Stays true across reconnects. */
    presented: boolean;
    hidden: boolean;
    /** suspend() succeeded from PLAYING or PAUSED, so restoreAsync is valid. */
    suspended: boolean;
    /** suspend() succeeded from READY, where restoreAsync is not valid. */
    suspendedReady: boolean;
    deferredOpen: boolean;
    restoring: boolean;
    /** The restoreAsync that has not answered; revalidation already cleared `restoring`. Only its own answer or the close of its transport clears it. */
    restoreOpen: object | undefined;
    /** The next open is a reconnect handoff and should say so. */
    resuming: boolean;
    recovery: PlaybackRecovery | undefined;
    recoveryPending: boolean;
    recoverySpec: ReturnType<typeof operations.replanPlayback> | undefined;
    recoveryRetryAt: number;
    cancelRecovery: (() => void) | undefined;
    /** Identical body for an unanswered replacement start. */
    replacementBody: StartPlaybackBody | undefined;
    retirePredecessor: boolean;
    resumeGeneration: number;
    progressDue: number | undefined;
    buffering: boolean;
    /** A seek or replan (including a track change) is in flight. */
    busy: boolean;
    /** The item's versions, read once per attempt for the audio menu. */
    tracks: TrackInfo | undefined;
    trackRead: number;
    change: TrackChange;
    /** A failed route reported while a track change was pending; recovered once it settles. */
    changeFailure: string | undefined;
    endedDuringChange: boolean;
    seekFailure: string | undefined;
    /** Pause or resume asked for while a local seek is settling. Applied when that seek ends. */
    pauseAfterSeek: boolean | undefined;
    queuedSeekSeconds: number | undefined;
    /** The target of the local seek in flight; read only while `pending.seek` is set. */
    seekTarget: number | undefined;
    /** The skips behind `queuedSeekSeconds`, in press order, when only skips queued it: a failed seek replays them from the real position. */
    queuedSkips: number[] | undefined;
    progress: Promise<void> | undefined;
    cancelTimer: (() => void) | undefined;
    stopSpec: RequestSpec<PlaybackMutation> | undefined;
    stopped: boolean;
    /** The advance may go on: the session stopped, or its STOP failed in a way that may clear and is left to the background (#709). */
    ended: boolean;
    stopRetryAt: number;
    progressRefusal: unknown;
}

interface PendingTransport {
    seek: Promise<void> | undefined;
    closing: Promise<void> | undefined;
}

// AVPlay is a platform singleton. A replacement controller must also wait for an
// uncancellable seek owned by the screen it replaced.
const pendingTransports = new WeakMap<AVPlay, PendingTransport>();

/** A subtitle the catalog can already name. Off and an unresolved Auto stay omitted. */
function subtitleStart(request: PlayRequest): { subtitle_track_id: string } | Record<string, never> {
    const subtitleTrackId = startSubtitleTrackId(request.fileId, request.subtitle, request.subtitleTracks, request.subtitlePreferences);
    return subtitleTrackId === undefined ? {} : { subtitle_track_id: subtitleTrackId };
}

export class PlaybackController implements PlayerControls {
    private readonly deps: PlaybackDeps;
    private readonly pending: PendingTransport;
    private attempt: Attempt | undefined;
    /** Increases on every AVPlay open and teardown; callbacks of an older value are dropped. */
    private transport = 0;
    private cancelStartup: (() => void) | undefined;
    private shownError: PlaybackError | undefined;
    private current: PlaybackView = { phase: "closed" };
    private readonly listeners: ((view: PlaybackView) => void)[] = [];
    private readonly stopAuthority: () => void;
    private startupDue: number | undefined;
    /** The last view as the player built it, before the buffering pill and notice are added. */
    private base: PlaybackView = { phase: "closed" };
    /** Counts show() calls that reach the buffering sync, so a nested one can supersede its caller. */
    private shown = 0;
    /** The last `playback.buffering_quality_mode` read, kept for a later attempt whose read fails, as Apple keeps the device's cached value. */
    private lastBufferingMode: BufferingQualityMode | undefined;
    /** The device going offline or online is transport trouble for the buffering controller. */
    private readonly onConnectivity = (): void => {
        const attempt = this.active();
        if (attempt !== undefined) this.syncBuffering(attempt);
    };
    private completion: { readonly attempt: Attempt; readonly abort: AbortController; pending: boolean } | undefined;
    private cancelAutoplayTimer: (() => void) | undefined;
    private nextStart: PlayRequest | undefined;

    constructor(deps: PlaybackDeps) {
        this.deps = deps;
        const pending = pendingTransports.get(deps.avplay) ?? { seek: undefined, closing: undefined };
        pendingTransports.set(deps.avplay, pending);
        this.pending = pending;
        globalThis.addEventListener?.("online", this.onConnectivity);
        globalThis.addEventListener?.("offline", this.onConnectivity);
        this.stopAuthority = deps.session.onAuthorityChange(() => {
            const attempt = this.attempt;
            if (attempt === undefined || (!attempt.live && this.completion === undefined)) {
                return;
            }
            this.cancelCompletion();
            this.leave(attempt, "abandon");
            this.attempt = undefined;
            this.show({ phase: "closed" });
            deps.exits.onEnd("authority_changed");
        });
    }

    /**
     * Track names, flags and Up Next's words are built into each view, so a language that lands while playback is paused has to send the view again.
     * The screen asks, once no Select is held; a loading, restoring, completion or error view is left as it is. It also puts the Up Next preview rectangle where the language now reads.
     */
    refreshView(): void {
        const attempt = this.attempt;
        if (attempt === undefined || (this.current.phase !== "playing" && this.current.phase !== "paused")) return;
        // The Up Next preview sits on the side the language reads from, so a direction that changes moves the video with the panel.
        if (attempt.prompt !== undefined) this.paintRect(attempt);
        this.showPlayback(attempt);
    }

    /** Starts a new attempt; one already running is stopped and never plays. */
    play(request: PlayRequest): void {
        if (this.completion !== undefined) return;
        const previous = this.attempt;
        if (previous !== undefined) {
            this.leave(previous, "stop");
        }
        this.shownError = undefined;
        const bufferingQuality: BufferingBridge = new BufferingBridge(this.deps.clock, {
            issueReplan: (request, restore) => this.issueBufferingReplan(bufferingQuality, request, restore),
            changed: () => this.bufferingChanged(bufferingQuality),
        });
        const attempt: Attempt = {
            hud: new HUDState(),
            bufferingQuality, bufferingMode: this.lastBufferingMode ?? DEFAULT_BUFFERING_QUALITY_MODE, bufferingAdvertised: false, bufferingRestore: undefined, skipPillShown: false,
            autoNextSupported: false,
            promptSeconds: 30, promptSupported: false, promptDismissed: false, promptPending: false, promptLookedUp: false, prompt: undefined,
            offer: { started: false, manual: false, episodeLoading: false, deckLoading: false, episodeSettled: false, episodeFailed: false, episode: undefined, deckSettled: false, deckFailed: false, episodeWindowRetried: false, deckWindowRetried: false, deck: [], presentationFor: undefined },
            rectPending: false,
            transportCommandCount: 0,
            autoNext: false, settingsEpoch: 0, autoNextSave: undefined,
            ai: undefined, search: undefined, sync: undefined, display: undefined, aiBlockedFiles: new Set(), pendingAIResult: undefined, pendingDownloadId: undefined,
            introMode: "ask", skipCredits: false, skippedMarkers: new Set(), undoSkip: undefined, pendingSkipUndo: undefined,
            appearance: DEFAULT_APPEARANCE, subtitleSync: 0, cues: [], secondaryId: undefined, secondaryCues: [], secondaryOrigin: 0, secondaryUrl: undefined, captionTiming: 0, secondaryTiming: 0, secondaryAbort: undefined, captionAbort: undefined, captionNotice: "", captionFallback: undefined, captionPreferenceNotice: "", captionKey: undefined, captionPreferencesRead: false, seriesSubtitle: request.episode ? { busy: false, message: "" } : undefined,
            request,
            playbackAttemptId: this.newId(),
            signal: this.deps.session.authoritySignal,
            live: true,
            installationId: undefined,
            profileId: undefined,
            sessionId: undefined,
            plan: undefined,
            planAttemptId: this.newId(),
            attemptedKeys: [],
            recoveries: 0,
            sequence: 0,
            sourceSeconds: request.startSeconds ?? 0,
            paused: false,
            qualityPreference: "auto",
            bandwidthCapKbps: undefined,
            autoBandwidthCapKbps: undefined,
            qualityPicked: false,
            seekIntervals: { backward: 10, forward: 10 },
            hdrEnabled: true,
            hdrPanel: { hdr10: false, hlg: false, dolbyVision: false },
            batchedSettings: true,
            serverFeatures: [],
            renditionsAll: false,
            nativeSubtitleUnavailable: false,
            subtitleOverride: undefined,
            orderingLanguage: undefined,
            subtitleRestore: undefined,
            reporting: false,
            pendingSubtitle: undefined,
            queuedSubtitle: undefined,
            trickplayEnabled: false,
            thumbnails: undefined,
            markers: undefined,
            started: false,
            presented: false,
            hidden: false,
            suspended: false,
            suspendedReady: false,
            deferredOpen: false,
            restoring: false,
            restoreOpen: undefined,
            resuming: false,
            recovery: undefined,
            recoveryPending: false,
            recoverySpec: undefined,
            recoveryRetryAt: 0,
            cancelRecovery: undefined,
            replacementBody: undefined,
            retirePredecessor: false,
            resumeGeneration: 0,
            progressDue: undefined,
            buffering: false,
            busy: false,
            tracks: undefined,
            trackRead: 0,
            change: { state: "idle" },
            changeFailure: undefined,
            endedDuringChange: false,
            seekFailure: undefined,
            pauseAfterSeek: undefined,
            queuedSeekSeconds: undefined,
            seekTarget: undefined,
            queuedSkips: undefined,
            progress: undefined,
            cancelTimer: undefined,
            stopSpec: undefined,
            stopped: false,
            ended: false,
            stopRetryAt: 0,
            progressRefusal: undefined,
        };
        this.attempt = attempt;
        this.show({ phase: "loading", title: request.title });
        void this.begin(attempt);
    }

    subscribe(listener: (view: PlaybackView) => void): () => void {
        this.listeners.push(listener);
        listener(this.current);
        return () => {
            const index = this.listeners.indexOf(listener);
            if (index !== -1) {
                this.listeners.splice(index, 1);
            }
        };
    }

    setVideo(kind: "speed" | "aspect", value: string): void {
        const attempt = this.active();
        if (attempt?.plan === undefined || attempt.busy || attempt.hidden || attempt.restoring) return;
        attempt.hud.setVideo(this.deps.avplay, attempt.plan, kind, value);
        this.showPlayback(attempt);
    }

    retryChapters(): void {
        const attempt = this.active();
        if (attempt?.plan === undefined) return;
        attempt.hud.read(this.deps.session, attempt.request.contentId, attempt.plan.effectiveMediaFileId, attempt.signal, () => this.showPlayback(attempt), true);
        this.showPlayback(attempt);
    }

    toggleAutoNext(): void {
        const attempt = this.active();
        if (attempt === undefined || !attempt.autoNextSupported || attempt.hud.autoBusy) return;
        attempt.hud.autoBusy = true;
        attempt.hud.message = "Saving Auto-play next";
        this.showPlayback(attempt);
        const enabled = !attempt.autoNext;
        const epoch = attempt.settingsEpoch;
        const deciding = (): boolean => attempt.live || this.completion?.attempt === attempt;
        const save = this.deps.session.call({ ...operations.putSetting(AUTO_NEXT_KEY, enabled), profileScoped: true, signal: attempt.signal }).then(async () => {
            const values = await this.deps.session.call({ ...operations.effectiveSettings([AUTO_NEXT_KEY]), profileScoped: true, signal: attempt.signal });
            if (attempt.signal.aborted || epoch !== attempt.settingsEpoch || !deciding()) return;
            attempt.settingsEpoch = epoch + 1;
            attempt.autoNext = values.get(AUTO_NEXT_KEY)?.value === true;
            if (attempt.live) attempt.hud.message = attempt.autoNext === enabled ? "" : "This TV's override keeps Auto-play next unchanged.";
        }).catch(() => {
            if (!attempt.signal.aborted && attempt.live) attempt.hud.message = "Could not save Auto-play next. Try again.";
        }).finally(() => {
            attempt.hud.autoBusy = false;
            if (attempt.live) this.showPlayback(attempt);
        });
        const settled = save.then(() => undefined, () => undefined);
        attempt.autoNextSave = settled;
        void settled.finally(() => {
            if (attempt.autoNextSave === settled) attempt.autoNextSave = undefined;
        });
    }

    togglePause(): void {
        const attempt = this.active();
        if (attempt !== undefined) this.setPaused(!(attempt.pauseAfterSeek ?? attempt.paused));
    }

    setPaused(paused: boolean): void {
        const attempt = this.active();
        if (attempt === undefined) {
            return;
        }
        attempt.transportCommandCount++;
        // A seek reanchor replaces the transport; preparation must use the latest intent.
        if (!attempt.started) {
            if (attempt.presented) attempt.paused = paused;
            return;
        }
        // AVPlay rejects play and pause while seekTo is outstanding. Keep the request and apply it when the seek ends.
        if (attempt.busy && this.pending.seek !== undefined && attempt.change.state !== "changing") {
            attempt.pauseAfterSeek = paused;
            this.showPlayback(attempt);
            return;
        }
        if (attempt.paused === paused) { this.showPlayback(attempt); return; }
        if (attempt.busy && !attempt.reporting && !(attempt.change.state === "changing" && attempt.change.kind === "quality")) {
            return;
        }
        if (attempt.hidden || attempt.restoring) {
            attempt.paused = paused;
            return;
        }
        try {
            if (paused) {
                this.deps.avplay.pause();
            } else {
                this.deps.avplay.play();
            }
            attempt.paused = paused;
        } catch {
            // Not allowed in the player's state right now; the next key press tries again.
        }
        this.showPlayback(attempt);
    }

    seekBy(seconds: number): void {
        const attempt = this.active();
        if (attempt === undefined) return;
        // PlayerViewModel.queueSkipDebounce (RelativeSeek.target(current:pending:delta:)): a skip pressed while a seek is in flight adds
        // to the target already asked for, the queued one first, never to the position from before that seek.
        const inFlight = attempt.busy && this.pending.seek !== undefined;
        const pending = inFlight ? attempt.queuedSeekSeconds ?? attempt.seekTarget : undefined;
        const skips = attempt.queuedSeekSeconds === undefined ? [] : attempt.queuedSkips;
        this.seekToSeconds((pending ?? attempt.sourceSeconds) + seconds);
        if (inFlight && attempt.queuedSeekSeconds !== undefined && skips !== undefined) attempt.queuedSkips = [...skips, seconds];
    }

    retrySettings(): void {
        const attempt = this.attempt;
        if (this.shownError?.kind === "settings" && attempt !== undefined && !attempt.signal.aborted && attempt.signal === this.deps.session.authoritySignal) this.play(attempt.request);
    }

    async seekThumbnail(seconds: number, signal: AbortSignal, loadSheet: ThumbnailSheetLoader): Promise<SeekThumbnail | undefined> {
        const attempt = this.changeable();
        const fileId = attempt?.plan?.effectiveMediaFileId;
        if (attempt === undefined || fileId === undefined || !attempt.trickplayEnabled) return undefined;
        const provider = attempt.thumbnails ?? new SeekThumbnails(this.deps.session, this.deps.clock, attempt.request.contentId, fileId);
        attempt.thumbnails = provider;
        const tile = await provider.load(seconds, signal, loadSheet);
        return attempt.live && attempt.thumbnails === provider && !attempt.busy && !signal.aborted ? tile : undefined;
    }

    private clearThumbnails(attempt: Attempt): void {
        attempt.thumbnails?.destroy();
        attempt.thumbnails = undefined;
    }

    seekToSeconds(seconds: number): void {
        this.seekAbsolute(seconds);
    }

    private seekAbsolute(seconds: number, requestedPaused?: boolean): void {
        const attempt = this.active();
        const plan = attempt?.plan;
        if (attempt === undefined || plan === undefined || !attempt.started) {
            return;
        }
        const duration = plan.durationSeconds;
        const target = Math.max(0, Math.min(seconds, duration ?? Number.MAX_VALUE));
        if (attempt.busy) {
            if (this.pending.seek !== undefined && attempt.change.state !== "changing" && !attempt.hidden && !attempt.restoring) {
                attempt.queuedSeekSeconds = target;
                attempt.queuedSkips = undefined;
            }
            return;
        }
        if (attempt.undoSkip === target) attempt.undoSkip = undefined;
        const timeline = plan.timeline;
        const local =
            timeline.canSeekAnywhere &&
            target >= timeline.timelineOffsetSeconds &&
            (timeline.seekWindowStartSeconds === undefined || target >= timeline.seekWindowStartSeconds) &&
            (timeline.seekWindowEndSeconds === undefined || target <= timeline.seekWindowEndSeconds);
        attempt.pauseAfterSeek = requestedPaused;
        attempt.busy = true;
        this.clearThumbnails(attempt);
        // The buffering controller must see the seek begin: the buffering that follows belongs to it.
        this.syncBuffering(attempt);
        if (!local) {
            if (requestedPaused !== undefined) attempt.paused = requestedPaused;
            attempt.pauseAfterSeek = undefined;
            // An open or partial window has no bytes there yet: the server re-anchors the timeline.
            this.closeTransport();
            attempt.started = false;
            this.show({ phase: "loading", title: attempt.request.title });
            void this.replan(attempt, plan, "seek_reanchor", target, undefined);
            return;
        }
        const transport = this.transport;
        attempt.seekTarget = target;
        const settled = (moved: boolean): void => {
            if (transport !== this.transport || !attempt.live) {
                attempt.pauseAfterSeek = undefined;
                attempt.queuedSeekSeconds = undefined;
                attempt.queuedSkips = undefined;
                return;
            }
            attempt.busy = false;
            if (moved) {
                attempt.sourceSeconds = target;
            }
            const failure = attempt.seekFailure;
            attempt.seekFailure = undefined;
            const pauseAfterSeek = attempt.pauseAfterSeek;
            attempt.pauseAfterSeek = undefined;
            // Skips queued behind a seek that did not move count from where playback still is, not from the failed target, each held at
            // 0 and the end as it was when pressed, so a failed seek and a landed one end in the same place.
            const queued = !moved && attempt.queuedSkips !== undefined && attempt.queuedSeekSeconds !== undefined
                ? attempt.queuedSkips.reduce((at, skip) => Math.max(0, Math.min(at + skip, duration ?? Number.MAX_VALUE)), attempt.sourceSeconds)
                : attempt.queuedSeekSeconds;
            attempt.queuedSeekSeconds = undefined;
            attempt.queuedSkips = undefined;
            if (failure !== undefined) {
                if (pauseAfterSeek !== undefined) attempt.paused = pauseAfterSeek;
                this.routeFailed(attempt, failure);
                return;
            }
            if (queued !== undefined) {
                this.finishSkipSeek(attempt, moved);
                this.seekAbsolute(queued, pauseAfterSeek);
                this.showPlayback(attempt);
                return;
            }
            if (pauseAfterSeek !== undefined && pauseAfterSeek !== attempt.paused) {
                if (attempt.hidden || attempt.restoring) {
                    attempt.paused = pauseAfterSeek;
                } else {
                    try {
                        if (pauseAfterSeek) this.deps.avplay.pause();
                        else this.deps.avplay.play();
                        attempt.paused = pauseAfterSeek;
                    } catch {
                        // The platform still refuses play or pause; the next key tries again.
                    }
                }
            }
            if (moved) this.updatePrompt(attempt);
            this.finishSkipSeek(attempt, moved);
            this.showPlayback(attempt);
        };
        try {
            this.seekTo(
                Math.round((target - timeline.timelineOffsetSeconds) * 1000),
                () => settled(true),
                () => settled(false),
            );
        } catch {
            settled(false);
        }
    }

    background(): void {
        if (this.completion !== undefined) {
            this.cancelCompletion();
            this.back();
            return;
        }
        const attempt = this.active();
        if (attempt !== undefined) {
            this.fail(attempt, { kind: "backgrounded" }, true);
        }
    }

    suspend(): void {
        if (this.completion !== undefined) {
            this.cancelCompletion();
            this.back();
            return;
        }
        const attempt = this.active();
        if (attempt === undefined || attempt.hidden) {
            return;
        }
        if (attempt.prompt !== undefined) this.cancelAutoplay();
        attempt.resumeGeneration += 1;
        attempt.restoring = false;
        attempt.hidden = true;
        attempt.queuedSeekSeconds = undefined;
        attempt.queuedSkips = undefined;
        // A backgrounded app is paused to the buffering controller: nothing waits, prompts or lowers unseen.
        this.syncBuffering(attempt);
        this.capturePosition(attempt);
        this.holdTimers(attempt);
        const seek = this.pending.seek;
        if (seek !== undefined) {
            const transport = this.transport;
            void seek.then(() => {
                if (this.attempt === attempt && attempt.live && transport === this.transport && (attempt.hidden || attempt.restoring)) {
                    this.capturePosition(attempt);
                    if (!attempt.suspended && !attempt.suspendedReady) this.suspendTransport(attempt);
                }
            });
            return;
        }
        this.suspendTransport(attempt);
    }

    private suspendTransport(attempt: Attempt): void {
        const state = this.deps.avplay.getState();
        if ((state === "PLAYING" || state === "PAUSED" || state === "READY") && this.deps.avplay.suspend !== undefined) {
            try {
                this.deps.avplay.suspend();
                if (state === "READY") {
                    attempt.suspendedReady = true;
                } else {
                    attempt.suspended = true;
                }
            } catch {
                attempt.suspended = false;
                attempt.suspendedReady = false;
            }
        }
    }

    restore(): void {
        const attempt = this.attempt;
        if (attempt === undefined || !attempt.live || !attempt.hidden || attempt.restoring) {
            return;
        }
        attempt.hidden = false;
        if (this.shownError !== undefined) {
            return;
        }
        attempt.restoring = true;
        this.showLoading(attempt, "restoring");
        const generation = attempt.resumeGeneration + 1;
        void this.resumeVisible(attempt).finally(() => {
            if (attempt.resumeGeneration === generation) attempt.restoring = false;
        });
    }

    back(): void {
        this.cancelCompletion();
        this.nextStart = undefined;
        if (this.shownError !== undefined) {
            this.dismissError();
            return;
        }
        const attempt = this.attempt;
        if (attempt !== undefined) {
            this.leave(attempt, "stop");
        }
        this.attempt = undefined;
        this.show({ phase: "closed" });
        this.deps.exits.onBack();
    }

    selectAudio(trackId: string): void {
        const attempt = this.changeable();
        const plan = attempt?.plan;
        if (attempt === undefined || plan === undefined || trackId === plan.selectedTracks.audio?.id) {
            return;
        }
        if (!audioChoices(attempt, plan).some((choice) => choice.id === trackId)) {
            return;
        }
        // Omitting a subtitle from a track_change turns it off, so the shown one is named again.
        const subtitle = chosenTracks(attempt, plan).subtitle;
        this.changeTracks(attempt, plan, { audio: { id: trackId }, ...(subtitle === undefined ? {} : { subtitle }) });
    }

    selectSubtitle(trackId: string | undefined): void {
        const reporting = this.active();
        if (reporting?.reporting) {
            const plan = reporting.plan;
            if (plan === undefined) return;
            const latest = reporting.pendingSubtitle;
            if (trackId === (latest === undefined ? shownSubtitle(reporting, plan) : latest.id)) return;
            if (trackId !== undefined && !selectableSubtitle(plan, trackId)) return;
            const applied = this.applyStreamSubtitle(reporting, trackId);
            if (applied) reporting.subtitleOverride = { id: trackId };
            reporting.pendingSubtitle = { id: trackId, applied };
            this.showPlayback(reporting);
            return;
        }
        const attempt = this.changeable();
        const plan = attempt?.plan;
        if (attempt === undefined || plan === undefined || trackId === shownSubtitle(attempt, plan)) {
            return;
        }
        if (trackId !== undefined && !selectableSubtitle(plan, trackId)) {
            return;
        }
        const previous = shownSubtitle(attempt, plan);
        if (this.applyStreamSubtitle(attempt, trackId)) {
            attempt.subtitleOverride = { id: trackId };
            this.showPlayback(attempt);
            if (renditionSwitch(plan, trackId)) this.reportSubtitle(attempt, plan, trackId, previous);
            return;
        }
        const audio = plan.selectedTracks.audio;
        this.changeTracks(attempt, plan, { ...(audio === undefined ? {} : { audio }), ...(trackId === undefined ? {} : { subtitle: { id: trackId } }) });
    }

    saveSeriesSubtitle(): void {
        const attempt = this.changeable();
        const plan = attempt?.plan;
        if (attempt === undefined || plan === undefined || attempt.seriesSubtitle === undefined || attempt.seriesSubtitle.busy) return;
        const shown = shownSubtitle(attempt, plan);
        const track = plan.subtitle.inventory.find(track => track.trackId === shown);
        const current = (): boolean => attempt.live && this.attempt === attempt && !attempt.signal.aborted;
        const failed = "Could not confirm the series subtitle choice. Check the saved preference before trying again.";
        // Saving `undefined` means Off, so a shown track missing from the inventory must not be saved.
        if (shown !== undefined && track === undefined) {
            attempt.seriesSubtitle = { busy: false, message: failed };
            this.showPlayback(attempt);
            return;
        }
        attempt.seriesSubtitle = { busy: true, message: "Saving series subtitles…" };
        this.showPlayback(attempt);
        void (async () => {
            try {
                const detail = await this.deps.session.call({ ...operations.watchDetail(attempt.request.contentId), profileScoped: true, signal: attempt.signal });
                if (!current()) return;
                if (detail.id !== attempt.request.contentId || detail.seriesId === undefined) throw new Error("Series unavailable");
                await this.deps.session.call({ ...operations.saveSeriesSubtitle(detail.seriesId, track), profileScoped: true, replayAfterRefresh: false, signal: attempt.signal });
                if (current()) attempt.seriesSubtitle = { busy: false, message: "Subtitle choice saved for this series." };
            } catch {
                if (current()) attempt.seriesSubtitle = { busy: false, message: failed };
            }
            if (current()) this.showPlayback(attempt);
        })();
    }

    retryTrackInfo(): void {
        const attempt = this.active();
        if (attempt !== undefined && attempt.tracks?.state === "failed") {
            this.readTracks(attempt);
        }
    }

    startSubtitleAI(language: string): void {
        const attempt = this.changeable();
        const plan = attempt?.plan;
        if (attempt === undefined || plan === undefined || attempt.hidden || attempt.restoring) return;
        const inputs = aiInputs(attempt, plan);
        // The route is chosen from the same inputs the menu was drawn from, so a row that was enabled sends what it showed.
        const route = inputs === undefined ? undefined : aiRoute(inputs, language);
        if (route === undefined) return;
        void attempt.ai?.start({ media_file_id: plan.effectiveMediaFileId, kind: route.kind, source_index: route.sourceIndex, source_language: route.sourceLanguage, target_language: route.targetLanguage, start_position: attempt.sourceSeconds });
    }

    subtitleAIAction(action: "open" | "cancel" | "dismiss" | "discard"): void {
        const ai = this.active()?.ai;
        if (action === "open") ai?.menuOpened();
        else if (action === "cancel") void ai?.cancel();
        else if (action === "dismiss") ai?.acknowledge();
        else ai?.discardHeld();
    }

    syncSubtitle(key: string): void {
        void this.active()?.sync?.request(key);
    }

    resetSubtitleTiming(key: string): void {
        void this.active()?.sync?.reset(key);
    }

    selectAIResult(id: string): void {
        const attempt = this.changeable();
        const plan = attempt?.plan;
        if (attempt === undefined || plan === undefined || attempt.hidden || attempt.restoring || !attempt.ai?.view?.results.some(result => result.id === id)) return;
        const track = plan.subtitle.inventory.find(track => track.syncKey === `stored-${id}`);
        if (track !== undefined) { this.selectSubtitle(track.trackId); return; }
        // Stored listings omit some rows, so only a fresh plan can supply the result's track identity.
        attempt.pendingAIResult = id;
        this.changeTracks(attempt, plan, chosenTracks(attempt, plan));
    }

    subtitleTool(action: SubtitleToolAction): void {
        const attempt = this.active();
        if (attempt === undefined || !attempt.started || attempt.plan === undefined) return;
        const search = attempt.search;
        const display = attempt.display;
        switch (action.kind) {
            case "search-open": search?.open(); return;
            case "search-language": void search?.pick(action.code); return;
            case "search-back": search?.back(); return;
            case "search-close": search?.close(); return;
            case "search-download": void search?.download(action.key); return;
            case "search-retry": void search?.retry(); return;
            case "delay": void display?.setDelay(action.milliseconds); return;
            case "size": void display?.setSize(action.size); return;
            case "position": void display?.setPosition(action.position); return;
            case "device": void display?.setDeviceOverride(action.enabled); return;
            case "appearance": void display?.setAppearance(action.member, action.value); return;
            default: {
                const unexpected: never = action;
                return unexpected;
            }
        }
    }

    /** Hands a downloaded subtitle to the same selection path as a finished AI result. */
    private attachDownloaded(attempt: Attempt, id: string): boolean {
        const plan = attempt.plan;
        if (!attempt.live || this.attempt !== attempt || plan === undefined || attempt.hidden || attempt.restoring) return false;
        const track = plan.subtitle.inventory.find(entry => entry.syncKey === `stored-${id}`);
        if (track !== undefined) {
            if (!attempt.started || attempt.busy || track.unplayable === true) return false;
            this.selectSubtitle(track.trackId);
            return true;
        }
        if (!attempt.started || attempt.busy) return false;
        attempt.pendingDownloadId = id;
        this.changeTracks(attempt, plan, chosenTracks(attempt, plan));
        return true;
    }

    selectBufferingPrimary(): void {
        this.attempt?.bufferingQuality.selectPrimary();
    }

    selectBufferingKeep(): void {
        this.attempt?.bufferingQuality.selectKeep();
    }

    dismissBufferingPill(): boolean {
        return this.active()?.bufferingQuality.back() ?? false;
    }

    setSkipPillShown(shown: boolean): void {
        const attempt = this.active();
        if (attempt === undefined || attempt.skipPillShown === shown) return;
        attempt.skipPillShown = shown;
        this.syncBuffering(attempt);
    }

    selectQuality(preference: string): void {
        const attempt = this.changeable();
        const plan = attempt?.plan;
        if (attempt === undefined || plan === undefined || preference === attempt.qualityPreference || !qualityChoices(plan).some((choice) => choice.id === preference)) {
            return;
        }
        attempt.attemptedKeys.length = 0;
        attempt.recoveries = 0;
        attempt.busy = true;
        this.clearThumbnails(attempt);
        attempt.change = { state: "changing", kind: "quality" };
        this.showPlayback(attempt);
        const selected = chosenTracks(attempt, plan);
        const offered = plan.availableQualities.find((quality) => quality.label === preference);
        const cap = preference === "auto" ? attempt.autoBandwidthCapKbps
            : offered !== undefined && !offered.preservesSource && offered.bitrateKbps !== undefined && offered.bitrateKbps > 0 ? offered.bitrateKbps : undefined;
        attempt.bufferingQuality.pickSent();
        void this.replan(attempt, plan, "quality_change", attempt.sourceSeconds, undefined, selected, { qualityPreference: preference, bandwidthCapKbps: cap });
    }

    dismissError(): void {
        const error = this.shownError;
        if (error === undefined) {
            return;
        }
        const attempt = this.attempt;
        this.shownError = undefined;
        if (attempt !== undefined && attempt.live) {
            this.leave(attempt, "stop");
        }
        this.attempt = undefined;
        this.show({ phase: "closed" });
        this.deps.exits.onError(error);
    }

    /** Stops playback without an exit callback, for a parent that is tearing the screen down. */
    destroy(): void {
        this.cancelCompletion();
        const attempt = this.attempt;
        if (attempt !== undefined) {
            this.leave(attempt, "stop");
        }
        this.attempt = undefined;
        this.stopAuthority();
        globalThis.removeEventListener?.("online", this.onConnectivity);
        globalThis.removeEventListener?.("offline", this.onConnectivity);
        this.listeners.length = 0;
    }

    // --- planning ---

    private async readSeekIntervals(attempt: Attempt): Promise<boolean> {
        const call = <T>(spec: RequestSpec<T>): Promise<T> => this.deps.session.call({ ...spec, profileScoped: true, signal: attempt.signal });
        let optionalOnly = false;
        try {
            let capability;
            try {
                capability = await call(operations.settingsCapabilities());
            } catch (error) {
                if (error instanceof ApiError && [403, 404, 501].includes(error.status ?? 0)) return attempt.live;
                throw error;
            }
            if (!attempt.live) return false;
            attempt.batchedSettings = capability.supportsBatchedEffective;
            if (capability.apiVersion !== 1 || capability.state !== "available" || !capability.allowed || !capability.scopes.includes("profile")) return true;
            optionalOnly = capability.manifestRevision < 9;
            const contract = await call(operations.settingsContract());
            if (!attempt.live) return false;
            if (contract.apiVersion !== 1 || contract.revision < capability.manifestRevision) throw new Error("Settings contract changed");
            const definitions = profileSettings(contract, capability);
            attempt.promptSupported = definitions.some(def => def.key === NEXT_UP_KEY);
            if (attempt.promptSupported) {
                try {
                    const values = await call(operations.effectiveSettings([NEXT_UP_KEY]));
                    const seconds = values.get(NEXT_UP_KEY)?.value;
                    if (typeof seconds === "number") attempt.promptSeconds = seconds;
                } catch { /* Apple's default remains usable offline. */ }
            }
            for (const key of [INTRO_SKIP_KEY, CREDITS_SKIP_KEY] as const) {
                if (!definitions.some(def => def.key === key)) continue;
                try {
                    const values = await call(operations.effectiveSettings([key]));
                    if (!attempt.live) return false;
                    const value = values.get(key)?.value;
                    if (key === INTRO_SKIP_KEY && (value === "never" || value === "ask" || value === "always")) attempt.introMode = value;
                    if (key === CREDITS_SKIP_KEY) attempt.skipCredits = value === true;
                } catch { /* Unavailable optional preferences retain manual skipping. */ }
            }
            if (definitions.some(def => def.key === BUFFERING_MODE_KEY)) {
                try {
                    const mode = (await call(operations.effectiveSettings([BUFFERING_MODE_KEY]))).get(BUFFERING_MODE_KEY)?.value;
                    if (mode === "never" || mode === "ask" || mode === "always") {
                        attempt.bufferingMode = mode;
                        this.lastBufferingMode = mode;
                    }
                } catch { /* The last mode read, else Apple's default (always), stands where the mode cannot be read. */ }
                if (!attempt.live) return false;
            }
            if (definitions.some(def => def.key === AUTO_NEXT_KEY)) {
                attempt.autoNextSupported = true;
                const epoch = attempt.settingsEpoch;
                try {
                    const values = await call(operations.effectiveSettings([AUTO_NEXT_KEY]));
                    if (attempt.live && epoch === attempt.settingsEpoch) attempt.autoNext = values.get(AUTO_NEXT_KEY)?.value === true;
                } catch { /* Unavailable autoplay preferences leave Play next manual. */ }
            }
            if (definitions.some(def => def.key === HDR_KEY)) {
                try {
                    const values = await call(operations.effectiveSettings([HDR_KEY]));
                    if (!attempt.live) return false;
                    attempt.hdrEnabled = values.get(HDR_KEY)?.value === true;
                } catch {
                    if (!attempt.live) return false;
                    attempt.hdrEnabled = false;
                }
            }
            if (!SEEK_KEYS.every(key => definitions.some(def => def.key === key))) return true;
            const values = await Promise.all((capability.supportsBatchedEffective ? [SEEK_KEYS] : SEEK_KEYS.map(key => [key])).map(keys => call(operations.effectiveSettings(keys))));
            if (!attempt.live) return false;
            const effective = new Map(values.flatMap(values => [...values]));
            const backward = effective.get(SEEK_BACK_KEY)?.value;
            const forward = effective.get(SEEK_FORWARD_KEY)?.value;
            if (typeof backward !== "number" || typeof forward !== "number") throw new Error("Missing seek intervals");
            attempt.seekIntervals = { backward, forward };
            return true;
        } catch {
            if (optionalOnly) return attempt.live;
            if (attempt.live) this.fail(attempt, { kind: "settings" }, false);
            return false;
        }
    }

    /**
     * The highest stored reading still current on this server and network, as Apple's start sends it.
     * Never a probe or a read: with no reading, on a metered link or on a server without a speed test it is absent.
     */
    private features(attempt: Attempt): readonly string[] {
        return clientFeatures(attempt.renditionsAll, attempt.bufferingAdvertised);
    }

    /** `ignore` keeps a limit another profile on this TV learned from lowering plans while the viewer has the feature off. */
    private learnedLimit(attempt: Attempt): { readonly learned_limit: "ignore" } | Record<string, never> {
        return attempt.bufferingAdvertised && attempt.bufferingMode === "never" ? { learned_limit: "ignore" } : {};
    }

    /** As Apple's start: the probe estimate names its source, and only to a server that takes sources. */
    private startBufferingMembers(attempt: Attempt, hasEstimate: boolean): Pick<StartPlaybackBody, "bandwidth_estimate_source" | "learned_limit"> {
        return { ...(attempt.bufferingAdvertised && hasEstimate ? { bandwidth_estimate_source: "probe" as const } : {}), ...this.learnedLimit(attempt) };
    }

    /**
     * The buffering members of a replan. The controller's own replan carries its estimate, source,
     * learned limit and observed throughput; the player's other replans repeat a kept estimate so a
     * lowering holds. Source and limit go only to a server that advertises the feature.
     */
    private replanBufferingMembers(attempt: Attempt, operation: ReplanOperation, request: ReplanRequest | undefined): Pick<ReplanPlaybackBody, "bandwidth_estimate_kbps" | "bandwidth_estimate_source" | "learned_limit" | "observed_throughput_kbps"> {
        const estimate = request !== undefined ? request.bandwidthEstimateKbps : operation === "quality_change" ? undefined : attempt.bufferingQuality.clientReplan(operation)?.bandwidthEstimateKbps;
        const limit = request?.learnedLimit ?? this.learnedLimit(attempt).learned_limit;
        const advertised = attempt.bufferingAdvertised;
        const source = advertised && estimate !== undefined ? request?.bandwidthEstimateSource : undefined;
        return {
            ...(estimate === undefined ? {} : { bandwidth_estimate_kbps: estimate }),
            ...(source === undefined ? {} : { bandwidth_estimate_source: source }),
            ...(advertised && limit !== undefined ? { learned_limit: limit } : {}),
            ...(source !== undefined && request?.observedThroughputKbps !== undefined ? { observed_throughput_kbps: request.observedThroughputKbps } : {}),
        };
    }

    /** The buffering controller's `quality_change`, sent like the viewer's switch but recorded as nobody's pick. */
    private issueBufferingReplan(bridge: BufferingBridge, request: ReplanRequest, restore: boolean): boolean {
        const live = this.active();
        if (live === undefined || live.bufferingQuality !== bridge) return false;
        const attempt = this.changeable();
        const plan = attempt?.plan;
        if (attempt === undefined || plan === undefined || attempt.recovery?.active === true || attempt.hidden || attempt.restoring) {
            // Restore quality is the viewer's answer: it goes out once the replan or reload in flight settles.
            if (restore) {
                live.bufferingRestore = request;
                return true;
            }
            return false;
        }
        const offered = plan.availableQualities.find((quality) => quality.label === request.qualityPreference);
        const cap = request.qualityPreference === AUTO_QUALITY ? attempt.autoBandwidthCapKbps
            : offered !== undefined && !offered.preservesSource && offered.bitrateKbps !== undefined && offered.bitrateKbps > 0 ? offered.bitrateKbps : undefined;
        attempt.attemptedKeys.length = 0;
        attempt.recoveries = 0;
        attempt.busy = true;
        this.clearThumbnails(attempt);
        attempt.change = { state: "changing", kind: "quality" };
        this.showPlayback(attempt);
        void this.replan(attempt, plan, "quality_change", attempt.sourceSeconds, undefined, chosenTracks(attempt, plan), { qualityPreference: request.qualityPreference, bandwidthCapKbps: cap }, request);
        return true;
    }

    private bufferingChanged(bridge: BufferingBridge): void {
        const attempt = this.attempt;
        if (attempt === undefined || !attempt.live || attempt.bufferingQuality !== bridge) return;
        if (this.base.phase === "loading" || this.base.phase === "playing" || this.base.phase === "paused") this.show(this.base);
    }

    /** Hands the buffering controller whatever the playback facts changed. */
    private syncBuffering(attempt: Attempt): void {
        const online = currentNetwork().online;
        const snapshot: BufferingSnapshot = {
            hasActiveLoad: attempt.plan !== undefined,
            wantsToPlay: !attempt.paused,
            // A suspended transport that has not been resumed is a reload, whatever AVPlay reports meanwhile.
            started: attempt.started && !attempt.suspended && !attempt.suspendedReady,
            buffering: attempt.buffering,
            // A replan that reloads the stream is a reload; any other busy time is a seek, local or re-anchored.
            seekInFlight: attempt.busy && attempt.change.state !== "changing" && !attempt.reporting,
            reloadInProgress: attempt.restoring || attempt.suspended || attempt.suspendedReady || attempt.resuming || attempt.recovery?.active === true || (attempt.busy && (attempt.change.state === "changing" || attempt.reporting)),
            reachedEnd: this.completion !== undefined || attempt.endedDuringChange,
            playheadMs: Math.round(attempt.sourceSeconds * 1000),
            suspended: attempt.hidden,
            connectionTrouble: !online || attempt.recovery?.active === true,
        };
        attempt.bufferingQuality.setCompetingPill(attempt.prompt !== undefined || attempt.hidden || attempt.skipPillShown);
        attempt.bufferingQuality.sync(snapshot);
        const restore = attempt.bufferingRestore;
        if (restore !== undefined && this.changeable() === attempt && attempt.recovery?.active !== true) {
            attempt.bufferingRestore = undefined;
            this.issueBufferingReplan(attempt.bufferingQuality, restore, true);
        }
    }

    private storedEstimateKbps(capabilities: PlaybackCapabilities): number | undefined {
        if (!capabilities.features.includes(CONNECTION_SPEED_FEATURE) || capabilities.bandwidthProbeUrl === undefined) return undefined;
        const network = currentNetwork();
        if (!network.online || network.metered) return undefined;
        return bandwidthReadings.freshEstimateKbps(
            readingsKey(this.deps.session.http.base.baseUrl, this.deps.session.account?.id, network.transport),
            this.deps.clock.now(),
            capabilities.bandwidthProbeMaxAgeSeconds ?? FALLBACK_MAX_AGE_SECONDS,
        );
    }

    private reportedPlayback(attempt: Attempt): Pick<StartPlaybackBody, "client_capabilities" | "client_playback_context"> {
        const report = { panel: attempt.hdrPanel, preference: { hdrEnabled: attempt.hdrEnabled } };
        return {
            client_capabilities: clientCapabilities(report),
            client_playback_context: playbackContext(this.deps.device.model, this.deps.device.appVersion, report),
        };
    }

    private async begin(attempt: Attempt): Promise<void> {
        attempt.hdrPanel = probeHdrPanel(this.deps.device.hdrProbeScope);
        const session = this.deps.session;
        let decision: PlaybackDecision;
        try {
            const capabilities = await session.call({ ...operations.playbackCapabilities(), profileScoped: true, signal: attempt.signal });
            const profile = session.activeProfile;
            if (!attempt.live) {
                return;
            }
            const installationId = capabilities.installationId;
            if (
                capabilities.state !== "available" ||
                !capabilities.allowed ||
                capabilities.protocolVersions.indexOf(3) === -1 ||
                installationId === undefined ||
                profile === undefined
            ) {
                this.fail(attempt, { kind: "unavailable" }, false);
                return;
            }
            attempt.installationId = installationId;
            attempt.profileId = profile.id;
            attempt.trickplayEnabled = capabilities.features.includes("trickplay_v1");
            attempt.renditionsAll = capabilities.features.includes(HLS_SUBTITLE_RENDITIONS_ALL_FEATURE);
            attempt.bufferingAdvertised = capabilities.features.includes(BUFFERING_QUALITY_FEATURE);
            if (!await this.readSeekIntervals(attempt)) return;
            const defaults = attempt.batchedSettings
                ? await session.call({ ...operations.playbackDefaults(), profileScoped: true, signal: attempt.signal })
                : await Promise.all([
                    session.call({ ...operations.playbackDefaults([QUALITY_KEY]), profileScoped: true, signal: attempt.signal }),
                    session.call({ ...operations.playbackDefaults([BITRATE_KEY]), profileScoped: true, signal: attempt.signal }),
                ]).then(([quality, cap]) => ({ qualityPreference: quality.qualityPreference, bandwidthCapKbps: cap.bandwidthCapKbps }));
            if (!attempt.live) {
                return;
            }
            attempt.qualityPreference = defaults.qualityPreference;
            attempt.bandwidthCapKbps = defaults.bandwidthCapKbps;
            attempt.autoBandwidthCapKbps = defaults.bandwidthCapKbps;
            const estimateKbps = this.storedEstimateKbps(capabilities);
            const start = operations.startPlayback({
                installation_id: installationId,
                protocol_version: 3,
                client_features: this.features(attempt),
                file_id: attempt.request.fileId,
                profile_id: profile.id,
                playback_attempt_id: attempt.playbackAttemptId,
                quality_preference: attempt.qualityPreference,
                ...(attempt.bandwidthCapKbps === undefined ? {} : { bandwidth_cap_kbps: attempt.bandwidthCapKbps }),
                ...(estimateKbps === undefined ? {} : { bandwidth_estimate_kbps: estimateKbps }),
                ...this.startBufferingMembers(attempt, estimateKbps !== undefined),
                subtitle_fidelity_preference: "compatible",
                ...(attempt.request.startSeconds === undefined ? {} : { start_position: attempt.request.startSeconds }),
                ...(attempt.request.audioTrackId === undefined ? {} : { audio_track_id: attempt.request.audioTrackId }),
                ...subtitleStart(attempt.request),
                ...(attempt.request.allowAlternateVersions === undefined ? {} : { allow_alternate_versions: attempt.request.allowAlternateVersions }),
                ...this.reportedPlayback(attempt),
            });
            // Back does not abort the start: its answer names the session that must then be stopped.
            decision = await this.resend(attempt, () => session.call({ ...start, profileScoped: true, signal: attempt.signal }));
        } catch (error) {
            if (attempt.live) {
                this.fail(attempt, startFailure(error), false);
            }
            return;
        }
        if (decision.outcome !== "playable") {
            if (attempt.live) {
                this.fail(attempt, decisionFailure(decision), false);
            }
            return;
        }
        attempt.sessionId = decision.sessionId;
        if (!attempt.live) {
            void this.stopSession(attempt).catch(() => undefined);
            return;
        }
        this.scheduleProgress(attempt);
        await this.startSubtitles(attempt, decision.plan, decision.serverFeatures);
    }

    /** The watch read Apple takes its subtitle policy and display-order language from; the language is kept for the track list. */
    private async readSubtitlePreferences(attempt: Attempt, plan: PlaybackPlan): Promise<SubtitlePreferences> {
        const preferences = await this.deps.session.call({ ...operations.preplaySubtitlePreferences(attempt.request.contentId, plan.effectiveMediaFileId, plan.selectedTracks.audio?.id), profileScoped: true, signal: attempt.signal });
        if (attempt.live && attempt.orderingLanguage !== preferences.language) {
            attempt.orderingLanguage = preferences.language;
            this.showPlayback(attempt);
        }
        return preferences;
    }

    private async startSubtitles(attempt: Attempt, plan: PlaybackPlan, serverFeatures: readonly string[]): Promise<void> {
        attempt.sourceSeconds = plan.timeline.sourceStartSeconds;
        if (attempt.request.allowAlternateVersions === false && plan.effectiveMediaFileId !== attempt.request.fileId) {
            this.fail(attempt, { kind: "terminal", reason: "version_unavailable", message: "The selected version is no longer available. Choose another version in Details.", retryable: false }, true);
            return;
        }
        // Apple resolves Auto at every start, so a start with no choice (Home, next episode, Up Next) follows the profile too.
        const implicit = attempt.request.subtitle === undefined;
        const intent = playableIntent(attempt.request.subtitle ?? { kind: "auto" }, plan.subtitle.inventory);
        try {
            if (intent.kind !== "auto") void this.readSubtitlePreferences(attempt, plan).catch(() => undefined);
            let preferences: SubtitlePreferences | undefined;
            if (intent.kind === "auto") {
                try {
                    preferences = await this.readSubtitlePreferences(attempt, plan);
                } catch (error) {
                    if (!implicit) throw error;
                    // No policy to apply: the plan's own default stands, as before this client resolved implicit starts.
                    if (attempt.live) this.adopt(attempt, plan, serverFeatures);
                    return;
                }
            }
            if (!attempt.live) return;
            const subtitle = initialSubtitle(intent, plan.subtitle.inventory, preferences, startingDefault(attempt.request, plan) ?? plan.subtitle.trackId);
            if (subtitle === plan.subtitle.trackId) this.adopt(attempt, plan, serverFeatures);
            else this.changeTracks(attempt, plan, { ...(plan.selectedTracks.audio === undefined ? {} : { audio: plan.selectedTracks.audio }), ...(subtitle === undefined ? {} : { subtitle: { id: subtitle } }) });
        } catch {
            const message = intent.kind === "track" ? "The selected subtitles are unavailable on this version. Choose another track in Details." : "Could not read subtitle preferences. Return to Details to retry or choose Off.";
            if (attempt.live) this.fail(attempt, { kind: "terminal", reason: "subtitle_selection_unavailable", message, retryable: false }, true);
        }
    }

    private async replan(
        attempt: Attempt,
        plan: PlaybackPlan,
        operation: ReplanOperation,
        positionSeconds: number,
        classification: string | undefined,
        selected: SelectedTracks = chosenTracks(attempt, plan),
        quality: PlaybackDefaults = attempt,
        buffering?: ReplanRequest,
    ): Promise<void> {
        const sessionId = attempt.sessionId;
        const installationId = attempt.installationId;
        if (sessionId === undefined || installationId === undefined) {
            return;
        }
        const transport = this.transport;
        const current = (): boolean => attempt.live && attempt.sessionId === sessionId && this.transport === transport;
        const replan = operations.replanPlayback(sessionId, {
            installation_id: installationId,
            protocol_version: 3,
            client_features: this.features(attempt),
            operation,
            playback_attempt_id: attempt.playbackAttemptId,
            replan_request_id: this.newId(),
            failed_plan_id: plan.planId,
            plan_attempt_id: attempt.planAttemptId,
            plan_attempt_key: plan.planAttemptKey,
            attempted_plan_keys: attempt.attemptedKeys.slice(),
            attempt_count: Math.max(1, attempt.recoveries),
            quality_preference: quality.qualityPreference,
            ...(quality.bandwidthCapKbps === undefined ? {} : { bandwidth_cap_kbps: quality.bandwidthCapKbps }),
            ...this.replanBufferingMembers(attempt, operation, buffering),
            position_seconds: positionSeconds,
            selected_tracks: selected,
            ...(classification === undefined ? {} : { failure: { classification } }),
            ...this.reportedPlayback(attempt),
        });
        let decision: PlaybackDecision;
        try {
            decision = await this.resend(attempt, () => {
                if (!current()) throw abortedError();
                return this.deps.session.call({ ...replan, profileScoped: true, signal: attempt.signal });
            });
        } catch (error) {
            this.qualityUnsettled(attempt, buffering);
            if (!current()) {
                return;
            }
            if (buffering !== undefined && !sessionGone(error)) {
                // Apple keeps the current plan only when the server answered with a refusal.
                if (rejectedReplan(error)) {
                    this.keepPlaying(attempt);
                    return;
                }
                // A lost or unusable answer cannot prove the server kept the old plan, so reconnect and play the one it holds, as Apple does.
                if (attempt.presented) {
                    attempt.change = { state: "idle" };
                    this.recoverConnection(attempt);
                    return;
                }
            }
            if (operation === "track_change" && (attempt.plan === undefined || (!attempt.started && attempt.nativeSubtitleUnavailable))) {
                this.fail(attempt, startFailure(error), true);
                return;
            }
            if ((operation === "track_change" || operation === "quality_change") && unanswered(error) && attempt.presented
                && (attempt.recovery?.active === true || (error instanceof ApiError && error.transient))) {
                if (attempt.reporting) this.restoreReportedSubtitle(attempt);
                attempt.change = { state: "failed" };
                attempt.busy = false;
                attempt.reporting = false;
                this.recoverConnection(attempt);
                return;
            }
            // A missing or unusable answer cannot prove that the server rolled the change back.
            if (operation === "track_change" && error instanceof ApiError && !error.transient && error.failure.kind !== "invalid_response" && !sessionGone(error)) {
                if (attempt.reporting) this.restoreReportedSubtitle(attempt);
                this.changeSettled(attempt, { state: "failed" });
                return;
            }
            if (operation === "failure_recovery" && unanswered(error) && attempt.presented && this.shownError === undefined) {
                this.releaseFailedRoute(attempt);
                if (attempt.recovery?.active === true) this.noteTransportUnanswered(attempt);
                else this.recoverConnection(attempt);
                return;
            }
            this.sessionFailure(attempt, error);
            return;
        }
        if (!current()) {
            return;
        }
        if ((operation === "track_change" || operation === "quality_change") && decision.outcome === "adaptation_unavailable") {
            this.qualityUnsettled(attempt, buffering);
            if (buffering !== undefined) {
                this.keepPlaying(attempt);
                return;
            }
            if (attempt.plan === undefined || (!attempt.started && attempt.nativeSubtitleUnavailable)) { this.fail(attempt, decisionFailure(decision), true); return; }
            // The server rolled the change back; the current plan and transport keep playing.
            if (attempt.reporting) this.restoreReportedSubtitle(attempt);
            this.changeSettled(attempt, { state: "refused", message: decision.terminal.message });
            return;
        }
        attempt.busy = false;
        if (decision.outcome === "playable") {
            if (decision.sessionId !== sessionId) {
                this.fail(attempt, { kind: "server" }, true);
                return;
            }
            if (attempt.plan === undefined && operation === "track_change" && decision.plan.effectiveMediaFileId !== plan.effectiveMediaFileId) {
                this.fail(attempt, { kind: "server" }, true);
                return;
            }
            if (attempt.plan === undefined && operation === "track_change" && (selectedSubtitle(decision.plan) !== selected.subtitle?.id || decision.plan.subtitle.mode === "unknown")) {
                this.fail(attempt, { kind: "terminal", reason: "subtitle_selection_unavailable", message: "The selected subtitles are no longer available. Choose another track in Details.", retryable: false }, true);
                return;
            }
            if (operation === "quality_change") {
                attempt.qualityPreference = quality.qualityPreference;
                attempt.bandwidthCapKbps = quality.bandwidthCapKbps;
                // The buffering controller's lowering is nobody's pick; a viewer's pick resets what it decided.
                if (buffering === undefined) {
                    attempt.qualityPicked = true;
                    attempt.bufferingQuality.qualityChanged();
                }
            }
            if (attempt.reporting) {
                this.finishSubtitleReport(attempt, decision.plan, decision.serverFeatures, selected);
                return;
            }
            if (operation === "track_change" && attempt.plan !== undefined && sameDirectTransport(attempt.plan, decision.plan, selected)) {
                this.applyKeptSubtitle(attempt, decision.plan, decision.serverFeatures);
                return;
            }
            this.adopt(attempt, decision.plan, decision.serverFeatures, buffering !== undefined);
        } else {
            this.qualityUnsettled(attempt, buffering);
            if (buffering !== undefined) {
                this.keepPlaying(attempt);
                return;
            }
            this.fail(attempt, decisionFailure(decision), true);
        }
    }

    /** The buffering controller's replan did not become a plan: the transport that was playing keeps playing. */
    private keepPlaying(attempt: Attempt): void {
        attempt.busy = false;
        attempt.change = { state: "idle" };
        this.showPlayback(attempt);
    }

    /** A quality change did not become a plan: the controller hears that its own replan failed, or that the viewer's pick did. */
    private qualityUnsettled(attempt: Attempt, buffering: ReplanRequest | undefined): void {
        if (buffering === undefined) attempt.bufferingQuality.pickRefused();
        else attempt.bufferingQuality.replanFailed();
    }

    /** A codec or route failure on this TV: the server picks the next route, a bounded number of times. */
    private routeFailed(attempt: Attempt, classification: string): void {
        attempt.queuedSeekSeconds = undefined;
        attempt.queuedSkips = undefined;
        attempt.pendingSkipUndo = undefined;
        const plan = attempt.plan;
        if (!attempt.live || plan === undefined) {
            return;
        }
        if (attempt.busy) {
            if (attempt.change.state === "changing" || attempt.reporting) {
                attempt.changeFailure = attempt.changeFailure ?? classification;
            } else if (this.pending.seek !== undefined && attempt.seekFailure === undefined) {
                attempt.seekFailure = classification;
                this.show({ phase: "loading", title: attempt.request.title });
            }
            return;
        }
        this.closeTransport();
        if (attempt.recoveries >= MAX_RECOVERY_REPLANS) {
            this.fail(attempt, { kind: "playback_failed" }, true);
            return;
        }
        attempt.recoveries++;
        if (attempt.attemptedKeys.indexOf(plan.planAttemptKey) === -1) {
            attempt.attemptedKeys.push(plan.planAttemptKey);
        }
        attempt.busy = true;
        this.show({ phase: "loading", title: attempt.request.title });
        this.clearThumbnails(attempt);
        void this.replan(attempt, plan, "failure_recovery", attempt.sourceSeconds, classification);
    }

    // --- tracks ---

    /** The attempt, when nothing else is in flight: a pending seek or change makes a choice wait. */
    private changeable(): Attempt | undefined {
        const attempt = this.active();
        return attempt !== undefined && attempt.started && !attempt.busy ? attempt : undefined;
    }

    private reportSubtitle(attempt: Attempt, plan: PlaybackPlan, trackId: string | undefined, previous: string | undefined): void {
        attempt.subtitleRestore = { id: previous };
        attempt.pendingSubtitle = undefined;
        attempt.reporting = true;
        attempt.busy = true;
        const audio = plan.selectedTracks.audio;
        const selected = { ...(audio === undefined ? {} : { audio }), ...(trackId === undefined ? {} : { subtitle: { id: trackId } }) };
        void this.replan(attempt, plan, "track_change", attempt.sourceSeconds, undefined, selected);
    }

    /** The first answer must not paint over a newer local pick. A kept HLS stream is not reopened. */
    private finishSubtitleReport(attempt: Attempt, next: PlaybackPlan, serverFeatures: readonly string[], reported: SelectedTracks): void {
        const pending = attempt.pendingSubtitle;
        const current = attempt.plan;
        const reportedId = reported.subtitle?.id;
        const kept = current !== undefined && keepsHlsTransport(current, next);
        if (pending !== undefined && (pending.id !== reportedId || !pending.applied)) {
            attempt.pendingSubtitle = undefined;
            if (!kept || attempt.endedDuringChange) {
                attempt.reporting = false;
                attempt.subtitleOverride = undefined;
                attempt.queuedSubtitle = pending;
                if (attempt.endedDuringChange) {
                    this.beginCompletion(attempt);
                    return;
                }
                this.adopt(attempt, next, serverFeatures);
                return;
            }
            this.rememberKeptPlan(attempt, next, serverFeatures);
            if (!pending.applied || !renditionSwitch(next, pending.id)) {
                attempt.reporting = false;
                attempt.subtitleOverride = undefined;
                if (!this.applyStreamSubtitle(attempt, selectedSubtitle(next))) {
                    attempt.queuedSubtitle = pending;
                    this.adopt(attempt, next, serverFeatures);
                    return;
                }
                attempt.busy = false;
                this.selectSubtitle(pending.id);
                return;
            }
            attempt.subtitleRestore = { id: selectedSubtitle(next) };
            attempt.subtitleOverride = pending;
            const audio = (attempt.plan ?? next).selectedTracks.audio;
            const selected = { ...(audio === undefined ? {} : { audio }), ...(pending.id === undefined ? {} : { subtitle: { id: pending.id } }) };
            attempt.busy = true;
            void this.replan(attempt, attempt.plan ?? next, "track_change", attempt.sourceSeconds, undefined, selected);
            this.showPlayback(attempt);
            return;
        }
        attempt.pendingSubtitle = undefined;
        attempt.reporting = false;
        attempt.subtitleRestore = undefined;
        if (attempt.endedDuringChange && !kept) {
            attempt.subtitleOverride = undefined;
            this.beginCompletion(attempt);
            return;
        }
        if (kept && streamRenditionAnswer(next, attempt.subtitleOverride?.id ?? reportedId)) {
            this.rememberKeptPlan(attempt, next, serverFeatures);
            attempt.subtitleOverride = undefined;
            this.changeSettled(attempt, { state: "idle" });
            return;
        }
        if (current !== undefined && sameDirectTransport(current, next, reported)) {
            this.applyKeptSubtitle(attempt, next, serverFeatures);
            return;
        }
        attempt.subtitleOverride = undefined;
        this.adopt(attempt, next, serverFeatures);
    }

    /** The picture is already the plan's stream. Load the sidecar, or clear it, and leave AVPlay open. */
    private applyKeptSubtitle(attempt: Attempt, next: PlaybackPlan, serverFeatures: readonly string[]): void {
        try { this.deps.avplay.setSilentSubtitle?.(true); } catch { /* The HTML overlay draws the sidecar. */ }
        this.rememberKeptPlan(attempt, next, serverFeatures);
        attempt.subtitleOverride = undefined;
        attempt.subtitleRestore = undefined;
        this.changeSettled(attempt, { state: "idle" });
    }

    private rememberKeptPlan(attempt: Attempt, plan: PlaybackPlan, serverFeatures: readonly string[]): void {
        const seconds = attempt.sourceSeconds;
        const started = attempt.started;
        const presented = attempt.presented;
        this.readCaptions(attempt, plan);
        attempt.plan = plan;
        // A subtitle the kept stream gained (a download, an AI result) needs its sync state too.
        this.adoptSync(attempt, plan);
        attempt.hud.read(this.deps.session, attempt.request.contentId, plan.effectiveMediaFileId, attempt.signal, () => this.showPlayback(attempt));
        attempt.serverFeatures = serverFeatures;
        attempt.planAttemptId = this.newId();
        attempt.sourceSeconds = seconds;
        attempt.started = started;
        attempt.presented = presented;
    }

    private restoreReportedSubtitle(attempt: Attempt): void {
        const restore = attempt.subtitleRestore;
        attempt.reporting = false;
        attempt.subtitleRestore = undefined;
        attempt.subtitleOverride = restore;
        if (restore !== undefined && !this.applyStreamSubtitle(attempt, restore.id) && attempt.plan?.subtitle.artifact !== undefined) {
            try { this.deps.avplay.setSilentSubtitle?.(true); } catch { /* Sidecar captions remain independent of native rendering. */ }
            this.readCaptions(attempt, attempt.plan);
        }
    }

    /**
     * Selects an embedded text row on the open AVPlay stream. Off silences a rendition stream.
     * A miss leaves the caller to replan. A same-URL direct-play sidecar stays open; a new URL or burn-in reopens.
     */
    private applyStreamSubtitle(attempt: Attempt, trackId: string | undefined): boolean {
        const plan = attempt.plan;
        const avplay = this.deps.avplay;
        if (plan === undefined || avplay.getTotalTrackInfo === undefined || avplay.setSelectTrack === undefined || avplay.setSilentSubtitle === undefined) return false;
        if (trackId === undefined) {
            if (!renditionSwitch(plan, undefined)) return false;
            try {
                avplay.setSilentSubtitle(true);
                attempt.captionAbort?.abort();
                this.clearSecondary(attempt);
                attempt.captionKey = undefined;
                attempt.cues = [];
                attempt.captionNotice = "";
                return true;
            } catch {
                return false;
            }
        }
        const row = plan.subtitle.inventory.find((entry) => entry.trackId === trackId);
        if (row === undefined || !inStreamCandidate(plan, row)) return false;
        let tracks: readonly AVPlayTrackInfo[];
        try {
            tracks = avplay.getTotalTrackInfo();
        } catch {
            return false;
        }
        const index = textTrackIndex(tracks, row, plan.delivery === "original_http");
        if (index === undefined) return false;
        try {
            avplay.setSelectTrack("TEXT", index);
            attempt.captionAbort?.abort();
            this.clearSecondary(attempt);
            attempt.captionKey = undefined;
            attempt.cues = [];
            attempt.captionNotice = "";
            return true;
        } catch {
            return false;
        }
    }

    /**
     * client_selected_audio_track_v1: the plan's audio index is an ordinal in the server's audio_tracks,
     * the source's probed order, so it is the nth AUDIO row of the original file. Call right after play():
     * AVPlay switches AUDIO only in PLAYING. False, a failed route, whenever the stream cannot show
     * or play that row: the claim promises the ordinal, so the server must be told to package instead.
     */
    private selectPlanAudio(plan: PlaybackPlan): boolean {
        const ordinal = plan.selectedTracks.audio?.index;
        const avplay = this.deps.avplay;
        if (plan.delivery !== "original_http" || plan.selectedTracks.audio === undefined) return true;
        // The id alone is opaque: without the ordinal this client cannot honor the selection.
        if (ordinal === undefined || avplay.getTotalTrackInfo === undefined || avplay.setSelectTrack === undefined) return false;
        try {
            const target = avplay.getTotalTrackInfo().filter((track) => track.type === "AUDIO")[ordinal];
            if (target === undefined) return false;
            const playing = avplay.getCurrentStreamInfo?.().find((track) => track.type === "AUDIO");
            if (playing?.index !== target.index) avplay.setSelectTrack("AUDIO", target.index);
            return true;
        } catch {
            return false;
        }
    }

    private alignOpenStream(attempt: Attempt, plan: PlaybackPlan): boolean {
        this.applyCaptionFallback(attempt, plan);
        if (plan.subtitle.mode === "off" || plan.subtitle.mode === "burn_in" || plan.subtitle.mode === "unknown" || plan.subtitle.artifact !== undefined) return true;
        const id = shownSubtitle(attempt, plan);
        if (id === undefined) return true;
        const row = plan.subtitle.inventory.find((entry) => entry.trackId === id);
        if (row !== undefined && inStreamCandidate(plan, row) && this.applyStreamSubtitle(attempt, id)) return true;
        if (plan.delivery !== "original_http" || attempt.nativeSubtitleUnavailable) {
            this.fail(attempt, { kind: "playback_failed" }, true);
            return false;
        }
        attempt.nativeSubtitleUnavailable = true;
        this.closeTransport();
        attempt.started = false;
        this.showLoading(attempt, undefined);
        void this.replan(attempt, plan, "track_change", attempt.sourceSeconds, undefined, plan.selectedTracks);
        return false;
    }

    private changeTracks(attempt: Attempt, plan: PlaybackPlan, selected: SelectedTracks): void {
        this.clearThumbnails(attempt);
        attempt.busy = true;
        attempt.change = { state: "changing" };
        this.showPlayback(attempt);
        void this.replan(attempt, plan, "track_change", attempt.sourceSeconds, undefined, selected);
    }

    private changeSettled(attempt: Attempt, change: TrackChange): void {
        // A kept picture never reaches prepare, where a refreshed inventory used to be read.
        const keptInventory = change.state === "idle" && !attempt.endedDuringChange;
        const resolveCompletedSubtitle = keptInventory && attempt.pendingAIResult !== undefined;
        const resolveDownloadedSubtitle = keptInventory && attempt.pendingDownloadId !== undefined;
        if (attempt.pendingAIResult !== undefined && !resolveCompletedSubtitle) {
            attempt.pendingAIResult = undefined;
            attempt.ai?.notice("Could not load the completed subtitle track. Playback continues; select it again to retry.");
        }
        if (attempt.pendingDownloadId !== undefined && !resolveDownloadedSubtitle) {
            attempt.pendingDownloadId = undefined;
            attempt.search?.reportUnselected();
        }
        attempt.busy = false;
        attempt.change = change;
        if (attempt.endedDuringChange) {
            this.beginCompletion(attempt);
            return;
        }
        this.showPlayback(attempt);
        const failure = attempt.changeFailure;
        attempt.changeFailure = undefined;
        if (failure !== undefined) {
            this.routeFailed(attempt, failure);
        } else if (attempt.pendingSubtitle !== undefined) {
            const pending = attempt.pendingSubtitle;
            attempt.pendingSubtitle = undefined;
            this.selectSubtitle(pending.id);
        }
        if (failure === undefined && (resolveCompletedSubtitle || resolveDownloadedSubtitle) && attempt.plan !== undefined && !attempt.busy) {
            this.applyPreparedSubtitleChoices(attempt, attempt.plan);
        }
    }

    private readTracks(attempt: Attempt): void {
        const read = ++attempt.trackRead;
        attempt.tracks = { state: "loading" };
        const spec = operations.catalogItemVersions(attempt.request.contentId);
        this.deps.session.call({ ...spec, profileScoped: true, signal: attempt.signal }).then(
            (versions) => {
                if (attempt.trackRead === read) {
                    attempt.tracks = { state: "ready", versions };
                    this.showPlayback(attempt);
                }
            },
            () => {
                if (attempt.trackRead === read) {
                    attempt.tracks = { state: "failed" };
                    this.showPlayback(attempt);
                }
            },
        );
    }

    // --- transport ---

    private adopt(attempt: Attempt, plan: PlaybackPlan, serverFeatures: readonly string[], bufferingReplan = false): void {
        this.clearThumbnails(attempt);
        this.readCaptions(attempt, plan);
        attempt.plan = plan;
        // The new stream has not started: what the old one reported must not reach the buffering controller while this adoption redraws.
        attempt.started = false;
        attempt.buffering = false;
        attempt.hud.read(this.deps.session, attempt.request.contentId, plan.effectiveMediaFileId, attempt.signal, () => this.showPlayback(attempt));
        if (attempt.ai?.fileId !== plan.effectiveMediaFileId) {
            attempt.ai?.destroy();
            attempt.ai = new SubtitleAI(this.deps.session, this.deps.clock, plan.effectiveMediaFileId, () => this.showPlayback(attempt), attempt.aiBlockedFiles);
            attempt.pendingAIResult = undefined;
        }
        if (attempt.search?.fileId !== plan.effectiveMediaFileId) {
            attempt.search?.destroy();
            attempt.pendingDownloadId = undefined;
            attempt.search = new SubtitleSearch(this.deps.session, plan.effectiveMediaFileId, id => this.attachDownloaded(attempt, id), () => this.showPlayback(attempt));
            void attempt.search.refresh();
        }
        this.adoptSync(attempt, plan);
        if (attempt.display === undefined && attempt.profileId !== undefined) {
            const profileId = attempt.profileId;
            attempt.display = new SubtitleDisplay(this.deps.session, profileId, (appearance, sync) => {
                attempt.appearance = appearance;
                attempt.subtitleSync = sync;
                this.showPlayback(attempt);
            }, () => this.showPlayback(attempt), this.deps.publicStorage);
            void attempt.display.load();
        }
        attempt.display?.adopt(attempt.appearance, attempt.subtitleSync);
        this.readMarkers(attempt, plan.effectiveMediaFileId);
        attempt.serverFeatures = serverFeatures;
        attempt.subtitleOverride = undefined;
        attempt.subtitleRestore = undefined;
        attempt.reporting = false;
        attempt.queuedSubtitle = attempt.pendingSubtitle ?? attempt.queuedSubtitle;
        attempt.pendingSubtitle = undefined;
        attempt.recoverySpec = undefined;
        attempt.recoveryRetryAt = 0;
        attempt.change = { state: "idle" };
        attempt.busy = false;
        attempt.seekFailure = undefined;
        attempt.changeFailure = undefined;
        attempt.endedDuringChange = false;
        if (attempt.tracks === undefined) {
            this.readTracks(attempt);
        }
        attempt.planAttemptId = this.newId();
        attempt.sourceSeconds = plan.timeline.sourceStartSeconds;
        attempt.started = false;
        attempt.bufferingAdvertised = serverFeatures.includes(BUFFERING_QUALITY_FEATURE);
        attempt.bufferingQuality.advertised = attempt.bufferingAdvertised;
        attempt.bufferingQuality.mode = attempt.bufferingMode;
        attempt.bufferingQuality.planAdopted(plan, serverFeatures, attempt.qualityPreference, bufferingReplan);
        this.showLoading(attempt, attempt.resuming ? "reconnecting" : undefined);
        void this.open(attempt, plan);
    }

    /** Sync waits for a plan whose inventory names a syncable subtitle. A replan that adds one (a download, an AI result) lists them again. */
    private adoptSync(attempt: Attempt, plan: PlaybackPlan): void {
        const keys = plan.subtitle.inventory.flatMap(track => track.syncKey === undefined || track.syncKey === "" ? [] : [track.syncKey]);
        if (attempt.sync !== undefined && attempt.sync.fileId !== plan.effectiveMediaFileId) {
            attempt.sync.destroy();
            attempt.sync = undefined;
        }
        if (keys.length === 0) return;
        if (attempt.sync === undefined) attempt.sync = new SubtitleSync(this.deps.session, this.deps.clock, plan.effectiveMediaFileId, () => this.showPlayback(attempt), key => this.refetchCaptions(attempt, key));
        else if (keys.some(key => !attempt.sync?.knows(key))) attempt.sync.reload();
    }

    /** The server retimed a subtitle: the track's URL serves the new timing, but the cues already read are the old ones. */
    private refetchCaptions(attempt: Attempt, key: string): void {
        const plan = attempt.plan;
        if (plan === undefined) return;
        const retimed = (trackId: string | undefined): boolean => trackId !== undefined && plan.subtitle.inventory.find(track => track.trackId === trackId)?.syncKey === key;
        // The same track can be retimed while it shows as SECONDARY; its URL and origin stay, so reconcileSecondary would keep the old cues.
        // A read that started under the current timing version already has these cues.
        const version = attempt.sync?.timingVersion(key) ?? 0;
        const secondary = retimed(attempt.secondaryId) && attempt.secondaryTiming < version ? secondaryRows(plan).find(row => row.trackId === attempt.secondaryId) : undefined;
        if (secondary !== undefined) this.startSecondary(attempt, secondary, attempt.secondaryOrigin, true);
        if (attempt.captionKey !== undefined && retimed(plan.subtitle.trackId) && attempt.captionTiming < version) this.readCaptions(attempt, plan, true);
        this.showPlayback(attempt);
    }

    private timingVersionOf(attempt: Attempt, key: string | undefined): number {
        return key === undefined || key === "" ? 0 : attempt.sync?.timingVersion(key) ?? 0;
    }

    /** SECONDARY follows its primary: it ends with the primary's artifact, or when the primary becomes the same track. */
    private reconcileSecondary(attempt: Attempt, plan: PlaybackPlan): void {
        if (attempt.secondaryId === undefined) return;
        const artifact = plan.subtitle.mode === "render" || plan.subtitle.mode === "convert" ? plan.subtitle.artifact : undefined;
        const row = secondaryRows(plan).find(candidate => candidate.trackId === attempt.secondaryId && candidate.trackId !== plan.subtitle.trackId);
        if (artifact === undefined || row === undefined) this.clearSecondary(attempt);
        // A replan that moved the primary's timing origin moves where the second track's cues belong, and one that gave the row a new session URL leaves the old read against a dead session.
        else if (artifact.origin !== attempt.secondaryOrigin || row.url !== attempt.secondaryUrl) this.startSecondary(attempt, row, artifact.origin);
    }

    private clearSecondary(attempt: Attempt): void {
        attempt.secondaryAbort?.abort();
        attempt.secondaryId = undefined;
        attempt.secondaryCues = [];
    }

    selectSecondarySubtitle(trackId: string | undefined): void {
        const attempt = this.active();
        const plan = attempt?.plan;
        if (attempt === undefined || plan === undefined || attempt.hidden || attempt.restoring) return;
        if (trackId === undefined) {
            this.clearSecondary(attempt);
            this.showPlayback(attempt);
            return;
        }
        const artifact = plan.subtitle.artifact;
        const row = secondaryRows(plan).find(candidate => candidate.trackId === trackId);
        if (attempt.captionKey === undefined || artifact === undefined || row === undefined || row.trackId === plan.subtitle.trackId) return;
        this.startSecondary(attempt, row, artifact.origin);
        this.showPlayback(attempt);
    }

    /** `refresh` rereads the shown secondary after a timing change, keeping its line and its selection unless new cues load. */
    private startSecondary(attempt: Attempt, row: SubtitleTrack, origin: number, refresh = false): void {
        const shownTiming = attempt.secondaryTiming;
        const keep = refresh && attempt.secondaryId === row.trackId;
        if (keep) attempt.secondaryAbort?.abort();
        else this.clearSecondary(attempt);
        attempt.secondaryId = row.trackId;
        attempt.secondaryOrigin = origin;
        attempt.secondaryUrl = row.url;
        attempt.secondaryTiming = this.timingVersionOf(attempt, row.syncKey);
        const abort = new AbortController();
        attempt.secondaryAbort = abort;
        const cancel = (): void => abort.abort();
        attempt.signal.addEventListener("abort", cancel, { once: true });
        abort.signal.addEventListener("abort", () => attempt.signal.removeEventListener("abort", cancel), { once: true });
        const current = (): boolean => attempt.live && !abort.signal.aborted;
        void (async () => {
            try {
                // The sidecar is read like the primary's artifact. Its cues share the primary's timing origin: both come from this plan's stream.
                // A download that ends early is fetched again like the primary's (`downloadSubtitle`), the cues that arrived showing meanwhile.
                const cues = await downloadSubtitle(this.deps.clock, abort.signal,
                    async () => this.deps.session.http.subtitleText(await this.captionUrl(row.url ?? "", abort.signal), abort.signal, keep),
                    text => decodeCues(text, secondaryFormat(row) ?? "", origin),
                    partial => {
                        if (!current() || keep) return;
                        attempt.secondaryCues = partial;
                        this.showPlayback(attempt);
                    });
                if (!current()) return;
                attempt.secondaryCues = cues;
            } catch {
                if (!current()) return;
                // A reread that fails leaves the line it replaced; with none loaded yet, or a track that cannot be read at all, it is not shown as chosen.
                if (keep && attempt.secondaryCues.length > 0) {
                    attempt.secondaryTiming = shownTiming;
                    return;
                }
                attempt.secondaryId = undefined;
            }
            if (current()) this.showPlayback(attempt);
        })();
    }

    /** A subtitle URL with the account's media token, since AVPlay and the app's own reads send no header for it. */
    private async captionUrl(raw: string, signal: AbortSignal): Promise<string> {
        const base = this.deps.session.http.base;
        const url = new URL(raw.startsWith("/") ? base.baseUrl + raw : raw);
        if (url.origin === base.origin && !url.searchParams.has("token")) url.searchParams.set("token", await this.deps.session.mediaToken(signal));
        return url.href;
    }

    /** `refresh` rereads the shown track past the HTTP cache after a timing change: its cues stay on screen until the new ones load, and stay if that fails. */
    private readCaptions(attempt: Attempt, plan: PlaybackPlan, refresh = false): void {
        const artifact = plan.subtitle.mode === "render" || plan.subtitle.mode === "convert" ? plan.subtitle.artifact : undefined;
        const key = captionKeyOf(plan);
        this.reconcileSecondary(attempt, plan);
        if (!refresh && key !== undefined && key === attempt.captionKey) return;
        const shownTiming = attempt.captionTiming;
        attempt.captionKey = key;
        attempt.captionFallback = undefined;
        attempt.captionTiming = this.timingVersionOf(attempt, plan.subtitle.inventory.find(track => track.trackId === plan.subtitle.trackId)?.syncKey);
        attempt.captionAbort?.abort();
        const abort = new AbortController();
        attempt.captionAbort = abort;
        const cancel = (): void => abort.abort();
        attempt.signal.addEventListener("abort", cancel, { once: true });
        abort.signal.addEventListener("abort", () => attempt.signal.removeEventListener("abort", cancel), { once: true });
        if (!refresh) {
            attempt.cues = [];
            attempt.captionNotice = "";
        }
        if (artifact === undefined) return;
        if (!refresh) attempt.captionNotice = CAPTION_LOADING;
        const current = (): boolean => attempt.live && !abort.signal.aborted && attempt.captionAbort === abort;
        void (async () => {
            try {
                const show = (cues: readonly SubtitleCue[]): void => {
                    if (!current() || refresh) return;
                    attempt.cues = cues;
                    attempt.captionNotice = "";
                    this.showPlayback(attempt);
                };
                const cues = await downloadSubtitle(this.deps.clock, abort.signal, async () => {
                    const url = await this.captionUrl(artifact.url, abort.signal);
                    if (!attempt.captionPreferencesRead) this.readCaptionPreferences(attempt);
                    return this.deps.session.http.subtitleText(url, abort.signal, refresh);
                }, text => decodeCues(text, artifact.format, artifact.origin), show);
                if (!current()) return;
                attempt.cues = cues;
                attempt.captionNotice = "";
            } catch {
                if (!current()) return;
                // Cues on screen are still the track's, at the older timing: keep them, and let the next timing change try again. With none loaded yet, fail as usual.
                if (refresh && attempt.cues.length > 0) {
                    attempt.captionTiming = shownTiming;
                    return;
                }
                attempt.captionKey = undefined;
                // SECONDARY needs a drawn primary: without it the list is gone, so its second line must go too.
                this.clearSecondary(attempt);
                if (this.nativeCaptionFallback(attempt, plan)) {
                    this.showPlayback(attempt);
                    return;
                }
                attempt.captionNotice = CAPTION_FAILED;
            }
            if (current()) this.showPlayback(attempt);
        })();
    }

    /**
     * Original HTTP asks for embedded text as an artifact (#538). When the app cannot load that file (over the 4 MiB limit, or a failed read),
     * AVPlay still has the embedded track and draws it, as it did before; Delay and Appearance then hide, since they cannot act on AVPlay's text.
     */
    private nativeCaptionFallback(attempt: Attempt, loaded: PlaybackPlan): boolean {
        const plan = attempt.plan;
        const id = loaded.subtitle.trackId;
        // Only while the plan on screen still shows that track from that file. A same-artifact replan (an audio change) keeps the read, so the
        // plan that started it may be gone; its artifact and track, not its id, are what must still hold.
        if (plan === undefined || captionKeyOf(plan) !== captionKeyOf(loaded) || plan.subtitle.trackId !== id || shownSubtitle(attempt, plan) !== id) return false;
        const row = plan.subtitle.inventory.find(entry => entry.trackId === id);
        if (plan.delivery !== "original_http" || row === undefined || !inStreamCandidate(plan, row)) return false;
        if (!this.applyStreamSubtitle(attempt, id)) {
            if (attempt.started) return false;
            // AVPlay lists its tracks only once it plays; the first frame applies this.
            attempt.captionFallback = id;
            return true;
        }
        try { this.deps.avplay.setSilentSubtitle?.(false); } catch { /* AVPlay keeps its own subtitle visibility. */ }
        return true;
    }

    /** The first frame's half of `nativeCaptionFallback`. */
    private applyCaptionFallback(attempt: Attempt, plan: PlaybackPlan): void {
        const id = attempt.captionFallback;
        if (id === undefined) return;
        attempt.captionFallback = undefined;
        if (shownSubtitle(attempt, plan) !== id) return;
        if (this.applyStreamSubtitle(attempt, id)) {
            try { this.deps.avplay.setSilentSubtitle?.(false); } catch { /* AVPlay keeps its own subtitle visibility. */ }
        } else {
            attempt.captionNotice = CAPTION_FAILED;
        }
    }

    /** Read once per attempt, so replans and track changes keep the profile's style and timing. */
    private readCaptionPreferences(attempt: Attempt): void {
        attempt.captionPreferencesRead = true;
        const current = (): boolean => attempt.live && !attempt.signal.aborted;
        const preferencesFailed = (): void => {
            if (!current()) return;
            attempt.captionPreferenceNotice = "Some subtitle preferences could not be loaded; using defaults.";
            this.showPlayback(attempt);
        };
        void this.deps.session.call({ ...operations.subtitleAppearance(attempt.profileId ?? ""), profileScoped: true, signal: attempt.signal }).then(appearance => {
            if (!current() || attempt.display?.editedAppearance) return;
            attempt.appearance = appearance;
            attempt.display?.adopt(appearance, attempt.subtitleSync);
            this.showPlayback(attempt);
        }, preferencesFailed);
        void this.deps.session.call({ ...operations.subtitleSync(), profileScoped: true, signal: attempt.signal }).then(sync => {
            if (!current() || attempt.display?.editedAppearance) return;
            attempt.subtitleSync = sync;
            attempt.display?.adopt(attempt.appearance, sync);
            this.showPlayback(attempt);
        }, preferencesFailed);
    }

    private async open(attempt: Attempt, plan: PlaybackPlan): Promise<void> {
        this.closeTransport();
        const transport = this.transport;
        await this.pending.closing;
        if (transport !== this.transport || !attempt.live) {
            return;
        }
        if (attempt.hidden || attempt.restoring) {
            attempt.deferredOpen = true;
            return;
        }
        const base = this.deps.session.http.base;
        // Root-relative URLs are on the API origin, below any path prefix the server sits behind.
        const published = plan.streamUrl.charAt(0) === "/" ? base.baseUrl + plan.streamUrl : plan.streamUrl;
        let media: URL;
        try {
            media = new URL(published);
            if (!isPermittedUrl(media, base.baseUrl)) {
                this.fail(attempt, { kind: "server" }, true);
                return;
            }
        } catch {
            this.fail(attempt, { kind: "server" }, true);
            return;
        }
        let url = published;
        if (media.origin === base.origin) {
            // Gate C candidate (playback-api.md, Delivery): the signed `st` the plan carries plus the
            // account bearer as `token`, because AVPlay cannot send headers. Never sent to another origin.
            let token: string;
            try {
                token = await this.deps.session.mediaToken(attempt.signal);
            } catch (error) {
                if (transport === this.transport && attempt.live) {
                    this.fail(attempt, startFailure(error), true);
                }
                return;
            }
            if (transport !== this.transport || !attempt.live) {
                return;
            }
            url = `${published}${published.indexOf("?") === -1 ? "?" : "&"}token=${encodeURIComponent(token)}`;
        }
        if (attempt.hidden || attempt.restoring) {
            attempt.deferredOpen = true;
            return;
        }
        if (await this.playlistUnreadable(attempt, plan, url)) {
            if (transport === this.transport && attempt.live) this.fail(attempt, { kind: "playback_failed" }, true);
            return;
        }
        if (transport !== this.transport || !attempt.live) {
            return;
        }
        if (attempt.hidden || attempt.restoring) {
            attempt.deferredOpen = true;
            return;
        }
        const avplay = this.deps.avplay;
        try {
            avplay.open(url);
            avplay.setListener(this.listen(attempt, transport));
            this.setDisplayRect(attempt);
            this.armStartup(attempt, transport);
            avplay.prepareAsync(
                () => {
                    if (transport === this.transport && attempt.live) {
                        this.prepared(attempt, plan, transport);
                    }
                },
                (error) => {
                    if (transport !== this.transport || !attempt.live) {
                        return;
                    }
                    if (error.name === "InvalidAccessError") {
                        // An unplayed replacement may be unreachable even when the previous transport played.
                        if (attempt.presented) this.routeFailed(attempt, "avplay_prepare_failed");
                        else this.fail(attempt, { kind: "network" }, true);
                    } else {
                        this.routeFailed(attempt, "avplay_prepare_failed");
                    }
                },
            );
        } catch {
            this.routeFailed(attempt, "avplay_open_failed");
        }
    }

    private prepared(attempt: Attempt, plan: PlaybackPlan, transport: number): void {
        const play = (): void => {
            if (transport !== this.transport || !attempt.live) {
                return;
            }
            this.cancelStartup?.();
            this.cancelStartup = undefined;
            this.startupDue = undefined;
            if (attempt.hidden || attempt.restoring) {
                try {
                    this.deps.avplay.suspend?.();
                    attempt.suspendedReady = true;
                } catch {
                    attempt.suspendedReady = false;
                }
                return;
            }
            let audioSelected: boolean;
            try {
                this.deps.avplay.play();
                audioSelected = this.selectPlanAudio(plan);
                attempt.hud.restore(this.deps.avplay, plan);
                if (attempt.paused) {
                    this.deps.avplay.pause();
                }
            } catch {
                this.routeFailed(attempt, "avplay_play_failed");
                return;
            }
            if (!audioSelected) {
                this.routeFailed(attempt, AUDIO_TRACK_SWITCH_FAILED);
                return;
            }
            attempt.started = true;
            attempt.presented = true;
            attempt.resuming = false;
            this.finishSkipSeek(attempt, true);
            if (attempt.recovery?.active === true) attempt.recovery.recovered(this.deps.clock.now());
            if (attempt.cancelTimer === undefined) {
                this.scheduleProgress(attempt);
            }
            if (!this.alignOpenStream(attempt, plan)) return;
            // Apple reads the next episode and On Deck once the item loads (PlayerViewModel.swift:6604-6607), so Show Up Next is offered from the start.
            this.beginDiscovery(attempt);
            this.updatePrompt(attempt);
            this.showPlayback(attempt);
            this.applyPreparedSubtitleChoices(attempt, plan);
        };
        const startMs = Math.round(plan.timeline.playerStartSeconds * 1000);
        if (startMs <= 0) {
            play();
            return;
        }
        try {
            this.seekTo(startMs, play, () => {
                if (transport === this.transport && attempt.live) {
                    this.routeFailed(attempt, "avplay_resume_seek_failed");
                }
            });
        } catch {
            this.routeFailed(attempt, "avplay_resume_seek_failed");
        }
    }

    private applyPreparedSubtitleChoices(attempt: Attempt, plan: PlaybackPlan): void {
        if (attempt.pendingAIResult !== undefined) {
            const resultId = attempt.pendingAIResult;
            attempt.pendingAIResult = undefined;
            const track = plan.subtitle.inventory.find(track => track.syncKey === `stored-${resultId}`);
            if (track === undefined) attempt.ai?.notice("The completed subtitle is not in the refreshed inventory. Playback continues; try selecting it later.");
            else if (track.unplayable === true) attempt.ai?.notice(STORED);
            else this.selectSubtitle(track.trackId);
        }
        if (attempt.pendingDownloadId !== undefined) {
            const id = attempt.pendingDownloadId;
            attempt.pendingDownloadId = undefined;
            const track = plan.subtitle.inventory.find(entry => entry.syncKey === `stored-${id}`);
            if (track === undefined || track.unplayable === true) attempt.search?.reportUnselected();
            else this.selectSubtitle(track.trackId);
        }
        if (attempt.queuedSubtitle !== undefined) {
            const queued = attempt.queuedSubtitle;
            attempt.queuedSubtitle = undefined;
            this.selectSubtitle(queued.id);
        }
    }

    private listen(attempt: Attempt, transport: number): AVPlayListener {
        const current = (): boolean => transport === this.transport && attempt.live;
        return {
            onbufferingstart: () => {
                if (current()) {
                    attempt.buffering = true;
                    this.showPlayback(attempt);
                }
            },
            onbufferingprogress: () => undefined,
            onbufferingcomplete: () => {
                if (current()) {
                    attempt.buffering = false;
                    this.showPlayback(attempt);
                }
            },
            oncurrentplaytime: (milliseconds) => {
                const plan = attempt.plan;
                if (current() && attempt.started && (!attempt.busy || attempt.change.state === "changing" || attempt.reporting) && plan !== undefined) {
                    attempt.sourceSeconds = milliseconds / 1000 + plan.timeline.timelineOffsetSeconds;
                    const marker = markerAt(attempt.markers?.segments ?? [], attempt.sourceSeconds);
                    if (!attempt.busy && marker !== undefined && !attempt.skippedMarkers.has(marker) && ((marker.kind === "intro" && attempt.introMode === "always") || (marker.kind === "credits" && attempt.skipCredits))) {
                        attempt.skippedMarkers.add(marker);
                        attempt.undoSkip = undefined;
                        // Apple offers Watch Intro after an automatic intro skip and nothing after a credits skip.
                        attempt.pendingSkipUndo = marker.kind === "intro" ? marker.startSeconds : undefined;
                        this.seekToSeconds(marker.endSeconds);
                        // Apple arms Watch Intro's five seconds as it issues the skip, so the seek counts against them.
                        this.showPlayback(attempt);
                        return;
                    }
                    this.updatePrompt(attempt);
                    this.showPlayback(attempt);
                }
            },
            onstreamcompleted: () => {
                if (!current() || !attempt.started) return;
                if (attempt.busy) {
                    if (attempt.change.state === "changing" || attempt.reporting) attempt.endedDuringChange = true;
                    return;
                }
                this.beginCompletion(attempt);
            },
            onevent: () => undefined,
            onerror: (eventType) => {
                // Before the first frame, prepareAsync's own callbacks decide.
                if (!current() || !attempt.started) {
                    return;
                }
                if (eventType === "PLAYER_ERROR_CONNECTION_FAILED") {
                    attempt.bufferingQuality.noteMediaRequestFailed();
                    this.recoverConnection(attempt);
                } else {
                    this.routeFailed(attempt, "avplay_playback_error");
                }
            },
        };
    }

    private finishSkipSeek(attempt: Attempt, moved: boolean): void {
        const seconds = attempt.pendingSkipUndo;
        attempt.pendingSkipUndo = undefined;
        if (moved && seconds !== undefined) {
            attempt.undoSkip = seconds;
        }
    }

    private beginCompletion(attempt: Attempt): void {
        attempt.endedDuringChange = false;
        this.leave(attempt, "abandon");
        this.nextStart = undefined;
        this.completion = { attempt, abort: new AbortController(), pending: false };
        this.retryCompletion();
    }

    private closeTransport(): void {
        const attempt = this.attempt;
        // A playing scrub pauses the stream and queues Play. The seek callback
        // drops that intent once this transport is gone, so keep it for the replacement.
        if (attempt?.pauseAfterSeek !== undefined) {
            attempt.paused = attempt.pauseAfterSeek;
            attempt.pauseAfterSeek = undefined;
        }
        this.transport++;
        if (attempt !== undefined) {
            attempt.suspended = false;
            attempt.suspendedReady = false;
            attempt.deferredOpen = false;
            attempt.restoreOpen = undefined;
        }
        this.startupDue = undefined;
        this.cancelStartup?.();
        this.cancelStartup = undefined;
        const seek = this.pending.seek;
        if (seek !== undefined) {
            const closing = seek.then(() => this.closeAVPlay());
            this.pending.closing = closing;
            void closing.then(() => {
                if (this.pending.closing === closing) {
                    this.pending.closing = undefined;
                }
            });
        } else {
            this.closeAVPlay();
        }
    }

    private closeAVPlay(): void {
        try {
            this.deps.avplay.close();
        } catch {
            // The pending seek has settled; a platform failure cannot be repaired here.
        }
    }

    private seekTo(milliseconds: number, success: () => void, error: () => void): void {
        let release: () => void = () => undefined;
        const seek = new Promise<void>((resolve) => { release = resolve; });
        this.pending.seek = seek;
        const settled = (callback: () => void): void => {
            if (this.pending.seek === seek) {
                this.pending.seek = undefined;
            }
            release();
            callback();
        };
        try {
            this.deps.avplay.seekTo(milliseconds, () => settled(success), () => settled(error));
        } catch {
            settled(error);
        }
    }

    // --- progress and stop ---

    private scheduleProgress(attempt: Attempt): void {
        attempt.cancelTimer?.();
        const due = this.deps.clock.now() + PROGRESS_INTERVAL_MS;
        attempt.progressDue = due;
        attempt.cancelTimer = this.deps.clock.schedule(() => {
            attempt.cancelTimer = undefined;
            attempt.progressDue = undefined;
            if (!attempt.live || attempt.hidden || attempt.recovery?.active === true) {
                return;
            }
            this.sendProgress(attempt);
            this.scheduleProgress(attempt);
        }, PROGRESS_INTERVAL_MS);
    }

    private sendProgress(attempt: Attempt): void {
        const sessionId = attempt.sessionId;
        const installationId = attempt.installationId;
        if (sessionId === undefined || installationId === undefined || attempt.progress !== undefined) {
            return;
        }
        const spec = operations.updatePlaybackProgress(sessionId, {
            installation_id: installationId,
            sequence: ++attempt.sequence,
            position: this.reportPosition(attempt),
            is_paused: samplePaused(attempt),
        });
        attempt.progress = this.deps.session.call({ ...spec, profileScoped: true, signal: attempt.signal }).then(
            () => {
                if (attempt.sessionId !== sessionId) return;
                attempt.progress = undefined;
            },
            (error: unknown) => {
                if (attempt.sessionId !== sessionId) return;
                attempt.progress = undefined;
                if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 410 || error.problemId === "installation_changed")) attempt.progressRefusal = error;
                if (!attempt.live || !(error instanceof ApiError)) {
                    return;
                }
                const status = error.status;
                // Other answers (stale, conflict, transient) leave playback alone; the next sample is newer.
                if (status === 410 || status === 404 || error.problemId === "installation_changed") {
                    this.sessionFailure(attempt, error);
                }
            },
        );
    }

    /** `once` sends the STOP a single time instead of retrying a failure that may clear; `sent` counts the sends already made. */
    private async stopSession(attempt: Attempt, once = false, sent = 0): Promise<void> {
        if (attempt.stopped) return;
        const sessionId = attempt.sessionId;
        const installationId = attempt.installationId;
        if (sessionId === undefined || installationId === undefined) {
            return;
        }
        // Stop is the last word: it waits for the sample in flight and carries the next sequence.
        await attempt.progress;
        if (attempt.progressRefusal !== undefined) throw attempt.progressRefusal;
        const spec = attempt.stopSpec ?? operations.stopPlayback(sessionId, {
            installation_id: installationId,
            stop_id: this.newId(),
            sequence: ++attempt.sequence,
            position: this.reportPosition(attempt),
            is_paused: samplePaused(attempt),
        });
        attempt.stopSpec = spec;
        if (attempt.stopRetryAt > this.deps.clock.now()) await sleep(this.deps.clock, attempt.stopRetryAt - this.deps.clock.now(), attempt.signal, abortedError);
        const send = async () => {
            try {
                return await this.deps.session.call({ ...spec, profileScoped: true, signal: attempt.signal });
            } catch (error) {
                if (error instanceof ApiError) attempt.stopRetryAt = this.deps.clock.now() + (error.retryAfterSeconds ?? 0) * 1000;
                throw error;
            }
        };
        const receipt = once ? await send() : await this.resend(attempt, send, sent);
        if ((receipt.outcome !== "stopped" && receipt.outcome !== "replayed") || (receipt.stopId !== undefined && receipt.stopId !== spec.body?.stop_id)) {
            throw new ApiError({ kind: "invalid_response", path: "playback_stop.receipt" });
        }
        attempt.stopped = true;
        attempt.ended = true;
    }

    retryCompletion(): void {
        const completion = this.completion;
        if (completion === undefined) {
            const attempt = this.attempt;
            if (attempt?.live === true && attempt.presented && this.shownError?.kind === "network") {
                this.shownError = undefined;
                const step = attempt.recovery?.step ?? "replan";
                attempt.resuming = true;
                this.showLoading(attempt, "reconnecting");
                this.arm(attempt, true, step);
                return;
            }
            if (this.shownError !== undefined && (retryableStart(this.shownError) || this.shownError.kind === "playback_failed")) {
                const replay = this.shownError.kind === "playback_failed" || (!attempt?.started && this.shownError.kind !== "settings");
                const next = attempt !== undefined && replay ? sameStart(attempt) : this.nextStart;
                if (next !== undefined) this.play(next);
            }
            return;
        }
        const view = this.current;
        if (view.phase === "completion" && view.state === "failed" && !view.retryable) return;
        if (completion.pending || completion.abort.signal.aborted || completion.attempt.signal.aborted) return;
        completion.pending = true;
        void this.finishCompletion(completion);
    }

    showUpNext(): void {
        const attempt = this.active();
        if (attempt?.started !== true || attempt.plan === undefined || attempt.hidden || attempt.request.shuffleId !== undefined) return;
        attempt.offer.manual = true;
        if (!attempt.offer.started) this.beginDiscovery(attempt);
        else {
            if (attempt.offer.episodeFailed && !attempt.offer.episodeLoading) this.retryEpisode(attempt);
            if (attempt.offer.deckFailed && !attempt.offer.deckLoading) this.retryDeck(attempt);
        }
        this.publishOffer(attempt);
    }

    /** The screen may pass a synopsis copy. Play the offer it came from. */
    private liveNext(attempt: Attempt, selected: PlayRequest | undefined): PlayRequest | undefined {
        const prompt = attempt.prompt;
        if (prompt === undefined) return undefined;
        if (selected === undefined) return prompt.next;
        if (selected === prompt.next || prompt.deck.includes(selected)) return selected;
        if (prompt.next !== undefined && prompt.next.contentId === selected.contentId && prompt.next.fileId === selected.fileId) return prompt.next;
        return prompt.deck.find(item => item.contentId === selected.contentId && item.fileId === selected.fileId);
    }

    playNext(selected?: PlayRequest): void {
        const view = this.current;
        const attempt = this.active();
        if ((view.phase === "playing" || view.phase === "paused") && attempt?.prompt !== undefined) {
            const request = this.liveNext(attempt, selected);
            if (request === undefined) return;
            this.beginCompletion(attempt);
            this.nextStart = request;
            return;
        }
        if (view.phase !== "completion" || view.state !== "ready" || view.next === undefined || this.completion?.attempt.ended !== true) return;
        const request = selected ?? view.next;
        if (request !== view.next && !view.deck?.includes(request)) return;
        this.cancelCompletion();
        this.nextStart = request;
        this.play(request);
    }

    private cancelCompletion(): void {
        this.cancelAutoplayTimer?.();
        this.cancelAutoplayTimer = undefined;
        this.completion?.abort.abort();
        this.completion = undefined;
    }

    cancelAutoplay(): void {
        const attempt = this.active();
        if (attempt !== undefined) {
            attempt.promptDismissed = true;
            attempt.offer.manual = false;
            attempt.prompt = undefined;
            this.paintRect(attempt);
            this.showPlayback(attempt);
        }
        this.cancelAutoplayTimer?.();
        this.cancelAutoplayTimer = undefined;
        if (this.current.phase === "completion" && this.current.countdown !== undefined) this.show({ ...this.current, countdown: undefined });
    }

    keepWatching(): void {
        const attempt = this.attempt;
        if (attempt?.live === true) {
            this.cancelAutoplay();
            this.setPaused(false);
        } else if (attempt?.ended === true && this.completion !== undefined) {
            const request = { ...attempt.request, startSeconds: Math.max(0, (attempt.plan?.durationSeconds ?? attempt.sourceSeconds) - 10) };
            this.cancelCompletion();
            this.play(request);
            if (this.attempt !== undefined) this.attempt.promptDismissed = true;
        } else this.back();
    }

    private startAutoplay(completion: NonNullable<PlaybackController["completion"]>): void {
        const deadline = this.deps.clock.now() + AUTOPLAY_COUNTDOWN_SECONDS * 1000;
        const tick = (): void => {
            const view = this.current;
            if (this.completion !== completion || completion.abort.signal.aborted || completion.attempt.signal.aborted || completion.attempt.signal !== this.deps.session.authoritySignal || !completion.attempt.ended || view.phase !== "completion" || view.state !== "ready" || view.next === undefined) return;
            const remaining = Math.max(0, Math.ceil((deadline - this.deps.clock.now()) / 1000));
            if (remaining === 0) { this.playNext(); return; }
            this.show({ ...view, countdown: remaining });
            this.cancelAutoplayTimer = this.deps.clock.schedule(tick, 1000);
        };
        tick();
    }

    private async finishCompletion(completion: NonNullable<PlaybackController["completion"]>): Promise<void> {
        const { attempt, abort } = completion;
        const current = (): boolean => this.completion === completion && this.attempt === attempt && !abort.signal.aborted && !attempt.signal.aborted && attempt.signal === this.deps.session.authoritySignal;
        const shuffle = attempt.request.shuffleId !== undefined;
        // PlayerView.statusLabel: while the next item is worked out, an ended video reads Playing Next (Up Next at Random in a Shuffle);
        // with nothing to follow it reads Finished. Apple has no separate stage for ending the session.
        const working: MessageKey = shuffle ? "upNext.headingShuffle" : "upNext.headingEnded";
        // A failure while the session ends (the final progress or STOP) is not a failed lookup: nothing was looked up yet.
        let stage: "session" | "lookup" = "session";
        const refused = (error: unknown): boolean => error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 410 || error.problemId === "installation_changed");
        const show = (state: "finalizing" | "resolving" | "ready" | "failed", next?: PlayRequest, retryable = false, status: MessageKey = state === "finalizing" || state === "resolving" ? working : "upNext.headingFinished", deck?: readonly PlayRequest[]): void => {
            if (current()) this.show({ phase: "completion", status, state, next: this.shownNext(next), retryable, ...(deck === undefined ? {} : { deck: deck.map(item => this.shownNext(item) ?? item) }), ...(shuffle ? { shuffle: true } : {}), ...(state === "failed" && stage === "session" ? { failure: "session" } : {}) });
        };
        // Apple's playShufflePart loads the next part with a plain loading state, not the end screen.
        if (attempt.request.shuffleId === undefined) show("finalizing");
        else if (current()) this.show({ phase: "loading", title: attempt.request.title, nextPart: true });
        try {
            // PlaybackSessionBridge.stopSession: one STOP, and a failure that may clear is logged and the advance goes on, the server timing
            // the old session out. The identical STOP keeps trying in the background, so the session still ends when the server can answer.
            // A refusal or an expired session still ends the advance: no successor starts without the session's authority.
            // A Retry after a failed lookup finds the session ended already, and sends no STOP of its own.
            if (!attempt.ended) try {
                await this.stopSession(attempt, true);
            } catch (error) {
                if (!(error instanceof ApiError && error.transient)) throw error;
                // Not at once: the first resend waits the first retry delay, or longer when the server asked (Retry-After). With the
                // first send counted, the STOP goes out as many times in all as a resent STOP does elsewhere.
                attempt.stopRetryAt = Math.max(attempt.stopRetryAt, this.deps.clock.now() + (RESEND_DELAYS_MS[0] ?? 0));
                attempt.ended = true;
                void this.stopSession(attempt, false, 1).catch((failure: unknown) => {
                    if (failure instanceof ApiError && failure.aborted) return;
                    // A resend refused like a first send ends the advance while it is still on screen. A 404 after a failure that may
                    // clear most likely means the first STOP landed, so it is only logged, as Apple logs a failed stop and goes on.
                    if (refused(failure) && current()) {
                        // As after a refused first send, the session never ended: Keep Watching and Back leave instead of replaying.
                        attempt.ended = false;
                        this.cancelAutoplay();
                        stage = "session";
                        show("failed");
                        abort.abort();
                        return;
                    }
                    console.warn("Auger playback: the session did not stop; the server will time it out", failure);
                });
            }
            if (!current()) return;
            stage = "lookup";
            if (this.nextStart !== undefined) {
                const request = this.nextStart;
                this.cancelCompletion();
                this.play(request);
                return;
            }
            if (attempt.request.shuffleId !== undefined) {
                // Apple plays every part of a pick before the shuffle moves on, with no countdown.
                const part = await nextShufflePart(spec => {
                    if (!current()) throw abortedError();
                    return this.deps.session.call({ ...spec, profileScoped: true, signal: abort.signal });
                }, attempt.request, attempt.plan?.effectiveMediaFileId ?? attempt.request.fileId).catch((error: unknown) => {
                    // A next part that no longer exists cannot be retried: the Shuffle moves on.
                    if (error instanceof ApiError && error.status === 404) return undefined;
                    throw error;
                });
                if (!current()) return;
                if (part !== undefined) {
                    this.cancelCompletion();
                    this.nextStart = part;
                    this.play(part);
                    return;
                }
            }
            const capRead = this.pickQuality(abort.signal);
            if (attempt.autoNextSupported) {
                await attempt.autoNextSave;
                if (!current()) return;
                const epoch = attempt.settingsEpoch;
                try {
                    const values = await this.deps.session.call({ ...operations.effectiveSettings([AUTO_NEXT_KEY]), profileScoped: true, signal: abort.signal });
                    if (epoch === attempt.settingsEpoch) attempt.autoNext = values.get(AUTO_NEXT_KEY)?.value === true;
                } catch { if (current() && epoch === attempt.settingsEpoch) attempt.autoNext = false; }
                if (!current()) return;
            }
            show("resolving");
            const quality = await capRead;
            if (!current()) return;
            if (attempt.request.shuffleId !== undefined) {
                const next = await nextShuffle(spec => {
                    if (!current()) throw abortedError();
                    return this.deps.session.call({ ...spec, profileScoped: true, signal: abort.signal });
                }, attempt.request.shuffleId, attempt.request.contentId, quality);
                show("ready", next, false, next === undefined ? "upNext.headingFinished" : "upNext.headingShuffle");
                if (current() && next !== undefined && attempt.autoNext) this.startAutoplay(completion);
                return;
            }
            const fileId = attempt.plan?.effectiveMediaFileId;
            if (fileId === undefined) throw new ApiError({ kind: "invalid_response", path: "playback_plan.effective_media_file_id" });
            const next = attempt.request.episode === true ? await nextEpisode(spec => {
                if (!current()) throw abortedError();
                return this.deps.session.call({ ...spec, profileScoped: true, signal: abort.signal });
            }, attempt.request.contentId, fileId, attempt.request.seriesTitle, quality) : undefined;
            if (next !== undefined) {
                show("ready", next, false, "upNext.headingEnded");
                this.loadPresentation(next, abort.signal, enriched => {
                    if (current() && this.current.phase === "completion" && this.current.next === next) this.show({ ...this.current, next: enriched });
                });
                void onDeckPlays(spec => {
                    if (!current()) throw abortedError();
                    return this.deps.session.call({ ...spec, profileScoped: true, signal: abort.signal });
                }, attempt.request.contentId, undefined, quality).then(deck => {
                    if (current() && this.current.phase === "completion" && this.current.state === "ready") this.show({ ...this.current, deck });
                }, () => undefined);
                if (current() && attempt.autoNext && !attempt.promptDismissed) {
                    if (attempt.prompt !== undefined) this.playNext();
                    else this.startAutoplay(completion);
                }
                return;
            }
            const deck = await onDeckPlays(spec => {
                if (!current()) throw abortedError();
                return this.deps.session.call({ ...spec, profileScoped: true, signal: abort.signal });
            }, attempt.request.contentId, items => {
                show("ready", items[0], false, "upNext.heading", items);
            }, quality);
            if (!current()) return;
            this.show({ phase: "completion", status: deck.length === 0 ? "upNext.headingFinished" : "upNext.heading", state: "ready", next: deck[0], deck, retryable: false });
        } catch (error) {
            // Only the session's own end can find the session missing; a 404 after that is a lookup that Retry may yet answer.
            const missingSession = error instanceof ApiError && error.status === 404 && stage === "session";
            const forbidden = missingSession || refused(error);
            show("failed", undefined, !forbidden);
        } finally {
            completion.pending = false;
        }
    }

    // --- endings ---

    /** Leaves an attempt: no callback of it acts again. `stop` also ends its server session. */
    private leave(attempt: Attempt, how: "stop" | "abandon"): void {
        attempt.ai?.destroy();
        attempt.search?.destroy();
        attempt.sync?.destroy();
        attempt.display?.destroy();
        attempt.captionAbort?.abort();
        attempt.secondaryAbort?.abort();
        if (!attempt.live) {
            return;
        }
        attempt.live = false;
        attempt.bufferingQuality.destroy();
        this.clearThumbnails(attempt);
        attempt.cancelTimer?.();
        attempt.cancelTimer = undefined;
        attempt.cancelRecovery?.();
        attempt.cancelRecovery = undefined;
        attempt.recovery?.end(false, this.deps.clock.now());
        if (this.attempt === attempt) {
            this.closeTransport();
        }
        if (how === "stop") {
            void this.stopSession(attempt).catch(() => undefined);
        }
    }

    private fail(attempt: Attempt, error: PlaybackError, stopSession: boolean): void {
        this.leave(attempt, stopSession ? "stop" : "abandon");
        if (this.attempt !== attempt) {
            return;
        }
        this.shownError = error;
        const exhausted = error.kind === "playback_failed";
        const retryable = exhausted || (!attempt.started && retryableStart(error) && (error.kind !== "settings" || this.nextStart !== undefined));
        this.show({ phase: "error", title: attempt.request.title, error, retryable });
    }

    /** A failed progress or replan for the session. */
    private sessionFailure(attempt: Attempt, error: unknown): void {
        if (error instanceof ApiError && error.aborted) {
            return;
        }
        if (error instanceof ApiError && error.status === 410) {
            // Ended by an administrator: leave, and never start a fresh session at this position.
            this.leave(attempt, "abandon");
            this.attempt = undefined;
            this.show({ phase: "closed" });
            this.deps.exits.onEnd("ended_by_server");
            return;
        }
        if (error instanceof ApiError && error.status === 404) {
            if (attempt.presented && attempt.live && this.shownError === undefined) {
                this.sessionMissing(attempt);
                return;
            }
            this.fail(attempt, { kind: "session_expired" }, false);
            return;
        }
        const failure = startFailure(error);
        this.fail(attempt, failure, failure.kind !== "installation_changed");
    }

    // --- reconnect and visibility ---

    private capturePosition(attempt: Attempt): void {
        const plan = attempt.plan;
        if (plan === undefined || !attempt.started || attempt.busy) {
            return;
        }
        try {
            const ms = this.deps.avplay.getCurrentTime();
            if (Number.isFinite(ms) && ms >= 0) {
                attempt.sourceSeconds = ms / 1000 + plan.timeline.timelineOffsetSeconds;
            }
        } catch {
            // Keep the last position the stream reported.
        }
    }

    private holdTimers(attempt: Attempt): void {
        attempt.cancelTimer?.();
        attempt.cancelTimer = undefined;
        attempt.cancelRecovery?.();
        attempt.cancelRecovery = undefined;
        this.cancelStartup?.();
        this.cancelStartup = undefined;
    }

    /**
     * True when an HLS playlist, or the first video variant of a master, is written with `#EXT-X-DEFINE` variables (or leaves one in a
     * segment address). The master is version 3 and clean; the define is in the variant (S95C, #650). Rendition playlists are not read. AVPlay
     * cannot read those, and handing it such a stream stops the page's JavaScript until the TV closes Silo (#650, #314),
     * so no timer could catch it. A playlist that cannot be read here is no verdict: AVPlay gets it as before.
     */
    private async playlistUnreadable(attempt: Attempt, plan: PlaybackPlan, url: string): Promise<boolean> {
        if (plan.delivery !== "server_remux_hls" && plan.delivery !== "server_transcode_hls") return false;
        let heads: string[];
        try {
            heads = await this.deps.session.http.playlistHeads(url, attempt.signal);
        } catch {
            return false;
        }
        if (!heads.some(head => /#EXT-X-DEFINE|\{\$/.test(head))) return false;
        console.warn(`Auger playback: the HLS playlist uses #EXT-X-DEFINE, which AVPlay cannot read (delivery ${plan.delivery})`);
        return true;
    }

    private armStartup(attempt: Attempt, transport: number, deadline = this.deps.clock.now() + STARTUP_TIMEOUT_MS): void {
        this.startupDue = deadline;
        this.cancelStartup?.();
        this.cancelStartup = this.deps.clock.schedule(() => {
            this.startupDue = undefined;
            if (transport === this.transport && !attempt.started && !attempt.hidden && attempt.live) {
                this.routeFailed(attempt, "avplay_startup_timeout");
            }
        }, Math.max(0, deadline - this.deps.clock.now()));
    }

    private showLoading(attempt: Attempt, detail: "reconnecting" | "restoring" | undefined): void {
        this.show({ phase: "loading", title: attempt.request.title, ...(detail === undefined ? {} : { detail }) });
    }

    private recoverConnection(attempt: Attempt): void {
        attempt.pendingAIResult = undefined;
        if (!attempt.live || !attempt.presented) {
            this.fail(attempt, { kind: "network" }, true);
            return;
        }
        if (attempt.recovery?.active === true) {
            return;
        }
        this.capturePosition(attempt);
        attempt.cancelTimer?.();
        attempt.cancelTimer = undefined;
        this.closeTransport();
        attempt.started = false;
        attempt.busy = false;
        attempt.buffering = false;
        attempt.resuming = true;
        this.showLoading(attempt, "reconnecting");
        this.arm(attempt, false, attempt.replacementBody === undefined ? "replan" : "start");
    }

    private releaseFailedRoute(attempt: Attempt): void {
        const plan = attempt.plan;
        if (plan !== undefined && attempt.attemptedKeys[attempt.attemptedKeys.length - 1] === plan.planAttemptKey) {
            attempt.attemptedKeys.pop();
        }
        if (attempt.recoveries > 0) {
            attempt.recoveries -= 1;
        }
        attempt.busy = false;
    }

    private noteTransportUnanswered(attempt: Attempt): void {
        const recovery = attempt.recovery;
        if (recovery === undefined || !recovery.active || !attempt.live) {
            this.fail(attempt, { kind: "network" }, true);
            return;
        }
        this.closeTransport();
        attempt.started = false;
        const action = recovery.retryLater(this.deps.clock.now());
        if (action.kind === "give_up") {
            this.giveUp(attempt);
            return;
        }
        if (action.kind === "wait") {
            this.scheduleRecovery(attempt, action.delayMs);
        }
        this.showLoading(attempt, "reconnecting");
    }

    private sessionMissing(attempt: Attempt): void {
        if (!attempt.live) {
            return;
        }
        const recovery = attempt.recovery;
        if (recovery?.active === true) {
            recovery.step = "start";
            if (attempt.recoveryPending) {
                return;
            }
            this.showLoading(attempt, "reconnecting");
            this.scheduleRecovery(attempt, 0);
            return;
        }
        this.capturePosition(attempt);
        attempt.cancelTimer?.();
        attempt.cancelTimer = undefined;
        this.closeTransport();
        attempt.started = false;
        attempt.resuming = true;
        this.showLoading(attempt, "reconnecting");
        this.arm(attempt, false, "start", true);
    }

    private arm(attempt: Attempt, fresh: boolean, step: RecoveryStep, immediate = false): void {
        const recovery = attempt.recovery ?? (attempt.recovery = new PlaybackRecovery());
        const action = recovery.begin(this.deps.clock.now(), fresh, step);
        switch (action.kind) {
            case "join":
                return;
            case "give_up":
                this.giveUp(attempt);
                return;
            case "wait":
                this.scheduleRecovery(attempt, immediate ? 0 : action.delayMs);
                return;
            default: {
                const unreachable: never = action;
                return unreachable;
            }
        }
    }

    private scheduleRecovery(attempt: Attempt, delayMs: number): void {
        const recovery = attempt.recovery;
        if (recovery === undefined) {
            return;
        }
        const due = Math.max(this.deps.clock.now() + delayMs, attempt.recoveryRetryAt);
        recovery.dueAt = due;
        attempt.cancelRecovery?.();
        attempt.cancelRecovery = undefined;
        if (attempt.hidden) {
            return;
        }
        const generation = recovery.generation;
        attempt.cancelRecovery = this.deps.clock.schedule(() => {
            if (recovery.generation === generation && attempt.live && !attempt.hidden) {
                void this.runRecovery(attempt);
            }
        }, Math.max(0, due - this.deps.clock.now()));
    }

    private async runRecovery(attempt: Attempt): Promise<void> {
        const recovery = attempt.recovery;
        if (recovery === undefined || !recovery.active || !attempt.live || attempt.hidden || attempt.restoring || attempt.recoveryPending) {
            return;
        }
        const generation = recovery.generation;
        const sessionId = attempt.sessionId;
        const step = recovery.step;
        const current = (): boolean => this.attempt === attempt && attempt.live && recovery.active && recovery.generation === generation && attempt.sessionId === sessionId;
        attempt.recoveryPending = true;
        recovery.beginAttempt();
        try {
            if (step === "start") {
                await this.recoveryStart(attempt, current);
                return;
            }
            const decision = await this.recoveryReplan(attempt);
            attempt.recoverySpec = undefined;
            if (!current()) {
                return;
            }
            if (decision.outcome === "playable") {
                if (decision.sessionId !== attempt.sessionId) {
                    recovery.end(false, this.deps.clock.now());
                    this.fail(attempt, { kind: "server" }, true);
                    return;
                }
                attempt.busy = false;
                attempt.resuming = true;
                this.adopt(attempt, decision.plan, decision.serverFeatures);
                return;
            }
            attempt.retirePredecessor = true;
            recovery.step = "start";
            await this.applyVerdict(attempt, { kind: "start_new_session" });
        } catch (error) {
            if (!current()) {
                return;
            }
            if (error instanceof ApiError && error.aborted) {
                return;
            }
            if (!unanswered(error)) attempt.recoverySpec = undefined;
            const verdict = recoveryVerdict(error, step);
            if (verdict.kind === "start_new_session") {
                attempt.retirePredecessor = !(error instanceof ApiError && error.status === 404);
            }
            await this.applyVerdict(attempt, verdict);
        } finally {
            attempt.recoveryPending = false;
        }
    }

    private recoveryReplan(attempt: Attempt): Promise<PlaybackDecision> {
        const plan = attempt.plan;
        const sessionId = attempt.sessionId;
        const installationId = attempt.installationId;
        if (plan === undefined || sessionId === undefined || installationId === undefined) {
            return Promise.reject(new ApiError({ kind: "invalid_response", path: "playback_recovery" }));
        }
        const replan = attempt.recoverySpec ?? operations.replanPlayback(sessionId, {
            installation_id: installationId,
            protocol_version: 3,
            client_features: this.features(attempt),
            operation: "track_change",
            playback_attempt_id: attempt.playbackAttemptId,
            replan_request_id: this.newId(),
            failed_plan_id: plan.planId,
            plan_attempt_id: attempt.planAttemptId,
            plan_attempt_key: plan.planAttemptKey,
            attempted_plan_keys: attempt.attemptedKeys.slice(),
            attempt_count: Math.max(1, attempt.recoveries),
            quality_preference: attempt.qualityPreference,
            ...(attempt.bandwidthCapKbps === undefined ? {} : { bandwidth_cap_kbps: attempt.bandwidthCapKbps }),
            ...this.replanBufferingMembers(attempt, "track_change", undefined),
            position_seconds: attempt.sourceSeconds,
            selected_tracks: chosenTracks(attempt, plan),
            ...this.reportedPlayback(attempt),
        });
        attempt.recoverySpec = replan;
        return this.deps.session.call({ ...replan, profileScoped: true, signal: attempt.signal });
    }

    private replacementBody(attempt: Attempt): StartPlaybackBody {
        const plan = attempt.plan;
        const profile = this.deps.session.activeProfile;
        const installationId = attempt.installationId;
        if (plan === undefined || profile === undefined || installationId === undefined) {
            throw new ApiError({ kind: "invalid_response", path: "playback_recovery.start" });
        }
        const audio = plan.selectedTracks.audio?.id;
        const subtitle = attempt.subtitleOverride !== undefined ? shownSubtitle(attempt, plan) : plan.subtitle.mode === "off" ? undefined : plan.subtitle.trackId ?? plan.selectedTracks.subtitle?.id;
        return {
            installation_id: installationId,
            protocol_version: 3,
            client_features: this.features(attempt),
            file_id: plan.effectiveMediaFileId,
            profile_id: profile.id,
            playback_attempt_id: this.newId(),
            quality_preference: attempt.qualityPreference,
            ...(attempt.bandwidthCapKbps === undefined ? {} : { bandwidth_cap_kbps: attempt.bandwidthCapKbps }),
            ...this.startBufferingMembers(attempt, false),
            subtitle_fidelity_preference: "compatible",
            start_position: attempt.sourceSeconds,
            ...(audio === undefined ? {} : { audio_track_id: audio }),
            ...(subtitle === undefined ? {} : { subtitle_track_id: subtitle }),
            ...(attempt.request.allowAlternateVersions === undefined ? {} : { allow_alternate_versions: attempt.request.allowAlternateVersions }),
            ...this.reportedPlayback(attempt),
        };
    }

    private async recoveryStart(attempt: Attempt, current: () => boolean): Promise<void> {
        const recovery = attempt.recovery;
        if (recovery === undefined) {
            return;
        }
        try {
            const body = attempt.replacementBody ?? this.replacementBody(attempt);
            attempt.replacementBody = body;
            const decision = await this.deps.session.call({ ...operations.startPlayback(body), profileScoped: true, signal: attempt.signal });
            if (!attempt.live && decision.outcome === "playable") {
                // A late replacement owns a separate session and cannot reuse the retired STOP.
                const retired: Attempt = { ...attempt, playbackAttemptId: body.playback_attempt_id, sessionId: decision.sessionId, sequence: 0, stopped: false, ended: false, stopSpec: undefined, stopRetryAt: 0, progress: undefined, progressRefusal: undefined };
                void this.stopSession(retired).catch(() => undefined);
                return;
            }
            if (!current()) {
                return;
            }
            if (decision.outcome !== "playable") {
                recovery.end(false, this.deps.clock.now());
                attempt.replacementBody = undefined;
                this.fail(attempt, decisionFailure(decision), attempt.retirePredecessor);
                return;
            }
            if (attempt.retirePredecessor) {
                // A stale plan does not prove the predecessor session has ended.
                void this.stopSession({ ...attempt }).catch(() => undefined);
                attempt.retirePredecessor = false;
            }
            attempt.playbackAttemptId = body.playback_attempt_id;
            attempt.sessionId = decision.sessionId;
            attempt.sequence = 0;
            attempt.stopped = false;
            attempt.ended = false;
            attempt.stopSpec = undefined;
            attempt.progress = undefined;
            attempt.progressRefusal = undefined;
            attempt.replacementBody = undefined;
            attempt.resuming = true;
            attempt.bufferingQuality.newAttempt();
            this.adopt(attempt, decision.plan, decision.serverFeatures);
        } catch (error) {
            if (!current()) {
                return;
            }
            if (error instanceof ApiError && error.aborted) {
                return;
            }
            await this.applyVerdict(attempt, recoveryVerdict(error, "start"));
        }
    }

    private async applyVerdict(attempt: Attempt, verdict: RecoveryVerdict): Promise<void> {
        const recovery = attempt.recovery;
        switch (verdict.kind) {
            case "retry": {
                if (recovery === undefined) {
                    return;
                }
                if (verdict.retryAfterMs !== undefined) attempt.recoveryRetryAt = Math.max(attempt.recoveryRetryAt, this.deps.clock.now() + verdict.retryAfterMs);
                const action = recovery.retryLater(this.deps.clock.now());
                if (action.kind === "give_up") {
                    this.giveUp(attempt);
                } else if (action.kind === "wait") {
                    this.scheduleRecovery(attempt, action.delayMs);
                }
                return;
            }
            case "start_new_session":
                if (recovery !== undefined) {
                    const generation = recovery.generation;
                    recovery.step = "start";
                    if (attempt.hidden || attempt.restoring) {
                        this.scheduleRecovery(attempt, 0);
                    } else {
                        const sessionId = attempt.sessionId;
                        await this.recoveryStart(attempt, () => this.attempt === attempt && attempt.live && recovery.active && recovery.generation === generation && attempt.sessionId === sessionId);
                    }
                }
                return;
            case "give_up":
                this.giveUp(attempt);
                return;
            case "installation_changed":
                recovery?.end(false, this.deps.clock.now());
                this.fail(attempt, { kind: "installation_changed" }, false);
                return;
            case "ended":
                recovery?.end(false, this.deps.clock.now());
                this.leave(attempt, "abandon");
                if (this.attempt !== attempt) {
                    return;
                }
                this.attempt = undefined;
                this.show({ phase: "closed" });
                this.deps.exits.onEnd("ended_by_server");
                return;
            case "revoked":
                recovery?.end(false, this.deps.clock.now());
                this.fail(attempt, { kind: "revoked" }, false);
                return;
            default: {
                const unreachable: never = verdict;
                return unreachable;
            }
        }
    }

    private giveUp(attempt: Attempt): void {
        attempt.recovery?.end(false, this.deps.clock.now());
        attempt.resuming = false;
        if (this.attempt !== attempt || !attempt.live) {
            return;
        }
        const error: PlaybackError = { kind: "network" };
        this.shownError = error;
        this.show({ phase: "error", title: attempt.request.title, error, retryable: true });
    }

    private async resumeVisible(attempt: Attempt): Promise<void> {
        const generation = ++attempt.resumeGeneration;
        if (attempt.installationId === undefined) return;
        const current = (): boolean => attempt.live && attempt.resumeGeneration === generation && this.attempt === attempt;
        const gate = await this.revalidate(attempt);
        if (!current() || this.shownError !== undefined) {
            return;
        }
        attempt.hidden = false;
        if (!gate.ok) {
            if ("ignored" in gate) {
                return;
            }
            if (gate.error.kind === "network" && attempt.presented) {
                if (attempt.recovery?.active === true) {
                    this.closeTransport();
                    attempt.started = false;
                    const due = attempt.recovery.dueAt ?? this.deps.clock.now();
                    this.scheduleRecovery(attempt, Math.max(0, due - this.deps.clock.now()));
                    this.showLoading(attempt, "reconnecting");
                } else {
                    this.recoverConnection(attempt);
                }
                return;
            }
            const stop = gate.error.kind !== "installation_changed" && gate.error.kind !== "revoked" && gate.error.kind !== "unavailable";
            this.fail(attempt, gate.error, stop);
            return;
        }
        attempt.restoring = false;
        if (!attempt.started && this.startupDue !== undefined) {
            this.armStartup(attempt, this.transport, this.startupDue);
            return;
        }
        if (attempt.suspended && attempt.plan !== undefined) {
            const transport = this.transport;
            const restored = await this.warmRestore(attempt, gate.token);
            if (!current() || transport !== this.transport) {
                return;
            }
            if (restored) {
                this.restartProgress(attempt);
                return;
            }
            this.recoverConnection(attempt);
            return;
        }
        if (attempt.suspendedReady) {
            attempt.suspendedReady = false;
            try {
                this.deps.avplay.play();
                if (attempt.plan !== undefined && !this.selectPlanAudio(attempt.plan)) {
                    this.routeFailed(attempt, AUDIO_TRACK_SWITCH_FAILED);
                    return;
                }
                if (attempt.plan !== undefined) attempt.hud.restore(this.deps.avplay, attempt.plan);
                if (attempt.paused) {
                    this.deps.avplay.pause();
                }
                attempt.started = true;
                attempt.presented = true;
                attempt.resuming = false;
                if (attempt.recovery?.active === true) attempt.recovery.recovered(this.deps.clock.now());
                if (attempt.plan !== undefined && !this.alignOpenStream(attempt, attempt.plan)) return;
                this.showPlayback(attempt);
                if (attempt.plan !== undefined) this.applyPreparedSubtitleChoices(attempt, attempt.plan);
            } catch {
                this.recoverConnection(attempt);
                return;
            }
            this.restartProgress(attempt);
            return;
        }
        if (attempt.deferredOpen && attempt.plan !== undefined) {
            attempt.deferredOpen = false;
            await this.open(attempt, attempt.plan);
            return;
        }
        if (attempt.recovery?.active === true) {
            if (attempt.recoveryPending) return;
            const due = attempt.recovery.dueAt ?? this.deps.clock.now();
            this.scheduleRecovery(attempt, Math.max(0, due - this.deps.clock.now()));
            this.showLoading(attempt, "reconnecting");
            return;
        }
        this.restartProgress(attempt);
    }

    private async revalidate(attempt: Attempt): Promise<{ ok: true; token: string } | { ok: false; ignored: true } | { ok: false; error: PlaybackError }> {
        try {
            const capabilities = await this.deps.session.call({ ...operations.playbackCapabilities(), profileScoped: true, signal: attempt.signal });
            if (!attempt.live || attempt.signal.aborted) {
                return { ok: false, ignored: true };
            }
            const profile = this.deps.session.activeProfile;
            const installationId = capabilities.installationId;
            if (capabilities.state !== "available" || !capabilities.allowed || capabilities.protocolVersions.indexOf(3) === -1 || installationId === undefined || profile === undefined) {
                return { ok: false, error: { kind: "unavailable" } };
            }
            if (installationId !== attempt.installationId) {
                return { ok: false, error: { kind: "installation_changed" } };
            }
            if (profile.id !== attempt.profileId) {
                return { ok: false, error: { kind: "revoked" } };
            }
            const token = await this.deps.session.mediaToken(attempt.signal);
            if (!attempt.live) {
                return { ok: false, ignored: true };
            }
            return { ok: true, token };
        } catch (error) {
            if (error instanceof ApiError && error.aborted) {
                return { ok: false, ignored: true };
            }
            if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
                return { ok: false, error: { kind: "revoked" } };
            }
            if (error instanceof ApiError && error.problemId === "installation_changed") {
                return { ok: false, error: { kind: "installation_changed" } };
            }
            if (unanswered(error)) {
                return { ok: false, error: { kind: "network" } };
            }
            return { ok: false, error: startFailure(error) };
        }
    }

    private warmRestore(attempt: Attempt, token: string): Promise<boolean> {
        const plan = attempt.plan;
        const restore = this.deps.avplay.restoreAsync;
        if (plan === undefined || restore === undefined) {
            return Promise.resolve(false);
        }
        const url = this.urlWithToken(plan, token);
        if (url === undefined) {
            return Promise.resolve(false);
        }
        const resumeMs = Math.max(0, Math.round((attempt.sourceSeconds - plan.timeline.timelineOffsetSeconds) * 1000));
        const generation = attempt.resumeGeneration;
        const transport = this.transport;
        this.showLoading(attempt, "restoring");
        const open = {};
        attempt.restoreOpen = open;
        const close = (): void => {
            if (attempt.restoreOpen === open) attempt.restoreOpen = undefined;
        };
        return new Promise<boolean>((resolve) => {
            try {
                restore.call(this.deps.avplay, url, resumeMs, false, () => {
                    close();
                    if (transport !== this.transport) {
                        resolve(false);
                        return;
                    }
                    if (!attempt.live || this.attempt !== attempt || attempt.hidden || attempt.resumeGeneration !== generation) {
                        if (attempt.live && this.attempt === attempt && (attempt.hidden || attempt.restoring)) {
                            try {
                                this.deps.avplay.suspend?.();
                            } catch {
                                this.closeTransport();
                                attempt.suspended = false;
                            }
                        }
                        resolve(false);
                        return;
                    }
                    attempt.suspended = false;
                    attempt.started = true;
                    attempt.presented = true;
                    attempt.resuming = false;
                    try {
                        attempt.hud.restore(this.deps.avplay, plan);
                        if (attempt.paused) {
                            if (this.deps.avplay.getState() === "PLAYING") {
                                this.deps.avplay.pause();
                            }
                        } else if (this.deps.avplay.getState() === "PAUSED") {
                            this.deps.avplay.play();
                        }
                    } catch {
                        // The next key tries again.
                    }
                    this.showPlayback(attempt);
                    resolve(true);
                }, () => resolve(false));
            } catch {
                resolve(false);
            }
        }).finally(close);
    }

    private urlWithToken(plan: PlaybackPlan, token: string): string | undefined {
        const base = this.deps.session.http.base;
        const published = plan.streamUrl.charAt(0) === "/" ? base.baseUrl + plan.streamUrl : plan.streamUrl;
        let media: URL;
        try {
            media = new URL(published);
        } catch {
            return undefined;
        }
        if (!isPermittedUrl(media, base.baseUrl)) {
            return undefined;
        }
        if (media.origin !== base.origin) {
            return published;
        }
        return `${published}${published.indexOf("?") === -1 ? "?" : "&"}token=${encodeURIComponent(token)}`;
    }

    private restartProgress(attempt: Attempt): void {
        if (!attempt.live || attempt.hidden || attempt.recovery?.active === true || !attempt.presented || !attempt.started) {
            return;
        }
        if (attempt.cancelTimer !== undefined) {
            return;
        }
        const remaining = attempt.progressDue === undefined ? PROGRESS_INTERVAL_MS : Math.max(0, attempt.progressDue - this.deps.clock.now());
        if (remaining === 0) {
            attempt.progressDue = undefined;
            this.sendProgress(attempt);
            this.scheduleProgress(attempt);
            return;
        }
        attempt.progressDue = this.deps.clock.now() + remaining;
        attempt.cancelTimer = this.deps.clock.schedule(() => {
            attempt.cancelTimer = undefined;
            attempt.progressDue = undefined;
            if (!attempt.live || attempt.hidden || attempt.recovery?.active === true) {
                return;
            }
            this.sendProgress(attempt);
            this.scheduleProgress(attempt);
        }, remaining);
    }

    // --- helpers ---

    private readMarkers(attempt: Attempt, fileId: string): void {
        if (attempt.markers?.fileId === fileId) return;
        const markers = { fileId, segments: [] as readonly SkipMarker[] };
        attempt.markers = markers;
        void this.deps.session.call({ ...operations.fileMarkers(fileId), profileScoped: true, signal: attempt.signal }).then(
            segments => {
                if (!attempt.live || attempt.markers !== markers) return;
                markers.segments = segments;
                this.showPlayback(attempt);
            },
            () => { /* Optional markers never interrupt playback. */ },
        );
    }

    /** Resends the identical request after no answer or a transient refusal; the contract replays it. */
    private async resend<T>(attempt: Attempt, send: () => Promise<T>, sent = 0): Promise<T> {
        for (let index = sent; ; index++) {
            try {
                return await send();
            } catch (error) {
                const delay = RESEND_DELAYS_MS[index];
                if (!(error instanceof ApiError) || !error.transient || delay === undefined) {
                    throw error;
                }
                await sleep(this.deps.clock, Math.max(delay, (error.retryAfterSeconds ?? 0) * 1000), attempt.signal, abortedError);
            }
        }
    }

    private active(): Attempt | undefined {
        const attempt = this.attempt;
        return attempt !== undefined && attempt.live ? attempt : undefined;
    }

    private showPlayback(attempt: Attempt): void {
        const plan = attempt.plan;
        // A late read must not draw over the Restoring overlay; the restore itself draws the view when it ends.
        if (this.attempt !== attempt || !attempt.live || !attempt.started || plan === undefined || attempt.restoring || attempt.restoreOpen !== undefined) {
            return;
        }
        const frozen = attempt.busy && !attempt.reporting;
        const captionTime = this.captionInstant(attempt, plan);
        this.show({
            phase: attempt.paused ? "paused" : "playing",
            title: attempt.request.title,
            positionSeconds: attempt.sourceSeconds,
            seriesTitle: attempt.request.seriesTitle,
            seasonNumber: attempt.request.seasonNumber,
            episodeNumber: attempt.request.episodeNumber,
            durationSeconds: plan.durationSeconds,
            buffering: attempt.buffering,
            ...(this.episodesVisible(attempt) ? { episodes: true as const } : {}),
            ...(attempt.prompt === undefined ? {} : { upNext: {
                next: this.shownNext(attempt.prompt.next), deck: attempt.prompt.deck.map(item => this.shownNext(item) ?? item),
                countdown: this.promptCountdown(attempt, plan),
                // Apple's nextUpCountdownTotalSeconds: the HUD threshold when opened by hand, else the prompt's length.
                countdownTotal: attempt.offer.manual ? MANUAL_COUNTDOWN_THRESHOLD_SECONDS : Math.max(1, attempt.promptSeconds),
                status: attempt.prompt.loading === true || attempt.prompt.next !== undefined ? translate("upNext.heading") : translate("upNext.headingNothing"),
                ...(attempt.prompt.loading === true ? { loading: true as const } : {}),
                ...(attempt.prompt.failed === true ? { failed: true as const } : {}),
            } }),
            resumePending: attempt.paused && attempt.pauseAfterSeek === false,
            transportCommandCount: attempt.transportCommandCount,
            tracks: trackView(attempt, plan),
            hud: {
                chapters: attempt.hud.chapters, chapterState: attempt.hud.chapterState,
                overview: attempt.hud.metadata?.overview ?? attempt.request.overview,
                metadata: attempt.hud.metadata, metadataFailed: attempt.hud.metadataFailed,
                stats: planStats(plan, liveStats(attempt, plan, this.deps.session.http.base.baseUrl)),
                ...videoOptions(this.deps.avplay.setSpeed !== undefined, this.deps.avplay.setDisplayMethod !== undefined, plan.streamProtocol),
                speed: attempt.hud.speed, aspect: attempt.hud.aspect,
                autoNext: attempt.autoNextSupported ? attempt.autoNext : undefined,
                busy: attempt.hud.autoBusy || attempt.busy,
                message: attempt.hud.message,
            },
            seekIntervals: attempt.seekIntervals,
            previewKey: frozen ? undefined : attempt.planAttemptId,
            // The offset moves cues this overlay draws. Text AVPlay selects itself is not shifted: AVPlay has no subtitle-offset call, and a TV has to confirm whether its TEXT track can move.
            captions: attempt.hidden || attempt.restoring || frozen ? undefined : { text: attempt.cues.filter(cue => captionTime >= cue.start && captionTime < cue.end).map(cue => cue.text).join("\n"), secondaryText: attempt.secondaryCues.filter(cue => captionTime >= cue.start && captionTime < cue.end).map(cue => cue.text).join("\n"), appearance: attempt.appearance, status: attempt.captionNotice === CAPTION_LOADING ? "loading" : attempt.captionNotice === CAPTION_FAILED ? "failed" : attempt.cues.length > 0 ? "ready" : "none", cueCount: attempt.cues.length, instant: captionTime },
            skipMarker: frozen ? undefined : markerAt((attempt.markers?.segments ?? []).filter(marker => marker.kind !== "intro" || attempt.introMode === "ask"), attempt.sourceSeconds),
            undoSkipSeconds: attempt.undoSkip ?? attempt.pendingSkipUndo,
        });
    }

    private inPromptWindow(attempt: Attempt): boolean {
        const duration = attempt.plan?.durationSeconds;
        if (duration === undefined || attempt.promptSeconds === 0) return false;
        const remaining = duration - attempt.sourceSeconds;
        return remaining >= 0 && remaining <= attempt.promptSeconds;
    }

    private episodesVisible(attempt: Attempt): boolean {
        const offer = attempt.offer;
        if (attempt.request.shuffleId !== undefined) return false;
        return attempt.request.episode === true || offer.manual || offer.episodeLoading || offer.deckLoading || offer.episode !== undefined || offer.deck.length > 0 || offer.episodeFailed || offer.deckFailed;
    }

    private promptCountdown(attempt: Attempt, plan: { durationSeconds: number | undefined }): number | undefined {
        const prompt = attempt.prompt;
        if (prompt === undefined || prompt.loading === true || prompt.failed === true || prompt.fromDeck || prompt.next === undefined || !attempt.autoNext) return undefined;
        const remaining = (plan.durationSeconds ?? Infinity) - attempt.sourceSeconds;
        if (attempt.offer.manual && remaining >= MANUAL_COUNTDOWN_THRESHOLD_SECONDS) return undefined;
        return Math.max(0, Math.ceil(remaining));
    }

    private updatePrompt(attempt: Attempt): void {
        if (attempt.request.shuffleId !== undefined) return;
        if (!this.inPromptWindow(attempt)) {
            attempt.promptDismissed = false;
            if (!attempt.offer.manual) this.clearPrompt(attempt);
            else this.paintRect(attempt);
            return;
        }
        if (attempt.promptDismissed || attempt.hidden || attempt.busy) return;
        if (!attempt.offer.started) this.beginDiscovery(attempt);
        else {
            // Discovery starts at the first frame (#698), so a read that failed then is read once more when the window opens.
            // Each read is retried once on its own: one may still be out when the other's retry starts.
            const offer = attempt.offer;
            if (!offer.episodeWindowRetried && offer.episodeFailed && !offer.episodeLoading) {
                offer.episodeWindowRetried = true;
                this.retryEpisode(attempt);
            }
            if (!offer.deckWindowRetried && offer.deckFailed && !offer.deckLoading) {
                offer.deckWindowRetried = true;
                this.retryDeck(attempt);
            }
            this.publishOffer(attempt);
        }
    }

    private beginDiscovery(attempt: Attempt): void {
        if (attempt.offer.started || attempt.request.shuffleId !== undefined) return;
        attempt.offer.started = true;
        attempt.offer.episodeLoading = attempt.request.episode === true;
        attempt.offer.deckLoading = true;
        void this.discover(attempt);
    }

    private retryEpisode(attempt: Attempt): void {
        attempt.offer.episodeLoading = true;
        attempt.offer.episodeFailed = false;
        void this.discover(attempt, "episode");
    }

    private retryDeck(attempt: Attempt): void {
        attempt.offer.deckLoading = true;
        attempt.offer.deckFailed = false;
        void this.discover(attempt, "deck");
    }

    private reportPosition(attempt: Attempt): number {
        const duration = attempt.plan?.durationSeconds;
        return attempt.prompt !== undefined && duration !== undefined && attempt.promptSeconds > 0 && duration - attempt.sourceSeconds >= 0 && duration - attempt.sourceSeconds <= attempt.promptSeconds ? duration : attempt.sourceSeconds;
    }

    /** The Resolution cap that ranks the next pick. A cap read still in flight is waited for; a failed one reads as no cap. */
    private async pickQuality(signal: AbortSignal): Promise<string | undefined> {
        const cap = this.deps.resolutionCap;
        if (cap === undefined) return undefined;
        await cap.ready(signal);
        return cap.quality;
    }

    /** A seek does not cancel this read. Only a new attempt or an aborted session does. */
    private async discover(attempt: Attempt, part: "all" | "episode" | "deck" = "all"): Promise<void> {
        const read = <T>(spec: RequestSpec<T>): Promise<T> => this.deps.session.call({ ...spec, profileScoped: true, signal: attempt.signal });
        const live = (): boolean => this.active() === attempt && !attempt.signal.aborted;
        const capRead = this.pickQuality(attempt.signal);
        if (part !== "deck") {
            try {
                if (attempt.autoNextSupported) {
                    const epoch = attempt.settingsEpoch;
                    try {
                        const values = await read(operations.effectiveSettings([AUTO_NEXT_KEY]));
                        if (live() && epoch === attempt.settingsEpoch) attempt.autoNext = values.get(AUTO_NEXT_KEY)?.value === true;
                    } catch { if (live() && epoch === attempt.settingsEpoch) attempt.autoNext = false; }
                }
                if (attempt.request.episode === true) {
                    const fileId = attempt.plan?.effectiveMediaFileId;
                    if (fileId === undefined) throw new ApiError({ kind: "invalid_response", path: "playback_plan.effective_media_file_id" });
                    const next = await nextEpisode(read, attempt.request.contentId, fileId, attempt.request.seriesTitle, await capRead);
                    if (!live()) return;
                    attempt.offer.episode = next;
                    attempt.offer.episodeSettled = true;
                    attempt.offer.episodeFailed = false;
                } else if (live()) {
                    attempt.offer.episode = undefined;
                    attempt.offer.episodeSettled = true;
                    attempt.offer.episodeFailed = false;
                }
            } catch (error) {
                if (!live() || (error instanceof ApiError && error.aborted)) return;
                attempt.offer.episode = undefined;
                attempt.offer.episodeSettled = false;
                attempt.offer.episodeFailed = true;
            } finally {
                if (live()) {
                    attempt.offer.episodeLoading = false;
                    this.publishOffer(attempt);
                }
            }
        }
        if (part === "episode" || !live()) return;
        try {
            const quality = await capRead;
            const deck = await readOnDeck(read, attempt.request.contentId, items => {
                if (!live()) return;
                attempt.offer.deck = items.slice();
                this.publishOffer(attempt);
            }, quality);
            if (!live()) return;
            attempt.offer.deck = deck.slice();
            attempt.offer.deckSettled = true;
            attempt.offer.deckFailed = false;
        } catch (error) {
            if (!live() || (error instanceof ApiError && error.aborted)) return;
            attempt.offer.deckFailed = true;
            attempt.offer.deckSettled = false;
        } finally {
            if (live()) {
                attempt.offer.deckLoading = false;
                this.publishOffer(attempt);
            }
        }
    }

    private publishOffer(attempt: Attempt): void {
        if (this.active() !== attempt) return;
        const offer = attempt.offer;
        const showManual = offer.manual && !attempt.hidden;
        const showAuto = !offer.manual && this.inPromptWindow(attempt) && !attempt.promptDismissed && !attempt.hidden && !attempt.busy;
        if (!showManual && !showAuto) {
            this.clearPrompt(attempt);
            this.showPlayback(attempt);
            return;
        }
        const episodeReady = offer.episodeSettled && !offer.episodeFailed;
        const episode = episodeReady ? offer.episode : undefined;
        const fromDeck = episode === undefined && episodeReady && !offer.episodeLoading && !offer.deckFailed && offer.deck.length > 0;
        const displayed = fromDeck ? offer.deck[0] : episode;
        const loading = displayed === undefined && (offer.episodeLoading || (offer.deckLoading && !offer.episodeFailed));
        const failed = displayed === undefined && !loading && (offer.episodeFailed || offer.deckFailed);
        // An automatic prompt waits for a real choice. A loading or empty read must not shrink the video or move the reported position.
        if (!showManual && displayed === undefined && offer.deck.length === 0) {
            this.clearPrompt(attempt);
            this.showPlayback(attempt);
            return;
        }
        attempt.prompt = { next: displayed, deck: offer.deckFailed ? [] : offer.deck, fromDeck, ...(loading ? { loading: true } : {}), ...(failed ? { failed: true } : {}) };
        this.paintRect(attempt);
        this.showPlayback(attempt);
        if (displayed !== undefined && !fromDeck && attempt.offer.presentationFor !== displayed.contentId) {
            attempt.offer.presentationFor = displayed.contentId;
            this.loadPresentation(displayed, attempt.signal, enriched => {
                if (this.active() !== attempt || attempt.offer.episode?.contentId !== displayed.contentId || attempt.prompt?.next?.contentId !== displayed.contentId) return;
                attempt.offer.episode = enriched;
                attempt.prompt = { ...attempt.prompt, next: enriched };
                this.showPlayback(attempt);
            });
        }
    }

    private clearPrompt(attempt: Attempt): void {
        if (attempt.offer.manual) return;
        if (attempt.prompt === undefined && !attempt.rectPending) return;
        attempt.prompt = undefined;
        this.paintRect(attempt);
    }

    private paintRect(attempt: Attempt): void {
        try {
            this.setDisplayRect(attempt);
            attempt.rectPending = false;
        } catch {
            attempt.rectPending = true;
        }
    }

    private setDisplayRect(attempt: Attempt): void {
        // tvOS standard-card column: 4 × 360 + 3 × 40; preview spans two cards.
        if (attempt.prompt !== undefined) this.deps.avplay.setDisplayRect(upNextPreviewLeft(SCREEN.width, textIsRightToLeft()), UP_NEXT_PREVIEW.top, UP_NEXT_PREVIEW.width, UP_NEXT_PREVIEW.height);
        else this.deps.avplay.setDisplayRect(0, 0, SCREEN.width, SCREEN.height);
    }

    private loadPresentation(request: PlayRequest, signal: AbortSignal, accept: (request: PlayRequest) => void): void {
        void this.deps.session.call({ ...operations.getCatalogItem(request.contentId), profileScoped: true, signal }).then(detail => {
            if (!signal.aborted && detail.id === request.contentId) {
                const watch = playbackWatch(detail.watch);
                // Apple's backgroundArtwork (PlayerView.swift) takes the episode still first. On the S95C a next season's first episode's item
                // carried no backdrop, or the series backdrop, where its season row had the still, so the item's backdrop wins only when it is a still or the row has none.
                const rowStill = request.episode === true && present(request.backdropUrl) && request.backdropIsEpisodeStill !== false;
                const itemWins = present(detail.backdropUrl) && (detail.backdropIsEpisodeStill === true || !rowStill);
                const still = itemWins ? { backdropUrl: detail.backdropUrl, backdropIsEpisodeStill: detail.backdropIsEpisodeStill } : { backdropUrl: request.backdropUrl, backdropIsEpisodeStill: request.backdropIsEpisodeStill };
                accept({ ...request, overview: detail.overview ?? request.overview, ...still, ...(watch === undefined ? {} : { watch }) });
            }
        }, () => undefined);
    }

    /** Apple TV hides an unstarted episode synopsis when the profile asks (`PlayerView.swift` metadata). */
    private shownNext(request: PlayRequest | undefined): PlayRequest | undefined {
        if (request?.episode !== true) return request;
        const settings = this.deps.spoilers?.() ?? { hidesImages: false, hidesOverviews: false };
        const presentation = episodeDetailPresentation({
            type: "episode",
            overview: request.overview,
            watch: request.watch,
            played: request.watch?.played,
            backdropUrl: request.backdropUrl,
            backdropIsEpisodeStill: request.backdropIsEpisodeStill,
        }, settings);
        const overview = presentation.overview;
        const hideBackdrop = presentation.hideBackdrop ? true as const : undefined;
        if (overview === request.overview && hideBackdrop === undefined) return request;
        return { ...request, ...(overview === request.overview ? {} : { overview }), ...(hideBackdrop === undefined ? {} : { hideBackdrop }) };
    }

    /**
     * Cue times are absolute source time. After a resume seek, AVPlay's clock is the picture
     * and the plan's source start can still be 0 until the next playhead callback.
     */
    private captionInstant(attempt: Attempt, plan: PlaybackPlan): number {
        const sync = attempt.subtitleSync / 1000;
        if (attempt.started) {
            try {
                const milliseconds = this.deps.avplay.getCurrentTime();
                if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds / 1000 + plan.timeline.timelineOffsetSeconds - sync;
            } catch { /* The last reported source time still places the cue. */ }
        }
        return attempt.sourceSeconds - sync;
    }

    private show(view: PlaybackView): void {
        this.base = view;
        const attempt = this.attempt;
        if (attempt !== undefined && attempt.live) {
            const serial = ++this.shown;
            this.syncBuffering(attempt);
            // The sync can draw a newer view of its own (a pill, a restore that began a change): this one is stale.
            if (this.shown !== serial) return;
            if (view.phase === "loading" || view.phase === "playing" || view.phase === "paused") {
                const { pill, notice } = attempt.bufferingQuality;
                if (pill !== undefined || notice !== undefined) view = { ...view, ...(pill === undefined ? {} : { bufferingPill: pill }), ...(notice === undefined ? {} : { bufferingNotice: notice }) };
            }
        }
        this.current = view;
        for (const listener of this.listeners.slice()) {
            listener(view);
        }
    }

    /** RFC 4122 version 4 UUID: a valid playback_attempt_id, replan_request_id, plan_attempt_id and stop_id. */
    private newId(): string {
        const bytes = new Uint8Array(16);
        this.deps.randomBytes(bytes);
        bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
        bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
        let hex = "";
        bytes.forEach((byte) => {
            hex += (byte + 0x100).toString(16).slice(1);
        });
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
}

function samplePaused(attempt: Attempt): boolean {
    return attempt.presented ? attempt.paused : true;
}

/** The tracks a later replan keeps, including a subtitle applied on the open stream. */
function chosenTracks(attempt: Attempt, plan: PlaybackPlan): SelectedTracks {
    const audio = plan.selectedTracks.audio;
    const id = shownSubtitle(attempt, plan);
    if (id === undefined) return { ...(audio === undefined ? {} : { audio }) };
    const planned = plan.selectedTracks.subtitle;
    const subtitle = planned !== undefined && planned.id === id ? planned : { id };
    return { ...(audio === undefined ? {} : { audio }), subtitle };
}

/** The shown subtitle. An override of `undefined` is Off even when the plan still names a track. */
function shownSubtitle(attempt: Attempt, plan: PlaybackPlan): string | undefined {
    const override = attempt.subtitleOverride;
    return override !== undefined ? override.id : selectedSubtitle(plan);
}

function retryableStart(error: PlaybackError): boolean {
    return error.kind === "network" || error.kind === "server" || error.kind === "settings" || (error.kind === "terminal" && error.retryable);
}

/** The failed start again. A plan that already chose a position keeps that position. */
function sameStart(attempt: Attempt): PlayRequest {
    const request = attempt.request;
    if (attempt.plan === undefined || request.startSeconds === attempt.sourceSeconds) return request;
    return { ...request, startSeconds: attempt.sourceSeconds };
}

/** SECONDARY is offered while the app draws the primary subtitle, which stays in the list dimmed. */
function secondaryView(attempt: Attempt, plan: PlaybackPlan): Pick<TrackView, "secondary"> {
    if (attempt.captionKey === undefined || shownSubtitle(attempt, plan) === undefined) return {};
    const rows = orderedInventory(secondaryRows(plan), attempt.orderingLanguage);
    if (rows.length === 0) return {};
    return { secondary: { choices: rows.map(row => ({ ...subtitleChoice(row, undefined), ...(row.trackId === shownSubtitle(attempt, plan) ? { unavailable: true } : {}) })), selectedId: attempt.secondaryId } };
}

/** The selected tracks, speed, phase and media host the Stats and Info rows need beside the plan. */
function liveStats(attempt: Attempt, plan: PlaybackPlan, baseUrl: string): LiveStats {
    const fileId = plan.effectiveMediaFileId;
    const version = attempt.tracks?.state === "ready" ? attempt.tracks.versions.find(candidate => candidate.fileId === fileId) : undefined;
    const ordinal = version?.audio.findIndex((_, index) => `file:${fileId}:audio:${index}` === plan.selectedTracks.audio?.id) ?? -1;
    const track = version?.audio[ordinal];
    const shown = shownSubtitle(attempt, plan);
    const entry = shown === undefined ? undefined : plan.subtitle.inventory.find(row => row.trackId === shown);
    let host: string | undefined;
    try { host = new URL(plan.streamUrl, baseUrl).hostname || undefined; } catch { host = undefined; }
    return {
        audio: track === undefined ? undefined : { track, ordinal },
        subtitle: entry === undefined ? undefined : { entry, generated: attempt.ai?.view?.results.find(result => entry.syncKey === `stored-${result.id}`)?.label },
        speed: attempt.hud.speed,
        status: attempt.buffering ? "Rebuffering" : attempt.paused ? "Paused" : "Playing",
        host,
    };
}

function trackView(attempt: Attempt, plan: PlaybackPlan): TrackView {
    const tracks = attempt.tracks;
    const notices: string[] = [];
    for (const warning of plan.warnings) {
        const notice = WARNING_NOTICES[warning.code];
        if (notice !== undefined && notices.indexOf(notice) === -1) {
            notices.push(notice);
        }
    }
    if (plan.subtitle.mode === "render" || plan.subtitle.mode === "convert") {
        if (attempt.captionNotice) notices.push(captionNoticeText(attempt.captionNotice));
        if (attempt.captionPreferenceNotice) notices.push(attempt.captionPreferenceNotice);
    }
    const sync = attempt.sync?.view;
    const shownKey = plan.subtitle.inventory.find(track => track.trackId === shownSubtitle(attempt, plan))?.syncKey;
    return {
        ai: aiView(attempt, plan),
        aiMenu: aiMenuView(attempt, plan),
        seriesSubtitle: attempt.seriesSubtitle,
        quality: {
            choices: qualityChoices(plan),
            selectedId: attempt.qualityPreference === "auto" ? "auto" : attempt.serverFeatures.includes("plan_active_quality_v1")
                ? qualityChoices(plan).find((quality) => quality.id === plan.activeQuality && quality.id !== "auto")?.id
                : attempt.qualityPicked ? plan.availableQualities.find((quality) => quality.label === attempt.qualityPreference)?.label : undefined,
        },
        audio: tracks === undefined || tracks.state !== "ready" ? { state: tracks?.state ?? "loading" } : { state: "ready", choices: audioChoices(attempt, plan) },
        selectedAudioId: plan.selectedTracks.audio?.id,
        // SubtitleDisplayOrder: display position only; every row keeps the id it selects.
        subtitles: orderedInventory(plan.subtitle.inventory, attempt.orderingLanguage).map((entry) => {
            const generated = attempt.ai?.view?.results.find(result => entry.syncKey === `stored-${result.id}`)?.label;
            const choice = subtitleChoice(entry, generated);
            // HUDTrackRow's attributes, then the track's sync status ("Syncing… 40%", "Synced −3.0 s"); an unsupported format says so instead.
            const status = entry.unplayable === true || entry.syncKey === undefined ? undefined : sync?.status[entry.syncKey];
            return status === undefined ? choice : { ...choice, detail: choice.detail === undefined || choice.detail === "" ? status : `${choice.detail} · ${status}` };
        }),
        selectedSubtitleId: shownSubtitle(attempt, plan),
        subtitleMode: shownSubtitle(attempt, plan) === undefined ? "off" : plan.subtitle.mode === "off" ? "render" : plan.subtitle.mode,
        change: attempt.change,
        reporting: attempt.reporting,
        notices,
        ...(shownKey === undefined || sync?.timing[shownKey] === undefined ? {} : { syncTiming: sync.timing[shownKey] }),
        ...(secondaryView(attempt, plan)),
        ...(attempt.search === undefined ? {} : { subtitleTools: { search: attempt.search.view, ...(attempt.display?.view === undefined ? {} : { display: attempt.display.view }), overlay: subtitleOverlay(attempt, plan) } }),
    };
}

/** Delay and styling apply to overlay cues. AVPlay-drawn text and burn-in have no offset or style path here. */
/** The identity of a plan's drawn subtitle file, as `readCaptions` keys its read. */
function captionKeyOf(plan: PlaybackPlan): string | undefined {
    const artifact = plan.subtitle.mode === "render" || plan.subtitle.mode === "convert" ? plan.subtitle.artifact : undefined;
    return artifact === undefined ? undefined : `${artifact.format} ${artifact.origin} ${artifact.url}`;
}

function subtitleOverlay(attempt: Attempt, plan: PlaybackPlan): boolean {
    const id = shownSubtitle(attempt, plan);
    if (id === undefined) return true;
    if (plan.subtitle.mode === "burn_in") return false;
    // The app draws the plan's artifact even for an embedded row: `readCaptions` keys it, and every AVPlay TEXT switch clears the key.
    if (id === plan.subtitle.trackId && (attempt.captionKey !== undefined || attempt.captionNotice === CAPTION_FAILED)) return true;
    const row = plan.subtitle.inventory.find(entry => entry.trackId === id);
    return row === undefined || !inStreamCandidate(plan, row);
}

function qualityChoices(plan: PlaybackPlan): TrackChoice[] {
    const offered = plan.availableQualities.filter((quality) => quality.label !== "original" && quality.label !== "auto");
    return offered.length === 0 ? [] : [{ id: "auto", label: translate("options.auto") }, ...offered.map((quality) => ({ id: quality.label, label: qualityMenuLabel(quality) }))];
}

/** The effective edition's audio tracks; empty until the versions read answers. */
function audioChoices(attempt: Attempt, plan: PlaybackPlan): TrackChoice[] {
    const tracks = attempt.tracks;
    const fileId = plan.effectiveMediaFileId;
    const version = tracks?.state === "ready" ? tracks.versions.find((candidate) => candidate.fileId === fileId) : undefined;
    return (version?.audio ?? []).map((track, ordinal) => ({ id: `file:${fileId}:audio:${ordinal}`, ...audioRow(track, ordinal) }));
}

/** The shown subtitle; `off` means none even when the plan still names a track. */
function selectedSubtitle(plan: PlaybackPlan): string | undefined {
    return plan.subtitle.mode === "off" ? undefined : plan.subtitle.trackId;
}

/** The format a sidecar's URL names, when the app can draw it. */
function secondaryFormat(row: SubtitleTrack): string | undefined {
    if (row.url === undefined) return undefined;
    try {
        const extension = new URL(row.url, "https://sidecar.invalid").pathname.split(".").pop()?.toLowerCase();
        return extension === "vtt" || extension === "srt" || extension === "ass" || extension === "ssa" ? extension : undefined;
    } catch {
        // The inventory is the server's; a URL that cannot be parsed is not a track the app can draw.
        return undefined;
    }
}

/** Text sidecars the app can draw as the second line, primary included (it is listed dimmed, as Apple lists it). */
function secondaryRows(plan: PlaybackPlan): readonly SubtitleTrack[] {
    return plan.subtitle.inventory.filter(row => row.delivery === "sidecar" && row.unplayable !== true && textSubtitle(row.codec) && secondaryFormat(row) !== undefined);
}

function textSubtitle(codec: string | undefined): boolean {
    return codec !== undefined && ["srt", "subrip", "webvtt", "vtt", "ass", "ssa", "mov_text", "text"].includes(codec.toLowerCase());
}

/** A listed HLS rendition, or Off while one is showing. Burn-in is not a rendition switch. */
function renditionSwitch(plan: PlaybackPlan, trackId: string | undefined): boolean {
    if (plan.streamProtocol !== "hls") return false;
    if (trackId === undefined) return plan.subtitle.hlsRendition !== undefined || plan.subtitle.inventory.some((row) => row.hlsRendition !== undefined);
    return plan.subtitle.inventory.find((row) => row.trackId === trackId)?.hlsRendition !== undefined;
}

function inStreamCandidate(plan: PlaybackPlan, row: SubtitleTrack): boolean {
    if (row.delivery === "burn_in_only" || row.source === "external" || row.source === "downloaded") return false;
    if (plan.streamProtocol === "hls") return row.hlsRendition !== undefined;
    return plan.delivery === "original_http" && row.source === "embedded" && textSubtitle(row.codec);
}

function textTrackIndex(tracks: readonly AVPlayTrackInfo[], row: SubtitleTrack, languageOnly: boolean): number | undefined {
    const text = tracks.filter((track) => track.type === "TEXT");
    const ordinal = row.hlsRendition?.index;
    const published = ordinal === undefined ? undefined : text[ordinal - 1];
    if (!languageOnly && published !== undefined) return published.index;
    // An original file's TEXT rows are numbered by the file's stream index, which the server publishes as `stream_index`
    // (the S95C selected English SDH, artifact 9.vtt, as TEXT 12 after one video and two audio streams). A file can hold several tracks in one language.
    const language = canonicalLanguageKey(row.language);
    if (languageOnly && row.streamIndex !== undefined) {
        const stream = text.find(track => track.index === row.streamIndex);
        // A row in another known language means AVPlay numbers this file differently: match by language instead.
        const other = stream === undefined ? undefined : canonicalLanguageKey(trackLanguage(stream));
        if (stream !== undefined && (language === undefined || other === undefined || other === language)) return stream.index;
    }
    if (language !== undefined) {
        const matches = text.filter((track) => canonicalLanguageKey(trackLanguage(track)) === language);
        const match = matches.length === 1 ? matches[0] : undefined;
        if (match !== undefined) return match.index;
    }
    if (languageOnly) return undefined;
    return ordinal === undefined ? undefined : text[ordinal - 1]?.index;
}

function trackLanguage(track: AVPlayTrackInfo): string | undefined {
    try {
        const extra: unknown = JSON.parse(track.extra_info);
        if (typeof extra !== "object" || extra === null || !("track_lang" in extra)) return undefined;
        const language = extra.track_lang;
        return typeof language === "string" ? language.toLowerCase() : undefined;
    } catch {
        return undefined;
    }
}

function streamRenditionAnswer(plan: PlaybackPlan, id: string | undefined): boolean {
    if (id === undefined) return plan.subtitle.mode === "off";
    const row = plan.subtitle.inventory.find((entry) => entry.trackId === id);
    return row?.hlsRendition !== undefined && plan.subtitle.mode !== "burn_in" && plan.subtitle.mode !== "off" && plan.subtitle.mode !== "unknown";
}

/**
 * Same original file and stream path. AVPlay cannot send headers, so a renewed `st` is still
 * this picture. A sidecar or Off draws here. An audio change, a burn-in, a native row with no
 * artifact, or a different native embedded selection does not.
 */
function sameDirectTransport(current: PlaybackPlan, next: PlaybackPlan, requested?: SelectedTracks): boolean {
    if (!sameDirectStreamUrl(current.streamUrl, next.streamUrl) || current.delivery !== "original_http" || next.delivery !== "original_http") return false;
    if (current.effectiveMediaFileId !== next.effectiveMediaFileId || current.streamProtocol !== next.streamProtocol) return false;
    if (current.timeline.streamOriginSeconds !== next.timeline.streamOriginSeconds || current.timeline.timelineOffsetSeconds !== next.timeline.timelineOffsetSeconds) return false;
    if (!samePlanAudio(current.selectedTracks.audio, next.selectedTracks.audio)) return false;
    if (requestedAudioChanges(current.selectedTracks.audio, requested?.audio)) return false;
    if (current.subtitle.mode === "burn_in" || next.subtitle.mode === "burn_in" || current.subtitle.mode === "unknown" || next.subtitle.mode === "unknown") return false;
    if ((next.subtitle.mode === "render" || next.subtitle.mode === "convert") && next.subtitle.artifact === undefined) return false;
    if (nativeEmbeddedSelection(current) !== nativeEmbeddedSelection(next)) return false;
    if ((current.recipe !== undefined || next.recipe !== undefined) && !sameRecipe(current.recipe, next.recipe)) return false;
    return true;
}

/** Same path and query, ignoring a renewed `st`. A different path or any other query value is a new stream. */
function sameDirectStreamUrl(current: string, next: string): boolean {
    if (current === next) return true;
    let left: URL;
    let right: URL;
    try {
        left = new URL(current, "https://stream.invalid");
        right = new URL(next, "https://stream.invalid");
    } catch {
        return false;
    }
    if (left.protocol !== right.protocol || left.host !== right.host || left.pathname !== right.pathname || left.hash !== right.hash) return false;
    const keys = new Set<string>();
    for (const key of left.searchParams.keys()) keys.add(key);
    for (const key of right.searchParams.keys()) keys.add(key);
    for (const key of keys) {
        if (key === "st") continue;
        const leftValues = left.searchParams.getAll(key);
        const rightValues = right.searchParams.getAll(key);
        if (leftValues.length !== rightValues.length || leftValues.some((value, index) => value !== rightValues[index])) return false;
    }
    return true;
}

function samePlanAudio(current: TrackIdentity | undefined, next: TrackIdentity | undefined): boolean {
    return current?.id === next?.id && current?.index === next?.index;
}

/** The viewer asked for different audio. Apple reloads on that change even when the answer keeps the previous track. */
function requestedAudioChanges(current: TrackIdentity | undefined, requested: TrackIdentity | undefined): boolean {
    if (requested === undefined) return false;
    if (requested.id !== current?.id) return true;
    return requested.index !== undefined && requested.index !== current?.index;
}

/**
 * The native embedded text this direct-play plan binds, or none when the overlay draws a sidecar.
 * Apple reloads when this identity changes: `subtitle.embedded`, or a render/convert row with no artifact.
 */
function nativeEmbeddedSelection(plan: PlaybackPlan): string | undefined {
    if (plan.subtitle.embedded !== undefined) return `embedded:${plan.subtitle.embedded.streamIndex}`;
    if ((plan.subtitle.mode !== "render" && plan.subtitle.mode !== "convert") || plan.subtitle.artifact !== undefined) return undefined;
    const id = plan.subtitle.trackId;
    if (id === undefined) return undefined;
    const row = plan.subtitle.inventory.find((entry) => entry.trackId === id);
    if (row === undefined || !inStreamCandidate(plan, row)) return undefined;
    return `${id}\n${row.streamIndex ?? ""}\n${row.nativeSelectable === true ? "1" : "0"}`;
}

function keepsHlsTransport(current: PlaybackPlan, next: PlaybackPlan): boolean {
    return current.streamProtocol === "hls"
        && next.streamProtocol === "hls"
        && current.streamUrl === next.streamUrl
        && current.delivery === next.delivery
        && current.effectiveMediaFileId === next.effectiveMediaFileId
        && current.expiresAt !== undefined
        && current.expiresAt === next.expiresAt
        && current.timeline.streamOriginSeconds === next.timeline.streamOriginSeconds
        && current.timeline.timelineOffsetSeconds === next.timeline.timelineOffsetSeconds
        && sameRecipe(current.recipe, next.recipe)
        && current.selectedTracks.audio?.id === next.selectedTracks.audio?.id
        && current.selectedTracks.audio?.index === next.selectedTracks.audio?.index
        && sameRenditions(current, next);
}

function sameRecipe(left: PlaybackPlan["recipe"], right: PlaybackPlan["recipe"]): boolean {
    return left !== undefined && right !== undefined
        && left.videoCodec === right.videoCodec
        && left.audioCodec === right.audioCodec
        && left.width === right.width
        && left.height === right.height
        && left.bitrateKbps === right.bitrateKbps;
}

function sameRenditions(left: PlaybackPlan, right: PlaybackPlan): boolean {
    const current = renditionSlots(left);
    const next = renditionSlots(right);
    const keys = Object.keys(current);
    return keys.length > 0 && keys.length === Object.keys(next).length && keys.every((key) => current[key] === next[key]);
}

function renditionSlots(plan: PlaybackPlan): Record<string, string> {
    const slots: Record<string, string> = {};
    for (const row of plan.subtitle.inventory) {
        const rendition = row.hlsRendition;
        if (rendition !== undefined) slots[row.trackId] = `${rendition.groupId}\n${rendition.name}\n${rendition.index}`;
    }
    return slots;
}

function playbackWatch(watch: { readonly played: boolean; readonly isInProgress?: boolean; readonly positionSeconds?: number | undefined } | undefined): PlayRequest["watch"] {
    if (watch === undefined) return undefined;
    return {
        played: watch.played,
        ...(watch.isInProgress === undefined ? {} : { isInProgress: watch.isInProgress }),
        ...(watch.positionSeconds === undefined ? {} : { positionSeconds: watch.positionSeconds }),
    };
}

/** The session itself is gone or the request was abandoned: not a track change the viewer can retry. */
/** The server answered and refused the replan, so it holds the plan it had. A missing or unusable answer proves nothing. */
function rejectedReplan(error: unknown): boolean {
    return error instanceof ApiError && !unanswered(error) && error.failure.kind !== "invalid_response";
}

function sessionGone(error: unknown): boolean {
    return error instanceof ApiError && (error.aborted || error.status === 404 || error.status === 410 || error.problemId === "installation_changed");
}

function decisionFailure(decision: PlaybackDecision): PlaybackError {
    return decision.outcome === "adaptation_unavailable" ? { kind: "terminal", ...decision.terminal } : { kind: "server" };
}

function startFailure(error: unknown): PlaybackError {
    if (error instanceof ApiError) {
        const kind = error.failure.kind;
        if (kind === "network" || kind === "timeout") {
            return { kind: "network" };
        }
        if (error.problemId === "installation_changed") {
            return { kind: "installation_changed" };
        }
    }
    return { kind: "server" };
}
