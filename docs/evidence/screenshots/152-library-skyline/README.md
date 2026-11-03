# Library Recommended shared Skyline evidence

The signed r2 client uses Home's backdrop, marquee and preference-aware shelves on Library Recommended.
These captures were made on 3 November 2026 in Samsung's software simulator.
Physical-TV testing is deferred at the user's direction until simulator parity is complete.

## Build identity

Source: `30ed08c5c0e45261beef0ae6133e72089c15ce89`.
Signed WGT SHA-256: `f03e8286e16ff59eb3b49e16f1ebcdd34aadbee405ef8f2d7930e632a009c07b`.
All 15 archive files matched the simulator installation; [installed-r2.sha256](installed-r2.sha256) records their hashes without certificate contents.
CDP read-back of loaded JavaScript and CSS matched the package for each retained capture.
[runtime-r2.json](runtime-r2.json) records sanitized measurements and the loaded-resource hashes.
The later evidence commit changes documentation and media only.

Samsung SDK 10.0.6 runs NW.js Chromium 137.0.7151.69 here, with a logical 1920×1080 viewport and DPR 2.
The user-agent's Chrome 55 string is not the runtime version.
This is not physical Tizen 8 / Chromium 108, and the SDK's disabled web security cannot establish ordinary packaged-origin CORS behavior.
CDP focus emulation supported the locked-desktop run; it does not establish native visibility handling.

## Captures

| Artifact | What it establishes |
| --- | --- |
| [Before / after](06-recommended-before-after.png) | The earlier signed Library shelf build versus the signed shared scene, both focused on Masterplan in New Releases. |
| [Apple comparison](01-apple-comparison.png) | Historical Apple TV and current Samsung simulator, Masterplan / New Releases / Compact. |
| [Artwork clearance](02-focus-clearance.png) | Failed signed r1 and corrected r2 after Collections → Up; focused artwork stays inside the viewport. |
| [Motion preference](03-motion-preference.png) | Normal artwork lift versus unchanged artwork size with the reduced-motion ring. |
| [Collections / expansion](04-collections-and-expansion.png) | Existing inline collections and the library-scoped expanded catalog. |
| [Failure / Retry](05-failure-and-retry.png) | A controlled local Collections denial retains shelves; disabling that fixture and selecting Retry restores collections. |
| [Remote recording](07-remote-focus.mp4) | Down to Collections and Up to the media row, using the signed r2 client. |

Each paired PNG is 1940×690, containing two 960×540 app areas.
Samsung's 1920×1080 captures are shown at 50%; Apple's 960×540 preview is shown at 100%, without upscaling.
Avatars are masked; screenshot metadata is omitted.
The 7.305-second recording contains 24 time-sampled CDP frames, scaled to 960×540 with the avatar masked.
It establishes the focus journey, not native animation timing or frame rate.

The Apple frame is an actual historical capture from 1 November 2026 at source `1a7cceeaf3b2bfc4f889c00487d19b2c6f843940`.
No tvOS device was available in the current device inventory, so it was not recaptured.
Catalog membership/order differs between captures.
For the Apple comparison, the current Tizen viewport was set to scrollTop 0 and the New Releases row to scrollLeft 574 to align the selected title; no catalog content was changed.
The earlier Tizen shelf build is source `30ccabfb650e8ab78cca7d423acb8239eb7e29db`, package SHA-256 `1f0b92547f9da445f47fcb6d9547d2621278d69501c4f2bd12ff4565ddce01dd`.
That comparison also has different membership/scroll and is not an identical-data pixel comparison.

## Measured behavior

After the native r1 Collections → Up journey, artwork top was 589.195 against viewport top 596, clipping about 6.8 logical pixels.
The correction reserves 20px above shared card buttons during reveal, covering the 19px artwork overhang plus rounding.
The same r2 journey produces artwork top 597.195 and scrollTop 57 instead of 65; viewport geometry remains y596 / height484.
This is measured Tizen clearance, not a new Swift layout constant or a correction for #97's historical Home row-offset observation.

The active server/profile preference was Compact.
Normal focused artwork measured 176.693×265.039; reduced motion measured 151.359×227.039 with `rgba(255, 255, 255, 0.9) 0px 0px 0px 4px`.
Reduced motion was emulated through a persistent CDP connection, verified in the app, then cleared; server preferences were not written.
Native mode switching requested `image_size=medium&logo_width=1760&backdrop_width=2688` at DPR 2.
The focused Masterplan backdrop decoded at 3840×2160; requested width and delivered dimensions are separate observations.

Movies and Series Recommended both used the shared scene, without duplicate mode pills or focusable section headings.
Movies New Releases and Series Continue Watching each opened an existing library-scoped section catalog with 60 initial cards.
Back restored the initiating Explore All control and horizontal position without another catalog/section read.
Movies Details / Back restored the same card and scroll without a catalog/section read.
Settled card movement started no catalog or detail requests.
All six library modes remained available through the existing top-bar menu.
This does not reproduce #89's historical Movies Continue Watching 422: that row was absent from the current Movies response.

For the failure capture, CDP Fetch supplied exactly one local HTTP 403 response for the Movies collections endpoint.
The unchanged signed client retained its media shelves and focused Retry.
Fetch interception was disabled before Retry; the subsequent live read removed the alert and restored the inline collection block.
This proves controlled failure handling, not a failure observed from the live server.
The recovered frame was captured after scroll movement settled.

## Automated proof and limits

The final local full gate exited 0: both typechecks/build, 565 native tests and 654 UI tests passed, with zero failures or cancellations.
Release-version checks passed 17/17; focused focus/motion checks passed 34/34.
Source review approved the bounded implementation and clearance correction.
An earlier full run failed Calendar revalidation; #119 retains that unexplained flake, and subsequent Calendar 24/24 plus the full green run do not establish a Calendar fix.

Compact and reduced motion have current native frames.
Standard/Large, delayed size/overlay/title-art answers, loading/empty states, optional artwork failure and authority-abandonment races have automated coverage; this artifact set does not provide a native frame for every state.
Initial capture-helper failures, an ineffective one-shot media override and the pre-settlement Retry frame are excluded from acceptance evidence.

Inter replaces Apple's font, SVGs replace system symbols, and CSS lift/shadow replaces native parallax/specular effects.
Inline collections intentionally retain their existing tile styling and poster-derived preview; they are absent from the historical Apple frame and are not claimed as calibrated Apple presentation.
Mixed-library scoped refill, other legacy focus owners, detail backgrounds and historical Home row alignment remain separate work.
No whole-screen or whole-app parity PASS is claimed.
No physical TV, AVPlay playback, native visibility or packaged-origin CORS acceptance is established here.
