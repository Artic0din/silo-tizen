import type { RequestSpec } from "./http.ts";
import { decodeTrickplay, decodeTrickplayFiles, type TrickplayManifest } from "../contracts/v2/trickplay.ts";

export const trickplayOperations = {
    watchTrickplayFiles: (contentId: string, fileId: string): RequestSpec<readonly string[]> => ({
        method: "GET", path: `/watch/${encodeURIComponent(contentId)}?file_id=${encodeURIComponent(fileId)}`, retry: "safe", decode: decodeTrickplayFiles,
    }),
    watchTrickplay: (contentId: string, fileId: string, origin: string): RequestSpec<TrickplayManifest> => ({
        method: "GET", path: `/watch/${encodeURIComponent(contentId)}/trickplay?file_id=${encodeURIComponent(fileId)}`,
        retry: "safe", decode: (value) => decodeTrickplay(value, fileId, origin),
    }),
};
