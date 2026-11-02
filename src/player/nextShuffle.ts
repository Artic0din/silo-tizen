// A shuffle's next pick after its current item finishes (silo-apple 1a7ccee: SiloAPI.advanceShuffle, then
// the player opens the new current item). The server advances only while the finished item is still
// current, so a retried advance after a lost answer changes nothing.
import { operations } from "../api/operations.ts";
import { ApiError } from "../api/errors.ts";
import type { RequestSpec } from "../api/http.ts";
import { resumeSeconds } from "../ui/browseModel.ts";
import type { PlayRequest } from "./controller.ts";
import type { Shuffle } from "../contracts/v2/shuffle.ts";

type Read = <T>(spec: RequestSpec<T>) => Promise<T>;

/** Undefined when the shuffle has nothing else to play (its scope holds one playable item). */
export async function nextShuffle(read: Read, shuffleId: string, finishedContentId: string): Promise<PlayRequest | undefined> {
    const shuffle = await read(operations.advanceShuffle(shuffleId, finishedContentId));
    if (shuffle.id !== shuffleId) throw new ApiError({ kind: "invalid_response", path: "shuffle.id" });
    if (shuffle.current.id === finishedContentId) return undefined;
    return shufflePick(read, shuffle);
}

export async function shufflePick(read: Read, shuffle: Shuffle): Promise<PlayRequest | undefined> {
    const detail = await read(operations.watchDetail(shuffle.current.id));
    if (detail.id !== shuffle.current.id || (detail.type !== "movie" && detail.type !== "episode")) throw new ApiError({ kind: "invalid_response", path: "shuffle.current" });
    const version = detail.versions.find(candidate => candidate.fileId === detail.watch?.lastFileId) ?? detail.versions[0];
    if (version === undefined) return undefined;
    const resume = detail.watch?.played === false ? resumeSeconds(detail.watch.positionSeconds, version.durationSeconds || undefined) : undefined;
    return { contentId: detail.id, fileId: version.fileId, title: detail.title, startSeconds: resume ?? 0, shuffleId: shuffle.id, ...(detail.type === "episode" ? { episode: true as const } : {}) };
}
