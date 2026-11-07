import { integer, object, string, WireError } from "./wire.ts";

export interface PlayerChapter {
    readonly title: string;
    readonly seconds: number;
}

export function decodePlayerChapters(value: unknown, fileId: string): readonly PlayerChapter[] {
    const watch = object(value, "watch");
    if (!Array.isArray(watch.versions)) throw new WireError("watch.versions", "an array");
    const version = watch.versions.map(value => object(value, "watch.version")).find(value => value.file_id === fileId);
    if (version === undefined) throw new WireError("watch.version", "the effective file");
    if (version.chapters === undefined) return [];
    if (!Array.isArray(version.chapters)) throw new WireError("watch.chapters", "an array");
    return version.chapters.map(value => {
        const chapter = object(value, "watch.chapter");
        const index = integer(chapter, "index", "watch.chapter");
        const seconds = chapter.start_seconds;
        const end = chapter.end_seconds;
        if (index < 0 || typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || typeof end !== "number" || !Number.isFinite(end) || end < seconds) throw new WireError("watch.chapter", "a valid source-time interval");
        return { title: string(chapter, "title", "watch.chapter").trim() || `Chapter ${index + 1}`, seconds };
    }).sort((a, b) => a.seconds - b.seconds);
}
