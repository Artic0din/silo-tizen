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
Series/season Shuffle remains outside Samsung's current Details capabilities.
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
Different profile state can still produce different suggestions; the reported Highway Patrol result has not been reproduced.

Validation uses fakes and desktop Chromium only.
No live server, simulator, television or signed package comparison has run.
