# Change Account

Change Account lists saved accounts beside a server rail.
The profile menu and profile picker footer open it.
Settings > Server > Accounts opens account management; Accounts is not a Settings category on the Apple reference.
Account credentials stay in protected storage, bound to their original server URL and a device-made account ID.
The first launch copies the previous saved credential before making the new selection durable, without a network request.
An interrupted copy can retry from the retained legacy credential.
Expiry keeps the account row and asks the person to sign in again.
From the profile menu, Back moves from the accounts pane to the server rail, then returns to the selected browse tab with the menu closed.

## Reference and proof boundary

Reference: silo-apple `ffa6e5188c70664090a6dc9beb8c7cbbc3ce43e7`, including the account change in `54cf0f34a4528795c69609268e6ad693d85e50b7`.
Navigation was rechecked at `bbd1e470f0e1d3a99f486d0d7246d11ed1c97d55`: `TVMainTabView.swift:720,1284-1286` sets bar focus on return from Change Account, and `TVChangeAccountView.swift:64` returns from the pane to the rail first.
`tvOS/Navigation/TVMainTabView.swift:1384-1387` routes both account screens inside its tvOS guard.
`Screens/Accounts/ChangeAccountView.swift` is guarded by `#if !os(tvOS)` and is excluded from this port.
Apple TV has no three-choice Add sheet: account and server actions are direct, and the profile picker's Add opens profile creation.
The Change Account view uses the reference's 88-point headline, 520 by 88 rail rows and 760 by 128 account cards at the 1920-wide design viewport.
Inter substitutes for Apple's system font.
Tizen has no downloads, so download deletion copy is omitted.
Desktop Chromium tests establish app behavior only.
Same-state Apple TV and signed Samsung WGT captures remain required before merge.

Saved-server follow-up reference: silo-apple `2c03722c3eecee64c74272258190f13e3258d959`.
`TVChangeAccountView.swift:1` guards this screen with `#if os(tvOS)`.
Its Select action enters the account pane (`:275-279`), remembering the last card (`:92-94`); Back returns to the rail (`:281-285`).
The Samsung manual entry adds Back to saved servers and holds Back while connecting, matching the probe guard in `Screens/Auth/TVServerSetupView.swift:286-295`.
Discovery and nearby-phone setup remain outside this delivery.
Removal keeps its confirmation focused with a loading label until storage answers; failures offer Back without removing the failed saved entry.

## Native capture journeys

1. Sign in, open the avatar menu, choose Change Account, and capture the current card.
2. Move Left to the server rail, Up and Down between servers, then Right into the account cards; record focus and Back.
3. Capture Add server in the rail and Add an account in the pane.
4. Choose Add an account, sign in to a second account on the same server, and capture both account cards and profile counts.
5. Choose each account; capture the picker for several profiles and direct opening for one profile without a PIN.
6. Revoke one account in the test server, choose it, and capture SIGN IN AGAIN and the sign-in username.
7. Open Settings > Server > Accounts; capture account rows, Add an account and Remove Server.
8. Open Sign Out, capture Cancel focused, cancel it, then repeat and confirm; verify other accounts remain.
9. Restart with the server offline after migration and verify no account entry has disappeared.
10. With two saved servers, open Change Account, press Back to the rail, move Down to the other server and press Select; verify focus enters that server's account pane without a request on rail focus.
11. Move Down to Add an account, Left to the rail and Select; verify the last account-pane card regains focus.
12. Choose Add server, press Back on manual entry, and verify saved servers and credentials remain; repeat with an unreachable address and Back from its error.
13. In Settings > Server > Accounts, choose Remove Server, cancel, then confirm on a test server; record the pending label and focus, storage failure and retry, and verify the other server still opens.
14. Start Add an account, return to Change Account while its answer is delayed, open the saved account and release the delayed answer; verify the profile picker stays open.

Before capture, record the Apple installed build separately from the source revision and the Samsung candidate SHA, signed WGT hash, installed asset identity and actual capture dimensions.
Use the same saved servers, accounts, selected card, focus and scroll state on both platforms; mask all private server and account fields before sharing.
