# Silo Tizen: Feature List

Inventory of what the Samsung TV client does today, and a tracker for parity with the Apple TV (tvOS) app.
Maintainer's rule: no build goes to Samsung TV Seller Office until the app reaches Apple TV parity ([Releasing](docs/releasing.md#store-release)).

Checked against the code on 3 Nov 2026; update a row in the pull request that changes it.

Tizen status legend:

- ✅ implemented and covered by tests; a gap still to prove on a physical TV is named in the row
- 🟡 partial ("bones-level")
- 🚧 planned (open issue, not built)
- 🧪 experimental
- ➖ not present on this platform

Apple TV column: ✅ present in the tvOS source, 🟡 present but opt-in or limited, ➖ not found in the tvOS source, ? not established.
Issue numbers refer to open issues in this repository; a gap without its own issue is part of the Apple TV parity umbrella, #106.
Apple names (`TVServerSetupView` and so on) are types or paths in [silo-apple](https://github.com/Silo-Server/silo-apple).
File pointers are repository-relative.

> **Validation note:** Almost every row is verified by native tests and desktop Chromium with fake Silo and AVPlay implementations, plus signed-package checks in Samsung's TV simulator.
> The composed app has run on one physical TV, an S95C on Tizen 9: device-code sign-in, profile selection, catalog reads, relaunch restore, direct play, seek, one audio-track replan, and sign-out.
> Tizen 8.0 hardware, the TV keyboard, remux/transcode, audible track changes and store builds are still open (#14, #13, #11; see [App behaviour](docs/app-behaviour.md#validation-limits)).
> Rows say "not yet validated on a TV" only where the docs call out a specific gap.

---

## Sign-in & server

| Feature | Tizen | Apple TV | Notes |
|---|:---:|:---:|---|
| Manual server entry (HTTPS; HTTP and port under Advanced) | ✅ | ✅ | `src/ui/signIn.ts`. A bare address tries HTTPS, then asks before using HTTP. TV keyboard not yet validated. Apple: `TVServerSetupView` |
| LAN server discovery | ➖ | ? | Apple has `DiscoveredServerList`; whether tvOS uses it is not confirmed |
| Device-code sign-in with QR | ✅ | ✅ | Eight-digit code approved on Silo's web page. Proven on the S95C |
| Password sign-in | ✅ | ✅ | "Sign in with a password"; hidden when the server turns passwords off |
| Phone-assisted pairing (a nearby phone approves the TV) | ➖ | ✅ | Apple: `Pairing/Receiver`, `Pairing/Companion` |
| First-run onboarding tour | ➖ | ✅ | Apple: `OnboardingTourPresentation+tvOS.swift` |
| Switch Server | 🟡 | ✅ | Opens manual entry and keeps saved sign-ins. Saved-server list is planned (#127). Apple: `ServerListView` |
| Sign out with confirmation | ✅ | ✅ | Cancel and Back keep the session |
| Sign Out & Remove Server | 🚧 | ✅ | Tracked under #107. Apple: `signOutRemoveServerAndReset` |

## Profiles

| Feature | Tizen | Apple TV | Notes |
|---|:---:|:---:|---|
| Household profile picker (avatars, account line, Change server) | ✅ | ✅ | `src/ui/profilePicker.ts`. Simulator-calibrated only |
| PIN-protected profiles, lockout handling | ✅ | ✅ | PIN never stored; proof kept only if the viewer opts in |
| Create profile (presets, PIN, child restrictions) | ✅ | ? | Ported from Apple's `CreateProfileView`; whether tvOS exposes it is not confirmed |
| Remember profile at launch | 🟡 | ✅ | Two choices: remember, or ask each launch. Timed choices not built. Apple: `ProfileLaunchPreferences` |
| Apple TV user mapping | ➖ | ✅ | Apple-only concept (`AppleTVUserContext`) |
| Per-profile settings applied (hidden libraries, audio, quality, bitrate, seek, subtitles, title art, poster size, badges) | ✅ | ✅ | Read from the server settings contract on each use |

## Navigation & Home

| Feature | Tizen | Apple TV | Notes |
|---|:---:|:---:|---|
| Skyline top bar (saved TV menu order, centred roots, anchored menus, profile avatar) | ✅ | ✅ | `src/ui/navigation.ts`. Parity captures in `docs/evidence/screenshots/94-navigation`. Focus and card styling parity open (#97) |
| Home rows in server order, Continue Watching resume, Explore all, 20-card cap | ✅ | ✅ | Resume goes straight to the player. First-load wait tracked in #78 |
| Home marquee (logo, meta chips, scores, aired date, cast) | ✅ | ✅ | Apple: `TVFocusMarquee`. Sharper backdrops open (#88) |
| Poster badges, watched checks, poster size (Compact/Standard/Large) | ✅ | ✅ | Size is read-only on Tizen; see Settings |
| Card actions on Select-hold (watched, favourites, watchlist) | ✅ | ? | Desktop tests only; real Samsung Select repeat/release is unverified |
| Live home refresh (events socket) | ➖ | ? | Apple has a draft spec (`docs/realtime-updates-spec.md`); no Home owner found in the tree |
| Row headings non-focusable | 🚧 | ? | #86 |

## Browse & libraries

| Feature | Tizen | Apple TV | Notes |
|---|:---:|:---:|---|
| Movies and Series tabs, per-type library scope | ✅ | ✅ | Scope remembered per server, profile and type |
| Library modes: Recommended, Browse, Collections, Genres, A–Z, Recently Added | ✅ | ✅ | Apple: `TVLibraryTypeTabView`. Recommended presentation (#152); opening a section heading returns HTTP 422 (#89) |
| Browse grid: sort, filters, A–Z rail, remembered choices | ✅ | ✅ | 100 cards per read. Apple: `TVLibraryGridView`, `TVBrowseFilterUI` |
| Expanded section grid (60-card reads) | ✅ | ✅ | Apple: `SectionCatalogView` |
| Collections (fan-card grid, personal collections) | ✅ | ✅ | Layout parity open (#100) |
| Library Shuffle | ✅ | ✅ | Server-owned; hidden in mixed-library scope. Apple: `ShuffleFeatureStore` |
| Music | 🚧 | ✅ | Blocked on the server parity contract (#56) |
| Audiobooks | 🚧 | ✅ | #55. Apple: `TVAudiobookDetailView`, `AudioFullPlayerView` |

## Search

| Feature | Tizen | Apple TV | Notes |
|---|:---:|:---:|---|
| Text search (debounced, paginated, episodes when the server supports it) | ✅ | ✅ | Uses the TV keyboard, not yet validated. Layout parity open (#99) |
| Voice search | ➖ | ✅ | Apple: Siri search request into `SearchView` |

## Details & people

| Feature | Tizen | Apple TV | Notes |
|---|:---:|:---:|---|
| Movie and series details (artwork, facts, ratings, cast and crew, versions) | ✅ | ✅ | Layout parity open (#92) |
| Series → seasons → episodes | ✅ | ✅ | Separate episode page to be dropped for direct play (#93) |
| Related titles | 🟡 | ✅ | Series page shows "Could not load related titles" (#90). Apple: `TVSimilarRail` |
| Person page (bio, age, photo, filmography preview) | ✅ | ✅ | Layout parity open (#102) |
| Full filmography (All, Movies, Series) | ✅ | ? | Server-filtered, paged |
| Trailers | ➖ | ✅ | Server gives a site key, not an AVPlay stream URL. Apple: `TVTrailersRail` |
| Local extras | ➖ | ? | |
| Synopsis dialog | ✅ | ? | |

## Personal lists & ratings

| Feature | Tizen | Apple TV | Notes |
|---|:---:|:---:|---|
| Watchlist, Favorites, History pages | ✅ | ✅ | Tizen: profile menu. Apple: Watchlist and Favorites under For You, History in the profile menu. Grid parity open (#105) |
| Watched / favourite / watchlist actions on details | ✅ | ? | Server-confirmed readback, never auto-replayed. Rating write reconcile open (#84) |
| Personal star rating (1–5) | ✅ | ➖ | Apple shows external scores only; no personal ratings client in the tree. Missing-rating log noise (#79) |
| External scores (IMDb, TMDB) | ✅ | ✅ | TMDB logo and notice in Acknowledgements |
| Title art switch (this TV or all devices) | ✅ | ✅ | |

## Recommendations / For You

| Feature | Tizen | Apple TV | Notes |
|---|:---:|:---:|---|
| For You hub (discover rows, Explore all) | ✅ | ✅ | Reuses Home renderers. Apple: `RecommendationsView` |
| Watchlist and Favorites shortcuts from the For You menu | ➖ | ✅ | Tizen reaches them from the profile menu (#105) |

## Calendar

| Feature | Tizen | Apple TV | Notes |
|---|:---:|:---:|---|
| Weekly calendar, Following / Trending / All | ✅ | ✅ | Top-bar root. Layout parity open (#101); intermittent test failure (#119) |

## Requests

| Feature | Tizen | Apple TV | Notes |
|---|:---:|:---:|---|
| Requests hub, discover rows, search, detail, My Requests, cancel | ✅ | ✅ | Shown only when the server enables it. Bugs: focus (#74), status text (#75), artwork (#76). Layout parity open (#98) |
| Follow / unfollow a requested title | ✅ | ? | |
| Request administration | ➖ | ➖ | Stays in web admin |

## Playback

| Feature | Tizen | Apple TV | Notes |
|---|:---:|:---:|---|
| AVPlay engine, server-planned direct play | ✅ | ✅ | `src/player/`. Direct play proven on the S95C (Tizen 9); Tizen 8.0 open. Apple uses its own engine ([silo-apple `docs/tvos-player`](https://github.com/Silo-Server/silo-apple/tree/main/docs/tvos-player)) |
| Remux / HLS transcode fallback | ✅ | ✅ | Server-planned. Progressive class not advertised. Not yet validated on a TV |
| Resume, progress every 10 s, final stop | ✅ | ✅ | Resume reads fresh progress for up to 3 s |
| Recovery after suspend or connection loss | ✅ | ? | Bounded backoff; real suspend/restore unverified (#13) |
| In-player quality picker | ✅ | ✅ | Options come from the server plan |
| Seek preview, Rewind/Fast Forward keys, profile seek intervals | ✅ | ✅ | Player panel and scrubber parity open (#103) |
| Seek thumbnails | ✅ | ✅ | Needs server trickplay. Apple: `ServerTrickplay` |
| Skip intro, recap, credits | ✅ | ✅ | Enter on Skip pauses instead of skipping (#73); on-screen buttons to remove (#87) |
| Autoplay next episode (10 s countdown, Cancel) | ✅ | ✅ | Reads the server setting. Stale after the episode ends (#82) |
| Playback speed | ➖ | ✅ | Apple: HUD Speed row |
| Sleep timer | ➖ | ✅ | |
| Chapters | ➖ | ✅ | Apple: HUD Chapters tab |
| Info / stats HUD | ➖ | ✅ | Apple: `TVPlayerInfoHUD` |
| HDR, Dolby Vision, 4K, audio passthrough | ➖ | ✅ | Capabilities declare SDR up to 1080p, H.264/HEVC, no DTS (`src/player/capabilities.ts`) |
| Watch Party | 🚧 | 🟡 | #54. Apple: opt-in under Extra Features |
| Phone "Play on TV" / remote control | ➖ | ✅ | Apple: `TVControlReceiver` |
| Smart Hub / Top Shelf row | ➖ | ✅ | Apple: [`iosApp/TopShelf`](https://github.com/Silo-Server/silo-apple/tree/main/iosApp/TopShelf) |

## Subtitles & audio

| Feature | Tizen | Apple TV | Notes |
|---|:---:|:---:|---|
| In-player audio track switch | ✅ | ✅ | Server replans. Audible change not confirmed on a TV (#11) |
| Preplay audio and file-version picker | ✅ | ✅ | Tizen choice lasts one attempt; Apple persists per title or series. Apple: `TVPlaybackSelectorRow` |
| Text subtitles (VTT/SRT, ASS dialogue) in an app overlay | ✅ | ✅ | Captions not yet verified on a TV or simulator (#80) |
| Embedded subtitle burn-in | ✅ | ? | Server burns in when transcoding is allowed |
| ASS styling, bitmap subtitles | ➖ | ✅ | Apple: ASS renderer ([`docs/tvos-player/ass-subtitles.md`](https://github.com/Silo-Server/silo-apple/blob/main/docs/tvos-player/ass-subtitles.md)) |
| Profile subtitle appearance and sync offset applied | ✅ | ✅ | Read-only; no editor (see Settings) |
| Series subtitle choice (keep or Off) | ✅ | ? | |
| Subtitle labels by language | 🟡 | ? | #77 |
| AI subtitle translate / transcribe (quota-aware) | ✅ | ✅ | Retry and duplicate-job fixes open (#83) |
| Subtitle search and download | ➖ | ✅ | Apple: `SubtitleSearchMenu` |

## Settings

| Feature | Tizen | Apple TV | Notes |
|---|:---:|:---:|---|
| Settings categories | 🟡 | ✅ | Tizen: General, Playback, Server. Apple adds Subtitles and Diagnostics (#104) |
| Hidden libraries | ✅ | ? | |
| Preferred audio, quality, maximum bitrate, seek intervals | ✅ | ✅ | Server-confirmed writes |
| Autoplay, Next Up, Skip Intros, Skip Credits switches | ➖ | ✅ | Tizen reads autoplay but never writes it |
| Subtitle settings (language, behaviour, appearance) | ➖ | ✅ | Apple: `TVSubtitleSettingsView` |
| HDR, Dolby Vision, buffering, lossless audio, deinterlacing | ➖ | ✅ | |
| Poster size, advisory age, theme music, Show Audiobooks | ➖ | ✅ | Tizen honours the saved poster size but has no editor |
| Acknowledgements (TMDB and open source) | ✅ | ✅ | |
| Privacy policy | ➖ | ✅ | |

## Diagnostics & support

| Feature | Tizen | Apple TV | Notes |
|---|:---:|:---:|---|
| Diagnostics reports | 🚧 | ✅ | #137, blocked by #138 (server does not accept a Tizen diagnostics platform) |
| Notifications inbox | ➖ | ➖ | No inbox screen found in the Apple tree |

## Platform & release

| Feature | Tizen | Apple TV | Notes |
|---|:---:|:---:|---|
| Tizen 8.0+ web app (`.wgt`), AVPlay, `internet` / `tv.inputdevice` / `productinfo` privileges | ✅ | ➖ | Apple ships a native tvOS app |
| Signed tester builds on GitHub, Promote workflow for store drafts | ✅ | ✅ | Apple: TestFlight |
| Samsung TV hardware beta | 🟡 | ✅ | One S95C (Tizen 9) checked; Tizen 8.0 hardware open (#14) |
| Samsung store certification and release | 🚧 | ✅ | Deferred until parity (#15) |
| Remote keys (arrows, Enter, Back, media keys), Reduced Motion | ✅ | ✅ | Focus rules in [TV focus](docs/tv-focus.md) |

---

## Platform summary

**Tizen** is a Skyline-style 10-foot client for sign-in, profiles, Movies and Series browsing, details, search, lists, calendar, requests and AVPlay playback with audio, text subtitles and AI subtitles.
It has no music, audiobooks, Watch Party, diagnostics, Smart Hub row, trailers, or player extras (speed, sleep timer, chapters).

**Parity work** is tracked by the umbrella issues #106 and #107, with screen-level issues #92 to #105.
