// The install's public device identity. It is not a secret: the server records it for
// display and audit and authorizes nothing on it, so it may live in ordinary web storage.

import type { DeviceHeaders } from "../api/http.ts";

/** Non-secret key/value storage (localStorage). Never holds tokens. */
export interface PublicStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export type RandomBytes = (bytes: Uint8Array) => void;

const DEVICE_ID_KEY = "silo.native.deviceId";
/** The server's accepted id alphabet and length (auth-api.md, device headers). */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const NAME_MAX = 120;
const PLATFORM_MAX = 40;
const DEVICE_ID_BYTES = 16;

export function loadDeviceId(storage: PublicStorage | undefined, random: RandomBytes): string {
    try {
        const existing = storage?.getItem(DEVICE_ID_KEY);
        if (existing !== null && existing !== undefined && DEVICE_ID_PATTERN.test(existing)) {
            return existing;
        }
    } catch {
        // Storage blocked: fall through to an id for this run only.
    }
    const bytes = new Uint8Array(DEVICE_ID_BYTES);
    random(bytes);
    let id = "";
    bytes.forEach((byte) => {
        id += (byte + 0x100).toString(16).slice(1);
    });
    try {
        storage?.setItem(DEVICE_ID_KEY, id);
    } catch {
        // Not persisted; the server sees a new device next launch, which is harmless.
    }
    return id;
}

/** Header values must be Latin-1 for fetch; keep printable ASCII and the server's lengths. */
function headerText(value: string, max: number, fallback: string): string {
    const cleaned = value.replace(/[^\x20-\x7e]/g, "").trim().slice(0, max);
    return cleaned === "" ? fallback : cleaned;
}

export function deviceHeaders(id: string, name: string, platform: string): DeviceHeaders {
    return {
        id,
        name: headerText(name, NAME_MAX, "Samsung TV"),
        platform: headerText(platform, PLATFORM_MAX, "tizen"),
    };
}
