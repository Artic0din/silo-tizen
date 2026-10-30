// Browser entry for the player screen tests: mounts the real screen over stub controls, so the
// test sets each playback view and sees which commands the remote keys send. No AVPlay or server.

import type { PlaybackView, PlayerControls } from "../../src/player/controller.ts";
import { mountPlayerScreen, type PlayerScreen } from "../../src/player/playerScreen.ts";

export interface PlayerHarness {
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
const controls: PlayerControls = {
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
    dismissError: () => commands.push("dismissError"),
    selectAudio: (id) => commands.push(`selectAudio ${id}`),
    selectSubtitle: (id) => commands.push(`selectSubtitle ${id ?? "off"}`),
    selectQuality: (id) => commands.push(`selectQuality ${id}`),
    retryTrackInfo: () => commands.push("retryTrackInfo"),
    retrySettings: () => commands.push("retrySettings"),
    seekThumbnail: async () => undefined,
};
const screen: PlayerScreen = mountPlayerScreen(root, controls);

window.player = {
    commands,
    show: (view) => listener?.(view),
    destroy: () => screen.destroy(),
};
