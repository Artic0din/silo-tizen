# Details actions

Apple reference: `Silo-Server/silo-apple` at `7baff3ef657757cc0a69202e86dd4bd5c7fcb585`.
All paths below are relative to `iosApp/iosApp/`.

More reuses the Versions, Audio and Subtitles popover.
Movies offer Add to Favorites / Remove from Favorites, then Mark as Watched / Mark as Unwatched (`tvOS/Screens/Detail/TVMovieDetailView.swift:210-265`).
Series add Show Series Info only while an episode is active, then Favorites, Mark Series Watched / Unwatched and the selected season's Mark Season Watched / Unwatched (`TVSeriesDetailView.swift:942-1037` in the same directory).
Actions retain confirmed-state loading, failure and explicit reconciliation before retry.
The season Watched action stays hidden if the season response omits watch state.
Selection closes More and restores its trigger; Back, Left and Right also dismiss.
Apple's popover width is 560, and its initial target is the first selected enabled option or the first enabled option (`TVActionPopoverMenu.swift:33-76`).

Find Trailers queues discovery and polls refreshed item detail; it does not play an existing trailer (`Screens/Detail/ItemDetailViewModel.swift:753-815`).
tvOS offers it only when remote trailers can be displayed (`TVItemDetailView.swift:317-324,481-488`).
The pinned native contract includes `POST /api/v2/catalog/items/{id}/trailers/refresh`.
Samsung's existing rail displays remote cards, so movies and series offer Find Trailers after the watched actions and before Translate Description.
Discovery does not add a YouTube playback handoff: remote cards still have that existing platform limitation.
The request is profile-scoped, non-retryable and never replayed after authentication refresh.
Queued requests poll detail every 3 seconds, observing at least 60 seconds before five unchanged polls may settle, with a 120-second window.
Only new supported-video identities or local extra IDs finish discovery; existing trailers do not count as a new result.
Cooldown, disabled, exhausted, transport failure and rate limit use Apple's status copy, dismissed after three seconds.
Leaving Details cancels observation; returning resumes an interrupted run without another POST, while an authority change discards it.
The found payload updates the rail without resetting the selected season or overwriting newer watch state.
Watch Party stays hidden pending #54's capability, opt-in and device gates (`Screens/WatchParty/WatchPartyEntry.swift:7-24`).
Shuffle Series leads More when the capability supports series and the hierarchy has at least two episodes.
It creates a series-scoped shuffle and uses the existing shuffle pick and player continuation owners (`TVSeriesDetailView.swift:923-928,954-966,1016-1021`).
Season Shuffle remains outside this change.
Translate Description follows the existing server and language gates.
The trailers rail and episode row are unchanged here.

Start Over follows Resume and precedes playback selectors.
It uses the `backward.end.fill` silhouette and the existing circle's 76 by 76 footprint, 38-point icon slot and 26-point focused label (`TVDetailActions.swift:327-385,491-502`).
The label appears on focus; it is icon-only at rest.

Removed Read synopsis and its expanded view because the tvOS hero synopsis is deliberately non-focusable (`TVHeroSynopsis.swift:4-35`).
Removed #66's Rate title control and personal star editor because neither is reachable on tvOS.
External rating data, including TMDB scores, remains visible.
Removed Season details: tvOS season tabs select the inline episode rail and expose only a watched context action (`TVSeriesDetailView.swift:608-647`).
Supporting focus follows Cast, Trailers, Similar, then the Details table (`TVSeriesDetailView.swift:282-289,1114-1180`).
Down at the final available section keeps its current focus; no empty supporting-control zone remains.

For series rewatch, Apple chooses the requested season, an in-progress season, a partially watched season, the first unplayed numbered season, Specials, or the first numbered season.
It then chooses an in-progress episode, the first unwatched episode, or the first episode (`Networking/Models.swift:874-909`, `Screens/Detail/ItemDetailViewModel.swift:1115-1125`, `TVItemDetailView.swift:786-795`).
Samsung's season selection already uses the same rollup fields.
Episode progress now reads `user_data.is_in_progress`, matching Apple's `LeafItemUserData` projection (`Networking/APIv2/APIv2CatalogReadProjection.swift:203-210`), instead of the aggregate `in_progress_count`.
The hero now uses that rail suggestion instead of the catalog's separate `play_content_id`.
The signed same-state comparison on 5 November 2026 at `3262f8b` reproduced a known difference: Apple opened Highway Patrol on S13:E1 and Running Point on S2:E1, while Samsung opened both on S1:E1.
The tvOS view obtains a cached view model (`TVItemDetailView.swift:60-69`), preserves its selected season as `initialResumeSeasonNumber` (`:150-167`), and prefers that request (`ItemDetailViewModel.swift:1119-1125`).
Fresh hierarchy selection uses the same preference (`:590-615,980-1010`).
With no requested or cached selection, zero in-progress counts, watched counts equal to episode counts, and every numbered season played, each predicate fails and `regular.first` returns Season 1 (`Models.swift:878-900`).
The episode fallback then returns the first episode (`:904-909`); the watch projection maps `isInProgress` directly and does not choose a season (`APIv2CatalogReadProjection.swift:203-210`).
This source explains how a cached later selection survives, but does not establish that cache caused the observed states or prove a last-played/newest-season rule.
Samsung retains its current server-seeded season selection; no rule was guessed from the two samples.

