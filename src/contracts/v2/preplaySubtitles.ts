import { boolean, integer, object, optionalString, string, WireError } from "./wire.ts";
import { decodeAudioTracks } from "./playback.ts";
import type { SubtitleTrack } from "./playback.ts";

export type SubtitleSignature = Pick<SubtitleTrack, "source" | "language" | "codec" | "label" | "forced" | "hearingImpaired">;
export interface CatalogSubtitleTrack extends SubtitleSignature {
    readonly selectionIndex: number | undefined;
    readonly externalPath: string;
}
export type SubtitleIntent = { readonly kind: "auto" } | { readonly kind: "off" } | { readonly kind: "track"; readonly signature: SubtitleSignature };
export interface SubtitlePreferences {
    readonly mode: "auto" | "always" | "off";
    readonly language: string | undefined;
    readonly audioLanguage: string | undefined;
    readonly showForced: boolean;
    readonly signature: SubtitleSignature | undefined;
}

export function decodeCatalogSubtitles(value: unknown, path: string): readonly CatalogSubtitleTrack[] {
    const version = object(value, path);
    if (version.subtitle_tracks === undefined) return [];
    if (!Array.isArray(version.subtitle_tracks)) throw new WireError(`${path}.subtitle_tracks`, "an array");
    return version.subtitle_tracks.map((value: unknown, ordinal: number) => {
        const name = `${path}.subtitle_tracks[${ordinal}]`;
        const track = object(value, name);
        const external = track.external === undefined ? false : boolean(track, "external", name);
        return { selectionIndex: (track.index === undefined ? (external ? undefined : 0) : integer(track, "index", name)), externalPath: external ? optionalString(track, "file_name", name) ?? "" : "", source: external ? "external" : "embedded", language: optionalString(track, "language", name), codec: optionalString(track, "codec", name), label: optionalString(track, "title", name) ?? optionalString(track, "embedded_title", name), forced: track.forced === undefined ? false : boolean(track, "forced", name), hearingImpaired: track.hearing_impaired === undefined ? false : boolean(track, "hearing_impaired", name) };
    });
}

export function decodeSubtitlePreferences(value: unknown, contentId: string, fileId: string, audioId: string | undefined): SubtitlePreferences {
    const body = object(value, "watch_subtitles");
    if (string(body, "content_id", "watch_subtitles") !== contentId || !Array.isArray(body.versions)) throw new WireError("watch_subtitles", "the requested item and its versions");
    const versions: unknown[] = body.versions;
    const version = versions.map(value => object(value, "watch_subtitles.version")).find(version => string(version, "file_id", "watch_subtitles.version") === fileId);
    if (version === undefined) throw new WireError("watch_subtitles.version", "the effective playback file");
    const audio = decodeAudioTracks(version, "watch_subtitles.version");
    const selected = audio.find((_track, index) => audioId === `file:${fileId}:audio:${index}`);
    const mode = optionalString(body, "effective_subtitle_mode", "watch_subtitles") ?? "auto";
    if (mode !== "auto" && mode !== "always" && mode !== "off") throw new WireError("watch_subtitles.mode", "auto, always or off");
    const raw = body.effective_subtitle_track_signature;
    let signature: SubtitleSignature | undefined;
    if (raw !== undefined && raw !== null) {
        const item = object(raw, "watch_subtitles.signature");
        const rawSource = optionalString(item, "source", "watch_subtitles.signature");
        const source = rawSource === "embedded" || rawSource === "external" || rawSource === "downloaded" ? rawSource : "unknown";
        signature = { source, language: optionalString(item, "language", "watch_subtitles.signature"), codec: optionalString(item, "codec", "watch_subtitles.signature"), label: optionalString(item, "label", "watch_subtitles.signature"), forced: item.forced === undefined ? false : boolean(item, "forced", "watch_subtitles.signature"), hearingImpaired: item.hearing_impaired === undefined ? false : boolean(item, "hearing_impaired", "watch_subtitles.signature") };
    }
    return { mode, language: optionalString(body, "effective_subtitle_language", "watch_subtitles"), audioLanguage: selected?.language, showForced: body.effective_show_forced_subtitles === undefined ? true : boolean(body, "effective_show_forced_subtitles", "watch_subtitles"), signature };
}
