# Tests

`npm test` runs the build, the native session tests, the adapter tests and the browse focus and layout tests.
It needs Node.js 26 or later, the version CI tests.
The Playwright tests serve the staged package in `dist/wgt/`, so run `npm run build` before running them directly.
Desktop Chromium is not Chromium 76; these runs do not prove 2021 TV rendering.

## Native session core (Node only)

```bash
npm run test:native
```

Node runs `test/native/*.test.ts` directly by stripping types; there is no compile step.
The tests use a fake Silo server and a fake KeyManager, so they need no network, TV or account.
The script hides Node's `MODULE_TYPELESS_PACKAGE_JSON` warning: the package stays CommonJS for the legacy runners, so Node detects the test files as ES modules.
`npm run typecheck` checks these tests with `tsconfig.test.json`.

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
