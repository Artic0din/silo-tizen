# Tests

`npm test` runs both strict type checks, the production build, `test/native/*.test.ts` and `test/ui/*.test.ts`.
Node.js 26 or later is required.
The package uses ES modules; Node runs TypeScript tests directly by stripping their types.

```bash
npm ci
npx playwright install chromium
npm test
```

## Native contracts, sessions and playback

`npm run test:native` uses the real core and controller with fake Silo, KeyManager and AVPlay ports.
The tests require no TV, account or network service.
They cover authentication, refresh/cleanup races, profile authority and PIN proofs, catalog decoding and profile restrictions, playback identities, progress/stop ordering, retries, offset timelines, seek/close sequencing and track changes.
AVPlay's fake enforces its documented states and retains uncancellable callbacks after teardown.
Lost track-change replies cannot leave an obsolete local plan playing; definitive refusals preserve the current transport.

## Screens and composed app

`npm run test:ui` bundles the real TypeScript screens for Chrome 76 and runs them in desktop Chromium.
Playwright routes native API requests to the same fake Silo and serves synthetic SVG artwork.
The fake server and browser clocks move together; polling and retry tests do not sleep.
Unexpected page logs and errors fail the screen tests.

`test/ui/app.test.ts` composes real sign-in, profiles, browse and playback over FakeCatalog, FakePlayback and FakeAVPlay.
It covers the approved device-code journey, returning from playback, PIN-proof revocation during playback, sign-out/relaunch, protected-account restore, exit modal focus/key isolation, unavailable AVPlay and startup failure recovery.
Its production case imports the actual `src/main.ts`, supplies the Tizen platform ports and exercises the same journey through that entry.
The focused sign-in, profile, browse and player suites retain their failure/loading/empty-state, navigation, paging and track-menu checks.

The retired Jellyfin adapter and its legacy browser/layout fixtures are no longer part of the app or test gate.
Native transport tests cover headers, timeouts, HTTPS and logout, while native browse and composed-app tests cover the current focus and return behavior.
Desktop Chromium and fake AVPlay do not prove real video/audio, TV keyboard behavior or Chromium 76 rendering.
The signed-TV app journey and the remaining hardware matrix must be checked separately.

## Captures and security

Set `PLAYER_CAPTURE_DIR` to a folder outside the repository to capture the player screen tests.
PR images and recordings belong outside Git and must use inspected synthetic data.
The Gitleaks configuration retains default rules and excludes only the exact synthetic subtitle-path hash at its pinned fixture path.

```bash
npm run typecheck
node --check scripts/build.mjs
xmllint --noout app/config.xml
git diff --check
```
