// Handwritten from the pinned v2 contract in SOURCE. Only fields displayed on Details.
import { boolean, integer, object, optionalString, string, WireError } from "./wire.ts";

export interface Credit {
    readonly id: string | undefined;
    readonly name: string;
    readonly role: string;
    readonly photoUrl: string | undefined;
}

export interface DetailExtras {
    readonly logoUrl: string | undefined;
    readonly cast: readonly Credit[];
    readonly crew: readonly Credit[];
    readonly ratings: readonly { readonly name: string; readonly display: string }[];
    readonly facts: readonly { readonly label: string; readonly value: string }[];
}

function entries(value: unknown, path: string): unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new WireError(path, "an array");
    return value;
}

export function decodeDetailExtras(value: unknown): DetailExtras {
    const obj = object(value, "item_detail");
    const credits = (key: "cast" | "crew"): Credit[] => entries(obj[key], `item_detail.${key}`).map((value, index) => {
        const path = `item_detail.${key}[${index}]`;
        const credit = object(value, path);
        if (key === "cast") integer(credit, "order", path);
        return { id: optionalString(credit, "person_id", path), name: string(credit, "name", path), role: string(credit, key === "cast" ? "character" : "job", path), photoUrl: optionalString(credit, "photo_url", path) };
    });
    const facts: { label: string; value: string }[] = [];
    for (const [key, label] of [["studios", "Studios"], ["countries", "Countries"]]) {
        if (key === undefined || label === undefined) continue;
        const values = entries(obj[key], `item_detail.${key}`).map((value) => {
            if (typeof value !== "string") throw new WireError(`item_detail.${key}`, "strings");
            return value;
        });
        if (values.length > 0) facts.push({ label, value: values.join(", ") });
    }
    const language = optionalString(obj, "original_language", "item_detail");
    if (language) facts.push({ label: "Original language", value: language });
    return {
        logoUrl: optionalString(obj, "logo_url", "item_detail"), cast: credits("cast"), crew: credits("crew"), facts,
        ratings: entries(obj.ratings, "item_detail.ratings").map((value, index) => {
            const path = `item_detail.ratings[${index}]`;
            const rating = object(value, path);
            return { name: string(rating, "name", path), display: string(rating, "display", path) };
        }),
    };
}

export interface Person {
    readonly id: string;
    readonly name: string;
    readonly bio: string | undefined;
    readonly photoUrl: string | undefined;
    readonly birthDate: string | undefined;
    readonly deathDate: string | undefined;
    readonly birthplace: string | undefined;
}

export function decodePerson(value: unknown): Person {
    const obj = object(value, "person");
    return { id: string(obj, "id", "person"), name: string(obj, "name", "person"), bio: optionalString(obj, "bio", "person"), photoUrl: optionalString(obj, "photo_url", "person"), birthDate: optionalString(obj, "birth_date", "person"), deathDate: optionalString(obj, "death_date", "person"), birthplace: optionalString(obj, "birthplace", "person") };
}

export function decodePersonalCapability(value: unknown): boolean {
    const obj = object(value, "personal_capability");
    const state = string(obj, "state", "personal_capability");
    const allowed = boolean(obj, "allowed", "personal_capability");
    const membership = boolean(obj, "membership_supported", "personal_capability");
    return state === "available" && allowed && membership;
}

export function decodeMembership(value: unknown): { readonly id: string; readonly member: boolean } {
    const obj = object(value, "membership");
    return { id: string(obj, "item_id", "membership"), member: boolean(obj, "is_member", "membership") };
}
