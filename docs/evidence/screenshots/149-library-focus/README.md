# Library Recommended shelf focus

These permanent calibration references cover issue #149, the shelf-specific part of #97.
The signed r1 package uses source `30ccabf`, captured on 3 November 2026.
They do not establish whole Library Recommended parity.

## Captures

| File | What it establishes |
| --- | --- |
| `01-before-after.png` | The same current household, In Theaters row and Fall 2 focus: installed signed r6 before, signed #149 r1 after. |
| `02-apple-comparison.png` | Masterplan in New Releases on historical Apple and current Samsung. Catalog membership/order, resting artwork sizes, chrome and hero composition differ. |
| `03-motion-preference.png` | The same current Masterplan focus with normal and reduced motion. |
| `04-remote-focus.mp4` | A 9.976-second, 32-frame time-sampled Right/Left round trip returning to the original card; this is not native animation-timing proof. |
| `runtime-r1.json` | Loaded-resource hashes, settled geometry, sanitized observed request paths, Back restoration and reduced-motion measurements. |
| `installed-r1.sha256` | All 15 archive files, compared byte-for-byte with installation. |

Each PNG is 1940×690 with equal 960×540 app frames.
Samsung's native 1920×1080 captures are displayed at 50%; Apple's historical 960×540 capture is displayed at 100%, never upscaled.
Black rectangles mask avatars.
The PNGs have only IHDR, IDAT and IEND chunks; the video has no audio or copied source metadata.
Private originals, signed packages and logs are not committed.

## Package and checks

Signed r1 WGT SHA-256: `1f0b92547f9da445f47fcb6d9547d2621278d69501c4f2bd12ff4565ddce01dd`.
All 15 package files matched the installed copy.
Loaded JavaScript and CSS matched the signed bytes, with hashes recorded in the runtime JSON.
The baseline was the previously signed r6 package from source `e367fe0`; its installed bytes were backed up before the update.

Fresh local checks passed: 564 native tests, 646 UI tests, both typechecks/build and 17 release-version checks.
The focused suite passed 20/20, covering normal/reduced motion, first/last clipping, caption clearance/contrast, exact Back restoration, missing-card fallback and no requests on focus moves.
The valid RED recorded whole-button `matrix(1.05, 0, 0, 1.05, 0, 0)` versus `none`, and a white button border versus transparent.
Sol approved the bounded five-file correction in R2; autoreview reported no actionable findings.
Neither review independently operated the simulator.

## Calibration

Pinned Swift `TVMediaCard` distinguishes native `.card` lift from ring controls; `TVCardFocusStyle` supplies caption opacity .45/.32, focused highlights/glow and 8 px clearance.
The 38 px added artwork height is the existing measured CSS substitute for native card lift, not a universal Swift scale constant.
The shelf retains its 208×312 artwork; its focused artwork measured 233.333×350 with an unscaled button, transparent border and 8 px caption gap.
A 16 px viewport gutter preserves resting content positions and accommodates the measured left-edge overhang.
The last card's artwork remained fully visible at horizontal scroll 1096.
Details → Back restored that card and scroll positions 1096 horizontally and 543.5 vertically.
Reduced motion retained 208×312 artwork and the 4 px ring.

The observed Right/Left round trip made artwork image requests only; it made no catalog/detail reads or writes.
The simulator was initially hidden by the locked desktop, so Select correctly did not activate through the existing hidden-page guard.
Details/Back and reduced-motion checks used CDP focus emulation; native visibility handling is not claimed.
The focus helper was stopped after capture and the reduced-motion override was cleared.

## Limits and retained work

Actual Samsung NW.js Chromium is 137, with logical 1920×1080 and DPR 2.
The package minimum is Tizen 8.0 and its build target is Chromium 108; this simulator does not establish physical-Tizen behavior.
The simulator disables web security, so it cannot prove packaged-origin CORS.
No physical TV was used, following the simulator-only instruction.
No playback or personal-state mutation was submitted.

The historical Apple source is `1a7ccee`, from the 1 November Movies-library capture.
The current device inventory provided no Apple TV target, so no fresh Apple interaction was performed.
The compared Masterplan selection and row are shared, but data order and layout are not identical.
Inter/system typography, CSS shadow/lift and original icons remain substitutes; native parallax and specular effects are unproven.
The shelf's resting dimensions, legacy mode strip, backdrop/hero composition, section-heading controls and metadata differences remain outside #149.
Those Library layout observations, detail background ownership and the historical Home row offset remain under #97; this correction does not change Home scrolling or the global background.
