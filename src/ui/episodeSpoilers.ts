// Profile spoiler switches from Apple TV (silo-apple ffa6e518):
// EpisodeSpoilers.swift hides an episode still and its description until playback starts.
// EpisodeSpoilerPreferences.swift syncs both keys at profile scope once the server
// serves settings manifest revision 17. Series and season artwork and text stay.

import { ApiError } from "../api/errors.ts";
import type { RequestSpec } from "../api/http.ts";
import { settingsOperations } from "../api/settingsOperations.ts";
import type { Card, Episode, ItemDetail } from "../contracts/v2/catalog.ts";
import { SPOILER_IMAGE_KEY, SPOILER_OVERVIEW_KEY, type SettingsCapabilities } from "../contracts/v2/settings.ts";
import type { PublicStorage } from "../session/deviceIdentity.ts";
import type { NativeSession } from "../session/session.ts";
import { readSettingsCapability } from "./presentationSettings.ts";

/** Settings manifest revision that introduced both spoiler keys (SettingKeyRevisions.swift). */
export const SPOILER_INTRODUCED_IN = 17;
/** EpisodeSpoilerBlur.radius. The image grows by this many pixels on every side so the fringe clips. */
export const EPISODE_SPOILER_BLUR_PX = 24;

export interface EpisodeSpoilerSettings {
    readonly hidesImages: boolean;
    readonly hidesOverviews: boolean;
}

export interface EpisodeWatchState {
    readonly played: boolean;
    readonly isInProgress?: boolean;
    readonly positionSeconds?: number;
}

const OFF: EpisodeSpoilerSettings = { hidesImages: false, hidesOverviews: false };

export function isEpisodeUnwatched(state: EpisodeWatchState | undefined): boolean {
    if (state === undefined) return true;
    if (state.played) return false;
    if (state.isInProgress === true) return false;
    return (state.positionSeconds ?? 0) <= 0;
}

export function hidesEpisodeImage(settings: EpisodeSpoilerSettings, state: EpisodeWatchState | undefined, isEpisodeStill: boolean | undefined): boolean {
    return settings.hidesImages && isEpisodeUnwatched(state) && isEpisodeStill !== false;
}

export function hidesEpisodeOverview(settings: EpisodeSpoilerSettings, state: EpisodeWatchState | undefined): boolean {
    return settings.hidesOverviews && isEpisodeUnwatched(state);
}

function cardWatch(card: Pick<Card, "played" | "positionSeconds">): EpisodeWatchState {
    return card.positionSeconds === undefined ? { played: card.played === true } : { played: card.played === true, positionSeconds: card.positionSeconds };
}

/** The URL a card actually shows: the continue-watching backdrop, otherwise the poster. */
export function hidesCardImage(card: Pick<Card, "type" | "played" | "positionSeconds" | "posterUrl" | "backdropUrl" | "posterIsEpisodeStill" | "backdropIsEpisodeStill">, settings: EpisodeSpoilerSettings, continuing: boolean): boolean {
    if (card.type !== "episode") return false;
    const usesBackdrop = continuing && card.backdropUrl !== undefined && card.backdropUrl !== "";
    const reference = usesBackdrop ? card.backdropUrl : card.posterUrl;
    if (reference === undefined || reference === "") return false;
    return hidesEpisodeImage(settings, cardWatch(card), usesBackdrop ? card.backdropIsEpisodeStill : card.posterIsEpisodeStill);
}

export function hidesCardOverview(card: Pick<Card, "type" | "played" | "positionSeconds">, settings: EpisodeSpoilerSettings): boolean {
    return card.type === "episode" && hidesEpisodeOverview(settings, cardWatch(card));
}

/** A series backdrop is never an episode still. The settings argument is unused; the marquee asks anyway. */
export function marqueeUsesSeriesArt(card: Pick<Card, "type" | "seriesBackdropUrl" | "backdropIsEpisodeStill">, _settings: EpisodeSpoilerSettings): boolean {
    return card.type === "episode" && card.seriesBackdropUrl !== undefined && card.seriesBackdropUrl !== "";
}

