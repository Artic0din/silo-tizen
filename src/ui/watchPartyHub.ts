// Apple's WatchPartySession for the Watch Party hub: the support probe, Start a party, Join party and
// the room the create or join answered with, and the lobby over HTTP only. The host stages a title,
// starts and stops playback, sets who chooses and who controls, and ends the party; each answer is the
// room as it now stands. Apple never polls and keeps the room current over the socket, which is not
// built, so a guest sees the room as it was when they joined.

import { ApiError } from "../api/errors.ts";
import { writeMayHaveApplied } from "./browseRoutes.ts";
import type { Card, Episode, Season } from "../contracts/v2/catalog.ts";
import type { CreatableSelectionMode, GuestControlPolicy, PickerEntry, Room, RoomAccess, RoomSelection, WatchTogetherCapabilities } from "../contracts/v2/watchTogether.ts";
import type { PlayRequest } from "./browseModel.ts";
import { type LobbyItem, type MediaChoice, lobbyItemFromDetail } from "./watchPartyChoice.ts";
import { supportsSynchronizedParty, uuidV4, type WatchPartyApi, watchPartyFailureText } from "./watchPartyApi.ts";

export { supportsSynchronizedParty, uuidV4, watchPartyApi, watchPartyFailureText, type WatchPartyApi } from "./watchPartyApi.ts";

const PLAYABLE_TYPES: readonly string[] = ["movie", "series", "episode"];

/** The pages of one open room. Back steps through them in order. */
export type LobbyPage =
    | { readonly kind: "lobby" }
    | { readonly kind: "options" }
    | { readonly kind: "end" }
    | { readonly kind: "invite" }
    | { readonly kind: "picker" }
    | { readonly kind: "choice"; readonly choice: MediaChoice; readonly from?: LobbyPage }
    /** Apple's episode picker: the series' season tabs over the chosen season's episodes. */
    | { readonly kind: "episodes"; readonly series: Card; readonly season: Season | undefined };

export interface PickerShelf { readonly id: string; readonly title: string; readonly entries: readonly PickerEntry[] }

export interface WatchPartyState {
    supported: boolean;
    /** Apple isCheckingSupport: the hub's own check is running. */
    checking: boolean;
    /** A create, join or room change is running. */
    busy: boolean;
    /** Apple errorMessage, shown in the warning banner. */
    error: string | undefined;
    /** The room the create or join answered with, as each change since has left it. */
    room: Room | undefined;
    /** What the server said it can do; read with the support check. */
    capabilities: WatchTogetherCapabilities | undefined;
    page: LobbyPage;
    /** The room's chosen title, from the host's pick until the catalog answers, then from the catalog. */
    selected: LobbyItem | undefined;
    /** The catalog refused the chosen title for this profile (Apple selectedItemUnavailable). */
    selectedUnavailable: boolean;
    shelves: readonly PickerShelf[];
    shelvesLoading: boolean;
    shelvesError: string | undefined;
    /** The seasons or episodes of the series being browsed. */
    seasons: readonly Season[] | undefined;
    episodes: readonly Episode[] | undefined;
    browseLoading: boolean;
    browseError: string | undefined;
}

export interface WatchPartyHubOptions {
    /** The answer the entry point was offered on. */
    readonly supported?: boolean;
    readonly onSupport?: (supported: boolean) => void;
    /** Back from the lobby: the entry opens afresh on its first control, not where focus moved while a request ran. */
    readonly onLeave?: () => void;
    /** The host started the party, or Return to playback: open the player on the room's file. There is no sync yet. */
    readonly onPlay?: (request: PlayRequest) => void;
    readonly describe?: (error: unknown) => string;
    readonly uuid?: () => string;
}

export const UNSUPPORTED_SERVER = "This server needs an update to support synchronized Watch Party playback safely on this profile.";
export const PARTY_ENDED = "This party has ended.";

const LOBBY: LobbyPage = { kind: "lobby" };

