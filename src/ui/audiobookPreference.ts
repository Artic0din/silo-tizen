type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };

/**
 * `nav.show_audiobooks`: a client_local setting, off until chosen, kept per server and profile on this device
 * and never sent to the server (silo-apple AppNavPreferences). Blocked storage leaves the choice for this run.
 */
export class ShowAudiobooks {
    private readonly storage: Storage | undefined;
    private readonly key: string;
    private choice: boolean | undefined;

    constructor(storage: Storage | undefined, key: string) {
        this.storage = storage;
        this.key = key;
    }

    get value(): boolean {
        if (this.choice !== undefined) return this.choice;
        try { return this.storage?.getItem(this.key) === "true"; } catch { return false; }
    }

    set(value: boolean): void {
        this.choice = value;
        try { this.storage?.setItem(this.key, String(value)); } catch { /* The choice holds for this run. */ }
    }
}
