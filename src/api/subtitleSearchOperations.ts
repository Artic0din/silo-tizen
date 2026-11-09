import type { RequestSpec } from "./http.ts";
import { decodeLanguageCatalog, decodePreferredLanguage, decodeProviderStatus, decodeSearchResponse, decodeStoredSubtitle, type SearchResponse, type StoredSubtitle } from "../contracts/v2/subtitleSearch.ts";

const SEARCH_TIMEOUT_MS = 35000;

export const subtitleSearchOperations = {
    providerStatus: (): RequestSpec<ReturnType<typeof decodeProviderStatus>> => ({ method: "GET", path: "/subtitles/providers/status", retry: "never", decode: decodeProviderStatus }),
    languages: (): RequestSpec<ReturnType<typeof decodeLanguageCatalog>> => ({ method: "GET", path: "/settings/contract", retry: "safe", decode: decodeLanguageCatalog }),
    preferredLanguage: (): RequestSpec<string | undefined> => ({ method: "GET", path: "/settings/values/effective?keys=playback.subtitle_language", retry: "safe", decode: decodePreferredLanguage }),
    search: (fileId: string, language: string): RequestSpec<SearchResponse> => ({
        method: "POST", path: "/subtitles/search", retry: "never", timeoutMs: SEARCH_TIMEOUT_MS,
        body: { media_file_id: fileId, languages: [language] }, decode: decodeSearchResponse,
    }),
    download: (fileId: string, result: { readonly id: string; readonly provider: string; readonly language: string; readonly releaseName: string; readonly score: number; readonly hearingImpaired: boolean }): RequestSpec<StoredSubtitle> => ({
        method: "POST", path: "/subtitles/download", retry: "never", timeoutMs: SEARCH_TIMEOUT_MS,
        body: { media_file_id: fileId, provider: result.provider, subtitle_id: result.id, language: result.language, release_name: result.releaseName, score: result.score, hearing_impaired: result.hearingImpaired },
        decode: decodeStoredSubtitle,
    }),
};
