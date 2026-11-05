// Details-only native v2 operations; source and retry classifications match contracts/v2/SOURCE.
import type { RequestSpec } from "./http.ts";
import { decodeCatalogCollection, decodeCatalogPage, decodeResumePosition } from "../contracts/v2/catalog.ts";
import { decodeMembership, decodePerson, decodePeople, decodePersonalCapability } from "../contracts/v2/details.ts";
import type { BrowseScope, TextSearchScope } from "./operations.ts";
import { object, string, WireError } from "../contracts/v2/wire.ts";

export type PersonalAction = "watchlist" | "favorites" | "watched";

export const detailOperations = {
    people: (query: string, scope: BrowseScope | TextSearchScope): RequestSpec<ReturnType<typeof decodePeople>> => ({ method: "GET", path: `/catalog/people?q=${encodeURIComponent(query)}&media_scope=${scope}&limit=20`, retry: "safe", decode: decodePeople }),
    resumePosition: (id: string, fileId: string): RequestSpec<ReturnType<typeof decodeResumePosition>> => ({
        method: "GET", path: `/watch/${encodeURIComponent(id)}?file_id=${encodeURIComponent(fileId)}`, retry: "safe",
        decode: value => decodeResumePosition(value, id, fileId),
    }),
    person: (id: string): RequestSpec<ReturnType<typeof decodePerson>> => ({ method: "GET", path: `/catalog/people/${encodeURIComponent(id)}`, retry: "safe", decode: value => {
        const person = decodePerson(value);
        if (person.id !== id) throw new WireError("person.id", "the requested person");
        return person;
    } }),
    refreshPerson: (id: string): RequestSpec<undefined> => ({ method: "POST", path: `/catalog/people/${encodeURIComponent(id)}/refresh`, retry: "never", decode: value => {
        const receipt = object(value, "person_refresh");
        if (string(receipt, "status", "person_refresh") !== "queued" || string(receipt, "person_id", "person_refresh") !== id) throw new WireError("person_refresh", "a queued receipt for this person");
        return undefined;
    } }),
    // Unused by the app. Person works call personQuery() through queryCatalogItems.
    filmography: (id: string): RequestSpec<ReturnType<typeof decodeCatalogPage>> => ({ method: "GET", path: `/catalog?source=person&person_id=${encodeURIComponent(id)}&type=video&sort=-year&limit=24&image_size=small`, retry: "safe", decode: decodeCatalogPage }),
    similar: (id: string): RequestSpec<ReturnType<typeof decodeCatalogCollection>> => ({ method: "GET", path: `/recommendations/similar/${encodeURIComponent(id)}?limit=24&image_size=small`, retry: "safe", decode: decodeCatalogCollection }),
    personalCapability: (): RequestSpec<boolean> => ({ method: "GET", path: "/capabilities/personal-lists", retry: "safe", decode: decodePersonalCapability }),
    membership: (kind: "watchlist" | "favorites", id: string): RequestSpec<ReturnType<typeof decodeMembership>> => ({ method: "GET", path: `/${kind}/${encodeURIComponent(id)}/membership`, retry: "safe", decode: decodeMembership }),
    // Watched is non_retryable; list PUT/DELETE are natural_idempotent but UI repeats only on press.
    setPersonal: (kind: PersonalAction, id: string, enabled: boolean): RequestSpec<undefined> => ({ method: enabled ? kind === "watched" ? "POST" : "PUT" : "DELETE", path: `/${kind}/${encodeURIComponent(id)}`, retry: "never", decode: () => undefined }),
};
