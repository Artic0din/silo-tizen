# Agent guide — silo-tizen

This repository is a Samsung Tizen TV client for [Silo Server](https://github.com/Silo-Server/silo-server). The app is **not** branded “Silo”; it is a separate TV client that speaks Silo’s Jellyfin-compatible API.

## Ryan’s global rules

- **Pull requests:** Never open draft PRs. Every PR is **ready for review**.
- **Secrets:** Run `gitleaks protect --staged` before every commit. Before every push, scan the commit range (e.g. `gitleaks detect --log-opts=<range>`). Do not commit certificates, passwords, server URLs, or tokens.
- **Git workflow:** Work on a **feature branch** and merge via PR. **Never commit to `main`** except the one-time README seed on an empty repo (already done).
- **Commits & PRs:** Use [Conventional Commits](https://www.conventionalcommits.org/) for PR titles (e.g. `feat: add AVPlay direct play`). Put `Fixes #N` **only in the PR body**, not commit messages.
- **Scope:** One logical change per PR. No unrequested features, refactors, or dependencies.
- **Proof:** Do not mark work done without evidence (build, tests, or explicit limitation with reason).
- **Retries:** Stop after **three** failed fix attempts; report blockers.
- **Design values:** MVP, YAGNI, KISS.
- **Merge authority:** Ryan merges.

## Domain rules (Tizen + Silo)

- **API layer:** Talk to Silo’s Jellyfin-compatible surface on port **8096** through a small **API adapter module**. Keep server URLs and auth out of committed code. A later move to Silo native `/api/v2` should be mostly an adapter swap.
- **Playback:** Prefer **AVPlay** over `<video>` (MSE limits on TV). Lifecycle: open → listener/display/buffering (IDLE) → prepareAsync → play; on **visibilitychange**, call suspend/restore with a **fresh stream URL** (Silo grants are short-lived).
- **Direct play first;** **HLS transcode** as fallback. Device profiles must advertise **MPEG-TS** for HLS transcodes — Silo returns **400** for fMP4-only profiles. No adaptive bitrate in the MVP.
- **Codecs:** No **DTS** direct play on target Samsung TVs; expect transcode for DTS audio.
- **UX:** D-pad focus must **never get lost**. Use large, readable type. One clear focus target minimum on each screen.
- **config.xml:** Include `<object type="application/avplayer">` and `$WEBAPIS/webapis/webapis.js`. Privileges: `internet`, `tv.inputdevice`, `productinfo` only unless a new capability is proven necessary. AVPlay is not a privilege.
- **Tooling:** Package with `tizen package -t wgt`. Avoid `tizen build-web` on CLI 6.1 (known crash). Signing uses the developer’s **security profile**; never commit `.p12`, profile XML, or passwords.
- **Proof bar:** The `.wgt` builds; smoke-test in the Tizen TV **software** emulator when possible; **real TV** validation is done by TV Ship and is the final gate.
- **Clean room:** Do not copy code from jellyfin-web or jellyfin-tizen.

## Local commands

```bash
export TIZEN_SECURITY_PROFILE="YourProfileName"
./scripts/build-wgt.sh
```
