// The /api/v2 operations this client calls, with the retry class each one's contract allows.
// Retry classes come from the operation's x-silo-retry-safety in openapi.json (see ../contracts/v2/SOURCE).

import { decodeServerBranding } from "../contracts/v2/branding.ts";
import { shuffleOperations } from "./shuffleOperations.ts";
import { recommendationOperations } from "./recommendationOperations.ts";
import {
    decodeAuthProviders,
    decodeDeviceLoginCancel,
    decodeDeviceLoginCapability,
    decodeDeviceLoginPoll,
    decodeDeviceLoginStart,
    decodeProfileCollection,
    decodeProfileSummary,
    type ProfileCreateBody,
    decodeProfileVerification,
    decodeRefreshedTokens,
    decodeServerIdentity,
    decodeSetupStatus,
    decodeSystemInfo,
    decodeTokenPair,
} from "../contracts/v2/wire.ts";
import {
    decodeFileVersionTracks,
    decodePlaybackCapabilities,
    decodePlaybackDecision,
    decodePlaybackMutation,
    decodePlaybackDefaults,
    PLAYBACK_SETTING_KEYS,
    type ProgressBody,
    type ReplanPlaybackBody,
    type StartPlaybackBody,
    type StopBody,
} from "../contracts/v2/playback.ts";
import {
    type CatalogPage,
    decodeCatalogPage,
    decodeEpisodes,
    decodeHiddenLibraries,
    decodeHomeCapabilities,
    decodeHomeSections,
    decodeItemDetail,
    decodeMarqueeDetail,
    decodeSeasons,
    decodeUserLibraries,
    decodeWatchDetail,
    type Episode,
    HIDDEN_LIBRARIES_KEY,
    type HomeSection,
    type ItemDetail,
    type MarqueeDetail,
    type Season,
    type UserLibrary,
} from "../contracts/v2/catalog.ts";
import type { RequestSpec } from "./http.ts";
import { decodeImageCapabilities, type ImageCapabilities } from "../contracts/v2/images.ts";
import { discoveryOperations } from "./discoveryOperations.ts";
import { settingsOperations } from "./settingsOperations.ts";
import { themeMusicOperations } from "./themeMusicOperations.ts";
import { trickplayOperations } from "./trickplayOperations.ts";
import { subtitleOperations } from "./subtitleOperations.ts";
import { markerOperations } from "./markerOperations.ts";
import { bandwidthProbeOperations } from "./bandwidthProbeOperations.ts";
import { audiobookOperations } from "./audiobookOperations.ts";

type Spec<T> = RequestSpec<T>;

function noContent(): undefined {
    return undefined;
}

