# silo-tizen

Silo client for Samsung Tizen TVs from model year 2021 (Tizen 6.0).

## Layout

- `app/` holds static package files: `config.xml`, `index.html`, CSS and the icon.
- `src/main.ts` is the bundle entry.
- `src/legacy/` holds the earlier plain-JavaScript screens and Jellyfin-compatible adapter.
  The entry bundles them unchanged so the app keeps working while typed modules replace them.
  tsc does not check them, and they are not the final architecture.
- `src/api/`, `src/session/` and `src/contracts/v2/` hold the native `/api/v2` session core: device login, profiles and credential storage.
  No screen uses it yet, so the packaged app still runs the legacy screens only.
- Native rollout is blocked by [the signed-TV transport gates in #6](https://github.com/Artic0din/silo-tizen/issues/6).
  Keep the entry point on the legacy client until a foreground signed app reads native discovery and authenticated responses over normally validated HTTPS.
  The server currently provides no native JSON CORS policy; Node fakes and successful wire requests do not prove that the TV's JavaScript can read those responses.
- `scripts/build.mjs` stages `app/` into `dist/wgt/` and bundles `src/main.ts` into `dist/wgt/js/main.js`.

## Build

The 2021 TVs run Chromium 76 ([Samsung web engine specifications](https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html)).
TypeScript checks with ES2019 and DOM libraries in strict mode.
`tsconfig.json` checks `src/` without Node types; `tsconfig.test.json` adds Node types and checks `src/` with `test/native/`.
esbuild emits one classic-script IIFE with target `chrome76`.
Neither step adds missing browser APIs or CSS support.

```bash
npm ci
npm run typecheck   # tsc for src/, then for src/ with test/native/
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
`npm test` builds, then runs the native session tests, the adapter tests and the browse focus and layout tests.
The native tests run the TypeScript sources directly with Node.js; CI and the type definitions use Node.js 26, the supported version.
