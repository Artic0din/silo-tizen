# Profile picker and TV creation

Issue #96, based on `f068d8d13b7741bd9183528367b27669d4434d02` plus the reviewed feature working tree.
The screenshots show the signed r4 candidate, captured on 3 November 2026.
They precede the subsequent validation-error placement, structured-rejection and construction-ownership corrections; final publication must refresh the signed package and recording after integration with current main.
They establish Samsung software-simulator rendering, not physical-Tizen acceptance or whole-authentication parity.

## Evidence

| File | Content |
| --- | --- |
| `01-before-after.png` | Same current household before and after: PR130 signed r3 versus the signed profile r4 candidate. |
| `02-apple-picker.png` | Historical Apple picker from 1 November, source `1a7ccee`, against current signed Tizen r4. |
| `03-create-form.png` | Current Tizen form and remote Done/Down reaching lower controls, with blank fields and 18 loaded presets. Both panels are Tizen. |
| `04-create-remote.mp4` | Four seconds of the r4 native simulator form: Done/Down and return to the blank name field after submission. Its error placement predates the correction described above. No account names or entered values appear. |
| `runtime-r4.json` | Sanitized current runtime, loaded-resource hashes and picker geometry. |
| `installed-assets-r4.sha256` | All 14 signed-archive file hashes, freshly compared with the simulator installation. |

Each PNG contains two equal 960 × 540 app frames in a 1940 × 690 canvas.
Samsung captures are native 1920 × 1080, displayed at 50%; the historical Apple 960 × 540 capture is displayed at 100% and is never upscaled.
Black rectangles mask the account line and profile names.
The public images were inspected after composition.
Private originals and excluded captures are not committed.

## Package and runtime

Signed WGT SHA-256: `ab1dc6b1099638016a0cc18cdf1099632877d4c1f2892b59d123198af9fa0df7`.
Installed manifest SHA-256: `691f61cf7a4ac8f5d322d99bf33b280fa44fd6e339aaf37f594961a1809ae87e`.
Loaded JavaScript SHA-256: `472331a7810b9953256d4bf72a347f93306b28aea07328b090f1b02b31b9f0b8`.
Loaded CSS SHA-256: `464622210d57fb46d4f5933f8a83977f11a8b86040b40c954187c51e7809e810`.
All archive files matched the installed files, and CDP-loaded JavaScript/CSS matched the packaged resources.

The Samsung NW.js runtime reports actual Chromium `137.0.7151.69`, logical viewport 1920 × 1080 and DPR 2.
Its simulated TV user agent advertises an older Chrome version; that string is not the actual engine version.
The package requires Tizen 8.0 and the build targets Chromium 108, but this simulator does not establish that physical runtime's behavior.
Only Samsung was running; no physical TV was used, following Ryan's simulator-only instruction.

## Source and calibration

The pinned Swift owners are `ProfileSelectionView`, `ProfileTile`, `AddProfileTile`, `CreateProfileView`, `ProfileAvatarPresets` and `MarqueeControls` at `1a7cceeaf3b2bfc4f889c00487d19b2c6f843940`.
The pinned server create contract is `cc8514943289045e7b9f7ac8d36d4968bfe93926`.

The picker uses a 220 px avatar, 1.12 focus scale, 6 px ring extending 12 px, 240 px columns, 44 px horizontal gaps and up to six columns including Add.
The focused ring footprint is 273.28 px; 270 px is not the base avatar diameter.
The footer's compact type is `29 × 0.85 = 24.65` px and height is `76 × 0.75 = 57` px.
The 120 px vertical CSS inset compensates for the reference TV safe area plus Swift's 60 px padding; it is measured compensation, not a Swift constant.
The form has a 360 px preview column, six preset columns with 96 px cells and Shuffle in the Avatar header.

Inter replaces Apple's system typography.
CSS scaling/rings/shadows and original line icons substitute for native focus rendering and SF Symbols; native parallax/specular behavior is not proven.
The historical and current backdrop animation phases and avatar imagery differ.
Historical avatar request metadata was not recorded, so the image-color difference is not attributed to a verified cause.
Apple's account-to-TV-user caption has no equivalent in this client and is not fabricated.

## Verified behavior and remaining limits

The current-source full behavior run recorded 563 native and 644 UI passes, with no failures or cancellations, including the later error handling and construction-ownership corrections.
It includes the Acknowledgements change, build and both typechecks.
Focused profile checks cover 1–8 total tiles, footer return, reduced motion, image transparency/failure, PIN/lockout, creation scope, child restrictions, duplicate presses, uncertain writes, late replies and remembered-profile preservation.
The native r4 run opened Add, loaded 18 presets, moved through fields with Done/Down, rejected a blank name locally and returned to Add on Back.
Successful creation, primary PIN management, bootstrap and late-response isolation are automated fake-server proof; no live profile was intentionally created or deleted.

Fresh Apple TV interaction was unavailable: the device inventory exposed iPhones and iPads, with no Apple TV target.
The historical picker is the only Apple image comparison here; the new form is source-grounded, without a current Apple form screenshot or measured whole-form pixel claim.
The earlier accepted missing Sign Out screenshot exception does not waive this separate limit.
Physical keyboard integration, real-server create authorization, physical Tizen 8, packaged-origin CORS and AVPlay remain unverified.

Change server currently opens manual entry; saved-server-list parity remains #127.
The picker retains its existing direct Sign out behavior; its confirmation remains #107 NAV-07, separate from the already delivered Browse-menu confirmation.
The earlier Portrait full-suite cancellation remains under #122; later green runs do not establish its cause or a fix.

Captures containing the simulator's Exit prompt were excluded and retaken after dismissal.
An initial resource-hash attempt lacked CDP Page enablement, and a second did not account for resource query strings; neither supplied acceptance evidence.
The successful hash record above uses loaded resources and the exact signed r4 bytes.
