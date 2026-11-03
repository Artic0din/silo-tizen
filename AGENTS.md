# Repository Guidelines

## Project Structure & Module Organization

This repository contains only the Silo Samsung TV client, a plain Tizen web app (`.wgt`); there is no other runtime. The package manifest, HTML entry, icon, fonts and third-party marks live in `app/`. TypeScript sources live in `src/`: native transport, sessions and contract decoders in `src/api/`, `src/session/` and `src/contracts/v2/`, screens and remote focus in `src/ui/`, and AVPlay playback in `src/player/`. Tests live in `test/native/` and `test/ui/`, build, packaging and release scripts in `scripts/`, and behaviour, design and validation notes in `docs/`.

## Silo Workspace Context

This repository is part of a broader multi-repo Silo workspace. The sibling
repositories are usually checked out alongside this repository.

- `silo-tizen` owns the Samsung TV (Tizen) client code only.
- `silo-server` owns the Go backend, web admin UI, API contracts, auth/session
  behavior, catalog/scanner/playback services, database migrations, and
  host-side plugin runtime. It is upstream: never change it from this
  repository, and do not file upstream issues from here.
- `silo-apple` owns the iOS, tvOS, and macOS clients. The Apple TV app is the
  reference for TV behavior and layout.
- `silo-android` owns the Android phone and TV clients. When changing shared
  client behavior, compare Android so the TV clients stay aligned.

When a task touches auth, API models, playback/session state, library browsing,
metadata display, or server-driven behavior, check whether the server and the
other clients need coordinated changes. Do not force server concerns into this
repo.

