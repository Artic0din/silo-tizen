import type { AppOptions } from "./app.ts";
import { findAVPlay } from "./player/avplay.ts";
import type { PublicStorage } from "./session/deviceIdentity.ts";
import { findTizenKeyManager } from "./session/secretStore.ts";

function field(value: unknown, key: string): unknown {
    return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

function modelName(): string {
    const product = field(field(globalThis, "webapis"), "productinfo");
    const read = field(product, "getRealModel");
    try {
        const name: unknown = typeof read === "function" ? read.call(product) : undefined;
        return typeof name === "string" && name.trim() !== "" ? name : "Samsung TV";
    } catch {
        return "Samsung TV";
    }
}

function exit(): void {
    const manager = field(field(globalThis, "tizen"), "application");
    const getCurrent = field(manager, "getCurrentApplication");
    const current: unknown = typeof getCurrent === "function" ? getCurrent.call(manager) : undefined;
    const leave = field(current, "exit");
    if (typeof leave !== "function") {
        throw new Error("Application exit is unavailable");
    }
    leave.call(current);
}

function registerMediaKey(): void {
    const input = field(field(globalThis, "tizen"), "tvinputdevice");
    const register = field(input, "registerKey");
    const supported = field(input, "getSupportedKeys");
    if (typeof register !== "function" || typeof supported !== "function") {
        return;
    }
    try {
        const keys: unknown = supported.call(input);
        if (Array.isArray(keys) && keys.some((key: unknown) => field(key, "name") === "MediaPlayPause")) {
            register.call(input, "MediaPlayPause");
        }
    } catch {
        // Enter remains available when this optional remote key is absent or refused.
    }
}

export function platformOptions(appVersion: string): AppOptions {
    if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
        throw new Error("Secure random generation is unavailable");
    }
    let storage: PublicStorage | undefined;
    try {
        storage = window.localStorage;
    } catch {
        // The session core will use its explicit session-only path.
    }
    const randomBytes = (bytes: Uint8Array): void => { bytes.set(crypto.getRandomValues(new Uint8Array(bytes.length))); };
    const model = modelName();
    const avplay = findAVPlay();
    registerMediaKey();
    return {
        core: {
            fetch: (url, init) => window.fetch(url, init),
            publicStorage: storage,
            keyManager: findTizenKeyManager(),
            randomBytes,
            deviceName: model,
            devicePlatform: "tizen",
        },
        player: avplay === undefined ? undefined : { avplay, randomBytes, model, appVersion },
        exit,
    };
}
