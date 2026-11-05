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
Samsung has no verified remote-trailer playback or handoff, so the tvOS displayability gate keeps this action hidden; adding an unreachable discovery operation would not make it usable.
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
Details table end scrolling is left to #247.

The signed 5 November season comparison at `93a39b3` confirmed pill focus selection and the loaded-season window.
Later fixes keep the pill selection authoritative over stale episode callbacks, use the loaded first-episode summary for the hero and Play label, and restore a retained Series visit on Play with the series overview.
The row reuses the continuous rail's terminal clamp (`TVEpisodeRail.swift:400-414`), including loaded predecessors for a short final season.
Without a loaded neighbour it shows the available episodes; it does not fetch solely to fill empty space.
Season focus and explicit Retry each make at most one season read, without transport retries or neighbour warming after selection.
Episode item details are deferred to playback or opening a version/audio/subtitle control; episode focus itself reads nothing.
Apple uses cached season pages (`ItemDetailViewModel.swift:1143-1156`), guards stale selections (`SeriesSeasonSelection.swift:16-30`), paints episode summaries (`TVSeriesDetailView.swift:448-464,1046-1055`), and skips per-card personal refresh for tvOS Series (`ItemDetailViewModel.swift:1397-1406`).
The shared abbreviated date formatter matches Apple's medium date style (`DetailDateFormatting.swift:77-82`), including English `Sep`.
These follow-up fixes have fake-server and Chromium validation only; the signed comparison predates them.
