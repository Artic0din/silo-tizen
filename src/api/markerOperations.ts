import type { RequestSpec } from "./http.ts";
import { decodeMarkers, type SkipMarker } from "../contracts/v2/markers.ts";

export const markerOperations = {
    fileMarkers: (fileId: string): RequestSpec<readonly SkipMarker[]> => ({
        method: "GET", path: `/markers/files/${encodeURIComponent(fileId)}`, retry: "safe",
        decode: value => decodeMarkers(value, fileId),
    }),
};
