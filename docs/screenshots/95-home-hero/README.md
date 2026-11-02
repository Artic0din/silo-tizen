# Home hero artwork evidence

These Tizen frames show signed build r1 in Samsung's NW.js software simulator at a real 1920×1080 viewport.
The engine is Chromium 137; this does not establish physical Tizen 8/Chromium 108 behavior, packaged-origin CORS or AVPlay playback.
No physical TV was used.

## Actual cold-to-ready transition

[Cold and ready](01-cold-to-ready.png) shows Vigil S03E03 in the same running build, with the same focused card.
Only the real `/images/capabilities` response was held at its response stage and then released unchanged with status 200.
Only the optional image-capability cache was cleared; no preference, watch-state or playback operation was performed.
Normal profile selection reused the existing signed-in account; no password submission or device-code approval was performed.
The browser initially decoded a 300×169 backdrop, then a 3840×2160 backdrop after the capability answer.
The 1344-CSS-pixel backdrop budget produced a 2688-image-pixel request at the simulator's device pixel ratio of 2; the logo request was 1760 image pixels.
The server delivered the larger image, so 3840 is an observed decode size rather than a requested layout constant.
Home made exactly two section reads, recorded in [the sanitized transition record](cold-to-ready.json).
The focus identity stayed `episode-tvdb-384968-3-3`.
Metadata enrichment continued independently; the cast line had arrived by the ready capture.
The ready image is the settled capture, rather than the first frame of the repaint.

The first interception attempt ended with an invalid interception identifier and simulator exit.
It is excluded from acceptance evidence; no application root cause was established.
After relaunch, response-stage continuation completed successfully without that failure.

## Apple comparison

[Spidey hero comparison](02-spidey-apple-comparison.png) uses the historical Apple `S03-home-scrolled` capture and the current signed Tizen build, both focused on Spidey and His Amazing Friends.
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

## Package and running assets

Signed WGT SHA-256: `f33e760ada8bf0bfbef660422edae19cc265cbf537f09301fe7776ba364f0900`.
All 14 archive files matched the installed files in [installed-assets.sha256](installed-assets.sha256), whose SHA-256 is `d7928a735beb3e38d04432a9d201797141aba731847c2acef005e28643451296`.
Loaded resources were independently read through CDP and matched the build:

- `js/main.js`: `916a857eccfd9a72f4103c9f8d579ea381ba0eb98c480ccd7a8aae4c08fac165`.
- `js/main.css`: `829a5d647296e0b2fbd449ddf0aa7edf8ed2863ca0b202343b086132a1fe6a22`.

The simulator remains on Home with the signed candidate installed.
Temporary interception and focus-emulation helpers are closed.
