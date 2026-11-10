// Apple's WatchPartySession for the Watch Party hub: the support probe, Start a party, Join party and
// the room the create or join answered with, behind the placeholder lobby. No socket, member state or playback yet.

import { ApiError } from "../api/errors.ts";
import { operations } from "../api/operations.ts";
import type { RequestSpec } from "../api/http.ts";
import { watchTogetherOperations } from "../api/watchTogetherOperations.ts";
import type { PlaybackCapabilities } from "../contracts/v2/playback.ts";
import { type CreatableSelectionMode, type Room, type RoomAccess, type WatchTogetherCapabilities, watchTogetherSocketSupported } from "../contracts/v2/watchTogether.ts";
import type { NativeSession } from "../session/session.ts";
import { errorState } from "./browseRoutes.ts";

/** The playback features Apple requires of a server before it offers a synchronized party. */
const PLAYBACK_FEATURES = ["watch_party_coordinator_v1", "fixed_media_file_v1"] as const;

/** WatchPartySession.supportsSynchronizedParty: the room gate and socket, plus coordinated fixed-file playback. */
export function supportsSynchronizedParty(room: WatchTogetherCapabilities, playback: PlaybackCapabilities): boolean {
    return watchTogetherSocketSupported(room) && playback.state === "available" && playback.allowed
        && PLAYBACK_FEATURES.every(feature => playback.features.includes(feature));
}

export interface WatchPartyApi {
    capabilities(signal: AbortSignal): Promise<WatchTogetherCapabilities>;
    playbackCapabilities(signal: AbortSignal): Promise<PlaybackCapabilities>;
    createRoom(roomId: string, mode: CreatableSelectionMode, signal: AbortSignal): Promise<RoomAccess>;
    joinByCode(code: string, signal: AbortSignal): Promise<RoomAccess>;
    closeRoom(roomId: string, signal: AbortSignal): Promise<void>;
}

export function watchPartyApi(session: Pick<NativeSession, "call">): WatchPartyApi {
    const call = <T>(spec: RequestSpec<T>, signal: AbortSignal): Promise<T> => session.call({ ...spec, profileScoped: true, signal });
    return {
        capabilities: signal => call(watchTogetherOperations.capabilities(), signal),
        playbackCapabilities: signal => call(operations.playbackCapabilities(), signal),
        createRoom: (roomId, mode, signal) => call(watchTogetherOperations.createRoom(roomId, mode), signal),
        joinByCode: (code, signal) => call(watchTogetherOperations.joinByCode(code), signal),
        closeRoom: (roomId, signal) => call(watchTogetherOperations.closeRoom(roomId), signal),
    };
}

/** Apple shows the server's own text for a refused create or join (APIv2Error.problem: detail, else title), where the shared wording hides it for 403 and 404. */
export function watchPartyFailureText(error: unknown): string {
    if (error instanceof ApiError && error.failure.kind === "problem" && (error.failure.problem.status === 403 || error.failure.problem.status === 404)) {
        const { detail, title } = error.failure.problem;
        const text = detail?.trim() || title.trim();
        if (text !== "") return text;
    }
    return errorState(error).message;
}

