# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Fixed

- Preserved episode completion after refused player changes and removed an unusable Retry action when the session expired before completion.
- Removed an unusable Retry action when an episode's playback session expired during final progress reporting, while keeping Back available.
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

### Added

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
- Added strict TypeScript checks and a bundled build targeting Chrome 76.
- Added a native Silo `/api/v2` session core with device-code sign-in, household profiles and PIN checks, and credential storage in Tizen KeyManager.
- Added native sign-in screens for server address entry and device-code sign-in with a QR code, remote-key focus and recovery for each failure.
- Added native household profile screens for choosing and switching profiles, PIN entry with lockout handling, and sign-out.
- Added a native player that plays one file through the server's playback plan with AVPlay, with resume, pause, seeking, progress reporting and a final stop, and recovers from a failed route by asking the server for another one. Full TV playback acceptance remains open.
- Added an audio and subtitles menu to the native player: the server switches the audio track, burns in embedded subtitles or turns them off at the current position, and says plainly when a choice isn't available on this TV. Audible audio changes and visible subtitles are not yet proven on a TV.
- Added native Movies and Series browsing for the selected profile: Home rows, visible libraries in pages, search with the TV keyboard, and movie, series, season and episode pages that hand the chosen file and resume point to the player.
- Added a CI workflow that runs the type checks, the build and all tests.

### Changed

- Replaced per-library navigation with Skyline type tabs, anchored library and profile menus, a focus-driven preview and smooth remote scrolling.
- Applied Skyline's OLED palette, typography, focus states and reduced-motion transitions to sign-in, profiles, dialogs and playback, and replaced the blank launcher with Silo artwork.
- Connected native sign-in, profiles, browsing and playback in the packaged app, replacing the earlier Jellyfin-compatible client and password sign-in on the TV.
- Removed redundant sign-in instructions and movie taglines from the native screens.
- Set the minimum app platform to Tizen 6.0.

### Fixed

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

- Fixed layouts on 2021 TVs, whose Chromium 76 engine lacks some newer CSS: sign-in fields, poster rows and the details screen keep their spacing, posters keep their 2:3 shape, and titles show in posters without artwork.
- Fixed the exit dialog on 2021 TVs: it now covers the screen instead of opening below it, with space between its Yes and No buttons.
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
