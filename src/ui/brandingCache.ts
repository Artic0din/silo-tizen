// ServerBrandingCache: the last branding each server answered, kept on this TV so the sign-in
// screens show its name, mark and accent at once on the next launch. Public text only; every read
// is validated again, so an edited or damaged store can't point the screens at another origin.
//
// When a saved server is removed (the profile lane's forgetServer), its entry here should go too,
// once that removal is confirmed, as ServerRegistry removes Apple's.

import { resolveBrandingAsset, type ServerBranding } from "../contracts/v2/branding.ts";
import type { PublicStorage } from "../session/deviceIdentity.ts";

const KEY = "silo.native.serverBranding.v1";

type Stored = Record<string, unknown>;

function readAll(storage: PublicStorage | undefined): Stored | undefined {
    try {
        const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? "null");
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Stored) : undefined;
    } catch {
        return undefined;
    }
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value.trim() || undefined : undefined);

/** `baseUrl` as the server answered it; the mark is resolved against it again. */
export function cachedBranding(storage: PublicStorage | undefined, baseUrl: string): ServerBranding | undefined {
    const entry = readAll(storage)?.[baseUrl];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return undefined;
    }
    const row = entry as Stored;
    return { serverName: text(row.serverName), markUrl: resolveBrandingAsset(text(row.markUrl), baseUrl), accentColor: text(row.accentColor) };
}

/** Replaces this server's entry with its newest answer; storage that refuses is left alone. */
export function storeBranding(storage: PublicStorage | undefined, baseUrl: string, branding: ServerBranding): void {
    const all = readAll(storage) ?? {};
    all[baseUrl] = { serverName: branding.serverName, markUrl: branding.markUrl, accentColor: branding.accentColor };
    try {
        storage?.setItem(KEY, JSON.stringify(all));
    } catch {
        // Not remembered: the next launch waits for the server's answer instead.
    }
}
