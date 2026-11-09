// A shuffle's next pick after its current item finishes (silo-apple 1a7ccee: SiloAPI.advanceShuffle, then
// the player opens the new current item). The server advances only while the finished item is still
// current, so a retried advance after a lost answer changes nothing.
import { operations } from "../api/operations.ts";
import { ApiError } from "../api/errors.ts";
import type { RequestSpec } from "../api/http.ts";
import { startVersion } from "../contracts/v2/versions.ts";
import type { PlayRequest } from "./controller.ts";
import type { Shuffle } from "../contracts/v2/shuffle.ts";

type Read = <T>(spec: RequestSpec<T>) => Promise<T>;

/** Undefined when the shuffle has nothing else to play (its scope holds one playable item). */
export async function nextShuffle(read: Read, shuffleId: string, finishedContentId: string, quality?: string): Promise<PlayRequest | undefined> {
    const shuffle = await read(operations.advanceShuffle(shuffleId, finishedContentId));
    if (shuffle.id !== shuffleId) throw new ApiError({ kind: "invalid_response", path: "shuffle.id" });
    if (shuffle.current.id === finishedContentId) return undefined;
    return shufflePick(read, shuffle, quality);
}

// Apple starts every pick from its beginning, not from saved progress (silo-apple 27cf4a2 PlayerViewModel.loadShufflePick).
export async function shufflePick(read: Read, shuffle: Shuffle, quality?: string): Promise<PlayRequest | undefined> {
    const detail = await read(operations.watchDetail(shuffle.current.id));
    if (detail.id !== shuffle.current.id || (detail.type !== "movie" && detail.type !== "episode")) throw new ApiError({ kind: "invalid_response", path: "shuffle.current" });
    const preferred = startVersion(detail.versions, detail.watch?.lastFileId, quality);
    const version = firstPart(preferred, detail.versions) ?? preferred;
    if (version === undefined) return undefined;
    return { contentId: detail.id, fileId: version.fileId, title: detail.title, startSeconds: 0, shuffleId: shuffle.id, ...(detail.type === "episode" ? { episode: true as const, seasonNumber: detail.seasonNumber, episodeNumber: detail.episodeNumber } : {}) };
}

/** The part after the playing file in its group, played before the shuffle advances (Apple nextShufflePart + playShufflePart). */
export async function nextShufflePart(read: Read, request: PlayRequest, playingFileId: string): Promise<PlayRequest | undefined> {
    const detail = await read(operations.watchDetail(request.contentId));
    if (detail.id !== request.contentId) throw new ApiError({ kind: "invalid_response", path: "shuffle.part" });
    const playing = detail.versions.find(version => version.fileId === playingFileId);
    const next = playing === undefined ? undefined : partAfter(playing, detail.versions);
    if (next === undefined) return undefined;
    // Apple loads the part fresh: no carried-over audio, subtitle or saved position.
    const { audioTrackId: _audio, subtitle: _subtitle, subtitleTracks: _tracks, subtitlePreferences: _preferences, watch: _watch, ...kept } = request;
    return { ...kept, fileId: next.fileId, startSeconds: 0 };
}

interface Part {
    readonly resolution?: string;
    readonly presentationGroupKey: string | undefined;
    readonly presentationPartIndex: number | undefined;
}

// Apple PlayerMultipartPolicy: a part of an empty or absent group key is no part; the same resolution wins, else the first candidate.
function part<T extends Part>(index: number, like: T, versions: readonly T[]): T | undefined {
    const group = like.presentationGroupKey;
    if (group === undefined || group === "") return undefined;
    const candidates = versions.filter(candidate => candidate.presentationGroupKey === group && candidate.presentationPartIndex === index);
    return candidates.find(candidate => candidate.resolution === like.resolution) ?? candidates[0];
}

function firstPart<T extends Part>(selected: T | undefined, versions: readonly T[]): T | undefined {
    const index = selected?.presentationPartIndex;
    return selected === undefined || index === undefined || index <= 1 ? undefined : part(1, selected, versions);
}

function partAfter<T extends Part>(current: T, versions: readonly T[]): T | undefined {
    const index = current.presentationPartIndex;
    return index === undefined ? undefined : part(index + 1, current, versions);
}
