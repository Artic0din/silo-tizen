import { ApiError } from "../api/errors.ts";
import type { JsonValue, RequestSpec } from "../api/http.ts";
import { subtitleDisplayOperations as operations } from "../api/subtitleDisplayOperations.ts";
import { subtitleOperations } from "../api/subtitleOperations.ts";
import { decodeSettingsCapabilities } from "../contracts/v2/settings.ts";
import { DEFAULT_APPEARANCE, type SubtitleAppearance } from "../contracts/v2/subtitles.ts";
import type { PublicStorage } from "../session/deviceIdentity.ts";
import type { NativeSession } from "../session/session.ts";
import { allowedScopes, appearanceValue, APPEARANCE_KEY, clampDelay, editAppearance, type AppearanceMember, subtitleControlSupport, type SubtitleControlSupport, SYNC_KEY, syncWriteScope } from "./subtitleAppearance.ts";

export interface SubtitleDisplayView {
    readonly delay: boolean;
    readonly styling: boolean;
    readonly deviceScope: boolean;
    readonly textOpacity: boolean;
    readonly delayMs: number;
    readonly appearance: SubtitleAppearance;
    readonly deviceOverride: boolean;
    readonly busy: boolean;
    readonly message: string;
}

const FAILED = "Couldn't save that change. Try again.";
const MARKER_PREFIX = "silo.native.player.leftoverDeviceSubtitleOffsetCleared.";
const OWED_DELETE_PREFIX = "silo.native.player.pendingDeviceSettingWrites.";
const MIGRATION_PREFIX = "silo.native.player.serverDeviceSettingsMigration.";

/**
 * Settings scope for this server, account, profile and device. Apple's marker key is
 * `player.leftoverDeviceSubtitleOffsetCleared.<scope>` in UserDefaults
 * (`PlayerSettings.leftoverSubtitleOffsetClearKey`, silo-apple 2ef3a171). This client
 * keeps that name in the public per-install store, which never holds tokens.
 */
export function subtitleSettingsScope(session: NativeSession, profileId: string): string | undefined {
    const accountId = session.account?.id;
    if (accountId === undefined || session.activeProfile?.id !== profileId) return undefined;
    return JSON.stringify([session.http.base.baseUrl, session.server.serverId, accountId, profileId, session.http.deviceId]);
}

export class SubtitleDisplay {
    private readonly session: NativeSession;
    private readonly profileId: string;
    private readonly onChange: (appearance: SubtitleAppearance, sync: number) => void;
    private readonly changed: () => void;
    private readonly storage: PublicStorage | undefined;
    private readonly abort = new AbortController();
    private support: SubtitleControlSupport = { delay: false, styling: false, deviceScope: false, syncAtProfile: false, textOpacity: false };
    private syncScopes: readonly string[] = [];
    private manifest = 0;
    private revisionScope: string | undefined;
    private appearance: SubtitleAppearance = DEFAULT_APPEARANCE;
    private delayMs = 0;
    private deviceOverride = false;
    private busy = false;
    private message = "";
    private loaded = false;
    private edited = false;
    private decided = false;
    private unsettledSync = 0;
    private clearing: Promise<void> | undefined;

    constructor(session: NativeSession, profileId: string, onChange: (appearance: SubtitleAppearance, sync: number) => void, changed: () => void, storage?: PublicStorage) {
        this.session = session;
        this.profileId = profileId;
        this.onChange = onChange;
        this.changed = changed;
        this.storage = storage;
    }

    get view(): SubtitleDisplayView | undefined {
        if (!this.loaded) return undefined;
        return {
            delay: this.support.delay, styling: this.support.styling, deviceScope: this.support.deviceScope, textOpacity: this.support.textOpacity,
            delayMs: this.delayMs, appearance: this.appearance, deviceOverride: this.deviceOverride, busy: this.busy, message: this.message,
        };
    }

    get editedAppearance(): boolean { return this.edited; }

    destroy(): void { this.abort.abort(); }

    async load(): Promise<void> {
        let effectiveSupported = false;
        try {
            const capability = await this.call(operations.capabilities());
            const contract = await this.call(operations.contract());
            const support = subtitleControlSupport(contract, capability);
            effectiveSupported = support.styling || support.delay || support.deviceScope;
            const device = support.deviceScope ? await this.call(operations.deviceAppearance(this.profileId, this.session.http.deviceId)) : false;
            if (this.abort.signal.aborted) return;
            this.manifest = decodeSettingsCapabilities(capability).manifestRevision;
            this.revisionScope = subtitleSettingsScope(this.session, this.profileId);
            this.deviceOverride = device;
            // A delete left owed is flushed before the effective read, as Apple's refresh
            // drains the journal before it paints. The decision itself stays once.
            // Support stays hidden until those reads succeed, so a missing preference
            // does not offer edits.
            await this.flushOwedDelete(support);
            const [appearance, readDelay] = await Promise.all([
                support.styling ? this.call(subtitleOperations.subtitleAppearance(this.profileId)) : this.appearance,
                support.delay ? this.call(subtitleOperations.subtitleSync()) : this.delayMs,
            ]);
            if (this.abort.signal.aborted) return;
            this.support = support;
            this.syncScopes = allowedScopes(contract, SYNC_KEY);
            this.appearance = appearance;
            this.delayMs = readDelay;
            await this.finishLeftoverClear();
            if (this.abort.signal.aborted) return;
            this.loaded = true;
            this.onChange(appearance, this.delayMs);
        } catch (error) {
            if (this.abort.signal.aborted) return;
            this.loaded = true;
            if (!(error instanceof ApiError && error.status === 404 && !effectiveSupported)) this.message = "Could not load subtitle preferences. Reopen playback to retry.";
        }
        this.changed();
    }

