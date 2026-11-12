// Item-detail fields the section payload does not carry: the marquee's aired date and cast line,
// a rating or runtime the row omitted, and Continue Watching's saved-file chips.
// silo-apple 2ef3a171 (AGPL-3.0-or-later):
// - TVFocusMarquee.swift waits `marqueeRestDebounceMilliseconds` (150) before an uncached detail read,
//   and drops the answer when focus has moved.
// - EpisodeThumbCard.swift:108-110 loads Continue Watching's saved file from `.task` when that
//   card's view exists. MediaRow.swift:413-416 keeps the row in a LazyHStack, so a card that
//   has not been mounted is not read (MediaRow.swift:49-50, 168-169). ArtworkLookahead warms
//   image bytes from the focused card (MediaRow.swift:143, 481-486), not item detail.
//   This row draws every card, so those saved-file reads stay on the queue, four at a time.
// - RecommendationsView.swift prewarms at most two rows of eight cards that omit a content rating,
//   three at a time. Home does not. Home's own prefetch is image bytes, not item detail.
// The presentation below is ported from TVMarqueeEnrichment and TVContinueWatchingPlaybackMetadataStore.

import type { Clock } from "../api/clock.ts";
import type { RequestSpec } from "../api/http.ts";
import { operations } from "../api/operations.ts";
import type { Card, CardOverlay, MarqueeAudioTrack, MarqueeDetail, MarqueeFile } from "../contracts/v2/catalog.ts";
import { resolutionLabel } from "./cardPresentation.ts";
import { formatPersonDate } from "./personHero.ts";

/** `SiloTheme.Skyline.marqueeRestDebounceMilliseconds` at silo-apple 2ef3a171. */
export const MARQUEE_REST_MILLISECONDS = 150;

/** `RecommendationsView.initialMarqueeItems`: the first two rows. */
export const FOR_YOU_PREWARM_ROWS = 2;

/** `RecommendationsView.initialMarqueeItems`: eight cards in each of those rows. */
export const FOR_YOU_PREWARM_CARDS = 8;

/** `RecommendationsView.prewarmInitialMarqueeDetails`: three detail reads at a time. */
export const FOR_YOU_PREWARM_CONCURRENCY = 3;

/**
 * Saved-file reads in flight for one Continue Watching row.
 * Apple mounts only the visible LazyHStack cards; this row draws all of them.
 */
export const CONTINUE_WATCHING_CONCURRENCY = 4;

export interface HomeEnrichmentRow {
    readonly cards: readonly Card[];
    readonly continuing: boolean;
}

interface Entry {
    readonly detail: MarqueeDetail;
    /** Continue Watching's progress revision the detail was read at; undefined for other rows. */
    readonly revision: string | undefined;
}

interface Job {
    readonly revision: string | undefined;
    readonly controller: AbortController;
    readonly listeners: Set<() => void>;
}

/** One Browse (one server and profile) owns this; nothing here outlives it. */
export class HomeEnrichment {
    private readonly entries = new Map<string, Entry>();
    private readonly jobs = new Map<string, Job>();
    private readonly read: <T>(spec: RequestSpec<T>, signal: AbortSignal) => Promise<T>;
    private readonly landed: (id: string) => void;
    private readonly continuingSettled: () => void;
    private readonly schedule: Clock["schedule"];
    private cancelRest: () => void = () => undefined;
    /** The focused card's read while it waits out the rest. */
    private pendingRead: (() => void) | undefined;
    private focusController: AbortController | undefined;
    private focusedId: string | undefined;
    private focusRevision: string | undefined;
    private continuingController: AbortController | undefined;
    private prewarmController: AbortController | undefined;

    /** `landed` fills the focused marquee. `continuingSettled` redraws Continue Watching badges. */
    constructor(read: <T>(spec: RequestSpec<T>, signal: AbortSignal) => Promise<T>, landed: (id: string) => void, continuingSettled: () => void, schedule: Clock["schedule"]) {
        this.read = read;
        this.landed = landed;
        this.continuingSettled = continuingSettled;
        this.schedule = schedule;
    }

