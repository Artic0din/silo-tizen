import { ApiError } from "../api/errors.ts";
import type { RequestSpec } from "../api/http.ts";
import type { PublicStorage } from "../session/deviceIdentity.ts";
import type { TizenKeyManager } from "./secretStore.ts";

const STORAGE_KEY = "silo.browseSnapshots.v1";
/** Snapshot artwork URLs are signed capabilities, so they live in protected storage beside the credentials. */
const ARTWORK_ALIAS = "silo.browseArtwork.v1";
const MAX_ARTWORK_BYTES = 256 * 1024;
const SENSITIVE_KEY = /url|token|authorization|password|secret/i;
const ARTWORK_KEY = /^(poster|backdrop|series_backdrop|still|logo|photo)_url$/;
const MAX_ENTRIES = 32;
const MAX_DETAIL_ENTRIES = 20;
const MAX_BYTES = 1024 * 1024;
const owners = new WeakMap<AbortSignal, BrowseCache>();
const live = new Set<BrowseCache>();

export function clearBrowseCache(storage: PublicStorage | undefined, account?: readonly string[], keyManager?: TizenKeyManager): void {
    for (const cache of live) {
        if (cache.belongsTo(storage, account)) cache.close();
    }
    removeSnapshots(storage, account, keyManager);
}

function removeSnapshots(storage: PublicStorage | undefined, account?: readonly string[], keyManager?: TizenKeyManager): void {
    try {
        const raw = storage?.getItem(STORAGE_KEY);
        if (account && raw) {
            const saved: unknown = JSON.parse(raw);
            if (typeof saved === "object" && saved !== null && "scope" in saved && typeof saved.scope === "string" && !matchesAccount(saved.scope, account)) return;
        }
        storage?.removeItem(STORAGE_KEY);
    } catch { try { storage?.removeItem(STORAGE_KEY); } catch { /* Optional snapshots cannot block sign-out. */ } }
    removeArtwork(keyManager);
}

function removeArtwork(keyManager: TizenKeyManager | undefined): void {
    try { keyManager?.removeData({ name: ARTWORK_ALIAS }); } catch { /* Missing, or unreadable: never loaded without a matching snapshot. */ }
}

/** FNV-1a: binds saved artwork to the exact snapshot text it was taken from. */
function hash(text: string): string {
    let value = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { value ^= text.charCodeAt(i); value = Math.imul(value, 0x01000193) >>> 0; }
    return value.toString(16);
}

function matchesAccount(identity: string, account: readonly string[]): boolean {
    const scope: unknown = JSON.parse(identity);
    return Array.isArray(scope) && account.every((value, index) => scope[index] === value);
}

function cacheKey(spec: RequestSpec<unknown>): string | undefined {
    if (spec.method !== "GET") return undefined;
    const path = spec.path.split("?")[0] ?? "";
    return path === "/home/sections" || path === "/recommendations/discover" || path === "/user/libraries"
        || /^\/catalog\/items\/[^/]+$/.test(path) || /^\/catalog\/series\/[^/]+\/seasons$/.test(path)
        || spec.path === "/settings/values/effective?keys=ui.disabled_library_ids" ? path : undefined;
}

function persistent(key: string): boolean {
    return key === "/home/sections" || key === "/recommendations/discover" || key === "/user/libraries" || key === "/settings/values/effective";
}

// Public snapshots never contain URLs; artwork capabilities stay in memory and protected storage.
function clean(value: unknown, artwork = false): unknown {
    if (Array.isArray(value)) return value.map(child => clean(child, artwork));
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(Object.entries(value).filter(([key, child]) => !SENSITIVE_KEY.test(key) || (artwork && ARTWORK_KEY.test(key) && typeof child === "string")).map(([key, child]) => [key, clean(child, artwork)]));
}

/** Only the artwork URLs of a cleaned response, in its shape; undefined when it has none. */
function artworkOf(value: unknown): unknown {
    if (Array.isArray(value)) {
        const children = value.map(artworkOf);
        return children.some(child => child !== undefined) ? children.map(child => child ?? null) : undefined;
    }
    if (typeof value !== "object" || value === null) return undefined;
    const kept = Object.entries(value).flatMap(([key, child]) => {
        const art = ARTWORK_KEY.test(key) ? (typeof child === "string" ? child : undefined) : SENSITIVE_KEY.test(key) ? undefined : artworkOf(child);
        return art === undefined ? [] : [[key, art] as const];
    });
    return kept.length === 0 ? undefined : Object.fromEntries(kept);
}