    adopt(appearance: SubtitleAppearance, sync: number): void {
        if (this.edited || this.busy || this.abort.signal.aborted) return;
        this.appearance = appearance;
        this.delayMs = sync;
        if (this.loaded) this.changed();
    }

    async setDelay(milliseconds: number): Promise<void> {
        if (!this.support.delay) return;
        const next = clampDelay(milliseconds);
        const scope = syncWriteScope(this.deviceOverride, this.syncScopes, this.manifest);
        // A newer device offset replaces the journaled clear. A profile write keeps it,
        // so the old device row cannot stay in front of the value just saved.
        if (scope === "profile_device") {
            const id = subtitleSettingsScope(this.session, this.profileId);
            if (id !== undefined) this.erase(owedDeleteKey(id));
        }
        await this.commit(() => this.call(operations.put(SYNC_KEY, next, scope)), () => { this.delayMs = next; }, true);
    }

    async setSize(size: SubtitleAppearance["fontSize"]): Promise<void> {
        await this.writeAppearance(editAppearance(this.appearance, "fontSize", size));
    }

    async setPosition(position: SubtitleAppearance["position"]): Promise<void> {
        await this.writeAppearance(editAppearance(this.appearance, "position", position));
    }

    async setAppearance(member: AppearanceMember, value: string | number | boolean): Promise<void> {
        await this.writeAppearance(editAppearance(this.appearance, member, value));
    }

    async setDeviceOverride(enabled: boolean): Promise<void> {
        if (!this.support.deviceScope || this.busy) return;
        if (enabled) {
            await this.commit(() => this.call(operations.put(APPEARANCE_KEY, appearanceJson(this.appearance, this.support.textOpacity), "profile_device")), () => { this.deviceOverride = true; });
            return;
        }
        await this.commit(async () => {
            await this.call(operations.delete(APPEARANCE_KEY, "profile_device"));
            if (this.support.syncAtProfile) await this.call(operations.delete(SYNC_KEY, "profile_device"));
            this.deviceOverride = false;
            try {
                const [appearance, delay] = await Promise.all([
                    this.support.styling ? this.call(subtitleOperations.subtitleAppearance(this.profileId)) : this.appearance,
                    this.support.delay ? this.call(subtitleOperations.subtitleSync()) : this.delayMs,
                ]);
                this.appearance = appearance;
                this.delayMs = delay;
            } catch (error) {
                this.support = { ...this.support, styling: false, delay: false, deviceScope: false };
                throw error;
            }
        }, () => { this.deviceOverride = false; }, this.support.syncAtProfile);
    }

    private async writeAppearance(next: SubtitleAppearance): Promise<void> {
        if (!this.support.styling) return;
        const scope = this.deviceOverride && this.support.deviceScope ? "profile_device" : "profile";
        await this.commit(() => this.call(operations.put(APPEARANCE_KEY, appearanceJson(next, this.support.textOpacity), scope)), () => { this.appearance = next; });
    }

    private async commit(send: () => Promise<void>, apply: () => void, touchesSync = false): Promise<void> {
        if (this.busy || this.abort.signal.aborted) return;
        this.busy = true;
        this.message = "";
        this.changed();
        if (touchesSync) this.beginUnsettledSync();
        try {
            await send();
            if (this.abort.signal.aborted) return;
            this.edited = true;
            apply();
            this.onChange(this.appearance, this.delayMs);
        } catch (error) {
            if (this.abort.signal.aborted || (error instanceof ApiError && error.aborted)) return;
            this.message = FAILED;
        } finally {
            if (touchesSync) await this.endUnsettledSync();
            this.busy = false;
            if (!this.abort.signal.aborted) this.changed();
        }
    }

    private call<T>(spec: RequestSpec<T>): Promise<T> {
        return this.session.call({ ...spec, profileScoped: true, replayAfterRefresh: spec.method === "GET", signal: this.abort.signal });
    }

    /**
     * Clear a subtitle offset an older build left on this device, once per settings scope.
     * Apple `clearLeftoverDeviceSubtitleOffsetIfNeeded` (PlayerSettings.swift:1268-1298 at
     * 2ef3a171): the marker is stored before the delete, a timing write still owed waits,
     * and a failed delete stays in the journal until a later flush sends it. A server that
     * no longer accepts the offset per profile drops that owed delete without sending it.
     */
    private finishLeftoverClear(): Promise<void> {
        if (this.clearing !== undefined) return this.clearing;
        const run = this.decideLeftoverClear();
        this.clearing = run.finally(() => { this.clearing = undefined; });
        return this.clearing;
    }

