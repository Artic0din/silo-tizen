import assert from "node:assert/strict";
import { test } from "node:test";
import { claimNumberKeys } from "../../src/ui/keys.ts";

test("number keys register only while claimed, each independently of a refused one", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "tizen");
    const calls: string[] = [];
    Object.defineProperty(globalThis, "tizen", { configurable: true, value: { tvinputdevice: {
        registerKey: (name: string) => { calls.push(`+${name}`); if (name === "3") throw new Error("Key unavailable"); },
        unregisterKey: (name: string) => { calls.push(`-${name}`); },
    } } });
    try {
        claimNumberKeys(true);
        claimNumberKeys(false);
        const digits = [..."0123456789"];
        assert.deepEqual(calls, [...digits.map(digit => `+${digit}`), ...digits.map(digit => `-${digit}`)]);
    } finally {
        if (previous === undefined) Reflect.deleteProperty(globalThis, "tizen");
        else Object.defineProperty(globalThis, "tizen", previous);
    }
});

test("number keys are a no-op off the TV", () => {
    assert.doesNotThrow(() => { claimNumberKeys(true); claimNumberKeys(false); });
});
