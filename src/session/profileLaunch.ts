import type { NativeSession } from "./session.ts";
import type { SecretStore } from "./secretStore.ts";
import { randomHex, type PublicStorage, type RandomBytes } from "./deviceIdentity.ts";
import type { ProfileSummary } from "../contracts/v2/wire.ts";
import { operations } from "../api/operations.ts";
import { ApiError } from "../api/errors.ts";

interface LaunchChoice {
    readonly remember: boolean;
    readonly behavior?: LaunchBehavior;
    readonly selectionRequired?: boolean;
    readonly profileId?: string;
    readonly proofAlias?: string;
    /** Proofs a newer choice replaced; each stays named here until the key store confirms its removal. */
    readonly retiredAliases?: readonly string[];
    /** The sign-in epoch the choice was made under; a choice without the current one never restores. */
    readonly epoch?: string;
    readonly profile?: Pick<ProfileSummary, "name" | "isPrimary" | "isChild">;
}
function clearedChoice(proofAlias: string | undefined, retiredAliases: readonly string[]): LaunchChoice {
    return { remember: false, ...(proofAlias === undefined ? {} : { proofAlias }), ...(retiredAliases.length === 0 ? {} : { retiredAliases }) };
}
export type LaunchBehavior = "automatic" | "askEveryLaunch" | "afterOneHour" | "afterTwelveHours";

/** Public choice points to a unique protected record; abandoned records cannot restore authority. */
export class ProfileLaunch {
    private readonly session: NativeSession;
    private readonly storage: PublicStorage | undefined;
    private readonly secrets: SecretStore;
    private readonly random: RandomBytes;
    private readonly scope: string;
    private lastKey: string | undefined;
    /** Choices storage refused to save, per account key, kept for this run. */
    private readonly unsaved = new Map<string, LaunchChoice>();

