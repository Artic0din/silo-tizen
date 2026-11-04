# Silo Tizen: Feature List

Inventory of what the Samsung TV client does today, and a tracker for parity with the Apple TV (tvOS) and Android TV apps.
Maintainer's rule: no build goes to Samsung TV Seller Office until the app reaches Apple TV parity ([Releasing](docs/releasing.md#store-release)).

Checked against the code on 3 Nov 2026; update a row in the pull request that changes it.

Tizen status legend:

- ✅ implemented and covered by tests; a gap still to prove on a physical TV is named in the row
- 🟡 partial ("bones-level")
- 🚧 planned (open issue, not built)
- 🧪 experimental
- ➖ not present on this platform

Apple TV and Android TV columns: ✅ present in the app's source, 🟡 present but opt-in, experimental or limited, ➖ not found in the app's source, ? not established.
Android TV status comes from the TV column of [silo-android `FEATURES.md`](https://github.com/Silo-Server/silo-android/blob/main/FEATURES.md), its `AGENTS.md` (Current Product Exposure) and the `androidTvApp` source.
Issue numbers refer to open issues in this repository; a gap without its own issue is part of the Apple TV parity umbrella, #106.
Apple names (`TVServerSetupView` and so on) are types or paths in [silo-apple](https://github.com/Silo-Server/silo-apple).
Android names (`TvServerSetupScreen` and so on) are types or paths in [silo-android](https://github.com/Silo-Server/silo-android).
File pointers are repository-relative.

> **Validation note:** Almost every row is verified by native tests and desktop Chromium with fake Silo and AVPlay implementations, plus signed-package checks in Samsung's TV simulator.
> The composed app has run on one physical TV, an S95C on Tizen 9: device-code sign-in, profile selection, catalog reads, relaunch restore, direct play, seek, one audio-track replan, and sign-out.
> Tizen 8.0 hardware, the TV keyboard, remux/transcode, audible track changes and store builds are still open (#14, #13, #11; see [App behaviour](docs/app-behaviour.md#validation-limits)).
> Rows say "not yet validated on a TV" only where the docs call out a specific gap.

---

## Sign-in & server

| Feature | Tizen | Apple TV | Android TV | Notes |
|---|:---:|:---:|:---:|---|
| Manual server entry (HTTPS; HTTP and port under Advanced) | ✅ | ✅ | ✅ | `src/ui/signIn.ts`. A bare address tries HTTPS, then asks before using HTTP. TV keyboard not yet validated. Apple: `TVServerSetupView`. Android: `TvServerSetupScreen` |
| LAN server discovery | ➖ | ✅ | ✅ | Android: `LanServerDiscovery`. Apple: `ServerDiscovery`, used by `TVServerSetupView` |
| Device-code sign-in with QR | ✅ | ✅ | ✅ | Eight-digit code approved on Silo's web page. Proven on the S95C. Android: `TvPairDeviceScreen` |
| Password sign-in | ✅ | ✅ | ✅ | "Sign in with a password"; hidden when the server turns passwords off |
| Phone-assisted pairing (a nearby phone approves the TV) | ➖ | ✅ | ✅ | Apple: `Pairing/Receiver`, `Pairing/Companion`. Android: `TvPairingAdvertiser`, `PairingReceiver` |
| First-run onboarding tour | ➖ | ➖ | ➖ | Apple: tour compiled out on tvOS (`OnboardingTourPresentation+tvOS.swift` is a no-op). Android: phone only (`OnboardingTourScreen`) |
| Switch Server | 🟡 | ✅ | ✅ | Opens manual entry and keeps saved sign-ins. Saved-server list is planned (#127). Apple: `ServerListView`. Android: `TvServerListScreen` |
| Sign out with confirmation | ✅ | ✅ | ✅ | Cancel and Back keep the session. Android: `TvSignOutDialog` |
| Sign Out & Remove Server | 🚧 | ✅ | ✅ | Tracked under #107. Apple: `signOutRemoveServerAndReset`. Android: `TvSignOut` |
| "Server isn't ready" screen for a server that still needs setup | ➖ | ✅ | ✅ | Tizen never reads `/api/v2/system/setup`. Apple: `TVServerNeedsSetupView`. Android: first-run setup in `TvServerSetupViewModel` |

## Profiles

| Feature | Tizen | Apple TV | Android TV | Notes |
|---|:---:|:---:|:---:|---|
| Household profile picker (avatars, account line, Change server) | ✅ | ✅ | ✅ | `src/ui/profilePicker.ts`. Simulator-calibrated only. Android: `TvProfileSelectionScreen` |
| PIN-protected profiles, lockout handling | ✅ | ✅ | ✅ | PIN never stored; proof kept only if the viewer opts in |
| Create profile (presets, PIN, child restrictions) | ✅ | ✅ | ✅ | Ported from Apple's `CreateProfileView`. Android: `TvCreateProfileScreen`. Apple: `CreateProfileView` (tvOS layout), opened from `AddProfileTile` |
| Remember profile at launch | 🟡 | ✅ | ✅ | Two choices: remember, or ask each launch. Timed choices not built. Apple: `ProfileLaunchPreferences`. Android: Automatic, Every Time, After 1 Hour, After 12 Hours (Settings → General) |
| Apple TV user mapping | ➖ | ✅ | ➖ | Apple-only concept (`AppleTVUserContext`) |
| Per-profile settings applied (hidden libraries, audio, quality, bitrate, seek, subtitles, title art, poster size, badges) | ✅ | ✅ | ✅ | Read from the server settings contract on each use |

## Navigation & Home

| Feature | Tizen | Apple TV | Android TV | Notes |
|---|:---:|:---:|:---:|---|
| Skyline top bar (saved TV menu order, centred roots, anchored menus, profile avatar) | ✅ | ✅ | ✅ | `src/ui/navigation.ts`. Parity captures in `docs/evidence/screenshots/94-navigation`. Focus and card styling parity open (#97). Android: `TvTopMenuBar` |
| Home rows in server order, Continue Watching resume, Explore all, 20-card cap | ✅ | ✅ | ✅ | Resume goes straight to the player. First-load wait tracked in #78. Android: `TvHomeScreen` |
| Home marquee (logo, meta chips, scores, aired date, cast) | ✅ | ✅ | ✅ | Apple: `TVFocusMarquee`. Sharper backdrops open (#88). Android: `TvFocusMarquee` |
| Poster badges, watched checks, poster size (Compact/Standard/Large) | ✅ | ✅ | ✅ | Size is read-only on Tizen; see Settings. Android: `TvMediaCard` overlays and watched badge, Poster Size setting |
| Card actions on Select-hold (watched, favourites, watchlist) | ✅ | ✅ | ✅ | Desktop tests only; real Samsung Select repeat/release is unverified. Android: `TvMediaCardActions`. Apple: `TVMediaCard` context menu (`MediaStateMenuItems`) |
| Live home refresh (events socket) | ➖ | ➖ | ✅ | Android: `HomeRealtimeCoordinator`. Apple: draft spec only (`docs/realtime-updates-spec.md`); no events subscriber |
| Row headings non-focusable | ✅ | ✅ | ✅ | Tizen and Apple end a row with an Explore all tile. Apple: `MediaRow` header is plain text on tvOS. Android: `TvSectionHeader` title is plain text; only its See all link takes focus |

## Browse & libraries

| Feature | Tizen | Apple TV | Android TV | Notes |
|---|:---:|:---:|:---:|---|
| Movies and Series tabs, per-type library scope | ✅ | ✅ | ✅ | Scope remembered per server, profile and type. Android: `TvLibraryTabType`, `TvLibraryScopeStore` |
| Library modes: Recommended, Browse, Collections, Genres, A–Z, Recently Added | ✅ | 🟡 | 🟡 | Apple: `TVLibraryTypeTabView`. Recommended shares Home's Skyline scene (#152); the historical section HTTP 422 remains unverified (#89). Android: Recommended, Browse (with A–Z rail) and Collections in `TvLibraryDetailScreen`; Genres and Recently Added not found as separate modes. Apple: three modes (`TVLibraryPill`); Genres is a filter, Recently Added a Date Added sort, A–Z the rail in Browse |
| Browse grid: sort, filters, A–Z rail, remembered choices | ✅ | ✅ | ✅ | 100 cards per read. Apple: `TVLibraryGridView`, `TVBrowseFilterUI`. Android: `TvFilterSheet`, `TvAlphabetRail` |
| Expanded section grid (60-card reads) | ✅ | ✅ | ✅ | Apple: `SectionCatalogView`. Android: `TvSectionBrowseScreen` |
| Collections (fan-card grid, personal collections) | ✅ | ✅ | ✅ | Layout parity open (#100). Android: `TvCollectionsScreen` |
| Library Shuffle | ✅ | ✅ | ✅ | Server-owned; hidden in mixed-library scope. Apple: `ShuffleFeatureStore`. Android: no mixed-library screen on TV |
| Music | 🚧 | ✅ | 🟡 | Blocked on the server parity contract (#56). Android: Music tab browses the library (`TvLibraryTabType.Music`); no music player found in `androidTvApp` |
| Audiobooks | 🚧 | ✅ | ✅ | #55. Apple: `TVAudiobookDetailView`, `AudioFullPlayerView`. Android: `TvAudiobookPlayerScreen`; top-bar tab is opt-in (Settings → Show Audiobooks) |

## Search

| Feature | Tizen | Apple TV | Android TV | Notes |
|---|:---:|:---:|:---:|---|
| Text search (debounced, paginated, episodes when the server supports it) | ✅ | ✅ | ✅ | Uses the TV keyboard, not yet validated. Layout parity open (#99). Android: `TvSearchScreen` |
| Voice search | ➖ | ✅ | ➖ | Apple: Siri search request into `SearchView`. Android: voice is the system keyboard's mic only |

## Details & people

| Feature | Tizen | Apple TV | Android TV | Notes |
|---|:---:|:---:|:---:|---|
| Movie and series details (artwork, facts, ratings, cast and crew, versions) | ✅ | ✅ | ✅ | Layout parity open (#92). Android: `TvItemDetailScreen` |
| Series → seasons → episodes | ✅ | ✅ | ✅ | Tizen uses season chips and an inline episode rail; episode Select plays directly. Card actions retains explicit Episode information; season information remains in More |
| Series Play starts the next-up episode | ✅ | ✅ | ✅ | Tizen resolves the server's target for Play/Resume S#:E# and refreshes its resume point at activation. Apple: `TVSeriesDetailView`. Android: `TvItemDetailScreen` |
| Related titles | 🟡 | ✅ | ✅ | Series page shows "Could not load related titles" (#90). Apple: `TVSimilarRail` |
| Person page (bio, age, photo, filmography preview) | ✅ | ✅ | ✅ | Layout parity open (#102). Android: `TvPersonDetailScreen` |
| Full filmography (All, Movies, Series) | ✅ | ✅ | ✅ | Server-filtered, paged. Android: filter chips on `TvPersonDetailScreen`. Apple: `TVPersonDetailContent` with `PersonFilterBar`, paged |
| Trailers | ➖ | ✅ | ✅ | Server gives a site key, not an AVPlay stream URL. Apple: `TVTrailersRail`. Android: `TvDetailTrailersSection` |
| Local extras | ➖ | ✅ | ✅ | Apple: `TVTrailersRail` "Trailers & More" plays local extras. Android: `TvDetailTrailersSection`, played from `TvItemDetailScreen` |
| Synopsis dialog | ✅ | ➖ | ✅ | Android: `TvExpandableSynopsis`. Apple: `TVHeroSynopsis` is a non-focusable 3-line clamp, no dialog |

## Personal lists & ratings

| Feature | Tizen | Apple TV | Android TV | Notes |
|---|:---:|:---:|:---:|---|
| Watchlist, Favorites, History pages | ✅ | ✅ | ✅ | Tizen: profile menu. Apple: Watchlist and Favorites under For You, History in the profile menu. Grid parity open (#105). Android: `TvPersonalScreens` |
| Watched / favourite / watchlist actions on details | ✅ | ✅ | ✅ | Server-confirmed readback, never auto-replayed. Rating write reconcile open (#84). Android: `TvHeroToggleIconButton`. Apple: hero Watchlist button (`TVDetailActions`), Favorite/Watched in the More menu |
| Personal star rating (1–5) | ✅ | ➖ | ✅ | Apple shows external scores only; no personal ratings client in the tree. Missing-rating log noise (#79) |
| External scores (IMDb, TMDB) | ✅ | ✅ | ✅ | TMDB logo and notice in Acknowledgements. Android: `TvDetailMetadata` and `TvFocusMarqueeModel` |
| Title art switch (this TV or all devices) | ✅ | ✅ | ✅ | Android: `TitleArtStore`, Settings → General |

## Recommendations / For You

| Feature | Tizen | Apple TV | Android TV | Notes |
|---|:---:|:---:|:---:|---|
| For You hub (discover rows, Explore all) | ✅ | ✅ | ✅ | Reuses Home renderers. Apple: `RecommendationsView`. Android: `TvRecommendationsScreen` |
| Watchlist and Favorites shortcuts from the For You menu | ➖ | ✅ | ✅ | Tizen reaches them from the profile menu (#105). Android: dropdown under the For You tab in `TvTopMenuBar` |

## Calendar

| Feature | Tizen | Apple TV | Android TV | Notes |
|---|:---:|:---:|:---:|---|
| Weekly calendar, Following / Trending / All | ✅ | ✅ | ✅ | Top-bar root. Layout parity open (#101); intermittent test failure (#119). Android: `TvCalendarScreen` |

## Requests

| Feature | Tizen | Apple TV | Android TV | Notes |
|---|:---:|:---:|:---:|---|
| Requests hub, discover rows, search, detail, My Requests, cancel | ✅ | ✅ | ✅ | Shown only when the server enables it. Bugs: focus (#74), status text (#75), artwork (#76). Layout parity open (#98). Tizen: a top-bar tab (`src/ui/navigation.ts`). Apple: in the profile menu (`TVMainTabView`). Android: `TvRequestsPage`, in the profile menu |
| Follow / unfollow a requested title | ✅ | ✅ | ✅ | Android: "Notify me when available" when the server reports `follow_supported`. Apple: "Notify Me" in `RequestDetailView`, gated on `followSupported` |
| Request administration | ➖ | ➖ | ➖ | Stays in web admin |

## Playback

| Feature | Tizen | Apple TV | Android TV | Notes |
|---|:---:|:---:|:---:|---|
| AVPlay engine, server-planned direct play | ✅ | ✅ | ✅ | `src/player/`. Direct play proven on the S95C (Tizen 9); Tizen 8.0 open. Apple uses its own engine ([silo-apple `docs/tvos-player`](https://github.com/Silo-Server/silo-apple/tree/main/docs/tvos-player)). Android: Media3/ExoPlayer via `SiloPlaybackService` |
| Remux / HLS transcode fallback | ✅ | ✅ | ✅ | Server-planned. Progressive class not advertised. Not yet validated on a TV |
| Resume, progress every 10 s, final stop | ✅ | ✅ | ✅ | Resume reads fresh progress for up to 3 s |
| Recovery after suspend or connection loss | ✅ | ✅ | ✅ | Bounded backoff; real suspend/restore unverified (#13). Android: runtime recovery replan (`PlaybackSessionManager.replanActiveVideoSession`). Apple: `PlaybackReconnectPolicy` (bounded backoff) |
| In-player quality picker | ✅ | ✅ | ✅ | Options come from the server plan |
| Seek preview, Rewind/Fast Forward keys, profile seek intervals | ✅ | ✅ | ✅ | Player panel and scrubber parity open (#103). Android: `TvPlayerScrubber`, `TvHoldSeekIndicator` |
| Seek thumbnails | ✅ | ✅ | ✅ | Needs server trickplay. Apple: `ServerTrickplay`. Android: `TrickplayPreviews` |
| Skip intro, recap, credits | ✅ | ✅ | ✅ | Enter on Skip pauses instead of skipping (#73); on-screen buttons to remove (#87). Android: `TvIntroAutoSkipBanner` |
| Autoplay next episode (10 s countdown, Cancel) | ✅ | ✅ | ✅ | Reads the server setting. Stale after the episode ends (#82) |
| Up Next panel before the episode ends (Play Now, Keep Watching) | ➖ | ✅ | ✅ | Tizen offers Play next only after the episode ends. Apple: `PlayerView`, with a Show Next Up time setting. Android: `TvPlayerScreen` |
| Retry after playback fails to start | ✅ | ✅ | ✅ | A retryable first start (network, server, retryable terminal, or a route recovery that ran out of attempts) focuses Retry and replays that request at the same position. Go Back stays available. Apple: `PlayerViewModel.retry()`. Android: `TvPlayerScreen` |
| Playback speed | ➖ | ✅ | ✅ | Apple: HUD Speed row, 0.75× to 2.0×. AVPlay `setSpeed` takes only whole-number rates (±1, 2, 4, 8, 16×), so Apple's range cannot be matched |
| Sleep timer | ➖ | 🟡 | ✅ | Apple: audiobook player only (`AudioFullPlayerView`); the video HUD has no way to start it |
| Chapters | ➖ | ✅ | ✅ | Apple: HUD Chapters tab. Android: scrubber markers |
| Info / stats HUD | ➖ | ✅ | ✅ | Apple: `TVPlayerInfoHUD`. Android: `TvPlayerHud` |
| In-player aspect mode, auto-play switch, subtitle appearance and delay | ➖ | ✅ | ✅ | #103. AVPlay has no crop mode for Fill. Apple: `TVPlayerInfoHUD`. Android: `TvPlayerHud` |
| HDR, Dolby Vision, 4K, audio passthrough | ➖ | ✅ | ✅ | Capabilities declare SDR up to 1080p, H.264/HEVC, no DTS (`src/player/capabilities.ts`). Android: `MediaCodecCapabilitiesProbe`, `DisplayHdrProbe`, `AudioCapabilityManager`; Dolby Vision profiles are 🟡 in silo-android |
| Watch Party | 🚧 | 🟡 | 🟡 | #54. Apple: opt-in under Extra Features. Android: experimental, behind Settings → Experimental → Watch Party |
| Phone "Play on TV" / remote control | ➖ | ✅ | ✅ | Apple: `TVControlReceiver`. Android: `TvSiloCastReceiver` |
| Smart Hub / Top Shelf row | ➖ | ✅ | ✅ | Apple: [`iosApp/TopShelf`](https://github.com/Silo-Server/silo-apple/tree/main/iosApp/TopShelf). Android: Watch Next row (`WatchNextRepository`) |

## Subtitles & audio

| Feature | Tizen | Apple TV | Android TV | Notes |
|---|:---:|:---:|:---:|---|
| In-player audio track switch | ✅ | ✅ | ✅ | Server replans. Audible change not confirmed on a TV (#11) |
| Preplay audio and file-version picker | ✅ | ✅ | ✅ | Tizen choice lasts one attempt; Apple persists per title or series. Apple: `TVPlaybackSelectorRow`. Android: `TvPlaybackSelectorRow` |
| Preplay subtitle picker (including Off) | 🟡 | ✅ | ✅ | Tizen offers catalog tracks, Auto and Off, resolved against the authoritative initial playback inventory. Choices last for the Details visit; downloaded choices and persistence use the in-player menu. Apple: `TVPlaybackSelectorRow`. Android: `TvPlaybackSelectorRow`; Auto policy not rechecked here |
| Text subtitles (VTT/SRT, ASS dialogue) in an app overlay | ✅ | ✅ | ✅ | Captions not yet verified on a TV or simulator (#80). Android: Media3 `SubtitleManager` |
| Embedded subtitle burn-in | ✅ | ✅ | ✅ | Server burns in when transcoding is allowed. Android: server plans render, convert or burn-in. Apple: server burn-in (`needsBurnIn`) |
| ASS styling, bitmap subtitles | ➖ | ✅ | ✅ | Apple: ASS renderer ([`docs/tvos-player/ass-subtitles.md`](https://github.com/Silo-Server/silo-apple/blob/main/docs/tvos-player/ass-subtitles.md)). Android: libass in the TV player (`AndroidTvModule`) and PGS bitmap cues (`PgsSupExtractor`) |
| Profile subtitle appearance and sync offset applied | ✅ | ✅ | ✅ | Read-only; no editor (see Settings) |
| Series subtitle choice (keep or Off) | ✅ | ✅ | ✅ | Apple: `TrackSelectionPersistence` saves per-series picks, including Off. Android: `SeriesTrackChoiceWriter` saves manual picks automatically; Tizen saves from a menu action |
| Subtitle labels by language | 🟡 | ✅ | ✅ | #77. Android: `subtitleChoiceLabel`. Apple: `TrackLabels`, used by `TVPlaybackSelectorRow` |
| AI subtitle translate / transcribe (quota-aware) | ✅ | ✅ | ✅ | Retry and duplicate-job fixes open (#83). Android: `TvAiTranslateDialog` |
| Subtitle search and download | ➖ | ✅ | ✅ | Apple: `SubtitleSearchMenu`. Android: `TvSubtitleSearchDialog` |

## Settings

| Feature | Tizen | Apple TV | Android TV | Notes |
|---|:---:|:---:|:---:|---|
| Settings categories | 🟡 | ✅ | ✅ | Tizen: General, Playback, Server. Apple adds Subtitles and Diagnostics (#104). Android: General, Playback, Subtitles, Diagnostics, Server (`TvSettingsCategory`) |
| Hidden libraries | ✅ | ✅ | ✅ | Apple: `HiddenLibraryPreference` applied in `TVMainTabView`; no tvOS editor. Android: `TvMainShell` leaves hidden libraries out |
| Preferred audio, quality, maximum bitrate, seek intervals | ✅ | ✅ | ✅ | Server-confirmed writes |
| Autoplay, Next Up, Skip Intros, Skip Credits switches | ➖ | ✅ | ✅ | Tizen reads autoplay but never writes it |
| Episode spoiler protection (hide unwatched stills and descriptions) | ➖ | ✅ | ✅ | Apple: `TVPlaybackSettingsView`. Android: `TvSettingsScreen` |
| Subtitle settings (language, behaviour, appearance) | ➖ | ✅ | ✅ | Apple: `TVSubtitleSettingsView` |
| HDR, Dolby Vision, buffering, lossless audio, deinterlacing | ➖ | ✅ | 🟡 | Android has Dolby Vision, Force HDR Passthrough, buffering quality and frame-rate matching; lossless audio and deinterlacing settings not found |
| Poster size, advisory age, theme music, Show Audiobooks | ➖ | ✅ | 🟡 | Tizen honours the saved poster size but has no editor. Android has Poster Size, Theme Music and Show Audiobooks; advisory age not found |
| Acknowledgements (TMDB and open source) | ✅ | ✅ | ➖ | Android: Settings → Server → About shows App Version and Privacy Policy only |
| Privacy policy | ➖ | ✅ | ✅ | Android: `TvPrivacyPolicyDialog` |

## Diagnostics & support

| Feature | Tizen | Apple TV | Android TV | Notes |
|---|:---:|:---:|:---:|---|
| Diagnostics reports | 🚧 | ✅ | ✅ | #137, blocked by #138 (server does not accept a Tizen diagnostics platform). Android: `TvDiagnosticsReportScreen` |
| Notifications inbox | ➖ | ➖ | ✅ | No inbox screen found in the Apple tree. Android: `TvInboxScreen` |

## Platform & release

| Feature | Tizen | Apple TV | Android TV | Notes |
|---|:---:|:---:|:---:|---|
| Tizen 8.0+ web app (`.wgt`), AVPlay, `internet` / `tv.inputdevice` / `productinfo` privileges | ✅ | ➖ | ➖ | Apple ships a native tvOS app. Android ships a native APK (`androidTvApp`) |
| Signed tester builds on GitHub, Promote workflow for store drafts | ✅ | ✅ | ✅ | Apple: TestFlight. Android: Release workflow publishes Play beta and GitHub prerelease APKs; Promote workflow creates the production draft |
| Samsung TV hardware beta | 🟡 | ✅ | ✅ | One S95C (Tizen 9) checked; Tizen 8.0 hardware open (#14). Android: Play beta track and sideload beta APKs |
| Samsung store certification and release | 🚧 | ✅ | 🟡 | Deferred until parity (#15). Android: Promote drafts a Play production release, but no store release has shipped (`docs/releasing.md`) |
| Remote keys (arrows, Enter, Back, media keys), Reduced Motion | ✅ | ✅ | 🟡 | Focus rules in [TV focus](docs/tv-focus.md). Android: D-pad and media keys handled (`TvPlayerRemoteKeyBridge`); Reduced Motion not found |

---

## Platform summary

**Tizen** is a Skyline-style 10-foot client for sign-in, profiles, Movies and Series browsing, details, search, lists, calendar, requests and AVPlay playback with audio, text subtitles and AI subtitles.
It has no music, audiobooks, Watch Party, diagnostics, Smart Hub row, trailers, or player extras (speed, sleep timer, chapters).

**Android TV** is a 10-foot D-pad client built on Media3/ExoPlayer, with the same top-bar layout as tvOS: Home, library-type tabs, For You and Calendar, with Requests in the profile menu.
It covers audiobooks, trailers, the subtitle suite, player extras, diagnostics, the notifications inbox and a Watch Next row.
It has no ebooks, downloads, onboarding tour, voice search, admin screens or session management, and Watch Party is experimental.

**Parity work** is tracked by the umbrella issues #106 and #107, with screen-level issues #92 to #105.
