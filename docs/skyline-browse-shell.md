# Skyline browse shell

This slice applies the [Skyline guide](https://github.com/Silo-Server/silo-apple/blob/main/docs/skyline-design-guide.md) to the native browse owner.
Home, Movies, Series, Search and Profiles share mounted root navigation.
Only visible video library types appear, and mixed libraries can be scoped to either video type.
Detail, season and playback routes remove the root chrome.
Library destinations follow the available discovery capabilities: Browse, Collections, Genres, A–Z and Recently Added.

## Preplay audio and resume

Movie and episode Details offer Auto plus the displayed file's listed audio tracks in an anchored, remote-operable picker.
Closing the picker restores its Audio trigger.
An omitted audio array lists only Auto; malformed audio metadata fails the existing Details read and retains Retry.
The shared decoder preserves the server's per-file audio order.
Explicit IDs use `file:{fileId}:audio:{ordinal}`, where ordinal indexes that file's audio array, never a container or AVPlay stream index.
Auto omits both audio fields, allowing server preferences to select a nonzero track.
An audio-only choice does not invent an explicit version pin.
Selecting a version sends `allow_alternate_versions:false`, and changing file clears the explicit audio choice.
An identical quiet Details refresh preserves valid choices; changed audio metadata or a missing file resets audio to Auto.

Resume captures file, audio, explicit version pin and initiating focus at the press, before a fresh profile-scoped `GET /api/v2/watch/{id}?file_id=…`.
A Play press cancels an obsolete quiet Details refresh so the visible controls remain usable while returning from playback.
Fresh progress replaces cached progress, including on a rewatched title; a valid answer without progress starts at zero.
The selected file's duration retains the existing five-second end margin.
Network failure, timeout, or HTTP 501/503 uses the confirmed cached position after at most three seconds.
Other refusals and malformed answers show an explicit Try again action and send no start.
Back, route teardown, profile change and sign-out cancel resolution; late results cannot hand off.
Repeated activation during resolution is ignored, and the existing app/player owner receives one captured request.
Playback return restores the initiating Details action, or its existing fallback when that action disappeared.
Play from start sends `start_position:0` without a watch read, even when the server has saved progress.
Home Continue Watching keeps its existing direct-resolution journey.

Audio choices last only in the current Details visit and playback attempt; no per-content audio preference PUT or DELETE is sent.
This differs from Apple's persisted per-title/series audio override, which is deferred.
There is no preplay subtitle selector, subtitle Auto resolution or new subtitle renderer claim.
Both subtitle start fields stay absent; the existing in-player subtitle contract is unchanged.
The server's returned effective file, tracks, warnings and source/player timeline remain authoritative.
The controller retains protocol 3, saved quality/cap settings, capability gates and bounded identical-body start resends with the same attempt identity.

The contract is pinned to [server cc851494](https://github.com/Silo-Server/silo-server/blob/cc8514943289045e7b9f7ac8d36d4968bfe93926/internal/apiv2/playback.go), with [Apple's fresh resume state at f334794](https://github.com/Silo-Server/silo-apple/blob/f33479404712737499b22365430db1885cf6c6ab/iosApp/iosApp/Screens/Detail/DetailResumeState.swift) as the interaction reference.
Production-entry desktop Chromium tests use synthetic Silo, KeyManager and AVPlay ports in normal and reduced motion.
They establish request, cancellation and focus behavior, not audible selection, decoded media, subtitles, a signed package, real Chromium 76 or 2021-plus TV acceptance.
Those device and subtitle gates remain open under issue #11; this slice does not complete issues #28 or #29.

## Text Search

Non-empty text Search reads `getCatalogSearchCapabilities` through the existing profile-scoped session before its first query.
It uses `type=video_with_episodes` only when `allowed` is true, `state` is `available`, and `video_with_episodes_scope` is true.
A valid older response without the optional flag, a false flag, or a confirmed unavailable/disallowed capability retains `type=video`.
Network, server and malformed capability responses fail visibly with Try again; they never fabricate unsupported status or empty results.
The optional flag is strictly boolean when present, while unknown additive fields remain accepted.

The operation remains `listCatalogItems`, **GET `/api/v2/catalog`**, with `q`, `type`, `limit=24`, opaque continuation and small artwork.
At [server cc851494](https://github.com/Silo-Server/silo-server/blob/cc8514943289045e7b9f7ac8d36d4968bfe93926/internal/catalog/catalog_parser.go), `video_with_episodes` is legal only on the query source; with text it includes movies, series and episodes, and without text it browses movies and series.
The typed client exposes that scope only for text Search, leaving library/Home types and POST source requests unchanged.
Resolved scope belongs to the active Search route and stays fixed through its cursor sequence, retries, Details and cached reopening.
Changing text resets the cursor; late query/profile answers cannot paint or start another authorised query.
Focus, render and page changes do not reread a resolved Search capability.

Episode cards retain their content ID, series title and season/episode metadata, opening the existing episode Details, resume and player handoff.
Back restores result focus; reopening Search through navigation preserves the query and page with its existing field-first entry.
The 600 ms debounce, TV Done key, cancellation and profile-menu Back priority remain unchanged.

Primary sources are the pinned [OpenAPI](https://github.com/Silo-Server/silo-server/blob/cc8514943289045e7b9f7ac8d36d4968bfe93926/contracts/api/v2/openapi.json), its catalog handler/parser/resolver, and canonical [Apple SearchViewModel at f334794](https://github.com/Silo-Server/silo-apple/blob/f33479404712737499b22365430db1885cf6c6ab/iosApp/iosApp/Screens/Search/SearchViewModel.swift).
The binding Skyline guide SHA-256 remains `2d42d292e01ab6ee539278b63c286756fc432edf876a9286a33c9e853672cac2`; section 6.7 retains the existing Search screen.
Synthetic desktop tests and captures establish this Search slice only, not live-server, decoded playback, Chromium 76 runtime, Tizen or whole-app acceptance.
The broader discovery and Details parity work remains tracked by issue #28.

Focus never activates a route or starts a request.
A library tab opens its anchored selector after 250 ms.
With one visible library, Down enters its modes directly in a single-level panel.
With multiple libraries, Down enters the scoped library list, Right enters its modes flyout, and Left returns to the library row.
Back closes either panel without committing.
Explicit activation commits one library, never a merged scope.
The profile avatar opens an anchored menu with Switch profile, personal lists, Settings and Sign out.
Back dismisses either anchored menu until focus leaves its anchor or the viewer presses it again.

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
The card's `logo_url` replaces the text title once the image loads, aspect-fit inside 880×200 on Home and 880×150 on a library landing.
Logos follow Apple `TitleArtPreferences`: they show unless the server's last confirmed `ui.title_art` answer for this server and profile is off.
That answer comes from the same capability, contract and effective-value reads Details uses and is kept on the TV, so a pending or failed read keeps it and a server without the key drops it.
Home uses medium row artwork on a server that advertises it, with the 1344 px backdrop fill and 880 px logo slots when per-slot widths are supported, scaled by device pixel ratio.
An unknown or older image API retains the small-artwork fallback.
The probe runs once per Home session, and its last answer for the server is remembered so Home does not wait for it.
Apple reads item detail when focus rests for the aired-date and cast line and for Continue Watching's last-played file.
Tizen never reads on focus: when Home's rows load it reads detail once for each distinct title Home draws, four at a time, Continue Watching first, through the same `getCatalogItem` request Details sends.
Answers are kept for the Home session; a reload reads only titles not read yet and Continue Watching titles whose `progress_updated_at` moved.
The aired line (`Aired 12 Mar 2026 · first three billed cast`, in an Australian region) fills in place when its answer lands and keeps its space until then.
Dates follow the device region and retain the server's calendar day.
Detail also supplies a runtime or content rating omitted by a row, without replacing the row's confirmed values.
Continue Watching's chips and card badges describe the file in `user_data.last_file_id` when the item still has that file; otherwise they keep `overlay_summary`, the server's best file, and never guess.
Rows stay usable while the reads run, and focus moves only look answers up.
Continue Watching keeps landscape geometry, using its backdrop or cropping its poster when no backdrop is available.
Home cards follow Apple `MediaCard` and `EpisodeThumbCard`: standard 176×264 posters and 360×200 Continue Watching stills, 40 px apart.
The effective `ui.card_presentation` value is read for the `tv` client family through the existing presentation-settings owner; Compact, Standard and Large scale artwork by 0.86, 1 and 1.2.
The last confirmed size is cached per server/profile, a transient failure keeps it, an older incompatible server restores Standard, and optional storage failure does not block a successful in-memory answer.
Poster badge sizes use the actual scaled artwork width; Continue Watching badges retain their fixed wide-card size.
Episode cards are captioned with their series and an `S01E02 · Pilot` line.
Unfocused captions dim; focus brightens and drops the caption below a lift of the artwork only.
The lift size comes from Apple's measured native card lift (about 38 px of height), not from the tvOS system effect itself.
With reduced motion the artwork does not grow and shows Apple's 4 px focus ring instead.
Continue Watching's heading carries a drawn play-circle mark; Apple's SF Symbol is not bundled.
Watched titles show a check disc on every card.
Home cards draw the profile's poster badges (Apple `CardOverlays`): the profile's `ui.card_overlays` document wins outright, else the administrator's baseline from `/settings/overlay-config`, else the registry defaults.
The profile's `ui.card_overlays_enabled` choice overrides the server-wide default in either direction.
As in Apple `OverlayPrefsStore`, the registry defaults show until the reads answer; a failed read keeps that half's last answer, so a known administrator or profile off stays off.
Poster badges scale from Apple's 185 px poster reference; Continue Watching badges keep their size and clear the progress bar.
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
Home uses image capabilities already known at request time; a cold launch immediately uses small artwork while the optional probe runs, and later loads use the cached sizing without a late-answer reload or focus change.
Canvas sampling first uses the already loaded image; a tainted canvas tries a separate anonymous CORS image without breaking the displayed image.
If sampling is refused, the matching backdrop ThumbHash supplies the wash, or black when there is no valid hash; an episode-still hash is never used with its series backdrop.
Real local HTTP tests cover allowed/refused CORS while retaining visible artwork, but do not establish the packaged TV's origin policy.
Inter is the licensed substitute for SF Pro; drawn symbols and CSS lift/ring approximate native focus effects, with no claim of tvOS parallax or specular equivalence.
Continue Watching uses a separately measured landscape lift: the Compact still is about 199 px high when focused, including `EpisodeThumbCard`'s 1.025 scale; the poster's 38 px lift does not apply to stills.
The [Home comparison](screenshots/107-home/home-comparison.png) pairs this signed candidate in Samsung's software simulator with the historical Apple r13 frame in the same Continue Watching state; the earlier Tizen r13 build is not used as current-build proof.
Apple's native 960×540 frame is displayed at 100%, and the current 1920×1080 Tizen frame at 50%, without upscaling.
On the Compact profile, current measurements are y596 for the first heading, y939.99 for the next heading, and 357.92×198.85 for focused landscape artwork, against Apple's 358.8×199 accessibility frame.
The [focused poster capture](screenshots/107-home/home-poster.png) is current Tizen evidence only, without a matching Apple frame.
The simulator uses Chromium 137 with a legacy Tizen user-agent string, so it establishes this software runtime's rendering rather than physical Tizen 8/AVPlay compatibility.
Expanded rows keep one page of at most 24 cards, explicit paging and Retry/Back controls, and restore the originating Home row focus and scroll on Back.

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
Continue Watching activation resolves the profile-authorized item and reuses `playChoices` for its last available file, source resume position and file-duration end margin.
It hands off once through the existing app/player owner without showing Details.
Back or account/profile authority changes cancel resolution; unavailable files and unreadable or failed reads retain Retry and Back.
Playback return restores the originating row rather than replaying the resolution route.
Other Home rows still open normal Details pages.
This is a scoped Home journey delivery against canonical Apple `f33479404712737499b22365430db1885cf6c6ab` and the guide hash `2d42d292e01ab6ee539278b63c286756fc432edf876a9286a33c9e853672cac2`.
The guide takes precedence over Apple's current Details activation for Continue Watching.
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
The synopsis dialog exposes the complete detail overview with remote scrolling and restores focus on close.
Optional Details responses retain the active synopsis and its focus; closing shows the latest data, and route or profile teardown removes the dialog.

Pushed Details pages show optional title artwork, server-ordered ratings, facts and credits from the pinned v2 contract.
Cast and crew share a rail of at most 24 people, combining roles for the same server person ID.
Credits without a person ID remain readable without an invented person route.
Person pages show the biography and the first 24 accessible movie and series credits; related titles use a separate bounded rail with loading, empty and retry states.
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
Desktop Chromium tests and synthetic captures do not prove actual Chromium 76, Tizen emulator, signed package or Samsung TV behavior.

Settings uses the existing native session and HTTP owners.
General contains Hidden libraries and the [title-art switches](title-art.md) with this-TV/all-devices scope; Playback contains the [saved profile defaults](playback-quality.md#saved-profile-defaults), including separate video seek intervals.
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
