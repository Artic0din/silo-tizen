import assert from "node:assert/strict";
import { type ConnectedServer, connect } from "../../../src/session/core.ts";
import type { DeviceLogin, DeviceLoginState } from "../../../src/session/deviceLogin.ts";
import { ManualClock } from "./clock.ts";
import { FakeSilo } from "./fakeSilo.ts";
import { FakeKeyManager, MemoryPublicStorage } from "./keyManager.ts";

export interface Harness {
    readonly clock: ManualClock;
    readonly fake: FakeSilo;
    readonly keyManager: FakeKeyManager | undefined;
    readonly storage: MemoryPublicStorage;
    readonly core: ConnectedServer;
}

export async function connected(
    options: { keyManager?: FakeKeyManager | null | undefined; storage?: MemoryPublicStorage; clock?: ManualClock; fake?: FakeSilo } = {},
): Promise<Harness> {
    const clock = options.clock ?? new ManualClock();
    const fake = options.fake ?? new FakeSilo(clock);
    const keyManager = options.keyManager === null ? undefined : (options.keyManager ?? new FakeKeyManager());
    const storage = options.storage ?? new MemoryPublicStorage();
    const result = await connect(fake.origin, {
        fetch: fake.fetch,
        publicStorage: storage,
        keyManager,
        randomBytes: (bytes) => bytes.fill(0xab),
        deviceName: "Living room TV",
        devicePlatform: "tizen",
        clock,
    });
    assert.equal(result.status, "connected");
    if (result.status !== "connected") {
        throw new Error("not connected");
    }
    return { clock, fake, keyManager, storage, core: result };
}

export function latestDeviceCode(fake: FakeSilo): string {
    const codes = [...fake.devices.keys()];
    const code = codes[codes.length - 1];
    if (code === undefined) {
        throw new Error("no device request started");
    }
    return code;
}

export function record(login: DeviceLogin): DeviceLoginState[] {
    const states: DeviceLoginState[] = [];
    login.subscribe((state) => states.push(state));
    return states;
}

/** Signs in through the real device-code flow. */
export async function signIn(harness: Harness): Promise<void> {
    const login = harness.core.createDeviceLogin();
    login.start();
    await harness.clock.advance(0);
    harness.fake.approve(latestDeviceCode(harness.fake));
    await harness.clock.advance(5000);
    assert.equal(login.current.phase, "signed_in");
}
