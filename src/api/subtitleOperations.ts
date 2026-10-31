import type { RequestSpec } from "./http.ts";
import { decodeAppearance, type SubtitleAppearance } from "../contracts/v2/subtitles.ts";
import type { SubtitleTrack } from "../contracts/v2/playback.ts";

export const subtitleOperations = {
    subtitleAppearance: (profile: string): RequestSpec<SubtitleAppearance> => ({ method: "GET", path: "/settings/subtitle-appearance/effective", retry: "safe", decode: value => decodeAppearance(value, profile) }),
    subtitleSync: (): RequestSpec<number> => ({ method: "GET", path: "/settings/values/effective?keys=player.subtitle_sync_ms", retry: "safe", decode: value => {
        if (typeof value !== "object" || value === null || !("items" in value) || !Array.isArray(value.items)) throw new Error("Invalid subtitle timing");
        const rows: unknown[] = value.items;
        const row = rows.find((row): row is { key: string; value: unknown } => typeof row === "object" && row !== null && "key" in row && row.key === "player.subtitle_sync_ms" && "value" in row);
        if (row === undefined || typeof row.value !== "number" || !Number.isInteger(row.value) || Math.abs(row.value) > 10000) throw new Error("Invalid subtitle timing");
        return row.value;
    } }),
    saveSeriesSubtitle: (series: string, track: SubtitleTrack | undefined): RequestSpec<undefined> => ({ method: "PUT", path: `/subtitle-prefs/${encodeURIComponent(series)}`, retry: "never", body: { subtitle_track_index: track?.combinedIndex ?? -1, subtitle_language: track?.language ?? "", subtitle_mode: track === undefined ? "off" : "always", ...(track === undefined ? { show_forced_subtitles: false } : { track_signature: { source: track.source, codec: track.codec, language: track.language, label: track.label, forced: track.forced, hearing_impaired: track.hearingImpaired } }) }, decode: () => undefined }),
};
