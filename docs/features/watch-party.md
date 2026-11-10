# Watch Party

Apple's Watch Party is an experimental feature.
This client has the opt-in, the capability check, the hub and a placeholder lobby.
The full lobby, the room socket and synchronized playback are not built (issue #54).

## Reference

Source revision: silo-apple `main` at `650a0b8a4a16601a9549d54d92d7c6d2f11e64eb`, tvOS paths only.
This is not the installed Apple TV build.

| Behaviour | Apple source |
| --- | --- |
| Device opt-in, off by default | `Screens/Settings/ExperimentalFeatures.swift`, `tvOS/Screens/Settings/TVSettingsView.swift` (`EXTRA FEATURES`) |
| Entry gate | `Screens/WatchParty/WatchPartyEntry.swift` (`isAvailable`) |
| Capability check | `WatchParty/WatchPartySession.swift` (`loadCapabilities`, `supportsSynchronizedParty`, `enter`) |
| Profile menu row | `tvOS/Navigation/TVTopMenuBar.swift` (`TVProfileDropdown`) |
| Hub layout and copy | `Screens/WatchParty/WatchPartyHubView.swift` (`WatchPartyEntryView.tvLayout`), `WatchPartyComponents.swift` |
| Error text, busy state, ending a party | `WatchParty/WatchPartySession.swift` (`enter`, `endParty`), `Networking/APIv2/APIv2Client.swift` (`APIv2Error.localizedDescription`) |

## Opt-in

Settings › Server ends with an EXTRA FEATURES header and a Watch Party row that reads Off or On.
The choice is stored on this TV (`silo.experimental.watchParty`) and is off until chosen.
Tizen has no debug build, so Apple's debug-default-on case does not apply.
`src/session/experimentalFeatures.ts` owns it.

## Gate

The profile menu shows Watch Party, after Requests and before Settings, only when the toggle is on and `supportsSynchronizedParty` holds (`src/ui/watchPartyHub.ts`):

- `GET /watch-together/capabilities` has `state: "available"`, `allowed: true`, `socket_protocol: "silo.room.v2"` and `connection_replaced: true`.
- `GET /playback/capabilities` has `state: "available"`, `allowed: true` and the features `watch_party_coordinator_v1` and `fixed_media_file_v1`.

The check runs when Browse opens, when Settings closes and when the hub opens or Check again is chosen.
Create and join read it again first, as Apple does.
A failed read keeps the last answer and shows "Could not check Watch Party support." with the reason.

## Hub

The hub is a root page under the bar, like the Requests hub: the tab underneath stays selected, Up reaches the bar, and Back steps to the bar and then to the tab.
Layout metrics are Apple's tvOS values at 1920×1080.
Focus order is Start a party, Start a party and let everyone vote, the code field, Join party and, when the server cannot host a party, Check again.
Start a party, the vote button and Join party are disabled while the server cannot host a party and while a create or join runs; Join party is also disabled until a code is typed.
Check again is disabled while a check runs.
A disabled button takes no focus: it leaves the focus order, and the page opens on Start a party, else Check again, else the code field.
Done on the Tizen keyboard moves focus from the code field to Join party.
A refused create or join shows the server's own text, as Apple does, including for 403 and 404.

## Placeholder lobby

Create and join show a lobby from the room the create or join answered with, as Apple does: the code in Apple's code pill and the members as seats, with Apple's seat states and the "n of m ready" summary.
Back as the host ends the room with `DELETE /watch-together/rooms/{id}`, so a started party is not left open (Apple refuses a new party while one is open).
Leaving the Watch Party page from the lobby does the same.
A room that already ended (409) is not an error; any other failure shows "Could not end the party." on the hub.
The next Start a party or Join party waits for a close still in flight and retries one that failed, and starts nothing while the close keeps failing.
A guest has no HTTP leave, so Back as a guest calls nothing.

## Not built

- Invitation links.
  The native contract joins by code, so a pasted link gets Apple's "This Watch Party invitation is invalid." message.
- Rejoin recent, and the Return to Watch Party label.
- The Invite seat, the room socket, title selection, voting, Ready, host controls and playback.
- The Details and episode Watch Party action.
