import { CredentialVault, type StoredCredential, type VaultLoad, type VaultSave, type VaultClear } from "./credentialVault.ts";
import type { PublicStorage, RandomBytes } from "./deviceIdentity.ts";
import type { SecretStore } from "./secretStore.ts";

export interface SavedAccount {
    readonly id: string;
    readonly baseUrl: string;
    readonly serverId: string;
    readonly accountId: string;
    readonly username: string;
    readonly profileCount: number;
    readonly needsSignIn: boolean;
}
const KEY = "silo.native.accounts.v1";
interface Directory { readonly accounts: readonly SavedAccount[]; readonly selected?: string }

/** Public metadata only. Credentials remain in the protected, server-bound vault. */
export class AccountDirectory {
    private state: Directory;
    private readonly storage: PublicStorage | undefined;
    private readonly random: RandomBytes;
    constructor(storage: PublicStorage | undefined, random: RandomBytes) {
        this.storage = storage;
        this.random = random;
        const raw = storage?.getItem(KEY);
        this.state = raw == null ? { accounts: [] } : decodeDirectory(raw);
    }
    private reload(): void {
        const raw = this.storage?.getItem(KEY);
        if (raw != null) this.state = decodeDirectory(raw);
    }
    list(): readonly SavedAccount[] { this.reload(); return this.state.accounts; }
    get selected(): string | undefined { this.reload(); return this.state.selected; }
    private write(state: Directory): void {
        this.storage?.setItem(KEY, JSON.stringify(state));
        this.state = state;
    }
    add(baseUrl: string, serverId: string, accountId: string, username: string): SavedAccount {
        const existing = this.list().find(row => row.baseUrl === baseUrl && row.serverId === serverId && row.accountId === accountId);
        if (existing) return existing;
        const bytes = new Uint8Array(16);
        this.random(bytes);
        const id = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
        if (this.list().some(row => row.id === id)) throw new Error("Account identity collision");
        const row = { id, baseUrl, serverId, accountId, username, profileCount: 0, needsSignIn: false };
        this.write({ ...this.state, accounts: [...this.list(), row] });
        return row;
    }
    select(id: string): void {
        const rows = this.list();
        const selected = rows.find(row => row.id === id);
        if (!selected) throw new Error("Account missing");
        this.write({ accounts: [selected, ...rows.filter(row => row.id !== id)], selected: id });
    }
    update(id: string, change: Partial<Pick<SavedAccount, "profileCount" | "needsSignIn" | "username">>): void {
        this.reload();
        this.write({ ...this.state, accounts: this.list().map(row => row.id === id ? { ...row, ...change } : row) });
    }
    remove(id: string): void {
        const removed = this.list().find(row => row.id === id);
        const accounts = this.list().filter(row => row.id !== id);
        this.write({ accounts, ...(this.selected === id || this.selected === undefined ? {} : { selected: this.selected }) });
        if (removed && !accounts.some(row => row.baseUrl === removed.baseUrl) && this.storage?.getItem("silo.native.server") === removed.baseUrl) this.storage.removeItem("silo.native.server");
    }
}

function decodeDirectory(raw: string): Directory {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || !("accounts" in value) || !Array.isArray(value.accounts)) throw new Error("Account list unavailable");
    for (const row of value.accounts) {
        if (typeof row !== "object" || row === null || !["id", "baseUrl", "serverId", "accountId", "username"].every(key => typeof Reflect.get(row, key) === "string") || typeof row.profileCount !== "number" || typeof row.needsSignIn !== "boolean") throw new Error("Account list unavailable");
    }
    if ("selected" in value && typeof value.selected !== "string") throw new Error("Account selection unavailable");
    return value as Directory;
}

