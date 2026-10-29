// Persists one server's native account credential in protected storage.
//
// Two slots alternate so a refresh never overwrites the only good copy: the new record goes
// to the other slot with a higher generation, then the old slot is removed. A crash or
// write failure in between leaves the previous record loadable.
//
// Logout records the last generation it cleared in public storage (a number, not a secret).
// If protected storage refuses a delete, the leftover record is at or below that floor and
// is never loaded again, so a failed delete cannot bring a signed-out session back. If a slot
// could not be read, its generation is unknown and the floor excludes every record until a
// load reads all slots and turns it back into a number. A floor that is not a count is treated
// the same way. A floor that public storage refuses to read loads, saves and deletes nothing.

import { integer, nonEmptyString, object, string, WireError } from "../contracts/v2/wire.ts";
import type { PublicStorage } from "./deviceIdentity.ts";
import type { SecretStore } from "./secretStore.ts";

export interface StoredCredential {
    readonly baseUrl: string;
    readonly serverId: string;
    readonly accountId: string;
    readonly username: string;
    readonly accessToken: string;
    readonly refreshToken: string;
    /** Local clock, epoch ms. */
    readonly accessExpiresAt: number;
}

export type VaultLoad =
    | { readonly status: "found"; readonly credential: StoredCredential }
    | { readonly status: "none" }
    /** A record was unreadable and has been discarded; the person signs in again. */
    | { readonly status: "corrupt" }
    /** Protected storage, or the floor in public storage, did not answer; nothing was discarded. */
    | { readonly status: "unavailable" };

export type VaultSave = "saved" | "failed";

/** `guarded`: a record could not be deleted but will never be loaded again. */
export type VaultClear = "cleared" | "guarded" | "failed";

type Slot = "a" | "b";
const SLOTS: readonly Slot[] = ["a", "b"];
const RECORD_VERSION = 1;
/** The floor a clear writes when a slot could not be read: no record is above it. */
const EVERY_GENERATION = Infinity;

/** FNV-1a: a short, stable alias for a base URL. The record repeats the URL and is checked. */
function aliasHash(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return (hash + 0x100000000).toString(16).slice(1);
}

interface DecodedRecord {
    readonly generation: number;
    readonly credential: StoredCredential;
}

function decodeRecord(raw: string): DecodedRecord {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new WireError("credential", "JSON");
    }
    const path = "credential";
    const obj = object(parsed, path);
    if (integer(obj, "v", path) !== RECORD_VERSION) {
        throw new WireError(`${path}.v`, `version ${RECORD_VERSION}`);
    }
    return {
        generation: integer(obj, "generation", path),
        credential: {
            baseUrl: nonEmptyString(obj, "baseUrl", path),
            serverId: nonEmptyString(obj, "serverId", path),
            accountId: nonEmptyString(obj, "accountId", path),
            username: string(obj, "username", path),
            accessToken: nonEmptyString(obj, "accessToken", path),
            refreshToken: nonEmptyString(obj, "refreshToken", path),
            accessExpiresAt: integer(obj, "accessExpiresAt", path),
        },
    };
}

export class CredentialVault {
    private readonly store: SecretStore;
    private readonly publicStorage: PublicStorage | undefined;
    private readonly baseUrl: string;
    private readonly aliasPrefix: string;
    private readonly floorKey: string;
    private generation = 0;
    private slot: Slot | undefined;
    /**
     * The last load read the floor and every slot, so `generation` is at or above every stored
     * record and the floor. Until then save and clear load first, and save writes nothing.
     */
    private known = false;
    /** Storage operations run one at a time, in call order. */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(store: SecretStore, publicStorage: PublicStorage | undefined, baseUrl: string) {
        this.store = store;
        this.publicStorage = publicStorage;
        this.baseUrl = baseUrl;
        const hash = aliasHash(baseUrl);
        this.aliasPrefix = `silo.native.v${RECORD_VERSION}.${hash}.`;
        this.floorKey = `silo.native.clearedGeneration.${hash}`;
    }

    get persistent(): boolean {
        return this.store.persistent;
    }

    load(): Promise<VaultLoad> {
        return this.serialize(() => this.loadNow());
    }

    /**
     * Writes `credential`. Operations run in call order, so a save started before a logout
     * is always followed by that logout's clear.
     */
    save(credential: StoredCredential): Promise<VaultSave> {
        return this.serialize(() => this.saveNow(credential));
    }

