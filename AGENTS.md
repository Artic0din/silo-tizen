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

### Backend: Jellyfin layer first, `/api/v2` later

- **Now:** talk to Silo’s **Jellyfin-compatible layer** (default port **8096**). It sends `Access-Control-Allow-Origin: *`, so a packaged Tizen web app can read its responses.
- **Later:** move to Silo’s native **`/api/v2`** once upstream Silo allows browser origins.
- **Why v2 is deferred:** `/api/v2` currently sends no CORS headers and answers `OPTIONS` preflights with `405` ([`api-contract.md` — “Browser origins”](https://github.com/Silo-Server/silo-server/blob/main/docs/architecture/api-contract.md)), so a web app cannot use it yet.

### Backend adapter (keep it v2-shaped)

- All server calls go through **one thin adapter module** whose interface is shaped like Silo v2, so the backend can be swapped without touching UI code:
  - `signIn` (password now; device-code once on v2), `signOut`
  - `browse` (home sections, library items, item details)
  - `playbackStart`, `playbackProgress`, `playbackStop`
  - `resumePosition` (seconds)
- The current implementation maps these onto Jellyfin endpoints. UI and player code must **never** call Jellyfin URLs directly.
- Model behavior on the official clients where it fits:
  - [silo-apple — `Networking/APIv2`](https://github.com/Silo-Server/silo-apple/tree/main/Networking/APIv2)
  - [silo-android — `AuthInterceptorImpl.kt`, `PlaybackV2Api.kt`, `SequencedPlayback.kt`](https://github.com/Silo-Server/silo-android)
- Copying code from silo-apple and silo-android is **allowed** (same AGPL licence); keep ports minimal and idiomatic for plain JS on Tizen.
- Do **not** copy from jellyfin-web or jellyfin-tizen.

**Auth header on every Jellyfin-layer request** (omit `Token` before sign-in):

```
Authorization: MediaBrowser Client="Silo", Device="<device name>", DeviceId="<stable device id>", Version="<app version>", Token="<access token>"
```

- `DeviceId` is generated once per install and stored locally; never derived from a server URL or account.
- Store the access token **per server** on the device (never in git).

### Auth

- **Primary:** username + password (`POST /Users/AuthenticateByName`).
- **Quick Connect:** add only once it is confirmed that Silo's Jellyfin layer supports it.

### Discovery

- **None in MVP.** Manual server URL entry, validated with `GET /System/Info/Public`.

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
