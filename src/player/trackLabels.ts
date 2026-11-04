// Language-first audio and subtitle rows, and the quality line with its bitrate.
// Ported (AGPL-3.0-or-later) from silo-apple 9723df007baa8e933f5615cc14b13e99a6ee1ea1:
// Screens/Player/TrackLabels.swift, PlayerTrack.swift, SubtitleDisplayOrder.swift,
// PlaybackPrefsResolver.titleIndicatesHearingImpaired, ApplePlaybackQuality.formatBitrate
// and labelWithBitrate. Display names use Intl where Apple uses Locale.en_US_POSIX.

export interface TrackRow {
    readonly label: string;
    readonly detail?: string;
}

const ISO639: Readonly<Record<string, string>> = {
    ara: "ar", ben: "bn", bul: "bg", chi: "zh", zho: "zh", cze: "cs", ces: "cs", dan: "da", dut: "nl", nld: "nl",
    eng: "en", est: "et", fin: "fi", fra: "fr", fre: "fr", ger: "de", deu: "de", gre: "el", ell: "el", heb: "he",
    hin: "hi", hun: "hu", ice: "is", isl: "is", ind: "id", ita: "it", jpn: "ja", kor: "ko", lav: "lv", lit: "lt",
    may: "ms", msa: "ms", nor: "no", nob: "no", nno: "no", pol: "pl", por: "pt", rum: "ro", ron: "ro", rus: "ru",
    slo: "sk", slk: "sk", slv: "sl", spa: "es", swe: "sv", tha: "th", tur: "tr", ukr: "uk", vie: "vi",
};

const AUDIO_TECHNICAL = new RegExp(
    "(?<![0-9])(?<![0-9]\\.)(?:\\d\\.\\d(?:\\.\\d)?(?:\\s?ch)?|\\d+\\s?ch(?:annels?)?)(?![0-9a-z])"
        + "|(?<![0-9a-z.])\\d+(?:[.,]\\d+)?[\\s-]?(?:[km]?(?:bps|b/s|bit/s)|k?hz|bits?)(?![a-z])"
        + "|\\b(?:atsc|a/52[ab]?|he-?aac(?:[\\s-]?v2)?|aac[\\s-]?lc|aac\\s+latm|e?-?ac-?3|ec-?3|true[\\s-]?hd|aac|flac|alac"
        + "|opus|vorbis|mp[23]|pcm\\s+(?:un)?signed\\s+[\\d|]+-bit\\s+(?:little|big)-endian(?:\\s+for\\s+blu-ray\\s+media)?"
        + "|l?pcm(?:_[a-z0-9]+)?|dd\\+?|ddp|stereo|mono|surround|dolby|digital(?:\\s*plus)?|dca|mlp"
        + "|advanced\\s+audio\\s+coding(?:\\s+latm\\s+syntax)?|coherent\\s+acoustics|(?:free|apple)\\s+lossless\\s+audio\\s+codec"
        + "|interactive\\s+audio\\s+codec|mpeg\\s+audio\\s+layer\\s+\\d|meridian\\s+lossless\\s+packing"
        + "|dts(?:-?hd)?(?:[\\s:._-]*(?:ma|master\\s+audio|hra?|high\\s+resolution(?:\\s+audio)?|es|x))?)(?![a-z])",
    "gi",
);
const JOINT_OBJECT = /\bjoc\b/gi;
const EMPTY_BRACKETS = /\([^\p{L}\p{N}]*\)|\[[^\p{L}\p{N}]*\]/gu;
const WHITESPACE = /\s+/g;
const WHOLE_BRACKETED = /^[(\[]([^()[\]]+)[)\]]$/;
const DEMUXER_TRACK = /^(?:audio\s+)?track\s*\d+$/i;
const WORD = /\p{L}+/gu;
const RELEASE_MARKERS = ["2160p", "1080p", "720p", "480p", "remux", "bluray", "blu-ray", "web-dl", "webrip", "hdtv", "x264", "x265", "h.264", "h.265", "hevc", "10-bit", "hdr10", ".mkv", ".mp4"];
const TRIM_EDGES = /^[\s\-–—_:/|,.+·•@]+|[\s\-–—_:/|,.+·•@]+$/g;

function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function canonicalLanguageKey(code: string | undefined): string | undefined {
    const trimmed = code?.trim();
    if (trimmed === undefined || trimmed === "") return undefined;
    const primary = trimmed.toLowerCase().replaceAll("_", "-").split("-")[0] ?? "";
    if (primary === "" || primary === "und") return undefined;
    return ISO639[primary] ?? primary;
}

