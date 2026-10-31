// Details-only native v2 operations; source and retry classifications match contracts/v2/SOURCE.
import type { RequestSpec } from "./http.ts";
import { decodeCatalogPage, decodeResumePosition } from "../contracts/v2/catalog.ts";
import { decodeMembership, decodePerson, decodePersonalCapability } from "../contracts/v2/details.ts";

export type PersonalAction = "watchlist" | "favorites" | "watched";

export const detailOperations = {
    resumePosition: (id: string, fileId: string): RequestSpec<ReturnType<typeof decodeResumePosition>> => ({
        method: "GET", path: `/watch/${encodeURIComponent(id)}?file_id=${encodeURIComponent(fileId)}`, retry: "safe",
        decode: value => decodeResumePosition(value, id, fileId),
    }),
    person: (id: string): RequestSpec<ReturnType<typeof decodePerson>> => ({ method: "GET", path: `/catalog/people/${encodeURIComponent(id)}`, retry: "safe", decode: decodePerson }),
    // The preview and full query start independently; GET and POST cursors have different scopes.
    filmography: (id: string): RequestSpec<ReturnType<typeof decodeCatalogPage>> => ({ method: "GET", path: `/catalog?source=person&person_id=${encodeURIComponent(id)}&type=video&sort=-year&limit=24&image_size=small`, retry: "safe", decode: decodeCatalogPage }),
    similar: (id: string): RequestSpec<ReturnType<typeof decodeCatalogPage>> => ({ method: "GET", path: `/recommendations/similar/${encodeURIComponent(id)}?limit=24&image_size=small`, retry: "safe", decode: decodeCatalogPage }),
    personalCapability: (): RequestSpec<boolean> => ({ method: "GET", path: "/capabilities/personal-lists", retry: "safe", decode: decodePersonalCapability }),
    membership: (kind: "watchlist" | "favorites", id: string): RequestSpec<ReturnType<typeof decodeMembership>> => ({ method: "GET", path: `/${kind}/${encodeURIComponent(id)}/membership`, retry: "safe", decode: decodeMembership }),
    // Watched is non_retryable; list PUT/DELETE are natural_idempotent but UI repeats only on press.
    setPersonal: (kind: PersonalAction, id: string, enabled: boolean): RequestSpec<undefined> => ({ method: enabled ? kind === "watched" ? "POST" : "PUT" : "DELETE", path: `/${kind}/${encodeURIComponent(id)}`, retry: "never", decode: () => undefined }),
};