/** Puts artworkOf's URLs back onto the public snapshot they were taken from. */
function withArtwork(value: unknown, art: unknown): unknown {
    if (Array.isArray(value)) return Array.isArray(art) ? value.map((child, index) => withArtwork(child, art[index])) : value;
    if (typeof value !== "object" || value === null || typeof art !== "object" || art === null || Array.isArray(art)) return value;
    const merged: Record<string, unknown> = { ...value };
    for (const [key, child] of Object.entries(art)) {
        if (ARTWORK_KEY.test(key)) { if (typeof child === "string") merged[key] = child; }
        else if (key in merged) merged[key] = withArtwork(merged[key], child);
    }
    return merged;
}

/** The saved artwork for `identity`, by response key and the hash of its public snapshot. */
function readArtwork(keyManager: TizenKeyManager | undefined, identity: string): Map<string, readonly [string, unknown]> {
    const found = new Map<string, readonly [string, unknown]>();
    try {
        const saved: unknown = keyManager === undefined ? undefined : JSON.parse(keyManager.getData({ name: ARTWORK_ALIAS }, null));
        if (typeof saved !== "object" || saved === null || !("scope" in saved) || saved.scope !== identity || !("entries" in saved) || !Array.isArray(saved.entries)) return found;
        for (const entry of saved.entries) {
            if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") found.set(entry[0], [entry[1], entry[2]]);
        }
    } catch { /* No saved artwork: the snapshot shows placeholders, as before. */ }
    return found;
}

/** One active authority owns memory and optional snapshots; no expiry, like Apple. */
export class BrowseCache {
    private readonly storage: PublicStorage | undefined;
    private readonly identity: string;
    private readonly entries = new Map<string, string>();
    private closed = false;
    private generation = 0;
    private readonly unreachable = new Set<string>();
    get offline(): boolean { return this.unreachable.size > 0; }
    isOffline(spec: RequestSpec<unknown>): boolean {
        const key = cacheKey(spec);
        return key !== undefined && this.unreachable.has(key);
    }

    /** The artwork record last saved, or being saved, so an unchanged Home does not rewrite it. */
    private artworkSaved: string | undefined;
    private artworkSaving = false;
    private artworkQueued = false;

    constructor(storage: PublicStorage | undefined, scope: readonly string[], signal: AbortSignal, keyManager?: TizenKeyManager) {
        const identity = JSON.stringify(scope);
        this.storage = storage;
        this.identity = identity;
        for (const cache of live) {
            if (cache.storage === storage && cache.identity !== identity) cache.close();
        }
        try {
            const raw = storage?.getItem(STORAGE_KEY);
            if (raw !== undefined && raw !== null && raw.length * 2 <= MAX_BYTES) {
                const saved: unknown = JSON.parse(raw);
                if (typeof saved === "object" && saved !== null && "scope" in saved && saved.scope === identity && "entries" in saved && Array.isArray(saved.entries)) {
                    const artwork = readArtwork(keyManager, identity);
                    for (const entry of saved.entries.slice(-MAX_ENTRIES)) {
                        if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string" || !persistent(entry[0])) continue;
                        const art = artwork.get(entry[0]);
                        this.entries.set(entry[0], art?.[0] === hash(entry[1]) ? JSON.stringify(withArtwork(JSON.parse(entry[1]), art[1])) : entry[1]);
                    }
                } else removeSnapshots(storage, undefined, keyManager);
            }
        } catch { removeSnapshots(storage, undefined, keyManager); }
        this.persist = () => {
            let artwork: unknown[];
            try {
                const entries = [...this.entries].filter(([key]) => persistent(key)).map(([key, raw]) => {
                    const value: unknown = JSON.parse(raw);
                    return [key, JSON.stringify(clean(value)), artworkOf(value)] as const;
                });
                storage?.setItem(STORAGE_KEY, JSON.stringify({ scope: identity, entries: entries.map(([key, text]) => [key, text]) }));
                artwork = entries.filter(([, , art]) => art !== undefined).map(([key, text, art]) => [key, hash(text), art]);
            } catch { removeSnapshots(storage, undefined, keyManager); this.artworkSaved = undefined; return; }
            this.saveArtwork(storage === undefined ? undefined : keyManager, artwork.length === 0 ? "" : JSON.stringify({ scope: identity, entries: artwork }));
        };
        live.add(this);
        const close = (): void => { if (this.closed) return; this.close(); removeSnapshots(storage, undefined, keyManager); };
        if (signal.aborted) close(); else signal.addEventListener("abort", close, { once: true });
    }
    private readonly persist: () => void;

