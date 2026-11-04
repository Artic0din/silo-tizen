// Password capability documents. Members this client does not read are ignored.

import { object, string, WireError } from "./wire.ts";

type WireObject = { readonly [key: string]: unknown };

export interface PasswordCapability {
    readonly state: string;
    readonly allowed: boolean | undefined;
    readonly minimumPasswordLength: number | undefined;
    readonly maximumPasswordBytes: number | undefined;
}

export function decodePasswordCapability(value: unknown): PasswordCapability {
    const path = "password_capability";
    const obj = object(value, path);
    return {
        state: string(obj, "state", path),
        allowed: optionalBoolean(obj, "allowed", path),
        minimumPasswordLength: optionalInteger(obj, "minimum_password_length", path),
        maximumPasswordBytes: optionalInteger(obj, "maximum_password_bytes", path),
    };
}

export interface PasswordResetCapability {
    readonly state: string;
}

export function decodePasswordResetCapability(value: unknown): PasswordResetCapability {
    const path = "password_reset_capability";
    return { state: string(object(value, path), "state", path) };
}

function optionalBoolean(obj: WireObject, key: string, path: string): boolean | undefined {
    const value = obj[key];
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== "boolean") {
        throw new WireError(`${path}.${key}`, "a boolean");
    }
    return value;
}

function optionalInteger(obj: WireObject, key: string, path: string): number | undefined {
    const value = obj[key];
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new WireError(`${path}.${key}`, "an integer");
    }
    return value;
}
