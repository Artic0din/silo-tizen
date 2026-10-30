# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Added strict TypeScript checks and a bundled build targeting Chrome 76.
- Added a native Silo `/api/v2` session core with device-code sign-in, household profiles and PIN checks, and credential storage in Tizen KeyManager. No screen uses it yet.
- Added native sign-in screens for server address entry and device-code sign-in with a QR code, remote-key focus and recovery for each failure. The app does not show them yet.
- Added native household profile screens for choosing and switching profiles, PIN entry with lockout handling, and sign-out. The app does not show them yet.
- Added native Movies and Series browsing for the selected profile: Home rows, visible libraries in pages, search with the TV keyboard, and movie, series, season and episode pages that hand the chosen file and resume point to the player. The app does not show them yet.
- Added a CI workflow that runs the type checks, the build and all tests.

### Changed

- Set the minimum app platform to Tizen 6.0.

### Fixed

- Fixed layouts on 2021 TVs, whose Chromium 76 engine lacks some newer CSS: sign-in fields, poster rows and the details screen keep their spacing, posters keep their 2:3 shape, and titles show in posters without artwork.
- Fixed the exit dialog on 2021 TVs: it now covers the screen instead of opening below it, with space between its Yes and No buttons.
- Kept the details poster at 2:3 when the description is taller than the poster, instead of stretching it.
- Reloaded an edited search when returning from a result opened before the search delay elapsed.
- Preserved remote focus when a PIN check finished unsuccessfully.
- Kept focus during native profile sign-out and waited for credential cleanup before returning to sign-in.
- Kept manual device-code sign-in available when its link could not be encoded as a QR code.
- Replaced an indefinite connection wait with a retry message while earlier sign-in storage cleanup remained pending.
- Dropped obsolete search responses as soon as the search text changed.

### Security

- Revoked native sign-ins abandoned before the sign-in screens handed the account to the app.
- Revoked native refresh credentials received after logout or another sign-in replaced their session.
- Updated the Playwright development dependency from 1.49.0 to 1.64.1 to include the fix for [GHSA-7mvr-c777-76hp](https://github.com/advisories/GHSA-7mvr-c777-76hp), where Playwright's macOS Chrome and Edge install scripts did not verify TLS certificates.
  Playwright runs only the desktop browser checks and is not part of the packaged TV app.