    /**
     * KeyManager refuses to save over an alias, so the old record goes first. One save per owner runs at
     * a time; a failed save is retried on the next persist, not at once, so a broken store cannot loop.
     */
    private saveArtwork(keyManager: TizenKeyManager | undefined, record: string): void {
        if (keyManager === undefined || this.closed || record === this.artworkSaved) return;
        if (this.artworkSaving) { this.artworkQueued = true; return; }
        removeArtwork(keyManager);
        this.artworkSaved = record;
        if (record === "" || record.length * 2 > MAX_ARTWORK_BYTES) return;
        this.artworkSaving = true;
        const done = (saved: boolean): void => {
            this.artworkSaving = false;
            // A save that outlived its authority or its snapshot must not leave artwork behind. A failed
            // save wrote nothing, and the alias may now hold the next owner's record.
            if (saved && (this.closed || this.artworkSaved !== record)) removeArtwork(keyManager);
            if (!saved && this.artworkSaved === record) this.artworkSaved = undefined;
            if (!this.closed && this.artworkQueued) { this.artworkQueued = false; this.persist(); }
        };
        try { keyManager.saveData(ARTWORK_ALIAS, record, null, () => done(true), () => done(false)); }
        catch { done(false); }
    }

    belongsTo(storage: PublicStorage | undefined, account?: readonly string[]): boolean {
        return this.storage === storage && (account === undefined || matchesAccount(this.identity, account));
    }

    close(): void { this.closed = true; this.entries.clear(); this.unreachable.clear(); live.delete(this); }

    invalidate(): void { if (this.closed) return; this.generation++; this.entries.clear(); this.persist(); }

    /** Drop one response after an explicit 403 or 404. Memory and the snapshot both lose it. */
    discard(spec: RequestSpec<unknown>): void {
        const key = cacheKey(spec);
        if (key === undefined || this.closed) return;
        this.entries.delete(key);
        this.unreachable.delete(key);
        this.persist();
    }

    peek<T>(spec: RequestSpec<T>): T | undefined {
        const key = cacheKey(spec);
        const raw = key === undefined || this.closed ? undefined : this.entries.get(key);
        if (raw === undefined || key === undefined) return undefined;
        try {
            this.entries.delete(key); this.entries.set(key, raw);
            return spec.decode(clean(JSON.parse(raw), true));
        }
        catch { if (key !== undefined) this.entries.delete(key); return undefined; }
    }

    async read<T>(spec: RequestSpec<T>, fetch: (request: RequestSpec<T>) => Promise<T>): Promise<T> {
        const key = cacheKey(spec);
        const generation = this.generation;
        try {
            const result = await fetch({ ...spec, decode: raw => {
                const result = spec.decode(raw);
                if (key !== undefined && !this.closed && generation === this.generation && !spec.signal?.aborted) this.store(key, raw);
                return result;
            } });
            if (key !== undefined) this.unreachable.delete(key);
            return result;
        } catch (error) {
            if (error instanceof ApiError && (error.status === 403 || error.status === 404)) this.discard(spec);
            if (key === undefined || this.closed || spec.signal?.aborted || !(error instanceof ApiError) || !["network", "timeout"].includes(error.failure.kind)) throw error;
            this.unreachable.add(key);
            if (this.unreachable.size > MAX_ENTRIES) {
                const oldest = [...this.unreachable].find(key => !persistent(key));
                if (oldest !== undefined) this.unreachable.delete(oldest);
            }
            const cached = this.peek(spec);
            if (cached === undefined) throw error;
            return cached;
        }
    }

    private store(key: string, raw: unknown): void {
        const value = JSON.stringify(clean(raw, true));
        this.entries.delete(key);
        if (value.length * 2 > MAX_BYTES / 2) return;
        this.entries.set(key, value);
        const details = [...this.entries.keys()].filter(key => key.startsWith("/catalog/"));
        while (details.length > MAX_DETAIL_ENTRIES) { const oldest = details.shift(); if (oldest !== undefined) this.entries.delete(oldest); }
        while (this.entries.size > MAX_ENTRIES || [...this.entries].reduce((size, [key, value]) => size + (key.length + value.length) * 2, 0) > MAX_BYTES / 2) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
        this.persist();
    }
}

export function browseCache(storage: PublicStorage | undefined, scope: readonly string[], signal: AbortSignal, keyManager?: TizenKeyManager): BrowseCache {
    let cache = owners.get(signal);
    if (cache === undefined) { cache = new BrowseCache(storage, scope, signal, keyManager); owners.set(signal, cache); }
    return cache;
}
