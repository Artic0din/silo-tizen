# Native API v2 on Tizen

The Silo Samsung TV client talks to the server only through the native `/api/v2` API.
This page lists every operation the app calls, how each one is authenticated, and how failures are handled.
The code is the source of truth.
Each section cites the file that defines the operation.

The Apple counterpart is [silo-apple `docs/native-api-v2.md`](https://github.com/Silo-Server/silo-apple/blob/main/docs/native-api-v2.md).
The wire contract is pinned by `src/contracts/v2/SOURCE` to silo-server commit `cc8514943289045e7b9f7ac8d36d4968bfe93926`.
The retry class of each operation is taken from that contract's `x-silo-retry-safety` annotations (`src/api/operations.ts` header comment).
The contract file itself is not in this repository, so this page does not re-verify those annotations.

## Boundaries

Every request path in `src/api/` is relative to `/api/v2`.
No API operation requests a path outside `/api/v2`.
Artwork, trickplay sheets and subtitle files are fetched from the URLs the server returns, which may be on another permitted origin.
Server operations and response decoding stay in `src/api/` and `src/contracts/v2/`.
Authenticated requests from UI and player code go through `NativeSession.call` (`src/session/session.ts`).
The public sign-in reads (branding and auth providers) call `NativeHttp.send` directly (`src/ui/signIn.ts`).

## Transport

`NativeHttp` in `src/api/http.ts` is the only code that sends API requests.

- **URL.** Each request goes to `base.apiRoot + path`.
- **Redirects and cookies.** Requests use `redirect: "error"`, `credentials: "omit"` and `cache: "no-store"`. A redirect is refused so a bearer token or body cannot reach another origin.
- **Timeout.** The default is 15 s (`DEFAULT_TIMEOUT_MS`). Callers may override it per request.
- **Headers on every request.**
  - `Accept: application/json, application/problem+json`
  - `X-Silo-Device-Id`
  - `X-Silo-Device-Name`
  - `X-Silo-Device-Platform`
- **Headers when set.**
  - `Content-Type: application/json` when a body is sent.
  - `Authorization: Bearer <token>` when the spec carries a bearer.
  - `X-Profile-Id`, and `X-Profile-Token` when a PIN proof exists, for profile-scoped specs.
  - `X-Room-Token` when the spec carries a Watch Together room token (`src/api/watchTogetherOperations.ts`).
  - `X-Silo-Client-Family: tv`, set only on the two `effectiveSettings` reads for the primary menu and card presentation (`src/ui/navigationSettings.ts`, `src/ui/presentationSettings.ts`).
- **Success.** A 2xx with status 204 or an empty body decodes `undefined`. Any other 2xx body must have media type `application/json`, otherwise the result is `invalid_response` at `content-type`.

### Retry policy

Each `RequestSpec` has `retry: "safe"` or `"never"`.
A `safe` request is sent at most twice (`MAX_ATTEMPTS = 2`).
The second attempt happens after a network error, a timeout, or a 502, 503 or 504 answer.
The delay is `Retry-After` when present, otherwise 1 s.
A `Retry-After` longer than 5 s is not retried by the transport.
A `never` request is never resent by the transport.
Callers that may resend an identical request (playback start, replan and stop) do so themselves; see Playback.

### Error decoding

`src/api/errors.ts` defines `ApiError`, which wraps one `ApiFailure`:

| Kind | Meaning |
| --- | --- |
| `network` | No HTTP answer: DNS, TLS, refused connection, CORS refusal or a refused redirect. |
| `timeout` | The request timer fired. |
| `aborted` | The caller or an authority change abandoned the request. |
| `problem` | A non-2xx answer whose body is `application/problem+json` and decodes as Problem Details. |
| `http` | A non-2xx answer without usable Problem Details, for example from a proxy. |
| `invalid_response` | A 2xx answer that failed decoding. Carries the `WireError` path, never the offending value. |

A Problem body is accepted only when its `status` equals the HTTP status.
`id` is the last path segment of the Problem `type` (`decodeProblem`, `src/contracts/v2/wire.ts`).
`ApiError` exposes `status`, `problemId`, `retryAfterSeconds` (delta-seconds only), `aborted` and `transient`.
`transient` is true for `network`, `timeout`, 408, 429 and any status of 500 or above.
A complete answer is returned even if the caller aborted while it arrived; callers check that it is still current.

## Server address and device identity

`parseServerUrl` (`src/api/serverUrl.ts`) builds a `ServerBase` with three fields.

- `origin` is scheme, host and port.
- `baseUrl` is the origin plus any reverse-proxy path prefix, with no trailing slash.
- `apiRoot` is `baseUrl + "/api/v2"`.

The address rules are:

- A missing scheme means HTTPS.
- Only `http:` and `https:` are accepted.
- Credentials, a query string or a fragment are rejected.
- An address that already ends in `/api` or `/api/vN` is rejected (`has_api_path`).
- `plainHttpFallbacks` offers plain HTTP only after a scheme-less address failed over HTTPS: the same host and port, then port 8090 if no port was typed.
- `isPermittedUrl` allows HTTPS anywhere, and HTTP only when the server itself is HTTP.

`DeviceId` is created once per install by `loadDeviceId` (`src/session/deviceIdentity.ts`).
It is 16 random bytes as 32 hex characters, stored in `localStorage` under `silo.native.deviceId`.
It matches `^[A-Za-z0-9._:-]{1,128}$`.
It is not derived from a server URL or account, and it is not a secret.
If storage is blocked, an id is generated for that run only.
`deviceHeaders` reduces the device name and platform to printable ASCII, 120 and 40 characters at most.
The fallbacks are `Samsung TV` and `tizen`.

## Credential storage

Tokens live only in protected storage (`src/session/secretStore.ts`).
On a TV that is Tizen KeyManager (`tizen.keymanager`), through `keyManagerStore`.
Without KeyManager the app uses `memoryStore`, which keeps credentials for the current run only.
The code states it never falls back to `localStorage`.
`NativeSession.persistence` reports `persistent` or `session_only`, and the sign-in result passes that to the screens.

`CredentialVault` (`src/session/credentialVault.ts`) stores one record per server, keyed by a hash of `baseUrl`, in two alternating slots.
A refresh writes the other slot before removing the old one.
Public storage holds only a "cleared generation" number, so a failed delete cannot bring a signed-out session back.
The record holds `baseUrl`, `serverId`, `accountId`, `username`, the access and refresh tokens, and the access expiry.
On restore, a record whose `serverId` differs from the server now answering is deleted without being sent.

## Authentication model

`NativeSession.call` (`src/session/session.ts`) attaches credentials to every authenticated request.

1. It reads the stored credential, and refreshes first if the access token expires within 30 s (`REFRESH_SKEW_MS`).
2. It sends the request with `Authorization: Bearer`.
3. With `profileScoped: true` it also sends `X-Profile-Id` and `X-Profile-Token` for the active profile.
4. On a 401 it refreshes once, then resends once. A caller can pass `replayAfterRefresh: false` to skip the resend.
5. A 403 with Problem id `profile_verification_required`, while a PIN proof is active, clears the profile with reason `profile_proof_revoked`.

`replayAfterRefresh` is not set (so it defaults to resend) for most reads, and for playback start, replan, progress and stop.
It is set to `false` for these calls:

- PIN verification (`src/session/profiles.ts`)
- personal-list and watched mutations (`src/ui/detailsState.ts`)
- shuffle creation (`src/ui/browse.ts`)
- request create, cancel, remove and follow (`src/ui/browse.ts`)
- series subtitle preference saves (`src/player/controller.ts`)

Settings and AI-subtitle calls resend only when the method is GET (`src/ui/settingsState.ts`, `src/player/subtitleAI.ts`).

Refresh is single-flight (`refresh`), so concurrent callers share one `POST /auth/refresh`.
A refresh answered 401, 400 or 422 ends the session (`session_expired`) and clears stored credentials.
Any other refresh failure leaves tokens in place and reports `unavailable` with the `Retry-After` value.
Every sign-in, sign-out, profile change or revoked proof bumps an authority generation and aborts in-flight requests made under the old authority.
`mediaToken(signal)` returns the current access token (refreshed first if needed) for URLs the platform fetches without headers.

## Operations by domain

"Profile" means the request carries `X-Profile-Id` (and `X-Profile-Token` if a PIN proof exists).
"Bearer" means `Authorization: Bearer`.
"Public" means no credentials are sent.
Retry is the `RetryPolicy` in code: `safe` or `never`.

### Discovery and capabilities

`discoverServer` (`src/api/discovery.ts`) runs before any credential is sent.
It calls `GET /system/info`, then `GET /system/identity`.
It reports `not_silo_v2` when `api_major` is not 2, when the answer is not a valid v2 body, or when the status is 404 or 410.
It reports `origin_mismatch` when `request_origin` differs from the entered origin.
It reports `unreachable` for network errors and timeouts, and `server_error` for any other failure.
The `serverId` it returns is self-asserted and never authorizes anything on its own.

`connect` (`src/session/core.ts`) then calls `GET /system/setup` on that server, still with no credentials.
A failure is reported the same way as discovery, and no session is opened.
`needs_setup: true` (true until the first administrator account exists) returns `needs_setup`.
Sign-in shows the recovery screen and does not start a device code.
`wizard_completed` is required by the contract and is not used to choose the screen.
Account creation stays off the TV.

| Operation | Method and path | Auth | Retry | Defined in |
| --- | --- | --- | --- | --- |
| getSystemInfo | `GET /system/info` | Public | safe | `src/api/operations.ts` |
| getServerIdentity | `GET /system/identity` | Public | safe | `src/api/operations.ts` |
| getSetupStatus | `GET /system/setup` | Public | safe | `src/api/operations.ts`, called from `src/session/core.ts` |
| server branding | `GET /theme/branding` | Public | safe | `src/api/operations.ts`, called from `src/ui/signIn.ts` |
| getImageCapabilities | `GET /images/capabilities` | Bearer, Profile | safe | `src/api/operations.ts` |

Artwork URLs are used as given and no credential is added.
They are signed or presigned URLs, root-relative or absolute, checked with `isPermittedUrl` (`artworkUrl`, `src/ui/browseModel.ts`).
`image_size` is `small` for lists and `medium` for detail pages.
Per-slot widths are added only when the image capability probe succeeded.

### Auth and sessions

Sign-in is a device code (`src/session/deviceLogin.ts`), with a password fallback through the native `/auth/login` route when the server offers it.

| Operation | Method and path | Auth | Retry | Notes |
| --- | --- | --- | --- | --- |
| getDeviceLoginCapability | `GET /auth/device/capability` | Public | safe | `state` must be `available`, otherwise the screen shows "unavailable". `cancel` says whether cancel is supported. |
| startDeviceLogin | `POST /auth/device/start` | Public | never | Body `device_name`, `device_platform`. A 403 or 404 means "unavailable". A temporary profile-bound session is refused. |
| pollDeviceLogin | `POST /auth/device/poll` | Public | never | Body `device_code`. An approved answer hands over the tokens once. |
| cancelDeviceLogin | `POST /auth/device/cancel` | Public | safe | Best effort, and only when the capability said cancel is supported. |
| listAuthProviders | `GET /auth/providers` | Public | safe | `password_login` gates the password button. A 404 is treated as "password allowed". |
| login | `POST /auth/login` | Public | never | Body `username`, `password`. No `provider` field is sent. |
| refreshSession | `POST /auth/refresh` | Public | never | Body `refresh_token`. |
| logout | `POST /auth/logout` | Bearer | safe | 204. |

All are defined in `src/api/operations.ts`.

Device login behaviour:

- Polls wait the start answer's `interval`, then each pending answer's `poll_after`.
- A pending answer's `expires_at` moves the local deadline, and the code is polled once more after it.
- No answer, 408, 429 and 5xx back off (capped at 30 s) and poll again; a 429 `Retry-After` is honoured in full, even beyond 30 s.
- A 404 on poll, and a `consumed` status, end the attempt; a lost approval is never requested again.
- Polling pauses while the screen is hidden, and resumes at once when it is shown, but not before a `Retry-After` the server asked for.
- Start is never resent after a failure.
- An approval that arrives for an abandoned attempt is revoked, not installed.
- Password login behaves the same way: an answer for an abandoned attempt is revoked (`src/session/passwordLogin.ts`).

`logout` runs after the session is ended locally, so it holds offline.
`revokeIssuedTokens` sends `POST /auth/logout` with the access token and a 5 s timeout.
On a 401 it exchanges the refresh token once and sends logout again.
It is also used for a replaced account, a refresh that finished after an account change, and abandoned sign-ins.

### Profiles and PIN

| Operation | Method and path | Auth | Retry | Defined in |
| --- | --- | --- | --- | --- |
| listProfiles | `GET /profiles` | Bearer, no Profile | safe | `src/api/operations.ts` |
| verifyProfilePIN | `POST /profiles/{id}/verify-pin` | Bearer, no Profile | never | `src/api/operations.ts` |

`Profiles` (`src/session/profiles.ts`) sends both with `profileScoped: false`.
A profile without a PIN is selected locally with no request.
A PIN-locked profile needs `verify-pin`, which returns a `profile_token` that becomes `X-Profile-Token`.
One check runs at a time and it is never resent, because every check counts toward the lockout.
Outcomes:

| Answer | Result |
| --- | --- |
| Valid | Profile installed with its token. |
| Invalid | `wrong_pin`. |
| 429 | `locked` until `Retry-After`, or 300 s if none. |
| 401 | `enter_again`; the token was refreshed and the PIN is not resent. |
| 503 | `busy`. |
| No answer, or another status of 500 or above | `uncertain`; it may have counted. |

`ProfileLaunch` (`src/session/profileLaunch.ts`) can remember a profile choice per account and device.
Fresh TVs show the profile picker even for one unprotected profile until the viewer chooses Remember.
Account migration preserves the existing launch choice and does not select a profile.
The choice is public storage and the PIN proof is in KeyManager under a random alias.
On restore it re-checks the profile with a profile-scoped `GET /user/libraries`.
Remembering a PIN proof is refused when protected storage is not persistent.

### Catalog, browse and detail

Details sends explicit audio and subtitle choices through `PUT /audio-prefs/{key}` and `PUT /subtitle-prefs/{key}`, and Auto through the corresponding `DELETE`.
The key is a nonempty series ID or the item's own opaque content ID.
The audio signature preserves title, embedded title, layout, language, codec, channels and default independently.
Writes never replay after refresh; queued choices serialize, uncertain results require explicit readback before retry, and playback remains blocked until confirmation and effective catalog readback settle.
Route teardown fences completions; retained playback returns reread effective state without resending writes.
Version selection remains visit-only.
Subtitle signatures preserve source, language, codec, label, forced and hearing-impaired flags.
External subtitle paths use the catalog `file_name`, matching Apple; embedded tracks send an empty path.
Explicit Off writes index `-1`, empty language/path and mode `off`.
Ordinary picks omit `show_forced_subtitles` so they do not pin an inherited profile setting.
Fresh effective subtitle signatures seed Details using Apple's language/label scoring; explicit Auto remains Auto for the retained visit.
This is source work only, pending independent review and native Apple/Samsung parity.

All of these are Bearer plus Profile.
The server applies library access and content limits, so the client does not filter.
Defined in `src/api/operations.ts` unless noted.

| Operation | Method and path | Retry |
| --- | --- | --- |
| listUserLibraries | `GET /user/libraries[?include_hidden=true]` | safe |
| listHomeSections | `GET /home/sections?image_size=small[&slot widths]` | safe |
| listCatalogItems | `GET /catalog?library_id&q&type&limit&cursor&image_size` | safe |
| getCatalogItem | `GET /catalog/items/{id}?image_size=large` (Details overrides with the negotiated hero slots when known) | safe |
| listCatalogItemVersions | `GET /catalog/items/{id}/versions` | safe |
| listSeriesSeasons | `GET /catalog/series/{id}/seasons` | safe |
| listSeasonEpisodes | `GET /catalog/series/{id}/seasons/{n}/episodes` | safe |
| getWatch (detail) | `GET /watch/{id}` | safe |
| resume position | `GET /watch/{id}?file_id=` (`src/api/detailOperations.ts`) | safe |
| person | `GET /catalog/people/{id}` (`src/api/detailOperations.ts`) | safe |
| refresh person metadata | `POST /catalog/people/{id}/refresh` (`src/api/detailOperations.ts`), queued receipt for the requested person | never |
| filmography | `queryCatalogItems`: `POST /catalog/query?image_size=small`, body from `personQuery` (`src/ui/personFilmography.ts`), 60-title pages | safe |
| similar | `GET /recommendations/similar/{id}?limit=24&image_size=small` (`src/api/detailOperations.ts`) | safe |
| library sections | `GET /library/{id}/sections?image_size=small` (`src/api/discoveryOperations.ts`) | safe |
| section items | `GET /library/{id}/sections/{sectionId}/items?image_size=small` (`src/api/discoveryOperations.ts`) | safe |
| library collections | `GET /library/{id}/collections` (`src/api/discoveryOperations.ts`) | safe |
| collection items | `POST /catalog/query` with `source: library_collection` or `user_collection`, `collection_id`, `limit: 60`, `match: all` and cursor; library/media scope only when narrowing a mixed library, no sort override (`src/api/discoveryOperations.ts`); includes profile viewer state | safe |
| catalog filters | `GET /catalog/filters?...` (`src/api/discoveryOperations.ts`) | safe |
| search capabilities | `GET /catalog/search/capabilities` (`src/api/discoveryOperations.ts`) | safe |
| Search people | `GET /catalog/people?q&media_scope&limit=20` (`src/api/detailOperations.ts`), gated by allowed/available `people_media_scope` | safe |
| searchCatalogBoxSets | `GET /catalog/box-sets?q&limit=5` (`src/api/boxSetOperations.ts`), All and Movies only, gated by `box_sets: true` | safe |
| getCatalogBoxSet | `GET /catalog/box-sets/{id}?library_id&image_size=medium` (`src/api/boxSetOperations.ts`) | safe |
| getCatalogItemBoxSet | `GET /catalog/items/{id}/box-set?image_size=medium` (`src/api/boxSetOperations.ts`), movie pages only, gated by `box_sets: true`. `box_set` absent means no row. Library browse does not group box sets | safe |
| queryCatalogItems | `POST /catalog/query?image_size=small` (`src/api/discoveryOperations.ts`) | safe |
| queryCatalogLetters | `POST /catalog/letters` (`src/api/discoveryOperations.ts`) | safe |

Notes:

- Related titles decode the endpoint's `items` collection without requiring the catalog listing's `total` or `total_exact` fields.
- Collection members decode `CatalogItemCollection` with optional totals and cursor pagination.
  The test fixture follows the server schema and handler at `6d1562473336738009a91475ed3f33143670c249`; catalog queries and filmography retain their required totals.
- Pages continue with the opaque `next_cursor`.
- `limit` is bounded client-side (1 to 200 for collection items, 1 to 100 for `catalog/query`), and out-of-range values throw `RangeError` before any request.
- The two POST queries are marked `safe` in code ("natural_idempotent"), so the transport retry applies to them.
- `queryCatalogItems` also serves the watchlist, favorites and history lists (`src/ui/personalLists.ts`).
- Person works use that same POST through `personQuery`: `source: "person"`, `person_id`, `type` (`video`, `movie` or `series`), `sort: "year"`, `order: "desc"`, `limit: 24` and an optional opaque `cursor`. `detailOperations.filmography` (`GET /catalog?source=person...`) is not called.
- The detail view reads the same `GET /catalog/items/{id}` for Home marquee fields (`marqueeDetail`).
- Item detail carries `themes`: `owner_id` and ordered `items` (`id`, `title`, `duration_seconds`). A season or episode answers with the set it inherits. A malformed set reads as none, because the server treats the theme lookup as optional.
- Library search capabilities are probed with `GET /catalog/search/capabilities` (`src/ui/libraryDiscovery.ts`). Text Search sends the episode-inclusive request only after an allowed, available `video_with_episodes_scope: true` answer (`src/contracts/v2/README.md`, Text Search).

### Personal state and lists

Defined in `src/api/detailOperations.ts`.
All are Bearer plus Profile.

| Operation | Method and path | Retry |
| --- | --- | --- |
| personal-list capability | `GET /capabilities/personal-lists` | safe |
| membership | `GET /watchlist/{id}/membership` and `GET /favorites/{id}/membership` | safe |
| add to watchlist or favorites | `PUT /watchlist/{id}`, `PUT /favorites/{id}` | never |
| remove from watchlist or favorites | `DELETE /watchlist/{id}`, `DELETE /favorites/{id}` | never |
| mark watched | `POST /watched/{id}` | never |
| mark unwatched | `DELETE /watched/{id}` | never |
| remove from Continue Watching or Next Up | `PUT /home/dismissals/continue_watching/{id}` with the card's `progress_updated_at`, or `PUT /home/dismissals/next_up/{id}` with its `series_id` (`dismissHomeItem`) | never |

Gating: `decodePersonalCapability` is true only when `state === "available"`, `allowed` and `membership_supported` are all true (`src/contracts/v2/details.ts`).
Mutations are sent once, with refresh replay off, and repeat only when the person presses again (comment in `detailOperations.ts`).
The card menu reads watched, Favorites and Watchlist from the card's own `user_state` (`is_favorite`, `in_watchlist`), as Apple's MediaCard does; it reads the item only for a card that carries none.
The list screens decode the same capability with a second decoder in `src/ui/personalLists.ts`, which requires a `revision` string.

### Recommendations

Defined in `src/api/recommendationOperations.ts`.
Bearer plus Profile, both safe.

| Operation | Method and path |
| --- | --- |
| discover | `GET /recommendations/discover?image_size=small` (or the artwork query passed in) |
| section | `GET /recommendations/section/{kind}?limit=60&image_size=small[&key=]` |

### Calendar

`getCalendar` in `src/api/calendarOperations.ts`: `GET /calendar?start&end&timezone&filter`.
Bearer plus Profile, safe.
The request throws `RangeError` before sending if:

- `start` or `end` is not a date key,
- `end` is before `start`,
- the window is longer than 30 days,
- `filter` is not `following`, `trending` or `everything`,
- the timezone is empty or not a valid IANA zone.

The decoder rejects any day outside the requested window.
The Calendar view preserves these server day groups and event order without capping events.
An `air_at` instant displays in the accepted query timezone with an explicit 12-hour clock.
Without an instant, `air_time` is interpreted as a device-local wall clock and formatted with the same 12-hour clock, as Apple's `DateFormatters.localShortTime(fromWallClock:)` does.
Date-only releases have no time pill.

Following, Trending and All sit above one week strip: previous, seven stacked weekday/day cells, next, conditional Today, and month/year anchored on Thursday.
Dots mean that the loaded response contains events for that date; pending days carry no confirmed event state.
The strip has one focus zone, preserves control keys, and enters on the selected day.
Artwork keeps the existing URL validation and missing/failed-image fallback, with release badges at top left, a watched check at top right and time at bottom right.
Captions retain title, episode identity and unavailable-destination information, and the accessible card name includes the overlays.

Presentation references are Apple `Screens/Calendar/CalendarView.swift`, `CalendarFilterBar.swift`, `CalendarWeekStrip.swift`, `CalendarDayShelf.swift`, `CalendarEventCard.swift`, `CalendarModels.swift` and `CalendarWeek.swift` at `9723df007baa8e933f5615cc14b13e99a6ee1ea1`.
These shared Swift screens contain the tvOS implementations; the shell and focus style live under `tvOS/`.
The issue's `1a7cceea` reference differs only in the Calendar card's shared focus style, now `TVCardOutlineButtonStyle`.
The 84×96 day cells, 26 bold day number, 8 dot, 64×64 chevrons, 18 strip gap and 10 day gap come directly from that source.
The CSS compensates the 18 strip gap by -8 between adjacent days to retain the source's 10 day gap without another focus owner or wrapper.
Calendar enters on the active filter and the strip enters on the selected day without changing that selection when cards gain focus.
Shelf zones use the shared spatial focus owner and retained horizontal axis, so vertical return chooses the nearest card and retains the row's scroll.
The shared scroll owner supports declarative top and bottom alignment: strip entry restores the page top, while shelf entry keeps its heading and cards visible.
The signed comparison's strip position is 281 pixels; the web filter's inherited action-row margin is removed and its strip gap accounts for the measured 66-pixel filter height.
Card titles use Apple's `siloCardTitle` alias (28 semibold), and 22-pixel metadata is restricted to one line with an ellipsis.
Empty weeks show the filter-specific Apple copy and links to the other two filters.
The existing shell, focus host, artwork fallback, session invalidation and remote Back chain retain ownership.
Loading has a blank focusable 320-pixel placeholder; empty weeks have a calendar icon and light primary filter links, without an extra Back button.
Errors without retained data use the shared error mapping and placeholder builder: triangle, headline, message and a 200-pixel Try Again button.
As in Apple, a quiet refresh retains cached events rather than replacing them with a loading page.
Today updates the week and selected date without requesting filter focus; Tizen keeps a valid focus target on the selected strip day when Today disappears.
The bundled Inter font and SVG symbol substitutes still require native comparison against SF Pro and SF Symbols.
Desktop UI checks cover remote behavior and both motion settings; signed Samsung, matched Apple captures and physical-TV calibration remain separate acceptance gates.

### Requests

Defined in `src/api/requestOperations.ts`, all under `/requests`.
Bearer plus Profile.
`media_type` must be `movie` or `series`, and `tmdb_id` a positive integer; otherwise `RangeError` is thrown before sending.

| Operation | Method and path | Retry |
| --- | --- | --- |
| status | `GET /requests/status` | safe |
| discover | `GET /requests/discover` | safe |
| row | `GET /requests/discover/rows/{key}?page=` | safe |
| search | `GET /requests/search?q&media_type=all&page=` | safe |
| detail | `GET /requests/detail/{type}/{tmdbId}` | safe |
| mine | `GET /requests/mine?limit=24[&cursor=]` | safe |
| get one | `GET /requests/{id}` | safe |
| create | `POST /requests` with `media_type`, `tmdb_id`, `title` | never |
| cancel | `POST /requests/{id}/cancel` (empty object body) | never |
| remove | `DELETE /requests/{id}` (204, no body) | never |
| follow | `PUT /requests/follows/{type}/{tmdbId}` | never |
| unfollow | `DELETE /requests/follows/{type}/{tmdbId}` | never |

Gating: the Requests section is shown only when `status` decodes as `requests_enabled`, `allowed` and `state === "available"` (`decodeRequestsCapability`).
A failed probe keeps the last confirmed capability (`src/ui/browse.ts`).
`follow_supported` is also decoded.
`remove_failed_supported` is optional. Absent means false. A non-boolean is rejected. Remove Request is offered only when requests are available and the flag is true.

### Shuffle

Defined in `src/api/shuffleOperations.ts`.
Bearer plus Profile.

| Operation | Method and path | Retry |
| --- | --- | --- |
| capabilities | `GET /shuffles/capabilities` | safe |
| create | `POST /shuffles` with `{ "scope": { "kind": "library", "id": ... } }` | never |
| advance | `POST /shuffles/{id}/advance` with `{ "from_content_id": ... }` | safe |

Shuffle is offered only when `allowed` is true, `state === "available"`, and `scope_kinds` includes `library` (`canShuffle`, `src/ui/browse.ts`).
Creation is sent once with refresh replay off.
A 404 on create shows "This is no longer available to shuffle."
`advance` runs when the current item finishes (`src/player/nextShuffle.ts`).

### Watch Together (hub, lobby, ballot and room socket)

Defined in `src/api/watchTogetherOperations.ts`. The Watch Party hub (`src/ui/watchPartyHub.ts`) calls `capabilities`, `createRoom`, `joinByCode`, the host's lobby calls below, `picker` and, when the host ends the party, `closeRoom`.
Back and Leave party only close this TV's room socket, for the host too, as Apple's `leaveRoom`.
The hub also reads `GET /playback/capabilities` for the playback features Apple requires, and reads the chosen title with `getCatalogItem` and the picker's series with `listSeriesSeasons` and `listSeasonEpisodes`.
Bearer plus Profile.
`room`, `socketTicket`, `picker` and the ballot calls also send `X-Room-Token` (`RequestSpec.roomToken`).
The host's calls take no room token: the contract authorizes them by account and profile, as it does `closeRoom`, and each answers with the room as it now stands, which replaces the lobby's room unless a newer socket snapshot already has.

The room socket (`src/ui/watchPartySocket.ts`) keeps the lobby current, as Apple's, which never polls.
Each connection attempt reads `room`, mints a single-use `socketTicket` with the renewed room token, and opens `wss://<base>/api/v2/watch-together/rooms/{id}/ws` offering the subprotocols `silo.room.v2` and `silo.ticket.<ticket>` (`roomSocketHandshake`); the address comes from the session's API root, never from a screen.
A server that answers with any other subprotocol is refused.
Snapshots replace the room unless they are older (`RoomState`); `room_closed`, a snapshot in the `ended` phase, `connection_replaced` and a 409 end the party for this TV; 401, 403, 404, 410, a malformed answer or a frame that breaks the contract end it as expired.
Any other failure reconnects after 1, 2, 4, 8, then 15 seconds, for as long as the room is open; a socket that stayed open 30 seconds, which the server ends at its connection deadline, reconnects at once.
The open socket sends `ping` every 2 seconds until four pongs set the server clock offset (`RoomClock`), then every 15.
Leave, Back, End party, sign-out and a profile switch close the socket with code 1000.
A guest's I'm ready sends `{ "type": "lobby_ready", "ready": true }` on the open socket when the capabilities say `lobby_ready`; the snapshot that follows marks the seat, and nothing is sent while the socket is not open.
In a vote room the lobby reads the ballot (`suggestions`, every page) 200 ms after the socket opens and after each `suggestions_update`, one read at a time, as Apple's; a read that falls due while a change runs, including the host's own switch to voting, runs when that change finishes.
A failed ballot read tries again after 1, 2 and 4 seconds, and a vote the server accepted stands even when the read after it fails.
The host's Start in a vote room waits until the ballot has been read on the current socket connection, since a ballot from before an outage may name a stale winner.
Suggestion posters, on the cards and as the lobby backdrop, are drawn only from the server's own origin: the server stores whatever the suggesting client sent, so a poster on another host (such as presigned storage) shows the blank poster.
`suggestions_update` replaces the tallies at once but always says `voted_by_me: false`, so this profile's own votes come only from that read; a read that a socket update or a vote overtook is dropped and read again, up to three times (`RoomVotes`, `src/ui/watchPartyVotes.ts`).
Voting and Add suggestion read the ballot again afterwards, including after a failure, since a lost answer may have landed.
The host's Start in a vote room promotes the winner: most votes, then the earlier suggestion, then the smaller id; nobody voting is no winner.
Transport commands arrive on the socket but nothing uses them yet (issue 54).
The packaged `.wgt` sends `Origin: file://` on the handshake; the server's origin check treats a non-web scheme like no `Origin` and lets it through, and refuses a foreign web origin with 403.

| Operation | Method and path | Retry |
| --- | --- | --- |
| capabilities | `GET /watch-together/capabilities` | safe |
| createRoom | `POST /watch-together/rooms` with `{ "room_id": <uuid>, "selection_mode": ... }` | safe (the `room_id` makes a replay return the same room) |
| joinByCode | `POST /watch-together/join` with `{ "code": ... }` | safe |
| room | `GET /watch-together/rooms/{id}` | safe |
| closeRoom | `DELETE /watch-together/rooms/{id}`, host only, 204; no room token | safe |
| stageSelection | `PUT /watch-together/rooms/{id}/staged-selection` with `{ "content_id": ... }`, host only | safe (natural idempotent) |
| selectItem | `PUT /watch-together/rooms/{id}/selection`, for a party that is already playing, host only | never (non-retryable) |
| startPlayback | `POST /watch-together/rooms/{id}/playback/start`, host only | never (non-retryable) |
| stopPlayback | `POST /watch-together/rooms/{id}/playback/stop`, host only | safe |
| setSelectionMode | `PATCH /watch-together/rooms/{id}/selection-mode` with `{ "selection_mode": ... }`, host only | safe |
| setGuestControlPolicy | `PATCH /watch-together/rooms/{id}/policy` with `{ "guest_control_policy": ... }`, host only | safe |
| picker | `GET /watch-together/rooms/{id}/picker` | safe |
| socketTicket | `POST /watch-together/rooms/{id}/ws-ticket` | safe |
| suggestions | `GET /watch-together/rooms/{id}/suggestions?limit=100&cursor=` | safe |
| addSuggestion | `POST /watch-together/rooms/{id}/suggestions` with `{ "suggestion_id": <uuid>, "content_id", "content_type": "movie" or "episode", "title", "subtitle"?, "poster_url"? }`, 201 | safe (the `suggestion_id` makes a replay return the same suggestion) |
| setVote | `POST` to vote, `DELETE` to take it back, `/watch-together/rooms/{id}/suggestions/{suggestionId}/vote`, 204 | safe |
| promoteSuggestion | `POST /watch-together/rooms/{id}/suggestions/promote` with `{ "suggestion_id": ... }`, host only | never (non-retryable) |

Everything is offered only when `allowed` is true and `state === "available"` (`watchTogetherAvailable`, `src/contracts/v2/watchTogether.ts`).
See `src/contracts/v2/README.md` for the socket frames and the operations left for later.

### Playback plan, progress and stop

Defined in `src/api/operations.ts`.
Bodies are typed in `src/contracts/v2/playback.ts`.
All are Bearer plus Profile, with refresh replay left at its default.

| Operation | Method and path | Retry |
| --- | --- | --- |
| getPlaybackCapabilities | `GET /playback/capabilities` | safe |
| startPlayback | `POST /playback/start` | never |
| replanPlayback | `POST /playback/{sessionId}/replan` | never |
| updatePlaybackProgress | `POST /playback/{sessionId}/progress` | never |
| stopPlayback | `DELETE /playback/{sessionId}` with a JSON body | never |
| getPlaybackConnection | `GET /playback/connection` | safe |
| resetPlaybackLearnedLimit | `DELETE /playback/connection/learned-limit` | never |
| playback defaults | `GET /settings/values/effective?keys=...` | safe |

Gating (`src/player/controller.ts`): playback proceeds only when the capability answer has `state` available, `allowed`, protocol version 3 in `protocol_versions`, an `installation_id`, and an active profile.
Otherwise the player fails with "unavailable".
The `trickplay_v1` feature enables seek thumbnails.

The controller sends playback mutations once through the transport and handles resends itself (`resend`, waiting 1 s then 2 s, or the `Retry-After` value when it is longer).
It resends only after a transient `ApiError`, with the identical body.
The identities that stay fixed across resends are:

- `playback_attempt_id` for start,
- `replan_request_id` for replan,
- `stop_id` (a UUID) for stop.

Progress is sent with an increasing `sequence`; a new sample is not sent while one is in flight.
Stop waits for the sample in flight, uses the next sequence, and checks the receipt: outcome `stopped` or `replayed`, and the same `stop_id`.
A failed progress sample with 410, 404 or Problem `installation_changed` ends playback.
Other progress failures are ignored, because the next sample is newer.
Progress samples are due every 10 s (`PROGRESS_INTERVAL_MS`, `src/player/controller.ts`).

Stream URL authentication: AVPlay cannot send headers.
When the plan's `stream.url` has the API origin (root-relative URLs are resolved below `baseUrl`), the controller appends `token=<access token>` from `mediaToken`.
The token is never added to a URL on another origin.
URLs failing `isPermittedUrl` fail the playback.
The code comment calls this a "Gate C candidate" from silo-server's `docs/playback-api.md` (at the commit in `src/contracts/v2/SOURCE`), so the server's acceptance of the `token` query on stream and subtitle URLs is not marked final.
On `visibilitychange` the stream URL is rebuilt with a fresh token (`urlWithToken`).

### Markers

`GET /markers/files/{fileId}` (`src/api/markerOperations.ts`).
Bearer plus Profile, safe.
The decoder checks the answer against the requested file id.
The call is made from `src/player/controller.ts`.

### Trickplay

Defined in `src/api/trickplayOperations.ts`.
Bearer plus Profile, safe.

| Operation | Method and path |
| --- | --- |
| trickplay availability | `GET /watch/{contentId}?file_id=` |
| manifest | `GET /watch/{contentId}/trickplay?file_id=` |

`SeekThumbnails` (`src/player/seekThumbnails.ts`) checks that the file is listed, then fetches the manifest.
It renews the manifest 30 s before expiry, or once when a sheet fails to load, and backs off 30 s after a failure.
Sheet URLs come from the manifest: root-relative paths get the API origin, and the URL must pass `isPermittedUrl`.
Sheets load as plain images (`src/player/seekThumbnailView.ts`), and no credential is added to them.

### Subtitles and AI subtitles

Defined in `src/api/subtitleOperations.ts`, `src/api/subtitleAIOperations.ts`, `src/api/subtitleSearchOperations.ts` and `src/api/subtitleDisplayOperations.ts`.
All are Bearer plus Profile.

| Operation | Method and path | Retry |
| --- | --- | --- |
| subtitle appearance | `GET /settings/subtitle-appearance/effective` | safe |
| subtitle sync | `GET /settings/values/effective?keys=player.subtitle_sync_ms` | safe |
| save series subtitle | `PUT /subtitle-prefs/{seriesId}` | never |
| AI status | `GET /subtitles/ai/status` | safe |
| AI quota | `GET /subtitles/ai/quota` | safe |
| AI languages | `GET /settings/contract` | safe |
| create AI job | `POST /subtitles/ai/translate` | never |
| AI job | `GET /subtitles/ai/jobs/{id}` | safe |
| subtitle provider status | `GET /subtitles/providers/status` | never |
| subtitle search | `POST /subtitles/search` | never |
| subtitle download | `POST /subtitles/download` | never |
| subtitle delay | `PUT /settings/values/player.subtitle_sync_ms?scope=` | never |
| subtitle appearance write | `PUT /settings/values/playback.subtitle_appearance?scope=` | never |
| clear device appearance | `DELETE /settings/values/playback.subtitle_appearance?scope=profile_device` | never |
| clear device subtitle delay | `DELETE /settings/values/player.subtitle_sync_ms?scope=profile_device` | never |

Subtitle file text is fetched by `NativeHttp.subtitleText`, which is not an API operation.
It checks that the URL passes `isPermittedUrl` and has no embedded credentials.
It sends no headers and no cookies, errors on redirects, and refuses bodies over 4 MiB.
For a URL on the API origin the controller adds `token=<access token>` first.

AI subtitles (`src/player/subtitleAI.ts`):

- Translation is offered only when status `state` is `available`, `allowed` and `enabled` are true.
- Transcription additionally needs `transcribe_enabled`, and a quota that is not exhausted.
- Create is sent once.
- A failure with a Problem id that is non-transient, or a 429, is treated as certain; any other failure leaves the job "uncertain" and blocks another start.
- Jobs are polled with `GET /subtitles/ai/jobs/{id}` until `completed`, `failed` or `cancelled`.

Subtitle search (`src/player/subtitleSearch.ts`) stays offered until provider status says the viewer is not allowed, the state is not `available`, or providers are not enabled. A failed probe is not retried and does not change that. Search and download are each sent once. A stored subtitle is selected through the existing track owner. An uncertain download is not sent again while the menu stays open.

Subtitle delay and appearance (`src/player/subtitleDisplay.ts`) are shown only when the settings contract advertises `player.subtitle_sync_ms` and `playback.subtitle_appearance`, and only while the selected subtitle is not burn-in or text AVPlay is drawing itself. A scope is a name, or `{ "scope", "introduced_in" }` from that revision; delay's profile scope starts at revision 19. Delay is clamped to ±10000 ms and written at profile scope, or `profile_device` when "Only on this TV" is on or the manifest revision is below 19. The offset moves cues this app draws. AVPlay has no subtitle-offset call, so text it draws itself is not shifted; a TV has to confirm whether that platform can move its own TEXT track.

### Theme music

Defined in `src/api/themeMusicOperations.ts`. Bearer plus Profile. Used only when the profile opted in (`ui.theme_music_enabled`). See [Theme music](settings.md#theme-music).

| Operation | Method and path | Retry |
| --- | --- | --- |
| themeCapability | `GET /catalog/themes/capabilities` | safe |
| themePlayback | `POST /catalog/items/{owner_id}/themes/{theme_id}/playback`, body `{ "accepted_formats": [{ "container", "audio_codec" }] }` or none | safe |

- The capability counts only when `state` is `available` and `allowed` is not false. The answer stands for 60 s.
- A grant carries `url`, `delivery` (`original` or `converted`), `content_type` and `expires_at`. It lasts at most five minutes, so a loop of a converted theme asks for a new one.
- `url` is root-relative (this server's audio route) or an absolute proxy URL. It is resolved with `artworkUrl`, which refuses anything but HTTPS (or HTTP from an HTTP server). It authorizes itself by its token, so no credential is added. It is never logged, stored or shown.
- `accepted_formats` is built from `canPlayType` on this TV's Chromium. With no body the server sends the original; with `mp4`/`aac` accepted it may convert to progressive AAC in MP4.
- The audio route (`GET|HEAD .../themes/{theme_id}/audio?token=`) is read by the `<audio>` element, not by `NativeHttp`.

### Settings

Defined in `src/api/settingsOperations.ts`.
All are Bearer plus Profile.

| Operation | Method and path | Retry |
| --- | --- | --- |
| capabilities | `GET /settings/contract/capabilities` | safe |
| contract | `GET /settings/contract` | safe |
| explicit values | `GET /settings/values?scope=&keys=` | safe |
| effective values | `GET /settings/values/effective?keys=` | safe |
| hidden libraries | `GET /settings/values/effective?keys=ui.disabled_library_ids` (`hiddenLibraries`, `src/api/operations.ts`, called from `src/ui/browse.ts`) | safe |
| overlay config | `GET /settings/overlay-config` | safe |
| set | `PUT /settings/values/{key}?scope=` with `{ "value": ... }` | never |
| reset | `DELETE /settings/values/{key}?scope=` | never |

Gating and error handling:

- Settings code first reads `/settings/contract/capabilities` to learn whether batched effective reads are supported.
- A 404 or 501 on that read leaves the setting unsupported in the presentation code (`src/ui/presentationSettings.ts`).
- Values are decoded against the key's expected type, and set rejects a wrong type before sending.
- Set and reset resend after a 401 refresh only if the method is GET, so neither is resent (`src/ui/settingsState.ts`).
- 403, 422 and 429 on a write surface as errors to the person. A 404 on reset counts as already absent.

## Failure handling summary

| Situation | Behaviour | Where |
| --- | --- | --- |
| 401 on a profile-scoped or account call | One refresh, then one resend unless replay is off. | `NativeSession.call` |
| Refresh answered 401, 400 or 422 | Session ended, credentials cleared. | `refreshNow` |
| Refresh unavailable | `SessionError("unavailable")`, tokens kept. | `refreshNow` |
| 403 `profile_verification_required` with a PIN proof | Profile cleared as `profile_proof_revoked`. | `NativeSession.call` |
| Account or profile change | In-flight requests abort; late answers are discarded. | `bump`, `ensureCurrent` |
| Network, timeout, 502, 503, 504 on a `safe` request | One resend after 1 s or `Retry-After` (at most 5 s). | `NativeHttp.send` |
| Unexpected response shape | `invalid_response` with the path only. | `wireDecode` |
| Redirect | Refused as `network`. | `sendOnce` |

## Not confirmed from the code

- The server's `x-silo-retry-safety` annotations (the `openapi.json` file is not in the repo).
- Whether the server accepts the `token` query parameter on stream, subtitle and any other URL (the controller comment calls it a candidate).