function query(params: Record<string, string | number | undefined>): string {
    const parts: string[] = [];
    for (const key of Object.keys(params)) {
        const value = params[key];
        if (value !== undefined) {
            parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
        }
    }
    return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/** Keep tiles small; Details needs the TV fallback, including stills used as episode backdrops. */
const LIST_IMAGES = "small";
const DETAIL_IMAGES = "large";

/** The media scope of a catalog page: what a library or search may list. */
export type BrowseScope = "movie" | "series" | "video";

export type TextSearchScope = "video" | "video_with_episodes";

/** The Home list a card leaves, and what the server anchors the dismissal to. */
export interface HomeDismissal { readonly surface: "continue_watching" | "next_up"; readonly anchor: string }

export type CatalogPageRequest = {
    readonly limit: number;
    readonly cursor: string | undefined;
} & ({ readonly libraryId?: string; readonly q?: string; readonly type: BrowseScope }
    // Search-only scope on listCatalogItems' default query source, never a library browse.
    | { readonly libraryId?: never; readonly q: string; readonly type: "video_with_episodes" }
    // Apple SearchMediaType: All names no scope while audiobooks take part.
    | { readonly libraryId?: never; readonly q: string; readonly type: "audiobook" | undefined });

export const operations = {
    ...audiobookOperations,
    ...bandwidthProbeOperations,
    ...recommendationOperations,
    ...shuffleOperations,
    ...subtitleOperations,
    watchDetail: (contentId: string): Spec<ReturnType<typeof decodeWatchDetail>> => ({
        method: "GET", path: `/watch/${encodeURIComponent(contentId)}`, retry: "safe", decode: decodeWatchDetail,
    }),
    ...discoveryOperations,
    ...settingsOperations,
    ...themeMusicOperations,
    ...trickplayOperations,
    ...markerOperations,
    /** getSystemInfo: public, read. */
    systemInfo: (): Spec<ReturnType<typeof decodeSystemInfo>> => ({
        method: "GET",
        path: "/system/info",
        retry: "safe",
        decode: decodeSystemInfo,
    }),
    serverBranding: (): Spec<ReturnType<typeof decodeServerBranding>> => ({
        method: "GET", path: "/theme/branding", retry: "safe", decode: decodeServerBranding,
    }),
    /** getSetupStatus: public, read. `needs_setup` is true until the first administrator exists. */
    setupStatus: (): Spec<ReturnType<typeof decodeSetupStatus>> => ({
        method: "GET",
        path: "/system/setup",
        retry: "safe",
        decode: decodeSetupStatus,
    }),
    /** getServerIdentity: public, read. */
    serverIdentity: (): Spec<string> => ({
        method: "GET",
        path: "/system/identity",
        retry: "safe",
        decode: decodeServerIdentity,
    }),
    /** getDeviceLoginCapability: public, read. */
    deviceLoginCapability: (): Spec<ReturnType<typeof decodeDeviceLoginCapability>> => ({
        method: "GET",
        path: "/auth/device/capability",
        retry: "safe",
        decode: decodeDeviceLoginCapability,
    }),
    /** startDeviceLogin: non_retryable, each start creates a new request. */
    startDeviceLogin: (deviceName: string, devicePlatform: string): Spec<ReturnType<typeof decodeDeviceLoginStart>> => ({
        method: "POST",
        path: "/auth/device/start",
        retry: "never",
        body: { device_name: deviceName, device_platform: devicePlatform },
        decode: decodeDeviceLoginStart,
    }),
    /** pollDeviceLogin: non_retryable, an approved answer hands over the tokens once. */
    pollDeviceLogin: (deviceCode: string): Spec<ReturnType<typeof decodeDeviceLoginPoll>> => ({
        method: "POST",
        path: "/auth/device/poll",
        retry: "never",
        body: { device_code: deviceCode },
        decode: decodeDeviceLoginPoll,
    }),
    /** cancelDeviceLogin: natural_idempotent, repeating converges. */
    cancelDeviceLogin: (deviceCode: string): Spec<ReturnType<typeof decodeDeviceLoginCancel>> => ({
        method: "POST",
        path: "/auth/device/cancel",
        retry: "safe",
        body: { device_code: deviceCode },
        decode: decodeDeviceLoginCancel,
    }),
    /** listAuthProviders: public read; `password_login` gates the password route. */
    authProviders: (): Spec<ReturnType<typeof decodeAuthProviders>> => ({
        method: "GET",
        path: "/auth/providers",
        retry: "safe",
        decode: decodeAuthProviders,
    }),
    /** login: public, non_retryable; no `provider`, so the server's default signs in, as on the Apple TV app. */
    login: (username: string, password: string): Spec<ReturnType<typeof decodeTokenPair>> => ({
        method: "POST",
        path: "/auth/login",
        retry: "never",
        body: { username, password },
        decode: (value) => decodeTokenPair(value),
    }),
    /** refreshSession: domain_identity; the session decides what follows a failure. */
    refreshSession: (refreshToken: string): Spec<ReturnType<typeof decodeRefreshedTokens>> => ({
        method: "POST",
        path: "/auth/refresh",
        retry: "never",
        body: { refresh_token: refreshToken },
        decode: decodeRefreshedTokens,
    }),
    /** logout: natural_idempotent; 204. */
    logout: (): Spec<undefined> => ({
        method: "POST",
        path: "/auth/logout",
        retry: "safe",
        decode: noContent,
    }),
    /** listProfiles: profile_scoped read. */
    listProfiles: (): Spec<ReturnType<typeof decodeProfileCollection>> => ({
        method: "GET",
        path: "/profiles",
        retry: "safe",
        decode: decodeProfileCollection,
    }),
    /** createProfile: non_retryable; a lost answer may already have created it. */
    createProfile: (body: ProfileCreateBody): Spec<ReturnType<typeof decodeProfileSummary>> => ({
        method: "POST",
        path: "/profiles",
        retry: "never",
        body: { ...body },
        decode: decodeProfileSummary,
    }),
    /** verifyProfilePIN: non_retryable, every check counts toward the lockout. */
    verifyProfilePin: (profileId: string, pin: string): Spec<ReturnType<typeof decodeProfileVerification>> => ({
        method: "POST",
        path: `/profiles/${encodeURIComponent(profileId)}/verify-pin`,
        retry: "never",
        body: { pin },
        decode: decodeProfileVerification,
    }),
    /** listCatalogItemVersions: profile_scoped read; only each version's file_id and audio_tracks are decoded. */
    catalogItemVersions: (contentId: string): Spec<ReturnType<typeof decodeFileVersionTracks>> => ({
        method: "GET",
        path: `/catalog/items/${encodeURIComponent(contentId)}/versions`,
        retry: "safe",
        decode: decodeFileVersionTracks,
    }),
    /** getPlaybackCapabilities: read; carries installation_id for every playback mutation. */
    playbackCapabilities: (): Spec<ReturnType<typeof decodePlaybackCapabilities>> => ({
        method: "GET",
        path: "/playback/capabilities",
        retry: "safe",
        decode: decodePlaybackCapabilities,
    }),
    /** startPlayback: domain_identity; only the identical body may be resent (same playback_attempt_id). */
    startPlayback: (body: StartPlaybackBody): Spec<ReturnType<typeof decodePlaybackDecision>> => ({
        method: "POST",
        path: "/playback/start",
        retry: "never",
        body,
        decode: decodePlaybackDecision,
    }),
    /** replanPlayback: domain_identity; only the identical body may be resent (same replan_request_id). */
    replanPlayback: (sessionId: string, body: ReplanPlaybackBody): Spec<ReturnType<typeof decodePlaybackDecision>> => ({
        method: "POST",
        path: `/playback/${encodeURIComponent(sessionId)}/replan`,
        retry: "never",
        body,
        decode: decodePlaybackDecision,
    }),
    /** updatePlaybackProgress: domain_identity; each sample has its own sequence. */
    updatePlaybackProgress: (sessionId: string, body: ProgressBody): Spec<ReturnType<typeof decodePlaybackMutation>> => ({
        method: "POST",
        path: `/playback/${encodeURIComponent(sessionId)}/progress`,
        retry: "never",
        body,
        decode: decodePlaybackMutation,
    }),
    /** stopPlayback: domain_identity; only the identical body may be resent (same stop_id). */
    stopPlayback: (sessionId: string, body: StopBody): Spec<ReturnType<typeof decodePlaybackMutation>> => ({
        method: "DELETE",
        path: `/playback/${encodeURIComponent(sessionId)}`,
        retry: "never",
        body,
        decode: decodePlaybackMutation,
    }),
    // Browse reads. All are profile_scoped reads: the server applies the profile's library
    // access, content-rating and advisory limits, so the client never filters for access.

    /** include_hidden is only for the editor; access limits still belong to the server. */
    listUserLibraries: (includeHidden = false): Spec<UserLibrary[]> => ({
        method: "GET",
        path: `/user/libraries${includeHidden ? "?include_hidden=true" : ""}`,
        retry: "safe",
        decode: decodeUserLibraries,
    }),
    playbackDefaults: (keys: readonly string[] = PLAYBACK_SETTING_KEYS): Spec<ReturnType<typeof decodePlaybackDefaults>> => ({
        method: "GET",
        path: `/settings/values/effective?${keys.map((key) => `keys=${encodeURIComponent(key)}`).join("&")}`,
        retry: "safe",
        decode: decodePlaybackDefaults,
    }),
    /** listEffectiveSettings for ui.disabled_library_ids only. */
    hiddenLibraries: (): Spec<string[]> => ({
        method: "GET",
        path: `/settings/values/effective${query({ keys: HIDDEN_LIBRARIES_KEY })}`,
        retry: "safe",
        decode: decodeHiddenLibraries,
    }),
    /** getImageCapabilities: how image-bearing reads may size their artwork. */
    imageCapabilities: (): Spec<ImageCapabilities> => ({ method: "GET", path: "/images/capabilities", retry: "safe", decode: decodeImageCapabilities }),
    /** getHomeCapabilities: `section_item_limit_max` is the largest `item_limit` listHomeSections accepts. */
    homeCapabilities: (): Spec<ReturnType<typeof decodeHomeCapabilities>> => ({ method: "GET", path: "/home/capabilities", retry: "safe", decode: decodeHomeCapabilities }),
    /**
     * listHomeSections: every section with its first cards.
     * `itemLimit` is sent only after getHomeCapabilities advertises `section_item_limit_max`.
     */
    listHomeSections: (slotWidths: Readonly<Record<string, string>> = {}, itemLimit?: number): Spec<HomeSection[]> => ({
        method: "GET",
        path: `/home/sections${query({ image_size: LIST_IMAGES, ...slotWidths, ...(itemLimit === undefined ? {} : { item_limit: itemLimit }) })}`,
        retry: "safe",
        decode: decodeHomeSections,
    }),
    /**
     * dismissHomeItem: natural_idempotent. Continue Watching is anchored to the card's
     * `progress_updated_at`, Next Up to its series (silo-apple `HomeDismissal`).
     */
    dismissHomeItem: (dismissal: HomeDismissal, id: string): Spec<undefined> => ({
        method: "PUT",
        path: `/home/dismissals/${dismissal.surface}/${encodeURIComponent(id)}`,
        retry: "safe",
        body: dismissal.surface === "continue_watching" ? { progress_updated_at: dismissal.anchor } : { series_id: dismissal.anchor },
        decode: noContent,
    }),
    /** listCatalogItems: one page of a library or a search, continued with page.next_cursor. */
    listCatalogItems: (request: CatalogPageRequest): Spec<CatalogPage> => ({
        method: "GET",
        path: `/catalog${query({
            library_id: request.libraryId,
            q: request.q,
            type: request.type,
            limit: request.limit,
            cursor: request.cursor,
            image_size: LIST_IMAGES,
        })}`,
        retry: "safe",
        decode: decodeCatalogPage,
    }),
    /** getCatalogItem: a movie, series, season or episode page with the viewer's state. */
    getCatalogItem: (contentId: string, artwork: Readonly<Record<string, string>> = {}): Spec<ItemDetail> => ({
        method: "GET",
        path: `/catalog/items/${encodeURIComponent(contentId)}${query({ image_size: DETAIL_IMAGES, ...artwork })}`,
        retry: "safe",
        decode: decodeItemDetail,
    }),
    /** getCatalogItem, read for the fields the Home marquee and Continue Watching cards add (the same request as Details'). */
    marqueeDetail: (contentId: string): Spec<MarqueeDetail> => ({
        method: "GET",
        path: `/catalog/items/${encodeURIComponent(contentId)}${query({ image_size: DETAIL_IMAGES })}`,
        retry: "safe",
        decode: decodeMarqueeDetail,
    }),
    /** listSeriesSeasons: bounded, unpaginated. */
    listSeriesSeasons: (seriesId: string): Spec<Season[]> => ({
        method: "GET",
        path: `/catalog/series/${encodeURIComponent(seriesId)}/seasons${query({ image_size: LIST_IMAGES })}`,
        retry: "safe",
        decode: decodeSeasons,
    }),
    /** listSeasonEpisodes: bounded, unpaginated; season 0 is specials. */
    listSeasonEpisodes: (seriesId: string, seasonNumber: number): Spec<Episode[]> => ({
        method: "GET",
        path: `/catalog/series/${encodeURIComponent(seriesId)}/seasons/${seasonNumber}/episodes${query({ image_size: LIST_IMAGES })}`,
        retry: "safe",
        decode: decodeEpisodes,
    }),
};
