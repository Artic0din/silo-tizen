import type { NativeSession } from "./session.ts";
import type { SecretStore } from "./secretStore.ts";
import type { PublicStorage, RandomBytes } from "./deviceIdentity.ts";
import type { ProfileSummary } from "../contracts/v2/wire.ts";
import { operations } from "../api/operations.ts";

interface LaunchChoice {
    readonly remember: boolean;
    readonly profileId?: string;
    readonly proofAlias?: string;
}

/** Public choice points to a unique protected record; abandoned records cannot restore authority. */
export class ProfileLaunch {
    private readonly session: NativeSession;
    private readonly storage: PublicStorage | undefined;
    private readonly secrets: SecretStore;
    private readonly random: RandomBytes;
    private readonly scope: string;
    private lastKey: string | undefined;
    private sessionChoice: { readonly key: string; readonly choice: LaunchChoice } | undefined;

    constructor(session: NativeSession, storage: PublicStorage | undefined, secrets: SecretStore, random: RandomBytes, serverId: string) {
        this.session = session;
        this.storage = storage;
        this.secrets = secrets;
        this.random = random;
        this.scope = JSON.stringify([session.http.base.baseUrl, serverId, session.http.deviceId]);
        this.lastKey = this.key();
        session.onAuthorityChange(change => {
            if (["signed_out", "session_expired", "signed_in", "profile_proof_revoked"].includes(change.reason)) {
                const key = this.lastKey ?? this.key();
                if (key !== undefined && this.choice(key) !== undefined) this.invalidate(key);
                const currentKey = this.key();
                if (change.reason === "signed_in" && currentKey !== undefined && currentKey !== key && this.choice(currentKey) !== undefined) this.invalidate(currentKey);
            }
            this.lastKey = this.key();
        });
    }

    private key(): string | undefined {
        const account = this.session.account;
        return account === undefined ? undefined : `silo.native.profileLaunch:${this.scope}:${account.id}`;
    }

    private choice(key = this.key()): LaunchChoice | undefined {
        if (key === undefined) return undefined;
        if (this.sessionChoice?.key === key) return this.sessionChoice.choice;
        try {
            const raw = this.storage?.getItem(key);
            if (raw == null) return undefined;
            const value: unknown = JSON.parse(raw);
            if (typeof value !== "object" || value === null || !("remember" in value) || typeof value.remember !== "boolean") return undefined;
            if (!value.remember) return { remember: false };
            if (!("profileId" in value) || typeof value.profileId !== "string") return undefined;
            const proofAlias = "proofAlias" in value && typeof value.proofAlias === "string" ? value.proofAlias : undefined;
            return { remember: true, profileId: value.profileId, ...(proofAlias === undefined ? {} : { proofAlias }) };
        } catch { return undefined; }
    }

    get needsOffer(): boolean { return this.choice() === undefined; }
    get remembered(): boolean { return this.choice()?.remember === true; }

    continueWithoutSaving(): void {
        const key = this.key();
        if (key !== undefined) this.sessionChoice = { key, choice: { remember: false } };
    }

    private persist(key: string, choice: LaunchChoice): void {
        if (this.storage === undefined) throw new Error("Device storage unavailable");
        const raw = JSON.stringify(choice);
        this.storage.setItem(key, raw);
        if (this.storage.getItem(key) !== raw) throw new Error("Device preference was not saved");
        this.sessionChoice = undefined;
    }

    private invalidate(key: string): void {
        const old = this.choice(key);
        try { this.persist(key, { remember: false }); } catch { /* A refused proof remains subject to server validation. */ }
        if (old?.proofAlias !== undefined) void this.secrets.remove(old.proofAlias);
    }

    async setRemember(remember: boolean, signal?: AbortSignal): Promise<void> {
        const key = this.key();
        const active = this.session.activeProfile;
        if (key === undefined || active === undefined) throw new Error("Choose a profile first");
        const generation = this.session.authorityGeneration;
        const old = this.choice(key);
        if (!remember) {
            this.persist(key, { remember: false });
        } else {
            let proofAlias: string | undefined;
            if (active.token !== undefined) {
                if (!this.secrets.persistent) throw new Error("Protected device storage unavailable");
                const bytes = new Uint8Array(16);
                this.random(bytes);
                proofAlias = `silo.profile.${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
                const saved = await this.secrets.write(proofAlias, JSON.stringify({ key, profileId: active.id, proof: active.token }));
                if (!saved) throw new Error("Profile unlock was not saved");
            }
            try {
                if (signal?.aborted || generation !== this.session.authorityGeneration || key !== this.key()) throw new Error("Profile changed while saving");
                this.persist(key, { remember: true, profileId: active.id, ...(proofAlias === undefined ? {} : { proofAlias }) });
            } catch (error) {
                if (proofAlias !== undefined) await this.secrets.remove(proofAlias);
                throw error;
            }
        }
        if (old?.proofAlias !== undefined) await this.secrets.remove(old.proofAlias);
    }

    async restore(list: readonly ProfileSummary[], signal: AbortSignal): Promise<ProfileSummary | undefined> {
        const key = this.key();
        const choice = this.choice(key);
        if (key === undefined || !choice?.remember) return undefined;
        const profile = list.find(item => item.id === choice.profileId);
        if (profile === undefined) { this.invalidate(key); return undefined; }
        let proof: string | undefined;
        const generation = this.session.authorityGeneration;
        if (profile.hasPin) {
            if (choice.proofAlias === undefined) return undefined;
            const stored = await this.secrets.read(choice.proofAlias);
            if (stored.status === "failed") throw new Error("Protected device storage unavailable");
            if (stored.status !== "found") { this.invalidate(key); return undefined; }
            try {
                const row: unknown = JSON.parse(stored.value);
                if (typeof row !== "object" || row === null || !("key" in row) || row.key !== key || !("profileId" in row) || row.profileId !== profile.id || !("proof" in row) || typeof row.proof !== "string" || row.proof.length === 0) throw new Error("Invalid unlock");
                proof = row.proof;
            } catch { this.invalidate(key); return undefined; }
        }
        if (signal.aborted || generation !== this.session.authorityGeneration || key !== this.key()) return undefined;
        this.session.setProfile({ id: profile.id, token: proof }, "profile_selected");
        const restoredGeneration = this.session.authorityGeneration;
        try {
            // Reuse the normal profile-scoped authority check before opening any content.
            await this.session.call({ ...operations.listUserLibraries(), profileScoped: true, signal });
            if (signal.aborted || this.session.authorityGeneration !== restoredGeneration) return undefined;
            return profile;
        } catch (error) {
            if (this.session.authorityGeneration === restoredGeneration) this.session.setProfile(undefined, "profile_cleared");
            throw error;
        }
    }
}
