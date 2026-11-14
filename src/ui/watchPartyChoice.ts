// What the Watch Party lobby and picker show of a title: Apple's WatchPartyMediaChoice and
// WatchPartySelectedItem. An episode never shows its own still or description, so the lobby and
// picker cannot spoil it; Apple blurs them by the viewer's spoiler setting, which this client lacks.

import type { Card, Episode, ItemDetail } from "../contracts/v2/catalog.ts";
import { runtimeText } from "./cardPresentation.ts";

/** The title as the lobby hero draws it. */
export interface LobbyItem {
    readonly contentId: string;
    readonly title: string;
    readonly subtitle: string | undefined;
    readonly posterUrl: string | undefined;
    readonly backdropUrl: string | undefined;
    readonly overview: string | undefined;
    /** "2024 · 2h 46m". */
    readonly facts: readonly string[];
    /** Outlined quality chips: "4K", "HDR". */
    readonly chips: readonly string[];
}

/** A title the host can choose, as the picker's confirmation page shows it. */
export interface MediaChoice {
    readonly contentId: string;
    readonly type: string;
    readonly title: string;
    readonly subtitle: string | undefined;
    readonly posterUrl: string | undefined;
    readonly backdropUrl: string | undefined;
    readonly overview: string | undefined;
    readonly facts: readonly string[];
    readonly lobby: LobbyItem;
}

const episodeCode = (season: number | undefined, episode: number | undefined, separator: string): string | undefined =>
    season === undefined || episode === undefined ? undefined : `S${season}${separator}E${episode}`;

function yearAndRuntime(year: number | undefined, minutes: number | undefined): string[] {
    return [year !== undefined && year > 0 ? String(year) : undefined, runtimeText(minutes)].filter((fact): fact is string => fact !== undefined);
}

/** Apple's WatchPartyMediaChoice(item:), or an episode card as a resume row gives it. */
export function choiceFromCard(card: Card): MediaChoice {
    const episode = card.type === "episode";
    const facts = [...yearAndRuntime(card.year, card.runtimeMinutes), card.contentRating, card.genres?.[0]].filter((fact): fact is string => fact !== undefined && fact !== "");
    const code = episodeCode(card.seasonNumber, card.episodeNumber, " · ");
    // An episode's card carries its still as the backdrop; the series art is the safe one.
    const backdropUrl = episode ? card.seriesBackdropUrl : card.backdropUrl;
    const lobbyCode = episodeCode(card.seasonNumber, card.episodeNumber, ":");
    return {
        contentId: card.id,
        type: card.type,
        title: episode ? card.seriesTitle ?? card.title : card.title,
        subtitle: episode ? [code, card.seriesTitle === undefined ? undefined : card.title].filter(part => part !== undefined).join(" · ") || undefined : undefined,
        posterUrl: card.posterUrl,
        backdropUrl,
        overview: episode ? undefined : card.overview,
        facts,
        lobby: {
            contentId: card.id,
            title: card.title,
            subtitle: episode ? [card.seriesTitle, lobbyCode].filter(part => part !== undefined).join(" · ") || undefined : undefined,
            posterUrl: card.posterUrl,
            backdropUrl,
            overview: episode ? undefined : card.overview,
            facts: yearAndRuntime(card.year, card.runtimeMinutes),
            chips: [],
        },
    };
}

/** Apple's WatchPartyMediaChoice(series:episode:): the series poster and art, with the episode's own title. */
export function choiceFromEpisode(series: Card, episode: Episode): MediaChoice {
    const title = episode.title === "" ? `Episode ${episode.episodeNumber}` : episode.title;
    const code = `S${episode.seasonNumber} · E${episode.episodeNumber}`;
    const facts = runtimeText(episode.runtimeMinutes) === undefined ? [] : [runtimeText(episode.runtimeMinutes) as string];
    return {
        contentId: episode.id,
        type: "episode",
        title: series.title,
        subtitle: `${code} · ${title}`,
        posterUrl: series.posterUrl,
        backdropUrl: series.backdropUrl,
        overview: undefined,
        facts,
        lobby: {
            contentId: episode.id,
            title,
            subtitle: `${series.title} · S${episode.seasonNumber}:E${episode.episodeNumber}`,
            posterUrl: series.posterUrl,
            backdropUrl: series.backdropUrl,
            overview: undefined,
            facts: facts,
            chips: [],
        },
    };
}

/** Apple's WatchPartyMediaChoice(series:nextUp:), for a series the group is part-way through. */
export function choiceFromNextUp(series: Card, nextUp: { readonly contentId: string; readonly seasonNumber: number; readonly episodeNumber: number; readonly title: string | undefined }): MediaChoice {
    const title = nextUp.title ?? `Episode ${nextUp.episodeNumber}`;
    return {
        contentId: nextUp.contentId,
        type: "episode",
        title: series.title,
        subtitle: `S${nextUp.seasonNumber} · E${nextUp.episodeNumber}${nextUp.title === undefined ? "" : ` · ${nextUp.title}`}`,
        posterUrl: series.posterUrl,
        backdropUrl: series.backdropUrl,
        overview: undefined,
        facts: [],
        lobby: { contentId: nextUp.contentId, title, subtitle: `${series.title} · S${nextUp.seasonNumber}:E${nextUp.episodeNumber}`, posterUrl: series.posterUrl, backdropUrl: series.backdropUrl, overview: undefined, facts: [], chips: [] },
    };
}

/** The room's selected title from the catalog read (Apple's WatchPartySelectedItem(detail)). */
export function lobbyItemFromDetail(detail: ItemDetail): LobbyItem {
    const episode = detail.type === "episode";
    const file = detail.versions[0];
    const resolution = file?.resolution?.toLowerCase() ?? "";
    const chips = [resolution.includes("2160") || resolution.includes("4k") ? "4K" : resolution.includes("1080") ? "1080p" : resolution.includes("720") ? "720p" : undefined, /hdr/i.test(file?.compactLabel ?? "") ? "HDR" : undefined]
        .filter((chip): chip is string => chip !== undefined);
    const code = episodeCode(detail.seasonNumber, detail.episodeNumber, ":");
    return {
        contentId: detail.id,
        title: detail.title,
        subtitle: episode ? [detail.seriesTitle, code].filter(part => part !== undefined).join(" · ") || undefined : detail.seriesTitle,
        posterUrl: detail.posterUrl,
        // A backdrop that is an episode still is left out, as the lobby cannot know the viewer's spoiler setting.
        backdropUrl: episode && detail.backdropIsEpisodeStill !== false ? undefined : detail.backdropUrl,
        overview: episode ? undefined : detail.overview,
        facts: yearAndRuntime(detail.year, detail.runtimeMinutes),
        chips,
    };
}

/** A title chosen from its own Details page (Apple's WatchPartySelectedItem(previewing:)). */
export function choiceFromDetail(detail: ItemDetail): MediaChoice {
    const lobby = lobbyItemFromDetail(detail);
    return { contentId: detail.id, type: detail.type, title: lobby.title, subtitle: lobby.subtitle, posterUrl: lobby.posterUrl, backdropUrl: lobby.backdropUrl, overview: lobby.overview, facts: lobby.facts, lobby };
}
