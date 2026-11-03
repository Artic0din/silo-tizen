# Upstream Design Notes

silo-apple and silo-android keep design specs and implementation plans in `docs/superpowers/`.
Before porting a feature, read the matching spec: it records what the Apple TV or Android TV app does, why, and the edge cases its review found.
They describe Swift and Kotlin code, so port the behaviour, not the structure.
This page links the specs that apply to a TV client; phone, reader, audiobook, download and admin specs are left out.
Most specs have an implementation plan of the same name under `docs/superpowers/plans/`.

## Parity audits

- [Four-client feature comparison](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-06-17-four-client-feature-comparison.md) - iOS, tvOS, Android phone and Android TV
- [Android TV and tvOS full-app parity audit](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-06-18-tvos-parity-fullapp-audit.md)
- [TV client review: solidity and mobile parity](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-06-17-tv-client-parity-review.md)
- [TV and mobile parity audit](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-06-17-tv-mobile-parity-audit.md)
- [Android TV full parity rework](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-05-23-android-tv-parity-rework-design.md)
- [Client and server API contract audit](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-06-15-client-server-contract-audit.md)

The Android repository also keeps Apple TV reference captures of Home, Calendar, movie and series detail, the player controls and the audio, subtitle and version pickers in [`docs/superpowers/reference/tvos-detail/`](https://github.com/Silo-Server/silo-android/tree/main/docs/superpowers/reference/tvos-detail).

## Screens

- [tvOS item detail redesign (Squared Skyline)](https://github.com/Silo-Server/silo-apple/blob/main/docs/superpowers/specs/2026-06-15-tvos-detail-redesign-design.md)
- [Android TV detail parity with tvOS](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-06-17-android-tv-detail-parity-design.md)
- [Android TV detail hero geometry](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-07-22-android-tv-detail-hero-geometry-design.md)
- [Remove the TV detail Starring overlay](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-07-29-remove-tv-detail-starring-overlay-design.md)
- [Specials-first season order](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-07-29-specials-first-season-order-design.md)
- [Person detail parity](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-06-19-person-detail-parity-design.md)
- [Resume-first Home](https://github.com/Silo-Server/silo-apple/blob/main/docs/superpowers/specs/2026-06-15-resume-first-home-design.md)
- [Active header focus and editorial hero](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-07-28-android-active-header-focus-editorial-hero-design.md)
- [Navigation alignment with the Apple and web shells](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-06-12-nav-alignment-apple-web-design.md)
- [Capability-driven media navigation](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-06-09-capability-driven-media-navigation-design.md)
- [Profile launch choice and Apple TV user mapping](https://github.com/Silo-Server/silo-apple/blob/main/docs/superpowers/specs/2026-08-11-profile-launch-and-tvos-user-mapping-design.md)
- [Silo companion pairing](https://github.com/Silo-Server/silo-apple/blob/main/docs/superpowers/specs/2026-06-14-companion-pairing-design.md)
- [TV Requests hub](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-06-09-tv-requests-hub-design.md)
- [Personal ratings, Calendar and picture-in-picture](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-06-12-quickwins-ratings-calendar-pip-design.md)

## Focus and navigation

- [Whole-application focus hardening](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-08-04-whole-application-focus-hardening-design.md)
- [Android TV navigation remediation](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-07-27-android-tv-navigation-remediation-design.md)
- [Android TV UI audit remediation](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-07-21-tv-ui-audit-remediation-design.md)
- [Focus restoration](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-08-03-shield-focus-restoration-design.md)
- [For You late focus relocation](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-08-03-for-you-late-focus-relocation-design.md)
- [Sign-in keyboard relocation](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-08-02-android-tv-auth-ime-relocation-design.md)

## Player and subtitles

- [TV player controls and buffer safety](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-06-13-tv-player-controls-and-buffer-safety-design.md)
- [Android TV player HUD redesign](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-07-01-android-tv-player-hud-redesign-design.md)
- [TV player transport accessibility](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-08-02-tv-player-transport-accessibility-design.md)
- [Playback selection on a TV remote](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-07-31-fire-tv-playback-selection-ux-design.md)
- [Playback behaviour migration](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-06-17-playback-behavior-migration-design.md)
- [Subtitle suite: provider search, download and AI translation](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-06-12-subtitle-suite-design.md)
- [TV subtitle picker dismissal and sizing](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-08-02-tv-subtitle-picker-and-sizing-design.md)
- [TV subtitle preset calibration](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-07-21-larger-tv-subtitle-presets-design.md)
- [Fast switching between mounted SRT subtitles](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-08-02-tv-mounted-srt-fast-switch-design.md)
- [Subtitle recentring across aspect modes](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-07-28-subtitle-aspect-recenter-design.md)
- [Watch Together synchronized playback](https://github.com/Silo-Server/silo-android/blob/main/docs/superpowers/specs/2026-06-12-watch-together-design.md)
