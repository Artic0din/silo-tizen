# Library discovery

Movies and Series each keep one selected library using the existing server/profile storage key.
Recommended uses Home's shared Skyline backdrop, marquee and preference-aware media rows.
Featured rows and rows without supported video destinations are omitted; headings are not focus targets, and Explore All opens the existing library-scoped section catalog.
Recommended omits collections; Collections is a separate destination, matching Apple TV.
The top-bar cascade provides every supported library destination without a duplicate mode strip.
Hero enrichment uses the existing bounded queue after accepted loads and cached re-entry, never on focus movement.
Known artwork capabilities size the initial section read; a late improving answer rereads sections only and merges artwork by retained section/card identity.
That optional upgrade preserves membership, metadata, collections, focus and scroll, and an expected failure leaves the current screen usable.
Shared row cards reserve 20px above their buttons during edge reveal, covering the approximately 19px artwork overhang and rounding.
The existing scroll owner reads that CSS scroll margin; other controls keep its 12px minimum.
Browse is a separate whole-library Movies/Series grid, matching the split in Apple's `TVLibraryTypeTabView`.
It requests 100 cards at a time and prefetches when a card in the last eight rows becomes visible.
The seven video sorts, typed facet groups and transient A–Z prefix share one query; moving focus alone sends no request.
Sort applies immediately; Filter edits a draft, applies through Done or Back from its root, and returns from a facet to the facet list on Back.
Committed sort and filters are remembered per server, profile and library while Preserve sort & filters is enabled; the prefix is never persisted.
The selected destination is not part of that memory. A new visit opens Recommended, so a saved Browse sort cannot replace the server shelves.
Browse retains loaded cards, item focus and scroll through ordinary Details/Back, and refreshes explicit personal/playback invalidation from page one through the retained depth.
Favorites and Watchlist changes in Details invalidate filtered Browse even when a write's answer is lost.
Duplicate cards and repeated cursors cannot accumulate; an invalid cursor restarts once. A later failed page keeps the loaded cards and shows nothing, and the grid reads again when a scroll brings a card near its end onto the screen, as each cell's `.onAppear` does (`TVLibraryGridViewModel.swift:138-143`, `:337-339`; `TVCatalogGrid.swift:131-133` at silo-apple `5780c84`).
Optional facet and Shuffle capability answers do not delay the catalog.
Poster size and badge answers repaint existing cards without changing their identity or querying the catalog again.
Supported whole-library Shuffle creates one non-retryable server session, resolves its current pick through the existing watch/version path, and advances through the player completion owner.
Pending Shuffle launches are discarded when their Browse visit is replaced, left or covered by Settings or Card Actions.
Mixed-library Movies/Series slices hide Shuffle because the server's library scope would include other media.
Collections preserves server groups and order, including opted-in personal collections, in a six-column portrait grid (seven Compact, five Large).
Each card uses the single poster or collage supplied by the server, without inventing additional posters.
Standard collection artwork is 260×390 with a 12px radius, 40px column spacing, 60px row spacing, and centered 24px title / 20px metadata captions.
Missing or failed artwork uses a stack glyph over a stable collection-id gradient.
Collection entry focuses the first non-empty group; Back from members restores the collection by id.
An empty list, or a failed read, shows Apple's “No collections yet” empty state (`TVLibraryCollectionsView.swift:139-151`, `:183-191`).
Empty members say “Collection is empty”.
Named groups keep the server heading; the anonymous bucket has none.
Count captions follow Apple's `collection_type` mapping; management types such as manual and smart use ITEM/ITEMS.
No collection creation or management controls are offered on this TV surface.
Collection contents use `POST /catalog/query` with `source=library_collection` for curated collections or `source=user_collection` for personal collections, `collection_id` and the current library scope.
This matches Apple's `LibraryCollectionDetailViewModel` and includes the profile's `user_state.played` for watched badges.
The collection membership endpoint's listing projection omits that viewer state.
Expanded Home and library section rows read 60 cards at a time into one scrolling grid, reading more when the last six cards enter the viewport.
Section queries send only their Home/library scope, section id, optional library id, limit and cursor, matching Apple's `sectionItems` builder; media filtering stays local because the server rejects query overlays on section sources.
They retain loaded depth through Details and refresh explicitly invalidated state from the beginning through that depth.
Other catalog and collection pages still contain at most 24 cards.
Recommended media previews show at most 20 supported cards; Explore All opens their complete section contents.

## Recommended simulator evidence

The [shared Skyline evidence](../evidence/screenshots/152-library-skyline/README.md) records the current signed build, historical Apple comparison, focused artwork clearance, reduced motion, inline collections, section expansion and controlled failure/Retry.
It separates requested artwork sizes from delivered dimensions and records package, installation and loaded-resource identity.
Compact was measured in Samsung's software simulator; this is not physical-TV or whole-screen parity acceptance.