Validation uses fakes and desktop Chromium only.
The signed comparison above predates these follow-up fixes; no new live server, simulator, television or signed package run was used for their implementation.
More now uses three round six-pixel dots at rest and focus, title-only 54px rows with 56px pitch, and the existing below/above/bottom-pinned placement rule (`TVActionPopoverMenu.swift:237-258`).
The 76px picker rows retain their second-line detail space.
The shorter gated Samsung menu can fit below where Apple's six-item menu opens above; direction is based on available space, not item type.
Unfocused Play now shares the circles' 10% white fill (`TVDetailActions.swift:356-360,701-707`), allowing the existing backdrop to show through without a filter.
Synthetic warm, neutral and cool underlays verify the supplied sRGB targets within two levels; actual title backdrops still need a signed comparison.
The season pill row now uses `TVDetailLayout.horizontalInset` (100 points) rather than the surrounding section's 88px inset.

The signed 5 November season comparison at `93a39b3` confirmed pill focus selection and the loaded-season window.
Later fixes keep the pill selection authoritative over stale episode callbacks, use the loaded first-episode summary for the hero and Play label, and restore a retained Series visit on Play with the series overview.
The row reuses the continuous rail's terminal clamp (`TVEpisodeRail.swift:400-414`), including loaded predecessors for a short final season.
Without a loaded neighbour it shows the available episodes; it does not fetch solely to fill empty space.
Season focus and explicit Retry each make at most one season read, without transport retries or neighbour warming after selection.
Episode focus paints its summary immediately and reads missing full detail after Apple's 120ms dwell; playback and version/audio/subtitle activation can resolve it immediately.
Apple uses cached season pages (`ItemDetailViewModel.swift:1143-1156`), guards stale selections (`SeriesSeasonSelection.swift:16-30`), paints episode summaries (`TVSeriesDetailView.swift:448-464,1046-1055`), and skips per-card personal refresh for tvOS Series (`ItemDetailViewModel.swift:1397-1406`).
The shared abbreviated date formatter matches Apple's medium date style (`DetailDateFormatting.swift:77-82`), including English `Sep`.
These follow-up fixes have fake-server and Chromium validation only; the signed comparison predates them.

The signed 6 November re-check at `b2f34a2` superseded the loaded-predecessor spacing assumption.
Fresh opens and pill moves use no extra 40px clearance; the general offset has been removed.
Apple's measured retained-title reopen offset remains a known difference: Samsung retains the season number without retaining Apple's view-model and rail lifecycle.
The existing terminal clamp is unchanged.
Season pills use Swift's 24px horizontal padding, 12px gap, medium unselected text and semibold selected text.
Cached playback details supply hero readouts; summary-only episodes omit unavailable values instead of leaving permanent skeleton bars.
Loaded-season moves perform no season-page reads.
At Apple source `df891d2e`, `TVSeriesDetailView.swift:879-906` activates the focused episode and `TVItemDetailView.swift:805-858` reads playback metadata after 120ms.
Samsung now uses the same dwell for missing catalog detail, reusing the existing version/track owners and four-worker queue.
Leaving a card cancels its dwell and superseded queued focus reads; explicit requests survive cancellation, whether requested before or after the dwell.
Retained episode owners do not reread on focus and failures require explicit Retry.
Tizen keeps 16 recent settled playback owners per route, excluding owners protected by current playback selection, pending reads/panels or unfinished user work.
Evicted episodes reload on a later dwell.
Apple's `ResponseCache.swift:6-12,24-34` at `df891d2e` deliberately has no TTL or LRU and clears item data on memory warnings.
Tizen uses a small route-local window because its cached entries also own preference state and authority listeners; there is no Apple numeric capacity to copy.
AGENTS.md names this episode-detail dwell as an approved no-focus-fetch exception for Apple TV parity; see [TV focus](../tv-focus.md).
Full version duration drives the hero runtime, while the card retains the episode-list runtime (`TVDetailHero.swift:721-734`, `SelectedMediaRuntime.swift:4-28` at that SHA).
This change has fake-server and desktop Chromium proof; same-state Apple/Samsung comparison and signed simulator journeys remain pending on the other Mac.
Selected-season failures stay with their failed season rather than appearing below a loaded neighbour.
Connectivity returning alone does not retry the row: `TVSeriesDetailView.swift:734-737,805` calls `retryHierarchy` only from Retry buttons, and `TVItemDetailView.swift:308` forwards that action to `retrySeriesHierarchy`.
Explicit Retry reads the failed season once.

Each Details route presentation has its own focus-host visit key, so a fresh presentation opens on its primary action at scroll zero without deleting an ancestor's snapshot.
The key is assigned where all item routes render, including available-to-request Search results that push a route directly.
This does not clear route-owned selected-season state when returning from an episode information page or repainting the current page.

