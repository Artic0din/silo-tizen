# Home hero artwork evidence

The cold-to-ready pair records signed build r2; the Apple comparison shows current signed build r3.
Both run in Samsung's NW.js software simulator at a real 1920×1080 viewport.
The engine is Chromium 137; this does not establish physical Tizen 8/Chromium 108 behavior, packaged-origin CORS or AVPlay playback.
No physical TV was used.

## Actual cold-to-ready transition

[Cold and ready](01-cold-to-ready.png) shows Vigil S03E03 in the same running r2 build, with the same focused card.
Only the real `/images/capabilities` response was held at its response stage and then released unchanged with status 200.
Only the optional image-capability cache was cleared; no preference, watch-state or playback operation was performed.
Normal profile selection reused the existing signed-in account; no password submission or device-code approval was performed.
The browser initially decoded a 300×169 backdrop, then a 3840×2160 backdrop after the capability answer.
The 1344-CSS-pixel backdrop budget produced a 2688-image-pixel request at the simulator's device pixel ratio of 2; the logo request was 1760 image pixels.
The server delivered the larger image, so 3840 is an observed decode size rather than a requested layout constant.
Home made exactly two section reads, recorded in [the sanitized transition record](cold-to-ready.json).
The focus identity stayed `episode-tvdb-384968-3-3`.
Metadata enrichment continued independently; the cast line is present in both captures.
The ready image is the settled capture, rather than the first frame of the repaint.
The correction merges artwork into retained section/card identities without rereading libraries/preferences or restarting pending metadata.
Automated regressions cover optional artwork-read failure, hidden-library preservation, in-flight metadata and incomplete remembered sizing; those failure scenarios were not injected into the live server.

During the earlier r1 capture, the first interception attempt ended with an invalid interception identifier and simulator exit.
It is excluded from acceptance evidence; no application root cause was established.
After relaunch, response-stage continuation completed successfully without that failure.

## Apple comparison

[Spidey hero comparison](02-spidey-apple-comparison.png) uses the historical Apple `S03-home-scrolled` capture and current signed Tizen r3, both focused on Spidey and His Amazing Friends.
The accompanying Apple capture notes identify source revision `1a7cceeaf3b2bfc4f889c00487d19b2c6f843940`, tvOS 27 and a 1920×1080 logical viewport.
Both native 1920×1080 captures are displayed at 50%, giving equal 960×540 areas with no Apple upscaling.
The labels disclose the historical/current dates, and both avatars are masked.
Catalog row order and membership changed between captures.

The current hero shows the series logo, TV-Y chip, year/genre and TMDB rating, an ellipsized two-line synopsis, billed cast and 1080p/EAC3 chips.
Its DOM measurements are: logo box (88,146) 880×200; metadata (88,360) 780×27; synopsis (88,401) 780×56; credits (88,471) 780×24; file-chip row (88,509) 880×27.
The backdrop frame is approximately (691.2,0) 1228.8×756, matching the pinned Swift footprint.
Inter replaces SF Pro, approved TMDB artwork replaces the older text mark, and SVG/CSS supplies platform icon/focus/material equivalents.

This is not a whole-screen parity PASS.
The focused Trending row appears about 70 logical pixels lower on current Tizen than in the historical Apple frame; this existing focus/row-alignment observation is tracked under #97.
The artwork correction does not change row scrolling or geometry.
Text-only/wrapped-title, delayed logo, missing-file and failed-probe paths have automated coverage; no new native captures of those states are claimed here.

## Card actions correction

Build r3 defers new artwork upgrades while Card actions is open, preserving watched-state invalidations for the normal content refresh on dismissal.
The controlled UI regression reproduced an extra artwork read while the dialog was open; after the guard it verifies no read until dismissal and the required watched-membership reload.
On signed r3, the simulator opened Card actions with its loaded controls and Back returned to Home with the same episode focus; no action was submitted.
The current Spidey capture was taken afterward.

The attempted r3 response-interception proof is excluded: two setup runs stopped before the expected profile state, and the controlled run ended when the simulator exited during interception.
No application cause was established, and no successful native interception/deferred-read proof is claimed for r3.
The recorded real cold-to-ready transition remains r2 evidence; the r3 timing/invalidation guarantee is established by the controlled UI regression and source review.

## Package and running assets

Current signed r3 WGT SHA-256: `0cf6b772818c6fe4e3181a7e0629b15193f0f6153095e337fc66cb06f331231e`.
All 14 archive files matched the installed files in [installed-assets-r3.sha256](installed-assets-r3.sha256), whose SHA-256 is `d469e3878850e8ad50bd8168826daeb3a549d65f3f982cb07e4f38c20c226ca3`.
The cold-to-ready r2 package was `c103505709b5b0a707f5ca6c78a929d6ec9fb8bf390c52aaf58e1682aa14b94b`, with its earlier [installed manifest](installed-assets-r2.sha256) retained separately.
The [r1 installed manifest](installed-assets.sha256) is retained as earlier-build evidence, not the current installation.
Loaded resources were independently read through CDP and matched the build:

- `js/main.js`: `b5c3831adaa246d8b19d1efbffb100f1fae5d8dac518163ddcf040d7649b2a5c`.
- `js/main.css`: `829a5d647296e0b2fbd449ddf0aa7edf8ed2863ca0b202343b086132a1fe6a22`.

The simulator remains on Home with the signed candidate installed.
Temporary interception and focus-emulation helpers are closed.
