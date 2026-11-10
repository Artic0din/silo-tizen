# Watch Party

Apple's Watch Party is an experimental feature.
This client has the opt-in, the capability check, the hub and the lobby over HTTP.
The room socket and synchronized playback are not built (issue #54).

## Reference

Source revision: silo-apple `main` at `650a0b8a4a16601a9549d54d92d7c6d2f11e64eb` for the opt-in, gate and hub, and at `2a9a1b322573fe6476fd63cc7d707172ff0cc5a0` for the lobby, tvOS paths only.
This is not the installed Apple TV build.

| Behaviour | Apple source |
| --- | --- |
| Device opt-in, off by default | `Screens/Settings/ExperimentalFeatures.swift`, `tvOS/Screens/Settings/TVSettingsView.swift` (`EXTRA FEATURES`) |
| Entry gate | `Screens/WatchParty/WatchPartyEntry.swift` (`isAvailable`) |
| Capability check | `WatchParty/WatchPartySession.swift` (`loadCapabilities`, `supportsSynchronizedParty`, `enter`) |
| Profile menu row | `tvOS/Navigation/TVTopMenuBar.swift` (`TVProfileDropdown`) |
| Hub layout and copy | `Screens/WatchParty/WatchPartyHubView.swift` (`WatchPartyEntryView.tvLayout`), `WatchPartyComponents.swift` |
| Error text, busy state, ending a party | `WatchParty/WatchPartySession.swift` (`enter`, `endParty`), `Networking/APIv2/APIv2Client.swift` (`APIv2Error.localizedDescription`) |
| Lobby layout, copy and focus | `Screens/WatchParty/WatchPartyHubView.swift` (`WatchPartyLobbyView.tvLobby`, `WatchPartyHostControlsOverlay`, `WatchPartyEndConfirmation`), `WatchPartyComponents.swift` (`WatchPartyMetrics`, `WatchPartySeatsRow`, `WatchPartyCodePill`) |
| Lobby rules | `WatchParty/WatchPartyLobbyState.swift` (`WatchPartyLobbyPolicy`), `WatchPartySession.swift` (`canStartPlayback`, `select`, `startPlayback`, `stopPlayback`, `setMode`, `setPolicy`, `mutate`) |
| Invitation | `Screens/WatchParty/WatchPartyInviteView.swift`, `WatchPartyLobbyPolicy.inviteURL` |
| Picker | `Screens/WatchParty/WatchPartyMediaPicker.swift` (`WatchPartyMediaPicker`, `WatchPartyEpisodePicker`, `WatchPartyMediaChoiceView`) |

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

## Lobby

Create and join open the lobby from the room the create or join answered with.
It is a full-screen page with no top bar, as on tvOS: Back steps through its pages and leaves from the lobby itself.
Layout and copy are `WatchPartyLobbyView.tvLobby` at 1920×1080: the Watch Party title with the presence dot, the code pill and Options at the top right, the hero (eyebrow, title, facts, who chose it, overview) at the left, the seats at the bottom left and the buttons with an advisory hint at the bottom right.
The backdrop is the chosen title's backdrop, else its poster blurred; an episode's own still and description are never shown, because Apple hides them by the viewer's spoiler setting and this client does not read it.

### Room state

Apple's session never polls the room: it takes the room from each host change and, after that, from the socket.
There is no manual refresh in Apple, so this client has none.
Until the socket exists the lobby shows the room as the last answer left it, so presence, readiness and the host's picks made on another device do not update on their own.
A guest therefore sees the room as it was when they joined.
The presence dot reads the room: "Host away" for a guest when the host is not connected, "Open" for one member here and "N here" otherwise.

### Host

The primary button follows `WatchPartyLobbyPolicy.primaryAction`: Choose a title, Change title, Start for everyone, Return to playback, or Return everyone to lobby.
Change title sits beside Start for everyone.
Focus opens on the primary button, and on the code pill when there is none.
One change runs at a time and a second is ignored while it runs, so the controls stay enabled and focus is not thrown out.
A refused change shows the server's text in the warning banner and keeps the room.

- Choose a title opens the picker (below). Choosing stages the title with `PUT /staged-selection` in a host-pick lobby when the server has `staged_selection`, and otherwise, or once the party is playing, sets it with `PUT /selection`. The chosen title shows at once from the pick and is then read from the catalog.
- Start for everyone needs a staged title and `staged_selection`, as Apple's `canStartPlayback` does. It calls `POST /playback/start` and, when the room answers `playing` with a file, opens the existing player on that file from the room's anchor. There is no synchronization: the player plays on its own. Return to playback opens it again.
- Party options (Back closes it; it opens on Close): Who chooses (needs `selection_mode_switch` and a lobby), Playback controls (Host only or Guests can play and pause), Return everyone to lobby (needs `stop_playback` and a playing party), End party for everyone and Leave party. Rows stay enabled while a change runs.
- End party for everyone asks "End this party for everyone?" first, then closes the room with `DELETE` and returns to the hub with "This party has ended.". A refused close keeps the room and shows the reason.
- Leave party and Back from the lobby end the host's room, as before, so a started party is not left open.

### Guest

A guest sees the hero, the seats, the code and Options with Leave party and Close only; there is no Ready button and no action.
Leave party and Back exit the room screen and call nothing: a guest has no HTTP leave, and the socket close that leaves is not built.

### Picker

Choose a title opens the picker, which reads `GET /rooms/{id}/picker` with the room token: Continue Together, then On Your Watchlists.
A server without the `picker` flag shows the viewer's own watchlist instead.
Focus opens on the first title once the shelves arrive.
A series the group is part-way through goes to its next episode; any other series opens its seasons as tabs over the chosen season's episodes, with the first season that is not specials selected.
A confirmation page then shows the title and stages it with Choose for the party, or Play for everyone when the party is already playing.
A failed read shows the reason with Try Again.

### Invitation

The code pill and the Invite seat open the invitation: the code, "Join with this code", and Done.
When the room carries an invitation path that is a `/rooms/join` link with one token on this server (`WatchPartyLobbyPolicy.inviteURL`), a QR code for phones is drawn on the TV and "Or scan to open the invitation on a phone." shows.
Joining by pasted link is still refused, as the native contract joins by code.

## Not built

- The room socket: live presence, readiness, other members' changes, synchronized playback, and the socket close that is a guest's leave.
- Ready for guests, voting, suggestions and the host's Everyone votes ballot. A vote room shows a banner that voting is not available on this TV, and Who chooses can switch it back to Host chooses.
- The picker's search, Home's discovery rows, Recently Added shelves and each member's viewing history ("Who's seen it").
- Episode spoiler protection in the lobby and picker.
- Invitation links pasted into the code field.
- Rejoin recent, and the Return to Watch Party label.
- The Details and episode Watch Party action.
