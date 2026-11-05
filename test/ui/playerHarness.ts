// Browser entry for the player screen tests: mounts the real screen over stub controls, so the
// test sets each playback view and sees which commands the remote keys send. No AVPlay or server.

import type { PlaybackView, PlayerControls } from "../../src/player/controller.ts";
import { mountPlayerScreen, type PlayerScreen } from "../../src/player/playerScreen.ts";
import { mountAudioScreen } from "../../src/player/audioScreen.ts";
import { systemClock } from "../../src/api/clock.ts";

export interface PlayerHarness {
    audio(): void;
    rejectSleepPause(): void;
    readonly commands: string[];
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
let listener: ((view: PlaybackView) => void) | undefined;
let rejectedPauseView: PlaybackView | undefined;
const controls: PlayerControls = {
    subscribe(next) {
        listener = next;
        next({ phase: "loading", title: "The Movie" });
        return () => {
            listener = undefined;
        };
    },
    togglePause: () => commands.push("togglePause"),
    setPaused: (paused) => {
        commands.push(`setPaused ${paused}`);
        if (paused && rejectedPauseView !== undefined) listener?.(rejectedPauseView);
    },
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
    playNext: () => commands.push("playNext"),
    cancelAutoplay: () => commands.push("cancelAutoplay"),
    saveSeriesSubtitle: () => commands.push("saveSeriesSubtitle"),
    startSubtitleAI: (kind, language) => commands.push(`startSubtitleAI ${kind} ${language ?? ""}`),
    selectAIResult: id => commands.push(`selectAIResult ${id}`),
    seekThumbnail: async () => undefined,
};
let screen: PlayerScreen = mountPlayerScreen(root, controls);

window.player = {
    audio() {
        screen.destroy();
        screen = mountAudioScreen(root, controls, { id: "book", title: "Book", overview: "", poster: undefined, position: 0, duration: 200, parts: [{ fileId: "1", duration: 200, offset: 0 }], chapters: [{ title: "Opening", start: 0 }, { title: "Ending", start: 100 }] }, systemClock);
    },
    commands,
    rejectSleepPause() { rejectedPauseView = { phase: "playing", title: "Book", positionSeconds: 0, durationSeconds: 200, buffering: false, seekIntervals: { backward: 10, forward: 30 }, tracks: { audio: { state: "loading" }, selectedAudioId: undefined, subtitles: [], selectedSubtitleId: undefined, subtitleMode: "off", change: { state: "idle" }, notices: [] } }; },
    show: (view) => listener?.(view),
    destroy: () => screen.destroy(),
};
