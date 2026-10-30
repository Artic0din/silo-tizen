// Remote keys as Samsung TVs deliver them: plain keydown events with these key codes
// (Remote Control guide). Escape stands in for Back on a desktop keyboard.

export type RemoteKey = "up" | "down" | "left" | "right" | "enter" | "back" | "play_pause" | "ime_done" | "ime_cancel";

const BY_CODE: Readonly<Record<number, RemoteKey>> = {
    13: "enter",
    27: "back",
    37: "left",
    38: "up",
    39: "right",
    40: "down",
    10009: "back",
    10252: "play_pause",
    // The on-screen keyboard's Done and Cancel keys.
    65376: "ime_done",
    65385: "ime_cancel",
};

const BY_NAME: Readonly<Record<string, RemoteKey>> = {
    Enter: "enter",
    Escape: "back",
    ArrowLeft: "left",
    ArrowUp: "up",
    ArrowRight: "right",
    ArrowDown: "down",
    MediaPlayPause: "play_pause",
};

export function remoteKey(event: KeyboardEvent): RemoteKey | undefined {
    return BY_CODE[event.keyCode] ?? BY_NAME[event.key];
}
