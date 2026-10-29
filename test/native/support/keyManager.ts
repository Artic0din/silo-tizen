import type { TizenKeyManager } from "../../../src/session/secretStore.ts";

class WebAPIException extends Error {
    constructor(name: string) {
        super(name);
        this.name = name;
    }
}

/**
 * Behaves like Tizen KeyManager for one package: an alias holds one value, saving over an
 * existing alias fails, getData/removeData throw NotFoundError for a missing alias. Failure
 * switches simulate a broken key store.
 */
export class FakeKeyManager implements TizenKeyManager {
    readonly items = new Map<string, string>();
    failSave = false;
    failGet = false;
    failRemove = false;
    /** Aliases whose reads fail while others still read, like one damaged entry. */
    readonly unreadable = new Set<string>();
    private heldSaves: (() => void)[] | undefined;

    /** Holds every save's callback until `release`, like a KeyManager slow to answer. */
    holdSaves(): { readonly waiting: () => number; readonly release: () => void } {
        const held: (() => void)[] = [];
        this.heldSaves = held;
        return {
            waiting: () => held.length,
            release: () => {
                if (this.heldSaves === held) {
                    this.heldSaves = undefined;
                }
                for (const complete of held.splice(0)) {
                    complete();
                }
            },
        };
    }

    saveData(
        name: string,
        rawData: string,
        _password: string | null,
        successCallback: () => void,
        errorCallback: (error: { readonly name: string }) => void,
    ): void {
        const alias = name.replace(/ /g, "");
        const complete = (): void => {
            if (this.failSave || this.items.has(alias)) {
                errorCallback(new WebAPIException("UnknownError"));
                return;
            }
            this.items.set(alias, rawData);
            successCallback();
        };
        if (this.heldSaves !== undefined) {
            this.heldSaves.push(complete);
            return;
        }
        setImmediate(complete);
    }

    getData(dataAlias: { readonly name: string }): string {
        if (this.failGet || this.unreadable.has(dataAlias.name)) {
            throw new WebAPIException("UnknownError");
        }
        const value = this.items.get(dataAlias.name);
        if (value === undefined) {
            throw new WebAPIException("NotFoundError");
        }
        return value;
    }

    removeData(dataAlias: { readonly name: string }): void {
        if (this.failRemove) {
            throw new WebAPIException("UnknownError");
        }
        if (!this.items.delete(dataAlias.name)) {
            throw new WebAPIException("NotFoundError");
        }
    }
}

export class MemoryPublicStorage {
    readonly items = new Map<string, string>();
    /** localStorage that throws on read, as a browser that refuses storage access does. */
    failGet = false;
    /** localStorage that throws on write, as a full or locked store does. */
    failSet = false;

    getItem(key: string): string | null {
        if (this.failGet) {
            throw new Error("SecurityError");
        }
        return this.items.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
        if (this.failSet) {
            throw new Error("QuotaExceededError");
        }
        this.items.set(key, value);
    }

    removeItem(key: string): void {
        this.items.delete(key);
    }
}
