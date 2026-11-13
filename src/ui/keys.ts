// Remote keys as Samsung TVs deliver them: plain keydown events with these key codes
// (Remote Control guide). Escape stands in for Back on a desktop keyboard.

export type RemoteKey = "up" | "down" | "left" | "right" | "enter" | "back" | "play_pause" | "play" | "pause" | "stop" | "rewind" | "fast_forward" | "ime_done" | "ime_cancel";

const BY_CODE: Readonly<Record<number, RemoteKey>> = {
    13: "enter",
    27: "back",
    37: "left",
    38: "up",
    39: "right",
    40: "down",
    10009: "back",
    10252: "play_pause",
    415: "play",
    19: "pause",
    413: "stop",
    412: "rewind",
    417: "fast_forward",
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
    MediaPlay: "play",
    MediaPause: "pause",
    MediaStop: "stop",
    MediaRewind: "rewind",
    MediaFastForward: "fast_forward",
};

export function remoteKey(event: KeyboardEvent): RemoteKey | undefined {
    return BY_CODE[event.keyCode] ?? BY_NAME[event.key];
}

const NUMBER_KEYS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/**
 * The remote's number keys reach the app only while registered. Search claims them while its keyboard has focus and
 * releases them after, so the TV keyboard on a text field still receives them.
 */
export function claimNumberKeys(claim: boolean): void {
    const tizen: unknown = Reflect.get(globalThis, "tizen");
    const input: unknown = typeof tizen === "object" && tizen !== null ? Reflect.get(tizen, "tvinputdevice") : undefined;
    if (typeof input !== "object" || input === null) return;
    const change: unknown = Reflect.get(input, claim ? "registerKey" : "unregisterKey");
    if (typeof change !== "function") return;
    for (const name of NUMBER_KEYS) {
        try { change.call(input, name); } catch {
            // A refused key must not stop the others.
        }
    }
}
