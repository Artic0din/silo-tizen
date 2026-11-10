// Theme music for title pages, ported from silo-apple ThemeMusicController.swift and ThemeMusicCenter.swift
// (Screens/Detail/ThemeMusic), which follow the web player in silo-server. The first theme of the page's set
// plays quietly while the page is open, and only for the profile that opted in on a server that reports
// the capability. Themes are optional: a refused grant or a failed stream only leaves the page silent.
import { systemClock, type Clock } from "../api/clock.ts";
import type { ThemePlayback, ThemeSongSet } from "../contracts/v2/themeMusic.ts";

/** Background level under the page, as on the web and Apple TV. */
export const THEME_VOLUME = 0.35;
/** How long a capability answer stands before the next page asks again. */
export const CAPABILITY_LIFETIME_MS = 60_000;
const RAMP_STEPS = 12;
const RAMP_STEP_MS = 25;

/** One theme's audio. The production output is an `<audio>` element and holds the only copy of the signed URL. */
export interface ThemeAudioOutput {
    volume: number;
    /** Loops in place. Only original audio can: it supports byte ranges. */
    loops: boolean;
    readonly playing: boolean;
    onEnded: (() => void) | undefined;
    onFailed: (() => void) | undefined;
    /** Playback advanced past the start. */
    onProgress: (() => void) | undefined;
    play(): void;
    pause(): void;
    /** Stops for good and releases the media and its URL. */
    tearDown(): void;
}

export type Grant = (ownerId: string, themeId: string) => Promise<ThemePlayback>;
export type MakeOutput = (grant: ThemePlayback) => ThemeAudioOutput;
/** Ramps `output` to a volume, then calls `done`. */
export type Fade = (output: ThemeAudioOutput, target: number, done: () => void) => void;

/** fade: ease out. silence: stop at once, leaving a theme already fading out to finish. handOff: stop everything at once for a player that is starting. */
export type StopMode = "fade" | "silence" | "handOff";

/** Twelve steps over 300 ms, as on the web. A new ramp on the same output replaces the one in progress. */
export function createVolumeRamp(clock: Clock = systemClock): Fade {
    const ramps = new WeakMap<ThemeAudioOutput, () => void>();
    return (output, target, done) => {
        ramps.get(output)?.();
        const start = output.volume;
        let step = 0;
        const tick = (): void => {
            step++;
            output.volume = Math.max(0, Math.min(1, start + (target - start) * step / RAMP_STEPS));
            if (step < RAMP_STEPS) { ramps.set(output, clock.schedule(tick, RAMP_STEP_MS)); return; }
            ramps.delete(output);
            done();
        };
        ramps.set(output, clock.schedule(tick, RAMP_STEP_MS));
    };
}

export class ThemeMusicController {
    private readonly grant: Grant;
    private readonly makeOutput: MakeOutput;
    private readonly fade: Fade;
    private output: ThemeAudioOutput | undefined;
    private load: Promise<void> | undefined;
    /** Bumped by every load and stop; a callback or grant from an older one is ignored. */
    private generation = 0;
    private owner = "";
    private theme = "";
    private loop = false;
    private converted = false;
    private played = false;
    private retry = 0;
    private suspended = false;
    /** The theme played to its end and nothing replays it; the page keeps it selected so staying open does not start it again. */
    private finished = false;
    /** Stopped outputs still fading out, so an immediate stop can silence them. */
    private readonly retiring = new Set<ThemeAudioOutput>();

    constructor(grant: Grant, makeOutput: MakeOutput, fade: Fade = createVolumeRamp()) {
        this.grant = grant;
        this.makeOutput = makeOutput;
        this.fade = fade;
    }

    /** Plays `selection`'s first theme, or stops when there is none. */
    select(selection: ThemeSongSet | undefined, loop: boolean): void {
        this.loop = loop;
        if (this.output !== undefined) this.output.loops = loop && !this.converted;
        const song = selection?.items[0];
        if (selection === undefined || song === undefined) {
            this.stop();
            return;
        }
        if (this.owner === selection.ownerId && this.theme === song.id) {
            if (this.suspended) {
                this.suspended = false;
                if (this.output !== undefined) this.resume(this.output);
                else if (!this.finished) this.startLoad();
            }
            return;
        }
        this.stop();
        this.owner = selection.ownerId;
        this.theme = song.id;
        this.retry = 0;
        this.startLoad();
    }

    /** Fades out and pauses, keeping the theme so selecting it again resumes in place. */
    suspend(): void {
        this.suspended = true;
        const output = this.output;
        if (output === undefined) {
            if (!this.finished) this.stop("silence");
            return;
        }
        this.fade(output, 0, () => {
            if (this.suspended && this.output === output) output.pause();
        });
    }

    stop(mode: StopMode = "fade"): void {
        this.suspended = false;
        this.finished = false;
        this.generation++;
        this.owner = "";
        this.theme = "";
        if (mode === "handOff") {
            for (const output of this.retiring) output.tearDown();
            this.retiring.clear();
        }
        const output = this.output;
        if (output === undefined) return;
        this.output = undefined;
        detach(output);
        if (mode !== "fade" || !output.playing) {
            output.tearDown();
            return;
        }
        this.retiring.add(output);
        this.fade(output, 0, () => {
            if (this.retiring.delete(output)) output.tearDown();
        });
    }

    /** Resolves once no grant request is in flight. For tests. */
    async waitUntilSettled(): Promise<void> {
        while (this.load !== undefined) {
            const pending = this.load;
            await pending;
            if (this.load === pending) this.load = undefined;
        }
    }

