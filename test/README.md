# Tests

`npm test` runs the build, the native session, browse contract, playback and track tests, the native sign-in, profile, browse and player screen tests, the adapter tests and the legacy browse focus and layout tests.
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

`test/ui/browse.test.ts` does the same for the native browse screens with `test/ui/browseHarness.ts`.
The harness signs in through the real device-code flow and selects a profile through the real `Profiles`.
`test/native/support/fakeCatalog.ts` adds a household to the fake Silo: an owner and a PIN-locked child profile whose library access the fake applies server-side, synthetic titles, cursor paging and search.
The fake serves synthetic SVG artwork from `/art/`; other image hosts fail, which exercises the placeholders.

## Native player

`test/native/playback.test.ts` runs the playback controller against the fake Silo's playback operations (`support/fakePlayback.ts`) and a fake AVPlay (`support/fakeAVPlay.ts`) that enforces the documented call states and retains uncancellable callbacks.
The fake rejects AVPlay calls during a pending seek; teardown and replacement wait for its callback before closing or opening a transport.
Tests also cover pause preservation after a server re-anchor, Retry-After delays, authority changes before dispatch and HTTPS-only media URLs.
`test/native/tracks.test.ts` covers audio and subtitle choices: every choice is a `track_change` replan with the server's identity, at the current source position and pause state; a refused change keeps the current plan playing; one change at a time; late answers after Back or a profile change are dropped.
The fake server applies the pinned server's track rules: canonical identities on the effective file, burn-in for embedded subtitles, refusal for external and downloaded ones, and the default audio track with a warning for a track the file lacks.
`test/ui/player.test.ts` drives the player screen in Chromium over stub controls, including the audio and subtitles menu's remote keys and focus.
Codec failures received during a seek are handled after its callback, unless the attempt has ended.
Backgrounding ends the attempt, stops progress and shows a restart notice; authenticated suspend/restore is deferred to issue #13.
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

## Browse focus and layout (Playwright)

```bash
npm ci
npx playwright install chromium
npm run build
node test/run-focus-tests.js
```

The run serves `app.css` without the CSS that Chromium 76 drops or ignores: `aspect-ratio`, `inset`, and `gap` in flex containers.
It also makes `inset` and `aspectRatio` assignments through `element.style` do nothing, and removes inline flex `gap` from the exit dialog after it opens.
It then checks form and tile spacing and 2:3 posters on the sign-in, home, details and library screens, and that the exit dialog covers the screen with its buttons 32px apart.
This simulates only those three features in desktop Chromium; it is not a Chromium 76 run and does not check other CSS or JavaScript support.

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