The #247 scroll audit at the Apple SHA above found these distinct owners, all under `tvOS/Screens/Detail/`:

- `TVMovieDetailView.swift:102-131` gives the hero an id and attaches `detailFocusScroll`; `TVDetailFocusScroll.swift:70-81,94-105` pins actions to the hero's top and centers the complete focused poster section.
- `TVSeriesDetailView.swift:153-177` computes the supporting anchor's midpoint minus half the viewport height, clamped to the content range; `:1105-1166` centers the first available supporting section (Cast, otherwise Trailers, otherwise Recommended).
- `TVTrailersRail.swift:27-33,50-56` groups heading and rail with 14-point spacing, pads the rail vertically by 12 and gives its first card default focus; it specifies no vertical scroll offset.
- `TVDetailFactsSection.swift:14-22,24-61` makes the whole table one passive focus target with a 14-point vertical highlight bleed; it specifies no explicit scroll anchor.
- `TVDetailHero.swift:18` supplies 140 points of bottom content padding; both page bodies apply it (`TVMovieDetailView.swift:120`, `TVSeriesDetailView.swift:292`).

`SkylineScroll` owns the heading-based reveal rule; the focus host passes the previous focus to distinguish Up from Down.
The settled running Apple app at `7baff3e` on 6 November 2026 supplies Down heading targets Cast 546, Trailers 501 and Series posters 547, and Up heading 111.
Apple's trailer image starts 69px below its heading, matching Samsung's 69.2px; its focused frame includes about 44px of padding above the image and is not comparable to Samsung's card frame.
Movie Related uses heading 321 and Series Cast uses 367 in both directions because the local complete section heights differ from Swift's centered anchors.
Up resets to zero when the heading and focused artwork are fully visible there, including Movie Cast at heading 690.
Horizontal moves preserve the section's vertical position; hero actions, season pills and episode rows stay at scroll zero.
Details scrolls to `scrollHeight - clientHeight`, with 140px of total bottom padding from `TVDetailLayout.pageBottomPadding` and no duplicate facts margin.
This removes 540px of duplicated Series bottom space; the earlier approximate 516px page-height difference also includes content/layout differences.
With representative five-row Movie and six-row Series fake tables, Details headings are 528.61 and 457.41: residuals +4.61 and +5.41 against Apple's 524 and 452.
The fake page heights are 2664 and 3171, so their absolute page maxima do not substitute for the captured titles' maxima.
Tests assert directional headings within three pixels, the movie stack 291/334/450/492/556, top resets, page-end arithmetic and the stated Details residuals.
The route-isolation and scroll changes need a new signed same-state re-check.
No simulator, TV, live server or signed package was used for this follow-up.

Metadata already includes the outlined rating chip and rating artwork (`TVDetailHero.swift:360-446`); Related Movies and Recommended Series already match (`TVMovieDetailView.swift:289`, `TVSeriesDetailView.swift:1117`).
The optional advisory-age chip (`TVDetailHero.swift:450-453`) remains the outstanding #247 implementation item: Swift requires `AdvisoryAgePreferenceStore.showsAdvisoryAge`, which has no corresponding preference owner here.
Adding that preference lifecycle falls outside this scroll change, so #247 stays open.

The later comparison must cover Movie and Series fresh opening and reopening after Cast/table scroll; Up through every hero action; return from episode information with Season 2 selected; focused middle and terminal Details tables; first and subsequent trailers with and without Cast; Related Movies and Recommended Series; rated metadata with advisory preference off/on; and the rest hero including the movie stack y291/334/450/492/556.
Repeat Series rail entry, horizontal terminal clamp and Up return at Compact, Standard and Large to protect #246.

## Remaining hero appearance (#274)

Source: [silo-apple b3d08d44](https://github.com/Silo-Server/silo-apple/tree/b3d08d444b75dc078d3047730db72e0c4456e79b/iosApp/iosApp/tvOS/Screens/Detail).
`TVDetailCastRail.swift:39` disables scroll clipping; the Samsung Cast viewport now extends through the right page inset while retaining horizontal scrolling.
`TVEpisodeRail.swift:693-725` uses a 20pt semibold single-line anchored caption at the full card width, with tail truncation for titles that still exceed it.
Samsung removes its inherited caption inset and medium-weight override rather than wrapping beyond Apple's single-line limit.
`TVSeriesDetailView.swift:467-494` and `TVDetailHero.swift` place episode date/runtime before ratings and Season/Episode after ratings.
`TVSeriesDetailView.swift:1221-1245` uses borderless season capsules, with white fills of 20% when selected and 5% otherwise.
`TVHeroSynopsis.swift:21` uses white at 92% opacity for the overview.
`TVActionPopoverMenu.swift:50` uses Liquid Glass with black at 45% opacity.
Samsung uses that translucent tint as the substitute; it does not reproduce Apple's Liquid Glass sampling and refraction.
Desktop Chromium fake-server checks establish CSS values and ordering only.
Signed Samsung and same-state Apple TV acceptance remain outstanding on the other Mac.
