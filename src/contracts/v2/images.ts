// Handwritten from the pinned v2 contract in SOURCE (`ImageCapabilities`). Only the fields that
// decide how a read sizes its artwork.
import { object, string, WireError } from "./wire.ts";

export interface ImageCapabilities {
    readonly state: string;
    /** The one-size query parameter (`image_size`). */
    readonly param: string;
    readonly sizes: readonly string[];
    /** Artwork slot → the query parameter that takes its width in device pixels; empty on older servers. */
    readonly slotWidthParams: Readonly<Record<string, string>>;
}

export function decodeImageCapabilities(value: unknown): ImageCapabilities {
    const path = "image_capabilities";
    const obj = object(value, path);
    const sizes = obj.sizes;
    if (!Array.isArray(sizes) || sizes.some(size => typeof size !== "string")) throw new WireError(`${path}.sizes`, "strings");
    const slots: Record<string, string> = {};
    if (obj.slot_width_params !== undefined) {
        for (const [slot, name] of Object.entries(object(obj.slot_width_params, `${path}.slot_width_params`))) {
            if (typeof name !== "string") throw new WireError(`${path}.slot_width_params.${slot}`, "a string");
            slots[slot] = name;
        }
    }
    return { state: string(obj, "state", path), param: string(obj, "param", path), sizes: sizes as string[], slotWidthParams: slots };
}

/** The widest slot width the server accepts (`maximum` on every `*_width` parameter). */
const MAX_SLOT_WIDTH = 7680;

/**
 * The `logo_width` entry for a logo drawn `points` CSS pixels wide, when the server takes per-slot
 * widths (silo-apple 1a7ccee `Shared/ImageSizeSelection.swift`). Nothing for an older or unknown server,
 * which keeps the response's one size.
 */
export function logoWidthQuery(capability: ImageCapabilities | undefined, points: number, scale: number): Record<string, string> {
    const name = capability?.state === "available" ? capability.slotWidthParams.logo : undefined;
    const pixels = Math.ceil(points * Math.max(scale, 1));
    if (name === undefined || name === "" || !Number.isFinite(pixels) || pixels < 1) return {};
    return { [name]: String(Math.min(pixels, MAX_SLOT_WIDTH)) };
}

/** ArtworkSurface.home: medium row posters plus the full-width hero and title-logo slots. */
export function homeArtworkQuery(capability: ImageCapabilities | undefined, scale: number): Record<string, string> {
    const query = logoWidthQuery(capability, 880, scale);
    if (capability?.state !== "available") return query;
    if (capability.sizes.includes("medium")) query[capability.param] = "medium";
    const name = capability.slotWidthParams.backdrop;
    const pixels = Math.ceil(1344 * Math.max(1, scale));
    if (name !== undefined && name !== "" && Number.isFinite(pixels)) query[name] = String(Math.min(pixels, MAX_SLOT_WIDTH));
    return query;
}
