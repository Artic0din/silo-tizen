// Browser entry for the player screen tests: mounts the real screen over stub controls, so the
// test sets each playback view and sees which commands the remote keys send. No AVPlay or server.

import type { PlaybackView, PlayerControls } from "../../src/player/controller.ts";
import { mountPlayerScreen, type PlayerScreen } from "../../src/player/playerScreen.ts";

export interface PlayerHarness {
    readonly commands: string[];
    /** What `dismissBufferingPill` answers: true while a buffering pill is up. */
    dismissesBufferingPill: boolean;
    readonly skipPillShown: boolean;
    show(view: PlaybackView): void;
    destroy(): void;
}

declare global {
    interface Window {
        player: PlayerHarness;
    }
}

const root = document.getElementById("root");
if (root === null) {
    throw new Error("missing #root");
}
// Stands for a screen another owner put in the same root; the player must leave it alone.
const sibling = document.createElement("div");
sibling.id = "sibling";
root.appendChild(sibling);

const commands: string[] = [];
let dismissesBufferingPill = false;
let skipPillShown = false;
let listener: ((view: PlaybackView) => void) | undefined;
const controls: PlayerControls = {
    setVideo: (kind, value) => commands.push(`setVideo ${kind} ${value}`),
    toggleAutoNext: () => commands.push("toggleAutoNext"),
    retryChapters: () => commands.push("retryChapters"),
    subscribe(next) {
        listener = next;
        next({ phase: "loading", title: "The Movie" });
        return () => {
            listener = undefined;
        };
    },
    togglePause: () => commands.push("togglePause"),
    setPaused: (paused) => commands.push(`setPaused ${paused}`),
    seekBy: (seconds) => commands.push(`seekBy ${seconds}`),
    seekToSeconds: (seconds) => commands.push(`seekToSeconds ${seconds}`),
    back: () => commands.push("back"),
    background: () => {
        commands.push("background");
        listener?.({ phase: "error", title: "The Movie", error: { kind: "backgrounded" } });
    },
    suspend: () => commands.push("suspend"),
    restore: () => commands.push("restore"),
    dismissError: () => commands.push("dismissError"),
    selectAudio: (id) => commands.push(`selectAudio ${id}`),
    selectSubtitle: (id) => commands.push(`selectSubtitle ${id ?? "off"}`),
    selectQuality: (id) => commands.push(`selectQuality ${id}`),
    retryTrackInfo: () => commands.push("retryTrackInfo"),
    retrySettings: () => commands.push("retrySettings"),
    retryCompletion: () => commands.push("retryCompletion"),
    playNext: request => commands.push(request === undefined ? "playNext" : `playNext ${request.contentId} ${request.fileId}`),
    showUpNext: () => commands.push("showUpNext"),
    cancelAutoplay: () => commands.push("cancelAutoplay"),
    keepWatching: () => commands.push("keepWatching"),
    saveSeriesSubtitle: () => commands.push("saveSeriesSubtitle"),
    startSubtitleAI: (kind, language) => commands.push(`startSubtitleAI ${kind} ${language ?? ""}`),
    selectAIResult: id => commands.push(`selectAIResult ${id}`),
    subtitleTool: action => commands.push(`subtitleTool ${JSON.stringify(action)}`),
    seekThumbnail: async () => undefined,
    selectBufferingPrimary: () => commands.push("selectBufferingPrimary"),
    selectBufferingKeep: () => commands.push("selectBufferingKeep"),
    dismissBufferingPill: () => {
        commands.push("dismissBufferingPill");
        return dismissesBufferingPill;
    },
    // Not a command: it follows every render, and the tests that list commands have no use for it.
    setSkipPillShown: (shown) => {
        skipPillShown = shown;
    },
};
const screen: PlayerScreen = mountPlayerScreen(root, controls, undefined, "https://media.test");

window.player = {
    commands,
    get dismissesBufferingPill() { return dismissesBufferingPill; },
    set dismissesBufferingPill(value: boolean) { dismissesBufferingPill = value; },
    get skipPillShown() { return skipPillShown; },
    show: (view) => listener?.(view),
    destroy: () => screen.destroy(),
};