const isConflict = (error: unknown): boolean => error instanceof ApiError && error.failure.kind === "problem" && error.failure.problem.status === 409;
/** Apple isAccessRefusal: the profile cannot see the title at all. */
const isRefusal = (error: unknown): boolean => error instanceof ApiError && error.failure.kind === "problem" && (error.failure.problem.status === 403 || error.failure.problem.status === 404);

export class WatchPartyHub {
    readonly state: WatchPartyState;
    private readonly api: WatchPartyApi;
    private readonly notify: () => void;
    private readonly options: WatchPartyHubOptions;
    private readonly describe: (error: unknown) => string;
    private readonly controller = new AbortController();
    private stopped = false;
    /** The room's membership proof from the last answer; the picker sends it. Never logged or stored. */
    private roomToken = "";
    /** Counts rooms and picker reads, so a late answer for an older one is dropped. */
    private epoch = 0;
    /** Counts season and episode reads; leaving the page ends them. The picker's read is not tied to its page, so backing out does not strand it. */
    private browseEpoch = 0;
    /** A hosted room that Back or leaving the page has not yet ended on the server. */
    private unclosed: Room | undefined;
    private closing: Promise<boolean> | undefined;
    private refocus = false;

    constructor(api: WatchPartyApi, notify: () => void, options: WatchPartyHubOptions = {}) {
        this.api = api;
        this.notify = notify;
        this.options = options;
        this.describe = options.describe ?? watchPartyFailureText;
        this.state = {
            supported: options.supported ?? false, checking: false, busy: false, error: undefined, room: undefined, capabilities: undefined,
            page: LOBBY, selected: undefined, selectedUnavailable: false, shelves: [], shelvesLoading: false, shelvesError: undefined,
            seasons: undefined, episodes: undefined, browseLoading: false, browseError: undefined,
        };
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

    // --- Lobby state ---

    /** WatchPartySession.canStartPlayback for a host-pick room: staged selection is a requirement of Start, as on Apple. */
    canStart(): boolean {
        const { room, capabilities } = this.state;
        return room?.selfCanManageRoom === true && room.phase === "lobby" && room.selectionMode === "host_pick"
            && capabilities?.stagedSelection === true && room.selectedContentId !== undefined;
    }

    /** Whether the next render should drop the focus it carries: shelves that arrive claim focus for the first title, as Apple's picker does. */
    takeRefocus(): boolean {
        const refocus = this.refocus;
        this.refocus = false;
        return refocus;
    }

    show(page: LobbyPage): void {
        // Leaving a page ends its season and episode reads: a late answer must not undo the move.
        this.browseEpoch++;
        this.state.browseLoading = false;
        this.state.page = page;
        this.notify();
    }

    /** Back inside an open room: one page at a time, and out of the room from the lobby. */
    back(): void {
        const page = this.state.page;
        switch (page.kind) {
            case "lobby": this.leave(); return;
            case "choice": this.show(page.from ?? { kind: "picker" }); return;
            case "episodes": this.show({ kind: "picker" }); return;
            default: this.show(LOBBY);
        }
    }

    /** Apple's WatchPartySession.select: the staged call in a host-pick lobby, the live selection otherwise. */
    async stage(choice: MediaChoice): Promise<boolean> {
        const { room, capabilities } = this.state;
        if (room?.selectionMode !== "host_pick") return false;
        const selection: RoomSelection = { contentId: choice.contentId };
        const staged = room.phase === "lobby" && capabilities?.stagedSelection === true;
        const before = this.state.selected;
        const picked = this.mutate(
            signal => staged ? this.api.stageSelection(room.roomId, selection, signal) : this.api.selectItem(room.roomId, selection, signal),
            () => { this.state.selected = choice.lobby; this.state.selectedUnavailable = false; },
            // A live selection whose answer is lost has taken effect when the room now holds the title.
            staged ? undefined : room => room.selectedContentId === choice.contentId,
        );
        const done = await picked;
        if (!done && !this.stopped && this.state.selected?.contentId === choice.contentId) this.state.selected = before;
        if (done) {
            this.show(LOBBY);
            // Choosing for a party that is already playing starts it for everyone, as the button says.
            if (!staged) this.resume();
        }
        return done;
    }

    /** Start for everyone. Opens the player on the room's file when the server says the party is playing. */
    async start(): Promise<boolean> {
        if (!this.canStart()) return false;
        const started = await this.mutate(signal => this.api.startPlayback(this.requireRoom().roomId, signal), undefined, room => room.phase === "playing");
        if (started) this.resume();
        return started;
    }

    /** Return to playback: the player opens on the room's file, from the room's anchor. */
    resume(): void {
        const room = this.state.room;
        if (room?.phase !== "playing" || room.selectedContentId === undefined || room.selectedFileId === undefined) return;
        this.options.onPlay?.({ contentId: room.selectedContentId, fileId: room.selectedFileId, title: this.state.selected?.title ?? "Watch Party", startSeconds: room.anchorPositionSeconds, allowAlternateVersions: false });
    }

    async stopPlayback(): Promise<boolean> {
        if (this.state.capabilities?.stopPlayback !== true || this.state.room?.phase !== "playing") return false;
        return this.mutate(signal => this.api.stopPlayback(this.requireRoom().roomId, signal));
    }

    async setMode(mode: CreatableSelectionMode): Promise<boolean> {
        if (this.state.capabilities?.selectionModeSwitch !== true || this.state.room?.phase !== "lobby") return false;
        return this.mutate(signal => this.api.setSelectionMode(this.requireRoom().roomId, mode, signal));
    }

    async setPolicy(policy: Exclude<GuestControlPolicy, "unknown">): Promise<boolean> {
        return this.mutate(signal => this.api.setGuestControlPolicy(this.requireRoom().roomId, policy, signal));
    }

    /** WatchPartySession.endParty: closes the room for everyone, then leaves it with Apple's "This party has ended.". */
    async endParty(): Promise<void> {
        const room = this.state.room;
        if (room?.selfCanManageRoom !== true || this.state.busy || this.stopped) return;
        this.state.busy = true;
        this.state.error = undefined;
        this.notify();
        try {
            await this.api.closeRoom(room.roomId, this.controller.signal).catch((error: unknown) => { if (!isConflict(error)) throw error; });
            if (this.stopped || this.state.room?.roomId !== room.roomId) return;
            this.state.busy = false;
            this.reset();
            this.state.error = PARTY_ENDED;
            this.options.onLeave?.();
        } catch (error) {
            if (!this.stopped) this.state.error = this.describe(error);
        } finally {
            if (!this.stopped) { this.state.busy = false; this.notify(); }
        }
    }

    /** The host's picker: group picks and watchlists, from the server's picker when it has one. */
    async openPicker(): Promise<void> {
        const epoch = ++this.epoch;
        this.state.page = { kind: "picker" };
        this.state.shelvesLoading = true;
        this.state.shelvesError = undefined;
        this.notify();
        try {
            const shelves = await this.loadShelves();
            if (this.stale(epoch)) return;
            this.state.shelves = shelves;
        } catch (error) {
            if (this.stale(epoch)) return;
            this.state.shelvesError = this.describe(error);
        }
        if (this.stale(epoch)) return;
        this.state.shelvesLoading = false;
        this.refocus = this.state.shelves.length > 0;
        this.notify();
    }

    /** The series' seasons with one season's episodes: the one asked for, else the first that is not specials. */
    async openEpisodes(series: Card, wanted?: Season): Promise<void> {
        const epoch = ++this.browseEpoch;
        const sameSeries = this.state.page.kind === "episodes" && this.state.page.series.id === series.id;
        Object.assign(this.state, { page: { kind: "episodes", series, season: wanted }, episodes: undefined, browseLoading: true, browseError: undefined, ...(sameSeries ? {} : { seasons: undefined }) });
        this.notify();
        await this.browse(epoch, async signal => {
            const seasons = this.state.seasons ?? await this.api.seasons(series.id, signal);
            if (this.staleBrowse(epoch)) return;
            this.state.seasons = seasons;
            const season = wanted ?? seasons.find(candidate => candidate.isSpecials !== true) ?? seasons[0];
            if (season === undefined) return;
            this.state.page = { kind: "episodes", series, season };
            const episodes = await this.api.episodes(series.id, season.seasonNumber, signal);
            if (this.staleBrowse(epoch)) return;
            this.state.episodes = episodes;
        });
    }

    /** Back from the lobby, or Leave party. A guest has no HTTP leave; the host ends the room, as Apple's endParty does. */
    leave(): void {
        const room = this.state.room;
        this.reset();
        this.state.error = undefined;
        this.options.onLeave?.();
        this.notify();
        this.end(room);
    }

    stop(): void {
        this.stopped = true;
        this.controller.abort();
        const room = this.state.room;
        this.reset();
        this.end(room);
    }

    private requireRoom(): Room {
        if (this.state.room === undefined) throw new Error("No open room");
        return this.state.room;
    }

    private stale(epoch: number): boolean { return this.stopped || epoch !== this.epoch; }

    private staleBrowse(epoch: number): boolean { return this.stopped || epoch !== this.browseEpoch; }

    private reset(): void {
        this.epoch++;
        this.browseEpoch++;
        this.roomToken = "";
        Object.assign(this.state, {
            room: undefined, page: LOBBY, selected: undefined, selectedUnavailable: false, shelves: [], shelvesLoading: false, shelvesError: undefined,
            seasons: undefined, episodes: undefined, browseLoading: false, browseError: undefined,
        });
    }

    /** Takes the room an answer carries. A new selection reloads the title; the pick the host just made shows until it lands. */
    private accept(answer: RoomAccess): void {
        const previous = this.state.room;
        this.roomToken = answer.roomAccessToken;
        this.state.room = answer.room;
        const id = answer.room.selectedContentId;
        if (id === previous?.selectedContentId && (id === undefined || this.state.selected !== undefined)) return;
        this.state.selectedUnavailable = false;
        if (id === undefined) { this.state.selected = undefined; return; }
        if (this.state.selected?.contentId !== id) this.state.selected = undefined;
        void this.refreshSelected(answer.room.roomId, id);
    }

    private async refreshSelected(roomId: string, contentId: string): Promise<void> {
        try {
            const item = lobbyItemFromDetail(await this.api.item(contentId, this.controller.signal));
            if (this.stopped || this.state.room?.roomId !== roomId || this.state.room.selectedContentId !== contentId) return;
            this.state.selected = item;
        } catch (error) {
            // The title's details are optional, but a refusal means this profile cannot see it and playback will be refused too.
            if (this.stopped || this.state.room?.roomId !== roomId || this.state.room.selectedContentId !== contentId || !isRefusal(error)) return;
            this.state.selectedUnavailable = true;
            this.state.selected = undefined;
        }
        this.notify();
    }

    /**
     * One host change at a time, as Apple's `mutate`: a second call while one runs is ignored, so the controls stay enabled
     * and focus is not thrown out. The answer replaces the room; a refusal shows the server's reason and keeps the room.
     */
    private async mutate(operation: (signal: AbortSignal) => Promise<RoomAccess>, begin?: () => void, applied?: (room: Room) => boolean): Promise<boolean> {
        const room = this.state.room;
        if (room?.selfCanManageRoom !== true || this.state.busy || this.stopped) return false;
        this.state.busy = true;
        this.state.error = undefined;
        begin?.();
        this.notify();
        try {
            const answer = await operation(this.controller.signal);
            if (this.stopped || this.state.room?.roomId !== room.roomId) return false;
            this.accept(answer);
            return true;
        } catch (error) {
            if (!this.stopped) this.state.error = this.describe(error);
            // A non-retryable change whose answer never came may have landed: read the room so the lobby does not stay behind it,
            // and count the change as done when the room proves it, so it is not sent a second time.
            if (applied !== undefined && !this.stopped && writeMayHaveApplied(error)) {
                const now = await this.readRoom(room.roomId);
                if (now !== undefined && applied(now)) { this.state.error = undefined; return true; }
            }
            return false;
        } finally {
            if (!this.stopped) { this.state.busy = false; this.notify(); }
        }
    }

    private async readRoom(roomId: string): Promise<Room | undefined> {
        try {
            const answer = await this.api.room(roomId, this.roomToken, this.controller.signal);
            if (this.stopped || this.state.room?.roomId !== roomId) return undefined;
            this.accept(answer);
            return answer.room;
        } catch {
            // The error from the change is already showing; the room stays as it was.
            return undefined;
        }
    }

    private async loadShelves(): Promise<PickerShelf[]> {
        const room = this.requireRoom();
        const playable = (entry: PickerEntry): boolean => PLAYABLE_TYPES.includes(entry.card.type);
        const shelf = (id: string, title: string, entries: readonly PickerEntry[]): PickerShelf[] => {
            const shown = entries.filter(playable);
            return shown.length === 0 ? [] : [{ id, title, entries: shown }];
        };
        if (this.state.capabilities?.picker === true) {
            const picker = await this.api.picker(room.roomId, this.roomToken, this.controller.signal);
            return [...shelf("together", "Continue Together", picker.continueTogether), ...shelf("watchlist", "On Your Watchlists", picker.watchlistUnion)];
        }
        const page = await this.api.watchlist(this.controller.signal);
        return shelf("watchlist", "On Your Watchlists", page.items.map(card => ({ card, members: [], nextUp: undefined })));
    }

    private async browse(epoch: number, load: (signal: AbortSignal) => Promise<void>): Promise<void> {
        try {
            await load(this.controller.signal);
        } catch (error) {
            if (this.staleBrowse(epoch)) return;
            this.state.browseError = this.describe(error);
        }
        if (this.staleBrowse(epoch)) return;
        this.state.browseLoading = false;
        this.notify();
    }

    private end(room: Room | undefined): void {
        if (room === undefined || !room.selfCanManageRoom) return;
        this.unclosed = room;
        void this.closeUnclosed();
    }

    /**
     * Ends the hosted room that was left open. A create or join waits for it, as Apple refuses a new party while one is open,
     * and retries it when it failed. A signal of its own lets the close finish after the hub stops, when a failure has no screen to show on.
     */
    private closeUnclosed(): Promise<boolean> {
        const room = this.unclosed;
        if (room === undefined) return Promise.resolve(true);
        this.closing ??= this.api.closeRoom(room.roomId, new AbortController().signal).then(
            () => true,
            (error: unknown) => {
                // 409 means the room already ended.
                if (isConflict(error)) return true;
                if (!this.stopped) { this.state.error = `Could not end the party. ${this.describe(error)}`; this.notify(); }
                return false;
            },
        ).then(ended => {
            if (ended) this.unclosed = undefined;
            this.closing = undefined;
            return ended;
        });
        return this.closing;
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
            this.state.capabilities = room;
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
            if (!await this.closeUnclosed()) return;
            if (!await this.load()) return;
            if (!this.state.supported) { this.state.error = UNSUPPORTED_SERVER; return; }
            try {
                const entered = await operation(this.controller.signal);
                if (!this.stopped) { this.reset(); this.accept(entered); }
            } catch (error) {
                if (!this.stopped) this.state.error = this.describe(error);
            }
        } finally {
            if (!this.stopped) { this.state.busy = false; this.notify(); }
        }
    }
}
