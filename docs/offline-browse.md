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
Account removal also clears that account's snapshots when no Browse screen is mounted, including when discovery fails offline.
Signing out or forgetting one saved account preserves another account's active cache and snapshot.
The cache authority listener is attached before restore and the saved-session reuse shortcut, and to the separate session used to revoke a saved account.
Changing any scope component closes the previous cache owner.
Optional storage failures leave the memory cache usable.
Persistent snapshots strip URL and credential fields recursively.
In-memory responses retain full artwork URLs, including signed backdrops, title art and cast portraits, for the active session.
Persistent snapshots still omit every URL; a cold reload cannot restore signed artwork from those snapshots.
Images are not downloaded, so reuse also depends on the image being available in the browser cache or still reachable.
Snapshots are decoded with the existing API decoders before use.

The cache has no time expiry.
It keeps at most 32 responses overall, including at most 20 Details/season responses, with a 512 KiB UTF-16 payload budget and a 1 MiB snapshot-read ceiling.
Reads touch the response eviction order.
Home enrichment has its own owner and cannot populate or evict the visited Details pool.
Up to 20 visited Details states retain supporting display reads in memory.
Personal-write reconciliation and confirmation always require fresh reads.
Metadata writes and returning from playback invalidate snapshots, with a generation fence against older reads.
While a cached page is unreachable, the visible route retries its normal reads after 15 seconds.
Cached metadata stays on screen without an unreachable notice, matching Apple TV.
Optional personal, next-episode, title-art and related reads retain prior display values on transport failure.
Uncached optional failures omit the corresponding unavailable content rather than adding red notices.
Failed episode hierarchy reads still show the episode Retry alongside retained episodes, as Apple TV does.
With cached episodes, "Couldn't load episodes." and the inline "Retry" appear below the rail at 18px, in their own remote focus row.
Without episodes, the error uses 22px text and a Retry below it.
An uncached Details failure uses the centred warning, headline, message and "Try Again"; remote Back returns to the previous page.
When the episode Retry disappears and focus returns to the primary action, the hero returns into view.
Recovery replaces the metadata.
The app uses native API v2 reads for recovery, because Apple's unversioned health endpoint is outside this client's contract.

## Apple reference

Read-only `origin/main` source: `Silo-Server/silo-apple`, commit `7baff3ef657757cc0a69202e86dd4bd5c7fcb585`.
This identifies source, not an installed Apple build.

- `iosApp/iosApp/Networking/ResponseCache.swift:7-12`: decoded responses, stale while revalidating, no TTL or LRU at this owner.
- `iosApp/iosApp/Networking/ResponseSnapshotStore.swift:15-25`: Home, recommendations, libraries and first browse pages persisted, 32 snapshots per scope; Details are not persisted here.
- `iosApp/iosApp/Networking/ResponseCache.swift:193-200`: server/account/profile snapshot scope.
- `iosApp/iosApp/Screens/Auth/AccountSessions.swift:30-60`: account switching cancels requests and clears memory while keeping account-scoped snapshots; this shared path is reachable on tvOS.
- `iosApp/iosApp/Screens/Auth/AuthService.swift:1064-1067,851-876`: account-change reset clears response memory and the tvOS Details owner.
- `iosApp/iosApp/tvOS/Caching/ItemDetailCache.swift:122-128`: clear visited Details at identity boundaries.
- `iosApp/iosApp/Networking/AccountLocalData.swift:95-106`: removing an account purges its own snapshots.
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
The byte budget, sanitised persistent artwork, conservative cache invalidation and recovery through page reads are explicit Tizen choices.
Apple's `tvOS/Caching/ItemDetailCache.swift:25-34,149-160` retains 20 visited view models in LRU order; Home enrichment uses the separate shared response cache.
`Screens/Detail/ItemDetailViewModel.swift:385-390,570-622,1431-1433` preserves cached detail, hierarchy and personal values.
`tvOS/Screens/Detail/TVItemDetailView.swift:868-873` retains usable cached next-episode playback detail.
`tvOS/Screens/Detail/TVSeriesDetailView.swift:582-589,801-811` explicitly offers hierarchy Retry, including with cached episodes.

## Pending native comparison

A signed same-state Apple/Samsung comparison ran on 5 November 2026 and identified the Details corrections described above.
Apple could not be taken offline; its offline expectations come from the pinned tvOS Swift source.
These corrections were checked with desktop Chromium and native TypeScript tests only, without simulators, TVs, signed packages or a live server in this follow-up.
A signed comparison of the corrected candidate remains pending, and Ryan retains merge authority.

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
