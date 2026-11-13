import { operations } from "../api/operations.ts";
import type { ProfileCreateBody, ProfileSummary } from "../contracts/v2/wire.ts";
import type { ConnectedServer } from "./core.ts";
import type { PinResult } from "./profiles.ts";

interface ManagementContext {
    readonly profileId: string | undefined;
    readonly generation: number;
    readonly borrowed: boolean;
}

/** A picker visit borrows the existing profile owner without changing remembered launch. */
export class ProfileManagement {
    private readonly server: Pick<ConnectedServer, "session" | "profiles">;
    private readonly accountId: string | undefined;
    private context: ManagementContext | undefined;
    private primary: ProfileSummary | undefined;
    private pendingGeneration = 0;
    /** The PIN asked for renews the open primary's proof instead of borrowing it. */
    private renewing = false;
    private closed = false;

    constructor(server: Pick<ConnectedServer, "session" | "profiles">) {
        this.server = server;
        this.accountId = server.session.account?.id;
    }

    begin(profiles: readonly ProfileSummary[]): "ready" | "pin_required" | "primary_missing" | "ended" {
        const { session, profiles: owner } = this.server;
        if (this.closed || this.accountId === undefined || session.account?.id !== this.accountId) return "ended";
        if (profiles.length === 0) {
            this.context = { profileId: undefined, generation: session.authorityGeneration, borrowed: false };
            return "ready";
        }
        const primary = profiles.find(profile => profile.isPrimary);
        if (primary === undefined) return "primary_missing";
        this.primary = primary;
        const borrowed = session.activeProfile?.id !== primary.id;
        const generation = session.authorityGeneration;
        // AddProfileFromMenu (silo-apple 5780c84 `Screens/Profiles/AddProfileFromMenu.swift:46, 70-83`): the fresh list
        // decides. An open primary that now has a PIN may have been opened before it was set, so the PIN is asked for
        // again and the open profile stays open while its proof is renewed.
        if (!borrowed && primary.hasPin) {
            this.pendingGeneration = generation;
            this.renewing = true;
            return "pin_required";
        }
        const hadProfile = session.activeProfile !== undefined;
        const selected = !borrowed || owner.select(primary).status === "selected";
        if (session.account?.id !== this.accountId) return "ended";
        if (selected) {
            if (session.activeProfile?.id !== primary.id || session.authorityGeneration !== generation + (borrowed ? 1 : 0)) return "ended";
            this.context = { profileId: primary.id, generation: session.authorityGeneration, borrowed };
            if (this.closed) { this.release(); return "ended"; }
            return "ready";
        }
        if (this.closed || session.activeProfile !== undefined || session.authorityGeneration !== generation + (hadProfile ? 1 : 0)) return "ended";
        this.pendingGeneration = session.authorityGeneration;
        return "pin_required";
    }

    get primaryProfile(): ProfileSummary | undefined { return this.primary; }

    async verifyPin(pin: string, signal: AbortSignal): Promise<PinResult> {
        const primary = this.primary;
        const { session, profiles } = this.server;
        if (this.closed || primary === undefined || session.account?.id !== this.accountId || session.authorityGeneration !== this.pendingGeneration) return { status: "aborted" };
        const result = await profiles.verifyPin(primary.id, pin, signal);
        if (result.status !== "verified") return result;
        if (session.account?.id !== this.accountId || session.activeProfile?.id !== primary.id || session.authorityGeneration !== this.pendingGeneration + 1) return { status: "aborted" };
        this.context = { profileId: primary.id, generation: session.authorityGeneration, borrowed: !this.renewing };
        if (this.closed || signal.aborted) { this.release(); return { status: "aborted" }; }
        return result;
    }

    async create(body: ProfileCreateBody, signal: AbortSignal): Promise<ProfileSummary> {
        const context = this.context;
        if (this.closed || context === undefined || !this.owns(context)) throw new Error("Profile management context changed.");
        const profile = await this.server.session.call({ ...operations.createProfile(body), profileScoped: context.profileId !== undefined, signal });
        if (this.closed || !this.owns(context)) throw new Error("Profile management context changed.");
        return profile;
    }

    close(): void {
        this.closed = true;
        this.release();
    }

    private owns(context: ManagementContext): boolean {
        const { session } = this.server;
        return session.account?.id === this.accountId && session.authorityGeneration === context.generation && session.activeProfile?.id === context.profileId;
    }

    private release(): void {
        const context = this.context;
        if (context?.borrowed && this.owns(context)) this.server.profiles.clear();
        this.context = undefined;
    }
}
