// Browser entry for the sign-in screen tests: mounts the real screens with the real session
// core. The page's fetches go to a fake Silo the Node test serves through Playwright routes.
// `#session-only` starts without KeyManager, as a TV whose protected storage is missing.

import type { ConnectedServer } from "../../src/session/core.ts";
import type { LogoutResult, Persistence, RestoreResult } from "../../src/session/session.ts";
import { mountSignIn, type SignInScreens } from "../../src/ui/signIn.ts";
import { FakeKeyManager, MemoryPublicStorage } from "../native/support/keyManager.ts";

export interface Handoff {
    readonly restore: RestoreResult;
    readonly username: string | undefined;
    readonly persistence: Persistence;
    readonly rootChildren: number;
}

export interface SignInHarness {
    readonly keyManager: FakeKeyManager | undefined;
    readonly storage: MemoryPublicStorage;
    readonly handoffs: Handoff[];
    discoveryRequests: number;
    saveHold: ReturnType<FakeKeyManager["holdSaves"]> | undefined;
    /** Whether the app's own handler would see the last key as unhandled. */
    lastKeyPrevented: boolean | undefined;
    /** A fresh mount on the same storage, as after the app restarts. */
    mount(signedOut?: LogoutResult): void;
    destroy(): void;
    /** Signs the last handed-off server out and shows sign-in again, as the profile screens will. */
    logout(): Promise<LogoutResult>;
}

declare global {
    interface Window {
        harness: SignInHarness;
    }
}

// The fake KeyManager defers its save callback with Node's setImmediate.
if (typeof setImmediate === "undefined") {
    Object.defineProperty(globalThis, "setImmediate", {
        value: (fn: () => void) => {
            void Promise.resolve().then(fn);
        },
    });
}

const root = document.getElementById("root");
if (root === null) {
    throw new Error("missing #root");
}
const keyManager = location.hash === "#session-only" ? undefined : new FakeKeyManager();
const storage = new MemoryPublicStorage();
let screens: SignInScreens | undefined;
let last: ConnectedServer | undefined;

const harness: SignInHarness = {
    keyManager,
    storage,
    handoffs: [],
    discoveryRequests: 0,
    saveHold: undefined,
    lastKeyPrevented: undefined,
    destroy() {
        screens?.destroy();
    },
    mount(signedOut) {
        screens?.destroy();
        screens = mountSignIn(root, {
            core: {
                fetch: (url, init) => {
                    if (new URL(url).pathname.endsWith("/system/info")) {
                        harness.discoveryRequests++;
                    }
                    return window.fetch(url, init);
                },
                publicStorage: storage,
                keyManager,
                randomBytes: (bytes) => {
                    bytes.set(crypto.getRandomValues(new Uint8Array(bytes.length)));
                },
                deviceName: "Living room TV",
                devicePlatform: "tizen",
            },
            onSignedIn: (server) => {
                last = server;
                harness.handoffs.push({
                    restore: server.restore,
                    username: server.session.account?.username,
                    persistence: server.session.persistence,
                    rootChildren: root.childElementCount,
                });
            },
            ...(signedOut === undefined ? {} : { signedOut }),
        });
    },
    async logout() {
        if (last === undefined) {
            throw new Error("nobody signed in");
        }
        const result = await last.session.logout();
        harness.mount(result);
        return result;
    },
};

window.addEventListener("keydown", (event) => {
    harness.lastKeyPrevented = event.defaultPrevented;
});
window.harness = harness;
harness.mount();
