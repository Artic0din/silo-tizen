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
// audio_tracks entry. The server packages the route; AVPlay track indices are never used. A
// refused change leaves the current plan playing.

import { type Clock, sleep } from "../api/clock.ts";
import { ApiError } from "../api/errors.ts";
import { abortedError, type RequestSpec } from "../api/http.ts";
import { operations } from "../api/operations.ts";
import type { AudioTrackInfo, FileVersionTracks, PlaybackDecision, PlaybackDefaults, PlaybackMutation, PlaybackPlan, ReplanOperation, SelectedTracks, StartPlaybackBody, SubtitleTrack } from "../contracts/v2/playback.ts";
import type { RandomBytes } from "../session/deviceIdentity.ts";
import type { NativeSession } from "../session/session.ts";
import type { AVPlay, AVPlayListener } from "./avplay.ts";
import { CLIENT_CAPABILITIES, CLIENT_FEATURES, playbackContext } from "./capabilities.ts";
import { SeekThumbnails, type ThumbnailSheetLoader } from "./seekThumbnails.ts";
import { QUALITY_KEY, BITRATE_KEY, SEEK_BACK_KEY, SEEK_FORWARD_KEY, SEEK_KEYS, profileSettings } from "../contracts/v2/settings.ts";
import type { SeekThumbnail } from "../contracts/v2/trickplay.ts";
import { nextEpisode } from "./nextEpisode.ts";
import { PlaybackRecovery, recoveryVerdict, type RecoveryStep, type RecoveryVerdict, unanswered } from "./playbackRecovery.ts";

/** What browse hands over: one file of one catalog item. */
export interface PlayRequest {
    readonly episode?: true;
    readonly audioTrackId?: string;
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
    readonly label: string;
}

export type AudioTracks = { readonly state: "loading" } | { readonly state: "failed" } | { readonly state: "ready"; readonly choices: readonly TrackChoice[] };

export type TrackChange =
    | { readonly state: "idle" }
    | { readonly state: "changing"; readonly kind?: "quality" }
    /** The server refused the choice; the current plan keeps playing. */
    | { readonly state: "refused"; readonly message: string }
    | { readonly state: "failed" };

export interface TrackView {
    readonly quality?: { readonly choices: readonly TrackChoice[]; readonly selectedId: string | undefined };
    readonly audio: AudioTracks;
    readonly selectedAudioId: string | undefined;
    readonly subtitles: readonly TrackChoice[];
    /** Undefined: subtitles off. */
    readonly selectedSubtitleId: string | undefined;
    readonly subtitleMode: string;
    readonly change: TrackChange;
    readonly notices: readonly string[];
}

export type PlaybackView =
    | { readonly phase: "completion"; readonly title: string; readonly state: "finalizing" | "resolving" | "ready" | "failed"; readonly next: PlayRequest | undefined; readonly retryable: boolean }
    | { readonly phase: "loading"; readonly title: string; readonly detail?: "reconnecting" | "restoring" }
    | {
          readonly phase: "playing" | "paused";
          readonly title: string;
          /** Source time. */
          readonly positionSeconds: number;
          readonly durationSeconds: number | undefined;
          readonly buffering: boolean;
          readonly tracks: TrackView;
          readonly seekIntervals: { readonly backward: number; readonly forward: number };
          readonly previewKey?: string | undefined;
      }
    | { readonly phase: "error"; readonly title: string; readonly error: PlaybackError; readonly retryable?: boolean }
    | { readonly phase: "closed" };

/** What the player screen drives. */
export interface PlayerControls {
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
    playNext(): void;
    seekThumbnail(seconds: number, signal: AbortSignal, loadSheet: ThumbnailSheetLoader): Promise<SeekThumbnail | undefined>;
}

export interface PlaybackDeps {
    readonly session: NativeSession;
    readonly avplay: AVPlay;
    readonly clock: Clock;
    readonly randomBytes: RandomBytes;
    /** `webapis.productinfo.getRealModel()` and the package version, for the server's device-quirk match. */
    readonly device: { readonly model: string; readonly appVersion: string };
    readonly exits: PlaybackExits;
}

