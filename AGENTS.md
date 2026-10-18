# Agent guide — silo-tizen

First-party Samsung Tizen TV client for [Silo Server](https://github.com/Silo-Server/silo-server). Licensed under **AGPL-3.0-or-later** (see `LICENSE`), aligned with [silo-apple](https://github.com/Silo-Server/silo-apple) and [silo-android](https://github.com/Silo-Server/silo-android).

## Ryan’s global rules

- **Pull requests:** Never open draft PRs. Every PR is **ready for review**.
- **Secrets:** Run `gitleaks protect --staged` before every commit. Before every push, scan the commit range (e.g. `gitleaks detect --log-opts=<range>`). Do not commit certificates, passwords, server URLs, or tokens.
- **Git workflow:** Work on a **feature branch** and merge via PR. **Never commit to `main`** except the one-time README seed on an empty repo (already done).
- **Commits & PRs:** Use [Conventional Commits](https://www.conventionalcommits.org/) for PR titles (e.g. `feat: add device-code sign-in`). Put `Fixes #N` **only in the PR body**, not commit messages.
- **Scope:** One logical change per PR. No unrequested features, refactors, or dependencies.
- **Proof:** Do not mark work done without evidence (build, tests, or explicit limitation with reason).
- **Retries:** Stop after **three** failed fix attempts; report blockers.
- **Design values:** MVP, YAGNI, KISS.
- **Merge authority:** Ryan merges.

## Domain rules (Tizen + Silo `/api/v2`)

### API client

- Talk to Silo’s native **`/api/v2` only**, through one small **API client module** (no Jellyfin compatibility layer in this app).
- Model behavior on the official clients:
  - [silo-apple — `APIv2Client.swift`, `AppleDeviceIdentity.swift`](https://github.com/Silo-Server/silo-apple/tree/main/Networking/APIv2)
  - [silo-android — `AuthInterceptorImpl.kt`, `PlaybackV2Api.kt`, `SequencedPlayback.kt`](https://github.com/Silo-Server/silo-android)
- Copying code from silo-apple and silo-android is **allowed** (same AGPL licence); keep ports minimal and idiomatic for plain JS on Tizen.
- Do **not** copy from jellyfin-web or jellyfin-tizen.

**Headers on every request** (omit empty values):

- `Authorization: Bearer <token>`
- `X-Silo-Device-Id`, `X-Silo-Device-Name`, `X-Silo-Device-Platform`
- `X-Silo-Client-Family: tv`
- `X-Silo-Client`, `X-Silo-Client-Version`, `X-Silo-Client-Build`, `X-Silo-Client-Channel`

### Auth

- **Primary:** device-code sign-in (`/api/v2/auth/device/*`). Show the code as **4+4**, plus `<host>/activate` and a **QR code**. Poll at the server’s interval, backing off to **30 s** max.
- **Fallback:** password login (`/api/v2/auth/login`).
- Store the bearer token **per server** (never in git).

### Discovery

- **None in MVP.** Manual server URL entry, validated with `GET /api/v2/system/identity`.

### Playback

- Use the v2 **sequenced** flow: capabilities → start → replan as needed; numbered **progress samples every 10 s**; **`DELETE` with `stop_id`** on stop.
- Play through **AVPlay** (not `<video>` / MSE for primary playback).
- Device **capability profile** lists what the TV can direct-play. No **DTS** direct play on Samsung TVs — expect transcode.
- For **HLS** stream URLs, pass auth via the **`token` query parameter** (AVPlay cannot set HTTP headers on playback URLs).
- On **visibilitychange**, call AVPlay suspend/restore with a **fresh URL** (grants are short-lived).

### Resume

- Use `positionSeconds`; **skip** resume when within **5 s** of the end.

### Artwork

- Use server **signed URLs** in plain `<img>` tags.

### TV focus (from silo-android TV work)

- Each screen **zone** has exactly **one focus owner**.
- Restore focus by **section id + item id**, not by list position.
- Take over D-pad navigation only at **zone edges**.
- Move focus programmatically only when the focused item **disappears**.
- **Never fetch data on focus moves.**

### UX and platform

- D-pad focus must **never get lost**. **Large, readable type.** At least one clear focus target per screen.
- **config.xml:** `<object type="application/avplayer">`, `$WEBAPIS/webapis/webapis.js`. Privileges: `internet`, `tv.inputdevice`, `productinfo` only unless proven necessary. AVPlay is not a privilege.

### Tooling and proof bar

- Package with `tizen package -t wgt`. Avoid `tizen build-web` on CLI 6.1 (known crash). Signing uses the developer’s **security profile**; never commit `.p12`, profile XML, or passwords.
- **Proof bar:** the `.wgt` builds; smoke-test in the Tizen TV **software** emulator when possible; **real TV** validation (TV Ship) is the final gate.

### Known blocker — `/api/v2` and browser-style HTTP

Silo’s native `/api/v2` sends **no CORS headers** by design ([`docs/architecture/api-contract.md` — “Browser origins”](https://github.com/Silo-Server/silo-server/blob/main/docs/architecture/api-contract.md)). Whether a **packaged** Tizen app with `<access origin="*">` can read `/api/v2` responses is **untested** and must be **proven on a real TV** before sign-in is considered done.

## Local commands

```bash
export TIZEN_SECURITY_PROFILE="YourProfileName"
./scripts/build-wgt.sh
```

Output: `dist/Silo.wgt` (from `<name>Silo</name>` in `app/config.xml`).
