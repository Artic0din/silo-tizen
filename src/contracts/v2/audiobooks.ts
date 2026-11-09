// Audiobook members of the Silo /api/v2 contract at the commit in ./SOURCE:
// getCatalogItem's `audiobook` extension and file parts, listAudiobookGroups and syncProgress.
// Resume rules and the whole-book timeline follow silo-apple AudiobookProgress.swift and
// AudiobookPlaybackContext.swift.
import type { UserLibrary } from "./catalog.ts";
import { boolean, integer, nonEmptyString, object, optionalString, string, WireError } from "./wire.ts";

/** `client_local` setting, default false: stored per profile on this device, never sent to the server. */
export const SHOW_AUDIOBOOKS_KEY = "nav.show_audiobooks";
export const SHOW_AUDIOBOOKS_DEFAULT = false;
/** Profile settings for the audiobook skip buttons (manifest revision 9 and newer). */
export const AUDIOBOOK_SEEK_KEYS = ["player.audiobook_skip_back_seconds", "player.audiobook_skip_forward_seconds"] as const;

export const AUDIOBOOK_GROUP_BY = ["author", "narrator", "series"] as const;
export type AudiobookGroupBy = (typeof AUDIOBOOK_GROUP_BY)[number];

/** Apple: resume only past a 30 s grace, and not within 5 s of a known end. */
export const RESUME_GRACE_SECONDS = 30;
export const END_MARGIN_SECONDS = 5;

/**
 * The libraries an Audiobooks destination may browse: audiobook libraries the profile has not hidden.
 * Servers with none must not gain an Audiobooks destination; whether the local opt-in is on is the caller's check.
 */
export function audiobookLibraries(libraries: readonly UserLibrary[], hiddenIds: readonly string[]): UserLibrary[] {
    return libraries.filter(library => library.type === "audiobooks" && !hiddenIds.includes(library.id));
}

type Obj = ReturnType<typeof object>;

function array(obj: Obj, key: string, path: string): unknown[] {
    const value = obj[key];
    if (!Array.isArray(value)) throw new WireError(`${path}.${key}`, "an array");
    return value;
}

/** Apple decodes absent lists as empty. */
function optionalArray(obj: Obj, key: string, path: string): unknown[] {
    return obj[key] === undefined ? [] : array(obj, key, path);
}

function stringList(obj: Obj, key: string, path: string, required = false): string[] {
    return (required ? array(obj, key, path) : optionalArray(obj, key, path)).map((value, index) => {
        if (typeof value !== "string") throw new WireError(`${path}.${key}[${index}]`, "a string");
        return value;
    });
}

function seconds(obj: Obj, key: string, path: string): number | undefined {
    const value = obj[key];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new WireError(`${path}.${key}`, "nonnegative finite seconds");
    return value;
}

function count(obj: Obj, key: string, path: string): number {
    const value = integer(obj, key, path);
    if (value < 0) throw new WireError(`${path}.${key}`, "a nonnegative integer");
    return value;
}

function optionalCount(obj: Obj, key: string, path: string): number | undefined {
    return obj[key] === undefined ? undefined : count(obj, key, path);
}

// --- getCatalogItem: the audiobook extension ---

export interface AudiobookPerson {
    readonly name: string;
    readonly personId: string | undefined;
    readonly photoUrl: string | undefined;
}
export interface AudiobookRelatedItem {
    readonly id: string;
    readonly title: string;
    readonly year: number | undefined;
    readonly seriesIndex: number | undefined;
    readonly posterUrl: string | undefined;
}
/** Another recording of the same book; the narrators are names, not people. */
export interface AudiobookNarration {
    readonly id: string;
    readonly title: string;
    readonly year: number | undefined;
    readonly narrators: readonly string[];
}
export interface AudiobookDetail {
    readonly authors: readonly AudiobookPerson[];
    readonly narrators: readonly AudiobookPerson[];
    readonly publisher: string | undefined;
    readonly totalDurationSeconds: number | undefined;
    readonly series: { readonly name: string | undefined; readonly entries: readonly AudiobookRelatedItem[] } | undefined;
    readonly otherNarrations: readonly AudiobookNarration[];
    readonly alsoByAuthor: readonly AudiobookRelatedItem[];
    readonly similar: readonly AudiobookRelatedItem[];
}

function decodePerson(value: unknown, path: string): AudiobookPerson {
    const obj = object(value, path);
    return { name: string(obj, "name", path), personId: optionalString(obj, "person_id", path), photoUrl: optionalString(obj, "photo_url", path) };
}