    /**
     * Continue Watching reads each saved file, four at a time. For You also warms ratings the
     * first two rows omitted, except titles this pass is already reading. Neither path reads
     * every other title.
     */
    present(rows: readonly HomeEnrichmentRow[], prewarmRatings: boolean): void {
        this.continuingController?.abort();
        this.prewarmController?.abort();
        const continuing = new AbortController();
        this.continuingController = continuing;
        const seen = new Set<string>();
        const jobs: { id: string; revision: string }[] = [];
        for (const row of rows) {
            if (!row.continuing) continue;
            for (const card of row.cards) {
                if (seen.has(card.id)) continue;
                seen.add(card.id);
                const revision = card.progressUpdatedAt ?? "";
                if (this.fresh(card.id, revision)) continue;
                jobs.push({ id: card.id, revision });
            }
        }
        let pending = jobs.length;
        this.pump(jobs, continuing.signal, CONTINUE_WATCHING_CONCURRENCY, () => {
            if (continuing.signal.aborted) return;
            pending -= 1;
            if (pending === 0) this.continuingSettled();
        });
        if (!prewarmRatings) return;
        const prewarm = new AbortController();
        this.prewarmController = prewarm;
        const ids: string[] = [];
        for (const row of rows.slice(0, FOR_YOU_PREWARM_ROWS)) {
            for (const card of row.cards.slice(0, FOR_YOU_PREWARM_CARDS)) {
                if (!missingRating(card) || this.fresh(card.id, undefined) || seen.has(card.id) || ids.includes(card.id)) continue;
                ids.push(card.id);
            }
        }
        this.pump(ids.map(id => ({ id, revision: undefined })), prewarm.signal, FOR_YOU_PREWARM_CONCURRENCY);
    }

    /**
     * The focused card. A cached detail fills the marquee now. An uncached one waits out the rest
     * delay, and a newer focus cancels both the wait and the read so the late answer cannot land.
     */
    rest(card: Card, continuing: boolean): void {
        const revision = continuing ? card.progressUpdatedAt ?? "" : undefined;
        if (this.focusedId === card.id && this.focusRevision === revision) {
            if (this.fresh(card.id, revision)) this.landed(card.id);
            return;
        }
        this.cancelRest();
        this.cancelRest = () => undefined;
        this.pendingRead = undefined;
        this.focusController?.abort();
        this.focusedId = card.id;
        this.focusRevision = revision;
        if (this.fresh(card.id, revision)) {
            this.focusController = undefined;
            this.landed(card.id);
            return;
        }
        const controller = new AbortController();
        this.focusController = controller;
        const read = (): void => {
            if (this.focusController !== controller) return;
            this.request(card.id, revision, controller.signal, () => {
                if (this.focusController !== controller || !this.fresh(card.id, revision)) return;
                this.landed(card.id);
            });
        };
        this.pendingRead = read;
        this.cancelRest = this.schedule(() => {
            this.cancelRest = () => undefined;
            this.pendingRead = undefined;
            read();
        }, MARQUEE_REST_MILLISECONDS);
    }

    /**
     * A row change: `loadEnrichment(deferNetwork: false)` in restForRowChange (silo-apple 85679e7
     * `tvOS/Components/TVFocusMarquee.swift:818-826`) starts the focused card's read without the rest.
     * Moves within a row still wait for it (`:808`, `:973-978`).
     */
    readNow(): void {
        const read = this.pendingRead;
        if (read === undefined) return;
        this.cancelRest();
        this.cancelRest = () => undefined;
        this.pendingRead = undefined;
        read();
    }

    /** Leaves the scene: drop the wait and every read that has not landed. Kept answers stay. */
    suspend(): void {
        this.cancelRest();
        this.cancelRest = () => undefined;
        this.pendingRead = undefined;
        this.focusController?.abort();
        this.focusController = undefined;
        this.focusedId = undefined;
        this.focusRevision = undefined;
        this.continuingController?.abort();
        this.continuingController = undefined;
        this.prewarmController?.abort();
        this.prewarmController = undefined;
    }

    stop(): void {
        this.suspend();
    }

    private fresh(id: string, revision: string | undefined): boolean {
        const known = this.entries.get(id);
        if (known === undefined) return false;
        return revision === undefined || known.revision === revision;
    }