    private startLoad(): void {
        const generation = ++this.generation;
        const owner = this.owner;
        const theme = this.theme;
        this.load = this.grant(owner, theme).then(granted => {
            if (generation === this.generation) this.attach(granted, generation);
        }, () => undefined);
    }

    private attach(granted: ThemePlayback, generation: number): void {
        this.clearOutput();
        const output = this.makeOutput(granted);
        this.output = output;
        this.converted = granted.converted;
        this.played = false;
        this.finished = false;
        output.volume = 0;
        output.loops = this.loop && !this.converted;
        output.onProgress = () => {
            if (generation !== this.generation) return;
            const started = !this.played;
            this.played = true;
            this.retry = 0;
            // The fade-in waits for audible audio: a converted theme is buffered first, and a fade run meanwhile would end before it.
            if (started && !this.suspended) this.fade(output, THEME_VOLUME, () => undefined);
        };
        output.onEnded = () => {
            if (generation !== this.generation) return;
            // A converted stream cannot seek back and its URL may have expired, so a loop replays it with a fresh grant.
            // One that ended without playing spends the same single retry as a failure, so a clean conversion failure cannot replay forever.
            if (this.converted && this.loop && (this.played || this.spendRetry())) {
                // Ended while suspended: drop the output but not the theme, so returning replays it with a fresh grant.
                if (this.suspended) this.clearOutput();
                else this.startLoad();
                return;
            }
            this.finished = true;
            this.clearOutput();
        };
        output.onFailed = () => {
            if (generation !== this.generation) return;
            this.clearOutput();
            if (!this.suspended && this.spendRetry()) this.startLoad();
        };
        this.resume(output);
    }

    private resume(output: ThemeAudioOutput): void {
        if (this.suspended) return;
        output.play();
        // Before its audio has started, `onProgress` fades it in.
        if (this.played) this.fade(output, THEME_VOLUME, () => undefined);
    }

    private spendRetry(): boolean {
        return this.retry++ === 0;
    }

    private clearOutput(): void {
        const output = this.output;
        if (output === undefined) return;
        this.output = undefined;
        detach(output);
        output.tearDown();
    }
}

function detach(output: ThemeAudioOutput): void {
    output.onEnded = undefined;
    output.onFailed = undefined;
    output.onProgress = undefined;
}

/** What the open title page reports to theme music. The page sends a fresh value whenever any part changes. */
export interface ThemeMusicPage {
    /** The page item's server-resolved set; a season or episode page carries its inherited set. */
    readonly themes: ThemeSongSet | undefined;
    /** The page is still resolving what it shows. */
    readonly isLoading: boolean;
    /** On screen, in the foreground and not covered. */
    readonly isVisible: boolean;
    readonly enabled: boolean;
    readonly loop: boolean;
}

/** Decides when the app's single theme player plays: only when the profile opted in and the server reports the capability, suspended while the page is hidden or resolving, and stopped at once when other media starts. */
export class ThemeMusicCenter {
    private readonly controller: ThemeMusicController;
    private readonly capability: () => Promise<boolean>;
    private readonly clock: Clock;
    private page: ThemeMusicPage | undefined;
    private otherMedia = false;
    private answer: { readonly available: boolean; readonly at: number } | undefined;
    private asking: Promise<void> | undefined;
    /** Bumped by `reset`, so an answer asked for an earlier identity is dropped. */
    private epoch = 0;

    constructor(controller: ThemeMusicController, capability: () => Promise<boolean>, clock: Clock = systemClock) {
        this.controller = controller;
        this.capability = capability;
        this.clock = clock;
    }

    /** The open page changed, or there is none (undefined). `otherMediaActive`: a video is playing or about to open, whatever page is showing. */
    update(page: ThemeMusicPage | undefined, otherMediaActive = false): void {
        this.page = page;
        this.otherMedia = otherMediaActive;
        this.apply();
    }

    /** Sign-out or a profile change: stop and forget the capability answer. */
    reset(): void {
        this.epoch++;
        this.controller.stop("silence");
        this.answer = undefined;
        this.asking = undefined;
        this.page = undefined;
        this.otherMedia = false;
    }

    /** Resolves once no capability or grant request is in flight. For tests. */
    async waitUntilSettled(): Promise<void> {
        for (;;) {
            const asking = this.asking;
            if (asking !== undefined) await asking;
            await this.controller.waitUntilSettled();
            if (this.asking === undefined) return;
        }
    }

    private apply(): void {
        const page = this.page;
        if (this.otherMedia) {
            this.controller.stop("handOff");
            return;
        }
        if (page === undefined || !page.enabled) {
            this.controller.stop();
            return;
        }
        const available = this.available();
        if (available === undefined) return;
        if (!available) {
            this.controller.stop();
            return;
        }
        if (!page.isVisible || page.isLoading) {
            this.controller.suspend();
            return;
        }
        this.controller.select(page.themes, page.loop);
    }

    /** The capability, asking when there is no fresh answer. Undefined until the first answer arrives. */
    private available(): boolean | undefined {
        const fresh = this.answer !== undefined && this.clock.now() - this.answer.at < CAPABILITY_LIFETIME_MS;
        if (!fresh && this.asking === undefined) {
            const epoch = this.epoch;
            const asking = this.capability().catch(() => false).then(available => {
                if (epoch !== this.epoch) return;
                this.answer = { available, at: this.clock.now() };
                this.asking = undefined;
                this.apply();
            });
            this.asking = asking;
        }
        return this.answer?.available;
    }
}