function decodeRelatedItem(value: unknown, path: string): AudiobookRelatedItem {
    const obj = object(value, path);
    return {
        id: string(obj, "content_id", path), title: string(obj, "title", path),
        year: obj.year === undefined ? undefined : integer(obj, "year", path),
        seriesIndex: obj.series_index === undefined ? undefined : integer(obj, "series_index", path),
        posterUrl: optionalString(obj, "poster_url", path),
    };
}

function decodeNarration(value: unknown, path: string): AudiobookNarration {
    const obj = object(value, path);
    return {
        id: string(obj, "content_id", path), title: string(obj, "title", path),
        year: obj.year === undefined ? undefined : integer(obj, "year", path),
        narrators: stringList(obj, "narrators", path),
    };
}

function decodeAudiobookDetail(value: unknown, path: string): AudiobookDetail {
    const obj = object(value, path);
    const series = obj.series === undefined ? undefined : object(obj.series, `${path}.series`);
    const related = obj.related === undefined ? undefined : object(obj.related, `${path}.related`);
    const items = (source: Obj | undefined, key: string, at: string): AudiobookRelatedItem[] =>
        source === undefined ? [] : optionalArray(source, key, at).map((entry, index) => decodeRelatedItem(entry, `${at}.${key}[${index}]`));
    return {
        authors: optionalArray(obj, "authors", path).map((entry, index) => decodePerson(entry, `${path}.authors[${index}]`)),
        narrators: optionalArray(obj, "narrators", path).map((entry, index) => decodePerson(entry, `${path}.narrators[${index}]`)),
        publisher: optionalString(obj, "publisher", path),
        totalDurationSeconds: seconds(obj, "total_duration_seconds", path),
        series: series === undefined ? undefined : { name: optionalString(series, "name", `${path}.series`), entries: items(series, "entries", `${path}.series`) },
        otherNarrations: optionalArray(obj, "other_narrations", path).map((entry, index) => decodeNarration(entry, `${path}.other_narrations[${index}]`)),
        alsoByAuthor: items(related, "also_by_author", `${path}.related`),
        similar: items(related, "similar", `${path}.related`),
    };
}

// --- getCatalogItem: parts and chapters on one whole-book timeline ---

/** One audio file, placed on the whole-book timeline. The playback API only knows files; `offset` exists only here. */
export interface AudiobookPart {
    readonly fileId: string;
    readonly duration: number;
    readonly offset: number;
}
export interface AudiobookChapter {
    readonly title: string;
    /** Whole-book seconds. */
    readonly start: number;
    readonly end: number | undefined;
    readonly partIndex: number;
}
export interface Audiobook {
    readonly id: string;
    readonly title: string;
    readonly overview: string | undefined;
    readonly year: number | undefined;
    readonly genres: readonly string[];
    readonly posterUrl: string | undefined;
    /** Whole-book resume position (`user_data.position_seconds`). */
    readonly position: number;
    /** `user_data.played`. */
    readonly played: boolean;
    /** Longest of the stitched parts and `audiobook.total_duration_seconds`; 0 when unknown. */
    readonly duration: number;
    readonly parts: readonly AudiobookPart[];
    readonly chapters: readonly AudiobookChapter[];
    readonly detail: AudiobookDetail;
}

interface DecodedVersion {
    readonly fileId: string;
    readonly order: number;
    readonly duration: number;
    readonly chapters: readonly { readonly title: string; readonly start: number; readonly end: number | undefined }[];
}

function decodeVersion(value: unknown, path: string): DecodedVersion | undefined {
    const obj = object(value, path);
    // Apple: a version is an audio part when it says so or carries audio facts.
    if (obj.presentation_kind !== "audiobook_part" && obj.codec_audio === undefined && obj.duration === undefined) return undefined;
    const chapters = optionalArray(obj, "chapters", path).map((entry, index) => {
        const chapterPath = `${path}.chapters[${index}]`;
        const chapter = object(entry, chapterPath);
        const start = seconds(chapter, "start_seconds", chapterPath);
        if (start === undefined) throw new WireError(`${chapterPath}.start_seconds`, "nonnegative finite seconds");
        return { title: optionalString(chapter, "title", chapterPath)?.trim() ?? "", start, end: seconds(chapter, "end_seconds", chapterPath) };
    });
    const declared = seconds(obj, "duration", path) ?? 0;
    // Some scanned parts carry chapters but no container duration. Only a chapter's end is evidence of length;
    // a start is not, so a part with neither stays unknown (0).
    const furthestEnd = chapters.reduce((furthest, chapter) => Math.max(furthest, chapter.end ?? 0), 0);
    return {
        fileId: nonEmptyString(obj, "file_id", path),
        order: obj.presentation_part_index === undefined ? Number.MAX_SAFE_INTEGER : integer(obj, "presentation_part_index", path),
        duration: declared > 0 ? declared : furthestEnd,
        chapters,
    };
}

