# Silo /api/v2 contract (vendored)

`SOURCE` holds the exact `silo-server` commit these files come from.
`fixtures/` holds the response bodies this client consumes, copied unchanged from
`contracts/api/v2/fixtures/` at that commit, except `settings_contract_ok.json` and `settings_rows_216.json`,
which contain the selected Settings manifest subsets consumed by this client, and `request_status_ok.json`.
`request_status_ok.json` is copied unchanged from [`request_status_ok.json`](https://github.com/Silo-Server/silo-server/blob/6e8c68d036fd32c4ec7fe1d328f8286d4a164e60/contracts/api/v2/fixtures/request_status_ok.json) at `6e8c68d036fd32c4ec7fe1d328f8286d4a164e60`, which is newer than `SOURCE` and is the fixture that carries `remove_failed_supported`.
The sync script keeps that file until `SOURCE` includes it and its name moves into `SELECTED`.
That documented exception selects seven definitions unchanged from `contracts/settings/v1/manifest.json` at `SOURCE` (v1, revision 24): `ui.disabled_library_ids`, `playback.audio_language`, `playback.preferred_quality`, `playback.max_bitrate_kbps`, `player.video_skip_back_seconds`, `player.video_skip_forward_seconds` and `ui.title_art`, plus the unchanged `playback_audio_languages` option set.
`player.hdr_enabled` is accepted from a live contract when the device-only boolean definition matches. `player.dolby_vision_enabled` is not read or written. Neither key is in this vendored subset.
The source manifest SHA-256 is `95b716c8b34974e4b97ee96f5c644135c437e09f4a6f2285fb263e3351e6c6ea`.
`scripts/sync-apiv2-fixtures.sh <server-ref>`, with `SILO_SERVER_REPO` set to a silo-server checkout, re-vendors the fixtures and both Settings subsets from `git show <commit>:<path>` and rewrites `SOURCE`; the Settings subsets are written in manifest order.
The script prints the manifest revision and SHA-256 so the lines above can be updated; `scripts/sync-apiv2-fixtures.test.sh` covers it.
`wire.ts` decodes only the members the client reads; unknown members are ignored and unknown
response enum values decode to `"unknown"`, so additive server changes keep working.

## Operations used

`trailers.ts` consumes `refreshCatalogItemTrailers` at `SOURCE`, including its unchanged `refresh_catalog_item_trailers_ok.json` fixture.
The profile-scoped POST is non-retryable and never replayed after refresh; completion is observed through catalog item reads.
Apple behavior is pinned separately to `b3d08d444b75dc078d3047730db72e0c4456e79b`; see [Details actions](../../../docs/features/details-actions.md).

`requests.ts` consumes the Requests status, discovery rows, search, media detail, request detail and My Requests contracts at `SOURCE`.
Create and cancel use POST; follow uses PUT; unfollow and removing a failed request use DELETE.
`DELETE /requests/{id}` expects 204 and no body. It uses `retry: never` and `replayAfterRefresh: false`, the server's `non_retryable` class, because a replay of a removal that already landed answers 404.
Create, cancel, follow and unfollow use the same retry class, including naturally idempotent follows, so an uncertain write requires an explicit read before another attempt.
`remove_failed_supported` is optional on status. Missing means the server cannot remove a failed request. A non-boolean value is a contract break. The flag is ignored unless requests are available.
See [Requests](../../../docs/features/requests.md) for capability and navigation behavior.

`calendar.ts` consumes `getCalendar` from the pinned OpenAPI schema without converting events to catalog cards.
The weekly query includes the device IANA timezone and an inclusive seven-day window.
Server day groups, event order, release metadata and all returned events are retained; there is no Calendar pagination or local access filtering.

| Operation | Retry class (`x-silo-retry-safety`) | Client behavior |
| --- | --- | --- |
| `getSystemInfo`, `getServerIdentity`, `getDeviceLoginCapability`, `listProfiles` | read | One transport retry after no answer or 502/503/504 |
| `startDeviceLogin` | `non_retryable` | Never resent; the person asks for a new code |
| `pollDeviceLogin` | `non_retryable` | Never resent; the next scheduled poll is a new request (`poll_after`) |
| `cancelDeviceLogin`, `logout` | `natural_idempotent` | One transport retry |
| `login` | `non_retryable` | Never resent; each press of Sign in is one request. No `provider`, so the server's default signs in. The `TokenPair` is installed like a device approval's; a late answer is revoked |
| `listAuthProviders` | read | One transport retry; `password_login: false` hides the password button, OAuth `display_name`s name the phone hint; 404 or failure keeps the password route |
| `refreshSession` | `domain_identity` | Never resent; 401/400/422 end the session, others keep the tokens |
| `verifyProfilePIN` | `non_retryable` | Never resent, not even after a token refresh |
| `getPlaybackCapabilities` | read | One transport retry; read before every play for `installation_id` |
| `listCatalogItemVersions` | read (`profile_scoped`) | One transport retry; read once per play for each version's `audio_tracks`; a failure only disables audio choices |
| `startPlayback`, `replanPlayback`, `stopPlayback` | `domain_identity` | The player resends only the identical body (same `playback_attempt_id`, `replan_request_id` or `stop_id`) after no answer or a transient failure |
| `updatePlaybackProgress` | `domain_identity` | Never resent; the next sample has a higher `sequence` |
| `listUserLibraries`, `listEffectiveSettings` (hidden libraries and playback defaults), `getImageCapabilities`, `listHomeSections`, `listCatalogItems`, `getCatalogItem`, `listSeriesSeasons`, `listSeasonEpisodes` | read (`profile_scoped`) | One transport retry; sent with the active profile's headers |
| `settingsCapabilities`, `settingsContract` | read | One transport retry; discover the Settings manifest and supported profile controls |
| `settingsValues`, `effectiveSettings` | read (`profile_scoped`) | One transport retry; read explicit profile rows separately from effective settings; title art also reads this profile-device row |
| `putSetting`, `deleteSetting` | `non_retryable` (`profile_scoped`) | Never resent automatically; profile scope by default (including explicit null for nullable keys); title art uses its selected profile/device scope and confirms both scopes and effective readback |

Settings also adopts the TV-capable poster, advisory-age, metadata-language, intro/credits and subtitle-appearance definitions from the manifest at `SOURCE`.
Poster writes use `profile_client` with client family `tv`, and can clear older device overrides to restore synced TV settings.
Playback choices use this TV's profile-device scope, while subtitle language, behavior and forced-subtitle editors read and write the profile row independently of narrower effective overrides.
Subtitle appearance can edit either the profile document or an explicit device document; the player consumes the same canonical appearance key through its effective endpoint.
The generated fixture `settings_rows_216.json` contains these eight consumed upstream definitions and the `catalog_metadata_languages` option set, selected by `SETTINGS_ROWS_KEYS` and `SETTINGS_ROWS_OPTION_SETS` in the refresh script.

Title art retains its existing contract checks, alongside the two seek exceptions.
It requires settings API v1, numeric manifest revision 16 or later, the compatible remote boolean definition and both `profile` and `profile_device` scopes.
Opaque capability `revision` remains opaque.
The decoder checks title-art JSON booleans, explicit and effective identities, discovered collection revisions and advancing PUT row revisions.
It accepts a server administrator's effective `source=default, value=false` without manufacturing a saved row.
See [title art](../../../docs/features/title-art.md) for the ordered write plan and compatibility behavior.

Playback bodies live in `playback.ts`, following `docs/playback-api.md` and `docs/architecture/playback-protocol-v3.md` at the same commit.
The vendored `playback_start_opaque_ids` plan is a direct plan at offset 0; the test server builds offset timelines, terminal decisions and problems without a fixture from the OpenAPI schemas.
Its subtitle inventory (external, embedded, burn-in-only and downloaded tracks) is the authoritative combined ordinal space; the player echoes an entry's `track_id` and never counts.
`effective_media_file_id` is an opaque string in `openapi.json` (the v3 design schema shows an integer); track identities belong to that file.

The audio identity `file:{effective file}:audio:{n}` is built from the nth `audio_tracks` entry of that file's version (`list_catalog_item_versions_ok` carries none; the test server adds them from the `AudioTrack` schema).
At the commit in `SOURCE` that position is the server's own ordinal: `internal/catalog/detail.go` copies the file's stored `AudioTracks` in order into each version, `internal/apiv2/catalog_items.go` passes them through unchanged, and `resolveV3AudioIndex` in `internal/api/handlers/playback_v3.go` reads the ordinal as an index into the same `AudioTracks`.
Re-check those three places when `SOURCE` moves.

Playback also reads effective `playback.preferred_quality` and `playback.max_bitrate_kbps` before each start, resolving the captured profile and stable device through the existing session headers.
The effective settings request repeats `keys` for each setting, as required by the pinned `listEffectiveSettings` contract.
The player retains the current quality and cap for the attempt and repeats them on track, seek and recovery replans; Auto restores the saved cap after a server rung is selected.
Quality choices come from `available_qualities` in server order, retaining additive labels and optional height/bitrate values without applying a client ladder.
Auto is added locally; legacy Original entries are removed, and no quality list is shown without a real alternative.
See [quality selection](../../../docs/playback/playback-quality.md) for highlighting and replacement safety.

`catalog.ts` holds the browse decoders. They are handwritten from `openapi.json` at the commit in `SOURCE`, not generated.
`getCatalogItem` reads optional `extras` (`ItemExtraInfo`) and `videos` (`ItemVideoInfo`). The vendored item fixture omits both, and a missing list decodes as empty. A missing `is_official` follows Apple and becomes false so one omitted flag cannot reject the detail; a non-boolean still fails.
A card's `user_state.watched_count` and `unplayed_count` are newer than `SOURCE`: [`CatalogItemUserState`](https://github.com/Silo-Server/silo-server/blob/3f1081bdfe82285ede3925473a1d63bb197e68f5/contracts/api/v2/openapi.json) gained them at silo-server `3f1081bdfe82285ede3925473a1d63bb197e68f5`. Both are optional, so an older server sends neither and the card shows no episodes-left count; the tests build those bodies from that schema.
The browse fixtures (`user_libraries`, `list_effective_settings_ok`, `list_home_sections_ok`, `list_catalog_items_ok`, `get_catalog_item_ok`, `list_series_seasons_ok`, `list_series_seasons_without_artwork`, `list_season_episodes_ok`) are copied unchanged from the same commit.
Artwork URLs in these responses are signed (`/api/v2/artwork/{key}?exp=…&sig=…`, operation `getArtwork`, public) or presigned storage URLs ([`docs/images-api.md`](https://github.com/Artic0din/silo-server/blob/cc8514943289045e7b9f7ac8d36d4968bfe93926/docs/images-api.md)); the client draws them with plain `<img>` and never adds credentials.

## Library discovery reads

`discovery.ts` decodes the consumed library collection, query, facet, letter-index and search-capability members at `SOURCE`.
`api/discoveryOperations.ts` supplies the eight factories, exposed through `operations`.
Every factory must be passed to `session.call({ ...spec, profileScoped: true })`; the session owns authentication, profile proof and cancellation.
`listLibrarySections` and `getLibrarySectionItems` reuse the Home section decoder; collection items and query results reuse the catalog page/card decoder.
Query results additionally retain `window_cursor` and `effective_sort`.
Section item reads return a Section, with no cursor/limit parameters in this pinned contract.
Collection item pages accept limits 1–200; catalog queries accept limits 1–100 and server seek positions 0–10000000.
Recent browsing uses `sort: "added_at", order: "desc"`.
Letter requests carry the same library, media type, filter groups and title order as the title browse.
Use server letter positions as `seek` and retain the window cursor when continuing that browse; runs may repeat a letter.
The factories add no credentials or new retry machinery.
The six GET operations are reads; `queryCatalogItems` declares `natural_idempotent`, so it uses the transport's existing safe retry.

The public discovery fixtures are byte-identical copies of `contracts/api/v2/fixtures/` at `SOURCE`:
`list_library_sections_ok`, `get_library_section_items_ok`, `get_library_collections_ok`, `get_catalog_filters_ok`, `query_catalog_items_ok`, `query_catalog_letters_ok`, and `get_catalog_search_capabilities_ok`.
Only consumed video facets and capability flags are decoded.
Text Search also consumes optional `video_with_episodes_scope` as a strict boolean and negotiates the existing GET `listCatalogItems` request only after an allowed, available, true response.
Optional `box_sets` is the same kind of boolean. When it is true, All and Movies search also calls `searchCatalogBoxSets`, opening a result calls `getCatalogBoxSet`, and a movie page calls `getCatalogItemBoxSet`. Older servers omit the flag and get none of those requests. Library browse does not group box sets. These reads are not in the vendored fixtures; their bodies follow the server structs and are not hand-copied into `fixtures/`.
Absent/false flags keep video-only searches; capability read/decode failures remain recoverable failures rather than unsupported facts.
The episode-inclusive request type is limited to text Search and is not added to library, facet, letter or POST source types.
See [Text Search](../../../docs/features/skyline-browse-shell.md#text-search) for route ownership, continuation and source evidence.
Unknown members are ignored and response enums are additive; malformed consumed fields fail without echoing values.
These factories do not implement the library UI or complete issue 28.

## Audiobooks

`audiobooks.ts` and `api/audiobookOperations.ts` carry the audiobook contract at `SOURCE`; `operations` exposes them. `ui/audiobookDetail.ts` and `ui/audiobookView.ts` draw the detail and chapter picker on top of it.
Apple behavior is read from `AudiobookPlaybackContext.swift`, `AudiobookProgress.swift` and `APIv2CatalogReadProjection.swift`.

| Operation | Retry class | Client behavior |
| --- | --- | --- |
| `listAudiobookGroups` | read (`profile_scoped`) | Authors, narrators or series with counts, durations and up to four covers; limit 1–200; a group's `name` is the filter value for its books. Apple does not call it; the server publishes it |
| `getCatalogItem` as `getAudiobook` | read (`profile_scoped`) | Decodes the `audiobook` extension, the audio parts, chapters and `user_data` |
| `queryCatalogItems` as `queryAudiobooks` | `natural_idempotent` (`profile_scoped`) | Scoped by `library_id` with no `type`, as Apple omits it for audiobook libraries; the author, narrator or series filter is one `match: any` group of `is` rules |
| `syncProgress` | `non_retryable` (`profile_scoped`) | The only durable resume point; whole-book milliseconds with `force_overwrite`; never resent, so the caller passes `replayAfterRefresh: false` and the next sample carries a fresh position |

Library gating: `listUserLibraries` reports `type: "audiobooks"`, and `audiobookLibraries` drops hidden ones.
`nav.show_audiobooks` is `client_local` and defaults to false in the manifest, so the opt-in is stored per profile on the device and is never read from or written to the server.
There is no server capability flag for audiobooks; a server without audiobook libraries simply lists none.
`player.audiobook_skip_back_seconds` and `player.audiobook_skip_forward_seconds` are ordinary profile settings (revision 9); this change only names them.

Parts follow Apple: a version is a part when `presentation_kind` is `audiobook_part` or it carries `codec_audio` or `duration`, ordered by `presentation_part_index` and then numerically by `file_id`.
Part offsets and chapter starts are summed onto one whole-book timeline; the playback API only knows files.
The total is the larger of the stitched length and `audiobook.total_duration_seconds`. The resume position never passes a known total (an unknown total of 0 leaves it as the server sent it, where Apple clamps it to 0), and a seek never passes the end of its file.
One deliberate difference from Apple: a part with no `duration` is sized by its furthest chapter `end_seconds`, never by a chapter start, and a multi-part book with any unknown part length is rejected rather than stitched on a guess.
`syncProgress` answers are decoded as Apple does: exactly one result per written item, matched by index and id, and anything else is a contract break, not success.

`fixtures/list_audiobook_groups_ok.json`, `list_audiobook_groups_invalid_group_by.json` and `list_audiobook_groups_profile_header_required.json` are byte-identical copies from `SOURCE`.
The server publishes no audiobook item or progress fixture; the tests build those bodies from `CatalogItemDetail`, `FileVersion`, `VersionChapter`, `WatchRollup`, `AudiobookDetailExtension` and the `ProgressSync*` schemas in `openapi.json`.

## Preplay audio and resume

Catalog versions decode optional `audio_tracks` using the same ordered audio decoder as the in-player version read.
Missing arrays become empty; malformed consumed metadata fails the read.
`detailOperations.resumePosition` reads the existing profile-scoped `getWatchState` with the captured `file_id`, verifies the item/file identity, and decodes finite nonnegative source seconds.
The Details owner bounds that safe read to three seconds and keeps cached fallback limited to network/timeout or HTTP 501/503.
Other refusals and invalid data require explicit Retry without starting playback.
`startPlayback` adds only optional `audio_track_id` and `allow_alternate_versions:false` to the existing typed body.
Auto omits audio fields; explicit audio IDs use the selected file's audio-array ordinal.
Zero explicitly starts over, while an omitted `start_position` retains server resume semantics for callers that need them.
Start still declares `retry:"never"`; only the controller resends its identical body and identity through its existing bounded domain retry.
No per-content preference writes, subtitle start fields or renderer claims are added.
See [preplay behavior](../../../docs/features/skyline-browse-shell.md#preplay-audio-and-resume).

## Seek preview reads

`trickplay.ts` decodes consumed watch availability and seek-thumbnail manifest members from the same `SOURCE`.
The exact public fixtures are `get_watch_state_ok` and `get_watch_trickplay_ok`.
`getWatchState` and `getWatchTrickplay` are profile-scoped reads using the existing safe transport retry.
Playback capability `features` is retained for the independent `trickplay_v1` gate.
Signed JPEG URLs bypass the authenticated API transport and remain unchanged.
See [seek thumbnails](../../../docs/playback/seek-thumbnails.md) for lifecycle and browser proof limits.

## Person hero

`decodePerson` reads optional `photo_thumbhash` from the pinned Person schema.
A present non-string fails the person read. Absence stays absent, and an empty string is preserved for the portrait to ignore.
Birth and death dates stay calendar strings. The hero formats valid `YYYY-MM-DD` values and leaves any other text unchanged.
See [person hero](../../../docs/features/person-hero.md).

## Playback markers

The pinned OpenAPI publishes profile-scoped `GET /api/v2/markers/items/{item_id}` and `GET /api/v2/markers/files/{file_id}`, both returning `FileMarkers`.
Playback reads the effective file route once per file in an attempt, using the existing authenticated session and authority signal.
Only `file_id` and `marker_segments` occurrences (`kind`, `start_seconds`, `end_seconds`) are consumed.
The server resolves detections; the client shows intro, recap and credits in the half-open source-time window `[start_seconds, end_seconds)` and ignores preview occurrences.
Missing, failed, malformed or mismatched-file responses leave playback and manual seeking available without a Skip control.
Up reaches Skip when available; Down or Back from Skip returns to transport, and Enter or Play seeks to the segment end.
The countdown is informational and never automatically seeks.
Desktop tests do not prove Samsung hardware rendering or live server CORS.

## Password sign-in

`login_ok`, `login_invalid_credentials`, `login_account_required`, `login_password_required` and `list_auth_providers_ok` are byte-identical copies from `SOURCE`.
`decodeTokenPair` reads `access_token`, `refresh_token`, `expires_in` and `user` (`id`, `username`, `password_change_required`), shared with the device poll's `tokens`.
Refusals follow `internal/apiv2/auth.go` at `SOURCE`: 401 `invalid_token` for a wrong password or unknown name alike, 403 `local_login_disabled`, `not_permitted`, `password_expired`, `account_required`, 409 `email_in_use`, `identity_linked_elsewhere`, 429 `rate_limited`, and 503 `dependency_unavailable` when the server is too busy to check a password.
The copy for each follows the Apple TV app's `LoginViewModel.message`.

## Watch Together (Watch Party)

`watchTogether.ts` decodes the `/watch-together` documents and the `silo.room.v2` socket frames; `api/watchTogetherOperations.ts` supplies the specs (capabilities, create, join by code, room read, close, socket ticket, the host's stage, select, start, stop, mode and policy calls, the picker read, and the ballot's suggestions read, add suggestion, vote and promote).
The Watch Party hub and lobby call the HTTP specs, and `src/ui/watchPartySocket.ts` mints the ticket and decodes the frames (issue 54); the lobby uses snapshots, `suggestions_update`, pongs, `room_closed`, `connection_replaced` and `error`, sends `lobby_ready` and `ping`, and nothing uses transport commands yet.
Pass each spec to `session.call({ ...spec, profileScoped: true })`, as Apple's calls run for the active profile.
`room`, `socketTicket`, `picker` and the ballot calls add the room's `X-Room-Token` (`RequestSpec.roomToken`); every create, join and read answer returns a `room_access_token` that replaces the previous one; never log or store it.

`watch_together_capabilities` is a byte-identical copy from `SOURCE` and carries `allowed: false`, so it proves the closed gate.
It is the only Watch Together fixture the server publishes.
Room, join, ticket and socket bodies are built in the tests from the `WatchTogetherRoomSnapshot`, `WatchTogetherRoomMember` and `EventsSocketTicket` schemas, and the socket frames from `internal/watchtogether/service.go` and `internal/api/handlers/watch_together.go` at `SOURCE`; the frames are not in `openapi.json`.

Everything is gated by `GET /watch-together/capabilities`: `watchTogetherAvailable` needs `state: "available"` and `allowed: true`, and `watchTogetherSocketSupported` also needs `socket_protocol: "silo.room.v2"` and `connection_replaced: true`, as Apple requires before it joins.
Apple additionally requires the playback capabilities features `watch_party_coordinator_v1` and `fixed_media_file_v1`; that check belongs with the player work.
Flags the first servers lacked default to false; `allowed` defaults to false.

| Operation | Retry class (`x-silo-retry-safety`) | Client behavior |
| --- | --- | --- |
| `getWatchTogetherCapabilities` | read | One transport retry |
| `createWatchTogetherRoom` | `unique_constraint` | The caller's `room_id` UUID makes an exact replay return the same room, so the transport may resend it and a 401 refresh may replay it. Reuse the id for any resend |
| `joinWatchTogetherRoom` | `natural_idempotent` | One transport retry. Body `code` only, trimmed, 1 to 128 characters; the invite `join_token` is not used |
| `getWatchTogetherRoom` | read | One transport retry; the lobby state |
| `closeWatchTogetherRoom` | `natural_idempotent` | Host only, by account and profile (no room token in the contract); 204, 409 once ended. A guest has no HTTP leave: leaving is closing the room socket, as in Apple's `leave()` |
| `createWatchTogetherSocketTicket` | `natural_idempotent` | A single-use ticket for one connection; mint a new one for every reconnect |
| `listWatchTogetherSuggestions` | read | 100 rows a page in creation order, continued by `page.next_cursor`; the only source of `voted_by_me` |
| `createWatchTogetherSuggestion` | `unique_constraint` | The caller's `suggestion_id` UUID makes a resend return the same suggestion; 201 with the id; `content_type` is `movie` or `episode` |
| `voteWatchTogetherSuggestion`, `unvoteWatchTogetherSuggestion` | `unique_constraint`, `natural_idempotent` | `POST` and `DELETE` on `.../suggestions/{id}/vote`; 204, and a vote already in that state is a no-op |
| `promoteWatchTogetherSuggestion` | `non_retryable` | Host only; plays the suggestion for everyone and answers with the room. A lost answer is read back from the room, never resent |

Socket frames still carry numeric `user_id`, `selected_file_id`, `selected_library_id` and `suggester_user_id`, while HTTP v2 bodies carry strings; both decode to strings, as Apple's `watchPartyID` does.
`anchor_updated_at` is RFC 3339; command and message times are RFC 3339 with nanoseconds and decode to epoch milliseconds.
`suggestions_update` rows always carry `voted_by_me: false`; the server strips it because it is per viewer, so this profile's votes come only from the HTTP read.
Unknown `type` values decode to `unknown` and unknown enum values to `"unknown"`; a frame without a string `type`, or with a missing or malformed consumed member, throws `WireError`.
`encodeRoomClientMessage` writes the seven client frames the server accepts and refuses an empty session id or a position that is not a finite number of seconds, zero or more.
`roomSocketHandshake` builds the `wss://<server>/api/v2/watch-together/rooms/{id}/ws` address and the `["silo.room.v2", "silo.ticket.<ticket>"]` subprotocols.

The room operations that this layer does not cover yet (suggestion delete, member state, source fallback) are in the same contract and are left for the lobby and playback work.

## Updating the pinned contract

1. Pick the new server commit and copy the same fixture names from its `contracts/api/v2/fixtures/`.
2. Write the commit SHA to `SOURCE`.
3. Re-read the OpenAPI schemas and docs for the operations above and update `wire.ts`.
4. Run the native tests.

## Native tests

Commands assume the repository root is the cwd.
Node 23.6 or later runs the TypeScript sources directly:

```bash
node --test --test-timeout=15000 test/native/
```

Type checking needs `allowImportingTsExtensions` (sources import `./x.ts`) and
`erasableSyntaxOnly` (Node strips types; no enums, namespaces or parameter properties).
