// Decoders for the Silo /api/v2 members this client consumes.
// Contract source: the server commit in ./SOURCE (openapi.json and fixtures/).
// Members the client does not read are ignored, so server additions stay compatible.
// Response enums are additive: unknown values decode to "unknown" rather than failing.

export class WireError extends Error {
    readonly path: string;

    constructor(path: string, expected: string) {
        // Never echo the offending value: it can be a credential.
        super(`Unexpected response from the server at ${path}: expected ${expected}`);
        this.name = "WireError";
        this.path = path;
    }
}

type WireObject = { readonly [key: string]: unknown };

function isObject(value: unknown): value is WireObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function object(value: unknown, path: string): WireObject {
    if (!isObject(value)) {
        throw new WireError(path, "an object");
    }
    return value;
}

export function string(obj: WireObject, key: string, path: string): string {
    const value = obj[key];
    if (typeof value !== "string") {
        throw new WireError(`${path}.${key}`, "a string");
    }
    return value;
}

export function nonEmptyString(obj: WireObject, key: string, path: string): string {
    const value = string(obj, key, path);
    if (value === "") {
        throw new WireError(`${path}.${key}`, "a non-empty string");
    }
    return value;
}

export function optionalString(obj: WireObject, key: string, path: string): string | undefined {
    return obj[key] === undefined ? undefined : string(obj, key, path);
}

export function boolean(obj: WireObject, key: string, path: string): boolean {
    const value = obj[key];
    if (typeof value !== "boolean") {
        throw new WireError(`${path}.${key}`, "a boolean");
    }
    return value;
}

export function integer(obj: WireObject, key: string, path: string): number {
    const value = obj[key];
    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new WireError(`${path}.${key}`, "an integer");
    }
    return value;
}

export function instant(obj: WireObject, key: string, path: string): number {
    const ms = Date.parse(string(obj, key, path));
    if (Number.isNaN(ms)) {
        throw new WireError(`${path}.${key}`, "an RFC 3339 instant");
    }
    return ms;
}

export function optionalInstant(obj: WireObject, key: string, path: string): number | undefined {
    return obj[key] === undefined || obj[key] === null ? undefined : instant(obj, key, path);
}

function additiveEnum<T extends string>(raw: string, known: readonly T[]): T | "unknown" {
    for (const value of known) {
        if (value === raw) {
            return value;
        }
    }
    return "unknown";
}

// --- Problem Details (RFC 9457) ---

export interface ProblemFieldError {
    readonly location: string;
    readonly code: string;
}

export interface Problem {
    /** Final segment of `type`, e.g. "session_expired". */
    readonly id: string;
    readonly status: number;
    readonly title: string;
    readonly instance: string;
    readonly errors: readonly ProblemFieldError[];
}

export function decodeProblem(value: unknown): Problem {
    const obj = object(value, "problem");
    const type = string(obj, "type", "problem");
    const segments = type.split("/");
    const id = segments[segments.length - 1];
    if (id === undefined || id === "") {
        throw new WireError("problem.type", "a problem type URI");
    }
    const errors: ProblemFieldError[] = [];
    const rawErrors = obj.errors;
    if (Array.isArray(rawErrors)) {
        rawErrors.forEach((entry: unknown, index: number) => {
            const item = object(entry, `problem.errors[${index}]`);
            errors.push({
                location: string(item, "location", `problem.errors[${index}]`),
                code: string(item, "code", `problem.errors[${index}]`),
            });
        });
    }
    return {
        id,
        status: integer(obj, "status", "problem"),
        title: string(obj, "title", "problem"),
        instance: optionalString(obj, "instance", "problem") ?? "",
        errors,
    };
}

// --- Discovery: getSystemInfo, getServerIdentity ---

export interface SystemInfo {
    readonly apiMajor: number;
    readonly serverVersion: string;
    readonly requestOrigin: string | undefined;
}

export function decodeSystemInfo(value: unknown): SystemInfo {
    const obj = object(value, "system_info");
    // links is required; the client calls fixed operation paths, so only its shape is checked.
    object(obj.links, "system_info.links");
    return {
        apiMajor: integer(obj, "api_major", "system_info"),
        serverVersion: string(obj, "server_version", "system_info"),
        requestOrigin: optionalString(obj, "request_origin", "system_info"),
    };
}

export function decodeServerIdentity(value: unknown): string {
    return nonEmptyString(object(value, "server_identity"), "server_id", "server_identity");
}

// --- Device sign-in ---

const CAPABILITY_STATES = ["available", "disabled", "not_configured", "unsupported"] as const;

export interface DeviceLoginCapability {
    readonly state: (typeof CAPABILITY_STATES)[number] | "unknown";
    readonly cancel: boolean;
    readonly openedSignal: boolean;
}

export function decodeDeviceLoginCapability(value: unknown): DeviceLoginCapability {
    const obj = object(value, "device_login_capability");
    return {
        state: additiveEnum(string(obj, "state", "device_login_capability"), CAPABILITY_STATES),
        cancel: boolean(obj, "cancel", "device_login_capability"),
        openedSignal: boolean(obj, "opened_signal", "device_login_capability"),
    };
}