export function decodeAudiobook(value: unknown): Audiobook {
    const path = "audiobook";
    const obj = object(value, path);
    const detail = obj.audiobook === undefined ? undefined : decodeAudiobookDetail(obj.audiobook, `${path}.audiobook`);
    if (obj.type !== "audiobook" && detail === undefined) throw new WireError(`${path}.type`, "an audiobook");

    const versions = optionalArray(obj, "versions", path)
        .map((entry, index) => decodeVersion(entry, `${path}.versions[${index}]`))
        .filter((version): version is DecodedVersion => version !== undefined)
        .sort((a, b) => a.order - b.order || a.fileId.localeCompare(b.fileId, "en", { numeric: true }));
    // A stitched timeline needs every part's length; a guessed length would move all later offsets.
    if (versions.length > 1 && versions.some(version => version.duration === 0)) {
        throw new WireError(`${path}.versions`, "a known duration or final chapter end for every part of a multi-part book");
    }

    let offset = 0;
    const parts: AudiobookPart[] = [];
    const chapters: { title: string; start: number; end: number | undefined; partIndex: number }[] = [];
    versions.forEach((version, partIndex) => {
        parts.push({ fileId: version.fileId, duration: version.duration, offset });
        for (const chapter of version.chapters) {
            chapters.push({ title: chapter.title, start: offset + chapter.start, end: chapter.end === undefined ? undefined : offset + chapter.end, partIndex });
        }
        offset += version.duration;
    });
    chapters.sort((a, b) => a.start - b.start);

    const user = obj.user_data === undefined ? undefined : object(obj.user_data, `${path}.user_data`);
    const duration = Math.max(offset, detail?.totalDurationSeconds ?? 0);
    const position = (user === undefined ? undefined : seconds(user, "position_seconds", `${path}.user_data`)) ?? 0;
    return {
        id: nonEmptyString(obj, "content_id", path),
        title: string(obj, "title", path),
        overview: optionalString(obj, "overview", path),
        year: obj.year === undefined ? undefined : integer(obj, "year", path),
        genres: stringList(obj, "genres", path),
        posterUrl: optionalString(obj, "poster_url", path),
        position: duration > 0 ? Math.min(position, duration) : position,
        played: user === undefined || user.played === undefined ? false : boolean(user, "played", `${path}.user_data`),
        duration,
        parts,
        // Apple names an untitled chapter by its place in the book.
        chapters: chapters.map((chapter, index) => ({ ...chapter, title: chapter.title === "" ? `Chapter ${index + 1}` : chapter.title })),
        detail: detail ?? { authors: [], narrators: [], publisher: undefined, totalDurationSeconds: undefined, series: undefined, otherNarrations: [], alsoByAuthor: [], similar: [] },
    };
}

// --- Progress rules (Apple AudiobookProgress) ---

/** The meaningful resume point, or undefined when Resume is suppressed. */
export function resumePosition(position: number, duration: number): number | undefined {
    if (!Number.isFinite(position) || position <= RESUME_GRACE_SECONDS) return undefined;
    if (Number.isFinite(duration) && duration > 0 && position >= duration - END_MARGIN_SECONDS) return undefined;
    return position;
}

/** The played flag, or a position within 5 s of a known end. */
export function isFinished(played: boolean, position: number, duration: number): boolean {
    if (played) return true;
    return duration > 0 && position > 0 && position >= duration - END_MARGIN_SECONDS;
}

/** The last chapter starting at or before `position`; a position before the first chapter still names chapter 0. */
export function currentChapterIndex(chapters: readonly AudiobookChapter[], position: number): number | undefined {
    if (chapters.length === 0) return undefined;
    let current = 0;
    chapters.forEach((chapter, index) => { if (chapter.start <= position) current = index; });
    return current;
}

