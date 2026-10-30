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
import { abortedError } from "../api/http.ts";
import { operations } from "../api/operations.ts";
import type { AudioTrackInfo, FileVersionTracks, PlaybackDecision, PlaybackPlan, ReplanOperation, SelectedTracks, SubtitleTrack } from "../contracts/v2/playback.ts";
import type { RandomBytes } from "../session/deviceIdentity.ts";
import type { NativeSession } from "../session/session.ts";
import type { AVPlay, AVPlayListener } from "./avplay.ts";
import { CLIENT_CAPABILITIES, CLIENT_FEATURES, playbackContext } from "./capabilities.ts";

/** What browse hands over: one file of one catalog item. */
export interface PlayRequest {
    readonly contentId: string;
    readonly fileId: string;
    readonly title: string;
    /** Source seconds; undefined lets the server resume from the profile's saved position. */
    readonly startSeconds: number | undefined;
}

export type EndReason = "completed" | "ended_by_server" | "authority_changed";

export type PlaybackError =
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
    | { readonly state: "changing" }
    /** The server refused the choice; the current plan keeps playing. */
    | { readonly state: "refused"; readonly message: string }
    | { readonly state: "failed" };

export interface TrackView {
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
    | { readonly phase: "loading"; readonly title: string }
    | {
          readonly phase: "playing" | "paused";
          readonly title: string;
          /** Source time. */
          readonly positionSeconds: number;
          readonly durationSeconds: number | undefined;
          readonly buffering: boolean;
          readonly tracks: TrackView;
      }
    | { readonly phase: "error"; readonly title: string; readonly error: PlaybackError }
    | { readonly phase: "closed" };

/** What the player screen drives. */
export interface PlayerControls {
    subscribe(listener: (view: PlaybackView) => void): () => void;
    togglePause(): void;
    /** Source seconds, negative to go back. */
    seekBy(seconds: number): void;
    back(): void;
    /** Ends the attempt safely; authenticated suspension/restore belongs to recovery. */
    background(): void;
    dismissError(): void;
    selectAudio(trackId: string): void;
    /** Undefined turns subtitles off. */
    selectSubtitle(trackId: string | undefined): void;
    retryTrackInfo(): void;
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
const QUALITY_PREFERENCE = "auto";
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
    readonly playbackAttemptId: string;
    /** The session's authority signal when the attempt began. */
    readonly signal: AbortSignal;
    live: boolean;
    installationId: string | undefined;
    sessionId: string | undefined;
    plan: PlaybackPlan | undefined;
    planAttemptId: string;
    readonly attemptedKeys: string[];
    recoveries: number;
    sequence: number;
    sourceSeconds: number;
    paused: boolean;
    /** The current transport is playing or paused. */
    started: boolean;
    buffering: boolean;
    /** A seek or replan (including a track change) is in flight. */
    busy: boolean;
    /** The item's versions, read once per attempt for the audio menu. */
    tracks: TrackInfo | undefined;
    trackRead: number;
    change: TrackChange;
    /** A failed route reported while a track change was pending; recovered once it settles. */
    changeFailure: string | undefined;
    seekFailure: string | undefined;
    progress: Promise<void> | undefined;
    cancelTimer: (() => void) | undefined;
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

    constructor(deps: PlaybackDeps) {
        this.deps = deps;
        const pending = pendingTransports.get(deps.avplay) ?? { seek: undefined, closing: undefined };
        pendingTransports.set(deps.avplay, pending);
        this.pending = pending;
        this.stopAuthority = deps.session.onAuthorityChange(() => {
            const attempt = this.attempt;
            if (attempt === undefined || !attempt.live) {
                return;
            }
            this.leave(attempt, "abandon");
            this.attempt = undefined;
            this.show({ phase: "closed" });
            deps.exits.onEnd("authority_changed");
        });
    }

    /** Starts a new attempt; one already running is stopped and never plays. */
    play(request: PlayRequest): void {
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
            sessionId: undefined,
            plan: undefined,
            planAttemptId: this.newId(),
            attemptedKeys: [],
            recoveries: 0,
            sequence: 0,
            sourceSeconds: request.startSeconds ?? 0,
            paused: false,
            started: false,
            buffering: false,
            busy: false,
            tracks: undefined,
            trackRead: 0,
            change: { state: "idle" },
            changeFailure: undefined,
            seekFailure: undefined,
            progress: undefined,
            cancelTimer: undefined,
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
        if (attempt === undefined || !attempt.started || attempt.busy) {
            return;
        }
        try {
            if (attempt.paused) {
                this.deps.avplay.play();
            } else {
                this.deps.avplay.pause();
            }
            attempt.paused = !attempt.paused;
        } catch {
            // Not allowed in the player's state right now; the next key press tries again.
        }
        this.showPlayback(attempt);
    }

