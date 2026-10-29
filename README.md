# silo-tizen

Silo client for Samsung Tizen TVs from model year 2021 (Tizen 6.0).

## Layout

- `app/` holds static package files: `config.xml`, `index.html`, CSS and the icon.
- `src/main.ts` is the bundle entry.
- `src/legacy/` holds the earlier plain-JavaScript screens and Jellyfin-compatible adapter.
  The entry bundles them unchanged so the app keeps working while typed modules replace them.
  tsc does not check them, and they are not the final architecture.
- `scripts/build.mjs` stages `app/` into `dist/wgt/` and bundles `src/main.ts` into `dist/wgt/js/main.js`.

## Build

The 2021 TVs run Chromium 76 ([Samsung web engine specifications](https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html)).
TypeScript checks with ES2019 and DOM libraries in strict mode.
esbuild emits one classic-script IIFE with target `chrome76`.
Neither step adds missing browser APIs or CSS support.

```bash
npm ci
npm run typecheck   # tsc only
npm run build       # typecheck, then stage dist/wgt
```

## Package

Packaging needs the Tizen Studio Web CLI on `PATH` and a Certificate Manager security profile.
Never commit certificates, profile XML or passwords.

```bash
export TIZEN_SECURITY_PROFILE="YourProfileName"
./scripts/build-wgt.sh
```

The script runs `npm run build`, packages `dist/wgt/` and writes `dist/Silo.wgt`.

## Test

See [test/README.md](test/README.md).
`npm test` builds, then runs the adapter tests and the browse focus tests.
