// Theme audio through an HTML5 `<audio>` element, not AVPlay: AVPlay is a single instance that video owns.
// The server sends original audio (mp3, aac, flac, ogg, wav) or, for a format this Chromium cannot decode,
// progressive AAC in MP4, both of which `<audio>` plays; the web client plays them the same way.
// The signed URL goes into the element and nowhere else: nothing here logs or stores it.
import type { ThemePlayback } from "../contracts/v2/themeMusic.ts";
import type { ThemeAudioOutput } from "./themeMusic.ts";

type AudioElement = Pick<HTMLAudioElement, "addEventListener" | "removeEventListener" | "play" | "pause" | "load" | "removeAttribute" | "currentTime" | "volume" | "loop" | "preload" | "src">;

export class ElementThemeOutput implements ThemeAudioOutput {
    onEnded: (() => void) | undefined;
    onFailed: (() => void) | undefined;
    onProgress: (() => void) | undefined;
    private readonly audio: AudioElement;
    private active = false;
    private tornDown = false;
    private reportedProgress = false;
    private releaseGesture: (() => void) | undefined;
    private readonly listeners: readonly (readonly [string, () => void])[];

    constructor(playback: ThemePlayback, audio: AudioElement = new Audio()) {
        this.audio = audio;
        audio.preload = "auto";
        audio.volume = 0;
        this.listeners = [
            ["timeupdate", () => {
                if (this.reportedProgress || audio.currentTime <= 0) return;
                this.reportedProgress = true;
                this.onProgress?.();
            }],
            ["ended", () => this.onEnded?.()],
            ["error", () => this.onFailed?.()],
        ];
        for (const [name, listener] of this.listeners) audio.addEventListener(name, listener);
        audio.src = playback.url;
    }

    get volume(): number { return this.audio.volume; }
    set volume(value: number) { this.audio.volume = Math.max(0, Math.min(1, value)); }
    get loops(): boolean { return this.audio.loop; }
    set loops(value: boolean) { this.audio.loop = value; }
    get playing(): boolean { return this.active; }

    play(): void {
        if (this.tornDown) return;
        this.active = true;
        this.audio.play().catch((error: unknown) => {
            if (this.tornDown || !this.active) return;
            // A pause or teardown interrupts a pending play(); that is not a failure.
            if (error instanceof DOMException && error.name === "AbortError") return;
            if (error instanceof DOMException && error.name === "NotAllowedError") { this.playOnNextKey(); return; }
            this.onFailed?.();
        });
    }

    pause(): void {
        this.active = false;
        this.releaseGesture?.();
        this.audio.pause();
    }

    tearDown(): void {
        if (this.tornDown) return;
        this.tornDown = true;
        this.active = false;
        this.releaseGesture?.();
        for (const [name, listener] of this.listeners) this.audio.removeEventListener(name, listener);
        this.onEnded = undefined;
        this.onFailed = undefined;
        this.onProgress = undefined;
        // Dropping the source and reloading frees the TV's audio decoder before AVPlay opens.
        this.audio.pause();
        this.audio.removeAttribute("src");
        this.audio.load();
    }

    /** The platform refused to start without a key press; the next remote key starts it. */
    private playOnNextKey(): void {
        this.releaseGesture?.();
        const retry = (): void => {
            this.releaseGesture?.();
            if (!this.tornDown && this.active) this.play();
        };
        document.addEventListener("keydown", retry, { once: true });
        this.releaseGesture = () => {
            document.removeEventListener("keydown", retry);
            this.releaseGesture = undefined;
        };
    }
}
