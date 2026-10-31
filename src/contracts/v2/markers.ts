import { object, nonEmptyString, WireError } from "./wire.ts";

export interface SkipMarker {
    readonly kind: "intro" | "recap" | "credits";
    readonly startSeconds: number;
    readonly endSeconds: number;
}

export function decodeMarkers(value: unknown, fileId: string): readonly SkipMarker[] {
    const obj = object(value, "markers");
    if (nonEmptyString(obj, "file_id", "markers") !== fileId) throw new WireError("markers.file_id", "the effective file");
    if (!Array.isArray(obj.marker_segments)) throw new WireError("markers.marker_segments", "an array");
    return obj.marker_segments.flatMap((entry: unknown): SkipMarker[] => {
        const segment = object(entry, "marker");
        const kind = segment.kind;
        if (kind !== "intro" && kind !== "recap" && kind !== "credits") return [];
        const start = segment.start_seconds;
        const end = segment.end_seconds;
        if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
            throw new WireError("marker.window", "finite increasing source seconds");
        }
        return [{ kind, startSeconds: start, endSeconds: end }];
    });
}

export function markerAt(markers: readonly SkipMarker[], seconds: number): SkipMarker | undefined {
    return markers.find(marker => seconds >= marker.startSeconds && seconds < marker.endSeconds);
}
