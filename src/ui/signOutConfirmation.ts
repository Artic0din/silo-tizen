/**
 * Apple tvOS sign-out confirmation (`confirmSignOut` / `signOutMessage` in
 * `AppRouter+Accounts.swift`, silo-apple 2ef3a171). "this TV" stands in for
 * DeviceNoun "Apple TV". This TV does not keep downloads, so that sentence is omitted.
 */

/** True when this sign-out leaves the server with no saved account, so the TV removes it. An unreadable directory reports false. */
export function signOutRemovesServer(readAccounts: () => readonly { readonly baseUrl: string }[], baseUrl: string | undefined, signingOut = 1): boolean {
    try {
        return readAccounts().filter(row => row.baseUrl === baseUrl).length === signingOut;
    } catch {
        return false;
    }
}

export function signOutConfirmationCopy(accountName: string | undefined, serverName: string | undefined, removesServer: boolean): { readonly title: string; readonly message: string } {
    const account = accountName?.trim() || "this account";
    const server = serverName?.trim() || "this server";
    const message = removesServer
        ? `This account's profiles and settings leave this TV, and ${server} will be removed from it.`
        : "This account's profiles and settings leave this TV. The server stays saved, so you can sign in again.";
    return { title: `Sign out of ${account} on ${server}?`, message };
}
