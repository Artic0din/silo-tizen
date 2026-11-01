# Agent guide — silo-tizen

First-party Samsung Tizen TV client for [Silo Server](https://github.com/Silo-Server/silo-server). App name **Silo**. Licensed under **AGPL-3.0-or-later** (see `LICENSE`), aligned with [silo-apple](https://github.com/Silo-Server/silo-apple) and [silo-android](https://github.com/Silo-Server/silo-android).

## Ryan’s global rules

- **Pull requests:** Never open draft PRs. Every PR is **ready for review**.
- **Secrets:** Run `gitleaks protect --staged` before every commit. Before every push, scan the commit range (e.g. `gitleaks detect --log-opts=<range>`). Do not commit certificates, passwords, server URLs, or tokens.
- **Git workflow:** Work on a **feature branch** and merge via PR. **Never commit to `main`** except the one-time README seed on an empty repo (already done).
- **Commits & PRs:** Use [Conventional Commits](https://www.conventionalcommits.org/) for PR titles (e.g. `feat: add sign-in`). Put `Fixes #N` **only in the PR body**, not commit messages.
- **Scope:** One logical change per PR. No unrequested features, refactors, or dependencies.
- **Proof:** Do not mark work done without evidence (build, tests, or explicit limitation with reason).
- **Retries:** Stop after **three** failed fix attempts; report blockers.
- **Design values:** MVP, YAGNI, KISS.
- **Merge authority:** Ryan merges.
- **Upstream:** `silo-server` is upstream and not ours. **Never change silo-server from this repo** and do not file upstream issues.

## Domain rules (Tizen + Silo)

### Backend: native `/api/v2`

- The packaged app uses Silo’s native **`/api/v2`** through `src/api/`, `src/contracts/v2/` and the session owners.
- The earlier Jellyfin-compatible client is retired; do not reintroduce its endpoints or authorization header.
- Server CORS behavior and platform origin restrictions must be checked on the runtime being claimed.
  The Samsung NW.js web simulator ships with `--disable-web-security`, so a successful simulator request does **not** establish ordinary-browser CORS or physical-TV acceptance.
  See [simulator evidence](docs/simulator-evidence.md) for launch, capture and proof boundaries.

### Backend operations

- Keep server operations and response decoding in the existing API and contract modules.
  UI and player controllers use the existing session transport and active profile authority rather than assembling separate authorization paths.
- Model behavior on the official clients where it fits:
  - [silo-apple — `Networking/APIv2`](https://github.com/Silo-Server/silo-apple/tree/main/Networking/APIv2)
  - [silo-android — `AuthInterceptorImpl.kt`, `PlaybackV2Api.kt`, `SequencedPlayback.kt`](https://github.com/Silo-Server/silo-android)
- Copying code from silo-apple and silo-android is **allowed** (same AGPL licence); keep ports minimal and idiomatic for plain JS on Tizen.
- Do **not** copy from jellyfin-web or jellyfin-tizen.

- `DeviceId` is generated once per install and stored locally; never derived from a server URL or account.
- Use the existing credential vault and explicit session-only fallback; never put credentials in public storage or git.

### Auth

- The current sign-in flow uses native device-code approval, followed by household profile selection and PIN verification when required.
- Add another sign-in method only against the native server contract; do not use Jellyfin Quick Connect or password endpoints.

### Discovery

- Manual HTTPS server entry uses the native discovery and capability flow.
- Do not treat the web simulator as evidence that LAN discovery or pinned local certificates work on a TV.

### Playback

- Play through **AVPlay** (not `<video>` / MSE for primary playback).
- **Direct play first**; **HLS (MPEG-TS segments)** transcode as the fallback. No ABR logic in MVP.
- Report playback start, **progress every 10 s**, and stop through the adapter.
- Device **capability profile** lists what the TV can direct-play. No **DTS** direct play on Samsung TVs — expect transcode.
- **Target TV:** Samsung S95C (2023, Tizen 7.0). Build the direct-play profile and AVPlay capability checks for it.
- AVPlay cannot set HTTP headers on playback URLs; pass auth as a **query parameter** on stream URLs.
- On **visibilitychange**, call AVPlay suspend/restore; rebuild the stream URL on restore.

### Resume

- Resume from the stored position (seconds); **skip** resume when within **5 s** of the end.

### Artwork

- Plain `<img>` tags pointing at the server’s image endpoints.

### TV focus (from silo-android TV work)

- Each screen **zone** has exactly **one focus owner**.
- Restore focus by **section id + item id**, not by list position.
- Handle D-pad navigation in app code for moves **within** each zone and **between** zones; focus must never be lost. Samsung TV remotes deliver arrow keys, Enter, and Back as plain `keydown` events ([Remote Control](https://developer.samsung.com/smarttv/develop/guides/user-interaction/remote-control.html), checked 21 Oct 2026), and there is no Tab key on the remote, so the app must move focus itself ([Text-to-Speech / focus](https://developer.samsung.com/smarttv/develop/guides/fundamentals/text-to-speech.html), checked 21 Oct 2026); relying on the browser’s built-in spatial navigation can move focus twice in grids.
- Move focus programmatically only when the focused item **disappears**.
- **Never fetch data on focus moves.**

### UX and platform

- Plain Tizen **web app (`.wgt`)**. No other runtime.
- D-pad focus must **never get lost**. **Large, readable type.** At least one clear focus target per screen.
- **config.xml:** `<object type="application/avplayer">`, `$WEBAPIS/webapis/webapis.js`. Privileges: `internet`, `tv.inputdevice`, `productinfo` only unless proven necessary. AVPlay is not a privilege.

### Tooling and proof bar

- Package with `tizen package -t wgt`. Avoid `tizen build-web` on CLI 6.1 (known crash). Signing uses the developer’s **security profile**; never commit `.p12`, profile XML, or passwords.
- **Proof bar:** the `.wgt` builds; smoke-test in the Tizen TV **software** emulator when possible; **real TV** validation (TV Ship) is the final gate.

## Local commands

```bash
export TIZEN_SECURITY_PROFILE="YourProfileName"
./scripts/build-wgt.sh
```

Output: `dist/Silo.wgt` (from `<name>Silo</name>` in `app/config.xml`).