/** A random version 4 UUID, lower case, as Apple sends for a new room. */
export function uuidV4(fill: (bytes: Uint8Array<ArrayBuffer>) => void = bytes => { crypto.getRandomValues(bytes); }): string {
    const bytes = new Uint8Array(16);
    fill(bytes);
    bytes[6] = (bytes[6] ?? 0) & 0x0f | 0x40;
    bytes[8] = (bytes[8] ?? 0) & 0x3f | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface WatchPartyState {
    supported: boolean;
    /** Apple isCheckingSupport: the hub's own check is running. */
    checking: boolean;
    /** A create or join is running. */
    busy: boolean;
    /** Apple errorMessage, shown in the warning banner. */
    error: string | undefined;
    /** The placeholder lobby: the room the create or join answered with. */
    room: Room | undefined;
}

export interface WatchPartyHubOptions {
    /** The answer the entry point was offered on. */
    readonly supported?: boolean;
    readonly onSupport?: (supported: boolean) => void;
    /** Back from the lobby: the entry opens afresh on its first control, not where focus moved while a request ran. */
    readonly onLeave?: () => void;
    readonly describe?: (error: unknown) => string;
    readonly uuid?: () => string;
}

export const UNSUPPORTED_SERVER = "This server needs an update to support synchronized Watch Party playback safely on this profile.";

export class WatchPartyHub {
    readonly state: WatchPartyState;
    private readonly api: WatchPartyApi;
    private readonly notify: () => void;
    private readonly options: WatchPartyHubOptions;
    private readonly describe: (error: unknown) => string;
    private readonly controller = new AbortController();
    private stopped = false;

    constructor(api: WatchPartyApi, notify: () => void, options: WatchPartyHubOptions = {}) {
        this.api = api;
        this.notify = notify;
        this.options = options;
        this.describe = options.describe ?? watchPartyFailureText;
        this.state = { supported: options.supported ?? false, checking: false, busy: false, error: undefined, room: undefined };
    }

    /** WatchPartySession.refreshCapabilities. A failed read keeps the last answer and says why. */
    async check(): Promise<void> {
        if (this.state.checking || this.stopped) return;
        this.state.checking = true;
        this.notify();
        await this.load();
        if (this.stopped) return;
        this.state.checking = false;
        this.notify();
    }

    async create(mode: CreatableSelectionMode): Promise<void> {
        await this.enter(signal => this.api.createRoom(this.options.uuid?.() ?? uuidV4(), mode, signal));
    }

    async join(invitation: string): Promise<void> {
        const value = invitation.trim();
        if (value === "") { this.fail("Enter a party code or invitation link."); return; }
        // The native contract joins by code only; invitation links come with the lobby work.
        if (value.includes("://")) { this.fail("This Watch Party invitation is invalid."); return; }
        await this.enter(signal => this.api.joinByCode(value, signal));
    }

    /** Back from the placeholder lobby. A guest has no HTTP leave; the host ends the room, as Apple's endParty does. */
    leave(): void {
        const room = this.state.room;
        this.state.room = undefined;
        this.state.error = undefined;
        this.options.onLeave?.();
        this.notify();
        if (room !== undefined) this.closeIfHost(room);
    }

    stop(): void {
        this.stopped = true;
        this.controller.abort();
        const room = this.state.room;
        this.state.room = undefined;
        if (room !== undefined) this.closeIfHost(room);
    }

    /** A signal of its own lets the close finish after the hub stops; a failure then has no screen to show on. 409 means the room already ended. */
    private closeIfHost(room: Room): void {
        if (!room.selfCanManageRoom) return;
        this.api.closeRoom(room.roomId, new AbortController().signal).catch((error: unknown) => {
            if (this.stopped || (error instanceof ApiError && error.failure.kind === "problem" && error.failure.problem.status === 409)) return;
            this.state.error = `Could not end the party. ${this.describe(error)}`;
            this.notify();
        });
    }

    private fail(message: string): void {
        this.state.error = message;
        this.notify();
    }

    /** WatchPartySession.loadCapabilities. */
    private async load(): Promise<boolean> {
        try {
            const [room, playback] = await Promise.all([this.api.capabilities(this.controller.signal), this.api.playbackCapabilities(this.controller.signal)]);
            if (this.stopped) return false;
            this.state.supported = supportsSynchronizedParty(room, playback);
            this.state.error = undefined;
            this.options.onSupport?.(this.state.supported);
            return true;
        } catch (error) {
            if (this.stopped) return false;
            this.state.error = `Could not check Watch Party support. ${this.describe(error)}`;
            return false;
        }
    }

    /** WatchPartySession.enter: support is read again before every create or join. */
    private async enter(operation: (signal: AbortSignal) => Promise<RoomAccess>): Promise<void> {
        if (this.state.busy || this.stopped) return;
        this.state.busy = true;
        this.state.error = undefined;
        this.notify();
        try {
            if (!await this.load()) return;
            if (!this.state.supported) { this.state.error = UNSUPPORTED_SERVER; return; }
            try {
                const entered = await operation(this.controller.signal);
                if (!this.stopped) this.state.room = entered.room;
            } catch (error) {
                if (!this.stopped) this.state.error = this.describe(error);
            }
        } finally {
            if (!this.stopped) { this.state.busy = false; this.notify(); }
        }
    }
}
