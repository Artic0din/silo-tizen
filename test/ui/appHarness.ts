import { mountApp, type SiloApp } from "../../src/app.ts";
import { FakeAVPlay } from "../native/support/fakeAVPlay.ts";
import { FakeKeyManager, MemoryPublicStorage } from "../native/support/keyManager.ts";

if (typeof setImmediate === "undefined") {
    Object.defineProperty(globalThis, "setImmediate", { value: (fn: () => void) => void Promise.resolve().then(fn) });
}

const root = document.getElementById("root");
if (root === null) {
    throw new Error("missing #root");
}
const storage = new MemoryPublicStorage();
const keyManager = new FakeKeyManager();
const avplay = new FakeAVPlay();
let app: SiloApp | undefined;
let exits = 0;
let exitFails = false;
const registeredKeys: string[] = [];

const mount = (withPlayer = true): void => {
    app?.destroy();
    const randomBytes = (bytes: Uint8Array): void => { bytes.set(crypto.getRandomValues(new Uint8Array(bytes.length))); };
    app = mountApp(root, {
        core: {
            fetch: (url, init) => window.fetch(url, init),
            publicStorage: storage,
            keyManager,
            randomBytes,
            deviceName: "Living room TV",
            devicePlatform: "tizen",
        },
        player: withPlayer ? { avplay, randomBytes, model: "QN55Q60AAFXZA", appVersion: "0.0.1" } : undefined,
        exit: () => {
            if (exitFails) {
                throw new Error("platform refused exit");
            }
            exits++;
        },
    });
};

const harness = {
    avplay,
    storage,
    keyManager,
    registeredKeys,
    get exits() { return exits; },
    failExit() { exitFails = true; },
    mount,
    destroy() { app?.destroy(); },
};

declare global {
    interface Window { appHarness: typeof harness; }
}
window.appHarness = harness;
if (location.hash === "#production") {
    root.id = "screen";
    Object.defineProperty(globalThis, "webapis", { value: { avplay, productinfo: { getRealModel: () => "QN55Q60AAFXZA" } } });
    Object.defineProperty(globalThis, "tizen", { value: {
        keymanager: keyManager,
        application: { getCurrentApplication: () => ({ exit: () => { exits++; } }) },
        tvinputdevice: {
            getSupportedKeys: () => [{ name: "MediaPlayPause", code: 10252 }],
            registerKey: (name: string) => registeredKeys.push(name),
        },
    } });
    void import("../../src/main.ts").then((entry) => { app = entry.app; });
} else {
    mount();
}