export function hidesMarqueeBackdrop(card: Pick<Card, "type" | "played" | "positionSeconds" | "seriesBackdropUrl" | "backdropIsEpisodeStill">, settings: EpisodeSpoilerSettings): boolean {
    if (card.type !== "episode" || marqueeUsesSeriesArt(card, settings)) return false;
    return hidesEpisodeImage(settings, cardWatch(card), card.backdropIsEpisodeStill);
}

function episodeWatch(episode: Pick<Episode, "played" | "isInProgress" | "positionSeconds">): EpisodeWatchState {
    return {
        played: episode.played,
        ...(episode.isInProgress === undefined ? {} : { isInProgress: episode.isInProgress }),
        ...(episode.positionSeconds === undefined ? {} : { positionSeconds: episode.positionSeconds }),
    };
}

export function hidesEpisodeListStill(episode: Pick<Episode, "played" | "isInProgress" | "positionSeconds" | "stillIsEpisodeStill">, settings: EpisodeSpoilerSettings): boolean {
    return hidesEpisodeImage(settings, episodeWatch(episode), episode.stillIsEpisodeStill);
}

export function episodeDetailPresentation(
    detail: Pick<ItemDetail, "type" | "overview"> & {
        readonly played?: boolean | undefined;
        readonly watch?: { readonly played: boolean; readonly isInProgress?: boolean | undefined; readonly positionSeconds?: number | undefined; readonly lastFileId?: string | undefined } | undefined;
        readonly backdropUrl?: string | undefined;
        readonly posterUrl?: string | undefined;
        readonly backdropIsEpisodeStill?: boolean | undefined;
        readonly posterIsEpisodeStill?: boolean | undefined;
    },
    settings: EpisodeSpoilerSettings,
    playedOverride?: boolean,
): { overview: string | undefined; hideBackdrop: boolean } {
    if (detail.type !== "episode") return { overview: detail.overview, hideBackdrop: false };
    const watch = detail.watch;
    const state: EpisodeWatchState = {
        played: playedOverride ?? watch?.played ?? detail.played ?? false,
        ...(watch?.isInProgress === undefined ? {} : { isInProgress: watch.isInProgress }),
        ...(watch?.positionSeconds === undefined ? {} : { positionSeconds: watch.positionSeconds }),
    };
    const usesBackdrop = detail.backdropUrl !== undefined && detail.backdropUrl !== "";
    return {
        overview: hidesEpisodeOverview(settings, state) ? undefined : detail.overview,
        hideBackdrop: hidesEpisodeImage(settings, state, usesBackdrop ? detail.backdropIsEpisodeStill : detail.posterIsEpisodeStill),
    };
}

export function spoilerSettingsSupported(capability: SettingsCapabilities | undefined): boolean {
    if (capability === undefined) return false;
    return capability.apiVersion === 1
        && capability.state === "available"
        && capability.allowed
        && capability.scopes.includes("profile")
        && capability.supportsBatchedEffective
        && capability.manifestRevision >= SPOILER_INTRODUCED_IN;
}

/** Blurs the still and leaves badges and progress sharp. No-ops when the box is only a title placeholder. */
export function blurEpisodeStill(box: HTMLElement): void {
    if (box.querySelector(".browse-art-image, .skyline-backdrop, .player-next-still") === null) return;
    box.classList.add("episode-spoiler-blur");
}

type SpoilerSetting = "images" | "overviews";
type Sync = "checking" | "supported" | "unsupported" | "unavailable";

function writeFailure(setting: SpoilerSetting, error: unknown): string {
    const name = setting === "images" ? "image setting" : "description setting";
    if (error instanceof ApiError && (error.failure.kind === "network" || error.failure.kind === "timeout")) return `Couldn't save the ${name}. Check the connection and try again.`;
    if (error instanceof ApiError && (error.status === 404 || error.status === 501 || error.problemId === "unknown_setting" || error.problemId === "server_upgrade_required")) return `This server can't save the ${name}.`;
    return `The server didn't save the ${name}. Try again.`;
}

