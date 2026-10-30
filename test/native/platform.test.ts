import assert from "node:assert/strict";
import { test } from "node:test";
import { platformOptions } from "../../src/platform.ts";

for (const refused of [false, true]) test(`supported media keys register independently when one is ${refused ? "refused" : "available"}`, () => {
    const previous = ["window", "tizen"].map(key => ({ key, descriptor: Object.getOwnPropertyDescriptor(globalThis, key) }));
    const keys = ["MediaPlayPause", "MediaPlay", "MediaPause", "MediaStop", "MediaRewind", "MediaFastForward"];
    const registered: string[] = [];
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: undefined } });
    Object.defineProperty(globalThis, "tizen", { configurable: true, value: { tvinputdevice: {
        getSupportedKeys: () => [...keys, "MediaPause", "UnknownKey"].map(name => ({ name })),
        registerKey: (name: string) => {
            registered.push(name);
            if (refused && name === "MediaPlay") throw new Error("Key unavailable");
        },
    } } });
    try {
        platformOptions("0.1.0");
        assert.deepEqual(registered.sort(), keys.sort());
    } finally {
        for (const { key, descriptor } of previous) {
            if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
            else Object.defineProperty(globalThis, key, descriptor);
        }
    }
});
