// Browser entry for the sign-in screen tests: mounts the real screens with the real session
// core. The page's fetches go to a fake Silo the Node test serves through Playwright routes.
// `#session-only` starts without KeyManager, as a TV whose protected storage is missing.
// `?flow=profiles` continues into the profile screens and a stand-in for the browse screens.

import type { ConnectedServer } from "../../src/session/core.ts";
import type { LogoutResult, Persistence, RestoreResult } from "../../src/session/session.ts";
import { mountProfiles, type ProfileHandoff, type ProfileScreens } from "../../src/ui/profiles.ts";
import { mountSignIn, type SignInScreens } from "../../src/ui/signIn.ts";
import { FakeKeyManager, MemoryPublicStorage } from "../native/support/keyManager.ts";

export interface Handoff {
    readonly restore: RestoreResult;
    readonly username: string | undefined;
    readonly persistence: Persistence;
    readonly rootChildren: number;
}

export interface SignInHarness {
    readonly server: ConnectedServer | undefined;
    readonly profileController: ProfileScreens | undefined;
    readonly mountProfiles: typeof mountProfiles;
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
    /** Profile flow: each profile handed to the browse stand-in. */
    readonly profiles: { readonly id: string; readonly generation: number }[];
    /** Profile flow: what each sign-out handed back to sign-in. */
    readonly signedOut: (LogoutResult | undefined)[];
    /** Profile flow: whether the n-th handed-off profile's signal has ended. */
    profileEnded(index: number): boolean;
    /** Profile flow: a profile-scoped read for the current profile; paints its answer only while that profile acts. */
    probe(): Promise<string>;
    /** Profile flow: the browse stand-in's Switch profile control. */
    switchProfile(): void;
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
const profileFlow = location.search === "?flow=profiles";
let screens: SignInScreens | undefined;
let profileScreens: ProfileScreens | undefined;
let last: ConnectedServer | undefined;
const handed: ProfileHandoff[] = [];

const harness: SignInHarness = {
    get server() { return last; },
    get profileController() { return profileScreens; },
    mountProfiles,
    keyManager,
    storage,
    handoffs: [],
    discoveryRequests: 0,
    saveHold: undefined,
    lastKeyPrevented: undefined,
    profiles: [],
    signedOut: [],
    destroy() {
        screens?.destroy();
        profileScreens?.destroy();
    },
    profileEnded: (index) => handed[index]?.signal.aborted ?? false,
    async probe() {
        const server = last;
        const active = handed[handed.length - 1];
        if (server === undefined || active === undefined) {
            throw new Error("no profile handed off");
        }
        try {
            const answer = await server.session.call({ method: "GET", path: "/catalog/probe", retry: "safe", decode: (body) => JSON.stringify(body), profileScoped: true, signal: active.signal });
            if (active.signal.aborted) {
                return "dropped";
            }
            const painted = document.getElementById("browse-probe");
            if (painted !== null) {
                painted.textContent = answer;
            }
            return "painted";
        } catch (error) {
            return error instanceof Error ? error.message : "failed";
        }
    },
    switchProfile() {
        while (root.firstChild !== null) {
            root.removeChild(root.firstChild);
        }
        profileScreens?.switchProfile();
    },
    mount(signedOut) {
        screens?.destroy();
        profileScreens?.destroy();
        profileScreens = undefined;
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
                if (profileFlow) {
                    profileScreens = mountProfiles(root, { server, onSelected: browse, onSignedOut: backToSignIn });
                }
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

/** Stands in for the browse screens until they are native: shows which profile acts. */
const browse = (active: ProfileHandoff): void => {
    handed.push(active);
    harness.profiles.push({ id: active.profile.id, generation: active.generation });
    const section = document.createElement("section");
    section.setAttribute("data-screen", "browse");
    const title = document.createElement("h1");
    title.textContent = active.profile.name;
    const probe = document.createElement("p");
    probe.id = "browse-probe";
    section.appendChild(title);
    section.appendChild(probe);
    root.appendChild(section);
};

const backToSignIn = (notice: LogoutResult | undefined): void => {
    profileScreens = undefined;
    harness.signedOut.push(notice);
    harness.mount(notice);
};

window.addEventListener("keydown", (event) => {
    harness.lastKeyPrevented = event.defaultPrevented;
});
window.harness = harness;
harness.mount();