    /** One flight per title. A listener that leaves before the answer does not keep the flight, and does not see it. */
    private request(id: string, revision: string | undefined, signal: AbortSignal, onDone: () => void): void {
        if (signal.aborted) return;
        if (this.fresh(id, revision)) {
            onDone();
            return;
        }
        let job = this.jobs.get(id);
        const sameRevision = job !== undefined && (revision === undefined || job.revision === undefined || job.revision === revision);
        if (job !== undefined && !sameRevision) {
            job.controller.abort();
            this.jobs.delete(id);
            job = undefined;
        }
        if (job === undefined) {
            const controller = new AbortController();
            const created: Job = { revision, controller, listeners: new Set() };
            job = created;
            this.jobs.set(id, created);
            void this.read(operations.marqueeDetail(id), controller.signal).then(detail => {
                if (controller.signal.aborted || this.jobs.get(id) !== created) return;
                if (detail.id === id) this.entries.set(id, { detail, revision });
            }, () => undefined).finally(() => {
                if (this.jobs.get(id) !== created) return;
                this.jobs.delete(id);
                if (controller.signal.aborted) return;
                for (const listener of created.listeners) listener();
            });
        }
        const active = job;
        const listener = (): void => {
            if (!signal.aborted) onDone();
        };
        active.listeners.add(listener);
        signal.addEventListener("abort", () => {
            active.listeners.delete(listener);
            if (active.listeners.size === 0 && this.jobs.get(id) === active) {
                active.controller.abort();
                this.jobs.delete(id);
            }
        }, { once: true });
    }

    /** At most `concurrency` reads at once. One flight per title, and a cancelled scene stops the queue. */
    private pump(jobs: readonly { id: string; revision: string | undefined }[], signal: AbortSignal, concurrency: number, onDone?: () => void): void {
        const queue = [...jobs];
        const workers = Math.min(concurrency, queue.length);
        const worker = async (): Promise<void> => {
            for (;;) {
                if (signal.aborted) return;
                const job = queue.shift();
                if (job === undefined) return;
                await new Promise<void>(resolve => {
                    if (signal.aborted) {
                        resolve();
                        return;
                    }
                    this.request(job.id, job.revision, signal, () => {
                        if (!signal.aborted && this.focusedId === job.id && this.fresh(job.id, job.revision)) this.landed(job.id);
                        onDone?.();
                        resolve();
                    });
                });
            }
        };
        void Promise.all(Array.from({ length: workers }, () => worker()));
    }

    /** TVMarqueeEnrichment fills only metadata the row omitted. */
    filled(card: Card): Card {
        const detail = this.entries.get(card.id)?.detail;
        if (detail === undefined) return card;
        const rating = card.contentRating?.trim() ? undefined : detail.contentRating?.trim();
        const runtime = card.runtimeMinutes !== undefined || (card.durationSeconds ?? 0) > 0 ? undefined : detail.runtimeMinutes;
        return rating || runtime !== undefined ? { ...card, ...(rating ? { contentRating: rating } : {}), ...(runtime === undefined ? {} : { runtimeMinutes: runtime }) } : card;
    }

    /** `Aired Mar 12, 2026 · Pedro Pascal, Bella Ramsey, Anna Torv`, when detail has either part. */
    detailLine(id: string): string | undefined {
        const detail = this.entries.get(id)?.detail;
        if (detail === undefined) return undefined;
        const parts: string[] = [];
        const aired = detail.airDate === undefined || detail.airDate.trim() === "" ? undefined : formatPersonDate(detail.airDate);
        if (aired !== undefined) parts.push(`Aired ${aired}`);
        const cast = detail.cast.map((credit, position) => ({ credit, position }))
            .sort((a, b) => (a.credit.order ?? Number.MAX_SAFE_INTEGER) - (b.credit.order ?? Number.MAX_SAFE_INTEGER) || a.position - b.position)
            .slice(0, 3).map(entry => entry.credit.name).filter(name => name !== "");
        if (cast.length > 0) parts.push(cast.join(", "));
        return parts.length === 0 ? undefined : parts.join(" · ");
    }

    /**
     * Continue Watching's chips and card badges for the exact file this viewer last played. Undefined
     * when that file is unknown, so the row's best-file summary stays: a file is never guessed.
     */
    savedFile(card: Card): { overlay: CardOverlay; badges: string[] } | undefined {
        // Like Apple's slot, the last answer stays until a newer revision's read lands.
        const entry = this.entries.get(card.id);
        if (entry === undefined) return undefined;
        const lastFileId = entry.detail.lastFileId;
        const version = lastFileId === undefined ? undefined : entry.detail.versions.find(file => file.fileId === lastFileId);
        return version === undefined ? undefined : savedFilePresentation(version, card.overlay);
    }
}

function missingRating(card: Card): boolean {
    const rating = card.contentRating?.trim();
    return rating === undefined || rating === "";
}

