# Skyline browse shell

This slice applies the [Skyline guide](https://github.com/Silo-Server/silo-apple/blob/main/docs/skyline-design-guide.md) to the native browse owner.
Home, Movies, Series and Profiles share mounted root navigation.
Only visible video library types appear, and mixed libraries can be scoped to either video type.
Search, Detail, season and playback routes remove the root chrome.
The library dropdown offers Recommended, Collections and Browse, in that order, matching the tvOS cascade.
Browse retains the capability-gated Genres, A–Z and Recently Added mode controls.

## Details layout and selection

Movie and episode Details place Play/Resume, Start Over when available, Version, Audio, Subtitles, Watchlist and More in one row.
A passive line shows the selected version, audio and subtitle intent.
Movie and Series share the existing sampled hero backdrop and title typography used by Requests details.
Series next-episode Version, Audio and Subtitles controls reuse the episode Details preference owner; both Resume and Start Over carry its selections.
Auto audio stays server-resolved until a viewer explicitly picks a track.
Local extras and YouTube listings appear together in Trailers & More. Local extras start at zero through the existing player and restore their card on Back.
If the embedded extra omits its file ID, Select resolves its existing catalog versions endpoint before playback; failure keeps Retry on that card and Back cancels the lookup.
YouTube cards use the same rail. Select does not start playback and does not leave Silo, because AVPlay cannot play a site key and no Samsung YouTube handoff has been verified.
More retains watched/favorite actions.
Each dialog owns focus, hides the underlying page from accessibility, and restores its initiating control on Back.
The inline synopsis clamps to three lines with ellipsis, matching the non-focusable tvOS synopsis.
Cast portraits remain 200 px circles, with 60 px gaps and centered two-line names.

Series Details use season chips and an inline landscape episode rail.
Initial selection follows Apple's resume priority: an explicit season, a season with progress, a partially watched season, then an unplayed numbered season before Specials.
Episode-row entry uses the in-progress episode, first unwatched episode, or first episode, and remembers the last focused episode on re-entry.
The rail anchors the current card to the leading slot and applies the profile's poster-size scale to Apple's 360×200 base stills.
Watched episodes carry a check disc over the still, and moving Down to Cast & Crew centres that section in the viewport.
Compact scales the base still to 309.6×172px; terminal focus is bounded by the loaded row's end.
The accepted initial season loads independently; neighbouring seasons then warm at least eight distinct episodes per side, crossing empty pages and stopping at missing or failed pages.
The rail joins contiguous loaded seasons, sorts episodes numerically and removes duplicate content identities.
It retains the nearest five nonempty pages plus enough adjacent pages for eight episodes per side; empty pages remain cached.
These window rules port `Screens/Detail/SeriesEpisodeWindow.swift:26-81` and tvOS `Screens/Detail/TVItemDetailView.swift:924-1002` at `7baff3ef657757cc0a69202e86dd4bd5c7fcb585`.
Re-selecting a loading chip keeps the same request and Calendar episode context.
Moving within the selected loaded season makes no request.
Crossing into another loaded season selects its cached page and warms its neighbours, as `ItemDetailViewModel.swift:1290-1303` does under tvOS.
Re-entering a boundary after a failed neighbour read retries it; existing cards remain usable and show an inline error.
Entry and focus share the stepped offset in `TVEpisodeRail.swift:400-414,436-468`; `SkylineScroll` remains the only scrolling owner.
All DOM cards stay focusable offscreen, providing the predecessor that SwiftUI's lazy stack keeps via its hidden lookbehind (`TVEpisodeRail.swift:331-378`).
The supplied 5 November final-season case has ten S13 episodes and six S14 episodes, with S14E05 focused and one successor.
At Compact size the content width is `16 * 309.6 + 15 * 40 = 5553.6`, and Swift's 1820px viewport gives `ceil((5553.6 - 1820) / 349.6) * 349.6 = 3845.6` maximum scroll.
Swift's leading hover inset is `309.6 * .025 + 2 = 9.74`; its added trailing inset is `3845.6 - (9.74 + 5553.6 - 1820) = 102.26` (`TVEpisodeRail.swift:420-435`, `TVDetailHero.swift:10`).
The hidden lookbehind adds one pitch to both content and viewport and cancels out of this maximum.
The former fourteen-episode S14 fixture never reached this boundary at E05.
`SkylineScroll` preserves fractional CSS widths when calculating the terminal step; integer `offsetWidth` accumulated rounding error at Compact size.
Rendered regression requires focused E05 near x1158 and E06's right edge near x1824.74, within 12px of the approximate supplied x1815 edge.
The existing Tizen leading slot is 7px right of Swift's 100px inset; this is disclosed rather than corrected with an episode-specific offset.
No native comparison has run for this revision.
Accepting a season queues its episode catalog details with at most four reads in flight, deduplicated against the next-up read and this visit's cache.
Season acceptance loads the playback episode; missing focused episode details load after a 120 ms dwell and then start the existing playback/preference owner.
Leaving the card cancels pending focus work, while explicit selector and playback requests retain their queue ownership.
The episode-detail dwell is an approved no-focus-fetch exception; see [TV focus](../tv-focus.md) and [Details actions](details-actions.md).
All cached episodes share a series-wide playback gate while any series preference save is pending or unconfirmed.
A confirmed save refreshes accepted episode details in the same bounded queue, clears other episodes' stale track intents, and retains their selected versions.
Interrupted prefetches resume on return; watched mutations cancel older cache generations before refreshing them.
Focus changes the hero synopsis, metadata, ratings and playback selection target by selecting that cached owner.
The show's title, logo, artwork and starring credit stay fixed.
While a detail is pending or failed, the loaded episode row still supplies its synopsis, air date and runtime; playback selectors wait for validated detail and an explicit Retry can repeat a failed read.
More > Show Series Info restores the overview without a read.
Rail Select carries confirmed version/audio/subtitle selections through the existing fresh catalog and progress resolution route.
Ordinary episode Details/Back retains the selected season, loaded rail and focused episode.
Season tabs select the inline episode rail.
Episode Select on the Details rail and season list prepares playback directly.
Select on shared browse cards opens Details: episodes open their parent series with their season and episode active; movies open themselves.
Remote MediaPlay and MediaPlayPause resume a focused movie or episode through the existing resolution route, including the last-used version on Continue Watching.
The existing resolution route owns catalog/file selection, fresh resume, loading, Retry and cancellation before the player handoff.
It checks fresh progress even when cached progress is zero, while explicit Start Over sends zero without a progress read.
Series and season primary actions resolve the server's target episode on entry and show Play/Resume S#:E#; unavailable metadata or files retain a truthful loading, retry or unavailable action.
Default direct activation uses automatic audio and subtitle selection without borrowing another episode's choices.
Hold Select or right-click an episode to choose Episode information for its full synopsis and visit-only version/audio/subtitle controls.
Calendar retains its existing series-context navigation rather than becoming a playback command.
Playback return restores the originating card or action and selected season; the discarded resolution route cannot replay.
Returning to hero actions pins the page to the top, including after a repaint restores an intermediate scroll position.
Opening a new Details route starts at its hero instead of reusing the previous presentation's focus and scroll.
Back to the existing Series route still retains its selected season and episode.

### Details scroll reference for issue 247

The reference is silo-apple `7baff3ef657757cc0a69202e86dd4bd5c7fcb585`, under `iosApp/iosApp/tvOS/Screens/Detail/`.
`TVDetailFocusScroll.swift:70-81` pins hero actions to `.top` and centers identified poster sections.
`TVMovieDetailView.swift:102-130` identifies the hero, box-set and similar sections and defaults focus to Play.
`TVSeriesDetailView.swift:140-176` pins its primary viewport to the top and clamps a supporting anchor's center to the scroll range.
The first available Series supporting section supplies that anchor (`TVSeriesDetailView.swift:1113-1165`); later sections use native focus reveal.
`TVTrailersRail.swift:28-63` has a heading, 14px heading gap, 12px rail padding and first-card default focus, with no vertical scroll position or explicit offset.
`TVDetailFactsSection.swift:25-61` makes the complete table focusable, also with no explicit scroll anchor.
Both pages use 140px page-bottom padding (`TVDetailHero.swift:18`, `TVMovieDetailView.swift:120`, `TVSeriesDetailView.swift:292`).

The measured 5 November heading targets remain unverified: Details y524, series page-end Details about y400, and trailer heading/card y501/y570.
They are native-focus outcomes rather than constants in these Swift files.
The supplied differences require 110px more scroll for Details (`634 - 524`), about 110px at series page end (`510 - 400`), and 149px for trailers (`719 - 570`, `650 - 501`).
Those are different deltas; this change adds no per-state offsets and does not claim those targets are fixed.
Desktop fake-data probes are not the same state: a three-row movie table reached the scroll clamp at 1025px, putting its heading at `1639.40625 - 1025 = 614.40625`.
A two-row series fixture put its heading at `2075.203125 - 1663 = 412.203125`; at its 1873px scroll limit that becomes 202.203125.
These values cannot establish the supplied native measurements without the same data and running-app comparison.

Main already uses Related Movies and Recommended Series.
Its content-rating chip matches `TVDetailHero.swift:434-443`; external ratings are inline after the facts (`TVDetailHero.swift:406-425`).
The pinned movie and Series metadata builders emit text facts (`TVDetailHero.swift:692-738`), despite the older quality-chip comment.
The optional advisory-age chip (`TVDetailHero.swift:446-453`) still needs a same-state preference/data comparison; no badge is invented here.
No simulator, signed package, live server or TV comparison was run for this change.

### Apple source reference and outstanding comparison

Reference: silo-apple `9723df007baa8e933f5615cc14b13e99a6ee1ea1` (current main fetched 5 November 2026).
This is a source reference, not identification of an installed Apple build.
Paths below are relative to `iosApp/iosApp/`.

| Element | Apple source and exact value | Tizen candidate |
| --- | --- | --- |
| Hero | `tvOS/Screens/Detail/TVDetailHero.swift:10`: inset 100, height 690, top 116, editorial width 1080 | Shared backdrop and fixed 690-point frame; Large Series lifts the hero and top inset by 32 |
| Title | `tvOS/Screens/Detail/TVDetailHero.swift:505`: 92-point compressed primary, 40-point secondary | Requests shared title treatment; colon-separated fallback; guarded logo loading retained |
| Summary | `tvOS/Screens/Detail/TVDetailHero.swift:763`: gap 8; slots 313/364/338; height 44 | Three passive slots above actions |
| Series baseline | `tvOS/Screens/Detail/TVSeriesDetailView.swift:405`: editorial 435, metadata 36, synopsis 112, credit 28, action spacing 4 | Primary editorial clipped at 351; 80-point disclosure bottom-locked inside 435; actions at y=557 |
| Controls | `tvOS/Screens/Detail/TVDetailActions.swift:354`: minimum circle width 76 and height 76; `TVMovieDetailView.swift:176`: primary width 340 | Existing playback dialogs and personal-action ownership retained; next-episode controls now use the same selection owner |
| Credits | `tvOS/Screens/Detail/TVDetailHero.swift:741`: first two directors for movies; first three cast names otherwise | Same text and limits |
| Cast | `tvOS/Screens/Detail/TVDetailCastRail.swift:15`: 200-point circles | Existing circular cards, role deduplication and focus unchanged |
| Extras | `tvOS/Screens/Detail/TVTrailersRail.swift:23`: gap 48; `:24` and `TVDetailHero.swift:16`: 12px rail padding plus 64px section spacing, 76px from the caption to the next heading; `:74-76`: 470×264 cards, radius 18 | Local extras and YouTube listings. Same card geometry. YouTube Select stays on the card |
| Episode caption | `Components/EpisodeCardCaption.swift:90`: zero-padded season/episode code, middle dot, title | Same title, localized air date and h/m runtime; watched badge |

Remote navigation retains one FocusHost owner: Left/Right within action, season, episode, cast, extras and related rows; Up/Down through nonempty rows; Back closes the active dialog before popping the page.
Seasons require explicit activation, including Specials; focus movement does not read data.
The existing route status owner retains initial loading, error, Retry and Back; season loading/error/empty states stay in SeriesEpisodes.
Missing metadata keeps a text title and usable controls; missing or failed artwork falls back to the shared tint surface.
Version labels retain the server edition, resolution and codec fields.

Native acceptance remains required before merge.
Compare identical Movie and Series items, profile, selected file and tracks, card-size setting and 1920×1080 viewport on both clients.
Capture entry with Play focused; each selector open; subtitle Off selected; More; Cast focused; Trailers & More focused; related focused; and Back restoration.
For Series additionally capture Season 1 selected, the first episode focused, the second episode focused, another season explicitly selected, Specials selected, and Back from Episode information.
Apple's Movie hero uses an unreserved editorial stack inside `heroComposition.clipped()` (`TVDetailHero.swift:149-166,263-270`); title and synopsis retain their vertical size (`:493,501`, `TVHeroSynopsis.swift:24`).
It has no grow-the-hero or shrink-the-title rule.
The Tizen Movie frame now follows that fixed clipping contract, including overflow for pathological text; Series separately clips its primary editorial region and preserves disclosure/actions.
This is a source-derived result, not an observation of the same pathological item on an installed Apple build.
Native comparison must establish the exact visible truncation before merge.

Apple does not filter local extras by file ID (`Screens/Detail/TrailerRail.swift:94-98`); tvOS launches their content ID from the beginning (`TVItemDetailView.swift:259-265`).
The Tizen fallback resolves `/catalog/items/{content_id}/versions` on Select when the embedded file ID is absent, then uses the existing player and its authoritative inventory.
Apple shows YouTube entries when its app is installed, and also in the tvOS simulator (`TVTrailersRail.swift:259-291`), then opens `youtube://www.youtube.com/watch?v=…` (`Screens/Detail/TrailerRail.swift:126`).
Samsung's [Application API](https://developer.samsung.com/smarttv/develop/api-references/tizen-web-device-api-references/application-api.html) provides generic application-control dispatch; it does not establish that Apple's URL scheme or a particular YouTube video handoff works on Samsung.
Tizen shows those remote cards so the row matches a tvOS device that can display them, and leaves Select on the card. It does not open `youtube://` until a Samsung receiving-app contract is verified. Local extras play independently.
Episode air dates, overview, ratings and runtime exist in the server's episode response (`silo-server 6aa6791ea072186ed0536bac41174486f96e7536`, `internal/apiv2/catalog_items.go:557-568`).
Apple caption commit `b63e1be0bd90c26c7af11f592def93b5cb56796f` is included in the pinned Apple main above.

## Preplay audio, subtitles and resume

Movie and episode Details offer Auto plus the displayed file's listed audio tracks in an anchored, remote-operable picker.
Closing the picker restores its Audio trigger.
An omitted audio array lists only Auto; malformed audio metadata fails the existing Details read and retains Retry.
The shared decoder preserves the server's per-file audio order.
Explicit IDs use `file:{fileId}:audio:{ordinal}`, where ordinal indexes that file's audio array, never a container or AVPlay stream index.
Auto omits both audio fields, allowing server preferences to select a nonzero track.
An audio-only choice does not invent an explicit version pin.
Selecting a version sends `allow_alternate_versions:false`, and changing file clears the explicit audio choice.
An identical quiet Details refresh preserves valid choices; changed audio metadata or a missing file resets audio to Auto.

Resume captures file, audio, subtitle intent, explicit version pin and initiating focus at the press, before a fresh profile-scoped `GET /api/v2/watch/{id}?file_id=…`.
A Play press cancels an obsolete quiet Details refresh so the visible controls remain usable while returning from playback.
Fresh progress replaces cached progress, including on a rewatched title; a valid answer without progress starts at zero.
The selected file's duration retains the existing five-second end margin.
Network failure, timeout, or HTTP 501/503 uses the confirmed cached position after at most three seconds.
Other refusals and malformed answers show an explicit Try again action and send no start.
Back, route teardown, profile change and sign-out cancel resolution; late results cannot hand off.
Repeated activation during resolution is ignored, and the existing app/player owner receives one captured request.
Playback return restores the initiating Details action, or its existing fallback when that action disappeared.
Play from start sends `start_position:0` without a resume read, even when the server has saved progress.
Subtitle Auto separately reads effective subtitle preferences before adopting the initial playable plan.
Home Continue Watching keeps its existing direct-resolution journey.

Details remembers an explicit audio choice with `PUT /audio-prefs/{key}` and clears it with `DELETE` for Auto. Playback waits until that write is confirmed.
Subtitles offers Auto, Off and the selected version's catalog subtitle tracks.
Auto resolves the watch answer's effective mode, language, saved signature and forced setting against the actual first plan's subtitle inventory and selected audio language.
Explicit Off bypasses forced/default selection.
An explicit catalog choice carries semantic metadata, never a container stream index or a manufactured playback ID.
Before AVPlay opens, the controller matches it uniquely against the authoritative first plan and uses the existing track-change replan when needed.
The initial start still omits both subtitle selector fields.
Missing or ambiguous explicit tracks, failed Auto preparation and refused initial replans show an error and retire the session; they do not silently play a different subtitle choice.
The existing cached-resume fallback remains usable with explicit subtitle Off when the watch endpoint is unreachable.
Subtitle choices persist within the Details visit and attempt, with explicit tracks reset when file or inventory changes; Off survives a version change.
Details also remembers an explicit subtitle choice, including Off, with `PUT /subtitle-prefs/{key}` and clears it with `DELETE` for Auto. The external path is the catalog file name; an external sidecar with no stream index stays on the visit only. Playback waits until that write is confirmed. Downloaded tracks remain available through the authoritative in-player menu.
No subtitle renderer, AVPlay transport or capability declaration changed.
The server's returned effective file, tracks, warnings and source/player timeline remain authoritative.
The controller retains protocol 3, saved quality/cap settings, capability gates and bounded identical-body start resends with the same attempt identity.

The contract is pinned to [server cc851494](https://github.com/Silo-Server/silo-server/blob/cc8514943289045e7b9f7ac8d36d4968bfe93926/internal/apiv2/playback.go), with [Apple's fresh resume state at f334794](https://github.com/Silo-Server/silo-apple/blob/f33479404712737499b22365430db1885cf6c6ab/iosApp/iosApp/Screens/Detail/DetailResumeState.swift) as the interaction reference.
Production-entry desktop Chromium tests use synthetic Silo, KeyManager and AVPlay ports in normal and reduced motion.
They establish request, cancellation and focus behavior, not audible selection, decoded media, subtitles, a signed package, real Chromium 108 or Tizen 8.0 TV acceptance.
Those device and subtitle gates remain open under issue #11; this slice does not complete issues #28 or #29.

## Text Search

Non-empty text Search reads `getCatalogSearchCapabilities` through the existing profile-scoped session before its first query.
It uses `type=video_with_episodes` only when `allowed` is true, `state` is `available`, and `video_with_episodes_scope` is true.
A valid older response without the optional flag, a false flag, or a confirmed unavailable/disallowed capability retains `type=video`.
Network, server and malformed capability responses fail visibly with Try again; they never fabricate unsupported status or empty results.
The optional flag is strictly boolean when present, while unknown additive fields remain accepted.

The operation remains `listCatalogItems`, **GET `/api/v2/catalog`**, with `q`, `type`, `limit=60`, opaque continuation and small artwork.
At [server cc851494](https://github.com/Silo-Server/silo-server/blob/cc8514943289045e7b9f7ac8d36d4968bfe93926/internal/catalog/catalog_parser.go), `video_with_episodes` is legal only on the query source; with text it includes movies, series and episodes, and without text it browses movies and series.
The typed client exposes that scope only for text Search, leaving library/Home types and POST source requests unchanged.
Resolved scope belongs to the active Search route and stays fixed through its cursor sequence, retries and returns from Details.
Changing text resets the cursor; late query/profile answers cannot paint or start another authorised query.
Focus, render and page changes do not reread a resolved Search capability.

Episode cards retain their content ID, series title and season/episode metadata and start prepared playback on Select; Card actions offers explicit Episode information.
Back from Details restores result focus and retains the query and page; opening Search through navigation starts empty with focus on the field.
The 600 ms debounce, TV Done key and cancellation remain unchanged.
Search is pushed above its originating page without invisible root-navigation targets.
Back returns to that page; profile menus on root pages retain their own Back priority.

All/Movies/Series filters apply to the whole server query and reset its cursor.
All retains the negotiated episode scope; Movies and Series send their literal native types.
Search shows the server title count (with `+` for an estimate) only when titles exist, and an idle Search Silo prompt.
People appears before titles, using 200 px circular portraits and centered two-line names.
People-only results omit the title count and empty-catalog message.
Filters appear only for a nonblank query.
People uses profile-scoped `GET /catalog/people?q&media_scope&limit=20` only after an allowed, available `people_media_scope: true` capability.
Its independent read cannot hide usable titles on failure and shows no separate error or retry control; a new query tries People again.
Pending People prevents premature No results but never hides a catalog error or Try Again.
The title grid and remote row navigation use five columns for large posters and six for standard or compact posters.
People cards use real person IDs, with no reads on focus.
People and supplementary Requests retain the logical scroll frame while painting whole cards that intersect its edges, matching the native lazy rails.
Remote navigation reaches all loaded cards; visibility observers are released when the query or route replaces a rail.
Long People names fill the first of two centered lines without leaving one word alone on the second or changing their text, and the media filters use capsule segments.
Returning Up to the field restores its top clearance.

The supplementary Available to request strip uses `requestOperations.search(query, 1)` only with an enabled Requests capability and a trimmed query longer than one character.
It excludes unknown media and initially available titles, keeps existing requests, and caps the strip at 12 cards.
Its independent abort owner fences query, route, profile and teardown changes without restarting catalog paging.
Settled and uncertain request writes invalidate retained strips.
If Search is already visible when the write settles, its strip refreshes independently while retaining the rendered cards and focus until the read completes.
Supplementary capability refusals recheck Requests status without restarting catalog or People reads; that status check cannot automatically retry the refused supplement in a loop.
Recognized request states take precedence over availability; only In library plus a nonempty `library_content_id` opens catalog Details.
The Search card presentation boundary delegates to the shared Requests card and progress owners.
Supplementary posters scale from 220×330 with the existing preference; focus uses the shared 1.05 lift and 4 px outline at 70% white without moving or whitening request captions.
Search catalog captions use a 16 px gap and Requests use 22 px, matching the tvOS branches of `TVMediaCard` and `RequestMediaCard`.
The native Samsung text field remains attached across renders; the tvOS alphabet keyboard is an operating-system surface, not a custom keyboard to port.
Samsung simulator keyboard rendering and final same-state visual acceptance remain unverified.
These source changes do not diagnose historical keyboard or first-query latency reports.

Primary sources are the pinned [OpenAPI](https://github.com/Silo-Server/silo-server/blob/cc8514943289045e7b9f7ac8d36d4968bfe93926/contracts/api/v2/openapi.json), its catalog handler/parser/resolver, and canonical [Apple SearchViewModel at f334794](https://github.com/Silo-Server/silo-apple/blob/f33479404712737499b22365430db1885cf6c6ab/iosApp/iosApp/Screens/Search/SearchViewModel.swift).
The binding Skyline guide SHA-256 remains `2d42d292e01ab6ee539278b63c286756fc432edf876a9286a33c9e853672cac2`; section 6.7 retains the existing Search screen.
Synthetic desktop tests and captures establish this Search slice only, not live-server, decoded playback, Chromium 108 runtime, Tizen or whole-app acceptance.
The broader discovery and Details parity work remains tracked by issue #28.

Focus never activates a route or starts a request.
A library tab opens its anchored selector after 250 ms.
The selector is centered under its tab at y132, clamped to the screen's horizontal safe area.
An open selector keeps the top bar lit and its anchor selected while the page behind it remains undimmed.
These dimensions follow `TVTopMenuBar` and `SiloTheme.Skyline` at Apple revision `1a7ccee`.
With one visible library, Down enters its modes directly in a single-level panel.
With multiple libraries, Down enters the scoped library list, Right enters its modes flyout, and Left returns to the library row.
Back closes either panel without committing.
Explicit activation commits one library, never a merged scope.
Search precedes the centered roots and the profile avatar stays fixed at the right.
The fixed roots follow Apple TVRootDestination.visibleRoots: Home, Movies, Series, Music, For You and Calendar.
Library types appear only when a matching visible library exists; mixed video libraries appear under Movies and Series.
Music opens an explicit unavailable page because the existing catalog browser supports video queries only; it sends no library queries and offers Back.
Saved menu order, omissions and library shortcuts no longer affect the bar.
Audiobooks requires Apple's opt-in feature; Tizen has no audiobook feature and omits it.
Watch Party requires both local opt-in and synchronized-party support; Tizen has neither and omits that profile row.
Search is 58 px wide with an 8 px gap before the roots and an invisible equal-width balance after them, keeping the roots centered at x960.
Labels retain Apple's 29 px horizontal inset (including the CSS border), 26 px semibold type and 8 px gaps.
Removing Requests lets the shared flex row recalculate every horizontal anchor from the remaining labels.

The avatar uses the server-resolved image through the existing artwork URL policy, keeping the initial visible until loading succeeds or if it fails.
Its focused ring is opaque white, 3 px wide and inset within the avatar edge, matching Apple's `strokeBorder`.
The anchored profile menu includes Switch Profile, History, capability-gated Requests, Settings, Change Account and a red, unfocused Sign Out row.
Watchlist and Favorites remain under For You.
Requests pushes a screen without the top bar.
Back from Requests, History or Settings keeps the profile menu closed and restores the selected tab.
Back from the open profile menu itself still restores avatar focus.
The header uses the confirmed server branding name, falling back to the host when none is cached.
Every focused menu row uses a white platter and black text, including Sign Out.
Change Account opens saved accounts without logging out or deleting saved sign-ins.
Back leaves the profile menu closed and restores the selected tab and its page.
The header keeps the server name because Tizen has no multiple saved accounts per server.
Sign Out requires confirmation; Cancel and Back preserve the session and restore avatar focus.
Its two-action layout follows `TVSettingsConfirmationOverlay`: centered surface, 48/42 px padding, 38 px title, 22 px message, horizontal 260 px buttons with 16 px spacing and a 0.62 black backdrop.
The existing focus host owns that row; Up/Down stay inside it, Left/Right select an action, and tapping the backdrop cancels without activating the covered page.
Back dismisses either anchored menu until focus leaves its anchor or the viewer presses it again.
Up from the first dropdown row returns to its anchor, and Down from the last For You action returns to content.

For You reuses Home's Skyline artwork, marquee and shelf renderers.
Returning to a retained Home or For You feed restarts only unfinished enrichment through the existing cache owner.
Its rows come from `/recommendations/discover`; nonempty rows titled “For You” are stably placed first.
Explore All is offered only for a supported recommendation `kind`/`key` and uses `/recommendations/section/{kind}` with its terminal 60-card contract.
Recommendation identities are namespaced separately from Home sections; no continuation or exact total is invented.
The server web client's recommendation adapter was checked, but importing its React/legacy-card layer would add a second transport and model without reducing this port.

This slice does not implement Apple's saved-server list or the additional Sign Out & Remove Server confirmation action.
The saved-server list is tracked in #127; the additional removal action remains under #107.
Those are client work, not claimed Tizen limitations.
Music, Audiobooks and Watch Party remain in their existing separate scopes.
Inter, original SVG drawings and CSS material/focus effects remain documented platform equivalents; full-product and physical-TV parity are not established by these changes.
The [current signed simulator comparisons](../evidence/screenshots/94-navigation/README.md) record package identity, historical-frame labels, measured menu/dialog bounds and remaining validation limits.

`BrowseOptions.publicStorage` accepts the existing `PublicStorage` interface.
The composition owner passes its existing public storage dependency to persist scopes across launches.
`ConnectedServer` does not expose that dependency.
Without it, the choice lasts for the mounted browse session.
Storage failures also retain a session choice.
Keys contain server identity, profile identity and video type, and stored choices must match a currently visible library.
Credentials are never stored here.

Marquee fields come from `CatalogItem` at the pinned `src/contracts/v2/SOURCE` revision.
Backdrop, series backdrop, logo, overview, runtime, duration, resume position, content rating, genres, IMDb and TMDB scores, `overlay_summary` and `user_state.played` are optional.
Missing metadata stays absent; the client does not request details on focus or invent badges.
The marquee follows the [Apple TV marquee](https://github.com/Silo-Server/silo-apple/blob/1a7cceeaf3b2bfc4f889c00487d19b2c6f843940/iosApp/iosApp/tvOS/Components/TVFocusMarquee.swift) at the installed Apple build `1a7ccee`.
The row name is spoken but not drawn.
Episodes headline with their series and use the series backdrop; the episode moves to the meta line (`S9 E8 · Fire Drill · 22m · 14m left`).
Movies and series show `year · genre · runtime`; time left appears only in Continue Watching.
The content rating leads the meta line as a chip, and resolution, dynamic range and audio from `overlay_summary` follow as chips.
Movies and series add one score after the meta text: IMDb, else TMDB, out of 10 with one decimal, as a dimmed text mark and a bold score.
TMDB scores use TMDB's approved logo instead of a text mark, as Apple does; Settings > Server > Acknowledgements carries the notice TMDB's terms require (see `app/third-party/README.md`).
The card's `logo_url` replaces the text title once the image loads. It scales to fit a fixed 880×200 slot and sits on the left, vertically centred. Home, For You and library Recommended share that home-scale slot.
Logos follow Apple `TitleArtPreferences`: they show unless the server's last confirmed `ui.title_art` answer for this server and profile is off.
That answer comes from the same capability, contract and effective-value reads Details uses and is kept on the TV, so a pending or failed read keeps it and a server without the key drops it.
Home uses medium row artwork with the 1344 px backdrop fill and 880 px logo slots when per-slot widths are supported, scaled by device pixel ratio.
Details uses the same hero query when the capability is known.
An unknown image API or a server without per-slot widths gets the Apple TV `large` fallback, including on the first Home request; it never starts with a 300 px backdrop.
At scale 1 the server resolves the 1344 px fill request to a 1920 px backdrop; scale 2 requests 2688 px and may resolve to the original, capped at 3840 px.
The one-size fallback resolves backdrops to 2560 px and episode stills to 1280 px.
The probe runs once per Home session, and its last answer for the server is remembered so Home does not wait for it.
Apple reads item detail when focus rests for the aired-date and cast line, and Continue Watching reads the last-played file when that card is mounted.
Tizen does the same. Continue Watching reads its saved file when the row loads. Every other title waits until focus has rested for 150 ms, then reads that one card. A move before the answer cancels it. For You also warms at most sixteen cards that omit a content rating, three at a time. Answers stay for the Browse session; Continue Watching reads again when `progress_updated_at` moves.
The aired line (`Aired 12 Mar 2026 · first three billed cast`, in an Australian region) fills in place when its answer lands and keeps its space until then.
Dates follow the device region and retain the server's calendar day.
Detail also supplies a runtime or content rating omitted by a row, without replacing the row's confirmed values.
Continue Watching's chips and card badges describe the file in `user_data.last_file_id` when the item still has that file; otherwise they keep `overlay_summary`, the server's best file, and never guess.
Rows stay usable while the reads run, and focus moves only look answers up.
Continue Watching, In Progress, any row whose server type contains "next", and a row made only of TV items that includes an episode use landscape stills. The still uses the backdrop, or the poster when no backdrop is available. A shared row that also contains a movie stays a poster, including when it has one episode.
Home cards follow Apple `MediaCard` and `EpisodeThumbCard`: standard 176×264 posters (`SiloTheme.Skyline.densePosterCardWidth`) and 360×200 stills (`SiloTheme.thumbnailCardWidth` / `thumbnailCardHeight`), 40 px apart. A focused Home row's top sits on the row band's top.
The effective `ui.card_presentation` value is read for the `tv` client family through the existing presentation-settings owner; Compact, Standard and Large scale artwork by 0.86, 1 and 1.2.
The last confirmed size is cached per server/profile, a transient failure keeps it, an older incompatible server restores Standard, and optional storage failure does not block a successful in-memory answer.
Poster badge sizes use the actual scaled artwork width; still badges retain their fixed wide-card size.
Episode cards are captioned with their series and an `S01E02 · Pilot` line.
Unfocused captions dim; focus brightens and drops the caption below a lift of the artwork only.
Cards use Apple's shared 1.05 artwork lift and 4px white outline at 70% opacity.
The focused shadow uses SwiftUI radius 18, converted to CSS box-shadow blur 36 px, with an 8 px vertical offset and 45% black opacity, with 120ms ease-out timing.
CSS box-shadow blur is twice the Gaussian standard deviation ([CSS specification](https://www.w3.org/TR/css-backgrounds-3/#shadow-blur)); the SwiftUI radius is treated as the Gaussian radius, so radius 18 maps to blur 36 and cast radius 14 maps to blur 28.
This rendering conversion requires same-state native comparison before merge.
Caption weights stay fixed; their glow uses white at 22% with an 8px radius and 12% with a 3px radius.
Caption drop is `max(0, artwork height × .025 + 8px - caption gap)` and is zero with reduced motion.
Related Details captions use a 16 px gap; Requests and Calendar captions have no focus drop or glow.
Cast scales the whole button, including its name and role, at 1.05; its focused name is `#EDEDED` and its role stays at 60% of that colour.
Calendar titles change from 85% to full `#EDEDED` on focus and their subtitles stay at 60%; request titles stay at full `#EDEDED`.
Reference: silo-apple `ffa6e5188c70664090a6dc9beb8c7cbbc3ce43e7`, source only; the installed Apple build was not verified.
With reduced motion the artwork does not grow and shows Apple's 4 px focus ring instead.
Library Recommended now uses these same media rows and the calibrated Home hero/marquee scene, independently of its selected navigation root or library shortcut.
Its headings are plain text; Explore All retains the section route and library scope.
Recommended preserves non-featured server shelf order without injecting a Collections shelf or requesting collections.
Collections retains its separate grid destination and actions.
The 38 px added artwork height is the measured native-card substitute, not a universal Swift scale constant.
[Earlier signed shelf focus comparisons](../evidence/screenshots/149-library-focus/README.md) document the superseded 208×312 Library shelf layout; they do not prove the current shared scene.
The [current signed scene evidence](../evidence/screenshots/152-library-skyline/README.md) records shared-scene calibration, corrected Collections-to-row artwork clearance, reduced motion, expansion and controlled failure recovery, with historical Apple and simulator limits disclosed.
Other legacy card owners, detail backgrounds and the historical Home row alignment remain separate investigations.
Continue Watching's heading carries a drawn play-circle mark; Apple's SF Symbol is not bundled.
Watched titles show a check disc on every card.
Home cards draw the profile's poster badges (Apple `CardOverlays`): the profile's `ui.card_overlays` document wins outright, else the administrator's baseline from `/settings/overlay-config`, else the registry defaults.
The profile's `ui.card_overlays_enabled` choice overrides the server-wide default in either direction.
As in Apple `OverlayPrefsStore`, the registry defaults show until the reads answer; a failed read keeps that half's last answer, so a known administrator or profile off stays off.
Poster badges scale from Apple's 185 px poster reference; still badges keep their size and clear the progress bar.
Brand marks (DV, HDR10, ATMOS, AV1) are text as in Apple; Apple's other badge icons are SF Symbols and are not drawn.
The settings are read when Home loads and again after Settings closes, never on focus.
Home shows non-empty rows in the server's profile order, matching the Apple TV client.
Sections whose server `featured` flag is true render as ordinary rows.
Additive section types remain intact; no duplicate recommendation feed is requested.
Each row retains at most 20 media cards and a remote-reachable Explore all tile, following `SectionRowLimit` and `SectionExploreAllCard`.
The tile uses the row's artwork size and has a drawn arrow in place of the unavailable SF Symbol; its stable focus key and existing row-page destination are preserved.
Explore all uses the existing catalog query with `source=section`, `scope=home` and the opaque `section_id`, without overriding media type, sorting or filters.
This preserves server-resolved membership, preferences, episode cards and cursor order.

Home's row band begins at y596 with height 484, and the bottom-anchored marquee frame is at x88/y256, 880×280, at the 1920×1080 logical viewport.
Rows start at x80 and retain an 80 px trailing reveal clearance.
The top bar uses the packaged 96 px wordmark, 26 px semibold labels, 56 px tab capsules and 58 px icon targets; this slice preserves its existing destinations and ordering.
The backdrop follows `TVRootHeroBackdrop`: a top-right 1228.8×756 artwork block with multiplied horizontal/vertical masks, a 190 px top scrim and sampled base/accent/shadow washes over black.
Home immediately uses small artwork while an optional cold-start probe runs, then upgrades once through its existing load owner when the answer advertises better artwork sizing.
The upgrade merges only artwork for retained section/card identities, preserving focus, content, hidden-library choices and in-flight metadata reads.
It waits while Card actions is open so its artwork response cannot clear a watched-state invalidation; closing the dialog resumes the existing content reload or optional upgrade path.
It also upgrades incomplete remembered sizing when the fresh answer adds better slots.
A pending, failed or non-improving probe, or a failed artwork read, leaves usable Home intact without an automatic retry loop; later mounts use remembered sizing immediately.
Canvas sampling first uses the already loaded image; a tainted canvas tries a separate anonymous CORS image without breaking the displayed image.
If sampling is refused, the matching backdrop ThumbHash supplies the wash, or black when there is no valid hash; an episode-still hash is never used with its series backdrop.
Real local HTTP tests cover allowed/refused CORS while retaining visible artwork, but do not establish the packaged TV's origin policy.
Inter is the licensed substitute for SF Pro; drawn symbols and CSS lift/ring approximate native focus effects, with no claim of tvOS parallax or specular equivalence.
Continue Watching uses the same 1.05 lift as posters, with a caption drop calculated from its still height and 14px caption gap.
The [Home comparison](../evidence/screenshots/107-home/home-comparison.png) pairs this signed candidate in Samsung's software simulator with the historical Apple r13 frame in the same Continue Watching state; the earlier Tizen r13 build is not used as current-build proof.
Apple's native 960×540 frame is displayed at 100%, and the current 1920×1080 Tizen frame at 50%, without upscaling.
That Compact capture measured the first heading at y596, the following heading at y939.99, and focused landscape artwork at 357.92×198.85, against Apple's 358.8×199 accessibility frame. A focused row now top-aligns in the band, so the following heading's old position is not the current scroll position.
The [focused poster capture](../evidence/screenshots/107-home/home-poster.png) is current Tizen evidence only, without a matching Apple frame.
The simulator uses Chromium 137 with a legacy Tizen user-agent string, so it establishes this software runtime's rendering rather than physical Tizen 8/AVPlay compatibility.
The [actual S95C capture](../evidence/screenshots/107-home/home-actual-tv.png) records PR #112's `117314f` build on Tizen 9 / Chromium 120; restored and fresh device-code sign-in, profile selection, Home and native AVPlay playback were exercised.
AVPlay reported H.264 1920×1080 with stereo audio and a position advancing from 184367 to 185369 ms over a one-second sample; start, progress and stop requests succeeded, and the app returned to Home.
The debugger reported no uncaught JavaScript exceptions or HTTP error responses, but did record blocked data-image and plugin-object policy errors tracked in [#113](https://github.com/Artic0din/silo-tizen/issues/113), plus one loading failure without diagnostic text.
The physical-TV capture was made with the debugger attached and `document.hasFocus` false, so it does not establish focused appearance or full visual parity; physical Tizen 8 and other media formats remain untested.
Expanded Home/library section rows use a continuous grid with 60-card reads and a six-card near-end trigger, following the pinned `SectionCatalogView` and shared `CatalogGrid` owners.
Focus movement alone never reads data; overlapping pages are deduplicated and thin pages keep reading toward six new visible cards or the end.
An exact server total is shown immediately; an unknown total is shown only once the final loaded count is known.
Ordinary Details/Back retains loaded cards, depth and focus, while explicit personal-state invalidation refreshes from the first cursor through the retained depth.
An invalid cursor restarts once without appending the old sequence; later failures retain usable cards with Retry.
Loading, empty and unavailable states own remote focus and Back without adding a navigation button to the populated grid.
The grid uses six columns for Compact/Standard and five for Large, with 40px track gaps and 60px row gaps; artwork and overlay badges scale together.
Its centered width is at least 1664px and grows to fit the scaled artwork plus track gaps: Compact 1664px, Standard 1760px and Large 1720px.
The current Compact comparison and retained-depth runtime evidence are recorded in [the expanded-row guide](library-discovery.md#expanded-row-simulator-evidence), with font/material substitutions and unverified states listed explicitly.

Holding Select for 650 ms opens card actions; a shorter down/up invokes the card's existing Details or Continue Watching activation once.
The threshold is a client choice, not a Samsung or Skyline specification.
Repeated keydowns, including those reporting `repeat: false`, belong to the same press until release.
Arrows, Back, blur, hidden document, replaced cards and teardown cancel the hold and its short activation.
A repaint of the same view preserves the press and its original deadline when the same card remains focused in the same zone.
Pointer context menus use the same panel; ordinary left clicks retain their existing action.
The modal captures input before Skyline Back handling, keeps Close reachable while busy and consumes the opening Select release.
Samsung system Exit is not intercepted.

Movie, series, episode and season cards share this registration across Home, expanded rows, library shelves/grids, collection contents, Search, personal pages, Person previews, related titles and full Filmography.
Season buttons and episode rows are included; people, collection fan cards, See All and Search input are excluded.
Calendar uses the event's own content ID for actions, including episode and season-premiere IDs, independently of its series navigation destination.
Opening the panel explicitly reads catalog detail and supported list memberships; focus movement never reads them.
Seasons expose confirmed watched state only; movie, series and episode list actions require capability and membership confirmation.
Unknown states remain unavailable and failed reads retain Retry and Close.

The panel reuses the Details mutation/readback owner in personal-only mode, skipping title-art and related-title requests.
Any pending mutation blocks all mutation actions.
Uncertain targets survive dismissal for the current browse authority; explicit Retry reads first and never automatically replays a write.
Mutations mark the origin and retained routes stale, including Calendar Following for all three actions.
Closing refreshes the actual committed origin page without clearing staleness early; an abandoned page turn cannot replace that origin.
Focus and scroll return to the origin identity, with the next surviving card at its old position when removed and existing navigation for empty results.
Late replies preserve subsequent navigation.
The desktop keyboard/release tests do not establish physical Samsung Select repeat or release delivery; real-TV validation remains required.
An invalid cursor clears that row's continuation; only explicit Retry restarts it.
Continue Watching remote Play resolves the profile-authorized item and reuses `playChoices` for its last available file, source resume position and file-duration end margin.
It hands off once through the existing app/player owner without showing Details.
Back or account/profile authority changes cancel resolution; unavailable files and unreadable or failed reads retain Retry and Back.
Playback return restores the originating row rather than replaying the resolution route.
Select on all Home rows opens Details; Continue Watching hold Select also offers Play or Resume in Card actions.
This is a scoped Home journey delivery against canonical Apple `f33479404712737499b22365430db1885cf6c6ab` and the guide hash `2d42d292e01ab6ee539278b63c286756fc432edf876a9286a33c9e853672cac2`.
The Select and Play behavior follows Apple `7baff3ef657757cc0a69202e86dd4bd5c7fcb585`; native same-state acceptance remains pending.
It does not complete whole-Home parity, issue #28, preplay controls, next-up behaviour or hardware acceptance.
Progress appears only when the server supplies position and duration.
The first card previews immediately; subsequent previews wait 150 ms and crossfade for 240 ms.
Root transitions take 200 ms, and reduced motion snaps transitions and scrolling.
Deliberate pill and same-tab scope changes crossfade for 200 ms with a 12 px upward drift of incoming content.
Focus and remote input take effect synchronously; chrome and pills stay mounted above the outgoing layer.
The marquee crossfades without translation so its fixed backdrop keeps the viewport as its containing block.
The shell receives a library/type/mode identity separately from the loading view name.
Loading, data completion and selector refreshes do not start a second transition.
Rapid changes replace the outgoing layer, and stopping or destroying the focus host removes that layer, incoming motion classes and its cleanup timer.
The noninteractive outgoing layer keeps its CSS classes and scroll position without serializing computed styles for each card.

Pushed Details pages show optional title artwork, server-ordered ratings, facts and credits from the pinned v2 contract.
Details shares Home's 1228.8×756 top-right artwork frame and fade masks, with an image contained in that frame rather than fixed to the viewport.
Its page wash follows tvOS `TVDetailPageSurface`: sampled base at 0.42 opacity, shared accent and shadow gradients, and no top menu scrim.
The content-rating badge follows tvOS `TVDetailHero`; runtime, credits and VERSION / AUDIO / SUBTITLES remain in the editorial column.
Movie, Episode and Season heroes retain a minimum 690px height and grow for wrapped editorial content so playback controls remain visible.
Season heroes precede the episode list, including the separate page wash.
Auto subtitle previews resolve using the explicit audio track or the file's effective audio language.
Shared episode preference changes invalidate retained Series and Season owners by series identity, including when the edited episode was not cached.
Ordinary Series entry focuses Play and retains the series overview, matching Apple `bbd1e47`.
The current episode is positioned at the rail's leading slot without taking focus.
Selecting a season retains pill focus and retargets Play to its first episode; Down enters that episode and Up returns to the selected season pill.
Reselecting the current season resets to its first episode using the loaded page, while other seasons load their page before retargeting.
The page tint sits behind the entire browse surface so headings, pills and captions remain painted.
Track selectors use anchored popovers with Auto entry focus, preference subtext and selection checkmarks.
The 560px track popovers use 76px rows; Audio checks both Auto and its effective track, and subtitle rows group by language and format without changing selection identity.
The cast section's leading anchor is centered on focus, following tvOS at `bef81e8`.
Remote YouTube trailers remain omitted because this client has no verified YouTube application handoff or direct stream resolver; local playable extras remain available.
Calendar's explicit season context retains its season-chip entry focus instead.
Cast and crew share a rail of at most 24 people, combining roles for the same server person ID.
Credits without a person ID remain readable without an invented person route.
Person pages show the biography and the first 24 accessible movie and series credits.
Related titles use a bounded rail with loading placeholders and omit the heading, cards and focus zone on failure or an empty result, matching Apple TV.
These bounded rails do not implement Apple's complete paged person browser.
The earlier Details slice used [silo-apple at 148d5d7](https://github.com/Silo-Server/silo-apple/tree/148d5d70f8b8ce982a827fead2b16f8de40f0f57), subject to the binding Skyline guide.

Version selection carries the exact file ID to playback and uses that file's duration for the five-second resume end margin.
Watchlist and favorite controls require the personal-list capability and successful item membership reads.
The pinned server accepts movie, series and episode list membership; season list membership returns not found, so season pages retain watched actions only.
Writes are profile-scoped, never automatically retried or replayed after account refresh, and must be confirmed by a read.
An explicit retry reconciles the server's state before sending another write, including when the first answer was lost.
Watched controls use the authoritative `user_state.played` flag independently of optional `user_data` progress, falling back to the progress flag when no viewer flags are supplied.
Unknown watched state cannot confirm a write.
Aggregate watched changes reread visible episode rows and invalidate covered season data, including when a write answer is lost or cancelled.
If an episode reread fails, the existing rows remain with an explicit retry that reconciles state before another write.
Season metadata uses its real catalog ID; missing metadata leaves the episode list usable.
Facts remain individually reachable by remote, including lists taller than the screen.

Remote trailer metadata contains a site and site key, not an AVPlay stream URL.
A Samsung trailer handoff remains unverified, so this slice exposes no trailer control.
Apple's local extras, artwork preferences, automatic version quality ranking and complete person filters remain outside this slice.

The shell uses the shared tokens in `src/theme.css` alongside Skyline's navigation, marquee and card dimensions.
Desktop Chromium tests and synthetic captures do not prove actual Chromium 108, Tizen emulator, signed package or Samsung TV behavior.

Settings uses the existing native session and HTTP owners.
General contains Hidden libraries and the [title-art switches](title-art.md) with this-TV/all-devices scope; Playback contains the [saved profile defaults](../playback/playback-quality.md#saved-profile-defaults), including separate video seek intervals.
The category rail, control pane and pickers share `FocusHost`.
Category focus only previews loaded controls; requests and writes require explicit activation.
Back cancels a picker, returns from controls to the category rail, then returns to browse with avatar focus.
Loading, empty and failed states retain reachable Back and retry controls.

Discovery checks the settings API version, capability state, allowed flag, manifest revision and profile scope before exposing controls.
The consumed contract subset is pinned to server `cc8514943289045e7b9f7ac8d36d4968bfe93926` in the synthetic settings fixture.
Language suggestions come from the discovered server contract, filtered by their introduction revision; unfamiliar valid stored tags remain selectable.
Original language uses `x-silo-original` from revision 9.
Automatic playback starts already omit explicit audio ID and index, allowing the server to consume the preference.
No quality-default or subtitle-default controls are exposed in this slice.

Profile rows and effective values are read separately and never copied into one another.
`No preference` stores explicit JSON null; `Use inherited default` deletes only the profile row.
A device, library or series audio override can continue to take priority.
The current effective value, source and policy constraints are shown separately from the edited profile value.
Writes are serialized, not automatically replayed, and confirmed by explicit and effective readback.
After an uncertain answer, retry first reconciles the edited scopes (both profile and this profile-device row for title art); Retry-After blocks early requests.
Account/profile authority changes cancel work and clear old settings data.

The hidden-library editor requests `include_hidden=true`; access restrictions remain server-owned.
Library IDs stay opaque strings until the validated positive JSON-integer write boundary.
Each toggle rereads the profile list and preserves IDs absent from the editable library list.
Returning after a hidden-list mutation refreshes Home and root navigation and drops cached library roots.
The whole-array API remains last-write-wins across clients; rereading does not make concurrent edits atomic.
