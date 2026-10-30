import { connect, type ConnectedServer } from "../../src/session/core.ts";
import type { DeviceLogin } from "../../src/session/deviceLogin.ts";
import { PlaybackController } from "../../src/player/controller.ts";
import { mountPlayerScreen, type PlayerScreen } from "../../src/player/playerScreen.ts";
import { FakeAVPlay } from "../native/support/fakeAVPlay.ts";
import { MemoryPublicStorage } from "../native/support/keyManager.ts";
import { systemClock } from "../../src/api/clock.ts";

// Synthetic AVPlay surface: no decoder, video, audio or hardware is exercised here.
const avplay = new FakeAVPlay();
let server: ConnectedServer | undefined;
let login: DeviceLogin | undefined;
let controller: PlaybackController | undefined;
let screen: PlayerScreen | undefined;
const root = document.getElementById("root");
if (root === null) throw new Error("Missing root");
const randomBytes = (bytes: Uint8Array): void => { bytes.set(crypto.getRandomValues(new Uint8Array(bytes.length))); };

const harness = {
    avplay,
    get loginPhase() { return login?.current.phase; },
    async connect() {
        const result = await connect("https://silo.example.test", {
            fetch: (url, init) => window.fetch(url, init), publicStorage: new MemoryPublicStorage(), keyManager: undefined,
            randomBytes, deviceName: "Synthetic TV", devicePlatform: "tizen",
        });
        if (result.status !== "connected") throw new Error("Synthetic server unavailable");
        server = result;
        login = server.createDeviceLogin();
        login.start();
    },
    async play(fileId = "42") {
        if (server === undefined) throw new Error("Not connected");
        const owner = (await server.profiles.list()).find((profile) => profile.id === "p-owner");
        if (owner === undefined) throw new Error("Missing synthetic profile");
        server.profiles.select(owner);
        controller?.destroy();
        screen?.destroy();
        controller = new PlaybackController({ session: server.session, avplay, clock: systemClock, randomBytes,
            device: { model: "Synthetic AVPlay", appVersion: "0.0.1" }, exits: { onBack() {}, onEnd() {}, onError() {} } });
        screen = mountPlayerScreen(root, controller);
        controller.play({ contentId: "movie-1", fileId, title: "Synthetic film", startSeconds: 1225 });
    },
    clearProfile() { server?.profiles.clear(); },
    quality() { controller?.selectQuality("720p"); },
    destroy() { screen?.destroy(); controller?.destroy(); },
};

declare global { interface Window { trickplay: typeof harness; } }
window.trickplay = harness;
