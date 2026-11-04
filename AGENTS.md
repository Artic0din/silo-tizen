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
Before porting a feature, read its upstream design spec; [Upstream design notes](docs/upstream-design-notes.md) links the ones that apply to a TV client.

## Parity delivery gates

### Establish the reference before editing

- Read the affected Apple TV Swift implementation before every UI or behaviour
  change, including integration fixes.
  Record the source revision and distinguish it from the installed Apple build;
  never infer that they match.
- Compare the complete affected experience: layout, typography, colour,
  spacing, copy, focus, motion, remote navigation and relevant loading,
  failure, Retry, offline, empty and artwork-fallback states.
- Inspect existing Tizen components and affected callers before adding code.
  Reuse the existing shell, artwork, cards, focus, scrolling, dialogs, paging
  and session owners where their behaviour fits.
  Fix shared causes at their existing owner; do not rebuild these per screen.

### Prove parity before committing

- Do not commit a user-facing parity change until same-state Apple/Samsung
  comparison demonstrates the affected experience matches.
  Passing tests, source approval and publication approval are separate checks;
  none substitutes for native comparison.
- Use the same content, status, selection, focus, scroll and viewport.
  Record actual capture dimensions; never upscale an image and call it native.
  Use remote interaction and a recording when focus, motion or timing matters.
- Identify the source candidate and signed WGT.
  Verify changed installed assets and loaded code match that package before
  capturing; repeat affected proof after subsequent changes.
- Fix implementation differences.
  For a demonstrated platform constraint, use the closest practical substitute,
  document the reason and show the comparison.
  A waiver applies only to the explicitly accepted gap.
- Preserve meaningful regression assertions during test migrations.
  Do not delete focus, cancellation, authority, paging or request-count checks
  to obtain green results.
  Diagnose failures; a later pass alone does not establish a flake or a fix.

### Runtime ownership and parallel work

- Use the Pro for native comparisons and Xcode Device Hub for Apple TV.
  One Apple simulator and one Samsung simulator may run concurrently.
  Never launch duplicate instances; assign one input owner per simulator.
- A locked desktop or missing generic device listing does not establish that
  SDK debugging is unavailable.
  Test the authorized debugging interface before declaring a blocker.
- Spread independent implementation, research and review across isolated
  agents and available machines.
  Serialize shared-file integration and simulator input, not all useful work.
  Verify transferred patch bytes and hashes before applying them.
- Keep physical-TV work deferred until simulator parity is complete.
  Simulator success does not establish TV CORS, AVPlay or hardware acceptance.
- Under full-send, continue the agreed backlog after each PR.
  Keep verified progress and remaining gaps in GitHub issues.
  An individual merge, green CI or partial review does not complete parity.

## Build, Test, and Development Commands

- `npm ci` installs the build and test tools (Node.js 26 or later); `npx playwright install chromium` adds the browser the screen tests need.
- `npm run build` type-checks and stages `app/` into `dist/wgt/`.
- `npm test` runs both type checks, the build, native tests and Playwright screen tests.
- `python3 scripts/test-release-version.py` tests the release version script.
- `SILO_SERVER_REPO=/path/to/silo-server scripts/sync-apiv2-fixtures.sh <server-commit>` re-vendors the API v2 contract fixtures; never hand-edit `src/contracts/v2/fixtures/`.
- `export TIZEN_SECURITY_PROFILE="YourProfileName"` then `./scripts/build-wgt.sh` packages and signs `dist/Silo.wgt` with `tizen package -t wgt`.
- `tizen install -n dist/Silo.wgt -t <device>` and `tizen run -p Sil0Tv0001.Silo -t <device>` install and launch on a TV in Developer Mode.

The proof bar: the signed `.wgt` builds and the affected simulator journeys
pass the parity gates above; real TV validation remains the final hardware gate.
The simulator ships with `--disable-web-security`, so a successful simulator
request does not establish ordinary-browser CORS or physical-TV acceptance. See
[simulator evidence](docs/evidence/simulator-evidence.md) for launch, capture and proof
boundaries.

## Platform Rules

### Backend: native `/api/v2`

[Native API v2](docs/native-api-v2.md) lists every operation the app calls, with its auth, gating and error handling.

- The packaged app uses only Silo's native `/api/v2`, through `src/api/`, `src/contracts/v2/` and the session owners. `scripts/ci/check-no-api-v1.sh` fails CI on any `/api/v1` path in `app/`, `src/` or `test/`.
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
  new has appeared.
  Green CI completes only the CI check; satisfy review and evidence gates,
  then continue the parent task when its agreed scope remains unfinished.

## Security & Configuration Tips

Run `gitleaks git --staged --redact` before every commit and scan the outgoing
range before every push. Do not commit certificates, security profiles,
passwords, server URLs, tokens or DUIDs. CI signs with repository secrets
(`TIZEN_AUTHOR_P12_B64`, `TIZEN_AUTHOR_PASSWORD`, `TIZEN_DISTRIBUTOR_P12_B64`,
`TIZEN_DISTRIBUTOR_PASSWORD`); see [Releasing](docs/releasing.md).
