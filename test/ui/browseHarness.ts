// Browser entry for the browse screen tests: signs in through the real session core and
// device-code flow, selects a profile through the real Profiles, then mounts the real browse
// screens. Requests go to the fake Silo (with FakeCatalog) the Node test serves through routes.
// Like the profile screens, an authority change puts a successor screen in the shared root.

import type { ConnectedServer } from "../../src/session/core.ts";
import { connect } from "../../src/session/core.ts";
import { type Browse, mountBrowse, type PlayRequest } from "../../src/ui/browse.ts";
import { FakeKeyManager, MemoryPublicStorage } from "../native/support/keyManager.ts";

export interface BrowseHarness {
    loginPhase: string;
    readonly plays: PlayRequest[];
    /** Whether browse's container was still in the root when onChooseProfile ran. */
    readonly chooseProfileCalls: boolean[];
    lastKeyPrevented: boolean | undefined;
    connect(): Promise<void>;
    selectProfile(id: string, pin?: string): Promise<string>;
    mount(): void;
    resume(): void;
    destroy(): void;
    /** As the profile screens do on Switch profile: clear the profile, which ends browse's authority. */
    clearProfile(): void;
}

declare global {
    interface Window {
        browseHarness: BrowseHarness;
        retainedNavigation: Element | null;
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
let server: ConnectedServer | undefined;
let browse: Browse | undefined;
const publicStorage = new MemoryPublicStorage();

function connected(): ConnectedServer {
    if (server === undefined) {
        throw new Error("not connected");
    }
    return server;
}

const harness: BrowseHarness = {
    loginPhase: "none",
    plays: [],
    chooseProfileCalls: [],
    lastKeyPrevented: undefined,
    async connect() {
        const result = await connect("https://silo.example.test", {
            fetch: (url, init) => window.fetch(url, init),
            publicStorage,
            keyManager: new FakeKeyManager(),
            randomBytes: (bytes) => {
                bytes.set(crypto.getRandomValues(new Uint8Array(bytes.length)));
            },
            deviceName: "Living room TV",
            devicePlatform: "tizen",
        });
        if (result.status !== "connected") {
            throw new Error(`connect: ${result.status}`);
        }
        server = result;
        result.session.onAuthorityChange((change) => {
            // The profile screens take the root back when the profile changes.
            if (change.reason !== "profile_selected" && document.getElementById("successor") === null) {
                const successor = document.createElement("div");
                successor.id = "successor";
                successor.textContent = "Who's watching?";
                root.appendChild(successor);
            }
        });
        const login = result.createDeviceLogin();
        login.subscribe((state) => {
            harness.loginPhase = state.phase;
        });
        login.start();
    },
    async selectProfile(id, pin) {
        const profiles = connected().profiles;
        const profile = (await profiles.list()).find((candidate) => candidate.id === id);
        if (profile === undefined) {
            throw new Error(`no profile ${id}`);
        }
        const selection = profiles.select(profile);
        if (selection.status === "selected") {
            return "selected";
        }
        return (await profiles.verifyPin(id, pin ?? "")).status;
    },
    mount() {
        document.getElementById("successor")?.remove();
        browse = mountBrowse(root, {
            server: connected(),
            publicStorage,
            onPlay: (request) => {
                harness.plays.push(request);
            },
            onChooseProfile: () => {
                harness.chooseProfileCalls.push(root.querySelector(".browse") !== null);
            },
        });
    },
    resume() {
        browse?.resumeAfterPlayback();
    },
    destroy() {
        browse?.destroy();
    },
    clearProfile() {
        connected().profiles.clear();
    },
};

window.addEventListener("keydown", (event) => {
    harness.lastKeyPrevented = event.defaultPrevented;
});
window.browseHarness = harness;