## Browse simulator evidence

The signed Browse calibration build is paired with historical actual Apple TV frames for [Browse entry](../evidence/screenshots/91-browse/browse-comparison.png), [Sort](../evidence/screenshots/91-browse/sort-comparison.png) and [Filter](../evidence/screenshots/91-browse/filter-comparison.png).
Tizen's native 1920×1080 frame is shown at 50%; Apple's native 960×540 preview is shown at 100%, without upscaling.
The Apple frames come from the earlier r3/r12 captures at the pinned source revision; they were not recaptured for this PR.
Current tool access does not provide the earlier tvOS DeviceHub interaction workflow.

At the profile's Compact size, the first poster is `(94.03,333)`, size `223.59×335.40`, versus Apple's `(94,333)`, `224×335`.
The second poster starts at `385.70` versus `386`; row two starts at `801.40` versus `801`; captions start at `684.40` versus `684`.
The 16px inherited grid inset was removed, and the grid's track widths and caption alignment were calibrated together.
The Sort panel's three sampled fill colours differ from the Apple frame by at most 1/255 per channel after calibration; this is a bounded colour comparison, not whole-material equality.

The [retained-depth frame](../evidence/screenshots/91-browse/browse-depth.png) records a real 100→200-card Movies append and ordinary Details/Back return with the same item, scroll and loaded depth and no catalog reread.
The [Series frame](../evidence/screenshots/91-browse/series-grid.png) records a separate real 100-card Series query and the same controls.
The [empty-result frame](../evidence/screenshots/91-browse/empty-grid.png) uses the real Q prefix plus 1960s filter, with Clear filters owning focus; clearing it restored the default query.
Standard/Large sizing, delayed preference answers, append failure/retry, query cancellation, profile abandonment and Shuffle have automated browser/native coverage; their complete state set does not have paired tvOS/simulator captures.

The signed calibration WGT has SHA-256 `db8b16b57e95be154c1be01b0cfe6758d10320ce2e99755d63273ff251e3b02d`.
Its 14 unpacked files matched the installed simulator files; [the calibration manifest](../evidence/screenshots/91-browse/calibration-installed.sha256) has SHA-256 `cd50b1da9cb7c3d6b097f2f4d9238d08155fdff9f06f3daa6e359192eb3ea9fb`.
The subsequent Shuffle-ownership and personal-filter invalidation corrections are covered by six RED/GREEN browser regressions.
The corrected signed WGT has SHA-256 `1b103870b1ff4502509bce00294d2015d58e4494647579744d0f0369159df84b`; all 14 files match its simulator installation, recorded in [the final manifest](../evidence/screenshots/91-browse/installed.sha256), SHA-256 `6f244cbdb4948a908d136714c553c283ed280e1a2e3cbb2ba7fe201387686b82`.
Only JavaScript and the two signature files differ from the calibration package; the pictured styles, artwork and fonts are unchanged.
After relaunch, CDP read-back of the loaded JavaScript and CSS matched the signed build byte for byte.

Inter substitutes for SF Pro; drawn SVGs replace SF Symbols, CSS scale/shadow replaces native parallax/specular focus, and the dark panel gradient approximates the tvOS material.
The focused Sort direction stays readable instead of copying Apple's low-contrast label.
The historical Apple Filter frame leaves focus on Search behind the panel; Tizen keeps focus inside the modal instead of reproducing that escape.
Existing top navigation and the six library mode controls are retained; their complete Apple composition belongs to #94 and is not claimed by this Browse delivery.
The locked-desktop run used CDP focus emulation in Samsung's software simulator.
This does not prove native visibility behavior, packaged browser-origin access, physical Tizen 8 behavior or successful AVPlay playback.
Physical-TV testing remains deferred until simulator parity is complete.

## Expanded-row simulator evidence

The [Compact comparison](../evidence/screenshots/117-section/section-comparison.png) pairs this candidate's Samsung simulator frame with the historical Apple `New Releases` frame at the pinned `1a7ccee` source revision, with the same first six titles and focused card.
Apple's native 960×540 preview is shown at 100%; Tizen's native 1920×1080 capture is shown at 50%, without upscaling either image.
The Apple frame was not recaptured this run: the existing DeviceHub tool required a device-interaction skill unavailable in this environment.
At 1920×1080, the second Compact poster is at `(422.2, 236)`, size `223.6×335.4`, versus Apple's `(422, 236)`, `224×335`; the count starts at `(128, 162)` versus `(128, 161)`.
The focused artwork is `248.9×373.4` versus Apple's measured `250.7×375`; native parallax/specular lift is represented by the existing CSS scale/shadow equivalent.
Inter replaces SF Pro, so longer captions can truncate sooner even at the same font size.
Compact was measured in the Samsung simulator; Standard/Large geometry, reduced motion, delayed badge changes and failure/loading/empty states have automated browser coverage, without paired native frames for each state.

