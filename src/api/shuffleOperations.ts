import type { RequestSpec } from "./http.ts";
import { decodeShuffle, decodeShuffleCapability, type Shuffle, type ShuffleCapability } from "../contracts/v2/shuffle.ts";

export const shuffleOperations = {
    shuffleCapabilities: (): RequestSpec<ShuffleCapability> => ({ method: "GET", path: "/shuffles/capabilities", retry: "safe", decode: decodeShuffleCapability }),
    createShuffle: (id: string): RequestSpec<Shuffle> => ({ method: "POST", path: "/shuffles", retry: "never", body: { scope: { kind: "library", id } }, decode: decodeShuffle }),
    advanceShuffle: (id: string, fromContentId: string): RequestSpec<Shuffle> => ({ method: "POST", path: `/shuffles/${encodeURIComponent(id)}/advance`, retry: "safe", body: { from_content_id: fromContentId }, decode: decodeShuffle }),
};