/** Legacy records remain intact until both the new vault and index are durable. */
export class AccountVault extends CredentialVault {
    readonly directory: AccountDirectory;
    private activeId: string | undefined;
    private readonly secrets: SecretStore;
    private readonly storage: PublicStorage | undefined;
    private readonly address: string;
    private readonly adding: boolean;
    private chooseOnSave = true;
    private accountQueue: Promise<unknown> = Promise.resolve();
    private readonly vaults = new Map<string, CredentialVault>();
    constructor(store: SecretStore, storage: PublicStorage | undefined, baseUrl: string, random: RandomBytes, accountId?: string, adding = false, directoryStorage = store.persistent ? storage : undefined) {
        super(store, storage, baseUrl);
        this.adding = adding;
        this.secrets = store;
        this.storage = storage;
        this.address = baseUrl;
        this.directory = new AccountDirectory(directoryStorage, random);
        this.activeId = accountId ?? this.directory.list().find(row => row.id === this.directory.selected && row.baseUrl === baseUrl)?.id;
    }
    get localAccountId(): string | undefined { return this.activeId; }
    private accountVault(id: string): CredentialVault {
        let vault = this.vaults.get(id);
        if (!vault) { vault = new CredentialVault(this.secrets, this.storage, this.address, id); this.vaults.set(id, vault); }
        return vault;
    }
    private ordered<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.accountQueue.then(operation, operation);
        this.accountQueue = result.catch(() => undefined);
        return result;
    }
    override load(): Promise<VaultLoad> { return this.ordered(() => this.loadAccount()); }
    private async loadAccount(): Promise<VaultLoad> {
        if (this.adding) return { status: "none" };
        if (this.activeId) {
            const loaded = await this.accountVault(this.activeId).load();
            const row = this.directory.list().find(row => row.id === this.activeId);
            if (loaded.status === "found" && (!row || loaded.credential.accountId !== row.accountId || loaded.credential.serverId !== row.serverId)) return { status: "corrupt" };
            if (this.directory.list().find(row => row.id === this.activeId)?.needsSignIn && loaded.status === "found") return { status: "none" };
            if (loaded.status === "found") {
                try { this.directory.select(this.activeId); } catch { return { status: "unavailable" }; }
                this.chooseOnSave = false;
            }
            return loaded;
        }
        const legacy = await super.load();
        if (legacy.status !== "found") return legacy;
        const credential = legacy.credential;
        try {
            const row = this.directory.add(this.address, credential.serverId, credential.accountId, credential.username);
            const existing = await this.accountVault(row.id).load();
            if (existing.status === "unavailable" || existing.status === "corrupt") return existing;
            if (existing.status === "found") {
                this.directory.select(row.id);
                this.activeId = row.id;
                this.chooseOnSave = false;
                return existing;
            }
            if (row.needsSignIn) return { status: "none" };
            const saved = await this.accountVault(row.id).save(credential);
            if (saved !== "saved") return { status: "unavailable" };
            this.directory.select(row.id);
            this.activeId = row.id;
            this.chooseOnSave = false;
            // The protected legacy copy is retained as recovery until explicit sign-out.
            return legacy;
        } catch { return { status: "unavailable" }; }
    }
    override save(credential: StoredCredential): Promise<VaultSave> { return this.ordered(() => this.saveAccount(credential)); }
    private async saveAccount(credential: StoredCredential): Promise<VaultSave> {
        try {
            const row = this.directory.add(this.address, credential.serverId, credential.accountId, credential.username);
            this.activeId = row.id;
            const saved = await this.accountVault(row.id).save(credential);
            if (saved !== "saved") return saved;
            this.directory.update(row.id, { needsSignIn: false, username: credential.username });
            if (this.chooseOnSave) this.directory.select(row.id);
            this.activeId = row.id;
            this.chooseOnSave = false;
            return "saved";
        } catch { return "failed"; }
    }
    override prepareSignIn(): Promise<VaultClear> {
        this.chooseOnSave = true;
        return this.adding ? Promise.resolve("cleared") : this.clear();
    }
    override clear(): Promise<VaultClear> { return this.ordered(() => this.clearAccount()); }
    override signOut(): Promise<VaultClear> {
        return this.ordered(async () => {
            const cleared = await this.clearAccount();
            if (cleared !== "failed" && this.activeId) {
                try { this.directory.remove(this.activeId); } catch { return "failed"; }
            }
            return cleared;
        });
    }
    private async clearAccount(): Promise<VaultClear> {
        if (!this.activeId) return super.clear();
        try { this.directory.update(this.activeId, { needsSignIn: true }); } catch { return "failed"; }
        const legacy = await super.clear();
        if (legacy === "failed") return legacy;
        return this.accountVault(this.activeId).clear();
    }
}
