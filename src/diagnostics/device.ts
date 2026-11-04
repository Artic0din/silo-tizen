import { CLIENT_CAPABILITIES } from "../player/capabilities.ts";

function field(value: unknown, key: string): unknown {
    return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** Unknown runtime facts stay unknown; the playback profile is explicitly declared evidence. */
export function diagnosticsDevice(): Readonly<Record<string, unknown>> {
    const product = field(field(globalThis, "webapis"), "productinfo");
    const read = field(product, "getRealModel");
    let model: unknown;
    try { model = typeof read === "function" ? read.call(product) : undefined; } catch { model = undefined; }
    const os = typeof navigator === "undefined" ? undefined : /Tizen[ /]([\d.]+)/i.exec(navigator.userAgent)?.[1];
    return {
        manufacturer: "Samsung", platform: "tizen", model: typeof model === "string" ? model : null,
        os_version: os ?? null, playback_profile: CLIENT_CAPABILITIES,
    };
}
