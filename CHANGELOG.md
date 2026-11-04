# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Fixed

- Kept scrolled personal-list cards visible when pages appended or reads failed.

- Opened History without the top menu, with a centered title, exact counts and Apple's unfiltered 60-item pages.

- Kept personal-list focus and cached cards after failed reads and fitted large History posters to five columns.
- Kept Home hero and detail backdrops sharp using Apple TV artwork sizes instead of small first-pass images.

- Prevented large Search posters from overlapping and kept catalog errors and Try Again visible while People results were pending.
- Restored related titles on Details when the server returned cards without catalog pagination totals.
- Made Enter on the player's default focus skip the intro, recap or credits while the Skip control shows, instead of pausing.

### Changed

- Showed Watchlist, Favorites and History as continuous scrolling grids with Apple TV layouts and empty states.

- Started the horizontal navigation column after leaving a text field, and reset it at the top bar or a page's first card.

- Kept Search's horizontal navigation column through default entries, showed its faded title only on return, and gave posters the native clearance when moving up from Requests.

- Applied Search filters on focus, followed nearby cards on vertical moves, restored native scroll and field presentation, and captioned episodes with their series and episode code.

- Kept focused Search requests visible when People arrived later and retried interrupted Requests refreshes after returning from details.

- Required demonstrated Apple TV parity before merging parity changes, preserved regression checks, and clarified component reuse and simulator ownership for coding agents.
- Added People results, All/Movies/Series filters, result counts, an idle prompt and an independent Available to request rail to Search, and opened Search above its originating page without the root navigation, starting empty on each visit.
- Preset profile avatars showed the flat image Apple TV shows when the server supplied an SVG avatar address.
- Rebuilt Requests to match Apple TV: the hub showed Your requests first with focused title previews, horizontal shelves and Apple's loading, error and empty pages, and no longer had its own Search requests, My Requests, Refresh or Back buttons; details gained posters, backdrops, title metadata, a status tracker and related recommendations, with title fallbacks for missing artwork; and the top bar's tab positions and Search icon used Apple's values. A request or cancellation kept focus on its action while it ran, a refused or unconfirmed one explained itself beside the action, a failed title read showed the full error page, hub rows no longer ended in a See all tile, and a focused poster gained Apple's sheen.
- Played episodes directly from cards and season lists with fresh resume progress, added numbered Play/Resume series actions, and kept episode information available in Card actions.
- Consolidated Details actions into one row, added version and subtitle dialogs, kept rating and personal actions in More, and showed season chips with an inline episode rail and clearer cast and synopsis layouts.
- Settled every unknown Android TV cell in FEATURES.md and added nine parity rows found in the upstream TV parity audits.
- Retried a failed AI subtitle job check up to three times before giving up, and kept the duplicate-job block for a file when switching versions and back.
- Shared Home's Skyline presentation with Library Recommended, replaced heading controls with Explore All tiles, retained usable shelves when collections failed, kept lifted artwork visible when returning between rows, and preserved the current card at grid edges.
- Lifted Library Recommended artwork independently of its captions, with dimmed unfocused labels and a reduced-motion focus ring.
- Started the preceding cast-image fixture explicitly before checking blank Person portraits, avoiding a wait on deferred image loading.
- Rebuilt the profile picker with circular avatars, the signed-in account, Change server and TV profile creation with primary-profile verification, optional PIN and child restrictions.
- Aligned type checks, docs and tests with the Tizen 8.0 minimum (Chromium 108), and named original languages in English with the browser's built-in language names.
- Aligned the top navigation with Apple TV: saved TV menu order, centered Search and roots, anchored menus, profile images, For You shelves, server switching and sign-out confirmation.
- Kept loaded expanded-row cards available when a later page reported the row missing.
- Replaced expanded Home and library row paging with a scrolling catalog that retained loaded cards and focus, followed poster-size preferences, and refreshed changed personal state.
- Aligned Home's backdrop, row and marquee placement, poster-size preferences, artwork resolution, wordmark and control dimensions with the Apple TV source.
- Kept Home available while the optional artwork-capability probe was pending, using small artwork until sizing was known.
- Required Tizen 8.0 or later and targeted its Chromium 108 web engine; TVs on earlier OS versions must upgrade before installing new releases.
- Documented signed-package simulator evidence and Apple TV comparisons.
- Redrew the sign-in screens in the Apple TV layout: Silo wordmark, a drifting brand-light backdrop with grain and the server's accent, glass cards, a server card with its mark and a Secure or HTTP badge, the QR code and code in a card beside the instructions, and the Apple TV wording for every code state; Back now waits while a server connects.
- Sign-in codes now behave as on the Apple TV app: an expired, withdrawn or lost code renews itself for an hour and then pauses until asked, a failing start retries on its own, "Can't reach" and "Too many sign-in attempts" appear only after 10, 30 or 60 seconds of failures, and an approval shows "Signed in as …" for a second before moving on.
- The TV now stops polling a sign-in code while the app is hidden and checks it at once on return (after any wait the server asked for), remembers each server's name, mark and accent between launches, and keeps showing a code through unreadable or unknown poll answers instead of ending sign-in.
- Replaced per-library navigation with Skyline type tabs, anchored library and profile menus, a focus-driven preview and smooth remote scrolling.
- Applied Skyline's OLED palette, typography, focus states and reduced-motion transitions to sign-in, profiles, dialogs and playback, and replaced the blank launcher with Silo artwork.
- Connected native sign-in, profiles, browsing and playback in the packaged app.
- Removed redundant sign-in instructions and movie taglines from the native screens.

