import type { PublicStorage } from "../session/deviceIdentity.ts";
import { SHOW_AUDIOBOOKS_KEY } from "../contracts/v2/audiobooks.ts";

/** Client-local contract key, scoped to the same server/profile owner as browse. */
export class AudiobookPreference {
    value = false;
    error = false;
    private readonly key: string;
    private readonly storage: PublicStorage | undefined;
    constructor(storage: PublicStorage | undefined, owner: string) {
        this.storage = storage;
        this.key = `silo.${SHOW_AUDIOBOOKS_KEY}:${owner}`;
        try { this.value = storage?.getItem(this.key) === "true"; } catch { this.error = true; }
    }
    set(value: boolean): void {
        try {
            if (this.storage === undefined) throw new Error("Storage unavailable");
            this.storage.setItem(this.key, String(value));
            this.value = value;
            this.error = false;
        } catch { this.error = true; }
    }
}
