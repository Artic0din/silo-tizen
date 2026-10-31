import type { RequestSpec } from "./http.ts";
import { decodeAIJob, decodeAILanguages, decodeAIQuota, decodeAIStatus } from "../contracts/v2/subtitleAI.ts";

export interface SubtitleAIRequest {
    readonly media_file_id: string;
    readonly kind: "translate" | "transcribe";
    readonly source_index: number;
    readonly source_language: string;
    readonly target_language: string;
    readonly start_position: number;
}
export const subtitleAIOperations = {
    subtitleAIStatus: (): RequestSpec<ReturnType<typeof decodeAIStatus>> => ({ method: "GET", path: "/subtitles/ai/status", retry: "safe", decode: decodeAIStatus }),
    subtitleAIQuota: (): RequestSpec<ReturnType<typeof decodeAIQuota>> => ({ method: "GET", path: "/subtitles/ai/quota", retry: "safe", decode: decodeAIQuota }),
    subtitleAILanguages: (): RequestSpec<readonly string[]> => ({ method: "GET", path: "/settings/contract", retry: "safe", decode: decodeAILanguages }),
    createSubtitleAI: (body: SubtitleAIRequest): RequestSpec<ReturnType<typeof decodeAIJob>> => ({ method: "POST", path: "/subtitles/ai/translate", retry: "never", body: { ...body }, decode: decodeAIJob }),
    subtitleAIJob: (id: string): RequestSpec<ReturnType<typeof decodeAIJob>> => ({ method: "GET", path: `/subtitles/ai/jobs/${encodeURIComponent(id)}`, retry: "safe", decode: decodeAIJob }),
};