const PROGRESS_INTERVAL_MS = 10000;
/** The server keeps a fresh plan 90 s, enough for a 60 s startup and the next replan (protocol v3 §2.5). */
const STARTUP_TIMEOUT_MS = 60000;
/** Failed routes this client replans before giving up; the protocol allows up to 8. */
const MAX_RECOVERY_REPLANS = 3;
/** Waits before resending an identical start, replan or stop that got no usable answer. */
const RESEND_DELAYS_MS = [1000, 2000];
/** AVPlay's display coordinates are in the app's 1920x1080 space. */
const SCREEN = { width: 1920, height: 1080 };

type TrackInfo = { readonly state: "loading" | "failed" } | { readonly state: "ready"; readonly versions: readonly FileVersionTracks[] };

/** Plain-text notices for the plan's degradation warnings a viewer can notice (protocol v3 §7.2). */
const WARNING_NOTICES: Readonly<Record<string, string>> = {
    subtitle_burn_in: "Subtitles are burned into the video.",
    audio_track_unavailable: "The chosen audio track isn't in this version, so its default track is playing.",
    subtitle_track_unavailable: "The chosen subtitles aren't available in this version, so subtitles are off.",
};

interface Attempt {
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
    batchedSettings: boolean;
    serverFeatures: readonly string[];
    trickplayEnabled: boolean;
    thumbnails: SeekThumbnails | undefined;
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
    progress: Promise<void> | undefined;
    cancelTimer: (() => void) | undefined;
    stopSpec: RequestSpec<PlaybackMutation> | undefined;
    stopped: boolean;
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
    private completion: { readonly attempt: Attempt; readonly abort: AbortController; pending: boolean } | undefined;
    private nextStart: PlayRequest | undefined;