    private async decideLeftoverClear(): Promise<void> {
        const scope = this.currentScope();
        if (scope === undefined) return;
        if (this.read(markerKey(scope)) === "true") {
            this.decided = true;
            return;
        }
        // Revision 19 is the first that stores the offset on the profile. An unknown
        // revision, or one read for a different scope, does not decide.
        if (!this.support.delay || !this.support.syncAtProfile) return;
        // No pre-contract import runs here. Apple marks that migration complete before
        // this clear when nothing is owed, and waits while the marker is still false.
        if (this.read(migrationKey(scope)) === "false") return;
        if (this.syncUnsettled(scope)) return;
        let leftover = false;
        try {
            leftover = await this.call(operations.deviceTiming(this.profileId, this.session.http.deviceId));
        } catch (error) {
            if (this.stopped(error)) return;
            return;
        }
        const still = this.currentScope();
        if (still === undefined || still !== scope || this.abort.signal.aborted) return;
        if (this.read(migrationKey(scope)) === "false" || this.syncUnsettled(scope)) return;
        if (this.storage !== undefined && !this.write(markerKey(scope), "true")) return;
        this.decided = true;
        // The marker is already stored. An override, or no device row, is not cleared
        // again on a later open.
        if (this.deviceOverride || !leftover) return;
        await this.sendDelete(scope, true);
    }

    /** Replay a delete the journal still owes. Apple flushes this before the next read. */
    private async flushOwedDelete(support: SubtitleControlSupport = this.support): Promise<void> {
        const scope = this.currentScope();
        if (scope === undefined || this.read(markerKey(scope)) !== "true" || this.read(owedDeleteKey(scope)) !== "true") return;
        if (this.syncUnsettled(scope)) return;
        if (!support.syncAtProfile) {
            this.erase(owedDeleteKey(scope));
            return;
        }
        await this.sendDelete(scope, false);
    }

    private async sendDelete(scope: string, reread: boolean): Promise<void> {
        try {
            await this.call(operations.delete(SYNC_KEY, "profile_device"));
        } catch (error) {
            if (this.stopped(error)) return;
            if (this.storage !== undefined) this.write(owedDeleteKey(scope), "true");
            return;
        }
        this.erase(owedDeleteKey(scope));
        if (!reread) return;
        try {
            this.delayMs = await this.call(subtitleOperations.subtitleSync());
            this.onChange(this.appearance, this.delayMs);
        } catch (error) {
            if (this.stopped(error)) return;
        }
    }

    private currentScope(): string | undefined {
        const scope = subtitleSettingsScope(this.session, this.profileId);
        if (scope === undefined || this.revisionScope !== scope) return undefined;
        return scope;
    }

    private syncUnsettled(scope: string): boolean {
        return this.unsettledSync > 0 || this.read(unsettledSyncKey(scope)) === "true";
    }

    private beginUnsettledSync(): void {
        this.unsettledSync += 1;
        const scope = subtitleSettingsScope(this.session, this.profileId);
        if (scope !== undefined) this.write(unsettledSyncKey(scope), "true");
    }

    private async endUnsettledSync(): Promise<void> {
        this.unsettledSync = Math.max(0, this.unsettledSync - 1);
        if (this.unsettledSync > 0) return;
        const scope = subtitleSettingsScope(this.session, this.profileId);
        if (scope !== undefined) this.erase(unsettledSyncKey(scope));
        const pending = this.clearing;
        if (pending !== undefined) await pending;
        await this.flushOwedDelete();
        if (!this.decided && !this.abort.signal.aborted) await this.finishLeftoverClear();
    }

    private read(key: string): string | null {
        try { return this.storage?.getItem(key) ?? null; }
        catch { return null; }
    }

    private write(key: string, value: string): boolean {
        if (this.storage === undefined) return false;
        try {
            this.storage.setItem(key, value);
            return this.storage.getItem(key) === value;
        } catch { return false; }
    }

    private erase(key: string): void {
        try { this.storage?.removeItem(key); }
        catch { /* A key left behind is read again on the next open. */ }
    }

    private stopped(error: unknown): boolean {
        return this.abort.signal.aborted || (error instanceof ApiError && error.aborted);
    }
}

function markerKey(scope: string): string {
    return `${MARKER_PREFIX}${scope}`;
}

function owedDeleteKey(scope: string): string {
    return `${OWED_DELETE_PREFIX}${scope}.${SYNC_KEY}.delete`;
}

function unsettledSyncKey(scope: string): string {
    return `${OWED_DELETE_PREFIX}${scope}.${SYNC_KEY}`;
}

function migrationKey(scope: string): string {
    return `${MIGRATION_PREFIX}${scope}`;
}

function appearanceJson(appearance: SubtitleAppearance, includeTextOpacity: boolean): JsonValue {
    const value: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(appearanceValue(appearance, includeTextOpacity))) {
        if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") value[key] = item;
    }
    return value;
}
