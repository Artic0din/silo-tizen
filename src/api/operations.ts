// The /api/v2 operations this client calls, with the retry class each one's contract allows.
// Retry classes come from the operation's x-silo-retry-safety in openapi.json (see ../contracts/v2/SOURCE).

import {
    decodeDeviceLoginCancel,
    decodeDeviceLoginCapability,
    decodeDeviceLoginPoll,
    decodeDeviceLoginStart,
    decodeProfileCollection,
    decodeProfileVerification,
    decodeRefreshedTokens,
    decodeServerIdentity,
    decodeSystemInfo,
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
    decodeHomeSections,
    decodeItemDetail,
    decodeSeasons,
    decodeUserLibraries,
    type Episode,
    HIDDEN_LIBRARIES_KEY,
    type HomeSection,
    type ItemDetail,
    type Season,
    type UserLibrary,
} from "../contracts/v2/catalog.ts";
import type { RequestSpec } from "./http.ts";
import { discoveryOperations } from "./discoveryOperations.ts";
import { settingsOperations } from "./settingsOperations.ts";
import { trickplayOperations } from "./trickplayOperations.ts";

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

/** Card rows and grids draw posters near 300px (the `small` rung); detail pages near 500px posters and full-width backdrops (`medium`). */
const LIST_IMAGES = "small";
const DETAIL_IMAGES = "medium";

/** The media scope of a catalog page: what a library or search may list. */
export type BrowseScope = "movie" | "series" | "video";

export interface CatalogPageRequest {
    readonly libraryId?: string;
    /** Search text; absent browses. */
    readonly q?: string;
    readonly type: BrowseScope;
    readonly limit: number;
    readonly cursor: string | undefined;
}

export const operations = {
    ...discoveryOperations,
    ...settingsOperations,
    ...trickplayOperations,
    /** getSystemInfo: public, read. */
    systemInfo: (): Spec<ReturnType<typeof decodeSystemInfo>> => ({
        method: "GET",
        path: "/system/info",
        retry: "safe",
        decode: decodeSystemInfo,
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
    playbackDefaults: (): Spec<ReturnType<typeof decodePlaybackDefaults>> => ({
        method: "GET",
        path: `/settings/values/effective?${PLAYBACK_SETTING_KEYS.map((key) => `keys=${encodeURIComponent(key)}`).join("&")}`,
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
    /** listHomeSections: every section with its first cards, bounded by each section's item_limit. */
    listHomeSections: (): Spec<HomeSection[]> => ({
        method: "GET",
        path: `/home/sections${query({ image_size: LIST_IMAGES })}`,
        retry: "safe",
        decode: decodeHomeSections,
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
    getCatalogItem: (contentId: string): Spec<ItemDetail> => ({
        method: "GET",
        path: `/catalog/items/${encodeURIComponent(contentId)}${query({ image_size: DETAIL_IMAGES })}`,
        retry: "safe",
        decode: decodeItemDetail,
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