Copying code from silo-apple and silo-android is allowed (same AGPL licence);
keep ports minimal and idiomatic for TypeScript on Tizen. Model behavior on the
official clients where it fits:
[silo-apple `Networking/APIv2`](https://github.com/Silo-Server/silo-apple/tree/main/iosApp/iosApp/Networking/APIv2) and
[silo-android `AuthInterceptorImpl.kt`, `PlaybackV2Api.kt`, `SequencedPlayback.kt`](https://github.com/Silo-Server/silo-android).
Do not copy from jellyfin-web or jellyfin-tizen.

## Build, Test, and Development Commands

- `npm ci` installs the build and test tools (Node.js 26 or later); `npx playwright install chromium` adds the browser the screen tests need.
- `npm run build` type-checks and stages `app/` into `dist/wgt/`.
- `npm test` runs both type checks, the build, native tests and Playwright screen tests.
- `python3 scripts/test-release-version.py` tests the release version script.
- `export TIZEN_SECURITY_PROFILE="YourProfileName"` then `./scripts/build-wgt.sh` packages and signs `dist/Silo.wgt` with `tizen package -t wgt`. Avoid `tizen build-web` on CLI 6.1 (known crash).
- `tizen install -n dist/Silo.wgt -t <device>` and `tizen run -p Sil0Tv0001.Silo -t <device>` install and launch on a TV in Developer Mode.

The proof bar: the `.wgt` builds; smoke-test in the Tizen TV software emulator
or Samsung TV simulator when possible; real TV validation is the final gate.
The simulator ships with `--disable-web-security`, so a successful simulator
request does not establish ordinary-browser CORS or physical-TV acceptance. See
[simulator evidence](docs/evidence/simulator-evidence.md) for launch, capture and proof
boundaries.

## Platform Rules

### Backend: native `/api/v2`

[Native API v2](docs/native-api-v2.md) lists every operation the app calls, with its auth, gating and error handling.

- The packaged app uses only Silo's native `/api/v2`, through `src/api/`, `src/contracts/v2/` and the session owners.
- Keep server operations and response decoding in the existing API and contract modules. UI and player controllers use the existing session transport and active profile authority rather than assembling separate authorization paths.
- Server CORS behavior and platform origin restrictions must be checked on the runtime being claimed.
- `DeviceId` is generated once per install and stored locally; never derive it from a server URL or account.
- Use the existing credential vault and explicit session-only fallback; never put credentials in public storage or git.

### Auth and discovery

- Sign-in uses native device-code approval, followed by household profile selection and PIN verification when required. Add another sign-in method only against the native server contract.
- Manual HTTPS server entry uses the native discovery and capability flow. Do not treat the web simulator as evidence that LAN discovery or pinned local certificates work on a TV.

### Playback

- Play through AVPlay, not `<video>` or MSE, for primary playback. Direct play first; HLS (MPEG-TS segments) transcode as the fallback. No ABR logic.
- Report playback start, progress every 10 s, and stop through the adapter.
- The device capability profile lists what the TV can direct-play. No DTS direct play on Samsung TVs; expect transcode.
- AVPlay cannot set HTTP headers on playback URLs; pass auth as a query parameter on stream URLs.
- On `visibilitychange`, call AVPlay suspend/restore and rebuild the stream URL on restore.
- Resume from the stored position (seconds); skip resume within 5 s of the end.

### Platform and package

- Minimum OS is Tizen 8.0 (Chromium 108). Target the Samsung S95C with supported installed firmware; validate its current OS and AVPlay capabilities rather than assuming them from the model year.
- `app/config.xml` declares `<object type="application/avplayer">` and loads `$WEBAPIS/webapis/webapis.js`. Privileges are `internet`, `tv.inputdevice` and `productinfo` only unless proven necessary; AVPlay is not a privilege.
- Artwork uses plain `<img>` tags pointing at the server's image endpoints.
- Signing uses the developer's security profile; never commit `.p12`, profile XML, passwords or DUIDs.

### TV focus

Read [TV focus](docs/tv-focus.md) before changing navigation, menus, grids, dialogs or custom controls.

- Each screen zone has exactly one focus owner. D-pad focus must never get lost, and every screen has at least one clear focus target.
- Restore focus by section id + item id, not by list position.
- Handle D-pad moves within and between zones in app code. Samsung remotes deliver arrow keys, Enter and Back as plain `keydown` events ([Remote Control](https://developer.samsung.com/smarttv/develop/guides/user-interaction/remote-control.html)) and have no Tab key ([Text-to-Speech / focus](https://developer.samsung.com/smarttv/develop/guides/fundamentals/text-to-speech.html)); relying on the browser's spatial navigation can move focus twice in grids.
- Move focus programmatically only when the focused item disappears.
- Never fetch data on focus moves.

## Coding Style & Naming Conventions

Use strict TypeScript with no `any`, ES module imports with explicit `.ts`
extensions, and the existing module boundaries above. Types use `PascalCase`;
functions and properties use `camelCase`. Keep large, readable type and the
Skyline design tokens in `src/theme.css`. Keep the design values MVP, YAGNI and
KISS: no unrequested features, refactors or dependencies.

## Testing Guidelines

Native tests use `node:test` under `test/native/`; screen and composition tests
use Playwright under `test/ui/`. Add focused regression tests when they
meaningfully protect changed behavior; use rendered checks for visual changes.
Desktop Chromium is not the TV's Chromium 108: it proves behavior, not TV
rendering or AVPlay playback. See [test/README.md](test/README.md).

## Writing

Run a final readability pass on every human-facing issue, pull request,
document, or status update.

- Lead with the outcome.
- Use concrete, plain language and active voice.
- Cut filler, stock framing, repetition, and promotional claims.
- Preserve meaning, evidence, citations, uncertainty, and established
  terminology.
- Never rewrite exact quotations, commands, logs, identifiers, API names, or
  contractual language.
- Match the tone to the audience and use only formatting that improves
  readability.

## Pull requests

Work on a feature branch and merge through a pull request; never commit to
`main`. Never open draft pull requests.

Use a Conventional Commit title in plain language. Start the body with the
problem, explain the solution next, and end with the required AI disclosure,
including the exact model identifier, agent harness, and any other AI tooling.
Put `Fixes #N` or `Closes #N` only in the pull request body, not in commit
messages. Include validation evidence, risks, and follow-up work.

- Keep one concern per pull request. Split changes that solve independent
  problems or can be reviewed and shipped separately.
- Every pull request that changes what a user sees must include evidence, as
  [Show visible changes](CONTRIBUTING.md#show-visible-changes) defines. Use
  before-and-after captures of the same screen with the same data on a Samsung
  TV running the signed `.wgt`, plus the same-state Apple TV screenshot, and a
  short recording when motion, timing, or focus matters. Write
  `Evidence: none, no user-visible change` only when that is true.
- Attach evidence on GitHub under the PR body's Evidence heading. Check media
  for private information, including DUIDs, before it goes on GitHub. Never
  commit PR-only assets such as `.github/pr-assets/`.
- When babysitting a pull request, poll checks and review comments created
  after the last push. Verify bot findings against the source, fix real issues,
  and dismiss false positives with a written reason. Remain quiet when nothing
  new has appeared. Stop when the latest commit is green.

## Security & Configuration Tips

Run `gitleaks git --staged --redact` before every commit and scan the outgoing
range before every push. Do not commit certificates, security profiles,
passwords, server URLs, tokens or DUIDs. CI signs with repository secrets
(`TIZEN_AUTHOR_P12_B64`, `TIZEN_AUTHOR_PASSWORD`, `TIZEN_DISTRIBUTOR_P12_B64`,
`TIZEN_DISTRIBUTOR_PASSWORD`); see [Releasing](docs/releasing.md).