    seekBy(seconds: number): void {
        const attempt = this.active();
        const plan = attempt?.plan;
        if (attempt === undefined || plan === undefined || !attempt.started || attempt.busy) {
            return;
        }
        const duration = plan.durationSeconds;
        const target = Math.max(0, Math.min(attempt.sourceSeconds + seconds, duration ?? Number.MAX_VALUE));
        const timeline = plan.timeline;
        const local =
            timeline.canSeekAnywhere &&
            target >= timeline.timelineOffsetSeconds &&
            (timeline.seekWindowStartSeconds === undefined || target >= timeline.seekWindowStartSeconds) &&
            (timeline.seekWindowEndSeconds === undefined || target <= timeline.seekWindowEndSeconds);
        attempt.busy = true;
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
        const attempt = this.active();
        if (attempt !== undefined) {
            this.fail(attempt, { kind: "backgrounded" }, true);
        }
    }

    back(): void {
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

    dismissError(): void {
        const error = this.shownError;
        if (error === undefined) {
            return;
        }
        this.shownError = undefined;
        this.attempt = undefined;
        this.show({ phase: "closed" });
        this.deps.exits.onError(error);
    }

    /** Stops playback without an exit callback, for a parent that is tearing the screen down. */
    destroy(): void {
        const attempt = this.attempt;
        if (attempt !== undefined) {
            this.leave(attempt, "stop");
        }
        this.attempt = undefined;
        this.stopAuthority();
        this.listeners.length = 0;
    }

    // --- planning ---

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
            const start = operations.startPlayback({
                installation_id: installationId,
                protocol_version: 3,
                client_features: CLIENT_FEATURES,
                file_id: attempt.request.fileId,
                profile_id: profile.id,
                playback_attempt_id: attempt.playbackAttemptId,
                quality_preference: QUALITY_PREFERENCE,
                subtitle_fidelity_preference: "compatible",
                ...(attempt.request.startSeconds === undefined ? {} : { start_position: attempt.request.startSeconds }),
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
            void this.stopSession(attempt);
            return;
        }
        this.scheduleProgress(attempt);
        this.adopt(attempt, decision.plan);
    }

    private async replan(
        attempt: Attempt,
        plan: PlaybackPlan,
        operation: ReplanOperation,
        positionSeconds: number,
        classification: string | undefined,
        selected: SelectedTracks = plan.selectedTracks,
    ): Promise<void> {
        const sessionId = attempt.sessionId;
        const installationId = attempt.installationId;
        if (sessionId === undefined || installationId === undefined) {
            return;
        }
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
            quality_preference: QUALITY_PREFERENCE,
            position_seconds: positionSeconds,
            selected_tracks: selected,
            ...(classification === undefined ? {} : { failure: { classification } }),
            client_capabilities: CLIENT_CAPABILITIES,
            client_playback_context: playbackContext(this.deps.device.model, this.deps.device.appVersion),
        });
        let decision: PlaybackDecision;
        try {
            decision = await this.resend(attempt, () => this.deps.session.call({ ...replan, profileScoped: true, signal: attempt.signal }));
        } catch (error) {
            if (!attempt.live) {
                return;
            }
            // A missing or unusable answer cannot prove that the server rolled the change back.
            if (operation === "track_change" && error instanceof ApiError && !error.transient && error.failure.kind !== "invalid_response" && !sessionGone(error)) {
                this.changeSettled(attempt, { state: "failed" });
                return;
            }
            this.sessionFailure(attempt, error);
            return;
        }
        if (!attempt.live) {
            return;
        }
        if (operation === "track_change" && decision.outcome !== "playable") {
            // The server rolled the change back; the current plan and transport keep playing.
            this.changeSettled(attempt, decision.outcome === "adaptation_unavailable" ? { state: "refused", message: decision.terminal.message } : { state: "failed" });
            return;
        }
        attempt.busy = false;
        if (decision.outcome === "playable") {
            this.adopt(attempt, decision.plan);
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
        void this.replan(attempt, plan, "failure_recovery", attempt.sourceSeconds, classification);
    }

    // --- tracks ---

    /** The attempt, when nothing else is in flight: a pending seek or change makes a choice wait. */
    private changeable(): Attempt | undefined {
        const attempt = this.active();
        return attempt !== undefined && attempt.started && !attempt.busy ? attempt : undefined;
    }

    private changeTracks(attempt: Attempt, plan: PlaybackPlan, selected: SelectedTracks): void {
        attempt.busy = true;
        attempt.change = { state: "changing" };
        this.showPlayback(attempt);
        void this.replan(attempt, plan, "track_change", attempt.sourceSeconds, undefined, selected);
    }

