# silo-tizen

Silo client for Samsung Tizen TVs from model year 2021 (Tizen 6.0).

## Native app

The packaged app uses Silo's native `/api/v2`: server entry, device-code sign-in, household profiles and PINs, Movies and Series browsing, and AVPlay playback with audio and subtitle selection.
The earlier Jellyfin-compatible client is retired.
Sign-in now uses an eight-digit device code approved on Silo's web page instead of entering an account password on the TV.
The server address is remembered publicly; credentials use Tizen KeyManager or the explicit session-only mode when protected storage is unavailable.

`src/main.ts` boots the app through `src/bootstrap.ts` and `src/platform.ts`.
`src/app.ts` composes the screen controllers without owning their network or credential logic.
The profile controller remains active while browsing and playback use its profile authority.
When that authority ends, the app removes the old content before the profile controller takes the screen back.
Player Back, completion and dismissed errors return to the same browse view and focus.
Back from Home or library content returns to the navigation bar, then selects Home, then opens an Exit/Cancel dialog.
Modal keys do not reach the screen underneath.

## Layout

The TV interface follows the [Skyline design guide](https://github.com/Silo-Server/silo-apple/blob/main/docs/skyline-design-guide.md).
`src/theme.css` owns the shared OLED palette, type family and motion durations.
Sign-in, profiles, dialogs and playback use monochrome focus states and respect the system Reduced Motion preference.
The launcher uses the existing Silo app artwork.
Samsung's supported Play/Pause, Play, Pause, Stop, Rewind and Fast Forward keys are registered independently; Enter remains available on every remote.
Player Up focuses the visible transport controls.
Left and Right preview a seek without changing playback; Enter commits the source position and Back cancels.
Dedicated Rewind and Fast Forward keys use the separate profile-saved video intervals, also used by transport buttons and Left/Right previews.
Supported servers inherit 10 seconds backward and 30 seconds forward; unsupported servers retain ten seconds in each direction.
The mounted Skyline bar groups visible libraries into Movies and Series tabs, with anchored library and profile menus.
Library scope is remembered per server, profile and content type.
Card focus drives a passive preview without fetching details; scrolling retargets immediately and respects Reduced Motion.
See [Skyline browse behavior](docs/skyline-browse-shell.md) for the implemented section boundary.

- `app/` holds the package manifest, HTML entry and icon.
- `src/api/`, `src/session/` and `src/contracts/v2/` own native transport, sessions, profile authority and contract decoders.
- `src/ui/` owns sign-in, profile/PIN and browse screens and remote focus.
- `src/player/` owns the server playback plan, AVPlay transport, progress, final stop and track changes.
- `scripts/build.mjs` stages `app/` into `dist/wgt/` and emits `js/main.js` and `js/main.css`.
  The bundle's app version comes from `app/config.xml`.

## Validation limits

The composed app is covered in desktop Chromium with fake Silo and AVPlay implementations, including the actual production bootstrap.
This is not TV playback or IME proof.
Earlier signed diagnostics on the S95C running Tizen 9 proved normal-HTTPS discovery/authenticated reads and direct playback with picture, dialogue, a 60-second resume, forward seek and progress.
The composed debug-signed app was then checked on the same S95C: device-code approval, real profile and catalog reads, account restoration after a full exit/relaunch, AVPlay start/pause/forward and backward seeking, an audio-track replan, return to the title, and sign-out with server revocation.
AVPlay state and server responses were observed; picture, dialogue and audible track differences were not independently confirmed during that composed-app run.
The TV keyboard, 2021 hardware, store builds, full remux/transcode acceptance and audible/visible track acceptance remain open.

The client declares no subtitle renderer.
The server can burn embedded subtitles into video when transcoding is allowed; external and downloaded subtitles receive an explicit unsupported result.
Backgrounding stops playback safely and requires selecting the title again.
Authenticated suspend/restore remains in [#13](https://github.com/Artic0din/silo-tizen/issues/13).

## Build and package

The 2021 TVs run Chromium 76 ([Samsung web engine specifications](https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html)).
TypeScript checks ES2019 and DOM code in strict mode; tests additionally load Node types.
esbuild emits a classic script targeting `chrome76`.
Neither step supplies missing browser APIs or CSS support.
Node.js 26 or later is required.

```bash
npm ci
npm run build
```

Packaging needs the Tizen Studio Web CLI and a Certificate Manager security profile.
Never commit certificates, profile XML or passwords.

```bash
export TIZEN_SECURITY_PROFILE="YourProfileName"
./scripts/build-wgt.sh
```

The script builds the package staging directory and writes `dist/Silo.wgt`.

## Test

`npm test` runs both strict type checks, the production build, native contract/session/player tests and Playwright screen/composition tests.
See [test/README.md](test/README.md) for the test boundaries.
