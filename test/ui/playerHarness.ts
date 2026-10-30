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
    seekBy: (seconds) => commands.push(`seekBy ${seconds}`),
    back: () => commands.push("back"),
    dismissError: () => commands.push("dismissError"),
};
const screen: PlayerScreen = mountPlayerScreen(root, controls);

window.player = {
    commands,
    show: (view) => listener?.(view),
    destroy: () => screen.destroy(),
};
