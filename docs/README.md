# Silo Tizen Docs

Start with the root [README](../README.md) for build, signing and release, and [AGENTS.md](../AGENTS.md) for the platform rules.
[App behaviour](app-behaviour.md) describes what the packaged app does today and what has been proven on a TV.

## Current Product Truth

- The app is a Tizen web app (`.wgt`) for Samsung TVs on Tizen 8.0 or later, and talks only to Silo's native `/api/v2`.
- The top bar follows the server's saved TV menu, falling back to Home, Movies, Series, For You and Calendar, with Search to the left.
  Movies and Series appear only when a matching or mixed library exists.
- Music and Audiobooks menu entries are skipped: the TV app has no music or audiobook playback.
- Requests appears in the top bar only while the server enables it for the active viewer.
- Playback uses AVPlay: direct play first, HLS transcode as the fallback.
- Diagnostics reports are not available yet: Silo Server does not accept a Tizen diagnostics platform ([#138](https://github.com/Silo-Server/silo-tizen/issues/138)).
- No build is submitted to Samsung TV Seller Office until the app reaches parity with the Apple TV app.

## Core References

- [Native API v2](native-api-v2.md) - every `/api/v2` operation the app calls, with its auth, gating and error handling
- [TV focus](tv-focus.md) - read before changing navigation, menus, grids, dialogs or custom controls
- [Releasing](releasing.md) - tester builds, store releases and installing a tester build
- `parity/upstream-snapshot.json` - the Apple TV and Android TV state FEATURES.md was last reviewed against; the weekly Parity drift workflow opens an issue when upstream changes (`scripts/parity-drift.py`)

## Playback

- [Playback quality, completion and recovery](playback/playback-quality.md)
- [Series autoplay](playback/series-autoplay.md)
- [Seek thumbnails](playback/seek-thumbnails.md)
- [Subtitle appearance](playback/subtitle-appearance.md)
- [AI subtitles](playback/ai-subtitles.md)

## Features

- [Skyline browse shell](features/skyline-browse-shell.md) - navigation bar, Home, sections and preplay
- [Library discovery](features/library-discovery.md)
- [Title art](features/title-art.md)
- [Ratings](features/ratings.md)
- [Personal lists](features/personal-lists.md)
- [Person hero](features/person-hero.md) and [filmography](features/person-filmography.md)
- [Profile launch](features/profile-launch.md)
- [Requests](features/requests.md)

## Evidence

- [Samsung simulator evidence](evidence/simulator-evidence.md) - simulator launch, signed-package identity checks and Apple TV comparisons
- `evidence/screenshots/` - captures referenced by pull requests and feature notes, grouped by pull request number
