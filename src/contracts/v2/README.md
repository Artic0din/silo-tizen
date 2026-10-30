# Silo /api/v2 contract (vendored)

`SOURCE` holds the exact `silo-server` commit these files come from.
`fixtures/` holds the response bodies this client consumes, copied unchanged from
`contracts/api/v2/fixtures/` at that commit, except `settings_contract_ok.json`,
which contains the selected Settings manifest subset consumed by this client.
`wire.ts` decodes only the members the client reads; unknown members are ignored and unknown
response enum values decode to `"unknown"`, so additive server changes keep working.

## Operations used

| Operation | Retry class (`x-silo-retry-safety`) | Client behavior |
| --- | --- | --- |
| `getSystemInfo`, `getServerIdentity`, `getDeviceLoginCapability`, `listProfiles` | read | One transport retry after no answer or 502/503/504 |
| `startDeviceLogin` | `non_retryable` | Never resent; the person asks for a new code |
| `pollDeviceLogin` | `non_retryable` | Never resent; the next scheduled poll is a new request (`poll_after`) |
| `cancelDeviceLogin`, `logout` | `natural_idempotent` | One transport retry |
| `refreshSession` | `domain_identity` | Never resent; 401/400/422 end the session, others keep the tokens |
| `verifyProfilePIN` | `non_retryable` | Never resent, not even after a token refresh |
| `getPlaybackCapabilities` | read | One transport retry; read before every play for `installation_id` |
| `listCatalogItemVersions` | read (`profile_scoped`) | One transport retry; read once per play for each version's `audio_tracks`; a failure only disables audio choices |
| `startPlayback`, `replanPlayback`, `stopPlayback` | `domain_identity` | The player resends only the identical body (same `playback_attempt_id`, `replan_request_id` or `stop_id`) after no answer or a transient failure |
| `updatePlaybackProgress` | `domain_identity` | Never resent; the next sample has a higher `sequence` |
| `listUserLibraries`, `listEffectiveSettings` (hidden libraries and playback defaults), `listHomeSections`, `listCatalogItems`, `getCatalogItem`, `listSeriesSeasons`, `listSeasonEpisodes` | read (`profile_scoped`) | One transport retry; sent with the active profile's headers |
| `settingsCapabilities`, `settingsContract` | read | One transport retry; discover the Settings manifest and supported profile controls |
| `settingsValues`, `effectiveSettings` | read (`profile_scoped`) | One transport retry; read explicit profile rows separately from effective hidden-library and preferred-audio values |
| `putSetting`, `deleteSetting` | `non_retryable` (`profile_scoped`) | Never resent automatically; write a profile value (including explicit null) or delete its override to restore inheritance, then confirm explicit and effective readback |

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
See [quality selection](../../../docs/playback-quality.md) for highlighting and replacement safety.

`catalog.ts` holds the browse decoders. They are handwritten from `openapi.json` at the commit in `SOURCE`, not generated.
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
The six GET operations are reads; `queryCatalogItems` and `queryCatalogLetters` declare `natural_idempotent`, so both use the transport's existing safe retry.

The public discovery fixtures are byte-identical copies of `contracts/api/v2/fixtures/` at `SOURCE`:
`list_library_sections_ok`, `get_library_section_items_ok`, `get_library_collections_ok`, `get_catalog_filters_ok`, `query_catalog_items_ok`, `query_catalog_letters_ok`, and `get_catalog_search_capabilities_ok`.
Only consumed video facets and capability flags are decoded.
Unknown members are ignored and response enums are additive; malformed consumed fields fail without echoing values.
These factories do not implement the library UI or complete issue 28.

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
