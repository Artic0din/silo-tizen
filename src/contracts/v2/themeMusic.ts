// Local theme songs: docs/catalog-api.md "Local theme songs, V2" in silo-server, and silo-apple
// APIv2ThemeSongModels.swift. Playback URLs are short-lived credentials: nothing here logs or keeps them.
import { WireError, boolean, nonEmptyString, object, optionalString, string } from "./wire.ts";

export interface ThemeSong {
    readonly id: string;
    readonly title?: string;
    readonly durationSeconds?: number;
}

/** One owner's ordered local theme audio (`themes` on the item detail). An empty set keeps the requested item's ID. */
export interface ThemeSongSet {
    readonly ownerId: string;
    readonly items: readonly ThemeSong[];
}

/** Themes are optional on the wire, so a malformed set reads as none and never fails the page. */
export function decodeThemeSongSet(value: unknown): ThemeSongSet | undefined {
    if (value === undefined) return undefined;
    try {
        const obj = object(value, "themes");
        if (!Array.isArray(obj.items)) throw new WireError("themes.items", "an array");
        const items = obj.items.map((raw, index): ThemeSong => {
            const path = `themes.items[${index}]`;
            const song = object(raw, path);
            const title = optionalString(song, "title", path);
            const seconds = song.duration_seconds;
            return {
                id: nonEmptyString(song, "id", path),
                ...(title === undefined ? {} : { title }),
                ...(typeof seconds === "number" && Number.isInteger(seconds) && seconds >= 0 ? { durationSeconds: seconds } : {}),
            };
        });
        return { ownerId: nonEmptyString(obj, "owner_id", "themes"), items };
    } catch (error) {
        if (error instanceof WireError) return undefined;
        throw error;
    }
}

/** `GET /catalog/themes/capabilities`. */
export function decodeThemeCapability(value: unknown): boolean {
    const obj = object(value, "theme_capability");
    const state = string(obj, "state", "theme_capability");
    return state === "available" && (obj.allowed === undefined || boolean(obj, "allowed", "theme_capability"));
}

export interface ThemeAudioFormat { readonly container: string; readonly audio_codec: string }

/** A grant: `delivery: "converted"` is progressive AAC in MP4 with no length or byte ranges. */
export interface ThemePlayback {
    readonly url: string;
    readonly converted: boolean;
}

export function decodeThemePlayback(value: unknown): ThemePlayback {
    const obj = object(value, "theme_playback");
    return { url: string(obj, "url", "theme_playback"), converted: optionalString(obj, "delivery", "theme_playback") === "converted" };
}

// Probed with canPlayType, as the web player does. mp4/aac is also the pair that lets the server convert at all.
const FORMAT_PROBES: readonly (ThemeAudioFormat & { readonly mime: string })[] = [
    { container: "mp3", audio_codec: "mp3", mime: "audio/mpeg" },
    { container: "mp4", audio_codec: "aac", mime: 'audio/mp4; codecs="mp4a.40.2"' },
    { container: "m4a", audio_codec: "aac", mime: 'audio/mp4; codecs="mp4a.40.2"' },
    { container: "m4a", audio_codec: "alac", mime: 'audio/mp4; codecs="alac"' },
    { container: "aac", audio_codec: "aac", mime: "audio/aac" },
    { container: "flac", audio_codec: "flac", mime: "audio/flac" },
    { container: "ogg", audio_codec: "vorbis", mime: 'audio/ogg; codecs="vorbis"' },
    { container: "ogg", audio_codec: "opus", mime: 'audio/ogg; codecs="opus"' },
    { container: "opus", audio_codec: "opus", mime: 'audio/ogg; codecs="opus"' },
    { container: "wav", audio_codec: "pcm", mime: 'audio/wav; codecs="1"' },
];

/** The theme formats this TV's Chromium decodes. Empty when it cannot say: the server then sends the original. */
export function themeAudioFormats(element: Pick<HTMLMediaElement, "canPlayType">): readonly ThemeAudioFormat[] {
    return FORMAT_PROBES.filter(probe => element.canPlayType(probe.mime) !== "").map(({ container, audio_codec }) => ({ container, audio_codec }));
}
