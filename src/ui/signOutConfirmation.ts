/**
 * Apple tvOS sign-out confirmation (`confirmSignOut` / `signOutMessage` in
 * `AppRouter+Accounts.swift`, silo-apple 2ef3a171). "this TV" stands in for
 * DeviceNoun "Apple TV". This TV does not keep downloads, so that sentence is omitted.
 */
export function signOutConfirmationCopy(accountName: string | undefined, serverName: string | undefined, removesServer: boolean): { readonly title: string; readonly message: string } {
    const account = accountName?.trim() || "this account";
    const server = serverName?.trim() || "this server";
    const message = removesServer
        ? `This account's profiles and settings leave this TV, and ${server} will be removed from it.`
        : "This account's profiles and settings leave this TV. The server stays saved, so you can sign in again.";
    return { title: `Sign out of ${account} on ${server}?`, message };
}