### Added

- Added a page linking the silo-apple and silo-android design specs that apply to a TV client, for reading before porting a feature.
- Added the Macroscope visible-change evidence check that silo-apple and silo-android run, tailored to the Samsung TV and its Apple TV comparison.
- Added a CI check that fails when the app or its tests mention an `/api/v1` path, as silo-apple's does.
- Added FEATURES.md, a feature inventory that tracks parity with the Apple TV and Android TV apps, as silo-android's does.
- Added `scripts/sync-apiv2-fixtures.sh`, which re-vendors the API v2 contract fixtures and Settings subset from a silo-server commit, with a test in the CI scripts job.
- Added a weekly Parity drift workflow that opens an issue when the Apple TV or Android TV apps change features since FEATURES.md was last reviewed.
- Added a docs index, a native API v2 reference and a TV focus guide, and grouped the feature, playback and evidence notes into folders as the Apple and Android repositories do.
- Added the top-level files the Silo Apple and Android repositories carry: contributing guide, Samsung store and platform licence exceptions, trademark policy, third-party notices, CLAUDE.md and t3.json, and rewrote the README and agent guide in their layout.
- Added a Promote workflow that turns a tester build into a draft store release with the same `.wgt` and store notes, with a fixed `silo-tizen-latest.wgt` that the `releases/latest` link serves once the store release is published.
- Added a Release workflow that tags a numbered tester build, signs its `.wgt` and publishes it on a GitHub prerelease, plus a fixed "latest tester build" link.
- Added a Tizen Builds CI job that packages the `.wgt` on every pull request and signs it with the maintainer's Samsung certificate on main and same-repository pull requests.
- Added Silo issue forms, contact links, a pull request template, evidence paths, release-note categories and the Discord commit feed, matching the Apple and Android apps.
- Added a separate library Browse grid with continuous loading, sort and filter panels, an A–Z prefix rail, remembered preferences and server-owned Shuffle, while keeping Recommended and the existing library destinations.
- Connected to plain-HTTP Silo servers like the Apple TV app: a typed `http://` address connects directly, and an address without a scheme tries HTTPS first, then asks "Connect without encryption?" before sending anything unencrypted.
- Added "Sign in with a password" beside the sign-in code, as on the Apple TV app; servers without code sign-in open on the password screen, and servers that turned passwords off hide it.
- Added Advanced options to server entry, as on the Apple TV app: choose Auto, HTTPS or HTTP and a port; HTTP connects without asking and HTTPS never falls back to plain HTTP.
- Added capability-gated subtitle translation and audio transcription with quota status, job failures and selectable AI-labeled results.
- Continued series episodes automatically with a cancellable countdown when the server-synced autoplay preference was enabled.
- Added the server-enabled Requests hub, discovery and search, title requests, My Requests, cancellation and follow controls with safe profile changes and return focus.
- Applied profile subtitle appearance and timing to text subtitles and added persistent series subtitle choices, including Off.
- Added a Server pane to Settings with Acknowledgements, crediting TMDB and the other rating sources and listing the open source code in the app.
- Added a timed Skip control for intro, recap and credits during video playback.
- Added a first-selection Remember this profile choice and a device-local launch preference in General Settings, with protected proof restoration and PIN checks for other profiles.
- Added per-profile movie and series star ratings with remote controls, server-confirmed saves and explicit retries.
- Added a person hero that shows a living person's age, initials when there is no photo, and a thumbhash preview while the photo loads.
- Added manual Play next after natural episode completion, with confirmed session teardown, authorized episode resolution, Retry and Back.
- Added Select-hold card actions for watched, favorites and watchlist, with confirmed state, safe explicit retries and restored page focus.
- Added attempt-only preplay audio selection with explicit version binding, fresh Resume and reliable Play from start.
- Added full person filmography with server-filtered All, Movies and Series pages, explicit paging, and restored Details and person focus.
- Added a weekly catalog Calendar with Following, Trending and All filters, release and episode shelves, and context-preserving Details navigation.
- Added Show Title Art and Apply to All Devices in General Settings, with server-confirmed title and season artwork choices and text retained during settings recovery.
- Added episode-aware text Search when the server confirms support, with video-only fallback for older servers and retryable capability failures.
- Added direct single-library menus and fluid library transitions while preserving immediate remote focus and reduced-motion navigation.
- Added separate profile-saved video rewind and fast-forward intervals across player buttons, seek previews and dedicated remote keys.
- Added Home row expansion with bounded pages and direct Continue Watching resume, while omitting featured rows and folding existing recommendations after Continue Watching.
- Added server-provided JPEG thumbnails during seek previews, with timestamp seeking retained when previews are unavailable.
- Added saved profile quality and maximum bitrate controls in Playback Settings, with server-confirmed values and device override visibility.
- Added profile Settings with Hidden libraries and Preferred audio controls.
- Added in-player quality selection from the server's available alternatives, preserving saved quality and bandwidth preferences throughout playback.
- Added visible player transport controls, cancellable seek previews and support for dedicated Samsung media buttons.
- Added profile-scoped Watchlist, Favorites and History pages with bounded pagination, server-side media filters including History episodes, and page and item focus retained on return from Details even after an interrupted page turn.
- Added richer title and season details with artwork, ratings, facts, cast and crew, person pages, related titles, file version selection and server-confirmed personal actions.
- Added Movies and Series library sections, collections, genres, A–Z letter navigation and recently added titles.
- Added strict TypeScript checks and a bundled build.
- Added a native Silo `/api/v2` session core with device-code sign-in, household profiles and PIN checks, and credential storage in Tizen KeyManager.
- Added native sign-in screens for server address entry and device-code sign-in with a QR code, remote-key focus and recovery for each failure.
- Added native household profile screens for choosing and switching profiles, PIN entry with lockout handling, and sign-out.
- Added a native player that plays one file through the server's playback plan with AVPlay, with resume, pause, seeking, progress reporting and a final stop, and recovers from a failed route by asking the server for another one. Full TV playback acceptance remains open.
- Added an audio and subtitles menu to the native player: the server switches the audio track, burns in embedded subtitles or turns them off at the current position, and says plainly when a choice isn't available on this TV. Audible audio changes and visible subtitles are not yet proven on a TV.
- Added native Movies and Series browsing for the selected profile: Home rows, visible libraries in pages, search with the TV keyboard, and movie, series, season and episode pages that hand the chosen file and resume point to the player.
- Added a CI workflow that runs the type checks, the build and all tests.