    clear(): Promise<VaultClear> {
        return this.serialize(() => this.clearNow());
    }

    private serialize<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.queue.then(operation, operation);
        this.queue = result.catch(() => undefined);
        return result;
    }

    private alias(slot: Slot): string {
        return this.aliasPrefix + slot;
    }

    private async loadNow(): Promise<VaultLoad> {
        this.known = false;
        let floor = this.readFloor();
        if (floor === undefined) {
            // Any record may be one a logout cleared; keep it for when the floor reads again.
            return { status: "unavailable" };
        }
        let best: (DecodedRecord & { readonly slot: Slot }) | undefined;
        let sawCorrupt = false;
        let sawFailure = false;
        let highest = 0;
        for (const slot of SLOTS) {
            const read = await this.store.read(this.alias(slot));
            if (read.status === "failed") {
                sawFailure = true;
                continue;
            }
            if (read.status === "missing") {
                continue;
            }
            let record: DecodedRecord;
            try {
                record = decodeRecord(read.value);
            } catch (error) {
                if (!(error instanceof WireError)) {
                    throw error;
                }
                sawCorrupt = true;
                await this.store.remove(this.alias(slot));
                continue;
            }
            highest = Math.max(highest, record.generation);
            if (record.generation <= floor) {
                // Survived a logout whose delete failed; finish the delete.
                await this.store.remove(this.alias(slot));
                continue;
            }
            if (record.credential.baseUrl !== this.baseUrl) {
                continue;
            }
            if (best === undefined || record.generation > best.generation) {
                best = { ...record, slot };
            }
        }
        if (floor === EVERY_GENERATION && !sawFailure && this.writeFloor(highest)) {
            // Every slot was read: what the unreadable clear left behind is now excluded by number.
            floor = highest;
        }
        this.generation = Math.max(floor, highest);
        this.slot = best?.slot;
        this.known = !sawFailure && this.generation !== EVERY_GENERATION;
        if (sawFailure) {
            // The unread slot may hold a newer record, even another account's: restore none.
            return { status: "unavailable" };
        }
        if (best !== undefined) {
            return { status: "found", credential: best.credential };
        }
        return sawCorrupt ? { status: "corrupt" } : { status: "none" };
    }

    private async saveNow(credential: StoredCredential): Promise<VaultSave> {
        if (!this.known) {
            await this.loadNow();
        }
        if (!this.known) {
            // An unread slot may hold a higher generation, or the floor may hide anything written now.
            return "failed";
        }
        const target: Slot = this.slot === "a" ? "b" : "a";
        const generation = this.generation + 1;
        const record = JSON.stringify({ v: RECORD_VERSION, generation, ...credential });
        // KeyManager does not overwrite an alias; the target slot holds only an older record.
        await this.store.remove(this.alias(target));
        if (!(await this.store.write(this.alias(target), record))) {
            return "failed";
        }
        const previous = this.slot;
        this.slot = target;
        this.generation = generation;
        if (previous !== undefined) {
            await this.store.remove(this.alias(previous));
        }
        return "saved";
    }

    private async clearNow(): Promise<VaultClear> {
        if (!this.known) {
            await this.loadNow();
        }
        const floor = this.known ? this.generation : EVERY_GENERATION;
        const guarded = this.writeFloor(floor);
        if (guarded) {
            this.generation = floor;
        }
        let removed = true;
        for (const slot of SLOTS) {
            if ((await this.store.remove(this.alias(slot))) === "failed") {
                removed = false;
            }
        }
        if (removed) {
            this.slot = undefined;
            return "cleared";
        }
        // The record is still in its slot, so the next save goes to the other one.
        return guarded ? "guarded" : "failed";
    }

    /** Undefined when public storage refuses the read: which records were cleared is unknown. */
    private readFloor(): number | undefined {
        let raw: string | null | undefined;
        try {
            raw = this.publicStorage?.getItem(this.floorKey);
        } catch {
            return undefined;
        }
        if (raw === null || raw === undefined) {
            return 0;
        }
        const floor = Number(raw);
        // "Infinity", or an edited value, says only that something was cleared: exclude everything.
        return /^\d+$/.test(raw) && Number.isSafeInteger(floor) ? floor : EVERY_GENERATION;
    }

    private writeFloor(generation: number): boolean {
        if (this.publicStorage === undefined) {
            return false;
        }
        try {
            this.publicStorage.setItem(this.floorKey, String(generation));
            return true;
        } catch {
            return false;
        }
    }
}
