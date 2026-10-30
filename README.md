# silo-tizen

Silo client for Samsung Tizen TVs from model year 2021 (Tizen 6.0).

## Layout

- `app/` holds static package files: `config.xml`, `index.html`, CSS and the icon.
- `src/main.ts` is the bundle entry.
- `src/legacy/` holds the earlier plain-JavaScript screens and Jellyfin-compatible adapter.
  The entry bundles them unchanged so the app keeps working while typed modules replace them.
  tsc does not check them, and they are not the final architecture.
- `src/api/`, `src/session/` and `src/contracts/v2/` hold the native `/api/v2` session core: device login, profiles and credential storage.
- `src/ui/` holds the native sign-in screens built on that core: server address entry, then the eight-digit code with a QR code.
  `mountSignIn` takes a root element and the core's dependencies and calls `onSignedIn` with the connected server.
  `mountProfiles` takes that server, shows the household profiles and PIN entry, and calls `onSelected` with the chosen profile and the signal that ends when it stops acting; app composition comes in later work.
  Their stylesheet is `src/ui/signIn.css`, written for Chromium 76.
  The entry point does not use them yet, so the packaged app still runs the legacy screens only.
- `src/ui/browse.ts` holds the native Movies and Series browsing for the selected profile ([#9](https://github.com/Artic0din/silo-tizen/issues/9)): Home, libraries, search and item pages.
  `mountBrowse(root, { server, onPlay, onChooseProfile })` draws inside its own container in `root`, removes only that container when the account or profile changes, and calls `onPlay` with the content id, file id and resume point.
  Its stylesheet is `src/ui/browse.css`, written for Chromium 76.
  The entry point does not use it yet, and no native player exists yet.
- A signed foreground app on a 2023 TV running Tizen 9 has read native discovery and authenticated responses over normally validated HTTPS ([#6](https://github.com/Artic0din/silo-tizen/issues/6)).
  2021 hardware, store signing, PIN profiles and media delivery are still unproven there.
  Keep the entry point on the legacy client until the native journey from sign-in through profiles and browsing is complete.
- `scripts/build.mjs` stages `app/` into `dist/wgt/` and bundles `src/main.ts` into `dist/wgt/js/main.js`.

## Build

The 2021 TVs run Chromium 76 ([Samsung web engine specifications](https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html)).
TypeScript checks with ES2019 and DOM libraries in strict mode.
`tsconfig.json` checks `src/` without Node types; `tsconfig.test.json` adds Node types and checks `src/`, `test/native/` and `test/ui/`.
esbuild emits one classic-script IIFE with target `chrome76`.
Neither step adds missing browser APIs or CSS support.

```bash
npm ci
npm run typecheck   # tsc for src/, then for src/ with test/native/ and test/ui/
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
`npm test` builds, then runs the native session and catalog tests, the sign-in, profile and browse screen tests, the adapter tests and the browse focus tests.
The native tests run the TypeScript sources directly with Node.js; CI and the type definitions use Node.js 26, the supported version.
