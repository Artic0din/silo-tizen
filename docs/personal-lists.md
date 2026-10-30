# Personal list pages

The Skyline profile dropdown opens Watchlist, Favorites and History for the selected profile.
Each page renders at most 24 live cards and keeps opaque server continuations.
Favorites offers Movies and TV Shows filters across the entire server result.
Watchlist uses video scope.
History offers Movies & TV Shows (`video`) and Episodes (`episode`) as separate server-filtered results.
Both retain native History ordering and independent opaque pagination, without merging streams in the client.
All lists preserve native source ordering.
Moving focus never fetches data.

Cards open the existing Details route and its playback handoff.
Returning from Details shows cached cards while re-reading the current page's opaque continuation in the existing fenced window.
Focus returns by item identity when that item remains visible; a removed item falls back to the next visible card at its old position, or the last card when it was at the end.
An empty page retains navigation through the existing focus host.
A failed page turn preserves the loaded page and retries the requested continuation.
An invalid cursor clears the obsolete window and Try again starts at page one.
Profile authority changes cancel requests and remove all personal-page data with the browse owner.

Favorites and Watchlist read the personal-list capability before querying.
An unsupported or disallowed capability has an explicit unavailable state.
Malformed responses and transport/server failures offer Try again.
`membership_supported` describes item membership reads, so it does not gate catalog list queries.
List absence never establishes that an item is not a member.

## Contract and integration

Sources are canonical `Silo-Server/silo-apple` commit `148d5d70f8b8ce982a827fead2b16f8de40f0f57` and `Silo-Server/silo-server` commit `cc8514943289045e7b9f7ac8d36d4968bfe93926`.
Apple's Personal Watchlist, Favorites and History screens define the destinations; Favorites supplies the TV media selector and History uses fenced catalog pagination.
Apple's History query factory omits `type`, but that does not expose episodes in the pinned backend's media-items relation.
The public query scope accepts `episode`; the query-only type was extended without widening library media scopes.
The separate History Episodes filter is a deliberate UX equivalent that preserves movies, series and episodes without inventing a mixed scope or continuation order.
The server's OpenAPI defines `POST /catalog/query` with `source=watchlist|favorites|history` as naturally idempotent and profile-scoped.
The existing session supplies profile and PIN proof headers.
`GET /history` has a different response shape and is not consumed here.

`personalLists.ts` exports `PersonalSource`, `PersonalFilter`, `PersonalListCapability`, `decodePersonalListCapability`, `personalListCapability`, `personalQuery`, `readPersonalPage`, `personalView` and `PERSONAL_TITLES`.
The capability helper is read-only and deliberately has no item mutation or membership controller.
The separate Details lane owns item actions; integration only needs to preserve the `item` route identity and the Back lifecycle in `browse.ts`.
The shared route additions are `personal`, `RouteHandlers.personalFilter`, the three catalog query source literals and the optional Skyline profile `personal` callback.

This is the personal-pages portion of issue 29 only.
It does not complete issue 29 or whole-app Apple TV parity.
Desktop Chromium validates behavior, bounded DOM and focus geometry; it does not prove Chromium 76 runtime, signed WGT, emulator or real-TV acceptance.