    constructor(session: NativeSession, storage: PublicStorage | undefined, secrets: SecretStore, random: RandomBytes, serverId: string) {
        this.session = session;
        this.storage = storage;
        this.secrets = secrets;
        this.random = random;
        this.scope = JSON.stringify([session.http.base.baseUrl, serverId, session.http.deviceId]);
        this.lastKey = this.key();
        this.sweep();
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

    /** A choice an earlier sign-in left behind, or a cleared one whose proof is still stored, is cleared and retried; so is any replaced proof. */
    private sweep(): void {
        const key = this.key();
        const leftover = key === undefined ? undefined : this.stored(key);
        if (key === undefined || leftover === undefined) return;
        if (leftover.remember ? this.choice(key)?.remember !== true : leftover.proofAlias !== undefined) this.invalidate(key);
        else for (const alias of leftover.retiredAliases ?? []) void this.dropProof(key, alias);
    }

    private key(): string | undefined {
        const account = this.session.account;
        return account === undefined ? undefined : `silo.native.profileLaunch:${this.scope}:${account.id}`;
    }

    /** What the device holds for this account, whichever sign-in it was made under. */
    private stored(key: string): LaunchChoice | undefined {
        const unsaved = this.unsaved.get(key);
        if (unsaved !== undefined) return unsaved;
        try {
            const raw = this.storage?.getItem(key);
            if (raw == null) return undefined;
            const value: unknown = JSON.parse(raw);
            if (typeof value !== "object" || value === null || !("remember" in value) || typeof value.remember !== "boolean") return undefined;
            const proofAlias = "proofAlias" in value && typeof value.proofAlias === "string" ? value.proofAlias : undefined;
            const retired = "retiredAliases" in value && Array.isArray(value.retiredAliases) ? value.retiredAliases.filter((alias): alias is string => typeof alias === "string") : [];
            const retiredAliases = retired.length === 0 ? {} : { retiredAliases: retired };
            if (!value.remember) return { remember: false, ...(proofAlias === undefined ? {} : { proofAlias }), ...retiredAliases };
            if (!("profileId" in value) || typeof value.profileId !== "string") return undefined;
            const epoch = "epoch" in value && typeof value.epoch === "string" && value.epoch !== "" ? value.epoch : undefined;
            const profile = "profile" in value ? value.profile : undefined;
            const summary = typeof profile === "object" && profile !== null && "name" in profile && typeof profile.name === "string" && "isPrimary" in profile && typeof profile.isPrimary === "boolean" && "isChild" in profile && typeof profile.isChild === "boolean" ? { name: profile.name, isPrimary: profile.isPrimary, isChild: profile.isChild } : undefined;
            const behavior = "behavior" in value && (value.behavior === "automatic" || value.behavior === "askEveryLaunch" || value.behavior === "afterOneHour" || value.behavior === "afterTwelveHours") ? value.behavior : undefined;
            return { remember: true, profileId: value.profileId, ...(epoch === undefined ? {} : { epoch }), ...(behavior === undefined ? {} : { behavior }), ...("selectionRequired" in value && value.selectionRequired === true ? { selectionRequired: true } : {}), ...(proofAlias === undefined ? {} : { proofAlias }), ...retiredAliases, ...(summary === undefined ? {} : { profile: summary }) };
        } catch { return undefined; }
    }

    /** Apple ignores a remembered profile whose account epoch differs, or is missing, at launch. */
    private choice(key = this.key()): LaunchChoice | undefined {
        if (key === undefined) return undefined;
        const choice = this.stored(key);
        if (choice?.remember === true && (choice.epoch === undefined || choice.epoch !== this.session.signInEpoch)) return { remember: false };
        return choice;
    }

    get needsOffer(): boolean { return this.choice() === undefined; }
    get remembered(): boolean { return this.choice()?.remember === true; }
    get behavior(): LaunchBehavior {
        if (!this.remembered) return "askEveryLaunch";
        return this.choice()?.behavior ?? "automatic";
    }
    private awayAt: number | undefined;
    recordAway(now = Date.now()): void {
        if (this.choice()?.selectionRequired) return;
        const key = this.key();
        let away = this.awayAt ?? now;
        try {
            const stored = Number(this.storage?.getItem(`${key}:away`));
            if (Number.isFinite(stored) && stored > 0) away = Math.min(away, stored);
        } catch { /* Session-only timing still works when storage is unavailable. */ }
        this.awayAt = away;
        try { if (key !== undefined) this.storage?.setItem(`${key}:away`, String(away)); } catch { /* Retain the current session's interval. */ }
    }
    recordActive(): void {
        this.awayAt = undefined;
        try { const key = this.key(); if (key !== undefined) this.storage?.removeItem(`${key}:away`); } catch { /* Optional lifecycle persistence must not block Browse. */ }
    }
    requiresSelection(now = Date.now()): boolean {
        if (this.choice()?.selectionRequired) return true;
        let away = this.awayAt ?? 0;
        try { away = this.awayAt ?? Number(this.storage?.getItem(`${this.key()}:away`)); } catch { /* Use the current session's away interval. */ }
        const behavior = this.behavior;
        return away > 0 && (behavior === "askEveryLaunch" || (behavior !== "automatic" && now - away >= (behavior === "afterOneHour" ? 3600 : 43200) * 1000));
    }
    requireSelection(): void {
        const key = this.key();
        const choice = this.choice(key);
        if (key === undefined || choice === undefined) return;
        const required = { ...choice, selectionRequired: true };
        try { this.persist(key, required); } catch { this.unsaved.set(key, required); }
    }
    async setBehavior(behavior: LaunchBehavior, signal?: AbortSignal): Promise<void> {
        await this.setRemember(behavior !== "askEveryLaunch", signal, behavior);
    }
    get rememberedProfileId(): string | undefined { const choice = this.choice(); return choice?.remember === true ? choice.profileId : undefined; }

    continueWithoutSaving(): void {
        const key = this.key();
        if (key !== undefined) this.unsaved.set(key, { remember: false });
    }

    private persist(key: string, choice: LaunchChoice): void {
        if (this.storage === undefined) throw new Error("Device storage unavailable");
        const raw = JSON.stringify(choice);
        this.storage.setItem(key, raw);
        if (this.storage.getItem(key) !== raw) throw new Error("Device preference was not saved");
        this.unsaved.delete(key);
    }

    private invalidate(key: string): void {
        const old = this.stored(key);
        const cleared = clearedChoice(old?.proofAlias, old?.retiredAliases ?? []);
        try { this.persist(key, cleared); } catch { this.unsaved.set(key, cleared); }
        for (const alias of [old?.proofAlias, ...(old?.retiredAliases ?? [])]) if (alias !== undefined) void this.dropProof(key, alias);
    }

    /** The choice keeps naming the alias until the key store confirms the removal, so the next start retries it. */
    private async dropProof(key: string, alias: string): Promise<void> {
        if ((await this.secrets.remove(alias)) === "failed") return;
        const current = this.stored(key);
        if (current === undefined) return;
        const retired = (current.retiredAliases ?? []).filter(item => item !== alias);
        const clearedAlias = current.remember === false && current.proofAlias === alias;
        if (!clearedAlias && retired.length === (current.retiredAliases ?? []).length) return;
        const { retiredAliases: _retired, ...rest } = current;
        const next: LaunchChoice = current.remember
            ? { ...rest, ...(retired.length === 0 ? {} : { retiredAliases: retired }) }
            : clearedChoice(clearedAlias ? undefined : current.proofAlias, retired);
        try { this.persist(key, next); } catch { this.unsaved.set(key, next); }
    }

    async setRemember(remember: boolean, signal?: AbortSignal, profileOrBehavior?: ProfileSummary | LaunchBehavior): Promise<void> {
        const key = this.key();
        const active = this.session.activeProfile;
        const epoch = this.session.signInEpoch;
        if (key === undefined || active === undefined || epoch === undefined) throw new Error("Choose a profile first");
        const generation = this.session.authorityGeneration;
        const old = this.choice(key);
        const oldStored = this.stored(key);
        const oldAlias = oldStored?.proofAlias;
        const oldRetired = oldStored?.retiredAliases ?? [];
        let newAlias: string | undefined;
        if (!remember) {
            this.persist(key, clearedChoice(oldAlias, oldRetired));
        } else {
            let proofAlias: string | undefined;
            if (active.token !== undefined) {
                if (!this.secrets.persistent) throw new Error("Protected device storage unavailable");
                proofAlias = `silo.profile.${randomHex(this.random, 16)}`;
                const saved = await this.secrets.write(proofAlias, JSON.stringify({ key, epoch, profileId: active.id, proof: active.token }));
                if (!saved) throw new Error("Profile unlock was not saved");
            }
            try {
                if (signal?.aborted || generation !== this.session.authorityGeneration || key !== this.key()) throw new Error("Profile changed while saving");
                const behavior = profileOrBehavior === "automatic" || profileOrBehavior === "askEveryLaunch" || profileOrBehavior === "afterOneHour" || profileOrBehavior === "afterTwelveHours" ? profileOrBehavior : undefined;
                const profile = behavior === undefined && typeof profileOrBehavior === "object" && profileOrBehavior !== null ? profileOrBehavior : undefined;
                const summary = profile !== undefined ? (profile.id === active.id ? { name: profile.name, isPrimary: profile.isPrimary, isChild: profile.isChild } : undefined) : old?.profile;
                const retiredAliases = [...oldRetired, ...(oldAlias === undefined || oldAlias === proofAlias ? [] : [oldAlias])];
                this.persist(key, { remember: true, behavior: behavior ?? old?.behavior ?? "automatic", profileId: active.id, epoch, ...(proofAlias === undefined ? {} : { proofAlias }), ...(retiredAliases.length === 0 ? {} : { retiredAliases }), ...(summary === undefined ? {} : { profile: summary }) });
            } catch (error) {
                if (proofAlias !== undefined) await this.secrets.remove(proofAlias);
                throw error;
            }
            newAlias = proofAlias;
        }
        for (const alias of [oldAlias, ...oldRetired]) if (alias !== undefined && alias !== newAlias) await this.dropProof(key, alias);
        this.recordActive();
    }

    async restoreOffline(signal: AbortSignal): Promise<ProfileSummary | undefined> {
        const choice = this.choice();
        if (!choice?.remember || choice.profileId === undefined) return undefined;
        return this.restore([{ id: choice.profileId, name: choice.profileId, hasPin: choice.proofAlias !== undefined, isPrimary: false, isChild: false, ...choice.profile, avatarUrl: undefined }], signal, true);
    }

    async restore(list: readonly ProfileSummary[], signal: AbortSignal, localOnly = false): Promise<ProfileSummary | undefined> {
        const key = this.key();
        const choice = this.choice(key);
        if (key === undefined || !choice?.remember) return undefined;
        if (this.requiresSelection()) { this.requireSelection(); return undefined; }
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
                if (typeof row !== "object" || row === null || !("key" in row) || row.key !== key || !("profileId" in row) || row.profileId !== profile.id || !("epoch" in row) || row.epoch !== choice.epoch || !("proof" in row) || typeof row.proof !== "string" || row.proof.length === 0) throw new Error("Invalid unlock");
                proof = row.proof;
            } catch { this.invalidate(key); return undefined; }
        }
        if (signal.aborted || generation !== this.session.authorityGeneration || key !== this.key()) return undefined;
        this.session.setProfile({ id: profile.id, token: proof }, "profile_selected");
        const restoredGeneration = this.session.authorityGeneration;
        if (localOnly) return profile;
        try {
            // Reuse the normal profile-scoped authority check before opening any content.
            await this.session.call({ ...operations.listUserLibraries(), profileScoped: true, signal });
            if (signal.aborted || this.session.authorityGeneration !== restoredGeneration) return undefined;
            return profile;
        } catch (error) {
            if (error instanceof ApiError && ["network", "timeout"].includes(error.failure.kind) && !signal.aborted && this.session.authorityGeneration === restoredGeneration) return profile;
            if (this.session.authorityGeneration === restoredGeneration) this.session.setProfile(undefined, "profile_cleared");
            throw error;
        }
    }
}
