# Tests

`npm test` runs the build, the native session tests, the sign-in and profile screen tests, the adapter tests and the browse focus tests.
It needs Node.js 26 or later, the version CI tests.
The browse Playwright tests serve the staged package in `dist/wgt/`, so run `npm run build` before running them directly.
Desktop Chromium is not Chromium 76; these runs do not prove 2021 TV rendering.

## Native session core (Node only)

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
