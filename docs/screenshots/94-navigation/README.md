# Top navigation simulator evidence

The current frames come from signed navigation build r2 in Samsung's NW.js software simulator at a real 1920×1080 viewport.
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

The active account's saved menu produced Home, Series, Movies, For You, Calendar and Requests.
That observed order is not hardcoded: the source default remains Home, Movies, Series, For You and Calendar, with Requests appended by capability.
The resolved avatar and wordmark decoded successfully.
The native For You read produced 13 rows and 231 cards, with one calibrated hero-backdrop owner.
Opening the Sign Out dialog kept the bar inert and `aria-hidden="true"`; Up/Down stayed in the action row, Right selected Sign Out, and Back restored avatar focus without signing out.
The dialog measured 632×259, centered at (644,410.5), with 260×63 action boxes before focus scaling.
Switch Server opened manual entry; Connect restored the existing account, and selecting the profile returned to Home without a new device-code approval.

## Package identity

Signed WGT SHA-256: `cebb1612b15534ff373160e43fa386ef9db892ffa65468e33c84edb5bd44aacf`.
All 14 unpacked package files matched the installed files; their hashes are in [installed-assets.sha256](installed-assets.sha256), whose SHA-256 is `a746b3c761b04584b56c727e233b37ad213d367f13a8162c493dd8f719232ed8`.
All 12 non-signature files also matched the final worktree's fresh build after the fixture-only base updates.
The loaded JavaScript and CSS were independently read through the simulator's resource API and matched the package:

- `js/main.js`: `06b6a9e0bb01b7ad5191b78aae97c667ae98e37e5614b7b8f0ada1ac0b3f1c7d`.
- `js/main.css`: `829a5d647296e0b2fbd449ddf0aa7edf8ed2863ca0b202343b086132a1fe6a22`.

## Remaining limits

Inter replaces SF Pro, original SVG drawings replace SF Symbols, and CSS supplies the focus and material effects.
Those substitutions do not establish proprietary font, parallax or material equivalence.
The account has one visible library per video type; multiple-library cascades, authored-menu edge cases, recommendation failures and avatar failures have automated behavioral coverage rather than native captures here.
No Apple profile-menu, confirmation or server-selection frame is claimed.
The saved-server list and Sign Out & Remove Server remain client work under #107, not proven Tizen limitations.
Samsung's NW.js simulator disables web security, so these server requests do not prove packaged-origin CORS behavior, physical-Tizen policy enforcement or successful AVPlay playback.
The simulator was left signed in on Home with focus on its first Continue Watching card; the temporary focus-emulation helper was stopped.
