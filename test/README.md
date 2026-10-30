# Tests

`npm test` runs the build, the native session and playback tests, the sign-in, profile and player screen tests, the adapter tests and the browse focus tests.
It needs Node.js 26 or later, the version CI tests.
The browse Playwright tests serve the staged package in `dist/wgt/`, so run `npm run build` before running them directly.
Desktop Chromium is not Chromium 76; these runs do not prove 2021 TV rendering.

## Native core and player (Node only)

```bash
npm run test:native
```

Node runs `test/native/*.test.ts` directly by stripping types; there is no compile step.
The tests use a fake Silo server and a fake KeyManager, so they need no network, TV or account.
The script hides Node's `MODULE_TYPELESS_PACKAGE_JSON` warning: the package stays CommonJS for the legacy runners, so Node detects the test files as ES modules.
`npm run typecheck` checks these tests with `tsconfig.test.json`.

## Native sign-in and profile screens (Playwright)

```bash
npm ci
npx playwright install chromium
npm run test:ui
```

`test/ui/harness.ts` mounts the real sign-in screens and session core in a test page, bundled with the TV build's esbuild settings.
With `?flow=profiles` it continues into the real profile screens and a stand-in for the browse screens.
Playwright routes the page's `/api/v2` requests to the fake Silo the native tests use and serves the page from the fake server's origin, so no CORS is involved.
The page stores credentials in the native tests' fake KeyManager.
Other hosts fail as unreachable.
Playwright's fake clock and the fake server's clock move together, so polling, expiry and retry waits need no real waiting.
The tests press remote keys and check what the screen shows and where focus is.

## Native player

`test/native/playback.test.ts` runs the playback controller against the fake Silo's playback operations (`support/fakePlayback.ts`) and a fake AVPlay (`support/fakeAVPlay.ts`) that enforces the documented call states and retains uncancellable callbacks.
The fake rejects AVPlay calls during a pending seek; teardown and replacement wait for its callback before closing or opening a transport.
Tests also cover pause preservation after a server re-anchor, Retry-After delays, authority changes before dispatch and HTTPS-only media URLs.
Codec failures received during a seek are handled after its callback, unless the attempt has ended.
Backgrounding ends the attempt, stops progress and shows a restart notice; authenticated suspend/restore is deferred to issue #13.
`test/ui/player.test.ts` drives the player screen in Chromium over stub controls.
Set `PLAYER_CAPTURE_DIR` to a folder outside the repository to save its screenshots.
Neither proves AVPlay media authentication or playback on a TV.

The Gitleaks configuration keeps the default rules and excludes only the exact synthetic subtitle-path hash in the pinned public playback fixture.
The same value in another file, or another value in that fixture, remains subject to scanning.

## Backend adapter (Node only)

```bash
node test/run-backend-tests.js
```

Uses a local mock HTTP server and loads `src/legacy/backend.js` directly; no npm install required.

## Headless UI screenshots (Playwright)

```bash
npm ci
npx playwright install chromium
npm run build
node test/run-ui-screenshots.js
```

Screenshots are written to `SCREENSHOT_DIR`, or `os.tmpdir()/silo-screenshots` when unset.

## Browse focus navigation (Playwright)

```bash
npm ci
npx playwright install chromium
npm run build
node test/run-focus-tests.js
```

## Static checks

```bash
npm run typecheck
node --check src/legacy/backend.js
node --check src/legacy/app.js
node --check scripts/build.mjs
node --check test/run-backend-tests.js
node --check test/mock-jellyfin-server.js
node --check test/run-ui-screenshots.js
node --check test/run-focus-tests.js
xmllint --noout app/config.xml
```
