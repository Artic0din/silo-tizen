import { boolean, nonEmptyString, object, string, WireError } from "./wire.ts";

export interface Shuffle { readonly id: string; readonly current: { readonly id: string }; readonly next: { readonly id: string } }
export interface ShuffleCapability { readonly usable: boolean; readonly scopeKinds: readonly string[] }

export function decodeShuffle(value: unknown): Shuffle {
    const body = object(value, "shuffle");
    return {
        id: nonEmptyString(body, "id", "shuffle"),
        current: { id: nonEmptyString(object(body.current, "shuffle.current"), "content_id", "shuffle.current") },
        next: { id: nonEmptyString(object(body.next, "shuffle.next"), "content_id", "shuffle.next") },
    };
}

export function decodeShuffleCapability(value: unknown): ShuffleCapability {
    const body = object(value, "shuffle_capability");
    const allowed = boolean(body, "allowed", "shuffle_capability"), state = string(body, "state", "shuffle_capability");
    if (!Array.isArray(body.scope_kinds) || body.scope_kinds.some(kind => typeof kind !== "string")) throw new WireError("shuffle_capability.scope_kinds", "an array of strings");
    return { usable: allowed && state === "available", scopeKinds: body.scope_kinds };
}
