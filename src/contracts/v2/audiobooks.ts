import { boolean, object, string, optionalString, WireError } from "./wire.ts";

export const SHOW_AUDIOBOOKS_KEY = "nav.show_audiobooks";
export const AUDIOBOOK_SEEK_KEYS = ["player.audiobook_skip_back_seconds", "player.audiobook_skip_forward_seconds"] as const;
const END_MARGIN_SECONDS = 5;
export interface AudioPart { readonly fileId: string; readonly duration: number; readonly offset: number }
export interface AudioChapter { readonly title: string; readonly start: number }
export interface Audiobook {
    readonly id: string; readonly title: string; readonly overview: string; readonly poster: string | undefined;
    readonly position: number; readonly duration: number; readonly parts: readonly AudioPart[]; readonly chapters: readonly AudioChapter[];
    readonly finished?: boolean;
    readonly metadata?: AudioMetadata;
}
export interface AudioRelated { readonly id: string; readonly title: string; readonly poster: string | undefined; readonly index: number | undefined; readonly year: number | undefined }
export interface AudioMetadata {
    readonly authors: readonly string[]; readonly narrators: readonly string[]; readonly genres: readonly string[];
    readonly publisher: string | undefined; readonly year: number | undefined;
    readonly series: { readonly name: string | undefined; readonly entries: readonly AudioRelated[] } | undefined;
    readonly narrations: readonly AudioRelated[]; readonly alsoByAuthor: readonly AudioRelated[]; readonly similar: readonly AudioRelated[];
}
function names(value: unknown): string[] {
    return list(value ?? []).map(entry => typeof entry === "string" ? entry : string(object(entry, "person"), "name", "person"));
}
function related(value: unknown): AudioRelated[] {
    return list(value ?? []).map(value => {
        const item = object(value, "related");
        const number = (key: string): number | undefined => item[key] === undefined ? undefined : time(item[key], `related.${key}`);
        return { id: string(item, "content_id", "related"), title: names(item.narrators).join(", ") || string(item, "title", "related"), poster: optionalString(item, "poster_url", "related"), index: number("series_index"), year: number("year") };
    });
}
function time(value: unknown, path: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new WireError(path, "nonnegative finite seconds");
    return value;
}
function list(value: unknown): unknown[] {
    if (!Array.isArray(value)) throw new WireError("audiobook.items", "an array");
    return value;
}
export function decodeAudiobook(value: unknown): Audiobook {
    const raw = object(value, "audiobook");
    if (raw.type !== "audiobook") throw new WireError("audiobook.type", "audiobook");
    const versions = list(raw.versions ?? []).map(value => object(value, "version"))
        .filter(v => v.presentation_kind === "audiobook_part" || v.codec_audio !== undefined || v.duration !== undefined || v.chapters !== undefined)
        .sort((a, b) => Number(a.presentation_part_index ?? Number.MAX_SAFE_INTEGER) - Number(b.presentation_part_index ?? Number.MAX_SAFE_INTEGER) || String(a.file_id).localeCompare(String(b.file_id), "en", { numeric: true }));
    let offset = 0;
    const chapters: AudioChapter[] = [];
    const parts = versions.map(v => {
        const local = list(v.chapters ?? []).map(value => {
            const c = object(value, "chapter");
            return { title: optionalString(c, "title", "chapter"), start: time(c.start_seconds, "chapter.start"), end: c.end_seconds === undefined ? undefined : time(c.end_seconds, "chapter.end") };
        });
        const lastChapter = local.reduce<(typeof local)[number] | undefined>((last, chapter) => last === undefined || chapter.start >= last.start ? chapter : last, undefined);
        const endpoint = lastChapter?.end;
        const duration = v.duration === undefined || v.duration === 0 ? endpoint !== undefined && endpoint > (lastChapter?.start ?? 0) ? endpoint : 0 : time(v.duration, "version.duration");
        const part = { fileId: string(v, "file_id", "version"), offset, duration };
        for (const c of local) chapters.push({ title: c.title || `Chapter ${chapters.length + 1}`, start: offset + c.start });
        offset += duration;
        return part;
    });
    const extension = raw.audiobook === undefined ? undefined : object(raw.audiobook, "audiobook.extension");
    if (parts.length > 1 && parts.some(part => part.duration === 0)) throw new WireError("audiobook.parts.duration", "known part durations or chapter edges for a stitched timeline");
    const user = raw.user_data === undefined ? undefined : object(raw.user_data, "user_data");
    const series = extension?.series === undefined ? undefined : object(extension.series, "series");
    const discovery = extension?.related === undefined ? undefined : object(extension.related, "related");
    return { id: string(raw, "content_id", "audiobook"), title: string(raw, "title", "audiobook"), overview: optionalString(raw, "overview", "audiobook") ?? "", poster: optionalString(raw, "poster_url", "audiobook"),
        position: time(user?.position_seconds ?? 0, "user_data.position_seconds"), finished: user?.played === undefined ? false : boolean(user, "played", "user_data"),
        duration: Math.max(offset, time(extension?.total_duration_seconds ?? 0, "audiobook.duration")), parts, chapters: chapters.sort((a, b) => a.start - b.start),
        metadata: { authors: names(extension?.authors), narrators: names(extension?.narrators), genres: names(raw.genres), publisher: extension === undefined ? undefined : optionalString(extension, "publisher", "audiobook"), year: raw.year === undefined ? undefined : time(raw.year, "year"), series: series === undefined ? undefined : { name: optionalString(series, "name", "series"), entries: related(series.entries) }, narrations: related(extension?.other_narrations), alsoByAuthor: related(discovery?.also_by_author), similar: related(discovery?.similar) } };
}
export function audiobookResume(position: number, duration: number): number | undefined {
    return position > 30 && (duration <= 0 || position < duration - END_MARGIN_SECONDS) ? position : undefined;
}
export function audiobookPrimaryLabel(book: Audiobook): "Resume" | "Play Again" | "Play" {
    if (audiobookResume(book.position, book.duration) !== undefined) return "Resume";
    const finished = book.finished === true || (book.duration > 0 && book.position > 0 && book.position >= book.duration - END_MARGIN_SECONDS);
    return finished ? "Play Again" : "Play";
}
export function bookPosition(book: Audiobook, seconds: number): { fileId: string; startSeconds: number; index: number } {
    const target = Math.max(0, book.duration > 0 ? Math.min(seconds, book.duration) : seconds);
    let index = 0;
    book.parts.forEach((part, i) => { if (part.offset <= target) index = i; });
    const part = book.parts[index];
    if (part === undefined) throw new WireError("audiobook.parts", "a playable part");
    return { fileId: part.fileId, startSeconds: Math.max(0, target - part.offset), index };
}
export interface AudioPage { readonly items: readonly { id: string; title: string; poster?: string | undefined }[]; readonly cursor: string | undefined }
function cursor(raw: ReturnType<typeof object>): string | undefined {
    const page = object(raw.page, "page");
    return page.next_cursor === null ? undefined : optionalString(page, "next_cursor", "page");
}
export function decodeGroups(value: unknown): AudioPage {
    const raw = object(value, "groups");
    return { items: list(raw.items).map(value => { const g = object(value, "group"); const name = string(g, "name", "group"); return { id: name, title: name }; }), cursor: cursor(raw) };
}
export function decodeAudioPage(value: unknown): AudioPage {
    const raw = object(value, "books");
    return { items: list(raw.items).map(value => { const book = object(value, "book"); return { id: string(book, "content_id", "book"), title: string(book, "title", "book"), poster: optionalString(book, "poster_url", "book") }; }), cursor: cursor(raw) };
}
