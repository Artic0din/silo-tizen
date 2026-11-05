import { ApiError } from "../api/errors.ts";
import type { RequestSpec } from "../api/http.ts";
import type { PublicStorage } from "../session/deviceIdentity.ts";

const STORAGE_KEY = "silo.browseSnapshots.v1";
const MAX_ENTRIES = 32;
const MAX_DETAIL_ENTRIES = 20;
const MAX_BYTES = 1024 * 1024;
const owners = new WeakMap<AbortSignal, BrowseCache>();
const live = new Set<BrowseCache>();

export function clearBrowseCache(storage: PublicStorage | undefined, account?: readonly string[]): void {
    for (const cache of live) {
        if (cache.belongsTo(storage, account)) cache.close();
    }
    removeSnapshots(storage, account);
}

function removeSnapshots(storage: PublicStorage | undefined, account?: readonly string[]): void {
    try {
        const raw = storage?.getItem(STORAGE_KEY);
        if (account && raw) {
            const saved: unknown = JSON.parse(raw);
            if (typeof saved === "object" && saved !== null && "scope" in saved && typeof saved.scope === "string" && !matchesAccount(saved.scope, account)) return;
        }
        storage?.removeItem(STORAGE_KEY);
    } catch { try { storage?.removeItem(STORAGE_KEY); } catch { /* Optional snapshots cannot block sign-out. */ } }
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

// Relative artwork paths can survive in memory; URL capabilities never enter snapshots.
function clean(value: unknown, artwork = false): unknown {
    if (Array.isArray(value)) return value.map(child => clean(child, artwork));
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(Object.entries(value).filter(([key, child]) => !/url|token|authorization|password|secret/i.test(key) || (artwork && /^(poster|backdrop|logo)_url$/.test(key) && typeof child === "string" && /^\/(?!\/)[^?#]*$/.test(child))).map(([key, child]) => [key, clean(child, artwork)]));
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

    constructor(storage: PublicStorage | undefined, scope: readonly string[], signal: AbortSignal) {
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
                    for (const entry of saved.entries.slice(-MAX_ENTRIES)) {
                        if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string" && persistent(entry[0])) this.entries.set(entry[0], entry[1]);
                    }
                } else removeSnapshots(storage);
            }
        } catch { removeSnapshots(storage); }
        this.persist = () => {
            try { storage?.setItem(STORAGE_KEY, JSON.stringify({ scope: identity, entries: [...this.entries].filter(([key]) => persistent(key)) })); }
            catch { removeSnapshots(storage); }
        };
        live.add(this);
        const close = (): void => { if (this.closed) return; this.close(); removeSnapshots(storage); };
        if (signal.aborted) close(); else signal.addEventListener("abort", close, { once: true });
    }
    private readonly persist: () => void;

    belongsTo(storage: PublicStorage | undefined, account?: readonly string[]): boolean {
        return this.storage === storage && (account === undefined || matchesAccount(this.identity, account));
    }

    close(): void { this.closed = true; this.entries.clear(); this.unreachable.clear(); live.delete(this); }

    invalidate(): void { if (this.closed) return; this.generation++; this.entries.clear(); this.persist(); }

    peek<T>(spec: RequestSpec<T>): T | undefined {
        const key = cacheKey(spec);
        const raw = key === undefined || this.closed ? undefined : this.entries.get(key);
        if (raw === undefined || key === undefined) return undefined;
        try {
            this.entries.delete(key); this.entries.set(key, raw);
            return spec.decode(clean(JSON.parse(raw), !persistent(key)));
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
            if (key !== undefined && !this.closed && error instanceof ApiError && (error.status === 403 || error.status === 404)) {
                this.entries.delete(key);
                this.unreachable.delete(key);
                this.persist();
            }
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
        const value = JSON.stringify(clean(raw, !persistent(key)));
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

export function browseCache(storage: PublicStorage | undefined, scope: readonly string[], signal: AbortSignal): BrowseCache {
    let cache = owners.get(signal);
    if (cache === undefined) { cache = new BrowseCache(storage, scope, signal); owners.set(signal, cache); }
    return cache;
}
