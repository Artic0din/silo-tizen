# Watch Party

Apple's Watch Party is an experimental feature.
This client has the opt-in, the capability check, the hub, the lobby, the room socket that keeps the lobby live, Ready, the vote room, the picker, the invitation QR and a Details action that starts a room.
Synchronized playback is not built, and the rest of what is missing is listed under [Not built](#not-built) (issue #54).
That work waits until playback recovery in #13 is accepted, and the feature stays off by default.

## Reference

Source revision: silo-apple `main` at `650a0b8a4a16601a9549d54d92d7c6d2f11e64eb` for the opt-in, gate and hub, and at `2a9a1b322573fe6476fd63cc7d707172ff0cc5a0` for the lobby, tvOS paths only.
This is not the installed Apple TV build.
What is still missing is specified against silo-apple `8655b06b077ab09a4604073ab3f9718fbfe66c6d` in the "Apple TV baseline" comment on #54.

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
| Room socket | `WatchPartySocket`, `WatchPartySession.startConnection`, `WatchPartyRoomState`, `WatchPartyClock` (named in `src/ui/watchPartySocket.ts`; no revision recorded) |
| Ballot | `WatchPartyVotes`, `WatchPartyLobbyPolicy.voteWinner`, `WatchPartyBallot` (named in `src/ui/watchPartyVotes.ts` and `watchPartyBallot.ts`; no revision recorded) |
| Invitation | `Screens/WatchParty/WatchPartyInviteView.swift`, `WatchPartyLobbyPolicy.inviteURL` |
| Picker | `Screens/WatchParty/WatchPartyMediaPicker.swift` (`WatchPartyMediaPicker`, `WatchPartyEpisodePicker`, `WatchPartyMediaChoiceView`) |

## Opt-in

Settings › Server ends with an EXTRA FEATURES header and a Watch Party row that reads Off or On.
The choice is stored on this TV (`silo.experimental.watchParty`) and is off until chosen.
Tizen has no debug build, so Apple's debug-default-on case does not apply.
`src/session/experimentalFeatures.ts` owns it.

## Gate

The profile menu shows Watch Party, after Requests and before Settings, only when the toggle is on and `supportsSynchronizedParty` holds (`src/ui/watchPartyApi.ts`):

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
The backdrop is the chosen title's backdrop, else its poster blurred; an episode's own still and description are never shown, because Apple hides them by the viewer's spoiler setting and the lobby does not apply that setting yet (`src/ui/watchPartyChoice.ts`).

### Room state

Apple's session never polls the room: it takes the room from each host change and, after that, from the socket.
There is no manual refresh in Apple, so this client has none.
Opening a room starts a `silo.room.v2` socket (`src/ui/watchPartySocket.ts`).
Each attempt reads the room, asks for a socket ticket and connects.
A snapshot, the host's pick and controls, readiness, who is here and the party ending reach every TV in the room as they happen.
An older snapshot never replaces a newer one, and an HTTP answer never replaces a snapshot that arrived after its request was sent.
A dropped socket reconnects after 1, 2, 4, 8 and then 15 seconds, and at once when it had stayed open for 30 seconds.
Pings on the open socket measure the offset to the server's clock (`RoomClock`); nothing reads it yet.
The room's `transport_command` frames are decoded and then ignored.
This TV sends only `lobby_ready` and `ping`.
The presence dot reads the socket: "Connecting", "Reconnecting", or once connected "Host away" for a guest when the host is not connected, "Open" for one member here and "N here" otherwise.
While reconnecting the lobby shows "Reconnecting to the party…", and a guest whose host is away sees that the party holds for two minutes.
Ready is a socket frame, and a frame sent while the socket is not open is dropped, as in Apple.
A vote is an HTTP call, but its card does nothing until the socket is connected and this profile's own vote has been read.
The party ends for this viewer, with the reason on the hub, when the server closes the room ("This party has ended."), when the room is gone or refuses this profile ("The party connection expired or is no longer available. Join again to continue."), or when the same profile joins from another device ("This profile joined the party on another device. Rejoin here to take over playback.").

### Host

The primary button follows `WatchPartyLobbyPolicy.primaryAction`: Choose a title (Change title once one is chosen but cannot be started), Start for everyone, or Return to playback.
A guest whose profile cannot see the playing title gets no button, as in Apple.
Return everyone to lobby is not a primary button yet: the lobby never reports that the title has ended, so the host finds it only in Party options.
Change title sits beside Start for everyone, and Choose something else beside Return to playback in a host-pick room.
Under the buttons an advisory hint says who has not marked ready ("You can still start.") or "Everyone's ready.".
Focus opens on the primary button, and on the code pill when there is none.
One change runs at a time and a second is ignored while it runs, so the controls stay enabled and focus is not thrown out.
A refused change shows the server's text in the warning banner and keeps the room.
A start or live selection whose answer is lost reads the room again (`GET /rooms/{id}`), because the contract marks both non-retryable and the server may have applied them, so it is not sent twice.
A start counts as done when the room is playing (in a vote room, on the winner), and a live selection when the room holds that title at a higher selection revision, since the same title at the same revision may be the one that was already playing.

- Choose a title opens the picker (below). Choosing stages the title with `PUT /staged-selection` in a host-pick lobby when the server has `staged_selection`, and otherwise, or once the party is playing, sets it with `PUT /selection`. The chosen title shows at once from the pick and is then read from the catalog.
- Start for everyone needs a staged title and `staged_selection`, as Apple's `canStartPlayback` does. It calls `POST /playback/start` and, when the room answers `playing` with a file, opens the existing player on that file from the room's anchor, pinned to that file so an alternate version cannot play. Choosing a title for a party that is already playing does the same. There is no synchronization: the player plays on its own. Return to playback opens it again.
- Party options (Back closes it; it opens on Close): Who chooses (needs `selection_mode_switch` and a lobby), Playback controls (Host only or Guests can play and pause), Return everyone to lobby (needs `stop_playback` and a playing party), End party for everyone and Leave party. Rows stay enabled while a change runs.
- End party for everyone asks "End this party for everyone?" first, then closes the room with `DELETE` and returns to the hub with "This party has ended.". A refused close keeps the room and shows the reason.
- Leave party, and Back from the lobby, leave this TV only: the socket closes and nothing else is called, as Apple's Leave party does.
  Apple's Back keeps the room open, which this client does not yet (see Not built).
  A host who leaves is away, and the server holds the party for them.
  End party for everyone is what closes the room.

### Vote room

A host who chooses Start a party and let everyone vote, or Who chooses set to Everyone votes, opens a vote lobby (`src/ui/watchPartyBallot.ts`, `watchPartyVotes.ts`).
The hero asks "What are we watching?", with "Everyone votes. You start the leader." for the host and "Tap a title to vote. {host} starts the winner." for a guest.
Each suggestion is a poster card with its live vote count, an outline on the leader and a tick on the ones this profile voted for.
Select votes or takes the vote back.
The cards, the tick and the leader come from the socket's `suggestions_update`; this profile's own votes come from a read over HTTP after each connection, and a card reads "Loading your vote" until then.
A suggestion's poster is drawn only when it is on this server.
The dashed Suggest a title card, and the Suggest button, open the picker, and choosing a title there adds it to the ballot.
The leader is the most votes, a tie going to the earlier suggestion; nobody voted is no leader.
The host's primary button is Start {leader}, disabled until the ballot has been read on this connection, and Suggest a title while nobody has voted.

### Guest

A guest sees the hero, the seats, the code and Options with Leave party and Close only.
When the server takes lobby readiness (`lobby_ready`), a guest in the lobby has I'm ready, which becomes You're ready with "tap to undo", and every seat shows it.
Ready is sent over the socket and does nothing while the socket is not connected.
A guest has no HTTP leave: Leave party and Back close the socket and return to the hub.

### Picker

Choose a title opens the picker, which reads `GET /rooms/{id}/picker` with the room token: Continue Together, then On Your Watchlists.
A server without the `picker` flag shows the viewer's own watchlist instead.
Focus opens on the first title once the shelves arrive.
A series the group is part-way through goes to its next episode; any other series opens its seasons as tabs over the chosen season's episodes, with the first season that is not specials selected.
A confirmation page then shows the title and stages it with Choose for the party, or Play for everyone when the party is already playing; in a vote room it puts the title on the ballot instead.
A failed read shows the reason with Try Again, under any shelves an earlier read left.

### Invitation

The code pill and the Invite seat open the invitation: the code, "Join with this code", and Done.
When the room carries an invitation path that is a `/rooms/join` link with one token on this server (`WatchPartyLobbyPolicy.inviteURL`), a QR code for phones is drawn on the TV and "Or scan to open the invitation on a phone." shows.
Joining by pasted link is still refused with "This Watch Party invitation is invalid.", because the code field only joins by code.

## Details

With the switch on and the server able to host a party, More on a movie, episode or series page ends with Watch Party (`src/ui/browseDetails.ts`).
A series offers the episode its hero shows.
It pushes the Watch Party page over the title, creates a host-pick room and chooses that title (`openWatchParty` in `src/ui/browse.ts`).
When the server has `staged_selection` the title is staged in the lobby.
Otherwise it is sent as a live selection, and if the room answers `playing` the existing player opens on its file (`WatchPartyHub.stage`).
Back from the lobby leaves the room and shows the entry page, and Back again returns to Details.
The title is chosen by content id alone: a version the viewer picked is not passed.

## Not built

Everything here waits until playback recovery in #13 is accepted, as #54 requires, and is specified in the "Apple TV baseline" comment on #54.
Release access stays closed until a mixed-room check, Samsung with Apple TV or web on a physical TV, shows play, pause, a host seek and a 10 second network drop staying within 1 second.

- Synchronized playback: a command from the room never runs, and this TV sends no `attach_session`, `transport_request`, `state_report`, `ready` or `buffering` frame, although the codecs exist (`src/contracts/v2/watchTogether.ts`).
  Start for everyone and Return to playback open the existing player at the room's anchor, so members drift apart.
- Party chrome in the player: the syncing and reconnecting capsule, the room panel over playback with Return to playback, the end-of-title Return everyone to lobby, and the fallback when the party's file is gone (`watch_party_source_fallback_v1` and `POST /rooms/{id}/source-fallback`; the gate does not read that feature).
  Seats show a member as buffering or syncing when the room says so, but this TV never reports either.
- A party that outlives its page: Back from the lobby leaves the room, the hub ends with its page, and the profile menu always reads Watch Party, never Return to Watch Party.
  The player opens only on the TV that pressed Start or Choose; a guest presses Return to playback.
- Joining and rejoining: invitation links pasted into the code field (`POST /watch-together/join` takes a code only; the `join_token` body is not sent), and Rejoin recent, with its stored room, Continue here and the ending messages.
- Suggestions: a host-pick lobby has no suggestions strip, so nothing in it lets a guest suggest a title, and the ballot cards in a vote room have no long-press menu (Start this one, Remove suggestion; `DELETE` of a suggestion has no operation).
- The picker: Search (the chrome has Close only), Home's discovery rows, the Recently Added shelves, and each member's viewing history ("Who's seen it"; the `member_state` capability is decoded, but `POST /rooms/{id}/member-state` has no operation).
- Episode spoiler protection: the lobby's and the picker's episode stills and overviews are dropped unconditionally instead of following the viewer's episode spoiler settings (`src/ui/episodeSpoilers.ts`).
- Details and cards: Suggest to Party and adding to an open room from Details, the version the viewer picked, and a Watch Party row in the episode card's long-press menu (`src/ui/cardActions.ts`).
