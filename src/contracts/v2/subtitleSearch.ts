import { boolean, integer, object, string, WireError } from "./wire.ts";

export interface ProviderStatus { readonly available: boolean }

/** Search is usable only when the viewer is allowed, the state is available, and a provider is enabled. */
export function decodeProviderStatus(value: unknown): ProviderStatus {
    const row = object(value, "subtitle_providers");
    if (string(row, "revision", "subtitle_providers") === "") throw new WireError("subtitle_providers.revision", "a revision");
    const available = boolean(row, "allowed", "subtitle_providers") && string(row, "state", "subtitle_providers") === "available" && boolean(row, "enabled", "subtitle_providers");
    return { available };
}

export interface SearchResult {
    readonly key: string;
    readonly id: string;
    readonly provider: string;
    readonly language: string;
    readonly releaseName: string;
    readonly format: string;
    readonly score: number;
    readonly downloads: number;
    readonly hearingImpaired: boolean;
}

export interface SearchResponse { readonly results: readonly SearchResult[]; readonly warnings: readonly string[] }

export function decodeSearchResponse(value: unknown): SearchResponse {
    const body = object(value, "subtitle_search");
    if (!Array.isArray(body.results) || !Array.isArray(body.warnings) || body.warnings.some(warning => typeof warning !== "string")) throw new WireError("subtitle_search", "results and warnings");
    return {
        results: body.results.map(raw => {
            const row = object(raw, "subtitle_result");
            const id = string(row, "id", "subtitle_result");
            if (id === "") throw new WireError("subtitle_result.id", "a provider result id");
            const provider = typeof row.provider === "string" ? row.provider : "";
            return {
                key: `${provider}:${id}`, id, provider,
                language: typeof row.language === "string" ? row.language : "",
                releaseName: typeof row.release_name === "string" ? row.release_name : "",
                format: typeof row.format === "string" ? row.format : "",
                score: typeof row.score === "number" && Number.isFinite(row.score) ? row.score : 0,
                downloads: typeof row.downloads === "number" && Number.isInteger(row.downloads) ? row.downloads : 0,
                hearingImpaired: row.hearing_impaired === true,
            };
        }),
        warnings: body.warnings.filter((warning): warning is string => typeof warning === "string"),
    };
}

export interface StoredSubtitle { readonly id: string; readonly fileId: string }

export function decodeStoredSubtitle(value: unknown): StoredSubtitle {
    const row = object(object(value, "subtitle_download").subtitle, "subtitle");
    const id = string(row, "id", "subtitle");
    const fileId = string(row, "media_file_id", "subtitle");
    if (id === "" || fileId === "") throw new WireError("subtitle", "a stored subtitle for a file");
    return { id, fileId };
}

export function decodeLanguageCatalog(value: unknown): readonly { readonly code: string; readonly label?: string }[] {
    const options = object(object(object(value, "contract").option_sets, "option_sets").playback_subtitle_languages, "languages").options;
    if (!Array.isArray(options)) throw new WireError("languages", "an array");
    return options.flatMap(raw => {
        const row = object(raw, "language");
        const code = typeof row.value === "string" ? row.value : "";
        if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(code)) return [];
        return [{ code, ...(typeof row.label === "string" && row.label.trim() !== "" ? { label: row.label } : {}) }];
    });
}

export function decodePreferredLanguage(value: unknown): string | undefined {
    const body = object(value, "preferred_subtitle_language");
    integer(body, "revision", "preferred_subtitle_language");
    if (!Array.isArray(body.items)) throw new WireError("preferred_subtitle_language.items", "an array");
    const row = body.items.map(item => object(item, "preferred_subtitle_language.item")).find(item => item.key === "playback.subtitle_language");
    if (row === undefined) throw new WireError("preferred_subtitle_language", "playback.subtitle_language");
    if (row.value === null || row.value === "") return undefined;
    if (typeof row.value !== "string") throw new WireError("preferred_subtitle_language.value", "a language or null");
    return row.value;
}