/** Maps a whole-book position to the file to play and the seconds into that file. */
export function bookPosition(book: Audiobook, wholeBookSeconds: number): { readonly part: AudiobookPart; readonly partIndex: number; readonly localSeconds: number } {
    const target = Math.max(0, book.duration > 0 ? Math.min(wholeBookSeconds, book.duration) : wholeBookSeconds);
    let partIndex = 0;
    book.parts.forEach((part, index) => { if (part.offset <= target) partIndex = index; });
    const part = book.parts[partIndex];
    if (part === undefined) throw new WireError("audiobook.parts", "a playable part");
    // The server total can exceed the stitched parts; never seek past the end of the file.
    const local = Math.max(0, target - part.offset);
    return { part, partIndex, localSeconds: part.duration > 0 ? Math.min(local, part.duration) : local };
}

// --- listAudiobookGroups ---

export interface AudiobookGroup {
    /** Also the value of the `author`, `narrator` or `series` filter that lists this group's books. */
    readonly name: string;
    readonly itemCount: number;
    readonly totalDurationSeconds: number;
    readonly inProgressCount: number;
    readonly finishedCount: number;
    /** Up to four covers for a stack. */
    readonly posterUrls: readonly string[];
}
export interface AudiobookGroupPage {
    readonly items: readonly AudiobookGroup[];
    readonly nextCursor: string | undefined;
    readonly total: number;
    /** False when the request skipped the exact count. */
    readonly totalExact: boolean;
}

export function decodeAudiobookGroups(value: unknown): AudiobookGroupPage {
    const path = "audiobook_groups";
    const obj = object(value, path);
    const page = obj.page === undefined ? undefined : object(obj.page, `${path}.page`);
    const hasMore = page === undefined ? false : boolean(page, "has_more", `${path}.page`);
    const nextCursor = page !== undefined && hasMore ? string(page, "next_cursor", `${path}.page`) : undefined;
    if (nextCursor === "") throw new WireError(`${path}.page.next_cursor`, "a nonempty continuation");
    return {
        items: array(obj, "items", path).map((entry, index) => {
            const groupPath = `${path}.items[${index}]`;
            const group = object(entry, groupPath);
            return {
                name: string(group, "name", groupPath),
                itemCount: count(group, "item_count", groupPath),
                totalDurationSeconds: count(group, "total_duration_seconds", groupPath),
                inProgressCount: count(group, "in_progress_count", groupPath),
                finishedCount: count(group, "finished_count", groupPath),
                posterUrls: stringList(group, "poster_urls", groupPath, true),
            };
        }),
        nextCursor,
        total: count(obj, "total", path),
        totalExact: boolean(obj, "total_exact", path),
    };
}

// --- syncProgress: the only durable resume point for an audiobook ---

export interface ProgressSyncFailure {
    readonly type: string;
    readonly title: string;
    readonly status: number;
    readonly detail: string;
}
/** One request item's outcome; `failure` is absent when the server applied the write. */
export interface ProgressSyncResult {
    readonly index: number;
    readonly mediaItemId: string;
    readonly failure: ProgressSyncFailure | undefined;
}

/**
 * Decodes the always-200 batch answer for the request items, in request order.
 * Apple treats an answer that does not pair one result with each request item as unknown, never as success.
 */
export function decodeProgressSync(value: unknown, requestedIds: readonly string[]): ProgressSyncResult[] {
    const path = "progress_sync";
    const obj = object(value, path);
    const summary = object(obj.summary, `${path}.summary`);
    for (const key of ["total", "succeeded", "failed"]) count(summary, key, `${path}.summary`);
    const entries = array(obj, "items", path);
    if (entries.length !== requestedIds.length) throw new WireError(`${path}.items`, "one result for each written item");
    const results = entries.map((entry, position) => {
        const itemPath = `${path}.items[${position}]`;
        const item = object(entry, itemPath);
        const status = string(item, "status", itemPath);
        if (status !== "success" && status !== "failure") throw new WireError(`${itemPath}.status`, "success or failure");
        let failure: ProgressSyncFailure | undefined;
        if (status === "failure") {
            const failurePath = `${itemPath}.failure`;
            const raw = object(item.failure, failurePath);
            failure = { type: string(raw, "type", failurePath), title: string(raw, "title", failurePath), status: integer(raw, "status", failurePath), detail: string(raw, "detail", failurePath) };
        } else if (item.failure !== undefined) {
            throw new WireError(`${itemPath}.failure`, "no failure on a successful write");
        }
        return { index: count(item, "index", itemPath), mediaItemId: string(item, "media_item_id", itemPath), failure };
    }).sort((a, b) => a.index - b.index);
    results.forEach((result, index) => {
        if (result.index !== index || result.mediaItemId !== requestedIds[index]) throw new WireError(`${path}.items[${index}]`, "the result for the item written at that index");
    });
    return results;
}