function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/** Apple TrackLabels.audioCodec. */
function audioCodec(codec: string | undefined): string | undefined {
    const lowered = codec?.toLowerCase();
    if (lowered === undefined || lowered === "") return undefined;
    if (lowered.includes("eac3") || lowered.includes("e-ac-3") || lowered.includes("ec-3")) return "EAC3";
    if (lowered.includes("ac3") || lowered.includes("ac-3")) return "AC3";
    if (lowered.includes("aac")) return "AAC";
    if (lowered.includes("mp3")) return "MP3";
    if (lowered.includes("truehd")) return "TrueHD";
    if (lowered.includes("dts")) return "DTS";
    if (lowered.includes("flac")) return "FLAC";
    return lowered.toUpperCase();
}

/** Apple DetailPlaybackFormatting.normalizedVideoCodec. */
function videoCodec(codec: string | undefined): string | undefined {
    const lowered = codec?.toLowerCase();
    if (lowered === undefined || lowered === "") return undefined;
    if (lowered.includes("hevc") || lowered.includes("h265")) return "HEVC";
    if (lowered.includes("av1")) return "AV1";
    if (lowered.includes("avc") || lowered.includes("h264")) return "H.264";
    return lowered.toUpperCase();
}

function selectedAudioTrack(file: MarqueeFile): MarqueeAudioTrack | undefined {
    const tracks = file.audioTracks;
    if (tracks.length === 0) return undefined;
    const effective = file.effectiveAudioTrackIndex;
    if (effective !== undefined) {
        const byIndex = tracks.find(track => track.index === effective);
        if (byIndex !== undefined) return byIndex;
        const byPosition = tracks[effective];
        if (effective >= 0 && byPosition !== undefined) return byPosition;
    }
    return tracks.find(track => track.isDefault === true) ?? tracks[0];
}

function compactAudioLayout(track: MarqueeAudioTrack | undefined): string | undefined {
    if (track === undefined) return undefined;
    const layout = nonEmpty(track.layout);
    if (layout !== undefined) {
        const lowered = layout.toLowerCase();
        if (lowered.includes("atmos")) return "Atmos";
        if (lowered.includes("7.1")) return "7.1";
        if (lowered.includes("5.1")) return "5.1";
        if (lowered.includes("stereo") || lowered === "2.0") return "Stereo";
        return layout;
    }
    switch (track.channels) {
        case undefined: return undefined;
        case 1: return "Mono";
        case 2: return "Stereo";
        case 6: return "5.1";
        case 8: return "7.1";
        default: return `${track.channels}ch`;
    }
}

function dynamicRangeLabel(file: MarqueeFile): string | undefined {
    if (file.videoTracks.some(track => nonEmpty(track.dolbyVision) !== undefined)) return "DV";
    if (file.hdr !== true) return undefined;
    return file.videoTracks.map(track => track.videoRange).find((range): range is string => range !== undefined && range !== "" && range.toLowerCase() !== "sdr") ?? "HDR";
}

export function savedFilePresentation(file: MarqueeFile, base: CardOverlay | undefined): { overlay: CardOverlay; badges: string[] } {
    const track = selectedAudioTrack(file);
    const codec = audioCodec(track?.codec ?? file.codecAudio);
    const layout = compactAudioLayout(track);
    const atmos = track?.layout?.toLowerCase().includes("atmos") === true;
    const hdr = dynamicRangeLabel(file);
    const overlay: CardOverlay = {
        ...base,
        resolution: file.resolution,
        hdr,
        audio: atmos ? "Atmos" : codec ?? layout,
        audioChannels: layout,
        videoCodec: videoCodec(file.codecVideo),
        container: file.container,
        multiAudio: file.audioTracks.length > 1,
        multiSub: file.subtitleTrackCount > 1,
    };
    const badges: string[] = [];
    const resolution = resolutionLabel(file.resolution);
    if (resolution !== undefined) badges.push(resolution);
    if (hdr !== undefined) badges.push(hdr.toLowerCase().includes("dv") ? "DOLBY VISION" : hdr.toUpperCase());
    if (atmos) badges.push("ATMOS");
    else {
        const audio = [codec, layout].filter((value): value is string => value !== undefined)
            .reduce<string[]>((values, value) => values.some(known => known.toLowerCase() === value.toLowerCase()) ? values : [...values, value], [])
            .join(" ");
        if (audio !== "") badges.push(audio.toUpperCase());
    }
    return { overlay, badges };
}
