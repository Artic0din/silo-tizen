# Tests

## Backend adapter (Node only)

```bash
node test/run-backend-tests.js
```

Uses a local mock HTTP server; no npm install required.

## Headless UI screenshots (Playwright)

```bash
npm ci
npx playwright install chromium
node test/run-ui-screenshots.js
```

Screenshots are written to `SCREENSHOT_DIR`, or `os.tmpdir()/silo-screenshots` when unset.

## Browse focus navigation (Playwright)

```bash
npm ci
npx playwright install chromium
node test/run-focus-tests.js
```

## Quick Connect UI tests (Playwright)

```bash
npm ci
npx playwright install chromium
node test/run-ui-tests.js
```

## Static checks

```bash
node --check app/js/backend.js
node --check app/js/app.js
node --check test/run-backend-tests.js
node --check test/mock-jellyfin-server.js
node --check test/run-ui-screenshots.js
node --check test/run-focus-tests.js
node --check test/run-ui-tests.js
xmllint --noout app/config.xml
```
