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

## Static checks

```bash
node --check app/js/backend.js
node --check app/js/app.js
node --check test/run-backend-tests.js
node --check test/mock-jellyfin-server.js
node --check test/run-ui-screenshots.js
xmllint --noout app/config.xml
```