/** Last confirmed values for this server, account and profile. The server URL is not part of the key. */
export class EpisodeSpoilerPreferences {
    private readonly session: NativeSession;
    private readonly storage: PublicStorage | undefined;
    private readonly listeners = new Set<() => void>();
    private readonly onVisible: () => void;
    private controller = new AbortController();
    private shown: EpisodeSpoilerSettings = OFF;
    private confirmed: EpisodeSpoilerSettings | undefined;
    private sync: Sync = "checking";
    private readError: string | undefined;
    private writeErrors: { images?: string; overviews?: string } = {};
    private published = "";
    private refreshSequence = 0;
    private writeRevision = 0;
    private writeChain: Promise<void> = Promise.resolve();
    private readonly generation: Record<SpoilerSetting, number> = { images: 0, overviews: 0 };
    private readonly pending: Record<SpoilerSetting, number> = { images: 0, overviews: 0 };

    constructor(session: NativeSession, storage: PublicStorage | undefined) {
        this.session = session;
        this.storage = storage;
        this.onVisible = () => {
            if (typeof document === "undefined" || document.hidden || this.controller.signal.aborted) return;
            void this.refresh();
        };
        this.loadCache();
        if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisible);
    }

    get settings(): EpisodeSpoilerSettings { return this.shown; }
    get showsSettings(): boolean { return this.sync === "supported" || this.confirmed !== undefined; }
    get allowsEditing(): boolean { return this.sync === "supported" && this.confirmed !== undefined; }

    get footer(): string {
        const parts = [
            "Blur an episode's thumbnail until you start watching it, so the image does not give away the story.",
            "Hide an episode's description until you start watching it.",
            "Applies to episodes you have not started, on every device that uses this profile.",
        ];
        const status = this.statusMessage;
        if (status !== undefined) parts.push(status);
        if (this.writeErrors.images !== undefined) parts.push(this.writeErrors.images);
        if (this.writeErrors.overviews !== undefined) parts.push(this.writeErrors.overviews);
        return parts.join(" ");
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    start(): void { void this.refresh(); }

    stop(): void {
        this.controller.abort();
        if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisible);
        this.listeners.clear();
    }

    toggle(setting: SpoilerSetting): void {
        switch (setting) {
            case "images":
                this.write("images", !this.shown.hidesImages);
                return;
            case "overviews":
                this.write("overviews", !this.shown.hidesOverviews);
                return;
            default: {
                const unexpected: never = setting;
                throw new Error(`Unknown spoiler setting ${String(unexpected)}`);
            }
        }
    }

    private get statusMessage(): string | undefined {
        if (this.readError !== undefined) return this.readError;
        if (this.sync === "checking") return "Checking whether this server supports spoiler settings…";
        if (this.sync === "unavailable") return "Spoiler settings can be changed once this server is reachable.";
        return undefined;
    }

    private async refresh(): Promise<void> {
        if (this.controller.signal.aborted) return;
        const sequence = ++this.refreshSequence;
        const writeRevision = this.writeRevision;
        const current = (): boolean => !this.controller.signal.aborted && sequence === this.refreshSequence && writeRevision === this.writeRevision;
        if (this.sync !== "supported") {
            this.sync = "checking";
            this.publish();
        }
        try {
            const found = await readSettingsCapability(spec => this.call(spec));
            if (!current()) return;
            if (!spoilerSettingsSupported(found)) {
                this.sync = "unsupported";
                this.readError = undefined;
                this.clearConfirmed();
                this.publish();
                return;
            }
            this.sync = "supported";
            const effective = await this.call(settingsOperations.effectiveSettings([SPOILER_IMAGE_KEY, SPOILER_OVERVIEW_KEY]));
            if (!current()) return;
            if (this.pending.images + this.pending.overviews === 0) {
                const resolved = { hidesImages: effective.get(SPOILER_IMAGE_KEY)?.value === true, hidesOverviews: effective.get(SPOILER_OVERVIEW_KEY)?.value === true };
                this.confirmed = resolved;
                this.shown = resolved;
                this.writeErrors = {};
                this.saveCache();
            }
            this.readError = undefined;
            this.publish();
        } catch (error) {
            if (!current() || (error instanceof ApiError && error.aborted)) return;
            if (this.sync !== "supported") {
                this.sync = "unavailable";
                this.readError = undefined;
            } else {
                this.readError = this.confirmed === undefined ? "Couldn't load spoiler settings from the server." : "Couldn't refresh spoiler settings. Showing the last saved values.";
            }
            this.publish();
        }
    }

    private write(setting: SpoilerSetting, on: boolean): void {
        if (!this.allowsEditing || this.confirmed === undefined) return;
        const current = setting === "images" ? this.shown.hidesImages : this.shown.hidesOverviews;
        if (current === on) return;
        this.shown = setting === "images" ? { hidesImages: on, hidesOverviews: this.shown.hidesOverviews } : { hidesImages: this.shown.hidesImages, hidesOverviews: on };
        const generation = ++this.generation[setting];
        this.writeRevision++;
        this.pending[setting] += 1;
        this.clearWriteError(setting);
        this.publish();
        const key = setting === "images" ? SPOILER_IMAGE_KEY : SPOILER_OVERVIEW_KEY;
        this.writeChain = this.writeChain.then(async () => {
            try {
                await this.call(settingsOperations.putSetting(key, on), false);
                if (this.controller.signal.aborted) return;
                const base = this.confirmed ?? this.shown;
                this.confirmed = setting === "images" ? { hidesImages: on, hidesOverviews: base.hidesOverviews } : { hidesImages: base.hidesImages, hidesOverviews: on };
                this.saveCache();
                if (this.generation[setting] !== generation) return;
                this.shown = setting === "images" ? { hidesImages: on, hidesOverviews: this.shown.hidesOverviews } : { hidesImages: this.shown.hidesImages, hidesOverviews: on };
                this.clearWriteError(setting);
                this.publish();
            } catch (error) {
                if (this.controller.signal.aborted || (error instanceof ApiError && error.aborted) || this.generation[setting] !== generation) return;
                const saved = this.confirmed ?? OFF;
                this.shown = setting === "images" ? { ...this.shown, hidesImages: saved.hidesImages } : { ...this.shown, hidesOverviews: saved.hidesOverviews };
                this.writeErrors = { ...this.writeErrors, [setting]: writeFailure(setting, error) };
                this.publish();
            } finally {
                this.writeRevision++;
                this.pending[setting] = Math.max(0, this.pending[setting] - 1);
            }
        });
    }

    private call<T>(spec: RequestSpec<T>, replayAfterRefresh = true): Promise<T> {
        return this.session.call({ ...spec, profileScoped: true, replayAfterRefresh, signal: this.controller.signal });
    }

    private publish(): void {
        const snapshot = JSON.stringify({ shown: this.shown, shows: this.showsSettings, edit: this.allowsEditing, footer: this.footer });
        if (snapshot === this.published) return;
        this.published = snapshot;
        for (const listener of this.listeners) listener();
    }

    private clearWriteError(setting: SpoilerSetting): void {
        if (this.writeErrors[setting] === undefined) return;
        const next = { ...this.writeErrors };
        delete next[setting];
        this.writeErrors = next;
    }

    private cacheKey(): string | undefined {
        const profile = this.session.activeProfile;
        const account = this.session.account;
        if (profile === undefined || account === undefined) return undefined;
        return `silo.episodeSpoilers:${JSON.stringify([this.session.server.serverId, account.id, profile.id])}`;
    }

    private loadCache(): void {
        const key = this.cacheKey();
        if (key === undefined) return;
        try {
            const raw = this.storage?.getItem(key);
            if (raw === null || raw === undefined) return;
            const parsed = JSON.parse(raw) as { hidesImages?: unknown; hidesOverviews?: unknown };
            if (typeof parsed.hidesImages !== "boolean" || typeof parsed.hidesOverviews !== "boolean") return;
            this.confirmed = { hidesImages: parsed.hidesImages, hidesOverviews: parsed.hidesOverviews };
            this.shown = this.confirmed;
        } catch { /* A broken cache reads as off until the server answers. */ }
    }

    private saveCache(): void {
        const key = this.cacheKey();
        if (key === undefined || this.confirmed === undefined) return;
        try { this.storage?.setItem(key, JSON.stringify(this.confirmed)); } catch { /* Persistence cannot fail the setting. */ }
    }

    private clearConfirmed(): void {
        this.confirmed = undefined;
        this.shown = OFF;
        this.writeErrors = {};
        const key = this.cacheKey();
        if (key === undefined) return;
        try { this.storage?.removeItem(key); } catch { /* Ignore a blocked cache. */ }
    }
}
