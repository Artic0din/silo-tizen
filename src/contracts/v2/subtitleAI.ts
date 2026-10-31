import { boolean, integer, object, string } from "./wire.ts";

export interface SubtitleAIStatus { readonly translate: boolean; readonly transcribe: boolean }
export interface SubtitleAIQuota { readonly limited: boolean; readonly remaining: number; readonly period: string }
export interface SubtitleAIJob {
    readonly id: string;
    readonly fileId: string;
    readonly kind: string;
    readonly sourceIndex: number;
    readonly language: string;
    readonly status: string;
    readonly resultId: string | undefined;
    readonly error: string | undefined;
}
export function decodeAIStatus(value: unknown): SubtitleAIStatus {
    const row = object(value, "subtitle_ai_status");
    const allowed = string(row, "state", "subtitle_ai_status") === "available" && boolean(row, "allowed", "subtitle_ai_status");
    const translate = allowed && boolean(row, "enabled", "subtitle_ai_status");
    return { translate, transcribe: allowed && boolean(row, "transcribe_enabled", "subtitle_ai_status") };
}
export function decodeAIQuota(value: unknown): SubtitleAIQuota {
    const row = object(value, "quota");
    return { limited: boolean(row, "limited", "quota"), remaining: integer(row, "remaining", "quota"), period: string(row, "period", "quota") };
}
export function decodeAIJob(value: unknown): SubtitleAIJob {
    const row = object(object(value, "ai_job").job, "job");
    const result = row.result_subtitle_id;
    if (result !== null && result !== undefined && (typeof result !== "string" || result === "")) throw new Error("Invalid AI result identity");
    return { id: string(row, "id", "job"), fileId: string(row, "media_file_id", "job"), kind: string(row, "kind", "job"), sourceIndex: integer(row, "source_index", "job"), language: string(row, "target_language", "job"), status: string(row, "status", "job"), resultId: typeof result === "string" ? result : undefined, error: typeof row.error_message === "string" ? row.error_message : undefined };
}
export function decodeAILanguages(value: unknown): readonly string[] {
    const options = object(object(object(value, "contract").option_sets, "option_sets").playback_subtitle_languages, "languages").options;
    if (!Array.isArray(options)) throw new Error("Missing subtitle languages");
    return options.flatMap((raw: unknown) => {
        const row = object(raw, "language");
        return typeof row.value === "string" && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(row.value) ? [row.value] : [];
    });
}
