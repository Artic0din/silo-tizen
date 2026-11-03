# Top navigation simulator evidence

Frames 01–07 come from signed navigation build r2; frames 08–09 use correction build r3 in Samsung's NW.js software simulator at a real 1920×1080 viewport.
Frame 10 compares the recorded r2 server destination with a historical Apple capture.
The simulator engine reports Chrome 137.0.7151.69; its Tizen-like user agent is not proof of Tizen 8 or Chromium 108 execution.
The package still requires Tizen 8.0 and the production build targets Chromium 108.
No physical TV was used.

The Apple references are historical 960×540 captures of the app at source revision `1a7cceeaf3b2bfc4f889c00487d19b2c6f843940`.
They are shown at 100%; current 1920×1080 Tizen frames are shown at 50%, giving equal 960×540 display areas without upscaling Apple.
Image labels distinguish historical frames, the previous installed Tizen app and the current signed build.
File timestamps identify the saved capture files, rather than claiming a new Apple capture.
Avatars, profile/server headers and the server address field are masked in the rasterized PNGs.

| Image | Comparison and proof boundary |
|---|---|
| [Home before/after](01-home-before-after.png) | Same focused Continue Watching title; Search moves before the centered roots, For You is present, and the avatar stays at the right. |
| [Movies menu](02-movies-menu.png) | Recommended focused over For You on both platforms; current panel is 460 px wide at y132, with 50 px mode rows and 20 px text. |
| [For You menu](03-for-you-menu.png) | Passive For You dwell over Home/Road Wars on both platforms; the episode and shelf ordering differ between capture dates. |
| [For You feed](04-for-you-feed.png) | Verity is focused on both platforms; current For You uses Home's calibrated artwork, wash, marquee and shelves. |
| [Profile menu](05-profile-menu.png) | Current Tizen only: passive menu and focused Sign Out, with private header masked. |
| [Sign Out confirmation](06-signout-confirmation.png) | Current Tizen only: source-derived two-action layout; explanatory text is not an Apple screenshot. |
| [Switch Server](07-switch-server.png) | Current Tizen only: existing manual-entry destination, with address masked. |
| [Corrected passive dwell](08-corrected-passive-dwell.png) | Signed r3: Movies → Series retains root focus and opens the TV Shows dropdown. |
| [Profile menu comparison](09-profile-apple-comparison.png) | Switch Profile focused on both platforms; historical Apple has Calendar behind the menu and current Tizen has Home. Watch Party remains separate work, so the Tizen menu is one row shorter. |
| [Server destination comparison](10-server-destination-comparison.png) | Historical Apple Manage Servers versus recorded Tizen manual entry; this shows the known saved-server-list gap rather than claiming parity. |

The active account's saved menu produced Home, Series, Movies, For You, Calendar and Requests.
That observed order is not hardcoded: the source default remains Home, Movies, Series, For You and Calendar, with Requests appended by capability.
The resolved avatar and wordmark decoded successfully.
The native For You read produced 13 rows and 231 cards, with one calibrated hero-backdrop owner.
Opening the Sign Out dialog kept the bar inert and `aria-hidden="true"`; Up/Down stayed in the action row, Right selected Sign Out, and Back restored avatar focus without signing out.
The dialog measured 632×259, centered at (644,410.5), with 260×63 action boxes before focus scaling.
Switch Server opened manual entry; Connect restored the existing account, and selecting the profile returned to Home without a new device-code approval.

## Package identity: original layout captures, r2

Signed WGT SHA-256: `cebb1612b15534ff373160e43fa386ef9db892ffa65468e33c84edb5bd44aacf`.
All 14 unpacked package files matched the installed files; their hashes are in [installed-assets.sha256](installed-assets.sha256), whose SHA-256 is `a746b3c761b04584b56c727e233b37ad213d367f13a8162c493dd8f719232ed8`.
All 12 non-signature files also matched the original navigation worktree build after the fixture-only base updates.
The loaded JavaScript and CSS were independently read through the simulator's resource API and matched the package:

- `js/main.js`: `06b6a9e0bb01b7ad5191b78aae97c667ae98e37e5614b7b8f0ada1ac0b3f1c7d`.
- `js/main.css`: `829a5d647296e0b2fbd449ddf0aa7edf8ed2863ca0b202343b086132a1fe6a22`.

## Package identity: review corrections, r3

Signed WGT SHA-256: `2d463c78aaa7dbf5b8c99ae07c6c02774cef09a932acf88c9e634f11c1daae95`.
All 14 unpacked files matched the installed files in [installed-assets-r3.sha256](installed-assets-r3.sha256), whose SHA-256 is `87791e6623bd9012b807a1e63efe76984b162bc274893e8c4ac30af67c9725be`.
The loaded JavaScript independently matched `6662236d28a24bf7b6ba115bb2a817da2ef6d012cc20bf8af6e2f25b3f86515e`; the loaded CSS retained the r2 hash above.
The live remote journey moved Series → Movies → Series with passive dropdowns opening and root focus connected throughout.
Automated regressions additionally cover deferred menu replacement, whole mixed-library shortcuts and cached Home enrichment restart.

## Remaining limits

Inter replaces SF Pro, original SVG drawings replace SF Symbols, and CSS supplies the focus and material effects.
Those substitutions do not establish proprietary font, parallax or material equivalence.
The account has one visible library per video type; multiple-library cascades, authored-menu edge cases, recommendation failures and avatar failures have automated behavioral coverage rather than native captures here.
The historical profile-menu capture is the native 1920×1080 `S18a-profile-menu` frame, whose accompanying capture notes identify the pinned Apple revision and tvOS 27 simulator.
The Manage Servers capture is the earlier 960×540 `tvos-manage-servers-http-active` frame; no fresh build identity is claimed for it.
No Apple Sign Out confirmation frame is available.
The attempted fresh Apple capture session was closed without app interaction because its required `device-interaction` skill was unavailable; the Apple simulator was shut down afterward.
The saved-server list is tracked in [#127](https://github.com/Artic0din/silo-tizen/issues/127); Sign Out & Remove Server remains under #107.
Both are client work, not proven Tizen limitations.
Samsung's NW.js simulator disables web security, so these server requests do not prove packaged-origin CORS behavior, physical-Tizen policy enforcement or successful AVPlay playback.
The simulator was left signed in on Home with focus on its first Continue Watching card; the temporary focus-emulation helper was stopped.
