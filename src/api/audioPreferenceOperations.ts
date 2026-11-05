import type { RequestSpec } from "./http.ts";
import type { AudioTrackInfo } from "../contracts/v2/playback.ts";
import { integer, object, string } from "../contracts/v2/wire.ts";

export interface AudioPreferencePick { readonly ordinal: number; readonly track: AudioTrackInfo; }

function signature(track: AudioTrackInfo) {
    return { language: track.language, title: track.rawTitle, embedded_title: track.embeddedTitle, codec: track.codec, layout: track.layout, channels: track.channels, default: track.isDefault };
}

export const audioPreferenceOperations = {
    read: (key: string): RequestSpec<{ ordinal: number; signature: unknown }> => ({
        method: "GET", path: `/audio-prefs/${encodeURIComponent(key)}`, retry: "safe", decode: value => {
            const row = object(value, "audio_preference");
            if (string(row, "series_id", "audio_preference") !== key) throw new Error("Audio preference identity mismatch");
            return { ordinal: integer(row, "audio_track_index", "audio_preference"), signature: row.track_signature };
        },
    }),
    matches: (actual: { ordinal: number; signature: unknown } | undefined, pick: AudioPreferencePick | undefined): boolean => {
        if (pick === undefined) return actual === undefined;
        if (actual?.ordinal !== pick.ordinal || actual.signature === null || typeof actual.signature !== "object") return false;
        const expected = JSON.parse(JSON.stringify(signature(pick.track))) as Record<string, unknown>;
        const received = actual.signature as Record<string, unknown>;
        return Object.keys(expected).every(key => received[key] === expected[key]);
    },
    write: (key: string, pick: AudioPreferencePick | undefined): RequestSpec<undefined> => ({
        method: pick === undefined ? "DELETE" : "PUT", path: `/audio-prefs/${encodeURIComponent(key)}`, retry: "never",
        ...(pick === undefined ? {} : { body: { audio_track_index: pick.ordinal, audio_language: pick.track.language ?? "", track_signature: signature(pick.track) } }), decode: () => undefined,
    }),
};