    private changeSettled(attempt: Attempt, change: TrackChange): void {
        attempt.busy = false;
        attempt.change = change;
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

    private adopt(attempt: Attempt, plan: PlaybackPlan): void {
        attempt.plan = plan;
        attempt.change = { state: "idle" };
        attempt.changeFailure = undefined;
        if (attempt.tracks === undefined) {
            this.readTracks(attempt);
        }
        attempt.planAttemptId = this.newId();
        attempt.sourceSeconds = plan.timeline.sourceStartSeconds;
        attempt.started = false;
        this.show({ phase: "loading", title: attempt.request.title });
        void this.open(attempt, plan);
    }

    private async open(attempt: Attempt, plan: PlaybackPlan): Promise<void> {
        this.closeTransport();
        const transport = this.transport;
        await this.pending.closing;
        if (transport !== this.transport || !attempt.live) {
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
        const avplay = this.deps.avplay;
        try {
            avplay.open(url);
            avplay.setListener(this.listen(attempt, transport));
            avplay.setDisplayRect(0, 0, SCREEN.width, SCREEN.height);
            this.cancelStartup = this.deps.clock.schedule(() => {
                if (transport === this.transport && !attempt.started) {
                    this.routeFailed(attempt, "avplay_startup_timeout");
                }
            }, STARTUP_TIMEOUT_MS);
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
                        // The URL is valid but unreachable: a network or authorization failure, not the codec route.
                        this.fail(attempt, { kind: "network" }, true);
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
                if (current() && attempt.started) {
                    this.leave(attempt, "stop");
                    this.attempt = undefined;
                    this.show({ phase: "closed" });
                    this.deps.exits.onEnd("completed");
                }
            },
            onevent: () => undefined,
            onerror: (eventType) => {
                // Before the first frame, prepareAsync's own callbacks decide.
                if (!current() || !attempt.started) {
                    return;
                }
                if (eventType === "PLAYER_ERROR_CONNECTION_FAILED") {
                    this.fail(attempt, { kind: "network" }, true);
                } else {
                    this.routeFailed(attempt, "avplay_playback_error");
                }
            },
        };
    }

    private closeTransport(): void {
        this.transport++;
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
        attempt.cancelTimer = this.deps.clock.schedule(() => {
            if (!attempt.live) {
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
            is_paused: attempt.paused || !attempt.started,
        });
        attempt.progress = this.deps.session.call({ ...spec, profileScoped: true, signal: attempt.signal }).then(
            () => {
                attempt.progress = undefined;
            },
            (error: unknown) => {
                attempt.progress = undefined;
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
        const sessionId = attempt.sessionId;
        const installationId = attempt.installationId;
        if (sessionId === undefined || installationId === undefined) {
            return;
        }
        // Stop is the last word: it waits for the sample in flight and carries the next sequence.
        await attempt.progress;
        const spec = operations.stopPlayback(sessionId, {
            installation_id: installationId,
            stop_id: this.newId(),
            sequence: ++attempt.sequence,
            position: attempt.sourceSeconds,
            is_paused: attempt.paused || !attempt.started,
        });
        try {
            await this.resend(attempt, () => this.deps.session.call({ ...spec, profileScoped: true, signal: attempt.signal }));
        } catch {
            // Ended already (404, 410) or unreachable: the server ends an idle session itself.
        }
    }

    // --- endings ---

    /** Leaves an attempt: no callback of it acts again. `stop` also ends its server session. */
    private leave(attempt: Attempt, how: "stop" | "abandon"): void {
        if (!attempt.live) {
            return;
        }
        attempt.live = false;
        attempt.cancelTimer?.();
        if (this.attempt === attempt) {
            this.closeTransport();
        }
        if (how === "stop") {
            void this.stopSession(attempt);
        }
    }

    private fail(attempt: Attempt, error: PlaybackError, stopSession: boolean): void {
        this.leave(attempt, stopSession ? "stop" : "abandon");
        if (this.attempt !== attempt) {
            return;
        }
        this.shownError = error;
        this.show({ phase: "error", title: attempt.request.title, error });
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
            this.fail(attempt, { kind: "session_expired" }, false);
            return;
        }
        const failure = startFailure(error);
        this.fail(attempt, failure, failure.kind !== "installation_changed");
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
        audio: tracks === undefined || tracks.state !== "ready" ? { state: tracks?.state ?? "loading" } : { state: "ready", choices: audioChoices(attempt, plan) },
        selectedAudioId: plan.selectedTracks.audio?.id,
        subtitles: plan.subtitle.inventory.map((entry) => ({ id: entry.trackId, label: subtitleLabel(entry) })),
        selectedSubtitleId: selectedSubtitle(plan),
        subtitleMode: plan.subtitle.mode,
        change: attempt.change,
        notices,
    };
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
