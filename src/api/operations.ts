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
    type ProgressBody,
    type ReplanPlaybackBody,
    type StartPlaybackBody,
    type StopBody,
} from "../contracts/v2/playback.ts";
import type { RequestSpec } from "./http.ts";

type Spec<T> = RequestSpec<T>;

function noContent(): undefined {
    return undefined;
}

export const operations = {
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
};
