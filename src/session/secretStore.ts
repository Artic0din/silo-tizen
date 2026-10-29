// Protected storage for credentials. On a TV this is Tizen KeyManager, readable only by this
// package. Without it the client keeps credentials in memory for this run only; it never falls
// back to localStorage.
//
// KeyManager (Since 2.4): saveData(name, rawData, password?, success?, error?) is the only
// callback API; getData/removeData return or throw a WebAPIException (NotFoundError,
// VerificationError, TypeMismatchError, UnknownError). Since 3.0 the
// http://tizen.org/privilege/keymanager privilege must NOT be declared.

export interface TizenKeyManager {
    saveData(
        name: string,
        rawData: string,
        password: string | null,
        successCallback: () => void,
        errorCallback: (error: { readonly name: string }) => void,
    ): void;
    getData(dataAlias: { readonly name: string }, password?: string | null): string;
    removeData(dataAlias: { readonly name: string }): void;
}

export type SecretRead =
    | { readonly status: "found"; readonly value: string }
    | { readonly status: "missing" }
    | { readonly status: "failed" };

export type SecretRemove = "removed" | "missing" | "failed";

export interface SecretStore {
    /** False for the in-memory store: nothing survives an app restart. */
    readonly persistent: boolean;
    read(alias: string): Promise<SecretRead>;
    write(alias: string, value: string): Promise<boolean>;
    remove(alias: string): Promise<SecretRemove>;
}

function errorName(error: unknown): string {
    if (typeof error === "object" && error !== null && "name" in error) {
        const name: unknown = error.name;
        return typeof name === "string" ? name : "";
    }
    return "";
}

export function keyManagerStore(keyManager: TizenKeyManager): SecretStore {
    return {
        persistent: true,
        async read(alias) {
            try {
                return { status: "found", value: keyManager.getData({ name: alias }, null) };
            } catch (error) {
                return errorName(error) === "NotFoundError" ? { status: "missing" } : { status: "failed" };
            }
        },
        write(alias, value) {
            return new Promise<boolean>((resolve) => {
                try {
                    keyManager.saveData(alias, value, null, () => resolve(true), () => resolve(false));
                } catch {
                    resolve(false);
                }
            });
        },
        async remove(alias) {
            try {
                keyManager.removeData({ name: alias });
                return "removed";
            } catch (error) {
                return errorName(error) === "NotFoundError" ? "missing" : "failed";
            }
        },
    };
}

export function memoryStore(): SecretStore {
    const values = new Map<string, string>();
    return {
        persistent: false,
        async read(alias) {
            const value = values.get(alias);
            return value === undefined ? { status: "missing" } : { status: "found", value };
        },
        async write(alias, value) {
            values.set(alias, value);
            return true;
        },
        async remove(alias) {
            return values.delete(alias) ? "removed" : "missing";
        },
    };
}

function isKeyManager(value: unknown): value is TizenKeyManager {
    return (
        typeof value === "object" &&
        value !== null &&
        "saveData" in value &&
        typeof value.saveData === "function" &&
        "getData" in value &&
        typeof value.getData === "function" &&
        "removeData" in value &&
        typeof value.removeData === "function"
    );
}

/** `tizen.keymanager` when the platform provides it. */
export function findTizenKeyManager(scope: unknown = globalThis): TizenKeyManager | undefined {
    if (typeof scope !== "object" || scope === null || !("tizen" in scope)) {
        return undefined;
    }
    const tizen: unknown = scope.tizen;
    if (typeof tizen !== "object" || tizen === null || !("keymanager" in tizen)) {
        return undefined;
    }
    const keyManager: unknown = tizen.keymanager;
    return isKeyManager(keyManager) ? keyManager : undefined;
}

export function openSecretStore(keyManager: TizenKeyManager | undefined): SecretStore {
    return keyManager === undefined ? memoryStore() : keyManagerStore(keyManager);
}
