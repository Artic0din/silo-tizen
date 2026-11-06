import { object, optionalString, string } from "./wire.ts";

export function decodeTrailerRefresh(value: unknown): { status: string; nextAllowedAt: string | undefined } {
    const body = object(value, "trailer_refresh");
    return { status: string(body, "status", "trailer_refresh"), nextAllowedAt: optionalString(body, "next_allowed_at", "trailer_refresh") };
}
