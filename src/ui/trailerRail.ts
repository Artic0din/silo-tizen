// Shaping for the movie and series "Trailers & More" rail.
// Rules match silo-apple Screens/Detail/TrailerRail.swift and ExtraKindLabels.swift
// at 7baff3ef657757cc0a69202e86dd4bd5c7fcb585. tvOS is the only caller that matters.

import type { ItemVideo, LocalExtra } from "../contracts/v2/catalog.ts";
import { clockTime } from "./browseModel.ts";

const KIND_LABELS: Readonly<Record<string, string>> = {
    trailer: "Trailer",
    teaser: "Teaser",
    featurette: "Featurette",
    clip: "Clip",
    behind_the_scenes: "Behind the Scenes",
    bloopers: "Bloopers",
    deleted_scene: "Deleted Scene",
    other: "Extra",
};

/** Singular card label. An unknown kind stays "Extra" rather than a raw id. */
export function extraKindLabel(kind: string): string {
    return KIND_LABELS[kind] ?? "Extra";
}

export function trailerTitle(name: string | undefined, kind: string): string {
    const trimmed = name?.trim() ?? "";
    return trimmed === "" ? extraKindLabel(kind) : trimmed;
}

/** YouTube's still that exists for every video. hqdefault, not maxresdefault. */
export function youtubeStillUrl(siteKey: string): string {
    return `https://i.ytimg.com/vi/${siteKey}/hqdefault.jpg`;
}

export type TrailerCard =
    | {
        readonly role: "local";
        readonly id: string;
        readonly title: string;
        readonly caption: string | undefined;
        readonly stillUrl: string | undefined;
        readonly extra: LocalExtra;
    }
    | {
        readonly role: "remote";
        readonly id: string;
        readonly title: string;
        readonly caption: "YouTube";
        readonly stillUrl: string;
        readonly site: string;
        readonly siteKey: string;
    };

/**
 * Local extras first, in server order, then YouTube videos in server order.
 * Any other site is dropped. `allowRemote` false leaves a local-only rail,
 * which is tvOS when the YouTube app cannot be opened.
 */
export function trailerCards(extras: readonly LocalExtra[] | undefined, videos: readonly ItemVideo[] | undefined, allowRemote: boolean): TrailerCard[] {
    const cards: TrailerCard[] = [];
    for (const extra of extras ?? []) {
        const seconds = extra.durationSeconds;
        cards.push({
            role: "local",
            id: `local:${extra.contentId}`,
            title: trailerTitle(extra.title, extra.kind),
            caption: seconds !== undefined && seconds > 0 ? clockTime(seconds) : undefined,
            stillUrl: extra.stillUrl,
            extra,
        });
    }
    if (allowRemote) {
        for (const video of videos ?? []) {
            if (video.site.toLowerCase() !== "youtube") continue;
            cards.push({
                role: "remote",
                id: `remote:${video.site}:${video.siteKey}`,
                title: trailerTitle(video.name, video.kind),
                caption: "YouTube",
                stillUrl: youtubeStillUrl(video.siteKey),
                site: video.site,
                siteKey: video.siteKey,
            });
        }
    }
    return cards;
}
