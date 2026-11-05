import type { RequestSpec } from "./http.ts";
import type { CatalogSubtitleTrack } from "../contracts/v2/preplaySubtitles.ts";
import { integer, object, optionalString, string } from "../contracts/v2/wire.ts";

export type SubtitlePreferencePick = "off" | { readonly track: CatalogSubtitleTrack };
export interface SubtitlePreference { index: number; mode: string; path: string; signature: unknown; }

function signature(track: CatalogSubtitleTrack) {
    return { source: track.source, language: track.language, codec: track.codec, label: track.label, forced: track.forced, hearing_impaired: track.hearingImpaired };
}

export const subtitlePreferenceOperations = {
    read: (key: string): RequestSpec<SubtitlePreference> => ({
        method: "GET", path: `/subtitle-prefs/${encodeURIComponent(key)}`, retry: "safe", decode: value => {
            const row = object(value, "subtitle_preference");
            if (string(row, "series_id", "subtitle_preference") !== key) throw new Error("Subtitle preference identity mismatch");
            return { index: integer(row, "subtitle_track_index", "subtitle_preference"), mode: string(row, "subtitle_mode", "subtitle_preference"), path: optionalString(row, "external_subtitle_path", "subtitle_preference") ?? "", signature: row.track_signature };
        },
    }),
    matches: (actual: SubtitlePreference | undefined, pick: SubtitlePreferencePick | undefined): boolean => {
        if (pick === undefined) return actual === undefined;
        if (pick === "off") return actual?.mode === "off" && actual.index === -1 && actual.path === "" && actual.signature == null;
        if (actual?.mode !== "always" || actual.index !== (pick.track.selectionIndex ?? -1) || actual.path !== pick.track.externalPath || actual.signature === null || typeof actual.signature !== "object") return false;
        const expected = JSON.parse(JSON.stringify(signature(pick.track))) as Record<string, unknown>;
        const received = actual.signature as Record<string, unknown>;
        // The server omits zero-value signature strings when encoding a readback.
        return Object.keys(expected).every(key => (received[key] ?? "") === expected[key]);
    },
    write: (key: string, pick: SubtitlePreferencePick | undefined): RequestSpec<undefined> => ({
        method: pick === undefined ? "DELETE" : "PUT", path: `/subtitle-prefs/${encodeURIComponent(key)}`, retry: "never",
        ...(pick === undefined ? {} : { body: pick === "off" ? { subtitle_track_index: -1, subtitle_language: "", external_subtitle_path: "", subtitle_mode: "off" } : { subtitle_track_index: pick.track.selectionIndex ?? -1, subtitle_language: pick.track.language ?? "", external_subtitle_path: pick.track.externalPath, subtitle_mode: "always", track_signature: signature(pick.track) } }), decode: () => undefined,
    }),
};