export interface DeviceLoginStart {
    readonly deviceCode: string;
    /** Wire form `4821-7730`. */
    readonly userCode: string;
    readonly verificationUri: string;
    readonly verificationUriComplete: string;
    /** Server clock, epoch ms. */
    readonly expiresAt: number;
    readonly expiresInSeconds: number;
    readonly intervalSeconds: number;
    readonly temporary: boolean;
}

export function decodeDeviceLoginStart(value: unknown): DeviceLoginStart {
    const path = "device_login_start";
    const obj = object(value, path);
    return {
        deviceCode: nonEmptyString(obj, "device_code", path),
        userCode: nonEmptyString(obj, "user_code", path),
        verificationUri: nonEmptyString(obj, "verification_uri", path),
        verificationUriComplete: nonEmptyString(obj, "verification_uri_complete", path),
        expiresAt: instant(obj, "expires_at", path),
        expiresInSeconds: integer(obj, "expires_in", path),
        intervalSeconds: integer(obj, "interval", path),
        temporary: boolean(obj, "temporary", path),
    };
}

export interface AccountSummary {
    readonly id: string;
    readonly username: string;
    readonly passwordChangeRequired: boolean;
}

function decodeAccount(value: unknown, path: string): AccountSummary {
    const obj = object(value, path);
    return {
        id: nonEmptyString(obj, "id", path),
        username: string(obj, "username", path),
        passwordChangeRequired: boolean(obj, "password_change_required", path),
    };
}

export interface IssuedTokens {
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly expiresInSeconds: number;
}

function decodeTokens(obj: WireObject, path: string): IssuedTokens {
    return {
        accessToken: nonEmptyString(obj, "access_token", path),
        refreshToken: nonEmptyString(obj, "refresh_token", path),
        expiresInSeconds: integer(obj, "expires_in", path),
    };
}

const POLL_STATUSES = ["pending", "approved", "denied", "consumed", "canceled", "expired"] as const;

export type DeviceLoginPoll =
    | {
          readonly status: "pending";
          readonly pollAfterSeconds: number;
          readonly opened: boolean;
          /** Server clock, epoch ms; absent on servers before the opened signal. */
          readonly expiresAt: number | undefined;
      }
    | {
          readonly status: "approved";
          readonly tokens: IssuedTokens;
          readonly account: AccountSummary;
          readonly temporary: boolean;
      }
    | { readonly status: "denied" | "consumed" | "canceled" | "expired" | "unknown" };

export function decodeDeviceLoginPoll(value: unknown): DeviceLoginPoll {
    const path = "device_login_poll";
    const obj = object(value, path);
    const status = additiveEnum(string(obj, "status", path), POLL_STATUSES);
    if (status === "pending") {
        return {
            status,
            pollAfterSeconds: integer(obj, "poll_after", path),
            opened: boolean(obj, "opened", path),
            expiresAt: optionalInstant(obj, "expires_at", path),
        };
    }
    if (status === "approved") {
        const tokens = object(obj.tokens, `${path}.tokens`);
        return {
            status,
            tokens: decodeTokens(tokens, `${path}.tokens`),
            account: decodeAccount(tokens.user, `${path}.tokens.user`),
            temporary: boolean(obj, "temporary", path),
        };
    }
    return { status };
}

const CANCEL_STATUSES = ["canceled", "denied", "consumed", "expired"] as const;

export function decodeDeviceLoginCancel(value: unknown): (typeof CANCEL_STATUSES)[number] | "unknown" {
    return additiveEnum(string(object(value, "device_login_cancel"), "status", "device_login_cancel"), CANCEL_STATUSES);
}

// --- refreshSession ---

export function decodeRefreshedTokens(value: unknown): IssuedTokens {
    return decodeTokens(object(value, "refreshed_tokens"), "refreshed_tokens");
}

// --- Profiles ---

export interface ProfileSummary {
    readonly id: string;
    readonly name: string;
    readonly hasPin: boolean;
    readonly isPrimary: boolean;
    readonly isChild: boolean;
    /** uri-reference, relative to the server base when not absolute. */
    readonly avatarUrl: string | undefined;
}

export function decodeProfileCollection(value: unknown): ProfileSummary[] {
    const obj = object(value, "profiles");
    const items = obj.items;
    if (!Array.isArray(items)) {
        throw new WireError("profiles.items", "an array");
    }
    return items.map((entry: unknown, index: number) => {
        const path = `profiles.items[${index}]`;
        const item = object(entry, path);
        return {
            id: nonEmptyString(item, "id", path),
            name: string(item, "name", path),
            hasPin: boolean(item, "has_pin", path),
            isPrimary: boolean(item, "is_primary", path),
            isChild: boolean(item, "is_child", path),
            avatarUrl: optionalString(item, "avatar_url", path),
        };
    });
}

export type ProfileVerification =
    | { readonly valid: true; readonly profileToken: string; readonly expiresAt: number | undefined }
    | { readonly valid: false };

export function decodeProfileVerification(value: unknown): ProfileVerification {
    const path = "profile_verification";
    const obj = object(value, path);
    if (!boolean(obj, "valid", path)) {
        return { valid: false };
    }
    return {
        valid: true,
        profileToken: nonEmptyString(obj, "profile_token", path),
        expiresAt: optionalInstant(obj, "expires_at", path),
    };
}
