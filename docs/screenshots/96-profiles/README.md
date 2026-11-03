# Profile picker and TV creation

Issue #96, source commit `985960e3152dbc0b5e0eacfc56a79a8827df7130`, incorporating main `031d5f42935aec467997db4fb6ce4fa4a4d796bc`.
The screenshots show the signed r5 package, captured on 3 November 2026 after the final error-handling and ownership corrections.
The current r6 package at source `e367fe0dfe6f2f8ef4466a2a13fc6aa771c52dd2` incorporates main `335b03e` and adds its packaged `NOTICE`.
All 12 shared non-signature files, including HTML, configuration, JavaScript, CSS and fonts, are byte-identical to r5; the signing certificates are unchanged.
The r5 media retain their original labels and remain the UI reference for that unchanged runtime payload.
They establish Samsung software-simulator rendering, not physical-Tizen acceptance or whole-authentication parity.

## Evidence

| File | Content |
| --- | --- |
| `01-before-after.png` | Same current household before and after: PR130 signed r3 versus the signed profile r5 package. |
| `02-apple-picker.png` | Historical Apple picker from 1 November, source `1a7ccee`, against current signed Tizen r5. |
| `03-create-form.png` | Current Tizen form, blank fields and 18 loaded presets; local blank-name validation beside its focused input. Both panels are Tizen. |
| `04-create-remote.mp4` | Four seconds of the r5 native simulator form: Done/Down, visible local validation and retained Name-field focus. No account names or entered values appear. |
| `runtime-r5.json` | Sanitized current runtime, loaded-resource hashes and picker geometry. |
| `recording-r5.json` | 32 native frames captured in 4001 ms, encoded at 8 fps; validation in view, Name focused and zero observed profile-write requests. |
| `installed-assets-r5.sha256` | All 14 signed-archive file hashes, freshly compared with the simulator installation. |
| `installed-assets-r6.sha256` | Current r6 archive: 15 files, including main's new `NOTICE`, compared with the simulator installation. |
| `package-bridge-r5-r6.json` | Exact shared-payload and signing-certificate comparison between the captured r5 and current r6 packages. |
| `runtime-r6.json` | Loaded-resource identity during r6 startup; this is not a profile-screen capture. |

Each PNG contains two equal 960 × 540 app frames in a 1940 × 690 canvas.
Samsung captures are native 1920 × 1080, displayed at 50%; the historical Apple 960 × 540 capture is displayed at 100% and is never upscaled.
Black rectangles mask the account line and profile names.
The public images were inspected after composition.
Private originals and excluded captures are not committed.

## Package and runtime

Signed WGT SHA-256: `110cf2ddeac717d46402f6390954f0a9bd62c77458019bb9d8269cf38dd44ead`.
Installed manifest SHA-256: `3e3869d59b61bb0c61773ce0ff7438b19019da3d53c73ce1e41639d48da9e181`.
Loaded JavaScript SHA-256: `b1d3a0a6b8658ea75d7f64c3051d2bed67a7ddda8ef69bd7bd1df61c2ce1eb59`.
Loaded CSS SHA-256: `464622210d57fb46d4f5933f8a83977f11a8b86040b40c954187c51e7809e810`.
All archive files matched the installed files, and CDP-loaded JavaScript/CSS matched the packaged resources.

Current r6 WGT SHA-256: `0f54749be8518c3ac20fe6d737c7f87f1b9526292b7ced3595d545f6d359ba3f`.
Current r6 installed manifest SHA-256: `b3a20768049bba42b82d287d2c4232313b4634d2d2f433db40d3e5aff6ae2865`.
The JavaScript and CSS hashes above are identical in r5 and r6.
Only `NOTICE` was added; the two signature files changed while their embedded certificates remained identical.

The Samsung NW.js runtime reports actual Chromium `137.0.7151.69`, logical viewport 1920 × 1080 and DPR 2.
Its simulated TV user agent advertises an older Chrome version; that string is not the actual engine version.
The simulator disables web security, so successful requests do not establish production CORS behavior.
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

The integrated-source full behavior run recorded 564 native and 644 UI passes, with no failures or cancellations, including the error handling and construction-ownership corrections.
It includes the Acknowledgements change, build and both typechecks.
The release-version script checks also passed 17/17.
Focused profile checks cover 1–8 total tiles, footer return, reduced motion, image transparency/failure, PIN/lockout, creation scope, child restrictions, duplicate presses, uncertain writes, late replies and remembered-profile preservation.
The native r5 run opened Add, loaded 18 presets, moved through fields with Done/Down, rejected a blank name locally with the error visible and Name still focused, and returned to Add on Back.
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
An initial r5 recording used separate raw-key and character Enter events and lost focus after validation.
The verified run uses one trusted Enter key-down carrying its text followed by key-up; focus remained on Name before and after key-up, without an application change.
The failed recording is excluded.
The successful hash and recording records above use loaded resources and the exact signed r5 bytes.
The r6 recapture returned to server entry; its wrong-state frames were excluded and the verified r5 media were restored before publication.
No application cause was established for that state change, and no r6 profile-screen or successful sign-in-restore claim is made.
A later startup-resource reread did not expose the CSS resource and was excluded; `runtime-r6.json` retains the earlier successful JS/CSS identity record.