/** English name for a language tag, or undefined when it is missing or undetermined. */
export function languageName(value: string | undefined): string | undefined {
    const text = nonEmpty(value);
    if (text === undefined) return undefined;
    const primary = text.toLowerCase().replaceAll("_", "-").split("-")[0] ?? "";
    if (primary === "und") return undefined;
    if (primary.length > 3) return capitalize(text);
    const key = canonicalLanguageKey(text);
    if (key === undefined) return text.toUpperCase();
    try {
        const name = new Intl.DisplayNames(["en"], { type: "language" }).of(key);
        if (name !== undefined && name.toLowerCase() !== key) return capitalize(name);
    } catch { /* an unknown tag keeps its code */ }
    return key.toUpperCase();
}

function capitalize(value: string): string {
    return value.replace(/\p{L}+/gu, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}

export function audioCodec(codec: string | undefined): string | undefined {
    const lowered = codec?.toLowerCase();
    if (lowered === undefined || lowered === "") return undefined;
    if (lowered.includes("eac3") || lowered.includes("e-ac-3") || lowered.includes("ec-3")) return "EAC3";
    if (lowered.includes("ac3") || lowered.includes("ac-3")) return "AC3";
    if (lowered.includes("aac")) return "AAC";
    if (lowered.includes("mp3")) return "MP3";
    if (lowered.includes("truehd")) return "TrueHD";
    if (lowered.includes("dts")) return "DTS";
    if (lowered.includes("flac")) return "FLAC";
    return lowered.toUpperCase();
}

export function subtitleCodec(codec: string | undefined): string | undefined {
    const lowered = codec?.toLowerCase();
    if (lowered === undefined || lowered === "") return undefined;
    if (lowered === "srt" || lowered.includes("subrip")) return "SRT";
    if (lowered.includes("ass")) return "ASS";
    if (lowered.includes("ssa")) return "SSA";
    if (lowered === "vtt" || lowered.includes("webvtt")) return "WebVTT";
    if (lowered === "sup" || lowered.includes("pgs") || lowered.includes("hdmv")) return "PGS";
    if (lowered.includes("dvd") || lowered.includes("vobsub")) return "VobSub";
    if (lowered.includes("mov_text") || lowered.includes("tx3g")) return "TX3G";
    return lowered.toUpperCase();
}

/** "Atmos", "7.1", "5.1", "Stereo", "Mono", else a channel count. */
export function audioLayout(channels: number | undefined): string | undefined {
    switch (channels) {
        case 1: return "Mono";
        case 2: return "Stereo";
        case 6: return "5.1";
        case 8: return "7.1";
        case undefined: return undefined;
        default: return channels > 0 ? `${channels}ch` : undefined;
    }
}

function replacePattern(pattern: RegExp, text: string, replacement = " "): string {
    return text.replace(pattern, () => replacement);
}

function removingWords(text: string, matches: (word: string) => boolean): string {
    const found = [...text.matchAll(WORD)];
    let result = text;
    for (const word of found.reverse()) {
        if (word.index === undefined || !matches(word[0])) continue;
        result = `${result.slice(0, word.index)}${" ".repeat(word[0].length)}${result.slice(word.index + word[0].length)}`;
    }
    return result;
}

function looksLikeReleaseName(title: string): boolean {
    const lowered = title.toLowerCase();
    return RELEASE_MARKERS.some((marker) => lowered.includes(marker));
}

function displayTitle(title: string): string {
    const trimmed = title.trim();
    switch (trimmed.toLowerCase()) {
        case "sdh": return "SDH";
        case "cc": return "CC";
        case "srt":
        case "subrip": return "SubRip";
        case "webvtt":
        case "vtt": return "WebVTT";
        default: return trimmed;
    }
}

/** Title text that is not already the language, codec, or channel layout. */
export function audioTitle(title: string | undefined, language: string | undefined): string | undefined {
    const text = nonEmpty(title);
    if (text === undefined || looksLikeReleaseName(text)) return undefined;
    let remainder = replacePattern(AUDIO_TECHNICAL, text);
    const saysAtmos = /atmos/i.test(remainder);
    remainder = replacePattern(JOINT_OBJECT, remainder, saysAtmos ? " " : "Atmos");
    const languageLabel = languageName(language);
    if (languageLabel !== undefined) {
        remainder = removingWords(remainder, (word) => word.localeCompare(languageLabel, undefined, { sensitivity: "accent" }) === 0 || ((word.length === 2 || word.length === 3) && word === word.toUpperCase() && languageName(word) === languageLabel));
    }
    remainder = replacePattern(EMPTY_BRACKETS, remainder);
    remainder = replacePattern(WHITESPACE, remainder).replace(TRIM_EDGES, "");
    const bracketed = WHOLE_BRACKETED.exec(remainder);
    if (bracketed?.[1] !== undefined) remainder = bracketed[1].trim();
    if ([...remainder].filter((character) => /\p{L}/u.test(character)).length <= 1 || DEMUXER_TRACK.test(remainder)) return undefined;
    return displayTitle(remainder);
}

function titleIndicatesHearingImpaired(title: string | undefined): boolean {
    const text = nonEmpty(title);
    if (text === undefined) return false;
    const lowered = text.toLowerCase();
    if (lowered.includes("hearing impaired") || lowered.includes("closed caption")) return true;
    const tokens = lowered.split(/[^\p{L}\p{N}]+/u);
    return tokens.includes("cc") || tokens.includes("sdh");
}

function subtitleTitle(title: string | undefined, language: string | undefined, codec: string | undefined, showsHearingImpaired: boolean): string | undefined {
    const text = nonEmpty(title);
    if (text === undefined || looksLikeReleaseName(text)) return undefined;
    const lowered = text.toLowerCase();
    const formats = new Set(["ass", "ssa", "srt", "subrip", "pgs", "sup", "sub", "vtt", "webvtt", "vobsub", "dvdsub", "mov_text"]);
    const flags = new Set(["forced", "sdh", "cc", "hearing impaired"]);
    if (showsHearingImpaired) flags.add("hi");
    if (formats.has(lowered) || flags.has(lowered) || lowered === "subtitle" || lowered === "subtitles") return undefined;
    const name = languageName(language)?.toLowerCase();
    if (name !== undefined && lowered === name) return undefined;
    const code = nonEmpty(language)?.toLowerCase();
    if (code !== undefined && lowered === code) return undefined;
    const rawCodec = nonEmpty(codec)?.toLowerCase();
    if (rawCodec !== undefined && (lowered === rawCodec || lowered === subtitleCodec(codec)?.toLowerCase())) return undefined;
    return displayTitle(text);
}

function row(name: string, parts: readonly (string | undefined)[]): TrackRow {
    const detail = parts.filter((part): part is string => part !== undefined && part !== "").join(" · ");
    return detail === "" ? { label: name } : { label: name, detail };
}

export function audioRow(track: { readonly language: string | undefined; readonly codec: string | undefined; readonly channels: number | undefined; readonly title: string | undefined; readonly isDefault: boolean }, ordinal: number): TrackRow {
    const title = audioTitle(track.title, track.language);
    const name = languageName(track.language) ?? title ?? `Track ${ordinal + 1}`;
    const qualifier = title !== undefined && title.localeCompare(name, undefined, { sensitivity: "accent" }) !== 0 ? title : undefined;
    return row(name, [qualifier, audioCodec(track.codec), audioLayout(track.channels), track.isDefault ? "Default" : undefined]);
}

export function subtitleRow(entry: { readonly label: string | undefined; readonly language: string | undefined; readonly codec?: string | undefined; readonly forced: boolean; readonly hearingImpaired: boolean; readonly source: string }, ordinal: number): TrackRow {
    const showsHearingImpaired = entry.hearingImpaired || titleIndicatesHearingImpaired(entry.label);
    const showsForced = entry.forced || (entry.label?.toLowerCase().includes("forced") ?? false);
    const format = subtitleCodec(entry.codec);
    const title = subtitleTitle(entry.label, entry.language, entry.codec, showsHearingImpaired);
    const name = languageName(entry.language) ?? title ?? format ?? `Subtitles ${ordinal + 1}`;
    const qualifier = title !== undefined && title.localeCompare(name, undefined, { sensitivity: "accent" }) !== 0 ? title : undefined;
    const formatPill = format !== undefined && format !== name ? format : undefined;
    const external = entry.source === "external" || entry.source === "downloaded" ? "External" : undefined;
    return row(name, [qualifier, formatPill, showsForced ? "Forced" : undefined, showsHearingImpaired ? "SDH" : undefined, external]);
}

/** Apple's in-player quality line: the server's name plus `(6 Mbps)` when a cap is known. */
export function qualityMenuLabel(quality: { readonly label: string; readonly displayName: string | undefined; readonly bitrateKbps: number | undefined }): string {
    const name = quality.displayName !== undefined && quality.displayName.trim() !== "" ? quality.displayName : quality.label;
    return quality.bitrateKbps !== undefined && quality.bitrateKbps > 0 ? `${name} (${formatBitrate(quality.bitrateKbps)})` : name;
}

export function formatBitrate(kbps: number): string {
    if (kbps >= 1000) {
        const mbps = kbps / 1000;
        return Math.trunc(mbps) === mbps ? `${mbps} Mbps` : `${mbps.toFixed(1)} Mbps`;
    }
    return `${kbps} kbps`;
}