### Fixed

- Kept a rating write running when the details page restarted, and read the rating only after it settled, so the page shows the stored rating instead of the old one.
- Measured current Continue Watching artwork in geometry regressions without retaining nodes across Home redraws.
- Upgraded cold or incomplete Home artwork after image sizing became available while preserving the selected title, hidden libraries, pending metadata and watched changes from Card actions, including when the optional artwork read failed.
- Preserved mixed-library shortcut scope, open dropdown focus during late menu updates, and unfinished Home metadata reads after visiting For You.
- Made the Browse recovery regression verify every retained title without rejecting valid post-retry prefetch.
- Made the Browse append-failure regression use remote scrolling so a pending focus animation could not undo its setup, and report recovery state if it failed.
- Made the rate-limit sign-in regression await completed server replies before advancing its simulated retry deadlines.
- Kept the blank-portrait regression focused on its own image requests after the preceding cast photo finished loading.
- Allowed sign-in grain artwork and the native AVPlay surface under the TV's content policy while keeping scripts, styles and player objects restricted to the app.
- Made phone/password handoff tests await the approval response before advancing the handoff clock on slower runners.
- Kept Home artwork visible when palette sampling was refused, filled missing marquee metadata from detail, followed regional air dates, and capped shelves at 20 titles with an Explore all tile.
- Kept active password fields and TV keyboards intact when device sign-in became unavailable, updating the phone controls without redrawing the form.
- Preserved the original handoff pause when returning to code sign-in after phone approval instead of starting another code.
- Kept completed phone sign-ins intact when password replies arrived late, and removed saved sign-ins from the protocol and port selected in Advanced options.
- Preserved active password fields and completed sign-in handoffs when provider discovery arrived late, and renewed expired codes after repeated unknown poll responses.
- Made the HTTP badge visibly unlocked, calibrated the cleartext alert's measured frame and translucent surface, and aligned sign-in instruction wrapping and spacing with Apple TV.
- Kept Home metadata current after playback and Home usable when the TV could not save optional presentation caches.
- Home kept the server's profile row order and showed featured rows as ordinary rows, matching Apple TV, instead of moving Continue Watching and recommendations first and hiding featured rows.
- Home's marquee and rows matched Apple TV more closely: series-first episode headlines, rating and file chips, Apple-sized posters and stills, series captions, dimmed captions with an artwork-only focus lift, and watched checks on cards.
- Home showed title logos unless the profile turned title art off, an IMDb or TMDB score in the marquee with TMDB's logo, and the profile's poster badges from its badge settings.
- Home's marquee showed the aired date and billed cast, and Continue Watching showed the file the viewer last played, from detail read once when Home loads.
- Home asked for sharper title logos on servers that take per-slot image widths.
- Restored interrupted playback after connection loss and app return while preserving position, track choices, pause intent and profile authority.
- Kept each library mode's scroll and focus through Details, playback, Settings and interrupted loads, revealed clipped shelf cards on return, and stopped focused cards from growing with reduced motion.
- Preserved episode completion after refused player changes and removed an unusable Retry action when the session expired before completion.
- Removed an unusable Retry action when an episode's playback session expired during final progress reporting, while keeping Back available.
- Synchronized Calendar formatting-recovery tests with the pending weekly response before retrying.
- Refreshed confirmed card-menu values after reopening an unresolved action and preserved Select presses during Details updates.
- Kept preplay audio focus visible, reset changed track selections and rejected incomplete resume responses.
- Corrected the profile PIN regression test to distinguish an unchanged public device ID from retained PIN material while continuing to check all stored values for profile proofs.
- Kept the opening Select hold from activating card actions, prevented concurrent personal updates across Details and card menus, and retained related-card focus during refresh.
- Updated Calendar's Today state at local midnight and refreshed retained weeks after watched, favorites, watchlist and playback changes.
- Preserved the expanded Home row's page and card after playback interrupted a pending page turn.
- Restored playback focus after a media button cancelled a seek preview so the controls could hide again.
- Preserved navigation during slow personal-list loads and refreshed covered personal lists after membership changes in another list.
- Refreshed Home progress after watched changes and made interrupted personal actions retryable when returning to Details.
- Kept synopsis dialogs open during Details updates, refreshed visible and cached episode watched controls after aggregate changes, and enabled watched actions for titles without playback progress.
- Preserved remote focus when library reads finished and kept inline collection cards at their intended width.
- Returned directly between the A–Z grid and its navigation pills while keeping the alphabet rail reachable from the side.
- Cleared invalid pagination cursors so reopening a cached list starts from its first page.
- Kept focus in explicitly opened library menus and revealed the first card when Browse was activated from a scrolled library.
- Restored interrupted library reads, preserved discovery chrome and personal groups, and matched collection cards and grid destinations to Skyline.
- Used the server's section type to keep Continue Watching cards landscape when its section ID is opaque.
- Removed blocking style copies from page transitions and kept menu dismissal from redirecting Search or trapping remote focus.
- Kept dismissed menus closed until reopened deliberately, remembered library scope across launches, and made complete synopses reachable.
- Kept full profile names visible, made empty server fields distinguishable, and supported the Samsung Play/Pause button.
- Kept the exit dialog visible and focused while a screen finished loading.
- Made track-choice buttons activate the same selection as remote Enter.
- Kept playback progress current during track changes and stopped safely when a change's outcome could not be confirmed.
- Kept long audio and subtitle lists inside the player's menu with the focused choice and track status visible.
- Removed the browser placeholder icon from native TV playback.
- Kept the details poster at 2:3 when the description is taller than the poster, instead of stretching it.
- Prevented an old stream from ending playback while a backward seek waited for a replacement plan in the native player.
- Stopped the native player when Silo was backgrounded and preserved codec failures received during a seek.
- Kept playback teardown safe during pending seeks, preserved pause after server re-anchoring, and honored server retry delays in the native player.
- Reloaded an edited search when returning from a result opened before the search delay elapsed.
- Preserved remote focus when a PIN check finished unsuccessfully.
- Kept focus during native profile sign-out and waited for credential cleanup before returning to sign-in.
- Kept manual device-code sign-in available when its link could not be encoded as a QR code.
- Replaced an indefinite connection wait with a retry message while earlier sign-in storage cleanup remained pending.
- Dropped obsolete search responses as soon as the search text changed.

### Security

- Rejected insecure native media URLs and canceled native requests and media-token reads when their account or profile authority changed.
- Revoked native sign-ins abandoned before the sign-in screens handed the account to the app.
- Revoked native refresh credentials received after logout or another sign-in replaced their session.
- Updated the Playwright development dependency from 1.49.0 to 1.64.1 to include the fix for [GHSA-7mvr-c777-76hp](https://github.com/advisories/GHSA-7mvr-c777-76hp), where Playwright's macOS Chrome and Edge install scripts did not verify TLS certificates.
  Playwright runs only the desktop browser checks and is not part of the packaged TV app.
