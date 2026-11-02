// Item-detail fields Home shows but its rows do not carry: the marquee's aired date and cast line, and
// Continue Watching's saved-file chips and badges. Apple reads them on focus
// (silo-apple 1a7ccee `tvOS/Components/TVFocusMarquee.swift`: TVMarqueeEnrichment and
// TVContinueWatchingPlaybackMetadataStore); Tizen never reads on focus, so it reads every title Home
// draws once, when Home's rows load, a few at a time, and focus only looks the answers up.
// The presentation below is ported (AGPL-3.0-or-later) from those two types.

import type { RequestSpec } from "../api/http.ts";
import { operations } from "../api/operations.ts";
import type { Card, CardOverlay, MarqueeAudioTrack, MarqueeDetail, MarqueeFile } from "../contracts/v2/catalog.ts";
import { resolutionLabel } from "./cardPresentation.ts";
import { formatPersonDate } from "./personHero.ts";

/** Item-detail reads in flight at once while Home loads (Apple's metadata pool runs a handful too). */
export const HOME_DETAIL_CONCURRENCY = 4;

export interface HomeTitle {
    readonly card: Card;
    readonly continuing: boolean;
}

interface Entry {
    readonly detail: MarqueeDetail;
    /** Continue Watching's progress revision the detail was read at; undefined for other rows. */
    readonly revision: string | undefined;
}

/** One Browse (one server and profile) owns this; nothing here outlives it. */
export class HomeEnrichment {
    private readonly entries = new Map<string, Entry>();
    private controller: AbortController | undefined;
    private readonly read: <T>(spec: RequestSpec<T>, signal: AbortSignal) => Promise<T>;
    private readonly landed: (id: string) => void;
    private readonly continuingSettled: () => void;

    /** `landed` follows each answer; `continuingSettled` follows the last Continue Watching read of a load. */
    constructor(read: <T>(spec: RequestSpec<T>, signal: AbortSignal) => Promise<T>, landed: (id: string) => void, continuingSettled: () => void) {
        this.read = read;
        this.landed = landed;
        this.continuingSettled = continuingSettled;
    }

    /**
     * Reads detail for each title Home just drew that has none yet, Continue Watching first. A title read
     * before is read again when it enters Continue Watching or its progress revision changes (a new
     * file may have been chosen). A newer call replaces an unfinished one.
     */
    load(titles: readonly HomeTitle[]): void {
        this.controller?.abort();
        const controller = new AbortController();
        this.controller = controller;
        const wanted = new Map<string, string | undefined>();
        const seen = new Set<string>();
        for (const title of [...titles].sort((a, b) => Number(b.continuing) - Number(a.continuing))) {
            if (seen.has(title.card.id)) continue;
            seen.add(title.card.id);
            const revision = title.continuing ? title.card.progressUpdatedAt ?? "" : undefined;
            const known = this.entries.get(title.card.id);
            if (known === undefined || (revision !== undefined && known.revision !== revision)) wanted.set(title.card.id, revision);
        }
        const queue = [...wanted];
        let continuing = queue.filter(([, revision]) => revision !== undefined).length;
        const work = async (): Promise<void> => {
            for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
                const [id, revision] = next;
                try {
                    const detail = await this.read(operations.marqueeDetail(id), controller.signal);
                    if (controller.signal.aborted) return;
                    if (detail.id === id) {
                        this.entries.set(id, { detail, revision });
                        this.landed(id);
                    }
                } catch {
                    // A title whose detail cannot be read keeps what its row carries; the next Home load tries again.
                    if (controller.signal.aborted) return;
                }
                if (revision !== undefined && --continuing === 0) this.continuingSettled();
            }
        };
        void Promise.all(Array.from({ length: Math.min(HOME_DETAIL_CONCURRENCY, queue.length) }, work)).then(() => {
            if (this.controller === controller) this.controller = undefined;
        });
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

    stop(): void {
        this.controller?.abort();
        this.controller = undefined;
    }
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
