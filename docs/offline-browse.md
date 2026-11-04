# Cached browse content

Home and For You retain last-known metadata in optional local snapshots.
Details and season metadata stay in memory for the active authority.
Every visit still requests fresh data; only transport failure or timeout uses a cached response.
HTTP errors, cancellation and writes never use this fallback.
Existing navigation and actions stay available and use their normal server validation and error handling.
This does not download media or enable offline playback.
Snapshots are used only after account and profile authority is established; they do not bypass startup discovery, sign-in or profile/PIN checks.

The scope contains the server ID, account ID and profile ID, never the server address or credentials.
Authority loss clears memory and snapshots and fences pending responses.
Account removal also clears snapshots when no Browse screen is mounted.
Changing any scope component closes the previous cache owner.
Optional storage failures leave the memory cache usable.
URL and credential fields are removed recursively before caching; artwork uses the existing fallback when its URL is unavailable.
Snapshots are decoded with the existing API decoders before use.

The cache has no time expiry.
It keeps at most 32 responses overall, including at most 20 Details/season responses, with a 512 KiB UTF-16 payload budget and a 1 MiB snapshot-read ceiling.
Oldest written responses leave first.
Metadata writes and returning from playback invalidate snapshots, with a generation fence against older reads.
While a cached page is unreachable, the visible route retries its normal reads after 15 seconds.
Cached metadata stays on screen without an unreachable notice, matching Apple TV.
Recovery replaces the metadata.
The app uses native API v2 reads for recovery, because Apple's unversioned health endpoint is outside this client's contract.

## Apple reference

Read-only `origin/main` source: `Silo-Server/silo-apple`, commit `bef81e8652a89c23a1c3cf07e312e9444baa6c4c`.
This identifies source, not an installed Apple build.

- `iosApp/iosApp/Networking/ResponseCache.swift:7-12`: decoded responses, stale while revalidating, no TTL or LRU at this owner.
- `iosApp/iosApp/Networking/ResponseSnapshotStore.swift:15-25`: Home, recommendations, libraries and first browse pages persisted, 32 snapshots per scope; Details are not persisted here.
- `iosApp/iosApp/Networking/ResponseCache.swift:193-200`: server/account/profile snapshot scope.
- `iosApp/iosApp/Screens/Home/HomeViewModel.swift:83-110`: hydrate cached sections and keep painted sections on refresh failure.
- `iosApp/iosApp/Screens/Home/HomeView.swift:53-107`: reachable tvOS feed, Retry/Manage Servers on a cold failure; `:177-185` belongs to the non-tvOS branch.
- `iosApp/iosApp/Screens/Recommendations/RecommendationsViewModel.swift:16-51`: hydrate recommendations and retain them on failure.
- `iosApp/iosApp/tvOS/Caching/ItemDetailCache.swift:34`: 20 view models, bounded LRU.
- `iosApp/iosApp/Screens/Recommendations/RecommendationsView.swift:106-159`: tvOS keeps its Skyline feed with no unreachable notice.
- `iosApp/iosApp/tvOS/Screens/Detail/TVItemDetailView.swift:63-84`: cached Details paints while refreshing, with no unreachable notice.
- `iosApp/iosApp/Networking/ConnectionMonitor.swift:189-190`: 15-second recovery interval; `:264-275` uses a health path Tizen does not call.

Home's `ServerUnreachablePill` at line 180 sits after the non-tvOS `#else` at line 107.
Tizen follows the tvOS branch and keeps cached Home, For You and Details visible without that notice.
Downloads are excluded; no tvOS download flow is ported.
The byte budget, metadata-only artwork fallback, conservative cache invalidation and recovery through page reads are explicit Tizen choices.

## Pending native comparison

No simulator, TV, live server writes or native captures were used for this implementation.
The PR must remain unmerged until same-state Apple/Samsung comparison passes.

1. Build and sign the candidate WGT using the normal release procedure; record its source SHA, package hash, installed assets and actual capture dimensions.
2. On an authorised Samsung debugging session, open Home, For You and a movie/series Details page while connected.
   Capture the loaded states with matching Apple content, focus, selection and scroll.
3. In that session's Web Inspector Network panel, enable offline mode or block the active server's requests after warming the pages.
   Alternatively, in the inspector console, save `window.fetch` and temporarily replace it with a function returning `Promise.reject(new TypeError("Offline test"))`.
   The platform transport calls `window.fetch` dynamically (`src/platform.ts:66`), so this affects the current app session without changing the server.
   Restore the saved function to recover; do not reload the app while that temporary override is required.
4. Navigate away and return, including opening the previously loaded Details page.
   Record retained metadata, artwork fallbacks, absence of an unreachable notice, remote focus and Back navigation.
   Check a cold uncached title and a failed action for honest failure handling.
5. Restore network access and record fresh content after the next recovery read.
   Switch profiles, sign out and remove the saved account in separate runs; verify old content never appears under the new authority.
   Repeat with optional storage unavailable.

Use the Apple platform's own authorised network controls for the same-state unreachable capture.
Record any differences from the tvOS cached-content behavior.
Simulator proof does not establish physical-TV CORS, AVPlay or hardware acceptance.
