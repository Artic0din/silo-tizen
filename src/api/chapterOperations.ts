import type { RequestSpec } from "./http.ts";
import { decodePlayerChapters, type PlayerChapter } from "../contracts/v2/chapters.ts";

export function watchChapters(contentId: string, fileId: string): RequestSpec<readonly PlayerChapter[]> {
    return { method: "GET", path: `/watch/${encodeURIComponent(contentId)}?file_id=${encodeURIComponent(fileId)}`, retry: "safe", decode: value => decodePlayerChapters(value, fileId) };
}
