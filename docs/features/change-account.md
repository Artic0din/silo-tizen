# Change Account

Change Account lists saved accounts beside a server rail.
The profile menu and profile picker footer open it.
Settings > Server > Accounts opens account management; Accounts is not a Settings category on the Apple reference.
Accounts uses its own Settings pane header, value-and-chevron rows, and red removal action.
Back returns to General in the Settings rail while the active profile remains valid.
Account credentials stay in protected storage, bound to their original server URL and a device-made account ID.
The first launch copies the previous saved credential before making the new selection durable, without a network request.
An interrupted copy can retry from the retained legacy credential.
Expiry keeps the account row and asks the person to sign in again.
From the profile menu, Back moves from the accounts pane to the server rail, then returns to the selected browse tab with the menu closed.
Cancelling preserves the active profile; choosing an account clears its PIN authority.
Signing in again to a saved account retires its previous session owner before saving replacement credentials.

## Reference and proof boundary

Reference: silo-apple `ffa6e5188c70664090a6dc9beb8c7cbbc3ce43e7`, including the account change in `54cf0f34a4528795c69609268e6ad693d85e50b7`.
Navigation was rechecked at `bbd1e470f0e1d3a99f486d0d7246d11ed1c97d55`: `TVMainTabView.swift:720,1284-1286` sets bar focus on return from Change Account, and `TVChangeAccountView.swift:64` returns from the pane to the rail first.
`tvOS/Navigation/TVMainTabView.swift:1384-1387` routes both account screens inside its tvOS guard.
`Screens/Accounts/ChangeAccountView.swift` is guarded by `#if !os(tvOS)` and is excluded from this port.
Apple TV has no three-choice Add sheet: account and server actions are direct, and the profile picker's Add opens profile creation.
The Change Account view uses the reference's 88-point headline, 520 by 88 rail rows and 760 by 128 account cards at the 1920-wide design viewport.
Inter substitutes for Apple's system font.
Pane rows, the 520px rail, plain Add server, gradient account tiles, and marquee scrim were rechecked against `bef81e8652a89c23a1c3cf07e312e9444baa6c4c`.
Offline recovery says "Back to profiles" while a saved account can open profiles, otherwise "Change account".
Tizen has no downloads, so download deletion copy is omitted.
Desktop Chromium tests establish app behavior only.
Same-state Apple TV and signed Samsung WGT captures remain required before merge.

## Native capture journeys

1. Sign in, open the avatar menu, choose Change Account, and capture the current card.
2. Move Left to the server rail, Up and Down between servers, then Right into the account cards; record focus and Back.
3. Capture Add server in the rail and Add an account in the pane.
4. Choose Add an account, sign in to a second account on the same server, and capture both account cards and profile counts.
5. Choose each account; capture the picker even for one profile without a PIN unless Remember was chosen.
6. Revoke one account in the test server, choose it, and capture SIGN IN AGAIN and the sign-in username.
7. Open Settings > Server > Accounts; capture account rows, Add an account and Remove Server.
8. Open Sign Out, capture Cancel focused, cancel it, then repeat and confirm; verify other accounts remain.
9. Restart with the server offline after migration and verify no account entry has disappeared.