Both real Home and library section requests returned 200 with 60 initial cards and the exact 1,021-item total.
The [retained-depth capture](../evidence/screenshots/117-section/section-depth.png) records a successful 60→120-card append and Details/Back return: the same focused card at `y=633.6`, scroll `3872`, with no catalog query during that round trip.
The existing scroll owner restarts a reveal only when a section repaint restores the focused card outside its 12px/32px viewport margins.
The locked-desktop session used CDP focus emulation in Samsung's software simulator; this does not establish native visibility handling, Tizen 8 hardware behavior, browser-origin compatibility or successful AVPlay playback.
Physical-TV runs remain deferred until simulator parity is complete.

The signed screen-calibration WGT at `f4096cd` has SHA-256 `81dbbd519e1dfd8274439b66c36d4c06b1c18d6a321f000e00f20836e2c08c79`.
All 14 unpacked files matched the installed simulator files; their complete hashes are in [the installed asset manifest](../evidence/screenshots/117-section/installed-calibrated.sha256), SHA-256 `5e910bc2141ad8d298c2acc14be603fb18deaad096d9b3c998fa805f8d2c09a5`.
The later append-404 correction is covered by native regression tests; it changes error handling without changing this screen geometry.

The library tabs offer only Apple's three destinations, Recommended, Collections and Browse (`TVLibraryPillRow.swift:7-10`); genre, A–Z and date added are Browse's filter, letter rail and sort.
Browse's 1920 column, the letter rail and its 32 trailing overflow the screen and centre, as Apple's HStack does at silo-apple `5780c84` (`TVLibraryGridView.swift:98-108`, `TVCatalogGrid.swift:102-143`): the pills and grid start at x55 with the rail closed and slide to x16 as it opens, and the open rail draws on through the bottom safe area.
The rail's letters, the Sort panel's heading and the filter count use the packaged Roboto Mono in place of SF Mono, because the TV has no monospaced system face (`app/fonts/README.md`).
All requests use the existing operations/session/NativeHttp owners and active profile authority.
Changing mode, scope or sort starts a fresh page sequence; Back restores the previous collection or section focus.
Each library mode remembers its own committed card and scroll position under the shared public view id.
Loading and failed initial reads do not replace a saved visit with placeholder controls.
Back from Details, playback or Settings keeps the saved position when its card still intersects the viewport and fits horizontally inside its shelf.
A partly clipped shelf card is revealed, while a missing or offscreen shelf card uses the visible fallback.
Grid cards retain their identity and are revealed when offscreen.
Reduced motion leaves focused cards at their resting size.
Return visibility is measured before reveal, including when reduced motion applies scrolling immediately.
Entering library content from navigation does not restore a saved navigation or selector control as the default card.

The Browse port references Apple commit `1a7cceeaf3b2bfc4f889c00487d19b2c6f843940`: `TVLibraryTypeTabView`, `TVLibraryGridView`, `CatalogSortKey`, `CatalogFilterState`, `CatalogFacets`, `CatalogQueryBuilder` and `ShuffleLauncher`.
The Collections port references Apple commit `bef81e8652a89c23a1c3cf07e312e9444baa6c4c`: `TVLibraryCollectionsView`, `TVCollectionPosterCard`, `TVLibraryTypeTabView`, `LibraryCollectionDetailView` and `TVCardFocusStyle`.
This is a source reference, not an assertion about the installed Apple build.
Collection members use 60-member pages, matching Apple, including the personal collection catalog query.
Member failures retain explicit Retry; a failed list read shows the empty state.
Collection detail uses a centered title and the Swift tvOS 260×390 poster default.
Its count uses loaded membership plus a continuation suffix when query totals are inexact.
Capability-gated Shuffle initially owns focus and uses the shared launch, cancellation and playback owners with the collection scope.
Restricted-member visibility remains server-authoritative in both clients.
Paired native captures and the reported collection's actual artwork request remain unverified for this change.
The existing session/operations boundary is retained; the server web Shuffle module is a thin request wrapper and offers no smaller reusable browser owner here.
The API fixtures and consumed Shuffle wire fields are pinned to server commit `cc8514943289045e7b9f7ac8d36d4968bfe93926`.
Optional test screenshots require both `DISCOVERY_CAPTURE` and `DISCOVERY_OUTPUT`; ordinary tests create no evidence directory.
Desktop fake-server tests exercise discovery, authentication authority and the existing detail/player handoff.
They do not establish Samsung simulator, actual Tizen 8 Chromium 108, packaged Tizen or physical TV compatibility.
Home and whole-app parity remain outside this slice, and issue 28 remains open for parent review and remaining acceptance.