    constructor(deps: PlaybackDeps) {
        this.deps = deps;
        const pending = pendingTransports.get(deps.avplay) ?? { seek: undefined, closing: undefined };
        pendingTransports.set(deps.avplay, pending);
        this.pending = pending;
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

    /** Starts a new attempt; one already running is stopped and never plays. */
    play(request: PlayRequest): void {
        if (this.completion !== undefined) return;
        const previous = this.attempt;
        if (previous !== undefined) {
            this.leave(previous, "stop");
        }
        this.shownError = undefined;
        const attempt: Attempt = {
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
            batchedSettings: true,
            serverFeatures: [],
            trickplayEnabled: false,
            thumbnails: undefined,
            started: false,
            presented: false,
            hidden: false,
            suspended: false,
            suspendedReady: false,
            deferredOpen: false,
            restoring: false,
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
            progress: undefined,
            cancelTimer: undefined,
            stopSpec: undefined,
            stopped: false,
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

    togglePause(): void {
        const attempt = this.active();
        if (attempt !== undefined) this.setPaused(!attempt.paused);
    }

    setPaused(paused: boolean): void {
        const attempt = this.active();
        if (attempt === undefined || !attempt.started || (attempt.busy && !(attempt.change.state === "changing" && attempt.change.kind === "quality")) || attempt.paused === paused) {
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
        if (attempt !== undefined) this.seekToSeconds(attempt.sourceSeconds + seconds);
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
        const attempt = this.active();
        const plan = attempt?.plan;
        if (attempt === undefined || plan === undefined || !attempt.started || attempt.busy) {
            return;
        }
        const duration = plan.durationSeconds;
        const target = Math.max(0, Math.min(seconds, duration ?? Number.MAX_VALUE));
        const timeline = plan.timeline;
        const local =
            timeline.canSeekAnywhere &&
            target >= timeline.timelineOffsetSeconds &&
            (timeline.seekWindowStartSeconds === undefined || target >= timeline.seekWindowStartSeconds) &&
            (timeline.seekWindowEndSeconds === undefined || target <= timeline.seekWindowEndSeconds);
        attempt.busy = true;
        this.clearThumbnails(attempt);
        if (!local) {
            // An open or partial window has no bytes there yet: the server re-anchors the timeline.
            this.closeTransport();
            attempt.started = false;
            this.show({ phase: "loading", title: attempt.request.title });
            void this.replan(attempt, plan, "seek_reanchor", target, undefined);
            return;
        }
        const transport = this.transport;
        const settled = (moved: boolean): void => {
            if (transport !== this.transport || !attempt.live) {
                return;
            }
            attempt.busy = false;
            if (moved) {
                attempt.sourceSeconds = target;
            }
            const failure = attempt.seekFailure;
            attempt.seekFailure = undefined;
            if (failure !== undefined) {
                this.routeFailed(attempt, failure);
                return;
            }
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
        attempt.resumeGeneration += 1;
        attempt.restoring = false;
        attempt.hidden = true;
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
        const subtitle = plan.subtitle.mode === "off" ? undefined : plan.selectedTracks.subtitle;
        this.changeTracks(attempt, plan, { audio: { id: trackId }, ...(subtitle === undefined ? {} : { subtitle }) });
    }

    selectSubtitle(trackId: string | undefined): void {
        const attempt = this.changeable();
        const plan = attempt?.plan;
        if (attempt === undefined || plan === undefined || trackId === selectedSubtitle(plan)) {
            return;
        }
        if (trackId !== undefined && !plan.subtitle.inventory.some((entry) => entry.trackId === trackId)) {
            return;
        }
        const audio = plan.selectedTracks.audio;
        this.changeTracks(attempt, plan, { ...(audio === undefined ? {} : { audio }), ...(trackId === undefined ? {} : { subtitle: { id: trackId } }) });
    }

    retryTrackInfo(): void {
        const attempt = this.active();
        if (attempt !== undefined && attempt.tracks?.state === "failed") {
            this.readTracks(attempt);
        }
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
        const audio = plan.selectedTracks.audio;
        const subtitle = plan.subtitle.mode === "off" ? undefined : plan.selectedTracks.subtitle;
        const selected = { ...(audio === undefined ? {} : { audio }), ...(subtitle === undefined ? {} : { subtitle }) };
        const offered = plan.availableQualities.find((quality) => quality.label === preference);
        const cap = preference === "auto" ? attempt.autoBandwidthCapKbps
            : offered !== undefined && !offered.preservesSource && offered.bitrateKbps !== undefined && offered.bitrateKbps > 0 ? offered.bitrateKbps : undefined;
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
        this.listeners.length = 0;
    }

    // --- planning ---

    private async readSeekIntervals(attempt: Attempt): Promise<boolean> {
        const call = <T>(spec: RequestSpec<T>): Promise<T> => this.deps.session.call({ ...spec, profileScoped: true, signal: attempt.signal });
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
            if (capability.apiVersion !== 1 || capability.state !== "available" || !capability.allowed || !capability.scopes.includes("profile") || capability.manifestRevision < 9) return true;
            const contract = await call(operations.settingsContract());
            if (!attempt.live) return false;
            if (contract.apiVersion !== 1 || contract.revision < capability.manifestRevision) throw new Error("Settings contract changed");
            const definitions = profileSettings(contract, capability);
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
            if (attempt.live) this.fail(attempt, { kind: "settings" }, false);
            return false;
        }
    }

    private async begin(attempt: Attempt): Promise<void> {
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
            const start = operations.startPlayback({
                installation_id: installationId,
                protocol_version: 3,
                client_features: CLIENT_FEATURES,
                file_id: attempt.request.fileId,
                profile_id: profile.id,
                playback_attempt_id: attempt.playbackAttemptId,
                quality_preference: attempt.qualityPreference,
                ...(attempt.bandwidthCapKbps === undefined ? {} : { bandwidth_cap_kbps: attempt.bandwidthCapKbps }),
                subtitle_fidelity_preference: "compatible",
                ...(attempt.request.startSeconds === undefined ? {} : { start_position: attempt.request.startSeconds }),
                ...(attempt.request.audioTrackId === undefined ? {} : { audio_track_id: attempt.request.audioTrackId }),
                ...(attempt.request.allowAlternateVersions === undefined ? {} : { allow_alternate_versions: attempt.request.allowAlternateVersions }),
                client_capabilities: CLIENT_CAPABILITIES,
                client_playback_context: playbackContext(this.deps.device.model, this.deps.device.appVersion),
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
        this.adopt(attempt, decision.plan, decision.serverFeatures);
    }

    private async replan(
        attempt: Attempt,
        plan: PlaybackPlan,
        operation: ReplanOperation,
        positionSeconds: number,
        classification: string | undefined,
        selected: SelectedTracks = plan.selectedTracks,
        quality: PlaybackDefaults = attempt,
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
            client_features: CLIENT_FEATURES,
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
            position_seconds: positionSeconds,
            selected_tracks: selected,
            ...(classification === undefined ? {} : { failure: { classification } }),
            client_capabilities: CLIENT_CAPABILITIES,
            client_playback_context: playbackContext(this.deps.device.model, this.deps.device.appVersion),
        });
        let decision: PlaybackDecision;
        try {
            decision = await this.resend(attempt, () => {
                if (!current()) throw abortedError();
                return this.deps.session.call({ ...replan, profileScoped: true, signal: attempt.signal });
            });
        } catch (error) {
            if (!current()) {
                return;
            }
            if ((operation === "track_change" || operation === "quality_change") && unanswered(error) && attempt.presented
                && (attempt.recovery?.active === true || (error instanceof ApiError && error.transient))) {
                attempt.change = { state: "failed" };
                attempt.busy = false;
                this.recoverConnection(attempt);
                return;
            }
            // A missing or unusable answer cannot prove that the server rolled the change back.
            if (operation === "track_change" && error instanceof ApiError && !error.transient && error.failure.kind !== "invalid_response" && !sessionGone(error)) {
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
            // The server rolled the change back; the current plan and transport keep playing.
            this.changeSettled(attempt, { state: "refused", message: decision.terminal.message });
            return;
        }
        attempt.busy = false;
        if (decision.outcome === "playable") {
            if (decision.sessionId !== sessionId) {
                this.fail(attempt, { kind: "server" }, true);
                return;
            }
            if (operation === "quality_change") {
                attempt.qualityPreference = quality.qualityPreference;
                attempt.bandwidthCapKbps = quality.bandwidthCapKbps;
                attempt.qualityPicked = true;
            }
            this.adopt(attempt, decision.plan, decision.serverFeatures);
        } else {
            this.fail(attempt, decisionFailure(decision), true);
        }
    }

    /** A codec or route failure on this TV: the server picks the next route, a bounded number of times. */
    private routeFailed(attempt: Attempt, classification: string): void {
        const plan = attempt.plan;
        if (!attempt.live || plan === undefined) {
            return;
        }
        if (attempt.busy) {
            if (attempt.change.state === "changing") {
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

    private changeTracks(attempt: Attempt, plan: PlaybackPlan, selected: SelectedTracks): void {
        this.clearThumbnails(attempt);
        attempt.busy = true;
        attempt.change = { state: "changing" };
        this.showPlayback(attempt);
        void this.replan(attempt, plan, "track_change", attempt.sourceSeconds, undefined, selected);
    }

    private changeSettled(attempt: Attempt, change: TrackChange): void {
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

    private adopt(attempt: Attempt, plan: PlaybackPlan, serverFeatures: readonly string[]): void {
        this.clearThumbnails(attempt);
        attempt.plan = plan;
        attempt.serverFeatures = serverFeatures;
        attempt.suspended = false;
        attempt.suspendedReady = false;
        attempt.deferredOpen = false;
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
        this.showLoading(attempt, attempt.resuming ? "reconnecting" : undefined);
        void this.open(attempt, plan);
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
            if (media.protocol !== "https:") {
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
        const avplay = this.deps.avplay;
        try {
            avplay.open(url);
            avplay.setListener(this.listen(attempt, transport));
            avplay.setDisplayRect(0, 0, SCREEN.width, SCREEN.height);
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
            try {
                this.deps.avplay.play();
                if (attempt.paused) {
                    this.deps.avplay.pause();
                }
            } catch {
                this.routeFailed(attempt, "avplay_play_failed");
                return;
            }
            attempt.started = true;
            attempt.presented = true;
            attempt.resuming = false;
            if (attempt.recovery?.active === true) attempt.recovery.recovered(this.deps.clock.now());
            if (attempt.cancelTimer === undefined) {
                this.scheduleProgress(attempt);
            }
            this.showPlayback(attempt);
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
                if (current() && attempt.started && (!attempt.busy || attempt.change.state === "changing") && plan !== undefined) {
                    attempt.sourceSeconds = milliseconds / 1000 + plan.timeline.timelineOffsetSeconds;
                    this.showPlayback(attempt);
                }
            },
            onstreamcompleted: () => {
                if (!current() || !attempt.started) return;
                if (attempt.busy) {
                    if (attempt.change.state === "changing") attempt.endedDuringChange = true;
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
                    this.recoverConnection(attempt);
                } else {
                    this.routeFailed(attempt, "avplay_playback_error");
                }
            },
        };
    }

    private beginCompletion(attempt: Attempt): void {
        attempt.endedDuringChange = false;
        this.leave(attempt, "abandon");
        this.nextStart = undefined;
        this.completion = { attempt, abort: new AbortController(), pending: false };
        this.retryCompletion();
    }

    private closeTransport(): void {
        this.transport++;
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
            position: attempt.sourceSeconds,
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

    private async stopSession(attempt: Attempt): Promise<void> {
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
            position: attempt.sourceSeconds,
            is_paused: samplePaused(attempt),
        });
        attempt.stopSpec = spec;
        if (attempt.stopRetryAt > this.deps.clock.now()) await sleep(this.deps.clock, attempt.stopRetryAt - this.deps.clock.now(), attempt.signal, abortedError);
        const receipt = await this.resend(attempt, async () => {
            try {
                return await this.deps.session.call({ ...spec, profileScoped: true, signal: attempt.signal });
            } catch (error) {
                if (error instanceof ApiError) attempt.stopRetryAt = this.deps.clock.now() + (error.retryAfterSeconds ?? 0) * 1000;
                throw error;
            }
        });
        if ((receipt.outcome !== "stopped" && receipt.outcome !== "replayed") || (receipt.stopId !== undefined && receipt.stopId !== spec.body?.stop_id)) {
            throw new ApiError({ kind: "invalid_response", path: "playback_stop.receipt" });
        }
        attempt.stopped = true;
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
            if (this.nextStart !== undefined && this.shownError !== undefined && retryableStart(this.shownError)) this.play(this.nextStart);
            return;
        }
        const view = this.current;
        if (view.phase === "completion" && view.state === "failed" && !view.retryable) return;
        if (completion.pending || completion.abort.signal.aborted || completion.attempt.signal.aborted) return;
        completion.pending = true;
        void this.finishCompletion(completion);
    }

    playNext(): void {
        const view = this.current;
        if (view.phase !== "completion" || view.state !== "ready" || view.next === undefined || this.completion?.attempt.stopped !== true) return;
        const request = view.next;
        this.cancelCompletion();
        this.nextStart = request;
        this.play(request);
    }

    private cancelCompletion(): void {
        this.completion?.abort.abort();
        this.completion = undefined;
    }

    private async finishCompletion(completion: NonNullable<PlaybackController["completion"]>): Promise<void> {
        const { attempt, abort } = completion;
        const current = (): boolean => this.completion === completion && this.attempt === attempt && !abort.signal.aborted && !attempt.signal.aborted && attempt.signal === this.deps.session.authoritySignal;
        const show = (state: "finalizing" | "resolving" | "ready" | "failed", next?: PlayRequest, retryable = false): void => {
            if (current()) this.show({ phase: "completion", title: "Playback ended", state, next, retryable });
        };
        show("finalizing");
        try {
            await this.stopSession(attempt);
            if (!current()) return;
            if (attempt.request.episode !== true) {
                this.cancelCompletion();
                this.attempt = undefined;
                this.show({ phase: "closed" });
                this.deps.exits.onEnd("completed");
                return;
            }
            show("resolving");
            const fileId = attempt.plan?.effectiveMediaFileId;
            if (fileId === undefined) throw new ApiError({ kind: "invalid_response", path: "playback_plan.effective_media_file_id" });
            const next = await nextEpisode(spec => {
                if (!current()) throw abortedError();
                return this.deps.session.call({ ...spec, profileScoped: true, signal: abort.signal });
            }, attempt.request.contentId, fileId);
            show("ready", next);
        } catch (error) {
            const missingSession = error instanceof ApiError && error.status === 404 && !attempt.stopped;
            const forbidden = missingSession || (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 410 || error.problemId === "installation_changed"));
            show("failed", undefined, !forbidden);
        } finally {
            completion.pending = false;
        }
    }

    // --- endings ---

    /** Leaves an attempt: no callback of it acts again. `stop` also ends its server session. */
    private leave(attempt: Attempt, how: "stop" | "abandon"): void {
        if (!attempt.live) {
            return;
        }
        attempt.live = false;
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
        this.show({ phase: "error", title: attempt.request.title, error, retryable: this.nextStart !== undefined && !attempt.started && retryableStart(error) });
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
        attempt.suspended = false;
        attempt.suspendedReady = false;
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
        const current = (): boolean => this.attempt === attempt && attempt.live && recovery.active && recovery.generation === generation && attempt.sessionId === sessionId;
        attempt.recoveryPending = true;
        recovery.beginAttempt();
        try {
            if (recovery.step === "start") {
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
            const verdict = recoveryVerdict(error, recovery.step);
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
            client_features: CLIENT_FEATURES,
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
            position_seconds: attempt.sourceSeconds,
            selected_tracks: keptTracks(plan),
            client_capabilities: CLIENT_CAPABILITIES,
            client_playback_context: playbackContext(this.deps.device.model, this.deps.device.appVersion),
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
        const subtitle = plan.subtitle.mode === "off" ? undefined : plan.subtitle.trackId ?? plan.selectedTracks.subtitle?.id;
        return {
            installation_id: installationId,
            protocol_version: 3,
            client_features: CLIENT_FEATURES,
            file_id: plan.effectiveMediaFileId,
            profile_id: profile.id,
            playback_attempt_id: this.newId(),
            quality_preference: attempt.qualityPreference,
            ...(attempt.bandwidthCapKbps === undefined ? {} : { bandwidth_cap_kbps: attempt.bandwidthCapKbps }),
            subtitle_fidelity_preference: "compatible",
            start_position: attempt.sourceSeconds,
            ...(audio === undefined ? {} : { audio_track_id: audio }),
            ...(subtitle === undefined ? {} : { subtitle_track_id: subtitle }),
            ...(attempt.request.allowAlternateVersions === undefined ? {} : { allow_alternate_versions: attempt.request.allowAlternateVersions }),
            client_capabilities: CLIENT_CAPABILITIES,
            client_playback_context: playbackContext(this.deps.device.model, this.deps.device.appVersion),
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
                const retired: Attempt = { ...attempt, playbackAttemptId: body.playback_attempt_id, sessionId: decision.sessionId, sequence: 0, stopped: false, stopSpec: undefined, stopRetryAt: 0, progress: undefined, progressRefusal: undefined };
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
            attempt.stopSpec = undefined;
            attempt.progress = undefined;
            attempt.progressRefusal = undefined;
            attempt.replacementBody = undefined;
            attempt.resuming = true;
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
        if (!current()) {
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
                    attempt.suspended = false;
                    attempt.suspendedReady = false;
                    attempt.deferredOpen = false;
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
                if (attempt.paused) {
                    this.deps.avplay.pause();
                }
                attempt.started = true;
                attempt.presented = true;
                attempt.resuming = false;
                if (attempt.recovery?.active === true) attempt.recovery.recovered(this.deps.clock.now());
                this.showPlayback(attempt);
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
        return new Promise((resolve) => {
            try {
                restore.call(this.deps.avplay, url, resumeMs, false, () => {
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
        });
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
        if (media.protocol !== "https:") {
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

    /** Resends the identical request after no answer or a transient refusal; the contract replays it. */
    private async resend<T>(attempt: Attempt, send: () => Promise<T>): Promise<T> {
        for (let index = 0; ; index++) {
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
        if (this.attempt !== attempt || !attempt.live || !attempt.started || plan === undefined) {
            return;
        }
        this.show({
            phase: attempt.paused ? "paused" : "playing",
            title: attempt.request.title,
            positionSeconds: attempt.sourceSeconds,
            durationSeconds: plan.durationSeconds,
            buffering: attempt.buffering,
            tracks: trackView(attempt, plan),
            seekIntervals: attempt.seekIntervals,
            previewKey: attempt.busy ? undefined : attempt.planAttemptId,
        });
    }

    private show(view: PlaybackView): void {
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

/** The tracks a no-op reconnect keeps. Omitting a subtitle means subtitles stay off. */
function keptTracks(plan: PlaybackPlan): SelectedTracks {
    const audio = plan.selectedTracks.audio;
    const subtitle = plan.subtitle.mode === "off" ? undefined : plan.selectedTracks.subtitle;
    return { ...(audio === undefined ? {} : { audio }), ...(subtitle === undefined ? {} : { subtitle }) };
}

function retryableStart(error: PlaybackError): boolean {
    return error.kind === "network" || error.kind === "server" || error.kind === "settings" || (error.kind === "terminal" && error.retryable);
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
        // This client declares no subtitle rendering, so it cannot draw a sidecar it was given.
        notices.push("This TV can't show these subtitles.");
    }
    return {
        quality: {
            choices: qualityChoices(plan),
            selectedId: attempt.qualityPreference === "auto" ? "auto" : attempt.serverFeatures.includes("plan_active_quality_v1")
                ? qualityChoices(plan).find((quality) => quality.id === plan.activeQuality && quality.id !== "auto")?.id
                : attempt.qualityPicked ? plan.availableQualities.find((quality) => quality.label === attempt.qualityPreference)?.label : undefined,
        },
        audio: tracks === undefined || tracks.state !== "ready" ? { state: tracks?.state ?? "loading" } : { state: "ready", choices: audioChoices(attempt, plan) },
        selectedAudioId: plan.selectedTracks.audio?.id,
        subtitles: plan.subtitle.inventory.map((entry) => ({ id: entry.trackId, label: subtitleLabel(entry) })),
        selectedSubtitleId: selectedSubtitle(plan),
        subtitleMode: plan.subtitle.mode,
        change: attempt.change,
        notices,
    };
}

function qualityChoices(plan: PlaybackPlan): TrackChoice[] {
    const offered = plan.availableQualities.filter((quality) => quality.label !== "original" && quality.label !== "auto");
    return offered.length === 0 ? [] : [{ id: "auto", label: "Auto" }, ...offered.map((quality) => ({ id: quality.label, label: quality.displayName || quality.label }))];
}

/** The effective edition's audio tracks; empty until the versions read answers. */
function audioChoices(attempt: Attempt, plan: PlaybackPlan): TrackChoice[] {
    const tracks = attempt.tracks;
    const fileId = plan.effectiveMediaFileId;
    const version = tracks?.state === "ready" ? tracks.versions.find((candidate) => candidate.fileId === fileId) : undefined;
    return (version?.audio ?? []).map((track, ordinal) => ({ id: `file:${fileId}:audio:${ordinal}`, label: audioLabel(track, ordinal) }));
}

/** The shown subtitle; `off` means none even when the plan still names a track. */
function selectedSubtitle(plan: PlaybackPlan): string | undefined {
    return plan.subtitle.mode === "off" ? undefined : plan.subtitle.trackId;
}

function languageText(language: string | undefined): string | undefined {
    return language === undefined || language === "" || language === "und" ? undefined : language.toUpperCase();
}

function audioLabel(track: AudioTrackInfo, ordinal: number): string {
    const parts = [track.title ?? languageText(track.language) ?? `Track ${ordinal + 1}`];
    const channels = track.channels;
    if (channels !== undefined && channels > 0) {
        parts.push(channels === 1 ? "Mono" : channels === 2 ? "Stereo" : channels === 6 ? "5.1" : channels === 8 ? "7.1" : `${channels} channels`);
    }
    if (track.codec !== undefined && track.codec !== "") {
        parts.push(track.codec.toUpperCase());
    }
    return parts.join(" · ");
}

function subtitleLabel(entry: SubtitleTrack): string {
    const parts = [entry.label ?? languageText(entry.language) ?? `Subtitles ${entry.combinedIndex + 1}`];
    if (entry.forced) {
        parts.push("Forced");
    }
    if (entry.hearingImpaired) {
        parts.push("SDH");
    }
    return parts.join(" · ");
}

/** The session itself is gone or the request was abandoned: not a track change the viewer can retry. */
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
